// T-140: the tree from node links (`links` two-way, `parent` as a legacy link): src/areas/treeCore.ts, and the room each node opens
// (src/shape/privacy.ts), which the shell's rooms and privacy read. Run: node --experimental-strip-types scripts/links.test.ts
import assert from "node:assert/strict";
import { parseArea, parseProject } from "../src/areas/areasCore.ts";
import { buildTree, ROOT, ancestry, type Tree } from "../src/areas/treeCore.ts";
import { linksOf } from "../src/areas/nodeLinks.ts";
import { roomView } from "../src/shape/privacy.ts";
const childrenOf = (t: Tree, path: string) => t.children.get(path) ?? [];

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
type M = Record<string, unknown>;
const area = (id: string, name: string, meta: M = {}) => parseArea({ id, path: `Areas/${name}`, tags: ["area"], content: `# ${name}\n\nPurpose.`, metadata: { status: "foreground", ...meta } })!;
const proj = (id: string, name: string, meta: M = {}) => parseProject({ id, path: `Projects/${name}`, tags: ["project"], content: `# ${name}`, metadata: meta })!;
const shape = (t: ReturnType<typeof buildTree>) => Object.fromEntries([ROOT, ...t.nodes.keys()].map((k) => [k || "Uni", childrenOf(t, k).map((n) => n.name)]).filter(([, v]) => (v as string[]).length));

// ids as the vault stores them; the same data is written three ways below
const A = { par: "a-par", sad: "a-sad", bou: "a-bou", tec: "a-tec" };
const parentOnly = () => buildTree([area("a-par", "Parachute"), area("a-sad", "Sanctum"), area("a-bou", "Boulder"), area("a-tec", "Techne"),
  proj("p-app", "uni-app", { parent: "Areas/Parachute" }), proj("p-mail", "Mail", { parent: "a-par" }), proj("p-reg", "RegenHub", { parent: "[[Areas/Boulder]]" })]);
const linksOnly = () => buildTree([area("a-par", "Parachute"), area("a-sad", "Sanctum"), area("a-bou", "Boulder"), area("a-tec", "Techne"),
  proj("p-app", "uni-app", { links: [A.par, A.sad, "p-mail"] }), proj("p-mail", "Mail", { links: [A.par, "p-app"] }), proj("p-reg", "RegenHub", { links: [A.bou, A.tec] })]);

