// T-335 OTA: check a signed channel file (web.json) and its archive the way the app will, before they are published.
//   node --experimental-strip-types scripts/ota-verify.ts <web.json> <archive> [--version X.Y.Z] [--api N] [--pubkey <hex>]
// The key is the one built into the app (RELEASE_PUBKEY_HEX in src-tauri/src/ota.rs) unless --pubkey is given (tests).
// Exit 0 and one "ota-verify: ok ..." line, or exit 1 with why.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const DOMAIN = "uni-ota-manifest-v1\n";
const MAX_VALID_S = 31 * 86400;

export type Manifest = {
  v: number; app: string; version: string; api: number; archive: string; sha256: string; bytes: number; commit: string;
  issued: number; expires: number;
};

export function builtInKey(rust: string): string {
  const m = /^const RELEASE_PUBKEY_HEX: &str = "([0-9a-f]*)";$/m.exec(rust);
  if (!m) throw new Error("RELEASE_PUBKEY_HEX not found in ota.rs");
  return m[1];
}

/** The manifest, if the channel file is signed by `pubkeyHex` and names exactly `archive`; throws why not. */
export function checkChannel(channel: string, archive: Buffer, pubkeyHex: string, now = Date.now() / 1000): Manifest {
  if (!/^[0-9a-f]{64}$/.test(pubkeyHex)) throw new Error("no bundle key to check against");
  const outer = JSON.parse(channel) as { manifest: string; sig: string };
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pubkeyHex, "hex").toString("base64url") }, format: "jwk" });
  if (!verify(null, Buffer.from(DOMAIN + outer.manifest), key, Buffer.from(outer.sig, "base64"))) {
    throw new Error("the signature doesn't verify with the built-in key");
  }
  const m = JSON.parse(outer.manifest) as Manifest;
  if (m.v !== 1 || m.app !== "org.unforced.uni") throw new Error(`the manifest is for ${m.app} v${m.v}`);
  // As the app reads it (src-tauri/src/ota.rs verify_channel): a plain X.Y.Z version, a hex sha256, whole numbers.
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(m.version)) throw new Error("the manifest's version isn't X.Y.Z");
  if (!/^[0-9a-f]{64}$/.test(m.sha256)) throw new Error("the manifest's sha256 isn't 64 hex characters");
  if (![m.api, m.bytes, m.issued, m.expires].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error("the manifest's numbers aren't whole");
  if (m.api > 0xffffffff) throw new Error("the manifest's API is out of range");
  if (m.archive !== `web-${m.version}.tar.gz`) throw new Error("the manifest's archive name isn't web-<version>.tar.gz");
  if (archive.length !== m.bytes || createHash("sha256").update(archive).digest("hex") !== m.sha256) {
    throw new Error("the archive is not the one the manifest names");
  }
  if (!(m.expires > m.issued && m.expires - m.issued <= MAX_VALID_S)) throw new Error("the validity window is malformed");
  if (now >= m.expires) throw new Error("the manifest has expired");
  return m;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [channelPath, archivePath, ...rest] = process.argv.slice(2);
  const opt = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  try {
    const pub = opt("--pubkey") ?? builtInKey(readFileSync(new URL("../src-tauri/src/ota.rs", import.meta.url), "utf8"));
    const m = checkChannel(readFileSync(channelPath, "utf8"), readFileSync(archivePath), pub);
    if (opt("--version") && m.version !== opt("--version")) throw new Error(`the manifest says ${m.version}`);
    if (opt("--api") && m.api !== Number(opt("--api"))) throw new Error(`the manifest says API ${m.api}`);
    console.log(`ota-verify: ok ${m.version} api ${m.api} sha256 ${m.sha256} expires ${new Date(m.expires * 1000).toISOString()}`);
  } catch (e) {
    console.error(`ota-verify: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
