# Uni release pipeline

**`main` is the release branch.** Day-to-day work lands on `journal` (or feature branches). Promoting to `main` ships: within 30 minutes uni-1 builds the new `main` commit and publishes it as a GitHub release. Installed apps update from there.

## How it runs
- `uni-updater.timer` (systemd user timer on uni-1, linger enabled) runs `scripts/watch-main.sh` every 30 minutes from the dedicated checkout `~/Code/uni-app-pipeline`. Install/refresh it with `bash scripts/install-updater-timer.sh`.
- If `origin/main` has no `uni-v*` tag, the watcher checks it out and runs `scripts/publish.sh`:
  1. Tests: case-collision check, `pnpm typecheck`, `pnpm test`, `cargo test --workspace`.
  2. Version: `scripts/next-version.py` gives one patch above the newest `uni-v*` tag, or `package.json`'s version if that is higher (edit it to jump minor/major). Android versionCode = `1000000 + major*100000 + minor*1000 + patch`. **The pipeline never commits to the repo**; the version is stamped at build time with `tauri --config`.
  3. Builds in parallel: the Mac app on the Mac mini (`uni@100.126.18.24`, `scripts/build-mac.sh`, exact SHA) and the Android APK on uni-1.
  4. Publishes GitHub release `uni-vX.Y.Z` (marked latest) with `Uni-mac-arm64.zip`, `Uni.app.tar.gz` + `.sig`, `uni.apk`, `latest.json` (Mac updater manifest) and `android.json`. The tag is created last, so a failed build leaves nothing behind and the next tick retries.
  5. If the wireless ADB is up on a paired device (Daylight, Pixel 7) and Uni isn't in the foreground, installs the APK directly (never uninstalls).
- Logs: `journalctl --user -u uni-updater.service`; build logs under `~/.cache/uni-release/uni-release-<version>/`.
- Run by hand: `bash scripts/watch-main.sh`. Pause: `systemctl --user stop uni-updater.timer`.

## Devices
- **Mac:** first install from the latest release's `Uni-mac-arm64.zip` (unzip, move to Applications, allow once in Privacy & Security; it is ad-hoc signed, not notarized). The app checks `https://github.com/unforcedagi/uni-app/releases/latest/download/latest.json` at launch and every 6 hours, downloads and verifies the signed update, and offers **Restart**.
- **Daylight:** the app checks `.../releases/latest/download/android.json` and shows **Download APK** for newer versions (Android requires one confirmation per install), unless the ADB path above already installed it. The APK is debug-signed with uni-1's `~/.android/debug.keystore`; keep that key or updates stop installing over the existing app.
- Builds 0.1.2-0.1.5 poll the tailnet (`https://uni-1.taildf9ce2.ts.net:8443`); `publish.sh` keeps those pointers current until those builds are gone.

## Signing
Updater key: `~/.config/uni/updater/uni.key` on uni-1 (copied to the Mac mini each run; mode 600). The public key is in `src-tauri/tauri.conf.json`. Never commit or print the private key; rotating it requires every Mac to reinstall by hand.
