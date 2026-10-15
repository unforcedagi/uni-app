# REPORT: T-137 step 1, the app survives the tailnet rename uni-1 → uni

Commit `7b6846d` on `feat/simple`, not pushed. It ships in 0.1.46. The default hub stays `uni-1`.

## What changed
- **One alias table:** `crates/uni-core/src/hub.rs`, `HUB_ALIASES`, holds the pair `https://uni-1.taildf9ce2.ts.net` ↔ `https://uni.taildf9ce2.ts.net`.
  - Either side may be the configured hub.
  - Cleanup after the rename means deleting that one pair.
  - `UNI_HUB_ALIASES=from=to[,…]` adds pairs for a scratch run only. A shipped install never sets it.
- **Hub requests (`VaultClient`)** go to the configured hub first.
  - On a DNS or connection failure (`reqwest::Error::is_connect`) the client retries once on the alias. The retry is signed again for that host, because the NIP-98 `u` tag names the host.
  - An HTTP answer is never retried on the alias, including 401 and 500.
  - When the alias answers, requests stay on it, and the client calls `on_hub_switch`. The app (`remember_hub` in `src-tauri/src/lib.rs`) then writes that origin to `vault.json`, so later launches go straight there.
  - Upload tickets and the note view's "Open in Parachute" URL follow the current origin.
- **Transcription** derives from the hub's host: same scheme and host, port 8445, `/transcribe` (`hub::transcribe_url`).
  - `TRANSCRIBE_URL` is gone.
  - `voice_transcribe` uses `transcribe_on_hub`, with the same one-time fallback, and remembers the alias the same way.
- **Links:** `journal_config` also returns `hub_origins` (the hub and its alias, from the same table). `sameHub(ref, hub, aliases)` treats a link on either name as this hub, so old `uni-1` links in notes keep opening in-app after the rename.
- **The setting stays visible:** Journal settings shows the hub as it is now. That is `uni-1` today, or `uni` once the app has switched. `DEFAULT_HUB` stays `uni-1` until step 3.

## Specs
- `hub.rs`:
  - transcription follows the hub host;
  - `uni-1` and `uni` alias each other, either way round;
  - `uni-2`, another scheme and another port are not aliases;
  - the UI gets both origins;
  - scratch pairs parse.
- `parachute.rs` (`surface_tests`):
  - `t137_a_hub_name_that_does_not_resolve_…`: the configured hub `https://uni-t137-gone.invalid` fails real DNS. The client falls back to a local scripted hub, is told once, and the next call goes straight there.
  - `t137_a_refused_connection_falls_back_too`.
  - `t137_an_http_error_is_an_answer_never_a_fallback`: for 401 and 500, the alias listener is never contacted and nothing is remembered.
  - `t137_neither_name_answers_…`: the error names the configured host, and the client stays on it.
  - `t137_the_built_in_alias_is_uni_1_and_uni`, which also checks that `uni-2` has no alias.
- `transcribe.rs`:
  - the URL derives from the hub host;
  - an unresolvable host falls back to the alias once and reports it;
  - 401 and 500 never fall back.
- `scripts/vaultlinks.test.ts`: links on both names are this hub, whether `uni-1` or `uni` is configured. `uni-2` and an `http://` origin stay foreign. Without the alias list, only the configured name counts.
- Suites at `7b6846d`:
  - `tsc` clean;
  - `npm test` passes;
  - `cargo test -p uni-core --offline`: 110 + 1 + 22 passed;
  - simple Playwright: 516 passed, 47 skipped, 1 failed. The failure was `r20 › the narrow companion's sheet is a foreground surface` on phone. It passed 15 of 15 on `--repeat-each=5` and touches nothing in this change, so it is flaky.
- `vault-links` (Playwright) was not run. It was known to fail before.

## The real check: not done
- The brief's check needs the scratch hub `127.0.0.1:19390`, which is down. It stopped at 19:27:53 when the first r24 worker was stopped, and no unit is left. The rules say not to start hubs, so the real app was **not** run against an unresolvable alias.
- What is proven instead is the client path the app uses, against **real DNS**. The `.invalid` name fails resolution on this machine, and the same `VaultClient` falls back and reports the switch.
- `remember_hub` (writing `vault.json`) compiles, but it has run only through the callback in specs. Its file write has not run in the real app.
- **For the room, once a scratch hub is up:**
  1. Write `{"hub":"https://uni-t137-gone.invalid","vault":"uni"}` to the scratch app home's `vault.json`.
  2. Launch the app with `UNI_HUB_ALIASES=https://uni-t137-gone.invalid=http://127.0.0.1:19390`.
  3. Check that Uni's home and a note load.
  4. Check that `vault.json` now reads `http://127.0.0.1:19390`.

## Still naming `uni-1` in the app, and why
- `DEFAULT_HUB` (`src-tauri/src/lib.rs`): stays until step 3, by the brief's order.
- `HUB_ALIASES` (`hub.rs`): the alias pair itself.
- `transcribe_probe` example: its default hub argument, used only for a manual probe.
- `SHORTHAND_VAULTS` in `src/vaultlinks.ts` lists `uni-1` as a **vault name** (the unused `uni-1` vault), not a host. The rename doesn't affect it.
- Doc comments and tests.

## For step 2 (configs), found while checking
- **The transcription server pins its URL.** In `~/.local/share/uni/transcribe/server.py`, `PUBLIC_URL` defaults to `https://uni-1.taildf9ce2.ts.net:8445/transcribe` (env `UNI_TRANSCRIBE_URL`), and it rejects any NIP-98 `u` tag that isn't exactly that.
  - Before the rename this is harmless, because devices stay on `uni-1`.
  - After it, a device that has switched to `uni` signs for `uni`, and the server would answer 401. A 401 is an answer, so there is no fallback.
  - Step 2 should make the server accept both URLs before step 3.
- **The hub accepts either name.** It rebuilds the expected `u` from the request's own Host (`parachute-hub/src/nostr-http-auth.ts`, `requestAbsoluteUrl`), so it accepts `uni` as soon as Tailscale serves that name. Its `expose-state.json` still says `canonicalFqdn`/`hubOrigin` `uni-1`, which is step 2's to change.
- Neither file was changed (read only).
