// T-122: steering — the change-mark diff, Running/Drafts parsing, the composer placeholder and the companion's lines (T-124).
// Run: node --experimental-strip-types scripts/steer.test.ts
import assert from "node:assert/strict";
import { buildTaskTree, parseNodes, parseTask, type Task } from "../src/areas/taskCore.ts";
import { changedLine, dayLabel, diffDrafts, diffTasks, draftsUnder, marksById, parseDrafts, parseRuns, runsUnder, valueLabel } from "../src/areas/steerCore.ts";
import { ROOT } from "../src/areas/treeCore.ts";
import { chatPlaceholder, firstSentence, quietAgo, standsLine, topNeeds } from "../src/areas/simpleCore.ts";
import { whereWeAre } from "../src/areas/whereCore.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const nd = (id: string, path: string, parent: string | null, tags = ["project"]) => ({ id, path, tags, metadata: parent ? { parent } : {} });
const { nodes, rootPath } = parseNodes([nd("u", "Uni", null, ["uni"]), nd("a-x", "Areas/Atlas", "Uni", ["area"]), nd("p-at", "Projects/ATLAS", "Areas/Atlas"), nd("p-lvb", "Projects/Learn Vibe Build", "Areas/Atlas"), nd("a-t", "Areas/Techne", "Uni", ["area"])]);
const tree = buildTaskTree(nodes, rootPath);
const AT = 1_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
const task = (id: string, node: string, extra: Record<string, unknown> = {}, at = AT - 60_000): Task =>
  parseTask({ id, path: `Tasks/${id} Title`, tags: ["task"], updatedAt: iso(at), metadata: { node, state: "open", owner: "aaron", ...extra } }, tree)!;

check("dayLabel: a due date as a weekday, anything else untouched", () => {
  assert.equal(dayLabel("2026-10-13"), "Tue 10-13");
  assert.equal(dayLabel("2026-10-12"), "Mon 10-12");
  assert.equal(dayLabel("soon"), "soon");
  assert.equal(valueLabel("due", null), "none");
  assert.equal(valueLabel("state", "open"), "open");
});
check("diff: a due date moved after the steer is marked with the old value", () => {
  const before = [task("t7", "Projects/ATLAS", { due: "2026-10-13" }), task("t8", "Projects/ATLAS")];
  const after = [task("t7", "Projects/ATLAS", { due: "2026-10-15" }, AT + 5000), task("t8", "Projects/ATLAS")];
  const marks = diffTasks(before, after, AT);
  assert.deepEqual(marks.map((m) => [m.id, m.field, m.was, m.now]), [["t7", "due", "2026-10-13", "2026-10-15"]]);
  assert.equal(changedLine(marks[0], AT + 10_000), "changed just now · was Tue 10-13");
});
check("diff: a change before the steer (updatedAt <= at) is not an effect of it", () => {
  const before = [task("t7", "Projects/ATLAS", { due: "2026-10-13" })];
  const after = [task("t7", "Projects/ATLAS", { due: "2026-10-15" }, AT - 1)];
  assert.deepEqual(diffTasks(before, after, AT), []);
  assert.deepEqual(diffTasks(before, [task("t7", "Projects/ATLAS", { due: "2026-10-15" }, AT)], AT), []);
});
check("diff: written after but nothing watched differs (a body edit) is not marked", () => {
  const before = [task("t7", "Projects/ATLAS", { due: "2026-10-13" })];
  assert.deepEqual(diffTasks(before, [task("t7", "Projects/ATLAS", { due: "2026-10-13" }, AT + 1)], AT), []);
});
check("diff: several fields on one task give several marks; priority, state, next, owner are watched; a cleared due reads 'none' after", () => {
  const before = [task("t7", "Projects/ATLAS", { due: "2026-10-13", priority: "soon", next: "a", state: "open" })];
  const after = [task("t7", "Projects/ATLAS", { priority: "now", next: "b", state: "doing", owner: "uni" }, AT + 9)];
  const m = diffTasks(before, after, AT);
  assert.deepEqual(m.map((x) => x.field).sort(), ["due", "next", "owner", "priority", "state"]);
  assert.equal(m.find((x) => x.field === "due")!.now, null);
  assert.equal(changedLine(m.find((x) => x.field === "priority")!, AT + 60_000), "changed just now · was soon");
  assert.equal(marksById(m).get("t7")!.length, 5);
  assert.equal(changedLine({ field: "due", was: null, at: AT }, AT + 3 * 60_000), "changed 3m ago · was none");
});
check("diff: a new item is 'added'; an item that left the live list is not marked; the baseline is kept, so a second load still shows the first value", () => {
  const before = [task("t7", "Projects/ATLAS", { due: "2026-10-13" }), task("gone", "Projects/ATLAS")];
  const first = [task("t7", "Projects/ATLAS", { due: "2026-10-14" }, AT + 1000), task("new", "Projects/ATLAS", {}, AT + 2000)];
  const second = [task("t7", "Projects/ATLAS", { due: "2026-10-15" }, AT + 3000), task("new", "Projects/ATLAS", {}, AT + 2000)];
  assert.deepEqual(diffTasks(before, first, AT).map((m) => [m.id, m.field]), [["t7", "due"], ["new", "added"]]);
  const m = diffTasks(before, second, AT);
  assert.equal(m.find((x) => x.id === "t7")!.was, "2026-10-13");
  assert.equal(m.find((x) => x.id === "t7")!.now, "2026-10-15");
  assert.equal(m.some((x) => x.id === "gone"), false);
  assert.equal(changedLine(m.find((x) => x.id === "new")!, AT + 5000), "added just now");
});
check("diff: no updatedAt or an unparseable one is never marked", () => {
  const t = { ...task("t7", "Projects/ATLAS", { due: "2026-10-14" }), updatedAt: null };
  assert.deepEqual(diffTasks([task("t7", "Projects/ATLAS", { due: "2026-10-13" })], [t], AT), []);
  assert.deepEqual(diffTasks([], [{ ...t, updatedAt: "nope" }], AT), []);
});

