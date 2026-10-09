import { useEffect, useRef, useState, type ReactNode } from "react";
import { cleanText } from "../interface/contract";
import { unreadAfter } from "./areaLayout";
import type { RoomMessage } from "../interface/modules/chat";

/** What the area view needs from the host's real room view (App owns it): its messages, and its pane (message list + composer). */
export type AreaRoom = {
  id: string;
  messages: RoomMessage[];
  /** The messages of this room are in `messages` (not a previous room's). */
  loaded: boolean;
  me: string | null;
  /** The room's own message list and composer; `above` is drawn directly over the composer. */
  render(above: ReactNode): ReactNode;
  /** Add text to the composer's draft (after any existing draft; never sends). */
  compose(text: string): void;
};

/** The area has no room, or the room is still opening. */
export function EmptyChat({ hasRoom }: { hasRoom: boolean }) {
  return <p className="area-chat-empty area-quiet" role="status">{hasRoom ? "Opening the room…" : "This area has no room yet"}</p>;
}

/** Switch between an area's rooms (metadata.channel lists several). */
export function RoomChips({ channels, selected, roomName, onPick }: { channels: readonly string[]; selected: string | null; roomName: (id: string) => string; onPick: (id: string) => void }) {
  return <div className="room-chips" role="group" aria-label="Rooms">{channels.map((id) =>
    <button key={id} type="button" className={`room-chip ${id === selected ? "on" : ""}`} aria-pressed={id === selected} onClick={() => onPick(id)}>#{roomName(id)}</button>)}</div>;
}

const DRAG = 30;

/** Phone: the chat as a pull-up sheet. Collapsed it is a peek bar (last message, unread count). */
export function ChatSheet({ room, hasRoom, above, rooms, forceOpen, poke, label }: { room: AreaRoom | null; hasRoom: boolean; above: ReactNode; rooms: ReactNode; forceOpen: number; poke: number; label: string }) {
  const [open, setOpen] = useState(false);
  const interactive = !!room;
  // A suggestion arriving while the sheet is down opens it: the bar and the composer live inside.
  const seenForce = useRef(forceOpen);
  useEffect(() => { if (forceOpen > seenForce.current && interactive) setOpen(true); seenForce.current = forceOpen; }, [forceOpen, interactive]);
  // A draft dropped in the composer (Ask Uni) opens the sheet the same way.
  const seenPoke = useRef(poke);
  useEffect(() => { if (poke > seenPoke.current && interactive) setOpen(true); seenPoke.current = poke; }, [poke, interactive]);
  const [marker, setMarker] = useState<string | null | undefined>(undefined);
  const last = room?.messages[room.messages.length - 1];
  useEffect(() => { if (room?.loaded && (open || marker === undefined)) setMarker(last?.ref ?? null); }, [room?.loaded, open, last?.ref, marker]);
  const unread = room && marker !== undefined ? unreadAfter(room.messages, marker, room.me) : 0;
  const drag = useRef<{ y: number; moved: boolean } | null>(null);
  const swallow = useRef(false);
  const peek = !hasRoom ? "This area has no room yet" : !room ? "Opening the room…" : !last ? "No messages yet" : null;
  return <section className={`area-chat sheet ${open ? "open" : ""}`} aria-label={label}>
    <button type="button" className="sheet-peek" aria-expanded={open} aria-controls="area-chat-body" disabled={!interactive}
      onPointerDown={(e) => { drag.current = { y: e.clientY, moved: false }; e.currentTarget.setPointerCapture?.(e.pointerId); }}
      onPointerMove={(e) => { if (drag.current && Math.abs(e.clientY - drag.current.y) > 8) drag.current.moved = true; }}
      onPointerUp={(e) => {
        const d = drag.current; drag.current = null;
        if (!d?.moved || !interactive) return;
        const dy = e.clientY - d.y;
        if (dy <= -DRAG) setOpen(true); else if (dy >= DRAG) setOpen(false);
        swallow.current = true;
      }}
      onPointerCancel={() => { drag.current = null; }}
      onClick={() => { if (swallow.current) { swallow.current = false; return; } setOpen((v) => !v); }}>
      <span className="sheet-grip" aria-hidden="true" />
      <span className="peek-text">{peek ?? <><strong>{cleanText(last!.author_name || last!.author.slice(0, 8))}</strong> {cleanText(last!.body).replace(/\s+/g, " ")}</>}</span>
      {unread > 0 && !open && <b className="peek-unread" aria-label={`${unread} unread`}>{unread > 99 ? "99+" : unread}</b>}
      <span className="peek-chevron" aria-hidden="true">{open ? "⌄" : "⌃"}</span>
    </button>
    <div id="area-chat-body" className="sheet-body" inert={!open}>{rooms}{room ? room.render(above) : null}</div>
  </section>;
}
