// T-124 r25: the row says the task's `next`, never its title; a summary claim that can't be reconciled is not shown as current;
// Check in has three honest states.
// Run: node --experimental-strip-types scripts/simpleR25.test.ts
import assert from "node:assert/strict";
import { actionLead, belowInCard, checkInResult, checkingBanner, couldntRead, currentStep, privateAction, rowAction, rowSub, staleLine, staleSummary, titleSays, verbPhrase } from "../src/areas/simpleCore.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const T113_NEXT = "On your phone, look at cohereboulder.org, then forward Eileen the asks";
const T113_TITLE = "T-113 Companion Today redesign + integrated PWA install flow (3…";

check("P1-1: T-113's shape (title cut, next whole) is led by its next, whole, in the row's action and the sheet's lead", () => {
  const a = rowAction(T113_NEXT)!;
  assert.equal(a.text, T113_NEXT);
  assert.equal(actionLead(T113_NEXT), T113_NEXT);
  assert.deepEqual(a.steps, ["On your phone, look at cohereboulder.org", "forward Eileen the asks"]);
  assert.equal(a.verb, "On your phone, look at cohereboulder.org");
  assert.equal(currentStep({ next: T113_NEXT, room: "cohere" }), T113_NEXT, "one shared step");
});

check("P1-1: a status is still no action, and an introduced phrase needs a verb after it", () => {
  assert.equal(rowAction("Waiting on Kevin's reply"), null);
  assert.equal(rowAction("On Thursday, the staging site is up"), null);
  assert.ok(rowAction("When ready, say go on #38"));
  assert.equal(privateAction({ kind: "task", next: "On your phone, look at the dentist's list" }), null, "an introduced step is not a short private imperative");
});

check("P1-1: the title is the quiet secondary line, cut with words and no \"…\"; a title stored cut loses its \"…\"", () => {
  const a = rowAction(T113_NEXT)!;
  assert.equal(titleSays(T113_TITLE, a.text), "Companion Today redesign + integrated PWA install flow");
  assert.equal(titleSays("T-40 Companion Today redesign…", a.text), "Companion Today redesign");
  const long = titleSays("T-9 " + "Prepare the quarterly planning summary for the whole team and every partner organisation involved this season", "Look at something")!;
  assert.ok(long.length <= 72 && !/…|\.\.\./.test(long), long);
  assert.equal(titleSays("T-5 Send Eileen the asks", "Forward Eileen the asks"), null, "a title that only says the action again adds nothing");
  assert.equal(rowSub({ title: T113_TITLE, due: "2026-10-13" }, a, null, "2026-10-14"), "Companion Today redesign + integrated PWA install flow · was due Oct 13");
});

check("Ryan: the row and the sheet heading say \"Send Ryan the deploy-access message\", the message beneath", () => {
  assert.equal(currentStep({ next: "Send Ryan the deploy-access message below", room: "techne", detail: "Hey Ryan, …" }), "Send Ryan the deploy-access message");
  assert.equal(belowInCard("Send Ryan the deploy-access message below.", { message: "x" }), "Send Ryan the deploy-access message.");
  assert.equal(currentStep({ next: "Send Ryan the deploy-access message below", room: "techne" }), "Ask #techne for the message", "words nobody stored: ask the room");
});

const STANDS = "Staging is up; prod waits on Aaron's Wed 10-14 go for #38, #58, #62.";
check("P1-2: a claim with no open request makes the whole summary older than the work, dated (r27: nothing is promoted)", () => {
  const s = staleSummary(STANDS, "2026-10-13T10:00:00Z", [])!;
  assert.ok(s);
  assert.match(staleLine(s), /^This summary is older than the latest work · from Oct 1[23]$/);
  assert.equal(s.why, "claim");
  assert.equal(staleLine({ from: null }), "This summary is older than the latest work");
});

check("P1-2: open requests that don't match the claim also make it stale; one that does keeps it current", () => {
  assert.ok(staleSummary(STANDS, "2026-10-13T10:00:00Z", [{ title: "Companion Today redesign" }, { title: "Edit and send the ATLAS follow-up" }]));
  assert.equal(staleSummary(STANDS, "2026-10-13T10:00:00Z", [{ next: "Say go on prod deploy of #38, #58 and #62" }]), null, "#38, #58 and #62 are all open");
  assert.ok(staleSummary(STANDS, "2026-10-13T10:00:00Z", [{ next: "Say go on prod deploy of #58" }]), "r26: #58 alone is not all three");
  assert.equal(staleSummary(STANDS, "2026-10-13T10:00:00Z", [{ next: "Say go on prod deploy of #580" }]) !== null, true, "#580 is not #58");
});

check("P1-2: with no id in the claim, a shared distinctive word reconciles it; nothing shared does not", () => {
  const c = "Waits on Aaron's decision about ATLAS hosting.";
  assert.equal(staleSummary(c, null, [{ title: "Decide the ATLAS hosting" }]), null);
  assert.ok(staleSummary(c, null, [{ title: "Send the follow-up email" }]));
  assert.ok(staleSummary(c, null, [{ title: "Decide the hosting budget" }]), "r26: one shared word is not enough");
  assert.equal(staleSummary("Staging is up and quiet.", null, []), null, "no claim, no line");
  for (const t of ["needs Aaron to pick", "for Aaron to sign", "Aaron's go", "waits on Aaron"]) assert.ok(staleSummary(t, null, []), t);
});

check("P1-3: Check in has three states: found, couldn't check, nothing related", () => {
  const asked = { at: "2026-10-06", kind: "asked" as const };
  const keys = { ids: ["#38"], words: [] };
  const ts = Date.parse("2026-10-12T11:00:00") / 1000;
  const found = checkInResult(asked, [{ ref: "m1", ts, body: "Merged #38, waiting on the go." }], keys);
  assert.equal(found.kind, "found");
  assert.equal(found.kind === "found" && found.hit?.ref, "m1");
  assert.deepEqual(checkInResult(asked, [{ ref: "m2", ts, body: "Lunch at noon?" }], keys), { kind: "none" });
  assert.deepEqual(checkInResult(asked, [], keys), { kind: "none" });
  assert.deepEqual(checkInResult(asked, null, keys), { kind: "failed" }, "a lookup that failed is never \"nothing related\"");
  assert.deepEqual(checkInResult(asked, undefined, keys), { kind: "failed" });
  assert.equal(couldntRead("#cohere"), "Couldn't read #cohere");
});

check("P1-3: the banner over the composer is one line: \"Checking: <step>\", in words", () => {
  assert.equal(checkingBanner("Say go on prod deploy of #38 + #58"), "Checking: Say go on prod deploy of #38 + #58");
  assert.ok(!/…|\.\.\./.test(checkingBanner("word ".repeat(80))));
  assert.equal(checkingBanner("Look at https://cohere-signup-staging.example-workers.invalid/?x=1 on phone"), "Checking: Look at cohere-signup-staging.example-workers.invalid on phone");
});

void verbPhrase;
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("simpleR25: all ok");
