# Uni app on mobile — Tauri 2 evaluation

**Status:** evaluation, 2026-09-20. Companion to `uni-app-spec.md` (same directory). Every claim is either a URL, a file path on this box, or a command I ran here. Things I could not check are in §8.

## 0. The short version

Tauri 2 can be the same app on Aaron's phone and his Mac, and the Rust core the spec describes (`uni-core` → `buzz-ws-client` + `buzz-sdk` + rusqlite) has **no desktop-only dependency in its Android dependency graph** — I checked with `cargo tree --target aarch64-linux-android`. The one thing that stopped a real cross-compile today is a missing Android NDK (the C compiler for Android); that is an install, not a design problem.

The hard part is not building the app. It is **waking the phone when the app is closed**. Tauri has no built-in push, the Buzz relay's push executor is currently iOS/APNs-only, and the Buzz Flutter app does not do push either. Whatever mobile stack Aaron picks, a small server-side piece has to exist before "a mention notifies my phone" is true. Tauri neither helps nor hurts there.

Recommendation: **Tauri 2, Android first**, with a first milestone that is deliberately narrow — a debug APK on Aaron's actual phone showing the read-only Buzz timeline from the same `uni-core` crate the Mac app uses. Push is milestone two and is mostly relay work.

## 1. Tauri 2 mobile status (as of 2026-09-20)

