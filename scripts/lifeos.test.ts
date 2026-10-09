// T-80: the life OS view — Brief/Today parsing, Today ranking, freshness, the device cache, the room switcher, Ask-Uni drafts.
// Run: node --experimental-strip-types scripts/lifeos.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { askDraft, briefMissingDraft, refreshDraft, nowLine, parseBrief, parseToday, rankNeeds, todayNeeds, updatedLabel, inlineTokens } from "../src/areas/briefCore.ts";
import { createAreasCache, CACHE_KEY } from "../src/areas/areasCache.ts";
import { pickRoom } from "../src/areas/areaLayout.ts";
import { parseArea, parseProject, parentOf } from "../src/areas/areasCore.ts";
import { buildTree, childrenOf, parentPath, rootNode, ROOT, trail, UNI_CHANNEL } from "../src/areas/treeCore.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const OWNER = { identity: 'A', vault: 'uni' };
const NOW = Date.parse("2026-10-09T18:00:00Z");

const BRIEF = `# Techne brief

## Now
The coop paperwork is done. COhere starts Oct 15 and needs a room plan.

## Needs you
- Reply to Leonardo about the grant, due 2026-10-10 [[Projects/Techne/Grant|Grant draft]]
- Decide the COhere venue by Oct 12
- nothing recent

## Moving
- **Festival** logistics: tents ordered [[Projects/Cohere/Logistics|Logistics]]

## People
- Leonardo, Mara

## Recent
- 10-08 Coop papers signed
- 10-07 Room plan drafted

## Quiet
- nothing recent

## Suggested next
- Draft a reply to Leonardo
- Ask Mara for the room plan
`;

check("parseBrief reads the seven sections in order", () => {
  const b = parseBrief(BRIEF);
  assert.equal(b.now, "The coop paperwork is done. COhere starts Oct 15 and needs a room plan.");
  assert.equal(b.needsYou.length, 2, "'nothing recent' is not an item");
  assert.equal(b.moving.length, 1);
  assert.equal(b.people.length, 1);
  assert.equal(b.recent.length, 2);
  assert.deepEqual(b.quiet, []);
  assert.equal(b.suggested.length, 2);
  assert.deepEqual(b.present, ["now", "needsYou", "moving", "people", "recent", "quiet", "suggested"]);
});
check("items keep wikilinks by path with display text, plain text drops the markup", () => {
  const [first] = parseBrief(BRIEF).needsYou;
  assert.equal(first.text, "Reply to Leonardo about the grant, due 2026-10-10 Grant draft");
  assert.deepEqual(first.tokens.filter((t) => t.t === "link"), [{ t: "link", target: "Projects/Techne/Grant", label: "Grant draft" }]);
  assert.deepEqual(inlineTokens("[[Areas/X/Y]]"), [{ t: "link", target: "Areas/X/Y", label: "Y" }]);
  assert.deepEqual(inlineTokens("a **b** c"), [{ t: "text", text: "a " }, { t: "bold", text: "b" }, { t: "text", text: " c" }]);
  assert.deepEqual(inlineTokens("[site](https://example.org/x)"), [{ t: "url", href: "https://example.org/x", label: "site" }]);
});
check("parseBrief tolerates front matter, missing sections, odd casing and unknown sections", () => {
  const b = parseBrief("---\narea: X\n---\n# X\n\n## now\nQuiet week.\n\n## Extras\n- ignored\n\n## Suggested Next\n* a star bullet\n1. numbered\n");
  assert.equal(b.now, "Quiet week.");
  assert.deepEqual(b.suggested.map((i) => i.text), ["a star bullet", "numbered"]);
  assert.deepEqual(b.present, ["now", "suggested"]);
  assert.deepEqual(b.needsYou, []);
  const empty = parseBrief("");
  assert.equal(empty.now, ""); assert.deepEqual(empty.present, []);
});
check("nowLine is the first sentence, capped", () => {
  assert.equal(nowLine(parseBrief(BRIEF)), "The coop paperwork is done.");
  assert.equal(nowLine(parseBrief("## Now\n" + "word ".repeat(80))).length <= 161, true);
  assert.equal(nowLine(parseBrief("")), "");
});

