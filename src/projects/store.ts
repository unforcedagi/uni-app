// T-302: the projects and sessions the app shows, read from the vault the app already reads (the same signed door as every note:
// `vault_query`), and what a person has asked the room to do to them. Nothing here changes a session: an action is a message in the
// room (actions.ts); this store only remembers that it was asked, until the run notes say it happened.
//
// Round 3 (the review's findings):
// - The work belongs to one identity on one vault: the device copy and every read are keyed by both, and Forget (or another identity)
//   drops the copy, what is in memory, the pending asks and any read still out (a late answer can't put it back).
// - A read that stops short (a list longer than the pages read) says so ("Some older sessions aren't loaded"), and run notes are read in
//   date windows, newest first, so the recent and working ones are whole even in a large vault.
// - T-304: a session's steps (feed.ts) follow the same owner: adopt() hands it on, so Forget and a change of owner drop them too.
// - Sessions keep their heartbeat; what counts as working is worked out again from the clock every minute, so a copy kept while offline
//   ages as the vault would. A failed read keeps what was shown, says when it is from, and the working counts say "at <time>".
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import { activeProfile, onVaultChange } from "../areas/profile";
import type { RawNote } from "../areas/taskCore";
import { POLL_MS, reader } from "../vault/reader";
import { freshen, workFrom, type LiveWork, type Sources } from "./live";
import { isHome } from "./model";
import type { Action } from "./actions";
import { setFeedOwner } from "./feed";

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
/** The work is read again on the app's one poller (src/vault/reader.ts: a minute apart while the window is visible). A read older than
 *  this (two ticks), or a failed one, is "as of" its time, and the working counts say so. */
export const FRESH_MS = 2 * POLL_MS;
/** How often what is on screen is aged by the clock (working → silent), between reads too. */
const CLOCK_MS = 60_000;
/** Tasks change slowly and only name sessions: read at most this often. */
const TASKS_MS = 5 * 60_000;
/** "Asked the room" stays this long at most, if the run notes never show the change. */
const ASKED_MS = 15 * 60_000;
/** The device keeps the last read's sessions from this far back (all live ones), so a cold start paints at once. */
const KEEP_MS = 30 * 86_400_000;

const BLANK: WorkState = { work: EMPTY, ready: false, error: null, at: null, partial: [], asked: new Map() };
let state: WorkState = BLANK;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const set = (next: Partial<WorkState>) => { state = { ...state, ...next }; emit(); };
let tasks: { rows: RawNote[]; whole: boolean; at: number } | null = null;
/** The account's rooms (the app tells the store), and the notes of the last read: the rooms often arrive just after it. Memory only. */
let hubRooms: readonly { id: string; name: string }[] | null = null;
let lastRead: Sources | null = null;
let inflight: Promise<void> | null = null;
/** Whose work this is: the identity, set by the app (null: signed out or not known yet, so nothing is read or shown). */
let identity: string | null = null;
/** The identity and vault the work on screen belongs to. */
let loadedFor: string | null = null;
/** Bumped by Forget and by a change of owner: a read begun under an older generation is dropped when it lands. */
let generation = 0;
const later = new Set<ReturnType<typeof setTimeout>>();
/** The owner the app is on now (identity and the active vault, read at this moment). */
const currentOwner = () => ownerOf(identity, activeProfile().vault);

const ownerOf = (id: string | null, vault: string) => (id && vault ? `${id}:${vault}` : null);
const CACHE_PREFIX = "uni.work.";
const cacheKey = (owner: string) => `${CACHE_PREFIX}v4:${owner}`;
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
  const sessions = s.work.sessions.filter((x) => x.state === "running" || (x.endedAt ?? 0) >= floor);
  // a home with none of its sessions kept is left out too: no "Unfiled sessions · 0" from a saved copy
  const kept = new Set(sessions.map((x) => x.project));
  const work = { ...s.work, sessions, projects: s.work.projects.filter((p) => !isHome(p) || kept.has(p.id)) };
  try { localStorage.setItem(cacheKey(owner), JSON.stringify({ ...s, work })); } catch { /* storage full or off: this session only */ }
}
/** Every device copy of the work, of every owner and every version (the vault-only keys before round 3 too). */
function dropCaches(keep: string | null = null) {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX) && k !== keep) localStorage.removeItem(k); } catch { /* private storage */ }
}

const taskIdIn = (path: unknown) => (typeof path === "string" ? /^Tasks\/(T-\d+[a-z]?)\b/i.exec(path)?.[1]?.toUpperCase() ?? null : null);
/** At most this many tasks are looked up one by one in a read (the rest wait for the next read, and are counted as not placed). */
const FILL_MAX = 40;
/** The tasks named by runs that don't land under a project, looked up one by one (the note list's paths, then each note). `missing`: the
 *  sessions still without a project because their task couldn't be read (one that doesn't exist at all isn't missing: there is nothing to
 *  read). */
