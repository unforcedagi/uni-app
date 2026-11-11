// T-335: what is new in a room, for its row on home. The counts come from the rooms list (`get_rooms`: messages from others since your
// read marker, and whether one names you); opening a room marks it read, so they clear. Unit-tested in scripts/roomUnread.test.ts.

/** A room's unread messages, and whether any of them mentions you. */
export type Unread = { n: number; mention: boolean };

/** "3 new" / "3 new, mentions you": a row's or a door's words for a screen reader and a tooltip. */
export const unreadWords = (u: Unread) => `${u.n} new${u.mention ? ", mentions you" : ""}`;
/** The pill's text: 99 at most, so a busy room never widens the row. */
export const unreadShort = (n: number) => (n > 99 ? "99+" : String(n));
