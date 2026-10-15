// T-86: tasks as Parachute objects — tree from `node` notes, subtree, grouping, roll-up, and the vault writes (mocked transport).
// Run: node --experimental-strip-types scripts/tasks.test.ts
import assert from "node:assert/strict";
import { buildTaskTree, dayOf, failureKind, groupOf, groupTasks, parseNodes, parseTask, rollUp, snoozed, subtreePaths, tasksUnder, tomorrowOf, nodeFilterKeys, type Task } from "../src/areas/taskCore.ts";
import { allPages, changedBy, createVaultTasks } from "../src/areas/vaultTasks.ts";
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
  node("p-c26", "Projects/COhere/COhere 2026", "Areas/Techne", { room: "#cohere", links: ["p-c"] }),
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
  assert.equal(tree.parent.get("Projects/COhere/COhere 2026"), "Areas/Techne", "a project link to a project does not nest");
  assert.deepEqual(tree.links.get("Projects/COhere"), ["Projects/COhere/COhere 2026", "Areas/Techne"]);
  assert.equal(nodes.find((n) => n.path.endsWith("2026"))!.room, "cohere");
});
check("tree: a parent stored as an id resolves; project links never nest or loop; self parent is top level", () => {
  const t = buildTaskTree(parseNodes([node("1", "P/B", "2"), node("2", "P/A", "1"), node("3", "P/S", "P/S")]).nodes);
  assert.equal(t.parent.get("P/A"), ROOT);
  assert.equal(t.parent.get("P/B"), "P/A", "a legacy parent ring is broken at its smallest path, as in 0.1.46");
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
  parse(task("c", "Areas/Techne", { owner: "person:kevin", state: "waiting", waiting_on: "external" })),
  parse(task("d", "Areas/Techne", { owner: "person:kevin", state: "waiting", waiting_on: "aaron", due: "2026-10-20" })),
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
check("roll-up: an area counts the projects linked to it; the root counts all, including tasks on the root note", () => {
  const r = rollUp(tree, sample());
  assert.equal(r.get("Projects/COhere/COhere 2026")!.total, 2);
  assert.equal(r.get("Projects/COhere")!.total, 2, "a project that links another (not linked back) is work under it (T-140 fix)");
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

await check("loadTasks (T-140): one `node in` request per kind from the tree in memory, never a vault walk over `parent`; the root is a plain state filter", async () => {
  const m = mock({ vault_query_meta: (a) => (a.tag === "task" ? [task("t", "p-c26")] : [task("d", "Areas/Techne", {}, ["decision"])]) });
  const api = createVaultTasks(m.call);
  const t = buildTaskTree(parseNodes(NODES).nodes);
  const { tasks } = await api.loadTasks(t, "Areas/Techne");
  assert.deepEqual(m.log.map((l) => l.cmd), ["vault_query_meta", "vault_query_meta"]);
  assert.deepEqual(tasks.map((x) => x.id).sort(), ["d", "t"]);
  await api.loadTasks(t, ROOT);
  assert.deepEqual(m.log.slice(2).map((l) => l.cmd), ["vault_query_meta", "vault_query_meta"]);
  assert.equal("node" in (m.log.at(-1)!.args.metadata as object), false);
});
await check("a network error is thrown", async () => {
  const m = mock({ vault_query_meta: () => new Error("hub unreachable") });
  const api = createVaultTasks(m.call);
  const t = buildTaskTree(parseNodes(NODES).nodes);
  await assert.rejects(api.loadTasks(t, "Areas/Techne"), /hub unreachable/);
});
await check("a node the loaded tree lacks asks nothing and has no tasks", async () => {
  const m = mock({});
  const api = createVaultTasks(m.call);
  assert.deepEqual(await api.loadTasks(buildTaskTree(parseNodes(NODES).nodes), "Projects/Late"), { tasks: [], truncated: false });
  assert.deepEqual(m.log, []);
});

await check("loadTree queries the node tag without content; loadTasks sends the subtree paths+ids and the live states", async () => {
  const m = mock({ vault_query: () => NODES, vault_query_meta: (a) => (a.tag === "task" ? [task("t", "p-c26")] : [task("d", "Areas/Techne", {}, ["decision"])]) });
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
await check("transition(): 200 sends a state_transition with from/to and the revision seen (r16); 409 and 422 are classified, never retried", async () => {
  const m = mock({ vault_transition: (a) => (a.id === "ok" ? { id: "ok", updatedAt: "T2", lastUpdatedBy: "u", lastUpdatedVia: "api" } : new Error(a.id === "stale" ? "[transition_conflict] conflict: note stale" : a.id === "edited" ? 'conflict: note "edited" has been modified (current updated_at=T9, expected=T1)' : "[schema_validation] state is not one of")) });
  const api = createVaultTasks(m.call);
  assert.deepEqual(await api.transition("ok", "open", "done", "T1"), { ok: true, updatedAt: "T2", lastUpdatedBy: "u", lastUpdatedVia: "api" });
  assert.deepEqual(m.log[0], { cmd: "vault_transition", args: { vault: "uni", id: "ok", from: "open", to: "done", ifUpdatedAt: "T1" } });
  const stale = await api.transition("stale", "open", "done", "T1");
  assert.ok(!stale.ok && stale.kind === "conflict");
  // r16: the state is unchanged but the instruction was rewritten since the revision seen: a conflict too
  const edited = await api.transition("edited", "open", "done", "T1");
  assert.ok(!edited.ok && edited.kind === "conflict");
  const bad = await api.transition("bad", "open", "bogus" as any, "T1");
  assert.ok(!bad.ok && bad.kind === "invalid");
  assert.equal(m.log.length, 4);
  // no revision: refused here, nothing is written
  const blind = await api.transition("ok", "open", "done", "");
  assert.ok(!blind.ok && blind.kind === "conflict");
  assert.equal(m.log.length, 4);
});
await check("decide(): one update with the state compare-and-set, the decided metadata and the revision read (r14); a conflict is classified, never retried", async () => {
  const m = mock({ vault_decide: (a) => (a.id === "ok" ? { id: "ok", updatedAt: "T5", lastUpdatedBy: "u", lastUpdatedVia: "api" } : new Error("[transition_conflict] conflict: note stale")) });
  const api = createVaultTasks(m.call);
  assert.deepEqual(await api.decide("ok", "Ship it", "aaron", "T4", "2026-10-13T09:00:00.000Z"), { ok: true, updatedAt: "T5", lastUpdatedBy: "u", lastUpdatedVia: "api" });
  assert.deepEqual(m.log[0], { cmd: "vault_decide", args: { vault: "uni", id: "ok", from: "open", to: "decided", metadata: { decided: "Ship it", decided_at: "2026-10-13T09:00:00.000Z", decided_by: "aaron", answered_rev: "T4" }, ifUpdatedAt: "T4" } });
  const stale = await api.decide("stale", "Hold", "aaron", "T1");
  assert.ok(!stale.ok && stale.kind === "conflict");
  assert.equal(m.log.length, 2);
});
await check("r26: \"I did this\" records the revision it answered in the same transition; an undo or a plain transition carries none", async () => {
  const m = mock({ vault_transition: () => ({ id: "x", updatedAt: "T3" }) });
  const api = createVaultTasks(m.call);
  await api.transition("x", "open", "done", "T2", true);
  await api.transition("x", "done", "open", "T3");
  assert.deepEqual(m.log[0].args.metadata, { answered_rev: "T2" });
  assert.equal("metadata" in m.log[1].args, false);
});
await check("Undo is the reverse transition (to → from) guarded by the first write's revision, and snooze is a guarded metadata merge", async () => {
  const m = mock({ vault_transition: () => ({ id: "x", updatedAt: "T3" }), vault_patch_meta: () => ({ id: "x", updatedAt: "T4" }) });
  const api = createVaultTasks(m.call);
  const w = await api.transition("x", "open", "done", "T2");
  await api.transition("x", "done", "open", w.ok ? w.updatedAt! : "");
  assert.deepEqual(m.log.map((l) => [l.args.from, l.args.to, l.args.ifUpdatedAt]), [["open", "done", "T2"], ["done", "open", "T3"]]);
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

await check("r12 paging: a list is read 200 at a time until a short page; a vault that ignores offset, or 10 full pages, is never called complete", async () => {
  const rows = Array.from({ length: 450 }, (_, i) => ({ id: `n${i}` }));
  const asked: number[] = [];
  const all = await allPages(async (offset) => { asked.push(offset); return rows.slice(offset, offset + 200); });
  assert.deepEqual(asked, [0, 200, 400]); assert.equal(all.rows.length, 450); assert.equal(all.complete, true);
  const exact = await allPages(async (offset) => rows.slice(0, 400).slice(offset, offset + 200));
  assert.equal(exact.rows.length, 400); assert.equal(exact.complete, true, "an empty last page ends it");
  const deaf = await allPages(async () => rows.slice(0, 200));
  assert.equal(deaf.rows.length, 200); assert.equal(deaf.complete, false, "the same page twice: offset is not honoured");
  const huge = await allPages(async (offset) => Array.from({ length: 200 }, (_, i) => ({ id: `h${offset + i}` })));
  assert.equal(huge.rows.length, 2000); assert.equal(huge.complete, false);
});
await check("r12 the root list pages past 200 tasks and says when it could not read them all", async () => {
  const many = Array.from({ length: 230 }, (_, i) => ({ id: `t${i}`, path: `Tasks/T-${i}`, tags: ["task"], metadata: { node: "Areas/Techne", state: "open", owner: "aaron" } }));
  const calls: Record<string, unknown>[] = [];
  const api = createVaultTasks(async (cmd, args) => { calls.push({ cmd, ...args }); if (cmd !== "vault_query_meta") return []; const o = (args.offset as number) ?? 0; return args.tag === "task" ? many.slice(o, o + (args.limit as number)) : []; }, "uni");
  const r = await api.loadTasks(tree, ROOT);
  assert.equal(r.tasks.length, 230); assert.equal(r.truncated, false);
  assert.deepEqual(calls.filter((c) => c.tag === "task").map((c) => c.offset ?? 0), [0, 200]);
});
await check("r12 who changed a task, in words: you (this app's writes), Uni (through MCP), else nobody named; never an id", () => {
  assert.equal(changedBy({ lastUpdatedBy: "abc", lastUpdatedVia: "api" }, "abc"), "you");
  assert.equal(changedBy({ lastUpdatedBy: "zzz", lastUpdatedVia: "mcp" }, "abc"), "Uni");
  assert.equal(changedBy({ lastUpdatedBy: "cdf67944-c5f2-4e42-a0d8-02ce7a95bbdb", lastUpdatedVia: "api" }, null), null);
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
