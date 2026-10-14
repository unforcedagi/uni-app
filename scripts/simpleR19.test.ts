// T-124 r19: nothing asserts an action it hasn't checked; source checks don't go stale; records that aren't real requests are Uni's to tidy.
// Titles are real ones from the refreshed scratch copy (10-14); steps are written in the same shapes, never copied from a note's body.
// Run: node --experimental-strip-types scripts/simpleR19.test.ts
import assert from "node:assert/strict";
import { CHECK_TTL, checkOf, needsFeed, needsYou, stepAudience, taskDeps, tidyReason, toTidy, withHosts, wouldNeedYou } from "../src/areas/simpleCore.ts";
import { buildTaskTree, parseNodes, parseTask, type Task } from "../src/areas/taskCore.ts";
import { createVaultTasks } from "../src/areas/vaultTasks.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const tree = (() => { const { nodes, rootPath } = parseNodes([{ id: "u", path: "Uni", tags: ["uni"], metadata: {} }]); return buildTaskTree(nodes, rootPath); })();
const task = (id: string, title: string, meta: Record<string, unknown>, tag = "task", updatedAt = "2026-10-14T06:00:00.000Z"): Task =>
  parseTask({ id, path: `${tag === "decision" ? "Decisions" : "Tasks"}/${title}`, tags: [tag], updatedAt, metadata: { state: "open", owner: "aaron", ...meta } }, tree)!;

type N = { id: string; path: string; content?: string; metadata?: Record<string, unknown>; updatedAt?: string; vault?: string };
/** A fake vault whose notes can be changed between reads, and whose reads can fail (`fail` ids throw a transport error). */
function fakeVault(list: N[]) {
  const fail = new Set<string>();
  const reads: string[] = [];
  const call = async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "vault_note") {
      reads.push(String(args.noteRef));
      if (fail.has(String(args.noteRef))) throw new Error("hub unreachable: connection refused");
      const n = list.find((x) => x.id === args.noteRef && (x.vault ?? "uni") === args.vault);
      if (!n) throw new Error("note not found");
      return { note: { content: "", metadata: {}, ...n } };
    }
    if (cmd === "vault_query_meta") return [];
    return [];
  };
  return { vt: createVaultTasks(call, "uni"), fail, reads, list };
}

const PLAN = "01M3ZR1RDJAZXTM6NQS74P8YS5";

await check("P1-1 dependencies are explicit: the notes a step links, a `source` that names a note, `depends_on`; provenance strings are none", () => {
  const t13 = task("t13", "T-13 Self-hosted mail: approved 10-02", { next: `Approve or change the mail cutover plan (uni:${PLAN}).`, source: "Aaron/Tasks#T-13" });
  assert.deepEqual(taskDeps(t13), { refs: [{ vault: "uni", id: PLAN, role: "step" }], questions: null });
  assert.equal(t13.sourceRef, undefined, "a provenance string names no note");
  const t2 = task("t2", "T-135 Migrate Uni to the new machine (Gigabyte Aero 16)", { next: "OK the migration windows", source: `[[Projects/Mail/Cutover plan]]`, depends_on: [`uni:${PLAN}`] });
  assert.deepEqual(taskDeps(t2).refs.map((r) => [r.role, r.id]), [["source", "Projects/Mail/Cutover plan"], ["after", PLAN]]);
  // a step with no note named stands on nothing: no check, no "Checking…"
  const t95 = task("t95", "T-95 Ryan’s deploy access", { next: "Send Ryan the deploy-access message." });
  assert.equal(checkOf(t95, undefined, Date.now()), null);
  // a step asking for answers stands on its own note, unless its `questions` field already holds them
  assert.equal(taskDeps(task("q", "T-40 Dynamic guides in Parachute", { next: "Answer the 4 questions on dynamic guides." })).questions, 4);
  assert.equal(taskDeps(task("q", "T-40 Dynamic guides in Parachute", { next: "Answer the 2 questions.", questions: ["Reader?", "Scope?"] })).questions, null);
});

await check("P1-1 nothing is asserted before it is checked: no record is checking, a failed read is unavailable, a good record is its result", () => {
  const t = task("t13", "T-13 Self-hosted mail: approved 10-02", { next: `Approve the plan (uni:${PLAN}).` });
  const now = Date.parse("2026-10-14T12:00:00Z");
  assert.deepEqual(checkOf(t, undefined, now), { kind: "checking" });
  assert.deepEqual(checkOf(t, { rec: null, failedAt: now - 1000 }, now), { kind: "unavailable" });
  const rec = { taskRev: t.updatedAt, at: now - 1000, result: { kind: "ok" as const }, sources: [{ vault: "uni", id: PLAN, rev: "r1" }] };
  assert.deepEqual(checkOf(t, { rec, failedAt: null }, now), { kind: "ok" });
  // a newer failure doesn't hide a good record that is still within its time
  assert.deepEqual(checkOf(t, { rec, failedAt: now }, now), { kind: "ok" });
});

