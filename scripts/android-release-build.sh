#!/usr/bin/env bash
# T-305: the Android release APK, as publish.sh ships it. Run from anywhere; prints the APK path last.
#   bash scripts/android-release-build.sh <version> <versionCode>
# Release build type, arm64 only (both devices are arm64-v8a), signed by app/build.gradle.kts with the one key installed
# apps trust ($ANDROID_USER_HOME/debug.keystore, from ~/.config/uni/android.env). The Rust library is built for size:
# LTO, opt-level s, one codegen unit, stripped. Set here and not in Cargo.toml's [profile.release], so the Mac build
# (the same profile, on the hosted runner) is unchanged. 0.1.83, a debug build, was 553 MB; this is about 24 MB.
set -euo pipefail
VERSION=${1:?version}; CODE=${2:?versionCode}
cd "$(dirname "$0")/.."
source "$HOME/.config/uni/android.env"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_PROFILE_RELEASE_LTO=true CARGO_PROFILE_RELEASE_OPT_LEVEL=s CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
  CARGO_PROFILE_RELEASE_STRIP=true
# T-207: Gradle updates the APK in place and can append a changed native library, leaving the old copy as dead space
# (0.1.62 was 683 MB, 337 MB of it unused). A fresh APK every time.
rm -rf src-tauri/gen/android/app/build/outputs/apk
# Messages needs Rust 1.93+; the Mac runner is pinned to 1.93.0 and builds it too.
pnpm tauri android build --apk --target aarch64 --features messages \
  --config "{\"version\":\"$VERSION\",\"bundle\":{\"android\":{\"versionCode\":$CODE}}}"
APK=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
test -s "$APK"
echo "$(pwd)/$APK"
