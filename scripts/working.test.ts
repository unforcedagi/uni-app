import assert from "node:assert/strict";
import { elapsed, workingOn } from "../src/working.ts";
let failed = 0;
const check = (n: string, f: () => void) => { try { f(); console.log("ok  ", n); } catch (e) { failed++; console.log("FAIL", n, e); } };
const ME = "a".repeat(64), UNI = "b".repeat(64), SAM = "c".repeat(64);
const NOW = 1_800_000_000;
/** 👀 from `by`, each `ago` seconds before NOW (default: 2 s after a message 42 s old would be 40). */
const eyes = (...by: (string | [string, number])[]) => {
  const list = by.map((b) => typeof b === "string" ? { pubkey: b, ts: 0 } : { pubkey: b[0], ts: NOW - b[1] });
  return [{ emoji: "👀", count: list.length, mine: list.some((b) => b.pubkey === ME) ? "r-me" : null, by: list }];
};
const m = (ref: string, author: string, ago: number, body = "words", extra: Record<string, unknown> = {}) => {
  const msg: any = { ref, author, ts: NOW - ago, body, edited: false, last_reply_ts: null, reactions: [], ...extra };
  for (const r of msg.reactions) for (const b of r.by ?? []) if (b.ts === 0) b.ts = msg.ts + 2; // a bare 👀 lands 2 s after its message
  return msg;
};

check("👀 from Uni on your newest message: Uni is working since it", () =>
  assert.deepEqual(workingOn([m("1", UNI, 600), m("2", ME, 42, "ask", { reactions: eyes(UNI) })], ME, NOW), { author: UNI, since: NOW - 40 }));
check("counted from the 👀, not from the message: a message taken late starts at 0", () =>
  assert.deepEqual(workingOn([m("2", ME, 3000, "ask", { reactions: eyes([UNI, 5]) })], ME, NOW), { author: UNI, since: NOW - 5 }));
check("no 👀: nothing", () => assert.equal(workingOn([m("1", UNI, 600), m("2", ME, 42)], ME, NOW), null));
check("Uni's reply after it ends the work", () =>
  assert.equal(workingOn([m("2", ME, 42, "ask", { reactions: eyes(UNI) }), m("3", UNI, 5, "done")], ME, NOW), null));
check("a progress ping does not end it", () =>
  assert.deepEqual(workingOn([m("2", ME, 400, "ask", { reactions: eyes(UNI) }), m("3", UNI, 220, "⏳ Working — 3 min — iteration 4/90, terminal")], ME, NOW), { author: UNI, since: NOW - 398 }));
check("your own 👀 is not work", () => assert.equal(workingOn([m("2", ME, 42, "ask", { reactions: eyes(ME) })], ME, NOW), null));
check("an older message of yours with 👀, a newer one without: still working since the older", () =>
  assert.deepEqual(workingOn([m("2", ME, 90, "ask", { reactions: eyes(UNI) }), m("3", ME, 30, "and also")], ME, NOW), { author: UNI, since: NOW - 88 }));
check("two of yours with Uni's 👀: since the first", () =>
  assert.deepEqual(workingOn([m("2", ME, 90, "ask", { reactions: eyes(UNI) }), m("3", ME, 30, "and also", { reactions: eyes(UNI) })], ME, NOW), { author: UNI, since: NOW - 88 }));
check("the newest 👀 says who works: someone's older 👀 does not name them", () =>
  assert.deepEqual(workingOn([m("2", ME, 90, "ask", { reactions: eyes(SAM) }), m("3", ME, 30, "and also", { reactions: eyes(UNI) })], ME, NOW), { author: UNI, since: NOW - 28 }));
check("a 👀 older than someone else's message is over", () =>
  assert.equal(workingOn([m("2", ME, 90, "ask", { reactions: eyes(UNI) }), m("3", SAM, 60, "hi"), m("4", ME, 30)], ME, NOW), null));
check("a reply in its thread after the 👀: over", () =>
  assert.equal(workingOn([m("2", ME, 90, "ask", { reactions: eyes(UNI), last_reply_ts: NOW - 10 })], ME, NOW), null));
check("a thread reply from before the 👀 does not end it", () =>
  assert.deepEqual(workingOn([m("2", ME, 900, "ask", { reactions: eyes([UNI, 60]), last_reply_ts: NOW - 800 })], ME, NOW), { author: UNI, since: NOW - 60 }));
check("a newer message of yours answered in its thread, with no 👀 on it: over", () =>
  assert.equal(workingOn([m("2", ME, 90, "ask", { reactions: eyes(UNI) }), m("3", ME, 30, "and also", { last_reply_ts: NOW - 10 })], ME, NOW), null));
check("counted from their earliest 👀 on a message, in either form", () => {
  const both = [{ emoji: "👀", count: 2, mine: null, by: [{ pubkey: SAM, ts: NOW - 100 }, { pubkey: UNI, ts: NOW - 50 }] }, { emoji: "👀\uFE0F", count: 1, mine: null, by: [{ pubkey: UNI, ts: NOW - 90 }] }];
  assert.deepEqual(workingOn([m("2", ME, 120, "ask", { reactions: both }), m("3", ME, 30, "and also", { reactions: eyes([UNI, 20]) })], ME, NOW), { author: UNI, since: NOW - 90 });
  const twice = [{ emoji: "👀", count: 1, mine: null, by: [{ pubkey: UNI, ts: NOW - 50 }] }, { emoji: "👀\uFE0F", count: 1, mine: null, by: [{ pubkey: UNI, ts: NOW - 90 }] }];
  assert.deepEqual(workingOn([m("2", ME, 120, "ask", { reactions: twice })], ME, NOW), { author: UNI, since: NOW - 90 });
});
check("past an hour with no live ping: let go", () =>
  assert.equal(workingOn([m("2", ME, 3700, "ask", { reactions: eyes(UNI) })], ME, NOW), null));
check("past an hour with Uni's ping still being edited: still working", () =>
  assert.deepEqual(workingOn([m("2", ME, 3700, "ask", { reactions: eyes(UNI) }), m("3", UNI, 3600 - 180, "⏳ Working — 61 min", { edited: true })], ME, NOW), { author: UNI, since: NOW - 3698 }));
check("another worker's live ping does not hold Uni's stale 👀", () =>
  assert.equal(workingOn([m("2", ME, 3700, "ask", { reactions: eyes(UNI) }), m("3", SAM, 3600 - 180, "⏳ Working — 61 min", { edited: true })], ME, NOW), null));
check("the 👀 with a variation selector counts, even after your own plain 👀; a reaction list without `by` (an older build) does not", () => {
  assert.deepEqual(workingOn([m("2", ME, 5, "ask", { reactions: [{ emoji: "👀", count: 1, mine: "r", by: [{ pubkey: ME, ts: NOW - 4 }] }, { emoji: "👀\uFE0F", count: 1, mine: null, by: [{ pubkey: UNI, ts: NOW - 3 }] }] })], ME, NOW), { author: UNI, since: NOW - 3 });
  assert.equal(workingOn([m("2", ME, 5, "ask", { reactions: [{ emoji: "👀", count: 1, mine: null }] })], ME, NOW), null);
});
check("no identity yet: nothing", () => assert.equal(workingOn([m("2", ME, 5, "ask", { reactions: eyes(UNI) })], null, NOW), null));
check("elapsed", () => {
  assert.equal(elapsed(0), "0:00"); assert.equal(elapsed(42.9), "0:42"); assert.equal(elapsed(725), "12:05"); assert.equal(elapsed(3729), "1:02:09"); assert.equal(elapsed(-3), "0:00");
});
if (failed) process.exit(1);
