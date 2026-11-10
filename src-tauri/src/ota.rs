//! T-335 (from the T-305 spike): the app's screens (the Vite `dist/`) delivered over the air, so an APK is needed only
//! when the Rust shell changes.
//!
//! - **Shell API.** The shell's commands are its contract with the screens. [`SHELL_API`] names that contract; it must
//!   change whenever a command is added, removed or changes shape (`scripts/shellApi.test.ts` fails the build
//!   otherwise). A bundle declares the API it was built against (`uni-bundle.json` inside the archive, and the signed
//!   manifest); the shell serves it only when the two are equal, and the bundle's own code checks again at boot
//!   (`src/ota.ts`): on a mismatch it doesn't start and asks to be dropped (`ota_refused`, only while on trial).
//! - **Trust.** The channel publishes `web.json`: a manifest and its Ed25519 signature, made by the sealed broker only
//!   after the owner's tap (uni-ops `sealed/bundle.py`). The public key is compiled in ([`PUBKEY_HEX`]); nothing from
//!   the channel or the webview can change it. The manifest names the archive by SHA-256 and size, the version and the
//!   API, when it was issued and when it expires. The signature and the archive's hash are checked when a bundle is
//!   downloaded and again at every launch, before a byte of it is served.
//! - **Replay.** A manifest is taken only before it expires, and only if it was issued no earlier than the newest one
//!   this device has taken; a bundle is fetched only if it is newer than anything the device has run (the floor). So
//!   the channel (or anyone who can serve its address) can't hold a device on, or send it back to, an old signed
//!   bundle, and a device that lost its state accepts only a manifest signed in the last [`MAX_VALID_DAYS`] days.
//! - **Serving.** [`OtaAssets`] wraps the assets built into the binary. With a verified bundle active it serves the
//!   bundle's files instead, on the same `tauri://` origin, so IPC, capabilities and CSP are unchanged.
//! - **Updating.** A check (by the shell a few seconds after launch, and by the screens when the app comes back to the
//!   foreground) downloads a newer bundle into
//!   `next.*`. It is applied at the next launch, or when the app next comes back to the foreground (the page reloads
//!   then, before the user has done anything). A new bundle is on trial until its page reports ready (`ota_ready`); one
//!   that is started [`MAX_UNCONFIRMED_BOOTS`] times without doing so is dropped and never fetched again.
//! - **Fallback.** The last bundle that reported ready is kept as `previous.*`. When the current one is dropped, the
//!   app goes back to it; with none, to the screens built in.
//! - **Versions.** A bundle carries a release version (`0.3.8`). It is used only while it is newer than the screens
//!   built into the app, so installing a newer APK always wins over an older bundle.
//!
//! Android builds look at the release channel ([`CHANNEL`]); desktop builds don't (the Mac app has its own updater).
//! `UNI_OTA_CHANNEL` and `UNI_OTA_PUBKEY` at build time point a test build at a local channel and a test key; the
//! release scripts refuse to build with either set.

use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::Digest as _;
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Manager, Runtime};

/// The shell's command API, as seen by the screens. Bump it with any change to the command set or a command's
/// arguments or result. `src/ota.ts` holds the same number, and `src-tauri/shell-api.txt` the commands it stands for
/// (both checked by `scripts/shellApi.test.ts`).
pub const SHELL_API: u32 = 1;

/// The public half of the sealed screens bundle key (uni-ops `sealed/bundle.py` PUBKEY_HEX), raw Ed25519, hex.
const RELEASE_PUBKEY_HEX: &str = "7eb47a945c28f019c78ea8691d19337f672261e10cff4e9abdfdbecbaec0330f";
pub const PUBKEY_HEX: &str = match option_env!("UNI_OTA_PUBKEY") {
    Some(k) => k,
    None => RELEASE_PUBKEY_HEX,
};

/// Where this build looks for bundles, if anywhere.
pub const CHANNEL: Option<&str> = match option_env!("UNI_OTA_CHANNEL") {
    Some(c) => Some(c),
    None if cfg!(target_os = "android") => Some("https://github.com/unforcedagi/uni-app/releases/latest/download/web.json"),
    None => None,
};

/// What the broker prefixes to the manifest before signing it (bundle.py DOMAIN).
const DOMAIN: &[u8] = b"uni-ota-manifest-v1\n";
const PACKAGE: &str = "org.unforced.uni";
/// The longest a manifest may be valid (bundle.py VALID_DAYS_MAX, plus a day of slack for clocks).
pub const MAX_VALID_DAYS: u64 = 31;
/// A bundle started this many times without reporting ready is dropped.
pub const MAX_UNCONFIRMED_BOOTS: u32 = 3;

const META_FILE: &str = "uni-bundle.json";
const MAX_CHANNEL_BYTES: u64 = 16 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
/// How long a page request waits for the bundle to be chosen at launch before using the built-in one.
const SETUP_WAIT: Duration = Duration::from_secs(5);

fn log(msg: impl AsRef<str>) {
    let msg = msg.as_ref();
    tracing::info!(target: "ota", "{msg}");
    // Android sends stderr to logcat (RustStdoutStderr); tracing has no subscriber there.
    #[cfg(mobile)]
    eprintln!("[ota] {msg}");
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn hex32(s: &str) -> Option<[u8; 32]> {
    let b = s.as_bytes();
    if b.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, pair) in b.chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(out)
}

fn sha256_hex(data: &[u8]) -> String {
    sha2::Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// What a bundle says about itself, inside the signed archive.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Meta {
    pub version: String,
    pub api: u32,
}

/// The signed manifest (bundle.py `manifest_bytes`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub v: u32,
    pub app: String,
    pub version: String,
    pub api: u32,
    pub archive: String,
    pub sha256: String,
    pub bytes: u64,
    pub commit: String,
    pub issued: u64,
    pub expires: u64,
}

/// The channel file, `web.json`: the manifest's exact signed text and its signature.
#[derive(Deserialize)]
struct ChannelFile {
    manifest: String,
    sig: String,
}

/// A channel file whose signature checks out with `pubkey`: the manifest, read strictly.
pub fn verify_channel(pubkey: &str, text: &[u8]) -> Result<Manifest, String> {
    let key = hex32(pubkey).ok_or("no bundle key is built into this app")?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&key).map_err(|_| "the built-in bundle key is malformed")?;
    let file: ChannelFile = serde_json::from_slice(text).map_err(|e| format!("channel file: {e}"))?;
    let sig = base64::engine::general_purpose::STANDARD.decode(file.sig.trim()).map_err(|e| format!("signature: {e}"))?;
    let sig = ed25519_dalek::Signature::from_slice(&sig).map_err(|_| "signature: not an Ed25519 signature")?;
    let mut msg = DOMAIN.to_vec();
    msg.extend_from_slice(file.manifest.as_bytes());
    key.verify_strict(&msg, &sig).map_err(|_| "signature does not match the built-in key".to_string())?;
    let m: Manifest = serde_json::from_str(&file.manifest).map_err(|e| format!("manifest: {e}"))?;
    if m.v != 1 || m.app != PACKAGE {
        return Err(format!("manifest is for {} v{}, not this app", m.app, m.v));
    }
    semver::Version::parse(&m.version).map_err(|e| format!("manifest version: {e}"))?;
    if m.archive != format!("web-{}.tar.gz", m.version) || m.sha256.len() != 64 || hex32(&m.sha256).is_none() {
        return Err("manifest: archive name or hash malformed".into());
    }
    if m.expires <= m.issued || m.expires - m.issued > MAX_VALID_DAYS * 86400 {
        return Err("manifest: validity window malformed".into());
    }
    Ok(m)
}

/// A manifest is fetched and staged only while it is valid.
pub fn fresh(m: &Manifest, now: u64) -> Result<(), String> {
    if now >= m.expires {
        return Err(format!("manifest for {} expired", m.version));
    }
    Ok(())
}

/// A verified, unpacked bundle.
pub struct Bundle {
    pub meta: Meta,
    pub manifest: Manifest,
    pub version: semver::Version,
    files: HashMap<String, Vec<u8>>,
}

impl std::fmt::Debug for Bundle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Bundle").field("meta", &self.meta).field("files", &self.files.len()).finish()
    }
}

impl Bundle {
    pub fn get(&self, path: &str) -> Option<&[u8]> {
        self.files.get(path.trim_start_matches('/')).map(Vec::as_slice)
    }
}

