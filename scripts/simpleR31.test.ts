// T-145 r31: an ask is current because its record says so, not because chat is quiet. Run: node --experimental-strip-types scripts/simpleR31.test.ts
import assert from "node:assert/strict";
import * as core from "../src/areas/simpleCore.ts";
import { buildTaskTree, parseNodes, parseTask, type Task } from "../src/areas/taskCore.ts";
import { swept } from "./swept.ts";
import { parseRuns, type Run } from "../src/areas/steerCore.ts";
import { askedShown, taskIdOf, CONFIRMED, confirmationOf, daysSince, needsByRow, needsFeed, needsYou, summaryLine, unconfirmedLine, withWaiting } from "../src/areas/simpleCore.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const nd = (id: string, path: string, parent: string | null, tags = ["project"]) => ({ id, path, tags, metadata: parent ? { parent } : {} });
const { nodes, rootPath } = parseNodes([nd("u", "Uni", null, ["uni"]), nd("a-x", "Areas/Atlas", "Uni", ["area"]), nd("p-at", "Projects/ATLAS", "Areas/Atlas")]);
const tree = buildTaskTree(nodes, rootPath);
const NEXT = "Send Harper the new site labels from the board, then say it is done";
const mk = (n: number, extra: Record<string, unknown> = {}, node = "Projects/ATLAS"): Task =>
  parseTask({ id: `id${n}`, path: `Tasks/T-${n} Do thing ${n}`, tags: ["task"], updatedAt: "2026-10-14T08:00:00.000Z", metadata: swept({ node, state: "open", owner: "aaron", next: NEXT, ...extra }) } as never, tree)!;
