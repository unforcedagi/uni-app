// T-124 r13: "All of X's work" as a focused view inside the room shell, not a second app. The same header and crumbs as the room, a way back
// to the chat, and sections built from the companion's own rows with the companion's own names (r27): Needs you (the one feed, with the one
// count, and a run waiting on the user's answer), Running (what is running), Drafts, With others (tasks others hold), Done lately, and Later (Someday,
// folded). No census, no counters per state, no priority pickers: priority is set in the task sheet. Records that need rewording are the
// rooms' business: logged, never shown. Styling is in tree.css.
import { useEffect, useState, type ReactNode } from "react";
import { cleanText } from "../interface/contract";
import { NeedRow, PrivateRow, Rechecks, RunText, WaitingRuns } from "./Companion";
import { isActiveRun, type Draft, type Run } from "./steerCore";
import { noneLine, quietAgo, runStateLabel, stampMs, titleWords, waitingOnYou, type NeedsFeed, type PrivateNeed } from "./simpleCore";
import type { TaskLoad } from "./Companion";
import { asOf, countLabel, countText, LoadHealth } from "./LoadHealth";
import type { Task } from "./taskCore";
import type { NoteRef } from "./noteRefsCore";
import { useVaultProfile } from "./ProfileContext";
import { taskTitle } from "./whereCore";
import { ApprovalRows } from "./ApprovalRows";

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
  onTask: (t: Task) => void;
  /** r30: a run waiting on the user opens its room at the run's message, the composer focused */
  onRun?: (r: Run) => void; runMissing?: (r: Run) => boolean; onDecide: (t: Task, option: string) => void; onNote: (ref: NoteRef) => void; onPrivate: (open: PrivateNeed["open"]) => void;
  /** r30: this is Uni's own work view: its counts are across all rooms; any other room's are its own */
  scopeAll?: boolean;
  /** r20: a row's area when it is shown outside it (an action row's subtitle names it). */
  placeOf?: (t: Task) => string | null;
  /** Above the sections: the brief's lede and its Refresh. Below them: a project's own note, folded. */
  top?: ReactNode; foot?: ReactNode;
};

/** A record to reword, by its title as words (r20): no "Decision (default yes):" label, no cut tail ("…feature 4, the"). Logged for the rooms (r27), never shown. */
export const tidyTitle = (t: Task): string => titleWords(cleanText(taskTitle(t.title).rest)) || cleanText(t.title);
/** Runs finished lately (r27): "Done lately" lists those done within a week, newest first. */
export const DONE_LATELY_DAYS = 7;
export const doneLately = (runs: readonly Run[], nowMs = Date.now()): Run[] => runs.filter((r) => { const t = stampMs(r.updated ?? r.started ?? ""); return r.state === "done" && Number.isFinite(t) && nowMs - t <= DONE_LATELY_DAYS * 86_400_000; }).sort((a, b) => stampMs(b.updated ?? b.started) - stampMs(a.updated ?? a.started)).slice(0, 5);

