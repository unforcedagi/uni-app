// Run: node --experimental-strip-types scripts/areasCore.test.ts
import assert from "node:assert/strict";
import { appPathOf, findAppRow, isAreaPath, parseArea, purposeOf, sortAreas, splitChannels, type Area } from "../src/areas/areasCore.ts";
import { LIVE_AREA_PLATFORMS, liveAreaApps, parseSelfTest, platformName } from "../src/interface/selftest/gate.ts";


const note = (path: string, status: string, extra: object = {}) => ({
  id: `id-${path}`, path, tags: ["area"], updatedAt: "2026-10-07T10:00:00Z",
  content: `# ${path.split("/").pop()}\n\nThe **purpose** of [this](https://x.y) area.\nSecond line.\n\nLater paragraph.`,
  metadata: { channel: "c1, c2 ,c1", status, since: "2026-01-01" }, ...extra,
});

// ---- parsing
const a = parseArea(note("Areas/Techne", "foreground"))!;
assert.equal(a.name, "Techne");
assert.equal(a.path, "Areas/Techne");
assert.equal(a.purpose, "The purpose of this area. Second line.");
assert.equal(a.status, "foreground");
assert.deepEqual(a.channels, ["c1", "c2"]);
assert.equal(a.since, "2026-01-01");
assert.equal(parseArea(note("Areas/X", "weird"))!.status, "background");
assert.equal(parseArea(note("Areas/X.md", "foreground"))!.path, "Areas/X");
assert.equal(parseArea({ ...note("Areas/X", "foreground"), tags: ["journal"] }), null, "needs the area tag");
assert.equal(parseArea(note("Areas/Techne/app", "foreground")), null, "the app note is not an area");
assert.equal(parseArea(note("Areas/Techne/Deep note", "foreground")), null);
assert.equal(parseArea(note("Elsewhere/Techne", "foreground")), null);
assert.equal(parseArea(note("Areas/Y", "foreground", { metadata: null }))!.channels.length, 0);
assert.deepEqual(splitChannels(["a", " b", 3, ""]), ["a", "b"]);
assert.deepEqual(splitChannels(undefined), []);
assert.equal(purposeOf("---\ntitle: x\n---\n# T\n\n## Sub\n\nFirst para"), "First para");
assert.equal(purposeOf("# Only title"), "");
assert.ok(isAreaPath("Areas/Atlas") && !isAreaPath("Areas/Atlas/app") && !isAreaPath("Areas") && !isAreaPath(null));

// ---- sorting: foreground first, then name
const mk = (name: string, status: "foreground" | "background") => parseArea(note(`Areas/${name}`, status)) as Area;
assert.deepEqual(sortAreas([mk("Sadhana", "background"), mk("Techne", "foreground"), mk("Atlas", "background"), mk("expression", "foreground")]).map((x) => x.name),
  ["expression", "Techne", "Atlas", "Sadhana"]);

// ---- app lookup and notes list
const rows = [
  { id: "1", path: "Areas/Techne", extension: "md" },
  { id: "2", path: "Areas/Techne/app", extension: "html" },
  { id: "3", path: "Areas/Techne/Log", extension: "md", updatedAt: "2026-10-02T00:00:00Z" },
  { id: "4", path: "Areas/Techne/Plan", extension: "md", updatedAt: "2026-10-05T00:00:00Z" },
  { id: "5", path: "Areas/Atlas/Secret", extension: "md", updatedAt: "2026-10-06T00:00:00Z" },
  { id: "6", path: "Areas/Atlas/app", extension: "md" },
  { id: "7", path: "Areas/TechneX/Other", extension: "md" },
];
assert.equal(appPathOf("Areas/Techne"), "Areas/Techne/app");
assert.equal(findAppRow(rows, "Areas/Techne")?.id, "2");
assert.equal(findAppRow(rows, "Areas/Atlas"), null, "app must be html");


// ---- platform gate
assert.equal(platformName("Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit"), "android");
assert.equal(platformName("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130"), "linux");
assert.equal(platformName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit"), "mac");
assert.deepEqual([...LIVE_AREA_PLATFORMS], [], "no platform is proven by constant");
const UA = "Mozilla/5.0 (X11; Linux x86_64) WebKitGTK/2.46";
const pass = { platform: "linux", passedAt: "2026-10-08T00:00:00Z", appVersion: "1.2.3", userAgent: UA };
assert.ok(!liveAreaApps("linux", "1.2.3", null, UA), "no stored pass: closed");
assert.ok(liveAreaApps("linux", "1.2.3", pass, UA), "stored pass for platform, version and webview: open");
assert.ok(!liveAreaApps("linux", "1.2.4", pass, UA), "version mismatch: closed");
assert.ok(!liveAreaApps("android", "1.2.3", pass, UA), "platform mismatch: closed");
assert.ok(!liveAreaApps("linux", null, pass, UA), "version unknown: closed");
assert.ok(!liveAreaApps("linux", "1.2.3", pass, UA + " upgraded"), "user agent mismatch: closed");
assert.ok(liveAreaApps("mac", "9", null, "", ["mac"]), "the constant still opens a platform");
assert.deepEqual(parseSelfTest(JSON.stringify(pass)), pass);
for (const bad of [null, "", "{", "[]", "null", JSON.stringify({ platform: "linux" }), JSON.stringify({ ...pass, appVersion: 3 }), JSON.stringify({ platform: "linux", passedAt: "x", appVersion: "1" }), JSON.stringify({ ...pass, platform: "" })]) assert.equal(parseSelfTest(bad), null, String(bad));

// ---- tab targets
const { openTab, restoreTabs, serializeTabs, EMPTY_TABS, sameTarget } = await import("../src/tabs.ts");
let n = 0; const id = () => `a${++n}`;
let s = openTab(EMPTY_TABS, { kind: "areas", title: "Areas" }, "focus", id);
s = openTab(s, { kind: "area", path: "Areas/Techne", title: "Techne" }, "new", id);
s = openTab(s, { kind: "areas", title: "Areas" }, "new", id);
assert.equal(s.tabs.length, 2, "one Areas tab");
assert.ok(sameTarget({ kind: "area", path: "Areas/A", title: "" }, { kind: "area", path: "Areas/A", title: "x" }));
assert.ok(!sameTarget({ kind: "area", path: "Areas/A", title: "" }, { kind: "area", path: "Areas/B", title: "" }));
const back = restoreTabs(serializeTabs(s), []);
assert.deepEqual(back.tabs.map((t) => [t.kind, t.path ?? null]), [["areas", null], ["area", "Areas/Techne"]]);
assert.equal(restoreTabs(JSON.stringify({ v: 1, tabs: [{ id: "x", kind: "area", path: "../etc", title: "" }], active: "x", recent: [] }), []).tabs.length, 0, "bad area path dropped");

console.log("areasCore: ok");

