// T-83: a node's status mark (the map's layout and slot registry went with the map in T-124 r12).
// Run: node --experimental-strip-types scripts/nodeMap.test.ts
import assert from "node:assert/strict";
import { parseBrief } from "../src/areas/briefCore.ts";
import { parseArea, parseProject } from "../src/areas/areasCore.ts";
import { buildTree } from "../src/areas/treeCore.ts";
import { markOf, rolledMark } from "../src/areas/nodeMap.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const entry = (md: string) => ({ brief: parseBrief(md), generatedAt: null, updatedAt: null });

check("mark: needs beats moving beats quiet; no brief is quiet", () => {
  assert.equal(markOf(entry("## Needs you\n- a\n\n## Moving\n- b\n")), "needs");
  assert.equal(markOf(entry("## Needs you\n- nothing recent\n\n## Moving\n- b\n")), "moving");
  assert.equal(markOf(entry("## Now\nQuiet.\n")), "quiet");
  assert.equal(markOf(null), "quiet");
  assert.equal(markOf(undefined), "quiet");
});

check("rolled mark: an arm shows what waits at its tip; briefs match by path only", () => {
  const a = parseArea({ id: "a", path: "Areas/Techne", tags: ["area"], metadata: { status: "foreground" } })!;
  const p = parseProject({ id: "p", path: "Projects/COhere", tags: ["project"], metadata: { status: "foreground", parent: "Areas/Techne" } })!;
  const tree = buildTree([a, p]);
  const briefs = { "Projects/COhere": entry("## Needs you\n- sign-in\n"), "Areas/Techne": entry("## Now\nx\n") };
  assert.equal(rolledMark(tree, briefs, "Areas/Techne"), "needs");
  assert.equal(rolledMark(tree, { "Areas/Techne": briefs["Areas/Techne"] }, "Areas/Techne"), "quiet");
  // a brief filed under a different path (a name collision) changes nothing
  assert.equal(rolledMark(tree, { "Areas/Other/Projects/COhere": briefs["Projects/COhere"] }, "Areas/Techne"), "quiet");
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
