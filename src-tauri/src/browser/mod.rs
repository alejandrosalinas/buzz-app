//! Remote website content embedded in the main window without a Tauri bridge.

mod builderlab;
mod platform;
mod policy;

use std::{
    cell::RefCell,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Webview};
use wry::{PageLoadEvent, Rect, WebView, WebViewBuilder};

pub use policy::BrowserBounds;
use policy::NavigationPolicy;

thread_local! {
    // Wry and its delegates must be created, used, and dropped on the UI thread.
    // Hidden guests keep their pages; the main webview decides which shows.
    static BROWSERS: RefCell<Vec<BrowserSession>> = const { RefCell::new(Vec::new()) };
}

/// A backstop for guests the main webview failed to detach. It evicts the
/// oldest, which the host's own, smaller limit should never reach.
const MAX_GUESTS: usize = 8;

static DOCUMENT_GENERATION: AtomicU64 = AtomicU64::new(0);

fn reset_document<Session>(
    label: &str,
    event: tauri::webview::PageLoadEvent,
    generation: &AtomicU64,
    sessions: &RefCell<Vec<Session>>,
) {
    if label == "main" && event == tauri::webview::PageLoadEvent::Started {
        generation.fetch_add(1, Ordering::SeqCst);
        sessions.borrow_mut().clear();
    }
}

fn with_current_document<Output>(
    generation: &AtomicU64,
    expected: u64,
    operation: impl FnOnce() -> Result<Output, String>,
) -> Result<Output, String> {
    if generation.load(Ordering::SeqCst) != expected {
        return Err("Browser host document was reloaded".into());
    }
    operation()
}

pub(crate) fn page_load(webview: &Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    // Wry forwards WKNavigationDelegate's callback synchronously on the UI thread.
    BROWSERS.with(|sessions| {
        reset_document(
            webview.label(),
            payload.event(),
            &DOCUMENT_GENERATION,
            sessions,
        );
    });
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct BrowserSnapshot {
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserAction {
    Back,
    Forward,
    Reload,
}

struct BrowserSession {
    instance: String,
    host: Webview,
    guest: WebView,
    // WKWebView's UI and navigation delegate references are weak.
    _permissions: platform::Permissions,
    navigation: platform::Navigation,
    snapshot: Rc<RefCell<BrowserSnapshot>>,
    policy: NavigationPolicy,
}

impl BrowserSession {
    fn navigate(&self, target: &str, fallback_to_http: bool) -> Result<(), String> {
        let url = self.policy.validate(target)?;
        let http_fallback = fallback_to_http
            .then(|| self.policy.http_fallback(&url))
            .flatten();
        platform::load(&self.guest, &self.navigation, &url, http_fallback)?;
        let mut snapshot = self.snapshot.borrow_mut();
        snapshot.url = url.to_string();
        snapshot.loading = true;
        snapshot.error = None;
        Ok(())
    }

    fn snapshot(&self) -> Result<BrowserSnapshot, String> {
        let mut snapshot = self.snapshot.borrow().clone();
        if let Some(url) = platform::current_url(&self.guest)? {
            snapshot.url = url;
        }
        #[cfg(target_os = "macos")]
        {
            snapshot.loading = platform::loading(&self.guest);
        }
        Ok(snapshot)
    }

    fn set_bounds(&self, bounds: BrowserBounds, visible: bool) -> Result<(), String> {
        self.guest
            .set_visible(false)
            .map_err(|error| error.to_string())?;
        if !visible {
            return Ok(());
        }
        platform::resize_guest(&self.guest, &self.host, bounds)?;
        self.guest
            .set_visible(true)
            .map_err(|error| error.to_string())
    }
}

async fn on_main_thread<T: Send + 'static>(
    app: &AppHandle,
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.try_send(operation());
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "Browser stopped before the request completed".to_string())?
}

