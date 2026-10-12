// Who stewards a node, and so where a note dropped on it goes (pure, unit-tested in scripts/tasks.test.ts). Rule: a node's own room,
// else the nearest ancestor's, up to #Uni. A node names its room two ways: `channel` (room ids, which survive a rename) and `room`
// (a Buzz channel name, the T-84 field); an id that matches a known room wins, the name is the fallback.
export type RoomRef = { id: string; name: string };
export type RoomNode = { path: string; name?: string; room: string | null; channels: readonly string[] };

// A name with a "/" (`atlas/build`) is matched segment by segment, so `atlasbuild` or `atlas-build` never stands in for it.
const slug = (s: string) => s.toLowerCase().replace(/^#/, "").trim().split("/").map((p) => p.replace(/[^a-z0-9]+/g, "")).join("/");
export const roomByName = (rooms: readonly RoomRef[], name: string | null | undefined): RoomRef | null => {
  const want = name ? slug(name) : "";
  return want ? rooms.find((r) => slug(r.name) === want) ?? null : null;
};

/** The room a node names itself, if it exists: a channel id first (a renamed room keeps its id), else the `room` name. */
export function ownRoom(n: Pick<RoomNode, "room" | "channels">, rooms: readonly RoomRef[]): RoomRef | null {
  const id = n.channels.find((c) => rooms.some((r) => r.id === c));
  return (id ? rooms.find((r) => r.id === id)! : null) ?? roomByName(rooms, n.room);
}

/** `own`: the node's room; `inherited`: an ancestor's (`from` is that ancestor); `uni`: nothing on the way, so #Uni. */
export type Steward = { room: RoomRef | null; via: "own" | "inherited" | "uni"; from: RoomNode | null };

/** `chain` runs from the node up to the top level. A named room that does not exist is skipped, not an error. */
export function steward(chain: readonly RoomNode[], rooms: readonly RoomRef[], uni: RoomRef | null): Steward {
  for (let i = 0; i < chain.length; i++) {
    const room = ownRoom(chain[i], rooms);
    if (room) return { room, via: i === 0 ? "own" : "inherited", from: chain[i] };
  }
  return { room: uni, via: "uni", from: null };
}

export const resolveRoom = (chain: readonly RoomNode[], rooms: readonly RoomRef[], uni: RoomRef | null): RoomRef | null => steward(chain, rooms, uni).room;

/** The line on a node page: which room stewards it. */
export function stewardLine(s: Steward): string | null {
  if (!s.room) return null;
  return s.via === "own" ? `Room #${s.room.name}` : `Stewarded by #${s.room.name}`;
}
