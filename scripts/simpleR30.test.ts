// T-124 r30: the words Aaron reads are the words stored, and every row can be acted on. Run: node --experimental-strip-types scripts/simpleR30.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTaskTree, parseTask } from "../src/areas/taskCore.ts";
import { parseRuns } from "../src/areas/steerCore.ts";
import { currentStep, detailLists, NEXT_CAP, reasonShort, recheckLine, referencedItems, rowAction, stepText, unconfirmedLine } from "../src/areas/simpleCore.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const fx = JSON.parse(readFileSync(new URL("./fixtures/sample-asks.json", import.meta.url), "utf8")) as { notes: { id: string; path: string; tags: string[]; metadata: Record<string, unknown> }[] };
const tree = buildTaskTree([], null);
const T113 = fx.notes.find((n) => n.path.includes("T-113"))!;

// ---- 1. the words on screen are the stored words
await check("1: a stored step of 140 characters or more, with no ending, keeps every word (T-113 lost \"and Me\")", () => {
  const next = String(T113.metadata.next);
  assert.ok(next.length > NEXT_CAP && /Me$/.test(next));
  assert.deepEqual(stepText(next), { text: next, cut: false });
  const t = parseTask(T113 as never, tree)!;
  assert.equal(currentStep({ ...t, next: stepText(t.next).text }, t.room), next);
});
await check("1: only what the old 140-character writer left (139 or 140 characters, no ending) is taken for a cut step", () => {
  const cut = "Send Harper the new site labels to approve or replace, and ask her for one morning-practice line per day Oct 15-25, then sign in once on the";
  assert.ok(cut.length === 140 || cut.length === 139, String(cut.length));
  const r = stepText(cut);
  assert.equal(r.cut, true);
  assert.ok(!/\bthe$/.test(r.text) && !/on$/.test(r.text));
  assert.equal(stepText(`${cut} site`).cut, false, "a longer step was written whole");
  assert.equal(stepText("Reply to Sebastian. ").cut, false);
});
await check("1: every sample ask: the row's words contain its whole stored next, no word missing", () => {
  let steps = 0;
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  for (const n of fx.notes) {
    const t0 = parseTask(n as never, tree);
    assert.ok(t0, n.path);
    if (t0.kind === "decision") continue; // a decision's row is its question (no `next`)
    const st = stepText(t0.next); const t = { ...t0, next: st.text };
    assert.equal(st.cut, false, `${t.title}: a stored step is never read as cut`);
    if (!t.next) continue;
    steps++;
    const step = currentStep(t, t.room);
    const a = rowAction(step);
    // a row that leads with an action draws it whole; any other row draws the step under its title, whole
    const drawn = a ? a.forms[0].text : t.next;
    const stored = norm(t.next).replace(/\.$/, ""); // (a closing "." is no word)
    assert.equal(norm(drawn).replace(/\.$/, ""), stored, `${t.title}: the row says the stored words`);
    if (a) assert.equal(norm(a.text), stored, `${t.title}: the sheet's heading says the same`);
  }
  assert.ok(steps >= 10, `${steps} asks with a step were checked`);
});

// ---- 2. "listed in detail" carries the list
await check("2: T-113 (the sample one): 'listed in detail' is recognised and its labels are the list, whole, 10 of them", () => {
  const r = referencedItems(String(T113.metadata.next), String(T113.metadata.detail))!;
  assert.equal(r.kind, "list");
  if (r.kind !== "list") return;
  assert.equal(r.noun, "labels");
  assert.equal(r.items.length, 10);
  assert.equal(r.items[0], "Already registered? Sign in");
  assert.equal(r.items[1], "Update your registration");
  assert.equal(r.items[9], "Try again");
  assert.match(r.items[4], /^This email is already registered\. Sign in to change your registration\.$/);
  assert.match(r.rest ?? "", /^Also her call: keep or cut the older registration lines/);
  assert.ok(!/Already registered/.test(r.rest ?? ""), "what is left is the background");
});
await check("2: 'in detail', 'in the detail' and 'in this task's detail' all point at the detail's list", () => {
  const detail = "Items:\n1. One thing to do\n2. Another thing to do\n3. A third thing to do";
  for (const loc of ["listed in detail", "in the detail", "in detail", "listed in this task's detail", "listed below"]) {
    const r = referencedItems(`Send Harper the new labels ${loc} to approve`, detail);
    assert.equal(r?.kind, "list", loc);
  }
  assert.equal(referencedItems("Send Harper the new labels to approve", detail), null, "no pointer, no list");
});
await check("2: a middle-dot run of items under a label is a list (at least three); the sentence after it is the rest", () => {
  const l = detailLists("Names: 'Ann' · 'Bo' · 'Cy'. Then nothing else.");
  assert.equal(l.length, 1);
  assert.deepEqual(l[0].items, ["Ann", "Bo", "Cy"]);
  assert.equal(l[0].rest, "Then nothing else.");
  assert.equal(detailLists("One · two").length, 0);
});

// ---- 4. requests that need confirming
await check("4: the line says it counts requests, and which rooms", () => {
  assert.equal(recheckLine(1), "1 request needs confirming in this room");
  assert.equal(recheckLine(3, "room"), "3 requests need confirming in this room");
  assert.equal(recheckLine(13, "all"), "13 requests need confirming across all rooms");
  assert.ok(!/older/i.test(recheckLine(13, "all")));
});

// ---- 6. a waiting run carries its message
await check("6: a run note's message ref is kept (the row opens the room there)", () => {
  const notes = [{ id: "r1", path: "Runs/x", metadata: { node: "Areas/Techne", state: "decision", summary: "Waiting on your answer in #techne: Ship it?", room: "techne", message_ref: "abc123" } },
    { id: "r2", path: "Runs/y", metadata: { node: "Areas/Techne", state: "decision", summary: "Waiting on your answer in #techne: Ship that?" } }];
  const t = buildTaskTree([{ path: "Areas/Techne", id: "n1", name: "Techne", kind: "area", metadata: {} } as never], null);
  const runs = parseRuns(notes as never, t);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].message, "abc123");
  assert.equal(runs[1].message, null);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("simpleR30: all ok");