fn with_browser<T>(
    session_id: &str,
    operation: impl FnOnce(&BrowserSession) -> Result<T, String>,
) -> Result<T, String> {
    BROWSERS.with(|browsers| {
        let browsers = browsers.borrow();
        let browser = browsers
            .iter()
            .find(|browser| browser.instance == session_id)
            .ok_or_else(|| "Browser session is closed or replaced".to_string())?;
        operation(browser)
    })
}

pub(crate) fn shutdown() {
    BROWSERS.with(|browsers| browsers.borrow_mut().clear());
}

/// Native shortcuts run on the UI thread even when WebKit's internal content
/// view owns focus rather than an element in the trusted host document.
#[cfg(target_os = "macos")]
pub(crate) fn focused_session() -> Option<String> {
    BROWSERS.with(|browsers| {
        browsers
            .borrow()
            .iter()
            .find(|browser| platform::focused(&browser.guest))
            .map(|browser| browser.instance.clone())
    })
}

pub(crate) fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        return;
    }
    match event {
        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
            BROWSERS.with(|browsers| {
                for browser in browsers.borrow().iter() {
                    if let Err(error) = browser.guest.set_visible(false) {
                        browser.snapshot.borrow_mut().error = Some(error.to_string());
                    }
                }
            });
        }
        tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. } => shutdown(),
        _ => {}
    }
}

/// The data store a named website storage lives in. Names are namespaced so
/// they cannot select a store something else in the app created.
fn storage_identifier(name: &str) -> Result<[u8; 16], String> {
    if name.is_empty()
        || name.len() > 64
        || !name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_.".contains(&byte)
        })
    {
        return Err(
            "Browser storage names use 1-64 lowercase letters, digits, '-', '_' or '.'".into(),
        );
    }
    let digest = Sha256::digest(format!("buzz-browser-storage:{name}"));
    let mut identifier = [0; 16];
    identifier.copy_from_slice(&digest[..16]);
    Ok(identifier)
}

fn build_contents(
    app: &AppHandle,
    target: &str,
    bounds: BrowserBounds,
    storage: Option<&str>,
    defer_navigation: bool,
) -> Result<BrowserSession, String> {
    let policy = NavigationPolicy::new(app.config().build.dev_url.clone());
    let target = policy.validate(target)?;
    bounds.validate()?;
    let storage = storage.map(storage_identifier).transpose()?;
    let host = app
        .get_webview_window("main")
        .ok_or("Buzz main webview is unavailable")?
        .as_ref()
        .clone();
    let snapshot = Rc::new(RefCell::new(BrowserSnapshot::default()));
    let navigation_policy = policy.clone();
    let title_snapshot = snapshot.clone();
    let load_snapshot = snapshot.clone();
    let download_snapshot = snapshot.clone();
    // No URL is loaded until native permission handlers replace Wry's defaults.
    // In particular, this builder receives no IPC handler or host initialization scripts.
    let builder = platform::with_storage(WebViewBuilder::new(), storage)
        .with_visible(false)
        .with_clipboard(false)
        .with_devtools(false)
        .with_autoplay(false)
        .with_bounds(Rect {
            position: LogicalPosition::new(0.0, 0.0).into(),
            size: LogicalSize::new(1.0, 1.0).into(),
        })
        // Wry also reports subframe URLs here. A blocked iframe must not label
        // the successfully loaded top-level website as a navigation failure.
        .with_navigation_handler(move |target| navigation_policy.validate(&target).is_ok())
        .with_document_title_changed_handler(move |title| {
            title_snapshot.borrow_mut().title = title;
        })
        .with_on_page_load_handler(move |event, url| {
            let mut snapshot = load_snapshot.borrow_mut();
            snapshot.url = url;
            snapshot.loading = matches!(event, PageLoadEvent::Started);
        })
        .with_download_started_handler(move |_, _| {
            download_snapshot.borrow_mut().error =
                Some("Downloads are not supported in Buzz Browser".into());
            false
        })
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny);
    let guest = platform::build_guest(builder, &host.window())?;
    let permissions = platform::deny_permissions(&guest)?;
    let navigation = platform::observe_navigation(&guest)?;
    let browser = BrowserSession {
        instance: uuid::Uuid::new_v4().to_string(),
        host,
        guest,
        _permissions: permissions,
        navigation,
        snapshot,
        policy,
    };
    platform::resize_guest(&browser.guest, &browser.host, bounds)?;
    if !defer_navigation {
        browser.navigate(target.as_str(), false)?;
    }
    Ok(browser)
}

