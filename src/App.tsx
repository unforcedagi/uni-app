import { VoiceOutbox, relayAccepted } from "./voiceOutbox";
import { SettingsIcon, UniIcon, JournalIcon, StarIcon, RoomsIcon } from "./Icons";
import { FOR_YOU_ID, FOR_YOU_OPENED_KEY, LAST_SURFACE_KEY, countRecommendations, isRecommendationNew, readLastSurface, saveLastSurface } from "./railCore";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { attachmentBlocksSend, enterInsertsNewline, manualAttachments } from "./composerCore";
import PairSource, { PairDeviceButton } from "./PairSource";
import { UpdateSettings } from "./UpdateNotice";
import { activeTab, closeTab, EMPTY_TABS, focusTab, navigateNoteTab, nextAfterClose, openTab, recordingTabCanClose, restoreTabs, serializeTabs, tabForDigit, updateTab, TABS_KEY, type Tabs, type Tab, type TabTarget, type OpenMode } from "./tabs";
import { notifyMention, setUnreadBadge } from "./desktopNotify";
import NoteView from "./NoteView";
import SurfaceModal from "./SurfaceModal";
import { readDraft, forgetDrafts } from "./noteDrafts";
import { invalidatePaths } from "./vaultPaths";
import { ALIASES_KEY, resolveNote, tabHasDraft } from "./noteIdentity";
import VaultBrowser from "./VaultBrowser";
import { validateNotePath } from "./noteEdit";
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

type PendingFile = { created?: number; signedEvent?: string; id: string; file: File; preview: string | null; state: "uploading" | "ready" | "error"; media?: MediaRef; error?: string; voice?: { channel: string; replyTo: string | null; notifyUni: boolean } };
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const OTHER_VAULTS_KEY = "uni:other-vaults-expanded";

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

function ComposerMenu({ onMention, onAttach, sending }: { onMention: () => void; onAttach: () => void; sending: boolean }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (e: PointerEvent) => {
      if (!container.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return <div className="compose-tools" ref={container}
    onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}
    onKeyDown={(e) => {
      if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    }}>
    <button ref={trigger} className="address-toggle compose-icon" aria-label="More message options" title="More message options"
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); } }}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
    </button>
    {/* WebKit can blur the focused item with relatedTarget=null on mousedown;
        preserve focus through click so onBlur cannot unmount the action target. */}
    {open && <div ref={menu} id={menuId} className="compose-menu" role="menu" aria-label="Message options"
      onMouseDown={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}>
      <button role="menuitem" onClick={() => { setOpen(false); onMention(); }}><span aria-hidden="true">@</span> Mention</button>
      <button role="menuitem" disabled={sending} onClick={() => { setOpen(false); trigger.current?.focus(); onAttach(); }}><span aria-hidden="true">＋</span> Attach file/photo</button>
    </div>}
  </div>;
}

function resizeComposer(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  const style = getComputedStyle(el);
  const maxHeight = parseFloat(style.lineHeight) * 6 + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
}

