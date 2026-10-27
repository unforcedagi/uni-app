//! The Messages dev bridge (T-278): the same Rust core the app's `messages_*` Tauri commands call, offered over HTTP
//! on this machine so a plain browser build, and Playwright, can drive it against a real homeserver.
//!
//! - `POST /p/<profile>/invoke/<command>` with the command's arguments as JSON: its answer, or `{kind, message}` (400).
//! - `GET /p/<profile>/events?token=…`: the updates as server-sent events, one JSON `Update` each.
//! - T-313: `messages_media` answers the attachment's bytes (`application/octet-stream`), as the app's command answers
//!   raw IPC; with `--transcribe-hub`, voice messages are transcribed as the app does it.
//!
//! A profile is one account with its own store (`<dir>/<profile>`), so two pages can be two people. It listens on
//! 127.0.0.1 only, answers only requests carrying the run's token, and allows only the one web origin it is given.
//! Development and tests only: the app never ships it (it's behind the crate's `dev-bridge` feature).
#![recursion_limit = "256"]

use std::{collections::HashMap, convert::Infallible, net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Router,
};
use clap::Parser;
use futures_util::{stream, Stream};
use serde_json::{json, Value};
use tokio::sync::{broadcast::error::RecvError, Mutex};
use uni_messages::{FileSecrets, Messages, MessagesError, Transcriber, Transcribing};

#[derive(Parser)]
struct Args {
    /// Port on 127.0.0.1.
    #[arg(long, default_value_t = 5789)]
    port: u16,
    /// Where the profiles' stores and secrets go.
    #[arg(long)]
    dir: PathBuf,
    /// The web origin allowed to call (the vite preview serving the app).
    #[arg(long, default_value = "http://127.0.0.1:5788")]
    origin: String,
    /// Every request must carry it; from the environment so it stays out of `ps`.
    #[arg(long, env = "UNI_MESSAGES_DEV_TOKEN", hide_env_values = true)]
    token: String,
    /// T-313: transcribe voice messages on this hub's host, as the app does (uni-transcribe, NIP-98 signed with this
    /// machine's key: `UNI_NSEC` or the keyring). Without it, a voice message's transcript says it isn't available.
    #[arg(long, conflicts_with = "transcribe_url")]
    transcribe_hub: Option<String>,
    /// T-313, for walkthroughs and tests: send voice messages to a transcriber on this machine instead (`http://127.0.0.1…`):
    /// POST the audio, answer `{"text": …}`.
    #[arg(long)]
    transcribe_url: Option<String>,
}

/// A transcriber on this machine (a stand-in running the same model as uni-transcribe, without its sign-in).
struct LocalTranscriber {
    url: String,
    http: reqwest::Client,
}

impl Transcriber for LocalTranscriber {
    fn transcribe(&self, audio: Vec<u8>, mime: String) -> Transcribing {
        let (url, http) = (self.url.clone(), self.http.clone());
        Box::pin(async move {
            let r = http.post(&url).header("content-type", mime).body(audio).send().await.map_err(|e| e.to_string())?;
            let status = r.status();
            let body = r.text().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(format!("the transcriber answered {status}"));
            }
            let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
            v["text"].as_str().map(str::to_owned).ok_or_else(|| "the transcriber gave no text".into())
        })
    }
}

/// The app's transcription path (src-tauri's `transcribe_audio`), from this machine.
struct HubTranscriber {
    hub: String,
    keys: nostr::Keys,
}

impl Transcriber for HubTranscriber {
    fn transcribe(&self, audio: Vec<u8>, mime: String) -> Transcribing {
        let (hub, keys) = (self.hub.clone(), self.keys.clone());
        Box::pin(async move { uni_core::transcribe::transcribe_on_hub(&hub, &keys, audio, &mime, None).await.map(|t| t.text).map_err(|e| e.to_string()) })
    }
}

struct Bridge {
    dir: PathBuf,
    token: String,
    origin: HeaderValue,
    profiles: Mutex<HashMap<String, Arc<Messages>>>,
    transcriber: Option<Arc<dyn Transcriber>>,
}

fn valid_profile(p: &str) -> bool {
    !p.is_empty() && p.len() <= 32 && p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Constant-time comparison, so the token can't be guessed a byte at a time.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl Bridge {
    async fn profile(&self, name: &str) -> Option<Arc<Messages>> {
        if !valid_profile(name) {
            return None;
        }
        let mut all = self.profiles.lock().await;
        Some(
            all.entry(name.to_owned())
                .or_insert_with(|| {
                    let dir = self.dir.join(name);
                    let m = Messages::new(dir.join("data"), Arc::new(FileSecrets::new(dir.join("secrets"))));
                    if let Some(t) = &self.transcriber {
                        m.set_transcriber(t.clone());
                    }
                    m
                })
                .clone(),
        )
    }

    fn cors(&self, mut r: Response) -> Response {
        let h = r.headers_mut();
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, self.origin.clone());
        h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("authorization, content-type"));
        h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
        h.insert(header::VARY, HeaderValue::from_static("origin"));
        r
    }

    fn authorized(&self, headers: &HeaderMap) -> bool {
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .is_some_and(|t| same(t, &self.token))
    }
}

