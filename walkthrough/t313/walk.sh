#!/usr/bin/env bash
# T-313 walkthrough: Messages with links, voice messages and their words, a photo, a file, a reply and reactions, filmed
# in the web build against the real Rust core (the dev bridge) and a throwaway homeserver full of made-up people.
#
#   walkthrough/t313/walk.sh up      start the homeserver (continuwuity, its own port and folder under $TMPDIR), seed it,
#                                    start the local whisper stand-in; writes $W/env.sh
#   walkthrough/t313/walk.sh film    voice the script, film the walk to its timing, mix in the music, encode WALKTHROUGH.mp4
#   walkthrough/t313/walk.sh down    stop what `up` started (only those processes, by pid)
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$D/../.." && pwd)
W=${T313_WALK_DIR:-${TMPDIR:-/tmp}/t313-walk}
STUDIO=~/studio/.venv/bin/python
WHISPER=~/.local/share/uni/transcribe-gpu/venv/bin/python
# the video toolkit (voice, mix, encode, qa): set T313_VT where it lives
VT=${T313_VT:-~/Code/uni-ops/research/t299-video-taste/tools/vt.py}
free() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }

case "${1:-}" in
up)
  mkdir -p "$W"
  HS_PORT=$(free); WH_PORT=$(free)
  cat > "$W/hs.toml" <<EOF
[global]
server_name = "example.org"
address = ["127.0.0.1"]
port = $HS_PORT
database_path = "$W/db"
allow_federation = false
allow_registration = true
registration_token = "walk-registration-token-0123456789"
allow_announcements_check = false
allow_legacy_media = false
trusted_servers = []
log = "info"
EOF
  ~/.local/share/uni-matrix/bin/continuwuity -c "$W/hs.toml" > "$W/hs.log" 2>&1 & echo $! > "$W/hs.pid"
  for _ in $(seq 60); do curl -sf "http://127.0.0.1:$HS_PORT/_matrix/client/versions" >/dev/null && break; sleep 0.5; done
  # the first account takes the one-time token a fresh database prints (a moment after it answers)
  BOOT=$(python3 - "$W/hs.log" <<'PY'
import re, sys, time
for _ in range(60):
    m = re.search(r"registration token (\S+) ", re.sub(r"\x1b\[[0-9;]*m", "", open(sys.argv[1]).read()))
    if m:
        print(m.group(1)); break
    time.sleep(0.5)
PY
)
  HF_HUB_OFFLINE=1 OMP_NUM_THREADS=4 nice -n 10 "$WHISPER" "$D/whisper_standin.py" "$WH_PORT" > "$W/whisper.log" 2>&1 & echo $! > "$W/whisper.pid"
  "$STUDIO" "$D/seed.py" "http://127.0.0.1:$HS_PORT" "$BOOT" walk-registration-token-0123456789 "$W"
  for _ in $(seq 120); do curl -sf "http://127.0.0.1:$WH_PORT/" >/dev/null && break; sleep 0.5; done
  printf 'export T313_HS=http://127.0.0.1:%s\nexport T313_WHISPER=http://127.0.0.1:%s/transcribe\nexport T313_DIR=%s\n' "$HS_PORT" "$WH_PORT" "$W" > "$W/env.sh"
  cat "$W/env.sh"
  ;;
film)
  . "$W/env.sh"
  mkdir -p "$D/runs"
  "$STUDIO" "$D/script.py" "$W/users.json" "$D/runs/lines.json"
  "$STUDIO" "$VT" voice "$D/runs/lines.json" "$D/runs/vo" --voice am_michael --speed 1.05 --lead 0.6 --gap 0.45 --tail 1.2
  rm -rf "$D/runs/film"
  (cd "$ROOT" && npx playwright test --config walkthrough/t313/playwright.config.ts)
  FILM=$(ls "$D"/runs/film/*/video.webm | head -1)
  START=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["start"])' "$D/runs/marks.json")
  DUR=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["duration"])' "$D/runs/vo/timeline.json")
  ffmpeg -y -loglevel error -ss "$START" -t "$DUR" -i "$FILM" -c:v libx264 -crf 16 -pix_fmt yuv420p "$D/runs/picture.mp4"
  "$STUDIO" "$VT" mix "$D/runs/vo/timeline.json" "$D/runs/mix.wav" --music ~/studio/tracks/first_light.wav --music-db -15 --duck-db -9
  "$STUDIO" "$VT" encode --video "$D/runs/picture.mp4" --audio "$D/runs/mix.wav" "$ROOT/WALKTHROUGH.mp4"
  "$STUDIO" "$VT" qa "$ROOT/WALKTHROUGH.mp4" --sheet "$D/runs/sheet.jpg"
  ;;
down)
  for p in hs whisper; do [ -f "$W/$p.pid" ] && kill "$(cat "$W/$p.pid")" 2>/dev/null || true; rm -f "$W/$p.pid"; done
  ;;
*) echo "usage: $0 up|film|down" >&2; exit 2 ;;
esac
