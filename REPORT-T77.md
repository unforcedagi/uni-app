# REPORT-T77: `webkit.messageHandlers.ipc` closed to sealed frames on Linux

Worker: Sonnet 5.5, 2026-10-09. Nothing pushed, not installed, no vault writes. No crate fork needed.

## Decision
Fixed host-side, strict check kept and unchanged. The self-test now passes **19/19** on the real WebKitGTK 2.52.6 webview and the sealed gate opens ("Passed. Live area apps are now on: Sealed.").

## Research (locked versions: wry 0.55.1, tauri 2.11.6; sources in ~/.cargo/registry)
- wry registers the handler with `manager.register_script_message_handler("ipc")` (`wry-0.55.1/src/webkitgtk/mod.rs:655`): default world, no world name, so every frame using that content manager sees `webkit.messageHandlers.ipc`. Its `window.ipc` shim (`mod.rs:344`) is injected main-frame only, which is why `window.ipc` was already unreachable.
- Scoping options: `register_script_message_handler_in_world` exists in webkit2gtk-rs 2.0.2 (`auto/user_content_manager.rs:94`), but wry's own shim calls `webkit.messageHandlers['ipc']` from the default world, so moving the handler would break the main frame too. `UserContentInjectedFrames::TopFrame` only applies to injected scripts (`mod.rs:725-728`), not to handlers. WebKitGTK has no per-frame handler visibility.
- Tauri on desktop does not need the handler: `tauri-2.11.6/scripts/ipc-protocol.js:26-69` sends every invoke by `fetch` to the `ipc://` custom protocol (with the invoke key) and uses `window.ipc.postMessage` (line 84) only after that fetch fails. The only `ipc.postMessage` use in tauri / tauri-runtime-wry / wry-webkitgtk is that fallback.

## Change
`src-tauri/src/lib.rs`: `close_ipc_handler` (Linux), called in setup next to `disable_webrtc`, runs `user_content_manager().unregister_script_message_handler("ipc")` through `with_webview` on every window (the T-76 replacement window included). Cost: the postMessage fallback is gone on Linux, so if the `ipc://` fetch is ever blocked, invokes fail instead of degrading. Windows created after setup would need the same call; the app creates none today.

## Proof (real engine, T-76 harness, `T76_TIMEOUT=420 scripts/t76/run.sh`)
Build: `UNI_T76=1 node node_modules/vite/bin/vite.js build`; `npm run tauri build -- --debug --no-bundle --config '{"build":{"beforeBuildCommand":""}}'`.
- Red (before): REPORT-T76 run, `webkit.messageHandlers.ipc unreachable` failed, 18/19 (saved as red-selftest.json).
- Green (after): 0 failed of 19 checks, raw JSON below.
- Main-window invoke still works: the harness reports every result through the real Tauri command `t76_write`; all files (selftest.json, focus-theft.json, done) arrived, and `app.log` has no "postMessage interface" fallback warning. (Whether a given call took fetch rather than the fallback is inferred from the missing handler plus the missing warning.)
- Focus-theft run: same outcomes as T-76. Natural steal impossible (B,C,D), real Tab not a theft (A), E notice, F stop at once with one log line, G/I stop on repeat, J/K app self-steal no accusation. In I the app heard one key before the stop ("u" this run, "h" before), same as T-76.

