// T-278 Messages: you and other people, next to Mail and Calendar (prototype, behind the app's `messages` feature).
// Conversations on our own Matrix homeserver, and later the Telegram and Signal chats its bridges bring in. The room
// list and one conversation side by side (one at a time on a phone), a composer under it, and live receive: a message
// arrives while you look. Agents don't read any of this: the thread says so, and "bring Uni in" is designed (T-278
// DESIGN.md), not built. Shape and word before colour, so it reads on the Daylight, where nothing moves.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import { closeRoom, join, lastOpen, markRead, older, onUpdate, openRoom, rememberOpen, rooms as readRooms, send, signIn, signInDevice, signOut, status as readStatus } from "./messagesDoor.ts";
import { applyLink, applyOpened, applyTimeline, asMessagesErr, initials, previewLine, problemText, rowTime, sendWords, shownItems, statusWords, timeLabel, type LinkRow, type MessagesErr, type RoomRow, type Status, type Thread } from "./messagesView.ts";
import LinkAccounts from "./LinkAccounts.tsx";
import { enterInsertsNewline } from "../composerCore";
import "./Messages.css";

/** The Daylight's WebView says Android: nothing of Messages moves there. */
const still = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
const touchKeyboard = () => typeof navigator !== "undefined" && enterInsertsNewline(navigator.maxTouchPoints ?? 0, matchMedia("(pointer: coarse)").matches);
/** One pane at a time below this width (Messages.css). */
const PHONE = "(max-width: 699px)";

function useMedia(q: string): boolean {
  const sub = useCallback((f: () => void) => { const m = matchMedia(q); m.addEventListener("change", f); return () => m.removeEventListener("change", f); }, [q]);
  return useSyncExternalStore(sub, () => matchMedia(q).matches, () => false);
}

function SignIn({ onDone }: { onDone: (s: Status) => void }) {
  const [homeserver, setHomeserver] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<MessagesErr | null>(null);
  const run = async (f: () => Promise<Status>) => {
    setBusy(true); setProblem(null);
    try { const s = await f(); setPassword(""); onDone(s); }
    catch (err) { setProblem(asMessagesErr(err)); }
    finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void run(() => signIn(homeserver, user, password)); };
  return <div className="msgs-signin">
    <h1>Sign in to Messages</h1>
    <p className="msgs-note">Your conversations with people, on your own homeserver. They stay on this device and the homeserver: <strong>Uni can't read them.</strong></p>
    <button type="button" className="send msgs-signin-go" disabled={busy} onClick={() => void run(signInDevice)}>{busy ? "Signing in…" : "Sign in with this device"}</button>
    <p className="msgs-link-hint">Your box signs this device in with its own key. No password is typed or sent.</p>
    {problem && <p className="msgs-problem" role="alert">{problemText(problem)}</p>}
    <form className="msgs-signin-form" onSubmit={submit} aria-label="Sign in to Messages">
      <h2>Or with a password</h2>
      <label><span>Homeserver</span><input value={homeserver} onChange={(e) => setHomeserver(e.target.value)} placeholder="https://matrix.example.ts.net" autoComplete="url" inputMode="url" required /></label>
      <label><span>Username</span><input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" autoCapitalize="none" required /></label>
      <label><span>Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
      <button className="note-action msgs-signin-go" disabled={busy}>Sign in</button>
    </form>
  </div>;
}

function RoomItem({ r, selected, now, onOpen }: { r: RoomRow; selected: boolean; now: number; onOpen: () => void }) {
  return <li><button type="button" className={`msgs-row ${selected ? "selected" : ""} ${r.unread > 0 ? "unread" : ""} ${r.invited ? "invite" : ""}`} aria-current={selected ? "page" : undefined} onClick={onOpen}>
    <span className="msgs-avatar" aria-hidden="true">{initials(r.name)}</span>
    <span className="msgs-row-text">
      <span className="msgs-row-top"><strong className="msgs-row-name">{r.name}</strong><time>{rowTime(r.ts, now)}</time></span>
      <span className="msgs-row-bottom">
        {r.invited && <span className="msgs-tag">INVITE</span>}
        <span className="msgs-row-preview">{previewLine(r)}</span>
        {r.unread > 0 && <span className="msgs-count" aria-label={`${r.unread} unread`}>{r.unread}</span>}
      </span>
    </span>
  </button></li>;
}

