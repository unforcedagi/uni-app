// T-335 one reader (src/vault/reader.ts): one reader per kind, its reads shared within a poller tick, fresh after a write; the run windows
// older than two days read at most every five minutes with no gap; the one poller ticks every subscriber; and the generated schema is the
// one the vault declares (a saved copy of the tag schemas, when one is given).
// Run: node --experimental-strip-types scripts/vaultReader.test.ts
import assert from "node:assert/strict";
import { createReader, LIVE, OLD_RUNS_MS, RUN_WINDOWS } from "../src/vault/reader.ts";
import { LIVE_STATES } from "../src/areas/taskCore.ts";
import { SCHEMA } from "../src/vault/schema.gen.ts";

let failed = 0;
const check = async (name: string, f: () => Promise<void> | void) => { try { await f(); console.log("ok  ", name); } catch (e) { failed++; console.log("FAIL", name, (e as Error).message); } };
type C = { cmd: string; args: Record<string, any> };
function door(answer: (c: C) => unknown = () => []) {
  const calls: C[] = [];
  return { calls, call: async (cmd: string, args: Record<string, unknown>) => { const c = { cmd, args: args as Record<string, any> }; calls.push(c); const r = answer(c); if (r instanceof Error) throw r; return r; } };
}

await check("a kind asked twice in one tick is one vault call; after invalidate (a write, a Retry) it is read again", async () => {
  let now = 0;
  const d = door(); const r = createReader(d.call, () => now);
  await Promise.all([r.nodes("uni"), r.nodes("uni")]);
  await r.nodes("uni");
  assert.equal(d.calls.length, 1);
  r.invalidate();
  await r.nodes("uni");
  assert.equal(d.calls.length, 2);
  // another vault is its own read; a read is never shared past its tick (20 s), even with no invalidate
  await r.nodes("other");
  assert.equal(d.calls.length, 3);
  now += 25_000;
  await r.nodes("uni");
  assert.equal(d.calls.length, 4);
});

await check("the live tasks and open decisions are asked by state (and node), and the filter is part of what is shared", async () => {
  const d = door(); const r = createReader(d.call, () => 0);
  await r.liveTasks("uni"); await r.liveTasks("uni", ["Areas/A"]); await r.liveTasks("uni", ["Areas/A"]); await r.openDecisions("uni");
  assert.equal(d.calls.length, 3);
  assert.deepEqual(d.calls[0].args.metadata, { state: { in: ["open", "doing", "waiting"] } });
  assert.deepEqual(d.calls[1].args.metadata, { node: { in: ["Areas/A"] }, state: { in: ["open", "doing", "waiting"] } });
  assert.deepEqual([d.calls[2].args.tag, d.calls[2].args.metadata], ["decision", { state: { in: ["open"] } }]);
  assert.deepEqual([...LIVE], [...LIVE_STATES], "the reader's live states are the task list's");
});

await check("a failed read is not shared: the next asker in the same tick reads again", async () => {
  let fail = true;
  const d = door(() => (fail ? new Error("vault unreachable") : []));
  const r = createReader(d.call, () => 0);
  await assert.rejects(r.cards("uni"));
  fail = false;
  assert.deepEqual((await r.cards("uni")).rows, []);
  assert.equal(d.calls.length, 2);
});

