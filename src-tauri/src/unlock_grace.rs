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
/// The awake and wall clocks may drift this far apart before it counts as a sleep. A backstop: the watchers see a
/// sleep coming.
const SKEW: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy)]
struct Stamp {
    awake: Instant,
    wall: SystemTime,
    /// [`GENERATION`] when the unlock was asked for.
    generation: u64,
    /// Android: how many times the app had left the screen, at the unlock. Desktop: 0.
    screen: u64,
}

static STAMP: Mutex<Option<Stamp>> = Mutex::new(None);
/// Moved by everything Rust sees that ends the grace: a lock or sleep the desktop watchers report, and a key change.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// What's left of the grace stamped `s`, seen at `awake`, `wall`, `generation` and `screen`; None once it's over.
fn left(s: &Stamp, awake: Instant, wall: SystemTime, generation: u64, screen: u64) -> Option<Duration> {
    if generation != s.generation || screen != s.screen {
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

/// The device locked or slept, a watcher stopped, or the key changed: the grace ends now, and an unlock asked for
/// before this starts none.
pub fn end() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut s) = STAMP.lock() {
        *s = None;
    }
}

/// Where the screen stands now: Android, how many times the app has left it; desktop, 0 while the lock watchers run.
/// None: no grace (no watcher; Android couldn't say).
async fn screen_now<R: Runtime>(_app: &AppHandle<R>) -> Option<u64> {
    #[cfg(target_os = "android")]
    {
        crate::secure_store::lifecycle(_app, false).await.ok().map(|l| l.epoch)
    }
    #[cfg(not(target_os = "android"))]
    {
        watching().then_some(0)
    }
}

/// Where the screen stands just after an unlock passed, if a grace may start from it. Android: the app is back on
/// the screen and hasn't left it since the unlock (a power press right after the fingerprint starts nothing).
async fn screen_after_unlock<R: Runtime>(_app: &AppHandle<R>) -> Option<u64> {
    #[cfg(target_os = "android")]
    {
        let l = crate::secure_store::lifecycle(_app, true).await.ok()?;
        (l.resumed && l.unlocked == Some(l.epoch)).then_some(l.epoch)
    }
    #[cfg(not(target_os = "android"))]
    {
        watching().then_some(0)
    }
}

/// An unlock asked for at `generation` just passed: routine approvals need no other for [`GRACE`], unless the grace
/// was ended while it was asked.
async fn grant<R: Runtime>(app: &AppHandle<R>, generation: u64) {
    let Some(screen) = screen_after_unlock(app).await else { return };
    let Ok(mut s) = STAMP.lock() else { return };
    // `end` moves the generation before it takes this lock: either it's seen here, or it clears what's stored
    if GENERATION.load(Ordering::SeqCst) == generation {
        *s = Some(Stamp { awake: Instant::now(), wall: SystemTime::now(), generation, screen });
    }
}

