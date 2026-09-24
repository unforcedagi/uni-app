use nostr::{Keys, Tag};
use uni_core::Store;
use uuid::Uuid;

#[tokio::test]
async fn cannot_send_to_unknown_room_or_blank_message() {
    let store = Store::open_in_memory().unwrap();
    let keys = Keys::generate();
    let ch = Uuid::new_v4();
    assert!(uni_core::send_message(
        "ws://127.0.0.1:1",
        &keys,
        None::<&Tag>,
        &store,
        ch,
        "hello",
        None,
        &[]
    )
    .await
    .is_err());
    store
        .upsert_channel(&ch.to_string(), Some("Uni"), None, false, 1)
        .unwrap();
    assert!(uni_core::send_message(
        "ws://127.0.0.1:1",
        &keys,
        None::<&Tag>,
        &store,
        ch,
        "  ",
        None,
        &[]
    )
    .await
    .is_err());
}
