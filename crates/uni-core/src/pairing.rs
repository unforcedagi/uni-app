//! NIP-AB device pairing, **target** role: receive this account's key from
//! Buzz desktop ("Settings → pair mobile device") via its `nostrpair://` link.
//!
//! All protocol crypto lives in `buzz_core::pairing::PairingSession`; this
//! module is only the relay I/O driver, mirroring the reference CLI
//! (`buzz-pairing-cli` `cmd_target`). It is split in two so a UI can show the
//! 6-digit code in between:
//!
//! 1. [`start`]: decode the link, connect to the pairing relay (answering a
//!    NIP-42 challenge with the *ephemeral* session key), subscribe to
//!    kind-24134 events p-tagged to us and wait for EOSE (race fix), then
//!    publish the offer. Returns a [`PendingPairing`] carrying the SAS code,
//!    which the target already knows from the QR secret + ECDH.
//! 2. [`PendingPairing::confirm`] (after the user says the codes match): wait
//!    for the source's `sas-confirm` (transcript hash verified by buzz-core),
//!    accept it, wait for the payload, validate it, publish `complete`, and
//!    return the secret as a [`PairedIdentity`].
//!    [`PendingPairing::cancel`] sends an `abort` instead.
//!
//! The secret is held in [`Zeroizing`] buffers and never logged.

use std::time::Duration;

use buzz_core::kind::KIND_PAIRING;
use buzz_core::pairing::{
    qr::decode_qr, AbortReason, PairingError, PairingSession, PayloadType, SessionState,
};
use buzz_ws_client::{NostrWsConnection, RelayMessage};
use nostr::nips::nip19::ToBech32;
use nostr::{Event, EventBuilder, Keys, PublicKey, RelayUrl};
use serde_json::json;
use tokio::time::Instant;
use zeroize::Zeroizing;

use crate::{Error, Result};

/// Whole-session budget, matching buzz-core's session timeout.
pub const SESSION_TIMEOUT: Duration = Duration::from_secs(120);
/// How long to wait for an optional NIP-42 challenge right after connecting.
const AUTH_CHALLENGE_WAIT: Duration = Duration::from_secs(3);
/// Sub id for the pairing subscription.
pub(super) const SUB_ID: &str = "pair";

/// A pairing in progress: offer published, SAS known, awaiting the user.
pub struct PendingPairing {
    session: PairingSession,
    conn: NostrWsConnection,
    sas: String,
    deadline: Instant,
}

/// The identity received from the source device.
pub struct PairedIdentity {
    /// `nsec1…` secret. Store it; never log it.
    pub nsec: Zeroizing<String>,
    /// Public key derived from `nsec` (and, for Buzz's JSON payload, checked
    /// equal to the payload's `pubkey`).
    pub pubkey: PublicKey,
    /// Buzz relay the source is signed into, normalized to `wss://`, when the
    /// payload carried one (Buzz desktop's JSON payload does; a raw `nsec`
    /// payload does not).
    pub relay_url: Option<String>,
}

impl std::fmt::Debug for PairedIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairedIdentity")
            .field("nsec", &"<redacted>")
            .field("pubkey", &self.pubkey.to_hex())
            .field("relay_url", &self.relay_url)
            .finish()
    }
}

pub(super) fn perr(e: PairingError) -> Error {
    Error::Pairing(e.to_string())
}

pub(super) fn remaining(deadline: Instant) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| Error::Pairing("pairing timed out — start again from Buzz".into()))
}

/// Pairing relays must be `wss://`; plain `ws://` is accepted only for
/// loopback (in-process tests).
pub(super) fn check_pairing_relay(url: &str) -> Result<()> {
    let u = url::Url::parse(url).map_err(|e| Error::Invalid(format!("pairing relay: {e}")))?;
    let host = u.host_str().unwrap_or_default();
    match u.scheme() {
        "wss" => Ok(()),
        "ws" if host == "127.0.0.1" || host == "localhost" || host == "[::1]" => Ok(()),
        s => Err(Error::Invalid(format!(
            "pairing relay must use wss:// (got {s}://)"
        ))),
    }
}