const NOW = Date.parse("2026-10-15T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

await check("1: the chat-scan path is gone: nothing in the core reads a room's messages", () => {
  for (const gone of ["chatAbout", "checkInResult", "checkInCue", "couldntRead", "gateOf", "quotes", "requestKeys", "ANNOUNCE_GRACE_MS", "QUOTE_WORDS", "chatMovedOn", "needsRead", "CONFIRM_WAIT_MS", "checkingAsks", "checkingRoom"])
    assert.equal((core as Record<string, unknown>)[gone], undefined, gone);
  assert.equal(confirmationOf.length, 1, "the answer takes the task's record alone: no chat, no room, no roster, no clock");
});

await check("1: confirmation is the field: needs_aaron true is confirmed; stale is old; resting, no card, no room are away; a room's own task is confirmed", () => {
  assert.deepEqual(confirmationOf(mk(1)), CONFIRMED);
  assert.deepEqual(confirmationOf(mk(2, { needs_aaron: false, needs_aaron_why: "stale" })), { state: "recheck", why: "old" });
  assert.deepEqual(confirmationOf(mk(3, { needs_aaron: false, needs_aaron_why: "no card" })), { state: "recheck", why: "away" });
  assert.deepEqual(confirmationOf(mk(4, { needs_aaron: false, needs_aaron_why: "resting" })), { state: "recheck", why: "away" });
  assert.deepEqual(confirmationOf(mk(5, { needs_aaron: false, needs_aaron_why: "no room" })), { state: "recheck", why: "away" });
  assert.deepEqual(confirmationOf(mk(6, { needs_aaron: false, needs_aaron_why: "not his" })), CONFIRMED, "a room's own task is not an unconfirmed ask");
  assert.deepEqual(confirmationOf(mk(7, { needs_aaron: false })), CONFIRMED, "no reason given: nothing to recheck");
  assert.deepEqual(confirmationOf(mk(8, { asked_at: hoursAgo(24 * 30), needs_aaron: true })), CONFIRMED, "the date is never read: the field is");
});

await check("1: cancelled or superseded is the note's own state, never chat", () => {
  assert.equal(needsYou(mk(20, { asked_at: hoursAgo(2) })), true);
  for (const state of ["done", "archived"]) assert.equal(needsYou(mk(21, { asked_at: hoursAgo(2), state })), false, state);
  assert.equal(needsYou(mk(22, { asked_at: hoursAgo(2), superseded_by: "T-200" })), false, "superseded_by");
  assert.equal(mk(22, { superseded_by: "T-200" }).supersededBy, "T-200");
  assert.equal(parseTask({ id: "x", path: "Tasks/T-23 x", tags: ["task"], metadata: { node: "Projects/ATLAS", state: "dropped", owner: "aaron", next: NEXT } } as never, tree), null, "a dropped task is not a task the app lists");
});

await check("1: the same stored request classifies the same on a cold home and a warm one (P2-2)", () => {
  // (T-335 one home: freshness is uni-tasks' word, in needs_aaron: an old one or one with no date is marked stale there)
  const stale = { needs_aaron: false, needs_aaron_why: "stale" };
  const tasks = [mk(30, { asked_at: hoursAgo(5) }), mk(31, { asked_at: hoursAgo(24 * 9), ...stale }), mk(32, { asked_at: hoursAgo(24 * 5), confirmed_at: hoursAgo(2) }), mk(33, stale)];
  const cold = needsFeed(tasks, () => null, null, "2026-10-15");
  const warm = needsFeed([...tasks].reverse(), () => null, null, "2026-10-15");
  const ids = (xs?: Task[]) => (xs ?? []).map((t) => t.id).sort();
  assert.deepEqual(ids(cold.rows), ["id30", "id32"]);
  assert.deepEqual(ids(warm.rows), ids(cold.rows));
  assert.equal(cold.total, 2);
});

await check("1: a row says it was asked on the date of the newer stamp; the line over one that is not current says why", () => {
  const t = mk(40, { asked_at: "2026-10-11T09:00:00Z", confirmed_at: "2026-10-14T09:00:00Z" });
  assert.equal(t.asked, "2026-10-14T09:00:00Z");
  assert.equal(t.confirmedAt, "2026-10-14T09:00:00Z");
  assert.equal(mk(41, { asked_at: "2026-10-14T09:00:00Z", confirmed_at: "2026-10-11T09:00:00Z" }).asked, "2026-10-14T09:00:00Z");
  assert.equal(mk(42, { asked_at: "2026-10-11T09:00:00Z" }).confirmedAt, undefined);
  assert.equal(unconfirmedLine("asked Oct 11"), "Asked Oct 11 · not confirmed since");
  assert.equal(unconfirmedLine("asked Oct 11", "old"), "Asked Oct 11 · not confirmed since");
  assert.equal(unconfirmedLine("asked Oct 11", "away"), "Asked Oct 11 · back with its room");
  assert.equal(unconfirmedLine(null), "Not confirmed since it was written");
  assert.equal(unconfirmedLine(null, "away"), "Back with its room");
  assert.ok(!/chat since|couldn't read/i.test(unconfirmedLine("asked Oct 11")));
});

await check("1: waiting runs and dots still add up with the record-only resolver", () => {
  const confirmed = [mk(50, { asked_at: hoursAgo(2) }), mk(51, { asked_at: hoursAgo(2) })];
  const stale = mk(52, { needs_aaron: false, needs_aaron_why: "stale" });
  const f0 = needsFeed([...confirmed, stale], () => null, null, "2026-10-15");
  const run = (id: string, task: string | null): Run => ({ id, path: `Runs/${id}`, node: "Projects/ATLAS", task, what: "Waiting on your answer in #Uni: Ship it?", by: "uni", state: "decision", started: null, updated: null, result: null, room: null });
  const f = withWaiting(f0, [run("r1", null), run("r2", "T-50")]);
  assert.equal(f.total, 2, "T-335 one home: a waiting run is listed, never counted");
  const m = needsByRow([...confirmed, stale], new Set(["Projects/ATLAS", "Areas/Atlas", "Uni"]), () => undefined);
  assert.equal([...m.values()].reduce((a, b) => a + b, 0), 2);
});

await check("1: taskIdOf reads the T-NN a task names", () => {
  assert.equal(taskIdOf(mk(30)), "T-30");
});

await check("2: the folded summary is one line: the heading folded into the date and room; older than 2 days says how old", () => {
  assert.equal(summaryLine("Oct 14", "cohere", 1), "Where this stands · Oct 14, #cohere");
  assert.equal(summaryLine("Oct 14", "#cohere", 0), "Where this stands · Oct 14, #cohere");
  assert.equal(summaryLine("Oct 14", "cohere", 2), "Where this stands · Oct 14, #cohere", "two days is not yet old");
  assert.equal(summaryLine("Oct 12", "uni", 3), "Where this stands · Oct 12 (3 days old)");
  assert.equal(summaryLine(null, "uni", null), "Where this stands");
  assert.ok(!/:\s*$/.test(summaryLine("Oct 14", "cohere", 1)));
  assert.equal(daysSince("2026-10-12T20:00:00", Date.parse("2026-10-15T09:00:00")), 3);
  assert.equal(daysSince("2026-10-15T00:10:00", Date.parse("2026-10-15T23:00:00")), 0);
  assert.equal(daysSince("nope"), null);
});

await check("2: one date on a row: an overdue task says only when it was due", () => {
  assert.equal(askedShown("2026-10-13", "asked today", "2026-10-15"), null);
  assert.equal(askedShown("2026-10-20", "asked today", "2026-10-15"), "asked today", "an upcoming due date contradicts nothing");
  assert.equal(askedShown(null, "asked today", "2026-10-15"), "asked today");
  assert.equal(askedShown("2026-10-15", "asked today", "2026-10-15"), "asked today", "due today is not overdue");
});

await check("3: a run's destination is its channel id and its message_ref, read exactly; the guessed fields are not read", () => {
  const t = buildTaskTree([{ path: "Areas/Techne", id: "n1", name: "Techne", kind: "area", metadata: {} } as never], null);
  const base = { node: "Areas/Techne", state: "decision", summary: "Waiting on your answer in #techne: Ship it?", room: "techne" };
  const runs = parseRuns([
    { id: "r1", path: "Runs/a", metadata: { ...base, channel: "chan-techne", message_ref: "ev1" } },
    { id: "r2", path: "Runs/b", metadata: { ...base, message: "guess1", ref: "guess2" } },
    { id: "r3", path: "Runs/c", metadata: base },
  ] as never, t);
  assert.deepEqual(runs.map((r) => [r.channel, r.message]), [["chan-techne", "ev1"], [null, null], [null, null]]);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("simpleR31: all ok");
