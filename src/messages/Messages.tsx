// T-278 Messages: you and other people, next to Mail and Calendar (prototype, behind the app's `messages` feature).
// Conversations on our own Matrix homeserver, and later the Telegram and Signal chats its bridges bring in. The room
// list and one conversation side by side (one at a time on a phone), a composer under it, and live receive: a message
// arrives while you look. Agents don't read any of this: the thread says so, and "bring Uni in" is designed (T-278
// DESIGN.md), not built. Shape and word before colour, so it reads on the Daylight, where nothing moves.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import { closeRoom, draftFor, draftsEpoch, forgetPlace, join, keepDraft, keepReadSpot, lastOpen, lastPane, lastTab, links as readLinks, markRead, older, onUpdate, openRoom, readSpot, rememberOpen, rememberPane, rememberTab, unsentBack, rooms as readRooms, send, signIn, signInDevice, signOut, status as readStatus } from "./messagesDoor.ts";
import { applyLink, mergeLinks, applyOpened, applyTimeline, asMessagesErr, initials, messageTabs, networkInfo, networkOf, previewLine, problemText, rowTime, sendWords, shownItems, shownTab, statusWords, tabName, tabRows, timeLabel, type LinkRow, type MessagesErr, type RoomRow, type Status, type Tab, type TabId, type Thread } from "./messagesView.ts";
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

function RoomItem({ r, selected, now, mark, onOpen }: { r: RoomRow; selected: boolean; now: number; mark: boolean; onOpen: () => void }) {
  const net = networkInfo(networkOf(r));
  return <li><button type="button" className={`msgs-row ${selected ? "selected" : ""} ${r.unread > 0 ? "unread" : ""} ${r.invited ? "invite" : ""}`} aria-current={selected ? "page" : undefined} onClick={onOpen}>
    <span className="msgs-avatar" aria-hidden="true">{initials(r.name)}</span>
    <span className="msgs-row-text">
      <span className="msgs-row-top"><strong className="msgs-row-name">{r.name}</strong>
        {mark && net.mark && <><span className="msgs-net" aria-hidden="true">{net.mark}</span><span className="msgs-sr">on {net.label}</span></>}
        <time>{rowTime(r.ts, now)}</time></span>
      <span className="msgs-row-bottom">
        {r.invited && <span className="msgs-tag">INVITE</span>}
        <span className="msgs-row-preview">{previewLine(r)}</span>
        {r.unread > 0 && <span className="msgs-count" aria-label={`${r.unread} unread`}>{r.unread}</span>}
      </span>
    </span>
  </button></li>;
}

/** T-310: All, then one tab per network; "Link another network" quietly at the end. Arrow keys move along the tabs. */
function TabStrip({ tabs, tab, onPick, onLink }: { tabs: Tab[]; tab: TabId; onPick: (t: TabId) => void; onLink: () => void }) {
  const strip = useRef<HTMLDivElement | null>(null);
  // the tab you're on stays in sight on a phone's sideways strip
  useLayoutEffect(() => {
    const el = strip.current, on = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !on) return;
    // the strip alone scrolls: nothing around it moves
    const left = on.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft, right = left + on.offsetWidth;
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  }, [tab]);
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = tabs.findIndex((t) => t.id === tab);
    const next = tabs[(at + step + tabs.length) % tabs.length];
    onPick(next.id);
    strip.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };
  return <div className="msgs-tabs" ref={strip}>
    <div className="msgs-tablist" role="tablist" aria-label="Networks" onKeyDown={key}>
      {tabs.map((t) => <button key={t.id} type="button" role="tab" data-tab={t.id} aria-selected={t.id === tab} aria-controls="msgs-list" tabIndex={t.id === tab ? 0 : -1}
        aria-label={tabName(t)} className={`msgs-tab ${t.attention ? "attention" : ""}`} onClick={() => onPick(t.id)}>
        <span>{t.label}</span>
        {t.waiting > 0 && <span className="msgs-tab-count" aria-hidden="true">{t.waiting}</span>}
        {t.attention && <span className="msgs-tab-alert" aria-hidden="true">!</span>}
      </button>)}
    </div>
    <button type="button" className="note-quiet msgs-link-open" aria-label="Link another network" onClick={onLink}>+ Link<span className="msgs-link-more"> another network</span></button>
  </div>;
}

