//! T-305 spike: the web layer (the Vite `dist/`) delivered over the air, so an APK is needed only when the Rust shell
//! changes.
//!
//! - **API version.** The shell's commands are its contract with the web layer. [`SHELL_API`] names that contract;
//!   change it whenever a command is added, removed or changes shape. A bundle declares the API it was built against
//!   (`uni-bundle.json` inside the archive); the shell serves it only when the two are equal, and the bundle's own
//!   code checks again at boot (`src/ota.ts`) and asks to be dropped on a mismatch.
//! - **Signature.** A bundle is a `.tar.gz` plus a minisign signature (the `tauri signer sign` format). The public key
//!   is compiled in ([`PUBKEY`]); nothing from the channel or the webview can change it. The signature is checked when
//!   a bundle is downloaded and again at every launch, before a byte of it is served.
//! - **Serving.** [`OtaAssets`] wraps the assets built into the binary. With a verified bundle active it serves the
//!   bundle's files instead, on the same `tauri://` origin, so IPC, capabilities and CSP are unchanged.
//! - **Next launch.** A check downloads a newer bundle into `next.*`; the next launch verifies and promotes it to
//!   `current.*`. A new bundle is on trial until its page reports ready (`ota_ready`); one that is started
//!   [`MAX_UNCONFIRMED_BOOTS`] times without doing so is dropped and never fetched again, and the app falls back to
//!   the built-in web layer.
//! - **Versions.** A bundle carries a release version (`0.1.85`). It is used only while it is newer than the web layer
//!   built into the app, so installing a newer APK always wins over an older bundle.
//!
//! The channel is off unless the build sets `UNI_OTA_CHANNEL` (a URL to `manifest.json`). Release builds don't.

use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Manager, Runtime};

/// The shell's command API, as seen by the web layer. Bump it with any change to the command set or a command's
/// arguments or result. `src/ota.ts` holds the same number (checked by `scripts/ota.test.ts`).
pub const SHELL_API: u32 = 1;

/// The bundle signing public key (minisign, base64 of the `.pub` file, as `tauri signer generate` writes it). Spike
/// key: its private half is on uni-1 only (`~/.config/uni/ota-spike/`).
pub const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDNDRTE3MEI3MzU5MkY0NTMKUldSVDlKSTF0M0RoUEpWb0FtL05UTEJqT1c5bXNGVkUwcnlyNnV2c3BZOHNlbmFMSUxScXhyNWYK";

/// Where this build looks for bundles, if anywhere. Set at build time only.
pub const CHANNEL: Option<&str> = option_env!("UNI_OTA_CHANNEL");

/// A bundle started this many times without reporting ready is dropped.
pub const MAX_UNCONFIRMED_BOOTS: u32 = 2;

const META_FILE: &str = "uni-bundle.json";
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

/// What a bundle says about itself, inside the signed archive.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Meta {
    pub version: String,
    pub api: u32,
}

/// A verified, unpacked bundle.
pub struct Bundle {
    pub meta: Meta,
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

/// Checks `sig` (a `tauri signer sign` signature: base64 of a minisign signature file) over `archive`.
pub fn verify(pubkey: &str, archive: &[u8], sig: &str) -> Result<(), String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let pk_file = String::from_utf8(b64.decode(pubkey.trim()).map_err(|e| format!("public key: {e}"))?)
        .map_err(|e| format!("public key: {e}"))?;
    let pk_line = pk_file.lines().nth(1).ok_or("public key: no key line")?;
    let pk = minisign_verify::PublicKey::from_base64(pk_line.trim()).map_err(|e| format!("public key: {e}"))?;
    let sig_file = String::from_utf8(b64.decode(sig.trim()).map_err(|e| format!("signature: {e}"))?)
        .map_err(|e| format!("signature: {e}"))?;
    let sig = minisign_verify::Signature::decode(&sig_file).map_err(|e| format!("signature: {e}"))?;
    pk.verify(archive, &sig, false).map_err(|e| format!("signature does not match: {e}"))
}

