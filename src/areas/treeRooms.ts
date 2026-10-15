// Rooms in the tree (pure, unit-tested in scripts/treehome.test.ts): the real name of a node's room (`cohere`, `atlas/build`), whether the
// node owns that room or is held by an ancestor's, the archived-room fallback, and the updates the rooms below have posted.
// Builds on stewardOf's rule (talkCore.steward): a node's own room, else the nearest ancestor's, else #Uni.
import type { Area } from "./areasCore.ts";
import { ancestry, ROOT, type Tree } from "./treeCore.ts";
import { ownRoom, steward, type RoomNode, type RoomRef } from "./talkCore.ts";

/** A room as the app writes it after "#": its real channel name, exactly (r13: never lowercased or re-spaced), without a leading "#". */
export const roomSlug = (name: string) => name.trim().replace(/^#/, "");

/** Nodes whose words and titles are never shown in a new place, only counts (the T-111 privacy rule). */
const PRIVATE = new Set(["relationships", "sanctum"]);
export const isPrivateNode = (tree: Tree, path: string): boolean => ancestry(tree, path).some((n) => PRIVATE.has(n.name.toLowerCase()));
/** The private area a node sits in (the outermost one, itself included), or null: the feed names private items by this place only. */
export function privateRoot(tree: Tree, path: string): { path: string; name: string } | null {
  const hit = ancestry(tree, path).filter((n) => PRIVATE.has(n.name.toLowerCase())).pop();
  return hit ? { path: hit.path, name: hit.name } : null;
}

/** r21: the same, read from the task tree (its nodes and parents), for while the areas aren't read yet: privacy never waits on them. */
export function privateRootIn(tasks: { byPath: ReadonlyMap<string, { path: string; name: string }>; parent: ReadonlyMap<string, string> }, path: string): { path: string; name: string } | null {
  let hit: { path: string; name: string } | null = null;
  const seen = new Set<string>();
  for (let at: string | undefined = path; at && !seen.has(at); at = tasks.parent.get(at)) {
    seen.add(at);
    const n = tasks.byPath.get(at); if (!n) break;
    if (PRIVATE.has(n.name.toLowerCase())) hit = { path: n.path, name: n.name };
  }
  return hit;
}

/**
 * A node as the steward rule reads it. A room marked `room_status: archived|missing` is skipped: the node's `room_fallback`
 * (a room name or id) stands in for it, and with none the walk simply continues to the ancestors.
 */
export function roomNodeOf(n: Area): RoomNode {
  const room = typeof n.metadata.room === "string" ? n.metadata.room : null;
  const status = typeof n.metadata.room_status === "string" ? n.metadata.room_status.toLowerCase() : "";
  if (status === "archived" || status === "missing") {
    const fb = typeof n.metadata.room_fallback === "string" ? n.metadata.room_fallback.replace(/^#/, "").trim() : "";
    return { path: n.path, name: n.name, room: fb || null, channels: fb ? [fb] : [] };
  }
  return { path: n.path, name: n.name, room, channels: n.rooms };
}
export const fellBack = (n: Area): boolean => /^(archived|missing)$/i.test(String(n.metadata.room_status ?? ""));

export type RoomView = {
  /** Where a note to this node goes: its own room, else an ancestor's, else #Uni. */
  target: RoomRef | null;
  /** The room's own name (`cohere`, `atlas/build`): shown when the node has a room of its own. */
  slash: string | null;
  /** The ancestor's room that holds a node with none of its own. */
  heldBy: RoomRef | null;
  own: boolean;
  /** The name of the node whose room holds this one (`Boulder`), so a held row never reads as the room's own. */
  heldNode: string | null;
};

/** Whether a node beneath `path` names `roomId` as its own room. */
function claimedBelow(tree: Tree, path: string, roomId: string, rooms: readonly RoomRef[]): boolean {
  // the start is seen: a cycle of links that comes back to it is not a descendant's claim (Codex 0.1.47 review 3)
  const stack = [...(tree.scope.get(path) ?? [])]; const seen = new Set<string>([path]);
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n.path)) continue;
    seen.add(n.path);
    if (ownRoom(roomNodeOf(n), rooms)?.id === roomId) return true;
    stack.push(...(tree.scope.get(n.path) ?? []));
  }
  return false;
}