async function fillTasks(vault: string, runs: readonly RawNote[], nodes: readonly RawNote[], have: readonly RawNote[]): Promise<{ rows: RawNote[]; missing: number }> {
  // a run in a home is on the screen, but its task may still say which project it belongs to
  const read = workFrom({ nodes, runs, tasks: have, rooms: hubRooms });
  const homes = new Set(read.projects.filter(isHome).map((p) => p.id));
  const placed = new Set(read.sessions.filter((x) => !homes.has(x.project)).map((x) => x.id));
  const known = new Set(have.map((t) => taskIdIn(t.path)));
  const want = new Map<string, number>();
  for (const r of runs) {
    const t = (r.metadata as Record<string, unknown> | undefined)?.task;
    // (a task field may hold words after its number)
    const id = typeof t === "string" ? (/\bT-\d+[a-z]?\b/i.exec(t)?.[0] ?? t).toUpperCase() : null;
    if (id && !known.has(id) && !placed.has(r.id as string)) want.set(id, (want.get(id) ?? 0) + 1);
  }
  if (!want.size) return { rows: [], missing: 0 };
  const count = (ids: Iterable<string>) => [...ids].reduce((n, id) => n + (want.get(id) ?? 0), 0);
  let paths: { id: string; path: string }[];
  try { paths = await invoke<{ id: string; path: string }[]>("vault_paths", { vault }); } catch { return { rows: [], missing: count(want.keys()) }; }
  const at = new Map<string, string>();
  for (const p of paths) { const id = taskIdIn(p.path); if (id && want.has(id) && !at.has(id)) at.set(id, p.id); }
  const ids = [...at.keys()];
  const got = await Promise.all(ids.slice(0, FILL_MAX).map((id) => invoke<{ note: RawNote }>("vault_note", { vault, noteRef: at.get(id) }).then((r) => r?.note ?? null, () => null)));
  const rows = got.filter((n): n is RawNote => !!n);
  const found = new Set(rows.map((n) => taskIdIn(n.path)));
  return { rows, missing: count(ids.filter((id) => !found.has(id))) };
}

/** Reads the work again (one at a time; a call while a read is out waits for it). A failed read keeps what was shown and says so.
 *  `fromVault` (the default: an action, a new owner, a test): from the vault; the poller's tick passes false and shares the tick's reads. */
