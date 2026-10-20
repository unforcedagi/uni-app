// T-210: the mail composer. Who a message is from is a choice you see, never a default you might miss: a new message
// from the combined view has no sender until you pick one, a reply goes from the thread's mailbox (locked), and every
// Send button says who it sends as, with the address beside it. Only a button sends: Enter in a field never does.
//
// Sending is the bridge's contract. Mail from you is saved as a draft first, then you review exactly what was saved
// (the bridge fingerprints the stored message), then Send sends that draft by id, under one operation id per review,
// so a retry can never send twice. Mail as Uni goes through the bridge's deputy path and Uni's outbound rules.
import { useEffect, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  addressLine, canSendFrom, formatAddresses, mailProblem, newOpId, parseAddresses, sameFields, sendLabel, sendOutcomeText, subjectLabel, whoMail, whoTag,
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

type Saved = { draftId: string; fingerprint: string; fields: DraftFields };
type Stage =
  | { kind: "edit" }
  | { kind: "busy"; what: string }
  | { kind: "review"; fields: DraftFields; reviewed: Reviewed | null; opId: string }
  | { kind: "outcome"; fields: DraftFields; reviewed: Reviewed | null; opId: string; out: SendOutcome };

/** Enter in a one-line field never submits anything. */
const noEnter = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") e.preventDefault(); };

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many.replace("#", String(n));
}

