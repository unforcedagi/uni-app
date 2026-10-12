import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildTaskTree, dayOf, isLive, rollUp, snoozed, tasksUnder, tomorrowOf, type AnyState, type Counts, type Priority, type Task, type TaskNode, type TaskTree } from "./taskCore";
import { vaultTasks } from "./vaultTasks";
import { shouldReload } from "./pathCache";
import { useVaultProfile } from "./ProfileContext";

export type TaskAction = "done" | "archive" | "snooze";
export type Undo = { id: string; label: string; run: () => Promise<void> };
export const UNDO_MS = 5000;
/** One finite exit animation; none when the user prefers reduced motion. */
export const LEAVE_MS = 240;
const reduced = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// Memory for this session only, scoped to the signed-in identity and cleared on Forget: tasks are Aaron's private work.
type Memory = { owner: string; tree: (TaskTree & { truncated: boolean }) | null; tasks: Map<string, { list: Task[]; truncated: boolean }>; at: number | null };
let memory: Memory = { owner: "", tree: null, tasks: new Map(), at: null };
export function forgetTasks() { memory = { owner: "", tree: null, tasks: new Map(), at: null }; }
const scoped = (owner: string) => { if (memory.owner !== owner) memory = { owner, tree: null, tasks: new Map(), at: null }; return memory; };

const verb: Record<TaskAction, string> = { done: "mark it done", archive: "archive it", snooze: "snooze it" };
const said: Record<TaskAction, string> = { done: "Marked done", archive: "Archived", snooze: "Snoozed until tomorrow" };

/**
 * The open tasks under one node, straight from the vault. Optimistic: a check-off disappears at once and the vault's answer
 * reconciles it. A failed write rolls back with a message; a conflict (the task changed elsewhere) re-reads instead of retrying.
 */
