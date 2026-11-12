//! `host.readPage` for a plugin granted `host.publicPages`: one GET for a web
//! page on any public HTTPS site, answered with its preview fields only.
//!
//! A link preview needs the title, description and image a page names in its
//! head, from a site nobody declared. This pins public addresses as
//! `public_image` does, follows no redirect (the plugin checks each `Location`
//! before asking again), reads at most the page's head and hands back only the
//! fields below, never the HTML, so the grant can't be used to read pages.
use super::public_image;
use serde::Serialize;
use std::net::SocketAddr;
use std::time::Duration;

const ACCEPT: &str = "text/html,application/xhtml+xml";
/// Pages put their head first; a head this long is not one worth reading on.
const MAX_HEAD_BYTES: usize = 512 * 1024;
const MAX_URL: usize = 2048;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PagePreview {
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    site_name: Option<String>,
    /// An absolute HTTPS URL, for the plugin to read with `host.publicImages`.
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_alt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
}

/// A redirect's status and `Location`, a page's status and preview, or for
/// anything else its status alone.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageReply {
    status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<PagePreview>,
}

pub(super) async fn read(url: reqwest::Url, timeout: Duration) -> Result<PageReply, String> {
    let addresses = public_image::public_addresses(&url).await?;
    read_from(url, &addresses, timeout).await
}

async fn read_from(
    url: reqwest::Url,
    addresses: &[SocketAddr],
    timeout: Duration,
) -> Result<PageReply, String> {
    let base = url.clone();
    let request = public_image::request(url, addresses, ACCEPT, timeout)?;
    let mut response = request.send().await.map_err(|_| "Host request failed")?;
    let status = response.status().as_u16();
    let header = |name| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    let mut reply = PageReply {
        status,
        location: None,
        preview: None,
    };
    if (300..400).contains(&status) {
        reply.location = header(reqwest::header::LOCATION).filter(|l| l.len() <= MAX_URL);
        return Ok(reply);
    }
    let html = header(reqwest::header::CONTENT_TYPE)
        .and_then(|value| {
            value
                .split(';')
                .next()
                .map(|t| t.trim().to_ascii_lowercase())
        })
        .is_some_and(|kind| kind == "text/html" || kind == "application/xhtml+xml");
    if !html || !(200..300).contains(&status) {
        return Ok(reply);
    }
    let mut bytes = Vec::new();
    let mut boundary_seen = false;
    while let Some(chunk) = response.chunk().await.map_err(|_| "Host response failed")? {
        let from = bytes.len().saturating_sub(5);
        let room = MAX_HEAD_BYTES - bytes.len();
        bytes.extend_from_slice(&chunk[..chunk.len().min(room)]);
        boundary_seen = boundary_seen || may_end_head(&bytes[from..]);
        if bytes.len() >= MAX_HEAD_BYTES
            || (boundary_seen && scan(&String::from_utf8_lossy(&bytes)).ended)
        {
            break;
        }
    }
    reply.preview = Some(preview(&String::from_utf8_lossy(&bytes), &base));
    Ok(reply)
}

/// A cheap check for `</head` or `<body` bytes; `scan` decides whether they
/// end the head or sit inside a script, comment or attribute.
fn may_end_head(bytes: &[u8]) -> bool {
    bytes
        .windows(5)
        .any(|w| w.eq_ignore_ascii_case(b"</hea") || w.eq_ignore_ascii_case(b"<body"))
}

/// The preview fields `html`'s head names, with URLs resolved against `base`.
pub(crate) fn preview(html: &str, base: &reqwest::Url) -> PagePreview {
    let Scan {
        meta, title, icon, ..
    } = scan(html);
    let value = |field: Ranked| field.map(|(_, value)| value);
    let mut images = meta.images;
    images.sort_by_key(|(rank, _)| *rank);
    PagePreview {
        title: text(value(meta.title).or(title), 300),
        description: text(value(meta.description), 600),
        site_name: text(value(meta.site_name), 100),
        image: images.iter().find_map(|(_, url)| https(url, base)),
        image_alt: text(value(meta.image_alt), 300),
        icon: icon.and_then(|url| https(&url, base)),
    }
}

struct Scan {
    meta: Meta,
    title: Option<String>,
    icon: Option<String>,
    ended: bool,
}

