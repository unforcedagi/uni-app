//! T-45 v2: both mailboxes through the bridge, against a local JMAP double over real HTTP that serves two accounts
//! shared with each other (`support/fake_mail_bridge.rs`, `start_shared`), and against a v1 bridge (one account).

#[path = "support/fake_mail_bridge.rs"]
mod fake;

use std::path::{Path, PathBuf};

use fake::{sample_mail, shared_mail, FakeBridge};
use nostr::Keys;
use uni_core::mail::{open_attachment_in, MailBridge, MailError, Source, Who, READ_METHODS};

async fn shared(keys: &Keys) -> FakeBridge {
    let (a, u, triage) = shared_mail();
    let fake = FakeBridge::start_shared(0, &[keys.public_key().to_hex()], a, vec![u]).await;
    fake.state.lock().unwrap().triage = triage;
    fake
}

fn inbox(account: &str) -> Source {
    Source { account_id: account.into(), mailbox_id: Some(format!("{account}-inbox")), exclude: vec![], position: 0 }
}

/// A whole account, less Junk and Trash: what a search reads.
fn whole(account: &str) -> Source {
    Source { account_id: account.into(), mailbox_id: None, exclude: vec![format!("{account}-junk"), format!("{account}-trash")], position: 0 }
}

fn ids(page: &uni_core::mail::ThreadPage) -> Vec<String> {
    page.threads.iter().map(|t| format!("{}/{}", t.account_id, t.thread_id)).collect()
}

#[tokio::test]
async fn the_session_has_the_keys_own_account_first_and_the_shared_one_as_uni() {
    let keys = Keys::generate();
    let fake = shared(&keys).await;
    let s = MailBridge::new(&fake.url, &keys).unwrap().session().await.unwrap();
    assert!(s.multi);
    assert_eq!(s.login, "robin@example.com");
    assert_eq!(s.accounts.iter().map(|a| (a.id.as_str(), a.name.as_str(), a.who)).collect::<Vec<_>>(), [
        ("A", "robin@example.com", Who::Owner),
        ("U", "uni@example.com", Who::Uni),
    ]);
}

#[tokio::test]
async fn the_overview_lists_each_accounts_mailboxes_with_counts() {
    let keys = Keys::generate();
    let fake = shared(&keys).await;
    let o = MailBridge::new(&fake.url, &keys).unwrap().overview().await.unwrap();
    assert_eq!(o.accounts.len(), 2);
    let (a, u) = (&o.accounts[0], &o.accounts[1]);
    assert_eq!((a.id.as_str(), a.who, u.id.as_str(), u.who), ("A", Who::Owner, "U", Who::Uni));
    assert_eq!(a.mailboxes[0].role.as_deref(), Some("inbox"));
    assert_eq!((a.mailboxes[0].total, a.mailboxes[0].unread), (4, 2), "a1 a3 a4 a5; a3 and a4 unread");
    assert_eq!((u.mailboxes[0].total, u.mailboxes[0].unread), (3, 2), "u1 u2 u4; u1 and u4 unread");
    // each account's Mailbox/get named that account
    let calls = fake.state.lock().unwrap().calls.clone();
    let boxes: Vec<_> = calls.iter().filter(|(m, _)| m == "Mailbox/get").map(|(_, a)| a.clone()).collect();
    assert_eq!(boxes, [Some("A".to_string()), Some("U".to_string())]);
}

#[tokio::test]
async fn a_v1_bridge_is_one_account_of_the_keys_own() {
    let keys = Keys::generate();
    let fake = FakeBridge::start(0, &[keys.public_key().to_hex()], sample_mail()).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let o = mail.overview().await.unwrap();
    assert!(!o.multi);
    assert_eq!(o.accounts.len(), 1);
    assert_eq!((o.accounts[0].id.as_str(), o.accounts[0].name.as_str(), o.accounts[0].who), ("a", "owner@example.com", Who::Owner));
    let page = mail.threads(&[Source { account_id: "a".into(), mailbox_id: Some("mb-inbox".into()), exclude: vec![], position: 0 }], None, 50).await.unwrap();
    assert_eq!(ids(&page), ["a/Tm1", "a/Tm2", "a/Tm4", "a/Tm5"]);
    assert!(mail.triage("a", &["m1".into()]).await.unwrap().is_empty(), "no triage on a v1 bridge: no notes, not an error");
}

