# REPORT-T79: sealed frames no longer see Tauri's bridge on Android; Daylight self-test = approved-code

Worker: Sonnet 5.5, 2026-10-09. Branch `feat/area-room`, committed, not pushed, no vault writes. APK **0.1.30 (1001030)** built and `adb install -r`'d to the Daylight (upgrade: firstInstallTime 2026-09-23 unchanged, nothing uninstalled). No crate fork, no `[patch.crates-io]`.

## Result
Daylight self-test (CDP, raw JSON `~/.hermes/cache/scratch/t79/selftest-1.json`): "Only the WebRTC checks failed. Approved code only (WebRTC present)". **18 of 19 pass.** Not the "two WebRTC checks" the task expected: only "WebRTC unavailable in a child frame" is ✗; "WebRTC unavailable" (the in-frame neutraliser) is ✓ on Android. The mode is `approved-code` either way (`evaluateProbe`: only WebRTC ids failed). `__TAURI_INTERNALS__`, `__TAURI__`, `webkit.messageHandlers.ipc`, `window.ipc`, CSP fetch/XHR/beacon, parent/top/cookie/storage/popup and all four navigation vectors pass. No check was weakened.
Side effect: this run stored an `approved-code` pass in the app's settings on the Daylight, so live area apps are now enabled there in that mode.

## Why the probe never reported (plumbing, fixed)
`probe.ts` `blocked(fn)` did `await fn()`. With `__TAURI_INTERNALS__` present, `invoke('vault_paths')` goes out through `window.ipc.postMessage`, Rust answers, and the callback id lives only in the host frame (the host's "[TAURI] Couldn't find callback id" warnings are that answer). The frame's promise never settles, so the probe hung on its first check and reported nothing; 40 s later the host timed out and marked everything ✗. Fix: `blocked` races `fn()` against 1.5 s; a call that neither throws nor settles is "not blocked" (fails closed). Test `selftest: a call that never settles is not 'blocked'…` in `scripts/interface.test.ts` runs the helper extracted from `PROBE_HTML` (sync throw → blocked, rejection → blocked, success → not, hang → not, bounded time).

## The hole (real) and its cause, with citations (wry 0.55.1, tauri 2.11.6)
1. `wry-0.55.1/src/android/kotlin/RustWebView.kt:31`: `WebViewCompat.addDocumentStartJavaScript(this, script, setOf("*"))` for every init script. Android wry never reads `for_main_frame_only` (it passes only `init_script.script`, `src/android/main_pipe.rs:179-184`), although Tauri marks its core scripts main-frame-only (`tauri-2.11.6/src/manager/webview.rs:162`). So `__TAURI_INTERNALS__` (with the invoke key) landed in sandboxed `about:srcdoc` frames.
2. `wry-0.55.1/src/android/main_pipe.rs:307`: `addJavascriptInterface(ipc, "ipc")`. Chromium exposes that object to every frame, and `Ipc.postMessage` (`kotlin/Ipc.kt:13`) cannot tell frames apart (`Rust.ipc(webView.id, webViewClient.currentUrl, m)` uses the main page URL).
3. `tauri-2.11.6/scripts/ipc-protocol.js:20`: `canUseCustomProtocol = osName !== 'android'`, so **every** invoke on Android is `window.ipc.postMessage(...)`. A sealed frame therefore could execute any command, not just wedge the probe. (The CSP only stops the fetch path, which Android doesn't use.)

## Fix (host-side, Kotlin; the generated wry copies are replaced)
`src-tauri/gen/android/app/src/main/java/org/unforced/uni/`:
- `RustWebView.kt`, `Ipc.kt`: copies of wry 0.55.1's templates (placeholders resolved). `app/build.gradle.kts` excludes `**/generated/RustWebView.kt` and `Ipc.kt` from `KotlinCompile`, so ours are the only definitions regardless of build order (the Kotlin compile runs before the rust task in this Gradle graph, so patching the generated files is not reliable).
- `MainFrameOnly.kt`: (1) init scripts registered for `http://tauri.localhost` and `https://tauri.localhost` only and wrapped in `if (window.top === window) {…}`; (2) once wry has added its JS interface, `Ipc.init` posts a runnable that removes it and installs `window.ipc` as a `WebViewCompat.addWebMessageListener` for the same origins; the listener forwards to `Rust.ipc` only when `isMainFrame` (on a single IPC thread, in order, like the old JavaBridge thread) and logs/drops the rest. If the WebView lacks WEB_MESSAGE_LISTENER the old interface stays and the self-test fails closed.
- `src-tauri/build.rs`: an Android build panics if wry is not 0.55.1 (the copies cannot go stale silently).

## Proof on the Daylight (0.1.30, WebView Chrome/156; raw files in `~/.hermes/cache/scratch/t79/`)
- `selftest-1.json`: above.
- `frame-direct-1.json`, a sealed `sandbox="allow-scripts"` srcdoc frame created from the main page: `__TAURI_INTERNALS__` undefined, `__TAURI__` undefined, `window.ipc` undefined. Same-origin unsandboxed frame: `__TAURI_INTERNALS__` undefined (guard), `window.ipc` **object** (the listener is injected for the app origin), so the native drop is what protects it. Main frame: internals object, ipc.postMessage function.
- `subframe-drop-logcat.txt`: `ipc.postMessage` from that same-origin frame posts, and logcat shows `UniMainFrameOnly: dropped an ipc message from a sub-frame`.
- Main-window invoke: `invoke('webview_runtime')` from the main frame returned "wry 0.55.1 tauri 2.11.6" (on Android that goes through the new listener). The Uni chat renders live messages and the composer; logcat has no FATAL/AndroidRuntime or callback errors. I did not drive a message send, and did not open a different room by touch (my click on the Rooms tab left the Uni chat showing).
- Red baseline is the task's own observation on 0.1.29 (`__TAURI_INTERNALS__` object in the frame, probe never finished); I could not reinstall 0.1.29 (downgrade).

## Gates
`tsc --noEmit` ok; `npm test` exit 0, 0 FAIL; `cargo check` (src-tauri, Linux) ok; `cargo check --target aarch64-linux-android` ok (needs the NDK clang on PATH); `tauri android build --debug --apk --target aarch64` "Finished 1 APK". Playwright and the Linux WebKitGTK harness not re-run (no code they exercise changed besides the one `blocked` helper line).

## Limits
- Same-origin sub-frames still get a `window.ipc` object; native code drops their messages. Sealed frames have an opaque origin and get nothing.
- Rules are the two `tauri.localhost` origins. `tauri android dev` (dev server origin) would lose IPC; release/debug APKs are unaffected.
- Trust in the opaque-origin exclusion is empirical on this WebView (Chrome 156): it holds here and the self-test re-checks it per webview version; the `top` guard and the main-frame check are independent layers.
- The key-pass is keyed on wry/tauri version, not on the Kotlin copies; a wry bump trips the `build.rs` check first.
