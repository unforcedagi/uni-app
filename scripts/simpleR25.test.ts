// T-124 r25: the row says the task's `next`, never its title; a summary claim that can't be reconciled is not shown as current;
// Check in has three honest states.
// Run: node --experimental-strip-types scripts/simpleR25.test.ts
import assert from "node:assert/strict";
import { actionLead, belowInCard, checkingBanner, currentStep, privateAction, rowAction, rowSub, titleSays, verbPhrase } from "../src/areas/simpleCore.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const T113_NEXT = "On your phone, look at grove.example.org, then forward Harper the asks";
const T113_TITLE = "T-113 Companion Today redesign + integrated PWA install flow (3…";

check("P1-1: T-113's shape (title cut, next whole) is led by its next, whole, in the row's action and the sheet's lead", () => {
  const a = rowAction(T113_NEXT)!;
  assert.equal(a.text, T113_NEXT);
  assert.equal(actionLead(T113_NEXT), T113_NEXT);
  assert.deepEqual(a.steps, ["On your phone, look at grove.example.org", "forward Harper the asks"]);
  assert.equal(a.verb, "On your phone, look at grove.example.org");
  assert.equal(currentStep({ next: T113_NEXT, room: "cohere" }), T113_NEXT, "one shared step");
});

check("P1-1: a status is still no action, and an introduced phrase needs a verb after it", () => {
  assert.equal(rowAction("Waiting on Casey's reply"), null);
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
  assert.equal(titleSays("T-5 Send Harper the asks", "Forward Harper the asks"), null, "a title that only says the action again adds nothing");
  assert.equal(rowSub({ title: T113_TITLE, due: "2026-10-13" }, a, null, "2026-10-14"), "Companion Today redesign + integrated PWA install flow · was due Oct 13");
});

check("Nico: the row and the sheet heading say \"Send Nico the deploy-access message\", the message beneath", () => {
  assert.equal(currentStep({ next: "Send Nico the deploy-access message below", room: "techne", detail: "Hey Nico, …" }), "Send Nico the deploy-access message");
  assert.equal(belowInCard("Send Nico the deploy-access message below.", { message: "x" }), "Send Nico the deploy-access message.");
  assert.equal(currentStep({ next: "Send Nico the deploy-access message below", room: "techne" }), "Ask #techne for the message", "words nobody stored: ask the room");
});



check("P1-3: the banner over the composer is one line: \"Checking: <step>\", in words", () => {
  assert.equal(checkingBanner("Say go on prod deploy of #38 + #58"), "Checking: Say go on prod deploy of #38 + #58");
  assert.ok(!/…|\.\.\./.test(checkingBanner("word ".repeat(80))));
  assert.equal(checkingBanner("Look at https://cohere-signup-staging.example-workers.invalid/?x=1 on phone"), "Checking: Look at cohere-signup-staging.example-workers.invalid on phone");
});

void verbPhrase;
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("simpleR25: all ok");
