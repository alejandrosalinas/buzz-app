//! Native-only viewer exchange. Credentials never enter a URL or website JavaScript.
use crate::federated_identity::FederatedIdentity;
use reqwest::header::{HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;
use zeroize::Zeroizing;

const VIEWER_COOKIE: &str = "__Secure-bbidentity_hosted_site_session";
/// FI builds have no Builderlab sign-in; the shared session is renewed here.
const FI_SIGN_IN_AGAIN: &str = "Sign in again in Settings → Identity → Organization sign-in";

/// The public revision of the native FI session whose token authorizes the
/// exchange, or in development builds the broker that holds the sign-in.
#[derive(Deserialize)]
#[serde(try_from = "RawViewerAuth")]
pub enum ViewerAuth {
    Federated(String),
    #[cfg(debug_assertions)]
    Broker(BrokerAuth),
}
#[cfg(debug_assertions)]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerAuth {
    origin: String,
    revision: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawViewerAuth {
    federated: Option<String>,
    #[cfg(debug_assertions)]
    broker: Option<BrokerAuth>,
}
impl TryFrom<RawViewerAuth> for ViewerAuth {
    type Error = &'static str;
    fn try_from(raw: RawViewerAuth) -> Result<Self, Self::Error> {
        #[cfg(debug_assertions)]
        if let Some(broker) = raw.broker {
            return if raw.federated.is_none() {
                Ok(Self::Broker(broker))
            } else {
                Err("expected exactly one viewer authentication source")
            };
        }
        raw.federated
            .map(Self::Federated)
            .ok_or("expected a federated session revision")
    }
}

/// Why an app could not be opened. `page` names a refusal the panel explains
/// with its own page instead of the message alone.
#[derive(Debug, Serialize)]
pub struct ViewerError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<ViewerPage>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ViewerPage {
    /// Kgoose refused this viewer. Like its own page, give no reason: an
    /// unknown or deleted app looks the same as one without access.
    Denied,
    /// The exchange could not be reached or failed on its side; trying again,
    /// or opening the app in the system browser, may work.
    Unavailable,
}

fn unavailable(message: &str) -> ViewerError {
    ViewerError {
        message: message.into(),
        page: Some(ViewerPage::Unavailable),
    }
}

impl From<String> for ViewerError {
    fn from(message: String) -> Self {
        Self {
            message,
            page: None,
        }
    }
}
impl From<&str> for ViewerError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

impl ViewerAuth {
    fn federated_revision(&self) -> Option<&str> {
        match self {
            Self::Federated(revision) => Some(revision),
            #[cfg(debug_assertions)]
            Self::Broker(_) => None,
        }
    }
}

/// A 401 alone never ends the shared FI session. As for other granted calls,
/// ask the adapter's session route once; it retires the session only when it
/// has really ended, so Settings shows it expired.
async fn recheck_refused_session(
    status: reqwest::StatusCode,
    revision: Option<String>,
    fi: FederatedIdentity,
) {
    if status != reqwest::StatusCode::UNAUTHORIZED {
        return;
    }
    if let Some(revision) = revision {
        fi.recheck(&revision).await;
    }
}

pub(super) struct Bootstrap {
    #[cfg(target_os = "macos")]
    pub cookie: Zeroizing<String>,
    #[cfg(target_os = "macos")]
    pub app_origin: String,
    #[cfg(target_os = "macos")]
    pub cookie_domain: String,
}

pub(super) fn app_root(domain: &str, target: &str) -> Result<String, String> {
    if domain.is_empty() {
        return Err("Builderlab Apps sign-in is not configured".into());
    }
    let url = Url::parse(target).map_err(|_| "Invalid Builderlab app URL")?;
    let label = url
        .host_str()
        .and_then(|host| host.strip_suffix(&format!(".{domain}")));
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !label.is_some_and(|label| {
            !label.is_empty() && !label.contains('.') && !matches!(label, "login" | "health")
        })
    {
        return Err("This app uses a different Builderlab environment".into());
    }
    Ok(format!("https://{}/", url.host_str().unwrap()))
}

fn cookie(
    credential: &str,
    expires_at: &str,
    domain: &str,
    now: i64,
    federated: bool,
) -> Result<Zeroizing<String>, String> {
    if !(32..=512).contains(&credential.len())
        || !credential
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err("Invalid Builderlab viewer credential".into());
    }
    let expires_at = chrono::DateTime::parse_from_rfc3339(expires_at)
        .map_err(|_| "Invalid Builderlab sign-in expiry")?;
    if !(1..=8 * 60 * 60).contains(&(expires_at.timestamp() - now)) {
        return Err(if federated {
            format!("Builderlab sign-in expired. {FI_SIGN_IN_AGAIN}")
        } else {
            "Builderlab sign-in expired. Sign in again in Settings".into()
        });
    }
    let expiry = expires_at
        .with_timezone(&chrono::Utc)
        .format("%a, %d %b %Y %H:%M:%S GMT");
    Ok(Zeroizing::new(format!(
        "{VIEWER_COOKIE}={credential}; Domain={domain}; Path=/; Expires={expiry}; Secure; HttpOnly; SameSite=Lax"
    )))
}

