import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { copyText, onCopied } from "./clipboard";
import { markFor, restoreTop, type ScrollMark } from "./noteText";
import "./App.css";
import { markdownToText } from "./markdown";
import { Body } from "./MessageBody";
import Pairing from "./Pairing";
import { emojiLabel, toggleLocal, type Reaction } from "./reactions";
import { DeleteButton, InlineEditor } from "./InlineEditor";
import { lastOwnMessage } from "./ownMessages";

import { approvalOpen, parseApproval } from "./approvals";
import { findUniMember, findUniRoom, handoffText, searchHandoffText, type UniAction } from "./uniActions";
import Search from "./Search";
import Journal from "./Journal";
import { mmss, newDraft, shareText, type JournalNote } from "./journalCore";
import { useRecorder, voiceFileName } from "./recorder";
import { notifyMention, setUnreadBadge } from "./desktopNotify";
import NoteView from "./NoteView";
import { NoteOpener } from "./noteLinks";
import { sameHub, type VaultRef } from "./vaultlinks";
import { attachmentKind, collectAttachments, formatSize, stripAttachmentLines } from "./media";
import { Attachments, attachmentBody, useRelayOrigin, type MediaRef } from "./Attachments";
import { activeQuery, filterMembers, insertMention, memberLabels, pruneBindings, resolveRecipients, type Bindings, type Member } from "./mentions";

type Room = { id: string; name: string; last_message: string | null; last_ts: number | null; mentions: boolean; unread: number };
type Message = { ref: string; channel: string; author: string; author_name: string; ts: number; body: string; mentions_me: boolean; root: string | null; parent: string | null; mentions: Member[]; reply_count: number; last_reply_ts: number | null; edited: boolean; reactions: Reaction[]; media?: MediaRef[] };
type LivePayload = { kind: "message" | "edit" | "delete" | "rooms" | "profiles" | "status" | "typing"; channel: string | null; status: string | null; author: string | null; root?: string | null; notify?: { author_name: string; preview: string } };
/** Buzz desktop: an indicator lives 8 s; send at most one every 3 s. */
const TYPING_TTL_MS = 8000;
const TYPING_SEND_MS = 3000;
type IdentityStatus = { paired: boolean; pubkey: string | null };
type SyncResult = { pubkey: string; total_items: number; channel_errors: Record<string, string>; truncated_channels: string[] };

type PendingFile = { id: string; file: File; preview: string | null; state: "uploading" | "ready" | "error"; media?: MediaRef; error?: string; voice?: "transcribing" | "done" | "failed" };
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;

