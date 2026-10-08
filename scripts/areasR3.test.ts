// Round 3 (T-73c): red tests for the independent review's findings.
// Run: node --experimental-strip-types scripts/areasR3.test.ts
// Each section is a named check so a failure names its finding; modules that
// don't exist yet import as {} and fail their section instead of the file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as core from "../src/areas/areasCore.ts";
import * as bridgeMod from "../src/areas/bridge.ts";
import * as areaApiMod from "../src/areas/areaApi.ts";
import * as gate from "../src/areas/gate.ts";
import * as probe from "../src/areas/probe.ts";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const opt = async (p: string): Promise<Any> => import(p).catch(() => ({}));
const guard: Any = await opt("../src/areas/frameGuard.ts");
const cache: Any = await opt("../src/areas/pathCache.ts");

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const noopApi = { areaGet: async () => ({}), notesList: async () => ({}), noteGet: async () => ({}), channelRecent: async () => ({}), channelCompose: async () => ({ ok: true }), noteOpen: async () => ({ ok: true }) };
const mkBridge = (api: Any = {}, opts: Any = {}, now: () => number = () => 0) => {
  const out: Any[] = [];
  const B = bridgeMod.AreaBridge as Any;
  return { out, bridge: new B((m: Any) => out.push(m), { ...noopApi, ...api }, now, opts) as Any };
};

// ---------------------------------------------------------------- P1-1
await check("P1-1 tauri.conf.json sets a frame-src about: CSP (map form, only what is needed)", () => {
  const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const csp = conf.app.security.csp;
  assert.ok(csp && typeof csp === "object", "csp is the map form");
  assert.equal(csp["frame-src"], "about:");
  assert.deepEqual(Object.keys(csp), ["frame-src"], "no other directive: nothing else can break");
});
await check("P1-1 LoadTripwire: one load per mount is fine, a second trips and stays tripped", () => {
  const t = new guard.LoadTripwire();
  assert.equal(t.load(), false);
  assert.equal(t.load(), true);
  assert.equal(t.load(), true);
  t.reset();
  assert.equal(t.load(), false, "a new srcdoc starts again");
});
await check("P1-1 a closed bridge drops pending replies and refuses further messages", async () => {
  let release!: () => void;
  const gateP = new Promise<void>((r) => { release = r; });
  const h = mkBridge({ areaGet: async () => { await gateP; return { title: "T" }; } });
  h.bridge.handle({ bridge: 1, id: "a", method: "area.get" });
  h.bridge.close();
  release(); await tick();
  assert.deepEqual(h.out, [], "no reply after close");
  h.bridge.handle({ bridge: 1, id: "b", method: "area.get" }); await tick();
  assert.deepEqual(h.out, [], "no messages accepted after close");
});
await check("P1-1 srcdoc neutralises WebRTC after the CSP meta and before the app", () => {
  const doc = core.buildSrcdoc("<script>APP()</script>", "<style>F</style>");
  const csp = doc.indexOf("Content-Security-Policy"), rtc = doc.indexOf("RTCPeerConnection"), app = doc.indexOf("APP()");
  assert.ok(csp >= 0 && rtc > csp && app > rtc, "CSP, then WebRTC removal, then the app");
  assert.match(doc, /webkitRTCPeerConnection/); assert.match(doc, /RTCDataChannel/);
});

