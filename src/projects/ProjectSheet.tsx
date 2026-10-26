// T-301/T-302: a project, opened in place over its room (a sheet on a phone, a drawer beside the room on a wide screen). Its folder, a
// thin line of when its sessions ran against when the room talked, its sessions (live ones first: what each is doing now and its steps;
// then its history, with what each left), and what you can ask: Stop, Fresh start, Add a session, Archive, Bring back. Every action
// is a message in the area's room, shown word for word before it is posted; the room's Uni does it. Nothing here names an id.
import { useEffect, useId, useRef, useState } from "react";
import { openDialog } from "../areas/focusTrap";
import { actionLabel, actionMessage, postAction, type Action } from "./actions";
import { ago, archivePlan, areaOf, cannotStart, isLive, sessionsOf, span, stateWords, timeline, timelineWindow, type Project, type Session } from "./model";
import { noteAsked, useWork, type Asked } from "./store";
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

/** One action, two steps: the button, then the exact words and where they go, with Post and Cancel. */
function Ask({ action, room, primary, onPosted, asked }: { action: Action; room: { id: string; name: string } | null; primary?: boolean; onPosted: () => void; asked: Asked | null }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (asked) return null;
  if (!open) return <button type="button" className={`task-do ${primary ? "primary" : "quiet"} pj-act`} data-act={action.kind} disabled={!room} onClick={() => setOpen(true)}>{actionLabel[action.kind]}</button>;
  const post = async () => {
    if (!room) return;
    setBusy(true); setError(null);
    try { await postAction(room.id, action); setOpen(false); onPosted(); } catch { setError("Couldn't post that. Try again in a moment."); } finally { setBusy(false); }
  };
  return <div className="pj-confirm" role="group" aria-label={`${actionLabel[action.kind]}: what will be posted`}>
    <p className="pj-confirm-to">Posts in #{room?.name.replace(/^#/, "")}, as you:</p>
    <blockquote className="pj-confirm-text">{actionMessage(action)}</blockquote>
    {error && <p className="note-error" role="alert">{error}</p>}
    <div className="pj-row"><span className="pj-gap" />
      <button type="button" className="task-do quiet" onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
      <button type="button" className="task-do primary pj-post" disabled={busy} onClick={() => void post()}>{busy ? "Posting…" : "Post"}</button>
    </div>
  </div>;
}

const askedWords = (a: Asked, now: number) => `Asked the room to ${a.kind === "fresh" ? "start it fresh" : a.kind === "stop" ? "stop it" : a.kind === "archive" ? "archive it" : a.kind === "restore" ? "bring it back" : "add a session"} · ${ago(now - a.at)}`;

