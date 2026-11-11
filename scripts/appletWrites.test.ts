// T-335 a sealed applet that adds and changes notes: the contract 2 rules that allow it (manifest2.ts), what they become (the frame's
// needs, the card's rows, the grant's key) and the frame's two writes (modules/vault.ts), each judged on the note as it is now.
// Made-up vault and folders only. Run: node --experimental-strip-types scripts/appletWrites.test.ts
import assert from "node:assert/strict";
import { appletHostNeeds, discoverApplets, joinDiscoveries, needsGrant } from "../src/interface/sealedApplet.ts";
import { grantLines } from "../src/interface/grant2.ts";
import { grantKey, parseManifest } from "../src/interface/manifest.ts";
import { createVaultModule, type VaultNote } from "../src/interface/modules/vault.ts";
import { createRouter } from "../src/interface/router.ts";

let failed = 0;
async function check(name: string, f: () => unknown) {
  try { await f(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const book = (over: Record<string, unknown> = {}) => ({ contract: 2, id: "soup-book", name: "Soup book",
  access: [{ vault: "here", allow: [{ path: "Soups/", verbs: ["read", "create", "update"] }, { path: "Pantry/", verbs: ["read"] }] }],
  search: [{ what: "soups", vault: "here", path: "Soups/" }], ...over });

await check("a contract 2 sealed applet may read, add and change by folder; the needs say so per folder", () => {
  const h = appletHostNeeds({ applet: book() }, []);
  assert.ok(h.ok, h.ok ? "" : h.error);
  if (!h.ok) return;
  assert.deepEqual(h.resolved, { "vault.read": ["Soups/", "Pantry/"], "vault.create": ["Soups/"], "vault.update": ["Soups/"] });
  assert.deepEqual(h.prefixes, ["Soups/", "Pantry/"], "search and reads: the read folders only");
});

await check("contract 1 can't ask for a write", () => {
  const r = parseManifest({ interface: { contract: 1, needs: [{ "vault.create": "Soups/" }] } }, { areaPath: "", channels: [] });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /contract 2/);
});

await check("the card names the vault and says it adds and changes, stressed; a read-only folder is not", () => {
  const h = appletHostNeeds({ applet: book() }, []);
  if (!h.ok) throw new Error(h.error);
  const lines = grantLines(needsGrant(h.needs, "kitchen", { id: "soup-book", name: "Soup book" }), (r) => r, { ownFolder: "Soups/" });
  assert.deepEqual(lines, [
    { where: "kitchen vault", text: "Read, add and change notes in Soups/", stress: true },
    { where: "kitchen vault", text: "Read notes outside this applet's folder, in Pantry/", stress: true },
  ]);
});

await check("the grant's key changes with the writes it asks for and with the vault its note is in", async () => {
  const key = async (meta: unknown, where: string) => { const h = appletHostNeeds(meta, []); if (!h.ok) throw new Error(h.error); return grantKey(h.resolved, where); };
  const readOnly = book({ access: [{ vault: "here", allow: [{ path: "Soups/", verbs: ["read"] }, { path: "Pantry/", verbs: ["read"] }] }] });
  const a = await key({ applet: book() }, "kitchen:Soups/Soup book");
  assert.notEqual(a, await key({ applet: readOnly }, "kitchen:Soups/Soup book"), "a write added asks again");
  assert.notEqual(a, await key({ applet: book() }, "other:Soups/Soup book"), "the same note in another vault asks again");
});

await check("applets from several vaults: the first vault's id wins, the repeat is skipped and counted, each keeps its vault", () => {
  const n = (id: string, path: string) => ({ id, path, tags: ["applet"], metadata: { applet: book() } });
  const d = joinDiscoveries([discoverApplets([n("a1", "Soups/Book")], "uni"), discoverApplets([n("b1", "Soups/Book")], "kitchen")]);
  assert.deepEqual(d.entries.map((e) => [e.noteId, e.vault]), [["a1", "uni"]]);
  assert.equal(d.skipped, 1);
});

// ── the frame's writes ──
type Call = [string, ...unknown[]];
function world() {
  const calls: Call[] = [];
  const notes: (VaultNote & { extension?: string })[] = [
    { id: "s1", path: "Soups/Leek", content: "leek", tags: ["soup"], updatedAt: "t1" },
    { id: "p1", path: "Pantry/Salt", content: "salt", tags: [], updatedAt: "t1" },
    { id: "x1", path: "Elsewhere/Secret", content: "SECRET", tags: [], updatedAt: "t1" },
    { id: "h1", path: "Soups/Soup book", extension: "html", content: "<p>code</p>", tags: ["applet"], updatedAt: "t1" },
    { id: "t1", path: "Soups/Tagged", content: "x", tags: ["applet"], updatedAt: "t1" },
  ];
  const mod = createVaultModule({
    listPaths: async () => notes.map((n) => ({ id: n.id, path: n.path ?? null, extension: n.extension ?? "md", updatedAt: n.updatedAt })),
    getNote: async (ref) => { const n = notes.find((x) => x.id === ref || x.path === ref); if (!n) throw new Error("not found"); return { ...n }; },
    search: async () => [],
    create: async (path, content) => { calls.push(["create", path, content]); if (notes.some((x) => x.path === path)) throw new Error("note already exists"); const n = { id: `new-${notes.length}`, path, content, tags: [], updatedAt: "t2" }; notes.push(n); return n; },
    save: async (id, content, ifUpdatedAt) => { calls.push(["save", id, content, ifUpdatedAt]); const n = notes.find((x) => x.id === id)!; if (n.updatedAt !== ifUpdatedAt) throw new Error("conflict: note has been modified"); n.content = content; n.updatedAt = "t3"; return { ...n }; },
  });
  const router = createRouter([mod]);
  const h = appletHostNeeds({ applet: book() }, []);
  if (!h.ok) throw new Error(h.error);
  let closed = false;
  const ctx = { charge() {}, closed: () => closed };
  const fetch = (method: string, path: string, body: unknown) => router.call("vault", "fetch", { method, path, headers: {}, body: body === null ? null : JSON.stringify(body) }, h.resolved, ctx);
  return { calls, notes, fetch, close: () => { closed = true; } };
}

await check("POST adds a note inside its create folder, content only", async () => {
  const w = world();
  const r = await w.fetch("POST", "/api/notes", { path: "Soups/Barley", content: "# Barley\n" });
  assert.equal(r.status, 201, r.body);
  assert.equal(JSON.parse(r.body).path, "Soups/Barley");
  assert.deepEqual(w.calls, [["create", "Soups/Barley", "# Barley\n"]]);
});

await check("POST is refused outside its folder, with tags or metadata, at a climbing, hidden or HTML path, and as a clash", async () => {
  const w = world();
  const cases: [unknown, number][] = [
    [{ path: "Pantry/Pepper", content: "x" }, 403], [{ path: "Elsewhere/x", content: "x" }, 403], [{ path: "Soups", content: "x" }, 403],
    [{ path: "Soups/x", content: "x", tags: ["applet"] }, 400], [{ path: "Soups/x", content: "x", metadata: { applet: {} } }, 400],
    [{ path: "Soups/../Elsewhere/x", content: "x" }, 403], [{ path: "Soups/x​", content: "x" }, 400], [{ path: "Soups/%2e%2e/x", content: "x" }, 400],
    [{ path: "Soups/new.html", content: "<script>" }, 400], [{ path: "Soups/x" }, 400], [{ path: "Soups/x", content: 3 }, 400], ["not json", 400],
  ];
  for (const [body, status] of cases) {
    const r = await w.fetch("POST", "/api/notes", body);
    assert.equal(r.status, status, `${JSON.stringify(body)} → ${r.status}`);
  }
  assert.equal(w.calls.length, 0, "nothing reached the writer");
  const clash = await w.fetch("POST", "/api/notes", { path: "Soups/Leek", content: "again" });
  assert.equal(clash.status, 409);
});

await check("PATCH changes a note in its update folder, only at the revision it read; a stale one is a conflict", async () => {
  const w = world();
  const ok = await w.fetch("PATCH", "/api/notes/s1", { content: "leek and potato", if_updated_at: "t1" });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(w.notes.find((n) => n.id === "s1")!.content, "leek and potato");
  const stale = await w.fetch("PATCH", "/api/notes/s1", { content: "again", if_updated_at: "t1" });
  assert.equal(stale.status, 409);
  const byPath = await w.fetch("PATCH", `/api/notes/${encodeURIComponent("Soups/Leek")}`, { content: "by path", if_updated_at: "t3" });
  assert.equal(byPath.status, 200, "a note may be named by path; it is judged on the note that comes back");
});

await check("PATCH is refused for a note it only reads (403), one it can't read (404, no oracle), its own code, an applet-tagged note, and without a revision", async () => {
  const w = world();
  const cases: [string, unknown, number][] = [
    ["p1", { content: "x", if_updated_at: "t1" }, 403], ["x1", { content: "x", if_updated_at: "t1" }, 404], ["nope", { content: "x", if_updated_at: "t1" }, 404],
    ["h1", { content: "<script>evil()</script>", if_updated_at: "t1" }, 403], ["t1", { content: "x", if_updated_at: "t1" }, 403],
    ["s1", { content: "x" }, 400], ["s1", { content: "x", if_updated_at: "" }, 400], ["s1", { content: "x", if_updated_at: "t1", force: "true" }, 400],
    ["s1", { content: "x", if_updated_at: "t1", path: "Elsewhere/moved" }, 400],
  ];
  for (const [ref, body, status] of cases) {
    const r = await w.fetch("PATCH", `/api/notes/${ref}`, body);
    assert.equal(r.status, status, `${ref} ${JSON.stringify(body)} → ${r.status}`);
  }
  assert.equal(w.calls.length, 0);
  for (const m of ["PUT", "DELETE"]) assert.equal((await w.fetch(m, "/api/notes/s1", { content: "x", if_updated_at: "t1" })).status, 405);
});

await check("a session that has ended writes nothing", async () => {
  const w = world();
  w.close();
  assert.notEqual((await w.fetch("POST", "/api/notes", { path: "Soups/Late", content: "x" })).status, 201);
  assert.notEqual((await w.fetch("PATCH", "/api/notes/s1", { content: "x", if_updated_at: "t1" })).status, 200);
  assert.equal(w.calls.length, 0);
});

console.log(failed ? `\nappletWrites: ${failed} failed` : "\nappletWrites: all passed");
if (failed) process.exit(1);
