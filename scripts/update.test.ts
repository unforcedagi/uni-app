// Run: node --experimental-strip-types scripts/update.test.ts
import assert from "node:assert/strict";
import { downloadPercent, isBusy, newerVersion, onDownloadEvent, updateLabel, type UpdateState } from "../src/updateCore.ts";

// Version comparison.
assert.equal(newerVersion("0.1.6", "0.1.5"), true);
assert.equal(newerVersion("0.2.0", "0.1.9"), true);
assert.equal(newerVersion("0.1.5", "0.1.5"), false);
assert.equal(newerVersion("0.1.4", "0.1.5"), false);
assert.equal(newerVersion("0.1.10", "0.1.9"), true);
assert.equal(newerVersion("0.2.0-beta", "0.1.0"), false);

// Download progress: Started (size) → Progress chunks → Finished.
let s: UpdateState = { kind: "downloading", received: 0, total: null };
s = onDownloadEvent(s, { event: "Started", data: { contentLength: 1000 } });
assert.deepEqual(s, { kind: "downloading", received: 0, total: 1000 });
assert.equal(updateLabel(s), "Downloading… 0%");
s = onDownloadEvent(s, { event: "Progress", data: { chunkLength: 256 } });
s = onDownloadEvent(s, { event: "Progress", data: { chunkLength: 250 } });
assert.equal(downloadPercent(s), 50);
assert.equal(updateLabel(s), "Downloading… 50%");
s = onDownloadEvent(s, { event: "Finished" });
assert.equal(downloadPercent(s), 100);
// Overshoot is clamped.
assert.equal(downloadPercent({ kind: "downloading", received: 1200, total: 1000 }), 100);

// Unknown size: no percent.
let u = onDownloadEvent({ kind: "idle" }, { event: "Started", data: {} });
u = onDownloadEvent(u, { event: "Progress", data: { chunkLength: 10 } });
assert.equal(downloadPercent(u), null);
assert.equal(updateLabel(u), "Downloading…");

// Labels.
assert.equal(updateLabel({ kind: "checking" }), "Checking…");
assert.equal(updateLabel({ kind: "current" }), "Up to date");
assert.equal(updateLabel({ kind: "ready", version: "0.1.6" }), "Update 0.1.6 ready");
assert.equal(updateLabel({ kind: "available", version: "0.1.6", url: "x" }), "Update 0.1.6 available");
assert.equal(updateLabel({ kind: "error", message: "network down: dns error" }), "Update check failed: network down: dns error");

// Busy while checking or downloading only.
assert.equal(isBusy({ kind: "checking" }), true);
assert.equal(isBusy(s), true);
assert.equal(isBusy({ kind: "current" }), false);
assert.equal(isBusy({ kind: "error", message: "x" }), false);

console.log("update tests passed");
