//! `host.requestBytes` for a plugin granted `host.publicImages`: one GET for
//! an image on any public HTTPS site, outside its declared origins.
//!
//! A link preview names its image, so the origin can't be declared ahead of
//! time. The web view would fetch a plain `<img>` with its cookies and follow
//! its redirects without asking the plugin. This instead resolves the name
//! here, refuses any address that isn't public, connects only to the addresses
//! it checked, follows no redirect (the plugin sees the `Location` and checks
//! it before asking again) and hands back a body only when it is a raster
//! image. Anything else comes back as a bare status, so the grant can't be
//! used to read pages. Names that resolve publicly but are only reachable on
//! a VPN are the plugin's to refuse, by name, on every hop.
use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

/// A response for the plugin: its status, the headers it may see and its body.
type Reply = (u16, BTreeMap<String, String>, Vec<u8>);

/// Raster images only: an SVG can carry links and is a document as well.
const TYPES: [&str; 5] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
];

/// Whether `ip` is on the public internet: not this computer, a private or
/// shared network, link-local, multicast, documentation or reserved space.
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => {
            if ip.is_unspecified() || ip.is_loopback() {
                return false;
            }
            if let Some(v4) = embedded_v4(ip) {
                return is_public_v4(v4);
            }
            let s = ip.segments();
            !(ip.is_multicast()
                // Unique local fc00::/7, link-local fe80::/10 and the retired
                // site-local fec0::/10.
                || s[0] & 0xfe00 == 0xfc00
                || s[0] & 0xffc0 == 0xfe80
                || s[0] & 0xffc0 == 0xfec0
                // IETF protocol assignments 2001::/23, which hold Teredo,
                // benchmarking and ORCHID, and documentation 2001:db8::/32.
                || (s[0] == 0x2001 && s[1] < 0x0200)
                || (s[0] == 0x2001 && s[1] == 0x0db8)
                // Local-use NAT64 64:ff9b:1::/48 and discard 100::/64.
                || (s[0] == 0x0064 && s[1] == 0xff9b && s[2] == 1)
                || (s[0] == 0x0100 && s[1..4] == [0, 0, 0])
                // Anything else under ::/8 is reserved.
                || s[0] & 0xff00 == 0)
        }
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        // Shared address space 100.64.0.0/10, used by carrier NAT and Tailscale.
        || (a == 100 && b & 0xc0 == 64)
        // IETF protocol assignments 192.0.0.0/24 and benchmarking 198.18.0.0/15.
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && b & 0xfe == 18)
        // Reserved 240.0.0.0/4.
        || a >= 240)
}

/// The IPv4 address an IPv6 address stands for: IPv4-mapped, SIIT-translated,
/// NAT64 or 6to4. The deprecated IPv4-compatible form falls in `::/8`, which
/// `is_public` refuses whole.
fn embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let from = |high: u16, low: u16| {
        Ipv4Addr::new((high >> 8) as u8, high as u8, (low >> 8) as u8, low as u8)
    };
    match ip.segments() {
        [0, 0, 0, 0, 0, 0xffff, high, low] => Some(from(high, low)),
        [0, 0, 0, 0, 0xffff, 0, high, low] => Some(from(high, low)),
        [0x0064, 0xff9b, 0, 0, 0, 0, high, low] => Some(from(high, low)),
        [0x2002, high, low, ..] => Some(from(high, low)),
        _ => None,
    }
}

/// The addresses to connect to for `url`, when its port is 443 and every
/// address its name resolves to is public. One private answer refuses all.
pub(super) async fn public_addresses(url: &reqwest::Url) -> Result<Vec<SocketAddr>, String> {
    const REFUSED: &str = "Public host is not a public address";
    if url.port_or_known_default() != Some(443) {
        return Err("Public hosts are read from port 443 only".into());
    }
    let addresses: Vec<SocketAddr> = match url.host() {
        Some(url::Host::Domain(name)) => tokio::net::lookup_host((name, 443))
            .await
            .map_err(|_| "Public host did not resolve")?
            .collect(),
        Some(url::Host::Ipv4(ip)) => vec![SocketAddr::new(ip.into(), 443)],
        Some(url::Host::Ipv6(ip)) => vec![SocketAddr::new(ip.into(), 443)],
        None => return Err(REFUSED.into()),
    };
    if addresses.is_empty() || !addresses.iter().all(|address| is_public(address.ip())) {
        return Err(REFUSED.into());
    }
    Ok(addresses)
}

