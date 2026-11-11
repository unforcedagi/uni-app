// T-335 the shape: each room's runs (moving, waiting on you), over the work store (src/projects/store.ts), which reads the run notes on the
// app's one poller and ages them by the clock.
import { useEffect, useMemo } from "react";
import { setWorkRooms, useWork } from "../projects/store";
import { runsByRoom } from "./runsCore";
import type { RoomRuns, ShapeRoom } from "./types";

/**
 * Tells the work store the account's rooms: a run note may hold only a room's id, and until the rooms are read a run with a room clue no
 * note names can't be told from a private one (it is held back, with no words). Pass null while the rooms list is still coming. Call it once,
 * where the shell holds the rooms (the old shell's AreasSurface did this; nothing else does).
 */
export function useFeedWorkRooms(rooms: readonly ShapeRoom[] | null): void {
  // the rooms list is a new array with every message: only a change of ids or names tells the store (it checks again itself)
  const key = rooms ? rooms.map((r) => `${r.id}\u0000${r.name}`).join("\u0001") : null;
  const refs = useMemo(() => (rooms ? rooms.map(({ id, name }) => ({ id, name })) : null), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setWorkRooms(refs); }, [refs]);
}

/** Each room's runs, keyed by channel id (a room with none is absent). Keeps the store read while it is shown. */
export function useRoomRuns(rooms: readonly ShapeRoom[]): Map<string, RoomRuns> {
  const { work } = useWork();
  const key = rooms.map((r) => r.id).join("\u0001");
  return useMemo(() => runsByRoom(work, rooms), [work, key]); // eslint-disable-line react-hooks/exhaustive-deps
}