/// Unpacks a `.tar.gz` into memory. Only regular files with plain relative paths; anything else fails the bundle.
pub fn unpack(archive: &[u8]) -> Result<(Meta, HashMap<String, Vec<u8>>), String> {
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    let mut files = HashMap::new();
    let mut total = 0u64;
    for entry in tar.entries().map_err(|e| format!("archive: {e}"))? {
        let mut entry = entry.map_err(|e| format!("archive: {e}"))?;
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            continue;
        }
        if !kind.is_file() {
            return Err("archive: only regular files are allowed".into());
        }
        let path = entry.path().map_err(|e| format!("archive: {e}"))?.into_owned();
        let mut parts = Vec::new();
        for c in path.components() {
            match c {
                std::path::Component::Normal(p) => parts.push(p.to_str().ok_or("archive: path is not UTF-8")?.to_string()),
                std::path::Component::CurDir => {}
                _ => return Err(format!("archive: unsafe path {}", path.display())),
            }
        }
        if parts.is_empty() {
            return Err("archive: empty path".into());
        }
        total += entry.size();
        if total > MAX_UNPACKED_BYTES || files.len() >= MAX_FILES {
            return Err("archive: too large".into());
        }
        let mut bytes = Vec::with_capacity(entry.size().min(MAX_UNPACKED_BYTES) as usize);
        entry.read_to_end(&mut bytes).map_err(|e| format!("archive: {e}"))?;
        if files.insert(parts.join("/"), bytes).is_some() {
            return Err("archive: a path appears twice".into());
        }
    }
    let meta: Meta = serde_json::from_slice(files.get(META_FILE).ok_or("archive: no uni-bundle.json")?)
        .map_err(|e| format!("uni-bundle.json: {e}"))?;
    if !files.contains_key("index.html") {
        return Err("archive: no index.html".into());
    }
    Ok((meta, files))
}

/// Verifies a stored or downloaded bundle (its channel file's signature, then the archive against the manifest),
/// unpacks it and checks it fits this shell: the same API, and newer than the built-in screens. Expiry is not checked
/// here: a bundle that was fresh when it was fetched stays usable.
pub fn open(pubkey: &str, channel: &[u8], archive: &[u8], builtin: &semver::Version, shell_api: u32) -> Result<Bundle, String> {
    let manifest = verify_channel(pubkey, channel)?;
    if archive.len() as u64 != manifest.bytes || sha256_hex(archive) != manifest.sha256 {
        return Err(format!("archive for {} is not the one its signed manifest names", manifest.version));
    }
    let (meta, files) = unpack(archive)?;
    if meta.version != manifest.version || meta.api != manifest.api {
        return Err(format!("archive says {} for API {}, its manifest {} for API {}", meta.version, meta.api, manifest.version, manifest.api));
    }
    let version = semver::Version::parse(&meta.version).map_err(|e| format!("uni-bundle.json version: {e}"))?;
    if meta.api != shell_api {
        return Err(format!("bundle {} needs shell API {}, this shell has {shell_api}", meta.version, meta.api));
    }
    if version <= *builtin {
        return Err(format!("bundle {} is not newer than the built-in screens {builtin}", meta.version));
    }
    Ok(Bundle { meta, manifest, version, files })
}

/// The bundle directory's bookkeeping (`state.json`).
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct State {
    /// The version on trial: promoted, not yet reported ready.
    pub trial: Option<String>,
    /// Launches of the trial version so far.
    pub boots: u32,
    /// Versions dropped here (failed checks, never ready, refused this shell). Never fetched again.
    pub rejected: Vec<String>,
    /// The newest version ever promoted here. Nothing that isn't newer is fetched or promoted again, even if it is
    /// signed and the bundle that set the floor is gone: a channel can't roll a device back to an old bundle.
    pub floor: Option<String>,
    /// The newest manifest `issued` time taken here. An older manifest is never taken again.
    pub issued: u64,
}