await check("P1-2 a check expires on its own schedule, and a rewritten task drops it", () => {
  const t = task("t13", "T-13 Self-hosted mail: approved 10-02", { next: `Approve the plan (uni:${PLAN}).` });
  const now = Date.parse("2026-10-14T12:00:00Z");
  const rec = { taskRev: t.updatedAt, at: now - CHECK_TTL - 1, result: { kind: "ok" as const }, sources: [] };
  assert.deepEqual(checkOf(t, { rec, failedAt: null }, now), { kind: "checking" });
  assert.deepEqual(checkOf(t, { rec, failedAt: now }, now), { kind: "unavailable" }, "expired and the read again failed: Couldn't check");
  assert.deepEqual(checkOf({ ...t, updatedAt: "2026-10-14T07:00:00.000Z" }, { rec: { ...rec, at: now }, failedAt: null }, now), { kind: "checking" });
});

await check("P1-2 the source closes while the task stays unchanged: the next list read sees it (kept by the source's revision, not the task's)", async () => {
  const { vt, list } = fakeVault([{ id: PLAN, path: "Projects/Mail/Cutover plan — unforced.dev", metadata: {}, updatedAt: "r1" }]);
  const t = task("t13", "T-13 Self-hosted mail: approved 10-02", { next: `Approve or change the plan (uni:${PLAN}).` });
  const first = await vt.loadChecks([t], () => []);
  assert.deepEqual(first.get("t13")!.rec!.result, { kind: "ok" });
  assert.deepEqual(first.get("t13")!.rec!.sources, [{ vault: "uni", id: PLAN, rev: "r1" }]);
  // the plan is superseded; the task itself is not touched
  Object.assign(list[0], { metadata: { superseded_by: "Projects/Mail/Cutover plan v2" }, updatedAt: "r2" });
  const second = await vt.loadChecks([t], () => []);
  assert.deepEqual(second.get("t13")!.rec!.result, { kind: "closed", how: "superseded", from: { vault: "uni", id: PLAN, title: "Cutover plan — unforced.dev" } });
  assert.deepEqual(second.get("t13")!.rec!.sources, [{ vault: "uni", id: PLAN, rev: "r2" }]);
});

await check("P1-2 a read fails and then recovers: unavailable (never 'nothing there' or 'unclear'), then the real result", async () => {
  const { vt, fail } = fakeVault([{ id: PLAN, path: "Projects/Mail/Cutover plan — unforced.dev", metadata: { state: "done" }, updatedAt: "r1" }]);
  const t = task("t13", "T-13 Self-hosted mail: approved 10-02", { next: `Approve or change the plan (uni:${PLAN}).` });
  fail.add(PLAN);
  const down = (await vt.loadChecks([t], () => [])).get("t13")!;
  assert.equal(down.rec, null);
  assert.ok(down.failedAt);
  assert.deepEqual(checkOf(t, down, Date.now()), { kind: "unavailable" });
  fail.delete(PLAN);
  const up = (await vt.loadChecks([t], () => [])).get("t13")!;
  assert.equal(up.failedAt, null);
  assert.deepEqual(checkOf(t, up, Date.now()), { kind: "closed", how: "closed", from: { vault: "uni", id: PLAN, title: "Cutover plan — unforced.dev" } });
  // a note that doesn't exist is an answer, not a failure (r20: an unresolved one, "Couldn't find …", never all clear)
  const gone = task("g", "T-25 Pope's AI encyclical: novel public reading experiment", { next: "Send the permission email (draft uni:01M3ZZXEXFNHRJV8KWHAGZZ1KQ)." });
  assert.deepEqual((await vt.loadChecks([gone], () => [])).get("g")!.rec!.result, { kind: "missing", ref: "01M3ZZXEXF…" });
});

