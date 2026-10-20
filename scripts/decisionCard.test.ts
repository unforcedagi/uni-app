// T-212: what turns a room's message into a decision card, and what a won tap posts (the parsers; the card itself is decisionCard.spec.ts).
import assert from "node:assert/strict";
import { decisionRefsIn, parseDecisionNote, pickedLine, questionOf, unreferenced } from "../src/decisionView.ts";
import { makeDecisionStore } from "../src/decisionStore.ts";
let failed = 0;
const check = (n: string, f: () => void) => { try { f(); console.log("ok  ", n); } catch (e) { failed++; console.log("FAIL", n, e); } };
const ID = "01M5D0000000000000000000A1";
const note = (metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: ID, path: "Decisions/2026-10-09 Which layout?", tags: ["decision"], updatedAt: "r1", content: "# Which layout for the garden page?\n\n- A\n- B\n", metadata, ...extra });

check("the ready line tasks.py prints names the decision", () => {
  assert.deepEqual(decisionRefsIn(`Decision: Which layout? — A · B (default) · C. Tap your pick: uni:${ID}`), [ID]);
});
check("refs: each once, in order, at most three; a path ref, another vault, an id inside a word or a URL path are not refs", () => {
  const ids = ["01M5D0000000000000000000A2", "01M5D0000000000000000000A3", "01M5D0000000000000000000A4"];
  assert.deepEqual(decisionRefsIn(`uni:${ID} and uni:${ID}, uni:${ids[0]}. (uni:${ids[1]}) uni:${ids[2]}`), [ID, ids[0], ids[1]]);
  assert.deepEqual(decisionRefsIn(`uni:Decisions/x x:uni:${ID} https://h.example/n/uni:${ID} uni:${ID}X uni:${ID}/more unforced:${ID}`), []);
  assert.deepEqual(decisionRefsIn(""), []);
});
check("a decision note becomes a card: question from its heading, the options, the default by name", () => {
  const d = parseDecisionNote(note({ state: "open", options: ["A", "B", "C"], default: "b", task: "T-7" }))!;
  assert.equal(d.question, "Which layout for the garden page?");
  assert.deepEqual([d.options, d.dflt, d.state, d.updatedAt, d.task], [["A", "B", "C"], "B", "open", "r1", "T-7"]);
});
check("an option written 'B (default)' (older notes) is the default; a default that is no option marks nothing", () => {
  assert.equal(parseDecisionNote(note({ state: "open", options: ["A", "B (default)"] }))!.dflt, "B (default)");
  assert.equal(parseDecisionNote(note({ state: "open", options: ["A", "B"], default: "Z" }))!.dflt, null);
});
check("decided notes carry the answer; other tags and junk are not cards", () => {
  const d = parseDecisionNote(note({ state: "decided", options: ["A", "B"], decided: "A", decided_by: "room" }))!;
  assert.deepEqual([d.state, d.decided, d.decidedBy], ["decided", "A", "room"]);
  assert.equal(parseDecisionNote(note({ state: "open" }, { tags: ["task"] })), null);
  assert.equal(parseDecisionNote(null), null);
  assert.equal(parseDecisionNote({ tags: ["decision"] }), null);
  assert.equal(parseDecisionNote(note({ state: "archived", options: ["A", "B"] }))!.state, "other");
});
check("the question falls back to the file name without its date", () => {
  assert.equal(questionOf(undefined, "Decisions/2026-10-09 Which layout?"), "Which layout?");
  assert.equal(questionOf("no heading", "Decisions/Plain.md"), "Plain");
});
check("a won tap posts the pick without its marker, the question, and the ref", () => {
  assert.equal(pickedLine("B (default)", { id: ID, question: "Which  layout?" }), `Picked: B (decision: Which layout?) uni:${ID}`);
  assert.ok(pickedLine("A", { id: ID, question: "q".repeat(300) }).length <= 175);
});
check("the room lists its open decisions no message names", () => {
  const known = [{ id: "a", channel: "r1" }, { id: "b", channel: "r1" }, { id: "c", channel: "r2" }, { id: "d", channel: null }];
  assert.deepEqual(unreferenced(known, "r1", new Set(["a"])), ["b"]);
});
// the store: Forget (a new identity) drops what was read and any read still under way; vaults don't mix
const pending: { vault: string; id: string; done: (v: unknown) => void }[] = [];
const store = makeDecisionStore((vault, id) => new Promise((done) => pending.push({ vault, id, done })));
const answer = async () => { const p = pending.shift()!; p.done(note({ state: "open", options: ["A", "B"] }, { id: p.id })); await new Promise((r) => setTimeout(r, 0)); };
void store.load(ID, "uni"); await answer();
check("a read decision is shared by vault and id", () => { assert.equal(store.get(ID, "uni")?.view?.question, "Which layout for the garden page?"); assert.equal(store.get(ID, "life"), undefined); });
void store.load(ID, "life");
store.forget();
await answer();
check("Forget empties the store, and a read under way when it did is dropped", () => { assert.equal(store.get(ID, "uni"), undefined); assert.equal(store.get(ID, "life"), undefined); });
const g = store.generation();
store.forget();
store.put(ID, "uni", { view: parseDecisionNote(note({ state: "decided", options: ["A", "B"], decided: "A" })), error: null, read: 0 }, g);
check("a tap's answer that comes back after Forget is not stored", () => assert.equal(store.get(ID, "uni"), undefined));
store.put(ID, "uni", { view: parseDecisionNote(note({ state: "decided", options: ["A", "B"], decided: "A" })), error: null, read: 0 }, store.generation());
check("one from this identity is", () => assert.equal(store.get(ID, "uni")?.view?.decided, "A"));
if (failed) { console.log(`${failed} failed`); process.exit(1); }
