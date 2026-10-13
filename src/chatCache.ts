// T-124 r9: the last messages of each room, and the rooms list, kept on this device (per identity), so the app paints the conversation at once
// on launch and on open, then refreshes in the background. Pure over a Storage so it is unit-tested; nothing here ever leaves the device.
export const CACHE_MESSAGES = 60;
/** Rooms whose messages are kept; the least recently written go first. */
export const CACHE_ROOMS = 24;
const WHO = "uni.cache.who.v1";
const ROOMS = (who: string) => `uni.cache.rooms.v1:${who}`;
const MSGS = (who: string, channel: string) => `uni.cache.msgs.v1:${who}:${channel}`;
const INDEX = (who: string) => `uni.cache.index.v1:${who}`;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const parse = <T>(raw: string | null): T | null => { if (!raw) return null; try { return JSON.parse(raw) as T; } catch { return null; } };

/** The identity this device last ran as: the cache is read before the app has asked for it. */
export const readWho = (s: Store): string | null => { try { return s.getItem(WHO); } catch { return null; } };
export const writeWho = (s: Store, who: string) => { try { s.setItem(WHO, who); } catch { /* private storage */ } };

export function readRooms<R>(s: Store, who: string | null): R[] {
  if (!who) return [];
  try { const v = parse<R[]>(s.getItem(ROOMS(who))); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function writeRooms(s: Store, who: string | null, rooms: readonly unknown[]) {
  if (!who) return;
  try { s.setItem(ROOMS(who), JSON.stringify(rooms)); } catch { /* full or private storage */ }
}

export function readMessages<M>(s: Store, who: string | null, channel: string): M[] | null {
  if (!who) return null;
  try { const v = parse<M[]>(s.getItem(MSGS(who, channel))); return Array.isArray(v) && v.length ? v : null; } catch { return null; }
}
/** Keeps the newest `CACHE_MESSAGES` (by time), oldest first. An empty room clears its entry. */
export function writeMessages<M extends { ts: number }>(s: Store, who: string | null, channel: string, rows: readonly M[]) {
  if (!who) return;
  try {
    const keep = [...rows].sort((a, b) => a.ts - b.ts).slice(-CACHE_MESSAGES);
    const idx = (parse<string[]>(s.getItem(INDEX(who))) ?? []).filter((c) => c !== channel);
    if (!keep.length) { s.removeItem(MSGS(who, channel)); s.setItem(INDEX(who), JSON.stringify(idx)); return; }
    idx.push(channel);
    for (const old of idx.splice(0, Math.max(0, idx.length - CACHE_ROOMS))) s.removeItem(MSGS(who, old));
    s.setItem(MSGS(who, channel), JSON.stringify(keep));
    s.setItem(INDEX(who), JSON.stringify(idx));
  } catch { /* full or private storage: the cache is a convenience */ }
}
