// Evidence -> a profile. Two distillers share these rules:
//  - distillLocal: the engine's own arithmetic. Free, instant, private; the cloud version uses only this.
//  - a model (on the owner's machine) writes richer claims; mergeModelClaims checks them before they land.
// Both obey the owner's verdicts from the Garden: "not me" blocks a claim for good (until they say "that's me"),
// "prune" lets it go until the evidence grows past where it was.
import type { Answer, Card, Claim, ClaimStatus, Domain, Profile, Reaction } from "./types.ts";
import { DOMAINS } from "./types.ts";
import { cardIndex, evidence, splitClaimId } from "./evidence.ts";
import { claimText, domainOf, slugify } from "./features.ts";

/** A claim needs this much pull, from at least two reactions. */
export const THRESHOLD = { score: 2, n: 2 } as const;
/** A pruned claim comes back once this many more reactions touch it. */
export const REGROW = 3;
export const MAX_PER_DOMAIN = 8;
export const MAX_QUOTES = 3;
export const MAX_ANSWERS = 12;

export function weightOf(score: number): number {
  return Math.round((1 - Math.exp(-Math.abs(score) / 4)) * 100) / 100;
}

/** One line, no markup that could break the note's structure. */
export function clean(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  let t = s.replace(/<!--[\s\S]*?(-->|$)/g, " ").replace(/-->/g, " ").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  t = t.replace(/^[#>\-*~\s]+/, "").replace(/~~/g, "");
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

interface VerdictState { status: ClaimStatus; nAtPrune?: number }

/** The latest verdict per claim id, walking reactions in order, with the evidence count at each prune. */
function verdicts(reactions: readonly Reaction[], cards: Map<string, Card>): Map<string, VerdictState> {
  const out = new Map<string, VerdictState>();
  const seen: Reaction[] = [];
  for (const r of reactions) {
    if (r.kind === "claim" && r.claim) {
      const v = r.claim.verdict;
      if (v === "me") out.set(r.claim.id, { status: "live" });
      else if (v === "not-me") out.set(r.claim.id, { status: "not-me" });
      else {
        const split = splitClaimId(r.claim.id);
        const n = split ? evidence(cards, seen).get(split[0])?.n ?? 0 : 0;
        out.set(r.claim.id, { status: "pruned", nAtPrune: n });
      }
    }
    seen.push(r);
  }
  return out;
}

function answersFrom(reactions: readonly Reaction[], cards: Map<string, Card>, prev: Answer[] = []): Answer[] {
  const list: Answer[] = [];
  for (const r of reactions) {
    if ((r.kind !== "voice" && !(r.kind === "words" && r.game === "ripple")) || !r.words?.trim()) continue;
    const q = cards.get(r.card);
    list.push({ question: clean(q?.text ?? q?.title ?? "", 300), words: clean(r.words, 2000), ...(r.voice?.ref ? { ref: clean(r.voice.ref, 300) } : {}), at: r.at });
  }
  const seen = new Set(list.map((a) => a.at + a.words));
  for (const a of prev) if (!seen.has(a.at + a.words)) list.push(a);
  return list.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, MAX_ANSWERS);
}

function localSummary(claims: Claim[]): string {
  const top = claims.filter((c) => c.status === "live").sort((a, b) => b.weight - a.weight).slice(0, 3);
  if (!top.length) return "Not enough play yet to say much. Every reaction teaches a little.";
  return `Strongest so far: ${top.map((c) => c.text.replace(/\.$/, "")).join("; ")}.`;
}

/**
 * The engine's own read of the reactions. `prev` keeps what a model or a hand edit wrote: a claim's words survive a
 * local pass (its weight and evidence are refreshed), model-only claims stay, a model's summary stays.
 */
export function distillLocal(cardList: Iterable<Card>, reactions: readonly Reaction[], prev: Profile | null, now: string): Profile {
  const cards = cardIndex(cardList);
  const ev = evidence(cards, reactions);
  const vs = verdicts(reactions, cards);
  const prevById = new Map((prev?.claims ?? []).map((c) => [c.id, c]));
  const claims: Claim[] = [];
  const statusFor = (id: string, n: number): ClaimStatus => {
    const v = vs.get(id);
    if (v?.status === "pruned") return n >= (v.nAtPrune ?? 0) + REGROW ? "live" : "pruned";
    if (v) return v.status;
    return prevById.get(id)?.status === "not-me" ? "not-me" : "live";
  };
  for (const e of ev.values()) {
    const domain = domainOf(e.feature);
    if (!domain) continue;
    const sign: 1 | -1 = e.score >= 0 ? 1 : -1;
    const id = `${e.feature}${sign > 0 ? "+" : "-"}`;
    const status = statusFor(id, e.n);
    const passes = Math.abs(e.score) >= THRESHOLD.score && e.n >= THRESHOLD.n;
    if (!passes && status === "live" && !prevById.has(id)) continue;
    if (!passes && status === "live") continue; // faded below the line: it goes until it earns its way back
    const p = prevById.get(id);
    claims.push({
      id, domain, text: p?.text || claimText(e.feature, sign), weight: weightOf(e.score), evidence: e.n, status,
      quotes: (sign > 0 ? e.quotesFor : e.quotesAgainst).slice(-MAX_QUOTES), since: p?.since ?? now.slice(0, 10),
    });
  }
  const have = new Set(claims.map((c) => c.id));
  // what the evidence can't rebuild: model-written claims, and every "not me", kept with their latest verdict
  for (const p of prev?.claims ?? []) {
    if (have.has(p.id)) continue;
    const feature = splitClaimId(p.id);
    if (feature && p.status !== "not-me" && !vs.has(p.id)) continue; // a feature claim the evidence no longer holds up
    const v = vs.get(p.id);
    const status: ClaimStatus = v ? (v.status === "pruned" ? "pruned" : v.status) : p.status;
    claims.push({ ...p, status });
    have.add(p.id);
  }
  // a verdict on a claim we can't see (e.g. a model claim not in prev): keep "not me" as a marker so it stays out
  for (const [id, v] of vs) {
    if (have.has(id) || v.status !== "not-me") continue;
    const split = splitClaimId(id);
    const domain = split ? domainOf(split[0]) : null;
    if (split && domain) claims.push({ id, domain, text: claimText(split[0], split[1]), weight: 0, evidence: 0, status: "not-me", quotes: [] });
  }
  const capped = capPerDomain(claims);
  const modelSummary = prev && prev.by !== "local" ? prev.summary : "";
  return {
    updated: now, by: prev && prev.by !== "local" ? prev.by : "local", summary: modelSummary || localSummary(capped), claims: capped,
    reactions: reactions.length, answers: answersFrom(reactions, cards, prev?.answers),
  };
}

function capPerDomain(claims: Claim[]): Claim[] {
  const out: Claim[] = [];
  for (const d of DOMAINS) {
    const live = claims.filter((c) => c.domain === d && c.status === "live").sort((a, b) => b.weight - a.weight || b.evidence - a.evidence);
    out.push(...live.slice(0, MAX_PER_DOMAIN));
    out.push(...claims.filter((c) => c.domain === d && c.status !== "live"));
  }
  return out;
}

/** Apply Garden verdicts to a profile right away, without a distil (the Garden shows the change at once). */
export function applyVerdicts(p: Profile, reactions: readonly Reaction[]): Profile {
  const claims = p.claims.map((c) => ({ ...c }));
  for (const r of reactions) {
    if (r.kind !== "claim" || !r.claim) continue;
    const c = claims.find((x) => x.id === r.claim!.id);
    if (!c) continue;
    if (r.claim.verdict === "me") { c.status = "live"; c.weight = Math.min(1, Math.round((c.weight + 0.1) * 100) / 100); }
    else c.status = r.claim.verdict === "not-me" ? "not-me" : "pruned";
    const w = r.words?.trim();
    if (w && r.claim.verdict === "me" && !c.quotes.includes(w)) c.quotes = [...c.quotes, w].slice(-MAX_QUOTES);
  }
  return { ...p, claims };
}

// ---------- model output ----------

const STOP = new Set("a an and are as at be but by for from has have i in is it its of on or over so than that the their them they this to too very was with you your".split(" "));
const NEGATION = /\b(not|never|no|avoid|avoids|away|less|without|isn't|doesn't|don't|steers|dislikes?)\b/i;

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|es|s)$/, "")));
}