#[tauri::command]
pub async fn browser_attach(
    app: AppHandle,
    url: String,
    bounds: BrowserBounds,
    storage: Option<String>,
    builderlab: Option<builderlab::ViewerAuth>,
    federated_identity: tauri::State<'_, crate::federated_identity::FederatedIdentity>,
) -> Result<String, String> {
    let generation = DOCUMENT_GENERATION.load(Ordering::SeqCst);
    let defer_navigation = builderlab.is_some();
    let bootstrap = match builderlab {
        Some(auth) => builderlab::prepare(&url, auth, &federated_identity).await?,
        None => None,
    };
    let handle = app.clone();
    let (session_id, pending) = on_main_thread(&app, move || {
        with_current_document(&DOCUMENT_GENERATION, generation, || {
            let browser =
                build_contents(&handle, &url, bounds, storage.as_deref(), defer_navigation)?;
            let pending = bootstrap
                .as_ref()
                .map(|value| platform::install_builderlab_cookie(&browser.guest, value))
                .transpose()?;
            let session_id = browser.instance.clone();
            BROWSERS.with(|browsers| {
                let mut browsers = browsers.borrow_mut();
                browsers.push(browser);
                let excess = browsers.len().saturating_sub(MAX_GUESTS);
                browsers.drain(..excess);
            });
            Ok((session_id, pending))
        })
    })
    .await?;
    if let Some(mut pending) = pending {
        let installed =
            tokio::time::timeout(std::time::Duration::from_secs(5), pending.recv()).await;
        let id = session_id.clone();
        on_main_thread(&app, move || {
            if !matches!(installed, Ok(Some(()))) {
                BROWSERS.with(|browsers| {
                    browsers
                        .borrow_mut()
                        .retain(|browser| browser.instance != id)
                });
                return Err("Builderlab viewer cookie could not be installed".into());
            }
            let result = with_current_document(&DOCUMENT_GENERATION, generation, || {
                with_browser(&id, |_| Ok(()))
            });
            if result.is_err() {
                BROWSERS.with(|browsers| {
                    browsers
                        .borrow_mut()
                        .retain(|browser| browser.instance != id)
                });
            }
            result
        })
        .await?;
    }
    Ok(session_id)
}

#[tauri::command]
pub async fn browser_set_bounds(
    app: AppHandle,
    session_id: String,
    bounds: BrowserBounds,
    visible: bool,
) -> Result<(), String> {
    on_main_thread(&app, move || {
        with_browser(&session_id, |browser| browser.set_bounds(bounds, visible))
    })
    .await
}

