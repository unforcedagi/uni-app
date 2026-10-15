// T-124 r21: the whole action shows, a failed check never looks like a pass, and status claims only what's true.
// Steps are the real ones from the scratch copy (10-14), no private areas; links are written in the same shapes.
// Run: node --experimental-strip-types scripts/simpleR21.test.ts
import assert from "node:assert/strict";
import { actionOf, checkOf, retryState, rowAction, withoutBrackets, type CheckState } from "../src/areas/simpleCore.ts";
import { buildTaskTree, parseNodes, parseTask, type Task } from "../src/areas/taskCore.ts";
import { createVaultTasks } from "../src/areas/vaultTasks.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const tree = (() => { const { nodes, rootPath } = parseNodes([{ id: "u", path: "Uni", tags: ["uni"], metadata: {} }]); return buildTaskTree(nodes, rootPath); })();
const task = (id: string, title: string, meta: Record<string, unknown>, updatedAt = "2026-10-14T06:00:00.000Z"): Task =>
  parseTask({ id, path: `Tasks/${title}`, tags: ["task"], updatedAt, metadata: { state: "open", owner: "aaron", ...meta } }, tree)!;

const ATLAS = "Edit and send the ATLAS follow-up to Mark and Michael from your account; fill the opening, sign-off and next-review date.";
const WOVEN = "Review the Woven Web handoff draft, fill the unknowns, then talk with Eileen yourself.";
const STAGING = "Look at https://cohere-signup-staging.unforced.workers.dev/?look=ecology on phone, then forward #cohere's 'For Eileen' block (posted 10-13)";
const PAYS = "Tell Uni who pays (Techne or Gitcoin Foundation) and how: crypto or ACH/Stripe, plus Woven Web's legal details.";
const COHERE = "Wed 10-14: say go on prod deploy of #38 + #58; Eileen signs off the copy/photos before/after (posting today); yes/no on add-only DB…";

