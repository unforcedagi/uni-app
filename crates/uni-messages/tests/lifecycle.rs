//! T-278 (Codex review 0yr2lewl): the account's lifecycle, sign-in, sign-out and a device ended on the homeserver,
//! checked as a restart would find it. The homeserver is outside this crate, so it is faked at the HTTP level on
//! 127.0.0.1; everything of ours is real: the account, its encrypted store, its saved record. The fake can hold a
//! logout open until the test lets it go (a slow sign-out) and can revoke a token (a device signed out elsewhere).

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering::SeqCst},
        Arc, Mutex,
    },
    time::Duration,
};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tokio::sync::Notify;
use uni_messages::{FileSecrets, Messages, Secrets};

// ── the fake homeserver ─────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Fake {
    /// Who logged in, in order (localparts).
    logins: Mutex<Vec<String>>,
    /// Whose devices logged out (localparts).
    logouts: Mutex<Vec<String>>,
    /// Access token → localpart.
    tokens: Mutex<Vec<(String, String)>>,
    revoked: Mutex<HashSet<String>>,
    hold_next_logout: Mutex<bool>,
    logout_held: Notify,
    release_logout: Notify,
    n: AtomicUsize,
}

struct Homeserver {
    url: String,
    fake: Arc<Fake>,
}

fn who(fake: &Fake, headers: &HeaderMap) -> Option<String> {
    let token = headers.get("authorization")?.to_str().ok()?.strip_prefix("Bearer ")?.to_owned();
    fake.tokens.lock().unwrap().iter().find(|(t, _)| *t == token).map(|(_, u)| u.clone())
}

fn revoked(fake: &Fake, headers: &HeaderMap) -> bool {
    who(fake, headers).is_some_and(|u| fake.revoked.lock().unwrap().contains(&u))
}

fn unknown_token() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({ "errcode": "M_UNKNOWN_TOKEN", "error": "Unknown access token" }))).into_response()
}

async fn versions() -> Json<Value> {
    Json(json!({
        "versions": ["v1.1", "v1.2", "v1.3", "v1.4", "v1.5", "v1.6", "v1.7", "v1.8", "v1.9", "v1.10", "v1.11"],
        "unstable_features": { "org.matrix.simplified_msc3575": true }
    }))
}

async fn login(State(fake): State<Arc<Fake>>, Json(body): Json<Value>) -> Response {
    let user = body["identifier"]["user"].as_str().unwrap_or_default().trim_start_matches('@').split(':').next().unwrap_or_default().to_owned();
    if body["password"] != "pw" {
        return (StatusCode::FORBIDDEN, Json(json!({ "errcode": "M_FORBIDDEN", "error": "Invalid password" }))).into_response();
    }
    let n = fake.n.fetch_add(1, SeqCst) + 1;
    let token = format!("token-{user}-{n}");
    fake.tokens.lock().unwrap().push((token.clone(), user.clone()));
    fake.logins.lock().unwrap().push(user.clone());
    Json(json!({ "user_id": format!("@{user}:example.org"), "access_token": token, "device_id": format!("DEVICE{n}"), "home_server": "example.org" })).into_response()
}

async fn logout(State(fake): State<Arc<Fake>>, headers: HeaderMap) -> Response {
    let user = who(&fake, &headers).unwrap_or_default();
    let hold = std::mem::take(&mut *fake.hold_next_logout.lock().unwrap());
    if hold {
        fake.logout_held.notify_one();
        fake.release_logout.notified().await;
    }
    fake.logouts.lock().unwrap().push(user);
    Json(json!({})).into_response()
}

