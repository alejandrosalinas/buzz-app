//! Cmd+W closes the active tab, or the window when no tab handles the request.
//! Cmd+Shift+W only clears the current channel's tabs.
//! The red button still closes the window directly.
//! Edit → Paste and Match Style (Cmd+Shift+V) pastes the clipboard as plain text.
//! Buzz → Settings… runs the app's Open Settings shortcut. It has no native
//! accelerator, so Cmd+, keeps the web shortcut's rebinding and IME rules.
//! Ctrl+Tab bypasses macOS menu highlighting latency. Menu commands and the
//! native key handler both work while a raw guest webview owns keyboard focus.
use std::{cell::RefCell, ptr::NonNull};

use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject, sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSEvent, NSEventMask, NSEventModifierFlags};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, WINDOW_SUBMENU_ID},
    AppHandle, Manager, Runtime,
};

const CLOSE: &str = "buzz-close";
const CLOSE_ALL: &str = "buzz-close-all";
const NEXT: &str = "buzz-next-tab";
const PREVIOUS: &str = "buzz-previous-tab";
const PASTE_PLAIN: &str = "buzz-paste-plain";
const SETTINGS: &str = "buzz-settings";
// The focused composer marks the paste that follows as raw, whether or not a
// key fired. A focused guest browser takes the paste itself.
const PASTE_PLAIN_REQUEST: &str = "if (browserSessionId === null) document.activeElement?.dispatchEvent(new Event(\"buzz:paste-plain\"));";
const REQUEST: &str = include_str!("close-request.js");
const SWITCH: &str = include_str!("switch-tab-request.js");

pub(crate) fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let close = MenuItem::with_id(app, CLOSE, "Close", true, Some("CmdOrCtrl+W"))?;
    let close_all = MenuItem::with_id(
        app,
        CLOSE_ALL,
        "Close All Tabs",
        true,
        Some("CmdOrCtrl+Shift+W"),
    )?;
    // Tauri's default has Close Window in both File and Window. Preserve all
    // other native items (especially editing/services), replacing both routes.
    // Predefined items expose their label, but not their native action type.
    // A detached item reports its label with its mnemonic (`C&lose Window`),
    // one in a menu its native title (`Close Window`).
    let close_label = PredefinedMenuItem::close_window(app, None)?
        .text()?
        .replace('&', "");
    // Tauri has no predefined Paste and Match Style. Cmd+Shift+V is the
    // chord Slack and Google Docs use for pasting without formatting.
    let paste_plain = MenuItem::with_id(
        app,
        PASTE_PLAIN,
        "Paste and Match Style",
        true,
        Some("CmdOrCtrl+Shift+V"),
    )?;
    let paste_label = PredefinedMenuItem::paste(app, None)?
        .text()?
        .replace('&', "");
    let mut replaced = 0;
    for item in menu.items()? {
        if let Some(submenu) = item.as_submenu() {
            for (index, item) in submenu.items()?.iter().enumerate() {
                if let Some(predefined) = item.as_predefined_menuitem() {
                    let label = predefined.text()?.replace('&', "");
                    if label == close_label {
                        submenu.remove(item)?;
                        submenu.insert(&close, index)?;
                        submenu.insert(&close_all, index + 1)?;
                        replaced += 1;
                    } else if label == paste_label {
                        submenu.insert(&paste_plain, index + 1)?;
                    }
                }
            }
        }
    }
    debug_assert_eq!(replaced, 2, "Tauri default Close menu structure changed");
    // The app menu opens with About and a separator; Settings follows them, as
    // in other Mac apps.
    if let Some(app_menu) = menu.items()?.first().and_then(|item| item.as_submenu()) {
        app_menu.insert_items(
            &[
                &MenuItem::with_id(app, SETTINGS, "Settings…", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
            ],
            2,
        )?;
    }
    if let Some(window) = menu.get(WINDOW_SUBMENU_ID) {
        if let Some(window) = window.as_submenu() {
            window.append_items(&[
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, NEXT, "Show Next Tab", true, Some("Ctrl+Tab"))?,
                &MenuItem::with_id(
                    app,
                    PREVIOUS,
                    "Show Previous Tab",
                    true,
                    Some("Ctrl+Shift+Tab"),
                )?,
            ])?;
        }
    }
    install_tab_keys(app);
    Ok(menu)
}

pub(crate) fn handle<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let script = match event.id().as_ref() {
        CLOSE => format!("{{ const tabEvent = \"buzz:close-active-tab\";\n{REQUEST}}}"),
        CLOSE_ALL => format!("{{ const tabEvent = \"buzz:close-all-tabs\";\n{REQUEST}}}"),
        // A block keeps the binding out of the page's global scope.
        NEXT => format!("{{ const tabEvent = \"buzz:next-tab\";\n{SWITCH}}}"),
        PREVIOUS => format!("{{ const tabEvent = \"buzz:previous-tab\";\n{SWITCH}}}"),
        SETTINGS => return open_settings(app),
        PASTE_PLAIN => {
            // On the UI thread the script is sent to the page at once, so it
            // runs before the paste command that follows it.
            send_request(app, PASTE_PLAIN_REQUEST);
            return paste_plain();
        }
        _ => return,
    };
    dispatch_request(app, &script, event.id().as_ref());
}

// Unlike a tab request, Settings brings back a hidden or minimized window, as
// the red button only hides it.
fn open_settings<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(error) = crate::notifications::focus(&window) {
        eprintln!("Could not show Buzz for Settings: {error}");
    }
    if let Err(error) = window.eval("window.dispatchEvent(new Event(\"buzz:open-settings\"));") {
        eprintln!("Could not send Buzz request: {error}");
    }
}

