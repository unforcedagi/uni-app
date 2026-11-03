// T-335 All view: not a room of its own but every area's room at once. The feed interleaves the rooms' messages by time, each marked
// with its place (tap to step into that room, at that message). The composer suggests where a message should go as editable chips; the
// person sees the route and can change it, and one tap sends to one room or several. Sending posts the message into each chosen room,
// as the person, with that room's Uni addressed, so each room's own Uni session takes it. Nothing is posted anywhere else, and nothing
// is posted on a guess: with no room chosen there is no Send.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Body } from "../MessageBody";
import type { Member } from "../mentions";
import { findUniMember } from "../uniActions";
import { andList, interleave, sendEach, type FeedMessage } from "./allCore";
import { makeRouter, type RouteRoom } from "./route";
import { enterInsertsNewline } from "../composerCore";
import { isMaintenance, isWorkerStatus } from "../chatMarkers";
import { commandOf, isStopReply } from "../chatFeel";
import "./all.css";

/** A place in the All view: an area and its own room. */
export type AllRoom = { id: string; name: string; slug: string | null; stands: string | null; lastTs: number | null };

type Message = FeedMessage & { mentions: Member[]; edited: boolean; media?: unknown[] | null };
type Live = { kind: string; channel: string | null };

const PER_ROOM = 40;
/** On a touch keyboard Return is a new line; Send is the button (as in the room's composer and Messages). */
const touchKeyboard = () => typeof navigator !== "undefined" && enterInsertsNewline(navigator.maxTouchPoints ?? 0, matchMedia("(pointer: coarse)").matches);
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
    // a room no longer in the list (made private, gone) leaves the feed at once
    setByRoom((m) => ([...m.keys()].every((k) => want.includes(k)) ? m : new Map([...m].filter(([k]) => want.includes(k)))));
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
  /** Each room's recent words (the route's second rule) and when you last wrote there (its third). */ words: ReadonlyMap<string, RoomWords>;
  /** Opens a room (a sent-to line's link). */ onOpen: (id: string) => void;
  /** Where it sits: in the middle of the home, or under the All feed. */ place?: "places" | "all" }) {
  const [text, setText] = useState(held.text);
  // null: follow Uni's suggestion; a list: the person's own choice, kept until it is sent or cleared
  const [chosen, setChosen] = useState<string[] | null>(held.chosen);
  const [adding, setAdding] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<{ sent: string[]; failed: { id: string; error: string }[]; noUni: string[] } | null>(null);
  const attempt = useRef<{ body: string; done: Set<string> } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const nameOf = useMemo(() => new Map(rooms.map((r) => [r.id, r.name])), [rooms]);
  // the rooms' words are read once per change of rooms or words; each key then routes the text as it is now, so Send always goes
  // where the chips on screen say
  const route = useMemo(() => makeRouter(rooms.map((r): RouteRoom => ({ id: r.id, name: r.name, slug: r.slug, text: `${r.stands ?? ""} ${words.get(r.id)?.text ?? ""}`, lastTs: r.lastTs, lastMine: words.get(r.id)?.lastMine ?? null }))), [rooms, words]);
  const picks = useMemo(() => (text.trim() ? route(text) : []), [text, route]);
  // T-335 chat feel: a sure route is chosen for you (and named on Send); a guess is only offered, dashed, until you tap it
  const to = (chosen ?? picks.filter((p) => p.sure).map((p) => p.id)).filter((id) => nameOf.has(id));
  const offered = chosen ? [] : picks.filter((p) => !p.sure && nameOf.has(p.id) && !to.includes(p.id));
  const done = attempt.current && attempt.current.body === text ? attempt.current.done : null;
  const left = to.filter((id) => !done?.has(id));
  const why = chosen ? "your choice" : picks.length ? picks.filter((p) => p.sure).map((p) => p.why).filter((w, i, a) => a.indexOf(w) === i).join(", ") : "";
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
    // as the room's own composer does: the message is addressed to the room's Uni when Uni is a member there
    const noUni: string[] = [];
    const post = async (room: string, b: string) => {
      const members = await invoke<Member[]>("get_members", { channel: room });
      const uni = findUniMember(members);
      await invoke("post_message", { channel: room, body: b, replyTo: null, recipients: uni ? [uni.pubkey] : [], media: [] });
      if (!uni) noUni.push(room);
    };
    try {
      const r = await sendEach(to, body, post, run.done);
      const sent = to.filter((id) => run.done.has(id));
      setOutcome({ sent, failed: r.failed, noUni });
      if (r.sent.length) onSent?.(r.sent);
      if (!r.failed.length) { setText(""); setChosen(null); setAdding(false); attempt.current = null; }
    } finally { setSending(false); }
  }

  const named = (ids: readonly string[]) => andList(ids.map((id) => nameOf.get(id) ?? id));
  return <section className={`all-compose all-compose-${place}`} aria-label="Talk to Uni">
    {text.trim() && <div className="all-route" role="group" aria-label="Where this goes">
      <span className="all-to">To</span>
      {to.map((id) => <span key={id} className={`all-chip chosen${done?.has(id) ? " sent" : ""}`} data-room={id}>
        <span className="all-chip-name">{nameOf.get(id)}</span>
        {done?.has(id) ? <span className="all-chip-sent">sent</span>
          : <button type="button" className="all-chip-x" aria-label={`Don't send to ${nameOf.get(id)}`} onClick={() => edit(to.filter((x) => x !== id))}>×</button>}
      </span>)}
      {offered.map((p) => <button key={p.id} type="button" className="all-chip suggested" data-room={p.id} aria-label={`Send to ${nameOf.get(p.id)}: ${p.why}`}
        onClick={() => { edit([...to, p.id]); field.current?.focus(); }}><span className="all-chip-name">{nameOf.get(p.id)}</span><span className="all-chip-why">{p.why}</span></button>)}
      <button type="button" className="all-chip all-chip-add" aria-expanded={adding} aria-label="Add a room" onClick={() => setAdding(!adding)}>+ Room</button>
      {why && <span className="all-why" data-why>{chosen ? why : `suggested: ${why}`}</span>}
      {adding && <ul className="all-add" aria-label="Rooms to add">{rooms.filter((r) => !to.includes(r.id)).map((r) => <li key={r.id}>
        <button type="button" onClick={() => { edit([...to, r.id]); setAdding(false); field.current?.focus(); }}>{r.name}</button></li>)}
        {rooms.every((r) => to.includes(r.id)) && <li className="all-add-none">Every room is on the list.</li>}</ul>}
    </div>}
    <div className="compose-row all-row">
      <textarea ref={field} rows={1} value={text} aria-label="Message for your rooms" onFocus={onFocus} placeholder={place === "all" ? "Say something; Uni suggests where" : "Talk to Uni"}
        onChange={(e) => { setText(e.target.value); setOutcome(null); }}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !touchKeyboard()) { e.preventDefault(); void send(); } }} />
      <button type="button" className="send all-send" disabled={!text.trim() || !left.length || sending}
        aria-label={left.length ? `Send to ${named(left)}` : "Choose a room to send to"} onClick={() => void send()}>
        {sending ? "Sending…" : left.length > 1 ? `Send to ${left.length} rooms` : left.length ? `Send to ${nameOf.get(left[0])}` : "Choose a room"}
      </button>
    </div>
    {text.trim() && !to.length && <p className="all-note" role="status">Pick a room, or keep typing. Nothing is sent until you do.</p>}
    {outcome && <p className={`all-note${outcome.failed.length ? " all-failed" : ""}`} role="status">
      {outcome.sent.length > 0 && <>Sent to {outcome.sent.map((id, i) => <span key={id}>{i > 0 && (i === outcome.sent.length - 1 ? " and " : ", ")}<button type="button" className="all-link" onClick={() => onOpen(id)}>{nameOf.get(id)}</button></span>)}. </>}
      {outcome.noUni.length > 0 && <>Uni isn't in {named(outcome.noUni)}, so no Uni there was asked. </>}
      {outcome.failed.length > 0 && <>Couldn't send to {named(outcome.failed.map((f) => f.id))} ({outcome.failed[0].error}). Send again to try only {outcome.failed.length === 1 ? "that room" : "those rooms"}.</>}
    </p>}
  </section>;
}

/** T-335 chat feel: a reply this long shows its start in All, and a way into its room for the rest. */
const isLong = (body: string) => body.length > 320 || body.split("\n").filter((l) => l.trim()).length > 4;
/** A room's own tint, from its id: the dot on its label. */
const tint = (id: string) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 38% 42%)`; };

const FeedRow = memo(function FeedRow({ m, place, mine, me, run, named, onOpen }: { m: Message; place: string; mine: boolean; me: string | null;
  /** The first message of a run from one room: it carries the room's label. */ run: boolean; /** Says who and when (a new author, or a pause). */ named: boolean;
  onOpen: (room: string, ref: string) => void }) {
  const clamp = !mine && isLong(m.body);
  return <article className={`message all-msg${mine ? " mine" : ""}${run ? " run" : " grouped"}${clamp ? " clamped" : ""}`} data-ref={m.ref} data-room={m.channel}
    onClick={(e) => { if (!(e.target instanceof Element) || !e.target.closest("a, button, summary, input, textarea")) onOpen(m.channel, m.ref); }}>
    <div className="message-content">
      {run && <div className="all-run"><button type="button" className="all-place" style={{ ["--room-tint" as string]: tint(m.channel) }} aria-label={`Open ${place}, at this message`} onClick={() => onOpen(m.channel, m.ref)}>{place}</button><time>{clock(m.ts)}</time></div>}
      {named && !mine && <div className="all-meta"><strong>{m.author_name}</strong>{!run && <time>{clock(m.ts)}</time>}</div>}
      {m.body.trim() ? <Body body={m.body} mentions={m.mentions ?? []} me={me} edited={m.edited} />
        : <p className="all-file">{m.media?.length ? `${m.media.length === 1 ? "A file" : `${m.media.length} files`}: open the room to see ${m.media.length === 1 ? "it" : "them"}` : "(nothing to show here)"}</p>}
      {clamp && <button type="button" className="all-rest" onClick={() => onOpen(m.channel, m.ref)}>Read the rest in {place} ›</button>}
    </div>
  </article>;
});
/** Not for All: progress pings, Uni's upkeep, the room buttons' commands and the gateway's answer to a stop. */
const notTalk = (m: FeedMessage) => isWorkerStatus(m.body) || isMaintenance(m.body) || !!commandOf(m.body) || isStopReply(m.body);

export function AllFeed({ rooms, byRoom, loaded, failed, me, onOpen }: { rooms: readonly AllRoom[]; byRoom: ReadonlyMap<string, Message[]>; loaded: boolean; failed: readonly string[];
  me: string | null; onOpen: (room: string, ref: string) => void }) {
  const nameOf = useMemo(() => new Map(rooms.map((r) => [r.id, r.name])), [rooms]);
  const feed = useMemo(() => interleave(new Map([...byRoom].filter(([id]) => nameOf.has(id)).map(([id, list]) => [id, list.filter((m) => !notTalk(m))]))), [byRoom, nameOf]);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => { const el = list.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [feed]);
  const rows: React.ReactNode[] = [];
  let prev: Message | null = null;
  for (const m of feed) {
    const sameDay = !!prev && new Date(prev.ts * 1000).toDateString() === new Date(m.ts * 1000).toDateString();
    if (!sameDay) rows.push(<div key={`d-${m.ref}`} className="day-divider" role="separator"><span>{dayLabel(m.ts)}</span></div>);
    // T-335 chat feel: runs, not a mirror: the room's label only where the room changes; inside a run, who speaks when the author changes
    const run = !sameDay || prev!.channel !== m.channel;
    const named = run || prev!.author !== m.author || m.ts - prev!.ts >= 300;
    rows.push(<FeedRow key={`${m.channel}:${m.ref}`} m={m} place={nameOf.get(m.channel) ?? "Room"} mine={!!me && m.author === me} me={me} run={run} named={named} onOpen={onOpen} />);
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

export type RoomWords = { text: string; lastMine: number | null };
/** Each room's recent words (its last messages' text) and when you last wrote there, for the route. */
export function roomWords(byRoom: ReadonlyMap<string, readonly FeedMessage[]>, me: string | null): Map<string, RoomWords> {
  return new Map([...byRoom].map(([id, list]) => {
    const recent = list.slice(-PER_ROOM);
    const mine = me ? recent.filter((m) => m.author === me) : [];
    return [id, { text: recent.map((m) => m.body).join(" "), lastMine: mine.length ? Math.max(...mine.map((m) => m.ts)) : null }];
  }));
}
