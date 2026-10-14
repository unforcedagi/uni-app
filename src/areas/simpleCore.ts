// T-124 "Simple first" (pure, unit-tested in scripts/steer.test.ts): what the room's quiet companion says. One sentence for where
// the room stands, at most three things that need the user (Now first), the chat composer's placeholder.
import { groupOf, PRIORITIES, type Task } from "./taskCore.ts";
import type { Where } from "./whereCore.ts";
import { ROOT } from "./treeCore.ts";

/** The first sentence of the level's lede, as plain text and whole (a long one is clamped on screen, never cut here: it opens in full). */
export function firstSentence(text: string | null | undefined): string {
  const plain = (text ?? "").replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  if (!plain) return "";
  const m = /^.*?[.!?](?=\s|$)/.exec(plain);
  return m ? m[0] : plain;
}

/**
 * Whether a task belongs in Needs you: the companion's list and the tree's dots use this one rule (r12). The user's own (owner, or waiting
 * on them) at Now or Soon (unsorted is Soon), and every open decision; live, never Someday. Snoozed and finished tasks are dropped before.
 */
export function needsYou(t: Pick<Task, "kind" | "owner" | "waitingOn" | "priority" | "state">): boolean {
  if (t.state !== "open" && t.state !== "doing" && t.state !== "waiting") return false;
  return groupOf(t) === "you" && (t.kind === "decision" || t.priority !== "someday");
}

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
 * Items that need you in a private area, named only by where they are (r13): from above, one row per private area ("A private item in
 * Sanctum", opening that area); at the private area's own level, one row per item ("A private item here", opening its note). They count.
 */
export type PrivateNeed = { key: string; count: number; place: string | null; open: { path: string } | { note: string } };
/** Needs you at one level, the one list every surface reads (r13): the companion, "+N in areas", the dots and the work view add up to `total`. */
export type NeedsFeed = { rows: Task[]; privates: PrivateNeed[]; total: number };

/** Now before Soon (overdue first), then by due date (undated last), then a decision before a task, then by title. */
export function rankNeeds(list: readonly Task[], today = localDay()): Task[] {
  const rank = (t: Task) => (isOverdue(t.due, today) ? -1 : t.priority === "now" ? 0 : t.priority === "someday" ? 2 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || Number(b.kind === "decision") - Number(a.kind === "decision") || a.title.localeCompare(b.title));
}

/**
 * Everything that needs you at a level and below, by the one rule (`needsYou`). `privateOf(node)`: the private area a node sits in, or null.
 * `self`: the level itself is private (it is that area, or inside one), so nothing here is named; each item is its own row, opening its note.
 */
export function needsFeed(tasks: readonly Task[], privateOf: (node: string) => PrivatePlace | null, self: PrivatePlace | null = null, today = localDay()): NeedsFeed {
  const all = rankNeeds(tasks.filter(needsYou), today);
  if (self) return { rows: [], privates: all.map((t) => ({ key: t.id, count: 1, place: null, open: { note: t.id } })), total: all.length };
  const rows: Task[] = [];
  const by = new Map<string, PrivateNeed>();
  for (const t of all) {
    const p = privateOf(t.node);
    if (!p) { rows.push(t); continue; }
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

/** "A private item in Sanctum", "2 private items in Sanctum", "A private item here". */
export function privateLabel(p: Pick<PrivateNeed, "count" | "place">): string {
  const what = p.count === 1 ? "A private item" : `${p.count} private items`;
  return p.place ? `${what} in ${p.place}` : `${what} here`;
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

/** How long ago, quietly: "today", "yesterday", "3 days ago", "2 weeks ago", else the month and day. Empty for a missing or future time. */
export function quietAgo(iso: string | null | undefined, nowMs: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t) || t > nowMs + 60_000) return "";
  const days = Math.floor((nowMs - t) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type Recent = Pick<Task, "title" | "state" | "kind" | "updatedAt" | "options">;
const plainTitle = (t: string) => t.replace(/^T-\d+\s+/, "");

/**
 * Where the room stands, in one sentence and never a count. The node's own `stands` (with `stands_at` as a quiet time); without it the
 * newest decision, else the newest task change, in plain words; else nothing.
 */
export function standsLine(stands: { text: string; at: string | null } | null | undefined, tasks: readonly Recent[], nowMs: number): { text: string; ago: string } | null {
  const text = firstSentence(stands?.text);
  if (text) return { text, ago: quietAgo(stands?.at, nowMs) };
  const stamped = tasks.filter((t) => t.updatedAt && !Number.isNaN(Date.parse(t.updatedAt))).sort((a, b) => Date.parse(b.updatedAt!) - Date.parse(a.updatedAt!));
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

const ASK_MAX = 280;
/**
 * The full question of a decision (or task) whose title is cut: the first real line of its content, without `_Converted from …_` lines or
 * the "Decision (default yes):" label, kept to whole sentences (the first one or two) and at most 280 characters. "" when there is nothing.
 */
/** A list item ("- Ship it", "2. Wait"): a decision's options are listed so, and an option is never its question (r13). */
export const isListLine = (l: string): boolean => /^([-*+•]|\d+[.)])\s/.test(l.trim());
export function askFromContent(content: string | null | undefined): string {
  const line = (content ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^_?converted from\b/i.test(l.replace(/^[*_>\s]+/, "")) && !/^#{1,6}\s/.test(l) && !/^---+$/.test(l) && !isListLine(l));
  if (!line) return "";
  const plain = line.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`>]/g, "").replace(/^decision\s*(\([^)]*\))?\s*[:\-–—]\s*/i, "").replace(/\s+/g, " ").trim();
  if (plain.length <= ASK_MAX) return plain;
  const sentences = plain.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [];
  let out = "";
  for (const sen of sentences) { if ((out + sen).length > ASK_MAX) break; out = `${out}${sen}`.replace(/\s*$/, " "); }
  if (out.trim()) return out.trim();
  return `${plain.slice(0, ASK_MAX).replace(/\s+\S*$/, "")}…`;
}

/** A cut title without its "…": what is left reads as a plain fragment, never as a row that ends on an ellipsis. */
export const withoutCut = (rest: string): string => rest.replace(/\s*(…|\.\.\.)\s*$/, "").trim();

/** What a Needs-you row says about its ask, given what is known: the full question, a whole title, or that there is no whole question. */
export type RowAsk = { text: string; /** a decision with no full question anywhere: open it to see the question, no buttons and no fragment */ openToDecide: boolean };
export const OPEN_TO_SEE = "Open to see the question";
export function rowAsk(full: string, ask: string | undefined, isDecision: boolean, hasNext: boolean): RowAsk {
  if (!isCutTitle(full)) return { text: full, openToDecide: false };
  if (ask && !isCutTitle(ask)) return { text: ask, openToDecide: false };
  if (isDecision) return { text: OPEN_TO_SEE, openToDecide: true };
  return { text: hasNext ? withoutCut(full) : "", openToDecide: false };
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
