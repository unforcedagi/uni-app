import { mark } from "./startupTrace";
import { readMessages, readRooms, readWho, writeMessages, writeRooms, writeWho } from "./chatCache";
import { nodeOfRoom, useRoomNodes } from "./areas/roomLabels";
import { isNetworkError, netError } from "./netError";
import { voiceRetryDelay } from "./voiceRetry";
import { VoiceOutbox, relayAccepted } from "./voiceOutbox";
import { SettingsIcon, UniIcon, JournalIcon, StarIcon, MailIcon, CalendarIcon } from "./Icons";
import Mail from "./Mail";
import Calendar from "./calendar/Calendar";
import { calShown, forgetCalendar, onCalShown, probeCalendar } from "./calendar/calDoor";
import { forgetAreas } from "./areas/useAreas";
import { useLifeOsVault } from "./areas/useLifeOsVault";
import { activeProfile, effectiveLifeVault, showUniGlue } from "./areas/profile";
import { clearProjectBodies } from "./areas/projectBody";
import AreasSurface from "./areas/LifeOsSurface";
import type { Overlay } from "./areas/AreasSurface";
import { rootOpenMemory } from "./areas/rootMemory";
import { UNI_CHANNEL } from "./areas/treeCore";
import type { NoteRef } from "./areas/noteRefsCore";
import AreaSelfTest from "./interface/selftest/SelfTest";
import LifeOsVaultSetting from "./areas/LifeOsVaultSetting";
import { appendDraft } from "./areas/composeDraft";
import { openDialog } from "./areas/focusTrap";
import { FOR_YOU_ID, FOR_YOU_OPENED_KEY, countRecommendations, isRecommendationNew, readLastSurface, saveLastSurface } from "./railCore";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { announce, copyText, onCopied } from "./clipboard";
import { forgetChatDrafts, loadChatDraft, saveChatDraft } from "./chatDrafts";
import { markFor, restoreTop, type ScrollMark } from "./noteText";
import "./App.css";
import { Body } from "./MessageBody";
import { isMaintenance, isWorkerStatus, staleStatus, UPKEEP_LABEL } from "./chatMarkers";
import Pairing from "./Pairing";
import { emojiLabel, type Reaction } from "./reactions";
import { DeleteButton, InlineEditor } from "./InlineEditor";
import { lastOwnMessage } from "./ownMessages";
import { elapsed, workingOn } from "./working";

import { decisionIn, useDecisionLinks } from "./decisionLinks";
import { DecisionCard, forgetDecisions } from "./DecisionCard";
import { checkHeld, forgetHeld, heldCount, onHeldCount } from "./mailHeld";
import { decisionRefsIn, unreferenced } from "./decisionView";
import { findUniMember, findUniRoom, searchHandoffText } from "./uniActions";
import Search from "./Search";
import Journal from "./Journal";
import { mmss, shareText, type JournalNote } from "./journalCore";
import { useRecorder, voiceFileName } from "./recorder";
import { attachmentBlocksSend, enterInsertsNewline, manualAttachments } from "./composerCore";
import PairSource, { PairDeviceButton } from "./PairSource";
import { UpdateSettings } from "./UpdateNotice";
import { watchLostIpc } from "./ipcLost";
import { currentUserAgent, platformName } from "./interface/selftest/gate";
import { activeTab, closeTab, EMPTY_TABS, focusTab, isSurface, LAST_ROOM_KEY, lastRoomOf, restorePlace, LEGACY_TABS_KEY, migrateLegacyTabs, navigateNoteTab, nextAfterClose, openTab, persistable, recordingTabCanClose, restoreTabs, serializeTabs, updateTab, TABS_KEY, type Tabs, type Tab, type TabTarget, type OpenMode } from "./tabs";
import { canBack as histCanBack, canForward as histCanForward, EMPTY_HISTORY, placeKey, RECENT_SHOWN, recent as histRecent, step as histStep, visit as histVisit, type History } from "./navHistory";
import { NavContext, type NavControls } from "./navContext";
import { useRailHidden } from "./areas/homeLayout";
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
import { attachmentKind, formatSize } from "./media";
import { Attachments, attachmentBody, useRelayOrigin, type MediaRef } from "./Attachments";
import { activeQuery, filterMembers, insertMention, memberLabels, pruneBindings, resolveRecipients, type Bindings, type Member } from "./mentions";
import { SmallLine } from "./areas/Companion";
import { SecretRequestCard } from "./SecretRequestCard";
import { EnrollmentLine, SealedApprovals } from "./SealedApprovals";
import { parseEnrollment } from "./sealedCore";
import { parseSecretReceipt, parseSecretRequest, receiptFor, receiptsByRequest, secretCardsOn, withoutSecretBlock } from "./secretRequest";
import NotePane, { usePaneShape } from "./NotePane";
import { ApprovalsContext, useApprovals } from "./approvalsLive";
import { ApprovalBanner } from "./areas/ApprovalRows";
import type { Approval } from "./approvals";

type Room = { id: string; name: string; last_message: string | null; last_ts: number | null; mentions: boolean; unread: number };
type Message = { ref: string; channel: string; author: string; author_name: string; ts: number; body: string; mentions_me: boolean; root: string | null; parent: string | null; mentions: Member[]; reply_count: number; last_reply_ts: number | null; edited: boolean; reactions: Reaction[]; media?: MediaRef[] };
type LivePayload = { kind: "message" | "edit" | "delete" | "rooms" | "profiles" | "status" | "typing"; channel: string | null; status: string | null; author: string | null; root?: string | null; notify?: { author_name: string; preview: string } };
/** Buzz desktop: an indicator lives 8 s; send at most one every 3 s. */
const TYPING_TTL_MS = 8000;
const TYPING_SEND_MS = 3000;
/** How long a freshly opened room holds the newest message against late layout (images, older pages). */
const SETTLE_MS = 1500;
type IdentityStatus = { paired: boolean; pubkey: string | null };
type SyncResult = { pubkey: string; total_items: number; channel_errors: Record<string, string>; truncated_channels: string[] };

type PendingFile = { owner?: string; relay?: string; created?: number; signedEvent?: string; id: string; file: File; preview: string | null; state: "uploading" | "ready" | "error"; media?: MediaRef; error?: string; voice?: { channel: string; replyTo: string | null; notifyUni: boolean } };
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const OTHER_VAULTS_KEY = "uni:other-vaults-expanded";

const time = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const keyFor = (channel: string, root: string | null) => `${channel}:${root ?? "room"}`;
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
  /** The key could not be read (not the same as having none): say so and retry, never send the user to pairing. */
  const [keyError, setKeyError] = useState(false);
  const [check, setCheck] = useState(0);
  const [keySlow, setKeySlow] = useState(false);
  useEffect(() => {
    setKeyError(false); setKeySlow(false);
    let live = true;
    const slow = setTimeout(() => { if (live) setKeySlow(true); }, 8000);
    invoke<IdentityStatus>("identity_status").then((s) => { if (live) setPaired(s.paired); }).catch(() => { if (live) setKeyError(true); }).finally(() => clearTimeout(slow));
    return () => { live = false; clearTimeout(slow); };
  }, [check]);
  if (keyError) return <main className="pairing"><p className="empty key-error" role="alert">Couldn't read your key · <button type="button" className="pairing-secondary" onClick={() => setCheck((n) => n + 1)}>Retry</button></p></main>;
  // r19 (Codex 9): the first key check is bounded too: past 8 s it says so, with Retry
  if (paired === null) return <main className="pairing">{keySlow ? <p className="empty" role="status">Still checking your key · <button type="button" className="pairing-secondary" onClick={() => setCheck((n) => n + 1)}>Retry</button></p> : <p className="empty">Loading…</p>}</main>;
  if (!paired) return <Pairing onPaired={() => setPaired(true)} />;
  return <Conversations onForget={() => setPaired(false)} />;
}


type Picker = { start: number; query: string; index: number };

function ComposerMenu({ onMention, onAttach, onDiscard, canDiscard, sending }: { onMention: () => void; onAttach: () => void; onDiscard: () => void; canDiscard: boolean; sending: boolean }) {
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
      {/* T-132: the text only; an attachment has its own × */}
      <button role="menuitem" disabled={!canDiscard} onClick={() => { setOpen(false); trigger.current?.focus(); onDiscard(); }}><span aria-hidden="true">×</span> Discard draft</button>
    </div>}
  </div>;
}

/** A room's chat is what is on screen (a room, a thread, Uni or an area with its room) with no full-page note over it. */
function chatOnScreen(tab: { kind: string } | null, channel: string | null, fullPageNotes: number): boolean {
  return !!channel && !!tab && ["room", "thread", "areas", "area"].includes(tab.kind) && !fullPageNotes;
}

/** T-132: "Uni is working · 0:42" under the last message; only this line re-renders as its clock ticks. The clock is hidden from screen
 *  readers (the chat is a live region): they hear "Uni is working" once. */
function WorkingLine({ name, since }: { name: string; since: number }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  return <p className="working-line" role="status"><span className="working-dot" aria-hidden="true" /><span>{name} is working</span><span aria-hidden="true" className="working-clock"> · <time>{elapsed(now - since)}</time></span></p>;
}

/** T-200: scroll a list so the message `ref` sits `offset` px below its top. False when the message isn't in the list. */
function pinTo(list: HTMLElement, at: { ref: string; offset: number }): boolean {
  const m = list.querySelector(`[data-ref="${CSS.escape(at.ref)}"]`);
  if (!m) return false;
  list.scrollTop += m.getBoundingClientRect().top - list.getBoundingClientRect().top - at.offset;
  return true;
}

function resizeComposer(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  const style = getComputedStyle(el);
  // T-200: with a note open beside or over the chat the composer stops at three lines (a quote scrolls inside it), so it never squeezes the pane
  const lines = el.closest(".note-aside") ? 3 : 6;
  const maxHeight = parseFloat(style.lineHeight) * lines + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
}

