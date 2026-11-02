#!/usr/bin/env bash
# T-305 spike: sign the channel's manifest.json for an archive already in <out-dir> (src-tauri/src/ota.rs `Manifest`).
#   UNI_OTA_KEY=<tauri signer private key> scripts/ota-manifest.sh <out-dir> <version> <api> <archive> [channel]
# The manifest expires (UNI_OTA_TTL seconds, default 7 days), so the publisher re-runs this on a schedule, well inside
# the TTL, whether or not the bundle changed (TUF's timestamp role). A device never takes a manifest older than one it
# already took, so a replayed or held-back channel can serve at most what this key signed inside the last TTL.
set -euo pipefail
OUT=${1:?out dir}; VERSION=${2:?version}; API=${3:?api}; NAME=${4:?archive}; CHANNEL=${5:-uni}
: "${UNI_OTA_KEY:?set UNI_OTA_KEY to the signing key file}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TTL=${UNI_OTA_TTL:-604800}
[[ -s $OUT/$NAME && -s $OUT/$NAME.sig ]] || { echo "ota-manifest: $OUT/$NAME or its .sig missing" >&2; exit 1; }
SIGNED=$(mktemp); trap 'rm -f "$SIGNED" "$SIGNED.sig"' EXIT
python3 -I - "$OUT/$NAME" "$VERSION" "$API" "$NAME" "$CHANNEL" "$TTL" "${UNI_OTA_ISSUED:-}" > "$SIGNED" <<'PY'
import hashlib, json, sys, time
path, version, api, name, channel, ttl, issued = sys.argv[1:]
issued = int(issued) if issued else int(time.time())
m = {"channel": channel, "issued": issued, "expires": issued + int(ttl), "version": version, "api": int(api),
     "archive": name, "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(), "signature": name + ".sig"}
sys.stdout.write(json.dumps(m, separators=(",", ":")))
PY
"$ROOT/node_modules/.bin/tauri" signer sign -f "$UNI_OTA_KEY" -p "" "$SIGNED" >/dev/null
python3 -I -c 'import json,sys; print(json.dumps({"signed": open(sys.argv[1]).read(), "signature": open(sys.argv[2]).read().strip()}))' \
  "$SIGNED" "$SIGNED.sig" > "$OUT/manifest.json.tmp"
mv "$OUT/manifest.json.tmp" "$OUT/manifest.json"
