// T-124 r17: nothing waiting on Aaron disappears, "Say it" only for the room, questions held in notes, statement decisions, one answer
// mechanism (the chat's link to a decision), the lighter Uni panel and whole-word cuts.
// Real phrasings are task titles (and two non-private next steps) from the scratch copy of the vault; no private area's words.
// Run: node --experimental-strip-types scripts/simpleR17.test.ts
import assert from "node:assert/strict";
import { answerChoices, answerLabel, decideLine, firstWords, isMine, wholeWords, linkedRefs, needsByRow, needsFeed, needsYou, privateNote, questionCount, questionsFrom, stepAudience, uniPanel, waitsOnMe } from "../src/areas/simpleCore.ts";
import { buildTaskTree, parseNodes, parseTask, type Task } from "../src/areas/taskCore.ts";
import { decisionIn } from "../src/decisionLinks.ts";
import { appendDraft } from "../src/areas/composeDraft.ts";
import { isMaintenance } from "../src/chatMarkers.ts";
import { createVaultTasks } from "../src/areas/vaultTasks.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const nd = (id: string, path: string, parent: string | null, tags = ["project"]) => ({ id, path, tags, metadata: parent ? { parent } : {} });
const { nodes, rootPath } = parseNodes([nd("u", "Uni", null, ["uni"]), nd("a-x", "Areas/Atlas", "Uni", ["area"]), nd("p-at", "Projects/ATLAS", "Areas/Atlas")]);
const tree = buildTaskTree(nodes, rootPath);
const mk = (id: string, extra: Record<string, unknown> = {}, tags = ["task"], title = "Do the thing"): Task =>
  parseTask({ id, path: `Tasks/${id} ${title}`, tags, updatedAt: "2026-10-14T08:00:00.000Z", metadata: { node: "Projects/ATLAS", state: "open", owner: "aaron", ...extra } }, tree)!;

await check("P1-1 a task that waits on Aaron is in Needs you whatever its owner, and lights its node's dot", () => {
  for (const owner of ["uni", "room:atlas/teach", "person:leonardo", "aaron"]) {
    const t = mk(`w-${owner}`, { owner, state: "waiting", waiting_on: "aaron", next: "Your OK on the draft" });
    assert.equal(needsYou(t), true, owner);
    assert.equal(isMine(t), true, owner);
  }
  for (const w of ["Aaron", "@aaron", "person:aaron"]) assert.equal(needsYou(mk("v", { owner: "uni", waiting_on: w })), true, w);
  const theirs = mk("t1", { owner: "room:atlas/teach", state: "waiting", waiting_on: "aaron" });
  assert.equal(waitsOnMe(theirs), true);
  assert.equal(waitsOnMe(mk("own", { waiting_on: "aaron" })), false, "his own task is simply his");
  const dots = needsByRow([theirs], new Set(["", "Projects/ATLAS"]), () => undefined);
  assert.deepEqual([...dots], [["Projects/ATLAS", 1]]);
});
await check("P1-1 the r16 owner rule holds when nothing waits on him: Uni's or a room's own drafting is not his", () => {
  assert.equal(needsYou(mk("u", { owner: "uni", state: "doing", next: "Drafting the invite" })), false);
  assert.equal(needsYou(mk("r", { owner: "room:cohere", waiting_on: "external" })), false);
  assert.equal(needsYou(mk("k", { owner: "person:casey", waiting_on: "casey" })), false);
  assert.equal(needsYou(mk("s", { owner: "uni", waiting_on: "aaron", priority: "someday" })), false, "Someday stays in Later for everyone");
});

