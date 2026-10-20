#!/usr/bin/env bash
# T-45: one walk of the real debug app.
# Usage: BIN=<binary> UNI_MAIL_URL=<bridge> KEY_FILE=<nsec file> DRIVER=<driver.js> walk.sh <run name>
# Output: ${RUNS:-walkthrough/t45/runs}/<name>/{<label>.png, walk-log.json, app.log}
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
NAME=${1:?run name}
export OUT=${RUNS:-$W/runs}/$NAME
rm -rf "$OUT"; mkdir -p "$OUT"
export UNI_T76_INIT=${DRIVER:-$W/driver.js} WALK_HOME=${TMPDIR:-/tmp/claude-1000}/t45-apphome-$NAME
rm -rf "$WALK_HOME"
bash "$W/launch.sh" &
L=$!
for _ in $(seq 1 100); do [ -s "$OUT/socket" ] && break; sleep 0.2; done
python3 "$W/shots.py" "$OUT" "$(cat "$OUT/socket")" &
S=$!
for _ in $(seq 1 "${WALK_TIMEOUT:-180}"); do { [ -e "$OUT/done" ] || [ -e "$OUT/error.txt" ]; } && break; sleep 1; done
sleep 1
kill "$(cat "$OUT/pid")" 2>/dev/null || true
wait $S 2>/dev/null || true; wait $L 2>/dev/null || true
rm -rf "$WALK_HOME"
ls "$OUT"
