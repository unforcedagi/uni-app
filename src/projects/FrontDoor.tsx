// T-301/T-302: the front door. Tapping Uni shows every area's room, each with one line on where it stands. Calm: a name, a line, when
// the room last talked, and a small mark when sessions are working there. No ids. Above the rooms, one quiet line on what needs you
// (round 2: #Uni is archived, so this is where it lives); under them, one quiet line on the Claude accounts, which opens the full card.
// T-304: the working mark counts the room's Uni at work on your message too, not only Claude Code sessions.
import { roomTint } from "../glow/roomTint";
import { sameWords } from "../areas/sameWords";
import { useRef, useCallback, useMemo, useState, type ReactNode } from "react";
import { AllComposer, AllFeed, roomWords, useEchoes, useReplyTarget, useRoomsFeed, type AllRoom } from "../all/AllView";
import { liveInArea, span } from "./model";
import { asOf, useWork } from "./store";
import { useRoomTurns } from "./roomTurns";
import { UsageLine } from "./UsageLine";
import { unreadShort, unreadWords, type Unread } from "../areas/roomUnread";
import "./projects.css";

export type Door = { path: string; name: string; slug: string | null; stands: string | null; lastTs: number | null;
  /** The area note's own one line on what it is (never a private area's): the route's description of it. */ about?: string | null;
  /** The area's own room (its id), where a turn of the room's Uni is looked for; null when it has none of its own. */ room?: string | null;
  /** T-335: what is new in the area's rooms (its own and its projects'), and how many things there need you. */ unread?: Unread | null; needs?: number };
/** T-335: a room outside the doors (one no area holds) with something new in it. */
export type NewRoom = { id: string; name: string; unread: Unread };
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

