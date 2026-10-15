// T-124 r20: rows say the action within two lines, nothing is owed until it's known, and Uni's tidying stays Uni's.
// Titles and steps are the real ones from the scratch copy (10-14), no private areas; links are written in the same shapes.
// Run: node --experimental-strip-types scripts/simpleR20.test.ts
import assert from "node:assert/strict";
import * as core from "../src/areas/simpleCore.ts";
import { checkOf, dueLine, needsByRow, needsFeed, needsYou, rowAction, rowSub, stepAudience, taskDeps, unknownDecision, verbPhrase } from "../src/areas/simpleCore.ts";
import { buildTaskTree, parseNodes, parseTask, type Task } from "../src/areas/taskCore.ts";
import { createVaultTasks, pool, prioritize } from "../src/areas/vaultTasks.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const tree = (() => { const { nodes, rootPath } = parseNodes([{ id: "u", path: "Uni", tags: ["uni"], metadata: {} }]); return buildTaskTree(nodes, rootPath); })();
const task = (id: string, title: string, meta: Record<string, unknown>, tag = "task", updatedAt = "2026-10-14T06:00:00.000Z"): Task =>
  parseTask({ id, path: `${tag === "decision" ? "Decisions" : "Tasks"}/${title}`, tags: [tag], updatedAt, metadata: { state: "open", owner: "aaron", ...meta } }, tree)!;

type N = { id: string; path: string; content?: string; metadata?: Record<string, unknown>; updatedAt?: string };
function fakeVault(list: N[], delay = 0) {
  const reads: string[] = [];
  let live = 0; let peak = 0;
  const call = async (cmd: string, args: Record<string, unknown>) => {
    if (cmd !== "vault_note") return [];
    reads.push(String(args.noteRef));
    live++; peak = Math.max(peak, live);
    try {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const n = list.find((x) => x.id === args.noteRef);
      if (!n) throw new Error("note not found");
      return { note: { content: "", metadata: {}, ...n } };
    } finally { live--; }
  };
  return { vt: createVaultTasks(call, "uni"), reads, peak: () => peak };
}

/** The real steps (scratch copy, 10-14) and what a row must lead with: the whole verb phrase, and the action's first clause. */
const REAL: [string, string, string][] = [
  // the four Sonnet cuts
  ["Review the Woven Web handoff draft, fill the unknowns, then talk with Harper yourself.", "Review the Woven Web handoff draft", "Review the Woven Web handoff draft, fill the unknowns, then talk with Harper yourself"],
  ["Wed 10-14: say go on prod deploy of #38 + #58; Harper signs off the copy/photos before/after (posting today); yes/no on add-only DB…", "Say go", "Say go on prod deploy of #38 + #58"],
  // r22 (both critics): "; fill the opening…" leads with a work verb, so it is the user's too and stays in the action
  ["Edit and send the ATLAS follow-up to Mark and Dominic from your account; fill the opening, sign-off and next-review date.", "Edit and send the ATLAS follow-up", "Edit and send the ATLAS follow-up to Mark and Dominic from your account; fill the opening, sign-off and next-review date"],
  ["Tell Uni who pays (Techne or Gitcoin Foundation) and how: crypto or ACH/Stripe, plus Woven Web's legal details.", "Tell Uni who pays", "Tell Uni who pays (Techne or Gitcoin Foundation) and how: crypto or ACH/Stripe, plus Woven Web's legal details"],
  // more from the same list
  ["Look at https://cohere-signup-staging.unforced.workers.dev/?look=ecology on phone, then forward #cohere's 'For Harper' block (posted 10-13)", "Look at https://cohere-signup-staging.unforced.workers.dev/?look=ecology", "Look at https://cohere-signup-staging.unforced.workers.dev/?look=ecology on phone, then forward #cohere's 'For Harper' block (posted 10-13)"],
  ["Production go: gateway deploy ($10/day cap), merge #55, BV_CHAT_ENABLED on; listen to 2 Jacobs clips first", "Production go: gateway deploy", "Production go: gateway deploy ($10/day cap), merge #55, BV_CHAT_ENABLED on; listen to 2 Jacobs clips first"],
  ["Tell Uni how to reach the friends box: add uni-1's SSH key for a read-only user, or have Omar run the export himself.", "Tell Uni how", "Tell Uni how to reach the friends box: add uni-1's SSH key for a read-only user, or have Omar run the export himself"],
  ["Reply: keep or archive the 87 Tana tasks (recommended: keep 15, fold 32, archive 40), and is journal Parachute's default entry type?", "Reply: keep or archive the 87 Tana tasks", "Reply: keep or archive the 87 Tana tasks (recommended: keep 15, fold 32, archive 40), and is journal Parachute's default entry type?"],
  ["Approve or change the unforced.dev mail cutover plan (uni:01M3ZR1RDJAZXTM6NQS74P8YS5).", "Approve or change the unforced.dev mail cutover plan", "Approve or change the unforced.dev mail cutover plan (uni:01M3ZR1RDJAZXTM6NQS74P8YS5)"],
];

