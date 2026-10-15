// T-88: references by note id (parent, node, brief), room stewardship and its edge cases.
// Run: node --experimental-strip-types scripts/ids.test.ts
import assert from "node:assert/strict";
import { buildTaskTree, parseNodes, parseTask, rollUp, subtreePaths, nodeFilterKeys } from "../src/areas/taskCore.ts";
import { isUlid, pathResolver, refKey } from "../src/areas/refs.ts";
import { parseArea, parseProject, trustedBrief } from "../src/areas/areasCore.ts";
import { ancestry, buildTree, ROOT, parentPath } from "../src/areas/treeCore.ts";
import { ownRoom, steward, type RoomNode } from "../src/areas/talkCore.ts";
import { createVaultTasks } from "../src/areas/vaultTasks.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const U = "01M0000000000000000000UNI0", TECH = "01M000000000000000000TECH0", BOUL = "01M00000000000000000BOULD0", COH = "01M0000000000000000000COH0", RIC = "01M0000000000000000000RIC0", MAIL = "01M000000000000000000MAIL0";
const note = (id: string, path: string, parent: string | null, extra: Record<string, unknown> = {}, tags = ["project"]) => ({ id, path, tags, metadata: { ...(parent ? { parent } : {}), ...extra } });
// A mixed vault: ids, paths and links side by side, as during the week both forms exist.
const NOTES = [
  note(U, "Uni", null, {}, ["uni"]),
  note(TECH, "Areas/Techne", U, { room: "techne" }, ["area"]),
  note(BOUL, "Areas/Boulder", "Uni", { room: "boulder", channel: "9f5dd143-96b1-440a-ab71-812219cdfaa1" }, ["area"]),
  note(COH, "Projects/COhere/COhere 2026", TECH, { room: "cohere" }),
  note(RIC, "Projects/Priya", "[[Areas/Techne]]"),
  note(MAIL, "Projects/Mail", BOUL),
];

await check("refs: ULID shape, link/extension/slash tolerated, resolver matches id, path and link", () => {
  assert.equal(isUlid("01M3ZK2R6A6C62M1ANJCSQNG3M"), true);
  assert.equal(isUlid("Areas/Techne"), false);
  assert.equal(refKey("[[Areas/Techne|Techne]]"), "Areas/Techne");
  assert.equal(refKey("/Areas/Techne.md"), "Areas/Techne");
  const r = pathResolver([{ id: TECH, path: "Areas/Techne" }]);
  assert.equal(r(TECH), "Areas/Techne");
  assert.equal(r("Areas/Techne"), "Areas/Techne");
  assert.equal(r("[[Areas/Techne]]"), "Areas/Techne");
  assert.equal(r("nope"), null);
  assert.equal(r(null), null);
});

await check("task tree: mixed id / path / link parents build one tree; a task's node as id resolves to the path; the root is ROOT by id or path", () => {
  const { nodes, rootPath } = parseNodes(NOTES);
  const t = buildTaskTree(nodes, rootPath);
  assert.equal(t.parent.get("Areas/Techne"), ROOT);
  assert.equal(t.parent.get("Areas/Boulder"), ROOT);
  assert.equal(t.parent.get("Projects/COhere/COhere 2026"), "Areas/Techne");
  assert.equal(t.parent.get("Projects/Priya"), "Areas/Techne");
  assert.equal(t.parent.get("Projects/Mail"), "Areas/Boulder");
  const mk = (node: unknown, id = "t") => parseTask({ id, path: `Tasks/${id}`, tags: ["task"], metadata: { node, state: "open" } }, t)!;
  assert.equal(mk(COH).node, "Projects/COhere/COhere 2026");
  assert.equal(mk("Projects/COhere/COhere 2026").node, "Projects/COhere/COhere 2026");
  assert.equal(mk(`[[Areas/Techne]]`).node, "Areas/Techne");
  assert.equal(mk(U).node, ROOT);
  assert.equal(mk("Uni").node, ROOT);
  assert.equal(mk(undefined).node, ROOT);
  // counts roll up the same whichever form the tasks use
  const list = [mk(COH, "a"), mk("Projects/COhere/COhere 2026", "b"), mk(MAIL, "c"), mk(BOUL, "d")];
  const c = rollUp(t, list);
  assert.equal(c.get("Areas/Techne")!.total, 2);
  assert.equal(c.get("Areas/Boulder")!.total, 2);
  assert.equal(c.get(ROOT)!.total, 4);
});

