#!/usr/bin/env bash
# T-200 C on a real desktop webview: the Linux debug build in a headless `cage`, throwaway HOME and key, no relay, invented data.
# The frontend is the fixture build with the driver (VITE_T200_DRIVE=1): it opens the plan in a second window, quotes a line there,
# closes it, and sends from the main window. grim records frames; the run's outcome is in them.
# build first: scripts/t200/build-desktop-c.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${TMPDIR:-/tmp}/t200/desktop-c; rm -rf "$OUT"; mkdir -p "$OUT/frames"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "${FAKE:-/nonexistent-t200}"; }
trap cleanup EXIT
FAKE=$(mktemp -d)
export HOME=$FAKE XDG_DATA_HOME=$FAKE/data XDG_CONFIG_HOME=$FAKE/config XDG_CACHE_HOME=$FAKE/cache XDG_STATE_HOME=$FAKE/state
export UNI_RELAY_URL=ws://127.0.0.1:9 UNI_NO_KEYRING=1 UNI_NSEC=$(openssl rand -hex 32)
export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman WLR_HEADLESS_OUTPUTS=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=wayland
unset WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE XDG_CURRENT_DESKTOP DESKTOP_SESSION
RT=/run/user/$(id -u)
BEFORE=$(ls "$RT" | grep -E '^wayland-[0-9]+$' || true)
timeout "${T_TIMEOUT:-40}" cage -- "$ROOT/target/debug/uni-app-tauri" > "$OUT/app.log" 2>&1 & PIDS+=($!)
NEW=
for _ in $(seq 1 50); do
  NEW=$(comm -13 <(echo "$BEFORE" | sort) <(ls "$RT" | grep -E '^wayland-[0-9]+$' | sort) | head -1 || true)
  [ -n "$NEW" ] && break; sleep 0.2
done
echo "cage socket: ${NEW:-none}" > "$OUT/cage-socket.txt"
# Without cage's own socket, grim would fall back to the real desktop's display: stop rather than screenshot it.
[ -n "$NEW" ] || { echo "cage did not start; see $OUT/app.log" >&2; exit 1; }
( while true; do WAYLAND_DISPLAY=$NEW grim -t png "$OUT/frames/$(date +%s%3N).png" 2>/dev/null; sleep 0.3; done ) & PIDS+=($!)
sleep "${T_TIMEOUT:-40}"
unset UNI_NSEC
ls "$OUT/frames" | wc -l
