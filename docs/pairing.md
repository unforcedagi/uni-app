# Pair a device

On a signed-in Uni device, open Settings → **Pair a device** and unlock using
the system prompt. On the new device's first-run Pair screen, scan the QR
(Android) or paste its link (all platforms). Compare all six digits on both
devices and choose **Codes match** on both. A mismatch should be rejected using
**They're different**. The source reports success only after the receiving
peer sends a successful protocol completion.

A device that already has an identity cannot receive a replacement through
Settings. **Forget this device key** first if that is intended.

## Security model

- The six-digit SAS is the pairing passcode: compare it visually on both devices.
  Possession of the QR alone is not approval to transfer the identity. Each side
  requires an explicit confirmation. Do not approve a code you have not compared.
- The source command enforces a fresh native device unlock in Rust for every
  start. JavaScript cannot supply an `authenticated` boolean. macOS uses
  LocalAuthentication's device-owner policy (Touch ID or system password), off
  the main thread, with a 60-second cap. Android API 30+ uses strong biometrics
  or device credentials. API 24–29 uses the system PIN/pattern/password prompt;
  it avoids the unsupported strong-biometric-or-credential combination on those
  versions. A device without a secure screen lock must set one first.
- The QR and copied link contain a fresh ephemeral session secret. Share only
  with the intended device; do not paste into public chat or logs. Uni never
  copies automatically. The clipboard is not cleared automatically.
- The session expires no later than 120 seconds after successful unlock,
  including relay discovery/connection time. The native actor enforces expiry
  even if the screen is backgrounded. Close, Cancel, mismatch, or a new start
  cancels the old source session. Generation IDs fence stale UI calls; the
  target session is separate. Cancelling after transfer has begun cannot revoke
  a key the peer already received.
- Buzz's NIP-AB protocol library provides ephemeral ECDH, encrypted events,
  transcript verification, event validation and duplicate rejection. Identity
  plaintext is kept in zeroizing Rust buffers and never returned to JavaScript.
  The native target stores it in Android Keystore or the desktop keyring.
- NIP-42 uses the ephemeral session identity. The subscription reaches EOSE
  before advertising the QR or sending the target offer. Relay discovery uses
  NIP-11 `pairing_relay_url`, then the NIP-43 legacy `/pair` path, then the main
  relay. Discovery has a five-second timeout and a 64 KiB body limit. Account
  relay URLs in the Custom identity payload retain the target's existing
  HTTPS/WSS and public-host validation.

## Supported directions

Uni supports Mac → Android, Android → Android (including Daylight DC-1),
Android → Mac, and Mac → Mac. Android can scan or paste; Mac can paste.
Buzz desktop → Uni remains supported. Uni source → Buzz mobile/CLI is supported
by NIP-AB. Buzz desktop has no plain **receive identity** target mode: its
recovery mode is a different flow, so Uni source → Buzz desktop is unsupported.
Linux and Windows can receive by pasting, but exporting is unavailable because
native device unlock is not implemented. The button explains this limitation.
For headless development only, debug builds accept `UNI_PAIR_NO_UNLOCK=1`;
the bypass code is compiled out of release builds. iOS source is unsupported.

Android scanning uses the official Tauri barcode-scanner plugin, QR-only and
full-screen. It asks for Camera access on use, explains denial, and retains
paste as a fallback. Camera hardware is optional. TauriActivity already inherits
AppCompatActivity through WryActivity, so the native BiometricPrompt needs no
MainActivity superclass change.

## Verification

Run `scripts/pair-interop.sh` with Python 3.11+, this repo and `~/Code/buzz` present (or set
`BUZZ_DIR`). It builds/runs `uni-core/examples/pair_interop.rs`, Buzz's pairing
CLI and the local pairing relay. Cases 1–3 test Uni → Uni, Uni → CLI and CLI →
Uni. Each case generates a throwaway key, compares the SAS before feeding stdin
approval, and verifies the received public key. CLI secret output is captured
only in Python variables; source QR links travel through a private FIFO or
captured CLI output, never the terminal or log files. A connection/auth/EOSE
probe gates the same three cases against `wss://pairing.buzz.xyz`; an unreachable
live relay is explicitly skipped. No existing account key or keyring is used.

The reference CLI's current standalone dependency graph has no rustls crypto
provider and panics on WSS. The harness compiles its original `main.rs` through
an ephemeral Cargo manifest that preserves its dependencies and adds the
`rustls/ring` provider, then uses `cargo run -p buzz-pairing-cli` with that
manifest. It copies the reference lockfile and reuses build artifacts. No Buzz
source or manifest is edited; this build-only workaround is announced in the
output. Local tests also exercise the same CLI build.

The driver accepts `source`, `target`, `pubkey` and `probe` modes. Inputs are
`UNI_PAIR_KEY` (throwaway hex/nsec), `UNI_PAIR_RELAY`, `UNI_PAIR_URI` (target),
and `UNI_PAIR_URI_PIPE` (source-owned harness FIFO). Source and target require
`yes` on stdin after displaying the SAS; they never print secret inputs.

Native validation still requires hardware: macOS Touch ID/password in a signed
release; Android biometric, credential-only, no-lock, denial, cancellation,
background/expiry, and QR scanning on Pixel and Daylight. A successful Linux
build or headless interop run does not establish these hardware results.

API references: [Tauri scanner](https://v2.tauri.app/plugin/barcode-scanner/),
[Android authentication](https://developer.android.com/identity/sign-in/biometric-auth),
[Apple LocalAuthentication](https://developer.apple.com/documentation/localauthentication/lacontext/evaluatepolicy(_:localizedreason:reply:)).

Verified on 2026-10-01: TypeScript, frontend tests, Vite production build, 102
uni-core tests, strict uni-core Clippy, Tauri check, the native generation-fence
test, and the Android aarch64 debug APK build passed. All three interop cases
passed locally and against the live relay, with matching SAS and received public
keys; the CLI used the TLS provider manifest described above. The macOS
LocalAuthentication branch also cross-checked against the Apple Silicon Rust
target in an isolated API-check crate. Full signed macOS packaging and physical
Touch ID/password, Pixel/Daylight authentication, and camera scanning remain
unverified. Vite chunk-size and upstream Gradle/Kotlin deprecation warnings
remain.
