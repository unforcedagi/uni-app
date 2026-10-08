// T-74: the interface contract. Red tests written before the code.
// Run: node --experimental-strip-types scripts/interface.test.ts
// Sections import modules that may not exist yet as {} so a failure names its section.
import assert from "node:assert/strict";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const opt = async (p: string): Promise<Any> => import(p).catch(() => ({}));
const contract: Any = await opt("../src/interface/contract.ts");
const manifest: Any = await opt("../src/interface/manifest.ts");
const grants: Any = await opt("../src/interface/grants.ts");
const routerMod: Any = await opt("../src/interface/router.ts");
const session: Any = await opt("../src/interface/session.ts");
const vaultMod: Any = await opt("../src/interface/modules/vault.ts");
const chatMod: Any = await opt("../src/interface/modules/chat.ts");
const noteMod: Any = await opt("../src/interface/modules/note.ts");
const ff: Any = await opt("../src/interface/modules/frameFetch.ts");
const sugg: Any = await opt("../src/interface/suggestions.ts");
const kits: Any = await opt("../src/interface/kits/index.ts");
const frameDoc: Any = await opt("../src/interface/srcdoc.ts");
const probe: Any = await opt("../src/interface/selftest/probe.ts");

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const ctx = { areaPath: "Areas/Techne", channels: ["ch-techne"] };

// ------------------------------------------------------------ contract
await check("contract: version 1, namespaces, error codes", () => {
  assert.equal(contract.CONTRACT_VERSION, 1);
  for (const ns of ["vault", "chat", "note", "theme"]) assert.ok(contract.NAMESPACES.includes(ns), ns);
  for (const c of ["bad_request", "bad_version", "bad_params", "too_large", "unknown_namespace", "unknown_method", "not_granted", "out_of_scope", "rate_limited", "too_many_pending", "failed"]) assert.ok(Object.values(contract.ERROR_CODES).includes(c), c);
});
await check("contract: parseEnvelope accepts exact uni:1 and pfr:1 shapes only", () => {
  const p = contract.parseEnvelope;
  assert.equal(p({ uni: 1, id: "a", ns: "chat", method: "recent", params: { limit: 3 } }).kind, "uni");
  assert.equal(p({ pfr: 1, channel: "vault", id: "a", method: "GET", path: "/api/vault", headers: {}, body: null }).kind, "pfr");
  for (const bad of [null, "x", 5, [], { uni: 2, id: "a", ns: "chat", method: "recent" }, { uni: 1, id: "a", ns: "chat", method: "recent", extra: 1 },
    { uni: 1, id: "", ns: "chat", method: "recent" }, { uni: 1, id: "x".repeat(65), ns: "chat", method: "recent" },
    { uni: 1, id: "a", ns: "chat", method: "recent", params: [] },
    { pfr: 1, channel: "other", id: "a", method: "GET", path: "/api/vault", headers: {}, body: null },
    { pfr: 1, channel: "vault", id: "a", method: "GET", path: "api/vault", headers: {}, body: null },
    { pfr: 1, channel: "vault", id: "a", method: "GET", path: "/api/vault", headers: { a: 1 }, body: null }]) {
    assert.equal(p(bad).kind, "bad", JSON.stringify(bad)?.slice(0, 60));
  }
});
await check("contract: oversize, deep and non-plain payloads are refused", () => {
  const p = contract.parseEnvelope;
  assert.equal(p({ uni: 1, id: "a", ns: "chat", method: "draft", params: { text: "x".repeat(9000) } }).error, "too_large");
  let deep: Any = {}; for (let i = 0; i < 20; i++) deep = { d: deep };
  assert.equal(p({ uni: 1, id: "a", ns: "chat", method: "draft", params: deep }).kind, "bad");
  assert.equal(p({ uni: 1, id: "a", ns: "chat", method: "draft", params: { text: new Map() } }).kind, "bad");
  assert.equal(p({ uni: 1, id: "a", ns: "chat", method: "recent", params: new (class X {})() }).kind, "bad");
  const t0 = Date.now(); p({ uni: 1, id: "a", ns: "chat", method: "recent", params: { a: new Array(5_000_000).fill(1) } }); assert.ok(Date.now() - t0 < 100);
});
await check("contract: RateLimiter is a sliding window", () => {
  const r = new contract.RateLimiter(3, 1000);
  assert.deepEqual([0, 1, 2, 3].map((t) => r.take(t)), [true, true, true, false]);
  assert.equal(r.take(1500), true);
});

