// The Parachute API for tasks (the node view's data layer). Every read is an indexed `query-notes` (one `near` request per kind), every write one
// vault call: `state_transition` for state (an atomic compare-and-set), a guarded metadata merge for snooze.
// Nothing is cached here beyond one session's memory; the node view reconciles with each server answer.
import { invoke } from "@tauri-apps/api/core";
import { buildTaskTree, failureKind, groupOf, LIVE_STATES, nodeFilterKeys, parseNodes, parseTask, subtreePaths, type AnyState, type FailureKind, type Priority, type RawNote, type Task, type TaskTree } from "./taskCore.ts";
import { ROOT } from "./treeCore.ts";
import { splitTitle } from "./whereCore.ts";
import { askFromContent, askOrder, isCutTitle } from "./simpleCore.ts";
import { activeProfile } from "./profile.ts";

export type Call = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
const LIMIT = 200;
/** A list longer than this many pages (2000 notes) is read no further and said to be incomplete. */
const MAX_PAGES = 10;

/**
 * Read a list page by page (200 at a time) until a short page. `complete` only when that last page came back short: a list that stops at
 * MAX_PAGES, or a vault that ignores `offset` (a page with nothing new), is incomplete, never taken for the whole.
 */
export async function allPages(page: (offset: number) => Promise<RawNote[]>): Promise<{ rows: RawNote[]; complete: boolean }> {
  const rows: RawNote[] = []; const seen = new Set<string>();
  for (let i = 0; i < MAX_PAGES; i++) {
    const got = await page(i * LIMIT);
    let fresh = 0;
    for (const r of Array.isArray(got) ? got : []) {
      const id = typeof r.id === "string" ? r.id : null;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      rows.push(r); fresh++;
    }
    if (!Array.isArray(got) || got.length < LIMIT) return { rows, complete: true };
    if (!fresh) return { rows, complete: false };
  }
  return { rows, complete: false };
}
const ASK_READS = 40;
const ASK_PARALLEL = 6;
const ASK_KEEP = 150;

const WRITER_KEY = "uni.tasks.writer.v1";
/** Who this app writes as in the vault (the `lastUpdatedBy` its own writes come back with), so a task changed from here can say "you". */
export const ownWriter = (): string | null => { try { return localStorage.getItem(WRITER_KEY); } catch { return null; } };
/** Who changed a task last, in words: "you" for this app's own writes, "Uni" for a write through the vault's MCP door; null when the app can't tell (never an id). */
export function changedBy(t: Pick<Task, "lastUpdatedBy" | "lastUpdatedVia">, me: string | null = ownWriter()): string | null {
  if (me && t.lastUpdatedBy === me) return "you";
  return t.lastUpdatedVia === "mcp" ? "Uni" : null;
}
const ok = (note: unknown): WriteResult => {
  const st = stamp(note);
  if (st.lastUpdatedBy) try { localStorage.setItem(WRITER_KEY, st.lastUpdatedBy); } catch { /* this session only */ }
  return { ok: true, ...st };
};

export type WriteResult = { ok: true; updatedAt: string | null; lastUpdatedBy: string | null; lastUpdatedVia: string | null } | { ok: false; kind: FailureKind; message: string };

const stamp = (note: unknown) => {
  const n = (note ?? {}) as RawNote;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return { updatedAt: s(n.updatedAt), lastUpdatedBy: s(n.lastUpdatedBy), lastUpdatedVia: s(n.lastUpdatedVia) };
};

