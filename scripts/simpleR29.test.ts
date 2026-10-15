// T-124 r29: say only what the app knows. The announcement grace is Uni's own message naming the ask; "need confirming" claims no work; a summary is a dated account.
// Run: node --experimental-strip-types scripts/simpleR29.test.ts
import assert from "node:assert/strict";
import { ANNOUNCE_GRACE_MS, chatAbout, checkInResult, lastWritten, noneLine, recheckLine, SUMMARY_LONG, standsHeading } from "../src/areas/simpleCore.ts";
import type { Task } from "../src/areas/taskCore.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const at = "2026-10-15T08:05:41.000Z";
const t0 = new Date(at).getTime();
const sec = (ms: number) => Math.floor(ms / 1000);
const asked = { at, kind: "asked" as const };
const NEXT = "Tell Uni who pays the $10k sponsorship and how";
const keys = { ids: ["T-65"], words: [] as string[], next: NEXT };
const UNI = "uni-pubkey", AARON = "aaron-pubkey", OTHER = "other-pubkey";

await check("P1-1: Uni's announcement naming T-65 inside the window is skipped", () => {
  const m = [{ ref: "a", ts: sec(t0 + 9_000), body: `I've re-stated each ask: T-65: ${NEXT.toLowerCase()}`, author: UNI }];
  assert.equal(chatAbout(asked, m, keys, UNI), null);
  assert.equal(checkInResult(asked, m, keys, undefined, UNI).kind, "none");
});
await check("P1-1: Aaron's \"T-65 is off\" two minutes later unconfirms it", () => {
  const m = [{ ref: "a", ts: sec(t0 + 9_000), body: `T-65: ${NEXT}`, author: UNI }, { ref: "b", ts: sec(t0 + 120_000), body: "T-65 is off", author: AARON }];
  assert.equal(chatAbout(asked, m, keys, UNI)?.ref, "b");
  assert.equal(checkInResult(asked, m, keys, undefined, UNI).kind, "found");
});
await check("P1-1: any other key inside the window counts, as does Uni's message that doesn't name T-65", () => {
  assert.equal(chatAbout(asked, [{ ref: "c", ts: sec(t0 + 60_000), body: "T-65 done", author: OTHER }], keys, UNI)?.ref, "c");
  const words = { ids: ["T-65"], words: ["sponsorship", "invoice"], next: NEXT };
  assert.equal(chatAbout(asked, [{ ref: "d", ts: sec(t0 + 60_000), body: "the sponsorship invoice went out", author: UNI }], words, UNI)?.ref, "d");
  assert.equal(chatAbout(asked, [{ ref: "e", ts: sec(t0 + 60_000), body: "T-650 is separate", author: UNI }], keys, UNI), null, "T-650 is not T-65, and names no key");
});
await check("P1-1: without a known Uni key nothing is an announcement; and past the window Uni's message counts", () => {
  const m = [{ ref: "a", ts: sec(t0 + 9_000), body: `T-65 ${NEXT}`, author: UNI }];
  assert.equal(chatAbout(asked, m, keys, null)?.ref, "a");
  assert.equal(chatAbout(asked, m, keys)?.ref, "a");
  const later = [{ ref: "z", ts: sec(t0 + ANNOUNCE_GRACE_MS + 60_000), body: "T-65 is settled", author: UNI }];
  assert.equal(chatAbout(asked, later, keys, UNI)?.ref, "z");
});

await check("P1-2: the quiet line claims no work, and the empty state says what is known", () => {
  // r30: "older" was wrong (some were asked today); the line says which rooms it counts
  assert.equal(recheckLine(1), "1 request needs confirming in this room");
  assert.equal(recheckLine(15, "all"), "15 requests need confirming across all rooms");
  assert.ok(!/rechecking|Uni is/i.test(recheckLine(3)));
  const t = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }) as unknown as Task);
  assert.equal(noneLine({ recheck: t(3), checking: [] }), "No confirmed asks");
  assert.equal(noneLine({ recheck: [], checking: t(2) }), "No confirmed asks");
  assert.equal(noneLine({ recheck: [], checking: [] }), "Nothing needs you here.");
  assert.equal(noneLine({}), "Nothing needs you here.");
});

await check("P1-3: a summary is labelled with its date and room; no verdict", () => {
  assert.equal(lastWritten("Oct 14", "cohere"), "Last written Oct 14 by #cohere:");
  assert.equal(lastWritten("Oct 14", "#Uni"), "Last written Oct 14 by #Uni:");
  assert.equal(lastWritten("Oct 14", null), "Last written Oct 14:");
  assert.ok(SUMMARY_LONG > 100);
  assert.equal(standsHeading(null, "yesterday", "Oct 14"), "Where this stands");
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("simpleR29: all ok");