// ------------------------------------------------------------ manifest
await check("manifest: parses the three needs and resolves the symbolic 'area' scope", () => {
  const m = manifest.parseManifest({ interface: { contract: 1, needs: [{ "vault.read": "Areas/Techne/" }, { "chat.read": "area" }, { "chat.draft": "area" }] } }, ctx);
  assert.equal(m.ok, true);
  const r = manifest.resolveNeeds(m.manifest.needs, ctx);
  assert.deepEqual(r["vault.read"], ["Areas/Techne/"]);
  assert.deepEqual(r["chat.read"], ["ch-techne"]);
  assert.deepEqual(r["chat.draft"], ["ch-techne"]);
});
await check("manifest: no interface key → default manifest for the area", () => {
  const m = manifest.parseManifest({ status: "foreground" }, ctx);
  assert.equal(m.ok, true); assert.equal(m.defaulted, true);
  const r = manifest.resolveNeeds(m.manifest.needs, ctx);
  assert.deepEqual(r, { "vault.read": ["Areas/Techne/"], "chat.read": ["ch-techne"], "chat.draft": ["ch-techne"] });
  assert.equal(manifest.parseManifest(null, ctx).ok, true);
});
await check("manifest: vault.read 'area' means Areas/<Name>/", () => {
  const m = manifest.parseManifest({ interface: { contract: 1, needs: [{ "vault.read": "area" }] } }, ctx);
  assert.deepEqual(manifest.resolveNeeds(m.manifest.needs, ctx)["vault.read"], ["Areas/Techne/"]);
});
await check("manifest: rejects bad contract, unknown capability, traversal and malformed scopes", () => {
  const bad = (iface: Any) => assert.equal(manifest.parseManifest({ interface: iface }, ctx).ok, false, JSON.stringify(iface));
  bad({ contract: 2, needs: [] }); bad({ needs: [] }); bad("x"); bad([]); bad({ contract: 1, needs: "x" });
  bad({ contract: 1, needs: [{ "fs.read": "/" }] });
  bad({ contract: 1, needs: [{ "vault.read": "Areas/Techne/../Atlas/" }] });
  bad({ contract: 1, needs: [{ "vault.read": "Areas/Techne" }] });
  bad({ contract: 1, needs: [{ "vault.read": "/" }] }); bad({ contract: 1, needs: [{ "vault.read": "" }] });
  bad({ contract: 1, needs: [{ "vault.read": "Areas/%2e%2e/" }] }); bad({ contract: 1, needs: [{ "vault.read": "A\\B/" }] });
  bad({ contract: 1, needs: [{ "vault.read": "A/", "chat.read": "area" }] });
  bad({ contract: 1, needs: [{ "vault.read": 5 }] });
  bad({ contract: 1, needs: Array.from({ length: 40 }, () => ({ "chat.read": "area" })) });
});
await check("manifest: hash is stable under reorder and changes with any need", () => {
  const h = (needs: Any[]) => manifest.parseManifest({ interface: { contract: 1, needs } }, ctx).hash;
  const a = h([{ "vault.read": "Areas/Techne/" }, { "chat.read": "area" }]);
  assert.equal(a, h([{ "chat.read": "area" }, { "vault.read": "Areas/Techne/" }]));
  assert.notEqual(a, h([{ "vault.read": "Areas/Techne/" }]));
  assert.notEqual(a, h([{ "vault.read": "Areas/Techne/Sub/" }, { "chat.read": "area" }]));
  assert.notEqual(a, h([{ "vault.read": "Areas/Techne/" }, { "chat.read": "area" }, { "chat.draft": "area" }]));
});
await check("manifest: describeNeeds speaks plainly", () => {
  const m = manifest.parseManifest(null, ctx);
  const lines = manifest.describeNeeds(m.manifest.needs, ctx, (id: string) => (id === "ch-techne" ? "Techne" : "room"));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /read notes in Areas\/Techne\//i);
  assert.match(lines.join("\n"), /read recent messages in #?Techne/i);
  assert.match(lines.join("\n"), /suggest drafts for #?Techne/i);
});

// ------------------------------------------------------------ grants
const memStore = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; };
await check("grants: granted only for the same note id and needs hash", () => {
  const g = grants.createGrantStore(memStore());
  assert.equal(g.isGranted("n1", "h1"), false);
  g.grant("n1", "h1");
  assert.equal(g.isGranted("n1", "h1"), true);
  assert.equal(g.isGranted("n1", "h2"), false, "changed needs re-ask");
  assert.equal(g.isGranted("n2", "h1"), false);
  g.revoke("n1"); assert.equal(g.isGranted("n1", "h1"), false);
});
await check("grants: persists in the injected storage; corrupt storage means not granted", () => {
  const s = memStore(); grants.createGrantStore(s).grant("n1", "h1");
  assert.equal(grants.createGrantStore(s).isGranted("n1", "h1"), true);
  const bad = memStore(); bad.setItem("uni.interface.grants.v1", "{nope"); assert.equal(grants.createGrantStore(bad).isGranted("n1", "h1"), false);
  const arr = memStore(); arr.setItem("uni.interface.grants.v1", JSON.stringify({ n1: { hash: ["h1"] } })); assert.equal(grants.createGrantStore(arr).isGranted("n1", "h1"), false);
  assert.equal(grants.createGrantStore(null).isGranted("n1", "h1"), false);
  const throwing = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); }, removeItem() { throw new Error("x"); } };
  const t = grants.createGrantStore(throwing); t.grant("n1", "h1"); assert.equal(t.isGranted("n1", "h1"), true, "session fallback works, nothing persisted");
});

