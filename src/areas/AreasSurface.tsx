import { useEffect, useMemo, useState } from "react";
import { RecentMessages, TalkBar, TaskList, TaskSheet, UndoBar, type Talk } from "./NodeWork";
import { useTasks } from "./useTasks";
import { MovedBlock, NeedsYou, WhereCounts } from "./WhereWeAre";
import { DraftSection, RunSection } from "./SteerPage";
import { draftsUnder, runsUnder, type Mark } from "./steerCore";
import { CompanionSide, CompanionStrip, useCompanionOpen } from "./Companion";
import { chatPlaceholder, standsLine, topNeeds } from "./simpleCore";
import { whereWeAre } from "./whereCore";
import { ownRoom, steward, stewardLine, type RoomNode, type Steward } from "./talkCore";
import type { Area } from "./areasCore";
import { groupOf, tasksUnder, type Task, type TaskNode } from "./taskCore";
import { rootNeeds, TodaySections, type RoomInfo } from "./TodayView";
import NodeStage, { type ZoomState, type StageKid } from "./NodeStage";
import { AreaSlot } from "./areaSlots";
import { aliveOf, rolledMark, type Alive } from "./nodeMap";
import { askDraft, refreshDraft, updatedLabel, type Inline } from "./briefCore";
import AreaView, { type AreaActions } from "./AreaView";
import type { AreaRoom } from "./AreaChat";
import { currentUserAgent, gateMode, platformName } from "../interface/selftest/gate";
import { useAppVersion, useWebviewRuntime } from "../interface/selftest/useAppVersion";
import { projectBody } from "./projectBody";
import { useAreas } from "./useAreas";
import { pickRoom } from "./areaLayout";
import { ancestry, childrenOf, parentPath, ROOT, rootNode, trail, UNI_CHANNEL } from "./treeCore";
import { findUniRoom } from "../uniActions";
import { useStoredSelfTest } from "../interface/selftest/useSelfTest";
import { useHomeLayout, useWide } from "./homeLayout";
import { isPrivateNode, roomSlug, roomView, treeRows, updatesBelow, type RoomView } from "./treeRooms";
import { levelAlive } from "./treeAlive";
import { publishRoomNodes, roomNodeMap } from "./roomLabels";
import { useNav } from "../navContext";
import { useVaultProfile } from "./ProfileContext";
import { AliveBlock, Crumbs, InsideBlock, LevelPanel, Ledger, NeedsBlock, ProjectNote, RoomBlock, RoomLine, RoomSidebar, TreeScreen, UpdatesBlock, type InsideKid } from "./TreeHome";
import { rootOpenMemory } from "./rootMemory";
import "./areas.css";
import "./tree.css";

const USER_AGENT = currentUserAgent();
const PLATFORM = platformName(USER_AGENT);

