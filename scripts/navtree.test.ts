// T-124 r7: the sidebar's fold state and width, Back/Forward history, the tab-set migration, link text and the needs-you feed.
// Run: node --experimental-strip-types scripts/navtree.test.ts
import assert from "node:assert/strict";
import { ancestorsOf, clampWidth, hasKids, isOpen, parseFolds, parseSidebar, rolledNeeds, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, visibleRows } from "../src/areas/sidebarState.ts";
import { canBack, canForward, EMPTY_HISTORY, recent, step, visit, type History } from "../src/navHistory.ts";
import { EMPTY_TABS, isSurface, migrateLegacyTabs, persistable, restoreTabs, serializeTabs, type Tabs, type TabTarget } from "../src/tabs.ts";
import { linkLabel, splitLinks } from "../src/areas/linkText.ts";
import { actionableTitle, askFromContent, dueLine, isCutTitle, isOverdue, topNeeds } from "../src/areas/simpleCore.ts";
import { splitRefs, titleOfPath } from "../src/areas/noteRefsCore.ts";
import { readMessages, readRooms, readWho, writeMessages, writeRooms, writeWho } from "../src/chatCache.ts";
import { isActiveRun } from "../src/areas/steerCore.ts";
import { whereWeAre } from "../src/areas/whereCore.ts";
import { buildTaskTree, parseNodes, parseTask, type Task } from "../src/areas/taskCore.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

// Uni / Atlas (ATLAS, Institute) / Boulder (AI Oracle, Civic (Votes))
const rows = [
  { path: "", depth: 0 }, { path: "A", depth: 1 }, { path: "A/1", depth: 2 }, { path: "A/2", depth: 2 },
  { path: "B", depth: 1 }, { path: "B/1", depth: 2 }, { path: "B/2", depth: 2 }, { path: "B/2/x", depth: 3 }, { path: "C", depth: 1 },
];
check("folds: areas are folded by default, except the one that holds the open room", () => {
  assert.deepEqual(visibleRows(rows, {}, undefined).map((r) => r.path), ["", "A", "B", "C"]);
  assert.deepEqual(visibleRows(rows, {}, "B/2/x").map((r) => r.path), ["", "A", "B", "B/1", "B/2", "B/2/x", "C"]);
  assert.deepEqual(ancestorsOf(rows, "B/2/x"), ["B/2", "B"]);
  assert.deepEqual(ancestorsOf(rows, ""), []);
});
check("folds: the user's choice beats the default, both ways; Uni never folds", () => {
  assert.equal(isOpen(rows, { B: false }, "B/1", "B"), false);
  assert.equal(isOpen(rows, { A: true }, undefined, "A"), true);
  assert.equal(isOpen(rows, { "": false }, undefined, ""), true);
  assert.deepEqual(visibleRows(rows, { A: true, B: true }, undefined).map((r) => r.path), ["", "A", "A/1", "A/2", "B", "B/1", "B/2", "C"]);
  assert.equal(hasKids(rows, 1), true); assert.equal(hasKids(rows, 2), false); assert.equal(hasKids(rows, 8), false);
});
check("folds: a folded row keeps its dot when anything under it needs you", () => {
  const needs = new Map([["B/2/x", 1], ["C", 2]]);
  assert.equal(rolledNeeds(rows, needs, 4), 1); // B
  assert.equal(rolledNeeds(rows, needs, 1), 0); // A
  assert.equal(rolledNeeds(rows, needs, 8), 2); // C
});
check("folds and sidebar parse safely", () => {
  assert.deepEqual(parseFolds('{"a":true,"b":false,"c":3}'), { a: true, b: false });
  assert.deepEqual(parseFolds("nope"), {}); assert.deepEqual(parseFolds(null), {}); assert.deepEqual(parseFolds("[1]"), {});
  assert.deepEqual(parseSidebar(null), { width: SIDEBAR_DEFAULT, hidden: false });
  assert.deepEqual(parseSidebar('{"width":9000,"hidden":true}'), { width: SIDEBAR_MAX, hidden: true });
  assert.equal(clampWidth(10), SIDEBAR_MIN); assert.equal(clampWidth(NaN), SIDEBAR_DEFAULT); assert.equal(clampWidth(250.4), 250);
  assert.equal(SIDEBAR_DEFAULT, 220);
});

