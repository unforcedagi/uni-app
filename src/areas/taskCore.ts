// Tasks as Parachute objects (pure, unit-tested in scripts/tasks.test.ts): parse `task` and `decision` notes, build the node tree
// from `node` notes, take a subtree, group by owner, roll counts up the tree. Nothing here fetches.
import { ROOT } from "./treeCore.ts";
import { pathResolver, refKey, stripExt } from "./refs.ts";
import { activeProfile, isAgentOwner, type VaultProfile } from "./profile.ts";
export { refKey };

export type TaskState = "open" | "doing" | "waiting" | "done" | "archived";
/** A decision is `open` until `decided`; it reads as a task whose closing state is `decided`. */
export type AnyState = TaskState | "decided";
export const LIVE_STATES: readonly TaskState[] = ["open", "doing", "waiting"];

export type RawNote = {
  id?: unknown; path?: unknown; tags?: unknown; metadata?: unknown; updatedAt?: unknown;
  lastUpdatedBy?: unknown; lastUpdatedVia?: unknown; content?: unknown;
};

/** `priority` on a task note: how soon it needs doing. Absent means unsorted, which reads as `soon`. */
export type Priority = "now" | "soon" | "someday";
export const PRIORITIES: readonly Priority[] = ["now", "soon", "someday"];
export const PRIORITY_LABEL: Record<Priority, string> = { now: "Now", soon: "Soon", someday: "Someday" };
export const priorityOf = (t: Pick<Task, "priority">): Priority => t.priority ?? "soon";

