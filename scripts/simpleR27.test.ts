// T-124 r27: whole items on a row, honest freshness, summaries as dated accounts, a banner with no trailing comma, bodies that never repeat their heading.
// Run: node --experimental-strip-types scripts/simpleR27.test.ts
import assert from "node:assert/strict";
import {
  answersReady, asOfDate, asOfPrefix, checkInResult, checkingBanner, detailLists, confirmationOf, itemForms, needsRead, askStamp, referencedItems,
  repeatsHeading, runStateLabel, staleLine, staleSummary, standsHeading, unconfirmedLine, waitingOnYou, LOOKUP_LIMIT,
} from "../src/areas/simpleCore.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const T113_NEXT = "On your phone, look at https://cohereboulder.org (live now), then forward Eileen the asks listed in this task's detail";
const T113_DETAIL = "Live on prod since 10-14 15:24 (PR #61); staging matches. Eileen still owes: (1) OK or cut 6 groups of short functional lines (notifications, email links, install, privacy, harvest/board, profile labels); (2) 3 answers: Spanish versions of 'What is COhere?' and 'What's Coming Up', whether 'Explore events on the community events' should end in 'calendar', whether the signed-in Home also gets the hat photo; (3) one morning-practice line per day for Oct 15–25 (her doc has 2); (4) yes/no on the Today heading showing just 'Honoring Water (9 AM at Martin Park)' with 'Home practice:' in bold. Aaron: sign in once as a member and open Board, People and Me.";

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
  const f = itemForms("Confirm the venue. Then tell Eileen the new time, and ask about parking.");
  assert.deepEqual(f, ["Confirm the venue. Then tell Eileen the new time, and ask about parking", "Confirm the venue"]);
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
  const l = detailLists("Eileen still owes:\n- OK or cut the short lines (a, b, c)\n- one line per day");
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
  assert.equal(repeatsHeading("Ship the chat to Eileen's members first", "Ship the chat?"), false);
  assert.equal(repeatsHeading("", "x"), true);
  assert.equal(repeatsHeading(null, "x"), true);
});

