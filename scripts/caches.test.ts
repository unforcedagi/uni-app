// A linked note's title cache (src/areas/noteRefsCore.ts) and the chat cache (src/chatCache.ts). Moved from the retired navtree test
// (T-335). Run: node --experimental-strip-types scripts/caches.test.ts
import assert from "node:assert/strict";
import { capped, RECHECK_MS, refKey, RETRY_MS, settle, shouldRead, titleOfPath } from "../src/areas/noteRefsCore.ts";
import { readMessages, readRooms, readWho, writeMessages, writeRooms, writeWho } from "../src/chatCache.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

check("r15 note refs: one key per note per vault; the title cache re-reads and stays capped", () => {
  const id = "01M3ZK2R6A6C62M1ANJCSQNG3M";
  assert.equal(refKey({ vault: "life", id }), `life:${id}`);
  assert.notEqual(refKey({ vault: "life", id }), refKey({ vault: "uni", id }));
  const now = 1_000_000_000;
  assert.equal(shouldRead(undefined, now, false), true, "never read");
  assert.equal(shouldRead({ title: null, at: null, read: now - 5_000 }, now, true), false, "a failure waits a little");
  assert.equal(shouldRead({ title: null, at: null, read: now - RETRY_MS }, now, true), true, "then it is tried again, never remembered for the session");
  assert.equal(shouldRead({ title: "Old", at: "a", read: now - 1_000 }, now, false), true, "a title kept from the last launch is checked once");
  assert.equal(shouldRead({ title: "Old", at: "a", read: now - 1_000 }, now, true), false);
  assert.equal(shouldRead({ title: "Old", at: "a", read: now - RECHECK_MS }, now, true), true, "and again once it is old");
  // a rename: a new revision brings the new title; a failed re-read keeps the known one
  assert.deepEqual(settle({ title: "Old", at: "a", read: 0 }, { title: "New", at: "b" }, now), { title: "New", at: "b", read: now });
  assert.deepEqual(settle({ title: "Old", at: "a", read: 0 }, null, now), { title: "Old", at: "a", read: now, failed: true }, "r18: kept, and marked as not read this time");
  assert.deepEqual(settle(undefined, null, now), { title: null, at: null, read: now });
  const m = new Map<string, number>(); for (let i = 0; i < 310; i++) m.set(`k${i}`, i);
  capped(m, 300); assert.equal(m.size, 300); assert.equal(m.has("k9"), false); assert.equal(m.has("k10"), true);
  assert.equal(titleOfPath("Projects/Atlas/Follow-up notes"), "Follow-up notes"); assert.equal(titleOfPath(undefined), null);
});
check("chat cache: the newest 60 per room, per identity; rooms list; old rooms fall out", () => {
  const mem = new Map<string, string>();
  const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  assert.equal(readWho(st), null); writeWho(st, "pk1"); assert.equal(readWho(st), "pk1");
  const rows = Array.from({ length: 80 }, (_, i) => ({ ref: `r${i}`, ts: i }));
  writeMessages(st, "pk1", "ch", rows);
  const got = readMessages<{ ref: string; ts: number }>(st, "pk1", "ch")!;
  assert.equal(got.length, 60); assert.equal(got[0].ts, 20); assert.equal(got[59].ts, 79);
  assert.equal(readMessages(st, "pk2", "ch"), null, "another identity sees nothing"); assert.equal(readMessages(st, null, "ch"), null);
  writeRooms(st, "pk1", [{ id: "ch" }]); assert.deepEqual(readRooms(st, "pk1"), [{ id: "ch" }]); assert.deepEqual(readRooms(st, "pk2"), []);
  const big = Array.from({ length: 60 }, (_, i) => ({ ts: i, body: "x".repeat(5000) }));
  writeMessages(st, "pk1", "big", big); const bigGot = readMessages<{ ts: number }>(st, "pk1", "big")!; assert.ok(JSON.stringify(bigGot).length <= 90_000 && bigGot.at(-1)!.ts === 59, "a room's entry is size-capped, newest kept");
  for (let i = 0; i < 30; i++) writeMessages(st, "pk1", `c${i}`, [{ ts: 1 }]);
  assert.equal(readMessages(st, "pk1", "ch"), null, "the least recent room was dropped"); assert.ok(readMessages(st, "pk1", "c29"));
  writeMessages(st, "pk1", "c29", []); assert.equal(readMessages(st, "pk1", "c29"), null);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("caches: all passed");