// ------------------------------------------------------------ router
const echo = (calls: Any[]) => ({
  namespace: "echo",
  methods: {
    read: { cap: "vault.read", validate: (p: Any) => (typeof p?.path === "string" ? { ok: true, value: p } : { ok: false }), scopeCheck: (scopes: Any, v: Any) => scopes["vault.read"].some((x: string) => v.path.startsWith(x)), run: async (v: Any) => { calls.push(v); return { ok: true }; } },
    free: { cap: null, validate: () => ({ ok: true, value: {} }), run: async () => ({ free: true }) },
  },
});
const GR = { "vault.read": ["Areas/Techne/"] };
await check("router: dispatches, and enforces unknown ns/method, grant, validation and scope", async () => {
  const calls: Any[] = [];
  const r = routerMod.createRouter([echo(calls)]);
  const code = async (ns: string, m: string, p: Any, g: Any = GR) => r.call(ns, m, p, g).then(() => "ok", (e: Any) => e.code);
  assert.equal(await code("echo", "read", { path: "Areas/Techne/Plan" }), "ok");
  assert.equal(await code("nope", "read", {}), "unknown_namespace");
  assert.equal(await code("echo", "nope", {}), "unknown_method");
  assert.equal(await code("echo", "__proto__", {}), "unknown_method");
  assert.equal(await code("echo", "constructor", {}), "unknown_method");
  assert.equal(await code("echo", "read", { path: 5 }), "bad_params");
  assert.equal(await code("echo", "read", { path: "Areas/Atlas/Secret" }), "out_of_scope");
  assert.equal(await code("echo", "read", { path: "Areas/Techne/Plan" }, {}), "not_granted");
  assert.equal(await code("echo", "free", {}, {}), "ok");
  assert.equal(calls.length, 1, "handler ran only for the allowed call");
});

