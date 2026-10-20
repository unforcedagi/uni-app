#!/usr/bin/env bash
# T-204: install the debug APK on the test EMULATOR only, open a fixture note, Download .md and Share over CDP,
# then check /sdcard/Download/<name>.md and the shared copy byte for byte against the fixture, and that the share
# sheet (ACTION_CHOOSER around ACTION_SEND) opened. Build first (repo root, ~/.config/uni/android.env sourced):
#   UNI_T76=1 node node_modules/vite/bin/vite.js build
#   ./node_modules/.bin/tauri android build --debug --apk --target x86_64 --config '{"build":{"beforeBuildCommand":""}}'
# usage: android-run.sh <apk> [note index]   (emulator serial: $S, default emulator-5570)
set -euo pipefail
APK=$1; IDX=${2:-0}
ROOT=$(cd "$(dirname "$0")/../.." && pwd); H=$ROOT/scripts/t204; FIX=$ROOT/scripts/fixtures/t204-notes.json
export ADB=${ADB:-$HOME/Android/Sdk/platform-tools/adb}; S=${S:-emulator-5570}; E="$ADB -s $S"; P=org.unforced.uni
case "$S" in emulator-*) ;; *) echo "refusing: $S is not an emulator" >&2; exit 1;; esac
OUT=$TMPDIR/t204/android-$IDX; rm -rf "$OUT"; mkdir -p "$OUT"
NAME=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["notes"][int(sys.argv[2])]["expectedName"])' "$FIX" "$IDX")
$E root >/dev/null; $E wait-for-device
$E uninstall $P >/dev/null 2>&1 || true
$E shell "rm -f '/sdcard/Download/$NAME'"
$E install "$APK" | tail -1
$E logcat -c
$E shell monkey -p $P -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
until $E shell pidof $P >/dev/null 2>&1; do sleep 1; done
PID=$($E shell pidof $P | tr -d '\r')
$E forward --remove tcp:9342 2>/dev/null || true
$E forward tcp:9342 localabstract:webview_devtools_remote_$PID >/dev/null
for _ in $(seq 1 30); do curl -s http://127.0.0.1:9342/json | grep -q webSocketDebuggerUrl && break; sleep 1; done
sleep 3
WS=$(curl -s http://127.0.0.1:9342/json | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['webSocketDebuggerUrl'])")
$E shell rm -f /sdcard/t204.mp4
date +%s%3N > "$OUT/rec-start"
$E shell screenrecord --time-limit 90 --bit-rate 6000000 /sdcard/t204.mp4 & REC=$!
sleep 1
node "$H/android-drive.mjs" "$WS" "$H/android-init.js" "$FIX" "$IDX" "$OUT" "$S" || echo "driver failed"
sleep 1
$E shell pkill -INT screenrecord || true; wait $REC 2>/dev/null || true; sleep 2
$E pull /sdcard/t204.mp4 "$OUT/android-run.mp4" >/dev/null || true
$E logcat -d > "$OUT/android-logcat.txt"
grep -E "START u0 .*(CHOOSER|SEND)" "$OUT/android-logcat.txt" | sed 's/^.*START/START/' > "$OUT/share-intent.txt" || true
$E shell dumpsys activity activities | grep -E "topResumedActivity|act=android.intent.action.(CHOOSER|SEND)" | head -5 >> "$OUT/share-intent.txt" || true
$E pull "/sdcard/Download/$NAME" "$OUT/downloaded.md" >/dev/null 2>&1 || true
$E shell "find /data/data/$P/cache/shared -type f" > "$OUT/shared-files.txt" || true
SHARED=$(grep -F "/$NAME" "$OUT/shared-files.txt" | tr -d '\r' | head -1 || true)
[ -n "$SHARED" ] && $E pull "$SHARED" "$OUT/shared.md" >/dev/null || true
$E shell content query --uri content://media/external/downloads --projection _display_name:mime_type:relative_path:_size:is_pending --where "\"_display_name LIKE '%.md'\"" > "$OUT/mediastore.txt" || true
$E shell input keyevent KEYCODE_BACK || true
cat "$OUT/share-intent.txt" "$OUT/mediastore.txt"
python3 -I - "$FIX" "$IDX" "$OUT" <<'PY' | tee "$OUT/check.txt"
import json, os, sys
fix, idx, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
n = json.load(open(fix, encoding="utf-8"))["notes"][idx]
want = n["content"].encode()
for f in ("downloaded.md", "shared.md"):
    p = os.path.join(out, f)
    assert os.path.exists(p), f"{f}: missing"
    got = open(p, "rb").read()
    assert got == want, f"{f}: bytes differ ({len(got)} vs {len(want)})"
    print(f"OK {f} ({n['expectedName']!r}): {len(got)} bytes, identical to the fixture")
intent = open(os.path.join(out, "share-intent.txt")).read()
assert "android.intent.action.CHOOSER" in intent, "no share sheet (ACTION_CHOOSER) started"
print("OK share sheet started (ACTION_CHOOSER)")
PY