await check("P1-2 one slow note doesn't hold the others: each task's check lands as it is read", async () => {
  const slow = "01M3ZZXEXFNHRJV8KWHAGZZ1KQ";
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const call = async (cmd: string, args: Record<string, unknown>) => {
    if (cmd !== "vault_note") return [];
    if (args.noteRef === slow) await gate;
    return { note: { id: args.noteRef, path: `Projects/X/${args.noteRef}`, metadata: {}, updatedAt: "r1", content: "" } };
  };
  const vt = createVaultTasks(call, "uni");
  const landed: string[] = [];
  const a = task("a", "T-25 Pope's AI encyclical: novel public reading experiment", { next: `Send the email (draft uni:${slow}).` });
  const b = task("b", "T-13 Self-hosted mail: approved 10-02", { next: `Approve the plan (uni:${PLAN}).` });
  const all = vt.loadChecks([a, b], () => [], (id) => landed.push(id));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(landed, ["b"]);
  release(); await all;
  assert.deepEqual(landed, ["b", "a"]);
});

await check("P1-2 an older read that finishes last never overwrites a newer check (kept by when its reads began)", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let closed = false; let n = 0;
  const call = async (cmd: string) => {
    if (cmd !== "vault_note") return [];
    const mine = ++n; const state = closed ? "done" : "open";
    if (mine === 1) await gate; // the first read hangs, holding the plan as it was
    return { note: { id: PLAN, path: "Projects/Mail/Cutover plan", metadata: { state }, updatedAt: state === "done" ? "r2" : "r1", content: "" } };
  };
  const vt = createVaultTasks(call, "uni");
  const t = task("t13", "T-13 Self-hosted mail: approved 10-02", { next: `Approve the plan (uni:${PLAN}).` });
  const old = vt.loadChecks([t], () => []);
  await new Promise((r) => setTimeout(r, 5));
  closed = true;
  await vt.loadChecks([t], () => []);
  release(); await old;
  assert.equal(vt.cachedChecks().get("t13")!.rec!.result.kind, "closed");
});

await check("P1-1 a `depends_on` note still open: the task waits on it (no action asserted); finished, the task is clear", async () => {
  const dep = "01M4MKXFQWKF85E2XN38W1QYSB";
  const { vt, list } = fakeVault([{ id: dep, path: "Tasks/T-43 Mail view in Uni over Stalwart JMAP", metadata: { state: "open" }, updatedAt: "r1" }]);
  const t = task("t45", "T-45 Mail view in Uni over Stalwart JMAP", { next: "Try the mail view on your phone.", depends_on: dep });
  assert.deepEqual((await vt.loadChecks([t], () => [])).get("t45")!.rec!.result, { kind: "waits", from: { vault: "uni", id: dep, title: "Mail view in Uni over Stalwart JMAP" } });
  list[0].metadata = { state: "done" };
  assert.deepEqual((await vt.loadChecks([t], () => [])).get("t45")!.rec!.result, { kind: "ok" });
});

await check("P1-3 records that aren't real requests: a testing outline, maintenance machinery, a finished step, a proposal that asks nothing", () => {
  // the outline and the machinery are the shapes Codex quoted from these records (r18 review); the titles are the records' own
  assert.equal(tidyReason(task("f", "T-111 Fractal flow test: real work in area rooms, check updates…", { next: "Fractal flow test: real work in area rooms, check updates propagate up; nested room names; app refresh for the tree" })), "outline");
  assert.equal(tidyReason(task("r", "T-125 Rooms write state: stands field, runs∕drafts∕decisions in…", { next: "Run /restart when convenient: loads the uni-relay hook that closes run notes on [done|blocked|decision] markers." })), "machinery");
  assert.equal(tidyReason(task("r2", "T-118 Lazy child-context digest: inject changes from child rooms…", { next: "Run /restart; then main wakes the room for a check" })), "machinery");
  assert.equal(tidyReason(task("s", "T-111 Fractal flow test: real work in area rooms, check updates…", { next: "Superseded: the app work moved to T-124; this is no longer an ask." })), "status");
  // proposals with no options whose question asks nothing (their whole question, read from the note, at the row's revision)
  const prop = (id: string, title: string, ask?: string) => ({ ...task(id, title, {}, "decision"), ...(ask ? { ask, askAt: "2026-10-14T06:00:00.000Z" } : {}) });
  assert.equal(tidyReason(prop("m", "Mail: approve a test week, not an immediate cutover")), "proposal");
  assert.equal(tidyReason(prop("d", "Decision (needs your yes): a daily calendar email to people who…", "Decision (needs your yes): a daily calendar email to people who registered and opted in. It goes to real attendees.")), "proposal");
  assert.equal(tidyReason(prop("b", "Decision (default yes): Uni adds Benya's missing feature 4, the…", "Uni adds the after-event “were you there? one takeaway” prompt on Wed. Say no to skip it.")), "proposal", "a ? inside a quote asks nothing");
  assert.equal(tidyReason(prop("x", "Decision: texting is not recommended for this year because carrier…", "Decision: texting is not recommended for this year because carrier approval may not clear.")), "proposal");
});

