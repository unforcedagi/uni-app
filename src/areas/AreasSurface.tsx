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
import { refreshDraft, updatedLabel } from "./briefCore";
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
import "./areas.css";

const USER_AGENT = currentUserAgent();
const PLATFORM = platformName(USER_AGENT);

/** The Uni tab: Uni itself at `{kind:"areas"}` (path null), any area or project under it at `{kind:"area", path}`. One page component for all. */
export default function AreasSurface({ zoom, identity, talk, path, rooms, actions, roomFor, onRoom, onOpenArea, onConversations, onBackChange }: {
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
  const { data, error, loading, signingIn } = useAreas(identity);
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
  const withRoom = (a: Area): Area => { if (a.rooms.length) return a; const r = ownRoom({ room: typeof a.metadata.room === "string" ? a.metadata.room : null, channels: [] }, roomRefs); return r ? { ...a, rooms: [r.id] } : a; };
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
  const back = path ? () => {
    const up = data ? data.tree.nodes.get(parentPath(data.tree, path)) : null;
    onOpenArea(up?.path ?? null, up?.name ?? "Uni", up ? pickRoom(withRoom(up).rooms, null) : uniRoom);
  } : null;
  useEffect(() => {
    // Android Back closes an open task sheet before it zooms out a level.
    onBackChange(sheet ? () => setSheet(null) : back);
    return () => onBackChange(null);
  }, [path, data, uniRoom, onOpenArea, onBackChange, sheet]); // eslint-disable-line react-hooks/exhaustive-deps
  // A node can have several rooms (metadata.channel is a list): the user's pick, else the first.
  const [picked, setPicked] = useState<string | null>(null);
  const nodeRoom = node ? pickRoom(node.rooms, picked) : null;
  useEffect(() => { if (node) onRoom(nodeRoom); }, [node?.id, nodeRoom]); // eslint-disable-line react-hooks/exhaustive-deps
  const roomName = useMemo(() => (id: string) => rooms.find((r) => r.id === id)?.name ?? "room", [rooms]);
  const now = Date.now();
  const fallback = useMemo<TaskNode[]>(() => (data?.areas ?? []).map((a) => ({ id: a.id, path: a.path, name: a.name, parent: a.parent, room: typeof a.metadata.room === "string" ? a.metadata.room : null, status: a.status === "archived" || a.status === "done" ? a.status : "active", isRoot: false })), [data?.areas]);
  const tasks = useTasks(identity, node?.path ?? "", fallback);
  const [sentTick, setSentTick] = useState(0);
  useEffect(() => { setSheet(null); }, [node?.path]);
  /** Who stewards a node: its own room, else the nearest ancestor's, else #Uni (one rule for talk targets, "Open in #room" and the node page). */
  const stewardOf = (p: string): Steward => {
    const chain: RoomNode[] = data ? ancestry(data.tree, p).map((n) => ({ path: n.path, name: n.name, room: typeof n.metadata.room === "string" ? n.metadata.room : null, channels: n.rooms })) : [];
    return steward(chain, roomRefs, uniRef);
  };
  const roomOfNode = (p: string) => stewardOf(p).room;
  const open = (a: Area) => { const w = withRoom(a); onOpenArea(w.path, w.name, pickRoom(w.rooms, null)); };
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
      onAsk={(name, text) => { const a = data?.areas.find((x) => x.name === name && x.kind === "area"); const ch = a ? pickRoom(a.rooms, null) : null; if (ch) actions.compose(ch, text); }} />
    {data && !data.today && !Object.keys(data.briefs).length && uniRoom && <button type="button" className="suggestion-go brief-write" onClick={() => actions.compose(uniRoom, refreshDraft("Uni", ""))}>Ask Uni to write it</button>}
  </> : undefined;
  const empty = isRoot && !kids.length && !error ? <p className="empty">{signingIn ? "Signing in…" : loading ? "Loading areas…" : "No areas yet. Tag a note `area` at Areas/<Name>."}</p> : null;
  const today = data?.today;
  const entry = data?.briefs[node.path] ?? null;
  const stageKids: StageKid[] = data && tree ? kids.map((k) => ({ node: k, open: tasks.counts.get(k.path)?.total ?? 0, needs: data.briefs[k.path]?.brief.needsYou.length ?? 0, room: k.kind === "project" ? stewardOf(k.path).via === "own" ? stewardOf(k.path).room?.name : undefined : undefined, mark: rolledMark(tree, data.briefs, k.path), tips: childrenOf(tree, k.path).map((c) => c.name) })) : [];
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
    <TalkBar key={`${node.path}|${target?.id ?? ""}`} room={target} talk={{ ...talk, sendText: async (c, t) => { await talk.sendText(c, t); setSentTick((n) => n + 1); } }} label={node.name} />
    {stewardText && <p className="steward" data-via={stewardView.via}>{stewardText}</p>}
    <RecentMessages room={target} tick={sentTick + (roomFor(target?.id)?.messages.length ?? 0)} />
    <TaskList tasks={tasks.tasks} leaving={tasks.leaving} here={here} nodeName={nodeName} loading={tasks.loading} ready={tasks.ready} error={tasks.error} truncated={tasks.truncated} treeTruncated={tasks.treeTruncated}
      onOpen={setSheet} onAct={(t, a) => void tasks.act(t, a)} onRetry={tasks.refresh} />
    {sheet && <TaskSheet key={sheet.id} task={sheet} here={here} nodeName={nodeName} room={roomOfNode(sheet.node) ?? target} onClose={() => setSheet(null)} onAct={(t, a) => void tasks.act(t, a)} onOpenRoom={actions.openRoom} />}
    <UndoBar undo={tasks.undo} notice={tasks.notice} onDismiss={tasks.dismissNotice} />
  </>;
  return <AreaView key={node.id} work={work} area={body !== null ? { ...node, body } : node} projectError={bodyError} projectLoading={body === null && !bodyError} entry={data?.briefs[node.path] ?? null} now={now} channel={nodeRoom} onChannel={setPicked} mode={mode} roomName={roomName} actions={actions}
    room={roomFor(nodeRoom)} onConversations={onConversations} onBack={back} backLabel={up?.name ?? "Uni"}
    crumbs={crumbs} stage={stage} slot={!isRoot && node.kind === "area" ? <AreaSlot node={node} /> : null} dataStatus={status} lead={lead} kids={empty} freshAt={isRoot ? (today ? today.generatedAt ?? today.updatedAt : null) : undefined} />;
}
