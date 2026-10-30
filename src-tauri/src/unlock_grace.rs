//! T-335: for a few minutes after an approval's device unlock, a routine approval goes through on its tap alone.
//!
//! The grace lives here in memory only: never written anywhere, gone when the app quits. It covers [`GRACE`] from the
//! last unlock and is never extended by using it. It ends early, and for good, when this device locks, sleeps or (on
//! Android) the app leaves the screen. Each of those moves a counter, the lock epoch; the grace remembers the epoch it
//! started in and is over once the epoch has moved:
//! - macOS: the system's screen-locked and screen-saver notifications;
//! - Linux: logind's Lock, LockedHint and PrepareForSleep, and the desktop's ScreenSaver ActiveChanged;
//! - Android: the activity's onPause and onStop, counted in `KeystorePlugin.kt` and read from there each time.
//!
//! Sleep is also caught by the clocks: the awake clock ([`Instant`]: CLOCK_MONOTONIC on Linux and Android,
//! CLOCK_UPTIME_RAW on macOS) stops while the machine sleeps and the wall clock doesn't, so when the two disagree by
//! more than [`SKEW`] the grace is over. A wall clock set back or jumped also ends it.
//!
//! Where nothing watches for a lock (a platform with no watcher here, or one whose watcher didn't start), there is no
//! grace: every approval asks. Only `confirm_approval` uses this; pairing a device always asks. Which cards may use it
//! is decided by `uni_core::sealed_card::needs_fresh_unlock`; what gets signed doesn't change.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use tauri::{AppHandle, Runtime};

/// How long a device unlock covers routine approvals, from the unlock.
pub const GRACE: Duration = Duration::from_secs(300);
/// The awake and wall clocks may drift this far apart before it counts as a sleep.
const SKEW: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy)]
struct Stamp {
    awake: Instant,
    wall: SystemTime,
    epoch: u64,
}

static STAMP: Mutex<Option<Stamp>> = Mutex::new(None);
/// Desktop: moved by the lock watchers. (Android keeps its own in Kotlin.)
#[cfg_attr(target_os = "android", allow(dead_code))]
static EPOCH: AtomicU64 = AtomicU64::new(0);
/// Desktop: whether a lock watcher is running. With none, there's no grace.
#[cfg_attr(target_os = "android", allow(dead_code))]
static WATCHING: AtomicBool = AtomicBool::new(false);

/// What's left of the grace stamped `s`, seen at `awake`, `wall` and lock epoch `epoch`; None once it's over.
fn left(s: &Stamp, awake: Instant, wall: SystemTime, epoch: u64) -> Option<Duration> {
    if epoch != s.epoch {
        return None;
    }
    let up = awake.checked_duration_since(s.awake)?;
    // the wall clock went back: over
    let by_wall = wall.duration_since(s.wall).ok()?;
    // asleep in between (the awake clock stopped, the wall clock didn't), or the wall clock jumped: over
    if by_wall.abs_diff(up) > SKEW {
        return None;
    }
    GRACE.checked_sub(up.max(by_wall)).filter(|d| !d.is_zero())
}

/// The device locked, slept or left the screen: the grace ends now, and any stamped before stays ended.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn locked() {
    EPOCH.fetch_add(1, Ordering::SeqCst);
    clear();
}

pub fn clear() {
    if let Ok(mut s) = STAMP.lock() {
        *s = None;
    }
}

/// The lock epoch now; None where nothing watches for a lock (then there's no grace).
async fn epoch<R: Runtime>(_app: &AppHandle<R>) -> Option<u64> {
    #[cfg(target_os = "android")]
    {
        crate::secure_store::lifecycle_epoch(_app).await.ok()
    }
    #[cfg(not(target_os = "android"))]
    {
        WATCHING.load(Ordering::SeqCst).then(|| EPOCH.load(Ordering::SeqCst))
    }
}

/// A device unlock for an approval just succeeded: routine approvals need no other for [`GRACE`].
pub async fn grant<R: Runtime>(app: &AppHandle<R>) {
    // the epoch is read after the unlock, so a lock during it (or the unlock's own screen) is already counted
    let Some(epoch) = epoch(app).await else { return clear() };
    if let Ok(mut s) = STAMP.lock() {
        *s = Some(Stamp { awake: Instant::now(), wall: SystemTime::now(), epoch });
    }
}

