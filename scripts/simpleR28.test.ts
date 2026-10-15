// T-124 r28: Needs you holds only confirmed asks; everything else is Uni's to recheck; one count; waiting runs are rows; summaries dim only for their own node.
// Run: node --experimental-strip-types scripts/simpleR28.test.ts
import assert from "node:assert/strict";
import { buildTaskTree, parseNodes, parseTask, type Task } from "../src/areas/taskCore.ts";
import type { Run } from "../src/areas/steerCore.ts";
import {
  askStamp, confirmationOf, chatAbout, checkInResult, ANNOUNCE_GRACE_MS, needsByRow, needsFeed, staleSummary, uniPanel, waitingRunParts, withWaiting, ROW_ITEMS, itemForms, taskIdOf, UNRESOLVED,
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
/** the feed's own resolver, over a table of chat results */
const resolver = (chat: Record<string, "none" | "found" | "failed" | "pending"> = {}): ConfOf => (t) => {
  const look = chat[t.id] === undefined ? { kind: "none" as const } : chat[t.id] === "pending" ? null : chat[t.id] === "found" ? { kind: "found" as const, hit: null } : { kind: chat[t.id] as "failed" | "none" };
  return confirmationOf(true, t.askedAt, look, NOW);
};

await check("asked_at is read as itself: the field is askedAt, apart from updated_at", () => {
  const t = mk(1, { asked_at: "2026-10-14T10:00:00+00:00" });
  assert.equal(t.askedAt, "2026-10-14T10:00:00+00:00");
  assert.equal(mk(2).askedAt, undefined, "no asked_at, no askedAt, whatever updated_at says");
  assert.equal(mk(3, { closed: "2026-10-14" }).closed, "2026-10-14");
});

await check("Needs you holds only confirmed asks; the rest is the recheck list, never counted", () => {
  const tasks = [
    mk(1, { asked_at: hoursAgo(5) }),         // confirmed
    mk(2),                                      // no asked_at: unconfirmed, whatever updated_at
    mk(3, { asked_at: hoursAgo(24 * 5) }),    // old
    mk(4, { asked_at: hoursAgo(-48) }),       // in the future
    mk(5, { asked_at: hoursAgo(5) }),         // related chat since
    mk(6, { asked_at: hoursAgo(5) }),         // chat still being read
    mk(7, { asked_at: hoursAgo(5) }),         // chat couldn't be read
  ];
  const f = needsFeed(tasks, () => null, null, "2026-10-15", resolver({ id5: "found", id6: "pending", id7: "failed" }));
  assert.deepEqual(f.rows.map((t) => t.id), ["id1"]);
  assert.equal(f.total, 1);
  assert.deepEqual((f.recheck ?? []).map((t) => t.id).sort(), ["id2", "id3", "id4", "id5", "id7"]);
  assert.deepEqual((f.checking ?? []).map((t) => t.id), ["id6"], "held back while its room's chat is read: not counted");
  // without a resolver everything is as before (callers that don't confirm)
  assert.equal(needsFeed(tasks, () => null).total, 7);
});

await check("an unrelated edit never confirms: a fresh updated_at with no asked_at is a recheck", () => {
  const t = mk(8, {}); // updatedAt 2026-10-14T08:00Z, within 3 days of NOW
  assert.equal(confirmationOf(true, t.askedAt, { kind: "none" }, NOW).state, "recheck");
  assert.equal(confirmationOf(true, t.askedAt, { kind: "none" }, NOW).why, "no-date");
});

await check("day-only asked_at: today is recent, tomorrow is the future", () => {
  assert.equal(askStamp("2026-10-15", NOW), "recent");
  assert.equal(askStamp("2026-10-16", NOW), "future");
  assert.equal(askStamp("2026-10-11", NOW), "old");
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

// ---- summaries: dimmed only by a task directly on the node
const SUM = "COhere 2026 is live on cohereboulder.org; the fix ships Friday.";
const WRITTEN = "2026-10-14T12:00:00.000Z";
await check("summary case 1: an ask written on the node after the summary dims it", () => {
  const r = staleSummary(SUM, WRITTEN, [], ["2026-10-14T18:30:00.000Z"], [])!;
  assert.equal(r.why, "newer");
});
await check("summary case 2: a task closed on or after the summary's day dims it", () => {
  assert.equal(staleSummary(SUM, WRITTEN, [], [], ["2026-10-14"])!.why, "closed", "the same day counts");
  assert.equal(staleSummary(SUM, WRITTEN, [], [], ["2026-10-15"])!.why, "closed");
  assert.equal(staleSummary(SUM, WRITTEN, [], [], ["2026-10-13"]), null, "closed the day before: the summary already knew");
  assert.equal(staleSummary(SUM, WRITTEN, [], [], [null, "not a date"]), null);
});
await check("summary case 3: nothing newer directly on the node leaves it as written, however much changed elsewhere", () => {
  assert.equal(staleSummary(SUM, WRITTEN, [], ["2026-10-14T11:59:00.000Z", null], []), null, "an ask written before it");
  assert.equal(staleSummary(SUM, WRITTEN, [], [], []), null, "descendants' changes are never passed in");
  assert.equal(staleSummary("Quiet.", null, [], ["2026-10-14T18:30:00.000Z"], ["2026-10-15"]), null, "an undated summary can't be compared");
});

await check("taskIdOf reads the T-NN a run names", () => {
  assert.equal(taskIdOf(mk(30)), "T-30");
  assert.equal(UNRESOLVED.state, "recheck");
});

await check("r28: a room announcing the ask it just re-stated doesn't unconfirm it; related chat past the grace window does", () => {
  const at = "2026-10-15T08:05:41.000Z";
  const sec = (ms: number) => Math.floor(ms / 1000);
  const t0 = new Date(at).getTime();
  const keys = { ids: ["T-65"], words: [] as string[] };
  const announce = [{ ref: "a", ts: sec(t0 + 9_000), body: "I've re-stated each ask: T-65: who pays the $10k sponsorship" }];
  assert.equal(chatAbout({ at, kind: "asked" }, announce, keys), null);
  assert.equal(checkInResult({ at, kind: "asked" }, announce, keys).kind, "none");
  const later = [{ ref: "b", ts: sec(t0 + ANNOUNCE_GRACE_MS + 60_000), body: "T-65 is settled" }];
  assert.equal(checkInResult({ at, kind: "asked" }, later, keys).kind, "found");
  assert.equal(chatAbout({ at, kind: "added" }, announce, keys)?.key, "T-65", "an added (not asked) record keeps the strict rule");
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("simpleR28: all ok");
