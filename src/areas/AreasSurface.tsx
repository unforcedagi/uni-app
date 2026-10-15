import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConfirm } from "./useConfirm";
import { invoke } from "@tauri-apps/api/core";
import { TaskSheet, UndoBar, ownerLabel } from "./NodeWork";
import { useTasks } from "./useTasks";
import { draftsUnder, runsUnder, type Run } from "./steerCore";
import { CompanionSide, CompanionStrip, Stands, useCompanionOpen, type CompanionProps, type TaskLoad } from "./Companion";
import { chatPlaceholder, isMine, needsByRow, needsFeed, needsYou, privateNote, withWaiting, standsHeading, standsLine, asOfDate, firstSentence, stateLine, uniPanel, type PrivateNeed } from "./simpleCore";
import { ownRoom, type Steward } from "./talkCore";
import type { Area } from "./areasCore";
import { isMe, priorityOf, tasksUnder, type Task, type TaskNode } from "./taskCore";
import type { RoomInfo } from "./TodayView";
import { refreshDraft } from "./briefCore";
import AreaView, { type AppView, type AreaActions } from "./AreaView";
import type { AreaRoom } from "./AreaChat";
import { currentUserAgent, gateMode, platformName } from "../interface/selftest/gate";
import { useAppVersion, useWebviewRuntime } from "../interface/selftest/useAppVersion";
import { useAreas } from "./useAreas";
import { pickRoom } from "./areaLayout";
import { childrenOf, parentPath, ROOT, rootNode, trail, UNI_CHANNEL } from "./treeCore";
import { findUniRoom } from "../uniActions";
import { useStoredSelfTest } from "../interface/selftest/useSelfTest";
import { useRailHidden, useShortTree, useUprightPhone, useWide } from "./homeLayout";
import { privateRoot, privateRootIn, roomSlug, roomView, treeRows } from "./treeRooms";
import { publishRoomNodes, roomNodeMap } from "./roomLabels";
import { useNav, type NavControls } from "../navContext";
import { useVaultProfile } from "./ProfileContext";
import { Crumbs, RoomSidebar, TreeScreen } from "./TreeHome";
import { WorkView } from "./WorkView";
import { LoadHealth } from "./LoadHealth";
import { Body } from "../MessageBody";
import { projectBody } from "./projectBody";
import { rootOpenMemory } from "./rootMemory";
import { openDialog } from "./focusTrap";
import { publishDecisions, setDecisionOpener } from "../decisionLinks";
import { taskTitle } from "./whereCore";
import type { NoteRef } from "./noteRefsCore";
import "./areas.css";
import "./tree.css";

const USER_AGENT = currentUserAgent();
const PLATFORM = platformName(USER_AGENT);

/** The note for a room no node owns: the companion says so instead of a node's state. */
export const UNFILED = "Not filed under an area yet.";

/** What the host does for the shell: as an area app's actions, except that a note is opened in its own vault (r15). */
export type ShellActions = Omit<AreaActions, "openNote"> & { openNote(ref: NoteRef): void;
  /** r21 (Codex 9): read the rooms list again (a conversation slow to open before its room is known) */
  retryRooms?: () => void;
  /** r24: scroll to and mark a message of the room open now ("Check in #room first" goes to the first message about the request) */
  focusMessage?: (ref: string | null, room?: string, checking?: string | null) => void };

/**
 * What is open over the place (the task sheet, the work view, the drawer): Android Back closes it first. `modal` (the sheet) holds Alt+arrow
 * history while open; `history` says Alt+← and the sidebar's ← close it before they change places (the work view; not the drawer alone,
 * whose own Back button goes back).
 */
export type Overlay = { close: () => void; modal: boolean; history: boolean };

/** After this long a conversation still opening says so, with a way to try again (r21, Codex 9). */
/** r28: the rechecks are logged once per launch (the module lives as long as the app does) */
const recheckLogged = { done: false };
const CHAT_SLOW_MS = 8000;
/**
 * The conversation's place while it opens (r21, Codex 9): a quiet chat, shaped like the one coming (an empty conversation and its composer's
 * line, greyed), never a status panel beside an empty column. Past 8 seconds it says it is still opening, with Retry.
 */
function ChatWait({ placeholder, retry }: { placeholder: string; retry: (() => void) | null }) {
  const [slow, setSlow] = useState(false);
  const [tries, setTries] = useState(0);
  useEffect(() => { const t = setTimeout(() => setSlow(true), CHAT_SLOW_MS); return () => clearTimeout(t); }, [tries]);
  return <div className="sr-chat-wait" aria-busy="true">
    <p className="sr-chat-wait-line" role="status">{slow ? <>Still opening the conversation{retry && <> · <button type="button" className="cp-retry" onClick={() => { setSlow(false); setTries(tries + 1); retry(); }}>Retry</button></>}</> : "Opening the conversation…"}</p>
    <div className="sr-chat-wait-composer" aria-hidden="true">{placeholder}</div>
  </div>;
}

/**
 * The room shell: Uni itself at `{kind:"areas"}` (path null), any area or project under it at `{kind:"area", path}`, a room no node owns
 * (`loose`, listed under "Other rooms") and a thread of any of them. One component for all: the tree, the conversation, the companion. "All of
 * X's work" is a view inside the same shell (r13), and below 900px the tree is a drawer opened from the room's header, with the app's places.
 */