// ---------------------------------------------------------------- P1-2
await check("P1-2 the probe requires securitypolicyviolation, aims at a reachable target, and never settles true on timeout", () => {
  assert.match(probe.PROBE_HTML, /securitypolicyviolation/);
  assert.match(probe.PROBE_HTML, /createObjectURL/, "a blob: target the frame could really reach without the CSP");
  assert.doesNotMatch(probe.PROBE_HTML, /res\(true\)\s*,\s*1500/, "timeout must not mean blocked");
  assert.doesNotMatch(probe.PROBE_HTML, /example\.invalid/, "an unresolvable host fails even with no CSP");
});
await check("P1-2 the probe checks WebRTC and the three navigation vectors", () => {
  const ids = probe.PROBE_CHECKS.map((c: Any) => c.id);
  for (const id of ["webrtc", "navSelf", "navMeta", "navAnchor", "beacon"]) assert.ok(ids.includes(id), id);
});
await check("P1-2 navVerdict: blocked by frame-src or tripwire passes, nothing observed fails", () => {
  const v = (probe as Any).navVerdict;
  assert.equal(v({ violation: true, loads: 1 }), true);
  assert.equal(v({ violation: false, loads: 2 }), true);
  assert.equal(v({ violation: false, loads: 1 }), false, "no positive signal is a fail");
  assert.equal(v({ violation: false, loads: 0 }), false);
});

