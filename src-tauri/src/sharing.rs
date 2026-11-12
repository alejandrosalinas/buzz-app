//! Native sharing for the invite QR image. No files or clipboard state are changed.
#[cfg(target_os = "macos")]
use tauri::Manager as _;

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri passes each IPC field as an argument.
pub(crate) async fn share_image<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    png: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Main window required".into());
    }
    #[cfg(target_os = "macos")]
    {
        let image = validate(&png, &url, [x, y, width, height])?;
        let (send, receive) = tokio::sync::oneshot::channel();
        let app = window.app_handle().clone();
        app.run_on_main_thread(move || {
            let _ = send.send(macos::show(&window, &image, &url, [x, y, width, height]));
        })
        .map_err(|_| "Could not open sharing".to_owned())?;
        receive
            .await
            .map_err(|_| "Could not open sharing".to_owned())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (png, url, x, y, width, height);
        Err("Image sharing is not available on this platform".into())
    }
}

#[cfg(any(target_os = "macos", test))]
fn validate(png: &str, url: &str, rect: [f64; 4]) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let invalid = || "Invalid image sharing request".to_owned();
    if png.len() > 1_400_000
        || url.len() > 4096
        || rect
            .iter()
            .any(|value| !value.is_finite() || value.abs() > 100_000.0)
        || rect[2] <= 0.0
        || rect[3] <= 0.0
    {
        return Err(invalid());
    }
    let parsed = url::Url::parse(url).map_err(|_| invalid())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(invalid());
    }
    let bytes = STANDARD.decode(png).map_err(|_| invalid())?;
    let reader =
        image::ImageReader::with_format(std::io::Cursor::new(&bytes), image::ImageFormat::Png);
    let (width, height) = reader.into_dimensions().map_err(|_| invalid())?;
    if width != 720 || height != 720 {
        return Err(invalid());
    }
    Ok(bytes)
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::{rc::Retained, runtime::AnyObject, AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSImage, NSSharingServicePicker, NSView};
    use objc2_foundation::{NSArray, NSData, NSPoint, NSRect, NSRectEdge, NSSize, NSString, NSURL};
    use std::cell::RefCell;

    // AppKit presents asynchronously. Retain one bounded picker on the main
    // thread until the next invocation; replacing it closes the previous menu.
    thread_local! {
        static PICKER: RefCell<Option<Retained<NSSharingServicePicker>>> = const { RefCell::new(None) };
    }

    pub(super) fn show<R: tauri::Runtime>(
        window: &tauri::WebviewWindow<R>,
        png: &[u8],
        url: &str,
        rect: [f64; 4],
    ) -> Result<(), String> {
        let _mtm = MainThreadMarker::new().ok_or("Sharing requires the main thread")?;
        let image = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(png))
            .ok_or("Could not create the shared image")?;
        let link = NSURL::URLWithString(&NSString::from_str(url)).ok_or("Invalid share link")?;
        let items = NSArray::<AnyObject>::from_slice(&[image.as_ref(), link.as_ref()]);
        // NSImage and NSURL both implement NSPasteboardWriting, as required.
        let picker = unsafe {
            NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &items)
        };
        let native = window
            .ns_view()
            .map_err(|_| "Could not find the sharing window")?;
        // Tauri owns this NSView; it stays alive for the synchronous presentation.
        let view: &NSView = unsafe { &*native.cast() };
        let [x, y, width, height] = rect;
        let y = if view.isFlipped() {
            y
        } else {
            view.bounds().size.height - y - height
        };
        let anchor = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
        PICKER.with(|stored| {
            if let Some(previous) = stored.borrow_mut().take() {
                previous.close();
            }
            picker.showRelativeToRect_ofView_preferredEdge(anchor, view, NSRectEdge::MaxY);
            *stored.borrow_mut() = Some(picker);
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::validate;
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    fn png(width: u32, height: u32) -> String {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(width, height)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        STANDARD.encode(bytes.into_inner())
    }

    #[test]
    fn accepts_bounded_png_and_web_link() {
        assert!(validate(
            &png(720, 720),
            "https://example.org/invite/abc",
            [10.0, 20.0, 70.0, 30.0]
        )
        .is_ok());
    }

    #[test]
    fn refuses_invalid_image_links_and_coordinates() {
        let image = png(720, 720);
        let rect = [10.0, 20.0, 70.0, 30.0];
        assert!(validate(&image, "file:///private/file", rect).is_err());
        assert!(validate(&image, "https://example.org", [f64::NAN, 0.0, 1.0, 1.0]).is_err());
        assert!(validate(&image, "https://example.org", [0.0, 0.0, 0.0, 1.0]).is_err());
        assert!(validate("not an image", "https://example.org", rect).is_err());
        assert!(validate(&png(1, 1), "https://example.org", rect).is_err());
        assert!(validate(&"A".repeat(1_400_001), "https://example.org", rect).is_err());
    }
}
