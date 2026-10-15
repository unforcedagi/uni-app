// 0.1.46: the app files a journal entry where the server's T-60 sweep (~/scripts/t60_journal_sweep.py) would, so the sweep never moves it.
// Expected values below were produced by calling the sweep's own `first_words` and `target_path` on these invented samples.
// Run: node --experimental-strip-types scripts/journalPaths.test.ts
import assert from "node:assert/strict";
import { entryPaths, firstWords, legacyEntryPath, newDraft, TRANSCRIPT_PENDING } from "../src/journalCore.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

type Case = { content: string; w7: string; w12: string; w20: string; w40: string; target: string | [string, string] | null; vtarget: string | [string, string] | null };
const SWEEP: Case[] = [
 {
  "content": "Woke up early and walked the dog along the creek before coffee.",
  "w7": "Woke up early and walked the dog",
  "w12": "Woke up early and walked the dog along the creek before coffee",
  "w20": "Woke up early and walked the dog along the creek before coffee",
  "w40": "Woke up early and walked the dog along the creek before coffee",
  "target": [
   "Journal/2026/10-14/19-43 Woke up early and walked the dog",
   "10"
  ],
  "vtarget": [
   "Journal/2026/10-14/19-43 Woke up early and walked the dog",
   "10"
  ]
 },
 {
  "content": "# Heading here\n\n- **Bold** item with [a link](https://x.y) and [[Some/Note|alias]] ok",
  "w7": "Heading here Bold item with a link",
  "w12": "Heading here Bold item with a link and alias ok",
  "w20": "Heading here Bold item with a link and alias ok",
  "w40": "Heading here Bold item with a link and alias ok",
  "target": [
   "Journal/2026/10-14/19-43 Heading here Bold item with a link",
   "10"
  ],
  "vtarget": [
   "Journal/2026/10-14/19-43 Heading here Bold item with a link",
   "10"
  ]
 },
 {
  "content": "https://example.com/x Morning thoughts: quiet / calm? yes",
  "w7": "Morning thoughts quiet calm yes",
  "w12": "Morning thoughts quiet calm yes",
  "w20": "Morning thoughts quiet calm yes",
  "w40": "Morning thoughts quiet calm yes",
  "target": [
   "Journal/2026/10-14/19-43 Morning thoughts quiet calm yes",
   "10"
  ],
  "vtarget": [
   "Journal/2026/10-14/19-43 Morning thoughts quiet calm yes",
   "10"
  ]
 },
 {
  "content": "Supercalifragilisticexpialidocious antidisestablishmentarianism pneumonoultramicroscopic words here",
  "w7": "Supercalifragilisticexpialidocious",
  "w12": "Supercalifragilisticexpialidocious antidisestablishmentarianism pneumonoultramicroscopic words here",
  "w20": "Supercalifragilisticexpialidocious antidisestablishmentarianism pneumonoultramicroscopic words here",
  "w40": "Supercalifragilisticexpialidocious antidisestablishmentarianism pneumonoultramicroscopic words here",
  "target": [
   "Journal/2026/10-14/19-43 Supercalifragilisticexpialidocious",
   "10"
  ],
  "vtarget": [
   "Journal/2026/10-14/19-43 Supercalifragilisticexpialidocious",
   "10"
  ]
 },
 {
  "content": "---\nsource: x\n---\nAfter the meeting I felt lighter than before",
  "w7": "After the meeting I felt lighter than",
  "w12": "After the meeting I felt lighter than before",
  "w20": "After the meeting I felt lighter than before",
  "w40": "After the meeting I felt lighter than before",
  "target": [
   "Journal/2026/10-14/19-43 After the meeting I felt lighter than",
   "10"
  ],
  "vtarget": [
   "Journal/2026/10-14/19-43 After the meeting I felt lighter than",
   "10"
  ]
 },
 {
  "content": "_Transcript pending._",
  "w7": "",
  "w12": "",
  "w20": "",
  "w40": "",
  "target": "Journal/2026/10-14/19-43",
  "vtarget": "Journal/2026/10-14/19-43"
 },
 {
  "content": "Quick note on the bus\n\n_Transcript pending._",
  "w7": "Quick note on the bus",
  "w12": "Quick note on the bus",
  "w20": "Quick note on the bus",
  "w40": "Quick note on the bus",
  "target": [
   "Journal/2026/10-14/19-43 Quick note on the bus",
   "10"
  ],
  "vtarget": [
   "Journal/2026/10-14/19-43 Quick note on the bus",
   "10"
  ]
 },
 {
  "content": "Done. — it's 'fine'...",
  "w7": "Done. — it's 'fine",
  "w12": "Done. — it's 'fine",
  "w20": "Done. — it's 'fine",
  "w40": "Done. — it's 'fine",
  "target": [
   "Journal/2026/10-14/19-43 Done. — it's 'fine",
   "10"
  ],
  "vtarget": [
   "Journal/2026/10-14/19-43 Done. — it's 'fine",
   "10"
  ]
 },
 {
  "content": "1. First thing\n2. Second thing",
  "w7": "First thing Second thing",
  "w12": "First thing Second thing",
  "w20": "First thing Second thing",
  "w40": "First thing Second thing",
  "target": [
   "Journal/2026/10-14/19-43 First thing Second thing",
   "10"
  ],
  "vtarget": [
   "Journal/2026/10-14/19-43 First thing Second thing",
   "10"
  ]
 },
 {
  "content": "![pic](a.png) The garden today is __very__ green",
  "w7": "The garden today is very green",
  "w12": "The garden today is very green",
  "w20": "The garden today is very green",
  "w40": "The garden today is very green",
  "target": [
   "Journal/2026/10-14/19-43 The garden today is very green",
   "10"
  ],
  "vtarget": [
   "Journal/2026/10-14/19-43 The garden today is very green",
   "10"
  ]
 },
 {
  "content": "Café — über naïve résumé façade jalapeño piñata extra",
  "w7": "Café — über naïve résumé façade jalapeño",
  "w12": "Café — über naïve résumé façade jalapeño piñata extra",
  "w20": "Café — über naïve résumé façade jalapeño piñata extra",
  "w40": "Café — über naïve résumé façade jalapeño piñata extra",
  "target": [
   "Journal/2026/10-14/19-43 Café — über naïve résumé façade jalapeño",
   "10"
  ],
  "vtarget": [
   "Journal/2026/10-14/19-43 Café — über naïve résumé façade jalapeño",
   "10"
  ]
 },
 {
  "content": "> quoted line about the plan for the week ahead",
  "w7": "quoted line about the plan for the",
  "w12": "quoted line about the plan for the week ahead",
  "w20": "quoted line about the plan for the week ahead",
  "w40": "quoted line about the plan for the week ahead",
  "target": [
   "Journal/2026/10-14/19-43 quoted line about the plan for the",
   "10"
  ],
  "vtarget": [
   "Journal/2026/10-14/19-43 quoted line about the plan for the",
   "10"
  ]
 },
 {
  "content": "a#b c|d e:f g*h i?j k\"l m<n o>p q^r",
  "w7": "a b c d e f g",
  "w12": "a b c d e f g h i j k l",
  "w20": "a b c d e f g h i j k l m n o p q r",
  "w40": "a b c d e f g h i j k l m n o p q r",
  "target": [
   "Journal/2026/10-14/19-43 a b c d e f g",
   "10"
  ],
  "vtarget": [
   "Journal/2026/10-14/19-43 a b c d e f g",
   "10"
  ]
 },
 {
  "content": "   ",
  "w7": "",
  "w12": "",
  "w20": "",
  "w40": "",
  "target": [
   "Journal/2026/10-14/19-43 Entry",
   "10"
  ],
  "vtarget": [
   "Journal/2026/10-14/19-43 Voice memo",
   "10"
  ]
 }
];

