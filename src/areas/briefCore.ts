// The life OS view's pure core (unit-tested in scripts/lifeos.test.ts): parse an area's Brief and the
// cross-area Today note, rank what needs Aaron, word the freshness, and draft the "Ask Uni" messages.
// The contract is the vault note "Uni as a life OS": `Areas/<Name>/Brief` has seven fixed sections and
// `Areas/Today` has "Needs you today", "Moved since yesterday", "Quiet areas" and "Areas". No React, no Tauri.

export type Inline =
  | { t: "text"; text: string }
  | { t: "bold"; text: string }
  | { t: "link"; target: string; label: string }
  | { t: "url"; href: string; label: string };
export type BriefItem = { text: string; tokens: Inline[] };
export type Need = BriefItem & { area: string | null };

export type SectionKey = "now" | "needsYou" | "moving" | "people" | "recent" | "quiet" | "suggested";
export type Brief = {
  now: string; nowTokens: Inline[];
  needsYou: BriefItem[]; moving: BriefItem[]; people: BriefItem[]; recent: BriefItem[]; quiet: BriefItem[]; suggested: BriefItem[];
  /** The sections the note actually has, in note order. */
  present: SectionKey[];
};
export type Today = { needs: Need[]; moved: BriefItem[]; quiet: BriefItem[]; areas: { name: string; path: string; now: string }[] };

const SECTIONS: Record<string, SectionKey> = {
  "now": "now", "needs you": "needsYou", "moving": "moving", "people": "people", "recent": "recent", "quiet": "quiet", "suggested next": "suggested",
};
const INLINE = /\[\[([^\]\n]+?)\]\]|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*/g;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const EMPTY = /^nothing recent\.?$/i;

/** Wikilinks (by path), markdown links and bold, in order; everything else is text. */
export function inlineTokens(line: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  const text = (s: string) => { if (s) out.push({ t: "text", text: s }); };
  for (const m of line.matchAll(INLINE)) {
    text(line.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) {
      const bar = m[1].indexOf("|");
      const target = (bar < 0 ? m[1] : m[1].slice(0, bar)).trim();
      const label = (bar < 0 ? "" : m[1].slice(bar + 1)).trim() || target.split("/").filter(Boolean).pop() || target;
      out.push({ t: "link", target, label });
    } else if (m[2] !== undefined) out.push({ t: "url", href: m[3], label: m[2] });
    else out.push({ t: "bold", text: m[4] });
  }
  text(line.slice(at));
  return out;
}

const plain = (tokens: Inline[]) => tokens.map((t) => (t.t === "text" || t.t === "bold" ? t.text : t.label)).join("").replace(/\s+/g, " ").trim();
const item = (line: string): BriefItem => { const tokens = inlineTokens(line.trim()); return { text: plain(tokens), tokens }; };

function sections(content: string): { key: SectionKey; lines: string[] }[] {
  const body = content.replace(/^\s*---\n[\s\S]*?\n---\n/, "");
  const out: { key: SectionKey; lines: string[] }[] = [];
  let cur: { key: SectionKey; lines: string[] } | null = null;
  for (const line of body.split("\n")) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { const key = SECTIONS[h[1].trim().toLowerCase()]; cur = key ? { key, lines: [] } : null; if (cur) out.push(cur); continue; }
    if (/^#{1,6}\s/.test(line)) { if (!/^###/.test(line)) cur = null; continue; }
    cur?.lines.push(line);
  }
  return out;
}

/** Bullets of a section; an indented continuation joins the item above; "nothing recent" is no item. */
function bullets(lines: string[]): BriefItem[] {
  const items: string[] = [];
  for (const line of lines) {
    const m = BULLET.exec(line);
    if (m) items.push(m[1]);
    else if (line.trim() && items.length && /^\s+/.test(line)) items[items.length - 1] += " " + line.trim();
    else if (line.trim() && !items.length) items.push(line.trim());
  }
  return items.filter((s) => !EMPTY.test(s.trim())).map(item);
}

export function parseBrief(content: string): Brief {
  const brief: Brief = { now: "", nowTokens: [], needsYou: [], moving: [], people: [], recent: [], quiet: [], suggested: [], present: [] };
  for (const s of sections(content ?? "")) {
    if (!brief.present.includes(s.key)) brief.present.push(s.key);
    if (s.key === "now") {
      const para = s.lines.map((l) => l.replace(BULLET, "$1").trim()).filter(Boolean).join(" ");
      const i = item(para);
      brief.now = i.text; brief.nowTokens = i.tokens;
    } else brief[s.key] = bullets(s.lines);
  }
  return brief;
}