function ThreadView({ room, thread, now, visible, onBack, onProblem }: { room: RoomRow; thread: Thread; now: number; visible: boolean; onBack: () => void; onProblem: (p: MessagesErr | null) => void }) {
  // T-294: the draft and the spot this conversation was left with come back with it
  const [draft, setDraft] = useState(() => draftFor(room.id));
  useEffect(() => keepDraft(room.id, draft), [room.id, draft]);
  const [atStart, setAtStart] = useState(false);
  /** Sends go one after another, in the order written; typing never waits for them. */
  const sending = useRef<Promise<unknown>>(Promise.resolve());
  const [loadingOlder, setLoadingOlder] = useState(false);
  const log = useRef<HTMLDivElement | null>(null);
  const leftAt = useRef(readSpot(room.id));
  const stuck = useRef(leftAt.current === undefined);
  const items = thread.items;
  const shown = items ? shownItems(items, now) : [];
  const lastOwn = items ? [...items].reverse().find((m) => m.own) : undefined;
  // a reply goes out the way the conversation came in: the composer says which network
  const net = networkOf(room);
  const to = net === "matrix" || net === "other" ? `Message ${room.name}` : `Message ${room.name} on ${networkInfo(net).label}`;

  // follow the conversation while you're at its end; leave it alone while you read back
  useLayoutEffect(() => {
    const el = log.current;
    if (!el || !items?.length) return;
    const left = leftAt.current;
    const at = left && el.querySelector<HTMLElement>(`[data-key="${CSS.escape(left.key)}"]`);
    if (at) { el.scrollTop += at.getBoundingClientRect().top - el.getBoundingClientRect().top - left.offset; leftAt.current = undefined; }
    // the message it was left at isn't in this window (only the newest page came back): the end, as a fresh open
    else if (left) { leftAt.current = undefined; stuck.current = true; el.scrollTop = el.scrollHeight; }
    else if (stuck.current) el.scrollTop = el.scrollHeight;
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
    const at = draftsEpoch();
    sending.current = sending.current.then(() => send(room.id, body)).then(() => onProblem(null), (err) => {
      // signed out or forgotten since it was sent: the words belonged to that account, so they are not put back anywhere
      if (!unsentBack(room.id, body, at)) return;
      onProblem(asMessagesErr(err));
      // what didn't go comes back to the composer, unless something new is being written there (kept for the conversation even if it was left meanwhile)
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
        onScroll={(e) => {
          const el = e.currentTarget, fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight;
          stuck.current = fromEnd < 48;
          if (leftAt.current !== undefined) return;
          const top = el.getBoundingClientRect().top;
          const first = stuck.current ? undefined : [...el.querySelectorAll<HTMLElement>("[data-key]")].find((m) => m.getBoundingClientRect().bottom > top);
          keepReadSpot(room.id, first ? { key: first.dataset.key!, offset: first.getBoundingClientRect().top - top } : null);
        }}>
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
        <label className="msgs-sr" htmlFor="msgs-draft">{to}</label>
        <textarea id="msgs-draft" value={draft} rows={1} placeholder={to} onChange={(e) => setDraft(e.target.value)} onKeyDown={key} enterKeyHint="send" />
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
  /** T-310: the tab picked on this device; shown while it has a tab (else All, without forgetting the pick). */
  const [tabPick, setTabPick] = useState<string | null>(lastTab);
  /** Each tab's place in the list, for this session. */
  const listAt = useRef(new Map<string, number>());
  const listEl = useRef<HTMLDivElement | null>(null);
  const seq = useRef(0);
  const openId = useRef<string | null>(null);
  /** Moves on when the account ends (or Messages closes): an answer asked for before then is dropped. */
  const gen = useRef(0);
  const phone = useMedia(PHONE);

  const open = useCallback(async (roomId: string, show = true) => {
    const prev = openId.current;
    if (prev && prev !== roomId) void closeRoom(prev).catch(() => {});
    const n = ++seq.current;
    openId.current = roomId;
    rememberOpen(roomId);
    setThread({ roomId, seq: n, items: null });
    if (show) { setPane("thread"); if (matchMedia(PHONE).matches) rememberPane("thread"); }
    try { const rows = await openRoom(roomId); setThread((t) => applyOpened(t, roomId, n, rows)); setProblem(null); }
    catch (err) { setProblem(asMessagesErr(err)); }
  }, []);

  /** The account is gone, whoever ended it (the Sign out button, or the homeserver): everything Messages held for it goes the one way
   * Forget takes too (forgetPlace: the open room, the pane, the tab, the drafts and spots, and the drafts' epoch), and so does what is
   * on screen. */
  const accountGone = useCallback(() => {
    gen.current++;
    setList(null); setThread(null); setPane("list"); setLinkView(false); setLinkRows(null); setTabPick(null);
    listAt.current.clear();
    openId.current = null;
    forgetPlace();
  }, []);

  /** T-310: how each network's link stands, asked once as Messages opens (and as the app comes back), so a link to redo shows its mark
   * and a linked network with no chats has its tab without the Link screen being opened. Quiet: a failure shows nothing (the core asks
   * each bridge at most once a minute; its answers come as `link` updates). */
  const loadLinks = useCallback(() => {
    const g = gen.current;
    readLinks().then((snap) => { if (g === gen.current) setLinkRows((cur) => mergeLinks(snap, cur)); }, () => {});
  }, []);

  const loadRooms = useCallback(async () => {
    try {
      const r = await readRooms();
      setList(r);
      const last = lastOpen();
      // T-294: a phone comes back to the conversation it was showing, not the list
      if (!openId.current && last && r.some((x) => x.id === last)) {
        if (!matchMedia(PHONE).matches) void open(last, false);
        else if (lastPane() === "thread") void open(last);
      }
    } catch (err) { setProblem(asMessagesErr(err)); }
  }, [open]);

  useEffect(() => {
    let alive = true;
    // live receive: the room list, the open room's messages and the sync's status, as they change
    const off = onUpdate((u) => {
      if (!alive) return;
      if (u.kind === "status") { setStatus(u.status); if (u.status.state === "signed_out") accountGone(); }
      else if (u.kind === "rooms") setList(u.rooms);
      else if (u.kind === "link") setLinkRows((rows) => applyLink(rows, u.link));
      else setThread((t) => applyTimeline(t, u.room_id, u.items));
    });
    void (async () => {
      try {
        const s = await readStatus();
        if (!alive) return;
        setStatus(s);
        if (s && s.state !== "signed_out") { loadLinks(); await loadRooms(); }
        else accountGone();
      } catch (err) { if (alive) setProblem(asMessagesErr(err)); }
    })();
    const tick = window.setInterval(() => setNow(Date.now()), 60_000);
    // the app put away and back: ask again (still quiet, and at most once a minute per bridge in the core)
    const back = () => { if (document.visibilityState === "visible") void readStatus().then((s) => { if (alive && s && s.state !== "signed_out") loadLinks(); }, () => {}); };
    document.addEventListener("visibilitychange", back);
    return () => { alive = false; gen.current++; off(); window.clearInterval(tick); document.removeEventListener("visibilitychange", back); if (openId.current) void closeRoom(openId.current).catch(() => {}); };
  }, [loadRooms, loadLinks, accountGone]);

  const signedIn = !!status && status.state !== "signed_out";
  const openRow = thread ? list?.find((r) => r.id === thread.roomId) ?? null : null;
  const out = async () => { try { setStatus(await signOut()); accountGone(); } catch (err) { setProblem(asMessagesErr(err)); } };
  const tabs = list ? messageTabs(list, linkRows) : [];
  const tab = shownTab(tabPick, tabs);
  const rows = list ? tabRows(list, tab) : [];
  const current = tabs.find((t) => t.id === tab);
  const pickTab = (t: TabId) => { setTabPick(t); rememberTab(t); };
  // back on a tab, or back to the list on a phone: where that tab's list was left
  useLayoutEffect(() => { if (listEl.current) listEl.current.scrollTop = listAt.current.get(tab) ?? 0; }, [tab, pane, linkView, !!list]);

  return <section className={`msgs ${still ? "msgs-still" : ""}`} aria-label="Messages" data-pane={pane}>
    <header className="note-bar msgs-bar">
      <button className="note-action" onClick={onBack}>← {backTo}</button>
      <span className="msgs-title"><strong>Messages</strong>{signedIn && <small className="msgs-account">{status?.user_id} · <span className={`msgs-live st-${status?.state}`} role="status">{statusWords(status)}</span></small>}</span>
      {signedIn ? <button className="note-quiet" onClick={() => void out()}>Sign out</button> : <span className="msgs-bar-gap" />}
    </header>
    {!status && !problem ? <p className="msgs-loading" role="status">Opening Messages…</p>
    : !signedIn ? <div className="msgs-scroll">{problem && <p className="msgs-problem" role="alert">{problemText(problem)}</p>}{status?.error && <p className="msgs-problem" role="status">{status.error}</p>}<SignIn onDone={(s) => { setStatus(s); loadLinks(); void loadRooms(); }} /></div>
    : linkView ? <LinkAccounts rows={linkRows} setRows={setLinkRows} onBack={() => setLinkView(false)} />
    : <div className="msgs-panes">
      {(!list || list.length > 0) && <TabStrip tabs={tabs} tab={tab} onPick={pickTab} onLink={() => setLinkView(true)} />}
      <nav className="msgs-rooms" aria-label="Conversations">
        <div className="msgs-scroll" id="msgs-list" role={list?.length ? "tabpanel" : undefined} aria-label={current ? `${current.id === "all" ? "All conversations" : current.label}` : undefined}
          ref={listEl} onScroll={(e) => listAt.current.set(tab, e.currentTarget.scrollTop)}>
          {!list ? <p className="msgs-loading" role="status">Loading conversations…</p>
            : list.length === 0 ? <div className="empty msgs-empty"><p>No conversations yet.</p><p>Bring in your chats from Signal, WhatsApp, Telegram and others.</p><button type="button" className="send" onClick={() => setLinkView(true)}>Link an account</button></div>
            : <>
              {current?.attention && <p className="msgs-attention" role="note">{current.label} needs linking again. <button type="button" className="note-action" onClick={() => setLinkView(true)}>Link again</button></p>}
              {rows.length === 0 ? <p className="empty msgs-tab-empty">Nothing from {current?.label ?? "here"} yet. Chats show here as they come in.</p>
                : <ul className="msgs-rows">{rows.map((r) => <RoomItem key={r.id} r={r} now={now} mark={tab === "all" && tabs.length > 2} selected={thread?.roomId === r.id} onOpen={() => void open(r.id)} />)}</ul>}
            </>}
        </div>
      </nav>
      <div className="msgs-read">
        {problem && <p className="msgs-problem" role="alert">{problemText(problem)} <button type="button" className="note-quiet" onClick={() => setProblem(null)}>Dismiss</button></p>}
        {thread && openRow ? <ThreadView key={thread.roomId} room={openRow} thread={thread} now={now} visible={!phone || pane === "thread"} onBack={() => { setPane("list"); rememberPane("list"); }} onProblem={setProblem} />
          : thread ? <p className="msgs-loading" role="status">Opening…</p>
          : <p className="empty msgs-pick">Pick a conversation.</p>}
      </div>
    </div>}
  </section>;
}
