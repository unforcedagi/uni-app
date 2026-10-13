// Rooms in the tree (pure, unit-tested in scripts/treehome.test.ts): the slash name of a node's room (`boulder/cohere`), whether the
// node owns that room or is held by an ancestor's, the archived-room fallback, and the updates the rooms below have posted.
// Builds on stewardOf's rule (talkCore.steward): a node's own room, else the nearest ancestor's, else #Uni.
import type { Area } from "./areasCore.ts";
import { ancestry, ROOT, type Tree } from "./treeCore.ts";
import { ownRoom, steward, type RoomNode, type RoomRef } from "./talkCore.ts";

export const roomSlug = (name: string) => name.toLowerCase().replace(/^#/, "").trim().replace(/[\s_]+/g, "-");

/** The slash name down a chain of room slugs (area first): `boulder` + `cohere` is `boulder/cohere`, but a room already named under its parent (`atlas` + `atlas/build`) is not doubled. */
export function joinSlash(slugs: readonly string[]): string {
  let out = "";
  for (const s of slugs) out = !out ? s : s.startsWith(out + "/") ? s : `${out}/${s}`;
  return out;
}

/** Nodes whose words and titles are never shown in a new place, only counts (the T-111 privacy rule). */
const PRIVATE = new Set(["relationships", "sadhana"]);
export const isPrivateNode = (tree: Tree, path: string): boolean => ancestry(tree, path).some((n) => PRIVATE.has(n.name.toLowerCase()));

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
  /** `boulder/cohere`: shown when the node has a room of its own. */
  slash: string | null;
  /** The ancestor's room that holds a node with none of its own. */
  heldBy: RoomRef | null;
  own: boolean;
  /** The name of the node whose room holds this one (`Boulder`), so a held row never reads as the room's own. */
  heldNode: string | null;
};

/** Whether a node beneath `path` names `roomId` as its own room. */
function claimedBelow(tree: Tree, path: string, roomId: string, rooms: readonly RoomRef[]): boolean {
  const stack = [...(tree.children.get(path) ?? [])]; const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n.path)) continue;
    seen.add(n.path);
    if (ownRoom(roomNodeOf(n), rooms)?.id === roomId) return true;
    stack.push(...(tree.children.get(n.path) ?? []));
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
  if (own) {
    // the names of the rooms on the way down, one per distinct room: area room, then project room
    const names: string[] = [];
    let last: string | null = null;
    for (let i = chain.length - 1; i >= 0; i--) {
      const r = fellBack(chain[i]) ? null : ownRoom(nodes[i], rooms);
      if (r && r.id !== last) { names.push(roomSlug(r.name)); last = r.id; }
    }
    return { target: s.room, slash: joinSlash(names), heldBy: null, own: true, heldNode: null };
  }
  const holder = s.room ? nodes.slice(1).find((n) => ownRoom(n, rooms)?.id === s.room!.id) : undefined;
  return { target: s.room, slash: null, heldBy: s.room, own: false, heldNode: holder?.name ?? (s.room && s.room.id === uni?.id ? "Uni" : null) };
}

export type RoomInfoLite = { id: string; name: string; last_message: string | null; last_ts: number | null };
export type Update = { path: string; name: string; slash: string; ts: number; /** The newest line of the room; null for a private node (only that it was active). */ text: string | null };
const DAY = 86_400;

/**
 * What the rooms below this node have posted in the last day: one entry per room of its own that sits under `path`
 * (not the node's own room), newest first. Private areas contribute the time only.
 */
export function updatesBelow(tree: Tree, path: string, rooms: readonly RoomInfoLite[], uni: RoomRef | null, nowSec: number, windowSec = DAY): Update[] {
  const mineRoom = roomView(tree, path, rooms, uni).target?.id ?? null;
  const out = new Map<string, Update>();
  const under = (p: string): boolean => { for (let at: string | undefined = tree.parent.get(p), n = 0; at !== undefined && n <= tree.nodes.size; at = tree.parent.get(at), n++) { if (at === path) return true; if (at === ROOT) return path === ROOT; } return false; };
  for (const n of tree.nodes.values()) {
    if (!under(n.path)) continue;
    const v = roomView(tree, n.path, rooms, uni);
    if (!v.own || !v.target || v.target.id === mineRoom) continue;
    const info = rooms.find((r) => r.id === v.target!.id);
    if (!info?.last_ts || nowSec - info.last_ts > windowSec || out.has(info.id)) continue;
    const priv = isPrivateNode(tree, n.path);
    out.set(info.id, { path: n.path, name: n.name, slash: v.slash ?? roomSlug(info.name), ts: info.last_ts, text: priv ? null : info.last_message });
  }
  return [...out.values()].sort((a, b) => b.ts - a.ts);
}

/** One row of the phone's room tree. */
export type TreeRow = {
  path: string; name: string; depth: number; kind: "root" | "area" | "project"; slash: string | null; heldBy: string | null; heldNode: string | null; own: boolean;
  /** For depths 1..depth-1: does the trunk at that depth carry on below this row (an ancestor with later siblings)? */
  trunk: boolean[];
  /** The last child of its parent: its branch ends here. */
  last: boolean;
};

/** Uni, then every node under it by depth-first order (foreground first, then by name), with its room. */
export function treeRows(tree: Tree, rooms: readonly RoomRef[], uni: RoomRef | null, rootName = "Uni"): TreeRow[] {
  const rows: TreeRow[] = [{ path: ROOT, name: rootName, depth: 0, kind: "root", slash: uni ? roomSlug(uni.name) : null, heldBy: null, heldNode: null, own: !!uni, trunk: [], last: true }];
  const seen = new Set<string>();
  const walk = (path: string, depth: number, trunk: boolean[]) => {
    const kids = (tree.children.get(path) ?? []).filter((n) => !seen.has(n.path));
    kids.forEach((n, i) => {
      if (seen.has(n.path)) return;
      seen.add(n.path);
      const v = roomView(tree, n.path, rooms, uni);
      const last = i === kids.length - 1;
      rows.push({ path: n.path, name: n.name, depth, kind: n.kind, slash: v.slash, heldBy: v.heldBy ? roomSlug(v.heldBy.name) : null, heldNode: v.heldNode, own: v.own, trunk, last });
      walk(n.path, depth + 1, [...trunk, !last]);
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