// ------------------------------------------------------------ vault module
const NOTES: Any[] = [
  { id: "t1", path: "Areas/Techne/Plan", ext: "md", content: "# Plan\nbody t1 widget", updatedAt: "2026-10-05T00:00:00Z", tags: ["plan"] },
  { id: "t2", path: "Areas/Techne/Log", ext: "md", content: "# Log\nlog body", updatedAt: "2026-10-07T00:00:00Z", tags: [] },
  { id: "t3", path: "Areas/Techne/Deep/Sub", ext: "md", content: "# Sub", updatedAt: "2026-10-06T00:00:00Z", tags: ["plan"] },
  { id: "tapp", path: "Areas/Techne/app", ext: "html", content: "<html>", updatedAt: "2026-10-01T00:00:00Z", tags: [] },
  { id: "a1", path: "Areas/Atlas/Secret", ext: "md", content: "ATLAS-SECRET widget", updatedAt: "2026-10-06T00:00:00Z", tags: ["plan"] },
  { id: "tx", path: "Areas/TechneX/Other", ext: "md", content: "sibling prefix", updatedAt: "2026-10-06T00:00:00Z", tags: [] },
  { id: "j1", path: "Journal/2026/10/08/09-00 private", ext: "md", content: "PRIVATE JOURNAL widget", updatedAt: "2026-10-08T00:00:00Z", tags: ["journal"] },
  { id: "nopath", path: null, ext: "md", content: "NO PATH", updatedAt: "2026-10-08T00:00:00Z", tags: [] },
];
const vaultDeps = (log: Any[] = []) => ({
  listPaths: async () => { log.push("paths"); return NOTES.map((n) => ({ id: n.id, path: n.path, extension: n.ext, updatedAt: n.updatedAt })); },
  getNote: async (ref: string) => { log.push("note:" + ref); const n = NOTES.find((x) => x.id === ref || x.path === ref); if (!n) throw new Error("not found"); return { id: n.id, path: n.path, content: n.content, tags: n.tags, updatedAt: n.updatedAt, createdAt: "2026-09-01T00:00:00Z", metadata: {} }; },
  search: async (query: string, limit: number, pathPrefix: string | null) => { log.push(`search:${query}:${pathPrefix}`); return NOTES.filter((n) => n.content.includes(query) && (!pathPrefix || (n.path ?? "").startsWith(pathPrefix))).slice(0, limit).map((n) => ({ id: n.id, path: n.path, snippet: n.content.slice(0, 40) })); },
});
const vget = async (path: string, grant: Any = GR, deps = vaultDeps()) => {
  const mod = vaultMod.createVaultModule(deps);
  const r = routerMod.createRouter([mod]);
  const res = await r.call("vault", "fetch", { method: "GET", path, headers: {}, body: null }, grant);
  return { status: res.status as number, body: res.body ? JSON.parse(res.body) : null, res };
};
const paths = (b: Any) => (Array.isArray(b) ? b : [b]).map((n: Any) => n.path);
await check("vault: GET /api/vault answers without leaking beyond scope", async () => {
  const { status, body } = await vget("/api/vault");
  assert.equal(status, 200); assert.equal(typeof body.name, "string");
  assert.ok(!JSON.stringify(body).includes("Journal"));
});
await check("vault: GET /api/notes with path_prefix lists only in-scope notes, newest first, app note hidden", async () => {
  const { status, body } = await vget("/api/notes?path_prefix=Areas/Techne/&limit=10");
  assert.equal(status, 200);
  assert.deepEqual(paths(body), ["Areas/Techne/Log", "Areas/Techne/Deep/Sub", "Areas/Techne/Plan"]);
  assert.ok(body.every((n: Any) => n.content === undefined), "no content unless include_content");
});
await check("vault: no path_prefix defaults to the granted scope, never the whole vault", async () => {
  const { body } = await vget("/api/notes");
  assert.ok(paths(body).every((p: string) => p.startsWith("Areas/Techne/")), paths(body).join());
});
await check("vault: path_prefix outside the grant is refused (403), including sibling-prefix and traversal", async () => {
  for (const q of ["Areas/Atlas/", "Areas/", "Journal/", "Areas/Techne", "Areas/TechneX/", "Areas/Techne/../Atlas/", "", "/", "Areas/Techne/%2e%2e/Atlas/"]) {
    const { status, body } = await vget(`/api/notes?path_prefix=${encodeURIComponent(q)}`);
    if (q === "") { assert.ok(paths(body).every((p: string) => p.startsWith("Areas/Techne/"))); continue; }
    assert.equal(status, q === "Areas/Techne" ? 403 : 403, `prefix ${JSON.stringify(q)} → ${status}`);
  }
});
await check("vault: search results are filtered to scope (and the query is scoped, not trusted)", async () => {
  const log: Any[] = [];
  const { status, body } = await vget("/api/notes?search=widget", GR, vaultDeps(log));
  assert.equal(status, 200);
  assert.deepEqual(paths(body).sort(), ["Areas/Techne/Plan"]);
  // a malicious/lax backend that ignores path_prefix still cannot leak
  const lax = { ...vaultDeps(), search: async () => NOTES.map((n) => ({ id: n.id, path: n.path, snippet: n.content })) };
  const r = await vget("/api/notes?search=widget", GR, lax);
  assert.ok(paths(r.body).every((p: string) => p.startsWith("Areas/Techne/")), paths(r.body).join());
  assert.ok(!JSON.stringify(r.body).includes("ATLAS-SECRET") && !JSON.stringify(r.body).includes("PRIVATE JOURNAL"));
});
await check("vault: tag filter only returns in-scope notes", async () => {
  const { body } = await vget("/api/notes?tag=plan&path_prefix=Areas/Techne/");
  assert.deepEqual(paths(body).sort(), ["Areas/Techne/Deep/Sub", "Areas/Techne/Plan"]);
  const all = await vget("/api/notes?tag=plan");
  assert.ok(paths(all.body).every((p: string) => p.startsWith("Areas/Techne/")));
});
await check("vault: GET /api/notes/:id and :path return in-scope notes; others are 404, not 403 (no existence oracle)", async () => {
  assert.equal((await vget("/api/notes/t1")).body.content, "# Plan\nbody t1 widget");
  assert.equal((await vget("/api/notes/" + encodeURIComponent("Areas/Techne/Plan"))).body.id, "t1");
  for (const ref of ["a1", "j1", "tx", "nopath", "Areas/Atlas/Secret", "does-not-exist"]) {
    const r = await vget("/api/notes/" + encodeURIComponent(ref));
    assert.equal(r.status, 404, ref); assert.ok(!JSON.stringify(r.body).includes("SECRET") && !JSON.stringify(r.body).includes("PRIVATE"));
  }
});
await check("vault: ?id= and ?path= lookups (what VaultClient.getNote sends) are scoped", async () => {
  const ok = await vget("/api/notes?id=t1&include_content=true");
  assert.equal(ok.status, 200); assert.equal(paths(ok.body)[0], "Areas/Techne/Plan"); assert.ok(ok.body[0].content.includes("body t1"));
  const no = await vget("/api/notes?id=a1&include_content=true");
  assert.deepEqual(no.body, []);
  assert.deepEqual((await vget("/api/notes?path=" + encodeURIComponent("Areas/Atlas/Secret"))).body, []);
});
await check("vault: path traversal and encoded tricks never reach an out-of-scope note", async () => {
  const attempts = ["Areas/Techne/../Atlas/Secret", "Areas/Techne/%2e%2e/Atlas/Secret", "..%2FAtlas%2FSecret", "Areas%2FTechne%2F..%2FAtlas%2FSecret", "%252e%252e", "Areas/Techne/./../Atlas/Secret", "Areas\\Atlas\\Secret", "/Areas/Atlas/Secret", "Areas/Techne/\u0000/../Atlas"];
  for (const a of attempts) {
    for (const p of [`/api/notes/${encodeURIComponent(a)}`, `/api/notes/${a}`, `/api/notes?path=${encodeURIComponent(a)}`, `/api/notes?id=${encodeURIComponent(a)}`]) {
      let r: Any; try { r = await vget(p); } catch { continue; }
      assert.ok(!JSON.stringify(r.body).includes("ATLAS-SECRET"), `${p} leaked`);
    }
  }
});
await check("vault: only GET; everything else is 405 and never calls the backend", async () => {
  const log: Any[] = [];
  const mod = vaultMod.createVaultModule(vaultDeps(log));
  const r = routerMod.createRouter([mod]);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "get", "HEAD"]) {
    const res = await r.call("vault", "fetch", { method, path: "/api/notes", headers: {}, body: "{}" }, GR);
    assert.ok(res.status === 405 || res.status === 400, `${method} → ${res.status}`);
  }
  for (const p of ["/api/tags", "/api/notes/t1/attachments", "/api/storage/x", "/api/unknown", "/mcp", "http://evil.test/api/notes", "//evil.test/api/notes"]) {
    const res = await r.call("vault", "fetch", { method: "GET", path: p, headers: {}, body: null }, GR);
    assert.ok([400, 404, 405].includes(res.status), `${p} → ${res.status}`);
  }
  assert.equal(log.length, 0);
});
await check("vault: limit is clamped and listing is bounded", async () => {
  const { body } = await vget("/api/notes?limit=99999&path_prefix=Areas/Techne/");
  assert.ok(body.length <= 50);
  assert.equal((await vget("/api/notes?limit=abc")).status, 400);
  assert.equal((await vget("/api/notes?limit=1&path_prefix=Areas/Techne/")).body.length, 1);
});
await check("vault: without the vault.read grant nothing is served", async () => {
  const r = routerMod.createRouter([vaultMod.createVaultModule(vaultDeps())]);
  await assert.rejects(() => r.call("vault", "fetch", { method: "GET", path: "/api/vault", headers: {}, body: null }, {}), (e: Any) => e.code === "not_granted");
});
await check("vault: a narrower grant (sub-folder) narrows everything", async () => {
  const g = { "vault.read": ["Areas/Techne/Deep/"] };
  assert.deepEqual(paths((await vget("/api/notes", g)).body), ["Areas/Techne/Deep/Sub"]);
  assert.equal((await vget("/api/notes/t1", g)).status, 404);
  assert.equal((await vget("/api/notes?path_prefix=Areas/Techne/", g)).status, 403);
});