const run = (id: string, node: string, extra: Record<string, unknown> = {}) => ({ id, path: `Runs/${id}`, updatedAt: iso(AT), metadata: { node, task: "T-07", what: "Draft the SOW", by: "room:atlas/build", state: "running", started: iso(AT - 5000), updated: iso(AT - 1000), ...extra } });
check("runs: parsed from run notes, under the node's subtree, active before finished; bad state or unknown node is dropped", () => {
  const runs = parseRuns([run("r1", "Projects/ATLAS"), run("r2", "Projects/ATLAS", { state: "done", result: "[[Drafts/SOW]]" }), run("r3", "p-lvb", { state: "stalled" }), run("r4", "Areas/Techne"), run("r5", "Projects/ATLAS", { state: "bogus" }), run("r6", "Nowhere/at/all"), run("r7", "Uni", { state: "queued" })], tree);
  assert.deepEqual(runs.map((r) => r.id), ["r1", "r2", "r3", "r4", "r7"]);
  assert.equal(runs[0].what, "Draft the SOW");
  assert.equal(runs[1].result, "[[Drafts/SOW]]");
  assert.deepEqual(runsUnder(tree, "Areas/Atlas", runs).map((r) => r.id), ["r1", "r3", "r2"]);
  assert.deepEqual(runsUnder(tree, "Projects/ATLAS", runs).map((r) => r.id), ["r1", "r2"]);
  assert.deepEqual(runsUnder(tree, ROOT, runs).map((r) => r.id), ["r1", "r4", "r3", "r7", "r2"]);
  assert.deepEqual(parseRuns([], tree), []);
});
const draft = (id: string, extra: Record<string, unknown>, at = AT) => ({ id, path: `Drafts/${id}`, updatedAt: iso(at), metadata: { status: "drafting", ...extra } });
check("drafts: status drafting|ready, node directly or through the task, ready first; others dropped", () => {
  const t7 = task("t7", "Projects/ATLAS");
  t7.title = "T-07 SOW for the commons grant";
  const drafts = parseDrafts([draft("d1", { node: "Projects/ATLAS", task: "T-07" }), draft("d2", { task: "T-07", status: "ready" }), draft("d3", { node: "Areas/Techne" }), draft("d4", { node: "Areas/Techne", status: "published" }), draft("d5", { task: "T-99" })], tree, [t7]);
  assert.deepEqual(drafts.map((d) => d.id), ["d1", "d2", "d3"]);
  assert.equal(drafts[1].node, "Projects/ATLAS");
  assert.deepEqual(draftsUnder(tree, "Areas/Atlas", drafts).map((d) => d.id), ["d2", "d1"]);
});
check("drafts: a status flip after the steer is marked", () => {
  const before = parseDrafts([draft("d1", { node: "Projects/ATLAS" })], tree);
  const after = parseDrafts([draft("d1", { node: "Projects/ATLAS", status: "ready" }, AT + 2000)], tree);
  assert.deepEqual(diffDrafts(before, after, AT).map((m) => [m.id, m.field, m.was, m.now]), [["d1", "status", "drafting", "ready"]]);
});
check("placeholder: names the room; a held node says whose; no room says the node", () => {
  assert.equal(chatPlaceholder({ name: "ATLAS", slash: "atlas/build", heldBy: null }), "Message #atlas/build");
  assert.equal(chatPlaceholder({ name: "Atlas Institute", slash: null, heldBy: "atlas" }), "Message #atlas");
  assert.equal(chatPlaceholder({ name: "Atlas Institute", slash: null, heldBy: "#atlas" }), "Message #atlas");
  assert.equal(chatPlaceholder({ name: "Nowhere", slash: null, heldBy: null }), "Message Nowhere");
});
check("companion: one sentence from the lede, whole however long (r12: clamped on screen, never cut), links as their text", () => {
  assert.equal(firstSentence("Draft out; waiting on Casey. Next up is the map."), "Draft out; waiting on Casey.");
  assert.equal(firstSentence("See [[Projects/X/Note|the note]] for **scope**"), "See the note for scope");
  assert.equal(firstSentence(""), "");
  assert.equal(firstSentence(null), "");
  const long = firstSentence(`${"word ".repeat(60)}end. More.`);
  assert.equal(long, `${"word ".repeat(60)}end.`);
  assert.ok(!long.includes("…"));
});
const decision = (id: string, node: string, extra: Record<string, unknown> = {}, at = AT - 60_000): Task =>
  parseTask({ id, path: `Decisions/${id} Pick one`, tags: ["decision"], updatedAt: iso(at), metadata: { node, state: "open", options: ["Ship it", "Hold"], ...extra } }, tree)!;
