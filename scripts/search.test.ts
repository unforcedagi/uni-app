// Run: node --experimental-strip-types scripts/search.test.ts
import assert from "node:assert/strict";
import { hitTarget, markParts, plainSnippet, snippetSegments, SNIPPET_END as E, SNIPPET_START as S } from "../src/searchCore.ts";
import type { NoteHit, SearchHit } from "../src/searchCore.ts";
import { ANY_ROOM, ANY_VAULT, group, hereNotes, scopeOf, split, whereOf } from "../src/shape/searchScope.ts";
import type { SearchCtx } from "../src/shape/searchScope.ts";

assert.deepEqual(snippetSegments(`now about the ${S}fcm${E} ${S}gateway${E}`), [
  { text: "now about the ", hit: false },
  { text: "fcm", hit: true },
  { text: " ", hit: false },
  { text: "gateway", hit: true },
]);
// HTML in a message stays text (it is rendered as a React text node).
assert.deepEqual(snippetSegments(`<img src=x onerror=alert(1)> ${S}hi${E}`), [
  { text: "<img src=x onerror=alert(1)> ", hit: false },
  { text: "hi", hit: true },
]);
assert.deepEqual(snippetSegments(""), []);
// Unbalanced markers: no crash, adjacent runs merge.
assert.deepEqual(snippetSegments(`a${E}b${S}c`), [{ text: "ab", hit: false }, { text: "c", hit: true }]);
assert.deepEqual(snippetSegments(`${S}${E}x`), [{ text: "x", hit: false }]);

assert.deepEqual(hitTarget({ ref: "r", channel: "c", root: "root" }), { channel: "c", root: "root", focus: "r" });
assert.deepEqual(hitTarget({ ref: "r", channel: "c", root: null }), { channel: "c", root: null, focus: "r" });
assert.deepEqual(hitTarget({ ref: "r", channel: "c", root: "r" }), { channel: "c", root: null, focus: "r" });

// T-335 glow-up: a note's snippet reads as prose: no heading marks, stars, backticks or link brackets, the link's words kept.
assert.equal(plainSnippet("## Now\n\nThe **coop** paperwork is signed. See [[Areas/Kiln Studio/Plan|the plan]] and [notes](https://example.com/n)."),
  "Now The coop paperwork is signed. See the plan and notes.");
assert.equal(plainSnippet("- first `cone 6`\n- second [[Glaze Tests]]"), "first cone 6 second Glaze Tests");
assert.equal(plainSnippet("Issue #12 stays"), "Issue #12 stays");
// emphasis marks go only in pairs around words; code and arithmetic keep theirs
assert.equal(plainSnippet("call __init__() with 2*3*4, then **bold** and *soft* and __strong__."), "call __init__() with 2*3*4, then bold and soft and strong.");

// T-335 the shape: query words marked in raw text, any case, regex characters literal, HTML left as text.
assert.deepEqual(markParts("Thursday at the kiln, thursday again", "THURSDAY"), [
  { text: "Thursday", hit: true }, { text: " at the kiln, ", hit: false }, { text: "thursday", hit: true }, { text: " again", hit: false },
]);
assert.deepEqual(markParts("cost (a+b)*2 vs ab", "(a+b)*2"), [{ text: "cost ", hit: false }, { text: "(a+b)*2", hit: true }, { text: " vs ab", hit: false }]);
assert.deepEqual(markParts("a.b and axb", "a.b"), [{ text: "a.b", hit: true }, { text: " and axb", hit: false }]);
assert.deepEqual(markParts("<b>glaze</b> test", "glaze test"), [
  { text: "<b>", hit: false }, { text: "glaze", hit: true }, { text: "</b> ", hit: false }, { text: "test", hit: true },
]);
assert.deepEqual(markParts("plain", "   "), [{ text: "plain", hit: false }]);
assert.deepEqual(markParts("", "x"), []);
assert.equal(markParts("<img src=x onerror=alert(1)>", "img").map((p) => p.text).join(""), "<img src=x onerror=alert(1)>");

// ── scope, group, split ──
const ctx: SearchCtx = {
  rooms: [{ id: "c1", name: "Riverbend Commons" }, { id: "c2", name: "Kiln Studio" }],
  vaults: ["home", "other"],
  journal: { vault: "home", prefix: "Journal/" },
  primaryVault: "home",
};

// home: every room and the journal
assert.deepEqual(scopeOf({ kind: "home" }, ctx), { label: "rooms and the journal", placeIds: ["room:c1", "room:c2", ANY_ROOM, "journal"] });
assert.deepEqual(scopeOf({ kind: "home" }, { ...ctx, journal: null }).label, "your rooms");
assert.deepEqual(scopeOf({ kind: "room", id: "c2", name: "Kiln Studio" }, ctx), { label: "Kiln Studio", placeIds: ["room:c2"] });
assert.deepEqual(scopeOf({ kind: "journal" }, ctx), { label: "the journal", placeIds: ["journal"] });
assert.deepEqual(scopeOf({ kind: "vault", vault: "other" }, ctx), { label: "the other vault", placeIds: ["vault:other"] });
assert.deepEqual(scopeOf({ kind: "vault", vault: "other", pathPrefix: "Projects/Glaze/" }, ctx), { label: "Glaze in the other vault", placeIds: ["folder:other:Projects/Glaze"] });
assert.deepEqual(scopeOf({ kind: "applet", id: "recipes", name: "Recipes", vault: "home", pathPrefix: "Recipes/" }, ctx), { label: "Recipes", placeIds: ["applet:recipes"] });
// a door with no search source here searches from home, and the scope line says so
assert.deepEqual(scopeOf({ kind: "applet", id: "mail", name: "Mail" }, ctx), scopeOf({ kind: "home" }, ctx));

