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
# T-335: "<sha> <version> <time>" of the commit whose signing card was asked and not (yet) approved; see the sign step.
SIGN_ASKED="$HOME/.config/uni/updater/sign-asked"
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
# T-335: set once the owner approved and the APK is signed by the right key, cleared once the tag exists.
SIGNED_NOT_PUBLISHED=0
on_exit() {
  if ((SIGNED_NOT_PUBLISHED)); then
    # gh release create can fail part-way, after the tag exists.
    local tags state="may be partly published: check the release page"
    if tags="$(timeout 20 git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null)" && [[ -z $tags ]]; then
      state="was not published"
    fi
    echo "Android signing was approved and the APK signed, but $VERSION $state; $SHA is not asked again until a new main commit or UNI_RELEASE_ASK_AGAIN=1" >&2
  fi
  cleanup_generated
}
trap on_exit EXIT
REPO_SLUG="unforcedagi/uni-app"
# T-305: the largest APK this publishes. The release build is about 24 MB; a debug or unstripped one is far over.
APK_MAX_BYTES=$((60 * 1024 * 1024))
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
python3 scripts/test_release_sign.py
pnpm typecheck
pnpm test
cargo test --workspace
cleanup_generated
STAGE="$TMPDIR/uni-release-$VERSION"
rm -rf "$STAGE"; mkdir -p "$STAGE"
# Build Android locally while the GitHub-hosted Mac runner builds the exact main commit.
( bash scripts/build-mac-hosted.sh "$SHA" "$VERSION" "$STAGE" >"$STAGE/mac.log" 2>&1 ) & MAC_PID=$!
# Android: scripts/android-release-build.sh (release build, size flags, fresh APK; T-207, T-305), unsigned (T-335).
( UNI_ANDROID_UNSIGNED=1 bash scripts/android-release-build.sh "$VERSION" "$CODE" >"$STAGE/android.log" 2>&1 ) & ANDROID_PID=$!
MAC_RESULT=0; ANDROID_RESULT=0
wait "$MAC_PID" || MAC_RESULT=$?
wait "$ANDROID_PID" || ANDROID_RESULT=$?
if (( MAC_RESULT || ANDROID_RESULT )); then
  echo "Build failed: mac=$MAC_RESULT android=$ANDROID_RESULT. Logs: $STAGE/{mac,android}.log" >&2
  tail -25 "$STAGE/mac.log" >&2
  tail -25 "$STAGE/android.log" >&2
  exit 1
fi
# The Mac updater signature (Uni.app.tar.gz.sig) is not yet behind the owner's tap: build-mac-hosted.sh still signs it.
for f in Uni-mac-arm64.zip Uni.app.tar.gz Uni.app.tar.gz.sig; do test -s "$STAGE/$f"; done
cp "$(pwd)/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk" "$STAGE/uni-unsigned.apk"
# T-305: every update is a full download over a phone's connection. A debug or unstripped build is ten times this.
APK_BYTES="$(stat -c %s "$STAGE/uni-unsigned.apk")"
(( APK_BYTES <= APK_MAX_BYTES )) || { echo "APK is $APK_BYTES bytes, over the $APK_MAX_BYTES limit: a debug or unstripped build?" >&2; exit 1; }
BADGING="$("$HOME/Android/Sdk/build-tools/35.0.0/aapt" dump badging "$STAGE/uni-unsigned.apk" | sed -n 1p)"
[[ $BADGING == *"versionCode='$CODE'"*"versionName='$VERSION'"* ]] || { echo "APK not stamped $VERSION/$CODE: $BADGING" >&2; exit 1; }
# T-335: the signing key lives in the sealed broker, which signs only after the owner approves a card on his phone
# ("Sign Uni X.Y.Z for Android", bound to this APK's sha256, the version, the code and the commit). Both builds are
# done first, so an approval is never spent on a half release. Before asking, $SIGN_ASKED records this commit:
# whatever happens next (declined, expired, broker down, killed mid-wait), watch-main.sh then skips the commit instead
# of building and asking again every tick. Only the release's tag existing (gh release create, below) clears it.
# UNI_SEALED_CMD overrides the broker command (tests point it at a fake).
read -ra SEALED <<<"${UNI_SEALED_CMD:-$HOME/REPOS/hermes-agent/.venv/bin/python -I $HOME/Code/uni-ops/sealed/cli.py --home $HOME/.config/uni-sealed}"
printf '%s %s %s\n' "$SHA" "$VERSION" "$(date -Is)" >"$SIGN_ASKED"
rm -f "$STAGE/uni.apk"
SIGN_RESULT=0
# The broker prints "asked: request …" on stdout once its card is posted (kept in sign.out), and why it stopped on
# stderr (kept in sign.err, shown after it exits). The failure line says only what those show.
"${SEALED[@]}" release sign --apk "$STAGE/uni-unsigned.apk" --version "$VERSION" --code "$CODE" --commit "$SHA" \
  --out "$STAGE/uni.apk" --purpose "Publish Uni $VERSION to every device (Android $CODE, main ${SHA:0:12})" --wait \
  2>"$STAGE/sign.err" | tee "$STAGE/sign.out" || SIGN_RESULT=$?
