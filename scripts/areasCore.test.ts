// Run: node --experimental-strip-types scripts/areasCore.test.ts
import assert from "node:assert/strict";
import { AREA_CSP, RateLimiter, appPathOf, areaNotes, buildSrcdoc, findAppRow, isAreaPath, parseArea, purposeOf, scopedPath, sortAreas, splitChannels, validateRequest, type Area } from "../src/areas/areasCore.ts";
import { AreaBridge, type BridgeApi, type BridgeMessage } from "../src/areas/bridge.ts";
import { createAreaApi } from "../src/areas/areaApi.ts";
import { liveAreaApps, platformName } from "../src/areas/gate.ts";

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
assert.deepEqual(areaNotes(rows, "Areas/Techne", 50).map((n) => n.path), ["Areas/Techne/Plan", "Areas/Techne/Log"]);
assert.equal(areaNotes(rows, "Areas/Techne", 1).length, 1);

// ---- path scope
const T = "Areas/Techne";
assert.equal(scopedPath(T, "Areas/Techne/Plan"), "Areas/Techne/Plan");
assert.equal(scopedPath(T, "Areas/Techne/sub/deep"), "Areas/Techne/sub/deep");
for (const bad of ["Areas/Techne/../Atlas/Secret", "Areas/Techne/..", "../Areas/Techne/x", "/Areas/Techne/x", "Areas/Atlas/Secret", "Areas/TechneX/Other",
  "Areas/Techne", "Areas/Techne/", "Areas//Techne/x", "Areas/Techne//x", "Areas/Techne/./x", "Areas\\Techne\\x", "Areas/Techne/%2e%2e/Atlas", "Areas/Techne/x\u0000",
  "", "Journal/2026/x", "areas/Techne/x", "/etc/passwd", "uni:Areas/Techne/x", 7, null, undefined, {}, "x".repeat(400)]) {
  assert.equal(scopedPath(T, bad), null, `rejects ${JSON.stringify(bad)}`);
}