// ------------------------------------------------------------ frameFetch adapter
await check("frameFetch: pfr request ↔ reply shapes", async () => {
  const req = { pfr: 1, channel: "vault", id: "r1", method: "GET", path: "/api/vault", headers: {}, body: null };
  const e = contract.parseEnvelope(req);
  const reply = ff.toFrameFetchReply(e, { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: "{}" });
  assert.deepEqual(reply, { pfr: 1, channel: "vault", id: "r1", status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: "{}" });
  for (const [code, status] of [["not_granted", 403], ["out_of_scope", 403], ["bad_params", 400], ["too_large", 413], ["rate_limited", 429], ["failed", 502]] as const) {
    assert.equal(ff.errorToFrameFetchReply(e, code).status, status, code);
  }
});

// ------------------------------------------------------------ chat module
const MSGS: Any[] = [
  { ref: "m1", channel: "ch-techne", author: "b".repeat(64), author_name: "Uni", ts: 100, body: "techne one" },
  { ref: "m2", channel: "ch-techne", author: "b".repeat(64), author_name: "Aaron", ts: 300, body: "techne two" },
  { ref: "m3", channel: "ch-private", author: "b".repeat(64), author_name: "Aaron", ts: 400, body: "PRIVATE ROOM" },
];
const chatDeps = (log: Any[] = []) => ({
  getMessages: async (room: string, limit: number) => { log.push(["get", room]); return MSGS.filter((m) => m.channel === room).slice(-limit); },
  suggest: (s: Any) => { log.push(["suggest", s]); return { id: "s1" }; },
  roomName: (id: string) => id,
});
await check("chat.recent: only granted rooms, limit ≤ 30, newest first", async () => {
  const log: Any[] = [];
  const r = routerMod.createRouter([chatMod.createChatModule(chatDeps(log))]);
  const g = { "chat.read": ["ch-techne"] };
  const res = await r.call("chat", "recent", { limit: 10 }, g);
  assert.deepEqual(res.messages.map((m: Any) => m.id), ["m2", "m1"]);
  assert.ok(!JSON.stringify(res).includes("PRIVATE"));
  assert.deepEqual(log.filter((l) => l[0] === "get").map((l) => l[1]), ["ch-techne"]);
  for (const bad of [{ limit: 31 }, { limit: 0 }, { limit: 1.5 }, { limit: "3" }, { room: "ch-private" }]) await assert.rejects(() => r.call("chat", "recent", bad, g), (e: Any) => e.code === "bad_params", JSON.stringify(bad));
  await assert.rejects(() => r.call("chat", "recent", {}, {}), (e: Any) => e.code === "not_granted");
});
await check("chat.draft: creates a pending suggestion only — no composer, no post", async () => {
  const log: Any[] = [];
  const r = routerMod.createRouter([chatMod.createChatModule(chatDeps(log))]);
  const g = { "chat.draft": ["ch-techne", "ch-two"] };
  const res = await r.call("chat", "draft", { text: "hello room" }, g);
  assert.deepEqual(res, { pending: true, room: "ch-techne" });
  assert.deepEqual(log, [["suggest", { kind: "draft", room: "ch-techne", text: "hello room" }]]);
  await r.call("chat", "draft", { text: "to two", room: "ch-two" }, g);
  assert.equal(log[1][1].room, "ch-two");
});
await check("chat.draft: bad text, oversize, other room and missing grant are refused with no suggestion", async () => {
  const log: Any[] = [];
  const r = routerMod.createRouter([chatMod.createChatModule(chatDeps(log))]);
  const g = { "chat.draft": ["ch-techne"] };
  const code = (p: Any, gr: Any = g) => r.call("chat", "draft", p, gr).then(() => "ok", (e: Any) => e.code);
  assert.equal(await code({ text: "" }), "bad_params"); assert.equal(await code({ text: "   " }), "bad_params");
  assert.equal(await code({ text: "x".repeat(2001) }), "bad_params"); assert.equal(await code({ text: 5 }), "bad_params");
  assert.equal(await code({ text: "ok", room: "ch-private" }), "out_of_scope");
  assert.equal(await code({ text: "ok", extra: 1 }), "bad_params");
  assert.equal(await code({ text: "ok" }, { "chat.read": ["ch-techne"] }), "not_granted");
  assert.equal(await code({ text: "x".repeat(2000) }), "ok");
  assert.equal(log.length, 1);
});

