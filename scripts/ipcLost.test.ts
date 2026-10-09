// T-77b P3-1: recognise the TypeError from the removed webkit ipc handler. Run: node --experimental-strip-types scripts/ipcLost.test.ts
import assert from "node:assert/strict";
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const m: Any = await import("../src/ipcLost.ts").catch(() => ({}));
let failed = 0;
const check = (n: string, f: () => void) => { try { f(); console.log(`ok   ${n}`); } catch (e) { failed++; console.log(`FAIL ${n}\n     ${(e as Error).message.split("\n")[0]}`); } };
check("recognises the WebKitGTK message for the missing ipc handler", () => {
  assert.equal(m.isLostIpcError(new TypeError("undefined is not an object (evaluating 'window.webkit.messageHandlers['ipc'].postMessage')")), true);
  assert.equal(m.isLostIpcError("undefined is not an object (evaluating 'window.webkit.messageHandlers.ipc.postMessage')"), true);
});
check("ignores unrelated errors", () => {
  assert.equal(m.isLostIpcError(new TypeError("undefined is not an object (evaluating 'x.y')")), false);
  assert.equal(m.isLostIpcError(new Error("messageHandlers")), false);
  assert.equal(m.isLostIpcError(null), false);
});
check("the toast text", () => assert.equal(m.IPC_LOST_MESSAGE, "Uni lost its connection to the app core. Restart Uni."));
process.exit(failed ? 1 : 0);
