// T-335 the shape: a room's runs (moving, waiting on you) by channel id, and a run's story from its note. Made-up world, through the real
// workFrom (live.ts), so the privacy rules tested are the ones the app applies.
// Run: node --experimental-strip-types scripts/runs.test.ts
import assert from "node:assert/strict";
import { workFrom } from "../src/projects/live.ts";
import { runStory, runsByRoom } from "../src/shape/runsCore.ts";
import type { ShapeRoom } from "../src/shape/types.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const NOW = Date.parse("2026-11-10T12:00:00Z");
const iso = (agoS: number) => new Date(NOW - agoS * 1000).toISOString();
const note = (id: string, path: string, tags: string[], metadata: Record<string, unknown>) => ({ id, path, tags, metadata, createdAt: iso(7200), updatedAt: iso(60) });
const area = (id: string, name: string, channel: string) => note(id, `Areas/${name}`, ["node", "area"], { channel, room: name.toLowerCase().replace(/ /g, "-") });
const run = (id: string, title: string, md: Record<string, unknown>) => note(id, `Runs/2026-11-10 ${title}`, ["run"], { started_at: iso(2400), ...md });
const live = (md: Record<string, unknown>) => ({ state: "running", doing_now: "Running pnpm", doing_at: iso(60), ...md });

const nodes = [area("a-kiln", "Kiln Studio", "ch-kiln"), area("a-north", "North Field", "ch-north"), area("a-bees", "Bee Garden", "ch-bees"), area("a-sad", "Sanctum", "ch-sad")];
const rooms: ShapeRoom[] = [["ch-kiln", "kiln-studio"], ["ch-north", "north-field"], ["ch-bees", "bee-garden"], ["ch-sad", "sanctum"], ["ch-loose", "loose-ends"], ["ch-quiet", "quiet-room"]]
  .map(([id, name]) => ({ id, name, last_message: null, last_ts: null }));
const hostRooms = rooms.map(({ id, name }) => ({ id, name }));
const runs = [
  run("run-kiln", "Glaze photos", live({ node: "a-kiln", channel: "ch-kiln", live_line: "Sorting the glaze photos" })),
  run("run-kiln-old", "Older kiln run", live({ node: "a-kiln", channel: "ch-kiln", started_at: iso(3000), live_line: "An older step" })),
  run("run-north", "Gravel order", { node: "a-north", channel: "ch-north", state: "blocked", ended_at: iso(600), waiting_on: "aaron", waiting_for: "Pick the gravel colour: grey or buff" }),
  run("run-bees", "Jar count", { node: "a-bees", channel: "ch-bees", state: "blocked", ended_at: iso(600), waiting_on: "uni", waiting_for: "Merge the jar list" }),
  run("run-bees-old", "Old plan", { node: "a-bees", channel: "ch-bees", state: "superseded", ended_at: iso(600), superseded_by: "beesrun2", waiting_on: "aaron", waiting_for: "Pick a hall" }),
  run("run-bees-done", "Finished one", { node: "a-bees", channel: "ch-bees", state: "done", ended_at: iso(600) }),
  // no area holds this room: the run's own channel places it
  run("run-loose", "Loose ends", live({ channel: "ch-loose", live_line: "Tidying the loose ends" })),
  run("run-loose-wait", "Loose decision", { channel: "ch-loose", state: "decision", ended_at: iso(600), waiting_for: "Keep or drop the old list" }),
  // private: the private area's own run, and a run with a public node but the private room's channel
  run("run-sad", "Quiet log", live({ node: "a-sad", channel: "ch-sad", live_line: "Private words about the practice" })),
  run("run-mixed", "Mixed clues", live({ node: "a-kiln", channel: "ch-sad", started_at: iso(100), live_line: "Private words in a public place" })),
  run("run-mixed-2", "Mixed clues 2", live({ channel: "ch-quiet", room: "sanctum", live_line: "More private words" })),
];
const work = workFrom({ nodes, runs, tasks: [], rooms: hostRooms }, NOW);
const by = runsByRoom(work, rooms);
const all = JSON.stringify([...by.values()]);

