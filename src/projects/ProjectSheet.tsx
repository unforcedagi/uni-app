// T-301/T-302: a project, opened in place over its room (a sheet on a phone, a drawer beside the room on a wide screen). It is for
// watching (round 2: Uni decides how sessions are used): its folder, a thin line of when its sessions ran against when the room talked,
// its sessions (live ones first: what each is doing now, its steps, and why it started when there is more than one; then its history,
// with what each left). What you can still ask (Stop, Fresh start, Add a session, Archive, Bring back) sits behind one small "…" menu;
// each is a message in the area's room, shown word for word before it is posted, and the room's Uni does it. Nothing here names an id.
// T-304: every session opens in place (SessionView): a live view of a working one, the report and why it ended of one that has ended, and
// the exact ask of one that needs you, with a way to answer it in the room.
import { useEffect, useId, useRef, useState } from "react";
import { openDialog } from "../areas/focusTrap";
import { actionLabel, actionMessage, postAction, type Action } from "./actions";
import { ago, archivePlan, areaOf, cannotStart, isLive, sessionsOf, span, stateWords, timeline, timelineWindow, whyWords, type Session } from "./model";
import { asOf, noteAsked, useWork, type Asked } from "./store";
import { SessionView } from "./SessionView";
import "./projects.css";

const DAY = 86_400_000;
/** Ended sessions shown before "Earlier". */
const RECENT = 5;
/** Ticks drawn at most (more steps than this show as a number). */
const TICKS = 24;

