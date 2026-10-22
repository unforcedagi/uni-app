import assert from "node:assert/strict";
import { elapsed, workingOn } from "../src/working.ts";
let failed = 0;
const check = (n: string, f: () => void) => { try { f(); console.log("ok  ", n); } catch (e) { failed++; console.log("FAIL", n, e); } };
const ME = "a".repeat(64), UNI = "b".repeat(64), SAM = "c".repeat(64);
const NOW = 1_800_000_000;
const eyes = (...by: string[]) => [{ emoji: "👀", count: by.length, mine: by.includes(ME) ? "r-me" : null, by }];
const m = (ref: string, author: string, ago: number, body = "words", extra: Record<string, unknown> = {}) =>
  ({ ref, author, ts: NOW - ago, body, edited: false, reply_count: 0, reactions: [] as any[], ...extra });

check("👀 from Uni on your newest message: Uni is working since it", () =>
  assert.deepEqual(workingOn([m("1", UNI, 600), m("2", ME, 42, "ask", { reactions: eyes(UNI) })], ME, NOW), { author: UNI, since: NOW - 42 }));
check("no 👀: nothing", () => assert.equal(workingOn([m("1", UNI, 600), m("2", ME, 42)], ME, NOW), null));
check("Uni's reply after it ends the work", () =>
  assert.equal(workingOn([m("2", ME, 42, "ask", { reactions: eyes(UNI) }), m("3", UNI, 5, "done")], ME, NOW), null));
check("a progress ping does not end it", () =>
  assert.deepEqual(workingOn([m("2", ME, 400, "ask", { reactions: eyes(UNI) }), m("3", UNI, 220, "⏳ Working — 3 min — iteration 4/90, terminal")], ME, NOW), { author: UNI, since: NOW - 400 }));
check("your own 👀 is not work", () => assert.equal(workingOn([m("2", ME, 42, "ask", { reactions: eyes(ME) })], ME, NOW), null));
check("an older message of yours with 👀, a newer one without: still working since the older", () =>
  assert.deepEqual(workingOn([m("2", ME, 90, "ask", { reactions: eyes(UNI) }), m("3", ME, 30, "and also")], ME, NOW), { author: UNI, since: NOW - 90 }));
check("a 👀 older than someone else's message is over", () =>
  assert.equal(workingOn([m("2", ME, 90, "ask", { reactions: eyes(UNI) }), m("3", SAM, 60, "hi"), m("4", ME, 30)], ME, NOW), null));
check("answered in its thread: over", () =>
  assert.equal(workingOn([m("2", ME, 90, "ask", { reactions: eyes(UNI), reply_count: 1 })], ME, NOW), null));
check("past an hour with no live ping: let go", () =>
  assert.equal(workingOn([m("2", ME, 3700, "ask", { reactions: eyes(UNI) })], ME, NOW), null));
check("past an hour with Uni's ping still being edited: still working", () =>
  assert.deepEqual(workingOn([m("2", ME, 3700, "ask", { reactions: eyes(UNI) }), m("3", UNI, 3600 - 180, "⏳ Working — 61 min", { edited: true })], ME, NOW), { author: UNI, since: NOW - 3700 }));
check("another worker's live ping does not hold Uni's stale 👀", () =>
  assert.equal(workingOn([m("2", ME, 3700, "ask", { reactions: eyes(UNI) }), m("3", SAM, 3600 - 180, "⏳ Working — 61 min", { edited: true })], ME, NOW), null));
check("the 👀 with a variation selector counts; a reaction list without `by` (an older build) does not", () => {
  assert.deepEqual(workingOn([m("2", ME, 5, "ask", { reactions: [{ emoji: "👀️", count: 1, mine: null, by: [UNI] }] })], ME, NOW), { author: UNI, since: NOW - 5 });
  assert.equal(workingOn([m("2", ME, 5, "ask", { reactions: [{ emoji: "👀", count: 1, mine: null }] })], ME, NOW), null);
});
check("no identity yet: nothing", () => assert.equal(workingOn([m("2", ME, 5, "ask", { reactions: eyes(UNI) })], null, NOW), null));
check("elapsed", () => {
  assert.equal(elapsed(0), "0:00"); assert.equal(elapsed(42.9), "0:42"); assert.equal(elapsed(725), "12:05"); assert.equal(elapsed(3729), "1:02:09"); assert.equal(elapsed(-3), "0:00");
});
if (failed) process.exit(1);
