// Who stewards a node, and so where a note dropped on it goes (pure, unit-tested in scripts/tasks.test.ts). Rule: a node's own room,
// else the nearest ancestor's, up to #Uni where an account still has one (#Uni was archived 10-26: on the live relay there is none, so
// the chain ends with no room, and nothing is said anywhere for it). A node names its room two ways: `channel` (room ids, which survive a rename) and `room`
// (a Buzz channel name, the T-84 field); an id that matches a known room wins, the name is the fallback.
// T-335 the shape: RoomRef, RoomNode, roomByName, ownRoom and steward now live in src/shape/privacy.ts; re-exported here.
import { roomByName, steward, type RoomNode, type RoomRef } from "../shape/privacy.ts";
export { roomByName, ownRoom, steward } from "../shape/privacy.ts";
export type { RoomRef, RoomNode, Steward } from "../shape/privacy.ts";

/**
 * 0.2.2: the room an ask belongs to. An ask (a task or decision) acts in its own room: its `room` (a channel id, or a room's name) when that
 * room exists, else the room that stewards its node (`nodeRoom`). Never the room that happens to be open, never a picker: an ask with no room
 * here has none, and says so.
 */
export function askRoom(t: { room?: string | null; node: string }, rooms: readonly RoomRef[], nodeRoom: (node: string) => RoomRef | null): RoomRef | null {
  const r = t.room?.trim() ?? "";
  const own = r ? rooms.find((x) => x.id === r) ?? roomByName(rooms, r) : null;
  return own ?? nodeRoom(t.node);
}



export const resolveRoom = (chain: readonly RoomNode[], rooms: readonly RoomRef[], uni: RoomRef | null): RoomRef | null => steward(chain, rooms, uni).room;