// r21 (both critics): the whole action, to the sentence's end; only context after it (a ";" clause that isn't the user's) is the sheet's
await check("rows lead with the action: the verb phrase and its object, the whole action (r21); the context after it goes to the sheet", () => {
  for (const [next, verb, text] of REAL) {
    const a = rowAction(next)!;
    assert.ok(a, next);
    assert.equal(a.verb, verb, next);
    assert.equal(a.text, text, next);
    assert.ok(a.text.startsWith(a.verb), `the action starts with its verb phrase: ${next}`);
  }
  assert.equal(rowAction("Edit and send the ATLAS follow-up to Mark and Dominic from your account; fill the opening, sign-off and next-review date.")!.rest, ""); // r22: on the row
  // a date label is never what a row leads with, and is kept as the cue when there is no due date
  assert.equal(rowAction("Wed 10-14: say go on prod deploy of #38 + #58; Harper signs off")!.prefix, "Wed 10-14");
  assert.equal(rowAction("10-05 09:04: send Runway the claim; wait")!.text, "Send Runway the claim");
  // a status is no action
  assert.equal(rowAction("Waiting on Casey's reply"), null);
  assert.equal(verbPhrase("Pick a quiet window to cut core over"), "Pick a quiet window");
});

await check("a subtitle is the due cue and where it belongs: never a title that repeats the action, never a cut or vague one", () => {
  const today = "2026-10-14";
  const cohere = task("t90", "T-90 COhere opens Oct 15", { due: "2026-10-14", next: REAL[1][0] });
  assert.equal(rowSub(cohere, rowAction(cohere.next)!, "COhere 2026", today), "COhere opens Oct 15 · due today");
  const atlas = task("t138", "T-138 Send the ATLAS Oct 12 follow-up email", { next: REAL[2][0] });
  assert.equal(rowSub(atlas, rowAction(atlas.next)!, "ATLAS", today), "ATLAS", "the title says the action again: the area instead");
  assert.equal(rowSub(atlas, rowAction(atlas.next)!, null, today), null, "inside its own area there is nothing to add");
  const look = task("t113", "T-113 Companion Today redesign + integrated PWA install flow (3 directions, then build the pick)", { due: "2026-10-13", next: REAL[4][0] });
  assert.equal(rowSub(look, rowAction(look.next)!, "uni-app", today), "Companion Today redesign + integrated PWA install flow · was due Oct 13", "r25: a long title is the quiet line, cut with words and no \"…\"");
  const cut = task("c", "T-40 Companion Today redesign…", { next: "Look at the staging site on phone" });
  assert.equal(rowSub(cut, rowAction(cut.next)!, null, today), "Companion Today redesign", "r25: a cut title is shown without its \"…\"");
  // no due date: the step's date label is the cue
  const nodue = task("n", "T-90 COhere opens Oct 15", { next: REAL[1][0] });
  assert.equal(rowSub(nodue, rowAction(nodue.next)!, null, today), "COhere opens Oct 15 · Wed 10-14");
  assert.equal(dueLine("2026-10-14", today), "due today");
});

await check("a date label is not who a step speaks to; the words for the room are the first clause", () => {
  assert.deepEqual(stepAudience(REAL[1][0], "cohere"), { kind: "room", text: "Go on prod deploy of #38 + #58" });
});

await check("P1-1 a missing prerequisite is unresolved, never all clear", async () => {
  const PRE = "01M40000000000000000000000";
  const { vt } = fakeVault([]);
  const t = task("t2", "T-135 Migrate Uni to the new machine (Gigabyte Aero 16)", { next: "OK the migration windows", depends_on: [`[[Projects/Mail/Migration runbook]]`, `uni:${PRE}`] });
  const s = (await vt.loadChecks([t], () => [])).get("t2")!;
  assert.deepEqual(s.rec!.result, { kind: "missing", ref: "“Migration runbook”" });
  assert.deepEqual(checkOf(t, s, Date.now()), { kind: "missing", ref: "“Migration runbook”" });
  assert.equal(core.missingLine({ kind: "missing", ref: "“Migration runbook”" }), "Couldn't find “Migration runbook”");
  // the owed count still holds it (it is Aaron's), but nothing in it is asserted
  assert.equal(needsYou({ ...t, check: checkOf(t, s, Date.now()) }), true);
});

