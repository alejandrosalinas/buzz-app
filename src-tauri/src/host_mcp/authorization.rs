use super::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::Instant;

const CODE_LIFETIME: Duration = Duration::from_secs(60);
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Authorization {
    pub(super) callback: String,
    pub(super) state: String,
    pub(super) code_challenge: String,
    pub(super) approval: Option<super::pairing::Approval>,
    pub(super) resume: Option<super::pairing::Resume>,
}
pub(super) struct Exchange {
    code: String,
    state: String,
    challenge: String,
    expires: Instant,
    consumed: bool,
}
fn opaque(value: &str) -> bool {
    URL_SAFE_NO_PAD
        .decode(value)
        .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == value)
}
pub(super) fn callback(request: &Authorization) -> Result<reqwest::Url, String> {
    let url =
        reqwest::Url::parse(&request.callback).map_err(|_| "Invalid authorization callback")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port().is_none_or(|port| port < 1024)
        || url.path() != "/buzz/authorize"
        || url.as_str() != request.callback
        || !opaque(&request.state)
        || !opaque(&request.code_challenge)
    {
        return Err("Invalid authorization callback".into());
    }
    Ok(url)
}

#[tauri::command]
pub(crate) async fn plugin_host_mcp_authorize<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    manager: tauri::State<'_, PluginManager>,
    servers: tauri::State<'_, HostMcpServers>,
    id: String,
    revision: String,
    handle: Option<u64>,
    request: Authorization,
) -> Result<(), String> {
    let expected_revision = super::pairing::revision();
    let plugin = id.clone();
    let granted = with_manager(manager, move |manager| {
        Ok(manager.host_grants(&id, &revision)?.mcp)
    })
    .await?;
    if !granted {
        return Err("MCP servers are not declared".into());
    }
    let shared = handle
        .map(|handle| servers.owned(&plugin, handle))
        .transpose()?;
    callback(&request)?;
    if (request.approval.is_some() || request.resume.is_some()) && plugin != "buzz.agents" {
        return Err("Only Agents can manage external approval".into());
    }
    let pairing = if let Some(shared) = shared.clone() {
        let request = request.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if request.approval.is_some() || request.resume.is_some() {
                super::pairing::begin(&shared, expected_revision)?;
            }
            super::pairing::authorize(&app, &request, expected_revision, &shared)
        })
        .await
        .map_err(|_| "Cannot save Buzz approval")??
    } else {
        None
    };
    authorize_with_pairing(shared, request, pairing).await
}

#[cfg(test)]
async fn authorize(shared: Option<Arc<Shared>>, request: Authorization) -> Result<(), String> {
    authorize_with_pairing(shared, request, None).await
}