export type Task = {
  id: string; path: string; title: string; kind: "task" | "decision";
  /** The node it belongs to, as a node path (ROOT for the Uni root). */
  node: string;
  state: AnyState; owner: string; waitingOn: string | null; due: string | null; next: string; room: string | null;
  /** `YYYY-MM-DD`: hidden until that day (the state stays as it was). */
  snoozedUntil: string | null;
  /** null: not sorted yet (shown as `soon`). */
  priority: Priority | null;
  /** Who set `priority`: "hand" (a person, kept by weigh.py), "weigh.py <date>" (automatic triage), or null. */
  priorityBy: string | null;
  updatedAt: string | null; lastUpdatedBy: string | null; lastUpdatedVia: string | null;
  /** An open decision's choices (`options[]`), as the labels to show; empty for a task or a decision with none. */
  options: string[];
  /** The full question when the title was cut short ("…"): the first line of the note's content, loaded for those only. */
  ask?: string;
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const leaf = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export type TaskNode = { id: string; path: string; name: string; parent: string | null; room: string | null; status: string; isRoot: boolean; /** `metadata.stands` (where it stands, one sentence) and `stands_at` (when it was written). */ stands?: string | null; standsAt?: string | null };

/** `node` notes in. The root (the profile's `rootTag`: `uni` in Uni's vault, `root` in the pack) is kept apart: its children are the top level. */
export function parseNodes(notes: readonly RawNote[], rootTag: string = activeProfile().rootTag): { nodes: TaskNode[]; rootPath: string | null } {
  const out = new Map<string, TaskNode>();
  let rootPath: string | null = null;
  for (const n of notes) {
    const id = str(n.id), path = str(n.path) && stripExt(str(n.path)!);
    if (!id || !path) continue;
    const tags = Array.isArray(n.tags) ? n.tags : [];
    const m = (n.metadata && typeof n.metadata === "object" ? n.metadata : {}) as Record<string, unknown>;
    const isRoot = tags.includes(rootTag);
    if (isRoot) rootPath = path;
    if (/\/(Brief|app)$/.test(path)) continue;
    const status = str(m.status) ?? "active";
    out.set(path, { id, path, name: leaf(path), parent: refKey(m.parent), room: str(m.room)?.replace(/^#/, "") ?? null, status, isRoot, stands: str(m.stands), standsAt: str(m.stands_at) });
  }
  return { nodes: [...out.values()], rootPath };
}

export type TaskTree = {
  /** path → node; archived/done nodes are left out. */
  byPath: Map<string, TaskNode>;
  /** id → path, so a task that stores a node id still finds its node. */
  idPath: Map<string, string>;
  /** parent path (ROOT: top level) → child paths. A missing parent, self parent or a cycle means "top level" for that link. */
  children: Map<string, string[]>;
  parent: Map<string, string>;
  /** The Uni root's path and id: a reference to either means ROOT. */
  rootRefs: ReadonlySet<string>;
  /** `metadata.stands` by node path (ROOT: Uni), with `stands_at` when it was written. */
  stands: ReadonlyMap<string, { text: string; at: string | null }>;
};

export function buildTaskTree(nodes: readonly TaskNode[], rootPath: string | null = null): TaskTree {
  const byPath = new Map<string, TaskNode>();
  const idPath = new Map<string, string>();
  const rootRefs = new Set<string>(rootPath ? [rootPath] : []);
  const stands = new Map<string, { text: string; at: string | null }>();
  for (const n of nodes) {
    if (n.stands) stands.set(n.isRoot || n.path === rootPath ? ROOT : n.path, { text: n.stands, at: n.standsAt ?? null });
    if (n.isRoot || n.path === rootPath) { rootRefs.add(n.id); rootRefs.add(n.path); continue; }
    idPath.set(n.id, n.path);
    if (n.status !== "archived" && n.status !== "done") byPath.set(n.path, n);
  }
  const parent = new Map<string, string>();
  // A parent may be written as a path, a `[[link]]` or an id; only a live node counts, anything else is the top level.
  const resolve = pathResolver(nodes.filter((n) => !rootRefs.has(n.id)));
  const up = (n: TaskNode) => { const p = resolve(n.parent); return p && p !== n.path && byPath.has(p) ? p : ROOT; };
  for (const n of byPath.values()) parent.set(n.path, up(n));
  for (const start of [...byPath.keys()].sort()) {
    const seen: string[] = [];
    let at = start;
    while (at !== ROOT && !seen.includes(at)) { seen.push(at); at = parent.get(at) ?? ROOT; }
    if (at !== ROOT) parent.set([...seen.slice(seen.indexOf(at))].sort()[0], ROOT);
  }
  const children = new Map<string, string[]>();
  for (const [p, up_] of [...parent].sort((a, b) => a[0].localeCompare(b[0]))) children.set(up_, [...(children.get(up_) ?? []), p]);
  return { byPath, idPath, children, parent, rootRefs, stands };
}

/** The node and everything beneath it (paths). ROOT is every node. */
export function subtreePaths(tree: TaskTree, path: string): string[] {
  if (path !== ROOT && !tree.byPath.has(path)) return [];
  const out: string[] = path === ROOT ? [] : [path];
  const seen = new Set(out);
  const stack = [...(tree.children.get(path) ?? [])];
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p)) continue;
    seen.add(p); out.push(p);
    stack.push(...(tree.children.get(p) ?? []));
  }
  return out;
}

/** What goes in `node: {in: [...]}`: the paths, plus the ids (a reference may be stored either way). */
export function nodeFilterKeys(tree: TaskTree, paths: readonly string[]): string[] {
  const ids = new Map<string, string>(); for (const [id, p] of tree.idPath) ids.set(p, id);
  return [...new Set(paths.flatMap((p) => [p, ...(ids.get(p) ? [ids.get(p)!] : [])]))];
}

/** A decision's `options[]`: strings, or objects with a `label`, `title` or `name`. Anything else is skipped. */
export function optionsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = v.map((o) => str(o) ?? (o && typeof o === "object" ? str((o as Record<string, unknown>).label) ?? str((o as Record<string, unknown>).title) ?? str((o as Record<string, unknown>).name) : null)).filter((x): x is string => !!x);
  return [...new Set(out)].slice(0, 4);
}

