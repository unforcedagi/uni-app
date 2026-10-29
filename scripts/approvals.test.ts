import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answersLine, approvalOutcomes, parseApproval, parseOutcome, pendingApprovals, type ApprovalSource } from "../src/approvals.ts";
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
check("Codex P1: an outcome inside another thread never settles a prompt outside it", () => {
  const a = msg(P.three_answers_5min, 1000, { root: "rA" });
  assert.deepEqual(pendingApprovals([a, msg(O.no_pending, 1010, { root: "rB" })], 1011).map((x) => x.ref), [a.ref]);
  assert.deepEqual(pendingApprovals([a, msg(O.approved, 1010, { root: "rB" })], 1011).map((x) => x.ref), [a.ref]);
  const top = msg(P.three_answers_5min, 1001);
  assert.deepEqual(pendingApprovals([top, msg(O.denied, 1010, { root: "rB" })], 1011).map((x) => x.ref), [top.ref]);
});
check("Codex P1: a late timeout notice never settles a newer prompt still open", () => {
  const a = msg(P.three_answers_5min, 1000), b = msg(P.three_answers_5min, 1400);
  assert.deepEqual(pendingApprovals([a, b, msg(O.timed_out_5, 1401)], 1402).map((x) => x.ref), [b.ref]);
});
check("Codex round 2 P1: a timeout notice never settles a prompt whose window ends later, even by a minute", () => {
  const a = msg(P.three_answers_5min, 1000), b = msg(P.three_answers_5min, 1150);
  assert.deepEqual(pendingApprovals([a, b, msg(O.timed_out_5, 1401)], 1402).map((x) => x.ref), [b.ref]);
  // its own notice, posted on the second its window ends, does settle it
  assert.equal(pendingApprovals([b, msg(O.timed_out_5, 1450)], 1451).length, 0);
});
check("Codex P2: in one second, the prompt comes before the outcome whatever the refs", () => {
  const a = msg(P.three_answers_5min, 1000, { ref: "zz" });
  assert.equal(pendingApprovals([a, msg(O.approved, 1000, { ref: "aa" })], 1001).length, 0);
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
check("T-335: how each prompt ended, for its one line in the room", () => {
  const out = (ms: ApprovalSource[], now: number) => Object.fromEntries([...approvalOutcomes(ms, now, ME)].map(([k, v]) => [k, [v.outcome, v.at]]));
  const a = msg(P.three_answers_5min, 1000), b = msg(P.two_answers_30min, 1010), c = msg(P.once_or_deny_30min, 1020, { channel: "ch-2" });
  // approved settles the oldest; the next waits (not in the map)
  assert.deepEqual(out([a, b, msg(O.approved, 1100)], 1101), { [a.ref]: ["approved", 1100] });
  assert.deepEqual(out([a, b, msg(O.approved_two, 1100)], 1101), { [a.ref]: ["approved", 1100], [b.ref]: ["approved", 1100] });
  assert.deepEqual(out([a, msg(O.denied, 1100)], 1101), { [a.ref]: ["denied", 1100] });
  assert.deepEqual(out([a, msg(O.denied_stale, 1100)], 1101), { [a.ref]: ["denied", 1100] });
  assert.deepEqual(out([a, msg(O.timed_out_5, 1300)], 1301), { [a.ref]: ["timed-out", 1300] });
  assert.deepEqual(out([a, msg(O.no_pending, 1100)], 1101), { [a.ref]: ["gone", 1100] });
  // no answer at all: still waiting inside its window, expired at its deadline after it
  assert.deepEqual(out([a], 1299), {});
  assert.deepEqual(out([a], 1300), { [a.ref]: ["expired", 1300] });
  // a prompt that ran out before a later outcome came is expired, and that outcome answers the next one
  assert.deepEqual(out([a, b, msg(O.denied, 1400)], 1401), { [a.ref]: ["expired", 1300], [b.ref]: ["denied", 1400] });
  // another room's answer never ends this one
  assert.deepEqual(out([c, msg(O.approved, 1100)], 1101), {});
  // the same reading as pendingApprovals: a prompt is either waiting or ended, never both, never neither
  const all = [a, b, c, msg(O.approved, 1100), msg(O.timed_out_30, 2820, { channel: "ch-2" })];
  for (const now of [1101, 1500, 2900]) {
    const waiting = new Set(pendingApprovals(all, now, ME).map((x) => x.ref)), ended = approvalOutcomes(all, now, ME);
    for (const p of [a, b, c]) assert.equal(waiting.has(p.ref) !== ended.has(p.ref), true, `${p.ref} at ${now}`);
  }
});
if (failed) { console.log(`${failed} failed`); process.exit(1); }
