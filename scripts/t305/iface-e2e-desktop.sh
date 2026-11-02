#!/usr/bin/env bash
# T-305 interface platform spike, end to end on a real Linux build: the same shell runs Uni, then Garden (another
# agent's interface, signed with that agent's own key and fetched over the air from its own channel), which reads
# rooms from a relay and sends a letter; then back to Uni, which shows the letter; then a relaunch with Garden's
# channel down, which still opens Garden from the device. Made-up rooms and people (the repo's mock relay).
# Headless (cage), throwaway HOME and key. Build first, from the repo root:
#   UNI_OTA_CHANNEL=http://127.0.0.1:18305/manifest.json ./node_modules/.bin/tauri build --debug --no-bundle \
#     --config '{"version":"0.1.84"}'
# usage: UNI_IFACE_KEY=<the Garden agent's tauri signer key> scripts/t305/iface-e2e-desktop.sh <out-dir>
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:?out dir}; rm -rf "$OUT"; mkdir -p "$OUT/channel" "$OUT/shots" "$OUT/t76"
: "${UNI_IFACE_KEY:?}"
APP=$ROOT/target/debug/uni-app-tauri
PIDS=()
FAKE=$(mktemp -d)
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; [ -n "${RELAY_PID:-}" ] && kill -- "-$RELAY_PID" 2>/dev/null || true; cp "$FAKE"/state/org.unforced.uni/uni.log "$OUT/uni.log" 2>/dev/null || true; rm -rf "$FAKE"; }
trap cleanup EXIT
step() { echo "$(date +%T) $*" | tee -a "$OUT/steps.log"; }

# Garden, as its agent publishes it: built, signed with the agent's key, behind a signed, expiring manifest.
UNI_OTA_KEY=$UNI_IFACE_KEY bash "$ROOT/scripts/iface-bundle.sh" garden 0.1.0 "$OUT/channel" | tee -a "$OUT/steps.log"
python3 -I -m http.server 18306 --bind 127.0.0.1 -d "$OUT/channel" > "$OUT/channel.log" 2>&1 & CHANNEL_PID=$!; PIDS+=($CHANNEL_PID)

# A throwaway member key, and a relay with five rooms of made-up neighbours for it.
NSEC=$(openssl rand -hex 32)
MEMBER=$(python3 -I - "$NSEC" <<'PY'
import sys
P = 2**256 - 2**32 - 977
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798, 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)
def add(a, b):
    if a is None: return b
    if b is None: return a
    if a[0] == b[0] and (a[1] + b[1]) % P == 0: return None
    l = (3 * a[0] * a[0] * pow(2 * a[1], -1, P)) % P if a == b else ((b[1] - a[1]) * pow(b[0] - a[0], -1, P)) % P
    x = (l * l - a[0] - b[0]) % P
    return (x, (l * (a[0] - x) - a[1]) % P)
k, r, q = int(sys.argv[1], 16), None, G
while k:
    if k & 1: r = add(r, q)
    q, k = add(q, q), k >> 1
print(f"{r[0]:064x}")
PY
)
# Its own process group, so stopping it stops the test binary cargo starts, not only cargo.
( cd "$ROOT" && MOCK_MEMBER_HEX=$MEMBER MOCK_PORT=19392 MOCK_TRIGGER=$OUT/t76/relay-live exec setsid cargo test -q -p uni-core --test mock_relay -- --ignored --nocapture serve_for_the_garden ) > "$OUT/relay.log" 2>&1 & RELAY_PID=$!
for _ in $(seq 1 600); do grep -q 'serving ws://127.0.0.1:19392' "$OUT/relay.log" && break; sleep 0.5; done
grep -q 'serving ws://' "$OUT/relay.log" || { echo "relay did not start" >&2; cat "$OUT/relay.log" >&2; exit 1; }
step "relay up with five rooms; Garden channel on 127.0.0.1:18306"

export HOME=$FAKE XDG_DATA_HOME=$FAKE/data XDG_CONFIG_HOME=$FAKE/config XDG_CACHE_HOME=$FAKE/cache XDG_STATE_HOME=$FAKE/state
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME"
export UNI_RELAY_URL=ws://127.0.0.1:19392 UNI_NO_KEYRING=1 UNI_NSEC=$NSEC
export UNI_T76_DIR=$OUT/t76 UNI_T76_INIT=$ROOT/scripts/t305/iface-drive.js
export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman WLR_HEADLESS_OUTPUTS=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=wayland
unset WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE XDG_CURRENT_DESKTOP DESKTOP_SESSION
RT=/run/user/$(id -u)
OTA_DIR=$XDG_DATA_HOME/org.unforced.uni/ota

# No real Parachute hub: the vault points at a closed local port.
mkdir -p "$XDG_DATA_HOME/org.unforced.uni"
echo '{"hub":"http://127.0.0.1:9","vault":"uni"}' > "$XDG_DATA_HOME/org.unforced.uni/vault.json"

