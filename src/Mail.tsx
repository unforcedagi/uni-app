// Mail (T-45): a read-only inbox. Mailboxes, a newest-first list, and a reading pane. Every call goes to Rust, which
// signs it for the mail bridge; the webview never holds a mail credential. Nothing here sends, flags or deletes, and
// opening a message does not mark it read.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "./clipboard";
import { splitLinks } from "./areas/linkText";
import { formatSize } from "./media";
import {
  addressLine, hasMore, mailboxLabel, mailDate, mailDateLong, mailProblem, mailSrcdoc, senderLabel, subjectLabel,
  type MailAccount, type MailAttachment, type MailLink, type MailMessage, type MailProblem, type MessagePage, type MessageSummary,
} from "./mailCore";
import "./Mail.css";

type List = { mailbox: string; messages: MessageSummary[]; total: number | null };
/** Where you were in Mail: the view remounts each time it is opened, and comes back to the same mailbox and message. */
const remembered: { box: string | null; openId: string | null } = { box: null, openId: null };
/** Narrow screens show one pane at a time. */
type Pane = "boxes" | "list" | "message";

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

function PlainBody({ text }: { text: string }) {
  return <div className="mail-text">{splitLinks(text).map((part, i) => "url" in part
    ? <a key={i} href={part.url} title={part.url} onClick={(e) => { e.preventDefault(); openLink(part.url); }}>{part.url}</a>
    : <span key={i}>{part.text}</span>)}</div>;
}

function AttachmentRow({ a }: { a: MailAttachment }) {
  const [state, setState] = useState<"idle" | "opening" | "error">("idle");
  const [error, setError] = useState("");
  const name = a.name || "attachment";
  const open = async () => {
    setState("opening");
    try { await invoke("mail_attachment_open", { blobId: a.blob_id, name: a.name, mime: a.mime }); setState("idle"); }
    catch (e) { const p = mailProblem(e); setError(p.kind === "invalid" ? p.detail : p.title); setState("error"); }
  };
  return <li className="mail-attachment-item"><button type="button" className="attachment-file mail-attachment" disabled={state === "opening"} onClick={() => void open()} aria-label={`Open ${name}`}>
    <span aria-hidden="true">{a.mime === "application/pdf" ? "📄" : "📎"}</span><span className="attachment-name">{name}</span>
    <small>{state === "opening" ? "Opening…" : state === "error" ? "⚠ Not opened" : [formatSize(a.size), "Open"].filter(Boolean).join(" · ")}</small>
  </button>{state === "error" && <small className="mail-note" role="status">{error}</small>}</li>;
}

/** The frame runs no script, so its links can't be followed there: they are listed, and open in the browser. */
function LinkList({ links }: { links: MailLink[] }) {
  return <details className="mail-links"><summary>Links in this message ({links.length})</summary><ul>{links.map((l) => <li key={l.url}>
    <a href={l.url} title={l.url} onClick={(e) => { e.preventDefault(); openLink(l.url); }}>{l.text ? <><span>{l.text}</span> <small>{l.url}</small></> : l.url}</a>
  </li>)}</ul></details>;
}

