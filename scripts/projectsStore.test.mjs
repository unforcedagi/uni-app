// T-302 review f97fx1ji P1: the projects store on its own (the real store.ts, loaded through Vite in Node), with a native side that can
// hold a read. Changing the vault while a read of the old one is out must drop it at once: nothing of the old vault is shown or kept.
// Run: node scripts/projectsStore.test.mjs
import assert from "node:assert/strict";
import { createServer } from "vite";

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
Object.defineProperty(globalThis.localStorage, Symbol.iterator, { value: () => mem.keys() });
const keys = () => [...mem.keys()];
const held = [];
let hold = false;
const NODES = { uni: [{ id: "a1", path: "Areas/Larder", tags: ["node", "area"], metadata: { channel: "r1" } }, { id: "p1", path: "Projects/Jam labels", tags: ["node", "project"], metadata: { parent: "a1", folder: "~/jam/labels" } }], other: [] };
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args = {}) => {
      if (hold) await new Promise((r) => held.push(r));
      if (cmd === "vault_query") return args.tag === "node" ? (NODES[args.vault] ?? []).slice(args.offset ?? 0) : [];
      if (cmd === "vault_query_meta") return [];
      return null;
    },
    transformCallback: () => 0,
  },
  addEventListener() {}, removeEventListener() {},
};
globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
// Object.keys(localStorage) is how the store lists its copies
const realKeys = Object.keys;
Object.keys = (o) => (o === globalThis.localStorage ? keys() : realKeys(o));

const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error", optimizeDeps: { noDiscovery: true } });
let failed = 0;
const check = async (name, f) => { try { await f(); console.log("ok  ", name); } catch (e) { failed++; console.log("FAIL", name, e.message); } };
try {
  const profile = await server.ssrLoadModule("/src/areas/profile.ts");
  const store = await server.ssrLoadModule("/src/projects/store.ts");
  const uni = profile.defaultProfile("uni"), other = profile.defaultProfile("other");
  const settle = () => new Promise((r) => setTimeout(r, 30));

  await check("a read of vault uni finishes and shows its project, kept for identity A on uni", async () => {
    profile.setActiveProfile(uni);
    store.setWorkOwner("A");
    await store.refreshWork();
    assert.deepEqual(store.workSnapshot().work.projects.map((p) => p.name), ["Jam labels"]);
    assert.deepEqual(keys(), ["uni.work.v3:A:uni"]);
  });

  await check("the vault changes while a read of the old one is out: the old vault's work is gone at once, and the late answer is dropped", async () => {
    mem.clear();
    store.setWorkOwner(null); store.setWorkOwner("A");
    profile.setActiveProfile(uni);
    await store.refreshWork();
    assert.deepEqual(store.workSnapshot().work.projects.map((p) => p.name), ["Jam labels"], "vault uni's work is on screen");
    // the next read of vault uni is held (a slow vault); then the vault changes
    hold = true;
    const p = store.refreshWork();
    await settle();
    assert.ok(held.length > 0, "the read is out");
    profile.setActiveProfile(other);
    // at once, before anything else runs: nothing of vault uni is shown
    assert.deepEqual(store.workSnapshot().work.projects, [], "the old vault's projects are not shown after the switch");
    hold = false; for (const r of held.splice(0)) r();
    await p; await settle();
    assert.deepEqual(store.workSnapshot().work.projects, [], "the late answer of vault uni is not published under vault other");
    assert.ok(!keys().includes("uni.work.v3:A:other"), "nor kept under vault other");
  });
} finally { await server.close(); }
if (failed) process.exit(1);