await check("task tree: an archived parent given as an id is top level; project links written in ids link only (no nesting, no loop); filter keys carry both forms", () => {
  const t = buildTaskTree(parseNodes([note("1", "P/A", "2"), note("2", "P/B", "1"), note("3", "P/C", "9"), note("9", "P/Old", null, { status: "archived" })]).nodes);
  assert.equal(t.parent.get("P/C"), ROOT);
  assert.equal(t.parent.get("P/A"), ROOT);
  assert.equal(t.parent.get("P/B"), "P/A", "a legacy parent ring is broken at its smallest path, as in 0.1.46");
  assert.deepEqual(t.links.get("P/A"), ["P/B"]);
  assert.deepEqual(subtreePaths(t, "P/A").sort(), ["P/A", "P/B"]);
  assert.deepEqual(nodeFilterKeys(t, ["P/A"]).sort(), ["1", "P/A"]);
});

await check("app tree: parents as ids, paths and links; a self or missing parent is top level; project-to-project links never nest (a legacy parent project lends its area)", () => {
  const area = (id: string, path: string, parent: string | null) => parseArea({ id, path, tags: ["area"], metadata: { status: "foreground", ...(parent ? { parent } : {}) }, content: "# x" })!;
  const proj = (id: string, path: string, parent: string) => parseProject({ id, path, tags: ["project"], metadata: { parent } })!;
  const tree = buildTree([area(TECH, "Areas/Techne", U), proj(COH, "Projects/C", TECH), proj(RIC, "Projects/R", "[[Projects/C]]"), proj("x1", "Projects/X", "x2"), proj("x2", "Projects/Y", "x1"), proj("s", "Projects/S", "s"), proj("m", "Projects/M", "01M0000000000000000000GONE")]);
  assert.equal(parentPath(tree, "Projects/C"), "Areas/Techne");
  assert.equal(parentPath(tree, "Projects/R"), "Areas/Techne", "legacy: filed under a project in Techne, shown in Techne, not nested");
  assert.deepEqual(tree.links.get("Projects/R"), ["Projects/C"]);
  assert.equal(parentPath(tree, "Projects/S"), ROOT);
  assert.equal(parentPath(tree, "Projects/M"), ROOT);
  assert.equal(parentPath(tree, "Projects/X"), ROOT);
  assert.equal(parentPath(tree, "Projects/Y"), ROOT);
  assert.deepEqual(ancestry(tree, "Projects/C").map((n) => n.name), ["C", "Techne"]);
  assert.deepEqual(ancestry(tree, "Projects/R").map((n) => n.name), ["R", "C", "Techne"], "rooms still follow the legacy project parent (T-140 fix)");
  assert.deepEqual(ancestry(tree, "Projects/Y").map((n) => n.name), ["Y", "X"], "a legacy ring is broken at its smallest path");
  assert.deepEqual(ancestry(tree, "nowhere"), []);
});

await check("subtree query (T-140): one `node in` request per kind, from the tree in memory, filtering on ids and paths; a node the tree lacks asks nothing", async () => {
  const log: { cmd: string; args: any }[] = [];
  const api = createVaultTasks(async (cmd, args) => { log.push({ cmd, args }); return []; });
  const t = buildTaskTree(parseNodes(NOTES).nodes);
  await api.loadTasks(t, "Areas/Techne");
  assert.deepEqual(log.map((l) => l.cmd), ["vault_query_meta", "vault_query_meta"]);
  const where = log[0].args.metadata.node.in as string[];
  for (const k of ["Areas/Techne", TECH, "Projects/COhere/COhere 2026", COH, "Projects/Priya", RIC]) assert.ok(where.includes(k), k);
  assert.ok(!where.includes("Projects/Mail"));
  log.length = 0;
  assert.deepEqual(await api.loadTasks(buildTaskTree([]), "Areas/Gone"), { tasks: [], truncated: false });
  assert.deepEqual(log, []);
});

