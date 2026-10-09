# REPORT-T76: the interface system on the real Linux webview (WebKitGTK via Tauri 2)

Run 2026-10-09 on uni-1 (Arch/Omarchy), `webkit2gtk-4.1 2.52.6`, Tauri 2.12 debug build of `feat/area-room` + this change.
Worker: Sonnet 5.5. Nothing pushed, nothing installed over the running Uni app, no vault writes (the page talks to a mock, see below).

## Bottom line

| Owed item | Result on the real engine |
|---|---|
| 1. Self-test passes `sealed`, WebRTC really off, child frames included | **No, not yet.** 18 of 19 checks pass, including `WebRTC unavailable` and `WebRTC unavailable in a child frame`. The one failure is `webkit.messageHandlers.ipc unreachable`. The stored mode is therefore "failed", the gate stays closed on Linux. |
| 2. Focus theft: blur-side counting stops a repeating thief, notice on first theft | **Yes**, with a caveat about how the theft had to be produced (below). Notice on the first theft, stop at once with text in the composer, stop on the second theft, one log line, real keys typed meanwhile stay in the composer. One key ("h") reached an app in the repeating-thief run before the stop. |

Two defects were found and are fixed here. Both made the packaged Linux app unable to run any area app or self-test at all, so the earlier Chromium/Playwright WebKit passes said nothing about them.

## Defects found and fixed

1. **Host CSP blocked every inline script in every sealed frame.** Tauri rewrites the configured CSP at build time and adds `script-src 'self' 'sha256-…'` to the host document. A `srcdoc` frame inherits its embedder's policy, so inline scripts in the self-test frame and in every area app were refused (the frame loaded, its script never ran, the self-test timed out with all checks red). Evidence, before the fix: `{"simpleFrame":"no message"}`, host header `frame-src about:; script-src 'self' 'sha256-ozz+…' …` (`red/diag.json`). Fix: `src-tauri/tauri.conf.json` gets `"dangerousDisableAssetCspModification": ["script-src"]`, so the packaged host has exactly the policy the Playwright runs always had (`frame-src about:` only). After the fix the header is `frame-src about:` and the same frame posts back. **Cost to weigh:** the host document itself no longer has a `script-src` restriction (before, it had `'self'` + hashes). No other directive was relied on. Not verified on macOS/Android, where the same inheritance rule should apply.
2. **The four navigation checks could never pass on WebKitGTK.** The nav probes aimed at `127.0.0.1:1`. WebKitGTK refuses restricted ports (1, 9, …) before the CSP check, so no `frame-src` violation is reported and the host has no evidence. Replaying the real probe documents against port 1 gave no violation; the same vectors against an allowed port gave one every time and no request reached a loopback listener (`experiments.json`, `http.log`). Red test first: `scripts/interface.test.ts` "probe: navigation targets use a port the engine does not refuse before the CSP" failed on `self: port 1 is restricted`; the probe now uses port 59999 and the test and all four checks pass. (The `sendBeacon` target also uses port 1 but passes because the CSP check fires first; left alone.)

## Still failing on the real engine: `webkit.messageHandlers.ipc unreachable`

A sandboxed `srcdoc` frame (and a child frame it creates under the real frame CSP) has `window.webkit.messageHandlers.ipc`, and posting to it does not throw. `window.ipc` is undefined there (wry injects that only in the main frame). What I observed: a well-formed Tauri message for the harness command `t76_write`, posted from the frame without the invoke key, did **not** run (`frame-ipc.txt` was never created). Tauri 2.12 requires a per-launch `Tauri-Invoke-Key` the frame cannot read (`tauri-2.12.0/src/ipc/protocol.rs`). So reachable, but I could not make it execute; I did not try to guess or extract the key, and I did not prove no command can ever run.

I did not weaken the check or hide `window.webkit` in the frame: a child frame gets its own `webkit` (shown), so hiding it would only make the probe pass. **Decision for Aaron:** (a) keep the check strict and Linux stays closed until wry/Tauri stop exposing the handler to sub-frames, or (b) accept "post is rejected without the key" as the proof and change the check to something the host can observe. I recommend (a) until (b) is argued by someone who reads wry's handler.

## Focus theft: what the real engine does

- A sandboxed frame **cannot take focus by itself** in WebKitGTK. `focus()` + `window.focus()` from inside left the host composer focused, with `frameHasFocus:false`, even with both of the host's `inert` layers (the frame and `.area-stage`) removed. A repeating 5 ms thief heard nothing while real keys were typed (`D_naturalThief_realTyping`: composer received `hunter2`, app heard ``).
- Control that the instrument can hear: when the host gives the frame the keyboard (as a press on it does), the app hears `abc` (`H_control…`).
- So the blur-side counting could not be exercised by the app's own script. To exercise it anyway, **the host moved focus to the iframe** (`iframe.focus()` after removing both inert layers): a real focus change and a real window blur, the case the counting exists for. Those runs (E, F, G, I) are forced, not natural.

