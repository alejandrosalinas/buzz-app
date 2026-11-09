//! Mainline pre-start path: reuse the selected node, then probe its inference route.
use tauri::Manager;

pub(crate) fn community_origin(raw: &str) -> Result<String, String> {
    let mut url = url::Url::parse(raw).map_err(|_| "Invalid agent community")?;
    if url.scheme() == "wss" {
        url.set_scheme("https")
            .map_err(|_| "Invalid agent community")?;
    }
    crate::desktop::host::relay_origin(url.as_str())?;
    if let Some(host) = url.host_str().filter(|host| host.ends_with('.')) {
        let host = host.trim_end_matches('.').to_owned();
        url.set_host(Some(&host))
            .map_err(|_| "Invalid agent community")?;
    }
    Ok(url.origin().ascii_serialization())
}

/// Shared readiness: the agent's community holds the current lease, compute is
/// Ready, and a real chat probe on the loopback route succeeded.
struct Ready {
    lease: String,
    model: String,
}

async fn ready_inference(
    app: &tauri::AppHandle,
    relay: &str,
    model: &str,
) -> Result<Ready, String> {
    use crate::lifecycle::Phase;
    let host = app.state::<super::MeshHost>();
    let identity = app.state::<crate::desktop::host::Identity>();
    let community = community_origin(relay)?;
    let lease = host.lease.for_community(&community)?;
    if host.lifecycle.phase() == Phase::Stopped {
        crate::startup_log::stage("entry", "from=agent");
        super::start(app, &host, &identity, &lease).await?;
    }
    let port = super::mesh_port("BUZZ_MESH_API_PORT", 19337)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
    let mut last = "Shared compute is starting".to_owned();
    let ready = async {
        loop {
            let (guard, cancel) = host.preparing.request(&lease).await;
            if cancel.is_cancelled() {
                return Err("Mesh request retired".into());
            }
            host.lease.community(&lease)?;
            match host.lifecycle.phase() {
                Phase::Failed(reason) => return Err(reason),
                Phase::Stopped | Phase::Stopping => {
                    return Err("Shared compute stopped before agent launch".into())
                }
                Phase::Starting => {}
                Phase::Ready => match tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err("Mesh request retired".into()),
                    result = probe(&client, port, model) => result,
                } {
                    Ok(model) => {
                        crate::startup_log::stage("first_probe_ok", "");
                        return Ok(model);
                    }
                    Err(error) => last = error,
                },
            }
            drop(guard);
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    };
    let model = tokio::time::timeout_at(deadline, ready)
        .await
        .map_err(|_| {
            crate::startup_log::stage("first_probe_ok", "ok=false timeout");
            format!("Shared compute inference did not become ready: {last}")
        })??;
    host.lease.community(&lease)?;
    Ok(Ready { lease, model })
}

/// Lease-bound gateway target for a plugin-owned helper. Each request is checked
/// after taking the native replacement lock, held through the upstream body.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedInference {
    pub base_url: String,
    pub model: String,
    pub lease: String,
}

#[tauri::command]
pub async fn mesh_compute_prepare_inference(
    app: tauri::AppHandle,
    relay: String,
    model: String,
) -> Result<PreparedInference, String> {
    let ready = ready_inference(&app, &relay, &model).await?;
    let host = app.state::<super::MeshHost>();
    let mut gateway = host.inference.lock().await;
    if gateway.is_none() {
        let lease = host.lease.clone();
        let lifecycle = host.lifecycle.clone();
        *gateway = Some(
            super::inference::Gateway::start(
                host.preparing.clone(),
                std::sync::Arc::new(move |id| {
                    lease.with_current(id, |_| {
                        if lifecycle.phase() != crate::lifecycle::Phase::Ready {
                            return Err("Shared compute is not ready".into());
                        }
                        super::mesh_port("BUZZ_MESH_API_PORT", 19337)
                    })
                }),
            )
            .await?,
        );
    }
    host.lease.with_current(&ready.lease, |_| {
        Ok(PreparedInference {
            base_url: gateway.as_ref().unwrap().base_url(&ready.lease),
            model: ready.model,
            lease: ready.lease.clone(),
        })
    })
}

/// True only while the lease from `mesh_compute_prepare_inference` is still the
/// current selection and compute is Ready. Check before publishing a reply.
/// Output freshness only; the gateway separately isolates inference requests.
/// A same-community lease rotation also returns false.
#[tauri::command]
pub async fn mesh_compute_inference_current(
    app: tauri::AppHandle,
    lease: String,
) -> Result<bool, String> {
    let host = app.state::<super::MeshHost>();
    Ok(host
        .lease
        .with_current(&lease, |_| {
            Ok(host.lifecycle.phase() == crate::lifecycle::Phase::Ready)
        })
        .unwrap_or(false))
}

