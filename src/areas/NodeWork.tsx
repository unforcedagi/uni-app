// The task sheet (r13: live, its own action first, answers only beside the whole question) and the undo bar. Styling is in areas.css and tree.css.
import { useEffect, useRef, useState } from "react";
import { cleanText } from "../interface/contract";
import { isMe, ownerLabel, PRIORITIES, PRIORITY_LABEL, priorityOf, type Priority, type Task } from "./taskCore";
import type { RoomRef } from "./talkCore";
import type { ActResult, TaskAction, Undo } from "./useTasks";
import { actionLead, actionOf, askedLine, checkInCue, checkInResult, checkingBanner, couldntRead, currentStep, type CheckIn, type RoomMsg, unresolvedBlock, isApprovalRequest, requestKeys, type ChatHit, pointsAt, pointsNowhere, quotedMessage, requestDate, withoutCut, answerLabel, answerText, ANSWER_MAX, checkLine, CHECK_FAILED, CHECKING, cutWords, dueLine, hostOf, withHosts, missingLine, OPEN_TASK, OPEN_TO_ANSWER, stateLine, stepAudience, TIDY_SAYS, toTidy, unknownDecision, waitsLine, waitsOnMe } from "./simpleCore";
import { requestRecheck } from "./useTasks";
import { taskTitle } from "./whereCore";
import { DecisionAnswer, NextText, decisionAsk, rowLinkLabel, supportOf } from "./Companion";
import { RefText } from "./noteRefs";
import { splitRefs, type NoteRef } from "./noteRefsCore";
import { useVaultProfile } from "./ProfileContext";
import { changedBy, vaultTasks } from "./vaultTasks";
import { openDialog } from "./focusTrap";
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "../clipboard";

export { ownerLabel };
const OWNER = (o: string) => ownerLabel(o);
const capFirst = (s: string) => (s ? s[0].toLocaleUpperCase() + s.slice(1) : s);

/** A step with something to open in it: a web link or a linked note. */
const linky = (text: string) => /https?:\/\/|\bwww\./.test(text) || splitRefs(text, "").some((p) => "id" in p);

const when = (iso: string | null) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null; };

/**
 * One task: what to do, then what you can do (r13). A task whose next step names an action leads with that step, the title under it; a "Say …"
 * step's own action is "Say it in #room ›" (the room's composer, filled in, never sent); "I did this" stays secondary. A decision is answered
 * here with the companion's control, and only beside its whole question: a cut title's question is read from its note first, and if none is
 * found the sheet offers the note, with no answers. The sheet is live: `task` is the list's current copy; `gone` says it closed elsewhere.
 */
