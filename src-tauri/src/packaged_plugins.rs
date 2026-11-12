//! Refreshes the packager's managed plugin policy from `BUZZ_BUILD_MANAGED_PLUGINS_URL`.
//! A failed or unusable fetch leaves the last good copy in place.
use buzzodz_plugins::{managed, Manager};
use std::{sync::OnceLock, time::Duration};

const REFRESH: Duration = Duration::from_secs(6 * 60 * 60);
const RETRY: Duration = Duration::from_secs(15 * 60);
const TIMEOUT: Duration = Duration::from_secs(30);

static FETCHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn spawn(manager: Manager) {
    if managed::PACKAGED_URL.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            let wait = if refresh(&manager).await {
                REFRESH
            } else {
                RETRY
            };
            tokio::time::sleep(wait).await;
        }
    });
}

/// Fetches the policy now and records the outcome on `manager`; true when Buzz kept it.
pub async fn refresh(manager: &Manager) -> bool {
    if managed::PACKAGED_URL.is_empty() {
        return false;
    }
    let _fetching = FETCHING.lock().await;
    let stored = match fetch(managed::PACKAGED_URL).await {
        Ok(bytes) => {
            let manager = manager.clone();
            tauri::async_runtime::spawn_blocking(move || manager.store_packaged_policy(&bytes))
                .await
                .map_err(|e| e.to_string())
                .and_then(|stored| stored.map(|_| ()))
        }
        Err(reason) => {
            manager.packaged_policy_failed(reason.clone());
            Err(reason)
        }
    };
    if let Err(error) = &stored {
        eprintln!("Could not refresh the packaged plugin policy: {error}");
    }
    stored.is_ok()
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .https_only(true)
                .connect_timeout(TIMEOUT)
                .timeout(TIMEOUT)
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

async fn fetch(url: &str) -> Result<Vec<u8>, String> {
    let mut response = client()?.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if (body.len() + chunk.len()) as u64 > managed::MAX_BYTES {
            return Err("Managed plugin policy exceeds 256 KiB".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
