// T-229: the fake calendar door (scripts/calFakeDoor.ts, the shared fixture's made-up events) over HTTP, for running
// the real app against it (the walkthrough). Never part of the app. It checks each request's NIP-98 header for the
// request it came with (kind 27235, `u` = this door's URL plus the path and query, `method`, `payload` = the body's
// sha256, a 120 s window, the allowed keys, no replays); it doesn't check the Schnorr signature itself (Node has no
// secp256k1): crates/uni-core/tests/cal_door.rs does, as the live door does.
// Usage: node --experimental-strip-types scripts/fake-cal-door.ts <port> <pubkey hex>[,<hex>…] [owner|uni] [conflict]
// then start the app with UNI_CAL_URL=http://127.0.0.1:<port>. Each op is printed; invites go to an outbox in memory.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { FakeDoor, type Fixture, type Role } from "./calFakeDoor.ts";

const [port, allowArg = "", role = "owner", extra = ""] = process.argv.slice(2);
if (!port) throw new Error("usage: fake-cal-door.ts <port> <pubkey hex,…> [owner|uni] [conflict]");
const allow = new Set(allowArg.split(",").filter(Boolean).map((k) => k.toLowerCase()));
const fixture: Fixture = JSON.parse(readFileSync(new URL("./fixtures/cal-sample-events.json", import.meta.url), "utf8"));
const door = new FakeDoor(fixture, { role: role as Role, conflict: extra === "conflict" });
const origin = `http://127.0.0.1:${port}`;
const seen = new Set<string>();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function check(header: string | undefined, method: string, url: string, body: Buffer): string | null {
  if (!header?.startsWith("Nostr ")) return "missing Nostr authorization";
  let ev: { kind: number; pubkey: string; created_at: number; id: string; tags: string[][] };
  try { ev = JSON.parse(Buffer.from(header.slice(6), "base64url").toString("utf8")); } catch { return "bad authorization encoding"; }
  if (ev.kind !== 27235) return "wrong kind";
  if (Math.abs(Date.now() / 1000 - ev.created_at) > 120) return "stale authorization";
  const tag = (n: string) => ev.tags.find((t) => t[0] === n)?.[1];
  if (tag("u") !== url || tag("method")?.toUpperCase() !== method) return "authorization is for a different request";
  if (tag("payload") !== sha(body)) return "payload hash mismatch";
  if (!allow.has(ev.pubkey.toLowerCase())) return "pubkey not allowed";
  if (seen.has(ev.id)) return "replayed authorization";
  seen.add(ev.id);
  return null;
}

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const send = (status: number, v: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
    const method = req.method ?? "GET";
    const bad = check(req.headers.authorization, method, origin + (req.url ?? "/"), body);
    if (bad) { console.log(`401 ${method} ${req.url}: ${bad}`); return send(401, { error: bad }); }
    let parsed: unknown;
    try { parsed = body.length ? JSON.parse(body.toString("utf8")) : undefined; } catch { return send(400, { error: "body must be JSON" }); }
    const r = door.handle(method, req.url ?? "/", parsed);
    if (method === "POST") console.log(`${r.status} op ${JSON.stringify(parsed)} -> ${JSON.stringify(r.body)}`);
    send(r.status, r.body);
  });
}).listen(Number(port), "127.0.0.1", () => console.log(`fake calendar door on ${origin} as ${role}, ${door.notes.size} made-up events`));
