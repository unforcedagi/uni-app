#!/usr/bin/env bash
# Publish one monotonic Uni version to Mac + Android. Run only on uni-1.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
cd "$(dirname "$0")/.."
REPO="$PWD"
SERVE="$HOME/.local/share/uni/apk"
MAC="uni@100.126.18.24"
BASE="https://uni-1.taildf9ce2.ts.net:8443"
[[ $(git branch --show-current) == pipeline || $(git branch --show-current) == journal ]] || { echo 'Run from the dedicated pipeline or journal checkout' >&2; exit 1; }
[[ -z $(git status --porcelain) ]] || { echo 'Commit/clean changes before publishing' >&2; exit 1; }
[[ $(git -C ../buzz rev-parse HEAD) == 5669fdc* ]] || { echo 'Buzz dependency moved: validate Mac sync before publishing' >&2; exit 1; }
command -v pnpm >/dev/null
# Integrate other agents before the version commit; never force journal.
git fetch origin journal
git rebase origin/journal
pnpm install --frozen-lockfile
python3 scripts/check-case-collisions.py
python3 scripts/test_case_collisions.py
pnpm typecheck
pnpm test
cargo test --workspace
# Tauri regenerates checked-in capability schemas during tests; these are not release inputs.
git restore -- src-tauri/gen/schemas
# Reserve the next patch version and Android versionCode. Both are committed together.
python3 scripts/bump-release.py
cargo test --workspace
VERSION="$(node -p 'require("./package.json").version')"
CODE="$(python3 -c 'import json;print(json.load(open("src-tauri/tauri.conf.json"))["bundle"]["android"]["versionCode"])')"
git add package.json Cargo.toml Cargo.lock src-tauri/tauri.conf.json
git commit -m "release: Uni v$VERSION (Android $CODE)"
SHA="$(git rev-parse HEAD)"
BUZZ_SHA="$(git -C ../buzz rev-parse HEAD)"
git push origin HEAD:journal
git tag "uni-v$VERSION" "$SHA"
git push origin "uni-v$VERSION"
# The Mac's private signing key lives outside the repo; install once from uni-1.
ssh "$MAC" 'mkdir -p ~/.config/uni/updater && chmod 700 ~/.config/uni/updater'
scp -q "$HOME/.config/uni/updater/uni.key" "$MAC:.config/uni/updater/uni.key"
ssh "$MAC" 'chmod 600 ~/.config/uni/updater/uni.key'
mkdir -p "$TMPDIR/uni-release-$VERSION"
STAGE="$TMPDIR/uni-release-$VERSION"
( ssh "$MAC" "bash ~/Code/uni-app-journal/scripts/build-mac.sh '$SHA' '$BUZZ_SHA'" >"$STAGE/mac.log" 2>&1 ) & MAC_PID=$!
(
  source "$HOME/.config/uni/android.env"
  export PATH="$HOME/.cargo/bin:$PATH"
  pnpm tauri android build --debug --apk --target aarch64 >"$STAGE/android.log" 2>&1
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
scp -q "$MAC:.local/share/uni/mac-build/Uni-mac-arm64.zip" "$STAGE/"
scp -q "$MAC:.local/share/uni/mac-build/Uni.app.tar.gz" "$STAGE/"
scp -q "$MAC:.local/share/uni/mac-build/Uni.app.tar.gz.sig" "$STAGE/"
APK="$REPO/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
test -s "$APK" && test -s "$STAGE/Uni.app.tar.gz.sig"
# Never mutate existing assets: versioned URL and atomic latest.json pointer.
mkdir -p "$SERVE/mac" "$SERVE/android"
cp "$STAGE/Uni.app.tar.gz" "$SERVE/mac/Uni-$VERSION.app.tar.gz"
cp "$STAGE/Uni.app.tar.gz.sig" "$SERVE/mac/Uni-$VERSION.app.tar.gz.sig"
cp "$STAGE/Uni-mac-arm64.zip" "$SERVE/mac/Uni-$VERSION-mac-arm64.zip"
cp "$APK" "$SERVE/uni.apk.tmp"
mv "$SERVE/uni.apk.tmp" "$SERVE/uni.apk"
GH_TAG="mac-v$VERSION-${SHA:0:7}"
gh release create "$GH_TAG" "$STAGE/Uni-mac-arm64.zip" --repo unforcedagi/uni-app --target "$SHA" --title "Uni $VERSION for macOS (Apple Silicon)" --notes "Updater-enabled first install; ad-hoc signed. See docs/release.md." --prerelease
python3 scripts/write-release-manifest.py "$SERVE" "$VERSION" "$SHA" "$BASE"
curl -fsS "$BASE/mac/latest.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["platforms"]["darwin-aarch64"]["signature"]; print("Mac manifest:", d["version"], "signature present")'
curl -fsS "$BASE/android/latest.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("Android manifest:", d["version"])'
# Only install while Uni is not foreground; wireless debugging may be offline.
SERIAL="$(adb devices | awk '/100\.114\.25\.16:[0-9]+[[:space:]]+device/{print $1; exit}')"
if [[ -n "$SERIAL" ]]; then
  TOP="$(timeout 10 adb -s "$SERIAL" shell dumpsys activity activities | grep topResumedActivity || true)"
  if [[ "$TOP" != *org.unforced.uni* ]]; then
    if timeout 900 adb -s "$SERIAL" install -r "$APK"; then echo "Daylight upgraded in background"; else echo 'Daylight install failed; never uninstall; inspect signature' >&2; fi
  else echo 'Daylight foreground: skipped disruptive ADB install; in-app banner will offer APK'; fi
else echo 'Daylight ADB offline: published APK + in-app prompt; no uninstall'; fi
echo "Published Uni $VERSION ($SHA), Android versionCode $CODE: $BASE/mac/latest.json $BASE/android/latest.json"
