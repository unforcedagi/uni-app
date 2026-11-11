import assert from "node:assert/strict";
import { splitMarkers, isWorkerStatus, isMaintenance, staleStatus } from "../src/chatMarkers.ts";
let failed = 0;
const check = (n: string, f: () => void) => { try { f(); console.log("ok  ", n); } catch (e) { failed++; console.log("FAIL", n, e); } };
// moved from the retired simpleR17/R18 tests (T-335): the room still mutes maintenance notes and dims past progress pings
check("maintenance notes are one muted line; a mention of a review is not one", () => {
  assert.equal(isMaintenance("Self-improvement review: Skill 'client-site-copy' patched."), true);
  assert.equal(isMaintenance("💾 Self-improvement review — memory updated"), true);
  assert.equal(isMaintenance("Let's do a self-improvement review of the site tomorrow"), false);
});
check("a progress ping older than an hour is a past update; an edited one that is still the newest message may be live", () => {
  const now = Date.parse("2026-10-14T12:00:00Z") / 1000;
  const monday = { ts: Date.parse("2026-10-12T12:29:00Z") / 1000, edited: false };
  assert.equal(staleStatus(monday, now, false), true);
  assert.equal(staleStatus(monday, now, true), true, "the newest, never edited: still stale");
  assert.equal(staleStatus({ ...monday, edited: true }, now, true), false, "edited in place and nothing after it: may be live");
  assert.equal(staleStatus({ ...monday, edited: true }, now, false), true, "something came after it");
  assert.equal(staleStatus({ ts: now - 600, edited: false }, now, false), false, "ten minutes old");
});
check("none: text unchanged", () => assert.deepEqual(splitMarkers("Hello [there]\nworld"), { text: "Hello [there]\nworld", markers: [] }));
check("trailing line", () => assert.deepEqual(splitMarkers("Shipped it.\n\n[done T-124]"), { text: "Shipped it.", markers: [{ state: "done", task: "T-124" }] }));
check("trailing on the same line", () => assert.deepEqual(splitMarkers("Shipped it. [decision T-9]  "), { text: "Shipped it.", markers: [{ state: "decision", task: "T-9" }] }));
check("leading", () => assert.deepEqual(splitMarkers("[blocked T-3] Waiting on keys."), { text: "Waiting on keys.", markers: [{ state: "blocked", task: "T-3" }] }));
check("several, in order", () => assert.deepEqual(splitMarkers("Two things.\n[done T-1] [active T-2]"), { text: "Two things.", markers: [{ state: "done", task: "T-1" }, { state: "active", task: "T-2" }] }));
check("a marker in the middle stays", () => assert.deepEqual(splitMarkers("See [done T-5] above and more"), { text: "See [done T-5] above and more", markers: [] }));
check("only a marker", () => assert.deepEqual(splitMarkers("[done T-7]"), { text: "", markers: [{ state: "done", task: "T-7" }] }));
check("a marker-only line in the middle becomes a chip", () => assert.deepEqual(splitMarkers("First part.\n[done T-123]\nSecond part."), { text: "First part.\nSecond part.", markers: [{ state: "done", task: "T-123" }] }));
check("several on a middle line", () => assert.deepEqual(splitMarkers("A\n\n[done T-1] [blocked T-2]\n\nB"), { text: "A\n\nB", markers: [{ state: "done", task: "T-1" }, { state: "blocked", task: "T-2" }] }));
check("a mid-line bracket in a longer line stays", () => assert.deepEqual(splitMarkers("A\nsee [done T-5] here\nB"), { text: "A\nsee [done T-5] here\nB", markers: [] }));
check("worker status matcher", () => {
  assert.equal(isWorkerStatus("⏳ Working — 6 min — iteration 7"), true);
  assert.equal(isWorkerStatus("⏳ Working - 1 min - reading files (edited)"), true);
  assert.equal(isWorkerStatus("⏳ working — 12 min"), true);
  assert.equal(isWorkerStatus("Working — 6 min"), false);
  assert.equal(isWorkerStatus("I was ⏳ Working — 6 min — here"), false);
  assert.equal(isWorkerStatus("⏳ Working on it\nand more"), false);
});
if (failed) process.exit(1);

check("r14: a one-word qualifier is part of the marker", () => assert.deepEqual(splitMarkers("[done T-02 step] P1–P3 now run."), { text: "P1–P3 now run.", markers: [{ state: "done", task: "T-02" }] }));
