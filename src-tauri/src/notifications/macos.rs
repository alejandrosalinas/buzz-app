//! One process-lifetime notification delegate owns click routing. Submission
//! completion only reports errors; it does not prove a notification was displayed.
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, OnceLock},
};

use block2::{Block, RcBlock};
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{NSObjectProtocol, ProtocolObject},
    AnyThread, DefinedClass,
};
use objc2_foundation::{NSArray, NSError, NSObject, NSString};
use objc2_user_notifications::{
    UNAuthorizationStatus, UNMutableNotificationContent, UNNotificationDefaultActionIdentifier,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

use super::{Outcome, Pending};

static REGISTRY: OnceLock<Arc<Registry>> = OnceLock::new();
static ADMISSION: Mutex<()> = Mutex::new(());
pub(super) fn admission_lock() -> &'static Mutex<()> {
    &ADMISSION
}

#[derive(Default)]
struct Registry(Mutex<Entries>);
#[derive(Default)]
struct Entries {
    active: HashMap<String, Arc<Pending>>,
    order: VecDeque<String>,
}

impl Registry {
    fn insert(&self, id: String, pending: Arc<Pending>) -> Result<(), String> {
        if let Ok(mut entries) = self.0.lock() {
            if entries.active.contains_key(&id) {
                return Err("Duplicate desktop notification".into());
            }
            entries.order.push_back(id.clone());
            entries.active.insert(id, pending);
            Ok(())
        } else {
            Err("Notification state unavailable".into())
        }
    }
    fn finish(&self, id: &str, outcome: Outcome) {
        let pending = self.0.lock().ok().and_then(|mut entries| {
            entries.order.retain(|current| current != id);
            entries.active.remove(id)
        });
        if let Some(pending) = pending {
            pending.finish(outcome);
        }
    }
    fn contains(&self, id: &str) -> bool {
        self.0
            .lock()
            .is_ok_and(|entries| entries.active.contains_key(id))
    }
    fn retire_oldest(&self, withdraw: impl FnOnce(&str)) -> Option<String> {
        let retired = self.0.lock().ok().and_then(|mut entries| {
            let id = entries.order.pop_front()?;
            entries.active.remove(&id).map(|pending| (id, pending))
        });
        let (id, pending) = retired?;
        withdraw(&id);
        pending.finish(Outcome::Closed);
        Some(id)
    }
}

pub(super) fn contains(id: &str) -> bool {
    REGISTRY.get().is_some_and(|registry| registry.contains(id))
}

pub(super) fn make_room(count: &super::Notifications) -> Option<String> {
    if !crate::dock::bundled() {
        return None;
    }
    let registry = REGISTRY.get()?;
    if count
        .0
        .lock()
        .is_ok_and(|count| *count >= super::MAX_ACTIVE)
    {
        // Some OS removals have no dismiss callback. Withdraw at capacity so
        // both native and frontend can discard the oldest click target.
        return registry.retire_oldest(|id| {
            let identifiers = NSArray::from_retained_slice(&[NSString::from_str(id)]);
            let center = UNUserNotificationCenter::currentNotificationCenter();
            center.removeDeliveredNotificationsWithIdentifiers(&identifiers);
            center.removePendingNotificationRequestsWithIdentifiers(&identifiers);
        });
    }
    None
}

/// How a notification is presented while Buzz is the active application.
/// `Banner` interrupts, `List` keeps the Notification Center entry so a missed
/// banner stays reachable. `Sound` and `Badge` are deliberately absent: alert
/// audio is app-owned (the renderer plays the chosen sound, and submissions are
/// always silent so the OS cannot play a second one), and the Dock badge is
/// projected from unread state rather than individual notifications.
fn foreground_presentation() -> UNNotificationPresentationOptions {
    UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List
}

struct DelegateIvars {
    registry: Arc<Registry>,
}