// ---- srcdoc: CSP first, before any app markup
for (const html of ["<h1>hi</h1><script>1</script>", "<!doctype html><html><head><title>t</title></head><body><script>1</script></body></html>",
  "<script>early()</script><head></head>", "<html><body>x</body></html>", "﻿<!DOCTYPE html>\n<script>x</script>"]) {
  const doc = buildSrcdoc(html);
  assert.ok(doc.startsWith("<!doctype html><meta http-equiv=\"Content-Security-Policy\""), doc);
  assert.equal((doc.match(/<!doctype/gi) ?? []).length, 1, "one doctype");
}
for (const d of ["default-src 'none'", "script-src 'unsafe-inline'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "img-src data: blob:", "font-src data:"]) assert.ok(AREA_CSP.includes(d), d);

// ---- request validator
const ok = (m: unknown) => validateRequest(m);
assert.deepEqual(ok({ bridge: 1, id: "1", method: "area.get" }), { ok: true, id: "1", call: { method: "area.get" } });
assert.deepEqual(ok({ bridge: 1, id: "a", method: "area.get", params: {} }), { ok: true, id: "a", call: { method: "area.get" } });
assert.deepEqual(ok({ bridge: 1, id: "n", method: "notes.list", params: { limit: 5 } }), { ok: true, id: "n", call: { method: "notes.list", limit: 5 } });
assert.deepEqual(ok({ bridge: 1, id: "n", method: "notes.list" }), { ok: true, id: "n", call: { method: "notes.list", limit: 50 } });
assert.equal((ok({ bridge: 1, id: "c", method: "channel.recent" }) as { call: { limit: number } }).call.limit, 30);
const reject = (m: unknown, error: string, id: string | null) => assert.deepEqual(ok(m), { ok: false, id, error }, String(error));
reject(null, "bad_request", null);
reject("str", "bad_request", null);
reject([], "bad_request", null);
reject({ bridge: 1, id: "", method: "area.get" }, "bad_id", null);
reject({ bridge: 1, id: "x".repeat(65), method: "area.get" }, "bad_id", null);
reject({ bridge: 1, id: 5, method: "area.get" }, "bad_id", null);
reject({ bridge: 2, id: "1", method: "area.get" }, "bad_version", "1");
reject({ id: "1", method: "area.get" }, "bad_version", "1");
reject({ bridge: 1, id: "1", method: "area.get", extra: true }, "bad_request", "1");
reject({ bridge: 1, id: "1" }, "bad_request", "1");
reject({ bridge: 1, id: "1", method: "fs.read" }, "unknown_method", "1");
reject({ bridge: 1, id: "1", method: "__proto__" }, "unknown_method", "1");
reject({ bridge: 1, id: "1", method: "area.get", params: [] }, "bad_params", "1");
reject({ bridge: 1, id: "1", method: "area.get", params: { x: 1 } }, "bad_params", "1");
reject({ bridge: 1, id: "1", method: "notes.list", params: { limit: 51 } }, "bad_params", "1");
reject({ bridge: 1, id: "1", method: "notes.list", params: { limit: 0 } }, "bad_params", "1");
reject({ bridge: 1, id: "1", method: "notes.list", params: { limit: 1.5 } }, "bad_params", "1");
reject({ bridge: 1, id: "1", method: "channel.recent", params: { limit: 31 } }, "bad_params", "1");
reject({ bridge: 1, id: "1", method: "note.get", params: {} }, "bad_params", "1");
reject({ bridge: 1, id: "1", method: "note.get", params: { path: 3 } }, "bad_params", "1");
reject({ bridge: 1, id: "1", method: "channel.compose", params: { text: "x".repeat(2001) } }, "bad_params", "1");
reject({ bridge: 1, id: "1", method: "channel.compose", params: { text: "  " } }, "bad_params", "1");
reject({ bridge: 1, id: "1", method: "channel.compose", params: { text: "hi", channel: "other" } }, "bad_params", "1");
reject({ bridge: 1, id: "1", method: "note.open", params: { ref: "" } }, "bad_params", "1");
reject({ bridge: 1, id: "1", method: "note.get", params: { path: "x".repeat(9000) } }, "too_large", "1");
const cyclic: Record<string, unknown> = { bridge: 1, id: "cy", method: "area.get" }; cyclic.params = cyclic;
reject(cyclic, "too_large", "cy");
assert.ok(ok({ bridge: 1, id: "1", method: "channel.compose", params: { text: "x".repeat(2000) } }).ok);
class Weird { bridge = 1; id = "1"; method = "area.get"; }
reject(new Weird(), "bad_request", null);

// ---- rate limiter
const rl = new RateLimiter(60, 10_000);
for (let i = 0; i < 60; i++) assert.ok(rl.take(1000 + i));
assert.ok(!rl.take(2000));
assert.ok(rl.take(11_000 + 60), "window slides");

// ---- bridge: pending cap, rate limit, errors
function harness(api: Partial<BridgeApi>, now = () => 0) {
  const out: BridgeMessage[] = [];
  const full = { areaGet: async () => ({}), notesList: async () => ({}), noteGet: async () => ({}), channelRecent: async () => ({}), channelCompose: async () => ({ ok: true }), noteOpen: async () => ({ ok: true }), ...api };
  return { out, bridge: new AreaBridge((m) => out.push(m), full, now) };
}
{
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const h = harness({ areaGet: async () => { await gate; return { title: "T" }; } });
  for (let i = 0; i < 10; i++) h.bridge.handle({ bridge: 1, id: `r${i}`, method: "area.get" });
  assert.deepEqual(h.out.map((m) => (m as { error: string }).error), ["too_many_pending", "too_many_pending"]);
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.out.filter((m) => "result" in m).length, 8);
  h.bridge.handle({ bridge: 1, id: "after", method: "area.get" });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(h.out.some((m) => "id" in m && m.id === "after" && "result" in m), "pending slot freed");
}
{
  const h = harness({});
  for (let i = 0; i < 100; i++) h.bridge.handle({ bridge: 1, id: `q${i}`, method: "area.get" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.out.filter((m) => "error" in m && m.error === "rate_limited").length, 40);
  h.bridge.handle("junk"); h.bridge.handle({ nope: 1 });
  assert.equal(h.out.length, 100, "unidentifiable junk gets no reply");
}
{
  const h = harness({ noteGet: async () => { throw new Error("boom"); } });
  h.bridge.handle({ bridge: 1, id: "e", method: "note.get", params: { path: "Areas/Techne/x" } });
  h.bridge.handle({ bridge: 1, id: "u", method: "shell.exec" });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(h.out, [{ bridge: 1, id: "u", error: "unknown_method" }, { bridge: 1, id: "e", error: "boom" }]);
}

// ---- area api scope
{
  const calls: string[] = [];
  const api = createAreaApi(a, {
    listPaths: async () => rows,
    getNote: async (p) => { calls.push(`get:${p}`); return { id: "n", content: "body" }; },
    getMessages: async (c) => c === "c1" ? [{ ref: "m1", author: "abcdef012345", author_name: "Aaron", ts: 100, body: "hi" }] : [{ ref: "m2", author: "feedbeefcafe", ts: 200, body: "yo" }],
    compose: (c, t) => calls.push(`compose:${c}:${t}`),
    openNote: (r) => calls.push(`open:${r}`),
  });
  assert.equal((await api.noteGet("Areas/Techne/Plan") as { content: string }).content, "body");
  await assert.rejects(api.noteGet("Areas/Atlas/Secret"), /out_of_scope/);
  await assert.rejects(api.noteGet("Areas/Techne/../Atlas/Secret"), /out_of_scope/);
  assert.deepEqual(calls, ["get:Areas/Techne/Plan"], "out-of-scope reads never reach the vault");
  const recent = await api.channelRecent(30) as { messages: { id: string; author: string; created_at: string }[] };
  assert.deepEqual(recent.messages.map((m) => [m.id, m.author]), [["m2", "feedbeef"], ["m1", "Aaron"]]);
  assert.equal(recent.messages[1].created_at, "1970-01-01T00:01:40.000Z");
  assert.deepEqual(await api.channelCompose("hello"), { ok: true });
  assert.ok(calls.includes("compose:c1:hello"));
  const none = createAreaApi({ ...a, channels: [] }, { listPaths: async () => [], getNote: async () => ({ id: "" }), getMessages: async () => [], compose: () => {}, openNote: () => {} });
  await assert.rejects(none.channelCompose("x"), /no_channel/);
  assert.equal(((await api.notesList(50)) as { notes: unknown[] }).notes.length, 2);
}

// ---- platform gate
assert.equal(platformName("Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit"), "android");
assert.equal(platformName("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130"), "linux");
assert.equal(platformName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit"), "mac");
assert.ok(liveAreaApps("linux"));
assert.ok(!liveAreaApps("android") && !liveAreaApps("mac") && !liveAreaApps("other"));

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
