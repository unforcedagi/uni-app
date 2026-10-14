// The task sheet (r13: live, its own action first, answers only beside the whole question) and the undo bar. Styling is in areas.css and tree.css.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cleanText } from "../interface/contract";
import { isMe, ownerLabel, PRIORITIES, PRIORITY_LABEL, priorityOf, type Priority, type Task } from "./taskCore";
import type { RoomRef } from "./talkCore";
import type { ActResult, TaskAction, Undo } from "./useTasks";
import { actionLead, answerLabel, answerText, ANSWER_MAX, checkLine, cutWords, dueLine, hostOf, OPEN_TO_ANSWER, questionCount, stateLine, stepAudience, waitsOnMe, type Support } from "./simpleCore";
import { taskTitle } from "./whereCore";
import { DecisionAnswer, NextText, decisionAsk, plainDetail, supportOf } from "./Companion";
import { RefText } from "./noteRefs";
import { splitRefs, type NoteRef } from "./noteRefsCore";
import { useVaultProfile } from "./ProfileContext";
import { changedBy, vaultTasks } from "./vaultTasks";
import { trapTab } from "./focusTrap";
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "../clipboard";

export { ownerLabel };
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
export function TaskSheet({ task, gone = false, here, nodeName, room, inRoom, onClose, onAct, onDecide, onNote, onOpenRoom, onSay, onPriority, onStale, nodeKeys = [], draft = null }: {
  task: Task; gone?: boolean; here: string; nodeName: (path: string) => string; room: RoomRef | null;
  /** The room open now: "Open in #room" is not offered for it. */
  inRoom?: string | null;
  /** A write against the revision shown (r16): the sheet waits for it, closes on success, and on a conflict stays with the latest copy. */
  onClose: () => void; onAct: (t: Task, a: TaskAction) => Promise<ActResult> | void;
  /** r17: the sheet waits for an answer's write, closes when it is recorded, and keeps the question with the reason when it isn't. */
  onDecide: (t: Task, option: string) => Promise<{ ok: boolean; message?: string }> | void; onOpenRoom: (id: string) => void;
  /** The task's node as the vault may store it (path and id): a closed task merged into this one is looked for there (r17). */
  nodeKeys?: readonly string[];
  /** Open a note in its vault (a link in the next step; the task's own note when its question is not whole anywhere else). */
  onNote: (ref: NoteRef) => void;
  /** Put words in a room's composer (never sends). */
  onSay?: (roomId: string, text: string) => void;
  onPriority?: (t: Task, p: Priority) => void;
  /** The note was read at a newer revision than the list's copy: re-read the list (the sheet then reads the question again). */
  onStale?: () => void;
  /** r18: a draft note written for this task (`draft` tag, its `task` field): its text is the message "Copy the message" copies. */
  draft?: { vault: string; id: string } | null;
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
  /** r18: a step asking for answers to questions: where they come from (an explicit list, a closed source, or neither), as the row read it, else read here. */
  const want = decision ? null : questionCount(task.next);
  const known_ = want ? supportOf(task) : null;
  const [qs, setQs] = useState<{ rev: string; support: Support } | null>(null);
  useEffect(() => {
    if (!want || known_) return;
    let live = true;
    vaultTasks.loadSupport(task, nodeKeys, want).then((r) => { if (live) setQs({ rev, support: r }); }).catch(() => { if (live) setQs({ rev, support: { kind: "unclear", from: null } }); });
    return () => { live = false; };
  }, [rev, want, !!known_]); // eslint-disable-line react-hooks/exhaustive-deps
  const support = known_ ?? (want && qs?.rev === rev ? qs.support : null);
  /** r18: its source note is closed: the sheet asks whether it is still needed, and never leads with the action it doubts. */
  const check = support?.kind === "closed" ? support : null;
  // r17: someone else's task that waits on the user leads with what it asks of them, whatever its first word
  const lead = decision || check ? null : actionLead(task.next) ?? (waitsOnMe(task) && task.next.trim() ? task.next.trim() : null);
  /** Who the step's words are for (r17): the room ("Say go…", "Tell Uni…", a step naming this room), or a person outside it ("Tell Sebastian…"). */
  const audience = decision || !lead ? null : stepAudience(task.next, room?.name ?? null);
  const say = audience?.kind === "room" ? audience.text : null;
  const toPerson = audience?.kind === "person" ? audience : null;
  const [copied, setCopied] = useState(false);
  /** An answer being written (r17: the sheet waits for it), and why it wasn't recorded when it wasn't. */
  const [deciding, setDeciding] = useState(false);
  const [decideError, setDecideError] = useState<string | null>(null);
  const answer = async (t: Task, o: string) => {
    if (deciding) return;
    setDeciding(true); setDecideError(null);
    const r = await onDecide(t, o);
    setDeciding(false);
    if (!r || r.ok) onClose(); else { setDecideError(r.message ?? "Your answer wasn't recorded."); box.current?.focus(); }
  };
  const heading = check ? checkLine(check) : dq ? (dq.answerable ? dq.text : reading ? (newer ? "This changed; reading the latest…" : "Reading the question…") : "The question is in its note") : lead ?? rest; // never the bare id
  /** "default yes": what a decision's title says happens without an answer, kept here though the row shows only the ask. */
  const dflt = decision ? /^decision\s*\(([^)]*)\)/i.exec(rest)?.[1]?.trim() ?? null : null;
  const by = changedBy(task);
  const at = when(task.updatedAt);
  const sayIn = !gone && say !== null && room && onSay ? () => { onSay(room.id, say); onClose(); } : null;
  const prio = priorityOf(task);
  /**
   * r18, toward a person: the message itself when one is stored (the task's `message`/`draft` field, or its draft note's text) is "Copy the
   * message"; an explicit destination (the `link`/`url` field, or a `mailto:` written in the step) opens; with no message, "Ask Uni to draft it"
   * types a request in the owning room (never sent). The bare instruction is never what Copy copies.
   */
  const [draftText, setDraftText] = useState<string | null>(null);
  useEffect(() => {
    if (!toPerson || task.message || !draft) return;
    let live = true;
    invoke("vault_note", { vault: draft.vault, noteRef: draft.id }).then((r) => { const c = (r as { note?: { content?: unknown } } | null)?.note?.content; if (live && typeof c === "string" && c.trim()) setDraftText(c.trim()); }).catch(() => {});
    return () => { live = false; };
  }, [draft?.id, !!toPerson]); // eslint-disable-line react-hooks/exhaustive-deps
  const message = toPerson ? task.message ?? draftText : null;
  const dest = toPerson ? (task.link ? { href: task.link, label: /^mailto:/i.test(task.link) ? `Email ${task.link.replace(/^mailto:/i, "").split("?")[0]}` : `Open ${hostOf(task.link)}` } : toPerson.link) : null;
  const askDraft = !gone && toPerson && !message && room && onSay ? () => { onSay(room.id, `Please draft the message for ${tid ?? "this task"} (${cutWords(rest, 80)}): ${task.next.trim()}`); onClose(); } : null;
  /** One primary action (r14): the step's own ("Say it in #room ›"; toward a person: its message, its destination, or a draft from Uni), else "I did this". */
  const primary = check ? "source" : sayIn ? "say" : !gone && toPerson ? (message ? "message" : dest ? "dest" : askDraft ? "draft" : "done") : !gone && !decision ? "done" : null;
  const openOut = (href: string) => { void invoke("open_link", { url: href }).catch(() => { try { window.open(href, "_blank", "noopener"); } catch { /* nothing to open with */ } }); };
  /** The title under the action, one line of whole words; the whole of it (and the note's own words) is in Details (r18). */
  const sub = cutWords(rest, 96);
  const about = (task.ask && task.ask.trim() !== rest.trim() ? task.ask.trim() : null) ?? (sub !== rest ? rest : null);
  /** r18: a decision with no stored options is answered in words, written like a tap: one revision-guarded write of `decided`. */
  const [words, setWords] = useState("");
  const typed = answerText(words);
  return <div className="task-sheet-wrap" onKeyDown={key}>
    <button type="button" className="task-backdrop" aria-label="Close" tabIndex={-1} onClick={onClose} />
    <div ref={box} className="task-sheet" role="dialog" aria-modal="true" aria-labelledby="task-sheet-title" tabIndex={-1}>
      <p className="task-kind">{decision ? `Decision${dflt ? ` (${dflt})` : ""}` : "Task"}{task.node !== here ? ` · in ${nodeName(task.node)}` : ""}</p>
      {dq?.answerable && dq.yourCall && <small className="cp-call-lead">Your call:</small>}
      <h2 id="task-sheet-title">{lead && !dq ? <RefText text={plainDetail(lead) || lead} vault={vault} /> : heading}</h2>
      {(lead || check) && <p className="task-sub" title={sub !== rest ? rest : undefined}>{sub}</p>}
      {gone && <p className="task-gone" role="status">This is no longer open: it was done, decided or changed elsewhere.</p>}
      {changed && !gone && <p className="task-gone task-changed" role="alert">This changed since you opened it. Nothing was saved; this is the latest.</p>}
      {dq?.answerable && dq.full !== dq.text && /https?:\/\/|\bwww\./.test(dq.full) && <div className="task-next"><NextText text={dq.full} vault={vault} onNote={(r) => { onClose(); onNote(r); }} /></div>}
      {dq && !dq.answerable && !reading && <p className="task-next"><button type="button" className="task-link" onClick={() => { onClose(); onNote({ vault, id: task.id }); }}>Open the note to read the question ›</button></p>}
      {/* the step itself, with its links to open, when the lead had to drop them (a URL, a linked note) or when it is not an action; never under "Check" */}
      {!check && task.next && (!lead || linky(task.next)) && <div className="task-next"><NextText text={task.next} vault={vault} onNote={(r) => { onClose(); onNote(r); }} /></div>}
      {!check && task.nextCut && <p className="task-next task-cut">This step was cut short when it was written. <button type="button" className="task-link" onClick={() => { onClose(); onNote({ vault, id: task.id }); }}>Open the note ›</button></p>}
      {check && <p className="task-q-note">Its questions came from that note, and it is {check.how === "superseded" ? "superseded" : "closed"}. If this still needs you, its note says what; if not, archive it.</p>}
      {want && !check && <section className="task-questions" aria-label={support?.kind === "list" ? answerLabel(support.items.length) : OPEN_TO_ANSWER}>
        {!support ? <p className="task-q-note" role="status">Reading the questions…</p>
          : support.kind === "list" ? <>
            <h3 className="task-q-h">{answerLabel(support.items.length)}</h3>
            <ol className="task-q-list">{support.items.map((q, i) => <li key={i}><RefText text={q} vault={vault} /></li>)}</ol>
            {support.from && <p className="task-q-note">From <button type="button" className="task-link" onClick={() => { onClose(); onNote({ vault: support.from!.vault, id: support.from!.id }); }}>{support.from.title} ›</button></p>}
          </>
          : <p className="task-q-note"><button type="button" className="task-link" onClick={() => { onClose(); onNote(support.from ? { vault: support.from.vault, id: support.from.id } : { vault, id: task.id }); }}>{OPEN_TO_ANSWER} ›</button></p>}
      </section>}
      {decideError && !gone && <p className="task-gone task-changed" role="alert">{decideError}</p>}
      {!gone && dq?.answerable && !dq.box && <DecisionAnswer t={task} label={heading} onDecide={(t, o) => void answer(t, o)} className={`task-answer${deciding ? " busy" : ""}`} />}
      {!gone && dq?.answerable && dq.box && <form className="task-answer-box" aria-label="Answer in your words" onSubmit={(e) => { e.preventDefault(); if (typed) void answer(task, typed); }}>
        <label htmlFor="task-answer-words">Answer in your words</label>
        <div className="task-answer-row">
          <input id="task-answer-words" type="text" value={words} maxLength={ANSWER_MAX} autoComplete="off" onChange={(e) => setWords(e.target.value)} disabled={deciding} />
          <button type="submit" className="task-do primary" disabled={!typed || deciding} aria-busy={deciding || undefined}>{deciding ? "Saving…" : "Answer"}</button>
        </div>
      </form>}
      <dl className="task-facts">
        <dt>Status</dt><dd>{stateLine(task, (w) => isMe(w), OWNER)}</dd>
        {!isMe(task.owner) && <><dt>{isMe(task.waitingOn) ? "Task of" : "With"}</dt><dd>{OWNER(task.owner)}</dd></>}
        {task.due && <><dt>Due</dt><dd>{dueLine(task.due)}</dd></>}
      </dl>
      <div className="task-actions">
        {primary === "source" && <button type="button" className="task-do primary" onClick={() => { onClose(); onNote({ vault: check!.from.vault, id: check!.from.id }); }}>Open the note</button>}
        {primary === "say" && <button type="button" className="task-do primary" onClick={sayIn!}>Say it in #{room!.name.replace(/^#/, "")} ›</button>}
        {primary === "message" && <button type="button" className="task-do primary" aria-live="polite" onClick={() => void copyText(message!, "Copied the message").then((ok) => { if (ok) setCopied(true); })}>{copied ? "Copied" : "Copy the message"}</button>}
        {dest && (primary === "dest" || primary === "message") && <button type="button" className={`task-do${primary === "dest" ? " primary" : ""}`} onClick={() => openOut(dest.href)}>{dest.label} ›</button>}
        {askDraft && <button type="button" className={`task-do${primary === "draft" ? " primary" : ""}`} onClick={askDraft}>Ask Uni to draft it</button>}
        {!gone && !decision && !check && <button type="button" className={`task-do${primary === "done" ? " primary" : ""}`} aria-busy={busy === "done" || undefined} disabled={!!busy} onClick={() => void go("done")}>{busy === "done" ? "Saving…" : "I did this"}</button>}
        {!sayIn && !askDraft && room && room.id !== inRoom && <button type="button" className="task-do quiet" onClick={() => { onOpenRoom(room.id); onClose(); }}>Open in #{room.name.replace(/^#/, "")}</button>}
        <button type="button" className="task-do quiet" onClick={onClose}>Close</button>
      </div>
      {/* r17: housekeeping sits below the real action, smaller and quieter */}
      {!gone && <div className="task-house" role="group" aria-label="Put aside">
        {!decision && <button type="button" className="task-house-b" aria-busy={busy === "archive" || undefined} disabled={!!busy} onClick={() => void go("archive")}>{busy === "archive" ? "Archiving…" : "Archive"}</button>}
        <button type="button" className="task-house-b" aria-busy={busy === "snooze" || undefined} disabled={!!busy} onClick={() => void go("snooze")}>{busy === "snooze" ? "Snoozing…" : "Snooze until tomorrow"}</button>
      </div>}
      {(tid || at || about || check || (!gone && !decision && onPriority)) && <details className="task-details" onToggle={(e) => { const d = e.currentTarget; if (d.open) requestAnimationFrame(() => d.scrollIntoView({ block: "nearest" })); }}><summary>Details</summary>
        {!gone && !decision && onPriority && <div className="task-prio" role="group" aria-label="Priority">
          {PRIORITIES.map((p) => <button key={p} type="button" className="task-prio-b" aria-pressed={p === prio} onClick={() => { if (p !== prio) onPriority(task, p); }}>{PRIORITY_LABEL[p]}</button>)}
        </div>}
        {/* r18: the note's own words (the wall a row used to carry under its action) and, under "Check", the step it doubts */}
        {about && <p className="task-about"><RefText text={about} vault={vault} /></p>}
        {check && task.next && <p className="task-about">Its step: <RefText text={task.next} vault={vault} /> <button type="button" className="task-link" onClick={() => { onClose(); onNote({ vault, id: task.id }); }}>This task's note ›</button></p>}
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
