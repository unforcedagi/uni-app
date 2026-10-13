import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildTaskTree, dayOf, isLive, rollUp, snoozed, tasksUnder, tomorrowOf, type AnyState, type Counts, type Priority, type RawNote, type Task, type TaskNode, type TaskTree } from "./taskCore";
import { vaultTasks } from "./vaultTasks";
import { shouldReload } from "./pathCache";
import { useVaultProfile } from "./ProfileContext";
import { parseDrafts, parseRuns } from "./steerCore";
import { activeProfile } from "./profile";
import { warmTitles } from "./noteRefs";

export type TaskAction = "done" | "archive" | "snooze";
export type Undo = { id: string; label: string; run: () => Promise<void> };
export const UNDO_MS = 5000;
/** How often an open window re-reads the tasks, and how stale a list may be when the window or a room is opened. */
export const POLL_MS = 60_000;
export const FOCUS_GAP_MS = 10_000;
/** One finite exit animation; none when the user prefers reduced motion. */
export const LEAVE_MS = 240;
const reduced = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// Memory for this session only, scoped to the signed-in identity and cleared on Forget: tasks are Aaron's private work.
type Memory = { owner: string; tree: (TaskTree & { truncated: boolean }) | null; tasks: Map<string, { list: Task[]; truncated: boolean }>; at: number | null; runs: RawNote[]; drafts: RawNote[] };
let memory: Memory = { owner: "", tree: null, tasks: new Map(), at: null, runs: [], drafts: [] };
export function forgetTasks() { memory = { owner: "", tree: null, tasks: new Map(), at: null, runs: [], drafts: [] }; }
const scoped = (owner: string) => { if (memory.owner !== owner) memory = { owner, tree: null, tasks: new Map(), at: null, runs: [], drafts: [] }; return memory; };

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
  const [truncated, setTruncated] = useState(() => !!scoped(owner).tasks.get(nodePath)?.truncated);
  const [treeTruncated, setTreeTruncated] = useState(() => !!scoped(owner).tree?.truncated);
  // The local date, re-read when the window is shown or focused again: a snooze ends at midnight even if the app stayed open.
  const [day, setDay] = useState(() => dayOf(new Date()));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** When the list last read cleanly (ms): a failed refresh says how old the rows it keeps are. */
  const [lastOk, setLastOk] = useState<number | null>(() => scoped(owner).at);
  const [notice, setNotice] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [n, setN] = useState(0);
  // The dispatch ledger and the draft notes: read with the tree-wide load (the node page's Running and Drafts), empty when the vault has none.
  const [rawRuns, setRawRuns] = useState<RawNote[]>(() => scoped(owner).runs);
  const [rawDrafts, setRawDrafts] = useState<RawNote[]>(() => scoped(owner).drafts);
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
    vaultTasks.setAskOwner(owner);
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
      const [r, runs, drafts] = await Promise.all([vaultTasks.loadTasks(t, nodePath), nodePath === "" ? vaultTasks.loadTagged("run") : null, nodePath === "" ? vaultTasks.loadTagged("draft") : null]);
      if (!live || mine !== epoch.current || memory !== mem) return;
      if (runs) { mem.runs = runs; setRawRuns(runs); }
      if (drafts) { mem.drafts = drafts; setRawDrafts(drafts); }
      mem.tasks.set(nodePath, { list: r.tasks, truncated: r.truncated });
      mem.at = Date.now();
      setList(r.tasks); setTruncated(r.truncated); setError(null); setLastOk(mem.at);
      warmTitles(r.tasks.flatMap((t) => [t.title, t.next]));
      // a cut title's full question arrives a moment later, without holding the list back
      void vaultTasks.loadAsks(r.tasks).then((asks) => {
        if (!asks.size || !live || mine !== epoch.current || memory !== mem) return;
        const withAsk = (l: Task[] | null) => l && l.map((t) => (asks.has(t.id) ? { ...t, ask: asks.get(t.id)! } : t));
        const merged = r.tasks.map((t) => (asks.has(t.id) ? { ...t, ask: asks.get(t.id)! } : t));
        mem.tasks.set(nodePath, { list: merged, truncated: r.truncated });
        setList((cur) => withAsk(cur));
      }).catch(() => {});
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
    // Coming back to the window re-reads what is stale; and while it stays open the list is re-read every minute, so a task finished
    // elsewhere (Uni in the vault, another device) leaves the needs-you feed on its own.
    const focus = () => { setDay(dayOf(new Date())); if (shouldReload(lastLoad.current, Date.now(), FOCUS_GAP_MS)) refresh(); };
    const tick = setInterval(() => { if (document.visibilityState === "visible" && shouldReload(lastLoad.current, Date.now(), POLL_MS - 1000)) refresh(); }, POLL_MS);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", focus);
    return () => { clearInterval(tick); document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", focus); };
  }, [refresh]);
  /** Re-read when the last read is older than `gapMs` (a room was opened: its list must not be a stale copy). */
  const refreshIfStale = useCallback((gapMs = FOCUS_GAP_MS) => { if (shouldReload(lastLoad.current, Date.now(), gapMs)) refresh(); }, [refresh]);
  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); if (undoTimer.current) clearTimeout(undoTimer.current); }, []);

  const now = new Date();
  const visible = useMemo(() => (list ?? []).filter((t) => isLive(t) && !gone.has(t.id) && !snoozed(t, new Date())), [list, gone, n, day]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts: Map<string, Counts> = useMemo(() => (tree ? rollUp(tree, tasksUnder(tree, nodePath, visible)) : new Map()), [tree, nodePath, visible]);

  const runs = useMemo(() => (tree ? parseRuns(rawRuns, tree) : []), [tree, rawRuns]);
  const drafts = useMemo(() => (tree ? parseDrafts(rawDrafts, tree, list ?? []) : []), [tree, rawDrafts, list]);

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

  /** One tap on a decision's option. A conflict (already decided elsewhere) says so and re-reads. There is no undo: a decision is a decision. */
  const decide = useCallback(async (task: Task, option: string) => {
    setNotice(null);
    hide(task.id);
    const r = await vaultTasks.decide(task.id, option, activeProfile().me);
    if (r.ok) { refresh(); return; }
    restore(task.id);
    setNotice(r.kind === "conflict" ? "Already decided. Showing the latest." : r.kind === "invalid" ? "Couldn't decide: the vault refused that value." : `Couldn't decide: ${r.message.replace(/^Error:\s*/, "").slice(0, 120)}`);
    if (r.kind === "conflict") refresh();
  }, [nodePath]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = useCallback(async (task: Task, action: TaskAction) => {
    setNotice(null);
    // a decision is closed only by recording an answer (decide); it can be snoozed, never checked off or put away without one
    if (task.kind === "decision" && action !== "snooze") { setNotice("A decision is closed by answering it."); return; }
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
    const to: AnyState = action === "archive" ? "archived" : "done";
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

  return { tree, tasks: visible, all: list, runs, drafts, setPriority, decide, leaving, counts, truncated, treeTruncated, error, loading, notice, undo, act, refresh, refreshIfStale, dismissNotice: () => setNotice(null), ready: list !== null, now,
    /** A re-read is under way while rows are on screen. */
    refreshing: loading && list !== null,
    lastOk,
    /** Every page of the list (and of the tree) was read: nothing is missing from it. */
    complete: !truncated && !treeTruncated };
}
