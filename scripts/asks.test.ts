// T-335 the shape: asks (src/shape/asksCore.ts): which tasks are asks, the room each lands in, the buttons, and what answering and Seen write.
// Made-up asks and rooms only. Run: node --experimental-strip-types scripts/asks.test.ts
process.env.TZ = "UTC";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answerBody, answerMeta, askButtons, asksByRoom, asksFrom, seenBody, seenCloses, seenMeta, visibleAsks, type VaultAsk } from "../src/shape/asksCore.ts";
import type { ShapeRoom } from "../src/shape/types.ts";
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
const from = (notes: Note<"task">[], extra: Partial<Parameters<typeof asksFrom>[2]> = {}) => asksFrom(notes, ROOMS, { uniRoom: "c-uni", now: NOW, ...extra });
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

check("a private place's asks are never shown: its room by name or by privateRooms (id or name), its node or card", () => {
  assert.equal(from([task("a", "T-1 x", { room: "sanctum" })]).length, 0);
  assert.equal(from([task("a", "T-1 x", { room: "held-room" })], { privateRooms: new Set(["c-held"]) }).length, 0);
  assert.equal(from([task("a", "T-1 x", { room: "#Held-Room" })], { privateRooms: new Set(["held-room"]) }).length, 0);
  assert.equal(from([task("a", "T-1 x", { room: "kiln-studio", node: "Areas/Sanctum/Garden" })]).length, 0);
  assert.equal(from([task("a", "T-1 x", { room: "kiln-studio", card: "[[Cards/Sanctum/Notes]]" })]).length, 0);
  assert.equal(from([task("a", "T-1 x", { room: "held-room" })]).length, 1, "a room not marked private shows");
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

check("buttons: default (primary), other choices, Seen; a do ask: Done (primary), Seen", () => {
  const c = one({ kind: "choose", options: ["Celadon", "Tenmoku"], default: "Celadon" });
  assert.deepEqual(askButtons(c), [
    { label: "Celadon", value: "Celadon", primary: true, act: "answer" },
    { label: "Tenmoku", value: "Tenmoku", primary: false, act: "answer" },
    { label: "Seen", value: "Seen", primary: false, act: "seen" },
  ]);
  const nd = askButtons(one({ kind: "choose", options: ["A", "B"] }));
  assert.deepEqual(nd.map((b) => [b.label, b.primary]), [["A", true], ["B", false], ["Seen", false]], "no default: the first choice is primary");
  assert.deepEqual(askButtons(one({ kind: "do" })).map((b) => [b.label, b.act, b.primary]), [["Done", "answer", true], ["Seen", "seen", false]]);
});

check("buttons: a tell ask is Seen alone (primary); a look ask with a link: Open (primary, its value the link), Seen", () => {
  assert.deepEqual(askButtons(one({ kind: "tell" })), [{ label: "Seen", value: "Seen", primary: true, act: "seen" }]);
  assert.deepEqual(askButtons(one({ kind: "look", look_url: "uni://arcade/look/1" })), [
    { label: "Open", value: "uni://arcade/look/1", primary: true, act: "open" },
    { label: "Seen", value: "Seen", primary: false, act: "seen" },
  ]);
  // a do ask with a link keeps Done primary, the link beside it
  assert.deepEqual(askButtons(one({ kind: "do", link: "https://example.com/x" })).map((b) => [b.label, b.primary]), [["Done", true], ["Open", false], ["Seen", false]]);
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

console.log(failed ? `\n${failed} failed` : "\nall asks checks passed");
if (failed) process.exit(1);
