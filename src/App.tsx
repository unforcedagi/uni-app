import { mark } from "./startupTrace";
import { readMessages, readRooms, readWho, writeMessages, writeRooms, writeWho } from "./chatCache";
import { keepSame } from "./keepSame";
import { isNetworkError, netError } from "./netError";
import { voiceRetryDelay } from "./voiceRetry";
import { VoiceOutbox, relayAccepted } from "./voiceOutbox";
import { forgetComposer } from "./all/AllView";
import { FOCUS_OUT_MS, type AllFocusState, type FocusView } from "./all/AllFocus";
import { saidIn } from "./all/allCore";
import { MoreIcon, SearchIcon, ToPostIcon, VaultIcon, SettingsIcon, UniIcon, JournalIcon, MailIcon, CalendarIcon, MessagesIcon } from "./Icons";
import Mail from "./Mail";
import Calendar from "./calendar/Calendar";
import { calShown, forgetCalendar, onCalShown, probeCalendar } from "./calendar/calDoor";
import Messages from "./messages/Messages";
import ToPost from "./post/ToPost";
import { forgetMessages, messagesShown, onMessagesShown, probeMessages } from "./messages/messagesDoor";
import { forgetAreas } from "./areas/useAreas";
import { forgetWork, setWorkOwner } from "./projects/store";
import { forgetUsage } from "./usage/usageNote";
import { useLifeOsVault } from "./areas/useLifeOsVault";
import { activeProfile, effectiveLifeVault, showUniGlue } from "./areas/profile";
import { clearProjectBodies } from "./areas/projectBody";
import AreasSurface from "./areas/LifeOsSurface";
import type { Overlay } from "./areas/AreasSurface";
import { setRootOpenMemory } from "./areas/rootMemory";
import { UNI_CHANNEL } from "./areas/treeCore";
import type { NoteRef } from "./areas/noteRefsCore";
import AreaSelfTest from "./interface/selftest/SelfTest";
import LifeOsVaultSetting from "./areas/LifeOsVaultSetting";
import { appendDraft } from "./areas/composeDraft";
import { openDialog } from "./areas/focusTrap";
import { ArcadeView } from "./arcade/ArcadeView.tsx";
import { ArcadeIcon } from "./arcade/ArcadeIcon.tsx";
import { readLastSurface, saveLastSurface } from "./railCore";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type TextareaHTMLAttributes } from "react";
import { draftBox, type DraftBox } from "./draftBox";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { announce, copyText, onCopied } from "./clipboard";
import { CHAT_DRAFT_PREFIX, loadChatDraft, saveChatDraft } from "./chatDrafts";
import { markFor, restoreTop, type ScrollMark } from "./noteText";
import "./App.css";
import { Body } from "./MessageBody";
import { isMaintenance, isWorkerStatus, staleStatus, UPKEEP_LABEL } from "./chatMarkers";
import Pairing from "./Pairing";
import { emojiLabel, type Reaction } from "./reactions";
import { DeleteButton, InlineEditor } from "./InlineEditor";
import { lastOwnMessage } from "./ownMessages";
import { workingOn } from "./working";
import { CONTINUE, commandOf, firstUnread, isStopReply, livePing, openAsk, quickReplies, receiptLine, RETRY, STOP, workReceipt, type Receipt, type TurnPhase } from "./chatFeel";
import { easeScroll, ICONS, MessageActions, MessageSheet, QuickReplies, shiftGlide, StatusLine, stopGlide, useLongPress, type Action } from "./ChatTurn";

import { decisionIn, useDecisionLinks } from "./decisionLinks";
import { DecisionCard, forgetDecisions } from "./DecisionCard";
import { checkHeld, forgetHeld, heldCount, mailUnread, onHeldCount, onMailUnread } from "./mailHeld";
import { decisionRefsIn, unreferenced } from "./decisionView";
import { findUniMember, findUniRoom, searchHandoffText } from "./uniActions";
import Search from "./Search";
import Journal, { JournalVaultSetting } from "./Journal";
import { AREA_ASK, areaRooms, shareText, type JournalNote } from "./journalCore";
import { useRecorder, voiceFileName, type RecorderControls } from "./recorder";
import RecordingPill from "./RecordingPill";
import { attachmentBlocksSend, enterInsertsNewline, manualAttachments } from "./composerCore";
import PairSource, { PairDeviceButton } from "./PairSource";
import { UpdateBanner, UpdateSettings } from "./UpdateNotice";
import ClaudeUsage from "./usage/ClaudeUsage";
import { watchLostIpc } from "./ipcLost";
import { currentUserAgent, platformName } from "./interface/selftest/gate";
import { activeTab, closeTab, EMPTY_TABS, focusTab, isSurface, isUniSide, LEGACY_TABS_KEY, migrateLegacyTabs, navigateNoteTab, nextAfterClose, openTab, persistable, recordingTabCanClose, readUniPlace, restoreTabs, sameTarget, serializeTabs, serializeUniPlace, updateTab, TABS_KEY, UNI_PLACE_KEY, viewOf, type Tabs, type Tab, type TabTarget, type OpenMode, type ReturnSpot } from "./tabs";
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
import { tooLargeLine, uploadMedia } from "./mediaUpload";
import { Attachments, attachmentBody, modalCount, useRelayOrigin, type MediaRef } from "./Attachments";
import { activeQuery, filterMembers, insertMention, memberLabels, pruneBindings, resolveRecipients, type Bindings, type Member } from "./mentions";
import { SmallLine } from "./areas/Companion";
import { SecretRequestCard } from "./SecretRequestCard";
import { EnrollmentLine, SealedApprovals } from "./SealedApprovals";
import { SealedCard } from "./SealedCard";
import { sealedFence, sealedProse } from "./sealedCardCore";
import { useSealedWaiting } from "./sealedLive";
import { parseEnrollment } from "./sealedCore";
import { parseSecretReceipt, parseSecretRequest, receiptFor, receiptsByRequest, secretCardsOn, withoutSecretBlock } from "./secretRequest";
import NotePane, { usePaneShape } from "./NotePane";
import { APPROVAL_WINDOW_S, ApprovalsContext, useApprovals } from "./approvalsLive";
import { ApprovalBanner } from "./areas/ApprovalRows";
import { parseApproval, type Approval } from "./approvals";
import { ApprovalPromptCard } from "./ApprovalPromptCard";
import MotionSetting from "./MotionSetting";
import { calmMotion, scrollMotion } from "./motion";

type Room = { id: string; name: string; last_message: string | null; last_ts: number | null; mentions: boolean; unread: number; /** a direct message, a room (false), or not known yet (null; absent in a list cached by an older app) */ dm?: boolean | null };
type Message = { ref: string; channel: string; author: string; author_name: string; ts: number; body: string; mentions_me: boolean; root: string | null; parent: string | null; mentions: Member[]; reply_count: number; last_reply_ts: number | null; edited: boolean; reactions: Reaction[]; media?: MediaRef[] };
type LivePayload = { kind: "message" | "edit" | "delete" | "rooms" | "profiles" | "status" | "typing"; channel: string | null; status: string | null; author: string | null; root?: string | null; notify?: { author_name: string; preview: string } };
/** Buzz desktop: an indicator lives 8 s; send at most one every 3 s. */
const TYPING_TTL_MS = 8000;
const TYPING_SEND_MS = 3000;
/** How long a freshly opened room holds the newest message against late layout (images, older pages). */
const SETTLE_MS = 1500;
/** T-335 chat feel: how far under the top of the chat a question just sent (or an answer longer than the screen) sits. */
const ANCHOR_GAP = 16;
type IdentityStatus = { paired: boolean; pubkey: string | null };
type SyncResult = { pubkey: string; total_items: number; channel_errors: Record<string, string>; truncated_channels: string[] };

type PendingFile = { owner?: string; relay?: string; created?: number; signedEvent?: string; id: string; file: File; preview: string | null; state: "uploading" | "ready" | "error"; media?: MediaRef; error?: string; voice?: { channel: string; replyTo: string | null; notifyUni: boolean } };
/** A voice message's limit, the same as the recorder's join limit and the transcriber's. */
const MAX_VOICE_BYTES = 25 * 1024 * 1024;
const invokeIpc = invoke as (cmd: string, args?: unknown, options?: { headers: Record<string, string> }) => Promise<unknown>;
const MAX_ATTACHMENTS = 20;
const OTHER_VAULTS_KEY = "uni:other-vaults-expanded";

// T-335: one formatter each, made once: `toLocaleString` with options builds a new one per call, and a room redraw called it per message
// (it was most of the cost of drawing a long room)
const timeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const time = (ts: number) => timeFormat.format(new Date(ts * 1000));
const keyFor = (channel: string, root: string | null) => `${channel}:${root ?? "room"}`;
const dayKey = (ts: number) => new Date(ts * 1000).toDateString();
function dayLabel(ts: number) {
  const d = new Date(ts * 1000), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
const clock = (ts: number) => clockFormat.format(new Date(ts * 1000));
// Stable per-author hue for letter avatars.
const hue = (pk: string) => parseInt(pk.slice(0, 6), 16) % 360;


const UNSAVED_NOTE = "This note has changes you haven't saved. Your draft stays on this device.";
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
  /** Discard asks twice (it sits under Attach, and takes the whole draft): the first press arms it, the second discards. */
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!open) setArmed(false); }, [open]);
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
      <button role="menuitem" className={armed ? "compose-discard armed" : "compose-discard"} disabled={!canDiscard}
        onClick={() => { if (!armed) { setArmed(true); return; } setOpen(false); trigger.current?.focus(); onDiscard(); }}><span aria-hidden="true">×</span> {armed ? "Tap again to discard" : "Discard draft"}</button>
    </div>}
  </div>;
}

/** A room's chat is what is on screen (a room, a thread, Uni or an area with its room) with no full-page note over it. */
function chatOnScreen(tab: { kind: string } | null, channel: string | null, fullPageNotes: number): boolean {
  return !!channel && !!tab && ["room", "thread", "areas", "area", "all"].includes(tab.kind) && !fullPageNotes;
}

/** T-200: scroll a list so the message `ref` sits `offset` px below its top. False when the message isn't in the list. */
function pinTo(list: HTMLElement, at: { ref: string; offset: number }): boolean {
  const m = list.querySelector(`[data-ref="${CSS.escape(at.ref)}"]`);
  if (!m) return false;
  list.scrollTop += m.getBoundingClientRect().top - list.getBoundingClientRect().top - at.offset;
  return true;
}

/** T-335: an out-of-flow copy of the composer that its text is measured in. Sizing the field itself (height auto, then read back) re-laid out
 *  the whole room column, every message in it, on every key. It holds the text only while measuring. */
let gauge: HTMLTextAreaElement | null = null;
let gaugeStyle = "";
// `width` is the layout width (transforms don't change it), border-box like the field
const GAUGED = ["width", "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "fontVariant", "fontKerning", "fontFeatureSettings",
  "fontVariationSettings", "letterSpacing", "wordSpacing", "textTransform", "textIndent", "lineHeight", "paddingTop", "paddingRight",
  "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderTopStyle",
  "borderRightStyle", "borderBottomStyle", "borderLeftStyle", "boxSizing", "whiteSpace", "overflowWrap", "wordBreak", "tabSize"] as const;

function resizeComposer(el: HTMLTextAreaElement) {
  const style = getComputedStyle(el);
  // T-200: with a note open beside or over the chat the composer stops at three lines (a quote scrolls inside it), so it never squeezes the pane
  const lines = el.closest(".note-aside") ? 3 : 6;
  // and never past the field's own CSS cap (64px on a short landscape window), where it scrolls instead
  const cssCap = parseFloat(style.maxHeight);
  const maxHeight = Math.min(parseFloat(style.lineHeight) * lines + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom), Number.isFinite(cssCap) ? cssCap : Infinity);
  if (!gauge?.isConnected) {
    gauge = document.createElement("textarea");
    gauge.setAttribute("aria-hidden", "true");
    gauge.tabIndex = -1;
    gauge.rows = 1;
    gauge.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;height:0;min-height:0;max-height:none;overflow:hidden;contain:layout style;";
    document.body.appendChild(gauge);
    gaugeStyle = "";
  }
  // the field's styles copied only when they change (a resize, a media query), not on every key
  const next = GAUGED.map((p) => style[p]).join("|");
  if (next !== gaugeStyle) { for (const p of GAUGED) gauge.style[p] = style[p]; gaugeStyle = next; }
  gauge.value = el.value;
  const content = gauge.scrollHeight;
  gauge.value = "";
  // written only when it changes: the same height is no new layout
  const height = `${Math.min(content, maxHeight)}px`, overflow = content > maxHeight ? "auto" : "hidden";
  if (el.style.height !== height) el.style.height = height;
  if (el.style.overflowY !== overflow) el.style.overflowY = overflow;
}

