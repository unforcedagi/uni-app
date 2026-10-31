// T-335: an approval waiting in another room is said at the top of the room you are in ("Approval waiting in #dev"), so a card that
// landed somewhere else is never missed. Pure: the room pane renders it (ApprovalRows.tsx → ApprovalElsewhere).
import type { Approval } from "./approvals";

export type Elsewhere = {
  /** the one the line opens: the soonest to end (one with no stated end last), then the oldest */
  first: Approval;
  /** every approval waiting outside `here` */
  count: number;
  /** their rooms' channel ids, `first`'s room first, each once */
  rooms: string[];
};

/** The approvals waiting in rooms other than `here` (the room on screen; null: none is), or null when there are none. */
export function waitingElsewhere(approvals: readonly Approval[], here: string | null): Elsewhere | null {
  const away = approvals.filter((a) => a.channel !== here);
  if (!away.length) return null;
  const end = (a: Approval) => a.deadline ?? Number.POSITIVE_INFINITY;
  const sorted = [...away].sort((a, b) => end(a) - end(b) || a.ts - b.ts);
  const rooms: string[] = [];
  for (const a of sorted) if (!rooms.includes(a.channel)) rooms.push(a.channel);
  return { first: sorted[0], count: away.length, rooms };
}

const hash = (name: string | null) => (name ? `#${name.replace(/^#/, "")}` : "another room");

/** "Approval waiting in #dev" / "2 approvals waiting in #dev" / "3 approvals waiting in #dev and #techne" / "… in #dev and 2 more rooms". */
export function elsewhereText(e: Elsewhere, roomName: (id: string) => string | null): string {
  const what = e.count === 1 ? "Approval waiting" : `${e.count} approvals waiting`;
  const [one, two] = e.rooms.map((id) => hash(roomName(id)));
  const where = e.rooms.length === 1 ? one : e.rooms.length === 2 ? `${one} and ${two}` : `${one} and ${e.rooms.length - 1} more rooms`;
  return `${what} in ${where}`;
}
