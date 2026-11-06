// The profile as a markdown note: readable by people and workers, editable by hand, parsed back losslessly.
// Each claim line ends in an HTML comment carrying its id and numbers, so a hand edit keeps its history:
//   - Slow motion, like breathing. _(5 reactions, clear)_ <!-- claim:motion:slow+ w=0.62 n=5 since=2026-11-05 -->
//     > "slow like breathing"
import type { Answer, Card, Claim, ClaimStatus, Domain, Profile, Reaction } from "./types.ts";
import { DOMAINS, DOMAIN_NAMES } from "./types.ts";
import { clean } from "./distill.ts";

const NOT_ME = "Not me";
const LET_GO = "Let go";
export const PROFILE_MARK = "taste-arcade profile v1";

function strength(w: number): string {
  return w >= 0.75 ? "strong" : w >= 0.45 ? "clear" : "faint";
}

function claimLine(c: Claim, withDomain: boolean): string[] {
  const meta = [`w=${c.weight}`, `n=${c.evidence}`, ...(c.since ? [`since=${c.since}`] : []), ...(c.status !== "live" ? [`status=${c.status}`] : []), ...(withDomain ? [`domain=${c.domain}`] : [])];
  const shown = c.status === "live" ? `${c.text} _(${c.evidence} ${c.evidence === 1 ? "reaction" : "reactions"}, ${strength(c.weight)})_` : `~~${c.text}~~`;
  return [`- ${shown} <!-- claim:${c.id} ${meta.join(" ")} -->`, ...c.quotes.map((q) => `  > "${q}"`)];
}

export function renderProfile(p: Profile, opts: { title?: string } = {}): string {
  const out: string[] = [`# ${opts.title ?? "Taste profile"}`, "", `> ${p.summary}`, ""];
  const date = p.updated.slice(0, 10);
  out.push(`_Distilled ${date} from ${p.reactions} reactions by ${p.by}. One claim per line, strongest first; "Not me" lists what to avoid. Edit freely, and keep a line's \`<!-- claim -->\` tail to keep its history._`, "");
  for (const d of DOMAINS) {
    out.push(`## ${DOMAIN_NAMES[d]}`, "");
    const live = p.claims.filter((c) => c.domain === d && c.status === "live").sort((a, b) => b.weight - a.weight || b.evidence - a.evidence);
    if (live.length) for (const c of live) out.push(...claimLine(c, false));
    if (d === "systems" && p.answers.length) {
      if (live.length) out.push("");
      out.push("### In their words", "");
      for (const a of p.answers) out.push(`- **${a.question || "Ripple"}** "${a.words}" <!-- answer at=${a.at}${a.ref ? ` ref=${encodeURIComponent(a.ref)}` : ""} -->`);
    }
    if (!live.length && !(d === "systems" && p.answers.length)) out.push("_Nothing yet._");
    out.push("");
  }
  const notMe = p.claims.filter((c) => c.status === "not-me");
  out.push(`## ${NOT_ME}`, "");
  if (notMe.length) for (const c of notMe) out.push(...claimLine(c, true));
  else out.push("_Nothing pushed back yet._");
  out.push("");
  const letGo = p.claims.filter((c) => c.status === "pruned");
  if (letGo.length) {
    out.push(`## ${LET_GO}`, "", "_Pruned in the Garden: not used, back only if the evidence grows._", "");
    for (const c of letGo) out.push(...claimLine(c, true));
    out.push("");
  }
  out.push(`<!-- ${PROFILE_MARK} updated=${p.updated} by=${encodeURIComponent(p.by)} reactions=${p.reactions} -->`, "");
  return out.join("\n");
}

const CLAIM = /^- (.*?)\s*<!--\s*claim:(\S+)((?:\s+[a-z]+=\S*)*)\s*-->\s*$/;
const ANSWER = /^- (?:\*\*(.*?)\*\* )?"([\s\S]*)"\s*<!--\s*answer((?:\s+[a-z]+=\S*)*)\s*-->\s*$/;

function attrs(s: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const m of s.matchAll(/([a-z]+)=(\S*)/g)) o[m[1]] = m[2];
  return o;
}

function sectionDomain(h: string): Domain | "not-me" | "let-go" | null {
  const t = h.trim().toLowerCase();
  if (t === NOT_ME.toLowerCase()) return "not-me";
  if (t === LET_GO.toLowerCase()) return "let-go";
  return DOMAINS.find((d) => DOMAIN_NAMES[d].toLowerCase() === t) ?? null;
}

