// T-213 Uni's sends held for you, pure parts: when Send it is offered, what each answer says, and how the store keeps
// what you decided through listings. Run: node --experimental-strip-types scripts/mailHeld.test.ts (Node >= 22.6)
import assert from "node:assert/strict";
import { approvalOffered, approveOutcome, canApprove, declineOutcome, heldFailure, settled, type AccountBoxes, type Parked, type SendOutcome } from "../src/mailCore.ts";
import { beginListing, endDeciding, forgetHeld, heldEntries, heldGen, keepAccounts, mergeListing, setOutcome, startDeciding, waitingCount } from "../src/mailHeld.ts";

const uni = (operations: string[]): AccountBoxes => ({ id: "U", name: "uni@example.com", who: "uni", mailboxes: [], operations });
const ALL = ["send.parked", "send.approve", "send.decline"];
const fields = { to: [{ name: null, email: "orchard@example.org" }], cc: [], bcc: [], subject: "Barn", text: "Saturday?", in_reply_to: null };
const held = (op: string, o: Partial<Parked> = {}): Parked => ({ op_id: op, draft_id: "h1", reason: "r", sent_by: "Uni", parked_at: null, recipients: ["orchard@example.org"],
  fingerprint: "ab".repeat(32), changed: false, fields, plain: true, problem: null, ...o });

// the group shows only on Uni's account, and only where deciding is offered
assert.equal(approvalOffered(uni(ALL)), true);
assert.equal(approvalOffered(uni(["send.decline"])), true);
assert.equal(approvalOffered(uni(["send.parked", "flag"])), false);
assert.equal(approvalOffered({ ...uni(ALL), who: "owner" }), false, "never on your own account");
assert.equal(approvalOffered(undefined), false);

// Send it only for a draft shown whole: plain text the bridge vouches for, its fingerprint, unchanged, no problem
assert.equal(canApprove(uni(ALL), held("op-a")), true);
for (const [why, p] of [["plain unknown", held("op-a", { plain: null })], ["not plain", held("op-a", { plain: false })], ["changed", held("op-a", { changed: true })],
  ["no fingerprint", held("op-a", { fingerprint: null })], ["no fields", held("op-a", { fields: null })], ["a problem", held("op-a", { problem: "gone" })]] as const) {
  assert.equal(canApprove(uni(ALL), p), false, why);
}
assert.equal(canApprove(uni(["send.parked", "send.decline"]), held("op-a")), false, "not offered");

