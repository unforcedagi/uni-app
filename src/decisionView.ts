// T-212: a decision as a card in the chat of the room that asked it (pure, unit-tested in scripts/decisionCard.test.ts; not decisionCard.ts: on a Mac that is DecisionCard.tsx).
// A room posts a line with `uni:<id>` of a `Decisions/…` note (tasks.py `decide new` prints it); the app reads that note and shows
// the question with one button per option. A tap is a compare-and-set in the vault (open -> decided) and, only when that tap won,
// a short message from you in the room ("Picked: B …") so the room's Uni session hears the answer.
import { parseMarkdown } from "./markdown.ts";

/** A decision note as the card shows it. */
export type DecisionView = {
  id: string;
  question: string;
  options: string[];
  /** The option the room marked as its default (`default` metadata, or an option written "B (default)"), else null. */
  dflt: string | null;
  state: "open" | "decided" | "other";
  decided: string | null;
  decidedBy: string | null;
  /** The revision the question was read at: a pick is written against it. */
  updatedAt: string;
  task: string | null;
  /** T-226: the words written with the pick (`decided_note`), else null. */
  decidedNote: string | null;
  /** T-226: words added with no pick (`notes`: `{text, at, by}`), oldest first. */
  notes: { text: string; at: string; by: string }[];
};

/** T-226: the longest note on a decision, in characters (the vault refuses longer; the field stops there and counts down near it). */
export const NOTE_MAX = 1000;
/** From here on the field shows how many characters are left. */
export const NOTE_WARN = 900;

/**
 * A note as it is stored and sent: plain text with its line breaks, without control or direction-override characters (they could make
 * the room message read other than it is), trimmed; the same as the vault side (`decision_note_text`). "" when nothing is left.
 */
export function cleanNote(text: string): string {
  return (text ?? "").replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    // a half emoji (a lone surrogate) is no character, and the vault can't take one
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
    .trim();
}

