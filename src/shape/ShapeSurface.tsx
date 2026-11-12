// T-335 the shape: the surface the App shows for the rooms. With no room in focus it is home (the rooms, newest first, what moves and what
// wants you); with one, it is that room: its head, the strip (what moves there, what waits on you), and the room's own chat, which the App
// builds (one send path, one draft per room), with the room's asks drawn as messages at its end. A run's story, or an ask opened to its
// context (T-335 fixes: every "waits on you" opens the same sheet, with its buttons and Archive), opens as a sheet over either.
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Home } from "./Home";
import { RoomFrame, RoomStrip } from "./RoomFrame";
import { RunLine } from "./RunLine";
import { RunStory } from "./RunStory";
import { AskMessage } from "./AskMessage";
import { AskSheet } from "./AskSheet";
import { askForRun, replyQuote, type AskButton } from "./asksCore";
import type { Ask, Pin, RoomRun, ShapeRoom } from "./types";
import type { ShapeData } from "./useShape";
import { Clock } from "./Home";
import { SealedCard } from "../SealedCard";
import "./shape.css";

/** The sheet over home or a room, as the App holds it (its Back and Escape close it): a run's story (the run, and the room it is in, for the
 *  sheet's "in <room>"), or an ask opened to its context (T-335 fixes) by its id. */
export type StoryOpen = { run: RoomRun; room: string } | { ask: string };

/** Uni's approval card pinned over the rooms as it is in its room (never a private room's: home draws that one without words), so Approve works in place (the card reads its own checked view). It
 *  leaves when it is answered (the waiting list is read again) or when its clock runs out. */
function SealedPin({ pin, onLapse }: { pin: Pin; onLapse: () => void }) {
  return <section className="sh-pin sh-pin-sealed" aria-label={`Approval in ${pin.roomName}`} data-ref={pin.ref}>
    <div className="sh-pin-head">
      <span className="sh-mark-needs" aria-hidden="true">◆{"\uFE0E"}</span>
      <span className="sh-pin-room">{pin.roomName}</span>
      <Clock expires={pin.expires} onLapse={onLapse} />
    </div>
    <SealedCard channel={pin.room} reference={pin.ref} />
  </section>;
}

