use url::Url;

const MAXIMUM_URL_BYTES: usize = 2048;

#[derive(Clone)]
pub(super) struct NavigationPolicy {
    development_url: Option<Url>,
}

impl NavigationPolicy {
    pub(super) fn new(development_url: Option<Url>) -> Self {
        Self { development_url }
    }

    pub(super) fn validate(&self, target: &str) -> Result<Url, String> {
        if target.len() > MAXIMUM_URL_BYTES {
            return Err("Browser URLs cannot exceed 2048 bytes".into());
        }
        let url = Url::parse(target)
            .map_err(|_| "Enter a complete http:// or https:// URL".to_string())?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err("Buzz Browser supports HTTP and HTTPS websites only".into());
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("URLs containing credentials are not supported".into());
        }
        if matches!(
            url.host_str(),
            Some("tauri.localhost" | "asset.localhost" | "ipc.localhost")
        ) || self
            .development_url
            .as_ref()
            .is_some_and(|development| development.origin() == url.origin())
        {
            return Err("Buzz application URLs cannot be opened as websites".into());
        }
        if url.as_str().len() > MAXIMUM_URL_BYTES {
            return Err("Browser URLs cannot exceed 2048 bytes after URL encoding".into());
        }
        Ok(url)
    }

    /// The http address to load when `url` fails over https, if this policy permits it.
    pub(super) fn http_fallback(&self, url: &Url) -> Option<Url> {
        if url.scheme() != "https" {
            return None;
        }
        let mut http = url.clone();
        http.set_scheme("http").ok()?;
        self.validate(http.as_str()).ok()
    }
}

/// The Builderlab portal's tool-app approval page and account connections
/// page. Both need the portal's own web login, which a Buzz guest never has
/// (it only holds an app viewer cookie), so Buzz opens them in the system
/// browser instead.
#[derive(Clone)]
pub(super) struct ApprovalGate {
    url: Url,
    apps_domain: &'static str,
}

impl ApprovalGate {
    const SUFFIX: &'static str = "/v1/hosted-app-tools/gate";
    const CONNECTIONS: &'static str = "/connections";

    /// The gate of the portal whose API lives at `adapter_base`, for apps
    /// under `apps_domain`. A build without an Apps domain has none.
    pub(super) fn new(adapter_base: &str, apps_domain: &'static str) -> Option<Self> {
        if apps_domain.is_empty() {
            return None;
        }
        let url = Url::parse(&format!("{adapter_base}{}", Self::SUFFIX)).ok()?;
        Some(Self { url, apps_domain })
    }

    /// When `target` is this gate for a Builderlab app, the approval to hand
    /// off: the gate rebuilt with only its app, and the app's address to
    /// return to once approved.
    pub(super) fn approval(&self, target: &str) -> Option<Approval> {
        let target = self.portal_page(target, self.url.path())?;
        let (host, app) = self.app(&target)?;
        let mut page = self.url.clone();
        page.query_pairs_mut().append_pair("app", &host);
        Some(Approval {
            page: page.into(),
            app,
        })
    }

    /// When `target` is the portal page connecting an account, such as
    /// GitHub, for a Builderlab app, that page rebuilt with only its
    /// extension and app, and the app's address to return to.
    pub(super) fn connection(&self, target: &str) -> Option<Approval> {
        let target = self.portal_page(target, Self::CONNECTIONS)?;
        let extension = single(&target, "extension").filter(|value| {
            (1..=64).contains(&value.len())
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        })?;
        let (host, app) = self.app(&target)?;
        let mut page = self.url.clone();
        page.set_path(Self::CONNECTIONS);
        page.query_pairs_mut()
            .append_pair("extension", &extension)
            .append_pair("app", &host);
        Some(Approval {
            page: page.into(),
            app,
        })
    }

    fn portal_page(&self, target: &str, path: &str) -> Option<Url> {
        let target = Url::parse(target).ok()?;
        (target.origin() == self.url.origin() && target.path().trim_end_matches('/') == path)
            .then_some(target)
    }

    /// The Builderlab app a portal page names, and that app's root.
    fn app(&self, target: &Url) -> Option<(String, String)> {
        let app = single(target, "app")?;
        let app_url = Url::parse(&format!("https://{app}/")).ok()?;
        let host = app_url.host_str()?;
        if host != app.to_ascii_lowercase() {
            return None;
        }
        let root = super::builderlab::app_root(self.apps_domain, app_url.as_str()).ok()?;
        Some((host.to_owned(), root))
    }
}