export default function Composer({ overview, start, onClose, onDone }: {
  overview: Overview; start: ComposeStart; onClose: (changed: boolean) => void; onDone: () => void;
}) {
  const locked = start.kind !== "new";
  const [from, setFrom] = useState<string | null>(start.kind === "new" ? start.from : start.accountId);
  const first = start.kind === "new" ? null : start.fields;
  const [to, setTo] = useState(first ? formatAddresses(first.to) : "");
  const [cc, setCc] = useState(first ? formatAddresses(first.cc) : "");
  const [bcc, setBcc] = useState(first ? formatAddresses(first.bcc) : "");
  const [showCc, setShowCc] = useState(!!first && (first.cc.length > 0 || first.bcc.length > 0));
  const [subject, setSubject] = useState(first?.subject ?? "");
  const [text, setText] = useState(first?.text ?? "");
  const inReplyTo = start.kind === "reply" ? start.fields.in_reply_to : null;
  const [saved, setSaved] = useState<Saved | null>(null);
  const [discardAhead, setDiscardAhead] = useState<string[]>([]);
  const [stage, setStage] = useState<Stage>(start.kind === "draft" ? { kind: "busy", what: "Opening the draft…" } : { kind: "edit" });
  const [problem, setProblem] = useState<MailProblem | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const acct: AccountBoxes | undefined = overview.accounts.find((a) => a.id === from);
  const senders = overview.accounts.filter(canSendFrom);
  const asUni = acct?.who === "uni";

  // an existing draft: what the bridge says it is now (its fingerprint, and the Uni drafts sending it will discard)
  useEffect(() => {
    if (start.kind !== "draft") return;
    let live = true;
    invoke<Reviewed>("mail_draft_review", { accountId: start.accountId, draftId: start.draftId })
      .then((r) => { if (!live) return; setSaved({ draftId: r.draft_id, fingerprint: r.fingerprint, fields: start.fields }); setDiscardAhead(r.discard); setStage({ kind: "edit" }); })
      .catch((e) => { if (live) { setProblem(mailProblem(e)); setStage({ kind: "edit" }); } });
    return () => { live = false; };
  }, []);

  /** The fields as typed, or the first address that isn't one. */
  const fields = (): DraftFields | string => {
    const lists = { to: parseAddresses(to), cc: parseAddresses(cc), bcc: parseAddresses(bcc) };
    const bad = [...lists.to.bad, ...lists.cc.bad, ...lists.bcc.bad];
    if (bad.length > 0) return `Not an email address: ${bad[0]}`;
    return { to: lists.to.list, cc: lists.cc.list, bcc: lists.bcc.list, subject: subject.trim(), text, in_reply_to: inReplyTo ?? saved?.fields.in_reply_to ?? null };
  };

  const fail = (e: unknown) => { setProblem(mailProblem(e)); };

  /** Save as a draft in your Drafts (over the one this composer already saved or opened). */
  const save = async (f: DraftFields): Promise<Reviewed> => {
    const r = await invoke<Reviewed>("mail_draft_save", { accountId: from, fields: f, replaces: saved?.draftId ?? null, base: saved?.fingerprint ?? null });
    setSaved({ draftId: r.draft_id, fingerprint: r.fingerprint, fields: f });
    setDiscardAhead(r.discard);
    setChanged(true);
    return r;
  };

  const saveDraft = async () => {
    const f = fields();
    if (typeof f === "string") { setNote(f); return; }
    setProblem(null); setNote(null); setStage({ kind: "busy", what: "Saving…" });
    try { await save(f); setNote("Saved in your Drafts."); } catch (e) { fail(e); }
    setStage({ kind: "edit" });
  };

  /** Step 1: what will be sent, exactly. Your mail is saved first and reviewed as stored; mail as Uni is reviewed as typed. */
  const review = async () => {
    const f = fields();
    if (typeof f === "string") { setNote(f); return; }
    if (f.to.length + f.cc.length + f.bcc.length === 0) { setNote("Add who it's to."); return; }
    setProblem(null); setNote(null);
    if (asUni) { setStage({ kind: "review", fields: f, reviewed: null, opId: newOpId() }); return; }
    setStage({ kind: "busy", what: "Saving the draft to review it…" });
    try {
      const r = saved && sameFields(saved.fields, f)
        ? await invoke<Reviewed>("mail_draft_review", { accountId: from, draftId: saved.draftId })
        : await save(f);
      setSaved({ draftId: r.draft_id, fingerprint: r.fingerprint, fields: f });
      setDiscardAhead(r.discard);
      setStage({ kind: "review", fields: f, reviewed: r, opId: newOpId() });
    } catch (e) { fail(e); setStage({ kind: "edit" }); }
  };

  /** Step 2: send what was reviewed, under the review's operation id (a retry is the same send). */
  const send = async (s: Extract<Stage, { kind: "review" }>) => {
    setProblem(null); setStage({ kind: "busy", what: "Sending…" });
    try {
      const out = asUni
        ? await invoke<SendOutcome>("mail_send_as_uni", { accountId: from, opId: s.opId, fields: s.fields })
        : await invoke<SendOutcome>("mail_send", { accountId: from, opId: s.opId, reviewed: s.reviewed });
      setChanged(true);
      setStage({ ...s, kind: "outcome", out });
    } catch (e) { fail(e); setStage(s); }
  };

  const check = async (s: Extract<Stage, { kind: "outcome" }>) => {
    setProblem(null); setStage({ kind: "busy", what: "Checking…" });
    try { setStage({ ...s, out: await invoke<SendOutcome>("mail_send_check", { accountId: from, opId: s.opId }) }); }
    catch (e) { fail(e); setStage(s); }
  };

  const discard = async () => {
    if (!saved || !from) { onClose(changed); return; }
    setProblem(null); setStage({ kind: "busy", what: "Discarding…" });
    try { await invoke("mail_draft_discard", { accountId: from, draftId: saved.draftId }); onClose(true); }
    catch (e) { fail(e); setStage({ kind: "edit" }); }
  };

  const who: Who | null = acct?.who ?? null;
  const label = who ? sendLabel(who) : "Choose who it's from";
  const busy = stage.kind === "busy";
  const sendBlock = (onClick: () => void, final: boolean) => <span className="mail-send-block">
    <button type="button" className="send mail-send" disabled={!acct || busy} onClick={onClick}
      aria-label={acct ? `${label}${final ? "" : ": review first"}, from ${acct.name}` : label}>{acct ? `${label}${final ? "" : "…"}` : label}</button>
    {acct && <small className="mail-send-from">from {acct.name}</small>}
  </span>;

  const fromBlock = <div className="mail-compose-from" role="group" aria-label="From">
    <span className="mail-compose-label">From</span>
    {locked || stage.kind !== "edit"
      ? acct ? <><WhoTag who={acct.who} address={acct.name} />{locked && <small className="mail-note">{start.kind === "reply" ? "the mailbox this thread is in" : "the mailbox this draft is in"}</small>}</> : <span className="mail-note">This mailbox can't send.</span>
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

  if (stage.kind === "review" || stage.kind === "outcome" || (busy && (stage.what === "Sending…" || stage.what === "Checking…"))) {
    const s = stage.kind === "review" || stage.kind === "outcome" ? stage : null;
    const f = s?.fields;
    const said = stage.kind === "outcome" && who ? sendOutcomeText(stage.out, who) : null;
    return <section className="mail-compose mail-review" aria-label="Review before sending">
      <div className="mail-compose-bar">
        {stage.kind === "review" && <button type="button" className="note-action" onClick={() => setStage({ kind: "edit" })}>← Edit</button>}
        {stage.kind === "outcome" && !said?.blocked && !said?.done && <button type="button" className="note-action" onClick={() => setStage({ kind: "edit" })}>← Edit</button>}
        <strong className="mail-compose-title">{stage.kind === "outcome" ? "Sending" : "Check what will be sent"}</strong>
        {stage.kind === "review" && sendBlock(() => void send(stage), true)}
        {busy && <span className="mail-loading" role="status">{stage.what}</span>}
      </div>
      <div className="mail-scroll">
        {fromBlock}
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
        {problem && <div className="note-error mail-problem" role="alert"><p className="mail-problem-title">{problem.title}</p><p className="mail-problem-help">{problem.detail}</p>
          {stage.kind === "review" && <p className="mail-note">Trying again is safe: it is the same send, and it can't go out twice.</p>}</div>}
        {stage.kind === "outcome" && said && <div className={`mail-outcome state-${stage.out.state}`} role="status">
          <p className="mail-outcome-text">{said.text}</p>
          {stage.out.note && <p className="mail-note">This draft had already been sent; nothing new went out.</p>}
          {stage.out.delivery && <ul className="mail-delivery">{Object.entries(stage.out.delivery).map(([a, st]) => <li key={a}>{a}: {st}</li>)}</ul>}
          <p className="mail-outcome-actions">
            {stage.out.state === "unknown" && <button type="button" className="note-action" onClick={() => void check(stage)}>Check again</button>}
            {(said.done || stage.out.state === "unknown") && <button type="button" className="note-action" onClick={onDone}>Close</button>}
          </p>
        </div>}
      </div>
    </section>;
  }

  return <section className="mail-compose" aria-label={uniDraft ? "Review Uni's draft" : start.kind === "reply" ? "Reply" : start.kind === "draft" ? "Edit draft" : "New message"}>
    <div className="mail-compose-bar">
      <button type="button" className="note-action" onClick={() => onClose(changed)}>✕ Close</button>
      <strong className="mail-compose-title">{uniDraft ? "Uni's draft" : start.kind === "reply" ? "Reply" : start.kind === "draft" ? "Draft" : "New message"}</strong>
      {!asUni && acct && <button type="button" className="note-quiet" disabled={busy} onClick={() => void saveDraft()}>Save draft</button>}
      {sendBlock(() => void review(), false)}
    </div>
    <div className="mail-scroll">
      {fromBlock}
      {uniDraft && <p className="mail-draft-note" role="note"><span className="mail-draft-tag">DRAFT · BY UNI · NOT SENT</span>
        <span>Uni wrote this in your Drafts. Uni can't send as you: nothing goes out unless you send it here.</span></p>}
      {discardNote}
      {asUni && <p className="mail-note">As Uni: it goes from Uni's address, through Uni's outbound rules.</p>}
      <div className="mail-compose-fields">
        <label><span>To</span><input type="text" inputMode="email" autoComplete="off" value={to} onChange={(e) => setTo(e.target.value)} onKeyDown={noEnter} placeholder="name@example.com, …" /></label>
        {showCc ? <>
          <label><span>Cc</span><input type="text" inputMode="email" autoComplete="off" value={cc} onChange={(e) => setCc(e.target.value)} onKeyDown={noEnter} /></label>
          <label><span>Bcc</span><input type="text" inputMode="email" autoComplete="off" value={bcc} onChange={(e) => setBcc(e.target.value)} onKeyDown={noEnter} /></label>
        </> : <button type="button" className="note-quiet mail-cc-open" onClick={() => setShowCc(true)}>Cc / Bcc</button>}
        <label><span>Subject</span><input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} onKeyDown={noEnter} /></label>
        <label className="mail-compose-body"><span>Message</span><textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} /></label>
      </div>
      {note && <p className="mail-note" role="status">{note}</p>}
      {busy && <p className="mail-loading" role="status">{stage.what}</p>}
      {problem && <div className="note-error mail-problem" role="alert"><p className="mail-problem-title">{problem.title}</p><p className="mail-problem-help">{problem.detail}</p></div>}
      {saved && <p className="mail-compose-discard"><button type="button" className="note-quiet" disabled={busy} onClick={() => void discard()}>Discard draft</button></p>}
    </div>
  </section>;
}
