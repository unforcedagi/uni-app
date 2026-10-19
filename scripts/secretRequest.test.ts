import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSecretReceipt, parseSecretRequest, receiptFor, receiptsByRequest, withoutSecretBlock } from "../src/secretRequest.ts";
let failed = 0;
const check = (n: string, f: () => void) => { try { f(); console.log("ok  ", n); } catch (e) { failed++; console.log("FAIL", n, e); } };
// Written by the uni-secrets plugin's desk.py (then re-signed with a throwaway key, a task id taken out of the purpose),
// so this checks the two sides agree on the format as of that capture; regenerate it when the plugin's format changes.
const fx = JSON.parse(readFileSync(new URL("./fixtures/t176-messages.json", import.meta.url), "utf8"));
const req = fx.request.content as string;

check("the plugin's request parses", () => {
  const r = parseSecretRequest(req)!;
  assert.equal(r.name, "tailscale-api");
  assert.equal(r.label, "Tailscale API token");
  assert.equal(r.store, "~/.config/uni/tailscale-api");
  assert.match(r.rpk, /^[0-9a-f]{64}$/);
});
check("its human lines survive without the block", () => {
  const t = withoutSecretBlock(req);
  assert.ok(t.startsWith("🔐 **Uni is asking for a secret:**"));
  assert.ok(!t.includes("```"));
});
check("malformed requests are plain text", () => {
  for (const [a, b] of [['"name":"tailscale-api"', '"name":"../x"'], ['"v":1', '"v":2'], ['"keep_days":30', '"keep_days":0']]) {
    assert.ok(req.includes(a), a);
    assert.equal(parseSecretRequest(req.replace(a, b)), null, b);
  }
  assert.equal(parseSecretRequest(req.replace(/\n```\s*$/, "")), null, "unterminated fence");
  assert.equal(parseSecretRequest("hello"), null);
});
check("receipts parse; a request is not a receipt", () => {
  assert.equal(parseSecretReceipt(fx.stored.content)!.state, "stored");
  assert.equal(parseSecretReceipt(fx.forgotten.content)!.state, "forgotten");
  assert.equal(parseSecretReceipt(req), null);
});
check("a receipt applies to its request; a forget (name only) to the latest stored one", () => {
  const rid = parseSecretRequest(req)!.rid;
  const m = (o: any, ts: number) => ({ author: o.pubkey, body: o.content, ts });
  assert.equal(receiptFor(receiptsByRequest([m(fx.request, 1), m(fx.stored, 2)]), fx.author, rid)!.state, "stored");
  assert.equal(receiptFor(receiptsByRequest([m(fx.request, 1), m(fx.stored, 2), m(fx.forgotten, 3)]), fx.author, rid)!.state, "forgotten");
});
check("a receipt from anyone else does not count", () => {
  const rid = parseSecretRequest(req)!.rid;
  const fake = { author: "f".repeat(64), body: fx.stored.content, ts: 2 };
  assert.equal(receiptFor(receiptsByRequest([fake]), fx.author, rid), undefined);
});
if (failed) { console.log(`${failed} failed`); process.exit(1); }
