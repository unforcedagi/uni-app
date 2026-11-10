// T-124 r29: say only what the app knows. The announcement grace is Uni's own message naming the ask; "need confirming" claims no work; a summary is a dated account.
// Run: node --experimental-strip-types scripts/simpleR29.test.ts
import assert from "node:assert/strict";
import { lastWritten, SUMMARY_LONG, standsHeading } from "../src/areas/simpleCore.ts";

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


await check("P1-3: a summary is labelled with its date and room; no verdict", () => {
  assert.equal(lastWritten("Oct 14", "cohere"), "Last written Oct 14 by #cohere:");
  assert.equal(lastWritten("Oct 14", "#Uni"), "Last written Oct 14 by #Uni:");
  assert.equal(lastWritten("Oct 14", null), "Last written Oct 14:");
  assert.ok(SUMMARY_LONG > 100);
  assert.equal(standsHeading(null, "yesterday", "Oct 14"), "Where this stands");
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("simpleR29: all ok");

// T-335 as Aaron: the folded room line keeps the dated account in fewer words
import { foldedLead } from "../src/areas/simpleCore.ts";
import assertLead from "node:assert/strict";
assertLead.equal(foldedLead("Nov 5", 0, "#kiln"), "Today: ");
assertLead.equal(foldedLead("Nov 4", 1, "#kiln"), "Yesterday: ");
assertLead.equal(foldedLead("Oct 7", 29, "#kiln"), "Oct 7: ");
assertLead.equal(foldedLead(null, null, "kiln"), "#kiln: ");
assertLead.equal(foldedLead(null, null, null), "");
