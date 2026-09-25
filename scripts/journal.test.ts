// Run: node --experimental-strip-types scripts/journal.test.ts
import assert from "node:assert/strict";
import { entryPath, entryText, mmss, newDraft, pickAudioMime, shareText, TRANSCRIPT_PENDING } from "../src/journal.ts";

const d = new Date(2026, 8, 5, 7, 3, 9);
assert.equal(entryPath(d), "Notes/2026/09-05/07-03-09");
const draft = newDraft("hi", "text", d, "id-1");
assert.deepEqual([draft.entry_id, draft.path, draft.source], ["id-1", "Notes/2026/09-05/07-03-09", "text"]);
assert.equal(draft.created_at, d.toISOString());

assert.equal(entryText(`note\n\n${TRANSCRIPT_PENDING}`), "note");
assert.equal(entryText(TRANSCRIPT_PENDING), "");

assert.equal(pickAudioMime((t) => t === "audio/webm"), "audio/webm");
assert.equal(pickAudioMime((t) => t === "audio/mp4"), "audio/mp4");
assert.equal(pickAudioMime(() => false), "");

const note = { path: "Notes/2026/09-05/07-03-09", content: "line one\n\nline two", created_at: d.toISOString() };
const toUni = shareText(note, "unforced", "Uni");
assert.ok(toUni.startsWith("@Uni here's a journal entry"));
assert.ok(toUni.includes("> line one\n>\n> line two"));
assert.ok(toUni.includes("vault unforced: Notes/2026/09-05/07-03-09"));
assert.ok(shareText(note, "unforced", "Uni", "what do you notice?").startsWith("@Uni what do you notice?"));
const plain = shareText(note, "unforced", null);
assert.ok(plain.startsWith("> line one") && !plain.includes("@"));
assert.ok(shareText({ ...note, content: "x".repeat(3000) }, "v", null).includes("x …"));

assert.equal(mmss(0), "0:00");
assert.equal(mmss(75.9), "1:15");
console.log("journal ok");
