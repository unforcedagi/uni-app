// T-335 the shape: the surface the App shows for the rooms. With no room in focus it is home (the rooms, newest first, what moves and what
// wants you); with one, it is that room: its head, the strip (what moves there, what waits on you), and the room's own chat, which the App
// builds (one send path, one draft per room), with the room's asks drawn as messages at its end. A run's story opens as a sheet over either.
import { useCallback, type ReactNode } from "react";
import { Home } from "./Home";
import { RoomFrame, RoomStrip } from "./RoomFrame";
import { RunLine } from "./RunLine";
import { RunStory } from "./RunStory";
import { AskMessage } from "./AskMessage";
import type { Ask, Pin, RoomRun, ShapeRoom } from "./types";
import type { ShapeData } from "./useShape";
import { Clock } from "./Home";
import { SealedCard } from "../SealedCard";
import "./shape.css";

/** A run's story as the App holds it: the run, and the room it is in (for the sheet's "in <room>"). */
export type StoryOpen = { run: RoomRun; room: string };

/** Scrolls the room's chat to an ask and marks it for a moment (the strip's "Waits on you"). */
export function jumpToAsk(id: string) {
  const el = document.querySelector<HTMLElement>(`.sh-ask-msg[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center" });
  el.classList.remove("sh-flash");
  void el.offsetWidth; // the mark starts again on a second tap
  el.classList.add("sh-flash");
  window.setTimeout(() => el.classList.remove("sh-flash"), 1800);
}

/** Uni's approval card pinned over the rooms as it is in its room, so Approve works in place (the card reads its own checked view). It
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
  /** Back from the room: out of a thread first, then home. */ onBack: () => void;
  onSearch: () => void;
  onSettings: () => void;
  onOpenNote: (id: string) => void;
  onOpenLink: (url: string) => void;
  emptyHint?: ReactNode;
}) {
  const { shape, focus, story, onStory } = p;
  const { asks } = shape;
  const nameOf = (id: string) => p.rooms.find((r) => r.id === id)?.name.replace(/^#/, "") ?? "";
  const openStory = useCallback((run: RoomRun, room: string) => onStory({ run, room }), [onStory]);
  const closeStory = useCallback(() => onStory(null), [onStory]);
  const ask = (a: Ask, compact: boolean) => <AskMessage ask={a} compact={compact} busy={asks.busy.has(a.id)} error={asks.errors.get(a.id)}
    onAnswer={asks.answer} onSeen={asks.seen} onOpenLink={p.onOpenLink} />;

  // (a room gone from the list while it is open: the App's re-read of the rooms takes it out of focus)
  const room = focus ? p.rooms.find((r) => r.id === focus.room) ?? null : null;

  const sheet = story && <RunStory key={story.run.id} vault={p.vault} run={story.run} roomName={nameOf(story.room)} onClose={closeStory} onOpenNote={(id) => { closeStory(); p.onOpenNote(id); }} />;

  if (!focus) return <>
    <div className="sh-scroll">
      <Home rows={shape.rows} pins={shape.pins} now={shape.now} loading={p.loading} onOpenRoom={p.onOpenRoom} onSearch={p.onSearch} onSettings={p.onSettings}
        renderAsk={(a) => ask(a, true)} renderRun={(run, r) => <RunLine run={run} where="row" onOpen={(x) => openStory(x, r.id)} />}
        renderPin={(pin) => (pin.sealed ? <SealedPin pin={pin} onLapse={shape.onPinLapsed} /> : null)} onPinLapsed={shape.onPinLapsed} emptyHint={p.emptyHint} />
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
        {waits && <RunLine key="waits" run={waits} where="strip" onOpen={(r) => (first ? jumpToAsk(first.id) : openStory(r, id))} />}
      </RoomStrip>}>
      {p.chat ? p.chat(tail) : <p className="sh-home-note" role="status">Opening the room…</p>}
    </RoomFrame>
    {sheet}
  </>;
}
