// T-229: a fake calendar door, from the build's shared fixture (scripts/fixtures/cal-sample-events.json, made-up
// events). It answers the signed API in the door's contract the way the real door (`uni-cal`) does for the app's side:
// a session with the key's role and ops, instances expanded in the event's own zone, one note per event, named ops that
// are idempotent on their opId and a compare-and-set on `rev` (409 {current_rev}), the three scopes on a series, owner-
// only `delete` and `send_invites`, and the conflict records. It holds no network: the browser checks route requests to
// `handle()` in the test process (scripts/browser/calMock.ts), and scripts/fake-cal-door.ts serves it over HTTP for the
// real app. Nothing here is the app; the app reads what a door answers.
import { addDays, bounds, dayKey, dayStart, expand, isoOf, occurrences, parseRule, ridOf, sameInstant, withCount, withUntil, type Attendee, type EventNote, type Override, type Scope, type Status, type Visibility } from "../src/calendar/calCore.ts";

export type Role = "owner" | "uni";
export type Answer = { status: number; body: unknown };
export type Fixture = {
  calendar: string; tz: string; organizer: { address: string; name?: string };
  events: (Partial<EventNote> & { fixture_id: string; title: string; start: string; end: string; description?: string })[];
};
export type ConflictRecord = { id: string; event_id: string; title: string; adapter: string; created: string;
  vault: { start: string; end: string; title: string; location?: string | null; status: Status };
  outside: { start: string; end: string; title: string; location?: string | null; status: Status } };

const OWNER_OPS = ["create", "update", "move", "cancel", "delete", "rsvp", "send_invites"];
const UNI_OPS = ["create", "update", "move", "cancel", "rsvp"];

/** Fields the app may set through `create` and `update`. Anything else in `fields` is refused (400). */
const EDITABLE = ["title", "description", "start", "end", "all_day", "tz", "location", "visibility", "shared_with", "attendees", "rrule", "status", "show_as"];
/** What a "this" edit may change on one instance of a series (it becomes an override inside the series note). */
const PER_INSTANCE = ["title", "start", "end", "location", "status"];

export class FakeDoor {
  notes = new Map<string, EventNote>();
  conflicts: ConflictRecord[] = [];
  /** Every request, in order, with the role it was made as. */
  log: { method: string; path: string; body?: any; role: Role }[] = [];
  /** `send_invites` hands off here (the Stalwart adapter's outbox, in the real door). */
  outbox: { id: string; to: string[] }[] = [];
  role: Role = "owner";
  /** `session` answers 404, as a door without the proposed route would. */
  noSession = false;
  private done = new Map<string, { req: string; answer: Answer }>();
  private seq = 0;
  readonly tz: string;
  readonly organizer: { address: string; name?: string };

  constructor(fx: Fixture, opts: { role?: Role; conflict?: boolean } = {}) {
    this.tz = fx.tz;
    this.organizer = fx.organizer;
    this.role = opts.role ?? "owner";
    for (const e of fx.events) {
      const { fixture_id, ...rest } = e;
      const id = fixture_id;
      const n: EventNote = { tz: fx.tz, all_day: false, status: "confirmed", show_as: "busy", visibility: "private", ...rest,
        id, rev: 1, uid: `${id}@uni.example.com`, sequence: 0, calendar: fx.calendar, source: "import", organizer: fx.organizer,
        path: `Calendar/${e.all_day ? e.start : dayKey(Date.parse(e.start), fx.tz)} ${e.title}` } as EventNote;
      this.notes.set(id, n);
    }
    if (opts.conflict) {
      const n = this.notes.get("fx-lunch")!;
      this.conflicts.push({ id: "cf-lunch", event_id: n.id, title: n.title, adapter: "google", created: "2026-10-21T15:04:00Z",
        vault: { start: n.start, end: n.end, title: n.title, location: n.location ?? null, status: n.status },
        outside: { start: "2026-10-22T18:30:00Z", end: "2026-10-22T19:30:00Z", title: n.title, location: n.location ?? null, status: n.status } });
    }
  }

