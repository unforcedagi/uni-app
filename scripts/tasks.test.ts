// T-86: tasks as Parachute objects — tree from `node` notes, subtree, grouping, roll-up, and the vault writes (mocked transport).
// Run: node --experimental-strip-types scripts/tasks.test.ts
import assert from "node:assert/strict";
import { buildTaskTree, dayOf, failureKind, groupOf, groupTasks, parseNodes, parseTask, rollUp, snoozed, subtreePaths, tasksUnder, tomorrowOf, nodeFilterKeys, type Task } from "../src/areas/taskCore.ts";
import { createVaultTasks } from "../src/areas/vaultTasks.ts";
import { ROOT } from "../src/areas/treeCore.ts";
import { resolveRoom, roomByName } from "../src/areas/talkCore.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const node = (id: string, path: string, parent: string | null, extra: Record<string, unknown> = {}, tags: string[] = ["project"]) => ({ id, path, tags, metadata: { ...(parent ? { parent } : {}), ...extra } });
const NODES = [
  node("u", "Uni", null, {}, ["uni"]),
  node("a-t", "Areas/Techne", "Uni", { room: "techne" }, ["area"]),
  node("a-x", "Areas/Atlas", "[[Uni]]", {}, ["area"]),
  node("p-c", "Projects/COhere", "Areas/Techne"),
  node("p-c26", "Projects/COhere/COhere 2026", "Projects/COhere", { room: "#cohere" }),
  node("p-old", "Projects/Old", "Areas/Techne", { status: "archived" }),
  node("p-loose", "Projects/Loose", "Areas/Missing"),
];
const { nodes, rootPath } = parseNodes(NODES);
const tree = buildTaskTree(nodes, rootPath);

check("tree: parents by path, [[link]] tolerated, missing parent is top level, archived left out, root kept apart", () => {
  assert.equal(rootPath, "Uni");
  assert.deepEqual([...tree.byPath.keys()].sort(), ["Areas/Atlas", "Areas/Techne", "Projects/COhere", "Projects/COhere/COhere 2026", "Projects/Loose"]);
  assert.equal(tree.parent.get("Areas/Atlas"), ROOT);
  assert.equal(tree.parent.get("Projects/Loose"), ROOT);
  assert.equal(tree.parent.get("Projects/COhere/COhere 2026"), "Projects/COhere");
  assert.equal(nodes.find((n) => n.path.endsWith("2026"))!.room, "cohere");
});
check("tree: a parent stored as an id resolves; a cycle is broken at its smallest path; self parent is top level", () => {
  const t = buildTaskTree(parseNodes([node("1", "P/B", "2"), node("2", "P/A", "1"), node("3", "P/S", "P/S")]).nodes);
  assert.equal(t.parent.get("P/A"), ROOT);
  assert.equal(t.parent.get("P/B"), "P/A");
  assert.equal(t.parent.get("P/S"), ROOT);
  assert.deepEqual(subtreePaths(t, "P/A").sort(), ["P/A", "P/B"]);
});
check("subtree paths: the node and everything under it; ROOT is all; unknown is empty", () => {
  assert.deepEqual(subtreePaths(tree, "Areas/Techne").sort(), ["Areas/Techne", "Projects/COhere", "Projects/COhere/COhere 2026"]);
  assert.equal(subtreePaths(tree, ROOT).length, 5);
  assert.deepEqual(subtreePaths(tree, "Nope"), []);
  assert.deepEqual(nodeFilterKeys(tree, ["Areas/Atlas"]).sort(), ["Areas/Atlas", "a-x"]);
});

const task = (id: string, nodeRef: string, extra: Record<string, unknown> = {}, tags = ["task"]) => ({ id, path: `Tasks/${id} Title`, tags, updatedAt: "2026-10-10T10:00:00Z", lastUpdatedBy: "tok", lastUpdatedVia: "api", metadata: { node: nodeRef, state: "open", owner: "aaron", ...extra } });
const parse = (n: ReturnType<typeof task>) => parseTask(n, tree)!;

check("parseTask: node by path, id or [[link]]; bad state is dropped; decision uses open/decided", () => {
  assert.equal(parse(task("t1", "Areas/Techne")).node, "Areas/Techne");
  assert.equal(parse(task("t2", "p-c26")).node, "Projects/COhere/COhere 2026");
  assert.equal(parse(task("t3", "[[Areas/Techne|Techne]]")).node, "Areas/Techne");
  assert.equal(parseTask(task("t4", "Areas/Techne", { state: "bogus" }), tree), null);
  assert.equal(parseTask(task("d1", "Areas/Techne", { state: "done" }, ["decision"]), tree), null);
  const d = parse(task("d2", "Areas/Techne", { state: "open" }, ["decision"]));
  assert.equal(d.kind, "decision");
  assert.equal(d.lastUpdatedBy, "tok");
});

