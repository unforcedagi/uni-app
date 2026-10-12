// Life OS profile: defaults equal today's Uni values; the profile note; vault choice; the vault parameter reaching the data layer.
// Run: node --experimental-strip-types scripts/profile.test.ts
import assert from "node:assert/strict";
import { defaultProfile, packProfile, readProfileNote, resolveProfile, readVaultChoice, writeVaultChoice, vaultChoices, setActiveProfile, activeProfile } from "../src/areas/profile.ts";
import { groupOf, parseNodes, sortTasks } from "../src/areas/taskCore.ts";
import { nodeStatus } from "../src/areas/areasCore.ts";
import { createAreasCache } from "../src/areas/areasCache.ts";
import { createVaultTasks } from "../src/areas/vaultTasks.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

check("defaultProfile is today's Uni values", () => {
  assert.deepEqual(defaultProfile(), { vault: "uni", title: "Uni", rootTag: "uni", me: "aaron", meLabel: "You", agentOwners: ["uni"], roomOwnerPrefix: "room:", areaPrefix: "Areas/", briefs: { mode: "paths" }, chat: { provider: "buzz" } });
});
check("uni without a note resolves to the default; a note overrides, vault stays", () => {
  assert.deepEqual(resolveProfile("uni", null, false), defaultProfile());
  assert.equal(resolveProfile("uni", { me: "x" }, true).me, "x");
  assert.equal(resolveProfile("uni", { me: "x" }, true).vault, "uni");
});
check("another vault without a note: pack defaults, rootTag root if it has notes else uni, no chat", () => {
  assert.equal(resolveProfile("s", null, true).rootTag, "root");
  assert.equal(resolveProfile("s", null, false).rootTag, "uni");
  assert.equal(resolveProfile("s", null, true).chat.provider, null);
  assert.equal(resolveProfile("s", null, true).roomOwnerPrefix, null);
});
check("profile note: JSON in metadata, or a fenced block; bad input ignored", () => {
  assert.deepEqual(readProfileNote({ metadata: { rootTag: "root", me: "me", chat: { provider: null } } }), { rootTag: "root", me: "me", chat: { provider: null } });
  assert.deepEqual(readProfileNote({ content: "# p\n```json\n{\"me\":\"zed\",\"agentOwners\":[\"bot\"],\"areaPrefix\":null}\n```" }), { me: "zed", agentOwners: ["bot"], areaPrefix: null });
  assert.equal(readProfileNote({ content: "```json\n{nope\n```" }), null);
  assert.equal(readProfileNote({ metadata: { me: 5, briefs: { mode: "x" } } }), null);
  assert.equal(readProfileNote(null), null);
});
check("vault choice persists; invalid or missing falls back to uni; uni listed first", () => {
  const m = new Map<string, string>(); const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  assert.equal(readVaultChoice(store), "uni");
  writeVaultChoice(store, "scratch-1"); assert.equal(readVaultChoice(store), "scratch-1");
  writeVaultChoice(store, "bad name!"); assert.equal(readVaultChoice(store), "scratch-1");
  assert.deepEqual(vaultChoices(["z", "uni", "a"]), ["uni", "a", "z"]);
});
check("vaultTasks: singleton follows the active profile's vault; an explicit vault wins", async () => {
  const seen: unknown[] = [];
  const call = async (_c: string, a: Record<string, unknown>) => { seen.push(a.vault); return []; };
  const t = createVaultTasks(call);
  await t.loadTree();
  setActiveProfile(packProfile("scratch", "root"));
  await t.loadTree();
  await createVaultTasks(call, "fixed").loadTree();
  setActiveProfile(defaultProfile());
  assert.deepEqual(seen, ["uni", "scratch", "fixed"]);
  assert.equal(activeProfile().vault, "uni");
});

