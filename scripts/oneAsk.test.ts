// T-335 one ask, step 2: the one list (src/shape/oneAsk.ts). Room asks are real signed events made by the vendored library with made-up
// keys; tasks and approvals are made-up too. Run: node --experimental-strip-types scripts/oneAsk.test.ts
process.env.TZ = "UTC";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2.js";
import { buildAnswer, buildAsk, parseAsk, pubkeyHex, signEvent, type NostrEvent } from "../src/ask/index.ts";
import { answersOf, cardButtons, nextChange, oneList, onList, roomAnswer, roomCards, type Card } from "../src/shape/oneAsk.ts";
import type { VaultAsk } from "../src/shape/asksCore.ts";
import type { Approval } from "../src/approvals.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n").slice(0, 6).join("\n     ")}`); }
}

const key = (n: string) => sha256(new TextEncoder().encode("one-ask app test key: " + n));
const UNI = key("uni"), ME = key("me");
const POLICY = { askers: [pubkeyHex(UNI)], owner: [pubkeyHex(ME)] };
const T = 1_900_000_000, H = 3600;
const ROOM = "ch-kiln";
const ask = (fields: Record<string, unknown>, at = T - H): NostrEvent => signEvent(UNI, buildAsk(ROOM, { kind: "tell", what: "Read the kiln log", why: "The firing ended", until: T + 2 * H, ...fields }, at), at);
const answer = (ev: NostrEvent, a: string, at = T - 60, o: Record<string, unknown> = {}) => signEvent(ME, buildAnswer(parseAsk(ev, POLICY.askers)[0]!, a, { now: at, ...o }), at);
const task = (id: string, m: Partial<VaultAsk> = {}): VaultAsk => ({ id, tid: `T-${id.length}`, room: ROOM, kind: "do", what: `Task ${id}`, next: null, why: null, options: [], fallback: null, action: "Done", link: null,
  updatedAt: T - 2 * H, rev: "r", state: "open", roomName: "kiln", replyRoot: null, askedAt: null, ...m });
const CARD = "ab12cd34ef56" + "1".repeat(52);
const sealed = (ref: string, channel = ROOM, expires = T + 600): Approval => ({ ref, channel, author: pubkeyHex(UNI), ts: T - 300, root: null, command: "", why: "", answers: [], deadline: expires, kind: "sealed",
  sealed: { ref, channel, root: null, ts: T - 300, kind: "single", credential: "kiln-key", action: "kiln.fire", class: "routine", rows: 1, expires, fingerprint: "7c4e19d2" } });
const ids = (cs: readonly Card[]) => cs.map((c) => c.id);

check("a room's ask is a card on the list; Seen ends it, in any order the events arrive", () => {
  const a = ask({});
  const before = roomCards([a], T, POLICY);
  assert.equal(before.length, 1);
  assert.equal(onList(before[0], T), true);
  const seen = answer(a, "seen");
  for (const evs of [[a, seen], [seen, a]]) {
    const [c] = roomCards(evs, T, POLICY);
    assert.equal(c.state, "answered");
    assert.equal(c.ended, "Seen");
    assert.equal(onList(c, T), false);
    assert.deepEqual(ids(oneList({ room: [c], tasks: [], approvals: [], now: T }).cards), []);
  }
});

check("an ask signed by a key not allowed to ask is no card", () => {
  const stranger = signEvent(key("stranger"), buildAsk(ROOM, { kind: "tell", what: "x", why: "y", until: T + H }, T - H), T - H);
  assert.deepEqual(roomCards([stranger], T, POLICY), []);
});

check("a lapsed ask leaves the list at its time by the clock alone, and the next change is the time to redraw", () => {
  const a = ask({ until: T + 120 });
  const [c] = roomCards([a], T, POLICY);
  assert.equal(nextChange([c], T), T + 60, "buttons stop a minute early");
  assert.equal(nextChange([c], T + 60), T + 120);
  assert.equal(onList(roomCards([a], T + 119, POLICY)[0], T + 119), true);
  const after = roomCards([a], T + 120, POLICY)[0];
  assert.equal(after.state, "lapsed");
  assert.equal(onList(after, T + 120), false);
  assert.deepEqual(cardButtons(roomCards([a], T + 61, POLICY)[0], { now: T + 61 }), [], "no button in the last minute");
});

check("a 'tap the card' task is its card while the card waits: one card, with the task's words; folded tasks too", () => {
  const t = task("tap", { sealedCard: CARD.slice(0, 12), what: "Deploy the kiln tool", why: "The kiln is booked" });
  const other = task("elsewhere", { room: "ch-studio", sealedCard: CARD });
  const folded = task("folded", { sealedCard: CARD });
  const plain = task("plain");
  const l = oneList({ room: [], tasks: [t, other, plain], onCard: [folded], approvals: [sealed(CARD)], now: T });
  assert.deepEqual(ids(l.cards).sort(), [CARD, "plain"].sort());
  const c = l.approvals.get(CARD)!;
  assert.equal(c.source, "card");
  assert.equal(c.what, "Deploy the kiln tool");
  assert.equal(c.why, "The kiln is booked");
  assert.equal(c.tid, t.tid);
  // a card that has ended no longer folds it: the task shows as itself (and says its card ended)
  assert.deepEqual(ids(oneList({ room: [], tasks: [t], approvals: [], now: T }).cards), ["tap"]);
  // a card past its time is off the list by the clock, even before the waiting list is read again
  assert.deepEqual(ids(oneList({ room: [], tasks: [], approvals: [sealed(CARD, ROOM, T - 1)], now: T }).cards), []);
});

check("another room's task never lends its words to the card", () => {
  const other = task("elsewhere", { room: "ch-studio", sealedCard: CARD, what: "Studio words" });
  const c = oneList({ room: [], tasks: [other], approvals: [sealed(CARD)], now: T }).approvals.get(CARD)!;
  assert.notEqual(c.what, "Studio words");
  assert.equal(c.task, undefined);
});

check("one rule for buttons: by kind, whatever made the card; opened adds Reply and Archive; an approval card answers on itself", () => {
  const ch = roomCards([ask({ kind: "choose", options: [{ id: "a", label: "Cone 6" }, { id: "b", label: "Cone 10" }] })], T, POLICY)[0];
  const later = `Later · ${new Date((T + 3 * 86400) * 1000).toLocaleDateString("en-US", { weekday: "short" })}`;
  assert.deepEqual(cardButtons(ch, { now: T }).map((b) => b.label), ["Cone 6", "Cone 10", "Seen", later]);
  assert.deepEqual(cardButtons(ch, { now: T, open: true }).map((b) => b.act).slice(-2), ["reply", "archive"]);
  const doTask = oneList({ room: [], tasks: [task("t")], approvals: [], now: T }).cards[0];
  assert.deepEqual(cardButtons(doTask, { now: T }).map((b) => b.label), ["I did it", "Seen", later]);
  assert.deepEqual(cardButtons(oneList({ room: [], tasks: [], approvals: [sealed(CARD)], now: T }).cards[0], { now: T }), []);
});

check("answers go in the main line: no e tag ever; only pick, words and did wake the room", () => {
  const a = ask({ kind: "do" });
  const [c] = roomCards([a], T, POLICY);
  for (const [b, wakes] of [[{ act: "did", value: "" }, true], [{ act: "seen", value: "" }, false], [{ act: "archive", value: "" }, false], [{ act: "later", value: "2030-03-20" }, false],
    [{ act: "words", text: "Done it my way" }, true]] as const) {
    const t = roomAnswer(c, b, T);
    assert.equal(t.tags.some((x) => x[0] === "e"), false);
    assert.deepEqual(t.tags.find((x) => x[0] === "q")?.slice(0, 2), ["q", a.id]);
    assert.equal(t.tags.some((x) => x[0] === "p"), wakes, b.act);
  }
  // a reply's words end it, and the chat knows which ask it quotes
  const words = signEvent(ME, roomAnswer(c, { act: "words", text: "Done it my way" }, T), T - 30);
  const after = roomCards([a, words], T, POLICY)[0];
  assert.equal(after.state, "answered");
  assert.equal(answersOf([a, words], T, POLICY).get(words.id), a.id);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\noneAsk: all ok");
