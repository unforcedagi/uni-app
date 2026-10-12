# Life OS profile PR 3: chat becomes optional (T-111, #uni-os)

With `activeProfile().chat.provider === null` the Life OS surface shows no Buzz surface and makes no Buzz calls from its own components. The uni vault (`buzz`) behaves as before.

## What changed
- `AreasSurface.tsx`: reads `useVaultProfile().chat.provider`. With chat off it passes an empty room list down (so no steward, room, door or update resolves), strips node room ids (`withRoom`), reports no host room (`onRoom(null)`, so the app shell loads no room for the surface), and does not render TalkBar, steward line, RecentMessages, RoomBlock/Ledger, RoomLine, "updates from rooms below", or the Ask/Refresh drafts.
- `AreaView.tsx`: chat pane forced `hidden`, "Uni routes from here" line dropped, and the sealed-app chat module's `getMessages` answers `[]` without calling Buzz. "Open room" and the Brief's Ask/Refresh follow from the stripped `channel`.
- `TreeHome.tsx`: `TreeScreen` and `InsideBlock` take `chat` and drop room doors and the room part of aria labels.
- `TodayView.tsx`: `canAsk` hides "Ask Uni" on the Today needs.
- `treeAlive.ts`: derived "in #room" notes use `roomOwnerPrefix` (a vault without room owners shows none). Same output for uni.
- `tree.css`: an empty foot (no composer) draws no rule.
- Task grouping: PR 2 already puts `room:*` owners under Others when `roomOwnerPrefix` is null (`isAgentOwner`); not duplicated, now covered by a test.

## Files
`src/areas/{AreasSurface,AreaView,TreeHome,TodayView,treeAlive}.ts(x)`, `tree.css`; tests `scripts/profile.test.ts`, `scripts/treehome.test.ts`, new `scripts/browser/chatOptional.spec.ts`, fixture options `profileNote` and `lifeVault` in `scripts/browser/areasFixture.ts`, new `playwright.chatoptional.config.ts` (`npm run test:chatoptional`, `CHATOPT_TEST_PORT`).

## Tests
- tsc clean. `npm test`: 416 ok, 0 FAIL.
- areas config: 330 passed, 10 skipped. composer (default config): 147 passed, 5 skipped. treehome: 24 passed, 3 skipped. chatoptional (new, 390×844 and 1600×1200): 6 passed.
- chatOptional spec: a non-uni vault with no profile note (pack defaults) and a uni vault whose note says chat null; asserts no TalkBar, "Open room/in", "Ask Uni", doors, ledger, steward line, "Room #", "held by #", "Stewarded by", `@Uni`, router line; no `post_message`/voice calls; and the uni profile still shows the talk bar.
- Screenshots (looked at): `scripts/browser/__shots__/chat-optional/{pack,note}-{home,level}-*.png`.
- Browser scratch-vault harness not run: `scratch-vault.ts` needs `packs add`, which `~/Code/parachute-vault` doesn't have (`Unknown command: packs`). I started it, cleaned up my own server and `/tmp` dir. `lifeosVault.spec.ts` unchanged.

## Gaps
- The app shell (`App.tsx`) loads the tab's initial room (`uni-room`, limit 300) once at start, before the surface reports no room. The spec allows exactly that one call and nothing from the surface (no ledger, recent line or node rooms). Closing it needs the shell to know the profile; not done.
- The uni vault renders at once with Uni's own profile, so a uni profile note with chat null only takes effect after discovery; surfaces and the first room load can precede it. Left so uni stays unchanged; no real case (uni is `buzz`).
- Task group heading "Rooms" and the root title "Uni" are unchanged.
- Test runs rewrote some tracked screenshots under `__shots__/t*`; not committed.