check("parent-only vault (before the migration): areas at the top, each project under its parent", () => {
  assert.deepEqual(shape(parentOnly()), { Uni: ["Boulder", "Parachute", "Sanctum", "Techne"], "Areas/Parachute": ["Mail", "uni-app"], "Areas/Boulder": ["RegenHub"] });
});
check("links-only vault (after it): a project linked to two areas is under both, as one node", () => {
  const t = linksOnly();
  assert.deepEqual(shape(t), { Uni: ["Boulder", "Parachute", "Sanctum", "Techne"], "Areas/Parachute": ["Mail", "uni-app"], "Areas/Sanctum": ["uni-app"], "Areas/Boulder": ["RegenHub"], "Areas/Techne": ["RegenHub"] });
  assert.equal(childrenOf(t, "Areas/Parachute").find((n) => n.name === "uni-app"), childrenOf(t, "Areas/Sanctum")[0], "the same node object");
  assert.deepEqual(t.areasOf.get("Projects/RegenHub"), ["Areas/Boulder", "Areas/Techne"]);
});
check("mixed: parent and links naming the same area, duplicated, give one child", () => {
  const t = buildTree([area("a-par", "Parachute"), area("a-sad", "Sanctum"), proj("p-app", "uni-app", { parent: "Areas/Parachute", links: ["a-par", "Areas/Parachute", "a-sad", "a-sad"] })]);
  assert.deepEqual(shape(t), { Uni: ["Parachute", "Sanctum"], "Areas/Parachute": ["uni-app"], "Areas/Sanctum": ["uni-app"] });
  assert.deepEqual(t.links.get("Projects/uni-app"), ["Areas/Parachute", "Areas/Sanctum"]);
});
check("two-way: a link listed on one end only counts from either side (the area lists the project)", () => {
  const t = buildTree([area("a-bou", "Boulder", { links: ["p-reg"] }), area("a-tec", "Techne", { links: ["p-reg"] }), proj("p-reg", "RegenHub")]);
  assert.deepEqual(shape(t), { Uni: ["Boulder", "Techne"], "Areas/Boulder": ["RegenHub"], "Areas/Techne": ["RegenHub"] });
  assert.deepEqual(t.links.get("Projects/RegenHub"), ["Areas/Boulder", "Areas/Techne"]);
  assert.deepEqual(t.parent.get("Projects/RegenHub"), "Areas/Boulder");
});
check("a project linked to no area is top level under Uni (a migrated Uni parent is no link); project-to-project links only link", () => {
  const t = buildTree([area("a-par", "Parachute"), proj("p-x", "Loose", { parent: "uni-root" }), proj("p-y", "Pair", { links: ["p-z"] }), proj("p-z", "Twin")]);
  assert.deepEqual(shape(t), { Uni: ["Parachute", "Loose", "Pair", "Twin"] });
  assert.deepEqual(t.links.get("Projects/Pair"), ["Projects/Twin"]);
  assert.deepEqual(t.links.get("Projects/Twin"), ["Projects/Pair"]);
});
check("legacy: a project whose only tie is an old parent project sits in that project's area, flat; with no area anywhere it is top level", () => {
  const t = buildTree([area("a-bou", "Boulder"), proj("p-c", "COhere", { parent: "a-bou" }), proj("p-26", "COhere 2026", { parent: "Projects/COhere" }), proj("p-w", "Woven Web", { parent: "p-26" }), proj("p-o", "Orphan", { parent: "p-nowhere" })]);
  assert.deepEqual(shape(t), { Uni: ["Boulder", "Orphan"], "Areas/Boulder": ["COhere", "COhere 2026", "Woven Web"] });
  assert.deepEqual(t.areasOf.get("Projects/Woven Web"), ["Areas/Boulder"]);
});
check("unresolved ids, a self link, a link to an archived node: ignored, nothing throws", () => {
  const t = buildTree([area("a-par", "Parachute"), area("a-old", "Old", { status: "archived" }), proj("p-x", "X", { links: ["nope", "01M0000000000000000000GONE", "p-x", "a-old", "a-par"], parent: "also-nope" })]);
  assert.deepEqual(shape(t), { Uni: ["Parachute"], "Areas/Parachute": ["X"] });
  assert.deepEqual(t.links.get("Projects/X"), ["Areas/Parachute"]);
  assert.deepEqual(linksOf({ links: "a, [[Areas/B|B]],, a" }), ["a", "Areas/B"]);
  assert.deepEqual(linksOf({ links: 7 }), []);
});
check("cycle safety: parents and links in a ring, area-to-area and self links never loop or nest", () => {
  const t = buildTree([area("a1", "A1", { parent: "a2", links: ["a1"] }), area("a2", "A2", { parent: "a1" }),
    proj("p1", "P1", { parent: "p2", links: ["a1"] }), proj("p2", "P2", { parent: "p3" }), proj("p3", "P3", { parent: "p1" })]);
  assert.deepEqual(shape(t), { Uni: ["A1", "A2"], "Areas/A1": ["P1", "P2", "P3"] }, "the legacy parent ring lends A1 to P2 and P3, and ends");
  assert.deepEqual(ancestry(t, "Projects/P3").map((n) => n.name), ["P3", "P1", "A1"]);
  assert.equal(t.nodes.size, 5);
});


// ---- legacy parent chains keep their room (src/shape/privacy.ts roomView); 0.1.46 equivalence on parent-only data
const FR = [{ id: "r-uni", name: "Uni", last_ts: 1 }, { id: "r-bou", name: "boulder", last_ts: 1 }, { id: "r-coh", name: "cohere", last_ts: 1 }, { id: "r-c26", name: "cohere-2026", last_ts: 1 }];
const legacyAreas = () => buildTree([area("a-bou", "Boulder", { room: "boulder" }), proj("p-coh", "COhere", { parent: "Areas/Boulder", room: "cohere" }),
  proj("p-ww", "Woven Web", { parent: "Projects/COhere" }), proj("p-c26", "COhere 2026", { parent: "p-coh", room: "cohere-2026" }), proj("p-top", "Loose", { parent: "Projects/Woven Web" })]);
