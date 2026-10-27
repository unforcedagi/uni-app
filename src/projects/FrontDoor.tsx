// T-301/T-302: the front door. Tapping Uni shows every area's room, each with one line on where it stands. Calm: a name, a line, when
// the room last talked, and a small mark when sessions are working there. No ids. Above the rooms, one quiet line on what needs you
// (round 2: #Uni is archived, so this is where it lives); under them, one quiet line on the Claude accounts, which opens the full card.
import { useState } from "react";
import { liveInArea, span } from "./model";
import { asOf, useWork } from "./store";
import { UsageLine } from "./UsageLine";
import "./projects.css";

export type Door = { path: string; name: string; slug: string | null; stands: string | null; lastTs: number | null };
/** What needs you across the areas: each item's own words and where it sits; a private area's items only as a count. */
export type Needs = { rows: { id: string; title: string; where: string | null; path: string }[]; privates: { place: string; count: number; path: string }[] };

/** One quiet line: "Needs you · 4", which opens the list in place; each item opens its room. Nothing when nothing needs you. */
function NeedsLine({ needs, onOpen }: { needs: Needs; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const n = needs.rows.length + needs.privates.reduce((k, p) => k + p.count, 0);
  if (!n) return null;
  return <section className="fd-needs" aria-label="Needs you">
    <button type="button" className="fd-needs-line" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span>Needs you · {n}</span><i className="ps-chev" aria-hidden="true" />
    </button>
    {open && <ul className="fd-needs-list">
      {needs.rows.map((r) => <li key={r.id}><button type="button" onClick={() => onOpen(r.path)}><span>{r.title}</span>{r.where && <small>{r.where}</small>}</button></li>)}
      {needs.privates.map((p) => <li key={p.path}><button type="button" onClick={() => onOpen(p.path)}><span>In {p.place}: {p.count} thing{p.count === 1 ? "" : "s"} for you</span></button></li>)}
    </ul>}
  </section>;
}

const today = () => new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

/** When the room last talked, in words ("talked 3 h ago"). */
const talked = (now: number, ts: number) => { const s = span(now - ts * 1000); return s === "just now" ? "talking now" : `talked ${s} ago`; };

export function FrontDoor({ doors, needs, onOpen }: { doors: readonly Door[]; needs?: Needs; onOpen: (path: string) => void }) {
  const ws = useWork();
  const { work } = ws;
  const now = Date.now();
  // round 3: a read that failed, or a saved copy not read again yet, is "as of" its time; the working counts say so too
  const at = asOf(ws, now);
  const areaAt = new Map(work.areas.map((a) => [a.path, a]));
  return <div className="fd" data-place="front-door">
    <header className="fd-head">
      <p className="fd-date">{today()}</p>
      <h1 className="fd-title">Uni</h1>
      <p className="fd-sub">Your rooms</p>
    </header>
    {needs && <NeedsLine needs={needs} onOpen={onOpen} />}
    <nav aria-label="Rooms"><ul className="fd-doors">{doors.map((d) => {
      const a = areaAt.get(d.path);
      const live = a ? liveInArea(work, a.id).length : 0;
      return <li key={d.path}>
        <button type="button" className="fd-door" data-path={d.path} onClick={() => onOpen(d.path)}
          aria-label={`${d.name}${live ? `, ${live} working${at ? ` at ${at}` : ""}` : ""}${d.stands ? `. ${d.stands}` : ""}`}>
          <span className="fd-name">{d.name}</span>
          {live > 0 && <span className="fd-live" title={`${live} session${live === 1 ? "" : "s"} working`}><i aria-hidden="true" />{live} working{at ? ` at ${at}` : ""}</span>}
          {d.stands && <span className="fd-stands">{d.stands}</span>}
          <span className="fd-foot">{d.slug && <span className="fd-slug">#{d.slug}</span>}{d.lastTs && <span className="fd-when">{talked(now, d.lastTs)}</span>}</span>
        </button>
      </li>;
    })}</ul></nav>
    {(at || ws.partial.length > 0) && <p className="fd-status" role="status">{[at && `${ws.error ? "Couldn't refresh · " : ""}As of ${at}`, ...ws.partial].filter(Boolean).join(" · ")}</p>}
    <UsageLine />
  </div>;
}
