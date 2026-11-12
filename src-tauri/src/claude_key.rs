//! The Anthropic API key Buzz's Claude runs with, in OSS builds. Native code
//! owns it: it is kept in the OS credential store under Buzz's own item, and
//! no command returns it. Native code adds it to the environment of the
//! Claude processes `buzz.claude-code` starts that ask for it
//! (`plugin_host_process_spawn`'s `secrets`). On macOS the item is created by
//! the Buzz binary, so only that binary reads it without a prompt; an agent's
//! shell cannot read it from the store.
//!
//! What this does not guarantee:
//! - Claude's own children (its Bash tool, hooks and MCP servers) inherit its
//!   environment, so commands a Claude agent runs can read the key. Claude
//!   scrubs it from them only with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, which
//!   also strips `SSH_AUTH_SOCK`, `GIT_*` and every `*TOKEN`/`*KEY`
//!   variable, so Buzz does not set it.
//! - `claude-sh` is `bash -c` with a script the caller supplies, so code that
//!   can start it as `buzz.claude-code` can print the key back. Keeping it
//!   out of the webview is the plugin's convention (`auth.tsx`), not
//!   something native code enforces: like the rest of Buzz's threat model,
//!   this trusts installed plugin code. What native code does enforce is
//!   that no other plugin or process is given the key (`may_have`).
use std::sync::Arc;
use tokio::sync::Mutex;
use zeroize::Zeroizing;

#[cfg_attr(test, allow(dead_code))]
const SERVICE: &str = if cfg!(debug_assertions) {
    "xyz.block.buzz.desktop.claude-api-key.debug"
} else {
    "xyz.block.buzz.desktop.claude-api-key"
};
#[cfg_attr(test, allow(dead_code))]
const ACCOUNT: &str = "anthropic";
const KEY_LIMIT: usize = 512;
/// The secret's name in a spawn's `secrets`.
pub(crate) const SECRET: &str = "anthropic-api-key";
/// The variable the secret is set as.
pub(crate) const ENV: &str = "ANTHROPIC_API_KEY";
const PLUGIN: &str = "buzz.claude-code";
const NOT_A_KEY: &str =
    "That is not an Anthropic API key. Create one at console.anthropic.com and paste it here.";

/// Whether `process_id` of `plugin` may be given the key: Buzz's Claude,
/// which starts its copy through `claude-sh`, and the protected release.
pub(crate) fn may_have(plugin: &str, process_id: &str) -> bool {
    plugin == PLUGIN
        && matches!(
            process_id,
            "claude-sh" | "claude-protected-arm64" | "claude-protected-x64"
        )
}