fn error(status: StatusCode, e: &MessagesError) -> Response {
    (status, axum::Json(serde_json::to_value(e).unwrap_or(Value::Null))).into_response()
}

async fn invoke(State(b): State<Arc<Bridge>>, Path((profile, cmd)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Response {
    if !b.authorized(&headers) {
        return b.cors(StatusCode::UNAUTHORIZED.into_response());
    }
    let Some(m) = b.profile(&profile).await else {
        return b.cors(StatusCode::NOT_FOUND.into_response());
    };
    let args: Value = if body.is_empty() { json!({}) } else { serde_json::from_slice(&body).unwrap_or(json!({})) };
    if cmd == "messages_media" {
        let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
        let r = match m.media(&s("roomId"), &s("eventId")).await {
            Ok(f) => ([(header::CONTENT_TYPE, "application/octet-stream")], f.bytes).into_response(),
            Err(e) => error(StatusCode::BAD_REQUEST, &e),
        };
        return b.cors(r);
    }
    let r = match m.call(&cmd, &args).await {
        Ok(v) => axum::Json(v).into_response(),
        Err(e) => error(StatusCode::BAD_REQUEST, &e),
    };
    b.cors(r)
}

async fn events(State(b): State<Arc<Bridge>>, Path(profile): Path<String>, Query(q): Query<HashMap<String, String>>) -> Response {
    if !q.get("token").is_some_and(|t| same(t, &b.token)) {
        return b.cors(StatusCode::UNAUTHORIZED.into_response());
    }
    let Some(m) = b.profile(&profile).await else {
        return b.cors(StatusCode::NOT_FOUND.into_response());
    };
    let rx = m.subscribe();
    let s: std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>> = Box::pin(stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(u) => {
                    let data = serde_json::to_string(&u).unwrap_or_default();
                    return Some((Ok(Event::default().data(data)), rx));
                }
                // a slow reader missed some: the next update carries the whole list or room again
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return None,
            }
        }
    }));
    b.cors(Sse::new(s).keep_alive(KeepAlive::default()).into_response())
}

async fn preflight(State(b): State<Arc<Bridge>>) -> Response {
    b.cors(StatusCode::NO_CONTENT.into_response())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "warn,uni_messages=info".into())).init();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args = Args::parse();
    if args.token.len() < 16 {
        return Err("the token must be at least 16 characters".into());
    }
    let origin = HeaderValue::from_str(&args.origin).map_err(|_| "bad --origin")?;
    let transcriber: Option<Arc<dyn Transcriber>> = match (args.transcribe_hub, args.transcribe_url) {
        (Some(hub), _) => {
            let (keys, _) = uni_core::load_keys(false).map_err(|e| format!("--transcribe-hub needs this machine's key: {e}"))?;
            Some(Arc::new(HubTranscriber { hub, keys }))
        }
        (None, Some(url)) => {
            if !(url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:")) {
                return Err("--transcribe-url is for a transcriber on this machine (http://127.0.0.1:…)".into());
            }
            let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(300)).build()?;
            Some(Arc::new(LocalTranscriber { url, http }))
        }
        (None, None) => None,
    };
    let bridge = Arc::new(Bridge { dir: args.dir, token: args.token, origin, profiles: Mutex::new(HashMap::new()), transcriber });
    let app = Router::new()
        .route("/p/{profile}/invoke/{cmd}", post(invoke).options(preflight))
        .route("/p/{profile}/events", get(events).options(preflight))
        .route("/health", get(|| async { "ok" }))
        .with_state(bridge.clone())
        .layer(axum::middleware::from_fn(|req: axum::extract::Request, next: axum::middleware::Next| async move {
            if req.method() != Method::GET && req.method() != Method::POST && req.method() != Method::OPTIONS {
                return StatusCode::METHOD_NOT_ALLOWED.into_response();
            }
            next.run(req).await
        }));
    let addr = SocketAddr::from(([127, 0, 0, 1], args.port));
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| format!("bind {addr}: {e}"))?;
    eprintln!("uni-messages-dev on http://{addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|e| e.to_string())?;
    // nothing is signed out: each profile's account stops, and stays saved for the next run
    for (_, m) in bridge.profiles.lock().await.drain() {
        m.shut_down().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_name_stays_inside_the_bridge_folder() {
        for ok in ["a", "b", "wren-2", "x1"] {
            assert!(valid_profile(ok));
        }
        for no in ["", "..", "../a", "a/b", "A", "a b", &"x".repeat(33)] {
            assert!(!valid_profile(no), "{no:?}");
        }
    }

    #[test]
    fn the_token_must_match_exactly() {
        assert!(same("0123456789abcdef", "0123456789abcdef"));
        assert!(!same("0123456789abcdef", "0123456789abcdeF"));
        assert!(!same("0123456789abcdef", "0123456789abcde"));
        assert!(!same("", "x"));
    }
}