Results (raw below): E first move, empty composer: notice shown, app still running, no log line. F with text in the composer: stopped at once, one `focus theft` log line, draft kept. G two moves: notice, then stopped. I repeating forced thief with real typing: stopped, one log line, but the app heard `"h"` before the stop. A real Tab out of the composer (four Tabs): no accusation.

Limits: the Tab in A is a real key; the composer text in C/F is real keys too. The theft's cause in E/F/G/I is the host, not an app script, as said above. The gate was opened by writing the stored pass by hand for this part (`forcedGate:true`), because the self-test fails on `ipc`; grant prompts were answered with a real Return key (Allow ignores untrusted clicks).

## How it was run

Everything lives in `scripts/t76/`; nothing in a release build.

```
# one-time
sudo pacman -S --needed cage            # nested headless Wayland compositor (wtype was already installed)
# build (frontend with the harness plugin, then the debug binary; pnpm's beforeBuildCommand fails in this worktree, so it is skipped)
UNI_T76=1 node node_modules/vite/bin/vite.js build
npm run tauri build -- --debug --no-bundle --config '{"build":{"beforeBuildCommand":""}}'
# run (results land in ~/.hermes/cache/scratch/t76/)
T76_TIMEOUT=420 scripts/t76/run.sh
```

How it works, and what is and is not the real thing:
- Real: the Tauri 2 debug binary, WebKitGTK 2.52.6, the real built frontend, the real host CSP header, real key events (`wtype` into a headless `cage`), the real self-test UI (Settings → Run sandbox self-test).
- Not real: the vault/rooms/identity. The page runs against the Playwright fixture's Tauri mock (`scripts/browser/areasFixture.ts`, captured by `make-init.ts`), injected as an init script into a replacement window (`src-tauri/src/t76.rs`, debug builds on Linux only, active only when `UNI_T76_DIR` and `UNI_T76_INIT` are set). `window.__TAURI_INTERNALS__` is read-only on WebKitGTK, so `UNI_T76=1` adds a Vite transform (`vite.config.ts`) that points `@tauri-apps/*` at `window.__T76_MOCK__`. Real IPC is used only for two debug-only commands (`t76_write`, `t76_read`).
- Isolation: throwaway `HOME`/`XDG_*`, cage runs without the user's Wayland session, `WLR_BACKENDS=headless`, `WEBKIT_DISABLE_COMPOSITING_MODE=1`, `WEBKIT_DISABLE_DMABUF_RENDERER=1`. cage started Xwayland (`:1`) on its own; GTK was set to the Wayland backend.
- `env.json` shows `hasFocus:false` until the first real key; cage's headless seat has no keyboard until `wtype` creates one. Focus results are from after that.

## Raw results

### env.json
```json
{
  "userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15",
  "rtcMain": "undefined",
  "webkitRtcMain": "undefined",
  "mediaDevices": "undefined",
  "hasFocus": false,
  "tauriInternalsReal": true,
  "descriptors": "[{\"w\":false,\"c\":false,\"g\":false},{\"w\":false,\"c\":false,\"g\":false}]",
  "mockActive": false,
  "hasFocusAtStart": false,
  "hasFocusAtRail": true,
  "hasFocusBeforeFirstKey": false,
  "focusWaitMs": 3260
}
```

### selftest.json (final run; `stored:null` because mode was "failed")
```json
{
  "status": "selftest-status fail",
  "text": "Failed. Live area apps are off.",
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
      "ok": false,
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
  "stored": null,
  "timeline": {
    "clickAtMs": 7001,
    "doneAtMs": 15165,
    "stageFramesSeen": [
      {
        "t": 7019,
        "bytes": 209428,
        "navUrlInDoc": null,
        "vector": "main"
      },
      {
        "t": 7104,
        "bytes": 204567,
        "navUrlInDoc": "127.0.0.1:59999/selftest-nav",
        "vector": "self"
      },
      {
        "t": 9105,
        "bytes": 204664,
        "navUrlInDoc": "127.0.0.1:59999/selftest-nav",
        "vector": "parse"
      },
      {
        "t": 11112,
        "bytes": 204638,
        "navUrlInDoc": "127.0.0.1:59999/selftest-nav",
        "vector": "anchor"
      },
      {
        "t": 13118,
        "bytes": 204490,
        "navUrlInDoc": "127.0.0.1:59999/selftest-nav",
        "vector": "parse"
      }
    ],
    "violationsDuringSelfTest": [
      {
        "t": 7223,
        "dir": "frame-src",
        "blocked": "http://127.0.0.1:59999"
      },
      {
        "t": 9213,
        "dir": "frame-src",
        "blocked": "http://127.0.0.1:59999"
      },
      {
        "t": 11219,
        "dir": "frame-src",
        "blocked": "http://127.0.0.1:59999"
      },
      {
        "t": 13127,
        "dir": "frame-src",
        "blocked": "http://127.0.0.1:59999"
      }
    ]
  }
}
```

