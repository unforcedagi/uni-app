// T-229 Calendar: the view's decisions that a screen hides when they're wrong. The window asked for across the clock
// change, the offline snapshot (what it covers, newest wins, capped), which ops a key's session shows, when "Send
// invites" is offered, and reading typed attendees. Run: node --experimental-strip-types scripts/calendar.test.ts
import assert from "node:assert/strict";
import { layoutDay, type DoorInstance } from "../src/calendar/calCore.ts";
import { can, daysFor, FALLBACK_SESSION, fromSnapshot, invitesWaiting, MAX_WINDOWS, parseAttendees, parseSnapshot, remember, toShown, windowFor, type Session } from "../src/calendar/calView.ts";

const TZ = "America/Denver";
let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log(`ok ${name}`); };

const inst = (id: string, start: string, end: string, over: Partial<DoorInstance> = {}): DoorInstance => ({
  id, uid: `${id}@example.com`, recurrence_id: null, start, end, all_day: start.length === 10, tz: TZ, title: id, status: "confirmed", show_as: "busy",
  visibility: "private", series: false, rev: 1, ...over,
});

t("the week across the clock change asks the door from local midnight to local midnight", () => {
  const days = daysFor("week", "2026-10-29", false);
  assert.deepEqual([days[0], days[6]], ["2026-10-26", "2026-11-01"]);
  // Mon Oct 26 00:00 MDT (UTC-6) to Mon Nov 2 00:00 MST (UTC-7): 7 days and an hour
  assert.deepEqual(windowFor(days, TZ), { from: "2026-10-26T06:00:00Z", to: "2026-11-02T07:00:00Z" });
  assert.deepEqual(daysFor("week", "2026-10-29", true), ["2026-10-29", "2026-10-30", "2026-10-31"]);
  assert.equal(daysFor("agenda", "2026-10-21", false).length, 21);
});

t("an all-day instance spans its local days; a timed one its instants", () => {
  const [a, b] = toShown([inst("b", "2026-10-22T18:00:00Z", "2026-10-22T19:00:00Z"), inst("a", "2026-10-23", "2026-10-26")]);
  assert.equal(b.key, "a");
  assert.equal(new Date(b.s).toISOString(), "2026-10-23T06:00:00.000Z");
  assert.equal((b.e - b.s) / 3_600_000, 72);
  assert.equal(a.key, "b");
  assert.equal(toShown([inst("s", "2026-10-20T15:00:00Z", "2026-10-20T17:00:00Z", { recurrence_id: "2026-10-20T15:00:00Z", series: true })])[0].key, "s@2026-10-20T15:00:00Z");
});

t("overlapping events sit side by side; a later one gets the full width", () => {
  const placed = layoutDay([{ start: 0, end: 60, k: "a" }, { start: 30, end: 60, k: "b" }, { start: 90, end: 120, k: "c" }]);
  assert.deepEqual(Object.fromEntries(placed.map((p) => [p.inst.k, [p.col, p.cols]])), { a: [0, 2], b: [1, 2], c: [0, 1] });
});

t("the snapshot: a read replaces the windows it covers, the newest read wins, at most MAX_WINDOWS", () => {
  const week = { from: "2026-10-19T06:00:00Z", to: "2026-10-26T06:00:00Z" };
  let s = remember(null, { ...week, instances: [inst("lunch", "2026-10-22T18:00:00Z", "2026-10-22T19:00:00Z")] }, "2026-10-21T16:00:00Z", null);
  s = remember(s, { from: "2026-10-22T06:00:00Z", to: "2026-10-23T06:00:00Z", instances: [inst("lunch", "2026-10-22T19:00:00Z", "2026-10-22T20:00:00Z", { rev: 2 })] }, "2026-10-21T17:00:00Z", null);
  // the day read later is newer: its lunch, moved, is the one shown for the week
  const got = fromSnapshot(s, week.from, week.to)!;
  assert.equal(got.complete, true);
  assert.deepEqual(got.instances.map((i) => [i.id, i.start, i.rev]), [["lunch", "2026-10-22T19:00:00Z", 2]]);
  // a read of the whole week replaces the day inside it
  s = remember(s, { ...week, instances: [] }, "2026-10-21T18:00:00Z", null);
  assert.equal(s.windows.length, 1);
  for (let i = 0; i < 12; i++) s = remember(s, { from: `2027-01-${String(i + 1).padStart(2, "0")}T07:00:00Z`, to: `2027-01-${String(i + 2).padStart(2, "0")}T07:00:00Z`, instances: [] }, "x", null);
  assert.equal(s.windows.length, MAX_WINDOWS);
});