  /** Another writer changed the note (a phone, Uni in chat): its `rev` moves on, so a write based on the old one is stale. */
  touch(id: string, patch: Partial<EventNote> = {}) {
    const n = this.notes.get(id);
    if (!n) throw new Error(`no note ${id}`);
    this.notes.set(id, { ...n, ...patch, rev: n.rev + 1 });
  }

  handle(method: string, url: string, body?: any): Answer {
    const u = new URL(url, "http://door.invalid");
    this.log.push({ method, path: u.pathname + u.search, body, role: this.role });
    const p = u.pathname;
    if (method === "GET" && p === "/cal/v1/session") {
      if (this.noSession) return err(404, "not found");
      return ok({ role: this.role, ops: this.role === "owner" ? OWNER_OPS : UNI_OPS, calendar: "aaron", tz: this.tz });
    }
    if (method === "GET" && p === "/cal/v1/events") {
      const from = Date.parse(u.searchParams.get("from") ?? ""), to = Date.parse(u.searchParams.get("to") ?? "");
      if (!(from < to)) return err(400, "from and to are required, from before to");
      return ok({ complete: true, instances: this.instances(from, to) });
    }
    const m = /^\/cal\/v1\/event\/([A-Za-z0-9_-]+)$/.exec(p);
    if (method === "GET" && m) {
      const n = this.notes.get(m[1]);
      return n ? ok({ ...n, ics: ics(n) }) : err(404, "no such event");
    }
    if (method === "GET" && p === "/cal/v1/conflicts") return ok({ conflicts: this.conflicts });
    if (method === "POST" && p === "/cal/v1/op") return this.op(body ?? {});
    return err(404, "not found");
  }

  instances(from: number, to: number) {
    return expand([...this.notes.values()], from, to).map((i) => ({
      id: i.source.id, uid: i.source.uid, recurrence_id: i.recurrenceId ?? null,
      start: i.allDay ? dayKey(i.start, i.note.tz) : isoOf(i.start), end: i.allDay ? dayKey(i.end, i.note.tz) : isoOf(i.end),
      all_day: i.allDay, tz: i.note.tz, title: i.note.title, status: i.note.status, show_as: i.note.show_as, visibility: i.note.visibility,
      location: i.note.location ?? null, attendees: i.note.attendees ?? [], organizer: i.note.organizer ?? null, series: !!i.source.rrule,
      rev: i.source.rev, invite_pending: !!i.source.invite_pending,
    }));
  }

  private op(b: any): Answer {
    if (typeof b.op !== "string" || typeof b.opId !== "string" || !b.opId) return err(400, "op and opId are required");
    const req = JSON.stringify(b);
    const seen = this.done.get(b.opId);
    if (seen) return seen.req === req ? seen.answer : err(409, "this opId was used for a different request");
    const allowed = this.role === "owner" ? OWNER_OPS : UNI_OPS;
    if (!allowed.includes(b.op)) return err(403, `${b.op} isn't allowed for this key`);
    const answer = this.run(b);
    // a stale write isn't an outcome: the same op may be sent again once the app has read the note again
    if (answer.status !== 409) this.done.set(b.opId, { req, answer });
    return answer;
  }

