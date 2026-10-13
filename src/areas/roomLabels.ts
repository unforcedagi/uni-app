// T-124 r2: one name per room. The tree names a room after the node that owns it ("Learn Vibe Build"); the Buzz room list shows the
// room's own name ("teach"). The Uni surface publishes the tree's names here and the rooms drawer reads them, so the two agree.
import { useSyncExternalStore } from "react";
import { ROOT, type Tree } from "./treeCore";
import type { RoomRef } from "./talkCore";
import { roomView } from "./treeRooms";

export type RoomNodeRef = { name: string; path: string };
let nodes: ReadonlyMap<string, RoomNodeRef> = new Map();
let labels: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

/** Room id -> the node that owns it (the shallowest owner when several do); the Uni room is the root (path ""). */
export function roomNodeMap(tree: Tree, rooms: readonly RoomRef[], uni: RoomRef | null): Map<string, RoomNodeRef> {
  const out = new Map<string, RoomNodeRef>();
  if (uni) out.set(uni.id, { name: "Uni", path: ROOT });
  const walk = (path: string) => {
    for (const n of tree.children.get(path) ?? []) {
      const v = roomView(tree, n.path, rooms, uni);
      if (v.own && v.target && !out.has(v.target.id)) out.set(v.target.id, { name: n.name, path: n.path });
      walk(n.path);
    }
  };
  walk(ROOT);
  return out;
}

/** Room id -> the name of the node that owns it. */
export const roomLabelMap = (tree: Tree, rooms: readonly RoomRef[], uni: RoomRef | null): Map<string, string> =>
  new Map([...roomNodeMap(tree, rooms, uni)].map(([id, n]) => [id, n.name]));

const same = (a: ReadonlyMap<string, RoomNodeRef>, b: ReadonlyMap<string, RoomNodeRef>) => a.size === b.size && [...b].every(([k, v]) => a.get(k)?.name === v.name && a.get(k)?.path === v.path);

/** The Uni surface publishes which node owns which room: the rooms drawer names rooms the way the tree does, and opening a room anywhere opens its node's one view. */
export function publishRoomNodes(next: ReadonlyMap<string, RoomNodeRef>): void {
  if (same(nodes, next)) return;
  nodes = next;
  labels = new Map([...next].map(([id, n]) => [id, n.name]));
  for (const l of listeners) l();
}
/** Withdraw them (the tree is not the navigation on this layout). */
export const clearRoomNodes = () => publishRoomNodes(new Map());

/** The node that owns a room, if the tree is loaded and one does. */
export const nodeOfRoom = (id: string): RoomNodeRef | null => nodes.get(id) ?? null;

export function useRoomLabels(): ReadonlyMap<string, string> {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => labels);
}
/** Re-renders when the published room-to-node map changes. */
export function useRoomNodes(): ReadonlyMap<string, RoomNodeRef> {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => nodes);
}
