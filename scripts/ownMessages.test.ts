// Run: node --experimental-strip-types scripts/ownMessages.test.ts
import assert from "node:assert/strict";
import { DELETE_CONFIRM_MS, editOutcome, editorKeyAction, lastOwnMessage } from "../src/ownMessages.ts";

// Enter saves, Shift+Enter is a newline, Esc cancels, IME composition is ignored.
assert.equal(editorKeyAction("Enter", false, false), "save");
assert.equal(editorKeyAction("Enter", true, false), null);
assert.equal(editorKeyAction("Escape", false, false), "cancel");
assert.equal(editorKeyAction("Enter", false, true), null);
assert.equal(editorKeyAction("a", false, false), null);

// Trimmed comparison; empty never publishes.
assert.equal(editOutcome("hi", "hi  "), "unchanged");
assert.equal(editOutcome("hi", "   "), "empty");
assert.equal(editOutcome("hi", "hi there"), "publish");

// Newest own message wins; none when not signed in or never posted.
const list = [{ ref: "1", author: "me" }, { ref: "2", author: "you" }, { ref: "3", author: "me" }, { ref: "4", author: "you" }];
assert.equal(lastOwnMessage(list, "me")?.ref, "3");
assert.equal(lastOwnMessage(list, "them"), null);
assert.equal(lastOwnMessage(list, null), null);
assert.equal(lastOwnMessage([], "me"), null);

assert.equal(DELETE_CONFIRM_MS, 4000);
console.log("ownMessages: ok");
