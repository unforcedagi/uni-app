// T-111, r12, r13: the tree of places and the crumbs. T-335 one surface: with rooms, a room is only ever in focus over All, so this tree is the home
// of a vault without rooms (its places, and each one's work); it is never beside a room any more.
// Styling is in tree.css (the Field Book tokens).
import { sameWords } from "./sameWords";
import { useEffect, type ReactNode } from "react";
import { roomSlug, type TreeRow } from "./treeRooms";
import { ancestorsOf, hasKids, isOpen, rolledNeeds, useFolds, visibleRows } from "./sidebarState";
import type { TaskLoad } from "./Companion";
import { LoadHealth } from "./LoadHealth";
import { asksWords, rolledAsks, rolledUnread, unreadShort, unreadWords, type Unread } from "./roomUnread";

// ---------------------------------------------------------------------------------------------- the phone's tree

/** The fold key of the "Other rooms" group (never a note path). */
export const OTHER_ROOMS = "~other-rooms";
export type OtherRoom = { id: string; name: string };
export type TreeProps = {
  chat?: boolean; rows: readonly TreeRow[]; needs: ReadonlyMap<string, number>;
  onOpen: (path: string, via?: string | null) => void;
  /** The row of the level being shown (the wide layout keeps the list beside it). */
  selected?: string;
  /** Rooms no node owns: a quiet "Other rooms" group at the bottom, folded unless one of them is open. */
  others?: readonly OtherRoom[]; selectedRoom?: string; onOpenRoom?: (id: string) => void;
  /** Whether the dots can be trusted: a failed first load says so (no dots at all), a failed refresh keeps them with a quiet Retry. */
  load?: TaskLoad; needsReady?: boolean;
  /** T-335: what is new in each row's own room (by node path), and in each of the "Other rooms" (by room id), with what needs you there. */
  unread?: ReadonlyMap<string, Unread>; otherUnread?: ReadonlyMap<string, Unread>;
  /** T-335: approvals waiting (Hermes prompts, Uni's cards) in each row's own room (by node path) and in each of the "Other rooms" (by room id). */
  asks?: ReadonlyMap<string, number>; otherAsks?: ReadonlyMap<string, number>;
};

/** T-335: a room's new messages, as a small count at the row's end (filled when one mentions you; hollow when it is inside a folded area). */
const NewCount = ({ u, inside = false }: { u: Unread; inside?: boolean }) =>
  <span className={`th-new${u.mention ? " at" : ""}${inside ? " inside" : ""}`} title={inside ? `${unreadWords(u)} inside` : unreadWords(u)} aria-hidden="true">{unreadShort(u.n)}</span>;
const newWords = (u: Unread | null, inside: boolean) => (u ? `, ${inside ? `${u.n} new inside${u.mention ? ", mentions you" : ""}` : unreadWords(u)}` : "");
/** T-335: an approval waiting in the row's room, as a key at the row's end (with the count past one; hollow when it is inside a folded row). */
const AskBadge = ({ n, inside = false }: { n: number; inside?: boolean }) =>
  <span className={`th-ask${inside ? " inside" : ""}`} title={inside ? `${asksWords(n)} inside` : asksWords(n)} aria-hidden="true">🔑{n > 1 ? <b>{unreadShort(n)}</b> : null}</span>;
const askWords = (n: number, inside: boolean) => (n > 0 ? `, ${asksWords(n)}${inside ? " inside" : ""}` : "");

/**
 * The rooms list: Uni, then every area with its projects beneath, then "Other rooms". A row is the node's name; the room line under it is
 * the room's real channel name (nothing for a node with no room of its own). Areas fold: the chevron folds, the name opens. A folded row
 * still shows the dot when anything under it needs you.
 */
