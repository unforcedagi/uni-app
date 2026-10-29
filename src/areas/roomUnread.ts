// T-335: what is new in each room, beside what needs you there (pure, unit-tested in scripts/roomUnread.test.ts). The counts come from the
// rooms list (`get_rooms`: messages from others since your read marker, and whether one names you); opening a room marks it read, so they clear.
import type { FoldRow } from "./sidebarState.ts";

/** A room's unread messages, and whether any of them mentions you. */
export type Unread = { n: number; mention: boolean };
export type UnreadRoom = { id: string; unread?: number; mentions?: boolean };

const add = (a: Unread | undefined, b: Unread): Unread => ({ n: (a?.n ?? 0) + b.n, mention: !!a?.mention || b.mention });
const of = (r: UnreadRoom): Unread | null => (r.unread ?? 0) > 0 ? { n: r.unread!, mention: !!r.mentions } : null;

/** Unread by room id (rooms with nothing new are left out). */
export function unreadByRoom(rooms: readonly UnreadRoom[]): Map<string, Unread> {
  const m = new Map<string, Unread>();
  for (const r of rooms) { const u = of(r); if (u) m.set(r.id, u); }
  return m;
}

/** Unread by the tree row that owns the room (`owned`: room id -> its node's path). A room no node owns is not here: it is an "Other room". */
export function unreadByPath(byRoom: ReadonlyMap<string, Unread>, owned: ReadonlyMap<string, { path: string }>): Map<string, Unread> {
  const m = new Map<string, Unread>();
  for (const [id, u] of byRoom) { const p = owned.get(id)?.path; if (p !== undefined) m.set(p, add(m.get(p), u)); }
  return m;
}

/** Row `i`'s own unread plus every row inside it (a folded area shows what is new beneath it). */
export function rolledUnread(rows: readonly FoldRow[], byPath: ReadonlyMap<string, Unread>, i: number): Unread | null {
  let u: Unread | undefined = byPath.get(rows[i].path);
  // a project linked to two areas has two rows and one room: count it once
  const seen = new Set([rows[i].path]);
  for (let j = i + 1; j < rows.length && rows[j].depth > rows[i].depth; j++) {
    const p = rows[j].path; if (seen.has(p)) continue; seen.add(p);
    const k = byPath.get(p); if (k) u = add(u, k);
  }
  return u && u.n > 0 ? u : null;
}

/**
 * The approval prompts waiting in each room, added to the tree's needs-you counts: a prompt in a room a node owns counts on that node's row,
 * a prompt in any other room on that room (by id, for "Other rooms").
 */
export function withApprovalNeeds(needs: ReadonlyMap<string, number>, approvals: readonly { channel: string }[], owned: ReadonlyMap<string, { path: string }> | null): { byPath: Map<string, number>; byRoom: Map<string, number> } {
  const byPath = new Map(needs); const byRoom = new Map<string, number>();
  for (const a of approvals) {
    const p = owned?.get(a.channel)?.path;
    if (p !== undefined) byPath.set(p, (byPath.get(p) ?? 0) + 1);
    else byRoom.set(a.channel, (byRoom.get(a.channel) ?? 0) + 1);
  }
  return { byPath, byRoom };
}

/** "3 new" / "3 new, mentions you": a row's or a door's words for a screen reader and a tooltip. */
export const unreadWords = (u: Unread) => `${u.n} new${u.mention ? ", mentions you" : ""}`;
/** The pill's text: 99 at most, so a busy room never widens the row. */
export const unreadShort = (n: number) => (n > 99 ? "99+" : String(n));