  private run(b: any): Answer {
    if (b.op === "create") {
      const f = b.fields ?? {};
      const bad = check(f);
      if (bad) return err(400, bad);
      if (!f.title || !f.start || !f.end) return err(400, "a new event needs a title, a start and an end");
      const id = `ev-${String(++this.seq).padStart(4, "0")}`;
      const others = (f.attendees ?? []).filter((a: Attendee) => a.address.toLowerCase() !== this.organizer.address.toLowerCase());
      const n: EventNote = { tz: this.tz, all_day: false, show_as: "busy", visibility: "private", ...f, status: others.length ? "tentative" : f.status ?? "confirmed",
        id, rev: 1, uid: `${id}@uni.example.com`, sequence: 0, calendar: "aaron", source: "uni-app", organizer: this.organizer,
        path: `Calendar/${f.all_day ? f.start : dayKey(Date.parse(f.start), f.tz ?? this.tz)} ${f.title}`, ...(others.length ? { invite_pending: true } : {}) };
      this.notes.set(id, n);
      return ok({ ok: true, opId: b.opId, id, rev: 1 });
    }
    const n = this.notes.get(b.id);
    if (!n) return err(404, "no such event");
    if (b.op === "send_invites") {
      if (!n.invite_pending) return err(409, "no invites are waiting on this event");
      this.outbox.push({ id: n.id, to: (n.attendees ?? []).map((a) => a.address) });
      this.notes.set(n.id, { ...n, invite_pending: false, rev: n.rev + 1 });
      return ok({ ok: true, opId: b.opId, id: n.id, rev: n.rev + 1, state: "queued" });
    }
    if (b.op === "rsvp") {
      this.notes.set(n.id, { ...n, rev: n.rev + 1 });
      return ok({ ok: true, opId: b.opId, id: n.id, rev: n.rev + 1 });
    }
    if (b.base_rev !== n.rev) return { status: 409, body: { error: "the event changed since it was read", current_rev: n.rev } };
    if (b.op === "delete") { this.notes.delete(n.id); return ok({ ok: true, opId: b.opId, id: n.id }); }
    const scope: Scope = b.scope ?? "all";
    if (!["this", "following", "all"].includes(scope)) return err(400, "scope is this, following or all");
    if (n.rrule && scope !== "all" && !b.recurrence_id) return err(400, `a "${scope}" change to a series names its recurrence_id`);
    let patch: Partial<EventNote>;
    if (b.op === "move") {
      if (!b.start || !b.end) return err(400, "a move needs a start and an end");
      patch = { start: b.start, end: b.end };
    } else if (b.op === "cancel") {
      patch = { status: "cancelled" };
    } else if (b.op === "update") {
      const bad = check(b.fields ?? {});
      if (bad) return err(400, bad);
      patch = b.fields ?? {};
    } else return err(400, `unknown op ${b.op}`);
    const r = !n.rrule || scope === "all" ? this.whole(n, patch, b.op === "move" ? b.recurrence_id : undefined) : scope === "this" ? this.one(n, b.recurrence_id, patch) : this.following(n, b.recurrence_id, patch);
    if (typeof r === "string") return err(400, r);
    return ok({ ok: true, opId: b.opId, id: r.id, rev: r.rev });
  }

  private put(n: EventNote, patch: Partial<EventNote>): EventNote {
    const timed = ["start", "end", "rrule", "status", "overrides", "exdates"].some((k) => k in patch);
    const next = { ...n, ...patch, rev: n.rev + 1, sequence: (n.sequence ?? 0) + (timed ? 1 : 0) };
    this.notes.set(n.id, next);
    return next;
  }

  /** The note, or the whole series; a series moved from one of its instances moves by that instance's shift. */
  private whole(n: EventNote, patch: Partial<EventNote>, rid?: string): EventNote | string {
    if (!n.rrule || !rid || !("start" in patch)) return this.put(n, patch);
    const from = instantOf(rid, n), delta = instantOf(patch.start!, n) - from;
    const len = instantOf(patch.end!, n) - instantOf(patch.start!, n);
    const b = bounds(n);
    const s = n.all_day ? { start: shift(n.start, delta, true), end: shift(n.start, delta + len, true) } : { start: isoOf(b.start + delta), end: isoOf(b.start + delta + len) };
    return this.put(n, { ...s, overrides: (n.overrides ?? []).map((o) => ({ ...o, recurrence_id: shift(o.recurrence_id, delta, n.all_day) })), exdates: (n.exdates ?? []).map((x) => shift(x, delta, n.all_day)) });
  }

  /** One instance: an override inside the series note (a cancelled one too: the note is kept). */
  private one(n: EventNote, rid: string, patch: Partial<EventNote>): EventNote | string {
    const extra = Object.keys(patch).filter((k) => !PER_INSTANCE.includes(k));
    if (extra.length) return `${extra.join(", ")} can't change on one event of a series; change all of them`;
    if (!this.isInstance(n, rid)) return "that isn't an instance of this series";
    const had = (n.overrides ?? []).find((o) => sameInstant(o.recurrence_id, rid));
    const o: Override = { ...(had ?? {}), recurrence_id: rid, ...(patch as Override) };
    return this.put(n, { overrides: [...(n.overrides ?? []).filter((x) => !sameInstant(x.recurrence_id, rid)), o] });
  }

