// T-335 one fluid surface: a room in focus, in All. Not a place you go to: the room's real conversation and composer come up over the feed, which
// recedes behind it and keeps its place. One tap on what shows of All, the Back button, Android Back, Escape, the rail's All or a swipe down on the
// head returns. On a calm screen nothing moves: the room is in full black inside a black edge, All behind it is pale.
// T-335 one surface: this is the only way a room is shown. Its head is the room's name and at most one labelled line; a tap on it opens the room's
// details in the same sheet (what needs you, its summary, its projects and sessions, all of its work, its app), never another screen.
import { useEffect, useRef, type ReactNode } from "react";
import { roomTint } from "../glow/roomTint";
import { calmScreen } from "../motion";
import { labelBack } from "./AllView";
import "./focus.css";

/** What the focus shows: the conversation, the room's details, all of its work, or its app. Back steps from right to left. */
export type FocusView = "chat" | "details" | "work" | "app";
/** The room in focus; `root`: a thread of it; `path`: the place it is open for (a place that talks in a room it borrows); `leaving`: on its way out, All already in reach. */
export type AllFocusState = { room: string; root: string | null; path?: string | null; view?: FocusView; leaving: boolean };
/** How long the way out takes (focus.css says the same): the room's pane stays until it has gone. */
export const FOCUS_OUT_MS = 170;
const PULL_PX = 72;

/** The head's one line: what it is (`src`, said first, so where it comes from is plain) and its words. */
export type FocusLine = { src: string; text: string };

export function AllFocusSheet({ id, name, line, root, replies, view = "chat", leaving, onBack, onView, details, children }: { id: string; name: string;
  /** The room's one line under its name (its summary, saying whose; or the room a place talks in), or nothing. */ line: FocusLine | null;
  /** In a thread of the room: Back steps to the room. */ root: string | null; replies: number | null;
  view?: FocusView; leaving: boolean; onBack: () => void; onView: (view: FocusView) => void;
  /** The room's details (or its work, or its app), shown in place of the conversation while `view` isn't the conversation. */ details: ReactNode; children: ReactNode }) {
  const sheet = useRef<HTMLElement>(null);
  // a coarse pointer keeps the keyboard down, so the reader gets the thread: the keys' place is the sheet. The label has them back at the end.
  useEffect(() => {
    if (matchMedia("(pointer: coarse)").matches) sheet.current?.focus({ preventScroll: true });
    return () => labelBack();
  }, []);
  // a pull that stepped from a thread to its room is over
  useEffect(() => { sheet.current?.style.removeProperty("--pull"); }, [root, view]);
  // a swipe down on the head puts the room back
  const pull = useRef<{ id: number; y: number } | null>(null);
  const setPull = (dy: number) => {
    const el = sheet.current;
    if (!el) return;
    el.style.setProperty("--pull", `${dy}px`);
    el.style.transform = dy ? `translateY(${dy}px)` : "";
  };
  const endPull = () => { pull.current = null; setPull(0); };
  /** a touch that moved (a pull on the head) is not also a tap on the titles */
  const moved = useRef(false);
  const inChat = view === "chat";
  const back = !inChat ? (view === "details" ? { label: "Chat", aria: `Back to the conversation in ${name}` } : { label: "Details", aria: `Back to ${name}'s details` })
    : root ? { label: name, aria: `Back to ${name}` } : { label: "All", aria: "Back to All" };
  const sub: FocusLine | null = view === "details" ? { src: "Room details", text: "" } : view === "work" ? { src: "All of its work", text: "" } : view === "app" ? { src: "Its app", text: "" }
    : root ? { src: `Thread${replies !== null ? ` · ${replies} ${replies === 1 ? "reply" : "replies"}` : ""}`, text: "" } : line;
  const region = view === "details" ? `${name} details` : view === "work" ? `${name}'s work` : `${name}'s app`;
  return <section ref={sheet} className="all-focus" role="region" tabIndex={-1} aria-label={`${name}, in focus`} data-leaving={leaving || undefined} data-view={view} style={{ ["--room-tint" as string]: roomTint(id) }}>
    <header className="all-focus-head"
      onPointerDown={(e) => { moved.current = false; if (e.pointerType === "touch") pull.current = { id: e.pointerId, y: e.clientY }; }}
      onPointerMove={(e) => { const p = pull.current; if (p && p.id === e.pointerId) { if (Math.abs(e.clientY - p.y) > 8) moved.current = true; if (!calmScreen()) setPull(Math.max(0, e.clientY - p.y)); } }}
      onPointerUp={(e) => {
        const p = pull.current;
        if (!p || p.id !== e.pointerId) return;
        pull.current = null;
        if (e.clientY - p.y >= PULL_PX) { sheet.current!.style.transform = ""; onBack(); } else setPull(0);
      }}
      onPointerCancel={endPull}>
      <button type="button" className="note-action all-focus-back" aria-label={back.aria} onClick={onBack}><span aria-hidden="true">←</span> {back.label}</button>
      {/* the name is the room's heading, and its button is the whole of the titles: the room's details, and from them (or its work) the conversation again */}
      {/* a tap anywhere on the titles (the name, its line, the chevron) is the button's; the button itself is the way for keys and screen readers */}
      <div className="all-focus-titles" onClick={(e) => { if (moved.current) { moved.current = false; return; } if (!(e.target as Element).closest(".all-focus-open")) onView(inChat ? "details" : "chat"); }}>
        <h2 className="all-focus-title"><button type="button" className="all-focus-open" aria-expanded={!inChat} aria-label={inChat ? `${name}: room details` : `${name}: back to the conversation`} title={inChat ? "Room details" : "Back to the conversation"}
          onClick={() => onView(inChat ? "details" : "chat")}>{name}</button></h2>
        {sub && <p className="all-focus-line"><span className="all-focus-src">{sub.src}{sub.text ? ":" : ""}</span>{sub.text && <> {sub.text}</>}</p>}
        <span className="all-focus-more" aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{inChat ? <path d="M4 6l4 4 4-4" /> : <path d="M4 10l4-4 4 4" />}</svg></span>
      </div>
    </header>
    {/* the conversation stays as it was (its place, its draft) while the details are up */}
    <div className="all-focus-chat" hidden={!inChat}>{children}</div>
    {!inChat && <section className="all-focus-details" role="region" aria-label={region}>{details}</section>}
  </section>;
}
