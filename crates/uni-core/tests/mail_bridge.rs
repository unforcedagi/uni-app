//! T-45: the app's mail client against a fake mail bridge over real HTTP
//! (`support/fake_mail_bridge.rs`, which checks NIP-98 the way the real bridge does).

#[path = "support/fake_mail_bridge.rs"]
mod fake;

use fake::{email, sample_mail, FakeBridge, Mail};
use nostr::Keys;
use uni_core::mail::{MailBridge, MailError};

async fn bridge_for(keys: &Keys) -> FakeBridge {
    FakeBridge::start(0, &[keys.public_key().to_hex()], sample_mail()).await
}

#[tokio::test]
async fn lists_mailboxes_inbox_first_with_the_account() {
    let keys = Keys::generate();
    let fake = bridge_for(&keys).await;
    let acct = MailBridge::new(&fake.url, &keys).unwrap().mailboxes().await.unwrap();
    assert_eq!(acct.account, "owner@example.com");
    let names: Vec<&str> = acct.mailboxes.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["Inbox", "Archive", "Junk Mail"]);
    let inbox = &acct.mailboxes[0];
    assert_eq!((inbox.total, inbox.unread), (4, 2));
}

#[tokio::test]
async fn a_page_is_newest_first_with_unread_state() {
    let keys = Keys::generate();
    let fake = bridge_for(&keys).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let page = mail.messages("mb-inbox", 0, 50).await.unwrap();
    assert_eq!(page.total, Some(4));
    let ids: Vec<&str> = page.messages.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["m1", "m2", "m4", "m5"], "newest first, though the server answered in another order");
    assert!(page.messages[0].unread && page.messages[1].unread && !page.messages[2].unread);
    assert_eq!(page.messages[0].from[0].email, "test@mail.example.com");
    assert!(page.messages[0].preview.starts_with("Hi Uni,"));
    assert!(page.messages[2].has_attachment);
    // paging
    let next = mail.messages("mb-inbox", 2, 2).await.unwrap();
    assert_eq!(next.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m4", "m5"]);
    assert_eq!(next.position, 2);
}

#[tokio::test]
async fn an_empty_mailbox_is_an_empty_page_not_an_error() {
    let keys = Keys::generate();
    let fake = bridge_for(&keys).await;
    let page = MailBridge::new(&fake.url, &keys).unwrap().messages("mb-archive", 0, 50).await.unwrap();
    assert_eq!(page.total, Some(0));
    assert!(page.messages.is_empty());
}

#[tokio::test]
async fn reading_gives_plain_text_and_sanitized_html_and_never_marks_read() {
    let keys = Keys::generate();
    let fake = bridge_for(&keys).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();

    let plain = mail.message("m1").await.unwrap();
    assert!(plain.text.as_deref().unwrap().contains("the read-only bridge works"));
    assert_eq!(plain.html, None);
    assert!(plain.unread);

    let news = mail.message("m2").await.unwrap();
    assert_eq!(news.text, None, "HTML-only: no plain text is invented");
    let html = news.html.unwrap();
    assert!(html.contains("This week at Hilltop Tech Night") && html.contains("RSVP here"));
    for bad in ["<script", "onclick", "tracker.example", "cdn.example"] {
        assert!(!html.contains(bad), "{bad} reached the app: {html}");
    }
    assert_eq!(news.remote_images, 2);

    let notes = mail.message("m4").await.unwrap();
    assert!(notes.text.is_some() && notes.html.is_some());
    assert_eq!(notes.attachments.len(), 3);
    assert_eq!(notes.attachments[0].name.as_deref(), Some("thursday-notes.pdf"));
    let bytes = mail.blob(&notes.attachments[0].blob_id).await.unwrap();
    assert!(bytes.starts_with(b"%PDF"));

    // read-only: everything the bridge forwarded was a read, and the message is still unread
    let forwarded = fake.state.lock().unwrap().forwarded.clone();
    assert!(forwarded.iter().all(|m| m.ends_with("/get") || m.ends_with("/query")), "{forwarded:?}");
    assert!(mail.message("m1").await.unwrap().unread);
}

#[tokio::test]
async fn a_key_the_bridge_does_not_allow_is_named() {
    let allowed = Keys::generate();
    let stranger = Keys::generate();
    let fake = bridge_for(&allowed).await;
    let e = MailBridge::new(&fake.url, &stranger).unwrap().mailboxes().await.unwrap_err();
    assert_eq!(e, MailError::NotAllowed { message: "pubkey not allowed".into(), pubkey: stranger.public_key().to_hex() });
}

