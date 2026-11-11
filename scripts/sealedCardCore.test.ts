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
assert.ok(whenText(noon - 20 * 3600, noon).startsWith("yesterday "), "a past end isn't tomorrow");

// The room doesn't say the reach twice: the card opens with it. An older card's line stays.
const reachCard = "🔑 **🔴 All of A · 10 min**\nFor: job.cloudflare. Can: x.\n\n```uni-sealed-approval\n{}\n```";
assert.equal(sealedProse(reachCard), "");
assert.equal(sealedProse(reachCard.replace("🔴", "🟢")), "");
assert.equal(sealedProse(reachCard.replace("🔴", "🟡")), "");
assert.equal(sealedProse("🔑 **Uni asks to use x** (powerful)\n\n```uni-sealed-approval\n{}\n```"), "🔑 **Uni asks to use x** (powerful)");

// Needs you says the reach too, when the card has one.
assert.equal(waitingTitle({ kind: "single", credential: "c", action: "a", rows: 1, reach: "🔴 All of A · 10 min" }), "🔴 All of A · 10 min");
assert.equal(waitingTitle({ kind: "single", credential: "c", action: "a", rows: 1, reach: null }), "c · a");

console.log("sealedCardCore ok");

// ── T-335 cards expand: what a card asks, and where an ask's card stands ──
{
  const { accountOf, askingOf, cardIs, cardState, staleLine, repostBody } = await import("../src/sealedCardCore.ts");
  const reach = "🔴 Open Site (site.example) — PRODUCTION account · changes what the public reaches · 10 min";
  assert.deepEqual(accountOf(reach), { account: "Open Site (site.example)", production: true });
  assert.deepEqual(accountOf("🟡 Site Staging (no production) · one thing · 10 min"), { account: "Site Staging", production: false });
  assert.equal(accountOf("dns-zone · dns.edit"), null);
  assert.equal(accountOf(null), null);

  const now = 1_900_000_000;
  const worded = { rid: "r", action: "job.cloudflare", credential: "cf-prod", class: "powerful" as const, ttl_s: 600, uses: 1, payload: { purpose: "Deploy the import tool" },
    request_digest: "ab".repeat(32), expires: now + 600, answer: null, asked: now - 3 * 3600, reach,
    scope: `${reach}\nCan: deploy Workers scripts on site.example.\nUni says: Deploy the import tool` };
  const a = askingOf(worded, { room: "dev", now });
  assert.equal(a.approve, "Uni gets a key for 10 min (1 use). It can deploy Workers scripts on site.example.");
  assert.equal(a.touches, "PRODUCTION · Open Site (site.example)");
  assert.match(a.asked, /^Uni · in #dev · .* \(asked 3 h ago\)$/);
  assert.equal(a.why, "Deploy the import tool");
  // an ask that points at the card: its T-number, its line and its why-now
  const b = askingOf(worded, { room: "dev", now, ask: { tid: "T-12", what: "Deploy the import tool", why: "Staging passed; the box closes Friday" } });
  assert.match(b.asked, / · for T-12: Deploy the import tool$/);
  assert.equal(b.why, "Staging passed; the box closes Friday");
  // a card the broker didn't word: what it opens, and that production isn't stated
  const plain = { ...worded, action: "dns.edit", credential: "dns-zone", reach: null, scope: "Add an A record for demo.example.org", payload: null, asked: undefined };
  const c = askingOf(plain, { room: null, now });
  assert.equal(c.approve, "Uni opens dns-zone for dns.edit, 10 min and 1 use: Add an A record for demo.example.org.");
  assert.equal(c.touches, "dns-zone · the card doesn't say whether it is production");
  assert.equal(c.asked, "Uni");
  assert.equal(c.why, null);

  const ref = "ab12cd34ef56" + "9".repeat(52);
  assert.ok(cardIs("AB12CD34EF56", ref));
  assert.ok(!cardIs("ab12cd", ref), "a short prefix never matches");
  assert.ok(!cardIs(null, ref));

  const fenced = "🔑 x\n\n```uni-sealed-approval\n{}\n```";
  const msg = { channel: "c", ref, body: fenced };
  const view = (rows: unknown[], refused: string | null = null) => ({ kind: "single" as const, event_id: ref, refused, rows: rows as never[] });
  assert.deepEqual(cardState(null, null, now), { state: "missing" });
  assert.deepEqual(cardState(msg, null, now), { state: "checking" });
  assert.equal(cardState({ ...msg, body: "✓ Approved 14:05 · Open Site" }, null, now).state, "ended");
  assert.equal(cardState(msg, view([], "This card has expired."), now).state, "expired");
  assert.equal(cardState(msg, view([], "Not signed by Uni."), now).state, "refused");
  assert.deepEqual(cardState(msg, view([worded]), now), { state: "waiting", channel: "c", ref, expires: now + 600 });
  assert.deepEqual(cardState(msg, view([worded]), now + 600), { state: "expired", channel: "c", ref, at: now + 600 });
  assert.equal(cardState(msg, view([{ ...worded, answer: { decision: "deny", at: now, until: null, sent: true } }]), now).state, "answered");

  const clock = () => "14:05";
  assert.equal(staleLine({ state: "waiting", channel: "c", ref, expires: now }, clock), null);
  assert.equal(staleLine({ state: "expired", channel: "c", ref, at: now }, clock), "Its card expired at 14:05: nothing was sent");
  assert.equal(staleLine({ state: "ended", channel: "c", ref, line: "🔑 ✓ Approved 14:05" }, clock), "Its card has ended: ✓ Approved 14:05");
  assert.match(repostBody({ tid: "T-12", what: "x", fp: "ab12 cd34", why: "it expired" }), /^T-12: the approval card ab12 cd34 no longer waits \(it expired\)\. If it's still needed, post a fresh card and point T-12 at it/);
  assert.match(repostBody({ tid: null, what: null, fp: null, why: "it expired" }), /^The approval card no longer waits/);
}
console.log("sealedCardCore T-335 cards expand: ok");
