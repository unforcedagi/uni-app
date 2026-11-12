# src/ask: the one-ask library, vendored

`ask.ts`, `nostr.ts`, `index.ts` and `cases.json` are copied byte for byte from the uni-ask repo at commit
`ce45775` (`ts/src/*` and `cases/cases.json`). Do not edit them here: change uni-ask, run both of its suites, then copy
the four files again and update the commit above. `scripts/askCases.test.ts` runs the shared case file in this repo's
`pnpm test`, so the app reads asks exactly as the Python listener does.

Why vendored and not a workspace link: uni-ask is not published yet, and this repo's CI and release builds must build
from this repo alone (a link to a path on one machine would break them). Its two dependencies, `@noble/curves` and
`@noble/hashes`, are pinned to the versions uni-ask's own lockfile uses.

`shim.ts` is the app's, not the library's: it adds `String.prototype.isWellFormed` and `Object.hasOwn` on an older
webview that lacks them, so the library runs unchanged there.
