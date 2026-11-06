// T-335 one fluid surface: a room in focus, in All. Not a place you go to: the room's real conversation and composer (the same pane a room's page has) come
// up over the feed, which recedes behind it and keeps its place. One tap on what shows of All, the Back button, Android Back, Escape, the rail's All or a
// swipe down on the head returns. On a calm screen nothing moves: the room is in full black inside a black edge, All behind it is pale.
import { useEffect, useRef, type ReactNode } from "react";
import { roomTint } from "../glow/roomTint";
import { calmScreen } from "../motion";
import { labelBack } from "./AllView";
import "./focus.css";

/** The room in focus; `leaving`: on its way out, All already in reach. */
export type AllFocusState = { room: string; root: string | null; leaving: boolean };
/** How long the way out takes (focus.css says the same): the room's pane stays until it has gone. */
export const FOCUS_OUT_MS = 170;
const PULL_PX = 72;

export function AllFocusSheet({ id, name, stands, root, replies, leaving, onBack, onPage, children }: { id: string; name: string;
  /** The room's one line on where it stands (a private area's never comes here). */ stands: string | null;
  /** In a thread of the room: Back steps to the room. */ root: string | null; replies: number | null;
  leaving: boolean; onBack: () => void; /** The room's page: its work, its tree, where it stands in full. */ onPage: () => void; children: ReactNode }) {
  const sheet = useRef<HTMLElement>(null);
  // a coarse pointer keeps the keyboard down, so the reader gets the thread: the keys' place is the sheet. The label has them back at the end.
  useEffect(() => {
    if (matchMedia("(pointer: coarse)").matches) sheet.current?.focus({ preventScroll: true });
    return () => labelBack();
  }, []);
  // a pull that stepped from a thread to its room is over
  useEffect(() => { sheet.current?.style.removeProperty("--pull"); }, [root]);
  // a swipe down on the head puts the room back
  const pull = useRef<{ id: number; y: number } | null>(null);
  const setPull = (dy: number) => {
    const el = sheet.current;
    if (!el) return;
    el.style.setProperty("--pull", `${dy}px`);
    el.style.transform = dy ? `translateY(${dy}px)` : "";
  };
  const endPull = () => { pull.current = null; setPull(0); };
  return <section ref={sheet} className="all-focus" role="region" tabIndex={-1} aria-label={`${name}, in focus`} data-leaving={leaving || undefined} style={{ ["--room-tint" as string]: roomTint(id) }}>
    <header className="all-focus-head"
      onPointerDown={(e) => { if (e.pointerType === "touch") pull.current = { id: e.pointerId, y: e.clientY }; }}
      onPointerMove={(e) => { const p = pull.current; if (p && p.id === e.pointerId && !calmScreen()) setPull(Math.max(0, e.clientY - p.y)); }}
      onPointerUp={(e) => {
        const p = pull.current;
        if (!p || p.id !== e.pointerId) return;
        pull.current = null;
        if (e.clientY - p.y >= PULL_PX) { sheet.current!.style.transform = ""; onBack(); } else setPull(0);
      }}
      onPointerCancel={endPull}>
      <button type="button" className="note-action all-focus-back" aria-label={root ? `Back to ${name}` : "Back to All"} onClick={onBack}><span aria-hidden="true">←</span> {root ? name : "All"}</button>
      <div className="all-focus-titles">
        <h2 className="all-focus-title">{name}</h2>
        {root ? <p className="all-focus-stands">Thread{replies !== null ? ` · ${replies} ${replies === 1 ? "reply" : "replies"}` : ""}</p> : stands && <p className="all-focus-stands">{stands}</p>}
        {!root && <button type="button" className="all-focus-page" aria-label={`Open ${name}'s page`} title={`${name}'s page`} onClick={onPage}><span aria-hidden="true">›</span></button>}
      </div>
    </header>
    {children}
  </section>;
}
