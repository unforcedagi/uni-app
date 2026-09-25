import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { markdownToText, parseMarkdown, type Block, type Inline } from "./markdown";
import { activeQuery, filterMembers, insertMention, memberLabels, mentionSegments, pruneBindings, resolveRecipients, type Bindings, type Member } from "./mentions";

type Room = { id: string; name: string; last_message: string | null; last_ts: number | null; mentions: boolean; unread: number };
type Message = { ref: string; channel: string; author: string; author_name: string; ts: number; body: string; mentions_me: boolean; root: string | null; parent: string | null; mentions: Member[]; reply_count: number; last_reply_ts: number | null; edited: boolean };
type LivePayload = { kind: "message" | "edit" | "delete" | "rooms" | "profiles" | "status"; channel: string | null; status: string | null; author: string | null };
type IdentityStatus = { paired: boolean; pubkey: string | null };
type PairStep = "paste" | "connecting" | "code" | "receiving" | "done";
type SyncResult = { pubkey: string; total_items: number; channel_errors: Record<string, string>; truncated_channels: string[] };

const time = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const HEX_KEY = /^[0-9a-f]{64}$/i;
const keyFor = (channel: string, root: string | null) => `${channel}:${root ?? "room"}`;

function Pairing({ onPaired }: { onPaired: (pubkey: string) => void }) {
  const [link, setLink] = useState("");
  const [step, setStep] = useState<PairStep>("paste");
  const [sas, setSas] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    setStep("connecting");
    try {
      const r = await invoke<{ sas: string }>("pairing_start", { uri: link.trim() });
      setSas(r.sas);
      setStep("code");
    } catch (e) { setError(String(e)); setStep("paste"); }
  }
  async function confirm() {
    setError(null);
    setStep("receiving");
    try {
      const r = await invoke<{ pubkey: string }>("pairing_confirm");
      setLink("");
      setStep("done");
      onPaired(r.pubkey);
    } catch (e) { setError(String(e)); setStep("paste"); }
  }
  async function cancel(codesDiffer: boolean) {
    try { await invoke("pairing_cancel", { codesDiffer }); } catch { /* best effort */ }
    setSas("");
    setStep("paste");
    if (codesDiffer) setError("Codes did not match — pairing cancelled. Start a new pairing in Buzz.");
  }

  return <main className="pairing">
    <div className="pairing-card">
      <span className="eyebrow">BUZZ · PERSONAL</span>
      <h1>Pair with Buzz desktop</h1>
      {(step === "paste" || step === "connecting") && <>
        <ol className="pairing-steps">
          <li>On your computer, open Buzz → Settings → <strong>Pair mobile device</strong>.</li>
          <li>Click <strong>Copy</strong> and get the link to this device (paste it here).</li>
          <li>Tap Start, then compare the 6-digit codes.</li>
        </ol>
        <label className="pairing-label">Pairing link
          <textarea value={link} onChange={(e) => setLink(e.target.value)} rows={4} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder="nostrpair://…" disabled={step === "connecting"} />
        </label>
        <button className="send pairing-primary" disabled={!link.trim().startsWith("nostrpair://") || step === "connecting"} onClick={() => void start()}>{step === "connecting" ? "Connecting…" : "Start"}</button>
      </>}
      {(step === "code" || step === "receiving") && <>
        <p>Does Buzz desktop show this code?</p>
        <p className="sas" aria-label={`Code ${sas.split("").join(" ")}`}>{sas.slice(0, 3)} {sas.slice(3)}</p>
        <p className="pairing-note">Only continue if the codes are identical. Then confirm on Buzz desktop too.</p>
        <div className="pairing-actions">
          <button className="send pairing-primary" disabled={step === "receiving"} onClick={() => void confirm()}>{step === "receiving" ? "Waiting for Buzz desktop…" : "Codes match"}</button>
          <button className="pairing-secondary" onClick={() => void cancel(step === "code")}>Cancel</button>
        </div>
      </>}
      {step === "done" && <p>Paired. Loading your conversations…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <p className="pairing-note">Your key is sent encrypted, end to end, and stored in this device's secure keystore.</p>
    </div>
  </main>;
}

function App() {
  const [paired, setPaired] = useState<boolean | null>(null);
  useEffect(() => {
    invoke<IdentityStatus>("identity_status").then((s) => setPaired(s.paired)).catch(() => setPaired(false));
  }, []);
  if (paired === null) return <main className="pairing"><p className="empty">Loading…</p></main>;
  if (!paired) return <Pairing onPaired={() => setPaired(true)} />;
  return <Conversations onForget={() => setPaired(false)} />;
}

