// Carried over from T-73c round 3: the checks that outlive the area bridge (gate, path cache, tabs, draft append, Tauri CSP).
// Run: node --experimental-strip-types scripts/areasR3.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as gate from "../src/interface/selftest/gate.ts";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const opt = async (p: string): Promise<Any> => import(p).catch(() => ({}));
const cache: Any = await opt("../src/areas/pathCache.ts");

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- P1-1
await check("P1-1 tauri.conf.json sets a frame-src about: CSP (map form, only what is needed)", () => {
  const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const csp = conf.app.security.csp;
  assert.ok(csp && typeof csp === "object", "csp is the map form");
  assert.equal(csp["frame-src"], "about:");
  assert.deepEqual(Object.keys(csp), ["frame-src"], "no other directive: nothing else can break");
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

await check("compose draft is appended after a blank line, never replacing", async () => {
  const { appendDraft } = await import("../src/areas/composeDraft.ts");
  assert.equal(appendDraft(undefined, "hi"), "hi");
  assert.equal(appendDraft("   ", "hi"), "hi");
  assert.equal(appendDraft("old draft ", "hi"), "old draft\n\nhi");
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