export function useTasks(identity: string | null, nodePath: string, fallback: readonly TaskNode[]) {
  const vault = useVaultProfile().vault;
  const owner = `${identity ?? ""}|${vault}`;
  const [tree, setTree] = useState<TaskTree | null>(() => scoped(owner).tree);
  const [list, setList] = useState<Task[] | null>(() => scoped(owner).tasks.get(nodePath)?.list ?? null);
  const [truncated, setTruncated] = useState(false);
  const [treeTruncated, setTreeTruncated] = useState(() => !!scoped(owner).tree?.truncated);
  // The local date, re-read when the window is shown or focused again: a snooze ends at midnight even if the app stayed open.
  const [day, setDay] = useState(() => dayOf(new Date()));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [n, setN] = useState(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoad = useRef<number | null>(null);
  const epoch = useRef(0);
  const refresh = useCallback(() => setN((x) => x + 1), []);

  useEffect(() => {
    if (!identity) return;
    const mem = scoped(owner);
    const mine = ++epoch.current;
    let live = true;
    setList(mem.tasks.get(nodePath)?.list ?? null);
    setLoading(true);
    lastLoad.current = Date.now();
    (async () => {
      let t = mem.tree;
      if (!t) {
        // `node` notes are the tree; if the vault has none yet, the app's own tree (areas and projects) stands in.
        try { const loaded = await vaultTasks.loadTree(); t = loaded.byPath.size || !fallback.length ? loaded : { ...buildTaskTree(fallback), truncated: false }; }
        catch { t = { ...buildTaskTree(fallback), truncated: false }; }
        mem.tree = t;
      }
      if (live && mine === epoch.current) { setTree(t); setTreeTruncated(!!t.truncated); }
      const r = await vaultTasks.loadTasks(t, nodePath);
      if (!live || mine !== epoch.current || memory !== mem) return;
      mem.tasks.set(nodePath, { list: r.tasks, truncated: r.truncated });
      setList(r.tasks); setTruncated(r.truncated); setError(null);
      // anything the server no longer lists is settled: stop hiding it by hand
      setGone((g) => new Set([...g].filter((id) => r.tasks.some((x) => x.id === id && isLive(x)))));
    })().catch((e) => { if (live && mine === epoch.current) setError(String(e)); }).finally(() => { if (live && mine === epoch.current) setLoading(false); });
    return () => { live = false; };
  }, [identity, vault, nodePath, n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      setDay(dayOf(new Date()));
      if (shouldReload(lastLoad.current, Date.now())) refresh();
    };
    const focus = () => setDay(dayOf(new Date()));
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", focus);
    return () => { document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", focus); };
  }, [refresh]);
  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); if (undoTimer.current) clearTimeout(undoTimer.current); }, []);

  const now = new Date();
  const visible = useMemo(() => (list ?? []).filter((t) => isLive(t) && !gone.has(t.id) && !snoozed(t, new Date())), [list, gone, n, day]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts: Map<string, Counts> = useMemo(() => (tree ? rollUp(tree, tasksUnder(tree, nodePath, visible)) : new Map()), [tree, nodePath, visible]);

  const patch = (id: string, f: (t: Task) => Task) => {
    setList((l) => (l ? l.map((t) => (t.id === id ? f(t) : t)) : l));
    const mem = memory.tasks.get(nodePath);
    if (mem) memory.tasks.set(nodePath, { ...mem, list: mem.list.map((t) => (t.id === id ? f(t) : t)) });
  };
  const hide = (id: string) => {
    const wait = reduced() ? 0 : LEAVE_MS;
    setLeaving((s) => new Set(s).add(id));
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id);
      setLeaving((s) => { const c = new Set(s); c.delete(id); return c; });
      setGone((s) => new Set(s).add(id));
    }, wait));
  };
  const restore = (id: string) => {
    clearTimeout(timers.current.get(id)); timers.current.delete(id);
    setLeaving((s) => { const c = new Set(s); c.delete(id); return c; });
    setGone((s) => { const c = new Set(s); c.delete(id); return c; });
  };
  const offerUndo = (u: Undo) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(u);
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
  };
  const fail = (task: Task, action: TaskAction, r: { kind: "conflict" | "invalid" | "error"; message: string }) => {
    restore(task.id);
    setNotice(r.kind === "conflict" ? `“${task.title}” changed elsewhere, so it wasn't ${action === "archive" ? "archived" : action === "done" ? "marked done" : "snoozed"}. Showing the latest.`
      : r.kind === "invalid" ? `Couldn't ${verb[action]}: the vault refused that value.`
      : `Couldn't ${verb[action]}: ${r.message.replace(/^Error:\s*/, "").slice(0, 120)}`);
    if (r.kind === "conflict") refresh();
  };

  const act = useCallback(async (task: Task, action: TaskAction) => {
    setNotice(null);
    if (action === "snooze") {
      if (!task.updatedAt) { setNotice("Couldn't snooze: reload the task first."); return; }
      const until = tomorrowOf(new Date());
      hide(task.id);
      const r = await vaultTasks.snooze(task.id, until, task.updatedAt);
      if (!r.ok) { fail(task, action, r); return; }
      patch(task.id, (t) => ({ ...t, snoozedUntil: until, updatedAt: r.updatedAt ?? t.updatedAt, lastUpdatedBy: r.lastUpdatedBy ?? t.lastUpdatedBy, lastUpdatedVia: r.lastUpdatedVia ?? t.lastUpdatedVia }));
      let stamp = r.updatedAt;
      offerUndo({ id: task.id, label: said.snooze, run: async () => {
        const back = stamp ? await vaultTasks.snooze(task.id, null, stamp) : null;
        if (back?.ok) { restore(task.id); patch(task.id, (t) => ({ ...t, snoozedUntil: null, updatedAt: back.updatedAt ?? t.updatedAt })); setUndo(null); setNotice(null); }
        else { setNotice("Couldn't undo: it changed elsewhere. Showing the latest."); setUndo(null); refresh(); }
        stamp = null;
      } });
      return;
    }
    const from = task.state;
    const to: AnyState = action === "archive" ? "archived" : task.kind === "decision" ? "decided" : "done";
    hide(task.id);
    const r = await vaultTasks.transition(task.id, from, to);
    if (!r.ok) { fail(task, action, r); return; }
    offerUndo({ id: task.id, label: said[action], run: async () => {
      // Undo is the reverse compare-and-set; if someone else moved it meanwhile it fails like any other conflict.
      const back = await vaultTasks.transition(task.id, to, from);
      if (back.ok) { restore(task.id); setUndo(null); setNotice(null); refresh(); }
      else { setNotice(back.kind === "conflict" ? "Couldn't undo: it changed elsewhere. Showing the latest." : `Couldn't undo: ${back.message.slice(0, 120)}`); setUndo(null); refresh(); }
    } });
  }, [nodePath]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Set a task's priority: one guarded metadata merge (`vault_patch_meta` with the `updated_at` the row was read at), optimistic,
   * with five seconds to take it back (the reverse merge, guarded by the stamp the first write returned). A conflict re-reads.
   */
  const setPriority = useCallback(async (task: Task, to: Priority) => {
    setNotice(null);
    const prev = task.priority, prevBy = task.priorityBy;
    if (prev === to && prevBy === "hand") return;
    if (!task.updatedAt) { setNotice("Couldn't change priority: reload the task first."); return; }
    patch(task.id, (t) => ({ ...t, priority: to, priorityBy: "hand" }));
    const r = await vaultTasks.setPriority(task.id, to, task.updatedAt);
    if (!r.ok) {
      patch(task.id, (t) => ({ ...t, priority: prev, priorityBy: prevBy }));
      setNotice(r.kind === "conflict" ? `“${task.title}” changed elsewhere, so its priority wasn't changed. Showing the latest.` : r.kind === "invalid" ? "Couldn't change priority: the vault refused that value." : `Couldn't change priority: ${r.message.replace(/^Error:\s*/, "").slice(0, 120)}`);
      if (r.kind === "conflict") refresh();
      return;
    }
    patch(task.id, (t) => ({ ...t, priority: to, priorityBy: "hand", updatedAt: r.updatedAt ?? t.updatedAt, lastUpdatedBy: r.lastUpdatedBy ?? t.lastUpdatedBy, lastUpdatedVia: r.lastUpdatedVia ?? t.lastUpdatedVia }));
    let stamp = r.updatedAt;
    offerUndo({ id: task.id, label: `Priority: ${to}`, run: async () => {
      const back = stamp ? await vaultTasks.setPriority(task.id, prev, stamp, prevBy) : null;
      if (back?.ok) { patch(task.id, (t) => ({ ...t, priority: prev, priorityBy: prevBy, updatedAt: back.updatedAt ?? t.updatedAt })); setUndo(null); setNotice(null); }
      else { setNotice("Couldn't undo: it changed elsewhere. Showing the latest."); setUndo(null); refresh(); }
      stamp = null;
    } });
  }, [nodePath]); // eslint-disable-line react-hooks/exhaustive-deps

  return { tree, tasks: visible, setPriority, leaving, counts, truncated, treeTruncated, error, loading, notice, undo, act, refresh, dismissNotice: () => setNotice(null), ready: list !== null, now };
}
