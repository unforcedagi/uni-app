// T-124 r2: one view per room. The tree names a room after the node that owns it ("Learn Vibe Build"); the Uni surface publishes which
// node owns which room here, so a room opened from anywhere (search, a link, a thread) opens as its node, and the rest are "Other rooms".
import { useSyncExternalStore } from "react";
import { ROOT, type Tree } from "./treeCore";
import type { RoomRef } from "./talkCore";
import { roomView } from "./treeRooms";

export type RoomNodeRef = { name: string; path: string };
let nodes: ReadonlyMap<string, RoomNodeRef> = new Map();
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

const same = (a: ReadonlyMap<string, RoomNodeRef>, b: ReadonlyMap<string, RoomNodeRef>) => a.size === b.size && [...b].every(([k, v]) => a.get(k)?.name === v.name && a.get(k)?.path === v.path);

/** The Uni surface publishes which node owns which room: opening a room anywhere opens its node's one view. */
export function publishRoomNodes(next: ReadonlyMap<string, RoomNodeRef>): void {
  if (same(nodes, next)) return;
  nodes = next;
  for (const l of listeners) l();
}

/** The node that owns a room, if the tree is loaded and one does. */
export const nodeOfRoom = (id: string): RoomNodeRef | null => nodes.get(id) ?? null;

/** Re-renders when the published room-to-node map changes. */
export function useRoomNodes(): ReadonlyMap<string, RoomNodeRef> {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => nodes);
}