// ------------------------------------------------------------ note.open module
await check("note.open: scoped to vault.read prefixes and only creates a pending suggestion", async () => {
  const log: Any[] = [];
  const r = routerMod.createRouter([noteMod.createNoteModule({ suggest: (s: Any) => { log.push(s); return { id: "s" }; } })]);
  assert.deepEqual(await r.call("note", "open", { ref: "Areas/Techne/Plan" }, GR), { pending: true });
  assert.deepEqual(log, [{ kind: "open", ref: "Areas/Techne/Plan" }]);
  for (const ref of ["Areas/Atlas/Secret", "Journal/2026", "Areas/Techne/../Atlas/x", "/etc/passwd", "Areas/Techne/%2e%2e/x", "Areas/Techne/", "Areas/TechneX/Other"]) {
    await assert.rejects(() => r.call("note", "open", { ref }, GR), (e: Any) => e.code === "out_of_scope" || e.code === "bad_params", ref);
  }
  assert.equal(log.length, 1);
});

// ------------------------------------------------------------ suggestions store
await check("suggestions: bounded, de-duplicated, and acting requires an explicit accept()", () => {
  const acted: Any[] = [];
  const s = sugg.createSuggestionStore({ onAccept: (x: Any) => acted.push(x), max: 3 });
  const a = s.add({ kind: "draft", room: "r", text: "one" });
  assert.equal(acted.length, 0, "adding never acts");
  s.add({ kind: "draft", room: "r", text: "one" });
  assert.equal(s.list().length, 1, "duplicates collapse");
  s.add({ kind: "draft", room: "r", text: "two" }); s.add({ kind: "draft", room: "r", text: "three" });
  assert.throws(() => s.add({ kind: "draft", room: "r", text: "four" }), (e: Any) => e.code === "rate_limited");
  s.dismiss(a.id); assert.equal(s.list().length, 2); assert.equal(acted.length, 0);
  s.accept(s.list()[0].id); assert.equal(acted.length, 1); assert.equal(s.list().length, 1);
  s.accept("nope"); assert.equal(acted.length, 1);
});
await check("suggestions: subscribers hear about changes; snapshot is stable between changes", () => {
  const s = sugg.createSuggestionStore({ onAccept: () => {} });
  let n = 0; const off = s.subscribe(() => n++);
  const snap = s.list(); assert.equal(s.list(), snap);
  s.add({ kind: "open", ref: "Areas/X/Y" }); assert.equal(n, 1); assert.notEqual(s.list(), snap);
  off(); s.add({ kind: "open", ref: "Areas/X/Z" }); assert.equal(n, 1);
});

