// "Where we are" at the top of a level's panel (T-111, 0.1.42): the typed summary of the level, from the task notes themselves.
// Counts by state, what moved this week, then what needs the user split Now / Soon / Someday. The root level's is the morning view.
// Styling is in tree.css (the Field Book tokens). Pure parts are in whereCore.ts.
import { useState } from "react";
import { cleanText } from "../interface/contract";
import { agoLabel } from "./treeRooms";
import { dueText } from "./NodeWork";
import { activeProfile } from "./profile";
import { PRIORITIES, PRIORITY_LABEL, priorityOf, type Priority, type Task } from "./taskCore";
import type { Where } from "./whereCore";
import { splitTitle } from "./whereCore";

const SHOW = 8;

/** The priority control on a row: a small select. Choosing writes once; the app offers five seconds to take it back. */
export function PriorityPick({ task, onPick }: { task: Task; onPick: (t: Task, p: Priority) => void }) {
  const { id, rest } = splitTitle(cleanText(task.title));
  return <select className="wr-prio" data-p={priorityOf(task)} value={priorityOf(task)} aria-label={`Priority for ${id ?? rest}`} onChange={(e) => onPick(task, e.target.value as Priority)}>
    {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}{p === "soon" && !task.priority ? " (unsorted)" : ""}</option>)}
  </select>;
}

/** A task as a row: T-NN, title, next step, due and where it belongs (when seen from above), the priority, the check-off. */
function Row({ t, here, nodeName, leaving, onOpen, onAct, onPriority }: {
  t: Task; here: string; nodeName: (p: string) => string; leaving: boolean;
  onOpen: (t: Task) => void; onAct: (t: Task, a: "done") => void; onPriority: (t: Task, p: Priority) => void;
}) {
  const { id, rest } = splitTitle(cleanText(t.title));
  const meta = [t.kind === "decision" ? "Decide" : null, t.waitingOn === activeProfile().me ? "Waiting on you" : t.state === "doing" ? "In progress" : t.state === "waiting" ? "Waiting" : null, dueText(t.due), t.node !== here ? nodeName(t.node) : null].filter(Boolean);
  return <li className={`wr-row ${leaving ? "leaving" : ""}`} data-id={id ?? undefined}>
    <button type="button" className="wr-main" onClick={() => onOpen(t)}>
      <span className="wr-line">{id && <b className="wr-id">{id}</b>}<span className="wr-title">{rest}</span></span>
      {t.next && <span className="wr-next">{cleanText(t.next)}</span>}
      {meta.length > 0 && <span className="wr-meta">{meta.map((m, i) => <span key={i}>{m}</span>)}</span>}
    </button>
    <PriorityPick task={t} onPick={onPriority} />
    <button type="button" className="task-check" aria-label={`${t.kind === "decision" ? "Mark decided" : "Mark done"}: ${cleanText(t.title)}`} onClick={() => onAct(t, "done")}><span aria-hidden="true" /></button>
  </li>;
}

function Bucket({ p, rows, count, ...rest }: { p: Priority; rows: readonly Task[]; count: number; here: string; nodeName: (p: string) => string; leaving: ReadonlySet<string>; onOpen: (t: Task) => void; onAct: (t: Task, a: "done") => void; onPriority: (t: Task, p: Priority) => void }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(p !== "someday");
  const shown = all ? rows : rows.slice(0, SHOW);
  const hidden = count - rows.length;
  return <div className={`wr-bucket p-${p}`} data-p={p}>
    {p === "someday"
      ? <button type="button" className="wr-h wr-fold" aria-expanded={open} aria-controls="wr-someday" onClick={() => setOpen(!open)}><span>{PRIORITY_LABEL[p]}</span><em>{count}</em><i aria-hidden="true">{open ? "–" : "+"}</i></button>
      : <h3 className="wr-h"><span>{PRIORITY_LABEL[p]}</span><em>{count}</em></h3>}
    {open && <div id={p === "someday" ? "wr-someday" : undefined}>
      <ul className="wr-rows">{shown.map((t) => <Row key={t.id} t={t} leaving={rest.leaving.has(t.id)} here={rest.here} nodeName={rest.nodeName} onOpen={rest.onOpen} onAct={rest.onAct} onPriority={rest.onPriority} />)}</ul>
      {rows.length > SHOW && <button type="button" className="th-link" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show ${rows.length - SHOW} more`}</button>}
      {hidden > 0 && <p className="wr-private">{hidden} more in private areas, counted not named.</p>}
    </div>}
  </div>;
}

export default function WhereWeAre({ where, here, nodeName, leaving, nowMs, lead, ready, onOpen, onAct, onPriority }: {
  where: Where; here: string; nodeName: (p: string) => string; leaving: ReadonlySet<string>; nowMs: number;
  /** The level's name, for the heading ("Where we are" at Uni reads "Where we are, all of it"). */
  lead: string; ready: boolean;
  onOpen: (t: Task) => void; onAct: (t: Task, a: "done") => void; onPriority: (t: Task, p: Priority) => void;
}) {
  const nowSec = Math.floor(nowMs / 1000);
  const w = where;
  const counts: [string, number][] = [["open", w.open], ["doing", w.doing], ["waiting", w.waiting]];
  return <section className="wr" aria-label="Where we are" aria-busy={!ready}>
    <h2 className="th-h"><span>Where we are</span><em>{w.total}</em></h2>
    <p className="wr-lead">{lead}</p>
    {!ready ? <p className="th-quiet" role="status">Loading tasks…</p> : <>
      <dl className="wr-counts" aria-label="Open work">
        {counts.map(([k, n]) => <div key={k} className={n ? "" : "zero"}><dt>{k}</dt><dd>{n}</dd></div>)}
        <div className={w.you ? "you" : "zero"}><dt>need you</dt><dd>{w.you}</dd></div>
      </dl>
      <section className="wr-moved" aria-label="Moved this week">
        <h3 className="wr-h"><span>Moved this week</span><em>{w.movedCount}</em></h3>
        {w.movedCount === 0 ? <p className="th-quiet">Nothing changed in the last 7 days.</p>
          : w.moved.length === 0 ? <p className="wr-private">{w.movedCount} changed, the last {agoLabel(nowSec, Math.floor((w.lastMoved ?? nowMs) / 1000))} ago. Counted, not named.</p>
          : <ul className="wr-moves">{w.moved.map((t) => { const { id, rest } = splitTitle(cleanText(t.title)); return <li key={t.id}>
            <button type="button" className="wr-mv" onClick={() => onOpen(t)}>{id && <b className="wr-id">{id}</b>}<span className="wr-title">{rest}</span>
              <small>{t.state}{t.node !== here ? ` · ${nodeName(t.node)}` : ""} · {agoLabel(nowSec, Math.floor(Date.parse(t.updatedAt ?? "") / 1000))}</small></button></li>; })}
          {w.movedCount > w.moved.length && <li className="wr-more">+ {w.movedCount - w.moved.length} more</li>}</ul>}
      </section>
      <section className="wr-needs" aria-label="Needs you">
        <h3 className="wr-h wr-needs-h"><span>Needs you</span><em>{w.you}</em></h3>
        {w.you === 0 ? <p className="th-quiet">Nothing needs you here.</p>
          : PRIORITIES.filter((p) => w.needs[p].count > 0).map((p) => <Bucket key={p} p={p} rows={w.needs[p].rows} count={w.needs[p].count} here={here} nodeName={nodeName} leaving={leaving} onOpen={onOpen} onAct={onAct} onPriority={onPriority} />)}
      </section>
    </>}
  </section>;
}
