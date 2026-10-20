// Mail (T-45 v2): both mailboxes in three panes (mailboxes | threads | thread) that stack on a phone. The owner's own
// account is YOU, the one shared with it is UNI, and every row, group and header says which, in a word and a shape
// (never colour alone: the Daylight is grayscale). Every call goes to Rust, which signs it for the mail bridge; the
// webview never holds a mail credential.
// T-210: writes are the bridge's named operations, and each control shows only where the bridge offers it (`can`): a
// bridge without the write patch leaves Mail exactly as read-only as before. Opening a thread marks it read, Mark
// unread undoes it; Flag; Archive (your own mail only); Reply, New and a Uni draft's review open the composer
// (MailCompose.tsx), which saves, shows what will be sent, and sends it once.
// T-213: sends from Uni's address that its outbound rules hold for you are listed under "Waiting for you" in Uni's
// mailboxes, where the bridge offers deciding them. Each shows what it sends and why it waits; Send it (bound to the
// fingerprint of what is shown) and Don't send each take one confirm, never from Enter, and what happened stays shown.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import Composer, { WhoTag, type ComposeStart, type ComposerSnapshot } from "./MailCompose";
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "./clipboard";
import { splitLinks } from "./areas/linkText";
import { formatSize } from "./media";
import {
  addressLine, allInboxesUnread, can, canSendFrom, draftEditable, draftFields, mailboxLabel, readPending, sendOutcomeText, settled, withoutPending, writePending, mailDate, mailDateLong, mailProblem, mailSrcdoc, notVerified, replyFields,
  scopeKey, scopeTitle, scopeValid, senderLabel, sourcesFor, subjectLabel, whoMail, writesOffered,
  type AccountBoxes, type MailAttachment, type MailLink, type MailMessage, type MailProblem, type MailThread, type Overview, type Scope,
  type PendingSend, type SendOutcome, type Source, type ThreadPage, type ThreadSummary, type Who,
  approvalOffered, approveOutcome, canApprove, declineOutcome, heldFailure, type HeldOutcome, type Parked,
} from "./mailCore";
import { beginListing, endDeciding, heldEntries, heldGen, keepAccounts, mergeListing, onHeld, setOutcome, startDeciding, waiting, type HeldEntry } from "./mailHeld";
import "./Mail.css";

type List = { key: string; threads: ThreadSummary[]; next: Source[]; more: boolean; total: number | null };
type Open = { accountId: string; threadId: string };
type Compose = { key: number; start: ComposeStart; hidden: boolean; snapshot: ComposerSnapshot | null };
/** Where you were in Mail: the view remounts each time it is opened, and comes back to the same list, thread and
 *  message being written. */
const remembered: { scope: Scope; query: string; open: Open | null; compose: Compose | null } = { scope: { kind: "all-inboxes" }, query: "", open: null, compose: null };
/** A phone shows one pane at a time; a narrow tablet shows the boxes in place of the list. */
type Pane = "boxes" | "list" | "thread";
/** The Daylight (and every Android device): no motion at all. Each frame of an animation is an e-ink redraw. */
const still = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
const LATER = "Sending comes later";

function openLink(url: string) {
  void invoke("open_link", { url }).catch(() => {});
}

function Problem({ p, onRetry }: { p: MailProblem; onRetry: () => void }) {
  return <div className="note-error mail-problem" role="alert" data-kind={p.kind}>
    <p className="mail-problem-title">{p.title}</p>
    <p className="mail-problem-help">{p.help}</p>
    {p.pubkey && <p className="mail-key"><code>{p.pubkey}</code><button type="button" className="note-quiet" onClick={() => void copyText(p.pubkey!, "Copied this device's key")}>Copy key</button></p>}
    {p.retry && <p><button type="button" className="cp-retry" onClick={onRetry}>Retry</button></p>}
    <details className="note-error-more"><summary>Details</summary><p className="note-error-detail">{p.detail}</p></details>
  </div>;
}

/** New and Reply where the bridge doesn't offer sending (yet): shown so the place is learnt, disabled. `captioned` says so on the button. */
function LaterButton({ label, className = "note-action", captioned }: { label: string; className?: string; captioned?: boolean }) {
  return <button type="button" className={`${className} mail-later ${captioned ? "captioned" : ""}`} disabled aria-disabled="true" title={LATER} aria-label={`${label}: ${LATER.toLowerCase()}`}>
    {captioned ? <><span>{label}</span><small>{LATER}</small></> : label}
  </button>;
}

function PlainBody({ text }: { text: string }) {
  return <div className="mail-text">{splitLinks(text).map((part, i) => "url" in part
    ? <a key={i} href={part.url} title={part.url} onClick={(e) => { e.preventDefault(); openLink(part.url); }}>{part.url}</a>
    : <span key={i}>{part.text}</span>)}</div>;
}

/** v1's gates, unchanged: a name/type refusal shows at once and fetches nothing; the bytes are checked on Open. */
function AttachmentRow({ accountId, a }: { accountId: string; a: MailAttachment }) {
  const [state, setState] = useState<"idle" | "opening" | "opened" | "error">("idle");
  const [error, setError] = useState("");
  const name = a.name || "attachment";
  const early = a.refused ?? null;
  const open = async () => {
    setState("opening");
    try { await invoke("mail_attachment_open", { accountId, blobId: a.blob_id, name: a.name, mime: a.mime }); setState("opened"); }
    catch (e) { const p = mailProblem(e); setError(p.kind === "invalid" ? p.detail : p.title); setState("error"); }
  };
  const refused = early !== null || state === "error";
  return <li className={`mail-attachment-item ${refused ? "refused" : ""}`}>
    <button type="button" className="attachment-file mail-attachment" disabled={early !== null || state === "opening"} onClick={() => void open()} aria-label={early ? `${name} won't open` : `Open ${name}`}>
      <span aria-hidden="true">{refused ? "⊘" : a.mime === "application/pdf" ? "📄" : "📎"}</span><span className="attachment-name">{name}</span>
      <small>{refused ? "Not opened" : state === "opening" ? "Opening…" : [formatSize(a.size), "Open"].filter(Boolean).join(" · ")}</small>
    </button>
    {early && <small className="mail-att-why" role="status">{early}</small>}
    {!early && state === "error" && <small className="mail-att-why" role="status">{error}</small>}
    {state === "opened" && <small className="mail-note" role="status">Passed the attachment checks; opened.</small>}
  </li>;
}

/** The frame runs no script, so its links can't be followed there: they are listed, and open in the browser. */
function LinkList({ links }: { links: MailLink[] }) {
  return <details className="mail-links"><summary>Links in this message ({links.length})</summary><ul>{links.map((l) => <li key={l.url}>
    <a href={l.url} title={l.url} onClick={(e) => { e.preventDefault(); openLink(l.url); }}>{l.text ? <><span>{l.text}</span> <small>{l.url}</small></> : l.url}</a>
  </li>)}</ul></details>;
}

