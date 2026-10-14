import { useEffect, useMemo, useState, type ReactNode } from "react";
import { TaskList, TaskSheet, UndoBar } from "./NodeWork";
import { useTasks } from "./useTasks";
import { MovedBlock, NeedsYou, WhereCounts } from "./WhereWeAre";
import { DraftSection, RunSection } from "./SteerPage";
import { draftsUnder, runsUnder, type Mark } from "./steerCore";
import { CompanionSide, CompanionStrip, useCompanionOpen, type CompanionProps, type TaskLoad } from "./Companion";
import { chatPlaceholder, needsByNode, needsYou, standsLine, topNeeds, uniNeeds } from "./simpleCore";
import { whereWeAre } from "./whereCore";
import { ownRoom, type Steward } from "./talkCore";
import type { Area } from "./areasCore";
import { groupOf, tasksUnder, type Task, type TaskNode } from "./taskCore";
import { rootNeeds, type RoomInfo } from "./TodayView";
import { rolledMark } from "./nodeMap";
import { refreshDraft, updatedLabel } from "./briefCore";
import AreaView, { type AreaActions } from "./AreaView";
import type { AreaRoom } from "./AreaChat";
import { currentUserAgent, gateMode, platformName } from "../interface/selftest/gate";
import { useAppVersion, useWebviewRuntime } from "../interface/selftest/useAppVersion";
import { projectBody } from "./projectBody";
import { useAreas } from "./useAreas";
import { pickRoom } from "./areaLayout";
import { childrenOf, parentPath, ROOT, rootNode, trail, UNI_CHANNEL } from "./treeCore";
import { findUniRoom } from "../uniActions";
import { useStoredSelfTest } from "../interface/selftest/useSelfTest";
import { useWide } from "./homeLayout";
import { isPrivateNode, roomSlug, roomView, treeRows, updatesBelow, type RoomView } from "./treeRooms";
import { levelAlive } from "./treeAlive";
import { publishRoomNodes, roomNodeMap } from "./roomLabels";
import { useNav } from "../navContext";
import { useVaultProfile } from "./ProfileContext";
import { AliveBlock, Crumbs, InsideBlock, LevelPanel, ProjectNote, RoomLine, RoomSidebar, TreeScreen, UpdatesBlock, type InsideKid } from "./TreeHome";
import { rootOpenMemory } from "./rootMemory";
import "./areas.css";
import "./tree.css";

const USER_AGENT = currentUserAgent();
const PLATFORM = platformName(USER_AGENT);

/** The note for a room no node owns: the companion says so instead of a node's state. */
export const UNFILED = "Not filed under an area yet.";

/**
 * The room shell: Uni itself at `{kind:"areas"}` (path null), any area or project under it at `{kind:"area", path}`, a room no node owns
 * (`loose`, listed under "Other rooms") and a thread of any of them. One component for all: the tree, the conversation, the companion.
 */