check("legacy parent chain: Boulder -> COhere -> roomless Woven Web keeps #cohere and is listed flat under Boulder", () => {
  const t = legacyAreas();
  assert.deepEqual(childrenOf(t, "Areas/Boulder").map((n) => n.name), ["COhere", "COhere 2026", "Loose", "Woven Web"]);
  assert.equal(roomView(t, "Projects/Woven Web", FR, FR[0]).target?.name, "cohere");
  assert.equal(roomView(t, "Projects/Loose", FR, FR[0]).target?.name, "cohere");
  assert.equal(roomView(t, "Projects/COhere", FR, FR[0]).own, true);
});
check("once a node has links, links rule: a legacy parent is ignored for its chain", () => {
  const t = buildTree([area("a-bou", "Boulder", { room: "boulder" }), proj("p-coh", "COhere", { links: ["a-bou"], room: "cohere" }), proj("p-ww", "Woven Web", { parent: "p-coh", links: ["a-bou"] })]);
  assert.equal(roomView(t, "Projects/Woven Web", FR, FR[0]).target?.name, "boulder");
});
check("0.1.46 equivalence: on a parent-only tree every node's room matches the old logic", () => {
  // 0.1.46 logic, copied: parent map (cycles broken at the smallest path), children from it, ancestry up it
  const list = [area("a-bou", "Boulder", { room: "boulder" }), area("a-par", "Parachute"), proj("p-coh", "COhere", { parent: "Areas/Boulder", room: "cohere" }), proj("p-ww", "Woven Web", { parent: "Projects/COhere" }),
    proj("p-c26", "COhere 2026", { parent: "p-coh", room: "cohere-2026" }), proj("p-x", "Deep", { parent: "[[Projects/Woven Web]]" }), proj("p-app", "uni-app", { parent: "Areas/Parachute" }), proj("p-lone", "Lone", {})];
  const neu = buildTree(list);
  const nodes = neu.nodes;
  const oldParent = new Map<string, string>();
  for (const [p, n] of nodes) { const raw = n.parent ? n.parent.replace(/^\[\[|\]\]$/g, "") : null; const hit = raw && [...nodes.values()].find((m) => m.path === raw || m.id === raw)?.path; oldParent.set(p, hit && hit !== p ? hit : ROOT); }
  const oldKids = new Map<string, string[]>();
  for (const [p, up] of oldParent) oldKids.set(up, [...(oldKids.get(up) ?? []), p]);
  const oldTree = { ...neu, parent: oldParent, chain: oldParent, children: new Map([...oldKids].map(([k, v]) => [k, v.map((c) => nodes.get(c)!)])), scope: new Map([...oldKids].map(([k, v]) => [k, v.map((c) => nodes.get(c)!)])) } as typeof neu;
  for (const path of nodes.keys()) {
    const a = roomView(neu, path, FR, FR[0]), b = roomView(oldTree, path, FR, FR[0]);
    assert.deepEqual([a.target?.id, a.own, a.heldNode], [b.target?.id, b.own, b.heldNode], `room of ${path}`);
  }
});
check("parent-only project with two channels keeps its unclaimed one when a legacy child claims the other (Codex 0.1.47 review 2)", () => {
  const RR = [{ id: "r-area", name: "area", last_ts: 1 }, { id: "r-parent", name: "parent", last_ts: 1 }, { id: "r-child", name: "child", last_ts: 1 }];
  const t = buildTree([area("a-a", "A", { channel: "r-area" }), proj("p-p", "P", { parent: "Areas/A", channel: ["r-child", "r-parent"] }), proj("p-c", "C", { parent: "Projects/P", channel: "r-child" })]);
  assert.equal(roomView(t, "Projects/P", RR, RR[0]).target?.id, "r-parent");
  assert.equal(roomView(t, "Projects/C", RR, RR[0]).target?.id, "r-child");
});
check("links-only project cycle P->Q->R->P: each opens its own room (Codex 0.1.47 review 3)", () => {
  const RR = [{ id: "r-uni", name: "Uni", last_ts: 1 }, { id: "r-p", name: "p", last_ts: 1 }, { id: "r-q", name: "q", last_ts: 1 }, { id: "r-r", name: "r", last_ts: 1 }];
  const t = buildTree([proj("p-p", "P", { links: ["p-q"], channel: "r-p" }), proj("p-q", "Q", { links: ["p-r"], channel: "r-q" }), proj("p-r", "R", { links: ["p-p"], channel: "r-r" })]);
  for (const [n, id] of [["P", "r-p"], ["Q", "r-q"], ["R", "r-r"]]) assert.equal(roomView(t, `Projects/${n}`, RR, RR[0]).target?.id, id, n);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("links: all passed");
