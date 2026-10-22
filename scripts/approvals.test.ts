import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answersLine, parseApproval, parseOutcome, pendingApprovals, type ApprovalSource } from "../src/approvals.ts";
import { uniPanel, withApprovals, type NeedsFeed } from "../src/areas/simpleCore.ts";
let failed = 0;
const check = (n: string, f: () => void) => { try { f(); console.log("ok  ", n); } catch (e) { failed++; console.log("FAIL", n, e); } };
// Synthetic copies of the gateway's shapes as stored on the relay (T-161 findings): regenerate when the gateway's wording changes.
const fx = JSON.parse(readFileSync(new URL("./fixtures/approval-prompts.json", import.meta.url), "utf8"));
const AG = "a".repeat(64), ME = "e".repeat(64), OTHER = "f".repeat(64);
let n = 0;
const msg = (body: string, ts: number, o: Partial<ApprovalSource> = {}): ApprovalSource => ({ ref: `m${++n}`, channel: "ch-1", author: AG, ts, body, root: null, ...o });
const P = fx.prompts, O = fx.outcomes;

check("every prompt shape parses, with its command, reason, answers and window", () => {
  const a = parseApproval(msg(P.three_answers_5min, 1000))!;
  assert.equal(a.command, "rm -rf /tmp/example-build/cache");
  assert.equal(a.why, "delete in root path");
  assert.deepEqual(a.answers, ["/approve", "/approve session", "/approve always", "/deny"]);
  assert.equal(a.deadline, 1300);
  assert.equal(a.kind, "command");
  assert.deepEqual(parseApproval(msg(P.two_answers_30min, 0))!.answers, ["/approve", "/approve session", "/deny"]);
  assert.equal(parseApproval(msg(P.once_or_deny_30min, 0))!.deadline, 1800);
  assert.match(parseApproval(msg(P.multiline_why, 0))!.why, /Pipe to interpreter.*Safer: download/);
  assert.equal(parseApproval(msg(P.smart_deny, 0))!.kind, "smart-deny");
  assert.equal(answersLine(parseApproval(msg(P.once_or_deny_30min, 0))!), "/approve or /deny");
});
check("a message that only mentions /approve, or quotes the header, is not a prompt", () => {
  for (const [k, body] of Object.entries(fx.not_prompts)) assert.equal(parseApproval(msg(body as string, 0)), null, k);
  // the header alone, or with the answers line changed, is not the gateway's shape
  assert.equal(parseApproval(msg(P.three_answers_5min.split("\n")[0], 0)), null);
  assert.equal(parseApproval(msg(P.three_answers_5min.replace("`/deny` to cancel.", "`/deny` to cancel, please.") , 0)), null);
  assert.equal(parseApproval(msg(P.three_answers_5min + "\nP.S. thanks", 0)), null);
});
check("every outcome is read: one, N or all", () => {
  for (const k of ["approved", "approved_session", "approved_always", "denied", "denied_reason", "timed_out_5", "timed_out_30"]) assert.deepEqual(parseOutcome(O[k]), { n: 1 }, k);
  assert.deepEqual(parseOutcome(O.approved_two), { n: 2 });
  for (const k of ["denied_stale", "expired", "no_pending"]) assert.equal(parseOutcome(O[k]), "all", k);
  assert.equal(parseOutcome("I approved the plan; the agent is resuming tomorrow."), null);
});
check("a prompt waits until approved, denied or timed out, or its window passes", () => {
  const p = msg(P.two_answers_30min, 1000);
  assert.equal(pendingApprovals([p], 1001).length, 1);
  assert.equal(pendingApprovals([p, msg("/approve", 1010, { author: ME }), msg(O.approved, 1011)], 1100, ME).length, 0);
  assert.equal(pendingApprovals([p, msg(O.denied, 1011)], 1100).length, 0);
  assert.equal(pendingApprovals([p, msg(O.timed_out_30, 2800)], 2801).length, 0);
  // withdrawn with no message: gone once its own window is up, not before
  assert.equal(pendingApprovals([p], 2799).length, 1);
  assert.equal(pendingApprovals([p], 2800).length, 0);
});
check("outcomes settle the oldest first, and only their own author's", () => {
  const a = msg(P.three_answers_5min, 1000), b = msg(P.two_answers_30min, 1010);
  assert.deepEqual(pendingApprovals([a, b, msg(O.approved, 1020)], 1030).map((x) => x.ref), [b.ref]);
  assert.equal(pendingApprovals([a, b, msg(O.approved_two, 1020)], 1030).length, 0);
  assert.equal(pendingApprovals([a, b, msg(O.no_pending, 1020)], 1030).length, 0);
  // someone else saying the words settles nothing
  assert.equal(pendingApprovals([a, msg(O.approved, 1020, { author: OTHER })], 1030).length, 1);
  // the user's own pasted prompt is never one
  assert.equal(pendingApprovals([msg(P.three_answers_5min, 1000, { author: ME })], 1001, ME).length, 0);
});
check("the timeout notice at the deadline settles that prompt, not the next one", () => {
  const a = msg(P.three_answers_5min, 1000), b = msg(P.two_answers_30min, 1100);
  assert.deepEqual(pendingApprovals([a, b, msg(O.timed_out_5, 1300)], 1301).map((x) => x.ref), [b.ref]);
  assert.deepEqual(pendingApprovals([a, b, msg(O.timed_out_5, 1301)], 1302).map((x) => x.ref), [b.ref]);
});
check("rooms and threads are apart", () => {
  const a = msg(P.three_answers_5min, 1000), b = msg(P.three_answers_5min, 1001, { channel: "ch-2" });
  assert.deepEqual(pendingApprovals([a, b, msg(O.approved, 1002, { channel: "ch-2" })], 1003).map((x) => x.ref), [a.ref]);
  const t = msg(P.three_answers_5min, 1005, { root: "r1" });
  assert.deepEqual(pendingApprovals([a, t, msg(O.approved, 1010, { root: "r1" })], 1011).map((x) => x.ref), [a.ref]);
  // an outcome at the top of a room settles a thread's prompt when nothing else waits there
  assert.equal(pendingApprovals([t, msg(O.approved, 1010)], 1011).length, 0);
});
check("order and duplicates in the input don't matter", () => {
  const a = msg(P.three_answers_5min, 1000), o = msg(O.approved, 1010);
  assert.equal(pendingApprovals([o, a, a], 1011).length, 0);
});
check("Uni's panel shows its approval prompts itself: they are counted once, and never also in \"Show N more\"", () => {
  const none: NeedsFeed = { rows: [], privates: [], total: 0 };
  const two = pendingApprovals([msg(P.three_answers_5min, 1000), msg(P.once_or_deny_30min, 1001, { channel: "ch-2" })], 1002);
  const p = uniPanel(withApprovals(none, two));
  assert.equal(p.total, 2);
  assert.equal(p.rest, 0, "nothing else is owed: no stray \"1 more\" under the prompts");
  assert.equal(p.rows.length + (p.approvals?.length ?? 0) + p.rest, p.total, "what is shown plus 'Show N more' is exactly the count");
});
if (failed) { console.log(`${failed} failed`); process.exit(1); }