t("the snapshot says when it covers only part of the days asked, and nothing for days never read", () => {
  const s = remember(null, { from: "2026-10-19T06:00:00Z", to: "2026-10-22T06:00:00Z", instances: [inst("x", "2026-10-20T18:00:00Z", "2026-10-20T19:00:00Z")] }, "t", null);
  assert.equal(fromSnapshot(s, "2026-10-19T06:00:00Z", "2026-10-26T06:00:00Z")!.complete, false);
  assert.equal(fromSnapshot(s, "2026-11-02T07:00:00Z", "2026-11-09T07:00:00Z"), null);
  // an instance outside the asked days isn't shown, though its window touches them
  assert.deepEqual(fromSnapshot(s, "2026-10-21T06:00:00Z", "2026-10-22T06:00:00Z")!.instances, []);
  assert.equal(parseSnapshot("{not json"), null);
  assert.equal(parseSnapshot(JSON.stringify({ v: 2, windows: [] })), null);
});

t("a key sees only the ops its session lists; a door without one gets what every key may do", () => {
  const uni: Session = { role: "uni", ops: ["create", "update", "move", "cancel", "rsvp"] };
  assert.equal(can(uni, "move"), true);
  assert.equal(can(uni, "delete"), false);
  assert.equal(can(uni, "send_invites"), false);
  assert.equal(can(FALLBACK_SESSION, "delete"), false);
  assert.equal(can(FALLBACK_SESSION, "send_invites"), false);
  assert.equal(can(null, "create"), false);
});

t("Send invites is offered for invites the door marks waiting, to people other than the organizer, for a key that may send", () => {
  const owner: Session = { role: "owner", ops: ["send_invites"] };
  const org = { address: "mailto:robin@example.com", name: "Robin Vale" };
  const juno = { address: "mailto:juno@example.com", name: "Juno Park" };
  assert.equal(invitesWaiting({ organizer: org, attendees: [juno], status: "tentative", invite_pending: true }, owner), true);
  assert.equal(invitesWaiting({ organizer: org, attendees: [juno], status: "tentative", invite_pending: false }, owner), false);
  assert.equal(invitesWaiting({ organizer: org, attendees: [juno], status: "tentative", invite_pending: true }, { role: "uni", ops: ["create"] }), false);
  // only the organizer on it: no one to invite
  assert.equal(invitesWaiting({ organizer: org, attendees: [{ address: "MAILTO:Robin@example.com" }], status: "tentative", invite_pending: true }, owner), false);
  // a door that doesn't carry the mark: a tentative event with people to invite
  assert.equal(invitesWaiting({ organizer: org, attendees: [juno], status: "tentative" }, owner), true);
  assert.equal(invitesWaiting({ organizer: org, attendees: [juno], status: "confirmed" }, owner), false);
});

t("typed attendees: addresses only, the known ones keep their names and answers", () => {
  const known = [{ address: "mailto:juno@example.com", name: "Juno Park", partstat: "ACCEPTED" }];
  assert.deepEqual(parseAttendees("Juno@Example.com, kai@example.com kai@example.com", known), [known[0], { address: "mailto:kai@example.com", partstat: "NEEDS-ACTION" }]);
  assert.deepEqual(parseAttendees("juno@example.com, not an address"), { bad: "not" });
  assert.deepEqual(parseAttendees("  "), []);
});

console.log(`${n} passed`);
