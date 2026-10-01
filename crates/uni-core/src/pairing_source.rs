//! NIP-AB source relay driver. Only `send` (explicit user confirmation) exports a key.
use crate::{
    pairing::{
        abort_text, check_pairing_relay, maybe_auth, perr, publish, remaining, SESSION_TIMEOUT,
        SUB_ID,
    },
    Error, Result,
};
use buzz_core::{
    kind::KIND_PAIRING,
    pairing::{
        qr::encode_qr, AbortReason, PairingError, PairingSession, PayloadType, SessionState,
    },
};
use buzz_ws_client::{NostrWsConnection, RelayMessage};
use nostr::{nips::nip19::ToBech32, Event, Keys};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::time::Instant;
use zeroize::Zeroizing;

/// Buzz's NIP-11 precedence: configured endpoint, NIP-43 legacy path, main relay.
fn relay_from_document(main: &str, doc: &Value) -> String {
    if let Some(raw) = doc.get("pairing_relay_url").and_then(Value::as_str) {
        if let Ok(url) = url::Url::parse(raw) {
            if matches!(url.scheme(), "ws" | "wss") && url.host_str().is_some() {
                return raw.into();
            }
        }
    }
    if doc
        .get("supported_nips")
        .and_then(Value::as_array)
        .is_some_and(|nips| nips.iter().any(|n| n.as_u64() == Some(43)))
    {
        if let Ok(mut url) = url::Url::parse(main) {
            url.set_path(&format!("{}/pair", url.path().trim_end_matches('/')));
            return url.into();
        }
    }
    main.into()
}

/// Probe for at most five seconds, accepting at most 64 KiB. Failure uses the main relay.
pub async fn resolve_pairing_relay(main: &str) -> String {
    let probe = async {
        let http = if let Some(rest) = main.strip_prefix("wss://") {
            format!("https://{rest}")
        } else {
            let rest = main.strip_prefix("ws://")?;
            format!("http://{rest}")
        };
        let client = crate::media::http_client_with_timeout(Duration::from_secs(5)).ok()?;
        let mut response = client
            .get(http)
            .header("Accept", "application/nostr+json")
            .send()
            .await
            .ok()?;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if body.len() + chunk.len() > 65536 {
                return None;
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice::<Value>(&body).ok()
    };
    match tokio::time::timeout(Duration::from_secs(5), probe).await {
        Ok(Some(doc)) => relay_from_document(main, &doc),
        _ => main.into(),
    }
}

/// Convert the account relay to the HTTP API base used by Buzz's Custom payload.
pub fn relay_http_base(relay: &str) -> Result<String> {
    let normalized = crate::pairing::validate_payload_relay_url(relay)?;
    Ok(normalized.replacen("wss://", "https://", 1))
}

fn identity_payload(keys: &Keys, relay: &str) -> Result<Zeroizing<String>> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Identity<'a> {
        relay_url: &'a str,
        pubkey: String,
        nsec: &'a str,
    }
    let relay = relay_http_base(relay)?;
    let nsec = Zeroizing::new(
        keys.secret_key()
            .to_bech32()
            .map_err(|_| Error::Pairing("encoding identity".into()))?,
    );
    // Serialize borrowed secret directly; no serde_json::Value secret clone survives drop.
    serde_json::to_string(&Identity {
        relay_url: &relay,
        pubkey: keys.public_key().to_hex(),
        nsec: &nsec,
    })
    .map(Zeroizing::new)
    .map_err(|_| Error::Pairing("encoding identity payload".into()))
}

pub struct PendingSource {
    session: PairingSession,
    conn: NostrWsConnection,
    uri: Zeroizing<String>,
    deadline: Instant,
}

pub async fn start_source(relay: &str) -> Result<PendingSource> {
    check_pairing_relay(relay)?;
    let deadline = Instant::now() + SESSION_TIMEOUT;
    let (session, qr) = PairingSession::new_source(relay.into());
    let uri = Zeroizing::new(encode_qr(&qr));
    tokio::time::timeout_at(deadline, async {
        let mut conn = NostrWsConnection::connect(relay).await?;
        maybe_auth(&mut conn, &session, relay).await?;
        conn.send_raw(
            &json!(["REQ", SUB_ID, {"kinds":[KIND_PAIRING], "#p":[session.pubkey().to_hex()]}]),
        )
        .await?;
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
        Ok(PendingSource {
            session,
            conn,
            uri,
            deadline,
        })
    })
    .await
    .map_err(|_| Error::Pairing("pairing expired".into()))?
}

impl PendingSource {
    /// Contains the session secret: display/copy only, never log.
    pub fn uri(&self) -> &str {
        &self.uri
    }
    pub fn deadline(&self) -> Instant {
        self.deadline
    }

