// T-335 All view: not a room of its own but every area's room at once. The feed interleaves the rooms' messages by time, each marked
// with its place (tap to step into that room, at that message). The composer suggests where a message should go as editable chips; the
// person sees the route and can change it, and one tap sends to one room or several. Sending posts the message into each chosen room,
// as the person, with that room's Uni addressed, so each room's own Uni session takes it. Nothing is posted anywhere else, and nothing
// is posted on a guess: with no room chosen there is no Send.
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Body } from "../MessageBody";
import type { Member } from "../mentions";
import { findUniMember } from "../uniActions";
import { andList, interleave, sendEach, type FeedMessage } from "./allCore";
import { suggestRoute, type RouteRoom } from "./route";
import "./all.css";

/** A place in the All view: an area and its own room. */
export type AllRoom = { id: string; name: string; slug: string | null; stands: string | null; lastTs: number | null };

type Message = FeedMessage & { mentions: Member[]; edited: boolean };
type Live = { kind: string; channel: string | null };

const PER_ROOM = 40;
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const clock = (ts: number) => clockFormat.format(new Date(ts * 1000));
function dayLabel(ts: number) {
  const d = new Date(ts * 1000), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/** Each room's recent messages, read when the view needs them and again when the room changes. */
export function useRoomsFeed(rooms: readonly AllRoom[], on: boolean) {
  const [byRoom, setByRoom] = useState<Map<string, Message[]>>(() => new Map());
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const readRef = useRef<((id: string) => void) | null>(null);
  const ids = rooms.map((r) => r.id).join(",");
  useEffect(() => {
    if (!on || !ids) return;
    let live = true;
    const want = ids.split(",");
    const read = (id: string) => invoke<Message[]>("get_messages", { channel: id, root: null, limit: PER_ROOM })
      .then((list) => { if (live) { setByRoom((m) => new Map(m).set(id, list)); setFailed((f) => f.filter((x) => x !== id)); } })
      .catch(() => { if (live) setFailed((f) => (f.includes(id) ? f : [...f, id])); });
    readRef.current = (id) => { if (want.includes(id)) void read(id); };
    void Promise.all(want.map(read)).then(() => { if (live) setLoaded(true); });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const un = listen<Live>("uni://live", (e) => {
      const c = e.payload?.channel;
      if (!c || !want.includes(c) || !["message", "edit", "delete"].includes(e.payload.kind)) return;
      clearTimeout(timers.get(c));
      timers.set(c, setTimeout(() => void read(c), 120));
    });
    return () => { live = false; readRef.current = null; timers.forEach(clearTimeout); void un.then((f) => f()); };
  }, [ids, on]);
  /** Reads these rooms again now (after a send: the relay's own echo may come later). */
  const reread = useCallback((list: readonly string[]) => { for (const id of list) readRef.current?.(id); }, []);
  return { byRoom, loaded, failed, reread };
}

/** What the composer holds across the home's two views (Places and All) and across visits. */
const held = { text: "", chosen: null as string[] | null };

export function AllComposer({ rooms, words, onOpen, onFocus, onSent, place = "places" }: { rooms: readonly AllRoom[];
  /** Rooms just sent to. */ onSent?: (ids: string[]) => void;
  /** The field took focus (the home reads the rooms' words then, not before). */ onFocus?: () => void;
  /** Each room's recent words, for the route's second rule. */ words: ReadonlyMap<string, string>;
  /** Opens a room (a sent-to line's link). */ onOpen: (id: string) => void;
  /** Where it sits: in the middle of the home, or under the All feed. */ place?: "places" | "all" }) {
  const [text, setText] = useState(held.text);
  // null: follow Uni's suggestion; a list: the person's own choice, kept until it is sent or cleared
  const [chosen, setChosen] = useState<string[] | null>(held.chosen);
  const [adding, setAdding] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<{ sent: string[]; failed: { id: string; error: string }[] } | null>(null);
  const attempt = useRef<{ body: string; done: Set<string> } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const nameOf = useMemo(() => new Map(rooms.map((r) => [r.id, r.name])), [rooms]);
  const routeRooms: RouteRoom[] = useMemo(() => rooms.map((r) => ({ id: r.id, name: r.name, slug: r.slug, text: `${r.stands ?? ""} ${words.get(r.id) ?? ""}`, lastTs: r.lastTs, lastMine: null })), [rooms, words]);
  const typed = useDeferredValue(text);
  const picks = useMemo(() => (typed.trim() ? suggestRoute(typed, routeRooms) : []), [typed, routeRooms]);
  const to = (chosen ?? picks.map((p) => p.id)).filter((id) => nameOf.has(id));
  const done = attempt.current && attempt.current.body === text ? attempt.current.done : null;
  const left = to.filter((id) => !done?.has(id));
  const why = chosen ? "your choice" : picks.length ? picks.map((p) => p.why).filter((w, i, a) => a.indexOf(w) === i).join(", ") : "";
  useEffect(() => { held.text = text; held.chosen = chosen; }, [text, chosen]);
  // the field grows with its text up to six lines
  useLayoutEffect(() => { const el = field.current; if (!el) return; el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 6 * 24 + 16)}px`; }, [text]);

  const edit = (next: string[]) => { setChosen(next); setOutcome(null); };
  async function send() {
    const body = text.trim();
    if (!body || !left.length || sending) return;
    if (!attempt.current || attempt.current.body !== text) attempt.current = { body: text, done: new Set() };
    const run = attempt.current;
    setSending(true);
    setOutcome(null);
    const post = async (room: string, b: string) => {
      const members = await invoke<Member[]>("get_members", { channel: room });
      const uni = findUniMember(members);
      await invoke("post_message", { channel: room, body: b, replyTo: null, recipients: uni ? [uni.pubkey] : [], media: [] });
    };
    try {
      const r = await sendEach(to, body, post, run.done);
      const sent = to.filter((id) => run.done.has(id));
      setOutcome({ sent, failed: r.failed });
      if (r.sent.length) onSent?.(r.sent);
      if (!r.failed.length) { setText(""); setChosen(null); setAdding(false); attempt.current = null; }
    } finally { setSending(false); }
  }

  const named = (ids: readonly string[]) => andList(ids.map((id) => nameOf.get(id) ?? id));
  return <section className={`all-compose all-compose-${place}`} aria-label="Talk to Uni">
    {text.trim() && <div className="all-route" role="group" aria-label="Where this goes">
      <span className="all-to">To</span>
      {to.map((id) => <span key={id} className={`all-chip${done?.has(id) ? " sent" : ""}`} data-room={id}>
        <span className="all-chip-name">{nameOf.get(id)}</span>
        {done?.has(id) ? <span className="all-chip-sent">sent</span>
          : <button type="button" className="all-chip-x" aria-label={`Don't send to ${nameOf.get(id)}`} onClick={() => edit(to.filter((x) => x !== id))}>×</button>}
      </span>)}
      <button type="button" className="all-chip all-chip-add" aria-expanded={adding} aria-label="Add a room" onClick={() => setAdding(!adding)}>+ Room</button>
      {why && <span className="all-why" data-why>{chosen ? why : `suggested: ${why}`}</span>}
      {adding && <ul className="all-add" aria-label="Rooms to add">{rooms.filter((r) => !to.includes(r.id)).map((r) => <li key={r.id}>
        <button type="button" onClick={() => { edit([...to, r.id]); setAdding(false); field.current?.focus(); }}>{r.name}</button></li>)}
        {rooms.every((r) => to.includes(r.id)) && <li className="all-add-none">Every room is on the list.</li>}</ul>}
    </div>}
    <div className="compose-row all-row">
      <textarea ref={field} rows={1} value={text} aria-label="Message for your rooms" onFocus={onFocus} placeholder={place === "all" ? "Say something; Uni suggests where" : "Talk to Uni"}
        onChange={(e) => { setText(e.target.value); setOutcome(null); }}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      <button type="button" className="send all-send" disabled={!text.trim() || !left.length || sending}
        aria-label={left.length ? `Send to ${named(left)}` : "Choose a room to send to"} onClick={() => void send()}>
        {sending ? "Sending…" : left.length > 1 ? `Send to ${left.length}` : "Send"}
      </button>
    </div>
    {text.trim() && !to.length && <p className="all-note" role="status">Choose a room: nothing is sent until you do.</p>}
    {outcome && <p className={`all-note${outcome.failed.length ? " all-failed" : ""}`} role="status">
      {outcome.sent.length > 0 && <>Sent to {outcome.sent.map((id, i) => <span key={id}>{i > 0 && (i === outcome.sent.length - 1 ? " and " : ", ")}<button type="button" className="all-link" onClick={() => onOpen(id)}>{nameOf.get(id)}</button></span>)}. </>}
      {outcome.failed.length > 0 && <>Couldn't send to {named(outcome.failed.map((f) => f.id))} ({outcome.failed[0].error}). Send again to try only {outcome.failed.length === 1 ? "that room" : "those rooms"}.</>}
    </p>}
  </section>;
}