// ---- Codex P1-1: freshness
const NOW = Date.parse("2026-10-15T12:00:00Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
check("r28: an ask is confirmed only by its own asked_at: within 3 days, never in the future", () => {
  assert.equal(askStamp(day(0.5), NOW), "recent");
  assert.equal(askStamp(day(2.9), NOW), "recent");
  assert.equal(askStamp(day(3.1), NOW), "old");
  assert.equal(askStamp(null, NOW), "none");
  assert.equal(askStamp("not a date", NOW), "none");
  assert.equal(askStamp(day(-2), NOW), "future", "ahead of this clock by days is a wrong date, not a vouch");
  assert.equal(askStamp(day(-0.001), NOW), "recent", "a clock a few minutes ahead is skew");
});
check("r28: confirmed = a recent asked_at, a room to check, and nothing related since", () => {
  const r = confirmationOf(true, day(1), { kind: "none" }, NOW);
  assert.equal(r.state, "confirmed");
  assert.equal(answersReady("confirmed", false), true);
});
check("r28: a recheck: no date, an old date, a future date, no room, related chat since, a read too short, a chat that can't be read", () => {
  const why = (r: ReturnType<typeof confirmationOf>) => `${r.state}:${r.why}`;
  assert.equal(why(confirmationOf(true, null, { kind: "none" }, NOW)), "recheck:no-date", "no asked_at: updated_at is never a fallback");
  assert.equal(why(confirmationOf(true, day(5), { kind: "none" }, NOW)), "recheck:old");
  assert.equal(why(confirmationOf(true, day(-3), { kind: "none" }, NOW)), "recheck:future");
  assert.equal(why(confirmationOf(false, day(1), { kind: "none" }, NOW)), "recheck:no-room");
  assert.equal(why(confirmationOf(true, day(1), { kind: "found", hit: { key: "#38", ref: "m1", ts: 1 } }, NOW)), "recheck:chat-since");
  assert.equal(why(confirmationOf(true, day(1), { kind: "found", hit: null }, NOW)), "recheck:chat-since", "a read that starts after the ask");
  const f = confirmationOf(true, day(1), { kind: "failed" }, NOW);
  assert.equal(why(f), "recheck:read-failed"); assert.equal(f.failed, true);
  assert.equal(why(confirmationOf(true, day(5), null, NOW)), "recheck:old", "no chat read is needed to say so");
  assert.equal(needsRead(true, day(5), NOW), false);
  assert.equal(needsRead(false, day(1), NOW), false);
  assert.equal(needsRead(true, day(1), NOW), true);
  assert.equal(answersReady("recheck", false), false);
  assert.equal(answersReady("recheck", true), true);
});
check("r28: pending while the room's chat is being read", () => {
  assert.equal(confirmationOf(true, day(1), null, NOW).state, "pending");
  assert.equal(answersReady("pending", false), false);
});
check("the line over an unconfirmed request: 'Asked Oct 13 · not confirmed since'", () => {
  assert.equal(unconfirmedLine("asked Oct 13"), "Asked Oct 13 · not confirmed since");
  assert.equal(unconfirmedLine("added today"), "Added today · not confirmed since");
  assert.equal(unconfirmedLine(null), "Not confirmed since it was written");
});
check("the lookup measures chat against the record's write: only messages after it count", () => {
  const wrote = { at: "2026-10-14T10:00:00Z", kind: "asked" as const };
  const keys = { ids: ["T-90"], words: [] };
  const t = (iso: string) => Date.parse(iso) / 1000;
  assert.deepEqual(checkInResult(wrote, [{ ts: t("2026-10-14T09:00:00Z"), body: "T-90 is ready" }], keys), { kind: "none" }, "chat before the write");
  assert.equal(checkInResult(wrote, [{ ts: t("2026-10-14T11:00:00Z"), body: "T-90 changed" }], keys).kind, "found");
  assert.deepEqual(checkInResult(wrote, [{ ts: t("2026-10-14T11:00:00Z"), body: "lunch" }], keys), { kind: "none" });
});
check("an incomplete lookup is unknown, not 'nothing related': a full read that starts after the write", () => {
  const wrote = { at: "2026-10-14T10:00:00Z", kind: "asked" as const };
  const keys = { ids: ["T-90"], words: [] };
  const base = Date.parse("2026-10-14T12:00:00Z") / 1000;
  const full = Array.from({ length: LOOKUP_LIMIT }, (_, i) => ({ ts: base + i, body: "lunch" }));
  assert.deepEqual(checkInResult(wrote, full, keys), { kind: "found", hit: null });
  const reaches = [{ ts: Date.parse("2026-10-14T08:00:00Z") / 1000, body: "early" }, ...full.slice(1)];
  assert.deepEqual(checkInResult(wrote, reaches, keys), { kind: "none" }, "a read that reaches back before the write is complete");
  assert.deepEqual(checkInResult(wrote, full.slice(0, 20), keys), { kind: "none" }, "a short list is the whole room");
});

// ---- Codex P1-2: summaries are dated accounts
const COHERE = "COhere 2026 is live on cohereboulder.org (new look, members, harvests; notifications off); tonight a time-of-day test failure blocks deploys while a fix is built, and register+sign-in (T-138) goes to staging for review on 10-15.";
const WRITTEN = "2026-10-14T12:00:00.000Z";
check("a fresh summary: nothing newer, nothing claimed, so it shows as written with its date", () => {
  assert.equal(staleSummary(COHERE, WRITTEN, [], [day(3), "2026-10-14T11:59:00.000Z", null]), null);
  assert.equal(staleSummary(COHERE, WRITTEN, [], []), null);
  assert.equal(asOfDate(WRITTEN), "Oct 14");
  assert.equal(asOfPrefix("Oct 14"), "As of Oct 14: ");
  assert.equal(asOfPrefix(null), "");
  assert.equal(asOfDate(null), null);
  assert.equal(standsHeading(null, "yesterday", "Oct 14"), "Where this stands", "the date is in the text, not twice");
  assert.equal(standsHeading(null, "2 days ago"), "Where this stands · 2 days ago", "a derived line keeps its age");
  assert.equal(standsHeading("COhere", null, null), "Where COhere stands");
});
check("a summary older than a task change on the node: the whole of it is older than the latest work", () => {
  const r = staleSummary(COHERE, WRITTEN, [], ["2026-10-14T11:00:00.000Z", "2026-10-14T18:30:00.000Z"])!;
  assert.ok(r);
  assert.equal(r.why, "newer");
  assert.equal(staleLine(r), "This summary is older than the latest work · from Oct 14");
});
check("COhere's real summary: it names nothing that waits on Aaron, so only a newer task dims it", () => {
  assert.equal(staleSummary(COHERE, "2026-10-15T03:32:18.000Z", [{ title: "T-113 Look at cohereboulder.org", next: "forward Eileen the asks" }], ["2026-10-15T03:00:00.000Z"]), null);
  assert.equal(staleSummary(COHERE, "2026-10-15T03:32:18.000Z", [], ["2026-10-15T09:00:00.000Z"])!.why, "newer");
});
check("a summary with no date cannot be compared with the work: only a wait claim dims it", () => {
  assert.equal(staleSummary(COHERE, null, [], [day(0)]), null);
  assert.equal(staleSummary("Waits on Aaron's go.", null, [], [])!.why, "claim");
  assert.equal(staleLine(staleSummary("Waits on Aaron's go.", null, [], [])!), "This summary is older than the latest work");
});

// ---- Codex P2-5: a run waiting on Aaron's answer is Needs you
check("a run waiting on the user's answer is not Running", () => {
  assert.equal(waitingOnYou({ state: "decision" }), true);
  for (const s of ["running", "queued", "stalled", "blocked", "done", "failed"]) assert.equal(waitingOnYou({ state: s }), false, s);
  assert.equal(runStateLabel("decision"), "Waiting on you");
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nsimpleR27: all ok");