/// One GET for `url`, connecting only to `addresses`, with no cookies, no
/// proxy and no redirects followed.
pub(super) async fn fetch(
    url: reqwest::Url,
    addresses: &[SocketAddr],
    max_bytes: usize,
    timeout: Duration,
) -> Result<Reply, String> {
    read_image(
        request(url, addresses, &TYPES.join(","), timeout)?,
        max_bytes,
    )
    .await
}

/// A GET for `url`, on a client of its own that can reach only `addresses`
/// for the URL's name.
pub(super) fn request(
    url: reqwest::Url,
    addresses: &[SocketAddr],
    accept: &str,
    timeout: Duration,
) -> Result<reqwest::RequestBuilder, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        // A proxy would resolve the name again, out of reach of the check.
        .no_proxy()
        .pool_max_idle_per_host(0)
        // Some image hosts, such as Wikimedia's, refuse requests without one.
        .user_agent(crate::relay::user_agent());
    if let Some(name) = url.domain() {
        builder = builder.resolve_to_addrs(name, addresses);
    }
    let client = builder
        .build()
        .map_err(|_| "Host request client is unavailable")?;
    Ok(client
        .get(url)
        .header(reqwest::header::ACCEPT, accept)
        .timeout(timeout))
}

/// A redirect's status and `Location`, a raster image's status, type and
/// bytes, or for anything else its status alone, with no body read.
async fn read_image(request: reqwest::RequestBuilder, max_bytes: usize) -> Result<Reply, String> {
    let mut response = request.send().await.map_err(|_| "Host request failed")?;
    let status = response.status().as_u16();
    let header = |name| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    let mut headers = BTreeMap::new();
    if (300..400).contains(&status) {
        if let Some(location) = header(reqwest::header::LOCATION).filter(|l| l.len() <= 2048) {
            headers.insert("location".to_owned(), location);
        }
        return Ok((status, headers, Vec::new()));
    }
    let kind = header(reqwest::header::CONTENT_TYPE)
        .and_then(|value| {
            value
                .split(';')
                .next()
                .map(|t| t.trim().to_ascii_lowercase())
        })
        .filter(|kind| TYPES.contains(&kind.as_str()));
    let Some(kind) = kind.filter(|_| (200..300).contains(&status)) else {
        return Ok((status, headers, Vec::new()));
    };
    headers.insert("content-type".to_owned(), kind);
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Host response failed")? {
        if bytes.len() + chunk.len() > max_bytes {
            return Err("Host response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((status, headers, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};

    #[test]
    fn only_public_addresses_pass() {
        for ip in [
            "93.184.216.34",
            "104.18.4.27",
            "8.8.8.8",
            "2606:4700::6812:41b",
            "2001:4860:4860::8888",
            "2001:200::1",
            "::ffff:93.184.216.34",
            "64:ff9b::5db8:d822",
            "100.63.255.255",
            "100.128.0.1",
            "172.15.255.255",
            "172.32.0.1",
            "198.17.255.255",
            "198.20.0.1",
        ] {
            assert!(is_public(ip.parse().unwrap()), "{ip} is public");
        }
        for ip in [
            "0.0.0.0",
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.100.100.100",
            "192.0.0.8",
            "192.0.2.1",
            "198.18.0.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "100::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "64:ff9b::a00:1",
            "2002:c0a8:101::1",
            "::127.0.0.1",
            "::ffff:0:a00:1",
            "64:ff9b:1::1",
            "fec0::1",
            "2001::1",
            "2001:2::1",
            "2001:10::1",
            "::ff:1",
            "100.127.255.255",
            "172.31.255.255",
            "198.19.255.255",
        ] {
            assert!(!is_public(ip.parse().unwrap()), "{ip} is not public");
        }
    }

    #[test]
    fn local_hosts_and_other_ports_are_refused_before_any_request() {
        tauri::async_runtime::block_on(async {
            for url in [
                "https://127.0.0.1/a.png",
                "https://[::1]/a.png",
                "https://10.0.0.1/a.png",
                "https://169.254.169.254/latest/meta-data",
                "https://localhost/a.png",
                "https://example.com:8443/a.png",
            ] {
                let url = reqwest::Url::parse(url).unwrap();
                assert!(public_addresses(&url).await.is_err(), "{url} is refused");
            }
            let public = reqwest::Url::parse("https://93.184.216.34/a.png").unwrap();
            assert_eq!(
                public_addresses(&public).await.unwrap(),
                ["93.184.216.34:443".parse().unwrap()]
            );
        });
    }

    /// A server that answers one request with `response`, and the request it
    /// was sent.
    fn reply(response: &'static [u8]) -> (SocketAddr, std::sync::mpsc::Receiver<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sent, received) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let n = socket.read(&mut request).unwrap();
            let _ = sent.send(String::from_utf8_lossy(&request[..n]).to_ascii_lowercase());
            let _ = socket.write_all(response);
        });
        (address, received)
    }

    /// `response` read through the client `fetch` uses, for a name nothing
    /// resolves: it can only arrive through the pinned address.
    fn read(response: &'static [u8], max: usize) -> Result<Reply, String> {
        let (address, server) = reply(response);
        let url =
            reqwest::Url::parse(&format!("http://image.invalid:{}/img", address.port())).unwrap();
        let request = request(url, &[address], &TYPES.join(","), Duration::from_secs(5))?;
        let result = tauri::async_runtime::block_on(read_image(request, max));
        let sent = server
            .recv_timeout(Duration::from_secs(5))
            .expect("the request reached the pinned address");
        assert!(sent.starts_with("get /img http/1.1"), "{sent}");
        assert!(sent.contains("host: image.invalid"), "{sent}");
        assert!(sent.contains("user-agent: buzz"), "{sent}");
        assert!(sent.contains("accept: image/png,image/jpeg"), "{sent}");
        assert!(!sent.contains("cookie:"), "{sent}");
        result
    }

    #[test]
    fn a_raster_image_comes_back_with_its_type_only() {
        let (status, headers, bytes) = read(
            b"HTTP/1.1 200 OK\r\nContent-Type: image/PNG; charset=binary\r\nSet-Cookie: a=1\r\nX-Other: 1\r\nContent-Length: 4\r\nConnection: close\r\n\r\n\x89PNG",
            16,
        )
        .unwrap();
        assert_eq!(status, 200);
        assert_eq!(
            headers,
            BTreeMap::from([("content-type".into(), "image/png".into())])
        );
        assert_eq!(bytes, b"\x89PNG");
    }

    #[test]
    fn a_redirect_comes_back_for_the_plugin_to_check() {
        let (status, headers, bytes) = read(
            b"HTTP/1.1 302 Found\r\nLocation: https://intranet.example/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            16,
        )
        .unwrap();
        assert_eq!(status, 302);
        assert_eq!(headers["location"], "https://intranet.example/x");
        assert!(bytes.is_empty());
    }

    #[test]
    fn pages_svg_and_errors_come_back_without_a_body() {
        for response in [
            &b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret"[..],
            b"HTTP/1.1 200 OK\r\nContent-Type: image/svg+xml\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret",
            b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret",
            b"HTTP/1.1 404 Not Found\r\nContent-Type: image/png\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret",
        ] {
            let (_, headers, bytes) = read(response, 16).unwrap();
            assert!(headers.is_empty() && bytes.is_empty());
        }
    }

    #[test]
    fn an_image_over_the_limit_is_refused() {
        assert!(read(
            b"HTTP/1.1 200 OK\r\nContent-Type: image/gif\r\nContent-Length: 8\r\nConnection: close\r\n\r\nGIF89a!!",
            4,
        )
        .is_err());
    }
}
