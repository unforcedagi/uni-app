// T-229 Calendar: the pure part. Event notes in the shape the calendar door's contract gives them, recurrence
// expansion in the event's own time zone (the fake door and the checks use it; the app shows what the door expands),
// the day/week layout and the labels. No DOM, no clock of its own, no network. Lifted from the T-229 prototype.

export type Status = "confirmed" | "tentative" | "cancelled";
export type Visibility = "private" | "shared" | "public";
export type Scope = "this" | "following" | "all";

/** `address` is a `mailto:` address; `person` an optional `People/…` note. */
export type Attendee = { address: string; name?: string; partstat?: string; person?: string };

/** One `event` note's fields, as `GET /cal/v1/event/<id>` returns them. */
export type EventNote = {
  id: string;
  path?: string;
  rev: number;
  title: string;
  description?: string;
  /** UTC instant (`…Z`) for a timed event; `YYYY-MM-DD` for an all-day one. For a series, the first instance. */
  start: string;
  /** Exclusive. All-day: the day after the last day. */
  end: string;
  tz: string;
  all_day: boolean;
  status: Status;
  show_as: "busy" | "free";
  visibility: Visibility;
  shared_with?: string[];
  location?: string;
  attendees?: Attendee[];
  organizer?: { address: string; name?: string };
  /** RFC 5545 RRULE without the `RRULE:` prefix: FREQ=DAILY|WEEKLY, INTERVAL, BYDAY, COUNT, UNTIL. */
  rrule?: string;
  /** Instance starts (as written in `start`) removed from the series. */
  exdates?: string[];
  /** Changed instances, inside the series note. */
  overrides?: Override[];
  uid: string;
  sequence?: number;
  calendar?: string;
  source?: string;
  invite_pending?: boolean;
};

/** One changed instance of a series: its original start (RECURRENCE-ID), and what changed. */
export type Override = { recurrence_id: string; start?: string; end?: string; title?: string; status?: Status; location?: string };

/** One instance as `GET /cal/v1/events` lists it. */
export type DoorInstance = {
  id: string;
  uid: string;
  recurrence_id: string | null;
  start: string;
  end: string;
  all_day: boolean;
  tz: string;
  title: string;
  status: Status;
  show_as: "busy" | "free";
  visibility: Visibility;
  location?: string | null;
  attendees?: Attendee[];
  organizer?: { address: string; name?: string } | null;
  series: boolean;
  rev: number;
  invite_pending?: boolean;
};

export type Instance = {
  /** Unique per occurrence: the note id, plus the original start for a series instance. */
  key: string;
  /** What to show: the stored note with this instance's override applied. */
  note: EventNote;
  /** The note as stored (the series, for a series instance). Writes go to this one. */
  source: EventNote;
  override?: Override;
  seriesId?: string;
  /** Original start of a series instance (what an override's `recurrence_id` names). */
  recurrenceId?: string;
  start: number;
  end: number;
  allDay: boolean;
};

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// ── time zones: wall time in an IANA zone ↔ UTC, with nothing but Intl ──────────────────────────────────────────────

const fmts = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmts.set(tz, f);
  }
  return f;
}

export type Wall = { y: number; m: number; d: number; h: number; mi: number };

export function wall(ms: number, tz: string): Wall {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, mi: p.minute };
}

/** The UTC instant of a wall time in `tz`. A wall time skipped by a spring-forward gap lands after the gap. */
export function zoned(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const want = Date.UTC(y, m - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const w = wall(guess, tz);
    const diff = want - Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
    if (diff === 0) return guess;
    guess += diff;
  }
  return guess;
}