/// Unpacks a `.tar.gz` into memory. Only regular files with plain relative paths; anything else fails the bundle.
pub fn unpack(archive: &[u8]) -> Result<Bundle, String> {
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
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes).map_err(|e| format!("archive: {e}"))?;
        files.insert(parts.join("/"), bytes);
    }
    let meta: Meta = serde_json::from_slice(files.get(META_FILE).ok_or("archive: no uni-bundle.json")?)
        .map_err(|e| format!("uni-bundle.json: {e}"))?;
    let version = semver::Version::parse(&meta.version).map_err(|e| format!("uni-bundle.json version: {e}"))?;
    if !files.contains_key("index.html") {
        return Err("archive: no index.html".into());
    }
    Ok(Bundle { meta, version, files })
}

/// Verifies and unpacks a bundle, then checks it fits this shell: the same API, and newer than the built-in web layer.
pub fn open(pubkey: &str, archive: &[u8], sig: &str, builtin: &semver::Version, shell_api: u32) -> Result<Bundle, String> {
    verify(pubkey, archive, sig)?;
    let bundle = unpack(archive)?;
    if bundle.meta.api != shell_api {
        return Err(format!("bundle {} needs shell API {}, this shell has {shell_api}", bundle.meta.version, bundle.meta.api));
    }
    if bundle.version <= *builtin {
        return Err(format!("bundle {} is not newer than the built-in web layer {builtin}", bundle.meta.version));
    }
    Ok(bundle)
}

/// The bundle directory's bookkeeping (`state.json`).
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct State {
    /// The version on trial: promoted, not yet reported ready.
    pub trial: Option<String>,
    /// Launches of the trial version so far.
    pub boots: u32,
    /// Versions dropped here (failed checks, refused by their own code, never ready). Never fetched again.
    pub rejected: Vec<String>,
    /// The newest version ever promoted here. Nothing older is used again, even if it is signed and the bundle that
    /// set the floor is gone: a channel can't roll a device back to an old bundle.
    pub floor: Option<String>,
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
                if ["current.tar.gz", "next.tar.gz", "floor"].iter().any(|f| dir.join(f).exists()) {
                    Err("bundles or a floor on disk but no state.json".into())
                } else {
                    Ok(State::default())
                }
            }
            Err(e) => Err(format!("state.json: {e}")),
        }
    }
    fn save(&self, dir: &Path) {
        // The floor is also kept on its own (`floor`), so damage to state.json alone can't lose it.
        if let Some(f) = &self.floor {
            if std::fs::write(dir.join("floor.tmp"), f).is_ok() {
                let _ = std::fs::rename(dir.join("floor.tmp"), dir.join("floor"));
            }
        }
        let tmp = dir.join("state.json.tmp");
        if std::fs::write(&tmp, serde_json::to_vec(self).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, dir.join("state.json"));
        }
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

fn read_pair(dir: &Path, name: &str) -> Option<(Vec<u8>, String)> {
    let archive = std::fs::read(dir.join(format!("{name}.tar.gz"))).ok()?;
    let sig = std::fs::read_to_string(dir.join(format!("{name}.tar.gz.sig"))).ok()?;
    Some((archive, sig))
}

fn remove_pair(dir: &Path, name: &str) {
    let _ = std::fs::remove_file(dir.join(format!("{name}.tar.gz")));
    let _ = std::fs::remove_file(dir.join(format!("{name}.tar.gz.sig")));
}

/// Inner version of a stored archive, for bookkeeping when it fails its checks (best effort, unverified).
fn claimed_version(archive: &[u8]) -> Option<String> {
    unpack(archive).ok().map(|b| b.meta.version)
}

