//! T-210: writing mail through the bridge's named operations, against the two-account double over real HTTP
//! (`support/fake_mail_bridge.rs`). The client runs an operation only when the bridge's session offers it on that
//! account, never sends JMAP that writes, and sends a reviewed draft once per opId.

#[path = "support/fake_mail_bridge.rs"]
mod fake;

use fake::{shared_mail, FakeBridge};
use nostr::Keys;
use serde_json::Value;
use uni_core::mail::{Address, DraftFields, MailBridge, MailError, SendState};

const OWN: &[&str] = &["mark_seen", "flag", "archive", "draft.save", "draft.review", "draft.discard", "send", "send.check"];

/// The owner's key on a bridge that offers writes: everything on its own account A, and on Uni's account U what the
/// owner may do there.
async fn writable(keys: &Keys) -> FakeBridge {
    let (a, u, triage) = shared_mail();
    let fake = FakeBridge::start_shared(0, &[keys.public_key().to_hex()], a, vec![u]).await;
    {
        let mut s = fake.state.lock().unwrap();
        s.triage = triage;
        s.ops.insert("A".into(), OWN.iter().map(|o| o.to_string()).collect());
        s.ops.insert("U".into(), ["mark_seen", "flag", "send_as_uni", "send.check"].iter().map(|o| o.to_string()).collect());
    }
    fake
}

fn keywords(fake: &FakeBridge, account: &str, id: &str) -> Value {
    fake.state.lock().unwrap().keywords().into_iter().find(|(a, i, _)| a == account && i == id).map(|(_, _, k)| k).unwrap_or(Value::Null)
}

fn to(email: &str) -> Vec<Address> {
    vec![Address { name: None, email: email.into() }]
}

fn ops_sent(fake: &FakeBridge) -> Vec<String> {
    fake.state.lock().unwrap().op_log.iter().map(|o| format!("{} {}", o["op"].as_str().unwrap_or(""), o["accountId"].as_str().unwrap_or(""))).collect()
}

#[tokio::test]
async fn a_bridge_that_offers_no_writes_gets_none() {
    let keys = Keys::generate();
    let (a, u, _) = shared_mail();
    let fake = FakeBridge::start_shared(0, &[keys.public_key().to_hex()], a, vec![u]).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let o = mail.overview().await.unwrap();
    assert!(o.accounts.iter().all(|a| a.operations.is_empty()), "the v2 read bridge as deployed today offers nothing");
    let draft = DraftFields { to: to("mara@example.org"), text: "x".into(), ..Default::default() };
    let tries: Vec<Result<(), MailError>> = vec![
        mail.mark_seen("A", &["a3".into()], true).await,
        mail.flag("A", &["a3".into()], true).await,
        mail.archive("A", &["a3".into()]).await,
        mail.draft_save("A", &draft, None).await.map(|_| ()),
        mail.draft_discard("A", "a6").await,
        mail.send_as_uni("U", "0123456789abcdef", &draft).await.map(|_| ()),
    ];
    for t in tries {
        assert!(matches!(&t, Err(MailError::Refused { status: 403, message }) if message.contains("doesn't offer")), "{t:?}");
    }
    let s = fake.state.lock().unwrap();
    assert!(s.op_log.is_empty(), "nothing reached /mail/op");
    assert!(s.requests.iter().all(|(p, _)| p != "/mail/op"));
}

#[tokio::test]
async fn reading_state_flags_and_archive_go_through_the_operations_offered() {
    let keys = Keys::generate();
    let fake = writable(&keys).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let o = mail.overview().await.unwrap();
    assert_eq!(o.accounts[0].operations, OWN);
    mail.mark_seen("A", &["a3".into()], true).await.unwrap();
    assert_eq!(keywords(&fake, "A", "a3")["$seen"], true);
    mail.mark_seen("A", &["a3".into()], false).await.unwrap();
    assert!(keywords(&fake, "A", "a3").get("$seen").is_none());
    mail.flag("U", &["u1".into()], true).await.unwrap();
    assert_eq!(keywords(&fake, "U", "u1")["$flagged"], true, "the owner flags Uni's mail");
    let list = mail.threads(&[uni_core::mail::Source { account_id: "U".into(), mailbox_id: Some("U-inbox".into()), exclude: vec![], position: 0 }], None, 50).await.unwrap();
    assert!(list.threads.iter().find(|t| t.email_id == "u1").unwrap().flagged);
    mail.archive("A", &["a4".into()]).await.unwrap();
    // Uni's account: no archive for the owner; the device refuses it before the bridge sees it
    let before = ops_sent(&fake).len();
    let e = mail.archive("U", &["u1".into()]).await.unwrap_err();
    assert!(matches!(e, MailError::Refused { status: 403, .. }), "{e:?}");
    assert_eq!(ops_sent(&fake).len(), before);
    assert_eq!(ops_sent(&fake), ["mark_seen A", "mark_seen A", "flag U", "archive A"]);
    // and still no JMAP write left the device
    let forwarded = fake.state.lock().unwrap().forwarded.clone();
    assert!(forwarded.iter().all(|m| uni_core::mail::READ_METHODS.contains(&m.as_str())), "{forwarded:?}");
}