function openLink(e: React.MouseEvent, href: string) {
  // Never navigate the app's own WebView; hand the link to the system browser.
  e.preventDefault();
  void invoke("open_link", { url: href }).catch(() => {});
}

function Body({ body, mentions, me, edited }: { body: string; mentions: Member[]; me: string | null; edited?: boolean }) {
  const text = (v: string, key: string) => mentionSegments(v, mentions).map((seg, i) => seg.mention
    ? <span key={`${key}.${i}`} className={`mention ${seg.mention === me ? "mention-me" : ""}`} title={seg.mention}>{seg.text}</span>
    : <span key={`${key}.${i}`}>{seg.text}</span>);
  const inline = (nodes: Inline[], key: string): React.ReactNode[] => nodes.map((n, i) => {
    const k = `${key}.${i}`;
    switch (n.t) {
      case "text": return text(n.v, k);
      case "br": return <br key={k} />;
      case "code": return <code key={k}>{n.v}</code>;
      case "strong": return <strong key={k}>{inline(n.c, k)}</strong>;
      case "em": return <em key={k}>{inline(n.c, k)}</em>;
      case "del": return <del key={k}>{inline(n.c, k)}</del>;
      case "link": return <a key={k} href={n.href} onClick={(e) => openLink(e, n.href)} rel="noreferrer noopener">{inline(n.c, k)}</a>;
    }
  });
  const blocks = (bs: Block[], key: string): React.ReactNode[] => bs.map((b, i) => {
    const k = `${key}.${i}`;
    switch (b.t) {
      case "p": return <p key={k}>{inline(b.c, k)}</p>;
      case "h": return <p key={k} className={`md-h md-h${b.level}`}>{inline(b.c, k)}</p>;
      case "code": return <pre key={k} className="md-pre"><code>{b.v}</code></pre>;
      case "quote": return <blockquote key={k}>{blocks(b.c, k)}</blockquote>;
      case "hr": return <hr key={k} />;
      case "list": {
        const items = b.items.map((it, j) => <li key={`${k}.${j}`}>{blocks(it, `${k}.${j}`)}</li>);
        return b.ordered ? <ol key={k} start={b.start}>{items}</ol> : <ul key={k}>{items}</ul>;
      }
    }
  });
  const tree = parseMarkdown(body);
  return <div className="md">{blocks(tree, "b")}{edited && <span className="edited" title="Edited by the author">(edited)</span>}</div>;
}

type Picker = { start: number; query: string; index: number };