### selftest.json before the fixes (both defects present), summary
All 19 checks red, `Failed: the probe did not finish.` (`red/selftest.json` in the scratch dir.) After fix 1 only: 14/19 passed (webkit ipc + 4 navigation checks failed). After fix 2: 18/19.

### experiments.json (what the failing checks do on this engine)
```json
{
  "ipcFromFrame": {
    "t76": 1,
    "present": true,
    "posted": true,
    "windowIpc": "undefined"
  },
  "nav_self": {
    "violationsSeenByHost": [
      {
        "dir": "frame-src",
        "blocked": "http://127.0.0.1:18176",
        "src": "",
        "sample": ""
      }
    ]
  },
  "nav_meta": {
    "violationsSeenByHost": [
      {
        "dir": "frame-src",
        "blocked": "http://127.0.0.1:18176",
        "src": "",
        "sample": ""
      }
    ]
  },
  "nav_anchor": {
    "violationsSeenByHost": [
      {
        "dir": "frame-src",
        "blocked": "http://127.0.0.1:18176",
        "src": "about",
        "sample": ""
      }
    ]
  },
  "nav_parse": {
    "violationsSeenByHost": [
      {
        "dir": "frame-src",
        "blocked": "http://127.0.0.1:18176",
        "src": "",
        "sample": ""
      }
    ]
  },
  "navWithFrameCsp_self": {
    "violationsSeenByHost": [
      {
        "dir": "frame-src",
        "blocked": "http://127.0.0.1:18176",
        "src": "",
        "sample": ""
      }
    ]
  },
  "navWithFrameCsp_meta": {
    "violationsSeenByHost": [
      {
        "dir": "frame-src",
        "blocked": "http://127.0.0.1:18176",
        "src": "",
        "sample": ""
      }
    ]
  },
  "navWithFrameCsp_anchor": {
    "violationsSeenByHost": [
      {
        "dir": "frame-src",
        "blocked": "http://127.0.0.1:18176",
        "src": "about",
        "sample": ""
      }
    ]
  },
  "navWithFrameCsp_parse": {
    "violationsSeenByHost": [
      {
        "dir": "frame-src",
        "blocked": "http://127.0.0.1:18176",
        "src": "",
        "sample": ""
      }
    ]
  },
  "childRealm": {
    "t76": 1,
    "kidIpc": true
  },
  "replay": [
    {
      "navUrlInDoc": "127.0.0.1:59999/selftest-nav",
      "violations": [
        "frame-src http://127.0.0.1:59999"
      ]
    },
    {
      "navUrlInDoc": "127.0.0.1:59999/selftest-nav",
      "violations": [
        "frame-src http://127.0.0.1:59999"
      ]
    },
    {
      "navUrlInDoc": "127.0.0.1:59999/selftest-nav",
      "violations": [
        "frame-src http://127.0.0.1:59999"
      ]
    },
    {
      "navUrlInDoc": "127.0.0.1:59999/selftest-nav",
      "violations": [
        "frame-src http://127.0.0.1:59999"
      ]
    }
  ],
  "fetchToListener": {
    "t76": 1,
    "r": "rejected TypeError"
  }
}
```
Loopback listener log (`http.log`): `1791540859.5 GET /fetch` (only the `fetch` experiment, which the frame CSP then rejected client-side with a TypeError; no navigation request arrived).

