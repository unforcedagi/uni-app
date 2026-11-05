// T-335 All view: not a room of its own but every area's room at once. The feed interleaves the rooms' messages by time, each marked
// with its place (tap to step into that room, at that message). The composer suggests where a message should go as editable chips; the
// person sees the route and can change it, and one tap sends to one room or several. Sending posts the message into each chosen room,
// as the person, with that room's Uni addressed, so each room's own Uni session takes it. Nothing is posted anywhere else, and nothing
// is posted on a guess: with no room chosen there is no Send.
// T-335 All v2: All is a place on the rail, reachable from every room and back, never where the app opens. A tap or a swipe on a message
// replies in that room (or its thread) with no routing at all; the room's label is the way into the room. An unaddressed message gets the word
// match at once and the small model's route if it answers in time (modelRoute.ts).
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Body } from "../MessageBody";
import type { Member } from "../mentions";
import { findUniMember } from "../uniActions";
import { andList, interleave, replyTargetOf, roomAddress, sameTarget, sendEach, type FeedMessage, type ReplyTarget } from "./allCore";
import { makeRouter, mergeRoute, type RouteRoom } from "./route";
import { forgetModelRoute, logOutcome, useModelRoute, type DoorRoom } from "./modelRoute";
import { enterInsertsNewline } from "../composerCore";
import { isMaintenance, isWorkerStatus } from "../chatMarkers";
import { commandOf, isStopReply } from "../chatFeel";
import { relayAccepted } from "../voiceOutbox";
import "./all.css";

/** A place in the All view: an area and its own room. */
export type AllRoom = { id: string; name: string; slug: string | null; stands: string | null; lastTs: number | null;
  /** The area note's own one line on what it is (the route's description of the room). */ about?: string | null };

type Message = FeedMessage & { mentions: Member[]; edited: boolean; media?: unknown[] | null; reply_count?: number };
type Live = { kind: string; channel: string | null };

const PER_ROOM = 40;
/** After the model moves the route, how long a Send is held (it was aimed at the route before). */
const SETTLE_MS = 300;
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

/**
 * What the composer holds, across the home and All, across visits, and while a send is out: written the moment it changes, not when a component draws,
 * because a send can finish after you have left. A message delivered isn't left as a draft to send again; one that failed is back here, with why.
 */
const held = {
  text: "", chosen: null as string[] | null, target: null as ReplyTarget | null,
  attempt: null as { body: string; done: Set<string> } | null, sending: false,
  /** Counts the taps that set a target: each one gives the field the keys (a reply coming back from a failure doesn't take them). */
  taps: 0,
  /** Counts Forgets: a send still out when the key is forgotten must not bring anything back. */
  era: 0,
  outcome: null as { sent: string[]; failed: { id: string; error: string }[]; noUni: string[] } | null,
  /** A reply that failed after the composer had moved on: its words are offered back, never mixed into the new ones. */
  lost: [] as { body: string; target: ReplyTarget; error: string }[],
};
const watchers = new Set<() => void>();
const setHeld = (p: Partial<typeof held>) => { Object.assign(held, p); watchers.forEach((f) => f()); };
function useHeld() {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => { watchers.add(redraw); return () => { watchers.delete(redraw); }; }, []);
  return held;
}
/** Forget this device's key: nothing typed under it stays in memory, or could be read to a model under the next key. */
export function forgetComposer() {
  setHeld({ text: "", chosen: null, target: null, attempt: null, sending: false, outcome: null, lost: [], era: held.era + 1 });
  forgetModelRoute();
}
if (import.meta.env.VITE_AREAS_TESTHOOKS === "1" && typeof window !== "undefined") (window as unknown as { __allHeld: typeof held }).__allHeld = held;

/** T-335 All v2: where the composer is replying, if anywhere. A room that left All drops it. */
export function useReplyTarget(rooms: readonly AllRoom[]): [ReplyTarget | null, (t: ReplyTarget | null) => void] {
  // only the target: a key typed in the composer doesn't redraw the home or the feed
  const [target, setTarget] = useState(held.target);
  useLayoutEffect(() => {
    const look = () => setTarget(held.target);
    look();
    watchers.add(look);
    return () => { watchers.delete(look); };
  }, []);
  const choose = useCallback((t: ReplyTarget | null) => setHeld(t ? { target: t, taps: held.taps + 1 } : { target: null }), []);
  const gone = !!target && rooms.length > 0 && !rooms.some((r) => r.id === target.room);
  useEffect(() => { if (gone) choose(null); }, [gone, choose]);
  return [gone ? null : target, choose];
}

