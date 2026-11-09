//! Read-only presentation of the app-owned Mesh node; no raw SDK payload crosses IPC.
use super::MeshHost;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
pub async fn mesh_compute_widget_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    host: tauri::State<'_, MeshHost>,
) -> Result<(), String> {
    if host
        .sharing
        .lock()
        .map_err(|_| "Mesh sharing unavailable")?
        .is_none()
    {
        return Err("Share compute before opening the activity widget".into());
    }
    if let Some(window) = app.get_webview_window("compute-widget") {
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(
        &app,
        "compute-widget",
        WebviewUrl::App("compute-widget.html".into()),
    )
    .title("Compute")
    .inner_size(200.0, 200.0)
    .min_inner_size(96.0, 96.0)
    .max_inner_size(320.0, 320.0)
    .resizable(true)
    // Opaque: a transparent window needs Tauri's app-wide macOS private API.
    .decorations(false)
    .always_on_top(true)
    .build()
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mesh_compute_widget_close<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("compute-widget") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn usage(payload: &serde_json::Value) -> Option<serde_json::Value> {
    let metrics = payload.get("routing_metrics")?;
    Some(serde_json::json!({
        "tokensServed": metrics.get("completion_tokens_observed")?.as_u64()?,
        "inflight": metrics.pointer("/local_node/current_inflight_requests")
            .or_else(|| payload.get("inflight_requests"))?.as_u64()?,
        "tokensPerSecond": metrics.get("avg_tokens_per_second").and_then(serde_json::Value::as_f64)
            .filter(|rate| rate.is_finite() && *rate >= 0.0),
        "peers": payload.get("peers").and_then(serde_json::Value::as_array).map(Vec::len),
    }))
}

#[tauri::command]
pub async fn mesh_compute_widget_status(
    host: tauri::State<'_, MeshHost>,
) -> Result<serde_json::Value, String> {
    {
        use crate::lifecycle::Phase;
        let generation = host.lifecycle.generation();
        let phase = host.lifecycle.phase();
        let sharing = host
            .sharing
            .lock()
            .map_err(|_| "Mesh sharing unavailable")?
            .is_some();
        if !sharing {
            return Ok(serde_json::json!({
                "available": true, "sharing": false, "generation": generation,
                "state": "off", "usage": null
            }));
        }
        let payload = if phase == Phase::Ready {
            Some(
                host.lifecycle
                    .status()
                    .await
                    .map_err(|e| e.to_string())?
                    .payload,
            )
        } else {
            None
        };
        if generation != host.lifecycle.generation() || phase != host.lifecycle.phase() {
            return Err("Mesh session changed during status read".into());
        }
        let ready = !sharing
            || payload
                .as_ref()
                .and_then(|p| p.get("llama_ready"))
                .and_then(serde_json::Value::as_bool)
                == Some(true);
        let state = match phase {
            Phase::Ready if ready => "running",
            Phase::Ready | Phase::Starting => "starting",
            Phase::Failed(_) => "failed",
            Phase::Stopping => "stopping",
            Phase::Stopped => "off",
        };
        Ok(serde_json::json!({
            "available": true, "sharing": sharing, "generation": generation, "state": state,
            "usage": payload.as_ref().filter(|_| state == "running").and_then(usage)
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn projects_usage_without_credentials_or_invented_counters() {
        assert!(usage(&json!({})).is_none());
        let payload = json!({"routing_metrics":{"completion_tokens_observed":123,"avg_tokens_per_second":-1,"local_node":{"current_inflight_requests":2}},"peers":[{"token":"secret"}],"token":"secret"});
        assert_eq!(
            usage(&payload),
            Some(json!({"tokensServed":123,"inflight":2,"tokensPerSecond":null,"peers":1}))
        );
        assert!(usage(&json!({"routing_metrics":{"completion_tokens_observed":123}})).is_none());
    }
}