#[tokio::test]
async fn the_combined_inbox_merges_both_accounts_newest_first_and_pages_each() {
    let keys = Keys::generate();
    let fake = shared(&keys).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let all = mail.threads(&[inbox("A"), inbox("U")], None, 50).await.unwrap();
    assert_eq!(ids(&all), ["A/TA-plan", "U/Tu1", "U/TU-read", "A/Ta4", "A/Ta5", "U/Tu4"]);
    assert_eq!(all.total, Some(6));
    assert!(!all.more);
    let plan = &all.threads[0];
    assert_eq!((plan.email_id.as_str(), plan.count, plan.unread), ("a3", 4, true), "the newest in the Inbox; four in the thread with Sent and Drafts");
    let read = &all.threads[2];
    assert_eq!((read.count, read.unread), (3, false), "u2 and u3 read; the draft doesn't count as unread");
    assert!(all.threads[3].has_attachment);

    // two at a time: each account carries on where it stopped
    let mut seen = Vec::new();
    let mut sources = vec![inbox("A"), inbox("U")];
    for _ in 0..3 {
        let page = mail.threads(&sources, None, 2).await.unwrap();
        seen.extend(ids(&page));
        sources = page.next;
        if !page.more {
            break;
        }
    }
    assert_eq!(seen, ids(&all));
    assert_eq!(sources.iter().map(|s| s.position).collect::<Vec<_>>(), [3, 3]);
}

#[tokio::test]
async fn search_reads_one_account_or_both_and_skips_junk() {
    let keys = Keys::generate();
    let fake = shared(&keys).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let a = mail.threads(&[whole("A")], Some("marmalade"), 50).await.unwrap();
    assert_eq!(ids(&a), ["A/TA-plan"], "found in a1's body; the Junk copy is left out");
    assert_eq!(a.threads[0].email_id, "a1", "the row is the message that matched");
    assert!(mail.threads(&[whole("U")], Some("marmalade"), 50).await.unwrap().threads.is_empty(), "A's word isn't in U");
    let both = mail.threads(&[whole("A"), whole("U")], Some("lighthouse"), 50).await.unwrap();
    assert_eq!(ids(&both), ["U/Tu1"]);
    let both = mail.threads(&[whole("A"), whole("U")], Some("THURSDAY"), 50).await.unwrap();
    assert_eq!(ids(&both), ["U/TU-read"], "case doesn't matter; one row per thread");
    // the text went to the server as a JMAP text filter
    assert!(mail.threads(&[whole("A")], Some(&"x".repeat(201)), 50).await.is_err(), "too long: never sent");
}

#[tokio::test]
async fn a_thread_opens_oldest_first_with_its_draft_and_reading_marks_nothing_read() {
    let keys = Keys::generate();
    let fake = shared(&keys).await;
    let before = fake.state.lock().unwrap().keywords();
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let t = mail.thread("A", "TA-plan").await.unwrap();
    assert_eq!(t.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["a1", "a2", "a3", "a6"]);
    assert!(t.messages[2].unread, "still unread after reading");
    let draft = &t.messages[3];
    assert!(draft.draft && draft.uni_drafted);
    assert_eq!(draft.mailbox_ids, ["A-drafts"]);
    assert!(t.messages[0].text.as_deref().unwrap().contains("marmalade"));
    let u = mail.thread("U", "TU-read").await.unwrap();
    assert_eq!(u.messages.iter().map(|m| (m.id.as_str(), m.draft, m.uni_drafted)).collect::<Vec<_>>(), [("u2", false, false), ("u3", false, false), ("u5", true, false)]);
    assert_eq!(fake.state.lock().unwrap().keywords(), before);
    assert!(matches!(mail.thread("A", "TU-read").await, Err(MailError::Invalid { .. })), "U's thread isn't in A");
}

