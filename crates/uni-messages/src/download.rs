//! T-313 (Codex review 9b8p17d9, P2): an attachment's bytes, with the size limit kept while they arrive.
//!
//! matrix-sdk's `get_media_content` reads the whole answer into memory before it returns, so a limit checked after it
//! is no limit: an event that understates its size (or gives none) could fill the device's memory first. So the
//! download is made here, with the account's own HTTP client and token (which never leave Rust): the homeserver's
//! authenticated media endpoint where it has one, a declared length past the limit refused before a byte is read, and
//! the body read a chunk at a time, stopped as soon as it passes the limit. An encrypted room's file is then decrypted
//! (its hash checked) as the SDK does it, and kept in the account's encrypted media store, so it is fetched once.

use std::io::Read;

use matrix_sdk::{
    media::{MediaFormat, MediaRequestParameters},
    ruma::{
        api::{client::authenticated_media, Metadata},
        events::room::MediaSource,
        MxcUri,
    },
    Client,
};
use matrix_sdk_base::media::store::IgnoreMediaRetentionPolicy;

use crate::{invalid, MessagesError, Result, MEDIA_FOR};

/// What a refused download says, so a caller can tell "too large" from the other refusals.
pub(crate) const TOO_LARGE: &str = "This attachment is too large to open here.";
/// The largest download also kept in the account's media store (voice notes and pictures, not every large file: the
/// store's copy is one more in memory while it is written).
const KEEP_MAX: usize = 20 * 1024 * 1024;

pub(crate) fn too_big() -> MessagesError {
    invalid(TOO_LARGE)
}

fn unreachable() -> MessagesError {
    MessagesError::Unreachable { message: "The homeserver isn't answering.".into() }
}

/// The download address of `mxc` on `homeserver`: the authenticated endpoint, or the old one for a homeserver without it.
fn download_url(homeserver: &url::Url, mxc: &MxcUri, authenticated: bool) -> Result<url::Url> {
    let (server, id) = mxc.parts().map_err(|_| invalid("That attachment's address isn't valid."))?;
    let mut url = homeserver.clone();
    {
        let mut path = url.path_segments_mut().map_err(|_| invalid("That isn't a homeserver address."))?;
        path.pop_if_empty();
        let base: &[&str] = if authenticated { &["_matrix", "client", "v1", "media", "download"] } else { &["_matrix", "media", "v3", "download"] };
        path.extend(base).push(server.as_str()).push(id);
    }
    url.set_query(None);
    Ok(url)
}

