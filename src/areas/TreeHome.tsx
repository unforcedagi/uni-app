// T-111, r12, r13: the room tree (beside the room on wide screens, the home on a phone, a drawer from the room's header below 900px) and the crumbs.
// Styling is in tree.css (the Field Book tokens).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { agoLabel, roomSlug, type TreeRow } from "./treeRooms";
import { VIEWS, type Card, type Chip, type RoomStamp, type SidebarView } from "./viewsCore";
import type { NavControls } from "../navContext";
import { useSidebarView, ancestorsOf, hasKids, isOpen, recentLabels, RECENT_FULL_PX, rolledNeeds, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, useFolds, useSidebar, visibleRows } from "./sidebarState";
import type { TaskLoad } from "./Companion";
import { LoadHealth } from "./LoadHealth";

// ---------------------------------------------------------------------------------------------- the phone's tree

/** The fold key of the "Other rooms" group (never a note path). */
export const OTHER_ROOMS = "~other-rooms";
export type OtherRoom = { id: string; name: string };
export type TreeProps = {
  chat?: boolean; rows: readonly TreeRow[]; needs: ReadonlyMap<string, number>;
  onOpen: (path: string, via?: string | null) => void;
  /** T-140: the Rooms and Projects views (the tree is the Areas view). Absent: the tree alone. */
  lists?: { live: readonly RoomStamp[]; archived: readonly RoomStamp[]; cards: readonly Card[]; now: number };
  /** The row of the level being shown (the wide layout keeps the list beside it). */
  selected?: string;
  /** Rooms no node owns: a quiet "Other rooms" group at the bottom, folded unless one of them is open. */
  others?: readonly OtherRoom[]; selectedRoom?: string; onOpenRoom?: (id: string) => void;
  /** Whether the dots can be trusted: a failed first load says so (no dots at all), a failed refresh keeps them with a quiet Retry. */
  load?: TaskLoad; needsReady?: boolean;
};

/**
 * The rooms list: Uni, then every area with its projects beneath, then "Other rooms". A row is the node's name; the room line under it is
 * the room's real channel name (nothing for a node with no room of its own). Areas fold: the chevron folds, the name opens. A folded row
 * still shows the dot when anything under it needs you.
 */