check("review: the device cache keeps one slot per vault; uni keeps the original key", async () => {
  const { createAreasCache, CACHE_KEY, cacheKeyFor } = await import("../src/areas/areasCache.ts");
  const m = new Map<string, string>(); const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } };
  const c = createAreasCache(store); const area = { id: "a", path: "Areas/A", name: "A", purpose: "", status: "foreground", channels: [], rooms: [], kind: "area", parent: null, since: null, title: "A", body: "", metadata: {}, updatedAt: null } as never;
  const uni = { identity: "i", vault: "uni" }, other = { identity: "i", vault: "scratch" };
  c.write({ areas: [area], briefs: {}, today: null }, uni);
  c.write({ areas: [area, area], briefs: {}, today: null }, other);
  assert.equal(cacheKeyFor("uni"), CACHE_KEY);
  assert.equal(c.read(uni)?.areas.length, 1, "uni's slot survives opening another vault");
  assert.equal(c.read(other)?.areas.length, 2);
  c.clear(); assert.equal(m.size, 0, "forget clears every vault's slot");
});
check("review: profile note strings are capped", () => {
  assert.equal(readProfileNote({ metadata: { me: "x".repeat(500) } })!.me!.length, 120);
});
check("PR2: root tag follows the profile; uni default unchanged", () => {
  const notes = [{ id: "r", path: "Life", tags: ["root", "node"] }, { id: "a", path: "Areas/A", tags: ["area", "node"], metadata: { parent: "r" } }];
  assert.equal(parseNodes(notes, "root").rootPath, "Life");
  assert.equal(parseNodes(notes, "uni").rootPath, null);
  assert.equal(parseNodes([{ id: "u", path: "Uni", tags: ["uni"] }]).rootPath, "Uni");
  setActiveProfile(packProfile("s", "root"));
  assert.equal(parseNodes(notes).rootPath, "Life");
  setActiveProfile(defaultProfile());
});
check("PR2: me / agentOwners / room prefix drive groups and sort", () => {
  const d = defaultProfile(); const p = packProfile("s", "root");
  assert.equal(groupOf({ owner: "aaron", waitingOn: null, kind: "task" }, d), "you");
  assert.equal(groupOf({ owner: "me", waitingOn: null, kind: "task" }, d), "others");
  assert.equal(groupOf({ owner: "room:x", waitingOn: null, kind: "task" }, d), "rooms");
  assert.equal(groupOf({ owner: "me", waitingOn: null, kind: "task" }, p), "you");
  assert.equal(groupOf({ owner: "x", waitingOn: "me", kind: "task" }, p), "you");
  assert.equal(groupOf({ owner: "room:x", waitingOn: null, kind: "task" }, p), "others");
  assert.equal(groupOf({ owner: "agent", waitingOn: null, kind: "task" }, p), "rooms");
  setActiveProfile(p);
  const mk = (title: string, waitingOn: string | null) => ({ title, waitingOn, kind: "task", state: "open", due: null }) as never;
  assert.equal(sortTasks([mk("b", null), mk("a", "me")])[0].title, "a");
  setActiveProfile(d);
});
check("PR2: pack statuses map (pack vaults only): active is foreground, dormant and incubating are background", () => {
  assert.equal(nodeStatus("active"), "background", "uni (the default profile) keeps today's reading");
  assert.equal(nodeStatus("active", true), "foreground");
  setActiveProfile(packProfile("s", "root")); assert.equal(nodeStatus("active"), "foreground"); setActiveProfile(defaultProfile());
  assert.equal(nodeStatus("foreground"), "foreground");
  assert.equal(nodeStatus("dormant"), "background");
  assert.equal(nodeStatus("incubating"), "background");
  assert.equal(nodeStatus("archived"), "archived");
  assert.equal(nodeStatus(undefined), "background");
});
check("PR2: the device cache accepts every status the parser can produce (active/dormant nodes are not rejected)", () => {
  const m = new Map<string, string>(); const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  const c = createAreasCache(store); const owner = { identity: "i", vault: "s" };
  const area = (status: string) => ({ id: status, path: "Areas/" + status, name: status, purpose: "", status: nodeStatus(status), channels: [], since: null, title: status, body: "", metadata: {}, updatedAt: null, kind: "area", parent: null, rooms: [] }) as never;
  c.write({ areas: ["active", "dormant", "incubating", "done"].map(area), briefs: {}, today: null }, owner);
  assert.equal(c.read(owner)?.areas.length, 4);
  // a raw pack status that slipped through unnormalised is also accepted
  c.write({ areas: [{ ...(area("x") as object), status: "active" } as never, { ...(area("y") as object), status: "dormant" } as never], briefs: {}, today: null }, owner);
  assert.equal(c.read(owner)?.areas.length, 2);
});

if (failed) { console.log(`${failed} failed`); process.exit(1); } else console.log("all passed");
