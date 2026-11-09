//! The saved TypeSafe key, which the `typesafe` decision backend sends (see
//! `decisions.rs`). Native code owns the key: it is kept in the OS credential
//! store under Buzz's own item, apart from Janet's, and it is never sent back
//! to the webview or given to an agent process. On macOS the item is created
//! by the Buzz binary, so only that binary reads it without a prompt; an
//! agent's shell cannot.
use std::sync::Arc;
use tokio::sync::Mutex;
use zeroize::Zeroizing;

#[cfg_attr(test, allow(dead_code))]
pub(crate) const KEY_SERVICE: &str = if cfg!(debug_assertions) {
    "xyz.block.buzz.desktop.jev-key.debug"
} else {
    "xyz.block.buzz.desktop.jev-key"
};
/// The service before 1.0. Reads copy a key found only there; clearing removes it too.
#[cfg_attr(test, allow(dead_code))]
const PREVIOUS_KEY_SERVICE: &str = if cfg!(debug_assertions) {
    "dev.local.buzz.foundation.jev-key.debug"
} else {
    "dev.local.buzz.foundation.jev-key"
};
#[cfg_attr(test, allow(dead_code))]
pub(crate) const KEY_ACCOUNT: &str = "typesafe";
pub(crate) const MODEL: &str = "jev-1.13.0";
const KEY_LIMIT: usize = 512;

/// Where the key lives.
pub(crate) trait KeyStore: Send + Sync {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String>;
    fn replace(&self, key: &str) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

pub(crate) struct JevHost {
    store: Arc<dyn KeyStore>,
    /// `None` until read: the Keychain is asked once, then kept current by set
    /// and clear. A failed read is not kept, and a key the service refuses is
    /// read again, so one removed outside the app is seen on the next call.
    key: Mutex<Option<Option<Zeroizing<String>>>>,
}

impl JevHost {
    pub(crate) fn new() -> Self {
        Self::with(Box::new(OsKeyStore))
    }
    pub(crate) fn with(store: Box<dyn KeyStore>) -> Self {
        Self {
            store: Arc::from(store),
            key: Mutex::new(None),
        }
    }
    /// The saved key, or `None` when there is none. A Keychain that cannot be
    /// read is an error, not a missing key.
    pub(crate) async fn key(&self) -> Result<Option<Zeroizing<String>>, String> {
        let mut key = self.key.lock().await;
        if key.is_none() {
            // The store can block on a consent dialog; a caller's deadline
            // still applies while it waits.
            let store = self.store.clone();
            let read = tokio::task::spawn_blocking(move || store.read())
                .await
                .map_err(|_| "The Keychain is unavailable".to_string())??;
            *key = Some(read);
        }
        Ok(key.as_ref().and_then(|k| k.clone()))
    }
    pub(crate) async fn forget(&self) {
        *self.key.lock().await = None;
    }
    pub(crate) async fn configured(&self) -> Result<bool, String> {
        Ok(self.key().await?.is_some())
    }
    pub(crate) async fn set(&self, value: &str) -> Result<(), String> {
        let value = value.trim();
        if value.is_empty()
            || value.len() > KEY_LIMIT
            || !value.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err("That does not look like a TypeSafe API key".into());
        }
        let mut key = self.key.lock().await;
        let store = self.store.clone();
        let saved = Zeroizing::new(value.to_owned());
        let write = saved.clone();
        tokio::task::spawn_blocking(move || store.replace(&write))
            .await
            .map_err(|_| "The Keychain is unavailable".to_string())??;
        *key = Some(Some(saved));
        Ok(())
    }
    pub(crate) async fn clear(&self) -> Result<(), String> {
        let mut key = self.key.lock().await;
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.clear())
            .await
            .map_err(|_| "The Keychain is unavailable".to_string())??;
        *key = Some(None);
        Ok(())
    }
}

