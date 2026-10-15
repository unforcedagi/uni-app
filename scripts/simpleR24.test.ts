// T-124 r24: "chat has moved on" only when the room talked about the request; the summary never contradicts Needs you.
// Run: node --experimental-strip-types scripts/simpleR24.test.ts
import assert from "node:assert/strict";
import { belowInCard, chatAbout, checkInCue, isApprovalRequest, nothingWaiting, requestKeys, unresolvedBlock } from "../src/areas/simpleCore.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const asked = { at: "2026-10-06", kind: "asked" as const };
const ts = (iso: string) => Date.parse(iso) / 1000;

check("P1: unrelated newer chat gives no cue; matching chat names what to check", () => {
  const keys = requestKeys({ title: "T-90 Say go on prod deploy of #38 + #58", next: "Say go on prod deploy of #38 + #58" });
  assert.deepEqual(keys.ids, ["T-90", "#38", "#58"]);
  const unrelated = [{ ref: "a", ts: ts("2026-10-12T10:00:00"), body: "Lunch at noon? The staging copy looks good." }];
  assert.equal(chatAbout(asked, unrelated, keys), null);
  const early = [{ ref: "b", ts: ts("2026-10-05T10:00:00"), body: "#38 is ready" }];
  assert.equal(chatAbout(asked, early, keys), null, "a message before the request doesn't count");
  const hit = chatAbout(asked, [...unrelated, { ref: "c", ts: ts("2026-10-12T11:00:00"), body: "Merged #38, waiting on the go." }], keys);
  assert.equal(hit?.key, "#38");
  assert.equal(hit?.ref, "c");
  assert.equal(checkInCue("cohere", hit!.key, asked), "#cohere has talked about #38 since this was asked");
  assert.equal(chatAbout(asked, [{ ts: ts("2026-10-12T11:00:00"), body: "Pull #380 landed" }], requestKeys({ next: "Say go on #38" })), null, "#380 is not #38");
});

check("P1: with no id, two distinctive words of the step are needed", () => {
  const keys = requestKeys({ title: "Placeholder", next: "Say go on the placeholder deploy" });
  assert.equal(chatAbout(asked, [{ ts: ts("2026-10-12T11:00:00"), body: "The deploy is slow today" }], keys), null);
  assert.ok(chatAbout(asked, [{ ts: ts("2026-10-12T11:00:00"), body: "The placeholder deploy is ready" }], keys));
});

check("P1: only a room-directed request or an approval can carry the cue", () => {
  assert.equal(isApprovalRequest({ next: "Send the plan to Casey" }, false), false);
  assert.equal(isApprovalRequest({ next: "Reply to Sebastian in your existing thread that the letter went out Oct 2 (skip if already done)" }, false), false, "an email reply is not an approval");
  assert.equal(isApprovalRequest({ next: "Say go on the deploy" }, true), true);
  assert.equal(isApprovalRequest({ next: "Approve the budget" }, false), true);
  assert.equal(isApprovalRequest({ next: "x", kind: "decision" }, false), true);
  assert.equal(isApprovalRequest({ next: "A go/no-go on the launch" }, false), true);
});

check("P1: a summary that says something waits on Aaron, with nothing open for them, gets a quiet line", () => {
  const s = "Staging is up; prod waits on Aaron's Wed 10-14 go for #38, #58, #62";
  assert.match(nothingWaiting(s, 0, "2026-10-13T10:00:00Z")!, /^Nothing is waiting on you here now · this summary is from Oct 1[23]$/);
  assert.equal(nothingWaiting(s, 1, "2026-10-13T10:00:00Z", ["Say go on prod deploy of #38"]), null, "an open request names #38: still owed, no line");
  assert.equal(nothingWaiting("Staging is up and quiet.", 0, "2026-10-13T10:00:00Z"), null);
  for (const t of ["needs Aaron to pick", "for Aaron to sign", "Aaron's go", "waits on Aaron"]) assert.ok(nothingWaiting(t, 0, null), t);
  assert.equal(nothingWaiting(s, 0, null), "Nothing is waiting on you here now");
});

check("P1: something else is open, but nothing open mentions what the summary says waits on Aaron: a different quiet line", () => {
  const s = "Staging is up; prod waits on Aaron's Wed 10-14 go for #38, #58, #62";
  assert.match(nothingWaiting(s, 2, "2026-10-13T10:00:00Z", ["Companion Today redesign", "Edit and send the ATLAS follow-up"])!, /^No open request mentions this now · this summary is from Oct 1[23]$/);
  assert.equal(nothingWaiting(s, 2, null, ["Say go on prod deploy of #58"]), null, "an open request names #58: the claim is owed");
  assert.equal(nothingWaiting("Waits on Aaron to pick", 2, null, ["x"]), null, "no id to check: no line while anything is open");
});

check("P1: two whole distinctive words, not a substring or a common verb", () => {
  const keys = requestKeys({ title: "x", next: "Approve the Cloudflare migration plan; the letter went out" });
  assert.equal(chatAbout(asked, [{ ts: ts("2026-10-12T11:00:00"), body: "The cloudflared tunnel and migrations are fine; the letter went to everyone" }], keys), null);
  assert.ok(chatAbout(asked, [{ ts: ts("2026-10-12T11:00:00"), body: "Cloudflare migration is done" }], keys));
});

check("rows:\"message below\" reads \"(in the card)\" when the card carries the message", () => {
  assert.equal(belowInCard("Send Ryan the deploy-access message below.", { detail: "x" }), "Send Ryan the deploy-access message (in the card).");
  assert.equal(belowInCard("Send Ryan the deploy-access message below.", {}), "Send Ryan the deploy-access message below.");
});

check("a step that names a block shows inline text only when it came from that block", () => {
  const next = "Send Harper #cohere's 'For Harper' block";
  assert.deepEqual(unresolvedBlock(next, "Some other note's text"), { name: "For Harper", room: "cohere" });
  assert.equal(unresolvedBlock(next, "## For Harper\nHi Harper"), null);
  assert.equal(unresolvedBlock("Send Ryan the message", "x"), null);
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