await check("P1-1 decisions get the same dependency contract: a closed `source` is a Check, a missing one is unresolved; question extraction stays apart", async () => {
  const SRC = "01M41111111111111111111111";
  const d = task("bv", "Ship the Boulder Votes AI chat?", { options: ["Ship it", "Wait"], source: `uni:${SRC}` }, "decision");
  assert.deepEqual(taskDeps(d), { refs: [{ vault: "uni", id: SRC, role: "source" }], questions: null });
  // a decision with no `source` or `depends_on` stands on nothing
  assert.deepEqual(taskDeps(task("x", "Which opening hours should we publish?", {}, "decision")), { refs: [], questions: null });
  const closed = fakeVault([{ id: SRC, path: "Projects/Boulder Votes/Chat plan", metadata: { state: "done" }, updatedAt: "r1" }]);
  const s = (await closed.vt.loadChecks([d], () => [])).get("bv")!;
  assert.deepEqual(s.rec!.result, { kind: "closed", how: "closed", from: { vault: "uni", id: SRC, title: "Chat plan" } });
  // while it is checked the decision is not owed
  assert.equal(needsYou({ ...d, check: { kind: "checking" } }), false);
  assert.equal(needsYou({ ...d, check: s.rec!.result }), true);
  const gone = fakeVault([]);
  assert.equal((await gone.vt.loadChecks([d], () => [])).get("bv")!.rec!.result.kind, "missing");
});

await check("P1-2 a cold list with three statement-only decisions owes 0 until they are classified (then they are Uni's to tidy)", async () => {
  const titles = ["Uni adds Benya's missing feature 4, the…", "A daily email of the calendar at 7, with…", "Texting Uni: a number that reaches…"];
  const notes: N[] = titles.map((t, i) => ({ id: `d${i}`, path: `Decisions/${t}`, content: `Decision (needs your yes): ${t.replace(/…$/, "")} and more of the proposal.`, updatedAt: "2026-10-14T06:00:00.000Z" }));
  const cold = titles.map((t, i) => task(`d${i}`, t, { options: [] }, "decision"));
  for (const d of cold) assert.equal(unknownDecision(d), true);
  const feed = needsFeed(cold, () => null);
  assert.equal(feed.total, 0, "nothing owed before the questions are read");
  assert.equal(feed.rows.length, 0);
  assert.equal(feed.pending!.length, 3);
  assert.equal(needsByRow(cold, new Set([""]), () => undefined).size, 0, "no dots");
  // read: statements, so Uni's to tidy, and still nothing owed
  const { vt } = fakeVault(notes);
  const asks = await vt.loadAsks(cold);
  const warm = cold.map((d) => ({ ...d, ask: asks.get(d.id)!.ask, askAt: asks.get(d.id)!.at }));
  const after = needsFeed(warm, () => null);
  assert.equal(after.total, 0);
  assert.equal(after.pending!.length, 0);
  assert.equal(after.tidy!.length, 3);
  // a read that fails is not owed either, and a note with no question in it is classified (owed, opened to read)
  const failedRead = { ...cold[0], askFailed: true };
  assert.equal(needsYou(failedRead), false);
  const empty = { ...cold[0], ask: "", askAt: cold[0].updatedAt };
  assert.equal(unknownDecision(empty), false);
  assert.equal(needsYou(empty), true);
});

await check("P2 checking finishes: 45 dependent tasks all resolve, six reads at a time, every reference read (none dropped after six)", async () => {
  const ids = Array.from({ length: 45 }, (_, i) => `01M5${String(i).padStart(22, "0")}`);
  const { vt, reads, peak } = fakeVault(ids.map((id) => ({ id, path: `Projects/Plans/Plan ${id.slice(-3)}`, updatedAt: "r1" })), 2);
  const tasks = ids.map((id, i) => task(`t${i}`, `T-${200 + i} Approve plan ${i}`, { next: `Approve or change the plan (uni:${id}).` }));
  const out = await vt.loadChecks(tasks, () => []);
  assert.equal(out.size, 45);
  for (const s of out.values()) assert.equal(s.rec!.result.kind, "ok");
  assert.ok(peak() <= 6, `at most six at once (saw ${peak()})`);
  assert.equal(new Set(reads).size, 45);
  // one task with eight references: every one is read
  const many = ids.slice(0, 8);
  const t8 = task("t8", "T-300 Review the eight plans", { next: "Review the plans", depends_on: many.map((id) => `uni:${id}`) });
  assert.equal(taskDeps(t8).refs.length, 8);
  // and 45 cut decisions all get their question read
  const ds = Array.from({ length: 45 }, (_, i) => task(`q${i}`, `Decision ${i}: a long question that was cut…`, {}, "decision"));
  const dv = fakeVault(ds.map((d) => ({ id: d.id, path: d.path, content: `Should we do thing ${d.id}?`, updatedAt: d.updatedAt! })));
  assert.equal((await dv.vt.loadAsks(ds)).size, 45);
});

await check("P2 an opened sheet's reads go first in the queue", async () => {
  const order: string[] = [];
  prioritize("z");
  await pool(["a", "b", "c", "d", "e", "f", "g", "z"].map((id) => ({ id })), 1, async (x) => { order.push(x.id); });
  prioritize(null);
  assert.equal(order[0], "z");
});

await check("P2 Uni's tidying stays Uni's: no request for the user to type, and no tool syntax anywhere it says", () => {
  assert.equal((core as Record<string, unknown>).tidyRequest, undefined);
  for (const line of [...Object.values(core.TIDY_LINE), ...Object.values(core.TIDY_SAYS)]) assert.ok(!/tasks\.py|decide new/.test(line), line);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
