// T-335 the shape: the surface the App shows for the rooms. With no room in focus it is home (the rooms, newest first, what moves and what
// wants you); with one, it is that room: its head, the strip (what moves there, what waits on you), and the room's own chat, which the App
// builds (one send path, one draft per room). T-335 one ask: every ask is one card (AskCard), drawn where it was asked when its message is
// in the chat (the App draws those), else after the chat; it opens in place (no sheet). A run's story still opens as a sheet over either.
import { useCallback, useMemo, type ReactNode } from "react";
import { Home } from "./Home";
import { RoomFrame, RoomStrip } from "./RoomFrame";
import { RunLine } from "./RunLine";
import { RunStory } from "./RunStory";
import { AskCard } from "./AskCard";
import { askForRun } from "./asksCore";
import type { Card, CardButton } from "./oneAsk";
import type { RoomRun, ShapeRoom } from "./types";
import type { ShapeData } from "./useShape";
import "./shape.css";

/** The sheet over home or a room, as the App holds it (its Back and Escape close it): a run's story (the run, and the room it is in, for the
 *  sheet's "in <room>"). (An ask opens in place: T-335 one ask.) */
export type StoryOpen = { run: RoomRun; room: string };

/** Sent before the surface scrolls a card into view: the App's chat lets go of its newest end (it would snap back while it settles). */
export const JUMP = "uni:jump-to-card";

/** What a card's button does that only moves the view (the rest are answers, shape.cards.act). */
export type CardHost = { onOpenLink: (url: string) => void; onOpenRoom: (id: string) => void; onAnswerInRoom: (card: Card) => void };

