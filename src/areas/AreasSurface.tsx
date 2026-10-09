import { useEffect, useMemo, useState } from "react";
import { ChildCards, dateLine, TodaySections, type RoomInfo } from "./TodayView";
import AreaView, { type AreaActions } from "./AreaView";
import type { AreaRoom } from "./AreaChat";
import { currentUserAgent, gateMode, platformName } from "../interface/selftest/gate";
import { useAppVersion, useWebviewRuntime } from "../interface/selftest/useAppVersion";
import { useAreas } from "./useAreas";
import { pickRoom } from "./areaLayout";
import { childrenOf, parentPath, ROOT, rootNode, trail, UNI_CHANNEL } from "./treeCore";
import { findUniRoom } from "../uniActions";
import { useStoredSelfTest } from "../interface/selftest/useSelfTest";
import "./areas.css";

const USER_AGENT = currentUserAgent();
const PLATFORM = platformName(USER_AGENT);

/** The Uni tab: Uni itself at `{kind:"areas"}` (path null), any area or project under it at `{kind:"area", path}`. One page component for all. */
export default function AreasSurface({ path, rooms, actions, roomFor, onRoom, onOpenArea }: {
  path: string | null; rooms: RoomInfo[]; actions: AreaActions;
  /** The host's room view for a room id (its messages and composer), when that room is the one loaded. */
  roomFor: (id: string | null | undefined) => AreaRoom | null;
  /** The open node's room (null: none), so the host can load it. */
  onRoom: (id: string | null) => void;
  /** Open a node (path null: Uni) in this tab. */
  onOpenArea: (areaPath: string | null, name: string, room: string | null) => void;
}) {
  const { data, error, loading } = useAreas();
  const version = useAppVersion();
  const runtime = useWebviewRuntime();
  const stored = useStoredSelfTest();
  // Live: a self-test pass (or a revoke) updates an already-open area without a remount.
  const mode = useMemo(() => gateMode(PLATFORM, version, stored, USER_AGENT, undefined, runtime), [version, stored, runtime]);
  const uniRoom = useMemo(() => (rooms.some((r) => r.id === UNI_CHANNEL) ? UNI_CHANNEL : findUniRoom(rooms)?.id ?? null), [rooms]);
  const root = useMemo(() => rootNode(uniRoom ? [uniRoom] : []), [uniRoom]);
  const node = path ? data?.tree.nodes.get(path) ?? null : root;
  // A node can have several rooms (metadata.channel is a list): the user's pick, else the first.
  const [picked, setPicked] = useState<string | null>(null);
  const nodeRoom = node ? pickRoom(node.rooms, picked) : null;
  useEffect(() => { if (node) onRoom(nodeRoom); }, [node?.id, nodeRoom]); // eslint-disable-line react-hooks/exhaustive-deps
  const roomName = useMemo(() => (id: string) => rooms.find((r) => r.id === id)?.name ?? "room", [rooms]);
  const now = Date.now();
  const open = (a: { path: string; name: string; rooms: string[] }) => onOpenArea(a.path, a.name, pickRoom(a.rooms, null));
  const toUni = () => onOpenArea(null, "Uni", uniRoom);
  if (!node) return <div className="areas-home"><button className="note-back" onClick={toUni}><span className="note-back-arrow" aria-hidden="true">←</span><span className="note-back-label">Uni</span></button>
    <p className="empty">{loading ? "Opening area…" : error ? `Couldn't load: ${error}` : "This area no longer exists."}</p></div>;
  const isRoot = node.path === ROOT;
  const tree = data?.tree;
  const kids = tree ? childrenOf(tree, node.path) : [];
  const up = isRoot ? null : tree?.nodes.get(parentPath(tree, node.path)) ?? null;
  const crumbs = isRoot ? undefined : <nav className="crumbs" aria-label="Where you are">
    <button type="button" className="crumb" onClick={toUni}>Uni</button>
    {(tree ? trail(tree, node.path) : [node]).map((n, i, all) => i === all.length - 1
      ? <span key={n.path} className="crumb here" aria-current="page"><span aria-hidden="true">›</span> {n.name}</span>
      : <span key={n.path}><span aria-hidden="true">›</span> <button type="button" className="crumb" onClick={() => open(n)}>{n.name}</button></span>)}
  </nav>;
  const lead = isRoot ? <>
    <p className="today-date">{dateLine(now)}</p>
    {error && <p className="note-error" role="alert">Couldn't load areas: {error}</p>}
    <TodaySections data={data} now={now} onOpen={open} onNote={actions.openNote}
      onAsk={(name, text) => { const a = data?.areas.find((x) => x.name === name && x.kind === "area"); const ch = a ? pickRoom(a.rooms, null) : null; if (ch) actions.compose(ch, text); }} />
  </> : undefined;
  const cards = data && kids.length ? <ChildCards nodes={kids} data={data} now={now} title={isRoot ? "Areas" : `Inside ${node.name}`} onOpen={open} />
    : isRoot && !kids.length && !error ? <p className="empty">{loading ? "Loading areas…" : "No areas yet. Tag a note `area` at Areas/<Name>."}</p> : null;
  const today = data?.today;
  return <AreaView key={node.id} area={node} entry={data?.briefs[node.path] ?? null} now={now} channel={nodeRoom} onChannel={setPicked} mode={mode} roomName={roomName} actions={actions}
    room={roomFor(nodeRoom)} onBack={isRoot ? null : () => (up ? open(up) : toUni())} backLabel={up?.name ?? "Uni"}
    crumbs={crumbs} lead={lead} kids={cards} freshAt={isRoot ? (today ? today.generatedAt ?? today.updatedAt : null) : undefined} />;
}
