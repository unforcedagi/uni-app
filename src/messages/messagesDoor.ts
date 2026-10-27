// T-278 Messages: the door, as the app reaches it. Every call is a Rust command (src-tauri, behind its `messages`
// feature: messages_*) that runs the Matrix account in crates/uni-messages; updates arrive as the Tauri event
// `messages://update`. The webview holds no Matrix token or key. This module also keeps whether the rail shows
// Messages: only once a build that has it has answered.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { asMessagesErr, OPEN_KEY, PANE_KEY, SEEN_KEY, TAB_KEY, type LinkRow, type MessageRow, type RoomRow, type Status, type Update } from "./messagesView.ts";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try { return await invoke<T>(cmd, args); } catch (e) { throw asMessagesErr(e); }
}

export const status = () => call<Status | null>("messages_status");
export const signIn = (homeserver: string, user: string, password: string) => call<Status>("messages_sign_in", { homeserver, user, password });
/** T-282: the Matrix door on the hub's host signs this device in (its device key, no password on the device). */
export const signInDevice = () => call<Status>("messages_sign_in_device");
/** T-282: the owner's Telegram app keys, to the door, which starts the Telegram bridge with them. */
export const telegramKeys = (apiId: string, apiHash: string) => call<null>("messages_telegram_keys", { apiId, apiHash });
export const signOut = () => call<Status>("messages_sign_out");
export const rooms = () => call<RoomRow[]>("messages_rooms");
export const openRoom = (roomId: string) => call<MessageRow[]>("messages_open", { roomId });
export const closeRoom = (roomId: string) => call<null>("messages_close", { roomId });
export const send = (roomId: string, body: string) => call<null>("messages_send", { roomId, body });
export const join = (roomId: string) => call<null>("messages_join", { roomId });
export const older = (roomId: string) => call<boolean>("messages_older", { roomId });
export const markRead = (roomId: string) => call<null>("messages_read", { roomId });

// linking accounts (T-282): each answers with the network's card; later changes arrive as `link` updates
export const links = () => call<LinkRow[]>("messages_links");
export const linkCheck = (network: string) => call<LinkRow>("messages_link_check", { network });
export const linkStart = (network: string, flow?: string, relogin?: string) => call<LinkRow>("messages_link_start", { network, flow: flow ?? null, relogin: relogin ?? null });
export const linkSend = (network: string, value: string) => call<LinkRow>("messages_link_send", { network, value });
export const linkCancel = (network: string) => call<LinkRow>("messages_link_cancel", { network });

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

/** The room open last, so leaving Messages and coming back lands in the same conversation. None (sign-out, Forget) drops the rest of
 * Messages' place too: the pane, the tab, the drafts, the spots. */
export function rememberOpen(roomId: string | null) {
  try { if (roomId) localStorage.setItem(OPEN_KEY, roomId); else { localStorage.removeItem(OPEN_KEY); localStorage.removeItem(PANE_KEY); localStorage.removeItem(TAB_KEY); } } catch { /* unavailable storage */ }
  if (!roomId) { drafts.clear(); readTo.clear(); draftEpoch++; }
}
export function lastOpen(): string | null {
  try { return localStorage.getItem(OPEN_KEY); } catch { return null; }
}

// T-294: the rest of Messages' place, for the way back from Uni's side. Whether a phone showed the conversation or the list is kept on the
// device. Each conversation's unsent draft, and how far up it was read, are kept for this session only: in memory, so nothing anyone wrote
// in a private conversation is put in the webview's storage.
export function rememberPane(pane: "list" | "thread") {
  try { localStorage.setItem(PANE_KEY, pane); } catch { /* unavailable storage */ }
}
export function lastPane(): "list" | "thread" {
  try { return localStorage.getItem(PANE_KEY) === "thread" ? "thread" : "list"; } catch { return "list"; }
}
/** T-310: the tab this device was on (All, or a network), kept on the device. */
export function rememberTab(tab: string) {
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* unavailable storage */ }
}
export function lastTab(): string | null {
  try { return localStorage.getItem(TAB_KEY); } catch { return null; }
}
const drafts = new Map<string, string>();
/** T-302 review f97fx1ji: bumped by sign-out and Forget (rememberOpen(null)). A send begun before them that fails after can't put its
 *  words back: the drafts belong to the account that was signed in, and the next account may open the same room. */
let draftEpoch = 0;
export const draftsEpoch = () => draftEpoch;
export const draftFor = (roomId: string): string => drafts.get(roomId) ?? "";
export function keepDraft(roomId: string, text: string) { if (text) drafts.set(roomId, text); else drafts.delete(roomId); }
/** A send that failed gives its words back to the conversation's draft (unless something new is there), only if the account it was
 *  sent from is still the one here (`at`: draftsEpoch() when it was sent). Returns whether it did. */
export function unsentBack(roomId: string, body: string, at: number): boolean {
  if (at !== draftEpoch) return false;
  if (!draftFor(roomId).trim()) keepDraft(roomId, body);
  return true;
}
/** Where a conversation was left: the first message in sight, and how far below the top it was (px); none at its end. */
export type ReadSpot = { key: string; offset: number };
const readTo = new Map<string, ReadSpot>();
export const readSpot = (roomId: string): ReadSpot | undefined => readTo.get(roomId);
export function keepReadSpot(roomId: string, spot: ReadSpot | null) { if (!spot) readTo.delete(roomId); else readTo.set(roomId, spot); }

/** Forgetting the device key signs Messages out too: the homeserver drops this device, and its store and session
 * here are deleted. A build without Messages has no such command, and nothing to sign out. */
export function forgetMessages() {
  rememberOpen(null);
  void signOut().catch(() => {});
  setSeen(false);
}
