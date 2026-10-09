import { useEffect, useMemo } from "react";
import AreasHome, { type RoomInfo } from "./AreasHome";
import AreaView, { type AreaActions } from "./AreaView";
import type { AreaRoom } from "./AreaChat";
import { currentUserAgent, gateMode, platformName } from "../interface/selftest/gate";
import { useAppVersion, useWebviewRuntime } from "../interface/selftest/useAppVersion";
import { useAreas } from "./useAreas";
import { markStarted } from "./appRun";
import { useStoredSelfTest } from "../interface/selftest/useSelfTest";
import "./areas.css";

const USER_AGENT = currentUserAgent();
const PLATFORM = platformName(USER_AGENT);

/** The Areas tab: the grid at `{kind:"areas"}`, one area at `{kind:"area", path}`. */
export default function AreasSurface({ path, rooms, actions, roomFor, onRoom, onOpenArea, onBack }: {
  path: string | null; rooms: RoomInfo[]; actions: AreaActions;
  /** The host's room view for a room id (its messages and composer), when that room is the one loaded. */
  roomFor: (id: string | null | undefined) => AreaRoom | null;
  /** The open area's room (null: none), so the host can load it. */
  onRoom: (id: string | null) => void;
  onOpenArea: (areaPath: string, name: string, room: string | null) => void; onBack: () => void;
}) {
  const { data, error, loading } = useAreas();
  const version = useAppVersion();
  const runtime = useWebviewRuntime();
  const stored = useStoredSelfTest();
  // Live: a self-test pass (or a revoke) updates an already-open area without a remount.
  const mode = useMemo(() => gateMode(PLATFORM, version, stored, USER_AGENT, undefined, runtime), [version, stored, runtime]);
  const area = path ? data?.areas.find((a) => a.path === path) : null;
  const areaRoom = area?.channels[0] ?? null;
  useEffect(() => { if (area) onRoom(areaRoom); }, [area?.id, areaRoom]); // eslint-disable-line react-hooks/exhaustive-deps
  const roomName = useMemo(() => (id: string) => rooms.find((r) => r.id === id)?.name ?? "room", [rooms]);
  if (!path) return <AreasHome areas={data?.areas ?? []} rooms={rooms} loading={loading} error={error} onOpen={(a) => { markStarted(a.path); onOpenArea(a.path, a.name, a.channels[0] ?? null); }} />;
  if (!area) return <div className="areas-home"><button className="note-back" onClick={onBack}><span className="note-back-arrow" aria-hidden="true">←</span><span className="note-back-label">Areas</span></button>
    <p className="empty">{loading ? "Opening area…" : error ? `Couldn't load: ${error}` : "This area no longer exists."}</p></div>;
  return <AreaView key={area.id} area={area} rows={data!.rows} mode={mode} roomName={roomName} actions={actions} room={roomFor(areaRoom)} onBack={onBack} />;
}
