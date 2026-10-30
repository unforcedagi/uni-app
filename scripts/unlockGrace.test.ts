// T-335: the unlock grace's hint text (src/unlockGraceCore.ts). Whether a tap needs an unlock is Rust's (unlock_grace.rs).
import assert from "node:assert/strict";
import { graceText } from "../src/unlockGraceCore.ts";

assert.equal(graceText(300), "Unlocked · 5 min");
assert.equal(graceText(240), "Unlocked · 4 min");
assert.equal(graceText(181), "Unlocked · 4 min", "rounded up: never says less than is left");
assert.equal(graceText(1), "Unlocked · 1 min");
assert.equal(graceText(0.4), "Unlocked · 1 min");
for (const none of [0, -3, null, undefined, NaN]) assert.equal(graceText(none), null, String(none));
console.log("unlockGrace: ok");
