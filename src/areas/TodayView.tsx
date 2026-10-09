import { useMemo } from "react";
import type { Area } from "./areasCore";
import { askDraft, nowLine, todayNeeds, updatedLabel } from "./briefCore";
import { InlineText } from "./BriefView";
import type { AreasData } from "./useAreas";
import { pickRoom } from "./areaLayout";

export type RoomInfo = { id: string; name: string; last_message: string | null; last_ts: number | null };

const dateLine = (now: number) => new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

function AreaCard({ area, data, now, onOpen }: { area: Area; data: AreasData; now: number; onOpen: (a: Area) => void }) {
  const entry = data.briefs[area.name];
  const needs = entry?.brief.needsYou.length ?? 0;
  const now_ = entry ? nowLine(entry.brief) : "";
  const fresh = entry ? updatedLabel(entry.generatedAt ?? entry.updatedAt, now) : "";
  return <button className={`area-card ${area.status}`} onClick={() => onOpen(area)} aria-label={`${area.name}, ${area.status}${needs ? `, ${needs} need${needs === 1 ? "s" : ""} you` : ""}`}>
    <span className={`area-mark ${area.status}`}>{area.status === "foreground" ? "Foreground" : "Background"}</span>
    <strong className="area-name">{area.name}</strong>
    <span className="area-purpose area-now">{now_ || area.purpose || "No purpose written yet."}</span>
    <span className="area-foot">
      {entry ? (needs > 0 ? <b className="needs-chip">{needs} {needs === 1 ? "needs" : "need"} you</b> : <span className="area-quiet">Nothing needs you</span>) : <span className="area-quiet">No brief yet</span>}
      {fresh && <time className="area-fresh">{fresh}</time>}
    </span>
  </button>;
}

/** The Areas home: what needs you today across areas, then one card per area (foreground first, background collapsed). */
export default function TodayView({ data, loading, error, now, onOpen, onNote, onAsk }: {
  data: AreasData | null; loading: boolean; error: string | null; now: number;
  onOpen: (area: Area) => void; onNote: (ref: string) => void;
  /** Draft `text` in the room of the area named `area`; never sends. */
  onAsk: (area: string, text: string) => void;
}) {
  const areas = data?.areas ?? [];
  const foreground = useMemo(() => areas.filter((a) => a.status === "foreground"), [areas]);
  const background = useMemo(() => areas.filter((a) => a.status !== "foreground"), [areas]);
  const needs = useMemo(() => (data ? todayNeeds(data.today?.today ?? null, Object.fromEntries(Object.entries(data.briefs).map(([k, v]) => [k, v.brief])), foreground.map((a) => a.name), now) : []), [data, foreground, now]);
  const byName = (name: string | null) => areas.find((a) => a.name === name) ?? null;
  const askable = (name: string | null) => { const a = byName(name); return !!a && !!pickRoom(a.channels, null); };
  const fresh = data?.today ? updatedLabel(data.today.updatedAt, now) : "";
  return <div className="areas-home today-home">
    <header className="areas-head">
      <span className="eyebrow">Unforced</span><h1>Today</h1><p>{dateLine(now)}{fresh && <span className="today-fresh"> · {fresh}</span>}</p>
    </header>
    {error && <p className="note-error" role="alert">Couldn't load areas: {error}</p>}
    {!areas.length && !error && <p className="empty">{loading ? "Loading areas…" : "No areas yet. Tag a note `area` at Areas/<Name>."}</p>}
    {areas.length > 0 && <section className="today-needs" aria-label="Needs you today">
      <h2>Needs you today</h2>
      {needs.length === 0
        ? <p className="area-quiet">{data && (data.today || Object.keys(data.briefs).length) ? "Nothing needs you today." : "Uni hasn't written Today yet."}</p>
        : <ol className="needs-list">{needs.map((n, i) => <li key={i}>
          {n.area && byName(n.area) && <button type="button" className="need-area" onClick={() => onOpen(byName(n.area)!)}>{n.area}</button>}
          <span className="brief-item"><InlineText tokens={n.tokens} onNote={onNote} /></span>
          {n.area && askable(n.area) && <button type="button" className="pairing-secondary brief-ask" aria-label={`Ask Uni about: ${n.text}`} onClick={() => onAsk(n.area!, askDraft("needsYou", n.area!, n))}>Ask Uni</button>}
        </li>)}</ol>}
    </section>}
    {foreground.length > 0 && <section aria-label="Foreground areas"><h2 className="today-h">Areas</h2><div className="areas-grid">{foreground.map((a) => <AreaCard key={a.id} area={a} data={data!} now={now} onOpen={onOpen} />)}</div></section>}
    {background.length > 0 && <details className="today-background"><summary>Background areas <span className="brief-count">{background.length}</span></summary>
      <div className="areas-grid">{background.map((a) => <AreaCard key={a.id} area={a} data={data!} now={now} onOpen={onOpen} />)}</div></details>}
  </div>;
}
