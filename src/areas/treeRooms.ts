// Rooms in the tree (pure, unit-tested in scripts/treehome.test.ts): the real name of a node's room (`cohere`, `atlas/build`), whether the
// node owns that room or is held by an ancestor's, the archived-room fallback, and the updates the rooms below have posted.
// Builds on stewardOf's rule (talkCore.steward): a node's own room, else the nearest ancestor's, else #Uni where an account still has
// one (archived 10-26: on the live relay, none, and a node with no room on its way has no room).
// T-335 the shape: the privacy rules and the room rule now live in src/shape/privacy.ts (they outlive the tree); re-exported here for
// the old home until it is deleted.
import { ROOT, type Tree } from "./treeCore.ts";
import { roomSlug, roomView, type RoomRef } from "../shape/privacy.ts";
export { roomSlug, fnv1a, isPrivateName, isPrivateNode, privateRoot, isPrivatePath, isPrivateRoom, roomCluePrivate, runIsPrivate, privateRunIds, privateRootIn, roomNodeOf, fellBack, roomView } from "../shape/privacy.ts";
export type { RunClues, RoomView } from "../shape/privacy.ts";

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