// 19:43:10 local, as the sweep reads Notes/2026/10-14/19-43-10
const d = new Date(2026, 9, 14, 19, 43, 10);
const sweepPath = (t: Case["target"]) => (Array.isArray(t) ? t[0] : t);

check("first words: the sweep's 7 words within 60 characters, and 12/20/40 within 200, case by case", () => {
  for (const c of SWEEP) {
    assert.equal(firstWords(c.content), c.w7, JSON.stringify(c.content));
    assert.equal(firstWords(c.content, 12, 200), c.w12, JSON.stringify(c.content));
    assert.equal(firstWords(c.content, 20, 200), c.w20, JSON.stringify(c.content));
    assert.equal(firstWords(c.content, 40, 200), c.w40, JSON.stringify(c.content));
  }
});

check("path: Journal/YYYY/MM-DD/HH-MM <first words> in local time, the path the sweep would move it to", () => {
  for (const c of SWEEP) {
    assert.equal(entryPaths(d, c.content, "text").path, sweepPath(c.target), JSON.stringify(c.content));
    assert.equal(entryPaths(d, c.content, "voice").path, sweepPath(c.vtarget), JSON.stringify(c.content));
  }
});

check("a voice entry still transcribing keeps the time-only path; typed words with it title it", () => {
  assert.equal(entryPaths(d, TRANSCRIPT_PENDING, "voice").path, "Journal/2026/10-14/19-43");
  assert.deepEqual(entryPaths(d, TRANSCRIPT_PENDING, "voice").alternates, ["Journal/2026/10-14/19-43-10"]);
  assert.equal(newDraft("", "voice", d, "v1").path, "Journal/2026/10-14/19-43");
  assert.equal(newDraft("Quick placeholder note", "voice", d, "v2").path, "Journal/2026/10-14/19-43 Quick placeholder note");
});

check("a clash adds the seconds first, then more words; never -1", () => {
  const long = "One two three four five six seven eight nine ten eleven twelve thirteen fourteen";
  const p = entryPaths(d, long, "text");
  assert.equal(p.path, "Journal/2026/10-14/19-43 One two three four five six seven");
  assert.deepEqual(p.alternates, [
    "Journal/2026/10-14/19-43-10 One two three four five six seven",
    "Journal/2026/10-14/19-43-10 One two three four five six seven eight nine ten eleven twelve",
    "Journal/2026/10-14/19-43-10 One two three four five six seven eight nine ten eleven twelve thirteen fourteen",
  ]);
  // short words: more words are the same words, so only the seconds remain
  assert.deepEqual(entryPaths(d, "A short placeholder", "text").alternates, ["Journal/2026/10-14/19-43-10 A short placeholder"]);
  for (const c of SWEEP) for (const a of entryPaths(d, c.content, "text").alternates) assert.doesNotMatch(a, /-\d$/);
});

check("the draft carries the path, its alternates, the entry id and the time; the old Notes/ shape is kept for queued entries", () => {
  const draft = newDraft("A placeholder entry", "text", d, "id-1");
  assert.deepEqual([draft.entry_id, draft.path, draft.source], ["id-1", "Journal/2026/10-14/19-43 A placeholder entry", "text"]);
  assert.equal(draft.alternates[0], "Journal/2026/10-14/19-43-10 A placeholder entry");
  assert.equal(draft.created_at, d.toISOString());
  assert.equal(legacyEntryPath(d), "Notes/2026/10-14/19-43-10");
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