/// One non-streaming chat completion on the leased loopback route, for the Mesh
/// agent's "Chat" mode (no harness). Native so the WebView CSP stays closed to
/// loopback HTTP. Refuses unless `lease` is still current and compute is Ready;
/// holds the replacement lock through the complete HTTP operation.
#[tauri::command]
pub async fn mesh_compute_chat(
    app: tauri::AppHandle,
    lease: String,
    model: String,
    messages: Vec<serde_json::Value>,
) -> Result<String, String> {
    let host = app.state::<super::MeshHost>();
    let (_guard, cancel) = host.preparing.request(&lease).await;
    if cancel.is_cancelled() {
        return Err("Mesh request retired".into());
    }
    let port = {
        host.lease.with_current(&lease, |_| {
            if host.lifecycle.phase() != crate::lifecycle::Phase::Ready {
                return Err("Shared compute is not ready".into());
            }
            super::mesh_port("BUZZ_MESH_API_PORT", 19337)
        })?
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(240))
        .build()
        .map_err(|e| e.to_string())?;
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("Mesh request retired".into()),
        result = chat_completion(&client, port, &model, messages) => result,
    }
}

async fn chat_completion(
    client: &reqwest::Client,
    port: u16,
    model: &str,
    messages: Vec<serde_json::Value>,
) -> Result<String, String> {
    let response = client
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .bearer_auth("mesh-local")
        // Chat asks for direct answers: hidden reasoning can outlast Mesh's route budget.
        .json(&serde_json::json!({"model": model, "messages": messages, "stream": false, "reasoning_effort": "none"}))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let detail = body["error"]["message"].as_str().unwrap_or("");
        return Err(format!("HTTP {status} {detail}").trim().to_owned());
    }
    Ok(body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_owned())
}

