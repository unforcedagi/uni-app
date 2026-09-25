// Run: node --experimental-strip-types scripts/uniActions.test.ts
import assert from "node:assert/strict";
import { findUniMember, findUniRoom, handoffText, messageLink, quote, searchHandoffText } from "../src/uniActions.ts";
import { occurrences } from "../src/mentions.ts";

const ch = "5b1c0a8e-0000-4000-8000-000000000001";
const id = "ab".repeat(32);
assert.equal(messageLink(ch, id), `buzz://message?channel=${ch}&id=${id}`);

assert.equal(quote("a\n\nb"), "> a\n>\n> b");
const long = quote("x".repeat(2000));
assert.ok(long.endsWith(" …") && [...long].length < 1300);
// Truncation never splits a surrogate pair.
assert.ok(!quote("🔥".repeat(1300)).includes("\uFFFD"));

const m = { ref: id, channel: ch, author_name: "Kai", ts: 1790000000, body: "relay wake-ups need an FCM proxy" };
const note = handoffText("note", m, "parachute", "Uni");
assert.ok(note.startsWith("@Uni keep this as a note"));
assert.ok(note.includes("> relay wake-ups need an FCM proxy"));
assert.ok(note.includes(`— Kai in #parachute`));
assert.ok(note.includes(messageLink(ch, id)));
// The mention is a real, bindable @label occurrence (so it gets p-tagged).
assert.deepEqual(occurrences(note, ["Uni"]).map((o) => o.label), ["Uni"]);

assert.ok(handoffText("ask", m, "parachute", "Uni", "what should I do with this?").startsWith("@Uni what should I do with this?"));
assert.ok(handoffText("ask", m, "parachute", "Uni", "   ").startsWith("@Uni let's talk about this."));

assert.equal(findUniRoom([{ id: "1", name: "general" }, { id: "2", name: " UNI " }])?.id, "2");
assert.equal(findUniRoom([{ id: "1", name: "university" }]), undefined);
assert.equal(findUniMember([{ pubkey: "p1", name: "Aaronji" }, { pubkey: "p2", name: "Uni" }])?.pubkey, "p2");

// Notes search handoff: one line, bindable mention, truncated.
assert.equal(searchHandoffText("  push\n\nnotifications  ", "Uni"), "@Uni search my notes for: push notifications");
assert.deepEqual(occurrences(searchHandoffText("x", "Uni"), ["Uni"]).map((o) => o.label), ["Uni"]);
const longQ = searchHandoffText("y".repeat(900), "Uni");
assert.ok(longQ.endsWith(" …") && [...longQ].length < 540);
assert.ok(!searchHandoffText("🔥".repeat(600), "Uni").includes("\uFFFD"));

console.log("uniActions tests passed");