impl State {
    /// The state, failing closed: an unreadable `state.json`, or bundles on disk with no `state.json`, is an error,
    /// because a lost floor would let an older signed bundle back in.
    fn load_checked(dir: &Path) -> Result<State, String> {
        match std::fs::read(dir.join("state.json")) {
            Ok(b) => {
                let state: State = serde_json::from_slice(&b).map_err(|e| format!("state.json unreadable: {e}"))?;
                match &state.floor {
                    Some(f) if semver::Version::parse(f).is_err() => Err(format!("state.json floor {f:?} is not a version")),
                    _ => Ok(state),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if SLOTS.iter().any(|s| dir.join(format!("{s}.tar.gz")).exists()) || dir.join("floor").exists() {
                    Err("bundles or a floor on disk but no state.json".into())
                } else {
                    Ok(State::default())
                }
            }
            Err(e) => Err(format!("state.json: {e}")),
        }
    }
    /// Written whole and synced, then renamed into place. False if it couldn't be: the caller doesn't act on it.
    fn save(&self, dir: &Path) -> bool {
        fn put(path: &Path, bytes: &[u8]) -> bool {
            let tmp = path.with_extension("tmp");
            let ok = std::fs::File::create(&tmp)
                .and_then(|mut f| std::io::Write::write_all(&mut f, bytes).and_then(|_| f.sync_all()))
                .and_then(|_| std::fs::rename(&tmp, path));
            ok.is_ok()
        }
        // The floor is also kept on its own (`floor`: "<version> <issued>"), so damage to state.json alone can't lose it.
        let floor_ok = match &self.floor {
            Some(f) => {
                let line = format!("{f} {}", self.issued);
                std::fs::read_to_string(dir.join("floor")).is_ok_and(|now| now == line) || put(&dir.join("floor"), line.as_bytes())
            }
            None => true,
        };
        floor_ok && put(&dir.join("state.json"), &serde_json::to_vec(self).unwrap_or_default())
    }
    fn floor(&self) -> Option<semver::Version> {
        self.floor.as_deref().and_then(|v| semver::Version::parse(v).ok())
    }
    fn reject(&mut self, version: &str) {
        if !self.rejected.iter().any(|v| v == version) {
            self.rejected.push(version.to_string());
        }
        if self.trial.as_deref() == Some(version) {
            self.trial = None;
            self.boots = 0;
        }
    }
}

/// A slot's two files, in the order they are written and moved: the channel file, then the archive. A slot whose archive
/// exists has its channel file. A check writes `next.<ext>.tmp`, then renames each to `next.<ext>`.
const PARTS: [&str; 2] = ["json", "tar.gz"];

/// `next`: staged by a check. `current`: being served (or on trial). `previous`: the last one that reported ready.
const SLOTS: [&str; 3] = ["next", "current", "previous"];

fn read_slot(dir: &Path, slot: &str) -> Option<(Vec<u8>, Vec<u8>)> {
    let channel = std::fs::read(dir.join(format!("{slot}.json"))).ok()?;
    let archive = std::fs::read(dir.join(format!("{slot}.tar.gz"))).ok()?;
    Some((channel, archive))
}

fn remove_slot(dir: &Path, slot: &str) {
    let _ = std::fs::remove_file(dir.join(format!("{slot}.tar.gz")));
    let _ = std::fs::remove_file(dir.join(format!("{slot}.json")));
}

/// Moves a slot's two files over another's. The archive moves last: a slot whose archive exists has its channel file.
fn move_slot(dir: &Path, from: &str, to: &str) -> bool {
    remove_slot(dir, to);
    std::fs::rename(dir.join(format!("{from}.json")), dir.join(format!("{to}.json"))).is_ok()
        && std::fs::rename(dir.join(format!("{from}.tar.gz")), dir.join(format!("{to}.tar.gz"))).is_ok()
}

/// A slot's version, from its signed channel file, if both its files are there.
fn slot_version(dir: &Path, slot: &str, pubkey: &str) -> Option<semver::Version> {
    if !dir.join(format!("{slot}.tar.gz")).exists() {
        return None;
    }
    let text = std::fs::read(dir.join(format!("{slot}.json"))).ok()?;
    semver::Version::parse(&verify_channel(pubkey, &text).ok()?.version).ok()
}

/// The staged bundle's version (a few KB read; the archive isn't unpacked for this).
fn staged_version(dir: &Path, pubkey: &str) -> Option<semver::Version> {
    slot_version(dir, "next", pubkey)
}

/// After a kill mid-way: finish a slot move that was cut between its two renames (the channel file moves first), then
/// drop what is left half: a slot with one of its two files, and a check's temporary files.
fn tidy(dir: &Path) {
    let has = |slot: &str, ext: &str| dir.join(format!("{slot}.{ext}")).exists();
    for (from, to) in [("next", "current"), ("current", "previous"), ("previous", "current")] {
        if has(from, "tar.gz") && !has(from, "json") && has(to, "json") && !has(to, "tar.gz") {
            let _ = std::fs::rename(dir.join(format!("{from}.tar.gz")), dir.join(format!("{to}.tar.gz")));
        }
    }
    for slot in SLOTS {
        if has(slot, "json") != has(slot, "tar.gz") {
            remove_slot(dir, slot);
        }
    }
    for ext in PARTS {
        let _ = std::fs::remove_file(dir.join(format!("next.{ext}.tmp")));
    }
}

/// Version a stored archive claims, for bookkeeping when it fails its checks (best effort, unverified).
fn claimed_version(archive: &[u8]) -> Option<String> {
    unpack(archive).ok().map(|(m, _)| m.version)
}

/// At launch (and when a staged bundle is applied on resume): promote a staged bundle, then pick the bundle to serve:
/// the current one, else the last good one, else none (the built-in screens). Every failure falls back and is logged.
pub fn activate(dir: &Path, pubkey: &str, builtin: &semver::Version, shell_api: u32) -> Option<Bundle> {
    let mut state = match State::load_checked(dir) {
        Ok(s) => s,
        Err(e) => {
            // Start over without the bundles, keeping the newest version they claim as the floor (unverified, so it
            // can only make the floor stricter), and the newest issued time any of their signed manifests has.
            let kept = std::fs::read_to_string(dir.join("floor")).ok();
            let mut words = kept.as_deref().unwrap_or("").split_whitespace();
            let (kept_floor, kept_issued) = (words.next().map(str::to_string), words.next().and_then(|w| w.parse::<u64>().ok()));
            let slots: Vec<_> = SLOTS.iter().filter_map(|s| read_slot(dir, s)).collect();
            let floor = slots
                .iter()
                .filter_map(|(_, a)| claimed_version(a))
                .chain(kept_floor)
                .filter_map(|v| semver::Version::parse(&v).ok())
                .max();
            let issued = slots
                .iter()
                .filter_map(|(c, _)| verify_channel(pubkey, c).ok().map(|m| m.issued))
                .chain(kept_issued)
                .max()
                .unwrap_or(0);
            log(format!("{e}; dropping installed bundles, built-in screens {builtin}"));
            SLOTS.iter().for_each(|s| remove_slot(dir, s));
            State { floor: floor.map(|v| v.to_string()), issued, ..State::default() }.save(dir);
            return None;
        }
    };
    tidy(dir);
    if let Some((channel, archive)) = read_slot(dir, "next") {
        // A promotion a kill cut short after it was recorded: the state already has this version on trial, as the floor.
        let unfinished = |b: &Bundle| state.trial.as_deref() == Some(b.meta.version.as_str()) && state.floor().as_ref() == Some(&b.version);
        match open(pubkey, &channel, &archive, builtin, shell_api).and_then(|b| match state.floor() {
            _ if unfinished(&b) => Ok(b),
            Some(f) if b.version <= f => Err(format!("bundle {} is not newer than {f}, already used here", b.meta.version)),
            _ if b.manifest.issued < state.issued => Err(format!("manifest for {} is older than one already taken", b.meta.version)),
            _ => Ok(b),
        }) {
            Ok(b) => {
                // In an order a kill at any point can resume from: (1) the current bundle steps aside while the state
                // still says what it is (kept as the fallback only if it proved itself by reporting ready); (2) the
                // promotion is recorded (on trial, the new floor), and one that can't be recorded doesn't happen, so a
                // bundle is never served without its trial counting; (3) the staged bundle moves into place.
                let recorded = if unfinished(&b) {
                    true
                } else {
                    // The current bundle is kept as the fallback unless the state's trial names it (it never reported
                    // ready). One whose channel file can't be read now is kept too: the fallback verifies it before use.
                    let on_trial = slot_version(dir, "current", pubkey)
                        .is_some_and(|v| state.trial.as_deref() == Some(v.to_string().as_str()));
                    let stepped_aside = if !dir.join("current.tar.gz").exists() || on_trial {
                        remove_slot(dir, "current");
                        true
                    } else {
                        move_slot(dir, "current", "previous")
                    };
                    if !stepped_aside {
                        log(format!("could not keep the current bundle as the fallback; {} stays staged", b.meta.version));
                        false
                    } else {
                    let mut promoted = state.clone();
                    promoted.trial = Some(b.meta.version.clone());
                    promoted.boots = 0;
                    promoted.floor = Some(b.meta.version.clone());
                    promoted.issued = state.issued.max(b.manifest.issued);
                    let ok = promoted.save(dir);
                    if ok {
                        state = promoted;
                    } else {
                        log(format!("could not record the promotion of {}; it stays staged (the bundle it replaces has \
                                     already stepped aside)", b.meta.version));
                    }
                    ok
                    }
                };
                if recorded {
                    if move_slot(dir, "next", "current") {
                        log(format!("promoted staged bundle {} (on trial)", b.meta.version));
                    } else {
                        log("could not promote the staged bundle");
                        remove_slot(dir, "next");
                    }
                }
            }
            Err(e) => {
                log(format!("staged bundle refused: {e}"));
                if let Some(v) = claimed_version(&archive) {
                    state.reject(&v);
                }
                remove_slot(dir, "next");
            }
        }
    }
    let mut chosen = None;
    if let Some((channel, archive)) = read_slot(dir, "current") {
        match open(pubkey, &channel, &archive, builtin, shell_api) {
            Ok(b) if state.trial.as_deref() == Some(b.meta.version.as_str()) && state.boots >= MAX_UNCONFIRMED_BOOTS => {
                log(format!("bundle {} started {} times without reporting ready; dropped", b.meta.version, state.boots));
                state.reject(&b.meta.version);
                remove_slot(dir, "current");
            }
            Ok(b) => {
                if state.trial.as_deref() == Some(b.meta.version.as_str()) {
                    state.boots += 1;
                }
                chosen = Some(b);
            }
            Err(e) => {
                log(format!("current bundle refused: {e}"));
                if state.trial.is_some() {
                    state.trial = None;
                    state.boots = 0;
                }
                remove_slot(dir, "current");
            }
        }
    }
    if chosen.is_none() {
        if let Some((channel, archive)) = read_slot(dir, "previous") {
            match open(pubkey, &channel, &archive, builtin, shell_api) {
                Ok(b) => {
                    // Recorded, then moved (as a promotion): the trial is over (and a drop above is kept) before the
                    // last good bundle moves back, so a kill mid-move leaves nothing stale for tidy() to trip on.
                    state.trial = None;
                    state.boots = 0;
                    if !state.save(dir) {
                        log(format!("back to the last good bundle {}, served from where it is (the state can't be written)", b.meta.version));
                        chosen = Some(b);
                    } else if move_slot(dir, "previous", "current") {
                        log(format!("back to the last good bundle {}", b.meta.version));
                        chosen = Some(b);
                    } else {
                        remove_slot(dir, "previous");
                    }
                }
                Err(e) => {
                    log(format!("last good bundle refused: {e}"));
                    remove_slot(dir, "previous");
                }
            }
        }
    }
    if !state.save(dir) {
        if let Some(b) = chosen.as_ref().filter(|b| state.trial.as_deref() == Some(b.meta.version.as_str())) {
            // Its start couldn't be counted: serving it could serve a bundle that never starts, forever. The last good
            // bundle instead, as it is (nothing can be moved or recorded now), else the built-in screens.
            log(format!("could not record a start of {} (on trial); not serving it this time", b.meta.version));
            chosen = read_slot(dir, "previous").and_then(|(c, a)| open(pubkey, &c, &a, builtin, shell_api).ok());
        }
    }
    match &chosen {
        Some(b) => log(format!("serving bundle {} (shell API {shell_api}, built-in {builtin})", b.meta.version)),
        None => log(format!("serving the built-in screens {builtin}")),
    }
    chosen
}

/// Bundle URLs: https, or plain http to this machine / the emulator's host only (local tests).
fn allowed_url(u: &url::Url) -> bool {
    match u.scheme() {
        "https" => true,
        "http" => matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "10.0.2.2")),
        _ => false,
    }
}