const FeedRow = memo(function FeedRow({ m, place, mine, me, grouped, onOpen }: { m: Message; place: string; mine: boolean; me: string | null; grouped: boolean; onOpen: (room: string, ref: string) => void }) {
  return <article className={`message all-msg${mine ? " mine" : ""}${grouped ? " grouped" : ""}`} data-ref={m.ref} data-room={m.channel}
    onClick={(e) => { if (!(e.target instanceof Element) || !e.target.closest("a, button, summary, input, textarea")) onOpen(m.channel, m.ref); }}>
    <div className="message-content">
      {!grouped && <div className="all-meta">
        <button type="button" className="all-place" aria-label={`Open ${place}, at this message`} onClick={() => onOpen(m.channel, m.ref)}>{place}</button>
        {!mine && <strong>{m.author_name}</strong>}<time>{clock(m.ts)}</time>
      </div>}
      <Body body={m.body} mentions={m.mentions ?? []} me={me} edited={m.edited} />
    </div>
  </article>;
});

export function AllFeed({ rooms, byRoom, loaded, failed, me, onOpen }: { rooms: readonly AllRoom[]; byRoom: ReadonlyMap<string, Message[]>; loaded: boolean; failed: readonly string[];
  me: string | null; onOpen: (room: string, ref: string) => void }) {
  const nameOf = useMemo(() => new Map(rooms.map((r) => [r.id, r.name])), [rooms]);
  const feed = useMemo(() => interleave(byRoom), [byRoom]);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => { const el = list.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [feed]);
  const rows: React.ReactNode[] = [];
  let prev: Message | null = null;
  for (const m of feed) {
    const sameDay = !!prev && new Date(prev.ts * 1000).toDateString() === new Date(m.ts * 1000).toDateString();
    if (!sameDay) rows.push(<div key={`d-${m.ref}`} className="day-divider" role="separator"><span>{dayLabel(m.ts)}</span></div>);
    // a run of one author in one room within five minutes reads as one message: its place and name once
    const grouped = sameDay && prev!.channel === m.channel && prev!.author === m.author && m.ts - prev!.ts < 300;
    rows.push(<FeedRow key={`${m.channel}:${m.ref}`} m={m} place={nameOf.get(m.channel) ?? "Room"} mine={!!me && m.author === me} me={me} grouped={grouped} onOpen={onOpen} />);
    prev = m;
  }
  return <div className="all-feed" ref={list} role="log" aria-label="All rooms, by time" aria-live="polite"
    onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
    <div className="all-stack">
      {!loaded && <p className="all-quiet" role="status">Reading your rooms…</p>}
      {loaded && !feed.length && <p className="all-quiet">Nothing said in your rooms yet.</p>}
      {rows}
      {failed.length > 0 && <p className="all-quiet" role="status">Couldn't read {andList(failed.map((id) => nameOf.get(id) ?? id))} just now.</p>}
    </div>
  </div>;
}

/** Each room's recent words, for the route (its last messages' text). */
export function roomWords(byRoom: ReadonlyMap<string, readonly FeedMessage[]>): Map<string, string> {
  return new Map([...byRoom].map(([id, list]) => [id, list.slice(-PER_ROOM).map((m) => m.body).join(" ")]));
}