/** How much of the shorter claim the longer one covers, 0..1. */
export function overlap(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let k = 0;
  for (const w of A) if (B.has(w)) k++;
  return k / Math.min(A.size, B.size);
}

function blockedBy(text: string, domain: Domain, blocked: Claim[]): Claim | undefined {
  return blocked.find((b) => {
    if (b.domain !== domain) return false;
    if (overlap(text, b.text) >= 0.6) return true;
    const split = splitClaimId(b.id);
    if (!split) return false;
    const key = split[0].slice(split[0].indexOf(":") + 1).split("-")[0];
    const has = new RegExp(`\\b${key.replace(/[^a-z0-9]/g, "")}`, "i").test(text);
    const negated = NEGATION.test(text);
    return has && (split[1] > 0 ? !negated : negated);
  });
}

/**
 * A model's proposed profile, checked against the rules before it replaces `prev`:
 * real domains only; one line of plain text per claim; quotes must appear word for word in `said` (their own words);
 * nothing that matches a "not me" or a pruned claim; at most MAX_PER_DOMAIN live claims per domain.
 */
export function mergeModelClaims(prev: Profile, raw: unknown, said: readonly string[], model: string, reactionCount: number, now: string): Profile {
  const o = (raw && typeof raw === "object" ? raw : {}) as { summary?: unknown; claims?: unknown };
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const corpus = said.map(norm);
  const held = prev.claims.filter((c) => c.status !== "live");
  const prevLive = prev.claims.filter((c) => c.status === "live");
  const out: Claim[] = [];
  const used = new Set<string>();
  for (const item of Array.isArray(o.claims) ? o.claims.slice(0, 80) : []) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const domain = it.domain as Domain;
    if (!(DOMAINS as readonly string[]).includes(domain)) continue;
    const text = clean(it.text, 200);
    if (text.length < 3) continue;
    const askedId = typeof it.id === "string" ? it.id : "";
    if (held.some((h) => h.id === askedId) || blockedBy(text, domain, held)) continue;
    const match = prevLive.find((p) => p.id === askedId && p.domain === domain) ?? prevLive.find((p) => p.domain === domain && overlap(p.text, text) >= 0.6);
    let id = match?.id ?? `m:${domain}:${slugify(text)}`;
    if (used.has(id)) { if (match) continue; id = `${id}-${used.size}`; }
    used.add(id);
    const quotes = (Array.isArray(it.quotes) ? it.quotes : []).map((q) => clean(q, 300)).filter((q) => q && corpus.some((c) => c.includes(norm(q)))).slice(0, MAX_QUOTES);
    const ev = Number(it.evidence);
    out.push({
      id, domain, text, weight: Math.max(0, Math.min(1, Number(it.weight) || 0.5)), status: "live",
      evidence: Number.isFinite(ev) && ev >= 0 ? Math.min(10000, Math.round(ev)) : match?.evidence ?? 0,
      quotes: quotes.length ? quotes : match?.quotes ?? [], since: match?.since ?? now.slice(0, 10),
    });
  }
  return {
    updated: now, by: clean(model, 60) || "model", summary: clean(o.summary, 600) || prev.summary,
    claims: capPerDomain([...out, ...held]), reactions: reactionCount, answers: prev.answers,
  };
}