/** A reply on its way or just sent, shown at once in the feed. */
export type Echo = { key: string; room: string; root: string | null; body: string; ts: number; ref: string | null; sending: boolean };
export type EchoSend = { start: (e: Pick<Echo, "room" | "root" | "body">) => string; done: (key: string, ref: string | null) => void; fail: (key: string) => void };
/** Your replies from All: on screen in the same frame as Send, until the room's own copy is read (a thread's reply stays: it isn't in the room's timeline). */
export function useEchoes(byRoom: ReadonlyMap<string, readonly FeedMessage[]>): { shown: Echo[]; send: EchoSend } {
  const [echoes, setEchoes] = useState<Echo[]>([]);
  const send = useMemo<EchoSend>(() => ({
    start: (e) => { const key = crypto.randomUUID(); setEchoes((l) => [...l.slice(-19), { ...e, key, ts: Date.now() / 1000, ref: null, sending: true }]); return key; },
    done: (key, ref) => setEchoes((l) => l.map((x) => (x.key === key ? { ...x, ref, sending: false } : x))),
    fail: (key) => setEchoes((l) => l.filter((x) => x.key !== key)),
  }), []);
  const shown = useMemo(() => echoes.filter((e) => e.root || !e.ref || !byRoom.get(e.room)?.some((m) => m.ref === e.ref)), [echoes, byRoom]);
  return { shown, send };
}

