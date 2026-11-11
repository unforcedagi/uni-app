// T-335 the shape: home's rows, pins, clock words, the bar's count, the last line and the glyphs (src/shape/homeCore.ts).
// Run: node --experimental-strip-types scripts/home.test.ts
import assert from "node:assert/strict";
import { ago, countdown, homeRows, lastLine, PIN_WINDOW_S, pinsFrom, roomGlyph, wantsCount } from "../src/shape/homeCore.ts";
import type { Approval } from "../src/approvals.ts";
import type { Ask, RoomRuns, ShapeRoom } from "../src/shape/types.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const NOW = 1_800_000_000;
const room = (id: string, name: string, last_ts: number | null, extra: Partial<ShapeRoom> = {}): ShapeRoom => ({ id, name, last_message: "hi", last_ts, ...extra });
const ask = (id: string, roomId: string, updatedAt: number): Ask => ({ id, tid: null, room: roomId, kind: "look", what: "Look at the plot map", why: null, options: [], fallback: null, action: "Seen", link: null, updatedAt });

check("rows: newest first; an ask lifts a quiet room; a waiting run lifts too; never-said rooms last, by name", () => {
  const rooms = [room("house", "House", NOW - 9000), room("zeta", "Zeta", null), room("garden", "Garden co-op site", NOW - 600), room("studio", "Studio", NOW - 5000), room("alpha", "Alpha", null), room("teach", "Teaching", NOW - 7000)];
  const asks = new Map([["house", [ask("a1", "house", NOW - 60)]]]);
  const runs = new Map<string, RoomRuns>([
    ["teach", { moving: null, waiting: { id: "r1", state: "waiting", title: "Rubric", line: "Which week?", startedAt: NOW - 300 } }],
    // a moving run's start does not lift a room
    ["studio", { moving: { id: "r2", state: "moving", title: "Cut", line: "Rendering", startedAt: NOW - 10 }, waiting: null }],
  ]);
  const rows = homeRows(rooms, runs, asks);
  assert.deepEqual(rows.map((r) => r.room.id), ["house", "teach", "garden", "studio", "alpha", "zeta"]);
  assert.equal(rows[0].at, NOW - 60);
  assert.equal(rows[0].asks.length, 1);
  assert.deepEqual(rows.find((r) => r.room.id === "garden")!.runs, { moving: null, waiting: null });
});

check("rows: ties keep the given order; hidden rooms are left out; unread and mention carried", () => {
  const rows = homeRows([room("b", "B", NOW, { unread: 3, mentions: true }), room("a", "A", NOW), room("c", "C", NOW)], new Map(), new Map(), { hidden: new Set(["c"]) });
  assert.deepEqual(rows.map((r) => r.room.id), ["b", "a"]);
  assert.equal(rows[0].unread, 3); assert.equal(rows[0].mention, true);
  assert.equal(rows[1].unread, 0); assert.equal(rows[1].mention, false);
});

const approval = (ref: string, deadline: number | null, extra: Partial<Approval> = {}): Approval => ({ ref, channel: "riverbend", author: "hermes", ts: NOW - 60, root: null, command: "send-invoice  --to billing@example.com", why: "Sends money", answers: ["/approve", "/deny"], deadline, kind: "command", ...extra });
const names = (id: string) => (id === "riverbend" ? "Riverbend Commons" : null);

check("pins: only within the window, not lapsed, soonest first (edges: expired, now, exactly at window, beyond)", () => {
  const list = [
    approval("beyond", NOW + PIN_WINDOW_S + 1), approval("late", NOW + 600), approval("edge", NOW + PIN_WINDOW_S),
    approval("soon", NOW + 30), approval("now", NOW), approval("gone", NOW - 5), approval("open", null),
  ];
  assert.deepEqual(pinsFrom(list, names, NOW).map((p) => p.ref), ["soon", "late", "edge"]);
});

