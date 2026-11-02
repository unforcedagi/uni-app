// Run: node --experimental-strip-types scripts/all.test.ts
// T-335 All view: the route decider, the interleaved timeline and the send that posts once per chosen room. Made-up places only.
import assert from "node:assert/strict";
import { suggestRoute, routeWords, type RouteRoom } from "../src/all/route.ts";
import { interleave, sendEach, andList, type FeedMessage } from "../src/all/allCore.ts";

const rooms: RouteRoom[] = [
  { id: "ch-north", name: "North Field", slug: "north-field", text: "Hedges, paths and the long meadow. The hedge cutting is booked.", lastTs: 100, lastMine: 90 },
  { id: "ch-kiln", name: "Kiln Studio", slug: "kiln-studio", text: "Firing days and the shared studio. The bisque firing finished; glaze tiles next.", lastTs: 300, lastMine: 50 },
  { id: "ch-bees", name: "Bee Garden", slug: "bees", text: "Hives, the swarm box and the honey harvest.", lastTs: 200, lastMine: null },
];

// 1. a place named: that place, and why
assert.deepEqual(suggestRoute("Can North Field take the spare benches?", rooms), [{ id: "ch-north", why: "names North Field" }]);
// by its slug, as #slug or in words
assert.deepEqual(suggestRoute("#kiln-studio is cold this morning", rooms), [{ id: "ch-kiln", why: "names Kiln Studio" }]);
assert.deepEqual(suggestRoute("tell kiln studio the cones arrived", rooms), [{ id: "ch-kiln", why: "names Kiln Studio" }]);
// two places named: both, in the order named
assert.deepEqual(suggestRoute("Bee Garden and North Field both need the mower", rooms).map((p) => p.id), ["ch-bees", "ch-north"]);
// a name inside another word is not a mention ("northfield" is not "north field"; "beekeeping" is not "bees")
assert.equal(suggestRoute("beekeeping course in spring", rooms)[0].why.startsWith("names"), false);
// 2. the most telling shared word
assert.deepEqual(suggestRoute("Is the honey ready to jar?", rooms), [{ id: "ch-bees", why: "talks about honey" }]);
assert.deepEqual(suggestRoute("the glaze tiles cracked", rooms), [{ id: "ch-kiln", why: "talks about glaze" }]);
// plural folded: "hedges" in the message matches "hedge" talk
assert.equal(suggestRoute("more hedges to cut", rooms)[0].id, "ch-north");
// 3. nothing shared: where you last wrote, else the latest talk
assert.deepEqual(suggestRoute("Remind me at noon", rooms), [{ id: "ch-north", why: "where you last wrote" }]);
assert.deepEqual(suggestRoute("Remind me at noon", rooms.map((r) => ({ ...r, lastMine: null }))), [{ id: "ch-kiln", why: "latest talk" }]);
// a word every place uses tells nothing: it falls through to where you last wrote
assert.deepEqual(suggestRoute("the shared plan", [{ ...rooms[0], text: "shared" }, { ...rooms[1], text: "shared" }]), [{ id: "ch-north", why: "where you last wrote" }]);
// no rooms: no pick
assert.deepEqual(suggestRoute("anything", []), []);
// common words never count
assert.deepEqual(routeWords("The and about it's Kiln's glazes"), ["kiln", "glaze"]);

// interleave: oldest first across rooms, each message once, thread replies out
const m = (ref: string, channel: string, ts: number, root: string | null = null): FeedMessage => ({ ref, channel, author: "a", author_name: "A", ts, body: ref, root });
const feed = interleave(new Map([["ch-north", [m("n1", "ch-north", 10), m("n2", "ch-north", 40), m("r1", "ch-north", 45, "n1")]], ["ch-kiln", [m("k1", "ch-kiln", 20), m("k2", "ch-kiln", 40), m("n2", "ch-north", 40)]]]));
assert.deepEqual(feed.map((x) => x.ref), ["n1", "k1", "k2", "n2"]);
assert.deepEqual(interleave(new Map([["a", [m("x", "a", 1), m("y", "a", 2), m("z", "a", 3)]]]), 2).map((x) => x.ref), ["y", "z"]);

// sendEach: once per chosen room, nowhere else; a retry sends only what failed
const posted: string[] = [];
let failKiln = true;
const post = async (room: string, body: string) => { if (room === "ch-kiln" && failKiln) throw new Error("relay unreachable"); posted.push(`${room}:${body}`); };
const done = new Set<string>();
const first = await sendEach(["ch-north", "ch-kiln", "ch-north"], "hello", post, done);
assert.deepEqual(first, { sent: ["ch-north"], failed: [{ id: "ch-kiln", error: "relay unreachable" }] });
failKiln = false;
const again = await sendEach(["ch-north", "ch-kiln"], "hello", post, done);
assert.deepEqual(again, { sent: ["ch-kiln"], failed: [] });
assert.deepEqual(posted, ["ch-north:hello", "ch-kiln:hello"]);

assert.equal(andList(["A"]), "A");
assert.equal(andList(["A", "B"]), "A and B");
assert.equal(andList(["A", "B", "C"]), "A, B and C");
console.log("all tests passed");
