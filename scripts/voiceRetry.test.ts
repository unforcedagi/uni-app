import assert from "node:assert/strict";
import { voiceRetryDelay } from "../src/voiceRetry.ts";
import { netError } from "../src/netError.ts";
assert.deepEqual([0, 1, 2, 3, 4, 5, 100].map(voiceRetryDelay), [15000, 30000, 60000, 120000, 300000, 300000, 300000]);
const message = "Can't reach Buzz. Is Tailscale on? Your voice note is saved and will send when you're back online.";
for (const failure of ["error sending request", "DNS lookup failed", "connect failed", "timed out", "connection reset"]) {
  assert.equal(netError(`upload failed: ${failure}`), message);
  assert.equal(netError(new Error(`post failed: ${failure}`)), message);
}
assert.equal(netError("relay rejected"), "relay rejected");
assert.equal(netError(new Error("invalid media")), "Error: invalid media");
console.log("voice retry tests passed");
