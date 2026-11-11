// T-335: the applets registry (which applets show, a sealed applet's manifest, the bar's count) and Studio's pins.
// Run: node --experimental-strip-types scripts/applets.test.ts
import assert from "node:assert/strict";
import { BUILT_IN, joinApplets, parseAppletManifest, totalCount, visibleApplets, type AppletManifest } from "../src/interface/applets.ts";
import { studioLooks } from "../src/shape/studioCore.ts";
import type { Ask } from "../src/shape/types.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const ids = (list: readonly AppletManifest[]) => list.map((a) => a.id);
const all = { calendar: true, messages: true, uniGlue: true };
const none = { calendar: false, messages: false, uniGlue: false };

check("drawer order: vault applets, then doors", () => {
  assert.deepEqual(ids(visibleApplets(BUILT_IN, all)), ["arcade", "studio", "topost", "recipes", "calendar", "vault", "mail", "messages"]);
});
check("nothing flagged: no Calendar, Messages or Uni's own applets", () => {
  assert.deepEqual(ids(visibleApplets(BUILT_IN, none)), ["recipes", "vault", "mail"]);
});
check("each flag shows only its own applets", () => {
  assert.deepEqual(ids(visibleApplets(BUILT_IN, { ...none, calendar: true })), ["recipes", "calendar", "vault", "mail"]);
  assert.deepEqual(ids(visibleApplets(BUILT_IN, { ...none, messages: true })), ["recipes", "vault", "mail", "messages"]);
  assert.deepEqual(ids(visibleApplets(BUILT_IN, { ...none, uniGlue: true })), ["arcade", "studio", "topost", "recipes", "vault", "mail"]);
});

const good = { contract: 1, id: "recipe-book", name: "Recipe book", kind: "vault", where: "kitchen vault, on the box", searches: ["recipes"] };
const refused = (raw: unknown, why: RegExp) => {
  const r = parseAppletManifest(raw);
  assert.equal(r.ok, false, `accepted ${JSON.stringify(raw)}`);
  if (!r.ok) assert.match(r.error, why);
};

check("a good manifest parses as a sealed vault applet", () => {
  const r = parseAppletManifest(good);
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.manifest.host, "sealed"); assert.equal(r.manifest.kind, "vault"); assert.deepEqual(r.manifest.searches, ["recipes"]); }
});
check("refused: unknown kind, and a note claiming to be a door", () => {
  refused({ ...good, kind: "bridge" }, /unknown kind/);
  refused({ ...good, kind: "door" }, /can.t be a door/);
});
check("refused: another contract", () => {
  refused({ ...good, contract: 2 }, /contract/);
  refused({ ...good, contract: "1" }, /contract/);
});
check("refused: hidden characters anywhere", () => {
  refused({ ...good, name: "Recipe​ book" }, /name/);
  refused({ ...good, where: "kitchen vault‮" }, /where/);
  refused({ ...good, searches: ["reci­pes"] }, /search/);
  refused({ ...good, name: "Recipe\nbook" }, /name/);
});
check("refused: a non-kebab or built-in id", () => {
  for (const id of ["Recipes", "recipe_book", "-recipes", "recipes-", "recipe--book", "", "a b"]) refused({ ...good, id }, /id/);
  refused({ ...good, id: "mail" }, /built-in/);
});
check("refused: too long", () => {
  refused({ ...good, name: "n".repeat(41) }, /name/);
  refused({ ...good, where: "w".repeat(81) }, /where/);
  refused({ ...good, id: "a".repeat(41) }, /id/);
  refused({ ...good, searches: Array(9).fill("x") }, /searches/);
  assert.ok(parseAppletManifest({ ...good, name: "n".repeat(40) }).ok);
});
check("glyph: one visible character, else refused", () => {
  const r = parseAppletManifest({ ...good, glyph: "❀" });
  assert.ok(r.ok && r.manifest.glyph === "❀");
  refused({ ...good, glyph: "ab" }, /glyph/);
  refused({ ...good, glyph: "❀\ufe0e" }, /glyph/);
});
check("refused: a key the contract doesn't know (host can't be claimed)", () => {
  refused({ ...good, host: "native" }, /key/);
});
check("a sealed Recipes takes the placeholder's slot", () => {
  const r = parseAppletManifest({ ...good, id: "recipes", name: "Recipes" });
  assert.ok(r.ok);
  if (!r.ok) return;
  const joined = joinApplets(BUILT_IN, [r.manifest]);
  assert.deepEqual(ids(joined), ids(BUILT_IN));
  assert.equal(joined[3].host, "sealed");
  assert.equal(joined[3].placeholder, undefined);
});

check("the bar's count adds only the applets shown", () => {
  const counts = { topost: 1, mail: 3, messages: 4, calendar: 2 };
  assert.equal(totalCount(counts, visibleApplets(BUILT_IN, all)), 10);
  assert.equal(totalCount(counts, visibleApplets(BUILT_IN, none)), 3);
  assert.equal(totalCount({ mail: -2, vault: Number.NaN, recipes: 2.7 }, BUILT_IN), 2);
});

const ask = (o: Partial<Ask>): Ask => ({ id: "t1", tid: null, room: "r-1", kind: "look", what: "Look at the poster", why: null, options: [], fallback: null, action: null, link: "https://board.example.com/c/1", updatedAt: 100, ...o });
check("studio: look asks with a board link (not an Arcade card), newest first, trimmed, with their room", () => {
  const asks = [
    ask({ id: "a", updatedAt: 1 }),
    ask({ id: "b", kind: "do" }),
    ask({ id: "c", link: null }),
    ask({ id: "d", link: "  " }),
    ask({ id: "e", updatedAt: 5, room: null, why: "Two cuts to compare", link: " https://board.example.com/c/5 " }),
    ask({ id: "f", updatedAt: 9, link: "https://box.example.ts.net:8543/#look/card-1" }),
  ];
  const looks = studioLooks(asks, (id) => (id === "r-1" ? "Kiln Studio" : null));
  assert.deepEqual(looks.map((l) => l.id), ["e", "a"]);
  assert.equal(looks[0].roomName, null);
  assert.equal(looks[0].why, "Two cuts to compare");
  assert.equal(looks[0].link, "https://board.example.com/c/5");
  assert.equal(looks[1].roomName, "Kiln Studio");
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