/** The web links a step holds, in order. */
const URLS = /https?:\/\/[^\s)>\]]+|\bwww\.[^\s)>\]]+/g;
const linksIn = (text: string): string[] => [...text.matchAll(URLS)].map((m) => { const u = m[0].replace(/[.,;:'"’”]+$/, ""); return /^www\./i.test(u) ? `https://${u}` : u; });
/** A step that asks the user to look at or open something (r22): its link is the step's own action. */
const LOOK = /^(?:look|open|view|visit|see|check|try|watch|read|test)\b/i;

export function TaskSheet({ task, gone = false, here, nodeName, room, roomNamed, inRoom, onClose, onAct, onDecide, onNote, onOpenRoom, onSay, onPriority, onStale, draft = null }: {
  task: Task; gone?: boolean; here: string; nodeName: (path: string) => string; room: RoomRef | null;
  /** r24: the joined room a step names ("#cohere's 'For Eileen' block"), when there is one */
  roomNamed?: (name: string) => RoomRef | null;
  /** r22 (Codex P1): the room's last message time (seconds), from the rooms list: a chat more than a day newer than the request is cued. */
  /** The room open now: "Open in #room" is not offered for it. */
  inRoom?: string | null;
  /** A write against the revision shown (r16): the sheet waits for it, closes on success, and on a conflict stays with the latest copy. */
  onClose: () => void; onAct: (t: Task, a: TaskAction) => Promise<ActResult> | void;
  /** r17: the sheet waits for an answer's write, closes when it is recorded, and keeps the question with the reason when it isn't. */
  onDecide: (t: Task, option: string) => Promise<{ ok: boolean; message?: string }> | void; onOpenRoom: (id: string, focus?: string | null, checking?: string | null) => void;
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
  const wrap = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  // r19: one dialog contract: the sheet itself takes focus (never an action or an answer: Enter must not write by accident), Tab stays among its
  // reachable controls (r15: never the closed Details' priority buttons), what is under it is inert, Escape closes it, and focus goes back
  useEffect(() => (box.current && wrap.current ? openDialog(box.current, () => closeRef.current(), { root: wrap.current, initial: box.current }) : undefined), []);
  // r20: an open sheet's reads go first in every queue (its notes, its question)
  useEffect(() => { vaultTasks.prioritize(task.id); return () => vaultTasks.prioritize(null); }, [task.id]);
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
  const [ask, setAsk] = useState<{ rev: string; text: string | null; at: string | null; failed?: boolean } | null>(null);
  const known = decision ? decisionAsk(task) : null;
  const needsRead = !!known && !known.answerable;
  useEffect(() => {
    if (!needsRead) return;
    let live = true;
    vaultTasks.loadAsks([task]).then((m) => {
      if (!live) return;
      const a = m.get(task.id) ?? null;
      setAsk({ rev, text: a?.ask || null, at: a?.at ?? null, failed: !!a?.failed });
      if (a && !a.failed && a.at !== task.updatedAt) onStale?.();
    }).catch(() => { if (live) setAsk({ rev, text: null, at: null, failed: true }); });
    return () => { live = false; };
  }, [rev, needsRead]); // eslint-disable-line react-hooks/exhaustive-deps
  const read = ask && ask.rev === rev ? ask : null;
  /** The note is newer than the list's copy: its question is not shown with this copy's options; the list is being re-read. */
  const newer = !!read?.text && read.at !== task.updatedAt;
  const dq = known && !known.answerable && read?.text && !newer ? decisionAsk({ ...task, ask: read.text, askAt: read.at }) : known;
  const reading = needsRead && (!read || newer);
  /** r19: what the notes it stands on came to, as the list last checked them (read again with every list read): its question source (an
   *  explicit list, a closed source, or neither), still being read, couldn't be read, or a `depends_on` note still open. */
  // r20: a decision has the same contract for the notes it stands on (`source`, `depends_on`) as a task
  const ck = task.check ?? null;
  const support = supportOf(task);
  /** r18: its source note is closed: the sheet asks whether it is still needed, and never leads with the action it doubts. */
  const check = support?.kind === "closed" ? support : null;
  /** r20: a decision whose question isn't read yet (here or by the list) is checking too: no answers, never "Decide: …" */
  const unread = decision && unknownDecision(task) && !(dq && dq.answerable) && !(read && !read.failed);
  const checking = ck?.kind === "checking" || (unread && !task.askFailed && !read?.failed);
  const unavailable = ck?.kind === "unavailable" || (decision && !!(task.askFailed || read?.failed) && !(dq && dq.answerable));
  const waits = ck?.kind === "waits" ? ck : null;
  /** r20: a note it stands on that the vault doesn't have: unresolved, "Couldn't find … · Open the task". */
  const missing = ck?.kind === "missing" ? ck : null;
  /** r19: a record that isn't a real request: never the action or an answer. r21: it needs rewording by its room; nothing here asks the user. */
  const tidy = toTidy(task);
  /** Where its questions are, once read: an explicit list, or "Open the note to answer". */
  const asks = support?.kind === "list" || support?.kind === "unclear" ? support : null;
  /** Nothing here may assert the step as current: not checked, doubted, waiting on another note, or not a real request. */
  const unsure = !!check || checking || unavailable || !!waits || !!missing || !!tidy;
  // r17: someone else's task that waits on the user leads with what it asks of them, whatever its first word
  // r23: a step that points at words nobody stored ("…the message below") asks the room for them; a draft note written for it is those words
  const nowhere = decision || unsure || draft ? null : pointsNowhere(task, room?.name ?? task.room);
  // r25: the same current step as the row (`currentStep`): the heading and the row say the same words
  const step = currentStep({ ...task, hasDraft: task.hasDraft || !!draft }, room?.name ?? task.room);
  const lead = decision || unsure ? null : actionLead(step) ?? (waitsOnMe(task) && step ? step : null);
  /** r22 (Codex 7): the request said once: the action (its steps, numbered, when it has more than one) is the body; context after it follows */
  const act = lead && !decision ? actionOf(lead) : null;
  const steps = act && act.steps.length > 1 ? act : null;
  /** Who the step's words are for (r17): the room ("Say go…", "Tell Uni…", a step naming this room), or a person outside it ("Tell Christian…"). */
  const audience = decision || !lead || nowhere ? null : stepAudience(task.next, room?.name ?? null);
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
  const heading = missing ? missingLine(missing) : check ? checkLine(check) : checking ? CHECKING : unavailable ? rest : waits ? waitsLine(waits) : tidy ? (dq?.answerable ? dq.text : rest) : dq ? (dq.answerable ? dq.text : reading ? (newer ? "This changed; reading the latest…" : CHECKING) : "The question is in its note") : lead ?? rest; // never the bare id
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
  // r23: the message a task's `detail` quotes ("Send this to Ryan: 'Hey Ryan, …'") is the message too
  const message = toPerson ? task.message ?? quotedMessage(task.detail) ?? draftText : null;
  const dest = toPerson ? (task.link ? { href: task.link, label: /^mailto:/i.test(task.link) ? `Email ${task.link.replace(/^mailto:/i, "").split("?")[0]}` : `Open ${hostOf(task.link)}` } : toPerson.link) : null;
  const askDraft = !gone && toPerson && !message && !task.detail && room && onSay ? () => { onSay(room.id, `Please draft the message for ${tid ?? "this task"} (${cutWords(rest, 80)}): ${task.next.trim()}`); onClose(); } : null;
  /** One primary action (r14): the step's own ("Say it in #room ›"; toward a person: its message, its destination, or a draft from Uni), else "I did this". */
  /** r23: "Ask #room for the message": the request goes in the room's composer (never sent) */
  const askRoom = !gone && nowhere && room && onSay ? () => { onSay(room.id, `Please post the ${pointsAt(task.next)?.noun ?? "message"} for ${tid ?? "this task"}: ${task.next.trim()}`); onClose(); } : null;
  const primary0 = missing ? "task" : check || waits ? "source" : checking || unavailable || tidy ? "note" : askRoom ? "askroom" : sayIn ? "say" : !gone && toPerson ? (message ? "message" : dest ? "dest" : askDraft ? "draft" : "done") : !gone && !decision ? "done" : null;
  const openOut = (href: string) => { void invoke("open_link", { url: href }).catch(() => { try { window.open(href, "_blank", "noopener"); } catch { /* nothing to open with */ } }); };
  /** r22 (Codex 7): a link in a step is a button in that step ("Open cohere-signup-staging"); for a "look at / open" step it is the primary action */
  const firstStep = steps ? steps.steps[0] : act?.text ?? "";
  const lookOpen = !gone && !!act && LOOK.test(firstStep.trim()) && linksIn(firstStep).length > 0;
  /** r24 (Codex P1 2): the cue shows only for a room-directed or approval request whose room has talked about it since it was asked/added */
  const reqAt = requestDate(task);
  const asked = askedLine(reqAt);
  const approval = isApprovalRequest(task, !!say);
  // r25 (Codex P1 2): the lookup has three results, and a failure is never read as "nothing related"
  const [look, setLook] = useState<CheckIn | null>(null);
  const [tries, setTries] = useState(0);
  const hit: ChatHit | null = look?.kind === "found" ? look.hit : null;
  const lookFailed = look?.kind === "failed";
  useEffect(() => {
    setLook(null);
    if (gone || !room || !reqAt || !approval) return;
    let live = true;
    const keys = requestKeys(task);
    // a test build can block the lookup (`VITE_CHECKIN_BLOCK=1`), to show the "couldn't check" state in the real app
    const lookup: Promise<unknown> = import.meta.env.VITE_CHECKIN_BLOCK === "1" ? Promise.reject(new Error("blocked")) : invoke("get_messages", { channel: room.id, root: null, limit: 200 });
    lookup.then((r) => { if (live) setLook(checkInResult(reqAt, Array.isArray(r) ? (r as RoomMsg[]) : null, keys)); }).catch(() => { if (live) setLook({ kind: "failed" }); });
    return () => { live = false; };
  }, [task.id, task.updatedAt, room?.id, gone, approval, reqAt?.at, tries]); // eslint-disable-line react-hooks/exhaustive-deps
  const blockGap = unresolvedBlock(task.next, task.detail);
  const movedOn = !gone && !unsure && !!room && !!hit;
  // couldn't read the room: no cue and no "Check in"; the room opens as the primary, and "I did this" and "Say it" stay secondary
  const primary = movedOn ? "check" : !gone && !unsure && !!room && lookFailed ? "openroom" : primary0 === "done" && lookOpen ? "open" : primary0;
  const stepLinks = (text: string, first: boolean) => {
    const ls = linksIn(text);
    return ls.length ? <span className="task-step-links">{ls.map((u, i) => <button key={i} type="button" className={`task-do task-step-open${first && i === 0 && primary === "open" ? " primary" : ""}`} title={u} onClick={() => openOut(u)}>Open {rowLinkLabel(hostOf(u))}</button>)}</span> : null;
  };
  /** The title under the action, one line of whole words; the whole of it (and the note's own words) is in Details (r18). */
  const sub = cutWords(withoutCut(rest), 96, false);
  const about = (task.ask && task.ask.trim() !== rest.trim() ? task.ask.trim() : null) ?? (sub !== rest && !act ? rest : null);
  /** r18: a decision with no stored options is answered in words, written like a tap: one revision-guarded write of `decided`. */
  const [words, setWords] = useState("");
  const typed = answerText(words);
  return <div ref={wrap} className="task-sheet-wrap">
    <button type="button" className="task-backdrop" aria-label="Close" tabIndex={-1} onClick={onClose} />
    <div ref={box} className="task-sheet" role="dialog" aria-modal="true" aria-labelledby="task-sheet-title" tabIndex={-1}>
      {/* r23: the body scrolls in its own region above the footer, so nothing in it (a cue, a step) is ever drawn under the footer */}
      <div className="task-body">
      <p className="task-kind">{decision ? `Decision${dflt ? ` (${dflt})` : ""}` : "Task"}{task.node !== here ? ` · in ${nodeName(task.node)}` : ""}</p>
      {/* r23: when it was asked, and whether the chat has moved on, first: a short window never scrolls it out of sight */}
      {asked && <p className="task-asked" data-asked={reqAt?.at ?? undefined} data-kind={reqAt?.kind}>{capFirst(asked)}{movedOn && <> · <span className="task-movedon" data-key={hit!.key}>{checkInCue(room!.name, hit!.key, reqAt!)}</span></>}</p>}
      {/* r25: the chat couldn't be read, which is not "nothing related" */}
      {!gone && !unsure && !!room && lookFailed && <p className="task-q-note task-lookfail" role="status">{couldntRead(room.name)} · <button type="button" className="task-link" onClick={() => setTries((n) => n + 1)}>Retry</button></p>}
      {dq?.answerable && dq.yourCall && !unsure && <small className="cp-call-lead">Your call:</small>}
      {/* r21: a step of more than one part ("A, then B") is listed, numbered, under how many steps it is */}
      <h2 id="task-sheet-title">{steps ? `${steps.steps.length} steps` : act ? <RefText text={withHosts(act.text)} vault={vault} onNote={(r) => { onClose(); onNote(r); }} /> : heading}</h2>
      {act && !steps && stepLinks(act.text, true)}
      {steps && <ol className="task-steps">{steps.steps.map((x, i) => <li key={i}><RefText text={withHosts(capFirst(x))} vault={vault} onNote={(r) => { onClose(); onNote(r); }} />{stepLinks(x, i === 0)}</li>)}</ol>}
      {act?.rest && <p className="task-next task-steps-rest"><RefText text={withHosts(capFirst(act.rest))} vault={vault} onNote={(r) => { onClose(); onNote(r); }} />{stepLinks(act.rest, false)}</p>}
      {/* r23: the content the ask carries (`detail`: the message, the questions, the draft), as stored */}
      {!unsure && blockGap && (() => { const named = blockGap.room ? roomNamed?.(blockGap.room) ?? null : room; const where = blockGap.room ?? room?.name.replace(/^#/, "") ?? null; return <p className="task-block-gap">{named ? <button type="button" className="task-link" onClick={() => { onOpenRoom(named.id); onClose(); }}>Open #{(blockGap.room ?? named.name).replace(/^#/, "")} to find the '{blockGap.name}' block ›</button> : <>{where ? `Open #${where}` : "Look"} to find the '{blockGap.name}' block</>}</p>; })()}
      {!unsure && task.detail && !blockGap && <div className="task-detail">{task.detail.split(/\n\s*\n/).map((para, i) => <p key={i}><DetailText text={para.trim()} vault={vault} onNote={(r) => { onClose(); onNote(r); }} /></p>)}</div>}
      {/* r22 (Codex 7): the record's title is in Details; here only where it is the subject (a check, a wait, a missing note) */}
      {(check || checking || waits || missing || (unavailable && decision)) && <p className="task-sub" title={sub !== rest ? rest : undefined}>{sub}</p>}
      {/* r19: why nothing is asserted yet */}
      {checking && <p className="task-q-note" role="status" aria-busy="true">{decision && !ck ? "Reading its note before saying what it asks." : "Reading the notes this stands on before saying what it needs."}</p>}
      {unavailable && <p className="task-q-note task-checkfail" role="status">{CHECK_FAILED}: {decision && !ck ? "its note" : "the notes this stands on"} couldn't be read just now. <button type="button" className="task-link" onClick={requestRecheck}>Retry</button></p>}
      {waits && <p className="task-q-note">This waits on that note, which is still open. When it is finished, this comes back with its step.</p>}
      {/* r20: a missing note is unresolved, never read past */}
      {missing && <p className="task-q-note task-missing" role="status">A note this stands on isn't in the vault: it may have been moved, renamed or deleted. Nothing here is asked of you until it is found; open the task to see what it needs.</p>}
      {tidy && !missing && !check && !checking && !unavailable && !waits && <p className="task-q-note task-tidy">{TIDY_SAYS[tidy]} It needs rewording by its room as one clear request, or closing. Nothing here is yours to do.</p>}
      {gone && <p className="task-gone" role="status">This is no longer open: it was done, decided or changed elsewhere.</p>}
      {changed && !gone && <p className="task-gone task-changed" role="alert">This changed since you opened it. Nothing was saved; this is the latest.</p>}
      {dq?.answerable && !unsure && dq.full !== dq.text && /https?:\/\/|\bwww\./.test(dq.full) && <div className="task-next"><NextText text={dq.full} vault={vault} onNote={(r) => { onClose(); onNote(r); }} /></div>}
      {dq && !dq.answerable && !reading && !unsure && <p className="task-next"><button type="button" className="task-link" onClick={() => { onClose(); onNote({ vault, id: task.id }); }}>Open the note to read the question ›</button></p>}
      {/* the step itself, with its links to open, when the lead had to drop them (a URL, a linked note) or when it is not an action; never under "Check" */}
      {!unsure && task.next && !act && (!lead || linky(task.next)) && <div className="task-next"><NextText text={task.next} vault={vault} onNote={(r) => { onClose(); onNote(r); }} /></div>}
      {!unsure && task.nextCut && <p className="task-next task-cut">(the note ends here · <button type="button" className="task-link" onClick={() => { onClose(); onNote({ vault, id: task.id }); }}>open the note</button>)</p>}
      {check && <p className="task-q-note">{decision ? "This decision stands on that note" : "Its questions came from that note"}, and it is {check.how === "superseded" ? "superseded" : "closed"}. If this still needs you, its note says what; if not, archive it.</p>}
      {asks && !unsure && <section className="task-questions" aria-label={asks.kind === "list" ? answerLabel(asks.items.length) : OPEN_TO_ANSWER}>
        {asks.kind === "list" ? <>
            <h3 className="task-q-h">{answerLabel(asks.items.length)}</h3>
            <ol className="task-q-list">{asks.items.map((q, i) => <li key={i}><RefText text={q} vault={vault} /></li>)}</ol>
            {asks.from && <p className="task-q-note">From <button type="button" className="task-link" onClick={() => { onClose(); onNote({ vault: asks.from!.vault, id: asks.from!.id }); }}>{asks.from.title} ›</button></p>}
          </>
          : <p className="task-q-note"><button type="button" className="task-link" onClick={() => { onClose(); onNote(asks.from ? { vault: asks.from.vault, id: asks.from.id } : { vault, id: task.id }); }}>{OPEN_TO_ANSWER} ›</button></p>}
      </section>}
      {decideError && !gone && <p className="task-gone task-changed" role="alert">{decideError}</p>}
      <dl className="task-facts">
        {/* r19: a record to tidy is Uni's to fix, never "Needs your decision"; r20: nor is one not read yet */}
        <dt>Status</dt><dd>{missing ? "Can't be checked: a note is missing" : decision && (checking || unavailable) ? "Not read yet" : tidy ? "Needs rewording by its room: not a request yet" : stateLine(task, (w) => isMe(w), OWNER)}</dd>
        {!isMe(task.owner) && <><dt>{isMe(task.waitingOn) ? "Task of" : "With"}</dt><dd>{OWNER(task.owner)}</dd></>}
        {task.due && <><dt>Due</dt><dd>{dueLine(task.due)}</dd></>}
      </dl>
      {/* r17: housekeeping sits below the real action, smaller and quieter. r20: inside the scrolling body, above the sticky footer, so a short
          window never hides it behind the footer */}
      {!gone && !tidy && <div className="task-house" role="group" aria-label="Put aside">
        {!decision && <button type="button" className="task-house-b" aria-busy={busy === "archive" || undefined} disabled={!!busy} onClick={() => void go("archive")}>{busy === "archive" ? "Archiving…" : "Archive"}</button>}
        <button type="button" className="task-house-b" aria-busy={busy === "snooze" || undefined} disabled={!!busy} onClick={() => void go("snooze")}>{busy === "snooze" ? "Snoozing…" : "Snooze until tomorrow"}</button>
      </div>}
      {(tid || at || about || check || act || (!gone && !decision && onPriority)) && <details className="task-details" onToggle={(e) => { const d = e.currentTarget; if (d.open) requestAnimationFrame(() => d.scrollIntoView({ block: "nearest" })); }}><summary>Details</summary>
        {!gone && !decision && !tidy && onPriority && <div className="task-prio" role="group" aria-label="Priority">
          {PRIORITIES.map((p) => <button key={p} type="button" className="task-prio-b" aria-pressed={p === prio} onClick={() => { if (p !== prio) onPriority(task, p); }}>{PRIORITY_LABEL[p]}</button>)}
        </div>}
        {/* r18: the note's own words (the wall a row used to carry under its action) and, under "Check", the step it doubts */}
        {about && <p className="task-about"><RefText text={about} vault={vault} /></p>}
        {(unsure || (decision && tidy)) && !checking && task.next && <p className="task-about">Its step: <RefText text={task.next} vault={vault} /> <button type="button" className="task-link" onClick={() => { onClose(); onNote({ vault, id: task.id }); }}>This task's note ›</button></p>}
        {(tid || act) && <p className="task-record">{decision ? "Decision" : "Task"}{tid ? ` ${tid}` : ""}{act ? `: ${withoutCut(rest)}` : ""}</p>}
        {at && <p>Last changed{by ? ` by ${by}` : ""}, {at}</p>}
      </details>}
      </div>
      {/* r19: the actions are the sheet's footer, kept in view however short the window (the sheet scrolls above them). r20: the last thing in
          the sheet, so nothing scrolls behind it */}
      <div className="task-actions task-foot">
        {/* a decision's answers are its primary action: in the footer too, so a short window never hides them behind it */}
        {!gone && !unsure && dq?.answerable && !dq.box && <DecisionAnswer t={task} label={heading} onDecide={(t, o) => void answer(t, o)} className={`task-answer${deciding ? " busy" : ""}`} />}
        {!gone && !unsure && dq?.answerable && dq.box && <form className="task-answer-box" onSubmit={(e) => { e.preventDefault(); if (typed) void answer(task, typed); }}>
          <label htmlFor="task-answer-words">Answer in your words</label>
          <div className="task-answer-row">
            <input id="task-answer-words" type="text" value={words} maxLength={ANSWER_MAX} autoComplete="off" onChange={(e) => setWords(e.target.value)} disabled={deciding} />
            <button type="submit" className="task-do primary" disabled={!typed || deciding} aria-busy={deciding || undefined}>{deciding ? "Saving…" : "Answer"}</button>
          </div>
        </form>}
        {primary === "task" && <button type="button" className="task-do primary" onClick={() => { onClose(); onNote({ vault, id: task.id }); }}>{OPEN_TASK}</button>}
        {primary === "note" && <button type="button" className="task-do primary" onClick={() => { onClose(); onNote({ vault, id: task.id }); }}>Open the note</button>}
        {primary === "source" && <button type="button" className="task-do primary" onClick={() => { const f = (check ?? waits)!.from; onClose(); onNote({ vault: f.vault, id: f.id }); }}>Open the note</button>}
        {primary === "check" && <button type="button" className="task-do primary" onClick={() => { onOpenRoom(room!.id, hit?.ref ?? null, checkingBanner(step)); onClose(); }}>Check in #{room!.name.replace(/^#/, "")} first</button>}
        {primary === "openroom" && <button type="button" className="task-do primary" onClick={() => { onOpenRoom(room!.id); onClose(); }}>Open #{room!.name.replace(/^#/, "")}</button>}
        {sayIn && (primary === "say" || primary === "check" || primary === "openroom") && <button type="button" className={`task-do${primary === "say" ? " primary" : ""}`} onClick={sayIn}>Say it in #{room!.name.replace(/^#/, "")} ›</button>}
        {primary === "askroom" && <button type="button" className="task-do primary" onClick={askRoom!}>Ask in #{room!.name.replace(/^#/, "")} ›</button>}
        {primary === "message" && <button type="button" className="task-do primary" aria-live="polite" onClick={() => void copyText(message!, "Copied the message").then((ok) => { if (ok) setCopied(true); })}>{copied ? "Copied" : "Copy the message"}</button>}
        {dest && (primary === "dest" || primary === "message") && <button type="button" className={`task-do${primary === "dest" ? " primary" : ""}`} onClick={() => openOut(dest.href)}>{dest.label} ›</button>}
        {askDraft && <button type="button" className={`task-do${primary === "draft" ? " primary" : ""}`} onClick={askDraft}>Ask Uni to draft it</button>}
        {!gone && !decision && !unsure && <button type="button" className={`task-do${primary === "done" ? " primary" : ""}`} aria-busy={busy === "done" || undefined} disabled={!!busy} onClick={() => void go("done")}>{busy === "done" ? "Saving…" : "I did this"}</button>}
        {!sayIn && !askRoom && !tidy && primary !== "openroom" && room && room.id !== inRoom && <button type="button" className="task-do quiet" onClick={() => { onOpenRoom(room.id); onClose(); }}>Open in #{room.name.replace(/^#/, "")}</button>}
        <button type="button" className="task-do quiet" onClick={onClose}>Close</button>
      </div>
    </div>
  </div>;
}

/** r23: a task's `detail` as written: a `[[Path|Name]]` link is a link to that note ("Name", or the path's last part), an id is its note. */
function DetailText({ text, vault, onNote }: { text: string; vault: string; onNote: (r: NoteRef) => void }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    const i = m.index ?? 0;
    if (i > at) parts.push(<RefText key={`t${i}`} text={text.slice(at, i)} vault={vault} onNote={onNote} />);
    const path = m[1].trim();
    parts.push(<button key={`l${i}`} type="button" className="task-link" onClick={() => onNote({ vault, id: path })}>{(m[2] ?? path.split("/").pop() ?? path).trim()}</button>);
    at = i + m[0].length;
  }
  if (at < text.length) parts.push(<RefText key="end" text={text.slice(at)} vault={vault} onNote={onNote} />);
  return <>{parts}</>;
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
