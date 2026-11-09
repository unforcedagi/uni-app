// 0.3.1 home layout: For you's folded head (its words) and For you on an area's stream (only that area's), as pure functions of the view
// forYouCore.ts makes. Made-up asks and cards only. Run: node --experimental-strip-types scripts/homeLayout.test.ts
process.env.TZ = "UTC";
import assert from "node:assert/strict";
import { forYou, type Note, type Place } from "../src/foryou/forYouCore.ts";
import { headWords, scopeForYou } from "../src/foryou/scope.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n").slice(0, 6).join("\n     ")}`); }
}

const NOW = Date.parse("2026-11-11T12:00:00Z");
const H = 3600_000, D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
// T-335 one home: these asks are fresh and open, so uni-tasks wrote needs_aaron true (a test that wants otherwise says so)
const task = (id: string, m: Record<string, unknown>): Note => ({ id, path: `Tasks/${id}`, tags: ["task"], updatedAt: iso(NOW - H), createdAt: iso(NOW - 9 * D), metadata: { state: "open", owner: "aaron", kind: "do", no_default: true, needs_aaron: true, needs_aaron_why: "yes", ...m } });
const card = (area: string, name: string, m: Record<string, unknown> = {}): Note => ({ id: `c-${name}`, path: `Cards/${area}/${name}`, tags: ["card"], metadata: { schema: "card/1", name, area, area_node: `Areas/${area}`, status: "active", private: false, lines: [], ...m } });
const PLACES: Record<string, Place> = {
  "Areas/Kiln Studio": { area: "Kiln Studio", areaPath: "Areas/Kiln Studio", room: "kiln-studio", private: false },
  "Projects/Glaze Tests": { area: "Kiln Studio", areaPath: "Areas/Kiln Studio", room: "glaze-tests", private: false },
  "Areas/North Field": { area: "North Field", areaPath: "Areas/North Field", room: "north-field", private: false },
};
const placeOf = (n: string): Place => PLACES[n] ?? { area: null, room: null, private: false };
const line = (h: number, text: string) => ({ run: `r${h}`, at: iso(NOW - (h + 1) * H), ended: iso(NOW - h * H), status: "completed", text });
// seven of his in two areas (six in Kiln Studio, one in its project), one to look at in each, a moving card in each
const asks = [
  ...[1, 2, 3, 4, 5].map((i) => task(`k${i}`, { node: "Areas/Kiln Studio", why_now: `kiln ${i}`, asked_at: iso(NOW - i * H) })),
  task("g1", { node: "Projects/Glaze Tests", asked_at: iso(NOW - 6 * H) }),
  task("n1", { node: "Areas/North Field", asked_at: iso(NOW - 7 * H) }),
  task("kl", { node: "Areas/Kiln Studio", kind: "look", asked_at: iso(NOW - H) }),
  task("nl", { node: "Areas/North Field", kind: "look", asked_at: iso(NOW - H) }),
];
const cards = [card("Kiln Studio", "Glaze Tests", { lines: [line(2, "Tiles out.")] }), card("North Field", "Gate Path", { lines: [line(3, "Gravel ordered.")] }), card("North Field", "Hedge", { lines: [line(300, "Old.")] })];
const all = forYou({ asks, cards, placeOf, me: "aaron", now: NOW, lastLooked: null });

check("the whole view: seven of his, five shown, two looks, two moving", () => {
  assert.equal(all.count, 7); assert.equal(all.yours.length, 5); assert.equal(all.more.length, 2); assert.equal(all.look.length, 2); assert.equal(all.moving.length, 2);
});

check("an area's For you: only its asks (a project's inside it too), its looks and its cards' lines; Yours re-capped", () => {
  const k = scopeForYou(all, "Areas/Kiln Studio");
  assert.equal(k.count, 6);
  assert.deepEqual([...k.yours, ...k.more].map((i) => i.id).sort(), ["g1", "k1", "k2", "k3", "k4", "k5"]);
  assert.equal(k.yours.length, 5); assert.equal(k.more.length, 1);
  assert.deepEqual(k.look.map((i) => i.id), ["kl"]);
  assert.deepEqual(k.moving.map((m) => m.card), ["Glaze Tests"]);
  assert.equal(k.quiet.line, "");
  const n = scopeForYou(all, "Areas/North Field");
  assert.deepEqual([...n.yours, ...n.more].map((i) => i.id), ["n1"]);
  assert.equal(n.more.length, 0);
  assert.deepEqual(n.moving.map((m) => m.card), ["Gate Path"]);
  // the view it was made from is untouched
  assert.equal(all.count, 7);
});

check("the head: counts, then nothing with the day's line, never 'nothing' beside an approval, and a failed read said", () => {
  assert.deepEqual(headWords(all, { failed: false, reading: false }), { lead: "7 for you", rest: ["2 to look at", "2 moving"] });
  assert.deepEqual(headWords(all, { failed: false, reading: false, approvals: 1 }), { lead: "7 for you", rest: ["1 waiting for your OK", "2 to look at", "2 moving"] });
  const none = { count: 0, look: [], moving: [] };
  assert.deepEqual(headWords(none, { failed: false, reading: false, quiet: "Breathe out." }), { lead: "Nothing for you", rest: ["Breathe out."] });
  assert.deepEqual(headWords(none, { failed: false, reading: false, approvals: 2 }), { lead: "2 waiting for your OK", rest: [] });
  assert.deepEqual(headWords(none, { failed: true, reading: false, quiet: "Breathe out." }), { lead: "Couldn't check what needs you", rest: [] });
  assert.deepEqual(headWords(none, { failed: false, reading: true }), { lead: "Looking for what's yours…", rest: [] });
  assert.deepEqual(headWords(none, { failed: true, reading: false, approvals: 1 }), { lead: "1 waiting for your OK", rest: ["couldn't check the rest"] });
  assert.deepEqual(headWords(all, { failed: true, reading: false }), { lead: "7 for you", rest: ["couldn't check the rest", "2 to look at", "2 moving"] });
  assert.deepEqual(headWords({ ...none, moving: all.moving }, { failed: false, reading: false, quiet: "Breathe out." }), { lead: "Nothing for you", rest: ["2 moving"] });
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall home layout checks passed");