/// Where the key lives.
pub(crate) trait KeyStore: Send + Sync {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String>;
    fn replace(&self, key: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

pub(crate) struct ClaudeKey {
    store: Arc<dyn KeyStore>,
    /// The key last read or saved. Only a key is kept: with none, every ask
    /// reads the store again, because another Buzz on this computer, or a
    /// development copy sharing its item, may save one.
    key: Mutex<Option<Zeroizing<String>>>,
}

impl ClaudeKey {
    pub(crate) fn new() -> Self {
        Self::with(Box::new(OsKeyStore))
    }
    pub(crate) fn with(store: Box<dyn KeyStore>) -> Self {
        Self {
            store: Arc::from(store),
            key: Mutex::new(None),
        }
    }
    /// Reads the store into the kept key. A store that cannot be read is an
    /// error, not a missing key, and leaves the kept key as it was.
    async fn reread(
        &self,
        key: &mut Option<Zeroizing<String>>,
    ) -> Result<Option<Zeroizing<String>>, String> {
        // The store can block on a consent dialog.
        let store = self.store.clone();
        let read = tokio::task::spawn_blocking(move || store.read())
            .await
            .map_err(|_| "Secure storage is unavailable".to_string())??;
        key.clone_from(&read);
        Ok(read)
    }
    /// The key a Claude process starts with: the kept one, or else the
    /// store's, or `None` when there is none.
    pub(crate) async fn key(&self) -> Result<Option<Zeroizing<String>>, String> {
        let mut key = self.key.lock().await;
        if key.is_some() {
            return Ok(key.clone());
        }
        self.reread(&mut key).await
    }
    /// Whether a key is saved, read from the store each time: the app's
    /// explicit check, which also picks up a key another Buzz replaced or
    /// removed for the processes started after it.
    pub(crate) async fn configured(&self) -> Result<bool, String> {
        let mut key = self.key.lock().await;
        Ok(self.reread(&mut key).await?.is_some())
    }
    /// Saves `value`, loosely checked as Anthropic's form: one `sk-ant-` word.
    pub(crate) async fn set(&self, value: &str) -> Result<(), String> {
        let value = value.trim();
        if value.len() <= "sk-ant-".len()
            || value.len() > KEY_LIMIT
            || !value.starts_with("sk-ant-")
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(NOT_A_KEY.into());
        }
        let mut key = self.key.lock().await;
        let store = self.store.clone();
        let saved = Zeroizing::new(value.to_owned());
        let write = saved.clone();
        tokio::task::spawn_blocking(move || store.replace(&write))
            .await
            .map_err(|_| "Secure storage is unavailable".to_string())??;
        *key = Some(saved);
        Ok(())
    }

    /// Remove the saved key before dropping the copy used by new processes.
    /// A failed delete preserves that copy so the caller can retry.
    pub(crate) async fn clear(&self) -> Result<(), String> {
        let mut key = self.key.lock().await;
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.delete())
            .await
            .map_err(|_| "Secure storage is unavailable".to_string())??;
        *key = None;
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
impl KeyStore for OsKeyStore {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
        match buzz_credential_store::read(SERVICE, ACCOUNT) {
            Ok(bytes) => {
                let text = std::str::from_utf8(&bytes)
                    .map_err(|_| "The saved key is damaged".to_string())?;
                let key = text.trim();
                Ok((!key.is_empty()).then(|| Zeroizing::new(key.to_owned())))
            }
            Err(buzz_credential_store::Error::Absent) => Ok(None),
            Err(error) => Err(stored(error)),
        }
    }
    fn replace(&self, key: &str) -> Result<(), String> {
        buzz_credential_store::replace(SERVICE, ACCOUNT, key.as_bytes()).map_err(stored)
    }
    fn delete(&self) -> Result<(), String> {
        match buzz_credential_store::delete(SERVICE, ACCOUNT) {
            Ok(()) | Err(buzz_credential_store::Error::Absent) => Ok(()),
            Err(error) => Err(stored(error)),
        }
    }
}

#[cfg(all(
    any(target_os = "macos", target_os = "windows", target_os = "linux"),
    not(test)
))]
fn stored(error: buzz_credential_store::Error) -> String {
    use buzz_credential_store::Error;
    match error {
        Error::Denied if cfg!(target_os = "macos") => {
            "Keychain access was denied. Allow access and retry"
        }
        Error::Denied => "Secure storage access was denied. Allow access and retry",
        Error::Busy => "Another Buzz app is using secure storage. Retry shortly",
        Error::Corrupt | Error::Ambiguous => "The saved key is damaged",
        _ if cfg!(target_os = "macos") => "The Keychain is unavailable",
        _ => "Secure storage is unavailable. Unlock it and retry",
    }
    .into()
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
    fn delete(&self) -> Result<(), String> {
        Err("Secure storage is not available here".into())
    }
}

#[tauri::command]
pub(crate) async fn claude_api_key_status(
    key: tauri::State<'_, ClaudeKey>,
) -> Result<bool, String> {
    key.configured().await
}

#[tauri::command]
pub(crate) async fn claude_api_key_set(
    key: tauri::State<'_, ClaudeKey>,
    value: String,
) -> Result<(), String> {
    let value = Zeroizing::new(value);
    key.set(&value).await
}

#[tauri::command]
pub(crate) async fn claude_api_key_clear(key: tauri::State<'_, ClaudeKey>) -> Result<(), String> {
    key.clear().await
}

#[cfg(test)]
#[path = "claude_key_tests.rs"]
mod tests;
