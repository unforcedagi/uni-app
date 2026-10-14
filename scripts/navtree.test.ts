// T-124 r7: the sidebar's fold state and width, Back/Forward history, the tab-set migration, link text and the needs-you feed.
// Run: node --experimental-strip-types scripts/navtree.test.ts
import assert from "node:assert/strict";
import { ancestorsOf, clampWidth, hasKids, isOpen, parseFolds, parseSidebar, recentLabels, rolledNeeds, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, visibleRows } from "../src/areas/sidebarState.ts";
import { canBack, canForward, EMPTY_HISTORY, placeKey, recent, step, visit, type History } from "../src/navHistory.ts";
import { EMPTY_TABS, isSurface, migrateLegacyTabs, persistable, restoreTabs, serializeTabs, type Tabs, type TabTarget } from "../src/tabs.ts";
import { linkLabel, splitLinks } from "../src/areas/linkText.ts";
import { createVaultTasks } from "../src/areas/vaultTasks.ts";
import { actionableTitle, askFromContent, askLead, askPreview, decisionQuestion, fitsRow, ROW_ASK_MAX, askOrder, dueLine, isCutTitle, isOverdue, lineBudget, needsByNode, needsByRow, needsFeed, needsYou, privateLabel, actionLead, sayText, rowAsk, stateLine, topNeeds, uniNeeds, uniPanel, withoutCut } from "../src/areas/simpleCore.ts";
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
check("r12 dots and the companion share one rule: Now, Soon and decisions of Aaron's, never Someday; a node's dot is its own", () => {
  const list = [mk("soon1", { priority: "soon" }), mk("some1", { priority: "someday" }), mk("room1", { owner: "room:atlas", priority: "now" }),
    mk("dec1", { priority: "someday", options: ["a"] }, ["decision"]), mk("done1", { state: "done", priority: "now" }), mk("up1", { node: "Areas/Atlas", priority: "someday" })];
  assert.deepEqual(list.filter(needsYou).map((t) => t.id), ["soon1", "dec1"]);
  assert.deepEqual([...needsByNode(list)], [["Projects/ATLAS", 2]], "Someday lights nothing; a parent never lights for a child");
  assert.deepEqual(feed(list).sort(), list.filter(needsYou).map((t) => t.id).sort(), "the companion lists exactly what the dots count");
});
check("r12 Uni's own panel: Uni's own items, then at most three from the areas; the rest is in All of Uni's work", () => {
  const own = (id: string) => ({ ...mk(id, { priority: "now" }), node: "" });
  const area = (id: string) => mk(id, { priority: "now" });
  const out = uniNeeds([area("a1"), own("u1"), area("a2"), area("a3"), area("a4"), own("u2"), area("a5")]);
  assert.deepEqual(out.map((t) => t.id), ["u1", "u2", "a1", "a2", "a3"]);
  assert.deepEqual(uniNeeds([area("a1")]).map((t) => t.id), ["a1"]);
});
check("r13 one feed, one count: private items are counted and named by place only; the total is every surface's number", () => {
  const list = [mk("n1", { priority: "now" }), mk("s1", { priority: "someday" }), { ...mk("p1", { priority: "now" }), node: "Areas/Sadhana" }, { ...mk("p2", { priority: "soon" }), node: "Areas/Sadhana/Sit" },
    mk("dec1", { options: ["a"] }, ["decision"]), mk("room1", { owner: "room:atlas", priority: "now" })];
  const priv = (n: string) => (n.startsWith("Areas/Sadhana") ? { path: "Areas/Sadhana", name: "Sadhana" } : null);
  const f = needsFeed(list, priv);
  assert.deepEqual(f.rows.map((t) => t.id), ["n1", "dec1"]);
  assert.deepEqual(f.privates, [{ key: "Areas/Sadhana", count: 2, place: "Sadhana", open: { path: "Areas/Sadhana" } }]);
  assert.equal(f.total, 4, "two named, two private; never Someday or someone else's");
  assert.equal(f.total, list.filter(needsYou).length);
  assert.equal(privateLabel(f.privates[0]), "Sadhana: 2 for you");
  // r14: inside the private area Aaron opened, its items are ordinary rows (titles, actions, the sheet); another private area stays one line
  const other = { ...mk("q1", { priority: "now" }), node: "Areas/Health" };
  const priv2 = (n: string) => priv(n) ?? (n.startsWith("Areas/Health") ? { path: "Areas/Health", name: "Health" } : null);
  const self = needsFeed([...list.filter((t) => t.node.startsWith("Areas/Sadhana")), other], priv2, { path: "Areas/Sadhana", name: "Sadhana" });
  assert.deepEqual(self.rows.map((t) => t.id), ["p1", "p2"]);
  assert.deepEqual(self.privates, [{ key: "Areas/Health", count: 1, place: "Health", open: { path: "Areas/Health" } }]);
  assert.equal(self.total, 3);
});
check("r13 Uni's panel says how many wait in the areas, and the numbers add up", () => {
  const own = (id: string) => ({ ...mk(id, { priority: "now" }), node: "" });
  const f = needsFeed([mk("a1", { priority: "now" }), own("u1"), mk("a2"), mk("a3"), mk("a4"), mk("a5", { priority: "now" })], () => null);
  const p = uniPanel(f);
  assert.deepEqual(p.rows.map((t) => t.id), ["u1", "a1", "a5", "a2"]);
  assert.equal(p.rest, 2);
  assert.equal(p.rows.length + p.rest + p.privates.reduce((n, x) => n + x.count, 0), f.total);
});
check("r13 dots: an item on a node with no row counts on its nearest ancestor's row, else Uni's; the dots add up to the feed", () => {
  const list = [mk("a"), { ...mk("b"), node: "Projects/ATLAS/Sub" }, { ...mk("c"), node: "Nowhere/At/All" }, mk("s", { priority: "someday" })];
  const parent = (p: string) => (p === "Projects/ATLAS/Sub" ? "Projects/ATLAS" : p === "Projects/ATLAS" ? "Areas/Atlas" : undefined);
  const m = needsByRow(list, new Set(["", "Areas/Atlas", "Projects/ATLAS"]), parent);
  assert.deepEqual([...m].sort(), [["", 1], ["Projects/ATLAS", 2]]);
  assert.equal([...m.values()].reduce((a, b) => a + b, 0), list.filter(needsYou).length);
});
check("r13 the sheet's lead: a next step that names an action leads; a status does not; a Say step fills the composer", () => {
  assert.equal(actionLead("Say go to deploy #38 + #58 by Oct 14"), "Say go to deploy #38 + #58 by Oct 14");
  assert.equal(actionLead("send to Kevin for the numbers"), "Send to Kevin for the numbers");
  assert.equal(actionLead("Waiting on Kevin"), null);
  assert.equal(actionLead("Check-in PR by Oct 12"), null, "a noun phrase is not an action");
  assert.equal(actionLead(""), null);
  assert.equal(sayText("Say go to deploy #38 + #58"), "go to deploy #38 + #58");
  assert.equal(sayText("Reply: thanks, Thursday works"), "thanks, Thursday works");
  assert.equal(sayText("Send to Kevin"), null, "only say/reply/tell/answer fill a composer");
});
check("needs-you feed: done and archived never appear; Now before Soon, then due date (undated last)", () => {
  const ids = feed([mk("d", { state: "done", priority: "now" }), mk("ar", { state: "archived" }), mk("s1", { priority: "soon", due: "2026-10-12" }), mk("n2", { priority: "now", due: "2026-10-20" }), mk("n1", { priority: "now", due: "2026-10-15" }), mk("n3", { priority: "now" })]);
  assert.deepEqual(ids, ["n1", "n2", "n3", "s1"]);
});
check("needs-you feed: an empty feed is empty; a title with words is an action, a bare id is not", () => {
  assert.deepEqual(feed([]), []);
  assert.equal(actionableTitle("Confirm scope with Kevin"), true); assert.equal(actionableTitle("Kevin call"), true); assert.equal(actionableTitle("Taxes"), false); assert.equal(actionableTitle(""), false);
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
  // r13: an option is never the question: a note that starts with its options has no whole question here
  assert.equal(askFromContent("- Add key and test live on preview first\n- Ship to production after live test\n- Change it first"), "");
  assert.equal(askFromContent("1. Wait\n2. Go"), "");
  assert.equal(askFromContent("- Option A\n\nShould the gateway move on Wednesday?"), "Should the gateway move on Wednesday?");
  assert.equal(askFromContent("_Converted from x_"), "");
  // r14: the question is the whole first paragraph, never a 280-character trim; the trim is a preview, always marked "…"
  const long = "First sentence here. " + "Second sentence that goes on and on. ".repeat(12);
  assert.equal(askFromContent(long), long.trim());
  assert.equal(askFromContent("Should we move the gateway\non Wednesday, after the backup?\n\nContext below."), "Should we move the gateway on Wednesday, after the backup?");
  const pv = askPreview(long);
  assert.ok(pv.endsWith("…") && pv.length <= 162 && pv.startsWith("First sentence here."), pv);
  assert.equal(askPreview("Short and whole."), "Short and whole.");
  assert.ok(askPreview("x".repeat(400)).endsWith("…"));
});
check("r14 decisionQuestion: the title when whole; a cut title's ask only at the row's own revision; else none", () => {
  assert.equal(decisionQuestion("Decision (default yes): Ship it?", undefined, undefined, "r1"), "Ship it?");
  assert.equal(decisionQuestion("Send a daily calendar email to…", "Send a daily calendar email to people who registered?", "r1", "r1"), "Send a daily calendar email to people who registered?");
  assert.equal(decisionQuestion("Send a daily calendar email to…", "Send a daily calendar email to people who registered?", "r1", "r2"), null, "an ask read at another revision is not this row's");
  assert.equal(decisionQuestion("Send a daily calendar email to…", "Send it?", null, null), null, "no revision, no question");
  assert.equal(decisionQuestion("Send a daily calendar email to…", undefined, undefined, "r1"), null);
  assert.equal(decisionQuestion("Send a daily calendar email to…", "Send a daily calendar email to…", "r1", "r1"), null, "a note that repeats the cut title has no whole question");
  assert.equal(fitsRow("x".repeat(ROW_ASK_MAX)), true); assert.equal(fitsRow("x".repeat(ROW_ASK_MAX + 1)), false);
});
check("r12 rowAsk: a cut title never keeps buttons beside a fragment; with no whole question anywhere, 'Open to see the question' and no fragment", () => {
  assert.deepEqual(rowAsk("Name the payer entity", undefined, true, false), { text: "Name the payer entity", openToDecide: false });
  assert.deepEqual(rowAsk("a daily calendar email to people who…", "a daily calendar email to people who registered. It goes to real attendees.", true, false), { text: "a daily calendar email to people who registered. It goes to real attendees.", openToDecide: false });
  assert.deepEqual(rowAsk("a daily calendar email to people who…", undefined, true, false), { text: "Open to see the question", openToDecide: true });
  assert.deepEqual(rowAsk("a daily calendar email to people who…", "still cut too…", true, true), { text: "Open to see the question", openToDecide: true });
  assert.deepEqual(rowAsk("Riverside: cure window…", undefined, false, true), { text: "Riverside: cure window", openToDecide: false });
  assert.deepEqual(rowAsk("Riverside: cure window…", undefined, false, false), { text: "", openToDecide: false });
  assert.equal(withoutCut("a b..."), "a b");
});
check("r11 askLead: sentence case, and \"Your call:\" unless it already asks", () => {
  assert.deepEqual(askLead("a daily calendar email to people who registered."), { text: "A daily calendar email to people who registered.", yourCall: true });
  assert.deepEqual(askLead("Should Uni send it?"), { text: "Should Uni send it?", yourCall: false });
  assert.deepEqual(askLead("Send it (yes?)"), { text: "Send it (yes?)", yourCall: false });
});
check("r11 task titles: the vault's fraction slash reads as a plain slash", () => {
  const t = parseTask({ id: "a", path: "Tasks/T-9 Riverside cure\u2215purchase", tags: ["task"], metadata: { state: "open", node: "" } } as never, buildTaskTree([]) as never);
  assert.equal(t?.title, "T-9 Riverside cure/purchase");
});
await (async () => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  const task = { id: "d1", kind: "decision", title: "T-1 Decision: send a daily calendar email to…", priority: "now", due: null, updatedAt: "2026-10-12T10:00:00Z", owner: "aaron", waitingOn: null } as unknown as Task;
  let reads = 0;
  let rev = "2026-10-12T10:00:00Z";
  const call = async () => { reads++; return { note: { content: "Send a daily calendar email to people who registered?", updatedAt: rev } }; };
  const first = createVaultTasks(call, "uni"); first.setAskOwner("me|uni");
  assert.deepEqual((await first.loadAsks([task])).get("d1"), { ask: "Send a daily calendar email to people who registered?", at: "2026-10-12T10:00:00Z" });
  // the next launch (a fresh instance, same identity) paints the ask without a read; another identity does not see it
  const next = createVaultTasks(call, "uni"); next.setAskOwner("me|uni");
  assert.deepEqual((await next.loadAsks([task])).get("d1"), { ask: "Send a daily calendar email to people who registered?", at: "2026-10-12T10:00:00Z" }); assert.equal(reads, 1);
  next.setAskOwner("you|uni"); await next.loadAsks([task]); assert.equal(reads, 2);
  // an edited note (new updatedAt) is read again
  const again = createVaultTasks(call, "uni"); again.setAskOwner("you|uni"); await again.loadAsks([{ ...task, updatedAt: "2026-10-13T10:00:00Z" }]); assert.equal(reads, 3);
  // r14: the ask carries the revision the note was read at, not the row's: a note newer than the list is not the row's question
  rev = "2026-10-14T10:00:00Z";
  const newer = createVaultTasks(call, "uni"); newer.setAskOwner("they|uni");
  assert.equal((await newer.loadAsks([task])).get("d1")?.at, "2026-10-14T10:00:00Z");
  console.log("ok   r11 asks: kept on the device per identity, re-read when the note changed");
})();
check("r10 stateLine: one plain line, never the state and who it waits on", () => {
  const me = (w: string | null) => w === "aaron";
  assert.equal(stateLine({ kind: "task", state: "waiting", waitingOn: "aaron" }, me), "Waiting on you");
  assert.equal(stateLine({ kind: "task", state: "waiting", waitingOn: "miranda" }, me), "Waiting on miranda");
  assert.equal(stateLine({ kind: "task", state: "doing", waitingOn: null }, me), "In progress");
  assert.equal(stateLine({ kind: "decision", state: "open", waitingOn: null }, me), "Needs your decision");
  assert.ok(!/waiting, waiting/i.test(stateLine({ kind: "task", state: "waiting", waitingOn: "aaron" }, me)));
});
check("r10 askOrder and lineBudget", () => {
  const t = (title: string, kind = "task", priority: string | null = null, due: string | null = null) => ({ title, kind, priority, due });
  assert.deepEqual(askOrder([t("b"), t("a", "task", "now"), t("c", "decision")]).map((x) => x.title), ["c", "a", "b"]);
  assert.equal(lineBudget(2, false).next, 1); assert.equal(lineBudget(2, true).next, 0); assert.equal(lineBudget(1, true).next, 1); assert.equal(lineBudget(3, false).next, 0);
});
check("r12 recent: never the current place, a place once, told apart by its id, never by its name", () => {
  // Uni's room, opened before the tree loaded, is Uni: the app's key maps a room a node owns to that node
  const uniKey = (t: TabTarget) => (t.kind === "room" && t.channel === "uni-ch" ? "uni" : placeKey(t));
  let h: History = EMPTY_HISTORY;
  h = visit(h, { kind: "room", channel: "uni-ch", title: "Uni" });
  h = visit(h, { kind: "areas", title: "Uni" });
  h = visit(h, { kind: "area", path: "A", title: "Atlas" });
  h = visit(h, { kind: "areas", title: "Uni" });
  assert.deepEqual(recent(h, 5, uniKey).map((t) => t.title), ["Atlas"]);
  // two projects with one name are two places
  h = visit(h, { kind: "area", path: "Areas/Atlas/Projects/Site", title: "Site" });
  h = visit(h, { kind: "area", path: "Areas/Techne/Projects/Site", title: "Site" });
  h = visit(h, { kind: "areas", title: "Uni" });
  assert.deepEqual(recent(h, 5, uniKey).map((t) => t.path), ["Areas/Techne/Projects/Site", "Areas/Atlas/Projects/Site", "A"]);
  assert.equal(placeKey({ kind: "thread", channel: "c", root: "r", title: "t" }), "thread:c:r");
});
check("r12 recent labels: a name two places share says where each sits; at most the given number", () => {
  const rows = [{ path: "", name: "Uni", depth: 0 }, { path: "A", name: "Atlas", depth: 1 }, { path: "A/S", name: "Site", depth: 2 }, { path: "T", name: "Techne", depth: 1 }, { path: "T/S", name: "Site", depth: 2 }, { path: "T/K", name: "Kit", depth: 2 }];
  const r = (key: string, title: string, path: string | null = null, room: string | null = null) => ({ key, title, path, room, go: () => {} });
  const list = [r("area:A/S", "Site", "A/S"), r("area:T/K", "Kit", "T/K"), r("area:T/S", "Site", "T/S"), r("room:g", "garden", null, "g")];
  assert.deepEqual(recentLabels(list, rows, null, 5).map((x) => x.label), ["Site · Atlas", "Kit", "Site · Techne", "garden"]);
  assert.deepEqual(recentLabels(list, rows, "garden", 5).map((x) => x.label), ["Site · Atlas", "Kit", "Site · Techne", "garden · Other rooms"]);
  assert.deepEqual(recentLabels(list, rows, null, 3).map((x) => x.label), ["Site · Atlas", "Kit", "Site · Techne"]);
  assert.deepEqual(recentLabels(list.slice(0, 2), rows, null, 3).map((x) => x.label), ["Site", "Kit"], "no collision, no parent");
});
check("runs: only the ones still going are running", () => {
  assert.equal(isActiveRun({ state: "running" }), true);
  assert.equal(isActiveRun({ state: "blocked" }), true);
  assert.equal(isActiveRun({ state: "decision" }), true);
  assert.equal(isActiveRun({ state: "done" }), false);
  assert.equal(isActiveRun({ state: "failed" }), false);
});
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