/// Validate the Buzz relay URL carried in the payload and normalize it to a
/// WebSocket URL. Buzz desktop sends its HTTP API base (`https://host`);
/// accept `https`/`wss`, reject anything else, loopback and private ranges
/// (same rules as Buzz mobile's `_validateRelayUrl`).
pub fn validate_payload_relay_url(raw: &str) -> Result<String> {
    let mut u = url::Url::parse(raw.trim())
        .map_err(|e| Error::Invalid(format!("payload relay URL: {e}")))?;
    let scheme = match u.scheme() {
        "https" | "wss" => "wss",
        s => {
            return Err(Error::Invalid(format!(
                "payload relay URL must be https/wss (got {s})"
            )))
        }
    };
    let blocked = match u.host() {
        None => true,
        Some(url::Host::Domain(d)) => {
            let d = d.to_ascii_lowercase();
            d == "localhost" || d.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(ip)) => {
            ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.octets()[0] == 100 && (64..128).contains(&ip.octets()[1])
        }
        Some(url::Host::Ipv6(ip)) => {
            ip.is_loopback() || ip.is_unspecified() || (ip.segments()[0] & 0xfe00) == 0xfc00
        }
    };
    if blocked {
        return Err(Error::Invalid(
            "payload relay URL cannot target localhost or a private network".into(),
        ));
    }
    u.set_scheme(scheme)
        .map_err(|_| Error::Invalid("payload relay URL: cannot set scheme".into()))?;
    Ok(u.as_str().trim_end_matches('/').to_string())
}

/// Parse and check a received payload. Accepts Buzz desktop's
/// `custom` JSON `{relayUrl, pubkey, nsec}` and a plain `nsec` payload.
pub fn parse_payload(kind: PayloadType, payload: &str) -> Result<PairedIdentity> {
    let (nsec, claimed_pubkey, relay_url) = match kind {
        PayloadType::Nsec => (Zeroizing::new(payload.trim().to_string()), None, None),
        PayloadType::Custom => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct BuzzIdentity {
                relay_url: Option<String>,
                pubkey: Option<String>,
                nsec: Option<String>,
            }
            let v: BuzzIdentity = serde_json::from_str(payload)
                .map_err(|_| Error::Pairing("payload is not Buzz identity JSON".into()))?;
            let nsec = Zeroizing::new(
                v.nsec
                    .ok_or_else(|| Error::Pairing("payload has no nsec".into()))?,
            );
            let relay = v
                .relay_url
                .as_deref()
                .map(validate_payload_relay_url)
                .transpose()?;
            (nsec, v.pubkey, relay)
        }
        other => {
            return Err(Error::Pairing(format!(
                "unsupported payload type {other:?} (expected an identity)"
            )))
        }
    };
    let keys = Keys::parse(nsec.as_str())
        .map_err(|_| Error::Pairing("payload secret is not a valid key".into()))?;
    let pubkey = keys.public_key();
    if let Some(claimed) = claimed_pubkey {
        let claimed = PublicKey::parse(claimed.trim())
            .map_err(|_| Error::Pairing("payload pubkey is invalid".into()))?;
        if claimed != pubkey {
            return Err(Error::Pairing(
                "payload pubkey does not match its secret key".into(),
            ));
        }
    }
    // Always store the canonical bech32 form.
    let nsec = Zeroizing::new(
        keys.secret_key()
            .to_bech32()
            .map_err(|e| Error::Pairing(format!("encoding key: {e}")))?,
    );
    Ok(PairedIdentity {
        nsec,
        pubkey,
        relay_url,
    })
}

/// Step 1: decode `uri`, connect, subscribe, publish the offer.
pub async fn start(uri: &str) -> Result<PendingPairing> {
    let deadline = Instant::now() + SESSION_TIMEOUT;
    let qr = decode_qr(uri.trim()).map_err(perr)?;
    let (session, offer) = PairingSession::new_target(&qr).map_err(perr)?;
    let relay = session
        .relay_urls()
        .first()
        .cloned()
        .ok_or_else(|| Error::Invalid("pairing link has no relay".into()))?;
    check_pairing_relay(&relay)?;
    let sas = session
        .sas_code()
        .ok_or_else(|| Error::Pairing("no SAS code".into()))?;

    let mut conn = NostrWsConnection::connect(&relay).await?;
    maybe_auth(&mut conn, &session, &relay).await?;

    let filter = json!({ "kinds": [KIND_PAIRING], "#p": [session.pubkey().to_hex()] });
    conn.send_raw(&json!(["REQ", SUB_ID, filter])).await?;
    // Subscription must be live on the relay before the offer goes out.
    loop {
        match conn.next_event(remaining(deadline)?).await? {
            RelayMessage::Eose { subscription_id } if subscription_id == SUB_ID => break,
            RelayMessage::Closed {
                subscription_id,
                message,
            } if subscription_id == SUB_ID => {
                return Err(Error::SubscriptionClosed {
                    sub_id: subscription_id,
                    message,
                })
            }
            _ => {}
        }
    }
    publish(&mut conn, &offer).await?;
    Ok(PendingPairing {
        session,
        conn,
        sas,
        deadline,
    })
}