    async fn next_event(&mut self) -> Result<Event> {
        loop {
            let message = match self.conn.next_event(remaining(self.deadline)?).await {
                Ok(message) => message,
                Err(
                    buzz_ws_client::WsClientError::Json(_)
                    | buzz_ws_client::WsClientError::UnexpectedMessage(_),
                ) => continue,
                Err(error) => return Err(error.into()),
            };
            match message {
                RelayMessage::Event {
                    subscription_id,
                    event,
                } if subscription_id == SUB_ID => {
                    if let Ok(reason) = self.session.handle_abort(&event) {
                        return Err(Error::Pairing(format!(
                            "other device cancelled pairing ({})",
                            abort_text(reason)
                        )));
                    }
                    return Ok(*event);
                }
                RelayMessage::Closed {
                    subscription_id,
                    message,
                } if subscription_id == SUB_ID => {
                    return Err(Error::SubscriptionClosed {
                        sub_id: subscription_id,
                        message,
                    })
                }
                RelayMessage::Ok(ok) if !ok.accepted => {
                    return Err(Error::Pairing("pairing relay rejected an event".into()))
                }
                _ => {}
            }
        }
    }

    pub async fn wait_offer(&mut self) -> Result<String> {
        tokio::time::timeout_at(self.deadline, self.receive_offer())
            .await
            .map_err(|_| Error::Pairing("pairing expired".into()))?
    }

    async fn receive_offer(&mut self) -> Result<String> {
        if self.session.state() != SessionState::Waiting {
            return Err(Error::Pairing("offer already received".into()));
        }
        loop {
            let event = self.next_event().await?;
            match self.session.handle_offer(&event) {
                Ok(sas) => return Ok(sas),
                Err(PairingError::SessionExpired) => {
                    return Err(Error::Pairing("pairing expired".into()))
                }
                Err(_) => {}
            }
        }
    }