  /** This and following: the series ends before `rid`, and a new series carries on from it with the change. */
  private following(n: EventNote, rid: string, patch: Partial<EventNote>): EventNote | string {
    if (!this.isInstance(n, rid)) return "that isn't an instance of this series";
    const at = (x: string) => instantOf(x, n);
    const later = (x: string) => at(x) >= at(rid);
    const rule = parseRule(n.rrule!);
    const orig = at(rid);
    const before = occurrences(n, -8.64e15, orig).length;
    if (before === 0) return this.whole(n, patch, rid);
    const len = bounds(n).end - bounds(n).start;
    const startOf = patch.start ? patch.start : n.all_day ? rid : isoOf(orig);
    const endOf = patch.end ? patch.end : n.all_day ? dayKey(dayStart(addDays(rid, Math.round(len / 86_400_000)), n.tz), n.tz) : isoOf(orig + len);
    const rest = rule.count !== null ? withCount(n.rrule!, rule.count - before) : n.rrule!;
    this.put(n, { rrule: withUntil(n.rrule!, orig - 1000), overrides: (n.overrides ?? []).filter((o) => !later(o.recurrence_id)), exdates: (n.exdates ?? []).filter((x) => !later(x)) });
    const id = `ev-${String(++this.seq).padStart(4, "0")}`;
    // the later changes and skips go with the new series; their ids shift with it, and a change that kept its
    // original time moves with it too
    const delta = instantOf(startOf, n) - orig;
    const overrides = (n.overrides ?? []).filter((o) => later(o.recurrence_id)).map((o) => ({ ...o, recurrence_id: shift(o.recurrence_id, delta, n.all_day),
      ...(o.start && sameInstant(o.start, o.recurrence_id) ? { start: shift(o.start, delta, n.all_day), end: o.end && shift(o.end, delta, n.all_day) } : {}) }));
    const exdates = (n.exdates ?? []).filter(later).map((x) => shift(x, delta, n.all_day));
    const made: EventNote = { ...n, ...patch, id, rev: 1, sequence: 0, uid: `${id}@uni.example.com`, start: startOf, end: endOf, rrule: rest, overrides, exdates, source: "uni-app",
      path: `Calendar/${n.all_day ? startOf : dayKey(Date.parse(startOf), n.tz)} ${patch.title ?? n.title}` };
    this.notes.set(id, made);
    return made;
  }

  private isInstance(n: EventNote, rid: string): boolean {
    const t = instantOf(rid, n);
    return occurrences(n, t - 1, t + 1).some((s) => sameInstant(ridOf(n, s), rid));
  }
}

function check(f: Record<string, unknown>): string | null {
  const extra = Object.keys(f).filter((k) => !EDITABLE.includes(k));
  if (extra.length) return `these fields aren't the app's to set: ${extra.join(", ")}`;
  if (f.visibility !== undefined && !["private", "shared", "public"].includes(f.visibility as Visibility)) return "visibility is private, shared or public";
  if (f.start !== undefined && f.end !== undefined && !(String(f.start) < String(f.end))) return "it has to end after it starts";
  return null;
}

function instantOf(x: string, n: Pick<EventNote, "tz">): number {
  return x.length === 10 ? dayStart(x, n.tz) : Date.parse(x);
}

function shift(iso: string, ms: number, allDay: boolean): string {
  return allDay ? addDays(iso.slice(0, 10), Math.round(ms / 86_400_000)) : isoOf(Date.parse(iso) + ms);
}

function ics(n: EventNote): string {
  const t = (x: string) => (x.length === 10 ? `;VALUE=DATE:${x.replace(/-/g, "")}` : `:${x.replace(/[-:]/g, "")}`);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//uni//fake door//EN", "BEGIN:VEVENT", `UID:${n.uid}`, `SUMMARY:${n.title}`, `DTSTART${t(n.start)}`, `DTEND${t(n.end)}`,
    ...(n.rrule ? [`RRULE:${n.rrule}`] : []), `STATUS:${n.status.toUpperCase()}`, `SEQUENCE:${n.sequence ?? 0}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

const ok = (body: unknown): Answer => ({ status: 200, body });
const err = (status: number, error: string): Answer => ({ status, body: { error } });