export function parseTask(n: RawNote, tree: TaskTree): Task | null {
  const id = str(n.id), path = str(n.path) && stripExt(str(n.path)!);
  if (!id || !path) return null;
  const m = (n.metadata && typeof n.metadata === "object" ? n.metadata : {}) as Record<string, unknown>;
  const kind = Array.isArray(n.tags) && n.tags.includes("decision") ? "decision" : "task";
  const state = str(m.state);
  const valid = kind === "decision" ? ["open", "decided"] : ["open", "doing", "waiting", "done", "archived"];
  if (!state || !valid.includes(state)) return null;
  const ref = refKey(m.node);
  const node = !ref || tree.rootRefs.has(ref) ? ROOT : tree.byPath.has(ref) ? ref : tree.idPath.get(ref) ?? ref;
  return {
    id, path, kind, title: leaf(path).replace(/\u2044/g, "/"), node, state: state as AnyState, owner: str(m.owner) ?? "", waitingOn: str(m.waiting_on),
    due: str(m.due)?.slice(0, 10) ?? null, next: str(m.next) ?? "", room: str(m.room)?.replace(/^#/, "") ?? null,
    snoozedUntil: str(m.snoozed_until)?.slice(0, 10) ?? null,
    priority: PRIORITIES.find((p) => p === str(m.priority)?.toLowerCase()) ?? null,
    priorityBy: str(m.priority_by),
    updatedAt: str(n.updatedAt), lastUpdatedBy: str(n.lastUpdatedBy), lastUpdatedVia: str(n.lastUpdatedVia),
    options: kind === "decision" ? optionsOf(m.options) : [],
  };
}

export const isLive = (t: Pick<Task, "state">) => t.state === "open" || t.state === "doing" || t.state === "waiting";
/** `YYYY-MM-DD` in the user's day. */
export const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const tomorrowOf = (now: Date) => dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
export const snoozed = (t: Pick<Task, "snoozedUntil">, now: Date) => !!t.snoozedUntil && t.snoozedUntil > dayOf(now);

/** Whether an `owner` / `waiting_on` field names the user: `aaron`, `Aaron`, `@aaron` or `person:aaron`. A field value only, never free text. */
export const isMe = (v: string | null | undefined, p: VaultProfile = activeProfile()): boolean => !!v && v.trim().toLowerCase().replace(/^(person:|@)/, "") === p.me.toLowerCase();

export type Group = "you" | "rooms" | "others";
/** Aaron's own work and everything waiting on him; Uni and room work; other people. */
export function groupOf(t: Pick<Task, "owner" | "waitingOn" | "kind">, p: VaultProfile = activeProfile()): Group {
  if (t.kind === "decision" || isMe(t.owner, p) || isMe(t.waitingOn, p)) return "you";
  if (isAgentOwner(t.owner, p)) return "rooms";
  return "others";
}
export const GROUP_LABEL: Record<Group, string> = { you: "You", rooms: "Rooms", others: "Others" };

const rank = (t: Task) => (isMe(t.waitingOn) || t.kind === "decision" ? 0 : t.state === "doing" ? 1 : 2);
/** Waiting-on-you first, then in progress, then by due date (undated last), then title. */
export function sortTasks(list: readonly Task[]): Task[] {
  return [...list].sort((a, b) => rank(a) - rank(b) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.title.localeCompare(b.title));
}

export function groupTasks(list: readonly Task[]): { group: Group; label: string; tasks: Task[] }[] {
  return (["you", "rooms", "others"] as const).map((group) => ({ group, label: GROUP_LABEL[group], tasks: sortTasks(list.filter((t) => groupOf(t) === group)) })).filter((g) => g.tasks.length);
}

export type Counts = { you: number; rooms: number; others: number; total: number };
const none = (): Counts => ({ you: 0, rooms: 0, others: 0, total: 0 });

/** Live tasks per node path, rolled up: a node's count includes every task on it and beneath it. */
export function rollUp(tree: TaskTree, list: readonly Task[]): Map<string, Counts> {
  const own = new Map<string, Counts>();
  for (const t of list) { const c = own.get(t.node) ?? none(); c[groupOf(t)]++; c.total++; own.set(t.node, c); }
  const out = new Map<string, Counts>();
  const visit = (p: string, seen: Set<string>): Counts => {
    const done = out.get(p); if (done) return done;
    const c = { ...(own.get(p) ?? none()) };
    if (!seen.has(p)) {
      seen.add(p);
      for (const k of tree.children.get(p) ?? []) { const s = visit(k, seen); c.you += s.you; c.rooms += s.rooms; c.others += s.others; c.total += s.total; }
    }
    out.set(p, c);
    return c;
  };
  for (const p of [ROOT, ...tree.byPath.keys()]) visit(p, new Set());
  // tasks filed on the Uni root itself or on an unknown node count for Uni
  for (const t of list) if (t.node !== ROOT && !tree.byPath.has(t.node)) { const c = out.get(ROOT)!; c[groupOf(t)]++; c.total++; }
  return out;
}

/** The tasks of one node's subtree (ROOT: all). */
export function tasksUnder(tree: TaskTree, path: string, list: readonly Task[]): Task[] {
  if (path === ROOT) return [...list];
  const set = new Set(subtreePaths(tree, path));
  return list.filter((t) => set.has(t.node));
}

export type FailureKind = "conflict" | "invalid" | "error";
/** How a failed write reads: 409 `transition_conflict`, 422 `schema_validation`, anything else. */
export function failureKind(message: string): FailureKind {
  if (/transition_conflict|\b409\b|conflict:/i.test(message)) return "conflict";
  if (/schema_validation|\b422\b|invalid value|not one of/i.test(message)) return "invalid";
  return "error";
}