const TODAY = `# Today

## Needs you today
- **Techne** Reply to Leonardo about the grant, due 2026-10-10 [[Projects/Techne/Grant|Grant draft]]
- **Sanctum** Book the retreat
- **Unforced Development** Send the Q4 invoice, overdue since 2026-10-05
- **Relationships** Call Mom on 2026-10-09

## Moved since yesterday
- **Techne** coop papers signed

## Quiet areas
- Atlas

## Areas
- [[Areas/Techne/Brief|Techne]]: Coop paperwork done, COhere next.
- [[Areas/Sanctum/Brief|Sanctum]]: nothing recent
`;
check("parseToday reads needs with their area, moved, quiet and the per-area lines", () => {
  const t = parseToday(TODAY);
  assert.equal(t.needs.length, 4);
  assert.equal(t.needs[0].area, "Techne");
  assert.equal(t.needs[0].text, "Reply to Leonardo about the grant, due 2026-10-10 Grant draft");
  assert.equal(t.needs[2].area, "Unforced Development");
  assert.equal(t.moved.length, 1);
  assert.equal(t.quiet[0].text, "Atlas");
  assert.deepEqual(t.areas.map((a) => [a.name, a.path, a.now]), [["Techne", "Areas/Techne/Brief", "Coop paperwork done, COhere next."], ["Sanctum", "Areas/Sanctum/Brief", ""]]);
});
check("rankNeeds: overdue, then due today, then soon, then undated; foreground breaks ties; the writer's order breaks the rest", () => {
  const t = parseToday(TODAY);
  const ranked = rankNeeds(t.needs, { now: NOW, foreground: ["Techne"] });
  assert.deepEqual(ranked.map((n) => n.area), ["Unforced Development", "Relationships", "Techne", "Sanctum"]);
  // no dates anywhere: foreground first, then the writer's order
  const flat = rankNeeds([{ text: "b", tokens: [], area: "Sanctum" }, { text: "a", tokens: [], area: "Techne" }, { text: "c", tokens: [], area: "Atlas" }], { now: NOW, foreground: ["Techne"] });
  assert.deepEqual(flat.map((n) => n.text), ["a", "b", "c"]);
  // the input is not mutated
  assert.equal(t.needs[0].area, "Techne");
});
check("rankNeeds understands 'Oct 12'-style dates", () => {
  const r = rankNeeds([{ text: "later Oct 20", tokens: [], area: "A" }, { text: "soon Oct 10", tokens: [], area: "B" }], { now: NOW, foreground: [] });
  assert.equal(r[0].area, "B");
});
check("todayNeeds falls back to the area briefs when there is no Today note, and carries the area name", () => {
  const briefs = { Techne: parseBrief(BRIEF), Sanctum: parseBrief("## Needs you\n- Book the retreat\n") };
  const none = todayNeeds(null, briefs, ["Techne"], NOW);
  assert.deepEqual(none.map((n) => n.area), ["Techne", "Techne", "Sanctum"]);
  assert.equal(none[0].text.startsWith("Reply to Leonardo"), true);
  const withNote = todayNeeds(parseToday(TODAY), briefs, ["Techne"], NOW);
  assert.equal(withNote.length, 4, "Today's own list wins when it has items");
  const emptyToday = todayNeeds(parseToday("## Needs you today\n- nothing recent\n"), briefs, ["Techne"], NOW);
  assert.equal(emptyToday.length, 3, "an empty Today note still falls back to the briefs");
});

check("updatedLabel: freshness in words", () => {
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  assert.equal(updatedLabel(ago(20_000), NOW), "updated just now");
  assert.equal(updatedLabel(ago(5 * 60_000), NOW), "updated 5m ago");
  assert.equal(updatedLabel(ago(3 * 3600_000 + 60_000), NOW), "updated 3h ago");
  assert.equal(updatedLabel(ago(2 * 86400_000), NOW), "updated 2d ago");
  assert.equal(updatedLabel(ago(40 * 86400_000), NOW), "updated 5w ago");
  assert.equal(updatedLabel(null, NOW), "");
  assert.equal(updatedLabel("garbage", NOW), "");
  assert.equal(updatedLabel(new Date(NOW + 60_000).toISOString(), NOW), "updated just now", "clock skew never says the future");
});