# What installing Garden writes: the person pinned the agent's public key and granted two capabilities.
mkdir -p "$OTA_DIR"
python3 -I - "$OTA_DIR/interfaces.json" "$(cat "$UNI_IFACE_KEY.pub")" <<'PY'
import json, sys
json.dump([{"id": "garden", "name": "Garden", "channel": "http://127.0.0.1:18306/manifest.json", "pubkey": sys.argv[2],
            "grants": ["rooms.read", "rooms.send"]}], open(sys.argv[1], "w"), indent=2)
PY
step "installed Garden: its agent's key pinned, granted rooms.read and rooms.send"

SEEN=""
launch() { # <n> <done-marker>: run the app until the driver writes the marker, screenshotting on its requests
  local n=$1 marker=$2 before new=""
  before=$(ls "$RT" | grep -E '^wayland-[0-9]+$' || true)
  cage -- "$APP" > "$OUT/launch-$n.log" 2>&1 & local cpid=$!
  for _ in $(seq 1 50); do
    new=$(comm -13 <(echo "$before" | sort) <(ls "$RT" | grep -E '^wayland-[0-9]+$' | sort) | head -1 || true)
    [ -n "$new" ] && break; sleep 0.2
  done
  [ -n "$new" ] || { echo "cage socket not found" >&2; kill $cpid; exit 1; }
  for _ in $(seq 1 1200); do
    for f in "$OUT"/t76/shot-*; do
      [ -e "$f" ] || continue
      local name=${f##*/shot-}
      case " $SEEN " in *" $name "*) continue;; esac
      SEEN="$SEEN $name"
      WAYLAND_DISPLAY=$new grim "$OUT/shots/$name.png" 2>/dev/null && step "screenshot $name"
    done
    { [ -e "$OUT/t76/$marker" ] || [ -e "$OUT/t76/error.txt" ]; } && break
    sleep 0.2
  done
  sleep 1
  kill $cpid 2>/dev/null || true; wait $cpid 2>/dev/null || true
  [ -e "$OUT/t76/error.txt" ] && { step "driver error: $(cat "$OUT/t76/error.txt")"; return 1; }
  [ -e "$OUT/t76/$marker" ] || { step "launch $n timed out"; return 1; }
  step "launch $n done; active interface: $(cat "$OTA_DIR/active" 2>/dev/null)"
}

launch 1 done-1
kill $CHANNEL_PID; wait $CHANNEL_PID 2>/dev/null || true
step "Garden channel stopped"
launch 2 done-2

unset UNI_NSEC
cp "$OUT/t76/drive.log" "$OUT/drive.log"
grep -h 'ota\|interface' "$XDG_STATE_HOME"/org.unforced.uni/uni.log > "$OUT/ota.log" 2>/dev/null || grep -h '\[ota\]' "$OUT"/launch-*.log > "$OUT/ota.log" || true
grep -h '"GET' "$OUT/channel.log" > "$OUT/channel-requests.log" || true
{ echo "garden records:"; ls "$OTA_DIR/iface/garden"; cat "$OTA_DIR/iface/garden/state.json"; echo; } >> "$OUT/steps.log"
# What must hold.
fail=0
need() { grep -q -- "$2" "$1" && step "ok: $3" || { step "FAIL: $3"; fail=1; }; }
need "$OUT/drive.log" 'places: .*Seed Library.*Workshop\|places: .*Workshop.*Seed Library' "Garden drew the relay's five rooms as places"
need "$OUT/drive.log" 'after live letters: .*Night Walks, 1 new letter' "letters arriving live became fireflies at their places"
need "$OUT/drive.log" 'vault_list from Garden: not granted: vault.read (interface garden)' "the shell refused a command Garden wasn't granted"
need "$OUT/drive.log" 'clipboard from Garden: refused' "Garden's window may use no plugins (clipboard refused)"
need "$OUT/drive.log" "Uni's storage seen from Garden: nothing" "Garden's window has its own browser storage"
need "$OUT/drive.log" "after trying to open Uni's page in Garden's window: still Garden" "Garden's window can't load Uni's pages"
need "$OUT/drive.log" 'status: Sent to Seed Library.' "Garden sent a letter through the shell"
need "$OUT/drive.log" 'Uni shows the letter Garden sent' "back in Uni, the same room shows Garden's letter"
need "$OUT/drive.log" 'relaunched with the Garden channel down: 5 places' "with its channel down, Garden still opens from the device"
need "$OUT/ota.log" 'interface garden: first use, fetching its bundle' "Garden was fetched over the air on first use"
need "$OUT/ota.log" 'garden bundle 0.1.0 reported ready; kept' "Garden's trial ended when its page reported ready"
need "$OUT/channel-requests.log" 'garden-0.1.0.tar.gz' "the bundle came from Garden's own channel"
echo "done: $OUT/steps.log"
exit $fail
