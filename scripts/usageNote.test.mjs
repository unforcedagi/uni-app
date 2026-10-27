// T-319: the usage note's reads (src/usage/usageNote.ts, loaded through Vite in Node), with a native side whose answers come back in the
// order a test says. Refresh, focus and the timer may all read at once: an older answer must never be shown over a newer one.
// Run: node scripts/usageNote.test.mjs
import assert from "node:assert/strict";
import { createServer } from "vite";

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const out = [];
let version = 0;
globalThis.window = { __TAURI_INTERNALS__: { invoke: (cmd) => new Promise((resolve) => {
  if (cmd !== "vault_note") return resolve(null);
  const v = ++version;
  out.push(() => resolve({ note: { id: "u1", updatedAt: `v${v}`, metadata: {} } }));
}), transformCallback: () => 0 } };
const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
let failed = 0;
try {
  const u = await server.ssrLoadModule("/src/usage/usageNote.ts");
  const first = u.loadUsage(), second = u.loadUsage();
  out[1](); await second;
  out[0](); await first;
  const seen = JSON.parse(localStorage.getItem("uni.usage.v1"));
  try { assert.equal(seen.updatedAt, "v2", "the older answer, landing last, is not shown over the newer"); console.log("ok   an older answer landing last is not shown over a newer one"); }
  catch (e) { failed++; console.log("FAIL", e.message); }
} finally { await server.close(); }
if (failed) process.exit(1);
