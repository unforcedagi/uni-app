// T-124 r24: "chat has moved on" only when the room talked about the request; the summary never contradicts Needs you.
// Run: node --experimental-strip-types scripts/simpleR24.test.ts
import assert from "node:assert/strict";
import { belowInCard, unresolvedBlock } from "../src/areas/simpleCore.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const asked = { at: "2026-10-06", kind: "asked" as const };
const ts = (iso: string) => Date.parse(iso) / 1000;





check("r25: \"message below\" loses \"below\" when the card carries the message (row and sheet heading say the same words)", () => {
  assert.equal(belowInCard("Send Ryan the deploy-access message below.", { detail: "x" }), "Send Ryan the deploy-access message.");
  assert.equal(belowInCard("Send Ryan the deploy-access message below.", {}), "Send Ryan the deploy-access message below.");
});

check("a step that names a block shows inline text only when it came from that block", () => {
  const next = "Send Harper #cohere's 'For Harper' block";
  assert.deepEqual(unresolvedBlock(next, "Some other note's text"), { name: "For Harper", room: "cohere" });
  assert.equal(unresolvedBlock(next, "## For Harper\nHi Harper"), null);
  assert.equal(unresolvedBlock("Send Ryan the message", "x"), null);
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
