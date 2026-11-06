// T-335 Taste Arcade: the app host's pure pieces. Run: node --experimental-strip-types scripts/arcade.test.ts
import assert from "node:assert/strict";
import { arcadeError, journalRef, mediaType } from "../src/arcade/arcadeCore.ts";
import type { Card } from "../src/arcade/kit/engine/src/types.ts";

const ID = "01M6QAF6FYXD39R6BP1TW2TEST";
// a voice answer that reached the vault is named by its note id (the sweep renames its path later)
assert.equal(journalRef({ sent: [ID], error: null }, "Journal/2026/11-05/10-00"), ID);
// several sent at once (older queued entries first): the new one is last
assert.equal(journalRef({ sent: ["01M6QAF6FYXD39R6BP1TW2AAAA", ID], error: null }, "p"), ID);
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
console.log("arcade: ok");