define_class!(
    // SAFETY: NSObject permits AnyThread subclasses. Registry is synchronized,
    // and Apple's delegate callback queue is unspecified.
    #[unsafe(super(NSObject))]
    #[name = "BuzzFoundationNotificationDelegate"]
    #[thread_kind = AnyThread]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present_notification(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &objc2_user_notifications::UNNotification,
            completion: &Block<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            // The frontend's notification policy already decided this alert is
            // worth interrupting for: it drops candidates for the conversation
            // in view unless Notify while viewing is on, and applies the
            // read/mute/category gates. Suppressing the banner here would
            // overrule that decision and leave Notify while viewing with no
            // visible effect on macOS. Sound stays app-owned, so the banner is
            // presented silently and the renderer plays the chosen alert.
            completion.call((foreground_presentation(),));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive_response(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &Block<dyn Fn()>,
        ) {
            let id = response.notification().request().identifier().to_string();
            let outcome = if &*response.actionIdentifier()
                == unsafe { UNNotificationDefaultActionIdentifier }
            {
                Outcome::Activated
            } else {
                Outcome::Closed
            };
            self.ivars().registry.finish(&id, outcome);
            // Required for every response, including unknown/old requests.
            completion.call(());
        }
    }
);

impl Delegate {
    fn new(registry: Arc<Registry>) -> Retained<Self> {
        let delegate = Self::alloc().set_ivars(DelegateIvars { registry });
        unsafe { msg_send![super(delegate), init] }
    }
}

/// Install once during setup. UNUserNotificationCenter.delegate is weak.
pub(crate) fn init() {
    if !crate::dock::bundled() {
        return;
    }
    REGISTRY.get_or_init(|| {
        let registry = Arc::new(Registry::default());
        let delegate: Retained<ProtocolObject<dyn UNUserNotificationCenterDelegate>> =
            ProtocolObject::from_retained(Delegate::new(registry.clone()));
        UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(&delegate));
        std::mem::forget(delegate);
        registry
    });
}

pub(super) fn show(id: String, title: String, body: String, pending: Arc<Pending>) {
    if !crate::dock::bundled() {
        pending.finish(Outcome::Failed(
            "macOS notifications are unavailable when Buzz is not running from an app bundle"
                .into(),
        ));
        return;
    }
    let Some(registry) = REGISTRY.get().cloned() else {
        pending.finish(Outcome::Failed(
            "macOS notification delegate unavailable".into(),
        ));
        return;
    };
    if let Err(error) = registry.insert(id.clone(), pending.clone()) {
        pending.finish(Outcome::Failed(error));
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        match notification_permission() {
            Ok(Permission::Granted) => {}
            Ok(permission) => {
                registry.finish(&id, Outcome::Failed(permission_error(permission)));
                return;
            }
            Err(error) => {
                registry.finish(&id, Outcome::Failed(error));
                return;
            }
        }
        if !registry.contains(&id) {
            return;
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&title));
        content.setBody(&NSString::from_str(&body));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&id),
            &content,
            None,
        );
        let callback_registry = registry.clone();
        let callback_id = id.clone();
        let completion = RcBlock::new(move |error: *mut NSError| {
            if let Some(error) = unsafe { error.as_ref() } {
                callback_registry.finish(&callback_id, Outcome::Failed(submission_error(error)));
            }
            // A successful submission remains registered for a later click.
        });
        let Ok(_admission) = admission_lock().lock() else {
            registry.finish(
                &id,
                Outcome::Failed("Notification state unavailable".into()),
            );
            return;
        };
        if registry.contains(&id) {
            UNUserNotificationCenter::currentNotificationCenter()
                .addNotificationRequest_withCompletionHandler(&request, Some(&completion));
        }
    });
}

const NOTIFICATIONS_NOT_ALLOWED: &str = "macOS did not allow this app to send notifications. Enable Buzz in System Settings → Notifications. Development builds also need a stable Code Signing certificate configured as BUZZ_DEV_SIGNING_IDENTITY.";

fn permission_error(permission: Permission) -> String {
    match permission {
        Permission::Denied => NOTIFICATIONS_NOT_ALLOWED.into(),
        _ => "macOS notification permission is not granted".into(),
    }
}

fn submission_error(error: &NSError) -> String {
    submission_error_message(error.code(), &error.to_string())
}

