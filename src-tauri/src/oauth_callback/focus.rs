//! Attempt-scoped, best-effort return from the sign-in browser after verification.
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tokio::time::{sleep_until, Duration, Instant};

pub(super) const READABLE_DELAY: Duration = Duration::from_secs(3);
const RETURN_WINDOW: Duration = Duration::from_secs(10);

struct Pending {
    id: String,
    browser: String,
    ready: Option<Instant>,
}

#[derive(Clone, Default)]
pub(super) struct FocusReturn(Arc<Mutex<Option<Pending>>>);

impl FocusReturn {
    pub(super) fn arm(&self, id: &str, browser: Option<String>) {
        if let Ok(mut pending) = self.0.lock() {
            *pending = browser.map(|browser| Pending {
                id: id.into(),
                browser,
                ready: None,
            });
        }
    }

    pub(super) fn cancel(&self, id: Option<&str>) {
        if let Ok(mut pending) = self.0.lock() {
            if id.is_none() || pending.as_ref().is_some_and(|p| Some(p.id.as_str()) == id) {
                pending.take();
            }
        }
    }

    pub(super) fn received(&self, id: &str, success: bool) {
        if !success {
            self.cancel(Some(id));
        } else if let Ok(mut pending) = self.0.lock() {
            if let Some(p) = pending.as_mut().filter(|p| p.id == id) {
                p.ready = Some(Instant::now() + READABLE_DELAY);
            }
        }
    }

    pub(super) fn deadline(&self, id: &str) -> Option<Instant> {
        self.0.lock().ok()?.as_ref().filter(|p| p.id == id)?.ready
    }

    fn take(&self, id: &str) -> Option<String> {
        let mut pending = self.0.lock().ok()?;
        let ready = pending.as_ref().filter(|p| p.id == id)?.ready?;
        let now = Instant::now();
        if now < ready {
            return None;
        }
        let browser = pending.take()?.browser;
        (now <= ready + RETURN_WINDOW).then_some(browser)
    }

    pub(super) async fn complete<R: tauri::Runtime>(&self, app: tauri::AppHandle<R>, id: String) {
        let Some(deadline) = self.deadline(&id) else {
            return;
        };
        sleep_until(deadline).await;
        let focus = self.clone();
        let handle = app.clone();
        let (done, wait) = tokio::sync::oneshot::channel();
        if app
            .run_on_main_thread(move || {
                if let Some(browser) = focus.take(&id) {
                    if let Some(window) = handle.get_webview_window("main") {
                        if browser_is_foreground(&browser)
                            && window.is_visible().unwrap_or(false)
                            && !window.is_minimized().unwrap_or(true)
                        {
                            let _ = crate::notifications::focus(&window);
                        }
                    }
                }
                let _ = done.send(());
            })
            .is_ok()
        {
            let _ = wait.await;
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn capture<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &str) -> Option<String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    if !app
        .get_webview_window("main")?
        .is_focused()
        .unwrap_or(false)
    {
        return None;
    }
    let url = NSURL::URLWithString(&NSString::from_str(url))?;
    Some(
        NSWorkspace::sharedWorkspace()
            .URLForApplicationToOpenURL(&url)?
            .absoluteString()?
            .to_string(),
    )
}

#[cfg(target_os = "macos")]
fn browser_is_foreground(browser: &str) -> bool {
    objc2_app_kit::NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .and_then(|app| app.bundleURL())
        .and_then(|url| url.absoluteString())
        .is_some_and(|url| url.to_string() == browser)
}

// Without a reliable foreground-browser check, completion must not activate Buzz.
#[cfg(not(target_os = "macos"))]
pub(crate) fn capture<R: tauri::Runtime>(_: &tauri::AppHandle<R>, _: &str) -> Option<String> {
    None
}
#[cfg(not(target_os = "macos"))]
fn browser_is_foreground(_: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn return_requires_callback_readable_delay_and_is_single_use() {
        let focus = FocusReturn::default();
        focus.arm("a", Some("browser".into()));
        assert!(focus.deadline("a").is_none());
        assert!(focus.take("a").is_none());
        focus.received("a", true);
        assert!(focus.take("a").is_none());
        tokio::time::advance(READABLE_DELAY).await;
        assert_eq!(focus.take("a"), Some("browser".into()));
        assert!(focus.take("a").is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_reload_error_and_replacement_retire_focus_permission() {
        let focus = FocusReturn::default();
        for cancel in [Some("a"), None] {
            focus.arm("a", Some("browser".into()));
            focus.received("a", true);
            focus.cancel(cancel);
            tokio::time::advance(READABLE_DELAY).await;
            assert!(focus.take("a").is_none());
        }
        focus.arm("a", Some("browser".into()));
        focus.received("a", false);
        assert!(focus.deadline("a").is_none());
        focus.arm("b", Some("new-browser".into()));
        focus.cancel(Some("a"));
        focus.received("a", true);
        assert!(focus.deadline("b").is_none());
        focus.received("b", true);
        tokio::time::advance(READABLE_DELAY).await;
        assert!(focus.take("a").is_none());
        assert_eq!(focus.take("b"), Some("new-browser".into()));
        focus.arm("c", None);
        focus.received("c", true);
        assert!(focus.deadline("c").is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn slow_verification_cannot_restore_focus_long_after_the_browser_handoff() {
        let focus = FocusReturn::default();
        focus.arm("a", Some("browser".into()));
        focus.received("a", true);
        tokio::time::advance(READABLE_DELAY + RETURN_WINDOW + Duration::from_millis(1)).await;
        assert!(focus.take("a").is_none());
        assert!(focus.deadline("a").is_none());
    }
}
