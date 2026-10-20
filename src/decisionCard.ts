// T-212: a decision as a card in the chat of the room that asked it (pure, unit-tested in scripts/decisionCard.test.ts).
// A room posts a line with `uni:<id>` of a `Decisions/…` note (tasks.py `decide new` prints it); the app reads that note and shows
// the question with one button per option. A tap is a compare-and-set in the vault (open -> decided) and, only when that tap won,
// a short message from you in the room ("Picked: B …") so the room's Uni session hears the answer.

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
};

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
  };
}

/** How an option reads on its button: without the "(default)" it may carry; the default gets its own label. */
export const optionLabel = (o: string): string => o.replace(DEFAULT_MARK, "") || o;

/** What a won tap posts in the room, as you: the pick, the question, and the ref the room can look up. */
export function pickedLine(option: string, d: Pick<DecisionView, "id" | "question">): string {
  const q = d.question.replace(/\s+/g, " ").trim();
  return `Picked: ${optionLabel(option)} (decision: ${q.length > 120 ? q.slice(0, 119) + "…" : q}) uni:${d.id}`;
}

/**
 * The room's open decisions no loaded message names: they are listed at the end of the room's chat, so an open decision the room asked
 * is tappable there even when the message that asked it is out of view or never carried the ref.
 */
export function unreferenced(known: readonly { id: string; channel: string | null }[], channel: string, named: ReadonlySet<string>): string[] {
  return known.filter((d) => d.channel === channel && !named.has(d.id)).map((d) => d.id);
}