**Mechanism, one line:** Tauri = your Rust program + a native "webview" (the OS's built-in browser engine — Android System WebView on Android, WKWebView on iOS/macOS) that renders your React UI. Rust and JS talk through `invoke` calls.

- **Official support.** Android and iOS are first-class, stable targets of Tauri 2; the docs have `tauri android dev` / `tauri ios dev` and per-platform prerequisites (https://v2.tauri.app/start/prerequisites/, https://v2.tauri.app/develop/). Latest stable is `tauri-v2.11.6` (2026-09-19); a `3.0.0-alpha` line started 2026-09-13 (https://github.com/tauri-apps/tauri/releases). Build on 2.x; don't chase 3.0-alpha.
- **Plugins that matter for Uni** (support tables on each page):
  - Deep links — Android + iOS supported, must be declared in config, not at runtime. https://v2.tauri.app/plugin/deep-linking/
  - Local notifications — Android + iOS supported, but an open bug report says several Android calls (`cancelAll`, `pending`, `active`, `channels`) misbehave: https://github.com/tauri-apps/plugins-workspace/issues/2341. Fine for "show a banner while the app is open", don't rely on the scheduling/query APIs.
  - Stronghold (encrypted secret file) — all platforms, but the plugin is slated for deprecation (maintainer comment on https://github.com/tauri-apps/plugins-workspace/issues/2048). See §4.
  - WebSocket — the Rust side is just `tokio-tungstenite`, which is what `buzz-ws-client` already uses; no plugin needed because the socket lives in Rust, not the webview.
- **Known mobile gaps (open issues, `platform: Android` label — 88 open as of today):**
  - **Push notifications: not in core.** Tracking issue https://github.com/tauri-apps/tauri/issues/11651 (open since 2024); the upstream plugin PR https://github.com/tauri-apps/plugins-workspace/pull/2066 is still a draft. Community plugins exist (§3).
  - **Background execution.** Android kills or freezes a backgrounded app's process within seconds-to-minutes; a Rust WebSocket does not survive that (discussion https://github.com/orgs/tauri-apps/discussions/14615). Keeping the process alive with a *foreground service* (a persistent notification, like a music player) works but hits a real bug: relaunch after swipe-away gives a blank webview — https://github.com/tauri-apps/tauri/issues/15671 (open, filed against tauri 2.11.5, July 2026). Conclusion: do **not** design around a long-lived socket on the phone.
  - **Tokio runtime on Android.** `tokio::task::spawn_blocking` in `setup` crashes on a physical device unless a runtime is entered or `tauri::async_runtime` is used: https://github.com/tauri-apps/tauri/issues/13828. Relevant because `uni-core` uses tokio; the fix is a known pattern (own the runtime, hand `uni-core` a handle).
  - **App lifecycle.** Android `onResume`/`onPause` are exposed to plugins (since 2.0.0-alpha.17: https://v2.tauri.app/release/tauri/v2.0.0-alpha.17); a small third-party plugin surfaces them to JS (`tauri-plugin-app-events`, https://docs.rs/crate/tauri-plugin-app-events/latest). Needed so the app reconnects and re-syncs on resume.
  - **Release builds on Android 15/16** had a crash-on-launch report in May 2026 (https://github.com/tauri-apps/tauri/issues/15337); unclear if resolved. Test a *release* APK early, not just debug.

Net: mature enough to ship a client that reconnects on open, immature for anything that must run while closed.

## 2. Can the same Rust core compile for Android? (real checks)

What is on this box: `rustc 1.97.1`, targets installed before I started: `aarch64-apple-darwin` only. No Android SDK/NDK, no `adb`, no Java runtime, no Xcode.app (CommandLineTools only), ~14 GB free on `/` (`df -h`).

**Dependency audit (read from Cargo.toml files):**

| Crate | Deps | Desktop-only? |
|---|---|---|
| `buzz-core` (`/Users/uni/Code/buzz/crates/buzz-core/Cargo.toml`) | nostr, serde, sha2, hmac, rand, zeroize… | No — file literally says "NO tokio, NO sqlx… zero I/O dependencies" |
| `buzz-sdk` (`…/buzz-sdk/Cargo.toml`) | buzz-core, nostr, uuid, serde, thiserror | No |
| `buzz-ws-client` (`…/buzz-ws-client/Cargo.toml`) | nostr, tokio, tokio-tungstenite (`rustls-tls-webpki-roots`), futures-util, url | No — rustls (pure-Rust TLS) with bundled root certs, so no OpenSSL and no OS cert store needed |
| `uni-core` (`/Users/uni/Code/uni-app/crates/uni-core/Cargo.toml`) | the above + rusqlite (`bundled`), rustls (`ring`), keyring, uuid | **keyring** — see below |

**`cargo tree --target aarch64-linux-android -p uni-core`** (resolves the graph *as it would be on Android* without compiling): no `openssl`, no `aws-lc`, no `security-framework`. Native C code in the graph is exactly three crates: `secp256k1-sys` (Nostr signing), `ring` (TLS crypto), `libsqlite3-sys` (SQLite, bundled). All three are routinely built for Android — they just need a C compiler that targets Android.

`keyring 3.6.3` on Android resolves to its `mock` backend (`~/.cargo/registry/src/*/keyring-3.6.3/src/lib.rs:301-309`: any OS not in {linux, freebsd, openbsd, macos, ios, windows} → `pub use mock as default`). It compiles, but stores nothing. So `uni-core::identity` (`crates/uni-core/src/identity.rs:42`) must get a platform-specific key store on Android (§4). iOS *is* covered by `apple-native`.

**Actual cross-compile attempt.** I ran `rustup target add aarch64-linux-android` (127 MB, the only install I made) and then:

```
cd /Users/uni/Code/buzz && cargo check -p buzz-sdk --target aarch64-linux-android
→ error: failed to run custom build command for `secp256k1-sys v0.10.1`
  error occurred in cc-rs: failed to find tool "aarch64-linux-android-clang"
```

Every pure-Rust crate before it checked fine (`serde_json`, `sha2`, `rand`, `hmac`, `hex` all reached `Checking … `). It failed at the first crate with C code, for the expected reason: no NDK. This is the honest result — **"compiles for Android modulo NDK", not "compiled for Android"**.

**What has to be installed for a real Android build** (per https://v2.tauri.app/start/prerequisites/ → "Configure for Mobile Targets → Android"): Android Studio (brings a JDK; set `JAVA_HOME`), then via its SDK Manager: SDK Platform, Platform-Tools (`adb`), NDK (side by side), Build-Tools, Command-line Tools; set `ANDROID_HOME` and `NDK_HOME`; `rustup target add` the four Android targets. Rough disk: Android Studio ~2–3 GB, SDK + platform-tools ~1–2 GB, NDK ~2–3 GB, plus Gradle caches ~1–2 GB — **plan on ~8–10 GB**, which fits in the 14 GB free but is tight; clearing `~/.cargo/registry` (1.0 GB) or old `target/` dirs first is worth it. No emulator needed if Aaron's phone is the target (saves ~3–5 GB of system images). iOS later needs full Xcode (~15 GB+) — not viable on this disk today.

## 3. Background mention wakeups — the hard problem

**Mechanism.** On Android a closed app cannot listen on a socket. The only thing that can wake it is the OS's push channel: Google's FCM (Firebase Cloud Messaging), or a UnifiedPush distributor (an open alternative where a separate app like `ntfy` holds one socket and forwards wakes; https://unifiedpush.org/developers/spec/definitions/). Some server must therefore watch the relay on the phone's behalf and send the wake.

**What Buzz already has.** The relay implements **NIP-PL push leases** (`/Users/uni/Code/buzz/docs/nips/NIP-PL.md`): the client publishes a `kind:30350` event containing an encrypted filter (e.g. `{kinds:[9], "#p":[me]}`) plus a push token; the relay keeps matching after the socket closes and sends a content-free "reconnect now" wake. This is exactly the right shape for Uni: the wake carries no message text, and the app fetches the real events with a normal `REQ` on open. The relay-side matcher and delivery worker exist (`crates/buzz-relay/src/push_runtime.rs`, `handlers/push_lease.rs`), and there is a separate gateway service (`crates/buzz-push-gateway`) that holds the Apple credentials.

**The catch, precisely:**
- The relay advertises only `buzz-ios-production` / `buzz-ios-sandbox` app profiles with transport `apns` (`crates/buzz-relay/src/nip11.rs:209-216`). A lease with `"transport":"fcm"` is rejected with `transport mismatch` (`handlers/push_lease.rs:226-227`; there is a unit test asserting exactly this at line 722).
- The NIP itself says "Until that constant and its wire tests are registered, **FCM is not a conforming v1 public-gateway profile**" (`NIP-PL.md:231`).
- The gateway is APNs-only (`buzz-push-gateway/src/lib.rs`: `apns.rs`, `app_attest.rs`; delivery URL hard-coded to `/v1/deliveries/apns`, `config.rs:370`).
- The Buzz Flutter app has no push code at all — `grep -ri firebase|apns|unifiedpush mobile/` is empty. So the Flutter app is *not* ahead of Tauri here.

**Options, compared:**

| Option | What it is | Works when app closed | Effort / who | Honest caveats |
|---|---|---|---|---|
| **A. NIP-PL + FCM profile on the relay** | Add an `fcm` app profile + FCM delivery path to `buzz-relay`/gateway; Uni app registers a lease with its FCM token | Yes | Relay-side Rust (Buzz team, or a fork Aaron controls since it's his relay); app side: a Tauri FCM plugin | Protocol-conformant and reuses the existing matcher, but it's upstream work; needs a Firebase project (Google account, `google-services.json`); Google sees a token + a wake, never content |
| **B. Hub-side/agent-side push bridge** | A tiny always-on process (could live next to the Parachute hub, or be Uni's own agent) holding a NIP-42 socket with `{kinds:[9],"#p":[aaron]}` and calling FCM's HTTP API on match | Yes | ~200 lines of Rust or TS; Aaron owns it fully | Duplicates what NIP-PL does but with zero relay changes; the bridge holds a Firebase server key; it is one more thing to keep running |
| **C. UnifiedPush** | Same as A or B but the bridge POSTs to a UnifiedPush endpoint (e.g. a self-hosted `ntfy`) instead of FCM; phone runs the ntfy distributor app | Yes (distributor keeps the socket) | Bridge as in B; **no** Tauri UnifiedPush plugin exists — would need a small Kotlin plugin | No Google dependency; battery cost of the distributor's socket; two apps on the phone |
| **D. Polling** | WorkManager-style periodic wake (min ~15 min on Android) | Sort of | Kotlin plugin | Latency is minutes, not seconds; not useful for "an agent just mentioned you" |
| **E. Foreground service** | Keep the app's own socket alive with a persistent notification | Yes while service lives | Kotlin | Battery drain; the blank-webview relaunch bug above (tauri#15671) |

**App-side plugins for FCM in Tauri** (none official): `srod/tauri-plugin-fcm` (https://github.com/srod/tauri-plugin-fcm — Android + iOS, gated `#[cfg(mobile)]`), `TM9657/tauri-plugin-remote-push` (https://github.com/TM9657/tauri-plugin-remote-push), `spicavi/tauri-plugin-push-notifications` (created 2026-07), plus the `inKibra`/`FreshX-GmbH` forks referenced in tauri#11651. All small, all recent, none with a track record; pick one and be ready to fork it.

**My read:** B first (no relay change, Aaron controls every piece), A as the end state (the relay already has the matcher, tenant checks and content-free wake). Both share the app-side code. C is the no-Google path at the cost of writing the plugin. FCM latency is seconds when the phone is online, minutes under Doze; battery cost is negligible because every app shares the phone's one Google socket.

## 4. Where the nsec lives on Android

**Mechanism.** The nsec (Nostr private key) must sign every relay message. On desktop the spec keeps it in the OS keychain via the `keyring` crate and signs only in Rust. On Android the equivalent is the **Android Keystore** — hardware-backed key storage; you can't export the key, you ask the OS to wrap/unwrap data with it — plus an app-private encrypted file for the wrapped bytes.

Options, with status:

1. **`android-keyring` crate** (https://lib.rs/crates/android-keyring, v0.2.0, 2025-07) — a pure-Rust backend for the `keyring` crate that calls Android Keystore + SharedPreferences over JNI; documented as working "out of box" with Tauri Mobile via `ndk-context`. One `set_android_keyring_credential_builder()` call at startup and `uni-core::identity` works unchanged. **Self-described "experimental… not mature enough for sensitive applications"**, 128 downloads/month. Best fit architecturally (key never leaves Rust); weakest maturity.
2. **`tauri-plugin-keystore`** (`@impierce/tauri-plugin-keystore`, v2.1.0-alpha.1, https://docs.rs/crate/tauri-plugin-keystore) — Android Keystore + iOS Keychain, Android 9+, alpha, last published about a year ago, assumes biometrics are set up. JS-facing API, which is the wrong side of the boundary for a signing key.
3. **`tauri-plugin-keyring-store`** (v0.2.0, https://docs.rs/crate/tauri-plugin-keyring-store) — built on `keyring-core 1.x` with "Android Keystore + SharedPreferences" backend and a **Rust-first API** (`app.keyring()`), which respects the "sign only in Rust" rule. Young.
4. **`tauri-plugin-stronghold`** (official, https://v2.tauri.app/plugin/stronghold/) — an encrypted file, password-derived key, all platforms. Works, but the maintainers have said it is being deprecated (https://github.com/tauri-apps/plugins-workspace/issues/2048), and the password has to come from somewhere (user-typed, or itself stored in the Keystore — which is option 1/3 again).
5. **Plain file encrypted with a Keystore-wrapped key** — ~100 lines of Kotlin in a custom Tauri plugin, no third-party dependency. Most control, most code.

Recommendation: start with **(1) `android-keyring`** behind the existing `keyring::Entry` calls so `identity.rs` stays one code path, keep the signing boundary in Rust, and treat "replace with (5) or a matured (3)" as a Phase 2 hardening item. On iOS `keyring`'s `apple-native` backend already covers it. Never pass the nsec to the webview on any platform.

## 5. Tauri vs React Native vs Flutter

Terms: **uniffi** = Mozilla's tool that generates Kotlin/Swift bindings for a Rust crate. **flutter_rust_bridge** = the same idea for Dart.

| Criterion | Tauri 2 (React + uni-core) | React Native (+ uni-core via uniffi) | Flutter (+ uni-core via flutter_rust_bridge; existing `buzz/mobile`) |
|---|---|---|---|
| Code sharing with desktop | **One codebase**: same React UI + same Rust; desktop = window, mobile = same app | UI shared with… nothing on desktop unless you also adopt RN-macOS (Microsoft-maintained, secondary); the Mac app would be a second codebase | Flutter desktop exists but is a second build of a Dart UI; the spec's Tauri desktop would be replaced, not shared |
| Rust core reuse | Direct: `uni-core` is linked into the Tauri binary, called via `invoke`. Same crate on all five OSes | Via uniffi: generate Kotlin + Swift bindings, ship as a native module; two binding layers to maintain | Via flutter_rust_bridge: works well, but note Buzz's Flutter app deliberately does **not** share the Rust core today (`mobile/` is pure Dart); you'd be the first |
| Mobile maturity | Stable but young; 88 open Android issues; background/relaunch rough edges (§1) | Very mature; huge ecosystem; expensive upgrades | Very mature; excellent rendering; Buzz already ships it |
| Background / push story | No built-in push; community FCM plugins (§3); background = foreground service with known bug | Mature FCM/APNs libraries (`@react-native-firebase/messaging`), headless JS tasks | Mature (`firebase_messaging`, `flutter_local_notifications`) — but Buzz mobile still has none wired |
| Secure key on Android | Experimental `android-keyring` or small custom plugin (§4) | `react-native-keychain` (mature) + key stays in Rust via uniffi | `flutter_secure_storage` (mature) + Rust via FRB |
| How much of spec Phase 1 survives | **All of it** — Phase 1 is Tauri + React + uni-core; mobile is `tauri android init` on the same tree | Rust core survives; React components partially (RN ≠ React DOM); Tauri shell and desktop packaging thrown away | Rust core survives; all TS/React UI thrown away; desktop story restarts |
| Relay-side push work needed | Same for all three (§3) | Same | Same |

The bottom row is the point: the push/wake problem is stack-independent. What the stack decides is whether Aaron has one UI or two. Only Tauri gives one.

## 6. Recommendation and first mobile milestone

**Recommendation: Tauri 2, Android first, iOS later**, as the spec assumed — now with two evidence-backed conditions: (a) design the phone client as *connect-on-open, sync, disconnect*, never as always-connected; (b) budget a separate small server-side push bridge, because no client stack gets wakeups for free.

**Milestone M1 — "same core, same UI, on Aaron's phone" (read-only).**

Definition of done: a **debug APK** built from `/Users/uni/Code/uni-app` (same repo as the Mac app) installed on Aaron's Android phone via USB, that (1) reads a pasted nsec (temporary — Keystore comes in M2), (2) NIP-42 authenticates to the relay from Rust, (3) discovers channels and shows kind-9 messages from `uni-core`'s SQLite in the React timeline, (4) shows "mentions me" highlights, (5) reconnects and re-syncs on `onResume`. No push, no vault side yet, no compose.

Why this is the right smallest thing: it proves every layer that is actually uncertain — NDK cross-compile of `secp256k1`/`ring`/`sqlite`, tokio inside the Android entry point, TLS to the relay without an OS cert store, the React UI on a phone screen — and nothing that isn't.

Prerequisites to install (one-time, on this Mac): Android Studio + SDK + NDK + platform-tools (§2, ~8–10 GB; free ~3 GB first), the three remaining Android rustup targets, `@tauri-apps/cli` (Node/npm are already at `/opt/homebrew/bin`). On the phone: Developer options → USB debugging.

Steps: `tauri android init` in `uni-app` → wire `uni-core` behind `#[cfg_attr(mobile, tauri::mobile_entry_point)]` with an explicitly owned tokio runtime → `cargo check --target aarch64-linux-android -p uni-core` green → `tauri android dev` on the USB device → responsive tweaks to the timeline → `tauri android build --apk --debug` and keep the APK.

Estimate: **3–4 working days** once the SDK is installed (installation itself is ~half a day of downloads and PATH fiddling). Breakdown: 0.5 d tooling; 1 d getting `uni-core` to link and run on device (expect the tokio issue and possibly a `ring`/NDK clang flag); 1 d UI/lifecycle; 0.5–1 d slack for the Android 15/16 release-build check.

**M2 (after M1): Keystore nsec + local notifications while open.** **M3: push bridge (option B) + FCM plugin → mention wakes the phone.** M3 is where the relay/hub conversation with the Buzz team happens (offer the FCM profile upstream, §3 option A).

## 7. Unknowns

- Whether `secp256k1-sys`, `ring` and bundled SQLite build cleanly with the current NDK clang once installed — expected yes, **not verified** here (build stopped at "no NDK").
- `android-keyring` actually working inside Tauri's `ndk-context` on Aaron's specific device/Android version; its author calls it experimental.
- Which Tauri FCM plugin is least broken; none has more than a handful of users.
- Whether the Buzz team will accept an FCM app profile in NIP-PL, or whether Aaron runs a modified relay.
- Whether tauri#15337 (release APK crash on Android 15/16) is fixed in 2.11.6 — must test a release build, not just debug.
- Whether tailnet certificates (`*.ts.net`) are accepted by `rustls` + `webpki-roots` from Android (Tailscale certs are Let's Encrypt, so likely yes; same question as spec §8 for the vault WS from the webview).
- Aaron's phone model / Android version and whether it is on the tailnet (the hub URL is a tailnet address).
- Disk: ~14 GB free is enough for Android tooling, not for Xcode; iOS work needs a disk decision first.
