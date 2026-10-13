// Run: node --experimental-strip-types scripts/reactions.test.ts (Node >= 22.6)
import assert from "node:assert/strict";
import { emojiLabel } from "../src/reactions.ts";

// NIP-25 labels.
assert.equal(emojiLabel("+"), "👍");
assert.equal(emojiLabel(""), "👍");
assert.equal(emojiLabel("-"), "👎");
assert.equal(emojiLabel("🔥"), "🔥");

console.log("reactions tests passed");