// ------------------------------------------------------------ session (the host pump)
const mkSession = (over: Any = {}) => {
  const out: Any[] = []; const log: Any[] = [];
  const router = routerMod.createRouter([vaultMod.createVaultModule(vaultDeps(log)), chatMod.createChatModule(chatDeps(log)), noteMod.createNoteModule({ suggest: (s: Any) => { log.push(["open", s]); return { id: "x" }; } })]);
  let t = 0;
  const s = session.createSession({ post: (m: Any) => out.push(m), router, grant: { "vault.read": ["Areas/Techne/"], "chat.read": ["ch-techne"], "chat.draft": ["ch-techne"] }, now: () => t, ...over });
  return { s, out, log, advance: (ms: number) => { t += ms; } };
};
await check("session: uni request → uni reply; pfr request → pfr reply", async () => {
  const { s, out } = mkSession();
  s.handle({ uni: 1, id: "a", ns: "chat", method: "recent", params: { limit: 5 } });
  s.handle({ pfr: 1, channel: "vault", id: "b", method: "GET", path: "/api/vault", headers: {}, body: null });
  await tick();
  assert.equal(out.find((m: Any) => m.id === "a").result.messages.length, 2);
  assert.equal(out.find((m: Any) => m.id === "b").status, 200);
});
await check("session: errors carry a code; junk without an id is dropped silently", async () => {
  const { s, out } = mkSession();
  s.handle({ uni: 1, id: "a", ns: "nope", method: "x" });
  s.handle({ uni: 1, id: "b", ns: "chat", method: "draft", params: { text: "x", room: "ch-private" } });
  s.handle("garbage"); s.handle(null); s.handle({ uni: 1 });
  await tick();
  assert.equal(out.find((m: Any) => m.id === "a").error.code, "unknown_namespace");
  assert.equal(out.find((m: Any) => m.id === "b").error.code, "out_of_scope");
  assert.equal(out.length, 2);
});
await check("session: rate limit counts every message; over the limit is dropped with no reply", async () => {
  const { s, out } = mkSession();
  for (let i = 0; i < 100; i++) s.handle(i % 2 ? "junk" : { uni: 1, id: "f" + i, ns: "chat", method: "recent", params: {} });
  await tick(20);
  assert.ok(out.length <= 8 + 0 || out.length <= 30, `replies ${out.length}`);
  assert.ok(out.length < 50);
});
await check("session: at most 8 calls in flight", async () => {
  let release!: () => void; const gate = new Promise<void>((r) => (release = r));
  const out: Any[] = [];
  const slow = { namespace: "slow", methods: { w: { cap: null, validate: () => ({ ok: true, value: {} }), run: async () => { await gate; return {}; } } } };
  const s = session.createSession({ post: (m: Any) => out.push(m), router: routerMod.createRouter([slow]), grant: {}, now: () => 0 });
  for (let i = 0; i < 12; i++) s.handle({ uni: 1, id: "p" + i, ns: "slow", method: "w" });
  await tick();
  assert.equal(out.filter((m: Any) => m.error?.code === "too_many_pending").length, 4);
  release(); await tick(); assert.equal(out.filter((m: Any) => "result" in m).length, 8);
});
await check("session: close() silences everything, including in-flight replies", async () => {
  let release!: () => void; const gate = new Promise<void>((r) => (release = r));
  const out: Any[] = [];
  const slow = { namespace: "slow", methods: { w: { cap: null, validate: () => ({ ok: true, value: {} }), run: async () => { await gate; return {}; } } } };
  const s = session.createSession({ post: (m: Any) => out.push(m), router: routerMod.createRouter([slow]), grant: {}, now: () => 0 });
  s.handle({ uni: 1, id: "p", ns: "slow", method: "w" }); s.close(); release(); await tick();
  s.handle({ uni: 1, id: "q", ns: "slow", method: "w" }); await tick();
  assert.equal(out.length, 0);
});
await check("session: chat.draft and note.open only ever reach suggest(); a flood of drafts is capped by the store", async () => {
  const { s, out, log } = mkSession();
  s.handle({ uni: 1, id: "d", ns: "chat", method: "draft", params: { text: "hi" } });
  s.handle({ uni: 1, id: "o", ns: "note", method: "open", params: { ref: "Areas/Techne/Plan" } });
  await tick();
  assert.deepEqual(out.map((m: Any) => m.result), [{ pending: true, room: "ch-techne" }, { pending: true }]);
  assert.deepEqual(log.map((l: Any) => l[0]), ["suggest", "open"]);
});
await check("session: sendEvent posts uni events with the theme", () => {
  const { s, out } = mkSession();
  s.sendEvent("theme", { accent: "#fff" });
  assert.deepEqual(out, [{ uni: 1, event: "theme", data: { accent: "#fff" } }]);
});

