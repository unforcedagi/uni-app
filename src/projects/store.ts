// T-302: the projects and sessions the app shows, read from the vault the app already reads (the same signed door as every note:
// `vault_query`), and what a person has asked the room to do to them. Nothing here changes a session: an action is a message in the
// room (actions.ts); this store only remembers that it was asked, until the run notes say it happened.
//
// Round 3 (the review's findings):
// - The work belongs to one identity on one vault: the device copy and every read are keyed by both, and Forget (or another identity)
//   drops the copy, what is in memory, the pending asks and any read still out (a late answer can't put it back).
// - A read that stops short (a list longer than the pages read) says so ("Some older sessions aren't loaded"), and run notes are read in
//   date windows, newest first, so the recent and working ones are whole even in a large vault.
// - Sessions keep their heartbeat; what counts as working is worked out again from the clock every minute, so a copy kept while offline
//   ages as the vault would. A failed read keeps what was shown, says when it is from, and the working counts say "at <time>".
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import { activeProfile } from "../areas/profile";
import type { RawNote } from "../areas/taskCore";
import { allPages } from "../areas/vaultTasks";
import { freshen, workFrom, type LiveWork, type Sources } from "./live";
import type { Action } from "./actions";

export type Asked = { kind: Action["kind"]; at: number; state: string | null };
export type WorkState = {
  work: LiveWork; ready: boolean; error: string | null;
  /** When the work on screen was read (a saved copy: when that copy was read); null before any. */
  at: number | null;
  /** What the last read couldn't cover, in words ("Some older sessions aren't loaded"); empty when it covered everything. */
  partial: string[];
  asked: ReadonlyMap<string, Asked>;
};

const EMPTY: LiveWork = { areas: [], projects: [], sessions: [], gaps: [] };
/** How often the work is read again while something shows it (and the window is visible). */
export const REFRESH_MS = 30_000;
/** A read older than this (or a failed one) is "as of" its time, and the working counts say so. */
export const FRESH_MS = 3 * REFRESH_MS;
/** How often what is on screen is aged by the clock (working → silent), between reads too. */
const CLOCK_MS = 60_000;
/** Tasks change slowly and only name sessions: read at most this often. */
const TASKS_MS = 5 * 60_000;
/** "Asked the room" stays this long at most, if the run notes never show the change. */
const ASKED_MS = 15 * 60_000;
/** The device keeps the last read's sessions from this far back (all live ones), so a cold start paints at once. */
const KEEP_MS = 30 * 86_400_000;
const DAY = 86_400_000;
/** Run notes are read in these windows of `started_at` (days back, newest first), plus every one still marked running. */
const RUN_WINDOWS: readonly [number, number][] = [[0, 2], [2, 7], [7, 21], [21, 60]];

const BLANK: WorkState = { work: EMPTY, ready: false, error: null, at: null, partial: [], asked: new Map() };
let state: WorkState = BLANK;
const listeners = new Set<() => void>();
const set = (next: Partial<WorkState>) => { state = { ...state, ...next }; for (const l of listeners) l(); };
let tasks: { rows: RawNote[]; at: number } | null = null;
let inflight: Promise<void> | null = null;
/** Whose work this is: the identity, set by the app (null: signed out or not known yet, so nothing is read or shown). */
let identity: string | null = null;
/** The identity and vault the work on screen belongs to. */
let loadedFor: string | null = null;
/** Bumped by Forget and by a change of owner: a read begun under an older generation is dropped when it lands. */
let generation = 0;
const later = new Set<ReturnType<typeof setTimeout>>();

