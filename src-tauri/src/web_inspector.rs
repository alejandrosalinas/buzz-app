#[tauri::command]
pub(crate) async fn web_inspector<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    enabled: Option<bool>,
) -> Result<Option<bool>, String> {
    if webview.label() != "main" {
        return Err("Web Inspector is available only for the main window".into());
    }

    #[cfg(not(all(target_os = "macos", not(debug_assertions))))]
    let inspectable = None;
    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    let inspectable = {
        use objc2::{runtime::NSObject, sel};
        use objc2_foundation::NSObjectProtocol;
        use objc2_web_kit::WKWebView;
        use tauri::Manager;

        let version = &webview.app_handle().package_info().version;
        if version
            .pre
            .as_str()
            .strip_prefix("beta.")
            .is_some_and(|number| {
                !number.is_empty()
                    && !number.starts_with('0')
                    && number.bytes().all(|b| b.is_ascii_digit())
            })
        {
            let (send, receive) = tokio::sync::oneshot::channel();
            webview
                .with_webview(move |platform| {
                    // SAFETY: Wry supplies a WKWebView on the UI thread. Check for the
                    // macOS 13.3 API because Buzz also runs on earlier versions.
                    let view = unsafe { &*platform.inner().cast::<WKWebView>() };
                    let value =
                        NSObject::respondsToSelector(view, sel!(setInspectable:)).then(|| unsafe {
                            if let Some(enabled) = enabled {
                                view.setInspectable(enabled);
                            }
                            view.isInspectable()
                        });
                    let _ = send.send(value);
                })
                .map_err(|error| error.to_string())?;
            receive.await.map_err(|error| error.to_string())?
        } else {
            None
        }
    };
    if enabled.is_some() && inspectable.is_none() {
        return Err("Web Inspector is unavailable in this build".into());
    }
    Ok(inspectable)
}
