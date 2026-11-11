// Pairing failures in words (src/pairingCore.ts). Moved from the retired simpleR22 test (T-335).
// Run: node --experimental-strip-types scripts/pairing.test.ts
import assert from "node:assert/strict";
import { pairingFailure } from "../src/pairingCore.ts";

assert.equal(pairingFailure("start", "Error: relay handshake failed: os error 111"), "Couldn't reach the other device. Check that both are online, start a new pairing there, then paste its link again.");
assert.match(pairingFailure("start", "invalid pairing uri: missing secret"), /^That link couldn't be read/);
assert.match(pairingFailure("confirm", "pairing timed out"), /^The other device didn't answer in time/);
assert.match(pairingFailure("confirm", "decrypt failed"), /^This device wasn't signed in/);
assert.equal(pairingFailure("scan", "This QR code is not a Uni/Buzz pairing link."), "This QR code is not a Uni/Buzz pairing link.");
for (const s of ["start", "confirm", "scan"] as const) assert.doesNotMatch(pairingFailure(s, "Error: os error 111"), /os error|Error:/);
console.log("pairing: ok");