await check("P1-2 'Say it in #room' only for the room: Say go…, Tell Uni…, Tell the room…, Ask Uni…, a step naming the room", () => {
  // the deploy step from the scratch copy (COhere)
  assert.deepEqual(stepAudience("Say go to deploy #38 (companion) + #58 (Today/Calendar) to production by Wed 10-14.", "cohere"), { kind: "room", text: "Go to deploy #38 (companion) + #58 (Today/Calendar) to production by Wed 10-14" });
  assert.deepEqual(stepAudience("Tell Uni to hold the deploy until Friday", "cohere"), { kind: "room", text: "Hold the deploy until Friday" });
  assert.deepEqual(stepAudience("Tell the room the PR is up", "cohere"), { kind: "room", text: "The PR is up" });
  assert.equal(stepAudience("Ask Uni to surface the current newsletter draft", null)?.kind, "room");
  // the Woven Web step from the scratch copy names its room
  assert.deepEqual(stepAudience("Answer the 7 Woven Web direction questions in #woven-web (A/B/C; lean A+C).", "woven-web"), { kind: "room", text: "" });
  assert.equal(stepAudience("Answer the 7 Woven Web direction questions in #woven-web (A/B/C; lean A+C).", "cohere"), null, "another room's name is not this room");
  assert.deepEqual(stepAudience("Say whether to build the live browser share and whether sessions are kept.", "uni-os"), { kind: "room", text: "" }, "a question to answer puts no words in his mouth");
  assert.deepEqual(stepAudience("Reply 'publish' or what to change.", null), { kind: "room", text: "publish" });
  assert.deepEqual(stepAudience("Say go to send the SOW to Casey", "atlas/build"), { kind: "room", text: "Go to send the SOW to Casey" }, "the word is for the room, whatever follows");
});
await check("P1-2 actions toward a person outside the room are never a room prefill (titles from the scratch copy)", () => {
  for (const title of ["Tell Sebastian the BVSD letter is sent, if not done…", "Send: the invite to Tobias and Leonardo. The draft is in Agent…",
    "Forward to Benya + Harper: the \"Notifications: paste-ready answer\"…", "Send Tobias the 9 questions", "Edit and send the draft to Mark and Dominic"]) {
    const a = stepAudience(title, "cohere");
    assert.equal(a?.kind, "person", title);
    if (a?.kind === "person") assert.equal(a.link, null, "r18: no destination written: no link");
  }
  assert.notEqual(stepAudience("Send the ATLAS Oct 12 follow-up email", "atlas/build")?.kind, "room", "an email is never said in the room");
  assert.notEqual(stepAudience("Say thanks to Mark for the intro", "atlas")?.kind, "room", "said to a person, not the room");
  assert.equal(stepAudience("Reply to jonbo's door messages", "regenhub")?.kind, "person");
  // r18: only an explicit `mailto:` leads; an address or a URL that merely appears in the step does not
  const mail = stepAudience("Email mailto:priya@example.org the second draft", null);
  assert.deepEqual(mail?.kind === "person" && mail.link, { href: "mailto:priya@example.org", label: "Email priya@example.org" });
  const bare = stepAudience("Email priya@example.org the second draft", null);
  assert.equal(bare?.kind === "person" && bare.link, null);
  const url = stepAudience("Tell Sebastian the letter is at https://example.org/letter.pdf.", null);
  assert.equal(url?.kind === "person" && url.link, null);
  // drafting for someone is the room's work, not a message: neither
  assert.equal(stepAudience("Draft the forward to Benya and Harper; bring back for your yes.", "cohere"), null);
  assert.equal(stepAudience("Confirm scope with Casey", null), null);
});

