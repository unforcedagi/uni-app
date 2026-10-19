// T-124 r23: honest request dates, an approval that can't outlive its moment, and no ellipsis left.
// Steps are the real shapes from the scratch copy (10-14); the message text is a made-up placeholder.
// Run: node --experimental-strip-types scripts/simpleR23.test.ts
import assert from "node:assert/strict";
import { askedLine, clauseForms, pointsAt, pointsNowhere, quotedMessage, requestDate, stepText, withoutRawIds } from "../src/areas/simpleCore.ts";
import { buildTaskTree, parseNodes, parseTask } from "../src/areas/taskCore.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const tree = (() => { const { nodes, rootPath } = parseNodes([{ id: "u", path: "Uni", tags: ["uni"], metadata: {} }]); return buildTaskTree(nodes, rootPath); })();
const parse = (meta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parseTask({ id: "x", path: "Tasks/T-95 Placeholder", tags: ["task"], createdAt: "2026-10-11T04:35:40.734Z", updatedAt: "2026-10-13T16:58:26.058Z", metadata: { state: "waiting", owner: "aaron", ...meta }, ...extra }, tree)!;

check("P1: \"asked\" means asked: an explicit request time, else when it was added (\"added Oct 11\"); never `updatedAt`", () => {
  // the live shape: no request time stored, created 10-11, rebalanced 10-13
  const t = parse({ next: "Send Nico the deploy-access message below." });
  assert.deepEqual(requestDate(t), { at: "2026-10-11T04:35:40.734Z", kind: "added" });
  // (the note's time, in the user's day: 04:35 UTC on 10-11 is Oct 10 in Mountain time)
  assert.equal(askedLine(requestDate(t), "2026-10-14"), `added Oct ${new Date("2026-10-11T04:35:40.734Z").getDate()}`);
  // the task's own `created` field is preferred to the note's createdAt (a migrated note was created by the migration)
  const c = parse({ next: "x", created: "2026-10-11" }, { createdAt: "2026-10-12T04:00:00Z" });
  assert.equal(askedLine(requestDate(c), "2026-10-14"), "added Oct 11");
  // an explicit request time wins, and reads "asked"
  for (const f of ["asked", "asked_at", "next_at"]) assert.equal(askedLine(requestDate(parse({ next: "x", [f]: "2026-10-06" })), "2026-10-14"), "asked Oct 6", f);
  // a rebalanced record keeps its original date: a new `updatedAt` changes nothing
  const before = askedLine(requestDate(c), "2026-10-14");
  const after = askedLine(requestDate({ ...c, updatedAt: "2026-10-14T09:00:00Z" }), "2026-10-14");
  assert.equal(after, before);
  // neither known: no date at all
  assert.equal(requestDate({}), null);
});


check("text: a step stored cut short is shown as stored, never with \"…\"", () => {
  const cut = "Wed 10-14: say go on prod deploy of #38 + #58; Harper signs off the copy/photos before/after (posting today); yes/no on add-only DB migratio";
  const st = stepText(cut);
  assert.equal(st.cut, true);
  assert.ok(!/…|\.\.\./.test(st.text), st.text);
  assert.ok(st.text.endsWith("yes/no on add-only DB"), st.text);
});

check("text: \"Where this stands\" without raw ids, shortened with words at clause ends, never \"…\"", () => {
  const co = "Staging has the D2 one-app with Harper's copy, photos and Spanish (run 38456928492 green); prod waits on Aaron's Wed 10-14 go for #38, #58, #62.";
  const clean = withoutRawIds(co);
  assert.equal(clean, "Staging has the D2 one-app with Harper's copy, photos and Spanish; prod waits on Aaron's Wed 10-14 go for #38, #58, #62.");
  assert.ok(!/\d{7,}/.test(withoutRawIds("Merged 3f9c2ab1d and run 1234567 passed")), withoutRawIds("Merged 3f9c2ab1d and run 1234567 passed"));
  assert.equal(withoutRawIds("Merged 3f9c2ab1d and run 1234567 passed"), "Merged and passed");
  // a long link goes; a short one, a task id or a date stays
  assert.equal(withoutRawIds("See https://example.invalid/a/very/long/path/that/goes/on/and/on for T-129 on Oct 12."), "See for T-129 on Oct 12.");
  const forms = clauseForms(clean);
  assert.equal(forms[0], clean);
  assert.equal(forms[1], "Staging has the D2 one-app with Harper's copy, photos and Spanish.");
  for (const f of forms) assert.ok(!/…/.test(f), f);
  const uni = "Coordinates five areas with cascading approvals due this week: COhere deployment (Wed), ATLAS grading, Techne contract signing need Aaron decisions.";
  assert.deepEqual(clauseForms(uni), [uni, "Coordinates five areas with cascading approvals due this week."]);
});

check("text: a step that points at a message shows it when it is stored, and asks the room for it when it isn't", () => {
  assert.deepEqual(pointsAt("Send Nico the deploy-access message below (asks for Cloudflare Pages access to bouldernewtech)."), { noun: "message" });
  assert.deepEqual(pointsAt("Send the draft to Theo"), { noun: "draft" });
  // only a sending step: a draft that exists elsewhere is asked about, not sent from here
  assert.equal(pointsAt("Your OK on the draft"), null);
  assert.equal(pointsAt("Edit the draft, check the dates against the calendar, and send it from the shared inbox"), null);
  assert.equal(pointsAt("Pick design A, B or C and answer the follow-ups below"), null);
  assert.equal(pointsAt("Tell Uni who pays (Techne or Gitcoin Foundation) and how"), null);
  assert.equal(pointsAt("Review the Woven Web handoff draft, fill the unknowns"), null);
  const next = "Send Nico the deploy-access message below.";
  // with `detail`, the content travels: nothing to ask for, and a quoted message is the one to copy
  const detail = "Send this to Nico:\n\n'Hey Nico, here is the placeholder message about deploy access for the staging copy.'\n\nAfter he replies, Uni checks the account.";
  assert.equal(pointsNowhere({ next, room: "techne", detail }), null);
  assert.equal(quotedMessage(detail), "Hey Nico, here is the placeholder message about deploy access for the staging copy.");
  assert.equal(quotedMessage("No quote here, only a plan."), null);
  // with none: "Ask #room for the message", the room named
  assert.equal(pointsNowhere({ next, room: "techne" }), "Ask #techne for the message");
  assert.equal(pointsNowhere({ next: "Send the draft to Casey", room: "atlas" }), "Ask #atlas for the draft");
  assert.equal(pointsNowhere({ next, room: null }), "Ask Uni for the message");
  // a link to the note that holds it is the content too
  assert.equal(pointsNowhere({ next: "Send the message in [[Projects/X/Draft]]", room: "techne" }), null);
  assert.equal(pointsNowhere({ next: "Send the message (uni:01M3ZZXEXFNHRJV8KWHAGZZ1KQ)", room: "techne" }), null);
  // parsed from the vault: `detail` is kept
  assert.equal(parse({ next, detail }).detail, detail);
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("simpleR23: all ok");
