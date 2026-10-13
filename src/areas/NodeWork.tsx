import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cleanText } from "../interface/contract";
import { groupTasks, isMe, type Task } from "./taskCore";
import type { RoomRef } from "./talkCore";
import type { TaskAction, Undo } from "./useTasks";
import { activeProfile, type VaultProfile } from "./profile";
import type { Mark } from "./steerCore";
import { Changed } from "./Changed";
import { isCutTitle, stateLine } from "./simpleCore";
import { splitTitle } from "./whereCore";

const SHOW = 8;

export const ownerLabel = (o: string, p: VaultProfile = activeProfile()) => (o === p.me ? p.meLabel : p.roomOwnerPrefix && o.startsWith(p.roomOwnerPrefix) ? `#${o.slice(p.roomOwnerPrefix.length)}` : o.startsWith("person:") ? o.slice(7) : p.agentOwners.includes(o) ? o.charAt(0).toUpperCase() + o.slice(1) : o || "unassigned");
const OWNER = (o: string) => ownerLabel(o);
export const dueText = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : `due ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
};

function Meta({ t, here, nodeName }: { t: Task; here: string; nodeName: (path: string) => string }) {
  const parts = [t.kind === "decision" ? "Decide" : null, isMe(t.waitingOn) ? "Waiting on you" : t.state === "doing" ? "In progress" : t.state === "waiting" ? "Waiting" : null, dueText(t.due), t.node !== here ? `in ${nodeName(t.node)}` : null].filter(Boolean);
  return parts.length ? <span className="task-meta">{parts.map((p, i) => <span key={i} className={p === "Decide" ? "task-decide" : ""}>{p}</span>)}</span> : null;
}

/** What needs doing at this level and below, grouped You / Rooms / Others, with a one-tap check-off. */
export function TaskList({ title = "Needs doing", tasks, leaving, here, nodeName, loading, ready, error, truncated, treeTruncated, marks, nowMs = 0, onOpen, onAct, onRetry }: {
  title?: string; marks?: ReadonlyMap<string, readonly Mark[]>; nowMs?: number; tasks: readonly Task[]; leaving: ReadonlySet<string>; here: string; nodeName: (path: string) => string;
  loading: boolean; ready: boolean; error: string | null; truncated: boolean; treeTruncated?: boolean;
  onOpen: (t: Task) => void; onAct: (t: Task, a: TaskAction) => void; onRetry: () => void;
}) {
  const [all, setAll] = useState<Record<string, boolean>>({});
  const groups = groupTasks(tasks);
  return <section className="work" aria-label="What needs doing here" aria-busy={loading && !ready}>
    <h2 className="work-head">{title}<span className="brief-count">{tasks.length}</span></h2>
    {error && <p className="work-error" role="alert">Couldn't load tasks: {error.slice(0, 160)} <button type="button" className="pairing-secondary" onClick={onRetry}>Retry</button></p>}
    {!ready && !error && <p className="area-quiet" role="status">Loading tasks…</p>}
    {ready && !tasks.length && !error && <p className="area-quiet">Nothing open here.</p>}
    {groups.map((g) => {
      const rows = all[g.group] ? g.tasks : g.tasks.slice(0, SHOW);
      return <div className={`work-group g-${g.group}`} key={g.group}>
        <h3>{g.label}<span>{g.tasks.length}</span></h3>
        <ul>{rows.map((t) => <li key={t.id} className={`task-row ${leaving.has(t.id) ? "leaving" : ""} ${t.kind} ${marks?.get(t.id)?.length ? "changed" : ""}`} data-note={t.id}>
          <button type="button" className="task-main" onClick={() => onOpen(t)}>
            <span className="task-title">{cleanText(t.title)}</span>
            <Meta t={t} here={here} nodeName={nodeName} />
            <Changed marks={marks?.get(t.id)} nowMs={nowMs} />
          </button>
          <button type="button" className="task-check" aria-label={`${t.kind === "decision" ? "Mark decided" : "Mark done"}: ${cleanText(t.title)}`} onClick={() => onAct(t, "done")}><span aria-hidden="true" /></button>
        </li>)}</ul>
        {g.tasks.length > SHOW && <button type="button" className="work-more" onClick={() => setAll((a) => ({ ...a, [g.group]: !a[g.group] }))}>{all[g.group] ? "Show fewer" : `Show ${g.tasks.length - SHOW} more`}</button>}
      </div>;
    })}
    {truncated && <p className="area-quiet" role="status">Showing the first 200; more may exist.</p>}
    {treeTruncated && <p className="area-quiet" role="status">The tree was cut short at 200 nodes; some areas or projects may be missing.</p>}
  </section>;
}

const who = (id: string | null) => (id ? (/^[0-9a-f-]{32,}$/i.test(id) ? id.slice(0, 8) : id) : null);

/** One task: what it is, who changed it last, and the four things you can do. Text only; the vault's words are never HTML. */
export function TaskSheet({ task, here, nodeName, room, inRoom, onClose, onAct, onOpenRoom }: {
  task: Task; here: string; nodeName: (path: string) => string; room: RoomRef | null;
  /** The room open now: "Open in #room" is not offered for it. */
  inRoom?: string | null;
  onClose: () => void; onAct: (t: Task, a: TaskAction) => void; onOpenRoom: (id: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  useEffect(() => { box.current?.querySelector<HTMLElement>("button.task-do")?.focus(); const back = opener.current as HTMLElement | null; return () => { if (back?.isConnected) back.focus(); }; }, []);
  const key = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    if (e.key === "Tab") {
      const f = [...box.current!.querySelectorAll<HTMLElement>("button:not(:disabled)")];
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  };
  const go = (a: TaskAction) => { onAct(task, a); onClose(); };
  const by = who(task.lastUpdatedBy), via = task.lastUpdatedVia;
  const { id: tid, rest } = splitTitle(task.title);
  const heading = task.ask && isCutTitle(rest) ? `${tid ? `${tid} ` : ""}${task.ask}` : task.title; // a cut title reads whole here
  return <div className="task-sheet-wrap" onKeyDown={key}>
    <button type="button" className="task-backdrop" aria-label="Close" tabIndex={-1} onClick={onClose} />
    <div ref={box} className="task-sheet" role="dialog" aria-modal="true" aria-labelledby="task-sheet-title">
      <p className="task-kind">{task.kind === "decision" ? "Decision" : "Task"}{task.node !== here ? ` · in ${nodeName(task.node)}` : ""}</p>
      <h2 id="task-sheet-title">{cleanText(heading)}</h2>
      {task.next && <p className="task-next">{cleanText(task.next)}</p>}
      <dl className="task-facts">
        <dt>Status</dt><dd>{stateLine(task, (w) => isMe(w), OWNER)}</dd>
        {!isMe(task.owner) && !isMe(task.waitingOn) && <><dt>With</dt><dd>{OWNER(task.owner)}</dd></>}
        {task.due && <><dt>Due</dt><dd>{task.due}</dd></>}
      </dl>
      {(by || via) && <p className="task-by">Changed by {by ?? "unknown"}{via ? ` via ${via}` : ""}</p>}
      <div className="task-actions">
        <button type="button" className="task-do primary" onClick={() => go("done")}>{task.kind === "decision" ? "Mark decided" : "Mark done"}</button>
        {task.kind === "task" && <button type="button" className="task-do" onClick={() => go("archive")}>Archive</button>}
        <button type="button" className="task-do" onClick={() => go("snooze")}>Snooze until tomorrow</button>
        {room && room.id !== inRoom && <button type="button" className="task-do" onClick={() => { onOpenRoom(room.id); onClose(); }}>Open in #{room.name}</button>}
        <button type="button" className="task-do quiet" onClick={onClose}>Close</button>
      </div>
    </div>
  </div>;
}

/** The last action, with five seconds to take it back. */
export function UndoBar({ undo, notice, onDismiss }: { undo: Undo | null; notice: string | null; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!undo && !notice) return null;
  return <div className="undo-bar" role="status" aria-live="polite">
    {notice && <span className="undo-note">{notice}<button type="button" className="undo-x" aria-label="Dismiss" onClick={onDismiss}>×</button></span>}
    {undo && <span className="undo-main">{undo.label}<button type="button" className="undo-go" disabled={busy} onClick={async () => { setBusy(true); try { await undo.run(); } finally { setBusy(false); } }}>Undo</button></span>}
  </div>;
}
