// Run: node --experimental-strip-types scripts/reactions.test.ts (Node >= 22.6)
import assert from "node:assert/strict";
import { emojiLabel, toggleLocal, type Reaction } from "../src/reactions.ts";

// NIP-25 labels.
assert.equal(emojiLabel("+"), "👍");
assert.equal(emojiLabel(""), "👍");
assert.equal(emojiLabel("-"), "👎");
assert.equal(emojiLabel("🔥"), "🔥");

const rs: Reaction[] = [{ emoji: "+", count: 2, mine: null }, { emoji: "🔥", count: 1, mine: "ev1" }];

// Adding to an existing group matches by label ("+" and "👍" are one group).
assert.deepEqual(toggleLocal(rs, "👍", false)[0], { emoji: "+", count: 3, mine: "pending" });
// Adding a new emoji appends a pending group.
assert.deepEqual(toggleLocal(rs, "🙏", false).at(-1), { emoji: "🙏", count: 1, mine: "pending" });
// Removing the last one drops the group; removing one of many decrements.
assert.deepEqual(toggleLocal(rs, "🔥", true), [rs[0]]);
assert.deepEqual(toggleLocal(rs, "+", true)[0], { emoji: "+", count: 1, mine: null });
// Removing something absent is a no-op (same array).
assert.equal(toggleLocal(rs, "😂", true), rs);
// Input is never mutated.
assert.deepEqual(rs, [{ emoji: "+", count: 2, mine: null }, { emoji: "🔥", count: 1, mine: "ev1" }]);

console.log("reactions tests passed");
