//! T-335: one remote image a person asked for, by tapping "Load image" under it.
//!
//! Note and message content never makes the webview fetch anything (the app's CSP refuses remote images, media, styles and
//! connections). A remote image shows as a link; its "Load image" tap calls this, which fetches that one URL here and hands the
//! bytes to the webview as a `blob:` URL. It sends no cookies, credentials or referrer, takes only http(s) to a host off this
//! device (never loopback, `localhost`, link-local or unspecified: by the address as written, by what a name resolves to, and
//! after a redirect), reads at most [`MAX_REMOTE_IMAGE_BYTES`], and returns only what the server says is a raster image (never
//! SVG, which can carry script). Hosts on the LAN or tailnet are allowed, as an `<img>` would be: the tap is the person's choice.

use std::time::Duration;

use crate::{Error, Result};

/// The largest remote image read.
pub const MAX_REMOTE_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: usize = 5;
const USER_AGENT: &str = "Mozilla/5.0 (compatible; Uni image loader)";

/// A URL this may fetch: http(s), a host, no user or password, and not this device.
pub fn check_url(raw: &str) -> Result<url::Url> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 4096 || raw.chars().any(|c| c.is_whitespace() || c.is_control() || c == '\\') {
        return Err(Error::Invalid("not an image address".into()));
    }
    let u = url::Url::parse(raw).map_err(|_| Error::Invalid("not an image address".into()))?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(Error::Invalid("only web images load".into()));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(Error::Invalid("an image address with a password is refused".into()));
    }
    if on_this_device(&u) {
        return Err(Error::Invalid("an image on this device is refused".into()));
    }
    Ok(u)
}

/// Loopback, `localhost`, link-local or unspecified: a service on this device, not an image on the web.
fn on_this_device(u: &url::Url) -> bool {
    match u.host() {
        None => true,
        Some(url::Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d == "localhost" || d.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(ip)) => ip_on_this_device(ip.into()),
        Some(url::Host::Ipv6(ip)) => ip_on_this_device(ip.into()),
    }
}

/// An address that reaches this device (or nowhere): loopback, link-local, unspecified, broadcast, and their IPv4-in-IPv6 forms.
fn ip_on_this_device(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast(),
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || v6.to_ipv4_mapped().is_some_and(|v4| ip_on_this_device(v4.into()))
                || v6.to_ipv4().is_some_and(|v4| v4.is_loopback() || v4.is_unspecified())
        }
    }
}

/// DNS that drops this device's addresses, so a name that resolves to loopback (or rebinds to it) is refused like the address.
struct OffDevice;

impl reqwest::dns::Resolve for OffDevice {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let found: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            let off: Vec<std::net::SocketAddr> = found.into_iter().filter(|a| !ip_on_this_device(a.ip())).collect();
            if off.is_empty() {
                return Err("the image's host is this device".into());
            }
            Ok(Box::new(off.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// An image the app shows: `image/…` (parameters ignored), but never SVG, which is a document that can carry script.
pub fn is_image_type(content_type: Option<&str>) -> bool {
    content_type
        .map(|c| c.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .is_some_and(|c| c.starts_with("image/") && c.len() > "image/".len() && !c.starts_with("image/svg"))
}

/// What the app says for an SVG it won't show (open the link instead).
pub const SVG_REFUSED: &str = "SVG images aren't shown in the app; open the link to see it";

/// `image/svg…`: an image type the app refuses, as opposed to something that isn't an image.
pub fn is_svg(content_type: Option<&str>) -> bool {
    content_type.is_some_and(|c| c.trim().to_ascii_lowercase().starts_with("image/svg"))
}

/// Fetch the image at `url` (see the module docs).
pub async fn fetch(url: &str) -> Result<Vec<u8>> {
    fetch_with(url, check_url).await
}

/// [`fetch`] with the address rule as a parameter: tests serve images from loopback.
async fn fetch_with(url: &str, check: fn(&str) -> Result<url::Url>) -> Result<Vec<u8>> {
    crate::init_crypto();
    let start = check(url)?;
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            attempt.error("too many redirects")
        } else if check(attempt.url().as_str()).is_err() {
            attempt.error("redirected off the web")
        } else {
            attempt.follow()
        }
    });
    let client = crate::media::client_builder(policy)?
        .timeout(TIMEOUT)
        // many image hosts refuse a request with no User-Agent; this one names the app, never the person or device
        .user_agent(USER_AGENT)
        .dns_resolver(OffDevice)
        // a proxy would resolve the host itself, past the rule above
        .no_proxy()
        .referer(false)
        .build()
        .map_err(|e| Error::Media(format!("http client: {e}")))?;
    let resp = client
        .get(start)
        .header("accept", "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8")
        .send()
        .await
        .map_err(|e| Error::Media(format!("couldn't reach the image: {}", short(&e))))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(Error::Media(format!("the image's server answered {status}")));
    }
    let ct = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_string);
    if is_svg(ct.as_deref()) {
        return Err(Error::Media(SVG_REFUSED.into()));
    }
    if !is_image_type(ct.as_deref()) {
        return Err(Error::Media("that address isn't an image".into()));
    }
    read_capped(resp, MAX_REMOTE_IMAGE_BYTES).await
}