/// At launch: promote a staged bundle, then pick the bundle to serve, if any. Every failure falls back to the built-in
/// web layer and is logged.
pub fn activate(dir: &Path, pubkey: &str, builtin: &semver::Version, shell_api: u32) -> Option<Bundle> {
    let mut state = match State::load_checked(dir) {
        Ok(s) => s,
        Err(e) => {
            // Start over without the bundles, keeping the newest version they claim as the floor (unverified, so it
            // can only make the floor stricter).
            let floor = ["current", "next"]
                .iter()
                .filter_map(|n| read_pair(dir, n).and_then(|(a, _)| claimed_version(&a)))
                .chain(std::fs::read_to_string(dir.join("floor")).ok().map(|f| f.trim().to_string()))
                .filter_map(|v| semver::Version::parse(&v).ok())
                .max();
            log(format!("{e}; dropping installed bundles, built-in web layer {builtin}"));
            remove_pair(dir, "current");
            remove_pair(dir, "next");
            State { floor: floor.map(|v| v.to_string()), ..State::default() }.save(dir);
            return None;
        }
    };
    if let Some((archive, sig)) = read_pair(dir, "next") {
        match open(pubkey, &archive, &sig, builtin, shell_api).and_then(|b| match state.floor() {
            Some(f) if b.version <= f => Err(format!("bundle {} is not newer than {f}, already used here", b.meta.version)),
            _ => Ok(b),
        }) {
            Ok(b) => {
                let ok = std::fs::rename(dir.join("next.tar.gz"), dir.join("current.tar.gz")).is_ok()
                    && std::fs::rename(dir.join("next.tar.gz.sig"), dir.join("current.tar.gz.sig")).is_ok();
                if ok {
                    log(format!("promoted staged bundle {} (on trial)", b.meta.version));
                    state.trial = Some(b.meta.version.clone());
                    state.boots = 0;
                    state.floor = Some(b.meta.version.clone());
                } else {
                    log("could not promote the staged bundle");
                    remove_pair(dir, "next");
                }
            }
            Err(e) => {
                log(format!("staged bundle refused: {e}"));
                if let Some(v) = claimed_version(&archive) {
                    state.reject(&v);
                }
                remove_pair(dir, "next");
            }
        }
    }
    let chosen = match read_pair(dir, "current") {
        None => None,
        Some((archive, sig)) => match open(pubkey, &archive, &sig, builtin, shell_api).and_then(|b| match state.floor() {
            Some(f) if b.version < f => Err(format!("bundle {} is older than {f}, already used here", b.meta.version)),
            _ => Ok(b),
        }) {
            Ok(b) if state.trial.as_deref() == Some(b.meta.version.as_str()) && state.boots >= MAX_UNCONFIRMED_BOOTS => {
                log(format!("bundle {} started {} times without reporting ready; dropped", b.meta.version, state.boots));
                state.reject(&b.meta.version);
                remove_pair(dir, "current");
                None
            }
            Ok(b) => {
                if state.trial.as_deref() == Some(b.meta.version.as_str()) {
                    state.boots += 1;
                }
                log(format!("serving bundle {} (shell API {shell_api}, built-in {builtin})", b.meta.version));
                Some(b)
            }
            Err(e) => {
                log(format!("current bundle refused, using the built-in web layer: {e}"));
                remove_pair(dir, "current");
                None
            }
        },
    };
    state.save(dir);
    if chosen.is_none() {
        log(format!("serving the built-in web layer {builtin}"));
    }
    chosen
}

/// The channel's pointer to its newest bundle. Unsigned: everything it points at is checked against the signature.
#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub version: String,
    pub api: u32,
    pub archive: String,
    pub signature: String,
}