function SessionCard({ s, p, now, room, asked }: { s: Session; p: Project; now: number; room: { id: string; name: string } | null; asked: Asked | null }) {
  const live = isLive(s);
  return <li className={`pj-session ${s.state}`} data-session={s.id} data-state={s.state}>
    <p className="pj-state"><i aria-hidden="true" />{stateWords(s, now)}</p>
    <h3 className="pj-ask">{s.ask}</h3>
    {live && <p className="pj-now"><Ticks s={s} /><span>{s.now ?? "Working; it hasn't said on what yet."}</span>{s.nowAt && <small>{ago(now - s.nowAt)}</small>}</p>}
    {s.result && <p className="pj-result">{s.result}</p>}
    {asked && <p className="pj-asked" role="status">{askedWords(asked, now)}</p>}
    {(s.video || live) && <div className="pj-row">
      {s.video && <a className="pj-link" href={s.video} target="_blank" rel="noreferrer">Watch the walkthrough</a>}
      <span className="pj-gap" />
      {live && <Ask action={{ kind: "fresh", project: p, session: s }} room={room} asked={asked} onPosted={() => noteAsked(s.id, "fresh")} />}
      {live && <Ask action={{ kind: "stop", project: p, session: s }} room={room} asked={asked} primary onPosted={() => noteAsked(s.id, "stop")} />}
    </div>}
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

export function ProjectSheet({ project, talk, room, onClose }: { project: string; talk: readonly number[]; room: { id: string; name: string } | null; onClose: () => void }) {
  const { work, asked } = useWork();
  const now = useNow();
  const p = work.projects.find((x) => x.id === project);
  const [adding, setAdding] = useState(false);
  const [ask, setAsk] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const titleId = useId();
  useEffect(() => (box.current && wrap.current ? openDialog(box.current, () => closeRef.current(), { root: wrap.current, initial: box.current }) : undefined), []);
  if (!p) return null;
  const area = areaOf(work, p);
  // the area's own room is where its actions go (the room this sheet is over, when it is the area's)
  const to = area ? (room && room.id === area.room ? room : { id: area.room, name: room?.name ?? area.name }) : room;
  const sessions = sessionsOf(work, p.id);
  const liveOnes = sessions.filter(isLive);
  const ended = sessions.filter((s) => !isLive(s));
  const recent = ended.filter((s, i) => i < RECENT || now - (s.endedAt ?? 0) < DAY);
  const earlier = ended.slice(recent.length);
  const projectAsked = asked.get(p.id) ?? null;
  const blocked = cannotStart(p);
  const addAction: Action = { kind: "add", project: p, ask: ask.trim() || "…" };
  return <div ref={wrap} className="pj-wrap" data-place="project-sheet">
    <button type="button" className="task-backdrop" aria-label="Close the project" tabIndex={-1} onClick={onClose} />
    <div ref={box} className="pj" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="pj-head">
        <div>
          <p className="task-kind">{area ? `Project in ${area.name}` : "Project"}{p.status === "resting" ? " · resting" : p.status === "archived" ? " · archived" : ""}</p>
          <h2 id={titleId}>{p.name}</h2>
          {p.about && <p className="pj-about">{p.about}</p>}
        </div>
        <button type="button" className="pj-close" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <p className="pj-folder"><span>Folder</span><code>{p.folder}</code></p>
      <Timeline sessions={sessions} talk={talk} now={now} />
      <section className="pj-sessions" aria-label="Sessions">
        <div className="pj-sessions-head">
          <h3 className="cp-h">Sessions{liveOnes.length ? ` · ${liveOnes.length} working` : ""}</h3>
          {!blocked && !adding && <button type="button" className="task-do primary pj-add" onClick={() => setAdding(true)}>Add a session</button>}
        </div>
        {adding && <form className="pj-new" onSubmit={(e) => e.preventDefault()}>
          <label htmlFor={`${titleId}-ask`}>What should it do?</label>
          <textarea id={`${titleId}-ask`} rows={2} value={ask} autoFocus placeholder={`In ${p.folder}…`} onChange={(e) => setAsk(e.target.value)} />
          {ask.trim() ? <Ask action={addAction} room={to} asked={null} primary onPosted={() => { noteAsked(p.id, "add"); setAsk(""); setAdding(false); }} />
            : <p className="pj-hint">It runs alongside {liveOnes.length ? `the ${liveOnes.length} already working` : "anything else"}; nothing is stopped.</p>}
          <div className="pj-row"><span className="pj-gap" /><button type="button" className="task-do quiet" onClick={() => { setAdding(false); setAsk(""); }}>Cancel</button></div>
        </form>}
        {projectAsked && <p className="pj-asked" role="status">{askedWords(projectAsked, now)}</p>}
        {sessions.length === 0 && !adding && <p className="cp-none">No sessions yet.</p>}
        <ul className="pj-list">{[...liveOnes, ...recent].map((s) => <SessionCard key={s.id} s={s} p={p} now={now} room={to} asked={asked.get(s.id) ?? null} />)}</ul>
        {earlier.length > 0 && <details className="pj-earlier"><summary>Earlier · {earlier.length}</summary>
          <ul>{earlier.map((s) => <li key={s.id} data-session={s.id}><span>{s.ask}</span><small>{stateWords(s, now)}</small></li>)}</ul></details>}
      </section>
      <footer className="pj-foot">
        {p.status === "archived"
          ? <Ask action={{ kind: "restore", project: p }} room={to} asked={projectAsked} onPosted={() => noteAsked(p.id, "restore")} />
          : <><p className="pj-hint">{liveOnes.length ? `Archiving asks the room to stop its ${liveOnes.length} working session${liveOnes.length === 1 ? "" : "s"} first.` : "Archiving keeps the folder and the history; it can be brought back."}</p>
            <Ask action={{ kind: "archive", project: p, live: archivePlan(work, p.id).stopFirst }} room={to} asked={projectAsked} onPosted={() => noteAsked(p.id, "archive")} /></>}
      </footer>
    </div>
  </div>;
}
