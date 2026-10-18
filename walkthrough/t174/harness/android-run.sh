#!/usr/bin/env bash
# T-174: install the harness APK on the test emulator (adb root), put the test files in the app's media cache,
# drive Save / Open over CDP while recording the screen, then show Downloads in the Files app.
# usage: android-run.sh <apk> <data dir> <out dir>
set -euo pipefail
APK=$1; DATA=$2; OUT=$3; H=$(cd "$(dirname "$0")" && pwd)
export ADB=${ADB:-$HOME/Android/Sdk/platform-tools/adb}; S=emulator-5570; E="$ADB -s $S"; P=org.unforced.uni
mkdir -p "$OUT"
$E uninstall $P >/dev/null 2>&1 || true
[ -n "${KEEP_DOWNLOADS:-}" ] || $E shell content delete --uri content://media/external/downloads --where "\"_display_name LIKE 'Q3 report%' OR _display_name LIKE 'class%' OR _display_name LIKE 'garden%'\""
$E install "$APK" | tail -1
$E shell monkey -p $P -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 3
U=$($E shell "stat -c %u /data/data/$P" | tr -d '\r')
for f in report.pdf class.mp4 photo.jpg; do
  SHA=$(sha256sum "$DATA/$f" | cut -d' ' -f1)
  $E push "$DATA/$f" /data/local/tmp/$f >/dev/null
  $E shell "mkdir -p /data/data/$P/cache/media && cp /data/local/tmp/$f /data/data/$P/cache/media/$SHA"
done
$E shell "chown -R $U:$U /data/data/$P/cache && restorecon -R /data/data/$P/cache"
$E shell am force-stop $P; $E logcat -c
$E shell monkey -p $P -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
until $E shell pidof $P >/dev/null 2>&1; do sleep 1; done
PID=$($E shell pidof $P | tr -d '\r')
$E forward --remove tcp:9341 2>/dev/null || true
$E forward tcp:9341 localabstract:webview_devtools_remote_$PID >/dev/null
for _ in $(seq 1 30); do curl -s http://127.0.0.1:9341/json | grep -q webSocketDebuggerUrl && break; sleep 1; done
sleep 3
WS=$(curl -s http://127.0.0.1:9341/json | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['webSocketDebuggerUrl'])")
$E shell rm -f /sdcard/t174.mp4
date +%s%3N > "$OUT/rec-start"
$E shell screenrecord --time-limit 170 --bit-rate 6000000 /sdcard/t174.mp4 & REC=$!
sleep 1
node "$H/android-drive.mjs" "$WS" "$H/android-init.js" "$OUT" $S "$DATA/photo.jpg" || echo "driver failed"
# Downloads, as the user sees it (Files app).
$E shell am start -a android.intent.action.VIEW -t vnd.android.document/root -d content://com.android.providers.downloads.documents/root/downloads >/dev/null 2>&1 || true
sleep 4
date +%s%3N > "$OUT/mark-downloads"
$E exec-out screencap -p > "$OUT/android-09-downloads.png"
sleep 2
$E shell pkill -INT screenrecord || true; wait $REC 2>/dev/null || true; sleep 2
$E pull /sdcard/t174.mp4 "$OUT/android-run.mp4" >/dev/null
$E logcat -d > "$OUT/android-logcat.txt"
$E shell 'cd /sdcard/Download && sha256sum *' > "$OUT/android-downloads.txt"
$E shell content query --uri content://media/external/downloads --projection _display_name:mime_type:relative_path:_size:is_pending >> "$OUT/android-downloads.txt"
$E shell am start -n $P/.MainActivity >/dev/null
cat "$OUT/android-downloads.txt"
