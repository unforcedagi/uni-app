// "Where we are" (pure, unit-tested in scripts/roomsnav.test.ts): the typed summary of one level, built from its live tasks.
// Counts by state, what moved in the last week, and what needs the user split by priority. Private nodes (and tasks that sit under
// one, seen from above) give counts and a time only, never a title.
import { groupOf, priorityOf, PRIORITIES, sortTasks, type Priority, type Task } from "./taskCore.ts";

export const MOVED_DAYS = 7;
export const MOVED_SHOWN = 5;

export type Where = {
  /** Live tasks and open decisions at this level and below. */
  total: number; open: number; doing: number; waiting: number;
  /** Of those, the ones that need the user (theirs, or waiting on them, or a decision). */
  you: number;
  /** Needs you, by priority. `rows` are the tasks that may be named here; `count` also counts the private ones. */
  needs: Record<Priority, { rows: Task[]; count: number }>;
  /** Tasks changed in the last 7 days: the newest few that may be named, how many in all, and when the last one moved (ms). */
  moved: Task[]; movedCount: number; lastMoved: number | null;
};

const stamp = (t: Task) => (t.updatedAt ? Date.parse(t.updatedAt) : NaN);

/**
 * `hidden(node)`: whether titles under that node may not be named here (the node is private). `selfPrivate`: the level itself is private,
 * so no row is named at all.
 */
export function whereWeAre(a: { tasks: readonly Task[]; hidden: (node: string) => boolean; selfPrivate?: boolean; nowMs: number }): Where {
  const live = a.tasks.filter((t) => t.state === "open" || t.state === "doing" || t.state === "waiting");
  const named = (t: Task) => !a.selfPrivate && !a.hidden(t.node);
  const needs = Object.fromEntries(PRIORITIES.map((p) => [p, { rows: [] as Task[], count: 0 }])) as Where["needs"];
  const mine = live.filter((t) => groupOf(t) === "you");
  for (const t of mine) { const b = needs[priorityOf(t)]; b.count++; if (named(t)) b.rows.push(t); }
  for (const p of PRIORITIES) needs[p].rows = sortTasks(needs[p].rows);
  const since = a.nowMs - MOVED_DAYS * 86_400_000;
  const recent = live.filter((t) => stamp(t) >= since).sort((x, y) => stamp(y) - stamp(x));
  const last = recent.length ? stamp(recent[0]) : null;
  return {
    total: live.length, open: live.filter((t) => t.state === "open").length, doing: live.filter((t) => t.state === "doing").length, waiting: live.filter((t) => t.state === "waiting").length,
    you: mine.length, needs, moved: recent.filter(named).slice(0, MOVED_SHOWN), movedCount: recent.length, lastMoved: last,
  };
}

/** `T-65` from `T-65 Sponsorship invoice draft`, and the rest. Titles without an id keep the whole title. */
export function splitTitle(title: string): { id: string | null; rest: string } {
  const m = /^([A-Z]{1,4}-\d+)\s+(.*)$/s.exec(title.trim());
  return m ? { id: m[1], rest: m[2] } : { id: null, rest: title.trim() };
}

/** A leading date (and time) a writer put in front of a title: "2026-10-13 ", "2026-10-13 14:05 · ". */
const DATE_LEAD = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}[:.]\d{2}(?::\d{2})?)?\s*(?:[-–—:·|]\s*)?(?=\S)/;
/** A "(preview: …" tail a writer appended (closed or not): a fragment of the note, never part of the title. */
const PREVIEW_TAIL = /\s*\((?:preview|excerpt|snippet)\s*:[^)]*\)?\s*$/i;
const CUT_END = /(…|\.\.\.)\s*$/;

/**
 * A task's or decision's title as every surface shows it (r16, one cleaner for the companion, the work view and the sheet): without its id,
 * a leading date and a "(preview: …" tail. `cut`: the title itself was cut short ("…"); `previewed`: a preview tail was dropped, so the
 * note holds more than the title says (a decision's question is then read from its note before it is answered).
 */
export function taskTitle(title: string): { id: string | null; rest: string; cut: boolean; previewed: boolean } {
  const { id, rest } = splitTitle(title);
  let r = rest;
  const tail = PREVIEW_TAIL.exec(r);
  if (tail && tail.index > 0) r = r.slice(0, tail.index);
  r = r.replace(DATE_LEAD, "").trim();
  if (!r) return { id, rest, cut: CUT_END.test(rest), previewed: false };
  return { id, rest: r, cut: CUT_END.test(r), previewed: !!tail && tail.index > 0 };
}
