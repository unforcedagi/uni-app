// T-124 r13: "All of X's work" as a focused view inside the room shell, not a second app. The same header and crumbs as the room, a way back
// to the chat, and three sections built from the companion's own rows: Needs you (the one feed, with the one count), In motion (what is
// running, what is being drafted, what others hold), and Later (Someday, folded). No census, no counters per state, no priority pickers:
// priority is set in the task sheet. Styling is in tree.css.
import { useState } from "react";
import { cleanText } from "../interface/contract";
import { NeedRow, PrivateRow } from "./Companion";
import { isActiveRun, type Draft, type Run } from "./steerCore";
import type { NeedsFeed, PrivateNeed } from "./simpleCore";
import type { Task } from "./taskCore";

export type WorkViewProps = {
  nodeName: string;
  /** Everything that needs you here: the same feed (and count) as the companion and the dots. */
  feed: NeedsFeed;
  /** Live tasks here that others hold, with a quiet line on where each stands. */
  others: readonly { task: Task; meta: string }[];
  /** The user's own Someday tasks: not in Needs you, never counted there. */
  later: readonly Task[];
  runs: readonly Run[]; drafts: readonly Draft[];
  /** Items left out of In motion and Later because they sit in a private area (counted, so the view never reads as all there is). */
  privateOther: number;
  ready: boolean; error: string | null; onRetry: () => void;
  onTask: (t: Task) => void; onDecide: (t: Task, option: string) => void; onNote: (ref: string) => void; onPrivate: (open: PrivateNeed["open"]) => void;
};

export function WorkView(p: WorkViewProps) {
  const [laterOpen, setLaterOpen] = useState(false);
  const running = p.runs.filter(isActiveRun);
  const motion = running.length + p.drafts.length + p.others.length;
  if (!p.ready) return <div className="wv"><p className={p.error ? "cp-lede cp-failed" : "th-quiet"} role={p.error ? "alert" : "status"}>{p.error ? <>Couldn't load. <button type="button" className="cp-retry" onClick={p.onRetry}>Retry</button></> : "Loading…"}</p></div>;
  return <div className="wv" aria-label={`All of ${p.nodeName}'s work`}>
    <section className="wv-sec" aria-label="Needs you">
      <h2 className="wv-h">Needs you <span className="wv-n">{p.feed.total}</span></h2>
      {p.feed.total === 0 ? <p className="cp-none">Nothing needs you here.</p> : <ul className="cp-list">
        {p.feed.rows.map((t) => <NeedRow key={t.id} t={t} onTask={p.onTask} onDecide={p.onDecide} onNote={p.onNote} />)}
        {p.feed.privates.map((x) => <PrivateRow key={x.key} p={x} onPrivate={p.onPrivate} />)}
      </ul>}
    </section>
    <section className="wv-sec" aria-label="In motion">
      <h2 className="wv-h">In motion</h2>
      {motion === 0 && !p.privateOther && <p className="cp-none">Nothing is moving here right now.</p>}
      {running.length > 0 && <ul className="cp-list wv-runs" aria-label="Running">{running.map((r) => <li key={r.id} className="cp-run" data-state={r.state}><i aria-hidden="true" /><span>{cleanText(r.what)}</span><small>{r.state}</small></li>)}</ul>}
      {p.drafts.length > 0 && <ul className="cp-list wv-drafts" aria-label="Drafts">{p.drafts.map((d) => <li key={d.id} className="cp-item">
        <button type="button" className="cp-need" onClick={() => p.onNote(d.id)}><span className="cp-title">{cleanText(d.title)}</span><small className="cp-detail">{d.status === "ready" ? "Draft ready to read" : "Being drafted"}</small></button></li>)}</ul>}
      {p.others.length > 0 && <ul className="cp-list wv-others">{p.others.map(({ task, meta }) => <NeedRow key={task.id} t={task} meta={meta} onTask={p.onTask} onDecide={p.onDecide} onNote={p.onNote} />)}</ul>}
      {p.privateOther > 0 && <p className="cp-none">{p.privateOther === 1 ? "One item in a private area is" : `${p.privateOther} items in private areas are`} not listed here; open the area to see {p.privateOther === 1 ? "it" : "them"}.</p>}
    </section>
    {p.later.length > 0 && <section className="wv-sec wv-later" aria-label="Later">
      <button type="button" className="wv-h wv-fold" aria-expanded={laterOpen} aria-controls="wv-later" onClick={() => setLaterOpen(!laterOpen)}>Later <span className="wv-n">{p.later.length}</span><i aria-hidden="true">{laterOpen ? "–" : "+"}</i></button>
      {laterOpen && <ul id="wv-later" className="cp-list">{p.later.map((t) => <NeedRow key={t.id} t={t} meta="Someday" onTask={p.onTask} onDecide={p.onDecide} onNote={p.onNote} />)}</ul>}
    </section>}
  </div>;
}
