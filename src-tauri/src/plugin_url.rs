//! Downloads a single plugin artifact for a URL import. The bytes are untrusted until
//! `imports::prepare_url` matches them to the pinned SHA-256.

pub async fn download(url: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || buzzodz_plugins::imports::download(&url))
        .await
        .map_err(|e| e.to_string())?
}