const room = (c: string, title = c): TabTarget => ({ kind: "area", path: c, channel: c, title });
const uni: TabTarget = { kind: "areas", title: "Uni" };
check("history: visit, back, forward; going somewhere new drops what was ahead", () => {
  let h: History = EMPTY_HISTORY;
  h = visit(h, uni); h = visit(h, room("A")); h = visit(h, room("B"));
  assert.equal(h.entries.length, 3); assert.equal(canBack(h), true); assert.equal(canForward(h), false);
  const back = step(h, -1)!; assert.equal((back.target as { path: string }).path, "A"); h = back.history;
  assert.equal(canForward(h), true);
  h = visit(h, room("C"));
  assert.deepEqual(h.entries.map((e) => (e.kind === "area" ? e.path : "uni")), ["uni", "A", "C"]);
  assert.equal(canForward(h), false);
  assert.equal(step(h, 1), null);
});
check("history: the same place twice is one entry; a note or vault is never an entry", () => {
  let h = visit(EMPTY_HISTORY, room("A"));
  h = visit(h, room("A")); assert.equal(h.entries.length, 1);
  const same = visit(h, room("A")); assert.equal(same, h);
  h = visit(h, { kind: "note", title: "n", note: { hub: null, vault: "uni", ref: "x" } }); assert.equal(h.entries.length, 1);
  h = visit(h, { kind: "vault", vault: "uni", title: "uni" }); assert.equal(h.entries.length, 1);
});
check("history: recent is the last five distinct places before this one, newest first", () => {
  let h = EMPTY_HISTORY;
  for (const c of ["A", "B", "C", "A", "D", "E", "F", "G"]) h = visit(h, room(c));
  const r = recent(h).map((t) => (t.kind === "area" ? t.path : ""));
  assert.deepEqual(r, ["F", "E", "D", "A", "C"]);
  assert.equal(recent(h, 2).length, 2);
});

check("tabs: only places are saved (a note or vault is never what the app reopens to)", () => {
  const s: Tabs = { tabs: [{ id: "1", kind: "area", path: "Areas/X", title: "X" }, { id: "2", kind: "note", note: { hub: null, vault: "uni", ref: "r" }, title: "n" }], active: "2", recent: ["1", "2"] };
  const p = persistable(s);
  assert.deepEqual(p.tabs.map((t) => t.id), ["1"]); assert.equal(p.active, "1"); assert.deepEqual(p.recent, ["1"]);
  assert.ok(isSurface({ kind: "journal" }) && !isSurface({ kind: "vault" }));
});
check("tabs: uni.tabs.v1 migrates to its active place alone; a note-only set opens nothing in particular", () => {
  const v1 = serializeTabs({ tabs: [{ id: "a", kind: "room", channel: "r1", title: "r1" }, { id: "b", kind: "area", path: "Areas/Boulder", title: "Boulder" }, { id: "c", kind: "note", note: { hub: null, vault: "uni", ref: "r" }, title: "n" }], active: "b", recent: ["a", "b"] });
  const m = migrateLegacyTabs(v1, ["r1"]);
  assert.equal(m.tabs.length, 1); assert.equal(m.tabs[0].path, "Areas/Boulder"); assert.equal(m.active, "b");
  const onNote = serializeTabs({ tabs: [{ id: "a", kind: "room", channel: "r1", title: "r1" }, { id: "c", kind: "note", note: { hub: null, vault: "uni", ref: "r" }, title: "n" }], active: "c", recent: ["a", "c"] });
  assert.equal(migrateLegacyTabs(onNote, ["r1"]).tabs[0].channel, "r1", "the last place under the note");
  assert.deepEqual(migrateLegacyTabs(null, []), EMPTY_TABS); assert.deepEqual(migrateLegacyTabs("garbage", []), EMPTY_TABS);
  assert.equal(restoreTabs(JSON.stringify({ v: 1, tabs: [], active: null, recent: [] }), []).tabs.length, 0);
});

