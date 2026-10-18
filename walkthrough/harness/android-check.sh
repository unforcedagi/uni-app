#!/usr/bin/env bash
# T-172: install an APK on the test emulator, put the clip in the app's media cache, launch, run android-test2.js over CDP.
set -euo pipefail
APK=$1; W=$TMPDIR/t172; E="adb -s emulator-5570"; P=org.unforced.uni
SHA=$(sha256sum "$W/clip.mp4" | cut -d' ' -f1)
$E uninstall $P >/dev/null 2>&1 || true
$E install "$APK" | tail -1
$E push "$W/clip.mp4" /data/local/tmp/clip.mp4 >/dev/null
U=$($E shell "stat -c %u /data/data/$P" | tr -d '\r')
$E shell "mkdir -p /data/data/$P/cache/media && cp /data/local/tmp/clip.mp4 /data/data/$P/cache/media/$SHA && chown -R $U:$U /data/data/$P/cache && restorecon -R /data/data/$P/cache"
for attempt in 1 2; do
  $E shell am force-stop $P; $E shell monkey -p $P -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  until $E shell pidof $P >/dev/null 2>&1; do sleep 1; done
  PID=$($E shell pidof $P | tr -d '\r')
  $E forward --remove tcp:9339 2>/dev/null || true
  $E forward tcp:9339 localabstract:webview_devtools_remote_$PID >/dev/null
  for _ in $(seq 1 30); do curl -s http://127.0.0.1:9339/json | grep -q webSocketDebuggerUrl && break; sleep 1; done
  sleep 3
  WS=$(curl -s http://127.0.0.1:9339/json | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['webSocketDebuggerUrl'])")
  OUT=$(node "$W/cdp.mjs" "$WS" "${2:-$W/android-test2.js}" | tr -d '\n ')
  echo "$OUT"
  # First launch on a cold emulator can lose the Java bridge (seen once: 'Unknown object: 1'); one relaunch.
  echo "$OUT" | grep -q "postMessageisnotafunction" || break
done