/// If the relay sends a NIP-42 challenge promptly, answer it with the
/// ephemeral session key (so the relay accepts events that key signs).
/// Pairing relays that don't require auth send nothing; that's fine.
pub(super) async fn maybe_auth(
    conn: &mut NostrWsConnection,
    session: &PairingSession,
    relay: &str,
) -> Result<()> {
    let challenge = match conn.next_event(AUTH_CHALLENGE_WAIT).await {
        Ok(RelayMessage::Auth { challenge }) => challenge,
        Ok(_) | Err(buzz_ws_client::WsClientError::Timeout) => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let url = RelayUrl::parse(relay).map_err(|e| Error::Invalid(format!("relay url: {e}")))?;
    let auth = session
        .sign_event(EventBuilder::auth(challenge, url))
        .map_err(perr)?;
    let id = auth.id.to_hex();
    conn.send_raw(&json!(["AUTH", auth])).await?;
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        match conn.next_event(remaining(until)?).await? {
            RelayMessage::Ok(ok) if ok.event_id == id => {
                return if ok.accepted {
                    Ok(())
                } else {
                    Err(Error::Pairing(format!(
                        "pairing relay refused auth: {}",
                        ok.message
                    )))
                };
            }
            _ => {}
        }
    }
}

/// Publish without blocking on OK: the pairing relay's OK is informational
/// and the peer's next message is what actually advances the protocol.
pub(super) async fn publish(conn: &mut NostrWsConnection, ev: &Event) -> Result<()> {
    conn.send_raw(&json!(["EVENT", ev])).await?;
    Ok(())
}

impl PendingPairing {
    /// The 6-digit code to compare with Buzz desktop.
    pub fn sas(&self) -> &str {
        &self.sas
    }

    async fn next_pairing_event(&mut self) -> Result<Event> {
        loop {
            let left = remaining(self.deadline)?;
            match self.conn.next_event(left).await {
                Ok(RelayMessage::Event {
                    subscription_id,
                    event,
                }) if subscription_id == SUB_ID => {
                    if let Ok(reason) = self.session.handle_abort(&event) {
                        return Err(Error::Pairing(format!(
                            "Buzz desktop cancelled pairing ({})",
                            abort_text(reason)
                        )));
                    }
                    return Ok(*event);
                }
                Ok(RelayMessage::Ok(ok)) if !ok.accepted => {
                    return Err(Error::Pairing(format!(
                        "pairing relay rejected an event: {}",
                        ok.message
                    )))
                }
                Ok(RelayMessage::Closed {
                    subscription_id,
                    message,
                }) if subscription_id == SUB_ID => {
                    return Err(Error::SubscriptionClosed {
                        sub_id: subscription_id,
                        message,
                    })
                }
                Ok(_) => {}
                Err(buzz_ws_client::WsClientError::Timeout) => {
                    return Err(Error::Pairing(
                        "pairing timed out — start again from Buzz".into(),
                    ))
                }
                Err(e) => return Err(e.into()),
            }
        }
    }

    /// Step 2: the user confirmed the codes match. Receive the identity.
    pub async fn confirm(mut self) -> Result<PairedIdentity> {
        let result = self.receive().await;
        if result.is_err() && !matches!(self.session.state(), SessionState::Aborted) {
            if let Ok(Some(ev)) = self.session.abort(AbortReason::ProtocolError) {
                let _ = publish(&mut self.conn, &ev).await;
            }
        }
        let _ = self.conn.disconnect().await;
        result
    }

