// The task sheet (r13: live, its own action first, answers only beside the whole question) and the undo bar. Styling is in areas.css and tree.css.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cleanText } from "../interface/contract";
import { isMe, PRIORITIES, PRIORITY_LABEL, priorityOf, type Priority, type Task } from "./taskCore";
import type { RoomRef } from "./talkCore";
import type { ActResult, TaskAction, Undo } from "./useTasks";
import { activeProfile, type VaultProfile } from "./profile";
import { actionLead, dueLine, sayText, stateLine } from "./simpleCore";
import { taskTitle } from "./whereCore";
import { DecisionAnswer, NextText, decisionAsk, plainDetail } from "./Companion";
import { RefText } from "./noteRefs";
import { splitRefs, type NoteRef } from "./noteRefsCore";
import { useVaultProfile } from "./ProfileContext";
import { changedBy, vaultTasks } from "./vaultTasks";
import { trapTab } from "./focusTrap";

export const ownerLabel = (o: string, p: VaultProfile = activeProfile()) => (o === p.me ? p.meLabel : p.roomOwnerPrefix && o.startsWith(p.roomOwnerPrefix) ? `#${o.slice(p.roomOwnerPrefix.length)}` : o.startsWith("person:") ? o.slice(7) : p.agentOwners.includes(o) ? o.charAt(0).toUpperCase() + o.slice(1) : o || "unassigned");
const OWNER = (o: string) => ownerLabel(o);

/** A step with something to open in it: a web link or a linked note. */
const linky = (text: string) => /https?:\/\/|\bwww\./.test(text) || splitRefs(text, "").some((p) => "id" in p);

const when = (iso: string | null) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null; };

/**
 * One task: what to do, then what you can do (r13). A task whose next step names an action leads with that step, the title under it; a "Say …"
 * step's own action is "Say it in #room ›" (the room's composer, filled in, never sent); "I did this" stays secondary. A decision is answered
 * here with the companion's control, and only beside its whole question: a cut title's question is read from its note first, and if none is
 * found the sheet offers the note, with no answers. The sheet is live: `task` is the list's current copy; `gone` says it closed elsewhere.
 */
