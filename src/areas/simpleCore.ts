// T-124 "Simple first" (pure, unit-tested in scripts/steer.test.ts): what the room's quiet companion says. One sentence for where
// the room stands, at most three things that need the user (Now first), the chat composer's placeholder.
import { isMe, PRIORITIES, type Task } from "./taskCore.ts";
import { taskTitle, type Where } from "./whereCore.ts";
import { ROOT } from "./treeCore.ts";

/** The first sentence of the level's lede, as plain text and whole (a long one is clamped on screen, never cut here: it opens in full). */
export function firstSentence(text: string | null | undefined): string {
  const plain = (text ?? "").replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  if (!plain) return "";
  const m = /^.*?[.!?](?=\s|$)/.exec(plain);
  return m ? m[0] : plain;
}

/**
 * Whether a task belongs in Needs you: the companion's list, the work view and the tree's dots use this one rule (r12). Every open decision,
 * and the user's own tasks (r16: `owner` is the user; a room's or Uni's task that only waits on them is theirs to move, so it stays in
 * In motion as "Waiting on you") at Now or Soon (unsorted is Soon); live, never Someday. Snoozed and finished tasks are dropped before.
 */
export function needsYou(t: Pick<Task, "kind" | "owner" | "waitingOn" | "priority" | "state">): boolean {
  if (t.state !== "open" && t.state !== "doing" && t.state !== "waiting") return false;
  return t.kind === "decision" || (isMe(t.owner) && t.priority !== "someday");
}
/** The user's own: an open decision, or a task they own (r16). Everything else here is someone else's, in In motion. */
export const isMine = (t: Pick<Task, "kind" | "owner">): boolean => t.kind === "decision" || isMe(t.owner);

/** How many items under each node path need you there (the node's own, never its children's): the tree's dots. */
export function needsByNode(tasks: readonly Task[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tasks) if (needsYou(t)) m.set(t.node, (m.get(t.node) ?? 0) + 1);
  return m;
}

/**
 * The tree's dots (r13): each item that needs you counts on its node's row or, when that node has no row in the tree, on its nearest
 * ancestor's (else Uni's), so the dots under a level add up to that level's feed.
 */
