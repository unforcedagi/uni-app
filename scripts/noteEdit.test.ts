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


assert.ok(editableExtension(undefined));
for (const path of ["a/./b", " a/b", "a/b ", "a/ b", "a\\b", "a\tb", "a\nb", "a\x7fb", "a/\u00a0b", "a/\ufeffb"]) assert.ok(validateNotePath(path), path);
import { resolveNote, tabHasDraft } from "../src/noteIdentity.ts";
const ref = (name: string) => ({ hub: null, vault: "v", ref: name });
const aliases = { [JSON.stringify(["v", "path"])]: "id" };
const read = (vault: string, id: string) => vault === "v" && id === "id" ? raw : null;
assert.equal(resolveNote(ref("path"), aliases).ref, "id");
assert.ok(tabHasDraft(ref("path"), [], aliases, read)); // restart, persisted path
assert.ok(tabHasDraft(ref("other"), [ref("path"), ref("top")], aliases, read));
assert.ok(tabHasDraft(ref("other"), [ref("top"), ref("path")], aliases, read));
assert.equal(tabHasDraft(ref("other"), [], aliases, read), false);
import { cachedPaths, loadPaths, invalidatePaths } from "../src/vaultPaths.ts";
let calls = 0;
const fetch = async () => { calls++; return [{ id: "id", path: null }]; };
await Promise.all([loadPaths("v", fetch), loadPaths("v", fetch)]);
await loadPaths("v", fetch);
assert.equal(calls, 1);
assert.equal(cachedPaths("v")?.length, 1);
invalidatePaths("v");
await loadPaths("v", fetch);
assert.equal(calls, 2);


import { draftWriter, readDraft, settleDraft, forgetDrafts } from "../src/noteDrafts.ts";
const disk = new Map<string, string>();
let writes = 0;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => disk.get(key) ?? null,
  setItem: (key: string, value: string) => { writes++; disk.set(key, value); },
  removeItem: (key: string) => { disk.delete(key); },
} });
const writer = draftWriter(draftKey("v", "id"), () => assert.fail("storage failed"));
writer.write("first");
writer.write("second");
assert.equal(readDraft("v", "id"), "second");
assert.equal(writes, 0);
await new Promise((resolve) => setTimeout(resolve, 350));
assert.equal(writes, 1);
assert.equal(disk.get(draftKey("v", "id")), "second");
writer.write("newer");
assert.equal(settleDraft("v", "id", "second"), true); // late save retains newer work
writer.flush(); // blur / unmount / save / beforeunload all use this flush
assert.equal(disk.get(draftKey("v", "id")), "newer");
assert.equal(settleDraft("v", "id", "newer"), false);
assert.equal(settleDraft("v", "id", "second"), false); // newer draft already saved
assert.equal(readDraft("v", "id"), null);
writer.write("forgotten");
forgetDrafts();
writer.flush();
assert.equal(disk.has(draftKey("v", "id")), false);


import { sameTarget } from "../src/tabs.ts";
assert.ok(sameTarget({ kind: "note", title: "path", note: resolveNote(ref("path"), aliases) }, { kind: "note", title: "id", note: ref("id") }));
console.log("noteEdit tests passed");
