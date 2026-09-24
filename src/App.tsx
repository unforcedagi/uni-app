import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type Room = { id: string; name: string; last_message: string | null; last_ts: number | null; mentions: boolean };
type Message = { ref: string; channel: string; author: string; author_name: string; ts: number; body: string; mentions_me: boolean; root: string | null; parent: string | null };
type SyncResult = { pubkey: string; total_items: number; channel_errors: Record<string, string>; truncated_channels: string[] };

const time = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const keyFor = (channel: string, root: string | null) => `${channel}:${root ?? "room"}`;

function App() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [channel, setChannel] = useState<string | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [identity, setIdentity] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const drafts = useRef(new Map<string, string>());
  const [address, setAddress] = useState("");
  const [addressOpen, setAddressOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("Loading cached conversations…");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const scrollEnd = useRef<HTMLDivElement>(null);

  const loadRooms = useCallback(async () => {
    const rows = await invoke<Room[]>("get_rooms");
    setRooms(rows);
    setChannel((current) => current && rows.some((r) => r.id === current) ? current : rows[0]?.id ?? null);
    setReady(true);
  }, []);

  const loadMessages = useCallback(async (selected: string, thread: string | null) => {
    const rows = await invoke<Message[]>("get_messages", { channel: selected, root: thread });
    setMessages(rows);
  }, []);

  const refresh = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatus("Connecting to Buzz…");
    setError(null);
    try {
      const result = await invoke<SyncResult>("refresh");
      setIdentity(result.pubkey);
      await loadRooms();
      const warnings = Object.entries(result.channel_errors).map(([id, reason]) => `${id.slice(0, 8)}: ${reason}`);
      if (result.truncated_channels.length) warnings.push("Some rooms have more history than the current 500-message backfill.");
      setStatus(warnings.length ? `Synced with warnings: ${warnings.join("; ")}` : `Synced · ${result.total_items} cached messages`);
    } catch (e) {
      setError(String(e));
      setStatus("Offline · showing cached messages");
    } finally { setBusy(false); }
  }, [busy, loadRooms]);

  useEffect(() => {
    let active = true;
    invoke<string>("get_identity").then((id) => { if (active) setIdentity(id); }).catch(() => {});
    loadRooms().then(() => { if (active) void refresh(); }).catch((e) => {
      if (active) { setError(String(e)); setStatus("Could not open local conversations"); setReady(true); }
    });
    return () => { active = false; };
    // Start only once; later refreshes are explicit or visibility-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  useEffect(() => {
    if (!channel) { setMessages([]); return; }
    let current = true;
    invoke<Message[]>("get_messages", { channel, root }).then((rows) => { if (current) setMessages(rows); }).catch((e) => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [channel, root, status]);

  useEffect(() => {
    if (!channel) { setAddress(""); return; }
    try { setAddress(localStorage.getItem(`uni-recipient:${channel}`) ?? ""); } catch { setAddress(""); }
  }, [channel]);

  function updateAddress(value: string) {
    setAddress(value);
    if (channel) try { localStorage.setItem(`uni-recipient:${channel}`, value); } catch { /* Storage can be unavailable. */ }
  }

  useEffect(() => { scrollEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages.length, channel, root]);

  function navigate(nextChannel: string | null, nextRoot: string | null) {
    if (channel) drafts.current.set(keyFor(channel, root), draft);
    setChannel(nextChannel);
    setRoot(nextRoot);
    setDraft(nextChannel ? drafts.current.get(keyFor(nextChannel, nextRoot)) ?? "" : "");
    setReplyTo(null);
    setError(null);
  }

  async function send() {
    if (!channel || sending || !draft.trim()) return;
    const snapshot = draft;
    const scope = keyFor(channel, root);
    const target = replyTo ?? (root ? messages[messages.length - 1]?.ref ?? root : null);
    setSending(true);
    setError(null);
    try {
      const sent = await invoke<Message>("post_message", {
        channel, body: snapshot, replyTo: target,
        recipients: address.trim() ? [address.trim()] : [],
      });
      // Do not erase text typed during an in-flight send or in another room.
      if (drafts.current.get(scope) === snapshot || (keyFor(channel, root) === scope && draft === snapshot)) {
        setDraft((current) => current === snapshot ? "" : current);
        drafts.current.set(scope, "");
      }
      setReplyTo(null);
      if (root && !messages.some((m) => m.ref === sent.ref)) setMessages((old) => [...old, sent]);
      else await loadMessages(channel, root);
      await loadRooms();
      setStatus("Message accepted by relay");
    } catch (e) { setError(String(e)); }
    finally { setSending(false); }
  }

  const currentRoom = rooms.find((r) => r.id === channel);
  const isThread = !!root;
  return <main className={`shell ${channel ? "in-room" : ""}`}>
    <aside className="rooms" aria-label="Conversations">
      <header className="rooms-header"><div><span className="eyebrow">BUZZ · PERSONAL</span><h1>Talk to Uni</h1></div><button className="icon-button" onClick={() => void refresh()} disabled={busy} aria-label="Refresh conversations">↻</button></header>
      <p className="connection" role="status">{status}</p>
      {identity && <p className="identity" title={identity}>Signed in as {identity.slice(0, 12)}…</p>}
      {!ready && <p className="empty">Loading…</p>}
      {ready && rooms.length === 0 && <p className="empty">No joined conversations cached. Refresh to connect with your personal Buzz key.</p>}
      <nav>{rooms.map((room) => <button key={room.id} className={`room ${channel === room.id ? "selected" : ""}`} onClick={() => navigate(room.id, null)} aria-current={channel === room.id ? "page" : undefined}>
        <span className="avatar">{room.name[0]?.toUpperCase() ?? "#"}</span><span className="room-text"><strong>{room.name}</strong><small>{room.last_message ?? "No messages yet"}</small></span>
        <span className="room-side"><time>{room.last_ts ? time(room.last_ts) : ""}</time>{room.mentions && <span className="mention-dot" aria-label="Mentioned in this room" />}</span>
      </button>)}</nav>
    </aside>
    <section className="conversation" aria-label={currentRoom ? `Conversation: ${currentRoom.name}` : "Conversation"}>
      {currentRoom ? <>
        <header className="conversation-header">
          <button className="back icon-button" onClick={() => isThread ? navigate(channel, null) : navigate(null, null)} aria-label={isThread ? "Back to room" : "Back to conversations"}>‹</button>
          <div><strong>{isThread ? `Thread in ${currentRoom.name}` : currentRoom.name}</strong><small>{isThread ? "Root and replies" : "Buzz conversation · cached locally"}</small></div>
          <button className="icon-button" onClick={() => void refresh()} disabled={busy} aria-label="Refresh messages">↻</button>
        </header>
        <div className="message-list" role="log" aria-label="Messages" aria-live="polite">
          {isThread && messages.length > 0 && !messages.some((m) => m.ref === root) && <p className="empty">Root message is not cached; showing replies we have.</p>}
          {messages.length === 0 && <p className="empty">{isThread ? "Thread not in local cache. Refresh to try again." : "No messages in this room yet."}</p>}
          {messages.map((m) => <article key={m.ref} className={`message ${m.author === identity ? "mine" : ""} ${m.mentions_me ? "highlight" : ""}`}>
            <span className="message-avatar" aria-hidden="true">{m.author_name[0]?.toUpperCase() ?? "?"}</span><div className="message-content"><div className="message-meta"><strong>{m.author_name}</strong><time>{time(m.ts)}</time></div><p>{m.body}</p>
              <div className="message-actions"><button onClick={() => setReplyTo(m.ref)} aria-label={`Reply to ${m.author_name}`}>Reply</button>{!isThread && <button onClick={() => navigate(channel, m.root ?? m.ref)} aria-label={`Open thread from ${m.author_name}`}>Thread ↗</button>}</div>
            </div>
          </article>)}<div ref={scrollEnd} />
        </div>
        <footer className="composer">
          {error && <p className="error" role="alert">{error}</p>}
          {replyTo && <div className="reply-banner">Replying to {messages.find((m) => m.ref === replyTo)?.author_name ?? "message"}<button onClick={() => setReplyTo(null)} aria-label="Cancel reply">×</button></div>}
          <div className="compose-destination">Sending to <strong>{currentRoom.name}</strong>{address ? " · notifying selected pubkey" : " · no explicit agent ping"}</div>
          {addressOpen && <label className="address-label">Notify a public key (64 hex characters)<input value={address} onChange={(e) => updateAddress(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Agent pubkey" /></label>}
          <div className="compose-row"><button className="address-toggle" onClick={() => setAddressOpen(!addressOpen)} aria-label={addressOpen ? "Hide recipient field" : "Add recipient public key"}>@</button><textarea aria-label={`Message ${currentRoom.name}`} value={draft} onChange={(e) => { setDraft(e.target.value); drafts.current.set(keyFor(channel!, root), e.target.value); }} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} maxLength={65536} rows={2} placeholder={isThread ? "Reply in thread…" : "Message Uni…"} /><button className="send" disabled={!draft.trim() || sending} onClick={() => void send()} aria-label="Send message">{sending ? "Sending…" : "Send"}</button></div>
          <p className="compose-hint">Enter to send · Shift+Enter for a new line · use your keyboard mic for dictation</p>
        </footer>
      </> : <div className="welcome"><span className="welcome-mark">✦</span><h2>Your conversation starts here</h2><p>Select a room to read and reply. Messages are cached for offline reading.</p></div>}
    </section>
  </main>;
}

export default App;
