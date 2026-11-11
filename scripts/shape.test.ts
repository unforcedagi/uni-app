// T-335 the shape: what the shell decides about rooms before home draws them, and the decisions the chat links to (src/shape/shapeCore.ts).
// Made-up rooms and notes only; "sanctum" is the fixtures' private area.
import assert from "node:assert/strict";
import { decisionsFrom, hiddenRooms, nodeTree, privateRooms, sweepOldKeys } from "../src/shape/shapeCore.ts";
import { parseRegistry } from "../src/areas/roomsRegistry.ts";

const room = (id: string, name: string) => ({ id, name, last_message: null, last_ts: null });
const rooms = [room("c-uni", "Uni"), room("c-kiln", "kiln-studio"), room("c-old", "old-barn"), room("c-fold", "potting-shed"), room("c-quiet", "sanctum"), room("c-sub", "garden/sanctum"), room("c-den", "den")];
const reg = parseRegistry({ registry: { rooms: { uni: { id: "c-uni" }, den: { id: "c-den", private: true } }, retired: { "old-barn": { none: true } }, folded_ids: { "c-fold": "kiln-studio" } } })!;

// a retired name and a folded channel are not rooms any more; with no registry read yet, nothing is hidden
assert.deepEqual([...hiddenRooms(rooms, reg)].sort(), ["c-fold", "c-old"]);
assert.equal(hiddenRooms(rooms, null).size, 0);
// a sub-room is its own room, whatever became of its parent's name; a name that is an Object key is only a name
assert.equal(hiddenRooms([room("c-b", "dev/build"), room("c-k", "constructor")], parseRegistry({ rooms: {}, retired: { dev: { none: true } } })).size, 0);
// a retired name the registry also lists as a live room stays
assert.equal(hiddenRooms([room("c-x", "kiln-studio")], parseRegistry({ rooms: { "kiln-studio": { id: "c-x" } }, retired: { "kiln-studio": { none: true } } })).size, 0);

// private: by a private name (any segment), or by the registry; never by a public name
assert.deepEqual([...privateRooms(rooms, reg)].sort(), ["c-den", "c-quiet", "c-sub"]);
assert.deepEqual([...privateRooms(rooms, null)].sort(), ["c-quiet", "c-sub"]);

// decisions: id, title's T-number, the task it decides, its room by name or id; closed ones and private ones left out
const note = (id: string, path: string, metadata: Record<string, unknown>) => ({ id, path, tags: ["decision"], metadata });
const priv = privateRooms(rooms, reg);
const known = decisionsFrom([
  note("D1", "Decisions/T-12 Pick the glaze", { state: "open", task: "t-130", room: "#kiln-studio" }),
  note("D2", "Decisions/Which hall", { state: "open", room: "c-uni" }),
  note("D3", "Decisions/T-13 Done already", { state: "decided", room: "kiln-studio" }),
  note("D4", "Decisions/T-14 Quiet one", { state: "open", node: "Areas/Sanctum" }),
  note("D5", "Decisions/T-15 In the den", { state: "open", room: "den" }),
  note("D6", "Decisions/T-16 Nowhere", { state: "open", room: "no-such-room" }),
] as never, rooms, priv);
assert.deepEqual(known, [
  { id: "D1", tid: "T-12", forTask: "T-130", channel: "c-kiln" },
  { id: "D2", tid: null, forTask: null, channel: "c-uni" },
  { id: "D6", tid: "T-16", forTask: null, channel: null },
]);

