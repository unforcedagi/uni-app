// T-124 r26: rows carry the content they point at, the heading is the current step, closed tasks and their runs are never open, a summary is
// reconciled claim by claim, a check gates answers.
// Run: node --experimental-strip-types scripts/simpleR26.test.ts
import assert from "node:assert/strict";
import {
  answersReady, checkInResult, closedTask, currentStep, detailLists, gateOf, itemShort, liveRuns, needsYou, notWrittenDown, referencedItems,
  revisionMoved, rowAction, rowItems, staleLine, staleSummary, stepHeading, stepNotes, summaryClauses, titleSays, ANSWER_ANYWAY,
} from "../src/areas/simpleCore.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

// the real shapes, from the scratch vault (T-113 and T-67 / T-70 on Woven Web)
const T113_NEXT = "On your phone, look at https://cohereboulder.org (live now), then forward Eileen the asks listed in this task's detail";
const T113_DETAIL = "Live on prod since 10-14 15:24 (PR #61); staging matches. Eileen still owes: (1) OK or cut 6 groups of short functional lines (notifications, email links, install, privacy, harvest/board, profile labels); (2) 3 answers: Spanish versions of 'What is COhere?' and 'What's Coming Up', whether 'Explore events on the community events' should end in 'calendar', whether the signed-in Home also gets the hat photo; (3) one morning-practice line per day for Oct 15–25 (her doc has 2); (4) yes/no on the Today heading showing just 'Honoring Water (9 AM at Martin Park)' with 'Home practice:' in bold. Aaron: sign in once as a member and open Board, People and Me.";
const T67_NEXT = "Review the Woven Web handoff draft, fill the unknowns, then talk with Eileen yourself.";
const T67_DETAIL = "Draft (not sent to Eileen): [[Projects/Woven Web/Handoff for Eileen]]\n\nKey unknowns only you can fill:\n1. Has Eileen agreed to the whole handoff, including admin and filings, and in what role (ED or board)?\n2. Nonprofit details: 501(c)(3) status, legal name, EIN, Colorado standing, board and officers.\n3. Bank account and signers; who holds the Cloudflare, Network Solutions, Google Workspace and Resend accounts.\n4. Filings: taxes are behind, an IRS call is owed, and an IRS correspondence item may be unanswered. Next hard deadline unknown.\n5. Do you stay on the board?\n\nNothing should be promised to funders until filings are current.";
const T70_NEXT = "Pick Sadhana design A, B or C at https://uni-1.taildf9ce2.ts.net:8459/ and answer the follow-ups below.";
const T70_DETAIL = "Mockups: https://uni-1.taildf9ce2.ts.net:8459/\nContext: [[Projects/Parachute/T-69 Area interfaces]]\nNothing is built until you pick.\n\n1. Direction for Sadhana: A = illuminated manuscript, B = ink on paper, C = living altar. (No recommendation is recorded.)\n2. Who can write to an area's interface? Recommend: Uni and Aaron only.\n3. Sending from an area: recommend every message needs your tap to confirm, at least at first.\n\nNote: the 7 older decisions in the T-69 note are only partly superseded.";

