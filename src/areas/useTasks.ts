import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildTaskTree, dayOf, isLive, rollUp, snoozed, tasksUnder, tomorrowOf, type AnyState, type Counts, type Priority, type RawNote, type Task, type TaskNode, type TaskTree } from "./taskCore";
import { vaultTasks } from "./vaultTasks";
import { shouldReload } from "./pathCache";
import { useVaultProfile } from "./ProfileContext";
import { parseDrafts, parseRuns } from "./steerCore";
import { activeProfile } from "./profile";
import { warmTitles } from "./noteRefs";
import { savedTasks } from "./savedTasks";
import type { FailureKind } from "./taskCore";

export type TaskAction = "done" | "archive" | "snooze";
/** What a write came to (r16): the sheet waits for it, and on a conflict stays open with the latest copy. */
export type ActResult = { ok: true } | { ok: false; kind: FailureKind | "refused"; message: string };
export type Undo = { id: string; label: string; run: () => Promise<void> };
export const UNDO_MS = 5000;
/** How often an open window re-reads the tasks, and how stale a list may be when the window or a room is opened. */
export const POLL_MS = 60_000;
export const FOCUS_GAP_MS = 10_000;
/** One finite exit animation; none when the user prefers reduced motion. */
export const LEAVE_MS = 240;
/** A load still running after this long says so, with Retry (r16): never an endless "Loading…". */
export const SLOW_MS = 8000;
/** The test build may shorten it (`window.__slowMs`); never in a release build. */
const slowMs = (): number => (import.meta.env?.VITE_AREAS_TESTHOOKS === "1" && typeof window !== "undefined" && Number((window as unknown as { __slowMs?: number }).__slowMs)) || SLOW_MS;
const reduced = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// Memory for this session only, scoped to the signed-in identity and cleared on Forget: tasks are Aaron's private work.
/** Running and Drafts' own read (r16): read yet, the last failure, when they last read cleanly. */
export type Activity = { ready: boolean; error: string | null; lastOk: number | null };
type Memory = { owner: string; tree: (TaskTree & { truncated: boolean }) | null; tasks: Map<string, { list: Task[]; truncated: boolean }>; at: number | null; runs: RawNote[]; drafts: RawNote[]; activity: Activity };
const fresh = (owner: string): Memory => ({ owner, tree: null, tasks: new Map(), at: null, runs: [], drafts: [], activity: { ready: false, error: null, lastOk: null } });
let memory: Memory = fresh("");
export function forgetTasks() { memory = fresh(""); }
/** Forget on the device too (the user's Forget): the saved list goes with the key. */
export function forgetSavedTasks() { forgetTasks(); savedTasks.clear(); }
/** The list kept on the device for this identity and vault (r16), for Uni's level (the whole tree's list). */
const savedFor = (owner: string, nodePath: string) => (nodePath === "" ? savedTasks.read(owner) : null);
const scoped = (owner: string) => { if (memory.owner !== owner) memory = fresh(owner); return memory; };

const verb: Record<TaskAction, string> = { done: "mark it done", archive: "archive it", snooze: "snooze it" };
const said: Record<TaskAction, string> = { done: "Marked done", archive: "Archived", snooze: "Snoozed until tomorrow" };

/**
 * The open tasks under one node, straight from the vault. Optimistic: a check-off disappears at once and the vault's answer
 * reconciles it. A failed write rolls back with a message; a conflict (the task changed elsewhere) re-reads instead of retrying.
 */