/** One card, as the App and this surface draw it (the App draws a room's ask where it was asked, in its chat). */
export function drawCard(shape: ShapeData, card: Card, place: "chat" | "tail" | "home", roomName: string, vault: string, host: CardHost): ReactNode {
  const act = (c: Card, b: CardButton) => {
    if (b.act === "open") host.onOpenLink(b.value);
    else if (b.act === "room") { if (c.room) host.onOpenRoom(c.room); }
    else if (b.act === "reply") host.onAnswerInRoom(c);
    else shape.cards.act(c, b);
  };
  return <AskCard key={card.id} card={card} place={place} roomName={roomName} vault={vault} busy={shape.cards.busy(card.id)} error={shape.cards.error(card.id)} onAct={act} now={shape.cards.now} />;
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
  /** (T-335 one ask) Reply in the room: open the card's room with the composer answering it (his words, sent, are its answer). */
  onAnswerInRoom: (card: Card) => void;
  /** The messages the room's chat holds now: a card asked by one of them is drawn there, not after the chat. */
  drawnAt: ReadonlySet<string>;
  /** Back from the room: out of a thread first, then home. */ onBack: () => void;
  onSearch: () => void;
  onOpenNote: (id: string) => void;
  onOpenLink: (url: string) => void;
  emptyHint?: ReactNode;
}) {
  const { shape, focus, story, onStory } = p;
  const nameOf = (id: string | null) => (id ? p.rooms.find((r) => r.id === id)?.name.replace(/^#/, "") ?? "" : "");
  const closeStory = useCallback(() => onStory(null), [onStory]);
  const here = focus?.room ?? null;
  const host: CardHost = { onOpenLink: p.onOpenLink, onOpenRoom: p.onOpenRoom, onAnswerInRoom: p.onAnswerInRoom };
  const card = (c: Card, place: "tail" | "home") => drawCard(shape, c, place, nameOf(c.room), p.vault, host);
  // a run that waits on you, when its task is an ask, is that ask: tapping it opens the ask's room (where the card is); else its story
  // (a private room's ask is reached only inside that room)
  const listed = useMemo(() => [...shape.asks.byRoom.values()].flat(), [shape.asks.byRoom]);
  const openStory = useCallback((run: RoomRun, room: string) => {
    const a = run.state === "waiting" ? askForRun(run, listed.filter((x) => !x.private || x.room === here)) : null;
    if (a?.room && a.room !== here) p.onOpenRoom(a.room);
    else if (a) { window.dispatchEvent(new Event(JUMP)); document.querySelector(`[data-card="${CSS.escape(a.id)}"]`)?.scrollIntoView({ block: "center" }); }
    else onStory({ run, room });
  }, [onStory, listed, here, p.onOpenRoom]); // eslint-disable-line react-hooks/exhaustive-deps
  const sheet = story && <RunStory key={story.run.id} vault={p.vault} run={story.run} roomName={nameOf(story.room)} onClose={closeStory} onOpenNote={(id) => { closeStory(); p.onOpenNote(id); }} />;

  if (!focus) return <>
    <div className="sh-scroll">
      <Home rows={shape.rows} now={shape.now} loading={p.loading} onOpenRoom={p.onOpenRoom} onSearch={p.onSearch}
        renderAsk={(c) => card(c, "home")} renderRun={(run, r) => <RunLine run={run} where="row" onOpen={(x) => openStory(x, r.id)} />}
        elsewhere={shape.elsewhere}
        emptyHint={p.emptyHint} unseen={shape.unseen} />
    </div>
    {sheet}
  </>;

  const id = focus.room;
  // (a room gone from the list while it is open: the App's re-read of the rooms takes it out of focus)
  const room = p.rooms.find((r) => r.id === id) ?? null;
  const name = room?.name.replace(/^#/, "") || "Room";
  const runs = shape.runs.get(id);
  // the room's cards: one asked by a message the chat holds is drawn there (by the App); the rest (tasks, older asks) after the chat
  const mine = focus.root ? [] : shape.cards.list.byRoom.get(id) ?? [];
  // (a Hermes prompt is answered in this room's composer, where its banner says so: not drawn again after the chat)
  const after = mine.filter((c) => c.source === "task" || (c.source !== "prompt" && !p.drawnAt.has(c.id)));
  const first = mine[0];
  // what waits on you here: the first card (a tap brings it into view), else a run that waits on you (its story)
  const waits: RoomRun | null = first ? { id: first.id, state: "waiting", title: first.what, line: first.what, startedAt: null } : runs?.waiting ?? null;
  // (a jump, as search's is: the chat stops holding its newest end in view, even in its first moments)
  const showFirst = () => { if (!first) return; window.dispatchEvent(new Event(JUMP)); document.querySelector(`.sh-room [data-card="${CSS.escape(first.id)}"]`)?.scrollIntoView({ block: "center" }); };
  const owed = shape.asks.owed.filter((o) => o.channel === id);
  const tail = (after.length > 0 || owed.length > 0) ? <div className="sh-room-tail">
    {after.map((c) => <div key={c.id} className="sh-room-ask">{card(c, "tail")}</div>)}
    {owed.map((o) => <p key={o.id} className="sh-owed" role="status"><span>Your answer was saved, but the room didn't get it.{o.error ? ` (${o.error})` : ""}</span>
      <button type="button" className="sh-btn sh-btn-small" onClick={() => void shape.asks.retry(o.id)}>Send again</button></p>)}
  </div> : null;
  return <>
    <RoomFrame name={name} onBack={p.onBack} onSearch={p.onSearch} backLabel={focus.root ? `Back to ${name}` : "Back to rooms"}
      title={focus.root ? <h1>{name}<span className="sh-room-sub"> · thread</span></h1> : undefined}
      strip={focus.root ? null : <RoomStrip>
        {runs?.moving && <RunLine key="moving" run={runs.moving} where="strip" onOpen={(r) => openStory(r, id)} />}
        {waits && <RunLine key="waits" run={waits} where="strip" onOpen={(r) => (first ? showFirst() : openStory(r, id))} />}
      </RoomStrip>}>
      {p.chat ? p.chat(tail) : <p className="sh-home-note" role="status">Opening the room…</p>}
    </RoomFrame>
    {sheet}
  </>;
}
