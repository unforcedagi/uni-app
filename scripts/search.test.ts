// Run: node --experimental-strip-types scripts/search.test.ts
import assert from "node:assert/strict";
import { groupByRoom, hitTarget, snippetSegments, SNIPPET_END as E, SNIPPET_START as S } from "../src/search.ts";

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
