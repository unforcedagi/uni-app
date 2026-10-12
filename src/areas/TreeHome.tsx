// T-111: the tree home. Wide screens (Daylight, tablets): the map with a level panel beside it. Phones: a room tree, then a level.
// The panel reads like a page (the C layout of the prototypes): what is alive, what needs you, updates from the rooms below, what is
// inside, the other tasks, then the room, with the composer pinned under it. Styling is in tree.css (the Field Book tokens).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cleanText } from "../interface/contract";
import type { RoomMessage } from "../interface/modules/chat";
import { InlineText } from "./BriefView";
import { Body } from "../MessageBody";
import type { Area } from "./areasCore";
import type { AliveLine, LevelAlive } from "./treeAlive";
import { agoLabel, type RoomView, type TreeRow, type Update } from "./treeRooms";
import type { Mark } from "./nodeMap";

const CAP = 3;

/** A room as a door: its slash name when the node has one of its own, a dashed door "held by #x" when an ancestor holds it. */
export function RoomDoor({ view, className = "" }: { view: Pick<RoomView, "slash" | "heldBy" | "own">; className?: string }) {
  if (view.own && view.slash) {
    const parts = view.slash.split("/");
    return <span className={`th-door ${className}`} data-kind="own" title={`#${view.slash}`}>{parts.map((p, i) => i < parts.length - 1 ? <span key={i} className="th-door-p">{p}/</span> : <span key={i}>{p}</span>)}</span>;
  }
  return <span className={`th-door held ${className}`} data-kind="held">{view.heldBy ? `held by #${view.heldBy.name.toLowerCase().replace(/\s+/g, "-")}` : "no room"}</span>;
}

