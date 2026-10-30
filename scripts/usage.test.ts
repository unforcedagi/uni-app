// T-295 Claude accounts card: what it reads from the launcher's usage note and how it says it. The fixture is made up
// (scripts/fixtures/usage-note.json). Run: node --experimental-strip-types scripts/usage.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ageText, pace, parseDoc, resetText, usageLineText, usageView } from "../src/usage/usageCore.ts";

const NOTE = JSON.parse(readFileSync(new URL("./fixtures/usage-note.json", import.meta.url), "utf8"));
const TZ = "America/Denver";
const NOW = new Date("2026-10-26T18:00:00Z"); // Mon noon in Denver
let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log(`ok ${name}`); };
const md = (over: (d: any) => void, pref?: string) => {
  const m = structuredClone(NOTE.metadata);
  over(m.claude_accounts);
  if (pref !== undefined) m.account_preference = pref;
  return m;
};

t("each account's session and week, with reset times in the device's zone and the week's pace", () => {
  const v = usageView(NOTE.metadata, NOW, TZ)!;
  const [a, b] = v.rows;
  assert.equal(a.label, "Account A");
  assert.deepEqual([a.session.text, a.session.reset, a.week.text, a.week.reset, a.week.pace], ["0%", null, "8%", "Fri 7am", "on pace"]);
  assert.deepEqual([b.session.text, b.session.reset, b.week.text, b.week.reset, b.week.pace], ["62%", "3:20pm", "71%", "Sat 8am", "ahead of pace"]);
  assert.deepEqual(v.choices, ["auto", "a", "b"]);
  assert.deepEqual(v.next, { label: "Account A", how: "auto" });
  assert.equal(v.stale, false);
});

t("the same instant reads in the zone it is shown in", () => {
  assert.equal(resetText("2026-10-30T13:00:00+00:00", NOW, "Europe/Berlin"), "Fri 2pm");
  assert.equal(resetText("2026-10-27T13:00:00+00:00", NOW, TZ), "tomorrow 7am");
  assert.equal(resetText("not a time", NOW, TZ), null);
  assert.equal(resetText("2026-10-30T12:59:59.653710+00:00", NOW, TZ), "Fri 7am"); // to the nearest minute
});

t("pace is even use over the 168 h week, ahead only past it by more than 5 points", () => {
  // 84 h left: even use is 50% now
  const reset = new Date(NOW.getTime() + 84 * 3600_000).toISOString();
  assert.equal(pace(55, reset, NOW), "on pace");
  assert.equal(pace(55.5, reset, NOW), "ahead of pace");
  assert.equal(pace(null, reset, NOW), null);
});

t("a window whose reset has passed is empty until the next reading", () => {
  const v = usageView(md((d) => { d.accounts[1].session.resets_at = "2026-10-26T17:50:00+00:00"; }), NOW, TZ)!;
  assert.deepEqual([v.rows[1].session.text, v.rows[1].session.reset], ["0%", null]);
});

// T-335: at the pacing stop (95) the launcher pauses an account and keeps the rest as headroom for rooms; only a real 100 is full
const atWeek = (used: number, stop: number | null = 95) => usageView(md((d) => { d.stop = stop; d.accounts[0].week.used = used; }), NOW, TZ)!;
t("T-335: under the stop is neither; at or over it but under 100 is paused, not full; 100 is full", () => {
  const cases: [number, string, boolean, boolean, string][] = [
    [94, "94%", false, false, "A 94% of the week"],
    [95, "95%", true, false, "A paused at 95%"],
    [99, "99%", true, false, "A paused at 99%"],
    [99.6, "99%", true, false, "A paused at 99%"],   // never "100%" while it isn't
    [100, "100%", false, true, "A full"],
  ];
  for (const [used, text, paused, full, front] of cases) {
    const v = atWeek(used), w = v.rows[0].week;
    assert.deepEqual([w.text, w.paused, w.full], [text, paused, full], `week at ${used}`);
    assert.equal(usageLineText(v, NOW)!.split(" · ")[0], `Claude: ${front}`, `front door at ${used}`);
  }
  assert.equal(atWeek(95).rows[0].week.headroom, "keeping 5% headroom for rooms");
  assert.equal(atWeek(94).rows[0].week.headroom, null);
  assert.equal(atWeek(90, 90).rows[0].week.headroom, "keeping 10% headroom for rooms");
  assert.deepEqual([atWeek(99, null).rows[0].week.paused, atWeek(99, null).rows[0].week.full], [false, false], "no stop: nothing pauses before 100");
  // Codex r1: a stop outside (0, 100] is not one: nothing pauses, and no headroom over 100 or under 0 is claimed
  for (const odd of [-1, 0, 101]) {
    assert.deepEqual([atWeek(5, odd).rows[0].week.paused, atWeek(99, odd).rows[0].week.paused, atWeek(100, odd).rows[0].week.full], [false, false, true], `stop ${odd}`);
  }
  assert.equal(parseDoc(md((d) => { d.stop = 150; }))!.stop, null);
});