check("a room an area owns shows its newest live run, with its live line", () => {
  const k = by.get("ch-kiln");
  assert.equal(k?.moving?.id, "run-kiln");
  assert.equal(k?.moving?.line, "Sorting the glaze photos");
  assert.equal(k?.moving?.state, "moving");
  assert.equal(k?.moving?.startedAt, Math.floor((NOW - 2400_000) / 1000));
  assert.equal(k?.waiting, null);
});
check("a run waiting on you shows, with what it waits for", () => {
  const n = by.get("ch-north");
  assert.deepEqual([n?.waiting?.id, n?.waiting?.line, n?.moving], ["run-north", "Pick the gravel colour: grey or buff", null]);
});
check("waiting on Uni, superseded and finished runs show nothing", () => assert.equal(by.has("ch-bees"), false));
check("a room no area owns gets its runs from the run's own channel (a decision with no one named is yours)", () => {
  const l = by.get("ch-loose");
  assert.equal(l?.moving?.line, "Tidying the loose ends");
  assert.equal(l?.waiting?.line, "Keep or drop the old list");
});
check("a private area's runs show nothing, and a private clue keeps a run out of every room", () => {
  assert.equal(by.has("ch-sad"), false);
  assert.equal(by.has("ch-quiet"), false);
  assert.equal(by.get("ch-kiln")?.moving?.id, "run-kiln");           // run-mixed is newer but private: never the kiln's line
  assert.doesNotMatch(all, /Private words|More private/);
});
check("with no private area to hold it, a run in the private room is sealed: no channel, no line, no words", () => {
  const w = workFrom({ nodes: nodes.filter((n) => n.id !== "a-sad"), runs: [run("run-z", "Sealed", live({ channel: "ch-sad", live_line: "Private words" }))], tasks: [], rooms: hostRooms }, NOW);
  assert.equal(w.sessions[0].channel ?? null, null);
  assert.equal(runsByRoom(w, rooms).size, 0);
});
check("a run whose room this device doesn't have shows nowhere", () => {
  const only = runsByRoom(work, rooms.filter((r) => r.id !== "ch-loose"));
  assert.equal(only.has("ch-loose"), false);
});
check("before the rooms are read, a run placed only by an unknown channel shows nowhere (it waits, sealed)", () => {
  const w = workFrom({ nodes, runs: [run("run-x", "Unread room", live({ channel: "ch-unknown", live_line: "Words" }))], tasks: [], rooms: null }, NOW);
  assert.equal(runsByRoom(w, [...rooms, { id: "ch-unknown", name: "x", last_message: null, last_ts: null }]).size, 0);
});
check("a moving run with no live line says what it was asked", () => {
  const w = workFrom({ nodes, runs: [run("run-y", "Quiet worker", { node: "a-kiln", state: "running", started_at: iso(60) })], tasks: [], rooms: hostRooms }, NOW);
  assert.equal(runsByRoom(w, rooms).get("ch-kiln")?.moving?.line, "Quiet worker");
});

const BLOCKED = "# Gravel order T-123\n\n**Blocked after 60 min. Waiting on Aaron:** Pick the gravel colour\n\nPriced two tonnes from both yards.\n\n## Open\n\n- Aaron: pick the colour\n- none\n\n## What it made\n\n- `quotes.md` in the [ [field notes] ]\n\n---\n\nRun on [[Areas/North Field]], worker `mts-northrn1`.\n";
check("a blocked run's story: the wait leads (as you), then summary, open, made; the footer goes", () => {
  const s = runStory(BLOCKED);
  assert.equal(s.title, "Gravel order");
  assert.equal(s.lead, "Blocked after 60 min. Waiting on you: Pick the gravel colour");
  assert.equal(s.summary, "Priced two tonnes from both yards.");
  assert.deepEqual(s.open, ["Aaron: pick the colour"]);
  assert.deepEqual(s.made, ["Quotes.md in the field notes"]);
  assert.deepEqual(s.steps, []);
});
check("a live run's story: its steps, the newest marked now; Working now is the step, not the lead", () => {
  const session = work.sessions.find((x) => x.id === "run-kiln")!;
  const feed = [{ at: NOW - 600_000, kind: "step" as const, text: "Read a file", n: 0 }, { at: NOW - 60_000, kind: "said" as const, text: "Sorting the glaze photos", n: 1 }];
  const s = runStory("# Glaze photos\n\n**Working now:** Sorting the glaze photos\n\nWhy: the log should show every tile.\n", session, feed);
  assert.equal(s.lead, null);
  assert.equal(s.summary, "Why: the log should show every tile.");
  assert.deepEqual(s.steps.map((x) => [x.text, x.now]), [["Read a file", false], ["Sorting the glaze photos", true]]);
  assert.equal(s.steps[0].at, Math.floor((NOW - 600_000) / 1000));
  // with no steps note, the live line is the one step, now
  assert.deepEqual(runStory("**Working now:** Sorting", session).steps.map((x) => [x.text, x.now]), [["Sorting the glaze photos", true]]);
});
check("a run that has stopped marks no step now, even when its old body still says Working now", () => {
  const session = { ...work.sessions.find((x) => x.id === "run-kiln")!, state: "silent" as const, now: null };
  const s = runStory("**Working now:** Old step", session, [{ at: null, kind: "step", text: "Read a file", n: 0 }]);
  assert.deepEqual(s.steps.map((x) => x.now), [false]);
  assert.equal(s.lead, null);
});
check("a body it can't read is the lead, as plain text; an empty one is nothing", () => {
  const s = runStory("just some words\nacross lines {not: markdown}");
  assert.equal(s.lead, "Just some words across lines {not: markdown}");
  assert.deepEqual([s.summary, s.open, s.made, s.steps, s.title], [null, [], [], [], "A run"]);
  assert.deepEqual(runStory(""), { title: "A run", lead: null, steps: [], summary: null, open: [], made: [] });
});
check("a secret in the body never reaches the story", () => {
  const s = runStory("**Done.** Used the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 to deploy");
  assert.doesNotMatch(JSON.stringify(s), /abcdefghijklmnop/);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nruns: all passed");