/// The value of a query parameter that appears exactly once.
fn single(url: &Url, name: &str) -> Option<String> {
    let mut values = url
        .query_pairs()
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned());
    values.next().filter(|_| values.next().is_none())
}

/// A portal page to open in the system browser, and the app page to return to.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Approval {
    pub(super) page: String,
    pub(super) app: String,
}

/// Coordinates relative to the main webview's CSS viewport.
#[derive(Clone, Copy, Debug, serde::Deserialize, PartialEq)]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl BrowserBounds {
    pub(super) fn validate(self) -> Result<(), String> {
        if ![self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || self.width <= 0.0
            || self.height <= 0.0
        {
            return Err(
                "Browser viewport must have finite, positive dimensions within the app".into(),
            );
        }
        Ok(())
    }

    #[cfg(any(target_os = "macos", target_os = "windows", test))]
    pub(super) fn clip(self, width: f64, height: f64) -> Result<Self, String> {
        self.validate()?;
        let clipped = Self {
            width: self.width.min(width - self.x),
            height: self.height.min(height - self.y),
            ..self
        };
        clipped.validate()?;
        Ok(clipped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_the_portal_approval_gate() {
        let gate = ApprovalGate::new(
            "https://app.builderlab.xyz/api/goose",
            "apps.builderlab.xyz",
        )
        .unwrap();
        assert!(ApprovalGate::new("https://app.builderlab.xyz/api/goose", "").is_none());
        let expected = Approval {
            page: "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=eggy--bpsites.apps.builderlab.xyz".into(),
            app: "https://eggy--bpsites.apps.builderlab.xyz/".into(),
        };
        assert_eq!(
            gate.approval("https://APP.builderlab.xyz/api/goose/v1/hosted-app-tools/gate/?app=Eggy--bpsites.apps.builderlab.xyz&next=https://evil.example"),
            Some(expected)
        );
        for other in [
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=a.apps.builderlab.xyz&app=b.apps.builderlab.xyz",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=a.example",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=localhost",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=127.0.0.1",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=tauri.localhost",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=apps.builderlab.xyz",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=a.b.apps.builderlab.xyz",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=login.apps.builderlab.xyz",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=a.apps.builderlab.xyz.evil.example",
            "https://app.builderlab.xyz:8443/api/goose/v1/hosted-app-tools/gate?app=a.apps.builderlab.xyz",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=a.apps.builderlab.xyz/path",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=a.apps.builderlab.xyz:8443",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=user@a.apps.builderlab.xyz",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/consent.js?app=a.apps.builderlab.xyz",
            "https://app.builderlabstaging.xyz/api/goose/v1/hosted-app-tools/gate?app=a.apps.builderlab.xyz",
            "http://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=a.apps.builderlab.xyz",
            "https://eggy--bpsites.apps.builderlab.xyz/",
            "not a url",
        ] {
            assert_eq!(gate.approval(other), None, "{other}");
        }
    }

    #[test]
    fn recognizes_only_the_portal_connections_page() {
        let gate = ApprovalGate::new(
            "https://app.builderlab.xyz/api/goose",
            "apps.builderlab.xyz",
        )
        .unwrap();
        let expected = Approval {
            page: "https://app.builderlab.xyz/connections?extension=github&app=eggy--bpsites.apps.builderlab.xyz".into(),
            app: "https://eggy--bpsites.apps.builderlab.xyz/".into(),
        };
        assert_eq!(
            gate.connection("https://APP.builderlab.xyz/connections/?extension=github&app=Eggy--bpsites.apps.builderlab.xyz&next=https://evil.example#x"),
            Some(expected)
        );
        for other in [
            "https://app.builderlab.xyz/connections?app=a.apps.builderlab.xyz",
            "https://app.builderlab.xyz/connections?extension=&app=a.apps.builderlab.xyz",
            "https://app.builderlab.xyz/connections?extension=git%2Fhub&app=a.apps.builderlab.xyz",
            &format!("https://app.builderlab.xyz/connections?extension={}&app=a.apps.builderlab.xyz", "a".repeat(65)),
            "https://app.builderlab.xyz/connections?extension=github&extension=linear&app=a.apps.builderlab.xyz",
            "https://app.builderlab.xyz/connections?extension=github",
            "https://app.builderlab.xyz/connections?extension=github&app=a.example",
            "https://app.builderlab.xyz/connections?extension=github&app=a.b.apps.builderlab.xyz",
            "https://app.builderlab.xyz/connections/oauth/github?extension=github&app=a.apps.builderlab.xyz",
            "https://app.builderlab.xyz/api/goose/connections?extension=github&app=a.apps.builderlab.xyz",
            "https://app.builderlabstaging.xyz/connections?extension=github&app=a.apps.builderlab.xyz",
            "http://app.builderlab.xyz/connections?extension=github&app=a.apps.builderlab.xyz",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=a.apps.builderlab.xyz",
        ] {
            assert_eq!(gate.connection(other), None, "{other}");
        }
    }

    #[test]
    fn permits_websites_and_normalizes_host_names() {
        let policy = NavigationPolicy::new(None);
        assert_eq!(
            policy
                .validate("https://EXAMPLE.com/a?q=x#part")
                .unwrap()
                .as_str(),
            "https://example.com/a?q=x#part"
        );
        assert!(policy.validate("http://127.0.0.1:5123/page").is_ok());
    }

    #[test]
    fn http_fallback_keeps_the_address_and_explicit_port() {
        let policy = NavigationPolicy::new(Some(Url::parse("http://localhost:1430").unwrap()));
        let fallback = |target: &str| {
            policy
                .http_fallback(&Url::parse(target).unwrap())
                .map(String::from)
        };
        assert_eq!(
            fallback("https://grugbrain.dev/a?q=x#part").as_deref(),
            Some("http://grugbrain.dev/a?q=x#part")
        );
        assert_eq!(
            fallback("https://localhost:3000/").as_deref(),
            Some("http://localhost:3000/")
        );
        assert_eq!(
            fallback("https://example.com:443/").as_deref(),
            Some("http://example.com/")
        );
        assert_eq!(fallback("http://example.com/"), None);
        assert_eq!(fallback("https://localhost:1430/"), None);
    }

    #[test]
    fn denies_non_web_schemes_credentials_and_application_origins() {
        let policy = NavigationPolicy::new(Some(Url::parse("http://localhost:1430").unwrap()));
        for target in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
            "tauri://localhost",
            "https://user@example.com",
            "https://user:password@example.com",
            "https://tauri.localhost/page",
            "http://ipc.localhost",
            "https://asset.localhost/private",
            "http://localhost:1430/browser.html",
        ] {
            assert!(policy.validate(target).is_err(), "{target}");
        }
        assert!(policy.validate("http://localhost:1431").is_ok());
    }

    #[test]
    fn enforces_url_limit_in_bytes() {
        let policy = NavigationPolicy::new(None);
        let prefix = "https://example.com/";
        assert!(policy
            .validate(&format!("{prefix}{}", "a".repeat(2048 - prefix.len())))
            .is_ok());
        assert!(policy
            .validate(&format!("{prefix}{}", "a".repeat(2049 - prefix.len())))
            .is_err());
        assert!(policy
            .validate(&format!("{prefix}{}", "🦀".repeat(600)))
            .is_err());
    }

    #[test]
    fn enforces_url_limit_after_percent_encoding() {
        let policy = NavigationPolicy::new(None);
        let target = format!("https://example.com/{}", "🦀".repeat(200));
        assert!(target.len() < MAXIMUM_URL_BYTES);
        assert!(policy.validate(&target).is_err());
    }

    #[test]
    fn viewport_rejects_invalid_or_offscreen_rectangles() {
        let bounds = BrowserBounds {
            x: 500.0,
            y: 80.0,
            width: 400.0,
            height: 600.0,
        };
        for invalid in [
            BrowserBounds { x: -1.0, ..bounds },
            BrowserBounds {
                y: f64::NAN,
                ..bounds
            },
            BrowserBounds {
                width: f64::INFINITY,
                ..bounds
            },
            BrowserBounds {
                height: 0.0,
                ..bounds
            },
        ] {
            assert!(invalid.validate().is_err());
        }
        assert!(bounds.clip(500.0, 800.0).is_err());
        assert!(bounds.clip(1200.0, 80.0).is_err());
    }

    #[test]
    fn viewport_clips_to_main_webview() {
        let bounds = BrowserBounds {
            x: 500.0,
            y: 80.0,
            width: 400.0,
            height: 600.0,
        };
        assert_eq!(
            bounds.clip(800.0, 600.0).unwrap(),
            BrowserBounds {
                width: 300.0,
                height: 520.0,
                ..bounds
            }
        );
        assert_eq!(bounds.clip(1200.0, 800.0).unwrap(), bounds);
    }
}