#[tokio::test]
async fn an_account_outside_the_session_is_refused() {
    let keys = Keys::generate();
    let fake = shared(&keys).await;
    let e = MailBridge::new(&fake.url, &keys).unwrap().threads(&[inbox("Z")], None, 10).await.unwrap_err();
    assert!(matches!(e, MailError::Server { ref message } if message.contains("accountNotFound")), "{e:?}");
}

/// Open through the real path; what the opener was handed, if anything.
async fn open(mail: &MailBridge<'_>, cache: &Path, account: &str, blob: &str, name: &str, mime: &str) -> (Result<PathBuf, MailError>, Option<PathBuf>) {
    let mut handed = None;
    let r = open_attachment_in(mail, cache, Some(account), blob, Some(name), Some(mime), |p: &Path| {
        handed = Some(p.to_path_buf());
        Ok(())
    })
    .await;
    (r, handed)
}

#[tokio::test]
async fn attachments_keep_v1s_gates_and_open_from_their_own_account() {
    let keys = Keys::generate();
    let fake = shared(&keys).await;
    let cache = tempfile::tempdir().unwrap();
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let t = mail.thread("A", "Ta4").await.unwrap();
    let atts = &t.messages[0].attachments;
    assert_eq!(atts.iter().map(|a| (a.name.as_deref().unwrap(), a.refused.is_some())).collect::<Vec<_>>(), [
        ("workshop-notes.pdf", false),
        ("poster-proof.png", false),
        ("setup.exe", true),
    ], "only the name/type refusal is known before Open");
    assert!(atts[2].refused.as_deref().unwrap().contains(".exe files"));

    let (r, handed) = open(&mail, cache.path(), "A", "Bnotes-pdf", "workshop-notes.pdf", "application/pdf").await;
    assert_eq!(std::fs::read(r.unwrap()).unwrap(), include_bytes!("fixtures/attachments/notes.pdf"));
    assert!(handed.is_some());
    let (r, handed) = open(&mail, cache.path(), "A", "Bproof-svg", "poster-proof.png", "image/png").await;
    assert!(matches!(r, Err(MailError::Invalid { ref message }) if message.contains("SVG")), "{r:?}");
    assert!(handed.is_none());
    let raws = |f: &FakeBridge| f.state.lock().unwrap().requests.iter().filter(|(p, _)| p == "/mail/raw").count();
    let before = raws(&fake);
    let (r, _) = open(&mail, cache.path(), "A", "Bsetup-exe", "setup.exe", "application/octet-stream").await;
    assert!(r.is_err());
    assert_eq!(raws(&fake), before, "refused by name: nothing fetched");

    // Uni's invoice is in U: it opens from U, and isn't found in A
    let (r, _) = open(&mail, cache.path(), "U", "Binvoice-pdf", "invoice-october.pdf", "application/pdf").await;
    assert!(r.is_ok(), "{r:?}");
    let (r, _) = open(&mail, cache.path(), "A", "Binvoice-pdf", "invoice-october.pdf", "application/pdf").await;
    assert!(matches!(r, Err(MailError::Server { .. })), "{r:?}");
}

#[tokio::test]
async fn triage_notes_come_from_the_bridge_as_one_plain_line() {
    let keys = Keys::generate();
    let fake = shared(&keys).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let notes = mail.triage("A", &["a1".into(), "a3".into(), "a4".into()]).await.unwrap();
    assert_eq!(notes.len(), 2, "a1 has none");
    assert_eq!(notes["a3"], "Needs you: Mara asks which day to start.");
    assert_eq!(notes["a4"], "<b>Two files</b> pass the checks; setup.exe won't open.", "text, which the app shows as text");
    assert_eq!(mail.triage("U", &["u1".into()]).await.unwrap()["u1"], "Routine. Nothing to do.");
    assert!(mail.triage("A", &["u1".into()]).await.unwrap().is_empty(), "keyed by account and id");
}