export default function AreasSurface({ identity, path, loose = null, thread = null, rooms: hostRooms, roomsPending = false, actions, roomFor, onRoom, onOpenArea, onBackChange, onOverlayChange }: {
  identity: string | null;
  path: string | null;
  /** A room no node owns: shown in the same shell, with the companion saying it is not filed under an area yet. `path` is ignored. */
  loose?: string | null;
  /** A thread (its room and root message), shown in the shell of its room's node, or as a loose room's. */
  thread?: { channel: string; root: string } | null;
  rooms: RoomInfo[]; actions: ShellActions;
  /** The rooms list has not arrived yet (a fresh start): a room place waits for it instead of showing a page with "no room". */
  roomsPending?: boolean;
  /** The host's room view for a room id (or one of its threads, by root): its messages and composer, when that is the one loaded. */
  roomFor: (id: string | null | undefined, threadRoot?: string | null) => AreaRoom | null;
  /** The open node's room (null: none), so the host can load it, and whether the room is the node's own (r15: a borrowed one is not reopened). */
  onRoom: (id: string | null, own: boolean | null) => void;
  /** Open a node (path null: Uni) in this tab. */
  onOpenArea: (areaPath: string | null, name: string, room: string | null) => void;
  onBackChange: (back: (() => void) | null) => void;
  /** What is open over the place, so the host's Back (Alt+←, the sidebar's ←) closes it before it changes places. */
  onOverlayChange?: (o: Overlay | null) => void;
}) {
  // chat.provider null: no Buzz on this surface. No rooms are known here, so nothing resolves a steward, loads messages or opens a room.
  const profile = useVaultProfile();
  const chat = profile.chat.provider === "buzz";
  /** A note named by path or id in this vault (a brief's link, the area app's), opened in this vault, never in another. */
  const openHere = (ref: string) => actions.openNote({ vault: profile.vault, id: ref });
  const appActions: AreaActions = { ...actions, openNote: openHere };
  const rooms = useMemo<RoomInfo[]>(() => (chat ? hostRooms : []), [chat, hostRooms]);
  const { data, error, loading, signingIn, retry: retryAreas } = useAreas(identity);
  const nav = useNav();
  const wide = useWide();
  /** One rule for global navigation (r14): Places (the drawer) shows whenever the rail is hidden, and below 900px where the tree is. */
  const railHidden = useRailHidden();
  /** r17: under 400px tall the sidebar folds into the drawer (the chat had ~170px beside it at 920×360): one tree, never two. */
  const shortTree = useShortTree();
  const sidebar = wide && !shortTree;
  const placesDrawer = !sidebar || railHidden;
  /** The companion beside (wide) or above (phone) the conversation: open or folded, remembered per device. */
  /** r19: a wide window too short for the sidebar (920×360) has no room for a side panel either: the companion is the strip there, folded to
   *  one line that still says what is waiting ("Needs you · 2: <first action>"). */
  const stripCompanion = !wide || shortTree;
  const [companionOpen, setCompanionOpen] = useCompanionOpen(stripCompanion ? "strip" : "side");
  /** Phone: the room tree is the home and a level opens from it; Uni's own level is one tap on its row. */
  const [rootOpen, setRootOpenState] = useState(rootOpenMemory.open);
  const setRootOpen = (v: boolean) => { rootOpenMemory.open = v; setRootOpenState(v); };
  const phoneTree = !wide;
  /** The tree as a full-screen home (a phone held upright). A short window (the rail hidden: 740×360) opens on the room instead, with Places in
   *  its header (r15): the tree is the drawer there. r20: so does every size that isn't an upright phone (800×600 opened on the tree). */
  const upright = useUprightPhone();
  const treeHome = phoneTree && !railHidden && upright;
  const version = useAppVersion();
  const runtime = useWebviewRuntime();
  const stored = useStoredSelfTest();
  // Live: a self-test pass (or a revoke) updates an already-open area without a remount.
  const mode = useMemo(() => gateMode(PLATFORM, version, stored, USER_AGENT, undefined, runtime), [version, stored, runtime]);
  const uniRoom = useMemo(() => (rooms.some((r) => r.id === UNI_CHANNEL) ? UNI_CHANNEL : findUniRoom(rooms)?.id ?? null), [rooms]);
  const root = useMemo(() => rootNode(uniRoom ? [uniRoom] : []), [uniRoom]);
  const roomRefs = useMemo(() => rooms.map((r) => ({ id: r.id, name: r.name })), [rooms]);
  const uniRef = useMemo(() => roomRefs.find((r) => r.id === uniRoom) ?? null, [roomRefs, uniRoom]);
  /** A node that names its room only by `room` (no channel id) still opens that room. */
  const withRoom = (a: Area): Area => { if (!chat) return a.rooms.length ? { ...a, rooms: [] } : a; if (a.rooms.length) return a; const r = ownRoom({ room: typeof a.metadata.room === "string" ? a.metadata.room : null, channels: [] }, roomRefs); return r ? { ...a, rooms: [r.id] } : a; };
  const found = loose ? null : path ? data?.tree.nodes.get(path) ?? null : root;
  const node = found ? withRoom(found) : null;
  /** A project's own note, read when its work view opens (it is shown there, folded). */
  const [body, setBody] = useState<string | null>(null);
  /** The open task, by id: the sheet always shows the list's current copy (r13), and says so when the task has closed elsewhere. */
  const [sheetId, setSheetId] = useState<string | null>(null);
  const lastSheet = useRef<Task | null>(null);
  const openSheet = (t: Task) => { lastSheet.current = t; setSheetId(t.id); };
  const closeSheet = () => { setSheetId(null); };
  /** "All of X's work": a view inside the shell, over the chat; Back (every kind) closes it first. Without chat it is the room's only view. */
  const [work, setWork] = useState(false);
  /** Below 900px: the tree, Back/Forward, Recent and the app's places, in a drawer opened from the room's header. */
  const [drawer, setDrawer] = useState(false);
  /** The area's app, as a view inside the shell (r14): Back (every kind) closes it, like the work view. */
  const [appOpen, setAppOpen] = useState(false);
  /** r20 (Codex 5): the narrow companion's sheet is a foreground surface like the task sheet: every Back closes it first. */
  const [stripSheet, setStripSheet] = useState<{ close: () => void } | null>(null);
  const toTree = () => { setRootOpen(false); onOpenArea(null, "Uni", uniRoom); };
  const back = loose ? (treeHome ? toTree : null) : path ? (treeHome ? toTree : () => {
    const up = data ? data.tree.nodes.get(parentPath(data.tree, path)) : null;
    onOpenArea(up?.path ?? null, up?.name ?? "Uni", up ? pickRoom(withRoom(up).rooms, null) : uniRoom);
  }) : treeHome && rootOpen ? () => setRootOpen(false) : null;
  /** What is over the place, top first: the sheet (modal), then the drawer, then the work view (only when the chat is there to go back to). */
  const workOver = work && chat;
  // the drawer is closed by every Back first (r14), its own Back button excepted (that one goes back a place as it closes)
  const overlay: Overlay | null = sheetId ? { close: closeSheet, modal: true, history: false }
    : stripSheet ? { close: stripSheet.close, modal: true, history: false }
    : drawer ? { close: () => setDrawer(false), modal: false, history: true }
    : appOpen ? { close: () => setAppOpen(false), modal: false, history: true }
    : workOver ? { close: () => setWork(false), modal: false, history: true } : null;
  const overlayKey = `${sheetId ? "sheet" : ""}${stripSheet ? "strip" : ""}${drawer ? "drawer" : ""}${appOpen ? "app" : ""}${workOver ? "work" : ""}`;
  // (layout effects: what is over the place is known to the host's Back before the first key can reach it)
  useLayoutEffect(() => {
    // Android Back closes what is over the place before it zooms out a level.
    onBackChange(sheetId ? closeSheet : stripSheet ? stripSheet.close : drawer ? () => setDrawer(false) : appOpen ? () => setAppOpen(false) : workOver ? () => setWork(false) : back);
    return () => onBackChange(null);
  }, [path, loose, data, uniRoom, onOpenArea, onBackChange, overlayKey, phoneTree, treeHome, rootOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    onOverlayChange?.(overlay);
    // Escape closes the drawer or the work view (the sheet handles its own)
    const esc = (e: KeyboardEvent) => { if (e.key !== "Escape" || !overlay || overlay.modal || e.defaultPrevented) return; if (drawer) setDrawer(false); else if (appOpen) setAppOpen(false); else setWork(false); };
    if (overlay && !overlay.modal) window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("keydown", esc); };
  }, [overlayKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onOverlayChange?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const workShown = work || !chat;
  // the drawer is a dialog (r14): focus moves in, stays in (Tab wraps), what is under it is inert, and closing gives focus back to Places
  const drawerBox = useRef<HTMLElement>(null);
  const drawerOpener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!drawer) return;
    const box = drawerBox.current; const wrap = box?.closest(".th-drawer-wrap") as HTMLElement | null;
    if (!box || !wrap) return;
    // r19: the one dialog contract every foreground surface uses (focusTrap.openDialog)
    return openDialog(box, () => setDrawer(false), { root: wrap, initial: box.querySelector<HTMLElement>(".th-place, button:not(:disabled)") ?? box, opener: drawerOpener.current });
  }, [drawer]);
  useEffect(() => {
    setBody(null);
    if (!identity || node?.kind !== "project" || !workShown) return;
    let live = true;
    projectBody(identity, node).then((text) => { if (live) setBody(text); }).catch(() => {});
    return () => { live = false; };
  }, [identity, node?.id, node?.updatedAt, workShown]); // eslint-disable-line react-hooks/exhaustive-deps
  // A node can have several rooms (metadata.channel is a list): its app hears the first.
  const nodeRoom = node ? pickRoom(node.rooms, null) : null;
  // The room shown is the steward's room (a held project's area room), so that is the one the host opens.
  const stewardRoomId = node && data ? roomView(data.tree, node.path, roomRefs, uniRef).target?.id ?? null : null;
  const hostRoom = !chat ? null : stewardRoomId ?? (node?.path === ROOT ? uniRoom : null);
  // a thread's room is the thread's own (the host opened it with the tab)
  // whether the room is the node's own is known once the tree is (before that a node is not taken for borrowing)
  const ownRoomHere = !node ? null : node.path === ROOT ? true : !data ? null : roomView(data.tree, node.path, roomRefs, uniRef).own;
  useEffect(() => { if (node && !thread) onRoom(hostRoom, ownRoomHere); }, [node?.id, hostRoom, !thread, ownRoomHere]); // eslint-disable-line react-hooks/exhaustive-deps
  const roomName = useMemo(() => (id: string) => rooms.find((r) => r.id === id)?.name ?? "room", [rooms]);
  const now = Date.now();
  const fallback = useMemo<TaskNode[]>(() => (data?.areas ?? []).map((a) => ({ id: a.id, path: a.path, name: a.name, parent: a.parent, room: typeof a.metadata.room === "string" ? a.metadata.room : null, status: a.status === "archived" || a.status === "done" ? a.status : "active", isRoot: false })), [data?.areas]);
  // The whole tree's tasks are loaded once (the room tree beside the room needs every row's dot) and each level takes its subtree.
  const tasks = useTasks(identity, "", fallback);
  const levelTasks = useMemo(() => (tasks.tree && node ? tasksUnder(tasks.tree, node.path, tasks.tasks) : tasks.tasks), [tasks.tree, tasks.tasks, node?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  // r17: one answer mechanism: the chat links a message that names an open decision to that decision's sheet here (never a private area's)
  useEffect(() => {
    const tree = data?.tree;
    publishDecisions((tasks.all ?? []).filter((t) => t.kind === "decision" && t.state === "open" && !(tree && privateRoot(tree, t.node))).map((t) => ({ id: t.id, tid: taskTitle(t.title).id, forTask: t.forTask ?? null })));
  }, [tasks.all, data?.tree]);
  useEffect(() => { setDecisionOpener((id) => { setWork(false); setDrawer(false); setAppOpen(false); setSheetId(id); }); return () => setDecisionOpener(null); }, []);
  /** The task list's health, for the companion and the tree. */
  const load: TaskLoad = { error: tasks.error, treeError: tasks.treeError, refreshing: tasks.refreshing, lastOk: tasks.lastOk, complete: tasks.complete, retry: tasks.refresh, savedAt: tasks.savedAt, slow: tasks.slow };
  // opening a room anywhere opens its node's one view
  // with the areas unreadable (an error, not a load still under way) only Uni's room is known to be owned: every other room stays reachable as "Other rooms"
  const owned = useMemo(() => (!chat ? null : data ? roomNodeMap(data.tree, roomRefs, uniRef) : error && !loading ? new Map(uniRef ? [[uniRef.id, { name: "Uni", path: ROOT }]] : []) : null), [data, chat, error, loading, roomRefs, uniRef]);
  useEffect(() => { if (owned) publishRoomNodes(owned); }, [owned]);
  /** "Other rooms": every room no node owns (not Uni's), by name. Known only once the tree is: before that, nothing is listed as unfiled. */
  const others = useMemo(() => (owned ? roomRefs.filter((r) => !owned.has(r.id) && r.id !== uniRoom).sort((a, b) => a.name.localeCompare(b.name)) : []), [owned, roomRefs, uniRoom]);
  // Opening a room re-reads the tasks if the copy is more than a few seconds old (the needs-you feed must not show what is already done).
  useEffect(() => { tasks.refreshIfStale(); }, [node?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSheetId(null); setWork(false); setDrawer(false); setAppOpen(false); }, [node?.path, loose, thread?.root]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Who stewards a node: its own room, else the nearest ancestor's (an archived room's `room_fallback` stands in), else #Uni. */
  const stewardOf = (p: string): Steward => {
    const v = data ? roomView(data.tree, p, roomRefs, uniRef) : { target: uniRef, own: false, heldBy: uniRef };
    return { room: v.target, via: v.own ? "own" : v.heldBy && v.heldBy.id !== uniRef?.id ? "inherited" : "uni", from: null };
  };
  const roomOfNode = (p: string) => stewardOf(p).room;
  // r28 (Codex P1-1/2): an ask is confirmed here, in the feed, before any row, count or dot shows it: one read of each room's chat, cached
  const roomOfTask = useCallback((t: Task) => (data ? roomView(data.tree, t.node, roomRefs, uniRef).target : uniRef) ?? null, [data, roomRefs, uniRef]);
  const confirm = useConfirm(tasks.tasks, roomOfTask, tasks.lastOk, tasks.ready && (!chat || !!data || !!error), chat, (id) => rooms.find((r) => r.id === id)?.last_ts ?? null);
  // r28: the asks Uni must recheck are told to the rooms once per launch, as task ids in the app's log (the app never writes them to the vault)
  useEffect(() => {
    if (!confirm.settled || tasks.savedAt || recheckLogged.done) return;
    const ids = tasks.tasks.filter((t) => needsYou(t) && confirm.of(t).state === "recheck").map((t) => taskTitle(t.title).id).filter(Boolean) as string[];
    recheckLogged.done = true;
    void invoke("log_line", { line: `recheck: ${ids.join(" ") || "none"}` }).catch(() => {});
  }, [confirm.settled, tasks.tasks, tasks.savedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const decide = (t: Task, o: string) => void tasks.decide(t, o);
  const open = (a: Area) => { setRootOpen(false); const w = withRoom(a); onOpenArea(w.path, w.name, pickRoom(w.rooms, null)); };
  const toUni = () => onOpenArea(null, "Uni", uniRoom);
  const openPath = (p: string) => {
    setDrawer(false);
    if (p === ROOT) { setRootOpen(true); onOpenArea(null, "Uni", uniRoom); return; }
    const n = data?.tree.nodes.get(p); if (n) open(n);
  };
  const navRows = data ? treeRows(data.tree, roomRefs, uniRef) : [{ path: ROOT, name: "Uni", depth: 0, kind: "root" as const, slash: uniRef ? uniRef.name : null, heldBy: null, heldNode: null, own: !!uniRef, trunk: [], last: true }];
  /** A row's dot is its own node's needs-you items (a parent never lights up for its children's), by the companion's one rule; an item on a
   *  node with no row counts on its nearest ancestor's (r13), so the dots under a level add up to its Needs you. */
  const rowPaths = useMemo(() => new Set(navRows.map((r) => r.path)), [navRows.map((r) => r.path).join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps
  const navNeeds = useMemo(() => needsByRow(tasks.tasks, rowPaths, (p) => tasks.tree?.parent.get(p) ?? data?.tree.parent.get(p), confirm.of, tasks.runs), [tasks.tasks, tasks.runs, rowPaths, tasks.tree, data?.tree, confirm.of]); // eslint-disable-line react-hooks/exhaustive-deps
  const openRoomFromTree = (id: string) => { setDrawer(false); actions.openRoom(id); };
  const treeProps = { chat, rows: navRows, needs: navNeeds, onOpen: openPath, others, onOpenRoom: openRoomFromTree, load, needsReady: tasks.ready };
  /** The app's own places (Journal, Vault, Search, Settings), for where the rail is out of reach: the drawer and a short screen's tree. */
  const places = nav?.places ?? [];
  // r17: Places holds only what the shell is not already showing: the app's places only while the rail is hidden (Codex P2-4)
  const placesRow = railHidden && places.length > 0 && <nav className="th-places" aria-label="App">{places.map((p) => <button key={p.label} type="button" className="th-place" onClick={() => { setDrawer(false); p.go(); }}>{p.label}</button>)}</nav>;
  const drawerNav: NavControls | null = nav ? { ...nav, back: () => { setDrawer(false); (nav.backPlace ?? nav.back)(); }, forward: () => { setDrawer(false); nav.forward(); }, recent: nav.recent.map((r) => ({ ...r, go: () => { setDrawer(false); r.go(); } })) } : null;
  /**
   * The room itself: a header (title, the room's own name, where it sits), the conversation, and the companion beside it (wide) or as a
   * strip above it (phone). A thread or the work view shows inside it, with a way back to the room.
   */
  const shell = (o: { title: string; door: string;
    /** A node in a borrowed room (r20): the node stays the heading, and this line says where it talks ("Chat in #Uni · no room of its own yet"). */
    context?: string; node?: string; crumbs: ReactNode; companion: CompanionProps | null; chatRoom: AreaRoom | null; placeholder: string; selected?: string; selectedRoom?: string; sheet: ReactNode; main?: ReactNode; workBar?: ReactNode;
    /** The area's app, opened from the header (r14): it shows as a view in this shell. */
    openApp?: ((e: React.MouseEvent) => void) | null; appOpen?: boolean;
    /** r21 (Codex 9): open the conversation again when it is slow to arrive */
    retryChat?: (() => void) | null }) => {
    const replies = thread && o.chatRoom?.loaded ? o.chatRoom.messages.filter((m) => m.ref !== thread.root).length : null;
    const view = o.main ? "work" : thread ? "thread" : "room";
    return <div className={`tree-home th-level ${wide ? "wide" : "phone"} th-rooms th-simple ${wide && (!o.companion || o.main || stripCompanion) ? "solo" : wide && !companionOpen ? "folded" : ""}`} data-layout="rooms" data-view={view}>
      {sidebar && <RoomSidebar {...treeProps} selected={o.selected} selectedRoom={o.selectedRoom} nav={nav} />}
      <section className="sr" aria-label={o.main ? `Work: ${o.title}` : `Conversation: ${o.title}`} data-node={o.node}>
        <header className="sr-head">
          {placesDrawer && <button ref={drawerOpener} type="button" className="sr-drawer" aria-label="Places" title="Rooms and places" aria-expanded={drawer} aria-controls="th-drawer" onClick={() => setDrawer(true)}><span aria-hidden="true" /></button>}
          <div className="sr-titles">
            {(o.door || o.crumbs) && <div className="sr-meta">{o.crumbs}{o.door && <span className="sr-door">{o.door}</span>}</div>}
            <h1 className="sr-title">{o.title}</h1>
            {o.context && <p className="sr-context">{o.context}</p>}
          </div>
          {o.openApp && !o.appOpen && <button type="button" className="sr-app" aria-label={`Open the ${o.title} app`} onClick={o.openApp}>App ›</button>}
        </header>
        {thread && !o.main && <div className="sr-thread"><button type="button" className="sr-thread-back" onClick={() => actions.openRoom(thread.channel)}><span aria-hidden="true">‹</span> Back to the room</button>
          <span className="sr-thread-label">Thread{replies !== null ? ` · ${replies} ${replies === 1 ? "reply" : "replies"}` : ""}</span></div>}
        {o.workBar}
        {/* below 900px the tree (and its health line) is in the drawer: the room says it itself, outside the drawer (r14); the work view has its own */}
        {stripCompanion && o.companion && !o.main && tasks.ready && <LoadHealth load={load} ready count={o.companion.feed.total} className="sr-health" />}
        {stripCompanion && o.companion && !o.main && <CompanionStrip {...o.companion} open={companionOpen} onToggle={setCompanionOpen} onSheet={(close) => setStripSheet(close ? { close } : null)} behind={!!sheetId} />}
        {o.main ? <div className="sr-work">{o.main}</div>
          : <div className="sr-chat" data-chat={o.chatRoom ? "open" : "waiting"}>{o.chatRoom ? o.chatRoom.render(null, o.placeholder) : <ChatWait placeholder={o.placeholder} retry={o.retryChat ?? null} />}</div>}
      </section>
      {!stripCompanion && o.companion && !o.main && <CompanionSide {...o.companion} open={companionOpen} onToggle={setCompanionOpen} />}
      {placesDrawer && drawer && <div className="th-drawer-wrap">
        <button type="button" className="th-drawer-scrim" aria-label="Close places" tabIndex={-1} onClick={() => setDrawer(false)} />
        <aside ref={drawerBox} id="th-drawer" className="th-drawer" role="dialog" aria-modal="true" aria-label="Rooms and places" tabIndex={-1}>
          {placesRow}
          <TreeScreen column {...treeProps} selected={o.selected} selectedRoom={o.selectedRoom} nav={drawerNav} onHide={() => setDrawer(false)} hideLabel="Close places" />
        </aside>
      </div>}
      <UndoBar undo={tasks.undo} notice={tasks.notice} onDismiss={tasks.dismissNotice} />
      {o.sheet}
    </div>;
  };
  /** The frame the app tab's host gives a node's page (AreaView), for a room no node owns. */
  const frame = (inner: ReactNode) => <div className="area-view tree-page"><div className="area-split mode-hidden"><div className="area-main"><div className="area-stage">{inner}</div></div></div></div>;
  if (loose) {
    const info = rooms.find((r) => r.id === loose);
    const title = info ? `#${info.name.replace(/^#/, "")}` : "Room";
    const companion: CompanionProps = { stands: null, ready: !!data, note: data ? UNFILED : null, feed: { rows: [], privates: [], total: 0 }, runs: [], nodeName: title, onTask: () => {}, onNote: actions.openNote, onDecide: () => {}, onEverything: null };
    return frame(shell({ title, door: "", crumbs: null, companion, chatRoom: roomFor(loose, thread?.root ?? null), placeholder: `Message ${title}`, selectedRoom: loose, sheet: null, retryChat: () => actions.openRoom(loose) }));
  }
  // r15: an area that can't be shown (gone, or the areas couldn't be read) stays inside the room shell: the tree (or Places), a heading that
  // says what happened, and the ways on: Retry, Back, Uni
  if (!node) {
    const gone = !signingIn && !loading && !error;
    const title = signingIn ? "Signing in…" : loading ? "Opening…" : error ? "Couldn't open this area" : "This area no longer exists";
    const main = <div className="wv sr-missing" role={error ? "alert" : "status"}>
      {error && <p className="cp-none">The areas couldn't be read: {error.replace(/^Error:\s*/, "").slice(0, 160)}</p>}
      {gone && <p className="cp-none">It may have been renamed, moved or archived. It is not in the tree any more.</p>}
      {!signingIn && !loading && <p className="sr-missing-go">
        {error && <button type="button" className="task-do primary" onClick={retryAreas}>Retry</button>}
        {nav?.canBack && <button type="button" className="task-do" onClick={() => nav.back()}>Back</button>}
        <button type="button" className={`task-do${error ? "" : " primary"}`} onClick={toUni}>Open Uni</button>
      </p>}
    </div>;
    return frame(shell({ title, door: "", crumbs: null, companion: null, chatRoom: null, placeholder: "", sheet: null, main }));
  }
  const isRoot = node.path === ROOT;
  const tree = data?.tree;
  const status = <>
    {signingIn && !data && <p className="areas-status" role="status">Signing in…</p>}
    {data?.stale && <p className="areas-status" role="status">{error ? `Saved copy${data.savedAt ? ` from ${new Date(data.savedAt).toLocaleString()}` : ""} · couldn't refresh: ${error}` : "Saved copy · refreshing…"}</p>}
    {!data && error && <p className="note-error" role="alert">Couldn't load areas: {error}</p>}
    {!!data?.truncated.length && <p className="areas-status" role="status">{data.truncated.join(", ")}: showing first 200 notes; more may exist.</p>}
  </>;
  if (treeHome && path === null && !rootOpen) {
    return <div className="areas-home tree-home-wrap"><TreeScreen {...treeProps} status={<>{status}{railHidden && places.length > 0 && <div className="th-places-short">{placesRow}</div>}</>} />
      <UndoBar undo={tasks.undo} notice={tasks.notice} onDismiss={tasks.dismissNotice} /></div>;
  }
  const stewardView: Steward = isRoot ? { room: uniRef, via: "own", from: null } : stewardOf(node.path);
  const target = stewardView.room;
  const nodeName = (p: string) => data?.tree.nodes.get(p)?.name ?? p.split("/").pop() ?? p;
  const here = isRoot ? "" : node.path;
  const rowOf = (p: string) => (tree ? roomView(tree, p, roomRefs, uniRef) : { target: uniRef, slash: null, heldBy: uniRef, own: false, heldNode: null });
  const nodeView = rowOf(node.path);
  /** A node with no room of its own talks in an ancestor's (or Uni's): that real room is the heading over its conversation, and the node is a
   *  line under it (r15). Its work view and app are still the node's own, so they keep its name. */
  const borrowed = chat && !isRoot && !nodeView.own && nodeView.heldBy ? `#${roomSlug(nodeView.heldBy.name)}` : null;
  // r20 (Codex 6): one identity across the header, the breadcrumb and the work view: the heading is the node's name everywhere, and the room it
  // talks in is a secondary line ("Chat in #Uni"); the composer keeps the real channel's name
  const context = borrowed ? `Chat in ${borrowed} · no room of its own yet` : undefined;
  const askRoom = target?.id ?? null;
  const trailItems = [{ path: ROOT, name: "Uni" }, ...(tree && !isRoot ? trail(tree, node.path) : isRoot ? [] : [node]).map((n) => ({ path: n.path, name: n.name }))];
  // r21 (found in the real app, cold at 800×600): before the areas are read, a private area's task showed as an ordinary row ("Pick Sanctum
  // design…"). Privacy is read from the task tree until the areas are, and nothing is listed while neither is known
  const privateOf = (p: string) => (tree ? privateRoot(tree, p) : tasks.tree ? privateRootIn(tasks.tree, p) : null);
  const privacyKnown = !!tree || !!tasks.tree;
  /** The private area this level is, or sits in: Aaron opened it himself, so its own items show as they are (r14). */
  const selfPrivate = privateOf(node.path);
  /** A private area's words are never shown outside it: not in Uni's panel, a parent's list, runs, drafts or the stands line. */
  const hidden = (p: string) => { const r = privateOf(p); return !!r && r.path !== selfPrivate?.path; };
  // ------------------------------------------------------------------------------------------ Needs you: one feed, one count (r13)
  // r23: each row knows the room that stewards it, as its sheet does ("Ask #techne for the message")
  const drafted = new Set(tasks.drafts.map((d) => d.task?.toUpperCase()).filter(Boolean));
  const feed0 = needsFeed(levelTasks.map((t) => ({ ...t, stewardRoom: roomOfNode(t.node)?.name ?? null, hasDraft: drafted.has(taskTitle(t.title).id?.toUpperCase()) })), privateOf, selfPrivate, undefined, confirm.of);
  const taskTree = tasks.tree;
  const runs = taskTree ? runsUnder(taskTree, here, tasks.runs).filter((r) => !hidden(r.node)) : [];
  // r28 (Codex P2-6): a run waiting on the user's answer is in the same feed, counted once with the asks
  const feed = withWaiting(feed0, runs);
  const panel = isRoot ? uniPanel(feed) : { ...feed, rest: 0, privateCount: 0 };
  const drafts = taskTree ? draftsUnder(taskTree, here, tasks.drafts).filter((d) => !hidden(d.node)) : [];
  const openPrivate = (o: PrivateNeed["open"]) => { closeSheet(); stripSheet?.close(); setWork(false); openPath(o.path); };
  // r18: one summary for the companion and the work view: the node's `stands`, else its brief's "Now" (with the brief's own time), else the
  // newest change it names (standsLine)
  const brief = !isRoot ? data?.briefs[node.path] ?? null : null;
  const briefStands = brief?.brief.now ? { text: brief.brief.now, at: brief.generatedAt ?? brief.updatedAt ?? null } : null;
  const rawStands = tasks.tree?.stands.get(node.path) ?? (typeof node.metadata.stands === "string" ? { text: node.metadata.stands, at: typeof node.metadata.stands_at === "string" ? node.metadata.stands_at : null } : briefStands);
  /** A vault with no areas yet: Uni says how to start, in plain words (r13), instead of a tag and a path to type. */
  const noAreas = isRoot && !!tree && !error && childrenOf(tree, ROOT).length === 0;
  const stands0 = noAreas ? { text: "No areas yet. Tell Uni here what you want to look after, and it will set up your first area.", ago: "" } : standsLine(rawStands, levelTasks.filter((t) => !hidden(t.node)), now);
  /** r29 (Codex P1-3): a written summary is a dated account: "Last written Oct 14 by #room:" and the text as written. The app doesn't judge whether it still holds. */
  const written = !noAreas && !!rawStands && !!firstSentence(rawStands.text);
  const stands = stands0 && !noAreas ? { ...stands0, written, asOf: written ? asOfDate(rawStands!.at) : null, by: written ? target?.name ?? null : null } : stands0;
  /** The room's composer when it is the one here, else that room's (opened, filled in, never sent). */
  const sayIn = (roomId: string, text: string) => { closeSheet(); stripSheet?.close(); setWork(false); const here = roomFor(roomId); if (here) here.compose(text); else actions.compose(roomId, text); };
  /** From the work view or the sheet, "Open #room" for this room is the conversation: it goes back to it. Another room opens as a tab. */
  const openRoomHere = (id: string, focus?: string | null, checking?: string | null) => { if (chat && id === target?.id) { closeSheet(); stripSheet?.close(); setWork(false); if (focus || checking) actions.focusMessage?.(focus ?? null, id, checking ?? null); } else (actions.openRoom as (id: string, focus?: string | null, checking?: string | null) => void)(id, focus, checking); };
  /** r30: a run waiting on the user's answer is a row like a request: it opens its room (at the run's message, when it has one) with the composer focused, writing nothing */
  const openRun = (r: Run) => {
    const named = r.room ? rooms.find((x) => x.name.replace(/^#/, "").toLowerCase() === r.room!.toLowerCase()) ?? null : null;
    const room = named ?? roomOfNode(r.node) ?? target;
    if (!room) return;
    closeSheet(); stripSheet?.close(); setWork(false);
    const here = roomFor(room.id);
    if (here) here.compose(""); else actions.compose(room.id, "");
    if (r.message) actions.focusMessage?.(r.message, room.id, null);
  };
  const live = sheetId ? tasks.all?.find((t) => t.id === sheetId) ?? null : null;
  if (live) lastSheet.current = live;
  const sheetTask = sheetId ? live ?? (lastSheet.current?.id === sheetId ? lastSheet.current : null) : null;
  const sheetGone = !!sheetId && (!live || !(live.state === "open" || live.state === "doing" || live.state === "waiting") || (tasks.ready && !tasks.tasks.some((t) => t.id === sheetId) && !tasks.leaving.has(sheetId)));
  /** r18: a draft note written for the task (its `task` field names it): its text is the message the sheet copies. */
  const draftOf = (t: Task) => { const tid = taskTitle(t.title).id?.toUpperCase(); const d = tid ? tasks.drafts.find((x) => x.task?.toUpperCase() === tid) : null; return d ? { vault: t.vault ?? profile.vault, id: d.id } : null; };
  const sheetView = sheetTask && <TaskSheet key={sheetTask.id} task={sheetTask} gone={sheetGone} here={here} nodeName={nodeName} room={roomOfNode(sheetTask.node) ?? target} roomNamed={(n) => rooms.find((r) => r.name.replace(/^#/, "").toLowerCase() === n.replace(/^#/, "").toLowerCase()) ?? null} inRoom={target?.id} onClose={closeSheet}
    draft={draftOf(sheetTask)} confirmation={confirm.of(sheetTask)} onRecheckRoom={confirm.retry}
    onAct={(t, a) => tasks.act(t, a, { sheet: true })} onDecide={(t, o) => tasks.decide(t, o)} onNote={actions.openNote} onOpenRoom={openRoomHere} onSay={chat ? sayIn : undefined} onPriority={(t, p) => void tasks.setPriority(t, p)} onStale={tasks.refresh} />;
  /** r20: a row's area when it is shown outside it (Uni's list holds every area's): its subtitle names it when its title can't say where it is. */
  const placeOf = (t: Task) => (t.node !== here ? nodeName(t.node) : null);
  const companionProps: CompanionProps = { stands, ready: tasks.ready && privacyKnown, load, feed: panel, rest: panel.rest, moreTitle: privateNote(panel.privateCount), onPrivate: openPrivate, runs, nodeName: node.name, scope: borrowed ? node.name : null, onTask: openSheet, onRun: openRun, scopeAll: isRoot, onNote: actions.openNote, onDecide: decide, placeOf, onEverything: () => { closeSheet(); setWork(true); } };
  const placeholder = chatPlaceholder({ name: node.name, slash: nodeView.own ? nodeView.slash : null, heldBy: nodeView.heldBy ? nodeView.heldBy.name : null });
  // ------------------------------------------------------------------------------------------ the work view (r13)
  const mineLive = isMine;
  const othersHere = levelTasks.filter((t) => !mineLive(t) && !hidden(t.node)).map((t) => ({ task: t, meta: [stateLine(t, (w) => isMe(w), ownerLabel), isMe(t.owner) ? null : `with ${ownerLabel(t.owner)}`, t.node !== here ? `in ${nodeName(t.node)}` : null].filter(Boolean).join(" · ") }));
  const later = levelTasks.filter((t) => mineLive(t) && t.kind !== "decision" && priorityOf(t) === "someday" && !hidden(t.node));
  // r19: everything in another private area that isn't in its "N for you" line (a record to tidy there included)
  const privateOther = levelTasks.filter((t) => hidden(t.node) && !needsYou(t)).length;
  /** No room to talk in (none found once the rooms are in): the work view is the room's view, with no chat to go back to. */
  const noRoom = chat && !target && !roomsPending && !thread;
  // r18: the work view says where this stands with the companion's own sentence, heading and date ("Where this stands · 2 days ago"), one
  // timestamp source (`stands_at`, else the newest change it names); the brief's separate "updated 16h ago" is gone
  const top = (stands || askRoom) ? <div className="wv-top">
    {stands && <><h3 className="cp-h wv-stands-h">{standsHeading(borrowed ? node.name : null, stands.ago, "asOf" in stands ? stands.asOf : null)}</h3><Stands stands={stands} className="th-lede wv-brief" /></>}
    {askRoom && <p className="th-fresh wv-fresh"><button type="button" className="th-link" onClick={() => actions.compose(askRoom, refreshDraft(node.name, isRoot ? "" : node.path))}>Ask Uni to update this summary</button></p>}
  </div> : null;
  const foot = node.kind === "project" && body ? <details className="th-note wv-note"><summary>Project note</summary><Body body={body} mentions={[]} me={null} /></details> : null;
  const workMain = <WorkView nodeName={node.name} feed={feed} others={othersHere} later={later} runs={runs} drafts={drafts} privateOther={privateOther} ready={tasks.ready && privacyKnown} load={load} activity={tasks.activity}
    onTask={openSheet} onRun={openRun} scopeAll={isRoot} onDecide={decide} onNote={actions.openNote} onPrivate={openPrivate} placeOf={placeOf} top={top} foot={foot} />;
  const workOpen = work || !chat || noRoom;
  const workBar = workOpen ? <div className="sr-thread sr-workbar">{chat && !noRoom && <button type="button" className="sr-thread-back sr-work-back" onClick={() => setWork(false)}><span aria-hidden="true">‹</span> Back to chat</button>}
    <span className="sr-thread-label">{`All of ${node.name}'s work`}</span></div> : null;
  const crumbs = !isRoot ? <Crumbs trail={trailItems} onOpen={openPath} compact={!wide} /> : null;
  /** The room's channel, once (r14): its own (`#cohere`). */
  const door = !chat ? "" : nodeView.own && nodeView.slash ? `#${nodeView.slash.replace(/^#/, "")}` : "";
  // the area's app, when open, is the view in the chat's place (r14); otherwise the work view when it is open, else the conversation
  const roomLevel = (app: AppView | null, openApp: ((e: React.MouseEvent) => void) | null) => shell({ title: node.name, door, context: app || workOpen ? undefined : context, node: node.name, crumbs,
    companion: chat ? companionProps : null, chatRoom: thread ? roomFor(thread.channel, thread.root) : roomFor(target?.id), placeholder, selected: node.path, sheet: sheetView, retryChat: target?.id ? () => actions.openRoom(target.id) : actions.retryRooms ?? null,
    main: app ? app.main : workOpen ? workMain : undefined, workBar: app ? app.bar : workBar, openApp, appOpen: !!app });
  return <AreaView key={node.id} area={body !== null ? { ...node, body } : node} mode={mode} roomName={roomName} actions={appActions}
    room={roomFor(nodeRoom)} open={appOpen} onOpen={setAppOpen} render={(app, openApp) => frame(<>{status}{roomLevel(app, openApp)}</>)} />;
}