check("Ask-Uni drafts reference the item and the area, and never look like a sent message", () => {
  const item = parseBrief(BRIEF).needsYou[0];
  const d = askDraft("needsYou", "Techne", item);
  assert.match(d, /@Uni/);
  assert.match(d, /Techne/);
  assert.ok(d.includes(item.text));
  const s = askDraft("suggested", "Techne", parseBrief(BRIEF).suggested[0]);
  assert.match(s, /draft|do this|take this/i);
  assert.ok(s.includes("Draft a reply to Leonardo"));
  const w = briefMissingDraft("Techne");
  assert.match(w, /@Uni/); assert.ok(w.includes("Areas/Techne/Brief"));
});

// -------------------------------------------------------------------- device cache
function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, raw: m };
}
const DATA = { areas: [{ id: "a", path: "Areas/Techne", name: "Techne", purpose: "p", status: "foreground" as const, channels: ["c1", "c2"], rooms: ["c1", "c2"], kind: "area" as const, parent: null, since: null, title: "Techne", body: "# Techne", metadata: {}, updatedAt: null }], briefs: { "Areas/Techne": { content: BRIEF, generatedAt: "2026-10-09T15:00:00Z", updatedAt: "2026-10-09T15:01:00Z" } }, today: { content: TODAY, updatedAt: "2026-10-09T15:02:00Z" } };
check("cache round-trips what the home paints from", () => {
  const s = memStore(); const c = createAreasCache(s, () => NOW);
  assert.equal(c.read(OWNER), null);
  c.write(DATA, OWNER);
  const back = c.read(OWNER)!;
  assert.deepEqual(back.areas, DATA.areas); assert.deepEqual(back.briefs, DATA.briefs); assert.deepEqual(back.today, DATA.today);
  assert.equal(back.savedAt, NOW);
  assert.ok(s.raw.has(CACHE_KEY));
});
check("cache ignores garbage, a wrong version and a broken shape; a failing store never throws", () => {
  for (const bad of ["{", "null", "[]", JSON.stringify({ v: 99, owner: OWNER, areas: [] }), JSON.stringify({ v: 1, owner: OWNER, savedAt: 1, areas: [], briefs: {}, today: null }), JSON.stringify({ v: 2, owner: OWNER, areas: "x" }), JSON.stringify({ v: 2, owner: OWNER, savedAt: 1, areas: [{ nope: 1 }], briefs: {}, today: null })]) {
    assert.equal(createAreasCache(memStore({ [CACHE_KEY]: bad })).read(OWNER), null, bad);
  }
  const boom = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => {} };
  const c = createAreasCache(boom);
  assert.equal(c.read(OWNER), null); c.write(DATA, OWNER);
  assert.equal(createAreasCache(null).read(OWNER), null);
});

check("cache refuses another identity or vault and clear forgets the device", () => {
  const store = memStore({ "uni.areas.cache.v1": "legacy" });
  const c = createAreasCache(store, () => NOW);
  const a = { identity: 'A', vault: 'uni' }, b = { identity: 'B', vault: 'uni' };
  c.write(DATA, a);
  assert.equal(c.read(b), null);
  assert.equal(c.read({ ...a, vault: 'other' }), null);
  assert.ok(c.read(a));
  c.clear();
  assert.equal(c.read(a), null);
  assert.equal(store.getItem("uni.areas.cache.v1"), null);
  store.setItem(CACHE_KEY, JSON.stringify({ v: 2, savedAt: NOW, ...DATA }));
  assert.equal(c.read(a), null, "an ownerless cache is never adopted");
});

