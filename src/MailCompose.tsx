// T-210: the mail composer. Who a message is from is a choice you see, never a default you might miss: a new message
// from the combined view has no sender until you pick one, a reply goes from the thread's mailbox (locked), and every
// Send button says who it sends as, with the address beside it. Only a button sends: Enter in a field never does.
//
// Sending is the bridge's contract. Mail from you is saved as a draft first, then you review exactly what was saved
// (the bridge fingerprints the stored message), then Send sends that draft by id, under one operation id per review,
// so a retry can never send twice. Mail as Uni goes through the bridge's deputy path and Uni's outbound rules.
// When a send gets no answer its outcome is unknown: the composer offers no edit and no new send, only Check again (or
// the same send again once the bridge says it never arrived), and the operation id is kept on the device until the
// bridge says what happened (Mail checks it later if the composer is closed).
//
// Mail keeps the composer while you look at a thread or leave Mail (`snapshot`), and Close asks before it drops text
// that isn't saved.
import { useEffect, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  addressLine, can, canSendFrom, formatAddresses, mailProblem, newOpId, parseAddresses, readPending, sameFields, sendLabel, sendOutcomeText,
  settled, subjectLabel, uncertain, whoMail, whoTag, withoutPending, withPending, writePending,
  type AccountBoxes, type DraftFields, type MailProblem, type Overview, type Reviewed, type SendOutcome, type Who,
} from "./mailCore";

/** YOU (filled) or UNI (dashed outline), with the address when `address` is given. */
export function WhoTag({ who, address }: { who: Who; address?: string }) {
  return <span className={`mail-who who-${who}`} aria-label={address ? `${whoMail(who)}, ${address}` : whoMail(who)}>
    {whoTag(who)}{address && <small>{address}</small>}
  </span>;
}

/** What opens the composer: a new message (`from` preset, or null to pick), a reply (from the thread's mailbox), or an
 *  existing draft to review and send (Uni's, or your own). */
export type ComposeStart =
  | { kind: "new"; from: string | null }
  | { kind: "reply"; accountId: string; fields: DraftFields }
  | { kind: "draft"; accountId: string; draftId: string; fields: DraftFields; uni: boolean };

type Saved = { accountId: string; draftId: string; fingerprint: string; fields: DraftFields };
type Review = { fields: DraftFields; reviewed: Reviewed | null; opId: string };
type Stage =
  | { kind: "edit" }
  | { kind: "opening" }
  | { kind: "open-failed" }
  | { kind: "busy"; what: string }
  | ({ kind: "review" } & Review)
  /** `lost`: the send got no answer; `absent`: the bridge has no record of it (it never arrived: nothing was sent). */
  | ({ kind: "outcome"; out: SendOutcome; lost?: boolean; absent?: boolean } & Review);
type Raw = { to: string; cc: string; bcc: string; subject: string; text: string };

/** What Mail keeps of a composer while you look elsewhere. */
export type ComposerSnapshot = { from: string | null; raw: Raw; baseline: Raw; showCc: boolean; saved: Saved | null; discardAhead: string[]; stage: Stage; dirty: boolean };

/** Enter in a one-line field never submits anything. */
const noEnter = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") e.preventDefault(); };
const store = () => (typeof localStorage === "undefined" ? null : localStorage);

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many.replace("#", String(n));
}

function rawOf(f: DraftFields | null): Raw {
  return { to: f ? formatAddresses(f.to) : "", cc: f ? formatAddresses(f.cc) : "", bcc: f ? formatAddresses(f.bcc) : "", subject: f?.subject ?? "", text: f?.text ?? "" };
}

