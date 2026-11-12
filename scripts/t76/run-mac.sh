#!/usr/bin/env bash
# T-335: the sandbox self-test on the real WKWebView (macOS), headless enough for a CI runner: the debug app opens its
# window, the injected driver (driver.js, T76_MODE=selftest) runs Settings → Run sandbox self-test and the frame-IPC
# experiments, and writes selftest.json, experiments.json and env.json to $OUT. No key presses. The frontend is the
# Playwright fixture's mock (synthetic), and the backend gets a throwaway HOME, no keychain and a dead relay, so a run
# on a developer's Mac leaves their Uni data alone.
# Needs the debug binary built with the harness frontend:
#   UNI_T76=1 node node_modules/vite/bin/vite.js build
#   pnpm tauri build --debug --no-bundle --config '{"build":{"beforeBuildCommand":""}}'
# Exit status 0 only when the driver finished without an error, every self-test check passed, no sandboxed frame found
# an ipc handler or wrote through it, and every nested frame level reported no WebRTC and no ipc.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${OUT:-${TMPDIR:-/tmp}/t76-mac}
export T76_PORT=${T76_PORT:-18176} T76_MODE=selftest
mkdir -p "$OUT"
rm -f "$OUT"/{http.log,frame-ipc.txt,selftest.json,experiments.json,diag.json,env.json,done,error.txt,progress.log,app.log}
PIDS=()
FAKE=$(mktemp -d)
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$FAKE"; }
trap cleanup EXIT

python3 "$ROOT/scripts/t76/listener.py" "$T76_PORT" "$OUT/http.log" & PIDS+=($!)
node --experimental-strip-types "$ROOT/scripts/t76/make-init.ts" "$OUT/init.js"

export UNI_T76_DIR=$OUT UNI_T76_INIT=$OUT/init.js HOME=$FAKE UNI_NO_KEYRING=1 UNI_RELAY_URL=ws://127.0.0.1:9
"$ROOT/target/debug/uni-app-tauri" > "$OUT/app.log" 2>&1 & PIDS+=($!)

for _ in $(seq 1 "${T76_TIMEOUT:-300}"); do { [ -e "$OUT/done" ] || [ -e "$OUT/error.txt" ]; } && break; sleep 1; done
[ -e "$OUT/error.txt" ] && { echo '--- driver error ---'; cat "$OUT/error.txt"; }
[ -e "$OUT/selftest.json" ] || { echo 'no selftest.json'; tail -n 40 "$OUT/progress.log" "$OUT/diag.json" 2>/dev/null; exit 1; }
node -e '
const fs = require("fs"), dir = process.argv[1];
const has = (n) => fs.existsSync(dir + "/" + n);
const read = (n) => { try { return JSON.parse(fs.readFileSync(dir + "/" + n, "utf8")); } catch { return null; } };
const r = read("selftest.json"), env = read("env.json"), exp = read("experiments.json") || {};
console.log("user agent:", env && env.userAgent);
console.log("top frame: RTCPeerConnection", env && env.rtcMain);
console.log("result:", r.text);
for (const c of r.checks) console.log(c.ok ? "  ✓" : "  ✗", c.label);
console.log("experiments:", JSON.stringify(exp, null, 2));
console.log("frame-ipc.txt written by a frame:", has("frame-ipc.txt"));
// Tauri refuses a forged key with an eprintln that names the real key: count the lines, never print them.
const log = (() => { try { return fs.readFileSync(dir + "/app.log", "utf8"); } catch { return ""; } })();
console.log("Tauri refusals of a wrong invoke key:", (log.match(/__TAURI_INVOKE_KEY__ expected/g) || []).length);
const levels = (exp.nested && exp.nested.levels) || [];
const failures = [
  [!has("done") || has("error.txt"), "the driver did not finish cleanly"],
  [!(r.checks.length > 0 && r.checks.every((c) => c.ok) && /pass/.test(r.status)), "a self-test check failed"],
  [has("frame-ipc.txt"), "a sandboxed frame wrote through the ipc handler"],
  [[exp.ipcFromFrame, exp.ipcFromFrameForgedKey].some((x) => !x || x.present !== false), "a sandboxed frame found webkit.messageHandlers.ipc"],
  [![0, 1, 2].every((d) => levels.some((l) => l.depth === d)), "a nested frame level did not report"],
  [levels.some((l) => l.rtc !== "undefined" || l.webkitRtc !== "undefined" || l.ipc !== false), "a nested frame has WebRTC or ipc"],
].filter(([bad]) => bad).map(([, why]) => why);
for (const f of failures) console.log("FAIL:", f);
process.exit(failures.length ? 1 : 0);
' "$OUT"