/** What may be a link or note ref in a note: an escape inside one would become part of its address, so it may go as typed. */
const RAW = /(?:https?:\/\/|(?:uni|unforced):)[^\s<>"'`]+/gi;
const escMarks = (s: string) => s.replace(/[\\`*_[\]~|]/g, "\\$&");
/** Line starts that would make a heading, quote, list or rule. */
const escLines = (s: string) => s.replace(/^(\s*)([#>+-]|\d+[.)](?=\s|$))/gm, (_, sp: string, mark: string) => `${sp}${mark.replace(/^[#>+-]|[.)]$/, "\\$&")}`);
/**
 * The chat shows exactly these words (spacing aside): only paragraphs of text, line breaks and links that read as the address typed,
 * nothing bold, code, a heading, a list, or a link labelled with other words.
 */
const readsAs = (md: string, words: string) => {
  const shown: string[] = [];
  const ok = parseMarkdown(md).every((b) => b.t === "p" && b.c.every((n) => {
    if (n.t === "text") { shown.push(n.v); return true; }
    if (n.t === "br") { shown.push("\n"); return true; }
    if (n.t !== "link" && n.t !== "vaultlink") return false;
    const label = n.c.length === 1 && n.c[0].t === "text" ? n.c[0].v : null;
    if (label === null || (n.t === "link" && label !== n.href)) return false;
    shown.push(label); return true;
  }) && (shown.push(" "), true));
  const flat = (x: string) => x.replace(/\s+/g, " ").trim();
  return ok && flat(shown.join("")) === flat(words);
};

/**
 * A note as the room message carries it: the markdown marks escaped, so the chat shows the words as typed (a `[x](javascript:…)` or
 * `**` stays text, never a link or bold), and a line can't start a heading, quote, list or rule. A bare http(s) link or `uni:` note
 * ref stays as typed (a link, as anywhere), but only when the chat then shows exactly the words typed, links reading as their own
 * address; otherwise every mark is escaped and links are defused (see `defuse`). The chat never renders HTML, so `<b>` is text.
 */
export function chatText(text: string): string {
  const t = cleanNote(text);
  let kept = "", at = 0;
  for (const m of t.matchAll(RAW)) { kept += escMarks(t.slice(at, m.index)) + m[0]; at = m.index! + m[0].length; }
  kept = escLines(kept + escMarks(t.slice(at)));
  return readsAs(kept, t) ? kept : escLines(escMarks(defuse(t)));
}

/**
 * The fallback's words can't start a link or note ref: an invisible zero-width space goes inside every `http:`, `https:`, `mailto:`,
 * `uni:` and `unforced:` and after every `<`, so no link parse can swallow an escape (only for a note whose links would not have
 * read as typed).
 */
export const defuse = (s: string): string => s.replace(/(https?|mailto|uni|unforced)(?=:)/gi, "$1\u200b").replace(/</g, "<\u200b");

const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const REF = new RegExp(`(?<![\\w/:.@-])uni:(${ULID})(?![\\w/])`, "g");
const DEFAULT_MARK = /\s*\((?:default|recommended)\)\s*$/i;

/** The note ids a message names with `uni:<id>`, in order, each once (at most 3: a card per ref, not a wall of them). */
export function decisionRefsIn(body: string): string[] {
  const out: string[] = [];
  for (const m of (body ?? "").matchAll(REF)) if (!out.includes(m[1])) out.push(m[1]);
  return out.slice(0, 3);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A decision's question: its `# heading`, else its file name without the date tasks.py puts first. */
export function questionOf(content: unknown, path: unknown): string {
  const h = typeof content === "string" ? content.split("\n").find((l) => l.startsWith("# ")) : undefined;
  if (h && h.slice(2).trim()) return h.slice(2).trim();
  const tail = (typeof path === "string" ? path : "").split("/").pop() ?? "";
  return tail.replace(/^\d{4}-\d{2}-\d{2} /, "").replace(/\.md$/, "") || "Decision";
}

/** The vault's note (from `vault_note`) as a card, or null when it is not a decision note. */
export function parseDecisionNote(note: any): DecisionView | null {
  if (!note || typeof note !== "object" || typeof note.id !== "string") return null;
  if (!Array.isArray(note.tags) || !note.tags.includes("decision")) return null;
  const m = note.metadata && typeof note.metadata === "object" ? note.metadata : {};
  const raw: string[] = Array.isArray(m.options) ? m.options.map((o: unknown) => (typeof o === "string" ? o.trim() : "")).filter(Boolean) : [];
  // an option written "B (default)" is option "B" marked as the default; what is stored is what a pick must write back
  const marked = raw.find((o) => DEFAULT_MARK.test(o));
  const named = str(m.default);
  const dflt = named && raw.some((o) => o.toLowerCase() === named.toLowerCase()) ? raw.find((o) => o.toLowerCase() === named.toLowerCase())! : marked ?? null;
  const state = m.state === "open" ? "open" : m.state === "decided" ? "decided" : "other";
  return {
    id: note.id, question: questionOf(note.content, note.path), options: [...new Set(raw)], dflt, state,
    decided: str(m.decided), decidedBy: str(m.decided_by), updatedAt: typeof note.updatedAt === "string" ? note.updatedAt : "", task: str(m.task),
    decidedNote: str(m.decided_note),
    notes: Array.isArray(m.notes) ? m.notes.flatMap((n: any) => n && typeof n.text === "string" && n.text.trim() ? [{ text: n.text, at: String(n.at ?? ""), by: String(n.by ?? "") }] : []) : [],
  };
}

/** How an option reads on its button: without the "(default)" it may carry; the default gets its own label. */
export const optionLabel = (o: string): string => o.replace(DEFAULT_MARK, "") || o;

const shortQ = (question: string) => { const q = question.replace(/\s+/g, " ").trim(); return q.length > 120 ? q.slice(0, 119) + "…" : q; };

/** What a won tap posts in the room, as you: the pick, your words with it (T-226, escaped), the question, and the ref the room can look up. */
export function pickedLine(option: string, d: Pick<DecisionView, "id" | "question">, note = ""): string {
  const words = chatText(note);
  return `Picked: ${optionLabel(option)}${words ? ` — ${words}` : ""} (decision: ${shortQ(d.question)}) uni:${d.id}`;
}

/** T-226: what words sent with no pick post in the room, as you; a decision decided meanwhile (your tap lost) says what it was decided as. */
export function noteLine(note: string, d: Pick<DecisionView, "id" | "state" | "decided">): string {
  const head = d.state === "decided" && d.decided ? `Note on decision (decided already: ${chatText(optionLabel(d.decided))})` : "Note on decision (no pick yet)";
  return `${head}: ${chatText(note)} uni:${d.id}`;
}

/**
 * The room's open decisions no loaded message names: they are listed at the end of the room's chat, so an open decision the room asked
 * is tappable there even when the message that asked it is out of view or never carried the ref.
 */
export function unreferenced(known: readonly { id: string; channel: string | null }[], channel: string, named: ReadonlySet<string>): string[] {
  return known.filter((d) => d.channel === channel && !named.has(d.id)).map((d) => d.id);
}
