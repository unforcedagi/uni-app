import assert from "node:assert/strict";
import { attachmentBlocksSend, enterInsertsNewline } from "../src/composerCore.ts";

assert.equal(attachmentBlocksSend({ state: "ready", media: {}, voice: "transcribing" }), false);
assert.equal(attachmentBlocksSend({ state: "uploading", voice: "transcribing" }), true);
assert.equal(attachmentBlocksSend({ state: "ready" }), true, "missing media must block send");
assert.equal(attachmentBlocksSend({ state: "error" }), true);
assert.equal(attachmentBlocksSend({ state: "error", voice: "done" }), false, "explicit transcript-only send is supported");
assert.equal(attachmentBlocksSend({ state: "ready", media: {}, voice: "failed" }), false);
assert.equal(enterInsertsNewline(1, false), true);
assert.equal(enterInsertsNewline(0, true), true);
assert.equal(enterInsertsNewline(0, false), false, "desktop retains Enter shortcut, regardless of width");
console.log("composer tests passed");