const sample = (): Task[] => [
  parse(task("a", "Projects/COhere/COhere 2026", { due: "2026-10-12" })),
  parse(task("b", "Projects/COhere/COhere 2026", { owner: "room:cohere", state: "doing" })),
  parse(task("c", "Areas/Techne", { owner: "person:casey", state: "waiting", waiting_on: "external" })),
  parse(task("d", "Areas/Techne", { owner: "person:casey", state: "waiting", waiting_on: "aaron", due: "2026-10-20" })),
  parse(task("e", "Areas/Atlas", { owner: "uni" })),
  parse(task("f", "Areas/Techne", { state: "open" }, ["decision"])),
  parse(task("g", ROOT === "" ? "Uni" : "Uni")),
];
check("grouping: You (aaron, waiting on aaron, decisions) / Rooms (room:, uni) / Others; waiting-on-you first, then doing, then due", () => {
  const g = groupTasks(sample());
  assert.deepEqual(g.map((x) => x.group), ["you", "rooms", "others"]);
  assert.deepEqual(g[0].tasks.map((t) => t.id), ["d", "f", "a", "g"]);
  assert.deepEqual(g[1].tasks.map((t) => t.id), ["b", "e"]);
  assert.deepEqual(g[2].tasks.map((t) => t.id), ["c"]);
  assert.equal(groupOf({ owner: "", waitingOn: null, kind: "task" }), "others");
});
check("roll-up: counts include everything beneath; the root counts all, including tasks on the root note", () => {
  const r = rollUp(tree, sample());
  assert.equal(r.get("Projects/COhere/COhere 2026")!.total, 2);
  assert.equal(r.get("Projects/COhere")!.total, 2);
  assert.equal(r.get("Areas/Techne")!.total, 5);
  assert.deepEqual({ ...r.get("Areas/Techne")! }, { you: 3, rooms: 1, others: 1, total: 5 });
  assert.equal(r.get("Areas/Atlas")!.total, 1);
  assert.equal(r.get(ROOT)!.total, 7);
  assert.equal(tasksUnder(tree, "Areas/Techne", sample()).length, 5);
  assert.equal(tasksUnder(tree, ROOT, sample()).length, 7);
});
check("roll-up survives a cycle in the data", () => {
  const t = buildTaskTree(parseNodes([node("1", "P/B", "P/A"), node("2", "P/A", "P/B")]).nodes);
  const r = rollUp(t, [parseTask(task("x", "P/B"), t)!]);
  assert.equal(r.get(ROOT)!.total, 1);
});
check("snooze: hidden only while the date is after today; tomorrow is the next calendar day", () => {
  const now = new Date(2026, 9, 31, 22, 0);
  assert.equal(tomorrowOf(now), "2026-11-01");
  assert.equal(dayOf(now), "2026-10-31");
  assert.equal(snoozed({ snoozedUntil: "2026-11-01" }, now), true);
  assert.equal(snoozed({ snoozedUntil: "2026-10-31" }, now), false);
  assert.equal(snoozed({ snoozedUntil: null }, now), false);
});
check("failure kinds: 409 transition_conflict, 422 schema_validation, other", () => {
  assert.equal(failureKind("MCP error -32600: [transition_conflict] conflict: note x"), "conflict");
  assert.equal(failureKind("[schema_validation] state is not one of"), "invalid");
  assert.equal(failureKind("hub unreachable"), "error");
});

type Log = { cmd: string; args: Record<string, unknown> }[];
const mock = (answers: Record<string, (args: any) => unknown>) => { const log: Log = []; return { log, call: async (cmd: string, args: Record<string, unknown>) => { log.push({ cmd, args }); const f = answers[cmd]; if (!f) throw new Error("unexpected " + cmd); const v = f(args); if (v instanceof Error) throw v; return v; } }; };

