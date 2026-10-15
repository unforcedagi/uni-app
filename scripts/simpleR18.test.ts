// T-124 r18: answers come from the record, not from punctuation; questions only when the note says so; a task never contradicts its own source;
// Copy copies something useful; the summary carries its date; a stale progress ping is not the room's status; one cut.
// Real phrasings are from the scratch copy of the vault (RegenHub, texting, Tell Christian); no private area's words.
// Run: node --experimental-strip-types scripts/simpleR18.test.ts
import assert from "node:assert/strict";
import { answerChoices, answerText, ANSWER_MAX, checkLine, closedBy, cutWords, linkedRefs, questionsFrom, standsHeading, stepAudience, stepText } from "../src/areas/simpleCore.ts";
import { buildTaskTree, parseNodes, parseTask } from "../src/areas/taskCore.ts";
import { createVaultTasks } from "../src/areas/vaultTasks.ts";
import { staleStatus } from "../src/chatMarkers.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

type N = { id: string; path: string; content: string; metadata?: Record<string, unknown>; vault?: string };
/** A fake vault: notes by id (per vault when `vault` is set), `vault_query_meta` over their metadata. Every call is logged with its vault. */
function fakeVault(list: N[]) {
  const seen: { cmd: string; vault: unknown; ref?: unknown }[] = [];
  const call = async (cmd: string, args: Record<string, unknown>) => {
    seen.push({ cmd, vault: args.vault, ref: args.noteRef });
    if (cmd === "vault_note") { const n = list.find((x) => x.id === args.noteRef && (x.vault ?? "uni") === args.vault); if (!n) throw new Error("note not found"); return { note: n }; }
    if (cmd === "vault_query_meta") { const m = args.metadata as { node: { in: string[] }; state: { in: string[] } }; return list.filter((n) => n.metadata && m.node.in.includes(String(n.metadata.node)) && m.state.in.includes(String(n.metadata.state))); }
    return [];
  };
  return { vt: createVaultTasks(call, "uni"), seen };
}

// The RegenHub shape from the scratch copy: T-11 asks to merge PRs and answer nine questions; T-93, done, says the fixes are not awaiting a
// merge and is "Merged into T-11".
const T11_NEXT = "Merge RegenHub PRs #108 and #109 (both green), then answer the nine operational/editorial questions (door beep, hours, hero wording…) in the";
const regenhub: N[] = [
  { id: "t11", path: "Tasks/T-11 RegenHub site + newsletter systems", content: "RegenHub site + newsletter systems\n\n**Next:** 10-03 17:56: October audit polish → PR #108. Aaron merges; still owes door beep / hours / hero line" },
  { id: "t93", path: "Tasks/T-93 RegenHub: deployed fixes are not awaiting a merge", content: "RegenHub: deployed fixes are not awaiting a merge; nine operational/editorial answers remain.\n\n- Front-door beep: silent keypad / leave it\n- Published opening hours", metadata: { node: "n-rh", state: "done", evidence: "Merged into T-11 (same RegenHub asks: door beep, hours, hero wording)" } },
];

await check("P1-1 the RegenHub shape: a task whose source note is closed says \"Check: … is closed — still needed?\", never its merge step as current", async () => {
  const { vt } = fakeVault(regenhub);
  const s = await vt.loadSupport({ id: "t11", title: "T-11 RegenHub site + newsletter systems", next: T11_NEXT }, ["Projects/RegenHub", "n-rh"], 9);
  assert.deepEqual(s, { kind: "closed", how: "closed", from: { vault: "uni", id: "t93", title: "RegenHub: deployed fixes are not awaiting a merge" } });
  assert.equal(checkLine(s as Extract<typeof s, { kind: "closed" }>), "Check: “RegenHub: deployed fixes are not awaiting a merge” is closed — still needed?");
});

await check("P1-1 only explicit state: a note linked in the step that is done or superseded is a closed source; one merely mentioned in the note is not", async () => {
  const a = "01M4MKXFQWKF85E2XN38W1QYSA", b = "01M4MKXFQWKF85E2XN38W1QYSB", c = "01M4MKXFQWKF85E2XN38W1QYSC";
  const { vt } = fakeVault([
    { id: "t1", path: "Tasks/T-1 Hours", content: `Hours.\n\nHistory: ${c}` },
    { id: a, path: "Projects/X/Hours plan", content: "## Questions\n- When?", metadata: { superseded_by: "Projects/X/Hours plan v2" } },
    { id: b, path: "Tasks/T-2 Old hours", content: "Old", metadata: { state: "archived" } },
    { id: c, path: "Tasks/T-3 Older", content: "Older, done, no questions", metadata: { state: "done" } },
  ]);
  assert.deepEqual(await vt.loadSupport({ id: "t1", title: "T-1 Hours", next: `Answer the 1 question in uni:${a}` }, [], 1), { kind: "closed", how: "superseded", from: { vault: "uni", id: a, title: "Hours plan" } });
  assert.deepEqual(await vt.loadSupport({ id: "t1", title: "T-1 Hours", next: `Answer the 1 question (see ${b})` }, [], 1), { kind: "closed", how: "closed", from: { vault: "uni", id: b, title: "Old hours" } });
  // the done note is only mentioned in the task's own note and holds no questions: not its source, and nothing is claimed
  assert.deepEqual(await vt.loadSupport({ id: "t1", title: "T-1 Hours", next: "Answer the 1 question" }, [], 1), { kind: "unclear", from: null });
  assert.equal(closedBy({ state: "open" }), null);
  assert.equal(closedBy({ state: "decided" }), "closed");
  assert.equal(closedBy({ superseded_by: "" }), null, "an empty field says nothing");
});