// what each answer says
const out = (state: SendOutcome["state"], reason: string | null = null): SendOutcome => ({ op_id: "op-a", account_id: "U", draft_id: "h1", state, reason, submission_id: null, delivery: null, note: null });
assert.deepEqual(approveOutcome(out("cleaned"), "uni@example.com"), { kind: "sent", text: "Sent from Uni's address (uni@example.com)." });
assert.equal(approveOutcome(out("refused", "the draft changed since it was reviewed"), "u").text, "Couldn't send: the draft changed since it was reviewed. Ask #mail.");
for (const s of ["unknown", "submitting", "reserved", "drafting"] as const) assert.match(approveOutcome(out(s), "u").text, /^Couldn't confirm it was sent: ask #mail/, s);
assert.equal(approveOutcome(out("awaiting-approval"), "u").kind, "failed");
assert.equal(declineOutcome(out("declined")).kind, "declined");
assert.equal(declineOutcome(out("cleaned")).kind, "failed");
assert.equal(heldFailure({ kind: "refused", status: 404, message: "no such send" }, true).text, "Couldn't send: no such send. Ask #mail.");
assert.equal(heldFailure({ kind: "refused", status: 409, message: "that send was already declined" }, true).text, "Couldn't send: that send was already declined. Ask #mail.");
assert.equal(heldFailure({ kind: "server", message: "URLError" }, false).text, "Couldn't decline it: the mail server didn't answer. Ask #mail.");
assert.equal(settled("declined"), true, "a declined send is settled: it leaves the pending list");

// the store: a listing never undoes what you decided here, and a decision on its way survives a listing without it
let gen = heldGen();
let early = beginListing(); // read before the decision, answered after it
const late = beginListing();
mergeListing("U", [held("op-a"), held("op-b")], gen, late);
assert.equal(waitingCount(), 2);
assert.ok(startDeciding("op-a"));
assert.equal(startDeciding("op-a"), false, "a second tap while the first is out does nothing");
mergeListing("U", [held("op-b")], gen, beginListing()); // the bridge already took it; the answer is still on its way
assert.deepEqual(heldEntries().U.map((e) => [e.item.op_id, e.listed]), [["op-b", true], ["op-a", false]], "kept while it is decided");
setOutcome("U", "op-a", { kind: "sent", text: "Sent" }, gen);
endDeciding("op-a");
mergeListing("U", [held("op-a"), held("op-b")], gen, early);
assert.equal(heldEntries().U.find((e) => e.item.op_id === "op-a")?.outcome?.kind, "sent", "an older listing is dropped");
mergeListing("U", [held("op-a"), held("op-b")], gen, beginListing());
assert.equal(heldEntries().U.find((e) => e.item.op_id === "op-a")?.outcome?.kind, "sent", "a listing read before the decision doesn't undo it");
assert.equal(waitingCount(), 1);
mergeListing("U", [], gen, beginListing());
assert.deepEqual(heldEntries().U.map((e) => e.item.op_id), ["op-a"], "decided here: stays; decided elsewhere: goes");
// two listings out at once, answered out of order: the older one doesn't bring back a send decided elsewhere since
const older = beginListing(), newer = beginListing();
mergeListing("U", [], gen, newer);
mergeListing("U", [held("op-elsewhere")], gen, older);
assert.deepEqual(heldEntries().U.map((e) => e.item.op_id), ["op-a"], "the older listing is dropped");

// deciding stops being offered while a decision is out: its outcome is kept out of sight, and back when it returns
mergeListing("U", [held("op-e"), held("op-f")], gen, beginListing());
assert.ok(startDeciding("op-e"));
keepAccounts([], gen, beginListing());
assert.equal(waitingCount(), 0, "nothing counted where deciding isn't offered");
assert.deepEqual(heldEntries().U.map((e) => [e.item.op_id, e.listed]), [["op-e", false], ["op-a", false]], "the one being decided and the one sent earlier are kept; the rest goes");
setOutcome("U", "op-e", { kind: "sent", text: "Sent" }, gen);
endDeciding("op-e");
mergeListing("U", [held("op-f")], gen, beginListing()); // offered again
assert.deepEqual(heldEntries().U.map((e) => [e.item.op_id, e.outcome?.kind ?? null]), [["op-f", null], ["op-e", "sent"], ["op-a", "sent"]]);
// a listing still out when a newer session withdraws deciding doesn't bring the sends (or the badge) back
const before = beginListing();
keepAccounts([], gen, beginListing());
mergeListing("U", [held("op-g")], gen, before);
assert.equal(waitingCount(), 0, "the older answer is dropped");
assert.ok(!heldEntries().U.some((e) => e.item.op_id === "op-g"));
keepAccounts(["U"], gen, beginListing());
mergeListing("U", [held("op-g")], gen, beginListing());
assert.equal(waitingCount(), 1, "offered again: listed again");
// Forget: nothing kept, and an answer that left before it is dropped
assert.ok(startDeciding("op-c"));
forgetHeld();
assert.deepEqual(heldEntries(), {});
assert.ok(startDeciding("op-c"), "Forget clears what was being decided");
mergeListing("U", [held("op-d")], gen, beginListing());
assert.deepEqual(heldEntries(), {}, "a listing asked before Forget doesn't land");
gen = heldGen(); early = beginListing();
mergeListing("U", [held("op-d")], gen, early);
assert.equal(waitingCount(), 1);
console.log("ok   held sends (T-213): when Send it is offered, what each answer says, the store through listings and Forget");