/// Only feature absence permits browser-login fallback. All authorization and transport failures stay closed.
fn exchange_available(status: reqwest::StatusCode, federated: bool) -> Result<bool, ViewerError> {
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(false);
    }
    if status.is_success() {
        return Ok(true);
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err(ViewerError {
            message: "Your Builderlab account cannot open this app".into(),
            page: Some(ViewerPage::Denied),
        });
    }
    Err(match status.as_u16() {
        401 if federated => {
            "Sign in again in Settings → Identity → Organization sign-in, then reopen this app"
                .into()
        }
        401 => "Sign out and sign in to Builderlab again in Settings, then reopen this app".into(),
        _ => unavailable("Builderlab viewer sign-in is unavailable. Try reopening this app"),
    })
}

/// The exchange endpoint and the header authorizing it. A federated token is
/// selected only while its revision is still the current FI session's.
fn exchange_request(
    auth: ViewerAuth,
    fi: &FederatedIdentity,
) -> Result<(String, HeaderName, HeaderValue), String> {
    const PATH: &str = "v1/auth/hosted-site/native-session";
    match auth {
        #[cfg(debug_assertions)]
        ViewerAuth::Broker(broker) => {
            let origin = Url::parse(&broker.origin).map_err(|_| "Invalid development origin")?;
            if origin.scheme() != "http"
                || !matches!(origin.host_str(), Some("127.0.0.1" | "localhost"))
                || origin.port().is_none()
                || origin.origin().ascii_serialization() != broker.origin
            {
                return Err("Invalid development origin".into());
            }
            Ok((
                format!("{}/api/builderlab/viewer", broker.origin),
                HeaderName::from_static("x-buzz-builderlab-revision"),
                HeaderValue::from_str(&broker.revision)
                    .map_err(|_| "Invalid development session")?,
            ))
        }
        ViewerAuth::Federated(revision) => fi
            .with_session(|token, current, config| {
                if current != revision {
                    return None;
                }
                // The NIP-FI session is a Builderlab CLI session. Kgoose's exchange
                // takes it only in this header and refuses any Authorization header.
                let mut value = HeaderValue::from_str(token.as_str()).ok()?;
                value.set_sensitive(true);
                Some((
                    format!("{}{}{PATH}", config.identity_origin, config.api_base_path),
                    HeaderName::from_static("x-bb-session-credential"),
                    value,
                ))
            })
            .flatten()
            .ok_or_else(|| FI_SIGN_IN_AGAIN.into()),
    }
}

