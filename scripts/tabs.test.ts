// Run: node --experimental-strip-types scripts/tabs.test.ts
import assert from "node:assert/strict";
import { isUniSide, persistable, readUniPlace, serializeUniPlace, viewOf, activeTab, closeTab, EMPTY_TABS, focusTab, MAX_TABS, navigateNoteTab, nextAfterClose, openTab, recordingTabCanClose, restoreTabs, sameTarget, serializeTabs, updateTab, type TabTarget, type Tabs } from "../src/tabs.ts";
import { claimRecording, recordingHolder, releaseRecording, RecordingBusy } from "../src/recLock.ts";

let n = 0;
const id = () => `t${++n}`;
// T-335 one surface: a room is never a tab; the tab mechanics are a place's (an area's work, in a vault without rooms), a note's, the Journal's.
// `room(x)` is a place named for its room, so the order and cap checks read as before.
const room = (channel: string): TabTarget => ({ kind: "area", path: `Areas/${channel}`, channel, title: channel });
/** All with a room in focus (a thread of it with `root`). */
const all = (channel: string, root?: string): TabTarget => ({ kind: "all", title: "Uni", channel, ...(root ? { root } : {}) });
const note = (ref: string): TabTarget => ({ kind: "note", note: { hub: null, vault: "uni", ref }, title: ref });
const journal: TabTarget = { kind: "journal", title: "Journal" };
const ids = (s: Tabs) => s.tabs.map((t) => t.id);

// Open into an empty set: one tab, active.
let s = openTab(EMPTY_TABS, room("a"), "focus", id);
assert.deepEqual(ids(s), ["t1"]);
assert.equal(s.active, "t1");

// Focus mode with a new target replaces the active tab (fresh id).
s = openTab(s, room("b"), "focus", id);
assert.equal(s.tabs.length, 1);
assert.equal(activeTab(s)?.channel, "b");
assert.equal(s.active, "t2");

// New mode opens after the active tab.
s = openTab(s, room("c"), "new", id);
assert.deepEqual(s.tabs.map((t) => t.channel), ["b", "c"]);
assert.equal(activeTab(s)?.channel, "c");
s = focusTab(s, s.tabs[0].id);
s = openTab(s, note("Projects/X"), "new", id);
assert.deepEqual(s.tabs.map((t) => t.kind === "note" ? "note" : t.channel), ["b", "note", "c"]);

// Focus mode on an already-open target focuses it; no duplicate.
const before = s.tabs.length;
s = openTab(s, room("c"), "focus", id);
assert.equal(s.tabs.length, before);
assert.equal(activeTab(s)?.channel, "c");
// New mode also focuses an identical open tab (one tab per target).
s = openTab(s, note("Projects/X"), "new", id);
assert.equal(s.tabs.length, before);
assert.equal(activeTab(s)?.kind, "note");

// Replace navigates in place; a place that already has a tab is opened there instead (r13: no tab strip, so a
// second tab for one place is never wanted, and a restore folds it away).
s = focusTab(s, s.tabs[0].id);
const pos = s.tabs.findIndex((t) => t.id === s.active);
s = openTab(s, journal, "replace", id);
assert.equal(s.tabs[pos].kind, "journal");
assert.equal(s.tabs[pos].id, s.active);
s = openTab(s, room("c"), "replace", id);
assert.equal(s.tabs.filter((t) => t.channel === "c").length, 1);
assert.equal(activeTab(s)?.channel, "c");

// sameTarget.
assert.ok(sameTarget(journal, { kind: "journal", title: "x" }));
// one All, whichever room is in focus there
assert.ok(sameTarget(all("a"), all("b", "r")));
assert.ok(!sameTarget(room("a"), room("b")));
assert.ok(!sameTarget(note("A"), note("B")));

