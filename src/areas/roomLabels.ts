// T-124 r2: one name per room. The tree names a room after the node that owns it ("Learn Vibe Build"); the Buzz room list shows the
// room's own name ("teach"). The Uni surface publishes the tree's names here and the rooms drawer reads them, so the two agree.
import { useSyncExternalStore } from "react";
import { ROOT, type Tree } from "./treeCore";
import type { RoomRef } from "./talkCore";
import { roomView } from "./treeRooms";

let labels: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

/** Room id -> the name of the node that owns it (the shallowest owner when several do). */
export function roomLabelMap(tree: Tree, rooms: readonly RoomRef[], uni: RoomRef | null): Map<string, string> {
  const out = new Map<string, string>();
  if (uni) out.set(uni.id, "Uni");
  const walk = (path: string) => {
    for (const n of tree.children.get(path) ?? []) {
      const v = roomView(tree, n.path, rooms, uni);
      if (v.own && v.target && !out.has(v.target.id)) out.set(v.target.id, n.name);
      walk(n.path);
    }
  };
  walk(ROOT);
  return out;
}

export function publishRoomLabels(next: ReadonlyMap<string, string>): void {
  if (next.size === labels.size && [...next].every(([k, v]) => labels.get(k) === v)) return;
  labels = next;
  for (const l of listeners) l();
}

export function useRoomLabels(): ReadonlyMap<string, string> {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => labels);
}
