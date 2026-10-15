//! The Parachute hub's host, and the names it answers to (T-137).
//!
//! One setting (`vault.json` `hub`) names the hub; every other tailnet URL
//! derives from it (transcription is the same host on port 8445). During the
//! tailnet rename `uni-1` → `uni` both names are the same hub: a request that
//! can't connect to one (DNS or connection failure, never an HTTP error)
//! tries the other once, and the app remembers the one that answered.
//!
//! Cleanup after the rename: delete the pair from [`HUB_ALIASES`].

/// Origins that are one hub, in pairs. Either side may be the configured one.
pub const HUB_ALIASES: &[(&str, &str)] = &[(
    "https://uni-1.taildf9ce2.ts.net",
    "https://uni.taildf9ce2.ts.net",
)];

/// Extra pairs for a scratch run, `from=to[,from=to]` (e.g. an unresolvable
/// host whose alias is a scratch hub). Never set in a shipped install.
pub const ALIAS_ENV: &str = "UNI_HUB_ALIASES";

/// Port the transcription service listens on, on the hub's host.
pub const TRANSCRIBE_PORT: u16 = 8445;

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
/// [`TRANSCRIBE_PORT`], path `/transcribe`.
pub fn transcribe_url(hub: &str) -> Option<String> {
    let mut u = url::Url::parse(hub.trim()).ok()?;
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

    const OLD: &str = "https://uni-1.taildf9ce2.ts.net";
    const NEW: &str = "https://uni.taildf9ce2.ts.net";

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
            Some("https://uni-1.taildf9ce2.ts.net:8445/transcribe")
        );
        assert_eq!(
            transcribe_url(&format!("{NEW}/")).as_deref(),
            Some("https://uni.taildf9ce2.ts.net:8445/transcribe")
        );
        assert_eq!(
            transcribe_url("https://hub.example.org/some/path?x=1").as_deref(),
            Some("https://hub.example.org:8445/transcribe")
        );
        assert_eq!(transcribe_url("not a url"), None);
    }

    #[test]
    fn uni_1_and_uni_are_one_hub_and_uni_2_is_not() {
        let t = table();
        assert_eq!(alias_in(OLD, &t).as_deref(), Some(NEW));
        assert_eq!(alias_in(&format!("{NEW}/"), &t).as_deref(), Some(OLD));
        assert_eq!(
            alias_in("https://UNI-1.taildf9ce2.ts.net", &t).as_deref(),
            Some(NEW)
        );
        assert_eq!(alias_in("https://uni-2.taildf9ce2.ts.net", &t), None);
        assert_eq!(
            alias_in("http://uni-1.taildf9ce2.ts.net", &t),
            None,
            "another scheme is another origin"
        );
        assert_eq!(
            alias_in("https://uni-1.taildf9ce2.ts.net:8443", &t),
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
        assert_eq!(
            hub_origins("https://uni-2.taildf9ce2.ts.net"),
            vec!["https://uni-2.taildf9ce2.ts.net".to_string()]
        );
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
