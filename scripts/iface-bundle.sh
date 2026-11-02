#!/usr/bin/env bash
# T-305 interface platform spike: build an installed interface (interfaces/<id>/) as a signed over-the-air bundle with
# its channel's signed, expiring manifest. The key is the interface's own agent's key, not Uni's; the person pins its
# public half when installing the interface.
#   UNI_OTA_KEY=<the agent's tauri signer key> scripts/iface-bundle.sh <id> <version> <out-dir>
set -euo pipefail
ID=${1:?interface id}; VERSION=${2:?version}; OUT=${3:?out dir}
: "${UNI_OTA_KEY:?set UNI_OTA_KEY to the signing key file of the interface agent}"
cd "$(dirname "$0")/.."
[[ -f interfaces/$ID/interface.json ]] || { echo "iface-bundle: no interfaces/$ID/interface.json" >&2; exit 1; }
API="$(sed -n 's/^export const SHELL_API = \([0-9][0-9]*\);$/\1/p' interfaces/sdk/shell.ts)"
[[ -n $API ]] || { echo 'iface-bundle: SHELL_API not found in interfaces/sdk/shell.ts' >&2; exit 1; }
DIST=dist-$ID
node node_modules/vite/bin/vite.js build --config "interfaces/$ID/vite.config.ts" --logLevel warn
python3 -I - "interfaces/$ID/interface.json" "$VERSION" "$API" > "$DIST/uni-bundle.json" <<'PY'
import json, sys
spec, version, api = sys.argv[1:]
print(json.dumps({"version": version, "api": int(api), "requires": json.load(open(spec))["requires"]}))
PY
mkdir -p "$OUT"
NAME="$ID-$VERSION.tar.gz"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$DIST" -cf - . | gzip -n -9 > "$OUT/$NAME"
./node_modules/.bin/tauri signer sign -f "$UNI_OTA_KEY" -p "" "$OUT/$NAME" >/dev/null
bash scripts/ota-manifest.sh "$OUT" "$VERSION" "$API" "$NAME" "$ID"
echo "iface-bundle: $OUT/$NAME ($(stat -c %s "$OUT/$NAME") bytes), API $API, channel $ID"