fn submission_error_message(code: isize, detail: &str) -> String {
    // This callback is specified to return UNErrorDomain values.
    if code == objc2_user_notifications::UNErrorCode::NotificationsNotAllowed.0 {
        NOTIFICATIONS_NOT_ALLOWED.into()
    } else {
        format!("failed to submit macOS notification: {detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unbundled_process_never_initializes_center() {
        assert!(!crate::dock::bundled());
        init();
        assert!(REGISTRY.get().is_none());
    }
    #[test]
    fn notification_not_allowed_has_actionable_setup_copy() {
        assert_eq!(
            permission_error(Permission::Denied),
            NOTIFICATIONS_NOT_ALLOWED
        );
        assert_eq!(
            permission_error(Permission::Default),
            "macOS notification permission is not granted",
        );
        assert_eq!(
            submission_error_message(
                objc2_user_notifications::UNErrorCode::NotificationsNotAllowed.0,
                "The operation couldn’t be completed. (UNErrorDomain error 1.)",
            ),
            "macOS did not allow this app to send notifications. Enable Buzz in System Settings → Notifications. Development builds also need a stable Code Signing certificate configured as BUZZ_DEV_SIGNING_IDENTITY.",
        );
        assert_eq!(
            submission_error_message(1400, "native detail"),
            "failed to submit macOS notification: native detail",
        );
    }
    #[test]
    fn unsuccessful_submission_reports_failure_without_click() {
        let registry = Registry::default();
        let notifications = super::super::Notifications::default();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let output = seen.clone();
        registry
            .insert(
                "failed".into(),
                notifications
                    .reserve(Box::new(move |outcome| {
                        output.lock().unwrap().push(outcome);
                    }))
                    .unwrap(),
            )
            .unwrap();
        registry.finish("failed", Outcome::Failed("native error".into()));
        registry.finish("failed", Outcome::Activated);
        assert_eq!(
            *seen.lock().unwrap(),
            vec![Outcome::Failed("native error".into())]
        );
        assert_eq!(*notifications.0.lock().unwrap(), 0);
    }
    #[test]
    fn never_clicked_requests_retire_at_capacity_and_keep_newer_clicks() {
        let registry = Registry::default();
        let notifications = super::super::Notifications::default();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut withdrawn = Vec::new();
        for index in 0..129 {
            if *notifications.0.lock().unwrap() == super::super::MAX_ACTIVE {
                assert_eq!(
                    registry.retire_oldest(|id| withdrawn.push(id.to_owned())),
                    Some((index - 128).to_string())
                );
            }
            let seen = seen.clone();
            registry
                .insert(
                    index.to_string(),
                    notifications
                        .reserve(Box::new(move |outcome| {
                            seen.lock().unwrap().push((index, outcome));
                        }))
                        .unwrap(),
                )
                .unwrap();
        }
        assert_eq!(withdrawn, vec!["0"]);
        registry.finish("0", Outcome::Activated);
        registry.finish("128", Outcome::Activated);
        assert_eq!(
            *seen.lock().unwrap(),
            vec![(0, Outcome::Closed), (128, Outcome::Activated)]
        );
        assert_eq!(*notifications.0.lock().unwrap(), 127);
        for index in 1..128 {
            registry.finish(&index.to_string(), Outcome::Closed);
        }
        assert_eq!(*notifications.0.lock().unwrap(), 0);
    }
    #[test]
    fn repeated_unanswered_requests_never_exhaust_capacity() {
        let registry = Registry::default();
        let notifications = super::super::Notifications::default();
        let retired = Arc::new(Mutex::new(0));
        for index in 0..(super::super::MAX_ACTIVE * 3) {
            if *notifications.0.lock().unwrap() == super::super::MAX_ACTIVE {
                let retired_count = retired.clone();
                registry.retire_oldest(|_| *retired_count.lock().unwrap() += 1);
            }
            registry
                .insert(
                    index.to_string(),
                    notifications.reserve(Box::new(|_| {})).unwrap(),
                )
                .unwrap();
        }
        assert_eq!(*retired.lock().unwrap(), super::super::MAX_ACTIVE * 2);
        assert_eq!(*notifications.0.lock().unwrap(), super::super::MAX_ACTIVE);
    }
    #[test]
    fn registry_routes_once_and_releases_capacity() {
        let registry = Registry::default();
        let notifications = super::super::Notifications::default();
        let seen = Arc::new(Mutex::new(Vec::new()));
        for id in ["first", "second"] {
            let seen = seen.clone();
            registry
                .insert(
                    id.into(),
                    notifications
                        .reserve(Box::new(move |outcome| {
                            seen.lock().unwrap().push(outcome);
                        }))
                        .unwrap(),
                )
                .unwrap();
        }
        registry.finish("second", Outcome::Activated);
        registry.finish("second", Outcome::Closed);
        registry.finish("first", Outcome::Closed);
        assert_eq!(
            *seen.lock().unwrap(),
            vec![Outcome::Activated, Outcome::Closed]
        );
        assert_eq!(*notifications.0.lock().unwrap(), 0);
    }
}

use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Permission {
    Default,
    Denied,
    Granted,
}

fn notification_error(error: String) -> String {
    match error.as_str() {
        "Dock permission requires a bundled macOS app" => {
            "macOS notifications are unavailable when Buzz is not running from an app bundle".into()
        }
        "Dock settings request timed out" => "macOS notification settings request timed out".into(),
        "Dock authorization request timed out" => {
            "macOS notification authorization request timed out".into()
        }
        _ => error,
    }
}
fn notification_permission() -> Result<Permission, String> {
    crate::dock::notification_permission()
        .map(project)
        .map_err(notification_error)
}
fn notification_request() -> Result<Permission, String> {
    crate::dock::notification_request()
        .map(project)
        .map_err(notification_error)
}
fn project(status: UNAuthorizationStatus) -> Permission {
    match status {
        UNAuthorizationStatus::Denied => Permission::Denied,
        UNAuthorizationStatus::Authorized
        | UNAuthorizationStatus::Provisional
        | UNAuthorizationStatus::Ephemeral => Permission::Granted,
        _ => Permission::Default,
    }
}

#[tauri::command]
pub(crate) async fn notification_permission_state<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> Result<Permission, String> {
    if window.label() != "main" {
        return Err("Notifications belong to the main window".into());
    }
    tauri::async_runtime::spawn_blocking(notification_permission)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn request_notification_access<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> Result<Permission, String> {
    if window.label() != "main" {
        return Err("Notifications belong to the main window".into());
    }
    tauri::async_runtime::spawn_blocking(notification_request)
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod permission_tests {
    use super::*;
    #[test]
    fn notification_copy_is_not_dock_copy() {
        assert_eq!(
            notification_error("Dock settings request timed out".into()),
            "macOS notification settings request timed out"
        );
        assert_eq!(
            notification_error("Dock permission requires a bundled macOS app".into()),
            "macOS notifications are unavailable when Buzz is not running from an app bundle"
        );
    }
    #[test]
    fn foreground_presentation_banners_without_borrowing_sound_or_badge() {
        let options = foreground_presentation();
        // The frontend's policy, not this delegate, decides whether an alert is
        // worth interrupting for; a foreground alert that reached the OS shows.
        assert!(options.contains(UNNotificationPresentationOptions::Banner));
        // A missed banner stays reachable in Notification Center.
        assert!(options.contains(UNNotificationPresentationOptions::List));
        // Alert audio is app-owned and the Dock badge comes from unread state.
        assert!(!options.contains(UNNotificationPresentationOptions::Sound));
        assert!(!options.contains(UNNotificationPresentationOptions::Badge));
    }
    #[test]
    fn authorization_projection() {
        assert!(matches!(
            project(UNAuthorizationStatus::NotDetermined),
            Permission::Default
        ));
        assert!(matches!(
            project(UNAuthorizationStatus::Denied),
            Permission::Denied
        ));
        for status in [
            UNAuthorizationStatus::Authorized,
            UNAuthorizationStatus::Provisional,
            UNAuthorizationStatus::Ephemeral,
        ] {
            assert!(matches!(project(status), Permission::Granted));
        }
    }
}
