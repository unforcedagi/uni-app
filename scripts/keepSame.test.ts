// T-335: a re-read keeps what didn't change as the objects already drawn. Run: node --experimental-strip-types scripts/keepSame.test.ts
import assert from "node:assert/strict";
import { keepSame } from "../src/keepSame.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const m = (ref: string, body: string, extra: Record<string, unknown> = {}) => ({ ref, body, mentions: [] as string[], reactions: [] as { emoji: string }[], ...extra });
const byRef = (r: { ref: string }) => r.ref;

check("a re-read with nothing changed is the list already drawn", () => {
  const prev = [m("a", "one"), m("b", "two")];
  assert.equal(keepSame(prev, [m("a", "one"), m("b", "two")], byRef), prev);
});
check("an edited row is the new object; the others are the ones already drawn", () => {
  const prev = [m("a", "one"), m("b", "two"), m("c", "three")];
  const out = keepSame(prev, [m("a", "one"), m("b", "two, edited"), m("c", "three")], byRef);
  assert.notEqual(out, prev);
  assert.equal(out[0], prev[0]); assert.equal(out[2], prev[2]);
  assert.equal(out[1].body, "two, edited"); assert.notEqual(out[1], prev[1]);
});
check("a change deep in a row (a new reaction) counts as a change", () => {
  const prev = [m("a", "one")];
  const out = keepSame(prev, [m("a", "one", { reactions: [{ emoji: "👍" }] })], byRef);
  assert.notEqual(out[0], prev[0]);
  assert.deepEqual(out[0].reactions, [{ emoji: "👍" }]);
});
check("a new message at the end: the old rows kept, the list is new", () => {
  const prev = [m("a", "one"), m("b", "two")];
  const out = keepSame(prev, [m("a", "one"), m("b", "two"), m("c", "three")], byRef);
  assert.notEqual(out, prev);
  assert.equal(out.length, 3); assert.equal(out[0], prev[0]); assert.equal(out[1], prev[1]);
});
check("a window that moved (oldest dropped) is a new list in the new order", () => {
  const prev = [m("a", "one"), m("b", "two"), m("c", "three")];
  const out = keepSame(prev, [m("b", "two"), m("c", "three"), m("d", "four")], byRef);
  assert.deepEqual(out.map(byRef), ["b", "c", "d"]);
  assert.equal(out[0], prev[1]);
});
check("the same rows in another order are a new list (order is what is drawn)", () => {
  const prev = [m("a", "one"), m("b", "two")];
  const out = keepSame(prev, [m("b", "two"), m("a", "one")], byRef);
  assert.notEqual(out, prev);
  assert.deepEqual(out.map(byRef), ["b", "a"]);
});
check("a row removed is a new list", () => {
  const prev = [m("a", "one"), m("b", "two")];
  assert.deepEqual(keepSame(prev, [m("a", "one")], byRef).map(byRef), ["a"]);
});
check("nothing before: the fresh rows as they are", () => {
  const next = [m("a", "one")];
  assert.equal(keepSame([], next, byRef)[0], next[0]);
});
check("an empty re-read of a room that had rows is the empty list", () => {
  assert.deepEqual(keepSame([m("a", "one")], [], byRef), []);
});
if (failed) { console.log(`${failed} failed`); process.exit(1); }