const unknownParam = () => new Error("MCP error -32602: unknown parameter: near.then");
await check("one-request path: loadTasks sends a fixed near+then shape per kind, detects support, and does not walk the tree", async () => {
  const m = mock({ vault_subtree_tasks: (a) => (a.tag === "task" ? [task("t", "p-c26")] : [task("d", "Areas/Techne", {}, ["decision"])]), vault_query_meta: () => [] });
  const api = createVaultTasks(m.call);
  const t = buildTaskTree(parseNodes(NODES).nodes);
  const { tasks } = await api.loadTasks(t, "Areas/Techne");
  assert.deepEqual(m.log.map((l) => l.cmd), ["vault_subtree_tasks", "vault_subtree_tasks"]);
  assert.deepEqual(m.log[0].args, { vault: "uni", tag: "task", root: "a-t", states: ["open", "doing", "waiting"], limit: 200 });
  assert.deepEqual(m.log[1].args, { vault: "uni", tag: "decision", root: "a-t", states: ["open"], limit: 200 });
  assert.deepEqual(tasks.map((x) => x.id).sort(), ["d", "t"]);
  assert.equal(api.nearSupported(), true);
  await api.loadTasks(t, ROOT); // the root is "everything": a plain state filter, no near
  assert.deepEqual(m.log.slice(2).map((l) => l.cmd), ["vault_query_meta", "vault_query_meta"]);
  assert.equal("node" in (m.log.at(-1)!.args.metadata as object), false);
});
await check("one-request path: an unknown-parameter error falls back to the two-query walk, once per session", async () => {
  const m = mock({ vault_subtree_tasks: unknownParam, vault_query_meta: (a) => (a.tag === "task" ? [task("t", "p-c26")] : []) });
  const api = createVaultTasks(m.call);
  const t = buildTaskTree(parseNodes(NODES).nodes);
  const a = await api.loadTasks(t, "Areas/Techne");
  assert.deepEqual(a.tasks.map((x) => x.id), ["t"]);
  assert.equal(api.nearSupported(), false);
  const tried = m.log.filter((l) => l.cmd === "vault_subtree_tasks").length;
  await api.loadTasks(t, "Areas/Techne");
  assert.equal(m.log.filter((l) => l.cmd === "vault_subtree_tasks").length, tried, "not retried after detection");
  assert.equal(m.log.filter((l) => l.cmd === "vault_query_meta").length, 4);
});
await check("one-request path: a network error is thrown, not mistaken for a missing feature", async () => {
  const m = mock({ vault_subtree_tasks: () => new Error("hub unreachable"), vault_query_meta: () => [] });
  const api = createVaultTasks(m.call);
  const t = buildTaskTree(parseNodes(NODES).nodes);
  await assert.rejects(api.loadTasks(t, "Areas/Techne"), /hub unreachable/);
  assert.equal(api.nearSupported(), null);
  assert.equal(m.log.some((l) => l.cmd === "vault_query_meta"), false);
});
await check("a node the vault can't anchor on (not_found) falls back for that call without turning the feature off", async () => {
  const m = mock({ vault_subtree_tasks: () => new Error("Anchor note not found"), vault_query_meta: () => [task("t", "Areas/Techne")] });
  const api = createVaultTasks(m.call);
  const t = buildTaskTree(parseNodes(NODES).nodes);
  assert.equal((await api.loadTasks(t, "Areas/Techne")).tasks.length, 1);
  assert.equal(api.nearSupported(), null);
});
await check("loadSubtree: one near request for the nodes; the anchor is always included", async () => {
  const m = mock({ vault_subtree_nodes: () => NODES.filter((n) => String(n.path).startsWith("Projects/COhere")) });
  const api = createVaultTasks(m.call);
  const s = await api.loadSubtree("Areas/Techne");
  assert.deepEqual(m.log, [{ cmd: "vault_subtree_nodes", args: { vault: "uni", root: "Areas/Techne" } }]);
  assert.ok(s.paths.includes("Areas/Techne") && s.paths.includes("Projects/COhere/COhere 2026"));
});
await check("a node the loaded tree lacks is resolved with loadSubtree before the two-query walk", async () => {
  const m = mock({ vault_subtree_tasks: () => new Error("Anchor note not found"), vault_subtree_nodes: () => [{ id: "z", path: "Projects/Late", tags: ["node"], metadata: { parent: "Areas/Techne" } }], vault_query_meta: (a) => (a.tag === "task" ? [task("t", "Projects/Late")] : []) });
  const api = createVaultTasks(m.call);
  const t = buildTaskTree(parseNodes(NODES).nodes);
  assert.equal((await api.loadTasks(t, "Projects/Late")).tasks.length, 1);
  const meta = m.log.find((l) => l.cmd === "vault_query_meta")!.args.metadata as any;
  assert.deepEqual(meta.node.in, ["Projects/Late", "z"]);
});

