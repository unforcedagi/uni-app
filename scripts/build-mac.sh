#!/usr/bin/env bash
# Invoked via SSH by publish.sh after the exact commit is pushed.
set -euo pipefail
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
SHA="${1:?commit required}"
REPO="$HOME/Code/uni-app-journal"
KEY="$HOME/.config/uni/updater/uni.key"
test -r "$KEY" || { echo 'Updater signing key missing on Mac mini' >&2; exit 1; }
git -C "$REPO" fetch origin journal
git -C "$REPO" checkout -f "$SHA"
# uni-core's ../buzz dependency must agree exactly with the Linux builder.
BUZZ_SHA="${2:?buzz commit required}"
git -C "$HOME/Code/buzz" fetch https://github.com/unforcedagi/buzz.git "$BUZZ_SHA"
git -C "$HOME/Code/buzz" checkout -f "$BUZZ_SHA"
cd "$REPO"
pnpm install --frozen-lockfile
export TAURI_SIGNING_PRIVATE_KEY="$(<"$KEY")"
# The key was generated with --ci (no passphrase); set this explicitly so SSH cannot prompt.
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
pnpm tauri build --bundles app
APP="$REPO/target/release/bundle/macos/Uni.app"
test -d "$APP"
# Tauri creates the updater tarball after macOS signing (signingIdentity: '-').
codesign --verify --deep --strict "$APP"
mkdir -p "$HOME/.local/share/uni/mac-build"
ditto -c -k --keepParent "$APP" "$HOME/.local/share/uni/mac-build/Uni-mac-arm64.zip"
cp "$REPO"/target/release/bundle/macos/*.app.tar.gz* "$HOME/.local/share/uni/mac-build/"
