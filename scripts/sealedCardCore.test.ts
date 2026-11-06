// T-234: the card's pure helpers (src/sealedCardCore.ts). The checks themselves are Rust's (uni-core sealed_card.rs).
import assert from "node:assert/strict";
import { ageText, needsHold, reachLine, tapOnly, whenText, childToken, payloadEntries, plainError, releasesLine, sealedFence, sealedProse, shortText, span, waitingTitle, windowText } from "../src/sealedCardCore.ts";

const card = "🔑 **Uni asks to use dns-zone** (powerful)\nFor: dns.edit. Add an A record\nOpen this in the Uni app.\n\n```uni-sealed-approval\n{\n \"v\": 1\n}\n```";
assert.equal(sealedFence(card), "single");
assert.equal(sealedFence(card.replace("uni-sealed-approval", "uni-sealed-morning")), "morning");
assert.equal(sealedFence("a message about ```uni-sealed-approval``` inline"), null);
assert.equal(sealedProse(card), "🔑 **Uni asks to use dns-zone** (powerful)");

// CARD.md §4 windows: seconds under 2 minutes, minutes under 2 hours, hours above; always the uses
assert.deepEqual([span(60), span(119), span(120), span(600), span(7199), span(7200), span(50400), span(5400 * 3)], ["60 s", "119 s", "2 min", "10 min", "119 min", "2 h", "14 h", "4.5 h"]);
assert.equal(windowText(600, 1), "10 min, 1 use");
assert.equal(windowText(50400, 200), "14 h, 200 uses");

// payload: top-level keys, text only, long values cut, a permanent child named
const entries = payloadEntries({ name: "demo", note: "<b>https://example.org/" + "x".repeat(80) + "</b>", child_ttl_s: null, n: 3, nested: { a: [1] } });
assert.deepEqual(entries.map((e) => e.key), ["name", "note", "child_ttl_s", "n", "nested"]);
assert.equal(entries[2].text, "permanent");
assert.equal(entries[4].text, '{"a":[1]}');
assert.equal(entries[1].long, true);
assert.equal([...shortText(entries[1].text)].length, 64);
assert.deepEqual(payloadEntries(null), []);
assert.deepEqual(payloadEntries([1, 2]), [{ key: "", text: "[1,2]", long: false }]);

// a mint's child: permanent or short-lived; anything else isn't a mint
assert.deepEqual(childToken({ action: "mint.cloudflare", payload: { child_ttl_s: null } }), { permanent: true, ttl: null });
assert.deepEqual(childToken({ action: "mint.cloudflare", payload: { child_ttl_s: 3600 } }), { permanent: false, ttl: 3600 });
assert.equal(childToken({ action: "dns.edit", payload: { child_ttl_s: null } }), null);

// P5: from the checked fields only, and only for powerful
assert.equal(releasesLine({ class: "powerful", credential: "cf-parent", ttl_s: 600 }),
  "Approving opens cf-parent itself on uni for up to 10 min. Uni is trusted to do only what's shown. If uni were compromised, this would hand over all of cf-parent.");
assert.equal(releasesLine({ class: "routine", credential: "r2", ttl_s: 600 }), null);

assert.equal(plainError("invalid: This card has expired."), "This card has expired.");
assert.equal(plainError(undefined), "it couldn't be sent");
assert.equal(waitingTitle({ kind: "single", credential: "dns-zone", action: "dns.edit", rows: 1 }), "dns-zone · dns.edit");
assert.equal(waitingTitle({ kind: "morning", credential: null, action: null, rows: 3 }), "Morning card · 3 routine credentials");
// Only the broker's own cards have a reach line, and only their first line is it (Rust gives it; this is for the row's words).
assert.equal(reachLine({ reach: "🔴 All of A · 10 min" }), "🔴 All of A · 10 min");
assert.equal(reachLine({ reach: null }), null);
assert.equal(reachLine({}), null, "an older app build's view has none");

// A small key on a powerful credential needs only a tap inside the grace; anything else keeps the hold and the unlock.
assert.equal(tapOnly([{ class: "powerful", always_unlock: false }]), true);
assert.equal(tapOnly([{ class: "powerful", always_unlock: true }]), false);
assert.equal(tapOnly([{ class: "routine", always_unlock: false }]), true);
assert.equal(tapOnly([{ class: "routine", always_unlock: true }]), false);
assert.equal(tapOnly([{ class: "powerful" }]), false, "not said: it asks");
assert.equal(tapOnly([]), false);
assert.equal(needsHold({ class: "powerful", always_unlock: true }), true);
assert.equal(needsHold({ class: "powerful" }), true, "not said: the hold stays");
assert.equal(needsHold({ class: "powerful", always_unlock: false }), false);
assert.equal(needsHold({ class: "routine", always_unlock: true }), false);

// The job's age: nothing while it's as fresh as a card could always be, then in plain words.
const T = 1_800_000_000;
assert.equal(ageText(T, T), null);
assert.equal(ageText(T + 899, T), null);
assert.equal(ageText(T + 900, T), "asked 15 min ago");
assert.equal(ageText(T + 7199, T), "asked 119 min ago");
assert.equal(ageText(T + 7200, T), "asked 2 h ago");
assert.equal(ageText(T + 23 * 3600, T), "asked 23 h ago");
assert.equal(ageText(T + 900), null, "an older view has no time");

// A card can be open past midnight: its time says which day.
const noon = new Date(2030, 5, 10, 12, 0).getTime() / 1000;
assert.ok(!whenText(noon + 3600, noon).includes("tomorrow"));
assert.ok(whenText(noon + 20 * 3600, noon).startsWith("tomorrow "));

console.log("sealedCardCore ok");