/** The first sentence of Now, for a card. */
export function nowLine(brief: Brief, max = 160): string {
  const first = /^.*?[.!?](?=\s|$)/.exec(brief.now)?.[0] ?? brief.now;
  return first.length > max ? first.slice(0, max).trimEnd() + "…" : first;
}

const needOf = (line: string): Need => {
  const i = item(line);
  const lead = i.tokens[0];
  if (lead?.t !== "bold") return { ...i, area: null };
  const tokens = i.tokens.slice(1);
  if (tokens[0]?.t === "text") tokens[0] = { t: "text", text: tokens[0].text.replace(/^[\s:–—-]+/, "") };
  return { text: plain(tokens), tokens: tokens.filter((t) => t.t !== "text" || t.text), area: lead.text.trim() };
};

export function parseToday(content: string): Today {
  const today: Today = { needs: [], moved: [], quiet: [], areas: [] };
  const body = (content ?? "").replace(/^\s*---\n[\s\S]*?\n---\n/, "");
  let cur: string | null = null;
  const lines: Record<string, string[]> = {};
  for (const line of body.split("\n")) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { cur = h[1].trim().toLowerCase(); lines[cur] = []; continue; }
    if (cur) lines[cur].push(line);
  }
  const list = (k: string) => (lines[k] ?? []).map((l) => BULLET.exec(l)?.[1]).filter((s): s is string => !!s && !EMPTY.test(s.trim()));
  today.needs = list("needs you today").map(needOf);
  today.moved = list("moved since yesterday").map(item);
  today.quiet = list("quiet areas").map(item);
  for (const raw of list("areas")) {
    const i = item(raw);
    const link = i.tokens.find((t): t is Extract<Inline, { t: "link" }> => t.t === "link");
    if (!link) continue;
    const name = /^Areas\/([^/]+)\//.exec(link.target)?.[1] ?? link.label;
    const rest = raw.slice(raw.indexOf("]]") + 2).replace(/^\s*[:–—-]\s*/, "").trim();
    today.areas.push({ name, path: link.target, now: EMPTY.test(rest) ? "" : plain(inlineTokens(rest)) });
  }
  return today;
}

// --------------------------------------------------------------------------- ranking
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY = 86_400_000;

/** The earliest date a line mentions (ISO `2026-10-10` or `Oct 12`), in days from today; null when it has none. */
function dueDay(text: string, now: number): number | null {
  const d = new Date(now);
  const y = d.getFullYear();
  const today = Date.UTC(y, d.getMonth(), d.getDate());
  const days: number[] = [];
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) days.push(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/gi)) {
    const mon = MONTHS.indexOf(m[1].toLowerCase());
    let t = Date.UTC(y, mon, +m[2]);
    if (today - t > 180 * DAY) t = Date.UTC(y + 1, mon, +m[2]);
    days.push(t);
  }
  return days.length ? Math.round((Math.min(...days) - today) / DAY) : null;
}

const urgency = (days: number | null) => (days === null ? 4 : days < 0 ? 0 : days === 0 ? 1 : days <= 3 ? 2 : days <= 7 ? 3 : 4);

/** What needs Aaron first: overdue, due today, due soon, then the rest; foreground areas first within a tier; the writer's order after that. */
export function rankNeeds<T extends Need>(needs: readonly T[], ctx: { now: number; foreground: readonly string[] }): T[] {
  return needs.map((n, i) => ({ n, i, u: urgency(dueDay(n.text, ctx.now)), f: n.area && ctx.foreground.includes(n.area) ? 0 : 1 }))
    .sort((a, b) => a.u - b.u || a.f - b.f || a.i - b.i).map((x) => x.n);
}

/** Today's own list, ranked — or, when the note is missing or empty, the areas' briefs gathered and ranked. */
export function todayNeeds(today: Today | null, briefs: Record<string, Brief>, foreground: readonly string[], now: number): Need[] {
  const own = today?.needs ?? [];
  const all: Need[] = own.length ? own : Object.entries(briefs).flatMap(([area, b]) => b.needsYou.map((i) => ({ ...i, area })));
  return rankNeeds(all, { now, foreground });
}

// --------------------------------------------------------------------------- freshness
export function updatedLabel(iso: string | null | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return "updated just now";
  if (s < 3600) return `updated ${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `updated ${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `updated ${Math.floor(s / 86400)}d ago`;
  return `updated ${Math.floor(s / (7 * 86400))}w ago`;
}

/** The Refresh action: a draft asking Uni to rewrite a node's Brief (the Uni home: Today). Never sent by the app. */
export const refreshDraft = (name: string, path: string | null) => path === null || path === ""
  ? "@Uni Please refresh Areas/Today: what needs me, what moved, and what is quiet."
  : `@Uni Please refresh ${name}'s brief (${path}/Brief): what is current, what needs me, and what moved since it was written.`;
