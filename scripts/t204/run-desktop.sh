#!/usr/bin/env bash
# T-204: real Linux debug build in headless cage, throwaway HOME and key, stand-in hub on :18204. Opens one fixture
# note, taps Download .md, presses Save in the real GTK Save dialog (AT-SPI, atspi_save.py), then compares the saved file's bytes
# with the fixture. Build first (from the repo root):
#   UNI_T76=1 node node_modules/vite/bin/vite.js build
#   ./node_modules/.bin/tauri build --debug --no-bundle --config '{"build":{"beforeBuildCommand":""}}'
# usage: run-desktop.sh <note index in scripts/fixtures/t204-notes.json> [frontmatter 0|1]
set -euo pipefail
# A private session bus: the accessibility bus (AT-SPI) the dialog helper uses lives on it, not on the real desktop's.
[ -n "${T204_IN_DBUS:-}" ] || exec env T204_IN_DBUS=1 dbus-run-session -- bash "$0" "$@"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/scripts/t204
FIX=$ROOT/scripts/fixtures/t204-notes.json
IDX=${1:-0} FM=${2:-0}
OUT=$TMPDIR/t204/desktop-$IDX; rm -rf "$OUT"; mkdir -p "$OUT/frames"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "${FAKE:-/nonexistent-t204}"; }
trap cleanup EXIT
# The accessibility bus and registry, started by hand: their systemd activation fails on a private bus.
/usr/lib/at-spi-bus-launcher --launch-immediately & PIDS+=($!)
sleep 1
AT_SPI_BUS_ADDRESS=$(gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.a11y.Bus.GetAddress | sed -E "s/^\(.(.*).,\)$/\1/")
export AT_SPI_BUS_ADDRESS
/usr/lib/at-spi2-registryd & PIDS+=($!)
python3 -I "$H/hub.py" 18204 "$FIX" "$OUT/hub.log" & PIDS+=($!)
NOTE_ID=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["notes"][int(sys.argv[2])]["id"])' "$FIX" "$IDX")
{ echo "const T204 = { noteId: '$NOTE_ID', frontmatter: $([ "$FM" = 1 ] && echo true || echo false), manual: ${T204_MANUAL_MS:-0} };"; cat "$H/desktop-init.js"; } > "$OUT/init.js"
FAKE=$(mktemp -d)
export HOME=$FAKE XDG_DATA_HOME=$FAKE/data XDG_CONFIG_HOME=$FAKE/config XDG_CACHE_HOME=$FAKE/cache XDG_STATE_HOME=$FAKE/state
mkdir -p "$XDG_DATA_HOME/org.unforced.uni" "$XDG_CONFIG_HOME"
echo '{"hub":"http://127.0.0.1:18204","vault":"uni"}' > "$XDG_DATA_HOME/org.unforced.uni/vault.json"
export UNI_T76_DIR=$OUT UNI_T76_INIT=$OUT/init.js UNI_RELAY_URL=ws://127.0.0.1:9 UNI_NO_KEYRING=1
export UNI_NSEC=$(openssl rand -hex 32)
export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman WLR_HEADLESS_OUTPUTS=1
export GTK_A11Y=atspi NO_AT_BRIDGE=0
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=wayland
unset WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE XDG_CURRENT_DESKTOP DESKTOP_SESSION
RT=/run/user/$(id -u)
BEFORE=$(ls "$RT" | grep -E '^wayland-[0-9]+$' || true)
timeout "${T_TIMEOUT:-120}" cage -- "$ROOT/target/debug/uni-app-tauri" > "$OUT/app.log" 2>&1 & PIDS+=($!)
NEW=
for _ in $(seq 1 50); do
  NEW=$(comm -13 <(echo "$BEFORE" | sort) <(ls "$RT" | grep -E '^wayland-[0-9]+$' | sort) | head -1 || true)
  [ -n "$NEW" ] && break; sleep 0.2
done
# Without cage's own socket, grim and wtype would reach the real desktop.
[ -n "$NEW" ] || { echo "cage socket not found" > "$OUT/error.txt"; exit 1; }
echo "$NEW" > "$OUT/cage-socket.txt"
python3 -I "$H/atspi_save.py" "$OUT" & PIDS+=($!)
( while true; do WAYLAND_DISPLAY=$NEW grim -t jpeg -q 85 "$OUT/frames/$(date +%s%3N).jpg" 2>/dev/null; sleep 0.25; done ) & PIDS+=($!)
for _ in $(seq 1 "${T_TIMEOUT:-120}"); do { [ -e "$OUT/done" ] || [ -e "$OUT/error.txt" ]; } && break; sleep 1; done
sleep 1
unset UNI_NSEC
ls -la "$FAKE/Downloads" > "$OUT/downloads.txt" 2>&1 || true
# The check: one file in Downloads, under the expected name, with the fixture's bytes (plus front matter when asked).
python3 -I - "$FIX" "$IDX" "$FM" "$FAKE/Downloads" > "$OUT/check.txt" <<'PY' && cat "$OUT/check.txt" || { cat "$OUT/check.txt"; exit 1; }
import json, os, sys
fix, idx, fm, dl = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "1", sys.argv[4]
n = json.load(open(fix, encoding="utf-8"))["notes"][idx]
want = n["content"].encode()
if fm:
    keys = f'path: {json.dumps(n["path"])}\ncreated: {json.dumps(n["createdAt"])}\nupdated: {json.dumps(n["updatedAt"])}\n'.encode()
    # A note with its own front matter gets the keys inside its block; others get a block of their own.
    want = b"---\n" + keys + want[4:] if want.startswith(b"---\n") else b"---\n" + keys + b"---\n" + want
files = sorted(os.listdir(dl)) if os.path.isdir(dl) else []
print("Downloads:", files)
assert files == [n["expectedName"]], f"expected {[n['expectedName']]}"
got = open(os.path.join(dl, files[0]), "rb").read()
assert got == want, f"bytes differ: {len(got)} vs {len(want)}"
print(f"OK {files[0]!r}: {len(got)} bytes, identical to the fixture" + (" with front matter" if fm else ""))
PY