await check("the whole action: objects and recipients are never cut; only context after the action is the sheet's", () => {
  const at = rowAction(ATLAS)!;
  // r22 (both critics): a ";" clause that leads with a work verb is the user's too, so it stays in the action
  assert.equal(at.head, "Edit and send the ATLAS follow-up to Mark and Michael from your account; fill the opening, sign-off and next-review date");
  assert.equal(at.text, ATLAS.replace(/\.$/, ""), "r30: the row and the heading say every word of the step");
  assert.deepEqual(at.forms.map((f) => f.text), [at.text]);
  const pays = rowAction(PAYS)!;
  assert.equal(pays.head, "Tell Uni who pays (Techne or Gitcoin Foundation) and how: crypto or ACH/Stripe, plus Woven Web's legal details");
  // r22: one form, the whole action (brackets are dropped only past 160 characters)
  assert.deepEqual(pays.forms.map((f) => f.text), [pays.text]);
  const co = rowAction(COHERE)!;
  assert.equal(co.head, "Say go on prod deploy of #38 + #58");
  assert.equal(co.prefix, "Wed 10-14");
  assert.match(co.text, /^Say go on prod deploy of #38 \+ #58; Eileen signs off/, "r30: the context after the action is on the row too");
  // a question carried on by the next is one ask
  const qa = rowAction("Decide: build the live browser share (CDP stream + needs-login card)? And keep logged-in sessions or log out after each job?")!;
  assert.equal(qa.head, qa.text);
  // context: a spaced dash, "because…"
  assert.equal(rowAction("Reply to Kevin — he asked twice")!.head, "Reply to Kevin");
  assert.equal(rowAction("Reply to Kevin — he asked twice")!.text, "Reply to Kevin — he asked twice");
  assert.equal(rowAction("Send Ryan the access note because Pages needs it")!.head, "Send Ryan the access note");
});

await check("multi-step: \"A, then B\" is both steps; the fallback is \"2 steps: A, then …\" and never step 1 alone", () => {
  const ww = rowAction(WOVEN)!;
  assert.deepEqual(ww.steps, ["Review the Woven Web handoff draft, fill the unknowns", "talk with Eileen yourself"]);
  assert.equal(ww.text, "Review the Woven Web handoff draft, fill the unknowns, then talk with Eileen yourself");
  // r22: never "2 steps: A, then …": the one form is both steps
  assert.deepEqual(ww.forms.map((f) => f.text), [ww.text]);
  const st = rowAction(STAGING)!;
  assert.equal(st.steps.length, 2);
  assert.match(st.steps[1], /^forward #cohere's 'For Eileen' block/);
  assert.deepEqual(st.forms.map((f) => f.text), [st.text]);
  // "A; then B" too; "then" inside brackets is not a step
  assert.equal(actionOf("Merge #55; then tell Kevin it is live").steps.length, 2);
  assert.equal(actionOf("Pick a direction (3 directions, then build the pick)").steps.length, 1);
  // "…; listen to 2 Jacobs clips first": that step comes first
  assert.deepEqual(rowAction("Production go: gateway deploy ($10/day cap), merge #55, BV_CHAT_ENABLED on; listen to 2 Jacobs clips first")!.steps, ["Listen to 2 Jacobs clips first", "Production go: gateway deploy ($10/day cap), merge #55, BV_CHAT_ENABLED on"]);
  assert.equal(withoutBrackets("OK the windows (gateway Wed, vaults Thu) and set the limit"), "OK the windows and set the limit");
});

const PLAN = "01M3ZR1RDJAZXTM6NQS74P8YS5";
await check("P1-1 a newer failed check invalidates a cached ok: unavailable, and Retry reads as checking (never the old ok) until a read succeeds", () => {
  const t = task("t13", "T-13 Self-hosted mail: approved 10-02", { next: `Approve the plan (uni:${PLAN}).` });
  const now = Date.parse("2026-10-14T12:00:00Z");
  const rec = { taskRev: t.updatedAt, at: now - 5000, result: { kind: "ok" as const }, sources: [{ vault: "uni", id: PLAN, rev: "r1" }] };
  const ok: CheckState = { rec, failedAt: null };
  assert.deepEqual(checkOf(t, ok, now), { kind: "ok" });
  const failed: CheckState = { rec, failedAt: now - 1000 };
  assert.deepEqual(checkOf(t, failed, now), { kind: "unavailable" });
  assert.deepEqual(checkOf(t, retryState(failed), now), { kind: "checking" });
  // a good read after the failure stands
  assert.deepEqual(checkOf(t, { rec: { ...rec, at: now }, failedAt: null }, now), { kind: "ok" });
  assert.deepEqual(retryState(ok), ok);
});

await check("P1-1 the list: an ok, then a failed refresh, then the action is gone (and the device forgets the ok)", async () => {
  let fail = false;
  const call = async (cmd: string, args: Record<string, unknown>) => {
    if (cmd !== "vault_note") return [];
    if (fail) throw new Error("hub unreachable");
    return { note: { id: args.noteRef, path: "Projects/Mail/Cutover plan", content: "plan", metadata: {}, updatedAt: "r1" } };
  };
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k), key: (i: number) => [...store.keys()][i] ?? null, get length() { return store.size; } };
  const vt = createVaultTasks(call, "uni");
  vt.setAskOwner("reviewer");
  const t = task("t13", "T-13 Self-hosted mail: approved 10-02", { priority: "now", next: `Approve the plan (uni:${PLAN}).` });
  const first = (await vt.loadChecks([t], () => [])).get("t13")!;
  assert.equal(first.rec?.result.kind, "ok");
  assert.equal(vt.cachedChecks().get("t13")?.rec?.result.kind, "ok");
  fail = true;
  const second = (await vt.loadChecks([t], () => [])).get("t13")!;
  assert.equal(second.rec, null);
  assert.ok(second.failedAt);
  assert.deepEqual(checkOf(t, second, Date.now()), { kind: "unavailable" });
  // the next launch doesn't paint the invalidated ok either
  assert.equal(vt.cachedChecks().get("t13"), undefined);
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("simpleR21: all ok");