await check("P1-2 no answer from punctuation: \"Which opening hours should we publish?\" gets no Yes/No; only stored options, or words", () => {
  const q = answerChoices([]);
  assert.equal(q.box, true);
  assert.deepEqual(q.choices, []);
  assert.ok(!q.choices.some((c) => /^(yes|no)$/i.test(c.label)));
  // the texting statement is no different: nothing is built from its wording ("agree: skip texting" is gone)
  assert.deepEqual(answerChoices([]).choices.map((c) => c.value), []);
  // stored options keep their stored values; Yes/No only when those are the stored options
  assert.deepEqual(answerChoices(["Self-host", "Managed"]).choices, [{ label: "Self-host", value: "Self-host" }, { label: "Managed", value: "Managed" }]);
  assert.equal(answerChoices(["Yes", "No"]).binary, true);
  assert.equal(answerChoices(["Yes", "Later"]).binary, false);
});

await check("P1-2 the answer box: one line, trimmed, at most the vault's 500 characters; empty is nothing to write", () => {
  assert.equal(answerText("  Mon–Fri 9 to 5,\n Sat 10 to 2  "), "Mon–Fri 9 to 5, Sat 10 to 2");
  assert.equal(answerText("   "), null);
  assert.equal(answerText("x".repeat(ANSWER_MAX)), "x".repeat(ANSWER_MAX));
  assert.equal(answerText("x".repeat(ANSWER_MAX + 1)), null);
});

await check("P1-2 the answer box writes like a tap: one vault_decide of decided/decided_at/decided_by, guarded by the revision shown", async () => {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const vt = createVaultTasks(async (cmd, args) => { calls.push({ cmd, args }); return { id: "d1", updatedAt: "2026-10-14T10:00:01Z" }; }, "uni");
  const r = await vt.decide("d1", "Mon–Fri 9 to 5", "aaron", "2026-10-14T10:00:00Z", "2026-10-14T10:00:00Z");
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { cmd: "vault_decide", args: { vault: "uni", id: "d1", from: "open", to: "decided", metadata: { decided: "Mon–Fri 9 to 5", decided_at: "2026-10-14T10:00:00Z", decided_by: "aaron", answered_rev: "2026-10-14T10:00:00Z" }, ifUpdatedAt: "2026-10-14T10:00:00Z" } });
});

await check("P1-3 explicit questions only: a numbered plan is not questions; a wrapped item stays whole; a count that differs is unclear", () => {
  const plan = "# Plan\n\n1. Merge #108\n2. Deploy\n3. Check the door\n";
  assert.equal(questionsFrom(plan, 3), null, "a numbered implementation plan is not questions");
  const wrapped = "Intro\n\n## Questions for Aaron\n1. Front-door beep: silent keypad, leave it,\n   or disable native relock (needs a hold-open plan)?\n2. Published hours?\n   - weekdays only\n\n## Next\n- later";
  assert.deepEqual(questionsFrom(wrapped, 2), { status: "list", items: ["Front-door beep: silent keypad, leave it, or disable native relock (needs a hold-open plan)?", "Published hours? weekdays only"] });
  assert.deepEqual(questionsFrom(wrapped, 9), { status: "unclear", found: 2 }, "the step says nine; the note holds two");
  assert.deepEqual(questionsFrom("Body", 2, { questions: ["Reader?", "Scope?"] }), { status: "list", items: ["Reader?", "Scope?"] }, "a structured questions field");
  assert.deepEqual(linkedRefs("see parachute:01M3ZYXCP9QEM2GS0E5THMXXX4 and 01M3ZYW4HW3CBS6YGGWH5EB0NE"), [{ vault: "parachute", id: "01M3ZYXCP9QEM2GS0E5THMXXX4" }, { vault: null, id: "01M3ZYW4HW3CBS6YGGWH5EB0NE" }]);
});

