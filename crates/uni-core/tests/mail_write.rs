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
    // a review says what the draft holds, with that content's fingerprint
    let again = mail.draft_review("A", &r.draft_id).await.unwrap();
    assert_eq!((again.fingerprint.as_str(), again.plain), (r.fingerprint.as_str(), Some(true)));
    let shown = again.fields.unwrap();
    assert_eq!((shown.to[0].email.as_str(), shown.subject.as_str(), shown.text.as_str()), ("mara@example.org", "Re: Planning the garden week", "Monday."));
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
    fake.state.lock().unwrap().force_send = Some(("awaiting-approval".into(), "Uni's outbound rules want Robin to approve mail to ada@example.org".into()));
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

/// /code-review: a write checks what the bridge offers without a session round trip each time (the session is fresh for
/// 30 s after the app last read it).
#[tokio::test]
async fn writes_reuse_a_fresh_session() {
    let keys = Keys::generate();
    let fake = writable(&keys).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    mail.overview().await.unwrap();
    mail.mark_seen("A", &["a3".into()], true).await.unwrap();
    mail.flag("A", &["a3".into()], true).await.unwrap();
    mail.archive("A", &["a4".into()]).await.unwrap();
    let sessions = fake.state.lock().unwrap().requests.iter().filter(|(p, _)| p == "/mail/session").count();
    assert_eq!(sessions, 1, "one session for the overview, none per write");
}

/// T-213: the owner's key on Uni's account, where the bridge offers the approval operations.
const ON_UNI_APPROVING: &[&str] = &["mark_seen", "flag", "send.parked", "send.approve", "send.decline"];

async fn approving(keys: &Keys) -> FakeBridge {
    let fake = writable(keys).await;
    {
        let mut s = fake.state.lock().unwrap();
        s.ops.insert("U".into(), ON_UNI_APPROVING.iter().map(|o| o.to_string()).collect());
        s.park("U", "ask@example.org", "Lunch on Thursday?", "Shall we meet at noon?", "Uni's outbound rules want Robin to approve mail to ask@example.org");
        s.park("U", "ask@example.org", "A second question", "And Friday?", "Uni's outbound rules want Robin to approve mail to ask@example.org");
    }
    fake
}

#[tokio::test]
async fn the_owner_sees_a_held_send_and_approves_exactly_it_once() {
    let keys = Keys::generate();
    let fake = approving(&keys).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let o = mail.overview().await.unwrap();
    assert_eq!(o.accounts[1].operations, ON_UNI_APPROVING);
    let held = mail.parked("U").await.unwrap();
    assert_eq!(held.len(), 2);
    let h = &held[0];
    let f = h.fields.as_ref().unwrap();
    assert_eq!((f.to[0].email.as_str(), f.subject.as_str(), f.text.as_str()), ("ask@example.org", "Lunch on Thursday?", "Shall we meet at noon?"));
    assert_eq!((h.recipients.as_slice(), h.changed, h.problem.as_deref()), (&["ask@example.org".to_string()][..], false, None));
    assert!(h.reason.as_deref().unwrap().contains("approve"));
    let fp = h.fingerprint.clone().unwrap();
    let out = mail.send_approve("U", &h.op_id, &fp).await.unwrap();
    assert_eq!(out.state, SendState::Cleaned);
    // a second tap (or a retry after a lost answer) is the same approval: its outcome, nothing sent again
    assert_eq!(mail.send_approve("U", &h.op_id, &fp).await.unwrap().state, SendState::Cleaned);
    assert_eq!(fake.state.lock().unwrap().submissions.len(), 1);
    // it has left the list; declining it now is refused
    assert_eq!(mail.parked("U").await.unwrap().iter().map(|p| p.op_id.as_str()).collect::<Vec<_>>(), [held[1].op_id.as_str()]);
    assert!(matches!(mail.send_decline("U", &h.op_id).await, Err(MailError::Refused { status: 409, .. })));
    // what was asked: the parked send by opId and the fingerprint shown, never fields
    let log = fake.state.lock().unwrap().op_log.clone();
    let asked = log.iter().find(|o| o["op"] == "send.approve").unwrap();
    assert_eq!((asked["opId"].as_str(), asked["fingerprint"].as_str(), asked.get("fields")), (Some(h.op_id.as_str()), Some(fp.as_str()), None));
}

#[tokio::test]
async fn a_held_send_that_changed_since_it_was_shown_is_not_sent() {
    let keys = Keys::generate();
    let fake = approving(&keys).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let held = mail.parked("U").await.unwrap();
    let (h, other) = (&held[0], &held[1]);
    // another fingerprint than the one parked: refused before anything runs
    let e = mail.send_approve("U", &h.op_id, other.fingerprint.as_deref().unwrap()).await.unwrap_err();
    assert!(matches!(&e, MailError::Refused { status: 409, message } if message.contains("isn't the draft")), "{e:?}");
    // the stored draft changed after it was shown: the shown fingerprint no longer sends it
    {
        let mut s = fake.state.lock().unwrap();
        let u = s.shared.iter_mut().find(|m| m.id == "U").unwrap();
        let d = u.emails.iter_mut().find(|e| e["id"] == h.draft_id.as_deref().unwrap()).unwrap();
        d["bodyValues"]["1"]["value"] = serde_json::json!("Shall we meet at noon? Bring the account number.");
    }
    let out = mail.send_approve("U", &h.op_id, h.fingerprint.as_deref().unwrap()).await.unwrap();
    assert_eq!((out.state, out.reason.as_deref()), (SendState::Refused, Some("the draft changed since it was reviewed")));
    // a fingerprint that isn't one never leaves the device
    let before = ops_sent(&fake).len();
    assert!(matches!(mail.send_approve("U", &other.op_id, "not-a-fingerprint").await, Err(MailError::Invalid { .. })));
    assert_eq!(ops_sent(&fake).len(), before);
    assert!(fake.state.lock().unwrap().submissions.is_empty());
}

#[tokio::test]
async fn declining_sends_nothing_and_a_bridge_without_the_operations_gets_none() {
    let keys = Keys::generate();
    let fake = approving(&keys).await;
    let mail = MailBridge::new(&fake.url, &keys).unwrap();
    let held = mail.parked("U").await.unwrap();
    let out = mail.send_decline("U", &held[1].op_id).await.unwrap();
    assert_eq!(out.state, SendState::Declined);
    assert_eq!(mail.send_decline("U", &held[1].op_id).await.unwrap().state, SendState::Declined, "a retry gets the outcome");
    assert!(matches!(mail.send_approve("U", &held[1].op_id, held[1].fingerprint.as_deref().unwrap()).await, Err(MailError::Refused { status: 409, .. })));
    assert!(fake.state.lock().unwrap().submissions.is_empty());
    // the same bridge with the approval operations off: nothing is asked of it
    fake.state.lock().unwrap().ops.insert("U".into(), vec!["mark_seen".into(), "flag".into()]);
    mail.session().await.unwrap(); // the app reads the session again (Refresh): the change is seen
    let before = ops_sent(&fake).len();
    for e in [mail.parked("U").await.map(|_| ()), mail.send_approve("U", &held[0].op_id, held[0].fingerprint.as_deref().unwrap()).await.map(|_| ()), mail.send_decline("U", &held[0].op_id).await.map(|_| ())] {
        assert!(matches!(&e, Err(MailError::Refused { status: 403, message }) if message.contains("doesn't offer")), "{e:?}");
    }
    assert_eq!(ops_sent(&fake).len(), before);
}