await check("a long list is read page by page until a short page; a vault that ignores offset is incomplete, never taken for the whole", async () => {
  const page = (o: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${o + i}` }));
  const d = door((c) => (c.args.offset ?? 0) === 0 ? page(0, 200) : page(200, 5));
  const r = createReader(d.call, () => 0);
  const got = await r.cards("uni");
  assert.equal(got.rows.length, 205); assert.equal(got.complete, true);
  const stuck = door(() => page(0, 200));
  const again = await createReader(stuck.call, () => 0).drafts("uni");
  assert.equal(again.rows.length, 200); assert.equal(again.complete, false);
});

await check("runs: the older windows are read once in five minutes, and the fresh window reaches back to where they began (no run falls between)", async () => {
  const DAY = 86_400_000;
  let now = Date.parse("2026-11-10T12:00:00Z");
  const d = door(); const r = createReader(d.call, () => now);
  const windows = () => d.calls.filter((c) => c.args.metadata?.started_at?.lt).length;
  const fresh = () => d.calls.filter((c) => c.args.metadata?.started_at && !c.args.metadata.started_at.lt);
  await r.runs("uni");
  assert.equal(windows(), RUN_WINDOWS.length - 1);
  const first = d.calls.find((c) => c.args.metadata?.started_at?.lt && c.args.metadata.started_at.lt);
  for (let i = 1; i <= 4; i++) { now += 60_000; r.invalidate(); await r.runs("uni"); }
  assert.equal(windows(), RUN_WINDOWS.length - 1, "four ticks later the older windows were not read again");
  const last = fresh().at(-1)!;
  // the fresh window starts two days before the older read began, not two days before now: the older read's newest edge
  assert.equal(last.args.metadata.started_at.gte, new Date(Date.parse("2026-11-10T12:00:00Z") - 2 * DAY).toISOString());
  assert.equal(first!.args.metadata.started_at.lt, last.args.metadata.started_at.gte, "the windows meet with no gap");
  now += OLD_RUNS_MS; r.invalidate(); await r.runs("uni");
  assert.equal(windows(), 2 * (RUN_WINDOWS.length - 1), "five minutes on, the older windows are read again");
  // the user's Forget drops them at once
  r.forget(); await r.runs("uni");
  assert.equal(windows(), 3 * (RUN_WINDOWS.length - 1));
});

await check("runs: a run the older windows saw live that has since ended is read again at once, never shown live from the older copy", async () => {
  let now = Date.parse("2026-11-10T12:00:00Z");
  let state = "running";
  const run = () => ({ id: "r3", metadata: { state, started_at: "2026-11-07T10:00:00Z" } });
  const d = door((c) => {
    const m = c.args.metadata ?? {};
    if (m.state) return m.state.in.includes(state) ? [run()] : [];
    const at = m.started_at;
    return at && at.lt && "2026-11-07T10:00:00Z" >= at.gte && "2026-11-07T10:00:00Z" < at.lt ? [run()] : [];
  });
  const r = createReader(d.call, () => now);
  assert.equal((await r.runs("uni")).rows[0].metadata!.state, "running");
  // stopped twenty seconds later (the write reads the runs fresh): done at once, not running from the older copy
  state = "done"; now += 20_000; r.invalidate("run");
  const got = await r.runs("uni");
  assert.equal((got.rows[0].metadata as any).state, "done");
});

await check("runs: a note the live read never lists (its index disagrees) forces one re-read of the older windows, not one on every read", async () => {
  let now = Date.parse("2026-11-10T12:00:00Z");
  const d = door((c) => (c.args.metadata?.started_at?.lt && "2026-11-07T10:00:00Z" >= c.args.metadata.started_at.gte && "2026-11-07T10:00:00Z" < c.args.metadata.started_at.lt ? [{ id: "r9", metadata: { state: "running", started_at: "2026-11-07T10:00:00Z" } }] : []));
  const r = createReader(d.call, () => now);
  const windows = () => d.calls.filter((c) => c.args.metadata?.started_at?.lt).length;
  await r.runs("uni");
  for (let i = 0; i < 4; i++) { now += 60_000; r.invalidate(); await r.runs("uni"); }
  assert.equal(windows(), 2 * (RUN_WINDOWS.length - 1), "the first read and one forced re-read");
});

await check("invalidate by kind: the work's follow-up read is fresh, the rest of the tick stays shared", async () => {
  const d = door(); const r = createReader(d.call, () => 0);
  await r.nodes("uni"); await r.cards("uni");
  r.invalidate("node");
  await r.nodes("uni"); await r.cards("uni");
  assert.deepEqual(d.calls.map((c) => c.args.tag), ["node", "card", "node"]);
});

await check("runs: one run in two windows is listed once; a short read says which part is missing", async () => {
  const run = { id: "r1", metadata: { state: "running" } };
  const d = door((c) => (c.args.metadata?.state ? [run] : c.args.metadata?.started_at && !c.args.metadata.started_at.lt ? [run] : []));
  const got = await createReader(d.call, () => Date.now()).runs("uni");
  assert.equal(got.rows.length, 1); assert.deepEqual(got.partial, []);
});

await check("the one poller: every subscriber hears a tick, its reads fresh; the timer runs while anyone listens", async () => {
  const listeners: Record<string, () => void> = {};
  const g = globalThis as any;
  g.window = { addEventListener: (k: string, f: () => void) => { listeners[k] = f; }, removeEventListener: (k: string) => { delete listeners[k]; } };
  g.document = { visibilityState: "visible", addEventListener: (k: string, f: () => void) => { listeners[k] = f; }, removeEventListener: (k: string) => { delete listeners[k]; } };
  let now = 0;
  const d = door(); const r = createReader(d.call, () => now);
  const heard: string[] = [];
  const a = r.onPoll(() => { heard.push("a"); void r.nodes("uni"); });
  const b = r.onPoll(() => { heard.push("b"); void r.nodes("uni"); });
  assert.equal(r.subscribers(), 2);
  r.tick();
  await new Promise((res) => setTimeout(res, 0));
  assert.deepEqual(heard, ["a", "b"]);
  assert.equal(d.calls.length, 1, "both subscribers' reads of the nodes are one call");
  // coming back to the window soon after a tick doesn't tick again; after FOCUS_GAP_MS it does
  now += 3_000; listeners.focus();
  assert.equal(heard.length, 2);
  now += 10_000; listeners.focus();
  assert.equal(heard.length, 4);
  // a clock that went back (the device's time changed) is stale too, never "just ticked"
  now -= 86_400_000; listeners.focus();
  assert.equal(heard.length, 6);
  a(); b();
  assert.equal(r.subscribers(), 0);
  assert.equal(listeners.focus, undefined, "the last subscriber gone, nothing listens");
  delete g.window; delete g.document;
});

await check("the poller's timer starts over on every tick: a tick on coming back is followed by the next a minute later, not seconds later", () => {
  const g = globalThis as any;
  const listeners: Record<string, () => void> = {};
  g.window = { addEventListener: (k: string, f: () => void) => { listeners[k] = f; }, removeEventListener: () => {} };
  g.document = { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} };
  // a fake timer: each `every` is one armed callback with the time it is due
  let now = 0; const armed: { f: () => void; due: number }[] = [];
  const advance = (ms: number) => { const end = now + ms; for (;;) { const next = armed.filter((a) => a.due <= end).sort((a, b) => a.due - b.due)[0]; if (!next) break; now = next.due; next.due += 60_000; next.f(); } now = end; };
  const r = createReader(door().call, () => now, { every: (f) => { const a = { f, due: now + 60_000 }; armed.push(a); return a; }, stopEvery: (h) => { const i = armed.indexOf(h as never); assert.ok(i >= 0, "only an armed timer is stopped"); armed.splice(i, 1); } });
  const at: number[] = [];
  const stop = r.onPoll(() => at.push(now));
  advance(55_000); listeners.focus();          // back at 55 s: a tick
  advance(10_000);                             // 65 s: the old timer would tick again here
  assert.deepEqual(at, [55_000], "no second tick seconds after the first");
  advance(60_000);                             // 115 s: a minute after the focus tick
  assert.deepEqual(at, [55_000, 115_000]);
  advance(60_000);
  assert.deepEqual(at, [55_000, 115_000, 175_000]);
  stop();
  assert.equal(armed.length, 0, "the last subscriber gone, no timer");
  delete g.window; delete g.document;
});

await check("the generated schema declares what the needs-you path reads (needs_aaron on task, the card's fields)", () => {
  assert.equal(SCHEMA.task.needs_aaron.type, "boolean");
  assert.ok("needs_aaron_why" in SCHEMA.task && "kind" in SCHEMA.task && "card" in SCHEMA.task);
  assert.ok("open_asks" in SCHEMA.card && "needs_you" in SCHEMA.card && "status" in SCHEMA.node);
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("all reader checks passed");
