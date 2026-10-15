// T-124 r28: Needs you holds only confirmed asks; everything else is Uni's to recheck; one count; waiting runs are rows; summaries dim only for their own node.
// Run: node --experimental-strip-types scripts/simpleR28.test.ts
import assert from "node:assert/strict";
import { buildTaskTree, parseNodes, parseTask, type Task } from "../src/areas/taskCore.ts";
import type { Run } from "../src/areas/steerCore.ts";
import {
  askStamp, confirmationOf, needsByRow, needsFeed, uniPanel, waitingRunParts, withWaiting, ROW_ITEMS, itemForms, taskIdOf, UNRESOLVED,
  type ConfOf, type Resolved,
} from "../src/areas/simpleCore.ts";
import { ROOT } from "../src/areas/treeCore.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const nd = (id: string, path: string, parent: string | null, tags = ["project"]) => ({ id, path, tags, metadata: parent ? { parent } : {} });
const { nodes, rootPath } = parseNodes([nd("u", "Uni", null, ["uni"]), nd("a-x", "Areas/Atlas", "Uni", ["area"]), nd("p-at", "Projects/ATLAS", "Areas/Atlas")]);
const tree = buildTaskTree(nodes, rootPath);
const mk = (n: number, extra: Record<string, unknown> = {}, node = "Projects/ATLAS"): Task =>
  parseTask({ id: `id${n}`, path: `Tasks/T-${n} Do thing ${n}`, tags: ["task"], updatedAt: "2026-10-14T08:00:00.000Z", metadata: { node, state: "open", owner: "aaron", next: `Say go on thing ${n}`, ...extra } }, tree)!;
const NOW = Date.parse("2026-10-15T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
/** the feed's own resolver: the record alone (r31) */
const resolver = (): ConfOf => (t) => confirmationOf(t, NOW);

await check("asked_at is read as itself: the field is askedAt, apart from updated_at", () => {
  const t = mk(1, { asked_at: "2026-10-14T10:00:00+00:00" });
  assert.equal(t.askedAt, "2026-10-14T10:00:00+00:00");
  assert.equal(mk(2).askedAt, undefined, "no asked_at, no askedAt, whatever updated_at says");
  assert.equal(mk(3, { closed: "2026-10-14" }).closed, "2026-10-14");
});




await check("one count, once: asks and waiting runs, deduplicated by task", () => {
  const confirmed = [mk(10, { asked_at: hoursAgo(2) }), mk(11, { asked_at: hoursAgo(2) })];
  const old = mk(12);
  const f0 = needsFeed([...confirmed, old], () => null, null, "2026-10-15", resolver());
  const run = (id: string, task: string | null, state = "decision"): Run => ({ id, path: `Runs/${id}`, node: "Projects/ATLAS", task, what: "Waiting on your answer in #Uni: Ship 0.1.46?", by: "uni", state: state as Run["state"], started: null, updated: null, result: null, room: null });
  const f = withWaiting(f0, [run("r1", null), run("r2", "T-10"), run("r3", "T-12"), run("r4", "T-12")]);
  assert.equal(f.total, 2 + 1 + 1, "T-10's run is already a row; T-12's two runs are one; the unnamed run counts");
  assert.deepEqual((f.waiting ?? []).map((r) => r.id), ["r1", "r3"]);
  assert.deepEqual((f.recheck ?? []).map((t) => t.id), [], "T-12 is waiting on the user now: the run is the live word, so it isn't also rechecked");
  // the panel: the waiting runs are shown in it, so they are not "Show N more"
  const p = uniPanel({ ...f, rows: f.rows }, 1);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rest, f.total - 1 - 2, "total - rows shown - waiting runs shown");
  assert.equal(p.rows.length + (p.waiting?.length ?? 0) + p.rest, f.total, "what is shown plus 'Show N more' is exactly the count");
});

await check("the dots add up to the count: confirmed asks and waiting runs, once each", () => {
  const rows = new Set(["Projects/ATLAS", "Areas/Atlas", ROOT]);
  const tasks = [mk(20, { asked_at: hoursAgo(2) }), mk(21), mk(22, { asked_at: hoursAgo(2) }, "Areas/Atlas")];
  const runs = [
    { node: "Projects/ATLAS", task: null, state: "decision" },
    { node: "Projects/ATLAS", task: "T-20", state: "decision" },
    { node: "Areas/Atlas", task: null, state: "running" },
  ];
  const m = needsByRow(tasks, rows, () => undefined, resolver(), runs);
  assert.equal(m.get("Projects/ATLAS"), 2, "T-20 once (its run is the same item), the unnamed run once; T-21 is a recheck: no dot");
  assert.equal(m.get("Areas/Atlas"), 1);
  assert.equal([...m.values()].reduce((a, b) => a + b, 0), 3);
});

await check("the waiting run's step is the question, never the lead-in with a colon", () => {
  assert.deepEqual(waitingRunParts("Waiting on your answer in #Uni: release 0.1.46 …"), { step: "Release 0.1.46", place: "in #Uni" });
  assert.deepEqual(waitingRunParts("Waiting on your answer in #Uni: Ship 0.1.46?"), { step: "Ship 0.1.46?", place: "in #Uni" });
  assert.deepEqual(waitingRunParts("Waiting on your answer in #atlas/build"), { step: "Waiting on your answer", place: "in #atlas/build" });
  assert.deepEqual(waitingRunParts("Waiting on your answer in #Uni:"), { step: "Waiting on your answer", place: "in #Uni" });
  assert.deepEqual(waitingRunParts("Re-label the map"), { step: "Re-label the map", place: null });
  for (const w of ["Waiting on your answer in #Uni: Pick A or B:", "Waiting on your answer in #Uni:"]) assert.ok(!/[:;,—–-]$/.test(waitingRunParts(w).step), w);
});

await check("a row's list shows at most two whole items; the others are 'and N more'", () => {
  assert.equal(ROW_ITEMS, 2);
  assert.ok(itemForms("a whole item")[0] === "a whole item");
});



if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("simpleR28: all ok");
