// T-278 Messages: the door, as the app reaches it. Every call is a Rust command (src-tauri, behind its `messages`
// feature: messages_*) that runs the Matrix account in crates/uni-messages; updates arrive as the Tauri event
// `messages://update`. The webview holds no Matrix token or key. This module also keeps whether the rail shows
// Messages: only once a build that has it has answered.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { asMessagesErr, OPEN_KEY, PANE_KEY, SEEN_KEY, TAB_KEY, type LinkRow, type MessageRow, type RoomRow, type Status, type Transcript, type Update } from "./messagesView.ts";

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
/** T-313: an attachment's bytes (raw IPC: an ArrayBuffer), fetched and decrypted by the core by its event. */
export const mediaBytes = (roomId: string, eventId: string) => call<ArrayBuffer>("messages_media", { roomId, eventId });
/** T-313: a voice message's words, transcribed once on the owner's box and kept by the core. */
export const transcript = (roomId: string, eventId: string) => call<Transcript>("messages_transcript", { roomId, eventId });
/** T-313: open an attachment in the app the system picks for it. */
export const openFile = (roomId: string, eventId: string) => call<null>("messages_open_file", { roomId, eventId });

// ── T-313: attachments on screen. Their bytes are kept in memory as object URLs (never in the webview's storage, since they
// are a private conversation's), a few at a time, and all dropped when the account goes. ──────────────────────────────

const MEDIA_KEEP = 40;
const MEDIA_KEEP_BYTES = 150 * 1024 * 1024;
type Kept = { url: string; size: number };
const shown = new Map<string, Kept>();
const fetching = new Map<string, Promise<string>>();
/** How many attachments hold each URL (one on screen, or playing; MessageParts' useMediaUrl): one in use is never revoked,
 * and the rest are kept within MEDIA_KEEP and MEDIA_KEEP_BYTES. Only what's on screen at once can pass those limits. */
const holding = new Map<string, number>();
let mediaEpoch = 0;
const mediaKey = (roomId: string, eventId: string) => `${roomId}\u0000${eventId}`;

/** An object URL for an attachment, typed `mime` (as the core said it may be). Asked twice, fetched once. */
export function mediaUrl(roomId: string, eventId: string, mime: string): Promise<string> {
  const key = mediaKey(roomId, eventId);
  const kept = shown.get(key);
  if (kept) { shown.delete(key); shown.set(key, kept); return Promise.resolve(kept.url); }
  const going = fetching.get(key);
  if (going) return going;
  const at = mediaEpoch;
  const p = mediaBytes(roomId, eventId).then((buf) => {
    // signed out meanwhile: these bytes were the old account's
    if (at !== mediaEpoch) throw asMessagesErr({ kind: "signed_out", message: "Signed out." });
    const url = URL.createObjectURL(new Blob([buf], { type: mime }));
    shown.set(key, { url, size: buf.byteLength });
    let total = 0;
    for (const k of shown.values()) total += k.size;
    for (const [k, v] of [...shown]) {
      if (shown.size <= MEDIA_KEEP && total <= MEDIA_KEEP_BYTES) break;
      // the oldest no longer on screen goes
      if (holding.has(k)) continue;
      shown.delete(k); total -= v.size; URL.revokeObjectURL(v.url);
    }
    return url;
  }).finally(() => { if (fetching.get(key) === p) fetching.delete(key); });
  fetching.set(key, p);
  return p;
}

/** An attachment on screen (or playing) holds its URL until it isn't (the returned function). */
export function holdMedia(roomId: string, eventId: string): () => void {
  const key = mediaKey(roomId, eventId);
  holding.set(key, (holding.get(key) ?? 0) + 1);
  let held = true;
  return () => { if (!held) return; held = false; const n = (holding.get(key) ?? 1) - 1; if (n > 0) holding.set(key, n); else holding.delete(key); };
}

const words = new Map<string, Transcript>();
const transcribing = new Map<string, Promise<Transcript>>();
/** A voice message's words: asked of the core once per session (which keeps them across restarts). */
export function wordsFor(roomId: string, eventId: string): Promise<Transcript> {
  const key = mediaKey(roomId, eventId);
  const known = words.get(key);
  if (known) return Promise.resolve(known);
  const going = transcribing.get(key);
  if (going) return going;
  const at = mediaEpoch;
  // an ask from before a sign-out mustn't remove the next account's ask for the same message
  const p: Promise<Transcript> = transcript(roomId, eventId).then((t) => { if (at === mediaEpoch) words.set(key, t); return t; })
    .finally(() => { if (transcribing.get(key) === p) transcribing.delete(key); });
  transcribing.set(key, p);
  return p;
}
export const knownWords = (roomId: string, eventId: string) => words.get(mediaKey(roomId, eventId));

/** The account went: its attachments and words leave memory too. */
export function forgetMedia() {
  mediaEpoch++;
  for (const v of shown.values()) URL.revokeObjectURL(v.url);
  shown.clear(); fetching.clear(); words.clear(); transcribing.clear(); holding.clear();
}

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
  if (!roomId) { drafts.clear(); readTo.clear(); draftEpoch++; forgetMedia(); }
}
/** The one way Messages' place for an account is dropped: Forget (forgetMessages), the Sign out button, and a sign-out from the
 * homeserver all come here, so they can't drift apart. */
export const forgetPlace = () => rememberOpen(null);
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
  forgetPlace();
  void signOut().catch(() => {});
  setSeen(false);
}
