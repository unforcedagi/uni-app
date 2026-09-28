// Run: node --experimental-strip-types scripts/approvals.test.ts (Node >= 22.6)
import assert from "node:assert/strict";
import { approvalOpen, parseApproval } from "../src/approvals.ts";

// The exact shape gateway/run.py _format_exec_approval_fallback emits on Buzz.
const full = "⚠️ **Hermes wants to run a command that needs your OK**\n```\nrm -rf /tmp/build\n```\nWhy it was flagged: recursive delete\n\n" +
  "Reply `/approve` to run it once, `/approve session` to allow this pattern for the rest of this session, `/approve always` to allow it permanently, or `/deny` to cancel.\n" +
  "If you don't answer within 30 minutes it will NOT run.";
const p = parseApproval(full)!;
assert.ok(p);
assert.equal(p.command, "rm -rf /tmp/build");
assert.equal(p.reason, "recursive delete");
assert.deepEqual(p.choices.map((c) => c.reply), ["/approve", "/approve session", "/approve always", "/deny"]);
assert.deepEqual(p.choices.map((c) => c.tone), ["go", "go", "go", "stop"]);

// Smart DENY: only approve-once and deny are offered.
const smart = "⚠️ **Smart DENY — owner override for one operation:**\n```\ngit push --force\n```\nWhy it was flagged: force push\n\n" +
  "Reply `/approve` to run it once, or `/deny` to cancel.\nIf you don't answer within 30 minutes it will NOT run.";
const s = parseApproval(smart)!;
assert.equal(s.command, "git push --force");
assert.equal(s.reason, "force push");
assert.deepEqual(s.choices.map((c) => c.reply), ["/approve", "/deny"]);

// Anything else is not a prompt.
assert.equal(parseApproval("hello there"), null);
assert.equal(parseApproval("Hermes wants to run a command that needs your OK (just quoting it)"), null);
assert.equal(parseApproval("Reply `/approve` or `/deny`"), null);

// Open while in the window and nobody has spoken since.
assert.equal(approvalOpen(1000, [], 1000 + 60), true);
assert.equal(approvalOpen(1000, [{ ts: 900 }, { ts: 1000 }], 1100), true);
assert.equal(approvalOpen(1000, [{ ts: 1001 }], 1100), false); // answered
assert.equal(approvalOpen(1000, [], 1000 + 1800), false); // expired
assert.equal(approvalOpen(1000, [], 1000 + 1799, 1800), true);
assert.equal(approvalOpen(1000, [], 1000 + 301, 300), false);
console.log("approvals: ok");
