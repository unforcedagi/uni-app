// "Steer, don't chat" (T-122, pure, unit-tested in scripts/steer.test.ts): what a steer changed (the diff between the load before it and
// the load after), the Running ledger and Drafts read from their notes. Nothing here fetches.
import { ROOT } from "./treeCore.ts";
import { refKey, stripExt } from "./refs.ts";
import { subtreePaths, type RawNote, type Task, type TaskTree } from "./taskCore.ts";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const meta = (n: RawNote) => (n.metadata && typeof n.metadata === "object" ? n.metadata : {}) as Record<string, unknown>;
const leaf = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

// ---------------------------------------------------------------------------------------------- the effect of a steer

/** A steer, remembered locally: when it went, to which room, and the tasks as they were just before it. */
export type Steer = { steerId: string; room: string; at: number };
export type Mark = { id: string; /** What changed: due, state, priority, next, owner, status. */ field: string; was: string | null; now: string | null; at: number };
/** The fields a steer can move on a task. */
export const TASK_FIELDS = ["due", "state", "priority", "next", "owner"] as const;
export const POLL_MS = 10_000;
export const POLL_FOR_MS = 180_000;
/** How many polls: every 10 s for 3 minutes. */
export const POLL_COUNT = POLL_FOR_MS / POLL_MS;

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** `2026-10-13` as `Tue 10-13`. Anything that is not a date is shown as it is. */
export function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${WEEKDAY[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]} ${m[2]}-${m[3]}`;
}
/** A field's value as a person reads it: a due date as a weekday, nothing as "none". */
export function valueLabel(field: string, v: string | null): string {
  if (v === null || v === "") return "none";
  return field === "due" ? dayLabel(v) : v;
}

type Fields = Record<string, string | null>;
const taskFields = (t: Task): Fields => ({ due: t.due, state: t.state, priority: t.priority, next: t.next || null, owner: t.owner || null });
const stampOf = (iso: string | null | undefined) => { const n = iso ? Date.parse(iso) : NaN; return Number.isNaN(n) ? NaN : n; };

type Item = { id: string; updatedAt: string | null };
/**
 * Old load against new load: every item that was written after `at` (its `updatedAt`) and whose watched fields differ from the old load
 * is marked, one mark per changed field, with the old value. An item not in the old load is marked `new` (`was` null, field "added");
 * an item the old load had and the new one lacks has left the live list (done or archived elsewhere) and is not marked.
 * The old load is the baseline at the steer, so a mark stays correct on every later load.
 */
export function diffMarks<T extends Item>(before: readonly T[], after: readonly T[], at: number, fieldsOf: (t: T) => Fields): Mark[] {
  const old = new Map(before.map((t) => [t.id, t]));
  const out: Mark[] = [];
  for (const t of after) {
    const stamp = stampOf(t.updatedAt);
    if (!(stamp > at)) continue;
    const was = old.get(t.id);
    if (!was) { out.push({ id: t.id, field: "added", was: null, now: null, at: stamp }); continue; }
    const a = fieldsOf(was), b = fieldsOf(t);
    for (const k of Object.keys(b)) if ((a[k] ?? null) !== (b[k] ?? null)) out.push({ id: t.id, field: k, was: a[k] ?? null, now: b[k] ?? null, at: stamp });
  }
  return out;
}
export const diffTasks = (before: readonly Task[], after: readonly Task[], at: number): Mark[] => diffMarks(before, after, at, taskFields);
export const diffDrafts = (before: readonly Draft[], after: readonly Draft[], at: number): Mark[] => diffMarks(before, after, at, (d) => ({ status: d.status }));

/** "changed just now · was Tue 10-13": under two minutes it is "just now", then how long ago. */
export function changedLine(m: Pick<Mark, "field" | "was" | "at">, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - m.at) / 1000));
  const when = s < 120 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86_400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86_400)}d ago`;
  if (m.field === "added") return `added ${when}`;
  return `changed ${when} · was ${valueLabel(m.field, m.was)}`;
}

/** The marks by item id (an item can have several; the first reads, the rest follow it). */
export function marksById(marks: readonly Mark[]): Map<string, Mark[]> {
  const out = new Map<string, Mark[]>();
  for (const m of marks) out.set(m.id, [...(out.get(m.id) ?? []), m]);
  return out;
}

// ---------------------------------------------------------------------------------------------- Running and Drafts

