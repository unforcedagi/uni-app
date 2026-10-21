// T-229 Calendar: the door, as the app reaches it. Every call is a Rust command (src-tauri: cal_*) that signs it with
// the device key; the webview holds no token. This module also keeps whether the rail shows Calendar (only once the
// door has answered on this device) and the offline snapshot.
import { invoke } from "@tauri-apps/api/core";
import type { DoorInstance, EventNote } from "./calCore.ts";
import { asCalErr, FALLBACK_SESSION, parseSnapshot, remember, SEEN_KEY, SNAPSHOT_KEY, type CalErr, type Session, type Snapshot } from "./calView.ts";

export type Conflict = { id: string; event_id: string; title: string; adapter: string; created?: string;
  vault: { start: string; end: string; title?: string; location?: string | null; status?: string };
  outside: { start: string; end: string; title?: string; location?: string | null; status?: string } };
export type OpAnswer = { ok: boolean; opId: string; id?: string; rev?: number; state?: string };

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try { return await invoke<T>(cmd, args); } catch (e) { throw asCalErr(e); }
}

/** The key's session; a door without the session route (404) is read with [`FALLBACK_SESSION`] if it lists events. */
export async function session(probeFrom: string, probeTo: string): Promise<Session> {
  try {
    const s = await call<Session>("cal_session");
    return { role: String(s.role ?? "unknown"), ops: Array.isArray(s.ops) ? s.ops.map(String) : [], calendar: s.calendar, tz: s.tz };
  } catch (e) {
    const err = e as CalErr;
    if (err.kind !== "refused" || err.status !== 404) throw err;
    await call("cal_events", { from: probeFrom, to: probeTo });
    return FALLBACK_SESSION;
  }
}

export const events = (from: string, to: string) => call<{ complete?: boolean; instances: DoorInstance[] }>("cal_events", { from, to });
export const event = (id: string) => call<EventNote & { ics?: string }>("cal_event", { id });
export const conflicts = () => call<{ conflicts: Conflict[] }>("cal_conflicts");
export const op = (o: Record<string, unknown>) => call<OpAnswer>("cal_op", { op: o });

// ── whether the rail shows Calendar ─────────────────────────────────────────────────────────────────────────────────

const subs = new Set<() => void>();
let seen = (() => { try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return false; } })();

export const calShown = () => seen;
export function onCalShown(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }

function setSeen(v: boolean) {
  if (v === seen) return;
  seen = v;
  try { if (v) localStorage.setItem(SEEN_KEY, "1"); else localStorage.removeItem(SEEN_KEY); } catch { /* unavailable storage */ }
  for (const f of subs) f();
}

/** The door answered this key: show the place. */
export const doorAnswered = () => setSeen(true);

/**
 * Ask the door whether it takes this key. It answered: Calendar shows. It refused the key, or there is no door: it
 * hides. It can't be reached: as it was (an offline Calendar still shows its snapshot).
 */
export async function probeCalendar(from: string, to: string): Promise<void> {
  try {
    await session(from, to);
    setSeen(true);
  } catch (e) {
    const err = e as CalErr;
    if (err.kind === "not_allowed" || err.kind === "refused" || err.kind === "invalid") setSeen(false);
  }
}

// ── the snapshot ────────────────────────────────────────────────────────────────────────────────────────────────────

export function readSnapshot(): Snapshot | null {
  try { return parseSnapshot(localStorage.getItem(SNAPSHOT_KEY)); } catch { return null; }
}

export function saveRead(from: string, to: string, instances: DoorInstance[], s: Session | null) {
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(remember(readSnapshot(), { from, to, instances }, new Date().toISOString(), s))); } catch { /* full or unavailable */ }
}

/** Forgetting the device key forgets what this device read of the calendar. */
export function forgetCalendar() {
  try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* unavailable storage */ }
  setSeen(false);
}