    async fn receive(&mut self) -> Result<PairedIdentity> {
        // Source sends sas-confirm once its user approves; buzz-core checks
        // the transcript hash. Junk / duplicates are skipped (NIP-AB §7).
        loop {
            let ev = self.next_pairing_event().await?;
            match self.session.handle_sas_confirm(&ev) {
                Ok(code) => {
                    if code != self.sas {
                        return Err(Error::Pairing("SAS mismatch".into()));
                    }
                    break;
                }
                Err(PairingError::TranscriptMismatch) => {
                    if let Ok(Some(abort)) = self.session.abort(AbortReason::SasMismatch) {
                        let _ = publish(&mut self.conn, &abort).await;
                    }
                    return Err(Error::Pairing(
                        "security check failed (transcript mismatch) — pairing aborted".into(),
                    ));
                }
                Err(PairingError::SessionExpired) => {
                    return Err(Error::Pairing("pairing timed out".into()))
                }
                Err(_) => continue,
            }
        }
        self.session.confirm_target_sas().map_err(perr)?;
        let (kind, payload) = loop {
            let ev = self.next_pairing_event().await?;
            match self.session.handle_payload(&ev) {
                Ok(p) => break p,
                Err(PairingError::SessionExpired) => {
                    return Err(Error::Pairing("pairing timed out".into()))
                }
                Err(_) => continue,
            }
        };
        let identity = parse_payload(kind, &payload)?;
        let complete = self.session.send_complete().map_err(perr)?;
        publish(&mut self.conn, &complete).await?;
        Ok(identity)
    }

    /// The user declined (codes differ, or cancel). Tells the source.
    pub async fn cancel(mut self, codes_differ: bool) -> Result<()> {
        let reason = if codes_differ {
            AbortReason::SasMismatch
        } else {
            AbortReason::UserDenied
        };
        if let Ok(Some(ev)) = self.session.abort(reason) {
            let _ = publish(&mut self.conn, &ev).await;
        }
        let _ = self.conn.disconnect().await;
        Ok(())
    }
}

pub(super) fn abort_text(r: AbortReason) -> &'static str {
    match r {
        AbortReason::SasMismatch => "codes did not match",
        AbortReason::UserDenied => "declined",
        AbortReason::Timeout => "timed out",
        AbortReason::ProtocolError | AbortReason::Unknown => "protocol error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_relay_url_rules() {
        assert_eq!(
            validate_payload_relay_url("https://buzz.unforced.org").unwrap(),
            "wss://buzz.unforced.org"
        );
        assert_eq!(
            validate_payload_relay_url("wss://buzz.unforced.org/").unwrap(),
            "wss://buzz.unforced.org"
        );
        for bad in [
            "http://buzz.unforced.org",
            "ws://buzz.unforced.org",
            "https://localhost",
            "https://127.0.0.1",
            "https://10.0.0.5",
            "https://192.168.1.2",
            "https://172.20.0.1",
            "https://169.254.1.1",
            "https://[::1]",
            "ftp://x.org",
            "not a url",
        ] {
            assert!(validate_payload_relay_url(bad).is_err(), "{bad} accepted");
        }
    }

    #[test]
    fn payload_pubkey_must_match_nsec() {
        let k = Keys::generate();
        let other = Keys::generate();
        let nsec = k.secret_key().to_bech32().unwrap();
        let ok = json!({"relayUrl":"https://buzz.example.com","pubkey":k.public_key().to_hex(),"nsec":nsec});
        let id = parse_payload(PayloadType::Custom, &ok.to_string()).unwrap();
        assert_eq!(id.pubkey, k.public_key());
        assert_eq!(id.relay_url.as_deref(), Some("wss://buzz.example.com"));
        assert!(!format!("{id:?}").contains(nsec.as_str()));

        let bad = json!({"relayUrl":"https://buzz.example.com","pubkey":other.public_key().to_hex(),"nsec":nsec});
        assert!(parse_payload(PayloadType::Custom, &bad.to_string()).is_err());
        let private =
            json!({"relayUrl":"https://10.1.1.1","pubkey":k.public_key().to_hex(),"nsec":nsec});
        assert!(parse_payload(PayloadType::Custom, &private.to_string()).is_err());
        assert!(parse_payload(PayloadType::Bunker, "bunker://x").is_err());
        let raw = parse_payload(PayloadType::Nsec, &nsec).unwrap();
        assert_eq!(raw.pubkey, k.public_key());
    }

    #[test]
    fn pairing_relay_must_be_wss_except_loopback() {
        assert!(check_pairing_relay("wss://pairing.buzz.xyz").is_ok());
        assert!(check_pairing_relay("ws://127.0.0.1:1234").is_ok());
        assert!(check_pairing_relay("ws://pairing.buzz.xyz").is_err());
    }
}