t("T-335: the session pauses and fills the same way, and a full meter outranks a paused one on the front door", () => {
  const v = usageView(md((d) => { d.accounts[0].session = { used: 96, resets_at: "2026-10-26T20:00:00+00:00" }; }), NOW, TZ)!;
  assert.deepEqual([v.rows[0].session.paused, v.rows[0].session.full, v.rows[1].session.paused], [true, false, false]);
  assert.equal(usageLineText(v, NOW)!.split(" · ")[0], "Claude: A paused at 96%");
  const both = usageView(md((d) => { d.accounts[0].session = { used: 100, resets_at: "2026-10-26T20:00:00+00:00" }; d.accounts[0].week.used = 97; }), NOW, TZ)!;
  assert.equal(usageLineText(both, NOW)!.split(" · ")[0], "Claude: A full");
  const two = usageView(md((d) => { d.accounts[0].session = { used: 96, resets_at: "2026-10-26T20:00:00+00:00" }; d.accounts[0].week.used = 98; }), NOW, TZ)!;
  assert.equal(usageLineText(two, NOW)!.split(" · ")[0], "Claude: A paused at 98%", "the higher of the two");
});

// T-335: Claude Ultra has no 5-hour limit; the launcher says so per account (stop.session_limit false) and the session is info only
t("T-335: a session the launcher doesn't count is never paused or full, on the card or the front door; the week still is", () => {
  const off = (used: number, week = 40) => usageView(md((d) => {
    d.accounts[0].session = { used, resets_at: "2026-10-26T20:00:00+00:00" }; d.accounts[0].week.used = week;
    d.accounts[0].stop = { session: null, week: 95, why: null, session_limit: false };
  }), NOW, TZ)!;
  for (const used of [96, 99, 100]) {
    const v = off(used), s = v.rows[0].session;
    assert.deepEqual([s.pct, s.paused, s.full, s.headroom, s.info], [used, false, false, null, true], `session at ${used}`);
    assert.equal(usageLineText(v, NOW)!.split(" · ")[0], "Claude: A 40% of the week", `front door at ${used}`);
  }
  assert.equal(off(99, 100).rows[0].week.full, true);
  assert.equal(usageLineText(off(99, 100), NOW)!.split(" · ")[0], "Claude: A full");
  assert.equal(usageLineText(off(99, 96), NOW)!.split(" · ")[0], "Claude: A paused at 96%");
  // an older note (no session_limit) or the switch on: the session pauses as before
  const on = usageView(md((d) => { d.accounts[0].session = { used: 96, resets_at: "2026-10-26T20:00:00+00:00" };
    d.accounts[0].stop = { session: 95, week: 95, why: null, session_limit: true }; }), NOW, TZ)!;
  assert.deepEqual([on.rows[0].session.paused, on.rows[0].session.info], [true, false]);
});

// T-335: in a week's last hours the launcher spends it to 100 (98 for the chat account); the note says so per account
const WHY = "spending to 100% before Fri 07:00 reset";
const lifted = (used: number, stop: unknown) => usageView(md((d) => { d.accounts[0].week.used = used; d.accounts[0].stop = stop; }), NOW, TZ)!;
t("T-335: an account the launcher spends to 100 is not paused at 96, and says why", () => {
  const v = lifted(96, { session: 95, week: 100, why: WHY }), w = v.rows[0].week;
  assert.deepEqual([w.text, w.paused, w.full, w.headroom, w.spending, w.why], ["96%", false, false, null, 100, WHY]);
  assert.equal(usageLineText(v, NOW)!.split(" · ")[0], "Claude: A 96% of the week");
  assert.deepEqual([lifted(99.6, { session: 95, week: 100, why: WHY }).rows[0].week.paused, lifted(100, { session: 95, week: 100, why: WHY }).rows[0].week.full], [false, true]);
  // the other account keeps the flat stop it was given
  assert.deepEqual([v.rows[1].week.spending, v.rows[1].week.why], [null, null]);
});

t("T-335: the chat account stops at 98 even then, with 2% headroom", () => {
  const why = "spending to 98% before Fri 07:00 reset (the chat account keeps 2%)";
  const at = (used: number) => lifted(used, { session: 95, week: 98, why }).rows[0].week;
  assert.deepEqual([at(97).paused, at(98).paused, at(98).headroom, at(98).spending], [false, true, "keeping 2% headroom for rooms", 98]);
});

