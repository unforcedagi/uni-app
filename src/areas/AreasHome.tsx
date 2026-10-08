import type { Area } from "./areasCore";

export type RoomInfo = { id: string; name: string; last_message: string | null; last_ts: number | null };
const when = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Latest message across the area's rooms, when the app knows them. */
export function latestFor(area: Area, rooms: RoomInfo[]): { ts: number; text: string } | null {
  let best: { ts: number; text: string } | null = null;
  for (const id of area.channels) {
    const r = rooms.find((x) => x.id === id);
    if (r?.last_ts && (!best || r.last_ts > best.ts)) best = { ts: r.last_ts, text: (r.last_message ?? "").replace(/\s+/g, " ").trim() };
  }
  return best;
}

export default function AreasHome({ areas, rooms, loading, error, onOpen, onReload }: {
  areas: Area[]; rooms: RoomInfo[]; loading: boolean; error: string | null; onOpen: (area: Area) => void; onReload: () => void;
}) {
  return <div className="areas-home">
    <header className="areas-head">
      <div><span className="eyebrow">Unforced</span><h1>Areas</h1><p>Where your life has weight. Choose where to focus.</p></div>
      <button className="icon-button" onClick={onReload} disabled={loading} aria-label="Refresh areas">↻</button>
    </header>
    {error && <p className="note-error" role="alert">Couldn't load areas: {error}</p>}
    {!areas.length && !error && <p className="empty">{loading ? "Loading areas…" : "No areas yet. Tag a note `area` at Areas/<Name>."}</p>}
    <div className="areas-grid">{areas.map((area) => {
      const latest = latestFor(area, rooms);
      return <button key={area.id} className={`area-card ${area.status}`} onClick={() => onOpen(area)} aria-label={`${area.name}, ${area.status}`}>
        <span className="area-card-top"><strong>{area.name}</strong><span className={`area-mark ${area.status}`}>{area.status === "foreground" ? "Foreground" : "Background"}</span></span>
        <span className="area-purpose">{area.purpose || "No purpose written yet."}</span>
        <span className="area-latest">{latest ? <><time>{when(latest.ts)}</time>{latest.text && <span>{latest.text}</span>}</> : <span className="area-quiet">{area.channels.length ? "No messages yet" : "No room linked"}</span>}</span>
      </button>;
    })}</div>
  </div>;
}