const rooms = [{ id: "r-uni", name: "Uni" }, { id: "r-techne", name: "techne" }, { id: "r-cohere", name: "cohere" }, { id: "9f5dd143-96b1-440a-ab71-812219cdfaa1", name: "boulder" }];
const uni = rooms[0];
const rn = (path: string, room: string | null, channels: string[] = []): RoomNode => ({ path, name: path.split("/").pop(), room, channels });

await check("steward: own room, inherited from the nearest ancestor, else #Uni", () => {
  const own = steward([rn("P/Cohere", "cohere"), rn("A/Techne", "techne")], rooms, uni);
  assert.deepEqual([own.room?.id, own.via], ["r-cohere", "own"]);
  const inh = steward([rn("P/Priya", null), rn("A/Techne", "techne")], rooms, uni);
  assert.deepEqual([inh.room?.id, inh.via, inh.from?.path], ["r-techne", "inherited", "A/Techne"]);
  const top = steward([rn("P/Loose", null)], rooms, uni);
  assert.deepEqual([top.room?.id, top.via], ["r-uni", "uni"]);
  assert.deepEqual(steward([], rooms, null), { room: null, via: "uni", from: null });
});

await check("steward: a room that does not exist is skipped (not a dead end); channel ids beat names; a renamed room still resolves by id", () => {
  assert.equal(steward([rn("P/Mail", "mail"), rn("A/Boulder", "civics", ["9f5dd143-96b1-440a-ab71-812219cdfaa1"])], rooms, uni).room?.name, "boulder");
  // the metadata still says #civics but the room is now called boulder: the channel id carries it
  assert.equal(ownRoom({ room: "civics", channels: ["9f5dd143-96b1-440a-ab71-812219cdfaa1"] }, rooms)?.name, "boulder");
  // the id is stale (room deleted) but the name still matches
  assert.equal(ownRoom({ room: "Techne", channels: ["gone"] }, rooms)?.id, "r-techne");
  // an id and a different name: the id wins
  assert.equal(ownRoom({ room: "techne", channels: ["r-cohere"] }, rooms)?.id, "r-cohere");
  assert.equal(ownRoom({ room: "nope", channels: ["nope"] }, rooms), null);
  const skipped = steward([rn("P/Mail", "mail"), rn("A/Boulder", "boulder")], rooms, uni);
  assert.deepEqual([skipped.room?.name, skipped.via], ["boulder", "inherited"]);
});

await check("steward on a cycle of legacy parents terminates: the ring is broken at its smallest path (T-140 fix)", () => {
  const a = parseProject({ id: "a", path: "P/A", tags: ["project"], metadata: { parent: "b", room: "cohere" } })!;
  const b = parseProject({ id: "b", path: "P/B", tags: ["project"], metadata: { parent: "a" } })!;
  const tree = buildTree([a, b]);
  for (const p of ["P/A", "P/B"]) {
    const chain = ancestry(tree, p).map((n) => rn(n.path, typeof n.metadata.room === "string" ? n.metadata.room : null, n.rooms));
    assert.equal(chain.length, p === "P/A" ? 1 : 2);
    assert.equal(steward(chain, rooms, uni).room?.name, "cohere");
  }
});

await check("brief by id: trusted only when it resolves to a note whose path is <node path>/Brief (Areas/Today for the root)", () => {
  const briefs = [{ id: "b-t", path: "Areas/Techne/Brief" }, { id: "b-c", path: "Projects/COhere/COhere 2026/Brief" }, { id: "b-today", path: "Areas/Today.md" }];
  assert.equal(trustedBrief("Areas/Techne", "b-t", briefs)?.id, "b-t");
  assert.equal(trustedBrief("Areas/Techne", "[[Areas/Techne/Brief]]", briefs)?.id, "b-t");
  assert.equal(trustedBrief("Areas/Techne", "Areas/Techne/Brief.md", briefs)?.id, "b-t");
  assert.equal(trustedBrief("Areas/Techne", "b-c", briefs), null, "another node's brief is refused");
  assert.equal(trustedBrief("Areas/Techne", "b-unknown", briefs), null);
  assert.equal(trustedBrief("Areas/Techne", null, briefs), null);
  assert.equal(trustedBrief("", "b-today", briefs)?.id, "b-today");
  assert.equal(trustedBrief("Areas/Boulder", "b-today", briefs), null, "a node cannot adopt Today");
  assert.equal(trustedBrief("Areas/Tech", "b-t", briefs), null, "a prefix is not enough");
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
