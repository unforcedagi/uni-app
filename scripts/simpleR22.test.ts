// T-124 r22: rows say the whole job, a request shows its age, and private areas show the action, not the content.
// Steps are the real ones from the scratch copy (10-14), no private areas; private items are made-up placeholders.
// Run: node --experimental-strip-types scripts/simpleR22.test.ts
import assert from "node:assert/strict";
import { askedLine, chatMovedOn, firstOfSteps, needsFeed, privateAction, privateActionLabel, privateRestLabel, ROW_ACTION_MAX, rowAction, rowForm, withHosts } from "../src/areas/simpleCore.ts";
import { pairingFailure } from "../src/pairingCore.ts";
import { buildTaskTree, parseNodes, parseTask, type Task } from "../src/areas/taskCore.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const ATLAS = "Edit and send the ATLAS follow-up to Mark and Michael from your account; fill the opening, sign-off and next-review date.";
const WOVEN = "Review the Woven Web handoff draft, fill the unknowns, then talk with Eileen yourself.";
const STAGING = "Look at https://cohere-signup-staging.unforced.workers.dev/?look=ecology on phone, then forward #cohere's 'For Eileen' block (posted 10-13)";
const PAYS = "Tell Uni who pays (Techne or Gitcoin Foundation) and how: crypto or ACH/Stripe, plus Woven Web's legal details.";
const COHERE = "Wed 10-14: say go on prod deploy of #38 + #58; Eileen signs off the copy/photos before/after (posting today); yes/no on add-only DB…";

const shown = (next: string) => withHosts(rowAction(next)!.forms[0].text);

check("a row is the whole job: every verb phrase, both steps, no \"then …\" and no ellipsis", () => {
  const want: [string, string[]][] = [
    [ATLAS, ["Edit and send the ATLAS follow-up", "to Mark and Michael from your account", "fill the opening, sign-off and next-review date"]],
    [WOVEN, ["Review the Woven Web handoff draft", "fill the unknowns", "then talk with Eileen yourself"]],
    [STAGING, ["Look at cohere-signup-staging.unforced.workers.dev on phone", "then forward #cohere's 'For Eileen' block"]],
    [PAYS, ["Tell Uni who pays", "and how: crypto or ACH/Stripe, plus Woven Web's legal details"]],
  ];
  for (const [next, parts] of want) {
    const t = shown(next);
    for (const p of parts) assert.ok(t.includes(p), `${JSON.stringify(t)} lacks ${JSON.stringify(p)}`);
    assert.doesNotMatch(t, /…|\.\.\.|then\s*…?$/);
    assert.equal(rowAction(next)!.forms.length, 1);
  }
  // context that isn't the user's stays the sheet's: COhere's row is the go itself
  assert.equal(shown(COHERE), "Say go on prod deploy of #38 + #58");
  assert.match(rowAction(COHERE)!.rest, /^Eileen signs off/);
});

check("past 160 characters an action is shortened with words: brackets first, then links' addresses; never an ellipsis", () => {
  const long = "Review the placeholder budget (the one from the long planning thread in September, with the three revisions and the notes) and send it to the placeholder board before the meeting";
  assert.ok(withHosts(long).length > ROW_ACTION_MAX);
  assert.equal(rowForm(long), "Review the placeholder budget and send it to the placeholder board before the meeting");
  const linky = "Look at https://example.org/a/very/long/path/that/goes/on/and/on?with=query&and=more&still=more&and=even-more-words-here on phone and send placeholder notes to the placeholder team about the placeholder thing";
  const f = rowForm(linky);
  assert.ok(!/…/.test(f));
  assert.ok(f.length <= linky.length);
  assert.match(f, /^Look at /);
  // the folded strip says step 1 and how many there are, never "then …"
  assert.equal(firstOfSteps(rowAction(STAGING)!.steps), "Look at https://cohere-signup-staging.unforced.workers.dev/?look=ecology on phone (step 1 of 2)");
});

