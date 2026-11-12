// Mail (T-335 v2): shaped like the job, not like the server's folders. Your Inbox first; the places are tabs like
// Messages' (Inbox, Later, Waiting, Drafts, Sent, Archive, Junk, Uni's mail); rows are Messages' rows; a thread reads as
// a conversation (earlier messages folded, the newest open, one-line headers, quoted history folded); Uni's draft is the
// reply, at the foot of the thread, and you write under the conversation, never in place of it. Archive and Later
// (the `$flagged` keyword) take a thread out of the list and open the next one. Two panes on a tablet or desktop
// (list | thread), one at a time on a phone. Shape and word before colour, so it reads in greyscale on the Daylight.
// Every call goes to Rust, which signs it for the mail bridge; the webview never holds a mail credential.
// T-210 (kept): writes are the bridge's named operations, and each control shows only where the bridge offers it
// (`can`). Opening a thread of yours marks it read; Unread undoes it. The composer (MailCompose.tsx) saves, shows what
// will be sent, and sends it once.
// T-213 (kept): sends from Uni's address that its outbound rules hold for you are under Waiting. Each shows what it
// sends and why it waits; Send it (bound to the fingerprint of what is shown) and Don't send each take one confirm,
// never from Enter, and what happened stays shown.
import { RefreshIcon } from "./Icons";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import Composer, { WhoTag, type ComposeStart, type ComposerSnapshot } from "./MailCompose";
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "./clipboard";
import { splitLinks } from "./areas/linkText";
import { formatSize } from "./media";
import { initials } from "./messages/messagesView";
import {
  addressLine, can, canSendFrom, draftEditable, draftFields, readPending, sendOutcomeText, settled, withoutPending, writePending, mailDate, mailDateLong, mailProblem, mailSrcdoc, notVerified, replyFields,
  senderLabel, subjectLabel, writesOffered, mailTabs, placeAccount, placeSources, placeTitle, placeValid, splitQuoted, threadPeople, toWords,
  type AccountBoxes, type MailAttachment, type MailLink, type MailMessage, type MailProblem, type MailThread, type Overview, type Place,
  type PendingSend, type SendOutcome, type Source, type ThreadPage, type ThreadSummary,
  approvalOffered, approveOutcome, canApprove, declineOutcome, fileKind, heldFailure, heldShownWhole, type HeldOutcome, type Parked,
} from "./mailCore";
import { beginListing, endDeciding, heldEntries, heldGen, keepAccounts, mergeListing, noteUnread, onHeld, setOutcome, startDeciding, waiting, type HeldEntry } from "./mailHeld";
import "./doors.css";
import "./Mail.css";

type List = { key: string; threads: ThreadSummary[]; next: Source[]; more: boolean; total: number | null };
type Open = { accountId: string; threadId: string };
/** `thread`: the thread a reply or draft belongs to (`account/thread`); it is written under that thread. */
type Compose = { key: number; start: ComposeStart; hidden: boolean; snapshot: ComposerSnapshot | null; thread: string | null };
/** Where you were in Mail: the view remounts each time it is opened, and comes back to the same place, thread and
 *  message being written. */
const remembered: { place: Place; query: string; files: boolean; open: Open | null; compose: Compose | null } = { place: "inbox", query: "", files: false, open: null, compose: null };
/** A phone shows one pane at a time. */
type Pane = "list" | "thread";
const SEARCH_PAUSE_MS = 350;

function openLink(url: string) {
  void invoke("open_link", { url }).catch(() => {});
}

const keyOf = (o: { accountId: string; threadId: string }) => `${o.accountId}/${o.threadId}`;

