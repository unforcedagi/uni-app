#!/usr/bin/env bash
# T-229: one walk of the real debug app against a calendar door (walkthrough/t45's launch and shots, with the door's URL).
# Usage: BIN=<binary> UNI_CAL_URL=<door> KEY_FILE=<nsec file> DRIVER=<driver.js> walk.sh <run name>
# STOP_DOOR=<pid>: when the driver writes stop-door, that process (a fake door) is stopped, so the app sees it gone.
# Output: ${RUNS:-walkthrough/t229/runs}/<name>/{<label>.png, walk-log.json, app.log}
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
: "${UNI_CAL_URL:?}"
export UNI_CAL_URL UNI_MAIL_URL=${UNI_MAIL_URL:-http://127.0.0.1:9}
NAME=${1:?run name}
export OUT=${RUNS:-$W/runs}/$NAME
rm -rf "$OUT"; mkdir -p "$OUT"
export UNI_T76_INIT=${DRIVER:?driver} WALK_HOME=${TMPDIR:-/tmp/claude-1000}/t229-apphome-$NAME
rm -rf "$WALK_HOME"
bash "$W/../t45/launch.sh" &
L=$!
for _ in $(seq 1 100); do [ -s "$OUT/socket" ] && break; sleep 0.2; done
python3 "$W/../t45/shots.py" "$OUT" "$(cat "$OUT/socket")" &
S=$!
for _ in $(seq 1 "${WALK_TIMEOUT:-180}"); do
  { [ -e "$OUT/done" ] || [ -e "$OUT/error.txt" ]; } && break
  if [ -n "${STOP_DOOR:-}" ] && [ -e "$OUT/stop-door" ]; then kill "$STOP_DOOR" 2>/dev/null || true; rm -f "$OUT/stop-door"; fi
  sleep 1
done
sleep 1
kill "$(cat "$OUT/pid")" 2>/dev/null || true
wait $S 2>/dev/null || true; wait $L 2>/dev/null || true
rm -rf "$WALK_HOME"
ls "$OUT"
