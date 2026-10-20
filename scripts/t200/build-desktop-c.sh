#!/usr/bin/env bash
# T-200 C: the Linux debug build for scripts/t200/desktop-c.sh. The note-window capability is copied in for this build only, so
# ordinary builds never grant window creation; it is removed (and the generated schema restored) when the build ends.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CAP=$ROOT/src-tauri/capabilities/t200-note-window.json
cleanup() { rm -f "$CAP"; git -C "$ROOT" checkout -- src-tauri/gen/schemas/capabilities.json 2>/dev/null || true; }
trap cleanup EXIT
cp "$ROOT/scripts/t200/t200-note-window.json" "$CAP"
sed -i 's|"../../src-tauri/gen/schemas/desktop-schema.json"|"../gen/schemas/desktop-schema.json"|' "$CAP"
cd "$ROOT"
UNI_T76=1 VITE_T200_FIXTURE=1 VITE_T200_MODE=c VITE_T200_DRIVE=1 node node_modules/vite/bin/vite.js build
npx tauri build --debug --no-bundle --config '{"build":{"beforeBuildCommand":""}}'