export function RoomTree({ chat = true, rows, needs, onOpen, selected, others = [], selectedRoom, onOpenRoom }: TreeProps) {
  const [folds, setFold, reveal] = useFolds();
  const inOthers = !!selectedRoom && others.some((o) => o.id === selectedRoom);
  const key = [...ancestorsOf(rows, selected), ...(inOthers ? [OTHER_ROOMS] : [])].join("\n");
  useEffect(() => { reveal(key ? key.split("\n") : []); }, [key, reveal]);
  const at = new Map(rows.map((r, i) => [r.key, i]));
  const othersOpen = folds[OTHER_ROOMS] ?? false;
  return <nav aria-label="Rooms and areas"><ul className="th-rows">{visibleRows(rows, folds, selected).map((r) => {
    const i = at.get(r.key)!;
    const kids = hasKids(rows, i);
    const open = !kids || isOpen(rows, folds, selected, r.path);
    const n = needs.get(r.path) ?? 0;
    // a folded area's dot is what is inside it; an open one shows its own only (its rows below carry theirs)
    const inside = !open && rolledNeeds(rows, needs, i) - n > 0;
    const dot = n > 0 || inside;
    const dotTitle = n > 0 ? (inside ? "Needs you, and so does something inside" : "Needs you") : "Something inside needs you";
    const sub = chat && r.own && r.slash ? `#${r.slash}` : "";
    const heldBy = chat && !r.own && r.heldBy ? `in #${r.heldBy}` : "";
    return <li key={r.key} className={`th-row d${Math.min(r.depth, 4)} ${selected === r.path ? "sel" : ""} ${kids ? "has-kids" : ""}`} data-open={kids ? String(open) : undefined}>
      {r.depth > 0 && (kids
        ? <button type="button" className="th-fold" data-path={r.path} aria-expanded={open} aria-label={`${open ? "Fold" : "Unfold"} ${r.name}`} title={`${open ? "Hide" : "Show"} what is inside ${r.name} (${kidCount(rows, i)})`} onClick={() => setFold(r.path, !open)}><i aria-hidden="true" /></button>
        : <span className="th-fold-gap" aria-hidden="true" />)}
      <button type="button" className="th-go" data-path={r.path} data-via={r.via ?? undefined} aria-current={selected === r.path ? "page" : undefined} onClick={() => onOpen(r.path, r.via)} title={heldBy || undefined}
        aria-label={`${r.name}${chat ? `, ${sub ? `room ${sub}` : "no channel of its own"}` : ""}${dot ? `, ${n ? `${n} need${n === 1 ? "s" : ""} you` : "something inside needs you"}` : ""}`}>
        <span className="th-name"><b>{r.name}</b>{sub && <small className="th-sub">{sub}</small>}</span>
        {dot && <i className={`th-dot ${n > 0 ? "" : "inside"}`} title={dotTitle} aria-hidden="true" />}
      </button>
    </li>;
  })}
  {others.length > 0 && <li className="th-row th-others d1 has-kids" data-open={String(othersOpen)}>
    <button type="button" className="th-fold" data-path={OTHER_ROOMS} aria-expanded={othersOpen} aria-label={`${othersOpen ? "Fold" : "Unfold"} Other rooms`} title={othersOpen ? "Fold" : "Unfold"} onClick={() => setFold(OTHER_ROOMS, !othersOpen)}><i aria-hidden="true" /></button>
    <button type="button" className="th-go th-others-go" aria-label={`Other rooms, ${others.length} not filed under an area`} onClick={() => setFold(OTHER_ROOMS, !othersOpen)}><span className="th-name"><b>Other rooms</b></span></button>
  </li>}
  {othersOpen && others.map((o) => <li key={`room:${o.id}`} className={`th-row th-other d2 ${selectedRoom === o.id ? "sel" : ""}`}>
    <span className="th-fold-gap" aria-hidden="true" />
    <button type="button" className="th-go" data-room={o.id} aria-current={selectedRoom === o.id ? "page" : undefined} aria-label={`#${roomSlug(o.name)}, not filed under an area`} onClick={() => onOpenRoom?.(o.id)}>
      <span className="th-name"><b>#{roomSlug(o.name)}</b></span>
    </button>
  </li>)}
  </ul></nav>;
}

/** How many rows sit directly inside row `i` (a chevron is only drawn when there are some). */
const kidCount = (rows: readonly TreeRow[], i: number) => { let n = 0; for (let j = i + 1; j < rows.length && rows[j].depth > rows[i].depth; j++) if (rows[j].depth === rows[i].depth + 1) n++; return n; };

const VIEW_LABEL: Record<SidebarView, string> = { rooms: "Rooms", projects: "Projects", areas: "Areas" };
/** Rooms / Projects / Areas, remembered per device. */
function ViewSwitch({ view, onView }: { view: SidebarView; onView: (v: SidebarView) => void }) {
  return <div className="th-views" role="group" aria-label="View">{VIEWS.map((v) => <button key={v} type="button" className="th-view" data-view={v} aria-pressed={view === v} onClick={() => onView(v)}>{VIEW_LABEL[v]}</button>)}</div>;
}

const whenOf = (now: number, ts: number | null) => ts ? agoLabel(now, ts) : "";

/** Every live room, newest message first; archived rooms stay behind one line. */
function RoomsView({ lists, selectedRoom, onOpenRoom }: { lists: NonNullable<TreeProps["lists"]>; selectedRoom?: string; onOpenRoom?: (id: string) => void }) {
  const [more, setMore] = useState(false);
  const row = (r: RoomStamp) => <li key={r.id} className={`th-room ${selectedRoom === r.id ? "sel" : ""}`}>
    <button type="button" className="th-go th-room-go" data-room={r.id} aria-current={selectedRoom === r.id ? "page" : undefined} aria-label={`#${roomSlug(r.name)}`} onClick={() => onOpenRoom?.(r.id)}>
      <span className="th-name"><b>#{roomSlug(r.name)}</b></span><small className="th-when">{whenOf(lists.now, r.last_ts)}</small>
    </button></li>;
  return <nav aria-label="Rooms by activity"><ul className="th-rows th-roomlist">{lists.live.map(row)}</ul>
    {lists.archived.length > 0 && <div className="th-archived"><button type="button" className="th-showarch" aria-expanded={more} onClick={() => setMore(!more)}>{more ? "Hide archived" : `Show archived (${lists.archived.length})`}</button>
      {more && <ul className="th-rows th-roomlist">{lists.archived.map(row)}</ul>}</div>}
  </nav>;
}

