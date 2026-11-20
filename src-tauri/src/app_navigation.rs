//! Keeps Buzz's own webviews on the app.
//!
//! A website link the page leaves unhandled, such as a plain or ⌘-click on a
//! link without `target="_blank"` (the opener's click script skips both),
//! would otherwise replace the whole app with that website and leave no way
//! back. Such navigations open in the system browser instead. Buzz Browser
//! guests are plain Wry webviews outside Tauri's plugin hooks, so they keep
//! their own navigation policy.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use url::Url;

pub(crate) fn init<R: tauri::Runtime>() -> TauriPlugin<R> {
    Builder::new("app-navigation")
        .on_navigation(|webview, url| {
            // Packaged builds keep `devUrl` in their config but never load it.
            let development = webview
                .config()
                .build
                .dev_url
                .as_ref()
                .filter(|_| tauri::is_dev());
            if stays_in_app(url, development) {
                return true;
            }
            if let Err(error) = webview.opener().open_url(url.as_str(), None::<&str>) {
                eprintln!("Could not open a website link in the browser: {error}");
            }
            false
        })
        .build()
}

/// Whether `url` may load in an app webview. Websites may not; other schemes
/// (the app's own, `about:`, `blob:`) keep the platform's handling.
fn stays_in_app(url: &Url, development: Option<&Url>) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return true;
    }
    // Windows serves the app from `http(s)://tauri.localhost`.
    (url.host_str() == Some("tauri.localhost") && url.port().is_none())
        || development.is_some_and(|development| development.origin() == url.origin())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_app_pages_load_in_app_webviews() {
        let development = Url::parse("http://localhost:1430").unwrap();
        for (url, development, expected) in [
            ("tauri://localhost/", None, true),
            ("tauri://localhost/huddle.html", None, true),
            ("http://tauri.localhost/compute-widget.html", None, true),
            ("https://tauri.localhost/", None, true),
            ("http://localhost:1430/channels", Some(&development), true),
            ("about:blank", None, true),
            ("blob:tauri://localhost/0b6c8d5e", None, true),
            ("mailto:someone@example.org", None, true),
            ("https://github.com/example-org/example/pull/1", None, false),
            ("http://example.org/", None, false),
            ("http://tauri.localhost.example.org/", None, false),
            ("http://tauri.localhost:8080/", None, false),
            ("http://127.0.0.1:1430/", Some(&development), false),
            ("http://localhost:1431/", Some(&development), false),
            // Packaged builds pass no development URL.
            ("http://localhost:1430/", None, false),
        ] {
            let parsed = Url::parse(url).unwrap();
            assert_eq!(stays_in_app(&parsed, development), expected, "{url}");
        }
    }
}
