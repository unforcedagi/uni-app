// Run: node --experimental-strip-types scripts/uniActions.test.ts
import assert from "node:assert/strict";
import { findUniMember, findUniRoom, quote, searchHandoffText } from "../src/uniActions.ts";
import { occurrences } from "../src/mentions.ts";

assert.equal(quote("a\n\nb"), "> a\n>\n> b");
const long = quote("x".repeat(2000));
assert.ok(long.endsWith(" …") && [...long].length < 1300);
// Truncation never splits a surrogate pair.
assert.ok(!quote("🔥".repeat(1300)).includes("\uFFFD"));

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
