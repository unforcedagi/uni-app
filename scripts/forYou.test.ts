// 0.3.0 For you: the one data module (src/foryou/forYouCore.ts), notes in, view out. Made-up asks and cards only.
// Run: node --experimental-strip-types scripts/forYou.test.ts
process.env.TZ = "UTC";
import assert from "node:assert/strict";
import { buildTaskTree, isTaskRow, parseTask } from "../src/areas/taskCore.ts";
import { parseArea, parseProject } from "../src/areas/areasCore.ts";
import { buildTree } from "../src/areas/treeCore.ts";
import { splitMarkdownLinks } from "../src/areas/linkText.ts";
import { askContext, contextLine, seenBody, seenCloses, seenMeta, answerBody, answerMeta, areaCards, awayLine, placeDormant, treeDormant, type PlaceNote, cardItems, cardLines, cardMark, cardOfMessage, cardView, forYou, hillWords, quietLine, splitTitle, waitsWords, whenLabel, type Note, type Place } from "../src/foryou/forYouCore.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n").slice(0, 6).join("\n     ")}`); }
}

// Wednesday 2026-11-11, 12:00 UTC
const NOW = Date.parse("2026-11-11T12:00:00Z");
const H = 3600_000, D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
// T-335 one home: an ask's needs_aaron is uni-tasks' word (the one rule); these asks are fresh and open, so it wrote true, unless a test says
const task = (id: string, title: string, m: Record<string, unknown>, tags = ["task"]): Note => ({ id, path: `Tasks/${title}`, tags, updatedAt: iso(NOW - H), createdAt: iso(NOW - 9 * D), metadata: { state: "open", owner: "aaron", asked_at: iso(NOW - H), needs_aaron: true, needs_aaron_why: "yes", ...m } });
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
  assert.equal(c.action, null, "T-335 Seen: a tell ask's one tap is Seen (it closes), not a second Got it");
});

check("the room an answer goes to: reply_room, else the ask's room, else its node's; with none found here, the footer says so", () => {
  assert.equal(view([task("a", "T-1 x", { node: "Areas/Kiln Studio", room: "glaze-tests" })]).yours[0].replyRoom, "glaze-tests");
  assert.equal(view([task("a", "T-1 x", { node: "Areas/Kiln Studio", room: "glaze-tests", reply_room: "north-field" })]).yours[0].replyRoom, "north-field");
  // (an ask with no live room anywhere is uni-tasks' "no room": needs_aaron false, so it never reaches here; one this device can't place yet still shows)
  const none = view([task("a", "T-1 x", { node: "Elsewhere" })], [], { liveRoom: () => null });
  assert.equal(none.yours[0].footer, "No room to send it to");
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

check("T-335 one home: For you is what uni-tasks marked needs_aaron; his asks it handed back are only counted; nothing else is decided here", () => {
  const no = (why: string) => ({ needs_aaron: false, needs_aaron_why: why });
  const v = view([
    task("mine", "T-1 mine", { node: "Areas/North Field" }),
    task("waits", "T-2 waits on me", { node: "Areas/North Field", owner: "room:north-field", waiting_on: "person:Aaron" }),
    task("room", "T-3 the room's", { node: "Areas/North Field", owner: "room:north-field", ...no("not his") }),
    task("ans", "T-5 answered", { node: "Areas/North Field", answered_at: iso(NOW - H), ...no("answered") }),
    task("snz", "T-6 snoozed", { node: "Areas/North Field", snoozed_until: "2026-11-20", ...no("snoozed") }),
    task("some", "T-8 someday", { node: "Areas/North Field", priority: "someday", ...no("someday") }),
    task("stale", "T-11 old", { node: "Areas/North Field", asked_at: iso(NOW - 8 * D), ...no("stale") }),
    task("nocard", "T-12 on no card", { node: "Areas/North Field", ...no("no card") }),
    task("rest", "T-13 resting place", { node: "Areas/North Field", ...no("resting") }),
    task("noroom", "T-14 no room", { node: "Areas/North Field", ...no("no room") }),
    task("unswept", "T-15 not swept yet", { node: "Areas/North Field", needs_aaron: undefined, needs_aaron_why: undefined }),
  ]);
  assert.deepEqual(v.yours.map((i) => i.id).sort(), ["mine", "waits"]);
  assert.equal(v.away, 4, "stale, on no card, in a resting place, with no room: back with their rooms");
  assert.equal(v.count, 2);
  assert.equal(awayLine(v.away), "4 waiting on their rooms");
  assert.equal(awayLine(1), "1 waiting on its room");
  assert.equal(awayLine(0), "");
});

check("look asks are Ready to look at, not Yours; their one tap is Seen (no second action), their link kept", () => {
  const v = view([task("l", "T-20 Look at the photos", { node: "Areas/Kiln Studio", kind: "look", no_default: true, link: "https://example.com/p" }), task("y", "T-21 x", { node: "Areas/Kiln Studio" })]);
  assert.deepEqual(v.look.map((i) => i.id), ["l"]);
  assert.deepEqual(v.yours.map((i) => i.id), ["y"]);
  assert.equal(v.look[0].action, null);
  assert.equal(v.look[0].link, "https://example.com/p");
  assert.equal(v.count, 1, "the count is what is yours");
});

check("T-335 one home: an old Decisions/ note is the record, not an ask: never in For you, whatever it says", () => {
  const dec: Note = { ...task("dq", "Choose the hive paint", { node: "Areas/North Field", options: ["White", { label: "Pale yellow" }], owner: "room:x" }, ["decision"]), path: "Decisions/Choose the hive paint" };
  const v = view([dec, dec, task("decided", "Old one", { node: "Areas/North Field", state: "decided" }, ["decision"])]);
  assert.deepEqual([v.yours.length, v.count, v.away], [0, 0, 0]);
  assert.equal(answerBody({ tid: null, what: "Choose the hive paint" }, "White"), "Choose the hive paint: White");
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
  assert.equal(by("c")?.footer, "No room to send it to", "none found here: said, never a dead room named");
  assert.ok(!JSON.stringify([...v.yours, ...v.more, ...v.look]).match(/old-hall|gone-room/i));
});

check("review 11-08: an ask that names a private room is only counted, however public its node; its words never show", () => {
  const privateRoom = (name: string) => name.toLowerCase() === "sanctum" || name.toLowerCase() === "old-cellar";
  const v = view([task("pr", "T-731 Cellar words", { node: "Areas/North Field", kind: "do", no_default: true, room: "old-cellar", why_now: "inner words" }),
    task("pk", "T-732 Kept", { node: "Areas/North Field", kind: "do", no_default: true })], [], { privateRoom });
  assert.deepEqual(v.yours.map((i) => i.id), ["pk"]);
  assert.equal(v.privates.reduce((n, p) => n + p.count, 0), 1);
  assert.ok(!JSON.stringify(v).includes("inner words"));
});

check("review 11-08: a place isn't live when it, or every area it is linked to, is archived, resting or done (archived areas included)", () => {
  const n = (id: string, path: string, kind: string, status: string, more: Partial<PlaceNote> = {}): PlaceNote => ({ id, path, kind, status: status === "resting" ? "background" : status, metadata: { status }, ...more });
  const all = [n("a1", "Areas/Old Shed", "area", "archived"), n("a2", "Areas/North Field", "area", "foreground"), n("a3", "Areas/Quiet Wood", "area", "resting"),
    n("p1", "Projects/Shed Work", "project", "foreground", { links: ["Areas/Old Shed"] }),
    n("p2", "Projects/Both", "project", "foreground", { links: ["[[Areas/Old Shed]]", "a2"] }),
    n("p3", "Projects/Wood Walk", "project", "foreground", { parent: "Areas/Quiet Wood" }),
    n("p4", "Projects/Paused", "project", "resting"),
    { ...n("a4", "Areas/Linker", "area", "archived"), links: ["p5"] }, n("p5", "Projects/Linked Back", "project", "foreground"),
    n("p6", "Projects/Loose", "project", "foreground")];
  assert.equal(placeDormant(all, "Projects/Shed Work"), true, "linked only to an archived area");
  assert.equal(placeDormant(all, "p2"), false, "one live area keeps it live");
  assert.equal(placeDormant(all, "Projects/Wood Walk"), true, "its area is resting");
  assert.equal(placeDormant(all, "p4"), true);
  assert.equal(placeDormant(all, "p5"), true, "an archived area that links to it");
  assert.equal(placeDormant(all, "p6"), false, "no area at all: live");
  assert.equal(placeDormant(all, "Areas/North Field"), false);
  assert.equal(placeDormant(all, "Projects/Unknown"), null);
});

check("review 11-08 (2): through the app's own tree: an archived project, and a project linked only to an archived area, aren't live", () => {
  const a = (id: string, name: string, meta: Record<string, unknown> = {}) => parseArea({ id, path: `Areas/${name}`, tags: ["area"], content: `# ${name}`, metadata: { status: "foreground", ...meta } })!;
  const p = (id: string, name: string, meta: Record<string, unknown> = {}) => parseProject({ id, path: `Projects/${name}`, tags: ["project"], content: `# ${name}`, metadata: meta })!;
  const tree = buildTree([a("a-shed", "Old Shed", { status: "archived" }), a("a-field", "North Field"),
    p("p-shed", "Shed Work", { links: ["a-shed"] }), p("p-gone", "Gone Project", { status: "archived", links: ["a-field"] }), p("p-gate", "Gate Path", { links: ["a-field"] })]);
  assert.equal(treeDormant(tree, "Projects/Shed Work"), true);
  assert.equal(treeDormant(tree, "p-gone"), true);
  assert.equal(treeDormant(tree, "Projects/Gate Path"), false);
});