/** T-335: the rooms no door holds that have something new, each one tap into its room. Nothing when there is nothing new there. */
function NewLine({ rooms, onOpen }: { rooms: readonly NewRoom[]; onOpen: (id: string) => void }) {
  if (!rooms.length) return null;
  return <section className="fd-new" aria-label="New in other rooms">
    <span className="fd-new-h">New in other rooms</span>
    <ul>{rooms.map((r) => <li key={r.id}><button type="button" data-room={r.id} aria-label={`#${r.name.replace(/^#/, "")}, ${unreadWords(r.unread)}`} onClick={() => onOpen(r.id)}>
      #{r.name.replace(/^#/, "")}<span className={`fd-count${r.unread.mention ? " at" : ""}`} aria-hidden="true">{unreadShort(r.unread.n)}</span></button></li>)}</ul>
  </section>;
}

const today = () => new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

const NONE: readonly AllRoom[] = [];

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];
const count = (n: number) => WORDS[n] ?? String(n);
/** T-335 glow-up: the day in one or two short sentences: what needs you, then what is moving. */
/** T-335 as Aaron: nothing happening is good news, and it needn't read the same every day. One line a day, the same all day. */
export const QUIET_LINES = ["All quiet.", "The rooms are resting.", "The mycelium has it.", "Go look at a tree.", "Nothing's on fire.", "Breathe out.", "The garden keeps itself today."];
export const quietLine = (day: number) => QUIET_LINES[((day % QUIET_LINES.length) + QUIET_LINES.length) % QUIET_LINES.length];
export function statement(needs: number, moving: number, day = 0, known = true): string[] {
  if (!known && !needs) return ["Looking in on your places.", moving ? `${count(moving)} place${moving === 1 ? " is" : "s are"} moving.` : ""].filter(Boolean);
  const first = needs ? `${count(needs)} thing${needs === 1 ? " needs" : "s need"} you.` : "Nothing needs you.";
  const second = moving ? `${count(moving)} place${moving === 1 ? " is" : "s are"} moving.` : needs ? "The rest is quiet." : quietLine(day);
  return [first, second];
}

/** Uni's mark: a one-breath brush circle. */
const Enso = () => <svg className="enso" viewBox="0 0 40 40" width="22" height="22" aria-hidden="true"><path pathLength="100" d="M29.5 8.8C24.6 5.2 14.8 5 9.3 11.6 4.6 17.3 5.6 27.4 12.6 32.2c7.2 4.9 17.4 2.9 21.2-4.3 3.3-6.3 1.6-13.4-3.1-17.4" /></svg>;

/** T-335 as Aaron: the places on one thread: each a knot in its room's colour, a place at work breathing, one that needs you ochre. Says nothing the list doesn't; it's the shape of the day at a glance. */
function Weave({ doors, liveOf }: { doors: readonly Door[]; liveOf: (d: Door) => number }) {
  const n = doors.length;
  if (n < 2) return null;
  const W = 400, H = 24, mid = H / 2;
  const at = (i: number) => (i + 0.5) * (W / n);
  const y = (i: number) => mid + (i % 2 ? 4.5 : -4.5);
  let line = `M0 ${mid}`;
  doors.forEach((_, i) => { const x = at(i), c = W / n / 2; line += ` C${(x - c).toFixed(1)} ${(i % 2 ? y(i - 1) : y(i + 1)).toFixed(1)} ${(x - c / 2).toFixed(1)} ${y(i).toFixed(1)} ${x.toFixed(1)} ${y(i)}`; });
  line += ` S${W - 8} ${mid} ${W} ${mid}`;
  return <span className="fd-weave" aria-hidden="true"><svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"><path d={line} vectorEffect="non-scaling-stroke" /></svg>
    {doors.map((d, i) => <i key={d.path} className={`fd-knot${liveOf(d) > 0 ? " live" : ""}${(d.needs ?? 0) > 0 ? " needs" : ""}${d.unread ? " fresh" : ""}`} style={{ left: `${(at(i) / W) * 100}%`, top: y(i), ...(d.room ? { ["--room-tint" as string]: roomTint(d.room) } : {}) }} />)}
  </span>;
}

/** When the room last talked, in words ("talked 3 h ago"). */
const talked = (now: number, ts: number) => { const s = span(now - ts * 1000); return s === "just now" ? "talking now" : `talked ${s} ago`; };

/** "Uni is answering here and 2 sessions are working", for the mark's label. */
function workingWords(sessions: number, turn: boolean): string {
  const s = sessions ? `${sessions} session${sessions === 1 ? " is" : "s are"} working` : "";
  return turn ? `Uni is answering here${s ? ` and ${s}` : ""}` : s;
}

/** T-335: All before the rooms are read, or when no area has a room of its own: it says which, never another screen under All's name. */
export function AllEmpty({ reading, error = null, onBack }: { reading: boolean; error?: (() => void) | null; onBack: () => void }) {
  return <div className="fd fd-all all-empty" data-place="front-door" data-view="all">
    <header className="fd-head fd-allhead">
      <div className="fd-mark"><h1 className="fd-title"><Enso />All</h1></div>
      <button type="button" className="note-action all-back" onClick={onBack}>← Back</button>
    </header>
    <p className="all-quiet" role="status">{error ? <>Couldn't read your places just now. <button type="button" className="all-link" onClick={error}>Try again</button></> : reading ? "Reading your rooms…" : "No room to show here yet. An area with a room of its own shows up here."}</p>
  </div>;
}

export function FrontDoor({ doors, needs, onOpen, me = null, newRooms = [], onOpenRoom, toPost = null, all = null, allPlace = null, onComposerFocus, needsKnown = true }: { /** T-335 as Aaron: the tasks have been read: only then may the home say nothing needs you */ needsKnown?: boolean; doors: readonly Door[]; needs?: Needs; onOpen: (path: string) => void;
  /** T-335 All view: the areas' own rooms (a private area's stay out) and how to open one at a message; null: no composer, no All. */
  all?: { rooms: readonly AllRoom[]; onOpenAt: (room: string, ref?: string) => void } | null;
  /** T-335: this is the All place (a place of its own on the rail), and the way back from it; null: the home, with the places. */
  allPlace?: { backTo: string; onBack: () => void } | null; onComposerFocus?: (on: boolean) => void;
  /** T-335: rooms outside the doors with something new, and how to open one. */ newRooms?: readonly NewRoom[]; onOpenRoom?: (id: string) => void;
  /** Your key: a turn is the room's Uni at work on your message. */ me?: string | null;
  /** T-335: the To post queue's one quiet line, under what needs you */ toPost?: ReactNode }) {
  const ws = useWork();
  const turns = useRoomTurns(doors.map((d) => ({ room: d.room ?? null, lastTs: d.lastTs })), me);
  const { work } = ws;
  const now = Date.now();
  // round 3: a read that failed, or a saved copy not read again yet, is "as of" its time; the working counts say so too
  const at = asOf(ws, now);
  const areaAt = new Map(work.areas.map((a) => [a.path, a]));
  // T-335 All view: every room at once is a place of its own on the rail; the home is always the places
  const view: "places" | "all" = allPlace && all ? "all" : "places";
  // the rooms' recent messages: the feed in All; in Places only once the composer is used (for the route's words)
  const [wantWords, setWantWords] = useState(false);
  // the same rooms keep the same list, so the feed and the route aren't read again on every redraw of the home
  const roomsKey = JSON.stringify(all?.rooms ?? NONE);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allRooms = useMemo(() => all?.rooms ?? NONE, [roomsKey]);
  const feed = useRoomsFeed(allRooms, !!all && (view === "all" || wantWords));
  const words = useMemo(() => roomWords(feed.byRoom, me), [feed.byRoom, me]);
  const openAt = all?.onOpenAt;
  const [target, setTarget] = useReplyTarget();
  const echoes = useEchoes(feed.byRoom);
  // the same function across redraws, so the feed's rows stay as they are
  const opener = useRef(openAt);
  opener.current = openAt;
  const openFromFeed = useCallback((room: string, ref: string) => opener.current?.(room, ref), []);
  const composer = all && <AllComposer rooms={allRooms} words={words} onOpen={(id) => openAt?.(id)} onFocus={() => setWantWords(true)} onSent={feed.reread} place={view}
    target={target} onTarget={setTarget} echo={echoes.send} onKeyboard={onComposerFocus} />;
  // T-335 glow-up: how many places are moving (a session or the room's Uni at work), for the home's one sentence
  const liveOf = (d: Door) => { const a = areaAt.get(d.path); return (a ? liveInArea(work, a.id).length : 0) + (d.room && turns.has(d.room) ? 1 : 0); };
  const moving = doors.filter((d) => liveOf(d) > 0).length;
  const needN = needs ? needs.rows.length + needs.privates.reduce((k, p) => k + p.count, 0) : 0;
  if (all && view === "all") return <div className="fd fd-all" data-place="front-door" data-view="all">
    <header className="fd-head fd-allhead">
      <div className="fd-mark"><h1 className="fd-title"><Enso />All</h1><span className="fd-date">Every room, newest at the bottom</span></div>
      <button type="button" className="note-action all-back" onClick={allPlace!.onBack}>← {allPlace!.backTo}</button>
    </header>
    <AllFeed rooms={allRooms} byRoom={feed.byRoom} loaded={feed.loaded} failed={feed.failed} me={me} onOpen={openFromFeed} target={target} onTarget={setTarget} echoes={echoes.shown} />
    {composer}
  </div>;
  return <div className="fd" data-place="front-door" data-view="places">
    <header className="fd-head" data-moving={moving > 0 ? "true" : undefined}>
      <div className="fd-mark"><h1 className="fd-title"><Enso />Uni</h1><span className="fd-date">{today()}</span></div>
      <p className="fd-statement">{statement(needN, moving, Math.floor((now - new Date(now).getTimezoneOffset() * 60_000) / 86_400_000), needsKnown).map((line) => <span key={line}>{line}</span>)}</p>
    </header>
    {composer}
    {needs && <NeedsLine needs={needs} onOpen={onOpen} />}
    {toPost && <div className="fd-topost">{toPost}</div>}
    {onOpenRoom && <NewLine rooms={newRooms} onOpen={onOpenRoom} />}
    <h2 className="fd-places-h"><span>Places</span><Weave doors={doors} liveOf={liveOf} /></h2>
    <nav aria-label="Rooms"><ul className="fd-doors">{doors.map((d) => {
      const a = areaAt.get(d.path);
      const sessions = a ? liveInArea(work, a.id).length : 0;
      const turn = !!d.room && turns.has(d.room);
      const live = sessions + (turn ? 1 : 0);
      // the sessions' count is as of the work's read; a turn is read from the room now
      const when = sessions && at ? ` at ${at}` : "";
      const u = d.unread ?? null; const k = d.needs ?? 0;
      const marks = [u && unreadWords(u), k > 0 && `${k} need${k === 1 ? "s" : ""} you`].filter(Boolean).join(", ");
      return <li key={d.path}>
        <button type="button" className="fd-door" style={d.room ? { ["--room-tint" as string]: roomTint(d.room) } : undefined} data-path={d.path} data-sign={k > 0 ? "needs" : live > 0 ? "running" : u ? "new" : "quiet"} onClick={() => onOpen(d.path)}
          aria-label={`${d.name}${marks ? `, ${marks}` : ""}${live ? `, ${workingWords(sessions, turn)}${when}` : ""}${d.stands ? `. ${d.stands}` : ""}`}>
          <span className="fd-sign" aria-hidden="true"><i /></span>
          <span className="fd-name">{d.name}</span>
          {live > 0 && <span className="fd-live" data-turn={turn || undefined} title={workingWords(sessions, turn)}><i aria-hidden="true" />{live} working{when}</span>}
          {marks && <span className="fd-marks" aria-hidden="true">
            {u && <span className={`fd-new-n${u.mention ? " at" : ""}`} title={unreadWords(u)}>{unreadShort(u.n)} new{u.mention ? " · @you" : ""}</span>}
            {k > 0 && <span className="fd-need-n" title={`${k} need${k === 1 ? "s" : ""} you`}><i />{k} for you</span>}
          </span>}
          {d.stands && <span className="fd-stands">{d.stands}</span>}
          <span className="fd-foot">{d.slug && !sameWords(d.name, d.slug) && <span className="fd-slug">#{d.slug}</span>}{d.lastTs && <span className="fd-when">{talked(now, d.lastTs)}</span>}</span>
        </button>
      </li>;
    })}</ul></nav>
    {(at || ws.partial.length > 0) && <p className="fd-status" role="status">{[at && `${ws.error ? "Couldn't refresh · " : ""}As of ${at}`, ...ws.partial].filter(Boolean).join(" · ")}</p>}
    <UsageLine />
  </div>;
}