// the narrow vault call each scope makes
assert.equal(hereNotes({ kind: "room", id: "c1", name: "x" }, ctx), null);
assert.deepEqual(hereNotes({ kind: "home" }, ctx), { vault: "home", pathPrefix: "Journal/" });
assert.deepEqual(hereNotes({ kind: "vault", vault: "other" }, ctx), { vault: "other", pathPrefix: null });
assert.deepEqual(hereNotes({ kind: "applet", id: "recipes", name: "Recipes", vault: "home", pathPrefix: "Recipes/" }, ctx), { vault: "home", pathPrefix: "Recipes/" });

const msg = (ref: string, channel: string, name: string): SearchHit => ({
  message: { ref, channel, author: "a", author_name: "Mira", ts: 1, body: "b", root: null, edited: false }, channel_name: name, snippet: `${S}thursday${E}`,
});
const note = (vault: string, path: string, id = path): NoteHit => ({ vault, id, path, snippet: "**thursday** plan", score: 1, mode: "meaning" });
const results = {
  messages: [msg("1", "c2", "kiln"), msg("2", "c1", "riverbend"), msg("3", "c2", "kiln"), msg("4", "c9", "elsewhere")],
  notes: [note("home", "Journal/2026/10-14/19-43 Thursday walk"), note("home", "Journalling ideas"), note("other", "Journal/x"),
    note("home", "Recipes/Bread"), note("home", "Journal/2026/10-14/19-43 Thursday walk")],
};
const groups = group(results, ctx);
const byId = Object.fromEntries(groups.map((g) => [g.place.id, g]));
// rooms keep rank order of their best hit; the host's room name wins over the store's
assert.deepEqual(groups.map((g) => g.place.id), ["room:c2", "room:c1", "room:c9", "journal", "vault:home", "vault:other"]);
assert.equal(byId["room:c2"].place.name, "Kiln Studio");
assert.equal(byId["room:c9"].place.name, "elsewhere");
assert.deepEqual(byId["room:c2"].hits.map((h) => h.key), ["m:1", "m:3"]);
// a note under the journal's prefix is the journal's (once, deduped); a look-alike folder or another vault's Journal/ is not
assert.deepEqual(byId["journal"].hits.map((h) => h.title), ["19-43 Thursday walk"]);
assert.deepEqual(byId["vault:home"].hits.map((h) => h.title), ["Journalling ideas", "Bread"]);
assert.deepEqual(byId["vault:other"].hits.map((h) => h.title), ["x"]);
assert.equal(byId["journal"].hits[0].text, "thursday plan");
assert.deepEqual(byId["journal"].hits[0].meta, ["Journal › 2026 › 10-14"]);
// every hit lands in exactly one place
assert.equal(groups.reduce((n, g) => n + g.hits.length, 0), 4 + 4);
// inside an applet, its folder is a place of its own (narrower than the vault)
const inRecipes = group(results, { ...ctx, here: { kind: "applet", id: "recipes", name: "Recipes", vault: "home", pathPrefix: "Recipes/" } });
assert.deepEqual(inRecipes.find((g) => g.place.id === "applet:recipes")?.hits.map((h) => h.title), ["Bread"]);
assert.equal(inRecipes.find((g) => g.place.id === "applet:recipes")?.place.name, "Recipes");

// where each place lives
assert.equal(whereOf({ id: "room:c1" }, ctx), "a room on this device");
assert.equal(whereOf({ id: "journal" }, ctx), "home vault");
assert.equal(whereOf({ id: "vault:home" }, ctx), "your main vault");
assert.equal(whereOf({ id: "vault:other" }, ctx), "");
assert.equal(whereOf({ id: "applet:recipes" }, { ...ctx, here: { kind: "applet", id: "recipes", name: "Recipes", vault: "home", pathPrefix: "Recipes/" } }), "home vault, Recipes");

// home: every room's matches (even a room the host didn't list) and the journal are here; vaults are "also in"
const home = split(groups, scopeOf({ kind: "home" }, ctx).placeIds, null);
assert.deepEqual(home.here.map((g) => g.place.id), ["room:c2", "room:c1", "room:c9", "journal"]);
assert.deepEqual(home.also.map((a) => [a.place.id, a.count]), [["vault:home", 2], ["vault:other", 1]]);
// in one room: only it; other rooms are counted apart, never blended in
const room = split(groups, scopeOf({ kind: "room", id: "c1", name: "Riverbend Commons" }, ctx).placeIds, null);
assert.deepEqual(room.here.map((g) => g.place.id), ["room:c1"]);
assert.deepEqual(room.also.map((a) => [a.place.id, a.count]), [["room:c2", 2], ["room:c9", 1], ["journal", 1], ["vault:home", 2], ["vault:other", 1]]);
// tapping one under "also in" shows only it; the rest (the room you came from included) are "also in"
const focused = split(groups, scopeOf({ kind: "room", id: "c1", name: "Riverbend Commons" }, ctx).placeIds, "vault:other");
assert.deepEqual(focused.here.map((g) => g.place.id), ["vault:other"]);
assert.ok(focused.also.some((a) => a.place.id === "room:c1"));
assert.equal(focused.also.length, groups.length - 1);
// nothing here: here is empty, the rest still counted
const none = split(groups, ["room:zz"], null);
assert.deepEqual(none.here, []);
assert.equal(none.also.length, groups.length);

// the old Find (no journal known) keeps every room and every vault here
const legacy = split(group(results, { ...ctx, journal: null }), [ANY_ROOM, ANY_VAULT], null);
assert.deepEqual(legacy.also, []);
assert.equal(legacy.here.length, 5);

console.log("search tests passed");
