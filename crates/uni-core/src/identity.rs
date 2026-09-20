//! Identity loading. The private key is never printed or logged.
//!
//! Resolution order (first hit wins):
//! 1. `UNI_NSEC` env var (hex or `nsec1…`).
//! 2. macOS keyring entry `service = "uni-app"`, `account = "nsec"`.
//! 3. If `allow_ephemeral` is set: a fresh throwaway key (for connection tests).

use nostr::Keys;

use crate::{Error, Result};

/// Where the key came from (safe to log).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySource {
    /// `UNI_NSEC` env var.
    Env,
    /// macOS keyring (`uni-app` / `nsec`).
    Keyring,
    /// Freshly generated throwaway key.
    Ephemeral,
}

/// Keyring service name.
pub const KEYRING_SERVICE: &str = "uni-app";
/// Keyring account name for the Nostr secret key.
pub const KEYRING_ACCOUNT: &str = "nsec";
/// Env var name for the Nostr secret key.
pub const ENV_NSEC: &str = "UNI_NSEC";

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

    match keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).and_then(|e| e.get_password()) {
        Ok(secret) => {
            let keys = Keys::parse(secret.trim())
                .map_err(|_| Error::Identity("keyring nsec is not a valid key".into()))?;
            return Ok((keys, KeySource::Keyring));
        }
        Err(keyring::Error::NoEntry) => {}
        Err(e) => {
            tracing::warn!("keyring lookup failed ({e}); falling through");
        }
    }

    if allow_ephemeral {
        return Ok((Keys::generate(), KeySource::Ephemeral));
    }

    Err(Error::Identity(format!(
        "no key found: set {ENV_NSEC} or store one in the keyring ({KEYRING_SERVICE}/{KEYRING_ACCOUNT})"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ephemeral_when_allowed_and_env_unset() {
        // Do not touch the real keyring in tests beyond a NoEntry-style miss;
        // `allow_ephemeral` guarantees a key comes back either way.
        std::env::remove_var(ENV_NSEC);
        let (_k, src) = load_keys(true).expect("ephemeral key");
        assert!(matches!(src, KeySource::Ephemeral | KeySource::Keyring));
    }
}