    /// Calling this method represents explicit user approval of the displayed SAS.
    pub async fn send(mut self, keys: &Keys, relay: &str) -> Result<()> {
        let result = self.send_confirmed(keys, relay).await;
        if result.is_err() {
            self.abort(false).await;
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), self.conn.disconnect()).await;
        result
    }

    /// Borrowing variant for a cancellable native session owner. Same explicit-confirm contract.
    pub async fn send_confirmed(&mut self, keys: &Keys, relay: &str) -> Result<()> {
        tokio::time::timeout_at(self.deadline, self.transfer(keys, relay))
            .await
            .map_err(|_| Error::Pairing("pairing expired".into()))?
    }

    async fn transfer(&mut self, keys: &Keys, relay: &str) -> Result<()> {
        remaining(self.deadline)?;
        let payload = identity_payload(keys, relay)?;
        // buzz-core rejects this unless a valid offer was accepted, before any publication.
        let confirm = self.session.confirm_sas().map_err(perr)?;
        publish(&mut self.conn, &confirm).await?;
        let event = self
            .session
            .send_payload(PayloadType::Custom, payload)
            .map_err(perr)?;
        publish(&mut self.conn, &event).await?;
        loop {
            let event = self.next_event().await?;
            match self.session.handle_complete(&event) {
                Ok(()) => return Ok(()),
                Err(_) if self.session.state() == SessionState::Aborted =>
                    return Err(Error::Pairing("other device reported failure importing the identity (complete success=false)".into())),
                Err(PairingError::SessionExpired) => return Err(Error::Pairing("pairing expired".into())),
                Err(_) => {}
            }
        }
    }

    async fn abort(&mut self, codes_differ: bool) {
        let reason = if codes_differ {
            AbortReason::SasMismatch
        } else {
            AbortReason::UserDenied
        };
        if let Ok(Some(event)) = self.session.abort(reason) {
            let _ =
                tokio::time::timeout(Duration::from_secs(2), publish(&mut self.conn, &event)).await;
        }
    }

    pub async fn cancel(mut self, codes_differ: bool) -> Result<()> {
        self.abort(codes_differ).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), self.conn.disconnect()).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relay_resolution() {
        let main = "wss://buzz.example/api/";
        assert_eq!(
            relay_from_document(
                main,
                &json!({"pairing_relay_url":"wss://pair.example", "supported_nips":[43]})
            ),
            "wss://pair.example"
        );
        assert_eq!(
            relay_from_document(
                main,
                &json!({"pairing_relay_url":"https://invalid", "supported_nips":[43]})
            ),
            "wss://buzz.example/api/pair"
        );
        assert_eq!(
            relay_from_document(main, &json!({"supported_nips":[1,42]})),
            main
        );
        assert_eq!(relay_from_document(main, &Value::Null), main);
    }
    #[test]
    fn payload_roundtrip() {
        let keys = Keys::generate();
        let payload = identity_payload(&keys, "wss://buzz.unforced.org/").unwrap();
        let received = crate::pairing::parse_payload(PayloadType::Custom, &payload).unwrap();
        assert_eq!(received.pubkey, keys.public_key());
        assert_eq!(
            received.relay_url.as_deref(),
            Some("wss://buzz.unforced.org")
        );
        let value: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert_eq!(value["relayUrl"], "https://buzz.unforced.org");
    }
    #[test]
    fn cannot_send_before_offer_and_confirmation() {
        let (mut source, qr) = PairingSession::new_source("wss://pair.example".into());
        assert!(source.confirm_sas().is_err());
        assert!(source
            .send_payload(PayloadType::Nsec, Zeroizing::new("test".into()))
            .is_err());
        let (_, offer) = PairingSession::new_target(&qr).unwrap();
        source.handle_offer(&offer).unwrap();
        assert!(source
            .send_payload(PayloadType::Nsec, Zeroizing::new("test".into()))
            .is_err());
        assert!(source.confirm_sas().is_ok());
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use buzz_core::pairing::{crypto::derive_session_id, qr::decode_qr};
    use futures_util::{SinkExt, StreamExt};
    use nostr::{EventBuilder, Kind, Tag};
    use tokio_tungstenite::tungstenite::Message;

    // A malicious/failing target over a real socket: malformed events must not
    // kill the session, and an authenticated complete(false) must not be success.
    #[tokio::test]
    async fn discard_junk_and_surface_negative_completion() {
        crate::init_crypto();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay = format!("ws://{}", listener.local_addr().unwrap());
        let (send_uri, receive_uri) = tokio::sync::oneshot::channel::<String>();
        let peer = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            let request = ws.next().await.unwrap().unwrap().into_text().unwrap();
            assert_eq!(serde_json::from_str::<Value>(&request).unwrap()[0], "REQ");
            ws.send(Message::Text(json!(["EOSE", SUB_ID]).to_string().into()))
                .await
                .unwrap();
            let uri = Zeroizing::new(receive_uri.await.unwrap());
            let qr = decode_qr(&uri).unwrap();
            let keys = Keys::generate();
            let event = |body: Value| {
                let encrypted = nostr::nips::nip44::encrypt(
                    keys.secret_key(),
                    &qr.source_pubkey,
                    body.to_string(),
                    nostr::nips::nip44::Version::V2,
                )
                .unwrap();
                EventBuilder::new(Kind::Custom(KIND_PAIRING as u16), encrypted)
                    .tags([Tag::public_key(qr.source_pubkey)])
                    .sign_with_keys(&keys)
                    .unwrap()
            };
            ws.send(Message::Text("not-json".into())).await.unwrap();
            let bad = event(json!({"type":"offer","session_id":"00".repeat(32),"version":1}));
            ws.send(Message::Text(
                json!(["EVENT", SUB_ID, bad]).to_string().into(),
            ))
            .await
            .unwrap();
            let id: String = derive_session_id(&qr.session_secret)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            let offer = event(json!({"type":"offer","session_id":id,"version":1}));
            ws.send(Message::Text(
                json!(["EVENT", SUB_ID, offer]).to_string().into(),
            ))
            .await
            .unwrap();
            // Source must publish sas-confirm and payload, in that order.
            for expected in ["sas-confirm", "payload"] {
                let raw = ws.next().await.unwrap().unwrap().into_text().unwrap();
                let value: Value = serde_json::from_str(&raw).unwrap();
                let ev: Event = serde_json::from_value(value[1].clone()).unwrap();
                let plaintext = Zeroizing::new(
                    nostr::nips::nip44::decrypt(keys.secret_key(), &qr.source_pubkey, ev.content)
                        .unwrap(),
                );
                let body: Value = serde_json::from_str(&plaintext).unwrap();
                assert_eq!(body["type"], expected);
            }
            let complete = event(json!({"type":"complete","success":false}));
            ws.send(Message::Text(
                json!(["EVENT", SUB_ID, complete]).to_string().into(),
            ))
            .await
            .unwrap();
            let _ = ws.next().await;
        });
        let mut pending = start_source(&relay).await.unwrap();
        send_uri.send(pending.uri().into()).unwrap();
        assert_eq!(pending.wait_offer().await.unwrap().len(), 6);
        let error = pending
            .send(&Keys::generate(), "https://buzz.unforced.org")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("success=false"));
        peer.await.unwrap();
    }
}