/** The 0.1.44 ledger (queued, running, stalled, done, failed) and the T-125 run notes (running, done, blocked, decision, failed). */
export const RUN_STATES = ["queued", "running", "stalled", "blocked", "decision", "done", "failed"] as const;
export type RunState = (typeof RUN_STATES)[number];
/** One line of the T-118 dispatch ledger (`run` notes). */
export type Run = { id: string; path: string; node: string; task: string | null; what: string; by: string; state: RunState; started: string | null; updated: string | null; result: string | null; room: string | null;
  /** r31: the room's channel id (`channel`, set by `tasks.py run start --channel`): the one thing that says which room a waiting run opens */ channel?: string | null;
  /** r31: the event id (`message_ref`, `run start --message-ref`) of the message the run waits on, when it waits on a specific one: a row opens the room there */ message?: string | null };
export type DraftStatus = "drafting" | "ready";
export type Draft = { id: string; path: string; title: string; node: string; task: string | null; status: DraftStatus; updatedAt: string | null };

/** A node reference (path, id or `[[link]]`) as the node's path; ROOT for Uni; null when no such node (and not a path). */
export function nodePath(tree: TaskTree, ref: unknown): string | null {
  const k = refKey(ref);
  if (!k) return null;
  if (tree.rootRefs.has(k)) return ROOT;
  return tree.byPath.has(k) ? k : tree.idPath.get(k) ?? null;
}

export function parseRuns(notes: readonly RawNote[], tree: TaskTree): Run[] {
  const out: Run[] = [];
  for (const n of notes) {
    const id = str(n.id), path = str(n.path) && stripExt(str(n.path)!);
    if (!id || !path) continue;
    const m = meta(n);
    const state = str(m.state)?.toLowerCase();
    const node = nodePath(tree, m.node);
    if (!state || !(RUN_STATES as readonly string[]).includes(state) || node === null) continue;
    // T-125 run notes: `summary`, `worker`, `started_at`, `ended_at`. The 0.1.44 ledger: `what`, `by`, `started`, `updated`. Never the note's path.
    const task = str(m.task);
    out.push({ id, path, node, task, what: str(m.summary) ?? str(m.what) ?? (task ? `Working on ${task}` : "Working on it"), by: str(m.worker) ?? str(m.by) ?? "", state: state as RunState,
      started: str(m.started_at) ?? str(m.started), updated: str(m.ended_at) ?? str(m.updated) ?? str(n.updatedAt), result: str(m.result), room: str(m.room)?.replace(/^#/, "") ?? null, channel: str(m.channel), message: str(m.message_ref) });
  }
  return out;
}

/** `tasks` lets a draft that names only its task (`T-07`) find the node that task sits on. */
export function parseDrafts(notes: readonly RawNote[], tree: TaskTree, tasks: readonly Pick<Task, "title" | "node">[] = []): Draft[] {
  const out: Draft[] = [];
  for (const n of notes) {
    const id = str(n.id), path = str(n.path) && stripExt(str(n.path)!);
    if (!id || !path) continue;
    const m = meta(n);
    const status = str(m.status)?.toLowerCase();
    if (status !== "drafting" && status !== "ready") continue;
    const task = str(m.task);
    const node = nodePath(tree, m.node) ?? (task ? tasks.find((t) => t.title === task || t.title.startsWith(task + " "))?.node ?? null : null);
    if (node === null) continue;
    out.push({ id, path, title: leaf(path), node, task, status, updatedAt: str(n.updatedAt) });
  }
  return out;
}

/** A run that is still going: finished ones (done, failed) are history and are not listed as running. */
export const isActiveRun = (r: Pick<Run, "state">): boolean => r.state !== "done" && r.state !== "failed";

const under = (tree: TaskTree, path: string) => (path === ROOT ? null : new Set(subtreePaths(tree, path)));
/** The runs on a node and beneath it (ROOT: all), the active ones first (running, stalled, queued), then the finished, newest first. */
export function runsUnder(tree: TaskTree, path: string, runs: readonly Run[]): Run[] {
  const set = under(tree, path);
  const rank: Record<RunState, number> = { running: 0, blocked: 1, stalled: 2, queued: 3, decision: 4, failed: 5, done: 6 };
  return runs.filter((r) => !set || set.has(r.node)).sort((a, b) => rank[a.state] - rank[b.state] || (b.updated ?? "").localeCompare(a.updated ?? ""));
}
export function draftsUnder(tree: TaskTree, path: string, drafts: readonly Draft[]): Draft[] {
  const set = under(tree, path);
  return drafts.filter((d) => !set || set.has(d.node)).sort((a, b) => (a.status === b.status ? (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") : a.status === "ready" ? -1 : 1));
}
