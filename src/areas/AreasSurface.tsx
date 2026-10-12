import { useEffect, useMemo, useState } from "react";
import { RecentMessages, TalkBar, TaskList, TaskSheet, UndoBar, type Talk } from "./NodeWork";
import { useTasks } from "./useTasks";
import { ownRoom, steward, stewardLine, type RoomNode, type Steward } from "./talkCore";
import type { Area } from "./areasCore";
import type { Task, TaskNode } from "./taskCore";
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
import { roomView, treeRows, updatesBelow, type RoomView } from "./treeRooms";
import { levelAlive } from "./treeAlive";
import { useVaultProfile } from "./ProfileContext";
import { AliveBlock, Crumbs, InsideBlock, LevelPanel, Ledger, NeedsBlock, ProjectNote, RoomBlock, RoomLine, TreeScreen, UpdatesBlock, type InsideKid } from "./TreeHome";
import "./areas.css";
import "./tree.css";

/** Whether the phone is on Uni's own level rather than the room tree. A replace in the tab strip remounts the page, so this outlives it. */
const rootOpenMemory = { open: false };
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
  const layout = useHomeLayout();
  const wide = useWide();
  const treeMode = layout === "tree";
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
  const back = path ? (phoneTree ? () => { setRootOpen(false); onOpenArea(null, "Uni", uniRoom); } : () => {
    const up = data ? data.tree.nodes.get(parentPath(data.tree, path)) : null;
    onOpenArea(up?.path ?? null, up?.name ?? "Uni", up ? pickRoom(withRoom(up).rooms, null) : uniRoom);
  }) : phoneTree && rootOpen ? () => setRootOpen(false) : null;
  useEffect(() => {
    // Android Back closes an open task sheet before it zooms out a level.
    onBackChange(sheet ? () => setSheet(null) : back);
    return () => onBackChange(null);
  }, [path, data, uniRoom, onOpenArea, onBackChange, sheet, phoneTree, rootOpen]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const tasks = useTasks(identity, node?.path ?? "", fallback);
  const [sentTick, setSentTick] = useState(0);
  useEffect(() => { setSheet(null); }, [node?.path]);
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
  const rowOf = (p: string): RoomView => (tree ? roomView(tree, p, roomRefs, uniRef) : { target: uniRef, slash: null, heldBy: uniRef, own: false });
  const needsOf = (p: string) => tasks.counts.get(p)?.you ?? 0;
  const openOf = (p: string) => tasks.counts.get(p)?.total ?? 0;
  const openPath = (p: string) => {
    if (p === ROOT) { setRootOpen(true); onOpenArea(null, "Uni", uniRoom); return; }
    const n = tree?.nodes.get(p); if (n) open(n);
  };
  if (treeMode && phoneTree && path === null && !rootOpen) {
    const rows = tree ? treeRows(tree, roomRefs, uniRef) : [{ path: ROOT, name: "Uni", depth: 0, kind: "root" as const, slash: uniRef ? "uni" : null, heldBy: null, own: !!uniRef, trunk: [], last: true }];
    const marks = new Map(rows.map((r) => [r.path, tree && data ? rolledMark(tree, data.briefs, r.path) : "quiet" as const]));
    const needs = new Map(rows.map((r) => [r.path, needsOf(r.path)]));
    const total = new Map(rows.map((r) => [r.path, openOf(r.path)]));
    const you = needsOf(ROOT);
    const summary = !data ? (signingIn ? "Signing in…" : loading ? "Opening…" : error ? `Couldn't load: ${error}` : "") : you ? `${you} need${you === 1 ? "s" : ""} you · ${openOf(ROOT)} open` : openOf(ROOT) ? `Nothing needs you · ${openOf(ROOT)} open` : "Nothing open";
    return <div className="areas-home tree-home-wrap"><TreeScreen chat={chat} rows={rows} marks={marks} needs={needs} open={total} summary={summary} status={status}
      dateLine={new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })} onOpen={openPath} />
      <UndoBar undo={tasks.undo} notice={tasks.notice} onDismiss={tasks.dismissNotice} /></div>;
  }
  const mark = tree && data ? rolledMark(tree, data.briefs, node.path) : "quiet";
  const insideKids: InsideKid[] = tree && data ? kids.map((k) => ({ node: k, mark: rolledMark(tree, data.briefs, k.path), view: rowOf(k.path), needs: needsOf(k.path), open: openOf(k.path) })) : [];
  const nodeView = rowOf(node.path);
  const askRoom = target?.id ?? null;
  const rootLines = isRoot ? rootNeeds(data, now).map((n) => ({ text: n.text, tokens: n.tokens, ...(n.area ? { note: n.area } : {}) })) : [];
  const levelA = tree && data ? levelAlive({ tree, path: node.path, node, entry, briefs: data.briefs, tasks: tasks.tasks,
    root: isRoot ? { needs: rootLines, moved: today?.today.moved ?? [], areas: kids.length, needing: new Set(rootLines.map((l) => l.note).filter(Boolean)).size } : null }) : { now: "", nowTokens: null, needs: [], moving: [], derived: false, hasBrief: false };
  const updates = tree && chat ? updatesBelow(tree, node.path, rooms, uniRef, nowSec) : [];
  const trailItems = [{ path: ROOT, name: "Uni" }, ...(tree && !isRoot ? trail(tree, node.path) : isRoot ? [] : [node]).map((n) => ({ path: n.path, name: n.name }))];
  const insideTitle = isRoot ? "Areas" : node.kind === "area" ? "Projects" : "Inside";
  const askDraftFor = (l: { text: string; tokens: Inline[]; note?: string }) => askRoom && actions.compose(askRoom, askDraft("needsYou", isRoot && l.note ? l.note : node.name, l));
  const sections = <>
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
    <h1 className="note-title">{node.title}</h1>
    {chat && <RoomLine view={nodeView} />}
  </header>;
  const wideHead = <header className="th-head wide">
    <Crumbs trail={trailItems} onOpen={openPath} />
    {chat && <RoomLine view={nodeView} />}
  </header>;
  const treeLevel = <div className={`tree-home th-level ${wide ? "wide" : "phone"}`} data-layout="tree">
    {wide && <div className="th-stage">{stage}</div>}
    <LevelPanel wide={wide} head={wide ? wideHead : phoneHead} foot={<>{talkBar}<UndoBar undo={tasks.undo} notice={tasks.notice} onDismiss={tasks.dismissNotice} /></>}>{sections}</LevelPanel>
    {sheet && <TaskSheet key={sheet.id} task={sheet} here={here} nodeName={nodeName} room={roomOfNode(sheet.node) ?? target} onClose={() => setSheet(null)} onAct={(t, a) => void tasks.act(t, a)} onOpenRoom={actions.openRoom} />}
  </div>;
  const classicKids = layout === "classic" ? <div className="tree-home th-classic"><InsideBlock chat={chat} title={insideTitle} kids={insideKids} onOpen={open} />{empty}</div> : empty;
  return <AreaView key={node.id} work={work} area={body !== null ? { ...node, body } : node} projectError={bodyError} projectLoading={body === null && !bodyError} entry={data?.briefs[node.path] ?? null} now={now} channel={nodeRoom} onChannel={setPicked} mode={mode} roomName={roomName} actions={actions}
    room={roomFor(nodeRoom)} onConversations={onConversations} onBack={back} backLabel={up?.name ?? "Uni"}
    crumbs={crumbs} stage={layout === "classic" ? undefined : stage} tree={treeMode ? <>{status}{treeLevel}</> : undefined} slot={!isRoot && node.kind === "area" && layout === "octopus" ? <AreaSlot node={node} /> : null} dataStatus={treeMode ? null : status} lead={lead} kids={classicKids} freshAt={isRoot ? (today ? today.generatedAt ?? today.updatedAt : null) : undefined} />;
}
