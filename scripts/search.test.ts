// Run: node --experimental-strip-types scripts/search.test.ts
import assert from "node:assert/strict";
import { groupByRoom, hitTarget, plainSnippet, snippetSegments, SNIPPET_END as E, SNIPPET_START as S } from "../src/searchCore.ts";

assert.deepEqual(snippetSegments(`now about the ${S}fcm${E} ${S}gateway${E}`), [
  { text: "now about the ", hit: false },
  { text: "fcm", hit: true },
  { text: " ", hit: false },
  { text: "gateway", hit: true },
]);
// HTML in a message stays text (it is rendered as a React text node).
assert.deepEqual(snippetSegments(`<img src=x onerror=alert(1)> ${S}hi${E}`), [
  { text: "<img src=x onerror=alert(1)> ", hit: false },
  { text: "hi", hit: true },
]);
assert.deepEqual(snippetSegments(""), []);
// Unbalanced markers: no crash, adjacent runs merge.
assert.deepEqual(snippetSegments(`a${E}b${S}c`), [{ text: "ab", hit: false }, { text: "c", hit: true }]);
assert.deepEqual(snippetSegments(`${S}${E}x`), [{ text: "x", hit: false }]);

const h = (ref: string, channel: string, name: string) => ({ channel_name: name, message: { ref, channel } });
const groups = groupByRoom([h("1", "b", "beta"), h("2", "a", "alpha"), h("3", "b", "beta")]);
assert.deepEqual(groups.map((g) => [g.name, g.hits.map((x) => x.message.ref)]), [["beta", ["1", "3"]], ["alpha", ["2"]]]);
assert.deepEqual(groupByRoom([]), []);

assert.deepEqual(hitTarget({ ref: "r", channel: "c", root: "root" }), { channel: "c", root: "root", focus: "r" });
assert.deepEqual(hitTarget({ ref: "r", channel: "c", root: null }), { channel: "c", root: null, focus: "r" });
assert.deepEqual(hitTarget({ ref: "r", channel: "c", root: "r" }), { channel: "c", root: null, focus: "r" });

console.log("search tests passed");

// T-335 glow-up: a note's snippet reads as prose: no heading marks, stars, backticks or link brackets, the link's words kept.
assert.equal(plainSnippet("## Now\n\nThe **coop** paperwork is signed. See [[Areas/Kiln Studio/Plan|the plan]] and [notes](https://example.com/n)."),
  "Now The coop paperwork is signed. See the plan and notes.");
assert.equal(plainSnippet("- first `cone 6`\n- second [[Glaze Tests]]"), "first cone 6 second Glaze Tests");
assert.equal(plainSnippet("Issue #12 stays"), "Issue #12 stays");
// emphasis marks go only in pairs around words; code and arithmetic keep theirs
assert.equal(plainSnippet("call __init__() with 2*3*4, then **bold** and *soft* and __strong__."), "call __init__() with 2*3*4, then bold and soft and strong.");