export function TaskSheet({ task, gone = false, here, nodeName, room, inRoom, onClose, onAct, onDecide, onNote, onOpenRoom, onSay, onPriority, onStale }: {
  task: Task; gone?: boolean; here: string; nodeName: (path: string) => string; room: RoomRef | null;
  /** The room open now: "Open in #room" is not offered for it. */
  inRoom?: string | null;
  /** A write against the revision shown (r16): the sheet waits for it, closes on success, and on a conflict stays with the latest copy. */
  onClose: () => void; onAct: (t: Task, a: TaskAction) => Promise<ActResult> | void; onDecide: (t: Task, option: string) => void; onOpenRoom: (id: string) => void;
  /** Open a note in its vault (a link in the next step; the task's own note when its question is not whole anywhere else). */
  onNote: (ref: NoteRef) => void;
  /** Put words in a room's composer (never sends). */
  onSay?: (roomId: string, text: string) => void;
  onPriority?: (t: Task, p: Priority) => void;
  /** The note was read at a newer revision than the list's copy: re-read the list (the sheet then reads the question again). */
  onStale?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  // the sheet itself takes focus, never an action or an answer: Enter must not write by accident
  useEffect(() => { box.current?.focus(); const back = opener.current as HTMLElement | null; return () => { if (back?.isConnected) back.focus(); }; }, []);
  const key = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    trapTab(e, box.current); // r15: only reachable controls (never the closed Details' priority buttons)
  };
  /** The write under way, and whether the last one met a newer revision (r16): the sheet then shows the latest copy and says so. */
  const [busy, setBusy] = useState<TaskAction | null>(null);
  const [changed, setChanged] = useState(false);
  const go = async (a: TaskAction) => {
    if (busy) return;
    setBusy(a); setChanged(false);
    const r = await onAct(task, a);
    setBusy(null);
    if (!r || r.ok) onClose();
    else if (r.kind === "conflict") { setChanged(true); box.current?.focus(); }
    else onClose(); // the undo bar says what went wrong
  };
  /** The task's own vault (r15): its note and the notes its step links are read and opened there. */
  const profileVault = useVaultProfile().vault;
  const vault = task.vault ?? profileVault;
  const decision = task.kind === "decision";
  const { id: tid, rest } = taskTitle(cleanText(task.title));
  // r14: a cut question not known at this revision is read from its note here, keyed by the note and its revision: a new revision drops the
  // old question at once, and the answers sit only beside a question read at the revision they will be written against
  const rev = `${task.id}@${task.updatedAt ?? ""}`;
  const [ask, setAsk] = useState<{ rev: string; text: string | null; at: string | null } | null>(null);
  const known = decision ? decisionAsk(task) : null;
  const needsRead = !!known && !known.answerable;
  useEffect(() => {
    if (!needsRead) return;
    let live = true;
    vaultTasks.loadAsks([task]).then((m) => {
      if (!live) return;
      const a = m.get(task.id) ?? null;
      setAsk({ rev, text: a?.ask ?? null, at: a?.at ?? null });
      if (a && a.at !== task.updatedAt) onStale?.();
    }).catch(() => { if (live) setAsk({ rev, text: null, at: null }); });
    return () => { live = false; };
  }, [rev, needsRead]); // eslint-disable-line react-hooks/exhaustive-deps
  const read = ask && ask.rev === rev ? ask : null;
  /** The note is newer than the list's copy: its question is not shown with this copy's options; the list is being re-read. */
  const newer = !!read?.text && read.at !== task.updatedAt;
  const dq = known && !known.answerable && read?.text && !newer ? decisionAsk({ ...task, ask: read.text, askAt: read.at }) : known;
  const reading = needsRead && (!read || newer);
  const lead = decision ? null : actionLead(task.next);
  const say = lead ? sayText(lead) : null;
  const heading = dq ? (dq.answerable ? dq.text : reading ? (newer ? "This changed; reading the latest…" : "Reading the question…") : "The question is in its note") : lead ?? rest; // never the bare id
  /** "default yes": what a decision's title says happens without an answer, kept here though the row shows only the ask. */
  const dflt = decision ? /^decision\s*\(([^)]*)\)/i.exec(rest)?.[1]?.trim() ?? null : null;
  const by = changedBy(task);
  const at = when(task.updatedAt);
  const sayIn = !gone && say && room && onSay ? () => { onSay(room.id, say); onClose(); } : null;
  const prio = priorityOf(task);
  /** One primary action (r14): the step's own ("Say it in #room ›"), else "I did this". Then the rest, quietly. */
  const primary = sayIn ? "say" : !gone && !decision ? "done" : null;
  return <div className="task-sheet-wrap" onKeyDown={key}>
    <button type="button" className="task-backdrop" aria-label="Close" tabIndex={-1} onClick={onClose} />
    <div ref={box} className="task-sheet" role="dialog" aria-modal="true" aria-labelledby="task-sheet-title" tabIndex={-1}>
      <p className="task-kind">{decision ? `Decision${dflt ? ` (${dflt})` : ""}` : "Task"}{task.node !== here ? ` · in ${nodeName(task.node)}` : ""}</p>
      {dq?.answerable && dq.yourCall && <small className="cp-call-lead">Your call:</small>}
      <h2 id="task-sheet-title">{lead && !dq ? <RefText text={plainDetail(lead) || lead} vault={vault} /> : heading}</h2>
      {lead && <p className="task-sub">{rest}</p>}
      {gone && <p className="task-gone" role="status">This is no longer open: it was done, decided or changed elsewhere.</p>}
      {changed && !gone && <p className="task-gone task-changed" role="alert">This changed since you opened it. Nothing was saved; this is the latest.</p>}
      {dq?.answerable && dq.full !== dq.text && /https?:\/\/|\bwww\./.test(dq.full) && <div className="task-next"><NextText text={dq.full} vault={vault} onNote={(r) => { onClose(); onNote(r); }} /></div>}
      {dq && !dq.answerable && !reading && <p className="task-next"><button type="button" className="task-link" onClick={() => { onClose(); onNote({ vault, id: task.id }); }}>Open the note to read the question ›</button></p>}
      {/* the step itself, with its links to open, when the lead had to drop them (a URL, a linked note) or when it is not an action */}
      {task.next && (!lead || linky(task.next)) && <div className="task-next"><NextText text={task.next} vault={vault} onNote={(r) => { onClose(); onNote(r); }} /></div>}
      {task.nextCut && <p className="task-next task-cut">This step was cut short when it was written. <button type="button" className="task-link" onClick={() => { onClose(); onNote({ vault, id: task.id }); }}>Open the note ›</button></p>}
      {!gone && dq?.answerable && <DecisionAnswer t={task} label={heading} onDecide={(t, o) => { onDecide(t, o); onClose(); }} className="task-answer" />}
      <dl className="task-facts">
        <dt>Status</dt><dd>{stateLine(task, (w) => isMe(w), OWNER)}</dd>
        {!isMe(task.owner) && !isMe(task.waitingOn) && <><dt>With</dt><dd>{OWNER(task.owner)}</dd></>}
        {task.due && <><dt>Due</dt><dd>{dueLine(task.due)}</dd></>}
      </dl>
      <div className="task-actions">
        {primary === "say" && <button type="button" className="task-do primary" onClick={sayIn!}>Say it in #{room!.name.replace(/^#/, "")} ›</button>}
        {!gone && !decision && <button type="button" className={`task-do${primary === "done" ? " primary" : ""}`} aria-busy={busy === "done" || undefined} disabled={!!busy} onClick={() => void go("done")}>{busy === "done" ? "Saving…" : "I did this"}</button>}
        {!gone && !decision && <button type="button" className="task-do" aria-busy={busy === "archive" || undefined} disabled={!!busy} onClick={() => void go("archive")}>{busy === "archive" ? "Archiving…" : "Archive"}</button>}
        {!gone && <button type="button" className="task-do" aria-busy={busy === "snooze" || undefined} disabled={!!busy} onClick={() => void go("snooze")}>{busy === "snooze" ? "Snoozing…" : "Snooze until tomorrow"}</button>}
        {!sayIn && room && room.id !== inRoom && <button type="button" className="task-do quiet" onClick={() => { onOpenRoom(room.id); onClose(); }}>Open in #{room.name.replace(/^#/, "")}</button>}
        <button type="button" className="task-do quiet" onClick={onClose}>Close</button>
      </div>
      {(tid || at || (!gone && !decision && onPriority)) && <details className="task-details" onToggle={(e) => { const d = e.currentTarget; if (d.open) requestAnimationFrame(() => d.scrollIntoView({ block: "nearest" })); }}><summary>Details</summary>
        {!gone && !decision && onPriority && <div className="task-prio" role="group" aria-label="Priority">
          {PRIORITIES.map((p) => <button key={p} type="button" className="task-prio-b" aria-pressed={p === prio} onClick={() => { if (p !== prio) onPriority(task, p); }}>{PRIORITY_LABEL[p]}</button>)}
        </div>}
        {tid && <p>{decision ? "Decision" : "Task"} {tid}</p>}
        {at && <p>Last changed{by ? ` by ${by}` : ""}, {at}</p>}
      </details>}
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