export function useTasks(identity: string | null, nodePath: string, fallback: readonly TaskNode[]) {
  const vault = useVaultProfile().vault;
  const owner = `${identity ?? ""}|${vault}`;
  // r16: memory first (this session), else the list kept on the device, painted at once with its age while it is read again
  const [initial] = useState(() => { const m = scoped(owner); return m.tasks.has(nodePath) ? null : savedFor(owner, nodePath); });
  const [tree, setTree] = useState<TaskTree | null>(() => scoped(owner).tree ?? initial?.tree ?? null);
  const [list, setList] = useState<Task[] | null>(() => scoped(owner).tasks.get(nodePath)?.list ?? initial?.list ?? null);
  const [truncated, setTruncated] = useState(() => !!(scoped(owner).tasks.get(nodePath)?.truncated ?? initial?.truncated));
  const [treeTruncated, setTreeTruncated] = useState(() => !!(scoped(owner).tree?.truncated ?? initial?.tree.truncated));
  /** When the rows on screen are the device's copy, not yet read this session: when that copy was read (ms). */
  const [savedAt, setSavedAt] = useState<number | null>(() => initial?.at ?? null);
  /** The current load has run past SLOW_MS (r16): say so, with Retry. */
  const [slow, setSlow] = useState(false);
  // The local date, re-read when the window is shown or focused again: a snooze ends at midnight even if the app stayed open.
  const [day, setDay] = useState(() => dayOf(new Date()));
  const [error, setError] = useState<string | null>(null);
  /** The last read of the task tree failed (the rows may sit under the wrong place until it reads again). */
  const [treeError, setTreeError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** When the list last read cleanly (ms): a failed refresh says how old the rows it keeps are. */
  const [lastOk, setLastOk] = useState<number | null>(() => scoped(owner).at ?? initial?.at ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [n, setN] = useState(0);
  // The dispatch ledger and the draft notes: read with the tree-wide load (the node page's Running and Drafts), empty when the vault has none.
  const [rawRuns, setRawRuns] = useState<RawNote[]>(() => scoped(owner).runs);
  const [rawDrafts, setRawDrafts] = useState<RawNote[]>(() => scoped(owner).drafts);
  /** Running and Drafts are read on their own (r16), so the list never waits for them; whether they were read, and when. */
  const [activity, setActivity] = useState<Activity>(() => scoped(owner).activity);
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
    const current = () => live && mine === epoch.current;
    // memory, else the device's copy (r16): the rows show at once with their age and the read below replaces them
    const kept = mem.tasks.get(nodePath) ?? null;
    const saved = kept ? null : savedFor(owner, nodePath);
    setList(kept?.list ?? saved?.list ?? null);
    if (saved) { setTree((t) => t ?? saved.tree); setTruncated(saved.truncated); setLastOk((l) => l ?? saved.at); }
    setActivity(mem.activity);
    setSavedAt(kept || mem.at !== null ? null : saved?.at ?? null);
    vaultTasks.setAskOwner(owner);
    setLoading(true); setSlow(false);
    const slowTimer = setTimeout(() => { if (current()) setSlow(true); }, slowMs());
    lastLoad.current = Date.now();
    // The tree is re-read with every refresh (r13), so a project filed or moved meanwhile is placed right. `node` notes are the tree; if the
    // vault has none yet, the app's own tree (areas and projects) stands in. A failed read keeps the last good tree, or the app's own, and
    // says so: it is never kept as if it had been read.
    const treeP: Promise<TaskTree & { truncated: boolean }> = vaultTasks.loadTree().then((loaded) => {
      const t = loaded.byPath.size || !fallback.length ? loaded : { ...buildTaskTree(fallback), truncated: false };
      mem.tree = t;
      if (current()) { setTreeError(null); setTree(t); setTreeTruncated(!!t.truncated); }
      return t;
    }, (e) => {
      const t = mem.tree ?? saved?.tree ?? { ...buildTaskTree(fallback), truncated: false };
      if (current()) { setTreeError(String(e)); setTree(t); setTreeTruncated(!!t.truncated); }
      return t;
    });
    // Running and Drafts (Uni's level reads them for the whole tree): their own reads, never holding the list back (r16). A failed read keeps
    // what was read before and says so; with nothing read yet the work view says it couldn't check, never "nothing is moving".
    if (nodePath === "") {
      void Promise.all([vaultTasks.loadTagged("run"), vaultTasks.loadTagged("draft")]).then(([runs, drafts]) => {
        if (!current() || memory !== mem) return;
        if (runs) { mem.runs = runs; setRawRuns(runs); }
        if (drafts) { mem.drafts = drafts; setRawDrafts(drafts); }
        mem.activity = runs && drafts ? { ready: true, error: null, lastOk: Date.now() } : { ...mem.activity, error: "Couldn't check what's running" };
        setActivity(mem.activity);
      });
    }
    (async () => {
      const r = await vaultTasks.loadTasks(treeP, nodePath);
      if (!current() || memory !== mem) return;
      mem.tasks.set(nodePath, { list: r.tasks, truncated: r.truncated });
      mem.at = Date.now();
      setList(r.tasks); setTruncated(r.truncated); setError(null); setLastOk(mem.at); setSavedAt(null);
      if (nodePath === "") { const t = mem.tree; if (t) savedTasks.write(owner, { at: mem.at, tree: t, list: r.tasks, truncated: r.truncated }); }
      warmTitles(r.tasks.flatMap((t) => [t.title, t.next]), vault);
      // a cut title's full question arrives a moment later, without holding the list back
      void vaultTasks.loadAsks(r.tasks).then((asks) => {
        if (!asks.size || !current() || memory !== mem) return;
        // each ask keeps the revision it was read at; a row shows it as its question only at that revision (decisionAsk)
        const one = (t: Task) => { const a = asks.get(t.id); return a ? { ...t, ask: a.ask, askAt: a.at } : t; };
        const withAsk = (l: Task[] | null) => l && l.map(one);
        const merged = r.tasks.map(one);
        mem.tasks.set(nodePath, { list: merged, truncated: r.truncated });
        setList((cur) => withAsk(cur));
      }).catch(() => {});
      // anything the server no longer lists is settled: stop hiding it by hand
      setGone((g) => new Set([...g].filter((id) => r.tasks.some((x) => x.id === id && isLive(x)))));
    })().catch((e) => { if (current()) setError(String(e)); }).finally(() => { clearTimeout(slowTimer); if (current()) { setLoading(false); setSlow(false); } });
    return () => { live = false; clearTimeout(slowTimer); };
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

  /**
   * One tap on a decision's option, written with the revision whose question was on screen (`task.updatedAt`: the row's question is shown
   * only at that revision). A conflict (decided or changed elsewhere) says so and re-reads. There is no undo: a decision is a decision.
   */
  const decide = useCallback(async (task: Task, option: string) => {
    setNotice(null);
    if (!task.updatedAt) { setNotice("Couldn't decide: reload the decision first."); refresh(); return; }
    hide(task.id);
    const r = await vaultTasks.decide(task.id, option, activeProfile().me, task.updatedAt);
    if (r.ok) { refresh(); return; }
    restore(task.id);
    setNotice(r.kind === "conflict" ? "This decision changed or was decided elsewhere, so your answer wasn't recorded. Showing the latest." : r.kind === "invalid" ? "Couldn't decide: the vault refused that value." : `Couldn't decide: ${r.message.replace(/^Error:\s*/, "").slice(0, 120)}`);
    if (r.kind === "conflict") refresh();
  }, [nodePath]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Done, Archive or Snooze. Every one is written against the revision the user saw (r16): "I did this" and Archive send the task's `updatedAt`
   * with the state compare-and-set, in one update, so a task whose instruction changed since can't be closed blind; Undo is guarded by the
   * revision the first write returned. From the sheet (`sheet`), the row stays until the write succeeds and a conflict is the sheet's to say
   * ("This changed since you opened it"); from elsewhere the row leaves at once and comes back with a notice.
   */
  const act = useCallback(async (task: Task, action: TaskAction, opts: { sheet?: boolean } = {}): Promise<ActResult> => {
    setNotice(null);
    // a decision is closed only by recording an answer (decide); it can be snoozed, never checked off or put away without one
    if (task.kind === "decision" && action !== "snooze") { const message = "A decision is closed by answering it."; setNotice(message); return { ok: false, kind: "refused", message }; }
    if (!task.updatedAt) {
      const message = `Couldn't ${verb[action]}: reload the task first.`;
      if (!opts.sheet) setNotice(message);
      refresh();
      return { ok: false, kind: "conflict", message };
    }
    const failed = (r: { ok: false; kind: FailureKind; message: string }): ActResult => {
      if (opts.sheet) { if (r.kind === "conflict") refresh(); else setNotice(`Couldn't ${verb[action]}: ${r.message.replace(/^Error:\s*/, "").slice(0, 120)}`); }
      else fail(task, action, r);
      return r;
    };
    if (!opts.sheet) hide(task.id);
    if (action === "snooze") {
      const until = tomorrowOf(new Date());
      const r = await vaultTasks.snooze(task.id, until, task.updatedAt);
      if (!r.ok) return failed(r);
      if (opts.sheet) hide(task.id);
      patch(task.id, (t) => ({ ...t, snoozedUntil: until, updatedAt: r.updatedAt ?? t.updatedAt, lastUpdatedBy: r.lastUpdatedBy ?? t.lastUpdatedBy, lastUpdatedVia: r.lastUpdatedVia ?? t.lastUpdatedVia }));
      let stamp = r.updatedAt;
      offerUndo({ id: task.id, label: said.snooze, run: async () => {
        const back = stamp ? await vaultTasks.snooze(task.id, null, stamp) : null;
        if (back?.ok) { restore(task.id); patch(task.id, (t) => ({ ...t, snoozedUntil: null, updatedAt: back.updatedAt ?? t.updatedAt })); setUndo(null); setNotice(null); }
        else { setNotice("Couldn't undo: it changed elsewhere. Showing the latest."); setUndo(null); refresh(); }
        stamp = null;
      } });
      return { ok: true };
    }
    const from = task.state;
    const to: AnyState = action === "archive" ? "archived" : "done";
    const r = await vaultTasks.transition(task.id, from, to, task.updatedAt);
    if (!r.ok) return failed(r);
    if (opts.sheet) hide(task.id);
    patch(task.id, (t) => ({ ...t, state: to, updatedAt: r.updatedAt ?? t.updatedAt, lastUpdatedBy: r.lastUpdatedBy ?? t.lastUpdatedBy, lastUpdatedVia: r.lastUpdatedVia ?? t.lastUpdatedVia }));
    // Undo is the reverse compare-and-set, guarded by the revision this write returned: if anyone changed it since, it fails like any other conflict
    let stamp = r.updatedAt;
    offerUndo({ id: task.id, label: said[action], run: async () => {
      const back = stamp ? await vaultTasks.transition(task.id, to, from, stamp) : null;
      stamp = null;
      if (back?.ok) { patch(task.id, (t) => ({ ...t, state: from, updatedAt: back.updatedAt ?? t.updatedAt })); restore(task.id); setUndo(null); setNotice(null); refresh(); }
      else { setNotice(!back || back.kind === "conflict" ? "Couldn't undo: it changed elsewhere. Showing the latest." : `Couldn't undo: ${back.message.slice(0, 120)}`); setUndo(null); refresh(); }
    } });
    return { ok: true };
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

  return { tree, tasks: visible, all: list, runs, drafts, setPriority, decide, leaving, counts, truncated, treeTruncated, error, treeError, loading, notice, undo, act, refresh, refreshIfStale, dismissNotice: () => setNotice(null), ready: list !== null, now,
    /** The rows are the device's copy from this moment (ms), not yet read again this session (r16). */
    savedAt,
    /** The current read has run past SLOW_MS: "Still loading · Retry" (r16). */
    slow: loading && slow,
    /** Running and Drafts: read yet, the last failure, when they last read cleanly. */
    activity,
    /** A re-read is under way while rows are on screen. */
    refreshing: loading && list !== null,
    lastOk,
    /** Every page of the list (and of the tree) was read: nothing is missing from it. */
    complete: !truncated && !treeTruncated };
}
