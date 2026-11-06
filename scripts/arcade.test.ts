// T-335 Taste Arcade: the app host's pure pieces. Run: node --experimental-strip-types scripts/arcade.test.ts
import assert from "node:assert/strict";
import { arcadeError, journalRef, mediaType, typedAnswer } from "../src/arcade/arcadeCore.ts";
import type { Card, Reaction } from "../src/arcade/kit/engine/src/types.ts";

const ID = "01M6QAF6FYXD39R6BP1TW2TEST";
// a voice answer that reached the vault is named by its note id (the sweep renames its path later)
assert.equal(journalRef({ sent: [ID], error: null }, "Journal/2026/11-05/10-00"), ID);
// several sent at once, or more still waiting: which one is ours can't be told, so the path
assert.equal(journalRef({ sent: ["01M6QAF6FYXD39R6BP1TW2AAAA", ID], error: null }, "p"), "p");
assert.equal(journalRef({ sent: [ID], remaining: 1, error: null }, "p"), "p");
// still queued on the device, or a failure: the path it was filed under
assert.equal(journalRef({ sent: [], error: null }, "Journal/2026/11-05/10-00"), "Journal/2026/11-05/10-00");
assert.equal(journalRef({ sent: [ID], error: "offline" }, "Journal/x"), "Journal/x");
assert.equal(journalRef({ sent: ["not-an-id"], error: null }, "Journal/x"), "Journal/x");

const card = (media: Card["media"]): Card => ({ id: "c", kind: "sound", domain: "sound", title: "t", features: [], source: "t", media });
assert.equal(mediaType(card({ src: "a.mp3", mime: "audio/mpeg" }), "src"), "audio/mpeg");
assert.equal(mediaType(card({ src: "a.mp4" }), "src"), "video/mp4");
assert.equal(mediaType(card({ src: "a.mp4", poster: "a.webp" }), "poster"), "image/webp");
// never a type that runs script in the app's origin
assert.equal(mediaType(card({ src: "a.svg" }), "src"), "application/octet-stream");
assert.equal(mediaType(card({ src: "a.html", mime: "text/html" }), "src"), "application/octet-stream");
assert.equal(mediaType(card({ src: "x", mime: "image/svg+xml" }), "src"), "application/octet-stream");

assert.match(arcadeError({ kind: "unreachable", message: "x" }), /tailnet/);
assert.match(arcadeError({ kind: "refused", status: 400, message: "words too long" }), /words too long/);
assert.equal(arcadeError("plain"), "plain");
// words held back as a duplicate: nothing new was sent, so the last id is someone else's entry
assert.equal(journalRef({ sent: [ID], error: null, duplicate: { kind: "saved", id: "x", created_at: "" } }, "Journal/x"), "Journal/x");

// a typed Ripple answer reaches the door as where it landed, never its words
const typed: Reaction = { id: "r1", at: "2026-11-05T10:00:00Z", game: "ripple", kind: "words", card: "q1", words: " made-up answer " };
const refs = new Map([["q1\nmade-up answer", ID]]);
assert.deepEqual(typedAnswer(typed, refs), { id: "r1", at: "2026-11-05T10:00:00Z", game: "ripple", kind: "voice", card: "q1", voice: { ref: ID } });
assert.equal(typedAnswer(typed, new Map()), null, "no known entry: not sent, so the words never reach the door");
const pick: Reaction = { id: "r2", at: "2026-11-05T10:00:00Z", game: "gallery", kind: "pin", card: "c", words: "kept" };
assert.equal(typedAnswer(pick, refs), pick);
console.log("arcade: ok");
