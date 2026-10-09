import { useMemo } from "react";
import type { Area } from "./areasCore";
import { askDraft, nowLine, todayNeeds, updatedLabel } from "./briefCore";
import { InlineText } from "./BriefView";
import type { AreasData } from "./useAreas";
import { pickRoom } from "./areaLayout";

export type RoomInfo = { id: string; name: string; last_message: string | null; last_ts: number | null };

const dateLine = (now: number) => new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

/** One node as a card: its Now line, how many things need you, and how fresh its Brief is. */
function NodeCard({ node, data, now, onOpen }: { node: Area; data: AreasData; now: number; onOpen: (a: Area) => void }) {
  const entry = data.briefs[node.path];
  const needs = entry?.brief.needsYou.length ?? 0;
  const now_ = entry ? nowLine(entry.brief) : "";
  const fresh = entry ? updatedLabel(entry.generatedAt ?? entry.updatedAt, now) : "";
  const mark = node.kind === "project" ? "Project" : node.status === "foreground" ? "Foreground" : "Background";
  const kids = data.tree.children.get(node.path)?.length ?? 0;
  return <button className={`area-card ${node.status} ${node.kind}`} onClick={() => onOpen(node)} aria-label={`${node.name}, ${mark.toLowerCase()}${needs ? `, ${needs} need${needs === 1 ? "s" : ""} you` : ""}`}>
    <span className={`area-mark ${node.status}`}>{mark}</span>
    <strong className="area-name">{node.name}</strong>
    <span className="area-purpose area-now">{now_ || node.purpose || "No purpose written yet."}</span>
    <span className="area-foot">
      {entry ? (needs > 0 ? <b className="needs-chip">{needs} {needs === 1 ? "needs" : "need"} you</b> : <span className="area-quiet">Nothing needs you</span>) : <span className="area-quiet">No brief yet</span>}
      {kids > 0 && <span className="area-kids">{kids} inside</span>}
      {fresh && <time className="area-fresh">{fresh}</time>}
    </span>
  </button>;
}

/** The next level down: foreground nodes as cards, background ones collapsed. */
export function ChildCards({ nodes, data, now, title, onOpen }: { nodes: readonly Area[]; data: AreasData; now: number; title: string; onOpen: (a: Area) => void }) {
  const foreground = nodes.filter((a) => a.status === "foreground" || a.kind === "project");
  const background = nodes.filter((a) => a.status !== "foreground" && a.kind !== "project");
  if (!nodes.length) return null;
  return <>
    {foreground.length > 0 && <section className="node-children" aria-label={title}><h2 className="today-h">{title}</h2><div className="areas-grid">{foreground.map((a) => <NodeCard key={a.id} node={a} data={data} now={now} onOpen={onOpen} />)}</div></section>}
    {background.length > 0 && <details className="today-background"><summary>Background areas <span className="brief-count">{background.length}</span></summary>
      <div className="areas-grid">{background.map((a) => <NodeCard key={a.id} node={a} data={data} now={now} onOpen={onOpen} />)}</div></details>}
  </>;
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