/// How long the grace has left; None when there is none (and then it's gone for good).
pub async fn remaining<R: Runtime>(app: &AppHandle<R>) -> Option<Duration> {
    let screen = screen_now(app).await;
    let mut s = STAMP.lock().ok()?;
    let st = (*s)?;
    let left = screen.and_then(|sc| left(&st, Instant::now(), SystemTime::now(), GENERATION.load(Ordering::SeqCst), sc));
    // over, unless the screen was read before a newer unlock stamped this (the count only goes up)
    if left.is_none() && screen.is_none_or(|sc| sc >= st.screen) {
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
    let generation = GENERATION.load(Ordering::SeqCst);
    if !fresh {
        if let Some(left) = remaining(app).await {
            tracing::info!(left_s = left.as_secs(), "approval: routine, within the unlock grace; no device unlock");
            return Ok(false);
        }
    }
    confirm.await?;
    grant(app, generation).await;
    Ok(true)
}

/// Desktop: the lock watchers that must all be running for a grace (see `watch`).
#[cfg_attr(target_os = "android", allow(dead_code))]
static WATCHERS: [AtomicBool; 2] = [AtomicBool::new(false), AtomicBool::new(false)];

#[cfg_attr(target_os = "android", allow(dead_code))]
fn watching() -> bool {
    #[cfg(target_os = "macos")]
    return WATCHERS[0].load(Ordering::SeqCst);
    #[cfg(target_os = "linux")]
    return WATCHERS.iter().all(|w| w.load(Ordering::SeqCst));
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    false
}

/// A watcher started (`on`) or stopped; one stopping ends the grace.
#[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
fn watcher(i: usize, on: bool) {
    WATCHERS[i].store(on, Ordering::SeqCst);
    if !on {
        end();
    }
}

/// Start this platform's lock watchers (desktop; Android needs none). Call once, from setup, on the main thread.
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
    use objc2_app_kit::{NSWorkspace, NSWorkspaceScreensDidSleepNotification, NSWorkspaceSessionDidResignActiveNotification,
        NSWorkspaceWillSleepNotification};
    use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSNotificationCenter, NSNotificationName,
        NSOperationQueue, NSString};

    /// Posted to every app when the screen locks, and when the screen saver starts (which may lock it).
    const LOCKS: [&str; 2] = ["com.apple.screenIsLocked", "com.apple.screensaver.didstart"];

    fn observe(center: &NSNotificationCenter, name: &NSNotificationName, queue: &NSOperationQueue) {
        let block = RcBlock::new(|_: NonNull<NSNotification>| super::end());
        // SAFETY: no object filter; the main queue; the block only touches atomics and a mutex, from any thread.
        let observer = unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), None, Some(queue), &block) };
        // watched for the life of the app
        std::mem::forget(observer);
    }

    pub fn watch() {
        let queue = NSOperationQueue::mainQueue();
        let distributed = NSDistributedNotificationCenter::defaultCenter();
        for name in LOCKS {
            observe(&distributed, &NSString::from_str(name), &queue);
        }
        // the machine going to sleep, its screens sleeping, and a switch to another user
        let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
        // SAFETY: AppKit's notification name constants, read once.
        for name in unsafe { [NSWorkspaceWillSleepNotification, NSWorkspaceScreensDidSleepNotification, NSWorkspaceSessionDidResignActiveNotification] } {
            observe(&workspace, name, &queue);
        }
        super::watcher(0, true);
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::time::Duration;

    use dbus::arg::{PropMap, RefArg};
    use dbus::blocking::Connection;
    use dbus::message::MatchRule;
    use dbus::Message;

    const LOGIND: &str = "org.freedesktop.login1";
    /// The screen saver services a desktop's locker reports through (bus name = interface).
    const SCREENSAVERS: [&str; 2] = ["org.freedesktop.ScreenSaver", "org.gnome.ScreenSaver"];

    /// Two watchers, both needed for a grace: logind on the system bus (Lock, LockedHint, PrepareForSleep) and the
    /// desktop's screen saver on the session bus (ActiveChanged). Each service must be running, and leaving its bus
    /// stops its watcher, which ends the grace. So a desktop with no screen saver service (a compositor whose locker
    /// runs on its own) has no grace: its lock could go unseen. A locker that tells neither still isn't seen.
    pub fn watch() {
        let _ = std::thread::Builder::new().name("unlock-grace-logind".into()).spawn(|| {
            let Ok(bus) = Connection::new_system() else { return super::watcher(0, false) };
            let lock = bus.add_match(MatchRule::new_signal("org.freedesktop.login1.Session", "Lock"), |(): (), _: &Connection, _: &Message| {
                super::end();
                true
            });
            // either edge: going to sleep, or waking from it
            let sleep = bus.add_match(MatchRule::new_signal("org.freedesktop.login1.Manager", "PrepareForSleep"), |_: (bool,), _: &Connection, _: &Message| {
                super::end();
                true
            });
            let hint = bus.add_match(
                MatchRule::new_signal("org.freedesktop.DBus.Properties", "PropertiesChanged"),
                |(iface, changed, _): (String, PropMap, Vec<String>), _: &Connection, _: &Message| {
                    if iface == "org.freedesktop.login1.Session" && changed.get("LockedHint").and_then(|v| v.as_i64()).is_some_and(|b| b != 0) {
                        super::end();
                    }
                    true
                },
            );
            // logind leaving the bus (or coming back as another process): nothing watches until it is seen again
            let gone = bus.add_match(
                MatchRule::new_signal("org.freedesktop.DBus", "NameOwnerChanged"),
                |(name, _, new): (String, String, String), _: &Connection, _: &Message| {
                    if name == LOGIND {
                        super::watcher(0, false);
                        super::watcher(0, !new.is_empty());
                    }
                    true
                },
            );
            let running = bus
                .with_proxy("org.freedesktop.DBus", "/org/freedesktop/DBus", Duration::from_secs(5))
                .method_call::<(bool,), _, _, _>("org.freedesktop.DBus", "NameHasOwner", (LOGIND,))
                .is_ok_and(|(on,)| on);
            if lock.is_err() || sleep.is_err() || hint.is_err() || gone.is_err() || !running {
                return super::watcher(0, false);
            }
            super::watcher(0, true);
            while bus.process(Duration::from_secs(3600)).is_ok() {}
            super::watcher(0, false);
        });
        let _ = std::thread::Builder::new().name("unlock-grace-screensaver".into()).spawn(|| {
            let Ok(bus) = Connection::new_session() else { return super::watcher(1, false) };
            let owned = |name: &str| {
                bus.with_proxy("org.freedesktop.DBus", "/org/freedesktop/DBus", Duration::from_secs(5))
                    .method_call::<(bool,), _, _, _>("org.freedesktop.DBus", "NameHasOwner", (name,))
                    .is_ok_and(|(on,)| on)
            };
            let gone = bus.add_match(
                MatchRule::new_signal("org.freedesktop.DBus", "NameOwnerChanged"),
                |(name, _, new): (String, String, String), _: &Connection, _: &Message| {
                    if SCREENSAVERS.contains(&name.as_str()) {
                        super::watcher(1, false);
                        super::watcher(1, !new.is_empty());
                    }
                    true
                },
            );
            if gone.is_err() || !SCREENSAVERS.iter().any(|n| owned(n)) {
                return super::watcher(1, false);
            }
            for iface in SCREENSAVERS {
                let added = bus.add_match(MatchRule::new_signal(iface, "ActiveChanged"), |(on,): (bool,), _: &Connection, _: &Message| {
                    if on {
                        super::end();
                    }
                    true
                });
                if added.is_err() {
                    return super::watcher(1, false);
                }
            }
            super::watcher(1, true);
            while bus.process(Duration::from_secs(3600)).is_ok() {}
            super::watcher(1, false);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: fn(u64) -> Duration = Duration::from_secs;

    fn at(s: &Stamp, awake: u64, wall: u64, generation: u64) -> Option<Duration> {
        left(s, s.awake + S(awake), s.wall + S(wall), generation, s.screen)
    }

    fn stamp(generation: u64) -> Stamp {
        Stamp { awake: Instant::now(), wall: SystemTime::now(), generation, screen: 3 }
    }

    #[test]
    fn five_minutes_from_the_unlock_then_it_asks_again() {
        let s = stamp(7);
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
    fn a_lock_sleep_background_or_clock_change_ends_it() {
        let s = stamp(7);
        assert_eq!(at(&s, 10, 10, 8), None, "locked, slept (a watcher saw it) or the key changed since");
        assert_eq!(left(&s, s.awake, s.wall, 7, 4), None, "Android: the app left the screen since");
        assert_eq!(at(&s, 10, 13, 7), None, "slept 3 s: the awake clock stopped");
        assert_eq!(at(&s, 10, 70, 7), None, "slept a minute, well within the five");
        assert_eq!(left(&s, s.awake + S(10), s.wall - S(1), 7, 3), None, "the wall clock went back");
        assert_eq!(at(&s, 13, 10, 7), None, "the wall clock lagged");
        assert_eq!(left(&s, s.awake, s.wall, 7, 3), Some(S(300)));
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

    fn all_watching(on: bool) {
        for i in 0..WATCHERS.len() {
            watcher(i, on);
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn the_gate_routine_within_five_minutes_goes_through_powerful_always_asks() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        // `age` moves the awake clock back past five minutes; a host up for less can't
        if Instant::now().checked_sub(S(600)).is_none() {
            return eprintln!("skipped: up for under 10 minutes");
        }
        let app = tauri::test::mock_app();
        let app = app.handle();
        let asks = AtomicU64::new(0);
        // the device's confirm: counts itself, passes or not, and may run `meanwhile` while it is up
        let ask = |ok: bool, meanwhile: fn()| {
            let asks = &asks;
            async move {
                asks.fetch_add(1, Ordering::SeqCst);
                meanwhile();
                if ok { Ok(()) } else { Err("not approved: cancelled".to_string()) }
            }
        };
        let gate_with = |fresh: bool, meanwhile: fn()| tauri::async_runtime::block_on(confirm_unless_graced(app, fresh, ask(true, meanwhile))).unwrap();
        let gate = |fresh: bool| gate_with(fresh, || {});
        all_watching(true);
        end();

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
        end();
        assert!(gate(false), "locked: asks");
        assert!(!gate(false));

        // locked, or the key forgotten or replaced, while the unlock was up: that unlock starts nothing
        end();
        assert!(gate_with(false, end));
        assert!(gate(false), "the lock during the unlock won");
        end();
        assert!(gate_with(true, end));
        assert!(gate(false));

        // a confirm that fails starts nothing
        end();
        assert!(tauri::async_runtime::block_on(confirm_unless_graced(app, false, ask(false, || {}))).is_err());
        assert!(gate(false), "nothing was granted by the cancelled one");

        // a watcher stopping ends it; with one not running there's no grace at all
        assert!(!gate(false));
        watcher(0, false);
        assert!(tauri::async_runtime::block_on(remaining(app)).is_none());
        assert!(gate(false) && gate(false));
        all_watching(true);
        end();
    }

    /// The real buses: a logind Lock, LockedHint and PrepareForSleep, and a ScreenSaver ActiveChanged, sent with
    /// `dbus-send`, each end the grace. Needs a system bus with logind, and a session bus:
    /// `cargo test -p uni-app-tauri -- --ignored`.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore]
    fn the_linux_watchers_see_a_lock() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        all_watching(false);
        // a screen saver service on the session bus, as GNOME and KDE have (this test's own process holds the name)
        let saver = dbus::blocking::Connection::new_session().unwrap();
        let name = "org.freedesktop.ScreenSaver";
        if saver.request_name(name, false, false, true).unwrap() != dbus::blocking::stdintf::org_freedesktop_dbus::RequestNameReply::PrimaryOwner {
            return eprintln!("skipped: {name} is already owned here");
        }
        watch();
        let wait = |what: &str, done: &dyn Fn() -> bool| {
            let until = Instant::now() + S(5);
            while !done() {
                assert!(Instant::now() < until, "{what}");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        wait("both watchers started", &watching);
        let send = |args: &[&str]| assert!(std::process::Command::new("dbus-send").args(args).status().unwrap().success());
        for (what, args) in [
            ("Lock", vec!["--system", "--type=signal", "/org/freedesktop/login1/session/t335", "org.freedesktop.login1.Session.Lock"]),
            ("PrepareForSleep", vec!["--system", "--type=signal", "/org/freedesktop/login1", "org.freedesktop.login1.Manager.PrepareForSleep", "boolean:true"]),
            ("LockedHint", vec!["--system", "--type=signal", "/org/freedesktop/login1/session/t335", "org.freedesktop.DBus.Properties.PropertiesChanged",
                "string:org.freedesktop.login1.Session", "dict:string:variant:LockedHint,boolean:true", "array:string:"]),
            ("ActiveChanged", vec!["--session", "--type=signal", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver.ActiveChanged", "boolean:true"]),
        ] {
            let before = GENERATION.load(Ordering::SeqCst);
            send(&args);
            wait(what, &|| GENERATION.load(Ordering::SeqCst) > before);
        }
        // an unlocked hint and a screen saver going off are no lock
        let before = GENERATION.load(Ordering::SeqCst);
        send(&["--system", "--type=signal", "/org/freedesktop/login1/session/t335", "org.freedesktop.DBus.Properties.PropertiesChanged",
            "string:org.freedesktop.login1.Session", "dict:string:variant:LockedHint,boolean:false", "array:string:"]);
        send(&["--session", "--type=signal", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver.ActiveChanged", "boolean:false"]);
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(GENERATION.load(Ordering::SeqCst), before);
        assert!(watching());
        // the screen saver service leaving the bus: no grace, and what there was ends
        saver.release_name(name).unwrap();
        wait("the screen saver gone", &|| !watching() && GENERATION.load(Ordering::SeqCst) > before);
    }
}
