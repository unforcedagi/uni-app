// T-111 (0.1.42) rooms nav: priority on tasks, the "Where we are" summary, its privacy rule, the priority write, the layout default.
// Run: node --experimental-strip-types scripts/roomsnav.test.ts
import assert from "node:assert/strict";
import { buildTaskTree, parseNodes, parseTask, priorityOf, type Task } from "../src/areas/taskCore.ts";
import { createVaultTasks } from "../src/areas/vaultTasks.ts";
import { splitTitle, whereWeAre } from "../src/areas/whereCore.ts";

let failed = 0;
const pending: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>) { pending.push(run(name, fn)); }
async function run(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const NOW = Date.parse("2026-10-12T12:00:00Z");
const tree = buildTaskTree(parseNodes([{ id: "u", path: "Uni", tags: ["uni"], metadata: {} }, { id: "a", path: "Areas/Techne", tags: ["area"], metadata: { parent: "Uni" } }, { id: "s", path: "Areas/Sanctum", tags: ["area"], metadata: { parent: "Uni" } }]).nodes, "Uni");
const t = (id: string, node: string, extra: Record<string, unknown> = {}, updatedAt = "2026-10-11T10:00:00Z", tags = ["task"]) =>
  parseTask({ id, path: `Tasks/${id} Title`, tags, updatedAt, metadata: { node, state: "open", owner: "aaron", ...extra } }, tree)!;
const hidden = (n: string) => n === "Areas/Sanctum";

check("priority: now|soon|someday parsed, anything else is unsorted and reads as soon", () => {
  assert.equal(t("a", "Areas/Techne", { priority: "now" }).priority, "now");
  assert.equal(t("b", "Areas/Techne", { priority: "SOMEDAY" }).priority, "someday");
  assert.equal(t("c", "Areas/Techne", { priority: "urgent" }).priority, null);
  const none = t("d", "Areas/Techne");
  assert.equal(none.priority, null); assert.equal(priorityOf(none), "soon");
});
check("where: counts by state; needs you = yours, waiting on you, decisions; split by priority, absent is soon", () => {
  const list: Task[] = [
    t("1", "Areas/Techne", { priority: "now" }), t("2", "Areas/Techne", { state: "doing", priority: "soon" }), t("3", "Areas/Techne"),
    t("4", "Areas/Techne", { priority: "someday" }), t("5", "Areas/Techne", { owner: "uni", state: "waiting" }), t("6", "Areas/Techne", { owner: "room:x", state: "doing" }),
    t("7", "Areas/Techne", { owner: "person:ben", state: "waiting", waiting_on: "aaron" }), t("8", "Areas/Techne", { priority: "now" }, "2026-10-11T10:00:00Z", ["decision"]),
  ];
  const w = whereWeAre({ tasks: list, hidden, nowMs: NOW });
  assert.deepEqual([w.total, w.open, w.doing, w.waiting], [8, 4, 2, 2]);
  assert.equal(w.you, 6);
  assert.deepEqual(w.needs.now.rows.map((x) => x.id).sort(), ["1", "8"]);
  assert.deepEqual(w.needs.soon.rows.map((x) => x.id).sort(), ["2", "3", "7"]);
  assert.deepEqual(w.needs.someday.rows.map((x) => x.id), ["4"]);
});
check("where: moved = changed in the last 7 days, newest first, capped at five", () => {
  const list = [t("old", "Areas/Techne", {}, "2026-10-01T00:00:00Z"), ...[1, 2, 3, 4, 5, 6].map((d) => t(`n${d}`, "Areas/Techne", {}, `2026-10-${String(12 - d).padStart(2, "0")}T13:00:00Z`))];
  const w = whereWeAre({ tasks: list, hidden, nowMs: NOW });
  assert.equal(w.movedCount, 6); assert.equal(w.moved.length, 5);
  assert.deepEqual(w.moved.map((x) => x.id), ["n1", "n2", "n3", "n4", "n5"]);
  assert.equal(w.lastMoved, Date.parse("2026-10-11T13:00:00Z"));
});
check("where: done and archived are not live; snoozed ones are the caller's to drop", () => {
  const w = whereWeAre({ tasks: [t("1", "Areas/Techne", { state: "done" }), t("2", "Areas/Techne", { state: "archived" })], hidden, nowMs: NOW });
  assert.equal(w.total, 0);
});
check("where privacy: tasks under a private node are counted, never named; a private level names none", () => {
  const list = [t("1", "Areas/Techne", { priority: "now" }), t("secret", "Areas/Sanctum", { priority: "now" }), t("secret2", "Areas/Sanctum", { priority: "someday" })];
  const up = whereWeAre({ tasks: list, hidden, nowMs: NOW });
  assert.equal(up.you, 3); assert.equal(up.needs.now.count, 2); assert.deepEqual(up.needs.now.rows.map((x) => x.id), ["1"]);
  assert.equal(up.needs.someday.count, 1); assert.deepEqual(up.needs.someday.rows, []);
  assert.deepEqual(up.moved.map((x) => x.id), ["1"]); assert.equal(up.movedCount, 3);
  const self = whereWeAre({ tasks: [list[1], list[2]], hidden, selfPrivate: true, nowMs: NOW });
  assert.equal(self.you, 2); assert.deepEqual([...self.needs.now.rows, ...self.needs.someday.rows, ...self.moved], []);
  assert.equal(self.movedCount, 2); assert.ok(self.lastMoved);
});
check("splitTitle: the T-NN id and the rest", () => {
  assert.deepEqual(splitTitle("T-65 Sponsorship invoice draft"), { id: "T-65", rest: "Sponsorship invoice draft" });
  assert.deepEqual(splitTitle("FY-14 FableJi remains"), { id: "FY-14", rest: "FableJi remains" });
  assert.deepEqual(splitTitle("Decide the venue"), { id: null, rest: "Decide the venue" });
});
check("setPriority: one vault_patch_meta with the read stamp; null clears; a stale stamp is a conflict result", async () => {
  const sent: any[] = [];
  const api = createVaultTasks(async (cmd, args) => { sent.push({ cmd, args }); if (args.ifUpdatedAt === "stale") throw new Error("conflict: note x has been modified"); return { updatedAt: "T2" }; }, "uni");
  const ok = await api.setPriority("k3", "now", "T1");
  assert.deepEqual(sent, [{ cmd: "vault_patch_meta", args: { vault: "uni", id: "k3", metadata: { priority: "now", priority_by: "hand" }, ifUpdatedAt: "T1" } }]);
  assert.ok(ok.ok && ok.updatedAt === "T2");
  await api.setPriority("k3", null, "T2");
  assert.deepEqual(sent[1].args.metadata, { priority: null, priority_by: null });
  await api.setPriority("k3", "soon", "T2", "weigh.py 2026-10-12");  // undo hands the previous stamp back
  assert.deepEqual(sent[2].args.metadata, { priority: "soon", priority_by: "weigh.py 2026-10-12" });
  const bad = await api.setPriority("k3", "soon", "stale");
  assert.ok(!bad.ok && bad.kind === "conflict");
});

await Promise.all(pending);  // an async check must finish before the exit code is decided
if (failed) { console.log(`${failed} failed`); process.exit(1); }
