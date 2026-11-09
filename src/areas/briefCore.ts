// The life OS view's pure core (unit-tested in scripts/lifeos.test.ts): parse a node's Brief, word the freshness, and
// draft the "Ask Uni" messages. The contract is the vault note "Uni as a life OS": `Areas/<Name>/Brief` has seven fixed
// sections. (The cross-area `Areas/Today` roll-up was retired 11-09, T-335: what needs you comes from the asks.) No React, no Tauri.

export type Inline =
  | { t: "text"; text: string }
  | { t: "bold"; text: string }
  | { t: "link"; target: string; label: string }
  | { t: "url"; href: string; label: string };
export type BriefItem = { text: string; tokens: Inline[] };

export type SectionKey = "now" | "needsYou" | "moving" | "people" | "recent" | "quiet" | "suggested";
export type Brief = {
  now: string; nowTokens: Inline[];
  needsYou: BriefItem[]; moving: BriefItem[]; people: BriefItem[]; recent: BriefItem[]; quiet: BriefItem[]; suggested: BriefItem[];
  /** The sections the note actually has, in note order. */
  present: SectionKey[];
};

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

/** The Refresh action: a draft asking Uni to rewrite a node's Brief (the Uni home: its own summary; the Areas/Today roll-up was retired
 *  11-09, T-335). Never sent by the app. */
export const refreshDraft = (name: string, path: string | null) => path === null || path === ""
  ? "@Uni Please update the summary on my home: what needs me, what moved, and what is quiet."
  : `@Uni Please refresh ${name}'s brief (${path}/Brief): what is current, what needs me, and what moved since it was written.`;
