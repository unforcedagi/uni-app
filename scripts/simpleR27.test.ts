// T-124 r27: whole items on a row, honest freshness, summaries as dated accounts, a banner with no trailing comma, bodies that never repeat their heading.
// Run: node --experimental-strip-types scripts/simpleR27.test.ts
import assert from "node:assert/strict";
import {
  answersReady, asOfDate, lastWritten, checkingBanner, detailLists, confirmationOf, itemForms, askStamp, referencedItems,
  repeatsHeading, runStateLabel, standsHeading, unconfirmedLine, waitingOnYou, } from "../src/areas/simpleCore.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const T113_NEXT = "On your phone, look at https://grove.example.org (live now), then forward Harper the asks listed in this task's detail";
const T113_DETAIL = "Live on prod since 10-14 15:24 (PR #61); staging matches. Harper still owes: (1) OK or cut 6 groups of short functional lines (notifications, email links, install, privacy, harvest/board, profile labels); (2) 3 answers: Spanish versions of 'What is COhere?' and 'What's Coming Up', whether 'Explore events on the community events' should end in 'calendar', whether the signed-in Home also gets the hat photo; (3) one morning-practice line per day for Oct 15–25 (her doc has 2); (4) yes/no on the Today heading showing just 'Honoring Water (9 AM at Martin Park)' with 'Home practice:' in bold. Aaron: sign in once as a member and open Board, People and Me.";

// ---- line 5.1: each item is its whole clause
check("T-113's items: the clause after a label, whole; the label alone is never an item", () => {
  const r = referencedItems(T113_NEXT, T113_DETAIL)!;
  if (r.kind !== "list") throw new Error("no list");
  const f = r.items.map(itemForms);
  assert.equal(f[0][0], "OK or cut 6 groups of short functional lines (notifications, email links, install, privacy, harvest/board, profile labels)");
  assert.equal(f[0][1], "OK or cut 6 groups of short functional lines", "then the same without its brackets");
  assert.equal(f[1][0], "Spanish versions of 'What is COhere?' and 'What's Coming Up', whether 'Explore events on the community events' should end in 'calendar', whether the signed-in Home also gets the hat photo");
  assert.ok(f.every((x) => x.every((y) => y !== "3 answers")));
  assert.deepEqual(f[2], ["one morning-practice line per day for Oct 15–25 (her doc has 2)", "one morning-practice line per day for Oct 15–25"]);
});
check("itemForms: never stops at a colon, a comma or mid-phrase; a sentence end is the only cut", () => {
  assert.deepEqual(itemForms("Payer: Techne Foundation"), ["Payer: Techne Foundation"], "a label with too little after it stays whole");
  assert.deepEqual(itemForms("2 questions: who pays and how, plus the legal details."), ["who pays and how, plus the legal details"]);
  const f = itemForms("Confirm the venue. Then tell Harper the new time, and ask about parking.");
  assert.deepEqual(f, ["Confirm the venue. Then tell Harper the new time, and ask about parking", "Confirm the venue"]);
  for (const x of [...f, ...itemForms("a b c d e f g h, i j k:"), ...itemForms("yes/no on the Today heading showing just 'Honoring Water (9 AM at Martin Park)' with 'Home practice:' in bold")]) assert.ok(!/[,;:]$|…/.test(x), x);
  assert.deepEqual(itemForms(""), []);
  assert.deepEqual(itemForms("  ,;: "), []);
});
check("itemForms: a label that isn't a count stays with its clause; a bracket inside a word is not an aside", () => {
  const f = itemForms("Nonprofit details: 501(c)(3) status, legal name, EIN.");
  assert.equal(f[0], "Nonprofit details: 501(c)(3) status, legal name, EIN");
  assert.deepEqual(f, ["Nonprofit details: 501(c)(3) status, legal name, EIN", "501(c)(3) status, legal name, EIN"], "the clause after the colon only when the whole doesn't fit");
});
check("itemForms: a bracket inside a sentence does not make a false sentence end", () => {
  assert.deepEqual(itemForms("Fix the intro (see Fig. 2. Then more) before Friday"), ["Fix the intro (see Fig. 2. Then more) before Friday", "Fix the intro before Friday"]);
});
check("a list under a heading, bulleted, keeps whole items too", () => {
  const l = detailLists("Harper still owes:\n- OK or cut the short lines (a, b, c)\n- one line per day");
  assert.deepEqual(l[0].items.map((x) => itemForms(x)[0]), ["OK or cut the short lines (a, b, c)", "one line per day"]);
});

