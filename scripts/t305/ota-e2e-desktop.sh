#!/usr/bin/env bash
# T-305 spike, end to end on a real Linux build: the shell serves bundle N, bundle N+1 is published, the app picks it
# up without a new binary; a tampered bundle, a bundle for another shell API and a bundle that never boots are refused.
# Headless (cage), throwaway HOME, a local channel on 127.0.0.1:18305. Build first, from the repo root:
#   UNI_OTA_CHANNEL=http://127.0.0.1:18305/manifest.json ./node_modules/.bin/tauri build --debug --no-bundle \
#     --config '{"version":"0.1.84"}'
# usage: UNI_OTA_KEY=<tauri signer key> scripts/t305/ota-e2e-desktop.sh <out-dir>
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:?out dir}; rm -rf "$OUT"; mkdir -p "$OUT/channel" "$OUT/shots" "$OUT/bundles"
: "${UNI_OTA_KEY:?}"
APP=$ROOT/target/debug/uni-app-tauri
PIDS=()
FAKE=$(mktemp -d)
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$FAKE"; }
trap cleanup EXIT
SIGN() { "$ROOT/node_modules/.bin/tauri" signer sign -f "$UNI_OTA_KEY" -p "" "$1" >/dev/null; }

# Bundles. N and N+1 are the real web layer (scripts/ota-bundle.sh); the bad ones are built by hand from N's dist.
UNI_OTA_KEY=$UNI_OTA_KEY bash "$ROOT/scripts/ota-bundle.sh" 0.1.85 "$OUT/bundles/n" >/dev/null
UNI_OTA_KEY=$UNI_OTA_KEY bash "$ROOT/scripts/ota-bundle.sh" 0.1.86 "$OUT/bundles/n1" >/dev/null
pack() { # <dir> <version> <out-dir>: tar+sign a prepared dist dir, write a manifest
  mkdir -p "$3"; local name="web-$2.tar.gz"
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$1" -cf - . | gzip -n -9 > "$3/$name"
  SIGN "$3/$name"
  printf '{"version":"%s","api":%s,"archive":"%s","signature":"%s.sig"}\n' "$2" "$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["api"])' "$1/uni-bundle.json")" "$name" "$name" > "$3/manifest.json"
}
# 0.1.87: valid, then one byte flipped after signing.
D=$(mktemp -d); tar -xzf "$OUT/bundles/n/web-0.1.85.tar.gz" -C "$D"; echo '{"version":"0.1.87","api":1}' > "$D/uni-bundle.json"
pack "$D" 0.1.87 "$OUT/bundles/tampered"
python3 -I -c 'import sys; p=sys.argv[1]; b=bytearray(open(p,"rb").read()); b[len(b)//2]^=1; open(p,"wb").write(b)' "$OUT/bundles/tampered/web-0.1.87.tar.gz"
# 0.1.88: signed, but built for shell API 2.
echo '{"version":"0.1.88","api":2}' > "$D/uni-bundle.json"; pack "$D" 0.1.88 "$OUT/bundles/api2"
# 0.1.89: signed, API 1, but its page never boots (no script), so it never reports ready.
B=$(mktemp -d); echo '<!doctype html><title>Uni</title><p>a bundle that never boots</p>' > "$B/index.html"
echo '{"version":"0.1.89","api":1}' > "$B/uni-bundle.json"; pack "$B" 0.1.89 "$OUT/bundles/neverready"
# 0.1.90: signed, says API 1, but its code was built for API 2: the shell serves it, its own boot check refuses.
cp "$ROOT/src/ota.ts" "$OUT/ota.ts.orig"
sed -i 's/^export const SHELL_API = 1;$/export const SHELL_API = 2;/' "$ROOT/src/ota.ts"
( cd "$ROOT" && bash scripts/check-release-dist.sh >/dev/null ); cp "$OUT/ota.ts.orig" "$ROOT/src/ota.ts"
grep -q 'shell API 1\|ota_reject' -r "$ROOT/dist/assets" || true
rm -rf "$D"; mkdir -p "$D"; cp -r "$ROOT/dist/." "$D/"; echo '{"version":"0.1.90","api":1}' > "$D/uni-bundle.json"
pack "$D" 0.1.90 "$OUT/bundles/handshake"
rm -rf "$D" "$B"

publish() { rm -f "$OUT/channel/"*; cp "$OUT/bundles/$1/"* "$OUT/channel/"; echo "published $1: $(cat "$OUT/channel/manifest.json")" | tee -a "$OUT/steps.log"; }
python3 -I -m http.server 18305 --bind 127.0.0.1 -d "$OUT/channel" > "$OUT/channel.log" 2>&1 & PIDS+=($!)

export HOME=$FAKE XDG_DATA_HOME=$FAKE/data XDG_CONFIG_HOME=$FAKE/config XDG_CACHE_HOME=$FAKE/cache XDG_STATE_HOME=$FAKE/state
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME"
export UNI_RELAY_URL=ws://127.0.0.1:9 UNI_NO_KEYRING=1
export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman WLR_HEADLESS_OUTPUTS=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=wayland
unset WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE XDG_CURRENT_DESKTOP DESKTOP_SESSION
RT=/run/user/$(id -u)
OTA_DIR=$XDG_DATA_HOME/org.unforced.uni/ota

launch() { # <n> <label>: run the app ~14 s, screenshot the window, record what it served
  local n=$1 label=$2 before new=""
  before=$(ls "$RT" | grep -E '^wayland-[0-9]+$' || true)
  cage -- "$APP" > "$OUT/launch-$n.log" 2>&1 & local cpid=$!
  for _ in $(seq 1 50); do
    new=$(comm -13 <(echo "$before" | sort) <(ls "$RT" | grep -E '^wayland-[0-9]+$' | sort) | head -1 || true)
    [ -n "$new" ] && break; sleep 0.2
  done
  [ -n "$new" ] || { echo "cage socket not found" >&2; kill $cpid; exit 1; }
  sleep 14
  WAYLAND_DISPLAY=$new grim "$OUT/shots/$n-$label.png" 2>/dev/null || true
  kill $cpid 2>/dev/null || true; wait $cpid 2>/dev/null || true
  local served
  served=$(grep -h '\[ota\]\|ota:' "$OUT/launch-$n.log" "$XDG_STATE_HOME"/org.unforced.uni/uni.log 2>/dev/null | grep -oE 'serving (bundle [0-9.]+|the built-in web layer [0-9.]+)' | tail -1 || true)
  echo "launch $n ($label): $served; state $(cat "$OTA_DIR/state.json" 2>/dev/null); staged $(ls "$OTA_DIR" 2>/dev/null | grep -c '^next.tar.gz$')" | tee -a "$OUT/steps.log"
}

publish n;          launch 1 builtin-downloads-N
launch 2 serves-N
publish n1;         launch 3 serves-N-downloads-N1
launch 4 serves-N1
publish tampered;   launch 5 tampered-refused
publish api2;       launch 6 api2-needs-newer-app
launch 7 still-N1
publish neverready; launch 8 downloads-neverready
launch 9 neverready-trial-1
launch 10 neverready-trial-2
launch 11 neverready-dropped
publish handshake;  launch 12 downloads-handshake
launch 13 handshake-refused-by-bundle
launch 14 after-handshake
grep -h 'ota' "$XDG_STATE_HOME"/org.unforced.uni/uni.log > "$OUT/ota.log" 2>/dev/null || grep -h '\[ota\]' "$OUT"/launch-*.log > "$OUT/ota.log" || true
grep -h '"GET' "$OUT/channel.log" > "$OUT/channel-requests.log" || true
echo "done: $OUT/steps.log"