#[tauri::command]
pub async fn browser_detach(app: AppHandle, session_id: String) -> Result<(), String> {
    on_main_thread(&app, move || {
        BROWSERS.with(|browsers| {
            browsers
                .borrow_mut()
                .retain(|browser| browser.instance != session_id);
        });
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    session_id: String,
    url: String,
    fallback_to_http: bool,
) -> Result<(), String> {
    on_main_thread(&app, move || {
        with_browser(&session_id, |browser| {
            browser.navigate(&url, fallback_to_http)
        })
    })
    .await
}

#[tauri::command]
pub async fn browser_action(
    app: AppHandle,
    session_id: String,
    action: BrowserAction,
) -> Result<(), String> {
    on_main_thread(&app, move || {
        with_browser(&session_id, |browser| {
            browser.snapshot.borrow_mut().error = None;
            match action {
                BrowserAction::Reload => browser.guest.reload().map_err(|error| error.to_string()),
                BrowserAction::Back => platform::back(&browser.guest),
                BrowserAction::Forward => platform::forward(&browser.guest),
            }
        })
    })
    .await
}

#[tauri::command]
pub async fn browser_status(app: AppHandle, session_id: String) -> Result<BrowserSnapshot, String> {
    on_main_thread(&app, move || {
        with_browser(&session_id, BrowserSession::snapshot)
    })
    .await
}

#[cfg(test)]
mod storage_tests {
    use super::storage_identifier;

    #[test]
    fn names_map_to_stable_distinct_stores() {
        let apps = storage_identifier("builderlab-apps").unwrap();
        assert_eq!(apps, storage_identifier("builderlab-apps").unwrap());
        assert_ne!(apps, storage_identifier("builderlab-docs").unwrap());
    }

    #[test]
    fn rejects_names_outside_the_allowed_shape() {
        for name in ["", "Apps", "a/b", "a b", &"a".repeat(65)] {
            assert!(storage_identifier(name).is_err(), "{name:?}");
        }
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use std::{cell::Cell, thread::ThreadId};
    use tauri::webview::PageLoadEvent::{Finished, Started};

    struct Guest {
        drops: Rc<RefCell<Vec<ThreadId>>>,
    }

    impl Drop for Guest {
        fn drop(&mut self) {
            self.drops.borrow_mut().push(std::thread::current().id());
        }
    }

    #[test]
    fn main_document_reload_drops_guest_on_callback_thread() {
        let generation = AtomicU64::new(0);
        let drops = Rc::new(RefCell::new(Vec::new()));
        let session = RefCell::new(vec![Guest {
            drops: drops.clone(),
        }]);

        reset_document("main", Started, &generation, &session);

        assert!(session.borrow().is_empty());
        assert_eq!(*drops.borrow(), vec![std::thread::current().id()]);
        assert_eq!(generation.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn guest_navigation_and_finished_loads_keep_the_session() {
        let generation = AtomicU64::new(7);
        let session = RefCell::new(vec!["current guest"]);

        for (label, event) in [("browser-content", Started), ("main", Finished)] {
            reset_document(label, event, &generation, &session);
            assert_eq!(*session.borrow(), vec!["current guest"]);
            assert_eq!(generation.load(Ordering::SeqCst), 7);
        }
    }

    #[test]
    fn reload_rejects_queued_attach_without_replacing_new_guest() {
        let generation = AtomicU64::new(0);
        let session = RefCell::new(vec!["old guest"]);
        let queued_generation = generation.load(Ordering::SeqCst);
        let created = Cell::new(false);
        let queued_attach = || {
            with_current_document(&generation, queued_generation, || {
                created.set(true);
                session.borrow_mut().push("stale guest");
                Ok(())
            })
        };

        reset_document("main", Started, &generation, &session);
        with_current_document(&generation, generation.load(Ordering::SeqCst), || {
            session.borrow_mut().push("new guest");
            Ok(())
        })
        .unwrap();

        assert_eq!(
            queued_attach().unwrap_err(),
            "Browser host document was reloaded"
        );
        assert!(!created.get());
        assert_eq!(*session.borrow(), vec!["new guest"]);
    }

    #[test]
    fn attach_before_reload_is_dropped_and_finished_keeps_replacement() {
        let generation = AtomicU64::new(0);
        let drops = Rc::new(RefCell::new(Vec::new()));
        let session = RefCell::new(Vec::new());
        let attach = |expected| {
            with_current_document(&generation, expected, || {
                session.borrow_mut().push(Guest {
                    drops: drops.clone(),
                });
                Ok(())
            })
        };

        attach(generation.load(Ordering::SeqCst)).unwrap();
        reset_document("main", Started, &generation, &session);
        assert_eq!(drops.borrow().len(), 1);
        attach(generation.load(Ordering::SeqCst)).unwrap();
        reset_document("main", Finished, &generation, &session);
        assert_eq!(session.borrow().len(), 1);
        assert_eq!(drops.borrow().len(), 1);
    }
}
