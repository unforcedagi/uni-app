# Uni release pipeline

**`main` is the release branch.** Day-to-day work lands on `journal` (or feature branches). Promoting to `main` ships: within 30 minutes uni-1 builds the new `main` commit and publishes it as a GitHub release. Installed apps update from there.

## How it runs
- `uni-updater.timer` (systemd user timer on uni-1, linger enabled) runs `scripts/watch-main.sh` every 30 minutes from the dedicated checkout `~/Code/uni-app-pipeline`. Install/refresh it with `bash scripts/install-updater-timer.sh`.
- If `origin/main` has no `uni-v*` tag, the watcher checks it out and runs `scripts/publish.sh`:
  1. Tests: case-collision check, `pnpm typecheck`, `pnpm test`, `cargo test --workspace`.
  2. Version: `scripts/next-version.py` gives one patch above the newest `uni-v*` tag, or `package.json`'s version if that is higher (edit it to jump minor/major). Android versionCode = `1000000 + major*100000 + minor*1000 + patch`. **The pipeline never commits to the repo**; the version is stamped at build time with `tauri --config`.
  3. Builds in parallel: the Mac app on GitHub-hosted `macos-15` (arm64) from the exact `main` SHA and the Android APK on uni-1. The Mac workflow checks out Buzz at pinned `5669fdc`; no Mac mini connection is used.
  4. Publishes GitHub release `uni-vX.Y.Z` (marked latest) with `Uni-mac-arm64.zip`, `Uni.app.tar.gz` + `.sig`, `uni.apk`, `latest.json` (Mac updater manifest) and `android.json`. The tag is created last, so a failed build leaves nothing behind and the next tick retries.
  5. If the wireless ADB is up on a paired device (Daylight, Pixel 7) and Uni isn't in the foreground, installs the APK directly (never uninstalls).
- Logs: `journalctl --user -u uni-updater.service`; build logs under `~/.cache/uni-release/uni-release-<version>/`.
- Run by hand: `bash scripts/watch-main.sh`. Pause: `systemctl --user stop uni-updater.timer`.

## Devices
- **Mac:** first install from the latest release's `Uni-mac-arm64.zip` (unzip, move to Applications, allow once in Privacy & Security; it is ad-hoc signed, not notarized). The app checks `https://github.com/unforcedagi/uni-app/releases/latest/download/latest.json` at launch and every 6 hours, downloads and verifies the signed update, and offers **Restart**.
- **Daylight:** the app checks `.../releases/latest/download/android.json` and shows **Download APK** for newer versions (Android requires one confirmation per install), unless the ADB path above already installed it. The APK is debug-signed with uni-1's `~/.android/debug.keystore`; keep that key or updates stop installing over the existing app.
- Builds 0.1.2-0.1.5 poll the tailnet (`https://uni-1.taildf9ce2.ts.net:8443`); `publish.sh` keeps those pointers current until those builds are gone.

## Signing and hosted build security
The updater private key and stable self-signed signing certificate remain on uni-1 in `~/.config/uni/updater/` (`uni.key`, `macsign.p12`, `macsign.pass`). `scripts/build-mac-hosted.sh` uploads them as **temporary GitHub environment secrets**, dispatches `.github/workflows/mac-build.yml` for the exact main SHA, waits for the run, downloads the three Mac assets and deletes the secrets on exit (including failure). The environment `uni-mac-signing` must have a custom deployment-branch policy allowing **only `main`**; the helper refuses to run if that policy changes. GitHub decrypts these credentials on its hosted runner while building; this is a trust tradeoff, not end-to-end private signing. Do not run this workflow on unreviewed main code, grant untrusted collaborators workflow write access, or widen the environment branch policy. If a host or workflow is compromised during the short secret window, rotate the updater key (requiring manual reinstall) and signing certificate. No signing secret is stored persistently in GitHub after the helper exits.

The workflow checks the release version in `Uni.app`, verifies the stable certificate SHA-1 `E82AA2442F66F08F3772C9D6F7ADD877A1290125`, and uploads `Uni-mac-arm64.zip`, `Uni.app.tar.gz`, and `Uni.app.tar.gz.sig` as a short-lived Actions artifact. The local publisher still stamps/builds Android on uni-1 and only creates a release/tag after both platforms succeed. An interrupted host can leave temporary secrets behind; check `gh secret list -R unforcedagi/uni-app -e uni-mac-signing` and delete the three `MACSIGN_P12_BASE64`, `MACSIGN_P12_PASSWORD`, `TAURI_SIGNING_PRIVATE_KEY` secrets before retrying. The environment must be created with a main-only custom branch policy before enabling the timer.
