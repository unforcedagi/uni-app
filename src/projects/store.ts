// T-302: the projects and sessions the app shows, read from the vault the app already reads (the same signed door as every note:
// `vault_query`), and what a person has asked the room to do to them. Nothing here changes a session: an action is a message in the
// room (actions.ts); this store only remembers that it was asked, until the run notes say it happened.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import { activeProfile } from "../areas/profile";
import type { RawNote } from "../areas/taskCore";
import { allPages } from "../areas/vaultTasks";
import { workFrom, type LiveWork, type Sources } from "./live";
import type { Action } from "./actions";

export type Asked = { kind: Action["kind"]; at: number; state: string | null };
export type WorkState = { work: LiveWork; ready: boolean; error: string | null; at: number | null; asked: ReadonlyMap<string, Asked> };

const EMPTY: LiveWork = { areas: [], projects: [], sessions: [], gaps: [] };
/** How often the work is read again while something shows it (and the window is visible). */
export const REFRESH_MS = 30_000;
/** Tasks change slowly and only name sessions: read at most this often. */
const TASKS_MS = 5 * 60_000;
/** "Asked the room" stays this long at most, if the run notes never show the change. */
const ASKED_MS = 15 * 60_000;
/** The device keeps the last read's sessions from this far back (all live ones), so a cold start paints at once. */
const KEEP_MS = 30 * 86_400_000;

let state: WorkState = { work: EMPTY, ready: false, error: null, at: null, asked: new Map() };
const listeners = new Set<() => void>();
const set = (next: Partial<WorkState>) => { state = { ...state, ...next }; for (const l of listeners) l(); };
let tasks: { rows: RawNote[]; at: number } | null = null;
let inflight: Promise<void> | null = null;
let loadedFor: string | null = null;

const cacheKey = (vault: string) => `uni.work.v1:${vault}`;
function readCache(vault: string): LiveWork | null {
  try { const w = JSON.parse(localStorage.getItem(cacheKey(vault)) ?? "null"); return w && Array.isArray(w.areas) && Array.isArray(w.projects) && Array.isArray(w.sessions) ? { gaps: [], ...w } : null; } catch { return null; }
}
function writeCache(vault: string, w: LiveWork) {
  const floor = Date.now() - KEEP_MS;
  try { localStorage.setItem(cacheKey(vault), JSON.stringify({ ...w, sessions: w.sessions.filter((s) => s.state === "running" || (s.endedAt ?? 0) >= floor) })); } catch { /* storage full or off: this session only */ }
}

const page = (vault: string, tag: string) => (offset: number) => invoke("vault_query", { vault, tag, includeContent: false, limit: 200, ...(offset ? { offset } : {}) }) as Promise<RawNote[]>;

/** Reads the work again (one at a time; a call while a read is out waits for it). A failed read keeps what was shown and says so. */
export function refreshWork(): Promise<void> {
  if (inflight) return inflight;
  const vault = activeProfile().vault;
  if (loadedFor !== vault) {
    loadedFor = vault; tasks = null;
    set({ work: readCache(vault) ?? EMPTY, ready: false, error: null, at: null });
  }
  inflight = (async () => {
    try {
      const fresh = !tasks || Date.now() - tasks.at > TASKS_MS;
      const [nodes, runs, taskRows] = await Promise.all([
        allPages(page(vault, "node")), allPages(page(vault, "run")),
        fresh ? allPages(page(vault, "task")).then((r) => r.rows).catch(() => tasks?.rows ?? []) : Promise.resolve(tasks!.rows),
      ]);
      if (fresh) tasks = { rows: taskRows, at: Date.now() };
      const src: Sources = { nodes: nodes.rows, runs: runs.rows, tasks: taskRows };
      const work = workFrom(src);
      writeCache(vault, work);
      set({ work, ready: true, error: null, at: Date.now(), asked: settle(state.asked, work) });
    } catch (e) {
      set({ error: String(e), ready: state.ready || state.work.areas.length > 0 });
    } finally { inflight = null; }
  })();
  return inflight;
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
  const s = w.sessions.find((x) => x.id === key);
  if (s) return s.state;
  const p = w.projects.find((x) => x.id === key);
  return p ? `${p.status}:${w.sessions.filter((x) => x.project === p.id).length}` : null;
}

/** Remembers that the room was asked (shown as "Asked the room" on the session or project), and reads again soon after. */
export function noteAsked(key: string, kind: Action["kind"]) {
  const asked = new Map(state.asked);
  asked.set(key, { kind, at: Date.now(), state: now(key, state.work) });
  set({ asked });
  for (const ms of [4000, 15000, 45000]) setTimeout(() => void refreshWork(), ms);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const get = () => state;
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const onVisible = () => { if (document.visibilityState === "visible" && (!state.at || Date.now() - state.at > REFRESH_MS / 2)) void refreshWork(); };

/** The work, kept fresh while any component shows it. */
export function useWork(): WorkState {
  useEffect(() => {
    if (users++ === 0) {
      void refreshWork();
      timer = setInterval(() => { if (document.visibilityState === "visible") void refreshWork(); }, REFRESH_MS);
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("focus", onVisible);
    }
    return () => {
      if (--users === 0) {
        if (timer) clearInterval(timer);
        timer = null;
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("focus", onVisible);
      }
    };
  }, []);
  return useSyncExternalStore(subscribe, get, get);
}
