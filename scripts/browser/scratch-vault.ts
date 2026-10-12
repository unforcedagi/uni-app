// Usage: VAULT_REPO=<vault checkout at origin/main> SV_OUT=<scratch dir> bun scripts/browser/scratch-vault.ts  → writes $SV_OUT/env.json (port, tokens, ids). Own PARACHUTE_HOME and port; never the live hub.
// Scratch Parachute server: own PARACHUTE_HOME + port; vault "lifeos" (pack installed + seed) and vault "bare" (no pack). Pattern from life-os/prove.ts.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
const repo = process.env.VAULT_REPO!, out = process.env.SV_OUT!;
const { generateKeyPair, exportJWK, SignJWT } = await import(join(repo, "node_modules/jose/dist/webapi/index.js"));
const home = join(out, "home"); rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true });
const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: "scratch-only", alg: "RS256", use: "sig" };
const issuer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req: Request) {
  const p = new URL(req.url).pathname;
  if (p === "/.well-known/jwks.json") return Response.json({ keys: [jwk] });
  if (p === "/.well-known/parachute-revocation.json") return Response.json({ generated_at: new Date().toISOString(), jtis: [] });
  return new Response("scratch", { status: 404 });
} });
const origin = `http://127.0.0.1:${issuer.port}`;
const token = (v: string) => new SignJWT({ scope: `vault:${v}:admin`, vault_scope: [v] }).setProtectedHeader({ alg: "RS256", kid: "scratch-only" }).setIssuer(origin).setAudience(`vault.${v}`).setSubject("scratch-proof").setIssuedAt().setExpirationTime("3h").setJti(crypto.randomUUID()).sign(privateKey);
const res = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const port = res.port; res.stop(true);
const env = { ...process.env, PARACHUTE_HOME: home, PORT: String(port), VAULT_BIND: "127.0.0.1", PARACHUTE_HUB_ORIGIN: origin, PARACHUTE_HUB_JWKS_ORIGIN: origin, PARACHUTE_HUB_ORIGINS: origin, VAULT_AUTH_TOKEN: "", EMBEDDINGS_ENABLED: "false", NODE_ENV: "production", PARACHUTE_VAULT_NAME: "" };
async function command(args: string[]) { const c = Bun.spawn(args, { cwd: repo, env, stdout: "pipe", stderr: "pipe" }); const [o, e, code] = await Promise.all([new Response(c.stdout).text(), new Response(c.stderr).text(), c.exited]); if (code) throw new Error(args.join(" ") + ": " + e); return o; }
await command(["bun", "-e", 'const c = await import("./src/config.ts"); for (const n of ["lifeos","bare"]) c.writeVaultConfig({name:n,api_keys:[],created_at:new Date().toISOString()}); const {getVaultStore}=await import("./src/vault-store.ts"); getVaultStore("lifeos"); getVaultStore("bare");']);
const server = Bun.spawn(["bun", "src/server.ts"], { cwd: repo, env, stdout: "ignore", stderr: "ignore" });
const tokens: Record<string, string> = { lifeos: await token("lifeos"), bare: await token("bare") };
const call = (v: string, path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}/vault/${v}/api${path}`, { ...init, headers: { Authorization: `Bearer ${tokens[v]}`, "Content-Type": "application/json" } });
for (let i = 0, ok = false; i < 100 && !ok; i++) { try { ok = (await call("lifeos", "/notes?limit=1")).ok; } catch {} if (!ok) await Bun.sleep(100); }
await command(["bun", "src/cli.ts", "packs", "add", join(process.env.HOME!, "Code/module-packs/packs/life-os"), "--vault", "lifeos"]);
const mk = async (b: any) => { const r = await call("lifeos", "/notes", { method: "POST", body: JSON.stringify(b) }); if (!r.ok) throw new Error(b.path + " " + r.status + await r.text()); const n: any = await r.json(); return n.id ?? n.note?.id; };
const root = await mk({ path: "Life", content: "# Life\n\nWhat is going on.", tags: ["root"], metadata: { status: "active" } });
const health = await mk({ path: "Areas/Health", content: "# Health\n\nBody, sleep and movement.", tags: ["area"], metadata: { parent: root, status: "active" } });
const work = await mk({ path: "Areas/Work", content: "# Work\n\nThe craft and the income.", tags: ["area"], metadata: { parent: root, status: "active" } });
const launch = await mk({ path: "Projects/Launch", content: "# Launch\n\nShip the first release.", tags: ["project"], metadata: { parent: work, status: "active" } });
const T = (n: string, node: string, state: string, owner: string, extra: any = {}) => mk({ path: `Tasks/${n}`, content: "# " + n, tags: ["task"], metadata: { node, state, owner, ...extra } });
await T("Book a dentist visit", health, "open", "me", { due: "2026-10-20" });
await T("Walk every morning", health, "doing", "me");
await T("Review the contract", work, "waiting", "me", { waiting_on: "me" });
await T("Write release notes", launch, "open", "agent");
await T("Tag the build", launch, "open", "me");
writeFileSync(join(out, "env.json"), JSON.stringify({ port, pid: server.pid, tokens, origin, ids: { root, health, work, launch } }));
console.log("ready", port);
await new Promise(() => {});
