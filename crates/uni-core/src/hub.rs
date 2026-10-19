//! The Parachute hub's host, and the names it answers to (T-137).
//!
//! One setting (`vault.json` `hub`) names the hub; every other tailnet URL
//! derives from it (transcription is the same host on port 8445). During the
//! tailnet rename `uni-1` → `uni` both names are the same hub: a request that
//! can't connect to one (DNS or connection failure, never an HTTP error)
//! tries the other once, and the app remembers the one that answered.
//!
//! Cleanup after the rename: delete the pair from [`HUB_ALIASES`].
//!
//! Every hub URL anything is sent to passes [`checked_origin`] first: https,
//! or http only on this device (`localhost`, `127.0.0.1`). The vault client
//! and transcription share it, so private audio never goes over plain http to
//! another machine.

/// Origins that are one hub, in pairs. Either side may be the configured one.
// The shipped hub's two names; tests read them from here, never spell them out.
pub const HUB_ALIASES: &[(&str, &str)] = &[(
    "https://uni-1.taildf9ce2.ts.net", // public-ok: the shipped hub (T-190, see CLAUDE.md)
    "https://uni.taildf9ce2.ts.net",   // public-ok: its new name
)];

/// Extra pairs for a scratch run, `from=to[,from=to]` (e.g. an unresolvable
/// host whose alias is a scratch hub). Never set in a shipped install.
pub const ALIAS_ENV: &str = "UNI_HUB_ALIASES";

/// Port the transcription service listens on, on the hub's host.
pub const TRANSCRIBE_PORT: u16 = 8445;

/// The origin of a hub URL that is safe to send to: https, or http only for
/// `localhost` and `127.0.0.1`.
pub fn checked_origin(url: &str) -> crate::Result<String> {
    let u =
        url::Url::parse(url.trim()).map_err(|e| crate::Error::Invalid(format!("hub URL: {e}")))?;
    let local = matches!(u.host_str(), Some("127.0.0.1" | "localhost"));
    if u.scheme() != "https" && !(u.scheme() == "http" && local) {
        return Err(crate::Error::Invalid("hub URL must be https".into()));
    }
    Ok(u.origin().ascii_serialization())
}

fn origin_of(url: &str) -> Option<String> {
    let u = url::Url::parse(url.trim()).ok()?;
    u.host_str()?;
    Some(u.origin().ascii_serialization())
}

/// The alias table in force: the built-in pairs plus any from [`ALIAS_ENV`].
pub fn alias_table() -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = HUB_ALIASES
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
    if let Ok(extra) = std::env::var(ALIAS_ENV) {
        out.extend(parse_pairs(&extra));
    }
    out
}

fn parse_pairs(s: &str) -> Vec<(String, String)> {
    s.split(',')
        .filter_map(|p| p.split_once('='))
        .filter_map(|(a, b)| Some((origin_of(a)?, origin_of(b)?)))
        .collect()
}

/// The other name of `hub`'s origin, if it has one in `table`.
pub fn alias_in(hub: &str, table: &[(String, String)]) -> Option<String> {
    let o = origin_of(hub)?;
    table.iter().find_map(|(a, b)| {
        let (a, b) = (origin_of(a)?, origin_of(b)?);
        if o == a {
            Some(b)
        } else if o == b {
            Some(a)
        } else {
            None
        }
    })
}

/// The other name of `hub` (built-in table plus [`ALIAS_ENV`]).
pub fn alias_of(hub: &str) -> Option<String> {
    alias_in(hub, &alias_table())
}

/// Every origin that is this hub: itself first, then its alias.
pub fn hub_origins(hub: &str) -> Vec<String> {
    origin_of(hub).into_iter().chain(alias_of(hub)).collect()
}

/// The transcription endpoint on the hub's host: same scheme and host, port
/// [`TRANSCRIBE_PORT`], path `/transcribe`. `None` for a hub that fails
/// [`checked_origin`] (e.g. plain http to another machine).
pub fn transcribe_url(hub: &str) -> Option<String> {
    let mut u = url::Url::parse(&checked_origin(hub).ok()?).ok()?;
    u.host_str()?;
    u.set_port(Some(TRANSCRIBE_PORT)).ok()?;
    u.set_path("/transcribe");
    u.set_query(None);
    u.set_fragment(None);
    Some(u.to_string())
}

