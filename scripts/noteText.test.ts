// Run: node --experimental-strip-types scripts/noteText.test.ts (Node >= 22.6)
import assert from "node:assert/strict";
import { bodyWithoutTitle, markFor, noteMeta, noteTitle, restoreTop } from "../src/noteText.ts";

// Title: H1 first, then path leaf, then id.
assert.equal(noteTitle("intro\n# Weekly Review\nbody", "Notes/x", "01H"), "Weekly Review");
assert.equal(noteTitle("no heading", "Projects/Uni App", "01H"), "Uni App");
assert.equal(noteTitle("", undefined, "01HABC"), "01HABC");
assert.equal(noteTitle("## Only h2", "a/", "id"), "a");

// Leading H1 dropped once; later H1s and front matter kept.
assert.equal(bodyWithoutTitle("# Title\n\nFirst para\n# Second"), "First para\n# Second");
assert.equal(bodyWithoutTitle("Para\n# Not leading"), "Para\n# Not leading");
assert.equal(bodyWithoutTitle("---\ntags: [a]\n---\n# T\nbody"), "---\ntags: [a]\n---\nbody");

// Meta line.
assert.equal(noteMeta("uni", "System/Now", undefined), "uni · System/Now");
assert.match(noteMeta("uni", undefined, "2026-09-27T12:00:00Z", "en-US"), /^uni · Updated Sep 2\d, 2026$/);
assert.equal(noteMeta("uni", "p", "not a date"), "uni · p");

// Scroll memory: at the end → reopen at the (new) end; mid-list → same spot, clamped.
assert.deepEqual(markFor(900, 1500, 600), { top: 900, atEnd: true });
assert.deepEqual(markFor(200, 1500, 600), { top: 200, atEnd: false });
assert.equal(restoreTop(undefined, 3000, 600), 2400);
assert.equal(restoreTop({ top: 900, atEnd: true }, 3000, 600), 2400);
assert.equal(restoreTop({ top: 200, atEnd: false }, 3000, 600), 200);
assert.equal(restoreTop({ top: 5000, atEnd: false }, 3000, 600), 2400);
assert.equal(restoreTop(undefined, 300, 600), 0);

console.log("noteText tests passed");