await check("P1-3 a vault-prefixed id resolves in its own vault, a bare one in the task's", async () => {
  const id = "01M3ZYXCP9QEM2GS0E5THMXXX4";
  const { vt, seen } = fakeVault([
    { id: "t26", path: "Tasks/T-26 Refresh", content: "Refresh" },
    { id, path: "Design/Questions for Aaron", content: "## Questions\n1. Reader?\n2. Scope?", vault: "parachute" },
  ]);
  const s = await vt.loadSupport({ id: "t26", title: "T-26 Refresh", next: `Answer the 2 questions in parachute:${id}`, vault: "uni" }, [], 2);
  assert.deepEqual(s, { kind: "list", items: ["Reader?", "Scope?"], from: { vault: "parachute", id, title: "Questions for Aaron" } });
  // r19: the notes a step links are read first (they are what it stands on), each once; then its own note
  assert.deepEqual(seen.filter((c) => c.cmd === "vault_note").map((c) => [c.vault, c.ref]), [["parachute", id], ["uni", "t26"]]);
});

await check("Copy: a person's step leads with a destination only when it is written as one; the message comes from a stored field", () => {
  const { nodes, rootPath } = parseNodes([{ id: "u", path: "Uni", tags: ["uni"], metadata: {} }]);
  const tree = buildTaskTree(nodes, rootPath);
  const t = (meta: Record<string, unknown>) => parseTask({ id: "x", path: "Tasks/T-101 Tell Christian", tags: ["task"], metadata: { state: "open", owner: "aaron", next: "Tell Christian the BVSD letter went out Oct 2", ...meta } }, tree)!;
  assert.equal(t({}).link, undefined);
  assert.equal(t({}).message, undefined);
  assert.equal(t({ link: "mailto:christian@example.org" }).link, "mailto:christian@example.org");
  assert.equal(t({ url: "https://example.org/letter" }).link, "https://example.org/letter");
  assert.equal(t({ link: "the thread with Christian" }).link, undefined, "words are not a destination");
  assert.equal(t({ message: "Hi Christian — the letter went out Oct 2." }).message, "Hi Christian — the letter went out Oct 2.");
  assert.equal(t({ draft: "Hi Christian" }).message, "Hi Christian");
  assert.equal(t({ draft: "uni:01M3ZYXCP9QEM2GS0E5THMXXX4" }).message, undefined, "a reference to a note is not the message");
  // the step from the scratch copy: no destination written in it
  const a = stepAudience("Tell Christian the BVSD letter went out Oct 2, before the Oct 20 HRC meeting (skip if already done).", null);
  assert.deepEqual(a, { kind: "person", link: null });
  assert.deepEqual(stepAudience("Tell Christian the letter is at https://example.org/l.pdf", null), { kind: "person", link: null }, "a URL in the instruction is not the destination");
});

await check("the summary carries its date: \"Where this stands · 2 days ago\" once older than today, one wording for the companion and the work view", () => {
  assert.equal(standsHeading(null, "2 days ago"), "Where this stands · 2 days ago");
  assert.equal(standsHeading(null, "yesterday"), "Where this stands · yesterday");
  assert.equal(standsHeading(null, "today"), "Where this stands");
  assert.equal(standsHeading(null, ""), "Where this stands");
  assert.equal(standsHeading("Expression", "3 days ago"), "Where Expression stands · 3 days ago");
});

await check("a progress ping older than an hour is a past update; an edited one that is still the newest message may be live", () => {
  const now = Date.parse("2026-10-14T12:00:00Z") / 1000;
  const monday = { ts: Date.parse("2026-10-12T12:29:00Z") / 1000, edited: false };
  assert.equal(staleStatus(monday, now, false), true);
  assert.equal(staleStatus(monday, now, true), true, "the newest, never edited: still stale");
  assert.equal(staleStatus({ ...monday, edited: true }, now, true), false, "edited in place and nothing after it: may be live");
  assert.equal(staleStatus({ ...monday, edited: true }, now, false), true, "something came after it");
  assert.equal(staleStatus({ ts: now - 600, edited: false }, now, false), false, "ten minutes old");
});

await check("one cut: whole words, one ellipsis (never \"wording…) …\"), no hanging word", () => {
  assert.equal(stepText(T11_NEXT).text, "Merge RegenHub PRs #108 and #109 (both green), then answer the nine operational/editorial questions (door beep, hours, hero wording…)");
  assert.equal(cutWords("Cohort 2 Week 7 is underway across three pods with grading next", 32), "Cohort 2 Week 7 is underway…");
  assert.equal(cutWords("short", 32), "short");
  assert.ok(!/\b(the|and|to|of|across)…$/.test(cutWords("Waiting on the decision about the hours and the hero line", 34)));
  assert.equal(cutWords("hero wording…) in the", Infinity), "hero wording…)");
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