### selftest.json
```json
{
  "status": "selftest-status pass",
  "text": "Passed. Live area apps are now on: Sealed.",
  "checks": [
    {
      "ok": true,
      "label": "Contract answers inside the frame"
    },
    {
      "ok": true,
      "label": "__TAURI_INTERNALS__ unreachable"
    },
    {
      "ok": true,
      "label": "__TAURI__ absent"
    },
    {
      "ok": true,
      "label": "webkit.messageHandlers.ipc unreachable"
    },
    {
      "ok": true,
      "label": "window.ipc unreachable"
    },
    {
      "ok": true,
      "label": "fetch blocked by the CSP"
    },
    {
      "ok": true,
      "label": "XMLHttpRequest blocked by the CSP"
    },
    {
      "ok": true,
      "label": "sendBeacon blocked by the CSP"
    },
    {
      "ok": true,
      "label": "WebRTC unavailable"
    },
    {
      "ok": true,
      "label": "WebRTC unavailable in a child frame"
    },
    {
      "ok": true,
      "label": "parent.document unreachable"
    },
    {
      "ok": true,
      "label": "Top navigation blocked"
    },
    {
      "ok": true,
      "label": "document.cookie unreachable"
    },
    {
      "ok": true,
      "label": "localStorage unreachable"
    },
    {
      "ok": true,
      "label": "window.open blocked"
    },
    {
      "ok": true,
      "label": "Self-navigation stopped (location)"
    },
    {
      "ok": true,
      "label": "Meta refresh stopped"
    },
    {
      "ok": true,
      "label": "Link navigation stopped"
    },
    {
      "ok": true,
      "label": "Navigation during page parse stopped"
    }
  ],
  "stored": {
    "platform": "linux",
    "passedAt": "2026-10-09T10:20:18.767Z",
    "appVersion": "dev",
    "userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15",
    "mode": "sealed"
  },
  "timeline": {
    "clickAtMs": 7062,
    "doneAtMs": 15217,
    "stageFramesSeen": [
      {
        "t": 7079,
        "bytes": 209428,
        "navUrlInDoc": null,
        "vector": "main"
      },
      {
        "t": 7193,
        "bytes": 204567,
        "navUrlInDoc": "127.0.0.1:59999/selftest-nav",
        "vector": "self"
      },
      {
        "t": 9173,
        "bytes": 204664,
        "navUrlInDoc": "127.0.0.1:59999/selftest-nav",
        "vector": "parse"
      },
      {
        "t": 11178,
        "bytes": 204638,
        "navUrlInDoc": "127.0.0.1:59999/selftest-nav",
        "vector": "anchor"
      },
      {
        "t": 13184,
        "bytes": 204490,
        "navUrlInDoc": "127.0.0.1:59999/selftest-nav",
        "vector": "parse"
      }
    ],
    "violationsDuringSelfTest": [
      {
        "t": 7309,
        "dir": "frame-src",
        "blocked": "http://127.0.0.1:59999"
      },
      {
        "t": 9280,
        "dir": "frame-src",
        "blocked": "http://127.0.0.1:59999"
      },
      {
        "t": 11286,
        "dir": "frame-src",
        "blocked": "http://127.0.0.1:59999"
      },
      {
        "t": 13192,
        "dir": "frame-src",
        "blocked": "http://127.0.0.1:59999"
      }
    ]
  }
}
```

## Round 2 (T-77b): review follow-ups

Red first, then green. Gates at the end: `tsc --noEmit` ok, `npm test` exit 0 (0 FAIL), `cargo check` in `src-tauri` ok, Playwright areas config on Chromium (port 1435 free): **196 passed, 6 skipped, 0 failed** (the skips are the viewport-conditional phone/desktop specs). Not re-run: the real-WebKitGTK harness (no Rust runtime code that the sealed-frame probe exercises changed except the logging and signature of `close_ipc_handler`).

- **P2-1** `scripts/htmlSinks.test.ts`, added to `npm test`. Red: a planted `src/__plant.tsx` with `dangerouslySetInnerHTML` and `el.innerHTML =` failed it (exit 1, both named); removed, it passes (exit 0). It scans `src/` for `dangerouslySetInnerHTML`, `.innerHTML =`, `insertAdjacentHTML`, `document.write`, `rehype-raw`, `allowDangerousHtml`, `highlight=`. No existing use, so the allowlist is empty. Trade-off recorded in `docs/interfaces.md` ("Host CSP trade-off and guards").
- **P2-2** `close_ipc_handler` now `tracing::warn!`s when `with_webview` errs or the webview has no user content manager. The stored pass gains a `runtime` field ("wry X tauri Y"), checked by `gateMode`/`liveAreaApps` through a new optional last parameter (`undefined` = not checked, `null` or a mismatch or a pass stored without one = closed). New command `webview_runtime` (wry version read from `Cargo.lock` by `build.rs`, Tauri from `tauri::VERSION`), hook `useWebviewRuntime`, used by `AreasSurface` and `SelfTest`. Unit test in `scripts/areasR3.test.ts` (red before: failed; green after). Consequence: every existing stored pass has no runtime, so each user re-runs the self-test once. The Playwright fixture now mocks `webview_runtime` and stores the matching `runtime`.
- **P3-1** `src/ipcLost.ts`: on Linux only, the first unhandled `error`/`unhandledrejection` that is the missing `messageHandlers.ipc` TypeError shows the toast "Uni lost its connection to the app core. Restart Uni." Unit test `scripts/ipcLost.test.ts` (red before, green after) covers the message matcher, not the live event path on a real webview (not observed). One line in `docs/interfaces.md`.
- **P3-2** `close_ipc_handler(&WebviewWindow)`, doc comment says any new window builder must call it; `setup` loops over `webview_windows()`.
- **P3-3** `scripts/check-release-dist.sh` (deletes `dist`, `unset UNI_T76`, `npm run build:vite`, fails if `__T76_MOCK` in `dist/assets`). It uses `npm run` because `pnpm` fails in this worktree's npm-installed `node_modules`; the script is the same `tsc && vite build`. Wired in as `beforeBuildCommand` in `src-tauri/tauri.conf.json`, so every Tauri build (Linux, Mac workflow, Android in `publish.sh`) goes through it; noted in `docs/release.md`. Red: a variant that leaves `UNI_T76=1` set exited 1 with the leak message. `dist/` was then rebuilt cleanly: 0 files contain `__T76_MOCK`.

Not verified: `beforeBuildCommand` through a real `tauri build` on Mac/Android (cwd assumed to be the repo root, as it is for `pnpm build:vite`).