/** A thread's subject as its heading says it: the first real message's, without "Re:". */
function threadSubject(t: MailThread): string {
  return subjectLabel((t.messages.find((m) => !m.draft) ?? t.messages[0]).subject.replace(/^re:\s*/i, ""));
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

function PlainBody({ text }: { text: string }) {
  return <div className="mail-text">{splitLinks(text).map((part, i) => "url" in part
    ? <a key={i} href={part.url} title={part.url} onClick={(e) => { e.preventDefault(); openLink(part.url); }}>{part.url}</a>
    : <span key={i}>{part.text}</span>)}</div>;
}

/** v1's gates, unchanged: a name/type refusal shows at once and fetches nothing; the bytes are checked on Open. */
function AttachmentRow({ accountId, a }: { accountId: string; a: MailAttachment }) {
  return <FileRow name={a.name || "attachment"} mime={a.mime} size={a.size} early={a.refused ?? null}
    open={() => invoke("mail_attachment_open", { accountId, blobId: a.blob_id, name: a.name, mime: a.mime })} />;
}

/** One file with its kind and size, which stay shown whatever happens; a tap opens it in the system's viewer (`open`),
 *  after Rust's checks. `onRefused`: the checks refused it (its bytes, or the listing changed), not a network failure. */
function FileRow({ name, mime, size, early, open: opener, onRefused }: { name: string; mime: string; size: number; early: string | null; open: () => Promise<unknown>; onRefused?: () => void }) {
  const [state, setState] = useState<"idle" | "opening" | "opened" | "error">("idle");
  const [error, setError] = useState("");
  const open = async () => {
    setState("opening");
    try { await opener(); setState("opened"); }
    catch (e) { const p = mailProblem(e); setError(p.kind === "invalid" ? p.detail : p.title); setState("error"); if (p.kind === "invalid") onRefused?.(); }
  };
  const refused = early !== null || state === "error";
  const facts = [fileKind(name, mime), formatSize(size)].filter(Boolean).join(" · ");
  return <li className={`mail-attachment-item ${refused ? "refused" : ""}`}>
    <button type="button" className="attachment-file mail-attachment" disabled={early !== null || state === "opening"} onClick={() => void open()} aria-label={`${early ? `${name} won't open` : `Open ${name}`}, ${facts}`}>
      <span aria-hidden="true">{refused ? "⊘" : mime === "application/pdf" ? "📄" : "📎"}</span><span className="attachment-name">{name}</span>
      <small>{facts} · {refused ? "Not opened" : state === "opening" ? "Opening…" : "Open"}</small>
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

/** Where a message of a thread lives, when that isn't somewhere you'd read it: a thread can reach into Junk and Trash. */
function placeOf(m: MailMessage, acct: AccountBoxes): "junk" | "trash" | null {
  const roles = m.mailbox_ids.map((id) => acct.mailboxes.find((b) => b.id === id)?.role);
  for (const r of ["junk", "trash"] as const) if (roles.length > 0 && roles.every((x) => x === r)) return r;
  return null;
}

/** A plain body: what it says, then its quoted history folded behind one tap. */
function PlainText({ text }: { text: string }) {
  const { body, quoted } = splitQuoted(text);
  const [showQuoted, setShowQuoted] = useState(false);
  return <>{<PlainBody text={body} />}
    {quoted && <button type="button" className="note-quiet mail-quoted-toggle" aria-expanded={showQuoted} onClick={() => setShowQuoted(!showQuoted)}>{showQuoted ? "Hide quoted text" : "Show quoted text"}</button>}
    {quoted && showQuoted && <div className="mail-quoted"><PlainBody text={quoted} /></div>}</>;
}

/** One message of a thread. Folded: one line (who, the first words, when), a tap opens it. Open: who and when on one
 *  line (the addresses under Details), the body (plain text first, the sealed HTML on request), attachments. */
function MessageCard({ m, acct, accountId, overview, folded, onToggle }: { m: MailMessage; acct: AccountBoxes; accountId: string; overview: Overview; folded: boolean; onToggle: (() => void) | null }) {
  const [formatted, setFormatted] = useState(!m.text && !!m.html);
  const [details, setDetails] = useState(false);
  const showHtml = formatted && !!m.html;
  const place = placeOf(m, acct);
  const unverified = notVerified(m, overview);
  const who = senderLabel(m.from);
  const when = mailDateLong(m.sent_at || m.received_at);
  if (folded) return <article id={`mail-msg-${m.id}`} className="mail-msg mail-msg-folded" data-folded="true">
    <button type="button" className="mail-msg-fold" onClick={onToggle ?? undefined} aria-label={`${who}, ${when}. Show this message`}>
      <span className="door-avatar mail-msg-disc" aria-hidden="true">{initials(m.from[0]?.name?.trim() || m.from[0]?.email || "?")}</span>
      <strong>{who}</strong><span className="mail-msg-snippet">{(m.text ?? "").replace(/\s+/g, " ").slice(0, 160) || subjectLabel(m.subject)}</span>
      <time dateTime={m.received_at}>{mailDate(m.received_at)}</time>
    </button>
  </article>;
  const to = toWords(m, acct);
  return <article id={`mail-msg-${m.id}`} className={`mail-msg ${m.unread && !m.draft ? "mail-msg-unread" : ""} ${m.draft ? "mail-msg-draft" : ""}`} data-folded="false"
    aria-label={m.draft ? `Draft: ${subjectLabel(m.subject)}` : `Message from ${addressLine(m.from) || "(no sender)"}`}>
    {m.draft && acct.who === "uni" && <p className="mail-flag-line"><span className="mail-draft-tag">Uni's own draft · not sent</span></p>}
    {!m.draft && m.uni_drafted && acct.who === "owner" && <p className="mail-flag-line mail-provenance"><span className="mail-draft-tag">Drafted by Uni · sent by you</span></p>}
    {unverified && <p className="mail-flag-line mail-unverified" role="note"><span className="mail-draft-tag">Not verified</span>
      <span>Says it is from you, but the receiving server couldn't confirm it (DMARC: {m.dmarc}). Treat what it asks with care.</span></p>}
    {place && <p className="mail-flag-line mail-place"><span className="mail-draft-tag">{place === "junk" ? "In Junk" : "In Trash"}</span>
      <span>{place === "junk" ? "Filed as junk. Treat its links and files with care." : "In the Trash."}</span></p>}
    <div className="mail-msg-head">
      <span className="door-avatar mail-msg-disc" aria-hidden="true">{initials(m.from[0]?.name?.trim() || m.from[0]?.email || "?")}</span>
      <p className="mail-msg-who">
        {onToggle ? <button type="button" className="mail-msg-name" onClick={onToggle} aria-label={`${who}: fold this message`}>{who}</button> : <strong className="mail-msg-name">{who}</strong>}
        {to && <span> to {to}</span>}
        <span className="mail-msg-when"> · {m.draft ? "saved " : ""}{when}</span>
        {m.unread && !m.draft && <span className="mail-unread-word"> · unread</span>}
        {m.flagged && <span className="mail-flag-word"> · Later</span>}
      </p>
      <button type="button" className="note-quiet mail-details-toggle" aria-expanded={details} onClick={() => setDetails(!details)}>Details</button>
    </div>
    {details && <dl className="mail-headers">
      <dt>From</dt><dd>{addressLine(m.from) || "(no sender)"}</dd>
      {m.to.length > 0 && <><dt>To</dt><dd>{addressLine(m.to)}</dd></>}
      {m.cc.length > 0 && <><dt>Cc</dt><dd>{addressLine(m.cc)}</dd></>}
      {m.draft && (m.bcc?.length ?? 0) > 0 && <><dt>Bcc</dt><dd>{addressLine(m.bcc!)}</dd></>}
      <dt>{m.draft ? "Saved" : "Date"}</dt><dd>{when}</dd>
    </dl>}
    {m.attachments.length > 0 && <ul className="mail-attachments" aria-label="Attachments">{m.attachments.map((a, i) => <AttachmentRow key={a.part_id ?? `${a.blob_id}-${i}`} accountId={accountId} a={a} />)}</ul>}
    {(m.text && m.html) || (showHtml && m.remote_images > 0) || m.truncated ? <div className="mail-body-bar">
      {m.text && m.html && <button type="button" className="note-quiet" aria-pressed={showHtml} onClick={() => setFormatted(!formatted)}>{showHtml ? "Show plain text" : "Show formatted"}</button>}
      {showHtml && m.remote_images > 0 && <span className="mail-note">{m.remote_images === 1 ? "1 remote image not loaded" : `${m.remote_images} remote images not loaded`}</span>}
      {m.truncated && <span className="mail-note">This message is long; the app shows its first megabyte.</span>}
    </div> : null}
    {showHtml && m.links.length > 0 && <LinkList links={m.links} />}
    {showHtml
      ? <iframe className="mail-html" title={`Message: ${subjectLabel(m.subject)}`} sandbox="" referrerPolicy="no-referrer" srcDoc={mailSrcdoc(m.html!)} />
      : m.text ? <PlainText text={m.text} />
      : <p className="empty">This message has no text.</p>}
  </article>;
}

/** The draft waiting at the foot of a thread of yours: Uni's (the reply Uni prepared) or your own. Said once. */
function DraftFoot({ drafts, uni, onEdit, onOwn }: { drafts: MailMessage[]; uni: boolean; onEdit: (() => void) | null; onOwn: (() => void) | null }) {
  const d = drafts[drafts.length - 1];
  const older = drafts.length - 1;
  const whole = draftEditable(d);
  return <section className={`mail-foot ${uni ? "mail-foot-uni" : ""}`} aria-label={uni ? "Uni's draft reply" : "Your draft"}>
    <p className="mail-foot-head"><span className="mail-draft-tag">{uni ? "Uni drafted a reply · not sent" : "Your draft · not sent"}</span>
      {older > 0 && <small className="mail-note">{older === 1 ? "1 older draft" : `${older} older drafts`}{uni ? " (sending this one discards it)" : ""}</small>}</p>
    {d.text ? <div className="mail-foot-text"><PlainBody text={d.text} /></div> : <p className="empty">No text yet.</p>}
    <p className="mail-foot-actions">
      {onEdit && whole && <button type="button" className="send mail-foot-edit" onClick={onEdit}>{uni ? "Edit and send" : "Edit draft"}</button>}
      {onEdit && !whole && <span className="mail-note">It has formatting or files this app can't show in full: send it from your mail client.</span>}
      {!onEdit && uni && <span className="mail-note">Uni can't send as you: send it from your mail app.</span>}
      {onOwn && uni && <button type="button" className="note-action" onClick={onOwn}>Write my own</button>}
    </p>
  </section>;
}

/** What the thread bar can do; each is null where the bridge doesn't offer it on this account. */
type ThreadActions = {
  reply: (() => void) | null;
  markUnread: (() => void) | null;
  markRead: (() => void) | null;
  later: (() => void) | null;
  laterLabel: string;
  archive: (() => void) | null;
  openDraft: ((m: MailMessage) => void) | null;
  replyOwn: (() => void) | null;
  busy: boolean;
  problem: string | null;
};

/** The thread bar: back (a phone), then the verbs. */
function ThreadBar({ t, backTo, onBack, actions }: { t: MailThread; backTo: string; onBack: () => void; actions: ThreadActions }) {
  const real = t.messages.filter((m) => !m.draft);
  const unread = real.some((m) => m.unread);
  return <div className="mail-thread-bar">
    <button type="button" className="note-action mail-thread-back" onClick={onBack}>← {backTo}</button>
    <span className="mail-thread-tools">
      {unread ? actions.markRead && <button type="button" className="note-quiet" disabled={actions.busy} onClick={actions.markRead}>Mark read</button>
        : actions.markUnread && <button type="button" className="note-quiet" disabled={actions.busy} onClick={actions.markUnread}>Unread</button>}
      {actions.later && <button type="button" className="note-action" disabled={actions.busy} onClick={actions.later}>{actions.laterLabel}</button>}
      {actions.archive && <button type="button" className="note-action mail-archive" disabled={actions.busy} onClick={actions.archive}>Archive</button>}
      {actions.reply && <button type="button" className="send mail-reply" onClick={actions.reply}>Reply</button>}
    </span>
  </div>;
}

/** The thread: subject, who's in it, Uni's triage note (labelled as Uni's), the conversation oldest first with the
 *  earlier messages folded, then the draft at its foot. */
function ThreadBody({ t, acct, overview, note, actions, composingHere }: { t: MailThread; acct: AccountBoxes; overview: Overview; note: string | null; actions: ThreadActions; composingHere: boolean }) {
  const own = acct.who === "owner";
  // your Drafts in this thread go to its foot; Uni's own drafts (in Uni's mail) stay in the conversation, labelled
  const conversation = t.messages.filter((m) => !(own && m.draft));
  const real = t.messages.filter((m) => !m.draft);
  const drafts = own ? t.messages.filter((m) => m.draft) : [];
  const uniDrafts = drafts.filter((m) => m.uni_drafted);
  const footDrafts = uniDrafts.length > 0 ? uniDrafts : drafts;
  const last = conversation[conversation.length - 1];
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const openByDefault = (m: MailMessage) => m.id === last?.id || (m.unread && !m.draft) || conversation.length <= 2;
  const isOpen = (m: MailMessage) => opened.has(m.id) || (openByDefault(m) && !closed.has(m.id));
  const toggle = (m: MailMessage) => () => {
    const now = isOpen(m);
    setOpened((s) => { const n = new Set(s); if (now) n.delete(m.id); else n.add(m.id); return n; });
    setClosed((s) => { const n = new Set(s); if (now) n.add(m.id); else n.delete(m.id); return n; });
  };
  return <>
    <h2 className="mail-subject">{threadSubject(t)}</h2>
    <p className="mail-thread-where">{!own && <WhoTag who={acct.who} address={acct.name} />}<span>{!own && "In Uni's mail · "}{real.length} {real.length === 1 ? "message" : "messages"} · {threadPeople({ ...t, messages: real }, acct)}</span></p>
    {note && <p className="mail-triage" role="note"><span className="eyebrow">Uni's note</span><span>{note}</span></p>}
    {conversation.map((m) => <MessageCard key={m.id} m={m} acct={acct} accountId={t.account_id} overview={overview} folded={!isOpen(m)} onToggle={m.id === last?.id ? null : toggle(m)} />)}
    {footDrafts.length > 0 && !composingHere && <DraftFoot drafts={footDrafts} uni={uniDrafts.length > 0}
      onEdit={actions.openDraft && (() => actions.openDraft!(footDrafts[footDrafts.length - 1]))} onOwn={actions.replyOwn} />}
  </>;
}

/** Enter never decides a held send: only a tap, a click or Space. */
const noEnter = (e: KeyboardEvent) => { if (e.key === "Enter") e.preventDefault(); };

/** Held sends (opId/fingerprint) with a file that failed its checks when opened. */
const failedHeld = new Set<string>();

const filesWord = (n: number) => (n === 1 ? "1 file" : `${n} files`);

function heldTo(p: Parked): string {
  const f = p.fields;
  const list = f ? [...f.to, ...f.cc, ...f.bcc].map((a) => a.email) : p.recipients;
  return list.length ? list.join(", ") : "(no recipients)";
}

function HeldRow({ e, selected, onOpen }: { e: HeldEntry; selected: boolean; onOpen: () => void }) {
  const p = e.item;
  const state = e.outcome && e.outcome.kind !== "failed" ? e.outcome.kind : waiting(e) ? "waiting" : "failed";
  const tag = state === "sent" ? "Sent" : state === "declined" ? "Not sent" : state === "failed" ? "Ask #systems" : "Waiting";
  const files = p.files?.length ?? 0;
  return <li><button type="button" className={`mail-row mail-held-row held-${state} ${selected ? "selected" : ""}`} aria-current={selected ? "true" : undefined} onClick={onOpen}
    aria-label={`${tag === "Waiting" ? "Waiting for you" : tag}. From Uni's address to ${heldTo(p)}: ${subjectLabel(p.fields?.subject ?? "")}${files ? `, with ${filesWord(files)}` : ""}`}>
    <span className="mail-row-top"><WhoTag who="uni" /><span className="mail-from">To {heldTo(p)}</span><span className="mail-held-tag">{tag}</span></span>
    <span className="mail-row-subject">{files > 0 && <span aria-hidden="true">📎 {files} · </span>}{subjectLabel(p.fields?.subject ?? "")}</span>
    <span className="mail-row-preview">{e.outcome?.text ?? p.reason ?? p.problem ?? ""}</span>
  </button></li>;
}

/** A held send in full, and the two decisions on it. Each needs a second, deliberate tap; Enter does neither. */
function HeldView({ e, acct, onBack, onDecide }: { e: HeldEntry; acct: AccountBoxes; onBack: () => void; onDecide: (kind: "approve" | "decline") => Promise<void> }) {
  const [confirm, setConfirm] = useState<"approve" | "decline" | null>(null);
  // a file that failed its checks when opened: Send it isn't offered for this send as listed (its opId and fingerprint),
  // remembered while the app runs, so leaving the view and coming back doesn't offer it again
  const heldKey = `${e.item.op_id}/${e.item.fingerprint ?? ""}`;
  const [failedFile, setFailedFile] = useState(() => failedHeld.has(heldKey));
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const confirmBox = useRef<HTMLDivElement>(null);
  const p = e.item, f = p.fields;
  const open = waiting(e);
  const approvable = canApprove(acct, p) && !failedFile;
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
  const files = p.files ?? [];
  const withFiles = files.length ? `, with its ${files.length === 1 ? "file" : filesWord(files.length)}` : "";
  return <section className="mail-thread mail-held" aria-label={`Held send: ${subjectLabel(f?.subject ?? "")}`}>
    <div className="mail-thread-bar">
      <button type="button" className="note-action mail-thread-back" onClick={onBack}>← Waiting</button>
      <span className="mail-held-where"><WhoTag who="uni" address={acct.name} /> {e.outcome?.kind === "sent" ? "Sent from Uni's address" : e.outcome?.kind === "declined" ? "Declined · not sent" : "Held for you · not sent"}</span>
    </div>
    <div className="mail-thread-scroll">
      <h2 className="mail-subject">{subjectLabel(f?.subject ?? "")}</h2>
      <p className="mail-triage mail-held-why" role="note"><span className="eyebrow">Why it waits</span><span>{p.reason ?? "Uni's outbound rules want your approval."}</span></p>
      {p.changed && <p className="mail-draft-note mail-unverified" role="note"><span className="mail-draft-tag">Changed</span><span>This draft changed after Uni's rules held it, so the bridge won't send it. Don't send it, and ask Uni to send it again.</span></p>}
      {p.problem && <p className="mail-draft-note mail-unverified" role="note"><span className="mail-draft-tag">Can't show it</span><span>{p.problem}. Nothing can be sent from here; ask #systems.</span></p>}
      {f && !p.problem && !heldShownWhole(p) && <p className="mail-draft-note" role="note"><span>It may have formatting or attachments this app can't show in full, so only Don't send is offered here.</span></p>}
      {f && <article className="mail-card mail-card-draft" aria-label="What it sends">
        <dl className="mail-headers">
          <dt>From</dt><dd>Uni &lt;{acct.name}&gt;</dd>
          <dt>To</dt><dd>{addressLine(f.to) || "(nobody)"}</dd>
          {f.cc.length > 0 && <><dt>Cc</dt><dd>{addressLine(f.cc)}</dd></>}
          {f.bcc.length > 0 && <><dt>Bcc</dt><dd>{addressLine(f.bcc)}</dd></>}
          <dt>Subject</dt><dd>{subjectLabel(f.subject)}</dd>
        </dl>
        {files.length > 0 && <ul className="mail-attachments" aria-label={`Files it sends (${files.length})`}>{files.map((x, i) => <FileRow key={`${i}-${x.sha256}`} name={x.name} mime={x.mime} size={x.size}
          early={x.refused ?? (p.draft_id ? null : "The held draft can't be found, so this file can't be opened here.")}
          open={() => invoke("mail_held_file_open", { accountId: acct.id, draftId: p.draft_id, index: i, file: x })} onRefused={() => { failedHeld.add(heldKey); setFailedFile(true); }} />)}</ul>}
        {f.text ? <PlainBody text={f.text} /> : <p className="empty">This message has no text.</p>}
      </article>}
      {failedFile && open && <p className="mail-draft-note mail-unverified" role="note"><span className="mail-draft-tag">File not checked</span><span>A file didn't pass the checks when opened, so Send it isn't offered. Don't send it, and ask Uni.</span></p>}
      {e.outcome && <p className={`mail-held-outcome held-${e.outcome.kind}`} role="status">{e.outcome.text}</p>}
      {open && (approvable || declinable) && (asking
        ? <div ref={confirmBox} tabIndex={-1} className="mail-held-confirm" role="group" aria-label={asking === "approve" ? "Confirm sending" : "Confirm not sending"}>
            <p>{asking === "approve" ? `Send this from ${from} to ${heldTo(p)}${withFiles}? It goes out exactly as shown${files.length ? ", files included" : ""}.` : `Don't send this? Nothing goes out from ${from}; Uni can change or drop the draft.`}</p>
            <span className="mail-held-buttons">
              <button type="button" className={asking === "approve" ? "send mail-held-yes" : "note-action mail-held-yes"} disabled={busy} onKeyDown={noEnter} onClick={() => void go()}>
                {busy ? (asking === "approve" ? "Sending…" : "Declining…") : asking === "approve" ? "Yes, send from Uni's address" : "Yes, don't send it"}</button>
              <button type="button" className="note-quiet" disabled={busy} onKeyDown={noEnter} onClick={() => setConfirm(null)}>Cancel</button>
            </span>
          </div>
        : <div className="mail-held-actions">
            {approvable && <button type="button" className="send mail-held-send" onKeyDown={noEnter} onClick={() => ask("approve")} aria-label={`Send it${files.length ? ` with ${filesWord(files.length)}` : ""}, from ${from}`}>
              <span>Send it</span><small>{files.length > 0 && `with ${filesWord(files.length)}, `}from Uni's address, {acct.name}</small></button>}
            {declinable && <button type="button" className="note-action mail-held-decline" onKeyDown={noEnter} onClick={() => ask("decline")} aria-label={`Don't send it from ${from}`}>
              <span>Don't send</span><small>nothing goes out from Uni's address</small></button>}
          </div>)}
    </div>
  </section>;
}

function ThreadRow({ t, place, note, selected, onOpen }: { t: ThreadSummary; place: Place; note: string | null; selected: boolean; onOpen: () => void }) {
  const party = t.draft ? `To ${senderLabel(t.to)}` : senderLabel(t.from);
  const who = (t.draft ? t.to[0] : t.from[0]);
  const uniDraft = !!t.uni_draft || (t.draft && t.uni_drafted);
  const said = [t.unread && "Unread.", t.flagged && place !== "later" && "Later.", uniDraft && "Draft by Uni.", t.draft && !t.uni_drafted && "Draft."].filter(Boolean).join(" ");
  return <li><button type="button" className={`mail-row door-row ${t.unread ? "unread" : ""} ${selected ? "selected" : ""}`} aria-current={selected ? "true" : undefined} onClick={onOpen}
    aria-label={`${said ? `${said} ` : ""}${party}: ${subjectLabel(t.subject)}${t.has_attachment ? ", with files" : ""}`}>
    <span className="door-avatar" aria-hidden="true">{initials(who?.name?.trim() || who?.email || "?")}</span>
    <span className="door-row-text">
      <span className="door-row-top">
        <span className="door-row-name mail-from">{t.draft ? <em>{party}</em> : party}{t.count > 1 && <small className="mail-row-count"> · {t.count}</small>}</span>
        {uniDraft && <span className="mail-draft-tag small" aria-hidden="true">Uni drafted</span>}
        {t.flagged && place !== "later" && <span className="mail-row-later" aria-hidden="true">Later</span>}
        {t.has_attachment && <span className="mail-row-files" aria-hidden="true">📎</span>}
        <time dateTime={t.received_at}>{mailDate(t.received_at)}</time>
      </span>
      <span className="door-row-bottom mail-row-line"><span className="mail-row-subject">{subjectLabel(t.subject)}</span>
        {!note && t.preview && t.preview.trim() !== t.subject.trim() && <span className="door-row-preview mail-row-preview">{t.preview}</span>}</span>
      {note && <span className="mail-row-triage"><span className="mail-row-triage-who">Uni:</span> {note}</span>}
    </span>
  </button></li>;
}

/** The places as tabs, like Messages'. Arrow keys move along them. */
function PlaceTabs({ tabs, place, onPick, onRefresh, refreshing }: { tabs: ReturnType<typeof mailTabs>; place: Place; onPick: (p: Place) => void; onRefresh: () => void; refreshing: boolean }) {
  const strip = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = strip.current, on = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !on) return;
    const left = on.offsetLeft - el.offsetLeft, right = left + on.offsetWidth;
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  }, [place]);
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = tabs.findIndex((t) => t.id === place);
    const next = tabs[(at + step + tabs.length) % tabs.length];
    onPick(next.id);
    strip.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };
  return <div className="door-tabs mail-tabs">
    <div className="door-tablist mail-tablist" role="tablist" aria-label="Mail places" ref={strip} onKeyDown={key}>
      {tabs.map((t) => <button key={t.id} type="button" role="tab" data-tab={t.id} aria-selected={t.id === place} aria-controls="mail-list" tabIndex={t.id === place ? 0 : -1}
        aria-label={t.name} className={`door-tab mail-tab ${t.id === "uni" ? "mail-tab-uni" : ""}`} onClick={() => onPick(t.id)}>
        <span>{t.label}</span>{t.count > 0 && <span className="door-tab-count" aria-hidden="true">{t.count}</span>}
      </button>)}
    </div>
    <button className="note-action note-refresh mail-refresh" aria-label="Refresh" title="Refresh" onClick={onRefresh} disabled={refreshing}><RefreshIcon /></button>
  </div>;
}

/** 0.2: Mail is a place on the rail, so it has no Back of its own (the rail and the system Back are the way out); `onBack` is for a host that has none. */
export default function Mail({ onBack, backTo = "Uni" }: { onBack?: () => void; backTo?: string }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [boxesProblem, setBoxesProblem] = useState<MailProblem | null>(null);
  const [place, setPlace] = useState<Place>(remembered.place);
  const [query, setQuery] = useState(remembered.query);
  const [typed, setTyped] = useState(remembered.query);
  const [files, setFiles] = useState(remembered.files);
  const [list, setList] = useState<List | null>(null);
  const [listProblem, setListProblem] = useState<MailProblem | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [laterCount, setLaterCount] = useState(0);
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
  /** T-208: triage calls by when they were asked, and for each row the call whose answer it shows: an older call that
   *  answers later (a page asked again by Load older) never overwrites a newer one's note. */
  const notesAsked = useRef(0);
  const noteFrom = useRef(new Map<string, number>()).current;
  const composeSeq = useRef(remembered.compose?.key ?? 0);
  /** The thread just opened from the list: only that load marks it read (a Refresh or a reload doesn't undo Unread). */
  const markOnOpen = useRef<string | null>(null);
  /** The open thread and list now, for callbacks that finish later (an archive, a refresh). */
  const openRef = useRef<Open | null>(remembered.open);
  const listRef = useRef<List | null>(null);
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
  const laterSeq = useRef(0);
  /** The list being shown (place, search, Files): notes for it are kept while it pages, dropped when it changes. */
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
      noteUnread(o, seq);
      const known = (id: string) => o.accounts.some((a) => a.id === id);
      overviewRef.current = o;
      setOverview(o);
      setPlace((cur) => (placeValid(cur, o) ? cur : "inbox"));
      setList((cur) => (cur && cur.threads.some((t) => !known(t.account_id)) ? { ...cur, threads: cur.threads.filter((t) => known(t.account_id)), more: false } : cur));
      setOpen((cur) => {
        if (!cur || known(cur.accountId)) return cur;
        threadSeq.current++; setThread(null); setThreadProblem(null); setPane("list");
        return null;
      });
      return o;
    } catch (e) { setBoxesProblem(mailProblem(e)); return null; }
  }, []);

  /** How many threads wait in Later, for its tab (the server counts them). */
  const loadLater = useCallback(async (o: Overview) => {
    const sources = placeSources("later", o);
    if (sources.length === 0) return;
    const seq = ++laterSeq.current;
    try {
      const page = await invoke<ThreadPage>("mail_threads", { sources, text: null });
      if (seq === laterSeq.current && alive.current) setLaterCount(page.total ?? page.threads.length);
    } catch { /* the count is a nicety: a failure leaves the last one */ }
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
      const asked = ++notesAsked.current;
      const got = await invoke<Record<string, string>>("mail_triage", { accountId, emailIds }).catch(() => null);
      if (key !== shownKey.current || gen !== notesGen.current) return;
      const fresh = emailIds.filter((id) => (noteFrom.get(`${accountId}/${id}`) ?? 0) < asked);
      // a failed call shows no notes but claims no row: an older answer that does arrive still counts
      if (got) for (const id of fresh) noteFrom.set(`${accountId}/${id}`, asked);
      setNotes((cur) => {
        const next = { ...cur };
        for (const id of fresh) delete next[`${accountId}/${id}`];
        for (const id of fresh) if (got && Object.prototype.hasOwnProperty.call(got, id) && got[id]) next[`${accountId}/${id}`] = got[id];
        return next;
      });
    }
  }, []);

  const loadList = useCallback(async (key: string, sources: Source[], text: string, more: List | null) => {
    if (sources.length === 0) { setList({ key, threads: [], next: [], more: false, total: 0 }); return; }
    const seq = ++listSeq.current;
    const gen = more ? notesGen.current : ++notesGen.current;
    if (!more) noteFrom.clear(); // an older list's answers are dropped by their generation
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
      // opening a thread of your own from the list marks it read, where the bridge offers that (Unread undoes
      // it). Uni's mail stays as Uni left it unless you mark it; a reload never marks.
      const acct = overviewRef.current?.accounts.find((a) => a.id === t.account_id);
      const unreadIds = t.messages.filter((m) => m.unread && !m.draft).map((m) => m.id);
      const opened = markOnOpen.current === keyOf(o);
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

  const listKey = overview ? `${place}?${query}${files ? "&files" : ""}` : "";
  const sourcesNow = (o: Overview) => placeSources(place, o, { text: query, files });
  useEffect(() => { void loadOverview().then((o) => { if (o) { void loadHeld(o); void loadLater(o); } }); }, [loadOverview, loadHeld, loadLater]);
  useEffect(() => {
    if (!overview) return;
    setList((cur) => (cur?.key === listKey ? cur : null));
    void loadList(listKey, sourcesNow(overview), query, null);
    // the overview's counts change on Refresh; the list reloads only when what it shows changes
  }, [listKey, loadList]);
  useEffect(() => { if (open) void loadThread(open); }, [open, loadThread]);
  useEffect(() => { remembered.place = place; remembered.query = query; remembered.files = files; remembered.open = open; openRef.current = open; }, [place, query, files, open]);
  useEffect(() => { listRef.current = list; }, [list]);
  // search as you type: a short pause after the last key, then the list reads it (Enter reads it at once)
  useEffect(() => {
    const want = typed.trim();
    if (want === query) return;
    const t = setTimeout(() => runSearch(want), want ? SEARCH_PAUSE_MS : 0);
    return () => clearTimeout(t);
  }, [typed]);

  const accountOf = (id: string) => overview?.accounts.find((a) => a.id === id);
  const refresh = async () => {
    const o = await loadOverview();
    if (o) { void loadHeld(o); void loadLater(o); }
    // the list reloads with the accounts the bridge has now (a place that went is reset, and its effect reloads)
    if (o && placeValid(place, o)) void loadList(listKey, placeSources(place, o, { text: query, files }), query, null);
    const now = openRef.current;
    if (o && now && o.accounts.some((a) => a.id === now.accountId)) void loadThread(now);
  };
  /** Close the open thread (a new list doesn't keep showing a thread from the old one). */
  const closeThread = () => { threadSeq.current++; openRef.current = null; setOpenHeld(null); setOpen(null); setThread(null); setThreadProblem(null); };
  const pick = (p: Place) => { closeThread(); setPlace(p); setQuery(""); setTyped(""); setFiles(false); setPane("list"); };
  const runSearch = (text: string) => { if (text !== query) { closeThread(); setQuery(text); setPane("list"); } };
  const toggleFiles = () => { closeThread(); setFiles(!files); setPane("list"); };
  const openThread = (t: Pick<ThreadSummary, "account_id" | "thread_id">) => {
    // a message being written stays: it waits, with Resume (it comes back under its own thread)
    const c = composeRef.current;
    if (c && !c.hidden && c.thread !== `${t.account_id}/${t.thread_id}`) setCompose({ ...c, hidden: true });
    markOnOpen.current = `${t.account_id}/${t.thread_id}`;
    setOpenHeld(null);
    setOpen({ accountId: t.account_id, threadId: t.thread_id }); setPane("thread");
  };
  const [composeNote, setComposeNote] = useState<string | null>(null);
  const resume = () => {
    const c = composeRef.current;
    if (!c) return;
    if (c.thread) {
      const [accountId, ...rest] = c.thread.split("/"), threadId = rest.join("/");
      const now = openRef.current;
      if (!now || keyOf(now) !== c.thread) { setOpenHeld(null); setOpen({ accountId, threadId }); }
    }
    setCompose({ ...c, hidden: false }); setPane("thread");
  };
  const startCompose = (start: ComposeStart, threadKey: string | null) => {
    // one message at a time: one with changes, a saved draft or a send under way comes back instead of being replaced
    const snap = remembered.compose?.snapshot;
    if (compose && (snap?.dirty || snap?.saved || (snap && snap.stage.kind !== "edit"))) {
      setComposeNote("Finish or close this message first."); resume(); return;
    }
    setComposeNote(null);
    if (!threadKey) { setOpenHeld(null); }
    setCompose({ key: ++composeSeq.current, start, hidden: false, snapshot: null, thread: threadKey }); setPane("thread");
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
    // from the place's account, when it can send (yours, or Uni's on Uni's tab)
    const here = overview ? placeAccount(place, overview) : undefined;
    closeThread();
    startCompose({ kind: "new", from: here && canSendFrom(here) ? here.id : null }, null);
  };

  /** Take a thread out of the list it is in, and open the one below it (else the one above; else back to the list). */
  const leaveThread = (o: Open) => {
    const same = (c: Open | null) => !!c && c.accountId === o.accountId && c.threadId === o.threadId;
    const rows = listRef.current?.threads ?? [];
    const at = rows.findIndex((r) => r.account_id === o.accountId && r.thread_id === o.threadId);
    const rest = rows.filter((_, i) => i !== at);
    const next = at < 0 ? undefined : rest[at] ?? rest[at - 1];
    setList((cur) => (cur ? { ...cur, threads: cur.threads.filter((r) => !(r.account_id === o.accountId && r.thread_id === o.threadId)), total: cur.total != null ? Math.max(0, cur.total - 1) : cur.total } : cur));
    if (!same(openRef.current)) return;
    const c = composeRef.current;
    if (c && !c.hidden && c.thread === keyOf(o)) return; // a reply being written keeps its thread
    if (next) openThread(next);
    else { closeThread(); if (!c || c.hidden) setPane("list"); }
  };
  /** Run one write for the open thread; say what failed, in words. */
  const act = async (what: string, run: () => Promise<unknown>, after: () => void) => {
    setBusy(true); setActionProblem(null);
    try { await run(); after(); }
    catch (e) { const p = mailProblem(e); setActionProblem(`Couldn't ${what}. ${p.title} ${p.detail}`); }
    finally { setBusy(false); }
  };
  const threadActions = (t: MailThread, acct: AccountBoxes): ThreadActions => {
    const o: Open = { accountId: t.account_id, threadId: t.thread_id };
    const real = t.messages.filter((m) => !m.draft);
    const newest = real[real.length - 1] ?? t.messages[t.messages.length - 1];
    const inbox = acct.mailboxes.find((b) => b.role === "inbox")?.id;
    const inInbox = real.filter((m) => inbox && m.mailbox_ids.includes(inbox)).map((m) => m.id);
    const flaggedIds = t.messages.filter((m) => m.flagged).map((m) => m.id);
    const flagged = flaggedIds.length > 0;
    const setFlag = (ids: string[], on: boolean) => {
      // only if that thread is still the one shown (email ids are per account)
      setThread((cur) => (cur && cur.account_id === o.accountId && cur.thread_id === o.threadId ? { ...cur, messages: cur.messages.map((m) => (ids.includes(m.id) ? { ...m, flagged: on } : m)) } : cur));
      setList((cur) => (cur ? { ...cur, threads: cur.threads.map((r) => (r.account_id === o.accountId && r.thread_id === o.threadId ? { ...r, flagged: on } : r)) } : cur));
    };
    const mark = can(acct, "mark_seen");
    const own = acct.who === "owner";
    const drafts = own ? t.messages.filter((m) => m.draft) : [];
    const uniDrafts = drafts.filter((m) => m.uni_drafted);
    const footList = uniDrafts.length > 0 ? uniDrafts : drafts, footDraft = footList[footList.length - 1];
    const sendable = canSendFrom(acct);
    const openDraft = own && sendable ? (m: MailMessage) => startCompose({ kind: "draft", accountId: acct.id, draftId: m.id, fields: draftFields(m), uni: m.uni_drafted }, keyOf(o)) : null;
    const replyOwn = sendable ? () => startCompose({ kind: "reply", accountId: acct.id, fields: replyFields(t, acct) }, keyOf(o)) : null;
    // Reply starts from the draft at the foot when there is one this app can show whole (Uni's prepared reply)
    const reply = openDraft && footDraft && draftEditable(footDraft) ? () => openDraft(footDraft) : replyOwn;
    // Later is the flag on every message of the thread (so no older message keeps it in the Inbox); back clears it
    const laterIds = real.map((m) => m.id);
    const leavesList = (on: boolean) => (on ? place === "inbox" : place === "later");
    return {
      busy,
      problem: actionProblem,
      reply,
      replyOwn,
      markUnread: mark && newest ? () => void act("mark it unread", () => invoke("mail_mark_seen", { accountId: o.accountId, emailIds: [newest.id], seen: false }), () => { markShown(o, [newest.id], true); void loadOverview(); }) : null,
      markRead: mark ? () => { const ids = real.filter((m) => m.unread).map((m) => m.id); void act("mark it read", () => invoke("mail_mark_seen", { accountId: o.accountId, emailIds: ids, seen: true }), () => { markShown(o, ids, false); void loadOverview(); }); } : null,
      later: can(acct, "flag") && own && laterIds.length > 0 ? () => {
        const on = !flagged, ids = on ? laterIds : flaggedIds;
        void act(on ? "put it off for later" : "bring it back", () => invoke("mail_flag", { accountId: o.accountId, emailIds: ids, flagged: on }), () => {
          setFlag(ids, on); setLaterCount((n) => Math.max(0, n + (on ? 1 : -1)));
          if (leavesList(on)) leaveThread(o);
          if (overviewRef.current) void loadLater(overviewRef.current);
        });
      } : null,
      laterLabel: flagged ? (inInbox.length > 0 ? "Back to Inbox" : "Not later") : "Later",
      archive: can(acct, "archive") && inInbox.length > 0 ? () => void act("archive it", async () => {
        await invoke("mail_archive", { accountId: o.accountId, emailIds: inInbox });
        // done with it: it leaves Later too
        if (flagged && can(acct, "flag")) await invoke("mail_flag", { accountId: o.accountId, emailIds: flaggedIds, flagged: false });
      }, () => {
        leaveThread(o);
        if (flagged) setLaterCount((n) => Math.max(0, n - 1));
        void loadOverview().then((ov) => { if (ov) void loadLater(ov); });
      }) : null,
      openDraft,
    };
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
  const submitSearch = (e: FormEvent) => { e.preventDefault(); runSearch(typed.trim()); };
  const waitingIn = (id: string) => (held[id] ?? []).filter(waiting).length;
  const uniAcct = overview?.accounts.find((a) => approvalOffered(a));
  const tabs = overview ? mailTabs(overview, { later: laterCount, waiting: uniAcct ? waitingIn(uniAcct.id) : 0 }) : [];
  const title = overview ? placeTitle(place, overview, query, files) : "";
  const openAcct = open ? accountOf(open.accountId) : undefined;
  const waitingPlace = place === "waiting" && !query;
  const waitingAcct = waitingPlace ? uniAcct : undefined;
  const heldShown = waitingAcct ? held[waitingAcct.id] ?? [] : [];
  const heldOpen = waitingAcct && openHeld ? heldShown.find((e) => e.item.op_id === openHeld) : undefined;
  const backWord = query ? "Search" : tabs.find((t) => t.id === place)?.label ?? "Mail";

  const composing = !!compose && !compose.hidden;
  const composeHere = composing && !!compose.thread && !!thread && compose.thread === `${thread.account_id}/${thread.thread_id}`;
  const composeAlone = composing && !compose.thread;
  const actions = thread && openAcct ? threadActions(thread, openAcct) : null;
  // a reply opened under its thread comes into view (the conversation stays above it)
  const composeKeyHere = composeHere ? compose.key : null;
  useEffect(() => {
    if (composeKeyHere == null) return;
    requestAnimationFrame(() => {
      // the reply comes up with the end of the message it answers still in sight above it
      const wrap = document.querySelector<HTMLElement>(".mail-compose-wrap.inline"), box = wrap?.closest<HTMLElement>(".mail-read-scroll");
      if (wrap && box) box.scrollTop += wrap.getBoundingClientRect().top - box.getBoundingClientRect().top - Math.min(220, box.clientHeight * 0.3);
    });
  }, [composeKeyHere]);
  return <section className="mail mail-v2" aria-label="Mail" data-pane={pane} data-composing={composing && pane === "thread" ? "true" : undefined}>
    {onBack && <header className="note-bar mail-bar"><button className="note-action" onClick={onBack}>← {backTo}</button></header>}
    {boxesProblem && !overview ? <div className="mail-scroll"><Problem p={boxesProblem} onRetry={() => void loadOverview()} /></div>
    : !overview ? <p className="mail-loading" role="status">Loading mail…</p>
    : <>
      <PlaceTabs tabs={tabs} place={place} onPick={pick} onRefresh={() => void refresh()} refreshing={listLoading} />
      {boxesProblem && <p className="mail-note mail-strip-note" role="status">Couldn't refresh Mail. <button type="button" className="cp-retry" onClick={() => void refresh()}>Retry</button></p>}
      <div className="mail-panes">
        <section className="mail-list" id="mail-list" aria-label={title}>
          <form className="mail-list-search" role="search" onSubmit={submitSearch}>
            <label className="mail-search"><span className="mail-sr">Search mail</span>
              <input ref={search} type="search" value={typed} placeholder={place === "uni" || place === "waiting" ? "Search Uni's mail" : place === "later" ? "Search Later" : "Search your mail"} aria-label="Search mail"
                onChange={(e) => setTyped(e.target.value)} enterKeyHint="search" />
            </label>
            {!waitingPlace && <button type="button" className={`note-quiet mail-files ${files ? "on" : ""}`} aria-pressed={files} onClick={toggleFiles}>Files</button>}
            {senders.length > 0 && <button type="button" className="send mail-new" onClick={newMessage}>New</button>}
          </form>
          {!writesOffered(overview) && <p className="mail-note mail-readonly">{overview.login} · reading only</p>}
          {(query || files) && <p className="mail-list-title" aria-live="polite"><strong>{title}</strong>{list?.total != null && <small> · {list.total} {list.total === 1 ? "thread" : "threads"}</small>}</p>}
          {compose?.hidden && <button type="button" className="mail-resume" onClick={resume}>✎ A message in progress · Resume</button>}
          {pending.length > 0 && !composing && <div className="mail-pending" role="status">
            <span>{pending.length === 1 ? "A message you sent hasn't confirmed yet." : `${pending.length} messages you sent haven't confirmed yet.`} None goes out twice.</span>
            {pending.some((p) => can(accountOf(p.account_id), "send.check"))
              ? <button type="button" className="note-action" onClick={() => void checkPending()}>Check</button>
              : <><button type="button" className="note-action" disabled>Check</button><small className="mail-note">The mail bridge doesn't offer checking sends now; they stay listed.</small></>}
          </div>}
          {pendingNote && <p className="mail-note mail-pending-note" role="status">{pendingNote}</p>}
          {waitingPlace ? <div className="mail-scroll">
            {heldProblem && <Problem p={heldProblem} onRetry={() => overview && void loadHeld(overview)} />}
            {waitingAcct && !can(waitingAcct, "send.parked") && <p className="mail-note mail-held-unlisted" role="note">This mail bridge can't list Uni's held sends yet. Each one is also a task for you; ask #systems.</p>}
            {heldShown.length === 0 && !heldProblem && waitingAcct && can(waitingAcct, "send.parked") && <p className="empty mail-empty">{heldLoading ? "Loading…" : "Nothing from Uni is waiting for you."}</p>}
            {heldShown.length > 0 && <ul className="mail-rows" aria-label="Held sends">{heldShown.map((e) => <HeldRow key={e.item.op_id} e={e} selected={openHeld === e.item.op_id}
              onOpen={() => { const c = composeRef.current; if (c && !c.hidden) setCompose({ ...c, hidden: true }); threadSeq.current++; setOpen(null); setThread(null); setOpenHeld(e.item.op_id); setPane("thread"); }} />)}</ul>}
          </div>
          : <div className="mail-scroll">
            {listProblem && <Problem p={listProblem} onRetry={() => void loadList(listKey, sourcesNow(overview), query, null)} />}
            {!listProblem && !list && listLoading && <p className="mail-loading" role="status">{query ? "Searching…" : "Loading…"}</p>}
            {list && list.threads.length === 0 && !listProblem && <p className="empty mail-empty">{query ? `Nothing matches “${query}”.` : files ? "No mail with files here." : place === "inbox" ? "Nothing new. The Inbox is clear." : place === "later" ? "Nothing put off for later." : "Nothing here."}</p>}
            {/* a row is drawn only for an account the session names */}
            {list && list.threads.length > 0 && <ul className="mail-rows">{list.threads.flatMap((t) => accountOf(t.account_id) ? [<ThreadRow key={`${t.account_id}/${t.thread_id}`} t={t} place={place}
              note={notes[`${t.account_id}/${t.email_id}`] ?? null} selected={open?.accountId === t.account_id && open.threadId === t.thread_id} onOpen={() => openThread(t)} />] : [])}</ul>}
            {list?.more && <p className="mail-more"><button type="button" className="note-quiet" disabled={listLoading} onClick={() => void loadList(listKey, list.next, query, list)}>{listLoading ? "Loading…" : "Load older"}</button></p>}
          </div>}
        </section>
        <section className="mail-read" aria-label={thread && openAcct && !composeAlone && !(heldOpen && waitingAcct && !composing) ? `Thread: ${threadSubject(thread)}` : "Reading"}>
          {heldOpen && waitingAcct && !composing ? <HeldView key={`${heldOpen.item.op_id}/${heldOpen.item.fingerprint ?? ""}`} e={heldOpen} acct={waitingAcct} onBack={() => setPane("list")}
              onDecide={(kind) => decideHeld(waitingAcct.id, heldOpen.item, kind)} />
          : <>
            {thread && openAcct && actions && !composeAlone && <ThreadBar t={thread} backTo={backWord} onBack={() => setPane("list")} actions={actions} />}
            {actions?.problem && !composeAlone && <p className="mail-action-problem" role="alert">{actions.problem}</p>}
            <div className={`mail-read-scroll ${composeAlone ? "alone" : ""}`}>
              {composeAlone ? null
              : thread && openAcct && actions ? <div className="mail-thread" key={`${thread.account_id}/${thread.thread_id}`}>
                  {compose?.hidden && <button type="button" className="mail-resume" onClick={resume}>✎ A message in progress · Resume</button>}
                  <ThreadBody t={thread} acct={openAcct} overview={overview} note={threadNote} actions={actions} composingHere={composeHere} />
                </div>
              : threadProblem ? <div><button type="button" className="note-action mail-thread-back" onClick={() => setPane("list")}>← {backWord}</button><Problem p={threadProblem} onRetry={() => open && void loadThread(open)} /></div>
              : open && !openAcct ? <div><button type="button" className="note-action mail-thread-back" onClick={() => setPane("list")}>← {backWord}</button><p className="empty mail-pick">This mailbox isn't shared with this device any more.</p></div>
              : open ? <p className="mail-loading" role="status">Opening…</p>
              : !composing ? <p className="empty mail-pick">{waitingPlace ? (heldShown.length ? "Pick a held send to see what it sends." : "Nothing from Uni is waiting for you.") : "Pick a thread to read it."}</p>
              : null}
              {compose && <div className={`mail-compose-wrap ${composeHere ? "inline" : ""}`} hidden={compose.hidden || (!!compose.thread && !composeHere)}>
                {composeNote && !compose.hidden && <p className="mail-note mail-compose-note" role="status">{composeNote}</p>}
                <Composer key={compose.key} composeKey={compose.key} overview={overview} start={compose.start} snapshot={compose.snapshot} onSnapshot={keepSnapshot}
                  onClose={(changed) => endCompose(changed, compose.key)} onDone={() => endCompose(true, compose.key)} onPendingChange={pendingChanged} /></div>}
            </div>
          </>}
        </section>
      </div>
    </>}
  </section>;
}
