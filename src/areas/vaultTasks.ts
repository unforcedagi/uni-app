// The Parachute API for tasks (the node view's data layer). Every read is an indexed `query-notes` (one `near` request per kind), every write one
// vault call: `state_transition` for state (an atomic compare-and-set), a guarded metadata merge for snooze.
// Nothing is cached here beyond one session's memory; the node view reconciles with each server answer.
import { invoke } from "@tauri-apps/api/core";
import { buildTaskTree, failureKind, LIVE_STATES, nodeFilterKeys, parseNodes, parseTask, subtreePaths, type AnyState, type FailureKind, type RawNote, type Task, type TaskTree } from "./taskCore.ts";
import { ROOT } from "./treeCore.ts";

export type Call = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
const VAULT = "uni";
const LIMIT = 200;

export type WriteResult = { ok: true; updatedAt: string | null; lastUpdatedBy: string | null; lastUpdatedVia: string | null } | { ok: false; kind: FailureKind; message: string };

const stamp = (note: unknown) => {
  const n = (note ?? {}) as RawNote;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return { updatedAt: s(n.updatedAt), lastUpdatedBy: s(n.lastUpdatedBy), lastUpdatedVia: s(n.lastUpdatedVia) };
};

export function createVaultTasks(call: Call = (cmd, args) => invoke(cmd, args), vault = VAULT) {
  /** The whole tree, metadata only: every `node` note (areas, projects, the Uni root). */
  async function loadTree(): Promise<TaskTree & { truncated: boolean }> {
    const rows = (await call("vault_query", { vault, tag: "node", includeContent: false, limit: LIMIT })) as RawNote[];
    const { nodes, rootPath } = parseNodes(rows);
    return { ...buildTaskTree(nodes, rootPath), truncated: rows.length >= LIMIT };
  }

  // Feature detect once per session: does the vault answer `near` with `direction` and `then`? null = not yet known.
  let nearOk: boolean | null = null;
  const unsupported = (e: unknown) => /unknown|unrecogni[sz]ed|unsupported|not supported|invalid[_ ]?(param|near|query)|bad[_ ]request|\b400\b|"?then"?/i.test(String(e)) && !/not[_ ]found/i.test(String(e));
  const missing = (e: unknown) => /not[_ ]found/i.test(String(e));

  /** The node at `path` and every node beneath it, one request (`near` inbound over `parent`). Paths in `paths`, ids in `ids`. */
  async function loadSubtree(path: string): Promise<{ paths: string[]; ids: string[] }> {
    const rows = (await call("vault_subtree_nodes", { vault, root: path })) as RawNote[];
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
    const finish = (tasks: RawNote[], decisions: RawNote[]) => {
      const parsed = [...tasks, ...decisions].map((n) => parseTask(n, tree)).filter((t): t is Task => !!t);
      return { tasks: [...new Map(parsed.map((t) => [t.id, t])).values()], truncated: tasks.length >= LIMIT || decisions.length >= LIMIT };
    };
    if (path !== ROOT && nearOk !== false) {
      // The anchor is the node's id when the tree knows it (the vault stores references as ids); the path is still accepted.
      const root = tree.byPath.get(path)?.id ?? path;
      try {
        const [tasks, decisions] = await Promise.all([
          call("vault_subtree_tasks", { vault, tag: "task", root, states: [...LIVE_STATES], limit: LIMIT }) as Promise<RawNote[]>,
          call("vault_subtree_tasks", { vault, tag: "decision", root, states: ["open"], limit: LIMIT }) as Promise<RawNote[]>,
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
    const [tasks, decisions] = await Promise.all([
      call("vault_query_meta", { vault, tag: "task", metadata: { ...where, state: { in: [...LIVE_STATES] } }, limit: LIMIT }) as Promise<RawNote[]>,
      call("vault_query_meta", { vault, tag: "decision", metadata: { ...where, state: { in: ["open"] } }, limit: LIMIT }) as Promise<RawNote[]>,
    ]);
    return finish(tasks, decisions);
  }

  /** Compare-and-set on `state`. A stale `from` is a conflict (409): the caller re-reads and says so, it never retries blind. */
  async function transition(taskId: string, from: AnyState, to: AnyState): Promise<WriteResult> {
    try {
      const note = ((await call("vault_transition", { vault, id: taskId, from, to })) as RawNote);
      return { ok: true, ...stamp(note) };
    } catch (e) {
      const message = String(e);
      return { ok: false, kind: failureKind(message), message };
    }
  }

  /** Snooze: `snoozed_until` (a date) via a metadata merge guarded by the `updated_at` the caller read; `null` clears it. */
  async function snooze(taskId: string, until: string | null, updatedAt: string): Promise<WriteResult> {
    try {
      const note = await call("vault_patch_meta", { vault, id: taskId, metadata: { snoozed_until: until }, ifUpdatedAt: updatedAt });
      return { ok: true, ...stamp(note) };
    } catch (e) {
      const message = String(e);
      return { ok: false, kind: failureKind(message), message };
    }
  }

  return { loadTree, loadSubtree, loadTasks, transition, snooze, nearSupported: () => nearOk };
}

export const vaultTasks = createVaultTasks();