/** What a draft is, in words: whose, and that it was not sent; and what you can do with it here. */
function DraftTag({ m, acct, onOpen }: { m: MailMessage; acct: AccountBoxes; onOpen: (() => void) | null }) {
  // formatting, attachments or a cut-off body: the composer can't show it all, so it doesn't offer to send it
  const whole = draftEditable(m);
  const elsewhere = onOpen && !whole && <span className="mail-note">It has formatting or attachments this app can't show in full: send it from your mail client.</span>;
  if (!whole) onOpen = null;
  if (acct.who === "uni") return <p className="mail-draft-note"><span className="mail-draft-tag">UNI'S OWN DRAFT · NOT SENT</span><span>A draft in Uni's mail. You can read it here; only Uni sends it, under its rules.</span></p>;
  if (m.uni_drafted) return <div className="mail-draft-note" role="note"><span className="mail-draft-tag">DRAFT · BY UNI · NOT SENT</span>
    <span>Uni wrote this in your Drafts. Uni can't send as you: nothing goes out unless you send it.{!onOpen && ` ${LATER} in this app.`}</span>
    {onOpen && <button type="button" className="note-action mail-draft-open" onClick={onOpen}>Review and send it yourself…</button>}{elsewhere}</div>;
  return <div className="mail-draft-note"><span className="mail-draft-tag">DRAFT · NOT SENT</span>
    {onOpen && <button type="button" className="note-action mail-draft-open" onClick={onOpen}>Edit draft</button>}{elsewhere}</div>;
}

/** Where a message of a thread lives, when that isn't somewhere you'd read it: a thread can reach into Junk and Trash. */
function placeOf(m: MailMessage, acct: AccountBoxes): "junk" | "trash" | null {
  const roles = m.mailbox_ids.map((id) => acct.mailboxes.find((b) => b.id === id)?.role);
  for (const r of ["junk", "trash"] as const) if (roles.length > 0 && roles.every((x) => x === r)) return r;
  return null;
}

