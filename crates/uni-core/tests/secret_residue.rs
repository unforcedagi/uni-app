//! T-176: sealing a secret frees no heap block that still holds the value.
//!
//! This test binary has its own global allocator. While armed, every block handed back to the
//! system is scanned for a marker value first; a hit means some copy of the plaintext was freed
//! without being zeroed (Codex round-2 review: nostr's `ensure_id()` hashed the rumor through a
//! `serde_json::Value` and a `String`). It covers this crate's sealing path, with nostr's NIP-44
//! (which pads into one buffer and encrypts it in place). It cannot see stack copies or what the
//! webview and Tauri IPC hold before `seal_delivery` is called.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use nostr::{EventBuilder, JsonUtil, Keys, Kind, Tag, Timestamp};
use uni_core::secret::{seal_delivery, verified_request, REQUEST_FENCE};
use zeroize::Zeroizing;

const MARK_LEN: usize = 32;
static ARMED: AtomicBool = AtomicBool::new(false);
static HITS: AtomicUsize = AtomicUsize::new(0);
static SIZES: [AtomicUsize; 8] = [const { AtomicUsize::new(0) }; 8];
static mut MARK: [u8; MARK_LEN] = [0; MARK_LEN];

struct Scanning;

unsafe impl GlobalAlloc for Scanning {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if ARMED.load(Ordering::SeqCst) && layout.size() >= MARK_LEN {
            // no allocation in here: a plain window compare over the freed block
            let block = unsafe { std::slice::from_raw_parts(ptr, layout.size()) };
            let mark = unsafe { &*std::ptr::addr_of!(MARK) };
            if block.windows(MARK_LEN).any(|w| w == mark) {
                let n = HITS.fetch_add(1, Ordering::SeqCst);
                if n < 8 {
                    SIZES[n].store(layout.size(), Ordering::SeqCst);
                }
            }
        }
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: Scanning = Scanning;

#[test]
fn sealing_frees_no_unzeroed_copy_of_the_value() {
    let uni = Keys::generate();
    let one_time = Keys::generate();
    let owner = Keys::generate();
    let now = Timestamp::now().as_secs();
    let block = serde_json::json!({
        "v": 1, "rid": "0123456789abcdef0123456789abcdef", "name": "tok", "label": "A token", "purpose": "p",
        "store": "~/.config/uni/tok", "keep_days": 30, "expires": now + 600, "rpk": one_time.public_key().to_hex(),
    });
    let ev = EventBuilder::new(Kind::Custom(9), format!("asking\n\n```{REQUEST_FENCE}\n{block}\n```"))
        .tags([Tag::parse(["h", "6a0c3f1e-1111-4222-8333-944455556666"]).unwrap()])
        .sign_with_keys(&uni)
        .unwrap();
    let asked = verified_request(&ev.as_json()).unwrap();

    // A fresh random marker (32 hex chars, so JSON writes it verbatim), held only in zeroizing buffers.
    let mut value = Zeroizing::new(String::with_capacity(MARK_LEN));
    value.push_str(&Keys::generate().secret_key().to_secret_hex()[..MARK_LEN]);
    unsafe { (*std::ptr::addr_of_mut!(MARK)).copy_from_slice(value.as_bytes()) };

    ARMED.store(true, Ordering::SeqCst);
    let wrap = seal_delivery(&owner, &asked, &value, now);
    ARMED.store(false, Ordering::SeqCst);

    let wrap = wrap.unwrap();
    assert!(wrap.verify().is_ok());
    assert_eq!(HITS.load(Ordering::SeqCst), 0, "a freed heap block still held the secret value (sizes {:?})", SIZES.iter().map(|s| s.load(Ordering::SeqCst)).collect::<Vec<_>>());
}
