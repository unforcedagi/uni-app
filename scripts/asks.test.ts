// T-335 the shape: asks (src/shape/asksCore.ts): which tasks are asks, the room each lands in, the buttons, and what answering and Seen write.
// Made-up asks and rooms only. Run: node --experimental-strip-types scripts/asks.test.ts
process.env.TZ = "UTC";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answerBody, answerMeta, archiveBody, askBody, askFault, askForRun, doneBody, laterBody, laterMeta, laterUntil, snoozed, asksByRoom, asksFrom, asksPlaced, seenBody, seenCloses, seenMeta, splitTitle, visibleAsks, whenLabel, type VaultAsk } from "../src/shape/asksCore.ts";
import type { ShapeRoom } from "../src/shape/types.ts";
// (T-335 one ask: a task's buttons are the one card's, by one rule for every source)
import { cardButtons, taskCard } from "../src/shape/oneAsk.ts";
import { nodeTree } from "../src/shape/shapeCore.ts";
import { parseRegistry } from "../src/areas/roomsRegistry.ts";
import type { Note } from "../src/vault/reader.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n").slice(0, 6).join("\n     ")}`); }
}

// Wednesday 2026-11-11, 12:00 UTC
const NOW = Date.parse("2026-11-11T12:00:00Z");
const H = 3600_000;
const iso = (t: number) => new Date(t).toISOString();
const task = (id: string, title: string, m: Record<string, unknown>, at = NOW - H, tags = ["task"]): Note<"task"> =>
  ({ id, path: `Tasks/${title}`, tags, updatedAt: iso(at), createdAt: iso(at), metadata: { state: "open", owner: "aaron", asked_at: iso(at), needs_aaron: true, ...m } });
const room = (id: string, name: string): ShapeRoom => ({ id, name, last_message: null, last_ts: null });
const ROOMS = [room("c-kiln", "Kiln-Studio"), room("c-field", "#north-field"), room("c-uni", "Uni"), room("c-sanctum", "sanctum"), room("c-held", "held-room")];
// (the node tree as read, with nothing in it: these asks are judged by their names and rooms)
const NO_NODES = nodeTree([]);
const from = (notes: Note<"task">[], extra: Partial<Parameters<typeof asksFrom>[2]> = {}) => asksFrom(notes, ROOMS, { uniRoom: "c-uni", now: NOW, tree: NO_NODES, ...extra });
const one = (m: Record<string, unknown>, title = "T-501 Pick the glaze") => { const a = from([task("a", title, m)]); assert.equal(a.length, 1); return a[0]; };

check("only open tasks with needs_aaron true are asks (false, missing, closed and plain decisions are not)", () => {
  const a = from([
    task("yes", "T-1 Yes", {}),
    task("waiting", "T-2 Waiting", { state: "waiting" }),
    task("no", "T-3 No", { needs_aaron: false, needs_aaron_why: "stale" }),
    task("missing", "T-4 Missing", { needs_aaron: undefined }),
    task("str", "T-5 Stringy", { needs_aaron: "true" }),
    task("done", "T-6 Done", { state: "done" }),
    task("dec", "T-7 Old decision", {}, NOW - H, ["decision"]),
  ]);
  assert.deepEqual(a.map((x) => x.id).sort(), ["waiting", "yes"]);
});

check("the synthetic sample asks (no needs_aaron written) are not asks", () => {
  const notes = (JSON.parse(readFileSync(new URL("./fixtures/sample-asks.json", import.meta.url), "utf8")) as { notes: Note<"task">[] }).notes;
  assert.ok(notes.length > 5);
  assert.equal(from(notes).length, 0);
  // marked, every task is an ask; the two old decision-only notes still are not
  const tasks = notes.filter((n) => (n.tags as string[]).includes("task")).length;
  assert.equal(tasks, notes.length - 2);
  assert.equal(from(notes.map((n) => ({ ...n, metadata: { ...(n.metadata as object), needs_aaron: true } }))).length, tasks);
});

check("its room: reply_room, else room, matched by name case-insensitively with '#' ignored on either side", () => {
  assert.equal(one({ room: "kiln-studio" }).room, "c-kiln");
  assert.equal(one({ room: "#KILN-STUDIO" }).room, "c-kiln");
  assert.equal(one({ room: "north-field" }).room, "c-field", "a room listed as '#north-field' matches 'north-field'");
  assert.equal(one({ room: "kiln-studio", reply_room: "#north-field" }).room, "c-field", "reply_room wins over room");
  assert.equal(one({ room: "kiln-studio", reply_room: "#north-field" }).roomName, "north-field");
});

check("no match (no room named, or one this device doesn't have): Uni's room; no Uni room: none", () => {
  assert.equal(one({}).room, "c-uni");
  assert.equal(one({ room: "elsewhere" }).room, "c-uni");
  assert.equal(from([task("a", "T-1 x", { room: "elsewhere" })], { uniRoom: null })[0].room, null);
  // (its reply_root belongs to its own room's post: in Uni's room it is no thread)
  assert.equal(one({ room: "elsewhere", reply_root: "ev1" }).replyRoot, null);
  assert.equal(one({ room: "kiln-studio", reply_root: "ev1" }).replyRoot, "ev1");
});

check("a private room's ask is its room's own, marked private: by its name, or by privateRooms (id or name)", () => {
  const where = (notes: Note<"task">[], extra: Partial<Parameters<typeof asksFrom>[2]> = {}) => from(notes, extra).map((a) => [a.room, a.private === true]);
  assert.deepEqual(where([task("a", "T-1 x", { room: "sanctum" })]), [["c-sanctum", true]]);
  assert.deepEqual(where([task("a", "T-1 x", { room: "held-room" })], { privateRooms: new Set(["c-held"]) }), [["c-held", true]]);
  assert.deepEqual(where([task("a", "T-1 x", { room: "#Held-Room" })], { privateRooms: new Set(["held-room"]) }), [["c-held", true]]);
  // a private node or card in a private room: still that room's
  assert.deepEqual(where([task("a", "T-1 x", { room: "sanctum", node: "Areas/Sanctum/Garden" })]), [["c-sanctum", true]]);
  assert.deepEqual(where([task("a", "T-1 x", { room: "held-room" })]), [["c-held", false]], "a room not marked private: an ordinary ask");
});

check("a private ask with no private room of its own on this device is never drawn: never in Uni's room, never in a public room", () => {
  const noSanctum = ROOMS.filter((r) => r.id !== "c-sanctum");
  assert.equal(asksFrom([task("a", "T-1 x", { room: "sanctum" })], noSanctum, { uniRoom: "c-uni", now: NOW }).length, 0);
  assert.equal(from([task("a", "T-1 x", { room: "held-room" })], { privateRooms: new Set(["gone-room"]) }).length, 1);
  assert.equal(from([task("a", "T-1 x", { room: "gone-room" })], { privateRooms: new Set(["gone-room"]) }).length, 0);
  // a private node or card in a public room (or none): its words would leave the private place
  assert.equal(from([task("a", "T-1 x", { room: "kiln-studio", node: "Areas/Sanctum/Garden" })]).length, 0);
  assert.equal(from([task("a", "T-1 x", { room: "kiln-studio", card: "[[Cards/Sanctum/Notes]]" })]).length, 0);
  assert.equal(from([task("a", "T-1 x", { node: "Areas/Sanctum/Garden" })]).length, 0);
});

check("newest first, by the note's updatedAt (seconds)", () => {
  const a = from([task("old", "T-1 Old", {}, NOW - 5 * H), task("new", "T-2 New", {}, NOW - H), task("mid", "T-3 Mid", {}, NOW - 2 * H)]);
  assert.deepEqual(a.map((x) => x.id), ["new", "mid", "old"]);
  assert.equal(a[0].updatedAt, Math.floor((NOW - H) / 1000));
});

check("what, tid, why; a choose ask's default with its date and the other choices; no action beside choices", () => {
  const a = one({ kind: "choose", options: ["Celadon", "Tenmoku"], default: "Celadon", default_at: "2026-11-13T17:00:00Z", why_now: "Tiles go in Friday." });
  assert.equal(a.tid, "T-501");
  assert.equal(a.what, "Pick the glaze");
  assert.equal(a.why, "Tiles go in Friday.");
  assert.deepEqual(a.fallback, { value: "Celadon", label: "Celadon · Fri 5pm" });
  assert.deepEqual(a.options, ["Tenmoku"]);
  assert.equal(a.action, null);
  assert.equal(a.rev, iso(NOW - H));
});

check("a do ask: Done; no_default wins over a stray default; a tell or look ask has no action (its tap is Seen)", () => {
  const d = one({ kind: "do", default: "x", no_default: true });
  assert.equal(d.fallback, null);
  assert.equal(d.action, "Done");
  assert.equal(one({ kind: "tell" }).action, null);
  assert.equal(one({ kind: "look" }).action, null);
  assert.equal(one({}, "Sign the note").tid, null);
  assert.equal(one({}, "Sign the note").kind, "do");
});

check("a look-here pin's deep link (look_url) is its link, before link and url", () => {
  assert.equal(one({ kind: "look", link: "https://example.com/ref", url: "https://example.com/u", look_url: "uni://arcade/look/1" }).link, "uni://arcade/look/1");
  assert.equal(one({ kind: "look", link: "https://example.com/ref", url: "https://example.com/u" }).link, "https://example.com/ref");
  assert.equal(one({ kind: "look", url: "https://example.com/u" }).link, "https://example.com/u");
});

check("a task's buttons by kind, by the one card's rule (T-335 one ask): choose -> its options, Seen, Later; do -> I did it, Seen, Later", () => {
  const now = NOW / 1000;                                          // Wed 11-11: Later brings it back Sat 11-14
  const btn = (a: VaultAsk, o: { open?: boolean; roomName?: string } = {}) => cardButtons(taskCard(a), { now, ...o });
  const c = one({ kind: "choose", options: ["Celadon", "Tenmoku"], default: "Celadon" });
  assert.deepEqual(btn(c).map((b) => [b.label, b.value, b.primary, b.act]), [
    ["Celadon", "Celadon", true, "pick"], ["Tenmoku", "Tenmoku", false, "pick"], ["Seen", "", false, "seen"], ["Later · Sat", "2026-11-14", false, "later"],
  ]);
  assert.deepEqual(btn(one({ kind: "choose", options: ["A", "B"] })).map((b) => [b.label, b.primary]), [["A", true], ["B", false], ["Seen", false], ["Later · Sat", false]], "no default: the first choice is primary");
  assert.deepEqual(btn(one({ kind: "do" })).map((b) => [b.label, b.act, b.primary]), [["I did it", "did", true], ["Seen", "seen", false], ["Later · Sat", "later", false]]);
  assert.deepEqual(btn(one({ kind: "do", link: "https://example.com/x" })).map((b) => b.label), ["I did it", "Seen", "Later · Sat"], "a do ask's link is in its context");
  for (const k of ["do", "choose", "look", "tell"]) for (const b of btn(one({ kind: k, options: ["A", "B"] }), { open: true })) assert.ok(!["Done", "Not now"].includes(b.label), `${k}: ${b.label}`);
  // opened in place, every kind adds Reply in the room (when it has a room) and Archive, last
  for (const k of ["do", "choose", "look", "tell"]) assert.deepEqual(btn(one({ kind: k, options: ["A", "B"] }), { open: true }).slice(-2).map((b) => b.act), ["reply", "archive"], k);
  assert.deepEqual(btn({ ...one({ kind: "do" }), room: null }, { open: true }).map((b) => b.act), ["did", "seen", "later", "archive"], "no room: nowhere to reply");
  // each says what it does, in plain words
  const says = (a: VaultAsk, act: string) => btn(a, { open: true, roomName: "Kiln Studio" }).find((b) => b.act === act)!.does;
  assert.equal(says(one({ kind: "do" }), "did"), "Ends it and tells #Kiln Studio, which does any follow-up");
  assert.equal(says(one({ kind: "tell" }), "seen"), "Ends it for good; #Kiln Studio sees it on its next turn");
  assert.equal(says(one({ kind: "do" }), "later"), "Off your list until Sat 11-14, then back");
  assert.equal(says(one({ kind: "do" }), "reply"), "Your words go to #Kiln Studio's main line as its answer, and end it");
});

check("Later's day and its write", () => {
  assert.equal(laterUntil(new Date(2026, 11, 30, 9)), "2027-01-02", "across a year end");
  assert.deepEqual(laterMeta("2026-11-14"), { snoozed_until: "2026-11-14" }, "the app's one snooze patch, nothing else");
  assert.equal(laterBody({ tid: "T-9", what: "x" }, "2026-11-14"), "T-9: later. It's back on my list Sat 11-14.");
  assert.equal(snoozed("2026-11-14", "2026-11-11"), true);
  assert.equal(snoozed("2026-11-11", "2026-11-11"), false, "back on its day");
  assert.equal(snoozed(null, "2026-11-11"), false);
});

check("buttons: a tell ask is Seen alone (primary); a look ask with a link: Open (primary, its value the link), Seen", () => {
  const btn = (a: VaultAsk) => cardButtons(taskCard(a), { now: NOW / 1000 }).map((b) => [b.label, b.value, b.primary, b.act]);
  assert.deepEqual(btn(one({ kind: "tell" })), [["Seen", "", true, "seen"]]);
  assert.deepEqual(btn(one({ kind: "look", look_url: "uni://arcade/look/1" })), [["Open", "uni://arcade/look/1", true, "open"], ["Seen", "", false, "seen"]]);
  assert.deepEqual(btn(one({ kind: "look" })).map((b) => [b[0], b[2]]), [["Seen", true]], "a look ask with no link: Seen");
});

check("context (T-335 fixes): next is read; the body drops a front matter block and a first heading; no body and no next is a fault", () => {
  assert.equal(one({ kind: "do", next: " Paste the key " }).next, "Paste the key");
  assert.equal(one({ kind: "do" }).next, null);
  assert.equal(askBody("---\na: 1\n---\n# The title\n\nAbove.\n\n## Why\n\nBecause."), "Above.\n\n## Why\n\nBecause.");
  assert.equal(askBody(null), "");
  assert.equal(askFault({ next: null }, ""), true);
  assert.equal(askFault({ next: null }, "## Why\n\nx"), false);
  assert.equal(askFault({ next: "Do it" }, null), false);
});

check("a waiting run opens the ask on its own task; I did it and Archive say so in its room", () => {
  const asks = [{ tid: "T-7", id: "a" }, { tid: "T-9", id: "b" }];
  assert.equal(askForRun({ task: "t-9" }, asks)?.id, "b");
  assert.equal(askForRun({ task: null }, asks), null);
  assert.equal(askForRun({ task: "T-8" }, asks), null);
  assert.equal(doneBody({ tid: "T-9", what: "x" }), "T-9: I did this. Hand it back to this room for any follow-up (tasks.py handback T-9), then post [done T-9].");
  assert.equal(archiveBody({ tid: null, what: "Paint the hive" }), "Paint the hive: archived. It's out of my view; open a new ask if it still needs me.");
});

check("answer: the metadata (a pick of a choose ask is decided too) and the room's words", () => {
  const at = "2026-11-11T12:00:00.000Z";
  const c = one({ kind: "choose", options: ["Celadon", "Tenmoku"], default: "Celadon" });
  assert.deepEqual(answerMeta(c, "Celadon", "aaron", at), { answer: "Celadon", answered_at: at, answered_by: "aaron", decided: "Celadon", decided_at: at, decided_by: "aaron" });
  assert.deepEqual(Object.keys(answerMeta(c, "Tenmoku", "aaron", at)).sort(), ["answer", "answered_at", "answered_by", "decided", "decided_at", "decided_by"]);
  assert.deepEqual(Object.keys(answerMeta(c, "Neither, wait a week", "aaron", at)).sort(), ["answer", "answered_at", "answered_by"]);
  assert.deepEqual(Object.keys(answerMeta(one({ kind: "do" }), "Done", "aaron", at)).sort(), ["answer", "answered_at", "answered_by"]);
  assert.equal(answerBody({ tid: "T-501", what: "Pick" }, " Celadon "), "T-501: Celadon");
  assert.equal(answerBody({ tid: null, what: "Choose the hive paint" }, "White"), "Choose the hive paint: White");
});

check("Seen: a tell or look ask closes, a do or choose ask stays open; it writes who and when and needs_aaron false, never an answer", () => {
  assert.equal(seenCloses("tell"), true);
  assert.equal(seenCloses("look"), true);
  assert.equal(seenCloses("do"), false);
  assert.equal(seenCloses("choose"), false);
  assert.deepEqual(seenMeta("aaron", "2026-11-11T12:00:00.000Z"), { seen_at: "2026-11-11T12:00:00.000Z", seen_by: "aaron", needs_aaron: false, needs_aaron_why: "seen" });
  assert.equal(seenBody({ tid: "T-31", what: "Know this", kind: "tell" }), "T-31: seen.");
  assert.equal(seenBody({ tid: "T-32", what: "Do this", kind: "do" }), "T-32: seen. It stays open here until it needs my steer; ask again then.");
});

check("Later holds at once: an ask put off to a later day leaves the list before the sweep writes needs_aaron; on its day it is back", () => {
  assert.equal(from([task("s", "T-40 Later", { kind: "do", snoozed_until: "2099-01-01" })]).length, 0);
  assert.equal(from([task("s", "T-40 Later", { kind: "do", snoozed_until: "2020-01-01" })]).length, 1);
});

check("by room: grouped by channel id, newest first within; an ask with no room is in none", () => {
  const a = from([task("k1", "T-1 a", { room: "kiln-studio" }, NOW - 3 * H), task("k2", "T-2 b", { room: "kiln-studio" }, NOW - H), task("u", "T-3 c", {})]);
  const none = from([task("x", "T-4 d", {})], { uniRoom: null });
  const by = asksByRoom([...a, ...none]);
  assert.deepEqual(by.get("c-kiln")!.map((x) => x.id), ["k2", "k1"]);
  assert.deepEqual(by.get("c-uni")!.map((x) => x.id), ["u"]);
  assert.equal([...by.values()].flat().length, 3);
});

check("answered or seen here: hidden at once; a seen ask its room asks again shows again; an answered one stays hidden", () => {
  const asks: VaultAsk[] = from([task("d", "T-32 Do this", { kind: "do" })]);
  assert.deepEqual(visibleAsks(asks, new Map([["d", { at: NOW, seen: true }]])), []);
  const reasked = from([task("d", "T-32 Do this", { kind: "do", confirmed_at: iso(NOW + H) })]);
  assert.deepEqual(visibleAsks(reasked, new Map([["d", { at: NOW, seen: true }]])).map((x) => x.id), ["d"]);
  assert.deepEqual(visibleAsks(reasked, new Map([["d", { at: NOW, seen: false }]])), []);
});

// moved from the retired For you test (T-335): the same functions, now here
check("the default's date in a few words, in the device's time; a task's id read off its title", () => {
  const NOW = Date.parse("2026-11-11T12:00:00Z");
  assert.equal(whenLabel("2026-11-13T17:00:00Z", NOW), "Fri 5pm");
  assert.equal(whenLabel("2026-11-11T17:30:00Z", NOW), "today 5:30pm");
  assert.equal(whenLabel("2026-11-12T09:00:00Z", NOW), "tomorrow 9am");
  assert.equal(whenLabel("2026-11-20", NOW), "Nov 20");
  assert.equal(whenLabel("2026-11-14", NOW), "Sat");
  assert.equal(whenLabel("2026-11-05T12:00:00Z", NOW), "Nov 5 12pm");
  assert.equal(whenLabel(null, NOW), null);
  assert.equal(whenLabel("soon", NOW), null);
  assert.deepEqual(splitTitle("Tasks/T-77b Fix it"), { tid: "T-77B", rest: "Fix it" });
});

// ------------------------------------------------------------------ the node tree, retired rooms, two rooms of one name (review 11-11)
const nnote = (id: string, path: string, tags: string[], metadata: Record<string, unknown>) => ({ id, path, tags, metadata, updatedAt: "2026-11-01T00:00:00Z" });
// "Sanctum" (the fixtures' private area) holds a project with an ordinary name, and that project owns a room with an ordinary name
const TREE = nodeTree([
  nnote("n-quiet", "Areas/Sanctum", ["area"], {}), nnote("n-kiln", "Areas/Kiln", ["area"], { channel: "c-kiln" }),
  nnote("n-pots", "Projects/Pots", ["project"], { parent: "[[Areas/Kiln]]" }),
  nnote("n-log", "Projects/Garden Log", ["project"], { parent: "[[Areas/Sanctum]]", channel: "c-garden" }),
  nnote("n-barn", "Areas/Barn", ["area"], { room: "old-barn", room_status: "archived", room_fallback: "north-field" }),
] as never);
const TROOMS = [...ROOMS, room("c-garden", "garden-log"), room("c-old", "old-barn")];
const tfrom = (notes: Note<"task">[], extra: Partial<Parameters<typeof asksFrom>[2]> = {}) =>
  asksFrom(notes, TROOMS, { uniRoom: "c-uni", now: NOW, tree: TREE, ...extra }).map((a) => [a.room, a.private === true]);

check("an ask on a project inside a private area (by the tree, under an ordinary name) never lands in Uni's room or a public one", () => {
  assert.deepEqual(tfrom([task("a", "T-1 x", { node: "[[Projects/Garden Log]]" })]), []);
  assert.deepEqual(tfrom([task("a", "T-1 x", { node: "Projects/Garden Log", room: "kiln-studio" })]), []);
  assert.deepEqual(tfrom([task("a", "T-1 x", { card: "[[Projects/Garden Log]]" })]), []);
  // a public project's ask is ordinary
  assert.deepEqual(tfrom([task("a", "T-1 x", { node: "[[Projects/Pots]]", room: "kiln-studio" })]), [["c-kiln", false]]);
});

check("a room a private area owns under an ordinary name is private: its asks are drawn only inside it", () => {
  assert.deepEqual(tfrom([task("a", "T-1 x", { room: "garden-log" })]), [["c-garden", true]]);
  assert.deepEqual(tfrom([task("a", "T-1 x", { node: "[[Projects/Garden Log]]", reply_room: "#garden-log" })]), [["c-garden", true]]);
});

check("a room named loosely (spaces, case, '#', no dash) is the same room, so a private place's room keeps its ask however it is written", () => {
  assert.deepEqual(tfrom([task("a", "T-1 x", { room: "Garden Log" })]), [["c-garden", true]]);
  assert.deepEqual(tfrom([task("a", "T-1 x", { reply_room: "#gardenlog" })]), [["c-garden", true]]);
  // a private project's name as the room, with no room of that name here: never Uni's room
  assert.deepEqual(asksFrom([task("a", "T-1 x", { room: "Garden Log" })], ROOMS, { uniRoom: "c-uni", now: NOW, tree: TREE }), []);
  assert.deepEqual(tfrom([task("a", "T-1 x", { room: "Kiln Studio" })]), [["c-kiln", false]]);
});

check("until the tree is read, an ask whose place can't be judged is not drawn (only a placeless ask in Uni's room is)", () => {
  const pre = (m: Record<string, unknown>) => tfrom([task("a", "T-1 x", m)], { tree: null });
  assert.deepEqual(pre({ node: "[[Projects/Pots]]" }), []);
  assert.deepEqual(pre({ room: "kiln-studio" }), []);
  assert.deepEqual(pre({ room: "garden-log" }), []);
  assert.deepEqual(pre({ card: "Cards/Anything" }), []);
  assert.deepEqual(pre({}), [["c-uni", false]]);
});

check("an ask naming a retired or renamed room goes where its work went: the registry's successor, else its node's room, else Uni's", () => {
  const reg = parseRegistry({ rooms: { "kiln-studio": { id: "c-kiln", was: ["kiln"] }, "held-room": { id: "c-held", private: true, was: ["old-held"] }, uni: { id: "c-uni" } },
    retired: { "old-barn": { into: "kiln-studio" }, "gone-room": { none: true } } })!;
  const hidden = new Set(["c-old"]);
  const at = (m: Record<string, unknown>, tree: typeof TREE | null = TREE) => asksFrom([task("a", "T-1 x", { reply_root: "ev1", ...m })], TROOMS, { uniRoom: "c-uni", now: NOW, tree, reg, hidden });
  // retired into a live room: there, and not threaded under a post of the old room
  assert.deepEqual(at({ room: "old-barn" }).map((a) => [a.room, a.replyRoot]), [["c-kiln", null]]);
  // an old name of a live room: that room
  assert.deepEqual(at({ room: "kiln" }).map((a) => a.room), ["c-kiln"]);
  // a private room's old name: inside that room, private (never dropped for its old name, never in Uni's room)
  assert.deepEqual(at({ room: "old-held" }).map((a) => [a.room, a.private === true]), [["c-held", true]]);
  // a retired room with no successor: its node's room, else Uni's
  assert.deepEqual(at({ room: "gone-room", node: "[[Projects/Pots]]" }).map((a) => a.room), ["c-kiln"]);
  assert.deepEqual(at({ room: "gone-room" }).map((a) => a.room), ["c-uni"]);
  // no registry word: a node that marks the room archived names its room_fallback
  const noReg = asksFrom([task("a", "T-1 x", { room: "old-barn" })], TROOMS, { uniRoom: "c-uni", now: NOW, tree: TREE, hidden });
  assert.deepEqual(noReg.map((a) => a.room), ["c-field"]);
});

check("an ask whose retired room moved into a private room this device doesn't have is dropped, never put in Uni's room", () => {
  // the registry says where it went, and that the place is private; the device has no such room
  const reg = parseRegistry({ rooms: { "kiln-studio": { id: "c-kiln" }, secret: { id: "c-sec", private: true }, uni: { id: "c-uni" } }, retired: { "old-a": { into: "secret" } } })!;
  const at = (m: Record<string, unknown>, o: Partial<Parameters<typeof asksFrom>[2]> = {}, rooms = TROOMS) => asksFrom([task("a", "T-1 x", m)], rooms, { uniRoom: "c-uni", now: NOW, tree: TREE, ...o }).map((a) => [a.room, a.private === true]);
  assert.deepEqual(at({ room: "old-a" }, { reg }), []);
  // the successor is private only by the tree (a project inside the private area owns it), and absent
  const moved = nodeTree([
    { id: "n-s", path: "Areas/Sanctum", tags: ["area"], metadata: {}, updatedAt: "2026-11-01T00:00:00Z" },
    { id: "n-k", path: "Areas/Kiln", tags: ["area"], metadata: { channel: "c-kiln" }, updatedAt: "2026-11-01T00:00:00Z" },
    { id: "n-log", path: "Projects/Seed Log", tags: ["project"], metadata: { parent: "[[Areas/Sanctum]]", channel: "c-seed" }, updatedAt: "2026-11-01T00:00:00Z" },
    { id: "n-pub", path: "Projects/Pots", tags: ["project"], metadata: { parent: "[[Areas/Kiln]]", room: "pots-old", room_status: "archived", room_fallback: "seed-log" }, updatedAt: "2026-11-01T00:00:00Z" },
  ] as never);
  const reg2 = parseRegistry({ rooms: { "kiln-studio": { id: "c-kiln" }, "seed-log": { id: "c-seed" }, uni: { id: "c-uni" } }, retired: { "old-g": { into: "seed-log" } } })!;
  assert.deepEqual(at({ room: "old-g" }, { reg: reg2, tree: moved }), []);
  // a public node's archived room whose room_fallback is that private, absent room
  assert.deepEqual(at({ room: "pots-old" }, { tree: moved }), []);
  // the private place owns the room under another name: only the registry's channel id ties the name to it
  const other = nodeTree([
    { id: "n-s", path: "Areas/Sanctum", tags: ["area"], metadata: {}, updatedAt: "2026-11-01T00:00:00Z" },
    { id: "n-c", path: "Projects/Compost", tags: ["project"], metadata: { parent: "[[Areas/Sanctum]]", channel: "c-seed" }, updatedAt: "2026-11-01T00:00:00Z" },
  ] as never);
  assert.deepEqual(at({ room: "old-g" }, { reg: reg2, tree: other }), []);
  assert.deepEqual(at({ room: "seed-log" }, { reg: reg2, tree: other }), []);
  // and when the private room it moved to IS here: inside it, private
  assert.deepEqual(at({ room: "old-g" }, { reg: reg2, tree: moved }, [...TROOMS, room("c-seed", "seed-log")]), [["c-seed", true]]);
});

check("a private place is private however it is spelled, wherever its work moved, and whichever room field names it", () => {
  const n = (id: string, path: string, tags: string[], metadata: Record<string, unknown>) => ({ id, path, tags, metadata, updatedAt: "2026-11-01T00:00:00Z" });
  const base = [n("n-s", "Areas/Sanctum", ["area"], {}), n("n-k", "Areas/Kiln", ["area"], { channel: "c-kiln" }), n("n-pots", "Projects/Pots", ["project"], { parent: "[[Areas/Kiln]]" }),
    n("n-log", "Projects/Garden Log", ["project"], { parent: "[[Areas/Sanctum]]", channel: "c-garden" })];
  const tree = nodeTree(base as never);
  const here = [room("c-kiln", "kiln-studio"), room("c-uni", "Uni"), room("c-field", "north-field")];
  const at = (m: Record<string, unknown>, o: Partial<Parameters<typeof asksFrom>[2]> = {}, rooms = here) => asksFrom([task("a", "T-1 x", m)], rooms, { uniRoom: "c-uni", now: NOW, tree, ...o }).map((a) => [a.room, a.private === true]);
  // the second room field: a public reply_room never hides a private room
  assert.deepEqual(at({ reply_room: "kiln-studio", room: "garden-log" }, {}, [...here, room("c-garden", "garden-log")]), []);
  assert.deepEqual(at({ reply_room: "kiln-studio", room: "sanctum" }), []);
  // the registry's private room, absent, spelled loosely or by an old name
  const was = parseRegistry({ rooms: { "secret-room": { id: "c-sec", private: true, was: ["old-secret"] } }, retired: { "hush-room": { none: true, private: true } } })!;
  for (const name of ["Secret Room", "secret_room", "Old Secret", "#old-secret", "Hush Room", "c-sec"]) assert.deepEqual(at({ room: name }, { reg: was }), [], name);
  // its work moved more than one step, or the step is written as a channel id
  const chain = parseRegistry({ rooms: { secret: { id: "c-sec", private: true }, "kiln-studio": { id: "c-kiln" } }, retired: { "a-old": { into: "b-old" }, "b-old": { into: "secret" } } })!;
  assert.deepEqual(at({ room: "a-old" }, { reg: chain }), []);
  assert.deepEqual(at({ room: "a-old" }, { reg: parseRegistry({ rooms: { secret: { id: "c-sec", private: true } }, retired: { "a-old": { into: "c-sec" } } })! }), []);
  assert.deepEqual(at({ room: "c-old" }, { reg: parseRegistry({ rooms: { secret: { id: "c-sec", private: true } }, folded_ids: { "c-old": "c-sec" } })! }), []);
  // a private node's archived room, spelled loosely (its public room_fallback is no way out)
  const beds = nodeTree([...base, n("n-pv", "Projects/Hidden Beds", ["project"], { parent: "[[Areas/Sanctum]]", room: "Old Beds", room_status: "archived", room_fallback: "kiln-studio" })] as never);
  for (const name of ["Old Beds", "old-beds", "oldbeds"]) assert.deepEqual(at({ room: name }, { tree: beds }), [], name);
  // a node or card written any way
  for (const node of ["projects/garden log", "Garden Log", "[[Garden Log]]", "Projects/Garden Log#x", "n-log"]) assert.deepEqual(at({ node, room: "kiln-studio" }), [], node);
  assert.deepEqual(at({ card: "[[projects/garden log|x]]", room: "kiln-studio" }), []);
  // and a public ask is still placed
  assert.deepEqual(at({ node: "[[Projects/Pots]]", room: "kiln-studio" }), [["c-kiln", false]]);
  assert.deepEqual(at({ reply_room: "north-field", room: "kiln-studio" }), [["c-field", false]]);
});

check("a private place named as a link, a path, a list, a non-string value or in another script is still private", () => {
  const n = (id: string, path: string, tags: string[], metadata: Record<string, unknown>) => ({ id, path, tags, metadata, updatedAt: "2026-11-01T00:00:00Z" });
  const base = [n("n-s", "Areas/Sanctum", ["area"], {}), n("n-k", "Areas/Kiln", ["area"], { channel: "c-kiln" }), n("n-log", "Projects/Garden Log", ["project"], { parent: "[[Areas/Sanctum]]", channel: "c-garden" }),
    n("n-t", "Projects/Тайна", ["project"], { parent: "[[Areas/Sanctum]]" }), n("n-c", "Projects/Caf\u00e9", ["project"], { parent: "[[Areas/Sanctum]]" }), n("n-pub", "Projects/Сад", ["project"], { parent: "[[Areas/Kiln]]" })];
  const tree = nodeTree(base as never);
  const here = [room("c-kiln", "kiln-studio"), room("c-uni", "Uni")];
  const at = (m: Record<string, unknown>, o: Partial<Parameters<typeof asksFrom>[2]> = {}) => asksFrom([task("a", "T-1 x", m)], here, { uniRoom: "c-uni", now: NOW, tree, ...o }).map((a) => [a.room, a.private === true]);
  // a room field written as a link, a path, with an alias, or as a list
  for (const r of ["[[Areas/Sanctum]]", "[[Projects/Garden Log]]", "projects/garden log", "Sanctum|x", "Sanctum, kiln-studio", "Areas\\Sanctum", "Garden%20Log", "\uff33\uff41\uff4e\uff43\uff54\uff55\uff4d"]) {
    assert.deepEqual(at({ room: r }), [], `room ${r}`);
    assert.deepEqual(at({ reply_room: "kiln-studio", room: r }), [], `reply_room + room ${r}`);
  }
  // values that aren't strings
  for (const v of [["sanctum"], ["garden-log"], ["c-garden"], { name: "sanctum" }]) { assert.deepEqual(at({ room: v }), [], JSON.stringify(v)); assert.deepEqual(at({ reply_room: v }), [], JSON.stringify(v)); }
  for (const v of [["[[Projects/Garden Log]]"], ["[[Areas/Sanctum]]"], ["n-log"], { path: "Projects/Garden Log" }]) { assert.deepEqual(at({ node: v }), [], JSON.stringify(v)); assert.deepEqual(at({ card: v }), [], JSON.stringify(v)); }
  // before the tree is read, a value of any shape that names something waits
  for (const k of ["room", "reply_room", "node", "card"]) assert.deepEqual(at({ [k]: ["Sanctum"] }, { tree: null }), [], k);
  // names with no ASCII letters, and the same name composed two ways
  assert.deepEqual(at({ node: "Тайна" }), []);
  assert.deepEqual(at({ node: "cafe\u0301" }), []);
  const far = parseRegistry({ rooms: { "日記": { id: "c-d", private: true } }, retired: { "a-old": { into: "b-old" }, "b-old": { into: "日記" } } })!;
  assert.deepEqual(at({ room: "a-old" }, { reg: far }), []);
  // a long chain of moves is followed to its end
  const retired: Record<string, unknown> = {};
  for (let i = 0; i < 70; i++) retired[`r${i}`] = { into: i === 69 ? "secret" : `r${i + 1}` };
  assert.deepEqual(at({ room: "r0" }, { reg: parseRegistry({ rooms: { secret: { id: "c-sec", private: true } }, retired })! }), []);
  // and a public project with a non-ASCII name is not hidden by a private one
  assert.deepEqual(at({ node: "[[Projects/Сад]]", room: "kiln-studio" }), [["c-kiln", false]]);
  // other separators, a markdown link, an .html reference, and a value nested too deep to read
  for (const r of ["kiln-studio; sanctum", "kiln-studio\nSanctum", "kiln-studio | sanctum", "kiln-studio garden-log", "[x](Areas/Sanctum.md)"]) assert.deepEqual(at({ room: r }), [], JSON.stringify(r));
  for (const v of ["Projects/Garden Log.html", "[[Projects/Garden Log.html|x]]", "[g](Projects/Garden Log.md)"]) { assert.deepEqual(at({ node: v, room: "kiln-studio" }), [], v); assert.deepEqual(at({ card: v, room: "kiln-studio" }), [], v); }
  assert.deepEqual(at({ room: ["kiln-studio", [[[[["Sanctum"]]]]]] }), []);
  assert.deepEqual(at({ room: ["kiln-studio", { a: { b: { c: { d: { e: "Sanctum" } } } } }] }), []);
  // a public room given as a one-item list is still placed
  assert.deepEqual(at({ room: ["kiln-studio"] }), [["c-kiln", false]]);
});

check("asks kept out of sight are counted, so home can say something waits without a word of it", () => {
  const got = asksPlaced([task("a", "T-1 x", { node: "[[Projects/Garden Log]]" }), task("b", "T-2 y", { room: "kiln-studio" }), task("c", "T-3 z", { room: "sanctum-absent", node: "[[Areas/Sanctum]]" })],
    [room("c-kiln", "kiln-studio"), room("c-uni", "Uni")], { uniRoom: "c-uni", now: NOW, tree: TREE });
  assert.deepEqual(got.asks.map((a) => a.id), ["b"]);
  assert.equal(got.unseen, 2);
});

check("two live rooms of one name: the non-DM one, else the one the registry lists, else Uni's room (never a guess)", () => {
  const dm = { ...room("c-dm", "kiln-studio"), dm: true };
  const two = (rooms: ShapeRoom[], extra: Partial<Parameters<typeof asksFrom>[2]> = {}) =>
    asksFrom([task("a", "T-1 x", { room: "kiln-studio", reply_root: "ev1" })], rooms, { uniRoom: "c-uni", now: NOW, tree: TREE, ...extra }).map((a) => [a.room, a.replyRoot]);
  assert.deepEqual(two([dm, ...ROOMS]), [["c-kiln", "ev1"]]);
  const twin = room("c-kiln2", "Kiln-Studio");
  assert.deepEqual(two([twin, ...ROOMS]), [["c-uni", null]]);
  assert.deepEqual(two([twin, ...ROOMS], { reg: parseRegistry({ rooms: { "kiln-studio": { id: "c-kiln2" } } }) }), [["c-kiln2", "ev1"]]);
  // one of the two private: its words never go to Uni's room
  assert.deepEqual(two([twin, ...ROOMS], { privateRooms: new Set(["c-kiln2"]) }), []);
  // the registry picks one, but its twin is private (known by id only): the ask is not drawn in the public one
  assert.deepEqual(two([twin, ...ROOMS], { reg: parseRegistry({ rooms: { "kiln-studio": { id: "c-kiln" } } }), privateRooms: new Set(["c-kiln2"]) }), []);
});

console.log(failed ? `\n${failed} failed` : "\nall asks checks passed");
if (failed) process.exit(1);