/// The OS credential store: the login Keychain on macOS, the Secret Service on
/// Linux and the Credential Manager on Windows.
struct OsKeyStore;

#[cfg(all(
    any(target_os = "macos", target_os = "windows", target_os = "linux"),
    not(test)
))]
fn decode(bytes: Zeroizing<Vec<u8>>) -> Result<Option<Zeroizing<String>>, String> {
    let text = std::str::from_utf8(&bytes).map_err(|_| "The saved key is damaged".to_string())?;
    let key = text.trim();
    Ok((!key.is_empty()).then(|| Zeroizing::new(key.to_owned())))
}

/// Delete the key under both services, the previous one first, stopping at a
/// failure: reads copy it while the current one is absent, so deleting the
/// current one first could let a read bring the key back.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
fn clear_with<E>(delete: impl FnMut(&str) -> Result<(), E>) -> Result<(), E> {
    [PREVIOUS_KEY_SERVICE, KEY_SERVICE]
        .into_iter()
        .try_for_each(delete)
}

#[cfg(all(
    any(target_os = "macos", target_os = "windows", target_os = "linux"),
    not(test)
))]
mod platform {
    use super::*;
    use buzz_credential_store::{self as credentials, Error};
    fn error(error: Error) -> String {
        match error {
            Error::Denied if cfg!(target_os = "macos") => {
                "Keychain access was denied. Allow access and retry"
            }
            Error::Denied => "Secure storage access was denied. Allow access and retry",
            Error::Busy => "Another Buzz app is using secure storage. Retry shortly",
            Error::Corrupt => "The saved key is damaged",
            _ if cfg!(target_os = "macos") => "The Keychain is unavailable",
            _ => "Secure storage is unavailable. Unlock it and retry",
        }
        .into()
    }
    impl KeyStore for OsKeyStore {
        fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
            let find = |service| match credentials::read(service, KEY_ACCOUNT) {
                Ok(bytes) => Ok(Some(bytes)),
                Err(Error::Absent) => Ok(None),
                Err(e) => Err(e),
            };
            credentials::read_or_copy(
                || find(KEY_SERVICE),
                || credentials::copy(PREVIOUS_KEY_SERVICE, KEY_SERVICE, KEY_ACCOUNT),
            )
            .map_err(error)?
            .map_or(Ok(None), decode)
        }
        fn replace(&self, key: &str) -> Result<(), String> {
            credentials::replace(KEY_SERVICE, KEY_ACCOUNT, key.as_bytes()).map_err(error)
        }
        fn clear(&self) -> Result<(), String> {
            clear_with(|service| match credentials::delete(service, KEY_ACCOUNT) {
                Ok(()) | Err(Error::Absent) => Ok(()),
                Err(e) => Err(error(e)),
            })
        }
    }
}

// Native tests never touch an OS credential store.
#[cfg(any(
    not(any(target_os = "macos", target_os = "windows", target_os = "linux")),
    test
))]
impl KeyStore for OsKeyStore {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
        Err("Secure storage is not available here".into())
    }
    fn replace(&self, _key: &str) -> Result<(), String> {
        Err("Secure storage is not available here".into())
    }
    fn clear(&self) -> Result<(), String> {
        Err("Secure storage is not available here".into())
    }
}

#[tauri::command]
pub(crate) async fn jev_classifier_status(host: tauri::State<'_, JevHost>) -> Result<bool, String> {
    host.configured().await
}

#[tauri::command]
pub(crate) async fn jev_classifier_set_key(
    host: tauri::State<'_, JevHost>,
    key: String,
) -> Result<(), String> {
    let key = Zeroizing::new(key);
    host.set(&key).await
}

#[tauri::command]
pub(crate) async fn jev_classifier_clear_key(
    host: tauri::State<'_, JevHost>,
) -> Result<(), String> {
    host.clear().await
}

#[cfg(test)]
#[path = "jev_tests.rs"]
mod tests;