await check("P1-3 when unsure, the item stays in Needs you: concrete steps (the live shapes), a label that asks, a decision with options or a question, a cut title not read", () => {
  const keep: [string, string][] = [
    ["T-90 COhere opens Oct 15", "Wed 10-14: say go on the prod deploy of #38 + #58; Harper signs off the copy; yes/no on the migration"],
    ["T-130 Shared Haiku gateway ($10∕day cap) + Boulder Votes AI chat", "Production go: gateway deploy, merge #55, chat flag on; listen to the two clips first"],
    ["T-21 Daylight layout: collapsible sidebar, big journal…", "Pick layout A, B or C, and say yes or no to calling captures journal."],
    ["T-60 Vault coherence after merge: captures → journal…", "Reply: keep or archive the Tana tasks, and is journal the default type?"],
    ["T-67 Woven Web handoff note for Harper", "Review the handoff draft, fill the unknowns, then talk with Harper yourself."],
    ["T-113 Companion Today redesign + integrated PWA install flow (3…", "Look at the staging link on your phone, then forward the block to Harper."],
    ["T-135 Migrate Uni to the new machine (Gigabyte Aero 16)", "OK the migration windows (gateway Wed, vaults Thu, Buzz+mail Sat)"],
    ["T-101 Tell Sebastian the BVSD letter is sent, if not done…", "Reply to Sebastian in your existing thread that the letter went out Oct 2."],
    ["T-12 Boulder New Tech site + organizer app", ""],
  ];
  for (const [title, next] of keep) assert.equal(tidyReason(task("k", title, { next })), null, title);
  assert.equal(tidyReason({ ...task("bv", "2026-10-13 Ship the Boulder Votes AI chat? (preview:…", { options: ["Add key and test live on preview first", "Ship to production after live test"] }, "decision") }), null);
  assert.equal(tidyReason(task("h", "Which opening hours should we publish?", {}, "decision")), null);
  assert.equal(tidyReason(task("c", "Decision (needs your yes): a daily calendar email to people who…", {}, "decision")), null, "its question isn't read yet: unsure, kept");
  // a partial record (no title) is never classified
  assert.equal(tidyReason({ kind: "task", next: "Run /restart" }), null);
});

await check("P1-3 tidy records leave Needs you and its count, and are listed apart; a room's own record never shows there", () => {
  const rows = [
    task("a", "T-129 Send the ATLAS Oct 12 follow-up email", { next: "Edit and send the follow-up to Mark and Dominic.", priority: "now" }),
    task("f", "T-111 Fractal flow test: real work in area rooms, check updates…", { next: "Fractal flow test: real work in area rooms, check updates propagate up; nested room names; app refresh for the tree" }),
    task("m", "Mail: approve a test week, not an immediate cutover", {}, "decision"),
    task("o", "T-11 RegenHub site + newsletter systems", { owner: "room:boulder", next: "Run /restart after the merge" }),
  ];
  assert.deepEqual(rows.map((t) => [t.id, needsYou(t), wouldNeedYou(t), toTidy(t)]), [["a", true, true, null], ["f", false, true, "outline"], ["m", false, true, "proposal"], ["o", false, false, null]]);
  const feed = needsFeed(rows, () => null);
  assert.equal(feed.total, 1);
  assert.deepEqual(feed.rows.map((t) => t.id), ["a"]);
  assert.deepEqual(feed.tidy!.map((t) => t.id), ["f", "m"]);
  // inside another private area: never listed by title outside it
  const priv = rows.map((t) => ({ ...t, node: "Areas/Sanctum/X" }));
  assert.equal(needsFeed(priv, () => ({ path: "Areas/Sanctum", name: "Sanctum" })).tidy!.length, 0);
});

// r20: "Ask Uni to fix this record" is gone (Uni's tidying stays Uni's): see simpleR20.test.ts

await check("found in the real app: a sheet heading keeps a link as its host, and a room named as where a block is isn't who the step speaks to", () => {
  assert.equal(withHosts("Look at https://cohere-signup-staging.unforced.workers.dev/?look=ecology on phone, then forward #cohere's 'For Harper' block"), "Look at cohere-signup-staging.unforced.workers.dev on phone, then forward #cohere's 'For Harper' block");
  assert.equal(stepAudience("Look at the staging link on phone, then forward #cohere's 'For Harper' block (posted 10-13)", "cohere"), null);
  assert.deepEqual(stepAudience("Answer the 7 questions in #cohere", "cohere"), { kind: "room", text: "" });
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
