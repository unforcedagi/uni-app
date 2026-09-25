//! Identity loading. The private key is never printed or logged.
//!
//! Resolution order (first hit wins):
//! 1. `UNI_NSEC` env var (hex or `nsec1…`).
//! 2. Device keys installed in memory with [`set_device_keys`] — how the
//!    Android app hands over the key it decrypted from Android Keystore
//!    (the `keyring` crate has no Android backend).
//! 3. OS keyring entry `service = "uni-app"`, `account = "nsec"` (skipped
//!    when `UNI_NO_KEYRING` is set, as on Android).
//! 4. If `allow_ephemeral` is set: a fresh throwaway key (for connection tests).
//!
//! [`init_keyring_key`] is the write path: it generates a new key and stores
//! it in the keyring (same `keyring` crate and service/account layout Buzz
//! desktop uses), returning only the public key.

use nostr::nips::nip19::ToBech32;
use nostr::{Keys, PublicKey};

use crate::{Error, Result};

/// Where the key came from (safe to log).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySource {
    /// `UNI_NSEC` env var.
    Env,
    /// OS keyring (`uni-app` / `nsec`).
    Keyring,
    /// Installed by the host app via [`set_device_keys`] (Android Keystore).
    Device,
    /// Freshly generated throwaway key.
    Ephemeral,
}

/// Keyring service name.
pub const KEYRING_SERVICE: &str = "uni-app";
/// Keyring account name for the Nostr secret key.
pub const KEYRING_ACCOUNT: &str = "nsec";
/// Env var name for the Nostr secret key.
pub const ENV_NSEC: &str = "UNI_NSEC";

/// Outcome of [`init_keyring_key`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyInit {
    /// Public key of the key now in the keyring.
    pub pubkey: PublicKey,
    /// `true` if a new key was generated and stored; `false` if one already
    /// existed and was left untouched.
    pub created: bool,
}

impl KeyInit {
    /// Hex pubkey.
    pub fn hex(&self) -> String {
        self.pubkey.to_hex()
    }
    /// `npub1…` pubkey.
    pub fn npub(&self) -> String {
        self.pubkey
            .to_bech32()
            .expect("bech32 encoding of a public key cannot fail")
    }
}

static DEVICE_KEYS: std::sync::Mutex<Option<Keys>> = std::sync::Mutex::new(None);

/// Install the device identity for this process (e.g. decrypted from
/// Android Keystore at startup, or just received by pairing).
pub fn set_device_keys(keys: Keys) {
    *DEVICE_KEYS.lock().unwrap_or_else(|e| e.into_inner()) = Some(keys);
}

/// Drop the in-memory device identity.
pub fn clear_device_keys() {
    *DEVICE_KEYS.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// `true` if [`set_device_keys`] installed a key.
pub fn has_device_keys() -> bool {
    DEVICE_KEYS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some()
}

/// Load keys per the resolution order above.
pub fn load_keys(allow_ephemeral: bool) -> Result<(Keys, KeySource)> {
    if let Ok(v) = std::env::var(ENV_NSEC) {
        let v = v.trim();
        if !v.is_empty() {
            let keys = Keys::parse(v).map_err(|_| {
                Error::Identity(format!("{ENV_NSEC} is set but not a valid hex/nsec key"))
            })?;
            return Ok((keys, KeySource::Env));
        }
    }

    if let Some(keys) = DEVICE_KEYS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    {
        return Ok((keys, KeySource::Device));
    }

    if !skip_keyring() {
        match read_keyring() {
            Ok(Some(keys)) => return Ok((keys, KeySource::Keyring)),
            Ok(None) => {}
            Err(e) => {
                tracing::warn!("keyring lookup failed ({e}); falling through");
            }
        }
    }

    if allow_ephemeral {
        return Ok((Keys::generate(), KeySource::Ephemeral));
    }

    Err(Error::Identity(format!(
        "no key found: set {ENV_NSEC}, or run `key init` to create one in the keyring ({KEYRING_SERVICE}/{KEYRING_ACCOUNT})"
    )))
}

/// Env var that disables the keyring lookup (`UNI_NO_KEYRING=1`).
///
/// Tests set this: an unsigned test binary reading the macOS Keychain
/// triggers an interactive access prompt, which hangs a headless run.
pub const ENV_NO_KEYRING: &str = "UNI_NO_KEYRING";

fn skip_keyring() -> bool {
    std::env::var(ENV_NO_KEYRING)
        .map(|v| !v.trim().is_empty() && v.trim() != "0")
        .unwrap_or(false)
}

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| Error::Identity(format!("keyring: {e}")))
}

