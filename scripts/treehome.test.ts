// T-111: the tree home's pure parts — room slash names, held-by, archived-room fallback, updates from below, the phone's row list, the layout setting.
// Run: node --experimental-strip-types scripts/treehome.test.ts
import assert from "node:assert/strict";
import { parseArea, parseProject } from "../src/areas/areasCore.ts";
import { buildTree, ROOT } from "../src/areas/treeCore.ts";
import { ownRoom } from "../src/areas/talkCore.ts";
import { isPrivateNode, privateRoot, roomSlug, roomView, treeRows } from "../src/areas/treeRooms.ts";
import { parseBrief } from "../src/areas/briefCore.ts";
import { HOME_LAYOUT_KEY, migrateHomeLayout } from "../src/areas/homeLayout.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const area = (id: string, name: string, meta: Record<string, unknown> = {}) => parseArea({ id, path: `Areas/${name}`, tags: ["area"], content: `# ${name}\n\nPurpose.`, metadata: { status: "foreground", ...meta } })!;
const proj = (id: string, name: string, parent: string, meta: Record<string, unknown> = {}) => parseProject({ id, path: `Projects/${name}`, tags: ["project"], content: `# ${name}`, metadata: { parent, ...meta } })!;
const ROOMS = [
  { id: "r-uni", name: "Uni" }, { id: "r-bou", name: "boulder" }, { id: "r-coh", name: "cohere" }, { id: "r-ufd", name: "Unforced Dev" }, { id: "r-sad", name: "Sadhana" },
  { id: "r-nt", name: "Boulder New Tech" },
];
const UNI = ROOMS[0];
const tree = buildTree([
  area("a-bou", "Boulder", { room: "boulder" }),
  area("a-ufd", "Unforced Development", { room: "unforced-dev" }),
  area("a-sad", "Sadhana", { room: "sadhana" }),
  area("a-rel", "Relationships"),
  proj("p-coh", "COhere", "Areas/Boulder", { room: "cohere" }),
  proj("p-civ", "Civic", "Areas/Boulder"),
  proj("p-coh26", "COhere 2026", "Projects/COhere", { room: "cohere" }),
  proj("p-nt", "New Tech", "Areas/Boulder", { room: "Boulder New Tech" }),
  proj("p-ric", "Ricki", "Areas/Unforced Development", { room: "ricki", room_status: "archived" }),
  proj("p-ric2", "Ricki Two", "Areas/Unforced Development", { room: "ricki", room_status: "archived", room_fallback: "boulder" }),
  proj("p-sad", "Sit", "Areas/Sadhana", { room: "sit" }),
]);