/** Re-render every so often, so "Working · 12 min" keeps time. */
function useNow(ms = 15_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

function Ticks({ s }: { s: Session }) {
  if (!s.steps) return null;
  const shown = Math.min(TICKS, s.steps);
  return <span className="pj-ticks" role="img" aria-label={`${s.steps} step${s.steps === 1 ? "" : "s"} so far`}>
    {Array.from({ length: shown }, (_, i) => <i key={i} className={i === shown - 1 ? "now" : ""} />)}
    {s.steps > TICKS && <small aria-hidden="true">{s.steps}</small>}
  </span>;
}

type Room = { id: string; name: string };

/** An action picked from the menu: the exact words and where they go, with Post and Cancel. Nothing is posted before Post. */
function Confirm({ action, room, onPosted, onCancel }: { action: Action; room: Room | null; onPosted: () => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const post = async () => {
    if (!room) return;
    setBusy(true); setError(null);
    try { await postAction(room.id, action); onPosted(); } catch { setError("Couldn't post that. Try again in a moment."); } finally { setBusy(false); }
  };
  return <div className="pj-confirm" role="group" aria-label={`${actionLabel[action.kind]}: what will be posted`} data-act={action.kind}>
    <p className="pj-confirm-to">Posts in #{room?.name.replace(/^#/, "")}, as you:</p>
    <blockquote className="pj-confirm-text">{actionMessage(action)}</blockquote>
    {error && <p className="note-error" role="alert">{error}</p>}
    <div className="pj-row"><span className="pj-gap" />
      <button type="button" className="task-do quiet" onClick={onCancel}>Cancel</button>
      <button type="button" className="task-do primary pj-post" disabled={busy || !room} onClick={() => void post()}>{busy ? "Posting…" : "Post"}</button>
    </div>
  </div>;
}

/** What the menu offers: per live session Stop and Fresh start (named by its line), then Add a session, then Archive or Bring back. */
type Pick = { key: string; label: string; act: Action["kind"]; action: Action | null };

/** The one small "…" menu: a list of what can be asked; picking one shows its words (Confirm) before anything is posted. */
function ActionsMenu({ picks, onPick }: { picks: readonly Pick[]; onPick: (p: Pick) => void }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  if (!picks.length) return null;
  return <div className="pj-menu">
    <button type="button" className="pj-more" aria-label="Actions" aria-haspopup="true" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(!open)}>…</button>
    {open && <ul id={menuId} className="pj-menu-list" aria-label="Ask the room">{picks.map((p) =>
      <li key={p.key}><button type="button" data-act={p.act} onClick={() => { setOpen(false); onPick(p); }}>{p.label}</button></li>)}</ul>}
  </div>;
}

const askedWords = (a: Asked, now: number) => `Asked the room to ${a.kind === "fresh" ? "start it fresh" : a.kind === "stop" ? "stop it" : a.kind === "archive" ? "archive it" : a.kind === "restore" ? "bring it back" : "add a session"} · ${ago(now - a.at)}`;

function SessionCard({ s, all, now, asked, onOpen }: { s: Session; all: readonly Session[]; now: number; asked: Asked | null; onOpen: () => void }) {
  const live = isLive(s);
  // "alongside" says why there are several while they work; in the history it is noise (a fresh start or a pick-up stays)
  const why = live || s.why?.kind !== "alongside" ? whyWords(s, all) : null;
  return <li className={`pj-session ${s.state}`} data-session={s.id} data-state={s.state}>
    <p className="pj-state"><i aria-hidden="true" />{stateWords(s, now)}</p>
    <h3 className="pj-ask"><button type="button" className="pj-open" onClick={onOpen}><span>{s.ask}</span><i className="ps-chev" aria-hidden="true" /></button></h3>
    {why && <p className="pj-why">{why}</p>}
    {live && <p className="pj-now"><Ticks s={s} /><span>{s.now ?? "Working; it hasn't said on what yet."}</span>{s.nowAt && <small>{ago(now - s.nowAt)}</small>}</p>}
    {s.result && <p className="pj-result">{s.result}</p>}
    {asked && <p className="pj-asked" role="status">{askedWords(asked, now)}</p>}
    {s.video && <div className="pj-row"><a className="pj-link" href={s.video} target="_blank" rel="noreferrer">Watch the walkthrough</a></div>}
  </li>;
}

/** When the sessions ran (bars) against when the room talked (ticks), over the last days. */
function Timeline({ sessions, talk, now }: { sessions: readonly Session[]; talk: readonly number[]; now: number }) {
  const { from } = timelineWindow(sessions, now);
  const t = timeline(sessions, talk, from, now);
  if (!t.runs.length) return null;
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const lanes = Math.max(1, ...t.runs.map((r) => r.lane + 1));
  return <figure className="pj-time" aria-label={`When the sessions ran, against the room's talk, over the last ${span(now - from)}`}>
    <div className="pj-time-track" style={{ height: 18 + Math.min(lanes, 6) * 11 }}>
      {t.talk.map((x, i) => <i key={`t${i}`} className="pj-talk" style={{ left: pct(x) }} />)}
      {t.runs.map((r) => <i key={r.id} className={`pj-run ${r.live ? "live" : ""}`} style={{ left: pct(r.x), width: pct(r.w), bottom: 3 + Math.min(r.lane, 5) * 11 }} />)}
    </div>
    <figcaption><span>{span(now - from)} ago</span><span className="pj-key"><i className="pj-talk-key" />the room talked <i className="pj-run-key" />a session ran</span><span>now</span></figcaption>
  </figure>;
}

export function ProjectSheet({ project, talk, room, roomName, onClose, onAnswer }: { project: string; talk: readonly number[]; room: Room | null;
  /** A room's name by its id (the area's own room may not be the one under the sheet). */ roomName: (id: string) => string | null; onClose: () => void;
  /** T-304: puts words in a room's composer (and closes the sheet), to answer a session that needs you. */ onAnswer?: (room: string, text: string) => void }) {
  const ws = useWork();
  const { work, asked, ready } = ws;
  const now = useNow();
  const p = work.projects.find((x) => x.id === project);
  const [pick, setPick] = useState<Pick | null>(null);
  const [ask, setAsk] = useState("");
  /** T-304: the session opened in place of the list (null: the list). */
  const [opened, setOpened] = useState<string | null>(null);
  const backTo = useRef<string | null>(null);
  /** Whether "Earlier" is open: kept here, so going into an earlier session and back finds it as it was. */
  const [earlierOpen, setEarlierOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const titleId = useId();
  const shown = !!p;
  useEffect(() => (shown && box.current && wrap.current ? openDialog(box.current, () => closeRef.current(), { root: wrap.current, initial: box.current }) : undefined), [shown]);
  // a project that is gone after a read (merged, its folder taken away) closes its sheet rather than leaving an empty one
  useEffect(() => { if (!shown && ready) closeRef.current(); }, [shown, ready]);
  // back from a session: the list, scrolled to where it was, with that session's line focused
  useEffect(() => {
    if (opened || !backTo.current) return;
    box.current?.querySelector<HTMLButtonElement>(`[data-session="${CSS.escape(backTo.current)}"] button`)?.focus();
    backTo.current = null;
  }, [opened]);
  if (!p) return null;
  const at = asOf(ws, now);
  const area = areaOf(work, p);
  // the area's own room is where its actions go (the room this sheet is over, when it is the area's)
  const to = area ? (room && room.id === area.room ? room : { id: area.room, name: roomName(area.room) ?? area.name }) : room;
  const sessions = sessionsOf(work, p.id);
  const liveOnes = sessions.filter(isLive);
  const ended = sessions.filter((s) => !isLive(s));
  const recent = ended.filter((s, i) => i < RECENT || now - (s.endedAt ?? 0) < DAY);
  const earlier = ended.slice(recent.length);
  const projectAsked = asked.get(p.id) ?? null;
  const addAsked = asked.get(`add:${p.id}`) ?? null;
  const short = (t: string) => (t.length > 48 ? `${t.slice(0, 47).trimEnd()}…` : t);
  const picks: Pick[] = !to ? [] : [
    ...liveOnes.filter((s) => !asked.get(s.id)).flatMap((s): Pick[] => [
      { key: `stop:${s.id}`, label: `Stop “${short(s.ask)}”`, act: "stop", action: { kind: "stop", project: p, session: s } },
      { key: `fresh:${s.id}`, label: `Fresh start of “${short(s.ask)}”`, act: "fresh", action: { kind: "fresh", project: p, session: s } },
    ]),
    ...(cannotStart(p) || addAsked ? [] : [{ key: "add", label: "Add a session", act: "add" as const, action: null }]),
    ...(projectAsked ? [] : p.status === "archived"
      ? [{ key: "restore", label: "Bring back", act: "restore" as const, action: { kind: "restore" as const, project: p } }]
      : [{ key: "archive", label: liveOnes.length ? "Archive (stops its sessions first)" : "Archive", act: "archive" as const, action: { kind: "archive" as const, project: p, live: archivePlan(work, p.id).stopFirst } }]),
  ];
  const done = () => { setPick(null); setAsk(""); };
  const open = (id: string) => { backTo.current = id; setOpened(id); if (box.current) box.current.scrollTop = 0; };
  const openedSession = opened ? sessions.find((s) => s.id === opened) ?? null : null;
  // a session gone after a read (merged, moved) closes its view: back to the list, nothing left half-open
  if (opened && !openedSession) { setOpened(null); backTo.current = null; }
  const posted = (pk: Pick) => {
    if (pk.act === "stop" || pk.act === "fresh") noteAsked((pk.action as { session: Session }).session.id, pk.act);
    else if (pk.act === "add") noteAsked(`add:${p.id}`, "add");
    else noteAsked(p.id, pk.act);
    done();
  };
  return <div ref={wrap} className="pj-wrap" data-place="project-sheet">
    <button type="button" className="task-backdrop" aria-label="Close the project" tabIndex={-1} onClick={onClose} />
    <div ref={box} className="pj" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="pj-head">
        <div>
          <p className="task-kind">{area ? `Project in ${area.name}` : "Project"}{p.status === "resting" ? " · resting" : p.status === "archived" ? " · archived" : ""}</p>
          <h2 id={titleId}>{p.name}</h2>
          {p.about && <p className="pj-about">{p.about}</p>}
        </div>
        <ActionsMenu picks={picks} onPick={(pk) => { setAsk(""); setPick(pk); }} />
        <button type="button" className="pj-close" aria-label="Close" onClick={onClose}>×</button>
      </header>
      {pick && (pick.act === "add"
        ? <form className="pj-new" onSubmit={(e) => e.preventDefault()}>
          <label htmlFor={`${titleId}-ask`}>What should the new session do?</label>
          <textarea id={`${titleId}-ask`} rows={2} value={ask} autoFocus placeholder={`In ${p.folder}…`} onChange={(e) => setAsk(e.target.value)} />
          {ask.trim() ? <Confirm action={{ kind: "add", project: p, ask }} room={to} onPosted={() => posted(pick)} onCancel={done} />
            : <><p className="pj-hint">It runs alongside {liveOnes.length ? `the ${liveOnes.length} already working` : "anything else"}; nothing is stopped.</p>
              <div className="pj-row"><span className="pj-gap" /><button type="button" className="task-do quiet" onClick={done}>Cancel</button></div></>}
        </form>
        : pick.action && <Confirm action={pick.action} room={to} onPosted={() => posted(pick)} onCancel={done} />)}
      {openedSession ? <SessionView s={openedSession} all={sessions} project={p} now={now} roomName={to?.name ?? null}
        asked={asked.get(openedSession.id) ? askedWords(asked.get(openedSession.id)!, now) : null}
        onAnswer={to && onAnswer ? (text) => onAnswer(to.id, text) : null} onBack={() => setOpened(null)} /> : <>
      <p className="pj-folder"><span>Folder</span><code>{p.folder}</code></p>
      <Timeline sessions={sessions} talk={talk} now={now} />
      <section className="pj-sessions" aria-label="Sessions">
        <div className="pj-sessions-head">
          <h3 className="cp-h">Sessions{liveOnes.length ? ` · ${liveOnes.length} working${at ? ` at ${at}` : ""}` : ""}</h3>
        </div>
        {(at || ws.partial.length > 0) && <p className="pj-hint pj-status" role="status">{[at && `${ws.error ? "Couldn't refresh · " : ""}As of ${at}`, ...ws.partial].filter(Boolean).join(" · ")}</p>}
        {addAsked && <p className="pj-asked" role="status">{askedWords(addAsked, now)}</p>}
        {projectAsked && <p className="pj-asked" role="status">{askedWords(projectAsked, now)}</p>}
        {sessions.length === 0 && <p className="cp-none">No sessions yet.</p>}
        <ul className="pj-list">{[...liveOnes, ...recent].map((s) => <SessionCard key={s.id} s={s} all={sessions} now={now} asked={asked.get(s.id) ?? null} onOpen={() => open(s.id)} />)}</ul>
        {earlier.length > 0 && <details className="pj-earlier" open={earlierOpen} onToggle={(e) => setEarlierOpen(e.currentTarget.open)}><summary>Earlier · {earlier.length}</summary>
          <ul>{earlier.map((s) => <li key={s.id} data-session={s.id}><button type="button" onClick={() => open(s.id)}><span>{s.ask}</span><small>{stateWords(s, now)}</small></button></li>)}</ul></details>}
      </section></>}
    </div>
  </div>;
}
