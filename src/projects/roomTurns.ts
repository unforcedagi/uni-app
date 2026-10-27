// T-304: the front door's "working" mark counts the room's Uni at work on your message (its turn), not only Claude Code sessions. A
// turn is read the way the room itself shows "Uni is working" (working.ts: Uni's 👀 on your newest message, until its reply), from each
// room's newest messages in the device's own message store (`get_messages`, nothing new is fetched for it).
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { workingOn } from "../working";
import type { Reaction } from "../reactions";

type Msg = { ref: string; author: string; ts: number; body: string; edited: boolean; last_reply_ts: number | null; reactions: Reaction[] };
/** How often the rooms are looked at again while the front door shows (a 👀 doesn't move a room's last message). */
export const TURNS_MS = 15_000;
/** The newest messages a turn is read from. */
const NEWEST = 30;

/** The rooms where the room's Uni is at work on your newest message now. */
export async function roomTurns(rooms: readonly string[], me: string | null, nowS = Date.now() / 1000): Promise<Set<string>> {
  const out = new Set<string>();
  if (!me) return out;
  await Promise.all(rooms.map(async (room) => {
    try {
      const msgs = await invoke<Msg[]>("get_messages", { channel: room, root: null, limit: NEWEST });
      if (Array.isArray(msgs) && workingOn(msgs, me, nowS)) out.add(room);
    } catch { /* a room that can't be read shows no turn */ }
  }));
  return out;
}

/** The front door's rooms with a turn under way; read again when a room's last message moves, and every TURNS_MS. */
export function useRoomTurns(rooms: readonly { room: string | null; lastTs: number | null }[], me: string | null): ReadonlySet<string> {
  const [turns, setTurns] = useState<ReadonlySet<string>>(() => new Set());
  const ids = rooms.map((r) => r.room).filter((r): r is string => !!r);
  const key = `${me ?? ""}|${rooms.map((r) => `${r.room}:${r.lastTs}`).join(",")}`;
  useEffect(() => {
    let live = true;
    const read = () => { void roomTurns(ids, me).then((t) => { if (live) setTurns((was) => (same(was, t) ? was : t)); }); };
    read();
    const timer = setInterval(() => { if (document.visibilityState === "visible") read(); }, TURNS_MS);
    return () => { live = false; clearInterval(timer); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return me ? turns : EMPTY;
}
const EMPTY: ReadonlySet<string> = new Set();
const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));