// ---- 1. a row that points at content carries it
check("T-113: the asks come from the inline (1)...(4) list in its own detail, whole, with the sentence after the list left out", () => {
  const r = referencedItems(T113_NEXT, T113_DETAIL)!;
  assert.equal(r.kind, "list");
  if (r.kind !== "list") return;
  assert.equal(r.noun, "asks");
  assert.equal(r.label, "Eileen still owes");
  assert.equal(r.items.length, 4);
  assert.match(r.items[0], /^OK or cut 6 groups of short functional lines \(notifications/);
  assert.match(r.items[1], /^3 answers: Spanish versions of 'What is COhere\?'.*hat photo$/);
  assert.equal(r.items[2], "one morning-practice line per day for Oct 15–25 (her doc has 2)");
  assert.match(r.items[3], /^yes\/no on the Today heading showing just 'Honoring Water \(9 AM at Martin Park\)' with 'Home practice:' in bold$/);
  assert.equal(r.rest, "Live on prod since 10-14 15:24 (PR #61); staging matches. Aaron: sign in once as a member and open Board, People and Me.");
});
check("T-113: the row shows the first 3 (short) and 'and 1 more'; the step no longer points at the detail", () => {
  const r = referencedItems(T113_NEXT, T113_DETAIL)!;
  if (r.kind !== "list") throw new Error("no list");
  const row = rowItems(r.items);
  assert.equal(row.shown.length, 3);
  assert.equal(row.more, 1);
  assert.equal(row.shown[0], "OK or cut 6 groups of short functional lines");
  assert.equal(row.shown[1], "3 answers");
  assert.ok(row.shown.every((x) => !/…|\.\.\./.test(x) && x.length <= 72), row.shown.join(" | "));
  assert.equal(currentStep({ next: T113_NEXT, room: "cohere" }), "On your phone, look at https://cohereboulder.org (live now), then forward Eileen the asks");
  assert.equal(rowAction(currentStep({ next: T113_NEXT, room: "cohere" }))!.steps.length, 2);
});
check("Woven Web T-67: 'fill the unknowns' takes the list under 'Key unknowns only you can fill:'", () => {
  const r = referencedItems(T67_NEXT, T67_DETAIL)!;
  assert.equal(r.kind, "list");
  if (r.kind !== "list") return;
  assert.equal(r.noun, "unknowns");
  assert.equal(r.label, "Key unknowns only you can fill");
  assert.equal(r.items.length, 5);
  assert.equal(r.items[4], "Do you stay on the board?");
  assert.equal(r.rest, "Draft (not sent to Eileen): [[Projects/Woven Web/Handoff for Eileen]]\n\nNothing should be promised to funders until filings are current.");
  assert.equal(rowItems(r.items).more, 2);
});
check("T-70: 'the follow-ups below' takes the detail's only list, with no label", () => {
  const r = referencedItems(T70_NEXT, T70_DETAIL)!;
  assert.equal(r.kind, "list");
  if (r.kind !== "list") return;
  assert.equal(r.label, null);
  assert.equal(r.items.length, 3);
  assert.equal(currentStep({ next: T70_NEXT, room: "sadhana" }), "Pick Sadhana design A, B or C at https://uni-1.taildf9ce2.ts.net:8459/ and answer the follow-ups.");
});
check("nothing resolves: a step that points at a list its task doesn't hold says so, and never borrows another note's", () => {
  const r = referencedItems("Forward Eileen the asks listed in this task's detail", "Live on prod since 10-14. Nothing else is written here.")!;
  assert.deepEqual(r, { kind: "none", noun: "asks" });
  assert.equal(notWrittenDown("asks"), "The asks aren't written down in this task");
  assert.deepEqual(referencedItems("Fill the unknowns", null), { kind: "none", noun: "unknowns" });
  // two lists and neither is headed for the unknowns: not guessed
  assert.equal(referencedItems("Fill the unknowns", "Steps:\n1. a thing\n2. another\n\nLinks:\n- one\n- two")!.kind, "none");
  // a bare "the unknowns" with only a located list is not the 'sole list' rule: it needs a heading
  assert.equal(referencedItems("Fill the unknowns", "1. a thing\n2. another")!.kind, "none");
});
check("steps that do not point at a list are left alone; a count of questions keeps its own source", () => {
  assert.equal(referencedItems("Say go to deploy #38 + #58", T113_DETAIL), null);
  assert.equal(referencedItems("Answer the nine operational questions in the woven-web note", "1. a\n2. b"), null);
  assert.equal(referencedItems("Tell Uni who pays and how", "Needed from you:\n1. Payer"), null);
  assert.equal(referencedItems("Send Ryan the deploy-access message below", "Send this to Ryan: 'Hey'"), null);
});
check("a bulleted list under a heading line, and an item with a continuation line, stay whole", () => {
  const l = detailLists("Context here.\n\nQuestions for Aaron:\n- First thing to settle\n  with a second line\n- Second thing\n\nTail.");
  assert.equal(l.length, 1);
  assert.deepEqual(l[0].items, ["First thing to settle with a second line", "Second thing"]);
  assert.equal(l[0].label, "Questions for Aaron");
  assert.equal(l[0].rest, "Context here.\n\nTail.");
});
check("itemShort: whole, else without brackets, else its label, else whole words; never '…'", () => {
  assert.equal(itemShort("Do you stay on the board?"), "Do you stay on the board?");
  assert.equal(itemShort("Payer: Techne Foundation or Gitcoin Foundation? Legal name, address, billing contact and a lot more words here, enough to run past the limit"), "Payer");
  const t = itemShort("aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp");
  assert.ok(t.length <= 72 && !/…/.test(t), t);
});

// ---- 2. the heading is the current step in full
check("heading: a trailing note-link parenthetical is dropped from the step and kept for the quiet line", () => {
  const next = "Approve or change the unforced.dev mail cutover plan (uni:01M3ZR1RDJAZXTM6NQS74P8YS5)";
  assert.equal(stepHeading(next), "Approve or change the unforced.dev mail cutover plan");
  assert.equal(stepNotes(next), "uni:01M3ZR1RDJAZXTM6NQS74P8YS5");
  assert.equal(currentStep({ next, room: "mail" }), "Approve or change the unforced.dev mail cutover plan");
});
check("heading: a parenthetical that repeats the step is dropped; one that adds something stays", () => {
  assert.equal(stepHeading("Approve the mail cutover plan (mail cutover plan)"), "Approve the mail cutover plan");
  assert.equal(stepHeading("Send Ryan the deploy-access message (asks for Cloudflare Pages access to bouldernewtech)."), "Send Ryan the deploy-access message (asks for Cloudflare Pages access to bouldernewtech).");
  assert.equal(stepHeading("Look at the site (live now)"), "Look at the site (live now)");
});
check("the quiet title line drops a trailing '(…)' that repeats the heading", () => {
  assert.equal(titleSays("T-9 Review the unforced.dev mail migration (cutover plan)", "Approve or change the cutover plan"), "Review the unforced.dev mail migration");
  assert.equal(titleSays("T-9 Send the ATLAS invoice (Net 15)", "Look at something else"), "Send the ATLAS invoice (Net 15)");
});

// ---- 3. closed tasks
check("an archived task whose title says 'approved' is not in Needs you; neither is a superseded one", () => {
  const base = { kind: "task" as const, owner: "aaron", waitingOn: "aaron", priority: "now" as const };
  assert.equal(needsYou({ ...base, state: "archived", title: "T-13 Self-hosted mail: approved 10-02", next: "Superseded by T-136 (Aaron, 10-14)" }), false);
  assert.equal(needsYou({ ...base, state: "waiting", title: "T-13 Self-hosted mail: approved 10-02", next: "Superseded by T-136 (Aaron, 10-14)" }), false, "state still open, step says superseded");
  assert.equal(needsYou({ ...base, state: "done", title: "T-5 x", next: "Say go" }), false);
  assert.equal(needsYou({ ...base, state: "waiting", title: "T-113 Look", next: "Say go" }), true);
  assert.equal(closedTask({ state: "archived" }), true);
  assert.equal(closedTask({ state: "open", next: "Superseded by T-136" }), true);
  assert.equal(closedTask({ state: "open", next: "Say go" }), false);
});
check("a run about a closed or missing task is not running; one about an open task, or about no T-NN, stays", () => {
  const runs = [
    { id: "a", task: "T-13", what: "Waiting on your answer in #Uni" },
    { id: "b", task: "T-113", what: "Design round" },
    { id: "c", task: null, what: "Upkeep" },
    { id: "d", task: "T-999", what: "Unknown" },
    { id: "e", task: "T-14", what: "Closed" },
  ];
  const tasks = [
    { title: "T-113 Look at cohereboulder.org", state: "waiting" as const, next: "Say go" },
    { title: "T-14 Old", state: "done" as const, next: "" },
  ];
  assert.deepEqual(liveRuns(runs, tasks, true).map((r) => r.id), ["b", "c"]);
  assert.deepEqual(liveRuns(runs, tasks, false).map((r) => r.id), ["a", "b", "c", "d"], "a list not read in full hides only what it names as closed");
  assert.deepEqual(liveRuns(runs, [{ title: "T-13 Self-hosted mail: approved 10-02", state: "archived" as const, next: "x" }, ...tasks], false).map((r) => r.id), ["b", "c", "d"]);
});

// ---- 4 (Codex P1 1): a check gates answers
check("the four states and what each offers", () => {
  assert.equal(gateOf(false, null), "none", "a task with no room check has the ordinary actions");
  assert.equal(gateOf(true, null), "pending");
  const keys = { ids: ["#38"], words: [] };
  assert.equal(gateOf(true, checkInResult({ at: "2026-10-12", kind: "added" }, null, keys)), "failed");
  assert.equal(gateOf(true, checkInResult({ at: "2026-10-12", kind: "added" }, [], keys)), "none");
  assert.equal(gateOf(true, checkInResult({ at: "2026-10-12", kind: "added" }, [{ ts: Date.parse("2026-10-13T10:00:00Z") / 1000, body: "deploy #38 went fine" }], keys)), "found");
  assert.equal(answersReady("none", false), true);
  for (const g of ["pending", "found", "failed"] as const) { assert.equal(answersReady(g, false), false, g); assert.equal(answersReady(g, true), true, `${g} after ${ANSWER_ANYWAY}`); }
});
check("the revision guard: a task changed since the sheet loaded", () => {
  assert.equal(revisionMoved("2026-10-14T10:00:00Z", "2026-10-14T10:00:00Z"), false);
  assert.equal(revisionMoved("2026-10-14T10:00:00Z", "2026-10-14T11:00:00Z"), true);
  assert.equal(revisionMoved(null, "2026-10-14T11:00:00Z"), false);
});

// ---- 5 (Codex P1 2): summaries claim by claim
const FROM = "2026-10-13T18:00:00.000Z";
check("a multi-ID summary where one id matches: the matched claim stays, the other is dated history", () => {
  const s = "Prod deploy of #38 waits on Aaron's go; #58 also waits on Aaron's approval; docs shipped on staging.";
  const r = staleSummary(s, FROM, [{ title: "T-90 Deploy", next: "Say go to deploy #38" }])!;
  assert.ok(r);
  assert.deepEqual(r.history, ["#58 also waits on Aaron's approval"]);
  assert.equal(r.current, "Prod deploy of #38 waits on Aaron's go; docs shipped on staging.");
  assert.equal(r.from, "Oct 13");
  assert.equal(staleLine(r), "Part of this summary needs updating · from Oct 13");
  // every id a claim names must be open: one of two is not enough
  const both = staleSummary("Deploy of #38 and #58 waits on Aaron's go.", FROM, [{ title: "T-90", next: "Say go to deploy #38" }])!;
  assert.deepEqual(both.history, ["Deploy of #38 and #58 waits on Aaron's go"]);
  assert.equal(both.current, "");
  assert.equal(staleLine(both), "This summary needs updating · from Oct 13");
  assert.equal(staleSummary("Deploy of #38 + #58 waits on Aaron's go.", FROM, [{ title: "T-90", next: "Say go to deploy #38 + #58" }]), null);
  // a PR number is an id
  assert.equal(staleSummary("PR #61 waits on Aaron's approval.", FROM, [{ title: "T-113 Look", detail: "Live on prod (PR #61)" }]), null);
});
check("a summary with no ids: two distinctive words, in the same claim, in one item; one shared word is not enough", () => {
  const s = "Follow-up email drafted and awaiting approval; grading and discovery end date waiting on Aaron.";
  const r = staleSummary(s, FROM, [{ title: "T-129 Send the ATLAS Oct 12 follow-up email", next: "Edit and send the ATLAS follow-up to Mark and Michael" }])!;
  assert.ok(r);
  assert.deepEqual(r.history, ["grading and discovery end date waiting on Aaron"]);
  assert.equal(r.current, "Follow-up email drafted and awaiting approval.");
  // one word shared (email) does not validate a whole paragraph
  const one = staleSummary("SOW waiting on Aaron to add the wallet.", FROM, [{ title: "T-1 Add the logo", next: "Send the wallet card" }])!;
  assert.equal(one.history.length, 1, "wallet alone");
  assert.equal(staleSummary("SOW waiting on Aaron to add the wallet and sign individually.", FROM, [{ title: "T-1 Add wallet", next: "Sign the SOW individually or as an LLC" }]), null);
  // a clause with too few words reads with the clause before it
  assert.equal(staleSummary("Wallet SOW ready for signature, waiting on Aaron.", FROM, [{ title: "T-1 SOW signature", next: "Add the wallet" }]), null);
});
check("COhere's real summary says nothing waits on Aaron: it is current, whole", () => {
  const s = "COhere 2026 is live on cohereboulder.org (new look, members, harvests; notifications off); tonight a time-of-day test failure blocks deploys while a fix is built, and register+sign-in (T-138) goes to staging for review on 10-15.";
  assert.equal(staleSummary(s, "2026-10-15T03:32:18.000Z", []), null);
  assert.equal(staleSummary(s, "2026-10-15T03:32:18.000Z", [{ title: "T-113 Look at cohereboulder.org", next: "forward Eileen the asks" }]), null);
});
check("a summary that waits on Aaron with no open item at all is all history; one that waits on nothing is untouched", () => {
  const r = staleSummary("Tuesday: Atlas review done; follow-up waiting on Aaron's go.", FROM, [])!;
  assert.deepEqual(r.history, ["follow-up waiting on Aaron's go"]);
  assert.equal(r.current, "Tuesday: Atlas review done.");
  assert.equal(staleSummary("Quiet; no open tasks.", FROM, []), null);
});
check("summaryClauses keeps brackets whole and does not split a list of ids", () => {
  const c = summaryClauses("Deploy of #38, #58 waits on Aaron (go, then ship); done.").map((x) => x.text);
  assert.deepEqual(c, ["Deploy of #38, #58 waits on Aaron (go, then ship)", "done"]);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