check("companion feed: Now before Soon, then due date; Someday is not shown; no cap, no count of the rest", () => {
  const rows = [task("t1", "Projects/ATLAS", { priority: "soon" }), task("t2", "Projects/ATLAS", { priority: "now" }), task("t3", "Projects/ATLAS", { priority: "someday" }), task("t4", "Projects/ATLAS", { priority: "now", due: "2026-10-12" }), task("t5", "Projects/ATLAS", { priority: "soon" })];
  const w = whereWeAre({ tasks: rows, hidden: () => false, nowMs: AT });
  const top = topNeeds(w, "Projects/ATLAS");
  assert.equal(top.length, 4, "someday is out; nothing is cut off");
  assert.deepEqual(top.map((t) => t.priority), ["now", "now", "soon", "soon"]);
  assert.equal(top[0].id, "t4", "the dated Now first");
  const d = decision("d1", "Projects/ATLAS"), far = decision("d2", "Areas/Atlas");
  const mixed = topNeeds(whereWeAre({ tasks: [...rows, far, d], hidden: () => false, nowMs: AT }), "Projects/ATLAS");
  assert.equal(mixed.length, 6, "open decisions are added");
  assert.deepEqual(mixed.slice(0, 2).map((t) => t.priority), ["now", "now"]);
  assert.equal(topNeeds(whereWeAre({ tasks: rows.slice(0, 2), hidden: () => false, nowMs: AT }), "Projects/ATLAS").length, 2);
});
check("decisions: options[] as labels (strings or {label}), at most four, none for a task", () => {
  assert.deepEqual(decision("d1", "Projects/ATLAS").options, ["Ship it", "Hold"]);
  assert.deepEqual(decision("d3", "Projects/ATLAS", { options: [{ label: "A" }, "B", "B", 7, { title: "C" }, "D", "E"] }).options, ["A", "B", "C", "D"]);
  assert.deepEqual(decision("d4", "Projects/ATLAS", { options: "nope" }).options, []);
  assert.deepEqual(task("t9", "Projects/ATLAS", { options: ["x"] }).options, []);
});
check("stands: the node's own sentence with a quiet time; never a count or the description", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  assert.deepEqual(standsLine({ text: "Cohort two opens Oct 15. Grading is next.", at: "2026-10-12T08:00:00Z" }, [], now), { text: "Cohort two opens Oct 15.", ago: "yesterday" });
  assert.deepEqual(standsLine({ text: "Quiet week.", at: null }, [], now), { text: "Quiet week.", ago: "" });
  assert.equal(standsLine(null, [], now), null);
  assert.equal(standsLine({ text: "  ", at: null }, [], now), null);
  const d = decision("T-11", "Projects/ATLAS", {}, Date.parse("2026-10-10T00:00:00Z"));
  const t = task("T-12", "Projects/ATLAS", { state: "doing" }, Date.parse("2026-10-12T00:00:00Z"));
  assert.equal(standsLine(null, [t, d], now)?.text, "Waiting on a decision: Pick one.");
  assert.equal(standsLine(null, [t], now)?.text, "Title is underway.");
  assert.equal(quietAgo("2026-10-13T08:00:00Z", now), "today");
  assert.equal(quietAgo("2026-10-10T08:00:00Z", now), "3 days ago");
  assert.equal(quietAgo("2026-09-20T08:00:00Z", now), "3 weeks ago");
  assert.equal(quietAgo("garbage", now), "");
  // r15: by calendar day on the local clock, and a bare date is that local day (never UTC midnight, the evening before west of UTC)
  const late = new Date(2026, 9, 13, 23, 30).getTime();
  assert.equal(quietAgo(new Date(2026, 9, 13, 0, 30).toISOString(), late), "today", "earlier the same day");
  assert.equal(quietAgo(new Date(2026, 9, 12, 23, 50).toISOString(), new Date(2026, 9, 13, 0, 10).getTime()), "yesterday", "20 minutes ago, across midnight");
  assert.equal(quietAgo("2026-10-13", late), "today");
  assert.equal(quietAgo("2026-10-12", new Date(2026, 9, 13, 0, 5).getTime()), "yesterday");
  // two rooms read at the same moment say the same of the same stamp, whichever form it is written in
  const at = new Date(2026, 9, 13, 9, 0);
  assert.equal(quietAgo(at.toISOString(), late), quietAgo("2026-10-13", late));
});
check("stands: read from the node notes, including Uni's own", () => {
  const withStands = parseNodes([{ id: "u", path: "Uni", tags: ["uni"], metadata: { stands: "All quiet.", stands_at: "2026-10-12T00:00:00Z" } }, { id: "a", path: "Areas/Atlas", tags: ["area"], metadata: { parent: "Uni", stands: "Atlas is moving." } }, { id: "b", path: "Areas/B", tags: ["area"], metadata: { parent: "Uni" } }]);
  const t2 = buildTaskTree(withStands.nodes, withStands.rootPath);
  assert.deepEqual(t2.stands.get(ROOT), { text: "All quiet.", at: "2026-10-12T00:00:00Z" });
  assert.deepEqual(t2.stands.get("Areas/Atlas"), { text: "Atlas is moving.", at: null });
  assert.equal(t2.stands.has("Areas/B"), false);
});
check("runs: the T-125 run notes (summary, worker, started_at, state decision/blocked) and never the note's path", () => {
  const r = parseRuns([
    { id: "n1", path: "Runs/scratch-cohere-ecology", updatedAt: iso(AT), metadata: { node: "Projects/ATLAS", state: "running", summary: "Writing the Canvas Week 7 brief", worker: "sonnet", room: "#atlas/build", started_at: iso(AT - 5000) } },
    { id: "n2", path: "Runs/scratch-no-summary", updatedAt: iso(AT), metadata: { node: "Projects/ATLAS", state: "blocked" } },
    { id: "n3", path: "Runs/done-one", updatedAt: iso(AT), metadata: { node: "Projects/ATLAS", state: "decision", task: "T-07", ended_at: iso(AT) } },
  ], tree);
  assert.deepEqual(r.map((x) => x.state), ["running", "blocked", "decision"]);
  assert.equal(r[0].what, "Writing the Canvas Week 7 brief");
  assert.equal(r[0].by, "sonnet");
  assert.equal(r[0].room, "atlas/build");
  assert.equal(r[0].started, iso(AT - 5000));
  assert.equal(r[1].what, "Working on it");
  assert.equal(r[2].what, "Working on T-07");
  for (const x of r) assert.ok(!/scratch|Runs\//.test(x.what), x.what);
  assert.deepEqual(runsUnder(tree, ROOT, r).map((x) => x.id), ["n1", "n2", "n3"]);
});
await Promise.resolve();
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("steer: all ok");