check("code-review 11-08: no room list yet keeps the asks (never all away); a deep node under a resting area isn't live", () => {
  const none = view([task("n", "T-741 No room known", { node: "Elsewhere", kind: "do", no_default: true })]);
  assert.deepEqual(none.yours.map((i) => i.id), ["n"], "no resolver: shown, saying it has no room");
  assert.equal(none.yours[0].footer, "No room to send it to");
  const n = (id: string, path: string, kind: string, status: string, more: Partial<PlaceNote> = {}): PlaceNote => ({ id, path, kind, status, metadata: { status }, ...more });
  const all = [n("a", "Areas/Quiet Wood", "area", "resting"), n("p", "Projects/Path", "project", "foreground", { parent: "Areas/Quiet Wood" }),
    n("s", "Projects/Path/Sub", "project", "foreground", { parent: "Projects/Path" })];
  assert.equal(placeDormant(all, "Projects/Path/Sub"), true);
});

// T-335 Seen (11-09): "I should really be able to just mark it as seen... to note that I'm aware of it"
check("Seen: a tell or look ask closes; a do or choose ask stays open with its room", () => {
  assert.equal(seenCloses("tell"), true);
  assert.equal(seenCloses("look"), true);
  assert.equal(seenCloses("do"), false);
  assert.equal(seenCloses("choose"), false);
  assert.equal(seenCloses("decision"), false);
});

