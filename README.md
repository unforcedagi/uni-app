# uni-app — Talk to Uni

An Android-first, Telegram-like Buzz conversation client. The product contract and release gates are in [`uni-app-spec.md`](uni-app-spec.md). This is a shared React/Tauri 2 shell over a Rust core; the CLI remains useful for development and relay diagnosis.

## What works in this branch

- Home is your rooms, newest first (since 0.4.0). A row shows the room's last line; a soft dot and a live line while a worker is moving there; and what wants you there, with its buttons inline. Approval cards about to expire are pinned on top with a countdown.
- A room is its chat with a thin strip under the head: what is moving (tap for the run's story) and what waits on you. Asks are messages in the room, with buttons.
- Every "waits on you" opens to its context (0.4.x): its next action, why now, its default and its note's body (Why, Steps, Links, Time) with live links. Its buttons go by kind: do → Done (back to its room for any follow-up) and Not now; choose → its options and Not now; look → Open and Seen; tell → Seen; and Archive on every ask. Seen and Not now record that you're aware of one (`seen_at`, `seen_by`).
- The bar (Rooms, Journal, Applets, Settings) shows everywhere on a phone, in a room too; it steps aside only while the keyboard is up. Settings opens from it, with Claude usage first.
- Journal is its own place. The Applets drawer opens the vault's applets (Arcade, Studio, To Post, Recipes, Calendar, Vault) and the doors (Mail, Messages), each with its count. Recipes is a slot that says it isn't built yet. A vault note tagged `applet` joins the drawer as a sealed applet, which asks before it runs (`src/shape/SealedApplet.tsx`). Arcade's "look here" links open in the app, on the pinned card.
- Search starts where you are: matches are grouped by place, other places with matches are listed apart, and nothing found offers Ask Uni.
- For you, the task and work lists, the areas tree, the cards and projects views and the All stream are gone (0.4.0): asks are messages in their room, and each room's strip says what is moving and what waits.
- One reader (since 0.4.0): asks, runs and most of the vault's lists are read through `src/vault/reader.ts` on one poller (the To Post count keeps its own slow timer), so the app reads the vault less often.
- Screens over the air (since 0.4.0, Android): a release that changes only the screens ships as a signed bundle after one tap, at most one a day, with no new APK. The app takes it at the next start or on coming back after two minutes or more away; Settings says which screens are running. `SHELL_API` (`src/ota.ts`, `src-tauri/src/ota.rs`) names what the screens need from the shell (`docs/release.md`).
- Cards on time (since 0.3.7): while the app is open, a sealed card waiting for a tap shows even when a read fails or the connection drops (every read's answer counts, a failed read or sync is retried). The Android release is signed by the sealed broker only after the owner approves one card (`docs/release.md`; the Mac updater signature is not behind it yet).
- Chronological cached messages, focused root/reply threads, per-room public-key recipient, text compose, manual/on-resume sync and explicit error states.
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

## Pairing a device

Every device uses the **same Buzz identity**. Talk to Uni receives it from Buzz desktop with NIP-AB device pairing (the app is the *target*; protocol crypto comes from `buzz-core`):

1. On the computer: Buzz → Settings → **Pair mobile device**, then **Copy** the `nostrpair://…` link.
2. Get the link onto the phone/tablet (e.g. shared clipboard, or a note to yourself), open Talk to Uni and paste it into **Pair with Buzz desktop** → **Start**.
3. Compare the 6-digit codes. Tap **Codes match** here *and* confirm in Buzz. If they differ, tap Cancel (the source is told `sas_mismatch`).

The key travels NIP-44-encrypted between ephemeral session keys over the pairing relay named in the link (session expires after 120 s). On arrival its pubkey is checked against the payload and the relay URL must be public `https`/`wss`. Storage: on **Android** it is encrypted with a non-exportable AES-256-GCM key in Android Keystore (alias `uni_identity`, in-app `KeystorePlugin.kt`); only ciphertext + IV are written, to private prefs. On **desktop** it goes to the OS keyring (`uni-app`/`nsec`). The secret is never logged or passed to JavaScript. Settings (⚙) → **Forget this device key** deletes it, along with the local cache.

Driver: `crates/uni-core/src/pairing.rs`. Tests: `pairing_e2e` in `crates/uni-core/tests/mock_relay.rs` run buzz-core's source role against it.

## Release gates — not yet done

Before using a personal account, check relay membership. Never put an nsec in the JavaScript or in an APK environment variable. The old debug-only plaintext `dev-nsec` fallback has been removed.

Raw microphone audio is not a supported Buzz voice note: native MP4 packaging, signed media upload, permission and device tests are deferred. Android keyboard speech-to-text can fill the text composer now. History is bounded (500 fetched per channel per sync, 300 displayed per room/thread); older-page backfill is not implemented. No real-relay publish or Pixel/tablet smoke test is claimed by this branch.

The previous core exploration and relay findings remain in [`UNI-APP-HANDOFF.md`](UNI-APP-HANDOFF.md). The `android` worktree/build effort is separate from the `talk-to-uni` branch.