/// Bundle URLs: https, or plain http to this machine / the emulator's host only (local spikes).
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
    let resp = client.get(u.clone()).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
    if resp.content_length().is_some_and(|n| n > max) {
        return Err("download too large".into());
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max {
        return Err("download too large".into());
    }
    Ok(bytes.to_vec())
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

/// Fetches the channel's manifest and, when it names a newer bundle this shell can run, downloads, verifies and
/// stages it as `next.*` for the next launch.
pub async fn check(
    dir: &Path,
    channel: &str,
    pubkey: &str,
    builtin: &semver::Version,
    active: Option<&semver::Version>,
    shell_api: u32,
) -> Result<CheckResult, String> {
    let base = url::Url::parse(channel).map_err(|e| format!("channel: {e}"))?;
    uni_core::init_crypto();
    let client = uni_core::media::https_client_following_redirects(Duration::from_secs(30)).map_err(|e| e.to_string())?;
    let manifest: Manifest =
        serde_json::from_slice(&fetch(&client, &base, 64 * 1024).await?).map_err(|e| format!("manifest: {e}"))?;
    let offered = semver::Version::parse(&manifest.version).map_err(|e| format!("manifest version: {e}"))?;
    let state = State::load_checked(dir)?;
    let staged = read_pair(dir, "next").and_then(|(a, _)| claimed_version(&a)).and_then(|v| semver::Version::parse(&v).ok());
    if let Some(newest) = not_new(&state, builtin, active, staged.as_ref(), &offered) {
        return Ok(CheckResult::UpToDate { version: newest.to_string() });
    }
    if manifest.api != shell_api {
        log(format!("bundle {offered} needs shell API {}, this shell has {shell_api}: needs a newer app", manifest.api));
        return Ok(CheckResult::NeedsNewerApp { version: manifest.version, api: manifest.api });
    }
    let archive = fetch(&client, &base.join(&manifest.archive).map_err(|e| e.to_string())?, MAX_ARCHIVE_BYTES).await?;
    let sig = String::from_utf8(fetch(&client, &base.join(&manifest.signature).map_err(|e| e.to_string())?, 16 * 1024).await?)
        .map_err(|_| "signature is not text".to_string())?;
    let bundle = open(pubkey, &archive, &sig, builtin, shell_api)?;
    if bundle.meta.version != manifest.version {
        return Err(format!("manifest says {}, the signed bundle says {}", manifest.version, bundle.meta.version));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // state.json first: bundles on disk without it read as lost state at the next launch.
    state.save(dir);
    for (name, bytes) in [("next.tar.gz.sig.tmp", sig.as_bytes()), ("next.tar.gz.tmp", archive.as_slice())] {
        std::fs::write(dir.join(name), bytes).map_err(|e| e.to_string())?;
    }
    // The archive lands last: a launch that sees next.tar.gz also sees its signature.
    std::fs::rename(dir.join("next.tar.gz.sig.tmp"), dir.join("next.tar.gz.sig")).map_err(|e| e.to_string())?;
    std::fs::rename(dir.join("next.tar.gz.tmp"), dir.join("next.tar.gz")).map_err(|e| e.to_string())?;
    log(format!("staged bundle {} for the next launch", bundle.meta.version));
    Ok(CheckResult::Staged { version: bundle.meta.version })
}

/// Shared between the asset provider and the commands.
pub struct Ota {
    chosen: OnceLock<Option<Bundle>>,
    ready: (Mutex<bool>, Condvar),
    /// Set when the active bundle is refused at runtime: everything after is served from the built-in assets.
    dropped: AtomicBool,
    dir: OnceLock<PathBuf>,
    builtin: OnceLock<semver::Version>,
    wait: Duration,
}

impl Ota {
    fn new() -> Arc<Ota> {
        Arc::new(Ota {
            chosen: OnceLock::new(),
            ready: (Mutex::new(false), Condvar::new()),
            dropped: AtomicBool::new(false),
            dir: OnceLock::new(),
            builtin: OnceLock::new(),
            wait: SETUP_WAIT,
        })
    }

    fn init(&self, dir: PathBuf, builtin: semver::Version, pubkey: &str) {
        let _ = std::fs::create_dir_all(&dir);
        if self.chosen.get().is_some() {
            log("setup came after the first page request; the built-in web layer stays for this launch");
        } else if self.chosen.set(activate(&dir, pubkey, &builtin, SHELL_API)).is_err() {
            // A page request timed out while this ran and fixed the built-in layer; the bundle stays for next launch.
            log("setup finished after the first page request timed out; the built-in web layer stays for this launch");
        }
        let _ = self.dir.set(dir);
        let _ = self.builtin.set(builtin);
        let (lock, cvar) = &self.ready;
        *lock.lock().unwrap_or_else(|e| e.into_inner()) = true;
        cvar.notify_all();
    }

    /// The bundle being served, once launch has chosen. Waits briefly for that choice. On timeout the built-in layer
    /// is fixed for the whole launch, so one page never mixes built-in and bundle files.
    fn active(&self) -> Option<&Bundle> {
        if self.dropped.load(Ordering::Acquire) {
            return None;
        }
        if self.chosen.get().is_none() {
            let (lock, cvar) = &self.ready;
            let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            let _ = cvar.wait_timeout_while(guard, self.wait, |ready| !*ready);
        }
        self.chosen.get_or_init(|| None).as_ref()
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
            Ok(d) => self.ota.init(d.join("ota"), builtin, PUBKEY),
            Err(e) => {
                log(format!("no app data dir ({e}); serving the built-in web layer"));
                let _ = self.ota.chosen.set(None);
                let (lock, cvar) = &self.ota.ready;
                *lock.lock().unwrap_or_else(|e| e.into_inner()) = true;
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
    /// The bundle being served, if not the built-in web layer.
    active: Option<Meta>,
    channel: Option<&'static str>,
}

#[tauri::command]
pub fn ota_status(app: tauri::AppHandle, ota: tauri::State<'_, Arc<Ota>>) -> Status {
    Status {
        shell_api: SHELL_API,
        builtin: app.package_info().version.to_string(),
        active: ota.active().map(|b| b.meta.clone()),
        channel: CHANNEL,
    }
}

/// The page booted: the bundle on trial is kept.
#[tauri::command]
pub fn ota_ready(ota: tauri::State<'_, Arc<Ota>>) {
    let (Some(dir), Some(b)) = (ota.dir.get(), ota.active()) else { return };
    // Unreadable now: leave it; the next launch fails closed.
    let Ok(mut state) = State::load_checked(dir) else { return };
    if state.trial.as_deref() == Some(b.meta.version.as_str()) {
        state.trial = None;
        state.boots = 0;
        state.save(dir);
        log(format!("bundle {} reported ready; kept", b.meta.version));
    }
}

/// The bundle's own code refused this shell (its API differs). Drop it and reload with the built-in web layer.
#[tauri::command]
pub fn ota_reject(window: tauri::WebviewWindow, ota: tauri::State<'_, Arc<Ota>>, reason: String) -> Result<(), String> {
    let (Some(dir), Some(b)) = (ota.dir.get(), ota.active()) else { return Ok(()) };
    log(format!("bundle {} refused by its own code: {reason}; reloading the built-in web layer", b.meta.version));
    if let Ok(mut state) = State::load_checked(dir) {
        state.reject(&b.meta.version);
        state.save(dir);
    }
    remove_pair(dir, "current");
    ota.dropped.store(true, Ordering::Release);
    window.eval("location.reload()").map_err(|e| e.to_string())
}

/// Look for a newer bundle on the build's channel and stage it for the next launch.
#[tauri::command]
pub async fn ota_check(ota: tauri::State<'_, Arc<Ota>>) -> Result<CheckResult, String> {
    let Some(channel) = CHANNEL else { return Ok(CheckResult::Off) };
    let (Some(dir), Some(builtin)) = (ota.dir.get(), ota.builtin.get()) else { return Err("not set up".into()) };
    let active = ota.active().map(|b| b.version.clone());
    let r = check(dir, channel, PUBKEY, builtin, active.as_ref(), SHELL_API).await;
    if let Err(e) = &r {
        log(format!("check failed: {e}"));
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Key {
        pk: String,
        kp: minisign::KeyPair,
    }

    fn key() -> Key {
        let kp = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let pk = base64::engine::general_purpose::STANDARD.encode(kp.pk.to_box().unwrap().to_string());
        Key { pk, kp }
    }

    fn sign(k: &Key, data: &[u8]) -> String {
        let sig = minisign::sign(Some(&k.kp.pk), &k.kp.sk, std::io::Cursor::new(data), None, None).unwrap();
        base64::engine::general_purpose::STANDARD.encode(sig.to_string())
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

    fn v(s: &str) -> semver::Version {
        semver::Version::parse(s).unwrap()
    }

    /// As the app does it: state.json exists (launch writes it) before any bundle lands.
    fn put(dir: &Path, name: &str, archive: &[u8], sig: &str) {
        if !dir.join("state.json").exists() {
            State::default().save(dir);
        }
        std::fs::write(dir.join(format!("{name}.tar.gz")), archive).unwrap();
        std::fs::write(dir.join(format!("{name}.tar.gz.sig")), sig).unwrap();
    }

    #[test]
    fn a_signed_newer_bundle_for_this_api_opens() {
        let k = key();
        let a = bundle("0.1.85", 1);
        let b = open(&k.pk, &a, &sign(&k, &a), &v("0.1.84"), 1).unwrap();
        assert_eq!(b.meta, Meta { version: "0.1.85".into(), api: 1 });
        assert_eq!(b.get("/index.html"), Some(&b"<html>web 0.1.85</html>"[..]));
        assert_eq!(b.get("assets/app.js"), Some(&b"1"[..]));
    }

    #[test]
    fn a_tampered_bundle_or_another_key_is_refused() {
        let (k, other) = (key(), key());
        let a = bundle("0.1.85", 1);
        let sig = sign(&k, &a);
        let mut tampered = a.clone();
        let n = tampered.len();
        tampered[n / 2] ^= 1;
        assert!(open(&k.pk, &tampered, &sig, &v("0.1.84"), 1).unwrap_err().contains("signature"));
        assert!(open(&other.pk, &a, &sig, &v("0.1.84"), 1).unwrap_err().contains("signature"));
        assert!(open(&k.pk, &a, "not a signature", &v("0.1.84"), 1).is_err());
    }

    #[test]
    fn the_production_key_parses() {
        let k = key();
        let a = bundle("0.1.85", 1);
        // Signed by a test key, so the pinned key must refuse it (and must parse to get that far).
        assert!(verify(PUBKEY, &a, &sign(&k, &a)).unwrap_err().contains("signature does not match"));
    }

    #[test]
    fn another_api_or_an_older_bundle_is_refused() {
        let k = key();
        let a = bundle("0.1.85", 2);
        assert!(open(&k.pk, &a, &sign(&k, &a), &v("0.1.84"), 1).unwrap_err().contains("shell API"));
        let a = bundle("0.1.84", 1);
        assert!(open(&k.pk, &a, &sign(&k, &a), &v("0.1.84"), 1).unwrap_err().contains("not newer"));
    }

    #[test]
    fn unsafe_paths_and_missing_metadata_are_refused() {
        let meta = br#"{"version":"0.1.85","api":1}"#;
        let a = archive(&[("uni-bundle.json", meta), ("index.html", b"x"), ("../evil", b"x")]);
        assert!(unpack(&a).unwrap_err().contains("unsafe path"));
        let a = archive(&[("index.html", b"x")]);
        assert!(unpack(&a).unwrap_err().contains("uni-bundle.json"));
    }

    #[test]
    fn launch_promotes_a_staged_bundle_and_serves_it() {
        let k = key();
        let dir = tempfile::tempdir().unwrap();
        assert!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).is_none(), "nothing installed: built-in");
        let a = bundle("0.1.85", 1);
        put(dir.path(), "next", &a, &sign(&k, &a));
        let b = activate(dir.path(), &k.pk, &v("0.1.84"), 1).unwrap();
        assert_eq!(b.meta.version, "0.1.85");
        assert!(!dir.path().join("next.tar.gz").exists() && dir.path().join("current.tar.gz").exists());
        assert_eq!(State::load_checked(dir.path()).unwrap().trial.as_deref(), Some("0.1.85"));
    }

    #[test]
    fn a_bundle_that_never_reports_ready_is_dropped() {
        let k = key();
        let dir = tempfile::tempdir().unwrap();
        let a = bundle("0.1.85", 1);
        put(dir.path(), "next", &a, &sign(&k, &a));
        for _ in 0..MAX_UNCONFIRMED_BOOTS {
            assert!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).is_some());
        }
        assert!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).is_none(), "never ready: back to built-in");
        assert_eq!(State::load_checked(dir.path()).unwrap().rejected, vec!["0.1.85".to_string()]);
        assert!(!dir.path().join("current.tar.gz").exists());
    }

    #[test]
    fn a_ready_bundle_stays_and_a_newer_app_wins() {
        let k = key();
        let dir = tempfile::tempdir().unwrap();
        let a = bundle("0.1.85", 1);
        put(dir.path(), "current", &a, &sign(&k, &a));
        // Not on trial (already reported ready): served on every launch.
        for _ in 0..5 {
            assert!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).is_some());
        }
        // An APK update to 0.1.85 brings the same web layer built in; the bundle is no longer newer.
        assert!(activate(dir.path(), &k.pk, &v("0.1.85"), 1).is_none());
    }

    #[test]
    fn a_tampered_installed_bundle_falls_back_at_launch() {
        let k = key();
        let dir = tempfile::tempdir().unwrap();
        let a = bundle("0.1.85", 1);
        let sig = sign(&k, &a);
        let mut t = a.clone();
        let n = t.len();
        t[n / 2] ^= 1;
        put(dir.path(), "current", &t, &sig);
        assert!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).is_none());
    }

    #[test]
    fn an_older_signed_bundle_is_never_used_again() {
        let k = key();
        let dir = tempfile::tempdir().unwrap();
        let (a85, a86) = (bundle("0.1.85", 1), bundle("0.1.86", 1));
        put(dir.path(), "next", &a86, &sign(&k, &a86));
        assert_eq!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).unwrap().meta.version, "0.1.86");
        // 0.1.86 is lost (cleared, refused later); the channel replays the older 0.1.85, validly signed.
        remove_pair(dir.path(), "current");
        put(dir.path(), "next", &a85, &sign(&k, &a85));
        assert!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).is_none());
        put(dir.path(), "current", &a85, &sign(&k, &a85));
        assert!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).is_none());
        // And a check won't fetch it.
        let state = State::load_checked(dir.path()).unwrap();
        assert_eq!(state.floor.as_deref(), Some("0.1.86"));
        assert!(not_new(&state, &v("0.1.84"), None, None, &v("0.1.85")).is_some());
        assert!(not_new(&state, &v("0.1.84"), None, None, &v("0.1.87")).is_none());
    }

    #[test]
    fn a_lost_or_corrupt_state_fails_closed_and_keeps_the_floor() {
        let k = key();
        let (a85, a86) = (bundle("0.1.85", 1), bundle("0.1.86", 1));
        for damage in ["corrupt", "missing"] {
            let dir = tempfile::tempdir().unwrap();
            put(dir.path(), "next", &a86, &sign(&k, &a86));
            assert!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).is_some());
            match damage {
                "corrupt" => std::fs::write(dir.path().join("state.json"), b"{not json").unwrap(),
                _ => std::fs::remove_file(dir.path().join("state.json")).unwrap(),
            }
            assert!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).is_none(), "{damage}: built-in");
            assert!(!dir.path().join("current.tar.gz").exists(), "{damage}: bundles dropped");
            assert_eq!(State::load_checked(dir.path()).unwrap().floor.as_deref(), Some("0.1.86"), "{damage}: floor kept");
            put(dir.path(), "next", &a85, &sign(&k, &a85));
            assert!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).is_none(), "{damage}: the older one stays out");
        }
        // state.json damaged after the bundle that set the floor is already gone: the floor file still holds it.
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "next", &a86, &sign(&k, &a86));
        assert!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).is_some());
        remove_pair(dir.path(), "current");
        std::fs::write(dir.path().join("state.json"), b"{not json").unwrap();
        assert!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).is_none());
        assert_eq!(State::load_checked(dir.path()).unwrap().floor.as_deref(), Some("0.1.86"));
        // A floor that isn't a version is damage too.
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "current", &a85, &sign(&k, &a85));
        std::fs::write(dir.path().join("state.json"), br#"{"floor":"not-a-version"}"#).unwrap();
        assert!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).is_none());
        assert!(!dir.path().join("current.tar.gz").exists());
        assert_eq!(State::load_checked(dir.path()).unwrap().floor.as_deref(), Some("0.1.85"));
    }

    #[test]
    fn a_page_request_before_setup_fixes_the_built_in_layer_for_the_launch() {
        let k = key();
        let dir = tempfile::tempdir().unwrap();
        let a = bundle("0.1.85", 1);
        put(dir.path(), "current", &a, &sign(&k, &a));
        let mut late = Ota::new();
        Arc::get_mut(&mut late).unwrap().wait = Duration::from_millis(10);
        assert!(late.active().is_none(), "setup hasn't run: built-in");
        late.init(dir.path().to_path_buf(), v("0.1.84"), &k.pk);
        assert!(late.active().is_none(), "still built-in for this launch");
        let on_time = Ota::new();
        on_time.init(dir.path().to_path_buf(), v("0.1.84"), &k.pk);
        assert_eq!(on_time.active().unwrap().meta.version, "0.1.85");
    }

    /// A channel served over real HTTP on 127.0.0.1, so tests run the shell's own `check`.
    struct Channel {
        dir: tempfile::TempDir,
        url: String,
    }

    fn channel() -> Channel {
        use std::io::Write as _;
        let dir = tempfile::tempdir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/manifest.json", listener.local_addr().unwrap().port());
        let root = dir.path().to_path_buf();
        std::thread::spawn(move || {
            for mut s in listener.incoming().flatten() {
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("/").trim_start_matches('/').to_string();
                let (code, body) = match std::fs::read(root.join(&path)) {
                    Ok(b) => ("200 OK", b),
                    Err(_) => ("404 Not Found", Vec::new()),
                };
                let _ = write!(s, "HTTP/1.1 {code}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = s.write_all(&body);
            }
        });
        Channel { dir, url }
    }

    impl Channel {
        /// Publishes a signed bundle as the channel's newest release.
        fn publish(&self, k: &Key, version: &str) {
            let a = bundle(version, 1);
            let name = format!("web-{version}.tar.gz");
            std::fs::write(self.dir.path().join(&name), &a).unwrap();
            std::fs::write(self.dir.path().join(format!("{name}.sig")), sign(k, &a)).unwrap();
            let m = format!(r#"{{"version":"{version}","api":1,"archive":"{name}","signature":"{name}.sig"}}"#);
            std::fs::write(self.dir.path().join("manifest.json"), m).unwrap();
        }
        /// What the channel serves now, to serve again later (a replay).
        fn snapshot(&self) -> HashMap<String, Vec<u8>> {
            std::fs::read_dir(self.dir.path())
                .unwrap()
                .flatten()
                .map(|e| (e.file_name().to_string_lossy().to_string(), std::fs::read(e.path()).unwrap()))
                .collect()
        }
        fn serve_again(&self, files: &HashMap<String, Vec<u8>>) {
            for (n, b) in files {
                std::fs::write(self.dir.path().join(n), b).unwrap();
            }
        }
    }

    fn run_check(dir: &Path, ch: &Channel, k: &Key, builtin: &str) -> Result<CheckResult, String> {
        tauri::async_runtime::block_on(check(dir, &ch.url, &k.pk, &v(builtin), None, 1))
    }

    #[test]
    fn after_double_damage_the_channel_cannot_replay_an_older_release() {
        let (k, ch, dir) = (key(), channel(), tempfile::tempdir().unwrap());
        ch.publish(&k, "0.1.85");
        let old = ch.snapshot();
        ch.publish(&k, "0.1.86");
        assert_eq!(run_check(dir.path(), &ch, &k, "0.1.84"), Ok(CheckResult::Staged { version: "0.1.86".into() }));
        assert_eq!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).unwrap().meta.version, "0.1.86");
        // The bundle is lost, then both of the floor's records are damaged (Codex r5 P2).
        remove_pair(dir.path(), "current");
        std::fs::write(dir.path().join("state.json"), b"{not json").unwrap();
        std::fs::write(dir.path().join("floor"), b"\xff garbage").unwrap();
        assert!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).is_none());
        // The channel, or anyone between it and the device, serves the older release again. It is validly signed.
        ch.serve_again(&old);
        let r = run_check(dir.path(), &ch, &k, "0.1.84");
        assert!(!matches!(r, Ok(CheckResult::Staged { .. })), "the older release was staged: {r:?}");
        assert!(activate(dir.path(), &k.pk, &v("0.1.84"), 1).is_none());
    }

    #[test]
    fn a_wiped_device_does_not_take_a_release_the_channel_stopped_signing() {
        let (k, ch, dir) = (key(), channel(), tempfile::tempdir().unwrap());
        // 0.1.85 was published long ago and superseded; the device has no record of anything (data wiped).
        ch.publish(&k, "0.1.85");
        let r = run_check(dir.path(), &ch, &k, "0.1.84");
        assert!(!matches!(r, Ok(CheckResult::Staged { .. })), "a long-superseded release was staged: {r:?}");
    }

    #[test]
    fn a_manifest_the_pinned_key_did_not_sign_is_refused() {
        let (k, other, ch, dir) = (key(), key(), channel(), tempfile::tempdir().unwrap());
        // A validly signed bundle, but the pointer to it comes from someone else.
        ch.publish(&k, "0.1.85");
        let forged = ch.snapshot();
        ch.publish(&other, "0.1.85");
        let mut files = ch.snapshot();
        files.insert("web-0.1.85.tar.gz.sig".into(), forged["web-0.1.85.tar.gz.sig"].clone());
        ch.serve_again(&files);
        let r = run_check(dir.path(), &ch, &k, "0.1.84");
        assert!(!matches!(r, Ok(CheckResult::Staged { .. })), "staged from a manifest the key did not sign: {r:?}");
    }

    #[test]
    fn only_https_or_local_http_urls() {
        let ok = |s: &str| allowed_url(&url::Url::parse(s).unwrap());
        assert!(ok("https://example.com/web/manifest.json"));
        assert!(ok("http://127.0.0.1:8765/manifest.json") && ok("http://10.0.2.2:8765/m.json"));
        assert!(!ok("http://example.com/manifest.json") && !ok("file:///etc/passwd"));
    }
}
