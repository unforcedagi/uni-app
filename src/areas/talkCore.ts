// Where a note dropped on a level goes (pure, unit-tested in scripts/tasks.test.ts): the node's own room, else its parent's,
// up to Uni. A node names its room two ways: `room` (a Buzz channel name, the T-84 field) or `channel` (room ids, the older field).
export type RoomRef = { id: string; name: string };
export type RoomNode = { path: string; room: string | null; channels: readonly string[] };

const slug = (s: string) => s.toLowerCase().replace(/^#/, "").replace(/[^a-z0-9]+/g, "");
export const roomByName = (rooms: readonly RoomRef[], name: string | null | undefined): RoomRef | null => {
  const want = name ? slug(name) : "";
  return want ? rooms.find((r) => slug(r.name) === want) ?? null : null;
};

/** `chain` runs from the node up to the top level; the first node with a known room wins; Uni's room is the last resort. */
export function resolveRoom(chain: readonly RoomNode[], rooms: readonly RoomRef[], uni: RoomRef | null): RoomRef | null {
  for (const n of chain) {
    const named = roomByName(rooms, n.room);
    if (named) return named;
    const id = n.channels.find((c) => rooms.some((r) => r.id === c));
    if (id) return rooms.find((r) => r.id === id)!;
  }
  return uni;
}