#[tokio::test]
async fn a_bridge_that_is_down_is_unreachable() {
    // bind, learn the port, close: nothing listens there
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let e = MailBridge::new(&format!("http://127.0.0.1:{port}"), &Keys::generate()).unwrap().mailboxes().await.unwrap_err();
    assert!(matches!(e, MailError::Unreachable { .. }), "{e:?}");
}

#[tokio::test]
async fn the_mail_server_behind_the_bridge_failing_is_a_server_error() {
    let keys = Keys::generate();
    let fake = bridge_for(&keys).await;
    fake.state.lock().unwrap().server_down = true;
    let e = MailBridge::new(&fake.url, &keys).unwrap().messages("mb-inbox", 0, 50).await.unwrap_err();
    assert_eq!(e, MailError::Server { message: "mail server: URLError".into() });
}

#[tokio::test]
async fn a_signature_for_another_url_is_refused() {
    // the bridge checks `u` against its public URL; a client pointed at another name is refused, not served
    let keys = Keys::generate();
    let fake = bridge_for(&keys).await;
    let other = fake.url.replace("127.0.0.1", "localhost");
    let e = MailBridge::new(&other, &keys).unwrap().mailboxes().await.unwrap_err();
    assert_eq!(e, MailError::Refused { status: 401, message: "authorization is for a different request".into() });
}

#[tokio::test]
async fn signing_as_the_public_url_is_accepted_over_another_name() {
    let keys = Keys::generate();
    let fake = bridge_for(&keys).await;
    let other = fake.url.replace("127.0.0.1", "localhost");
    let acct = MailBridge::new(&other, &keys).unwrap().signing_as(&fake.url).unwrap().mailboxes().await.unwrap();
    assert_eq!(acct.mailboxes.len(), 3);
}

#[tokio::test]
async fn an_unreachable_hub_name_falls_back_to_its_alias_once() {
    let keys = Keys::generate();
    let fake = bridge_for(&keys).await;
    let gone = format!("http://127.0.0.1:{}", std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port());
    let acct = MailBridge::new(&gone, &keys).unwrap().with_alias(Some(&fake.url)).mailboxes().await.unwrap();
    assert_eq!(acct.mailboxes.len(), 3, "signed for the alias, answered by it");
}

#[tokio::test]
async fn an_answer_is_never_retried_on_the_alias() {
    let keys = Keys::generate();
    let fake = bridge_for(&keys).await;
    let other = bridge_for(&keys).await;
    fake.state.lock().unwrap().server_down = true;
    let e = MailBridge::new(&fake.url, &keys).unwrap().with_alias(Some(&other.url)).mailboxes().await.unwrap_err();
    assert!(matches!(e, MailError::Server { .. }), "{e:?}");
    assert!(other.state.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn the_html_links_are_listed_since_the_frame_cannot_follow_them() {
    let keys = Keys::generate();
    let fake = bridge_for(&keys).await;
    let news = MailBridge::new(&fake.url, &keys).unwrap().message("m2").await.unwrap();
    assert_eq!(news.links.len(), 1);
    assert_eq!(news.links[0].url, "https://bouldernewtech.example/rsvp");
    assert_eq!(news.links[0].text.as_deref(), Some("RSVP here"));
}

#[tokio::test]
async fn bad_ids_never_leave_the_device() {
    let keys = Keys::generate();
    let fake = bridge_for(&keys).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    assert!(matches!(mail.message("../m1").await, Err(MailError::Invalid { .. })));
    assert!(matches!(mail.blob("a/b").await, Err(MailError::Invalid { .. })));
    assert!(matches!(mail.messages("x y", 0, 10).await, Err(MailError::Invalid { .. })));
    assert!(fake.state.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn plain_http_to_another_machine_is_refused() {
    assert!(MailBridge::new("http://10.0.0.5:8452", &Keys::generate()).is_err());
}

#[tokio::test]
async fn a_message_gone_from_the_mailbox_says_so() {
    let keys = Keys::generate();
    let mail = Mail { account: "x@y".into(), mailboxes: vec![], emails: vec![email("a", "mb", ("A", "a@x"), "s", "2026-01-01T00:00:00Z", true, "t", None)], blobs: Default::default() };
    let fake = FakeBridge::start(0, &[keys.public_key().to_hex()], mail).await;
    let e = MailBridge::new(&fake.url, &keys).unwrap().message("gone").await.unwrap_err();
    assert!(matches!(e, MailError::Invalid { ref message } if message.contains("no longer")), "{e:?}");
}