/// How long the grace has left; None when there is none (and then it's gone for good).
pub async fn remaining<R: Runtime>(app: &AppHandle<R>) -> Option<Duration> {
    let epoch = epoch(app).await;
    let mut s = STAMP.lock().ok()?;
    let left = s.as_ref().zip(epoch).and_then(|(st, e)| left(st, Instant::now(), SystemTime::now(), e));
    if left.is_none() {
        *s = None;
    }
    left
}

/// The gate in front of an approval's own confirm: a routine approval (`fresh` false) inside the grace skips `confirm`;
/// otherwise `confirm` runs, and once it passes a new grace starts. Returns whether it asked.
pub async fn confirm_unless_graced<R: Runtime>(
    app: &AppHandle<R>,
    fresh: bool,
    confirm: impl std::future::Future<Output = Result<(), String>>,
) -> Result<bool, String> {
    if !fresh {
        if let Some(left) = remaining(app).await {
            tracing::info!(left_s = left.as_secs(), "approval: routine, within the unlock grace; no device unlock");
            return Ok(false);
        }
    }
    confirm.await?;
    grant(app).await;
    Ok(true)
}

/// Start this platform's lock watcher (desktop; Android needs none). Call once, from setup, on the main thread.
pub fn watch() {
    #[cfg(target_os = "macos")]
    mac::watch();
    #[cfg(target_os = "linux")]
    linux::watch();
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSOperationQueue, NSString};

    /// Posted by the system when the screen locks, and when the screen saver starts (which may lock it).
    const LOCKS: [&str; 2] = ["com.apple.screenIsLocked", "com.apple.screensaver.didstart"];

    pub fn watch() {
        let center = NSDistributedNotificationCenter::defaultCenter();
        let queue = NSOperationQueue::mainQueue();
        for name in LOCKS {
            let block = RcBlock::new(|_: NonNull<NSNotification>| super::locked());
            // SAFETY: no object filter; the main queue; the block only touches atomics and a mutex, from any thread.
            let observer = unsafe {
                center.addObserverForName_object_queue_usingBlock(Some(&NSString::from_str(name)), None, Some(&queue), &block)
            };
            // watched for the life of the app
            std::mem::forget(observer);
        }
        super::WATCHING.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::time::Duration;

    use dbus::arg::{PropMap, RefArg};
    use dbus::blocking::Connection;
    use dbus::message::MatchRule;
    use dbus::Message;

    /// logind on the system bus (the lock everyone has), then the desktop's screen saver on the session bus. The grace
    /// is on once logind is watched.
    pub fn watch() {
        let _ = std::thread::Builder::new().name("unlock-grace-logind".into()).spawn(|| {
            let Ok(bus) = Connection::new_system() else { return };
            let lock = bus.add_match(MatchRule::new_signal("org.freedesktop.login1.Session", "Lock"), |(): (), _: &Connection, _: &Message| {
                super::locked();
                true
            });
            // either edge: going to sleep, or waking from it
            let sleep = bus.add_match(MatchRule::new_signal("org.freedesktop.login1.Manager", "PrepareForSleep"), |_: (bool,), _: &Connection, _: &Message| {
                super::locked();
                true
            });
            let hint = bus.add_match(
                MatchRule::new_signal("org.freedesktop.DBus.Properties", "PropertiesChanged"),
                |(iface, changed, _): (String, PropMap, Vec<String>), _: &Connection, _: &Message| {
                    if iface == "org.freedesktop.login1.Session" && changed.get("LockedHint").and_then(|v| v.as_i64()).is_some_and(|b| b != 0) {
                        super::locked();
                    }
                    true
                },
            );
            if lock.is_err() || sleep.is_err() || hint.is_err() {
                return;
            }
            super::WATCHING.store(true, std::sync::atomic::Ordering::SeqCst);
            loop {
                if bus.process(Duration::from_secs(3600)).is_err() {
                    // the watcher is gone: no more grace
                    super::WATCHING.store(false, std::sync::atomic::Ordering::SeqCst);
                    super::locked();
                    return;
                }
            }
        });
        let _ = std::thread::Builder::new().name("unlock-grace-screensaver".into()).spawn(|| {
            let Ok(bus) = Connection::new_session() else { return };
            for iface in ["org.freedesktop.ScreenSaver", "org.gnome.ScreenSaver"] {
                let _ = bus.add_match(MatchRule::new_signal(iface, "ActiveChanged"), |(on,): (bool,), _: &Connection, _: &Message| {
                    if on {
                        super::locked();
                    }
                    true
                });
            }
            while bus.process(Duration::from_secs(3600)).is_ok() {}
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: fn(u64) -> Duration = Duration::from_secs;

    fn at(s: &Stamp, awake: u64, wall: u64, epoch: u64) -> Option<Duration> {
        left(s, s.awake + S(awake), s.wall + S(wall), epoch)
    }

    #[test]
    fn five_minutes_from_the_unlock_then_it_asks_again() {
        let s = Stamp { awake: Instant::now(), wall: SystemTime::now(), epoch: 7 };
        assert_eq!(at(&s, 0, 0, 7), Some(S(300)));
        assert_eq!(at(&s, 60, 60, 7), Some(S(240)), "4 min left after one");
        assert_eq!(at(&s, 299, 299, 7), Some(S(1)));
        assert_eq!(at(&s, 300, 300, 7), None, "5:00");
        assert_eq!(at(&s, 301, 301, 7), None, "5:01");
        // a small drift between the clocks is no sleep; the later of the two counts
        assert_eq!(at(&s, 100, 102, 7), Some(S(198)));
        assert_eq!(at(&s, 299, 301, 7), None);
    }

    #[test]
    fn a_lock_sleep_or_clock_change_ends_it() {
        let s = Stamp { awake: Instant::now(), wall: SystemTime::now(), epoch: 7 };
        assert_eq!(at(&s, 10, 10, 8), None, "locked or left the screen since");
        assert_eq!(at(&s, 10, 13, 7), None, "slept 3 s: the awake clock stopped");
        assert_eq!(at(&s, 10, 70, 7), None, "slept a minute, well within the five");
        assert_eq!(left(&s, s.awake + S(10), s.wall - S(1), 7), None, "the wall clock went back");
        assert_eq!(left(&s, s.awake, s.wall, 7), Some(S(300)));
        assert_eq!(at(&s, 13, 10, 7), None, "the wall clock lagged");
    }

    /// The tests below share the process-wide grace: they take turns.
    static TURN: Mutex<()> = Mutex::new(());

    /// Move the live stamp's clocks back, as if `awake` and `wall` had passed since the unlock.
    fn age(awake: u64, wall: u64) {
        let mut s = STAMP.lock().unwrap();
        let st = s.as_mut().expect("a grace");
        st.awake = st.awake.checked_sub(S(awake)).expect("uptime");
        st.wall -= S(wall);
    }

    #[test]
    fn the_gate_routine_within_five_minutes_goes_through_powerful_always_asks() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        let app = tauri::test::mock_app();
        let app = app.handle();
        let asks = AtomicU64::new(0);
        let ask = |ok: bool| {
            let asks = &asks;
            async move {
                asks.fetch_add(1, Ordering::SeqCst);
                if ok { Ok(()) } else { Err("not approved: cancelled".to_string()) }
            }
        };
        let gate = |fresh: bool| tauri::async_runtime::block_on(confirm_unless_graced(app, fresh, ask(true))).unwrap();
        WATCHING.store(true, Ordering::SeqCst);
        clear();

        assert!(gate(false), "the first routine approval asks");
        assert!(!gate(false) && !gate(false), "routine ones right after: no prompt");
        assert!(gate(true) && gate(true), "a powerful one always asks");
        assert_eq!(asks.load(Ordering::SeqCst), 3);
        let left = tauri::async_runtime::block_on(remaining(app)).unwrap();
        assert!(left > S(295) && left <= GRACE, "{left:?}: the powerful unlock started a new five minutes");

        age(240, 240);
        assert!(!gate(false), "4:00 after the unlock, using it doesn't extend it");
        age(61, 61);
        assert!(gate(false), "5:01 asks again");

        age(30, 90);
        assert!(gate(false), "slept a minute: asks");
        locked();
        assert!(gate(false), "locked: asks");
        assert!(!gate(false));

        // a confirm that fails starts nothing; a refused routine one asks next time too
        clear();
        assert!(tauri::async_runtime::block_on(confirm_unless_graced(app, false, ask(false))).is_err());
        assert!(gate(false), "nothing was granted by the cancelled one");

        // nothing watching for a lock: no grace at all
        WATCHING.store(false, Ordering::SeqCst);
        assert!(gate(false) && gate(false));
        assert!(tauri::async_runtime::block_on(remaining(app)).is_none());
        WATCHING.store(true, Ordering::SeqCst);
        clear();
    }

    /// The real buses: a logind Lock, LockedHint and PrepareForSleep, and a ScreenSaver ActiveChanged, sent with
    /// `dbus-send`, each move the epoch. Needs a system and a session bus: `cargo test -p uni-app-tauri -- --ignored`.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore]
    fn the_linux_watcher_sees_a_lock() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        WATCHING.store(false, Ordering::SeqCst);
        watch();
        let wait = |what: &str, done: &dyn Fn() -> bool| {
            let until = Instant::now() + S(5);
            while !done() {
                assert!(Instant::now() < until, "{what}");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        wait("the watcher started", &|| WATCHING.load(Ordering::SeqCst));
        std::thread::sleep(Duration::from_millis(300)); // the session bus watcher too
        let send = |args: &[&str]| assert!(std::process::Command::new("dbus-send").args(args).status().unwrap().success());
        for (what, args) in [
            ("Lock", vec!["--system", "--type=signal", "/org/freedesktop/login1/session/t335", "org.freedesktop.login1.Session.Lock"]),
            ("PrepareForSleep", vec!["--system", "--type=signal", "/org/freedesktop/login1", "org.freedesktop.login1.Manager.PrepareForSleep", "boolean:true"]),
            ("LockedHint", vec!["--system", "--type=signal", "/org/freedesktop/login1/session/t335", "org.freedesktop.DBus.Properties.PropertiesChanged",
                "string:org.freedesktop.login1.Session", "dict:string:variant:LockedHint,boolean:true", "array:string:"]),
            ("ActiveChanged", vec!["--session", "--type=signal", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver.ActiveChanged", "boolean:true"]),
        ] {
            let before = EPOCH.load(Ordering::SeqCst);
            send(&args);
            wait(what, &|| EPOCH.load(Ordering::SeqCst) > before);
        }
        // an unlocked hint and a screen saver going off are no lock
        let before = EPOCH.load(Ordering::SeqCst);
        send(&["--system", "--type=signal", "/org/freedesktop/login1/session/t335", "org.freedesktop.DBus.Properties.PropertiesChanged",
            "string:org.freedesktop.login1.Session", "dict:string:variant:LockedHint,boolean:false", "array:string:"]);
        send(&["--session", "--type=signal", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver.ActiveChanged", "boolean:false"]);
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(EPOCH.load(Ordering::SeqCst), before);
    }

    #[test]
    fn locked_ends_a_grace_and_one_stamped_before_it() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        // the shared state: the watchers' path, without an app (desktop epoch)
        WATCHING.store(true, Ordering::SeqCst);
        let before = EPOCH.load(Ordering::SeqCst);
        *STAMP.lock().unwrap() = Some(Stamp { awake: Instant::now(), wall: SystemTime::now(), epoch: before });
        locked();
        assert!(STAMP.lock().unwrap().is_none());
        assert_eq!(EPOCH.load(Ordering::SeqCst), before + 1);
        // a stamp taken with the old epoch (a grant racing the lock) is over too
        let raced = Stamp { awake: Instant::now(), wall: SystemTime::now(), epoch: before };
        assert_eq!(left(&raced, raced.awake, raced.wall, EPOCH.load(Ordering::SeqCst)), None);
    }
}
