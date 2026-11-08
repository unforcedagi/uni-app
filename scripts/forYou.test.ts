// 0.3.0 For you: the one data module (src/foryou/forYouCore.ts), notes in, view out. Made-up asks and cards only.
// Run: node --experimental-strip-types scripts/forYou.test.ts
process.env.TZ = "UTC";
import assert from "node:assert/strict";
import { buildTaskTree, isTaskRow, parseTask } from "../src/areas/taskCore.ts";
import { answerBody, answerMeta, cardView, forYou, hillWords, quietLine, splitTitle, whenLabel, type Note, type Place } from "../src/foryou/forYouCore.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n").slice(0, 6).join("\n     ")}`); }
}

// Wednesday 2026-11-11, 12:00 UTC
const NOW = Date.parse("2026-11-11T12:00:00Z");
const H = 3600_000, D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
const task = (id: string, title: string, m: Record<string, unknown>, tags = ["task"]): Note => ({ id, path: `Tasks/${title}`, tags, updatedAt: iso(NOW - H), createdAt: iso(NOW - 9 * D), metadata: { state: "open", owner: "aaron", ...m } });
const card = (area: string, name: string, m: Record<string, unknown>): Note => ({ id: `c-${name}`, path: `Cards/${area}/${name}`, tags: ["card"], metadata: { schema: "card/1", name, area, status: "active", private: false, lines: [], ...m } });
const PLACES: Record<string, Place> = {
  "Areas/Kiln Studio": { area: "Kiln Studio", room: "kiln-studio", private: false },
  "Areas/North Field": { area: "North Field", room: "north-field", private: false },
  "Projects/Glaze Tests": { area: "Kiln Studio", room: "glaze-tests", private: false },
  "Areas/Sanctum": { area: "Sanctum", room: "sanctum", private: true, areaPath: "Areas/Sanctum" },
};
const placeOf = (n: string): Place => PLACES[n] ?? { area: null, room: null, private: false };
const view = (asks: Note[], cards: Note[] = [], extra: Partial<Parameters<typeof forYou>[0]> = {}) => forYou({ asks, cards, placeOf, me: "aaron", now: NOW, lastLooked: null, ...extra });
const GLAZE = card("Kiln Studio", "Glaze Tests", { project: "Projects/Glaze Tests", stands: "Twelve tiles fired.", stands_at: iso(NOW - 2 * H), hill: { pos: 64 },
  lines: [{ run: "r2", at: iso(NOW - 3 * H), ended: iso(NOW - 2 * H), text: "The tiles came out." }, { run: "r1", at: iso(NOW - 3 * D), text: "Mixed glazes." }] });

check("the default's date in a few words, in the device's time", () => {
  assert.equal(whenLabel("2026-11-13T17:00:00Z", NOW), "Fri 5pm");
  assert.equal(whenLabel("2026-11-11T17:30:00Z", NOW), "today 5:30pm");
  assert.equal(whenLabel("2026-11-12T09:00:00Z", NOW), "tomorrow 9am");
  assert.equal(whenLabel("2026-11-20", NOW), "Nov 20");
  assert.equal(whenLabel("2026-11-14", NOW), "Sat");
  assert.equal(whenLabel("2026-11-05T12:00:00Z", NOW), "Nov 5 12pm");
  assert.equal(whenLabel(null, NOW), null);
  assert.equal(whenLabel("soon", NOW), null);
});

check("an item: where (card · area), what, why now, the default with its date, the other options, the footer under the card's post", () => {
  const v = view([task("a", "T-501 Pick the glaze", { node: "Areas/Kiln Studio", kind: "choose", options: ["Celadon", "Tenmoku"], default: "Celadon", default_at: "2026-11-13T17:00:00Z",
    card: "[[Cards/Kiln Studio/Glaze Tests]]", why_now: "Tiles go in Friday.", reply_room: "#kiln-studio", reply_root: "ev1" })], [GLAZE]);
  const i = v.yours[0];
  assert.equal(i.tid, "T-501");
  assert.equal(i.where.label, "Glaze Tests · Kiln Studio");
  assert.equal(i.where.cardPath, "Cards/Kiln Studio/Glaze Tests");
  assert.equal(i.what, "Pick the glaze");
  assert.equal(i.why, "Tiles go in Friday.");
  assert.deepEqual(i.default, { value: "Celadon", at: "2026-11-13T17:00:00Z", label: "Celadon · Fri 5pm" });
  assert.deepEqual(i.options, ["Tenmoku"]);
  assert.equal(i.action, null);
  assert.equal(i.footer, "Goes to #kiln-studio, under Glaze Tests's post");
  assert.equal(i.replyRoot, "ev1");
});

check("no card: the node's area is where; no default: none shown, the plain action instead; the footer names the node's room", () => {
  const v = view([task("b", "T-502 Sign the note", { node: "Areas/North Field", kind: "do", no_default: true }), task("c", "T-503 Know this", { node: "Areas/North Field", kind: "tell", default: "x", no_default: true })]);
  const [b, c] = [v.yours.find((x) => x.id === "b")!, v.yours.find((x) => x.id === "c")!];
  assert.equal(b.where.label, "North Field");
  assert.equal(b.default, null);
  assert.equal(b.action, "Done");
  assert.equal(b.footer, "Goes to #north-field");
  assert.equal(c.default, null, "no_default wins over a stray default");
  assert.equal(c.action, "Got it");
});

check("the room an answer goes to: reply_room, else the ask's room, else its node's; none at all says so", () => {
  assert.equal(view([task("a", "T-1 x", { node: "Areas/Kiln Studio", room: "glaze-tests" })]).yours[0].replyRoom, "glaze-tests");
  assert.equal(view([task("a", "T-1 x", { node: "Areas/Kiln Studio", room: "glaze-tests", reply_room: "north-field" })]).yours[0].replyRoom, "north-field");
  const none = view([task("a", "T-1 x", { node: "Elsewhere" })]).yours[0];
  assert.equal(none.replyRoom, null);
  assert.equal(none.footer, "No room to send it to");
  // a reply_root with no card still says whose post
  assert.equal(view([task("a", "T-1 x", { node: "Areas/Kiln Studio", reply_root: "ev" })]).yours[0].footer, "Goes to #kiln-studio, in its thread");
});

check("Yours: earliest default first, then the oldest asked; five shown, the rest behind N more", () => {
  const at = (d: number) => iso(NOW + d * D);
  const asks = [
    task("n1", "T-11 no default, asked long ago", { node: "Areas/North Field", no_default: true, asked_at: at(-9) }),
    task("d3", "T-12 default in three days", { node: "Areas/North Field", default: "x", default_at: at(3) }),
    task("d1", "T-13 default tomorrow", { node: "Areas/North Field", default: "x", default_at: at(1) }),
    task("n2", "T-14 no default, asked lately", { node: "Areas/North Field", no_default: true, asked_at: at(-1) }),
    task("d2", "T-15 default in two days", { node: "Areas/North Field", default: "x", default_at: at(2) }),
    task("n3", "T-16 no default, asked midway", { node: "Areas/North Field", no_default: true, asked_at: at(-4) }),
    task("d9", "T-17 default much later", { node: "Areas/North Field", default: "x", default_at: at(9) }),
  ];
  const v = view(asks);
  assert.deepEqual(v.yours.map((i) => i.id), ["d1", "d2", "d3", "d9", "n1"]);
  assert.deepEqual(v.more.map((i) => i.id), ["n3", "n2"]);
  assert.equal(v.count, 7);
  assert.equal(view(asks, [], { cap: 3 }).more.length, 4);
});

check("only Aaron's live, unanswered asks: a room's own task, a done one, an answered one, a snoozed or someday one stay out", () => {
  const v = view([
    task("mine", "T-1 mine", { node: "Areas/North Field" }),
    task("waits", "T-2 waits on me", { node: "Areas/North Field", owner: "room:north-field", waiting_on: "person:Aaron" }),
    task("room", "T-3 the room's", { node: "Areas/North Field", owner: "room:north-field" }),
    task("done", "T-4 done", { node: "Areas/North Field", state: "done" }),
    task("ans", "T-5 answered", { node: "Areas/North Field", answered_at: iso(NOW - H) }),
    task("snz", "T-6 snoozed", { node: "Areas/North Field", snoozed_until: "2026-11-20" }),
    task("snz0", "T-7 snooze over", { node: "Areas/North Field", snoozed_until: "2026-11-10" }),
    task("some", "T-8 someday", { node: "Areas/North Field", priority: "someday" }),
    task("sup", "T-9 replaced", { node: "Areas/North Field", superseded_by: "T-10" }),
  ]);
  assert.deepEqual(v.yours.map((i) => i.id).sort(), ["mine", "snz0", "waits"]);
});

check("look asks are Ready to look at, not Yours; their action is Seen it, their link kept", () => {
  const v = view([task("l", "T-20 Look at the photos", { node: "Areas/Kiln Studio", kind: "look", no_default: true, link: "https://example.com/p" }), task("y", "T-21 x", { node: "Areas/Kiln Studio" })]);
  assert.deepEqual(v.look.map((i) => i.id), ["l"]);
  assert.deepEqual(v.yours.map((i) => i.id), ["y"]);
  assert.equal(v.look[0].action, "Seen it");
  assert.equal(v.look[0].link, "https://example.com/p");
  assert.equal(v.count, 1, "the count is what is yours");
});

check("old decisions: open ones are Yours with no default, their area as where, their options; a decision-only note under tag task is kept once", () => {
  const dec: Note = { ...task("dq", "Choose the hive paint", { node: "Areas/North Field", options: ["White", { label: "Pale yellow" }], owner: "room:x" }, ["decision"]), path: "Decisions/Choose the hive paint" };
  const v = view([dec, dec, task("decided", "Old one", { node: "Areas/North Field", state: "decided" }, ["decision"])]);
  assert.equal(v.yours.length, 1);
  const i = v.yours[0];
  assert.equal(i.legacy, true);
  assert.equal(i.kind, "decision");
  assert.equal(i.default, null);
  assert.deepEqual(i.options, ["White", "Pale yellow"]);
  assert.equal(i.where.label, "North Field");
  assert.equal(i.tid, null);
  assert.equal(answerBody(i, "White"), "Choose the hive paint: White");
});

check("a new-style decision (task + decision) is a choose ask, answered as one", () => {
  const v = view([task("nd", "T-40 Which van", { node: "Areas/North Field", options: ["Red", "Blue"], default: "Red", default_at: iso(NOW + D) }, ["task", "decision"])]);
  assert.equal(v.yours[0].kind, "choose");
  assert.equal(v.yours[0].legacy, false);
  assert.deepEqual(v.yours[0].options, ["Blue"]);
});

check("private: an ask in a private area or on a private card is a count by place, none of its words", () => {
  const priv = card("Sanctum", "daily practice", { private: true, area_node: "Areas/Sanctum", stands: "words that must not show", hill: { pos: 40 }, lines: [{ at: iso(NOW - H), text: "A session on daily practice: completed." }] });
  const v = view([
    task("p1", "T-50 Private words here", { node: "Areas/Sanctum" }),
    task("p2", "T-51 More private words", { node: "Areas/North Field", card: "Cards/Sanctum/daily practice" }),
  ], [priv]);
  assert.deepEqual(v.yours, []);
  assert.deepEqual(v.privates, [{ area: "Sanctum", node: "Areas/Sanctum", areaPath: "Areas/Sanctum", count: 2 }]);
  assert.equal(v.count, 2);
  assert.ok(!JSON.stringify(v.privates).includes("Private words"));
  const c = v.cards.get("Cards/Sanctum/daily practice")!;
  assert.equal(c.stands, null);
  assert.equal(c.hill, null);
  // its line only as stored
  assert.deepEqual(v.moving.map((m) => [m.text, m.private]), [["A session on daily practice: completed.", true]]);
});

check("Moving: card lines since he last looked, newest first; quiet cards counted, resting apart, retired not at all", () => {
  const cards = [
    GLAZE,
    card("North Field", "Gate Path", { lines: [{ at: iso(NOW - 5 * D), text: "Measured." }] }),
    card("North Field", "Hedge", { lines: [] }),
    card("Choir", "Winter Set", { status: "resting", lines: [{ at: iso(NOW - 9 * D), text: "Printed." }] }),
    card("Choir", "Old Set", { status: "retired", lines: [{ at: iso(NOW - H), text: "Never shown." }] }),
    card("Bee Garden", "Honey", { lines: [{ at: iso(NOW - 30 * 60_000), text: "Weighed hive two." }] }),
  ];
  const v = view([], cards);
  assert.deepEqual(v.moving.map((m) => [m.card, m.text]), [["Honey", "Weighed hive two."], ["Glaze Tests", "The tiles came out."]]);
  assert.deepEqual([v.quiet.quiet, v.quiet.resting, v.quiet.line], [2, 1, "2 cards quiet, 1 resting"]);
  // looked an hour ago: only the newest line; the glaze card is quiet now
  const later = view([], cards, { lastLooked: NOW - H });
  assert.deepEqual(later.moving.map((m) => m.card), ["Honey"]);
  assert.equal(later.quiet.line, "3 cards quiet, 1 resting");
  assert.equal(quietLine(1, 0), "1 card quiet");
  assert.equal(quietLine(0, 0), "");
});

check("a card: stands, the hill in words, the lines newest first", () => {
  const c = cardView(GLAZE)!;
  assert.equal(c.name, "Glaze Tests");
  assert.equal(c.stands, "Twelve tiles fired.");
  assert.deepEqual(c.hill, { pos: 64, words: "Downhill, 64", stuck: false });
  assert.deepEqual(c.lines.map((l) => l.text), ["The tiles came out.", "Mixed glazes."]);
  assert.equal(hillWords(30), "Uphill, 30");
  assert.equal(hillWords(100), "Done");
});

check("answering: the close's metadata (decided too for a choose pick) and the room's words", () => {
  const at = "2026-11-11T12:00:00.000Z";
  assert.deepEqual(answerMeta({ kind: "choose", options: ["Tenmoku"], default: { value: "Celadon", at: null, label: "" } }, "Celadon", "aaron", at),
    { answer: "Celadon", answered_at: at, answered_by: "aaron", decided: "Celadon", decided_at: at, decided_by: "aaron" });
  // a choose ask answered in his own words is an answer, not a pick
  assert.deepEqual(Object.keys(answerMeta({ kind: "choose", options: ["Tenmoku"], default: null }, "Neither, wait a week", "aaron", at)).sort(), ["answer", "answered_at", "answered_by"]);
  assert.deepEqual(Object.keys(answerMeta({ kind: "do", options: [], default: null }, "Done", "aaron", at)).sort(), ["answer", "answered_at", "answered_by"]);
  assert.equal(answerBody({ tid: "T-501", what: "Pick" }, " Celadon "), "T-501: Celadon");
  assert.deepEqual(splitTitle("Tasks/T-77b Fix it"), { tid: "T-77B", rest: "Fix it" });
});

check("answered on this device: gone from the bands at once, listed today only", () => {
  const asks = [task("a", "T-1 One", { node: "Areas/North Field" }), task("b", "T-2 Two", { node: "Areas/North Field" })];
  const v = view(asks, [], { answered: [{ id: "a", what: "One", answer: "Done", at: NOW - H, room: "north-field", post: "sent" }, { id: "z", what: "Yesterday", answer: "x", at: NOW - 2 * D, room: null, post: "sent" }] });
  assert.deepEqual(v.yours.map((i) => i.id), ["b"]);
  assert.deepEqual(v.answered.map((a) => a.id), ["a"]);
  // a post still owed to its room keeps its line (and Retry) past midnight
  const owed = view(asks, [], { answered: [{ id: "y", what: "Late", answer: "x", at: NOW - 20 * H, room: "north-field", post: "failed", error: "relay down" }] });
  assert.deepEqual(owed.answered.map((a) => a.id), ["y"]);
});

check("a tag: task read keeps only tasks (decision is becoming a child of task); a task + decision note is a task closed by done", () => {
  const rows = [{ id: "t", tags: ["task"] }, { id: "d", tags: ["decision"] }, { id: "td", tags: ["task", "decision"] }, { id: "x" }];
  assert.deepEqual(rows.filter(isTaskRow).map((r) => r.id), ["t", "td", "x"]);
  const tree = buildTaskTree([]);
  const nd = parseTask({ id: "td", path: "Tasks/T-40 Which van", tags: ["task", "decision"], metadata: { state: "done", node: "Uni", kind: "choose" } }, tree)!;
  assert.equal(nd.kind, "task");
  assert.equal(nd.state, "done");
  assert.equal(nd.raw?.metadata.kind, "choose");
  const old = parseTask({ id: "d", path: "Decisions/Old", tags: ["decision"], metadata: { state: "decided", node: "Uni" } }, tree)!;
  assert.equal(old.kind, "decision");
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall For you checks passed");
