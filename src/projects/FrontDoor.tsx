// T-301/T-302: the front door. Tapping Uni shows every area's room, each with one line on where it stands. Calm: a name, a line, when
// the room last talked, and a small mark when sessions are working there. No ids. Above the rooms, one quiet line on what needs you
// (round 2: #Uni is archived, so this is where it lives); under them, one quiet line on the Claude accounts, which opens the full card.
// T-304: the working mark counts the room's Uni at work on your message too, not only Claude Code sessions.
import { useState } from "react";
import { liveInArea, span } from "./model";
import { asOf, useWork } from "./store";
import { useRoomTurns } from "./roomTurns";
import { UsageLine } from "./UsageLine";
import "./projects.css";

export type Door = { path: string; name: string; slug: string | null; stands: string | null; lastTs: number | null;
  /** The area's own room (its id), where a turn of the room's Uni is looked for; null when it has none of its own. */ room?: string | null };
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

/** "Uni is answering here and 2 sessions are working", for the mark's label. */
function workingWords(sessions: number, turn: boolean): string {
  const s = sessions ? `${sessions} session${sessions === 1 ? " is" : "s are"} working` : "";
  return turn ? `Uni is answering here${s ? ` and ${s}` : ""}` : s;
}

export function FrontDoor({ doors, needs, onOpen, me = null }: { doors: readonly Door[]; needs?: Needs; onOpen: (path: string) => void;
  /** Your key: a turn is the room's Uni at work on your message. */ me?: string | null }) {
  const ws = useWork();
  const turns = useRoomTurns(doors.map((d) => ({ room: d.room ?? null, lastTs: d.lastTs })), me);
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
      const sessions = a ? liveInArea(work, a.id).length : 0;
      const turn = !!d.room && turns.has(d.room);
      const live = sessions + (turn ? 1 : 0);
      // the sessions' count is as of the work's read; a turn is read from the room now
      const when = sessions && at ? ` at ${at}` : "";
      return <li key={d.path}>
        <button type="button" className="fd-door" data-path={d.path} onClick={() => onOpen(d.path)}
          aria-label={`${d.name}${live ? `, ${workingWords(sessions, turn)}${when}` : ""}${d.stands ? `. ${d.stands}` : ""}`}>
          <span className="fd-name">{d.name}</span>
          {live > 0 && <span className="fd-live" data-turn={turn || undefined} title={workingWords(sessions, turn)}><i aria-hidden="true" />{live} working{when}</span>}
          {d.stands && <span className="fd-stands">{d.stands}</span>}
          <span className="fd-foot">{d.slug && <span className="fd-slug">#{d.slug}</span>}{d.lastTs && <span className="fd-when">{talked(now, d.lastTs)}</span>}</span>
        </button>
      </li>;
    })}</ul></nav>
    {(at || ws.partial.length > 0) && <p className="fd-status" role="status">{[at && `${ws.error ? "Couldn't refresh · " : ""}As of ${at}`, ...ws.partial].filter(Boolean).join(" · ")}</p>}
    <UsageLine />
  </div>;
}
