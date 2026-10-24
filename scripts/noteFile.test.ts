// Run: node --experimental-strip-types scripts/noteFile.test.ts (Node >= 22.6)
import assert from "node:assert/strict";
import { downloadName, isMarkdownNote, markdownFile, MAX_STEM_BYTES, noteRender } from "../src/noteFile.ts";

const bytes = (s: string) => new TextEncoder().encode(s).length;

// File names: forbidden characters and controls go, the title is trimmed, ".md" is added.
assert.equal(downloadName("Plans 10/19: draft?", "01H"), "Plans 1019 draft.md");
assert.equal(downloadName('a\\b*c"d<e>f|g', "01H"), "abcdefg.md");
assert.equal(downloadName("  Tab\there\nnewline\u0007 ", "01H"), "Tab here newline.md");
assert.equal(downloadName("...hidden. ", "01H"), "hidden.md");
assert.equal(downloadName("Garden 🌱 notes 👩‍👩‍👧", "01H"), "Garden 🌱 notes 👩‍👩‍👧.md");
// Nothing usable left: the id, then "note".
assert.equal(downloadName("///", "01HXYZ"), "01HXYZ.md");
assert.equal(downloadName(undefined, "notes/01H:Z"), "notes01HZ.md");
assert.equal(downloadName("?", "/"), "note.md");

// Length is counted in UTF-8 bytes and never splits a character or leaves a dangling joiner.
const long = "長い題名".repeat(40); // 3 bytes each, 480 bytes
const name = downloadName(long, "01H");
assert.ok(bytes(name) <= MAX_STEM_BYTES + 3, `${bytes(name)} bytes`);
assert.ok(long.startsWith(name.slice(0, -3)));
assert.equal(bytes(name.slice(0, -3)), 120);
const family = "a".repeat(MAX_STEM_BYTES - 5) + "👩‍👩‍👧"; // the cut falls after 👩 + joiner
assert.equal(downloadName(family, "01H"), "a".repeat(MAX_STEM_BYTES - 5) + "👩.md");
assert.equal(downloadName("x".repeat(300), "01H"), "x".repeat(MAX_STEM_BYTES) + ".md");

// The file: the note exactly as stored, unless front matter is asked for.
const body = "# Title\r\n\r\nLine with trailing space \nNo final newline";
const dates = { path: "Notes/Plans: 2026 #1", createdAt: "2026-10-01T09:00:00Z", updatedAt: "2026-10-19T21:30:00Z" };
assert.equal(markdownFile(body, dates, false), body);
assert.equal(
  markdownFile(body, dates, true),
  '---\npath: "Notes/Plans: 2026 #1"\ncreated: "2026-10-01T09:00:00Z"\nupdated: "2026-10-19T21:30:00Z"\n---\n' + body,
);
assert.equal(markdownFile(body, { path: "a" }, true), '---\npath: "a"\n---\n' + body);
assert.equal(markdownFile(body, {}, true), body);
// A note with its own front matter: only missing keys are added, inside its block; the rest is untouched.
const fm = "---\ntags: [a]\nupdated: 2026-01-01\n---\n# T\nbody";
assert.equal(markdownFile(fm, dates, true), '---\npath: "Notes/Plans: 2026 #1"\ncreated: "2026-10-01T09:00:00Z"\ntags: [a]\nupdated: 2026-01-01\n---\n# T\nbody');
const crlf = "---\r\ntitle: x\r\n---\r\nbody";
assert.equal(markdownFile(crlf, { path: "p" }, true), '---\r\npath: "p"\r\ntitle: x\r\n---\r\nbody');
// An unclosed fence is not front matter: a block goes before it.
assert.equal(markdownFile("---\nnot closed", { path: "p" }, true), '---\npath: "p"\n---\n---\nnot closed');

// Only markdown notes download as .md.
assert.ok(isMarkdownNote(undefined) && isMarkdownNote("md") && isMarkdownNote(".MD") && isMarkdownNote("mdx"));
assert.ok(!isMarkdownNote("canvas") && !isMarkdownNote("pdf") && !isMarkdownNote("json"));

console.log("noteFile tests passed");

// T-270: a note renders by its own extension, never by a dot in its folder. No extension is markdown; a code extension
// carries its language; an extension the app doesn't know is left to surface-render.
assert.deepEqual(noteRender(undefined), { format: "markdown" });
assert.deepEqual(noteRender(""), { format: "markdown" });
for (const ext of ["md", "MD", ".mdx", "markdown"]) assert.deepEqual(noteRender(ext), { format: "markdown" });
assert.deepEqual(noteRender("csv"), { format: "csv" });
assert.deepEqual(noteRender("json"), { format: "json" });
assert.deepEqual(noteRender("yml"), { format: "yaml" });
assert.deepEqual(noteRender("yaml"), { format: "yaml" });
assert.deepEqual(noteRender("ts"), { format: "code", language: "typescript" });
assert.deepEqual(noteRender(".PY"), { format: "code", language: "python" });
assert.deepEqual(noteRender("xyz"), {});
console.log("noteRender ok");
