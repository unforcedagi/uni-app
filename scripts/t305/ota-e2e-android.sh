#!/usr/bin/env bash
# T-305 spike on Android: an emulator runs a spike APK built with
#   UNI_OTA_CHANNEL=http://10.0.2.2:18305/manifest.json bash scripts/android-release-build.sh 0.1.84 1001084
# (10.0.2.2 is the emulator's address for this machine). Bundle N is published, then N+1, then a tampered one; the
# app switches web layers across launches with no new APK. Never point this at a real device.
# usage: scripts/t305/ota-e2e-android.sh <emulator serial> <apk> <bundles dir from ota-e2e-desktop.sh> <out-dir>
set -euo pipefail
SERIAL=${1:?serial}; APK=${2:?apk}; BUNDLES=${3:?bundles}; OUT=${4:?out}
[[ $SERIAL == emulator-* ]] || { echo "emulators only" >&2; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT/channel" "$OUT/shots"
E="adb -s $SERIAL"
PIDS=()
trap 'for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done' EXIT
python3 -I -m http.server 18305 --bind 127.0.0.1 -d "$OUT/channel" > "$OUT/channel.log" 2>&1 & PIDS+=($!)
publish() { rm -f "$OUT/channel/"*; cp "$BUNDLES/$1/"* "$OUT/channel/"; echo "published $1: $(cat "$OUT/channel/manifest.json")" | tee -a "$OUT/steps.log"; }

$E install -r "$APK" | tail -1
$E shell dumpsys package org.unforced.uni | grep -E 'versionName|firstInstallTime|lastUpdateTime' | tee -a "$OUT/steps.log"

launch() { # <n> <label>
  $E shell am force-stop org.unforced.uni
  $E logcat -c
  $E shell monkey -p org.unforced.uni -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  sleep "${WAIT:-30}"
  $E shell screencap -p /sdcard/t305.png && $E pull /sdcard/t305.png "$OUT/shots/$1-$2.png" >/dev/null
  $E logcat -d | grep -F '[ota]' | sed -E 's/^.*\[ota\] //' > "$OUT/launch-$1.log" || true
  echo "launch $1 ($2): $(tr '\n' ';' < "$OUT/launch-$1.log")" | tee -a "$OUT/steps.log"
}

publish n;        launch 1 builtin-downloads-N
launch 2 serves-N
publish n1;       launch 3 serves-N-downloads-N1
launch 4 serves-N1
publish tampered; launch 5 tampered-refused
grep -h '"GET' "$OUT/channel.log" > "$OUT/channel-requests.log" || true
echo "done: $OUT/steps.log"
