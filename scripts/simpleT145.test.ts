// T-145: an ask's stamp vouches for the words it was written with (`ask_sig`). Run: node --experimental-strip-types scripts/simpleT145.test.ts
import assert from "node:assert/strict";
import { askSig, buildTaskTree, parseNodes, parseTask, type Task } from "../src/areas/taskCore.ts";
import { confirmationOf, needsFeed, reasonShort, unconfirmedLine, type ConfOf } from "../src/areas/simpleCore.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const nd = (id: string, path: string, parent: string | null, tags = ["project"]) => ({ id, path, tags, metadata: parent ? { parent } : {} });
const { nodes, rootPath } = parseNodes([nd("u", "Uni", null, ["uni"]), nd("a-x", "Areas/Atlas", "Uni", ["area"]), nd("p-at", "Projects/ATLAS", "Areas/Atlas")]);
const tree = buildTaskTree(nodes, rootPath);
const NEXT = "Send Harper the new site labels from the board, then say it is done";
const DETAIL = "The labels: A · B · C";
const NOW = Date.parse("2026-10-15T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const mk = (n: number, extra: Record<string, unknown> = {}): Task =>
  parseTask({ id: `id${n}`, path: `Tasks/T-${n} Do thing ${n}`, tags: ["task"], updatedAt: "2026-10-14T08:00:00.000Z", metadata: { node: "Projects/ATLAS", state: "open", owner: "aaron", next: NEXT, detail: DETAIL, asked_at: hoursAgo(5), ...extra } } as never, tree)!;

await check("the signature is the one tasks.py writes (the vectors in uni-tasks test_ask_sig.py)", () => {
  // change these only together with tasks.py's ask_sig and its test
  assert.equal(askSig(null, null), "v1:af63d24c8601db8e");
  assert.equal(askSig("Send the labels", null), "v1:4c36cc51b2848fcc");
  assert.equal(askSig("Say go", "Line one\n\nLine two"), "v1:bad813d786ed910d");
  assert.equal(askSig("Café — naïve ✓", "emoji 🎉"), "v1:6b2222e48ef54627");
  assert.equal(askSig("", ""), askSig(undefined, undefined));
  assert.equal(askSig(3, ["x"]), askSig(null, null), "a field that is not text is empty");
  assert.notEqual(askSig("a", "b"), askSig("a\u001fb", null), "next and detail are kept apart");
  assert.notEqual(askSig("Send the labels ", null), askSig("Send the labels", null), "the words exactly as stored: no trimming");
});

await check("a stamp written with these words keeps the ask current; any change to next or detail since needs confirming", () => {
  const sig = askSig(NEXT, DETAIL);
  assert.deepEqual(confirmationOf(mk(1, { ask_sig: sig }), NOW), { state: "confirmed", why: null });
  assert.deepEqual(confirmationOf(mk(2, { ask_sig: sig, next: `${NEXT} today` }), NOW), { state: "recheck", why: "changed" });
  assert.deepEqual(confirmationOf(mk(3, { ask_sig: sig, detail: "The labels: A · B" }), NOW), { state: "recheck", why: "changed" });
  assert.deepEqual(confirmationOf(mk(4, { ask_sig: sig, detail: null }), NOW), { state: "recheck", why: "changed" }, "detail cleared");
  assert.equal(confirmationOf(mk(5, { ask_sig: sig, priority: "soon", due: "2026-10-20" }), NOW).state, "confirmed", "other fields are not the ask");
});

await check("a fresh confirmed_at does not vouch for words it was not written with; a new sig with it does", () => {
  const old = askSig(NEXT, DETAIL);
  const changed = { next: "Send Harper the old labels instead", confirmed_at: hoursAgo(1) };
  assert.equal(confirmationOf(mk(6, { ask_sig: old, ...changed }), NOW).why, "changed");
  assert.equal(confirmationOf(mk(7, { ask_sig: askSig(changed.next, DETAIL), ...changed }), NOW).state, "confirmed");
});

await check("changed words with an old stamp say changed (the words are the reason), and a record with no sig is read by its stamp as before", () => {
  assert.equal(confirmationOf(mk(8, { ask_sig: "v1:0000000000000000", asked_at: hoursAgo(24 * 6) }), NOW).why, "changed");
  assert.equal(confirmationOf(mk(9), NOW).state, "confirmed");
  assert.equal(confirmationOf(mk(10, { asked_at: hoursAgo(24 * 6) }), NOW).why, "old");
  assert.equal(mk(9).sig, undefined, "no sig is computed for a record with nothing to hold it to");
});

await check("a changed ask is out of Needs you and its count, and in the list that needs confirming with its reason", () => {
  const sig = askSig(NEXT, DETAIL);
  const ts = [mk(11, { ask_sig: sig }), mk(12, { ask_sig: sig, next: "Send Harper something else" })];
  const conf: ConfOf = (t) => confirmationOf(t, NOW);
  const f = needsFeed(ts, () => null, null, "2026-10-15", conf);
  assert.deepEqual(f.rows.map((t) => t.id), ["id11"]);
  assert.equal(f.total, 1);
  assert.deepEqual(f.recheck?.map((t) => t.id), ["id12"]);
  assert.equal(f.recheckWhy?.id12, "changed");
  assert.match(reasonShort(ts[1], "2026-10-15", "changed"), /^changed since asked (today|Oct 15)$/);
  assert.equal(reasonShort(ts[1], "2026-10-15", "old"), reasonShort(ts[1], "2026-10-15"));
  assert.equal(unconfirmedLine("asked Oct 11", "changed"), "Asked Oct 11 · changed since, not confirmed");
  assert.equal(unconfirmedLine("asked Oct 11"), "Asked Oct 11 · not confirmed since");
  assert.equal(unconfirmedLine(null, "changed"), "Changed since it was asked, not confirmed");
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