/** `YYYY-MM-DD` of an instant, in `tz`. */
export function dayKey(ms: number, tz: string): string {
  const w = wall(ms, tz);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

export function parseDay(key: string): { y: number; m: number; d: number } {
  const [y, m, d] = key.split("-").map(Number);
  return { y, m, d };
}

export function addDays(key: string, n: number): string {
  const { y, m, d } = parseDay(key);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. */
export function weekday(key: string): number {
  const { y, m, d } = parseDay(key);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function mondayOf(key: string): string {
  return addDays(key, -weekday(key));
}

/** Start of a local day, as a UTC instant. */
export function dayStart(key: string, tz: string): number {
  const { y, m, d } = parseDay(key);
  return zoned(y, m, d, 0, 0, tz);
}

/** An event's own bounds as instants: all-day dates are local midnights in the event's zone. */
export function bounds(n: Pick<EventNote, "start" | "end" | "all_day" | "tz">): { start: number; end: number } {
  if (n.all_day) return { start: dayStart(n.start.slice(0, 10), n.tz), end: dayStart(n.end.slice(0, 10), n.tz) };
  return { start: Date.parse(n.start), end: Date.parse(n.end) };
}

// ── recurrence ──────────────────────────────────────────────────────────────────────────────────────────────────────

const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

export type Rule = { freq: "DAILY" | "WEEKLY"; interval: number; byday: number[] | null; count: number | null; until: number | null };

/** Parses the RRULE subset the prototype writes. Anything else is refused rather than half-understood. */
export function parseRule(s: string): Rule {
  const kv = new Map(s.split(";").filter(Boolean).map((p) => { const [k, v] = p.split("="); return [k.toUpperCase(), v] as [string, string]; }));
  const freq = kv.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY") throw new Error(`unsupported FREQ: ${freq}`);
  for (const k of kv.keys()) if (!["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL"].includes(k)) throw new Error(`unsupported RRULE part: ${k}`);
  const byday = kv.has("BYDAY") ? kv.get("BYDAY")!.split(",").map((d) => { const i = DAYS.indexOf(d); if (i < 0) throw new Error(`bad BYDAY: ${d}`); return i; }).sort() : null;
  const u = kv.get("UNTIL");
  const until = u ? Date.parse(u.length === 8 ? `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}T23:59:59Z` : `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}T${u.slice(9, 11)}:${u.slice(11, 13)}:${u.slice(13, 15)}Z`) : null;
  return { freq, interval: Math.max(1, Number(kv.get("INTERVAL") ?? 1)), byday, count: kv.has("COUNT") ? Number(kv.get("COUNT")) : null, until };
}

export function untilStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Replaces or adds UNTIL (and drops COUNT): how "this and following" ends the old series. */
export function withUntil(rrule: string, until: number): string {
  const parts = rrule.split(";").filter((p) => p && !/^(UNTIL|COUNT)=/i.test(p));
  return [...parts, `UNTIL=${untilStamp(until)}`].join(";");
}

/** Replaces COUNT: how a split keeps a finite series finite. */
export function withCount(rrule: string, count: number): string {
  return [...rrule.split(";").filter((p) => p && !/^(UNTIL|COUNT)=/i.test(p)), `COUNT=${count}`].join(";");
}

/** Hard caps: a query never expands more than this many instances of one series. */
export const MAX_INSTANCES = 2000;

/**
 * The original starts of a series' instances that overlap [from, to). Walks local dates from the first start, so a
 * weekly 7 pm stays 7 pm across a daylight-saving change; COUNT counts from the first instance, not from `from`.
 */
export function occurrences(n: EventNote, from: number, to: number): number[] {
  if (!n.rrule) return [];
  const r = parseRule(n.rrule);
  const first = bounds(n);
  const w = n.all_day ? { ...parseDay(n.start.slice(0, 10)), h: 0, mi: 0 } : wall(first.start, n.tz);
  const startKey = `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
  const at = (key: string) => { const p = parseDay(key); return zoned(p.y, p.m, p.d, w.h, w.mi, n.tz); };
  const out: number[] = [];
  let made = 0;
  const take = (key: string): boolean => {
    const s = at(key);
    if (s < first.start) return true;
    if (r.until !== null && s > r.until) return false;
    if (r.count !== null && made >= r.count) return false;
    made++;
    if (s < to && instanceEnd(n, s) > from) out.push(s);
    return s < to && out.length < MAX_INSTANCES;
  };
  if (r.freq === "DAILY") {
    for (let i = 0; ; i += r.interval) if (!take(addDays(startKey, i))) break;
  } else {
    const days = r.byday ?? [weekday(startKey)];
    const mon = mondayOf(startKey);
    outer: for (let wk = 0; ; wk += r.interval) for (const d of days) if (!take(addDays(mon, wk * 7 + d))) break outer;
  }
  return out;
}

export function isoOf(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

export function sameInstant(a: string, b: string): boolean {
  return a === b || Date.parse(a) === Date.parse(b);
}

/** An instance's end: all-day series keep their length in days (a day across a DST change isn't 24 hours). */
function instanceEnd(n: EventNote, start: number): number {
  if (!n.all_day) { const b = bounds(n); return start + (b.end - b.start); }
  const days = Math.round((Date.UTC(...ymd(n.end)) - Date.UTC(...ymd(n.start))) / 86_400_000);
  return dayStart(addDays(dayKey(start, n.tz), days), n.tz);
}
const ymd = (k: string): [number, number, number] => { const p = parseDay(k.slice(0, 10)); return [p.y, p.m - 1, p.d]; };

export function ridOf(n: EventNote, ms: number): string {
  return n.all_day ? dayKey(ms, n.tz) : isoOf(ms);
}

/**
 * Every instance overlapping [from, to): single events, and series expanded minus their exdates, with each
 * override shown at its own time (it may have moved into or out of the window).
 */
export function expand(notes: EventNote[], from: number, to: number): Instance[] {
  const out: Instance[] = [];
  for (const n of notes) {
    if (!n.rrule) {
      const b = bounds(n);
      if (b.start < to && b.end > from) out.push({ key: n.id, note: n, source: n, start: b.start, end: b.end, allDay: n.all_day });
      continue;
    }
    const ex = (rid: string) => (n.exdates ?? []).some((x) => sameInstant(x, rid));
    const ovs = n.overrides ?? [];
    for (const s of occurrences(n, from, to)) {
      const rid = ridOf(n, s);
      if (ex(rid) || ovs.some((o) => sameInstant(o.recurrence_id, rid))) continue;
      out.push({ key: `${n.id}@${rid}`, note: n, source: n, seriesId: n.id, recurrenceId: rid, start: s, end: instanceEnd(n, s), allDay: n.all_day });
    }
    for (const o of ovs) {
      if (ex(o.recurrence_id)) continue;
      const ridStart = n.all_day ? dayStart(o.recurrence_id.slice(0, 10), n.tz) : Date.parse(o.recurrence_id);
      const os = o.start ?? (n.all_day ? o.recurrence_id : o.recurrence_id), oe = o.end ?? (n.all_day ? dayKey(instanceEnd(n, ridStart), n.tz) : isoOf(instanceEnd(n, ridStart)));
      const b = bounds({ ...n, start: os, end: oe });
      if (!(b.start < to && b.end > from)) continue;
      const shown: EventNote = { ...n, start: os, end: oe, title: o.title ?? n.title, status: o.status ?? n.status, location: o.location ?? n.location };
      out.push({ key: `${n.id}@${o.recurrence_id}`, note: shown, source: n, override: o, seriesId: n.id, recurrenceId: o.recurrence_id, start: b.start, end: b.end, allDay: n.all_day });
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end || a.key.localeCompare(b.key));
}

// ── layout: side-by-side columns for overlapping events in one day ─────────────────────────────────────────────────

export type Placed = { inst: Instance; col: number; cols: number };

export function layoutDay(items: Instance[]): Placed[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -Infinity;
  const flush = () => { const n = Math.max(1, ...cluster.map((p) => p.col + 1)); for (const p of cluster) p.cols = n; out.push(...cluster); cluster = []; };
  for (const inst of sorted) {
    if (inst.start >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((p) => p.inst.end > inst.start).map((p) => p.col));
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({ inst, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd, inst.end);
  }
  if (cluster.length) flush();
  return out;
}

// ── display ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const timeFmts = new Map<string, Intl.DateTimeFormat>();
export function timeLabel(ms: number, tz: string): string {
  let f = timeFmts.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }); timeFmts.set(tz, f); }
  return f.format(new Date(ms)).replace(":00", "").replace(" ", " ");
}

export function dayLabel(key: string, style: "long" | "short" = "long"): string {
  const { y, m, d } = parseDay(key);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: style === "long" ? "long" : "short", month: "short", day: "numeric" }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function rangeLabel(inst: Pick<Instance, "start" | "end" | "allDay">, tz: string): string {
  if (inst.allDay) {
    const a = dayKey(inst.start, tz), b = addDays(dayKey(inst.end, tz), -1);
    return a === b ? `${dayLabel(a)} · all day` : `${dayLabel(a, "short")} – ${dayLabel(b, "short")} · all day`;
  }
  return `${dayLabel(dayKey(inst.start, tz))} · ${timeLabel(inst.start, tz)} – ${timeLabel(inst.end, tz)}`;
}

/** Plain words for a rule: "Every Tue and Thu", "Every day, 5 times". */
export function ruleLabel(rrule: string): string {
  const r = parseRule(rrule);
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const every = r.interval > 1 ? `Every ${r.interval} ${r.freq === "DAILY" ? "days" : "weeks"}` : r.freq === "DAILY" ? "Every day" : "Every week";
  const on = r.byday ? (r.byday.join() === "0,1,2,3,4" ? " on weekdays" : ` on ${r.byday.map((d) => names[d]).join(" and ").replace(/ and (?=.* and )/g, ", ")}`) : "";
  const end = r.count ? `, ${r.count} times` : r.until ? `, until ${new Date(r.until).toISOString().slice(0, 10)}` : "";
  return every + on + end;
}

/** An attendee's name, or the address without `mailto:`. */
export function attendeeName(a: Attendee): string {
  return a.name || a.address.replace(/^mailto:/i, "");
}

/** A door instance's bounds as instants: all-day dates are local midnights in the event's zone. */
export function instBounds(i: Pick<DoorInstance, "start" | "end" | "all_day" | "tz">): { start: number; end: number } {
  return bounds({ start: i.start, end: i.end, all_day: i.all_day, tz: i.tz });
}