await check("rows: a step that asks for answers to questions says how many; the questions are read from a note's list", () => {
  // the RegenHub step from the scratch copy (cut at 140 by the writer)
  assert.equal(questionCount("Merge RegenHub PRs #108 and #109 (both green), then answer the nine operational/editorial questions (door beep, hours, hero wording…) in the"), 9);
  assert.equal(questionCount("When ready, answer the 7 unforced.org refresh questions (some already decided) in a convo with main."), 7);
  assert.equal(questionCount("Answer the 7 Woven Web direction questions in #woven-web (A/B/C; lean A+C)."), 7);
  assert.equal(questionCount("Draft the IRS call questions for the Woven Web taxes"), null, "drafting questions is not answering them");
  assert.equal(answerLabel(9), "Answer 9 questions");
  assert.equal(answerLabel(1), "Answer 1 question");
  const note = "# Read\n\n- a point\n- another\n\n## Questions for Aaron\n1. **Reader:** who lands here?\n2. Scope: person or body of work?\n\n## Next\n- later";
  assert.deepEqual(questionsFrom(note, 2), { status: "list", items: ["Reader: who lands here?", "Scope: person or body of work?"] }, "the list under the Questions heading");
  // r18: no numbered list or list of the right count elsewhere is taken for questions
  assert.equal(questionsFrom("Intro\n\n- x\n\n1. First\n2. Second", null), null, "a numbered list without a Questions heading is not questions");
  const nine = `Whenever you return, answer any of:\n\n${Array.from({ length: 9 }, (_, i) => `- Item ${i + 1}: [[Projects/RegenHub/Audit 2026-10|the audit]]`).join("\n")}\n\n_Converted._`;
  assert.equal(questionsFrom(nine, 9), null, "r18: a bare list of the step's count is not an explicit source");
  assert.equal(questionsFrom("RegenHub site\n\n**Next:** still owes door beep / hours", 9), null);
  assert.deepEqual(linkedRefs("read + 7 questions written (uni:01M3ZYXCP9QEM2GS0E5THMXXX4); see [[Projects/X/Note|the note]] and 01M3ZYW4HW3CBS6YGGWH5EB0NE"), [{ vault: "uni", id: "01M3ZYXCP9QEM2GS0E5THMXXX4" }, { vault: null, id: "Projects/X/Note" }, { vault: null, id: "01M3ZYW4HW3CBS6YGGWH5EB0NE" }]);
});
await check("rows: the questions are found in the task's note, a note it links, or a closed task merged into it, in the same vault", async () => {
  const notes: Record<string, { id: string; path: string; content: string; metadata?: Record<string, unknown> }> = {
    t11: { id: "t11", path: "Tasks/T-11 RegenHub site", content: "RegenHub site\n\n**Next:** still owes door beep / hours" },
    t93: { id: "t93", path: "Tasks/T-93 RegenHub: nine answers remain", content: `Answer any of:\n\n${Array.from({ length: 9 }, (_, i) => `- Q${i + 1}`).join("\n")}`, metadata: { state: "done", node: "n-rh", evidence: "Merged into T-11 (same asks)" } },
    t26: { id: "t26", path: "Tasks/T-26 unforced.org refresh", content: "**Next:** read + 7 questions written (uni:01M3ZYXCP9QEM2GS0E5THMXXX4)" },
    "01M3ZYXCP9QEM2GS0E5THMXXX4": { id: "01M3ZYXCP9QEM2GS0E5THMXXX4", path: "Projects/unforced.org/Refresh — read and questions (2026-10)", content: "## Questions for Aaron\n1. Reader?\n2. Scope?" },
  };
  const seen: { cmd: string; vault: unknown }[] = [];
  const call = async (cmd: string, args: Record<string, unknown>) => {
    seen.push({ cmd, vault: args.vault });
    if (cmd === "vault_note") { const n = notes[String(args.noteRef)]; if (!n) throw new Error("note not found"); return { note: n }; }
    if (cmd === "vault_query_meta") return Object.values(notes).filter((n) => n.metadata && (args.metadata as any).node.in.includes(n.metadata.node) && (args.metadata as any).state.in.includes(n.metadata.state));
    return [];
  };
  const vt = createVaultTasks(call, "uni");
  // r18: a closed task merged into this one is its source, and it is closed: "Check", never its list as current
  const merged = await vt.loadSupport({ id: "t11", title: "T-11 RegenHub site", next: "answer the nine questions" }, ["Projects/RegenHub", "n-rh"], 9);
  assert.deepEqual(merged, { kind: "closed", how: "closed", from: { vault: "uni", id: "t93", title: "RegenHub: nine answers remain" } });
  const linked = await vt.loadSupport({ id: "t26", title: "T-26 unforced.org refresh", next: "answer the 2 questions" }, [], 2);
  assert.deepEqual(linked, { kind: "list", items: ["Reader?", "Scope?"], from: { vault: "uni", id: "01M3ZYXCP9QEM2GS0E5THMXXX4", title: "Refresh — read and questions (2026-10)" } });
  assert.ok(seen.every((c) => c.vault === "uni"), "every read is in the task's own vault");
  assert.deepEqual(await vt.loadSupport({ id: "t11", title: "T-11 RegenHub site", next: "answer the nine questions" }, [], 9), { kind: "unclear", from: null }, "not written out anywhere found");
});

