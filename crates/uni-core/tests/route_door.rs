//! One real call to a deployed route door, through the same client the app uses. Ignored by default: it needs the door, and a key on its list.
//! UNI_ROUTE_URL=https://… ROUTE_TEST_ALLOW=<the door's allow file> cargo test -p uni-core --test route_door -- --ignored --nocapture
//! It adds a throwaway key to the list for the length of the run and takes it off again; the message and rooms are made up, and nothing is posted.
use std::time::Instant;

use nostr::Keys;
use uni_core::route::{DoorRoom, RouteDoor};

#[tokio::test]
#[ignore]
async fn a_real_call_answers_with_known_rooms() {
    let url = std::env::var("UNI_ROUTE_URL").expect("UNI_ROUTE_URL");
    let allow = std::env::var("ROUTE_TEST_ALLOW").expect("ROUTE_TEST_ALLOW");
    let keys = Keys::generate();
    let before = std::fs::read_to_string(&allow).expect("read the list");
    std::fs::write(&allow, format!("{before}{} # throwaway test key\n", keys.public_key().to_hex())).expect("write the list");
    let door = RouteDoor::new(&url, None, &keys).expect("door");
    let room = |id: &str, name: &str, about: &str| DoorRoom { id: id.into(), name: name.into(), about: about.into() };
    let rooms = [room("ch-kiln", "Kiln Studio", "Firing days and glaze tests"), room("ch-bees", "Bee Garden", "Hives and the honey harvest"), room("ch-choir", "Choir", "Tuesday rehearsals and the winter set"), room("ch-table", "Long Table", "The Saturday supper club")];
    let mut out = Vec::new();
    for text in ["the second glaze batch crawled again, try a thinner coat?", "can we move Tuesday's rehearsal to the barn", "who's bringing soup on Saturday"] {
        // the door starts its next process after each answer
        let t = Instant::now();
        let r = door.suggest(text, &rooms).await;
        println!("{} ms  {:?}", t.elapsed().as_millis(), r);
        out.push(r);
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    }
    let sid = out[0].as_ref().ok().and_then(|v| v["id"].as_str()).map(str::to_string);
    let logged = door.outcome(&serde_json::json!({ "suggestion": sid, "model": ["ch-kiln"], "modelState": "in-time", "words": [], "sent": ["ch-kiln"], "edited": false })).await;
    std::fs::write(&allow, before).expect("restore the list");
    assert!(logged.is_ok(), "{logged:?}");
    for (i, want) in ["ch-kiln", "ch-choir", "ch-table"].iter().enumerate() {
        let v = out[i].as_ref().expect("an answer");
        assert_eq!(v["picks"][0]["id"].as_str(), Some(*want), "{v}");
    }
}
