import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TaskSheet, UndoBar, ownerLabel } from "./NodeWork";
import { useTasks } from "./useTasks";
import { draftsUnder, runsUnder } from "./steerCore";
import { CompanionSide, CompanionStrip, useCompanionOpen, type CompanionProps, type TaskLoad } from "./Companion";
import { chatPlaceholder, needsByRow, needsFeed, standsLine, stateLine, uniPanel, type PrivateNeed } from "./simpleCore";
import { ownRoom, type Steward } from "./talkCore";
import type { Area } from "./areasCore";
import { groupOf, isMe, priorityOf, tasksUnder, type Task, type TaskNode } from "./taskCore";
import type { RoomInfo } from "./TodayView";
import { refreshDraft, updatedLabel } from "./briefCore";
import AreaView, { type AppView, type AreaActions } from "./AreaView";
import type { AreaRoom } from "./AreaChat";
import { currentUserAgent, gateMode, platformName } from "../interface/selftest/gate";
import { useAppVersion, useWebviewRuntime } from "../interface/selftest/useAppVersion";
import { useAreas } from "./useAreas";
import { pickRoom } from "./areaLayout";
import { childrenOf, parentPath, ROOT, rootNode, trail, UNI_CHANNEL } from "./treeCore";
import { findUniRoom } from "../uniActions";
import { useStoredSelfTest } from "../interface/selftest/useSelfTest";
import { useRailHidden, useWide } from "./homeLayout";
import { isPrivateNode, privateRoot, roomSlug, roomView, treeRows } from "./treeRooms";
import { publishRoomNodes, roomNodeMap } from "./roomLabels";
import { useNav, type NavControls } from "../navContext";
import { useVaultProfile } from "./ProfileContext";
import { Crumbs, RoomSidebar, TreeScreen } from "./TreeHome";
import { WorkView } from "./WorkView";
import { LoadHealth } from "./LoadHealth";
import { InlineText } from "./InlineText";
import { Body } from "../MessageBody";
import { projectBody } from "./projectBody";
import { rootOpenMemory } from "./rootMemory";
import "./areas.css";
import "./tree.css";

const USER_AGENT = currentUserAgent();
const PLATFORM = platformName(USER_AGENT);

/** The note for a room no node owns: the companion says so instead of a node's state. */
export const UNFILED = "Not filed under an area yet.";

/**
 * What is open over the place (the task sheet, the work view, the drawer): Android Back closes it first. `modal` (the sheet) holds Alt+arrow
 * history while open; `history` says Alt+← and the sidebar's ← close it before they change places (the work view; not the drawer alone,
 * whose own Back button goes back).
 */
