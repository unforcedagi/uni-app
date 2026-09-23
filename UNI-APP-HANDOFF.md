# Uni app — handoff from Mac to uni-1 (2026-09-23)

Source was transferred as a complete Git bundle, **without** giving uni-1 general SSH access to the Mac. Checkout: `/home/uni/Code/uni-app`, commit `27ebbf1`, branch `main`. Source bundle: `/home/uni/uni-app-20260923.bundle`. Mac checkout was clean when inspected. `git bundle verify` succeeded on both machines; remote checkout reported `27ebbf1` with no uncommitted changes. There is no configured Git remote in the source checkout, so this is not yet backed by a hosted repository.

## What is implemented

- Rust `uni-core` and `uni-core-cli`: Buzz WebSocket/NIP-42, channel discovery/history, SQLite timeline and FTS5, profile cache, incremental sync, live subscriptions and reconnect. Tests exist for an in-process mock relay.
- Tauri 2 + Vite/React shell: *read-only* timeline via `get_timeline(limit)` from the local SQLite store. It shows channel, author, time, body, and mention highlighting. There is no compose/send, room/project navigation, thread deep links, or vault adapter.
- The `README.md` is stale: it says "no Tauri shell" despite commit `27ebbf1`. Use code as authority and update README before publishing a status.
- `uni-app-spec.md` and `uni-app-mobile.md` were not in Git, but were copied alongside this handoff into `/home/uni/Code/uni-app/` as untracked reference files. Preserve them before cleaning the checkout.

## Verified / not verified

- Source bundle verified on both machines; clone and clean checkout verified on uni-1.
- Linux tests **were run** with `/home/uni/.cargo/bin/cargo`. `cargo test --workspace --quiet` passed 15 unit tests and **8/9 integration tests**; `live_appends_new_events_after_eose_and_stops_cleanly` failed at `crates/uni-core/tests/mock_relay.rs:675`. Re-running that single test failed again, so this is a reproducible Linux failure, not a green suite. Investigate before claiming the app is ready. Earlier macOS work reported 24/24 and a desktop render; neither is a current Linux result.
- Real Buzz auth + sync from this app remain unproven. The earlier Mac-side probe received `restricted: not a relay member` for the app's personal key; do not copy a secret key from the Mac to bypass this. Use an approved relay-member enrollment or owner attestation.
- Linux GUI/Tauri build and desktop launch remain unverified.

## Next work

1. Read `uni-app-spec.md` and `uni-app-mobile.md` in this checkout as non-secret reference files; inspect for drift with the current Buzz/Hermes design.
2. Run `cargo test --workspace` in `/home/uni/Code/uni-app` with `~/Code/buzz` as a sibling checkout; fix failures. Build and launch Tauri on the Omarchy desktop.
3. Arrange supported membership/auth for the *app identity*, then run a real sync against `buzz.unforced.org` and check channel counts and timeline. Don't infer this from the mock tests.
4. Build the client Aaron actually wants: room/thread navigation and deep links first, then compose/mentions; define privacy before adding private vault data to shared rooms.
5. Decide a durable Git remote/backup for this repo before treating the Mac as disposable.

## Context boundaries

The old Mac vault and macOS shell are not authoritative for current Parachute state. Avoid general SSH from uni-1 into the Mac: use scoped, audited copies of files/artifacts when needed. The authenticated techne vault access problem is separate; don't treat network/SSH access as Parachute admin authority.