/** `vault` is a name, or a function read on every call (the singleton follows the selected vault's profile). */
export function createVaultTasks(call: Call = (cmd, args) => invoke(cmd, args), vaultOf: string | (() => string) = () => activeProfile().vault) {
  const name = () => (typeof vaultOf === "function" ? vaultOf() : vaultOf);
  /** The whole tree, metadata only: every `node` note (areas, projects, the Uni root). */
  async function loadTree(): Promise<TaskTree & { truncated: boolean }> {
    const { rows, complete } = await allPages((offset) => call("vault_query", { vault: name(), tag: "node", includeContent: false, limit: LIMIT, ...(offset ? { offset } : {}) }) as Promise<RawNote[]>);
    const { nodes, rootPath } = parseNodes(rows);
    return { ...buildTaskTree(nodes, rootPath), truncated: !complete };
  }

  /** Every note with `tag`, metadata only (the dispatch ledger `run`, the `draft` notes). A vault with none, or one that refuses, reads as empty: these are extras on the page. */
  async function loadTagged(tag: string): Promise<RawNote[] | null> {
    // null = the read failed: the caller keeps what it had rather than wiping Running/Drafts on a transient error
    try { return (await allPages((offset) => call("vault_query", { vault: name(), tag, includeContent: false, limit: LIMIT, ...(offset ? { offset } : {}) }) as Promise<RawNote[]>)).rows; } catch { return null; }
  }

  /** Full questions already read, by note id, with the note's `updatedAt` they were read at: a refresh shows them at once, and so does the next launch (kept on the device, per identity, newest 150). */
  const askCache = new Map<string, { ask: string; at: string | null }>();
  let askOwner = "";
  const askKey = () => `uni.asks.v1:${askOwner}`;
  const keepAsks = () => { try { localStorage.setItem(askKey(), JSON.stringify([...askCache].slice(-ASK_KEEP))); } catch { /* this session only */ } };
  /** Whose asks the cache holds: another identity or vault starts clean, the same one picks up what the device kept. */
  function setAskOwner(owner: string) {
    if (owner === askOwner) return;
    askOwner = owner; askCache.clear();
    try {
      const v = JSON.parse(localStorage.getItem(askKey()) ?? "[]");
      if (Array.isArray(v)) for (const e of v) if (Array.isArray(e) && typeof e[0] === "string" && e[1] && typeof e[1].ask === "string") askCache.set(e[0], { ask: e[1].ask, at: typeof e[1].at === "string" ? e[1].at : null });
    } catch { /* nothing kept */ }
  }
  const askFor = (t: Task) => { const c = askCache.get(t.id); return c && c.at === t.updatedAt ? c.ask : undefined; };
  /**
   * The lists carry no content, so a decision or one of the user's tasks whose title was cut short ("…") gets its full question from the first
   * line of its note (one read each, only for those; decisions, Now and the soonest due first, at most 40, six at a time). Called after the
   * list is already on screen; resolves to the new asks.
   */
  async function loadAsks(tasks: readonly Task[]): Promise<Map<string, string>> {
    const cut = askOrder(tasks.filter((t) => askFor(t) === undefined && (t.kind === "decision" || groupOf(t) === "you") && isCutTitle(splitTitle(t.title).rest))).slice(0, ASK_READS);
    const asks = new Map<string, string>();
    for (let i = 0; i < cut.length; i += ASK_PARALLEL) {
      await Promise.all(cut.slice(i, i + ASK_PARALLEL).map(async (t) => {
        try {
          const r = (await call("vault_note", { vault: name(), noteRef: t.id })) as { note?: RawNote } | null;
          const ask = askFromContent(typeof r?.note?.content === "string" ? r.note.content : "");
          if (ask) { asks.set(t.id, ask); askCache.delete(t.id); askCache.set(t.id, { ask, at: t.updatedAt }); }
        } catch { /* the row opens to decide instead */ }
      }));
    }
    if (asks.size) keepAsks();
    return asks;
  }

  // Feature detect once per session: does the vault answer `near` with `direction` and `then`? null = not yet known.
  let nearOk: boolean | null = null;
  const unsupported = (e: unknown) => /unknown|unrecogni[sz]ed|unsupported|not supported|invalid[_ ]?(param|near|query)|bad[_ ]request|\b400\b|"?then"?/i.test(String(e)) && !/not[_ ]found/i.test(String(e));
  const missing = (e: unknown) => /not[_ ]found/i.test(String(e));

  /** The node at `path` and every node beneath it, one request (`near` inbound over `parent`). Paths in `paths`, ids in `ids`. */
  async function loadSubtree(path: string): Promise<{ paths: string[]; ids: string[] }> {
    const rows = (await call("vault_subtree_nodes", { vault: name(), root: path })) as RawNote[];
    const { nodes } = parseNodes(rows);
    const self = nodes.some((n) => n.path === path) ? [] : [path]; // the walk should include its anchor; make sure
    return { paths: [...nodes.map((n) => n.path), ...self], ids: nodes.map((n) => n.id) };
  }

  /**
   * Live tasks and open decisions under `path` (ROOT: everywhere). With the vault's subtree queries, one `near` request per
   * kind (anchored at the node's id, else its path; `parent` inbound, then `node` inbound, `state in [open, doing, waiting]`). A vault that answers with an unknown-parameter
   * error gets the older walk instead: `node in [subtree paths and ids]`, decided once per session. `truncated` says the
   * vault returned a full page (more may exist).
   */
  async function loadTasks(tree: TaskTree, path: string): Promise<{ tasks: Task[]; truncated: boolean }> {
    const finish = (tasks: RawNote[], decisions: RawNote[], cut = tasks.length >= LIMIT || decisions.length >= LIMIT) => {
      const parsed = [...tasks, ...decisions].map((n) => parseTask(n, tree)).filter((t): t is Task => !!t);
      return { tasks: [...new Map(parsed.map((t) => [t.id, askFor(t) !== undefined ? { ...t, ask: askFor(t)! } : t])).values()], truncated: cut };
    };
    if (path !== ROOT && nearOk !== false) {
      // The anchor is the node's id when the tree knows it (the vault stores references as ids); the path is still accepted.
      const root = tree.byPath.get(path)?.id ?? path;
      try {
        const [tasks, decisions] = await Promise.all([
          call("vault_subtree_tasks", { vault: name(), tag: "task", root, states: [...LIVE_STATES], limit: LIMIT }) as Promise<RawNote[]>,
          call("vault_subtree_tasks", { vault: name(), tag: "decision", root, states: ["open"], limit: LIMIT }) as Promise<RawNote[]>,
        ]);
        nearOk = true;
        return finish(tasks, decisions);
      } catch (e) {
        if (unsupported(e) && nearOk === null) nearOk = false;
        else if (!missing(e)) throw e; // a network or vault failure is the caller's to show; only "can't do this" falls back
      }
    }
    let keys: string[] | null = null;
    if (path !== ROOT) {
      const known = subtreePaths(tree, path);
      if (known.length) keys = nodeFilterKeys(tree, known);
      else if (nearOk !== false) { try { const s = await loadSubtree(path); keys = [...s.paths, ...s.ids]; } catch { /* no such subtree */ } }
      if (!keys?.length) return { tasks: [], truncated: false };
    }
    const where = keys ? { node: { in: keys } } : {};
    // past the first 200: every page is read before the list is taken for the whole
    const [tasks, decisions] = await Promise.all([
      allPages((offset) => call("vault_query_meta", { vault: name(), tag: "task", metadata: { ...where, state: { in: [...LIVE_STATES] } }, limit: LIMIT, ...(offset ? { offset } : {}) }) as Promise<RawNote[]>),
      allPages((offset) => call("vault_query_meta", { vault: name(), tag: "decision", metadata: { ...where, state: { in: ["open"] } }, limit: LIMIT, ...(offset ? { offset } : {}) }) as Promise<RawNote[]>),
    ]);
    return finish(tasks.rows, decisions.rows, !tasks.complete || !decisions.complete);
  }

  /** Compare-and-set on `state`. A stale `from` is a conflict (409): the caller re-reads and says so, it never retries blind. */
  async function transition(taskId: string, from: AnyState, to: AnyState): Promise<WriteResult> {
    try {
      const note = ((await call("vault_transition", { vault: name(), id: taskId, from, to })) as RawNote);
      return ok(note);
    } catch (e) {
      const message = String(e);
      return { ok: false, kind: failureKind(message), message };
    }
  }

  /**
   * Decide an open decision: one update that sets `state` open -> decided (compare-and-set) and writes `decided`, `decided_at`,
   * `decided_by`. A decision someone else already decided is a conflict: the caller says so and re-reads, it never retries.
   */
  async function decide(taskId: string, option: string, by: string, at: string = new Date().toISOString()): Promise<WriteResult> {
    try {
      const note = await call("vault_decide", { vault: name(), id: taskId, from: "open", to: "decided", metadata: { decided: option, decided_at: at, decided_by: by } });
      return ok(note);
    } catch (e) {
      const message = String(e);
      return { ok: false, kind: failureKind(message), message };
    }
  }

  /** A metadata merge guarded by the `updated_at` the caller read (a stale stamp is a conflict); a `null` value clears its key. */
  async function patchMeta(taskId: string, metadata: Record<string, unknown>, updatedAt: string): Promise<WriteResult> {
    try {
      const note = await call("vault_patch_meta", { vault: name(), id: taskId, metadata, ifUpdatedAt: updatedAt });
      return ok(note);
    } catch (e) {
      const message = String(e);
      return { ok: false, kind: failureKind(message), message };
    }
  }

  /** Snooze: `snoozed_until` (a date); `null` clears it. */
  const snooze = (taskId: string, until: string | null, updatedAt: string) => patchMeta(taskId, { snoozed_until: until }, updatedAt);
  /** Priority: now, soon or someday; `null` clears it (back to unsorted). */
  /** A priority picked in the app is a person's call: stamp `priority_by: "hand"` so weigh.py never overwrites it.
   *  Undo passes the previous stamp back (null clears it). */
  const setPriority = (taskId: string, priority: Priority | null, updatedAt: string, by: string | null = "hand") =>
    patchMeta(taskId, { priority, priority_by: priority === null ? null : by }, updatedAt);

  return { setAskOwner, loadTree, loadTagged, loadAsks, loadSubtree, loadTasks, transition, decide, snooze, setPriority, nearSupported: () => nearOk };
}

export const vaultTasks = createVaultTasks();