/** The Uni tab: Uni itself at `{kind:"areas"}` (path null), any area or project under it at `{kind:"area", path}`. One page component for all. */
export default function AreasSurface({ zoom, identity, talk, path, rooms: hostRooms, actions, roomFor, onRoom, onOpenArea, onConversations, onBackChange }: {
  zoom: React.RefObject<ZoomState>;
  identity: string | null;
  /** Voice and one-line notes to a room, through the app's own send and voice outbox paths. */
  talk: Talk;
  path: string | null; rooms: RoomInfo[]; actions: AreaActions;
  /** The host's room view for a room id (its messages and composer), when that room is the one loaded. */
  roomFor: (id: string | null | undefined) => AreaRoom | null;
  /** The open node's room (null: none), so the host can load it. */
  onRoom: (id: string | null) => void;
  /** Open a node (path null: Uni) in this tab. */
  onOpenArea: (areaPath: string | null, name: string, room: string | null) => void;
  onConversations: () => void;
  onBackChange: (back: (() => void) | null) => void;
}) {
  // chat.provider null: no Buzz on this surface. No rooms are known here, so nothing resolves a steward, loads messages or opens a room.
  const chat = useVaultProfile().chat.provider === "buzz";
  const rooms = useMemo<RoomInfo[]>(() => (chat ? hostRooms : []), [chat, hostRooms]);
  const { data, error, loading, signingIn } = useAreas(identity);
  const nav = useNav();
  const layout = useHomeLayout();
  const wide = useWide();
  /** The companion beside (wide) or above (phone) the conversation: open or folded, remembered per device. */
  const [companionOpen, setCompanionOpen] = useCompanionOpen(wide ? "side" : "strip");
  /** Rooms (0.1.42): the room tree is the navigation on every screen and the panel opens on "Where we are". Map (`tree`) is the 0.1.41 home. */
  const roomsMode = layout === "rooms";
  const treeMode = layout === "tree" || roomsMode;
  /** Phone: the room tree is the home and a level opens from it; Uni's own level is one tap on its row. */
  const [rootOpen, setRootOpenState] = useState(rootOpenMemory.open);
  const setRootOpen = (v: boolean) => { rootOpenMemory.open = v; setRootOpenState(v); };
  const phoneTree = treeMode && !wide;
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
  const found = path ? data?.tree.nodes.get(path) ?? null : root;
  const node = found ? withRoom(found) : null;
  const [body, setBody] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  useEffect(() => {
    setBody(null); setBodyError(null);
    if (!identity || node?.kind !== "project") return;
    let live = true;
    projectBody(identity, node).then((text) => { if (live) setBody(text); }).catch((e) => { if (live) setBodyError(String(e)); });
    return () => { live = false; };
  }, [identity, node?.id, node?.updatedAt]);
  const [sheet, setSheet] = useState<Task | null>(null);
  /** A room opens to its conversation; "Everything here" (the companion's link) shows the full node page instead. */
  const [full, setFull] = useState(false);
  const back = path ? (phoneTree ? () => { setRootOpen(false); onOpenArea(null, "Uni", uniRoom); } : () => {
    const up = data ? data.tree.nodes.get(parentPath(data.tree, path)) : null;
    onOpenArea(up?.path ?? null, up?.name ?? "Uni", up ? pickRoom(withRoom(up).rooms, null) : uniRoom);
  }) : phoneTree && rootOpen ? () => setRootOpen(false) : null;
  useEffect(() => {
    // Android Back closes an open task sheet before it zooms out a level.
    onBackChange(sheet ? () => setSheet(null) : full ? () => setFull(false) : back);
    return () => onBackChange(null);
  }, [path, data, uniRoom, onOpenArea, onBackChange, sheet, phoneTree, rootOpen, full]); // eslint-disable-line react-hooks/exhaustive-deps
  // A node can have several rooms (metadata.channel is a list): the user's pick, else the first.
  const [picked, setPicked] = useState<string | null>(null);
  const nodeRoom = node ? pickRoom(node.rooms, picked) : null;
  // The tree home talks to the steward's room (a held project's area room), so that is the one the host opens.
  const stewardRoomId = node && data && treeMode ? roomView(data.tree, node.path, roomRefs, uniRef).target?.id ?? null : null;
  const hostRoom = !chat ? null : treeMode ? stewardRoomId ?? (node?.path === ROOT ? uniRoom : null) : nodeRoom;
  useEffect(() => { if (node) onRoom(hostRoom); }, [node?.id, hostRoom]); // eslint-disable-line react-hooks/exhaustive-deps
  const roomName = useMemo(() => (id: string) => rooms.find((r) => r.id === id)?.name ?? "room", [rooms]);
  const now = Date.now();
  const fallback = useMemo<TaskNode[]>(() => (data?.areas ?? []).map((a) => ({ id: a.id, path: a.path, name: a.name, parent: a.parent, room: typeof a.metadata.room === "string" ? a.metadata.room : null, status: a.status === "archived" || a.status === "done" ? a.status : "active", isRoot: false })), [data?.areas]);
  // Rooms: the whole tree's tasks are loaded once (the room tree beside the level needs every row's counts) and each level takes its subtree.
  const tasks = useTasks(identity, roomsMode ? "" : node?.path ?? "", fallback);
  const levelTasks = useMemo(() => (roomsMode && tasks.tree && node ? tasksUnder(tasks.tree, node.path, tasks.tasks) : tasks.tasks), [roomsMode, tasks.tree, tasks.tasks, node?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  /** A room's dot is its OWN node's needs-you items (T-124 r2): a parent never lights up for what its children need. Rooms mode loads the whole tree's tasks, so they can be counted per node. */
  const ownNeeds = useMemo(() => { const m = new Map<string, number>(); for (const t of tasks.tasks) if (groupOf(t) === "you") m.set(t.node, (m.get(t.node) ?? 0) + 1); return m; }, [tasks.tasks]);
  // the rooms drawer names a room as the tree does
  useEffect(() => { if (data && treeMode && chat) publishRoomNodes(roomNodeMap(data.tree, roomRefs, uniRef)); }, [data, treeMode, chat, roomRefs, uniRef]);
  // Opening a room re-reads the tasks if the copy is more than a few seconds old (the needs-you feed must not show what is already done).
  useEffect(() => { tasks.refreshIfStale(); }, [node?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sentTick, setSentTick] = useState(0);
  useEffect(() => { setSheet(null); setFull(false); }, [node?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  const noMarks = useMemo(() => new Map<string, Mark[]>(), []);
  /** Who stewards a node: its own room, else the nearest ancestor's, else #Uni (one rule for talk targets, "Open in #room" and the node page). */
  const stewardOf = (p: string): Steward => {
    if (treeMode && data) {
      // the tree home also skips an archived room (its `room_fallback` stands in) and knows a room an ancestor shares
      const v = roomView(data.tree, p, roomRefs, uniRef);
      return { room: v.target, via: v.own ? "own" : v.heldBy && v.heldBy.id !== uniRef?.id ? "inherited" : "uni", from: null };
    }
    const chain: RoomNode[] = data ? ancestry(data.tree, p).map((n) => ({ path: n.path, name: n.name, room: typeof n.metadata.room === "string" ? n.metadata.room : null, channels: n.rooms })) : [];
    return steward(chain, roomRefs, uniRef);
  };
  const roomOfNode = (p: string) => stewardOf(p).room;
  const open = (a: Area) => { setRootOpen(false); const w = withRoom(a); onOpenArea(w.path, w.name, pickRoom(w.rooms, null)); };
  const toUni = () => onOpenArea(null, "Uni", uniRoom);
  if (!node) return <div className="areas-home"><button className="note-back" onClick={toUni}><span className="note-back-arrow" aria-hidden="true">←</span><span className="note-back-label">Uni</span></button>
    <p className="empty">{signingIn ? "Signing in…" : loading ? "Opening area…" : error ? `Couldn't load: ${error}` : "This area no longer exists."}</p></div>;
  const isRoot = node.path === ROOT;
  const tree = data?.tree;
  const kids = tree ? childrenOf(tree, node.path) : [];
  const up = isRoot ? null : tree?.nodes.get(parentPath(tree, node.path)) ?? null;
  const status = <>
    {data?.stale && <p className="areas-status" role="status">{error ? `Saved copy${data.savedAt ? ` from ${new Date(data.savedAt).toLocaleString()}` : ""} · couldn't refresh: ${error}` : "Saved copy · refreshing…"}</p>}
    {!data && error && !isRoot && <p className="note-error" role="alert">Couldn't load areas: {error}</p>}
    {!!data?.truncated.length && <p className="areas-status" role="status">{data.truncated.join(", ")}: showing first 200 notes; more may exist.</p>}
  </>;
  const crumbs = isRoot ? undefined : <nav className="crumbs" aria-label="Where you are">
    <button type="button" className="crumb" onClick={toUni}>Uni</button>
    {(tree ? trail(tree, node.path) : [node]).map((n, i, all) => i === all.length - 1
      ? <span key={n.path} className="crumb here" aria-current="page"><span className="crumb-separator" aria-hidden="true">›</span> {n.name}</span>
      : <span key={n.path}><span className="crumb-separator" aria-hidden="true">›</span> <button type="button" className="crumb" onClick={() => open(n)}>{n.name}</button></span>)}
  </nav>;
  const lead = isRoot ? <>
    {error && <p className="note-error" role="alert">Couldn't load areas: {error}</p>}
    <TodaySections data={data} now={now} onOpen={open} onNote={actions.openNote}
      canAsk={chat} onAsk={(name, text) => { if (!chat) return; const a = data?.areas.find((x) => x.name === name && x.kind === "area"); const ch = a ? pickRoom(a.rooms, null) : null; if (ch) actions.compose(ch, text); }} />
    {data && !data.today && !Object.keys(data.briefs).length && uniRoom && <button type="button" className="suggestion-go brief-write" onClick={() => actions.compose(uniRoom, refreshDraft("Uni", ""))}>Ask Uni to write it</button>}
  </> : undefined;
  const empty = isRoot && !kids.length && !error ? <p className="empty">{signingIn ? "Signing in…" : loading ? "Loading areas…" : "No areas yet. Tag a note `area` at Areas/<Name>."}</p> : null;
  const today = data?.today;
  const entry = data?.briefs[node.path] ?? null;
  const stageKids: StageKid[] = data && tree ? kids.map((k) => ({ node: k, open: tasks.counts.get(k.path)?.total ?? 0, needs: data.briefs[k.path]?.brief.needsYou.length ?? 0, room: k.kind === "project" ? treeMode ? (roomView(tree, k.path, roomRefs, uniRef).slash ?? undefined) : stewardOf(k.path).via === "own" ? stewardOf(k.path).room?.name : undefined : undefined, mark: rolledMark(tree, data.briefs, k.path), tips: treeMode ? [] : childrenOf(tree, k.path).map((c) => c.name) })) : [];
  const alive: Alive = isRoot
    ? { has: !!data && (!!data.today || Object.keys(data.briefs).length > 0), needs: rootNeeds(data, now).map((n) => n.text), moving: (today?.today.moved ?? []).map((m) => m.text) }
    : aliveOf(entry);
  const freshIso = isRoot ? (today ? today.generatedAt ?? today.updatedAt : null) : entry ? entry.generatedAt ?? entry.updatedAt : null;
  const stage = <NodeStage zoom={zoom} node={node} kids={stageKids} parent={isRoot ? null : up ?? root} alive={data ? alive : { has: false, needs: [], moving: [] }} pending={data ? null : signingIn ? "Signing in…" : loading ? "Opening…" : null}
    fresh={updatedLabel(freshIso, now)} kindLabel={isRoot ? new Date(now).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : node.kind === "project" ? "Project" : "Area"} count={{ needs: alive.needs.length, moving: alive.moving.length }}
    onOpen={open} onUp={back} />;
  const stewardView: Steward = isRoot ? { room: uniRef, via: "own", from: null } : stewardOf(node.path);
  const stewardText = stewardLine(stewardView);
  const target = stewardView.room;
  const nodeName = (p: string) => data?.tree.nodes.get(p)?.name ?? p.split("/").pop() ?? p;
  const here = isRoot ? "" : node.path;
  const work = <>
    {chat && <>
    <TalkBar key={`${node.path}|${target?.id ?? ""}`} room={target} talk={{ ...talk, sendText: async (c, t) => { await talk.sendText(c, t); setSentTick((n) => n + 1); } }} label={node.name} />
    {stewardText && <p className="steward" data-via={stewardView.via}>{stewardText}</p>}
    <RecentMessages room={target} tick={sentTick + (roomFor(target?.id)?.messages.length ?? 0)} />
    </>}
    <TaskList tasks={tasks.tasks} leaving={tasks.leaving} here={here} nodeName={nodeName} loading={tasks.loading} ready={tasks.ready} error={tasks.error} truncated={tasks.truncated} treeTruncated={tasks.treeTruncated}
      onOpen={setSheet} onAct={(t, a) => void tasks.act(t, a)} onRetry={tasks.refresh} />
    {sheet && <TaskSheet key={sheet.id} task={sheet} here={here} nodeName={nodeName} room={roomOfNode(sheet.node) ?? target} onClose={() => setSheet(null)} onAct={(t, a) => void tasks.act(t, a)} onOpenRoom={actions.openRoom} />}
    <UndoBar undo={tasks.undo} notice={tasks.notice} onDismiss={tasks.dismissNotice} />
  </>;
  // ------------------------------------------------------------------------------------------ the tree home (T-111)
  const nowSec = Math.floor(now / 1000);
  const rowOf = (p: string): RoomView => (tree ? roomView(tree, p, roomRefs, uniRef) : { target: uniRef, slash: null, heldBy: uniRef, own: false, heldNode: null });
  const needsOf = (p: string) => (roomsMode ? ownNeeds.get(p) ?? 0 : tasks.counts.get(p)?.you ?? 0);
  const openOf = (p: string) => tasks.counts.get(p)?.total ?? 0;
  const openPath = (p: string) => {
    if (p === ROOT) { setRootOpen(true); onOpenArea(null, "Uni", uniRoom); return; }
    const n = tree?.nodes.get(p); if (n) open(n);
  };
  const navRows = treeMode && tree ? treeRows(tree, roomRefs, uniRef) : [{ path: ROOT, name: "Uni", depth: 0, kind: "root" as const, slash: uniRef ? "uni" : null, heldBy: null, heldNode: null, own: !!uniRef, trunk: [], last: true }];
  const navNeeds = new Map(navRows.map((r) => [r.path, needsOf(r.path)]));
  if (treeMode && phoneTree && path === null && !rootOpen) {
    return <div className="areas-home tree-home-wrap"><TreeScreen chat={chat} rows={navRows} needs={navNeeds} status={status} onOpen={openPath} />
      <UndoBar undo={tasks.undo} notice={tasks.notice} onDismiss={tasks.dismissNotice} /></div>;
  }
  const mark = tree && data ? rolledMark(tree, data.briefs, node.path) : "quiet";
  const insideKids: InsideKid[] = tree && data ? kids.map((k) => ({ node: k, mark: rolledMark(tree, data.briefs, k.path), view: rowOf(k.path), needs: needsOf(k.path), open: openOf(k.path) })) : [];
  const nodeView = rowOf(node.path);
  const askRoom = target?.id ?? null;
  const rootLines = isRoot ? rootNeeds(data, now).map((n) => ({ text: n.text, tokens: n.tokens, ...(n.area ? { note: n.area } : {}) })) : [];
  const levelA = tree && data ? levelAlive({ tree, path: node.path, node, entry, briefs: data.briefs, tasks: levelTasks,
    root: isRoot ? { needs: rootLines, moved: today?.today.moved ?? [], areas: kids.length, needing: new Set(rootLines.map((l) => l.note).filter(Boolean)).size } : null }) : { now: "", nowTokens: null, needs: [], moving: [], derived: false, hasBrief: false };
  const updates = tree && chat ? updatesBelow(tree, node.path, rooms, uniRef, nowSec) : [];
  const trailItems = [{ path: ROOT, name: "Uni" }, ...(tree && !isRoot ? trail(tree, node.path) : isRoot ? [] : [node]).map((n) => ({ path: n.path, name: n.name }))];
  const insideTitle = isRoot ? "Areas" : node.kind === "area" ? "Projects" : "Inside";
  const askDraftFor = (l: { text: string; tokens: Inline[]; note?: string }) => askRoom && actions.compose(askRoom, askDraft("needsYou", isRoot && l.note ? l.note : node.name, l));
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
  const roomsSections = <div className="sp-cols">
    <div className="sp-col sp-left">
      <NeedsYou where={where} here={here} nodeName={nodeName} leaving={tasks.leaving} marks={noMarks} nowMs={nowMs}
        onOpen={setSheet} onAct={(t, a) => void tasks.act(t, a)} onPriority={(t, p) => void tasks.setPriority(t, p)} />
      <MovedBlock where={where} here={here} nodeName={nodeName} nowMs={nowMs} onOpen={setSheet} />
      <UpdatesBlock updates={updates} nowSec={nowSec} onOpen={openPath} />
      <InsideBlock chat={chat} title={insideTitle} kids={insideKids} onOpen={open} />
      {empty}
    </div>
    <div className="sp-col sp-right">
      <RunSection runs={runs} nowMs={nowMs} onOpenNote={actions.openNote} />
      <DraftSection drafts={drafts} marks={noMarks} nowMs={nowMs} onOpenNote={actions.openNote} />
      <TaskList title="Tasks" tasks={otherWork} marks={noMarks} nowMs={nowMs} leaving={tasks.leaving} here={here} nodeName={nodeName} loading={tasks.loading} ready={tasks.ready} error={tasks.error} truncated={tasks.truncated} treeTruncated={tasks.treeTruncated}
        onOpen={setSheet} onAct={(t, a) => void tasks.act(t, a)} onRetry={tasks.refresh} />
      <ProjectNote area={body !== null ? { ...node, body } : node} />
    </div>
  </div>;
  const sections = roomsMode ? roomsSections : <>
    <AliveBlock alive={levelA} kind={node.kind} onNote={actions.openNote} fresh={updatedLabel(freshIso, now)} onRefresh={askRoom ? () => actions.compose(askRoom, refreshDraft(node.name, isRoot ? "" : node.path)) : null} />
    <NeedsBlock lines={levelA.needs} onNote={actions.openNote} onAsk={askRoom && !levelA.derived ? (l) => void askDraftFor(l) : null} />
    <UpdatesBlock updates={updates} nowSec={nowSec} onOpen={openPath} />
    <InsideBlock chat={chat} title={insideTitle} kids={insideKids} onOpen={open} />
    {empty}
    <ProjectNote area={body !== null ? { ...node, body } : node} />
    <TaskList tasks={tasks.tasks} leaving={tasks.leaving} here={here} nodeName={nodeName} loading={tasks.loading} ready={tasks.ready} error={tasks.error} truncated={tasks.truncated} treeTruncated={tasks.treeTruncated}
      onOpen={setSheet} onAct={(t, a) => void tasks.act(t, a)} onRetry={tasks.refresh} />
    {chat && <RoomBlock view={nodeView} steward={stewardText} ledger={<Ledger roomId={target?.id ?? null} me={identity} nowSec={nowSec} tick={sentTick + (roomFor(target?.id)?.messages.length ?? 0)} />} />}
  </>;
  const talkBar = !chat ? null : <TalkBar key={`${node.path}|${target?.id ?? ""}`} room={target} talk={{ ...talk, sendText: async (c, t) => { await talk.sendText(c, t); setSentTick((n) => n + 1); } }} label={node.name} />;
  const phoneHead = <header className="th-head phone">
    <div className="th-toprow">
      <button type="button" className="th-back" onClick={() => (back ? back() : undefined)} aria-label="Back to the room tree"><span aria-hidden="true">‹</span> Rooms</button>
      <Crumbs trail={trailItems} onOpen={openPath} />
    </div>
    <p className="th-cap">{node.kind === "project" ? "Project" : isRoot ? new Date(now).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "Area"} {mark !== "quiet" && <span className="th-state" data-st={mark}>{mark === "needs" ? "needs you" : "moving"}</span>}</p>
    <h1 className="note-title">{node.name}</h1>
    {chat && <RoomLine view={nodeView} target={target} onOpenRoom={roomsMode ? openRoomHere : actions.openRoom} context={roomsMode} />}
    {roomsMode && headState}
  </header>;
  const wideHead = <header className="th-head wide">
    <Crumbs trail={trailItems} onOpen={openPath} />
    {roomsMode && <h1 className="note-title">{node.name}</h1>}
    {chat && <RoomLine view={nodeView} target={target} onOpenRoom={roomsMode ? openRoomHere : actions.openRoom} context={roomsMode} />}
    {roomsMode && headState}
  </header>;
  const fullLevel = <div className={`tree-home th-level ${wide ? "wide" : "phone"} ${roomsMode ? "th-rooms" : ""}`} data-layout={roomsMode ? "rooms" : "tree"}>
    {wide && !roomsMode && <div className="th-stage">{stage}</div>}
    {wide && roomsMode && <RoomSidebar chat={chat} rows={navRows} needs={navNeeds} selected={node.path} onOpen={openPath} nav={nav} />}
    <LevelPanel wide={wide} head={wide ? wideHead : phoneHead} foot={<>{roomsMode ? null : talkBar}<UndoBar undo={tasks.undo} notice={tasks.notice} onDismiss={tasks.dismissNotice} /></>}>{sections}</LevelPanel>
    {sheet && <TaskSheet key={sheet.id} task={sheet} here={here} nodeName={nodeName} room={roomOfNode(sheet.node) ?? target} onClose={() => setSheet(null)} onAct={(t, a) => void tasks.act(t, a)} onOpenRoom={roomsMode ? openRoomHere : actions.openRoom} />}
  </div>;
  // ------------------------------------------------------------------------------------------ the room (T-124): the conversation, with the state as a quiet companion
  const needTop = topNeeds(where, node.path);
  const rawStands = tasks.tree?.stands.get(node.path) ?? (typeof node.metadata.stands === "string" ? { text: node.metadata.stands, at: typeof node.metadata.stands_at === "string" ? node.metadata.stands_at : null } : null);
  const stands = standsLine(rawStands, privateLevel ? [] : levelTasks, now);
  const companionProps = { stands, ready: tasks.ready, needs: needTop, runs, nodeName: node.name, onTask: setSheet, onDecide: (t: Task, o: string) => void tasks.decide(t, o), onEverything: () => { setSheet(null); setFull(true); } };
  const roomView_ = roomFor(target?.id);
  const placeholder = chatPlaceholder({ name: node.name, slash: nodeView.own ? nodeView.slash : null, heldBy: nodeView.heldBy ? roomSlug(nodeView.heldBy.name) : null });
  const doorText = nodeView.own && nodeView.slash ? `#${nodeView.slash}` : "";
  const room = <section className="sr" aria-label={`Conversation: ${node.name}`}>
    <header className="sr-head">
      {!wide && <button type="button" className="sr-back" onClick={() => (back ? back() : undefined)} aria-label="Back to rooms"><span aria-hidden="true">‹</span></button>}
      <div className="sr-titles">
        {(doorText || (wide && !isRoot)) && <div className="sr-meta">
          {wide && !isRoot && <Crumbs trail={trailItems} onOpen={openPath} />}
          {doorText && <span className="sr-door">{doorText}</span>}
        </div>}
        <h1 className="sr-title">{node.name}</h1>
      </div>
    </header>
    {!wide && <CompanionStrip {...companionProps} open={companionOpen} onToggle={setCompanionOpen} />}
    <div className="sr-chat">{roomView_ ? roomView_.render(null, placeholder) : <p className="th-quiet" role="status">Opening the room…</p>}</div>
  </section>;
  const roomLevel = <div className={`tree-home th-level ${wide ? "wide" : "phone"} th-rooms th-simple ${wide && !companionOpen ? "folded" : ""}`} data-layout="rooms" data-view="room">
    {wide && <RoomSidebar chat={chat} rows={navRows} needs={navNeeds} selected={node.path} onOpen={openPath} nav={nav} />}
    {room}
    {wide && <CompanionSide {...companionProps} open={companionOpen} onToggle={setCompanionOpen} />}
    <UndoBar undo={tasks.undo} notice={tasks.notice} onDismiss={tasks.dismissNotice} />
    {sheet && <TaskSheet key={sheet.id} task={sheet} here={here} nodeName={nodeName} room={roomOfNode(sheet.node) ?? target} onClose={() => setSheet(null)} onAct={(t, a) => void tasks.act(t, a)} onOpenRoom={openRoomHere} />}
  </div>;
  const treeLevel = roomsMode && chat && target && !full ? roomLevel : fullLevel;
  const classicKids = layout === "classic" ? <div className="tree-home th-classic"><InsideBlock chat={chat} title={insideTitle} kids={insideKids} onOpen={open} />{empty}</div> : empty;
  return <AreaView key={node.id} work={work} area={body !== null ? { ...node, body } : node} projectError={bodyError} projectLoading={body === null && !bodyError} entry={data?.briefs[node.path] ?? null} now={now} channel={nodeRoom} onChannel={setPicked} mode={mode} roomName={roomName} actions={actions}
    room={roomFor(nodeRoom)} onConversations={onConversations} onBack={back} backLabel={up?.name ?? "Uni"}
    crumbs={crumbs} stage={layout === "classic" ? undefined : stage} tree={treeMode ? <>{status}{treeLevel}</> : undefined} slot={!isRoot && node.kind === "area" && layout === "octopus" ? <AreaSlot node={node} /> : null} dataStatus={treeMode ? null : status} lead={lead} kids={classicKids} freshAt={isRoot ? (today ? today.generatedAt ?? today.updatedAt : null) : undefined} />;
}