/** The room line under a title: the door, and nothing else. */
export function RoomLine({ view, target, onOpenRoom, context }: { view: Pick<RoomView, "slash" | "heldBy" | "own">; target?: { id: string; name: string } | null; onOpenRoom?: (id: string) => void; context?: boolean }) {
  return <p className="th-roomline"><RoomDoor view={view} />{context && view.own && <span className="th-ctx">this node's context window</span>}<OpenRoom target={target} onOpenRoom={onOpenRoom} /></p>;
}

/** "Open #atlas/build": the room's chat as a tab. A node held by an ancestor's room opens that room. Nothing when there is no room to open. */
export function OpenRoom({ target, onOpenRoom }: { target?: { id: string; name: string } | null; onOpenRoom?: (id: string) => void }) {
  if (!target || !onOpenRoom) return null;
  const name = target.name.replace(/^#/, "");
  return <button type="button" className="th-link th-openroom" aria-label={`Open #${name}`} title={`Open #${name} as a chat`} onClick={() => onOpenRoom(target.id)}>Open #{name}</button>;
}

/** The node glyph: growth rings are depth, the fill is the state. Shape first, so it reads in grayscale. */
export function Stump({ mark, kind, own }: { mark: Mark; kind: "root" | "area" | "project"; own?: boolean }) {
  return <i className={`th-stump ${own === false ? "held" : ""}`} data-st={mark} data-d={kind === "root" ? 0 : kind === "area" ? 1 : 2} aria-hidden="true" />;
}

/** A number that needs you, as a hang tag. */
export const Tag = ({ n, label }: { n: number; label?: string }) => <b className="th-tag" aria-label={label ?? `${n} need you`}>{n > 99 ? "99+" : n}</b>;

// ---------------------------------------------------------------------------------------------- the phone's tree

/** The room tree: Uni, then every area and project beneath it as nested rows, each with its room door and what needs you. */
export function RoomTree({ chat = true, rows, marks, needs, open, onOpen, selected }: {
  chat?: boolean; rows: readonly TreeRow[]; marks: ReadonlyMap<string, Mark>; needs: ReadonlyMap<string, number>; open: ReadonlyMap<string, number>;
  onOpen: (path: string) => void;
  /** The row of the level being shown (the wide layout keeps the tree beside it). */
  selected?: string;
}) {
  return <nav aria-label="Rooms and areas"><ul className="th-rows">{rows.map((r) => {
    const n = needs.get(r.path) ?? 0, o = open.get(r.path) ?? 0;
    return <li key={r.path || "uni"} className={`th-row d${Math.min(r.depth, 4)} ${r.last ? "last" : ""} ${selected === r.path ? "sel" : ""}`}>
      {r.depth > 0 && <span className="th-guides" aria-hidden="true">{Array.from({ length: r.depth }, (_, i) => <span key={i} className={`th-guide ${i === r.depth - 1 ? "branch" : r.trunk[i] ? "run" : ""}`} />)}</span>}
      <button type="button" className="th-go" data-path={r.path} aria-current={selected === r.path ? "page" : undefined} onClick={() => onOpen(r.path)}
        aria-label={`${r.name}${chat ? `, ${r.own && r.slash ? `room #${r.slash}` : r.heldBy ? `held by #${r.heldBy}` : "no room"}` : ""}${n ? `, ${n} need${n === 1 ? "s" : ""} you` : ""}${o ? `, ${o} open` : ""}`}>
        <Stump mark={marks.get(r.path) ?? "quiet"} kind={r.kind} own={r.own} />
        <span className="th-name"><b>{r.name}</b>
          {chat && <RoomDoor view={{ slash: r.slash, heldBy: r.heldBy ? { id: "", name: r.heldBy } : null, own: r.own }} className="th-rowdoor" />}</span>
        {n > 0 ? <Tag n={n} /> : o > 0 ? <span className="th-open" aria-hidden="true">{o}</span> : null}
      </button>
    </li>;
  })}</ul></nav>;
}

export function TreeScreen({ chat = true, rows, marks, needs, open, dateLine, summary, onOpen, status, selected, column }: {
  /** false (chat.provider null): no room doors or room names. */
  chat?: boolean;
  rows: readonly TreeRow[]; marks: ReadonlyMap<string, Mark>;
  /** Tasks that need you / are open, rolled up per node path. */
  needs: ReadonlyMap<string, number>; open: ReadonlyMap<string, number>;
  dateLine: string; summary: string; onOpen: (path: string) => void; status?: ReactNode;
  selected?: string;
  /** The left column beside a level (wide screens): no page title, the level has its own. */
  column?: boolean;
}) {
  return <div className={`tree-home th-phone-tree ${column ? "th-column" : ""}`}>
    <header className="th-treehead">
      <p className="th-cap">{dateLine}</p>
      {column ? <p className="th-colname">Rooms</p> : <h1 className="note-title">Uni</h1>}
      <p className="th-summary">{summary}</p>
    </header>
    {status}
    <RoomTree chat={chat} rows={rows} marks={marks} needs={needs} open={open} onOpen={onOpen} selected={selected} />
  </div>;
}

// ---------------------------------------------------------------------------------------------- the level panel

/** The panel's frame: the page scrolls, the composer stays at the bottom. */
export function LevelPanel({ head, children, foot, wide }: { head: ReactNode; children: ReactNode; foot: ReactNode; wide: boolean }) {
  return <section className={`th-panel ${wide ? "wide" : "phone"}`} aria-label="This level">
    <div className="th-scroll">{head}{children}</div>
    <div className="th-foot">{foot}</div>
  </section>;
}

export function Crumbs({ trail, onOpen }: { trail: readonly { path: string; name: string }[]; onOpen: (path: string) => void }) {
  return <nav className="th-crumbs" aria-label="Where you are">{trail.map((c, i) => i === trail.length - 1
    ? <span key={c.path || "uni"} className="th-crumb here" aria-current="page">{i > 0 && <i aria-hidden="true">›</i>}{c.name}</span>
    : <span key={c.path || "uni"} className="th-crumb-wrap">{i > 0 && <i aria-hidden="true">›</i>}<button type="button" className="th-crumb" onClick={() => onOpen(c.path)}>{c.name}</button></span>)}</nav>;
}

const Section = ({ id, title, count, children }: { id: string; title: string; count?: number; children: ReactNode }) =>
  <section className={`th-sec th-${id}`} aria-label={title}><h2 className="th-h"><span>{title}</span>{count !== undefined && <em>{count}</em>}</h2>{children}</section>;

/** What is alive: the lede, then what is moving. */
export function AliveBlock({ alive, onNote, kind, fresh, onRefresh }: { alive: LevelAlive; onNote: (ref: string) => void; kind: Area["kind"]; fresh: string; onRefresh: (() => void) | null }) {
  const [all, setAll] = useState(false);
  const moving = all ? alive.moving : alive.moving.slice(0, CAP);
  return <section className="th-alive" aria-label="What is alive here">
    {alive.now
      ? <p className="th-lede">{alive.nowTokens ? <InlineText tokens={alive.nowTokens} onNote={onNote} /> : alive.now}</p>
      : <p className="th-lede quiet">{alive.hasBrief ? "Quiet here." : kind === "project" ? "No summary yet." : "No brief yet."}</p>}
    {(fresh || onRefresh) && <p className="th-fresh">{fresh && <span>{fresh}{alive.derived ? " · derived" : ""}</span>}{onRefresh && <button type="button" className="th-link" onClick={onRefresh}>Refresh</button>}</p>}
    {moving.length > 0 && <>
      <h2 className="th-h"><span>Moving</span><em>{alive.moving.length}</em></h2>
      <ul className="th-lines">{moving.map((l, i) => <Line key={i} l={l} onNote={onNote} />)}</ul>
      {alive.moving.length > CAP && <button type="button" className="th-link" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show ${alive.moving.length - CAP} more`}</button>}
    </>}
  </section>;
}

function Line({ l, onNote, ask, onAsk }: { l: AliveLine; onNote: (ref: string) => void; ask?: boolean; onAsk?: (l: AliveLine) => void }) {
  return <li className="th-line"><i className="th-k" aria-hidden="true" />
    <span className="th-line-text"><InlineText tokens={l.tokens} onNote={onNote} />{l.note && <small>{l.note}</small>}</span>
    {ask && onAsk && <button type="button" className="th-link th-ask" aria-label={`Ask Uni about: ${l.text}`} onClick={() => onAsk(l)}>Ask Uni</button>}
  </li>;
}

export function NeedsBlock({ lines, onNote, onAsk }: { lines: readonly AliveLine[]; onNote: (ref: string) => void; onAsk: ((l: AliveLine) => void) | null }) {
  const [all, setAll] = useState(false);
  if (!lines.length) return null;
  const shown = all ? lines : lines.slice(0, CAP);
  return <Section id="needs" title="Needs you" count={lines.length}>
    <ul className="th-lines needs">{shown.map((l, i) => <Line key={i} l={l} onNote={onNote} ask={!!onAsk} onAsk={onAsk ?? undefined} />)}</ul>
    {lines.length > CAP && <button type="button" className="th-link" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show ${lines.length - CAP} more`}</button>}
  </Section>;
}

/** "↳ 3 updates from boulder/cohere": what the rooms below posted in the last day, as sap climbing the tree. */
export function UpdatesBlock({ updates, nowSec, onOpen }: { updates: readonly Update[]; nowSec: number; onOpen: (path: string) => void }) {
  if (!updates.length) return null;
  return <Section id="updates" title="From the rooms below" count={updates.length}>
    <ul className="th-sap">{updates.map((u) => <li key={u.path}>
      <button type="button" className="th-up" data-path={u.path} onClick={() => onOpen(u.path)} aria-label={`Update from ${u.slash}, ${agoLabel(nowSec, u.ts)}. Open ${u.name}`}>
        <span className="th-arrow" aria-hidden="true">↳</span>
        <span className="th-up-text"><b>{u.text ? "Update" : "Active"}</b> from <span className="th-up-room">{u.slash}</span><small>{agoLabel(nowSec, u.ts)}{u.text ? ` · ${cleanText(u.text).replace(/\s+/g, " ").slice(0, 110)}` : ""}</small></span>
      </button></li>)}</ul>
  </Section>;
}

export type InsideKid = { node: Area; mark: Mark; view: Pick<RoomView, "slash" | "heldBy" | "own">; needs: number; open: number };

/** The children: areas (from Uni) or projects (from an area), each a door to its own level. */
export function InsideBlock({ chat = true, title, kids, onOpen }: { chat?: boolean; title: string; kids: readonly InsideKid[]; onOpen: (n: Area) => void }) {
  if (!kids.length) return null;
  return <Section id="inside" title={title} count={kids.length}>
    <ul className="th-kids">{kids.map((k) => <li key={k.node.path}>
      <button type="button" className="th-kid" data-name={k.node.name} onClick={() => onOpen(k.node)}
        aria-label={`${k.node.name}${k.needs ? `, ${k.needs} need you` : ""}${k.open ? `, ${k.open} open` : ""}`}>
        <Stump mark={k.mark} kind={k.node.kind} own={chat ? k.view.own : undefined} />
        <span className="th-kid-main"><b>{k.node.name}</b>{k.node.purpose && <em>{k.node.purpose.slice(0, 90)}</em>}{chat && <RoomDoor view={k.view} className="th-rowdoor" />}</span>
        {k.needs > 0 ? <Tag n={k.needs} /> : k.open > 0 ? <span className="th-open" aria-hidden="true">{k.open}</span> : null}
      </button></li>)}</ul>
  </Section>;
}

/** A project's own note, folded: the purpose and body 0.1.39 showed at the foot of its page. */
export function ProjectNote({ area }: { area: Area }) {
  if (area.kind !== "project" || !area.body) return null;
  return <details className="th-note"><summary>Project note</summary><Body body={area.body} mentions={[]} me={null} /></details>;
}

// ---------------------------------------------------------------------------------------------- the room

/** The room's latest lines as ledger slips (not bubbles). Fetches itself; `tick` refetches (a message arrived or was sent). */
export function Ledger({ roomId, me, tick, nowSec }: { roomId: string | null; me: string | null; tick: number; nowSec: number }) {
  const [list, setList] = useState<{ room: string; messages: RoomMessage[] } | null>(null);
  useEffect(() => {
    if (!roomId) return;
    let live = true;
    invoke<RoomMessage[]>("get_messages", { channel: roomId, root: null, limit: 12 }).then((m) => { if (live) setList({ room: roomId, messages: m.slice(-8) }); }).catch(() => { if (live) setList({ room: roomId, messages: [] }); });
    return () => { live = false; };
  }, [roomId, tick]);
  const messages = useMemo(() => (list && list.room === roomId ? list.messages : []), [list, roomId]);
  if (!roomId) return <p className="th-quiet">No room to show.</p>;
  if (!list || list.room !== roomId) return <p className="th-quiet" role="status">Opening the room…</p>;
  if (!messages.length) return <p className="th-quiet">Nothing said here yet.</p>;
  return <ol className="th-ledger" aria-label="Latest in the room">{messages.map((m) => <li key={m.ref} className={`th-slip ${me && m.author === me ? "me" : ""}`}>
    <small>{cleanText(m.author_name || m.author.slice(0, 8))} · {agoLabel(nowSec, m.ts)}</small>
    <span>{cleanText(m.body).replace(/\s+/g, " ")}</span></li>)}</ol>;
}

/** `steward`: who answers here when the node has no room of its own ("Stewarded by #boulder"); nothing to say when the room is its own. */
export function RoomBlock({ view, ledger, steward }: { view: RoomView; ledger: ReactNode; steward: string | null }) {
  return <Section id="room" title="Room">
    <div className="th-roomhead"><RoomDoor view={view} />{!view.own && steward && <span className="th-rnote">{steward}</span>}</div>
    {ledger}
  </Section>;
}
