#!/usr/bin/env bash
# T-335 Taste Arcade: copy the games and their engine from the taste-arcade library (MIT) into src/arcade/kit/.
# The copy keeps the library's own layout (kit/engine/src, kit/ui/src), so its relative imports work unchanged.
# Edit the library, not the copy; then run this and commit both sides.
set -euo pipefail
SRC="${TASTE_ARCADE:-$HOME/Code/taste-arcade}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/src/arcade/kit"
rm -rf "$DEST"
mkdir -p "$DEST/engine" "$DEST/ui"
cp -r "$SRC/engine/src" "$DEST/engine/src"
cp -r "$SRC/ui/src" "$DEST/ui/src"
cp "$SRC/LICENSE" "$DEST/LICENSE"
printf 'Vendored from taste-arcade %s (MIT, see LICENSE). Do not edit here: run scripts/sync-arcade.sh.\n' "$(git -C "$SRC" rev-parse --short HEAD)" > "$DEST/VENDORED.md"
