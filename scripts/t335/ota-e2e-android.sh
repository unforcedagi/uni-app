#!/usr/bin/env bash
# T-335 OTA emulator proof, step 2: an emulator runs an APK whose built-in screens are 0.4.0, built with the test
# broker's key and a local channel (never the release key, never a real device):
#   UNI_OTA_PUBKEY=$(cat <bundles>/signed/pubkey) UNI_OTA_CHANNEL=http://10.0.2.2:18335/web.json \
#     UNI_ANDROID_UNSIGNED=1 bash scripts/android-release-build.sh 0.4.0 1004000
# then signed with a throwaway key (apksigner). 10.0.2.2 is the emulator's address for this machine. The bundles come from
# ota-e2e-bundles.sh. Each step publishes one bundle to the channel, then launches or resumes the app, takes a screenshot
# and keeps what the app logged ([ota] lines).
# usage: scripts/t335/ota-e2e-android.sh <emulator serial> <signed apk> <bundles dir> <out-dir>
set -euo pipefail
SERIAL=${1:?serial}; APK=${2:?apk}; BUNDLES=${3:?bundles}; OUT=${4:?out}
[[ $SERIAL == emulator-* ]] || { echo "emulators only" >&2; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT/channel" "$OUT/shots"
E="adb -s $SERIAL"
PIDS=()
trap 'for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; $E shell settings put global auto_time 1 >/dev/null 2>&1 || true' EXIT
python3 -I -m http.server 18335 --bind 127.0.0.1 -d "$OUT/channel" > "$OUT/channel.log" 2>&1 & PIDS+=($!)
publish() { rm -f "$OUT/channel/"*; cp "$BUNDLES/signed/$1/"* "$OUT/channel/"; echo "== published $1: $(ls "$OUT/channel" | tr '\n' ' ')" | tee -a "$OUT/steps.log"; }
shot() { $E shell screencap -p /sdcard/t335.png && $E pull /sdcard/t335.png "$OUT/shots/$1.png" >/dev/null; }
record() { # <n> <label>: what the app logged since the last step
  $E logcat -d | grep -F '[ota]' | sed -E 's/^.*\[ota\] //' > "$OUT/log-$1.txt" || true
  echo "$1 ($2): $(tr '\n' ';' < "$OUT/log-$1.txt")" | tee -a "$OUT/steps.log"
  $E logcat -c
}
launch() { # <n> <label>: a cold start
  $E shell am force-stop org.unforced.uni
  $E logcat -c
  $E shell monkey -p org.unforced.uni -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  sleep "${WAIT:-25}"; shot "$1-$2"; record "$1" "$2"
}
resume() { # <n> <label>: home, then back to the running app (no restart). New screens go in only after 2 min away.
  $E shell input keyevent KEYCODE_HOME; sleep "${AWAY:-5}"
  $E shell monkey -p org.unforced.uni -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  sleep "${WAIT:-25}"; shot "$1-$2"; record "$1" "$2"
}

$E root >/dev/null 2>&1 || true; sleep 2
$E uninstall org.unforced.uni >/dev/null 2>&1 || true
$E install "$APK" | tail -1
$E shell dumpsys package org.unforced.uni | grep -E 'versionName|lastUpdateTime' | tee -a "$OUT/steps.log"
$E logcat -c

publish n1;         WAIT=45 launch 01 built-in-0.4.0-finds-0.4.1  # a first start after install is slow on the emulator
launch 02 serves-0.4.1-no-apk
publish n2;         AWAY=40 resume 03 resume-finds-0.4.2
AWAY=130 resume 04 resume-puts-in-0.4.2
publish tampered;   launch 05 tampered-refused
publish expired
NOW=$($E shell date +%s | tr -d '\r')
$E shell settings put global auto_time 0
$E shell date "@$((NOW + 2 * 86400))" >/dev/null || $E shell toybox date -s "@$((NOW + 2 * 86400))" >/dev/null
echo "== phone clock moved on two days: $($E shell date | tr -d '\r')" | tee -a "$OUT/steps.log"
launch 06 expired-refused
$E shell date "@$(( $(date +%s) ))" >/dev/null || true
$E shell settings put global auto_time 1
echo "== phone clock back: $($E shell date | tr -d '\r')" | tee -a "$OUT/steps.log"
publish api2;       launch 07 api2-needs-newer-app
publish neverready; launch 08 finds-0.4.6
launch 09 0.4.6-on-trial-1
launch 10 0.4.6-on-trial-2
launch 11 0.4.6-on-trial-3
launch 12 back-to-last-good-0.4.2
$E shell dumpsys package org.unforced.uni | grep -E 'versionName|lastUpdateTime' | sed 's/^/== at the end, still the one install: /' | tee -a "$OUT/steps.log"
grep -h '"GET' "$OUT/channel.log" > "$OUT/channel-requests.log" || true
echo "done: $OUT/steps.log"
