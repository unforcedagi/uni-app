#!/usr/bin/env bash
# T-335 OTA emulator proof, step 1: the bundles, signed by a throwaway sealed broker (uni-ops tests/ota_e2e_sign.py) with
# the production commands, approved on a simulated phone. The app under test is built at <apk-version> with that
# broker's public key (UNI_OTA_PUBKEY) and pointed at a local channel; see ota-e2e-android.sh.
#   scripts/t335/ota-e2e-bundles.sh <out-dir> [uni-ops checkout]
# Bundles (the APK's built-in screens are 0.4.0):
#   n1 0.4.1         the screens as they are                       -> arrives over the air, no APK
#   n2 0.4.2         a visible change to the sign-in screen        -> arrives on resume
#   tampered 0.4.3   signed, then one byte of the archive flipped  -> refused
#   expired 0.4.4    valid one day; the phone's clock is moved on  -> refused
#   api2 0.4.5       signed for shell API 2                        -> refused: needs a newer app
#   neverready 0.4.6 signed, its page never starts                 -> dropped after three starts, back to 0.4.2
set -euo pipefail
OUT=${1:?out dir}; OPS=${2:-$HOME/Code/uni-ops}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
rm -rf "$OUT"; mkdir -p "$OUT/archives"
cd "$ROOT"
A=$OUT/archives
build() { bash scripts/ota-bundle.sh "$1" "$A/$2" >/dev/null; }
pack() { # <dir> <version> <api> <name>
  echo "{\"version\":\"$2\",\"api\":$3}" > "$1/uni-bundle.json"; mkdir -p "$A/$4"
  tar --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$1" -cf - . | gzip -n -9 > "$A/$4/web-$2.tar.gz"
}
build 0.4.1 n1
TITLE='Sign in to Uni from a device you already use'
cp src/Pairing.tsx "$OUT/Pairing.tsx.orig"
trap 'cp "$OUT/Pairing.tsx.orig" "$ROOT/src/Pairing.tsx"' EXIT
sed -i "s|$TITLE|New screens arrived over the air|" src/Pairing.tsx
build 0.4.2 n2
cp "$OUT/Pairing.tsx.orig" src/Pairing.tsx
D=$(mktemp -d); trap 'cp "$OUT/Pairing.tsx.orig" "$ROOT/src/Pairing.tsx"; rm -rf "$D"' EXIT
tar -xzf "$A/n1/web-0.4.1.tar.gz" -C "$D"
pack "$D" 0.4.3 1 tampered
pack "$D" 0.4.4 1 expired
pack "$D" 0.4.5 2 api2
rm -rf "$D"/*; echo '<!doctype html><title>Uni</title><p>a bundle that never starts</p>' > "$D/index.html"
pack "$D" 0.4.6 1 neverready
( cd "$OPS" && PYTHONDONTWRITEBYTECODE=1 uv run -q --python 3.13 --with pytest --with coincurve --with cryptography \
    --with websockets python tests/ota_e2e_sign.py "$OUT/signed" \
    "n1:0.4.1:1:$A/n1/web-0.4.1.tar.gz:14" "n2:0.4.2:1:$A/n2/web-0.4.2.tar.gz:14" \
    "tampered:0.4.3:1:$A/tampered/web-0.4.3.tar.gz:14:tamper" "expired:0.4.4:1:$A/expired/web-0.4.4.tar.gz:1" \
    "api2:0.4.5:2:$A/api2/web-0.4.5.tar.gz:14" "neverready:0.4.6:1:$A/neverready/web-0.4.6.tar.gz:14" )
PUB=$(cat "$OUT/signed/pubkey")
# The independent check publish.sh runs, on what the real broker code signed.
for n in n1 n2 tampered expired api2 neverready; do
  printf '%s: ' "$n"; node --experimental-strip-types scripts/ota-verify.ts "$OUT/signed/$n/web.json" "$OUT/signed/$n"/web-*.tar.gz --pubkey "$PUB" 2>&1 || true
done
echo "pubkey $PUB"