export function ShapeSurface(p: {
  shape: ShapeData;
  rooms: readonly ShapeRoom[];
  /** The rooms list hasn't been read yet. */ loading: boolean;
  /** The room in focus (and a thread of it), or null: home. */ focus: { room: string; root: string | null } | null;
  vault: string;
  /** The room's chat (the App's), with `tail` drawn after its last message; null while the room is still being opened. */
  chat: ((tail: ReactNode) => ReactNode) | null;
  story: StoryOpen | null;
  onStory: (s: StoryOpen | null) => void;
  onOpenRoom: (id: string) => void;
  /** (T-335 asks in tune) Reply in the room: open the room's own chat with this text in its composer (never sent, never a new chat). */
  onReplyInRoom: (room: string, text: string) => void;
  /** Back from the room: out of a thread first, then home. */ onBack: () => void;
  onSearch: () => void;
  onOpenNote: (id: string) => void;
  onOpenLink: (url: string) => void;
  emptyHint?: ReactNode;
}) {
  const { shape, focus, story, onStory } = p;
  const { asks } = shape;
  const nameOf = (id: string) => p.rooms.find((r) => r.id === id)?.name.replace(/^#/, "") ?? "";
  const closeStory = useCallback(() => onStory(null), [onStory]);
  const openAsk = useCallback((a: Ask) => onStory({ ask: a.id }), [onStory]);
  // a run that waits on you opens the ask on its own task when there is one (its context and its buttons), else its story
  // (the vetted asks, by room; a private room's are opened only inside that room, never from home or another room)
  const listed = useMemo(() => [...asks.byRoom.values()].flat(), [asks.byRoom]);
  const here = focus?.room ?? null;
  const openStory = useCallback((run: RoomRun, room: string) => {
    const a = run.state === "waiting" ? askForRun(run, listed.filter((x) => !x.private || x.room === here)) : null;
    onStory(a ? { ask: a.id } : { run, room });
  }, [onStory, listed, here]);
  const act = useCallback((a: Ask, b: AskButton) => {
    if (b.act === "open") { p.onOpenLink(b.value); return; }
    if (b.act === "answer") void asks.answer(a, b.value);
    else if (b.act === "seen") void asks.seen(a);
    else if (b.act === "later") void asks.later(a, b.value);
    else if (b.act === "reply") { if (a.room) { onStory(null); p.onReplyInRoom(a.room, replyQuote(a)); } }
    else if (b.act === "done") void asks.done(a);
    else if (b.act === "archive") void asks.archive(a);
  }, [asks, p.onOpenLink, p.onReplyInRoom, onStory]); // eslint-disable-line react-hooks/exhaustive-deps
  const ask = (a: Ask, compact: boolean) => <AskMessage ask={a} compact={compact} busy={asks.busy.has(a.id)} error={asks.errors.get(a.id)}
    onAct={act} onOpen={openAsk} />;

  // (a room gone from the list while it is open: the App's re-read of the rooms takes it out of focus)
  const room = focus ? p.rooms.find((r) => r.id === focus.room) ?? null : null;

  // an ask's sheet stays while the ask is listed: answered, seen or archived, it leaves with it (a failed write brings the ask back, with why)
  // (while its write is out the ask is off the list: the sheet stays as it was, its buttons held; a write that fails brings the ask back with why)
  const listedAsk = story && "ask" in story ? listed.find((a) => a.id === story.ask && (!a.private || a.room === here)) ?? null : null;
  const lastAsk = useRef<Ask | null>(null);
  if (listedAsk) lastAsk.current = listedAsk;
  const writing = !!story && "ask" in story && lastAsk.current?.id === story.ask && asks.busy.has(story.ask);
  // (the held copy is judged as the list is: a private room's ask only inside that room)
  const held = writing && lastAsk.current && (!lastAsk.current.private || lastAsk.current.room === here) ? lastAsk.current : null;
  const openedAsk = listedAsk ?? held;
  useEffect(() => { if (story && "ask" in story && !openedAsk) onStory(null); }, [story, openedAsk, onStory]);
  const sheet = story && ("run" in story
    ? <RunStory key={story.run.id} vault={p.vault} run={story.run} roomName={nameOf(story.room)} onClose={closeStory} onOpenNote={(id) => { closeStory(); p.onOpenNote(id); }} />
    : openedAsk && <AskSheet key={openedAsk.id} vault={p.vault} ask={openedAsk} roomName={openedAsk.room ? nameOf(openedAsk.room) : ""} busy={asks.busy.has(openedAsk.id)}
      error={asks.errors.get(openedAsk.id)} onAct={act} onClose={closeStory} />);

  if (!focus) return <>
    <div className="sh-scroll">
      <Home rows={shape.rows} pins={shape.pins} now={shape.now} loading={p.loading} onOpenRoom={p.onOpenRoom} onSearch={p.onSearch}
        renderAsk={(a) => ask(a, true)} renderRun={(run, r) => <RunLine run={run} where="row" onOpen={(x) => openStory(x, r.id)} />}
        renderPin={(pin) => (pin.sealed && !pin.private ? <SealedPin pin={pin} onLapse={shape.onPinLapsed} /> : null)} onPinLapsed={shape.onPinLapsed} emptyHint={p.emptyHint} unseen={shape.unseen} />
    </div>
    {sheet}
  </>;

  const id = focus.room;
  const name = room?.name.replace(/^#/, "") || "Room";
  const runs = shape.runs.get(id);
  const mine = focus.root ? [] : asks.byRoom.get(id) ?? [];
  const first = mine[0];
  // what waits on you here: the first ask (a tap goes to it in the chat), else a run that waits on you (its story)
  const waits: RoomRun | null = first ? { id: first.id, state: "waiting", title: first.what, line: first.what, startedAt: null } : runs?.waiting ?? null;
  const owed = asks.owed.filter((o) => o.channel === id);
  const tail = (mine.length > 0 || owed.length > 0) ? <div className="sh-room-tail">
    {mine.map((a) => <div key={a.id} className="sh-room-ask">{ask(a, false)}</div>)}
    {owed.map((o) => <p key={o.id} className="sh-owed" role="status"><span>Your answer was saved, but the room didn't get it.{o.error ? ` (${o.error})` : ""}</span>
      <button type="button" className="sh-btn sh-btn-small" onClick={() => void asks.retry(o.id)}>Send again</button></p>)}
  </div> : null;
  return <>
    <RoomFrame name={name} onBack={p.onBack} onSearch={p.onSearch} backLabel={focus.root ? `Back to ${name}` : "Back to rooms"}
      title={focus.root ? <h1>{name}<span className="sh-room-sub"> · thread</span></h1> : undefined}
      strip={focus.root ? null : <RoomStrip>
        {runs?.moving && <RunLine key="moving" run={runs.moving} where="strip" onOpen={(r) => openStory(r, id)} />}
        {waits && <RunLine key="waits" run={waits} where="strip" onOpen={(r) => (first ? openAsk(first) : openStory(r, id))} />}
      </RoomStrip>}>
      {p.chat ? p.chat(tail) : <p className="sh-home-note" role="status">Opening the room…</p>}
    </RoomFrame>
    {sheet}
  </>;
}