check("pins: a Hermes prompt says its command and why; an unknown room reads 'a room'", () => {
  const [p] = pinsFrom([approval("x", NOW + 60)], names, NOW);
  assert.deepEqual({ ...p }, { ref: "x", room: "riverbend", roomName: "Riverbend Commons", what: "OK to run send-invoice --to billing@example.com?", detail: "Sends money", expires: NOW + 60, sealed: false });
  const [q] = pinsFrom([approval("y", NOW + 60, { channel: "elsewhere", why: "" })], names, NOW);
  assert.equal(q.roomName, "a room"); assert.equal(q.detail, null);
});

check("pins: Uni's sealed card says its reach and class, not the prompt fields", () => {
  const sealed = { ref: "s", channel: "riverbend", root: null, ts: NOW, kind: "single" as const, credential: "billing", action: "invoice.send", class: "powerful" as const, rows: 1, expires: NOW + 120, fingerprint: "9b13b2ae00", reach: "Sends one invoice for $2,400" };
  const [p] = pinsFrom([approval("s", NOW + 120, { kind: "sealed", command: "ignored", why: "", sealed })], names, NOW);
  assert.equal(p.what, "Sends one invoice for $2,400");
  assert.equal(p.detail, "Powerful: hold to approve · job 9b13 b2ae");
  assert.equal(p.sealed, true);
  const [m] = pinsFrom([approval("m", NOW + 120, { kind: "sealed", sealed: { ...sealed, kind: "morning", reach: null, rows: 2 } })], names, NOW);
  assert.equal(m.what, "Morning card · 2 routine credentials");
});

check("pins: one from a private room (or while privacy can't be told) is wordless: no command, no reach, no why, no room name; still counted", () => {
  const sealed = { ref: "s", channel: "den", root: null, ts: NOW, kind: "single" as const, credential: "billing", action: "invoice.send", class: "powerful" as const, rows: 1, expires: NOW + 120, fingerprint: "9b13b2ae00", reach: "Sends one invoice for $2,400" };
  const list = [approval("x", NOW + 60, { channel: "den" }), approval("s", NOW + 120, { kind: "sealed", channel: "den", sealed }), approval("o", NOW + 90)];
  const pins = pinsFrom(list, (id) => (id === "den" ? "den" : names(id)), NOW, (ch) => ch === "den");
  const hushed = pins.filter((p) => p.private);
  assert.deepEqual(hushed.map((p) => p.ref), ["x", "s"]);
  for (const p of hushed) {
    assert.deepEqual({ what: p.what, detail: p.detail, roomName: p.roomName, room: p.room }, { what: "An approval waits in a private room", detail: null, roomName: "a private room", room: "den" });
    assert.doesNotMatch(JSON.stringify(p), /invoice|Sends|billing|Powerful/i);
  }
  assert.equal(pins.find((p) => p.ref === "o")!.private, undefined);
  assert.equal(wantsCount([], pins), 3);
});

check("countdown: m:ss, zero-padded seconds, expired at and after zero", () => {
  assert.equal(countdown(NOW + 539, NOW), "expires in 8:59");
  assert.equal(countdown(NOW + 5, NOW), "expires in 0:05");
  assert.equal(countdown(NOW + 60, NOW), "expires in 1:00");
  assert.equal(countdown(NOW + 0.4, NOW), "expires in 0:01");
  assert.equal(countdown(NOW, NOW), "expired");
  assert.equal(countdown(NOW - 3, NOW), "expired");
});

check("wantsCount: asks + pins + a waiting run only where the row has no asks", () => {
  const waiting = { id: "w", state: "waiting" as const, title: "t", line: "l", startedAt: NOW };
  const rows = homeRows(
    [room("a", "A", NOW), room("b", "B", NOW), room("c", "C", NOW), room("d", "D", NOW)],
    new Map<string, RoomRuns>([["b", { moving: null, waiting }], ["c", { moving: null, waiting }]]),
    new Map([["a", [ask("1", "a", NOW), ask("2", "a", NOW)]], ["c", [ask("3", "c", NOW)]]]),
  );
  const pins = pinsFrom([approval("p", NOW + 60)], names, NOW);
  assert.equal(wantsCount(rows, pins), 2 + 1 + 1 + 1);
  assert.equal(wantsCount([], []), 0);
});