check("r13: a room is written by its real channel name, never lowercased or re-spaced", () => { assert.equal(roomSlug("Boulder New Tech"), "Boulder New Tech"); assert.equal(roomSlug("#Cohere"), "Cohere"); assert.equal(roomSlug("atlas/build"), "atlas/build"); });
check("an area with a room shows it flat; a project shows its own room's real name: #cohere", () => {
  assert.deepEqual(roomView(tree, "Areas/Boulder", ROOMS, UNI), { target: ROOMS[1], slash: "boulder", heldBy: null, own: true, heldNode: null });
  const v = roomView(tree, "Projects/COhere", ROOMS, UNI);
  assert.equal(v.slash, "cohere"); assert.equal(v.target?.id, "r-coh"); assert.equal(v.own, true);
  assert.equal(roomView(tree, "Projects/New Tech", ROOMS, UNI).slash, "Boulder New Tech");
});
check("a project with no room is held by its area's room, and talk goes there", () => {
  const v = roomView(tree, "Projects/Civic", ROOMS, UNI);
  assert.equal(v.own, false); assert.equal(v.slash, null); assert.equal(v.heldBy?.id, "r-bou"); assert.equal(v.target?.id, "r-bou");
});
check("a project that names the same room as its parent project is held by it, not nested twice", () => {
  const v = roomView(tree, "Projects/COhere 2026", ROOMS, UNI);
  assert.equal(v.own, false); assert.equal(v.heldBy?.id, "r-coh"); assert.equal(v.slash, null);
});
check("an archived room is skipped: no fallback means held by the ancestor; a fallback names the room it borrows", () => {
  const a = roomView(tree, "Projects/Ricki", ROOMS, UNI);
  assert.equal(a.own, false); assert.equal(a.heldBy?.id, "r-ufd"); assert.equal(a.target?.id, "r-ufd");
  const b = roomView(tree, "Projects/Ricki Two", ROOMS, UNI);
  assert.equal(b.own, false); assert.equal(b.heldBy?.id, "r-bou"); assert.equal(b.target?.id, "r-bou");
});
check("an area with no room anywhere is held by #Uni", () => {
  const v = roomView(tree, "Areas/Relationships", ROOMS, UNI);
  assert.equal(v.own, false); assert.equal(v.heldBy?.id, "r-uni"); assert.equal(v.target?.id, "r-uni");
  assert.deepEqual(roomView(tree, ROOT, ROOMS, UNI), { target: UNI, slash: "Uni", heldBy: null, own: true, heldNode: null });
});
check("r13: privateRoot names the private area a node sits in (itself included), else null", () => {
  assert.deepEqual(privateRoot(tree, "Projects/Sit"), { path: "Areas/Sadhana", name: "Sadhana" });
  assert.deepEqual(privateRoot(tree, "Areas/Relationships"), { path: "Areas/Relationships", name: "Relationships" });
  assert.equal(privateRoot(tree, "Projects/COhere"), null);
  assert.equal(isPrivateNode(tree, "Projects/Sit"), true);
});
check("the phone's rows: Uni, then depth-first by foreground and name, with room or held-by", () => {
  const rows = treeRows(tree, ROOMS, UNI);
  assert.equal(rows[0].path, ROOT); assert.equal(rows[0].depth, 0);
  const ri = (p: string) => rows.find((r) => r.path === p)!;
  assert.equal(ri("Areas/Boulder").depth, 1);
  assert.equal(ri("Projects/COhere").depth, 2); assert.equal(ri("Projects/COhere").slash, "cohere");
  assert.equal(ri("Projects/COhere 2026").depth, 3); assert.equal(ri("Projects/COhere 2026").heldBy, "cohere");
  assert.equal(ri("Projects/Civic").heldBy, "boulder");
  const order = rows.map((r) => r.path);
  assert.ok(order.indexOf("Projects/COhere") + 1 === order.indexOf("Projects/COhere 2026"), "a child follows its parent");
});
check("layout setting (r12): a saved Map, Octopus or Classic choice is dropped once; the room layout is all there is", () => {
  for (const was of ["tree", "octopus", "classic", "rooms"]) {
    const m = new Map([[HOME_LAYOUT_KEY, was]]);
    const st = { getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => { m.delete(k); } };
    assert.equal(migrateHomeLayout(st), was); assert.equal(m.has(HOME_LAYOUT_KEY), false);
    assert.equal(migrateHomeLayout(st), null, "the second start finds nothing to migrate");
  }
  assert.equal(migrateHomeLayout(null), null);
});
check("slash: a room line is the room's real name (atlas/build is a channel name; cohere is not boulder/cohere)", () => {
  const rooms = [{ id: "r-uni", name: "Uni" }, { id: "r-atl", name: "atlas" }, { id: "r-bld", name: "atlas/build" }, { id: "r-tch", name: "atlas/teach" }, { id: "r-bou", name: "boulder" }, { id: "r-coh", name: "cohere" }];
  const t = buildTree([area("a-atl", "ATLAS", { room: "atlas" }), area("a-bou", "Boulder", { room: "boulder" }),
    proj("p1", "ATLAS", "Areas/ATLAS", { room: "atlas/build", channel: "r-bld" }), proj("p2", "Learn Vibe Build", "Areas/ATLAS", { room: "atlas/teach" }),
    proj("p3", "Atlas Institute", "Areas/ATLAS", { room: "atlas" }), proj("p4", "COhere", "Areas/Boulder", { room: "cohere" })]);
  const v = (p: string) => roomView(t, p, rooms, rooms[0]);
  assert.equal(v("Projects/ATLAS").slash, "atlas/build"); assert.equal(v("Projects/Learn Vibe Build").slash, "atlas/teach");
  assert.equal(v("Areas/ATLAS").slash, "atlas");
  assert.equal(v("Projects/Atlas Institute").own, false); assert.equal(v("Projects/Atlas Institute").heldBy?.name, "atlas");
  assert.equal(v("Projects/COhere").slash, "cohere", "the channel name, never a path built from the tree");
});
check("ownRoom: channel id first; a name with a slash matches exactly, never as atlasbuild or atlas-build", () => {
  const rooms = [{ id: "7dce", name: "atlas/build" }, { id: "x1", name: "atlas-build" }, { id: "x2", name: "atlasbuild" }, { id: "a1", name: "atlas" }];
  assert.equal(ownRoom({ room: "atlas/teach", channels: ["7dce"] }, rooms)?.id, "7dce", "the id wins over a name that matches nothing");
  assert.equal(ownRoom({ room: "atlas/build", channels: [] }, rooms)?.id, "7dce");
  assert.equal(ownRoom({ room: "#Atlas/Build", channels: [] }, rooms)?.id, "7dce");
  assert.equal(ownRoom({ room: "atlas/build", channels: [] }, [{ id: "x1", name: "atlas-build" }, { id: "x2", name: "atlasbuild" }]), null);
  assert.equal(ownRoom({ room: "atlas-build", channels: [] }, [{ id: "7dce", name: "atlas/build" }]), null);
  assert.equal(ownRoom({ room: "atlas", channels: ["nope"] }, rooms)?.id, "a1");
});
check("an area whose channel points at its child's room does not show that room as its own (Boulder is not #cohere)", () => {
  const t2 = buildTree([area("a-bou", "Boulder", { room: "boulder", channel: "r-coh" }), proj("p-coh", "COhere", "Areas/Boulder", { room: "cohere", channel: "r-coh" })]);
  const b = roomView(t2, "Areas/Boulder", ROOMS, UNI);
  assert.equal(b.slash, "boulder"); assert.equal(b.target?.id, "r-bou");
  assert.equal(roomView(t2, "Projects/COhere", ROOMS, UNI).target?.id, "r-coh");
  const c = roomView(t2, "Projects/COhere", ROOMS, UNI);
  assert.equal(c.own, true, "COhere owns its room even though Boulder's channel names it"); assert.equal(c.slash, "cohere");
  const noBoulderRoom = roomView(t2, "Areas/Boulder", ROOMS.filter((r) => r.id !== "r-bou"), UNI);
  assert.equal(noBoulderRoom.own, false); assert.equal(noBoulderRoom.slash, null); assert.equal(noBoulderRoom.target?.id, "r-uni");
});
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
