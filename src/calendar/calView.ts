// T-229 Calendar: the view's decisions, pure (scripts/calendar.test.ts checks them). Which days a view shows and which
// window it asks the door for; what the door's key may do here (its session's ops: the Uni-unsafe ones, delete and
// sending invites, are hidden from any key the door doesn't give them to); what an error says; and the snapshot kept
// on the device so an offline Calendar still shows the last days it read, read-only.
import { addDays, attendeeName, dayKey, dayStart, instBounds, isoOf, mondayOf, wall, zoned, type Attendee, type DoorInstance, type EventNote } from "./calCore.ts";

export type View = "day" | "week" | "agenda";
export const AGENDA_DAYS = 21;
export const DEFAULT_TZ = "America/Denver";

/** What the door says this key may do (`GET /cal/v1/session`). `fallback`: the door has no session route. */
export type Session = { role: string; ops: string[]; calendar?: string; tz?: string; fallback?: boolean };

/**
 * A door without the session route: what every key it takes may do (owner and uni alike). Delete and sending invites
 * need the door to say so, so they stay hidden.
 */
export const FALLBACK_SESSION: Session = { role: "unknown", ops: ["create", "update", "move", "cancel"], fallback: true };

export const can = (s: Session | null | undefined, op: string): boolean => !!s && s.ops.includes(op);

export type CalErr = { kind: "unreachable" | "not_allowed" | "stale" | "refused" | "server" | "invalid"; message?: string; status?: number; current_rev?: number | null; pubkey?: string };

export function asCalErr(e: unknown): CalErr {
  if (e && typeof e === "object" && typeof (e as CalErr).kind === "string") return e as CalErr;
  return { kind: "invalid", message: e instanceof Error ? e.message : String(e) };
}

/** One sentence for the view. */
export function problemText(e: CalErr): string {
  switch (e.kind) {
    case "unreachable": return "The calendar door isn't answering. It's on the tailnet only.";
    case "not_allowed": return "The calendar door doesn't take this device's key for that.";
    case "stale": return "It changed since you opened it. Here it is now; nothing was saved.";
    case "server": return `The calendar door couldn't do it: ${e.message ?? "server error"}.`;
    case "refused": return `The calendar door said no: ${e.message ?? `error ${e.status}`}.`;
    default: return `Something went wrong: ${e.message ?? "unknown error"}.`;
  }
}

/** The days a time grid shows: one, a week from Monday, or three on a phone. */
export function daysFor(view: View, focus: string, phone: boolean): string[] {
  if (view === "day") return [focus];
  if (view === "week") return phone ? [focus, addDays(focus, 1), addDays(focus, 2)] : Array.from({ length: 7 }, (_, i) => addDays(mondayOf(focus), i));
  return Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(focus, i));
}

/** How far ‹ and › move. */
export const stepFor = (view: View, phone: boolean): number => (view === "day" ? 1 : view === "week" ? (phone ? 3 : 7) : 7);

/** The window the door is asked for: local midnight of the first day to local midnight after the last, as UTC. */
export function windowFor(days: string[], tz: string): { from: string; to: string } {
  return { from: isoOf(dayStart(days[0], tz)), to: isoOf(dayStart(addDays(days[days.length - 1], 1), tz)) };
}

/** An instance as the view uses it: the door's fields, its key and its bounds as instants. */
export type Shown = DoorInstance & { key: string; s: number; e: number };

export const instKey = (i: Pick<DoorInstance, "id" | "recurrence_id">): string => (i.recurrence_id ? `${i.id}@${i.recurrence_id}` : i.id);

export function toShown(list: DoorInstance[]): Shown[] {
  return list.map((i) => { const b = instBounds(i); return { ...i, key: instKey(i), s: b.start, e: b.end }; }).sort((a, b) => a.s - b.s || b.e - a.e || a.key.localeCompare(b.key));
}

// ── the offline snapshot ────────────────────────────────────────────────────────────────────────────────────────────