check("a private room's asks: on home its row carries none of them, only how many (counted on the bar, lifting the row); inside, they are its own", () => {
  const hushedAsk = { ...ask("p1", "den", NOW - 5), what: "Words that stay inside", private: true };
  const asks = new Map([["den", [hushedAsk, { ...hushedAsk, id: "p2" }]], ["a", [ask("x", "a", NOW - 50)]]]);
  const rows = homeRows([room("a", "A", NOW - 100), room("den", "Den", NOW - 200)], new Map(), asks);
  const den = rows.find((r) => r.room.id === "den")!;
  assert.deepEqual(den.asks, []);
  assert.equal(den.hushed, 2);
  assert.equal(rows.find((r) => r.room.id === "a")!.hushed ?? 0, 0);
  assert.equal(JSON.stringify(den).includes("Words that stay inside"), false);
  assert.equal(rows[0].room.id, "den", "an ask lifts a private room too");
  assert.equal(wantsCount(rows, []), 1 + 2);
});

check("ago: now / minutes / hours / Yesterday / weekday / date", () => {
  assert.equal(ago(NOW - 59, NOW), "now");
  assert.equal(ago(NOW + 30, NOW), "now"); // a clock a little ahead
  assert.equal(ago(NOW - 60, NOW), "1m");
  assert.equal(ago(NOW - 3599, NOW), "59m");
  assert.equal(ago(NOW - 3600, NOW), "1h");
  assert.equal(ago(NOW - 86399, NOW), "23h");
  assert.equal(ago(NOW - 86400, NOW), "Yesterday");
  // 2026-11-10 12:00 UTC is a Tuesday in every zone from UTC-11 to UTC+11
  const tue = Date.UTC(2026, 10, 10, 12) / 1000;
  assert.equal(ago(tue, tue + 3 * 86400), "Tue");
  assert.equal(ago(tue, tue + 7 * 86400), "Nov 10");
});

check("lastLine: one plain line; markdown stripped; a bold lead name becomes the author", () => {
  assert.deepEqual(lastLine({ last_message: "**Mira Okafor:** Can we move the *walkthrough* to `Thursday`?" }), { who: "Mira Okafor", text: "Can we move the walkthrough to Thursday?" });
  assert.deepEqual(lastLine({ last_message: "# Plan\n\n- one\n- [two](https://example.com)\n\nthree" }), { who: null, text: "Plan one two three" });
  assert.deepEqual(lastLine({ last_message: "**Note** this is bold, not a name" }), { who: null, text: "Note this is bold, not a name" });
  assert.deepEqual(lastLine({ last_message: "plain", last_author: "Uni" }), { who: "Uni", text: "plain" });
  assert.deepEqual(lastLine({ last_message: null }), { who: null, text: "" });
  const long = lastLine({ last_message: "x".repeat(400) }).text;
  assert.equal([...long].length, 160); assert.ok(long.endsWith("…"));
  assert.equal(lastLine({ last_message: "Your OK, please.\n```uni-sealed-approval\n{\"v\":1}\n```" }).text, "Your OK, please.");
});

check("roomGlyph: Uni's ring; others stable, from the set, always text style", () => {
  assert.equal(roomGlyph("Uni"), "◎︎");
  const g = roomGlyph("Riverbend Commons");
  assert.equal(g, roomGlyph("Riverbend Commons"));
  assert.ok(g.endsWith("︎"));
  assert.ok(["◇", "❦", "▢", "△", "✎", "⌂", "◆"].includes(g.slice(0, -1)));
  // the hash spreads names over the set, not onto one shape
  const seen = new Set(["House", "Studio", "To Post", "Arcade night", "Garden co-op site", "Teaching: Design 2", "Riverbend Commons"].map(roomGlyph));
  assert.ok(seen.size >= 3, `only ${seen.size} glyphs`);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nhome: all passed");