// Close: the most recently used other tab takes over.
let c = openTab(EMPTY_TABS, room("a"), "focus", id);
c = openTab(c, room("b"), "new", id);
c = openTab(c, room("c"), "new", id);
const [ta, tb, tc] = ids(c);
c = focusTab(c, ta);
c = focusTab(c, tc);
assert.equal(nextAfterClose(c, tc)?.id, ta);
c = closeTab(c, tc);
assert.deepEqual(ids(c), [ta, tb]);
assert.equal(c.active, ta);
// Closing an inactive tab keeps the active one.
c = closeTab(c, tb);
assert.equal(c.active, ta);
// Closing the last tab leaves nothing active.
c = closeTab(c, ta);
assert.deepEqual(c, { tabs: [], active: null, recent: [] });
// Closing an unknown id is a no-op.
assert.equal(closeTab(c, "nope"), c);

// Cap: the 13th tab closes the least recently used inactive tab.
let k = openTab(EMPTY_TABS, room("r0"), "focus", id);
for (let i = 1; i < MAX_TABS; i++) k = openTab(k, room(`r${i}`), "new", id);
assert.equal(k.tabs.length, MAX_TABS);
k = focusTab(k, k.tabs[0].id); // r0 is now recent; r1 is the oldest
k = openTab(k, room("r12"), "new", id);
assert.equal(k.tabs.length, MAX_TABS);
assert.ok(!k.tabs.some((t) => t.channel === "r1"));
assert.ok(k.tabs.some((t) => t.channel === "r0"));
assert.equal(activeTab(k)?.channel, "r12");

// updateTab: title change keeps identity; no-op returns the same object.
const u = updateTab(k, k.active!, { title: "Renamed" });
assert.equal(activeTab(u)?.title, "Renamed");
assert.equal(u.active, k.active);
assert.equal(updateTab(u, u.active!, { title: "Renamed" }), u);

// Nested navigation persists the visible note; Back restores its predecessor.
let nested = openTab(EMPTY_TABS, note("A"), "new", id);
const nestedId = nested.active!;
nested = navigateNoteTab(nested, nestedId, note("B").note!, "B title");
assert.equal(activeTab(restoreTabs(serializeTabs(nested), []))?.note?.ref, "B");
assert.equal(activeTab(nested)?.title, "B title");
nested = navigateNoteTab(nested, nestedId, note("A").note!, "A title");
assert.equal(activeTab(restoreTabs(serializeTabs(nested), []))?.note?.ref, "A");


// Persist and restore round trip: All keeps the room in focus (and its thread).
let p = openTab(EMPTY_TABS, { kind: "areas", title: "Uni" }, "focus", id);
p = openTab(p, all("a", "root1"), "new", id);
p = openTab(p, note("Projects/uni-app/Tabs"), "new", id);
p = openTab(p, journal, "new", id);
p = focusTab(p, p.tabs[1].id);
const raw = serializeTabs(p);
const r = restoreTabs(raw, ["a", "b"]);
assert.deepEqual(r.tabs, p.tabs);
assert.equal(r.active, p.active);
assert.deepEqual(activeTab(r), { ...p.tabs[1] }, "All comes back with its room and thread");

// A room that no longer exists leaves focus (silently): All is All again; the rest is kept.
const gone = restoreTabs(raw, ["b"]);
assert.deepEqual(gone.tabs.map((t) => t.kind), ["areas", "all", "note", "journal"]);
assert.deepEqual(activeTab(gone), { id: p.tabs[1].id, kind: "all", title: "Uni" });
// what is saved: All only with a room in focus; never a note
assert.deepEqual(persistable(p).tabs.map((t) => t.kind), ["areas", "all", "journal"]);
assert.deepEqual(persistable(gone).tabs.map((t) => t.kind), ["areas", "journal"]);