function ThreadView({ room, thread, now, visible, onBack, onProblem }: { room: RoomRow; thread: Thread; now: number; visible: boolean; onBack: () => void; onProblem: (p: MessagesErr | null) => void }) {
  const [draft, setDraft] = useState("");
  const [atStart, setAtStart] = useState(false);
  /** Sends go one after another, in the order written; typing never waits for them. */
  const sending = useRef<Promise<unknown>>(Promise.resolve());
  const [loadingOlder, setLoadingOlder] = useState(false);
  const log = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);
  const items = thread.items;
  const shown = items ? shownItems(items, now) : [];
  const lastOwn = items ? [...items].reverse().find((m) => m.own) : undefined;

  // follow the conversation while you're at its end; leave it alone while you read back
  useLayoutEffect(() => {
    const el = log.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  // read up to here while it's on screen: not while a phone shows the list instead, nor in a hidden window
  const lastKey = items?.length ? items[items.length - 1].key : null;
  useEffect(() => {
    if (!lastKey || room.invited || !visible || document.visibilityState !== "visible") return;
    const t = window.setTimeout(() => void markRead(room.id).catch(() => {}), 600);
    return () => window.clearTimeout(t);
  }, [lastKey, room.id, room.invited, visible]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    stuck.current = true;
    sending.current = sending.current.then(() => send(room.id, body)).then(() => onProblem(null), (err) => {
      onProblem(asMessagesErr(err));
      // what didn't go comes back to the composer, unless something new is being written there
      setDraft((d) => (d.trim() ? d : body));
    });
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !touchKeyboard()) { e.preventDefault(); void submit(); }
  };
  const loadOlder = async () => {
    setLoadingOlder(true);
    try { setAtStart(await older(room.id)); } catch (err) { onProblem(asMessagesErr(err)); } finally { setLoadingOlder(false); }
  };

  return <section className="msgs-thread" aria-label={`Conversation: ${room.name}`}>
    <div className="msgs-thread-bar">
      <button type="button" className="note-action msgs-thread-back" onClick={onBack}>← Conversations</button>
      <h2 className="msgs-thread-name">{room.name}</h2>
      {room.encrypted ? <span className="msgs-tag" title="End-to-end encrypted between the people's devices">ENCRYPTED</span>
        : <span className="msgs-tag msgs-tag-open" title="Not end-to-end encrypted: the homeserver can read it">NOT ENCRYPTED</span>}
    </div>
    <p className="msgs-private" role="note"><span className="msgs-tag msgs-tag-private">PRIVATE</span> Uni can't read this conversation.</p>
    {room.invited ? <div className="msgs-invite">
      <p>{room.inviter ? `${room.inviter} invited you to talk.` : "You're invited to this conversation."}</p>
      <button type="button" className="send" onClick={() => void join(room.id).catch((err) => onProblem(asMessagesErr(err)))}>Accept</button>
    </div>
    : <>
      <div className="msgs-log" ref={log} role="log" aria-label={`Messages with ${room.name}`} aria-live="polite"
        onScroll={(e) => { const el = e.currentTarget; stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
        {items && !atStart && items.length > 0 && <p className="msgs-older"><button type="button" className="note-quiet" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "Loading…" : "Load earlier messages"}</button></p>}
        {!items ? <p className="msgs-loading" role="status">Opening…</p>
          : items.length === 0 ? <p className="empty">No messages yet. Say hello.</p>
          : shown.map((s) => s.kind === "day" ? <p key={s.key} className="msgs-day">{s.label}</p>
            : <div key={s.key} className={`msgs-msg ${s.row.own ? "own" : "theirs"} ${s.first ? "first" : ""} ${s.last ? "last" : ""} kind-${s.row.kind} st-${s.row.state}`} data-key={s.row.key} data-encrypted={s.row.encrypted ? "true" : undefined}>
              {s.first && !s.row.own && <p className="msgs-from"><strong>{s.row.sender_name}</strong> <time>{timeLabel(s.row.ts)}</time></p>}
              {s.first && s.row.own && <p className="msgs-from"><time>{timeLabel(s.row.ts)}</time></p>}
              <p className="msgs-body">{s.row.kind === "emote" ? `* ${s.row.sender_name} ${s.row.body}` : s.row.body}{s.row.edited && <small className="msgs-edited"> (edited)</small>}</p>
              {s.row.own && s.row.key === lastOwn?.key && sendWords(s.row.state) && <p className="msgs-state">{sendWords(s.row.state)}</p>}
            </div>)}
      </div>
      <form className="msgs-compose" onSubmit={(e) => void submit(e)}>
        <label className="msgs-sr" htmlFor="msgs-draft">Message {room.name}</label>
        <textarea id="msgs-draft" value={draft} rows={1} placeholder={`Message ${room.name}`} onChange={(e) => setDraft(e.target.value)} onKeyDown={key} enterKeyHint="send" />
        <button className="send msgs-send" disabled={!draft.trim()}>Send</button>
      </form>
    </>}
  </section>;
}

export default function Messages({ backTo, onBack }: { backTo: string; onBack: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [list, setList] = useState<RoomRow[] | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [pane, setPane] = useState<"list" | "thread">("list");
  const [problem, setProblem] = useState<MessagesErr | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** The Link screen (T-282) in place of the conversations, and its cards as the bridges last said. */
  const [linkView, setLinkView] = useState(false);
  const [linkRows, setLinkRows] = useState<LinkRow[] | null>(null);
  const seq = useRef(0);
  const openId = useRef<string | null>(null);
  const phone = useMedia(PHONE);

  const open = useCallback(async (roomId: string, show = true) => {
    const prev = openId.current;
    if (prev && prev !== roomId) void closeRoom(prev).catch(() => {});
    const n = ++seq.current;
    openId.current = roomId;
    rememberOpen(roomId);
    setThread({ roomId, seq: n, items: null });
    if (show) setPane("thread");
    try { const rows = await openRoom(roomId); setThread((t) => applyOpened(t, roomId, n, rows)); setProblem(null); }
    catch (err) { setProblem(asMessagesErr(err)); }
  }, []);

  const loadRooms = useCallback(async () => {
    try {
      const r = await readRooms();
      setList(r);
      const last = lastOpen();
      if (!openId.current && last && r.some((x) => x.id === last) && !matchMedia(PHONE).matches) void open(last, false);
    } catch (err) { setProblem(asMessagesErr(err)); }
  }, [open]);

  useEffect(() => {
    let alive = true;
    // live receive: the room list, the open room's messages and the sync's status, as they change
    const off = onUpdate((u) => {
      if (!alive) return;
      if (u.kind === "status") setStatus(u.status);
      else if (u.kind === "rooms") setList(u.rooms);
      else if (u.kind === "link") setLinkRows((rows) => applyLink(rows, u.link));
      else setThread((t) => applyTimeline(t, u.room_id, u.items));
    });
    void (async () => {
      try {
        const s = await readStatus();
        if (!alive) return;
        setStatus(s);
        if (s && s.state !== "signed_out") await loadRooms();
      } catch (err) { if (alive) setProblem(asMessagesErr(err)); }
    })();
    const tick = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => { alive = false; off(); window.clearInterval(tick); if (openId.current) void closeRoom(openId.current).catch(() => {}); };
  }, [loadRooms]);

  const signedIn = !!status && status.state !== "signed_out";
  const openRow = thread ? list?.find((r) => r.id === thread.roomId) ?? null : null;
  const out = async () => { try { setStatus(await signOut()); setList(null); setThread(null); setLinkView(false); setLinkRows(null); openId.current = null; rememberOpen(null); } catch (err) { setProblem(asMessagesErr(err)); } };
  const linkButton = <button type="button" className="note-quiet msgs-link-open" onClick={() => setLinkView(true)}>Link an account</button>;

  return <section className={`msgs ${still ? "msgs-still" : ""}`} aria-label="Messages" data-pane={pane}>
    <header className="note-bar msgs-bar">
      <button className="note-action" onClick={onBack}>← {backTo}</button>
      <span className="msgs-title"><strong>Messages</strong>{signedIn && <small className="msgs-account">{status?.user_id} · <span className={`msgs-live st-${status?.state}`} role="status">{statusWords(status)}</span></small>}</span>
      {signedIn ? <button className="note-quiet" onClick={() => void out()}>Sign out</button> : <span className="msgs-bar-gap" />}
    </header>
    {!status && !problem ? <p className="msgs-loading" role="status">Opening Messages…</p>
    : !signedIn ? <div className="msgs-scroll">{problem && <p className="msgs-problem" role="alert">{problemText(problem)}</p>}{status?.error && <p className="msgs-problem" role="status">{status.error}</p>}<SignIn onDone={(s) => { setStatus(s); void loadRooms(); }} /></div>
    : linkView ? <LinkAccounts rows={linkRows} setRows={setLinkRows} onBack={() => setLinkView(false)} />
    : <div className="msgs-panes">
      <nav className="msgs-rooms" aria-label="Conversations">
        <div className="msgs-rooms-head"><strong>Conversations</strong>{list && <small>{list.length}</small>}{linkButton}</div>
        <div className="msgs-scroll">
          {!list ? <p className="msgs-loading" role="status">Loading conversations…</p>
            : list.length === 0 ? <div className="empty msgs-empty"><p>No conversations yet.</p><p>Bring in your chats from Signal, WhatsApp, Telegram and others.</p><button type="button" className="send" onClick={() => setLinkView(true)}>Link an account</button></div>
            : <ul className="msgs-rows">{list.map((r) => <RoomItem key={r.id} r={r} now={now} selected={thread?.roomId === r.id} onOpen={() => void open(r.id)} />)}</ul>}
        </div>
      </nav>
      <div className="msgs-read">
        {problem && <p className="msgs-problem" role="alert">{problemText(problem)} <button type="button" className="note-quiet" onClick={() => setProblem(null)}>Dismiss</button></p>}
        {thread && openRow ? <ThreadView key={thread.roomId} room={openRow} thread={thread} now={now} visible={!phone || pane === "thread"} onBack={() => setPane("list")} onProblem={setProblem} />
          : thread ? <p className="msgs-loading" role="status">Opening…</p>
          : <p className="empty msgs-pick">Pick a conversation.</p>}
      </div>
    </div>}
  </section>;
}