export function refreshWork(fromVault = true): Promise<void> {
  const vault = activeProfile().vault;
  const owner = ownerOf(identity, vault);
  if (owner !== loadedFor) adopt(owner);
  if (!owner) return Promise.resolve();
  if (inflight) return inflight;
  if (fromVault) reader.invalidate();
  const mine = generation;
  // dropped if Forget, another identity or another vault came since this read began (checked again before anything is shown or kept)
  const current = () => mine === generation && currentOwner() === owner;
  let p: Promise<void> | undefined;
  p = (async () => {
    try {
      const fresh = !tasks || Date.now() - tasks.at > TASKS_MS;
      const t0 = Date.now();
      // T-335 one reader: the nodes and the runs are the same reads the tasks and Running make in this tick (shared, one call each)
      const [nodes, runs, taskRead] = await Promise.all([
        reader.nodes(vault), reader.runs(vault),
        fresh ? reader.allTasks(vault).then((r) => ({ rows: r.rows as RawNote[], whole: r.complete }), () => ({ rows: tasks?.rows ?? [], whole: false }))
          : Promise.resolve({ rows: tasks!.rows, whole: tasks!.whole }),
      ]);
      // Forget, or another identity or vault, since this read began: its answer is not this owner's, so it is dropped
      if (!current()) return;
      let taskRows = taskRead.rows;
      let missing = 0;
      // review f97fx1ji P3: a task list longer than the pages read (or one that failed) can leave a run with no project; the tasks those
      // runs name are looked up one by one, and what still can't be found is said
      if (!taskRead.whole) {
        const fill = await fillTasks(vault, runs.rows, nodes.rows, taskRows);
        if (!current()) return;
        taskRows = [...taskRows, ...fill.rows];
        missing = fill.missing;
      }
      if (fresh || !taskRead.whole) tasks = { rows: taskRows, whole: taskRead.whole, at: fresh ? Date.now() : tasks!.at };
      const src: Sources = { nodes: nodes.rows, runs: runs.rows, tasks: taskRows };
      lastRead = src;
      const work = workFrom({ ...src, rooms: hubRooms });
      const partial = [...(nodes.complete ? [] : ["Some projects aren't loaded"]), ...runs.partial,
        ...(missing ? [`${missing} session${missing === 1 ? "" : "s"} couldn't be placed under a project`] : [])];
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
function adopt(owner: string | null, notify = true) {
  generation++;
  // another owner (identity or vault) after one: nothing read for the last one is shared with this one's reads (the first owner of a launch
  // shares what the tasks already read for it)
  if (loadedFor !== null) reader.invalidate();
  loadedFor = owner; tasks = null; inflight = null; lastRead = null;
  // T-304: a session's steps are the same owner's, and go with the work
  setFeedOwner(owner, owner ? activeProfile().vault : "");
  for (const t of later) clearTimeout(t);
  later.clear();
  const saved = owner ? readCache(owner) : null;
  state = { ...BLANK, asked: new Map(), ...(saved ? { work: freshen(saved.work), at: saved.at, partial: saved.partial } : {}) };
  if (notify) emit();
}

// Review f97fx1ji P1: the vault changes during a render (ProfileContext); the old vault's work is dropped at that moment (a read of it
// still out is then of an older generation), and the screen is told just after, outside the render.
onVaultChange(() => {
  const owner = currentOwner();
  if (owner === loadedFor) return;
  adopt(owner, false);
  queueMicrotask(() => { emit(); if (owner && users > 0 && owner === currentOwner()) void refreshWork(false); });
});

/** The app's identity (null when signed out or not read yet). Called on every change; another identity sees none of this one's work. */
export function setWorkOwner(id: string | null) {
  // the copies kept before round 3 were keyed by the vault alone: no owner can be sure they are theirs
  try { for (const k of Object.keys(localStorage)) if (/^uni\.work\.v[123]:/.test(k)) localStorage.removeItem(k); } catch { /* private storage */ }
  if (id === identity) return;
  // another identity's rooms say nothing of this one's: its own arrive from the app (rooms set before the first identity is known are its own)
  if (identity !== null) hubRooms = null;
  identity = id;
  const owner = ownerOf(id, activeProfile().vault);
  if (owner !== loadedFor) adopt(owner);
  if (owner && users > 0) void refreshWork(false);
}

/** The account's rooms, which say what a room's id on a run note is. New rooms place the last read again, at once. */
export function setWorkRooms(rooms: readonly { id: string; name: string }[] | null) {
  // the rooms list is new, and in a new order, with every message: only new ids or names place anything again
  const had = new Map((hubRooms ?? []).map((r) => [r.id, r.name]));
  const same = rooms === hubRooms || (!!rooms && !!hubRooms && rooms.length === hubRooms.length && rooms.every((r) => had.get(r.id) === r.name));
  hubRooms = rooms;
  if (same || !lastRead || !loadedFor || loadedFor !== currentOwner()) return;
  const work = workFrom({ ...lastRead, rooms });
  // the device copy too: the next launch paints from it
  writeCache(loadedFor, { work, at: state.at, partial: state.partial });
  set({ work });
}

/** Forget this device key: the device copies (every owner's), the work in memory, the pending asks, and any read still out. */
export function forgetWork() {
  reader.forget();
  identity = null;
  hubRooms = null;
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
  // (the work's own reads only are read fresh: the rest of the tick stays shared)
  for (const ms of [4000, 15000, 45000]) { const t = setTimeout(() => { later.delete(t); reader.invalidate("run", "node", "task-all"); void refreshWork(false); }, ms); later.add(t); }
}

/** "as of 10:32" when the work on screen isn't a fresh read (a failed one, or a saved copy not read again yet); null when it is fresh. */
export function asOf(s: Pick<WorkState, "at" | "error">, nowMs = Date.now()): string | null {
  if (s.at === null) return null;
  if (!s.error && nowMs - s.at <= FRESH_MS) return null;
  const d = new Date(s.at), today = new Date(nowMs).toDateString() === d.toDateString();
  return (today ? "" : `${d.toLocaleDateString(undefined, { weekday: "short" })} `) + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** What the screen sees: the work only while it is the current owner's (an identity or vault change is never shown the old one's). */
const NONE: WorkState = { ...BLANK };
const get = () => (loadedFor === currentOwner() ? state : NONE);
/** What the screen would see now (for code outside React, and the store's own test). */
export const workSnapshot = (): WorkState => get();
let users = 0;
let stopPoll: (() => void) | null = null;
let clock: ReturnType<typeof setInterval> | null = null;

/** Ages what is on screen by the clock (a session no one has heard from stops counting as working), and re-renders "as of". */
const tick = () => set({ work: freshen(state.work) });

/** The work, kept fresh while any component shows it. */
export function useWork(): WorkState {
  useEffect(() => {
    if (users++ === 0) {
      void refreshWork(false);
      // the app's one poller (and coming back to the window) reads it again
      stopPoll = reader.onPoll(() => void refreshWork(false));
      clock = setInterval(tick, CLOCK_MS);
    }
    return () => {
      if (--users === 0) {
        stopPoll?.(); stopPoll = null;
        if (clock) clearInterval(clock);
        clock = null;
      }
    };
  }, []);
  return useSyncExternalStore(subscribe, get, get);
}