check("links: a URL reads as its domain, stays a link, trailing punctuation stays out", () => {
  assert.deepEqual(splitLinks("Try https://docs.example.com/a/b?x=1, then answer"), [{ text: "Try " }, { url: "https://docs.example.com/a/b?x=1", label: "docs.example.com" }, { text: ", then answer" }]);
  assert.deepEqual(splitLinks("see www.example.org."), [{ text: "see " }, { url: "https://www.example.org", label: "example.org" }, { text: "." }]);
  assert.deepEqual(splitLinks("no links here"), [{ text: "no links here" }]);
  assert.deepEqual(splitLinks("(https://a.io/x)"), [{ text: "(" }, { url: "https://a.io/x", label: "a.io" }, { text: ")" }]);
  assert.equal(linkLabel("http://localhost:3000/x"), "link");
  assert.equal(splitLinks("javascript:alert(1)").length, 1);
});

// needs-you feed
const nd = (id: string, path: string, parent: string | null, tags = ["project"]) => ({ id, path, tags, metadata: parent ? { parent } : {} });
const { nodes, rootPath } = parseNodes([nd("u", "Uni", null, ["uni"]), nd("a-x", "Areas/Atlas", "Uni", ["area"]), nd("p-at", "Projects/ATLAS", "Areas/Atlas")]);
const tree = buildTaskTree(nodes, rootPath);
const AT = 1_000_000;
const mk = (id: string, extra: Record<string, unknown> = {}, tags = ["task"]): Task =>
  parseTask({ id, path: `Tasks/${id} Do the thing`, tags, updatedAt: new Date(AT).toISOString(), metadata: { node: "Projects/ATLAS", state: "open", owner: "aaron", ...extra } }, tree)!;
const feed = (tasks: Task[], today = "2026-10-01") => topNeeds(whereWeAre({ tasks, hidden: () => false, nowMs: AT }), undefined, Infinity, today).map((t) => t.id);
check("needs-you feed: Aaron's own (or waiting on him), Now and Soon (unsorted is Soon), open decisions; Someday is not there", () => {
  const list = [mk("soon1", { priority: "soon" }), mk("none1"), mk("now1", { priority: "now" }), mk("some1", { priority: "someday" }),
    mk("room1", { owner: "room:atlas", priority: "now" }), mk("wait1", { owner: "room:atlas", state: "waiting", waiting_on: "aaron", priority: "now" }), mk("dec1", { priority: "someday", options: ["a"] }, ["decision"])];
  const ids = feed(list);
  assert.ok(!ids.includes("some1"), "someday task hidden"); assert.ok(!ids.includes("room1"), "a room's task is not Aaron's");
  assert.ok(ids.includes("wait1") && ids.includes("none1") && ids.includes("dec1"));
  assert.equal(ids.indexOf("dec1"), ids.length - 1, "a someday decision sorts last");
});
check("needs-you feed: done and archived never appear; Now before Soon, then due date (undated last)", () => {
  const ids = feed([mk("d", { state: "done", priority: "now" }), mk("ar", { state: "archived" }), mk("s1", { priority: "soon", due: "2026-10-12" }), mk("n2", { priority: "now", due: "2026-10-20" }), mk("n1", { priority: "now", due: "2026-10-15" }), mk("n3", { priority: "now" })]);
  assert.deepEqual(ids, ["n1", "n2", "n3", "s1"]);
});
check("needs-you feed: an empty feed is empty; a title with words is an action, a bare id is not", () => {
  assert.deepEqual(feed([]), []);
  assert.equal(actionableTitle("Confirm scope with Casey"), true); assert.equal(actionableTitle("Casey call"), true); assert.equal(actionableTitle("Taxes"), false); assert.equal(actionableTitle(""), false);
});

