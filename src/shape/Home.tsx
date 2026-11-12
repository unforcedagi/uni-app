// T-335 the shape: home is the rooms list. Presentational: every piece of data and every action comes in through props, and the
// ask and run lines are drawn by the host (`renderAsk`, `renderRun`), so this file knows nothing of where they come from.
import type { MouseEvent, ReactNode } from "react";
import { SearchIcon } from "../Icons";
import "./shape.css";
import { unreadShort, unreadWords } from "../areas/roomUnread";
import { ago, lastLine, roomGlyph } from "./homeCore";
import type { Card } from "./oneAsk";
import type { HomeRow, RoomRun, ShapeRoom } from "./types";

export type HomeProps = {
  rows: HomeRow[];
  /** Unix seconds: what the row times are read against. */
  now: number;
  loading: boolean;
  error?: string | null;
  onOpenRoom(id: string): void;
  onSearch(): void;
  /** (T-335 one ask) A card on a room's row: its asks, tasks and approvals alike (approvals are no longer pinned over the rooms). */
  renderAsk(card: Card, room: ShapeRoom): ReactNode;
  renderRun(run: RoomRun, room: ShapeRoom): ReactNode;
  emptyHint?: ReactNode;
  /** Asks kept out of sight (private, with no private room of their own on this device): home says how many, never a word of them. */
  unseen?: number;
};

/** Asks shown on a row; the rest are "N more in the room". */
const ROW_ASKS = 2;

export function Home(p: HomeProps) {
  const { rows, now, loading, error } = p;
  return <div className="sh-home">
    <div className="sh-top">
      <h1>Rooms</h1>
    </div>
    <button type="button" className="sh-find" onClick={p.onSearch}><SearchIcon /><span>Search rooms and the journal</span></button>
    {error && <p className="sh-home-note sh-home-error" role="alert">{error}</p>}
    {(p.unseen ?? 0) > 0 && <p className="sh-home-note sh-home-unseen" role="status" data-unseen={p.unseen}><span className="sh-mark-needs" aria-hidden="true">◆{"\uFE0E"}</span> {p.unseen === 1 ? "1 more thing waits" : `${p.unseen} more things wait`} in a private place. This device doesn't show {p.unseen === 1 ? "it" : "them"}.</p>}
    {rows.length > 0
      ? <ul className="sh-rows">{rows.map((r) => <Row key={r.room.id} row={r} now={now} onOpenRoom={p.onOpenRoom} renderAsk={p.renderAsk} renderRun={p.renderRun} />)}</ul>
      : loading
        ? <p className="sh-home-note" role="status">Reading your rooms…</p>
        : !error && <div className="sh-home-empty">{p.emptyHint ?? <p>No rooms yet. When Uni or someone writes to you, the room shows here.</p>}</div>}
  </div>;
}

const interactive = (el: EventTarget | null, row: HTMLElement) => {
  const hit = (el as HTMLElement | null)?.closest?.("button, a, input, textarea, select, [role='button'], [tabindex]");
  return !!hit && hit !== row && row.contains(hit);
};

function Row({ row, now, onOpenRoom, renderAsk, renderRun }: { row: HomeRow; now: number } & Pick<HomeProps, "onOpenRoom" | "renderAsk" | "renderRun">) {
  const { room, runs, asks, unread, mention } = row;
  const last = lastLine(room);
  const open = () => onOpenRoom(room.id);
  // the open button covers the name and last line; a tap anywhere else on the row that isn't a control opens the room too
  const onRowClick = (e: MouseEvent<HTMLLIElement>) => { if (!interactive(e.target, e.currentTarget)) open(); };
  const shown = asks.slice(0, ROW_ASKS);
  const more = asks.length - shown.length;
  // what wants you here, as the bar counts it: every card, the ones "in the room" and a private room's wordless ones
  const wants = asks.length + (row.hushed ?? 0);
  return <li className={`sh-row${unread > 0 ? " sh-unread" : ""}`} data-room={room.id} data-wants={wants || undefined} onClick={onRowClick}>
    <div className="sh-glyph" aria-hidden="true">{roomGlyph(room.name)}</div>
    <button type="button" className="sh-row-open" onClick={(e) => { e.stopPropagation(); open(); }}>
      <span className="sh-row-head">
        <span className="sh-row-name">{room.name}</span>
        {unread > 0 && <><span className={`sh-unread-pill${mention ? " sh-mention" : ""}`} aria-hidden="true">{mention ? "@ " : ""}{unreadShort(unread)}</span><span className="sh-vh">, {unreadWords({ n: unread, mention })}</span></>}
        {row.at > 0 && <span className="sh-row-time">{ago(row.at, now)}</span>}
      </span>
      {(last.text || last.who) && <span className="sh-row-last">{last.who && <b>{last.who}:</b>}{last.who ? " " : ""}{last.text}</span>}
    </button>
    {runs.moving && <div className="sh-row-slot">{renderRun(runs.moving, room)}</div>}
    {shown.map((a) => <div key={a.id} className="sh-row-slot">{renderAsk(a, room)}</div>)}
    {more > 0 && <button type="button" className="sh-row-more" onClick={(e) => { e.stopPropagation(); open(); }}>+{more} more in the room</button>}
    {/* a private room's asks: that something waits, never what (it is answered inside the room) */}
    {(row.hushed ?? 0) > 0 && <p className="sh-row-slot sh-row-hush" data-hushed={row.hushed}><span className="sh-mark-needs" aria-hidden="true">◆{"︎"}</span> Something waits in here</p>}
    {runs.waiting && asks.length === 0 && !row.hushed && <div className="sh-row-slot">{renderRun(runs.waiting, room)}</div>}
  </li>;
}