await check("fallback: loadTree queries the node tag without content; loadTasks sends the subtree paths+ids and the live states", async () => {
  const m = mock({ vault_query: () => NODES, vault_subtree_tasks: unknownParam, vault_query_meta: (a) => (a.tag === "task" ? [task("t", "p-c26")] : [task("d", "Areas/Techne", {}, ["decision"])]) });
  const api = createVaultTasks(m.call);
  const t = await api.loadTree();
  assert.deepEqual(m.log[0], { cmd: "vault_query", args: { vault: "uni", tag: "node", includeContent: false, limit: 200 } });
  const { tasks } = await api.loadTasks(t, "Areas/Techne");
  const q = m.log.filter((l) => l.cmd === "vault_query_meta");
  assert.equal(q.length, 2);
  const meta = q[0].args.metadata as any;
  assert.deepEqual(meta.state, { in: ["open", "doing", "waiting"] });
  assert.ok(meta.node.in.includes("Projects/COhere/COhere 2026") && meta.node.in.includes("p-c26") && !meta.node.in.includes("Areas/Atlas"));
  assert.deepEqual((q[1].args.metadata as any).state, { in: ["open"] });
  assert.deepEqual(tasks.map((x) => x.id).sort(), ["d", "t"]);
  await api.loadTasks(t, ROOT);
  assert.equal("node" in (m.log.at(-1)!.args.metadata as object), false);
});
await check("transition(): 200 sends a state_transition with from/to; 409 and 422 are classified, never retried", async () => {
  const m = mock({ vault_transition: (a) => (a.id === "ok" ? { id: "ok", updatedAt: "T2", lastUpdatedBy: "u", lastUpdatedVia: "api" } : new Error(a.id === "stale" ? "[transition_conflict] conflict: note stale" : "[schema_validation] state is not one of")) });
  const api = createVaultTasks(m.call);
  assert.deepEqual(await api.transition("ok", "open", "done"), { ok: true, updatedAt: "T2", lastUpdatedBy: "u", lastUpdatedVia: "api" });
  assert.deepEqual(m.log[0], { cmd: "vault_transition", args: { vault: "uni", id: "ok", from: "open", to: "done" } });
  const stale = await api.transition("stale", "open", "done");
  assert.ok(!stale.ok && stale.kind === "conflict");
  const bad = await api.transition("bad", "open", "bogus" as any);
  assert.ok(!bad.ok && bad.kind === "invalid");
  assert.equal(m.log.length, 3);
});
await check("Undo is the reverse transition (to → from), and snooze is a guarded metadata merge", async () => {
  const m = mock({ vault_transition: () => ({ id: "x", updatedAt: "T3" }), vault_patch_meta: () => ({ id: "x", updatedAt: "T4" }) });
  const api = createVaultTasks(m.call);
  await api.transition("x", "open", "done");
  await api.transition("x", "done", "open");
  assert.deepEqual(m.log.map((l) => [l.args.from, l.args.to]), [["open", "done"], ["done", "open"]]);
  const s = await api.snooze("x", "2026-10-11", "T3");
  assert.ok(s.ok);
  assert.deepEqual(m.log[2], { cmd: "vault_patch_meta", args: { vault: "uni", id: "x", metadata: { snoozed_until: "2026-10-11" }, ifUpdatedAt: "T3" } });
});

await check("talk target: the node's `room` name, else its channel ids, else the parent's, else Uni", () => {
  const rooms = [{ id: "r-cohere", name: "Cohere" }, { id: "r-techne", name: "Techne" }, { id: "r-uni", name: "Uni" }];
  const uni = rooms[2];
  assert.equal(roomByName(rooms, "#cohere")?.id, "r-cohere");
  assert.equal(roomByName(rooms, "unknown"), null);
  assert.equal(resolveRoom([{ path: "P/C", room: "cohere", channels: [] }, { path: "A/T", room: "techne", channels: [] }], rooms, uni)?.id, "r-cohere");
  assert.equal(resolveRoom([{ path: "P/C", room: null, channels: ["r-techne"] }], rooms, uni)?.id, "r-techne");
  assert.equal(resolveRoom([{ path: "P/C", room: "gone", channels: ["x"] }, { path: "A/T", room: "techne", channels: [] }], rooms, uni)?.id, "r-techne");
  assert.equal(resolveRoom([{ path: "P/C", room: null, channels: [] }], rooms, uni)?.id, "r-uni");
  assert.equal(resolveRoom([], rooms, null), null);
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
