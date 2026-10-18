#!/usr/bin/env bash
# T-172: real debug build in headless cage, throwaway HOME and key, local Blossom stand-in on :18172.
set -euo pipefail
ROOT=/home/uni/Code/wt/t172-media
W=$TMPDIR/t172
OUT=$W/out; rm -rf "$OUT"; mkdir -p "$OUT/frames"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "${FAKE:-/nonexistent-t172}"; }
trap cleanup EXIT
SHA=$(sha256sum "$W/clip.mp4" | cut -d' ' -f1)
python3 -I "$W/server.py" 18172 "$W/clip.mp4" "$OUT/server.log" "$SHA" & PIDS+=($!)
FAKE=$(mktemp -d)
export HOME=$FAKE XDG_DATA_HOME=$FAKE/data XDG_CONFIG_HOME=$FAKE/config XDG_CACHE_HOME=$FAKE/cache XDG_STATE_HOME=$FAKE/state
export UNI_T76_DIR=$OUT UNI_T76_INIT=$W/init.js UNI_RELAY_URL=ws://127.0.0.1:18172 UNI_NO_KEYRING=1
export UNI_NSEC=$(openssl rand -hex 32)
export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman WLR_HEADLESS_OUTPUTS=1
export WEBKIT_DEBUG=${WEBKIT_DEBUG:-} GST_DEBUG=${GST_DEBUG:-}
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=wayland
unset WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE
RT=/run/user/$(id -u)
BEFORE=$(ls "$RT" | grep -E '^wayland-[0-9]+$' || true)
timeout "${T_TIMEOUT:-150}" cage -- "$ROOT/target/debug/uni-app-tauri" > "$OUT/app.log" 2>&1 & PIDS+=($!)
NEW=
for _ in $(seq 1 50); do
  NEW=$(comm -13 <(echo "$BEFORE" | sort) <(ls "$RT" | grep -E '^wayland-[0-9]+$' | sort) | head -1 || true)
  [ -n "$NEW" ] && break; sleep 0.2
done
echo "cage socket: ${NEW:-none}" > "$OUT/cage-socket.txt"
( i=0; while true; do WAYLAND_DISPLAY=$NEW grim -t jpeg -q 85 "$OUT/frames/$(date +%s%3N).jpg" 2>/dev/null && i=$((i+1)); sleep 0.15; done ) & PIDS+=($!)
for _ in $(seq 1 "${T_TIMEOUT:-150}"); do { [ -e "$OUT/done" ] || [ -e "$OUT/error.txt" ]; } && break; sleep 1; done
sleep 1
unset UNI_NSEC
find "$FAKE" -name 'uni.log*' -exec cp {} "$OUT/" ';' || true
ls "$FAKE/cache/org.unforced.uni/media" -la > "$OUT/cache-listing.txt" 2>&1 || true
sha256sum "$FAKE/cache/org.unforced.uni/media/$SHA" > "$OUT/cache-sha.txt" 2>&1 || true
ls "$OUT"
