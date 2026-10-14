// Run: node --experimental-strip-types scripts/tabs.test.ts
import assert from "node:assert/strict";
import { isRealRoom, lastRoomOf, restorePlace, activeTab, closeTab, EMPTY_TABS, focusTab, MAX_TABS, navigateNoteTab, nextAfterClose, openTab, recordingTabCanClose, restoreTabs, sameTarget, serializeTabs, updateTab, type TabTarget, type Tabs } from "../src/tabs.ts";
import { claimRecording, recordingHolder, releaseRecording, RecordingBusy } from "../src/recLock.ts";

let n = 0;
const id = () => `t${++n}`;
const room = (channel: string): TabTarget => ({ kind: "room", channel, title: channel });
const thread = (channel: string, root: string): TabTarget => ({ kind: "thread", channel, root, title: `Thread · ${channel}` });
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

// Replace navigates in place (room → thread); a place that already has a tab is opened there instead (r13: no tab strip, so a
// second tab for one place is never wanted, and a restore folds it away).
s = focusTab(s, s.tabs[0].id);
const pos = s.tabs.findIndex((t) => t.id === s.active);
s = openTab(s, thread("b", "r1"), "replace", id);
assert.equal(s.tabs[pos].kind, "thread");
assert.equal(s.tabs[pos].id, s.active);
s = openTab(s, room("c"), "replace", id);
assert.equal(s.tabs.filter((t) => t.channel === "c").length, 1);
assert.equal(activeTab(s)?.channel, "c");

// sameTarget.
assert.ok(sameTarget(journal, { kind: "journal", title: "x" }));
assert.ok(!sameTarget(room("a"), thread("a", "r")));
assert.ok(sameTarget(thread("a", "r"), thread("a", "r")));
assert.ok(!sameTarget(thread("a", "r"), thread("a", "q")));
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


// Persist and restore round trip.
let p = openTab(EMPTY_TABS, room("a"), "focus", id);
p = openTab(p, thread("a", "root1"), "new", id);
p = openTab(p, note("Projects/uni-app/Tabs"), "new", id);
p = openTab(p, journal, "new", id);
p = focusTab(p, p.tabs[1].id);
const raw = serializeTabs(p);
const r = restoreTabs(raw, ["a", "b"]);
assert.deepEqual(r.tabs, p.tabs);
assert.equal(r.active, p.active);

// Restoring drops tabs for rooms that no longer exist (silently), keeps the rest.
const gone = restoreTabs(raw, ["b"]);
assert.deepEqual(gone.tabs.map((t) => t.kind), ["note", "journal"]);
// The active tab was the dropped thread: fall back to the most recent survivor.
assert.equal(activeTab(gone)?.kind, "journal");

// Garbage in: empty state, never a throw.
assert.deepEqual(restoreTabs(null, []), EMPTY_TABS);
assert.deepEqual(restoreTabs("{not json", []), EMPTY_TABS);
assert.deepEqual(restoreTabs(JSON.stringify({ tabs: "x" }), []), EMPTY_TABS);
const junk = restoreTabs(JSON.stringify({ tabs: [{ id: "x", kind: "room" }, { id: "y", kind: "weird", channel: "a" }, { id: "z", kind: "thread", channel: "a" }, null, { id: "j", kind: "journal" }, { id: "j2", kind: "journal" }], active: "nope" }), ["a"]);
assert.deepEqual(junk.tabs, [{ id: "j", kind: "journal", title: "Journal" }]);
assert.equal(junk.active, "j");
// Over-cap saved state is trimmed on restore.
const many = { tabs: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, kind: "room", channel: `c${i}`, title: "" })), active: "m19" };
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
  assert.equal(restored.tabs[0].channel, "room-uni");
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

{
  // r15: a saved node that only borrows a room reopens on the last real room opened, else on nothing (the app then opens Uni)
  let n = 0; const id = () => `n${++n}`;
  const saved = (t: object) => restoreTabs(JSON.stringify({ v: 1, tabs: [{ id: "x", ...t }], active: "x", recent: ["x"] }), ["ch-uni", "ch-cohere"]);
  const expr = saved({ kind: "area", path: "Areas/Expression", title: "Expression", channel: "ch-uni", borrowed: true });
  assert.equal(activeTab(expr)?.borrowed, true, "the flag survives a save");
  const cohere = { id: "c", kind: "area" as const, path: "Projects/COhere", title: "COhere", channel: "ch-cohere", borrowed: false };
  assert.equal(isRealRoom(cohere), true);
  assert.equal(lastRoomOf({ ...cohere, borrowed: true }), null, "a borrowed room is never the last room");
  assert.equal(lastRoomOf({ id: "u", kind: "area", path: "X", title: "X" }), null, "nor a node not yet known to own one");
  const back = restorePlace(expr, lastRoomOf(cohere), ["ch-uni", "ch-cohere"], id);
  assert.equal(activeTab(back)?.path, "Projects/COhere");
  assert.equal(back.tabs.some((t) => t.path === "Areas/Expression"), false);
  assert.equal(activeTab(restorePlace(expr, null, ["ch-uni"], id)), null, "no last room: nothing, so the app opens Uni");
  assert.equal(activeTab(restorePlace(expr, "{bad", ["ch-uni"], id)), null);
  // a last room that has gone is not reopened
  assert.equal(activeTab(restorePlace(expr, JSON.stringify({ kind: "room", channel: "ch-gone", title: "x" }), ["ch-uni"], id)), null);
  // a place that owns its room, or is not yet known, is kept
  const own = saved({ kind: "area", path: "Projects/COhere", title: "COhere", channel: "ch-cohere", borrowed: false });
  assert.equal(restorePlace(own, null, [], id), own);
  const unknown = saved({ kind: "area", path: "Areas/Expression", title: "Expression" });
  assert.equal(restorePlace(unknown, null, [], id), unknown);
}

console.log("tabs tests passed");