/// Read the keyring key. `Ok(None)` when no entry exists.
fn read_keyring() -> Result<Option<Keys>> {
    match entry()?.get_password() {
        Ok(secret) => {
            let keys = Keys::parse(secret.trim())
                .map_err(|_| Error::Identity("keyring nsec is not a valid key".into()))?;
            Ok(Some(keys))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(Error::Identity(format!("keyring: {e}"))),
    }
}

/// Public key of the keyring entry, if one exists. Never returns the secret.
pub fn keyring_pubkey() -> Result<Option<PublicKey>> {
    Ok(read_keyring()?.map(|k| k.public_key()))
}

/// Store a paired account key in the keyring, replacing any existing entry.
/// Returns only the public key after a read-back check.
pub fn store_keyring_nsec(nsec: &str) -> Result<PublicKey> {
    let keys = Keys::parse(nsec.trim()).map_err(|_| Error::Identity("not a valid nsec".into()))?;
    let canonical = zeroize::Zeroizing::new(
        keys.secret_key()
            .to_bech32()
            .map_err(|e| Error::Identity(format!("encoding key: {e}")))?,
    );
    entry()?
        .set_password(&canonical)
        .map_err(|e| Error::Identity(format!("keyring write: {e}")))?;
    match read_keyring()? {
        Some(k) if k.public_key() == keys.public_key() => Ok(keys.public_key()),
        _ => Err(Error::Identity(
            "keyring read-back did not return the key just stored".into(),
        )),
    }
}

/// Delete the keyring entry ("forget this device key"). Missing is fine.
pub fn forget_keyring_key() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(Error::Identity(format!("keyring delete: {e}"))),
    }
}

/// Ensure a persistent app key exists in the keyring.
///
/// If an entry already exists it is left as is (`created: false`); otherwise
/// a new key is generated and stored as `nsec1…`. The secret never leaves
/// this function except into the keyring.
pub fn init_keyring_key() -> Result<KeyInit> {
    if let Some(keys) = read_keyring()? {
        return Ok(KeyInit {
            pubkey: keys.public_key(),
            created: false,
        });
    }
    let keys = Keys::generate();
    let nsec = keys
        .secret_key()
        .to_bech32()
        .map_err(|e| Error::Identity(format!("encoding key: {e}")))?;
    entry()?
        .set_password(&nsec)
        .map_err(|e| Error::Identity(format!("keyring write: {e}")))?;
    // Read back to prove the round trip before reporting success.
    match read_keyring()? {
        Some(k) if k.public_key() == keys.public_key() => Ok(KeyInit {
            pubkey: keys.public_key(),
            created: true,
        }),
        _ => Err(Error::Identity(
            "keyring read-back did not return the key just stored".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ephemeral_then_device_keys() {
        // Never touch the real keyring from a test: an unsigned test binary
        // reading the macOS Keychain pops an interactive prompt and hangs.
        // One test owns the process-global device slot to avoid races.
        std::env::remove_var(ENV_NSEC);
        std::env::set_var(ENV_NO_KEYRING, "1");
        clear_device_keys();
        let (_k, src) = load_keys(true).expect("ephemeral key");
        assert_eq!(src, KeySource::Ephemeral);
        assert!(load_keys(false).is_err());

        let dev = Keys::generate();
        set_device_keys(dev.clone());
        assert!(has_device_keys());
        let (k, src) = load_keys(false).expect("device key");
        assert_eq!(src, KeySource::Device);
        assert_eq!(k.public_key(), dev.public_key());
        clear_device_keys();
        assert!(!has_device_keys());
        assert!(load_keys(false).is_err());
    }

    #[test]
    fn key_init_reports_npub_and_hex_only() {
        let keys = Keys::generate();
        let ki = KeyInit {
            pubkey: keys.public_key(),
            created: true,
        };
        assert!(ki.npub().starts_with("npub1"));
        assert_eq!(ki.hex().len(), 64);
        // The debug form carries no secret material.
        let dbg = format!("{ki:?}");
        assert!(!dbg.contains("nsec"));
        assert!(!dbg.contains(&keys.secret_key().to_secret_hex()));
    }
}
