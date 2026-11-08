// T-301/T-302: the front door (0.2: the home, All's stream, with these doors in the drawer under its head; a vault without the Uni
// glue keeps them as its places page). Every area's room, each with one line on where it stands. Calm: a name, a line, when
// the room last talked, and a small mark when sessions are working there. No ids. 0.3.0: For you (src/foryou) is the top of the home, above
// the stream; the separate Needs-you list that sat in the drawer is gone. Under the rooms, one quiet line on the Claude accounts.
// T-304: the working mark counts the room's Uni at work on your message too, not only Claude Code sessions.
import { roomTint } from "../glow/roomTint";
import { sameWords } from "../areas/sameWords";
import { useEffect, useLayoutEffect, useRef, useCallback, useMemo, useState, type ReactNode } from "react";
import { AllComposer, AllFeed, roomWords, useEchoes, useReplyTarget, useRoomsFeed, type AllRoom } from "../all/AllView";
import { roomAddress } from "../all/allCore";
import { liveSessions, liveInArea, sessionsOf, span, UNFILED } from "./model";
import { asOf, useWork } from "./store";
import { useRoomTurns } from "./roomTurns";
import { UsageLine } from "./UsageLine";
import { unreadShort, unreadWords, type Unread } from "../areas/roomUnread";
import "./projects.css";

export type Door = { path: string; name: string; slug: string | null; stands: string | null; lastTs: number | null;
  /** The area note's own one line on what it is (never a private area's): the route's description of it. */ about?: string | null;
  /** The area's own room (its id), where a turn of the room's Uni is looked for; null when it has none of its own. */ room?: string | null;
  /** T-335: what is new in the area's rooms (its own and its projects'), and how many things there need you. */ unread?: Unread | null; needs?: number };
/** 0.3.1: an area's own stream: its path and name, and its rooms (its own first). */
export type Scope = { path: string; name: string; rooms: readonly AllRoom[] };

/** 0.3.1: the stream's scope, one tap each: every area's rooms, or one area's. The same stream, never another screen; All is always the first
 *  chip, so the way back to every room is one tap (Back and Escape too). Shown when there is more than one area to choose from. */