const ownerOf = (id: string | null, vault: string) => (id && vault ? `${id}:${vault}` : null);
const CACHE_PREFIX = "uni.work.";
const cacheKey = (owner: string) => `${CACHE_PREFIX}v3:${owner}`;
type Saved = { work: LiveWork; at: number | null; partial: string[] };
function readCache(owner: string): Saved | null {
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey(owner)) ?? "null");
    const w = c?.work;
    return w && Array.isArray(w.areas) && Array.isArray(w.projects) && Array.isArray(w.sessions)
      ? { work: { gaps: [], ...w }, at: typeof c.at === "number" ? c.at : null, partial: Array.isArray(c.partial) ? c.partial : [] } : null;
  } catch { return null; }
}
function writeCache(owner: string, s: Saved) {
  const floor = Date.now() - KEEP_MS;
  const work = { ...s.work, sessions: s.work.sessions.filter((x) => x.state === "running" || (x.endedAt ?? 0) >= floor) };
  try { localStorage.setItem(cacheKey(owner), JSON.stringify({ ...s, work })); } catch { /* storage full or off: this session only */ }
}
/** Every device copy of the work, of every owner and every version (the vault-only keys before round 3 too). */
function dropCaches(keep: string | null = null) {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX) && k !== keep) localStorage.removeItem(k); } catch { /* private storage */ }
}

const page = (vault: string, tag: string) => (offset: number) => invoke("vault_query", { vault, tag, includeContent: false, limit: 200, ...(offset ? { offset } : {}) }) as Promise<RawNote[]>;
const pageWhere = (vault: string, tag: string, metadata: Record<string, unknown>) => (offset: number) => invoke("vault_query_meta", { vault, tag, metadata, limit: 200, ...(offset ? { offset } : {}) }) as Promise<RawNote[]>;
/** The runs that started in the last 60 days, a window at a time (newest first), and every one still marked running. */
async function readRuns(vault: string, at: number): Promise<{ rows: RawNote[]; partial: string[] }> {
  const iso = (days: number) => new Date(at - days * DAY).toISOString();
  const [running, ...windows] = await Promise.all([
    allPages(pageWhere(vault, "run", { state: { eq: "running" } })),
    ...RUN_WINDOWS.map(([to, from]) => allPages(pageWhere(vault, "run", { started_at: to === 0 ? { gte: iso(from) } : { gte: iso(from), lt: iso(to) } }))),
  ]);
  const seen = new Set<unknown>();
  const rows = [running, ...windows].flatMap((r) => r.rows).filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  const partial = !running.complete || !windows[0].complete ? ["Some sessions aren't loaded"] : windows.some((w) => !w.complete) ? ["Some older sessions aren't loaded"] : [];
  return { rows, partial };
}

/** Reads the work again (one at a time; a call while a read is out waits for it). A failed read keeps what was shown and says so. */
export function refreshWork(): Promise<void> {
  const vault = activeProfile().vault;
  const owner = ownerOf(identity, vault);
  if (owner !== loadedFor) adopt(owner);
  if (!owner) return Promise.resolve();
  if (inflight) return inflight;
  const mine = generation;
  const current = () => mine === generation;
  let p: Promise<void> | undefined;
  p = (async () => {
    try {
      const fresh = !tasks || Date.now() - tasks.at > TASKS_MS;
      const t0 = Date.now();
      const [nodes, runs, taskRows] = await Promise.all([
        allPages(page(vault, "node")), readRuns(vault, t0),
        fresh ? allPages(page(vault, "task")).then((r) => r.rows).catch(() => tasks?.rows ?? []) : Promise.resolve(tasks!.rows),
      ]);
      // Forget, or another identity or vault, since this read began: its answer is not this owner's, so it is dropped
      if (!current()) return;
      if (fresh) tasks = { rows: taskRows, at: Date.now() };
      const src: Sources = { nodes: nodes.rows, runs: runs.rows, tasks: taskRows };
      const work = workFrom(src);
      const partial = [...(nodes.complete ? [] : ["Some projects aren't loaded"]), ...runs.partial];
      writeCache(owner, { work, at: t0, partial });
      set({ work, ready: true, error: null, at: t0, partial, asked: settle(state.asked, work) });
    } catch (e) {
      if (current()) set({ error: String(e), ready: state.ready || state.work.areas.length > 0, work: freshen(state.work) });
    } finally { if (inflight === p) inflight = null; }
  })();
  inflight = p;
  return p!;
}

/** The work of a new owner (or none): what this device kept for that owner, never another's. Reads still out are dropped. */
function adopt(owner: string | null) {
  generation++;
  loadedFor = owner; tasks = null; inflight = null;
  for (const t of later) clearTimeout(t);
  later.clear();
  const saved = owner ? readCache(owner) : null;
  state = { ...BLANK, asked: new Map() };
  set(saved ? { work: freshen(saved.work), at: saved.at, partial: saved.partial } : {});
}