async fn fetch(client: &reqwest::Client, u: &url::Url, max: u64) -> Result<Vec<u8>, String> {
    if !allowed_url(u) {
        return Err(format!("refused URL {u}"));
    }
    let mut resp = client.get(u.clone()).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
    if resp.content_length().is_some_and(|n| n > max) {
        return Err("download too large".into());
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if (out.len() + chunk.len()) as u64 > max {
            return Err("download too large".into());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CheckResult {
    Off,
    UpToDate { version: String },
    NeedsNewerApp { version: String, api: u32 },
    Staged { version: String },
}

/// The newest version this device has or has had, when `offered` is no newer (or was dropped here); `None` when
/// `offered` is worth fetching.
fn not_new(
    state: &State,
    builtin: &semver::Version,
    active: Option<&semver::Version>,
    staged: Option<&semver::Version>,
    offered: &semver::Version,
) -> Option<semver::Version> {
    let floor = state.floor();
    let newest = [Some(builtin), active, staged, floor.as_ref()].into_iter().flatten().max().cloned().unwrap_or_else(|| builtin.clone());
    (*offered <= newest || state.rejected.contains(&offered.to_string())).then_some(newest)
}

/// Fetches the channel file; when it is signed, still valid, not older than one already taken, and names a newer
/// bundle this shell can run, downloads, verifies and stages it as `next.*`.
pub async fn check(
    dir: &Path,
    channel: &str,
    pubkey: &str,
    builtin: &semver::Version,
    active: Option<&semver::Version>,
    shell_api: u32,
    now: u64,
    files: &Mutex<()>,
) -> Result<CheckResult, String> {
    let base = url::Url::parse(channel).map_err(|e| format!("channel: {e}"))?;
    uni_core::init_crypto();
    let client = uni_core::media::https_client_following_redirects(Duration::from_secs(60)).map_err(|e| e.to_string())?;
    let text = fetch(&client, &base, MAX_CHANNEL_BYTES).await?;
    let manifest = verify_channel(pubkey, &text)?;
    fresh(&manifest, now)?;
    let state = State::load_checked(dir)?;
    if manifest.issued < state.issued {
        return Err(format!("manifest for {} is older than one already taken here (a replay?)", manifest.version));
    }
    let offered = semver::Version::parse(&manifest.version).map_err(|e| e.to_string())?;
    let staged = staged_version(dir, pubkey);
    if let Some(newest) = not_new(&state, builtin, active, staged.as_ref(), &offered) {
        return Ok(CheckResult::UpToDate { version: newest.to_string() });
    }
    if manifest.api != shell_api {
        log(format!("bundle {offered} needs shell API {}, this shell has {shell_api}: needs a newer app", manifest.api));
        return Ok(CheckResult::NeedsNewerApp { version: manifest.version, api: manifest.api });
    }
    let archive = fetch(&client, &base.join(&manifest.archive).map_err(|e| e.to_string())?, MAX_ARCHIVE_BYTES.min(manifest.bytes)).await?;
    let bundle = open(pubkey, &text, &archive, builtin, shell_api)?;
    // From here the bundle directory is shared with launch, apply and ready: decide again on its state as it is now, and
    // never write back a state read before the download.
    let _files = files.lock().unwrap_or_else(|e| e.into_inner());
    let state = State::load_checked(dir)?;
    if manifest.issued < state.issued {
        return Err(format!("manifest for {} is older than one already taken here", manifest.version));
    }
    let staged = staged_version(dir, pubkey);
    if let Some(newest) = not_new(&state, builtin, active, staged.as_ref(), &offered) {
        return Ok(CheckResult::UpToDate { version: newest.to_string() });
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // state.json first: bundles on disk without it read as lost state at the next launch.
    if !dir.join("state.json").exists() && !state.save(dir) {
        return Err("could not write state.json".into());
    }
    for (ext, bytes) in PARTS.iter().zip([text.as_slice(), archive.as_slice()]) {
        std::fs::write(dir.join(format!("next.{ext}.tmp")), bytes).map_err(|e| e.to_string())?;
    }
    // The archive lands last: a launch that sees next.tar.gz also sees its channel file.
    remove_slot(dir, "next"); // an older staged bundle: a cut between the renames then leaves a half tidy() can see
    for ext in PARTS {
        std::fs::rename(dir.join(format!("next.{ext}.tmp")), dir.join(format!("next.{ext}"))).map_err(|e| e.to_string())?;
    }
    log(format!("staged bundle {} for the next launch or resume", bundle.meta.version));
    Ok(CheckResult::Staged { version: bundle.meta.version })
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Setup {
    Pending,
    Done,
    /// A page request gave up waiting: the built-in screens stay for this launch (one page never mixes layers).
    TimedOut,
}

/// Shared between the asset provider and the commands.
pub struct Ota {
    /// The bundle being served. Each activated bundle is leaked (a few per process at most) so the asset provider can
    /// hand out borrowed slices without holding a lock; a swap is always followed by a page reload.
    active: RwLock<Option<&'static Bundle>>,
    setup: (Mutex<Setup>, Condvar),
    dir: std::sync::OnceLock<PathBuf>,
    builtin: std::sync::OnceLock<semver::Version>,
    pubkey: &'static str,
    /// Serialises launch, apply, ready, refused and the staging part of check, which all change the bundle directory.
    files: Mutex<()>,
    wait: Duration,
}

impl Ota {
    fn new() -> Arc<Ota> {
        Arc::new(Ota {
            active: RwLock::new(None),
            setup: (Mutex::new(Setup::Pending), Condvar::new()),
            dir: std::sync::OnceLock::new(),
            builtin: std::sync::OnceLock::new(),
            pubkey: PUBKEY_HEX,
            files: Mutex::new(()),
            wait: SETUP_WAIT,
        })
    }

    fn set_active(&self, b: Option<Bundle>) {
        let leaked = b.map(|b| &*Box::leak(Box::new(b)));
        *self.active.write().unwrap_or_else(|e| e.into_inner()) = leaked;
    }

    fn init(&self, dir: PathBuf, builtin: semver::Version) {
        let _ = std::fs::create_dir_all(&dir);
        // Chosen without holding the setup lock, so a page request waiting for it times out after SETUP_WAIT.
        let chosen = if self.pubkey.is_empty() {
            None
        } else {
            let _files = self.files.lock().unwrap_or_else(|e| e.into_inner());
            activate(&dir, self.pubkey, &builtin, SHELL_API)
        };
        let (lock, cvar) = &self.setup;
        let mut setup = lock.lock().unwrap_or_else(|e| e.into_inner());
        if *setup == Setup::TimedOut {
            log("setup came after the first page request timed out; the built-in screens stay for this launch");
            // A start activate counted for a bundle on trial stands: on a device this slow every launch would time out,
            // and giving it back would keep that bundle on trial forever; counted, it is dropped after a few.
        } else {
            self.set_active(chosen);
            *setup = Setup::Done;
        }
        let _ = self.dir.set(dir);
        let _ = self.builtin.set(builtin);
        cvar.notify_all();
    }

    /// The bundle being served, once launch has chosen. Waits briefly for that choice; on timeout the built-in screens
    /// are fixed for the whole launch.
    fn active(&self) -> Option<&'static Bundle> {
        let (lock, cvar) = &self.setup;
        let mut setup = lock.lock().unwrap_or_else(|e| e.into_inner());
        if *setup == Setup::Pending {
            setup = cvar.wait_timeout_while(setup, self.wait, |s| *s == Setup::Pending).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
            if *setup == Setup::Pending {
                *setup = Setup::TimedOut;
            }
        }
        if *setup == Setup::TimedOut {
            return None;
        }
        drop(setup);
        *self.active.read().unwrap_or_else(|e| e.into_inner())
    }

    fn ready_dir(&self) -> Option<(&Path, &semver::Version)> {
        if self.pubkey.is_empty() {
            return None;
        }
        Some((self.dir.get()?.as_path(), self.builtin.get()?))
    }

    /// The page booted: the bundle on trial is kept.
    fn ready(&self) {
        let (Some((dir, _)), Some(b)) = (self.ready_dir(), self.active()) else { return };
        let _files = self.files.lock().unwrap_or_else(|e| e.into_inner());
        // Unreadable now: leave it; the next launch fails closed.
        let Ok(mut state) = State::load_checked(dir) else { return };
        if state.trial.as_deref() == Some(b.meta.version.as_str()) {
            state.trial = None;
            state.boots = 0;
            if state.save(dir) {
                log(format!("bundle {} reported ready; kept", b.meta.version));
            } else {
                log(format!("bundle {} reported ready, but that couldn't be recorded; still on trial", b.meta.version));
            }
        }
    }

    /// The screens on trial don't fit this shell (their own code says so at boot): drop them now rather than after
    /// MAX_UNCONFIRMED_BOOTS blank starts, and fall back. Only a bundle still on trial: a script in it can do no more
    /// than not reporting ready would. True when the page must reload.
    fn refused(&self, version: &str, reason: &str) -> bool {
        let (Some((dir, builtin)), Some(b)) = (self.ready_dir(), self.active()) else { return false };
        let _files = self.files.lock().unwrap_or_else(|e| e.into_inner());
        let Ok(mut state) = State::load_checked(dir) else { return false };
        // The refusing page names its version: an apply that swapped bundles meanwhile doesn't drop the new one.
        if b.meta.version != version || state.trial.as_deref() != Some(version) {
            return false;
        }
        let reason: String = reason.chars().take(200).collect();
        log(format!("bundle {} refused this shell: {reason:?}; dropped", b.meta.version));
        state.reject(&b.meta.version);
        if !state.save(dir) {
            return false;
        }
        remove_slot(dir, "current");
        self.set_active(activate(dir, self.pubkey, builtin, SHELL_API));
        true
    }

    /// Look for a newer bundle on the build's channel and stage it.
    async fn check(&self) -> Result<CheckResult, String> {
        let (Some(channel), Some((dir, builtin))) = (CHANNEL, self.ready_dir()) else { return Ok(CheckResult::Off) };
        let active = self.active().map(|b| b.version.clone());
        let r = check(dir, channel, self.pubkey, builtin, active.as_ref(), SHELL_API, now(), &self.files).await;
        if let Err(e) = &r {
            log(format!("check failed: {e}"));
        }
        r
    }

    /// A staged bundle, applied now (the app came back to the foreground). True when the screens changed and the caller
    /// must reload the page.
    fn apply(&self) -> bool {
        let Some((dir, builtin)) = self.ready_dir() else { return false };
        if *self.setup.0.lock().unwrap_or_else(|e| e.into_inner()) != Setup::Done {
            return false; // still launching, or this launch is fixed on the built-in screens
        }
        let _files = self.files.lock().unwrap_or_else(|e| e.into_inner());
        if !dir.join("next.tar.gz").exists() {
            return false;
        }
        let before = self.active().map(|b| b.meta.version.clone());
        let chosen = activate(dir, self.pubkey, builtin, SHELL_API);
        let after = chosen.as_ref().map(|b| b.meta.version.clone());
        if after == before {
            return false;
        }
        self.set_active(chosen);
        true
    }
}

/// The app's asset provider: the active bundle's files, else the ones built in.
pub struct OtaAssets<R: Runtime> {
    builtin: Box<dyn Assets<R>>,
    ota: Arc<Ota>,
}

struct NoAssets;
impl<R: Runtime> Assets<R> for NoAssets {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

/// Puts [`OtaAssets`] in front of the context's built-in assets. Returns the shared state to `manage`.
pub fn wrap<R: Runtime>(ctx: &mut tauri::Context<R>) -> Arc<Ota> {
    let ota = Ota::new();
    let builtin = ctx.set_assets(Box::new(NoAssets));
    ctx.set_assets(Box::new(OtaAssets { builtin, ota: ota.clone() }));
    ota
}

impl<R: Runtime> Assets<R> for OtaAssets<R> {
    fn setup(&self, app: &tauri::App<R>) {
        self.builtin.setup(app);
        let builtin = app.package_info().version.clone();
        match app.path().app_data_dir() {
            Ok(d) => {
                self.ota.init(d.join("ota"), builtin);
                // The shell looks for new screens itself a few seconds after launch, so a bundle whose own update code
                // is broken can still be replaced over the air. (Coming back to the app checks too: src/ota.ts.)
                if CHANNEL.is_some() && !self.ota.pubkey.is_empty() {
                    let ota = self.ota.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(3));
                        let _ = tauri::async_runtime::block_on(ota.check());
                    });
                }
            }
            Err(e) => {
                log(format!("no app data dir ({e}); serving the built-in screens"));
                let (lock, cvar) = &self.ota.setup;
                *lock.lock().unwrap_or_else(|e| e.into_inner()) = Setup::Done;
                cvar.notify_all();
            }
        }
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        match self.ota.active() {
            // Only the bundle's own files: never a built-in file mixed into a bundle's page.
            Some(b) => b.get(key.as_ref()).map(Cow::Borrowed),
            None => self.builtin.get(key),
        }
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        match self.ota.active() {
            Some(b) => Box::new(b.files.iter().map(|(k, v)| (Cow::Owned(format!("/{k}")), Cow::Borrowed(v.as_slice())))),
            None => self.builtin.iter(),
        }
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        match self.ota.active() {
            // A bundle's HTML has no build-time nonce tokens or inline-script hashes; the configured CSP applies as is.
            Some(_) => Box::new(std::iter::empty()),
            None => self.builtin.csp_hashes(html_path),
        }
    }
}

#[derive(Serialize)]
pub struct Status {
    shell_api: u32,
    builtin: String,
    /// The bundle being served, if not the built-in screens.
    active: Option<Meta>,
    channel: Option<&'static str>,
}

#[tauri::command]
pub fn ota_status(app: tauri::AppHandle, ota: tauri::State<'_, Arc<Ota>>) -> Status {
    Status {
        shell_api: SHELL_API,
        builtin: app.package_info().version.to_string(),
        active: ota.active().map(|b| b.meta.clone()),
        channel: if ota.pubkey.is_empty() { None } else { CHANNEL },
    }
}

#[tauri::command(async)]
pub fn ota_ready(ota: tauri::State<'_, Arc<Ota>>) {
    ota.ready();
}

/// The screens on trial refused this shell at boot: dropped, fall back. True when the page must reload.
#[tauri::command(async)]
pub fn ota_refused(ota: tauri::State<'_, Arc<Ota>>, version: String, reason: String) -> bool {
    ota.refused(&version, &reason)
}

/// Apply a staged bundle now. True when the page must reload (the caller does it, once nothing would be lost).
#[tauri::command(async)]
pub fn ota_apply(ota: tauri::State<'_, Arc<Ota>>) -> bool {
    ota.apply()
}

/// Look for a newer bundle on the build's channel and stage it.
#[tauri::command]
pub async fn ota_check(ota: tauri::State<'_, Arc<Ota>>) -> Result<CheckResult, String> {
    ota.check().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer as _;

    struct Key {
        sk: ed25519_dalek::SigningKey,
        pk: String,
    }

    fn key(seed: u8) -> Key {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
        let pk = sk.verifying_key().to_bytes().iter().map(|b| format!("{b:02x}")).collect();
        Key { sk, pk }
    }

    fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut b = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        for (path, data) in files {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_entry_type(tar::EntryType::Regular);
            // set_path refuses `..`; write the name bytes directly so the unsafe-path test can build one.
            let name = &mut h.as_old_mut().name;
            name[..path.len()].copy_from_slice(path.as_bytes());
            h.set_cksum();
            b.append(&h, *data).unwrap();
        }
        b.into_inner().unwrap().finish().unwrap()
    }

    fn bundle(version: &str, api: u32) -> Vec<u8> {
        let meta = format!(r#"{{"version":"{version}","api":{api}}}"#);
        let page = format!("<html>web {version}</html>");
        archive(&[("uni-bundle.json", meta.as_bytes()), ("index.html", page.as_bytes()), ("assets/app.js", b"1")])
    }

    /// The channel file the broker would write for `archive`, as bundle.py does it.
    fn channel_for(k: &Key, version: &str, api: u32, archive: &[u8], issued: u64, days: u64) -> Vec<u8> {
        let m = Manifest {
            v: 1,
            app: PACKAGE.into(),
            version: version.into(),
            api,
            archive: format!("web-{version}.tar.gz"),
            sha256: sha256_hex(archive),
            bytes: archive.len() as u64,
            commit: "0".repeat(40),
            issued,
            expires: issued + days * 86400,
        };
        let text = serde_json::to_string(&m).unwrap();
        let mut msg = DOMAIN.to_vec();
        msg.extend_from_slice(text.as_bytes());
        let sig = base64::engine::general_purpose::STANDARD.encode(k.sk.sign(&msg).to_bytes());
        serde_json::to_vec(&serde_json::json!({"manifest": text, "sig": sig})).unwrap()
    }

    const T0: u64 = 1_800_000_000;

    fn signed(k: &Key, version: &str, api: u32) -> (Vec<u8>, Vec<u8>) {
        let a = bundle(version, api);
        // Later versions are issued later, as the broker does.
        let minor: u64 = version.rsplit('.').next().unwrap().parse().unwrap();
        (channel_for(k, version, api, &a, T0 + minor * 3600, 14), a)
    }

    fn v(s: &str) -> semver::Version {
        semver::Version::parse(s).unwrap()
    }

    /// As the app does it: state.json exists (launch writes it) before any bundle lands.
    fn put(dir: &Path, slot: &str, (channel, archive): &(Vec<u8>, Vec<u8>)) {
        if !dir.join("state.json").exists() {
            State::default().save(dir);
        }
        std::fs::write(dir.join(format!("{slot}.json")), channel).unwrap();
        std::fs::write(dir.join(format!("{slot}.tar.gz")), archive).unwrap();
    }

    fn act(dir: &Path, k: &Key) -> Option<String> {
        activate(dir, &k.pk, &v("0.3.7"), 1).map(|b| b.meta.version)
    }

    fn ready(dir: &Path) {
        let mut s = State::load_checked(dir).unwrap();
        s.trial = None;
        s.boots = 0;
        s.save(dir);
    }

    #[test]
    fn a_signed_newer_bundle_for_this_api_opens() {
        let k = key(1);
        let (c, a) = signed(&k, "0.3.8", 1);
        let b = open(&k.pk, &c, &a, &v("0.3.7"), 1).unwrap();
        assert_eq!(b.meta, Meta { version: "0.3.8".into(), api: 1 });
        assert_eq!(b.get("/index.html"), Some(&b"<html>web 0.3.8</html>"[..]));
        assert_eq!(b.get("assets/app.js"), Some(&b"1"[..]));
    }

    #[test]
    fn a_tampered_archive_another_key_or_a_bad_signature_is_refused() {
        let (k, other) = (key(1), key(2));
        let (c, a) = signed(&k, "0.3.8", 1);
        let mut tampered = a.clone();
        let n = tampered.len();
        tampered[n / 2] ^= 1;
        assert!(open(&k.pk, &c, &tampered, &v("0.3.7"), 1).unwrap_err().contains("not the one its signed manifest names"));
        assert!(open(&other.pk, &c, &a, &v("0.3.7"), 1).unwrap_err().contains("signature does not match"));
        // The manifest text edited after signing (a longer validity, say): the signature no longer matches.
        let edited = String::from_utf8(c.clone()).unwrap().replace("\\\"expires\\\":", "\\\"expires\\\":9");
        assert_ne!(edited.as_bytes(), c.as_slice());
        assert!(open(&k.pk, edited.as_bytes(), &a, &v("0.3.7"), 1).unwrap_err().contains("signature"));
        assert!(open(&k.pk, b"not json", &a, &v("0.3.7"), 1).is_err());
        assert!(open("", &c, &a, &v("0.3.7"), 1).unwrap_err().contains("no bundle key"));
    }

    #[test]
    fn the_signed_text_is_domain_separated() {
        let k = key(1);
        let a = bundle("0.3.8", 1);
        let m = serde_json::to_string(&verify_channel(&k.pk, &channel_for(&k, "0.3.8", 1, &a, T0, 14)).unwrap()).unwrap();
        // The same manifest signed without the prefix (any other use of the key) doesn't pass as a manifest.
        let sig = base64::engine::general_purpose::STANDARD.encode(k.sk.sign(m.as_bytes()).to_bytes());
        let bare = serde_json::to_vec(&serde_json::json!({"manifest": m, "sig": sig})).unwrap();
        assert!(verify_channel(&k.pk, &bare).unwrap_err().contains("signature"));
    }

    #[test]
    fn an_archive_that_disagrees_with_its_manifest_is_refused() {
        let k = key(1);
        let a = bundle("0.3.9", 1); // says 0.3.9 inside
        let c = channel_for(&k, "0.3.8", 1, &a, T0, 14); // signed as 0.3.8
        assert!(open(&k.pk, &c, &a, &v("0.3.7"), 1).unwrap_err().contains("archive says 0.3.9"));
    }

    #[test]
    fn an_expired_or_overlong_manifest_is_refused() {
        let k = key(1);
        let a = bundle("0.3.8", 1);
        let m = verify_channel(&k.pk, &channel_for(&k, "0.3.8", 1, &a, T0, 14)).unwrap();
        assert!(fresh(&m, T0 + 13 * 86400).is_ok());
        assert!(fresh(&m, T0 + 14 * 86400).unwrap_err().contains("expired"));
        assert!(verify_channel(&k.pk, &channel_for(&k, "0.3.8", 1, &a, T0, 40)).unwrap_err().contains("validity"));
    }

    #[test]
    fn the_production_key_is_a_key() {
        // Empty until the sealed key exists; once pinned it must be a valid Ed25519 point.
        if !RELEASE_PUBKEY_HEX.is_empty() {
            let k = key(1);
            let a = bundle("0.3.8", 1);
            let c = channel_for(&k, "0.3.8", 1, &a, T0, 14);
            assert!(verify_channel(RELEASE_PUBKEY_HEX, &c).unwrap_err().contains("signature does not match"));
        }
    }

    #[test]
    fn another_api_or_an_older_bundle_is_refused() {
        let k = key(1);
        let (c, a) = signed(&k, "0.3.8", 2);
        assert!(open(&k.pk, &c, &a, &v("0.3.7"), 1).unwrap_err().contains("shell API"));
        let (c, a) = signed(&k, "0.3.7", 1);
        assert!(open(&k.pk, &c, &a, &v("0.3.7"), 1).unwrap_err().contains("not newer"));
    }

    #[test]
    fn unsafe_paths_links_and_missing_metadata_are_refused() {
        let meta = br#"{"version":"0.3.8","api":1}"#;
        let a = archive(&[("uni-bundle.json", meta), ("index.html", b"x"), ("../evil", b"x")]);
        assert!(unpack(&a).unwrap_err().contains("unsafe path"));
        let a = archive(&[("index.html", b"x")]);
        assert!(unpack(&a).unwrap_err().contains("uni-bundle.json"));
        let a = archive(&[("uni-bundle.json", meta), ("index.html", b"x"), ("index.html", b"y")]);
        assert!(unpack(&a).unwrap_err().contains("twice"));
        let mut b = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Symlink);
        h.set_size(0);
        b.append_link(&mut h, "index.html", "/etc/passwd").unwrap();
        assert!(unpack(&b.into_inner().unwrap().finish().unwrap()).unwrap_err().contains("regular files"));
    }

    #[test]
    fn launch_promotes_a_staged_bundle_and_serves_it() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(act(dir.path(), &k), None, "nothing installed: built-in");
        put(dir.path(), "next", &signed(&k, "0.3.8", 1));
        assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.8"));
        assert!(!dir.path().join("next.tar.gz").exists() && dir.path().join("current.tar.gz").exists());
        let s = State::load_checked(dir.path()).unwrap();
        assert_eq!((s.trial.as_deref(), s.floor.as_deref(), s.issued), (Some("0.3.8"), Some("0.3.8"), T0 + 8 * 3600));
    }

    #[test]
    fn a_bundle_that_never_reports_ready_falls_back_to_the_last_good_one() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "next", &signed(&k, "0.3.8", 1));
        assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.8"));
        ready(dir.path());
        // 0.3.9 arrives, takes over, and never boots.
        put(dir.path(), "next", &signed(&k, "0.3.9", 1));
        for _ in 0..MAX_UNCONFIRMED_BOOTS {
            assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.9"));
        }
        assert!(dir.path().join("previous.tar.gz").exists(), "0.3.8 kept as the last good bundle");
        assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.8"), "never ready: back to the last good bundle");
        let s = State::load_checked(dir.path()).unwrap();
        assert_eq!((s.rejected, s.trial), (vec!["0.3.9".to_string()], None));
        assert!(!dir.path().join("previous.tar.gz").exists(), "it is current again");
        assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.8"), "and stays");
        // With no last good bundle, the built-in screens.
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "next", &signed(&k, "0.3.8", 1));
        for _ in 0..MAX_UNCONFIRMED_BOOTS {
            assert!(act(dir.path(), &k).is_some());
        }
        assert_eq!(act(dir.path(), &k), None);
    }

    #[test]
    fn a_bundle_still_on_trial_is_not_kept_as_the_fallback() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "next", &signed(&k, "0.3.8", 1));
        assert!(act(dir.path(), &k).is_some()); // 0.3.8 on trial, never ready
        put(dir.path(), "next", &signed(&k, "0.3.9", 1));
        assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.9"));
        assert!(!dir.path().join("previous.tar.gz").exists());
    }

    #[test]
    fn a_ready_bundle_stays_and_a_newer_app_wins() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "current", &signed(&k, "0.3.8", 1));
        for _ in 0..5 {
            assert!(act(dir.path(), &k).is_some());
        }
        // An APK update to 0.3.8 brings the same screens built in; the bundle is no longer newer.
        assert!(activate(dir.path(), &k.pk, &v("0.3.8"), 1).is_none());
    }

    #[test]
    fn a_tampered_installed_bundle_falls_back_at_launch() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "previous", &signed(&k, "0.3.8", 1));
        let (c, mut a) = signed(&k, "0.3.9", 1);
        let n = a.len();
        a[n / 2] ^= 1;
        put(dir.path(), "current", &(c, a));
        assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.8"));
    }

    #[test]
    fn an_older_signed_bundle_is_never_used_again() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "next", &signed(&k, "0.3.9", 1));
        assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.9"));
        // 0.3.9 is lost (cleared, refused later); the channel replays the older 0.3.8, validly signed.
        remove_slot(dir.path(), "current");
        put(dir.path(), "next", &signed(&k, "0.3.8", 1));
        assert_eq!(act(dir.path(), &k), None);
        // And a check won't fetch it.
        let state = State::load_checked(dir.path()).unwrap();
        assert_eq!(state.floor.as_deref(), Some("0.3.9"));
        assert!(not_new(&state, &v("0.3.7"), None, None, &v("0.3.8")).is_some());
        assert!(not_new(&state, &v("0.3.7"), None, None, &v("0.3.10")).is_none());
    }

    #[test]
    fn a_manifest_issued_before_one_already_taken_is_not_promoted() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "next", &signed(&k, "0.3.8", 1));
        assert!(act(dir.path(), &k).is_some());
        // A newer version, but signed earlier than the manifest already taken (an old signing held back and replayed).
        let a = bundle("0.3.9", 1);
        put(dir.path(), "next", &(channel_for(&k, "0.3.9", 1, &a, T0, 14), a));
        assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.8"));
    }

    #[test]
    fn a_lost_or_corrupt_state_fails_closed_and_keeps_the_floor() {
        let k = key(1);
        for damage in ["corrupt", "missing"] {
            let dir = tempfile::tempdir().unwrap();
            put(dir.path(), "next", &signed(&k, "0.3.9", 1));
            assert!(act(dir.path(), &k).is_some());
            match damage {
                "corrupt" => std::fs::write(dir.path().join("state.json"), b"{not json").unwrap(),
                _ => std::fs::remove_file(dir.path().join("state.json")).unwrap(),
            }
            assert_eq!(act(dir.path(), &k), None, "{damage}: built-in");
            assert!(!dir.path().join("current.tar.gz").exists(), "{damage}: bundles dropped");
            let s = State::load_checked(dir.path()).unwrap();
            assert_eq!((s.floor.as_deref(), s.issued), (Some("0.3.9"), T0 + 9 * 3600), "{damage}: floor kept");
            put(dir.path(), "next", &signed(&k, "0.3.8", 1));
            assert_eq!(act(dir.path(), &k), None, "{damage}: the older one stays out");
        }
        // state.json damaged after the bundle that set the floor is already gone: the floor file still holds it.
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "next", &signed(&k, "0.3.9", 1));
        assert!(act(dir.path(), &k).is_some());
        remove_slot(dir.path(), "current");
        std::fs::write(dir.path().join("state.json"), b"{not json").unwrap();
        assert_eq!(act(dir.path(), &k), None);
        let s = State::load_checked(dir.path()).unwrap();
        assert_eq!((s.floor.as_deref(), s.issued), (Some("0.3.9"), T0 + 9 * 3600));
    }

    #[test]
    fn apply_swaps_in_a_staged_bundle() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "current", &signed(&k, "0.3.8", 1));
        let mut o = Ota::new();
        Arc::get_mut(&mut o).unwrap().pubkey = Box::leak(k.pk.clone().into_boxed_str());
        o.init(dir.path().to_path_buf(), v("0.3.7"));
        assert_eq!(o.active().unwrap().meta.version, "0.3.8");
        assert!(!o.apply(), "nothing staged: nothing to apply");
        put(dir.path(), "next", &signed(&k, "0.3.9", 1));
        assert!(o.apply());
        assert_eq!(o.active().unwrap().meta.version, "0.3.9");
        assert!(!dir.path().join("next.tar.gz").exists());
        assert_eq!(State::load_checked(dir.path()).unwrap().trial.as_deref(), Some("0.3.9"), "on trial after an apply too");
    }

    #[test]
    fn a_page_request_before_setup_fixes_the_built_in_layer_for_the_launch() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "current", &signed(&k, "0.3.8", 1));
        let pk: &'static str = Box::leak(k.pk.clone().into_boxed_str());
        let mut late = Ota::new();
        let l = Arc::get_mut(&mut late).unwrap();
        l.wait = Duration::from_millis(10);
        l.pubkey = pk;
        assert!(late.active().is_none(), "setup hasn't run: built-in");
        late.init(dir.path().to_path_buf(), v("0.3.7"));
        assert!(late.active().is_none(), "still built-in for this launch");
        let mut on_time = Ota::new();
        Arc::get_mut(&mut on_time).unwrap().pubkey = pk;
        on_time.init(dir.path().to_path_buf(), v("0.3.7"));
        assert_eq!(on_time.active().unwrap().meta.version, "0.3.8");
    }

    /// Makes `dir` unwritable; false where that doesn't stop writes (root), and the test then has nothing to show.
    fn read_only(dir: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        if std::fs::write(dir.join("probe"), b"x").is_ok() {
            let _ = std::fs::remove_file(dir.join("probe"));
            writable(dir);
            return false;
        }
        true
    }

    fn writable(dir: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn a_promotion_that_cannot_be_recorded_does_not_happen() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "next", &signed(&k, "0.3.8", 1));
        if !read_only(dir.path()) {
            return;
        }
        let served = act(dir.path(), &k);
        writable(dir.path());
        assert_eq!(served, None, "not served without its trial recorded");
        assert!(dir.path().join("next.tar.gz").exists(), "still staged");
        assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.8"), "promoted once it can be recorded");
    }

    #[test]
    fn a_trial_bundle_whose_start_cannot_be_counted_is_not_served() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "next", &signed(&k, "0.3.8", 1));
        assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.8"));
        ready(dir.path());
        put(dir.path(), "next", &signed(&k, "0.3.9", 1));
        assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.9"), "0.3.8 is now the last good one");
        if !read_only(dir.path()) {
            return;
        }
        let served = act(dir.path(), &k);
        writable(dir.path());
        assert_eq!(served.as_deref(), Some("0.3.8"), "a start that isn't counted could repeat forever: the last good one");
        std::fs::remove_file(dir.path().join("previous.tar.gz")).unwrap();
        std::fs::remove_file(dir.path().join("previous.json")).unwrap();
        if !read_only(dir.path()) {
            return;
        }
        let served = act(dir.path(), &k);
        writable(dir.path());
        assert_eq!(served, None, "and with none, the built-in screens");
        ready(dir.path());
        if !read_only(dir.path()) {
            return;
        }
        let served = act(dir.path(), &k);
        writable(dir.path());
        assert_eq!(served.as_deref(), Some("0.3.9"), "a bundle that proved itself needs no count");
    }

    #[test]
    fn half_a_staging_is_not_a_staged_bundle() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        let (c, _) = signed(&k, "0.3.9", 1);
        State::default().save(dir.path());
        std::fs::write(dir.path().join("next.json"), &c).unwrap(); // a check killed before the archive landed
        assert_eq!(staged_version(dir.path(), &k.pk), None);
        assert_eq!(act(dir.path(), &k), None);
        assert!(!dir.path().join("next.json").exists(), "cleared at launch");
    }

    #[test]
    fn a_promotion_cut_between_its_two_renames_is_finished_at_launch() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "next", &signed(&k, "0.3.8", 1));
        let mut s = State::default();
        s.trial = Some("0.3.8".into());
        s.floor = Some("0.3.8".into());
        s.save(dir.path());
        // Killed after next.json moved to current.json, before the archive followed.
        std::fs::rename(dir.path().join("next.json"), dir.path().join("current.json")).unwrap();
        std::fs::write(dir.path().join("next.tar.gz.tmp"), b"partial").unwrap();
        assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.8"), "the floor already says 0.3.8: it must not be lost");
        assert!(!dir.path().join("next.tar.gz").exists() && !dir.path().join("next.tar.gz.tmp").exists());
    }

    #[test]
    fn a_promotion_killed_after_it_was_recorded_is_finished_at_launch() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "next", &signed(&k, "0.3.8", 1));
        assert!(act(dir.path(), &k).is_some());
        ready(dir.path());
        put(dir.path(), "next", &signed(&k, "0.3.9", 1));
        // Killed after the current bundle stepped aside and the promotion was recorded, before next moved.
        std::fs::rename(dir.path().join("current.json"), dir.path().join("previous.json")).unwrap();
        std::fs::rename(dir.path().join("current.tar.gz"), dir.path().join("previous.tar.gz")).unwrap();
        let mut s = State::load_checked(dir.path()).unwrap();
        s.trial = Some("0.3.9".into());
        s.floor = Some("0.3.9".into());
        s.save(dir.path());
        assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.9"), "not refused as 'already used here'");
        assert!(dir.path().join("previous.tar.gz").exists(), "0.3.8 still the fallback");
    }

    #[test]
    fn a_fallback_cut_between_its_two_renames_keeps_the_last_good_bundle() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "previous", &signed(&k, "0.3.8", 1));
        // 0.3.9 never started three times and was dropped (recorded first), then the move back was killed after
        // previous.json became current.json, before the archive followed.
        let mut s = State::default();
        s.rejected = vec!["0.3.9".into()];
        s.floor = Some("0.3.9".into());
        s.issued = T0 + 9 * 3600;
        s.save(dir.path());
        std::fs::rename(dir.path().join("previous.json"), dir.path().join("current.json")).unwrap();
        assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.8"));
        // The next promotion keeps 0.3.8 as the fallback.
        put(dir.path(), "next", &signed(&k, "0.3.10", 1));
        assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.10"));
        assert!(dir.path().join("previous.tar.gz").exists(), "0.3.8 kept as the last good bundle");
    }

    #[test]
    fn the_current_bundle_is_kept_as_the_fallback_unless_it_is_the_one_on_trial() {
        let k = key(1);
        for (trial, kept) in [(None, true), (Some("0.3.7"), true), (Some("0.3.8"), false)] {
            let dir = tempfile::tempdir().unwrap();
            put(dir.path(), "current", &signed(&k, "0.3.8", 1));
            let mut s = State::default();
            s.trial = trial.map(str::to_string);
            s.save(dir.path());
            put(dir.path(), "next", &signed(&k, "0.3.9", 1));
            assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.9"));
            assert_eq!(dir.path().join("previous.tar.gz").exists(), kept, "trial {trial:?}");
        }
    }

    fn ota_for(dir: &Path, k: &Key) -> Arc<Ota> {
        let mut o = Ota::new();
        Arc::get_mut(&mut o).unwrap().pubkey = Box::leak(k.pk.clone().into_boxed_str());
        o.init(dir.to_path_buf(), v("0.3.7"));
        o
    }

    #[test]
    fn screens_that_refuse_the_shell_are_dropped_only_while_on_trial() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "next", &signed(&k, "0.3.8", 1));
        assert!(act(dir.path(), &k).is_some());
        ready(dir.path());
        put(dir.path(), "next", &signed(&k, "0.3.9", 1));
        let o = ota_for(dir.path(), &k);
        assert_eq!(o.active().unwrap().meta.version, "0.3.9");
        assert!(!o.refused("0.3.8", "test"), "only the version that is running");
        assert!(o.refused("0.3.9", "test"));
        assert_eq!(o.active().unwrap().meta.version, "0.3.8", "back to the last good one");
        assert!(State::load_checked(dir.path()).unwrap().rejected.contains(&"0.3.9".to_string()));
        // 0.3.8 reported ready long ago: a script can't drop it.
        let o = ota_for(dir.path(), &k);
        assert!(!o.refused("0.3.8", "test"));
        assert_eq!(o.active().unwrap().meta.version, "0.3.8");
    }

    /// A channel on 127.0.0.1: path -> body. `hook` runs when a path is asked for, before the answer (a launch or an
    /// apply happening while a check downloads).
    fn channel_server(files: HashMap<String, Vec<u8>>, hook: Option<(String, Box<dyn Fn() + Send>)>) -> String {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/", l.local_addr().unwrap());
        std::thread::spawn(move || {
            for conn in l.incoming() {
                let Ok(mut c) = conn else { continue };
                let mut buf = [0u8; 4096];
                let n = std::io::Read::read(&mut c, &mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("/").trim_start_matches('/').to_string();
                if let Some((p, f)) = &hook {
                    if *p == path {
                        f();
                    }
                }
                let (status, body) = match files.get(&path) {
                    Some(b) => ("200 OK", b.clone()),
                    None => ("404 Not Found", Vec::new()),
                };
                let head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = std::io::Write::write_all(&mut c, head.as_bytes());
                let _ = std::io::Write::write_all(&mut c, &body);
            }
        });
        base
    }

    fn publish(k: &Key, version: &str, issued: u64, days: u64) -> HashMap<String, Vec<u8>> {
        let a = bundle(version, 1);
        let c = channel_for(k, version, 1, &a, issued, days);
        HashMap::from([("web.json".to_string(), c), (format!("web-{version}.tar.gz"), a)])
    }

    fn run_check(dir: &Path, k: &Key, base: &str, now: u64) -> Result<CheckResult, String> {
        let lock = Mutex::new(());
        tauri::async_runtime::block_on(check(dir, &format!("{base}web.json"), &k.pk, &v("0.3.7"), None, 1, now, &lock))
    }

    #[test]
    fn a_check_stages_a_fresh_newer_bundle_and_refuses_expired_or_replayed_ones() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        let base = channel_server(publish(&k, "0.3.9", T0, 14), None);
        assert!(run_check(dir.path(), &k, &base, T0 + 15 * 86400).unwrap_err().contains("expired"));
        assert!(!dir.path().join("next.tar.gz").exists());
        assert_eq!(run_check(dir.path(), &k, &base, T0 + 60), Ok(CheckResult::Staged { version: "0.3.9".into() }));
        assert_eq!(act(dir.path(), &k).as_deref(), Some("0.3.9"));
        assert_eq!(run_check(dir.path(), &k, &base, T0 + 120), Ok(CheckResult::UpToDate { version: "0.3.9".into() }));
        // A newer version, but under a manifest signed before the one already taken: a held-back signing, replayed.
        let base = channel_server(publish(&k, "0.3.10", T0 - 3600, 14), None);
        assert!(run_check(dir.path(), &k, &base, T0 + 180).unwrap_err().contains("older than one already taken"));
        // Another key's manifest.
        let base = channel_server(publish(&key(2), "0.3.11", T0 + 7200, 14), None);
        assert!(run_check(dir.path(), &k, &base, T0 + 7300).unwrap_err().contains("signature"));
        assert!(!dir.path().join("next.tar.gz").exists());
    }

    #[test]
    fn a_check_never_writes_back_a_state_read_before_its_download() {
        let k = key(1);
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "current", &signed(&k, "0.3.8", 1));
        let mut s = State::default();
        s.floor = Some("0.3.8".into());
        s.save(dir.path());
        // While the archive downloads, an apply puts a bundle on trial and raises the floor and the issued time.
        let d = dir.path().to_path_buf();
        let hook = move || {
            let mut s = State::load_checked(&d).unwrap();
            s.trial = Some("0.3.8".into());
            s.issued = T0 + 100;
            s.save(&d);
        };
        let base = channel_server(publish(&k, "0.3.9", T0 + 200, 14), Some(("web-0.3.9.tar.gz".into(), Box::new(hook))));
        assert_eq!(run_check(dir.path(), &k, &base, T0 + 300), Ok(CheckResult::Staged { version: "0.3.9".into() }));
        let s = State::load_checked(dir.path()).unwrap();
        assert_eq!((s.trial.as_deref(), s.issued), (Some("0.3.8"), T0 + 100), "the apply's state stands");
    }

    #[test]
    fn only_https_or_local_http_urls() {
        let ok = |s: &str| allowed_url(&url::Url::parse(s).unwrap());
        assert!(ok("https://example.com/web/web.json"));
        assert!(ok("http://127.0.0.1:8765/web.json") && ok("http://10.0.2.2:8765/m.json"));
        assert!(!ok("http://example.com/web.json") && !ok("file:///etc/passwd"));
    }
}