check("a request shows its age: \"asked Oct 11\", or today; the chat has moved on when it is more than a day newer", () => {
  assert.equal(askedLine("2026-10-11T18:00:00.000Z", "2026-10-14"), "asked Oct 11");
  assert.equal(askedLine("2026-10-13T18:00:00.000Z", "2026-10-14"), "asked Oct 13");
  assert.equal(askedLine(`2026-10-14T12:00:00`, "2026-10-14"), "asked today");
  assert.equal(askedLine(null), null);
  const asked = "2026-10-11T18:00:00.000Z";
  assert.equal(chatMovedOn(asked, Date.parse("2026-10-13T09:00:00Z") / 1000), true);
  assert.equal(chatMovedOn(asked, Date.parse("2026-10-12T09:00:00Z") / 1000), false);
  assert.equal(chatMovedOn(asked, null), false);
  assert.equal(chatMovedOn(null, Date.parse("2026-10-13T09:00:00Z") / 1000), false);
});

const tree = (() => { const { nodes, rootPath } = parseNodes([{ id: "u", path: "Uni", tags: ["uni"], metadata: {} }]); return buildTaskTree(nodes, rootPath); })();
const task = (id: string, next: string, kind = "task"): Task => ({ ...parseTask({ id, path: `Tasks/T-9${id} Placeholder ${id}`, tags: [kind], updatedAt: "2026-10-14T06:00:00.000Z", metadata: { state: "open", owner: "aaron", priority: "now", next } }, tree)!, node: "Areas/Private" });

check("private areas show the action (verb and object only), or one plain line when the words may be personal", () => {
  // a short work imperative: its verb and object only
  assert.equal(privateAction({ kind: "task", next: "Book the placeholder appointment" }), "Book the placeholder appointment");
  assert.equal(privateAction({ kind: "task", next: "Call the placeholder office about the form" }), "Call the placeholder office");
  // personal: no work verb, longer than a short imperative, a decision, a link, two steps, a date label
  assert.equal(privateAction({ kind: "task", next: "Placeholder feeling about the placeholder week" }), null);
  assert.equal(privateAction({ kind: "task", next: "Write about the placeholder memory and what the placeholder person said that day at length" }), null);
  assert.equal(privateAction({ kind: "decision", next: "Book the placeholder" }), null);
  assert.equal(privateAction({ kind: "task", next: "Read https://example.org/placeholder" }), null);
  assert.equal(privateAction({ kind: "task", next: "Book the placeholder, then call the placeholder" }), null);
  const priv = (n: string) => (n === "Areas/Private" ? { path: "Areas/Private", name: "Private" } : null);
  const f = needsFeed([task("1", "Book the placeholder appointment"), task("2", "Placeholder feeling about the placeholder week")], priv);
  assert.equal(f.total, 2);
  assert.deepEqual(f.privates[0].actions, ["Book the placeholder appointment"]);
  assert.equal(f.privates[0].others, 1);
  assert.equal(privateActionLabel("Private", f.privates[0].actions[0]), "In Private: Book the placeholder appointment");
  assert.equal(privateRestLabel(f.privates[0]), "In Private: 1 more thing for you · open Private");
  assert.equal(privateRestLabel({ place: "Private", others: 1, actions: [] }), "In Private: 1 thing for you · open Private");
  assert.equal(privateRestLabel({ place: "Private", others: 2, actions: [] }), "In Private: 2 things for you · open Private");
});

check("pairing failures say what happened in words; the raw error is only Details (Codex 5)", () => {
  assert.equal(pairingFailure("start", "Error: relay handshake failed: os error 111"), "Couldn't reach the other device. Check that both are online, start a new pairing there, then paste its link again.");
  assert.match(pairingFailure("start", "invalid pairing uri: missing secret"), /^That link couldn't be read/);
  assert.match(pairingFailure("confirm", "pairing timed out"), /^The other device didn't answer in time/);
  assert.match(pairingFailure("confirm", "decrypt failed"), /^This device wasn't signed in/);
  assert.equal(pairingFailure("scan", "This QR code is not a Uni/Buzz pairing link."), "This QR code is not a Uni/Buzz pairing link.");
  for (const s of ["start", "confirm", "scan"] as const) assert.doesNotMatch(pairingFailure(s, "Error: os error 111"), /os error|Error:/);
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