check("Seen writes seen_at and seen_by and takes it out of For you (needs_aaron false, why seen); never an answer", () => {
  const m = seenMeta("aaron", "2026-11-11T12:00:00.000Z");
  assert.deepEqual(m, { seen_at: "2026-11-11T12:00:00.000Z", seen_by: "aaron", needs_aaron: false, needs_aaron_why: "seen" });
  assert.ok(!("answer" in m), "no answer: the card sync has no words of his to relay");
});

check("Seen tells its room in one quiet line, the same words uni-tasks prints", () => {
  const v = view([task("t", "T-31 Know this", { node: "Areas/North Field", kind: "tell" }), task("d", "T-32 Do this", { node: "Areas/North Field", kind: "do" })]);
  const [t, d] = [v.yours.find((x) => x.id === "t")!, v.yours.find((x) => x.id === "d")!];
  assert.equal(seenBody(t), "T-31: seen.");
  assert.equal(seenBody(d), "T-32: seen. It stays open here until it needs my steer; ask again then.");
});

check("a seen ask leaves For you and its count at once, is never a card line of his, and isn't 'waiting on its room'", () => {
  const asks = [task("d", "T-32 Do this", { node: "Projects/Glaze Tests", kind: "do", card: "Cards/Kiln Studio/Glaze Tests" }), task("y", "T-33 Other", { node: "Areas/North Field" })];
  const before = view(asks, [GLAZE]);
  assert.equal(before.total, 2);
  const seen = { id: "d", what: "Do this", answer: "Seen", at: NOW, room: "glaze-tests", post: "sent" as const, card: "Cards/Kiln Studio/Glaze Tests", seen: true };
  const after = view(asks, [GLAZE], { answered: [seen] });
  assert.deepEqual([...after.yours, ...after.more].map((i) => i.id), ["y"]);
  assert.equal(after.total, 1);
  assert.equal(after.away, 0);
  const c = after.cards.get("Cards/Kiln Studio/Glaze Tests")!;
  assert.ok(!cardLines(c, after.answered).some((l) => l.mine), "Seen is not his words on the card");
  // as the vault holds it after the write (and after the sweep): not counted anywhere
  const stored = view([task("d", "T-32 Do this", { node: "Areas/North Field", kind: "do", seen_at: iso(NOW), needs_aaron: false, needs_aaron_why: "seen" })]);
  assert.equal(stored.total, 0);
  assert.equal(stored.away, 0, "seen is his choice, not an ask that went back to its room");
});

