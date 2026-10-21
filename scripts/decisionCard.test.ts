// T-212: what turns a room's message into a decision card, and what a won tap posts (the parsers; the card itself is decisionCard.spec.ts).
import assert from "node:assert/strict";
import { chatText, cleanNote, decisionRefsIn, noteLine, parseDecisionNote, pickedLine, questionOf, unreferenced } from "../src/decisionView.ts";
import { parseMarkdown } from "../src/markdown.ts";
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
// T-226: your words on a decision
check("words go with a pick after an em dash; words alone say no pick yet, or what it was decided as when your tap lost", () => {
  assert.equal(pickedLine("B (default)", { id: ID, question: "Which layout?" }, "  keep the menu left \n"), `Picked: B — keep the menu left (decision: Which layout?) uni:${ID}`);
  assert.equal(pickedLine("B", { id: ID, question: "Which layout?" }, "  "), `Picked: B (decision: Which layout?) uni:${ID}`);
  assert.equal(noteLine("ask first", { id: ID, state: "open", decided: null }), `Note on decision (no pick yet): ask first uni:${ID}`);
  assert.equal(noteLine("ask first", { id: ID, state: "decided", decided: "A (default)" }), `Note on decision (decided already: A): ask first uni:${ID}`);
});
check("a note is stored as plain text: line breaks kept, control and direction-override characters dropped, trimmed", () => {
  assert.equal(cleanNote(" a\r\nb\rc\u202e\u0007\td "), "a\nb\nc\td");
  assert.equal(cleanNote(" \n "), "");
});
check("in the room a note reads as typed: markup is escaped and parses back to the same text, with no link, bold or heading", () => {
  for (const t of ["<b>bold</b> [x](javascript:alert(1)) **loud** _u_ `c` ~~s~~ a|b \\ back", "one\n# head\n> quote\n- item\n+ plus\n1. first\n2) second", "3.5 and -5 and a-b"]) {
    const tree = parseMarkdown(chatText(t));
    assert.equal(tree.length, 1, JSON.stringify(tree));
    const p = tree[0] as any;
    assert.equal(p.t, "p");
    assert.ok(p.c.every((n: any) => n.t === "text" || n.t === "br"), JSON.stringify(p.c));
    assert.equal(p.c.map((n: any) => (n.t === "br" ? "\n" : n.v)).join(""), t);
  }
});
check("links and note refs in a note stay as typed; a rule line and a bidi mark don't get through", () => {
  const link = (parseMarkdown(chatText("see https://example.com/a_b~c/x and uni:Projects/my_note"))[0] as any).c;
  assert.deepEqual(link.filter((n: any) => n.t !== "text").map((n: any) => n.t === "link" ? n.href : n.ref.ref), ["https://example.com/a_b~c/x", "Projects/my_note"]);
  const rule = parseMarkdown(chatText("a\n---\nb\n- - -"));
  assert.equal(rule.length, 1, JSON.stringify(rule));
  assert.equal(cleanNote("a\u061cb"), "ab");
  assert.equal(cleanNote("half \ud83d"), "half");
});
check("a decision's words are read back: the pick's note and the notes added alone", () => {
  const d = parseDecisionNote(note({ state: "decided", options: ["A", "B"], decided: "A", decided_note: "because", notes: [{ text: "first", at: "t1", by: "aaron" }, { text: " " }, "junk", null] }))!;
  assert.equal(d.decidedNote, "because");
  assert.deepEqual(d.notes, [{ text: "first", at: "t1", by: "aaron" }]);
  assert.deepEqual(parseDecisionNote(note({ state: "open", options: ["A", "B"] }))!.notes, []);
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
// a read that started before a write and lands after it is dropped; a fresh read is not held up by one under way
{
  const reads: { done: (v: unknown) => void }[] = [];
  const s2 = makeDecisionStore(() => new Promise((done) => reads.push({ done })));
  void s2.load(ID, "uni");                                                   // an old read, under way
  s2.put(ID, "uni", { view: parseDecisionNote(note({ state: "decided", options: ["A", "B"], decided: "B" })), error: null, read: 0 }, s2.generation());
  reads[0].done(note({ state: "open", options: ["A", "B"] }));
  await new Promise((r) => setTimeout(r, 0));
  check("an older read does not undo a tap's answer", () => assert.equal(s2.get(ID, "uni")?.view?.decided, "B"));
  void s2.load(ID, "uni"); void s2.load(ID, "uni", true);
  check("a fresh read goes out even while one is under way", () => assert.equal(reads.length, 3));
  reads[2].done(note({ state: "open", options: ["A", "B"], notes: [{ text: "new", at: "t", by: "aaron" }] }, { updatedAt: "r9" }));
  await new Promise((r) => setTimeout(r, 0));
  reads[1].done(note({ state: "open", options: ["A", "B"] }, { updatedAt: "r8" }));
  await new Promise((r) => setTimeout(r, 0));
  check("only the newest read lands", () => assert.equal(s2.get(ID, "uni")?.view?.updatedAt, "r9"));
}
store.setDraft(ID, "uni", "half a thought");
check("unsent words are kept per decision and vault", () => { assert.equal(store.draft(ID, "uni"), "half a thought"); assert.equal(store.draft(ID, "life"), ""); });
store.forget();
check("Forget drops unsent words with the rest", () => assert.equal(store.draft(ID, "uni"), ""));
if (failed) { console.log(`${failed} failed`); process.exit(1); }