function Conversations({ onForget }: { onForget: () => void }) {
  // The last rooms list on this device (per identity): a restored place resolves at once, before the first fetch.
  const whoRef = useRef<string | null>(readWho(localStorage));
  const [rooms, setRooms] = useState<Room[]>(() => readRooms<Room>(localStorage, whoRef.current));
  const [tabs, setTabs] = useState<Tabs>(() => openTab(EMPTY_TABS,
    readLastSurface(localStorage) === "journal" ? { kind: "journal", title: "Journal" } : { kind: "areas", title: "Uni" },
    "new", () => crypto.randomUUID()));
  const tabsRef = useRef<Tabs>(tabs);
  const areaBack = useRef<(() => void) | null>(null);
  /** Whether the open place has a Back of its own (a level up, the room tree): Android Back is the app's while it does. */
  const [hasAreaBack, setHasAreaBack] = useState(false);
  const setAreaBack = useCallback((back: (() => void) | null) => { areaBack.current = back; setHasAreaBack(!!back); }, []);
  /** What the room shell has open over the place (its task sheet, work view or drawer): every Back closes it first; a modal one holds history. */
  const overlayRef = useRef<Overlay | null>(null);
  const [hasOverlay, setHasOverlay] = useState(false);
  const setOverlay = useCallback((o: Overlay | null) => { overlayRef.current = o; setHasOverlay(!!o?.history); }, []);
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
  const [sidebarVisible, setSidebarVisible] = useState(() => window.matchMedia("(min-width: 600px)").matches);
  /** `nav`: the navigation panel where the rail is out of reach (short landscape screens): the surfaces, Vault, Search and the vaults. */
  const [panel, setPanel] = useState<"nav" | "vault" | "settings" | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  /** The rail is hidden on short windows up to 950px (one rule, r14): the room then shows its Places drawer. */
  const railHidden = useRailHidden();
  const forYouBack = useRef("Uni");
  const forYouReturn = useRef<string | null>(null);
  const [journalFocus, setJournalFocus] = useState(false);
  const [forYou, setForYou] = useState({ count: 0, fresh: false, updatedAt: null as string | null });
  const renderedForYou = useRef<string | null>(null);
  const [forYouReload, setForYouReload] = useState(0);
  const lifeVault = effectiveLifeVault(useLifeOsVault(), vaults); // PR 6: the For you pin is Uni glue, shown (and fetched) only while the selected vault is uni
  async function refreshForYou() {
    if (!showUniGlue(lifeVault)) return;
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
  // T-229: Calendar is on the rail once the calendar door has answered this device's key
  const calOn = useSyncExternalStore(onCalShown, calShown, calShown);
  useEffect(() => {
    const probe = () => { const now = new Date(); void probeCalendar(new Date(now.getTime() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"), now.toISOString().replace(/\.\d{3}Z$/, "Z")); };
    const soon = window.setTimeout(probe, 3000);
    return () => window.clearTimeout(soon);
  }, []);
  // T-213: Uni's sends held for you, counted on the rail's Mail button (Mail keeps the count current while it is open)
  const [held, setHeld] = useState(heldCount);
  useEffect(() => {
    const off = onHeldCount(setHeld);
    const soon = window.setTimeout(() => void checkHeld(60_000), 4000); // skipped when Mail has just listed them
    const visible = () => { if (document.visibilityState === "visible") void checkHeld(10 * 60_000); };
    document.addEventListener("visibilitychange", visible);
    return () => { off(); window.clearTimeout(soon); document.removeEventListener("visibilitychange", visible); };
  }, []);
  useEffect(() => {
    void refreshForYou();
    const visible = () => { if (document.visibilityState === "visible") void refreshForYou(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [lifeVault]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const [journalRecording, setJournalRecording] = useState<{ elapsed: number; stop: () => void } | null>(null);
  const journalRecordingRef = useRef(false);
  const [channel, setChannel] = useState<string | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  // T-176: Uni's secret-request cards (on unless "uni:secret-cards" is "off"), the keys trusted to ask, and what became of each request
  const [secretCards] = useState(secretCardsOn);
  const [secretRequesters, setSecretRequesters] = useState<string[]>([]);
  useEffect(() => { if (secretCards) invoke<string[]>("secret_requesters").then((k) => setSecretRequesters(k ?? [])).catch(() => {}); }, [secretCards]);
  const trustRequester = (channel: string, request: string) => invoke("secret_pin", { channel, request }).then(() => invoke<string[]>("secret_requesters")).then((k) => setSecretRequesters(k ?? [])).catch(() => {});
  const secretReceipts = useMemo(() => secretCards ? receiptsByRequest(messages) : new Map(), [secretCards, messages]);
  const [members, setMembers] = useState<Member[]>([]);
  const [identity, setIdentity] = useState<string | null>(null);
  useLayoutEffect(() => { clearProjectBodies(); }, [identity]);
  const [draft, setDraft] = useState("");
  const drafts = useRef(new Map<string, string>());
  const draftRevisions = useRef(new Map<string, number>());
  /** T-132: drafts are saved per identity; until it is known nothing is read or saved (what is typed meanwhile is saved when it is). */
  const identityRef = useRef<string | null>(null);
  const [draftStorageWarning, setDraftStorageWarning] = useState("");
  const [pending, setPending] = useState<PendingFile[]>([]);
  const pendingStore = useRef(new Map<string, PendingFile[]>());
  const voiceQueue = useRef(Promise.resolve());
  const voiceCreated = useRef(0);
  const voiceJobs = useRef(new Set<string>());
  const voiceRetryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const voiceRetryAttempts = useRef(new Map<string, number>());
  const [voiceStatus, setVoiceStatus] = useState("");
  const [voiceStorageWarning, setVoiceStorageWarning] = useState("");
  const voiceOutbox = useRef(new VoiceOutbox(() => setVoiceStorageWarning("Voice storage unavailable. Recordings are kept only until this app closes.")));
  const voiceRestored = useRef<Promise<void> | null>(null);
  useEffect(() => {
    voiceRestored.current ??= Promise.all([voiceOutbox.current.list(), invoke<string>("get_identity"), invoke<string>("relay_origin")]).then(([records, owner, relay]) => {
      for (const record of records) if (record.state === "delivered") void voiceOutbox.current.remove(record.id);
      const clips = records.filter(clip => clip.owner === owner && clip.relay === relay && clip.state !== "delivered");
      for (const clip of clips) {
        voiceCreated.current = Math.max(voiceCreated.current, clip.created);
        const item: PendingFile = { ...clip, error: clip.error, file: new File([clip.file], clip.filename, { type: clip.mime }), state: clip.state === "error" ? "error" : "uploading", preview: null };
        changePending(clip.key, items => items.some(x => x.id === clip.id) ? items : [...items, item]);
      }
      for (const clip of clips) if (voiceMounted.current && (clip.state !== "error" || isNetworkError(clip.error))) queueVoice(clip.key, clip.id);
    }).catch(e => setError(String(e)));
  }, []);
  const activeScope = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const voiceMounted = useRef(true);
  useEffect(() => {
    voiceMounted.current = true;
    const retry = () => {
      for (const [key, files] of pendingStore.current) {
        for (const clip of files) if (clip.voice && clip.state === "error" && isNetworkError(clip.error) && !voiceRetryTimers.current.has(clip.id)) queueVoice(key, clip.id);
      }
    };
    const visible = () => { if (document.visibilityState === "visible") retry(); };
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", visible);
    return () => {
      voiceMounted.current = false;
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", visible);
      for (const timer of voiceRetryTimers.current.values()) clearTimeout(timer);
      voiceRetryTimers.current.clear();
      for (const files of pendingStore.current.values()) for (const item of files) if (item.preview) URL.revokeObjectURL(item.preview);
    };
  }, []);
  const [bindings, setBindings] = useState<Bindings>(new Map());
  const bindingStore = useRef(new Map<string, Bindings>());
  const [picker, setPicker] = useState<Picker | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  /** r26 (Codex P1 3): the message being sent shows in its thread as "Sending…" the moment Send is pressed, until it is delivered (the draft stays in the composer meanwhile and is never lost) */
  const [outgoing, setOutgoing] = useState<{ key: string; body: string } | null>(null);
  const sendingRef = useRef(false);
  const [status, setStatus] = useState("Loading conversations…");
  /** The last sync's machinery (message count, per-room warnings): for Developer only (r18). */
  const [syncDetail, setSyncDetail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  /** The message whose ⋯ menu is open (T-124: nothing is shown under a message by default). */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  useEffect(() => {
    if (!menuFor) return;
    const away = (e: PointerEvent) => { if (!(e.target instanceof Element) || !e.target.closest(".message-more")) setMenuFor(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuFor(null); };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [menuFor]);
  // Our own message currently open in the inline editor.
  const [editing, setEditing] = useState<string | null>(null);
  // T-212: a message that names a decision (`uni:<id>`, or a room's `[decision T-NN]` marker) carries its card, tappable in the chat
  const decisions = useDecisionLinks();
  // Latest bindings for syncPicker (called in the same tick as setBindings).
  const bindingsRef = useRef<Bindings>(new Map());
  // Message actions go through a ref so the memoized list never holds stale closures.
  useEffect(() => { bindingsRef.current = bindings; }, [bindings]);
  // T-132: once the identity is known, the open room shows its saved draft, and what was typed before then is saved under it.
  // Another identity (never within one mount today: Forget unmounts) starts from its own drafts only.
  useEffect(() => {
    const prev = identityRef.current;
    identityRef.current = identity;
    if (!identity || prev === identity) return;
    if (prev) { drafts.current.clear(); bindingStore.current.clear(); }
    else for (const [key, text] of drafts.current) if (text) storeDraft(key, text, bindingStore.current.get(key));
    const key = activeScope.current;
    if (key && !drafts.current.has(key)) {
      setDraft(scopeDraft(key));
      bindingsRef.current = bindingStore.current.get(key) ?? new Map();
      setBindings(bindingsRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);
  const actions = useRef({ openThread: (_m: Message) => {}, loadOlder: () => {}, saveEdit: (_m: Message, _b: string): Promise<void> => Promise.resolve(), cancelEdit: () => {}, deleteOwn: (_m: Message): Promise<void> => Promise.resolve() });

  const [searchOpen, setSearchOpen] = useState(false);
  // r19: Search, Settings and Vault keep the one dialog contract the sheets and Places keep: focus in, Tab kept inside, what is under them inert
  // (the rail, which switches them, and their scrim excepted), Escape closes them, and focus goes back to what opened them
  const panelBox = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const utilityOpen = !!panel || searchOpen;
  useEffect(() => {
    const box = panelBox.current;
    if (!utilityOpen || !box) return;
    return openDialog(box, () => { setPanel(null); setSearchOpen(false); }, { keep: [railRef.current, box.parentElement?.querySelector(".panel-scrim") ?? null], initial: box });
  }, [utilityOpen]);
  // Search result to scroll to and flash once its room/thread has loaded.
  const [focusRef, setFocusRef] = useState<string | null>(null);
  /** r25: "Check in" opens a room at a message and keeps the sheet's question over the composer ("Checking: <step>") until it is dismissed or the room is left. */
  const [checking, setChecking] = useState<{ channel: string; text: string } | null>(null);
  const checkingSeen = useRef(false);
  useEffect(() => {
    if (!checking) { checkingSeen.current = false; return; }
    if (channel === checking.channel) checkingSeen.current = true;
    else if (checkingSeen.current) setChecking(null); // the room it was about is left
  }, [checking, channel]);
  const [journalOpen, setJournalOpen] = useState(activeTab(tabs)?.kind === "journal");
  const [npub, setNpub] = useState<string | null>(null);
  const [myName, setMyName] = useState<string | null>(null);
  // Who is typing where: "channel|root" -> author -> expiry (ms).
  const [typing, setTyping] = useState<Map<string, Map<string, number>>>(new Map());
  const lastTypingSent = useRef(0);
  // Vault notes opened from message links; the top of the stack is shown over
  // whatever was open (room, thread or Journal) and Back pops it.
  const [notes, setNotes] = useState<VaultRef[]>([]);
  notesRef.current = notes;
  // T-200: a note linked in chat opens beside the chat (wide screens) or as a sheet over it (narrow ones, Android), and the chat stays
  // mounted with its scroll and draft. Each room keeps its own note (a stack, for links inside it): another room shows its own or none,
  // and coming back shows it again. `asideAhead`: the stacks Back left in the room on screen, newest last, for Forward (gone once you
  // leave the room or open another note: Forward never brings back a note from long ago).
  const [asides, setAsides] = useState<Record<string, VaultRef[]>>({});
  const asidesRef = useRef(asides);
  const asideAhead = useRef(new Map<string, VaultRef[][]>());
  /** Notes in a pane with an edit not saved yet (their drafts are kept on this device). */
  const asideDirty = useRef(new Set<string>());
  const paneShape = usePaneShape();
  /** The room whose chat is on screen, so whose note may show; null under a full-page note, the Journal, a vault, a phone's room tree or
   *  a work view (the room's message list is not drawn). */
  const chatRoom = () => chatOnScreen(activeTab(tabsRef.current), channelRef.current, notesRef.current.length) && listRef.current?.isConnected ? channelRef.current : null;
  function putAside(room: string, stack: VaultRef[]) {
    const next = { ...asidesRef.current };
    if (stack.length) next[room] = stack; else delete next[room];
    asidesRef.current = next;
    setAsides(next);
  }
  const paneDraft = (stack: VaultRef[]) => stack.some((r) => asideDirty.current.has(`${r.vault}:${r.ref}`));
  /** A note from the chat replaces the room's note (a new branch: nothing ahead). Leaving an unsaved edit asks first. */
  function openAside(room: string, target: VaultRef, confirmed = false) {
    const cur = asidesRef.current[room];
    const top = cur?.[cur.length - 1];
    if (top && top.vault === target.vault && resolveNote(top, aliases.current).ref === target.ref) return;
    if (!confirmed && cur && paneDraft(cur)) {
      setConfirmation({ text: "Close this note with unsaved changes? Its draft will be kept on this device.", run: () => openAside(room, target, true) }); return;
    }
    asideAhead.current.delete(room);
    putAside(room, [target]);
  }
  /** Back in the room's note: one step (a link inside it), kept for Forward; or `all` (×, Escape) closes it. Leaving an unsaved edit asks first. */
  function backAside(room: string, all = false, confirmed = false) {
    const cur = asidesRef.current[room];
    if (!cur) return;
    if (!confirmed && paneDraft(all ? cur : cur.slice(-1))) {
      setConfirmation({ text: "Close this note with unsaved changes? Its draft will be kept on this device.", run: () => backAside(room, all, true) }); return;
    }
    if (all) asideAhead.current.delete(room);
    else asideAhead.current.set(room, [...(asideAhead.current.get(room) ?? []), cur].slice(-20));
    putAside(room, all ? [] : cur.slice(0, -1));
  }
  /** A link inside the room's note opens over it (a new branch: nothing ahead). */
  function pushAside(room: string, target: VaultRef) {
    const cur = asidesRef.current[room] ?? [];
    const top = cur[cur.length - 1];
    if (top && top.vault === target.vault && resolveNote(top, aliases.current).ref === target.ref) return;
    asideAhead.current.delete(room);
    putAside(room, [...cur.slice(-19), target]);
  }
  function forwardAside(room: string): boolean {
    const ahead = asideAhead.current.get(room);
    const stack = ahead?.pop();
    if (!stack) return false;
    putAside(room, stack);
    return true;
  }
  const [hub, setHub] = useState<string | null>(null);
  /** T-137: every origin that is this hub (its tailnet alias too), from the app's alias table */
  const [hubOrigins, setHubOrigins] = useState<string[]>([]);
  useEffect(() => { invoke<{ hub: string; hub_origins?: string[] }>("journal_config").then((c) => { setHub(c.hub); setHubOrigins(c.hub_origins ?? []); }).catch(() => {}); }, []);

  // The places visited, for Back and Forward (Alt+←/→ and the sidebar's two buttons).
  const [hist, setHist] = useState<History>(EMPTY_HISTORY);
  const histRef = useRef<History>(EMPTY_HISTORY);
  function pushHistory(t: Tab | TabTarget) {
    const next = histVisit(histRef.current, t);
    if (next !== histRef.current) { histRef.current = next; setHist(next); }
  }
  function goHistory(by: -1 | 1, pastOverlay = false) {
    // A note open over the place has its own Back: that comes first. Then whatever is in front closes (the task sheet, the drawer, the work
    // view) before Back changes places (`pastOverlay`: the drawer's own Back, pressed as it closes); Forward never closes anything.
    if (by < 0 && notesRef.current.length) { closeNoteRef.current(); return; }
    const over = pastOverlay ? null : overlayRef.current;
    // r19 (Codex 4): every Back closes what is in front first, a task sheet too (it used to swallow history Back), then follows the visits
    if (by < 0 && over) { over.close(); return; }
    if (over?.modal) return;
    // T-200: then the room's note: Back closes it (a step at a time), Forward brings it back
    const room = chatRoom();
    if (room && by < 0 && asidesRef.current[room]) { backAside(room); return; }
    if (room && by > 0 && forwardAside(room)) return;
    const hop = histStep(histRef.current, by);
    if (!hop) return;
    histRef.current = hop.history; setHist(hop.history);
    openTargetRef.current(hop.target, "focus", false, true);
  }
  function commitTabs(next: Tabs) {
    tabsRef.current = next;
    setTabs(next);
    if (tabsReady.current) {
      try {
        localStorage.setItem(TABS_KEY, serializeTabs(persistable(next)));
        // r15: the last place that is a real room, for a restore that lands on a node that only borrows one
        const cur = activeTab(next); const last = cur ? lastRoomOf(cur) : null;
        if (last) localStorage.setItem(LAST_ROOM_KEY, last);
      } catch { /* private storage */ }
    }
  }
  function switchToTab(tab: Tab | null) {
    setComposerFocused(false);
    setPanel(null);
    setSearchOpen(false);
    setJournalFocus(false);
    if (tab?.kind === "journal") saveLastSurface(localStorage, "journal");
    else if (tab?.kind === "areas" || (tab?.kind === "room" && tab.channel === findUniRoom(roomsRef.current)?.id)) saveLastSurface(localStorage, "uni");
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
  /** A room that a node owns opens as that node: one view of a room, wherever it is opened from (the tree, search, a note link, a needs-you item). */
  function resolveTarget(target: TabTarget): TabTarget {
    if (target.kind !== "room" || !target.channel) return target;
    const n = nodeOfRoom(target.channel);
    if (!n) return target;
    if (n.path === "") { rootOpenMemory.open = true; return { kind: "areas", title: "Uni", channel: target.channel }; }
    return { kind: "area", path: n.path, title: n.name, channel: target.channel };
  }
  /** `fromHistory`: Back and Forward move through the places visited; they do not add to them. */
  function openTarget(target: TabTarget, mode: OpenMode = "focus", confirmed = false, fromHistory = false) {
    target = resolveTarget(target);
    if (target.note) target = { ...target, note: resolveNote(target.note, aliases.current) };
    // No tab strip: a place replaces the one you were on (a second tab never shows the same room). The Journal keeps its own tab (its page and any recording stay alive), and a place opened from it goes beside it.
    if (isSurface(target) && target.kind !== "journal" && mode === "new") mode = "focus";
    if (target.kind === "journal") mode = "new";
    else if (isSurface(target) && mode === "focus" && activeTab(tabsRef.current)?.kind === "journal") mode = "new";
    // A recording's origin tab must survive the 12-tab eviction cap.
    const originId = recordingOrigin.current?.tabId;
    const pinned = new Set(tabsRef.current.tabs.filter((t) => t.id === originId || (t.kind === "journal" && journalRecordingRef.current)).map((t) => t.id));
    const base = { ...tabsRef.current, tabs: tabsRef.current.tabs.map((t) => t.note ? { ...t, note: resolveNote(t.note, aliases.current) } : t), recent: [...tabsRef.current.recent.filter((id) => !pinned.has(id)), ...pinned] };
    // a recording's tab is never replaced: going elsewhere (a row of the tree, a phone's Back to the tree) opens beside it
    const effectiveMode = (mode === "focus" || mode === "replace") && pinned.has(tabsRef.current.active ?? "") ? "new" : mode;
    const next = openTab(base, target, effectiveMode, () => crypto.randomUUID());
    const removed = tabsRef.current.tabs.filter((t) => !next.tabs.some((n) => n.id === t.id));
    if (removed.some((t) => t.id === originId || (t.kind === "journal" && journalRecordingRef.current))) {
      setError("Stop the recording before replacing its tab."); return;
    }
    if (!confirmed && removed.some(isTabDirty)) {
      setConfirmation({ text: "Leave this note with unsaved changes? Its draft will be kept on this device.", run: () => openTarget(target, mode, true, fromHistory) }); return;
    }
    removed.forEach((t) => dirtyNotes.current.delete(t.id));
    const tab = activeTab(next);
    if (tab && (next.active !== tabsRef.current.active || mode === "replace")) switchToTab(tab);
    commitTabs(next);
    if (!fromHistory && tab) pushHistory(tab);
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
  const closeNoteRef = useRef<() => void>(() => {});
  const switchToTabRef = useRef(switchToTab);
  openTargetRef.current = openTarget;
  closeTabRef.current = closeTabById;
  switchToTabRef.current = switchToTab;
  // A plain room tab opened before the tree had loaded becomes its node's view once the tree says which node owns the room.
  const roomNodes = useRoomNodes();
  useEffect(() => {
    const cur = activeTab(tabsRef.current);
    if (cur?.kind !== "room" || !cur.channel) return;
    const t = resolveTarget(cur);
    if (t.kind !== "room") openTargetRef.current(t, "replace", false, true);
  }, [roomNodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const openNote = useCallback((ref: VaultRef, href: string | null) => {
    // A note on some other hub isn't readable with this key: let the browser
    // (and that hub's Parachute app) handle it.
    if (!sameHub(ref, hub, hubOrigins)) { if (href) void invoke("open_link", { url: href }).catch(() => {}); return; }
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
  }, [hub, hubOrigins]);
  /** A note link in the chat: beside the chat (or over it), never in place of it. Anywhere else, or another hub's note, as before. */
  const openFromChat = useCallback((ref: VaultRef, href: string | null) => {
    const room = chatRoom();
    if (!room || !sameHub(ref, hub, hubOrigins)) { openNote(ref, href); return; }
    openAside(room, resolveNote({ ...ref, hub: null }, aliases.current));
  }, [openNote, hub, hubOrigins]); // eslint-disable-line react-hooks/exhaustive-deps
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
  closeNoteRef.current = closeNote;
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
  useEffect(() => (platformName(currentUserAgent()) === "linux" ? watchLostIpc(setToast) : undefined), []);
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
  /** T-200: the spot in the chat that "Open as page" left (the first message in sight, and how far down it was), for the Back that comes
   *  back to it; `pinned` holds it there while late layout settles, as a fresh room is held at its newest message. */
  const returnSpot = useRef<{ view: string; ref: string; offset: number; limit: number; seq: number } | null>(null);
  const pinned = useRef<{ ref: string; offset: number; until: number } | null>(null);
  // Following the newest message: content growth (images, late layout) keeps it pinned.
  const stickToEnd = useRef(true);
  /** T-132: the view the reader has scrolled up in (the jump-to-latest button shows there); per view, the newest message they had seen
   *  at its end (with its time, so a deleted one doesn't lose the place); the newest on screen; until when a jump to the newest is under way. */
  const [awayView, setAwayView] = useState<string | null>(null);
  type Seen = { view: string; ts: number; ref: string };
  const seenRef = useRef(new Map<string, Seen>());
  const newestRef = useRef<Seen | null>(null);
  const jumpUntil = useRef(0);
  const [loadedView, setLoadedView] = useState<string | null>(null);
  /** The view whose messages the relay store has answered with (not just the device's kept copy): only then can a room be said to be empty. */
  const [fetchedView, setFetchedView] = useState<string | null>(null);
  /** The view whose last read failed with nothing kept to show: the timeline says so, with Retry, instead of loading forever. */
  const [failedView, setFailedView] = useState<string | null>(null);
  const fetchSeq = useRef(0), appliedSeq = useRef(0), viewNow = useRef<string | null>(null);
  /** T-200: how many messages the applied fetch asked for (a spot to return to waits for the window it was taken in). */
  const appliedLimit = useRef(0);
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const setList = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
    restoredView.current = null;
    setListEl(el);
  }, []);
  const [stackEl, setStackEl] = useState<HTMLDivElement | null>(null);
  const channelRef = useRef<string | null>(null);
  const roomsRef = useRef<Room[]>(rooms);
  channelRef.current = channel;
  const rootRef = useRef<string | null>(root);
  rootRef.current = root;
  const scrollEnd = useRef<HTMLDivElement>(null);
  const shownView = useRef<string | null>(null);
  // Uni is notified on every message in rooms it belongs to, unless muted.
  const [notifyUni, setNotifyUni] = useState(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const composerInput = useCallback((el: HTMLTextAreaElement | null) => {
    input.current = el;
    if (!el) return;
    mark("composer");
    resizeComposer(el);
    let width = el.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = el.getBoundingClientRect().width;
      if (nextWidth !== width) { width = nextWidth; resizeComposer(el); }
    });
    observer.observe(el);
    return () => { observer.disconnect(); input.current = null; };
  }, []);
  useLayoutEffect(() => { if (input.current) resizeComposer(input.current); }, [draft, asides, channel, notes.length]); // T-200: a note opening or closing changes the cap
  const focusComposer = useRef(false);
  // T-161: every room's Hermes approval prompts still waiting, for Needs you, the room and one notification each
  const approvals = useApprovals({ identity, enabled: !!identity, synced, roomsReady: rooms.length > 0, roomName: (id) => roomsRef.current.find((r) => r.id === id)?.name ?? null,
    looking: (ch, r) => document.hasFocus() && ch === channelRef.current && r === rootRef.current });

  const loadRooms = useCallback(async (cached?: Room[]) => {
    const rows = cached ?? await invoke<Room[]>("get_rooms");
    if (rows.length) mark(cached ? "roomsCached" : "rooms");
    setRooms(rows);
    roomsRef.current = rows;
    if (!cached) { writeRooms(localStorage, whoRef.current, rows); setUnreadBadge(rows.reduce((n, r) => n + (r.unread || 0), 0)); }
    if (!tabsReady.current) {
      tabsReady.current = true;
      // 0.1.46: no tab strip. The app reopens to the place it was last on (v2 holds just that); v1's set of tabs is ignored beyond its active surface.
      const ids = rows.map((r) => r.id);
      let saved: string | null = null, legacy: string | null = null;
      try { saved = localStorage.getItem(TABS_KEY); if (!saved) legacy = localStorage.getItem(LEGACY_TABS_KEY); } catch { /* private storage */ }
      let next = saved ? restoreTabs(saved, ids) : migrateLegacyTabs(legacy, ids);
      // a node that only borrows a room (r15) reopens on the last room actually opened, else on Uni
      let lastRoom: string | null = null;
      try { lastRoom = localStorage.getItem(LAST_ROOM_KEY); } catch { /* private storage */ }
      next = restorePlace(next, lastRoom, ids, () => crypto.randomUUID());
      if (!activeTab(next)) {
        const uni = rows.some((r) => r.id === UNI_CHANNEL) ? UNI_CHANNEL : findUniRoom(rows)?.id;
        // The app opens to Uni: its home page, with the Uni room attached as the chat. Without a Uni room (an account that has none) it opens the first room.
        const target: TabTarget = readLastSurface(localStorage) === "journal" ? { kind: "journal", title: "Journal" }
          : uni ? { kind: "areas", title: "Uni", channel: uni } : rows[0] ? { kind: "room", channel: rows[0].id, title: rows[0].name } : { kind: "areas", title: "Uni" };
        next = openTab(next, target, "new", () => crypto.randomUUID());
      }
      // Note stacks are reconstructed from their saved top-level tab target.
      switchToTabRef.current(activeTab(next));
      // Restoring the first tab preserves the viewport-specific sidebar default.
      setSidebarVisible(window.matchMedia("(min-width: 600px)").matches);
      commitTabs(next);
      const first = activeTab(next);
      if (first) pushHistory(first);
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
  }, []);

  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    mark("syncStart");
    setBusy(true);
    // r25 (Codex 8): the first sync of a cold start takes seconds, but its rooms are in the local store in milliseconds and each room's
    // messages as its history lands: read them while it runs, so the conversation and its composer don't wait for the whole sync
    const cold = roomsRef.current.length === 0;
    const poll = cold ? window.setInterval(() => { void loadRooms().catch(() => {}); setTick((n) => n + 1); }, 700) : 0;
    setStatus("Connecting…");
    setError(null);
    try {
      const result = await invoke<SyncResult>("refresh");
      setIdentity(result.pubkey);
      await loadRooms();
      const warnings = Object.entries(result.channel_errors).map(([id, reason]) => `${id.slice(0, 8)}: ${reason}`);
      if (result.truncated_channels.length) warnings.push("Some rooms have more history than the current 500-message backfill.");
      // r18: Settings says it in words; the counts and per-room warnings are under Developer
      setSyncDetail(warnings.length ? `${result.total_items} saved messages; ${warnings.join("; ")}` : `${result.total_items} saved messages`);
      setStatus(warnings.length ? "Up to date, except a few rooms" : "Up to date");
      mark("syncDone");
      setSynced((n) => n + 1);
      // Keep the socket open for push while we're in the foreground.
      // r19 (Codex 10): the reason goes to the developer log, the status line says it in words
      invoke<boolean>("live_start").catch((e) => { console.warn("live_start failed", e); setLive("Live updates paused"); });
    } catch (e) {
      setError(String(e));
      setStatus("Offline · showing what this device saved");
    } finally { if (poll) window.clearInterval(poll); busyRef.current = false; setBusy(false); }
  }, [loadRooms]);

  useEffect(() => {
    let active = true;
    invoke<string>("get_identity").then((id) => { mark("identity"); if (active) setIdentity(id); }).catch(() => {});
    // A rooms list from the last run restores the place at once; the real list follows and re-syncs it.
    if (roomsRef.current.length) void loadRooms(roomsRef.current).catch(() => {});
    loadRooms().then(() => { if (active) void refresh(); }).catch((e) => {
      if (active) { setError(String(e)); setStatus("Could not open local conversations"); }
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
    if (whoRef.current !== identity) { whoRef.current = identity; writeWho(localStorage, identity); }
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
    if (!channel) { viewNow.current = null; setMessages([]); setLoadedView(null); return; }
    let current = true;
    const view = `${channel}|${root}`;
    // Sync ticks re-run this effect faster than a big room loads: a result for the view still on screen is kept (the newest request wins),
    // so the room never stays blank while ticks keep cancelling its fetch.
    const seq = ++fetchSeq.current;
    // A room opened from the cache paints its last messages now (the composer is live with them); the fetch below refreshes them.
    if (viewNow.current !== view && root === null) {
      const kept = readMessages<Message>(localStorage, whoRef.current, channel);
      if (kept) { mark("messagesCached"); setMessages(kept); setLoadedView(view); }
    }
    viewNow.current = view;
    invoke<Message[]>("get_messages", { channel, root, limit }).then((rows) => { if (rows.length) mark("messages"); if (viewNow.current === view && seq > appliedSeq.current) { appliedSeq.current = seq; appliedLimit.current = limit; setMessages(rows); setLoadedView(view); setFetchedView(view); setFailedView(null); if (root === null) writeMessages(localStorage, whoRef.current, channel, rows); } }).catch((e) => { if (current) { setError(String(e)); setFailedView(view); } });
    // Viewing the room reads it (only while the app is actually on screen).
    if (document.visibilityState === "visible") {
      invoke("mark_read", { channel }).then(() => loadRooms()).catch(() => {});
    }
    return () => { current = false; };
  }, [channel, root, synced, tick, limit, loadRooms]);

  // New room: back to the default window; older pages load on demand.
  // T-200: the room a note was opened as a page from comes back with the older messages it had loaded, so its spot is there to return to
  useEffect(() => { const spot = returnSpot.current; setLimit(spot && channel && spot.view.startsWith(`${channel}|`) ? spot.limit : 300); setOlder("idle"); setMenuFor(null); setEditing(null); asideAhead.current.clear(); }, [channel]);

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
    // T-124 r2: a room always opens at its latest message (no remembered spot), and stays there while images and older pages settle
    // in, until the reader scrolls on purpose. T-200: except the room a note was opened as a page from, which comes back to its spot.
    const spot = returnSpot.current?.view === currentView ? returnSpot.current : null;
    // the device's kept copy holds only the newest messages: a spot further back waits for the fetched window (below)
    if (!spot || (appliedSeq.current > spot.seq && appliedLimit.current >= spot.limit)) returnSpot.current = null;
    if (spot && pinTo(el, spot)) {
      returnSpot.current = null;
      stickToEnd.current = false;
      settleUntil.current = 0;
      pinned.current = { ref: spot.ref, offset: spot.offset, until: Date.now() + SETTLE_MS };
    } else {
      pinned.current = null;
      el.scrollTop = restoreTop(undefined, el.scrollHeight, el.clientHeight);
      stickToEnd.current = true;
      settleUntil.current = Date.now() + SETTLE_MS;
      setAwayView(null); // T-132: reopened at the newest, whatever was left there before
    }
    restoredView.current = currentView;
    shownView.current = currentView;
  }, [listEl, currentView, loadedView, messages]);
  // T-200: a spot that was not in the kept copy, once the fetched window is in
  useLayoutEffect(() => {
    const el = listEl, spot = returnSpot.current;
    if (!el || !spot || spot.view !== currentView || appliedSeq.current <= spot.seq || appliedLimit.current < spot.limit || restoredView.current !== currentView) return;
    returnSpot.current = null;
    if (!pinTo(el, spot)) return;
    stickToEnd.current = false;
    settleUntil.current = 0;
    pinned.current = { ref: spot.ref, offset: spot.offset, until: Date.now() + SETTLE_MS };
  }, [listEl, currentView, messages]);

  // Remember where the reader is, per view (only once that view is restored,
  // so a half-swapped list never overwrites a good mark).
  const gliding = useRef(0);
  const settleUntil = useRef(0);
  useEffect(() => {
    const el = listEl;
    if (!el) return;
    // T-132: the reader's own input also ends a glide to a new message, so a scroll up under way then is theirs, not the glide's
    const onUser = () => { settleUntil.current = 0; pinned.current = null; jumpUntil.current = 0; gliding.current = 0; };
    const onScroll = () => {
      const v = restoredView.current;
      if (!v || Date.now() < gliding.current) return;
      // Still settling after the open: a scroll that is not the reader's own is layout (older rows, images) moving the list. Stay at the end.
      if (Date.now() < settleUntil.current) { if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) el.scrollTop = el.scrollHeight; return; }
      const mark = markFor(el.scrollTop, el.scrollHeight, el.clientHeight);
      // T-132: a jump to the newest still gliding there is not the reader leaving the end (one cut short is let go after a while)
      if (Date.now() < jumpUntil.current && !mark.atEnd) return;
      jumpUntil.current = 0;
      scrollMemory.current.set(v, mark);
      stickToEnd.current = mark.atEnd;
      if (mark.atEnd && newestRef.current?.view === v) seenRef.current.set(v, newestRef.current);
      setAwayView(mark.atEnd ? null : v);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const inputs = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const t of inputs) el.addEventListener(t, onUser, { passive: true });
    return () => { el.removeEventListener("scroll", onScroll); for (const t of inputs) el.removeEventListener(t, onUser); };
  }, [listEl]);

  // Images, fonts and embeds settle after first paint: while following the
  // newest message, stay pinned to the end as the content grows. T-132: and as the list itself shrinks (a banner or bar above it
  // arriving late), which moves no content and fires no scroll.
  useEffect(() => {
    if (!listEl || !stackEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (pinned.current && Date.now() < pinned.current.until && pinTo(listEl, pinned.current)) return;
      pinned.current = null;
      if (stickToEnd.current && restoredView.current && preserveScroll.current === null) listEl.scrollTop = listEl.scrollHeight;
    });
    ro.observe(stackEl);
    ro.observe(listEl);
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
      if (!uni) { setError("Uni isn't in the Uni room's member list yet. Try again in a moment."); return false; }
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
      settleUntil.current = 0;
      setOlder("idle");
      setLimit((l) => l + n + 50);
    } catch (e) { if (channelRef.current === ch) { setError(String(e)); setOlder("idle"); } }
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
      setTick((n) => n + 1);
      void loadRooms().catch(() => {});
    } catch (e) { setError(`Delete failed: ${e}`); }
  }

  useEffect(() => {
    if (focusComposer.current) { focusComposer.current = false; input.current?.focus(); }
  }, [root, channel]);

  const labels = memberLabels(members);
  const typists = [...(typing.get(`${channel}|${root ?? ""}`)?.keys() ?? [])].filter((pk) => pk !== identity);
  const typingNames = typists.map((pk) => labels.get(pk) ?? members.find((m) => m.pubkey === pk)?.name ?? pk.slice(0, 8));
  const typingLine = typingNames.length === 0 ? null : typingNames.length === 1 ? `${typingNames[0]} is typing…` : typingNames.length === 2 ? `${typingNames[0]} and ${typingNames[1]} are typing…` : "Several people are typing…";
  // T-132: "Uni is working · 0:42", from Uni's 👀 on your message until its reply; the clock ticks while it shows
  const viewShown = !!currentView && loadedView === currentView;
  const working = viewShown ? workingOn(messages, identity, Date.now() / 1000) : null;
  const workingName = working ? labels.get(working.author) ?? members.find((m) => m.pubkey === working.author)?.name ?? "Uni" : null;
  // with nothing else arriving, look again now and then, so work past its hour with no live ping is let go
  const [, setWorkCheck] = useState(0);
  useEffect(() => {
    if (!working) return;
    const t = window.setInterval(() => setWorkCheck((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [!!working]); // eslint-disable-line react-hooks/exhaustive-deps
  // T-132: scrolled up, the newest is a tap away; messages from others that came in since you were at the end are counted on it.
  // A view seen for the first time (or come back to) counts from what it showed then.
  useLayoutEffect(() => {
    const last = messages[messages.length - 1];
    newestRef.current = viewShown && currentView && last ? { view: currentView, ts: last.ts, ref: last.ref } : null;
    if (newestRef.current && (stickToEnd.current || !seenRef.current.has(newestRef.current.view))) seenRef.current.set(newestRef.current.view, newestRef.current);
  });
  const away = viewShown && awayView === currentView;
  const seen = away && currentView ? seenRef.current.get(currentView) : undefined;
  const seenAt = seen ? messages.findIndex((m) => m.ref === seen.ref) : -1;
  // after the seen message if it is still here (a reply in the same second counts), else after its time
  const newSince = !seen ? 0 : messages.filter((m, i) => (seenAt >= 0 ? i > seenAt : m.ts > seen.ts) && m.author !== identity && !isWorkerStatus(m.body)).length;
  function jumpToLatest() {
    const el = listRef.current;
    if (!el) return;
    stickToEnd.current = true;
    jumpUntil.current = Date.now() + 2000;
    if (newestRef.current) seenRef.current.set(newestRef.current.view, newestRef.current);
    setAwayView(null);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }
  const suggestions = picker ? filterMembers(members, picker.query, identity ?? undefined) : [];

  function scope() { return channel ? keyFor(channel, root) : null; }

  activeScope.current = scope();
  function changePending(key: string, update: (items: PendingFile[]) => PendingFile[]) {
    const next = update(pendingStore.current.get(key) ?? []);
    pendingStore.current.set(key, next);
    if (activeScope.current === key) setPending(next);
  }
  async function persistVoice(key: string, id: string, delivered = false) {
    const clip = pendingStore.current.get(key)?.find(x => x.id === id);
    if (!clip?.voice) return;
    const owner = clip.owner ?? await invoke<string>("get_identity");
    const relay = clip.relay ?? await invoke<string>("relay_origin");
    changePending(key, items => items.map(x => x.id === id ? { ...x, owner, relay } : x));
    const saved = await voiceOutbox.current.put({ id, key, owner, relay, file: clip.file, filename: clip.file.name, mime: clip.file.type,
      created: clip.created!, state: delivered ? "delivered" : clip.state === "error" ? "error" : "uploading", error: clip.error,
      media: clip.media, signedEvent: clip.signedEvent, voice: clip.voice });
    if (saved === "failed") throw new Error("Couldn’t save the voice note safely — Retry");
  }
  function removeFile(key: string, id: string) {
    clearTimeout(voiceRetryTimers.current.get(id));
    voiceRetryTimers.current.delete(id);
    voiceRetryAttempts.current.delete(id);
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
    clearTimeout(voiceRetryTimers.current.get(id));
    voiceRetryTimers.current.delete(id);
    voiceJobs.current.add(id);
    setError(null);
    changePending(key, (items) => items.map((x) => x.id === id ? { ...x, state: "uploading" } : x));
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
        let known = false;
        if (clip.signedEvent) {
          try {
            const eventId = JSON.parse(signedEvent).id;
            const rows = await invoke<Message[]>("get_messages", { channel: destination.channel, root: destination.replyTo, limit: 200 });
            known = typeof eventId === "string" && rows.some(row => row.ref === eventId || row.ref === `nostr:${eventId}`);
          } catch { /* Re-publishing the same signed event is idempotent at the relay. */ }
        }
        try { if (!known) await invoke<Message>("post_message", { ...args, signedEvent }); }
        catch (e) { if (!relayAccepted(e)) throw e; }
        // A durable tombstone survives a failed delete; deletion is also retried below.
        await persistVoice(key, id, true).catch(() => {});
        await voiceOutbox.current.remove(id);
        if (!voiceMounted.current) return;
        removeFile(key, id); // Clears the retry timer and attempt count after delivery.
        setTick((n) => n + 1);
        outcome = "Voice message sent";
        void loadRooms().catch(() => {});
      } catch (e) {
        if (!voiceMounted.current) return;
        changePending(key, (items) => items.map((x) => x.id === id ? { ...x, state: "error", error: String(e) } : x));
        await persistVoice(key, id).catch(() => {});
        setError(`Voice message failed: ${netError(e)}`);
        outcome = "Voice message failed";
      } finally {
        voiceJobs.current.delete(id);
        if (voiceMounted.current && pendingStore.current.get(key)?.some(x => x.id === id && x.state === "error" && isNetworkError(x.error))) {
          const attempt = voiceRetryAttempts.current.get(id) ?? 0;
          voiceRetryAttempts.current.set(id, attempt + 1);
          voiceRetryTimers.current.set(id, setTimeout(() => {
            voiceRetryTimers.current.delete(id);
            if (voiceMounted.current) queueVoice(key, id);
          }, voiceRetryDelay(attempt)));
        }
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
    void (async () => { await voiceRestored.current; if (voiceMounted.current) queueVoice(origin.key, id); })();
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
    const target = root ? (messages.some((m) => m.ref === root) ? root : messages[messages.length - 1]?.ref ?? null) : null;
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
  function editDraft(key: string, text: string, mentions?: Bindings) {
    drafts.current.set(key, text);
    draftRevisions.current.set(key, (draftRevisions.current.get(key) ?? 0) + 1);
    storeDraft(key, text, mentions ?? bindingStore.current.get(key));
  }
  // T-132: kept on this device, so a reload gives the text back. Refused storage never blocks typing: the copy in memory stays.
  function storeDraft(key: string, text: string, mentions?: Bindings) {
    const owner = identityRef.current;
    if (!owner) return;
    setDraftStorageWarning(saveChatDraft(owner, key, text, mentions ?? []) ? "" : "This device isn't saving drafts right now. Your text is kept until the app closes.");
  }
  /** A scope's draft: the one in memory, else the one saved for this identity (read once). */
  function scopeDraft(key: string): string {
    if (drafts.current.has(key)) return drafts.current.get(key) ?? "";
    const owner = identityRef.current;
    if (!owner) return "";
    const saved = loadChatDraft(owner, key);
    drafts.current.set(key, saved?.text ?? "");
    if (saved?.mentions.length) bindingStore.current.set(key, new Map(saved.mentions));
    return saved?.text ?? "";
  }
  function discardDraft() {
    const key = scope();
    if (!key) return;
    const none: Bindings = new Map();
    bindingStore.current.set(key, none);
    editDraft(key, "", none);
    setDraft("");
    bindingsRef.current = none;
    setBindings(none);
    setPicker(null);
    announce("Draft discarded");
  }

  function updateDraft(text: string, caret: number | null) {
    setDraft(text);
    const now = Date.now();
    if (text.trim() && channel && now - lastTypingSent.current > TYPING_SEND_MS) {
      lastTypingSent.current = now;
      void invoke("send_typing", { channel, root: root ?? null, parent: root ?? null }).catch(() => {});
    }
    const key = scope();
    const next = pruneBindings(text, bindingsRef.current);
    bindingsRef.current = next;
    if (key) { bindingStore.current.set(key, next); editDraft(key, text, next); }
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
    const updated = new Map(pruneBindings(next.text, bindingsRef.current));
    updated.set(label, member.pubkey);
    bindingsRef.current = updated;
    if (key) { bindingStore.current.set(key, updated); editDraft(key, next.text, updated); }
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
    const nextKey = nextChannel ? keyFor(nextChannel, nextRoot) : null;
    // Same scope again (a second tab on this room): the map already holds the live draft, and a caller may just have appended to it.
    if (key && key !== nextKey) { drafts.current.set(key, draft); bindingStore.current.set(key, bindings); }
    activeScope.current = nextKey;
    setPending(nextKey ? pendingStore.current.get(nextKey) ?? [] : []);
    setJournalOpen(false);
    setNotes([]);
    setChannel(nextChannel);
    setRoot(nextRoot);
    setDraft(nextKey ? scopeDraft(nextKey) : "");
    setBindings(nextKey ? bindingStore.current.get(nextKey) ?? new Map() : new Map());
    setPicker(null);
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
    // In a thread, reply to the root. If the root is not cached, reply to the newest cached message in the thread.
    let target: string | null = null;
    if (root) target = messages.some((m) => m.ref === root) ? root : messages[messages.length - 1]?.ref ?? null;
    if (root && !target) { setError("Thread not in local cache. Refresh before replying."); return; }
    sendingRef.current = true;
    setSending(true);
    setOutgoing({ key, body: snapshot });
    setError(null);
    try {
      await invoke<Message>("post_message", { channel, body: snapshot, replyTo: target, recipients, media: files.map((f) => f.media!) });
      changePending(key, (items) => {
        for (const item of items) if (sentIds.includes(item.id) && item.preview) URL.revokeObjectURL(item.preview);
        return items.filter((item) => !sentIds.includes(item.id));
      });
      // Do not erase text typed during an in-flight send or in another room.
      if ((draftRevisions.current.get(key) ?? 0) === revision) {
        bindingStore.current.set(key, new Map());
        editDraft(key, "", new Map());
        if (activeScope.current === key) {
          setDraft("");
          bindingsRef.current = new Map();
          setBindings(bindingsRef.current);
        }
      }
      if (activeScope.current === key) {

      }
      // Re-read through the room effect, which drops the result if the
      // user has switched rooms meanwhile.
      setTick((n) => n + 1);
      await loadRooms();
      setStatus(recipients.length ? `Message sent · notified ${recipients.length}` : "Message sent");
    } catch (e) {
      setError(String(e));
    }
    finally { sendingRef.current = false; setSending(false); setOutgoing(null); }
  }

  async function forget() {
    // Two taps instead of window.confirm (unreliable in Android WebView).
    if (!forgetArmed) { setForgetArmed(true); return; }
    try { voiceMounted.current = false; await voiceQueue.current; await voiceOutbox.current.clear(); await invoke("identity_forget");
      forgetDrafts(); forgetChatDrafts(); invalidatePaths(); forgetAreas(); forgetDecisions(); forgetHeld(); forgetCalendar();
      try { for (const key of Object.keys(localStorage)) if (key.startsWith("uni.noteDraft.v1:") || key.startsWith("uni.vaultExpanded.v1:") || key === ALIASES_KEY) localStorage.removeItem(key); } catch { /* unavailable storage */ }
      onForget(); } catch (e) { voiceMounted.current = true; setError(String(e)); }
  }

  const currentRoom = rooms.find((r) => r.id === channel);
  const isThread = !!root;
  const rootMessage = isThread ? messages.find((m) => m.ref === root) : undefined;
  const threadReplies = isThread ? messages.filter((m) => m.ref !== root) : [];

  // The room's message list and composer. The room view and an area's chat pane are this same markup, so one send path,
  // one draft per room and one signer serve both; `above` is drawn directly over the composer (the suggestion bar).
  const uniInRoom = !!findUniMember(members);
  const roomPane = (currentRoom: Room, above: ReactNode, placeholder?: string) => <>
        <div className="message-list" ref={setList} role="log" aria-label="Messages" aria-live="polite">
          <div className="message-stack" ref={setStackEl}>
            <NoteOpener.Provider value={openFromChat}>{timeline}</NoteOpener.Provider>
            {outgoing && outgoing.key === keyFor(currentRoom.id, root) && <article className="message mine outgoing" aria-busy="true" data-outgoing="true"><span className="message-avatar" aria-hidden="true" /><div className="message-content"><div className="message-meta"><time>Sending…</time></div><p className="outgoing-body">{outgoing.body}</p></div></article>}
            {working && workingName && <WorkingLine name={workingName} since={working.since} />}
            <div ref={scrollEnd} />
          </div>
        </div>
        <footer onFocusCapture={() => requestAnimationFrame(() => setComposerFocused(true))} onBlurCapture={(e) => { const composer = e.currentTarget; requestAnimationFrame(() => setComposerFocused(composer.contains(document.activeElement))); }} className="composer" onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={onDropFiles}>
          {/* a press doesn't take focus: focus in the composer hides the phone's bottom bar, which would move the button from under the tap */}
          {away && <button type="button" className={`jump-latest${newSince ? " has-new" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={jumpToLatest} aria-label={newSince ? `Jump to latest, ${newSince} new message${newSince === 1 ? "" : "s"}` : "Jump to latest"}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" /></svg>{newSince ? <span>{newSince} new message{newSince === 1 ? "" : "s"}</span> : <span className="jump-latest-label">Latest</span>}
          </button>}
          <ApprovalBanner approvals={approvals.filter((a) => a.channel === currentRoom.id)} onShow={openApproval} />
          {checking && checking.channel === channel && <p className="checking-banner" role="status" title={checking.text}><SmallLine className="checking-text" text={checking.text} /><button type="button" className="checking-x" aria-label="Stop checking" onClick={() => setChecking(null)}>×</button></p>}
          {above}
          <input ref={fileInput} className="file-picker" type="file" multiple aria-label="Choose files to attach" onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          {error && <p className="error" role="alert">{error}</p>}
          {picker && <ul className="mention-picker" role="listbox" aria-label="Mention a member">
            {suggestions.length === 0 && <li className="mention-empty">{members.length ? `No member matches “${picker.query}”` : "No members known for this room yet."}</li>}
            {suggestions.map((m, i) => <li key={m.pubkey} role="option" aria-selected={i === picker.index}>
              <button className={i === picker.index ? "active" : ""} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(m)}>
                <span className="avatar small">{m.name[0]?.toUpperCase() ?? "?"}</span><span className="mention-name">{labels.get(m.pubkey) ?? m.name}</span><small>{m.pubkey.slice(0, 8)}</small>
              </button>
            </li>)}
          </ul>}
          {typingLine && <div className="typing-line" role="status" aria-live="polite">{typingLine}</div>}
          {pending.length > 0 && <div className="compose-files" aria-label="Attachments">
            {pending.map((item) => <div className={`compose-file ${item.state}`} key={item.id}>
              {item.preview ? <img src={item.preview} alt="" /> : <span className="compose-file-icon" aria-hidden="true">{item.file.type === "application/pdf" || item.file.name.toLowerCase().endsWith(".pdf") ? "📄" : attachmentKind({ url: item.file.name, mime: item.file.type }) === "audio" ? "♪" : "📎"}</span>}
              <span className="compose-file-info" onClick={() => item.error && setError(`${item.file.name}: ${item.voice ? netError(item.error) : item.error}`)} title={item.error ?? undefined}><strong>{item.file.name}</strong><small>{formatSize(item.file.size)} · {item.voice && item.error ? (isNetworkError(item.error) ? "Not sent — will retry" : `Not sent · ${item.error.replace(/^Error:\s*/, "")}`) : item.state === "ready" ? "Ready" : item.state === "uploading" ? "Uploading…" : `Failed: ${item.error}`}</small>{item.state === "uploading" && <progress aria-label={`Uploading ${item.file.name}`} />}</span>
              {item.state === "error" && <button className="compose-file-retry" onClick={() => item.voice ? queueVoice(keyFor(currentRoom.id, root), item.id) : void uploadFile(keyFor(currentRoom.id, root), item.id, item.file)} aria-label={`Retry upload ${item.file.name}`}>Retry</button>}
              <button className="compose-file-remove" disabled={sending} onClick={() => removeFile(keyFor(currentRoom.id, root), item.id)} aria-label={`Remove ${item.file.name}`}>×</button>
            </div>)}
          </div>}
          {voiceStorageWarning && <p role="status">{voiceStorageWarning}</p>}
          {draftStorageWarning && <p className="draft-storage" role="status">{draftStorageWarning}</p>}
          {voiceStatus && <p className="voice-status" role="status">{voiceStatus}</p>}
          <div className="compose-row">
            <ComposerMenu key={`${channel}:${root}`} onMention={startMention} onAttach={() => fileInput.current?.click()} onDiscard={discardDraft} canDiscard={!!draft} sending={sending} />
            <textarea ref={composerInput} aria-label={`Message ${currentRoom.name}`} value={draft} onChange={(e) => updateDraft(e.target.value, e.target.selectionStart)} onPaste={onPasteFiles} onSelect={(e) => syncPicker(e.currentTarget.value, e.currentTarget.selectionStart)} onBlur={() => setPicker(null)} onKeyDown={onKeyDown} maxLength={65536} rows={1} placeholder={isThread ? "Reply in thread…" : placeholder ?? "Message Uni…"} />
            {/* Uni hears every message in a room it is in, unless muted here: a small, visible switch (it was hidden with the old destination line) */}
            {uniInRoom && <button type="button" className={`compose-uni ${notifyUni ? "on" : ""}`} aria-pressed={notifyUni} onClick={() => setNotifyUni((v) => !v)}
              aria-label={notifyUni ? "Uni is listening. Mute Uni for your messages" : "Uni is muted. Let Uni listen again"} title={notifyUni ? "Uni hears what you send here. Tap to mute." : "Uni is muted: your messages don't notify Uni. Tap to let Uni listen."}>{notifyUni ? "Uni listening" : "Uni muted"}</button>}
            <button className={`address-toggle compose-icon mic ${recorder.recording && recordingOrigin.current?.key === scope() ? "recording" : ""}`} onClick={() => void toggleRecording()} disabled={sending || (recorder.busy && (!recorder.recording || recordingOrigin.current?.key !== scope()))} aria-pressed={recorder.recording && recordingOrigin.current?.key === scope()} aria-label={recorder.recording && recordingOrigin.current?.key === scope() ? "Stop recording voice message" : "Record a voice message"} title={recorder.recording && recordingOrigin.current?.key === scope() ? "Stop recording" : "Voice message"}>
              {recorder.recording && recordingOrigin.current?.key === scope() ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" fill="currentColor" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>}
            </button>
            <button className="send compose-icon" disabled={(!draft.trim() && !pending.some((f) => !f.voice && f.state === "ready")) || manualAttachments(pending).some(attachmentBlocksSend) || sending || recorder.busy} onClick={() => void send()} aria-label="Send message" title={sending ? "Sending…" : "Send message"} aria-busy={sending}>
              {sending ? <span aria-hidden="true">…</span> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7 7 7M12 5v14" /></svg>}
            </button>
          </div>
          <p className="compose-hint">Enter to send · Shift+Enter for a new line · @ to mention</p>
        </footer>
  </>;
  /** T-212: the decisions a message names: its `uni:<id>` refs (a card only if the note is a decision), then a known open decision its
   *  `[decision T-NN]` marker or bare id names. */
  const markerHits = useRef(new Map<string, string>());
  const decisionIds = (m: Pick<Message, "ref" | "body">) => {
    const ids = decisionRefsIn(m.body);
    // a marker names an open decision; once decided the shell stops listing it, and the card stays (showing the answer)
    const known = decisionIn(m.body, decisions.known) ?? markerHits.current.get(m.ref) ?? null;
    if (known) markerHits.current.set(m.ref, known);
    return known && !ids.includes(known) ? [...ids, known] : ids;
  };
  /** A won tap's "Picked: …", as you, in the room the card is in, to Uni too (it is the room's answer). Not after a Forget meanwhile. */
  const postPick = (room: string, thread: string | null = null) => async (body: string, current: () => boolean) => {
    const roster = await invoke<Member[]>("get_members", { channel: room }).catch(() => [] as Member[]);
    if (!current()) return;
    const uni = findUniMember(roster);
    // a card tapped in a thread answers in that thread, where it was asked
    await invoke<Message>("post_message", { channel: room, body, replyTo: thread, recipients: uni ? [uni.pubkey] : [] });
    setTick((n) => n + 1);
  };
  const decisionCards = (m: Message, inThread: boolean) => {
    const ids = decisionIds(m), refs = decisionRefsIn(m.body);
    return ids.length ? <div className="decision-cards">{ids.map((id) => <DecisionCard key={id} id={id} vault={refs.includes(id) ? "uni" : activeProfile().vault} post={postPick(m.channel, inThread ? root : null)} />)}</div> : null;
  };
  /** The decisions listed under this room's chat so far: one answered here stays (showing its answer, telling the room) until the room changes. */
  const listedHere = useRef<{ room: string; ids: string[] }>({ room: "", ids: [] });
  /** The room's open decisions that no loaded message names, under its chat (folded: one line until opened). */
  const roomDecisions = (room: string, list: Message[]) => {
    const named = new Set(list.flatMap((m) => decisionIds(m)));
    const open = unreferenced(decisions.known.map((d) => ({ id: d.id, channel: d.channel ?? null })), room, named);
    if (listedHere.current.room !== room) listedHere.current = { room, ids: [] };
    const ids = [...new Set([...listedHere.current.ids, ...open])].filter((id) => !named.has(id));
    listedHere.current.ids = ids;
    if (!ids.length) return null;
    return <details className="room-decisions"><summary>{!open.length ? "Decided here" : open.length === 1 ? "1 open decision for this room" : `${open.length} open decisions for this room`}</summary>
      <div className="decision-cards">{ids.map((id) => <DecisionCard key={id} id={id} vault={activeProfile().vault} post={postPick(room)} />)}</div></details>;
  };

  /** T-176: a secret request becomes its card; a receipt shows only its human line. Null: the ordinary body. */
  const secretView = (m: Message) => {
    // T-234: the enrollment Settings posted, in words rather than its JSON
    if (m.author === identity && parseEnrollment(m.body)) return <EnrollmentLine channel={m.channel} reference={m.ref} me={identity}
      fallback={<Body body={m.body} mentions={m.mentions} me={identity} edited={m.edited} />} />;
    if (!secretCards) return null;
    if (parseSecretRequest(m.body)) return <><Body body={withoutSecretBlock(m.body).split("\n")[0]} mentions={m.mentions} me={identity} edited={m.edited} />
      <SecretRequestCard channel={m.channel} requestRef={m.ref} authorName={m.author_name} receipts={(author, rid) => receiptFor(secretReceipts, author, rid)}
        pins={secretRequesters} onTrust={() => void trustRequester(m.channel, m.ref)} /></>;
    return parseSecretReceipt(m.body) ? <Body body={withoutSecretBlock(m.body)} mentions={m.mentions} me={identity} edited={m.edited} /> : null;
  };

  const waitingRefs = new Set(approvals.map((a) => a.ref));
  const waitingKey = approvals.map((a) => a.ref).join(" ");
  const renderMessage = (m: Message, inThread: boolean, prev?: Message, newest = false) => {
    // r18: a progress ping from hours or days ago is folded away as a past update, never the room's live status
    if (isWorkerStatus(m.body) && !(inThread && m.ref === root) && editing !== m.ref && staleStatus(m, Date.now() / 1000, newest)) return <details key={m.ref} data-ref={m.ref} className="message status-line status-past">
      <summary><span className="status-line-text">Earlier progress update</span><time>{time(m.ts)}</time></summary><p className="status-past-body">{m.body}</p></details>;
    // r19: Uni's upkeep notes (self-improvement reviews, the usage guard, cron jobs) are folded away, never a bubble in the conversation
    if (isMaintenance(m.body) && !(inThread && m.ref === root) && editing !== m.ref) return <details key={m.ref} data-ref={m.ref} className="message status-line status-past status-upkeep">
      <summary><span className="status-line-text">{UPKEEP_LABEL}</span><time>{clock(m.ts)}</time></summary><p className="status-past-body">{m.body}</p></details>;
    if (isWorkerStatus(m.body) && !(inThread && m.ref === root) && editing !== m.ref) return <article key={m.ref} data-ref={m.ref} className="message status-line" title={m.body}><span className="status-line-text">{m.body}</span><time>{clock(m.ts)}</time></article>;
    const grouped = !!prev && prev.author === m.author && m.ts - prev.ts < 300 && !(inThread && prev.ref === root);
    return <article key={m.ref} data-ref={m.ref} className={`message ${m.ref === focusRef ? "search-focus" : ""} ${grouped ? "grouped" : ""} ${m.author === identity ? "mine" : ""} ${m.mentions_me ? "highlight" : ""} ${inThread && m.ref === root ? "thread-root" : ""} ${waitingRefs.has(m.ref) ? "approval-waiting" : ""}`}>
      {grouped ? <time className="gutter-time">{clock(m.ts)}</time> : <span className="message-avatar" style={{ background: `hsl(${150 + (hue(m.author) % 120) - 60} 22% 44%)` }} aria-hidden="true">{m.author_name[0]?.toUpperCase() ?? "?"}</span>}
      <div className="message-content">{!grouped && <div className="message-meta"><strong>{m.author_name}</strong><time>{clock(m.ts)}</time></div>}{editing === m.ref ? <InlineEditor key={m.ref} initial={m.body} onSave={(body) => actions.current.saveEdit(m, body)} onCancel={() => actions.current.cancelEdit()} /> : secretView(m) ?? <Body body={attachmentBody(m.body, m.media, relayOrigin)} mentions={m.mentions} me={identity} edited={m.edited} />}
        <Attachments body={m.body} media={m.media} />
        {decisionCards(m, inThread)}
        {m.reactions.length > 0 && <div className="reactions" aria-label="Reactions">{m.reactions.map((r) => <span key={r.emoji} className={`pill ${r.mine ? "mine" : ""}`} aria-label={`${emojiLabel(r.emoji)} ${r.count}${r.mine ? ", including yours" : ""}`}>{emojiLabel(r.emoji)} <span>{r.count}</span></span>)}</div>}
        {!inThread && m.reply_count > 0 && <button className="thread-summary" onClick={() => actions.current.openThread(m)} aria-label={`View thread with ${m.reply_count} ${m.reply_count === 1 ? "reply" : "replies"}`}>💬 {m.reply_count} {m.reply_count === 1 ? "reply" : "replies"}{m.last_reply_ts ? <span> · last {time(m.last_reply_ts)}</span> : null}</button>}
        <div className={`message-more ${menuFor === m.ref ? "open" : ""}`}>
          <button className="message-more-go" onClick={() => setMenuFor(menuFor === m.ref ? null : m.ref)} aria-label={`More actions for ${m.author_name}'s message`} aria-expanded={menuFor === m.ref}>⋯</button>
          {menuFor === m.ref && <div className="message-menu" role="group" aria-label="Message actions" onClick={(e) => { if (e.target instanceof Element && !e.target.closest(".danger, [aria-label^='Delete'], [aria-label^='Tap again']")) setMenuFor(null); }}>
          <button onClick={() => void copyText(m.body, "Copied text")} aria-label={`Copy ${m.author_name}'s message`}>Copy</button>
          {m.author === identity && editing !== m.ref && <button onClick={() => setEditing(m.ref)} aria-label="Edit your message">Edit</button>}
          {m.author === identity && <DeleteButton key={`del-${m.ref}`} label="your message" onDelete={() => actions.current.deleteOwn(m)} />}
          </div>}
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
    out.push(renderMessage(m, inThread, sameDay ? prev : undefined, i === list.length - 1));
    return out;
  });

  actions.current = {
    openThread,
    loadOlder: () => void loadOlder(),
    saveEdit,
    cancelEdit: () => { setEditing(null); input.current?.focus(); },
    deleteOwn,
  };

  // The rendered timeline depends only on data, never on the draft, so
  // keystrokes in the composer don't rebuild hundreds of messages.
  const roomName = currentRoom?.name ?? "";
  const timeline = useMemo(() => isThread ? <>
    {rootMessage ? renderMessage(rootMessage, true) : messages.length > 0 && <p className="empty">Root message is not cached; showing replies we have.</p>}
    {rootMessage && <div className="thread-divider"><span>{threadReplies.length ? `${threadReplies.length} ${threadReplies.length === 1 ? "reply" : "replies"}` : "No replies yet"}</span></div>}
    {renderList(threadReplies, true)}
    {messages.length === 0 && fetchedView === currentView && <p className="empty">This thread has no messages yet.</p>}
    {/* r14: a thread's first read fails the same way a room's does, with Retry */}
    {messages.length === 0 && fetchedView !== currentView && (failedView === currentView
      ? <p className="empty room-loading" role="alert">Couldn't load the thread · <button type="button" className="pairing-secondary" onClick={() => setTick((n) => n + 1)}>Retry</button></p>
      : <p className="empty room-loading" role="status">Loading the thread…</p>)}
  </> : <>
    {messages.length > 0 && <div className="older">{older === "done" ? <span>Start of #{roomName}</span> : <button onClick={() => actions.current.loadOlder()} disabled={older === "loading"}>{older === "loading" ? "Loading older messages…" : "Load older messages"}</button>}</div>}
    {/* the kept copy or nothing until the store has answered: a room is never called empty before it has been read */}
    {messages.length === 0 && fetchedView === currentView && !(busy && synced === 0) && <p className="empty">No messages in this room yet.</p>}
    {/* r13: a known room is never a blank timeline while its first read is under way */}
    {messages.length === 0 && fetchedView !== currentView && (failedView === currentView
      ? <p className="empty room-loading" role="alert">Couldn't load messages · <button type="button" className="pairing-secondary" onClick={() => setTick((n) => n + 1)}>Retry</button></p>
      : <p className="empty room-loading" role="status">Loading messages…</p>)}
    {renderList(messages, false)}
    {currentView && fetchedView === currentView && channel && roomDecisions(channel, messages)}
  </>,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [messages, identity, menuFor, decisions.version, root, older, roomName, editing, focusRef, relayOrigin, fetchedView, failedView, currentView, busy, synced, secretRequesters, secretReceipts, waitingKey]);

  const topNote = notes[notes.length - 1];
  // A top-level note Back closes its tab and returns to the last used tab.
  const backTo = activeTab(tabs)?.kind === "note" && tabs.active ? nextAfterClose(tabs, tabs.active)?.title ?? "Conversations"
    : journalOpen ? "Journal" : currentRoom ? (isThread ? `Thread in ${currentRoom.name}` : currentRoom.name) : searchOpen ? "Search" : "Conversations";

  // Android back gesture/button: step back through the app (note stack,
  // search, thread, Journal, room) before leaving it. The listener is only
  // registered while there is somewhere to go back to, so at the room list
  // the system default runs (the app goes to the background, as usual).
  // Uni's chat room: the id the home page attaches (the Uni room by id, else the room named Uni).
  const uniHomeRoom = () => (roomsRef.current.some((r) => r.id === UNI_CHANNEL) ? UNI_CHANNEL : findUniRoom(roomsRef.current)?.id ?? null);
  const uniHome = (): TabTarget => ({ kind: "areas", title: "Uni", ...(uniHomeRoom() ? { channel: uniHomeRoom()! } : {}) });
  /** r22 (Codex 2): the place (Uni, an area, a room) a utility was opened from: Journal's and the Vault's Back return there, not always to Uni.
   *  Kept for this session only; a reopened utility returns to Uni. */
  const originRef = useRef<TabTarget | null>(null);
  const origin = (): TabTarget => originRef.current ?? uniHome();
  const asideRoom = channel && chatOnScreen(activeTab(tabs), channel, notes.length) && listEl?.isConnected && asides[channel] ? channel : null;
  const asideShown = !!asideRoom;
  const goBack = useRef<() => void>(() => {});
  goBack.current = () => {
    if (journalFocus) { setJournalFocus(false); return; }
    if (panel) { setPanel(null); return; }
    if (searchOpen) { setSearchOpen(false); return; }
    if (overlayRef.current && !notes.length) { overlayRef.current.close(); return; }
    if (notes.length) { closeNote(); return; }
    if (asideRoom) { backAside(asideRoom); return; }
    if (root && channel) { openTarget(roomTarget(channel), "focus"); return; }
    // A level goes up, a room on a phone goes back to the room tree (Uni's own level, opened from the tree, too); anything else goes to Uni.
    if (areaBack.current) { areaBack.current(); return; }
    if (activeTab(tabsRef.current)?.kind !== "areas") openTarget(origin(), "replace");
  };
  // At Uni's room tree (nothing open over it) the system's own Back runs: the app goes to the background.
  const canGoBack = !!panel || journalFocus || notes.length > 0 || asideShown || searchOpen || !!root || hasAreaBack || (!!activeTab(tabs) && activeTab(tabs)!.kind !== "areas");
  // Ctrl+W (Linux, Windows) closes what is open over the place. r22 (Codex 6): on macOS the native menu's "Close Window" owns Cmd+W.
  const closeActiveRef = useRef(() => {});
  const goHistoryRef = useRef<(by: -1 | 1) => void>(() => {});
  goHistoryRef.current = goHistory;
  const lastClose = useRef(0);
  closeActiveRef.current = () => {
    if (creating || confirmation) return;
    // A native menu event and a WebView keydown can both report one Cmd+W.
    if (Date.now() - lastClose.current < 120) return;
    lastClose.current = Date.now();
    // No tabs to close: Cmd+W closes what is open over the place (a note, a vault browser) and otherwise leaves the place alone.
    const cur = activeTab(tabsRef.current);
    if (cur && !isSurface(cur)) closeTabById(cur.id);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // r23 (Codex 8): on macOS Cmd+W is the native menu's Close Window, never the page's. Elsewhere Ctrl+W acts on the foreground: an open
      // dialog (a task or companion sheet) closes as Escape closes it; otherwise the note or vault view over the place closes
      if (e.key.toLowerCase() === "w" && !e.altKey && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
        if (/mac|iphone|ipad/i.test(navigator.platform)) return;
        if (!e.ctrlKey) return;
        e.preventDefault();
        const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].pop();
        if (dialog) { (dialog.contains(document.activeElement) ? document.activeElement as HTMLElement : dialog).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return; }
        closeActiveRef.current(); return;
      }
      // Alt+← / Alt+→: Back and Forward over the places visited. In a text field on a Mac, Option+arrow moves by word, so it is left alone there.
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const el = e.target instanceof HTMLElement ? e.target : null;
        const typing = !!el && (el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["button", "checkbox", "radio"].includes(el.type)));
        if (typing && /mac|iphone|ipad/i.test(navigator.platform)) return;
        e.preventDefault(); goHistoryRef.current(e.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
  useEffect(() => { if (active && (active.kind === "areas" || active.kind === "area")) { const { id: _id, ...t } = active; originRef.current = t; } }, [active]);
  const originTitle = originRef.current?.title || "Uni";
  const journalTab = tabs.tabs.find((t) => t.kind === "journal");
  const areasOpen = active?.kind === "areas" || active?.kind === "area";
  /** Every room opens in the room shell (tree, conversation, companion): a node's room, a room no node owns ("Other rooms"), a thread. */
  const shellOpen = areasOpen || active?.kind === "room" || active?.kind === "thread";
  const threadNode = active?.kind === "thread" && active.channel ? roomNodes.get(active.channel) ?? null : null;
  const shellPath = active?.kind === "area" ? active.path ?? null : threadNode && threadNode.path !== "" ? threadNode.path : null;
  const shellLoose = active?.kind === "room" || (active?.kind === "thread" && !threadNode) ? active.channel ?? null : null;
  const shellThread = active?.kind === "thread" && active.channel && active.root ? { channel: active.channel, root: active.root } : null;
  // Drafts only: the scope's draft is read when the room opens. Aaron presses Send.
  const composeInRoom = (id: string, text: string) => {
    const key = keyFor(id, null);
    editDraft(key, appendDraft(scopeDraft(key), text));
    focusComposer.current = true;
    openTargetRef.current(roomTarget(id), "new");
  };
  const composeInRoomRef = useRef(composeInRoom);
  composeInRoomRef.current = composeInRoom;
  // The open area's room: the active area tab carries its channel, so the room state above (messages, draft, send)
  // is already loaded for it. Text for its composer goes straight in (after any draft; never sends).
  const composeHere = (text: string) => {
    const key = scope();
    if (!key) return;
    const next = appendDraft(drafts.current.get(key) ?? draft, text);
    editDraft(key, next);
    setDraft(next);
    requestAnimationFrame(() => input.current?.focus());
  };
  /** The loaded room (or one of its threads, by root) as the shell's chat; null while another is loaded. */
  const areaRoomFor = (id: string | null | undefined, threadRoot: string | null = null) => {
    const room = id && channel === id && (root ?? null) === threadRoot ? currentRoom : undefined;
    if (!id || !room) return null;
    return { id, messages, loaded: loadedView === `${id}|${threadRoot}`, me: identity, render: (above: ReactNode, placeholder?: string) => roomPane(room, above, placeholder), compose: composeHere };
  };
  // An area learns its room from the area note; the tab remembers it, and the room view follows the tab.
  const syncAreaRoom = (id: string | null, own: boolean | null) => {
    const tab = activeTab(tabsRef.current);
    if (tab?.kind !== "area" && tab?.kind !== "areas") return;
    // an area tab also remembers whether the room is its own (r15): a borrowed one is not what the app reopens to
    const borrowed = tab.kind === "area" && own !== null ? !own : tab.borrowed;
    if ((tab.channel ?? null) !== id || tab.borrowed !== borrowed) commitTabs(updateTab(tabsRef.current, tab.id, { channel: id ?? undefined, borrowed }));
    if ((channel ?? null) !== id || root) navigate(id, null);
  };
  const areaActions = useMemo(() => ({
    /** `focus`: a message of that room to scroll to and mark (the request sheet's "Check in #room first" goes to the first message about it) */
    openRoom: (id: string, focus?: string | null, checking?: string | null) => { openTargetRef.current(roomTarget(id), "new"); if (focus) { focusTries.current = 0; setFocusRef(focus); } setChecking(checking ? { channel: id, text: checking } : null); },
    // r15: a note opens in the vault its reference names (the task's, the area's), the same vault its title was read from
    openNote: (r: NoteRef) => openNote({ hub: null, vault: r.vault, ref: r.id }, null),
    compose: (id: string, text: string) => composeInRoomRef.current(id, text),
    retryRooms: () => { void loadRooms().catch(() => {}); },
    focusMessage: (ref: string | null, room?: string, checking?: string | null) => { if (ref) { focusTries.current = 0; setFocusRef(ref); } if (room) setChecking(checking ? { channel: room, text: checking } : null); },
  }), [openNote, loadRooms]);
  /** T-161: an approval prompt opens its room at the prompt with the composer focused; the user answers there (nothing is sent for them) */
  const openApproval = (a: Approval) => {
    if (channelRef.current === a.channel && root === a.root) { focusTries.current = 0; setFocusRef(a.ref); input.current?.focus(); return; }
    focusComposer.current = true;
    // a prompt posted as a reply is in its thread, never the room's timeline: it opens there, as a search hit does
    if (a.root) { focusTries.current = 0; openTarget({ kind: "thread", channel: a.channel, root: a.root, title: `Thread · ${roomsRef.current.find((r) => r.id === a.channel)?.name ?? "Room"}` }, "focus"); setFocusRef(a.ref); }
    else areaActions.openRoom(a.channel, a.ref);
  };
  const approvalsView = { list: approvals, open: openApproval, roomName: (id: string) => rooms.find((r) => r.id === id)?.name ?? null };
  const primaryVault = vaults.includes(lifeVault) ? lifeVault : vaults.includes("uni") ? "uni" : null;
  const otherVaults = vaults.filter((vault) => vault !== primaryVault);
  const activeOtherVault = active?.kind === "vault" && active.vault && active.vault !== primaryVault && otherVaults.includes(active.vault) ? active.vault : null;
  function toggleOtherVaults() {
    const next = !otherVaultsExpanded;
    setOtherVaultsExpanded(next);
    try { localStorage.setItem(OTHER_VAULTS_KEY, String(next)); } catch { /* Storage may be unavailable. */ }
  }
  const vaultRow = (vault: string) => <button key={vault} className={`room ${active?.kind === "vault" && active.vault === vault ? "selected" : ""}`} aria-label={vault}
    aria-current={active?.kind === "vault" && active.vault === vault ? "page" : undefined}
    onClick={() => openTarget({ kind: "vault", vault, title: vault }, "new")}><span className="avatar" aria-hidden="true">▤</span><span className="room-text"><strong>{vault}</strong></span></button>;
  /** A place's identity: a room a node owns is that node (Uni's room, opened before the tree loaded, is Uni). */
  const placeOf = (t: TabTarget): string => { const n = t.kind === "room" && t.channel ? roomNodes.get(t.channel) : null; return n ? (n.path === "" ? "uni" : `area:${n.path}`) : placeKey(t); };
  const navControls: NavControls = {
    canBack: histCanBack(hist) || notes.length > 0 || hasOverlay || asideShown, canForward: histCanForward(hist) || (!!channel && !!listEl?.isConnected && !!asideAhead.current.get(channel)?.length && chatOnScreen(active ?? null, channel, notes.length)),
    places: [
      { label: "Journal", go: () => openTarget({ kind: "journal", title: "Journal" }) },
      { label: "Mail", go: () => openTarget({ kind: "mail", title: "Mail" }) },
      ...(calOn ? [{ label: "Calendar", go: () => openTarget({ kind: "calendar", title: "Calendar" }) }] : []),
      ...(showUniGlue(lifeVault) ? [{ label: "For you", go: openForYou }] : []),
      { label: "Vault", go: () => { setSearchOpen(false); setPanel("vault"); } },
      { label: "Search", go: () => { setPanel(null); setSearchQuery(""); setSearchScope({ vault: "", prefix: "" }); setSearchOpen(true); } },
      { label: "Settings", go: () => { setSearchOpen(false); setPanel("settings"); setForgetArmed(false); } },
    ],
    back: () => goHistory(-1), forward: () => goHistory(1), backPlace: () => goHistory(-1, true),
    recent: histRecent(hist, RECENT_SHOWN, placeOf).filter((t) => !active || placeOf(t) !== placeOf(active)).map((t) => ({ key: placeOf(t), title: t.title, path: t.kind === "area" ? t.path ?? null : null, room: t.kind === "room" ? t.channel ?? null : null, go: () => openTarget(t, "focus") })),
  };
  /** The open utility panel's own name (r14): its frame says where you are. */
  const panelTitle = searchOpen ? "Search" : panel === "settings" ? "Settings" : panel === "vault" ? "Vault" : "Places";
  const recordingTab = recordingOrigin.current;
  const pill = recordingTab && recorder.busy ? { title: recordingTab.title, elapsed: recorder.elapsed, tabId: recordingTab.tabId, stop: recorder.stop, phase: recorder.phase } :
    journalRecording && journalTab ? { title: "Journal", elapsed: journalRecording.elapsed, tabId: journalTab.id, stop: journalRecording.stop, phase: "recording" as const } : null;
  return <ApprovalsContext.Provider value={approvalsView}><NavContext.Provider value={navControls}><NoteOpener.Provider value={openNote}><main className={`shell ${(!sidebarVisible && (channel || journalOpen || shellOpen || (active?.kind === "note" || active?.kind === "vault" || active?.kind === "mail" || active?.kind === "calendar"))) ? "in-room" : ""} ${topNote ? "note-open" : ""} ${panel ? `panel-open panel-${panel}` : ""} ${searchOpen ? "search-open" : ""} ${composerFocused ? "composer-focused" : ""} ${journalFocus && journalOpen ? "journal-focus" : ""} ${railHidden ? "rail-off" : ""} ${asideShown ? `note-aside note-aside-${paneShape}` : ""}`}>
    <nav ref={railRef} className="rail" aria-label="Main navigation">
      <button aria-label="Uni" aria-current={!panel && !searchOpen && (!topNote && shellOpen ? "page" : undefined)} onClick={() => openTarget(uniHome())}><i><UniIcon /></i><span>Uni</span></button>
      <button aria-label="Journal" aria-current={!panel && !searchOpen && (journalOpen && !topNote ? "page" : undefined)} onClick={() => openTarget({ kind: "journal", title: "Journal" })}><i><JournalIcon /></i><span>Journal</span></button>
      <button aria-label="Mail" aria-current={!panel && !searchOpen && (active?.kind === "mail" && !topNote ? "page" : undefined)} onClick={() => openTarget({ kind: "mail", title: "Mail" })} aria-describedby={held > 0 ? "rail-mail-held" : undefined}><i><MailIcon />{held > 0 && <span className="rail-count" aria-hidden="true">{held}</span>}</i><span>Mail</span>{held > 0 && <span id="rail-mail-held" hidden>{held} waiting for you</span>}</button>
      {calOn && <button aria-label="Calendar" aria-current={!panel && !searchOpen && (active?.kind === "calendar" && !topNote ? "page" : undefined)} onClick={() => openTarget({ kind: "calendar", title: "Calendar" })}><i><CalendarIcon /></i><span>Calendar</span></button>}
      {showUniGlue(lifeVault) && <button aria-label="For you" aria-current={!panel && !searchOpen && (topNote?.ref === FOR_YOU_ID ? "page" : undefined)} onClick={openForYou}><i><StarIcon />{forYou.fresh && <span className="rail-dot" aria-label="Updated recommendations" />}</i><span>For you</span></button>}
      <button className="rail-vault" aria-label="Vault" aria-current={!panel && !searchOpen && (active?.kind === "vault" || (topNote && topNote.ref !== FOR_YOU_ID) ? "page" : undefined)} aria-expanded={panel === "vault"} onClick={() => { setSearchOpen(false); setPanel(panel === "vault" ? null : "vault"); }}><i>▤</i><span>Vault</span></button>
      <button className="rail-search" aria-label="Search" aria-expanded={searchOpen} onClick={() => { setPanel(null); setSearchQuery(""); setSearchScope({ vault: "", prefix: "" }); setSearchOpen(true); }}><i>⌕</i><span>Search</span></button>
      <button className="rail-settings" aria-label="Settings" aria-expanded={panel === "settings"} onClick={() => { setSearchOpen(false); setPanel(panel === "settings" ? null : "settings"); setForgetArmed(false); }}><i><SettingsIcon /></i><span>Settings</span></button>
    </nav>
    {(panel || searchOpen) && <button className="panel-scrim" aria-label="Close navigation panel" onClick={() => { setPanel(null); setSearchOpen(false); }} />}
    {/* r14: one utility-panel frame for Settings, Search and Vault: the destination's title and Close, nothing else */}
    <aside ref={panelBox} className="rooms" aria-label={panelTitle} {...(panel || searchOpen ? { role: "dialog", "aria-modal": true, tabIndex: -1 } : {})}>
      {(panel || searchOpen) && <header className="panel-head"><h1>{panelTitle}</h1><button className="panel-close icon-button" aria-label="Close panel" title="Close" onClick={() => { setPanel(null); setSearchOpen(false); }}>×</button></header>}
      {pairSourceOpen && <PairSource onClose={() => setPairSourceOpen(false)} />}
      {panel === "settings" && <div className="settings">
        <p className="connection" role="status">{status}{live ? <span className={`live ${live === "Live" ? "on" : ""}`}> · {live}</span> : null}</p>
      {identity && <p className="identity" title={npub ?? identity}>{myName ? <>Signed in as <strong>{myName}</strong></> : <>Public key <code>{npub ? `${npub.slice(0, 14)}…${npub.slice(-6)}` : `${identity.slice(0, 12)}…`}</code></>}<button className="identity-copy" onClick={() => void copyText(npub ?? identity, "Copied public key")} aria-label="Copy your public key">⧉</button></p>}
        <UpdateSettings /><LifeOsVaultSetting vaults={vaults} /><SealedApprovals /><PairDeviceButton onOpen={() => setPairSourceOpen(true)} /><button className="pairing-secondary" onClick={() => void forget()}>{forgetArmed ? "Tap again to forget — you'll need to re-pair" : "Forget this device key"}</button>{forgetArmed && <button className="pairing-secondary" onClick={() => setForgetArmed(false)}>Keep key</button>}
        {/* r13: the machinery (the app sandbox's self-test, where the app connects) is for whoever builds Uni, not part of ordinary Settings */}
        <details className="settings-dev"><summary>Developer</summary>{hub && <p className="settings-dev-line">Notes hub: <code>{hub}</code></p>}{syncDetail && <p className="settings-dev-line">Last sync: {syncDetail}</p>}<AreaSelfTest /></details></div>}
      {searchOpen && <Search initialQuery={searchQuery} vaults={vaults} key={`${searchScope.vault}:${searchScope.prefix}`} initialVault={searchScope.vault} initialPathPrefix={searchScope.prefix} onOpen={openHit} onOpenNote={(n) => { setSearchOpen(false); openNote({ hub: null, vault: n.vault, ref: n.id }, null); }} onAskUni={askUniSearch} onClose={() => { setSearchOpen(false); if (topNote) setSidebarVisible(false); }} />}
      {searchOpen && error && <p className="error search-error" role="alert">{error}</p>}
      <div className="rooms-body" hidden={searchOpen}>
      <section className="vault-sidebar" aria-label="Vaults"><div className="vault-heading"><button className="note-quiet" onClick={() => setVaultRefresh((n) => n + 1)}>Refresh the list</button></div>
        {vaultError && <p className="error" role="alert">{vaultError}</p>}
        {primaryVault && vaultRow(primaryVault)}
        {otherVaults.length > 0 && <>
          <button className={`vault-toggle ${activeOtherVault ? "selected" : ""}`} type="button" aria-expanded={otherVaultsExpanded} aria-controls="other-vault-list"
            aria-label={`Other vaults (${otherVaults.length})${activeOtherVault ? `, current vault ${activeOtherVault}` : ""}`}
            onClick={toggleOtherVaults}>Other vaults ({otherVaults.length})</button>
          <div id="other-vault-list" hidden={!otherVaultsExpanded}>{otherVaults.map(vaultRow)}</div>
        </>}
      </section>
      </div>
    </aside>
    <section className="conversation" aria-label={journalOpen ? "Journal" : active?.kind === "mail" ? "Mail" : active?.kind === "calendar" ? "Calendar" : shellOpen ? "Uni" : active?.kind === "note" ? "Note" : "Conversation"}>
      {journalTab && <div className="journal-tab-content" hidden={!journalOpen} onFocusCapture={(e) => { if (e.target instanceof HTMLTextAreaElement) requestAnimationFrame(() => setComposerFocused(true)); }} onBlurCapture={(e) => { const journal = e.currentTarget; requestAnimationFrame(() => setComposerFocused(journal.contains(document.activeElement) && document.activeElement instanceof HTMLTextAreaElement)); }}><Journal focus={journalFocus} onFocus={() => setJournalFocus((v) => !v)} rooms={rooms} uniRoomId={findUniRoom(rooms)?.id ?? null} onShare={shareEntry} backTo={originTitle} onBack={() => openTarget(origin())} onRecordingChange={(on, elapsed, stop) => { journalRecordingRef.current = on; setJournalRecording(on ? { elapsed, stop } : null); }} /></div>}
      {active?.kind === "mail" ? <Mail backTo={originTitle} onBack={() => openTarget(origin())} />
      : active?.kind === "calendar" ? <Calendar backTo={originTitle} onBack={() => openTarget(origin())} />
      : active?.kind === "vault" && active.vault ? <VaultBrowser key={active.vault} vault={active.vault} backTo={originTitle} onBack={() => openTarget(origin())} onOpen={(note) => openTarget({ kind: "note", note: { hub: null, vault: active.vault!, ref: note.id }, title: note.path || note.id }, "new")} onCreate={(folder) => requestCreate(active.vault!, folder)} onSearch={(prefix) => { setSearchQuery(""); setSearchScope({ vault: active.vault!, prefix }); setSearchOpen(true); setSidebarVisible(true); }} />
      : journalOpen ? null
      : shellOpen && active ? <AreasSurface noteBeside={asideShown && paneShape === "beside"} roomsPending={rooms.length === 0 && synced === 0} vaults={vaults} onBackChange={setAreaBack} onOverlayChange={setOverlay} identity={identity} key={`${active.id}:${identity ?? ""}`} path={shellPath} loose={shellLoose} thread={shellThread} rooms={rooms} actions={areaActions} roomFor={areaRoomFor} onRoom={syncAreaRoom}
          onOpenArea={(path, name, room) => openTarget(path === null ? { kind: "areas", title: "Uni", ...(room ? { channel: room } : {}) } : { kind: "area", path, title: name, ...(room ? { channel: room } : {}) }, "replace")} />
      : <div className="welcome"><span className="welcome-mark">✦</span><h2>Your conversation starts here</h2><p>Select a room to read and reply. Messages are cached for offline reading.</p></div>}
    </section>
    {asideRoom && listEl && <NotePane shape={paneShape} stack={asides[asideRoom]} hub={hub} list={listEl} layoutKey={`${channel}|${root}`} onQuote={composeHere}
      onSearch={(query) => { setSidebarVisible(true); setSearchQuery(query); setSearchScope({ vault: "", prefix: "" }); setSearchOpen(true); }}
      onOpen={(ref, href) => {
        // a link inside the note opens over it in the pane; another hub's note goes to the browser
        if (!sameHub(ref, hub, hubOrigins)) { if (href) void invoke("open_link", { url: href }).catch(() => {}); return; }
        pushAside(asideRoom, resolveNote({ ...ref, hub: null }, aliases.current));
      }}
      onBack={() => backAside(asideRoom)} onClose={() => backAside(asideRoom, true)}
      onOpenPage={(note, title) => {
        const el = listRef.current, top = el?.getBoundingClientRect().top ?? 0;
        const first = el ? [...el.querySelectorAll<HTMLElement>("[data-ref]")].find((m) => m.getBoundingClientRect().bottom > top) : undefined;
        returnSpot.current = first && currentView ? { view: currentView, ref: first.dataset.ref!, offset: first.getBoundingClientRect().top - top, limit, seq: appliedSeq.current } : null;
        openTarget({ kind: "note", note, title }, "new");
      }}
      onDirty={(ref, dirty) => { const k = noteKey(ref); if (dirty) asideDirty.current.add(k); else asideDirty.current.delete(k); }} />}
    {pill && <div className={`recording-pill ${sidebarVisible ? "over-sidebar" : ""}`} role="status" aria-live="polite">
      <span className="recording-dot" aria-hidden="true">●</span><span>{pill.phase === "recording" ? mmss(pill.elapsed) : pill.phase === "starting" ? "Starting…" : "Finishing…"}</span>
      <span className="recording-separator" aria-hidden="true">·</span>
      <button className="recording-destination" onClick={() => focusTabById(pill.tabId)} aria-label={`Jump to recording in ${pill.title}`}>{pill.title}</button>
      <span className="recording-separator" aria-hidden="true">·</span>
      <button className="recording-stop" onClick={pill.stop} disabled={pill.phase !== "recording"} aria-label={`Stop recording for ${pill.title}`}>Stop</button>
    </div>}
    {/* A note opens over the place you were in; Back pops the note's own stack (or closes it at the first note). */}
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
        // r21 (Codex 5): For you is a page of recommendations to read, not a vault document to edit (its note opens on request)
        readOnly={topNote.vault === "uni" && topNote.ref === FOR_YOU_ID}
        startEditing={editOnOpen.current.has(noteKey(topNote))}
        onDirty={(dirty) => { reportDirty(tabs.active!, noteKey(topNote), dirty); if (!dirty) editOnOpen.current.delete(noteKey(topNote)); }}
        onCreate={(folder) => requestCreate(topNote.vault, folder)}
        backLabel={topNote.ref === FOR_YOU_ID ? forYouBack.current : notes.length > 1 ? noteTitles[noteKey(notes[notes.length - 2])] ?? notes[notes.length - 2].ref.split("/").pop() ?? "note" : backTo}
        onTitle={(t) => rememberTitle(noteKey(topNote), t)} />
    </section>}
    {creating && <SurfaceModal onCancel={() => { if (!createBusy) setCreating(null); }}><form role="dialog" aria-modal="true" aria-label="New note" onSubmit={(e) => { e.preventDefault(); void createNote(); }}><h2>New note in {creating.vault}</h2><label>Path<input autoFocus value={creating.path} disabled={createBusy} onChange={(e) => setCreating({ ...creating, path: e.target.value })} /></label>{createError && <p className="error" role="alert">{createError}</p>}<button disabled={createBusy} type="submit">{createBusy ? "Creating…" : "Create note"}</button><button disabled={createBusy} type="button" onClick={() => setCreating(null)}>Cancel</button></form></SurfaceModal>}
    {confirmation && <SurfaceModal onCancel={() => setConfirmation(null)}><div role="alertdialog" aria-modal="true" aria-label="Confirm tab close">{confirmation.notice && <p role="status">{confirmation.notice}</p>}<p>{confirmation.text}</p><button autoFocus onClick={() => { const run = confirmation.run; setConfirmation(null); run(); }}>Continue</button><button onClick={() => setConfirmation(null)}>Cancel</button></div></SurfaceModal>}
    {toast && <div className="toast" role="status">{toast}</div>}
  </main></NoteOpener.Provider></NavContext.Provider></ApprovalsContext.Provider>;
}

export default App;
