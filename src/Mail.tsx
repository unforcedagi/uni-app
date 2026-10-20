// Mail (T-45 v2): both mailboxes, read-only, in three panes (mailboxes | threads | thread) that stack on a phone. The
// owner's own account is YOU, the one shared with it is UNI, and every row, group and header says which, in a word and
// a shape (never colour alone: the Daylight is grayscale). Every call goes to Rust, which signs it for the mail bridge;
// the webview never holds a mail credential. Nothing here sends, flags, moves or deletes, and opening a thread does not
// mark it read. New and Reply are shown, disabled: sending comes later.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "./clipboard";
import { splitLinks } from "./areas/linkText";
import { formatSize } from "./media";
import {
  addressLine, allInboxesUnread, mailboxLabel, mailDate, mailDateLong, mailProblem, mailSrcdoc, scopeKey, scopeTitle, scopeValid, senderLabel,
  sourcesFor, subjectLabel, whoMail, whoTag,
  type AccountBoxes, type MailAttachment, type MailLink, type MailMessage, type MailProblem, type MailThread, type Overview, type Scope,
  type Source, type ThreadPage, type ThreadSummary, type Who,
} from "./mailCore";
import "./Mail.css";

type List = { key: string; threads: ThreadSummary[]; next: Source[]; more: boolean; total: number | null };
type Open = { accountId: string; threadId: string };
/** Where you were in Mail: the view remounts each time it is opened, and comes back to the same list and thread. */
const remembered: { scope: Scope; query: string; open: Open | null } = { scope: { kind: "all-inboxes" }, query: "", open: null };
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

/** YOU (filled) or UNI (dashed outline), with the address when `address` is given. */
function WhoTag({ who, address }: { who: Who; address?: string }) {
  return <span className={`mail-who who-${who}`} aria-label={address ? `${whoMail(who)}, ${address}` : whoMail(who)}>
    {whoTag(who)}{address && <small>{address}</small>}
  </span>;
}

/** New and Reply, shown so the place is learnt, and disabled until sending is built. `captioned` says so on the button. */
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

/** What a draft is, in words: whose, and that it was not sent. */
function DraftTag({ m, who }: { m: MailMessage; who: Who }) {
  if (who === "uni") return <p className="mail-draft-note"><span className="mail-draft-tag">UNI'S OWN DRAFT · NOT SENT</span><span>A draft in Uni's mail. You can read it here.</span></p>;
  if (m.uni_drafted) return <p className="mail-draft-note" role="note"><span className="mail-draft-tag">DRAFT · BY UNI · NOT SENT</span>
    <span>Uni wrote this in your Drafts. Uni can't send as you: nothing goes out unless you send it. {LATER} in this app.</span></p>;
  return <p className="mail-draft-note"><span className="mail-draft-tag">DRAFT · NOT SENT</span></p>;
}

/** Where a message of a thread lives, when that isn't somewhere you'd read it: a thread can reach into Junk and Trash. */
function placeOf(m: MailMessage, acct: AccountBoxes): "junk" | "trash" | null {
  const roles = m.mailbox_ids.map((id) => acct.mailboxes.find((b) => b.id === id)?.role);
  for (const r of ["junk", "trash"] as const) if (roles.length > 0 && roles.every((x) => x === r)) return r;
  return null;
}