fn scan(html: &str) -> Scan {
    let mut meta = Meta::default();
    let mut title = None;
    let mut icon = None;
    let mut ended = false;
    let lower = html.to_ascii_lowercase();
    let mut at = 0;
    while let Some(offset) = lower[at..].find('<') {
        let start = at + offset;
        let rest = &lower[start..];
        if rest.starts_with("<!--") {
            at = rest.find("-->").map_or(lower.len(), |end| start + end + 3);
            continue;
        }
        let Some(end) = tag_end(&lower, start) else {
            break;
        };
        let name: String = rest[1..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '/')
            .collect();
        at = end + 1;
        match name.as_str() {
            "/head" | "body" => {
                ended = true;
                break;
            }
            "meta" => {
                let attributes = attributes(&html[start..end]);
                let key = attribute(&attributes, "property")
                    .or_else(|| attribute(&attributes, "name"))
                    .map(str::to_ascii_lowercase);
                if let (Some(key), Some(content)) = (key, attribute(&attributes, "content")) {
                    meta.set(&key, content);
                }
            }
            "link" => {
                let attributes = attributes(&html[start..end]);
                let rel = attribute(&attributes, "rel").map(str::to_ascii_lowercase);
                if icon.is_none()
                    && rel.is_some_and(|rel| rel.split_ascii_whitespace().any(|r| r == "icon"))
                {
                    icon = attribute(&attributes, "href").map(str::to_owned);
                }
            }
            "title" if title.is_none() => {
                let close = lower[at..].find("</title").map_or(lower.len(), |i| at + i);
                title = Some(html[at..close].to_owned());
                at = close;
            }
            "script" | "style" | "noscript" | "template" => {
                let close = format!("</{name}");
                at = lower[at..].find(&close).map_or(lower.len(), |i| at + i);
            }
            _ => {}
        }
    }
    Scan {
        meta,
        title,
        icon,
        ended,
    }
}

type Ranked = Option<(u8, String)>;

#[derive(Default)]
struct Meta {
    title: Ranked,
    description: Ranked,
    site_name: Ranked,
    images: Vec<(u8, String)>,
    image_alt: Ranked,
}

/// Image candidates kept per page; the first, by rank, that is HTTPS wins.
const MAX_IMAGES: usize = 8;

impl Meta {
    /// Open Graph wins over Twitter cards, which win over plain `description`.
    fn set(&mut self, key: &str, content: &str) {
        let (field, rank) = match key {
            "og:title" => (&mut self.title, 0),
            "twitter:title" => (&mut self.title, 1),
            "og:description" => (&mut self.description, 0),
            "twitter:description" => (&mut self.description, 1),
            "description" => (&mut self.description, 2),
            "og:site_name" => (&mut self.site_name, 0),
            "og:image" | "og:image:url" | "og:image:secure_url" => return self.image(0, content),
            "twitter:image" | "twitter:image:src" => return self.image(1, content),
            "og:image:alt" => (&mut self.image_alt, 0),
            "twitter:image:alt" => (&mut self.image_alt, 1),
            _ => return,
        };
        if !content.trim().is_empty() && field.as_ref().is_none_or(|(held, _)| rank < *held) {
            *field = Some((rank, content.to_owned()));
        }
    }

    fn image(&mut self, rank: u8, content: &str) {
        if !content.trim().is_empty() && self.images.len() < MAX_IMAGES {
            self.images.push((rank, content.to_owned()));
        }
    }
}

/// The `>` closing the tag at `start`, outside quoted attribute values.
fn tag_end(html: &str, start: usize) -> Option<usize> {
    let mut quote = None;
    for (i, c) in html[start..].char_indices() {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), c) if c == q => quote = None,
            (None, '>') => return Some(start + i),
            _ => {}
        }
    }
    None
}

/// A tag's attributes, names lowercased, values as written.
fn attributes(tag: &str) -> Vec<(String, &str)> {
    let mut out = Vec::new();
    let body = tag.trim_start_matches('<');
    let body = body.trim_start_matches(|c: char| c.is_ascii_alphanumeric());
    let mut rest = body;
    loop {
        rest = rest.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == '/');
        if rest.is_empty() {
            break;
        }
        let name_end = rest
            .find(|c: char| c.is_ascii_whitespace() || c == '=' || c == '/')
            .unwrap_or(rest.len());
        let name = rest[..name_end].to_ascii_lowercase();
        rest = rest[name_end..].trim_start();
        let value = if let Some(after) = rest.strip_prefix('=') {
            let after = after.trim_start();
            match after.chars().next() {
                Some(q @ ('"' | '\'')) => {
                    let close = after[1..].find(q).map_or(after.len(), |i| i + 1);
                    let value = &after[1..close];
                    rest = after.get(close + 1..).unwrap_or("");
                    value
                }
                _ => {
                    let end = after
                        .find(|c: char| c.is_ascii_whitespace())
                        .unwrap_or(after.len());
                    rest = &after[end..];
                    &after[..end]
                }
            }
        } else {
            ""
        };
        if name.is_empty() {
            break;
        }
        out.push((name, value));
    }
    out
}