// T-335 one surface: a room or a thread saved by an older version (a tab of its own) is that room in focus over All
{
  const old = restoreTabs(JSON.stringify({ v: 1, tabs: [{ id: "o1", kind: "room", channel: "a", title: "a" }], active: "o1", recent: ["o1"] }), ["a"]);
  assert.deepEqual(activeTab(old), { id: "o1", kind: "all", title: "Uni", channel: "a" });
  const oldThread = restoreTabs(JSON.stringify({ v: 1, tabs: [{ id: "o2", kind: "thread", channel: "a", root: "r9", title: "Thread" }], active: "o2" }), ["a"]);
  assert.deepEqual(activeTab(oldThread), { id: "o2", kind: "all", title: "Uni", channel: "a", root: "r9" });
  // two saved rooms (the old tab strip): one All, with the room that was active in focus
  const two = restoreTabs(JSON.stringify({ v: 1, tabs: [{ id: "r1", kind: "room", channel: "a", title: "a" }, { id: "r2", kind: "room", channel: "b", title: "b" }], active: "r2", recent: ["r1", "r2"] }), ["a", "b"]);
  assert.deepEqual(two.tabs.map((t) => [t.kind, t.channel]), [["all", "b"]]);
  assert.equal(activeTab(two)?.channel, "b");
  // several old rooms, none of them active (Uni was): All keeps none of them in focus
  const none = restoreTabs(JSON.stringify({ v: 1, tabs: [{ id: "r1", kind: "room", channel: "a", title: "a" }, { id: "r2", kind: "room", channel: "b", title: "b" }, { id: "u", kind: "areas", title: "Uni" }], active: "u", recent: ["r1", "r2", "u"] }), ["a", "b"]);
  assert.deepEqual(none.tabs.map((t) => [t.kind, t.channel]), [["all", undefined], ["areas", undefined]]);
  // a room gone since: All alone
  assert.deepEqual(activeTab(restoreTabs(JSON.stringify({ v: 1, tabs: [{ id: "o3", kind: "room", channel: "gone", title: "x" }], active: "o3" }), ["a"])), { id: "o3", kind: "all", title: "Uni" });
  // All's place for a room it borrows is a note path, checked like an area's
  assert.equal(activeTab(restoreTabs(JSON.stringify({ v: 1, tabs: [{ id: "o4", kind: "all", channel: "a", path: "Areas/Still Water" }], active: "o4" }), ["a"]))?.path, "Areas/Still Water");
  assert.equal(activeTab(restoreTabs(JSON.stringify({ v: 1, tabs: [{ id: "o5", kind: "all", channel: "a", path: "../x" }], active: "o5" }), ["a"]))?.path, undefined);
}

// Garbage in: empty state, never a throw.
assert.deepEqual(restoreTabs(null, []), EMPTY_TABS);
assert.deepEqual(restoreTabs("{not json", []), EMPTY_TABS);
assert.deepEqual(restoreTabs(JSON.stringify({ tabs: "x" }), []), EMPTY_TABS);
const junk = restoreTabs(JSON.stringify({ tabs: [{ id: "x", kind: "room" }, { id: "y", kind: "weird", channel: "a" }, { id: "z", kind: "area", channel: "a" }, null, { id: "j", kind: "journal" }, { id: "j2", kind: "journal" }], active: "nope" }), ["a"]);
assert.deepEqual(junk.tabs, [{ id: "j", kind: "journal", title: "Journal" }]);
assert.equal(junk.active, "j");
// Over-cap saved state is trimmed on restore.
const many = { tabs: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, kind: "area", path: `Areas/c${i}`, channel: `c${i}`, title: "" })), active: "m19" };
const trimmed = restoreTabs(JSON.stringify(many), many.tabs.map((t) => t.channel));
assert.equal(trimmed.tabs.length, MAX_TABS);
assert.equal(trimmed.active, "m19");

// A pending mic permission or an onstop callback protects the origin too.
assert.equal(recordingTabCanClose("origin", "origin"), false);
assert.equal(recordingTabCanClose("other", "origin"), true);
assert.equal(recordingTabCanClose("origin", null), true);

