// T-335 one home: one "needs you" rule and one rooms registry. Made-up data only.
// - scripts/fixtures/needs-disagree.json is uni-tasks' fixture of asks the old rules split on (the app's 3-day badges, its own For you rule,
//   the Python readers), as the vault holds them after uni-tasks' sweep wrote `needs_aaron`. Every count here must be its `needs`.
// - The registry (the vault note System/Rooms) decides which rooms are private and what an old room name means; the app keeps no list.
// Run: node --experimental-strip-types scripts/oneHome.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTaskTree, parseNodes, parseTask, type Task } from "../src/areas/taskCore.ts";
import { needsByRow, needsFeed, needsYou, withWaiting } from "../src/areas/simpleCore.ts";
import { forYou, type Note, type Place } from "../src/foryou/forYouCore.ts";
import { canonRoom, isPrivateRoomName, noneIds, parseRegistry, successorOf } from "../src/areas/roomsRegistry.ts";
import { ROOT } from "../src/areas/treeCore.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n").slice(0, 4).join("\n     ")}`); }
}

type Fix = { now: string; nodes: { id: string; path: string; tags: string[]; metadata: Record<string, unknown> }[]; cards: Note[]; tasks: (Note & { id: string; path: string })[]; needs: string[]; away: string[] };
const FIX = JSON.parse(readFileSync(new URL("./fixtures/needs-disagree.json", import.meta.url), "utf8")) as Fix;
const NOW = Date.parse(FIX.now);
const { nodes, rootPath } = parseNodes(FIX.nodes.map((n) => ({ ...n, metadata: { ...n.metadata, parent: (n.metadata.links as string[] | undefined)?.[0] ? FIX.nodes.find((x) => x.id === (n.metadata.links as string[])[0])?.path : undefined } })));
const tree = buildTaskTree(nodes, rootPath);
const tasks = FIX.tasks.map((n) => parseTask(n as never, tree)).filter((t): t is Task => !!t && t.kind === "task");
const tid = (t: { path: string }) => /T-\d+/.exec(t.path)?.[0] ?? t.path;
const areaOf = (node: string) => FIX.nodes.find((n) => n.id === node || n.path === node);
const placeOf = (node: string): Place => {
  const n = areaOf(node);
  const area = n?.tags.includes("area") ? n : areaOf((n?.metadata.links as string[] | undefined)?.[0] ?? "");
  return { area: area?.path.split("/").pop() ?? null, room: (area?.metadata.room as string) ?? null, private: area?.metadata.private === true, areaPath: area?.path ?? null };
};

check("the asks the old rules split on: For you, the dots, the companion's feed and the doors count one number, the one rule's", () => {
  const want = FIX.needs.length;
  assert.equal(want, 4);
  assert.deepEqual(tasks.filter(needsYou).map(tid).sort(), FIX.needs);
  const fy = forYou({ asks: tasks.map((t) => ({ id: t.id, path: t.path, tags: t.raw?.tags, metadata: t.raw?.metadata, createdAt: t.raw?.createdAt })), cards: FIX.cards, placeOf, me: "aaron", now: NOW, lastLooked: null });
  assert.equal(fy.count, want, "For you's count");
  assert.equal(fy.away, FIX.away.length, "his asks back with their rooms: counted apart, never in the count");
  const dots = needsByRow(tasks, new Set([ROOT]), () => undefined);
  assert.equal([...dots.values()].reduce((a, b) => a + b, 0), want, "the tree's dots and the doors' badges");
  const feed = withWaiting(needsFeed(tasks, (n) => (placeOf(n).private ? { path: "Areas/Hearth", name: "Hearth" } : null)), []);
  assert.equal(feed.total, want, "the companion and the work view");
  assert.equal(feed.privates.reduce((k, p) => k + p.count, 0), 1, "the private room's ask is counted by place only");
});

check("an ask the sweep hasn't reached, or one closed on this device since, is never counted by a rule of the app's own", () => {
  const t = tasks.find((x) => tid(x) === "T-901")!;
  assert.equal(needsYou({ ...t, needsAaron: undefined }), false);
  assert.equal(needsYou({ ...t, owner: "someone-else" }), true, "the field, not the owner, decides");
});

// a made-up registry, in the shape uni-tasks publishes (rooms.json under the note's `registry`)
const REG = parseRegistry({ registry: {
  schema: "rooms/1", home: "commons",
  rooms: { commons: { id: "c-commons", area: "Glade", was: ["old-commons"] }, hearth: { id: "c-hearth", area: "Hearth", private: true, own: true, was: ["ember"] } },
  retired: { hall: { none: true, was: ["front"] }, attic: { private: true, into: "hearth" }, shed: { into: "commons" } },
  folded_ids: { "c-hall": null, "c-shed": "commons" },
} })!;

check("the registry: a private room in it is private under any old name; an old name means the room it became; a name meaning none is no room", () => {
  for (const r of ["hearth", "#Hearth", "room:hearth", "ember", "attic"]) assert.equal(isPrivateRoomName(REG, r), true, r);
  for (const r of ["commons", "old-commons", "shed", "hall", ""]) assert.equal(isPrivateRoomName(REG, r), false, r);
  assert.equal(canonRoom(REG, "old-commons"), "commons");
  assert.equal(canonRoom(REG, "front"), "", "an old name of the room meaning none");
  assert.equal(canonRoom(REG, "c-hall"), "");
  assert.equal(canonRoom(REG, "c-shed"), "commons");
  assert.equal(successorOf(REG, "shed"), "commons");
  assert.equal(successorOf(REG, "attic"), "hearth");
  assert.equal(successorOf(REG, "hall"), null);
  assert.deepEqual([...noneIds(REG)], ["c-hall"]);
  assert.equal(parseRegistry({ nope: 1 }), null);
});

check("a private room the registry names keeps its ask's words out of For you, wherever its node sits", () => {
  const ask: Note = { id: "x", path: "Tasks/T-950 Words for the room", tags: ["task"], metadata: { state: "open", owner: "aaron", node: "n-lamp", reply_room: "ember", card: "Cards/Glade/Lamp", needs_aaron: true, needs_aaron_why: "yes" } };
  const v = forYou({ asks: [ask], cards: FIX.cards, placeOf, me: "aaron", now: NOW, lastLooked: null, privateRoom: (n) => isPrivateRoomName(REG, n) });
  assert.equal(v.yours.length, 0);
  assert.equal(v.count, 1);
  assert.ok(!JSON.stringify(v).includes("Words for the room"));
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall one-home checks passed");
