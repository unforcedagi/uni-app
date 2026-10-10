import { useMemo } from "react";
import type { Area } from "./areasCore";
import { askDraft, todayNeeds } from "./briefCore";
import { InlineText } from "./BriefView";
import type { AreasData } from "./useAreas";
import { pickRoom } from "./areaLayout";

export type RoomInfo = { id: string; name: string; last_message: string | null; last_ts: number | null };

const dateLine = (now: number) => new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

/** What needs Aaron across areas, ranked (Uni's page and the centre of its map). */
export function rootNeeds(data: AreasData | null, now: number) {
  if (!data) return [];
  const named = data.areas.filter((a) => a.kind === "area");
  const foreground = named.filter((a) => a.status === "foreground");
  return todayNeeds(data.today?.today ?? null, Object.fromEntries(named.flatMap((a) => (data.briefs[a.path] ? [[a.name, data.briefs[a.path].brief]] : []))), foreground.map((a) => a.name), now);
}

/** Uni's own page: what needs you today across areas (ranked), then what moved. */
export function TodaySections({ data, now, onOpen, onNote, onAsk }: {
  data: AreasData | null; now: number; onOpen: (area: Area) => void; onNote: (ref: string) => void;
  /** Draft `text` in the room of the area named `area`; never sends. */
  onAsk: (area: string, text: string) => void;
}) {
  const areas = data?.areas ?? [];
  const named = useMemo(() => areas.filter((a) => a.kind === "area"), [areas]);
  const foreground = useMemo(() => named.filter((a) => a.status === "foreground"), [named]);
  const needs = useMemo(() => (data ? todayNeeds(data.today?.today ?? null, Object.fromEntries(named.flatMap((a) => (data.briefs[a.path] ? [[a.name, data.briefs[a.path].brief]] : []))), foreground.map((a) => a.name), now) : []), [data, named, foreground, now]);
  const byName = (name: string | null) => named.find((a) => a.name === name) ?? null;
  const askable = (name: string | null) => { const a = byName(name); return !!a && !!pickRoom(a.rooms, null); };
  const moved = data?.today?.today.moved ?? [];
  return <>
    <section className="today-needs" aria-label="Needs you today">
      <h2>Needs you</h2>
      {needs.length === 0
        ? <p className="area-quiet">{data && (data.today || Object.keys(data.briefs).length) ? "Nothing needs you today." : "Uni hasn't written Today yet."}</p>
        : <ol className="needs-list">{needs.map((n, i) => <li key={i}>
          {n.area && byName(n.area) && <button type="button" className="need-area" onClick={() => onOpen(byName(n.area)!)}>{n.area}</button>}
          <span className="brief-item"><InlineText tokens={n.tokens} onNote={onNote} /></span>
          {n.area && askable(n.area) && <button type="button" className="pairing-secondary brief-ask" aria-label={`Ask Uni about: ${n.text}`} onClick={() => onAsk(n.area!, askDraft("needsYou", n.area!, n))}>Ask Uni</button>}
        </li>)}</ol>}
    </section>
    {moved.length > 0 && <section className="today-moved" aria-label="Moved"><h2>Moved</h2>
      <ul>{moved.map((m, i) => <li key={i}><span className="brief-item"><InlineText tokens={m.tokens} onNote={onNote} /></span></li>)}</ul></section>}
  </>;
}

export { dateLine };