/// Baseline readiness (legacy `mesh_readiness::wait_for_mesh_inference`): a real
/// chat request decides. The catalog only explains a failure; it never gates.
async fn probe(client: &reqwest::Client, port: u16, model: &str) -> Result<String, String> {
    let base = format!("http://127.0.0.1:{port}/v1");
    let wire = match model.trim() {
        "" | "auto" | "mesh" => "mesh",
        named => named,
    };
    let response = client
        .post(format!("{base}/chat/completions"))
        .bearer_auth("mesh-local")
        .json(&serde_json::json!({"model": wire, "messages": [{"role":"user","content":"Reply OK"}], "max_tokens":1, "stream":false}))
        .send()
        .await;
    let failure = match response {
        Ok(response) if response.status().is_success() => return Ok(wire.to_owned()),
        Ok(response) => format!("HTTP {}", response.status()),
        Err(error) => error.to_string(),
    };
    let visible = async {
        let catalog = client
            .get(format!("{base}/models"))
            .bearer_auth("mesh-local")
            .send()
            .await
            .ok()?
            .json::<serde_json::Value>()
            .await
            .ok()?;
        let ids: Vec<String> = catalog["data"]
            .as_array()?
            .iter()
            .filter_map(|m| m["id"].as_str().map(str::to_owned))
            .collect();
        // The virtual route counts as synced once any concrete model is listed.
        Some(if wire == "mesh" {
            ids.iter().any(|id| id != "mesh")
        } else {
            ids.iter().any(|id| id == wire)
        })
    }
    .await;
    Err(match visible {
        Some(false) => format!("{failure} (model not yet visible in the Mesh catalog)"),
        _ => failure,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn prepared_inference_wire_contract_is_camel_case() {
        let wire = serde_json::to_value(PreparedInference {
            base_url: "http://127.0.0.1:1/v1".into(),
            model: "mesh".into(),
            lease: "l".into(),
        })
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({"baseUrl":"http://127.0.0.1:1/v1","model":"mesh","lease":"l"})
        );
    }

    struct Fixture {
        port: u16,
        stop: tokio::sync::oneshot::Sender<()>,
        server: tokio::task::JoinHandle<Vec<String>>,
    }
    impl Fixture {
        /// Stop only after the awaited probe, then return the recorded requests.
        async fn finish(self) -> Vec<String> {
            let _ = self.stop.send(());
            self.server.await.unwrap()
        }
    }

    /// Loopback fixture answering `/v1/models` and `/v1/chat/completions` by path.
    async fn fixture(catalog: (u16, &'static str), chat: u16) -> Fixture {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let mut seen = Vec::new();
            loop {
                let mut socket = tokio::select! {
                    _ = &mut stopped => break,
                    accepted = listener.accept() => accepted.unwrap().0,
                };
                let mut request = Vec::new();
                loop {
                    let mut buf = [0; 1024];
                    let n = socket.read(&mut buf).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    request.extend_from_slice(&buf[..n]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&request[..end]).to_lowercase();
                        let length: usize = header
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("content-length:")
                                    .map(|v| v.trim().parse().unwrap())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let text = String::from_utf8(request).unwrap();
                let (code, body) = if text.starts_with("POST /v1/chat/completions") {
                    let body: serde_json::Value =
                        serde_json::from_str(text.split("\r\n\r\n").nth(1).unwrap()).unwrap();
                    assert_eq!(body["max_tokens"], 1);
                    seen.push(format!("chat:{}", body["model"].as_str().unwrap()));
                    (chat, "{}")
                } else {
                    assert!(text.starts_with("GET /v1/models"));
                    seen.push("models".into());
                    catalog
                };
                socket.write_all(format!("HTTP/1.1 {code} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
            seen
        });
        Fixture { port, stop, server }
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .unwrap()
    }

    /// Answers one request with `code` and `body`, returning the request text.
    async fn once(code: u16, body: &'static str) -> (u16, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buf = [0; 4096];
            while !String::from_utf8_lossy(&request).contains("\"messages\"") {
                let n = socket.read(&mut buf).await.unwrap();
                request.extend_from_slice(&buf[..n]);
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            if let Ok(n) = socket.try_read(&mut buf) {
                request.extend_from_slice(&buf[..n]);
            }
            socket.write_all(format!("HTTP/1.1 {code} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            String::from_utf8(request).unwrap()
        });
        (port, server)
    }

    #[tokio::test]
    async fn chat_returns_the_answer_for_the_given_messages() {
        let (port, server) = once(200, r#"{"choices":[{"message":{"content":"Monday"}}]}"#).await;
        let messages = vec![serde_json::json!({"role":"user","content":"when?"})];
        assert_eq!(
            chat_completion(&client(), port, "mesh", messages)
                .await
                .unwrap(),
            "Monday"
        );
        let request = server.await.unwrap();
        assert!(request.starts_with("POST /v1/chat/completions"));
        assert!(request.contains(r#""stream":false"#));
        assert!(request.contains(r#""reasoning_effort":"none""#));
        assert!(request.contains(r#""content":"when?""#));
    }

    #[tokio::test]
    async fn chat_reports_the_endpoint_error() {
        let (port, _server) = once(503, r#"{"error":{"message":"no capacity"}}"#).await;
        let error = chat_completion(&client(), port, "mesh", vec![])
            .await
            .unwrap_err();
        assert_eq!(error, "HTTP 503 Service Unavailable no capacity");
    }

    // Live 0.78.1 shape: a remote peer's model with no context_length.
    const BUDGETLESS: &str = r#"{"data":[{"id":"mesh"},{"id":"unsloth/Qwen3.5-9B-GGUF:Q4_K_M","metadata":{"workload_class":"causal_generation"}}]}"#;

    #[tokio::test]
    async fn successful_inference_is_ready_even_without_a_context_budget() {
        let f = fixture((200, BUDGETLESS), 200).await;
        assert_eq!(probe(&client(), f.port, "auto").await.unwrap(), "mesh");
        assert_eq!(f.finish().await, vec!["chat:mesh"]);
    }

    #[tokio::test]
    async fn catalog_failure_or_missing_entry_does_not_gate_working_inference() {
        let f = fixture((500, "oops"), 200).await;
        assert_eq!(probe(&client(), f.port, "auto").await.unwrap(), "mesh");
        assert_eq!(f.finish().await, vec!["chat:mesh"]);
        let f = fixture((200, BUDGETLESS), 200).await;
        assert_eq!(
            probe(&client(), f.port, "lagging/model:Q4").await.unwrap(),
            "lagging/model:Q4"
        );
        assert_eq!(f.finish().await, vec!["chat:lagging/model:Q4"]);
    }

    #[tokio::test]
    async fn failed_inference_uses_the_catalog_only_to_explain() {
        let f = fixture((200, BUDGETLESS), 503).await;
        let error = probe(&client(), f.port, "lagging/model:Q4")
            .await
            .unwrap_err();
        assert!(
            error.contains("503") && error.contains("not yet visible"),
            "{error}"
        );
        assert_eq!(f.finish().await, vec!["chat:lagging/model:Q4", "models"]);
        let f = fixture((200, BUDGETLESS), 503).await;
        let error = probe(&client(), f.port, "auto").await.unwrap_err();
        assert!(
            error.contains("503") && !error.contains("not yet visible"),
            "{error}"
        );
        assert_eq!(f.finish().await, vec!["chat:mesh", "models"]);
    }
}

#[cfg(test)]
mod community_tests {
    use super::community_origin;
    #[test]
    fn saved_agent_and_ui_share_one_origin_without_accepting_paths_or_credentials() {
        for raw in [
            "wss://meshllm.communities.buzz.xyz",
            "https://MESHLLM.communities.buzz.xyz:443/",
            "wss://meshllm.communities.buzz.xyz./",
        ] {
            assert_eq!(
                community_origin(raw).unwrap(),
                "https://meshllm.communities.buzz.xyz"
            );
        }
        for raw in [
            "wss://relay.example/path",
            "https://user:pass@relay.example",
            "https://relay.example?x",
            "http://relay.example",
        ] {
            assert!(community_origin(raw).is_err());
        }
    }
}
