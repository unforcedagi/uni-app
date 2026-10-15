// T-140: the tree from node links (`links` two-way, `parent` as a legacy link), and the Rooms / Projects views over it.
// Run: node --experimental-strip-types scripts/links.test.ts
import assert from "node:assert/strict";
import { parseArea, parseProject } from "../src/areas/areasCore.ts";
import { buildTree, childrenOf, parentPath, ROOT, trail, ancestry } from "../src/areas/treeCore.ts";
import { buildTaskTree, parseNodes, subtreePaths, rollUp, tasksUnder } from "../src/areas/taskCore.ts";
import { treeRows } from "../src/areas/treeRooms.ts";
import { ancestorsOf, visibleRows } from "../src/areas/sidebarState.ts";
import { archivedRoomIds, byActivity, parseView, projectCards, roomsList } from "../src/areas/viewsCore.ts";
import { linksOf } from "../src/areas/nodeLinks.ts";

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
const parentOnly = () => buildTree([area("a-par", "Parachute"), area("a-sad", "Sadhana"), area("a-bou", "Boulder"), area("a-tec", "Techne"),
  proj("p-app", "uni-app", { parent: "Areas/Parachute" }), proj("p-mail", "Mail", { parent: "a-par" }), proj("p-reg", "RegenHub", { parent: "[[Areas/Boulder]]" })]);
const linksOnly = () => buildTree([area("a-par", "Parachute"), area("a-sad", "Sadhana"), area("a-bou", "Boulder"), area("a-tec", "Techne"),
  proj("p-app", "uni-app", { links: [A.par, A.sad, "p-mail"] }), proj("p-mail", "Mail", { links: [A.par, "p-app"] }), proj("p-reg", "RegenHub", { links: [A.bou, A.tec] })]);

check("parent-only vault (before the migration): areas at the top, each project under its parent", () => {
  assert.deepEqual(shape(parentOnly()), { Uni: ["Boulder", "Parachute", "Sadhana", "Techne"], "Areas/Parachute": ["Mail", "uni-app"], "Areas/Boulder": ["RegenHub"] });
});
check("links-only vault (after it): a project linked to two areas is under both, as one node", () => {
  const t = linksOnly();
  assert.deepEqual(shape(t), { Uni: ["Boulder", "Parachute", "Sadhana", "Techne"], "Areas/Parachute": ["Mail", "uni-app"], "Areas/Sadhana": ["uni-app"], "Areas/Boulder": ["RegenHub"], "Areas/Techne": ["RegenHub"] });
  assert.equal(childrenOf(t, "Areas/Parachute").find((n) => n.name === "uni-app"), childrenOf(t, "Areas/Sadhana")[0], "the same node object");
  assert.deepEqual(t.areasOf.get("Projects/RegenHub"), ["Areas/Boulder", "Areas/Techne"]);
});
check("mixed: parent and links naming the same area, duplicated, give one child", () => {
  const t = buildTree([area("a-par", "Parachute"), area("a-sad", "Sadhana"), proj("p-app", "uni-app", { parent: "Areas/Parachute", links: ["a-par", "Areas/Parachute", "a-sad", "a-sad"] })]);
  assert.deepEqual(shape(t), { Uni: ["Parachute", "Sadhana"], "Areas/Parachute": ["uni-app"], "Areas/Sadhana": ["uni-app"] });
  assert.deepEqual(t.links.get("Projects/uni-app"), ["Areas/Parachute", "Areas/Sadhana"]);
});
check("two-way: a link listed on one end only counts from either side (the area lists the project)", () => {
  const t = buildTree([area("a-bou", "Boulder", { links: ["p-reg"] }), area("a-tec", "Techne", { links: ["p-reg"] }), proj("p-reg", "RegenHub")]);
  assert.deepEqual(shape(t), { Uni: ["Boulder", "Techne"], "Areas/Boulder": ["RegenHub"], "Areas/Techne": ["RegenHub"] });
  assert.deepEqual(t.links.get("Projects/RegenHub"), ["Areas/Boulder", "Areas/Techne"]);
  assert.deepEqual(parentPath(t, "Projects/RegenHub"), "Areas/Boulder");
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
  assert.deepEqual(trail(t, "Projects/P1").map((n) => n.name), ["A1", "P1"]);
  assert.deepEqual(ancestry(t, "Projects/P3").map((n) => n.name), ["P3", "A1"]);
  assert.equal(t.nodes.size, 5);
});
check("a project in two areas: the breadcrumb and Back use the area you came through, else the first by name", () => {
  const t = linksOnly();
  assert.deepEqual(trail(t, "Projects/uni-app").map((n) => n.name), ["Parachute", "uni-app"]);
  assert.deepEqual(trail(t, "Projects/uni-app", "Areas/Sadhana").map((n) => n.name), ["Sadhana", "uni-app"]);
  assert.deepEqual(trail(t, "Projects/uni-app", "Areas/Boulder").map((n) => n.name), ["Parachute", "uni-app"], "an area it is not in is ignored");
  assert.equal(parentPath(t, "Projects/uni-app", "Areas/Sadhana"), "Areas/Sadhana");
  assert.equal(parentPath(t, "Projects/uni-app"), "Areas/Parachute");
  assert.equal(parentPath(t, "Areas/Sadhana"), ROOT);
});
check("the sidebar rows list a project under each area with its own key; opening either row selects the one node", () => {
  const t = linksOnly();
  const rows = treeRows(t, [], null);
  const mine = rows.filter((r) => r.path === "Projects/uni-app");
  assert.deepEqual(mine.map((r) => r.via), ["Areas/Parachute", "Areas/Sadhana"]);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, "keys are unique");
  assert.deepEqual(ancestorsOf(rows, "Projects/uni-app").sort(), ["Areas/Parachute", "Areas/Sadhana"]);
  assert.equal(visibleRows(rows, {}, "Projects/uni-app").filter((r) => r.path === "Projects/uni-app").length, 2, "selecting it reveals both rows");
  assert.equal(visibleRows(rows, {}, undefined).filter((r) => r.path === "Projects/uni-app").length, 0, "folded by default");
});
check("the task tree reads the same links: an area's subtree is its projects; a project in two areas counts in both and once at Uni", () => {
  const note = (id: string, path: string, tags: string[], metadata: M) => ({ id, path, tags, metadata });
  const { nodes, rootPath } = parseNodes([note("u", "Uni", ["uni"], {}), note("a-par", "Areas/Parachute", ["area"], {}), note("a-sad", "Areas/Sadhana", ["area"], { links: ["p-app"] }),
    note("p-app", "Projects/uni-app", ["project"], { links: ["a-par"], parent: "u" }), note("p-lone", "Projects/Lone", ["project"], {})]);
  const t = buildTaskTree(nodes, rootPath);
  assert.deepEqual(subtreePaths(t, "Areas/Parachute").sort(), ["Areas/Parachute", "Projects/uni-app"]);
  assert.deepEqual(subtreePaths(t, "Areas/Sadhana").sort(), ["Areas/Sadhana", "Projects/uni-app"]);
  assert.deepEqual(subtreePaths(t, "Projects/uni-app"), ["Projects/uni-app"]);
  assert.equal(t.parent.get("Projects/Lone"), ROOT);
  const task = (n: string) => ({ node: n, id: n, kind: "task", state: "open", owner: "aaron", title: "t", next: "", options: [] }) as never;
  const r = rollUp(t, [task("Projects/uni-app")]);
  assert.deepEqual([r.get("Areas/Parachute")!.total, r.get("Areas/Sadhana")!.total, r.get(ROOT)!.total], [1, 1, 1]);
  assert.equal(tasksUnder(t, "Areas/Sadhana", [task("Projects/uni-app")]).length, 1);
});

