import assert from "node:assert/strict";
import { beginEdit, changeEdit, draftKey, editableExtension, failedSave, isDirty, savedEdit, serializeDraft, validateNotePath } from "../src/noteEdit.ts";
const base = beginEdit("old", "t1", null);
assert.equal(isDirty(base), false);
assert.equal(serializeDraft(base), null);
const draft = changeEdit(base, "mine");
const raw = serializeDraft(draft)!;
assert.ok(isDirty(draft));
assert.equal(draftKey("v", "id"), "uni.noteDraft.v1:v:id");
assert.deepEqual(beginEdit("old", "t1", raw), { ...draft, restored: true });
const restored = beginEdit("theirs", "t2", raw);
assert.equal(restored.updatedAt, "t1"); // never silently rebase a draft
assert.equal(restored.content, "mine");
assert.ok(restored.conflict);
assert.equal(beginEdit("mine", "t2", raw).restored, false); // save succeeded but response was lost
assert.equal(beginEdit("old", "t1", "bad").restored, false);
assert.equal(beginEdit("old", "t1", '{"content":"x"}').restored, false);
assert.equal(failedSave(draft, "conflict: updated_at").content, "mine");
assert.ok(failedSave(draft, "conflict: updated_at").conflict);
assert.equal(failedSave(draft, "offline").conflict, false);
assert.equal(serializeDraft(savedEdit("mine", "t2")), null);
assert.equal(isDirty(changeEdit(draft, "old")), false);
assert.ok(editableExtension("mdx"));
assert.ok(editableExtension(".YAML"));
assert.equal(editableExtension("png"), false);
for (const path of ["", "   ", "/root", "a/../b", "a//b", "a/", "a\0b", "é".repeat(257)]) assert.ok(validateNotePath(path), path);
for (const path of ["Probe/note", "é".repeat(256), "a..b", "a.md"]) assert.equal(validateNotePath(path), null);
console.log("noteEdit tests passed");