t("T-335: the session keeps its own stop; an old note, or a bad stop, behaves as before", () => {
  const v = usageView(md((d) => { d.accounts[0].session = { used: 96, resets_at: "2026-10-26T20:00:00+00:00" }; d.accounts[0].week.used = 96;
    d.accounts[0].stop = { session: 95, week: 100, why: WHY }; }), NOW, TZ)!;
  assert.deepEqual([v.rows[0].session.paused, v.rows[0].week.paused], [true, false]);
  assert.equal(usageLineText(v, NOW)!.split(" · ")[0], "Claude: A paused at 96%");
  // no stop on the account (an older mts): the note's flat stop, as today
  assert.deepEqual([lifted(96, undefined).rows[0].week.paused, lifted(96, undefined).rows[0].week.spending], [true, null]);
  // junk falls back to the note's stop; an explicit null is the launcher's "no stop"
  for (const junk of ["x", 7, { week: "100" }, { week: 150 }, { week: -1 }]) assert.equal(lifted(96, junk).rows[0].week.paused, true, JSON.stringify(junk));
  assert.deepEqual([lifted(99, { session: null, week: null, why: null }).rows[0].week.paused], [false]);
  // a why without a lift is not shown as spending
  assert.deepEqual([lifted(50, { session: 95, week: 95, why: WHY }).rows[0].week.spending], [null]);
});

t("the preference: the note's value when it is auto or an account; the next account only while it was decided with it", () => {
  const b = usageView(md(() => {}, "b"), NOW, TZ)!;
  assert.equal(b.preference, "b");
  assert.equal(b.next, null);                       // the note's next was decided with auto
  const synced = usageView(md((d) => { d.preference = "b"; d.next = { account: "b", how: "preference" }; }, "b"), NOW, TZ)!;
  assert.deepEqual(synced.next, { label: "Account B", how: "preference" });
  assert.equal(usageView(md(() => {}, "z"), NOW, TZ)!.preference, "auto");
});

const readAll = (d: any, at: string) => { d.read_at = at; for (const a of d.accounts) a.read_at = at; };
t("an old reading says how old", () => {
  const v = usageView(md((d) => readAll(d, "2026-10-26T16:00:00+00:00")), NOW, TZ)!;
  assert.equal(v.stale, true);
  assert.equal(ageText(v.readAt, NOW), "2 h ago");
  assert.equal(ageText("2026-10-26T17:48:00Z", NOW), "12 min ago");
});

t("T-319: a reading is current up to an hour old, and stale after", () => {
  assert.equal(usageView(md((d) => readAll(d, "2026-10-26T17:01:00+00:00")), NOW, TZ)!.stale, false);
  assert.equal(usageView(md((d) => readAll(d, "2026-10-26T16:59:00+00:00")), NOW, TZ)!.stale, true);
  assert.equal(usageView(md((d) => { for (const a of d.accounts) a.read_at = null; }), NOW, TZ)!.stale, true, "no reading time: never current");
});

t("Codex zwmejvyc P2: one fresh account doesn't make another's 48-hour-old reading current", () => {
  // as mts writes it: the note's read_at is the newest account's
  const v = usageView(md((d) => { d.read_at = "2026-10-26T17:50:00+00:00"; d.accounts[0].read_at = "2026-10-24T18:00:00+00:00"; d.accounts[0].week.used = 88;
    d.accounts[1].read_at = "2026-10-26T17:50:00+00:00"; }), NOW, TZ)!;
  assert.deepEqual(v.rows.map((r) => [r.name, r.stale]), [["a", true], ["b", false]]);
  assert.equal(v.stale, false);
  assert.equal(v.someStale, true);
  const line = usageLineText(v, NOW)!;
  assert.ok(!line.includes("88%"), "A's old 88% is not shown as current");
  assert.equal(line, "Claude: A no fresh reading (2 days old) · B 71% of the week · new work to A · as of 10 min ago");
  // as of: the oldest of the numbers shown, never only the newest
  const both = usageView(md((d) => { d.accounts[0].read_at = "2026-10-26T17:20:00+00:00"; d.accounts[1].read_at = "2026-10-26T17:50:00+00:00"; }), NOW, TZ)!;
  assert.equal(ageText(both.readAt, NOW), "40 min ago");
});

t("a signed-out account is neither fresh nor stale: it says so, and the others decide", () => {
  const v = usageView(md((d) => { d.accounts[1].signed_in = false; d.accounts[1].read_at = "2026-10-21T18:00:00+00:00"; }), NOW, TZ)!;
  assert.deepEqual(v.rows.map((r) => [r.name, r.stale, r.out]), [["a", false, false], ["b", false, true]]);
  assert.equal(v.stale, false);
  assert.equal(v.someStale, false);
  assert.equal(usageLineText(v, NOW), "Claude: A 8% of the week · B signed out · new work to A · as of 15 min ago");
});

t("not a usage note, or bad account names: nothing, or only the good ones", () => {
  assert.equal(usageView({}, NOW, TZ), null);
  assert.equal(usageView({ claude_accounts: { accounts: [] } }, NOW, TZ), null);
  const d = parseDoc(md((x) => { x.accounts.push({ name: "../c" }, { name: "C" }); }))!;
  assert.deepEqual(d.accounts.map((a) => a.name), ["a", "b"]);
});

t("a signed-out account is shown but can't be chosen", () => {
  const v = usageView(md((d) => { d.accounts[1].signed_in = false; }), NOW, TZ)!;
  assert.deepEqual(v.choices, ["auto", "a"]);
  assert.equal(v.rows.length, 2);
});

console.log(`${n} usage tests passed`);
