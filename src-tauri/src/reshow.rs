//! A closed main window comes back whenever Buzz becomes the active app.
//!
//! Closing the main window hides it (see the `CloseRequested` handler). AppKit
//! sends Reopen, which shows it again, only for Dock and Finder reopens;
//! Cmd-Tab, Spotlight and other app switches only activate the app, leaving
//! it with no window. This observer shows the window on those activations too.
//!
//! Only a window the person closed returns: the launch window stays hidden
//! until the page shows it, and a minimized window stays in the Dock.
use std::{
    ptr::NonNull,
    sync::atomic::{AtomicBool, Ordering},
};

use block2::RcBlock;
use objc2_app_kit::NSApplicationDidBecomeActiveNotification;
use objc2_foundation::{NSNotification, NSNotificationCenter};
use tauri::{AppHandle, Manager, Runtime};

static CLOSED: AtomicBool = AtomicBool::new(false);

/// Record that closing the main window hid it.
pub(crate) fn closed() {
    CLOSED.store(true, Ordering::Relaxed);
}

/// Each activation consumes the close, so a window shown since (Dock click,
/// deep link) and then minimized is not brought back by a later activation.
fn should_show(closed: &AtomicBool, visible: bool, minimized: bool) -> bool {
    closed.swap(false, Ordering::Relaxed) && !visible && !minimized
}

pub(crate) fn install<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let handler = RcBlock::new(move |_: NonNull<NSNotification>| {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if !should_show(
            &CLOSED,
            window.is_visible().unwrap_or(true),
            window.is_minimized().unwrap_or(true),
        ) {
            return;
        }
        if let Err(error) = crate::notifications::focus(&window) {
            eprintln!("Could not show the Buzz window: {error}");
        }
    });
    // With no queue, AppKit runs the block on the main thread that posts the
    // activation, where window calls are safe.
    let token = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSApplicationDidBecomeActiveNotification),
            None,
            None,
            &handler,
        )
    };
    // The observer lives for the whole app.
    std::mem::forget(token);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_first_activation_after_a_close_shows_the_window() {
        let closed = AtomicBool::new(false);
        // Launch: the page has not shown the window yet.
        assert!(!should_show(&closed, false, false));

        closed.store(true, Ordering::Relaxed);
        assert!(should_show(&closed, false, false));
        assert!(!should_show(&closed, false, false));

        // Already back from a Dock click or deep link, then minimized later.
        closed.store(true, Ordering::Relaxed);
        assert!(!should_show(&closed, true, false));
        assert!(!should_show(&closed, false, true));

        // Minimized windows stay in the Dock, as Cmd-Tab leaves them elsewhere.
        closed.store(true, Ordering::Relaxed);
        assert!(!should_show(&closed, false, true));
        assert!(!closed.load(Ordering::Relaxed));
    }
}
