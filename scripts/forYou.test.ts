// 0.3.0 For you: the one data module (src/foryou/forYouCore.ts), notes in, view out. Made-up asks and cards only.
// Run: node --experimental-strip-types scripts/forYou.test.ts
process.env.TZ = "UTC";
import assert from "node:assert/strict";
import { buildTaskTree, isTaskRow, parseTask } from "../src/areas/taskCore.ts";
import { answerBody, answerMeta, areaCards, awayLine, cardItems, cardLines, cardMark, cardOfMessage, cardView, forYou, hillWords, quietLine, splitTitle, waitsWords, whenLabel, type Note, type Place } from "../src/foryou/forYouCore.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n").slice(0, 6).join("\n     ")}`); }
}

// Wednesday 2026-11-11, 12:00 UTC
const NOW = Date.parse("2026-11-11T12:00:00Z");
const H = 3600_000, D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
const task = (id: string, title: string, m: Record<string, unknown>, tags = ["task"]): Note => ({ id, path: `Tasks/${title}`, tags, updatedAt: iso(NOW - H), createdAt: iso(NOW - 9 * D), metadata: { state: "open", owner: "aaron", asked_at: iso(NOW - H), ...m } });
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

check("the room an answer goes to: reply_room, else the ask's room, else its node's; with no live room at all it is not in For you", () => {
  assert.equal(view([task("a", "T-1 x", { node: "Areas/Kiln Studio", room: "glaze-tests" })]).yours[0].replyRoom, "glaze-tests");
  assert.equal(view([task("a", "T-1 x", { node: "Areas/Kiln Studio", room: "glaze-tests", reply_room: "north-field" })]).yours[0].replyRoom, "north-field");
  const none = view([task("a", "T-1 x", { node: "Elsewhere" })]);
  assert.deepEqual(none.yours, []);
  assert.equal(none.away, 1);
  // a reply_root with no card still says whose post
  assert.equal(view([task("a", "T-1 x", { node: "Areas/Kiln Studio", reply_root: "ev" })]).yours[0].footer, "Goes to #kiln-studio, in its thread");
});

check("Yours: earliest default first, then the oldest asked; five shown, the rest behind N more", () => {
  const at = (d: number) => iso(NOW + d * D);
  const asks = [
    task("n1", "T-11 no default, asked long ago", { node: "Areas/North Field", no_default: true, asked_at: at(-6) }),
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

// ------------------------------------------------------------------ 0.3.2: the card itself
check("a card's lines: his own answers marked (by the line's author, its status, or his name before the words), the name dropped", () => {
  const c = cardView(card("Kiln Studio", "Glaze Tests", { lines: [
    { run: "r3", at: iso(NOW - H), text: "Aaron: Use the cracked pot for tests." },
    { at: iso(NOW - 2 * H), by: "aaron", text: "Keep the shelf clear." },
    { at: iso(NOW - 3 * H), status: "answer", text: "Celadon" },
    { run: "r2", at: iso(NOW - 4 * H), text: "Aaronson's kiln: fired the second load." },
    { run: "r1", at: iso(NOW - 5 * H), by: "uni", text: "Mixed glazes." },
  ], threads: ["test tiles", { name: "shelf order" }], open_asks: ["T-501"], last_session_at: iso(NOW - H) }), "aaron")!;
  assert.deepEqual(c.lines.map((l) => [l.text, l.mine]), [["Use the cracked pot for tests.", true], ["Keep the shelf clear.", true], ["Celadon", true],
    ["Aaronson's kiln: fired the second load.", false], ["Mixed glazes.", false]]);
  assert.deepEqual(c.threads, ["test tiles", "shelf order"]);
  assert.deepEqual(c.openAsks, ["T-501"]);
  assert.equal(c.lastAt, iso(NOW - H));
});

check("an answer given here shows on its card at once, as his line, until the card's own line says it", () => {
  const c = cardView(GLAZE)!;
  const a = { id: "g", what: "Pick the glaze", answer: "Celadon", at: NOW - 60_000, room: "kiln-studio", post: "sent" as const, card: "Cards/Kiln Studio/Glaze Tests" };
  const other = { ...a, id: "o", answer: "Elsewhere", card: "Cards/North Field/Gate" };
  assert.deepEqual(cardLines(c, [a, other]).map((l) => [l.text, l.mine]), [["Celadon", true], ["The tiles came out.", false], ["Mixed glazes.", false]]);
  const back = cardView(card("Kiln Studio", "Glaze Tests", { lines: [{ at: iso(NOW - 30_000), text: "Aaron: celadon." }] }))!;
  assert.deepEqual(cardLines(back, [a]).map((l) => l.text), ["celadon."]);
});

check("a card's mark by shape: his, ready to look at, moving, resting; a private card's asks by count only", () => {
  const glaze = task("g", "T-1 Pick the glaze", { node: "Areas/Kiln Studio", kind: "choose", card: "Cards/Kiln Studio/Glaze Tests", options: ["A", "B"], no_default: true });
  const photos = task("p", "T-2 Look at the photos", { node: "Areas/Kiln Studio", kind: "look", card: "Cards/Kiln Studio/Shelves", no_default: true });
  const quiet = task("q", "T-3 Private words", { node: "Areas/Sanctum", kind: "tell", card: "Cards/Sanctum/practice", no_default: true });
  const cards = [GLAZE, card("Kiln Studio", "Shelves", { area_node: "Areas/Kiln Studio" }), card("Kiln Studio", "Clay", { status: "resting", area_node: "Areas/Kiln Studio" }),
    card("Kiln Studio", "Wheel", { area_node: "Areas/Kiln Studio", last_session_at: iso(NOW - D) }), card("Kiln Studio", "Kiln", { area_node: "Areas/Kiln Studio", last_session_at: iso(NOW - H) }),
    card("Sanctum", "practice", { private: true, area_node: "Areas/Sanctum", open_asks: ["T-3"], threads: ["practice"] })];
  const v = view([glaze, photos, quiet], cards.map((c) => ({ ...c, metadata: { area_node: `Areas/${(c.metadata as any).area}`, ...(c.metadata as any) } })));
  const mark = (p: string) => cardMark(v, v.cards.get(p)!);
  assert.equal(mark("Cards/Kiln Studio/Glaze Tests"), "yours");
  assert.equal(mark("Cards/Kiln Studio/Shelves"), "look");
  assert.equal(mark("Cards/Kiln Studio/Wheel"), "moving");
  assert.equal(mark("Cards/Kiln Studio/Clay"), "rest");
  assert.equal(mark("Cards/Sanctum/practice"), "yours");
  // the asks shown on a card: its own; a private card's none (counted)
  assert.deepEqual(cardItems(v, v.cards.get("Cards/Kiln Studio/Glaze Tests")!).map((i) => i.id), ["g"]);
  assert.deepEqual(cardItems(v, v.cards.get("Cards/Sanctum/practice")!), []);
  assert.equal(waitsWords(1), "1 thing waits on you");
  assert.equal(waitsWords(3), "3 things wait on you");
  // an area's cards: active first (his, to look at, then moving by the newest session), resting apart
  const k = areaCards(v, "Areas/Kiln Studio");
  assert.deepEqual(k.active.map((c) => [c.card.name, c.mark]), [["Glaze Tests", "yours"], ["Shelves", "look"], ["Kiln", "moving"], ["Wheel", "moving"]]);
  assert.deepEqual(k.resting.map((c) => c.card.name), ["Clay"]);
  // a project's own card is its place's too
  assert.deepEqual(areaCards(v, "Projects/Glaze Tests").active.map((c) => c.card.name), ["Glaze Tests"]);
  assert.deepEqual(areaCards(v, "Areas/North Field"), { active: [], resting: [] });
});

check("which card a room's message is about: the post its asks thread under, a reply in it, or the card's name first, in its area's rooms", () => {
  const glaze = task("g", "T-1 Pick the glaze", { node: "Areas/Kiln Studio", kind: "choose", card: "Cards/Kiln Studio/Glaze Tests", options: ["A", "B"], no_default: true, reply_root: "post-1" });
  const cards = [{ ...GLAZE, metadata: { ...(GLAZE.metadata as any), area_node: "Areas/Kiln Studio" } }, card("Kiln Studio", "Glaze", { area_node: "Areas/Kiln Studio" }),
    card("Sanctum", "practice", { private: true, area_node: "Areas/Sanctum" })];
  const v = view([glaze], cards);
  const of = (m: { ref: string; root?: string | null; body: string }, room: string | null) => cardOfMessage(v, m, room)?.name ?? null;
  assert.equal(of({ ref: "post-1", body: "Anything at all." }, null), "Glaze Tests");
  assert.equal(of({ ref: "r9", root: "post-1", body: "A reply." }, "Areas/North Field"), "Glaze Tests");
  // by name: the longest card name that opens the message, in a room of the card's area (or a place inside it)
  assert.equal(of({ ref: "m1", body: "Glaze Tests: the tiles are out. 1 for you: pick the glaze." }, "Areas/Kiln Studio"), "Glaze Tests");
  assert.equal(of({ ref: "m2", body: "**Glaze Tests**\nThe tiles are out." }, "Areas/Kiln Studio/Glaze Tests"), "Glaze Tests");
  assert.equal(of({ ref: "m3", body: "Glaze: mixed." }, "Areas/Kiln Studio"), "Glaze");
  assert.equal(of({ ref: "m4", body: "Glaze Tests went well today." }, "Areas/Kiln Studio"), null);
  assert.equal(of({ ref: "m5", body: "Glaze Tests: out." }, "Areas/North Field"), null);
  // never a private card
  assert.equal(of({ ref: "m6", body: "practice: done." }, "Areas/Sanctum"), null);
});

check("a card filed in a private area is private without its flag; a private card's answers are marked, never in his words", () => {
  const stray = card("Sanctum", "evening walk", { area_node: "Areas/Sanctum", stands: "Words that must stay inside.", hill: { pos: 40 },
    lines: [{ at: iso(NOW - H), text: "Aaron: my own private words." }, { at: iso(NOW - 2 * H), text: "A session on evening walk: completed." }] });
  const c = view([], [stray]).cards.get("Cards/Sanctum/evening walk")!;
  assert.equal(c.private, true);
  assert.equal(c.stands, null);
  assert.equal(c.hill, null);
  assert.deepEqual(c.lines.map((l) => [l.text, l.mine]), [["answered.", true], ["A session on evening walk: completed.", false]]);
  assert.ok(!JSON.stringify(c).includes("private words"));
});

check("review: a named author rules; an old answer in the same words doesn't hide a new one; live private counts; a project in a private place", () => {
  const c = cardView(card("Kiln Studio", "Glaze Tests", { lines: [
    { at: iso(NOW - H), by: "maya", status: "answer", text: "Use the kiln on Friday." },
    { at: iso(NOW - 2 * H), by: "uni", text: "Aaron: asked for blue." },
    { at: iso(NOW - 7 * D), text: "Aaron: Done" },
  ] }))!;
  assert.deepEqual(c.lines.map((l) => l.mine), [false, false, true]);
  assert.equal(c.lines[1].text, "Aaron: asked for blue.");
  const now = { id: "d", what: "Shelf", answer: "Done", at: NOW - 60_000, room: "kiln-studio", post: "sent" as const, card: "Cards/Kiln Studio/Glaze Tests" };
  assert.deepEqual(cardLines(c, [now]).map((l) => l.text).slice(0, 1), ["Done"]);
  assert.equal(cardLines(c, [now]).filter((l) => l.text === "Done").length, 2);
  // a private card's mark and count follow the live asks, not the note's stored list
  const priv = card("Sanctum", "practice", { private: true, area_node: "Areas/Sanctum", open_asks: ["T-3", "T-4"] });
  const v0 = view([], [priv]);
  assert.equal(cardMark(v0, v0.cards.get("Cards/Sanctum/practice")!), "moving");
  const live = task("q", "T-3 Private words", { node: "Areas/Sanctum", kind: "tell", card: "Cards/Sanctum/practice", no_default: true });
  const v1 = view([live], [priv]);
  assert.equal(cardMark(v1, v1.cards.get("Cards/Sanctum/practice")!), "yours");
  assert.equal(v1.privateCards.get("Cards/Sanctum/practice"), 1);
  // a card whose project sits in a private place is private
  const proj = card("Kiln Studio", "Quiet Project", { project: "Areas/Sanctum", stands: "Inside words." });
  assert.equal(view([], [proj]).cards.get("Cards/Kiln Studio/Quiet Project")!.stands, null);
});

// T-335 fresh (11-08): For you shows only what is live and fresh
check("an ask naming an archived room resolves to the live one: its footer and its answer never name the dead room", () => {
  // the relay lists only live rooms; an archived room's work went to its fallback (a node's room_fallback)
  const liveRoom = (name: string) => ({ "north-field": "north-field", "kiln-studio": "kiln-studio", "old-hall": "north-field" } as Record<string, string>)[name.toLowerCase()] ?? null;
  const v = view([
    task("a", "T-701 Old hall ask", { node: "Areas/North Field", kind: "do", no_default: true, room: "Old-Hall" }),
    task("b", "T-702 Dead reply room", { node: "Areas/Kiln Studio", kind: "do", no_default: true, reply_room: "gone-room" }),
    task("c", "T-703 Root ask", { node: "", kind: "do", no_default: true, room: "gone-room" }),
  ], [], { liveRoom });
  const by = (id: string) => [...v.yours, ...v.more].find((i) => i.id === id);
  assert.equal(by("a")?.replyRoom, "north-field");
  assert.equal(by("a")?.footer, "Goes to #north-field");
  assert.equal(by("b")?.replyRoom, "kiln-studio", "a dead reply_room falls to the node's live room");
  assert.equal(by("c"), undefined, "no live room anywhere: not in For you");
  assert.ok(!JSON.stringify([...v.yours, ...v.more, ...v.look]).match(/old-hall|gone-room/i));
  assert.equal(v.away, 1);
});

check("an 8-day-old unconfirmed ask is not in Yours, only counted as waiting on its room; a re-confirmed one shows", () => {
  const v = view([
    task("old", "T-711 Asked long ago", { node: "Areas/North Field", kind: "do", no_default: true, asked_at: iso(NOW - 8 * D) }),
    task("conf", "T-712 Asked long ago, confirmed", { node: "Areas/North Field", kind: "do", no_default: true, asked_at: iso(NOW - 20 * D), confirmed_at: iso(NOW - 2 * D) }),
    task("look", "T-713 Old film", { node: "Areas/North Field", kind: "look", no_default: true, asked_at: iso(NOW - 10 * D) }),
    task("nodate", "T-714 Never stamped", { node: "Areas/North Field", kind: "do", no_default: true, asked_at: null }),
    task("priv", "T-715 Old private", { node: "Areas/Sanctum", kind: "do", no_default: true, asked_at: iso(NOW - 9 * D) }),
  ]);
  assert.deepEqual([...v.yours, ...v.more].map((i) => i.id), ["conf"]);
  assert.deepEqual(v.look, []);
  assert.deepEqual(v.privates, []);
  assert.equal(v.away, 4, "the old ask, the old look, the never-stamped one (created 9 days ago) and the old private one");
  assert.equal(v.count, 1, "the head counts only what is his now");
  assert.equal(awayLine(v.away), "4 waiting on their rooms");
  assert.equal(awayLine(1), "1 waiting on its room");
  assert.equal(awayLine(0), "");
});

check("only live places: an ask on an archived or resting node (or area) is not in For you", () => {
  const placeOf2 = (n: string): Place => n === "Projects/Shelved" ? { area: "North Field", room: "north-field", private: false, live: false } : placeOf(n);
  const v = view([task("s", "T-721 Shelved thing", { node: "Projects/Shelved", kind: "do", no_default: true }), task("k", "T-722 Kept", { node: "Areas/North Field", kind: "do", no_default: true })], [], { placeOf: placeOf2 });
  assert.deepEqual(v.yours.map((i) => i.id), ["k"]);
  assert.equal(v.away, 1);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall For you checks passed");

// review 11-07: an ask on a card that isn't read yet (or can't be) is counted, never shown: the card may be private
{
  const v = view([task("a9", "T-9 Pick the glaze", { kind: "choose", options: ["Celadon", "Tenmoku"], why_now: "secret-ish why", card: "Cards/Kiln Studio/Unread Card", node: "Projects/Glaze Tests" })], [GLAZE]);
  assert.equal(v.yours.length, 0);
  assert.ok(!JSON.stringify(v).includes("secret-ish why"));
  assert.equal(v.privates.reduce((n, p) => n + p.count, 0), 1);
  console.log("ok   an ask whose card isn't read yet is only counted");
}
