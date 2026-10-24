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
LOCK="$HOME/.config/uni/updater/publish.lock"
# watch-main already holds fd 9 before checkout. Inherit that same lock across exec;
# direct invocations open it here instead. flocking a second FD would conflict.
if [[ $(readlink "/proc/$$/fd/9" 2>/dev/null || :) != "$LOCK" ]]; then
  exec 9>"$LOCK"
fi
flock -n 9 || { echo 'A Uni release is already running' >&2; exit 1; }
# Tauri regenerates capability schemas during builds; they are not release inputs.
cleanup_generated() {
  git restore -- src-tauri/gen/schemas
  git clean -fq -- src-tauri/gen/schemas
  rm -rf src-tauri/gen/android/buildSrc/.kotlin
}
trap cleanup_generated EXIT
REPO_SLUG="unforcedagi/uni-app"
# The tailnet download page (index.html here, shared by `tailscale serve`) offers the newest APK.
SERVE="$HOME/.local/share/uni/apk"
source scripts/release-check.sh
[[ -z $(git status --porcelain) ]] || { echo 'Commit/clean changes before publishing' >&2; exit 1; }
git fetch --quiet origin main --tags
SHA="$(git rev-parse HEAD)"
git merge-base --is-ancestor "$SHA" origin/main || { echo 'HEAD is not on origin/main' >&2; exit 1; }
if git tag --points-at "$SHA" | grep -q '^uni-v'; then echo "$SHA already released" >&2; exit 0; fi
[[ $(git -C ../buzz rev-parse HEAD) == 5669fdc* ]] || { echo 'Buzz dependency moved: update the pinned hosted build checkout before publishing' >&2; exit 1; }
read -r VERSION CODE < <(python3 scripts/next-version.py)
TAG="uni-v$VERSION"
echo "Releasing $TAG (Android $CODE) from $SHA" >&2
pnpm install --frozen-lockfile
python3 scripts/check-case-collisions.py
python3 scripts/test_case_collisions.py
python3 scripts/test_check_public.py
python3 scripts/check-public.py
python3 scripts/test_release_check.py
pnpm typecheck
pnpm test
cargo test --workspace
cleanup_generated
STAGE="$TMPDIR/uni-release-$VERSION"
rm -rf "$STAGE"; mkdir -p "$STAGE"
# Build Android locally while the GitHub-hosted Mac runner builds the exact main commit.
( bash scripts/build-mac-hosted.sh "$SHA" "$VERSION" "$STAGE" >"$STAGE/mac.log" 2>&1 ) & MAC_PID=$!
# T-207: Gradle updates the APK in place and can append a changed native library, leaving the old copy as dead space
# (0.1.62 was 683 MB, 337 MB of it unused). A fresh APK every time.
rm -rf src-tauri/gen/android/app/build/outputs/apk
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
for f in Uni-mac-arm64.zip Uni.app.tar.gz Uni.app.tar.gz.sig; do test -s "$STAGE/$f"; done
cp "$(pwd)/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk" "$STAGE/uni.apk"
BADGING="$("$HOME/Android/Sdk/build-tools/35.0.0/aapt" dump badging "$STAGE/uni.apk" | head -1)"
[[ $BADGING == *"versionCode='$CODE'"*"versionName='$VERSION'"* ]] || { echo "APK not stamped $VERSION/$CODE: $BADGING" >&2; exit 1; }
# Installed apps trust only the original signing key (~/.config/.android/debug.keystore, set via ANDROID_USER_HOME
# in android.env). An APK signed by any other key fails on every device with "conflicts with another package"
# (0.1.47, 10-16). Refuse to publish it.
APK_SIGNER_SHA256="6e9f4f94ffbb86604e02ca97a1b7b764ae0cc341430e92b4c7a4a4f22246b63d"
SIGNERS="$("$HOME/Android/Sdk/build-tools/36.1.0/apksigner" verify --print-certs "$STAGE/uni.apk" | sed -n 's/^Signer #[0-9]* certificate SHA-256 digest: //p')"
[[ $SIGNERS == "$APK_SIGNER_SHA256" ]] || { echo "APK signed by the wrong key: '$SIGNERS' (expected $APK_SIGNER_SHA256)" >&2; exit 1; }
python3 scripts/write-release-manifest.py "$STAGE" "$VERSION" "$SHA" "$REPO_SLUG"
# The tag is created last, so a failed build leaves nothing behind and the next tick retries.
gh release create "$TAG" --repo "$REPO_SLUG" --target "$SHA" --latest \
  --title "Uni $VERSION" \
  --notes "Built from \`${SHA:0:12}\` on main. Mac: download Uni-mac-arm64.zip for a first install; installed apps update themselves. Android: uni.apk (Android versionCode $CODE)." \
  "$STAGE/Uni-mac-arm64.zip" "$STAGE/Uni.app.tar.gz" "$STAGE/Uni.app.tar.gz.sig" \
  "$STAGE/uni.apk" "$STAGE/latest.json" "$STAGE/android.json"
git fetch --quiet origin --tags
# Read the release by its tag (GitHub caches releases/latest). A release that never serves its manifest is broken: stop.
retry 6 5 release_serves "$REPO_SLUG" "$TAG" "$VERSION" || { echo "Release $TAG does not serve latest.json for $VERSION" >&2; exit 1; }
# The tag exists now, so a later tick will not come back for the device installs below: a slow "latest" only warns.
if retry 6 5 release_is_latest "$REPO_SLUG" "$TAG"; then echo "GitHub names $TAG the latest release" >&2
else echo "Warning: GitHub does not name $TAG the latest release yet; installed apps update once it does" >&2; fi
# The tailnet download page (atomic swaps). It is a convenience: a failed copy never fails a published release.
{ mkdir -p "$SERVE/android" &&
  cp "$STAGE/uni.apk" "$SERVE/uni.apk.tmp" && mv "$SERVE/uni.apk.tmp" "$SERVE/uni.apk" &&
  printf '{"version": "%s", "url": "uni.apk"}\n' "$VERSION" >"$SERVE/android/latest.json.tmp" &&
  mv "$SERVE/android/latest.json.tmp" "$SERVE/android/latest.json"; } || echo "Warning: tailnet download page not updated ($SERVE)" >&2
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