await check("rows (r18): answers come only from stored options; with none, an answer box, never Yes/No or answers built from the wording", () => {
  assert.deepEqual(answerChoices([]), { choices: [], box: true, binary: false }, "the texting statement and the mail decision: no options, words");
  assert.deepEqual(answerChoices(["Add key and test live on preview first", "Change it first"]).choices.map((c) => c.label), ["Add key and test live on preview first", "Change it first"]);
  assert.deepEqual(answerChoices(["yes", "no"]), { choices: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], box: false, binary: true });
});

await check("P1-3 a message names an open decision by its marker (title id or the task it decides) or by its note id; nothing else links", () => {
  const known = [{ id: "01M4V11N5D02YWZX918DM4FWJA", tid: null, forTask: "T-130" }, { id: "dq-12", tid: "T-12", forTask: null }];
  assert.equal(decisionIn("Eval posted. [decision T-130]", known), "01M4V11N5D02YWZX918DM4FWJA");
  assert.equal(decisionIn("[decision T-12] Pick one of the two", known), "dq-12");
  assert.equal(decisionIn("See uni:01M4V11N5D02YWZX918DM4FWJA for the chat question", known), "01M4V11N5D02YWZX918DM4FWJA");
  assert.equal(decisionIn("[done T-130]", known), null, "a done marker is not a decision");
  assert.equal(decisionIn("[decision T-999] nothing known", known), null);
  assert.equal(decisionIn("Hermes wants to run a command that needs your OK\n`/approve` or `/deny`", known), null, "an approval prompt is just a message now");
  assert.equal(decisionIn("[decision T-130]", []), null);
});

await check("the lighter Uni panel: three rows, one count with the private items folded in, said in its tooltip", () => {
  const own = (id: string) => ({ ...mk(id, { priority: "now" }), node: "" });
  const list = [own("u1"), mk("a1", { priority: "now" }), mk("a2"), mk("a3"), mk("a4"), { ...mk("p1", { priority: "now" }), node: "Areas/Sanctum" }];
  const f = needsFeed(list, (n) => (n.startsWith("Areas/Sanctum") ? { path: "Areas/Sanctum", name: "Sanctum" } : null));
  const p = uniPanel(f);
  assert.deepEqual(p.rows.map((t) => t.id), ["u1", "a1", "a2"]);
  assert.deepEqual(p.privates, [], "no private line in the panel");
  assert.equal(p.rest, 3, "two more rows and the private one");
  assert.equal(p.privateCount, 1);
  assert.equal(p.rows.length + p.rest, f.total);
  assert.equal(privateNote(1), "Includes 1 item in a private area");
  assert.equal(privateNote(3), "Includes 3 items in private areas");
  assert.equal(privateNote(0), null);
});

await check("small: 'Say it' with no words leaves the draft alone; maintenance notes are one muted line", () => {
  assert.equal(appendDraft("half a thought", ""), "half a thought");
  assert.equal(appendDraft(undefined, ""), "");
  assert.equal(appendDraft("a", "b"), "a\n\nb");
  assert.equal(isMaintenance("Self-improvement review: Skill 'client-site-copy' patched."), true);
  assert.equal(isMaintenance("💾 Self-improvement review — memory updated"), true);
  assert.equal(isMaintenance("Let's do a self-improvement review of the site tomorrow"), false);
});

await check("mid-sentence cuts: a cut decision line never ends on a joining word ('…for this year because ›')", () => {
  // the texting decision's cut title from the scratch copy, read before its note (a cold device)
  assert.equal(decideLine("texting is not recommended for this year because carrier…"), "Decide: texting is not recommended for this year");
  assert.equal(firstWords("Edit and send the draft to Mark and Dominic: the follow-up", 46), "Edit and send the draft to Mark and Dominic");
  assert.equal(wholeWords("a daily calendar email to people who…"), "a daily calendar email to people");
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("simpleR17: all ok");
