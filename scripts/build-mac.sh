#!/usr/bin/env bash
# Invoked via SSH by publish.sh: build one exact commit, stamped with the release version.
set -euo pipefail
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
SHA="${1:?commit required}"
BUZZ_SHA="${2:?buzz commit required}"
VERSION="${3:?version required}"
REPO="$HOME/Code/uni-app-journal"
KEY="$HOME/.config/uni/updater/uni.key"
test -r "$KEY" || { echo 'Updater signing key missing on Mac mini' >&2; exit 1; }
git -C "$REPO" fetch --quiet origin main
git -C "$REPO" checkout -f "$SHA"
# uni-core's ../buzz dependency must agree exactly with the Linux builder.
git -C "$HOME/Code/buzz" fetch https://github.com/unforcedagi/buzz.git "$BUZZ_SHA"
git -C "$HOME/Code/buzz" checkout -f "$BUZZ_SHA"
cd "$REPO"
pnpm install --frozen-lockfile
export TAURI_SIGNING_PRIVATE_KEY="$(<"$KEY")"
# The key was generated with --ci (no passphrase); set this explicitly so SSH cannot prompt.
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
pnpm tauri build --bundles app --config "{\"version\":\"$VERSION\"}"
APP="$REPO/target/release/bundle/macos/Uni.app"
test -d "$APP"
[[ $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist") == "$VERSION" ]]
codesign --verify --deep --strict "$APP"
OUT="$HOME/.local/share/uni/mac-build"
rm -rf "$OUT"; mkdir -p "$OUT"
ditto -c -k --keepParent "$APP" "$OUT/Uni-mac-arm64.zip"
cp "$REPO"/target/release/bundle/macos/Uni.app.tar.gz "$REPO"/target/release/bundle/macos/Uni.app.tar.gz.sig "$OUT/"