export function WorkView(p: WorkViewProps) {
  const [laterOpen, setLaterOpen] = useState(false);
  /** r19: records that aren't real requests yet: Uni's to tidy, never counted in Needs you. r27: not Aaron's to read: they are for the rooms, so they are logged. */
  const tidy = p.feed.tidy ?? [];
  const tidyKey = tidy.map((t) => t.id).join(",");
  useEffect(() => { if (tidy.length) console.info(`[uni] ${tidy.length} record${tidy.length === 1 ? "" : "s"} need rewording by their rooms:`, tidy.map((t) => `${t.id} ${tidyTitle(t)}`)); }, [tidyKey]); // eslint-disable-line react-hooks/exhaustive-deps
  /** r20: decisions not read yet: "Checking what's needed…" rows after the owed ones, never counted. */
  const pending = p.feed.pending ?? [];
  const vault = useVaultProfile().vault;
  const live = p.runs.filter(isActiveRun);
  /** r27 (Codex P2-5): a run waiting on the user's answer is Needs you; Running holds only what is not waiting on them */
  const waiting = p.feed.waiting ?? [];
  const running = live.filter((r) => !waitingOnYou(r));
  const done = doneLately(p.runs);
  const motion = running.length + p.drafts.length + p.others.length;
  // an approval waiting in a room (T-161, T-234) needs no task list: it shows while the list loads or fails
  if (!p.ready) return <div className="wv"><ApprovalRows approvals={p.feed.approvals ?? []} className="cp-list cp-approvals wv-approvals" />
    {p.load.error || p.load.slow ? <LoadHealth load={p.load} ready={false} /> : <p className="th-quiet" role="status">Loading…</p>}</div>;
  return <div className="wv" aria-label={`All of ${p.nodeName}'s work`}>
    <LoadHealth load={p.load} ready count={p.feed.total} />
    <section className="wv-sec" aria-label="Needs you" aria-busy={p.load.refreshing || undefined}>
      <h2 className="wv-h">Needs you <span className="wv-n" aria-label={countLabel(p.feed.total, p.load)} title={countLabel(p.feed.total, p.load)}>{countText(p.feed.total, p.load)}</span></h2>
      <ApprovalRows approvals={p.feed.approvals ?? []} className="cp-list cp-approvals wv-approvals" />
      {p.feed.total === 0 && !pending.length && !waiting.length ? <p className="cp-none">{noneLine(p.feed)}</p> : p.feed.rows.length + p.feed.privates.length + pending.length === 0 ? null : <ul className="cp-list">
        {p.feed.rows.map((t) => <NeedRow key={t.id} t={t} onTask={p.onTask} onDecide={p.onDecide} onNote={p.onNote} area={p.placeOf?.(t) ?? null} />)}
        {p.feed.privates.map((x) => <PrivateRow key={x.key} p={x} onPrivate={p.onPrivate} />)}
        {pending.map((t) => <NeedRow key={t.id} t={t} onTask={p.onTask} onDecide={p.onDecide} onNote={p.onNote} area={p.placeOf?.(t) ?? null} />)}
      </ul>}
      <WaitingRuns runs={waiting} className="cp-list cp-waiting wv-waiting" onRun={p.onRun} missing={p.runMissing} />
      <Rechecks tasks={p.feed.recheck ?? []} why={p.feed.recheckWhy} scope={p.scopeAll ? "all" : "room"} onTask={p.onTask} placeOf={p.placeOf} />
    </section>
    {/* r29 (Codex P1-3): the summary is a dated account, below what needs you */}
    {p.top}
    {/* r27: no heading with nothing under it: Running is here when something runs, when what runs couldn't be read, or when nothing moves at all */}
    {(running.length > 0 || !!p.activity.error || !p.activity.ready || (motion === 0 && !p.privateOther)) && <section className="wv-sec" aria-label="Running">
      <h2 className="wv-h">Running</h2>
      {/* r16: activity that couldn't be read is never "nothing moving"; activity kept from an earlier read says when it was read */}
      {p.activity.error ? <p className="lh-line" role="status">{p.activity.lastOk ? `Running and drafts as of ${asOf(p.activity.lastOk)} · Couldn't refresh` : "Couldn't check what's running"} · <button type="button" className="cp-retry" onClick={p.load.retry}>Retry</button></p>
        : !p.activity.ready ? <p className="lh-line" role="status">Checking what's running…</p> : null}
      {motion === 0 && !p.privateOther && p.activity.ready && !p.activity.error && <p className="cp-none">Nothing is moving here right now.</p>}
      {running.length > 0 && <ul className="cp-list wv-runs" aria-label="Running now">{running.map((r) => <li key={r.id} className="cp-run" data-state={r.state}><i aria-hidden="true" /><RunText what={cleanText(r.what)} /><small>{runStateLabel(r.state)}</small></li>)}</ul>}
    </section>}
    {p.drafts.length > 0 && <section className="wv-sec" aria-label="Drafts">
      <h2 className="wv-h">Drafts</h2>
      <ul className="cp-list wv-drafts">{p.drafts.map((d) => <li key={d.id} className="cp-item">
        <button type="button" className="cp-need" onClick={() => p.onNote({ vault, id: d.id })}><span className="cp-title">{cleanText(taskTitle(d.title).rest)}</span><small className="cp-detail">{d.status === "ready" ? "Draft ready to read" : "Being drafted"}</small></button></li>)}</ul>
    </section>}
    {p.others.length > 0 && <section className="wv-sec" aria-label="With others">
      <h2 className="wv-h">With others</h2>
      <ul className="cp-list wv-others">{p.others.map(({ task, meta }) => <NeedRow key={task.id} t={task} meta={meta} onTask={p.onTask} onDecide={p.onDecide} onNote={p.onNote} />)}</ul>
    </section>}
    {p.privateOther > 0 && <p className="cp-none wv-private-other">{p.privateOther === 1 ? "One item in a private area is" : `${p.privateOther} items in private areas are`} not listed here; open the area to see {p.privateOther === 1 ? "it" : "them"}.</p>}
    {done.length > 0 && <section className="wv-sec" aria-label="Done lately">
      <h2 className="wv-h">Done lately</h2>
      <ul className="cp-list wv-done">{done.map((r) => <li key={r.id} className="cp-run" data-state={r.state}><i aria-hidden="true" /><RunText what={cleanText(r.what)} /><small>{quietAgo(r.updated ?? r.started, Date.now()) || runStateLabel(r.state)}</small></li>)}</ul>
    </section>}
    {p.later.length > 0 && <section className="wv-sec wv-later" aria-label="Later">
      <button type="button" className="wv-h wv-fold" aria-expanded={laterOpen} aria-controls="wv-later" onClick={() => setLaterOpen(!laterOpen)}>Later <span className="wv-n">{p.later.length}</span><i aria-hidden="true">{laterOpen ? "–" : "+"}</i></button>
      {laterOpen && <ul id="wv-later" className="cp-list">{p.later.map((t) => <NeedRow key={t.id} t={t} meta="Someday" onTask={p.onTask} onDecide={p.onDecide} onNote={p.onNote} />)}</ul>}
    </section>}
    {p.foot}
  </div>;
}
