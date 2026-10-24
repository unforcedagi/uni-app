// T-278 Messages: the door, as the app reaches it. Every call is a Rust command (src-tauri, behind its `messages`
// feature: messages_*) that runs the Matrix account in crates/uni-messages; updates arrive as the Tauri event
// `messages://update`. The webview holds no Matrix token or key. This module also keeps whether the rail shows
// Messages: only once a build that has it has answered.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { asMessagesErr, OPEN_KEY, SEEN_KEY, type MessageRow, type RoomRow, type Status, type Update } from "./messagesView.ts";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try { return await invoke<T>(cmd, args); } catch (e) { throw asMessagesErr(e); }
}

export const status = () => call<Status | null>("messages_status");
export const signIn = (homeserver: string, user: string, password: string) => call<Status>("messages_sign_in", { homeserver, user, password });
export const signOut = () => call<Status>("messages_sign_out");
export const rooms = () => call<RoomRow[]>("messages_rooms");
export const openRoom = (roomId: string) => call<MessageRow[]>("messages_open", { roomId });
export const closeRoom = (roomId: string) => call<null>("messages_close", { roomId });
export const send = (roomId: string, body: string) => call<null>("messages_send", { roomId, body });
export const join = (roomId: string) => call<null>("messages_join", { roomId });
export const older = (roomId: string) => call<boolean>("messages_older", { roomId });
export const markRead = (roomId: string) => call<null>("messages_read", { roomId });

/** Live updates: the room list, the open room's messages, the sync's status. */
export function onUpdate(f: (u: Update) => void): () => void {
  let off: (() => void) | null = null;
  let gone = false;
  void listen<Update>("messages://update", (e) => f(e.payload)).then((u) => { if (gone) u(); else off = u; }).catch(() => {});
  return () => { gone = true; off?.(); };
}

// ── whether the rail shows Messages ─────────────────────────────────────────────────────────────────────────────────

const subs = new Set<() => void>();
let seen = (() => { try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return false; } })();

export const messagesShown = () => seen;
export function onMessagesShown(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }

function setSeen(v: boolean) {
  if (v === seen) return;
  seen = v;
  try { if (v) localStorage.setItem(SEEN_KEY, "1"); else localStorage.removeItem(SEEN_KEY); } catch { /* unavailable storage */ }
  for (const f of subs) f();
}

/** A build with Messages answers `messages_status`, so Messages shows. A build without it has no such command (or a
 * test double answers nothing), so it hides. Any other failure leaves the rail as it was, so a store that won't
 * reopen still leaves the way in to sign in again. */
export async function probeMessages(): Promise<void> {
  try {
    const s = await status();
    setSeen(!!s && typeof s === "object" && typeof s.state === "string");
  } catch (e) {
    if (/not found|unknown command|no such command/i.test(asMessagesErr(e).message)) setSeen(false);
  }
}

/** The room open last, so leaving Messages and coming back lands in the same conversation. */
export function rememberOpen(roomId: string | null) {
  try { if (roomId) localStorage.setItem(OPEN_KEY, roomId); else localStorage.removeItem(OPEN_KEY); } catch { /* unavailable storage */ }
}
export function lastOpen(): string | null {
  try { return localStorage.getItem(OPEN_KEY); } catch { return null; }
}

/** Forgetting the device key signs Messages out too: the homeserver drops this device, and its store and session
 * here are deleted. A build without Messages has no such command, and nothing to sign out. */
export function forgetMessages() {
  rememberOpen(null);
  void signOut().catch(() => {});
  setSeen(false);
}
