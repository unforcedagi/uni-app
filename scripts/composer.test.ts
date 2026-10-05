import assert from "node:assert/strict";
import { attachmentBlocksSend, enterInsertsNewline, manualAttachments } from "../src/composerCore.ts";

assert.equal(attachmentBlocksSend({ state: "ready", media: {} }), false);
assert.equal(attachmentBlocksSend({ state: "uploading" }), true);
assert.equal(attachmentBlocksSend({ state: "ready" }), true, "missing media must block send");
assert.equal(attachmentBlocksSend({ state: "error" }), true);
assert.equal(attachmentBlocksSend({ state: "error", media: {} }), true, "failed uploads must never be silently omitted");
assert.equal(attachmentBlocksSend({ state: "ready", media: {} }), false);
assert.equal(enterInsertsNewline(1, false), true);
assert.equal(enterInsertsNewline(0, true), true);
assert.equal(enterInsertsNewline(0, false), false, "desktop retains Enter shortcut, regardless of width");
const normalFile = { id: "file", state: "ready" as const, media: {} };
const voiceFiles = [
  { id: "voice-upload", state: "uploading" as const, voice: {} },
  { id: "voice-failed", state: "error" as const, voice: {} },
];
assert.deepEqual(manualAttachments([...voiceFiles, normalFile]), [normalFile], "manual Send must preserve all independent voice deliveries");
assert.equal(manualAttachments(voiceFiles).length, 0, "Enter cannot send pending audio a second time");
console.log("composer tests passed");
