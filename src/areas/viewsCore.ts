// T-140: the sidebar's three views over the same nodes (pure, unit-tested in scripts/links.test.ts): Rooms (every live room, newest message
// first, archived ones behind one line), Projects (a card per project: its room and its links as chips) and Areas (the tree).
// Room activity is the app's own `last_ts` per room (it already has the latest event); nothing here fetches.
import { ownRoom, type RoomRef } from "./talkCore.ts";
import { roomView } from "./treeRooms.ts";
import type { Tree } from "./treeCore.ts";

export type SidebarView = "rooms" | "projects" | "areas";
export const VIEWS: readonly SidebarView[] = ["rooms", "projects", "areas"];
export const VIEW_KEY = "uni.sidebar.view.v1";
export function parseView(raw: string | null): SidebarView {
  let v: unknown = raw;
  try { v = raw ? JSON.parse(raw) : null; } catch { /* a bare word */ }
  return (VIEWS as readonly unknown[]).includes(v) ? v as SidebarView : "areas";
}

export type RoomStamp = RoomRef & { last_ts: number | null };

/** Rooms only retired nodes remember: a room an archived or done node named, or a live node's `room_status: archived` room, that no live node owns now. */
export function archivedRoomIds(tree: Tree, rooms: readonly RoomRef[], owned: ReadonlyMap<string, unknown>): Set<string> {
  const out = new Set<string>();
  const add = (n: { metadata: Record<string, unknown>; channels: readonly string[] }) => {
    const r = ownRoom({ room: typeof n.metadata.room === "string" ? n.metadata.room : null, channels: n.channels }, rooms);
    if (r && !owned.has(r.id)) out.add(r.id);
  };
  for (const n of tree.archived) add(n);
  for (const n of tree.nodes.values()) if (/^(archived|missing)$/i.test(String(n.metadata.room_status ?? ""))) add(n);
  return out;
}

/** Newest message first; a room with no message sorts after those that have one, by name. */
export const byActivity = <T extends { name: string; last_ts: number | null }>(list: readonly T[]): T[] =>
  [...list].sort((a, b) => (b.last_ts ?? -1) - (a.last_ts ?? -1) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

export function roomsList(rooms: readonly RoomStamp[], archived: ReadonlySet<string>): { live: RoomStamp[]; archived: RoomStamp[] } {
  return { live: byActivity(rooms.filter((r) => !archived.has(r.id))), archived: byActivity(rooms.filter((r) => archived.has(r.id))) };
}

/** A link shown as a chip: the node and the room a tap opens (its own, else the room that holds it, else Uni's). */
export type Chip = { kind: "area" | "project"; path: string; name: string; roomId: string | null; roomName: string | null };
export type Card = { path: string; name: string; summary: string; roomId: string | null; roomName: string | null; own: boolean; lastTs: number | null; chips: Chip[] };

/** Each project, newest room activity first. `own`: it has a room of its own; otherwise it "talks in" its first area's room. */
export function projectCards(tree: Tree, rooms: readonly RoomStamp[], uni: RoomRef | null): Card[] {
  const stamp = new Map(rooms.map((r) => [r.id, r.last_ts]));
  const chipOf = (path: string): Chip => {
    const n = tree.nodes.get(path)!; const v = roomView(tree, path, rooms, uni);
    return { kind: n.kind, path, name: n.name, roomId: v.target?.id ?? null, roomName: v.target?.name ?? null };
  };
  const cards = [...tree.nodes.values()].filter((n) => n.kind === "project").map((n): Card => {
    const v = roomView(tree, n.path, rooms, uni);
    const links = tree.links.get(n.path) ?? [];
    const chips = [...links.filter((p) => tree.nodes.get(p)?.kind === "area"), ...links.filter((p) => tree.nodes.get(p)?.kind === "project")].map(chipOf);
    // Uni links to everything implicitly: a project that only falls back to #Uni has no activity of its own, so #Uni's chatter must not sort it first.
    const viaUni = !v.own && !!uni && v.target?.id === uni.id;
    return { path: n.path, name: n.name, summary: n.purpose, roomId: v.target?.id ?? null, roomName: v.target?.name ?? null, own: v.own, lastTs: v.target && !viaUni ? stamp.get(v.target.id) ?? null : null, chips };
  });
  return byActivity(cards.map((c) => ({ ...c, last_ts: c.lastTs }))).map(({ last_ts: _drop, ...c }) => c);
}