/** The app's identity (null when signed out or not read yet). Called on every change; another identity sees none of this one's work. */
export function setWorkOwner(id: string | null) {
  // the copies kept before round 3 were keyed by the vault alone: no owner can be sure they are theirs
  try { for (const k of Object.keys(localStorage)) if (/^uni\.work\.v[12]:/.test(k)) localStorage.removeItem(k); } catch { /* private storage */ }
  if (id === identity) return;
  identity = id;
  const owner = ownerOf(id, activeProfile().vault);
  if (owner !== loadedFor) adopt(owner);
  if (owner && users > 0) void refreshWork();
}

/** Forget this device key: the device copies (every owner's), the work in memory, the pending asks, and any read still out. */
export function forgetWork() {
  identity = null;
  adopt(null);
  dropCaches();
}

/** An ask is settled when the run notes show something new for it (the session ended, a project changed status), or after a while. */
function settle(asked: ReadonlyMap<string, Asked>, w: LiveWork): Map<string, Asked> {
  const out = new Map<string, Asked>();
  for (const [key, a] of asked) {
    if (Date.now() - a.at > ASKED_MS) continue;
    if (now(key, w) !== a.state) continue;
    out.set(key, a);
  }
  return out;
}
/** What an ask is waiting to see change: a session's state, or a project's status and how many sessions it has. */
function now(key: string, w: LiveWork): string | null {
  // "add:<project>": the ask is answered when the project has another session
  if (key.startsWith("add:")) { const id = key.slice(4); return String(w.sessions.filter((x) => x.project === id).length); }
  const s = w.sessions.find((x) => x.id === key);
  if (s) return s.state;
  const p = w.projects.find((x) => x.id === key);
  return p ? p.status : null;
}

/** Remembers that the room was asked (shown as "Asked the room" on the session or project), and reads again soon after. The key is the
 *  session's id (Stop, Fresh start), the project's id (Archive, Bring back), or `add:<project id>` (Add a session). */
export function noteAsked(key: string, kind: Action["kind"]) {
  const asked = new Map(state.asked);
  asked.set(key, { kind, at: Date.now(), state: now(key, state.work) });
  set({ asked });
  for (const ms of [4000, 15000, 45000]) { const t = setTimeout(() => { later.delete(t); void refreshWork(); }, ms); later.add(t); }
}

/** "as of 10:32" when the work on screen isn't a fresh read (a failed one, or a saved copy not read again yet); null when it is fresh. */
export function asOf(s: Pick<WorkState, "at" | "error">, nowMs = Date.now()): string | null {
  if (s.at === null) return null;
  if (!s.error && nowMs - s.at <= FRESH_MS) return null;
  const d = new Date(s.at), today = new Date(nowMs).toDateString() === d.toDateString();
  return (today ? "" : `${d.toLocaleDateString(undefined, { weekday: "short" })} `) + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const get = () => state;
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let clock: ReturnType<typeof setInterval> | null = null;
const onVisible = () => { if (document.visibilityState === "visible" && (!state.at || state.error || Date.now() - state.at > REFRESH_MS / 2)) void refreshWork(); };
/** Ages what is on screen by the clock (a session no one has heard from stops counting as working), and re-renders "as of". */
const tick = () => set({ work: freshen(state.work) });

/** The work, kept fresh while any component shows it. */
export function useWork(): WorkState {
  useEffect(() => {
    if (users++ === 0) {
      void refreshWork();
      timer = setInterval(() => { if (document.visibilityState === "visible") void refreshWork(); }, REFRESH_MS);
      clock = setInterval(tick, CLOCK_MS);
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("focus", onVisible);
    }
    return () => {
      if (--users === 0) {
        if (timer) clearInterval(timer);
        if (clock) clearInterval(clock);
        timer = clock = null;
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("focus", onVisible);
      }
    };
  }, []);
  return useSyncExternalStore(subscribe, get, get);
}
