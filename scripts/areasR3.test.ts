// Carried over from T-73c round 3: the checks that outlive the area bridge (gate, tabs, draft append, Tauri CSP).
// Run: node --experimental-strip-types scripts/areasR3.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as gate from "../src/interface/selftest/gate.ts";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const opt = async (p: string): Promise<Any> => import(p).catch(() => ({}));

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- P1-1
await check("P1-1 tauri.conf.json sets a frame-src about: CSP (map form); T-335: and no remote load but published media", () => {
  const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const csp = conf.app.security.csp;
  assert.ok(csp && typeof csp === "object", "csp is the map form");
  assert.equal(csp["frame-src"], "about:");
  // T-335: nothing a note or message names is fetched: every fetching directive is local sources only, except published media
  // on the hub's tailnet host (port 8444, which Funnel can't serve). The sealed frames inherit this and add their own.
  assert.equal(csp["default-src"], "'self'");
  assert.equal(csp["object-src"], "'none'");
  const PUBLISH = "https://*.ts.net:8444";
  const LOCAL = new Set(["'self'", "data:", "blob:", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", "ipc:", "http://ipc.localhost",
    "unimedia:", "http://unimedia.localhost", "http://127.0.0.1:*", "about:", "'none'"]);
  for (const [d, v] of Object.entries(csp as Record<string, string>)) {
    for (const src of v.split(/\s+/)) {
      const ok = LOCAL.has(src) || (src === PUBLISH && (d === "img-src" || d === "media-src"));
      assert.ok(ok, `${d} allows ${src}`);
    }
  }
  for (const d of ["script-src", "style-src", "img-src", "media-src", "connect-src", "font-src", "worker-src"]) assert.ok(csp[d], `${d} is set`);
  assert.ok(csp["script-src"].includes("'unsafe-inline'"), "the sealed frames' inline scripts still run (they inherit this policy)");
  assert.deepEqual(conf.app.security.dangerousDisableAssetCspModification, ["script-src", "style-src"], "no nonce turns 'unsafe-inline' off");
});
// ---------------------------------------------------------------- P2-1
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 WebKitGTK/2.46";
const pass = { platform: "linux", passedAt: "2026-10-08T00:00:00Z", appVersion: "1.2.3", userAgent: UA, mode: "sealed" };
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


