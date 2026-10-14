// T-124 r13: "All of X's work" as a focused view inside the room shell, not a second app. The same header and crumbs as the room, a way back
// to the chat, and three sections built from the companion's own rows: Needs you (the one feed, with the one count), In motion (what is
// running, what is being drafted, what others hold), and Later (Someday, folded). No census, no counters per state, no priority pickers:
// priority is set in the task sheet. Styling is in tree.css.
import { useState, type ReactNode } from "react";
import { cleanText } from "../interface/contract";
import { NeedRow, PrivateRow } from "./Companion";
import { isActiveRun, type Draft, type Run } from "./steerCore";
import { withoutCut, type NeedsFeed, type PrivateNeed } from "./simpleCore";
import type { TaskLoad } from "./Companion";
import { asOf, countLabel, countText, LoadHealth } from "./LoadHealth";
import type { Task } from "./taskCore";
import type { NoteRef } from "./noteRefsCore";
import { useVaultProfile } from "./ProfileContext";
import { taskTitle } from "./whereCore";

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
  ready: boolean;
  /** The list's health (r14): the same line as the companion's and the tree's, so saved rows never read as current or whole. */
  load: TaskLoad;
  /** Running and Drafts, read on their own (r16): not read yet, failed (with what was read before, and when), or read. */
  activity: { ready: boolean; error: string | null; lastOk: number | null };
  onTask: (t: Task) => void; onDecide: (t: Task, option: string) => void; onNote: (ref: NoteRef) => void; onPrivate: (open: PrivateNeed["open"]) => void;
  /** r20: a row's area when it is shown outside it (an action row's subtitle names it). */
  placeOf?: (t: Task) => string | null;
  /** Above the sections: the brief's lede and its Refresh. Below them: a project's own note, folded. */
  top?: ReactNode; foot?: ReactNode;
};

export function WorkView(p: WorkViewProps) {
  const [laterOpen, setLaterOpen] = useState(false);
  const [tidyOpen, setTidyOpen] = useState(false);
  /** r19: records that aren't real requests yet: Uni's to tidy, never counted in Needs you. r20: one quiet line, its titles read-only. */
  const tidy = p.feed.tidy ?? [];
  /** r20: decisions not read yet: "Checking what's needed…" rows after the owed ones, never counted. */
  const pending = p.feed.pending ?? [];
  const vault = useVaultProfile().vault;
  const running = p.runs.filter(isActiveRun);
  const motion = running.length + p.drafts.length + p.others.length;
  if (!p.ready) return <div className="wv">{p.load.error || p.load.slow ? <LoadHealth load={p.load} ready={false} /> : <p className="th-quiet" role="status">Loading…</p>}</div>;
  return <div className="wv" aria-label={`All of ${p.nodeName}'s work`}>
    <LoadHealth load={p.load} ready count={p.feed.total} />
    {p.top}
    <section className="wv-sec" aria-label="Needs you" aria-busy={p.load.refreshing || undefined}>
      <h2 className="wv-h">Needs you <span className="wv-n" aria-label={countLabel(p.feed.total, p.load)} title={countLabel(p.feed.total, p.load)}>{countText(p.feed.total, p.load)}</span></h2>
      {p.feed.total === 0 && !pending.length ? <p className="cp-none">Nothing needs you here.</p> : <ul className="cp-list">
        {p.feed.rows.map((t) => <NeedRow key={t.id} t={t} onTask={p.onTask} onDecide={p.onDecide} onNote={p.onNote} area={p.placeOf?.(t) ?? null} />)}
        {p.feed.privates.map((x) => <PrivateRow key={x.key} p={x} onPrivate={p.onPrivate} />)}
        {pending.map((t) => <NeedRow key={t.id} t={t} onTask={p.onTask} onDecide={p.onDecide} onNote={p.onNote} area={p.placeOf?.(t) ?? null} />)}
      </ul>}
    </section>
    <section className="wv-sec" aria-label="In motion">
      <h2 className="wv-h">In motion</h2>
      {/* r16: activity that couldn't be read is never "nothing moving"; activity kept from an earlier read says when it was read */}
      {p.activity.error ? <p className="lh-line" role="status">{p.activity.lastOk ? `Running and drafts as of ${asOf(p.activity.lastOk)} · Couldn't refresh` : "Couldn't check what's running"} · <button type="button" className="cp-retry" onClick={p.load.retry}>Retry</button></p>
        : !p.activity.ready ? <p className="lh-line" role="status">Checking what's running…</p> : null}
      {motion === 0 && !p.privateOther && p.activity.ready && !p.activity.error && <p className="cp-none">Nothing is moving here right now.</p>}
      {running.length > 0 && <ul className="cp-list wv-runs" aria-label="Running">{running.map((r) => <li key={r.id} className="cp-run" data-state={r.state}><i aria-hidden="true" /><span>{cleanText(r.what)}</span><small>{r.state}</small></li>)}</ul>}
      {p.drafts.length > 0 && <ul className="cp-list wv-drafts" aria-label="Drafts">{p.drafts.map((d) => <li key={d.id} className="cp-item">
        <button type="button" className="cp-need" onClick={() => p.onNote({ vault, id: d.id })}><span className="cp-title">{cleanText(taskTitle(d.title).rest)}</span><small className="cp-detail">{d.status === "ready" ? "Draft ready to read" : "Being drafted"}</small></button></li>)}</ul>}
      {p.others.length > 0 && <ul className="cp-list wv-others">{p.others.map(({ task, meta }) => <NeedRow key={task.id} t={task} meta={meta} onTask={p.onTask} onDecide={p.onDecide} onNote={p.onNote} />)}</ul>}
      {p.privateOther > 0 && <p className="cp-none">{p.privateOther === 1 ? "One item in a private area is" : `${p.privateOther} items in private areas are`} not listed here; open the area to see {p.privateOther === 1 ? "it" : "them"}.</p>}
    </section>
    {/* r20 (Codex 8): Uni's tidying stays Uni's: one quiet line, no rows to act on; opened, the records' titles, read-only */}
    {tidy.length > 0 && <section className="wv-sec wv-tidy" aria-label="Uni is tidying">
      <button type="button" className="wv-tidy-line" aria-expanded={tidyOpen} aria-controls="wv-tidy" onClick={() => setTidyOpen(!tidyOpen)}>{`Uni is tidying ${tidy.length} ${tidy.length === 1 ? "record" : "records"}`}</button>
      {tidyOpen && <ul id="wv-tidy" className="wv-tidy-list">{tidy.map((t) => <li key={t.id}>{cleanText(withoutCut(taskTitle(t.title).rest) || t.title)}</li>)}</ul>}
    </section>}
    {p.later.length > 0 && <section className="wv-sec wv-later" aria-label="Later">
      <button type="button" className="wv-h wv-fold" aria-expanded={laterOpen} aria-controls="wv-later" onClick={() => setLaterOpen(!laterOpen)}>Later <span className="wv-n">{p.later.length}</span><i aria-hidden="true">{laterOpen ? "–" : "+"}</i></button>
      {laterOpen && <ul id="wv-later" className="cp-list">{p.later.map((t) => <NeedRow key={t.id} t={t} meta="Someday" onTask={p.onTask} onDecide={p.onDecide} onNote={p.onNote} />)}</ul>}
    </section>}
    {p.foot}
  </div>;
}