/** `rooms`: every known room; `uni`: the Uni room. A node with a live room of its own that an ancestor also uses is held by that ancestor. */
export function roomView(tree: Tree, path: string, rooms: readonly RoomRef[], uni: RoomRef | null): RoomView {
  if (path === ROOT) return { target: uni, slash: uni ? roomSlug(uni.name) : null, heldBy: null, own: !!uni, heldNode: null };
  const chain = ancestry(tree, path);
  const nodes = chain.map(roomNodeOf);
  // A room belongs to the deepest node that names it: when a descendant claims the very room an ancestor's channel points at (Boulder -> #cohere),
  // the ancestor keeps only the room its own `room` name finds, else none.
  // The same goes for every ancestor on the way up, so the deepest node does not read as sharing with them (COhere under Boulder).
  for (let i = 0; i < nodes.length; i++) {
    const channelRoom = ownRoom(nodes[i], rooms);
    if (channelRoom && claimedBelow(tree, chain[i].path, channelRoom.id, rooms)) nodes[i] = { ...nodes[i], channels: [] };
  }
  const s = steward(nodes, rooms, uni);
  const mine = chain[0] ? ownRoom(nodes[0], rooms) : null;
  const sharedWithAncestor = mine ? nodes.slice(1).some((n) => ownRoom(n, rooms)?.id === mine.id) : false;
  // An archived room's fallback is a room the node borrows, not one it owns.
  const own = !!mine && !sharedWithAncestor && !(chain[0] && fellBack(chain[0]));
  // A node's room line is the room's own name (`cohere`, `atlas/build`), exactly as the rooms list has it: never a path built from the tree.
  if (own) return { target: s.room, slash: s.room ? roomSlug(s.room.name) : null, heldBy: null, own: true, heldNode: null };
  const holder = s.room ? nodes.slice(1).find((n) => ownRoom(n, rooms)?.id === s.room!.id) : undefined;
  return { target: s.room, slash: null, heldBy: s.room, own: false, heldNode: holder?.name ?? (s.room && s.room.id === uni?.id ? "Uni" : null) };
}

/** One row of the phone's room tree. */
export type TreeRow = {
  /** The row's own identity: a project linked to two areas has two rows with one `path` (one node, one room, one unread state) and two keys. */
  key: string;
  /** The area this row sits under (null: Uni's top level), so opening it keeps the breadcrumb on the area you came through. */
  via: string | null;
  path: string; name: string; depth: number; kind: "root" | "area" | "project"; slash: string | null; heldBy: string | null; heldNode: string | null; own: boolean;
  /** For depths 1..depth-1: does the trunk at that depth carry on below this row (an ancestor with later siblings)? */
  trunk: boolean[];
  /** The last child of its parent: its branch ends here. */
  last: boolean;
};

/** Uni, then every node under it by depth-first order (foreground first, then by name), with its room. */
export function treeRows(tree: Tree, rooms: readonly RoomRef[], uni: RoomRef | null, rootName = "Uni"): TreeRow[] {
  const rows: TreeRow[] = [{ key: "~uni", via: null, path: ROOT, name: rootName, depth: 0, kind: "root", slash: uni ? roomSlug(uni.name) : null, heldBy: null, heldNode: null, own: !!uni, trunk: [], last: true }];
  // Areas and the projects linked to them. A project is one node however many areas hold it; nothing nests below a project, so the walk is two deep.
  const walk = (path: string, depth: number, trunk: boolean[]) => {
    const kids = tree.children.get(path) ?? [];
    kids.forEach((n, i) => {
      const v = roomView(tree, n.path, rooms, uni);
      const last = i === kids.length - 1;
      rows.push({ key: `${path}>${n.path}`, via: path === ROOT ? null : path, path: n.path, name: n.name, depth, kind: n.kind, slash: v.slash, heldBy: v.heldBy ? roomSlug(v.heldBy.name) : null, heldNode: v.heldNode, own: v.own, trunk, last });
      if (n.kind === "area") walk(n.path, depth + 1, [...trunk, !last]);
    });
  };
  walk(ROOT, 1, []);
  return rows;
}

/** "now", "5m", "3h", "2d": how long ago, for a ledger line. */
export function agoLabel(nowSec: number, ts: number): string {
  const s = Math.max(0, nowSec - ts);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
