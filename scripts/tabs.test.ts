// Run: node --experimental-strip-types scripts/tabs.test.ts
import assert from "node:assert/strict";
import { activeTab, closeTab, EMPTY_TABS, focusTab, MAX_TABS, navigateNoteTab, nextAfterClose, openTab, recordingTabCanClose, restoreTabs, sameTarget, serializeTabs, tabForDigit, updateTab, type TabTarget, type Tabs } from "../src/tabs.ts";
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

// Replace navigates in place (room → thread), even if that room is open elsewhere.
s = focusTab(s, s.tabs[0].id);
const pos = s.tabs.findIndex((t) => t.id === s.active);
s = openTab(s, thread("b", "r1"), "replace", id);
assert.equal(s.tabs[pos].kind, "thread");
assert.equal(s.tabs[pos].id, s.active);
s = openTab(s, room("c"), "replace", id);
assert.equal(s.tabs.filter((t) => t.channel === "c").length, 2);

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

// Cmd-1…8 / 9 = last.
assert.equal(tabForDigit(k, 1)?.id, k.tabs[0].id);
assert.equal(tabForDigit(k, 9)?.id, k.tabs[k.tabs.length - 1].id);
assert.equal(tabForDigit(EMPTY_TABS, 1), null);
let two = openTab(EMPTY_TABS, room("a"), "focus", id);
two = openTab(two, room("b"), "new", id);
assert.equal(tabForDigit(two, 5), null);

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

console.log("tabs tests passed");
