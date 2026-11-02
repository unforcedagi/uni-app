//! T-305 interface platform spike: the interfaces a person installed, which one is showing, and what each may use.
//!
//! Uni is the shell's own interface and may use every command. Any other interface is an agent's bundle: signed with
//! that agent's key, which the person pinned when installing it (`interfaces.json` holds the key, the channel and the
//! capabilities the person granted), delivered over the air like Uni's own bundles (src/ota.rs, one records directory
//! per interface), and gated here: a command outside its grants is refused before it runs.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Uni's own interface id. Never an installed interface's.
pub const UNI: &str = "uni";

/// An interface the person installed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Installed {
    pub id: String,
    pub name: String,
    /// URL of its channel's `manifest.json`.
    pub channel: String,
    /// The agent's bundle-signing public key, as the person pinned it (minisign, base64 of the `.pub` file).
    pub pubkey: String,
    /// Capabilities the person granted (see [`capability`]).
    #[serde(default)]
    pub grants: Vec<String>,
}

/// An id is a short lowercase name: it becomes a directory name, so nothing else gets in.
pub fn valid_id(id: &str) -> bool {
    (1..=32).contains(&id.len()) && id != UNI && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The installed interfaces (`interfaces.json`). Unreadable or invalid entries are left out.
pub fn installed(root: &Path) -> Vec<Installed> {
    let Ok(bytes) = std::fs::read(root.join("interfaces.json")) else { return Vec::new() };
    serde_json::from_slice::<Vec<Installed>>(&bytes).unwrap_or_default().into_iter().filter(|i| valid_id(&i.id)).collect()
}

pub fn find(root: &Path, id: &str) -> Option<Installed> {
    installed(root).into_iter().find(|i| i.id == id)
}

/// An installed interface's records directory (its bundles, trial and floors), apart from Uni's.
pub fn dir(root: &Path, id: &str) -> PathBuf {
    root.join("iface").join(id)
}

/// The interface the person chose last; Uni when none is chosen or the choice isn't installed.
pub fn active(root: &Path) -> String {
    let id = std::fs::read_to_string(root.join("active")).unwrap_or_default().trim().to_string();
    if find(root, &id).is_some() { id } else { UNI.to_string() }
}

pub fn set_active(root: &Path, id: &str) {
    let tmp = root.join("active.tmp");
    if std::fs::write(&tmp, id).is_ok() {
        let _ = std::fs::rename(tmp, root.join("active"));
    }
}

/// Commands every interface may call: its own handshake, updates and switching.
const SHELL: &[&str] = &["ota_status", "ota_ready", "ota_reject", "ota_check", "iface_list", "iface_use", "app_version", "webview_runtime", "log_line"];

/// The capability a command belongs to. `None`: Uni only (identity keys, pairing, secrets, answering sealed
/// approvals, mail, calendar, journal, posting, anything new until it is given a capability).
pub fn capability(cmd: &str) -> Option<&'static str> {
    Some(match cmd {
        c if SHELL.contains(&c) => "shell",
        // The real-webview harness's own commands (src/t76.rs): debug Linux builds only, inert without UNI_T76_DIR.
        #[cfg(all(debug_assertions, target_os = "linux"))]
        c if c.starts_with("t76_") => "shell",
        "identity_status" | "get_identity" | "get_npub" => "identity.read",
        "get_rooms" | "get_messages" | "get_members" | "refresh" | "mark_read" | "load_older" | "search" | "live_start" | "live_stop" | "live_watch" | "relay_origin" => "rooms.read",
        "post_message" | "send_typing" => "rooms.send",
        "edit_message" | "delete_message" => "rooms.edit",
        "vault_note" | "vault_search" | "vault_list" | "vault_paths" | "vault_query" | "vault_query_meta" | "vault_subtree_nodes" | "vault_subtree_tasks" => "vault.read",
        "vault_transition" | "vault_patch_meta" | "vault_decide" | "vault_pick_decision" | "vault_note_decision" | "vault_create" | "vault_save" => "vault.write",
        "media_bytes" | "media_stream" | "media_pin" | "media_release" | "media_save" | "media_open" => "media.read",
        "media_upload" | "prepare_voice_message" | "voice_transcribe" => "media.send",
        "approval_messages" | "sealed_status" | "sealed_card" | "sealed_waiting" => "approvals.read",
        "usage_set_preference" => "usage",
        _ => return None,
    })
}

/// May interface `id`, with `grants` (`None`: Uni, everything), call `cmd`?
pub fn permit(id: &str, grants: Option<&[String]>, cmd: &str) -> Result<(), String> {
    let Some(grants) = grants else { return Ok(()) };
    match capability(cmd) {
        Some("shell") => Ok(()),
        Some(cap) if grants.iter().any(|g| g == cap) => Ok(()),
        Some(cap) => Err(format!("not granted: {cap} (interface {id})")),
        None => Err(format!("not granted: {cmd} is Uni's own (interface {id})")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_interface_may_call_only_what_the_person_granted() {
        let grants = vec!["rooms.read".to_string(), "rooms.send".to_string()];
        let g = Some(grants.as_slice());
        for ok in ["get_rooms", "get_messages", "post_message", "live_start", "ota_ready", "ota_check", "iface_use"] {
            assert_eq!(permit("garden", g, ok), Ok(()), "{ok}");
        }
        assert_eq!(permit("garden", g, "vault_note").unwrap_err(), "not granted: vault.read (interface garden)");
        assert!(permit("garden", g, "edit_message").unwrap_err().contains("rooms.edit"));
        // The shell's own powers are never granted to an agent's interface, whatever its grants say.
        let all: Vec<String> = ["sealed_answer", "pairing_confirm", "send_secret", "identity_forget", "mail_send", "journal_save_text"].map(String::from).to_vec();
        for cmd in ["sealed_answer", "pairing_confirm", "send_secret", "identity_forget", "mail_send", "journal_save_text", "a_command_added_later"] {
            assert!(permit("garden", Some(&all), cmd).unwrap_err().contains("Uni's own"), "{cmd}");
        }
        // Uni may call anything.
        assert_eq!(permit(UNI, None, "sealed_answer"), Ok(()));
    }

    #[test]
    fn interface_ids_are_plain_names_and_the_choice_falls_back_to_uni() {
        for bad in ["", "uni", "../uni", "a/b", "Garden", "x".repeat(33).as_str(), "garden."] {
            assert!(!valid_id(bad), "{bad:?}");
        }
        assert!(valid_id("garden") && valid_id("tide-pool-2"));
        let root = tempfile::tempdir().unwrap();
        let g = Installed { id: "garden".into(), name: "Garden".into(), channel: "https://example.com/m.json".into(), pubkey: "k".into(), grants: vec![] };
        let evil = Installed { id: "../x".into(), ..g.clone() };
        std::fs::write(root.path().join("interfaces.json"), serde_json::to_vec(&vec![g.clone(), evil]).unwrap()).unwrap();
        assert_eq!(installed(root.path()), vec![g]);
        assert_eq!(active(root.path()), UNI);
        set_active(root.path(), "garden");
        assert_eq!(active(root.path()), "garden");
        set_active(root.path(), "removed-later");
        assert_eq!(active(root.path()), UNI);
    }
}
