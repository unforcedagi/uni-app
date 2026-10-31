// T-335: what the line at the top of a room says about approvals waiting in other rooms, and which one it opens.
// Run: node --experimental-strip-types scripts/approvalsElsewhere.test.ts
import assert from "node:assert/strict";
import { elsewhereText, waitingElsewhere } from "../src/approvalsElsewhere.ts";
import type { Approval } from "../src/approvals.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const a = (ref: string, channel: string, deadline: number | null, ts = 100): Approval =>
  ({ ref, channel, author: "u", ts, root: null, command: "x", why: "", answers: [], deadline, kind: "sealed" });
const names: Record<string, string> = { "ch-kiln": "kiln", "ch-garden": "#garden-club", "ch-loom": "loom" };
const name = (id: string) => names[id] ?? null;

check("nothing waiting, or only here: no line", () => {
  assert.equal(waitingElsewhere([], "ch-kiln"), null);
  assert.equal(waitingElsewhere([a("1", "ch-kiln", 900)], "ch-kiln"), null);
});

check("one elsewhere: its room by name", () => {
  const e = waitingElsewhere([a("1", "ch-kiln", 900), a("2", "ch-garden", 900)], "ch-kiln")!;
  assert.equal(e.first.ref, "2");
  assert.equal(elsewhereText(e, name), "Approval waiting in #garden-club");
});

check("no room on screen: every approval counts", () => {
  const e = waitingElsewhere([a("1", "ch-kiln", 900)], null)!;
  assert.equal(elsewhereText(e, name), "Approval waiting in #kiln");
});

check("it opens the soonest to end; one with no end goes last; a tie goes to the oldest", () => {
  const e = waitingElsewhere([a("late", "ch-kiln", 2000), a("none", "ch-loom", null, 1), a("soon", "ch-garden", 1000, 50), a("soon-older", "ch-garden", 1000, 10)], "ch-x")!;
  assert.equal(e.first.ref, "soon-older");
  assert.deepEqual(e.rooms, ["ch-garden", "ch-kiln", "ch-loom"]);
  assert.equal(e.count, 4);
});

check("two in one room, two rooms, more rooms", () => {
  assert.equal(elsewhereText(waitingElsewhere([a("1", "ch-kiln", 9), a("2", "ch-kiln", 10)], null)!, name), "2 approvals waiting in #kiln");
  assert.equal(elsewhereText(waitingElsewhere([a("1", "ch-kiln", 9), a("2", "ch-loom", 10)], null)!, name), "2 approvals waiting in #kiln and #loom");
  assert.equal(elsewhereText(waitingElsewhere([a("1", "ch-kiln", 9), a("2", "ch-loom", 10), a("3", "ch-garden", 11)], null)!, name), "3 approvals waiting in #kiln and 2 more rooms");
});

check("a room the app doesn't know yet is \"another room\", never an id", () => {
  assert.equal(elsewhereText(waitingElsewhere([a("1", "ch-unknown", 9)], null)!, name), "Approval waiting in another room");
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