/** One message of a thread: headers, the body (plain text first, the sealed HTML on request), attachments. */
function MessageCard({ m, acct, accountId }: { m: MailMessage; acct: AccountBoxes; accountId: string }) {
  const [formatted, setFormatted] = useState(!m.text && !!m.html);
  const showHtml = formatted && !!m.html;
  const who = acct.who;
  const place = placeOf(m, acct);
  return <article id={`mail-msg-${m.id}`} className={`mail-card ${m.draft ? "mail-card-draft" : ""} ${m.unread && !m.draft ? "mail-card-unread" : ""}`} aria-label={m.draft ? `Draft: ${subjectLabel(m.subject)}` : `Message from ${addressLine(m.from) || "(no sender)"}`}>
    {m.draft && <DraftTag m={m} who={who} />}
    {place && <p className="mail-draft-note mail-place"><span className="mail-draft-tag">{place === "junk" ? "IN JUNK" : "IN TRASH"}</span>
      <span>{place === "junk" ? "The server filed this message as junk. Treat its links and attachments with care." : "This message is in the Trash."}</span></p>}
    <dl className="mail-headers">
      <dt>From</dt><dd>{addressLine(m.from) || "(no sender)"}</dd>
      {m.to.length > 0 && <><dt>To</dt><dd>{addressLine(m.to)}</dd></>}
      {m.cc.length > 0 && <><dt>Cc</dt><dd>{addressLine(m.cc)}</dd></>}
      <dt>{m.draft ? "Saved" : "Date"}</dt><dd>{mailDateLong(m.sent_at || m.received_at)}{m.unread && !m.draft && <span className="mail-unread-word"> · unread</span>}</dd>
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

/** The thread: subject, whose mail it is, Uni's triage note (labelled as Uni's), the messages oldest first. */
function ThreadView({ t, acct, note, onBack }: { t: MailThread; acct: AccountBoxes; note: string | null; onBack: () => void }) {
  const real = t.messages.filter((m) => !m.draft);
  const subject = (real[0] ?? t.messages[0]).subject;
  const uniDraft = acct.who === "owner" ? [...t.messages].reverse().find((m) => m.draft && m.uni_drafted) : undefined;
  return <section className="mail-thread" aria-label={`Thread: ${subjectLabel(subject)}`}>
    <div className="mail-thread-bar">
      <button type="button" className="note-action mail-thread-back" onClick={onBack}>← Threads</button>
      <span className="mail-thread-tools"><LaterButton label="Reply" /><small className="mail-later-note">{LATER}</small></span>
    </div>
    <div className="mail-thread-scroll">
      <h2 className="mail-subject">{subjectLabel(subject.replace(/^re:\s*/i, ""))}</h2>
      <p className="mail-thread-where"><WhoTag who={acct.who} address={acct.name} /> <span>{acct.who === "uni" ? "In Uni's mail" : "In your mail"} · {real.length} {real.length === 1 ? "message" : "messages"}</span></p>
      {note && <p className="mail-triage" role="note"><span className="eyebrow">Uni's triage note</span><span>{note}</span></p>}
      {uniDraft && <button type="button" className="mail-draft-hint" onClick={() => document.getElementById(`mail-msg-${uniDraft.id}`)?.scrollIntoView({ block: "start" })}>
        <span className="mail-draft-tag small">DRAFT BY UNI</span> Uni left a draft reply at the end of this thread. Not sent.</button>}
      {t.messages.map((m) => <MessageCard key={m.id} m={m} acct={acct} accountId={t.account_id} />)}
    </div>
  </section>;
}

function ThreadRow({ t, who, note, selected, onOpen }: { t: ThreadSummary; who: Who; note: string | null; selected: boolean; onOpen: () => void }) {
  const party = t.draft ? `To ${senderLabel(t.to)}` : senderLabel(t.from);
  return <li><button type="button" className={`mail-row ${t.unread ? "unread" : ""} ${selected ? "selected" : ""}`} aria-current={selected ? "true" : undefined} onClick={onOpen}
    aria-label={`${t.unread ? "Unread. " : ""}${whoMail(who)}. ${t.draft ? (t.uni_drafted ? "Draft by Uni. " : "Draft. ") : ""}${party}: ${subjectLabel(t.subject)}`}>
    <span className="mail-row-top">
      <WhoTag who={who} />
      <span className="mail-from">{t.unread && <span className="mail-dot" aria-hidden="true" />}{t.draft ? <em>{party}</em> : party}{t.count > 1 && <small> · {t.count}</small>}</span>
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
  const [pane, setPane] = useState<Pane>(remembered.open ? "thread" : "list");
  const search = useRef<HTMLInputElement>(null);
  // a slow answer for a list or thread no longer shown is dropped
  const listSeq = useRef(0);
  const threadSeq = useRef(0);
  /** The list being shown (scope and search): notes for it are kept while it pages, dropped when it changes. */
  const shownKey = useRef("");

  /** The accounts and their mailboxes. What was shown from an account no longer in the session goes with it. */
  const loadOverview = useCallback(async (): Promise<Overview | null> => {
    setBoxesProblem(null);
    try {
      const o = await invoke<Overview>("mail_overview");
      const known = (id: string) => o.accounts.some((a) => a.id === id);
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

  /** Uni's notes for these rows, one call per account. Each answer replaces what was shown for those rows, so a note
   *  Uni removed goes on Refresh. Display only: a failure shows no notes for those rows. */
  const loadNotes = useCallback(async (threads: ThreadSummary[], key: string) => {
    const by = new Map<string, string[]>();
    for (const t of threads) by.set(t.account_id, [...(by.get(t.account_id) ?? []), t.email_id]);
    for (const [accountId, emailIds] of by) {
      const got = await invoke<Record<string, string>>("mail_triage", { accountId, emailIds }).catch(() => ({} as Record<string, string>));
      if (key !== shownKey.current) return;
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
      void loadNotes(page.threads, key);
    } catch (e) { if (seq === listSeq.current) setListProblem(mailProblem(e)); }
    finally { if (seq === listSeq.current) setListLoading(false); }
  }, [loadNotes]);

  const loadThread = useCallback(async (o: Open) => {
    const seq = ++threadSeq.current;
    setThread(null); setThreadProblem(null); setThreadNote(null);
    try {
      const t = await invoke<MailThread>("mail_thread", { accountId: o.accountId, threadId: o.threadId });
      if (seq !== threadSeq.current) return;
      setThread(t);
      const got = await invoke<Record<string, string>>("mail_triage", { accountId: t.account_id, emailIds: t.messages.map((m) => m.id) }).catch(() => ({} as Record<string, string>));
      if (seq !== threadSeq.current) return;
      const latest = [...t.messages].reverse().find((m) => got[m.id]);
      setThreadNote(latest ? got[latest.id] : null);
    } catch (e) { if (seq === threadSeq.current) setThreadProblem(mailProblem(e)); }
  }, []);

  const listKey = overview ? `${scopeKey(scope)}?${query}` : "";
  useEffect(() => { void loadOverview(); }, [loadOverview]);
  useEffect(() => {
    if (!overview) return;
    setList((cur) => (cur?.key === listKey ? cur : null));
    void loadList(listKey, sourcesFor(scope, overview, !!query), query, null);
    // the overview's counts change on Refresh; the list reloads only when what it shows changes
  }, [listKey, loadList]);
  useEffect(() => { if (open) void loadThread(open); }, [open, loadThread]);
  useEffect(() => { remembered.scope = scope; remembered.query = query; remembered.open = open; }, [scope, query, open]);

  const accountOf = (id: string) => overview?.accounts.find((a) => a.id === id);
  const refresh = async () => {
    const o = await loadOverview();
    // the list reloads with the accounts the bridge has now (a scope that went is reset, and its effect reloads)
    if (o && scopeValid(scope, o)) void loadList(listKey, sourcesFor(scope, o, !!query), query, null);
    if (o && open && o.accounts.some((a) => a.id === open.accountId)) void loadThread(open);
  };
  const pick = (s: Scope) => { threadSeq.current++; setScope(s); setQuery(""); setTyped(""); setOpen(null); setThread(null); setThreadProblem(null); setPane("list"); };
  const openThread = (t: ThreadSummary) => { setOpen({ accountId: t.account_id, threadId: t.thread_id }); setPane("thread"); };
  const submitSearch = (e: FormEvent) => { e.preventDefault(); setQuery(typed.trim()); setPane("list"); };
  const toSearch = () => { setPane("list"); requestAnimationFrame(() => search.current?.focus()); };
  const title = overview ? scopeTitle(scope, overview, query) : "";
  const unreadAll = overview ? allInboxesUnread(overview) : 0;
  const openAcct = open ? accountOf(open.accountId) : undefined;

  return <section className={`mail mail-a ${still ? "mail-still" : ""}`} aria-label="Mail" data-pane={pane}>
    <header className="note-bar mail-bar">
      <button className="note-action" onClick={onBack}>← {backTo}</button>
      <span className="mail-title"><strong>Mail</strong>{overview && <small className="mail-account" title="The address this device reads as">{overview.login} · read-only</small>}</span>
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
            {list?.total != null && <small>{list.total} {list.total === 1 ? "thread" : "threads"}</small>}
          </div>
          <form className="mail-list-search" role="search" onSubmit={submitSearch}>
            <label className="mail-search"><span className="mail-sr">Search mail</span>
              <input ref={search} type="search" value={typed} placeholder="Search mail" aria-label="Search mail"
                onChange={(e) => { setTyped(e.target.value); if (!e.target.value && query) setQuery(""); }} enterKeyHint="search" />
            </label>
            {query && <button type="button" className="note-quiet" onClick={() => { setTyped(""); setQuery(""); }}>Clear</button>}
            <span className="mail-list-new"><LaterButton label="New" className="send mail-new" captioned /></span>
          </form>
          <div className="mail-scroll">
            {listProblem && <Problem p={listProblem} onRetry={() => void loadList(listKey, sourcesFor(scope, overview, !!query), query, null)} />}
            {!listProblem && !list && listLoading && <p className="mail-loading" role="status">{query ? "Searching…" : "Loading threads…"}</p>}
            {list && list.threads.length === 0 && !listProblem && <p className="empty mail-empty">{query ? `Nothing matches “${query}”.` : "Nothing here."}</p>}
            {/* a row is drawn only with the tag of an account the session names: never a guessed YOU */}
            {list && list.threads.length > 0 && <ul className="mail-rows">{list.threads.flatMap((t) => { const a = accountOf(t.account_id); return a ? [<ThreadRow key={`${t.account_id}/${t.thread_id}`} t={t} who={a.who}
              note={notes[`${t.account_id}/${t.email_id}`] ?? null} selected={open?.accountId === t.account_id && open.threadId === t.thread_id} onOpen={() => openThread(t)} />] : []; })}</ul>}
            {list?.more && <p className="mail-more"><button type="button" className="note-quiet" disabled={listLoading} onClick={() => void loadList(listKey, list.next, query, list)}>{listLoading ? "Loading…" : "Load older threads"}</button></p>}
          </div>
        </section>
        <section className="mail-read" aria-label="Thread">
          {threadProblem ? <div className="mail-scroll"><button type="button" className="note-action mail-thread-back" onClick={() => setPane("list")}>← Threads</button><Problem p={threadProblem} onRetry={() => open && void loadThread(open)} /></div>
          : thread && openAcct ? <ThreadView key={`${thread.account_id}/${thread.thread_id}`} t={thread} acct={openAcct} note={threadNote} onBack={() => setPane("list")} />
          : open && !openAcct ? <div className="mail-scroll"><button type="button" className="note-action mail-thread-back" onClick={() => setPane("list")}>← Threads</button><p className="empty mail-pick">This mailbox isn't shared with this device any more.</p></div>
          : open ? <p className="mail-loading" role="status">Opening…</p>
          : <p className="empty mail-pick">Pick a thread to read it.</p>}
        </section>
      </div>
      <nav className="mail-thumb" aria-label="Mail actions">
        <button type="button" className="note-action" onClick={toSearch}>Search</button>
        <LaterButton label="New" className="send mail-new" captioned />
      </nav>
    </>}
  </section>;
}
