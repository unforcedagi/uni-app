import { useMemo } from "react";
import AreasHome, { type RoomInfo } from "./AreasHome";
import AreaView, { type AreaActions } from "./AreaView";
import { liveAreaApps, platformName, readSelfTest } from "./gate";
import { useAppVersion } from "./useAppVersion";
import { useAreas } from "./useAreas";
import "./areas.css";

const PLATFORM = platformName(typeof navigator === "undefined" ? "" : navigator.userAgent);

/** The Areas tab: the grid at `{kind:"areas"}`, one area at `{kind:"area", path}`. */
export default function AreasSurface({ path, rooms, actions, onOpenArea, onBack }: {
  path: string | null; rooms: RoomInfo[]; actions: AreaActions; onOpenArea: (areaPath: string, name: string) => void; onBack: () => void;
}) {
  const { data, error, loading } = useAreas();
  const version = useAppVersion();
  const live = useMemo(() => liveAreaApps(PLATFORM, version, readSelfTest()), [version]);
  const area = path ? data?.areas.find((a) => a.path === path) : null;
  const roomName = useMemo(() => (id: string) => rooms.find((r) => r.id === id)?.name ?? "room", [rooms]);
  if (!path) return <AreasHome areas={data?.areas ?? []} rooms={rooms} loading={loading} error={error} onOpen={(a) => onOpenArea(a.path, a.name)} />;
  if (!area) return <div className="areas-home"><button className="note-back" onClick={onBack}><span className="note-back-arrow" aria-hidden="true">←</span><span className="note-back-label">Areas</span></button>
    <p className="empty">{loading ? "Opening area…" : error ? `Couldn't load: ${error}` : "This area no longer exists."}</p></div>;
  return <AreaView key={area.id} area={area} rows={data!.rows} live={live} roomName={roomName} actions={actions} onBack={onBack} />;
}
