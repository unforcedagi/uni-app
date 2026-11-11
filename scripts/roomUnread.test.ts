// T-335: a room row's unread words and its short count (src/areas/roomUnread.ts).
// Run: node --experimental-strip-types scripts/roomUnread.test.ts
import assert from "node:assert/strict";
import { unreadShort, unreadWords } from "../src/areas/roomUnread.ts";

assert.equal(unreadWords({ n: 1, mention: false }), "1 new");
assert.equal(unreadWords({ n: 4, mention: true }), "4 new, mentions you");
assert.equal(unreadShort(7), "7");
assert.equal(unreadShort(99), "99");
assert.equal(unreadShort(140), "99+");
console.log("roomUnread: all passed");