function Reader({ m, onBack }: { m: MailMessage; onBack: () => void }) {
  // plain text first; the formatted (HTML) version on request, or when it is all there is
  const [formatted, setFormatted] = useState(!m.text && !!m.html);
  const showHtml = formatted && !!m.html;
  return <article className="mail-message" aria-label={subjectLabel(m.subject)}>
    <button type="button" className="note-action mail-back" onClick={onBack}>← Messages</button>
    <h2 className="mail-subject">{subjectLabel(m.subject)}</h2>
    <dl className="mail-headers">
      <dt>From</dt><dd>{addressLine(m.from) || "(no sender)"}</dd>
      {m.to.length > 0 && <><dt>To</dt><dd>{addressLine(m.to)}</dd></>}
      {m.cc.length > 0 && <><dt>Cc</dt><dd>{addressLine(m.cc)}</dd></>}
      <dt>Date</dt><dd>{mailDateLong(m.sent_at || m.received_at)}</dd>
    </dl>
    {m.attachments.length > 0 && <ul className="mail-attachments" aria-label="Attachments">{m.attachments.map((a) => <AttachmentRow key={a.blob_id} a={a} />)}</ul>}
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

export default function Mail({ onBack, backTo = "Uni" }: { onBack: () => void; backTo?: string }) {
  const [account, setAccount] = useState<MailAccount | null>(null);
  const [boxesProblem, setBoxesProblem] = useState<MailProblem | null>(null);
  const [box, setBox] = useState<string | null>(remembered.box);
  const [list, setList] = useState<List | null>(null);
  const [listProblem, setListProblem] = useState<MailProblem | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(remembered.openId);
  const [message, setMessage] = useState<MailMessage | null>(null);
  const [messageProblem, setMessageProblem] = useState<MailProblem | null>(null);
  const [pane, setPane] = useState<Pane>(remembered.openId ? "message" : "list");
  // a slow answer for a mailbox or message no longer shown is dropped
  const listSeq = useRef(0);
  const messageSeq = useRef(0);

  const loadBoxes = useCallback(async () => {
    setBoxesProblem(null);
    try {
      const a = await invoke<MailAccount>("mail_mailboxes");
      setAccount(a);
      setBox((cur) => (cur && a.mailboxes.some((b) => b.id === cur) ? cur : a.mailboxes[0]?.id ?? null));
    } catch (e) { setBoxesProblem(mailProblem(e)); }
  }, []);

  const loadList = useCallback(async (mailbox: string, position: number) => {
    const seq = ++listSeq.current;
    setListLoading(true);
    if (position === 0) setListProblem(null);
    try {
      const page = await invoke<MessagePage>("mail_messages", { mailbox, position });
      if (seq !== listSeq.current) return;
      setList((cur) => position > 0 && cur?.mailbox === mailbox
        ? { mailbox, total: page.total, messages: [...cur.messages, ...page.messages.filter((m) => !cur.messages.some((c) => c.id === m.id))] }
        : { mailbox, total: page.total, messages: page.messages });
      setListProblem(null);
    } catch (e) { if (seq === listSeq.current) setListProblem(mailProblem(e)); }
    finally { if (seq === listSeq.current) setListLoading(false); }
  }, []);

  const loadMessage = useCallback(async (id: string) => {
    const seq = ++messageSeq.current;
    setMessage(null); setMessageProblem(null);
    try {
      const m = await invoke<MailMessage>("mail_message", { id });
      if (seq === messageSeq.current) setMessage(m);
    } catch (e) { if (seq === messageSeq.current) setMessageProblem(mailProblem(e)); }
  }, []);

  useEffect(() => { void loadBoxes(); }, [loadBoxes]);
  useEffect(() => { if (box) { setList(null); void loadList(box, 0); } }, [box, loadList]);
  useEffect(() => { if (openId) void loadMessage(openId); }, [openId, loadMessage]);
  useEffect(() => { remembered.box = box; remembered.openId = openId; }, [box, openId]);

  const current = account?.mailboxes.find((b) => b.id === box) ?? null;
  // a message never changes on the server (read-only), so Refresh leaves an open one alone unless it failed
  const refresh = () => { void loadBoxes(); if (box) void loadList(box, 0); if (openId && messageProblem) void loadMessage(openId); };
  const pick = (id: string) => { messageSeq.current++; setBox(id); setOpenId(null); setMessage(null); setMessageProblem(null); setPane("list"); };
  const openMessage = (id: string) => { setOpenId(id); setPane("message"); };

  return <section className="mail" aria-label="Mail" data-pane={pane}>
    <header className="note-bar mail-bar">
      <button className="note-action" onClick={onBack}>← {backTo}</button>
      <span className="mail-title"><strong>Mail</strong>{account && <small className="mail-account" title="The mailbox the bridge reads">{account.account} · read-only</small>}</span>
      <button className="note-action" onClick={refresh} disabled={listLoading}>Refresh</button>
    </header>
    {boxesProblem && !account ? <div className="mail-scroll"><Problem p={boxesProblem} onRetry={() => void loadBoxes()} /></div>
    : !account ? <p className="mail-loading" role="status">Loading mail…</p>
    : <div className="mail-panes">
      <nav className="mail-boxes" aria-label="Mailboxes">
        {account.mailboxes.length === 0 && <p className="empty">No mailboxes.</p>}
        {account.mailboxes.map((b) => <button key={b.id} type="button" className={`mail-box ${b.id === box ? "selected" : ""}`} aria-current={b.id === box ? "page" : undefined} onClick={() => pick(b.id)}>
          <span>{mailboxLabel(b)}</span>{b.unread > 0 && <span className="mail-count" aria-label={`${b.unread} unread`}>{b.unread}</span>}
        </button>)}
        {boxesProblem && <p className="mail-note" role="status">Couldn't refresh the mailboxes. <button type="button" className="cp-retry" onClick={() => void loadBoxes()}>Retry</button></p>}
      </nav>
      <section className="mail-list" aria-label={current ? `${mailboxLabel(current)} messages` : "Messages"}>
        <div className="mail-list-head"><button type="button" className="note-quiet mail-boxes-open" onClick={() => setPane("boxes")}>☰ Mailboxes</button><strong>{current ? mailboxLabel(current) : ""}</strong>{list?.total != null && <small>{list.total} {list.total === 1 ? "message" : "messages"}</small>}</div>
        <div className="mail-scroll">
          {listProblem && <Problem p={listProblem} onRetry={() => box && void loadList(box, 0)} />}
          {!listProblem && !list && listLoading && <p className="mail-loading" role="status">Loading messages…</p>}
          {list && list.messages.length === 0 && !listProblem && <p className="empty mail-empty">No messages in {current ? mailboxLabel(current) : "this mailbox"}.</p>}
          {list && list.messages.length > 0 && <ul className="mail-rows">{list.messages.map((m) => <li key={m.id}>
            <button type="button" className={`mail-row ${m.unread ? "unread" : ""} ${m.id === openId ? "selected" : ""}`} aria-current={m.id === openId ? "true" : undefined} onClick={() => openMessage(m.id)}
              aria-label={`${m.unread ? "Unread. " : ""}${senderLabel(m.from)}: ${subjectLabel(m.subject)}`}>
              <span className="mail-row-top"><span className="mail-from">{m.unread && <span className="mail-dot" aria-hidden="true" />}{senderLabel(m.from)}</span><time dateTime={m.received_at}>{mailDate(m.received_at)}</time></span>
              <span className="mail-row-subject">{m.has_attachment && <span aria-label="Has attachment">📎 </span>}{subjectLabel(m.subject)}</span>
              <span className="mail-row-preview">{m.preview}</span>
            </button></li>)}</ul>}
          {list && hasMore({ total: list.total, loaded: list.messages.length }) && <p className="mail-more"><button type="button" className="note-quiet" disabled={listLoading} onClick={() => box && void loadList(box, list.messages.length)}>{listLoading ? "Loading…" : "Load older messages"}</button></p>}
        </div>
      </section>
      <section className="mail-read" aria-label="Message">
        {messageProblem ? <div className="mail-scroll"><button type="button" className="note-action mail-back" onClick={() => setPane("list")}>← Messages</button><Problem p={messageProblem} onRetry={() => openId && void loadMessage(openId)} /></div>
        : message ? <div className="mail-scroll"><Reader key={message.id} m={message} onBack={() => setPane("list")} /></div>
        : openId ? <p className="mail-loading" role="status">Opening…</p>
        : <p className="empty mail-pick">Pick a message to read it.</p>}
      </section>
    </div>}
  </section>;
}