/// `mxc`'s bytes, at most `max`: refused at once if the answer says it is longer, and stopped as soon as more arrives.
async fn fetch(client: &Client, mxc: &MxcUri, max: u64) -> Result<Vec<u8>> {
    let versions = client.supported_versions().await.map_err(|_| unreachable())?;
    let authenticated = authenticated_media::get_content::v1::Request::PATH_BUILDER.is_supported(&versions);
    let url = download_url(&client.homeserver(), mxc, authenticated)?;
    // the account's client gives up on a request after REQUEST_FOR (15 s); a download takes as long as it takes, up to
    // MEDIA_FOR, as the SDK's own download did
    let mut request = client.http_client().get(url).timeout(MEDIA_FOR);
    if authenticated {
        let token = client.access_token().ok_or_else(crate::signed_out)?;
        request = request.bearer_auth(token);
    }
    let mut answer = request.send().await.map_err(|_| unreachable())?;
    let status = answer.status().as_u16();
    if status == 404 {
        return Err(invalid("This attachment isn't on the homeserver any more."));
    }
    if status == 401 || status == 403 {
        return Err(MessagesError::Refused { message: "The homeserver refused the attachment.".into() });
    }
    if !(200..300).contains(&status) {
        return Err(MessagesError::Server { message: format!("the homeserver answered {status} for the attachment") });
    }
    if answer.content_length().is_some_and(|n| n > max) {
        return Err(too_big());
    }
    let mut bytes = Vec::with_capacity(answer.content_length().unwrap_or(0) as usize);
    while let Some(chunk) = answer.chunk().await.map_err(|_| unreachable())? {
        if bytes.len() as u64 + chunk.len() as u64 > max {
            // dropping the answer closes the connection: nothing more is read
            return Err(too_big());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// An attachment's bytes, decrypted, at most `max`, within `MEDIA_FOR`; from the account's media store when it has them.
pub(crate) async fn download(client: &Client, source: MediaSource, max: u64) -> Result<Vec<u8>> {
    let request = MediaRequestParameters { source: source.clone(), format: MediaFormat::File };
    if let Ok(store) = client.media_store().lock().await {
        if let Ok(Some(kept)) = store.get_media_content(&request).await {
            if kept.len() as u64 <= max {
                return Ok(kept);
            }
            return Err(too_big());
        }
    }
    let bytes = match tokio::time::timeout(MEDIA_FOR, async {
        match &source {
            MediaSource::Plain(mxc) => fetch(client, mxc, max).await,
            MediaSource::Encrypted(file) => {
                // the ciphertext is as long as the file
                let sealed = fetch(client, &file.url, max).await?;
                let len = sealed.len();
                let mut cursor = std::io::Cursor::new(sealed);
                let mut reader = matrix_sdk_base::crypto::AttachmentDecryptor::new(&mut cursor, file.as_ref().clone().into())
                    .map_err(|_| invalid("That attachment can't be decrypted."))?;
                let mut open = Vec::with_capacity(len);
                reader.read_to_end(&mut open).map_err(|_| invalid("That attachment can't be decrypted (it isn't the file that was sent)."))?;
                Ok(open)
            }
        }
    })
    .await
    {
        Ok(got) => got?,
        Err(_) => return Err(MessagesError::Unreachable { message: "The attachment took too long to download.".into() }),
    };
    if bytes.len() <= KEEP_MAX {
        if let Ok(store) = client.media_store().lock().await {
            let _ = store.add_media_content(&request, bytes.clone(), IgnoreMediaRetentionPolicy::No).await;
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicU64, Ordering::SeqCst},
        Arc,
    };

    use axum::{body::Body, extract::State, http::header, response::IntoResponse, routing::get, Json, Router};
    use matrix_sdk::{
        authentication::matrix::MatrixSession,
        ruma::{owned_mxc_uri, owned_device_id, owned_user_id},
        store::RoomLoadSettings,
        SessionMeta, SessionTokens,
    };
    use serde_json::json;

    use super::*;

    /// A homeserver whose media never ends (and, for `/big`, says so up front): how many bytes it got out, and
    /// whether the request carried the account's token.
    #[derive(Default)]
    struct Endless {
        sent: AtomicU64,
        authorized: AtomicU64,
    }

    async fn endless(State(s): State<Arc<Endless>>, headers: axum::http::HeaderMap) -> impl IntoResponse {
        if headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) == Some("Bearer made-up-token") {
            s.authorized.fetch_add(1, SeqCst);
        }
        let chunk = bytes_of(64 * 1024);
        let stream = futures_util::stream::unfold(s, move |s| {
            let chunk = chunk.clone();
            async move {
                s.sent.fetch_add(chunk.len() as u64, SeqCst);
                Some((Ok::<_, std::io::Error>(chunk), s))
            }
        });
        ([(header::CONTENT_TYPE, "application/octet-stream")], Body::from_stream(stream))
    }

    fn bytes_of(n: usize) -> axum::body::Bytes {
        axum::body::Bytes::from(vec![7u8; n])
    }

    async fn client_on(app: Router) -> Client {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        // as the app builds it, with its short limit for an ordinary request (REQUEST_FOR), shortened further here
        let config = matrix_sdk::config::RequestConfig::short_retry().timeout(std::time::Duration::from_secs(1));
        let client = Client::builder().homeserver_url(&url).request_config(config).build().await.unwrap();
        let session = MatrixSession {
            meta: SessionMeta { user_id: owned_user_id!("@pat:example.org"), device_id: owned_device_id!("MADEUP") },
            tokens: SessionTokens { access_token: "made-up-token".into(), refresh_token: None },
        };
        client.matrix_auth().restore_session(session, RoomLoadSettings::default()).await.unwrap();
        client
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_download_stops_at_the_limit_while_it_arrives_and_a_declared_length_past_it_is_refused_at_once() {
        let s = Arc::new(Endless::default());
        let app = Router::new()
            .route("/_matrix/client/versions", get(|| async { Json(json!({ "versions": ["v1.11"], "unstable_features": {} })) }))
            .route("/_matrix/client/v1/media/download/example.org/endless", get(endless))
            .route(
                "/_matrix/client/v1/media/download/example.org/big",
                get(|state, headers| async move {
                    // the same endless body, its length said up front
                    let mut r = endless(state, headers).await.into_response();
                    r.headers_mut().insert(header::CONTENT_LENGTH, header::HeaderValue::from_static("999999999999"));
                    r
                }),
            )
            .with_state(s.clone());
        let client = client_on(app).await;
        let max = 1024 * 1024;
        // a body with no end and no length: stopped once past the limit, not read to its end
        let got = tokio::time::timeout(std::time::Duration::from_secs(20), download(&client, MediaSource::Plain(owned_mxc_uri!("mxc://example.org/endless")), max)).await;
        assert!(matches!(got, Ok(Err(MessagesError::Invalid { .. }))), "{got:?}");
        // through the authenticated endpoint, with the account's token
        assert_eq!(s.authorized.load(SeqCst), 1);
        // the server got out about the limit, and what the connection's buffers held, not an endless amount
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let sent = s.sent.load(SeqCst);
        assert!(sent < max + 16 * 1024 * 1024, "the server sent {sent} bytes");
        let after = s.sent.load(SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(s.sent.load(SeqCst), after, "the download went on after it was refused");
        // a length past the limit, declared: refused before reading
        let got = tokio::time::timeout(std::time::Duration::from_secs(20), download(&client, MediaSource::Plain(owned_mxc_uri!("mxc://example.org/big")), max)).await;
        assert!(matches!(got, Ok(Err(MessagesError::Invalid { .. }))), "{got:?}");
        assert_eq!(s.authorized.load(SeqCst), 2);
    }

    /// A file that takes 3 s to arrive, 64 KB at a time.
    async fn slow() -> impl IntoResponse {
        let stream = futures_util::stream::unfold(0u32, |n| async move {
            if n == 6 {
                return None;
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            Some((Ok::<_, std::io::Error>(bytes_of(64 * 1024)), n + 1))
        });
        Body::from_stream(stream)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_download_slower_than_an_ordinary_request_still_arrives() {
        let app = Router::new()
            .route("/_matrix/client/versions", get(|| async { Json(json!({ "versions": ["v1.11"], "unstable_features": {} })) }))
            .route("/_matrix/client/v1/media/download/example.org/slow", get(slow));
        let client = client_on(app).await;
        let got = download(&client, MediaSource::Plain(owned_mxc_uri!("mxc://example.org/slow")), 1024 * 1024).await;
        assert_eq!(got.map(|b| b.len()).ok(), Some(6 * 64 * 1024));
    }

    #[test]
    fn the_download_address_names_the_file_and_nothing_else() {
        let hs = url::Url::parse("https://matrix.example.org/").unwrap();
        let mxc = owned_mxc_uri!("mxc://example.org/abc_DEF-123");
        assert_eq!(download_url(&hs, &mxc, true).unwrap().as_str(), "https://matrix.example.org/_matrix/client/v1/media/download/example.org/abc_DEF-123");
        assert_eq!(download_url(&hs, &mxc, false).unwrap().as_str(), "https://matrix.example.org/_matrix/media/v3/download/example.org/abc_DEF-123");
        let under = url::Url::parse("https://example.org/matrix/").unwrap();
        assert_eq!(download_url(&under, &mxc, true).unwrap().as_str(), "https://example.org/matrix/_matrix/client/v1/media/download/example.org/abc_DEF-123");
        // a media id that would climb out of the path isn't valid
        assert!(download_url(&hs, <&MxcUri>::from("mxc://example.org/../../x"), true).is_err());
        assert!(download_url(&hs, <&MxcUri>::from("mxc://example.org/a/b"), true).is_err());
    }
}