export function AllComposer({ rooms, words, onOpen, onFocus, onSent, place = "places", target = null, onTarget, echo, onKeyboard }: { rooms: readonly AllRoom[];
  /** Rooms just sent to. */ onSent?: (ids: string[]) => void;
  /** The field took focus (the home reads the rooms' words then, not before). */ onFocus?: () => void;
  /** Each room's recent words (the route's second rule) and when you last wrote there (its third). */ words: ReadonlyMap<string, RoomWords>;
  /** Opens a room (a sent-to line's link). */ onOpen: (id: string) => void;
  /** Where it sits: in the middle of the home, or under the All feed. */ place?: "places" | "all";
  /** Replying in this room or thread: no route, no model, Send posts there. */ target?: ReplyTarget | null; onTarget?: (t: ReplyTarget | null) => void;
  /** Shows a reply in the feed at once. */ echo?: EchoSend;
  /** The field has the keyboard. */ onKeyboard?: (on: boolean) => void }) {
  // null: follow Uni's suggestion; a list: the person's own choice, kept until it is sent or cleared
  const { text, chosen, sending, outcome, lost, attempt, taps } = useHeld();
  const [adding, setAdding] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const nameOf = useMemo(() => new Map(rooms.map((r) => [r.id, r.name])), [rooms]);
  // the rooms' words are read once per change of rooms or words; each key then routes the text as it is now, so Send always goes
  // where the chips on screen say
  const route = useMemo(() => makeRouter(rooms.map((r): RouteRoom => ({ id: r.id, name: r.name, slug: r.slug, text: `${r.stands ?? ""} ${words.get(r.id)?.text ?? ""}`, lastTs: r.lastTs, lastMine: words.get(r.id)?.lastMine ?? null }))), [rooms, words]);
  const wordPicks = useMemo(() => (text.trim() && !target ? route(text) : []), [text, route, target]);
  // T-335 All v2: the small model, when nothing is targeted and no room is named; it never stands between a key and the chips
  const doorRooms = useMemo<DoorRoom[]>(() => rooms.map((r) => ({ id: r.id, name: r.name, about: (r.about || r.stands || "").slice(0, 200) })), [rooms]);
  const model = useModelRoute(text, doorRooms, !target && !wordPicks.some((p) => p.named), chosen !== null);
  const picks = useMemo(() => mergeRoute(wordPicks, model.picks.length ? model : null), [wordPicks, model]);
  // T-335 chat feel: a sure route is chosen for you (and named on Send); a guess is only offered, dashed, until you tap it
  const to = target ? [target.room] : (chosen ?? picks.filter((p) => p.sure).map((p) => p.id)).filter((id) => nameOf.has(id));
  // what you dropped stays on offer, dashed, so it is one tap back
  const offered = target ? [] : picks.filter((p) => (chosen || !p.sure) && nameOf.has(p.id) && !to.includes(p.id));
  const done = attempt && attempt.body === text ? attempt.done : null;
  // a partial send's rooms are skipped only for its own route; a reply goes where it says
  const left = target ? to : to.filter((id) => !done?.has(id));
  const why = chosen ? "your choice" : picks.length ? picks.filter((p) => p.sure).map((p) => p.why).filter((w, i, a) => a.indexOf(w) === i).join(", ") : "";
  // the route moved by itself just now (the model answered, a room's words changed), with the words the same: a Send already on its way was aimed
  // at the old one, so it waits a moment
  const routeKey = to.join(",");
  const lastRoute = useRef({ key: routeKey, text });
  const settling = useRef(0);
  const [routeMoved, setRouteMoved] = useState(false);
  useLayoutEffect(() => {
    if (lastRoute.current.text === text && lastRoute.current.key !== routeKey && routeKey && !chosen && !target) settling.current = performance.now() + SETTLE_MS;
    if (routeMoved && (lastRoute.current.key !== routeKey || lastRoute.current.text !== text || target)) setRouteMoved(false);
    lastRoute.current = { key: routeKey, text };
  });
  // the field grows with its text up to six lines
  useLayoutEffect(() => { const el = field.current; if (!el) return; el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 6 * 24 + 16)}px`; }, [text]);
  // a tapped message: the words go there next
  const seenTaps = useRef(taps);
  useEffect(() => { if (taps !== seenTaps.current) { seenTaps.current = taps; field.current?.focus({ preventScroll: true }); } }, [taps]);
  // leaving All with the field focused hands the phone's bottom bar back
  useEffect(() => () => onKeyboard?.(false), [onKeyboard]);

  const edit = (next: string[]) => setHeld({ chosen: next, outcome: null });
  /** One post, as the room's own composer does it: addressed to the room's Uni when Uni is a member there. The relay having it is sent, even if this
   *  device's own copy failed (putting the words back would invite a second one). */
  const postOnce = async (room: string, body: string, replyTo: string | null) => {
    const uni = findUniMember(await invoke<Member[]>("get_members", { channel: room }));
    try {
      const sent = await invoke<{ ref?: string } | null>("post_message", { channel: room, body, replyTo, recipients: uni ? [uni.pubkey] : [], media: [] });
      return { ref: sent?.ref ?? null, uni: !!uni };
    } catch (e) {
      if (relayAccepted(e)) return { ref: (e as { eventId: string }).eventId, uni: !!uni };
      throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : "the relay refused it");
    }
  };

  /** Empty in the same frame, your words in the feed at once; on a failure the words and the chip come back, with why. */
  async function reply(t: ReplyTarget) {
    const body = held.text.trim();
    if (!body || held.sending) return;
    const era = held.era;
    setHeld({ text: "", target: null, chosen: null, outcome: null });
    const key = echo?.start({ room: t.room, root: t.root, body });
    try {
      const sent = await postOnce(t.room, body, t.root);
      if (key) echo?.done(key, sent.ref);
      if (era !== held.era) return;
      // the feed shows it went; the home has no feed, so it says so
      const shown = place === "all" ? [] : [t.room];
      if (!sent.uni || shown.length) setHeld({ outcome: { sent: shown, failed: [], noUni: sent.uni ? [] : [t.room] } });
      onSent?.([t.room]);
    } catch (e) {
      if (key) echo?.fail(key);
      if (era !== held.era) return;
      const error = String(e instanceof Error ? e.message : e).replace(/^Error:\s*/, "").slice(0, 160);
      const here = !held.target || sameTarget(held.target, t);
      if (here && !held.text.trim()) setHeld({ text: body, target: t, outcome: { sent: [], failed: [{ id: t.room, error }], noUni: [] } });
      else if (held.target && sameTarget(held.target, t)) setHeld({ text: `${body}\n${held.text}`, outcome: { sent: [], failed: [{ id: t.room, error }], noUni: [] } });
      // the composer has moved on: its new words stay where they were going
      else setHeld({ lost: [...held.lost, { body, target: t, error }] });
    }
  }

  async function send() {
    if (held.sending) return;
    if (held.target) { await reply(held.target); return; }
    const sentText = held.text, body = sentText.trim();
    if (!body || !left.length) return;
    if (!held.chosen && performance.now() < settling.current) { setRouteMoved(true); return; }
    setRouteMoved(false);
    const run = held.attempt && held.attempt.body === sentText ? held.attempt : { body: sentText, done: new Set<string>() };
    setHeld({ attempt: run, sending: true, outcome: null });
    const noUni: string[] = [];
    const post = async (room: string, b: string) => { const r = await postOnce(room, b, null); if (!r.uni) noUni.push(room); };
    const edited = held.chosen !== null, era = held.era;
    try {
      const r = await sendEach(to, body, post, run.done);
      if (era !== held.era) return;
      setHeld({ outcome: { sent: to.filter((id) => run.done.has(id)), failed: r.failed, noUni } });
      if (r.sent.length) {
        onSent?.(r.sent);
        logOutcome({ suggestion: model.suggestion, model: model.picks.map((p) => p.id), modelState: model.state, words: wordPicks.map((p) => p.id), sent: r.sent, edited });
      }
      // delivered: the sent words go; anything written since stays
      if (!r.failed.length) {
        setAdding(false);
        const since = held.text.startsWith(sentText) ? held.text.slice(sentText.length).trimStart() : held.text;
        // drawn now: a key already on its way must see the field without the sent words, or it would bring them back
        flushSync(() => setHeld(since ? { text: since, attempt: null } : { text: "", chosen: null, attempt: null }));
      }
    } finally { if (era === held.era) setHeld({ sending: false }); }
  }

  const named = (ids: readonly string[]) => andList(ids.map((id) => nameOf.get(id) ?? id));
  const targetRoom = target ? rooms.find((r) => r.id === target.room) ?? null : null;
  const where = targetRoom ? roomAddress(targetRoom) : "";
  const hasText = !!text.trim();
  return <section className={`all-compose all-compose-${place}`} aria-label="Talk to Uni"
    onFocusCapture={(e) => { if (e.target instanceof HTMLTextAreaElement) onKeyboard?.(true); }}
    onBlurCapture={(e) => { const box = e.currentTarget; requestAnimationFrame(() => onKeyboard?.(box.contains(document.activeElement))); }}>
    {target && targetRoom && <div className="all-route" role="group" aria-label="Where this goes">
      <span className="all-chip chosen all-reply-chip" data-room={target.room}>
        <span className="all-chip-name">Replying in {where}{target.root ? " · thread" : ""}</span>
        <button type="button" className="all-chip-x" aria-label={`Stop replying in ${where}`} onClick={() => { onTarget?.(null); field.current?.focus({ preventScroll: true }); }}>×</button>
      </span>
    </div>}
    {!target && hasText && <div className="all-route" role="group" aria-label="Where this goes">
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
      <textarea ref={field} rows={1} value={text} aria-label="Message for your rooms" onFocus={onFocus} placeholder={target ? `Reply in ${where}` : place === "all" ? "Say something, or tap a message" : "Talk to Uni"}
        onChange={(e) => setHeld({ text: e.target.value, outcome: null, attempt: held.attempt?.body === e.target.value ? held.attempt : null })}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !touchKeyboard()) { e.preventDefault(); void send(); } }} />
      <button type="button" className={`send all-send${hasText ? "" : " all-send-idle"}`} disabled={!hasText || !left.length || sending}
        aria-label={!hasText ? "Send" : left.length ? `Send to ${named(left)}` : "Choose a room to send to"} onClick={() => void send()}>
        {!hasText ? "↑" : sending ? "Sending…" : target ? "Send" : left.length > 1 ? `Send to ${left.length} rooms` : left.length ? `Send to ${nameOf.get(left[0])}` : "Choose a room"}
      </button>
    </div>
    {routeMoved && <p className="all-note" role="status">The route just changed. Check it, then send.</p>}
    {!target && hasText && !to.length && <p className="all-note" role="status">Pick a room, or keep typing. Nothing is sent until you do.</p>}
    {outcome && (outcome.sent.length > 0 || outcome.noUni.length > 0 || outcome.failed.length > 0) && <p className={`all-note${outcome.failed.length ? " all-failed" : ""}`} role="status">
      {outcome.sent.length > 0 && <>Sent to {outcome.sent.map((id, i) => <span key={id}>{i > 0 && (i === outcome.sent.length - 1 ? " and " : ", ")}<button type="button" className="all-link" onClick={() => onOpen(id)}>{nameOf.get(id)}</button></span>)}. </>}
      {outcome.noUni.length > 0 && <>Uni isn't in {named(outcome.noUni)}, so no Uni there was asked. </>}
      {outcome.failed.length > 0 && <>Couldn't send to {named(outcome.failed.map((f) => f.id))} ({outcome.failed[0].error}). Send again to try only {outcome.failed.length === 1 ? "that room" : "those rooms"}.</>}
    </p>}
    {lost.map((l, i) => <p key={i} className="all-note all-failed" role="status">Couldn't send "{l.body.length > 60 ? `${l.body.slice(0, 60)}…` : l.body}" to {nameOf.get(l.target.room) ?? "its room"} ({l.error}).{" "}
      <button type="button" className="all-link" disabled={hasText} title={hasText ? "Send or clear what's in the box first" : undefined} onClick={() => setHeld({ text: l.body, target: l.target, lost: held.lost.filter((x) => x !== l) })}>Put it back</button></p>)}
  </section>;
}

/** T-335 chat feel: a reply this long shows its start in All, and a way into its room for the rest. */
const isLong = (body: string) => body.length > 320 || body.split("\n").filter((l) => l.trim()).length > 4;
/** A room's own tint, from its id: the dot on its label. */
const tint = (id: string) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 38% 42%)`; };

