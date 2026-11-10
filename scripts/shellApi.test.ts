// Run: node --experimental-strip-types scripts/shellApi.test.ts
// T-335 OTA: the build fails when the shell's contract with the screens changes without a new SHELL_API (scripts/shellApi.ts).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { SHELL_API } from "../src/ota.ts";
import { commandSignature, handlerCommands, parseRecord, shellContract } from "./shellApi.ts";

const root = new URL("..", import.meta.url).pathname;
const recordPath = "src-tauri/shell-api.txt";
const record = parseRecord(readFileSync(root + recordPath, "utf8"));
const today = shellContract(root);
const fix = `the shell's commands, plugins or capabilities changed: bump SHELL_API (src-tauri/src/ota.rs and src/ota.ts) ` +
  `and add an \`api N\` block to ${recordPath} with the output of \`node --experimental-strip-types scripts/shellApi.ts\``;

// 1. Today's contract is the one recorded for today's number.
const mine = record.get(SHELL_API);
assert.ok(mine, `${recordPath} has no block for SHELL_API ${SHELL_API}`);
const missing = today.filter((l) => !mine.includes(l)), extra = mine.filter((l) => !today.includes(l));
assert.ok(!missing.length && !extra.length, `${fix}\n  new or changed: ${missing.join("\n    ")}\n  gone: ${extra.join("\n    ")}`);
assert.equal(Math.max(...record.keys()), SHELL_API, "SHELL_API is the newest number in shell-api.txt");

// 2. A block an earlier release shipped is never edited: a change is a new number (else phones running that release
//    would take screens built for a shell they aren't).
let released: string | null = null;
try {
  const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "uni-v*", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  released = execFileSync("git", ["show", `${tag}:${recordPath}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch { /* no release tag here (a shallow clone), or no record in it yet (the first release with one) */ }
if (released !== null) {
  for (const [api, lines] of parseRecord(released)) {
    assert.deepEqual(record.get(api), lines, `${recordPath}: the block for api ${api} was edited after it shipped; ${fix}`);
  }
}

// 3. The parser sees through formatting, and a changed argument is a change.
const src = `#[tauri::command]\npub async fn f<R: Runtime>(\n    app: AppHandle<R>,\n    n: u32,\n) -> Result<(), String> where R: X {}`;
assert.equal(commandSignature(src, "f"), "async f<R: Runtime>(app: AppHandle<R>, n: u32) -> Result<(), String>");
assert.notEqual(commandSignature(src.replace("n: u32", "n: u64"), "f"), commandSignature(src, "f"));
assert.equal(commandSignature("#[tauri::command]\nfn g() {}", "f"), null);
assert.deepEqual(handlerCommands("x.invoke_handler(tauri::generate_handler![\n #[cfg(a)]\n m::a,\n b, // note\n])"), ["m::a", "b"]);
assert.throws(() => parseRecord("api 1\nx\napi 1\n"), /twice/);
console.log(`shell API tests passed (api ${SHELL_API}, ${today.length} lines)`);
