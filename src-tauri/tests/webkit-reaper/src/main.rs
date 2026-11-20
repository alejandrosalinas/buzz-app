#[cfg(target_os = "macos")]
#[path = "../../../src/webkit_reaper.rs"]
mod webkit_reaper;

#[cfg(target_os = "macos")]
fn main() {
    use std::ffi::{c_char, c_void, CString};

    use objc2::rc::Retained;
    use objc2_web_kit::WKWebViewConfiguration;

    extern "C" {
        fn storage_probe_configuration(root: *const c_char) -> *mut WKWebViewConfiguration;
        fn storage_probe_capture_begin();
        fn storage_probe_capture_end() -> *mut c_void;
        fn storage_probe_run(view: *mut c_void, timer: *mut c_void, root: *const c_char) -> i32;
    }

    let storage = tempfile::Builder::new()
        .prefix("buzz-webkit-reaper-test-")
        .tempdir()
        .expect("temporary WebKit storage");
    let root = CString::new(storage.path().to_str().expect("UTF-8 temporary path")).unwrap();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = "org.example.buzz.webkit-reaper-test".into();
    // This host loads only the watcher, not Buzz's services or identity startup.
    let app = tauri::Builder::default()
        .enable_macos_default_menu(false)
        .setup(move |app| {
            // SAFETY: the fixture retains its isolated configuration for this process.
            let configuration = unsafe {
                Retained::retain(storage_probe_configuration(root.as_ptr()))
                    .expect("WebKit supports the isolated storage fixture")
            };
            let view = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External("about:blank".parse().unwrap()),
            )
            .visible(false)
            .with_webview_configuration(configuration)
            .build()?;
            // SAFETY: these main-thread calls capture and restore NSTimer's factory.
            unsafe { storage_probe_capture_begin() };
            webkit_reaper::install(app.handle());
            let timer = unsafe { storage_probe_capture_end() } as usize;
            let handle = app.handle().clone();
            view.with_webview(move |platform| {
                // SAFETY: Tauri supplies a live WKWebView on the main thread.
                // The fixture keeps the captured timer alive through this call.
                let result = unsafe {
                    storage_probe_run(platform.inner().cast(), timer as *mut c_void, root.as_ptr())
                };
                handle.exit(result);
            })?;
            Ok(())
        })
        .build(context)
        .expect("isolated Tauri host");
    let result = app.run_return(|_, _| {});
    storage.close().expect("remove temporary WebKit storage");
    std::process::exit(result);
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("This regression check requires macOS and a graphical session.");
    std::process::exit(1);
}