const time = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const HEX_KEY = /^[0-9a-f]{64}$/i;
const keyFor = (channel: string, root: string | null) => `${channel}:${root ?? "room"}`;
const QUICK_REACTIONS = ["👍", "❤️", "😂", "🙏", "🔥", "✦"];
const dayKey = (ts: number) => new Date(ts * 1000).toDateString();
function dayLabel(ts: number) {
  const d = new Date(ts * 1000), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
// Stable per-author hue for letter avatars.
const hue = (pk: string) => parseInt(pk.slice(0, 6), 16) % 360;


function App() {
  const [paired, setPaired] = useState<boolean | null>(null);
  useEffect(() => {
    invoke<IdentityStatus>("identity_status").then((s) => setPaired(s.paired)).catch(() => setPaired(false));
  }, []);
  if (paired === null) return <main className="pairing"><p className="empty">Loading…</p></main>;
  if (!paired) return <Pairing onPaired={() => setPaired(true)} />;
  return <Conversations onForget={() => setPaired(false)} />;
}


type Picker = { start: number; query: string; index: number };

function Conversations({ onForget }: { onForget: () => void }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [channel, setChannel] = useState<string | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [identity, setIdentity] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const drafts = useRef(new Map<string, string>());
  const [pending, setPending] = useState<PendingFile[]>([]);
  const pendingStore = useRef(new Map<string, PendingFile[]>());
  const activeScope = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => {
    for (const files of pendingStore.current.values()) for (const item of files) if (item.preview) URL.revokeObjectURL(item.preview);
  }, []);
  const [bindings, setBindings] = useState<Bindings>(new Map());
  const bindingStore = useRef(new Map<string, Bindings>());
  const [picker, setPicker] = useState<Picker | null>(null);
  const [rawKey, setRawKey] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("Loading cached conversations…");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [forgetArmed, setForgetArmed] = useState(false);
  const [live, setLive] = useState<string | null>(null);
  // Bumped by live events so the open room re-reads from the local store.
  const [tick, setTick] = useState(0);
  // Bumped after each successful sync so the open room and roster re-read.
  const [synced, setSynced] = useState(0);
  const busyRef = useRef(false);
  const [limit, setLimit] = useState(300);
  const relayOrigin = useRelayOrigin();
  const [older, setOlder] = useState<"idle" | "loading" | "done">("idle");
  const [reactFor, setReactFor] = useState<string | null>(null);
  // Our own message currently open in the inline editor.
  const [editing, setEditing] = useState<string | null>(null);
  // Messages handed to Uni as notes this session (a local receipt).
  const [kept, setKept] = useState<Set<string>>(new Set());
  // Approval prompts answered from this device: message ref -> reply sent.
  const [answered, setAnswered] = useState<Map<string, string>>(new Map());
  // Latest bindings for syncPicker (called in the same tick as setBindings).
  const bindingsRef = useRef<Bindings>(new Map());
  // Message actions go through a ref so the memoized list never holds stale closures.
  useEffect(() => { bindingsRef.current = bindings; }, [bindings]);
  const actions = useRef({ react: (_m: Message, _e: string) => {}, toUni: (_m: Message, _a: UniAction) => {}, openThread: (_m: Message) => {}, reply: (_id: string) => {}, loadOlder: () => {}, saveEdit: (_m: Message, _b: string): Promise<void> => Promise.resolve(), cancelEdit: () => {}, deleteOwn: (_m: Message): Promise<void> => Promise.resolve(), answer: (_m: Message, _reply: string) => {}, keepVoice: (_m: Message, _a: MediaRef) => {} });

  const [searchOpen, setSearchOpen] = useState(false);
  // Search result to scroll to and flash once its room/thread has loaded.
  const [focusRef, setFocusRef] = useState<string | null>(null);
  const [journalOpen, setJournalOpen] = useState(false);
  const [npub, setNpub] = useState<string | null>(null);
  const [myName, setMyName] = useState<string | null>(null);
  // Who is typing where: "channel|root" -> author -> expiry (ms).
  const [typing, setTyping] = useState<Map<string, Map<string, number>>>(new Map());
  const lastTypingSent = useRef(0);
  // Vault notes opened from message links; the top of the stack is shown over
  // whatever was open (room, thread or Journal) and Back pops it.
  const [notes, setNotes] = useState<VaultRef[]>([]);
  const [hub, setHub] = useState<string | null>(null);
  useEffect(() => { invoke<{ hub: string }>("journal_config").then((c) => setHub(c.hub)).catch(() => {}); }, []);
  const openNote = useCallback((ref: VaultRef, href: string | null) => {
    // A note on some other hub isn't readable with this key: let the browser
    // (and that hub's Parachute app) handle it.
    if (!sameHub(ref, hub)) { if (href) void invoke("open_link", { url: href }).catch(() => {}); return; }
    setNotes((s) => {
      const top = s[s.length - 1];
      if (top && top.vault === ref.vault && top.ref === ref.ref) return s;
      return [...s.slice(-19), { hub: null, vault: ref.vault, ref: ref.ref }];
    });
  }, [hub]);
  const closeNote = useCallback(() => setNotes((s) => s.slice(0, -1)), []);
  // Loaded note titles, so a nested note's Back reads "← <previous note>".
  const [noteTitles, setNoteTitles] = useState<Record<string, string>>({});
  const noteKey = (r: VaultRef) => `${r.vault}:${r.ref}`;
  const rememberTitle = useCallback((key: string, t: string) => setNoteTitles((m) => m[key] === t ? m : { ...m, [key]: t }), []);
  // "Copied" confirmation.
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onCopied((msg) => { setToast(msg); clearTimeout(t); t = setTimeout(() => setToast(null), 1600); });
    return () => { off(); clearTimeout(t); };
  }, []);
  const focusTries = useRef(0);
  const preserveScroll = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Scroll memory per room/thread. The list element is recreated whenever the
  // room view remounts (Journal, welcome pane, narrow-screen back), so each
  // new element and each newly loaded view is restored once its own messages
  // are in: the saved spot, or the newest message when there is none.
  const scrollMemory = useRef(new Map<string, ScrollMark>());
  const restoredView = useRef<string | null>(null);
  // Following the newest message: content growth (images, late layout) keeps it pinned.
  const stickToEnd = useRef(true);
  const [loadedView, setLoadedView] = useState<string | null>(null);
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const setList = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
    restoredView.current = null;
    setListEl(el);
  }, []);
  const [stackEl, setStackEl] = useState<HTMLDivElement | null>(null);
  const channelRef = useRef<string | null>(null);
  const roomsRef = useRef<Room[]>([]);
  channelRef.current = channel;
  const scrollEnd = useRef<HTMLDivElement>(null);
  const shownView = useRef<string | null>(null);
  // Uni is notified on every message in rooms it belongs to, unless muted.
  const [notifyUni, setNotifyUni] = useState(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const focusComposer = useRef(false);

  const loadRooms = useCallback(async () => {
    const rows = await invoke<Room[]>("get_rooms");
    setRooms(rows);
    roomsRef.current = rows;
    setUnreadBadge(rows.reduce((n, r) => n + (r.unread || 0), 0));
    setChannel((current) => current && rows.some((r) => r.id === current) ? current : rows[0]?.id ?? null);
    setReady(true);
  }, []);

  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setStatus("Connecting to Buzz…");
    setError(null);
    try {
      const result = await invoke<SyncResult>("refresh");
      setIdentity(result.pubkey);
      await loadRooms();
      const warnings = Object.entries(result.channel_errors).map(([id, reason]) => `${id.slice(0, 8)}: ${reason}`);
      if (result.truncated_channels.length) warnings.push("Some rooms have more history than the current 500-message backfill.");
      setStatus(warnings.length ? `Synced with warnings: ${warnings.join("; ")}` : `Synced · ${result.total_items} cached messages`);
      setSynced((n) => n + 1);
      // Keep the socket open for push while we're in the foreground.
      invoke<boolean>("live_start").catch((e) => setLive(`Live unavailable: ${e}`));
    } catch (e) {
      setError(String(e));
      setStatus("Offline · showing cached messages");
    } finally { busyRef.current = false; setBusy(false); }
  }, [loadRooms]);

  useEffect(() => {
    let active = true;
    invoke<string>("get_identity").then((id) => { if (active) setIdentity(id); }).catch(() => {});
    loadRooms().then(() => { if (active) void refresh(); }).catch((e) => {
      if (active) { setError(String(e)); setStatus("Could not open local conversations"); setReady(true); }
    });
    return () => { active = false; };
    // Start only once; later refreshes are explicit or visibility-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
      else { void invoke("live_stop").catch(() => {}); setLive(null); }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  useEffect(() => {
    if (!identity) return;
    invoke<string>("get_npub").then(setNpub).catch(() => {});
  }, [identity]);
  useEffect(() => {
    const me = members.find((m) => m.pubkey === identity);
    if (me?.named && me.name) setMyName(me.name);
  }, [members, identity]);

  // Expire typing indicators.
  useEffect(() => {
    const t = window.setInterval(() => setTyping((old) => {
      const now = Date.now(); let changed = false; const next = new Map<string, Map<string, number>>();
      for (const [k, m] of old) { const live = new Map([...m].filter(([, exp]) => exp > now)); if (live.size !== m.size) changed = true; if (live.size) next.set(k, live); else changed = true; }
      return changed ? next : old;
    }), 1000);
    return () => clearInterval(t);
  }, []);

  // Live push: re-read rooms (unread badges, previews) and the open room.
  useEffect(() => {
    const un = listen<LivePayload>("uni://live", (e) => {
      const p = e.payload;
      if (p.kind === "status") { setLive(p.status); return; }
      if (p.kind === "typing") {
        if (!p.channel || !p.author) return;
        const where = `${p.channel}|${p.root ?? ""}`;
        const author = p.author;
        setTyping((old) => { const next = new Map(old); const m = new Map(next.get(where) ?? []); m.set(author, Date.now() + TYPING_TTL_MS); next.set(where, m); return next; });
        return;
      }
      if (p.kind === "message" && p.notify && p.channel) {
        const room = roomsRef.current.find((r) => r.id === p.channel)?.name ?? "room";
        void notifyMention({ author: p.notify.author_name, room, preview: p.notify.preview, looking: document.hasFocus() && p.channel === channelRef.current });
      }
      // A message from someone ends their typing indicator in that room.
      if (p.kind === "message" && p.channel && p.author) {
        const ch = p.channel, author = p.author;
        setTyping((old) => { let hit = false; const next = new Map(old); for (const [k, m] of next) if (k.startsWith(`${ch}|`) && m.has(author)) { const c = new Map(m); c.delete(author); next.set(k, c); hit = true; } return hit ? next : old; });
      }
      void loadRooms().catch(() => {});
      if (p.kind === "profiles" || !p.channel || p.channel === channelRef.current) setTick((n) => n + 1);
    });
    return () => { void un.then((f) => f()); };
  }, [loadRooms]);

  useEffect(() => {
    if (!channel) { setMessages([]); setLoadedView(null); return; }
    let current = true;
    const view = `${channel}|${root}`;
    invoke<Message[]>("get_messages", { channel, root, limit }).then((rows) => { if (current) { setMessages(rows); setLoadedView(view); } }).catch((e) => { if (current) setError(String(e)); });
    // Viewing the room reads it (only while the app is actually on screen).
    if (document.visibilityState === "visible") {
      invoke("mark_read", { channel }).then(() => loadRooms()).catch(() => {});
    }
    return () => { current = false; };
  }, [channel, root, synced, tick, limit, loadRooms]);

  // New room: back to the default window; older pages load on demand.
  useEffect(() => { setLimit(300); setOlder("idle"); setReactFor(null); setEditing(null); }, [channel]);

  useEffect(() => {
    if (!channel) { setMembers([]); return; }
    let current = true;
    invoke<Member[]>("get_members", { channel }).then((rows) => { if (current) setMembers(rows); }).catch(() => { if (current) setMembers([]); });
    return () => { current = false; };
  }, [channel, synced]);

  // Restore a (re)opened list once this view's own messages are rendered:
  // the remembered spot, or the newest message. Runs before paint, so the
  // list never flashes at the top.
  const currentView = channel ? `${channel}|${root}` : null;
  useLayoutEffect(() => {
    const el = listEl;
    if (!el || !currentView || loadedView !== currentView || restoredView.current === currentView) return;
    const saved = scrollMemory.current.get(currentView);
    el.scrollTop = restoreTop(saved, el.scrollHeight, el.clientHeight);
    stickToEnd.current = !saved || saved.atEnd;
    restoredView.current = currentView;
    shownView.current = currentView;
  }, [listEl, currentView, loadedView, messages]);

  // Remember where the reader is, per view (only once that view is restored,
  // so a half-swapped list never overwrites a good mark).
  const gliding = useRef(0);
  useEffect(() => {
    const el = listEl;
    if (!el) return;
    const onScroll = () => {
      const v = restoredView.current;
      if (!v || Date.now() < gliding.current) return;
      const mark = markFor(el.scrollTop, el.scrollHeight, el.clientHeight);
      scrollMemory.current.set(v, mark);
      stickToEnd.current = mark.atEnd;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [listEl]);

  // Images, fonts and embeds settle after first paint: while following the
  // newest message, stay pinned to the end as the content grows.
  useEffect(() => {
    if (!listEl || !stackEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stickToEnd.current && restoredView.current && preserveScroll.current === null) listEl.scrollTop = listEl.scrollHeight;
    });
    ro.observe(stackEl);
    return () => ro.disconnect();
  }, [listEl, stackEl]);

  useEffect(() => {
    // After prepending older history, keep the reader where they were.
    if (preserveScroll.current !== null && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight - preserveScroll.current;
      preserveScroll.current = null;
      return;
    }
    // A search jump positions the list itself (below).
    if (focusRef || !listRef.current) return;
    // Only new messages in the view you're already reading (and following) glide in.
    if (!currentView || restoredView.current !== currentView || loadedView !== currentView || !stickToEnd.current) return;
    gliding.current = Date.now() + 700;
    scrollEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  // Jump to a search hit: once its room/thread is rendered, center and flash
  // it. If it is older than the loaded window, widen the window once.
  useEffect(() => {
    if (!focusRef) return;
    // Wait until the list shows the target room (and thread), not the last one.
    if (!messages.length || messages[0].channel !== channel) return;
    if (root && !messages.some((m) => m.ref === root || m.root === root)) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-ref="${CSS.escape(focusRef)}"]`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      const t = setTimeout(() => setFocusRef(null), 2500);
      return () => clearTimeout(t);
    }
    if (focusTries.current++ === 0 && !root) { setLimit((l) => Math.max(l, 3000)); return; }
    setFocusRef(null);
    setStatus("That message isn't in the loaded history of this room");
  }, [focusRef, messages, channel, root]);

  function openHit(t: { channel: string; root: string | null; focus: string }) {
    setSearchOpen(false);
    focusTries.current = 0;
    navigate(t.channel, t.root);
    setFocusRef(t.focus);
  }

  // Notes search runs on Uni's side (the app holds no vault token).
  async function askUniSearch(query: string): Promise<boolean> {
    setError(null);
    const uniRoom = findUniRoom(rooms);
    if (!uniRoom) { setError("No room named Uni is joined. Refresh, or join #Uni in Buzz."); return false; }
    try {
      const roster = await invoke<Member[]>("get_members", { channel: uniRoom.id });
      const uni = findUniMember(roster);
      if (!uni) { setError("Uni isn't in the Uni room's member list yet. Refresh to load it."); return false; }
      const label = memberLabels(roster).get(uni.pubkey) ?? uni.name;
      await invoke<Message>("post_message", { channel: uniRoom.id, body: searchHandoffText(query, label), replyTo: null, recipients: [uni.pubkey] });
      setStatus("Asked Uni · results will arrive in #Uni");
      setTick((n) => n + 1);
      await loadRooms();
      return true;
    } catch (e) { setError(`Couldn't reach Uni: ${e}`); return false; }
  }

  async function loadOlder() {
    if (!channel || older === "loading") return;
    const ch = channel;
    setOlder("loading");
    try {
      const n = await invoke<number>("load_older", { channel: ch });
      // The room changed while loading: its own reset already ran.
      if (channelRef.current !== ch) return;
      if (n === 0) { setOlder("done"); return; }
      if (listRef.current) preserveScroll.current = listRef.current.scrollHeight - listRef.current.scrollTop;
      setOlder("idle");
      setLimit((l) => l + n + 50);
    } catch (e) { if (channelRef.current === ch) { setError(String(e)); setOlder("idle"); } }
  }

  // Hand a message to Uni: "note" posts straight to the Uni room (Uni files it
  // in Parachute and replies with where it went); "ask" opens the Uni room
  // with the quote drafted so Aaron can add his question first.
  // A voice message goes straight to the vault: transcript plus the audio
  // link, no round trip through Uni.
  async function keepVoice(m: Message, audio: MediaRef) {
    setError(null);
    setStatus("Saving voice note…");
    try {
      const roomName = rooms.find((r) => r.id === m.channel)?.name ?? "room";
      const when = new Date(m.ts * 1000);
      const transcript = stripAttachmentLines(m.body, [audio]).trim();
      const content = `Voice message from ${m.author_name} in #${roomName}, ${when.toLocaleString()}\n\n${transcript || "(no transcript)"}\n\n[Audio](${audio.url})`;
      const draft = newDraft(content, "text");
      const r = await invoke<{ sent: string[]; remaining: number; error: string | null }>("journal_save_text", { entry: draft });
      if (!r.sent.includes(draft.entry_id)) { setKept((k) => new Set(k).add(m.ref)); setStatus(`Queued for your vault; it will save when reachable${r.error ? ` (${r.error})` : ""}`); return; }
      setKept((k) => new Set(k).add(m.ref));
      setStatus("Kept as a note in your vault");
    } catch (e) {
      setError(`Couldn't save the note: ${String(e)}`);
    }
  }
  async function toUni(m: Message, action: UniAction) {
    setError(null);
    const uniRoom = findUniRoom(rooms);
    if (!uniRoom) { setError("No room named Uni is joined. Refresh, or join #Uni in Buzz."); return; }
    try {
      const roster = await invoke<Member[]>("get_members", { channel: uniRoom.id });
      const uni = findUniMember(roster);
      if (!uni) { setError("Uni isn't in the Uni room's member list yet. Refresh to load it."); return; }
      const label = memberLabels(roster).get(uni.pubkey) ?? uni.name;
      const roomName = rooms.find((r) => r.id === m.channel)?.name ?? "room";
      if (action === "note") {
        setStatus("Handing to Uni…");
        await invoke<Message>("post_message", { channel: uniRoom.id, body: handoffText("note", m, roomName, label), replyTo: null, recipients: [uni.pubkey] });
        setKept((k) => new Set(k).add(m.ref));
        setStatus("Sent to Uni · it will file the note and reply in #Uni");
        setTick((n) => n + 1);
        await loadRooms();
      } else {
        const text = handoffText("ask", m, roomName, label, " ");
        navigate(uniRoom.id, null);
        // Replace navigate's restored draft: question goes after "@Uni ".
        const prefix = `@${label} `;
        setDraft(prefix + "\n\n" + text.slice(text.indexOf("\n\n") + 2));
        setBindings(new Map([[label, uni.pubkey]]));
        focusComposer.current = true;
        setTimeout(() => { input.current?.focus(); input.current?.setSelectionRange(prefix.length, prefix.length); }, 50);
      }
    } catch (e) { setError(`Couldn't reach Uni: ${e}`); setStatus("Handoff failed · your message is unchanged"); }
  }

  // Journal → room. To Uni: addressed and p-tagged; the entry itself stays in the vault.
  async function shareEntry(note: JournalNote, roomId: string, toUni: boolean, vault: string, journalHub: string) {
    let label: string | null = null;
    const recipients: string[] = [];
    if (toUni) {
      const roster = await invoke<Member[]>("get_members", { channel: roomId });
      const uni = findUniMember(roster);
      if (!uni) throw new Error("Uni isn't in the Uni room's member list yet. Refresh conversations.");
      label = memberLabels(roster).get(uni.pubkey) ?? uni.name;
      recipients.push(uni.pubkey);
    }
    await invoke<Message>("post_message", { channel: roomId, body: shareText(note, vault, label, "", journalHub), replyTo: null, recipients });
    await loadRooms();
  }

  async function react(m: Message, emoji: string) {
    setReactFor(null);
    const mine = m.reactions.find((r) => r.mine && emojiLabel(r.emoji) === emojiLabel(emoji))?.mine ?? null;
    // Optimistic: show the change now, then re-read the store.
    setMessages((rows) => rows.map((x) => x.ref !== m.ref ? x : { ...x, reactions: toggleLocal(x.reactions, emoji, !!mine) }));
    try {
      await invoke("react", { channel: m.channel, target: m.ref, emoji: mine ? m.reactions.find((r) => r.mine === mine)!.emoji : emoji, mine });
    } catch (e) { setError(`Reaction failed: ${e}`); }
    setTick((n) => n + 1);
  }

  // Edit / delete our own messages (kind 40003 / kind 5, as Buzz desktop).
  // Rejecting keeps the inline editor open with the text intact.
  async function saveEdit(m: Message, body: string) {
    setError(null);
    try {
      await invoke("edit_message", { channel: m.channel, target: m.ref, body });
      setEditing(null);
      setTick((n) => n + 1);
      void loadRooms().catch(() => {});
    } catch (e) { setError(`Edit failed: ${e}`); throw e; }
  }
  async function deleteOwn(m: Message) {
    setError(null);
    try {
      await invoke("delete_message", { channel: m.channel, target: m.ref });
      if (editing === m.ref) setEditing(null);
      if (replyTo === m.ref) setReplyTo(null);
      setTick((n) => n + 1);
      void loadRooms().catch(() => {});
    } catch (e) { setError(`Delete failed: ${e}`); }
  }

  useEffect(() => {
    if (focusComposer.current) { focusComposer.current = false; input.current?.focus(); }
  }, [root]);

  const labels = memberLabels(members);
  const typists = [...(typing.get(`${channel}|${root ?? ""}`)?.keys() ?? [])].filter((pk) => pk !== identity);
  const typingNames = typists.map((pk) => labels.get(pk) ?? members.find((m) => m.pubkey === pk)?.name ?? pk.slice(0, 8));
  const typingLine = typingNames.length === 0 ? null : typingNames.length === 1 ? `${typingNames[0]} is typing…` : typingNames.length === 2 ? `${typingNames[0]} and ${typingNames[1]} are typing…` : "Several people are typing…";
  const suggestions = picker ? filterMembers(members, picker.query, identity ?? undefined) : [];

  function scope() { return channel ? keyFor(channel, root) : null; }

  activeScope.current = scope();
  function changePending(key: string, update: (items: PendingFile[]) => PendingFile[]) {
    const next = update(pendingStore.current.get(key) ?? []);
    pendingStore.current.set(key, next);
    if (activeScope.current === key) setPending(next);
  }
  function removeFile(key: string, id: string) {
    changePending(key, (items) => {
      const item = items.find((x) => x.id === id);
      if (item?.preview) URL.revokeObjectURL(item.preview);
      return items.filter((x) => x.id !== id);
    });
  }
  async function uploadFile(key: string, id: string, file: File) {
    changePending(key, (items) => items.map((x) => x.id === id ? { ...x, state: "uploading", error: undefined } : x));
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const media = await invoke<MediaRef>("media_upload", bytes, { headers: { "x-filename": encodeURIComponent(file.name), "x-file-mime": file.type || "application/octet-stream" } });
      changePending(key, (items) => items.map((x) => x.id === id ? { ...x, media, state: "ready" } : x));
    } catch (e) {
      changePending(key, (items) => items.map((x) => x.id === id ? { ...x, state: "error", error: String(e) } : x));
    }
  }
  function addFiles(files: File[]) {
    const key = scope();
    if (!key || !files.length) return;
    const current = pendingStore.current.get(key) ?? [];
    const room = MAX_ATTACHMENTS - current.length;
    if (files.length > room) setError(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
    for (const file of files.slice(0, Math.max(0, room))) {
      if (!file.size || file.size > MAX_FILE_BYTES) { setError(`${file.name}: file is empty or exceeds 25 MB.`); continue; }
      const id = crypto.randomUUID();
      const preview = /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : null;
      changePending(key, (items) => [...items, { id, file, preview, state: "uploading" }]);
      void uploadFile(key, id, file);
    }
  }
  // Voice message: record, upload the audio like any attachment, and put the
  // uni-1 transcript into the draft so it becomes the message text.
  const recorder = useRecorder((blob, mime) => {
    const key = scope();
    if (!key || !blob.size) return;
    const file = new File([blob], voiceFileName(mime), { type: mime.split(";")[0] });
    if (file.size > MAX_FILE_BYTES) { setError("Recording exceeds 25 MB."); return; }
    const id = crypto.randomUUID();
    changePending(key, (items) => [...items, { id, file, preview: null, state: "uploading", voice: "transcribing" }]);
    void uploadFile(key, id, file);
    void (async () => {
      try {
        const t = await invoke<{ text: string }>("voice_transcribe", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-audio-mime": mime } });
        const text = t.text.trim();
        changePending(key, (items) => items.map((x) => x.id === id ? { ...x, voice: "done" } : x));
        if (!text) return;
        const before = drafts.current.get(key) ?? "";
        const next = before.trim() ? `${before.trimEnd()}\n${text}` : text;
        drafts.current.set(key, next);
        if (activeScope.current === key) updateDraft(next, next.length);
      } catch (e) {
        changePending(key, (items) => items.map((x) => x.id === id ? { ...x, voice: "failed" } : x));
        setStatus(`No transcript (${String(e).slice(0, 120)}). The voice message still sends.`);
      }
    })();
  });
  async function toggleRecording() {
    if (recorder.recording) { recorder.stop(); return; }
    setError(null);
    try { await recorder.start(); } catch (e) { setError(`Microphone unavailable: ${String(e)}`); }
  }
  function onPasteFiles(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.files);
    if (files.length) { e.preventDefault(); addFiles(files); }
  }
  function onDropFiles(e: React.DragEvent) {
    e.preventDefault();
    if (!sending) addFiles(Array.from(e.dataTransfer.files));
  }
  function updateDraft(text: string, caret: number | null) {
    setDraft(text);
    const now = Date.now();
    if (text.trim() && channel && now - lastTypingSent.current > TYPING_SEND_MS) {
      lastTypingSent.current = now;
      void invoke("send_typing", { channel, root: root ?? null, parent: replyTo ?? root ?? null }).catch(() => {});
    }
    const key = scope();
    if (key) drafts.current.set(key, text);
    const next = pruneBindings(text, bindingsRef.current);
    bindingsRef.current = next;
    if (key) bindingStore.current.set(key, next);
    setBindings(next);
    syncPicker(text, caret);
  }

  function syncPicker(text: string, caret: number | null) {
    const q = caret === null ? null : activeQuery(text, caret, { settled: bindingsRef.current.keys(), names: members.map((m) => labels.get(m.pubkey) ?? m.name) });
    setPicker((old) => q ? { ...q, index: old && old.start === q.start ? old.index : 0 } : null);
  }

  function choose(member: Member) {
    if (!picker) return;
    const el = input.current;
    const caret = el?.selectionStart ?? draft.length;
    const label = labels.get(member.pubkey) ?? member.name;
    const next = insertMention(draft, picker.start, caret, label);
    const key = scope();
    setDraft(next.text);
    if (key) drafts.current.set(key, next.text);
    const updated = new Map(pruneBindings(next.text, bindingsRef.current));
    updated.set(label, member.pubkey);
    bindingsRef.current = updated;
    if (key) bindingStore.current.set(key, updated);
    setBindings(updated);
    setPicker(null);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(next.caret, next.caret); });
  }

  function startMention() {
    const el = input.current;
    const caret = el?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const prefix = before && !/\s$/.test(before) ? " @" : "@";
    const text = before + prefix + draft.slice(caret);
    const at = caret + prefix.length;
    updateDraft(text, at);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at, at); });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (picker && suggestions.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setPicker({ ...picker, index: (picker.index + step + suggestions.length) % suggestions.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(suggestions[Math.min(picker.index, suggestions.length - 1)]);
        return;
      }
    }
    if (picker && e.key === "Escape") { e.preventDefault(); setPicker(null); return; }
    if (e.key === "ArrowUp" && !draft) {
      // Slack/Buzz convention: ArrowUp in an empty composer edits your last message.
      const last = lastOwnMessage(messages, identity);
      if (last) { e.preventDefault(); setEditing(last.ref); }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  }

  function navigate(nextChannel: string | null, nextRoot: string | null) {
    const key = scope();
    // Save the spot in the view we're leaving; the next view restores its own.
    const leaving = restoredView.current, el = listRef.current;
    if (leaving && el) scrollMemory.current.set(leaving, markFor(el.scrollTop, el.scrollHeight, el.clientHeight));
    if (nextChannel !== channel || nextRoot !== root) restoredView.current = null;
    if (key) { drafts.current.set(key, draft); bindingStore.current.set(key, bindings); }
    const nextKey = nextChannel ? keyFor(nextChannel, nextRoot) : null;
    activeScope.current = nextKey;
    setPending(nextKey ? pendingStore.current.get(nextKey) ?? [] : []);
    setJournalOpen(false);
    setNotes([]);
    setChannel(nextChannel);
    setRoot(nextRoot);
    setDraft(nextKey ? drafts.current.get(nextKey) ?? "" : "");
    setBindings(nextKey ? bindingStore.current.get(nextKey) ?? new Map() : new Map());
    setPicker(null);
    setReplyTo(null);
    setError(null);
  }

  function openThread(m: Message) {
    focusComposer.current = true;
    navigate(channel, m.root && messages.some((x) => x.ref === m.root) ? m.root : m.ref);
  }

  async function send() {
    if (!channel || sending || (!draft.trim() && !pending.length)) return;
    const files = pendingStore.current.get(keyFor(channel, root)) ?? [];
    if (files.some((f) => f.state !== "ready" || !f.media || f.voice === "transcribing")) {
      setError("Wait for uploads to finish or remove failed files before sending."); return;
    }
    const sentIds = files.map((f) => f.id);
    const snapshot = draft;
    const key = keyFor(channel, root);
    const resolved = resolveRecipients(snapshot, bindings, members);
    if ("error" in resolved) { setError(resolved.error); return; }
    const recipients = [...resolved.recipients];
    const uniHere = findUniMember(members);
    if (notifyUni && uniHere && !recipients.includes(uniHere.pubkey)) recipients.push(uniHere.pubkey);
    const raw = rawKey.trim();
    if (raw) {
      if (!HEX_KEY.test(raw)) { setError("The advanced public key must be 64 hex characters."); return; }
      if (!recipients.includes(raw.toLowerCase())) recipients.push(raw.toLowerCase());
    }
    // In a thread, reply to the chosen message or to the root. If the root is
    // not cached, reply to the newest cached message in the thread.
    let target: string | null = replyTo;
    if (!target && root) target = messages.some((m) => m.ref === root) ? root : messages[messages.length - 1]?.ref ?? null;
    if (root && !target) { setError("Thread not in local cache. Refresh before replying."); return; }
    setSending(true);
    setError(null);
    try {
      await invoke<Message>("post_message", { channel, body: snapshot, replyTo: target, recipients, media: files.map((f) => f.media!) });
      changePending(key, (items) => {
        for (const item of items) if (sentIds.includes(item.id) && item.preview) URL.revokeObjectURL(item.preview);
        return items.filter((item) => !sentIds.includes(item.id));
      });
      // Do not erase text typed during an in-flight send or in another room.
      if (drafts.current.get(key) === snapshot || (scope() === key && draft === snapshot)) {
        setDraft((current) => current === snapshot ? "" : current);
        drafts.current.set(key, "");
        bindingStore.current.set(key, new Map());
        setBindings(new Map());
      }
      setRawKey("");
      setReplyTo(null);
      // Re-read through the room effect, which drops the result if the
      // user has switched rooms meanwhile.
      setTick((n) => n + 1);
      await loadRooms();
      setStatus(recipients.length ? `Message accepted by relay · notified ${recipients.length}` : "Message accepted by relay");
    } catch (e) { setError(String(e)); }
    finally { setSending(false); }
  }

  // One-tap answer to a Hermes approval prompt: post the reply text as an
  // ordinary message in the same lane, addressed to Uni, like send() would.
  async function answerApproval(m: Message, reply: string) {
    if (!channel || answered.has(m.ref)) return;
    let target: string | null = null;
    if (root) target = messages.some((x) => x.ref === root) ? root : messages[messages.length - 1]?.ref ?? null;
    if (root && !target) { setError("Thread not in local cache. Refresh before replying."); return; }
    const uni = findUniMember(members);
    setAnswered((prev) => new Map(prev).set(m.ref, reply));
    try {
      await invoke<Message>("post_message", { channel, body: reply, replyTo: target, recipients: uni ? [uni.pubkey] : [] });
      setTick((n) => n + 1);
      setStatus(`Sent ${reply}`);
    } catch (e) {
      setAnswered((prev) => { const next = new Map(prev); next.delete(m.ref); return next; });
      setError(String(e));
    }
  }

  async function forget() {
    // Two taps instead of window.confirm (unreliable in Android WebView).
    if (!forgetArmed) { setForgetArmed(true); return; }
    try { await invoke("identity_forget"); onForget(); } catch (e) { setError(String(e)); }
  }

  const currentRoom = rooms.find((r) => r.id === channel);
  const isThread = !!root;
  const rootMessage = isThread ? messages.find((m) => m.ref === root) : undefined;
  const threadReplies = isThread ? messages.filter((m) => m.ref !== root) : [];
  const boundNames = [...new Set(bindings.values())].map((pk) => members.find((m) => m.pubkey === pk)?.name ?? pk.slice(0, 8));

  const approvalRow = (m: Message) => {
    const prompt = parseApproval(m.body);
    if (!prompt) return null;
    const sent = answered.get(m.ref);
    if (!sent && !approvalOpen(m.ts, messages, Date.now() / 1000, 1800)) return null;
    return <div className="approval-actions" role="group" aria-label="Answer approval request">
      {prompt.choices.map((c) => <button key={c.reply} className={`pill approval-${c.tone}`} disabled={!!sent} onClick={() => actions.current.answer(m, c.reply)} aria-label={`${c.label}: send ${c.reply}`}>{c.label}</button>)}
      {sent && <span className="approval-sent">Sent: {sent}</span>}
    </div>;
  };

  const voiceOf = (m: Message): MediaRef | undefined => collectAttachments(m.body, m.media ?? [], relayOrigin).find((x) => attachmentKind(x) === "audio");
  const renderMessage = (m: Message, inThread: boolean, prev?: Message) => {
    const grouped = !!prev && prev.author === m.author && m.ts - prev.ts < 300 && !(inThread && prev.ref === root);
    return <article key={m.ref} data-ref={m.ref} className={`message ${m.ref === focusRef ? "search-focus" : ""} ${grouped ? "grouped" : ""} ${m.author === identity ? "mine" : ""} ${m.mentions_me ? "highlight" : ""} ${inThread && m.ref === root ? "thread-root" : ""}`}
      onContextMenu={(e) => {
        // Touch: long-press is the system's text selection (select + copy a
        // phrase); don't swallow it. Mouse: right-click opens quick reactions.
        if (window.matchMedia?.("(pointer: coarse)").matches) return;
        e.preventDefault(); setReactFor(reactFor === m.ref ? null : m.ref);
      }}>
      {grouped ? <time className="gutter-time">{clock(m.ts)}</time> : <span className="message-avatar" style={{ background: `hsl(${150 + (hue(m.author) % 120) - 60} 22% 44%)` }} aria-hidden="true">{m.author_name[0]?.toUpperCase() ?? "?"}</span>}
      <div className="message-content">{!grouped && <div className="message-meta"><strong>{m.author_name}</strong><time>{clock(m.ts)}</time></div>}{editing === m.ref ? <InlineEditor key={m.ref} initial={m.body} onSave={(body) => actions.current.saveEdit(m, body)} onCancel={() => actions.current.cancelEdit()} /> : <Body body={attachmentBody(m.body, m.media, relayOrigin)} mentions={m.mentions} me={identity} edited={m.edited} />}
        <Attachments body={m.body} media={m.media} />
        {approvalRow(m)}
        {m.reactions.length > 0 && <div className="reactions">{m.reactions.map((r) => <button key={r.emoji} className={`pill ${r.mine ? "mine" : ""}`} onClick={() => actions.current.react(m, r.emoji)} aria-pressed={!!r.mine} aria-label={`${emojiLabel(r.emoji)} ${r.count}${r.mine ? ", you reacted; tap to remove" : "; tap to add yours"}`}>{emojiLabel(r.emoji)} <span>{r.count}</span></button>)}</div>}
        {reactFor === m.ref && <div className="quick-react" role="toolbar" aria-label="React">{QUICK_REACTIONS.map((e) => <button key={e} onClick={() => actions.current.react(m, e)} aria-label={`React ${e}`}>{e}</button>)}</div>}
        {!inThread && m.reply_count > 0 && <button className="thread-summary" onClick={() => actions.current.openThread(m)} aria-label={`View thread with ${m.reply_count} ${m.reply_count === 1 ? "reply" : "replies"}`}>💬 {m.reply_count} {m.reply_count === 1 ? "reply" : "replies"}{m.last_reply_ts ? <span> · last {time(m.last_reply_ts)}</span> : null}</button>}
        <div className="message-actions">
          <button onClick={() => setReactFor(reactFor === m.ref ? null : m.ref)} aria-label={`React to ${m.author_name}`} aria-expanded={reactFor === m.ref}>React</button>
          {voiceOf(m) ? <button onClick={() => actions.current.keepVoice(m, voiceOf(m)!)} disabled={kept.has(m.ref)} aria-label={`Keep ${m.author_name}'s voice message as a note`}>{kept.has(m.ref) ? "✓ Kept" : "⤓ Keep as note"}</button>
            : <button onClick={() => actions.current.toUni(m, "note")} disabled={kept.has(m.ref)} aria-label={`Keep ${m.author_name}'s message as a note`}>{kept.has(m.ref) ? "✓ Sent to Uni" : "⤓ Keep"}</button>}
          <button onClick={() => actions.current.toUni(m, "ask")} aria-label={`Ask Uni about ${m.author_name}'s message`}>✦ Ask Uni</button>
          <button onClick={() => void copyText(m.body, "Copied text")} aria-label={`Copy ${m.author_name}'s message as markdown`}>⧉ Copy text</button>
          {!inThread && <button onClick={() => actions.current.openThread(m)} aria-label={`Reply in thread to ${m.author_name}`}>Reply in thread</button>}
          {inThread && m.ref !== root && <button onClick={() => actions.current.reply(m.ref)} aria-label={`Reply to ${m.author_name}`}>Reply</button>}
          {m.author === identity && editing !== m.ref && <button onClick={() => setEditing(m.ref)} aria-label="Edit your message">Edit</button>}
          {m.author === identity && <DeleteButton key={`del-${m.ref}`} label="your message" onDelete={() => actions.current.deleteOwn(m)} />}
        </div>
      </div>
    </article>;
  };

  // Day dividers + author grouping for a chronological list.
  const renderList = (list: Message[], inThread: boolean) => list.flatMap((m, i) => {
    const prev = list[i - 1];
    const sameDay = !!prev && dayKey(prev.ts) === dayKey(m.ts);
    const out: React.ReactNode[] = [];
    if (!sameDay) out.push(<div key={`d-${m.ref}`} className="day-divider" role="separator"><span>{dayLabel(m.ts)}</span></div>);
    out.push(renderMessage(m, inThread, sameDay ? prev : undefined));
    return out;
  });

  actions.current = {
    react: (m, e) => void react(m, e),
    toUni: (m, a) => void toUni(m, a),
    openThread,
    reply: (id) => { setReplyTo(id); input.current?.focus(); },
    loadOlder: () => void loadOlder(),
    saveEdit,
    cancelEdit: () => { setEditing(null); input.current?.focus(); },
    deleteOwn,
    answer: (m, reply) => void answerApproval(m, reply),
    keepVoice: (m, audio) => void keepVoice(m, audio),
  };

  // The rendered timeline depends only on data, never on the draft, so
  // keystrokes in the composer don't rebuild hundreds of messages.
  const roomName = currentRoom?.name ?? "";
  const timeline = useMemo(() => isThread ? <>
    {rootMessage ? renderMessage(rootMessage, true) : messages.length > 0 && <p className="empty">Root message is not cached; showing replies we have.</p>}
    {rootMessage && <div className="thread-divider"><span>{threadReplies.length ? `${threadReplies.length} ${threadReplies.length === 1 ? "reply" : "replies"}` : "No replies yet"}</span></div>}
    {renderList(threadReplies, true)}
    {messages.length === 0 && <p className="empty">Thread not in local cache. Refresh to try again.</p>}
  </> : <>
    {messages.length > 0 && <div className="older">{older === "done" ? <span>Start of #{roomName}</span> : <button onClick={() => actions.current.loadOlder()} disabled={older === "loading"}>{older === "loading" ? "Loading older messages…" : "Load older messages"}</button>}</div>}
    {messages.length === 0 && <p className="empty">No messages in this room yet.</p>}
    {renderList(messages, false)}
  </>,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [messages, identity, reactFor, kept, answered, root, older, roomName, editing, focusRef, relayOrigin]);

  const topNote = notes[notes.length - 1];
  // A note opened from a chat says where Back goes: "← Uni", "← Thread", "← Journal".
  const backTo = journalOpen ? "Journal" : currentRoom ? (isThread ? `Thread in ${currentRoom.name}` : currentRoom.name) : searchOpen ? "Search" : "Conversations";

  // Android back gesture/button: step back through the app (note stack,
  // search, thread, Journal, room) before leaving it. The listener is only
  // registered while there is somewhere to go back to, so at the room list
  // the system default runs (the app goes to the background, as usual).
  const goBack = useRef<() => void>(() => {});
  goBack.current = () => {
    if (notes.length) { closeNote(); return; }
    if (searchOpen) { setSearchOpen(false); return; }
    if (journalOpen) { setJournalOpen(false); return; }
    if (root) { navigate(channel, null); return; }
    if (channel) navigate(null, null);
  };
  const canGoBack = notes.length > 0 || searchOpen || journalOpen || !!channel;
  useEffect(() => {
    if (!canGoBack) return;
    let off: (() => void) | null = null, dead = false;
    onBackButtonPress(() => goBack.current())
      .then((l) => { if (dead) void l.unregister(); else off = () => void l.unregister(); })
      .catch(() => { /* desktop / browser: no back button */ });
    return () => { dead = true; off?.(); };
  }, [canGoBack]);
  return <NoteOpener.Provider value={openNote}><main className={`shell ${channel || journalOpen ? "in-room" : ""} ${topNote ? "note-open" : ""}`}>
    <aside className="rooms" aria-label="Conversations">
      <header className="rooms-header"><div><span className="eyebrow">Unforced</span><h1>Uni</h1></div><div><button className="icon-button" onClick={() => setSearchOpen(true)} aria-label="Search messages and notes">⌕</button><button className="icon-button" onClick={() => void refresh()} disabled={busy} aria-label="Refresh conversations">↻</button><button className="icon-button" onClick={() => { setSettingsOpen(!settingsOpen); setForgetArmed(false); }} aria-label="Settings" aria-expanded={settingsOpen}>⚙</button></div></header>
      {settingsOpen && <div className="settings"><button className="pairing-secondary" onClick={() => void forget()}>{forgetArmed ? "Tap again to forget — you'll need to re-pair" : "Forget this device key"}</button>{forgetArmed && <button className="pairing-secondary" onClick={() => setForgetArmed(false)}>Keep key</button>}</div>}
      {searchOpen && <Search onOpen={openHit} onAskUni={askUniSearch} onClose={() => setSearchOpen(false)} />}
      {searchOpen && error && <p className="error search-error" role="alert">{error}</p>}
      <div className="rooms-body" hidden={searchOpen}>
      <p className="connection" role="status">{status}{live ? <span className={`live ${live === "Live" ? "on" : ""}`}> · {live}</span> : null}</p>
      {identity && <p className="identity" title={npub ?? identity}>{myName ? <>Signed in as <strong>{myName}</strong></> : <>Public key <code>{npub ? `${npub.slice(0, 14)}…${npub.slice(-6)}` : `${identity.slice(0, 12)}…`}</code></>}<button className="identity-copy" onClick={() => void copyText(npub ?? identity, "Copied public key")} aria-label="Copy your public key">⧉</button></p>}
      {!ready && <p className="empty">Loading…</p>}
      {ready && rooms.length === 0 && <p className="empty">No joined conversations cached. Refresh to connect with your personal Buzz key.</p>}
      <button className={`room journal-room ${journalOpen ? "selected" : ""}`} onClick={() => { navigate(null, null); setJournalOpen(true); }} aria-current={journalOpen ? "page" : undefined}>
        <span className="avatar">❋</span><span className="room-text"><strong>Journal</strong><small>Speak or write · private to your vault</small></span>
      </button>
      <nav>{rooms.map((room) => <button key={room.id} className={`room ${channel === room.id ? "selected" : ""}`} onClick={() => navigate(room.id, null)} aria-current={channel === room.id ? "page" : undefined}>
        <span className="avatar">{room.name[0]?.toUpperCase() ?? "#"}</span><span className="room-text"><strong className={room.unread ? "unread" : ""}>{room.name}</strong><small>{room.last_message ? markdownToText(room.last_message) : "No messages yet"}</small></span>
        <span className="room-side"><time>{room.last_ts ? time(room.last_ts) : ""}</time>{room.unread > 0 && <span className={`unread-badge ${room.mentions ? "mention" : ""}`} aria-label={`${room.unread} unread${room.mentions ? ", mentions you" : ""}`}>{room.mentions ? "@ " : ""}{room.unread > 99 ? "99+" : room.unread}</span>}</span>
      </button>)}</nav>
      </div>
    </aside>
    <section className="conversation" aria-label={journalOpen ? "Journal" : currentRoom ? `Conversation: ${currentRoom.name}` : "Conversation"} aria-hidden={topNote ? true : undefined}>
      {journalOpen ? <Journal rooms={rooms} uniRoomId={findUniRoom(rooms)?.id ?? null} onShare={shareEntry} onBack={() => setJournalOpen(false)} />
      : currentRoom ? <>
        <header className="conversation-header">
          <button className="back icon-button" onClick={() => isThread ? navigate(channel, null) : navigate(null, null)} aria-label={isThread ? "Back to room" : "Back to conversations"}>‹</button>
          {isThread && <button className="thread-back" onClick={() => navigate(channel, null)} aria-label="Close thread">‹ {currentRoom.name}</button>}
          <div><strong>{isThread ? "Thread" : currentRoom.name}</strong><small>{isThread ? `${threadReplies.length} ${threadReplies.length === 1 ? "reply" : "replies"} · in ${currentRoom.name}` : `Buzz conversation · ${members.length ? `${members.length} members` : "cached locally"}`}</small></div>
          <button className="icon-button" onClick={() => void refresh()} disabled={busy} aria-label="Refresh messages">↻</button>
        </header>
        <div className="message-list" ref={setList} role="log" aria-label="Messages" aria-live="polite">
          <div className="message-stack" ref={setStackEl}>
            {timeline}
            <div ref={scrollEnd} />
          </div>
        </div>
        <footer className="composer" onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={onDropFiles}>
          <input ref={fileInput} className="file-picker" type="file" multiple aria-label="Choose files to attach" onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          {error && <p className="error" role="alert">{error}</p>}
          {replyTo && replyTo !== root && <div className="reply-banner">Replying to {messages.find((m) => m.ref === replyTo)?.author_name ?? "message"}<button onClick={() => setReplyTo(null)} aria-label="Cancel reply">×</button></div>}
          <div className="compose-destination">{isThread ? <>Replying in thread · <strong>{currentRoom.name}</strong></> : <>Sending to <strong>{currentRoom.name}</strong></>}{boundNames.length ? ` · notifying ${boundNames.join(", ")}` : ""}{findUniMember(members) && <> · <button className="link" onClick={() => setNotifyUni((v) => !v)} aria-pressed={notifyUni}>{notifyUni ? "Uni is listening" : "Uni muted"}</button></>}</div>
          {picker && <ul className="mention-picker" role="listbox" aria-label="Mention a member">
            {suggestions.length === 0 && <li className="mention-empty">{members.length ? `No member matches “${picker.query}”` : "No member list cached yet. Refresh to load it."}</li>}
            {suggestions.map((m, i) => <li key={m.pubkey} role="option" aria-selected={i === picker.index}>
              <button className={i === picker.index ? "active" : ""} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(m)}>
                <span className="avatar small">{m.name[0]?.toUpperCase() ?? "?"}</span><span className="mention-name">{labels.get(m.pubkey) ?? m.name}</span><small>{m.pubkey.slice(0, 8)}</small>
              </button>
            </li>)}
          </ul>}
          {advancedOpen && <label className="address-label">Advanced: also notify a raw public key (64 hex characters)<input value={rawKey} onChange={(e) => setRawKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder="hex pubkey" /></label>}
          {typingLine && <div className="typing-line" role="status" aria-live="polite">{typingLine}</div>}
          {pending.length > 0 && <div className="compose-files" aria-label="Attachments">
            {pending.map((item) => <div className={`compose-file ${item.state}`} key={item.id}>
              {item.preview ? <img src={item.preview} alt="" /> : <span className="compose-file-icon" aria-hidden="true">{item.file.type === "application/pdf" || item.file.name.toLowerCase().endsWith(".pdf") ? "📄" : attachmentKind({ url: item.file.name, mime: item.file.type }) === "audio" ? "♪" : "📎"}</span>}
              <span className="compose-file-info" onClick={() => item.error && setError(`${item.file.name}: ${item.error}`)} title={item.error ?? undefined}><strong>{item.file.name}</strong><small>{formatSize(item.file.size)} · {item.state === "ready" ? "Ready" : item.state === "uploading" ? "Uploading…" : `Failed: ${item.error}`}{item.voice === "transcribing" ? " · Transcribing…" : item.voice === "failed" ? " · No transcript" : ""}</small>{item.state === "uploading" && <progress aria-label={`Uploading ${item.file.name}`} />}</span>
              {item.state === "error" && <button className="compose-file-retry" onClick={() => void uploadFile(keyFor(currentRoom.id, root), item.id, item.file)} aria-label={`Retry upload ${item.file.name}`}>Retry</button>}
              <button className="compose-file-remove" disabled={sending} onClick={() => removeFile(keyFor(currentRoom.id, root), item.id)} aria-label={`Remove ${item.file.name}`}>×</button>
            </div>)}
          </div>}
          <div className="compose-row"><button className="address-toggle" onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={startMention} aria-label="Mention someone">@</button><button className="address-toggle" onClick={() => fileInput.current?.click()} disabled={sending} aria-label="Attach files" title="Attach files">📎</button><button className={`address-toggle mic ${recorder.recording ? "recording" : ""}`} onClick={() => void toggleRecording()} disabled={sending} aria-pressed={recorder.recording} aria-label={recorder.recording ? "Stop recording voice message" : "Record a voice message"} title={recorder.recording ? "Stop recording" : "Voice message"}>{recorder.recording ? `■ ${mmss(recorder.elapsed)}` : "🎙"}</button><textarea ref={input} aria-label={`Message ${currentRoom.name}`} value={draft} onChange={(e) => updateDraft(e.target.value, e.target.selectionStart)} onPaste={onPasteFiles} onSelect={(e) => syncPicker(e.currentTarget.value, e.currentTarget.selectionStart)} onBlur={() => setPicker(null)} onKeyDown={onKeyDown} maxLength={65536} rows={2} placeholder={isThread ? "Reply in thread…" : "Message Uni…"} /><button className="send" disabled={(!draft.trim() && !pending.length) || pending.some((f) => f.state !== "ready" || f.voice === "transcribing") || sending || recorder.recording} onClick={() => void send()} aria-label="Send message">{sending ? "Sending…" : "Send"}</button></div>
          <p className="compose-hint">Enter to send · Shift+Enter for a new line · @ to mention · <button className="link" onClick={() => setAdvancedOpen(!advancedOpen)}>{advancedOpen ? "hide raw key" : "raw key…"}</button></p>
        </footer>
      </> : <div className="welcome"><span className="welcome-mark">✦</span><h2>Your conversation starts here</h2><p>Select a room to read and reply. Messages are cached for offline reading.</p></div>}
    </section>
    {/* The note is a sheet over the chat; the chat stays mounted underneath,
        so Back lands exactly where you were. */}
    {topNote && <section className="note-sheet" role="dialog" aria-modal="true" aria-label="Note">
      <NoteView key={`${notes.length}:${noteKey(topNote)}`} target={topNote} hub={hub} onOpen={openNote} onBack={closeNote}
        backLabel={notes.length > 1 ? noteTitles[noteKey(notes[notes.length - 2])] ?? notes[notes.length - 2].ref.split("/").pop() ?? "note" : backTo}
        onTitle={(t) => rememberTitle(noteKey(topNote), t)} />
    </section>}
    {toast && <div className="toast" role="status">{toast}</div>}
  </main></NoteOpener.Provider>;
}

export default App;