const ChipButton = ({ chip, onOpenRoom }: { chip: Chip; onOpenRoom?: (id: string) => void }) =>
  <button type="button" className="th-chip" data-chip={chip.path} data-room={chip.roomId ?? undefined} disabled={!chip.roomId} onClick={() => chip.roomId && onOpenRoom?.(chip.roomId)}>
    <b>{chip.name}</b>{chip.roomName && <span> · #{roomSlug(chip.roomName)}</span>}</button>;

/** A card per project, newest room activity first: its room (or "talks in #room"), and its links as chips. A chip or the room opens that room. */
function ProjectsView({ lists, selected, onOpen, onOpenRoom }: { lists: NonNullable<TreeProps["lists"]>; selected?: string; onOpen: TreeProps["onOpen"]; onOpenRoom?: (id: string) => void }) {
  return <nav aria-label="Projects by activity"><ul className="th-rows th-cards">{lists.cards.map((c) => <li key={c.path} className={`th-card ${selected === c.path ? "sel" : ""}`} data-card={c.path}>
    <div className="th-card-head">
      <button type="button" className="th-go th-card-name" data-path={c.path} aria-current={selected === c.path ? "page" : undefined} onClick={() => onOpen(c.path)}><span className="th-name"><b>{c.name}</b></span></button>
      <small className="th-when">{whenOf(lists.now, c.lastTs)}</small>
    </div>
    {c.roomId && c.roomName && <button type="button" className={`th-cardroom ${c.own ? "own" : "held"}`} data-room={c.roomId} onClick={() => onOpenRoom?.(c.roomId!)}>{c.own ? "" : "talks in "}#{roomSlug(c.roomName)}</button>}
    {c.chips.length > 0 && <div className="th-chips">{c.chips.map((k) => <ChipButton key={k.path} chip={k} onOpenRoom={onOpenRoom} />)}</div>}
  </li>)}</ul></nav>;
}

const NavButtons = ({ nav }: { nav: NavControls | null }) => nav ? <>
  <button type="button" className="th-nb" aria-label="Back" title="Back (Alt+←)" disabled={!nav.canBack} onClick={nav.back}>←</button>
  <button type="button" className="th-nb" aria-label="Forward" title="Forward (Alt+→)" disabled={!nav.canForward} onClick={nav.forward}>→</button>
</> : null;

const FRESHNESS = ["saved", "refresh", "slow"];
export function TreeScreen({ status, column, nav, onHide, hideLabel = "Hide the sidebar", ...tree }: TreeProps & {
  status?: ReactNode;
  /** The left column beside a room (wide screens, and the drawer below 900px): a slim toolbar (Back, Forward, hide), the tree, then the last few places. */
  column?: boolean;
  nav?: NavControls | null; onHide?: () => void; hideLabel?: string;
}) {
  const { rows, selected, others, selectedRoom } = tree;
  const [view, setView] = useSidebarView();
  // the tree may scroll, but Recent never takes its room: with the tree's rows taller than what is left beside five places, Recent shows three
  const box = useRef<HTMLDivElement>(null);
  const [tight, setTight] = useState(false);
  useLayoutEffect(() => {
    const root = box.current; const wrap = root?.querySelector<HTMLElement>(".th-rows-wrap"); const list = wrap?.firstElementChild as HTMLElement | null;
    if (!column || !root || !wrap || !list || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const fixed = [...root.children].filter((c) => c !== wrap && !c.classList.contains("th-recent")).reduce((a, c) => a + (c as HTMLElement).offsetHeight, 0);
      setTight(list.offsetHeight > root.clientHeight - fixed - RECENT_FULL_PX);
    };
    // r23: the tree scrolls in its own region above Recent; while rows run on below, its last line fades, so a row never reads as under Recent
    const more = () => { const on = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight > 2; if (on) wrap.setAttribute("data-more", ""); else wrap.removeAttribute("data-more"); };
    measure(); more();
    const ro = new ResizeObserver(() => { measure(); more(); });
    ro.observe(root); ro.observe(list);
    wrap.addEventListener("scroll", more, { passive: true });
    return () => { ro.disconnect(); wrap.removeEventListener("scroll", more); };
  }, [column]);
  const here = selectedRoom ? others?.find((o) => o.id === selectedRoom)?.name ?? null : rows.find((r) => r.path === selected)?.name ?? null;
  return <div ref={box} className={`tree-home th-phone-tree ${column ? "th-column" : ""}`}>
    {column
      ? <header className="th-toolbar"><NavButtons nav={nav ?? null} /><span className="th-tb-gap" />{onHide && <button type="button" className="th-nb" aria-label={hideLabel} title={hideLabel} onClick={onHide}>‹</button>}</header>
      : <header className="th-treehead"><h1 className="note-title">Uni</h1></header>}
    {status}
    {/* r23: one freshness line at a time: beside a room (the column), the companion or the room's strip says it, so the tree doesn't */}
    <LoadHealth load={tree.load} ready={!!tree.needsReady} skip={column ? FRESHNESS : undefined} />
    {tree.lists && <ViewSwitch view={view} onView={setView} />}
    <div className="th-rows-wrap">{!tree.lists || view === "areas" ? <RoomTree {...tree} /> : view === "rooms" ? <RoomsView lists={tree.lists} selectedRoom={selectedRoom} onOpenRoom={tree.onOpenRoom} /> : <ProjectsView lists={tree.lists} selected={selected} onOpen={tree.onOpen} onOpenRoom={tree.onOpenRoom} />}</div>
    {column && nav && nav.recent.length > 0 && <section className={`th-recent ${tight ? "tight" : ""}`} aria-label="Recent"><h2>Recent</h2>
      <ul>{recentLabels(nav.recent, rows, here, tight ? 3 : 5).map(({ r, label }) => <li key={r.key}><button type="button" onClick={r.go} title={label}>{label}</button></li>)}</ul></section>}
  </div>;
}

/** The left column: width set by dragging its right edge (180 to 360px, remembered), or hidden down to a thin strip. */
/** `fold` (T-200, a note beside the chat): folded or not for now, over the choice kept on this device. */
export function RoomSidebar({ nav, fold = null, ...tree }: TreeProps & { nav?: NavControls | null; fold?: { folded: boolean; set: (open: boolean) => void } | null }) {
  const [sb, setSb] = useSidebar();
  const drag = useRef<{ x: number; w: number } | null>(null);
  if (fold ? fold.folded : sb.hidden) return <div className="th-roomnav hidden"><button type="button" className="th-nb" aria-label="Show the sidebar" title="Show the sidebar" onClick={() => fold ? fold.set(true) : setSb({ hidden: false })}>›</button><NavButtons nav={nav ?? null} /></div>;
  return <div className="th-roomnav" data-width={sb.width}>
    <TreeScreen column {...tree} nav={nav} onHide={() => fold ? fold.set(false) : setSb({ hidden: true })} />
    <div className="th-resize" role="separator" aria-orientation="vertical" aria-label="Resize the sidebar" aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX} aria-valuenow={sb.width} tabIndex={0}
      onPointerDown={(e) => { drag.current = { x: e.clientX, w: sb.width }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => { if (drag.current) setSb({ width: drag.current.w + e.clientX - drag.current.x }); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onDoubleClick={() => setSb({ width: SIDEBAR_DEFAULT })}
      onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setSb({ width: sb.width + (e.key === "ArrowRight" ? 16 : -16) }); } }} />
  </div>;
}

/** Where the place sits. `compact` (below 900px): one line, the places above it only (the title says the last), the first ones giving way. */
export function Crumbs({ trail, onOpen, compact = false }: { trail: readonly { path: string; name: string }[]; onOpen: (path: string) => void; compact?: boolean }) {
  if (compact) trail = trail.slice(0, -1);
  return <nav className={`th-crumbs ${compact ? "compact" : ""}`} aria-label="Where you are">{trail.map((c, i) => i === trail.length - 1 && !compact
    ? <span key={c.path || "uni"} className="th-crumb here" aria-current="page">{i > 0 && <i aria-hidden="true">›</i>}{c.name}</span>
    : <span key={c.path || "uni"} className="th-crumb-wrap">{i > 0 && <i aria-hidden="true">›</i>}<button type="button" className="th-crumb" onClick={() => onOpen(c.path)}>{c.name}</button></span>)}</nav>;
}
