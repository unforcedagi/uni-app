// Run: node --experimental-strip-types scripts/ota.test.ts
// T-305: the web layer and the shell agree on the command API number, and a bundle refuses a shell with another one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SHELL_API, refusesShell, webLabel } from "../src/ota.ts";

const rust = readFileSync(new URL("../src-tauri/src/ota.rs", import.meta.url), "utf8");
const m = rust.match(/^pub const SHELL_API: u32 = (\d+);$/m);
assert.ok(m, "SHELL_API not found in ota.rs");
assert.equal(Number(m[1]), SHELL_API, "src/ota.ts and src-tauri/src/ota.rs disagree on SHELL_API");
// ota-bundle.sh reads the number from this exact line.
assert.match(readFileSync(new URL("../src/ota.ts", import.meta.url), "utf8"), /^export const SHELL_API = \d+;$/m);

const bundle = { version: "0.1.85", api: SHELL_API };
assert.equal(refusesShell({ shell_api: SHELL_API, active: bundle }), false, "same API: runs");
assert.equal(refusesShell({ shell_api: SHELL_API + 1, active: bundle }), true, "newer shell: the bundle steps aside");
assert.equal(refusesShell({ shell_api: SHELL_API - 1, active: bundle }), true, "older shell: the bundle steps aside");
assert.equal(refusesShell({ shell_api: SHELL_API + 1, active: null }), false, "the built-in web layer never refuses its own shell");
assert.equal(webLabel({ shell_api: 1, builtin: "0.1.84", active: bundle, channel: null }), "web 0.1.85 (over the air)");
assert.equal(webLabel({ shell_api: 1, builtin: "0.1.84", active: null, channel: null }), "web built in");
console.log("ota tests passed");