// ---------------------------------------------------------------- P2-1
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 WebKitGTK/2.46";
const pass = { platform: "linux", passedAt: "2026-10-08T00:00:00Z", appVersion: "1.2.3", userAgent: UA };
await check("P2-1 a stored pass needs the same userAgent", () => {
  const live = gate.liveAreaApps as Any;
  assert.equal(live("linux", "1.2.3", pass, UA, []), true);
  assert.equal(live("linux", "1.2.3", pass, UA.replace("2.46", "2.48"), []), false, "webview upgrade forces a re-test");
  assert.equal(live("linux", "1.2.3", { ...pass, userAgent: undefined }, UA, []), false, "a record without a UA is not a pass");
  assert.equal(live("linux", "1.2.3", pass, "", []), false);
});
await check("P2-1 parseSelfTest keeps userAgent and drops records without one", () => {
  assert.deepEqual(gate.parseSelfTest(JSON.stringify(pass)), pass);
  assert.equal(gate.parseSelfTest(JSON.stringify({ ...pass, userAgent: undefined })), null);
});
await check("P2-1 clearSelfTest removes the stored pass", () => {
  const store = new Map<string, string>();
  (globalThis as Any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  try {
    gate.storeSelfTest(pass as Any);
    assert.ok(gate.readSelfTest());
    (gate as Any).clearSelfTest();
    assert.equal(gate.readSelfTest(), null);
  } finally { delete (globalThis as Any).localStorage; }
});

// ---------------------------------------------------------------- P2-2
await check("P2-2 every message counts against the limiter, invalid ones included, over-limit drops silently", async () => {
  const h = mkBridge();
  for (let i = 0; i < 200; i++) h.bridge.handle({ bridge: 1, id: `x${i}`, method: "nope" });
  const replies = h.out.length;
  assert.equal(replies, 60, "only the first 60 are answered");
  for (let i = 0; i < 50; i++) h.bridge.handle({ bridge: 1, id: `v${i}`, method: "area.get" });
  await tick();
  assert.equal(h.out.length, 60, "silent once over the limit: no rate_limited reply");
});
await check("P2-2 cheap size guard: 20 x 20 MB junk costs the host almost nothing", () => {
  const h = mkBridge();
  const big = { bridge: 1, id: "x", method: "nope", params: { a: "y".repeat(20_000_000) } };
  const t = performance.now();
  for (let i = 0; i < 20; i++) h.bridge.handle(big);
  const ms = performance.now() - t;
  assert.ok(ms < 50, `main thread ${Math.round(ms)} ms`);
});
await check("P2-2 cheap size guard: huge arrays and deep objects are rejected without stringify", () => {
  const h = mkBridge();
  const arr = new Array(5_000_000).fill(1);
  let deep: Any = { bridge: 1, id: "d", method: "area.get", params: {} };
  for (let i = 0; i < 5000; i++) deep = { n: deep };
  const t = performance.now();
  for (let i = 0; i < 5; i++) { h.bridge.handle({ bridge: 1, id: "a", method: "area.get", params: { l: arr } }); h.bridge.handle({ bridge: 1, id: "p", method: "area.get", params: deep }); }
  assert.ok(performance.now() - t < 50, "bounded");
  assert.ok(h.out.every((m) => m.error === "too_large" || m.error === "bad_params"));
});
await check("P2-2 200k tiny junk messages stay bounded and answer at most the limit", () => {
  const h = mkBridge();
  const t = performance.now();
  for (let i = 0; i < 200_000; i++) h.bridge.handle({ bridge: 1, id: "x", method: "nope" });
  assert.ok(performance.now() - t < 400, "bounded");
  assert.equal(h.out.length, 60);
});

// ---------------------------------------------------------------- P2-3
const call = (id: string, method: string, params: object) => ({ bridge: 1, id, method, params });
await check("P2-3 compose and note.open are refused without a gesture (needs_gesture)", async () => {
  const seen: string[] = [];
  const h = mkBridge({ channelCompose: async () => { seen.push("compose"); return { ok: true }; }, noteOpen: async () => { seen.push("open"); return { ok: true }; } }, { gesture: () => false });
  h.bridge.handle(call("c", "channel.compose", { text: "hi" }));
  h.bridge.handle(call("o", "note.open", { ref: "Areas/T/x" }));
  await tick();
  assert.deepEqual(h.out.map((m) => m.error), ["needs_gesture", "needs_gesture"]);
  assert.deepEqual(seen, []);
});
await check("P2-3 with a gesture, one compose or open per 3 s", async () => {
  let t = 1000;
  const seen: string[] = [];
  const h = mkBridge({ channelCompose: async () => { seen.push("compose"); return { ok: true }; }, noteOpen: async () => { seen.push("open"); return { ok: true }; } }, { gesture: () => true }, () => t);
  h.bridge.handle(call("c1", "channel.compose", { text: "a" }));
  h.bridge.handle(call("c2", "channel.compose", { text: "b" }));
  h.bridge.handle(call("o1", "note.open", { ref: "Areas/T/x" }));
  await tick();
  assert.deepEqual(seen, ["compose"]);
  assert.deepEqual(Object.fromEntries(h.out.map((m) => [m.id, m.error ?? "ok"])), { c1: "ok", c2: "rate_limited", o1: "rate_limited" });
  t += 3001;
  h.bridge.handle(call("c3", "channel.compose", { text: "c" })); await tick();
  assert.deepEqual(seen, ["compose", "compose"]);
});
await check("P2-3 refused calls do not use up the cooldown", async () => {
  let g = false;
  const seen: string[] = [];
  const h = mkBridge({ noteOpen: async () => { seen.push("open"); return { ok: true }; } }, { gesture: () => g });
  h.bridge.handle(call("a", "note.open", { ref: "Areas/T/x" }));
  g = true;
  h.bridge.handle(call("b", "note.open", { ref: "Areas/T/x" })); await tick();
  assert.deepEqual(seen, ["open"]);
});
await check("P2-3 note.open is scoped to Areas/<Name>/", async () => {
  const calls: string[] = [];
  const a = core.parseArea({ id: "a", path: "Areas/Techne", tags: ["area"], content: "# T\n\np", metadata: { channel: "c1" } })!;
  const mk = (createAreaApi: Any) => createAreaApi(a, { listPaths: async () => [], getNote: async () => ({ id: "n" }), getMessages: async () => [], compose: () => {}, roomName: () => "Techne", openNote: (r: string) => calls.push(r) });
  const api = mk(areaApiMod.createAreaApi);
  await api.noteOpen("Areas/Techne/Plan");
  for (const bad of ["Journal/2026/10-01/secret", "Areas/Atlas/Secret", "Areas/Techne/../Atlas/x", "Areas/Techne", "01JXYZ", "/etc/passwd"]) await assert.rejects(api.noteOpen(bad), /out_of_scope/, bad);
  assert.deepEqual(calls, ["Areas/Techne/Plan"]);
});
await check("P2-3 gestureFresh: needs focus in the frame and a live activation", () => {
  const f = guard.gestureFresh as Any;
  assert.equal(f({ iframeFocused: true, userActive: true, focusedAt: null, now: 10_000 }), true);
  assert.equal(f({ iframeFocused: false, userActive: true, focusedAt: null, now: 10_000 }), false, "a tap on the host UI is not a tap in the frame");
  assert.equal(f({ iframeFocused: true, userActive: false, focusedAt: null, now: 10_000 }), false);
  assert.equal(f({ iframeFocused: true, userActive: null, focusedAt: 6_000, now: 10_000 }), true, "no userActivation API: focus entered within 5 s");
  assert.equal(f({ iframeFocused: true, userActive: null, focusedAt: 4_000, now: 10_000 }), false);
  assert.equal(f({ iframeFocused: true, userActive: null, focusedAt: null, now: 10_000 }), false);
});

// ---------------------------------------------------------------- P2-4
await check("P2-4 path listing is cached for 10 s, shared and de-duplicated in flight", async () => {
  let t = 0, n = 0;
  const c = cache.createPathCache(async () => { n++; await tick(); return [{ id: String(n), path: "Areas/X" }]; }, 10_000, () => t);
  const [a, b] = await Promise.all([c.get(), c.get()]);
  assert.equal(n, 1, "in-flight request shared");
  assert.equal(a, b);
  t = 9_999; await c.get(); assert.equal(n, 1, "fresh");
  t = 10_001; await c.get(); assert.equal(n, 2, "expired");
  await c.get(true); assert.equal(n, 3, "forced");
});
await check("P2-4 a failed listing is not cached", async () => {
  let n = 0;
  const c = cache.createPathCache(async () => { n++; if (n === 1) throw new Error("down"); return []; }, 10_000, () => 0);
  await assert.rejects(c.get(), /down/);
  await c.get(); assert.equal(n, 2);
});
await check("P2-4 visibility reload is debounced to once per 30 s", () => {
  const s = cache.shouldReload as Any;
  assert.equal(s(null, 1000), true);
  assert.equal(s(1000, 20_000), false);
  assert.equal(s(1000, 31_001), true);
});

// ---------------------------------------------------------------- P3
await check("P3-1 compose returns the room it drafted into", async () => {
  const a = core.parseArea({ id: "a", path: "Areas/Techne", tags: ["area"], content: "# T\n\np", metadata: { channel: "c1,c2" } })!;
  const api = (areaApiMod.createAreaApi as Any)(a, { listPaths: async () => [], getNote: async () => ({ id: "n" }), getMessages: async () => [], compose: () => {}, roomName: (c: string) => `room-${c}`, openNote: () => {} });
  assert.deepEqual(await api.channelCompose("hi"), { ok: true, room: "room-c1" });
});
await check("P3-5 dead exports are gone", () => {
  assert.equal((core as Any).BRIDGE_METHODS, undefined);
});
await check("P3-5 the production frame has no probe branch", () => {
  assert.doesNotMatch(readFileSync(new URL("../src/areas/AreaFrame.tsx", import.meta.url), "utf8"), /onProbe|probe/i);
});
await check("P3-5 areas tab dedupes on Back (replace of an area tab with an Areas tab elsewhere)", async () => {
  const { openTab, EMPTY_TABS } = await import("../src/tabs.ts");
  let n = 0; const id = () => `t${++n}`;
  let s = openTab(EMPTY_TABS, { kind: "areas", title: "Areas" }, "focus", id);
  s = openTab(s, { kind: "area", path: "Areas/Techne", title: "Techne" }, "new", id);
  s = openTab(s, { kind: "areas", title: "Areas" }, "replace", id);
  assert.equal(s.tabs.filter((t) => t.kind === "areas").length, 1);
  assert.equal(s.tabs.find((t) => t.id === s.active)?.kind, "areas");
});

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nareasR3: ok");