### focus-theft.json (traces removed; full file in the scratch dir)
```json
{
  "forcedGate": true,
  "A_tabOutIsNotTheft": {
    "after": {
      "frames": 1,
      "notice": false,
      "stopped": false,
      "composerFocused": false,
      "hasFocus": true
    },
    "thefts": []
  },
  "B_naturalSteal_emptyComposer": {
    "inertWhileComposerFocused": true,
    "before": {
      "frames": 1,
      "notice": false,
      "stopped": false,
      "composerFocused": true,
      "hasFocus": true
    },
    "iframeWasActive": false,
    "samples": 73,
    "frameReport": {
      "t76steal": 1,
      "frameHasFocus": false,
      "active": ""
    },
    "after": {
      "frames": 1,
      "notice": false,
      "stopped": false,
      "composerFocused": true,
      "hasFocus": true
    },
    "thefts": []
  },
  "C_naturalSteal_withText": {
    "inertWhileComposerFocused": true,
    "composerValueBefore": "hello",
    "before": {
      "frames": 1,
      "notice": false,
      "stopped": false,
      "composerFocused": true,
      "hasFocus": true
    },
    "iframeWasActive": false,
    "samples": 77,
    "frameReport": {
      "t76steal": 1,
      "frameHasFocus": false,
      "active": ""
    },
    "after": {
      "frames": 1,
      "notice": false,
      "stopped": false,
      "composerFocused": true,
      "hasFocus": true
    },
    "composerValueAfter": "hello",
    "thefts": []
  },
  "D_naturalThief_realTyping": {
    "after": {
      "frames": 1,
      "notice": false,
      "stopped": false,
      "composerFocused": true,
      "hasFocus": true
    },
    "composerValue": "hunter2",
    "keysHeardByApp": "",
    "thefts": []
  },
  "H_control_appHearsKeysWhenItHasTheKeyboard": {
    "frameIsActiveElement": true,
    "keysHeardByApp": "abc"
  },
  "E_focusMovedToFrame_emptyComposer": {
    "before": {
      "frames": 1,
      "notice": false,
      "stopped": false,
      "composerFocused": true,
      "hasFocus": true
    },
    "iframeWasActive": false,
    "samples": 77,
    "after": {
      "frames": 1,
      "notice": true,
      "stopped": false,
      "composerFocused": true,
      "hasFocus": true
    },
    "thefts": []
  },
  "F_focusMovedToFrame_withText": {
    "before": {
      "frames": 1,
      "notice": false,
      "stopped": false,
      "composerFocused": true,
      "hasFocus": true
    },
    "iframeWasActive": false,
    "samples": 76,
    "after": {
      "frames": 0,
      "notice": false,
      "stopped": true,
      "composerFocused": true,
      "hasFocus": true
    },
    "composerEndsWithHello": true,
    "thefts": [
      "uni: focus theft: stopped the app of area \"Areas/PoliteE\" for taking the keyboard from the chat"
    ]
  },
  "G_repeatingMoves_emptyComposer": {
    "afterEach": [
      {
        "frames": 1,
        "notice": true,
        "stopped": false,
        "composerFocused": true,
        "hasFocus": true
      },
      {
        "frames": 0,
        "notice": false,
        "stopped": true,
        "composerFocused": true,
        "hasFocus": true
      }
    ],
    "thefts": [
      "uni: focus theft: stopped the app of area \"Areas/PoliteG\" for taking the keyboard from the chat"
    ]
  },
  "I_repeatingThief_realTyping": {
    "after": {
      "frames": 0,
      "notice": false,
      "stopped": true,
      "composerFocused": true,
      "hasFocus": true
    },
    "keysHeardByApp": "h",
    "thefts": [
      "uni: focus theft: stopped the app of area \"Areas/ThiefD\" for taking the keyboard from the chat"
    ]
  },
  "J_appStealsItself_emptyComposer": {
    "before": {
      "frames": 1,
      "notice": false,
      "stopped": false,
      "composerFocused": true,
      "hasFocus": true
    },
    "iframeWasActive": false,
    "samples": 74,
    "frameReport": {
      "t76steal": 1,
      "frameHasFocus": false,
      "active": ""
    },
    "after": {
      "frames": 1,
      "notice": false,
      "stopped": false,
      "composerFocused": true,
      "hasFocus": true
    },
    "thefts": []
  },
  "K_appStealsItself_withText": {
    "before": {
      "frames": 1,
      "notice": false,
      "stopped": false,
      "composerFocused": true,
      "hasFocus": true
    },
    "iframeWasActive": false,
    "samples": 77,
    "frameReport": {
      "t76steal": 1,
      "frameHasFocus": false,
      "active": ""
    },
    "after": {
      "frames": 1,
      "notice": false,
      "stopped": false,
      "composerFocused": true,
      "hasFocus": true
    },
    "thefts": []
  }
}
```

### Focus event trace of E (one forced move, empty composer), ms from the move
```
31.0ms blur target=TEXTAREA active=BODY related=IFRAME
31.0ms focusout target=TEXTAREA active=BODY related=IFRAME
32.0ms blur target=#doc active=IFRAME related=-
32.0ms blur target=IFRAME active=IFRAME related=TEXTAREA
32.0ms focusout target=IFRAME active=IFRAME related=TEXTAREA
32.0ms focus target=TEXTAREA active=TEXTAREA[Message Techne] related=IFRAME
32.0ms focusin target=TEXTAREA active=TEXTAREA[Message Techne] related=IFRAME
44.0ms focus target=#doc active=TEXTAREA[Message Techne] related=-
```

## Not done / not claimed

- Release build, packaged bundle, Wayland compositors other than cage, and a real GPU were not tested.
- Natural app-initiated theft could not occur on this engine, so "stops a repeating thief" is proven only for host-forced focus moves.
- The ipc exposure is observed, not resolved.
- Repo checks run: `npm test` (all sections ok), `tsc --noEmit`, `cargo check`, Playwright `interface.spec.ts` on desktop Chromium (39 passed).
