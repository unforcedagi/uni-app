#!/usr/bin/env bash
# T-335 OTA: build the screens (dist/) as an over-the-air bundle archive: web-<version>.tar.gz in <out-dir>.
#   scripts/ota-bundle.sh <version> <out-dir>
# Nothing is signed here: the sealed broker signs the bundle's channel manifest (web.json) after the owner's tap
# (`sealed release bundle`, uni-ops sealed/bundle.py). The API is SHELL_API from src/ota.ts; a bundle runs only on a
# shell with the same API, and only while it is newer than the screens built into the app.
set -euo pipefail
VERSION=${1:?version}; OUT=${2:?out dir}
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "ota-bundle: version is X.Y.Z" >&2; exit 1; }
cd "$(dirname "$0")/.."
API="$(sed -n 's/^export const SHELL_API = \([0-9][0-9]*\);$/\1/p' src/ota.ts)"
[[ -n $API ]] || { echo 'ota-bundle: SHELL_API not found in src/ota.ts' >&2; exit 1; }
bash scripts/check-release-dist.sh >&2
printf '{"version":"%s","api":%s}\n' "$VERSION" "$API" > dist/uni-bundle.json
mkdir -p "$OUT"
NAME="web-$VERSION.tar.gz"
# Reproducible: sorted names, fixed times and owners, no gzip timestamp.
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C dist -cf - . | gzip -n -9 > "$OUT/$NAME.tmp"
mv "$OUT/$NAME.tmp" "$OUT/$NAME"
echo "ota-bundle: $OUT/$NAME ($(stat -c %s "$OUT/$NAME") bytes), API $API" >&2
echo "$API $OUT/$NAME"