export type Overlay = { close: () => void; modal: boolean; history: boolean };

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
  rooms: RoomInfo[]; actions: AreaActions;
  /** The rooms list has not arrived yet (a fresh start): a room place waits for it instead of showing a page with "no room". */
  roomsPending?: boolean;
  /** The host's room view for a room id (or one of its threads, by root): its messages and composer, when that is the one loaded. */
  roomFor: (id: string | null | undefined, threadRoot?: string | null) => AreaRoom | null;
  /** The open node's room (null: none), so the host can load it. */
  onRoom: (id: string | null) => void;
  /** Open a node (path null: Uni) in this tab. */
  onOpenArea: (areaPath: string | null, name: string, room: string | null) => void;
  onBackChange: (back: (() => void) | null) => void;
  /** What is open over the place, so the host's Back (Alt+←, the sidebar's ←) closes it before it changes places. */
  onOverlayChange?: (o: Overlay | null) => void;
}) {
  // chat.provider null: no Buzz on this surface. No rooms are known here, so nothing resolves a steward, loads messages or opens a room.
  const chat = useVaultProfile().chat.provider === "buzz";
  const rooms = useMemo<RoomInfo[]>(() => (chat ? hostRooms : []), [chat, hostRooms]);
  const { data, error, loading, signingIn } = useAreas(identity);
  const nav = useNav();
  const wide = useWide();
  /** One rule for global navigation (r14): Places (the drawer) shows whenever the rail is hidden, and below 900px where the tree is. */
  const railHidden = useRailHidden();
  const placesDrawer = !wide || railHidden;
  /** The companion beside (wide) or above (phone) the conversation: open or folded, remembered per device. */
  const [companionOpen, setCompanionOpen] = useCompanionOpen(wide ? "side" : "strip");
  /** Phone: the room tree is the home and a level opens from it; Uni's own level is one tap on its row. */
  const [rootOpen, setRootOpenState] = useState(rootOpenMemory.open);
  const setRootOpen = (v: boolean) => { rootOpenMemory.open = v; setRootOpenState(v); };
  const phoneTree = !wide;
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
  const closeSheet = () => setSheetId(null);
  /** "All of X's work": a view inside the shell, over the chat; Back (every kind) closes it first. Without chat it is the room's only view. */
  const [work, setWork] = useState(false);
  /** Below 900px: the tree, Back/Forward, Recent and the app's places, in a drawer opened from the room's header. */
  const [drawer, setDrawer] = useState(false);
  /** The area's app, as a view inside the shell (r14): Back (every kind) closes it, like the work view. */
  const [appOpen, setAppOpen] = useState(false);
  const toTree = () => { setRootOpen(false); onOpenArea(null, "Uni", uniRoom); };
  const back = loose ? (phoneTree ? toTree : null) : path ? (phoneTree ? toTree : () => {
    const up = data ? data.tree.nodes.get(parentPath(data.tree, path)) : null;
    onOpenArea(up?.path ?? null, up?.name ?? "Uni", up ? pickRoom(withRoom(up).rooms, null) : uniRoom);
  }) : phoneTree && rootOpen ? () => setRootOpen(false) : null;
  /** What is over the place, top first: the sheet (modal), then the drawer, then the work view (only when the chat is there to go back to). */
  const workOver = work && chat;
  // the drawer is closed by every Back first (r14), its own Back button excepted (that one goes back a place as it closes)
  const overlay: Overlay | null = sheetId ? { close: closeSheet, modal: true, history: false }
    : drawer ? { close: () => setDrawer(false), modal: false, history: true }
    : appOpen ? { close: () => setAppOpen(false), modal: false, history: true }
    : workOver ? { close: () => setWork(false), modal: false, history: true } : null;
  const overlayKey = `${sheetId ? "sheet" : ""}${drawer ? "drawer" : ""}${appOpen ? "app" : ""}${workOver ? "work" : ""}`;
  useEffect(() => {
    // Android Back closes what is over the place before it zooms out a level.
    onBackChange(sheetId ? closeSheet : drawer ? () => setDrawer(false) : appOpen ? () => setAppOpen(false) : workOver ? () => setWork(false) : back);
    return () => onBackChange(null);
  }, [path, loose, data, uniRoom, onOpenArea, onBackChange, overlayKey, phoneTree, rootOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
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
    const box = drawerBox.current; const wrap = box?.closest(".th-drawer-wrap");
    if (!box || !wrap) return;
    const marked: Element[] = [];
    for (let el: Element | null = wrap; el && el !== document.body; el = el.parentElement) {
      for (const sib of el.parentElement?.children ?? []) if (sib !== el && !sib.hasAttribute("inert")) { sib.setAttribute("inert", ""); marked.push(sib); }
    }
    (box.querySelector<HTMLElement>(".th-place, button:not(:disabled)") ?? box).focus();
    const opener = drawerOpener.current;
    return () => { for (const m of marked) m.removeAttribute("inert"); const at = document.activeElement; if (opener?.isConnected && (!at || at === document.body)) opener.focus(); };
  }, [drawer]);
  const trapDrawer = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const f = [...drawerBox.current!.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], [tabindex='0']")];
    if (!f.length) return;
    if (e.shiftKey && (document.activeElement === f[0] || document.activeElement === drawerBox.current)) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  };
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
  useEffect(() => { if (node && !thread) onRoom(hostRoom); }, [node?.id, hostRoom, !thread]); // eslint-disable-line react-hooks/exhaustive-deps
  const roomName = useMemo(() => (id: string) => rooms.find((r) => r.id === id)?.name ?? "room", [rooms]);
  const now = Date.now();
  const fallback = useMemo<TaskNode[]>(() => (data?.areas ?? []).map((a) => ({ id: a.id, path: a.path, name: a.name, parent: a.parent, room: typeof a.metadata.room === "string" ? a.metadata.room : null, status: a.status === "archived" || a.status === "done" ? a.status : "active", isRoot: false })), [data?.areas]);
  // The whole tree's tasks are loaded once (the room tree beside the room needs every row's dot) and each level takes its subtree.
  const tasks = useTasks(identity, "", fallback);
  const levelTasks = useMemo(() => (tasks.tree && node ? tasksUnder(tasks.tree, node.path, tasks.tasks) : tasks.tasks), [tasks.tree, tasks.tasks, node?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The task list's health, for the companion and the tree. */
  const load: TaskLoad = { error: tasks.error, treeError: tasks.treeError, refreshing: tasks.refreshing, lastOk: tasks.lastOk, complete: tasks.complete, retry: tasks.refresh };
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
  const navNeeds = useMemo(() => needsByRow(tasks.tasks, rowPaths, (p) => tasks.tree?.parent.get(p) ?? data?.tree.parent.get(p)), [tasks.tasks, rowPaths, tasks.tree, data?.tree]);
  const openRoomFromTree = (id: string) => { setDrawer(false); actions.openRoom(id); };
  const treeProps = { chat, rows: navRows, needs: navNeeds, onOpen: openPath, others, onOpenRoom: openRoomFromTree, load, needsReady: tasks.ready };
  /** The app's own places (Journal, Vault, Search, Settings), for where the rail is out of reach: the drawer and a short screen's tree. */
  const places = nav?.places ?? [];
  const placesRow = places.length > 0 && <nav className="th-places" aria-label="App">{places.map((p) => <button key={p.label} type="button" className="th-place" onClick={() => { setDrawer(false); p.go(); }}>{p.label}</button>)}</nav>;
  const drawerNav: NavControls | null = nav ? { ...nav, back: () => { setDrawer(false); (nav.backPlace ?? nav.back)(); }, forward: () => { setDrawer(false); nav.forward(); }, recent: nav.recent.map((r) => ({ ...r, go: () => { setDrawer(false); r.go(); } })) } : null;
  /**
   * The room itself: a header (title, the room's own name, where it sits), the conversation, and the companion beside it (wide) or as a
   * strip above it (phone). A thread or the work view shows inside it, with a way back to the room.
   */
  const shell = (o: { title: string; door: string; crumbs: ReactNode; companion: CompanionProps | null; chatRoom: AreaRoom | null; placeholder: string; selected?: string; selectedRoom?: string; sheet: ReactNode; main?: ReactNode; workBar?: ReactNode;
    /** The area's app, opened from the header (r14): it shows as a view in this shell. */
    openApp?: ((e: React.MouseEvent) => void) | null; appOpen?: boolean }) => {
    const replies = thread && o.chatRoom?.loaded ? o.chatRoom.messages.filter((m) => m.ref !== thread.root).length : null;
    const view = o.main ? "work" : thread ? "thread" : "room";
    return <div className={`tree-home th-level ${wide ? "wide" : "phone"} th-rooms th-simple ${wide && (!o.companion || o.main) ? "solo" : wide && !companionOpen ? "folded" : ""}`} data-layout="rooms" data-view={view}>
      {wide && <RoomSidebar {...treeProps} selected={o.selected} selectedRoom={o.selectedRoom} nav={nav} />}
      <section className="sr" aria-label={o.main ? `Work: ${o.title}` : `Conversation: ${o.title}`}>
        <header className="sr-head">
          {placesDrawer && <button ref={drawerOpener} type="button" className="sr-drawer" aria-label="Places" title="Rooms and places" aria-expanded={drawer} aria-controls="th-drawer" onClick={() => setDrawer(true)}><span aria-hidden="true" /></button>}
          <div className="sr-titles">
            {(o.door || o.crumbs) && <div className="sr-meta">{o.crumbs}{o.door && <span className="sr-door">{o.door}</span>}</div>}
            <h1 className="sr-title">{o.title}</h1>
          </div>
          {o.openApp && !o.appOpen && <button type="button" className="sr-app" aria-label={`Open the ${o.title} app`} onClick={o.openApp}>App ›</button>}
        </header>
        {thread && !o.main && <div className="sr-thread"><button type="button" className="sr-thread-back" onClick={() => actions.openRoom(thread.channel)}><span aria-hidden="true">‹</span> Back to the room</button>
          <span className="sr-thread-label">Thread{replies !== null ? ` · ${replies} ${replies === 1 ? "reply" : "replies"}` : ""}</span></div>}
        {o.workBar}
        {/* below 900px the tree (and its health line) is in the drawer: the room says it itself, outside the drawer (r14); the work view has its own */}
        {!wide && o.companion && !o.main && tasks.ready && <LoadHealth load={load} ready className="sr-health" />}
        {!wide && o.companion && !o.main && <CompanionStrip {...o.companion} open={companionOpen} onToggle={setCompanionOpen} />}
        {o.main ? <div className="sr-work">{o.main}</div>
          : <div className="sr-chat">{o.chatRoom ? o.chatRoom.render(null, o.placeholder) : <p className="th-quiet" role="status">Opening the room…</p>}</div>}
      </section>
      {wide && o.companion && !o.main && <CompanionSide {...o.companion} open={companionOpen} onToggle={setCompanionOpen} />}
      {placesDrawer && drawer && <div className="th-drawer-wrap">
        <button type="button" className="th-drawer-scrim" aria-label="Close places" tabIndex={-1} onClick={() => setDrawer(false)} />
        <aside ref={drawerBox} id="th-drawer" className="th-drawer" role="dialog" aria-modal="true" aria-label="Rooms and places" tabIndex={-1} onKeyDown={trapDrawer}>
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
    return frame(shell({ title, door: "", crumbs: null, companion, chatRoom: roomFor(loose, thread?.root ?? null), placeholder: `Message ${title}`, selectedRoom: loose, sheet: null }));
  }
  if (!node) return <div className="areas-home"><button className="note-back" onClick={toUni}><span className="note-back-arrow" aria-hidden="true">←</span><span className="note-back-label">Uni</span></button>
    <p className="empty">{signingIn ? "Signing in…" : loading ? "Opening area…" : error ? `Couldn't load: ${error}` : "This area no longer exists."}</p></div>;
  const isRoot = node.path === ROOT;
  const tree = data?.tree;
  const status = <>
    {signingIn && !data && <p className="areas-status" role="status">Signing in…</p>}
    {data?.stale && <p className="areas-status" role="status">{error ? `Saved copy${data.savedAt ? ` from ${new Date(data.savedAt).toLocaleString()}` : ""} · couldn't refresh: ${error}` : "Saved copy · refreshing…"}</p>}
    {!data && error && <p className="note-error" role="alert">Couldn't load areas: {error}</p>}
    {!!data?.truncated.length && <p className="areas-status" role="status">{data.truncated.join(", ")}: showing first 200 notes; more may exist.</p>}
  </>;
  if (phoneTree && path === null && !rootOpen) {
    return <div className="areas-home tree-home-wrap"><TreeScreen {...treeProps} status={<>{status}{railHidden && places.length > 0 && <div className="th-places-short">{placesRow}</div>}</>} />
      <UndoBar undo={tasks.undo} notice={tasks.notice} onDismiss={tasks.dismissNotice} /></div>;
  }
  const today = data?.today;
  const entry = data?.briefs[node.path] ?? null;
  const freshIso = isRoot ? (today ? today.generatedAt ?? today.updatedAt : null) : entry ? entry.generatedAt ?? entry.updatedAt : null;
  const stewardView: Steward = isRoot ? { room: uniRef, via: "own", from: null } : stewardOf(node.path);
  const target = stewardView.room;
  const nodeName = (p: string) => data?.tree.nodes.get(p)?.name ?? p.split("/").pop() ?? p;
  const here = isRoot ? "" : node.path;
  const rowOf = (p: string) => (tree ? roomView(tree, p, roomRefs, uniRef) : { target: uniRef, slash: null, heldBy: uniRef, own: false, heldNode: null });
  const nodeView = rowOf(node.path);
  const askRoom = target?.id ?? null;
  const trailItems = [{ path: ROOT, name: "Uni" }, ...(tree && !isRoot ? trail(tree, node.path) : isRoot ? [] : [node]).map((n) => ({ path: n.path, name: n.name }))];
  const privateOf = (p: string) => (tree ? privateRoot(tree, p) : null);
  /** The private area this level is, or sits in: Aaron opened it himself, so its own items show as they are (r14). */
  const selfPrivate = tree && isPrivateNode(tree, node.path) ? privateOf(node.path) : null;
  /** A private area's words are never shown outside it: not in Uni's panel, a parent's list, runs, drafts or the stands line. */
  const hidden = (p: string) => { const r = privateOf(p); return !!r && r.path !== selfPrivate?.path; };
  // ------------------------------------------------------------------------------------------ Needs you: one feed, one count (r13)
  const feed = needsFeed(levelTasks, privateOf, selfPrivate);
  const panel = isRoot ? uniPanel(feed) : { ...feed, rest: 0 };
  const taskTree = tasks.tree;
  const runs = taskTree ? runsUnder(taskTree, here, tasks.runs).filter((r) => !hidden(r.node)) : [];
  const drafts = taskTree ? draftsUnder(taskTree, here, tasks.drafts).filter((d) => !hidden(d.node)) : [];
  const openPrivate = (o: PrivateNeed["open"]) => { closeSheet(); setWork(false); openPath(o.path); };
  const rawStands = tasks.tree?.stands.get(node.path) ?? (typeof node.metadata.stands === "string" ? { text: node.metadata.stands, at: typeof node.metadata.stands_at === "string" ? node.metadata.stands_at : null } : null);
  /** A vault with no areas yet: Uni says how to start, in plain words (r13), instead of a tag and a path to type. */
  const noAreas = isRoot && !!tree && !error && childrenOf(tree, ROOT).length === 0;
  const stands = noAreas ? { text: "No areas yet. Tell Uni here what you want to look after, and it will set up your first area.", ago: "" } : standsLine(rawStands, levelTasks.filter((t) => !hidden(t.node)), now);
  /** The room's composer when it is the one here, else that room's (opened, filled in, never sent). */
  const sayIn = (roomId: string, text: string) => { closeSheet(); setWork(false); const here = roomFor(roomId); if (here) here.compose(text); else actions.compose(roomId, text); };
  /** From the work view or the sheet, "Open #room" for this room is the conversation: it goes back to it. Another room opens as a tab. */
  const openRoomHere = (id: string) => { if (chat && id === target?.id) { closeSheet(); setWork(false); } else actions.openRoom(id); };
  const live = sheetId ? tasks.all?.find((t) => t.id === sheetId) ?? null : null;
  if (live) lastSheet.current = live;
  const sheetTask = sheetId ? live ?? (lastSheet.current?.id === sheetId ? lastSheet.current : null) : null;
  const sheetGone = !!sheetId && (!live || !(live.state === "open" || live.state === "doing" || live.state === "waiting") || (tasks.ready && !tasks.tasks.some((t) => t.id === sheetId) && !tasks.leaving.has(sheetId)));
  const sheetView = sheetTask && <TaskSheet key={sheetTask.id} task={sheetTask} gone={sheetGone} here={here} nodeName={nodeName} room={roomOfNode(sheetTask.node) ?? target} inRoom={target?.id} onClose={closeSheet}
    onAct={(t, a) => void tasks.act(t, a)} onDecide={decide} onNote={actions.openNote} onOpenRoom={openRoomHere} onSay={chat ? sayIn : undefined} onPriority={(t, p) => void tasks.setPriority(t, p)} onStale={tasks.refresh} />;
  const companionProps: CompanionProps = { stands, ready: tasks.ready, load, feed: panel, rest: panel.rest, onPrivate: openPrivate, runs, nodeName: node.name, onTask: openSheet, onNote: actions.openNote, onDecide: decide, onEverything: () => { closeSheet(); setWork(true); } };
  const placeholder = chatPlaceholder({ name: node.name, slash: nodeView.own ? nodeView.slash : null, heldBy: nodeView.heldBy ? nodeView.heldBy.name : null });
  // ------------------------------------------------------------------------------------------ the work view (r13)
  const mineLive = (t: Task) => groupOf(t) === "you";
  const othersHere = levelTasks.filter((t) => !mineLive(t) && !hidden(t.node)).map((t) => ({ task: t, meta: [stateLine(t, (w) => isMe(w), ownerLabel), isMe(t.owner) ? null : `with ${ownerLabel(t.owner)}`, t.node !== here ? `in ${nodeName(t.node)}` : null].filter(Boolean).join(" · ") }));
  const later = levelTasks.filter((t) => mineLive(t) && t.kind !== "decision" && priorityOf(t) === "someday" && !hidden(t.node));
  const privateOther = levelTasks.filter((t) => hidden(t.node) && !(mineLive(t) && (t.kind === "decision" || priorityOf(t) !== "someday"))).length;
  const fresh = updatedLabel(freshIso, now);
  /** No room to talk in (none found once the rooms are in): the work view is the room's view, with no chat to go back to. */
  const noRoom = chat && !target && !roomsPending && !thread;
  const briefNow = !isRoot ? entry?.brief.now ?? "" : "";
  const top = (briefNow || fresh || askRoom) ? <div className="wv-top">
    {briefNow && <p className="th-lede wv-brief">{entry!.brief.nowTokens.length ? <InlineText tokens={entry!.brief.nowTokens} onNote={actions.openNote} /> : briefNow}</p>}
    <p className="th-fresh wv-fresh">{fresh && <span>Brief {fresh}</span>}{askRoom && <button type="button" className="th-link" onClick={() => actions.compose(askRoom, refreshDraft(node.name, isRoot ? "" : node.path))}>Refresh the brief</button>}</p>
  </div> : null;
  const foot = node.kind === "project" && body ? <details className="th-note wv-note"><summary>Project note</summary><Body body={body} mentions={[]} me={null} /></details> : null;
  const workMain = <WorkView nodeName={node.name} feed={feed} others={othersHere} later={later} runs={runs} drafts={drafts} privateOther={privateOther} ready={tasks.ready} load={load}
    onTask={openSheet} onDecide={decide} onNote={actions.openNote} onPrivate={openPrivate} top={top} foot={foot} />;
  const workOpen = work || !chat || noRoom;
  const workBar = workOpen ? <div className="sr-thread sr-workbar">{chat && !noRoom && <button type="button" className="sr-thread-back sr-work-back" onClick={() => setWork(false)}><span aria-hidden="true">‹</span> Back to chat</button>}
    <span className="sr-thread-label">{`All of ${node.name}'s work`}</span></div> : null;
  const crumbs = !isRoot ? <Crumbs trail={trailItems} onOpen={openPath} compact={!wide} /> : null;
  /** The room's channel, once (r14): its own (`#cohere`), or the room it borrows, said plainly ("Conversation in #boulder"). */
  const door = !chat ? "" : nodeView.own && nodeView.slash ? `#${nodeView.slash.replace(/^#/, "")}` : nodeView.heldBy && !isRoot ? `Conversation in #${roomSlug(nodeView.heldBy.name)}` : "";
  // the area's app, when open, is the view in the chat's place (r14); otherwise the work view when it is open, else the conversation
  const roomLevel = (app: AppView | null, openApp: ((e: React.MouseEvent) => void) | null) => shell({ title: node.name, door, crumbs,
    companion: chat ? companionProps : null, chatRoom: thread ? roomFor(thread.channel, thread.root) : roomFor(target?.id), placeholder, selected: node.path, sheet: sheetView,
    main: app ? app.main : workOpen ? workMain : undefined, workBar: app ? app.bar : workBar, openApp, appOpen: !!app });
  return <AreaView key={node.id} area={body !== null ? { ...node, body } : node} mode={mode} roomName={roomName} actions={actions}
    room={roomFor(nodeRoom)} open={appOpen} onOpen={setAppOpen} render={(app, openApp) => frame(<>{status}{roomLevel(app, openApp)}</>)} />;
}