/// A response body, refused past `max` bytes (by its length header, or as it streams in).
pub(crate) async fn read_capped(mut resp: reqwest::Response, max: u64) -> Result<Vec<u8>> {
    let too_large = || Error::Media(format!("image larger than {} MB", max / (1024 * 1024)));
    if resp.content_length().is_some_and(|n| n > max) {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| Error::Media(format!("download failed: {}", short(&e))))? {
        if (bytes.len() + chunk.len()) as u64 > max {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// reqwest's error kind and causes, without the URL (the caller already knows it).
fn short(e: &reqwest::Error) -> String {
    let mut out = String::from(if e.is_timeout() { "timed out" } else if e.is_connect() { "no connection" } else if e.is_redirect() { "redirect refused" } else { "request failed" });
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        out.push_str(": ");
        out.push_str(&s.to_string());
        src = s.source();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::dns::Resolve as _;
    use std::io::{Read, Write};

    #[test]
    fn only_web_addresses_off_this_device() {
        for ok in ["https://images.example.com/a.png", "http://example.org/x.jpg?w=2", "https://192.0.2.9/a.png", "https://hub.example.ts.net:8444/a.png"] {
            assert!(check_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "", "ftp://example.com/a.png", "file:///etc/passwd", "data:image/png;base64,AAAA", "javascript:alert(1)", "blob:https://x/1",
            "https://user:pw@example.com/a.png", "https://user@example.com/a.png", "https://example.com/a b.png", "https:\\\\example.com/a.png",
            "http://localhost/a.png", "http://LOCALHOST./a.png", "http://app.localhost/a.png", "http://127.0.0.1:9/a.png", "http://127.9.9.9/a.png",
            "http://0.0.0.0/a.png", "http://169.254.169.254/latest", "http://[::1]/a.png", "http://[::]/a.png", "http://[fe80::1]/a.png",
            "http://[::ffff:127.0.0.1]/a.png", "http://2130706433/a.png", "http://0x7f.1/a.png",
        ] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn image_types() {
        assert!(is_image_type(Some("image/png")));
        assert!(is_image_type(Some("IMAGE/JPEG; charset=binary")));
        for bad in [Some("image/svg+xml"), Some("IMAGE/SVG+XML; charset=utf-8"), None, Some(""), Some("image/"), Some("text/html"), Some("application/octet-stream"), Some("text/html; x=image/png")] {
            assert!(!is_image_type(bad), "{bad:?}");
        }
    }

    /// A one-request-per-connection HTTP server on loopback answering each path from `routes`.
    fn serve(routes: Vec<(&'static str, String)>) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { continue };
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("").to_string();
                log.lock().unwrap().push(req.clone());
                let reply = routes.iter().find(|(p, _)| *p == path).map(|(_, r)| r.clone()).unwrap_or_else(|| "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n".into());
                let _ = s.write_all(reply.as_bytes());
            }
        });
        (base, seen)
    }

    fn loopback_ok(raw: &str) -> Result<url::Url> {
        url::Url::parse(raw).map_err(|_| Error::Invalid("bad".into()))
    }

    #[tokio::test]
    async fn fetches_an_image_without_cookies_or_referrer_and_refuses_what_isnt_one() {
        let png = "\u{89}PNG-ish";
        let (base, seen) = serve(vec![
            ("/a.png", format!("HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: {}\r\n\r\n{png}", png.len())),
            ("/page", "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 2\r\n\r\nhi".into()),
            ("/logo.svg", "HTTP/1.1 200 OK\r\ncontent-type: image/svg+xml\r\ncontent-length: 6\r\n\r\n<svg/>".into()),
            ("/huge.png", format!("HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: {}\r\n\r\n", MAX_REMOTE_IMAGE_BYTES + 1)),
        ]);
        let got = fetch_with(&format!("{base}/a.png"), loopback_ok).await.unwrap();
        assert_eq!(got, png.as_bytes());
        let req = seen.lock().unwrap()[0].to_ascii_lowercase();
        assert!(!req.contains("cookie") && !req.contains("referer") && !req.contains("authorization"), "{req}");
        assert!(req.contains("user-agent: mozilla/5.0 (compatible; uni image loader)"), "{req}");
        assert!(fetch_with(&format!("{base}/page"), loopback_ok).await.unwrap_err().to_string().contains("isn't an image"));
        assert!(fetch_with(&format!("{base}/logo.svg"), loopback_ok).await.unwrap_err().to_string().contains("SVG images aren't shown"));
        assert!(fetch_with(&format!("{base}/huge.png"), loopback_ok).await.unwrap_err().to_string().contains("larger than"));
        assert!(fetch_with(&format!("{base}/missing.png"), loopback_ok).await.unwrap_err().to_string().contains("404"));
    }

    #[tokio::test]
    async fn a_redirect_onto_this_device_is_not_followed() {
        let (inner, inner_seen) = serve(vec![("/secret.png", "HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 1\r\n\r\nx".into())]);
        // the first hop is allowed (a test stand-in for a web host); its redirect to loopback must be refused by the real rule
        fn first_hop_only(raw: &str) -> Result<url::Url> {
            if raw.contains("/start.png") { loopback_ok(raw) } else { check_url(raw) }
        }
        let (outer, _) = serve(vec![("/start.png", format!("HTTP/1.1 302 Found\r\nlocation: {inner}/secret.png\r\ncontent-length: 0\r\n\r\n"))]);
        let err = fetch_with(&format!("{outer}/start.png"), first_hop_only).await.unwrap_err().to_string();
        assert!(err.contains("redirected off the web"), "{err}");
        assert!(inner_seen.lock().unwrap().is_empty(), "the loopback target was never asked");
    }

    #[tokio::test]
    async fn a_name_that_resolves_to_this_device_is_refused_before_any_request() {
        let (base, seen) = serve(vec![("/a.png", "HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 1\r\n\r\nx".into())]);
        // past the address rule (as a name like 127.0.0.1.nip.io would be), the resolver still drops loopback
        let named = base.replace("127.0.0.1", "localhost");
        let err = fetch_with(&format!("{named}/a.png"), loopback_ok).await.unwrap_err().to_string();
        assert!(err.contains("this device"), "{err}");
        assert!(seen.lock().unwrap().is_empty(), "the listener was never asked");
        let direct = OffDevice.resolve("localhost".parse().unwrap()).await;
        assert!(direct.is_err());
        assert!(ip_on_this_device("::ffff:127.0.0.1".parse().unwrap()) && ip_on_this_device("169.254.1.1".parse().unwrap()));
        assert!(!ip_on_this_device("192.0.2.9".parse().unwrap()) && !ip_on_this_device("10.0.0.1".parse().unwrap()));
    }

    #[tokio::test]
    async fn this_device_is_refused_before_any_request() {
        let (base, seen) = serve(vec![("/a.png", "HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 1\r\n\r\nx".into())]);
        assert!(fetch(&format!("{base}/a.png")).await.is_err());
        assert!(seen.lock().unwrap().is_empty());
    }
}
