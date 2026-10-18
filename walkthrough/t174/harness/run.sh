#!/usr/bin/env bash
# T-174: real debug build in headless cage, throwaway HOME and key, local Blossom stand-in on :18174.
# xdg-open goes through open-log.sh (records what was opened) to evince / mpv / imv.
# usage: run.sh <data dir with the test files>   (build first: UNI_T76=1 vite build; tauri build --debug --no-bundle)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
H=$ROOT/walkthrough/t174/harness
DATA=$1
W=$TMPDIR/t174
OUT=$W/out; rm -rf "$OUT"; mkdir -p "$OUT/frames"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "${FAKE:-/nonexistent-t174}"; }
trap cleanup EXIT
python3 -I "$H/server.py" 18174 "$DATA" "$OUT/server.log" & PIDS+=($!)
FAKE=$(mktemp -d)
export HOME=$FAKE XDG_DATA_HOME=$FAKE/data XDG_CONFIG_HOME=$FAKE/config XDG_CACHE_HOME=$FAKE/cache XDG_STATE_HOME=$FAKE/state
mkdir -p "$XDG_DATA_HOME/applications" "$XDG_CONFIG_HOME"
for v in pdf:evince:application/pdf video:mpv:video/mp4 image:imv:image/jpeg; do
  IFS=: read -r k viewer mime <<< "$v"
  printf '[Desktop Entry]\nType=Application\nName=t174 %s\nExec=%s %s %%f\nMimeType=%s;\n' "$k" "$H/open-log.sh" "$viewer" "$mime" > "$XDG_DATA_HOME/applications/t174-$k.desktop"
done
printf '[Default Applications]\napplication/pdf=t174-pdf.desktop\nvideo/mp4=t174-video.desktop\nimage/jpeg=t174-image.desktop\n' > "$XDG_CONFIG_HOME/mimeapps.list"
export UNI_T76_DIR=$OUT UNI_T76_INIT=$H/init.js UNI_RELAY_URL=ws://127.0.0.1:18174 UNI_NO_KEYRING=1
export UNI_NSEC=$(openssl rand -hex 32)
export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman WLR_HEADLESS_OUTPUTS=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=wayland
unset WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE XDG_CURRENT_DESKTOP DESKTOP_SESSION
RT=/run/user/$(id -u)
BEFORE=$(ls "$RT" | grep -E '^wayland-[0-9]+$' || true)
timeout "${T_TIMEOUT:-180}" cage -- "$ROOT/target/debug/uni-app-tauri" > "$OUT/app.log" 2>&1 & PIDS+=($!)
NEW=
for _ in $(seq 1 50); do
  NEW=$(comm -13 <(echo "$BEFORE" | sort) <(ls "$RT" | grep -E '^wayland-[0-9]+$' | sort) | head -1 || true)
  [ -n "$NEW" ] && break; sleep 0.2
done
echo "cage socket: ${NEW:-none}" > "$OUT/cage-socket.txt"
( while true; do WAYLAND_DISPLAY=$NEW grim -t jpeg -q 85 "$OUT/frames/$(date +%s%3N).jpg" 2>/dev/null; sleep 0.15; done ) & PIDS+=($!)
for _ in $(seq 1 "${T_TIMEOUT:-180}"); do { [ -e "$OUT/done" ] || [ -e "$OUT/error.txt" ]; } && break; sleep 1; done
sleep 1
unset UNI_NSEC
find "$FAKE" -name 'uni.log*' -exec cp {} "$OUT/" ';' || true
(cd "$FAKE" && find Downloads -type f -exec sha256sum {} + ) > "$OUT/downloads.txt" 2>&1 || true
ls -la "$FAKE/cache/org.unforced.uni/media" > "$OUT/cache-listing.txt" 2>&1 || true
ls "$OUT"