/// A failure to reach the host at all (DNS, refused, unroutable, TLS), as
/// opposed to an answer: only this kind tries the alias.
pub fn is_connect_failure(e: &reqwest::Error) -> bool {
    e.is_connect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The built-in pair, and a third host on the same tailnet that is not this hub.
    const OLD: &str = HUB_ALIASES[0].0;
    const NEW: &str = HUB_ALIASES[0].1;
    fn other() -> String {
        OLD.replacen("uni-1", "uni-2", 1)
    }
    fn on(origin: &str, suffix: &str) -> String {
        format!("{origin}{suffix}")
    }

    fn table() -> Vec<(String, String)> {
        HUB_ALIASES
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn transcription_follows_the_hub_host() {
        assert_eq!(
            transcribe_url(OLD).as_deref(),
            Some(on(OLD, ":8445/transcribe").as_str())
        );
        assert_eq!(
            transcribe_url(&format!("{NEW}/")).as_deref(),
            Some(on(NEW, ":8445/transcribe").as_str())
        );
        assert_eq!(
            transcribe_url("https://hub.example.org/some/path?x=1").as_deref(),
            Some("https://hub.example.org:8445/transcribe")
        );
        assert_eq!(transcribe_url("not a url"), None);
    }

    #[test]
    fn an_http_remote_hub_is_refused_for_transcription() {
        for bad in [
            OLD.replacen("https", "http", 1).as_str(),
            "http://hub.example.org:8443",
            "http://10.0.0.5",
            "ftp://hub.example.org",
        ] {
            assert!(checked_origin(bad).is_err(), "{bad}");
            assert_eq!(transcribe_url(bad), None, "{bad}");
        }
        assert_eq!(
            transcribe_url("http://127.0.0.1:1939").as_deref(),
            Some("http://127.0.0.1:8445/transcribe")
        );
        assert_eq!(
            transcribe_url("http://localhost").as_deref(),
            Some("http://localhost:8445/transcribe")
        );
        assert_eq!(checked_origin(&on(NEW, "/x")).unwrap(), NEW);
    }

    #[test]
    fn uni_1_and_uni_are_one_hub_and_uni_2_is_not() {
        let t = table();
        assert_eq!(alias_in(OLD, &t).as_deref(), Some(NEW));
        assert_eq!(alias_in(&format!("{NEW}/"), &t).as_deref(), Some(OLD));
        assert_eq!(
            alias_in(&OLD.replacen("uni-1", "UNI-1", 1), &t).as_deref(),
            Some(NEW)
        );
        assert_eq!(alias_in(&other(), &t), None);
        assert_eq!(
            alias_in(&OLD.replacen("https", "http", 1), &t),
            None,
            "another scheme is another origin"
        );
        assert_eq!(
            alias_in(&on(OLD, ":8443"), &t),
            None,
            "another port is another origin"
        );
    }

    #[test]
    fn the_ui_gets_both_names_of_the_hub() {
        assert_eq!(
            hub_origins(&format!("{OLD}/")),
            vec![OLD.to_string(), NEW.to_string()]
        );
        assert_eq!(hub_origins(NEW), vec![NEW.to_string(), OLD.to_string()]);
        assert_eq!(hub_origins(&other()), vec![other()]);
    }

    #[test]
    fn scratch_pairs_parse() {
        let p = parse_pairs("https://uni-gone.invalid=http://127.0.0.1:19390, junk ,a=b");
        assert_eq!(
            p,
            vec![(
                "https://uni-gone.invalid".to_string(),
                "http://127.0.0.1:19390".to_string()
            )]
        );
        assert_eq!(
            alias_in("https://uni-gone.invalid/", &p).as_deref(),
            Some("http://127.0.0.1:19390")
        );
    }
}
