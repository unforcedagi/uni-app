// T-80b: the tree of areas and projects the shell's rooms and privacy are read from (src/areas/areasCore.ts, src/areas/treeCore.ts).
// Moved from the retired life OS test (T-335). Run: node --experimental-strip-types scripts/nodeTree.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseArea, parseProject, parentOf } from "../src/areas/areasCore.ts";
import { buildTree, ROOT, type Tree } from "../src/areas/treeCore.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const childrenOf = (t: Tree, path: string) => t.children.get(path) ?? [];
const parentPath = (t: Tree, path: string) => t.parent.get(path) ?? ROOT;

check("the Tauri side registers vault_query", () => {
  assert.match(readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"), /vault_query,/);
});

// -------------------------------------------------------------------- the tree (T-80b)
const areaNote = (name: string, metadata: Record<string, unknown> = {}) => ({ id: `a-${name}`, path: `Areas/${name}`, tags: ["area"], content: `# ${name}\n\nAbout ${name}.`, metadata, updatedAt: "2026-10-09T10:00:00Z" });
const projectNote = (path: string, metadata: Record<string, unknown> = {}) => ({ id: `p-${path}`, path, tags: ["project"], content: "", metadata, updatedAt: "2026-10-09T10:00:00Z" });
const nodes = (...n: { id: string; path: string; tags: string[]; content: string; metadata: Record<string, unknown>; updatedAt: string }[]) =>
  n.map((x) => (x.tags.includes("area") ? parseArea(x) : parseProject(x))!).filter(Boolean);

check("parentOf reads a path, tolerating [[ ]], a leading slash and an extension", () => {
  assert.equal(parentOf({ parent: "Areas/Techne" }), "Areas/Techne");
  assert.equal(parentOf({ parent: "[[Areas/Techne|Techne]]" }), "Areas/Techne");
  assert.equal(parentOf({ parent: " /Areas/Techne.md " }), "Areas/Techne");
  assert.equal(parentOf({ parent: "" }), null);
  assert.equal(parentOf({}), null);
  assert.equal(parentOf({ parent: 7 }), null);
});
check("a project is a tagged note with a parent; Brief and app notes, and notes without a parent, are not nodes", () => {
  assert.equal(parseProject(projectNote("Projects/COhere/COhere 2026", { parent: "Areas/Techne" }))?.parent, "Areas/Techne");
  assert.equal(parseProject(projectNote("Projects/COhere/COhere 2026", {})), null);
  assert.equal(parseProject(projectNote("Projects/X/Brief", { parent: "Areas/Techne" })), null);
  assert.equal(parseProject({ ...projectNote("Projects/Y", { parent: "Areas/Techne" }), tags: ["note"] }), null);
});
check("buildTree: areas at the top, a project under its parent, foreground first", () => {
  const t = buildTree(nodes(areaNote("Techne", { status: "foreground", channel: "t1" }), areaNote("Atlas", { channel: "a1" }),
    projectNote("Projects/COhere/COhere 2026", { parent: "Areas/Techne", channel: "c1" })));
  assert.deepEqual(childrenOf(t, ROOT).map((n) => n.name), ["Techne", "Atlas"]);
  assert.deepEqual(childrenOf(t, "Areas/Techne").map((n) => n.path), ["Projects/COhere/COhere 2026"]);
  assert.deepEqual(childrenOf(t, "Areas/Atlas"), []);
  assert.equal(parentPath(t, "Projects/COhere/COhere 2026"), "Areas/Techne");
  assert.equal(parentPath(t, "Areas/Techne"), ROOT);
});
check("buildTree: a missing parent puts the node at the top level; so does naming itself", () => {
  const t = buildTree(nodes(areaNote("Techne"), projectNote("Projects/Lost", { parent: "Areas/Gone" }), projectNote("Projects/Self", { parent: "Projects/Self" })));
  assert.deepEqual(childrenOf(t, ROOT).map((n) => n.path).sort(), ["Areas/Techne", "Projects/Lost", "Projects/Self"]);
});
check("buildTree: a cycle of project links links only: nothing nests, nothing is lost or loops (T-140)", () => {
  const t = buildTree(nodes(projectNote("Projects/B", { parent: "Projects/A" }), projectNote("Projects/A", { parent: "Projects/C" }), projectNote("Projects/C", { parent: "Projects/B" }), projectNote("Projects/D", { parent: "Projects/C" })));
  assert.equal(t.nodes.size, 4);
  assert.deepEqual(childrenOf(t, ROOT).map((n) => n.path), ["Projects/A", "Projects/B", "Projects/C", "Projects/D"]);
  assert.deepEqual(t.links.get("Projects/C"), ["Projects/A", "Projects/B", "Projects/D"], "the links are kept, both ways");
});
check("buildTree: multiple rooms are kept in order, and a child's room leaves the parent's view but not the note", () => {
  const t = buildTree(nodes(areaNote("Techne", { channel: "t1, c1,t1" }), projectNote("Projects/COhere/COhere 2026", { parent: "Areas/Techne", channel: "c1" }), projectNote("Projects/Two", { parent: "Areas/Techne", channel: "x1, x2" })));
  const techne = t.nodes.get("Areas/Techne")!;
  assert.deepEqual(techne.channels, ["t1", "c1"], "the note says what it says");
  assert.deepEqual(techne.rooms, ["t1"], "the view drops the room a child claims");
  assert.deepEqual(t.nodes.get("Projects/Two")!.rooms, ["x1", "x2"]);
});
check("buildTree: a parent whose rooms are all claimed keeps them, and duplicate paths keep the newest", () => {
  const t = buildTree(nodes(areaNote("Techne", { channel: "c1" }), projectNote("Projects/P", { parent: "Areas/Techne", channel: "c1" })));
  assert.deepEqual(t.nodes.get("Areas/Techne")!.rooms, ["c1"]);
  const a = { ...areaNote("Techne", { status: "foreground" }), updatedAt: "2026-10-01T00:00:00Z" }, b = { ...areaNote("Techne"), id: "newer", updatedAt: "2026-10-09T00:00:00Z" };
  assert.equal(buildTree(nodes(a, b)).nodes.get("Areas/Techne")!.id, "newer");
});
check("project summary supplies purpose with a lean query", () => {
  const p = parseProject({ id: "p", path: "Projects/P", tags: ["project"], metadata: { parent: "Areas/A", summary: "Project purpose", status: "dormant" } });
  assert.equal(p?.purpose, "Project purpose");
  assert.equal(p?.status, "background");
});
check("archived and done nodes stay hidden for areas and projects", () => {
  for (const status of ["archived", "done"]) {
    const a = parseArea({ id: "a", path: "Areas/A", tags: ["area"], metadata: { status } })!;
    const p = parseProject({ id: "p", path: "Projects/P", tags: ["project"], metadata: { status, parent: "Areas/A" } })!;
    assert.equal(a.status, status);
    assert.equal(p.status, status);
    assert.equal(buildTree([a, p]).nodes.size, 0);
  }
});

check("tree uses normalized status as its source", () => {
  const a = parseArea({ id: "a", path: "Areas/A", tags: ["area"], metadata: { status: "foreground" } })!;
  a.metadata.status = "archived";
  assert.equal(buildTree([a]).nodes.size, 1);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("nodeTree: all passed");