/** The prompt a model distiller gets. Evidence only: card descriptions, reactions, their words, the current profile. */
export function distillPrompt(input: { profile: Profile; evidenceLines: string[]; words: string[]; deep: boolean }): string {
  const { profile, evidenceLines, words, deep } = input;
  const held = profile.claims.filter((c) => c.status !== "live").map((c) => `- [${c.status}] (${c.domain}) ${c.text} {id: ${c.id}}`);
  const live = profile.claims.filter((c) => c.status === "live").map((c) => `- (${c.domain}) ${c.text} {id: ${c.id}, weight ${c.weight}, ${c.evidence} reactions}`);
  return [
    `You keep a person's taste profile: short, specific claims about what they like and dislike, in five domains: ${DOMAINS.join(", ")}.`,
    deep ? "This is the weekly rewrite: reread everything and rewrite the profile so it is sharp, specific and true to the evidence. Merge duplicates, drop weak claims, name tensions."
      : "This is a quick pass: adjust the current profile for the new evidence. Keep claim ids that still hold; add only what the evidence clearly shows.",
    "Rules:",
    "- Every claim is one plain sentence a designer, musician or writer could act on. Specific beats general (\"clay and late-sun oranges\" beats \"warm colours\").",
    "- Quotes must be copied word for word from THEIR WORDS below, or left out. Never invent or paraphrase a quote.",
    "- Never re-assert anything listed under HELD BACK (they said 'not me' or let it go), in any wording.",
    `- At most ${MAX_PER_DOMAIN} claims per domain. Weight 0..1 is how sure the evidence makes you.`,
    "- The summary is two or three sentences, plain, in the third person.",
    "Answer with JSON only: {\"summary\": string, \"claims\": [{\"id\"?: string, \"domain\": string, \"text\": string, \"weight\": number, \"evidence\": number, \"quotes\": string[]}]}",
    "", "CURRENT PROFILE:", profile.summary, ...live,
    "", "HELD BACK (never re-assert):", ...(held.length ? held : ["(none)"]),
    "", "EVIDENCE (feature, signed score, reactions):", ...evidenceLines,
    "", "THEIR WORDS (verbatim, one per line):", ...(words.length ? words.map((w) => `- ${w.replace(/\s+/g, " ")}`) : ["(none yet)"]),
  ].join("\n");
}

/** The lines distillPrompt wants, from the reaction log. */
export function evidenceLines(cardList: Iterable<Card>, reactions: readonly Reaction[], max = 120): string[] {
  const cards = cardIndex(cardList);
  return [...evidence(cards, reactions).values()].filter((e) => Math.abs(e.score) >= 0.5).sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, max)
    .map((e) => `- ${e.feature} ${e.score >= 0 ? "+" : ""}${Math.round(e.score * 10) / 10} (${e.n})`);
}

/** Their own words from the log, newest last, deduplicated. */
export function theirWords(reactions: readonly Reaction[], cardList: Iterable<Card>, max = 80): string[] {
  const cards = cardIndex(cardList);
  const out: string[] = [];
  for (const r of reactions) {
    const w = r.words?.trim();
    if (!w) continue;
    const c = cards.get(r.card);
    const about = c ? ` [${r.kind} on ${c.kind} "${clean(c.title, 60)}"]` : "";
    const line = `${clean(w, 600)}${about}`;
    if (!out.includes(line)) out.push(line);
  }
  return out.slice(-max);
}
