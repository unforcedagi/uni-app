//! A scratch copy of the real `uni-mail-bridge` (T-45 tests), run as a process.
//!
//! `mail_bridge_server.py` is the bridge's `server.py` as it was before
//! `docs/t45/mail-bridge-public-aliases.patch` (copied from the bridge's
//! host 2026-10-18, hosts and addresses swapped for example ones).
//! [`RealBridge::start`] copies it to a temp folder, applies the
//! patch when asked (strictly: no fuzz), and runs it with its own HOME: its
//! own config and allowlist, and a dead upstream (`https://127.0.0.1:9`), so
//! it never reads the live config or reaches Stalwart. A request that passes
//! the bridge's checks therefore answers 502 (`mail server: URLError`); one
//! that fails them answers 401 with the bridge's own reason.
#![allow(dead_code)]

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub struct RealBridge {
    /// Where it listens (loopback); requests are signed for its public URLs instead.
    pub url: String,
    child: Child,
    _home: tempfile::TempDir,
}

/// What a request that passed every check gets from a bridge with no mail server behind it.
pub const PASSED: u16 = 502;

impl RealBridge {
    /// `aliases: None` leaves `public_aliases` out of the config (as today's config is, before the patch).
    pub fn start(patched: bool, public_url: &str, aliases: Option<&[&str]>, allow: &[String]) -> RealBridge {
        let support = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support");
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("bridge");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::copy(support.join("mail_bridge_server.py"), dir.join("server.py")).unwrap();
        if patched {
            let patch = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/t45/mail-bridge-public-aliases.patch");
            let out = Command::new("patch").args(["-p1", "-F0", "--no-backup-if-mismatch", "-i"]).arg(&patch).current_dir(&dir).output().expect("run patch");
            assert!(out.status.success(), "the aliases patch must apply cleanly: {}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        }
        let conf = home.path().join(".config/uni");
        std::fs::create_dir_all(&conf).unwrap();
        std::fs::write(home.path().join("pw"), "not-a-password").unwrap();
        let mut c = serde_json::json!({
            "user": "test@example.invalid", "password_file": home.path().join("pw"),
            "jmap": "https://127.0.0.1:9", "public_url": public_url,
        });
        if let Some(a) = aliases {
            c["public_aliases"] = serde_json::json!(a);
        }
        std::fs::write(conf.join("mail-bridge.json"), c.to_string()).unwrap();
        std::fs::write(conf.join("mail-allow"), allow.iter().map(|k| format!("{k}  # test key\n")).collect::<String>()).unwrap();

        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let python = std::env::var("UNI_BRIDGE_PYTHON").unwrap_or_else(|_| "python3".into());
        let mut child = Command::new(python)
            .arg(support.join("run_mail_bridge.py"))
            .arg(dir.join("server.py"))
            .env("HOME", home.path())
            .env("UNI_MAIL_PORT", port.to_string())
            .stdout(Stdio::null())
            .spawn()
            .expect("run python3 (set UNI_BRIDGE_PYTHON to choose one)");
        let deadline = Instant::now() + Duration::from_secs(15);
        while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("the bridge exited: {status}");
            }
            assert!(Instant::now() < deadline, "the bridge did not start listening");
            std::thread::sleep(Duration::from_millis(50));
        }
        RealBridge { url: format!("http://127.0.0.1:{port}"), child, _home: home }
    }
}

impl Drop for RealBridge {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