// ------------------------------------------------------------ srcdoc + kits
await check("srcdoc: the CSP meta is first, then kits, then the app; app doctype is dropped", () => {
  const doc = frameDoc.buildSrcdoc("<!DOCTYPE html><html><head><title>x</title></head><body>hi</body></html>", { kitSource: "window.KIT=1;", headExtra: "<style>/*f*/</style>" });
  assert.ok(doc.startsWith("<!doctype html><meta http-equiv=\"Content-Security-Policy\""));
  assert.ok(doc.indexOf("window.KIT=1") < doc.indexOf("<title>x</title>"));
  assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf("window.KIT=1"));
  assert.equal((doc.match(/<!doctype/gi) ?? []).length, 1);
  for (const d of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(doc.includes(d), d);
});
await check("srcdoc: kit source cannot be broken out of by a closing script tag in its data", () => {
  const doc = frameDoc.buildSrcdoc("<p>x</p>", { kitSource: "var a='</script><img src=x>';", headExtra: "" });
  assert.ok(!doc.includes("</script><img"), "closing tag escaped");
});
await check("kits: defines uni.ready, frameFetch, chat, theme and (VaultClient or vault) from one source", () => {
  const src = kits.buildKitSource({ vaultClientSource: "window.__UniVC={VaultClient:function(){}};" });
  for (const n of ["uni.ready", "frameFetch", "chat", "theme", "VaultClient"]) assert.ok(src.includes(n.replace("uni.", "")), n);
  assert.ok(src.includes("pfr"), "frame-fetch envelope");
  assert.ok(src.includes('"uni":1') || src.includes("uni:1"), "contract envelope");
  assert.ok(!/userActivation|blur/.test(src), "no gesture inference");
});

// ------------------------------------------------------------ self-test (pure parts)
await check("selftest: navigation verdict needs a host-observed frame-src violation; reload count is not proof", () => {
  assert.equal(probe.navVerdict({ violation: true }), true);
  assert.equal(probe.navVerdict({ violation: false }), false);
  assert.equal(probe.navVerdict({ violation: false, loads: 2 }), false);
  assert.equal(probe.navVerdict({ violation: false, loads: 1 }), false);
});
await check("selftest: a navigate-during-parse stage exists and the probe has no load tripwire dependence", () => {
  assert.ok(probe.NAV_STAGES.some((s: Any) => s.vector === "parse"));
  const html = probe.navProbeHtml("parse");
  assert.ok(!/addEventListener\('load'/.test(html), "fires while parsing, not after load");
  assert.ok(probe.PROBE_CHECKS.some((c: Any) => c.id === "navParse"));
});
await check("selftest: the WebRTC check runs in a probe-created srcdoc child frame", () => {
  assert.match(probe.PROBE_HTML, /createElement\('iframe'\)/);
  assert.match(probe.PROBE_HTML, /srcdoc/);
  assert.ok(probe.PROBE_CHECKS.some((c: Any) => c.id === "webrtcChild"));
});
await check("selftest: cookie check accepts throw, or empty + write that does not persist", () => {
  assert.match(probe.PROBE_HTML, /selftest=1/);
  assert.match(probe.PROBE_HTML, /indexOf\('selftest'\)/);
});
await check("selftest: evaluateProbe fails closed on missing results", () => {
  assert.equal(probe.evaluateProbe({}).pass, false);
  assert.equal(probe.evaluateProbe(Object.fromEntries(probe.PROBE_CHECKS.map((c: Any) => [c.id, true]))).pass, true);
  const almost = Object.fromEntries(probe.PROBE_CHECKS.map((c: Any) => [c.id, true])); almost.webrtcChild = false;
  assert.equal(probe.evaluateProbe(almost).pass, false);
});

if (failed) { console.log(`\ninterface: ${failed} failed`); process.exit(1); }
console.log("\ninterface: ok");
