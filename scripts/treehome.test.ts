// T-111: the tree home's pure parts — room slash names, held-by, archived-room fallback, updates from below, the phone's row list, the layout setting.
// Run: node --experimental-strip-types scripts/treehome.test.ts
import assert from "node:assert/strict";
import { parseArea, parseProject } from "../src/areas/areasCore.ts";
import { buildTree, ROOT } from "../src/areas/treeCore.ts";
import { ownRoom } from "../src/areas/talkCore.ts";
import { fnv1a, isPrivateName, isPrivateNode, isPrivatePath, isPrivateRoom, privateRoot, privateRootIn, roomSlug, roomView, treeRows } from "../src/areas/treeRooms.ts";
import { parseBrief } from "../src/areas/briefCore.ts";
import { HOME_LAYOUT_KEY, migrateHomeLayout } from "../src/areas/homeLayout.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const area = (id: string, name: string, meta: Record<string, unknown> = {}) => parseArea({ id, path: `Areas/${name}`, tags: ["area"], content: `# ${name}\n\nPurpose.`, metadata: { status: "foreground", ...meta } })!;
const proj = (id: string, name: string, parent: string, meta: Record<string, unknown> = {}) => parseProject({ id, path: `Projects/${name}`, tags: ["project"], content: `# ${name}`, metadata: { parent, ...meta } })!;
const ROOMS = [
  { id: "r-uni", name: "Uni" }, { id: "r-bou", name: "boulder" }, { id: "r-coh", name: "cohere" }, { id: "r-ufd", name: "Unforced Dev" }, { id: "r-sad", name: "Sanctum" },
  { id: "r-nt", name: "Boulder New Tech" },
];
const UNI = ROOMS[0];
const tree = buildTree([
  area("a-bou", "Boulder", { room: "boulder" }),
  area("a-ufd", "Unforced Development", { room: "unforced-dev" }),
  area("a-sad", "Sanctum", { room: "sanctum" }),
  area("a-rel", "Relationships"),
  proj("p-coh", "COhere", "Areas/Boulder", { room: "cohere" }),
  proj("p-civ", "Civic", "Areas/Boulder"),
  proj("p-coh26", "COhere 2026", "Areas/Boulder", { room: "cohere", links: ["p-coh"] }),
  proj("p-nt", "New Tech", "Areas/Boulder", { room: "Boulder New Tech" }),
  proj("p-ric", "Priya", "Areas/Unforced Development", { room: "priya", room_status: "archived" }),
  proj("p-ric2", "Priya Two", "Areas/Unforced Development", { room: "priya", room_status: "archived", room_fallback: "boulder" }),
  proj("p-sad", "Sit", "Areas/Sanctum", { room: "sit" }),
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
check("T-140: a project linked to another project does not nest under it or lose its room: both are the area's projects", () => {
  const v = roomView(tree, "Projects/COhere 2026", ROOMS, UNI);
  assert.equal(v.own, true); assert.equal(v.target?.id, "r-coh");
  assert.deepEqual(tree.links.get("Projects/COhere"), ["Areas/Boulder", "Projects/COhere 2026"]);
});
check("an archived room is skipped: no fallback means held by the ancestor; a fallback names the room it borrows", () => {
  const a = roomView(tree, "Projects/Priya", ROOMS, UNI);
  assert.equal(a.own, false); assert.equal(a.heldBy?.id, "r-ufd"); assert.equal(a.target?.id, "r-ufd");
  const b = roomView(tree, "Projects/Priya Two", ROOMS, UNI);
  assert.equal(b.own, false); assert.equal(b.heldBy?.id, "r-bou"); assert.equal(b.target?.id, "r-bou");
});
check("an area with no room anywhere is held by #Uni", () => {
  const v = roomView(tree, "Areas/Relationships", ROOMS, UNI);
  assert.equal(v.own, false); assert.equal(v.heldBy?.id, "r-uni"); assert.equal(v.target?.id, "r-uni");
  assert.deepEqual(roomView(tree, ROOT, ROOMS, UNI), { target: UNI, slash: "Uni", heldBy: null, own: true, heldNode: null });
});
check("r13: privateRoot names the private area a node sits in (itself included), else null", () => {
  assert.deepEqual(privateRoot(tree, "Projects/Sit"), { path: "Areas/Sanctum", name: "Sanctum" });
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
  assert.equal(ri("Projects/COhere 2026").depth, 2); assert.equal(ri("Projects/COhere 2026").via, "Areas/Boulder");
  assert.equal(ri("Projects/Civic").heldBy, "boulder");
  const order = rows.map((r) => r.path);
  assert.ok(order.indexOf("Areas/Boulder") < order.indexOf("Projects/COhere 2026"), "a project follows its area");
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
check("T-190: private names: the two plain ones, any case; the owner's own by a pinned 32-bit FNV-1a; nothing else", () => {
  assert.equal(fnv1a(""), 0x811c9dc5); assert.equal(fnv1a("a"), 0xe40c292c); assert.equal(fnv1a("foobar"), 0xbf9cf968);
  assert.equal(isPrivateName("Sanctum"), true); assert.equal(isPrivateName("RELATIONSHIPS"), true);
  for (const n of ["Techne", "Boulder", "Parachute", "Sanctums", ""]) assert.equal(isPrivateName(n), false, n);
});
check("T-293: a private area that absorbed its parts: items repointed to it are private by that area, a part filed under it is no node", () => {
  // A former part keeps its note at Areas/<Area>/<Part> without the area tag; even tagged, a nested path is never an area.
  const part = (id: string, tags: string[]) => parseArea({ id, path: "Areas/Sanctum/Practice", tags, content: "# Practice", metadata: { room: "sanctum" } });
  assert.equal(part("x-1", []), null); assert.equal(part("x-2", ["area"]), null);
  const t = buildTree([area("a-sad", "Sanctum", { room: "sanctum" }), area("a-bou", "Boulder", { room: "boulder" })]);
  assert.deepEqual([...t.nodes.keys()].sort(), ["Areas/Boulder", "Areas/Sanctum"]);
  // A task, decision or draft whose node was the part now names the area, so the feed sees it as the area's (tree read or not).
  assert.deepEqual(privateRoot(t, "Areas/Sanctum"), { path: "Areas/Sanctum", name: "Sanctum" });
  const byPath = new Map([...t.nodes.values()].map((n) => [n.path, { path: n.path, name: n.name }]));
  assert.deepEqual(privateRootIn({ byPath, parent: new Map() }, "Areas/Sanctum"), { path: "Areas/Sanctum", name: "Sanctum" });
  assert.equal(privateRoot(t, "Areas/Boulder"), null);
});
check("T-335: a private place's rooms, done or archived ones too, and never a room it only borrows", () => {
  const rooms = [UNI, { id: "r-sad", name: "Sanctum" }, { id: "r-old", name: "old-sit" }, { id: "r-older", name: "older-sit" }, { id: "r-bou", name: "boulder" }, { id: "r-gone", name: "gone-work" }];
  const t = buildTree([
    area("a-sad", "Sanctum", { room: "Sanctum" }),
    area("a-rel", "Relationships"),                                                            // private, no room of its own: talks in Uni's
    area("a-bou", "Boulder", { room: "boulder" }),
    proj("p-old", "Old Sit", "Areas/Sanctum", { room: "old-sit", status: "done" }),            // done, under a private area
    proj("p-older", "Older Sit", "Projects/Old Sit", { room: "older-sit", status: "archived" }), // archived, under the done one
    proj("p-gone", "Gone Work", "Areas/Boulder", { room: "gone-work", status: "done" }),       // done, under a public one
  ]);
  assert.equal(isPrivateRoom(t, "r-sad", rooms, UNI), true, "the private area's own room");
  assert.equal(isPrivateRoom(t, "r-old", rooms, UNI), true, "a done project under it");
  assert.equal(isPrivateRoom(t, "r-older", rooms, UNI), true, "archived, under the done one");
  assert.equal(isPrivateRoom(t, "r-uni", rooms, UNI), false, "Uni's room is not private because a private area borrows it");
  assert.equal(isPrivateRoom(t, "r-bou", rooms, UNI), false);
  assert.equal(isPrivateRoom(t, "r-gone", rooms, UNI), false, "done, under a public area");
  assert.equal(isPrivatePath(t, "Projects/Old Sit"), true);
  assert.equal(isPrivatePath(t, "Projects/Older Sit"), true);
  assert.equal(isPrivatePath(t, "Projects/Gone Work"), false);
  assert.equal(isPrivatePath(t, "Areas/Relationships"), true);
  assert.equal(isPrivatePath(t, "Areas/Boulder"), false);
  // a live project reaches a private place only through something done or archived: the tree's walk stops there and it looks top-level
  const rooms2 = [UNI, { id: "r-q", name: "q-room" }, { id: "r-q2", name: "q2-room" }, { id: "r-l", name: "listed" }, { id: "r-bou", name: "boulder" }, { id: "r-pub", name: "pub" }];
  const t2 = buildTree([
    area("a-sad", "Sanctum", { room: "sanctum", links: ["Projects/Listed"] }),
    area("a-bou", "Boulder", { room: "boulder", links: ["Projects/Pub", "Projects/Q2"] }),                 // linking to a private project doesn't make an area private
    proj("p-p", "Done Parent", "Areas/Sanctum", { status: "done" }),
    proj("p-q", "Q", "Projects/Done Parent", { room: "q-room" }),                                          // live, under done, under private
    parseProject({ id: "p-listed", path: "Projects/Listed", tags: ["project"], content: "# Listed", metadata: { status: "done", room: "listed" } })!, // only the area lists it
    proj("p-pub", "Pub", "Areas/Boulder", { room: "pub" }),
  ]);
  const t3 = buildTree([
    area("a-sad", "Sanctum", { room: "sanctum", status: "archived" }),
    proj("p-q2", "Q2", "Areas/Sanctum", { room: "q2-room" }),                                              // live, its private area archived
    proj("p-w", "W", "[[Areas/Sanctum]]", { room: "q-room" }),                                             // the same, written as a wikilink
    area("a-bou", "Boulder", { room: "boulder" }),
  ]);
  assert.equal(isPrivatePath(t2, "Projects/Q"), true, "live, under done, under private");
  assert.equal(isPrivateRoom(t2, "r-q", rooms2, UNI), true);
  assert.equal(isPrivateRoom(t2, "r-l", rooms2, UNI), true, "done, listed only by the private area");
  assert.equal(isPrivatePath(t2, "Areas/Boulder"), false, "an area stays public whatever it links to");
  assert.equal(isPrivateRoom(t2, "r-bou", rooms2, UNI), false);
  assert.equal(isPrivatePath(t2, "Projects/Pub"), false);
  assert.equal(isPrivateRoom(t2, "r-pub", rooms2, UNI), false);
  assert.equal(isPrivatePath(t3, "Projects/Q2"), true, "live, its private area archived");
  assert.equal(isPrivateRoom(t3, "r-q2", rooms2, UNI), true);
  assert.equal(isPrivatePath(t3, "Projects/W"), true, "by a wikilink");
  assert.equal(isPrivatePath(t3, "Areas/Boulder"), false);
  // private only by the tree's walk: what hangs off it is private too
  const roomsN = [UNI, { id: "r-d", name: "d-room" }, { id: "r-r2", name: "r2-room" }, { id: "r-bou", name: "boulder" }];
  const t4 = buildTree([
    area("a-sad", "Sanctum", { room: "sanctum" }),
    area("a-in", "Inner", { parent: "Areas/Sanctum" }),
    proj("p-d", "Done Under", "Areas/Inner", { room: "d-room", status: "done" }),
    proj("p-lv", "Live Under", "Areas/Inner"),
    parseProject({ id: "p-r2", path: "Projects/R2", tags: ["project"], content: "# R2", metadata: { status: "foreground", room: "r2-room", links: ["Projects/Live Under"] } })!,
    area("a-bou", "Boulder", { room: "boulder" }),
  ]);
  assert.equal(isPrivateRoom(t4, "r-d", roomsN, UNI), true, "done, under a node private by the walk");
  assert.equal(isPrivatePath(t4, "Projects/R2"), true, "linked to a live project under it");
  assert.equal(isPrivatePath(t4, "Areas/Boulder"), false);
  // an area's own parent counts, its links don't
  const t5 = buildTree([
    area("a-sad", "Sanctum", { room: "sanctum" }),
    area("a-old", "Old", { parent: "Areas/Sanctum", status: "done" }),
    proj("p-q", "Q", "Areas/Old", { room: "q-room" }),
    proj("p-dn", "Done Here", "Areas/Sanctum", { status: "done" }),
    area("a-up", "Upward", { parent: "Projects/Done Here", room: "up" }),
    area("a-kid", "Kid", { parent: "Areas/Sanctum", links: ["Projects/Q"], room: "kid" }),
    area("a-bou", "Boulder", { room: "boulder", links: ["Projects/Q"] }),
  ]);
  assert.equal(isPrivatePath(t5, "Projects/Q"), true, "live, under a done area under private");
  assert.equal(isPrivatePath(t5, "Areas/Upward"), true, "an area whose parent is a done private project");
  assert.equal(isPrivatePath(t5, "Areas/Kid"), true, "an area under a private one, with links of its own");
  assert.equal(isPrivatePath(t5, "Areas/Boulder"), false, "links never make an area private");
  // however the reference is written
  for (const ref of ["areas/sanctum", "AREAS/SANCTUM", "[[Sanctum]]", "Sanctum", "[[Areas/Sanctum#top]]", "Areas/Sanctum.md", "[[Areas/Sanctum|the quiet]]", "/Areas/Sanctum/"]) {
    const live = buildTree([area("a-sad", "Sanctum", { room: "sanctum" }), proj("p-q", "Q", ref, { room: "q-room" }), area("a-bou", "Boulder", { room: "boulder" })]);
    assert.equal(isPrivatePath(live, "Projects/Q"), true, `parent written ${ref}`);
    const gone = buildTree([proj("p-q", "Q", ref, { room: "q-room" }), area("a-bou", "Boulder", { room: "boulder" })]);
    assert.equal(isPrivatePath(gone, "Projects/Q"), true, `parent written ${ref}, the area not even known`);
    assert.equal(isPrivatePath(live, "Areas/Boulder"), false);
  }
  const filed = buildTree([parseProject({ id: "p-f", path: "Projects/Sanctum/Part", tags: ["project"], content: "# Part", metadata: { status: "foreground", parent: "Nowhere/At all", room: "q-room" } })!, area("a-bou", "Boulder", { room: "boulder" })]);
  assert.equal(isPrivatePath(filed, "Projects/Sanctum/Part"), true, "filed under a private name, with a reference to nothing");
  // a room named privately is private, whoever claims it; a name that only contains the word isn't
  const named = [UNI, { id: "r-s", name: "Sanctum" }, { id: "r-sp", name: "sanctum/practice" }, { id: "r-sg", name: "sanctum-garden" }, { id: "r-bou", name: "boulder" }];
  const noClaim = buildTree([area("a-sad", "Sanctum"), area("a-bou", "Boulder", { room: "boulder" })]);
  assert.equal(isPrivateRoom(noClaim, "r-s", named, UNI), true, "the room of a private area with no room field");
  assert.equal(isPrivateRoom(noClaim, "r-sp", named, UNI), true, "a part of a private name");
  assert.equal(isPrivateRoom(noClaim, "r-sg", named, UNI), false, "only contains the word");
  const noNode = buildTree([area("a-bou", "Boulder", { room: "boulder" })]);
  assert.equal(isPrivateRoom(noNode, "r-s", named, UNI), true, "no such node at all: its note has moved");
  assert.equal(isPrivateRoom(noNode, "r-bou", named, UNI), false);
  // a public area keeps its room when a project sharing it is private only by a link to a private project
  const shared = [UNI, { id: "r-bou", name: "boulder" }, { id: "r-sec", name: "secret" }];
  const share = (pub: Record<string, unknown>) => buildTree([
    area("a-sad", "Sanctum", { room: "sanctum" }),
    area("a-bou", "Boulder", { room: "boulder" }),
    proj("p-sec", "Secret", "Areas/Sanctum", { room: "secret" }),
    parseProject({ id: "p-pub", path: "Projects/Pub", tags: ["project"], content: "# Pub", metadata: { status: "foreground", room: "boulder", links: ["Areas/Boulder", "Projects/Secret"], ...pub } })!,
  ]);
  for (const pub of [{}, { status: "done" }, { room: undefined, channel: "r-bou" }]) {
    const tree5 = share(pub);
    assert.equal(isPrivatePath(tree5, "Areas/Boulder"), false);
    assert.equal(isPrivateRoom(tree5, "r-bou", shared, UNI), false, `the public area's room, with ${JSON.stringify(pub)}`);
    assert.equal(isPrivateRoom(tree5, "r-sec", shared, UNI), true, "the private project's own");
  }
  // a public area that holds its room only by the room's name matching in the tree's own way, not by these exact words
  const loosely = [UNI, { id: "r-ufd", name: "Unforced Dev" }, { id: "r-sec", name: "secret" }];
  const held = buildTree([
    area("a-sad", "Sanctum", { room: "sanctum" }), area("a-ufd", "Unforced Development", { room: "unforced-dev" }), proj("p-sec", "Secret", "Areas/Sanctum", { room: "secret" }),
    parseProject({ id: "p-pub", path: "Projects/Pub", tags: ["project"], content: "# Pub", metadata: { status: "foreground", channel: "r-ufd", links: ["Projects/Secret"] } })!,
  ]);
  assert.equal(roomView(held, "Areas/Unforced Development", loosely, UNI).own, true, "the shape this case needs");
  assert.equal(isPrivateRoom(held, "r-ufd", loosely, UNI), false, "the public area's room, held loosely");
  // two hops through a plain project: the same
  const hop = buildTree([
    area("a-sad", "Sanctum", { room: "sanctum" }), area("a-bou", "Boulder", { room: "boulder" }), proj("p-sec", "Secret", "Areas/Sanctum", { room: "secret" }),
    parseProject({ id: "p-mid", path: "Projects/Mid", tags: ["project"], content: "# Mid", metadata: { status: "foreground", links: ["Projects/Secret"] } })!,
    parseProject({ id: "p-pub", path: "Projects/Pub", tags: ["project"], content: "# Pub", metadata: { status: "foreground", room: "boulder", links: ["Projects/Mid"] } })!,
  ]);
  assert.equal(isPrivateRoom(hop, "r-bou", shared, UNI), false, "two hops");
  // a project really under the private area, in that room: private words are in it, so it stays out
  const under = buildTree([area("a-sad", "Sanctum", { room: "sanctum" }), area("a-bou", "Boulder", { room: "boulder" }), proj("p-in", "In", "Areas/Sanctum", { room: "boulder" })]);
  assert.equal(isPrivateRoom(under, "r-bou", shared, UNI), true, "under the private area itself");
  // no private name anywhere, a cycle: nothing is hidden, and it ends
  const plain = buildTree([area("a-bou", "Boulder", { room: "boulder", links: ["Projects/A"] }), proj("p-a", "A", "Projects/B", { room: "a" }), proj("p-b", "B", "Projects/A", { room: "b" })]);
  for (const n of plain.nodes.keys()) assert.equal(isPrivatePath(plain, n), false, n);
});
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