export function RoomTree({ chat = true, rows, needs, onOpen, selected, others = [], selectedRoom, onOpenRoom, unread, otherUnread, asks, otherAsks }: TreeProps) {
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
    // T-335: an open row shows its own room's new messages (its rows below carry theirs); a folded one, everything inside it too
    const ownNew = unread?.get(r.path) ?? null;
    const shownNew = unread ? (open ? ownNew : rolledUnread(rows, unread, i)) : null;
    const newInside = !!shownNew && !ownNew;
    // T-335: the same for approvals waiting: its own room's when open, everything inside it too when folded
    const ownAsks = asks?.get(r.path) ?? 0;
    const shownAsks = asks ? (open ? ownAsks : rolledAsks(rows, asks, i)) : 0;
    const asksInside = shownAsks > 0 && !ownAsks;
    const sub = chat && r.own && r.slash ? `#${r.slash}` : "";
    const heldBy = chat && !r.own && r.heldBy ? `in #${r.heldBy}` : "";
    return <li key={r.key} className={`th-row d${Math.min(r.depth, 4)} ${selected === r.path ? "sel" : ""} ${kids ? "has-kids" : ""}`} data-open={kids ? String(open) : undefined}>
      {r.depth > 0 && (kids
        ? <button type="button" className="th-fold" data-path={r.path} aria-expanded={open} aria-label={`${open ? "Fold" : "Unfold"} ${r.name}`} title={`${open ? "Hide" : "Show"} what is inside ${r.name} (${kidCount(rows, i)})`} onClick={() => setFold(r.path, !open)}><i aria-hidden="true" /></button>
        : <span className="th-fold-gap" aria-hidden="true" />)}
      <button type="button" className="th-go" data-path={r.path} data-via={r.via ?? undefined} aria-current={selected === r.path ? "page" : undefined} onClick={() => onOpen(r.path, r.via)} title={heldBy || undefined}
        aria-label={`${r.name}${chat ? `, ${sub ? `room ${sub}` : "no channel of its own"}` : ""}${dot ? `, ${n ? `${n} need${n === 1 ? "s" : ""} you` : "something inside needs you"}` : ""}${askWords(shownAsks, asksInside)}${newWords(shownNew, newInside)}`}>
        <span className="th-name"><b>{r.name}</b>{sub && !sameWords(r.name, sub) && <small className="th-sub">{sub}</small>}</span>
        {shownAsks > 0 && <AskBadge n={shownAsks} inside={asksInside} />}
        {shownNew && <NewCount u={shownNew} inside={newInside} />}
        {dot && <i className={`th-dot ${n > 0 ? "" : "inside"}`} title={dotTitle} aria-hidden="true" />}
      </button>
    </li>;
  })}
  {others.length > 0 && (() => {
    const folded = othersNew(others, otherUnread); const waiting = others.reduce((k, o) => k + (otherAsks?.get(o.id) ?? 0), 0);
    return <li className="th-row th-others d1 has-kids" data-open={String(othersOpen)}>
    <button type="button" className="th-fold" data-path={OTHER_ROOMS} aria-expanded={othersOpen} aria-label={`${othersOpen ? "Fold" : "Unfold"} Other rooms`} title={othersOpen ? "Fold" : "Unfold"} onClick={() => setFold(OTHER_ROOMS, !othersOpen)}><i aria-hidden="true" /></button>
    <button type="button" className="th-go th-others-go" aria-label={`Other rooms, ${others.length} not filed under an area${othersOpen ? "" : askWords(waiting, true)}${othersOpen ? "" : newWords(folded, true)}`} onClick={() => setFold(OTHER_ROOMS, !othersOpen)}><span className="th-name"><b>Other rooms</b></span>
      {!othersOpen && waiting > 0 && <AskBadge n={waiting} inside />}{!othersOpen && folded && <NewCount u={folded} inside />}</button>
  </li>;
  })()}
  {othersOpen && others.map((o) => { const u = otherUnread?.get(o.id) ?? null; const k = otherAsks?.get(o.id) ?? 0;
    return <li key={`room:${o.id}`} className={`th-row th-other d2 ${selectedRoom === o.id ? "sel" : ""}`}>
    <span className="th-fold-gap" aria-hidden="true" />
    <button type="button" className="th-go" data-room={o.id} aria-current={selectedRoom === o.id ? "page" : undefined} aria-label={`#${roomSlug(o.name)}, not filed under an area${askWords(k, false)}${newWords(u, false)}`} onClick={() => onOpenRoom?.(o.id)}>
      <span className="th-name"><b>#{roomSlug(o.name)}</b></span>
      {k > 0 && <AskBadge n={k} />}{u && <NewCount u={u} />}
    </button>
  </li>; })}
  </ul></nav>;
}

/** Everything new in the "Other rooms" together, for the folded group's count. */
function othersNew(others: readonly OtherRoom[], by: ReadonlyMap<string, Unread> | undefined): Unread | null {
  let n = 0, mention = false;
  for (const o of others) { const u = by?.get(o.id); if (u) { n += u.n; mention ||= u.mention; } }
  return n > 0 ? { n, mention } : null;
}

/** How many rows sit directly inside row `i` (a chevron is only drawn when there are some). */
const kidCount = (rows: readonly TreeRow[], i: number) => { let n = 0; for (let j = i + 1; j < rows.length && rows[j].depth > rows[i].depth; j++) if (rows[j].depth === rows[i].depth + 1) n++; return n; };

export function TreeScreen({ status, ...tree }: TreeProps & { status?: ReactNode }) {
  return <div className="tree-home th-phone-tree">
    <header className="th-treehead"><h1 className="note-title">Uni</h1></header>
    {status}
    <LoadHealth load={tree.load} ready={!!tree.needsReady} />
    <div className="th-rows-wrap"><RoomTree {...tree} /></div>
  </div>;
}

/** Where the place sits. `compact` (below 900px): one line, the places above it only (the title says the last), the first ones giving way. */
export function Crumbs({ trail, onOpen, compact = false }: { trail: readonly { path: string; name: string }[]; onOpen: (path: string) => void; compact?: boolean }) {
  if (compact) trail = trail.slice(0, -1);
  return <nav className={`th-crumbs ${compact ? "compact" : ""}`} aria-label="Where you are">{trail.map((c, i) => i === trail.length - 1 && !compact
    ? <span key={c.path || "uni"} className="th-crumb here" aria-current="page">{i > 0 && <i aria-hidden="true">›</i>}{c.name}</span>
    : <span key={c.path || "uni"} className="th-crumb-wrap">{i > 0 && <i aria-hidden="true">›</i>}<button type="button" className="th-crumb" onClick={() => onOpen(c.path)}>{c.name}</button></span>)}</nav>;
}