function Conversations({ onForget }: { onForget: () => void }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [tabs, setTabs] = useState<Tabs>(EMPTY_TABS);
  const tabsRef = useRef<Tabs>(EMPTY_TABS);
  const tabsReady = useRef(false);
  const [vaults, setVaults] = useState<string[]>([]);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [vaultRefresh, setVaultRefresh] = useState(0);
  const [otherVaultsExpanded, setOtherVaultsExpanded] = useState(() => {
    try { return localStorage.getItem(OTHER_VAULTS_KEY) === "true"; } catch { return false; }
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState({ vault: "", prefix: "" });
  const [initialAliases] = useState<Record<string, string>>(() => {
    try { const value = JSON.parse(localStorage.getItem(ALIASES_KEY) ?? "{}"); return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string")) as Record<string, string> : {}; } catch { return {}; }
  });
  const aliases = useRef(initialAliases);
  const dirtyNotes = useRef(new Map<string, Set<string>>());
  const [, setDirtyTabs] = useState(new Set<string>());
  const editOnOpen = useRef(new Set<string>());
  const [confirmation, setConfirmation] = useState<{ text: string; run: () => void; notice?: string } | null>(null);
  const [creating, setCreating] = useState<{ vault: string; path: string } | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const createLock = useRef(false);
  useEffect(() => {
    let live = true;
    setVaultError(null);
    invoke<string[]>("vault_list").then((names) => { if (live) setVaults(names); }).catch((e) => { if (live) setVaultError(String(e)); });
    return () => { live = false; };
  }, [vaultRefresh]);
  function reportDirty(tabId: string, ref: string, dirty: boolean) {
    const entries = dirtyNotes.current.get(tabId) ?? new Set<string>();
    if (entries.has(ref) === dirty) return;
    if (dirty) entries.add(ref); else entries.delete(ref);
    dirtyNotes.current.set(tabId, entries);
    setDirtyTabs(new Set([...dirtyNotes.current].filter(([, notes]) => notes.size).map(([id]) => id)));
  }
  function isTabDirty(tab: Tab) {
    return tabHasDraft(tab.note, tab.id === tabsRef.current.active ? notesRef.current : noteStacks.current.get(tab.id) ?? [], aliases.current, readDraft);
  }
  function requestCreate(vault: string, folder: string) {
    setCreateError(null); setCreating({ vault, path: folder ? `${folder}/` : "" });
  }
  async function createNote() {
    if (!creating || createLock.current) return;
    const problem = validateNotePath(creating.path);
    if (problem) { setCreateError(problem); return; }
    createLock.current = true; setCreateBusy(true); setCreateError(null);
    try {
      const note = await invoke<{ id: string; path: string }>("vault_create", { ...creating, content: "" });
      invalidatePaths(creating.vault);
      setToast(`Created ${note.path || note.id}`);
      editOnOpen.current.add(`${creating.vault}:${note.id}`);
      openTarget({ kind: "note", note: { hub: null, vault: creating.vault, ref: note.id }, title: note.path || note.id }, "new");
      setConfirmation((current) => current ? { ...current, notice: `Created ${note.path || note.id}.` } : null);
      setCreating(null);
    } catch (e) { setCreateError(String(e)); }
    finally { createLock.current = false; setCreateBusy(false); }
  }
  // Each tab owns its own note Back stack, even while another tab is active.
  const noteStacks = useRef(new Map<string, VaultRef[]>());
  const notesRef = useRef<VaultRef[]>([]);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [panel, setPanel] = useState<"rooms" | "vault" | "settings" | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const forYouBack = useRef("Uni");
  const forYouReturn = useRef<string | null>(null);
  const [journalFocus, setJournalFocus] = useState(false);
  const [forYou, setForYou] = useState({ count: 0, fresh: false, updatedAt: null as string | null });
  const renderedForYou = useRef<string | null>(null);
  const [forYouReload, setForYouReload] = useState(0);
  async function refreshForYou() {
    try {
      const data = await invoke<{ note: { content?: string; updatedAt?: string } }>("vault_note", { vault: "uni", noteRef: FOR_YOU_ID });
      const updated = data.note.updatedAt ?? null;
      let last: string | null = null;
      try {
        last = localStorage.getItem(FOR_YOU_OPENED_KEY);
      } catch { /* unavailable storage */ }
      setForYou({ count: countRecommendations(data.note.content ?? ""), updatedAt: updated, fresh: isRecommendationNew(updated, last) });
    } catch { /* keep the last successful count while offline */ }
  }
  useEffect(() => {
    void refreshForYou();
    const visible = () => { if (document.visibilityState === "visible") void refreshForYou(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { setJournalFocus(false); setPanel(null); setSearchOpen(false); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  function openForYou() {
    if (topNote?.ref !== FOR_YOU_ID) {
      const surfaces = tabsRef.current.tabs.filter((t) => t.kind === "room" || t.kind === "thread" || t.kind === "journal");
      const previous = [...tabsRef.current.recent].reverse().map((id) => surfaces.find((t) => t.id === id)).find(Boolean);
      forYouBack.current = previous?.title ?? "Uni";
      forYouReturn.current = previous?.id ?? null;
    }
    openTarget({ kind: "note", note: { hub: null, vault: "uni", ref: FOR_YOU_ID }, title: "For you" }, "new");
    if (topNote?.vault === "uni" && topNote.ref === FOR_YOU_ID && isRecommendationNew(forYou.updatedAt, renderedForYou.current)) setForYouReload((n) => n + 1);
  }
  const pickNewTab = useRef(false);
  const longPress = useRef<number | null>(null);
  const longPressed = useRef(false);
  const [journalRecording, setJournalRecording] = useState<{ elapsed: number; stop: () => void } | null>(null);
  const journalRecordingRef = useRef(false);
  const [channel, setChannel] = useState<string | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [identity, setIdentity] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const drafts = useRef(new Map<string, string>());
  const draftRevisions = useRef(new Map<string, number>());
  const [pending, setPending] = useState<PendingFile[]>([]);
  const pendingStore = useRef(new Map<string, PendingFile[]>());
  const voiceQueue = useRef(Promise.resolve());
  const voiceCreated = useRef(0);
  const voiceJobs = useRef(new Set<string>());
  const [voiceStatus, setVoiceStatus] = useState("");
  const [voiceStorageWarning, setVoiceStorageWarning] = useState("");
  const voiceOutbox = useRef(new VoiceOutbox(() => setVoiceStorageWarning("Voice storage unavailable. Recordings are kept only until this app closes.")));
  const voiceRestored = useRef<Promise<void> | null>(null);
  useEffect(() => {
    voiceRestored.current ??= voiceOutbox.current.list().then((clips) => {
      for (const clip of clips) {
        voiceCreated.current = Math.max(voiceCreated.current, clip.created);
        const item: PendingFile = { ...clip, file: new File([clip.file], clip.filename, { type: clip.mime }), preview: null };
        changePending(clip.key, items => items.some(x => x.id === clip.id) ? items : [...items, item]);
      }
      for (const clip of clips) if (clip.state !== "error") queueVoice(clip.key, clip.id);
    });
  }, []);
  const activeScope = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const voiceMounted = useRef(true);
  useEffect(() => {
    voiceMounted.current = true;
    return () => {
      voiceMounted.current = false;
      for (const files of pendingStore.current.values()) for (const item of files) if (item.preview) URL.revokeObjectURL(item.preview);
    };
  }, []);
  const [bindings, setBindings] = useState<Bindings>(new Map());
  const bindingStore = useRef(new Map<string, Bindings>());
  const [picker, setPicker] = useState<Picker | null>(null);
  const [rawKey, setRawKey] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [status, setStatus] = useState("Loading cached conversations…");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pairSourceOpen, setPairSourceOpen] = useState(false);
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
  notesRef.current = notes;
  const [hub, setHub] = useState<string | null>(null);
  useEffect(() => { invoke<{ hub: string }>("journal_config").then((c) => setHub(c.hub)).catch(() => {}); }, []);

  function commitTabs(next: Tabs) {
    tabsRef.current = next;
    setTabs(next);
    if (tabsReady.current) { try { localStorage.setItem(TABS_KEY, serializeTabs(next)); } catch { /* private storage */ } }
  }
  function switchToTab(tab: Tab | null) {
    setComposerFocused(false);
    setPanel(null);
    setSearchOpen(false);
    setJournalFocus(false);
    if (tab?.kind === "journal") saveLastSurface(localStorage, "journal");
    else if (tab?.kind === "room" && tab.channel === findUniRoom(roomsRef.current)?.id) saveLastSurface(localStorage, "uni");
    const leaving = tabsRef.current.active;
    if (leaving) noteStacks.current.set(leaving, notesRef.current);
    // navigate restores scoped draft, attachments, scroll and bindings.
    navigate(tab?.channel ?? null, tab?.root ?? null);
    setJournalOpen(tab?.kind === "journal");
    const stack = tab ? noteStacks.current.get(tab.id) ?? (tab.kind === "note" && tab.note ? [tab.note] : []) : [];
    notesRef.current = stack;
    setNotes(stack);
    setSidebarVisible(false);
  }
  function focusTabById(id: string) {
    const next = tabsRef.current.tabs.find((t) => t.id === id);
    if (!next) return;
    if (id !== tabsRef.current.active) switchToTab(next);
    commitTabs(focusTab(tabsRef.current, id));
    setSidebarVisible(false);
  }
  function openTarget(target: TabTarget, mode: OpenMode = "focus", confirmed = false) {
    if (target.note) target = { ...target, note: resolveNote(target.note, aliases.current) };
    // A recording's origin tab must survive the 12-tab eviction cap.
    const originId = recordingOrigin.current?.tabId;
    const pinned = new Set(tabsRef.current.tabs.filter((t) => t.id === originId || (t.kind === "journal" && journalRecordingRef.current)).map((t) => t.id));
    const base = { ...tabsRef.current, tabs: tabsRef.current.tabs.map((t) => t.note ? { ...t, note: resolveNote(t.note, aliases.current) } : t), recent: [...tabsRef.current.recent.filter((id) => !pinned.has(id)), ...pinned] };
    const effectiveMode = mode === "focus" && pinned.has(tabsRef.current.active ?? "") ? "new" : mode;
    const next = openTab(base, target, effectiveMode, () => crypto.randomUUID());
    const removed = tabsRef.current.tabs.filter((t) => !next.tabs.some((n) => n.id === t.id));
    if (removed.some((t) => t.id === originId || (t.kind === "journal" && journalRecordingRef.current))) {
      setError("Stop the recording before replacing its tab."); return;
    }
    if (!confirmed && removed.some(isTabDirty)) {
      setConfirmation({ text: "Close a tab with unsaved changes? Its draft will be kept on this device.", run: () => openTarget(target, mode, true) }); return;
    }
    removed.forEach((t) => dirtyNotes.current.delete(t.id));
    const tab = activeTab(next);
    if (tab && (next.active !== tabsRef.current.active || mode === "replace")) switchToTab(tab);
    commitTabs(next);
    setSidebarVisible(false);
    setPanel(null);
    setSearchOpen(false);
  }
  function closeTabById(id: string, confirmed = false) {
    const closing = tabsRef.current.tabs.find((t) => t.id === id);
    if (!confirmed && closing && isTabDirty(closing)) {
      setConfirmation({ text: "Close this tab with unsaved changes? Its draft will be kept on this device.", run: () => closeTabById(id, true) }); return;
    }
    if (!recordingTabCanClose(id, recordingOrigin.current?.tabId ?? null)) {
      setError("Stop the voice recording before closing its tab."); return;
    }
    if (journalRecordingRef.current && tabsRef.current.tabs.find((t) => t.id === id)?.kind === "journal") {
      setError("Stop the Journal recording before closing its tab."); return;
    }
    const wasActive = tabsRef.current.active === id;
    const next = closeTab(tabsRef.current, id);
    if (next === tabsRef.current) return;
    if (wasActive) switchToTab(activeTab(next));
    noteStacks.current.delete(id);
    dirtyNotes.current.delete(id);
    commitTabs(next);
    if (!next.tabs.length) setSidebarVisible(true);
  }
  function roomTarget(id: string): TabTarget {
    return { kind: "room", channel: id, title: roomsRef.current.find((r) => r.id === id)?.name ?? "Room" };
  }
  const openTargetRef = useRef(openTarget);
  const closeTabRef = useRef(closeTabById);
  const switchToTabRef = useRef(switchToTab);
  openTargetRef.current = openTarget;
  closeTabRef.current = closeTabById;
  switchToTabRef.current = switchToTab;
  const openNote = useCallback((ref: VaultRef, href: string | null) => {
    // A note on some other hub isn't readable with this key: let the browser
    // (and that hub's Parachute app) handle it.
    if (!sameHub(ref, hub)) { if (href) void invoke("open_link", { url: href }).catch(() => {}); return; }
    setSidebarVisible(false);
    const target = resolveNote({ ...ref, hub: null }, aliases.current);
    const current = activeTab(tabsRef.current);
    if (current?.kind === "note") {
      const top = notesRef.current[notesRef.current.length - 1];
      if (top?.vault === target.vault && resolveNote(top, aliases.current).ref === target.ref) return;
      const stack = [...notesRef.current.slice(-19), target];
      notesRef.current = stack;
      noteStacks.current.set(current.id, stack);
      setNotes(stack);
      commitTabs(navigateNoteTab(tabsRef.current, current.id, target, ref.ref.split("/").pop() || ref.ref));
    } else {
      openTargetRef.current({ kind: "note", note: target, title: ref.ref.split("/").pop() || ref.ref }, "new");
    }
  }, [hub]);
  // Loaded note titles, so a nested note's Back reads "← <previous note>".
  const [noteTitles, setNoteTitles] = useState<Record<string, string>>({});
  const closeNote = useCallback(() => {
    const s = notesRef.current;
    if (s.length <= 1 && activeTab(tabsRef.current)?.kind === "note") {
      closeTabRef.current(tabsRef.current.active!); return;
    }
    const stack = s.slice(0, -1);
    notesRef.current = stack;
    if (tabsRef.current.active) {
      noteStacks.current.set(tabsRef.current.active, stack);
      const previous = stack[stack.length - 1];
      if (previous) commitTabs(navigateNoteTab(tabsRef.current, tabsRef.current.active, previous, noteTitles[`${previous.vault}:${previous.ref}`] ?? previous.ref.split("/").pop() ?? previous.ref));
    }
    setNotes(stack);
  }, [noteTitles]);
  const noteKey = (r: VaultRef) => `${r.vault}:${r.ref}`;
  const rememberTitle = useCallback((key: string, t: string) => {
    setNoteTitles((m) => m[key] === t ? m : { ...m, [key]: t });
    const current = activeTab(tabsRef.current);
    if (current?.kind === "note" && notesRef.current.length && noteKey(notesRef.current[notesRef.current.length - 1]) === key) {
      const next = updateTab(tabsRef.current, current.id, { title: t });
      if (next !== tabsRef.current) commitTabs(next);
    }
  }, []);
  // Creation and clipboard notices.
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => onCopied(setToast), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
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
  const composerInput = useCallback((el: HTMLTextAreaElement | null) => {
    input.current = el;
    if (!el) return;
    resizeComposer(el);
    let width = el.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = el.getBoundingClientRect().width;
      if (nextWidth !== width) { width = nextWidth; resizeComposer(el); }
    });
    observer.observe(el);
    return () => { observer.disconnect(); input.current = null; };
  }, []);
  useLayoutEffect(() => { if (input.current) resizeComposer(input.current); }, [draft]);
  const focusComposer = useRef(false);

  const loadRooms = useCallback(async () => {
    const rows = await invoke<Room[]>("get_rooms");
    setRooms(rows);
    roomsRef.current = rows;
    setUnreadBadge(rows.reduce((n, r) => n + (r.unread || 0), 0));
    if (!tabsReady.current) {
      tabsReady.current = true;
      let saved: string | null = null;
      try { saved = localStorage.getItem(TABS_KEY); } catch { /* private storage */ }
      let next = restoreTabs(saved, rows.map((r) => r.id));
      if (!saved && !next.tabs.length && rows[0]) next = openTab(next, { kind: "room", channel: rows[0].id, title: rows[0].name }, "new", () => crypto.randomUUID());
      let preferred: string | null = null;
      try { preferred = localStorage.getItem(LAST_SURFACE_KEY); } catch { /* unavailable storage */ }
      if (preferred || !saved) {
        const uni = findUniRoom(rows) ?? rows[0];
        const target: TabTarget | null = readLastSurface(localStorage) === "journal" ? { kind: "journal", title: "Journal" } : uni ? { kind: "room", channel: uni.id, title: uni.name } : null;
        if (target) next = openTab(next, target, "new", () => crypto.randomUUID());
      }
      // Note stacks are reconstructed from their saved top-level tab target.
      switchToTabRef.current(activeTab(next));
      commitTabs(next);
    } else {
      // Re-sync after room membership changes: discard tabs for missing rooms.
      const previous = tabsRef.current;
      const next = restoreTabs(serializeTabs(previous), rows.map((r) => r.id));
      if (next.tabs.length !== previous.tabs.length) {
        if (next.active !== previous.active) switchToTabRef.current(activeTab(next));
        for (const old of previous.tabs) if (!next.tabs.some((t) => t.id === old.id)) noteStacks.current.delete(old.id);
        commitTabs(next);
      }
    }
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
    openTarget(t.root ? { kind: "thread", channel: t.channel, root: t.root, title: `Thread · ${roomsRef.current.find((r) => r.id === t.channel)?.name ?? "Room"}` } : roomTarget(t.channel), "focus");
    setFocusRef(t.focus);
  }

  // Fallback when the hub is unreachable: Uni searches the vault and replies in #Uni.
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
    setStatus("Saving vault note…");
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
        openTarget(roomTarget(uniRoom.id), "focus");
        // Replace the restored draft: question goes after "@Uni ".
        const prefix = `@${label} `;
        const question = prefix + "\n\n" + text.slice(text.indexOf("\n\n") + 2);
        setDraft(question);
        const key = keyFor(uniRoom.id, null);
        editDraft(key, question);
        const nextBindings = new Map([[label, uni.pubkey]]);
        bindingStore.current.set(key, nextBindings);
        bindingsRef.current = nextBindings;
        setBindings(nextBindings);
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
  async function persistVoice(key: string, id: string) {
    const clip = pendingStore.current.get(key)?.find(x => x.id === id);
    if (!clip?.voice) return;
    await voiceOutbox.current.put({ id, key, file: clip.file, filename: clip.file.name, mime: clip.file.type,
      created: clip.created!, state: clip.state === "error" ? "error" : "uploading", error: clip.error,
      media: clip.media, signedEvent: clip.signedEvent, voice: clip.voice });
  }
  function removeFile(key: string, id: string) {
    void voiceOutbox.current.remove(id);
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
  // Voice delivery owns its destination and never consumes the text draft.
  // Serialize jobs so a second recording cannot overtake the first.
  function queueVoice(key: string, id: string) {
    if (voiceJobs.current.has(id)) return;
    const clip = pendingStore.current.get(key)?.find((x) => x.id === id);
    if (!clip?.voice) return;
    voiceJobs.current.add(id);
    setError(null);
    changePending(key, (items) => items.map((x) => x.id === id ? { ...x, state: "uploading", error: undefined } : x));
    setVoiceStatus("Sending voice message…");
    voiceQueue.current = voiceQueue.current.then(async () => {
      let outcome = "Voice message removed";
      try {
        if (!voiceMounted.current || !pendingStore.current.get(key)?.some((x) => x.id === id)) return;
        if (clip.file.size > MAX_FILE_BYTES) throw new Error("Recording exceeds 25 MB.");
        await persistVoice(key, id);
        const bytes = new Uint8Array(await clip.file.arrayBuffer());
        const media = clip.media ?? await invoke<MediaRef>("media_upload", bytes, { headers: { "x-filename": encodeURIComponent(clip.file.name), "x-file-mime": clip.file.type } });
        changePending(key, (items) => items.map((x) => x.id === id ? { ...x, media } : x));
        if (!voiceMounted.current || !pendingStore.current.get(key)?.some((x) => x.id === id)) return;
        await persistVoice(key, id);
        const destination = clip.voice!;
        const roomMembers = await invoke<Member[]>("get_members", { channel: destination.channel });
        const uni = findUniMember(roomMembers);
        if (!voiceMounted.current || !pendingStore.current.get(key)?.some((x) => x.id === id)) return;
        const args = { channel: destination.channel, body: "", replyTo: destination.replyTo, recipients: destination.notifyUni && uni ? [uni.pubkey] : [], media: [media] };
        const signedEvent = clip.signedEvent ?? await invoke<string>("prepare_voice_message", args);
        changePending(key, items => items.map(x => x.id === id ? { ...x, signedEvent } : x));
        await persistVoice(key, id);
        if (!voiceMounted.current || !pendingStore.current.get(key)?.some(x => x.id === id)) return;
        try { await invoke<Message>("post_message", { ...args, signedEvent }); }
        catch (e) { if (!relayAccepted(e)) throw e; }
        await voiceOutbox.current.remove(id);
        if (!voiceMounted.current) return;
        removeFile(key, id);
        setTick((n) => n + 1);
        outcome = "Voice message sent";
        void loadRooms().catch(() => {});
      } catch (e) {
        if (!voiceMounted.current) return;
        changePending(key, (items) => items.map((x) => x.id === id ? { ...x, state: "error", error: String(e) } : x));
        await persistVoice(key, id);
        setError(`Voice message failed: ${String(e)}. Retry or remove the recording.`);
        outcome = "Voice message failed";
      } finally {
        voiceJobs.current.delete(id);
        if (voiceMounted.current) setVoiceStatus(voiceJobs.current.size ? "Sending voice message…" : outcome);
      }
    });
  }
  type RecordingOrigin = { key: string; tabId: string; title: string; channel: string; replyTo: string | null; notifyUni: boolean };
  const recordingOrigin = useRef<RecordingOrigin | null>(null);
  const recorder = useRecorder((blob, mime, origin: RecordingOrigin) => {
    if (recordingOrigin.current === origin) recordingOrigin.current = null;
    if (!blob.size) { setError("Recording was empty. Please record again."); return; }
    const file = new File([blob], voiceFileName(mime), { type: mime.split(";")[0] });
    const id = crypto.randomUUID();
    changePending(origin.key, (items) => [...items, { id, file, preview: null, state: "uploading", created: (voiceCreated.current = Math.max(Date.now(), voiceCreated.current + 1)), voice: { channel: origin.channel, replyTo: origin.replyTo, notifyUni: origin.notifyUni } }]);
    void (async () => { await voiceRestored.current; await persistVoice(origin.key, id); if (voiceMounted.current) queueVoice(origin.key, id); })();
  }, `for #${rooms.find((r) => r.id === channel)?.name ?? "room"}`);
  async function toggleRecording() {
    if (sendingRef.current) return;
    if (recordingOrigin.current) {
      if (recordingOrigin.current.key !== scope()) { setError(`Already recording for ${recordingOrigin.current.title}. Stop from the recording pill first.`); return; }
      if (recorder.recording) recorder.stop();
      return;
    }
    if (recorder.isBusy()) return;
    const key = scope(), tab = activeTab(tabsRef.current);
    if (!key || !tab) return;
    setError(null);
    if (!channel) return;
    const target = root ? replyTo ?? (messages.some((m) => m.ref === root) ? root : messages[messages.length - 1]?.ref ?? null) : null;
    if (root && !target) { setError("Thread not in local cache. Refresh before replying."); return; }
    const origin = { key, tabId: tab.id, title: tab.title, channel, replyTo: target, notifyUni };
    recordingOrigin.current = origin;
    try { if (!await recorder.start(origin) && recordingOrigin.current === origin) recordingOrigin.current = null; }
    catch (e) { if (recordingOrigin.current === origin) recordingOrigin.current = null; setError(`Microphone unavailable: ${String(e)}`); }
  }
  function onPasteFiles(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.files);
    if (files.length) { e.preventDefault(); addFiles(files); }
  }
  function onDropFiles(e: React.DragEvent) {
    e.preventDefault();
    if (!sending) addFiles(Array.from(e.dataTransfer.files));
  }
  // Only edits advance identity. Saving/restoring a scope is not an edit, and
  // an edit back to the submitted text must still count as a new draft.
  function editDraft(key: string, text: string) {
    drafts.current.set(key, text);
    draftRevisions.current.set(key, (draftRevisions.current.get(key) ?? 0) + 1);
  }

  function updateDraft(text: string, caret: number | null) {
    setDraft(text);
    const now = Date.now();
    if (text.trim() && channel && now - lastTypingSent.current > TYPING_SEND_MS) {
      lastTypingSent.current = now;
      void invoke("send_typing", { channel, root: root ?? null, parent: replyTo ?? root ?? null }).catch(() => {});
    }
    const key = scope();
    if (key) editDraft(key, text);
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
    if (key) editDraft(key, next.text);
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
    // Touch/mobile keyboards own Enter, including while mentions are open.
    // Do not infer this from viewport width: a narrow desktop keeps shortcuts.
    if (e.key === "Enter" && enterInsertsNewline(navigator.maxTouchPoints, window.matchMedia("(pointer: coarse)").matches)) return;
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
    const threadRoot = m.root && messages.some((x) => x.ref === m.root) ? m.root : m.ref;
    openTarget({ kind: "thread", channel: m.channel, root: threadRoot, title: `Thread · ${roomsRef.current.find((r) => r.id === m.channel)?.name ?? "Room"}` }, "new");
  }

  async function send() {
    // Refs/session state cover events before React commits the disabled controls.
    if (!channel || activeScope.current !== keyFor(channel, root) || sendingRef.current ||
        recordingOrigin.current || recorder.isBusy() || (!draft.trim() && !pending.length)) return;
    const files = manualAttachments(pendingStore.current.get(keyFor(channel, root)) ?? []);
    if ((!draft.trim() && !files.length) || files.some(attachmentBlocksSend)) {
      setError("Wait for uploads to finish or retry or remove failed files."); return;
    }
    const sentIds = files.map((f) => f.id);
    const snapshot = draft;
    const key = keyFor(channel, root);
    const revision = draftRevisions.current.get(key) ?? 0;
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
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      await invoke<Message>("post_message", { channel, body: snapshot, replyTo: target, recipients, media: files.map((f) => f.media!) });
      changePending(key, (items) => {
        for (const item of items) if (sentIds.includes(item.id) && item.preview) URL.revokeObjectURL(item.preview);
        return items.filter((item) => !sentIds.includes(item.id));
      });
      // Do not erase text typed during an in-flight send or in another room.
      if ((draftRevisions.current.get(key) ?? 0) === revision) {
        editDraft(key, "");
        bindingStore.current.set(key, new Map());
        if (activeScope.current === key) {
          setDraft("");
          bindingsRef.current = new Map();
          setBindings(bindingsRef.current);
        }
      }
      if (activeScope.current === key) {
        setRawKey("");
        setReplyTo(null);
      }
      // Re-read through the room effect, which drops the result if the
      // user has switched rooms meanwhile.
      setTick((n) => n + 1);
      await loadRooms();
      setStatus(recipients.length ? `Message accepted by relay · notified ${recipients.length}` : "Message accepted by relay");
    } catch (e) {
      setError(String(e));
    }
    finally { sendingRef.current = false; setSending(false); }
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
    try { await invoke("identity_forget");
      forgetDrafts(); invalidatePaths();
      try { for (const key of Object.keys(localStorage)) if (key.startsWith("uni.noteDraft.v1:") || key.startsWith("uni.vaultExpanded.v1:") || key === ALIASES_KEY) localStorage.removeItem(key); } catch { /* unavailable storage */ }
      onForget(); } catch (e) { setError(String(e)); }
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
  // A top-level note Back closes its tab and returns to the last used tab.
  const backTo = activeTab(tabs)?.kind === "note" && tabs.active ? nextAfterClose(tabs, tabs.active)?.title ?? "Conversations"
    : journalOpen ? "Journal" : currentRoom ? (isThread ? `Thread in ${currentRoom.name}` : currentRoom.name) : searchOpen ? "Search" : "Conversations";

  // Android back gesture/button: step back through the app (note stack,
  // search, thread, Journal, room) before leaving it. The listener is only
  // registered while there is somewhere to go back to, so at the room list
  // the system default runs (the app goes to the background, as usual).
  const goBack = useRef<() => void>(() => {});
  goBack.current = () => {
    if (journalFocus) { setJournalFocus(false); return; }
    if (panel) { setPanel(null); return; }
    if (searchOpen) { setSearchOpen(false); return; }
    if (notes.length) { closeNote(); return; }
    if (root && channel) { openTarget(roomTarget(channel), "focus"); return; }
    // On narrow screens the sidebar is a view, not a tab close.
    setPanel("rooms");
  };
  const canGoBack = !!panel || journalFocus || notes.length > 0 || searchOpen || !sidebarVisible;
  // Desktop tab shortcuts. On macOS the native menu owns Cmd+W; it emits
  // uni://close-tab from Rust, so the WebView never closes the window.
  const closeActiveRef = useRef(() => {});
  const focusTabRef = useRef((_id: string) => {});
  const lastClose = useRef(0);
  closeActiveRef.current = () => {
    if (creating || confirmation) return;
    // A native menu event and a WebView keydown can both report one Cmd+W.
    if (Date.now() - lastClose.current < 120) return;
    lastClose.current = Date.now();
    if (tabsRef.current.active) closeTabById(tabsRef.current.active);
  };
  focusTabRef.current = focusTabById;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === "w") { e.preventDefault(); closeActiveRef.current(); }
      else if (/^[1-9]$/.test(e.key)) {
        const t = tabForDigit(tabsRef.current, Number(e.key));
        if (t) { e.preventDefault(); focusTabRef.current(t.id); }
      }
    };
    window.addEventListener("keydown", onKey);
    const un = listen("uni://close-tab", () => closeActiveRef.current());
    return () => { window.removeEventListener("keydown", onKey); void un.then((off) => off()); };
  }, []);
  useEffect(() => {
    if (!canGoBack) return;
    let off: (() => void) | null = null, dead = false;
    onBackButtonPress(() => goBack.current())
      .then((l) => { if (dead) void l.unregister(); else off = () => void l.unregister(); })
      .catch(() => { /* desktop / browser: no back button */ });
    return () => { dead = true; off?.(); };
  }, [canGoBack]);
  const active = activeTab(tabs);
  function startLongPress(target: TabTarget) {
    longPressed.current = false;
    if (longPress.current) window.clearTimeout(longPress.current);
    longPress.current = window.setTimeout(() => {
      longPressed.current = true;
      pickNewTab.current = false;
      openTarget(target, "new");
    }, 500);
  }
  function endLongPress() {
    if (longPress.current) window.clearTimeout(longPress.current);
    longPress.current = null;
  }
  function sidebarClick(target: TabTarget, e: React.MouseEvent) {
    if (longPressed.current) { longPressed.current = false; return; }
    const asNew = pickNewTab.current || e.metaKey || e.ctrlKey;
    pickNewTab.current = false;
    openTarget(target, asNew ? "new" : "focus");
  }
  const journalTab = tabs.tabs.find((t) => t.kind === "journal");
  const primaryVault = vaults.includes("uni") ? "uni" : null;
  const otherVaults = vaults.filter((vault) => vault !== "uni");
  const activeOtherVault = active?.kind === "vault" && active.vault && active.vault !== "uni" && otherVaults.includes(active.vault) ? active.vault : null;
  function toggleOtherVaults() {
    const next = !otherVaultsExpanded;
    setOtherVaultsExpanded(next);
    try { localStorage.setItem(OTHER_VAULTS_KEY, String(next)); } catch { /* Storage may be unavailable. */ }
  }
  const vaultRow = (vault: string) => <button key={vault} className={`room ${active?.kind === "vault" && active.vault === vault ? "selected" : ""}`} aria-label={vault}
    aria-current={active?.kind === "vault" && active.vault === vault ? "page" : undefined}
    onClick={() => openTarget({ kind: "vault", vault, title: vault }, "new")}><span className="avatar" aria-hidden="true">▤</span><span className="room-text"><strong>{vault}</strong></span></button>;
  const recordingTab = recordingOrigin.current;
  const pill = recordingTab && recorder.busy ? { title: recordingTab.title, elapsed: recorder.elapsed, tabId: recordingTab.tabId, stop: recorder.stop, phase: recorder.phase } :
    journalRecording && journalTab ? { title: "Journal", elapsed: journalRecording.elapsed, tabId: journalTab.id, stop: journalRecording.stop, phase: "recording" as const } : null;
  return <NoteOpener.Provider value={openNote}><main className={`shell ${(!sidebarVisible && (channel || journalOpen || (active?.kind === "note" || active?.kind === "vault"))) ? "in-room" : ""} ${topNote ? "note-open" : ""} ${panel ? `panel-open panel-${panel}` : ""} ${searchOpen ? "search-open" : ""} ${composerFocused ? "composer-focused" : ""} ${journalFocus && journalOpen ? "journal-focus" : ""}`}>
    <nav className="rail" aria-label="Main navigation">
      <button aria-label="Uni" aria-current={!panel && !searchOpen && (!topNote && !journalOpen && channel === findUniRoom(rooms)?.id ? "page" : undefined)} onClick={() => { const uni = findUniRoom(rooms); if (uni) openTarget(roomTarget(uni.id)); }}><i><UniIcon /></i><span>Uni</span></button>
      <button aria-label="Journal" aria-current={!panel && !searchOpen && (journalOpen && !topNote ? "page" : undefined)} onClick={() => openTarget({ kind: "journal", title: "Journal" })}><i><JournalIcon /></i><span>Journal</span></button>
      <button aria-label="For you" aria-current={!panel && !searchOpen && (topNote?.ref === FOR_YOU_ID ? "page" : undefined)} onClick={openForYou}><i><StarIcon /><b className="rail-count">{forYou.count}</b>{forYou.fresh && <span className="rail-dot" aria-label="Updated recommendations" />}</i><span>For you</span></button>
      <button aria-label="Rooms" aria-current={!panel && !searchOpen && (!topNote && !journalOpen && channel && channel !== findUniRoom(rooms)?.id ? "page" : undefined)} aria-expanded={panel === "rooms"} onClick={() => { setSearchOpen(false); setPanel(panel === "rooms" ? null : "rooms"); }}><i><RoomsIcon /></i><span>Rooms</span>{rooms.some((r) => r.unread > 0) && <span className="rail-dot" aria-label="Unread rooms" />}</button>
      <button className="rail-vault" aria-label="Vault" aria-current={!panel && !searchOpen && (active?.kind === "vault" || (topNote && topNote.ref !== FOR_YOU_ID) ? "page" : undefined)} aria-expanded={panel === "vault"} onClick={() => { setSearchOpen(false); setPanel(panel === "vault" ? null : "vault"); }}><i>▤</i><span>Vault</span></button>
      <button className="rail-search" aria-label="Search" aria-expanded={searchOpen} onClick={() => { setPanel(null); setSearchQuery(""); setSearchScope({ vault: "", prefix: "" }); setSearchOpen(true); }}><i>⌕</i><span>Search</span></button>
      <button className="rail-settings" aria-label="Settings" aria-expanded={panel === "settings"} onClick={() => { setSearchOpen(false); setPanel(panel === "settings" ? null : "settings"); setForgetArmed(false); }}><i><SettingsIcon /></i><span>Settings</span></button>
    </nav>
    {(panel || searchOpen) && <button className="panel-scrim" aria-label="Close navigation panel" onClick={() => { setPanel(null); setSearchOpen(false); }} />}
    <aside className="rooms" aria-label="Conversations">
      {(panel || searchOpen) && <button className="panel-close icon-button" aria-label="Close panel" onClick={() => { setPanel(null); setSearchOpen(false); }}>×</button>}
      <div className="landscape-panel-surfaces"><button onClick={() => { const uni = findUniRoom(rooms); if (uni) openTarget(roomTarget(uni.id)); }}><UniIcon />Uni</button><button onClick={() => openTarget({ kind: "journal", title: "Journal" })}><JournalIcon />Journal</button><button onClick={openForYou}><StarIcon />For you</button><button onClick={() => { setPanel("settings"); }}><SettingsIcon />Settings</button></div>
      <div className="phone-panel-tools"><button onClick={() => { setPanel("vault"); setSearchOpen(false); }}>Vault</button><button onClick={() => { setPanel(null); setSearchOpen(true); }}>Search</button></div>
      <header className="rooms-header"><div><span className="eyebrow">Unforced</span><h1>Uni</h1></div><div><button className="icon-button" onClick={() => { setSearchQuery(""); setSearchScope({ vault: "", prefix: "" }); setSearchOpen(true); }} aria-label="Search messages and notes">⌕</button><button className="icon-button" onClick={() => void refresh()} disabled={busy} aria-label="Refresh conversations">↻</button><button className="icon-button" onClick={() => { setPanel(panel === "settings" ? "rooms" : "settings"); setSearchOpen(false); setForgetArmed(false); }} aria-label="Settings" aria-expanded={panel === "settings"}><SettingsIcon /></button></div></header>
      {pairSourceOpen && <PairSource onClose={() => setPairSourceOpen(false)} />}
      {panel === "settings" && <div className="settings"><UpdateSettings /><PairDeviceButton onOpen={() => setPairSourceOpen(true)} /><button className="pairing-secondary" onClick={() => void forget()}>{forgetArmed ? "Tap again to forget — you'll need to re-pair" : "Forget this device key"}</button>{forgetArmed && <button className="pairing-secondary" onClick={() => setForgetArmed(false)}>Keep key</button>}</div>}
      {searchOpen && <Search initialQuery={searchQuery} vaults={vaults} key={`${searchScope.vault}:${searchScope.prefix}`} initialVault={searchScope.vault} initialPathPrefix={searchScope.prefix} onOpen={openHit} onOpenNote={(n) => { setSearchOpen(false); openNote({ hub: null, vault: n.vault, ref: n.id }, null); }} onAskUni={askUniSearch} onClose={() => { setSearchOpen(false); if (topNote) setSidebarVisible(false); }} />}
      {searchOpen && error && <p className="error search-error" role="alert">{error}</p>}
      <div className="rooms-body" hidden={searchOpen}>
      <p className="connection" role="status">{status}{live ? <span className={`live ${live === "Live" ? "on" : ""}`}> · {live}</span> : null}</p>
      {identity && <p className="identity" title={npub ?? identity}>{myName ? <>Signed in as <strong>{myName}</strong></> : <>Public key <code>{npub ? `${npub.slice(0, 14)}…${npub.slice(-6)}` : `${identity.slice(0, 12)}…`}</code></>}<button className="identity-copy" onClick={() => void copyText(npub ?? identity, "Copied public key")} aria-label="Copy your public key">⧉</button></p>}
      {!ready && <p className="empty">Loading…</p>}
      {ready && rooms.length === 0 && <p className="empty">No joined conversations cached. Refresh to connect with your personal Buzz key.</p>}
      <section className="vault-sidebar" aria-label="Vaults"><div className="vault-heading"><h2>Vaults</h2><button className="note-quiet" onClick={() => setVaultRefresh((n) => n + 1)}>Refresh</button></div>
        {vaultError && <p className="error" role="alert">{vaultError}</p>}
        {primaryVault && vaultRow(primaryVault)}
        {otherVaults.length > 0 && <>
          <button className={`vault-toggle ${activeOtherVault ? "selected" : ""}`} type="button" aria-expanded={otherVaultsExpanded} aria-controls="other-vault-list"
            aria-label={`Other vaults (${otherVaults.length})${activeOtherVault ? `, current vault ${activeOtherVault}` : ""}`}
            onClick={toggleOtherVaults}>Other vaults ({otherVaults.length})</button>
          <div id="other-vault-list" hidden={!otherVaultsExpanded}>{otherVaults.map(vaultRow)}</div>
        </>}
      </section>
      <nav>{rooms.map((room) => <button key={room.id} className={`room ${channel === room.id ? "selected" : ""}`} onClick={(e) => sidebarClick(roomTarget(room.id), e)}
        onPointerDown={(e) => { if (e.pointerType === "touch") startLongPress(roomTarget(room.id)); }} onPointerUp={endLongPress} onPointerCancel={endLongPress} onPointerLeave={endLongPress}
        aria-current={channel === room.id ? "page" : undefined}>
        <span className="avatar">{room.name[0]?.toUpperCase() ?? "#"}</span><span className="room-text"><strong className={room.unread ? "unread" : ""}>{room.name}</strong><small>{room.last_message ? markdownToText(room.last_message) : "No messages yet"}</small></span>
        <span className="room-side"><time>{room.last_ts ? time(room.last_ts) : ""}</time>{room.unread > 0 && <span className={`unread-badge ${room.mentions ? "mention" : ""}`} aria-label={`${room.unread} unread${room.mentions ? ", mentions you" : ""}`}>{room.mentions ? "@ " : ""}{room.unread > 99 ? "99+" : room.unread}</span>}</span>
      </button>)}</nav>
      </div>
    </aside>
    <section className="conversation" aria-label={journalOpen ? "Journal" : currentRoom ? `Conversation: ${currentRoom.name}` : active?.kind === "note" ? "Note" : "Conversation"}>
      <div className="tab-strip" role="tablist" aria-label="Open tabs">
        <div className="tab-scroller">{tabs.tabs.map((t) => <div key={t.id} className={`tab-chip ${t.id === tabs.active ? "active" : ""}`} role="presentation"
          onPointerDown={(e) => { if (e.pointerType === "touch") { longPressed.current = false; longPress.current = window.setTimeout(() => { longPressed.current = true; closeTabById(t.id); }, 600); } }}
          onPointerUp={endLongPress} onPointerCancel={endLongPress} onPointerLeave={endLongPress}>
          <button className="tab-title" role="tab" aria-selected={t.id === tabs.active} onClick={() => { if (longPressed.current) { longPressed.current = false; return; } focusTabById(t.id); }} title={t.title}>{t.kind === "journal" ? "❋" : (t.kind === "note" || t.kind === "vault") ? "▤" : t.kind === "thread" ? "↳" : "#"} {isTabDirty(t) && <span aria-label="Unsaved changes">● </span>}{t.title}</button>
          <button className="tab-close" onClick={() => closeTabById(t.id)} aria-label={`Close ${t.title}`}>×</button>
        </div>)}</div>
        <button className="tab-add" onClick={() => { pickNewTab.current = true; setPanel("rooms"); setSearchOpen(false); setSidebarVisible(true); document.querySelector<HTMLButtonElement>(".rooms nav .room")?.focus(); }} aria-label="New tab — pick a room" title="New tab — pick a room">+</button>
      </div>
      {journalTab && <div className="journal-tab-content" hidden={!journalOpen} onFocusCapture={(e) => { if (e.target instanceof HTMLTextAreaElement) requestAnimationFrame(() => setComposerFocused(true)); }} onBlurCapture={(e) => { const journal = e.currentTarget; requestAnimationFrame(() => setComposerFocused(journal.contains(document.activeElement) && document.activeElement instanceof HTMLTextAreaElement)); }}><Journal focus={journalFocus} onFocus={() => setJournalFocus((v) => !v)} rooms={rooms} uniRoomId={findUniRoom(rooms)?.id ?? null} onShare={shareEntry} onBack={() => setPanel("rooms")} onRecordingChange={(on, elapsed, stop) => { journalRecordingRef.current = on; setJournalRecording(on ? { elapsed, stop } : null); }} /></div>}
      {active?.kind === "vault" && active.vault ? <VaultBrowser key={active.vault} vault={active.vault} onBack={() => setPanel("rooms")} onOpen={(note) => openTarget({ kind: "note", note: { hub: null, vault: active.vault!, ref: note.id }, title: note.path || note.id }, "new")} onCreate={(folder) => requestCreate(active.vault!, folder)} onSearch={(prefix) => { setSearchQuery(""); setSearchScope({ vault: active.vault!, prefix }); setSearchOpen(true); setSidebarVisible(true); }} />
      : journalOpen ? null
      : currentRoom ? <>
        <header className="conversation-header">
          <button className="back icon-button" onClick={() => isThread && channel ? openTarget(roomTarget(channel), "focus") : setPanel("rooms")} aria-label={isThread ? "Back to room" : "Back to conversations"}>‹</button>
          {isThread && <button className="thread-back" onClick={() => channel && openTarget(roomTarget(channel), "focus")} aria-label="Back to room">‹ {currentRoom.name}</button>}
          <div><strong>{isThread ? "Thread" : currentRoom.name}</strong><small>{isThread ? `${threadReplies.length} ${threadReplies.length === 1 ? "reply" : "replies"} · in ${currentRoom.name}` : `Buzz conversation · ${members.length ? `${members.length} members` : "cached locally"}`}</small></div>
          <button className="icon-button" onClick={() => void refresh()} disabled={busy} aria-label="Refresh messages">↻</button>
        </header>
        <div className="message-list" ref={setList} role="log" aria-label="Messages" aria-live="polite">
          <div className="message-stack" ref={setStackEl}>
            {timeline}
            <div ref={scrollEnd} />
          </div>
        </div>
        <footer onFocusCapture={() => requestAnimationFrame(() => setComposerFocused(true))} onBlurCapture={(e) => { const composer = e.currentTarget; requestAnimationFrame(() => setComposerFocused(composer.contains(document.activeElement))); }} className="composer" onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={onDropFiles}>
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
              <span className="compose-file-info" onClick={() => item.error && setError(`${item.file.name}: ${item.error}`)} title={item.error ?? undefined}><strong>{item.file.name}</strong><small>{formatSize(item.file.size)} · {item.state === "ready" ? "Ready" : item.state === "uploading" ? "Uploading…" : `Failed: ${item.error}`}</small>{item.state === "uploading" && <progress aria-label={`Uploading ${item.file.name}`} />}</span>
              {item.state === "error" && <button className="compose-file-retry" onClick={() => item.voice ? queueVoice(keyFor(currentRoom.id, root), item.id) : void uploadFile(keyFor(currentRoom.id, root), item.id, item.file)} aria-label={`Retry upload ${item.file.name}`}>Retry</button>}
              <button className="compose-file-remove" disabled={sending} onClick={() => removeFile(keyFor(currentRoom.id, root), item.id)} aria-label={`Remove ${item.file.name}`}>×</button>
            </div>)}
          </div>}
          {voiceStorageWarning && <p role="status">{voiceStorageWarning}</p>}
          {voiceStatus && <p className="voice-status" role="status">{voiceStatus}</p>}
          <div className="compose-row">
            <ComposerMenu key={`${channel}:${root}`} onMention={startMention} onAttach={() => fileInput.current?.click()} sending={sending} />
            <textarea ref={composerInput} aria-label={`Message ${currentRoom.name}`} value={draft} onChange={(e) => updateDraft(e.target.value, e.target.selectionStart)} onPaste={onPasteFiles} onSelect={(e) => syncPicker(e.currentTarget.value, e.currentTarget.selectionStart)} onBlur={() => setPicker(null)} onKeyDown={onKeyDown} maxLength={65536} rows={1} placeholder={isThread ? "Reply in thread…" : "Message Uni…"} />
            <button className={`address-toggle compose-icon mic ${recorder.recording && recordingOrigin.current?.key === scope() ? "recording" : ""}`} onClick={() => void toggleRecording()} disabled={sending || (recorder.busy && (!recorder.recording || recordingOrigin.current?.key !== scope()))} aria-pressed={recorder.recording && recordingOrigin.current?.key === scope()} aria-label={recorder.recording && recordingOrigin.current?.key === scope() ? "Stop recording voice message" : "Record a voice message"} title={recorder.recording && recordingOrigin.current?.key === scope() ? "Stop recording" : "Voice message"}>
              {recorder.recording && recordingOrigin.current?.key === scope() ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" fill="currentColor" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>}
            </button>
            <button className="send compose-icon" disabled={(!draft.trim() && !pending.some((f) => !f.voice && f.state === "ready")) || manualAttachments(pending).some(attachmentBlocksSend) || sending || recorder.busy} onClick={() => void send()} aria-label="Send message" title={sending ? "Sending…" : "Send message"} aria-busy={sending}>
              {sending ? <span aria-hidden="true">…</span> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7 7 7M12 5v14" /></svg>}
            </button>
          </div>
          <p className="compose-hint">Enter to send · Shift+Enter for a new line · @ to mention · <button className="link" onClick={() => setAdvancedOpen(!advancedOpen)}>{advancedOpen ? "hide raw key" : "raw key…"}</button></p>
        </footer>
      </> : <div className="welcome"><span className="welcome-mark">✦</span><h2>Your conversation starts here</h2><p>Select a room to read and reply. Messages are cached for offline reading.</p></div>}
    </section>
    {pill && <div className={`recording-pill ${sidebarVisible ? "over-sidebar" : ""}`} role="status" aria-live="polite">
      <span className="recording-dot" aria-hidden="true">●</span><span>{pill.phase === "recording" ? mmss(pill.elapsed) : pill.phase === "starting" ? "Starting…" : "Finishing…"}</span>
      <span className="recording-separator" aria-hidden="true">·</span>
      <button className="recording-destination" onClick={() => focusTabById(pill.tabId)} aria-label={`Jump to recording in ${pill.title}`}>{pill.title}</button>
      <span className="recording-separator" aria-hidden="true">·</span>
      <button className="recording-stop" onClick={pill.stop} disabled={pill.phase !== "recording"} aria-label={`Stop recording for ${pill.title}`}>Stop</button>
    </div>}
    {/* The note sheet leaves the tab strip visible above it; Back pops the
        note's own stack (or closes the tab at the first note). */}
    {topNote && !searchOpen && <section className="note-sheet" role="region" aria-label="Note">
      <NoteView key={`${tabs.active}:${notes.length}:${noteKey(topNote)}:${topNote.ref === FOR_YOU_ID ? forYouReload : 0}`} target={topNote} onSearch={(query) => { setSidebarVisible(true); setSearchQuery(query); setSearchScope({ vault: "", prefix: "" }); setSearchOpen(true); }} hub={hub} onOpen={openNote} onBack={() => { if (topNote.ref === FOR_YOU_ID && forYouReturn.current && tabsRef.current.tabs.some((t) => t.id === forYouReturn.current)) focusTabById(forYouReturn.current); else closeNote(); }}
        onResolved={(id) => {
          if (tabsRef.current.active) commitTabs(updateTab(tabsRef.current, tabsRef.current.active, { note: { hub: null, vault: topNote.vault, ref: id } }));
          aliases.current[JSON.stringify([topNote.vault, topNote.ref])] = id;
          try { localStorage.setItem(ALIASES_KEY, JSON.stringify(aliases.current)); } catch { /* session alias remains */ }
        }}
        onRendered={(note) => {
          if (topNote.vault !== "uni" || note.id !== FOR_YOU_ID) return;
          const updatedAt = note.updatedAt ?? null;
          renderedForYou.current = updatedAt;
          if (updatedAt) {
            try { localStorage.setItem(FOR_YOU_OPENED_KEY, updatedAt); } catch { /* unavailable storage */ }
          }
          setForYou((known) => isRecommendationNew(known.updatedAt, updatedAt)
            ? { ...known, fresh: true }
            : { count: countRecommendations(note.content ?? ""), updatedAt, fresh: false });
        }}
        startEditing={editOnOpen.current.has(noteKey(topNote))}
        onDirty={(dirty) => { reportDirty(tabs.active!, noteKey(topNote), dirty); if (!dirty) editOnOpen.current.delete(noteKey(topNote)); }}
        onCreate={(folder) => requestCreate(topNote.vault, folder)}
        backLabel={topNote.ref === FOR_YOU_ID ? forYouBack.current : notes.length > 1 ? noteTitles[noteKey(notes[notes.length - 2])] ?? notes[notes.length - 2].ref.split("/").pop() ?? "note" : backTo}
        onTitle={(t) => rememberTitle(noteKey(topNote), t)} />
    </section>}
    {creating && <SurfaceModal onCancel={() => { if (!createBusy) setCreating(null); }}><form role="dialog" aria-modal="true" aria-label="New note" onSubmit={(e) => { e.preventDefault(); void createNote(); }}><h2>New note in {creating.vault}</h2><label>Path<input autoFocus value={creating.path} disabled={createBusy} onChange={(e) => setCreating({ ...creating, path: e.target.value })} /></label>{createError && <p className="error" role="alert">{createError}</p>}<button disabled={createBusy} type="submit">{createBusy ? "Creating…" : "Create note"}</button><button disabled={createBusy} type="button" onClick={() => setCreating(null)}>Cancel</button></form></SurfaceModal>}
    {confirmation && <SurfaceModal onCancel={() => setConfirmation(null)}><div role="alertdialog" aria-modal="true" aria-label="Confirm tab close">{confirmation.notice && <p role="status">{confirmation.notice}</p>}<p>{confirmation.text}</p><button autoFocus onClick={() => { const run = confirmation.run; setConfirmation(null); run(); }}>Continue</button><button onClick={() => setConfirmation(null)}>Cancel</button></div></SurfaceModal>}
    {toast && <div className="toast" role="status">{toast}</div>}
  </main></NoteOpener.Provider>;
}

export default App;