check("overdue: a passed due date is listed first, oldest first, with a quiet 'was due' line", () => {
  const ids = feed([mk("n1", { priority: "now", due: "2026-10-15" }), mk("late2", { priority: "soon", due: "2026-10-12" }), mk("late1", { priority: "soon", due: "2026-10-10" }), mk("n3", { priority: "now" })], "2026-10-13");
  assert.deepEqual(ids, ["late1", "late2", "n1", "n3"]);
  assert.equal(isOverdue("2026-10-12", "2026-10-13"), true); assert.equal(isOverdue("2026-10-13", "2026-10-13"), false); assert.equal(isOverdue(null), false);
  assert.match(dueLine("2026-10-12", "2026-10-13")!, /^was due /); assert.match(dueLine("2026-10-15", "2026-10-13")!, /^due /); assert.equal(dueLine(null), null);
});
check("note ids: uni:<ULID> and a bare ULID are picked out of text; words and short ids are not", () => {
  const id = "01M3ZK2R6A6C62M1ANJCSQNG3M";
  assert.deepEqual(splitRefs(`See uni:${id} and ${id}.`), [{ text: "See " }, { id }, { text: " and " }, { id }, { text: "." }]);
  assert.deepEqual(splitRefs("Reply to T-12 about COHERENCEISNOTAULIDATALLXX"), [{ text: "Reply to T-12 about COHERENCEISNOTAULIDATALLXX" }]);
  assert.equal(titleOfPath("Projects/Atlas/Follow-up notes"), "Follow-up notes"); assert.equal(titleOfPath(undefined), null);
});
check("chat cache: the newest 60 per room, per identity; rooms list; old rooms fall out", () => {
  const mem = new Map<string, string>();
  const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  assert.equal(readWho(st), null); writeWho(st, "pk1"); assert.equal(readWho(st), "pk1");
  const rows = Array.from({ length: 80 }, (_, i) => ({ ref: `r${i}`, ts: i }));
  writeMessages(st, "pk1", "ch", rows);
  const got = readMessages<{ ref: string; ts: number }>(st, "pk1", "ch")!;
  assert.equal(got.length, 60); assert.equal(got[0].ts, 20); assert.equal(got[59].ts, 79);
  assert.equal(readMessages(st, "pk2", "ch"), null, "another identity sees nothing"); assert.equal(readMessages(st, null, "ch"), null);
  writeRooms(st, "pk1", [{ id: "ch" }]); assert.deepEqual(readRooms(st, "pk1"), [{ id: "ch" }]); assert.deepEqual(readRooms(st, "pk2"), []);
  const big = Array.from({ length: 60 }, (_, i) => ({ ts: i, body: "x".repeat(5000) }));
  writeMessages(st, "pk1", "big", big); const bigGot = readMessages<{ ts: number }>(st, "pk1", "big")!; assert.ok(JSON.stringify(bigGot).length <= 90_000 && bigGot.at(-1)!.ts === 59, "a room's entry is size-capped, newest kept");
  for (let i = 0; i < 30; i++) writeMessages(st, "pk1", `c${i}`, [{ ts: 1 }]);
  assert.equal(readMessages(st, "pk1", "ch"), null, "the least recent room was dropped"); assert.ok(readMessages(st, "pk1", "c29"));
  writeMessages(st, "pk1", "c29", []); assert.equal(readMessages(st, "pk1", "c29"), null);
});
check("ask: a cut title shows the first line of the note's content in full, without the label or the converted line", () => {
  assert.equal(isCutTitle("Uni adds Benya's missing feature 4, the…"), true);
  assert.equal(isCutTitle("Name the payer entity"), false);
  const content = `_Converted from a task on 2026-10-01_\n\nDecision (default yes): Uni adds Benya's missing feature #4, the after-event "were you there? one takeaway" prompt, to the companion on Wed. Say no to skip it.\n\nMore detail below.`;
  assert.equal(askFromContent(content), `Uni adds Benya's missing feature #4, the after-event "were you there? one takeaway" prompt, to the companion on Wed. Say no to skip it.`);
  assert.equal(askFromContent(""), "");
  assert.equal(askFromContent("_Converted from x_"), "");
  const long = "First sentence here. " + "Second sentence that goes on and on. ".repeat(12);
  assert.ok(askFromContent(long).endsWith("here.") || askFromContent(long).length <= 280);
});
check("recent: never the current place, and a name is listed once", () => {
  let h: History = EMPTY_HISTORY;
  h = visit(h, { kind: "room", channel: "uni-ch", title: "Uni" });
  h = visit(h, { kind: "areas", title: "Uni" });
  h = visit(h, { kind: "area", path: "A", title: "Atlas" });
  h = visit(h, { kind: "areas", title: "Uni" });
  assert.deepEqual(recent(h).map((t) => t.title), ["Atlas"]);
});
check("runs: only the ones still going are running", () => {
  assert.equal(isActiveRun({ state: "running" }), true);
  assert.equal(isActiveRun({ state: "blocked" }), true);
  assert.equal(isActiveRun({ state: "decision" }), true);
  assert.equal(isActiveRun({ state: "done" }), false);
  assert.equal(isActiveRun({ state: "failed" }), false);
});
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