/** T-335: the composer's textarea, drawn from the draft box: a keystroke redraws this field (and sizes it), nothing else. */
function ComposerField({ box, inputRef, ...props }: { box: DraftBox; inputRef: (el: HTMLTextAreaElement | null) => (() => void) | void } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value">) {
  const value = useSyncExternalStore(box.subscribe, box.get, box.get);
  const own = useRef<HTMLTextAreaElement | null>(null);
  const ref = useCallback((el: HTMLTextAreaElement | null) => {
    own.current = el;
    const cleanup = inputRef(el);
    return () => { own.current = null; if (cleanup) cleanup(); else inputRef(null); };
  }, [inputRef]);
  useLayoutEffect(() => { if (own.current) resizeComposer(own.current); }, [value]);
  return <textarea ref={ref} value={value} {...props} />;
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
  /** T-302: an area opened before the rooms list arrived (a door of the front door, which paints from the areas first): the restore keeps it. */
  const openedEarly = useRef(false);
  /** The place on screen is one the app restored or opened, not the Uni it paints before the saved place is read. */
  const placeSettled = useRef(false);
  const [vaults, setVaults] = useState<string[]>([]);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [vaultRefresh, setVaultRefresh] = useState(0);
  const [otherVaultsExpanded, setOtherVaultsExpanded] = useState(() => {
    try { return localStorage.getItem(OTHER_VAULTS_KEY) === "true"; } catch { return false; }
  });
  const [searchQuery, setSearchQuery] = useState("");
  /** T-335 glow-up: Find keeps the last query, so reopening it (the rail, Ctrl/Cmd+K) brings the results back */
  const lastSearch = useRef("");
  const openFindRef = useRef<() => void>(() => {});
  const [searchScope, setSearchScope] = useState({ vault: "", prefix: "" });
  const [initialAliases] = useState<Record<string, string>>(() => {
    try { const value = JSON.parse(localStorage.getItem(ALIASES_KEY) ?? "{}"); return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string")) as Record<string, string> : {}; } catch { return {}; }
  });
  const aliases = useRef(initialAliases);
  const dirtyNotes = useRef(new Map<string, Set<string>>());
  const [, setDirtyTabs] = useState(new Set<string>());
  const editOnOpen = useRef(new Set<string>());
  const [confirmation, setConfirmation] = useState<{ text: string; run: () => void; notice?: string; /** the words on the button that goes ahead */ go: string } | null>(null);
  const [creating, setCreating] = useState<{ vault: string; path: string } | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const createLock = useRef(false);
  useEffect(() => {
    let live = true;
    setVaultError(null);
    invoke<string[]>("vault_list").then((names) => { if (live) setVaults(names); }).catch((e) => { if (live) { setVaultError(String(e)); if (vaultRefresh > 0) setToast("Couldn't look for new vaults"); } });
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
  /** The rail is hidden on short windows up to 950px (one rule, r14): the home's drawer then carries the app's places. */
  const railHidden = useRailHidden();
  const [railMore, setRailMore] = useState(false);
  useEffect(() => { if (!railMore) return; const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setRailMore(false); }; const width = window.innerWidth; const onSize = () => { if (window.innerWidth !== width) setRailMore(false); }; window.addEventListener("keydown", onKey); window.addEventListener("resize", onSize); return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("resize", onSize); }; }, [railMore]);
  const [journalFocus, setJournalFocus] = useState(false);
  const lifeVault = effectiveLifeVault(useLifeOsVault(), vaults);
  /** 0.2 one home: All is the home wherever the Uni glue is on (a vault of your own without it keeps its places page) */
  const homeIsAll = showUniGlue(lifeVault);
  const homeIsAllRef = useRef(homeIsAll);
  homeIsAllRef.current = homeIsAll;
  // T-229: Calendar is on the rail once the calendar door has answered this device's key
  const calOn = useSyncExternalStore(onCalShown, calShown, calShown);
  useEffect(() => {
    const probe = () => { const now = new Date(); void probeCalendar(new Date(now.getTime() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"), now.toISOString().replace(/\.\d{3}Z$/, "Z")); };
    const soon = window.setTimeout(probe, 3000);
    return () => window.clearTimeout(soon);
  }, []);
  // T-278: Messages is on the rail only in a build that has it (the `messages` feature): its door answered here
  const msgsOn = useSyncExternalStore(onMessagesShown, messagesShown, messagesShown);
  useEffect(() => {
    const soon = window.setTimeout(() => void probeMessages(), 3500);
    return () => window.clearTimeout(soon);
  }, []);
  // T-213: Uni's sends held for you, counted on the rail's Mail button (Mail keeps the count current while it is open)
  const [held, setHeld] = useState(heldCount);
  // T-208: and your Inbox's unread, from the same overview answers
  const unreadMail = useSyncExternalStore(onMailUnread, mailUnread, mailUnread);
  useEffect(() => {
    const off = onHeldCount(setHeld);
    const soon = window.setTimeout(() => void checkHeld(60_000), 4000); // skipped when Mail has just listed them
    const visible = () => { if (document.visibilityState === "visible") void checkHeld(10 * 60_000); };
    document.addEventListener("visibilitychange", visible);
    return () => { off(); window.clearTimeout(soon); document.removeEventListener("visibilitychange", visible); };
  }, []);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { setJournalFocus(false); setPanel(null); setSearchOpen(false); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  /** T-335 Taste Arcade: the profile note opens like any note, over the Arcade */
  const openArcadeNote = useCallback((vault: string, path: string) => { openTargetRef.current({ kind: "note", note: { hub: null, vault, ref: path }, title: "Taste profile" }, "new"); }, []);
  const [journalRecording, setJournalRecording] = useState<{ controls: RecorderControls } | null>(null);
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
  useLayoutEffect(() => { clearProjectBodies(); setWorkOwner(identity); }, [identity]);
  // T-335: the composer's text (draftBox.ts): a keystroke redraws the composer field only; this view redraws when it turns empty or blank
  const [box] = useState(() => draftBox());
  const setDraft = box.set;
  const draftShape = () => { const t = box.get(); return !t ? "empty" : !t.trim() ? "blank" : "text"; };
  const draftState = useSyncExternalStore(box.subscribe, draftShape, draftShape);
  const hasDraft = draftState !== "empty", draftBlank = draftState !== "text";
  const drafts = useRef(new Map<string, string>());
  const draftRevisions = useRef(new Map<string, number>());
  /** T-132: drafts are saved per identity; until it is known nothing is read or saved (what is typed meanwhile is saved when it is). */
  const identityRef = useRef<string | null>(null);
  /** Set once Forget device key is confirmed: from then on no draft is saved, whatever arrives later (an identity, a send landing). */
  const draftsForgotten = useRef(false);
  const [draftStorageWarning, setDraftStorageWarning] = useState("");
  const [pending, setPending] = useState<PendingFile[]>([]);
  const pendingStore = useRef(new Map<string, PendingFile[]>());
  const voiceQueue = useRef(Promise.resolve());
  const voiceCreated = useRef(0);
  const voiceJobs = useRef(new Set<string>());
  const voiceRetryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const voiceRetryAttempts = useRef(new Map<string, number>());
  /** Attachments on their way, so that removing one stops it: up to 500 MB of a phone's data for something no longer wanted. */
  const uploadAborts = useRef(new Map<string, AbortController>());
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
  /** r26 (Codex P1 3): the message being sent shows in its thread as "Sending…" the moment Send is pressed, until it is delivered. T-335 chat
   *  feel: the composer is empty from that same frame (a send that fails puts the text back); `at` is when it went, `toUni` whether this room's
   *  Uni was asked, and once posted `ref` is its id: it stays on screen until the room's list has it, so nothing blinks out in between. */
  const [outgoing, setOutgoing] = useState<{ key: string; body: string; at: number; toUni: boolean; ref?: string } | null>(null);
  /** T-335 chat feel: the messages sent to Uni from this device, and when (unix seconds): until Uni's 👀, the status line says it is passing. */
  const asked = useRef(new Map<string, number>());
  /** T-335 chat feel: a button's words (Stop, Try again, Continue, a chip) on their way: one at a time, the buttons wait meanwhile. */
  const postingRef = useRef(false);
  const [posting, setPosting] = useState(false);
  /** T-335 chat feel: the long-press sheet's message (touch). */
  const [sheetFor, setSheetFor] = useState<string | null>(null);
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
    // text that came in before (typed, or put there by Say it) goes after the saved draft, never over it
    else for (const [key, text] of drafts.current) {
      const saved = loadChatDraft(identity, key);
      if (saved && saved.text !== text) {
        const mentions = new Map([...saved.mentions, ...(bindingStore.current.get(key) ?? [])]);
        // joined as written: the saved text keeps every space (appendDraft trims)
        drafts.current.set(key, text ? `${saved.text}\n\n${text}` : saved.text);
        bindingStore.current.set(key, mentions);
        // a change of text, so a send on its way doesn't take it for its own and clear it
        draftRevisions.current.set(key, (draftRevisions.current.get(key) ?? 0) + 1);
      }
      if (drafts.current.get(key)) storeDraft(key, drafts.current.get(key)!, bindingStore.current.get(key));
    }
    const key = activeScope.current;
    if (key) {
      setDraft(scopeDraft(key));
      bindingsRef.current = bindingStore.current.get(key) ?? new Map();
      setBindings(bindingsRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);
  const actions = useRef({ openThread: (_m: Message) => {}, loadOlder: () => {}, saveEdit: (_m: Message, _b: string): Promise<void> => Promise.resolve(), cancelEdit: () => {}, deleteOwn: (_m: Message): Promise<void> => Promise.resolve(),
    postAs: (_body: string) => {} });
  /** T-335 chat feel: each message's row, built from the handlers of this render (MessageActions is memoised on what it shows). */
  const rowMaker = useRef<(m: Message) => { actions: Action[]; tail?: ReactNode }>(() => ({ actions: [] }));

  const [searchOpen, setSearchOpen] = useState(false);
  // r19: Search, Settings and Vault keep the one dialog contract the sheets and Places keep: focus in, Tab kept inside, what is under them inert
  // (the rail, which switches them, and their scrim excepted), Escape closes them, and focus goes back to what opened them
  const panelBox = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const utilityOpen = !!panel || searchOpen;
  useEffect(() => {
    const box = panelBox.current;
    if (!utilityOpen || !box) return;
    return openDialog(box, () => { setPanel(null); setSearchOpen(false); }, { keep: [railRef.current, box.parentElement?.querySelector(".panel-scrim") ?? null], initial: box, fallback: () => railRef.current?.querySelector<HTMLElement>(".rail-more") ?? null });
  }, [utilityOpen]);
  // Search result to scroll to and flash once its room/thread has loaded.
  const [focusRef, setFocusRef] = useState<string | null>(null);
  const focusPlaced = useRef<string | null>(null);
  const focusDecided = useRef<string | null>(null);
  // T-335 one fluid surface: the room in focus inside All (AllFocus.tsx). The All tab stays what it is, with its feed in place behind; this room's view (messages, composer, drafts) is
  // the one the room's page uses, so one send path, one draft per room and one signer serve both.
  // T-335 one surface: every way into a room comes here (`openRoom`); the All tab remembers the room in focus, so All comes back with it and
  // the app reopens on it.
  const [allFocus, setAllFocusState] = useState<AllFocusState | null>(null);
  const allFocusRef = useRef<AllFocusState | null>(null);
  /** `keep`: the All tab keeps the room it had (All is left for another place: coming back brings the room back). */
  const setAllFocus = (f: AllFocusState | null, keep = false) => {
    allFocusRef.current = f; setAllFocusState(f);
    if (keep) return;
    const tab = tabsRef.current.tabs.find((t) => t.kind === "all");
    const on = f && !f.leaving ? f : null;
    if (tab && ((tab.channel ?? null) !== (on?.room ?? null) || (tab.root ?? null) !== (on?.root ?? null) || (tab.path ?? null) !== (on?.path ?? null))) {
      const { channel: _c, root: _r, path: _p, ...rest } = tab;
      commitTabs({ ...tabsRef.current, tabs: tabsRef.current.tabs.map((t) => (t.id === tab.id ? { ...rest, ...(on ? { channel: on.room, ...(on.root ? { root: on.root } : {}), ...(on.path ? { path: on.path } : {}) } : {}) } : t)) });
    }
  };
  const focusLeaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishRef = useRef<() => void>(() => {});
  const stopLeaving = () => { if (focusLeaving.current) { clearTimeout(focusLeaving.current); focusLeaving.current = null; } };
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
      setConfirmation({ text: UNSAVED_NOTE, go: "Close note", run: () => openAside(room, target, true) }); return;
    }
    asideAhead.current.delete(room);
    putAside(room, [target]);
  }
  /** Back in the room's note: one step (a link inside it), kept for Forward; or `all` (×, Escape) closes it. Leaving an unsaved edit asks first. */
  function backAside(room: string, all = false, confirmed = false) {
    const cur = asidesRef.current[room];
    if (!cur) return;
    if (!confirmed && paneDraft(all ? cur : cur.slice(-1))) {
      setConfirmation({ text: UNSAVED_NOTE, go: "Close note", run: () => backAside(room, all, true) }); return;
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
  /** T-294: the last place on Uni's side (see `origin`). */
  const uniPlace = useRef<TabTarget | null>(null);
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
    if (by < 0 && allFocusRef.current) { if (panel || searchOpen) { setPanel(null); setSearchOpen(false); } else stepBackInFocus(); return; }
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
      } catch { /* private storage */ }
      placeSettled.current = true;
      // a new place on Uni's side is kept (at its newest); the same place again keeps the spot already saved for it
      const cur = activeTab(next);
      if (cur && isUniSide(cur)) { const { id: _id, ...t } = cur; if (uniPlace.current && sameTarget(t, uniPlace.current)) uniPlace.current = t; else keepUniPlace(cur, null); }
    }
  }
  /** T-294: the place on Uni's side, kept for the way back to it (in memory, and on the device for a restart), with the spot in its conversation. */
  function keepUniPlace(t: Tab, spot: ReturnSpot | null) {
    const { id: _id, ...target } = t;
    uniPlace.current = target;
    try { localStorage.setItem(UNI_PLACE_KEY, serializeUniPlace(target, spot)); } catch { /* private storage: this session still has it */ }
  }
  function switchToTab(tab: Tab | null) {
    // T-294: leaving Uni's side (for Messages, Mail, the Journal…) keeps where the reader was in its conversation, for the way back. Any other
    // place on Uni's side opens at its newest (T-124 r2), and drops a spot kept for another.
    const from = activeTab(tabsRef.current);
    if (placeSettled.current && from && isUniSide(from) && tab && !isUniSide(tab)) { const spot = spotOf(from); returnSpot.current = spot; keepUniPlace(from, spot); }
    else if (tab && isUniSide(tab) && returnSpot.current && returnSpot.current.view !== viewOf(tab)) returnSpot.current = null;
    setComposerFocused(false);
    setPanel(null);
    setSearchOpen(false);
    setJournalFocus(false);
    if (tab?.kind === "journal") saveLastSurface(localStorage, "journal");
    else if (tab?.kind === "areas" || tab?.kind === "all") saveLastSurface(localStorage, "uni");
    const leaving = tabsRef.current.active;
    if (leaving) noteStacks.current.set(leaving, notesRef.current);
    // navigate restores scoped draft, attachments, scroll and bindings.
    navigate(tab?.channel ?? null, tab?.root ?? null);
    // T-335 one surface: All comes back with the room it had in focus (a trip to Mail and back, a restart)
    if (tab?.kind === "all" && tab.channel) { stopLeaving(); setAllFocus({ room: tab.channel, root: tab.root ?? null, path: tab.path ?? null, view: "chat", leaving: false }, true); }
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
  /**
   * T-335 one surface: every way into a room (a place on the home, search, a task, an approval, a link, a reply, a restart). All is the place and
   * the room is in focus over it: at a message (`ref`), in a thread (`root`), for the place that talks there (`path`, a place borrowing the room),
   * with its details first (`view`). `checking`: the request sheet's question, kept over the composer.
   */
  function openRoom(room: string, o: { ref?: string | null; root?: string | null; path?: string | null; view?: FocusView; checking?: string | null; keys?: boolean } = {}) {
    setSearchOpen(false); setPanel(null); setRailMore(false);
    // a room opened before the rooms list has come (a cold launch): the saved place isn't restored over it
    if (!tabsReady.current) openedEarly.current = true;
    const go = () => {
      if (o.keys !== undefined) focusComposer.current = o.keys;
      focusInAll(room, o.ref ?? null, o.root ?? null, { path: o.path, view: o.view ?? "chat", keys: o.keys });
      setChecking(o.checking ? { channel: room, text: o.checking } : null);
    };
    // (a note left unsaved asks first: the room comes up once the person leaves it, and not at all if they stay)
    if (activeTab(tabsRef.current)?.kind !== "all") openTarget({ kind: "all", title: "Uni" }, "focus", false, false, go); else go();
  }
  /** `fromHistory`: Back and Forward move through the places visited; they do not add to them. */
  function openTarget(target: TabTarget, mode: OpenMode = "focus", confirmed = false, fromHistory = false, then?: () => void) {
    // 0.2 one home: Uni's places page is All, with its places under the head (an older save, a step back, a place's way up)
    if (target.kind === "areas" && !target.path && homeIsAll) target = { kind: "all", title: "Uni" };
    // already in All, with a room in focus: All is what is behind it
    if (target.kind === "all" && allFocusRef.current && activeTab(tabsRef.current)?.kind === "all") {
      // a panel over it goes first; the room stays in focus under it
      setSidebarVisible(false);
      if (panel || searchOpen) { setPanel(null); setSearchOpen(false); } else endAllFocus();
      return;
    }
    // T-335 one surface: a place's room (an area saved by an older version, a step back to one) is that room in focus over All
    if (target.kind === "area" && target.channel) { openRoom(target.channel, { path: target.path ?? null }); return; }
    if (target.kind === "areas") setRootOpenMemory(false);
    if (!tabsReady.current && target.kind === "area") openedEarly.current = true;
    if (target.note) target = { ...target, note: resolveNote(target.note, aliases.current) };
    // No tab strip: a place replaces the one you were on (a second tab never shows the same room). The Journal keeps its own tab (its page and any recording stay alive), and a place opened from it goes beside it.
    if (isSurface(target) && target.kind !== "journal" && mode === "new") mode = "focus";
    if (target.kind === "journal") mode = "new";
    else if (isSurface(target) && mode === "focus" && activeTab(tabsRef.current)?.kind === "journal") mode = "new";
    // T-335 one surface: All with a room in focus stays (Mail, Uni's home, a note open beside it), so All and Back bring the room back
    if (target.kind !== "all" && target.kind !== "journal" && isSurface(target) && mode !== "new") { const cur = activeTab(tabsRef.current); if (cur?.kind === "all" && cur.channel) mode = "new"; }
    // A recording's origin tab must survive the 12-tab eviction cap.
    const originId = recordingOrigin.current?.tabId;
    const pinned = new Set(tabsRef.current.tabs.filter((t) => t.id === originId || (t.kind === "journal" && journalRecordingRef.current)).map((t) => t.id));
    const base = { ...tabsRef.current, tabs: tabsRef.current.tabs.map((t) => t.note ? { ...t, note: resolveNote(t.note, aliases.current) } : t), recent: [...tabsRef.current.recent.filter((id) => !pinned.has(id)), ...pinned] };
    // a recording's tab is never replaced: going elsewhere (a row of the tree, a phone's Back to the tree) opens beside it
    const effectiveMode = (mode === "focus" || mode === "replace") && pinned.has(tabsRef.current.active ?? "") ? "new" : mode;
    const next = openTab(base, target, effectiveMode, () => crypto.randomUUID());
    const removed = tabsRef.current.tabs.filter((t) => !next.tabs.some((n) => n.id === t.id));
    if (removed.some((t) => t.id === originId || (t.kind === "journal" && journalRecordingRef.current))) {
      setError("Stop the recording before leaving it."); return;
    }
    if (!confirmed && removed.some(isTabDirty)) {
      setConfirmation({ text: UNSAVED_NOTE, go: "Leave note", run: () => openTarget(target, mode, true, fromHistory, then) }); return;
    }
    removed.forEach((t) => dirtyNotes.current.delete(t.id));
    const tab = activeTab(next);
    if (tab && (next.active !== tabsRef.current.active || mode === "replace")) switchToTab(tab);
    commitTabs(next);
    if (!fromHistory && tab) pushHistory(tab);
    setSidebarVisible(false);
    setPanel(null);
    setSearchOpen(false);
    then?.();
  }
  function closeTabById(id: string, confirmed = false) {
    const closing = tabsRef.current.tabs.find((t) => t.id === id);
    if (!confirmed && closing && isTabDirty(closing)) {
      setConfirmation({ text: UNSAVED_NOTE, go: "Close note", run: () => closeTabById(id, true) }); return;
    }
    if (!recordingTabCanClose(id, recordingOrigin.current?.tabId ?? null)) {
      setError("Stop the voice recording before leaving the room."); return;
    }
    if (journalRecordingRef.current && tabsRef.current.tabs.find((t) => t.id === id)?.kind === "journal") {
      setError("Stop the Journal recording before leaving the Journal."); return;
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
  const openTargetRef = useRef(openTarget);
  const openRoomRef = useRef(openRoom);
  openRoomRef.current = openRoom;
  const closeTabRef = useRef(closeTabById);
  const closeNoteRef = useRef<() => void>(() => {});
  const switchToTabRef = useRef(switchToTab);
  openTargetRef.current = openTarget;
  closeTabRef.current = closeTabById;
  switchToTabRef.current = switchToTab;
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
  const returnSpot = useRef<(ReturnSpot & { seq: number }) | null>(null);
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
  /** T-335 chat feel: a question just sent is held 16 px under the top of the chat while its answer grows below it (the view never follows
   *  the text down); `spaceRef` is the blank room below the content that lets it sit there. Held until the room changes or the reader asks
   *  for the end ("More below"). */
  const anchor = useRef<{ view: string; ref: string | null; placed: boolean; /** placing it waits for the next frame */ due?: boolean; /** where it was placed (scroll coordinates) */ top?: number; /** the reader scrolled: no more holding */ free?: boolean } | null>(null);
  const spaceRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  /** The refs in the view when its first read came in, and the newest time among them: a later message arrived live, and settles in. */
  const known = useRef<{ view: string | null; refs: Set<string>; ts: number; arrived: Set<string> }>({ view: null, refs: new Set(), ts: 0, arrived: new Set() });
  /** A room opened on unread: how many, read before the room marks itself read; then the first unread message, which the New line sits over. */
  const unreadAtOpen = useRef<{ view: string; unread: number } | null>(null);
  const [newLine, setNewLine] = useState<{ view: string; ref: string; ts: number } | null>(null);
  const [loadedView, setLoadedView] = useState<string | null>(null);
  /** The view whose messages the relay store has answered with (not just the device's kept copy): only then can a room be said to be empty. */
  const [fetchedView, setFetchedView] = useState<string | null>(null);
  /** The view whose last read failed with nothing kept to show: the timeline says so, with Retry, instead of loading forever. */
  const [failedView, setFailedView] = useState<string | null>(null);
  const fetchSeq = useRef(0), appliedSeq = useRef(0), viewNow = useRef<string | null>(null);
  /** T-200: how many messages the applied fetch asked for (a spot to return to waits for the window it was taken in). */
  const appliedLimit = useRef(0);
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  /** T-335 one surface: the reader's spot as a list went away, for a list of the same room drawn again at once (the surface around a room in
   *  focus can be drawn anew as the app signs in): it comes back where it was, not at the newest. */
  const remountSpot = useRef<{ view: string; ref: string; offset: number; at: number } | null>(null);
  const setList = useCallback((el: HTMLDivElement | null) => {
    if (!el && listRef.current) { const s = spotNowRef.current(); remountSpot.current = s ? { view: s.view, ref: s.ref, offset: s.offset, at: Date.now() } : null; }
    listRef.current = el;
    restoredView.current = null;
    setListEl(el);
  }, []);
  const [stackEl, setStackEl] = useState<HTMLDivElement | null>(null);
  /** The spot the reader is at in the conversation on screen (the first message in sight, and how far down it is); null at its newest,
   *  undefined with no conversation on screen to read one from. */
  function spotNow(): (ReturnSpot & { seq: number }) | null | undefined {
    const el = listRef.current, view = restoredView.current;
    if (!el || !view || !el.isConnected) return undefined;
    if (markFor(el.scrollTop, el.scrollHeight, el.clientHeight).atEnd) return null;
    const top = el.getBoundingClientRect().top;
    const first = [...el.querySelectorAll<HTMLElement>("[data-ref]")].find((m) => m.getBoundingClientRect().bottom > top);
    return first ? { view, ref: first.dataset.ref!, offset: first.getBoundingClientRect().top - top, limit, seq: appliedSeq.current } : null;
  }
  const spotNowRef = useRef(spotNow);
  spotNowRef.current = spotNow;
  /** A place's spot: read from its conversation when that is on screen, else the one still waiting to be applied to it (a restart's). */
  function spotOf(t: Tab): (ReturnSpot & { seq: number }) | null {
    const view = viewOf(t), now = restoredView.current === view ? spotNow() : undefined;
    return now !== undefined ? now : returnSpot.current?.view === view ? returnSpot.current : null;
  }
  const spotOfRef = useRef(spotOf);
  spotOfRef.current = spotOf;
  // T-294: put away (the system may close the app from there), the room's spot is kept with its place, so a restart comes back to it
  useEffect(() => {
    const keep = () => {
      if (document.visibilityState !== "hidden" || !placeSettled.current) return;
      const cur = activeTab(tabsRef.current);
      if (cur && isUniSide(cur)) keepUniPlace(cur, spotOfRef.current(cur));
    };
    document.addEventListener("visibilitychange", keep);
    window.addEventListener("pagehide", keep);
    return () => { document.removeEventListener("visibilitychange", keep); window.removeEventListener("pagehide", keep); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
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
  /** T-335 chat feel: the field was focused when it was last taken out (the room view redrawn around it): the new one takes the focus back. */
  const refocusField = useRef(false);
  const composerInput = useCallback((el: HTMLTextAreaElement | null) => {
    input.current = el;
    if (!el) return;
    mark("composer");
    if (refocusField.current) { refocusField.current = false; el.focus({ preventScroll: true }); }
    resizeComposer(el);
    let width = el.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = el.getBoundingClientRect().width;
      if (nextWidth !== width) { width = nextWidth; resizeComposer(el); }
    });
    observer.observe(el);
    return () => {
      observer.disconnect(); input.current = null;
      // a focused field that goes fires no blur: say so, or the phone's bottom bar stays hidden for a composer no longer focused
      if (document.activeElement === el) refocusField.current = true;
      requestAnimationFrame(() => { refocusField.current = false; setComposerFocused(!!document.activeElement?.closest(".composer")); });
    };
  }, []);
  useLayoutEffect(() => { if (input.current) resizeComposer(input.current); }, [asides, channel, notes.length]); // T-200: a note opening or closing changes the cap (the field sizes itself as text changes)
  const focusComposer = useRef(false);
  // T-161: every room's Hermes approval prompts still waiting, for Needs you, the room and one notification each
  // T-161 and T-234: how both notify (the room's name; whether the user is already looking at it)
  const notifyOpts = { synced, roomsReady: rooms.length > 0, roomName: (id: string) => roomsRef.current.find((r) => r.id === id)?.name ?? null,
    looking: (ch: string, r: string | null) => document.hasFocus() && ch === channelRef.current && r === rootRef.current };
  const { list: hermesApprovals, ended: promptsEnded, failed: promptsFailed } = useApprovals({ identity, enabled: !!identity, ...notifyOpts });
  // T-234: Uni's approval cards waiting for a tap join the same list (Needs you, the room's banner, the room's mark)
  const sealedWaiting = useSealedWaiting({ enabled: !!identity, ...notifyOpts });
  const approvals = useMemo(() => [...hermesApprovals, ...sealedWaiting].sort((a, b) => a.ts - b.ts), [hermesApprovals, sealedWaiting]);

  /** Whose rooms list this run has written to the device's copy. */
  const roomsSavedFor = useRef<string | null>(null);
  const loadRooms = useCallback(async (cached?: Room[]) => {
    const fresh = cached ?? await invoke<Room[]>("get_rooms");
    if (fresh.length) mark(cached ? "roomsCached" : "rooms");
    // T-335: every live event re-reads the rooms; the same list (and each unchanged room) stays the object already drawn, so nothing redraws for it
    const rows = keepSame(roomsRef.current, fresh, (r) => r.id);
    const changed = rows !== roomsRef.current;
    if (changed) { setRooms(rows); roomsRef.current = rows; }
    // the device's copy: written on a change, and once for each identity (the first read can come before the identity is known)
    if (!cached && whoRef.current && (changed || roomsSavedFor.current !== whoRef.current)) { writeRooms(localStorage, whoRef.current, rows); roomsSavedFor.current = whoRef.current; }
    if (!cached) setUnreadBadge(rows.reduce((n, r) => n + (r.unread || 0), 0));
    if (!tabsReady.current) {
      tabsReady.current = true;
      // 0.1.46: no tab strip. The app reopens to the place it was last on (v2 holds just that); v1's set of tabs is ignored beyond its active surface.
      const ids = rows.map((r) => r.id);
      let saved: string | null = null, legacy: string | null = null;
      try { saved = localStorage.getItem(TABS_KEY); if (!saved) legacy = localStorage.getItem(LEGACY_TABS_KEY); } catch { /* private storage */ }
      let next = openedEarly.current && activeTab(tabsRef.current) ? tabsRef.current : saved ? restoreTabs(saved, ids) : migrateLegacyTabs(legacy, ids);
      // T-335 one surface: an area saved with its room (an older version's room page) reopens as that room in focus over All
      const was = activeTab(next);
      // 0.2 one home: an area an older version saved without its room (0.1.45's tab strip) reopens on the home, All
      if (was?.kind === "area" && !was.channel && homeIsAllRef.current) next = { ...next, tabs: next.tabs.map((t) => (t.id === was.id ? { id: t.id, kind: "all" as const, title: "Uni" } : t)) };
      else if (was?.kind === "area" && was.channel) { const tabs = next.tabs.filter((t) => t.kind !== "all" || t.id === was.id).map((t) => (t.id === was.id ? { id: t.id, kind: "all" as const, title: "Uni", channel: was.channel, ...(was.path ? { path: was.path } : {}) } : t)); next = { ...next, tabs, recent: next.recent.filter((id) => tabs.some((t) => t.id === id)) }; }
      // T-294: Uni's side's last place (the way back from Messages, Mail, the Journal), and its spot, which the room comes back to
      let place = null;
      try { place = readUniPlace(localStorage.getItem(UNI_PLACE_KEY), ids); } catch { /* private storage */ }
      if (place) { uniPlace.current = place.target; returnSpot.current = place.spot ? { ...place.spot, seq: -1 } : null; }
      if (!activeTab(next)) {
        const uni = rows.some((r) => r.id === UNI_CHANNEL) ? UNI_CHANNEL : findUniRoom(rows)?.id;
        // The app opens to Uni: the home (T-302: the archived Uni room is no longer the home, so none is attached).
        // 0.2.2: #Uni is archived (10-26), so the relay lists no Uni room: with the Uni glue the home is All, whatever the rooms are. Only an
        // account without the glue and without a Uni room opens its first room.
        const target: TabTarget = readLastSurface(localStorage) === "journal" ? { kind: "journal", title: "Journal" }
          : uni || homeIsAllRef.current || !rows[0] ? { kind: "areas", title: "Uni" } : { kind: "all", title: "Uni", channel: rows[0].id };
        next = openTab(next, target, "new", () => crypto.randomUUID());
      }
      // T-302: a restored Uni place is Uni's own level when it carries its room, else the front door (as resolveTarget decides for an open)
      const restored = activeTab(next);
      if (restored?.kind === "areas") setRootOpenMemory(!!restored.channel);
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
      // T-335 one surface: a room gone while it is in focus leaves it (All is All again), and All forgets it
      const f = allFocusRef.current;
      if (f && !rows.some((r) => r.id === f.room)) { stopLeaving(); setAllFocus(null, true); if (activeTab(previous)?.kind === "all") navigate(null, null); }
      if (next.tabs.length === previous.tabs.length && serializeTabs(next) !== serializeTabs(previous)) commitTabs(next);
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
    invoke<Message[]>("get_messages", { channel, root, limit }).then((rows) => { if (rows.length) mark("messages"); if (viewNow.current === view && seq > appliedSeq.current) { appliedSeq.current = seq; appliedLimit.current = limit; setMessages((old) => keepSame(old, rows, (m) => m.ref)); setLoadedView(view); setFetchedView(view); setFailedView(null); if (root === null) writeMessages(localStorage, whoRef.current, channel, rows); } }).catch((e) => { if (current) { setError(String(e)); setFailedView(view); } });
    // Viewing the room reads it (only while the app is actually on screen).
    if (document.visibilityState === "visible") {
      invoke("mark_read", { channel }).then(() => loadRooms()).catch(() => {});
    }
    return () => { current = false; };
  }, [channel, root, synced, tick, limit, loadRooms]);

  // T-335 chat feel: the count is read as the room opens (its read mark comes a moment later); a thread has no New line
  useLayoutEffect(() => {
    const view = channel ? `${channel}|${root}` : null;
    anchor.current = null; setMoreBelow(false); setSheetFor(null); setNewLine(null);
    const n = channel && !root ? roomsRef.current.find((r) => r.id === channel)?.unread ?? 0 : 0;
    unreadAtOpen.current = view && n > 0 ? { view, unread: n } : null;
  }, [channel, root]);
  // New room: back to the default window; older pages load on demand.
  // T-200: the room a note was opened as a page from comes back with the older messages it had loaded, so its spot is there to return to
  useEffect(() => { const spot = returnSpot.current; setLimit(spot && channel && spot.view.startsWith(`${channel}|`) ? spot.limit : 300); setOlder("idle"); setEditing(null); asideAhead.current.clear(); }, [channel]);

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
  // no room on screen (All, with nothing in focus): the last room's read isn't this visit's when it comes back
  useEffect(() => { if (!currentView) { setFetchedView(null); setFailedView(null); } }, [currentView]);
  useLayoutEffect(() => {
    const el = listEl;
    if (!el || !currentView || loadedView !== currentView || restoredView.current === currentView) return;
    // T-124 r2: a room always opens at its latest message (no remembered spot), and stays there while images and older pages settle
    // in, until the reader scrolls on purpose. T-200: except the room a note was opened as a page from, which comes back to its spot.
    const spot = returnSpot.current?.view === currentView ? returnSpot.current : null;
    // the device's kept copy holds only the newest messages: a spot further back waits for the fetched window (below)
    if (!spot || (appliedSeq.current > spot.seq && appliedLimit.current >= spot.limit)) returnSpot.current = null;
    const again = !spot && remountSpot.current?.view === currentView && Date.now() - remountSpot.current.at < 2000 ? remountSpot.current : null;
    remountSpot.current = null;
    if (again && pinTo(el, again)) {
      stickToEnd.current = false;
      settleUntil.current = 0;
      pinned.current = { ref: again.ref, offset: again.offset, until: Date.now() + SETTLE_MS };
    } else if (spot && pinTo(el, spot)) {
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

  // T-335 chat feel: the anchored question's top and the content's end (the space's top), in the list's scroll coordinates
  function anchorBox(list: HTMLElement) {
    const a = anchor.current, space = spaceRef.current;
    if (!a || !space) return null;
    const el = (a.ref ? list.querySelector<HTMLElement>(`[data-ref="${CSS.escape(a.ref)}"]`) : null) ?? list.querySelector<HTMLElement>('[data-outgoing="true"]');
    if (!el) return null;
    const origin = list.getBoundingClientRect().top - list.scrollTop;
    return { top: el.getBoundingClientRect().top - origin, end: space.getBoundingClientRect().top - origin };
  }
  /** Sizes the space so the anchored question can sit under the top, and says whether there is more below the screen. */
  function fitAnchor() {
    const list = listRef.current, space = spaceRef.current;
    if (!list || !space) return;
    let a = anchor.current, box = a && a.view === restoredView.current ? anchorBox(list) : null;
    // what it held is gone (a send that failed, a stand-in that timed out): let go, and follow the newest again
    if (a && a.placed && !box && a.view === restoredView.current) { anchor.current = a = null; stickToEnd.current = true; setAwayView(null); }
    const h = `${Math.round(box ? Math.max(0, list.clientHeight - ANCHOR_GAP - (box.end - box.top)) : 0)}px`;
    if (space.style.height !== h) space.style.height = h;
    // what is above it changed height (the last reply's row folding away, a picture loading): it stays where it was, unless the reader moved
    if (a && box && a.placed && !a.free && a.top !== undefined && Math.abs(box.top - a.top) > 0.5) { const d = box.top - a.top; list.scrollTop += d; shiftGlide(d); a.top = box.top; }
    setMoreBelow(!!box && box.end - (list.scrollTop + list.clientHeight) > 24);
  }
  /** Lets go of a hold whose message never landed (a failed send): the space goes, and the view is back at the newest, following it. */
  function releaseAnchor(view: string | null) {
    if (!anchor.current || anchor.current.ref || anchor.current.view !== view) return;
    anchor.current = null;
    setMoreBelow(false);
    if (spaceRef.current) spaceRef.current.style.height = "0px";
    stickToEnd.current = true;
    setAwayView(null);
    const list = listRef.current;
    if (list) { stopGlide(); list.scrollTop = list.scrollHeight; }
  }
  /** Holds what is sent next in this view under the top of the chat. */
  function anchorNext(view: string | null) {
    if (!view) return;
    // only from the end of the room (or near it): a reader scrolled back into the history (a note open beside it, T-200) keeps the place,
    // and the newest is a tap away (Jump to latest)
    // (a follow-up sent while an answer is held from its top anchors too: that reader is in the conversation, not the history)
    const list = listRef.current, holding = !!anchor.current && anchor.current.view === view && !anchor.current.free;
    // (a reply from a room in focus, opened at an older message, is the conversation: it shows; with a note beside it, that reader keeps the place too)
    const reading = !allFocusRef.current || !!asidesRef.current[allFocusRef.current.room];
    if (reading && list && !stickToEnd.current && !holding && list.scrollHeight - list.scrollTop - list.clientHeight > list.clientHeight / 2) return;
    anchor.current = { view, ref: null, placed: false };
    stickToEnd.current = false; settleUntil.current = 0; pinned.current = null;
  }
  // the question, once drawn: the space under it is sized, then it glides up (220 ms; a jump when calm). In the next frame, before it is
  // painted (one redraw on the Daylight): the send itself never waits for the layout this reads
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a || a.placed || a.due || a.view !== currentView || restoredView.current !== currentView) return;
    a.due = true;
    requestAnimationFrame(() => {
      a.due = false;
      const list = listRef.current;
      if (!list || anchor.current !== a || a.placed || restoredView.current !== a.view) return;
      // one read of the layout, then the writes (the space, the scroll)
      const box = anchorBox(list), space = spaceRef.current;
      if (!box || !space) return;
      a.placed = true;
      a.top = box.top;
      space.style.height = `${Math.round(Math.max(0, list.clientHeight - ANCHOR_GAP - (box.end - box.top)))}px`;
      gliding.current = Date.now() + 400;
      easeScroll(list, box.top - ANCHOR_GAP, 220, calmMotion());
    });
  });
  // T-335 chat feel: a room opened on unread lands on its first unread message under the New line, once the store has answered
  useLayoutEffect(() => {
    const u = unreadAtOpen.current;
    if (!u || u.view !== currentView || fetchedView !== currentView || restoredView.current !== currentView) return;
    unreadAtOpen.current = null;
    const i = firstUnread(messages, u.unread, identity);
    if (i >= 0) { newPlaced.current = false; setNewLine({ view: u.view, ref: messages[i].ref, ts: messages[i].ts }); }
  }, [currentView, fetchedView, messages, identity]);
  const newPlaced = useRef(false);
  useLayoutEffect(() => {
    const el = listEl, line = newLine;
    if (!el || !line || line.view !== currentView || newPlaced.current) return;
    const at = el.querySelector<HTMLElement>(".new-line");
    if (!at) return;
    newPlaced.current = true;
    // opened at a message you asked for: the list stays on it (the New line still marks where the new ones start)
    if (focusRef) return;
    stickToEnd.current = false;
    settleUntil.current = 0;
    stopGlide();
    el.scrollTop += at.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
    const m = el.querySelector<HTMLElement>(`[data-ref="${CSS.escape(line.ref)}"]`);
    if (m) pinned.current = { ref: line.ref, offset: m.getBoundingClientRect().top - el.getBoundingClientRect().top, until: Date.now() + SETTLE_MS };
  }, [listEl, currentView, newLine, messages]);

  // Remember where the reader is, per view (only once that view is restored,
  // so a half-swapped list never overwrites a good mark).
  const gliding = useRef(0);
  const settleUntil = useRef(0);
  useEffect(() => {
    const el = listEl;
    if (!el) return;
    // T-132: the reader's own input also ends a glide to a new message, so a scroll up under way then is theirs, not the glide's
    const onUser = () => { settleUntil.current = 0; pinned.current = null; jumpUntil.current = 0; gliding.current = 0; stopGlide(); if (anchor.current) anchor.current.free = true; };
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
      if (anchor.current?.view === v) {
        fitAnchor();
        const a = anchor.current;
        // the reader scrolled to the end of what is there (nothing held below): the hold is over, the view follows again
        if (a && a.free && mark.atEnd && (!spaceRef.current || spaceRef.current.offsetHeight === 0)) anchor.current = null;
        else if (a) { stickToEnd.current = false; setAwayView(null); return; }
      }
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
      if (anchor.current && anchor.current.view === restoredView.current) { fitAnchor(); return; }
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
    // T-335: calm (the Daylight, reduced motion) jumps: no glide to wait out
    const behavior = scrollMotion();
    // T-335 chat feel: a new message from someone else longer than the screen is shown from its top; the view doesn't follow it down
    const list = listRef.current, last = messages[messages.length - 1];
    const live = !!last && known.current.view === currentView && !known.current.refs.has(last.ref);
    const el = live && last.author !== identity ? list.querySelector<HTMLElement>(`[data-ref="${CSS.escape(last.ref)}"]`) : null;
    if (el && el.offsetHeight > list.clientHeight - 80) {
      stickToEnd.current = false;
      gliding.current = Date.now() + 400;
      easeScroll(list, list.scrollTop + el.getBoundingClientRect().top - list.getBoundingClientRect().top - ANCHOR_GAP, 220, behavior !== "smooth");
      return;
    }
    if (behavior === "smooth") gliding.current = Date.now() + 700;
    scrollEnd.current?.scrollIntoView({ behavior, block: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  // Jump to a search hit: once its room/thread is rendered, center and flash
  // it. If it is older than the loaded window, widen the window once.
  useEffect(() => {
    if (!focusRef) { focusPlaced.current = null; focusDecided.current = null; return; }
    // Wait until the list shows the target room (and thread), not the last one.
    if (loadedView !== currentView || !messages.length || messages[0].channel !== channel) return;
    if (root && !messages.some((m) => m.ref === root || m.root === root)) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-ref="${CSS.escape(focusRef)}"]`);
    if (el) {
      const box = listRef.current;
      // placed once: what arrives while the mark is on doesn't send the list back to it. A message taller than the list opens at its top, where its reader starts.
      if (box && focusPlaced.current !== focusRef) {
        el.scrollIntoView({ block: el.offsetHeight > box.clientHeight - 32 ? "start" : "center" });
        // the list may be the device's kept copy: nothing follows the newest yet, and it stays there as the rest comes in
        stickToEnd.current = false;
        settleUntil.current = 0;
        pinned.current = { ref: focusRef, offset: el.getBoundingClientRect().top - box.getBoundingClientRect().top, until: Date.now() + 2000 };
      }
      focusPlaced.current = focusRef;
      // the room's read has answered: at its end, the view simply goes on following; else it follows again when the reader scrolls down to it
      if (box && focusDecided.current !== focusRef && (fetchedView === currentView || failedView === currentView)) {
        focusDecided.current = focusRef;
        const atEnd = markFor(box.scrollTop, box.scrollHeight, box.clientHeight).atEnd;
        stickToEnd.current = atEnd;
        if (atEnd) pinned.current = null;
        setAwayView(atEnd ? null : currentView);
      }
      // the mark lasts its time from then: a slow read mustn't end it before that decision is made
      if (focusDecided.current !== focusRef) return;
      const t = setTimeout(() => setFocusRef(null), 2500);
      return () => clearTimeout(t);
    }
    // the kept copy may just be older than the message: the read in hand answers first; only then is the room's long history asked for
    if (fetchedView !== currentView && failedView !== currentView) return;
    if (focusTries.current++ === 0 && !root) { setLimit((l) => Math.max(l, 3000)); return; }
    setFocusRef(null);
    setStatus("That message isn't in the loaded history of this room");
  }, [focusRef, messages, channel, root, fetchedView, failedView, currentView, loadedView]); // eslint-disable-line react-hooks/exhaustive-deps

  function openHit(t: { channel: string; root: string | null; focus: string }) {
    setSearchOpen(false);
    openRoom(t.channel, { ref: t.focus, root: t.root, path: null });
  }

  // Fallback when the hub is unreachable: the Uni of the room you were last in searches the vault and replies there (0.2.2: #Uni is
  // archived; there is no room for everything, so the ask goes where you were, and the button says which room).
  // (at the home no room is loaded: the last one you were in still counts. Never a known direct message; a room whose kind isn't known
  // yet is offered, and one without its Uni in the roster stops with a line, posting nothing)
  const lastRoom = useRef<string | null>(null);
  useEffect(() => { if (channel && rooms.some((r) => r.id === channel && r.dm !== true)) lastRoom.current = channel; }, [channel, rooms]);
  const searchAt = channel ?? lastRoom.current;
  const searchRoom = searchAt ? rooms.find((r) => r.id === searchAt && r.dm !== true) ?? null : null;
  async function askUniSearch(query: string): Promise<boolean> {
    setError(null);
    const room = searchRoom;
    if (!room) { setError("Open a room first: its Uni searches your notes and answers there."); return false; }
    const name = `#${room.name.replace(/^#/, "")}`;
    try {
      const roster = await invoke<Member[]>("get_members", { channel: room.id });
      const uni = findUniMember(roster);
      if (!uni) { setError(`Uni isn't in ${name}'s member list yet. Try again in a moment.`); return false; }
      const label = memberLabels(roster).get(uni.pubkey) ?? uni.name;
      await invoke<Message>("post_message", { channel: room.id, body: searchHandoffText(query, label), replyTo: null, recipients: [uni.pubkey] });
      setStatus(`Asked Uni · results will arrive in ${name}`);
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

  // Journal → an area room, addressed to the room's Uni and p-tagged (Hermes in a group room wakes only on a mention); the entry itself
  // stays in the vault, and the room gets its link (T-263). (0.2.2: no "Pass to Uni": #Uni is archived, and every room has its Uni.)
  async function shareEntry(note: JournalNote, roomId: string, vault: string, journalHub: string) {
    // an area room gets the link only: without a hub the message would carry the entry's words
    if (!journalHub) throw new Error("No Parachute hub set, so there's no link to send.");
    // the chip may be older than what the core knows now (a room that turned out to be a DM, or was archived): ask again before posting
    const now = await invoke<Room[]>("get_rooms");
    if (!areaRooms(now, findUniRoom(now)?.id ?? null).some((r) => r.id === roomId)) {
      await loadRooms();
      throw new Error("That isn't an area room any more, so nothing was sent.");
    }
    let label: string | null = null;
    const recipients: string[] = [];
    const roster = await invoke<Member[]>("get_members", { channel: roomId });
    const uni = findUniMember(roster);
    if (uni) {
      label = memberLabels(roster).get(uni.pubkey) ?? uni.name;
      recipients.push(uni.pubkey);
    }
    await invoke<Message>("post_message", { channel: roomId, body: shareText(note, vault, label, AREA_ASK, journalHub), replyTo: null, recipients });
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
  // T-335 chat feel: the turn, in phases: the message is on its way, then waiting for Uni (until its 👀), then Uni works (until its reply).
  // A stop ends it; so does anything from anyone else. Only messages sent to Uni from here are waited on.
  const nowS = Date.now() / 1000;
  const ask = viewShown ? openAsk(messages, identity) : null;
  const working = ask ? workingOn(messages, identity, nowS) : null;
  const out = outgoing && channel && outgoing.key === keyFor(channel, root) && commandOf(outgoing.body) !== "stop" ? outgoing : null;
  // a 👀 seen on it, or an answer in its thread: no longer waiting to be picked up (a reply there ends the work too)
  if (ask && (working || (ask.last_reply_ts ?? 0) > 0)) asked.current.delete(ask.ref);
  const askedAt = ask ? asked.current.get(ask.ref) : undefined;
  const turn: { phase: TurnPhase; since: number } | null = out?.toUni && !out.ref ? { phase: "sending", since: out.at }
    : working ? { phase: "working", since: working.since }
    : out?.toUni ? { phase: "waiting", since: out.at }
    : askedAt !== undefined && nowS - askedAt < 1800 ? { phase: "waiting", since: askedAt } : null;
  const turnPing = turn?.phase === "working" ? livePing(messages)?.body ?? null : null;
  // a live ping in a turn that isn't yours (someone else asked): no message of its own either, so the line says it, in words
  // (not a ping landing after your own stop: that turn is over)
  let lastTalk: Message | undefined;
  for (let i = messages.length - 1; i >= 0 && !lastTalk; i--) if (!isWorkerStatus(messages[i].body)) lastTalk = messages[i];
  const afterStop = !!lastTalk && lastTalk.author === identity && commandOf(lastTalk.body) === "stop";
  const otherPing = !turn && viewShown && !afterStop ? livePing(messages) : null;
  const pingLine = otherPing && !staleStatus(otherPing, nowS, true) ? otherPing : null;
  /** The message whose receipt reads "Sent" (posted, not yet picked up). */
  const sentRef = turn?.phase === "waiting" && ask && !out ? ask.ref : null;
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
    el.scrollTo({ top: el.scrollHeight, behavior: scrollMotion() });
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
    uploadAborts.current.get(id)?.abort();
    changePending(key, (items) => {
      const item = items.find((x) => x.id === id);
      if (item?.preview) URL.revokeObjectURL(item.preview);
      return items.filter((x) => x.id !== id);
    });
  }
  async function uploadFile(key: string, id: string, file: File) {
    changePending(key, (items) => items.map((x) => x.id === id ? { ...x, state: "uploading", error: undefined } : x));
    const controller = new AbortController();
    uploadAborts.current.set(id, controller);
    try {
      const media = await uploadMedia(file, file.name, file.type || "application/octet-stream", invokeIpc, controller.signal);
      changePending(key, (items) => items.map((x) => x.id === id ? { ...x, media, state: "ready" } : x));
    } catch (e) {
      changePending(key, (items) => items.map((x) => x.id === id ? { ...x, state: "error", error: e instanceof Error ? e.message : String(e) } : x));
    } finally {
      if (uploadAborts.current.get(id) === controller) uploadAborts.current.delete(id);
    }
  }
  function addFiles(files: File[]) {
    const key = scope();
    if (!key || !files.length) return;
    const current = pendingStore.current.get(key) ?? [];
    const room = MAX_ATTACHMENTS - current.length;
    if (files.length > room) setError(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
    for (const file of files.slice(0, Math.max(0, room))) {
      const refused = file.size ? tooLargeLine(file.size) : "This file is empty.";
      if (refused) { setError(`${file.name}: ${refused}`); continue; }
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
        if (clip.file.size > MAX_VOICE_BYTES) throw new Error("Recording exceeds 25 MB.");
        await persistVoice(key, id);
        if (!pendingStore.current.get(key)?.some((x) => x.id === id)) return; // removed while it was being saved
        const controller = new AbortController();
        uploadAborts.current.set(id, controller);
        const media = await Promise.resolve(clip.media ?? uploadMedia(clip.file, clip.file.name, clip.file.type, invokeIpc, controller.signal))
          .finally(() => { if (uploadAborts.current.get(id) === controller) uploadAborts.current.delete(id); });
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
        saidIn(destination.channel);
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
        // Removed while it was going up: that's the end of it, and the next voice note can have its turn.
        if (!pendingStore.current.get(key)?.some((x) => x.id === id)) return;
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
  type RecordingOrigin = { key: string; tabId: string; title: string; channel: string; replyTo: string | null; notifyUni: boolean; root?: string | null };
  const recordingOrigin = useRef<RecordingOrigin | null>(null);
  const recorder = useRecorder((blob, mime, origin: RecordingOrigin) => {
    if (recordingOrigin.current === origin) recordingOrigin.current = null;
    if (!blob.size) { setError("Recording was empty. Please record again."); return; }
    const file = new File([blob], voiceFileName(mime), { type: mime.split(";")[0] });
    const id = crypto.randomUUID();
    changePending(origin.key, (items) => [...items, { id, file, preview: null, state: "uploading", created: (voiceCreated.current = Math.max(Date.now(), voiceCreated.current + 1)), voice: { channel: origin.channel, replyTo: origin.replyTo, notifyUni: origin.notifyUni } }]);
    void (async () => { await voiceRestored.current; if (voiceMounted.current) queueVoice(origin.key, id); })();
  }, `for #${rooms.find((r) => r.id === channel)?.name ?? "room"}`, { onDiscard: (origin) => {
    if (recordingOrigin.current === origin) recordingOrigin.current = null;
    setVoiceStatus("Recording deleted");
  } });
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
    // from a room in focus, the pill names the room, not All
    const origin = { key, tabId: tab.id, title: allFocusRef.current ? roomsRef.current.find((r) => r.id === channel)?.name ?? tab.title : tab.title, channel, replyTo: target, notifyUni, root };
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
    if (!owner || draftsForgotten.current) return;
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
    // T-335: nothing dropped is the same map, so the view isn't redrawn for it
    const next = pruneBindings(text, bindingsRef.current);
    if (key) { bindingStore.current.set(key, next); editDraft(key, text, next); }
    if (next !== bindingsRef.current) { bindingsRef.current = next; setBindings(next); }
    syncPicker(text, caret);
  }

  function syncPicker(text: string, caret: number | null) {
    const q = caret === null ? null : activeQuery(text, caret, { settled: bindingsRef.current.keys(), names: members.map((m) => labels.get(m.pubkey) ?? m.name) });
    setPicker((old) => q ? { ...q, index: old && old.start === q.start ? old.index : 0 } : null);
  }

  function choose(member: Member) {
    if (!picker) return;
    const el = input.current;
    const draft = box.get();
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
    const draft = box.get();
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
    if (e.key === "ArrowUp" && !box.get()) {
      // Slack/Buzz convention: ArrowUp in an empty composer edits your last message.
      const last = lastOwnMessage(messages, identity);
      if (last) { e.preventDefault(); setEditing(last.ref); }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  }

  /** Puts a room (or a thread of it) in focus inside All, at a message if one is named. Works from All, from another focus, and while one is on its way out.
   *  `path`: the place it is open for (one that borrows this room); `view`: the conversation, or the room's details first. */
  function focusInAll(room: string, ref: string | null = null, threadRoot: string | null = null, o: { path?: string | null; view?: FocusView; keys?: boolean } = {}) {
    stopLeaving();
    const was = allFocusRef.current;
    const view = o.view ?? "chat";
    // `path` unsaid (a step inside the focus: a thread, a draft): the place stays as it was; said (null too): it is that
    setAllFocus({ room, root: threadRoot, path: o.path !== undefined ? o.path : was?.room === room ? was.path ?? null : null, view, leaving: false });
    // a pointer that doesn't bring up a keyboard goes on typing; a touch keeps the thread on screen (an approval to answer in words asks for the keys itself)
    if (o.keys === undefined && !matchMedia("(pointer: coarse)").matches && view === "chat") focusComposer.current = true;
    setChecking(null);
    // (the same room still leaving stays as it is; otherwise its view comes up, whatever the tab's own switch has just queued)
    if (!was || was.room !== room || was.root !== threadRoot) navigate(room, threadRoot);
    // only this opening's message: a mark from a visit that was cut short doesn't come back
    focusTries.current = 0;
    setFocusRef(ref);
  }
  /** Ends the focus: All is in reach at once; the room's pane goes when it has finished leaving. */
  function endAllFocus() {
    const f = allFocusRef.current;
    if (!f || f.leaving) return;
    // the keyboard goes as the room does
    if (document.activeElement instanceof HTMLElement && document.activeElement.closest(".all-focus")) document.activeElement.blur();
    setComposerFocused(false);
    setFocusRef(null);
    const finish = () => { focusLeaving.current = null; setAllFocus(null); if (activeTab(tabsRef.current)?.kind === "all") navigate(null, null); };
    if (calmMotion()) { finish(); return; }
    setAllFocus({ ...f, leaving: true });
    focusLeaving.current = setTimeout(() => finishRef.current(), FOCUS_OUT_MS);
    finishRef.current = finish;
  }
  /** Back in focus: the room's work or app steps to its details, the details to the conversation, a thread to its room, the room to All. */
  function stepBackInFocus() {
    const f = allFocusRef.current;
    if (!f) return;
    if (f.leaving) { stopLeaving(); finishRef.current(); return; }
    if (f.view === "work" || f.view === "app") { setFocusView("details"); return; }
    if (f.view === "details") { setFocusView("chat"); return; }
    if (f.root) focusInAll(f.room, null, null, { path: f.path ?? null });
    else endAllFocus();
  }
  /** Inside the focus: the conversation, the room's details, all of its work, its app. */
  function setFocusView(view: FocusView) {
    const f = allFocusRef.current;
    if (!f || f.leaving || f.view === view) return;
    setAllFocus({ ...f, view });
  }

  function navigate(nextChannel: string | null, nextRoot: string | null) {
    const key = scope();
    const draft = box.get();
    // Save the spot in the view we're leaving; the next view restores its own.
    const leaving = restoredView.current, el = listRef.current;
    if (leaving && el) scrollMemory.current.set(leaving, markFor(el.scrollTop, el.scrollHeight, el.clientHeight));
    if (nextChannel !== channel || nextRoot !== root) restoredView.current = null;
    const nextKey = nextChannel ? keyFor(nextChannel, nextRoot) : null;
    // Same scope again (a second tab on this room): the map already holds the live draft, and a caller may just have appended to it.
    // (before the identity is known an empty composer only means its saved draft isn't read yet: that is not kept as the draft)
    if (key && key !== nextKey && (identityRef.current || draft || drafts.current.has(key))) { drafts.current.set(key, draft); bindingStore.current.set(key, bindings); }
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
    const threadRoot = m.root && messages.some((x) => x.ref === m.root) ? m.root : m.ref;
    openRoom(m.channel, { root: threadRoot, path: allFocusRef.current?.room === m.channel ? allFocusRef.current.path ?? null : null });
  }

  async function send() {
    const draft = box.get();
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
    // T-335 chat feel: the composer is empty in the same frame as Send (the text is put back if the send fails, in front of anything typed
    // since, so it is never lost); the message is on screen at once, and held under the top of the chat while the answer comes
    const sentMentions = bindings, none: Bindings = new Map();
    bindingStore.current.set(key, none);
    // emptied in memory now; the device's saved copy keeps the text until it is delivered (an app closed mid-send gives it back)
    drafts.current.set(key, "");
    draftRevisions.current.set(key, (draftRevisions.current.get(key) ?? 0) + 1);
    const cleared = draftRevisions.current.get(key) ?? 0;
    setDraft(""); bindingsRef.current = none; setBindings(none); setPicker(null);
    // the composer keeps focus: the Send that was pressed turns into Stop (or the mic), and a focused button that goes away takes the
    // composer's focus with it without a blur, which would leave the phone's bottom bar hidden
    const pressed = document.activeElement;
    if (pressed instanceof HTMLElement && pressed !== input.current && pressed.closest(".composer")) input.current?.focus({ preventScroll: true });
    const toUni = !!uniHere && recipients.includes(uniHere.pubkey);
    setOutgoing({ key, body: snapshot, at: Date.now() / 1000, toUni });
    const sendView = currentView;
    anchorNext(sendView);
    setError(null);
    try {
      const sent = await invoke<Message | null>("post_message", { channel, body: snapshot, replyTo: target, recipients, media: files.map((f) => f.media!) });
      changePending(key, (items) => {
        for (const item of items) if (sentIds.includes(item.id) && item.preview) URL.revokeObjectURL(item.preview);
        return items.filter((item) => !sentIds.includes(item.id));
      });
      landed(key, sendView, snapshot, sent?.ref ?? null, toUni);
      if ((draftRevisions.current.get(key) ?? 0) === cleared) storeDraft(key, "", new Map());
      // Re-read through the room effect, which drops the result if the
      // user has switched rooms meanwhile.
      setTick((n) => n + 1);
      await loadRooms();
      setStatus(recipients.length ? `Message sent · notified ${recipients.length}` : "Message sent");
    } catch (e) {
      // the relay has it and only this device's copy failed: it was sent (putting the text back would invite a second one)
      if (relayAccepted(e)) {
        const ref = (e as { eventId: string }).eventId;
        changePending(key, (items) => {
          for (const item of items) if (sentIds.includes(item.id) && item.preview) URL.revokeObjectURL(item.preview);
          return items.filter((item) => !sentIds.includes(item.id));
        });
        landed(key, sendView, snapshot, ref, toUni);
        if ((draftRevisions.current.get(key) ?? 0) === cleared) storeDraft(key, "", new Map());
        setTick((n) => n + 1);
        return;
      }
      setError(String(e));
      setOutgoing(null);
      releaseAnchor(sendView);
      const now = drafts.current.get(key) ?? "";
      const back = (draftRevisions.current.get(key) ?? 0) === cleared || !now.trim() ? snapshot : `${snapshot}\n\n${now}`;
      const mentions: Bindings = new Map([...sentMentions, ...(bindingStore.current.get(key) ?? [])]);
      bindingStore.current.set(key, mentions);
      editDraft(key, back, mentions);
      if (activeScope.current === key) { setDraft(back); bindingsRef.current = mentions; setBindings(mentions); }
    }
    finally { sendingRef.current = false; setSending(false); }
  }

  /** T-335 chat feel: a message is posted: it is Uni's to pick up (the status line says so until its 👀), and it stays on screen until the
   *  room's list has it. */
  function landed(key: string, view: string | null, body: string, ref: string | null, toUni: boolean) {
    if (view) saidIn(view.split("|")[0]);
    if (ref && toUni) asked.current.set(ref, Date.now() / 1000);
    // only the hold of the view it was sent from (another room's send landing late never takes this one's)
    if (ref && anchor.current && !anchor.current.ref && anchor.current.view === view) anchor.current.ref = ref;
    setOutgoing((o) => o && o.key === key && o.body === body ? (ref ? { ...o, ref } : null) : o);
  }
  // the posted message is in the list now (or never comes, in a thread the list doesn't hold): the stand-in goes
  useEffect(() => {
    if (!outgoing?.ref) return;
    if (messages.some((m) => m.ref === outgoing.ref)) { setOutgoing(null); return; }
    const t = window.setTimeout(() => setOutgoing((o) => (o === outgoing ? null : o)), 6000);
    return () => clearTimeout(t);
  }, [outgoing, messages]);
  /** T-335 chat feel: posts words as you, with this room's Uni addressed: a quick reply, Stop ("/stop"), Try again ("/retry"), Continue. */
  async function postAs(body: string) {
    if (!channel || postingRef.current || sendingRef.current) return;
    const key = keyFor(channel, root), view = currentView;
    const uniHere = findUniMember(members);
    const command = commandOf(body);
    // the buttons' words always reach this room's Uni (a stop, a try again, a continue); a chip's answer as a typed message would
    const toUni = !!uniHere && (!!command || body === CONTINUE || notifyUni);
    postingRef.current = true; setPosting(true);
    const target = root ? (messages.some((m) => m.ref === root) ? root : messages[messages.length - 1]?.ref ?? null) : null;
    // a pressed button (Stop, a chip) that is about to go lets go of focus first, so the composer is known to be left
    const pressed = document.activeElement;
    if (pressed instanceof HTMLButtonElement) pressed.blur();
    setOutgoing({ key, body, at: Date.now() / 1000, toUni });
    if (command !== "stop") anchorNext(view);
    setError(null);
    try {
      const sent = await invoke<Message | null>("post_message", { channel, body, replyTo: target, recipients: toUni ? [uniHere!.pubkey] : [], media: [] });
      landed(key, view, body, sent?.ref ?? null, toUni && command !== "stop");
      setTick((n) => n + 1);
      void loadRooms().catch(() => {});
    } catch (e) {
      if (relayAccepted(e)) { landed(key, view, body, (e as { eventId: string }).eventId, toUni && command !== "stop"); setTick((n) => n + 1); return; }
      setOutgoing(null); setError(`Couldn't send: ${e}`);
      releaseAnchor(view);
    } finally { postingRef.current = false; setPosting(false); }
  }
  async function reactTo(m: Message, emoji: string) {
    const mine = m.reactions.find((r) => r.emoji === emoji && r.mine)?.mine ?? null;
    try {
      await invoke("react_message", { channel: m.channel, target: m.ref, emoji, ...(mine ? { mine } : {}) });
      setTick((n) => n + 1);
    } catch (e) { setError(`Couldn't react: ${e}`); }
  }
  /** T-335 chat feel: a message's words kept as a note in the vault, saying where they came from. */
  async function saveAsNote(m: Message) {
    const vault = activeProfile().vault;
    const d = new Date(m.ts * 1000), two = (n: number) => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}${two(d.getMinutes())}`;
    const words = m.body.replace(/[#*_`>|[\]()~]/g, " ").replace(/[\\/:?"<>]/g, " ").split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
    if (savedNotes.current.has(m.ref)) { setToast("Already saved as a note"); return; }
    const tag = m.ref.slice(-4);
    let path = `Saved from chat/${day} ${words || "message"} ${tag}`.trim();
    if (validateNotePath(path)) path = `Saved from chat/${day} message ${tag}`;
    const content = `${m.body}\n\n— ${m.author_name} in ${placeRef.current}, ${time(m.ts)}\n`;
    try {
      const note = await invoke<{ id: string; path: string } | null>("vault_create", { vault, path, content });
      invalidatePaths(vault);
      savedNotes.current.add(m.ref);
      setToast(`Saved as a note in “${(note?.path ?? path).split("/")[0]}”`);
    } catch (e) { setError(`Couldn't save the note: ${e}`); }
  }
  /** The messages saved as notes from this device this session (one note each). */
  const savedNotes = useRef(new Set<string>());
  /** The place the room is, as the person knows it (the area's name in an area's chat). */
  const placeRef = useRef("this room");

  async function forget() {
    // Two taps instead of window.confirm (unreliable in Android WebView).
    if (!forgetArmed) { setForgetArmed(true); return; }
    // T-132: from here no draft is saved (a send still on its way, or an identity arriving, would otherwise save one back after the wipe);
    // a failed Forget gives saving back
    draftsForgotten.current = true;
    try { voiceMounted.current = false; uploadAborts.current.forEach((upload) => upload.abort()); await voiceQueue.current; await voiceOutbox.current.clear(); await invoke("identity_forget");
      forgetDrafts(); forgetComposer(); invalidatePaths(); forgetAreas(); forgetDecisions(); forgetHeld(); forgetCalendar(); forgetMessages(); forgetWork(); forgetUsage();
      try { for (const key of Object.keys(localStorage)) if (key.startsWith("uni.noteDraft.v1:") || key.startsWith(CHAT_DRAFT_PREFIX) || key.startsWith("uni.vaultExpanded.v1:") || key === ALIASES_KEY || key === UNI_PLACE_KEY) localStorage.removeItem(key); } catch { /* unavailable storage */ }
      onForget(); } catch (e) { voiceMounted.current = true; draftsForgotten.current = false; setError(String(e)); }
  }

  const currentRoom = rooms.find((r) => r.id === channel);
  const isThread = !!root;
  const rootMessage = isThread ? messages.find((m) => m.ref === root) : undefined;
  const threadReplies = isThread ? messages.filter((m) => m.ref !== root) : [];

  // The room's message list and composer. The room view and an area's chat pane are this same markup, so one send path,
  // one draft per room and one signer serve both; `above` is drawn directly over the composer (the suggestion bar).
  const uniInRoom = !!findUniMember(members);
  // T-335 chat feel: the newest message, when it is someone else's question with plain answers, offers them as chips (not while you're sending)
  const newest = messages[messages.length - 1];
  const chips = viewShown && !isThread && newest && newest.author !== identity && !outgoing && !turn ? quickReplies(newest.body) : null;
  const sheetMsg = sheetFor ? messages.find((m) => m.ref === sheetFor) ?? null : null;
  const roomPane = (currentRoom: Room, above: ReactNode, placeholder?: string, place?: string) => {
    placeRef.current = place || currentRoom.name;
    const out = outgoing && outgoing.key === keyFor(currentRoom.id, root) && !messages.some((m) => m.ref === outgoing.ref) ? outgoing : null;
    const outCommand = out ? commandOf(out.body) : null;
    return <>
        <div className="message-list" ref={setList} role="log" aria-label="Messages" aria-live="polite">
          <div className="message-stack" ref={setStackEl}>
            <NoteOpener.Provider value={openFromChat}>{timeline}</NoteOpener.Provider>
            {out && (outCommand ? <p className="chat-note" data-outgoing="true">{outCommand === "stop" ? "Stopping Uni…" : "Asking Uni to try again…"}</p>
              : <article className="message mine outgoing" aria-busy={!out.ref} data-outgoing="true"><span className="message-avatar" aria-hidden="true" /><div className="message-content"><div className="message-meta"><time>{out.ref ? clock(out.at) : "Sending…"}</time></div><p className="outgoing-body">{out.body}</p>{out.toUni && <span className="msg-receipt">{out.ref ? "Sent" : "Sending"}</span>}</div></article>)}
            {turn ? <StatusLine phase={turn.phase} since={turn.since} ping={turnPing} place={placeRef.current} />
              : pingLine && <StatusLine phase="working" since={pingLine.ts} ping={pingLine.body} place={placeRef.current} theirs />}
            {chips && <QuickReplies answers={chips} onPick={(a) => void postAs(a)} />}
            <div ref={scrollEnd} />
            <div className="anchor-space" ref={spaceRef} aria-hidden="true" />
          </div>
        </div>
        {sheetMsg && <MessageSheet preview={sheetMsg.body.slice(0, 140)} reactions={sheetMsg.author !== identity} mine={sheetMsg.reactions.filter((r) => r.mine).map((r) => r.emoji)}
          rows={messageActions(sheetMsg, true)} onReact={(e) => void reactTo(sheetMsg, e)} onClose={closeSheet} />}
        <footer onFocusCapture={() => requestAnimationFrame(() => setComposerFocused(true))} onBlurCapture={(e) => { const composer = e.currentTarget; requestAnimationFrame(() => setComposerFocused(composer.contains(document.activeElement))); }} className="composer" onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={onDropFiles}>
          {/* a press doesn't take focus: focus in the composer hides the phone's bottom bar, which would move the button from under the tap */}
          {anchor.current && anchor.current.view === currentView && moreBelow && <button type="button" className="jump-latest more-below" onMouseDown={(e) => e.preventDefault()} onClick={toContentEnd} aria-label="More below">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" /></svg><span>More below</span>
          </button>}
          {away && !(anchor.current && anchor.current.view === currentView) && <button type="button" className={`jump-latest${newSince ? " has-new" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={jumpToLatest} aria-label={newSince ? `Jump to latest, ${newSince} new message${newSince === 1 ? "" : "s"}` : "Jump to latest"}>
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
          <div className={`compose-row${draftBlank && !pending.length ? " empty" : ""}`}>
            <ComposerMenu key={`${channel}:${root}`} onMention={startMention} onAttach={() => fileInput.current?.click()} onDiscard={discardDraft} canDiscard={hasDraft} sending={sending} />
            <ComposerField box={box} inputRef={composerInput} aria-label={`Message ${currentRoom.name}`} onChange={(e) => updateDraft(e.target.value, e.target.selectionStart)} onPaste={onPasteFiles} onSelect={(e) => syncPicker(e.currentTarget.value, e.currentTarget.selectionStart)} onBlur={() => setPicker(null)} onKeyDown={onKeyDown} maxLength={65536} rows={1} placeholder={isThread ? "Reply in thread…" : placeholder ?? "Message Uni…"} />
            {/* Uni hears every message in a room it is in, unless muted here: a small, visible switch (it was hidden with the old destination line) */}
            {uniInRoom && <button type="button" className={`compose-uni ${notifyUni ? "on" : ""}`} aria-pressed={notifyUni} onClick={() => setNotifyUni((v) => !v)}
              aria-label={notifyUni ? "Uni is listening. Mute Uni for your messages" : "Uni is muted. Let Uni listen again"} title={notifyUni ? "Uni hears what you send here. Tap to mute." : "Uni is muted: your messages don't notify Uni. Tap to let Uni listen."}>{notifyUni ? "Uni listening" : "Uni muted"}</button>}
            <button className={`address-toggle compose-icon mic ${recorder.recording && recordingOrigin.current?.key === scope() ? "recording" : ""}`} onClick={() => void toggleRecording()} disabled={sending || (recorder.busy && (!recorder.recording || recordingOrigin.current?.key !== scope()))} aria-pressed={recorder.recording && recordingOrigin.current?.key === scope()} aria-label={recorder.recording && recordingOrigin.current?.key === scope() ? "Stop recording voice message" : "Record a voice message"} title={recorder.recording && recordingOrigin.current?.key === scope() ? "Stop recording" : "Voice message"}>
              {recorder.recording && recordingOrigin.current?.key === scope() ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" fill="currentColor" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>}
            </button>
            {/* T-335 chat feel: while Uni works and the field is empty, Send is Stop, in the same place; typing gives Send back (a word to Uni meanwhile) */}
            {turn && uniInRoom && draftBlank && !pending.length ? <button className="send compose-icon stop" onClick={() => void postAs(STOP)} aria-label="Stop Uni" title="Stop Uni"
              disabled={posting || turn.phase === "sending" || (!!outgoing && commandOf(outgoing.body) === "stop")}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" /></svg>
            </button>
            : <button className="send compose-icon" disabled={(draftBlank && !pending.some((f) => !f.voice && f.state === "ready")) || manualAttachments(pending).some(attachmentBlocksSend) || sending || recorder.busy} onClick={() => void send()} aria-label="Send message" title={sending ? "Sending…" : "Send message"} aria-busy={sending}>
              {sending ? <span aria-hidden="true">…</span> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7 7 7M12 5v14" /></svg>}
            </button>}
          </div>
          <p className="compose-hint">Enter to send · Shift+Enter for a new line · @ to mention</p>
        </footer>
  </>; };
  /** T-335 chat feel: "More below" goes to the end of what is there, and the view follows the newest again. */
  function toContentEnd() {
    const list = listRef.current;
    anchor.current = null;
    setMoreBelow(false);
    if (spaceRef.current) spaceRef.current.style.height = "0px";
    if (!list) return;
    stickToEnd.current = true;
    jumpUntil.current = Date.now() + 2000;
    easeScroll(list, list.scrollHeight, 220, calmMotion());
  }
  /** Your own message whose Delete in the sheet was tapped once: the sheet opens again asking for the second tap. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const closeSheet = useCallback(() => { setSheetFor(null); setConfirmDelete(null); }, []);
  useEffect(() => { if (!sheetFor) setConfirmDelete(null); }, [sheetFor]);
  rowMaker.current = (m) => ({ actions: messageActions(m, false),
    tail: m.author === identity ? <DeleteButton key={`del-${m.ref}`} label="your message" onDelete={() => actions.current.deleteOwn(m)} /> : undefined });
  useLongPress(listEl, (ref) => { if (messages.some((m) => m.ref === ref)) setSheetFor(ref); });
  /** A message's actions. Someone else's: Copy, Try again (the latest reply, where Uni is), 👍, Reply, Save as note; your own: Copy, Edit.
   *  In the sheet also Select text (and Delete for your own). */
  function messageActions(m: Message, inSheet: boolean): Action[] {
    const mine = m.author === identity;
    const copy: Action = { id: "copy", label: "Copy", icon: ICONS.copy, run: () => void copyText(m.body, "Copied text") };
    const select: Action = { id: "select", label: "Select text", icon: ICONS.select, run: () => requestAnimationFrame(() => {
      const el = listRef.current?.querySelector(`[data-ref="${CSS.escape(m.ref)}"] .md`);
      if (el) window.getSelection()?.selectAllChildren(el);
    }) };
    if (mine) return [copy, ...(editing !== m.ref ? [{ id: "edit", label: "Edit", icon: ICONS.edit, run: () => setEditing(m.ref) }] : []), ...(inSheet ? [select,
      // the sheet asks before it deletes: a second sheet, opened again, would be a second tap away; here the row confirms in place
      { id: "delete", label: confirmDelete === m.ref ? "Tap again to delete" : "Delete", aria: confirmDelete === m.ref ? "Tap again to delete your message" : "Delete your message", icon: ICONS.del,
        run: () => { if (confirmDelete === m.ref) { setConfirmDelete(null); void actions.current.deleteOwn(m); } else { setConfirmDelete(m.ref); setSheetFor(m.ref); } } }] : [])];
    const up = m.reactions.find((r) => r.emoji === "👍");
    const uniPk = findUniMember(members)?.pubkey;
    const byPerson = m.author !== uniPk && members.some((x) => x.pubkey === m.author);
    const latest = m.ref === latestReply && uniInRoom && !isThread && !byPerson;
    return [
      ...(inSheet ? [] : [copy]),
      ...(latest ? [{ id: "retry", label: "Try again", aria: "Ask Uni to try again", icon: ICONS.retry, run: () => void postAs(RETRY) }] : []),
      ...(inSheet ? [] : [{ id: "up", label: "👍", aria: "Thumbs up", icon: null, pressed: !!up?.mine, run: () => void reactTo(m, "👍") }]),
      { id: "reply", label: "Reply", icon: ICONS.reply, run: () => openThread(m) },
      ...(inSheet ? [copy] : []),
      { id: "save", label: "Save as note", icon: ICONS.save, run: () => void saveAsNote(m) },
      ...(inSheet ? [select] : []),
    ];
  }
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
    saidIn(room);
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
    // T-234: Uni's approval card; Rust checks who signed it and everything in it, and the card draws only from that
    if (sealedFence(m.body)) return <><Body body={sealedProse(m.body)} mentions={m.mentions} me={identity} edited={m.edited} />
      <SealedCard channel={m.channel} reference={m.ref} /></>;
    if (!secretCards) return null;
    if (parseSecretRequest(m.body)) return <><Body body={withoutSecretBlock(m.body).split("\n")[0]} mentions={m.mentions} me={identity} edited={m.edited} />
      <SecretRequestCard channel={m.channel} requestRef={m.ref} authorName={m.author_name} receipts={(author, rid) => receiptFor(secretReceipts, author, rid)}
        pins={secretRequesters} onTrust={() => void trustRequester(m.channel, m.ref)} /></>;
    return parseSecretReceipt(m.body) ? <Body body={withoutSecretBlock(m.body)} mentions={m.mentions} me={identity} edited={m.edited} /> : null;
  };

  const waitingRefs = new Set(approvals.map((a) => a.ref));
  const waitingKey = approvals.map((a) => a.ref).join(" ");
  /**
   * T-335: a Hermes approval prompt drawn as its short card. Its state comes from the same store read as Needs you (every room and thread),
   * never from the loaded timeline alone (a room's list has no thread replies). An outcome once read stands. Older than that read: no
   * longer waiting, outcome unknown (Needs you doesn't list it either). Before the store has answered, or when its last read failed (an
   * answer may have come since the list was read): unknown, never drawn as waiting. Null: not a prompt.
   */
  const promptView = (m: Message) => {
    const a = m.author === identity ? null : parseApproval(m);
    if (!a) return null;
    const ended = promptsEnded?.get(m.ref);
    if (ended) return <ApprovalPromptCard a={a} state={ended} />;
    const now = Date.now() / 1000;
    // its own window is over, or it is older than the store's read: not waiting, however it ended
    if (m.ts <= now - APPROVAL_WINDOW_S || (a.deadline !== null && a.deadline <= now)) return <ApprovalPromptCard a={a} state="past" />;
    if (promptsFailed) return <ApprovalPromptCard a={a} state="unchecked" />;
    if (waitingRefs.has(m.ref)) return <ApprovalPromptCard a={a} state="waiting" />;
    // not in the store's last read: one that has just come is read again within a moment; one a minute old that still isn't, the read
    // doesn't reach (a room past its newest 1000), so its state is unknown
    return <ApprovalPromptCard a={a} state={promptsEnded && m.ts < now - 60 ? "unchecked" : "checking"} />;
  };
  const endedKey = `${promptsEnded ? [...promptsEnded].map(([k, v]) => `${k}${v.outcome}`).join(" ") : "-"}${promptsFailed ? "!" : ""}`;
  // T-335 chat feel: what a room's list holds besides its messages. Pings feed the status line and fold into the reply's one-line receipt,
  // never a message of their own (a stale one with no reply after it stays folded as an earlier update); the gateway's "⚡ Stopped" after
  // your stop is said by the Stopped row; the newest reply from someone else has its actions always shown.
  const feel = useMemo(() => {
    const hidden = new Set<string>(), receipts = new Map<string, Receipt>();
    // each message's previous one that isn't a ping, in one pass forward
    const prevTalk: (Message | undefined)[] = [];
    let last: Message | undefined;
    for (const m of messages) { prevTalk.push(last); if (!isWorkerStatus(m.body)) last = m; }
    let answered = false, latest: string | null = null, lastStop: string | null = null, spokeSince = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (isWorkerStatus(m.body)) { if (answered || !staleStatus(m, Date.now() / 1000, i === messages.length - 1)) hidden.add(m.ref); continue; }
      const prev = prevTalk[i];
      const stopReply = m.author !== identity && isStopReply(m.body) && !!prev && prev.author === identity && commandOf(prev.body) === "stop";
      // the newest stop, while nothing has been said since (the gateway's own "Stopped" aside), offers Continue
      if (lastStop === null && !spokeSince && m.author === identity && commandOf(m.body) === "stop") lastStop = m.ref;
      if (!stopReply) spokeSince = true;
      if (m.author !== identity) {
        answered = true;
        if (stopReply) { hidden.add(m.ref); continue; }
        if (!latest && !isMaintenance(m.body)) latest = m.ref;
        const r = workReceipt(messages, i, identity);
        if (r) receipts.set(m.ref, r);
      } else answered = false;
    }
    return { hidden, receipts, latest, lastStop };
  }, [messages, identity]);
  const latestReply = feel.latest;
  // what the view held when its first read came in; anything newer arrived live, and settles in
  if (currentView && fetchedView === currentView && known.current.view !== currentView) {
    known.current = { view: currentView, refs: new Set(messages.map((m) => m.ref)), ts: messages.reduce((t, m) => Math.max(t, m.ts), 0), arrived: new Set() };
  }
  const shownReactions = (m: Message) => m.author !== identity ? m.reactions : m.reactions.filter((r) => r.mine || !/^👀️?$/u.test(r.emoji));
  const renderMessage = (m: Message, inThread: boolean, prev?: Message, newest = false) => {
    if (!inThread && feel.hidden.has(m.ref)) return null;
    const command = m.author === identity && !(inThread && m.ref === root) ? commandOf(m.body) : null;
    if (command === "stop") return <p key={m.ref} data-ref={m.ref} className="chat-note uni-stopped">You stopped Uni.{feel.lastStop === m.ref
      && <button type="button" className="chat-note-go" onClick={() => actions.current.postAs(CONTINUE)}>Continue</button>}</p>;
    if (command === "retry") return <p key={m.ref} data-ref={m.ref} className="chat-note uni-retried">You asked Uni to try again.</p>;
    // r18: a progress ping from hours or days ago is folded away as a past update, never the room's live status
    if (isWorkerStatus(m.body) && !(inThread && m.ref === root) && editing !== m.ref && staleStatus(m, Date.now() / 1000, newest)) return <details key={m.ref} data-ref={m.ref} className="message status-line status-past">
      <summary><span className="status-line-text">Earlier progress update</span><time>{time(m.ts)}</time></summary><p className="status-past-body">{m.body}</p></details>;
    // r19: Uni's upkeep notes (self-improvement reviews, the usage guard, cron jobs) are folded away, never a bubble in the conversation
    if (isMaintenance(m.body) && !(inThread && m.ref === root) && editing !== m.ref) return <details key={m.ref} data-ref={m.ref} className="message status-line status-past status-upkeep">
      <summary><span className="status-line-text">{UPKEEP_LABEL}</span><time>{clock(m.ts)}</time></summary><p className="status-past-body">{m.body}</p></details>;
    if (isWorkerStatus(m.body) && !(inThread && m.ref === root) && editing !== m.ref) return <article key={m.ref} data-ref={m.ref} className="message status-line" title={m.body}><span className="status-line-text">{m.body}</span><time>{clock(m.ts)}</time></article>;
    const grouped = !!prev && prev.author === m.author && m.ts - prev.ts < 300 && !(inThread && prev.ref === root);
    const k = known.current;
    if (k.view === currentView && !k.refs.has(m.ref) && m.ts >= k.ts && m.author !== identity) k.arrived.add(m.ref);
    const receipt = inThread ? null : feel.receipts.get(m.ref);
    return <article key={m.ref} data-ref={m.ref} className={`message ${k.arrived.has(m.ref) ? "arrived" : ""} ${m.ref === focusRef ? "search-focus" : ""} ${grouped ? "grouped" : ""} ${m.author === identity ? "mine" : ""} ${m.mentions_me ? "highlight" : ""} ${inThread && m.ref === root ? "thread-root" : ""} ${waitingRefs.has(m.ref) ? "approval-waiting" : ""}`}>
      {grouped ? <time className="gutter-time">{clock(m.ts)}</time> : <span className="message-avatar" style={{ background: `hsl(${150 + (hue(m.author) % 120) - 60} 22% 44%)` }} aria-hidden="true">{m.author_name[0]?.toUpperCase() ?? "?"}</span>}
      <div className="message-content">{!grouped && <div className="message-meta"><strong>{m.author_name}</strong><time>{clock(m.ts)}</time></div>}
        {receipt && <details className="work-receipt"><summary>{receiptLine(receipt)}</summary>{receipt.steps.length > 0 && <ul>{receipt.steps.map((s) => <li key={s}>{s[0].toUpperCase() + s.slice(1)}</li>)}</ul>}</details>}
        {editing === m.ref ? <InlineEditor key={m.ref} initial={m.body} onSave={(body) => actions.current.saveEdit(m, body)} onCancel={() => actions.current.cancelEdit()} /> : promptView(m) ?? secretView(m) ?? <Body body={attachmentBody(m.body, m.media, relayOrigin)} mentions={m.mentions} me={identity} edited={m.edited} />}
        <Attachments body={m.body} media={m.media} />
        {decisionCards(m, inThread)}
        {/* T-335 chat feel: Uni's 👀 on your message is said by the status line and the work receipt, not as a pill */}
        {shownReactions(m).length > 0 && <div className="reactions" aria-label="Reactions">{shownReactions(m).map((r) => <span key={r.emoji} className={`pill ${r.mine ? "mine" : ""}`} aria-label={`${emojiLabel(r.emoji)} ${r.count}${r.mine ? ", including yours" : ""}`}>{emojiLabel(r.emoji)} <span>{r.count}</span></span>)}</div>}
        {!inThread && m.reply_count > 0 && <button className="thread-summary" onClick={() => actions.current.openThread(m)} aria-label={`View thread with ${m.reply_count} ${m.reply_count === 1 ? "reply" : "replies"}`}>💬 {m.reply_count} {m.reply_count === 1 ? "reply" : "replies"}{m.last_reply_ts ? <span> · last {time(m.last_reply_ts)}</span> : null}</button>}
        {m.ref === sentRef && <span className="msg-receipt">Sent</span>}
        {/* T-335 chat feel: a quiet row instead of a ⋯ on every message: always shown on the latest reply, on hover or focus elsewhere; a
            long press opens the sheet on touch */}
        {editing !== m.ref && <MessageActions m={m} make={rowMaker} always={!inThread && m.ref === latestReply}
          retry={!inThread && m.ref === latestReply && uniInRoom} editable={m.author === identity} />}
      </div>
    </article>;
  };

  // Day dividers + author grouping for a chronological list.
  const renderList = (list: Message[], inThread: boolean) => list.flatMap((m, i) => {
    const prev = list[i - 1];
    const sameDay = !!prev && dayKey(prev.ts) === dayKey(m.ts);
    const out: React.ReactNode[] = [];
    if (!sameDay) out.push(<div key={`d-${m.ref}`} className="day-divider" role="separator"><span>{dayLabel(m.ts)}</span></div>);
    if (!inThread && newLine && newLine.view === currentView && newLine.ref === m.ref) out.push(<div key={`new-${m.ref}`} className="new-line" role="separator"><span>New · since {clock(newLine.ts)}</span></div>);
    out.push(renderMessage(m, inThread, sameDay ? prev : undefined, i === list.length - 1));
    return out;
  });

  actions.current = {
    openThread,
    loadOlder: () => void loadOlder(),
    saveEdit,
    cancelEdit: () => { setEditing(null); input.current?.focus(); },
    deleteOwn,
    postAs: (body) => void postAs(body),
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
  [messages, identity, decisions.version, root, older, roomName, editing, focusRef, relayOrigin, fetchedView, failedView, currentView, busy, synced, secretRequesters, secretReceipts, waitingKey, endedKey, feel, sentRef, newLine, uniInRoom]);

  const topNote = notes[notes.length - 1];
  // A top-level note Back closes its tab and returns to the last used tab.
  const backTo = activeTab(tabs)?.kind === "note" && tabs.active ? nextAfterClose(tabs, tabs.active)?.title ?? "Conversations"
    : journalOpen ? "Journal" : currentRoom ? (isThread ? `Thread in ${currentRoom.name}` : currentRoom.name) : searchOpen ? "Search" : "Conversations";

  // Android back gesture/button: step back through the app (note stack,
  // search, thread, Journal, room) before leaving it. The listener is only
  // registered while there is somewhere to go back to, so at the room list
  // the system default runs (the app goes to the background, as usual).
  // T-302 (0.2: the home is All; a vault without the Uni glue has the places page and its tree); asking for the home
  // closes that level wherever it is open.
  // 0.2 one home: with the Uni glue (rooms and areas in the uni vault) the home is All's stream, its places folded under its head
  /** At the home: Uni's places page, or (0.2, with the Uni glue) All with no room in focus. The system's own Back runs there. */
  const atHome = (t: TabTarget | null | undefined) => !!t && (t.kind === "areas" ? !t.path : t.kind === "all" && homeIsAll && !allFocusRef.current);
  const uniHome = (): TabTarget => { setRootOpenMemory(false); return homeIsAll ? { kind: "all", title: "Uni" } : { kind: "areas", title: "Uni" }; };
  /** r22 (Codex 2): the last Uni or area opened, which a room's own Back (a phone's) goes up to. Kept for this session only. */
  const originRef = useRef<TabTarget | null>(null);
  /** T-294: the place on Uni's side a utility was opened from (Uni, an area, a room, a thread; kept on the device): the Back of the Journal, the
   *  Vault, Mail, Calendar and Messages, and the rail's Uni, return there, not always to Uni. */
  const origin = (): TabTarget => uniPlace.current ?? uniHome();
  const asideRoom = channel && chatOnScreen(activeTab(tabs), channel, notes.length) && listEl?.isConnected && asides[channel] ? channel : null;
  const asideShown = !!asideRoom;
  const goBack = useRef<() => void>(() => {});
  goBack.current = () => {
    if (railMore) { setRailMore(false); return; }
    // T-258: a full-window layer (video full screen, image viewer) closes first, as Escape closes it.
    if (modalCount() > 0) { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return; }
    if (journalFocus) { setJournalFocus(false); return; }
    if (sheetFor) { setSheetFor(null); return; }
    if (panel) { setPanel(null); return; }
    if (searchOpen) { setSearchOpen(false); return; }
    if (overlayRef.current && !notes.length) { overlayRef.current.close(); return; }
    if (notes.length) { closeNote(); return; }
    if (asideRoom) { backAside(asideRoom); return; }
    if (allFocusRef.current) { stepBackInFocus(); return; }
    // A level goes up, a room on a phone goes back to the room tree (Uni's own level, opened from the tree, too); anything else goes to Uni.
    if (areaBack.current) { areaBack.current(); return; }
    const cur = activeTab(tabsRef.current);
    // 0.2 one home: All with nothing in focus is the home, as Uni's places page was
    if (atHome(cur)) return;
    openTarget(cur && isUniSide(cur) ? originRef.current ?? uniHome() : origin(), "replace");
  };
  // At Uni's room tree (nothing open over it) the system's own Back runs: the app goes to the background.
  const [modalOpen, setModalOpenState] = useState(false);
  useEffect(() => { const on = (e: Event) => setModalOpenState(((e as CustomEvent<number>).detail ?? 0) > 0); window.addEventListener("uni-modal", on); return () => window.removeEventListener("uni-modal", on); }, []);
  const canGoBack = railMore || modalOpen || !!sheetFor || !!panel || journalFocus || notes.length > 0 || asideShown || searchOpen || !!root || hasAreaBack || !!allFocus || (!!activeTab(tabs) && !atHome(activeTab(tabs)));
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
      // T-335 glow-up: Ctrl/Cmd+K opens Find from anywhere (on its last query). On a Mac, Ctrl+K in a text field is the field's own (delete
      // to the end of the line), so there it is Cmd+K only; and an open dialog (a task or companion sheet) keeps the keyboard.
      if (e.key.toLowerCase() === "k" && !e.altKey && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
        const mac = /mac|iphone|ipad/i.test(navigator.platform);
        if (mac && !e.metaKey) return;
        const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].find((d) => !d.querySelector(".search-view"));
        if (dialog) return;
        e.preventDefault(); openFindRef.current(); return;
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
  useEffect(() => { setRailMore(false); }, [active?.id]);
  // 0.2 one home: a restored Uni places page (an older version's save) is the home, All
  useLayoutEffect(() => { if (homeIsAll && tabsReady.current && oldHome(active)) openTarget(uniHome(), "replace"); }, [homeIsAll, active?.id, active?.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (active && (active.kind === "areas" || active.kind === "area")) { const { id: _id, ...t } = active; originRef.current = t; } }, [active]);
  const journalTab = tabs.tabs.find((t) => t.kind === "journal");
  const areasOpen = active?.kind === "areas" || active?.kind === "area";
  /** T-335 one surface: every room opens in focus over All; Uni's home (and a vault without rooms, its areas' work) is the other side of it. */
  // 0.2 one home: Uni's places page, before the saved place is restored (or while a step back to it is turned into All), is drawn as the home
  const oldHome = (t: TabTarget | null | undefined) => !!t && t.kind === "areas" && !t.path;
  const allOpen = active?.kind === "all" || (homeIsAll && oldHome(active));
  const shellOpen = areasOpen || allOpen;
  // another place opened: the focus ended with All (whoever opened it has already moved the room's view on)
  useLayoutEffect(() => { if (!allOpen && allFocusRef.current) { stopLeaving(); setAllFocus(null, true); } }, [allOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  // Escape: what is in front goes first, as Back; a field's own use of it (the mention list, an edit) comes before that
  const inFocus = !!allFocus;
  useEffect(() => {
    if (!inFocus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !e.isTrusted || modalCount() > 0) return;
      if (e.target instanceof Element && e.target.closest(".inline-editor, [role=dialog], [role=alertdialog]")) return;
      goBack.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inFocus]);
  const uniShown = !panel && !searchOpen && !topNote && shellOpen && !allOpen;
  const shellPath = active?.kind === "area" ? active.path ?? null : null;
  // Drafts only: the scope's draft is read when the room opens. Aaron presses Send.
  const composeInRoom = (id: string, text: string) => {
    const key = keyFor(id, null);
    editDraft(key, appendDraft(scopeDraft(key), text));
    focusComposer.current = true;
    openRoomRef.current(id, { keys: true });
  };
  const composeInRoomRef = useRef(composeInRoom);
  composeInRoomRef.current = composeInRoom;
  // The open area's room: the active area tab carries its channel, so the room state above (messages, draft, send)
  // is already loaded for it. Text for its composer goes straight in (after any draft; never sends).
  const composeHere = (text: string) => {
    const key = scope();
    if (!key) return;
    const next = appendDraft(drafts.current.get(key) ?? box.get(), text);
    editDraft(key, next);
    setDraft(next);
    requestAnimationFrame(() => input.current?.focus());
  };
  /** The loaded room (or one of its threads, by root) as the shell's chat; null while another is loaded. */
  const areaRoomFor = (id: string | null | undefined, threadRoot: string | null = null) => {
    const room = id && channel === id && (root ?? null) === threadRoot ? currentRoom : undefined;
    if (!id || !room) return null;
    return { id, messages, loaded: loadedView === `${id}|${threadRoot}`, me: identity, render: (above: ReactNode, placeholder?: string, place?: string) => roomPane(room, above, placeholder, place), compose: composeHere };
  };
  const setFocusViewRef = useRef(setFocusView);
  setFocusViewRef.current = setFocusView;
  const areaActions = useMemo(() => ({
    /** `focus`: a message of that room to scroll to and mark (the request sheet's "Check in #room first" goes to the first message about it) */
    openRoom: (id: string, focus?: string | null, checking?: string | null, place?: { path?: string | null; view?: FocusView }) => openRoomRef.current(id, { ref: focus ?? null, checking: checking ?? null, path: place ? place.path ?? null : undefined, view: place?.view }),
    /** T-335 one surface: inside the focus, the conversation, the room's details, its work or its app */
    focusView: (view: FocusView) => setFocusViewRef.current(view),
    // r15: a note opens in the vault its reference names (the task's, the area's), the same vault its title was read from
    openNote: (r: NoteRef) => openNote({ hub: null, vault: r.vault, ref: r.id }, null),
    compose: (id: string, text: string) => composeInRoomRef.current(id, text),
    retryRooms: () => { void loadRooms().catch(() => {}); },
    focusMessage: (ref: string | null, room?: string, checking?: string | null) => { if (ref) { focusTries.current = 0; setFocusRef(ref); } if (room) setChecking(checking ? { channel: room, text: checking } : null); },
    composerFocus: (on: boolean) => setComposerFocused(on),
    openPosts: (node?: string | null) => openTargetRef.current({ kind: "posts", title: "To post", ...(node ? { path: node } : {}) }, "new"),
  }), [openNote, loadRooms]);
  /** T-161: an approval prompt opens its room at the prompt with the composer focused; the user answers there (nothing is sent for them) */
  const openApproval = (a: Approval) => {
    // a Hermes prompt is answered in the composer; Uni's approval card (T-234) on the card itself
    const typed = a.kind !== "sealed";
    if (allFocusRef.current && channelRef.current === a.channel && root === a.root) { setFocusView("chat"); focusTries.current = 0; setFocusRef(a.ref); if (typed) requestAnimationFrame(() => input.current?.focus()); return; }
    focusComposer.current = typed;
    // a prompt posted as a reply is in its thread, never the room's timeline: it opens there, as a search hit does
    openRoom(a.channel, { ref: a.ref, root: a.root ?? null, keys: typed, path: null });
  };
  const approvalsView = { list: approvals, open: openApproval, roomName: (id: string) => rooms.find((r) => r.id === id)?.name ?? null };
  const primaryVault = vaults.includes(lifeVault) ? lifeVault : vaults.includes("uni") ? "uni" : vaults.length === 1 ? vaults[0] : null;
  const otherVaults = vaults.filter((vault) => vault !== primaryVault);
  const activeOtherVault = active?.kind === "vault" && active.vault && active.vault !== primaryVault && otherVaults.includes(active.vault) ? active.vault : null;
  function toggleOtherVaults() {
    const next = !otherVaultsExpanded;
    setOtherVaultsExpanded(next);
    try { localStorage.setItem(OTHER_VAULTS_KEY, String(next)); } catch { /* Storage may be unavailable. */ }
  }
  /** One vault: nothing to choose, straight in (and it still looks for new ones). More than one: the panel; from the rail, a second tap closes it. */
  function openVaultPlace(toggle: boolean) {
    setSearchOpen(false);
    if (vaults.length === 1) { setPanel(null); setVaultRefresh((n) => n + 1); openTarget({ kind: "vault", vault: vaults[0], title: vaults[0] }, "new"); return; }
    setPanel(toggle && panel === "vault" ? null : "vault");
  }
  const vaultRow = (vault: string) => <button key={vault} className={`room ${active?.kind === "vault" && active.vault === vault ? "selected" : ""}`} aria-label={vault}
    aria-current={active?.kind === "vault" && active.vault === vault ? "page" : undefined}
    onClick={() => openTarget({ kind: "vault", vault, title: vault }, "new")}><span className="avatar" aria-hidden="true">▤</span><span className="room-text"><strong>{vault}</strong></span></button>;
  /** A place's identity: a room a node owns is that node (Uni's room, opened before the tree loaded, is Uni). */
  const placeOf = (t: TabTarget): string => placeKey(t);
  /** T-335 glow-up: Find opens on the last query (the rail, the Places row, Ctrl/Cmd+K) */
  function openFind() { setPanel(null); setSearchQuery(lastSearch.current); setSearchScope({ vault: "", prefix: "" }); setSearchOpen(true); }
  openFindRef.current = openFind;
  const navControls: NavControls = {
    canBack: histCanBack(hist) || notes.length > 0 || hasOverlay || asideShown, canForward: histCanForward(hist) || (!!channel && !!listEl?.isConnected && !!asideAhead.current.get(channel)?.length && chatOnScreen(active ?? null, channel, notes.length)),
    places: [
      { label: "Journal", go: () => openTarget({ kind: "journal", title: "Journal" }) },
      { label: "Mail", go: () => openTarget({ kind: "mail", title: "Mail" }) },
      ...(calOn ? [{ label: "Calendar", go: () => openTarget({ kind: "calendar", title: "Calendar" }) }] : []),
      ...(msgsOn ? [{ label: "Messages", go: () => openTarget({ kind: "messages", title: "Messages" }) }] : []),
      ...(showUniGlue(lifeVault) ? [{ label: "To post", go: () => openTarget({ kind: "posts", title: "To post" }) }, { label: "Arcade", go: () => openTarget({ kind: "arcade", title: "Arcade" }) }] : []),
      { label: "Vault", go: () => openVaultPlace(false) },
      { label: "Search", go: openFind },
      { label: "Settings", go: () => { setSearchOpen(false); setPanel("settings"); setForgetArmed(false); } },
    ],
    back: () => goHistory(-1), forward: () => goHistory(1), backPlace: () => goHistory(-1, true),
    recent: histRecent(hist, RECENT_SHOWN, placeOf).filter((t) => !active || placeOf(t) !== placeOf(active)).map((t) => ({ key: placeOf(t), title: t.title, path: t.kind === "area" ? t.path ?? null : null, room: t.kind === "all" ? t.channel ?? null : null, go: () => openTarget(t, "focus") })),
  };
  /** The open utility panel's own name (r14): its frame says where you are. */
  const panelTitle = searchOpen ? "Search" : panel === "settings" ? "Settings" : panel === "vault" ? "Vault" : "Rooms";
  const recordingTab = recordingOrigin.current;
  const pill = recordingTab && recorder.busy ? { title: recordingTab.title, tabId: recordingTab.tabId, controls: recorder as RecorderControls, finish: "send" as const } :
    journalRecording && journalTab ? { title: "Journal", tabId: journalTab.id, controls: journalRecording.controls, finish: "save" as const } : null;
  return <ApprovalsContext.Provider value={approvalsView}><NavContext.Provider value={navControls}><NoteOpener.Provider value={openNote}><main className={`shell ${(!sidebarVisible && (channel || journalOpen || shellOpen || (active?.kind === "note" || active?.kind === "vault" || active?.kind === "mail" || active?.kind === "calendar" || active?.kind === "messages" || active?.kind === "posts" || active?.kind === "arcade"))) ? "in-room" : ""} ${topNote ? "note-open" : ""} ${panel ? `panel-open panel-${panel}` : ""} ${searchOpen ? "search-open" : ""} ${composerFocused ? "composer-focused" : ""} ${journalFocus && journalOpen ? "journal-focus" : ""} ${railHidden ? "rail-off" : ""} ${asideShown ? `note-aside note-aside-${paneShape}` : ""}`}>
    <nav ref={railRef} className="rail" aria-label="Main navigation" onClickCapture={(e) => { if (!(e.target as HTMLElement).closest(".rail-more")) setRailMore(false); }}>
      {/* 0.2 one home: Uni is the home, All's stream with its places under the head; a room is in focus over it. From Mail, the Journal or
          another place it goes back to where you were on Uni's side (the room you left, kept on the device), as their old "← Uni" did */}
      <button aria-label="Uni" aria-current={uniShown || (!panel && !searchOpen && !topNote && allOpen) ? "page" : undefined} onClick={() => openTarget(active && !isUniSide(active) && active.kind !== "note" && !panel && !searchOpen ? origin() : uniHome())}><i><UniIcon /></i><span>Uni</span></button>
      <button aria-label="Journal" aria-current={!panel && !searchOpen && (journalOpen && !topNote ? "page" : undefined)} onClick={() => openTarget({ kind: "journal", title: "Journal" })}><i><JournalIcon /></i><span>Journal</span></button>
      <button aria-label="Mail" aria-current={!panel && !searchOpen && (active?.kind === "mail" && !topNote ? "page" : undefined)} onClick={() => openTarget({ kind: "mail", title: "Mail" })} aria-describedby={[held > 0 && "rail-mail-held", unreadMail > 0 && "rail-mail-unread"].filter(Boolean).join(" ") || undefined}><i><MailIcon />{held > 0 && <span className="rail-count" aria-hidden="true">{held}</span>}{unreadMail > 0 && <span className="rail-dot" aria-hidden="true" />}</i><span>Mail</span>{held > 0 && <span id="rail-mail-held" hidden>{held} waiting for you</span>}{unreadMail > 0 && <span id="rail-mail-unread" hidden>{unreadMail} unread in your Inbox</span>}</button>
      {/* T-335 as Aaron: on a phone the bar is four places and More; the rest open from a sheet above it. On a wider screen More is hidden and the rest sit on the rail (display: contents) */}
      <button className="rail-more" aria-label="More" aria-expanded={railMore} aria-controls="rail-extras" aria-current={!railMore && (panel || searchOpen || active?.kind === "calendar" || active?.kind === "messages" || active?.kind === "posts" || active?.kind === "arcade" || active?.kind === "vault" || !!topNote) ? "page" : undefined} onClick={() => { setPanel(null); setSearchOpen(false); setRailMore((o) => !o); }}><i><MoreIcon /></i><span>More</span></button>
      <div id="rail-extras" className={`rail-extras${railMore ? " open" : ""}`}>
      {calOn && <button aria-label="Calendar" aria-current={!panel && !searchOpen && (active?.kind === "calendar" && !topNote ? "page" : undefined)} onClick={() => openTarget({ kind: "calendar", title: "Calendar" })}><i><CalendarIcon /></i><span>Calendar</span></button>}
      {msgsOn && <button aria-label="Messages" aria-current={!panel && !searchOpen && (active?.kind === "messages" && !topNote ? "page" : undefined)} onClick={() => openTarget({ kind: "messages", title: "Messages" })}><i><MessagesIcon /></i><span>Messages</span></button>}
      {showUniGlue(lifeVault) && <button aria-label="To post" aria-current={!panel && !searchOpen && (active?.kind === "posts" && !topNote ? "page" : undefined)} onClick={() => openTarget({ kind: "posts", title: "To post" })}><i aria-hidden="true"><ToPostIcon /></i><span>To post</span></button>}
      {/* T-335 Taste Arcade: small games that teach Uni your taste */}
      {showUniGlue(lifeVault) && <button aria-label="Arcade" aria-current={!panel && !searchOpen && (active?.kind === "arcade" && !topNote ? "page" : undefined)} onClick={() => openTarget({ kind: "arcade", title: "Arcade" })}><i><ArcadeIcon /></i><span>Arcade</span></button>}
      <button className="rail-vault" aria-label="Vault" aria-current={!panel && !searchOpen && (active?.kind === "vault" || topNote ? "page" : undefined)} aria-expanded={vaults.length === 1 ? undefined : panel === "vault"} onClick={() => openVaultPlace(true)}><i><VaultIcon /></i><span>Vault</span></button>
      <button className="rail-search" aria-label="Search" aria-expanded={searchOpen} aria-keyshortcuts="Control+K Meta+K" onClick={openFind}><i><SearchIcon /></i><span>Search</span></button>
      <button className="rail-settings" aria-label="Settings" aria-expanded={panel === "settings"} onClick={() => { setSearchOpen(false); setPanel(panel === "settings" ? null : "settings"); setForgetArmed(false); }}><i><SettingsIcon /></i><span>Settings</span></button>
      </div>
    </nav>
    {railMore && <button className="rail-more-scrim" aria-label="Close More" tabIndex={-1} onClick={() => setRailMore(false)} />}
    {(panel || searchOpen) && <button className="panel-scrim" aria-label="Close navigation panel" onClick={() => { setPanel(null); setSearchOpen(false); }} />}
    {/* r14: one utility-panel frame for Settings, Search and Vault: the destination's title and Close, nothing else */}
    <aside ref={panelBox} className="rooms" aria-label={panelTitle} {...(panel || searchOpen ? { role: "dialog", "aria-modal": true, tabIndex: -1 } : {})}>
      {(panel || searchOpen) && <header className="panel-head"><h1>{panelTitle}</h1><button className="panel-close icon-button" aria-label="Close panel" title="Close" onClick={() => { setPanel(null); setSearchOpen(false); }}>×</button></header>}
      {pairSourceOpen && <PairSource onClose={() => setPairSourceOpen(false)} />}
      {panel === "settings" && <div className="settings">
        <p className="connection" role="status" data-fine={/^(Up to date$|Message sent|Asked Uni)/.test(status) && (!live || live === "Live") ? "true" : undefined}>{status}{live ? <span className={`live ${live === "Live" ? "on" : ""}`}> · {live}</span> : null}</p>
      {identity && <p className="identity" title={npub ?? identity}>{myName ? <>Signed in as <strong>{myName}</strong></> : <>Public key <code>{npub ? `${npub.slice(0, 14)}…${npub.slice(-6)}` : `${identity.slice(0, 12)}…`}</code></>}<button className="identity-copy" onClick={() => void copyText(npub ?? identity, "Copied public key")} aria-label="Copy your public key">⧉</button></p>}
        <UpdateSettings /><ClaudeUsage /><MotionSetting /><LifeOsVaultSetting vaults={vaults} /><SealedApprovals />
        <section className="settings-device" aria-label="This device"><h2>This device</h2><PairDeviceButton onOpen={() => setPairSourceOpen(true)} /><button className="pairing-secondary settings-forget" onClick={() => void forget()}>{forgetArmed ? "Tap again to forget. You'll need to pair again." : "Forget this device key"}</button>{forgetArmed && <button className="pairing-secondary" onClick={() => setForgetArmed(false)}>Keep it</button>}</section>
        {/* r13: the machinery (the app sandbox's self-test, where the app connects) is for whoever builds Uni, not part of ordinary Settings */}
        <details className="settings-dev"><summary>Developer</summary>{hub && <p className="settings-dev-line">Notes hub: <code>{hub}</code></p>}{syncDetail && <p className="settings-dev-line">Last sync: {syncDetail}</p>}<JournalVaultSetting /><AreaSelfTest /></details></div>}
      {searchOpen && <Search initialQuery={searchQuery} onQuery={(q) => { lastSearch.current = q; }} recent={navControls.recent} vaults={vaults} key={`${searchScope.vault}:${searchScope.prefix}`} initialVault={searchScope.vault} initialPathPrefix={searchScope.prefix} onOpen={openHit} onOpenNote={(n) => { setSearchOpen(false); openNote({ hub: null, vault: n.vault, ref: n.id }, null); }} onAskUni={askUniSearch} askIn={searchRoom ? searchRoom.name.replace(/^#/, "") : null} onClose={() => { setSearchOpen(false); if (topNote) setSidebarVisible(false); }} />}
      {searchOpen && error && <p className="error search-error" role="alert">{error}</p>}
      <div className="rooms-body" hidden={searchOpen}>
      <section className="vault-sidebar" aria-label="Vaults"><div className="vault-heading"><button className="note-quiet" onClick={() => setVaultRefresh((n) => n + 1)}>Look for new vaults</button></div>
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
    <section className="conversation" aria-label={journalOpen ? "Journal" : active?.kind === "mail" ? "Mail" : active?.kind === "calendar" ? "Calendar" : active?.kind === "messages" ? "Messages" : active?.kind === "posts" ? "To post" : active?.kind === "arcade" ? "Arcade" : shellOpen ? "Uni" : active?.kind === "note" ? "Note" : "Conversation"}>
      {/* T-335: an update is a line at the top, in the flow: never over the composer */}
      <UpdateBanner />
      {journalTab && <div className="journal-tab-content" hidden={!journalOpen} onFocusCapture={(e) => { if (e.target instanceof HTMLTextAreaElement) requestAnimationFrame(() => setComposerFocused(true)); }} onBlurCapture={(e) => { const journal = e.currentTarget; requestAnimationFrame(() => setComposerFocused(journal.contains(document.activeElement) && document.activeElement instanceof HTMLTextAreaElement)); }}><Journal focus={journalFocus} onFocus={() => setJournalFocus((v) => !v)} rooms={rooms} uniRoomId={findUniRoom(rooms)?.id ?? null} onShare={shareEntry} onRecordingChange={(on, controls) => { journalRecordingRef.current = on; setJournalRecording(on && controls ? { controls } : null); }} /></div>}
      {/* 0.2: the rail's places have no Back pill of their own: the rail (and the system Back, to where you came from) is the way out */}
      {active?.kind === "mail" ? <Mail />
      : active?.kind === "calendar" ? <Calendar />
      : active?.kind === "messages" ? <Messages />
      : active?.kind === "arcade" ? <ArcadeView ownerName={myName ?? null} onOpenNote={openArcadeNote} />
      : active?.kind === "posts" ? <ToPost key={active.path ?? ""} vault={lifeVault} node={active.path ?? null} />
      : active?.kind === "vault" && active.vault ? <VaultBrowser key={active.vault} vault={active.vault} onOpen={(note) => openTarget({ kind: "note", note: { hub: null, vault: active.vault!, ref: note.id }, title: note.path || note.id }, "new")} onCreate={(folder) => requestCreate(active.vault!, folder)} onSearch={(prefix, query = "") => { setSearchQuery(query); setSearchScope({ vault: active.vault!, prefix }); setSearchOpen(true); setSidebarVisible(true); }} />
      : journalOpen ? null
      : shellOpen && active ? <AreasSurface allPlace={allOpen ? { backTo: "Uni", from: null, onBack: () => openTarget(uniHome()), focus: allFocus, onFocus: (room, ref, threadRoot, place) => focusInAll(room, ref ?? null, threadRoot ?? null, place), onUnfocus: endAllFocus, onFocusBack: stepBackInFocus, onView: setFocusView } : null} noteBeside={asideShown && paneShape === "beside"} roomsPending={rooms.length === 0 && synced === 0} vaults={vaults} onBackChange={setAreaBack} onOverlayChange={setOverlay} identity={identity} key={allOpen ? `home:${identity ?? ""}` : `${active.id}:${identity ?? ""}`} path={shellPath} rooms={rooms} actions={areaActions} roomFor={areaRoomFor}
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
        returnSpot.current = spotNow() ?? null;
        openTarget({ kind: "note", note, title }, "new");
      }}
      onDirty={(ref, dirty) => { const k = noteKey(ref); if (dirty) asideDirty.current.add(k); else asideDirty.current.delete(k); }} />}
    {pill && <RecordingPill title={pill.title} controls={pill.controls} finish={pill.finish} overSidebar={sidebarVisible} onJump={() => { const o = recordingOrigin.current, tab = tabsRef.current.tabs.find((t) => t.id === pill.tabId); focusTabById(pill.tabId); if (tab?.kind === "all" && o?.channel && pill.finish === "send") focusInAll(o.channel, null, o.root ?? null); }} />}
    {/* A note opens over the place you were in; Back pops the note's own stack (or closes it at the first note). */}
    {topNote && !searchOpen && <section className="note-sheet" role="region" aria-label="Note">
      <NoteView key={`${tabs.active}:${notes.length}:${noteKey(topNote)}`} target={topNote} onSearch={(query) => { setSidebarVisible(true); setSearchQuery(query); setSearchScope({ vault: "", prefix: "" }); setSearchOpen(true); }} hub={hub} onOpen={openNote} onBack={closeNote}
        onResolved={(id) => {
          if (tabsRef.current.active) commitTabs(updateTab(tabsRef.current, tabsRef.current.active, { note: { hub: null, vault: topNote.vault, ref: id } }));
          aliases.current[JSON.stringify([topNote.vault, topNote.ref])] = id;
          try { localStorage.setItem(ALIASES_KEY, JSON.stringify(aliases.current)); } catch { /* session alias remains */ }
        }}
        startEditing={editOnOpen.current.has(noteKey(topNote))}
        onDirty={(dirty) => { reportDirty(tabs.active!, noteKey(topNote), dirty); if (!dirty) editOnOpen.current.delete(noteKey(topNote)); }}
        onCreate={(folder) => requestCreate(topNote.vault, folder)}
        backLabel={notes.length > 1 ? noteTitles[noteKey(notes[notes.length - 2])] ?? notes[notes.length - 2].ref.split("/").pop() ?? "note" : backTo}
        onTitle={(t) => rememberTitle(noteKey(topNote), t)} />
    </section>}
    {creating && <SurfaceModal onCancel={() => { if (!createBusy) setCreating(null); }}><form role="dialog" aria-modal="true" aria-label="New note" onSubmit={(e) => { e.preventDefault(); void createNote(); }}><h2>New note in {creating.vault}</h2><label>Name, with any folders before it<input autoFocus placeholder="Projects/Glaze Tests/Firing notes" value={creating.path} disabled={createBusy} onChange={(e) => setCreating({ ...creating, path: e.target.value })} /></label>{createError && <p className="error" role="alert">{createError}</p>}<button disabled={createBusy} type="submit">{createBusy ? "Creating…" : "Create note"}</button><button disabled={createBusy} type="button" onClick={() => setCreating(null)}>Cancel</button></form></SurfaceModal>}
    {confirmation && <SurfaceModal onCancel={() => setConfirmation(null)}><div role="alertdialog" aria-modal="true" aria-label="Unsaved changes">{confirmation.notice && <p role="status">{confirmation.notice}</p>}<p>{confirmation.text}</p><button autoFocus onClick={() => setConfirmation(null)}>Keep editing</button><button onClick={() => { const run = confirmation.run; setConfirmation(null); run(); }}>{confirmation.go}</button></div></SurfaceModal>}
    {toast && <div className="toast" role="status">{toast}</div>}
  </main></NoteOpener.Provider></NavContext.Provider></ApprovalsContext.Provider>;
}

export default App;
