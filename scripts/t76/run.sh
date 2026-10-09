#!/usr/bin/env bash
# T-76: run the debug Tauri build on the real WebKitGTK webview inside a headless `cage` compositor, with a throwaway
# HOME/XDG so the user's Uni app data is untouched, and let the injected driver write its results to $OUT.
# Needs: cage, wtype, the debug binary built with the frontend from `UNI_T76=1 vite build`
# (UNI_T76=1 node node_modules/vite/bin/vite.js build && npm run tauri build -- --debug --no-bundle --config '{"build":{"beforeBuildCommand":""}}').
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${OUT:-$HOME/.hermes/cache/scratch/t76}
export T76_PORT=${T76_PORT:-18176}
mkdir -p "$OUT"
cd "$OUT" && rm -f keys.req keys.ack keys.err http.log frame-ipc.txt selftest.json focus-theft.json experiments.json diag.json env.json done error.txt progress.log; cd "$ROOT"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "${FAKE:-/nonexistent-t76}"; }
trap cleanup EXIT

python3 "$ROOT/scripts/t76/listener.py" "$T76_PORT" "$OUT/http.log" & PIDS+=($!)
node --experimental-strip-types "$ROOT/scripts/t76/make-init.ts" "$OUT/init.js"

FAKE=$(mktemp -d)
export HOME=$FAKE XDG_DATA_HOME=$FAKE/data XDG_CONFIG_HOME=$FAKE/config XDG_CACHE_HOME=$FAKE/cache XDG_STATE_HOME=$FAKE/state
export UNI_T76_DIR=$OUT UNI_T76_INIT=$OUT/init.js
export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=wayland
unset WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE
RT=/run/user/$(id -u)
BEFORE=$(ls "$RT" | grep -E '^wayland-[0-9]+$' || true)
timeout "${T76_TIMEOUT:-240}" cage -- "$ROOT/target/debug/uni-app-tauri" > "$OUT/app.log" 2>&1 & PIDS+=($!)

# cage opens the first free wayland-N socket; wtype talks to it so the app receives real, trusted key events
NEW=
for _ in $(seq 1 50); do
  NEW=$(comm -13 <(echo "$BEFORE" | sort) <(ls "$RT" | grep -E '^wayland-[0-9]+$' | sort) | head -1 || true)
  [ -n "$NEW" ] && break; sleep 0.2
done
echo "cage socket: ${NEW:-none}" > "$OUT/cage-socket.txt"
python3 "$ROOT/scripts/t76/keys.py" "$OUT" "${NEW:-wayland-0}" & PIDS+=($!)

for _ in $(seq 1 "${T76_TIMEOUT:-240}"); do { [ -e "$OUT/done" ] || [ -e "$OUT/error.txt" ]; } && break; sleep 1; done
sleep 1
ls "$OUT"