export default function AreasSurface({ identity, path, loose = null, thread = null, rooms: hostRooms, roomsPending = false, actions, roomFor, onRoom, onOpenArea, onBackChange }: {
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
}) {
  // chat.provider null: no Buzz on this surface. No rooms are known here, so nothing resolves a steward, loads messages or opens a room.
  const chat = useVaultProfile().chat.provider === "buzz";
  const rooms = useMemo<RoomInfo[]>(() => (chat ? hostRooms : []), [chat, hostRooms]);
  const { data, error, loading, signingIn } = useAreas(identity);
  const nav = useNav();
  const wide = useWide();
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
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    setBody(null);
    if (!identity || node?.kind !== "project") return;
    let live = true;
    projectBody(identity, node).then((text) => { if (live) setBody(text); }).catch(() => {});
    return () => { live = false; };
  }, [identity, node?.id, node?.updatedAt]);
  const [sheet, setSheet] = useState<Task | null>(null);
  /** A room opens to its conversation; "Everything here" (the companion's link) shows the full node page instead. */
  const [full, setFull] = useState(false);
  const toTree = () => { setRootOpen(false); onOpenArea(null, "Uni", uniRoom); };
  const back = loose ? (phoneTree ? toTree : null) : path ? (phoneTree ? () => { setRootOpen(false); onOpenArea(null, "Uni", uniRoom); } : () => {
    const up = data ? data.tree.nodes.get(parentPath(data.tree, path)) : null;
    onOpenArea(up?.path ?? null, up?.name ?? "Uni", up ? pickRoom(withRoom(up).rooms, null) : uniRoom);
  }) : phoneTree && rootOpen ? () => setRootOpen(false) : null;
  useEffect(() => {
    // Android Back closes an open task sheet before it zooms out a level.
    onBackChange(sheet ? () => setSheet(null) : full ? () => setFull(false) : back);
    return () => onBackChange(null);
  }, [path, loose, data, uniRoom, onOpenArea, onBackChange, sheet, phoneTree, rootOpen, full]); // eslint-disable-line react-hooks/exhaustive-deps
  // A node can have several rooms (metadata.channel is a list): the user's pick, else the first.
  const [picked, setPicked] = useState<string | null>(null);
  const nodeRoom = node ? pickRoom(node.rooms, picked) : null;
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
  /** A room's dot is its OWN node's needs-you items (T-124 r2): a parent never lights up for what its children need. The whole tree's tasks are
   *  loaded, so they can be counted per node, by the companion's own rule (r12: Now, Soon and decisions; never Someday). */
  const ownNeeds = useMemo(() => needsByNode(tasks.tasks), [tasks.tasks]);
  /** The task list's health, for the companion and the tree. */
  const load: TaskLoad = { error: tasks.error, refreshing: tasks.refreshing, lastOk: tasks.lastOk, complete: tasks.complete, retry: tasks.refresh };
  // opening a room anywhere opens its node's one view
  // with the areas unreadable (an error, not a load still under way) only Uni's room is known to be owned: every other room stays reachable as "Other rooms"
  const owned = useMemo(() => (!chat ? null : data ? roomNodeMap(data.tree, roomRefs, uniRef) : error && !loading ? new Map(uniRef ? [[uniRef.id, { name: "Uni", path: ROOT }]] : []) : null), [data, chat, error, loading, roomRefs, uniRef]);
  useEffect(() => { if (owned) publishRoomNodes(owned); }, [owned]);
  /** "Other rooms": every room no node owns (not Uni's), by name. Known only once the tree is: before that, nothing is listed as unfiled. */
  const others = useMemo(() => (owned ? roomRefs.filter((r) => !owned.has(r.id) && r.id !== uniRoom).sort((a, b) => a.name.localeCompare(b.name)) : []), [owned, roomRefs, uniRoom]);
  // Opening a room re-reads the tasks if the copy is more than a few seconds old (the needs-you feed must not show what is already done).
  useEffect(() => { tasks.refreshIfStale(); }, [node?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSheet(null); setFull(false); }, [node?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  const noMarks = useMemo(() => new Map<string, Mark[]>(), []);
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
    if (p === ROOT) { setRootOpen(true); onOpenArea(null, "Uni", uniRoom); return; }
    const n = data?.tree.nodes.get(p); if (n) open(n);
  };
  const navRows = data ? treeRows(data.tree, roomRefs, uniRef) : [{ path: ROOT, name: "Uni", depth: 0, kind: "root" as const, slash: uniRef ? "uni" : null, heldBy: null, heldNode: null, own: !!uniRef, trunk: [], last: true }];
  const navNeeds = new Map(navRows.map((r) => [r.path, ownNeeds.get(r.path) ?? 0]));
  const treeProps = { chat, rows: navRows, needs: navNeeds, onOpen: openPath, others, onOpenRoom: actions.openRoom, load, needsReady: tasks.ready };
  /**
   * The room itself: a header (title, the room's own name, where it sits), the conversation, and the companion beside it (wide) or as a
   * strip above it (phone). A thread shows inside it, with a way back to the room.
   */
  const shell = (o: { title: string; door: string; crumbs: ReactNode; back: (() => void) | null; companion: CompanionProps; chatRoom: AreaRoom | null; placeholder: string; selected?: string; selectedRoom?: string; sheet: ReactNode }) => {
    const replies = thread && o.chatRoom?.loaded ? o.chatRoom.messages.filter((m) => m.ref !== thread.root).length : null;
    return <div className={`tree-home th-level ${wide ? "wide" : "phone"} th-rooms th-simple ${wide && !companionOpen ? "folded" : ""}`} data-layout="rooms" data-view={thread ? "thread" : "room"}>
      {wide && <RoomSidebar {...treeProps} selected={o.selected} selectedRoom={o.selectedRoom} nav={nav} />}
      <section className="sr" aria-label={`Conversation: ${o.title}`}>
        <header className="sr-head">
          {!wide && <button type="button" className="sr-back" onClick={() => (o.back ? o.back() : undefined)} aria-label="Back to rooms"><span aria-hidden="true">‹</span></button>}
          <div className="sr-titles">
            {(o.door || o.crumbs) && <div className="sr-meta">{o.crumbs}{o.door && <span className="sr-door">{o.door}</span>}</div>}
            <h1 className="sr-title">{o.title}</h1>
          </div>
        </header>
        {thread && <div className="sr-thread"><button type="button" className="sr-thread-back" onClick={() => actions.openRoom(thread.channel)}><span aria-hidden="true">‹</span> Back to the room</button>
          <span className="sr-thread-label">Thread{replies !== null ? ` · ${replies} ${replies === 1 ? "reply" : "replies"}` : ""}</span></div>}
        {!wide && <CompanionStrip {...o.companion} open={companionOpen} onToggle={setCompanionOpen} />}
        <div className="sr-chat">{o.chatRoom ? o.chatRoom.render(null, o.placeholder) : <p className="th-quiet" role="status">Opening the room…</p>}</div>
      </section>
      {wide && <CompanionSide {...o.companion} open={companionOpen} onToggle={setCompanionOpen} />}
      <UndoBar undo={tasks.undo} notice={tasks.notice} onDismiss={tasks.dismissNotice} />
      {o.sheet}
    </div>;
  };
  /** The frame the app tab's host gives a node's page (AreaView), for a room no node owns. */
  const frame = (inner: ReactNode) => <div className="area-view tree-page"><div className="area-split mode-hidden"><div className="area-main"><div className="area-stage">{inner}</div></div></div></div>;
  if (loose) {
    const info = rooms.find((r) => r.id === loose);
    const title = info ? `#${roomSlug(info.name)}` : "Room";
    const companion: CompanionProps = { stands: null, ready: !!data, note: data ? UNFILED : null, needs: [], runs: [], nodeName: title, onTask: () => {}, onNote: actions.openNote, onDecide: () => {}, onEverything: null };
    return frame(shell({ title, door: "", crumbs: null, back, companion, chatRoom: roomFor(loose, thread?.root ?? null), placeholder: `Message ${title}`, selectedRoom: loose, sheet: null }));
  }
  if (!node) return <div className="areas-home"><button className="note-back" onClick={toUni}><span className="note-back-arrow" aria-hidden="true">←</span><span className="note-back-label">Uni</span></button>
    <p className="empty">{signingIn ? "Signing in…" : loading ? "Opening area…" : error ? `Couldn't load: ${error}` : "This area no longer exists."}</p></div>;
  const isRoot = node.path === ROOT;
  const tree = data?.tree;
  const kids = tree ? childrenOf(tree, node.path) : [];
  const status = <>
    {signingIn && !data && <p className="areas-status" role="status">Signing in…</p>}
    {data?.stale && <p className="areas-status" role="status">{error ? `Saved copy${data.savedAt ? ` from ${new Date(data.savedAt).toLocaleString()}` : ""} · couldn't refresh: ${error}` : "Saved copy · refreshing…"}</p>}
    {!data && error && <p className="note-error" role="alert">Couldn't load areas: {error}</p>}
    {!!data?.truncated.length && <p className="areas-status" role="status">{data.truncated.join(", ")}: showing first 200 notes; more may exist.</p>}
  </>;
  const empty = isRoot && !kids.length && !error ? <p className="empty">{signingIn ? "Signing in…" : loading ? "Loading areas…" : "No areas yet. Tag a note `area` at Areas/<Name>."}</p> : null;
  const today = data?.today;
  const entry = data?.briefs[node.path] ?? null;
  const freshIso = isRoot ? (today ? today.generatedAt ?? today.updatedAt : null) : entry ? entry.generatedAt ?? entry.updatedAt : null;
  const stewardView: Steward = isRoot ? { room: uniRef, via: "own", from: null } : stewardOf(node.path);
  const target = stewardView.room;
  const nodeName = (p: string) => data?.tree.nodes.get(p)?.name ?? p.split("/").pop() ?? p;
  const here = isRoot ? "" : node.path;
  const nowSec = Math.floor(now / 1000);
  const rowOf = (p: string): RoomView => (tree ? roomView(tree, p, roomRefs, uniRef) : { target: uniRef, slash: null, heldBy: uniRef, own: false, heldNode: null });
  const openOf = (p: string) => tasks.counts.get(p)?.total ?? 0;
  if (phoneTree && path === null && !rootOpen) {
    return <div className="areas-home tree-home-wrap"><TreeScreen {...treeProps} status={status} />
      <UndoBar undo={tasks.undo} notice={tasks.notice} onDismiss={tasks.dismissNotice} /></div>;
  }
  const mark = tree && data ? rolledMark(tree, data.briefs, node.path) : "quiet";
  const insideKids: InsideKid[] = tree && data ? kids.map((k) => ({ node: k, mark: rolledMark(tree, data.briefs, k.path), view: rowOf(k.path), needs: ownNeeds.get(k.path) ?? 0, open: openOf(k.path) })) : [];
  const nodeView = rowOf(node.path);
  const askRoom = target?.id ?? null;
  const rootLines = isRoot ? rootNeeds(data, now).map((n) => ({ text: n.text, tokens: n.tokens, ...(n.area ? { note: n.area } : {}) })) : [];
  const levelA = tree && data ? levelAlive({ tree, path: node.path, node, entry, briefs: data.briefs, tasks: levelTasks,
    root: isRoot ? { needs: rootLines, moved: today?.today.moved ?? [], areas: kids.length, needing: new Set(rootLines.map((l) => l.note).filter(Boolean)).size } : null }) : { now: "", nowTokens: null, needs: [], moving: [], derived: false, hasBrief: false };
  const updates = tree && chat ? updatesBelow(tree, node.path, rooms, uniRef, nowSec) : [];
  const trailItems = [{ path: ROOT, name: "Uni" }, ...(tree && !isRoot ? trail(tree, node.path) : isRoot ? [] : [node]).map((n) => ({ path: n.path, name: n.name }))];
  const insideTitle = isRoot ? "Areas" : node.kind === "area" ? "Projects" : "Inside";
  const privateLevel = !!tree && isPrivateNode(tree, node.path);
  const where = whereWeAre({ tasks: levelTasks, hidden: (p) => !!tree && isPrivateNode(tree, p), selfPrivate: privateLevel, nowMs: now });
  const taskTree = tasks.tree;
  /** A private node's words are never shown in a new place: no runs or drafts from it, and none at all on a private level. */
  const named = (p: string) => !privateLevel && !(tree && isPrivateNode(tree, p));
  const runs = taskTree ? runsUnder(taskTree, here, tasks.runs).filter((r) => named(r.node)) : [];
  const drafts = taskTree ? draftsUnder(taskTree, here, tasks.drafts).filter((d) => named(d.node)) : [];
  const otherWork = privateLevel ? levelTasks : levelTasks.filter((t) => groupOf(t) !== "you");
  /** From the full page, the room is the conversation: "Open #room" goes back to it. A room other than this page's still opens as a tab. */
  const openRoomHere = (id: string) => { if (chat && id === target?.id) { setSheet(null); setFull(false); } else actions.openRoom(id); };
  const nowMs = now;
  const headState = <>
    <WhereCounts where={where} ready={tasks.ready} />
    <AliveBlock alive={{ ...levelA, needs: [], moving: [] }} kind={node.kind} onNote={actions.openNote} fresh={updatedLabel(freshIso, now)} onRefresh={askRoom ? () => actions.compose(askRoom, refreshDraft(node.name, isRoot ? "" : node.path)) : null} />
  </>;
  const sections = <div className="sp-cols">
    <div className="sp-col sp-left">
      <NeedsYou where={where} here={here} nodeName={nodeName} leaving={tasks.leaving} marks={noMarks} nowMs={nowMs}
        onOpen={setSheet} onAct={(t, a) => void tasks.act(t, a)} onDecide={decide} onPriority={(t, p) => void tasks.setPriority(t, p)} />
      <MovedBlock where={where} here={here} nodeName={nodeName} nowMs={nowMs} onOpen={setSheet} />
      <UpdatesBlock updates={updates} nowSec={nowSec} onOpen={openPath} />
      <InsideBlock chat={chat} title={insideTitle} kids={insideKids} onOpen={open} />
      {empty}
    </div>
    <div className="sp-col sp-right">
      <RunSection runs={runs} nowMs={nowMs} onOpenNote={actions.openNote} />
      <DraftSection drafts={drafts} marks={noMarks} nowMs={nowMs} onOpenNote={actions.openNote} />
      <TaskList title="Tasks" tasks={otherWork} marks={noMarks} nowMs={nowMs} leaving={tasks.leaving} here={here} nodeName={nodeName} loading={tasks.loading} ready={tasks.ready} error={tasks.error} truncated={tasks.truncated} treeTruncated={tasks.treeTruncated}
        onOpen={setSheet} onAct={(t, a) => void tasks.act(t, a)} onDecide={decide} onRetry={tasks.refresh} />
      <ProjectNote area={body !== null ? { ...node, body } : node} />
    </div>
  </div>;
  const phoneHead = <header className="th-head phone">
    <div className="th-toprow">
      <button type="button" className="th-back" onClick={() => (back ? back() : undefined)} aria-label="Back to the room tree"><span aria-hidden="true">‹</span> Rooms</button>
      <Crumbs trail={trailItems} onOpen={openPath} />
    </div>
    <p className="th-cap">{node.kind === "project" ? "Project" : isRoot ? new Date(now).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "Area"} {mark !== "quiet" && <span className="th-state" data-st={mark}>{mark === "needs" ? "needs you" : "moving"}</span>}</p>
    <h1 className="note-title">{node.name}</h1>
    {chat && <RoomLine view={nodeView} target={target} onOpenRoom={openRoomHere} context />}
    {headState}
  </header>;
  const wideHead = <header className="th-head wide">
    <Crumbs trail={trailItems} onOpen={openPath} />
    <h1 className="note-title">{node.name}</h1>
    {chat && <RoomLine view={nodeView} target={target} onOpenRoom={openRoomHere} context />}
    {headState}
  </header>;
  const sheetView = sheet && <TaskSheet key={sheet.id} task={sheet} here={here} nodeName={nodeName} room={roomOfNode(sheet.node) ?? target} inRoom={target?.id} onClose={() => setSheet(null)}
    onAct={(t, a) => void tasks.act(t, a)} onDecide={decide} onNote={actions.openNote} onOpenRoom={openRoomHere} />;
  const fullLevel = <div className={`tree-home th-level ${wide ? "wide" : "phone"} th-rooms`} data-layout="rooms">
    {wide && <RoomSidebar {...treeProps} selected={node.path} nav={nav} />}
    <LevelPanel wide={wide} head={wide ? wideHead : phoneHead} foot={<UndoBar undo={tasks.undo} notice={tasks.notice} onDismiss={tasks.dismissNotice} />}>{sections}</LevelPanel>
    {sheetView}
  </div>;
  // ------------------------------------------------------------------------------------------ the room (T-124): the conversation, with the state as a quiet companion
  // the companion's list, by the same rule as the dots; Uni's own panel keeps to Uni's own items and the three most urgent from the areas
  const needAll = topNeeds(where, node.path);
  const needTop = isRoot ? uniNeeds(needAll) : needAll;
  /** Items here that need you but sit in a private area (never named here): counted, so the list never reads as all there is. */
  const privateNeeds = Math.max(0, levelTasks.filter(needsYou).length - needAll.length);
  const rawStands = tasks.tree?.stands.get(node.path) ?? (typeof node.metadata.stands === "string" ? { text: node.metadata.stands, at: typeof node.metadata.stands_at === "string" ? node.metadata.stands_at : null } : null);
  const stands = standsLine(rawStands, privateLevel ? [] : levelTasks, now);
  const companionProps: CompanionProps = { stands, ready: tasks.ready, load, hidden: privateNeeds, needs: needTop, runs, nodeName: node.name, onTask: setSheet, onNote: actions.openNote, onDecide: decide, onEverything: () => { setSheet(null); setFull(true); } };
  const placeholder = chatPlaceholder({ name: node.name, slash: nodeView.own ? nodeView.slash : null, heldBy: nodeView.heldBy ? roomSlug(nodeView.heldBy.name) : null });
  const roomLevel = shell({ title: node.name, door: nodeView.own && nodeView.slash ? `#${nodeView.slash}` : "", crumbs: wide && !isRoot ? <Crumbs trail={trailItems} onOpen={openPath} /> : null, back,
    companion: companionProps, chatRoom: thread ? roomFor(thread.channel, thread.root) : roomFor(target?.id), placeholder, selected: node.path, sheet: sheetView });
  const level = chat && (target || roomsPending || thread) && !full ? roomLevel : fullLevel;
  return <AreaView key={node.id} area={body !== null ? { ...node, body } : node} channel={nodeRoom} onChannel={setPicked} mode={mode} roomName={roomName} actions={actions}
    room={roomFor(nodeRoom)} onBack={back} backLabel={tree?.nodes.get(parentPath(tree, node.path))?.name ?? "Uni"} tree={<>{status}{level}</>} />;
}
