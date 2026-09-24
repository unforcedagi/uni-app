# Talk to Uni — Android conversation client

**Status:** implementation target. This replaces the September 20 unified Buzz/Parachute timeline proposal. Aaron wants a small, Telegram-like app for talking to Uni, not a second Buzz desktop or a vault browser.

## Product contract

Open the app, see conversations, tap the Uni room, read newest messages, type a reply, and follow a thread without losing the room. Other joined Buzz channels are available, but the Uni conversation is the home screen. A note feed, task dashboard, workflow builder, and Parachute write UI do not belong in phase 1. The app is Aaron's personal client, never the Uni agent identity; only Aaron's key signs outbound events.

**Navigation:** room list (name, last message, timestamp, mention marker) → chronological message view → focused thread with root and replies; back preserves room and draft. On a narrow screen, one pane at a time; on desktop, the same React/Rust code can use a wider layout. Empty/loading/auth-rejected/offline states distinguish cached data from successful sync. No implicit background socket on Android: reconnect and catch up on open/resume/manual refresh. Drafts survive thread navigation in memory; durable drafts are later work.

**Compose:** text to an explicitly selected joined room; show the destination next to Send. Empty/oversized content is rejected. Replies use Buzz's NIP-10 `e` tags (root and immediate parent); include `p` tags for the parent author and explicitly selected recipients (plus self as Buzz expects). Do not infer a pubkey from arbitrary typed `@name`: ambiguous names must not silently wake the wrong agent. A phase-1 Uni quick-address may use a configured *public* Uni pubkey, but it must be explicit and visible before send. Relay `OK` is the success boundary; preserve draft and report rejection on error. Never copy Parachute private material into a Buzz send automatically.

**Read:** reuse `uni-core` NIP-42 connection and membership discovery; query kind 9 by `#h` for each joined room, persist idempotently to SQLite, cache kind 0 display names, and expose bounded room/thread queries through Tauri. Store reply root/parent from event tags during ingest; migrate existing local databases without dropping messages. Direct replies with a single `e` reply marker resolve to that event as root; nested replies carry root + reply markers. Unknown/late-arriving parents must not erase a child. Search remains local. Respect relay's 500-result cap and make partial history explicit; historical pagination is a follow-up.

**Voice:** phase 1 may offer native WebView microphone recording only when permission and a compatible upload path are proven. Buzz's relay rejects raw audio; desktop and mobile package it into a sanitized H.264/AAC MP4 envelope before Blossom upload. Do not send a dangling voice URL or claim voice support merely because `MediaRecorder` exists. Until packaging/upload and Android microphone permissions are tested on device, provide text compose and let the OS keyboard's speech-to-text handle dictation.

## Architecture and trust boundary

Tauri 2 hosts one React UI and `uni-core` Rust crate on Android and desktop. Rust owns signing keys and relay I/O; the webview receives public keys, messages, and statuses only. `UNI_NSEC` is a development-only override; desktop keyring works, but the `keyring` crate's Android fallback is nonpersistent, so **Android production sign-in requires Android Keystore-backed storage and a device-pairing flow**. Do not ship a production APK that generates a key into the mock backend or exposes nsec to JS. A debug APK without secure identity is a development artifact, not ready for Aaron's account. The relay currently requires membership; enroll the personal pubkey through an approved path, not by copying Uni's agent key.

The SQLite store resides in Tauri app data. Sync is connect → authenticate → discover → per-channel history since stored watermark → profiles → disconnect. All UI commands open the same database, with bounded results. The Rust send path signs a Buzz SDK kind-9 builder, waits for relay `OK`, then writes the accepted event to SQLite; a subsequent sync deduplicates it. Concurrent sync and send need serialized coordination or separate connections; no draft is cleared before acceptance. Android foreground refresh is sufficient for phase 1; push/wake while closed requires separate FCM/UnifiedPush server work.

## Phase 1 acceptance

1. A joined Uni room and other joined channels appear with cached last message, even offline; tapping one shows chronological messages and a visible sync/error state.
2. A reply opens a focused thread; direct and nested replies survive restart, and local legacy rows remain visible after migration.
3. Sending plain text and a thread reply uses the selected room, correct `h`/`e`/`p` tags, and only clears the draft after relay `OK`. Rejection leaves the draft and gives a useful error.
4. A mock-relay integration test exercises auth → discovery → read → publish → `OK` → stored thread, including rejection; Rust and TypeScript builds pass. On-device Android and real relay verification are separate gates and must be reported honestly.
5. Accessibility: labelled navigation, send and reply controls, keyboard submission without accidental newline loss, readable contrast and safe-area spacing.

## Later milestones

- **Identity/on-device:** Keystore + NIP-AB device pairing or another approved personal-key enrollment, APK install, real relay and Pixel/tablet test, on-resume sync.
- **Voice:** microphone permission, record and preview, native H.264/AAC MP4 packaging, signed Blossom upload and imeta/link, playback and failure/retry tests.
- **Notifications:** server-side push bridge/relay NIP-PL Android transport; a background Rust socket alone does not wake a closed app.
- **Polish:** older-page backfill, durable drafts/read marks, reactions, mention picker and profile updates, deep links, rate-limit recovery.

**Non-goals:** vault adapter, unified notes timeline, DMs, huddles, workflows, forum, agent administration. The previous dual-auth vault design is intentionally deferred; this is a conversation client first.