const FeedRow = memo(function FeedRow({ m, place, address, mine, me, run, named, targeted, onOpen, onTap }: { m: Message; place: string; address: string; mine: boolean; me: string | null;
  /** The first message of a run from one room: it carries the room's label. */ run: boolean; /** Says who and when (a new author, or a pause). */ named: boolean;
  /** The composer is replying here. */ targeted: boolean;
  onOpen: (room: string, ref: string) => void; onTap: (m: Message) => void }) {
  const clamp = !mine && isLong(m.body);
  const replies = m.reply_count ?? 0;
  return <article className={`message all-msg${mine ? " mine" : ""}${run ? " run" : " grouped"}${clamp ? " clamped" : ""}${targeted ? " targeted" : ""}`} data-ref={m.ref} data-room={m.channel}
    onClick={(e) => {
      // T-335 All v2: a tap replies here; the room's label opens the room. Links and buttons stay themselves, and selecting text isn't a tap.
      if (e.target instanceof Element && e.target.closest("a, button, summary, input, textarea")) return;
      const picked = getSelection();
      if (picked && !picked.isCollapsed && picked.anchorNode && e.currentTarget.contains(picked.anchorNode)) return;
      onTap(m);
    }}>
    {run && <div className="all-run"><button type="button" className="all-place" style={{ ["--room-tint" as string]: tint(m.channel) }} aria-label={`Open ${place}, at this message`} onClick={() => onOpen(m.channel, m.ref)}>{place}</button>
      {!mine && <strong>{m.author_name}</strong>}<time>{clock(m.ts)}</time></div>}
    <div className="message-content">
      {named && !run && !mine && <div className="all-meta"><strong>{m.author_name}</strong><time>{clock(m.ts)}</time></div>}
      {m.body.trim() ? <Body body={m.body} mentions={m.mentions ?? []} me={me} edited={m.edited} />
        : <p className="all-file">{m.media?.length ? `${m.media.length === 1 ? "A file" : `${m.media.length} files`}: open the room to see ${m.media.length === 1 ? "it" : "them"}` : "(nothing to show here)"}</p>}
      {clamp && <button type="button" className="all-rest" onClick={() => onOpen(m.channel, m.ref)}>Read the rest in {place} ›</button>}
      {replies > 0 && <p className="all-thread">{replies} {replies === 1 ? "reply" : "replies"}</p>}
    </div>
    <button type="button" className="all-reply-go" aria-label={`Reply in ${address}${m.root || replies ? ", in the thread" : ""}`} aria-pressed={targeted} onClick={() => onTap(m)}>Reply</button>
  </article>;
});
/** Your reply, shown from the moment you sent it. */
function EchoRow({ e, place }: { e: Echo; place: string }) {
  return <article className="message all-msg mine run all-echo" data-room={e.room}>
    <div className="all-run"><span className="all-place" style={{ ["--room-tint" as string]: tint(e.room) }}>{place}</span><time>{clock(e.ts)}</time></div>
    <div className="message-content"><Body body={e.body} mentions={[]} me={null} edited={false} /></div>
    <p className="all-echo-state" role="status">{e.sending ? "Sending" : "Sent"}{e.root ? " in the thread" : ""}</p>
  </article>;
}
/** Not for All: progress pings, Uni's upkeep, the room buttons' commands and the gateway's answer to a stop. */
const notTalk = (m: FeedMessage) => isWorkerStatus(m.body) || isMaintenance(m.body) || !!commandOf(m.body) || isStopReply(m.body);