await check("compose draft is appended after a blank line, never replacing", async () => {
  const { appendDraft } = await import("../src/areas/composeDraft.ts");
  assert.equal(appendDraft(undefined, "hi"), "hi");
  assert.equal(appendDraft("   ", "hi"), "hi");
  assert.equal(appendDraft("old draft ", "hi"), "old draft\n\nhi");
  // "Say it" with no words leaves the draft alone (from the retired simpleR17 test)
  assert.equal(appendDraft("half a thought", ""), "half a thought");
  assert.equal(appendDraft(undefined, ""), "");
  assert.equal(appendDraft("a", "b"), "a\n\nb");
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

// ---------------------------------------------------------------- T-74e approved-code mode
const probeMod: Any = await opt("../src/interface/selftest/probe.ts");
const ALL_IDS: string[] = (probeMod.PROBE_CHECKS ?? []).map((c: Any) => c.id);
const report = (failing: string[]) => Object.fromEntries(ALL_IDS.map((id) => [id, !failing.includes(id)]));
await check("T-74e evaluateProbe mode: all pass → sealed; only WebRTC checks fail → approved-code; anything else → failed", () => {
  assert.ok(ALL_IDS.length > 10);
  assert.equal(probeMod.evaluateProbe(report([])).mode, "sealed");
  assert.equal(probeMod.evaluateProbe(report(["webrtc"])).mode, "approved-code");
  assert.equal(probeMod.evaluateProbe(report(["webrtcChild"])).mode, "approved-code");
  assert.equal(probeMod.evaluateProbe(report(["webrtc", "webrtcChild"])).mode, "approved-code");
  assert.equal(probeMod.evaluateProbe(report(["webrtc", "fetch"])).mode, "failed");
  assert.equal(probeMod.evaluateProbe(report(["webrtcChild", "navParse"])).mode, "failed");
  assert.equal(probeMod.evaluateProbe(report(["cookie"])).mode, "failed");
  assert.equal(probeMod.evaluateProbe({}).mode, "failed", "no evidence at all");
  // a non-WebRTC check that is missing (not reported true) is not positive evidence
  const r = report(["webrtc"]) as Any; delete r.storage;
  assert.equal(probeMod.evaluateProbe(r).mode, "failed");
  const r2 = report(["webrtc"]) as Any; r2.storage = "yes";
  assert.equal(probeMod.evaluateProbe(r2).mode, "failed", "only exactly true counts");
  assert.equal(probeMod.evaluateProbe(report(["webrtc"])).pass, false, "approved-code is not a pass");
});
const UA2 = UA;
const stored = (mode?: string) => { const { mode: _m, ...rest } = pass; return { ...rest, ...(mode ? { mode } : {}) }; }; // no mode = a record written before T-74e
await check("T-74e gate decision table: all pass / only webrtc fails / webrtc + another fails / no result", () => {
  const g = gate.gateMode as Any;
  assert.equal(g("linux", "1.2.3", stored("sealed"), UA2, []), "sealed");
  assert.equal(g("linux", "1.2.3", gate.parseSelfTest(JSON.stringify(stored())), UA2, []), "sealed", "an old stored record without a mode parses as a sealed pass");
  assert.equal(g("linux", "1.2.3", stored(), UA2, []), "closed", "an unparsed record with no mode is not trusted");
  assert.equal(g("linux", "1.2.3", stored("approved-code"), UA2, []), "approved-code");
  assert.equal(g("linux", "1.2.3", null, UA2, []), "closed", "no result");
  assert.equal(g("linux", "1.2.3", stored("approved-code"), UA2 + "x", []), "closed", "webview changed");
  assert.equal(g("linux", "1.2.4", stored("approved-code"), UA2, []), "closed", "version changed");
  assert.equal(g("linux", "1.2.3", stored("failed"), UA2, []), "closed", "a failed result never opens");
  assert.equal(g("mac", "9", null, "", ["mac"]), "sealed", "the proven constant is sealed");
  assert.equal(gate.liveAreaApps("linux", "1.2.3", stored("approved-code") as Any, UA2, []), true);
});
await check("T-77b the pass key includes the wry/tauri runtime: a change closes the gate", () => {
  const g = gate.gateMode as Any;
  const rt = { ...stored("sealed"), runtime: "wry 0.55.1 tauri 2.11.6" };
  assert.equal(g("linux", "1.2.3", rt, UA2, [], "wry 0.55.1 tauri 2.11.6"), "sealed");
  assert.equal(g("linux", "1.2.3", rt, UA2, [], "wry 0.56.0 tauri 2.11.6"), "closed", "wry bumped");
  assert.equal(g("linux", "1.2.3", rt, UA2, [], "wry 0.55.1 tauri 2.12.0"), "closed", "tauri bumped");
  assert.equal(g("linux", "1.2.3", stored("sealed"), UA2, [], "wry 0.55.1 tauri 2.11.6"), "closed", "a pass stored without a runtime re-runs");
  assert.equal(g("linux", "1.2.3", rt, UA2, [], null), "closed", "runtime unknown stays closed");
  assert.equal(g("linux", "1.2.3", rt, UA2, []), "sealed", "callers that do not pass a runtime are unchanged");
  assert.equal(gate.parseSelfTest(JSON.stringify(rt))?.runtime, "wry 0.55.1 tauri 2.11.6", "parse keeps the runtime");
});
await check("T-74e parse/store keep the mode; only the two modes are accepted", () => {
  assert.equal(gate.parseSelfTest(JSON.stringify(stored("approved-code")))?.mode, "approved-code");
  assert.equal(gate.parseSelfTest(JSON.stringify(stored()))?.mode, "sealed");
  assert.equal(gate.parseSelfTest(JSON.stringify(stored("failed"))), null);
  assert.equal(gate.parseSelfTest(JSON.stringify(stored("open"))), null);
});
await check("T-74e run decision: approved-code runs only a status-ok app; updated re-asks; sealed keeps the notice", () => {
  const d = (gate as Any).runDecision as Any;
  assert.equal(d("sealed", "none"), "ask");
  assert.equal(d("sealed", "ok"), "run");
  assert.equal(d("sealed", "updated"), "run-notice");
  assert.equal(d("approved-code", "none"), "ask");
  assert.equal(d("approved-code", "ok", "approved-code"), "run");
  assert.equal(d("approved-code", "updated", "approved-code"), "ask-updated");
  assert.equal(d("closed", "ok"), "closed");
  assert.equal(d("closed", "updated"), "closed");
  assert.equal(d("closed", "none"), "closed");
});
await check("T-74f: runDecision tests sealed explicitly; an unknown mode is closed", () => {
  const d = (gate as Any).runDecision as Any;
  for (const m of ["bogus", undefined, null, "Sealed", "", 0, {}]) for (const st of ["none", "ok", "updated"]) assert.equal(d(m, st), "closed", `${String(m)}/${st}`);
});
await check("T-74f: a sealed-mode (or unrecorded) grant asks again once in approved-code mode", () => {
  const d = (gate as Any).runDecision as Any;
  assert.equal(d("approved-code", "ok", "sealed"), "ask-updated");
  assert.equal(d("approved-code", "ok", undefined), "ask-updated");
  assert.equal(d("approved-code", "ok", "approved-code"), "run");
  assert.equal(d("approved-code", "updated", "approved-code"), "ask-updated");
  assert.equal(d("sealed", "ok", "approved-code"), "run");
  assert.equal(d("sealed", "ok", "sealed"), "run");
  assert.equal(d("sealed", "updated", "sealed"), "run-notice");
});

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nareasR3: ok");