/** One message of a thread: headers, the body (plain text first, the sealed HTML on request), attachments. */
function MessageCard({ m, acct, accountId, overview, onOpenDraft }: { m: MailMessage; acct: AccountBoxes; accountId: string; overview: Overview; onOpenDraft: ((m: MailMessage) => void) | null }) {
  const [formatted, setFormatted] = useState(!m.text && !!m.html);
  const showHtml = formatted && !!m.html;
  const place = placeOf(m, acct);
  const unverified = notVerified(m, overview);
  return <article id={`mail-msg-${m.id}`} className={`mail-card ${m.draft ? "mail-card-draft" : ""} ${m.unread && !m.draft ? "mail-card-unread" : ""}`} aria-label={m.draft ? `Draft: ${subjectLabel(m.subject)}` : `Message from ${addressLine(m.from) || "(no sender)"}`}>
    {m.draft && <DraftTag m={m} acct={acct} onOpen={onOpenDraft && (() => onOpenDraft(m))} />}
    {!m.draft && m.uni_drafted && acct.who === "owner" && <p className="mail-draft-note mail-provenance"><span className="mail-draft-tag">DRAFTED BY UNI · SENT BY YOU</span></p>}
    {unverified && <p className="mail-draft-note mail-unverified" role="note"><span className="mail-draft-tag">NOT VERIFIED</span>
      <span>This says it is from you, but the server that received it couldn't confirm that (DMARC: {m.dmarc}). Treat what it asks with care.</span></p>}
    {place && <p className="mail-draft-note mail-place"><span className="mail-draft-tag">{place === "junk" ? "IN JUNK" : "IN TRASH"}</span>
      <span>{place === "junk" ? "The server filed this message as junk. Treat its links and attachments with care." : "This message is in the Trash."}</span></p>}
    <dl className="mail-headers">
      <dt>From</dt><dd>{addressLine(m.from) || "(no sender)"}</dd>
      {m.to.length > 0 && <><dt>To</dt><dd>{addressLine(m.to)}</dd></>}
      {m.cc.length > 0 && <><dt>Cc</dt><dd>{addressLine(m.cc)}</dd></>}
      {m.draft && (m.bcc?.length ?? 0) > 0 && <><dt>Bcc</dt><dd>{addressLine(m.bcc!)}</dd></>}
      <dt>{m.draft ? "Saved" : "Date"}</dt><dd>{mailDateLong(m.sent_at || m.received_at)}{m.unread && !m.draft && <span className="mail-unread-word"> · unread</span>}{m.flagged && <span className="mail-flag-word"> · ⚑ flagged</span>}</dd>
    </dl>
    {m.attachments.length > 0 && <ul className="mail-attachments" aria-label="Attachments">{m.attachments.map((a, i) => <AttachmentRow key={a.part_id ?? `${a.blob_id}-${i}`} accountId={accountId} a={a} />)}</ul>}
    {(m.text && m.html) || (showHtml && m.remote_images > 0) || m.truncated ? <div className="mail-body-bar">
      {m.text && m.html && <button type="button" className="note-quiet" aria-pressed={showHtml} onClick={() => setFormatted(!formatted)}>{showHtml ? "Show plain text" : "Show formatted"}</button>}
      {showHtml && m.remote_images > 0 && <span className="mail-note">{m.remote_images === 1 ? "1 remote image not loaded" : `${m.remote_images} remote images not loaded`}</span>}
      {m.truncated && <span className="mail-note">This message is long; the app shows its first megabyte.</span>}
    </div> : null}
    {showHtml && m.links.length > 0 && <LinkList links={m.links} />}
    {showHtml
      ? <iframe className="mail-html" title={`Message: ${subjectLabel(m.subject)}`} sandbox="" referrerPolicy="no-referrer" srcDoc={mailSrcdoc(m.html!)} />
      : m.text ? <PlainBody text={m.text} />
      : <p className="empty">This message has no text.</p>}
  </article>;
}

/** What the thread bar can do; each is null where the bridge doesn't offer it on this account. */
type ThreadActions = {
  reply: (() => void) | null;
  markUnread: (() => void) | null;
  markRead: (() => void) | null;
  flag: ((on: boolean) => void) | null;
  archive: (() => void) | null;
  openDraft: ((m: MailMessage) => void) | null;
  busy: boolean;
  problem: string | null;
};

/** The thread: subject, whose mail it is, Uni's triage note (labelled as Uni's), the messages oldest first. */
function ThreadView({ t, acct, overview, note, onBack, actions }: { t: MailThread; acct: AccountBoxes; overview: Overview; note: string | null; onBack: () => void; actions: ThreadActions }) {
  const real = t.messages.filter((m) => !m.draft);
  const subject = (real[0] ?? t.messages[0]).subject;
  const uniDraft = acct.who === "owner" ? [...t.messages].reverse().find((m) => m.draft && m.uni_drafted) : undefined;
  const unread = real.some((m) => m.unread);
  const flagged = t.messages.some((m) => m.flagged);
  return <section className="mail-thread" aria-label={`Thread: ${subjectLabel(subject)}`}>
    <div className="mail-thread-bar">
      <button type="button" className="note-action mail-thread-back" onClick={onBack}>← Threads</button>
      <span className="mail-thread-tools">
        {unread ? actions.markRead && <button type="button" className="note-quiet" disabled={actions.busy} onClick={actions.markRead}>Mark read</button>
          : actions.markUnread && <button type="button" className="note-quiet" disabled={actions.busy} onClick={actions.markUnread}>Mark unread</button>}
        {actions.flag && <button type="button" className="note-quiet" aria-pressed={flagged} disabled={actions.busy} onClick={() => actions.flag!(!flagged)}>{flagged ? "⚑ Unflag" : "⚐ Flag"}</button>}
        {actions.archive && <button type="button" className="note-quiet" disabled={actions.busy} onClick={actions.archive}>Archive</button>}
        {actions.reply
          ? <button type="button" className="note-action mail-reply" onClick={actions.reply} aria-label={`Reply ${acct.who === "uni" ? "as Uni" : "as you"}, from ${acct.name}`}>Reply</button>
          : <><LaterButton label="Reply" /><small className="mail-later-note">{LATER}</small></>}
      </span>
    </div>
    {actions.problem && <p className="note-error mail-action-problem" role="alert">{actions.problem}</p>}
    <div className="mail-thread-scroll">
      <h2 className="mail-subject">{subjectLabel(subject.replace(/^re:\s*/i, ""))}</h2>
      <p className="mail-thread-where"><WhoTag who={acct.who} address={acct.name} /> <span>{acct.who === "uni" ? "In Uni's mail" : "In your mail"} · {real.length} {real.length === 1 ? "message" : "messages"}</span></p>
      {note && <p className="mail-triage" role="note"><span className="eyebrow">Uni's triage note</span><span>{note}</span></p>}
      {uniDraft && <button type="button" className="mail-draft-hint" onClick={() => document.getElementById(`mail-msg-${uniDraft.id}`)?.scrollIntoView({ block: "start" })}>
        <span className="mail-draft-tag small">DRAFT BY UNI</span> Uni left a draft reply at the end of this thread. Not sent.</button>}
      {t.messages.map((m) => <MessageCard key={m.id} m={m} acct={acct} accountId={t.account_id} overview={overview} onOpenDraft={m.draft && acct.who === "owner" ? actions.openDraft : null} />)}
    </div>
  </section>;
}

/** Enter never decides a held send: only a tap, a click or Space. */
const noEnter = (e: KeyboardEvent) => { if (e.key === "Enter") e.preventDefault(); };

function heldTo(p: Parked): string {
  const f = p.fields;
  const list = f ? [...f.to, ...f.cc, ...f.bcc].map((a) => a.email) : p.recipients;
  return list.length ? list.join(", ") : "(no recipients)";
}

function HeldRow({ e, selected, onOpen }: { e: HeldEntry; selected: boolean; onOpen: () => void }) {
  const p = e.item;
  const state = e.outcome && e.outcome.kind !== "failed" ? e.outcome.kind : waiting(e) ? "waiting" : "failed";
  const tag = state === "sent" ? "SENT" : state === "declined" ? "NOT SENT" : state === "failed" ? "ASK #MAIL" : "WAITING";
  return <li><button type="button" className={`mail-row mail-held-row held-${state} ${selected ? "selected" : ""}`} aria-current={selected ? "true" : undefined} onClick={onOpen}
    aria-label={`${tag === "WAITING" ? "Waiting for you" : tag}. From Uni's address to ${heldTo(p)}: ${subjectLabel(p.fields?.subject ?? "")}`}>
    <span className="mail-row-top"><WhoTag who="uni" /><span className="mail-from">To {heldTo(p)}</span><span className="mail-held-tag">{tag}</span></span>
    <span className="mail-row-subject">{subjectLabel(p.fields?.subject ?? "")}</span>
    <span className="mail-row-preview">{e.outcome?.text ?? p.reason ?? p.problem ?? ""}</span>
  </button></li>;
}

/** A held send in full, and the two decisions on it. Each needs a second, deliberate tap; Enter does neither. */
function HeldView({ e, acct, onBack, onDecide }: { e: HeldEntry; acct: AccountBoxes; onBack: () => void; onDecide: (kind: "approve" | "decline") => Promise<void> }) {
  const [confirm, setConfirm] = useState<"approve" | "decline" | null>(null);
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const confirmBox = useRef<HTMLDivElement>(null);
  const p = e.item, f = p.fields;
  const open = waiting(e);
  const approvable = canApprove(acct, p);
  const declinable = can(acct, "send.decline");
  // a confirm stands only while its own operation is offered (the bridge's session can change on Refresh)
  const allowed = (kind: "approve" | "decline" | null) => (kind === "approve" ? approvable : kind === "decline" ? declinable : false);
  const asking = allowed(confirm) ? confirm : null;
  const ask = (kind: "approve" | "decline") => { setConfirm(kind); requestAnimationFrame(() => confirmBox.current?.focus()); };
  const go = async () => {
    // a second tap while the first is on its way does nothing
    if (inflight.current || !asking) return;
    inflight.current = true; setBusy(true);
    try { await onDecide(asking); } finally { inflight.current = false; setBusy(false); setConfirm(null); }
  };
  const from = `Uni's address (${acct.name})`;
  return <section className="mail-thread mail-held" aria-label={`Held send: ${subjectLabel(f?.subject ?? "")}`}>
    <div className="mail-thread-bar">
      <button type="button" className="note-action mail-thread-back" onClick={onBack}>← Waiting</button>
      <span className="mail-held-where"><WhoTag who="uni" address={acct.name} /> {e.outcome?.kind === "sent" ? "Sent from Uni's address" : e.outcome?.kind === "declined" ? "Declined · not sent" : "Held for you · not sent"}</span>
    </div>
    <div className="mail-thread-scroll">
      <h2 className="mail-subject">{subjectLabel(f?.subject ?? "")}</h2>
      <p className="mail-triage mail-held-why" role="note"><span className="eyebrow">Why it waits</span><span>{p.reason ?? "Uni's outbound rules want your approval."}</span></p>
      {p.changed && <p className="mail-draft-note mail-unverified" role="note"><span className="mail-draft-tag">CHANGED</span><span>This draft changed after Uni's rules held it, so the bridge won't send it. Don't send it, and ask Uni to send it again.</span></p>}
      {p.problem && <p className="mail-draft-note mail-unverified" role="note"><span className="mail-draft-tag">CAN'T SHOW IT</span><span>{p.problem}. Nothing can be sent from here; ask #mail.</span></p>}
      {f && !p.problem && p.plain !== true && <p className="mail-draft-note" role="note"><span>It may have formatting or attachments this app can't show in full, so only Don't send is offered here.</span></p>}
      {f && <article className="mail-card mail-card-draft" aria-label="What it sends">
        <dl className="mail-headers">
          <dt>From</dt><dd>Uni &lt;{acct.name}&gt;</dd>
          <dt>To</dt><dd>{addressLine(f.to) || "(nobody)"}</dd>
          {f.cc.length > 0 && <><dt>Cc</dt><dd>{addressLine(f.cc)}</dd></>}
          {f.bcc.length > 0 && <><dt>Bcc</dt><dd>{addressLine(f.bcc)}</dd></>}
          <dt>Subject</dt><dd>{subjectLabel(f.subject)}</dd>
        </dl>
        {f.text ? <PlainBody text={f.text} /> : <p className="empty">This message has no text.</p>}
      </article>}
      {e.outcome && <p className={`mail-held-outcome held-${e.outcome.kind}`} role="status">{e.outcome.text}</p>}
      {open && (approvable || declinable) && (asking
        ? <div ref={confirmBox} tabIndex={-1} className="mail-held-confirm" role="group" aria-label={asking === "approve" ? "Confirm sending" : "Confirm not sending"}>
            <p>{asking === "approve" ? `Send this from ${from} to ${heldTo(p)}? It goes out exactly as shown.` : `Don't send this? Nothing goes out from ${from}; Uni can change or drop the draft.`}</p>
            <span className="mail-held-buttons">
              <button type="button" className={asking === "approve" ? "send mail-held-yes" : "note-action mail-held-yes"} disabled={busy} onKeyDown={noEnter} onClick={() => void go()}>
                {busy ? (asking === "approve" ? "Sending…" : "Declining…") : asking === "approve" ? "Yes, send from Uni's address" : "Yes, don't send it"}</button>
              <button type="button" className="note-quiet" disabled={busy} onKeyDown={noEnter} onClick={() => setConfirm(null)}>Cancel</button>
            </span>
          </div>
        : <div className="mail-held-actions">
            {approvable && <button type="button" className="send mail-held-send" onKeyDown={noEnter} onClick={() => ask("approve")} aria-label={`Send it, from ${from}`}>
              <span>Send it</span><small>from Uni's address, {acct.name}</small></button>}
            {declinable && <button type="button" className="note-action mail-held-decline" onKeyDown={noEnter} onClick={() => ask("decline")} aria-label={`Don't send it from ${from}`}>
              <span>Don't send</span><small>nothing goes out from Uni's address</small></button>}
          </div>)}
    </div>
  </section>;
}

function ThreadRow({ t, who, note, selected, onOpen }: { t: ThreadSummary; who: Who; note: string | null; selected: boolean; onOpen: () => void }) {
  const party = t.draft ? `To ${senderLabel(t.to)}` : senderLabel(t.from);
  return <li><button type="button" className={`mail-row ${t.unread ? "unread" : ""} ${selected ? "selected" : ""}`} aria-current={selected ? "true" : undefined} onClick={onOpen}
    aria-label={`${t.unread ? "Unread. " : ""}${t.flagged ? "Flagged. " : ""}${whoMail(who)}. ${t.draft ? (t.uni_drafted ? "Draft by Uni. " : "Draft. ") : ""}${party}: ${subjectLabel(t.subject)}`}>
    <span className="mail-row-top">
      <WhoTag who={who} />
      <span className="mail-from">{t.unread && <span className="mail-dot" aria-hidden="true" />}{t.draft ? <em>{party}</em> : party}{t.count > 1 && <small> · {t.count}</small>}</span>
      {t.flagged && <span className="mail-row-flag" aria-hidden="true">⚑</span>}
      <time dateTime={t.received_at}>{mailDate(t.received_at)}</time>
    </span>
    <span className="mail-row-subject">{t.uni_drafted && t.draft && <span className="mail-draft-tag small">DRAFT BY UNI</span>}{t.has_attachment && <span aria-label="Has attachment">📎 </span>}{subjectLabel(t.subject)}</span>
    {note ? <span className="mail-row-triage"><span className="mail-row-triage-who">Uni:</span> {note}</span> : <span className="mail-row-preview">{t.preview}</span>}
  </button></li>;
}

export default function Mail({ onBack, backTo = "Uni" }: { onBack: () => void; backTo?: string }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [boxesProblem, setBoxesProblem] = useState<MailProblem | null>(null);
  const [scope, setScope] = useState<Scope>(remembered.scope);
  const [query, setQuery] = useState(remembered.query);
  const [typed, setTyped] = useState(remembered.query);
  const [list, setList] = useState<List | null>(null);
  const [listProblem, setListProblem] = useState<MailProblem | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Open | null>(remembered.open);
  const [thread, setThread] = useState<MailThread | null>(null);
  const [threadNote, setThreadNote] = useState<string | null>(null);
  const [threadProblem, setThreadProblem] = useState<MailProblem | null>(null);
  const [pane, setPane] = useState<Pane>((remembered.compose && !remembered.compose.hidden) || remembered.open ? "thread" : "list");
  const [compose, setComposeState] = useState<Compose | null>(remembered.compose);
  /** Sends whose outcome isn't known yet (kept on the device), and what checking them found. */
  const [pending, setPending] = useState<PendingSend[]>(() => readPending(typeof localStorage === "undefined" ? null : localStorage));
  const [pendingNote, setPendingNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionProblem, setActionProblem] = useState<string | null>(null);
  /** T-213: Uni's sends held for you, per account (kept in mailHeld.ts, so outcomes outlive this view). */
  const held = useSyncExternalStore(onHeld, heldEntries);
  const [heldProblem, setHeldProblem] = useState<MailProblem | null>(null);
  const [heldLoading, setHeldLoading] = useState(false);
  const [openHeld, setOpenHeld] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  /** The overview as last loaded, for callbacks that outlive a render (marking a thread read once it has loaded). */
  const overviewRef = useRef<Overview | null>(null);
  /** The newest overview shown, by its number; and each overview's number, for the held sends read with it. */
  const overviewSeq = useRef(0);
  const overviewListing = useRef(new WeakMap<Overview, number>()).current;
  /** T-208 follow-up: each fresh list (not a further page) is a new generation; a triage answer for an older one is dropped. */
  const notesGen = useRef(0);
  const composeSeq = useRef(remembered.compose?.key ?? 0);
  /** The thread just opened from the list: only that load marks it read (a Refresh or a reload doesn't undo Mark unread). */
  const markOnOpen = useRef<string | null>(null);
  /** The open thread and list now, for callbacks that finish later (an archive, a refresh). */
  const openRef = useRef<Open | null>(remembered.open);
  const composeRef = useRef<Compose | null>(remembered.compose);
  /** False once this Mail is gone: a late answer for it (a save that finished after Mail was left) changes nothing shared. */
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  /** The composer as kept here; its live text is in `remembered.compose.snapshot` (kept on every change, not rendered). */
  const setCompose = (c: Compose | null) => {
    if (!alive.current) return;
    const live = c && remembered.compose?.key === c.key ? remembered.compose.snapshot : c?.snapshot ?? null;
    const next = c ? { ...c, snapshot: live } : null;
    remembered.compose = next; composeRef.current = next; setComposeState(next);
  };
  // a slow answer for a list or thread no longer shown is dropped
  const listSeq = useRef(0);
  const threadSeq = useRef(0);
  /** The list being shown (scope and search): notes for it are kept while it pages, dropped when it changes. */
  const shownKey = useRef("");

  /** The accounts and their mailboxes. What was shown from an account no longer in the session goes with it. */
  const loadOverview = useCallback(async (): Promise<Overview | null> => {
    setBoxesProblem(null);
    // numbered before it is asked: an answer older than one already shown is dropped, and the held sends read with
    // it are ordered by when the bridge's session was read, not when its answer came (T-213)
    const seq = beginListing();
    try {
      const o = await invoke<Overview>("mail_overview");
      if (seq < overviewSeq.current) return overviewRef.current;
      overviewSeq.current = seq;
      overviewListing.set(o, seq);
      const known = (id: string) => o.accounts.some((a) => a.id === id);
      overviewRef.current = o;
      setOverview(o);
      setScope((cur) => (scopeValid(cur, o) ? cur : { kind: "all-inboxes" }));
      setList((cur) => (cur && cur.threads.some((t) => !known(t.account_id)) ? { ...cur, threads: cur.threads.filter((t) => known(t.account_id)), more: false } : cur));
      setOpen((cur) => {
        if (!cur || known(cur.accountId)) return cur;
        threadSeq.current++; setThread(null); setThreadProblem(null); setPane("list");
        return null;
      });
      return o;
    } catch (e) { setBoxesProblem(mailProblem(e)); return null; }
  }, []);

  /** The sends held for you in each account where the bridge offers deciding them, as of the session in `o`. */
  const loadHeld = useCallback(async (o: Overview) => {
    const gen = heldGen(), seq = overviewListing.get(o) ?? beginListing();
    const offered = o.accounts.filter(approvalOffered);
    keepAccounts(offered.map((a) => a.id), gen, seq);
    setHeldProblem(null);
    setHeldLoading(true);
    try {
      for (const a of offered.filter((x) => can(x, "send.parked"))) mergeListing(a.id, await invoke<Parked[]>("mail_parked", { accountId: a.id }), gen, seq);
    } catch (e) { if (gen === heldGen()) setHeldProblem(mailProblem(e)); }
    finally { if (alive.current) setHeldLoading(false); }
  }, []);

  /** Uni's notes for these rows, one call per account. Each answer replaces what was shown for those rows, so a note
   *  Uni removed goes on Refresh. Display only: a failure shows no notes for those rows. */
  const loadNotes = useCallback(async (threads: ThreadSummary[], key: string, gen: number) => {
    const by = new Map<string, string[]>();
    for (const t of threads) by.set(t.account_id, [...(by.get(t.account_id) ?? []), t.email_id]);
    for (const [accountId, emailIds] of by) {
      const got = await invoke<Record<string, string>>("mail_triage", { accountId, emailIds }).catch(() => ({} as Record<string, string>));
      if (key !== shownKey.current || gen !== notesGen.current) return;
      setNotes((cur) => {
        const next = { ...cur };
        for (const id of emailIds) delete next[`${accountId}/${id}`];
        for (const [id, n] of Object.entries(got)) if (emailIds.includes(id)) next[`${accountId}/${id}`] = n;
        return next;
      });
    }
  }, []);

  const loadList = useCallback(async (key: string, sources: Source[], text: string, more: List | null) => {
    if (sources.length === 0) { setList({ key, threads: [], next: [], more: false, total: 0 }); return; }
    const seq = ++listSeq.current;
    const gen = more ? notesGen.current : ++notesGen.current;
    shownKey.current = key;
    setListLoading(true);
    if (!more) setListProblem(null);
    try {
      const page = await invoke<ThreadPage>("mail_threads", { sources, text: text || null });
      if (seq !== listSeq.current) return;
      setList(more
        ? { key, total: page.total, next: page.next, more: page.more, threads: [...more.threads, ...page.threads.filter((t) => !more.threads.some((c) => c.account_id === t.account_id && c.thread_id === t.thread_id))] }
        : { key, total: page.total, next: page.next, more: page.more, threads: page.threads });
      setListProblem(null);
      void loadNotes(page.threads, key, gen);
    } catch (e) { if (seq === listSeq.current) setListProblem(mailProblem(e)); }
    finally { if (seq === listSeq.current) setListLoading(false); }
  }, [loadNotes]);

  /** Mark these messages of the open thread read or unread, here and in its row. */
  const markShown = useCallback((o: Open, ids: string[], unread: boolean) => {
    setThread((cur) => (cur && cur.account_id === o.accountId && cur.thread_id === o.threadId ? { ...cur, messages: cur.messages.map((m) => (ids.includes(m.id) ? { ...m, unread } : m)) } : cur));
    setList((cur) => (cur ? { ...cur, threads: cur.threads.map((r) => (r.account_id === o.accountId && r.thread_id === o.threadId ? { ...r, unread } : r)) } : cur));
  }, []);

  const loadThread = useCallback(async (o: Open) => {
    const seq = ++threadSeq.current;
    setThread(null); setThreadProblem(null); setThreadNote(null); setActionProblem(null);
    try {
      const t = await invoke<MailThread>("mail_thread", { accountId: o.accountId, threadId: o.threadId });
      if (seq !== threadSeq.current) return;
      setThread(t);
      // opening a thread of your own from the list marks it read, where the bridge offers that (Mark unread undoes
      // it). Uni's mail stays as Uni left it unless you mark it; a reload never marks.
      const acct = overviewRef.current?.accounts.find((a) => a.id === t.account_id);
      const unreadIds = t.messages.filter((m) => m.unread && !m.draft).map((m) => m.id);
      const opened = markOnOpen.current === `${o.accountId}/${o.threadId}`;
      if (opened) markOnOpen.current = null;
      if (opened && acct?.who === "owner" && can(acct, "mark_seen") && unreadIds.length > 0) {
        void invoke("mail_mark_seen", { accountId: t.account_id, emailIds: unreadIds, seen: true })
          .then(() => { markShown(o, unreadIds, false); void loadOverview(); })
          .catch((e) => { if (seq === threadSeq.current) setActionProblem(`Couldn't mark it read: ${mailProblem(e).title}`); });
      }
      const got = await invoke<Record<string, string>>("mail_triage", { accountId: t.account_id, emailIds: t.messages.map((m) => m.id) }).catch(() => ({} as Record<string, string>));
      if (seq !== threadSeq.current) return;
      const latest = [...t.messages].reverse().find((m) => got[m.id]);
      setThreadNote(latest ? got[latest.id] : null);
    } catch (e) { if (seq === threadSeq.current) setThreadProblem(mailProblem(e)); }
  }, [markShown, loadOverview]);

  const listKey = overview ? `${scopeKey(scope)}?${query}` : "";
  useEffect(() => { void loadOverview().then((o) => { if (o) void loadHeld(o); }); }, [loadOverview, loadHeld]);
  useEffect(() => {
    if (!overview) return;
    setList((cur) => (cur?.key === listKey ? cur : null));
    void loadList(listKey, sourcesFor(scope, overview, !!query), query, null);
    // the overview's counts change on Refresh; the list reloads only when what it shows changes
  }, [listKey, loadList]);
  useEffect(() => { if (open) void loadThread(open); }, [open, loadThread]);
  useEffect(() => { remembered.scope = scope; remembered.query = query; remembered.open = open; openRef.current = open; }, [scope, query, open]);

  const accountOf = (id: string) => overview?.accounts.find((a) => a.id === id);
  const refresh = async () => {
    const o = await loadOverview();
    if (o) void loadHeld(o);
    // the list reloads with the accounts the bridge has now (a scope that went is reset, and its effect reloads)
    if (o && scopeValid(scope, o)) void loadList(listKey, sourcesFor(scope, o, !!query), query, null);
    const now = openRef.current;
    if (o && now && o.accounts.some((a) => a.id === now.accountId)) void loadThread(now);
  };
  const pick = (s: Scope) => { threadSeq.current++; setOpenHeld(null); setScope(s); setQuery(""); setTyped(""); setOpen(null); setThread(null); setThreadProblem(null); setPane("list"); };
  const openThread = (t: ThreadSummary) => {
    // a message being written stays: it waits behind the thread, with Resume
    if (compose && !compose.hidden) setCompose({ ...compose, hidden: true });
    markOnOpen.current = `${t.account_id}/${t.thread_id}`;
    setOpenHeld(null);
    setOpen({ accountId: t.account_id, threadId: t.thread_id }); setPane("thread");
  };
  const [composeNote, setComposeNote] = useState<string | null>(null);
  const resume = () => { if (compose) { setCompose({ ...compose, hidden: false }); setPane("thread"); } };
  const startCompose = (start: ComposeStart) => {
    // one message at a time: one with changes, a saved draft or a send under way comes back instead of being replaced
    const snap = remembered.compose?.snapshot;
    if (compose && (snap?.dirty || snap?.saved || (snap && snap.stage.kind !== "edit"))) {
      setComposeNote("Finish or close this message first."); resume(); return;
    }
    setComposeNote(null);
    setCompose({ key: ++composeSeq.current, start, hidden: false, snapshot: null }); setPane("thread");
  };
  /** Close the composer `key` (a late answer for one already gone closes nothing newer). */
  const endCompose = (changed: boolean, key: number) => {
    if (!alive.current) return;
    if (composeRef.current?.key === key) { setCompose(null); setComposeNote(null); if (!openRef.current) setPane("list"); }
    if (changed) void refresh();
  };
  const keepSnapshot = (snapshot: ComposerSnapshot) => { if (alive.current && remembered.compose) remembered.compose = { ...remembered.compose, snapshot }; };
  const pendingChanged = () => setPending(readPending(typeof localStorage === "undefined" ? null : localStorage));
  /** Ask the bridge about each send whose outcome isn't known (a lost answer, or a composer closed before it came). */
  const checkPending = async () => {
    const store = typeof localStorage === "undefined" ? null : localStorage;
    const said: string[] = [];
    for (const p of readPending(store)) {
      if (!can(overviewRef.current?.accounts.find((a) => a.id === p.account_id), "send.check")) { said.push("The mail bridge doesn't offer checking it now; it stays listed."); continue; }
      try {
        const out = await invoke<SendOutcome>("mail_send_check", { accountId: p.account_id, opId: p.op_id });
        if (settled(out.state)) { writePending(store, withoutPending(readPending(store), p.op_id)); said.push(sendOutcomeText(out, p.who).text); }
        else said.push("Still unknown; it won't be sent twice.");
      } catch (e) {
        const prob = mailProblem(e);
        if (prob.kind === "refused" && prob.detail.startsWith("404")) { writePending(store, withoutPending(readPending(store), p.op_id)); said.push("It never reached the mail bridge: nothing was sent."); }
        else said.push(`Couldn't check: ${prob.title}`);
      }
    }
    pendingChanged(); setPendingNote(said.join(" ")); void refresh();
  };
  const senders = overview ? overview.accounts.filter(canSendFrom) : [];
  const newMessage = () => {
    // from a mailbox, its account (if it can send); from the combined view, nobody until you choose
    const here = scope.kind === "mailbox" ? overview?.accounts.find((a) => a.id === scope.accountId) : undefined;
    startCompose({ kind: "new", from: here && canSendFrom(here) ? here.id : null });
  };

  /** Run one write for the open thread; say what failed, in words. */
  const act = async (what: string, run: () => Promise<unknown>, after: () => void) => {
    setBusy(true); setActionProblem(null);
    try { await run(); after(); }
    catch (e) { const p = mailProblem(e); setActionProblem(`Couldn't ${what}. ${p.title} ${p.detail}`); }
    finally { setBusy(false); }
  };
  const threadActions = (t: MailThread, acct: AccountBoxes) => {
    const o: Open = { accountId: t.account_id, threadId: t.thread_id };
    const real = t.messages.filter((m) => !m.draft);
    const newest = real[real.length - 1] ?? t.messages[t.messages.length - 1];
    const inbox = acct.mailboxes.find((b) => b.role === "inbox")?.id;
    const inInbox = real.filter((m) => inbox && m.mailbox_ids.includes(inbox)).map((m) => m.id);
    const flaggedIds = t.messages.filter((m) => m.flagged).map((m) => m.id);
    const setFlag = (ids: string[], flagged: boolean) => {
      // only if that thread is still the one shown (email ids are per account)
      setThread((cur) => (cur && cur.account_id === o.accountId && cur.thread_id === o.threadId ? { ...cur, messages: cur.messages.map((m) => (ids.includes(m.id) ? { ...m, flagged } : m)) } : cur));
      setList((cur) => (cur ? { ...cur, threads: cur.threads.map((r) => (r.account_id === o.accountId && r.thread_id === o.threadId ? { ...r, flagged } : r)) } : cur));
    };
    const mark = can(acct, "mark_seen");
    return {
      busy,
      problem: actionProblem,
      reply: canSendFrom(acct) ? () => startCompose({ kind: "reply", accountId: acct.id, fields: replyFields(t, acct) }) : null,
      markUnread: mark && newest ? () => void act("mark it unread", () => invoke("mail_mark_seen", { accountId: o.accountId, emailIds: [newest.id], seen: false }), () => { markShown(o, [newest.id], true); void loadOverview(); }) : null,
      markRead: mark ? () => { const ids = real.filter((m) => m.unread).map((m) => m.id); void act("mark it read", () => invoke("mail_mark_seen", { accountId: o.accountId, emailIds: ids, seen: true }), () => { markShown(o, ids, false); void loadOverview(); }); } : null,
      flag: can(acct, "flag") && newest ? (on: boolean) => {
        const ids = on ? [newest.id] : flaggedIds;
        void act(on ? "flag it" : "unflag it", () => invoke("mail_flag", { accountId: o.accountId, emailIds: ids, flagged: on }), () => setFlag(ids, on));
      } : null,
      archive: can(acct, "archive") && inInbox.length > 0 ? () => void act("archive it", () => invoke("mail_archive", { accountId: o.accountId, emailIds: inInbox }), () => {
        // only if that thread is still the one shown: another opened since stays open
        const same = (c: Open | null) => !!c && c.accountId === o.accountId && c.threadId === o.threadId;
        const c = composeRef.current;
        if (same(openRef.current)) { threadSeq.current++; openRef.current = null; setOpen(null); setThread(null); if (!c || c.hidden) setPane("list"); }
        setList((cur) => (cur ? { ...cur, threads: cur.threads.filter((r) => !(r.account_id === o.accountId && r.thread_id === o.threadId)) } : cur));
        void refresh();
      }) : null,
      openDraft: acct.who === "owner" && canSendFrom(acct) ? (m: MailMessage) => startCompose({ kind: "draft", accountId: acct.id, draftId: m.id, fields: draftFields(m), uni: m.uni_drafted }) : null,
    } satisfies ThreadActions;
  };
  /** Send or decline a held send, once: a second call for the same send while one is out does nothing (and the bridge
   *  answers a repeat of the same opId and fingerprint with the first outcome). What happened stays on the entry. */
  const decideHeld = async (accountId: string, p: Parked, kind: "approve" | "decline") => {
    if (!startDeciding(p.op_id)) return;
    const gen = heldGen();
    const acct = overviewRef.current?.accounts.find((a) => a.id === accountId);
    let outcome: HeldOutcome;
    try {
      outcome = kind === "approve"
        ? approveOutcome(await invoke<SendOutcome>("mail_send_approve", { accountId, opId: p.op_id, fingerprint: p.fingerprint }), acct?.name ?? "Uni's account")
        : declineOutcome(await invoke<SendOutcome>("mail_send_decline", { accountId, opId: p.op_id }));
    } catch (e) { outcome = heldFailure(e, kind === "approve"); }
    finally { endDeciding(p.op_id); }
    setOutcome(accountId, p.op_id, outcome, gen);
    if (outcome.kind === "sent" && alive.current) void refresh();
  };
  const submitSearch = (e: FormEvent) => { e.preventDefault(); setQuery(typed.trim()); setPane("list"); };
  const toSearch = () => { setPane("list"); requestAnimationFrame(() => search.current?.focus()); };
  const title = overview ? scopeTitle(scope, overview, query) : "";
  const unreadAll = overview ? allInboxesUnread(overview) : 0;
  const openAcct = open ? accountOf(open.accountId) : undefined;
  const waitingScope = scope.kind === "waiting" && !query ? scope : null;
  const waitingAcct = waitingScope ? accountOf(waitingScope.accountId) : undefined;
  const heldShown = waitingScope ? held[waitingScope.accountId] ?? [] : [];
  const heldOpen = waitingScope && openHeld ? heldShown.find((e) => e.item.op_id === openHeld) : undefined;
  const waitingIn = (id: string) => (held[id] ?? []).filter(waiting).length;
  const heldAccount = overview?.accounts.find((a) => approvalOffered(a) && waitingIn(a.id) > 0);
  const waitingAll = overview ? overview.accounts.reduce((n, a) => n + (approvalOffered(a) ? waitingIn(a.id) : 0), 0) : 0;

  const composing = !!compose && !compose.hidden;
  return <section className={`mail mail-a ${still ? "mail-still" : ""}`} aria-label="Mail" data-pane={pane} data-composing={composing && pane === "thread" ? "true" : undefined}>
    <header className="note-bar mail-bar">
      <button className="note-action" onClick={onBack}>← {backTo}</button>
      <span className="mail-title"><strong>Mail</strong>{overview && <small className="mail-account" title="The address this device reads as">{overview.login}{writesOffered(overview) ? "" : " · read-only"}</small>}</span>
      <button className="note-action" onClick={() => void refresh()} disabled={listLoading}>Refresh</button>
    </header>
    {boxesProblem && !overview ? <div className="mail-scroll"><Problem p={boxesProblem} onRetry={() => void loadOverview()} /></div>
    : !overview ? <p className="mail-loading" role="status">Loading mail…</p>
    : <>
      <div className="mail-panes">
        <nav className="mail-boxes" aria-label="Mailboxes">
          {overview.accounts.length > 1 && <button type="button" className={`mail-box ${scope.kind === "all-inboxes" ? "selected" : ""}`} aria-current={scope.kind === "all-inboxes" ? "page" : undefined} onClick={() => pick({ kind: "all-inboxes" })}>
            <span>All inboxes</span>{unreadAll > 0 && <span className="mail-count" aria-label={`${unreadAll} unread`}>{unreadAll}</span>}
          </button>}
          {overview.accounts.map((a) => <div key={a.id} className={`mail-acct who-${a.who}`} role="group" aria-label={a.who === "uni" ? "Uni's mailboxes" : "Your mailboxes"}>
            <p className="mail-acct-head"><WhoTag who={a.who} /> <span>{a.name}</span></p>
            {approvalOffered(a) && (() => {
              const on = scope.kind === "waiting" && scope.accountId === a.id;
              const n = waitingIn(a.id);
              return <button type="button" className={`mail-box mail-box-waiting ${on ? "selected" : ""}`} aria-current={on ? "page" : undefined} onClick={() => pick({ kind: "waiting", accountId: a.id })}>
                <span>Waiting for you</span>{n > 0 && <span className="mail-count mail-count-waiting" aria-label={`${n} waiting for you`}>{n}</span>}
              </button>;
            })()}
            {a.mailboxes.length === 0 && <p className="empty">No mailboxes.</p>}
            {a.mailboxes.map((b) => {
              const s: Scope = { kind: "mailbox", accountId: a.id, mailboxId: b.id };
              const on = scopeKey(s) === scopeKey(scope);
              const n = b.role === "drafts" ? b.total : b.unread;
              return <button key={b.id} type="button" className={`mail-box ${on ? "selected" : ""}`} aria-current={on ? "page" : undefined} onClick={() => pick(s)}>
                <span>{mailboxLabel(b)}</span>{n > 0 && <span className={`mail-count ${b.role === "drafts" ? "quiet" : ""}`} aria-label={b.role === "drafts" ? `${n} drafts` : `${n} unread`}>{n}</span>}
              </button>;
            })}
          </div>)}
          {!overview.multi && <p className="mail-note mail-one-account">This bridge reads one mailbox. Uni's appears here once it is shared.</p>}
          {boxesProblem && <p className="mail-note" role="status">Couldn't refresh the mailboxes. <button type="button" className="cp-retry" onClick={() => void loadOverview()}>Retry</button></p>}
        </nav>
        <section className="mail-list" aria-label={`${title} threads`}>
          <div className="mail-list-head">
            <button type="button" className="note-quiet mail-boxes-open" onClick={() => setPane("boxes")}>☰ Mailboxes</button>
            <strong>{title}</strong>
            {waitingScope ? <small>{heldShown.filter(waiting).length} waiting</small>
              : list?.total != null && <small>{list.total} {list.total === 1 ? "thread" : "threads"}</small>}
          </div>
          <form className="mail-list-search" role="search" onSubmit={submitSearch}>
            <label className="mail-search"><span className="mail-sr">Search mail</span>
              <input ref={search} type="search" value={typed} placeholder="Search mail" aria-label="Search mail"
                onChange={(e) => { setTyped(e.target.value); if (!e.target.value && query) setQuery(""); }} enterKeyHint="search" />
            </label>
            {query && <button type="button" className="note-quiet" onClick={() => { setTyped(""); setQuery(""); }}>Clear</button>}
            <span className="mail-list-new">{senders.length > 0 ? <button type="button" className="send mail-new" onClick={newMessage}>New</button> : <LaterButton label="New" className="send mail-new" captioned />}</span>
          </form>
          {compose?.hidden && <button type="button" className="mail-resume" onClick={resume}>✎ A message in progress · Resume</button>}
          {pending.length > 0 && !composing && <div className="mail-pending" role="status">
            <span>{pending.length === 1 ? "A message you sent hasn't confirmed yet." : `${pending.length} messages you sent haven't confirmed yet.`} None goes out twice.</span>
            {pending.some((p) => can(accountOf(p.account_id), "send.check"))
              ? <button type="button" className="note-action" onClick={() => void checkPending()}>Check</button>
              : <><button type="button" className="note-action" disabled>Check</button><small className="mail-note">The mail bridge doesn't offer checking sends now; they stay listed.</small></>}
          </div>}
          {pendingNote && <p className="mail-note mail-pending-note" role="status">{pendingNote}</p>}
          {!waitingScope && heldAccount && <button type="button" className="mail-held-banner" onClick={() => pick({ kind: "waiting", accountId: heldAccount.id })}>
            <span className="mail-held-tag">WAITING</span> {waitingAll === 1 ? "A send from Uni's address waits for you" : `${waitingAll} sends from Uni's address wait for you`} · Review</button>}
          {waitingScope ? <div className="mail-scroll">
            {heldProblem && <Problem p={heldProblem} onRetry={() => overview && void loadHeld(overview)} />}
            {waitingAcct && !can(waitingAcct, "send.parked") && <p className="mail-note mail-held-unlisted" role="note">This mail bridge can't list Uni's held sends yet. Each one is also a task for you; ask #mail.</p>}
            {heldShown.length === 0 && !heldProblem && waitingAcct && can(waitingAcct, "send.parked") && <p className="empty mail-empty">{heldLoading ? "Loading…" : "Nothing is waiting for you."}</p>}
            {heldShown.length > 0 && <ul className="mail-rows" aria-label="Held sends">{heldShown.map((e) => <HeldRow key={e.item.op_id} e={e} selected={openHeld === e.item.op_id}
              onOpen={() => { if (compose && !compose.hidden) setCompose({ ...compose, hidden: true }); threadSeq.current++; setOpen(null); setThread(null); setOpenHeld(e.item.op_id); setPane("thread"); }} />)}</ul>}
          </div>
          : <div className="mail-scroll">
            {listProblem && <Problem p={listProblem} onRetry={() => void loadList(listKey, sourcesFor(scope, overview, !!query), query, null)} />}
            {!listProblem && !list && listLoading && <p className="mail-loading" role="status">{query ? "Searching…" : "Loading threads…"}</p>}
            {list && list.threads.length === 0 && !listProblem && <p className="empty mail-empty">{query ? `Nothing matches “${query}”.` : "Nothing here."}</p>}
            {/* a row is drawn only with the tag of an account the session names: never a guessed YOU */}
            {list && list.threads.length > 0 && <ul className="mail-rows">{list.threads.flatMap((t) => { const a = accountOf(t.account_id); return a ? [<ThreadRow key={`${t.account_id}/${t.thread_id}`} t={t} who={a.who}
              note={notes[`${t.account_id}/${t.email_id}`] ?? null} selected={open?.accountId === t.account_id && open.threadId === t.thread_id} onOpen={() => openThread(t)} />] : []; })}</ul>}
            {list?.more && <p className="mail-more"><button type="button" className="note-quiet" disabled={listLoading} onClick={() => void loadList(listKey, list.next, query, list)}>{listLoading ? "Loading…" : "Load older threads"}</button></p>}
          </div>}
        </section>
        <section className="mail-read" aria-label="Thread">
          {compose && <div className="mail-compose-wrap" hidden={compose.hidden}>
            {composeNote && !compose.hidden && <p className="mail-note mail-compose-note" role="status">{composeNote}</p>}
            <Composer key={compose.key} composeKey={compose.key} overview={overview} start={compose.start} snapshot={compose.snapshot} onSnapshot={keepSnapshot}
              onClose={(changed) => endCompose(changed, compose.key)} onDone={() => endCompose(true, compose.key)} onPendingChange={pendingChanged} /></div>}
          {composing ? null
          : heldOpen && waitingAcct ? <HeldView key={`${heldOpen.item.op_id}/${heldOpen.item.fingerprint ?? ""}`} e={heldOpen} acct={waitingAcct} onBack={() => setPane("list")}
              onDecide={(kind) => decideHeld(waitingAcct.id, heldOpen.item, kind)} />
          : waitingScope ? <p className="empty mail-pick">{heldShown.length ? "Pick a held send to see what it sends." : "Nothing is waiting for you."}</p>
          : threadProblem ? <div className="mail-scroll"><button type="button" className="note-action mail-thread-back" onClick={() => setPane("list")}>← Threads</button><Problem p={threadProblem} onRetry={() => open && void loadThread(open)} /></div>
          : thread && openAcct ? <>{compose?.hidden && <button type="button" className="mail-resume" onClick={resume}>✎ A message in progress · Resume</button>}<ThreadView key={`${thread.account_id}/${thread.thread_id}`} t={thread} acct={openAcct} overview={overview} note={threadNote} onBack={() => setPane("list")} actions={threadActions(thread, openAcct)} /></>
          : open && !openAcct ? <div className="mail-scroll"><button type="button" className="note-action mail-thread-back" onClick={() => setPane("list")}>← Threads</button><p className="empty mail-pick">This mailbox isn't shared with this device any more.</p></div>
          : open ? <p className="mail-loading" role="status">Opening…</p>
          : <p className="empty mail-pick">Pick a thread to read it.</p>}
        </section>
      </div>
      <nav className="mail-thumb" aria-label="Mail actions">
        <button type="button" className="note-action" onClick={toSearch}>Search</button>
        {senders.length > 0 ? <button type="button" className="send mail-new" onClick={newMessage}>New</button> : <LaterButton label="New" className="send mail-new" captioned />}
      </nav>
    </>}
  </section>;
}
