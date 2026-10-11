// The Parachute API for tasks (the node view's data layer). Every read is an indexed `query-notes`, every write one
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

  /**
   * Live tasks and open decisions under `path` (ROOT: everywhere). Two indexed queries, `node in [subtree paths and ids]`,
   * `state in [open, doing, waiting]`; `truncated` says the vault returned a full page (more may exist).
   */
  async function loadTasks(tree: TaskTree, path: string): Promise<{ tasks: Task[]; truncated: boolean }> {
    const where = path === ROOT ? {} : { node: { in: nodeFilterKeys(tree, subtreePaths(tree, path)) } };
    if (path !== ROOT && !subtreePaths(tree, path).length) return { tasks: [], truncated: false };
    const [tasks, decisions] = await Promise.all([
      call("vault_query_meta", { vault, tag: "task", metadata: { ...where, state: { in: [...LIVE_STATES] } }, limit: LIMIT }) as Promise<RawNote[]>,
      call("vault_query_meta", { vault, tag: "decision", metadata: { ...where, state: { in: ["open"] } }, limit: LIMIT }) as Promise<RawNote[]>,
    ]);
    const parsed = [...tasks, ...decisions].map((n) => parseTask(n, tree)).filter((t): t is Task => !!t);
    return { tasks: [...new Map(parsed.map((t) => [t.id, t])).values()], truncated: tasks.length >= LIMIT || decisions.length >= LIMIT };
  }

  /** Compare-and-set on `state`. A stale `from` is a conflict (409): the caller re-reads and says so, it never retries blind. */
  async function transition(taskId: string, from: AnyState, to: AnyState): Promise<WriteResult> {
    try {
      const note = ((await call("vault_transition", { vault, id: taskId, field: "state", from, to })) as RawNote);
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

  return { loadTree, loadTasks, transition, snooze };
}

export const vaultTasks = createVaultTasks();
