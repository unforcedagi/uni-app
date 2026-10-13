// T-111: the tree home's pure parts — room slash names, held-by, archived-room fallback, updates from below, the phone's row list, the layout setting.
// Run: node --experimental-strip-types scripts/treehome.test.ts
import assert from "node:assert/strict";
import { parseArea, parseProject } from "../src/areas/areasCore.ts";
import { buildTree, ROOT } from "../src/areas/treeCore.ts";
import { nestRooms } from "../src/roomNesting.ts";
import { ownRoom } from "../src/areas/talkCore.ts";
import { isPrivateNode, joinSlash, roomSlug, roomView, treeRows, updatesBelow } from "../src/areas/treeRooms.ts";
import { levelAlive } from "../src/areas/treeAlive.ts";
import { parseBrief } from "../src/areas/briefCore.ts";
import { parseHomeLayout } from "../src/areas/homeLayout.ts";

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

check("slug: lower case, spaces to dashes", () => { assert.equal(roomSlug("Boulder New Tech"), "boulder-new-tech"); assert.equal(roomSlug("#Cohere"), "cohere"); });
check("an area with a room shows it flat; a project nests under its area's room: boulder/cohere", () => {
  assert.deepEqual(roomView(tree, "Areas/Boulder", ROOMS, UNI), { target: ROOMS[1], slash: "boulder", heldBy: null, own: true, heldNode: null });
  const v = roomView(tree, "Projects/COhere", ROOMS, UNI);
  assert.equal(v.slash, "boulder/cohere"); assert.equal(v.target?.id, "r-coh"); assert.equal(v.own, true);
  assert.equal(roomView(tree, "Projects/New Tech", ROOMS, UNI).slash, "boulder/boulder-new-tech");
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
  assert.deepEqual(roomView(tree, ROOT, ROOMS, UNI), { target: UNI, slash: "uni", heldBy: null, own: true, heldNode: null });
});
check("updates from below: rooms of their own under the node, active within a day, newest first, not its own room", () => {
  const now = 1_000_000;
  const rooms = [{ id: "r-uni", name: "Uni", last_message: "x", last_ts: now - 10 }, { id: "r-bou", name: "boulder", last_message: "own room line", last_ts: now - 5 }, { id: "r-coh", name: "cohere", last_message: "venue held", last_ts: now - 3600 }, { id: "r-nt", name: "Boulder New Tech", last_message: "old news", last_ts: now - 3 * 86400 }, { id: "r-ufd", name: "Unforced Dev", last_message: "invoice sent", last_ts: now - 600 }, { id: "r-sad", name: "Sadhana", last_message: "sat twenty minutes", last_ts: now - 7200 }, ...[]];
  const b = updatesBelow(tree, "Areas/Boulder", rooms, UNI, now);
  assert.deepEqual(b.map((u) => [u.slash, u.text]), [["boulder/cohere", "venue held"]]);
  const all = updatesBelow(tree, ROOT, rooms, UNI, now);
  assert.deepEqual(all.map((u) => u.slash), ["boulder", "unforced-dev", "boulder/cohere", "sadhana"], "newest first");
  assert.ok(all.some((u) => u.slash === "unforced-dev"), "an area's own room counts for Uni");
  assert.ok(!all.some((u) => u.slash.includes("new-tech")), "older than a day is left out");
});
check("private areas contribute the time only, never the words", () => {
  assert.equal(isPrivateNode(tree, "Projects/Sit"), true);
  assert.equal(isPrivateNode(tree, "Areas/Boulder"), false);
  const rooms = [{ id: "r-sad", name: "Sadhana", last_message: "sat twenty minutes", last_ts: 999_000 }, { id: "r-ufd", name: "Unforced Dev", last_message: "invoice sent", last_ts: 999_500 }];
  const u = updatesBelow(tree, ROOT, rooms, null, 1_000_000);
  assert.equal(u.find((x) => x.name === "Sadhana")!.text, null);
  assert.equal(u.find((x) => x.name === "Unforced Development")!.text, "invoice sent");
});
check("the phone's rows: Uni, then depth-first by foreground and name, with room or held-by", () => {
  const rows = treeRows(tree, ROOMS, UNI);
  assert.equal(rows[0].path, ROOT); assert.equal(rows[0].depth, 0);
  const ri = (p: string) => rows.find((r) => r.path === p)!;
  assert.equal(ri("Areas/Boulder").depth, 1);
  assert.equal(ri("Projects/COhere").depth, 2); assert.equal(ri("Projects/COhere").slash, "boulder/cohere");
  assert.equal(ri("Projects/COhere 2026").depth, 3); assert.equal(ri("Projects/COhere 2026").heldBy, "cohere");
  assert.equal(ri("Projects/Civic").heldBy, "boulder");
  const order = rows.map((r) => r.path);
  assert.ok(order.indexOf("Projects/COhere") + 1 === order.indexOf("Projects/COhere 2026"), "a child follows its parent");
});
check("layout setting: unknown or missing is Tree", () => {
  assert.equal(parseHomeLayout(null), "rooms"); assert.equal(parseHomeLayout("tree"), "tree"); assert.equal(parseHomeLayout("octopus"), "octopus"); assert.equal(parseHomeLayout("classic"), "classic"); assert.equal(parseHomeLayout("x"), "rooms");
});
check("alive: a node with a Brief reads it; a project with none is derived from its summary, the area brief's lines naming it, and the rooms' tasks", () => {
  const briefs = { "Areas/Boulder": { brief: parseBrief("## Now\nBoulder is mostly COhere this week.\n\n## Needs you\n- Confirm the COhere venue deposit\n- Approve the testimony\n\n## Moving\n- COhere tents ordered\n"), updatedAt: null, generatedAt: null } } as never;
  const task = (id: string, title: string, owner: string) => ({ id, path: id, title, kind: "task" as const, node: "Projects/COhere", state: "open" as const, owner, waitingOn: null, due: null, next: "", room: null, snoozedUntil: null, updatedAt: null, lastUpdatedBy: null, lastUpdatedVia: null });
  const own = levelAlive({ tree, path: "Areas/Boulder", node: tree.nodes.get("Areas/Boulder")!, entry: (briefs as never)["Areas/Boulder"], briefs, tasks: [] });
  assert.equal(own.derived, false); assert.equal(own.needs.length, 2); assert.match(own.now, /COhere/);
  const d = levelAlive({ tree, path: "Projects/COhere", node: tree.nodes.get("Projects/COhere")!, entry: null, briefs, tasks: [task("t1", "Crew list pass", "room:cohere"), task("t2", "Pay the deposit", "aaron")] });
  assert.equal(d.derived, true);
  assert.deepEqual(d.needs.map((x) => x.text), ["Confirm the COhere venue deposit"]);
  assert.deepEqual(d.moving.map((x) => x.text), ["COhere tents ordered", "Crew list pass"]);
  assert.equal(d.moving[1].note, "in #cohere");
  const priv = levelAlive({ tree, path: "Projects/Sit", node: tree.nodes.get("Projects/Sit")!, entry: null, briefs, tasks: [task("t3", "Sit longer", "room:sit")] });
  assert.deepEqual(priv.moving, [], "a private area gets no task-derived lines");
});
check("alive: with no room owners (chat null profile) a room-owned task shows no #room note; the uni profile still does", async () => {
  const { setActiveProfile, defaultProfile, packProfile } = await import("../src/areas/profile.ts");
  const task = { id: "t1", path: "t1", title: "Crew list pass", kind: "task" as const, node: "Projects/COhere", state: "open" as const, owner: "room:cohere", waitingOn: null, due: null, next: "", room: null, snoozedUntil: null, updatedAt: "2026-10-12T00:00:00Z" } as never;
  const at = () => levelAlive({ tree, path: "Projects/COhere", node: tree.nodes.get("Projects/COhere")!, entry: null, briefs: {}, tasks: [task] }).moving.map((x) => x.note);
  try {
    setActiveProfile(packProfile("pack", "root")); assert.deepEqual(at(), [undefined]);
    setActiveProfile(defaultProfile()); assert.deepEqual(at(), ["in #cohere"]);
  } finally { setActiveProfile(defaultProfile()); }
});
check("slash: a project room already under the area's name is not doubled; a flat old name still is", () => {
  const rooms = [{ id: "r-uni", name: "Uni" }, { id: "r-atl", name: "atlas" }, { id: "r-bld", name: "atlas/build" }, { id: "r-tch", name: "atlas/teach" }, { id: "r-bou", name: "boulder" }, { id: "r-coh", name: "cohere" }];
  const t = buildTree([area("a-atl", "ATLAS", { room: "atlas" }), area("a-bou", "Boulder", { room: "boulder" }),
    proj("p1", "ATLAS", "Areas/ATLAS", { room: "atlas/build", channel: "r-bld" }), proj("p2", "Learn Vibe Build", "Areas/ATLAS", { room: "atlas/teach" }),
    proj("p3", "Atlas Institute", "Areas/ATLAS", { room: "atlas" }), proj("p4", "COhere", "Areas/Boulder", { room: "cohere" })]);
  const v = (p: string) => roomView(t, p, rooms, rooms[0]);
  assert.equal(v("Projects/ATLAS").slash, "atlas/build"); assert.equal(v("Projects/Learn Vibe Build").slash, "atlas/teach");
  assert.equal(v("Areas/ATLAS").slash, "atlas");
  assert.equal(v("Projects/Atlas Institute").own, false); assert.equal(v("Projects/Atlas Institute").heldBy?.name, "atlas");
  assert.equal(v("Projects/COhere").slash, "boulder/cohere");
  assert.equal(joinSlash(["atlas", "atlas/build"]), "atlas/build"); assert.equal(joinSlash(["atlas", "atlasx"]), "atlas/atlasx");
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
check("nestRooms: children indent under their parent, parent first; orphans keep their full name; flat rooms unchanged", () => {
  const r = (name: string) => ({ name });
  const out = nestRooms([r("build-log"), r("atlas/build"), r("Uni"), r("atlas"), r("atlas/teach"), r("solo/child")]);
  assert.deepEqual(out.map((o) => [o.room.name, o.label, o.child]), [["build-log", "build-log", false], ["Uni", "Uni", false], ["atlas", "atlas", false], ["atlas/build", "build", true], ["atlas/teach", "teach", true], ["solo/child", "solo/child", false]]);
  assert.deepEqual(nestRooms([r("a"), r("b")]).map((o) => o.child), [false, false]);
});
check("an area whose channel points at its child's room does not show that room as its own (Boulder is not #cohere)", () => {
  const t2 = buildTree([area("a-bou", "Boulder", { room: "boulder", channel: "r-coh" }), proj("p-coh", "COhere", "Areas/Boulder", { room: "cohere", channel: "r-coh" })]);
  const b = roomView(t2, "Areas/Boulder", ROOMS, UNI);
  assert.equal(b.slash, "boulder"); assert.equal(b.target?.id, "r-bou");
  assert.equal(roomView(t2, "Projects/COhere", ROOMS, UNI).target?.id, "r-coh");
  const noBoulderRoom = roomView(t2, "Areas/Boulder", ROOMS.filter((r) => r.id !== "r-bou"), UNI);
  assert.equal(noBoulderRoom.own, false); assert.equal(noBoulderRoom.slash, null); assert.equal(noBoulderRoom.target?.id, "r-uni");
});
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
