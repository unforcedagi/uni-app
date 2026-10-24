// Run: node --experimental-strip-types scripts/journal.test.ts
import assert from "node:assert/strict";
import { areaRooms, entryText, legacyEntryPath, mmss, newDraft, pickAudioMime, sameWordsLine, shareText, TRANSCRIPT_PENDING } from "../src/journalCore.ts";

const d = new Date(2026, 8, 5, 7, 3, 9);
// 0.1.46: filed under Journal/ by its first words (scripts/journalPaths.test.ts has the sweep's cases); Notes/ is the old shape
assert.equal(legacyEntryPath(d), "Notes/2026/09-05/07-03-09");
const draft = newDraft("hi", "text", d, "id-1");
assert.deepEqual([draft.entry_id, draft.path, draft.source], ["id-1", "Journal/2026/09-05/07-03 hi", "text"]);
assert.equal(draft.created_at, d.toISOString());
// 0.1.46 fix (P2): every composer send has its own submission id besides the entry id (a retry reuses the draft, so both stay)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const a = newDraft("hi", "text", d), b = newDraft("hi", "text", d);
assert.match(a.submission_id, uuid);
assert.notEqual(a.submission_id, b.submission_id);
assert.notEqual(a.submission_id, a.entry_id);
assert.equal(newDraft("hi", "text", d, "id-1", "send-1").submission_id, "send-1");
assert.match(sameWordsLine({ kind: "waiting", id: "q1", created_at: new Date(2026, 9, 14, 19, 43).toISOString() }), /^Same words as your 7:43\sPM entry$|^Same words as your 19:43 entry$/);
assert.equal(sameWordsLine({ kind: "saved", id: "n1", created_at: "" }), "Same words as your earlier entry");

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
const hub = "https://uni-1.example.ts.net/";
const url = "https://uni-1.example.ts.net/surface/parachute/v/unforced/n/01M33NQB9BK6543P4SEJ2WKFMS";
const linked = shareText(note, "unforced", "Uni", "", hub);
assert.ok(linked.startsWith("@Uni here's a journal entry") && linked.endsWith(url), linked);
assert.ok(!linked.includes("line one"));
const linkedPlain = shareText(note, "unforced", null, "", hub);
assert.ok(linkedPlain.startsWith("Journal entry · ") && linkedPlain.endsWith(url) && !linkedPlain.includes("line one"));

assert.equal(mmss(0), "0:00");
assert.equal(mmss(75.9), "1:15");

// T-263: only rooms known to be rooms, never a DM, a room of unknown kind (null, or absent in an older app's cached list), or #Uni
{
  const rooms = [
    { id: "u", name: "Uni", dm: false }, { id: "g", name: "garden", dm: false }, { id: "d", name: "DM", dm: true },
    { id: "n", name: "porch", dm: null }, { id: "o", name: "attic" }, { id: "b", name: "Bakery", dm: false },
  ];
  assert.deepEqual(areaRooms(rooms, "u").map((r) => r.id), ["b", "g"]);
  // a DM that findUniRoom took for #Uni: #Uni is still not an area room
  assert.deepEqual(areaRooms([...rooms, { id: "x", name: "Uni", dm: true }], "x").map((r) => r.id), ["b", "g"]);
}

console.log("journal ok");
