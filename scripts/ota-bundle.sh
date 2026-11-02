#!/usr/bin/env bash
# T-305 spike: build the web layer (dist/) as a signed over-the-air bundle, plus the channel's signed, expiring
# manifest.json (scripts/ota-manifest.sh).
#   UNI_OTA_KEY=<tauri signer private key file> scripts/ota-bundle.sh <version> <out-dir>
# The version must be newer than the app it targets (src-tauri/src/ota.rs uses only bundles newer than the built-in
# web layer). The API is SHELL_API from src/ota.ts; a bundle runs only on a shell with the same API.
set -euo pipefail
VERSION=${1:?version}; OUT=${2:?out dir}
: "${UNI_OTA_KEY:?set UNI_OTA_KEY to the signing key file}"
cd "$(dirname "$0")/.."
API="$(sed -n 's/^export const SHELL_API = \([0-9][0-9]*\);$/\1/p' src/ota.ts)"
[[ -n $API ]] || { echo 'ota-bundle: SHELL_API not found in src/ota.ts' >&2; exit 1; }
bash scripts/check-release-dist.sh
printf '{"version":"%s","api":%s}\n' "$VERSION" "$API" > dist/uni-bundle.json
mkdir -p "$OUT"
NAME="web-$VERSION.tar.gz"
# Reproducible: sorted names, fixed times and owners, no gzip timestamp.
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C dist -cf - . | gzip -n -9 > "$OUT/$NAME"
./node_modules/.bin/tauri signer sign -f "$UNI_OTA_KEY" -p "" "$OUT/$NAME" >/dev/null
test -s "$OUT/$NAME.sig"
bash scripts/ota-manifest.sh "$OUT" "$VERSION" "$API" "$NAME"
echo "ota-bundle: $OUT/$NAME ($(stat -c %s "$OUT/$NAME") bytes), API $API"