// As a native Paste and Match Style item does: the focused web view, main or
// guest, fires a paste event holding only the clipboard's plain text.
fn paste_plain() {
    let Some(marker) = MainThreadMarker::new() else {
        return;
    };
    // A nil target walks the key window's responder chain; none may answer.
    unsafe {
        NSApplication::sharedApplication(marker).sendAction_to_from(
            sel!(pasteAsPlainText:),
            None,
            None,
        )
    };
}

pub(crate) fn send_request<R: Runtime>(app: &AppHandle<R>, script: &str) -> bool {
    dispatch_request(app, script, "")
}

fn closes_window(action: &str, result: &str) -> bool {
    action == CLOSE && result == r#""unhandled""#
}

fn dispatch_request<R: Runtime>(app: &AppHandle<R>, script: &str, action: &str) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    // Unlike a predefined Close item, custom menu items stay enabled without
    // a key window. Never consume a retained tab in a hidden/background window.
    if !window.is_visible().unwrap_or(false)
        || window.is_minimized().unwrap_or(true)
        || !window.is_focused().unwrap_or(false)
    {
        return false;
    }
    // Evaluate only in the trusted main view, even when a raw guest webview
    // owns keyboard focus.
    let browser = serde_json::to_string(&crate::browser::focused_session())
        .expect("Browser session IDs are JSON strings");
    let script = format!("{{ const browserSessionId = {browser};\n{script}\n}}");
    let result = if action == CLOSE {
        let target = window.clone();
        window.eval_with_callback(script, move |result| {
            // Evaluation failures and handled tab/modal requests must never
            // cause a second, window-level close. Recheck focus after the reply.
            if closes_window(CLOSE, &result)
                && target.is_visible().unwrap_or(false)
                && !target.is_minimized().unwrap_or(true)
                && target.is_focused().unwrap_or(false)
            {
                if let Err(error) = target.close() {
                    eprintln!("Could not close Buzz window: {error}");
                }
            }
        })
    } else {
        window.eval(script)
    };
    if let Err(error) = result {
        eprintln!("Could not send Buzz request: {error}");
        return false;
    }
    true
}

struct TabKeys(Retained<AnyObject>);
impl Drop for TabKeys {
    fn drop(&mut self) {
        // This token came from addLocalMonitor; creation and drop stay on the UI thread.
        unsafe { NSEvent::removeMonitor(&self.0) };
    }
}
thread_local! {
    static TAB_KEYS: RefCell<Option<TabKeys>> = const { RefCell::new(None) };
}

fn tab_key(key: u16, modifiers: NSEventModifierFlags) -> Option<&'static str> {
    if key != 48
        || !modifiers.contains(NSEventModifierFlags::Control)
        || modifiers.intersects(NSEventModifierFlags::Command | NSEventModifierFlags::Option)
    {
        return None;
    }
    Some(if modifiers.contains(NSEventModifierFlags::Shift) {
        "buzz:previous-tab"
    } else {
        "buzz:next-tab"
    })
}

// Tauri constructs the menu on the UI thread. Monitor before AppKit performs
// menu key equivalents: its highlight flash otherwise delays successive actions.
fn install_tab_keys<R: Runtime>(app: &AppHandle<R>) {
    TAB_KEYS.with(|slot| {
        if slot.borrow().is_some() {
            return;
        }
        let app = app.clone();
        let handler = RcBlock::new(move |event: NonNull<NSEvent>| {
            // AppKit supplies a live event for the duration of this callback.
            let key = unsafe { event.as_ref() };
            let Some(name) = tab_key(key.keyCode(), key.modifierFlags()) else {
                return event.as_ptr();
            };
            let script = format!("{{ const tabEvent = \"{name}\";\n{SWITCH}}}");
            if send_request(&app, &script) {
                std::ptr::null_mut()
            } else {
                event.as_ptr()
            }
        });
        // The callback returns only the original event or null to consume it.
        let token = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler)
        };
        if let Some(token) = token {
            *slot.borrow_mut() = Some(TabKeys(token));
        } else {
            eprintln!("Could not install Buzz tab keys; using menu accelerators");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_unhandled_close_falls_back_to_the_window() {
        assert!(closes_window(CLOSE, r#""unhandled""#));
        for result in [
            r#""handled""#,
            "null",
            "",
            "unhandled",
            r#"{"error":"failed"}"#,
        ] {
            assert!(!closes_window(CLOSE, result));
        }
        for action in [CLOSE_ALL, NEXT, PREVIOUS, PASTE_PLAIN, ""] {
            assert!(!closes_window(action, r#""unhandled""#));
        }
    }

    #[test]
    fn tab_keys_preserve_direction_and_leave_other_chords_to_appkit() {
        let control = NSEventModifierFlags::Control;
        assert_eq!(tab_key(48, control), Some("buzz:next-tab"));
        assert_eq!(
            tab_key(48, control | NSEventModifierFlags::Shift),
            Some("buzz:previous-tab")
        );
        assert_eq!(
            tab_key(48, control | NSEventModifierFlags::CapsLock),
            Some("buzz:next-tab")
        );
        for modifiers in [
            NSEventModifierFlags::empty(),
            NSEventModifierFlags::Shift,
            control | NSEventModifierFlags::Command,
            control | NSEventModifierFlags::Option,
        ] {
            assert_eq!(tab_key(48, modifiers), None);
        }
        assert_eq!(tab_key(49, control), None);
    }
}
