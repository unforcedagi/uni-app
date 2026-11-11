// T-335 the shape: a room is its chat plus a thin strip under the head. The frame only: the host builds the chat (with its
// composer) and the strip's rows, and hands them in.
import { Children, type ReactNode } from "react";
import { SearchIcon } from "../Icons";
import "./shape.css";

export type RoomFrameProps = {
  name: string;
  onBack(): void;
  onSearch(): void;
  /** The back button's spoken name; "Back to rooms" when not given. */
  backLabel?: string;
  /** The strip under the head: a `RoomStrip`, or null. */
  strip: ReactNode;
  /** The chat pane, already built by the host, including its composer. */
  children: ReactNode;
  /** Replaces the plain name in the head (the name is still the frame's label). */
  title?: ReactNode;
};

export function RoomFrame({ name, onBack, onSearch, backLabel = "Back to rooms", strip, children, title }: RoomFrameProps) {
  return <section className="sh-room" aria-label={name}>
    <div className="sh-top sh-room-top">
      <button type="button" className="sh-iconbtn sh-back" aria-label={backLabel} title={backLabel} onClick={onBack}><span aria-hidden="true">‹</span></button>
      {title ?? <h1>{name}</h1>}
      <button type="button" className="sh-iconbtn" aria-label="Search" title="Search" onClick={onSearch}><SearchIcon /></button>
    </div>
    {strip}
    <div className="sh-room-chat">{children}</div>
  </section>;
}

/** The strip's frame: paper ground, hairlines above and below, one between rows. Nothing at all when it has no rows. */
export function RoomStrip({ children }: { children?: ReactNode }) {
  const rows = Children.toArray(children);
  if (!rows.length) return null;
  return <div className="sh-strip">{rows}</div>;
}
