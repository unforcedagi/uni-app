// Run: node --experimental-strip-types scripts/androidNetwork.test.ts
// T-172 (Codex review 1, P1): Android plays streamed media from http://127.0.0.1 (src-tauri/src/media_loopback.rs).
// Release builds set usesCleartextTraffic=false, so they need a network security config that allows cleartext to
// this device only; debug builds keep their cleartext.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const A = new URL("../src-tauri/gen/android/app/src/", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, A), "utf8").replace(/<!--[\s\S]*?-->/g, "");

const manifest = read("main/AndroidManifest.xml");
assert.match(manifest, /<application[^>]*android:networkSecurityConfig="@xml\/network_security_config"/, "manifest must use the network security config");
assert.ok(existsSync(new URL("main/res/xml/network_security_config.xml", A)), "release config missing");

const release = read("main/res/xml/network_security_config.xml");
assert.match(release, /<base-config\s+cleartextTrafficPermitted="false"\s*\/>/, "release: cleartext off by default");
const domains = [...release.matchAll(/<domain-config\s+cleartextTrafficPermitted="true">([\s\S]*?)<\/domain-config>/g)].flatMap((m) =>
  [...m[1].matchAll(/<domain\s+includeSubdomains="(\w+)">\s*([^<\s]+)\s*<\/domain>/g)].map((d) => `${d[2]}:${d[1]}`));
assert.deepEqual(domains.sort(), ["127.0.0.1:false", "localhost:false"], "release: cleartext only to this device");
assert.doesNotMatch(release, /<base-config[^>]*cleartextTrafficPermitted="true"/);

const debug = read("debug/res/xml/network_security_config.xml");
assert.match(debug, /<base-config\s+cleartextTrafficPermitted="true"\s*\/>/, "debug keeps cleartext (dev server)");

// The loopback really is 127.0.0.1, the host the config allows.
assert.match(readFileSync(new URL("../src-tauri/src/media_loopback.rs", import.meta.url), "utf8"), /format!\("http:\/\/127\.0\.0\.1:\{port\}\/\{token\}"\)/);
console.log("android network tests passed");
