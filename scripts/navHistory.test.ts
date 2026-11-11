// T-124 r7: Back/Forward history over the places visited, the recent places, and which tabs the app reopens to (src/navHistory.ts,
// src/tabs.ts). Moved from the retired navtree test (T-335). Run: node --experimental-strip-types scripts/navHistory.test.ts
import assert from "node:assert/strict";
import { EMPTY_HISTORY, placeKey, recent, step, visit, type History } from "../src/navHistory.ts";
import { EMPTY_TABS, isSurface, migrateLegacyTabs, persistable, restoreTabs, serializeTabs, type Tabs, type TabTarget } from "../src/tabs.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const room = (c: string, title = c): TabTarget => ({ kind: "area", path: c, channel: c, title });
const uni: TabTarget = { kind: "areas", title: "Uni" };
check("history: visit, back, forward; going somewhere new drops what was ahead", () => {
  let h: History = EMPTY_HISTORY;
  h = visit(h, uni); h = visit(h, room("A")); h = visit(h, room("B"));
  assert.equal(h.entries.length, 3); assert.equal(h.index, 2, "at the newest: Back is possible, Forward is not");
  const back = step(h, -1)!; assert.equal((back.target as { path: string }).path, "A"); h = back.history;
  assert.equal(h.index, 1); assert.equal(h.entries.length, 3, "Forward is possible");
  h = visit(h, room("C"));
  assert.deepEqual(h.entries.map((e) => (e.kind === "area" ? e.path : "uni")), ["uni", "A", "C"]);
  assert.equal(h.index, h.entries.length - 1, "nothing ahead");
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
check("tabs: All is a place you can be, but never what the app reopens to; a re-read of the rooms keeps it", () => {
  const s: Tabs = { tabs: [{ id: "1", kind: "all", title: "All" }], active: "1", recent: ["1"] };
  assert.deepEqual(restoreTabs(serializeTabs(s), []).tabs.map((t) => t.kind), ["all"], "the live rooms' re-read goes through restoreTabs");
  assert.equal(persistable(s).tabs.length, 0);
  assert.equal(persistable(s).active, null);
  const beside: Tabs = { tabs: [{ id: "1", kind: "all", title: "All" }, { id: "2", kind: "journal", title: "Journal" }], active: "1", recent: ["2", "1"] };
  assert.equal(persistable(beside).active, "2");
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

check("r12 recent: never the current place, a place once, told apart by its id, never by its name", () => {
  // T-335 one surface: All is one place, whichever room is in focus there
  const uniKey = placeKey;
  let h: History = EMPTY_HISTORY;
  h = visit(h, { kind: "all", channel: "c1", title: "All" });
  h = visit(h, { kind: "all", channel: "c2", title: "All" });
  assert.equal(h.entries.length, 1, "a room in focus is All's own step, never a second visit");
  h = visit(h, { kind: "areas", title: "Uni" });
  h = visit(h, { kind: "area", path: "A", title: "Atlas" });
  h = visit(h, { kind: "areas", title: "Uni" });
  assert.deepEqual(recent(h, 5, uniKey).map((t) => t.title), ["Atlas", "All"]);
  h = visit(EMPTY_HISTORY, { kind: "areas", title: "Uni" });
  h = visit(h, { kind: "area", path: "A", title: "Atlas" });
  h = visit(h, { kind: "areas", title: "Uni" });
  assert.deepEqual(recent(h, 5, uniKey).map((t) => t.title), ["Atlas"]);
  // two projects with one name are two places
  h = visit(h, { kind: "area", path: "Areas/Atlas/Projects/Site", title: "Site" });
  h = visit(h, { kind: "area", path: "Areas/Techne/Projects/Site", title: "Site" });
  h = visit(h, { kind: "areas", title: "Uni" });
  assert.deepEqual(recent(h, 5, uniKey).map((t) => t.path), ["Areas/Techne/Projects/Site", "Areas/Atlas/Projects/Site", "A"]);
  assert.equal(placeKey({ kind: "all", channel: "c", root: "r", title: "All" }), "all");
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("navHistory: all passed");
