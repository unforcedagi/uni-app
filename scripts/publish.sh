#!/usr/bin/env bash
# Build the checked-out commit (must be on origin/main) and publish it as the next
# GitHub release. Run on uni-1 only, normally via scripts/watch-main.sh.
main() {
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
# systemd user units do not set TMPDIR.
export TMPDIR="${TMPDIR:-$HOME/.cache/uni-release}"
mkdir -p "$TMPDIR"
cd "$(dirname "$0")/.."
mkdir -p "$HOME/.config/uni/updater"
exec 9>"$HOME/.config/uni/updater/publish.lock"
flock -n 9 || { echo 'A Uni release is already running' >&2; exit 1; }
# Tauri regenerates capability schemas during builds; they are not release inputs.
cleanup_generated() {
  git restore -- src-tauri/gen/schemas
  git clean -fq -- src-tauri/gen/schemas
  rm -rf src-tauri/gen/android/buildSrc/.kotlin
}
trap cleanup_generated EXIT
REPO_SLUG="unforcedagi/uni-app"
MAC="uni@100.126.18.24"
# Legacy bridge: 0.1.2-0.1.5 installs poll the tailnet; keep those pointers current.
SERVE="$HOME/.local/share/uni/apk"
LEGACY_BASE="https://uni-1.taildf9ce2.ts.net:8443"
[[ -z $(git status --porcelain) ]] || { echo 'Commit/clean changes before publishing' >&2; exit 1; }
git fetch --quiet origin main --tags
SHA="$(git rev-parse HEAD)"
git merge-base --is-ancestor "$SHA" origin/main || { echo 'HEAD is not on origin/main' >&2; exit 1; }
if git tag --points-at "$SHA" | grep -q '^uni-v'; then echo "$SHA already released" >&2; exit 0; fi
[[ $(git -C ../buzz rev-parse HEAD) == 5669fdc* ]] || { echo 'Buzz dependency moved: validate Mac sync before publishing' >&2; exit 1; }
BUZZ_SHA="$(git -C ../buzz rev-parse HEAD)"
read -r VERSION CODE < <(python3 scripts/next-version.py)
TAG="uni-v$VERSION"
echo "Releasing $TAG (Android $CODE) from $SHA" >&2
pnpm install --frozen-lockfile
python3 scripts/check-case-collisions.py
python3 scripts/test_case_collisions.py
pnpm typecheck
pnpm test
cargo test --workspace
cleanup_generated
STAGE="$TMPDIR/uni-release-$VERSION"
rm -rf "$STAGE"; mkdir -p "$STAGE"
# The Mac's private signing key lives outside the repo; install from uni-1 each run.
ssh "$MAC" 'mkdir -p ~/.config/uni/updater ~/.local/share/uni && chmod 700 ~/.config/uni/updater'
scp -q "$HOME/.config/uni/updater/uni.key" "$MAC:.config/uni/updater/uni.key"
scp -q scripts/build-mac.sh "$MAC:.local/share/uni/build-mac.sh"
ssh "$MAC" 'chmod 600 ~/.config/uni/updater/uni.key'
( ssh "$MAC" "bash ~/.local/share/uni/build-mac.sh '$SHA' '$BUZZ_SHA' '$VERSION'" >"$STAGE/mac.log" 2>&1 ) & MAC_PID=$!
(
  source "$HOME/.config/uni/android.env"
  export PATH="$HOME/.cargo/bin:$PATH"
  pnpm tauri android build --debug --apk --target aarch64 \
    --config "{\"version\":\"$VERSION\",\"bundle\":{\"android\":{\"versionCode\":$CODE}}}" >"$STAGE/android.log" 2>&1
) & ANDROID_PID=$!
MAC_RESULT=0; ANDROID_RESULT=0
wait "$MAC_PID" || MAC_RESULT=$?
wait "$ANDROID_PID" || ANDROID_RESULT=$?
if (( MAC_RESULT || ANDROID_RESULT )); then
  echo "Build failed: mac=$MAC_RESULT android=$ANDROID_RESULT. Logs: $STAGE/{mac,android}.log" >&2
  tail -25 "$STAGE/mac.log" >&2
  tail -25 "$STAGE/android.log" >&2
  exit 1
fi
for f in Uni-mac-arm64.zip Uni.app.tar.gz Uni.app.tar.gz.sig; do scp -q "$MAC:.local/share/uni/mac-build/$f" "$STAGE/"; done
cp "$(pwd)/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk" "$STAGE/uni.apk"
BADGING="$("$HOME/Android/Sdk/build-tools/35.0.0/aapt" dump badging "$STAGE/uni.apk" | head -1)"
[[ $BADGING == *"versionCode='$CODE'"*"versionName='$VERSION'"* ]] || { echo "APK not stamped $VERSION/$CODE: $BADGING" >&2; exit 1; }
python3 scripts/write-release-manifest.py "$STAGE" "$VERSION" "$SHA" "$REPO_SLUG"
# The tag is created last, so a failed build leaves nothing behind and the next tick retries.
gh release create "$TAG" --repo "$REPO_SLUG" --target "$SHA" --latest \
  --title "Uni $VERSION" \
  --notes "Built from \`${SHA:0:12}\` on main. Mac: download Uni-mac-arm64.zip for a first install; installed apps update themselves. Android: uni.apk (Android versionCode $CODE)." \
  "$STAGE/Uni-mac-arm64.zip" "$STAGE/Uni.app.tar.gz" "$STAGE/Uni.app.tar.gz.sig" \
  "$STAGE/uni.apk" "$STAGE/latest.json" "$STAGE/android.json"
git fetch --quiet origin --tags
LIVE="$(curl -fsSL "https://github.com/$REPO_SLUG/releases/latest/download/latest.json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["version"])')"
[[ $LIVE == "$VERSION" ]] || { echo "GitHub latest is $LIVE, expected $VERSION" >&2; exit 1; }
echo "GitHub releases/latest now serves $VERSION" >&2
# Legacy tailnet bridge (atomic swaps). Remove once no device runs <= 0.1.5.
mkdir -p "$SERVE/mac" "$SERVE/android"
cp "$STAGE/uni.apk" "$SERVE/uni.apk.tmp" && mv "$SERVE/uni.apk.tmp" "$SERVE/uni.apk"
cp "$STAGE/latest.json" "$SERVE/mac/latest.json.tmp" && mv "$SERVE/mac/latest.json.tmp" "$SERVE/mac/latest.json"
printf '{"version": "%s", "url": "%s/uni.apk"}\n' "$VERSION" "$LEGACY_BASE" >"$SERVE/android/latest.json.tmp"
mv "$SERVE/android/latest.json.tmp" "$SERVE/android/latest.json"
# Zero-touch install on each paired device (Daylight, Pixel 7) when wireless ADB is up
# and Uni is not in the foreground. Never uninstalls: that would lose the device identity.
while read -r NAME SERIAL; do
  if [[ $SERIAL == offline ]]; then echo "$NAME: ADB offline; in-app banner will offer the APK"; continue; fi
  TOP="$(timeout 10 adb -s "$SERIAL" shell dumpsys activity activities | grep topResumedActivity || true)"
  if [[ "$TOP" == *org.unforced.uni* ]]; then echo "$NAME: Uni in foreground; skipped, banner will offer the APK"; continue; fi
  if timeout 900 adb -s "$SERIAL" install -r "$STAGE/uni.apk" </dev/null; then echo "$NAME: upgraded to $VERSION"
  else echo "$NAME: install failed; never uninstall, inspect signature" >&2; fi
done < <(python3 scripts/connect-devices.py || true)
echo "Published $TAG ($SHA): https://github.com/$REPO_SLUG/releases/tag/$TAG"
}
main "$@"