/// Everything the Mail view does, against a server that would accept writes: the app sends none, and nothing is marked read.
#[tokio::test]
async fn no_write_method_is_ever_sent_and_nothing_is_marked_read() {
    let keys = Keys::generate();
    let fake = shared(&keys).await;
    fake.state.lock().unwrap().accept_writes = true;
    let before = fake.state.lock().unwrap().keywords();
    let cache = tempfile::tempdir().unwrap();
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    mail.overview().await.unwrap();
    let page = mail.threads(&[inbox("A"), inbox("U")], None, 50).await.unwrap();
    for t in &page.threads {
        mail.thread(&t.account_id, &t.thread_id).await.unwrap();
    }
    mail.threads(&[whole("A"), whole("U")], Some("garden"), 50).await.unwrap();
    mail.triage("A", &["a3".into()]).await.unwrap();
    let _ = open(&mail, cache.path(), "A", "Bnotes-pdf", "workshop-notes.pdf", "application/pdf").await;
    let _ = open(&mail, cache.path(), "U", "Binvoice-pdf", "invoice-october.pdf", "application/pdf").await;

    let s = fake.state.lock().unwrap();
    assert!(s.calls.len() > 20, "the flow ran: {} calls", s.calls.len());
    for (method, _) in &s.calls {
        assert!(READ_METHODS.contains(&method.as_str()), "sent {method}");
        assert!(!method.ends_with("/set") && !method.starts_with("EmailSubmission") && !method.ends_with("/import") && !method.ends_with("/copy"), "sent {method}");
    }
    assert_eq!(s.keywords(), before, "no $seen (or any keyword) changed");
}

/// Codex review 1, P0: a bridge that lists both accounts but reads only the key's own (a half-done upgrade) must not show
/// the owner's mail as Uni's. Every answer names its account, and a mismatch fails closed.
#[tokio::test]
async fn a_bridge_that_lists_both_accounts_but_reads_one_fails_closed() {
    let keys = Keys::generate();
    let fake = shared(&keys).await;
    fake.state.lock().unwrap().honour_account = false;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let e = mail.overview().await.unwrap_err();
    assert!(matches!(e, MailError::Invalid { ref message } if message.contains("answered for account A when asked about U")), "{e:?}");
    assert!(mail.threads(&[inbox("A"), inbox("U")], None, 50).await.is_err());
    assert!(mail.thread("U", "TU-read").await.is_err());
    assert!(mail.threads(&[inbox("A")], None, 50).await.is_ok(), "its own account still reads");
}

/// Codex review 1, P0: an account shared with the key that the bridge doesn't name as Uni's is never listed or read.
#[tokio::test]
async fn a_shared_account_the_bridge_doesnt_name_is_not_shown() {
    let keys = Keys::generate();
    let (a, u, _) = shared_mail();
    let (mut other, _, _) = shared_mail();
    other.id = "Z".into();
    other.account = "someone@example.com".into();
    let fake = FakeBridge::start_shared(0, &[keys.public_key().to_hex()], a, vec![u, other]).await;
    fake.state.lock().unwrap().roles = Some(serde_json::json!({ "A": "owner", "U": "uni" }));
    let o = MailBridge::new(&fake.url, &keys).unwrap().overview().await.unwrap();
    assert_eq!(o.accounts.iter().map(|a| (a.id.as_str(), a.who)).collect::<Vec<_>>(), [("A", Who::Owner), ("U", Who::Uni)]);
    let read: Vec<_> = fake.state.lock().unwrap().calls.iter().filter_map(|(_, a)| a.clone()).collect();
    assert!(!read.iter().any(|a| a == "Z"), "Z was never read: {read:?}");
}
