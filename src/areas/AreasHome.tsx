import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Area } from "./areasCore";

export type RoomInfo = { id: string; name: string; last_message: string | null; last_ts: number | null };
type Latest = { ts: number; text: string; author: string | null };
type Tail = { author: string | null; text: string };
const when = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** Latest message across the area's rooms, when the app knows them. `tails` adds the author of each room's last message. */
export function latestFor(area: Area, rooms: RoomInfo[], tails: Record<string, Tail> = {}): Latest | null {
  let best: Latest | null = null;
  for (const id of area.channels) {
    const r = rooms.find((x) => x.id === id);
    if (r?.last_ts && (!best || r.last_ts > best.ts)) best = { ts: r.last_ts, text: flat(tails[id]?.text ?? r.last_message ?? ""), author: tails[id]?.author ?? null };
  }
  return best;
}

/** The author of each linked room's last message, read from the existing message store. */
function useTails(areas: Area[], rooms: RoomInfo[]): Record<string, Tail> {
  const [tails, setTails] = useState<Record<string, Tail>>({});
  const ids = useMemo(() => [...new Set(areas.flatMap((a) => a.channels))], [areas]);
  const stamp = ids.map((id) => `${id}:${rooms.find((r) => r.id === id)?.last_ts ?? 0}`).join("|");
  useEffect(() => {
    let on = true;
    Promise.all(ids.map((channel) => invoke<{ author: string; author_name?: string; body: string; ts: number }[]>("get_messages", { channel, root: null, limit: 1 })
      .then((m) => { const last = m[m.length - 1]; return last ? [channel, { author: last.author_name || null, text: last.body }] as const : null; }).catch(() => null)))
      .then((l) => { if (on) setTails(Object.fromEntries(l.filter((x): x is [string, Tail] => !!x))); });
    return () => { on = false; };
  }, [stamp]);
  return tails;
}

export default function AreasHome({ areas, rooms, loading, error, onOpen }: {
  areas: Area[]; rooms: RoomInfo[]; loading: boolean; error: string | null; onOpen: (area: Area) => void;
}) {
  const tails = useTails(areas, rooms);
  return <div className="areas-home">
    <header className="areas-head">
      <span className="eyebrow">Unforced</span><h1>Areas</h1><p>Where your life has weight. Choose where to focus.</p>
    </header>
    {error && <p className="note-error" role="alert">Couldn't load areas: {error}</p>}
    {!areas.length && !error && <p className="empty">{loading ? "Loading areas…" : "No areas yet. Tag a note `area` at Areas/<Name>."}</p>}
    <div className="areas-grid">{areas.map((area) => {
      const latest = latestFor(area, rooms, tails);
      return <button key={area.id} className={`area-card ${area.status}`} onClick={() => onOpen(area)} aria-label={`${area.name}, ${area.status}`}>
        <span className={`area-mark ${area.status}`}>{area.status === "foreground" ? "Foreground" : "Background"}</span>
        <strong className="area-name">{area.name}</strong>
        <span className="area-purpose">{area.purpose || "No purpose written yet."}</span>
        {latest ? <span className="area-latest"><time>{when(latest.ts)}</time>{latest.text && <span>{latest.author ? `${latest.author}: ` : ""}{latest.text}</span>}</span>
          : <span className="area-latest"><span className="area-quiet">{area.channels.length ? "Quiet so far" : "No room linked"}</span></span>}
      </button>;
    })}</div>
  </div>;
}