// ---- line 5.2: the banner
check("the Checking banner ends at a whole word, no trailing , ; : and no ellipsis", () => {
  const step = "Reply: keep or archive the 87 Tana tasks (recommended: keep 15, fold 32, archive 40), then say which";
  const b = checkingBanner(step);
  assert.match(b, /^Checking: /);
  assert.ok(!/[,;:]$|…|\.\.\./.test(b), b);
  assert.ok(!/[,;:]$/.test(checkingBanner("word, ".repeat(60))), "a long step cut at a comma");
  assert.equal(checkingBanner("Say go on prod deploy of #38 + #58,"), "Checking: Say go on prod deploy of #38 + #58");
});

// ---- line 5.4: a body never repeats its heading or title
check("repeatsHeading: the heading or the title said again", () => {
  assert.equal(repeatsHeading("Ship the Boulder Votes AI chat?", "Ship the Boulder Votes AI chat?"), true);
  assert.equal(repeatsHeading("Ship the Boulder Votes AI chat? (preview: chat.bouldervotes-preview.pages.dev)", "Ship the Boulder Votes AI chat?", "x"), true);
  assert.equal(repeatsHeading("Ship the Boulder Votes AI chat", "something else", "Ship the Boulder Votes AI chat?"), true, "equals the title");
  assert.equal(repeatsHeading("Ship the chat to Harper's members first", "Ship the chat?"), false);
  assert.equal(repeatsHeading("", "x"), true);
  assert.equal(repeatsHeading(null, "x"), true);
});

// ---- Codex P1-1: freshness
const NOW = Date.parse("2026-10-15T12:00:00Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

// ---- Codex P1-2: summaries are dated accounts
const COHERE = "COhere 2026 is live on grove.example.org (new look, members, harvests; notifications off); tonight a time-of-day test failure blocks deploys while a fix is built, and register+sign-in (T-138) goes to staging for review on 10-15.";
const WRITTEN = "2026-10-14T12:00:00.000Z";
check("a summary is a dated account: the date and the room, and no freshness verdict (r29)", () => {
  assert.equal(asOfDate(WRITTEN), "Oct 14");
  assert.equal(lastWritten("Oct 14", "cohere"), "Last written Oct 14 by #cohere:");
  assert.equal(lastWritten("Oct 14", "#Uni"), "Last written Oct 14 by #Uni:");
  assert.equal(lastWritten("Oct 14", null), "Last written Oct 14:");
  assert.equal(lastWritten(null, "cohere"), "Last written by #cohere:");
  assert.equal(asOfDate(null), null);
  assert.equal(standsHeading(null, "yesterday", "Oct 14"), "Where this stands", "the date is in the text, not twice");
  assert.equal(standsHeading(null, "2 days ago"), "Where this stands · 2 days ago", "a derived line keeps its age");
  assert.equal(standsHeading("COhere", null, null), "Where COhere stands");
});

// ---- Codex P2-5: a run waiting on Aaron's answer is Needs you
check("a run waiting on the user's answer is not Running", () => {
  assert.equal(waitingOnYou({ state: "decision" }), true);
  for (const s of ["running", "queued", "stalled", "blocked", "done", "failed"]) assert.equal(waitingOnYou({ state: s }), false, s);
  assert.equal(runStateLabel("decision"), "Waiting on you");
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nsimpleR27: all ok");
