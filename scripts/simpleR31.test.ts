// T-145 r31: an ask is current because its record says so, not because chat is quiet. Run: node --experimental-strip-types scripts/simpleR31.test.ts
import assert from "node:assert/strict";
import * as core from "../src/areas/simpleCore.ts";
import { buildTaskTree, parseNodes, parseTask, type Task } from "../src/areas/taskCore.ts";
import { parseRuns, type Run } from "../src/areas/steerCore.ts";
import { askedShown, askStamp, taskIdOf, UNRESOLVED, confirmationOf, currentAt, daysSince, needsByRow, needsFeed, needsYou, reasonShort, summaryLine, unconfirmedLine, withWaiting, type ConfOf } from "../src/areas/simpleCore.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const nd = (id: string, path: string, parent: string | null, tags = ["project"]) => ({ id, path, tags, metadata: parent ? { parent } : {} });
const { nodes, rootPath } = parseNodes([nd("u", "Uni", null, ["uni"]), nd("a-x", "Areas/Atlas", "Uni", ["area"]), nd("p-at", "Projects/ATLAS", "Areas/Atlas")]);
const tree = buildTaskTree(nodes, rootPath);
const NEXT = "Send Harper the new site labels from the board, then say it is done";
const mk = (n: number, extra: Record<string, unknown> = {}, node = "Projects/ATLAS"): Task =>
  parseTask({ id: `id${n}`, path: `Tasks/T-${n} Do thing ${n}`, tags: ["task"], updatedAt: "2026-10-14T08:00:00.000Z", metadata: { node, state: "open", owner: "aaron", next: NEXT, ...extra } } as never, tree)!;