async fn authorize_with_pairing(
    shared: Option<Arc<Shared>>,
    request: Authorization,
    pairing: Option<super::pairing::Grant>,
) -> Result<(), String> {
    let url = callback(&request)?;
    let deadline = tokio::time::Instant::now() + CODE_LIFETIME;
    let durable = pairing.is_some();
    let body = if let Some(shared) = &shared {
        if shared.shared_session
            || shared.claim.load(Ordering::SeqCst) != UNCLAIMED
            || shared.stop.is_cancelled()
        {
            return Err("This MCP server cannot authorize an external app".into());
        }
        let mut secret = [0; 32];
        getrandom::fill(&mut secret).map_err(|_| "Could not create authorization code")?;
        let code = URL_SAFE_NO_PAD.encode(secret);
        let mut exchange = shared
            .authorization
            .lock()
            .map_err(|_| "Authorization state unavailable")?;
        if exchange.is_some() {
            return Err("Authorization already started".into());
        }
        let endpoint = format!("http://{}/authorize/exchange", shared.authority);
        let proof = pairing
            .as_ref()
            .map(|grant| grant.response_proof(&request, &code, &endpoint))
            .transpose()?;
        *exchange = Some(Exchange {
            code: code.clone(),
            state: request.state.clone(),
            challenge: request.code_challenge,
            expires: Instant::now() + CODE_LIFETIME,
            consumed: false,
        });
        let mut body = serde_json::json!({ "version": 1, "state": request.state, "outcome": "authorized", "code": code,
            "exchange_url": endpoint });
        if request.resume.is_some() {
            body["proof"] = proof.into();
        }
        body
    } else {
        serde_json::json!({ "version": 1, "state": request.state, "outcome": "denied" })
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "Could not send authorization result")?;
    let sending = client.post(url).json(&body).send();
    let sent = if let Some(shared) = shared.as_ref().filter(|_| durable) {
        tokio::select! {
            biased;
            () = shared.stop.cancelled() => return Err("Buzz approval is cancelled".into()),
            result = sending => result,
        }
    } else {
        sending.await
    };
    if !sent.is_ok_and(|response| response.status().is_success()) {
        if let Some(shared) = shared {
            shared.stop.cancel();
        }
        return Err("The external app did not accept authorization. Start setup again.".into());
    }
    if let Some(shared) = shared {
        tokio::spawn(async move {
            tokio::select! { () = tokio::time::sleep_until(deadline) => {}, () = shared.stop.cancelled() => return }
            if shared.authorization.lock().map_or(true, |exchange| {
                exchange.as_ref().is_some_and(|exchange| !exchange.consumed)
            }) || shared.claim.load(Ordering::SeqCst) != CLAIMED
            {
                shared.stop.cancel();
            }
        });
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Redemption {
    version: u8,
    code: String,
    code_verifier: String,
    state: String,
}
fn redeem(shared: &Shared, input: Redemption) -> Option<String> {
    if input.version != 1
        || !(43..=128).contains(&input.code_verifier.len())
        || !input
            .code_verifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._~".contains(&byte))
    {
        return None;
    }
    let mut held = shared.authorization.lock().ok()?;
    let exchange = held.as_mut()?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(input.code_verifier.as_bytes()));
    if exchange.consumed
        || exchange.expires <= Instant::now()
        || !same(exchange.code.as_bytes(), input.code.as_bytes())
        || !same(exchange.state.as_bytes(), input.state.as_bytes())
        || !same(exchange.challenge.as_bytes(), challenge.as_bytes())
    {
        return None;
    }
    if shared
        .pairing
        .lock()
        .ok()?
        .as_ref()
        .is_some_and(|grant| grant.active().is_err())
    {
        return None;
    }
    exchange.consumed = true;
    let mut descriptor = serde_json::json!({"version": 1, "url": format!("http://{}/mcp", shared.authority), "token": shared.token});
    if let Some(pairing) = shared.pairing.lock().ok()?.as_ref() {
        descriptor["pairing"] = pairing.descriptor();
    }
    Some(descriptor.to_string())
}

pub(super) async fn exchange(
    shared: &Arc<Shared>,
    request: Request<Incoming>,
) -> Response<Full<Bytes>> {
    let admitted = !shared.stop.is_cancelled()
        && header(&request, header::HOST) == Some(shared.authority.as_str())
        && request.uri().query().is_none()
        && !request.headers().contains_key(header::ORIGIN)
        && request.method() == Method::POST
        && header(&request, header::CONTENT_TYPE)
            .is_some_and(|value| value.split(';').next() == Some("application/json"));
    let body = if admitted {
        match tokio::time::timeout(
            Duration::from_secs(5),
            Limited::new(request.into_body(), 2048).collect(),
        )
        .await
        {
            Ok(Ok(body)) => match serde_json::from_slice::<Redemption>(&body.to_bytes()) {
                Ok(input) => {
                    let shared = shared.clone();
                    tauri::async_runtime::spawn_blocking(move || redeem(&shared, input))
                        .await
                        .ok()
                        .flatten()
                }
                Err(_) => None,
            },
            _ => None,
        }
    } else {
        None
    };
    Response::builder()
        .status(if body.is_some() {
            StatusCode::OK
        } else {
            StatusCode::NOT_FOUND
        })
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Full::new(body.unwrap_or_default().into()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::{server::conn::http1, service::service_fn};
    use hyper_util::rt::TokioIo;
    use std::net::Ipv4Addr;
    use tokio::net::TcpListener;
    const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    async fn receiver(
        status: StatusCode,
    ) -> (
        String,
        oneshot::Receiver<serde_json::Value>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let url = format!("http://{}/buzz/authorize", listener.local_addr().unwrap());
        let (sent, received) = oneshot::channel();
        let sent = Arc::new(Mutex::new(Some(sent)));
        let task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            http1::Builder::new()
                .serve_connection(
                    TokioIo::new(socket),
                    service_fn(move |request: Request<Incoming>| {
                        let sent = sent.clone();
                        async move {
                            let body = request.into_body().collect().await.unwrap().to_bytes();
                            sent.lock()
                                .unwrap()
                                .take()
                                .unwrap()
                                .send(serde_json::from_slice(&body).unwrap())
                                .unwrap();
                            Ok::<_, Infallible>(
                                Response::builder()
                                    .status(status)
                                    .body(Full::new(Bytes::from_static(b"{}")))
                                    .unwrap(),
                            )
                        }
                    }),
                )
                .await
                .unwrap();
        });
        (url, received, task)
    }
    fn request(callback: &str) -> Authorization {
        Authorization {
            callback: callback.into(),
            state: "A".repeat(43),
            code_challenge: CHALLENGE.into(),
            approval: None,
            resume: None,
        }
    }
    #[test]
    fn callback_requires_an_exact_literal_loopback_endpoint() {
        assert!(callback(&request("http://127.0.0.1:1234/buzz/authorize")).is_ok());
        for url in [
            "http://localhost:1234/buzz/authorize",
            "https://127.0.0.1:1234/buzz/authorize",
            "http://127.0.0.1:80/buzz/authorize",
            "http://127.1:1234/buzz/authorize",
            "http://127.0.0.1:1234/extra/../buzz/authorize",
            "http://127.0.0.1:1234/buzz/authorize?x=1",
            "http://user@127.0.0.1:1234/buzz/authorize",
            "http://127.0.0.1:1234/buzz/authorize#x",
        ] {
            assert!(callback(&request(url)).is_err(), "{url}");
        }
    }
    #[tokio::test]
    async fn exchanges_once_with_the_verifier_and_state_before_expiry() {
        let servers = HostMcpServers::default();
        let info = servers
            .serve(
                servers.page(),
                "plugin".into(),
                Channel::new(|_| Ok(())),
                false,
            )
            .unwrap();
        let shared = servers.owned("plugin", info.handle).unwrap();
        *shared.authorization.lock().unwrap() = Some(Exchange {
            code: "C".repeat(43),
            state: "A".repeat(43),
            challenge: CHALLENGE.into(),
            expires: Instant::now() + CODE_LIFETIME,
            consumed: false,
        });
        let input = || Redemption {
            version: 1,
            code: "C".repeat(43),
            state: "A".repeat(43),
            code_verifier: VERIFIER.into(),
        };
        let mut wrong = input();
        wrong.code_verifier = "x".repeat(43);
        assert!(redeem(&shared, wrong).is_none());
        let mut wrong = input();
        wrong.state = "B".repeat(43);
        assert!(redeem(&shared, wrong).is_none());
        let result = redeem(&shared, input()).unwrap();
        let descriptor: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(descriptor["url"], info.url);
        assert!(descriptor["token"]
            .as_str()
            .is_some_and(|token| same(token.as_bytes(), info.token.as_bytes())));
        assert!(redeem(&shared, input()).is_none());
        {
            let mut held = shared.authorization.lock().unwrap();
            let exchange = held.as_mut().unwrap();
            exchange.consumed = false;
            exchange.expires = Instant::now() - Duration::from_secs(1);
        }
        assert!(redeem(&shared, input()).is_none());
        servers.stop_all();
    }

    #[tokio::test]
    async fn callback_publishes_the_code_before_exchange_and_revokes_unused_grants() {
        let servers = HostMcpServers::default();
        let info = servers
            .serve(
                servers.page(),
                "plugin".into(),
                Channel::new(|_| Ok(())),
                false,
            )
            .unwrap();
        let shared = servers.owned("plugin", info.handle).unwrap();
        let (url, received, task) = receiver(StatusCode::OK).await;
        authorize(Some(shared.clone()), request(&url))
            .await
            .unwrap();
        let callback = received.await.unwrap();
        assert_eq!(callback["outcome"], "authorized");
        assert!(callback.get("token").is_none());
        let body = serde_json::json!({ "version": 1, "code": callback["code"], "state": callback["state"], "code_verifier": VERIFIER });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let endpoint = callback["exchange_url"].as_str().unwrap();
        let blocked = client
            .post(endpoint)
            .header("Origin", "https://example.test")
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(blocked.status(), StatusCode::NOT_FOUND);
        let response = client.post(endpoint).json(&body).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let descriptor: serde_json::Value = response.json().await.unwrap();
        assert_eq!(descriptor["url"], info.url);
        assert!(descriptor["token"]
            .as_str()
            .is_some_and(|token| same(token.as_bytes(), info.token.as_bytes())));
        assert_eq!(
            client
                .post(endpoint)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        tokio::time::pause();
        tokio::time::advance(CODE_LIFETIME).await;
        tokio::time::timeout(Duration::from_secs(1), shared.stop.cancelled())
            .await
            .expect("Unused grant expires");
        assert!(shared.stop.is_cancelled());
        task.abort();
        servers.stop_all();
    }

    #[tokio::test]
    async fn failed_callback_closes_the_grant_and_denial_sends_no_code() {
        let servers = HostMcpServers::default();
        let info = servers
            .serve(
                servers.page(),
                "plugin".into(),
                Channel::new(|_| Ok(())),
                false,
            )
            .unwrap();
        let shared = servers.owned("plugin", info.handle).unwrap();
        let (url, received, task) = receiver(StatusCode::FORBIDDEN).await;
        assert!(authorize(Some(shared.clone()), request(&url))
            .await
            .is_err());
        assert!(shared.stop.is_cancelled());
        assert_eq!(received.await.unwrap()["outcome"], "authorized");
        task.abort();
        let (url, received, task) = receiver(StatusCode::OK).await;
        authorize(None, request(&url)).await.unwrap();
        let callback = received.await.unwrap();
        assert_eq!(callback["outcome"], "denied");
        assert!(callback.get("code").is_none());
        task.abort();
        servers.stop_all();
    }
}