function Conversations({ onForget }: { onForget: () => void }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [channel, setChannel] = useState<string | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [identity, setIdentity] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const drafts = useRef(new Map<string, string>());
  const [bindings, setBindings] = useState<Bindings>(new Map());
  const bindingStore = useRef(new Map<string, Bindings>());
  const [picker, setPicker] = useState<Picker | null>(null);
  const [rawKey, setRawKey] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("Loading cached conversations…");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [forgetArmed, setForgetArmed] = useState(false);
  const [live, setLive] = useState<string | null>(null);
  // Bumped by live events so the open room re-reads from the local store.
  const [tick, setTick] = useState(0);
  const channelRef = useRef<string | null>(null);
  channelRef.current = channel;
  const scrollEnd = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const focusComposer = useRef(false);

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
      // Keep the socket open for push while we're in the foreground.
      invoke<boolean>("live_start").catch((e) => setLive(`Live unavailable: ${e}`));
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
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
      else { void invoke("live_stop").catch(() => {}); setLive(null); }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  // Live push: re-read rooms (unread badges, previews) and the open room.
  useEffect(() => {
    const un = listen<LivePayload>("uni://live", (e) => {
      const p = e.payload;
      if (p.kind === "status") { setLive(p.status); return; }
      void loadRooms().catch(() => {});
      if (p.kind === "profiles" || !p.channel || p.channel === channelRef.current) setTick((n) => n + 1);
    });
    return () => { void un.then((f) => f()); };
  }, [loadRooms]);

  useEffect(() => {
    if (!channel) { setMessages([]); return; }
    let current = true;
    invoke<Message[]>("get_messages", { channel, root }).then((rows) => { if (current) setMessages(rows); }).catch((e) => { if (current) setError(String(e)); });
    // Viewing the room reads it (only while the app is actually on screen).
    if (document.visibilityState === "visible") {
      invoke("mark_read", { channel }).then(() => loadRooms()).catch(() => {});
    }
    return () => { current = false; };
  }, [channel, root, status, tick, loadRooms]);

  useEffect(() => {
    if (!channel) { setMembers([]); return; }
    let current = true;
    invoke<Member[]>("get_members", { channel }).then((rows) => { if (current) setMembers(rows); }).catch(() => { if (current) setMembers([]); });
    return () => { current = false; };
  }, [channel, status]);

  useEffect(() => { scrollEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages.length, channel, root]);

  useEffect(() => {
    if (focusComposer.current) { focusComposer.current = false; input.current?.focus(); }
  }, [root]);

  const labels = memberLabels(members);
  const suggestions = picker ? filterMembers(members, picker.query, identity ?? undefined) : [];

  function scope() { return channel ? keyFor(channel, root) : null; }

  function updateDraft(text: string, caret: number | null) {
    setDraft(text);
    const key = scope();
    if (key) drafts.current.set(key, text);
    setBindings((old) => {
      const next = pruneBindings(text, old);
      if (key) bindingStore.current.set(key, next);
      return next;
    });
    syncPicker(text, caret);
  }

  function syncPicker(text: string, caret: number | null) {
    const q = caret === null ? null : activeQuery(text, caret);
    setPicker((old) => q ? { ...q, index: old && old.start === q.start ? old.index : 0 } : null);
  }

  function choose(member: Member) {
    if (!picker) return;
    const el = input.current;
    const caret = el?.selectionStart ?? draft.length;
    const label = labels.get(member.pubkey) ?? member.name;
    const next = insertMention(draft, picker.start, caret, label);
    const key = scope();
    setDraft(next.text);
    if (key) drafts.current.set(key, next.text);
    setBindings((old) => {
      const updated = new Map(pruneBindings(next.text, old));
      updated.set(label, member.pubkey);
      if (key) bindingStore.current.set(key, updated);
      return updated;
    });
    setPicker(null);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(next.caret, next.caret); });
  }

  function startMention() {
    const el = input.current;
    const caret = el?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const prefix = before && !/\s$/.test(before) ? " @" : "@";
    const text = before + prefix + draft.slice(caret);
    const at = caret + prefix.length;
    updateDraft(text, at);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at, at); });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (picker && suggestions.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setPicker({ ...picker, index: (picker.index + step + suggestions.length) % suggestions.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(suggestions[Math.min(picker.index, suggestions.length - 1)]);
        return;
      }
    }
    if (picker && e.key === "Escape") { e.preventDefault(); setPicker(null); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  }

  function navigate(nextChannel: string | null, nextRoot: string | null) {
    const key = scope();
    if (key) { drafts.current.set(key, draft); bindingStore.current.set(key, bindings); }
    const nextKey = nextChannel ? keyFor(nextChannel, nextRoot) : null;
    setChannel(nextChannel);
    setRoot(nextRoot);
    setDraft(nextKey ? drafts.current.get(nextKey) ?? "" : "");
    setBindings(nextKey ? bindingStore.current.get(nextKey) ?? new Map() : new Map());
    setPicker(null);
    setReplyTo(null);
    setError(null);
  }

  function openThread(m: Message) {
    focusComposer.current = true;
    navigate(channel, m.root && messages.some((x) => x.ref === m.root) ? m.root : m.ref);
  }

  async function send() {
    if (!channel || sending || !draft.trim()) return;
    const snapshot = draft;
    const key = keyFor(channel, root);
    const resolved = resolveRecipients(snapshot, bindings, members);
    if ("error" in resolved) { setError(resolved.error); return; }
    const recipients = [...resolved.recipients];
    const raw = rawKey.trim();
    if (raw) {
      if (!HEX_KEY.test(raw)) { setError("The advanced public key must be 64 hex characters."); return; }
      if (!recipients.includes(raw.toLowerCase())) recipients.push(raw.toLowerCase());
    }
    // In a thread, reply to the chosen message or to the root. If the root is
    // not cached, reply to the newest cached message in the thread.
    let target: string | null = replyTo;
    if (!target && root) target = messages.some((m) => m.ref === root) ? root : messages[messages.length - 1]?.ref ?? null;
    if (root && !target) { setError("Thread not in local cache. Refresh before replying."); return; }
    setSending(true);
    setError(null);
    try {
      await invoke<Message>("post_message", { channel, body: snapshot, replyTo: target, recipients });
      // Do not erase text typed during an in-flight send or in another room.
      if (drafts.current.get(key) === snapshot || (scope() === key && draft === snapshot)) {
        setDraft((current) => current === snapshot ? "" : current);
        drafts.current.set(key, "");
        bindingStore.current.set(key, new Map());
        setBindings(new Map());
      }
      setRawKey("");
      setReplyTo(null);
      await loadMessages(channel, root);
      await loadRooms();
      setStatus(recipients.length ? `Message accepted by relay · notified ${recipients.length}` : "Message accepted by relay");
    } catch (e) { setError(String(e)); }
    finally { setSending(false); }
  }

  async function forget() {
    // Two taps instead of window.confirm (unreliable in Android WebView).
    if (!forgetArmed) { setForgetArmed(true); return; }
    try { await invoke("identity_forget"); onForget(); } catch (e) { setError(String(e)); }
  }

  const currentRoom = rooms.find((r) => r.id === channel);
  const isThread = !!root;
  const rootMessage = isThread ? messages.find((m) => m.ref === root) : undefined;
  const threadReplies = isThread ? messages.filter((m) => m.ref !== root) : [];
  const boundNames = [...new Set(bindings.values())].map((pk) => members.find((m) => m.pubkey === pk)?.name ?? pk.slice(0, 8));

  const renderMessage = (m: Message, inThread: boolean) => <article key={m.ref} className={`message ${m.author === identity ? "mine" : ""} ${m.mentions_me ? "highlight" : ""} ${inThread && m.ref === root ? "thread-root" : ""}`}>
    <span className="message-avatar" aria-hidden="true">{m.author_name[0]?.toUpperCase() ?? "?"}</span><div className="message-content"><div className="message-meta"><strong>{m.author_name}</strong><time>{time(m.ts)}</time></div><Body body={m.body} mentions={m.mentions} me={identity} edited={m.edited} />
      {!inThread && m.reply_count > 0 && <button className="thread-summary" onClick={() => openThread(m)} aria-label={`View thread with ${m.reply_count} ${m.reply_count === 1 ? "reply" : "replies"}`}>💬 {m.reply_count} {m.reply_count === 1 ? "reply" : "replies"}{m.last_reply_ts ? <span> · last {time(m.last_reply_ts)}</span> : null}</button>}
      <div className="message-actions">
        {!inThread && <button onClick={() => openThread(m)} aria-label={`Reply in thread to ${m.author_name}`}>Reply in thread</button>}
        {inThread && m.ref !== root && <button onClick={() => { setReplyTo(m.ref); input.current?.focus(); }} aria-label={`Reply to ${m.author_name}`}>Reply</button>}
      </div>
    </div>
  </article>;

  return <main className={`shell ${channel ? "in-room" : ""}`}>
    <aside className="rooms" aria-label="Conversations">
      <header className="rooms-header"><div><span className="eyebrow">BUZZ · PERSONAL</span><h1>Talk to Uni</h1></div><div><button className="icon-button" onClick={() => void refresh()} disabled={busy} aria-label="Refresh conversations">↻</button><button className="icon-button" onClick={() => { setSettingsOpen(!settingsOpen); setForgetArmed(false); }} aria-label="Settings" aria-expanded={settingsOpen}>⚙</button></div></header>
      {settingsOpen && <div className="settings"><button className="pairing-secondary" onClick={() => void forget()}>{forgetArmed ? "Tap again to forget — you'll need to re-pair" : "Forget this device key"}</button>{forgetArmed && <button className="pairing-secondary" onClick={() => setForgetArmed(false)}>Keep key</button>}</div>}
      <p className="connection" role="status">{status}{live ? <span className={`live ${live === "Live" ? "on" : ""}`}> · {live}</span> : null}</p>
      {identity && <p className="identity" title={identity}>Signed in as {identity.slice(0, 12)}…</p>}
      {!ready && <p className="empty">Loading…</p>}
      {ready && rooms.length === 0 && <p className="empty">No joined conversations cached. Refresh to connect with your personal Buzz key.</p>}
      <nav>{rooms.map((room) => <button key={room.id} className={`room ${channel === room.id ? "selected" : ""}`} onClick={() => navigate(room.id, null)} aria-current={channel === room.id ? "page" : undefined}>
        <span className="avatar">{room.name[0]?.toUpperCase() ?? "#"}</span><span className="room-text"><strong className={room.unread ? "unread" : ""}>{room.name}</strong><small>{room.last_message ? markdownToText(room.last_message) : "No messages yet"}</small></span>
        <span className="room-side"><time>{room.last_ts ? time(room.last_ts) : ""}</time>{room.unread > 0 && <span className={`unread-badge ${room.mentions ? "mention" : ""}`} aria-label={`${room.unread} unread${room.mentions ? ", mentions you" : ""}`}>{room.mentions ? "@ " : ""}{room.unread > 99 ? "99+" : room.unread}</span>}</span>
      </button>)}</nav>
    </aside>
    <section className="conversation" aria-label={currentRoom ? `Conversation: ${currentRoom.name}` : "Conversation"}>
      {currentRoom ? <>
        <header className="conversation-header">
          <button className="back icon-button" onClick={() => isThread ? navigate(channel, null) : navigate(null, null)} aria-label={isThread ? "Back to room" : "Back to conversations"}>‹</button>
          {isThread && <button className="thread-back" onClick={() => navigate(channel, null)} aria-label="Close thread">‹ {currentRoom.name}</button>}
          <div><strong>{isThread ? "Thread" : currentRoom.name}</strong><small>{isThread ? `${threadReplies.length} ${threadReplies.length === 1 ? "reply" : "replies"} · in ${currentRoom.name}` : `Buzz conversation · ${members.length ? `${members.length} members` : "cached locally"}`}</small></div>
          <button className="icon-button" onClick={() => void refresh()} disabled={busy} aria-label="Refresh messages">↻</button>
        </header>
        <div className="message-list" role="log" aria-label="Messages" aria-live="polite">
          {isThread ? <>
            {rootMessage ? renderMessage(rootMessage, true) : messages.length > 0 && <p className="empty">Root message is not cached; showing replies we have.</p>}
            {rootMessage && <div className="thread-divider"><span>{threadReplies.length ? `${threadReplies.length} ${threadReplies.length === 1 ? "reply" : "replies"}` : "No replies yet"}</span></div>}
            {threadReplies.map((m) => renderMessage(m, true))}
            {messages.length === 0 && <p className="empty">Thread not in local cache. Refresh to try again.</p>}
          </> : <>
            {messages.length === 0 && <p className="empty">No messages in this room yet.</p>}
            {messages.map((m) => renderMessage(m, false))}
          </>}
          <div ref={scrollEnd} />
        </div>
        <footer className="composer">
          {error && <p className="error" role="alert">{error}</p>}
          {replyTo && replyTo !== root && <div className="reply-banner">Replying to {messages.find((m) => m.ref === replyTo)?.author_name ?? "message"}<button onClick={() => setReplyTo(null)} aria-label="Cancel reply">×</button></div>}
          <div className="compose-destination">{isThread ? <>Replying in thread · <strong>{currentRoom.name}</strong></> : <>Sending to <strong>{currentRoom.name}</strong></>}{boundNames.length ? ` · notifying ${boundNames.join(", ")}` : " · type @ to notify someone"}</div>
          {picker && <ul className="mention-picker" role="listbox" aria-label="Mention a member">
            {suggestions.length === 0 && <li className="mention-empty">{members.length ? `No member matches “${picker.query}”` : "No member list cached yet. Refresh to load it."}</li>}
            {suggestions.map((m, i) => <li key={m.pubkey} role="option" aria-selected={i === picker.index}>
              <button className={i === picker.index ? "active" : ""} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(m)}>
                <span className="avatar small">{m.name[0]?.toUpperCase() ?? "?"}</span><span className="mention-name">{labels.get(m.pubkey) ?? m.name}</span><small>{m.pubkey.slice(0, 8)}</small>
              </button>
            </li>)}
          </ul>}
          {advancedOpen && <label className="address-label">Advanced: also notify a raw public key (64 hex characters)<input value={rawKey} onChange={(e) => setRawKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder="hex pubkey" /></label>}
          <div className="compose-row"><button className="address-toggle" onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={startMention} aria-label="Mention someone">@</button><textarea ref={input} aria-label={`Message ${currentRoom.name}`} value={draft} onChange={(e) => updateDraft(e.target.value, e.target.selectionStart)} onSelect={(e) => syncPicker(e.currentTarget.value, e.currentTarget.selectionStart)} onBlur={() => setPicker(null)} onKeyDown={onKeyDown} maxLength={65536} rows={2} placeholder={isThread ? "Reply in thread…" : "Message Uni…"} /><button className="send" disabled={!draft.trim() || sending} onClick={() => void send()} aria-label="Send message">{sending ? "Sending…" : "Send"}</button></div>
          <p className="compose-hint">Enter to send · Shift+Enter for a new line · @ to mention · <button className="link" onClick={() => setAdvancedOpen(!advancedOpen)}>{advancedOpen ? "hide raw key" : "raw key…"}</button></p>
        </footer>
      </> : <div className="welcome"><span className="welcome-mark">✦</span><h2>Your conversation starts here</h2><p>Select a room to read and reply. Messages are cached for offline reading.</p></div>}
    </section>
  </main>;
}

export default App;
