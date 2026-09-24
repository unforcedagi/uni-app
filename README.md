# uni-app — Talk to Uni

An Android-first, Telegram-like Buzz conversation client. The product contract and release gates are in [`uni-app-spec.md`](uni-app-spec.md). This is a shared React/Tauri 2 shell over a Rust core; the CLI remains useful for development and relay diagnosis.

## What works in this branch

- Responsive room list, chronological cached messages, focused root/reply threads, per-room public-key recipient, text compose, manual/on-resume sync and explicit error states.
- Rust core discovers joined channels, authenticates with NIP-42, fetches kind-9 history and kind-0 profiles, persists messages in SQLite, and stores NIP-10 root/parent references alongside legacy rows.
- Sending signs a Buzz SDK kind-9 event with `h`/`e`/`p` tags; it checks the selected room and cached reply target, waits for relay `OK`, and only then persists the event. Relay rejection does not clear the draft.
- CLI `key init|show`, `sync`, `live`, `show`, `search`, and `probe` remain available. The live loop is not used by the mobile shell.

## Build and test

Buzz source must be checked out at `../buzz` because the workspace uses path dependencies.

```sh
UNI_NO_KEYRING=1 cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm install                     # configure esbuild build approval in pnpm policy if required
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vite build
```

The mock relay tests cover discovery, per-channel reads, profile cache, subscriptions, reconnection, accepted and rejected sends, and thread persistence. `UNI_NO_KEYRING=1` keeps headless tests from prompting a system keychain. The Tauri shell uses the same app-data SQLite database on desktop and Android; `UNI_RELAY_URL` can override its default relay.

## Release gates — not yet done

**Do not treat this as an account-ready Android app.** The `keyring` crate's Android fallback is nonpersistent; phase 1 has no Keystore-backed personal-key pairing. It will show cached data offline, but cannot safely sign in as Aaron on an unprovisioned Android device. Implement/test secure on-device enrollment and relay membership before using a personal account. Do not put an nsec in the JavaScript or in an APK environment variable.

Raw microphone audio is not a supported Buzz voice note: native MP4 packaging, signed media upload, permission and device tests are deferred. Android keyboard speech-to-text can fill the text composer now. History is bounded (500 fetched per channel per sync, 300 displayed per room/thread); older-page backfill is not implemented. No real-relay publish or Pixel/tablet smoke test is claimed by this branch.

The previous core exploration and relay findings remain in [`UNI-APP-HANDOFF.md`](UNI-APP-HANDOFF.md). The `android` worktree/build effort is separate from the `talk-to-uni` branch.