check("a seen ask its room asks again shows again at once (the device's Seen hides only what was seen); an answer still hides its ask", () => {
  const seen = { id: "d", what: "Do this", answer: "Seen", at: NOW - H, room: "north-field", post: "sent" as const, seen: true };
  const reasked = task("d", "T-32 Do this", { node: "Areas/North Field", kind: "do", confirmed_at: iso(NOW - 10 * 60_000) });
  assert.deepEqual(view([reasked], [], { answered: [seen] }).yours.map((i) => i.id), ["d"]);
  // not asked since: still hidden
  const same = task("d", "T-32 Do this", { node: "Areas/North Field", kind: "do", asked_at: iso(NOW - 2 * H) });
  assert.deepEqual(view([same], [], { answered: [seen] }).yours.map((i) => i.id), []);
  // an answer closes its ask: hidden whatever the stamps say until the list catches up
  const answered = { ...seen, seen: undefined, answer: "Done" };
  assert.deepEqual(view([reasked], [], { answered: [answered] }).yours.map((i) => i.id), []);
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

{
  // T-335: the ask's context lives at the end of its own body (tasks.py), or in an older ask's context note: the same sections
  const body = [
    "T-540 Sign the lease for the kiln shed", "", "**Next:** sign it", "",
    "## Why", "The landlord holds the shed until Friday.", "",
    "## Steps", "1. Open the lease (uni:01ABCDEFGHJKMNPQRSTVWXYZ00)", "2. Sign page 3", "",
    "## Links", "- https://example.com/lease", "", "## Time", "About 5 minutes", "",
    "## Already answered", "You said yes to the shed on 11-02.",
  ].join("\r\n");
  const c = askContext(body)!;
  assert.equal(c.why, "The landlord holds the shed until Friday.");
  assert.deepEqual(c.steps, ["Open the lease (uni:01ABCDEFGHJKMNPQRSTVWXYZ00)", "Sign page 3"]);
  assert.deepEqual(c.links, ["https://example.com/lease"]);
  assert.equal(c.time, "About 5 minutes");
  assert.equal(c.answered, "You said yes to the shed on 11-02.");
  assert.equal(contextLine(c), "Steps and links · About 5 minutes");
  // the title and Next above the block are not context; a `# title` or another `##` heading ends a section
  assert.ok(!c.steps.some((x) => x.includes("Next")));
  assert.equal(askContext("# T-1 Old context note\n\n## Why\nIt matters.\n\n## Notes\nnot context")!.why, "It matters.");
  assert.equal(askContext("## Why\nIt matters.\n\n## Notes\nnot context")!.steps.length, 0);
  assert.deepEqual(askContext("## Steps\n#### On the phone\n1. Call the hall")!.steps, ["On the phone", "Call the hall"]);
  // a body with none of the sections has no context; nor does a missing body
  assert.equal(askContext("T-2 Plain task\n\n**Next:** do it"), null);
  assert.equal(askContext(undefined), null);
  assert.equal(contextLine({ why: "w", steps: [], links: [], time: null, answered: null }), "Why");
  assert.equal(contextLine({ why: null, steps: [], links: [], time: "About 5 minutes", answered: null }), "About 5 minutes");
  // links: markdown links read as their words (an address with its own brackets too); bare ones as their host, the full stop left out
  const urls = (t: string) => splitMarkdownLinks(t).filter((p) => "url" in p).map((p) => ["url" in p ? p.url : "", "url" in p ? p.label : ""]);
  assert.deepEqual(urls("See https://example.com/kiln/tiles."), [["https://example.com/kiln/tiles", "example.com"]]);
  assert.deepEqual(urls("- [glaze sheet](https://example.com/sheet) and [kiln](https://example.com/wiki/Kiln_(pottery))."), [["https://example.com/sheet", "glaze sheet"], ["https://example.com/wiki/Kiln_(pottery)", "kiln"]]);
  assert.deepEqual(urls("[not a web link](javascript:alert(1))"), []);
  assert.equal(splitMarkdownLinks("See [it](https://example.com/x). Then go").map((p) => ("url" in p ? `<${p.label}>` : p.text)).join(""), "See <it>. Then go");
  console.log("ok   an ask's context is read from its body: why, steps, links, time, what he already said");
}
