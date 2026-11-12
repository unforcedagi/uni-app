// T-335 one ask: the app's shim for the vendored ask library (src/ask/shim.ts), run as an older webview would: the native method removed.
// Run: node --experimental-strip-types scripts/askShim.test.ts
import assert from "node:assert/strict";
delete (String.prototype as { isWellFormed?: unknown }).isWellFormed;
await import("../src/ask/shim.ts");
const wf = (s: string) => (s as unknown as { isWellFormed(): boolean }).isWellFormed();
for (const [s, want] of [["abc", true], ["", true], ["a😀b", true], ["\uD83D", false], ["\uDE00", false], ["a\uD83Db", false], ["\uDE00\uD83D", false], ["\uD83D😀", false]] as const)
  assert.equal(wf(s), want, JSON.stringify(s));
console.log("askShim: all ok");