export const SNAPSHOT_KEY = "uni.cal.snapshot.v1";
/** The Calendar answered on this device once: the rail shows it (offline too) until a door refuses the key. */
export const SEEN_KEY = "uni.cal.seen.v1";
export const MAX_WINDOWS = 8;

export type Window = { from: string; to: string; instances: DoorInstance[] };
export type Snapshot = { v: 1; at: string; session: Session | null; windows: Window[] };

/** The snapshot after a read: this window replaces any it covers, newest first, at most [`MAX_WINDOWS`]. */
export function remember(snap: Snapshot | null, w: Window, at: string, session: Session | null): Snapshot {
  const covered = (x: Window) => x.from >= w.from && x.to <= w.to;
  const windows = [w, ...(snap?.windows ?? []).filter((x) => !covered(x))].slice(0, MAX_WINDOWS);
  return { v: 1, at, session: session ?? snap?.session ?? null, windows };
}

/**
 * What the snapshot holds for [from, to): the newest read of each instance, and whether the saved windows cover all
 * of it (`complete`). `null` when nothing saved touches it.
 */
export function fromSnapshot(snap: Snapshot | null, from: string, to: string): { instances: DoorInstance[]; complete: boolean } | null {
  if (!snap) return null;
  const f = Date.parse(from), t = Date.parse(to);
  const touching = snap.windows.filter((w) => Date.parse(w.from) < t && Date.parse(w.to) > f);
  if (!touching.length) return null;
  const seen = new Set<string>();
  const instances: DoorInstance[] = [];
  for (const w of touching) for (const i of w.instances) {
    const k = instKey(i);
    if (seen.has(k)) continue;
    seen.add(k);
    const b = instBounds(i);
    if (b.start < t && b.end > f) instances.push(i);
  }
  // covered when the windows, joined, reach from `from` to `to` with no gap
  let reach = f;
  for (const w of [...touching].sort((a, b) => Date.parse(a.from) - Date.parse(b.from))) if (Date.parse(w.from) <= reach) reach = Math.max(reach, Date.parse(w.to));
  return { instances, complete: reach >= t };
}

export function parseSnapshot(raw: string | null): Snapshot | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    return s && s.v === 1 && Array.isArray(s.windows) ? s as Snapshot : null;
  } catch { return null; }
}

// ── invitations ─────────────────────────────────────────────────────────────────────────────────────────────────────

const addr = (a: string) => a.replace(/^mailto:/i, "").toLowerCase();

/** The people an invite goes to: every attendee but the organizer. */
export function invitees(n: Pick<EventNote, "attendees" | "organizer">): Attendee[] {
  const org = n.organizer?.address ? addr(n.organizer.address) : null;
  return (n.attendees ?? []).filter((a) => addr(a.address) !== org);
}

type InviteFields = Pick<EventNote, "attendees" | "organizer" | "status" | "invite_pending" | "invite_state" | "invite_detail">;

/**
 * Whether "Send invites" is offered: the key may send them, the door marks the invites waiting (`invite_pending`), and
 * they aren't already on their way (`invite_state` queued). After a tap the door may say the event changed since
 * (stale) or the send failed: then it is offered again. A door that doesn't carry the mark: a tentative event with
 * people to invite.
 */
export function invitesWaiting(n: InviteFields, s: Session | null): boolean {
  if (!can(s, "send_invites") || invitees(n).length === 0) return false;
  if (n.invite_state === "queued" || n.invite_state === "sent") return false;
  return n.invite_pending === undefined ? n.status === "tentative" : n.invite_pending;
}

/** What the panel says about the invites, if anything. */
export function inviteWords(n: InviteFields): string | null {
  switch (n.invite_state) {
    case "queued": return "Invites are on their way, from your address.";
    case "stale": return "The event changed after you sent the invites; send them again.";
    case "refused": case "failed": return `The invites didn't go${n.invite_detail ? `: ${n.invite_detail}` : ""}.`;
    default: return null;
  }
}

/** "Juno Park <juno@example.com>", for the confirm. */
export const inviteeLine = (a: Attendee): string => (a.name ? `${a.name} <${addr(a.address)}>` : addr(a.address));