fn attribute<'a>(attributes: &[(String, &'a str)], name: &str) -> Option<&'a str> {
    attributes
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| *value)
}

/// `raw` with entities decoded, whitespace collapsed, and at most `max`
/// characters, or nothing when empty.
fn text(raw: Option<String>, max: usize) -> Option<String> {
    let decoded = decode(&raw?);
    let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = collapsed.chars();
    let mut out: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        out.pop();
        out.push('…');
    }
    (!out.is_empty()).then_some(out)
}

fn decode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest[1..].find(';').map(|e| e + 1).filter(|e| *e <= 10);
        let decoded = end.and_then(|end| {
            let name = &rest[1..end];
            let c = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ => name
                    .strip_prefix("#x")
                    .or_else(|| name.strip_prefix("#X"))
                    .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                    .or_else(|| name.strip_prefix('#').and_then(|n| n.parse().ok()))
                    .and_then(char::from_u32),
            }?;
            Some((c, end))
        });
        match decoded {
            Some((c, end)) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn https(raw: &str, base: &reqwest::Url) -> Option<String> {
    let url = base.join(decode(raw).trim()).ok()?;
    (url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.as_str().len() <= MAX_URL)
        .then(|| url.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};

    fn base() -> reqwest::Url {
        reqwest::Url::parse("https://example.com/a/page").unwrap()
    }

    #[test]
    fn open_graph_wins_over_twitter_and_the_title() {
        let html = r#"<!doctype html><html><head>
            <title>Plain &amp; simple</title>
            <meta name="twitter:title" content="Twitter title">
            <meta property="og:title" content="OG &quot;title&quot;" />
            <meta name=description content=Fallback>
            <meta name="twitter:description" content="Twitter description">
            <meta property='og:site_name' content='Example'>
            <meta property="og:image" content="/img/card.png">
            <meta property="og:image:alt" content="A card">
            <link rel="shortcut icon" href="//cdn.example.com/favicon.ico">
            </head><body><meta property="og:description" content="in body"></body></html>"#;
        assert_eq!(
            preview(html, &base()),
            PagePreview {
                title: Some("OG \"title\"".into()),
                description: Some("Twitter description".into()),
                site_name: Some("Example".into()),
                image: Some("https://example.com/img/card.png".into()),
                image_alt: Some("A card".into()),
                icon: Some("https://cdn.example.com/favicon.ico".into()),
            }
        );
    }

    #[test]
    fn the_title_tag_fills_in_and_scripts_and_comments_are_skipped() {
        let html = "<head><!-- <meta property=\"og:title\" content=\"comment\"> -->\
            <script>var s = '<meta property=\"og:title\" content=\"script\">';</script>\
            <TITLE>\n  Hello&#x20;&#8212;   world \n</TITLE></head>";
        let page = preview(html, &base());
        assert_eq!(page.title.as_deref(), Some("Hello — world"));
        assert_eq!(page.description, None);
    }

    #[test]
    fn only_https_urls_come_back() {
        let html = r#"<meta property="og:image" content="http://example.com/a.png">
            <link rel="icon" href="javascript:alert(1)">"#;
        let page = preview(html, &base());
        assert_eq!(page.image, None);
        assert_eq!(page.icon, None);
        let html = r#"<meta property="og:image" content="https://user:pw@example.com/a.png">"#;
        assert_eq!(preview(html, &base()).image, None);
    }

    #[test]
    fn an_https_image_behind_an_http_one_still_comes_back() {
        let html = r#"<meta property="og:image" content="http://example.com/a.png">
            <meta property="og:image:secure_url" content="https://example.com/a.png">
            <meta name="twitter:image" content="https://example.com/b.png">"#;
        assert_eq!(
            preview(html, &base()).image.as_deref(),
            Some("https://example.com/a.png")
        );
        let html = r#"<meta property="og:image" content="http://example.com/a.png">
            <meta name="twitter:image" content="https://example.com/b.png">"#;
        assert_eq!(
            preview(html, &base()).image.as_deref(),
            Some("https://example.com/b.png")
        );
    }

    #[test]
    fn only_a_real_boundary_ends_the_head() {
        for html in [
            "<head><script>let s = '</head><body>';</script>",
            "<head><!-- </head> <body> -->",
            r#"<head><meta name="x" content="</head><body>">"#,
            "<head><title></head></title>",
            "<head></head",
        ] {
            assert!(may_end_head(html.as_bytes()), "{html}");
            assert!(!scan(html).ended, "{html}");
        }
        assert!(scan("<head><script>'</head>'</script></head>").ended);
        assert!(scan("<head><BODY class=x>").ended);
    }

    #[test]
    fn long_text_is_cut() {
        let html = format!("<title>{}</title>", "a".repeat(400));
        let title = preview(&html, &base()).title.unwrap();
        assert_eq!(title.chars().count(), 300);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn broken_markup_ends_quietly() {
        for html in [
            "<meta property=\"og:title",
            "<",
            "<title>open",
            "&#xFFFFFFFF; <meta",
        ] {
            let _ = preview(html, &base());
        }
        assert_eq!(
            preview("<title>a &bogus; b &#99999999;</title>", &base())
                .title
                .as_deref(),
            Some("a &bogus; b &#99999999;")
        );
    }

    fn reply(response: Vec<u8>) -> (SocketAddr, std::sync::mpsc::Receiver<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sent, received) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let n = socket.read(&mut request).unwrap();
            let _ = sent.send(String::from_utf8_lossy(&request[..n]).to_ascii_lowercase());
            let _ = socket.write_all(&response);
        });
        (address, received)
    }

    fn read(response: Vec<u8>) -> Result<PageReply, String> {
        let (address, server) = reply(response);
        let url =
            reqwest::Url::parse(&format!("http://page.invalid:{}/p", address.port())).unwrap();
        let result =
            tauri::async_runtime::block_on(read_from(url, &[address], Duration::from_secs(5)));
        let sent = server
            .recv_timeout(Duration::from_secs(5))
            .expect("the request reached the pinned address");
        assert!(sent.starts_with("get /p http/1.1"), "{sent}");
        assert!(sent.contains("host: page.invalid"), "{sent}");
        assert!(sent.contains("accept: text/html"), "{sent}");
        assert!(!sent.contains("cookie:"), "{sent}");
        result
    }

    fn http(head: &str, body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {head}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[test]
    fn a_page_comes_back_as_its_preview_only() {
        let reply = read(http(
            "200 OK\r\nContent-Type: text/html; charset=utf-8\r\nSet-Cookie: a=1",
            "<head><title>Hi</title></head><body>secret</body>",
        ))
        .unwrap();
        assert_eq!(reply.status, 200);
        assert_eq!(reply.location, None);
        assert_eq!(reply.preview.unwrap().title.as_deref(), Some("Hi"));
    }

    #[test]
    fn a_redirect_comes_back_for_the_plugin_to_check() {
        let reply = read(http(
            "301 Moved Permanently\r\nLocation: https://intranet.example/x",
            "",
        ))
        .unwrap();
        assert_eq!(reply.status, 301);
        assert_eq!(
            reply.location.as_deref(),
            Some("https://intranet.example/x")
        );
        assert_eq!(reply.preview, None);
    }

    #[test]
    fn other_types_and_errors_come_back_bare() {
        for response in [
            http("200 OK\r\nContent-Type: application/json", "{\"title\":1}"),
            http("200 OK", "<title>untyped</title>"),
            http(
                "404 Not Found\r\nContent-Type: text/html",
                "<title>gone</title>",
            ),
        ] {
            let reply = read(response).unwrap();
            assert_eq!((reply.location, reply.preview), (None, None));
        }
    }

    #[test]
    fn reading_stops_at_the_head_limit() {
        let body = format!("<head>{}<title>late</title>", " ".repeat(MAX_HEAD_BYTES));
        let reply = read(http("200 OK\r\nContent-Type: text/html", &body)).unwrap();
        assert_eq!(reply.preview.unwrap().title, None);
    }
}
