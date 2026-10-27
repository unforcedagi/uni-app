// T-295 Claude accounts card: what it reads from the launcher's usage note and how it says it. The fixture is made up
// (scripts/fixtures/usage-note.json). Run: node --experimental-strip-types scripts/usage.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ageText, pace, parseDoc, resetText, usageView } from "../src/usage/usageCore.ts";

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

t("at or over the stop is full", () => {
  const v = usageView(md((d) => { d.accounts[0].session = { used: 95, resets_at: "2026-10-26T20:00:00+00:00" }; }), NOW, TZ)!;
  assert.equal(v.rows[0].session.full, true);
  assert.equal(v.rows[1].session.full, false);
});

t("the preference: the note's value when it is auto or an account; the next account only while it was decided with it", () => {
  const b = usageView(md(() => {}, "b"), NOW, TZ)!;
  assert.equal(b.preference, "b");
  assert.equal(b.next, null);                       // the note's next was decided with auto
  const synced = usageView(md((d) => { d.preference = "b"; d.next = { account: "b", how: "preference" }; }, "b"), NOW, TZ)!;
  assert.deepEqual(synced.next, { label: "Account B", how: "preference" });
  assert.equal(usageView(md(() => {}, "z"), NOW, TZ)!.preference, "auto");
});

t("an old reading says how old", () => {
  const v = usageView(md((d) => { d.read_at = "2026-10-26T16:00:00+00:00"; }), NOW, TZ)!;
  assert.equal(v.stale, true);
  assert.equal(ageText(v.readAt, NOW), "2 h ago");
  assert.equal(ageText("2026-10-26T17:48:00Z", NOW), "12 min ago");
});

t("T-319: a reading is current up to an hour old, and stale after", () => {
  assert.equal(usageView(md((d) => { d.read_at = "2026-10-26T17:01:00+00:00"; }), NOW, TZ)!.stale, false);
  assert.equal(usageView(md((d) => { d.read_at = "2026-10-26T16:59:00+00:00"; }), NOW, TZ)!.stale, true);
  assert.equal(usageView(md((d) => { d.read_at = null; }), NOW, TZ)!.stale, true, "no reading time: never current");
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