/// Sync is held open, as a long poll with nothing new would be, until the token is revoked.
async fn sync(State(fake): State<Arc<Fake>>, headers: HeaderMap) -> Response {
    loop {
        if revoked(&fake, &headers) {
            return unknown_token();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn keys_upload() -> Json<Value> {
    Json(json!({ "one_time_key_counts": { "signed_curve25519": 50 } }))
}

async fn keys_query() -> Json<Value> {
    Json(json!({ "device_keys": {}, "failures": {} }))
}

async fn other(State(fake): State<Arc<Fake>>, headers: HeaderMap) -> Response {
    if revoked(&fake, &headers) {
        return unknown_token();
    }
    (StatusCode::NOT_FOUND, Json(json!({ "errcode": "M_UNRECOGNIZED", "error": "Unrecognized request" }))).into_response()
}

impl Homeserver {
    async fn start() -> Self {
        let fake = Arc::new(Fake::default());
        let app = Router::new()
            .route("/_matrix/client/versions", get(versions))
            .route("/_matrix/client/v3/login", post(login))
            .route("/_matrix/client/v3/logout", post(logout))
            .route("/_matrix/client/unstable/org.matrix.simplified_msc3575/sync", post(sync))
            .route("/_matrix/client/v3/keys/upload", post(keys_upload))
            .route("/_matrix/client/v3/keys/query", post(keys_query))
            .fallback(other)
            .with_state(fake.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Homeserver { url, fake }
    }

    fn hold_next_logout(&self) {
        *self.fake.hold_next_logout.lock().unwrap() = true;
    }

    async fn logout_held(&self) {
        self.fake.logout_held.notified().await;
    }

    fn release_logout(&self) {
        self.fake.release_logout.notify_one();
    }

    fn logged_out(&self, user: &str) -> bool {
        self.fake.logouts.lock().unwrap().iter().any(|u| u == user)
    }

    fn revoke(&self, user: &str) {
        self.fake.revoked.lock().unwrap().insert(user.to_owned());
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/// A `Secrets` whose writes can be made to fail: a full disk, or a keychain that says no.
struct Flaky {
    inner: FileSecrets,
    /// The write (counted from `fail_write`) that fails; 0: none.
    fail_at: AtomicUsize,
    writes: AtomicUsize,
}

impl Flaky {
    fn new(dir: PathBuf) -> Self {
        Flaky { inner: FileSecrets::new(dir), fail_at: AtomicUsize::new(0), writes: AtomicUsize::new(0) }
    }

    fn fail_write(&self, n: usize) {
        self.writes.store(0, SeqCst);
        self.fail_at.store(n, SeqCst);
    }
}

impl Secrets for Flaky {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        self.inner.get(name)
    }

    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        if self.writes.fetch_add(1, SeqCst) + 1 == self.fail_at.load(SeqCst) {
            return Err("no space left on device".into());
        }
        self.inner.set(name, value)
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        self.inner.delete(name)
    }
}

/// The store folders in an account's data folder, each with what is in it.
fn stores(data: &Path) -> Vec<(String, usize)> {
    let Ok(entries) = std::fs::read_dir(data) else { return vec![] };
    entries
        .flatten()
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .filter(|(name, path)| name.starts_with("store") && path.is_dir())
        .map(|(name, path)| (name, std::fs::read_dir(path).map(|d| d.count()).unwrap_or(0)))
        .collect()
}

/// What a restart finds: a new `Messages` over the same folders picks up the saved account.
async fn after_restart(data: &Path, secrets: &Path) -> uni_messages::Status {
    Messages::new(data.to_owned(), Arc::new(FileSecrets::new(secrets.to_owned()))).resume().await.expect("resume answers")
}

const ALICE: &str = "@alice:example.org";
const BOB: &str = "@bob:example.org";

// ── the tests ───────────────────────────────────────────────────────────────────────────────────────────────────────

/// Review finding 2: replacing an account used to take the running one out, then save the new key and the new session
/// as two writes. A failed first write left nothing running; a failed second write left the old session paired with
/// the new key, so its encrypted store could never be opened again. Whichever write fails now, the device keeps one
/// account, running and on disk together.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sign_in_that_cant_be_saved_leaves_the_old_account_running_and_on_disk() {
    let hs = Homeserver::start().await;
    for fail_at in 1..=2 {
        let tmp = tempfile::tempdir().unwrap();
        let (data, secrets_dir) = (tmp.path().join("data"), tmp.path().join("secrets"));
        let secrets = Arc::new(Flaky::new(secrets_dir.clone()));
        let m = Messages::new(data.clone(), secrets.clone());
        m.sign_in(&hs.url, "alice", "pw").await.expect("alice signs in");

        secrets.fail_write(fail_at);
        let replaced = m.sign_in(&hs.url, "bob", "pw").await;
        secrets.fail_write(0);
        let account = if replaced.is_ok() { BOB } else { ALICE };

        let s = m.status();
        assert_eq!(s.user_id.as_deref(), Some(account), "write {fail_at} failing: the status names {account}");
        assert_ne!(s.state, "signed_out", "write {fail_at} failing: {account} is signed in");
        assert!(m.rooms().await.is_ok(), "write {fail_at} failing: {account} is running, not just named");
        let left = stores(&data);
        assert_eq!(left.len(), 1, "write {fail_at} failing: only {account}'s store is left, found {left:?}");

        drop(m);
        let s = after_restart(&data, &secrets_dir).await;
        assert_eq!(s.user_id.as_deref(), Some(account), "write {fail_at} failing: a restart finds {account} ({:?})", s.error);
        assert_ne!(s.state, "signed_out", "write {fail_at} failing: a restart opens {account}'s store ({:?})", s.error);
    }
}

/// Review finding 3: a sign-out used to let go of the account, wait for the homeserver's logout, then delete the saved
/// account and every store. A sign-in made during that wait finished first, and the late sign-out deleted it. Now a
/// sign-in that comes while a sign-out is waiting for its logout ends signed in, with its store.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sign_in_while_a_sign_out_waits_for_its_logout_keeps_its_store() {
    let hs = Homeserver::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let (data, secrets_dir) = (tmp.path().join("data"), tmp.path().join("secrets"));
    let m = Messages::new(data.clone(), Arc::new(FileSecrets::new(secrets_dir.clone())));
    m.sign_in(&hs.url, "alice", "pw").await.expect("alice signs in");

    // alice signs out, and the homeserver is slow to answer her logout
    hs.hold_next_logout();
    let out = tokio::spawn({
        let m = m.clone();
        async move { m.sign_out().await }
    });
    hs.logout_held().await;

    // bob signs in meanwhile. If his sign-in goes ahead (his store appears, or his login reaches the homeserver), let
    // it finish before alice's logout comes back. It may also wait its turn.
    let inn = tokio::spawn({
        let (m, url) = (m.clone(), hs.url.clone());
        async move { m.sign_in(&url, "bob", "pw").await }
    });
    let gone_ahead = async {
        loop {
            if stores(&data).len() > 1 || hs.fake.logins.lock().unwrap().iter().any(|u| u == "bob") {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    if tokio::time::timeout(Duration::from_secs(2), gone_ahead).await.is_ok() {
        tokio::time::timeout(Duration::from_secs(60), async {
            while !inn.is_finished() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("bob's sign-in finishes");
    }
    hs.release_logout();
    out.await.unwrap().expect("alice's sign-out answers");
    inn.await.unwrap().expect("bob signs in");

    let s = m.status();
    assert_eq!(s.user_id.as_deref(), Some(BOB), "bob is the account: {s:?}");
    assert_ne!(s.state, "signed_out", "bob is signed in: {s:?}");
    assert!(m.rooms().await.is_ok(), "bob is running");
    let left = stores(&data);
    assert!(left.len() == 1 && left[0].1 > 0, "bob's store is on disk, and only his: {left:?}");
    assert!(hs.logged_out("alice"), "alice's device left the homeserver");

    drop(m);
    let s = after_restart(&data, &secrets_dir).await;
    assert_eq!(s.user_id.as_deref(), Some(BOB), "a restart finds bob ({:?})", s.error);
    assert_ne!(s.state, "signed_out", "a restart opens bob's store ({:?})", s.error);
}

/// A device the homeserver no longer knows (signed out elsewhere, its token revoked) ends here too: signed out, with
/// the reason, its store and saved account gone. And the next sign-in works.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_device_ended_on_the_homeserver_signs_out_here() {
    let hs = Homeserver::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let (data, secrets_dir) = (tmp.path().join("data"), tmp.path().join("secrets"));
    let m = Messages::new(data.clone(), Arc::new(FileSecrets::new(secrets_dir.clone())));
    m.sign_in(&hs.url, "alice", "pw").await.expect("alice signs in");

    hs.revoke("alice");
    tokio::time::timeout(Duration::from_secs(30), async {
        while m.status().state != "signed_out" {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the app notices");
    let s = m.status();
    assert!(s.error.as_deref().unwrap_or_default().contains("signed out on the homeserver"), "it says why: {s:?}");
    assert!(m.rooms().await.is_err(), "nothing is running");
    assert!(stores(&data).is_empty(), "the store is gone: {:?}", stores(&data));
    assert_eq!(after_restart(&data, &secrets_dir).await.state, "signed_out", "nothing is saved");

    m.sign_in(&hs.url, "bob", "pw").await.expect("bob signs in");
    assert_eq!(m.status().user_id.as_deref(), Some(BOB));
}
