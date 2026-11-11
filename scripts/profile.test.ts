// Life OS profile: defaults equal today's Uni values; the profile note; vault choice; discovery.
// Run: node --experimental-strip-types scripts/profile.test.ts
import assert from "node:assert/strict";
import { showUniGlue, defaultProfile, packProfile, readProfileNote, resolveProfile, readVaultChoice, writeVaultChoice, vaultChoices, setActiveProfile, activeProfile } from "../src/areas/profile.ts";
import { nodeStatus } from "../src/areas/areasCore.ts";

let failed = 0;
const pending: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>) { pending.push(run(name, fn)); }
async function run(name: string, fn: () => void | Promise<void>) {
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

check("review: profile note strings are capped", () => {
  assert.equal(readProfileNote({ metadata: { me: "x".repeat(500) } })!.me!.length, 120);
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

check("PR4: discover — uni reads only the profile note (no tag queries); other vaults probe node and root", async () => {
  const { discover } = await import("../src/areas/discover.ts");
  const run = async (vault: string, answer: (cmd: string, a: any) => unknown) => { const calls: any[] = []; const inv = async (cmd: string, a: any) => { calls.push({ cmd, ...a }); const r = answer(cmd, a); if (r instanceof Error) throw r; return r as never; }; return { found: await discover(vault, inv as never), calls }; };
  const u = await run("uni", () => new Error("no note"));
  assert.deepEqual(u.calls.map((c) => c.cmd), ["vault_note"]); assert.deepEqual(u.found.profile, defaultProfile()); assert.equal(u.found.hasPack, true);
  const s = await run("s", (cmd, a) => cmd === "vault_note" ? new Error("none") : a.tag === "node" ? [1] : a.tag === "root" ? [1] : []);
  assert.equal(s.found.profile.rootTag, "root"); assert.equal(s.found.hasPack, true); assert.equal(s.calls.filter((c) => c.cmd === "vault_query").length, 2);
  assert.equal((await run("b", (cmd) => cmd === "vault_note" ? new Error("none") : [])).found.hasPack, false, "no node notes → no pack");
  assert.equal((await run("b", (cmd, a) => cmd === "vault_note" ? new Error("none") : a.tag === "node" ? [] : [])).found.profile.rootTag, "uni", "no root notes → uni root");
  const f = await run("f", (cmd) => cmd === "vault_note" ? new Error("none") : new Error("offline"));
  assert.equal(f.found.hasPack, true, "a failed pack check is not 'no pack'"); assert.equal(f.found.profile.rootTag, "root", "a failed root check is not 'no root'");
});
check("PR6: Uni glue only for the uni vault", () => { assert.equal(showUniGlue("uni"), true); assert.equal(showUniGlue("scratch"), false); });
check("PR6: a saved vault that left the list falls back to uni, in the shell and the surface alike", async () => {
  const { effectiveLifeVault } = await import("../src/areas/profile.ts");
  assert.equal(effectiveLifeVault("s", []), "s", "list not loaded yet: keep the choice");
  assert.equal(effectiveLifeVault("s", ["uni", "s"]), "s");
  assert.equal(effectiveLifeVault("gone", ["uni", "s"]), "uni");
});

await Promise.all(pending);  // an async check must finish before the exit code is decided
if (failed) { console.log(`${failed} failed`); process.exit(1); } else console.log("all passed");