/** How far a finger must travel, sideways, for a swipe to mean "reply here"; touches this close to the screen's edge belong to the system. */
const SWIPE_PX = 64, EDGE_PX = 24;
const stillScreen = () => document.documentElement.dataset.screen === "ink" || matchMedia("(prefers-reduced-motion: reduce)").matches;

export function AllFeed({ rooms, byRoom, loaded, failed, me, onOpen, target = null, onTarget, echoes = [] }: { rooms: readonly AllRoom[]; byRoom: ReadonlyMap<string, Message[]>; loaded: boolean; failed: readonly string[];
  me: string | null; onOpen: (room: string, ref: string) => void;
  /** Where the composer is replying, and how a tap or a swipe sets it. */ target?: ReplyTarget | null; onTarget?: (t: ReplyTarget | null) => void;
  /** Your replies not yet in their room's list. */ echoes?: readonly Echo[] }) {
  const nameOf = useMemo(() => new Map(rooms.map((r) => [r.id, r.name])), [rooms]);
  const addressOf = useMemo(() => new Map(rooms.map((r) => [r.id, roomAddress(r)])), [rooms]);
  const feed = useMemo(() => interleave(new Map([...byRoom].filter(([id]) => nameOf.has(id)).map(([id, list]) => [id, list.filter((m) => !notTalk(m))]))), [byRoom, nameOf]);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // the message being replied to (the tapped one): when the keyboard takes the room, it stays in sight
  const [tapped, setTapped] = useState<string | null>(null);
  const tappedRef = useRef<string | null>(null);
  tappedRef.current = target ? tapped : null;
  const keepTapped = useCallback(() => {
    const el = list.current, ref = tappedRef.current;
    const row = el && ref ? el.querySelector(`article[data-ref="${CSS.escape(ref)}"]`) : null;
    if (row) row.scrollIntoView({ block: "nearest" });
    return !!row;
  }, []);
  const targetRef = useRef(target);
  targetRef.current = target;
  const tap = useCallback((m: Message) => {
    const t = replyTargetOf(m);
    if (sameTarget(targetRef.current, t) && tappedRef.current === m.ref) { onTarget?.(null); setTapped(null); return; }
    setTapped(m.ref);
    onTarget?.(t);
  }, [onTarget]);
  // a sent reply: back to the newest, where it is
  const echoCount = echoes.length;
  const echoesWere = useRef(echoCount);
  useLayoutEffect(() => {
    const added = echoCount > echoesWere.current;
    echoesWere.current = echoCount;
    const el = list.current;
    if (added && el) { stick.current = true; el.scrollTop = el.scrollHeight; }
  }, [echoCount]);
  useLayoutEffect(() => { const el = list.current; if (el && stick.current && !tappedRef.current) el.scrollTop = el.scrollHeight; }, [feed]);
  useLayoutEffect(() => { keepTapped(); }, [tapped, target, keepTapped]);
  // the feed gets shorter (the route row appearing over the composer, the keyboard): still at its newest if it was, or still at the tapped message
  useEffect(() => {
    const el = list.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (!keepTapped() && stick.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, [keepTapped]);
  // a swipe sideways on a message is the same as a tap on it; up and down is the feed's own scroll (touch-action: pan-y)
  const swipe = useRef<{ id: number; x: number; y: number; el: HTMLElement; ref: string; on: boolean } | null>(null);
  const swiped = useRef(-Infinity);
  const endSwipe = () => { const s = swipe.current; if (s) s.el.style.transform = ""; swipe.current = null; };
  const rows: React.ReactNode[] = [];
  let prev: { channel: string; author: string; ts: number } | null = null;
  const items: (Message | Echo)[] = [...feed, ...echoes].sort((a, b) => a.ts - b.ts);
  for (const m of items) {
    const sameDay = !!prev && new Date(prev.ts * 1000).toDateString() === new Date(m.ts * 1000).toDateString();
    if (!sameDay) rows.push(<div key={`d-${"ref" in m && m.ref ? m.ref : (m as Echo).key}`} className="day-divider" role="separator"><span>{dayLabel(m.ts)}</span></div>);
    if ("key" in m) { rows.push(<EchoRow key={m.key} e={m} place={nameOf.get(m.room) ?? "Room"} />); prev = { channel: m.room, author: me ?? "", ts: m.ts }; continue; }
    // T-335 chat feel: runs, not a mirror: the room's label only where the room changes; inside a run, who speaks when the author changes
    const run = !sameDay || prev!.channel !== m.channel;
    const named = run || prev!.author !== m.author || m.ts - prev!.ts >= 300;
    const targeted = !!target && tapped === m.ref && target.room === m.channel;
    rows.push(<FeedRow key={`${m.channel}:${m.ref}`} m={m} place={nameOf.get(m.channel) ?? "Room"} address={addressOf.get(m.channel) ?? "this room"} mine={!!me && m.author === me} me={me} run={run} named={named} targeted={targeted} onOpen={onOpen} onTap={tap} />);
    prev = m;
  }
  return <div className="all-feed" ref={list} role="log" aria-label="All rooms, by time" aria-live="polite"
    onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
    onPointerDown={(e) => {
      if (e.pointerType !== "touch" || e.clientX < EDGE_PX || e.clientX > innerWidth - EDGE_PX || !(e.target instanceof Element)) return;
      if (e.target.closest("pre, table, .md-table-wrap, a, button, video, audio, input, textarea, summary")) return;
      const el = e.target.closest<HTMLElement>("article.all-msg:not(.all-echo)");
      if (el?.dataset.ref) swipe.current = { id: e.pointerId, x: e.clientX, y: e.clientY, el, ref: el.dataset.ref, on: false };
    }}
    onPointerMove={(e) => {
      const s = swipe.current;
      if (!s || s.id !== e.pointerId) return;
      const dx = e.clientX - s.x, dy = e.clientY - s.y;
      if (!s.on && Math.abs(dx) > 14 && Math.abs(dx) > 2 * Math.abs(dy)) s.on = true;
      if (s.on && !stillScreen()) s.el.style.transform = `translateX(${Math.max(-SWIPE_PX, Math.min(SWIPE_PX, dx)) / 2}px)`;
    }}
    onPointerUp={(e) => {
      const s = swipe.current;
      if (!s || s.id !== e.pointerId) return;
      const hit = s.on && Math.abs(e.clientX - s.x) >= SWIPE_PX ? feed.find((m) => m.ref === s.ref) : null;
      if (s.on) swiped.current = performance.now();
      endSwipe();
      if (hit) tap(hit);
    }}
    onPointerCancel={endSwipe}
    // the click a swipe's lifted finger may leave behind isn't a tap
    onClickCapture={(e) => { if (performance.now() - swiped.current < 350) { swiped.current = -Infinity; e.stopPropagation(); } }}>
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
