// Run: node --experimental-strip-types scripts/chatFeel.test.ts (Node >= 22.6)
import assert from "node:assert/strict";
import { actionWords, commandOf, firstUnread, isStopReply, openAsk, pingAction, quickReplies, receiptLine, shortElapsed, statusWords, workReceipt } from "../src/chatFeel.ts";
let failed = 0;
const check = (n: string, f: () => void) => { try { f(); console.log("ok  ", n); } catch (e) { failed++; console.log("FAIL", n, e); } };
const ME = "a".repeat(64), UNI = "b".repeat(64);
const NOW = 1_800_000_000;
const m = (ref: string, author: string, ts: number, body = "words", eyes: number | null = null) =>
  ({ ref, author, ts, body, reactions: eyes === null ? [] : [{ emoji: "👀", count: 1, mine: null, by: [{ pubkey: UNI, ts: eyes }] }] });

check("a ping names its action, never its iteration count", () => {
  assert.equal(pingAction("⏳ Working — 3 min — iteration 4/90, terminal"), "terminal");
  assert.equal(pingAction("⏳ Working — 6 min"), null);
  assert.equal(pingAction("⏳ Working — 2 min — iteration 7/90"), null);
  assert.equal(pingAction("Working on it"), null);
});
check("tools are said in words; an unknown tool is 'Working on it', never its raw name", () => {
  assert.deepEqual(actionWords("terminal"), ["Running a command", "ran a command"]);
  assert.deepEqual(actionWords("read_file"), ["Reading files", "read files"]);
  assert.deepEqual(actionWords("mcp_vault_query_notes"), ["Reading notes", "read notes"]);
  assert.deepEqual(actionWords("frobnicate_widgets"), ["Working on it", "worked on it"]);
  assert.deepEqual(actionWords("waiting for the model response"), ["Thinking it through", "thought it through"]);
  assert.equal(actionWords(null), null);
});
check("the status line: passing it on, then reading, then thinking, or what the ping says", () => {
  assert.equal(statusWords("sending", NOW, NOW + 1, null), "Passing it to Uni");
  assert.equal(statusWords("waiting", NOW, NOW + 30, null), "Waiting for Uni to pick it up");
  assert.equal(statusWords("working", NOW, NOW + 3, null), "Reading your message");
  assert.equal(statusWords("working", NOW, NOW + 30, null), "Thinking it through");
  assert.equal(statusWords("working", NOW, NOW + 200, "⏳ Working — 3 min — iteration 4/90, terminal"), "Running a command");
  for (const s of [statusWords("working", NOW, NOW + 200, "⏳ Working — 3 min — iteration 4/90, some_tool_x")]) assert.doesNotMatch(s, /iteration|some_tool/);
});
check("short elapsed times", () => {
  assert.equal(shortElapsed(4.7), "4s");
  assert.equal(shortElapsed(185), "3m 05s");
  assert.equal(shortElapsed(3725), "1h 02m");
});
check("the open ask is your newest message with nothing after it but pings; a stop closes it", () => {
  const ask = m("q", ME, NOW, "Plan the week");
  assert.equal(openAsk([m("1", UNI, NOW - 9), ask], ME)?.ref, "q");
  assert.equal(openAsk([ask, m("p", UNI, NOW + 60, "⏳ Working — 1 min")], ME)?.ref, "q");
  assert.equal(openAsk([ask, m("r", UNI, NOW + 60, "Here is the plan")], ME), null);
  assert.equal(openAsk([ask, m("s", ME, NOW + 5, "/stop")], ME), null);
  assert.equal(openAsk([ask], null), null);
});
check("a finished turn folds into one line: from the 👀 to the reply, with the pings' steps once each", () => {
  const list = [m("q", ME, NOW, "Plan", NOW + 2), m("p1", UNI, NOW + 60, "⏳ Working — 3 min — iteration 4/90, terminal"), m("p2", UNI, NOW + 200, "⏳ Working — 6 min — iteration 9/90, read_file"),
    m("p3", UNI, NOW + 300, "⏳ Working — 9 min — iteration 12/90, terminal"), m("r", UNI, NOW + 43, "Here")];
  const r = workReceipt(list, 4, ME)!;
  assert.deepEqual(r, { seconds: 41, steps: ["ran a command", "read files"] });
  assert.equal(receiptLine({ seconds: 41, steps: [] }), "Worked 41s");
  assert.equal(receiptLine({ seconds: 185, steps: ["ran a command"] }), "Worked 3m 05s · ran a command");
  // no 👀: Uni never took it, so there is nothing to fold
  assert.equal(workReceipt([m("q", ME, NOW), m("r", UNI, NOW + 5)], 1, ME), null);
  // your own message is never a reply
  assert.equal(workReceipt([m("q", ME, NOW, "x", NOW + 1)], 0, ME), null);
});
check("the buttons' commands are known; the gateway's stop answer is folded", () => {
  assert.equal(commandOf(" /stop "), "stop");
  assert.equal(commandOf("/retry"), "retry");
  assert.equal(commandOf("/stop now"), null);
  assert.equal(isStopReply("⚡ Stopped. You can continue this session."), true);
  assert.equal(isStopReply("Stopped by the gate"), false);
});
check("quick replies: a yes-or-no question gets Yes · No · Not now; a choice or a statement doesn't", () => {
  assert.deepEqual(quickReplies("The honey harvest looks ready for Saturday. Shall I ask the neighbours for jars?"), ["Yes", "No", "Not now"]);
  assert.deepEqual(quickReplies("Do you want me to book it?"), ["Yes", "No", "Not now"]);
  assert.equal(quickReplies("Monday or Tuesday?"), null);
  assert.equal(quickReplies("Should we use Monday or Tuesday?"), null);
  assert.equal(quickReplies("What time works for you?"), null);
  assert.equal(quickReplies("The kiln is cool."), null);
});
check("a room opened on unread lands on the first of them, counting others' messages only", () => {
  const list = [m("1", UNI, 1), m("2", ME, 2), m("3", UNI, 3), m("p", UNI, 4, "⏳ Working — 3 min"), m("4", UNI, 5)];
  assert.equal(firstUnread(list, 1, ME), 4);
  assert.equal(firstUnread(list, 2, ME), 2);
  assert.equal(firstUnread(list, 3, ME), 0);
  assert.equal(firstUnread(list, 9, ME), -1);
  assert.equal(firstUnread(list, 0, ME), -1);
});
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("chatFeel tests passed");
