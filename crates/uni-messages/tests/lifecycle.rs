//! T-278 (Codex review 0yr2lewl and the review after it): the account's lifecycle, sign-in, sign-out and a device ended
//! on the homeserver, checked as a restart finds it (the first instance shut down, a new one over the same folders).
//! The homeserver is outside this crate, so it is faked at the HTTP level on 127.0.0.1; everything of ours is real: the
//! account, its encrypted store, its saved record. The fake can hold a login or a logout open until the test lets it
//! go, and can refuse a token (a device signed out elsewhere).

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
    hold_next_login: Mutex<bool>,
    login_held: Notify,
    release_login: Notify,
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
    if std::mem::take(&mut *fake.hold_next_login.lock().unwrap()) {
        fake.login_held.notify_one();
        fake.release_login.notified().await;
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

    fn hold_next_login(&self) {
        *self.fake.hold_next_login.lock().unwrap() = true;
    }

    async fn login_held(&self) {
        self.fake.login_held.notified().await;
    }

    fn release_login(&self) {
        self.fake.release_login.notify_one();
    }

    fn logged_out(&self, user: &str) -> bool {
        self.fake.logouts.lock().unwrap().iter().any(|u| u == user)
    }

    fn revoke(&self, user: &str) {
        self.fake.revoked.lock().unwrap().insert(user.to_owned());
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/// How the next write fails: before anything is written (a full disk), or after the value is in place (a keychain
/// that stores, then answers with an error).
#[derive(Clone, Copy, Debug, PartialEq)]
enum Fail {
    Before,
    After,
}

/// A `Secrets` whose next write can be made to fail.
struct Flaky {
    inner: FileSecrets,
    next: Mutex<Option<Fail>>,
    fail_delete: Mutex<bool>,
}

impl Flaky {
    fn new(dir: PathBuf) -> Self {
        Flaky { inner: FileSecrets::new(dir), next: Mutex::new(None), fail_delete: Mutex::new(false) }
    }

    fn fail_next_write(&self, how: Fail) {
        *self.next.lock().unwrap() = Some(how);
    }

    fn fail_next_delete(&self) {
        *self.fail_delete.lock().unwrap() = true;
    }
}

impl Secrets for Flaky {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        self.inner.get(name)
    }

    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        match self.next.lock().unwrap().take() {
            Some(Fail::Before) => Err("no space left on device".into()),
            Some(Fail::After) => {
                self.inner.set(name, value)?;
                Err("the keychain answered with an error".into())
            }
            None => self.inner.set(name, value),
        }
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        if std::mem::take(&mut *self.fail_delete.lock().unwrap()) {
            return Err("permission denied".into());
        }
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

/// What a restart finds: the running instance shuts down (as the app does when it quits), then a new `Messages` over
/// the same folders picks up the saved account.
async fn after_restart(m: Arc<Messages>, data: &Path, secrets: &Path) -> uni_messages::Status {
    m.shut_down().await;
    drop(m);
    let again = Messages::new(data.to_owned(), Arc::new(FileSecrets::new(secrets.to_owned())));
    let s = again.resume().await.expect("resume answers");
    again.shut_down().await;
    s
}

/// Wait until `f` holds, or fail after `secs`.
async fn until(secs: u64, what: &str, mut f: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(secs), async {
        while !f() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{what}"));
}

const ALICE: &str = "@alice:example.org";
const BOB: &str = "@bob:example.org";

// ── the tests ───────────────────────────────────────────────────────────────────────────────────────────────────────

/// Review finding 2: replacing an account used to take the running one out, then save the new key and the new session
/// as two writes. A failed first write left nothing running; a failed second write left the old session paired with
/// the new key, so its encrypted store could never be opened again. Now the account is saved in one write before it
/// replaces the running one. If that write fails, the old account goes on and the new device leaves the homeserver
/// again; if the write reports an error but did save (the review after it), the saved one is the account. Either way
/// the account running is the account a restart finds.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sign_in_whose_save_fails_leaves_one_account_running_and_saved() {
    for fail in [Fail::Before, Fail::After] {
        let hs = Homeserver::start().await;
        let tmp = tempfile::tempdir().unwrap();
        let (data, secrets_dir) = (tmp.path().join("data"), tmp.path().join("secrets"));
        let secrets = Arc::new(Flaky::new(secrets_dir.clone()));
        let m = Messages::new(data.clone(), secrets.clone());
        m.sign_in(&hs.url, "alice", "pw").await.expect("alice signs in");

        secrets.fail_next_write(fail);
        let replaced = m.sign_in(&hs.url, "bob", "pw").await;
        let account = match fail {
            Fail::Before => {
                assert!(replaced.is_err(), "nothing was saved, so the sign-in failed: {replaced:?}");
                assert!(hs.logged_out("bob") && !hs.logged_out("alice"), "bob's new device left the homeserver again; alice's stayed");
                ALICE
            }
            Fail::After => {
                assert!(replaced.is_ok(), "the save reported an error but did save, so bob is the account: {replaced:?}");
                assert!(hs.logged_out("alice") && !hs.logged_out("bob"), "alice's old device left the homeserver; bob's stayed");
                BOB
            }
        };

        let s = m.status();
        assert_eq!(s.user_id.as_deref(), Some(account), "{fail:?}: the status names {account}");
        assert_ne!(s.state, "signed_out", "{fail:?}: {account} is signed in");
        assert!(m.rooms().await.is_ok(), "{fail:?}: {account} is running, not just named");
        let left = stores(&data);
        assert_eq!(left.len(), 1, "{fail:?}: only {account}'s store is left, found {left:?}");

        let s = after_restart(m, &data, &secrets_dir).await;
        assert_eq!(s.user_id.as_deref(), Some(account), "{fail:?}: a restart finds {account} ({:?})", s.error);
        assert_ne!(s.state, "signed_out", "{fail:?}: a restart opens {account}'s store ({:?})", s.error);
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

    let s = after_restart(m, &data, &secrets_dir).await;
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
    until(30, "the app notices", || m.status().state == "signed_out").await;
    let s = m.status();
    assert!(s.error.as_deref().unwrap_or_default().contains("signed out on the homeserver"), "it says why: {s:?}");
    assert!(m.rooms().await.is_err(), "nothing is running");
    assert!(stores(&data).is_empty(), "the store is gone: {:?}", stores(&data));
    let probe = Messages::new(data.clone(), Arc::new(FileSecrets::new(secrets_dir.clone())));
    assert_eq!(probe.resume().await.unwrap().state, "signed_out", "nothing is saved");
    drop(probe);

    m.sign_in(&hs.url, "bob", "pw").await.expect("bob signs in");
    assert_eq!(m.status().user_id.as_deref(), Some(BOB));
    assert_eq!(after_restart(m, &data, &secrets_dir).await.user_id.as_deref(), Some(BOB), "a restart finds bob");
}

/// The review after 0yr2lewl: a refusal that comes for an account that has meanwhile been replaced leaves the new one
/// alone. Alice's token is refused while bob's sign-in holds the turn (his login held open); her session watch asks to
/// end her session and waits its turn; by then bob is the account, and he stays.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refusal_for_an_account_replaced_meanwhile_leaves_the_new_one_alone() {
    let hs = Homeserver::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let (data, secrets_dir) = (tmp.path().join("data"), tmp.path().join("secrets"));
    let m = Messages::new(data.clone(), Arc::new(FileSecrets::new(secrets_dir.clone())));
    m.sign_in(&hs.url, "alice", "pw").await.expect("alice signs in");

    hs.hold_next_login();
    let inn = tokio::spawn({
        let (m, url) = (m.clone(), hs.url.clone());
        async move { m.sign_in(&url, "bob", "pw").await }
    });
    hs.login_held().await;
    hs.revoke("alice");
    // alice's sync is refused within 100 ms; give her session watch time to ask
    tokio::time::sleep(Duration::from_secs(1)).await;
    hs.release_login();
    inn.await.unwrap().expect("bob signs in");
    // the request to end alice's session runs now, after bob's sign-in
    tokio::time::sleep(Duration::from_secs(1)).await;

    let s = m.status();
    assert_eq!(s.user_id.as_deref(), Some(BOB), "bob is still the account: {s:?}");
    assert_ne!(s.state, "signed_out", "bob is still signed in: {s:?}");
    assert!(m.rooms().await.is_ok(), "bob is running");
    assert_eq!(stores(&data).len(), 1, "bob's store is there: {:?}", stores(&data));
    let s = after_restart(m, &data, &secrets_dir).await;
    assert_eq!(s.user_id.as_deref(), Some(BOB), "a restart finds bob ({:?})", s.error);
}

/// The review after 0yr2lewl: a sign-out that can't remove the saved account keeps its store too, so a restart never
/// finds the record without its store (it would reopen over an empty one); and it says so.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sign_out_that_cant_remove_the_saved_account_keeps_its_store() {
    let hs = Homeserver::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let (data, secrets_dir) = (tmp.path().join("data"), tmp.path().join("secrets"));
    let secrets = Arc::new(Flaky::new(secrets_dir.clone()));
    let m = Messages::new(data.clone(), secrets.clone());
    m.sign_in(&hs.url, "alice", "pw").await.expect("alice signs in");

    secrets.fail_next_delete();
    let s = m.sign_out().await.expect("sign-out answers");
    assert_eq!(s.state, "signed_out", "signed out on this device: {s:?}");
    assert!(s.error.as_deref().unwrap_or_default().contains("couldn't be removed"), "it says so: {s:?}");
    assert_eq!(stores(&data).len(), 1, "the store stays with its record: {:?}", stores(&data));
    let s = after_restart(m, &data, &secrets_dir).await;
    assert!(!s.error.as_deref().unwrap_or_default().contains("store is gone"), "a restart never finds the record without its store: {s:?}");
}

/// The review after 0yr2lewl: a saved account whose store is gone is refused, not reopened over a new, empty store
/// (no keys for a device the homeserver knows), and nothing else is deleted for it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_saved_account_whose_store_is_gone_is_not_reopened_empty() {
    let hs = Homeserver::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let (data, secrets_dir) = (tmp.path().join("data"), tmp.path().join("secrets"));
    let m = Messages::new(data.clone(), Arc::new(FileSecrets::new(secrets_dir.clone())));
    m.sign_in(&hs.url, "alice", "pw").await.expect("alice signs in");
    m.shut_down().await;
    drop(m);

    let (alice_store, _) = stores(&data).pop().expect("alice's store");
    std::fs::remove_dir_all(data.join(&alice_store)).unwrap();
    std::fs::create_dir_all(data.join("store-leftover")).unwrap();

    let again = Messages::new(data.clone(), Arc::new(FileSecrets::new(secrets_dir.clone())));
    let s = again.resume().await.expect("resume answers");
    assert_eq!(s.state, "signed_out", "the account isn't reopened: {s:?}");
    assert!(s.error.as_deref().unwrap_or_default().contains("store is gone"), "it says why: {s:?}");
    assert!(!data.join(&alice_store).exists(), "no empty store was made for it");
    assert!(data.join("store-leftover").exists(), "nothing else was deleted for it");
    again.sign_in(&hs.url, "bob", "pw").await.expect("a new sign-in replaces it");
    assert_eq!(again.status().user_id.as_deref(), Some(BOB));
}