/**
 * The attendees typed as addresses, comma- or space-separated. Names already known for an address are kept. `null`
 * names the first entry that isn't an address.
 */
export function parseAttendees(text: string, known: Attendee[] = []): Attendee[] | { bad: string } {
  const out: Attendee[] = [];
  for (const raw of text.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean)) {
    const a = addr(raw);
    if (!/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(a)) return { bad: raw };
    if (out.some((x) => addr(x.address) === a)) continue;
    const had = known.find((k) => addr(k.address) === a);
    out.push(had ?? { address: `mailto:${a}`, partstat: "NEEDS-ACTION" });
  }
  return out;
}

export const attendeesText = (list: Attendee[] | undefined): string => (list ?? []).map((a) => addr(a.address)).join(", ");

const PARTSTAT: Record<string, string> = { ACCEPTED: "accepted", DECLINED: "declined", TENTATIVE: "maybe", "NEEDS-ACTION": "no answer yet", DELEGATED: "delegated" };
export const partstatWords = (p?: string): string => PARTSTAT[(p ?? "").toUpperCase()] ?? "no answer yet";
export const who = attendeeName;

/** A fresh op id: the door applies one op id once, so a retry of the same tap reuses it. */
export function newOpId(): string {
  const r = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return `app-${r.slice(0, 24)}`;
}

// ── times from a form ───────────────────────────────────────────────────────────────────────────────────────────────

/** Whole days from one `YYYY-MM-DD` to another. */
export function daysBetween(a: string, b: string): number {
  const at = (k: string) => { const [y, m, d] = k.slice(0, 10).split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((at(b) - at(a)) / 86_400_000);
}

/** Two `start`/`end` values name the same time: the same day, or the same instant however it is written. */
export const sameTime = (a: string | undefined, b: string | undefined): boolean =>
  a === b || (!!a && !!b && a.length > 10 && b.length > 10 && Date.parse(a) === Date.parse(b));

export type FormTimes = { day: string; allDay: boolean; start: string; end: string; endOffset: number; lastDay: string };

/**
 * The times a form makes, in `tz`. Timed: the end is `endOffset` days after the start day (an event that ran over
 * midnight keeps doing so), or the next day when it would otherwise not be after the start. All-day: from the first day
 * to the last, inclusive (stored with the exclusive end).
 */
export function formTimes(f: FormTimes, tz: string): { start: string; end: string; endDay: string } | { error: string } {
  if (f.allDay) {
    if (f.lastDay < f.day) return { error: "The last day can't be before the first." };
    return { start: f.day, end: addDays(f.lastDay, 1), endDay: f.lastDay };
  }
  const at = (day: string, hhmm: string) => { const [y, m, d] = day.split("-").map(Number); const [h, mi] = hhmm.split(":").map(Number); return zoned(y, m, d, h, mi, tz); };
  const s = at(f.day, f.start);
  let endDay = addDays(f.day, f.endOffset);
  let e = at(endDay, f.end);
  if (e <= s && f.endOffset === 0) { endDay = addDays(f.day, 1); e = at(endDay, f.end); }
  if (e <= s) return { error: "It has to end after it starts." };
  return { start: isoOf(s), end: isoOf(e), endDay };
}

/** An all-day event moved to start on `day`: as many days long as it was, whatever the clocks did. */
export const allDayMoved = (start: string, end: string, day: string): { start: string; end: string } => ({ start: day, end: addDays(day, daysBetween(start, end)) });

/**
 * Where a drag puts an event's start: in its own column, the instant moved by the minutes (so a start in the hour a
 * clock change repeats stays in the one it was); across columns, the same wall time that many days on, then the minutes.
 */
export function dragTarget(start: number, columns: number, minutes: number, tz: string): number {
  if (columns === 0) return start + minutes * 60_000;
  const w = wall(start, tz);
  const [y, m, d] = addDays(dayKey(start, tz), columns).split("-").map(Number);
  return zoned(y, m, d, w.h, w.mi, tz) + minutes * 60_000;
}