export default function Composer({ overview, start, snapshot, onSnapshot, onClose, onDone, onPendingChange }: {
  overview: Overview; start: ComposeStart; snapshot: ComposerSnapshot | null; onSnapshot: (s: ComposerSnapshot) => void;
  onClose: (changed: boolean) => void; onDone: () => void; onPendingChange: () => void;
}) {
  const first = start.kind === "new" ? null : start.fields;
  const [from, setFrom] = useState<string | null>(snapshot?.from ?? (start.kind === "new" ? start.from : start.accountId));
  const [raw, setRaw] = useState<Raw>(snapshot?.raw ?? rawOf(first));
  const [baseline, setBaseline] = useState<Raw>(snapshot?.baseline ?? rawOf(first));
  const [showCc, setShowCc] = useState(snapshot?.showCc ?? (!!first && (first.cc.length > 0 || first.bcc.length > 0)));
  const inReplyTo = start.kind === "reply" ? start.fields.in_reply_to : null;
  const [saved, setSaved] = useState<Saved | null>(snapshot?.saved ?? null);
  const [discardAhead, setDiscardAhead] = useState<string[]>(snapshot?.discardAhead ?? []);
  const [stage, setStage] = useState<Stage>(snapshot?.stage ?? (start.kind === "draft" ? { kind: "opening" } : { kind: "edit" }));
  const [problem, setProblem] = useState<MailProblem | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const acct: AccountBoxes | undefined = overview.accounts.find((a) => a.id === from);
  const senders = overview.accounts.filter(canSendFrom);
  const asUni = acct?.who === "uni";
  const sendable = canSendFrom(acct);
  const locked = start.kind !== "new" || saved !== null;
  const dirty = (Object.keys(raw) as (keyof Raw)[]).some((k) => raw[k] !== baseline[k]);
  const setField = (k: keyof Raw) => (v: string) => { setRaw((r) => ({ ...r, [k]: v })); setConfirmClose(false); };

  // Mail keeps what is being written while you look elsewhere (a send in flight is in the pending list, not here)
  useEffect(() => {
    const keep: Stage = stage.kind === "busy" || stage.kind === "opening" ? { kind: "edit" } : stage;
    onSnapshot({ from, raw, baseline, showCc, saved, discardAhead, stage: keep, dirty });
  }, [from, raw, baseline, showCc, saved, discardAhead, stage, dirty]);

  // an existing draft: what the bridge says it is now (its fingerprint, and the Uni drafts sending it will discard).
  // Until that answer, nothing can be edited: a save without it would make a second draft beside the one opened.
  const open = () => {
    if (start.kind !== "draft") return;
    setProblem(null); setStage({ kind: "opening" });
    invoke<Reviewed>("mail_draft_review", { accountId: start.accountId, draftId: start.draftId })
      .then((r) => { setSaved({ accountId: start.accountId, draftId: r.draft_id, fingerprint: r.fingerprint, fields: start.fields }); setDiscardAhead(r.discard); setStage({ kind: "edit" }); })
      .catch((e) => { setProblem(mailProblem(e)); setStage({ kind: "open-failed" }); });
  };
  useEffect(() => { if (stage.kind === "opening") open(); }, []);

  /** The fields as typed, or the first address that isn't one. */
  const fields = (): DraftFields | string => {
    const lists = { to: parseAddresses(raw.to), cc: parseAddresses(raw.cc), bcc: parseAddresses(raw.bcc) };
    const bad = [...lists.to.bad, ...lists.cc.bad, ...lists.bcc.bad];
    if (bad.length > 0) return `Not an email address: ${bad[0]}`;
    return { to: lists.to.list, cc: lists.cc.list, bcc: lists.bcc.list, subject: raw.subject.trim(), text: raw.text, in_reply_to: inReplyTo ?? saved?.fields.in_reply_to ?? null };
  };

  const fail = (e: unknown) => { setProblem(mailProblem(e)); };

  /** Save as a draft in your Drafts (over the one this composer already saved or opened, in that draft's account). */
  const save = async (f: DraftFields): Promise<Reviewed> => {
    const account = saved?.accountId ?? from;
    const r = await invoke<Reviewed>("mail_draft_save", { accountId: account, fields: f, replaces: saved?.draftId ?? null, base: saved?.fingerprint ?? null });
    setSaved({ accountId: account!, draftId: r.draft_id, fingerprint: r.fingerprint, fields: f });
    setBaseline(raw);
    setDiscardAhead(r.discard);
    setChanged(true);
    return r;
  };

  const saveDraft = async (thenClose = false) => {
    const f = fields();
    if (typeof f === "string") { setNote(f); setConfirmClose(false); return; }
    setProblem(null); setNote(null); setStage({ kind: "busy", what: "Saving…" });
    try { await save(f); if (thenClose) { onClose(true); return; } setNote("Saved in your Drafts."); } catch (e) { fail(e); }
    setStage({ kind: "edit" });
  };

  /** Step 1: what will be sent, exactly. Your mail is saved first and reviewed as stored; mail as Uni is reviewed as typed. */
  const review = async () => {
    const f = fields();
    if (typeof f === "string") { setNote(f); return; }
    if (f.to.length + f.cc.length + f.bcc.length === 0) { setNote("Add who it's to."); return; }
    setProblem(null); setNote(null); setConfirmClose(false);
    if (asUni) { setStage({ kind: "review", fields: f, reviewed: null, opId: newOpId() }); return; }
    setStage({ kind: "busy", what: "Saving the draft to review it…" });
    try {
      const r = saved && sameFields(saved.fields, f)
        ? await invoke<Reviewed>("mail_draft_review", { accountId: saved.accountId, draftId: saved.draftId })
        : await save(f);
      setSaved({ accountId: r.account_id, draftId: r.draft_id, fingerprint: r.fingerprint, fields: f });
      setDiscardAhead(r.discard);
      setStage({ kind: "review", fields: f, reviewed: r, opId: newOpId() });
    } catch (e) { fail(e); setStage({ kind: "edit" }); }
  };

  const unknownOut = (s: Review): SendOutcome => ({ op_id: s.opId, account_id: from ?? "", draft_id: s.reviewed?.draft_id ?? null, state: "unknown",
    reason: "no answer from the mail bridge", submission_id: null, delivery: null, note: null });

  /** Step 2: send what was reviewed, under the review's operation id (a retry is the same send). The id is kept on the
   *  device until the bridge gives an outcome, so a lost answer is checked, never sent again under a new id. */
  const send = async (r: Review) => {
    if (!from || !acct) return;
    const s: Review = { fields: r.fields, reviewed: r.reviewed, opId: r.opId };
    writePending(store(), withPending(readPending(store()), { account_id: from, op_id: s.opId, who: acct.who, at: new Date().toISOString() }));
    onPendingChange();
    setProblem(null); setStage({ kind: "busy", what: "Sending…" });
    try {
      const out = asUni
        ? await invoke<SendOutcome>("mail_send_as_uni", { accountId: from, opId: s.opId, fields: s.fields })
        : await invoke<SendOutcome>("mail_send", { accountId: from, opId: s.opId, reviewed: s.reviewed });
      setChanged(true);
      if (settled(out.state)) { writePending(store(), withoutPending(readPending(store()), s.opId)); onPendingChange(); }
      setStage({ ...s, kind: "outcome", out });
    } catch (e) {
      fail(e);
      if (uncertain(e)) { setStage({ ...s, kind: "outcome", out: unknownOut(s), lost: true }); return; }
      // a refusal: nothing was sent
      writePending(store(), withoutPending(readPending(store()), s.opId)); onPendingChange();
      setStage({ ...s, kind: "review" });
    }
  };

  const check = async (s: Extract<Stage, { kind: "outcome" }>) => {
    if (!from) return;
    setProblem(null); setStage({ kind: "busy", what: "Checking…" });
    try {
      const out = await invoke<SendOutcome>("mail_send_check", { accountId: from, opId: s.opId });
      if (settled(out.state)) { writePending(store(), withoutPending(readPending(store()), s.opId)); onPendingChange(); }
      setStage({ ...s, out, lost: false, absent: false });
    } catch (e) {
      const p = mailProblem(e);
      // the bridge has no send under this id: it never arrived. The same send (same id) can go again safely.
      if (p.kind === "refused" && p.detail.startsWith("404")) { setStage({ ...s, absent: true, lost: false }); return; }
      fail(e); setStage(s);
    }
  };

  const discard = async () => {
    if (!saved) { onClose(changed); return; }
    setProblem(null); setStage({ kind: "busy", what: "Discarding…" });
    try { await invoke("mail_draft_discard", { accountId: saved.accountId, draftId: saved.draftId }); onClose(true); }
    catch (e) { fail(e); setStage({ kind: "edit" }); }
  };

  const close = () => { if (dirty && !confirmClose) { setConfirmClose(true); return; } onClose(changed); };

  const who: Who | null = acct?.who ?? null;
  const label = who ? sendLabel(who) : "Choose who it's from";
  const busy = stage.kind === "busy" || stage.kind === "opening";
  const sendBlock = (onClick: () => void, final: boolean) => <span className="mail-send-block">
    <button type="button" className="send mail-send" disabled={!sendable || busy} onClick={onClick}
      aria-label={acct ? `${label}${final ? "" : ": review first"}, from ${acct.name}` : label}>{acct ? `${label}${final ? "" : "…"}` : label}</button>
    {acct && <small className="mail-send-from">from {acct.name}</small>}
  </span>;
  const cantSend = acct && !sendable && <p className="mail-note" role="status">The mail bridge doesn't offer sending from this mailbox now.</p>;

  const fromBlock = <div className="mail-compose-from" role="group" aria-label="From">
    <span className="mail-compose-label">From</span>
    {locked || stage.kind !== "edit"
      ? acct ? <><WhoTag who={acct.who} address={acct.name} /><small className="mail-note">{start.kind === "reply" ? "the mailbox this thread is in" : start.kind === "draft" ? "the mailbox this draft is in" : "saved in this mailbox's Drafts"}</small></> : <span className="mail-note">This mailbox can't send.</span>
      : <span className="mail-compose-pick">
        {from === null && <span className="mail-note">Choose who it's from:</span>}
        {senders.map((a) => <label key={a.id} className={`mail-from-pick ${from === a.id ? "on" : ""}`}>
          <input type="radio" name="mail-from" checked={from === a.id} onChange={() => setFrom(a.id)} />
          <WhoTag who={a.who} address={a.name} />
        </label>)}
      </span>}
  </div>;

  const uniDraft = start.kind === "draft" && start.uni;
  const discardNote = discardAhead.length > 0 && <p className="mail-draft-note" role="note"><span className="mail-draft-tag">UNI'S EARLIER DRAFTS</span>
    <span>Sending this discards {plural(discardAhead.length, "Uni's 1 earlier draft", "Uni's # earlier drafts")} in this thread.</span></p>;
  const problemBox = problem && <div className="note-error mail-problem" role="alert"><p className="mail-problem-title">{problem.title}</p><p className="mail-problem-help">{problem.detail}</p></div>;

  if (stage.kind === "opening" || stage.kind === "open-failed") {
    return <section className="mail-compose" aria-label={uniDraft ? "Review Uni's draft" : "Edit draft"}>
      <div className="mail-compose-bar">
        <button type="button" className="note-action" onClick={() => onClose(false)}>✕ Close</button>
        <strong className="mail-compose-title">{uniDraft ? "Uni's draft" : "Draft"}</strong>
      </div>
      <div className="mail-scroll">
        {stage.kind === "opening" ? <p className="mail-loading" role="status">Opening the draft…</p> : <>
          {problemBox}
          <p className="mail-note">The draft couldn't be opened for review, so it can't be edited or sent yet.</p>
          <p><button type="button" className="cp-retry" onClick={open}>Retry</button></p>
        </>}
      </div>
    </section>;
  }

  const inFlight = stage.kind === "busy" && (stage.what === "Sending…" || stage.what === "Checking…");
  if (stage.kind === "review" || stage.kind === "outcome" || inFlight) {
    const s = stage.kind === "review" || stage.kind === "outcome" ? stage : null;
    const f = s?.fields;
    const said = stage.kind === "outcome" && who ? sendOutcomeText(stage.out, who) : null;
    const canEdit = stage.kind === "review" || (stage.kind === "outcome" && !!said && !said.done && !said.blocked && !stage.lost && !stage.absent);
    return <section className="mail-compose mail-review" aria-label="Review before sending">
      <div className="mail-compose-bar">
        {canEdit && <button type="button" className="note-action" onClick={() => setStage({ kind: "edit" })}>← Edit</button>}
        <strong className="mail-compose-title">{stage.kind === "review" ? "Check what will be sent" : "Sending"}</strong>
        {stage.kind === "review" && sendBlock(() => void send(stage), true)}
        {inFlight && <span className="mail-loading" role="status">{stage.what}</span>}
      </div>
      <div className="mail-scroll">
        {fromBlock}
        {cantSend}
        {f && <dl className="mail-headers mail-review-headers">
          <dt>To</dt><dd>{addressLine(f.to) || "—"}</dd>
          {f.cc.length > 0 && <><dt>Cc</dt><dd>{addressLine(f.cc)}</dd></>}
          {f.bcc.length > 0 && <><dt>Bcc</dt><dd>{addressLine(f.bcc)}</dd></>}
          <dt>Subject</dt><dd>{subjectLabel(f.subject)}</dd>
        </dl>}
        {f && <pre className="mail-review-text">{f.text || "(no text)"}</pre>}
        {stage.kind === "review" && (asUni
          ? <p className="mail-note">Uni's outbound rules check this before it goes. If they want your approval, it waits in Uni's Drafts.</p>
          : <p className="mail-note">This is the draft as saved in your Drafts. Send sends exactly this, once.</p>)}
        {stage.kind === "review" && discardNote}
        {problemBox}
        {stage.kind === "review" && problem && <p className="mail-note">Nothing was sent. You can send again, or edit it first.</p>}
        {stage.kind === "outcome" && said && <div className={`mail-outcome state-${stage.out.state}`} role="status">
          <p className="mail-outcome-text">{stage.absent ? "The mail bridge has no record of this send: it never arrived, and nothing was sent." : said.text}</p>
          {stage.lost && <p className="mail-note">The mail bridge didn't answer, so it may have gone. It can't be edited or sent under a new id until the bridge says what happened.</p>}
          {stage.out.note && <p className="mail-note">This draft had already been sent; nothing new went out.</p>}
          {stage.out.delivery && <ul className="mail-delivery">{Object.entries(stage.out.delivery).map(([a, st]) => <li key={a}>{a}: {st}</li>)}</ul>}
          <p className="mail-outcome-actions">
            {stage.absent && <button type="button" className="send mail-send" disabled={!sendable} onClick={() => void send(stage)}>Send it again (the same send)</button>}
            {!stage.absent && said.blocked && !said.done && <button type="button" className="note-action" disabled={!can(acct, "send.check")} onClick={() => void check(stage)}>Check again</button>}
            <button type="button" className="note-action" onClick={said.done ? onDone : () => onClose(true)}>Close</button>
          </p>
        </div>}
      </div>
    </section>;
  }

  return <section className="mail-compose" aria-label={uniDraft ? "Review Uni's draft" : start.kind === "reply" ? "Reply" : start.kind === "draft" ? "Edit draft" : "New message"}>
    <div className="mail-compose-bar">
      <button type="button" className="note-action" onClick={close}>✕ Close</button>
      <strong className="mail-compose-title">{uniDraft ? "Uni's draft" : start.kind === "reply" ? "Reply" : start.kind === "draft" ? "Draft" : "New message"}</strong>
      {!asUni && acct && can(acct, "draft.save") && <button type="button" className="note-quiet" disabled={busy} onClick={() => void saveDraft()}>Save draft</button>}
      {sendBlock(() => void review(), false)}
    </div>
    {confirmClose && <div className="mail-confirm" role="alertdialog" aria-label="Close without saving?">
      <span>This message has changes that aren't saved.</span>
      <button type="button" className="note-action" onClick={() => setConfirmClose(false)}>Keep writing</button>
      {!asUni && acct && can(acct, "draft.save") && <button type="button" className="note-action" onClick={() => void saveDraft(true)}>Save draft and close</button>}
      <button type="button" className="note-action" onClick={() => onClose(changed)}>Close without saving</button>
    </div>}
    <div className="mail-scroll">
      {fromBlock}
      {cantSend}
      {uniDraft && <p className="mail-draft-note" role="note"><span className="mail-draft-tag">DRAFT · BY UNI · NOT SENT</span>
        <span>Uni wrote this in your Drafts. Uni can't send as you: nothing goes out unless you send it here.</span></p>}
      {discardNote}
      {asUni && <p className="mail-note">As Uni: it goes from Uni's address, through Uni's outbound rules.</p>}
      <div className="mail-compose-fields">
        <label><span>To</span><input type="text" inputMode="email" autoComplete="off" value={raw.to} onChange={(e) => setField("to")(e.target.value)} onKeyDown={noEnter} placeholder="name@example.com, …" /></label>
        {showCc ? <>
          <label><span>Cc</span><input type="text" inputMode="email" autoComplete="off" value={raw.cc} onChange={(e) => setField("cc")(e.target.value)} onKeyDown={noEnter} /></label>
          <label><span>Bcc</span><input type="text" inputMode="email" autoComplete="off" value={raw.bcc} onChange={(e) => setField("bcc")(e.target.value)} onKeyDown={noEnter} /></label>
        </> : <button type="button" className="note-quiet mail-cc-open" onClick={() => setShowCc(true)}>Cc / Bcc</button>}
        <label><span>Subject</span><input type="text" value={raw.subject} onChange={(e) => setField("subject")(e.target.value)} onKeyDown={noEnter} /></label>
        <label className="mail-compose-body"><span>Message</span><textarea value={raw.text} onChange={(e) => setField("text")(e.target.value)} rows={10} /></label>
      </div>
      {note && <p className="mail-note" role="status">{note}</p>}
      {stage.kind === "busy" && <p className="mail-loading" role="status">{stage.what}</p>}
      {problemBox}
      {saved && acct && can(acct, "draft.discard") && <p className="mail-compose-discard"><button type="button" className="note-quiet" disabled={busy} onClick={() => void discard()}>Discard draft</button></p>}
    </div>
  </section>;
}
