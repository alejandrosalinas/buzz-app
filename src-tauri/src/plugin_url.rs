//! Downloads a single plugin artifact for a URL import. The bytes are untrusted until
//! `imports::prepare_url` matches them to the pinned SHA-256.
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(60);

pub async fn download(url: String) -> Result<Vec<u8>, String> {
    let url = buzzodz_plugins::imports::plugin_url(&url)?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(30))
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Could not download the plugin: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Could not download the plugin: HTTP {}",
            response.status()
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Could not download the plugin: {e}"))?
    {
        if (body.len() + chunk.len()) as u64 > buzzodz_plugins::LIMIT {
            return Err("Plugin artifact exceeds 8 MiB".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