const ROOMS = [{ id: "r-uni", name: "Uni", last_ts: 100 }, { id: "r-par", name: "parachute", last_ts: 500 }, { id: "r-os", name: "uni-os", last_ts: 900 }, { id: "r-sad", name: "sadhana", last_ts: null }, { id: "r-old", name: "ricki", last_ts: 950 }, { id: "r-bou", name: "boulder", last_ts: 300 }];
const UNI = ROOMS[0];
const vt = () => buildTree([area("a-par", "Parachute", { room: "parachute" }), area("a-sad", "Sadhana", { room: "sadhana" }), area("a-bou", "Boulder", { room: "boulder" }),
  proj("p-app", "uni-app", { links: ["a-par", "a-sad", "p-mail"], room: "uni-os" }), proj("p-mail", "Mail", { links: ["a-par"] }), proj("p-reg", "RegenHub", { links: ["a-bou"] }),
  proj("p-ric", "Ricki", { links: ["a-bou"], status: "archived", room: "ricki" })]);
check("Rooms view: newest message first, a room with none last; archived rooms (a retired node's) leave the list", () => {
  const t = vt();
  const archived = archivedRoomIds(t, ROOMS, new Map([["r-par", 1], ["r-os", 1], ["r-sad", 1], ["r-bou", 1]]));
  assert.deepEqual([...archived], ["r-old"]);
  const l = roomsList(ROOMS, archived);
  assert.deepEqual(l.live.map((r) => r.name), ["uni-os", "parachute", "boulder", "Uni", "sadhana"]);
  assert.deepEqual(l.archived.map((r) => r.name), ["ricki"]);
  assert.deepEqual(byActivity([{ name: "b", last_ts: null }, { name: "a", last_ts: null }]).map((r) => r.name), ["a", "b"]);
});
check("Projects view: by the room's last activity; a roomless project talks in its area's room; chips are areas then linked projects", () => {
  const cards = projectCards(vt(), ROOMS, UNI);
  assert.deepEqual(cards.map((c) => c.name), ["uni-app", "Mail", "RegenHub"], "uni-os 900, parachute 500, boulder 300");
  const app = cards[0];
  assert.deepEqual([app.roomName, app.own], ["uni-os", true]);
  assert.deepEqual(app.chips.map((c) => [c.name, c.roomName]), [["Parachute", "parachute"], ["Sadhana", "sadhana"], ["Mail", "parachute"]]);
  assert.deepEqual([cards[1].roomName, cards[1].own], ["parachute", false], "Mail has no room: it talks in #parachute");
  assert.deepEqual(cards[1].chips.map((c) => c.name), ["Parachute", "uni-app"]);
});
check("the view choice is remembered per device: a bad value is Areas", () => {
  assert.equal(parseView('"rooms"'), "rooms"); assert.equal(parseView("projects"), "projects");
  assert.equal(parseView(null), "areas"); assert.equal(parseView("nope"), "areas");
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