export function needsByRow(tasks: readonly Task[], rows: ReadonlySet<string>, parentOf: (path: string) => string | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tasks) {
    if (!needsYou(t)) continue;
    let at: string | undefined = t.node;
    for (let n = 0; at !== undefined && at !== ROOT && !rows.has(at) && n < 64; n++) at = parentOf(at);
    const key = at !== undefined && rows.has(at) ? at : ROOT;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

/** Uni's own panel (r12): what is Uni's own, then at most `fromAreas` from the areas by urgency; the rest is in "All of Uni's work". */
export function uniNeeds(feed: readonly Task[], fromAreas = 3): Task[] {
  const own = feed.filter((t) => t.node === ROOT);
  return [...own, ...feed.filter((t) => t.node !== ROOT).slice(0, fromAreas)];
}

/** A place whose words are never shown elsewhere (a private area), as the feed names it: by place only. */
export type PrivatePlace = { path: string; name: string };
/**
 * Items that need you in a private area, seen from outside it (r14): one line per private area, "Sanctum: 2 for you ›", opening that area.
 * Inside the area Aaron opened himself, its items are ordinary rows. They always count.
 */
export type PrivateNeed = { key: string; count: number; place: string; open: { path: string } };
/** Needs you at one level, the one list every surface reads (r13): the companion, "+N in areas", the dots and the work view add up to `total`. */
export type NeedsFeed = { rows: Task[]; privates: PrivateNeed[]; total: number };

/** Now before Soon (overdue first), then by due date (undated last), then a decision before a task, then by title. */
export function rankNeeds(list: readonly Task[], today = localDay()): Task[] {
  const rank = (t: Task) => (isOverdue(t.due, today) ? -1 : t.priority === "now" ? 0 : t.priority === "someday" ? 2 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || Number(b.kind === "decision") - Number(a.kind === "decision") || a.title.localeCompare(b.title));
}

/**
 * Everything that needs you at a level and below, by the one rule (`needsYou`). `privateOf(node)`: the private area a node sits in, or null.
 * `self`: the private area this level is (or sits in), opened by the user: its own items are ordinary rows with their titles (r14); items in
 * any other private area are one line per area.
 */
export function needsFeed(tasks: readonly Task[], privateOf: (node: string) => PrivatePlace | null, self: PrivatePlace | null = null, today = localDay()): NeedsFeed {
  const all = rankNeeds(tasks.filter(needsYou), today);
  const rows: Task[] = [];
  const by = new Map<string, PrivateNeed>();
  for (const t of all) {
    const p = privateOf(t.node);
    if (!p || (self && p.path === self.path)) { rows.push(t); continue; }
    const g = by.get(p.path);
    if (g) g.count++; else by.set(p.path, { key: p.path, count: 1, place: p.name, open: { path: p.path } });
  }
  return { rows, privates: [...by.values()], total: all.length };
}

/** Uni's panel (r13): Uni's own rows, then the first `fromAreas` from the areas; `rest` is how many named area rows wait in "All of Uni's work". */
export function uniPanel(feed: NeedsFeed, fromAreas = 3): NeedsFeed & { rest: number } {
  const own = feed.rows.filter((t) => t.node === ROOT);
  const areas = feed.rows.filter((t) => t.node !== ROOT);
  return { ...feed, rows: [...own, ...areas.slice(0, fromAreas)], rest: Math.max(0, areas.length - fromAreas) };
}

/** "Sanctum: 2 for you": a private area's items, from outside it, by place and count only (r14). */
export function privateLabel(p: Pick<PrivateNeed, "count" | "place">): string {
  return `${p.place}: ${p.count} for you`;
}

const ACTION_VERBS = /^(say|reply|tell|answer|send|approve|confirm|review|decide|sign|pay|call|email|write|read|pick|choose|check|book|schedule|draft|merge|deploy|ship|test|ask|give|post|share|record|update|fix|add|set|move|file|submit|finish|meet|join|buy|order|cancel|renew|follow|try|look|go|let|ping|invite|publish|upload|run|print|prepare|bring|forward|accept|decline|reject)(?=[\s:,]|$)/i;
/** A next step that names something to do ("Say go to deploy #38 + #58"), not a status ("Waiting on Casey"): the task sheet leads with it. */
export function actionLead(next: string | null | undefined): string | null {
  const t = (next ?? "").replace(/[*_`>]/g, "").replace(/\s+/g, " ").trim();
  if (!t || !ACTION_VERBS.test(t)) return null;
  return t[0].toLocaleUpperCase() + t.slice(1);
}
/** What a "Say …" / "Reply …" / "Tell …" step would put in the room's composer (never sent): the words after the verb. Null for other steps. */
export function sayText(lead: string | null): string | null {
  const m = /^(say|reply|tell|answer)\b[\s:,-]*(?:with\s+|to\s+(?:the\s+)?room\s+)?(.*)$/i.exec(lead ?? "");
  if (!m) return null;
  const words = m[2].replace(/^["“'‘]|["”'’]$/g, "").trim();
  return words || null;
}

/**
 * The needs-you feed (T-124 r7): only what the user must do. Their tasks (owner, or waiting on them) that are live and not snoozed (the
 * caller's `Where` has already dropped those, and anything done or archived), at priority Now or Soon (unsorted counts as Soon), plus open
 * decisions; Someday is not here. Now before Soon, then by due date (undated last), then a decision before a task, then by title.
 */
export function topNeeds(w: Where, _path?: string, max = Infinity, today = localDay()): Task[] {
  const rank = (t: Task) => (isOverdue(t.due, today) ? -1 : t.priority === "now" ? 0 : t.priority === "someday" ? 2 : 1);
  const all = PRIORITIES.flatMap((p) => w.needs[p].rows).filter(needsYou);
  return all.sort((a, b) => rank(a) - rank(b) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || Number(b.kind === "decision") - Number(a.kind === "decision") || a.title.localeCompare(b.title)).slice(0, max);
}

/** Today as YYYY-MM-DD, local. */
export const localDay = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** A due date (YYYY-MM-DD) before today. */
export const isOverdue = (due: string | null | undefined, today = localDay()): boolean => !!due && due < today;
/** "due Oct 14", or "was due Oct 12" once it has passed. Null without a date. */
export function dueLine(due: string | null | undefined, today = localDay()): string | null {
  if (!due) return null;
  const d = new Date(`${due}T12:00:00`);
  if (Number.isNaN(d.getTime())) return due;
  return `${isOverdue(due, today) ? "was due" : "due"} ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** A title says what to do when it has words beyond its id; "T-12" or one bare word does not. */
export function actionableTitle(rest: string): boolean {
  return rest.trim().split(/\s+/).filter(Boolean).length >= 2;
}

/** A stamp as a moment: a bare date (`2026-10-13`) is that day on the local calendar, never UTC midnight (the evening before, west of UTC). */
export const stampMs = (iso: string | null | undefined): number => (!iso ? NaN : /^\d{4}-\d{2}-\d{2}$/.test(iso.trim()) ? new Date(`${iso.trim()}T12:00:00`).getTime() : Date.parse(iso));
/** Whole calendar days between two moments on the local clock (r15: "yesterday" is the day before today, not 24 hours ago). */
export const calendarDays = (fromMs: number, toMs: number): number => {
  const a = new Date(fromMs), b = new Date(toMs);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000);
};
/**
 * How long ago, quietly: "today", "yesterday", "3 days ago", "2 weeks ago", else the month and day. Empty for a missing or future time.
 * By calendar day on one local clock (r15), so every room says the same of the same moment.
 */
export function quietAgo(iso: string | null | undefined, nowMs: number): string {
  const t = stampMs(iso);
  if (Number.isNaN(t) || t > nowMs + 60_000) return "";
  const days = Math.max(0, calendarDays(t, nowMs));
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type Recent = Pick<Task, "title" | "state" | "kind" | "updatedAt" | "options">;
const plainTitle = (t: string) => withoutCut(taskTitle(t).rest);

/**
 * Where the room stands, in one sentence and never a count. The node's own `stands` (with `stands_at` as a quiet time); without it the
 * newest decision, else the newest task change, in plain words; else nothing.
 */
export function standsLine(stands: { text: string; at: string | null } | null | undefined, tasks: readonly Recent[], nowMs: number): { text: string; ago: string } | null {
  const text = firstSentence(stands?.text);
  if (text) return { text, ago: quietAgo(stands?.at, nowMs) };
  const stamped = tasks.filter((t) => t.updatedAt && !Number.isNaN(stampMs(t.updatedAt))).sort((a, b) => stampMs(b.updatedAt) - stampMs(a.updatedAt));
  const pick = stamped.find((t) => t.kind === "decision") ?? stamped[0];
  if (!pick) return null;
  const what = plainTitle(pick.title);
  const line = pick.kind === "decision" ? `Waiting on a decision: ${what}.` : pick.state === "doing" ? `${what} is underway.` : pick.state === "waiting" ? `${what} is waiting.` : `Latest: ${what}.`;
  return { text: line, ago: quietAgo(pick.updatedAt, nowMs) };
}

/** `Message #atlas/build`; a node held by a room says whose (`Message #atlas`); no room, the node's name. */
export function chatPlaceholder(a: { name: string; slash: string | null; heldBy: string | null }): string {
  if (a.slash) return `Message #${a.slash}`;
  if (a.heldBy) return `Message #${a.heldBy.replace(/^#/, "")}`;
  return `Message ${a.name}`;
}

/** A title that was cut short on the way into the vault ("…", "..."), so the real question is in the note's content. */
export const isCutTitle = (rest: string): boolean => /(…|\.\.\.)\s*$/.test(rest.trim());

/** The longest question a Needs-you row shows in full beside its answers; a longer one opens to decide (r14). */
export const ROW_ASK_MAX = 280;
/** A list item ("- Ship it", "2. Wait"): a decision's options are listed so, and an option is never its question (r13). */
export const isListLine = (l: string): boolean => /^([-*+•]|\d+[.)])\s/.test(l.trim());
const skipLine = (l: string) => /^_?converted from\b/i.test(l.replace(/^[*_>\s]+/, "")) || /^#{1,6}\s/.test(l) || /^---+$/.test(l) || isListLine(l);
/**
 * The full question of a decision (or task) whose title is cut (r14): the first paragraph of its content, whole, without `_Converted from …_`
 * lines, headings, rules, list items or the "Decision (default yes):" label. Never trimmed: a shortened question is a preview
 * (`askPreview`), and only a whole one is answered. "" when there is nothing.
 */
export function askFromContent(content: string | null | undefined): string {
  const lines = (content ?? "").split(/\r?\n/).map((l) => l.trim());
  const start = lines.findIndex((l) => l && !skipLine(l));
  // r16: a note that is only its heading and its options ("# Ship the chat? (preview: …)" then a list): the heading is the question
  if (start < 0) { const h = lines.find((l) => /^#{1,6}\s+\S/.test(l)); return h ? askFromContent(h.replace(/^#{1,6}\s+/, "")) : ""; }
  const para: string[] = [];
  for (const l of lines.slice(start)) { if (!l || skipLine(l)) break; para.push(l); }
  return para.join(" ").replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`>]/g, "").replace(/^decision\s*(\([^)]*\))?\s*[:\-–—]\s*/i, "").replace(/\s+/g, " ").trim();
}
/** A short preview of a long question: its first whole sentences within `max`, else its first words, and always "…" when anything is left out. */
export function askPreview(text: string, max = 160): string {
  const plain = text.replace(/\s+/g, " ").trim();
  if (plain.length <= max) return plain;
  let out = "";
  for (const sen of plain.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? []) { if ((out + sen).length > max) break; out = `${out}${sen}`; }
  return `${(out.trim() || plain.slice(0, max).replace(/\s+\S*$/, "")).replace(/[\s,;:]+$/, "")} …`;
}

/** A Needs-you row shows a whole question beside its answers only when it fits the row; a longer one opens to decide (r14). */
export const fitsRow = (q: string): boolean => q.length <= ROW_ASK_MAX;

/**
 * A decision's whole question (r14), or null when none is known: its title when the title is not cut (`rest`, without its id), else the ask
 * read from its note, but only when that ask was read at the row's own revision (`askAt === updatedAt`), so the question shown and the
 * answer written are the same revision's. Punctuation proves nothing: a cut title with no ask at this revision has no question here.
 */
export function decisionQuestion(rest: string, ask: string | undefined, askAt: string | null | undefined, updatedAt: string | null, inNote = isCutTitle(rest)): string | null {
  if (!inNote) { const t = rest.replace(/\s+/g, " ").trim(); return t.replace(/^decision\s*(\([^)]*\))?\s*[:\-–—]\s*/i, "").trim() || t || null; }
  // an ask that is itself cut (the note repeats the cut title) is no whole question either
  if (ask && !isCutTitle(ask) && updatedAt && askAt === updatedAt) return ask;
  return null;
}

/** Words a fragment must not end on ("…feature 4, the"): an article, a preposition or a joining word left hanging. */
const DANGLING = /^(a|an|the|to|of|for|in|on|at|by|with|and|or|but|nor|who|whom|whose|that|which|from|as|is|are|was|be|if|than|then|into|onto|about|your|their|its|this|these|those|our|my|so|via|per|&|\+|-|–|—)$/i;
/** The first whole words of a text within `max` characters, never ending on a hanging word or a separator, and never with "…" (r16). */
export function firstWords(text: string, max = 48): string {
  const words = withoutCut(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const out: string[] = [];
  for (const w of words) { if (out.length && [...out, w].join(" ").length > max) break; out.push(w); }
  const strip = (w: string) => w.replace(/[,;:(\[–—-]+$/, "");
  while (out.length > 1 && (DANGLING.test(strip(out[out.length - 1])) || !strip(out[out.length - 1]))) out.pop();
  if (out.length) out[out.length - 1] = strip(out[out.length - 1]) || out[out.length - 1];
  return out.join(" ");
}
/**
 * A decision row with no whole question to show (r16): the verb first, the first words, and the way in: "Decide: Uni adds Benya's missing
 * feature 4". The row opens to decide; it never ends on "…" with nothing to act on.
 */
export const decideLine = (words: string): string => {
  const w = firstWords(words);
  if (!w) return "A decision waits on you";
  // a question that already leads with the verb keeps it once ("Decide the ATLAS hosting", never "Decide: Decide …")
  return /^decide\b/i.test(w) ? w.replace(/^decide\b\s*:?\s*/i, "Decide: ") : `Decide: ${w}`;
};

/** The vault's task writer keeps `next` to 140 characters (tasks.py): a step that long with no ending was cut there (r16). */
export const NEXT_CAP = 140;
/**
 * A task's next step as rows show it (r16): a step cut at the writer's 140 characters loses its last (possibly partial) word and any hanging
 * word, and says it was cut ("…"), so a row never ends mid-phrase ("…in the"). `cut`: the full step is only in the note.
 */
export function stepText(next: string): { text: string; cut: boolean } {
  const t = next.replace(/\s+/g, " ").trim();
  if (t.length < NEXT_CAP || /[.!?)"”’'\]]$/.test(t)) return { text: t, cut: false };
  const words = t.split(" ");
  words.pop();
  while (words.length > 1 && DANGLING.test(words[words.length - 1].replace(/[,;:(\[]+$/, ""))) words.pop();
  return { text: `${words.join(" ").replace(/[\s,;:(\[–—-]+$/, "")} …`, cut: true };
}

/** A cut fragment as whole words (r16): no "…", no unclosed "(3" tail, no hanging word ("…install flow (3" → "…install flow"). */
export function wholeWords(text: string): string {
  let t = withoutCut(text);
  const open = t.lastIndexOf("("); if (open > 0 && t.indexOf(")", open) < 0) t = t.slice(0, open);
  const words = t.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const strip = (w: string) => w.replace(/[,;:(\[–—+&-]+$/, "");
  while (words.length > 1 && (DANGLING.test(strip(words[words.length - 1])) || !strip(words[words.length - 1]))) words.pop();
  if (words.length) words[words.length - 1] = strip(words[words.length - 1]) || words[words.length - 1];
  return words.join(" ");
}
/** A cut title without its "…": what is left reads as a plain fragment, never as a row that ends on an ellipsis. */
export const withoutCut = (rest: string): string => rest.replace(/\s*(…|\.\.\.)\s*$/, "").trim();

/** What a Needs-you row says about its ask, given what is known: the full question, a whole title, or that there is no whole question. */
export type RowAsk = { text: string; /** a decision with no full question anywhere: open it to see the question, no buttons and no fragment */ openToDecide: boolean };
export const OPEN_TO_SEE = "Open to see the question";
export function rowAsk(full: string, ask: string | undefined, isDecision: boolean, hasNext: boolean, cut = isCutTitle(full)): RowAsk {
  if (!cut) return { text: full, openToDecide: false };
  if (ask && !isCutTitle(ask)) return { text: ask, openToDecide: false };
  if (isDecision) return { text: OPEN_TO_SEE, openToDecide: true };
  return { text: hasNext ? wholeWords(full) : "", openToDecide: false };
}

/** A decision's ask as a question: sentence-cased, and "Your call:" above it when the stored ask does not end in "?". */
export function askLead(text: string): { text: string; yourCall: boolean } {
  const t = text.trim();
  const cased = t ? t[0].toLocaleUpperCase() + t.slice(1) : t;
  return { text: cased, yourCall: !!cased && !/\?["')\]]*$/.test(cased) };
}

/** One plain line for where a task stands, never both the state and who it waits on ("waiting, waiting on aaron"). */
export function stateLine(t: { state: string; waitingOn: string | null; kind: string }, isMeFn: (who: string | null) => boolean, nameOf: (who: string) => string = (w) => w): string {
  if (t.kind === "decision") return "Needs your decision";
  if (isMeFn(t.waitingOn)) return "Waiting on you";
  // r16: the writer's markers read as words, never "Waiting on blocked"
  const marker: Record<string, string> = { blocked: "Blocked", parked: "Parked", external: "Waiting on someone outside" };
  if (t.waitingOn && marker[t.waitingOn.toLowerCase()]) return marker[t.waitingOn.toLowerCase()];
  if (t.waitingOn) return `Waiting on ${nameOf(t.waitingOn)}`;
  return t.state === "doing" ? "In progress" : t.state === "waiting" ? "Waiting" : "Open";
}

/** The cut-title reads that matter most go first: decisions, then Now, then the soonest due. */
export function askOrder<T extends { kind: string; priority: string | null; due: string | null; title: string }>(tasks: readonly T[]): T[] {
  const rank = (t: T) => (t.kind === "decision" ? 0 : t.priority === "now" ? 1 : 2);
  return [...tasks].sort((a, b) => rank(a) - rank(b) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.title.localeCompare(b.title));
}

/** How many text lines each part of a row may take so the whole stays within `budget` (3): title first, then the due line, then the next step. */
export function lineBudget(titleLines: number, hasDue: boolean, budget = 3): { next: number } {
  return { next: Math.max(0, budget - Math.min(titleLines, budget) - (hasDue ? 1 : 0)) };
}

/** Of the room's height, what the conversation keeps before the strip gets any (r16), with the whole composer. */
export const CONVERSATION_SHARE = 0.4;
/** Less room than this for the strip's body and it opens as a sheet over the room instead of pushing the conversation away. */
export const STRIP_MIN_BODY = 200;
/**
 * Where an opened strip goes (r16): inline (with this many px for its body) when the room keeps its composer and 40% of its height for the
 * conversation and still has STRIP_MIN_BODY to spare; otherwise a sheet over the room. Pure: the numbers are measured by the strip.
 */
export function stripRoom(m: { room: number; above: number; line: number; composer: number }): { mode: "inline"; body: number } | { mode: "sheet" } {
  const body = Math.floor(m.room - m.above - m.line - m.composer - CONVERSATION_SHARE * m.room);
  return body >= STRIP_MIN_BODY ? { mode: "inline", body } : { mode: "sheet" };
}