/** Read a profile note back. Tolerant: unknown lines are ignored, a claim line without numbers gets defaults. */
export function parseProfile(md: string): Profile {
  const lines = md.split(/\r?\n/);
  const p: Profile = { updated: "", by: "local", summary: "", claims: [], reactions: 0, answers: [] };
  let section: ReturnType<typeof sectionDomain> = null;
  let last: Claim | null = null;
  for (const line of lines) {
    const footer = line.match(new RegExp(`<!--\\s*${PROFILE_MARK}((?:\\s+[a-z]+=\\S*)*)\\s*-->`));
    if (footer) {
      const a = attrs(footer[1]);
      p.updated = a.updated ?? "";
      p.by = a.by ? decodeURIComponent(a.by) : p.by;
      p.reactions = Number(a.reactions) || 0;
      continue;
    }
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h && !line.startsWith("###")) { section = sectionDomain(h[1]); last = null; continue; }
    if (!section && !p.summary && line.startsWith("> ")) { p.summary = line.slice(2).trim(); continue; }
    if (!section) continue;
    const q = /^\s{2,}>\s?"?(.*?)"?\s*$/.exec(line);
    if (q && last) { if (q[1]) last.quotes.push(q[1]); continue; }
    const m = CLAIM.exec(line);
    if (m) {
      const a = attrs(m[3]);
      const status: ClaimStatus = section === "not-me" ? "not-me" : section === "let-go" ? "pruned" : ((a.status as ClaimStatus) ?? "live");
      const domain = (section === "not-me" || section === "let-go" ? a.domain : section) as Domain;
      if (!(DOMAINS as readonly string[]).includes(domain)) { last = null; continue; }
      let text = m[1].replace(/\s*_\(\d+ reactions?, (?:strong|clear|faint)\)_\s*$/, "").trim();
      text = text.replace(/^~~(.*)~~$/, "$1").trim();
      const w = Number(a.w);
      last = { id: m[2], domain, text, weight: Number.isFinite(w) ? w : 0.5, evidence: Number(a.n) || 0, status, quotes: [], ...(a.since ? { since: a.since } : {}) };
      p.claims.push(last);
      continue;
    }
    const an = ANSWER.exec(line);
    if (an && section === "systems") {
      const a = attrs(an[3]);
      const ans: Answer = { question: an[1] === "Ripple" ? "" : an[1] ?? "", words: an[2], at: a.at ?? "" };
      if (a.ref) ans.ref = decodeURIComponent(a.ref);
      p.answers.push(ans);
      last = null;
      continue;
    }
    if (line.trim() && !line.startsWith("  ")) last = null;
  }
  return p;
}

const GAME_NAMES: Record<string, string> = {
  "this-or-that": "This or That", gallery: "The Gallery", "fix-it": "Fix It", "who-said-it": "Who Said It", ripple: "Ripple", garden: "Garden", import: "Imported",
};

function describe(r: Reaction, cards: Map<string, Card>): string {
  const t = (id?: string) => (id && cards.get(id) ? `**${clean(cards.get(id)!.title, 80)}**` : id ? `\`${id}\`` : "?");
  switch (r.kind) {
    case "pick": return `picked ${t(r.card)} over ${t(r.other)}`;
    case "keep": return `kept ${t(r.card)}`;
    case "drop": return `dropped ${t(r.card)}`;
    case "pin": return `pinned ${t(r.card)}`;
    case "nudge": return `nudged ${t(r.card)}: ${Object.entries(r.nudges ?? {}).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${Math.round(v * 10) / 10}`).join(", ")}`;
    case "guess": return `guessed ${r.guess?.said === "owner" ? "mine" : "Uni's"} on ${t(r.card)} (${r.guess?.right ? "right" : "wrong"})`;
    case "claim": return `said "${r.claim?.verdict === "me" ? "that's me" : r.claim?.verdict === "not-me" ? "not me" : "let it go"}" to \`${r.claim?.id}\``;
    case "voice": return `answered ${t(r.card)} out loud`;
    default: return `wrote about ${t(r.card)}`;
  }
}

function seenAs(r: Reaction): string {
  const parts = [r.dimension && r.dimension !== "claim" ? `judging ${r.dimension}` : "", r.grey ? "seen in greyscale" : ""].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** Everything they gave, as one markdown file they can keep: the profile, then every reaction in order. */
export function exportMarkdown(p: Profile, reactions: readonly Reaction[], cardList: Iterable<Card>): string {
  const cards = new Map<string, Card>();
  for (const c of cardList) cards.set(c.id, c);
  const lines = [renderProfile(p, { title: "My taste" }).trimEnd(), "", "## Every reaction", ""];
  for (const r of reactions) {
    const when = r.at.slice(5, 16).replace("T", " ");
    lines.push(`- ${when}, ${GAME_NAMES[r.game] ?? r.game}: ${describe(r, cards)}${seenAs(r)}${r.words?.trim() ? `: "${clean(r.words, 2000)}"` : ""}`);
  }
  if (!reactions.length) lines.push("_None yet._");
  lines.push("", "_Made with Taste Arcade. Your reactions stay yours: this file is all of them._", "");
  return lines.join("\n");
}