// -------------------------------------------------------------------- room switcher
check("pickRoom keeps a valid choice, falls back to the first room, and is null without rooms", () => {
  assert.equal(pickRoom(["a", "b"], "b"), "b");
  assert.equal(pickRoom(["a", "b"], "zzz"), "a");
  assert.equal(pickRoom(["a", "b"], null), "a");
  assert.equal(pickRoom([], "a"), null);
});

// -------------------------------------------------------------------- wiring (source-level guards for what the UI promised)
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
check("useAreas no longer pages the whole vault", () => {
  const u = src("../src/areas/useAreas.ts");
  assert.ok(!/invoke<PathRow\[]>\("vault_paths"/.test(u.split("export const areaPaths")[0] ?? ""), "paths are only for the bridge");
  assert.match(u, /vault_query/);
  assert.ok(!/vault_note/.test(u), "no per-area note fetch");
});
check("the Tauri side registers vault_query", () => {
  assert.match(src("../src-tauri/src/lib.rs"), /vault_query,/);
});


check("forget clears the areas memory and persistent cache", () => {
  assert.match(src("../src/App.tsx").split('async function forget()')[1].split('const currentRoom')[0], /forgetAreas\(\)/);
  const u = src("../src/areas/useAreas.ts");
  assert.match(u, /export function forgetAreas/);
  assert.match(u, /deviceCache.clear\(\)/);
});

// -------------------------------------------------------------------- the tree (T-80b)
const areaNote = (name: string, metadata: Record<string, unknown> = {}) => ({ id: `a-${name}`, path: `Areas/${name}`, tags: ["area"], content: `# ${name}\n\nAbout ${name}.`, metadata, updatedAt: "2026-10-09T10:00:00Z" });
const projectNote = (path: string, metadata: Record<string, unknown> = {}) => ({ id: `p-${path}`, path, tags: ["project"], content: "", metadata, updatedAt: "2026-10-09T10:00:00Z" });
const nodes = (...n: { id: string; path: string; tags: string[]; content: string; metadata: Record<string, unknown>; updatedAt: string }[]) =>
  n.map((x) => (x.tags.includes("area") ? parseArea(x) : parseProject(x))!).filter(Boolean);

check("parentOf reads a path, tolerating [[ ]], a leading slash and an extension", () => {
  assert.equal(parentOf({ parent: "Areas/Techne" }), "Areas/Techne");
  assert.equal(parentOf({ parent: "[[Areas/Techne|Techne]]" }), "Areas/Techne");
  assert.equal(parentOf({ parent: " /Areas/Techne.md " }), "Areas/Techne");
  assert.equal(parentOf({ parent: "" }), null);
  assert.equal(parentOf({}), null);
  assert.equal(parentOf({ parent: 7 }), null);
});
check("a project is a tagged note with a parent; Brief and app notes, and notes without a parent, are not nodes", () => {
  assert.equal(parseProject(projectNote("Projects/COhere/COhere 2026", { parent: "Areas/Techne" }))?.parent, "Areas/Techne");
  assert.equal(parseProject(projectNote("Projects/COhere/COhere 2026", {})), null);
  assert.equal(parseProject(projectNote("Projects/X/Brief", { parent: "Areas/Techne" })), null);
  assert.equal(parseProject({ ...projectNote("Projects/Y", { parent: "Areas/Techne" }), tags: ["note"] }), null);
});
check("buildTree: areas at the top, a project under its parent, foreground first", () => {
  const t = buildTree(nodes(areaNote("Techne", { status: "foreground", channel: "t1" }), areaNote("Atlas", { channel: "a1" }),
    projectNote("Projects/COhere/COhere 2026", { parent: "Areas/Techne", channel: "c1" })));
  assert.deepEqual(childrenOf(t, ROOT).map((n) => n.name), ["Techne", "Atlas"]);
  assert.deepEqual(childrenOf(t, "Areas/Techne").map((n) => n.path), ["Projects/COhere/COhere 2026"]);
  assert.deepEqual(childrenOf(t, "Areas/Atlas"), []);
  assert.equal(parentPath(t, "Projects/COhere/COhere 2026"), "Areas/Techne");
  assert.equal(parentPath(t, "Areas/Techne"), ROOT);
  assert.deepEqual(trail(t, "Projects/COhere/COhere 2026").map((n) => n.name), ["Techne", "COhere 2026"]);
  assert.deepEqual(trail(t, "Nope"), []);
});
check("buildTree: a missing parent puts the node at the top level; so does naming itself", () => {
  const t = buildTree(nodes(areaNote("Techne"), projectNote("Projects/Lost", { parent: "Areas/Gone" }), projectNote("Projects/Self", { parent: "Projects/Self" })));
  assert.deepEqual(childrenOf(t, ROOT).map((n) => n.path).sort(), ["Areas/Techne", "Projects/Lost", "Projects/Self"]);
});
check("buildTree: cycles are broken at the smallest path and nothing is lost or loops", () => {
  const t = buildTree(nodes(projectNote("Projects/B", { parent: "Projects/A" }), projectNote("Projects/A", { parent: "Projects/C" }), projectNote("Projects/C", { parent: "Projects/B" }), projectNote("Projects/D", { parent: "Projects/C" })));
  assert.equal(t.nodes.size, 4);
  assert.deepEqual(childrenOf(t, ROOT).map((n) => n.path), ["Projects/A"]);
  assert.deepEqual(trail(t, "Projects/D").map((n) => n.path), ["Projects/A", "Projects/B", "Projects/C", "Projects/D"]);
  const total = [ROOT, ...t.nodes.keys()].reduce((n, k) => n + childrenOf(t, k).length, 0);
  assert.equal(total, 4, "every node has exactly one parent");
});
check("buildTree: multiple rooms are kept in order, and a child's room leaves the parent's view but not the note", () => {
  const t = buildTree(nodes(areaNote("Techne", { channel: "t1, c1,t1" }), projectNote("Projects/COhere/COhere 2026", { parent: "Areas/Techne", channel: "c1" }), projectNote("Projects/Two", { parent: "Areas/Techne", channel: "x1, x2" })));
  const techne = t.nodes.get("Areas/Techne")!;
  assert.deepEqual(techne.channels, ["t1", "c1"], "the note says what it says");
  assert.deepEqual(techne.rooms, ["t1"], "the view drops the room a child claims");
  assert.deepEqual(t.nodes.get("Projects/Two")!.rooms, ["x1", "x2"]);
});
check("buildTree: a parent whose rooms are all claimed keeps them, and duplicate paths keep the newest", () => {
  const t = buildTree(nodes(areaNote("Techne", { channel: "c1" }), projectNote("Projects/P", { parent: "Areas/Techne", channel: "c1" })));
  assert.deepEqual(t.nodes.get("Areas/Techne")!.rooms, ["c1"]);
  const a = { ...areaNote("Techne", { status: "foreground" }), updatedAt: "2026-10-01T00:00:00Z" }, b = { ...areaNote("Techne"), id: "newer", updatedAt: "2026-10-09T00:00:00Z" };
  assert.equal(buildTree(nodes(a, b)).nodes.get("Areas/Techne")!.id, "newer");
});
check("the Uni root is a node on the Uni channel, and refresh drafts name the node and its Brief", () => {
  const r = rootNode([UNI_CHANNEL]);
  assert.equal(r.path, ROOT); assert.deepEqual(r.rooms, [UNI_CHANNEL]); assert.equal(UNI_CHANNEL, "1b667c1f-95c8-45e5-a7cc-1df13b7d0e2a");
  assert.match(refreshDraft("Techne", "Areas/Techne"), /^@Uni .*Areas\/Techne\/Brief/);
  assert.match(refreshDraft("COhere 2026", "Projects/COhere/COhere 2026"), /Projects\/COhere\/COhere 2026\/Brief/);
  assert.match(refreshDraft("Uni", ""), /Areas\/Today/);
  assert.match(briefMissingDraft("COhere 2026", "Projects/COhere/COhere 2026"), /Projects\/COhere\/COhere 2026\/Brief/);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