// with the node tree: a decision on a project under a private area (by its parent, whatever its name) is left out; one with no room of
// its own is listed under the room that stewards its node
const node = (id: string, path: string, tags: string[], metadata: Record<string, unknown>) => ({ id, path, tags, metadata, updatedAt: "2026-11-01T00:00:00Z" });
const tree = nodeTree([
  node("n-quiet", "Areas/Sanctum", ["area"], {}), node("n-kiln", "Areas/Kiln", ["area"], { channel: "c-kiln" }),
  node("n-pots", "Projects/Pots", ["project"], { parent: "[[Areas/Kiln]]" }), node("n-hush", "Projects/Hush", ["project"], { parent: "[[Areas/Sanctum]]" }),
] as never);
const placed = decisionsFrom([
  note("E1", "Decisions/T-21 Glaze order", { state: "open", node: "[[Projects/Pots]]" }),
  note("E2", "Decisions/T-22 Hush", { state: "open", node: "Projects/Hush" }),
  note("E3", "Decisions/T-23 Anything", { state: "open" }),
] as never, rooms, priv, tree, "c-uni");
assert.deepEqual(placed, [
  { id: "E1", tid: "T-21", forTask: null, channel: "c-kiln" },
  { id: "E3", tid: "T-23", forTask: null, channel: "c-uni" },
]);

// with the registry: a decision naming a private room by an old name is left out; one naming a retired room goes to its node's room
const reg2 = parseRegistry({ rooms: { den: { id: "c-den", private: true, was: ["old-den"] }, uni: { id: "c-uni" } }, retired: { "old-barn": { none: true } } })!;
const withReg = decisionsFrom([
  note("F1", "Decisions/T-31 Den talk", { state: "open", room: "old-den" }),
  note("F2", "Decisions/T-32 Barn talk", { state: "open", room: "old-barn", node: "Projects/Pots" }),
] as never, rooms, privateRooms(rooms, reg2), tree, "c-uni", { reg: reg2, hidden: hiddenRooms(rooms, reg2) });
assert.deepEqual(withReg, [{ id: "F2", tid: "T-32", forTask: null, channel: "c-kiln" }]);

// a folded room's decision goes to the room its work went to; a node whose steward channel is folded is listed nowhere hidden
const reg3 = parseRegistry({ rooms: { "kiln-studio": { id: "c-kiln" } }, retired: {}, folded_ids: { "c-fold": "kiln-studio" } })!;
const foldTree = nodeTree([node("n-shed", "Areas/Shed", ["area"], { channel: "c-fold" })] as never);
const folded = decisionsFrom([
  note("G1", "Decisions/T-41 Shed talk", { state: "open", room: "potting-shed" }),
  note("G2", "Decisions/T-42 Shed node", { state: "open", node: "Areas/Shed" }),
] as never, rooms, new Set(), foldTree, "c-uni", { reg: reg3, hidden: hiddenRooms(rooms, reg3) });
assert.deepEqual(folded.map((d) => [d.id, d.channel]), [["G1", "c-kiln"], ["G2", "c-uni"]]);
// an old name of a retired room is retired too; a live room's name never is
assert.deepEqual([...hiddenRooms([room("c-b", "barn"), room("c-k", "kiln-studio")], parseRegistry({ rooms: { "kiln-studio": {} }, retired: { "old-barn": { none: true, was: ["barn"] } } }))], ["c-b"]);

// Forget sweeps what the old home kept on the device, and only that
const kept = new Map(Object.entries({ "uni.areas.cache.v2": "x", "uni.areas.cache.v2:uni": "x", "uni.areas.cache.v1": "x", "uni.tasks.saved.v1": "x", "uni.asks.v3:me": "x",
  "uni.noteTitles.uni": "x", "uni.home.layout.v1": "x", "uni.rooms.registry.v1:uni": "x", "uni.tabs.v2": "keep", "uni.asks.owed.v1:me|uni": "keep", "uni.areas.cachedthing": "keep" }));
const store = { get length() { return kept.size; }, key: (i: number) => [...kept.keys()][i] ?? null, removeItem: (k: string) => { kept.delete(k); } };
sweepOldKeys(store);
assert.deepEqual([...kept.keys()].sort(), ["uni.areas.cachedthing", "uni.asks.owed.v1:me|uni", "uni.tabs.v2"]);

console.log("shape: ok");