// One recording at a time.
const composer = {}, journalRec = {};
claimRecording(composer, "for #general");
claimRecording(composer, "for #general"); // same holder: fine
assert.throws(() => claimRecording(journalRec, "in the Journal"), (e: unknown) => e instanceof RecordingBusy && /Already recording for #general/.test((e as Error).message));
assert.equal(recordingHolder(), "for #general");
releaseRecording(journalRec); // not the holder: ignored
assert.equal(recordingHolder(), "for #general");
releaseRecording(composer);
claimRecording(journalRec, "in the Journal");
assert.equal(recordingHolder(), "in the Journal");
releaseRecording(journalRec);
assert.equal(recordingHolder(), null);



const vaultTab: TabTarget = { kind: "vault", vault: "scope-test", title: "Scope" };
assert.ok(sameTarget(vaultTab, { ...vaultTab, title: "Renamed" }));
assert.ok(!sameTarget(vaultTab, { ...vaultTab, vault: "other" }));
assert.ok(!sameTarget(vaultTab, note("scope-test")));
let v = openTab(EMPTY_TABS, vaultTab, "new", id);
v = openTab(v, vaultTab, "new", id);
assert.equal(v.tabs.length, 1);
assert.deepEqual(restoreTabs(serializeTabs(v), []).tabs, v.tabs);
assert.equal(restoreTabs(JSON.stringify({ tabs: [{ id: "bad", kind: "vault" }] }), []).tabs.length, 0);


const recoverTab = openTab(EMPTY_TABS, { kind: "note", title: "Title", note: { hub: null, vault: "unforced", ref: "Notes/Title prose", recover: true } }, "new", () => "recover");
assert.equal(activeTab(restoreTabs(serializeTabs(recoverTab), []))?.note?.recover, true);
const resolvedTab = updateTab(recoverTab, "recover", { note: { hub: null, vault: "unforced", ref: "01M3ZK2R6A6C62M1ANJCSQNG3M" } });
assert.equal(activeTab(restoreTabs(serializeTabs(resolvedTab), []))?.note?.ref, "01M3ZK2R6A6C62M1ANJCSQNG3M");

// T-80b: Uni's home is the areas tab (with its room); a project under an area is an area tab with a deeper path.
{
  const raw = JSON.stringify({ v: 1, tabs: [
    { id: "home", kind: "areas", title: "Areas", channel: "room-uni" },
    { id: "proj", kind: "area", path: "Projects/COhere/COhere 2026", title: "COhere 2026", channel: "room-cohere" },
    { id: "bad1", kind: "area", path: "../etc/passwd", title: "x" },
    { id: "bad2", kind: "area", path: "/Areas/X", title: "x" },
    { id: "bad3", kind: "area", path: "", title: "x" },
  ], active: "proj", recent: ["home", "proj"] });
  const restored = restoreTabs(raw, ["room-uni", "room-cohere"]);
  assert.deepEqual(restored.tabs.map((t) => t.id), ["home", "proj"]);
  assert.equal(restored.tabs[0].title, "Uni", "old saved tabs titled Areas now say Uni");
  assert.equal(restored.tabs[0].channel, undefined, "T-335: Uni's own level with its room is gone: Uni is its home");
  assert.equal(restored.tabs[1].path, "Projects/COhere/COhere 2026");
  assert.equal(restoreTabs(raw, []).tabs[0].channel, undefined, "a room that is gone is dropped, the tab stays");
  assert.equal(restoreTabs(raw, []).tabs.length, 2);
}

// r13: Journal → Uni → a place that already has a tab: that tab is used, never a second one; and a saved twin restores as its kept tab
{
  const area = (path: string): TabTarget => ({ kind: "area", path, title: path });
  const uni: TabTarget = { kind: "areas", title: "Uni" };
  let t = openTab(EMPTY_TABS, area("Projects/COhere"), "focus", id);
  const cohere = t.active!;
  t = openTab(t, journal, "new", id);
  const jid = t.active!;
  t = openTab(t, uni, "new", id); // the Journal's Back to Uni opens beside it
  t = openTab(t, area("Projects/COhere"), "replace", id); // a row of the tree, from Uni's tab
  assert.equal(t.tabs.filter((x) => x.kind === "area" && x.path === "Projects/COhere").length, 1, "one tab per place");
  assert.equal(t.active, cohere, "the place's own tab is the one shown");
  assert.equal(restoreTabs(serializeTabs(t), []).active, cohere, "and it survives the next restore");
  assert.ok(t.tabs.some((x) => x.id === jid), "the Journal keeps its tab");
  // a saved set with two tabs for one place (older builds): the active twin restores as the kept one, never as the Journal
  const raw = JSON.stringify({ v: 1, tabs: [{ id: "a1", kind: "area", path: "P", title: "P" }, { id: "j", kind: "journal", title: "Journal" }, { id: "a2", kind: "area", path: "P", title: "P" }], active: "a2", recent: ["a1", "j", "a2"] });
  assert.equal(restoreTabs(raw, []).active, "a1");
}

// T-294: Uni's side's last place, as kept on the device. It comes back with its spot when the place still exists.
{
  const area: TabTarget = { kind: "area", path: "Projects/Lantern", title: "Lantern", channel: "ch-lantern" };
  const spot = { view: "ch-lantern|null", ref: "m12", offset: -14, limit: 300 };
  assert.deepEqual(readUniPlace(serializeUniPlace({ ...area, id: "t9" } as never, spot), ["ch-lantern"]), { target: area, spot });
  // a thread's spot is the thread's view (All with the thread in focus)
  const th = all("ch-lantern", "r1");
  assert.equal(viewOf(th), "ch-lantern|r1");
  assert.deepEqual(readUniPlace(serializeUniPlace(th, { ...spot, view: "ch-lantern|r1" }), ["ch-lantern"])?.spot?.view, "ch-lantern|r1");
  // a spot from another conversation is not this place's: it is never written, and never read back
  assert.equal(readUniPlace(serializeUniPlace(area, { ...spot, view: "ch-other|null" }), ["ch-lantern"])?.spot, null);
  assert.equal(readUniPlace(JSON.stringify({ v: 1, target: area, spot: { ...spot, view: "ch-other|null" } }), ["ch-lantern"])?.spot, null);
  // a room that has gone: All keeps its place without the room (and so without a spot), as an area does
  assert.deepEqual(readUniPlace(serializeUniPlace(all("ch-gone"), { ...spot, view: "ch-gone|null" }), ["ch-lantern"]), { target: { kind: "all", title: "Uni" }, spot: null });
  assert.deepEqual(readUniPlace(serializeUniPlace(area, spot), []), { target: { kind: "area", path: "Projects/Lantern", title: "Lantern" }, spot: null });
  // only Uni's side is a place to go back to; anything malformed is nothing
  assert.equal(readUniPlace(JSON.stringify({ v: 1, target: { kind: "messages", title: "Messages" }, spot: null }), []), null);
  assert.equal(readUniPlace(JSON.stringify({ v: 1, target: journal, spot: null }), []), null);
  for (const raw of [null, "", "{", "[]", "null", JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, target: "Uni" })]) assert.equal(readUniPlace(raw, ["ch-lantern"]), null);
  for (const bad of [{ ...spot, ref: "" }, { ...spot, offset: "4" }, { ...spot, offset: null }, { ...spot, limit: 0 }, { ...spot, limit: 2.5 }, { ...spot, ref: "x".repeat(201) }])
    assert.equal(readUniPlace(JSON.stringify({ v: 1, target: area, spot: bad }), ["ch-lantern"])?.spot, null);
  assert.deepEqual(["areas", "area", "all", "journal", "messages", "mail", "calendar", "note", "vault"].filter((kind) => isUniSide({ kind: kind as TabTarget["kind"] })), ["areas", "area", "all"]);
}

console.log("tabs tests passed");
