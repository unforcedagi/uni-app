import assert from "node:assert/strict";
import { backlinks } from "../src/backlinks.ts";
const inbound = { sourceId: "a", targetId: "here", relationship: "mentions", sourceNote: { id: "a", path: "People/A" } };
assert.deepEqual(backlinks("here", [inbound, inbound, { sourceId: "here", targetId: "out" }, { sourceId: "b", targetId: "here", relationship: "related", sourceNote: null }, null, {}, { sourceNote: { id: "c", path: "C" }, targetNote: { id: "here" }, relationship: "contains" }]), [
  { id: "b", path: "b", relationship: "related" }, { id: "c", path: "C", relationship: "contains" }, { id: "a", path: "People/A", relationship: "mentions" },
]);
assert.equal(backlinks("here", [inbound, { ...inbound, relationship: "related" }]).length, 2);
assert.deepEqual(backlinks("here", undefined), []);
assert.deepEqual(backlinks("here", { links: [] }), []);
console.log("backlinks tests passed");