const NOW = Date.parse("2026-10-15T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const resolver = (): ConfOf => (t) => confirmationOf(t, NOW);

await check("1: the chat-scan path is gone: nothing in the core reads a room's messages", () => {
  for (const gone of ["chatAbout", "checkInResult", "checkInCue", "couldntRead", "gateOf", "quotes", "requestKeys", "ANNOUNCE_GRACE_MS", "QUOTE_WORDS", "chatMovedOn", "needsRead", "CONFIRM_WAIT_MS", "checkingAsks", "checkingRoom"])
    assert.equal((core as Record<string, unknown>)[gone], undefined, gone);
  assert.equal(confirmationOf.length, 1, "the answer takes the task's record and the time: no chat, no room, no roster");
});

await check("1: an ask is current when asked_at or confirmed_at (the newer) is within 3 days", () => {
  assert.equal(confirmationOf(mk(1, { asked_at: hoursAgo(5) }), NOW).state, "confirmed");
  assert.equal(confirmationOf(mk(2, { asked_at: hoursAgo(24 * 5) }), NOW).why, "old");
  assert.equal(confirmationOf(mk(3, { asked_at: hoursAgo(24 * 5), confirmed_at: hoursAgo(3) }), NOW).state, "confirmed", "confirmed_at renews an old ask");
  assert.equal(confirmationOf(mk(4, { asked_at: hoursAgo(3), confirmed_at: hoursAgo(24 * 9) }), NOW).state, "confirmed", "an old confirmation does not demote a recent ask");
  assert.equal(confirmationOf(mk(5), NOW).why, "no-date", "no stamp, no confirmation: updated_at is never a fallback");
  assert.equal(confirmationOf(mk(6, { asked_at: hoursAgo(-48) }), NOW).why, "future");
  assert.equal(confirmationOf(mk(7, { asked_at: hoursAgo(5), confirmed_at: hoursAgo(-48) }), NOW).state, "confirmed", "a wrong (future) confirmed_at is passed over for a good asked_at");
  assert.equal(confirmationOf(mk(8, { asked_at: hoursAgo(-1 / 60) }), NOW).state, "confirmed", "a clock a minute ahead is skew");
  assert.equal(askStamp("2026-10-15", NOW), "recent");
  assert.equal(askStamp("2026-10-16", NOW), "future");
  assert.equal(currentAt({ askedAt: "2026-10-10T10:00:00Z", confirmedAt: "2026-10-12T10:00:00Z" }, NOW), "2026-10-12T10:00:00Z");
});

await check("1: the P1 cases cannot change the classification: chat has no way in", () => {
  // Codex's two examples: a cancellation quoting six words of the ask, and talk sharing two words with it. The record is all that is read.
  const t = mk(113, { asked_at: hoursAgo(5) });
  const before = confirmationOf(t, NOW);
  const chat = ["Cancel T-113: Send Harper the new site labels from the board", "the new labels are on the board", "T-113 is off"];
  assert.ok(chat.length);
  assert.deepEqual(confirmationOf({ ...t }, NOW), before);
  assert.equal(before.state, "confirmed", "a valid ask stays valid whatever is said around it");
  const old = mk(114, { asked_at: hoursAgo(24 * 6) });
  assert.equal(confirmationOf(old, NOW).state, "recheck", "an old ask stays unconfirmed whatever is said around it");
});

await check("1: cancelled or superseded is the note's own state, never chat", () => {
  assert.equal(needsYou(mk(20, { asked_at: hoursAgo(2) })), true);
  for (const state of ["done", "archived"]) assert.equal(needsYou(mk(21, { asked_at: hoursAgo(2), state })), false, state);
  assert.equal(needsYou(mk(22, { asked_at: hoursAgo(2), superseded_by: "T-200" })), false, "superseded_by");
  assert.equal(mk(22, { superseded_by: "T-200" }).supersededBy, "T-200");
  assert.equal(parseTask({ id: "x", path: "Tasks/T-23 x", tags: ["task"], metadata: { node: "Projects/ATLAS", state: "dropped", owner: "aaron", next: NEXT } } as never, tree), null, "a dropped task is not a task the app lists");
});

await check("1: the same stored request classifies the same on a cold home and a warm one (P2-2)", () => {
  const tasks = [mk(30, { asked_at: hoursAgo(5) }), mk(31, { asked_at: hoursAgo(24 * 6) }), mk(32, { asked_at: hoursAgo(24 * 5), confirmed_at: hoursAgo(2) }), mk(33)];
  const cold = needsFeed(tasks, () => null, null, "2026-10-15", resolver());
  const warm = needsFeed([...tasks].reverse(), () => null, null, "2026-10-15", resolver());
  const ids = (xs?: Task[]) => (xs ?? []).map((t) => t.id).sort();
  assert.deepEqual(ids(cold.rows), ["id30", "id32"]);
  assert.deepEqual(ids(warm.rows), ids(cold.rows));
  assert.deepEqual(ids(warm.recheck), ids(cold.recheck));
  assert.deepEqual(ids(cold.recheck), ["id31", "id33"]);
  assert.equal(cold.total, 2, "the recheck list is never counted");
});

await check("1: a confirmed row says it was asked on the date of the newer stamp; the reason of one that is not is that date", () => {
  const t = mk(40, { asked_at: "2026-10-11T09:00:00Z", confirmed_at: "2026-10-14T09:00:00Z" });
  assert.equal(t.asked, "2026-10-14T09:00:00Z");
  assert.equal(t.confirmedAt, "2026-10-14T09:00:00Z");
  assert.equal(mk(41, { asked_at: "2026-10-14T09:00:00Z", confirmed_at: "2026-10-11T09:00:00Z" }).asked, "2026-10-14T09:00:00Z");
  assert.equal(mk(42, { asked_at: "2026-10-11T09:00:00Z" }).confirmedAt, undefined);
  assert.equal(reasonShort(mk(43, { asked_at: "2026-10-11T12:00:00Z" }), "2026-10-15"), "asked Oct 11");
  assert.equal(reasonShort(mk(44, { asked_at: "2026-10-09T12:00:00Z", confirmed_at: "2026-10-12T12:00:00Z" }), "2026-10-15"), "asked Oct 12");
  assert.equal(unconfirmedLine("asked Oct 11"), "Asked Oct 11 · not confirmed since");
  assert.equal(unconfirmedLine(null), "Not confirmed since it was written");
  assert.ok(!/chat since|couldn't read/i.test(unconfirmedLine("asked Oct 11") + reasonShort(mk(45), "2026-10-15")));
});

await check("1: waiting runs and dots still add up with the record-only resolver", () => {
  const confirmed = [mk(50, { asked_at: hoursAgo(2) }), mk(51, { asked_at: hoursAgo(2) })];
  const f0 = needsFeed([...confirmed, mk(52)], () => null, null, "2026-10-15", resolver());
  const run = (id: string, task: string | null): Run => ({ id, path: `Runs/${id}`, node: "Projects/ATLAS", task, what: "Waiting on your answer in #Uni: Ship it?", by: "uni", state: "decision", started: null, updated: null, result: null, room: null });
  const f = withWaiting(f0, [run("r1", null), run("r2", "T-50")]);
  assert.equal(f.total, 3);
  const m = needsByRow([...confirmed, mk(52)], new Set(["Projects/ATLAS", "Areas/Atlas", "Uni"]), () => undefined, resolver(), []);
  assert.equal([...m.values()].reduce((a, b) => a + b, 0), 2);
});

await check("1: taskIdOf reads the T-NN a task names; a task the feed has not resolved is a recheck with no date", () => {
  assert.equal(taskIdOf(mk(30)), "T-30");
  assert.deepEqual(UNRESOLVED, { state: "recheck", why: "no-date" });
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
