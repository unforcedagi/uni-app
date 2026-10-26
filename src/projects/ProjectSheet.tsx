// T-301: a project, opened in place over its room (a sheet on a phone, a drawer beside the room on a wide screen). Its folder, a thin
// line of when its sessions ran against when the room talked, its sessions (live ones first: the one line, ticks, the story on tap, Stop;
// finished ones with what came back), a fresh session, and Retire. Nothing here names an id.
import { useEffect, useId, useRef, useState } from "react";
import { openDialog } from "../areas/focusTrap";
import { areaOf, isLive, retiredOf, sessionsOf, span, stateWords, timeline, timelineWindow, type Session } from "./model";
import { useWork, workActions } from "./store";
import "./projects.css";

const DAY = 86_400_000;
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const when = (t: number, now: number) => (now - t < DAY && new Date(t).getDate() === new Date(now).getDate() ? clock(t) : `${new Date(t).toLocaleDateString(undefined, { weekday: "short" })} ${clock(t)}`);

/** Re-render every so often, so "Working · 12 min" keeps time. */
function useNow(ms = 15_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

function Ticks({ s }: { s: Session }) {
  const steps = s.story.length;
  return <span className="pj-ticks" role="img" aria-label={`${steps} step${steps === 1 ? "" : "s"} so far`}>
    {s.story.map((st, i) => <i key={i} className={isLive(s) && i === steps - 1 ? "now" : ""} title={st.text} />)}
  </span>;
}

function SessionCard({ s, now }: { s: Session; now: number }) {
  const [story, setStory] = useState(false);
  const live = isLive(s);
  const storyId = useId();
  return <li className={`pj-session ${s.state}`} data-session={s.id} data-state={s.state}>
    <p className="pj-state"><i aria-hidden="true" />{stateWords(s, now)}</p>
    <h3 className="pj-ask">{s.ask}</h3>
    {live && <p className="pj-now"><Ticks s={s} /><span>{s.now}</span></p>}
    {s.result && <p className="pj-result">{s.result}</p>}
    <div className="pj-row">
      <button type="button" className="pj-link" aria-expanded={story} aria-controls={storyId} onClick={() => setStory(!story)}>{story ? "Hide the story" : "The story"}</button>
      {s.video && <a className="pj-link" href={s.video} target="_blank" rel="noreferrer">Watch the walkthrough</a>}
      <span className="pj-gap" />
      {live && <button type="button" className="task-do pj-stop" onClick={() => workActions.stop(s.id)}>Stop</button>}
      <button type="button" className="task-do quiet pj-retire" onClick={() => workActions.retire(s.id)}>Retire</button>
    </div>
    {story && <ol id={storyId} className="pj-story">{s.story.map((st, i) => <li key={i}><time>{when(st.at, now)}</time><span>{st.text}</span></li>)}</ol>}
  </li>;
}

/** When the sessions ran (bars) against when the room talked (ticks), over the last days. */
function Timeline({ sessions, talk, now }: { sessions: readonly Session[]; talk: readonly number[]; now: number }) {
  const { from } = timelineWindow(sessions, now);
  const t = timeline(sessions, talk, from, now);
  if (!t.runs.length) return null;
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  return <figure className="pj-time" aria-label={`When the sessions ran, against the room's talk, over the last ${span(now - from)}`}>
    <div className="pj-time-track">
      {t.talk.map((x, i) => <i key={`t${i}`} className="pj-talk" style={{ left: pct(x) }} />)}
      {t.runs.map((r) => <i key={r.id} className={`pj-run ${r.live ? "live" : ""}`} style={{ left: pct(r.x), width: pct(r.w) }} />)}
    </div>
    <figcaption><span>{span(now - from)} ago</span><span className="pj-key"><i className="pj-talk-key" />the room talked <i className="pj-run-key" />a session ran</span><span>now</span></figcaption>
  </figure>;
}

export function ProjectSheet({ project, talk, onClose }: { project: string; talk: readonly number[]; onClose: () => void }) {
  const work = useWork();
  const now = useNow();
  const p = work.projects.find((x) => x.id === project);
  const [asking, setAsking] = useState(false);
  const [ask, setAsk] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const titleId = useId();
  useEffect(() => (box.current && wrap.current ? openDialog(box.current, () => closeRef.current(), { root: wrap.current, initial: box.current }) : undefined), []);
  if (!p) return null;
  const area = areaOf(work, p);
  const sessions = sessionsOf(work, p.id);
  const retired = retiredOf(work, p.id);
  const live = sessions.filter(isLive).length;
  const start = () => { if (!ask.trim()) return; workActions.start(p.id, ask); setAsk(""); setAsking(false); };
  return <div ref={wrap} className="pj-wrap" data-proto="project-sheet">
    <button type="button" className="task-backdrop" aria-label="Close the project" tabIndex={-1} onClick={onClose} />
    <div ref={box} className="pj" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="pj-head">
        <div>
          <p className="task-kind">{area ? `Project in ${area.name}` : "Project"}{p.status === "resting" ? " · resting" : ""}</p>
          <h2 id={titleId}>{p.name}</h2>
          {p.about && <p className="pj-about">{p.about}</p>}
        </div>
        <button type="button" className="pj-close" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <p className="pj-folder"><span>Folder</span><code>{p.folder}</code></p>
      <Timeline sessions={[...sessions, ...retired]} talk={talk} now={now} />
      <section className="pj-sessions" aria-label="Sessions">
        <div className="pj-sessions-head">
          <h3 className="cp-h">Sessions{live ? ` · ${live} working` : ""}</h3>
          {!asking && <button type="button" className="task-do primary pj-fresh" onClick={() => setAsking(true)}>Start a fresh session</button>}
        </div>
        {asking && <form className="pj-new" onSubmit={(e) => { e.preventDefault(); start(); }}>
          <label htmlFor={`${titleId}-ask`}>What should it do?</label>
          <textarea id={`${titleId}-ask`} rows={2} value={ask} autoFocus placeholder={`In ${p.folder}…`} onChange={(e) => setAsk(e.target.value)} />
          <div className="pj-row"><span className="pj-gap" /><button type="button" className="task-do quiet" onClick={() => { setAsking(false); setAsk(""); }}>Cancel</button>
            <button type="submit" className="task-do primary" disabled={!ask.trim()}>Start</button></div>
        </form>}
        {sessions.length === 0 && !asking && <p className="cp-none">No sessions yet. Start one when there is something to do here.</p>}
        <ul className="pj-list">{sessions.map((s) => <SessionCard key={s.id} s={s} now={now} />)}</ul>
        {retired.length > 0 && <details className="pj-retired"><summary>Retired · {retired.length}</summary>
          <ul>{retired.map((s) => <li key={s.id} data-session={s.id}><span>{s.ask}</span><small>{s.endedAt ? `ended ${span(now - s.endedAt)} ago` : ""}</small></li>)}</ul></details>}
      </section>
    </div>
  </div>;
}
