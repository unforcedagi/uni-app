// Run: node --experimental-strip-types scripts/journal.test.ts
import assert from "node:assert/strict";
import { entryPath, entryText, entryTitle, mmss, newDraft, pickAudioMime, shareText, TRANSCRIPT_PENDING } from "../src/journalCore.ts";

const d = new Date(2026, 8, 5, 7, 3, 9);
assert.equal(entryPath(d), "Journal/2026/09/2026-09-05 0703");
const draft = newDraft("hi", "text", d, "id-1");
assert.deepEqual([draft.entry_id, draft.path, draft.source], ["id-1", "Journal/2026/09/2026-09-05 0703 hi", "text"]);
// Voice entries carry only the placeholder: no title until uni-1's sweep adds one.
assert.equal(newDraft(TRANSCRIPT_PENDING, "voice", d, "v").path, "Journal/2026/09/2026-09-05 0703");
assert.equal(entryTitle("One two three four five six seven eight nine"), "One two three four five six seven");
assert.equal(entryTitle("## Morning: **sat** with [the chant](https://x.y/z) at www.a.b/c today!"), "Morning sat with the chant at today");
assert.equal(entryTitle("What? a/b [c] #d |e *f \"g\" <h> ^i {j} `k` ~l \\m"), "What a b c d e f"); // 7-word cap
assert.equal(entryTitle("See https://example.com/long/url ok..."), "See ok");
assert.equal(entryTitle("[[Areas/Sadhana|sadhana]] notes, —"), "sadhana notes");
assert.ok(entryTitle("Supercalifragilisticexpialidocious ".repeat(5)).length <= 60);
assert.equal(entryTitle(""), "");
assert.equal(draft.created_at, d.toISOString());

assert.equal(entryText(`note\n\n${TRANSCRIPT_PENDING}`), "note");
assert.equal(entryText(TRANSCRIPT_PENDING), "");

assert.equal(pickAudioMime((t) => t === "audio/webm"), "audio/webm");
assert.equal(pickAudioMime((t) => t === "audio/mp4"), "audio/mp4");
assert.equal(pickAudioMime(() => false), "");

const note = { id: "01M33NQB9BK6543P4SEJ2WKFMS", path: "Notes/2026/09-05/07-03-09", content: "line one\n\nline two", created_at: d.toISOString() };
const toUni = shareText(note, "unforced", "Uni");
assert.ok(toUni.startsWith("@Uni here's a journal entry"));
assert.ok(toUni.includes("> line one\n>\n> line two"));
assert.ok(toUni.includes("vault unforced: Notes/2026/09-05/07-03-09"));
assert.ok(shareText(note, "unforced", "Uni", "what do you notice?").startsWith("@Uni what do you notice?"));
const plain = shareText(note, "unforced", null);
assert.ok(plain.startsWith("> line one") && !plain.includes("@"));
assert.ok(shareText({ ...note, content: "x".repeat(3000) }, "v", null).includes("x …"));
// With a hub, a share is the canonical note URL, never the entry's text.
const hub = "https://uni-1.taildf9ce2.ts.net/";
const url = "https://uni-1.taildf9ce2.ts.net/surface/parachute/v/unforced/n/01M33NQB9BK6543P4SEJ2WKFMS";
const linked = shareText(note, "unforced", "Uni", "", hub);
assert.ok(linked.startsWith("@Uni here's a journal entry") && linked.endsWith(url), linked);
assert.ok(!linked.includes("line one"));
const linkedPlain = shareText(note, "unforced", null, "", hub);
assert.ok(linkedPlain.startsWith("Journal entry · ") && linkedPlain.endsWith(url) && !linkedPlain.includes("line one"));

assert.equal(mmss(0), "0:00");
assert.equal(mmss(75.9), "1:15");
console.log("journal ok");