cat "$STAGE/sign.err" >&2
if (( SIGN_RESULT )) || [[ ! -s $STAGE/uni.apk ]]; then
  CARD='no card was posted'; grep -q '^asked: request ' "$STAGE/sign.out" && CARD='a card was posted'
  SEALED_ERROR="$(grep -v '^[[:space:]]*$' "$STAGE/sign.err" | tail -n 1 | tr -d '\r' | cut -c1-200 || :)"
  echo "Android signing did not complete (sealed exit $SIGN_RESULT; $CARD): ${SEALED_ERROR:-no error from sealed}. Nothing published; $SHA is not asked again until a new main commit or UNI_RELEASE_ASK_AGAIN=1" >&2
  exit 1
fi
# Installed apps trust only the original signing key (once ~/.config/.android/debug.keystore; T-335 moves it into the
# sealed broker). An APK signed by any other key fails on every device with "conflicts with another package"
# (0.1.47, 10-16). Refuse to publish it.
APK_SIGNER_SHA256="6e9f4f94ffbb86604e02ca97a1b7b764ae0cc341430e92b4c7a4a4f22246b63d"
SIGNERS="$("$HOME/Android/Sdk/build-tools/36.1.0/apksigner" verify --print-certs "$STAGE/uni.apk" | sed -n 's/^Signer #[0-9]* certificate SHA-256 digest: //p')"
[[ $SIGNERS == "$APK_SIGNER_SHA256" ]] || { echo "APK signed by the wrong key: '$SIGNERS' (expected $APK_SIGNER_SHA256)" >&2; exit 1; }
SIGNED_NOT_PUBLISHED=1
python3 scripts/write-release-manifest.py "$STAGE" "$VERSION" "$SHA" "$REPO_SLUG"
# The tag is created last, so a failed build leaves nothing behind and the next tick retries.
# A release may carry its own notes in plain words (docs/releases/<version>.md); the build line follows them.
NOTES="Built from \`${SHA:0:12}\` on main. Mac: download Uni-mac-arm64.zip for a first install; installed apps update themselves. Android: uni.apk (Android versionCode $CODE)."
if [[ -f "docs/releases/$VERSION.md" ]]; then NOTES="$(cat "docs/releases/$VERSION.md")

$NOTES"; fi
gh release create "$TAG" --repo "$REPO_SLUG" --target "$SHA" --latest \
  --title "Uni $VERSION" \
  --notes "$NOTES" \
  "$STAGE/Uni-mac-arm64.zip" "$STAGE/Uni.app.tar.gz" "$STAGE/Uni.app.tar.gz.sig" \
  "$STAGE/uni.apk" "$STAGE/latest.json" "$STAGE/android.json"
rm -f "$SIGN_ASKED"; SIGNED_NOT_PUBLISHED=0
git fetch --quiet origin --tags
# Read the release back by its tag, then at the address installed apps poll, which GitHub caches for a while. Neither
# stops the run here: the tag exists now, so a later tick would never come back for the device installs below.
RELEASE_READABLE=1
if ! retry 6 5 release_serves "$REPO_SLUG" "$TAG" "$VERSION"; then
  RELEASE_READABLE=0; echo "Release $TAG does not serve latest.json for $VERSION" >&2
elif retry 7 10 release_is_latest "$REPO_SLUG" "$VERSION"; then echo "GitHub releases/latest now serves $VERSION" >&2
else echo "Warning: GitHub releases/latest does not serve $VERSION yet; installed apps update once it does" >&2; fi
# The tailnet download page (atomic swaps). It is a convenience: a failed copy never fails a published release.
{ mkdir -p "$SERVE/android" &&
  cp "$STAGE/uni.apk" "$SERVE/uni.apk.tmp" && mv "$SERVE/uni.apk.tmp" "$SERVE/uni.apk" &&
  printf '{"version": "%s", "url": "uni.apk"}\n' "$VERSION" >"$SERVE/android/latest.json.tmp" &&
  mv "$SERVE/android/latest.json.tmp" "$SERVE/android/latest.json"; } || echo "Warning: tailnet download page not updated ($SERVE)" >&2
# Zero-touch install on each paired device (Daylight, Pixel 7) when wireless ADB is up
# and Uni is not in the foreground. Never uninstalls: that would lose the device identity.
# UNI_RELEASE_NO_DEVICE_INSTALL=1 (a release whose brief says not to install on any device) leaves every device to the
# in-app update banner.
if [[ ${UNI_RELEASE_NO_DEVICE_INSTALL:-} == 1 ]]; then echo "Device installs skipped (UNI_RELEASE_NO_DEVICE_INSTALL=1); the in-app banner offers the APK"; else
while read -r NAME SERIAL; do
  if [[ $SERIAL == offline ]]; then echo "$NAME: ADB offline; in-app banner will offer the APK"; continue; fi
  TOP="$(timeout 10 adb -s "$SERIAL" shell dumpsys activity activities | grep topResumedActivity || true)"
  if [[ "$TOP" == *org.unforced.uni* ]]; then echo "$NAME: Uni in foreground; skipped, banner will offer the APK"; continue; fi
  if timeout 900 adb -s "$SERIAL" install -r "$STAGE/uni.apk" </dev/null; then echo "$NAME: upgraded to $VERSION"
  else echo "$NAME: install failed; never uninstall, inspect signature" >&2; fi
done < <(python3 scripts/connect-devices.py || true)
fi
((RELEASE_READABLE)) || { echo "Published $TAG, but it could not be read back by its tag: check the release" >&2; exit 1; }
echo "Published $TAG ($SHA): https://github.com/$REPO_SLUG/releases/tag/$TAG"
}
main "$@"
