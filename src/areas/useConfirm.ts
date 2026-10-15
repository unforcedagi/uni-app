// r28 (Codex P1-1, P1-2): an ask is confirmed in the feed, before any row shows. One read of each room's chat (cached), one pure answer per task
// (`confirmationOf`): confirmed, to recheck, or pending while its room's chat is still being read (for at most CONFIRM_WAIT_MS, then it is a
// recheck with "couldn't read"). The sheet takes the same answer; it never looks the chat up itself.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Task } from "./taskCore";
import { checkInResult, CONFIRM_WAIT_MS, confirmationOf, needsRead, requestKeys, UNRESOLVED, type Resolved, type RoomMsg } from "./simpleCore";

/** A room's chat is read again when the copy is older than this (the task list is re-read every minute). */
export const ROOM_TTL_MS = 60_000;
export const ROOM_LIMIT = 200;
type RoomRead = { at: number; msgs: RoomMsg[] | null };
/** Session memory: room id → its last read (null msgs: it failed). */
const reads = new Map<string, RoomRead>();
const inflight = new Set<string>();
export const forgetRoomReads = () => { reads.clear(); inflight.clear(); };

/**
 * One read of a room's recent chat. Test builds can block it (`VITE_CHECKIN_BLOCK=1`), delay it (`VITE_CHECKIN_DELAY=<ms>`) or find chat after
 * every ask (`VITE_CHECKIN_FOUND=1`, with `hint` the words of the room's asks) to show each state in the real app; none is in a normal build.
 */
async function readRoom(room: string, hint: string): Promise<RoomMsg[] | null> {
  const wait = Number(import.meta.env.VITE_CHECKIN_DELAY ?? 0) || 0;
  const go = async (): Promise<unknown> => {
    if (import.meta.env.VITE_CHECKIN_BLOCK === "1") throw new Error("blocked");
    if (import.meta.env.VITE_CHECKIN_FOUND === "1") return [{ ts: Date.now() / 1000 + 5, body: hint }];
    return invoke("get_messages", { channel: room, root: null, limit: ROOM_LIMIT });
  };
  const r = wait ? await new Promise<unknown>((res, rej) => setTimeout(() => go().then(res, rej), wait)) : await go();
  return Array.isArray(r) ? (r as RoomMsg[]) : null;
}

export type Confirmations = {
  /** the answer for one task: never undefined (a task the feed hasn't resolved is a recheck with no date) */
  of: (t: Task) => Resolved;
  /** read a room's chat again (the sheet's "Couldn't read #room · Retry") */
  retry: (room: string) => void;
  /** every room that has to be read has been (or has given up): the set of rechecks is final */
  settled: boolean;
};

/**
 * `tasks`: the visible list. `roomOf`: the room whose chat would answer an ask (its steward's), by id; null: no room to check in.
 * `stamp`: changes when the list is read again, so a room is read again with it.
 */
export function useConfirm(tasks: readonly Task[], roomOf: (t: Task) => { id: string } | null, stamp: number | null, ready: boolean): Confirmations {
  const [, bump] = useState(0);
  const [gaveUp, setGaveUp] = useState<ReadonlySet<string>>(new Set());
  const nowMs = useMemo(() => Date.now(), [tasks, stamp, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  /** room id → the words of its asks (only used by the test build that finds chat) */
  const wanted = useMemo(() => {
    const m = new Map<string, string>();
    if (!ready) return m;
    for (const t of tasks) {
      const room = roomOf(t);
      if (!room || !needsRead(true, t.askedAt, Date.now())) continue;
      const k = requestKeys(t);
      m.set(room.id, `${m.get(room.id) ?? ""} ${k.ids.join(" ")} ${k.words.join(" ")}`);
    }
    return m;
  }, [tasks, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = [...wanted.keys()].sort().join("\n");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const fetchRoom = useCallback((room: string, hint: string) => {
    if (inflight.has(room)) return;
    inflight.add(room);
    readRoom(room, hint).then((msgs) => msgs, () => null).then((msgs) => {
      inflight.delete(room);
      reads.set(room, { at: Date.now(), msgs });
      if (alive.current) { setGaveUp((g) => { if (!g.has(room)) return g; const c = new Set(g); c.delete(room); return c; }); bump((n) => n + 1); }
    });
  }, []);
  // every wanted room is read once and read again when its copy is old; while a room has no read, its asks are pending
  useEffect(() => {
    for (const [room, hint] of wanted) { const r = reads.get(room); if (!r || Date.now() - r.at > ROOM_TTL_MS) fetchRoom(room, hint); }
  }, [key, stamp, fetchRoom]); // eslint-disable-line react-hooks/exhaustive-deps
  // a room that has not answered in a few seconds is "couldn't read": its asks are rechecks, not held back for good
  useEffect(() => {
    const open = [...wanted.keys()].filter((r) => !reads.has(r));
    if (!open.length) return;
    const t = setTimeout(() => { setGaveUp((g) => new Set([...g, ...open.filter((r) => !reads.has(r))])); }, CONFIRM_WAIT_MS);
    return () => clearTimeout(t);
  }, [key, reads.size, gaveUp.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const retry = useCallback((room: string) => { reads.delete(room); setGaveUp((g) => { const c = new Set(g); c.delete(room); return c; }); bump((n) => n + 1); fetchRoom(room, wanted.get(room) ?? ""); }, [fetchRoom, wanted]);
  const memo = useRef(new Map<string, { sig: string; res: Resolved }>());
  const of = useCallback((t: Task): Resolved => {
    if (!ready) return UNRESOLVED;
    const room = roomOf(t);
    const hasRoom = !!room;
    let look = null as ReturnType<typeof checkInResult> | null;
    if (room && needsRead(true, t.askedAt, nowMs)) {
      const r = reads.get(room.id);
      if (r) look = checkInResult({ at: t.askedAt!, kind: "asked" }, r.msgs, requestKeys(t));
      else if (gaveUp.has(room.id)) look = { kind: "failed" };
    }
    const res = confirmationOf(hasRoom, t.askedAt, look, nowMs);
    const sig = `${t.updatedAt}|${t.askedAt}|${res.state}|${res.why}|${res.hit?.ts ?? ""}`;
    const had = memo.current.get(t.id);
    if (had && had.sig === sig) return had.res;
    memo.current.set(t.id, { sig, res });
    return res;
  }, [ready, roomOf, gaveUp, nowMs, reads.size, tasks]); // eslint-disable-line react-hooks/exhaustive-deps
  const settled = ready && [...wanted.keys()].every((r) => reads.has(r) || gaveUp.has(r));
  return { of, retry, settled };
}