function ScopeRow({ rooms, scope, onScope, onOpenScope }: { rooms: readonly AllRoom[]; scope: Scope | null; onScope: (path: string | null) => void; onOpenScope?: (path: string) => void }) {
  const row = useRef<HTMLElement>(null);
  // the chosen area's chip is in sight (a row wider than a phone scrolls sideways)
  useLayoutEffect(() => { const on = row.current?.querySelector<HTMLElement>('[aria-pressed="true"]'); const r = row.current; if (on && r) r.scrollLeft = Math.max(0, on.offsetLeft - (r.clientWidth - on.offsetWidth) / 2); }, [scope?.path]);
  return <div className="all-scope">
    <nav className="all-scope-row" aria-label="Show in the stream" ref={row}>
      <button type="button" className="all-scope-chip" aria-pressed={!scope} onClick={() => onScope(null)}>All</button>
      {rooms.map((r) => r.path && <button key={r.id} type="button" className="all-scope-chip" aria-pressed={scope?.path === r.path} style={{ ["--room-tint" as string]: roomTint(r.id) }}
        onClick={() => onScope(scope?.path === r.path ? null : r.path!)}><i aria-hidden="true" />{r.name}</button>)}
    </nav>
    {scope && <p className="all-scope-line"><span>{scope.rooms.length > 1 ? `${andWords(scope.rooms.map((r) => roomAddress(r)))}, by time` : `${roomAddress(scope.rooms[0])}, by time`}</span>
      {onOpenScope && <button type="button" className="all-link" onClick={() => onOpenScope(scope.path)}>Open {scope.name} ›</button>}</p>}
  </div>;
}
const andWords = (l: readonly string[]) => (l.length < 2 ? l.join("") : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`);

/** T-335: a room outside the doors (one no area holds) with something new in it. */
export type NewRoom = { id: string; name: string; unread: Unread };
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
export type NeedsKnown = "known" | "reading" | "failed";
export function statement(needs: number, moving: number, day = 0, known: NeedsKnown = "known"): string[] {
  if (known !== "known" && !needs) return [known === "failed" ? "Couldn't check what needs you." : "Looking in on your places.", moving ? `${count(moving)} place${moving === 1 ? " is" : "s are"} moving.` : ""].filter(Boolean);
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
export function AllEmpty({ reading, error = null }: { reading: boolean; error?: (() => void) | null; onBack?: () => void }) {
  return <div className="fd fd-all fd-home all-empty" data-place="front-door" data-view="all">
    <header className="fd-head fd-homehead">
      <div className="fd-mark"><h1 className="fd-title"><Enso />Uni</h1><span className="fd-date">{today()}</span></div>
    </header>
    <p className="all-quiet" role="status">{error ? <>Couldn't read your places just now. <button type="button" className="all-link" onClick={error}>Try again</button></> : reading ? "Reading your rooms…" : "No room to show here yet. An area with a room of its own shows up here."}</p>
  </div>;
}

/** T-335 one surface: the rooms no area holds, all of them, folded under one line (the tree beside a room used to list them). */
function OtherRooms({ rooms, onOpen }: { rooms: readonly { id: string; name: string }[]; onOpen: (id: string) => void }) {
  if (!rooms.length) return null;
  return <details className="fd-others"><summary>Other rooms · {rooms.length}</summary>
    <ul>{rooms.map((r) => <li key={r.id}><button type="button" data-room={r.id} onClick={() => onOpen(r.id)}>#{r.name.replace(/^#/, "")}</button></li>)}</ul></details>;
}

export function FrontDoor({ onOpenProject, doors, forYou = null, yours = 0, onOpen, me = null, newRooms = [], otherRooms = [], noAreas, onOpenRoom, toPost = null, all = null, allPlace = null, onComposerFocus, needsKnown = "known", alsoNeeds = 0, onRetryNeeds, pulled = false, onPull, approvals = null }: {
  /** 0.2 one home: the head's drawer (your OK, To post, the places) is open, and how to open or close it */ pulled?: boolean; onPull?: (open: boolean) => void;
  /** 0.2: the approval prompts waiting, in the drawer under their own heading */ approvals?: ReactNode;
  /** 0.3.0: For you, the top of the home (Yours, Ready to look at, Moving), and how many things in it are his */ forYou?: ReactNode; yours?: number;
  /** T-335 one surface: every room no area holds, folded under one line */ otherRooms?: readonly { id: string; name: string }[];
  /** No areas yet (once that is known): the home says so, with the way to the old #Uni where an account still has one (archived 10-26) */ noAreas?: (() => void) | null; /** T-335 as Aaron: only once the tasks have been read, fresh and whole, may the home say nothing needs you */ needsKnown?: NeedsKnown; /** approvals waiting, which For you doesn't count */ alsoNeeds?: number; onRetryNeeds?: () => void; doors: readonly Door[]; onOpen: (path: string) => void;
  /** T-335 All view: the areas' own rooms (a private area's stay out) and how to open one at a message; null: no composer, no All. */
  all?: { rooms: readonly AllRoom[]; onOpenAt: (room: string, ref?: string | null, root?: string | null) => void;
    /** 0.3.1: the stream's scope: one area's rooms (its own and the places' inside it), shown by time in place of every area's; null: all of them. */
    scope?: Scope | null; onScope?: (path: string | null) => void; onOpenScope?: (path: string) => void } | null;
  /** 0.2: this is the home (All's stream, the drawer under its head); null: the places page of a vault without the Uni glue. */
  allPlace?: { backTo: string; onBack: () => void; /** A room in focus over All. */ focusRoom?: string | null } | null; onComposerFocus?: (on: boolean) => void;
  /** T-335: rooms outside the doors with something new, and how to open one. */ newRooms?: readonly NewRoom[]; onOpenRoom?: (id: string) => void;
  /** Your key: a turn is the room's Uni at work on your message. */ me?: string | null;
  /** T-335: the To post queue's one quiet line, in the drawer */ toPost?: ReactNode;
  /** Opens a project or home in place (here: the Unfiled sessions). */ onOpenProject?: (id: string) => void }) {
  const ws = useWork();
  const turns = useRoomTurns(doors.map((d) => ({ room: d.room ?? null, lastTs: d.lastTs })), me);
  const { work } = ws;
  const now = Date.now();
  // round 3: a read that failed, or a saved copy not read again yet, is "as of" its time; the working counts say so too
  const at = asOf(ws, now);
  const areaAt = new Map(work.areas.map((a) => [a.path, a]));
  // 0.2 one home: with rooms, the home is All's stream with the places folded under its head (no rooms with an area yet: the places, open)
  const view: "places" | "all" = allPlace ? "all" : "places";
  // the rooms' recent messages: the feed in All; in Places only once the composer is used (for the route's words)
  const [wantWords, setWantWords] = useState(false);
  // the same rooms keep the same list, so the feed and the route aren't read again on every redraw of the home
  const roomsKey = JSON.stringify(all?.rooms ?? NONE);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allRooms = useMemo(() => all?.rooms ?? NONE, [roomsKey]);
  // 0.3.1: an area's stream shows its rooms (its own and those inside it); the feed reads them with every area's, so All is still there when you come back
  const scope = all?.scope ?? null;
  const scopeKey = JSON.stringify(scope?.rooms ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shownRooms = useMemo(() => scope?.rooms ?? allRooms, [scopeKey, allRooms]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const readRooms = useMemo(() => (scope ? [...allRooms, ...scope.rooms.filter((r) => !allRooms.some((a) => a.id === r.id))] : allRooms), [scopeKey, allRooms]);
  const feed = useRoomsFeed(readRooms, !!all && (view === "all" || wantWords));
  const words = useMemo(() => roomWords(feed.byRoom, me), [feed.byRoom, me]);
  const openAt = all?.onOpenAt;
  // T-335 one fluid surface: what you said in a room in focus is in All when you come back (a message of your own may bring no live event)
  const focusRoom = allPlace?.focusRoom ?? null;
  const focusWas = useRef<string | null>(null);
  useEffect(() => { if (focusWas.current && focusWas.current !== focusRoom) feed.reread([focusWas.current]); focusWas.current = focusRoom; }, [focusRoom, feed.reread]); // eslint-disable-line react-hooks/exhaustive-deps
  const [target, setTarget] = useReplyTarget();
  const echoes = useEchoes(feed.byRoom);
  // the same function across redraws, so the feed's rows stay as they are
  const opener = useRef(openAt);
  opener.current = openAt;
  const openFromFeed = useCallback((room: string, ref: string | null, root?: string | null) => opener.current?.(room, ref, root), []);
  const composer = all && <AllComposer rooms={shownRooms} words={words} onOpen={(id) => openAt?.(id)} onFocus={() => setWantWords(true)} onSent={feed.reread} place={view === "all" && (pulled || !all) ? "places" : view}
    target={target} onTarget={setTarget} echo={echoes.send} onKeyboard={onComposerFocus} />;
  // T-335 glow-up: how many places are moving (a session or the room's Uni at work), for the home's one sentence
  const liveOf = (d: Door) => { const a = areaAt.get(d.path); return (a ? liveInArea(work, a.id).length : 0) + (d.room && turns.has(d.room) ? 1 : 0); };
  // working sessions with no area are somewhere moving too
  const moving = doors.filter((d) => liveOf(d) > 0).length + (liveSessions(work, UNFILED).length > 0 ? 1 : 0);
  // 0.3.0: the sentence counts what For you holds for him (and the approvals waiting): the list right under it. (A door's mark is its
  // room's own count, by the details' rule, which also counts a session waiting on him.)
  const needN = yours + alsoNeeds;
  const day = Math.floor((now - new Date(now).getTimezoneOffset() * 60_000) / 86_400_000);
  const lines = statement(needN, moving, day, needsKnown);
  const doorList = <nav aria-label="Rooms"><ul className="fd-doors">{doors.map((d) => {
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
    })}</ul></nav>;
  const unfiled = onOpenProject && work.projects.some((p) => p.id === UNFILED) ? (() => {
    const n = liveSessions(work, UNFILED).length;
    return <button type="button" className="fd-unfiled" onClick={() => onOpenProject(UNFILED)}>Unfiled sessions · {sessionsOf(work, UNFILED).length}{n > 0 && <span className="fd-live"><i aria-hidden="true" />{n} working{at ? ` at ${at}` : ""}</span>}</button>;
  })() : null;
  const health = (at || ws.partial.length > 0) ? <p className="fd-status" role="status">{[at && `${ws.error ? "Couldn't refresh · " : ""}As of ${at}`, ...ws.partial].filter(Boolean).join(" · ")}</p> : null;
  if (view === "all") {
    // 0.2 one home: the day in one sentence is the head; one tap pulls down the approvals waiting, To post and every place. 0.3.0: For you
    // is the top of the home, under the head and over the stream (the retired Aaron/For you note is never read). No rooms with an area yet: the places, open.
    const open = pulled || !all;
    return <div className="fd fd-all fd-home" data-place="front-door" data-view="all" data-pulled={open ? "true" : undefined}>
      <header className="fd-head fd-homehead" data-moving={moving > 0 ? "true" : undefined}>
        <div className="fd-mark"><h1 className="fd-title"><Enso />Uni</h1><span className="fd-date">{today()}</span></div>
        <button type="button" className="fd-pull" aria-expanded={open} aria-controls={open ? "fd-drawer" : undefined} disabled={!all} onClick={() => onPull?.(!pulled)}
          aria-label={`${lines.join(" ")} ${open ? "Close" : "Open"} your places`}>
          {/* 0.3.1: with For you on the home its head is the day's line (what is yours, to look at, moving); the sentence stays its label */}
          {!forYou && <span className="fd-statement">{lines.map((line) => <span key={line}>{line}</span>)}</span>}
          <span className="fd-pull-row" aria-hidden="true"><Weave doors={doors} liveOf={liveOf} />{all && <><span className="fd-pull-word">Places</span><i className="ps-chev" /></>}</span>
        </button>
      </header>
      <div className="fd-body">
      {open && <div id="fd-drawer" className="fd-drawer" role="region" aria-label="Your places">
        {needsKnown === "failed" && !needN && onRetryNeeds && <button type="button" className="note-action fd-retry" onClick={onRetryNeeds}>Try again</button>}
        {approvals && <section className="fd-ok" aria-label="Waiting for your OK"><h2 className="fd-sec-h">Waiting for your OK</h2>{approvals}</section>}
        {toPost && <div className="fd-lines"><div className="fd-topost">{toPost}</div></div>}
        {onOpenRoom && <NewLine rooms={newRooms} onOpen={onOpenRoom} />}
        <h2 className="fd-sec-h">Places</h2>
        {doorList}
        {unfiled}
        {noAreas !== undefined && <p className="fd-none">No areas yet. Tell Uni in any room what you want to look after, and it will set up your first area.{noAreas && <> <button type="button" className="all-link" onClick={noAreas}>Talk to Uni</button></>}</p>}
        {onOpenRoom && <OtherRooms rooms={otherRooms} onOpen={onOpenRoom} />}
        {health}
      </div>}
      {/* under the drawer the stream is out of reach (keys, screen readers) until it is put away */}
      {forYou && <div className="fy-wrap" inert={open}>{forYou}</div>}
      <div className="fd-stream" inert={open}>
        {all && all.onScope && allRooms.length > 1 && <ScopeRow rooms={allRooms} scope={scope} onScope={all.onScope} onOpenScope={all.onOpenScope} />}
        {all ? <AllFeed key={scope?.path ?? ""} scope={scope?.path ?? ""} rooms={shownRooms} byRoom={feed.byRoom} loaded={feed.loaded} failed={feed.failed} me={me} onOpen={openFromFeed} target={target} onTarget={setTarget} echoes={echoes.shown} receded={!!focusRoom || open} /> : <div className="all-feed-box" />}</div>
      </div>
      {composer}
    </div>;
  }
  return <div className="fd" data-place="front-door" data-view="places">
    <header className="fd-head" data-moving={moving > 0 ? "true" : undefined}>
      <div className="fd-mark"><h1 className="fd-title"><Enso />Uni</h1><span className="fd-date">{today()}</span></div>
      <p className="fd-statement">{lines.map((line) => <span key={line}>{line}</span>)}</p>
      {needsKnown === "failed" && !needN && onRetryNeeds && <button type="button" className="note-action fd-retry" onClick={onRetryNeeds}>Try again</button>}
    </header>
    {forYou}
    {composer}
    {approvals && <section className="fd-ok" aria-label="Waiting for your OK"><h2 className="fd-sec-h">Waiting for your OK</h2>{approvals}</section>}
    {toPost && <div className="fd-topost">{toPost}</div>}
    {onOpenRoom && <NewLine rooms={newRooms} onOpen={onOpenRoom} />}
    <h2 className="fd-places-h"><span>Places</span><Weave doors={doors} liveOf={liveOf} /></h2>
    {doorList}
    {unfiled}
    {noAreas !== undefined && <p className="fd-none">No areas yet. Tell Uni in any room what you want to look after, and it will set up your first area.{noAreas && <> <button type="button" className="all-link" onClick={noAreas}>Talk to Uni</button></>}</p>}
    {onOpenRoom && <OtherRooms rooms={otherRooms} onOpen={onOpenRoom} />}
    {health}
    <UsageLine />
  </div>;
}