#[tokio::test]
async fn a_reviewed_draft_is_sent_once_whatever_the_retries() {
    let keys = Keys::generate();
    let fake = writable(&keys).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let fields = DraftFields { to: to("mara@example.org"), subject: "Re: Planning the garden week".into(), text: "Monday.".into(), in_reply_to: Some("a3".into()), ..Default::default() };
    let r = mail.draft_save("A", &fields, None).await.unwrap();
    assert_eq!((r.account_id.as_str(), r.fingerprint.len(), r.thread_id.as_deref()), ("A", 64, Some("TA-plan")));
    let op = "op-0123456789abcdef";
    let out = mail.send("A", op, &r).await.unwrap();
    assert_eq!((out.state, out.draft_id.as_deref()), (SendState::Cleaned, Some(r.draft_id.as_str())));
    // the composer retries (a lost answer, say): same opId, same outcome, nothing new
    assert_eq!(mail.send("A", op, &r).await.unwrap().state, SendState::Cleaned);
    let again = mail.send("A", "op-fedcba9876543210", &r).await.unwrap();
    assert!(again.note.is_some(), "a second opId for the same draft gets the first send's outcome");
    assert_eq!(fake.state.lock().unwrap().submissions.len(), 1);
    let sent = mail.send_check("A", op).await.unwrap();
    assert_eq!(sent.delivery.unwrap()["mara@example.org"], "queued");
    // what the bridge was asked: the draft by id and fingerprint, never fields
    let log = fake.state.lock().unwrap().op_log.clone();
    let send = log.iter().find(|o| o["op"] == "send").unwrap();
    assert_eq!((send["draftId"].as_str(), send["fingerprint"].as_str()), (Some(r.draft_id.as_str()), Some(r.fingerprint.as_str())));
    assert!(send.get("fields").is_none());
}

#[tokio::test]
async fn a_changed_draft_or_a_reused_opid_does_not_send() {
    let keys = Keys::generate();
    let fake = writable(&keys).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let r = mail.draft_save("A", &DraftFields { to: to("mara@example.org"), text: "v1".into(), ..Default::default() }, None).await.unwrap();
    // saved over since it was reviewed: the old id and fingerprint no longer send
    let r2 = mail.draft_save("A", &DraftFields { to: to("mara@example.org"), text: "v2".into(), ..Default::default() }, Some((&r.draft_id, &r.fingerprint))).await.unwrap();
    let out = mail.send("A", "op-aaaaaaaaaaaaaaaa", &r).await.unwrap();
    assert_eq!(out.state, SendState::Refused);
    let e = mail.send("A", "op-aaaaaaaaaaaaaaaa", &r2).await.unwrap_err();
    assert!(matches!(&e, MailError::Refused { status: 409, message } if message.contains("different request")), "{e:?}");
    // saving over a draft with a stale fingerprint is refused too
    let e = mail.draft_save("A", &DraftFields { text: "v3".into(), ..Default::default() }, Some((&r2.draft_id, &r.fingerprint))).await.unwrap_err();
    assert!(matches!(e, MailError::Refused { status: 409, .. }), "{e:?}");
    assert!(fake.state.lock().unwrap().submissions.is_empty());
}

#[tokio::test]
async fn fields_that_could_forge_a_header_never_leave_the_device() {
    let keys = Keys::generate();
    let fake = writable(&keys).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let bad = DraftFields { to: to("mara@example.org"), subject: "Hi\r\nBcc: spy@example.net".into(), ..Default::default() };
    assert!(matches!(mail.draft_save("A", &bad, None).await, Err(MailError::Invalid { .. })));
    assert!(matches!(mail.send_as_uni("U", "op-0123456789abcdef", &bad).await, Err(MailError::Invalid { .. })));
    assert!(ops_sent(&fake).is_empty());
}

#[tokio::test]
async fn the_owner_sends_as_uni_by_fields_and_a_parked_send_says_so() {
    let keys = Keys::generate();
    let fake = writable(&keys).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let fields = DraftFields { to: to("ada@example.org"), subject: "Re: Question about the reading group".into(), text: "Yes, Thursday.".into(), in_reply_to: Some("u2".into()), ..Default::default() };
    let out = mail.send_as_uni("U", "op-uni-0123456789ab", &fields).await.unwrap();
    assert_eq!(out.state, SendState::Cleaned);
    fake.state.lock().unwrap().force_send = Some(("awaiting-approval".into(), "Uni's outbound rules want Aaron to approve mail to ada@example.org".into()));
    let parked = mail.send_as_uni("U", "op-uni-fedcba987654", &fields).await.unwrap();
    assert_eq!(parked.state, SendState::AwaitingApproval);
    assert!(parked.reason.unwrap().contains("approve"));
    assert_eq!(fake.state.lock().unwrap().submissions.len(), 1);
}

#[tokio::test]
async fn mail_from_the_owner_that_failed_dmarc_says_so() {
    let keys = Keys::generate();
    let fake = writable(&keys).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let t = mail.thread("U", "Tu6").await.unwrap();
    assert_eq!((t.messages[0].from[0].email.as_str(), t.messages[0].dmarc.as_deref()), ("robin@example.com", Some("fail")), "the topmost hop's result, not the sender's own header");
    let t = mail.thread("A", "TA-plan").await.unwrap();
    assert!(t.messages.iter().all(|m| m.dmarc.is_none()), "mail with no authentication header has no result");
}