pub(super) async fn prepare(
    target: &str,
    auth: ViewerAuth,
    fi: &FederatedIdentity,
) -> Result<Option<Bootstrap>, ViewerError> {
    let domain = buzzodz_plugins::BUILDERLAB_APPS_DOMAIN;
    if domain.is_empty() {
        return Ok(None);
    }
    let root = app_root(domain, target)?;
    #[cfg(not(debug_assertions))]
    let development = false;
    #[cfg(debug_assertions)]
    let development = matches!(auth, ViewerAuth::Broker(_));
    let federated = !development;
    let revision = auth.federated_revision().map(str::to_owned);
    let (url, header, credential) = exchange_request(auth, fi)?;
    let client = reqwest::Client::builder()
        .https_only(!development)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Builderlab sign-in is unavailable")?;
    let body = Zeroizing::new(serde_json::json!({ "return_to": root }).to_string());
    let mut request = client.post(&url);
    if development {
        request = request.header(
            "Origin",
            Url::parse(&url)
                .map_err(|_| "Invalid development origin")?
                .origin()
                .ascii_serialization(),
        );
    }
    let mut response = request
        .header(header, credential)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|_| unavailable("Builderlab sign-in request failed"))?;
    // The refusal shows now; the session route answers in the background.
    tokio::spawn(recheck_refused_session(
        response.status(),
        revision.clone(),
        fi.clone(),
    ));
    if !exchange_available(response.status(), federated)? {
        return Ok(None);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| unavailable("Invalid Builderlab sign-in response"))?
    {
        if bytes.len() + chunk.len() > 4096 {
            return Err(unavailable("Invalid Builderlab sign-in response"));
        }
        bytes.extend_from_slice(&chunk);
    }
    #[derive(Deserialize)]
    struct Reply {
        credential: String,
        expires_at: String,
    }
    let reply: Reply = serde_json::from_slice(&bytes)
        .map_err(|_| unavailable("Invalid Builderlab sign-in response"))?;
    let viewer_credential = Zeroizing::new(reply.credential);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Invalid system clock")?
        .as_secs() as i64;
    let viewer_cookie = cookie(
        &viewer_credential,
        &reply.expires_at,
        domain,
        now,
        federated,
    )?;
    #[cfg(not(target_os = "macos"))]
    {
        drop(viewer_cookie);
        Err("Builderlab viewer sign-in is supported only on macOS".into())
    }
    #[cfg(target_os = "macos")]
    Ok(Some(Bootstrap {
        cookie: viewer_cookie,
        app_origin: root.trim_end_matches('/').into(),
        cookie_domain: domain.into(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_in() -> FederatedIdentity {
        crate::federated_identity::testing::signed_in(
            "http://127.0.0.1:1".into(),
            "wss://relay.example",
            false,
        )
    }
    fn revision(fi: &FederatedIdentity) -> String {
        fi.with_session(|_, revision, _| revision.to_owned())
            .unwrap()
    }

    #[test]
    fn viewer_auth_accepts_exactly_one_known_field() {
        let parse = |json: &str| serde_json::from_str::<ViewerAuth>(json);
        assert!(matches!(
            parse(r#"{"federated":"r"}"#),
            Ok(ViewerAuth::Federated(value)) if value == "r"
        ));
        for json in [
            "{}",
            r#"{"federated":null}"#,
            r#"{"credential":"c"}"#,
            r#"{"credential":"c","federated":"r"}"#,
            r#"{"federated":"r","extra":1}"#,
            r#"{"federated":1}"#,
        ] {
            assert!(parse(json).is_err(), "{json}");
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn development_viewer_auth_accepts_only_loopback_origins_and_a_public_revision() {
        let fi = signed_in();
        for origin in ["http://127.0.0.1:1430", "http://localhost:1430"] {
            let auth: ViewerAuth = serde_json::from_value(serde_json::json!({ "broker": { "origin": origin, "revision": "public-revision" } })).unwrap();
            let (url, header, value) = exchange_request(auth, &fi).unwrap();
            assert_eq!(url, format!("{origin}/api/builderlab/viewer"));
            assert_eq!(header.as_str(), "x-buzz-builderlab-revision");
            assert_eq!(value.to_str().unwrap(), "public-revision");
        }
        for origin in [
            "https://evil.example",
            "http://127.0.0.1:1430/path",
            "http://user@localhost:1430",
            "http://localhost",
        ] {
            assert!(exchange_request(
                ViewerAuth::Broker(BrokerAuth {
                    origin: origin.into(),
                    revision: "r".into()
                }),
                &fi
            )
            .is_err());
        }
        assert!(serde_json::from_value::<ViewerAuth>(serde_json::json!({"federated":"r", "broker":{"origin":"http://127.0.0.1:1430","revision":"r"}})).is_err());
    }

    #[test]
    fn federated_exchange_sends_the_session_credential_only_for_the_current_revision() {
        let fi = signed_in();
        let (url, name, value) =
            exchange_request(ViewerAuth::Federated(revision(&fi)), &fi).unwrap();
        assert_eq!(
            url,
            "https://identity.example/api/v1/auth/hosted-site/native-session"
        );
        assert_eq!(name.as_str(), "x-bb-session-credential");
        assert_eq!(value.to_str().unwrap(), "fixture-session-token");
        assert!(value.is_sensitive());
        for stale in [revision(&fi) + "x", String::new()] {
            assert_eq!(
                exchange_request(ViewerAuth::Federated(stale), &fi).unwrap_err(),
                FI_SIGN_IN_AGAIN
            );
        }
        let current = revision(&fi);
        fi.sign_out_for_test();
        assert!(exchange_request(ViewerAuth::Federated(current), &fi).is_err());
    }

    #[test]
    fn federated_exchange_fails_closed_when_federated_identity_is_unconfigured() {
        let fi = FederatedIdentity::unconfigured();
        assert!(exchange_request(ViewerAuth::Federated("any".into()), &fi).is_err());
    }

    #[test]
    fn browser_login_fallback_is_only_for_an_unavailable_feature() {
        for federated in [false, true] {
            assert!(!exchange_available(reqwest::StatusCode::NOT_FOUND, federated).unwrap());
            assert!(exchange_available(reqwest::StatusCode::OK, federated).unwrap());
            for code in [400, 401, 403, 429, 500, 503, 302] {
                let status = reqwest::StatusCode::from_u16(code).unwrap();
                assert!(exchange_available(status, federated).is_err());
            }
        }
        // A refused session is renewed where each build signs in.
        let unauthorized = reqwest::StatusCode::UNAUTHORIZED;
        assert!(exchange_available(unauthorized, true)
            .unwrap_err()
            .message
            .contains("Identity → Organization sign-in"));
        assert!(exchange_available(unauthorized, false)
            .unwrap_err()
            .message
            .contains("sign in to Builderlab again"));
    }

    #[test]
    fn refusals_and_outages_name_their_panel_pages() {
        for federated in [false, true] {
            for code in [400, 401, 403, 429, 500, 503, 302] {
                let status = reqwest::StatusCode::from_u16(code).unwrap();
                let error = exchange_available(status, federated).unwrap_err();
                let page = match code {
                    403 => Some(ViewerPage::Denied),
                    401 => None,
                    _ => Some(ViewerPage::Unavailable),
                };
                assert_eq!(error.page, page, "{code}");
            }
        }
        let denied = exchange_available(reqwest::StatusCode::FORBIDDEN, true).unwrap_err();
        assert_eq!(
            serde_json::to_value(&denied).unwrap(),
            serde_json::json!({
                "message": "Your Builderlab account cannot open this app",
                "page": "denied",
            })
        );
        // Other failures carry only their message.
        let outage = exchange_available(reqwest::StatusCode::BAD_GATEWAY, true).unwrap_err();
        assert_eq!(
            serde_json::to_value(&outage).unwrap(),
            serde_json::json!({
                "message": "Builderlab viewer sign-in is unavailable. Try reopening this app",
                "page": "unavailable",
            })
        );
        let other = ViewerError::from("Invalid Builderlab viewer credential");
        assert_eq!(
            serde_json::to_value(&other).unwrap(),
            serde_json::json!({ "message": "Invalid Builderlab viewer credential" })
        );
    }

    #[test]
    fn credentials_are_only_used_for_same_tenant_exact_app_hosts() {
        let domain = "apps.example";
        assert_eq!(
            app_root(
                domain,
                "https://counter--bpsites.apps.example/second?q=1#part"
            )
            .unwrap(),
            "https://counter--bpsites.apps.example/"
        );
        for target in [
            "https://counter.apps.other.example/",
            "https://apps.example/",
            "https://login.apps.example/",
            "https://health.apps.example/",
            "https://nested.app.apps.example/",
            "https://app.apps.example.evil.test/",
            "http://counter.apps.example/",
            "https://user@counter.apps.example/",
            "https://counter.apps.example:8443/",
        ] {
            assert!(app_root(domain, target).is_err(), "{target}");
        }
        assert!(app_root("", "https://counter.apps.example/").is_err());
    }

    #[test]
    fn viewer_cookie_replaces_the_existing_domain_cookie_with_absolute_expiry() {
        let value = cookie(
            &"C".repeat(43),
            "2026-10-26T16:00:00Z",
            "apps.example",
            chrono::DateTime::parse_from_rfc3339("2026-10-26T15:00:00Z")
                .unwrap()
                .timestamp(),
            false,
        )
        .unwrap();
        assert!(value.starts_with("__Secure-bbidentity_hosted_site_session="));
        assert!(value.contains(
            "Path=/; Expires=Mon, 26 Oct 2026 16:00:00 GMT; Secure; HttpOnly; SameSite=Lax"
        ));
        assert!(value.contains("Domain=apps.example; Path=/"));
        for credential in [
            "short".to_string(),
            "C".repeat(513),
            format!("{}; injected=x", "C".repeat(43)),
        ] {
            assert!(cookie(
                &credential,
                "2026-10-26T16:00:00Z",
                "apps.example",
                chrono::DateTime::parse_from_rfc3339("2026-10-26T15:00:00Z")
                    .unwrap()
                    .timestamp(),
                false,
            )
            .is_err());
        }
        for expiry in ["invalid", "2026-10-26T15:00:00Z", "2026-10-27T16:00:00Z"] {
            assert!(cookie(
                &"C".repeat(43),
                expiry,
                "apps.example",
                chrono::DateTime::parse_from_rfc3339("2026-10-26T15:00:00Z")
                    .unwrap()
                    .timestamp(),
                false,
            )
            .is_err());
        }
        // An expired viewer is renewed where each build signs in.
        let expired = |federated| {
            cookie(
                &"C".repeat(43),
                "2026-10-26T15:00:00Z",
                "apps.example",
                chrono::DateTime::parse_from_rfc3339("2026-10-26T15:00:00Z")
                    .unwrap()
                    .timestamp(),
                federated,
            )
            .unwrap_err()
        };
        assert_eq!(
            expired(true),
            format!("Builderlab sign-in expired. {FI_SIGN_IN_AGAIN}")
        );
        assert_eq!(
            expired(false),
            "Builderlab sign-in expired. Sign in again in Settings"
        );
    }

    /// The adapter's session route answers every request with `status`.
    async fn adapter(status: u16) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).await.unwrap();
                    head.push(byte[0]);
                }
                let line = String::from_utf8(head).unwrap();
                log.lock()
                    .unwrap()
                    .push(line.lines().next().unwrap().to_owned());
                let body = if status == 200 {
                    r#"{"expires_at":"2099-01-01T00:00:00Z"}"#
                } else {
                    r#"{"error":"session_expired"}"#
                };
                let reply = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        (origin, seen)
    }
    fn status(fi: &FederatedIdentity) -> serde_json::Value {
        serde_json::to_value(fi.snapshot()).unwrap()["status"].clone()
    }

    #[tokio::test]
    async fn an_exchange_401_ends_the_session_only_when_the_adapter_denies_it() {
        let unauthorized = reqwest::StatusCode::UNAUTHORIZED;
        for (adapter_status, expected) in [(200, "signed-in"), (401, "reauthentication-required")] {
            let (origin, seen) = adapter(adapter_status).await;
            let fi = crate::federated_identity::testing::signed_in_at(origin);
            let current = revision(&fi);
            recheck_refused_session(unauthorized, Some(current), fi.clone()).await;
            assert_eq!(status(&fi), expected);
            let seen = seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert!(seen[0].starts_with("GET /v1/session "), "{}", seen[0]);
        }
    }

    #[tokio::test]
    async fn other_exchange_refusals_and_other_sessions_ask_nothing() {
        let (origin, seen) = adapter(401).await;
        let fi = crate::federated_identity::testing::signed_in_at(origin);
        let current = revision(&fi);
        for code in [200, 400, 403, 404, 429, 500, 503] {
            let refusal = reqwest::StatusCode::from_u16(code).unwrap();
            recheck_refused_session(refusal, Some(current.clone()), fi.clone()).await;
        }
        // A development broker has no shared session, and a replaced one is not asked about.
        let unauthorized = reqwest::StatusCode::UNAUTHORIZED;
        recheck_refused_session(unauthorized, None, fi.clone()).await;
        recheck_refused_session(unauthorized, Some("stale".into()), fi.clone()).await;
        assert!(seen.lock().unwrap().is_empty());
        assert_eq!(status(&fi), "signed-in");
    }
}
