use super::*;
use futures_util::StreamExt;
use http_body_util::StreamBody;
use tauri::ipc::InvokeResponseBody;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

const PLUGIN: &str = "buzz.agents";
const SESSION: &str = "5dd650cf-d3a5-4d70-b06f-d84a67ff523a";

/// One request the fake gateway received.
#[derive(Debug)]
struct Seen {
    method: String,
    path: String,
    headers: HeaderMap,
    body: Bytes,
}

/// A fake gateway on loopback. `x-test` picks its answer: `hold` streams one
/// event and never ends (reporting when the connection drops), `flood`
/// streams 64 MiB in 1 MiB chunks (reporting a drop too),
/// `300`, `305` and `307` answer with a Location, `304` with an ETag,
/// `busy` answers 503 as text, `hop`
/// nominates `x-hop` in `Connection`; otherwise 200 JSON.
struct FakeGateway {
    origin: &'static str,
    seen: mpsc::UnboundedReceiver<Seen>,
    dropped: mpsc::UnboundedReceiver<()>,
}
async fn fake_gateway() -> FakeGateway {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let origin: &'static str =
        Box::leak(format!("http://{}", listener.local_addr().unwrap()).into_boxed_str());
    let (seen_tx, seen) = mpsc::unbounded_channel();
    let (dropped_tx, dropped) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            let seen_tx = seen_tx.clone();
            let dropped_tx = dropped_tx.clone();
            tokio::spawn(async move {
                let service = service_fn(move |request: Request<Incoming>| {
                    let seen_tx = seen_tx.clone();
                    let dropped_tx = dropped_tx.clone();
                    async move {
                        let (parts, body) = request.into_parts();
                        let body = body.collect().await.unwrap().to_bytes();
                        let mode = parts.headers.get("x-test").cloned();
                        let _ = seen_tx.send(Seen {
                            method: parts.method.to_string(),
                            path: parts.uri.to_string(),
                            headers: parts.headers,
                            body: body.clone(),
                        });
                        Ok::<_, Infallible>(answer(mode.as_ref(), body, dropped_tx))
                    }
                });
                let _ = http1::Builder::new()
                    .serve_connection(TokioIo::new(socket), service)
                    .await;
            });
        }
    });
    FakeGateway {
        origin,
        seen,
        dropped,
    }
}

fn answer(mode: Option<&HeaderValue>, body: Bytes, dropped: mpsc::UnboundedSender<()>) -> Reply {
    struct Report(mpsc::UnboundedSender<()>);
    impl Drop for Report {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }
    match mode.and_then(|mode| mode.to_str().ok()) {
        Some("hold") => {
            let report = Report(dropped);
            let first = futures_util::stream::once(async {
                Ok::<_, BoxError>(Frame::data(Bytes::from_static(b"event: ping\n\n")))
            });
            let rest = StreamExt::map(
                futures_util::stream::pending(),
                move |frame: Frame<Bytes>| {
                    let _ = &report;
                    Ok(frame)
                },
            );
            Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(BodyExt::boxed(StreamBody::new(first.chain(rest))))
                .unwrap()
        }
        Some("flood") => {
            let report = Report(dropped);
            // Each chunk outsizes the listener's write buffer, so a stalled
            // harness leaves hyper with no reason to poll the body again.
            let chunks = futures_util::stream::iter(0..64).map(move |_| {
                let _ = &report;
                Ok::<_, BoxError>(Frame::data(Bytes::from(vec![b'x'; 1024 * 1024])))
            });
            Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(BodyExt::boxed(StreamBody::new(chunks)))
                .unwrap()
        }
        Some("hop") => Response::builder()
            .header(header::CONNECTION, "X-Hop")
            .header("x-hop", "1")
            .header("x-kept", "1")
            .body(
                Full::new(Bytes::new())
                    .map_err(|never| match never {})
                    .boxed(),
            )
            .unwrap(),
        Some(status @ ("300" | "305" | "307")) => Response::builder()
            .status(StatusCode::from_bytes(status.as_bytes()).unwrap())
            .header(header::LOCATION, "https://elsewhere.example/v1/messages")
            .body(
                Full::new(Bytes::new())
                    .map_err(|never| match never {})
                    .boxed(),
            )
            .unwrap(),
        Some("304") => Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, "\"catalog\"")
            .body(
                Full::new(Bytes::new())
                    .map_err(|never| match never {})
                    .boxed(),
            )
            .unwrap(),
        Some("busy") => Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header(header::CONTENT_TYPE, "text/plain")
            .header(header::RETRY_AFTER, "2")
            .body(
                Full::new(Bytes::from_static(b"busy"))
                    .map_err(|never| match never {})
                    .boxed(),
            )
            .unwrap(),
        _ => Response::builder()
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::SET_COOKIE, "track=1")
            .body(Full::new(body).map_err(|never| match never {}).boxed())
            .unwrap(),
    }
}

fn channel() -> (
    Channel<ForwardEvent>,
    mpsc::UnboundedReceiver<serde_json::Value>,
) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            let _ = sender.send(serde_json::from_str(&json).unwrap());
        }
        Ok(())
    });
    (channel, receiver)
}

fn headers(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect()
}
const HUMAN: &str = "8680b8da79033487b62a47ef0836491abd11b67525295c4fd079669b2280eea1";
const AGENT: &str = "4acc49cb93576448ba82e631688c51a40bf03d6a889d78fddf57917d198de10f";
const MESSAGE: &str = "c456387b6cf631e03ea1dba924de057151ab94da50d56a4c435bfff921386684";
const THREAD: &str = "9f1e540e497aff0cf240e0b1638db1a6a4c7b3d140de9d83af5a0922c5447e56";
/// Discovery's identity: no channel, message or thread.
fn discovery() -> BTreeMap<String, String> {
    headers(&[
        ("x-gw-launcher-client", "client-a"),
        (
            "x-gw-launcher-session",
            "0b9d7c55-1f43-4a49-9a55-3f7f0a3e2c11",
        ),
        ("x-gw-ctx-human-pubkey", HUMAN),
        ("x-gw-ctx-agent-pubkey", AGENT),
        (
            "x-gw-ctx-community-id",
            "6f1d2c3b-4a5e-4f60-8b7a-9c0d1e2f3a4b",
        ),
    ])
}
/// All eight: discovery's plus the turn.
fn inference() -> BTreeMap<String, String> {
    let mut headers = discovery();
    headers.extend(self::headers(&[
        (
            "x-gw-ctx-channel-id",
            "9d424bb2-58b3-4bf6-8a0a-cb1e74229e59",
        ),
        ("x-gw-ctx-message-id", MESSAGE),
        ("x-gw-ctx-thread-id", THREAD),
    ]));
    headers
}

struct Opening {
    id: u64,
    url: String,
    events: mpsc::UnboundedReceiver<serde_json::Value>,
}
fn open(forward: &HostForward, harness: Harness, revision: u64) -> Opening {
    let (channel, events) = channel();
    match forward
        .open(
            forward.page(),
            PLUGIN,
            "route-a",
            revision,
            harness,
            None,
            &inference(),
            &discovery(),
            channel,
        )
        .unwrap()
    {
        Opened::Opened { id, url } => Opening { id, url, events },
        refused => panic!("not opened: {refused:?}"),
    }
}
/// A goose generation ready for inference after explicit session association.
fn associated(forward: &HostForward, revision: u64) -> Opening {
    let generation = open(forward, Harness::Goose, revision);
    forward
        .associate(PLUGIN, generation.id, SESSION.into())
        .unwrap();
    generation
}
/// A neutral gateway configuration on `origin`, as the descriptor's native
/// subset would hold it.
fn config(origin: &str) -> Option<Gateway> {
    let field = |field: &str, name: &str| (field.to_owned(), name.to_owned());
    Some(Gateway {
        gateway: origin.to_owned(),
        launcher_client: "client-a".into(),
        headers: BTreeMap::from([
            field("launcher_client", "x-gw-launcher-client"),
            field("launcher_session", "x-gw-launcher-session"),
            field("human_pubkey", "x-gw-ctx-human-pubkey"),
            field("agent_pubkey", "x-gw-ctx-agent-pubkey"),
            field("community_id", "x-gw-ctx-community-id"),
            field("channel_id", "x-gw-ctx-channel-id"),
            field("message_id", "x-gw-ctx-message-id"),
            field("thread_id", "x-gw-ctx-thread-id"),
        ]),
        reserved_prefixes: vec!["x-gw-ctx-".into()],
        upstreams: BTreeMap::from([
            field("claude-code", "/upstream/claude"),
            field("goose", "/upstream/goose"),
        ]),
    })
}
fn ready(origin: &str) -> HostForward {
    let forward = HostForward::new(config(origin));
    forward
        .push(forward.page(), PLUGIN, "route-a", 1, true)
        .unwrap();
    forward
}

fn messages(url: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .post(format!("{url}/serving-endpoints/model-a/invocations"))
        .header("agent-session-id", SESSION)
        .header("x-api-key", "placeholder")
        .header("content-type", "application/json")
}

async fn recv<T>(receiver: &mut mpsc::UnboundedReceiver<T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), receiver.recv())
        .await
        .expect("in time")
        .expect("open")
}

/// Sends a raw request line and head to `url`'s listener, returning the
/// response's status line.
async fn raw(url: &str, head: &str) -> String {
    let authority = url.trim_start_matches("http://").split('/').next().unwrap();
    let mut socket = TcpStream::connect(authority).await.unwrap();
    socket.write_all(head.as_bytes()).await.unwrap();
    let mut response = vec![0; 512];
    let read = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut response))
        .await
        .unwrap()
        .unwrap();
    String::from_utf8_lossy(&response[..read])
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned()
}
fn handle(url: &str) -> &str {
    url.rsplit('/').next().unwrap()
}

#[test]
fn compose_matches_the_contract_vectors() {
    let neutral = config("https://gateway.example").unwrap();
    // The frontend composer's compose vectors, under the neutral configuration.
    let map = |pairs: &[(&str, &str)]| {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    };
    type Pairs = &'static [(&'static str, &'static str)];
    let cases: [(Pairs, Pairs, Pairs); 3] = [
        (
            &[
                ("Authorization", "Bearer x"),
                ("content-type", "application/json"),
            ],
            &[("x-gw-launcher-client", "client-a")],
            &[
                ("authorization", "Bearer x"),
                ("content-type", "application/json"),
                ("x-gw-launcher-client", "client-a"),
            ],
        ),
        (
            &[
                ("X-GW-Launcher-Session", "stale"),
                ("x-gw-ctx-message-id", "stale"),
                ("X-GW-CTX-THREAD-ID", "stale"),
                ("x-gw-launcher-client", "other"),
            ],
            &[("x-gw-launcher-client", "client-a")],
            &[("x-gw-launcher-client", "client-a")],
        ),
        (
            &[
                ("x-gw-request-id", "keep"),
                ("x-gw-launcher", "keep"),
                ("x-gw-ctx", "keep"),
            ],
            &[],
            &[
                ("x-gw-request-id", "keep"),
                ("x-gw-launcher", "keep"),
                ("x-gw-ctx", "keep"),
            ],
        ),
    ];
    for (assembled, bundled, composed) in cases {
        let bundled = bundle(&neutral, &headers(bundled)).unwrap();
        assert_eq!(compose(&neutral, &map(assembled), &bundled), map(composed));
    }
    for refused in [
        headers(&[("authorization", "Bearer x")]),
        headers(&[("X-GW-Launcher-Client", "client-a")]),
        headers(&[("x-gw-ctx-message-id", "two words")]),
        headers(&[("x-gw-ctx-message-id", "")]),
        headers(&[("x-gw-ctx-message-id", &"a".repeat(2048))]),
        headers(&[("x-gw-ctx-message-ID", MESSAGE)]),
        // Retired fields, and any other name under the reserved prefix.
        headers(&[("x-gw-ctx-purpose", "inference")]),
        headers(&[("x-gw-ctx-trigger-kind", "message")]),
        headers(&[("x-gw-ctx-trigger-id", MESSAGE)]),
        headers(&[("x-gw-ctx-trigger-author-pubkey", HUMAN)]),
        headers(&[("x-gw-ctx-message-created-at", "1793820000")]),
        headers(&[("x-gw-ctx-unknown", "x")]),
    ] {
        assert!(bundle(&neutral, &refused).is_err(), "{refused:?}");
    }
    // `_` aliases of reserved names are reserved too, and never bundled.
    let composed = compose(
        &neutral,
        &map(&[
            ("x_gw_ctx_message_id", "forged"),
            ("X_GW_Launcher_Client", "x"),
        ]),
        &HeaderMap::new(),
    );
    assert!(composed.is_empty());
    assert!(bundle(&neutral, &headers(&[("x_gw_ctx_message_id", "x")])).is_err());
    // A request carries whichever names apply, down to the client alone.
    for subset in [
        inference(),
        discovery(),
        headers(&[("x-gw-launcher-client", "client-a")]),
        BTreeMap::new(),
    ] {
        assert_eq!(bundle(&neutral, &subset).unwrap().len(), subset.len());
    }
    // The connection's own headers never pass, whatever the harness sent.
    let composed = compose(
        &neutral,
        &map(&[
            ("host", "127.0.0.1:1"),
            ("origin", "x"),
            ("connection", "close"),
        ]),
        &HeaderMap::new(),
    );
    assert!(composed.is_empty());
}

#[tokio::test]
async fn admission_matches_the_reference_reducer() {
    // The frontend's admission vectors.
    // A step is push(revision, admits), open(name, revision) or request(name);
    // reload closes the scope. Requests go through the listener, so this is
    // the admission a harness actually meets.
    enum Step {
        Push(u64, bool, Pushed),
        Open(&'static str, u64, Option<(u64, bool)>),
        Request(&'static str, bool),
        Reload,
    }
    use Step::*;
    let applied = |revoked| Pushed::Applied { revoked };
    let vectors: Vec<(&str, Vec<Step>)> = vec![
        (
            "pending then ready opens at the ready revision only",
            vec![
                Push(1, false, applied(0)),
                Open("g1", 1, Some((1, false))),
                Push(2, true, applied(0)),
                Open("g1", 1, Some((2, true))),
                Open("g1", 2, None),
                Request("g1", true),
            ],
        ),
        (
            "a stale probe success pushes nothing and opens nothing",
            vec![
                Push(1, false, applied(0)),
                Push(2, false, applied(0)),
                Open("g1", 2, Some((2, false))),
            ],
        ),
        (
            "reordered pushes: ready before the pending it followed",
            vec![
                Push(2, true, applied(0)),
                Push(1, false, Pushed::Stale),
                Open("g1", 2, None),
                Push(2, false, Pushed::Stale),
                Request("g1", true),
            ],
        ),
        (
            "a higher revision terminally revokes, and a later ready never reopens",
            vec![
                Push(2, true, applied(0)),
                Open("g1", 2, None),
                Push(3, false, applied(1)),
                Request("g1", false),
                Push(4, true, applied(0)),
                Request("g1", false),
                Open("g2", 4, None),
                Request("g2", true),
            ],
        ),
        (
            "a ready revision revokes generations opened under older ones",
            vec![
                Push(2, true, applied(0)),
                Open("g1", 2, None),
                Push(4, true, applied(1)),
                Request("g1", false),
            ],
        ),
        (
            "page reload revokes the old scope's generations",
            vec![
                Push(2, true, applied(0)),
                Open("g1", 2, None),
                Reload,
                Request("g1", false),
                Push(1, false, applied(0)),
                Push(2, true, applied(0)),
                Request("g1", false),
                Open("g2", 2, None),
            ],
        ),
    ];
    let mut gateway = fake_gateway().await;
    for (name, steps) in vectors {
        let forward = HostForward::new(config(gateway.origin));
        let mut opened: HashMap<&str, Opening> = HashMap::new();
        for step in steps {
            match step {
                Push(revision, admits, expected) => {
                    let pushed = forward
                        .push(forward.page(), PLUGIN, "route-a", revision, admits)
                        .unwrap();
                    assert_eq!(pushed, expected, "{name}");
                }
                Open(label, revision, refused) => {
                    let (channel, events) = channel();
                    let result = forward
                        .open(
                            forward.page(),
                            PLUGIN,
                            "route-a",
                            revision,
                            Harness::Goose,
                            None,
                            &inference(),
                            &discovery(),
                            channel,
                        )
                        .unwrap();
                    match (result, refused) {
                        (Opened::Opened { id, url }, None) => {
                            forward.associate(PLUGIN, id, SESSION.into()).unwrap();
                            opened.insert(label, Opening { id, url, events });
                        }
                        (Opened::Refused { current, admits }, Some(expected)) => {
                            assert_eq!((current, admits), expected, "{name}");
                        }
                        (result, _) => panic!("{name}: {result:?}"),
                    }
                }
                Request(label, admitted) => {
                    let url = &opened[label].url;
                    let status = messages(url).body("{}").send().await.unwrap().status();
                    let expected = if admitted {
                        StatusCode::OK
                    } else if forward.registry().generations.contains_key(handle(url)) {
                        StatusCode::GONE
                    } else {
                        StatusCode::NOT_FOUND
                    };
                    assert_eq!(status, expected, "{name}");
                    if admitted {
                        recv(&mut gateway.seen).await;
                    }
                }
                Reload => forward.stop_all(),
            }
        }
    }
    // A handle opens once: every open mints a new one.
    let forward = ready(gateway.origin);
    let first = associated(&forward, 1);
    let second = associated(&forward, 1);
    assert_ne!(handle(&first.url), handle(&second.url));
    assert_eq!(
        URL_SAFE_NO_PAD.decode(handle(&first.url)).unwrap().len(),
        32
    );
}

#[tokio::test]
async fn forwards_inference_with_only_the_bundle_as_provenance() {
    let mut gateway = fake_gateway().await;
    let forward = ready(gateway.origin);
    let mut generation = associated(&forward, 1);
    let response = messages(&generation.url)
        .header("Authorization", "Bearer owner-sentinel")
        .header("aUtHoRiZaTiOn", "Bearer second-sentinel")
        .header("x-gw-ctx-channel-id", "forged")
        .header("X-GW-Launcher-Client", "forged")
        .header("x-gw-request-id", "keep")
        .header("origin-trial", "kept")
        .body(r#"{"stream":true}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().get(header::SET_COOKIE).is_none());
    assert_eq!(response.text().await.unwrap(), r#"{"stream":true}"#);
    let seen = recv(&mut gateway.seen).await;
    assert_eq!(seen.method, "POST");
    assert_eq!(
        seen.path,
        "/upstream/goose/serving-endpoints/model-a/invocations"
    );
    assert_eq!(seen.body, Bytes::from_static(br#"{"stream":true}"#));
    let header = |name: &str| seen.headers.get(name).map(|value| value.to_str().unwrap());
    assert_eq!(header("x-gw-launcher-client"), Some("client-a"));
    for (name, value) in inference() {
        assert_eq!(seen.headers.get_all(&name).iter().count(), 1, "{name}");
        assert_eq!(header(&name), Some(value.as_str()), "{name}");
    }
    assert_eq!(header("x-gw-request-id"), Some("keep"));
    assert!(seen.headers.get(header::AUTHORIZATION).is_none());
    assert_eq!(header("x-api-key"), Some("placeholder"));
    assert_eq!(header("agent-session-id"), Some(SESSION));
    assert_eq!(
        header("host"),
        Some(gateway.origin.trim_start_matches("http://"))
    );
    assert_eq!(
        recv(&mut generation.events).await,
        serde_json::json!({ "type": "admitted", "request": 1, "class": "inference", "child": false })
    );
    assert_eq!(
        recv(&mut generation.events).await,
        serde_json::json!({ "type": "finished", "request": 1, "status": 200, "aborted": false })
    );

    // Discovery carries the discovery bundle, with or without the session.
    let hello = reqwest::Client::new()
        .get(format!("{}/api/2.0/serving-endpoints", generation.url))
        .header("Authorization", "Bearer discovery-sentinel")
        .header("agent-session-id", SESSION)
        .send()
        .await
        .unwrap();
    assert_eq!(hello.status(), StatusCode::OK);
    let seen = recv(&mut gateway.seen).await;
    assert_eq!(seen.path, "/upstream/goose/api/2.0/serving-endpoints");
    assert_eq!(recv(&mut generation.events).await["type"], "admitted");
    assert_eq!(
        recv(&mut generation.events).await,
        serde_json::json!({ "type": "finished", "request": 2, "status": 200, "aborted": false })
    );
    assert_eq!(seen.headers["x-gw-ctx-agent-pubkey"], AGENT);
    assert!(seen.headers.get(header::AUTHORIZATION).is_none());
    assert_eq!(seen.headers["agent-session-id"], SESSION);
    for (name, value) in discovery() {
        assert_eq!(seen.headers[&name], value, "{name}");
    }
    for turn in [
        "x-gw-ctx-channel-id",
        "x-gw-ctx-message-id",
        "x-gw-ctx-thread-id",
    ] {
        assert!(seen.headers.get(turn).is_none(), "{turn}");
    }
}

#[tokio::test]
async fn the_final_url_keeps_the_configured_origin_and_base() {
    let mut gateway = fake_gateway().await;
    let with_base = |base: &str| {
        let mut config = config(gateway.origin).unwrap();
        config.upstreams.insert("goose".into(), base.into());
        let forward = HostForward::new(Some(config));
        forward
            .push(forward.page(), PLUGIN, "route-a", 1, true)
            .unwrap();
        forward
    };
    let forward = with_base("/a/b-c/d.e");
    let generation = associated(&forward, 1);
    let response = messages(&generation.url).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        recv(&mut gateway.seen).await.path,
        "/a/b-c/d.e/serving-endpoints/model-a/invocations"
    );
    // The descriptor refuses these; were one to reach the transport anyway,
    // the target's parse must neither move the origin nor rewrite the base.
    for base in [
        "@elsewhere.example",
        ":1@elsewhere.example",
        "/a/../b",
        "/a/./b",
        "/%2e%2e/b",
        "/a?x",
        "/a#x",
    ] {
        let forward = with_base(base);
        let generation = associated(&forward, 1);
        let response = messages(&generation.url).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY, "{base}");
        assert!(
            response
                .text()
                .await
                .unwrap()
                .contains("gateway_upstream_invalid"),
            "{base}"
        );
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(200), gateway.seen.recv())
            .await
            .is_err(),
        "nothing else reached the gateway"
    );
}

#[tokio::test]
async fn passes_upstream_status_and_refuses_redirects() {
    let mut gateway = fake_gateway().await;
    let forward = ready(gateway.origin);
    let mut generation = associated(&forward, 1);
    let busy = messages(&generation.url)
        .header("x-test", "busy")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(busy.headers()[header::RETRY_AFTER], "2");
    assert_eq!(busy.headers()[header::CONTENT_TYPE], "text/plain");
    assert_eq!(busy.text().await.unwrap(), "busy");
    recv(&mut gateway.seen).await;

    let redirects = ["300", "305", "307"];
    for status in redirects {
        let redirected = messages(&generation.url)
            .header("x-test", status)
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(
            redirected.status(),
            StatusCode::BAD_GATEWAY,
            "upstream {status}"
        );
        assert!(redirected.headers().get(header::LOCATION).is_none());
    }

    let cached = reqwest::Client::new()
        .get(format!("{}/api/2.0/serving-endpoints", generation.url))
        .header("x-test", "304")
        .header(header::IF_NONE_MATCH, "\"catalog\"")
        .send()
        .await
        .unwrap();
    assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(cached.headers()[header::ETAG], "\"catalog\"");
    assert!(cached.bytes().await.unwrap().is_empty());

    let mut events = Vec::new();
    for _ in 0..2 * (redirects.len() + 2) {
        events.push(recv(&mut generation.events).await);
    }
    // One response's end may race the next request's admission.
    for request in 2..2 + redirects.len() {
        assert!(events.contains(
            &serde_json::json!({ "type": "finished", "request": request, "status": 502, "aborted": false })
        ));
    }
    assert!(events.contains(
        &serde_json::json!({ "type": "finished", "request": redirects.len() + 2, "status": 304, "aborted": false })
    ));
}

#[tokio::test]
async fn only_allowlisted_paths_reach_the_gateway() {
    let mut gateway = fake_gateway().await;
    let forward = ready(gateway.origin);
    let goose = associated(&forward, 1);
    let host = goose
        .url
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap();
    let request = |method: &str, target: &str, extra: &str| {
        format!(
            "{method} {target} HTTP/1.1\r\nHost: {host}\r\n{extra}agent-session-id: {SESSION}\r\ncontent-length: 0\r\n\r\n"
        )
    };
    let g = handle(&goose.url);
    for (method, target, extra) in [
        ("POST", format!("/{g}/serving-endpoints/m/invocations/"), ""),
        ("POST", format!("/{g}/serving-endpoints//m/invocations"), ""),
        (
            "POST",
            format!("/{g}/serving-endpoints/./m/invocations"),
            "",
        ),
        (
            "POST",
            format!("/{g}/serving-endpoints/x/../m/invocations"),
            "",
        ),
        (
            "POST",
            format!("/{g}/serving-endpoints/%6D/invocations"),
            "",
        ),
        (
            "POST",
            format!("/{g}/serving-endpoints/m/invocations?beta=true"),
            "",
        ),
        ("GET", format!("/{g}/serving-endpoints/m/invocations"), ""),
        ("GET", format!("/{g}/other/probe"), ""),
        ("GET", format!("/{g}/https://elsewhere.example/"), ""),
        ("GET", "http://elsewhere.example/".to_owned(), ""),
        // Absolute form is refused even naming this listener and an allowed route.
        (
            "GET",
            format!("http://{host}/{g}/api/2.0/serving-endpoints"),
            "",
        ),
        ("GET", format!("/{g}/api/2.0/serving-endpoints/..%2Fx"), ""),
        ("GET", format!("/{g}/api/2.0/serving-endpoints/.hidden"), ""),
        (
            "POST",
            format!("/{g}/serving-endpoints/m/invocations/x"),
            "",
        ),
        // Claude routes no longer belong to the native transport.
        ("HEAD", format!("/{g}/api/hello"), ""),
        ("POST", format!("/{g}/v1/messages"), ""),
        ("POST", format!("/{g}/v1/messages?beta=true"), ""),
        (
            "POST",
            format!("/{g}/serving-endpoints/m/invocations"),
            "Origin: https://page.example\r\n",
        ),
        (
            "POST",
            "/unknown/serving-endpoints/m/invocations".to_owned(),
            "",
        ),
    ] {
        let status = raw(&goose.url, &request(method, &target, extra)).await;
        assert!(status.contains(" 404 "), "{method} {target}: {status}");
    }
    let wrong_host = format!(
        "POST /{g}/serving-endpoints/m/invocations HTTP/1.1\r\nHost: localhost\r\nagent-session-id: {SESSION}\r\ncontent-length: 0\r\n\r\n"
    );
    assert!(raw(&goose.url, &wrong_host).await.contains(" 404 "));
    assert!(
        tokio::time::timeout(Duration::from_millis(200), gateway.seen.recv())
            .await
            .is_err(),
        "nothing reached the gateway"
    );
}

#[tokio::test]
async fn inference_must_name_the_generation_session() {
    let mut gateway = fake_gateway().await;
    let mut forward = ready(gateway.origin);
    forward.rendezvous = Duration::from_millis(100);
    let mut associated_goose = associated(&forward, 1);
    let client = reqwest::Client::new();
    let post = || {
        client
            .post(format!(
                "{}/serving-endpoints/model-a/invocations",
                associated_goose.url
            ))
            .body("{}")
    };
    assert_eq!(
        post().send().await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    let other = post().header("agent-session-id", "other");
    assert_eq!(
        other.send().await.unwrap().status(),
        StatusCode::GATEWAY_TIMEOUT
    );
    // A session no child could have is refused without waiting.
    let invalid = post().header("agent-session-id", "other session");
    assert_eq!(
        invalid.send().await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    let twice = post()
        .header("agent-session-id", SESSION)
        .header("agent-session-id", SESSION);
    assert_eq!(
        twice.send().await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        recv(&mut associated_goose.events).await,
        serde_json::json!({ "type": "refused", "status": 400, "reason": "session_mismatch" })
    );

    // goose: discovery before association, inference only after it, once.
    let goose = open(&forward, Harness::Goose, 1);
    let endpoints = client
        .get(format!("{}/api/2.0/serving-endpoints", goose.url))
        .send()
        .await
        .unwrap();
    assert_eq!(endpoints.status(), StatusCode::OK);
    assert_eq!(
        recv(&mut gateway.seen).await.path,
        "/upstream/goose/api/2.0/serving-endpoints"
    );
    let invoke = |session: &str| {
        client
            .post(format!(
                "{}/serving-endpoints/model-a/invocations",
                goose.url
            ))
            .header("agent-session-id", session)
            .body("{}")
    };
    assert_eq!(
        invoke("20261104_1").send().await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    // Discovery may already name its session before association.
    let early = client
        .get(format!("{}/api/2.0/serving-endpoints/m", goose.url))
        .header("agent-session-id", "20261104_1")
        .send()
        .await
        .unwrap();
    assert_eq!(early.status(), StatusCode::OK);
    recv(&mut gateway.seen).await;
    assert!(forward
        .associate("other.plugin", goose.id, "20261104_1".into())
        .is_err());
    forward
        .associate(PLUGIN, goose.id, "20261104_1".into())
        .unwrap();
    assert!(forward
        .associate(PLUGIN, goose.id, "20261104_1".into())
        .is_err());
    assert!(forward
        .associate(PLUGIN, associated_goose.id, "20261104_1".into())
        .is_err());
    // Another session may be a child not yet registered: it waits, then is
    // refused, and nothing reaches the gateway.
    assert_eq!(
        invoke("20261104_2").send().await.unwrap().status(),
        StatusCode::GATEWAY_TIMEOUT
    );
    assert_eq!(
        invoke("20261104_1").send().await.unwrap().status(),
        StatusCode::OK
    );
    let seen = recv(&mut gateway.seen).await;
    assert_eq!(
        seen.path,
        "/upstream/goose/serving-endpoints/model-a/invocations"
    );
    assert_eq!(seen.headers["x-gw-ctx-message-id"], MESSAGE);
    let model = client
        .get(format!("{}/api/2.0/serving-endpoints/m", goose.url))
        .header("agent-session-id", "20261104_2")
        .send()
        .await
        .unwrap();
    assert_eq!(model.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn seal_is_terminal_while_admitted_streams_finish() {
    let mut gateway = fake_gateway().await;
    let forward = ready(gateway.origin);
    let mut generation = associated(&forward, 1);
    let mut stream = messages(&generation.url)
        .header("x-test", "hold")
        .body("{}")
        .send()
        .await
        .unwrap();
    recv(&mut gateway.seen).await;
    forward.seal(PLUGIN, generation.id).unwrap();
    // The admitted stream still flows after the seal.
    assert_eq!(
        &stream.chunk().await.unwrap().unwrap()[..],
        b"event: ping\n\n"
    );
    let late = messages(&generation.url).body("{}").send().await.unwrap();
    assert_eq!(late.status(), StatusCode::GONE);
    assert!(late
        .text()
        .await
        .unwrap()
        .contains("gateway_generation_ended"));
    // A later ready revision doesn't reopen it, and nor does sealing again.
    forward
        .push(forward.page(), PLUGIN, "route-a", 1, true)
        .unwrap();
    forward.seal(PLUGIN, generation.id).unwrap();
    assert_eq!(
        messages(&generation.url)
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::GONE
    );
    assert!(forward.seal("other.plugin", generation.id).is_err());
    assert!(forward.close("other.plugin", generation.id).is_err());
    assert_eq!(recv(&mut generation.events).await["type"], "admitted");
    for _ in 0..2 {
        assert_eq!(
            recv(&mut generation.events).await,
            serde_json::json!({ "type": "refused", "status": 410, "reason": "generation_ended" })
        );
    }
    // Closing forgets it and aborts what still streams. The aborted stream's
    // end is reported, and `closed` comes last.
    forward.close(PLUGIN, generation.id).unwrap();
    assert!(stream.chunk().await.is_err());
    recv(&mut gateway.dropped).await;
    drop(stream);
    let finished = recv(&mut generation.events).await;
    assert_eq!(finished["type"], "finished");
    assert_eq!(finished["aborted"], true);
    assert_eq!(recv(&mut generation.events).await["type"], "closed");
    assert_eq!(
        messages(&generation.url)
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert!(forward.registry().generations.is_empty());
}

#[tokio::test]
async fn revocation_aborts_admitted_streams() {
    let mut gateway = fake_gateway().await;
    let forward = ready(gateway.origin);
    let mut generation = associated(&forward, 1);
    let mut stream = messages(&generation.url)
        .header("x-test", "hold")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(
        &stream.chunk().await.unwrap().unwrap()[..],
        b"event: ping\n\n"
    );
    assert_eq!(
        forward
            .push(forward.page(), PLUGIN, "route-a", 2, true)
            .unwrap(),
        Pushed::Applied { revoked: 1 }
    );
    // A failed stream, never a short complete one.
    assert!(stream.chunk().await.is_err());
    recv(&mut gateway.dropped).await;
    assert_eq!(recv(&mut generation.events).await["type"], "admitted");
    assert_eq!(
        recv(&mut generation.events).await,
        serde_json::json!({ "type": "finished", "request": 1, "status": 200, "aborted": true })
    );
    let late = messages(&generation.url).body("{}").send().await.unwrap();
    assert_eq!(late.status(), StatusCode::GONE);
    // Another route's generation is untouched.
    forward
        .push(forward.page(), PLUGIN, "route-b", 1, true)
        .unwrap();
    assert!(matches!(
        forward.open(
            forward.page(),
            PLUGIN,
            "route-b",
            1,
            Harness::Goose,
            None,
            &inference(),
            &discovery(),
            channel().0,
        ),
        Ok(Opened::Opened { .. })
    ));
    assert_eq!(
        forward
            .push(forward.page(), PLUGIN, "route-a", 3, true)
            .unwrap(),
        Pushed::Applied { revoked: 0 }
    );
}

#[tokio::test]
async fn a_harness_that_hangs_up_aborts_upstream() {
    let mut gateway = fake_gateway().await;
    let forward = ready(gateway.origin);
    let mut generation = associated(&forward, 1);
    let mut stream = messages(&generation.url)
        .header("x-test", "hold")
        .body("{}")
        .send()
        .await
        .unwrap();
    stream.chunk().await.unwrap();
    drop(stream);
    recv(&mut gateway.dropped).await;
    assert_eq!(recv(&mut generation.events).await["type"], "admitted");
    assert_eq!(
        recv(&mut generation.events).await,
        serde_json::json!({ "type": "finished", "request": 1, "status": 200, "aborted": true })
    );
}

#[tokio::test]
async fn revocation_drops_upstream_while_the_harness_stops_reading() {
    let mut gateway = fake_gateway().await;
    let forward = ready(gateway.origin);
    let mut generation = associated(&forward, 1);
    let host = generation
        .url
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap();
    let mut socket = TcpStream::connect(host).await.unwrap();
    let head = format!(
        "POST /{}/serving-endpoints/model-a/invocations HTTP/1.1\r\nHost: {host}\r\nagent-session-id: {SESSION}\r\nx-test: flood\r\ncontent-length: 0\r\n\r\n",
        handle(&generation.url)
    );
    socket.write_all(head.as_bytes()).await.unwrap();
    let mut start = [0; 64];
    let read = socket.read(&mut start).await.unwrap();
    assert!(String::from_utf8_lossy(&start[..read]).starts_with("HTTP/1.1 200"));
    // The harness reads no more; `relay_*` tests below hold that barrier
    // exactly, while this one checks the wiring end to end.
    forward.close(PLUGIN, generation.id).unwrap();
    recv(&mut gateway.dropped).await;
    assert_eq!(recv(&mut generation.events).await["type"], "admitted");
    assert_eq!(
        recv(&mut generation.events).await,
        serde_json::json!({ "type": "finished", "request": 1, "status": 200, "aborted": true })
    );
    // The harness's connection still holds the response; dropping it closes.
    drop(socket);
    assert_eq!(recv(&mut generation.events).await["type"], "closed");
}

/// An upstream body that yields `frames`, then reports each step: `taken`
/// when its last frame is taken, `dropped` when dropped. After its frames it
/// stays pending, so only `is_end_stream` (`complete`) can say it ended.
struct Upstream {
    frames: std::collections::VecDeque<Bytes>,
    complete: bool,
    taken: Option<tokio::sync::oneshot::Sender<()>>,
    dropped: mpsc::UnboundedSender<()>,
}
impl Body for Upstream {
    type Data = Bytes;
    type Error = BoxError;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let Some(frame) = self.frames.pop_front() else {
            return Poll::Pending;
        };
        if self.frames.is_empty() {
            if let Some(taken) = self.taken.take() {
                let _ = taken.send(());
            }
        }
        Poll::Ready(Some(Ok(Frame::data(frame))))
    }
    fn is_end_stream(&self) -> bool {
        self.complete && self.frames.is_empty()
    }
}
impl Drop for Upstream {
    fn drop(&mut self) {
        let _ = self.dropped.send(());
    }
}

struct Relaying {
    body: Relayed,
    abort: CancellationToken,
    taken: tokio::sync::oneshot::Receiver<()>,
    dropped: mpsc::UnboundedReceiver<()>,
    events: mpsc::UnboundedReceiver<serde_json::Value>,
}
fn relaying(frames: &[&'static [u8]], complete: bool) -> Relaying {
    let (taken_tx, taken) = tokio::sync::oneshot::channel();
    let (dropped_tx, dropped) = mpsc::unbounded_channel();
    let (channel, events) = channel();
    let upstream = Upstream {
        frames: frames
            .iter()
            .map(|frame| Bytes::from_static(frame))
            .collect(),
        complete,
        taken: Some(taken_tx),
        dropped: dropped_tx,
    };
    let abort = CancellationToken::new();
    let finished = Finished {
        events: Arc::new(Events(channel)),
        request: 1,
        status: Some(200),
        done: false,
    };
    Relaying {
        body: relay(reqwest::Body::wrap(upstream), abort.clone(), finished),
        abort,
        taken,
        dropped,
        events,
    }
}
fn finished_event(aborted: bool) -> serde_json::Value {
    serde_json::json!({ "type": "finished", "request": 1, "status": 200, "aborted": aborted })
}

#[tokio::test]
async fn relay_drops_upstream_on_revocation_while_the_harness_is_blocked() {
    let mut relaying = relaying(&[b"one", b"two"], false);
    // Barrier: the harness never polls, so the first frame fills the relay's
    // buffer; once the second is taken the relay is blocked sending it.
    tokio::time::timeout(Duration::from_secs(5), &mut relaying.taken)
        .await
        .unwrap()
        .unwrap();
    relaying.abort.cancel();
    recv(&mut relaying.dropped).await;
    assert_eq!(recv(&mut relaying.events).await, finished_event(true));
    // The harness, polling at last, sees a broken stream.
    let frame = relaying.body.frame().await.unwrap();
    assert!(frame.is_err());
}

#[tokio::test]
async fn relay_reports_a_complete_response_complete_however_the_harness_lets_go() {
    // The final frame completes it: the harness drops the body at once.
    let mut last = relaying(&[b"all"], true);
    let frame = last.body.frame().await.unwrap().unwrap();
    assert_eq!(frame.into_data().unwrap(), Bytes::from_static(b"all"));
    drop(last.body);
    assert_eq!(recv(&mut last.events).await, finished_event(false));
    // Empty, as a HEAD answer or a 204 is: complete before any frame.
    let empty = relaying(&[], true);
    drop(empty.body);
    let mut empty_events = empty.events;
    assert_eq!(recv(&mut empty_events).await, finished_event(false));
    // An empty body the harness does read ends cleanly, not broken.
    let mut read = relaying(&[], true);
    assert!(read.body.frame().await.is_none());
    assert_eq!(recv(&mut read.events).await, finished_event(false));
    // Not known complete, and let go: aborted.
    let mut cut = relaying(&[b"part"], false);
    cut.body.frame().await.unwrap().unwrap();
    drop(cut.body);
    recv(&mut cut.dropped).await;
    assert_eq!(recv(&mut cut.events).await, finished_event(true));
}

#[tokio::test]
async fn strips_headers_the_connection_nominates() {
    let mut gateway = fake_gateway().await;
    let forward = ready(gateway.origin);
    let generation = associated(&forward, 1);
    let host = generation
        .url
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap();
    let head = format!(
        "POST /{}/serving-endpoints/model-a/invocations HTTP/1.1\r\nHost: {host}\r\nConnection: keep-alive, X-Hop-A\r\nconnection: x-HOP-b , x-gw-ctx-message-id\r\nx-hop-a: 1\r\nX-Hop-B: 1\r\nx-kept: 1\r\nagent-session-id: {SESSION}\r\ncontent-length: 0\r\n\r\n",
        handle(&generation.url)
    );
    assert!(raw(&generation.url, &head).await.contains(" 200 "));
    let seen = recv(&mut gateway.seen).await;
    assert!(seen.headers.get("x-hop-a").is_none());
    assert!(seen.headers.get("x-hop-b").is_none());
    assert!(seen.headers.get(header::CONNECTION).is_none());
    assert_eq!(seen.headers["x-kept"], "1");
    // Nominating a bundle header doesn't remove the bundle's own.
    assert_eq!(seen.headers["x-gw-ctx-message-id"], MESSAGE);

    // The gateway's own nominations stop here too.
    let direct = reqwest::Client::new()
        .get(gateway.origin)
        .header("x-test", "hop")
        .send()
        .await
        .unwrap();
    assert_eq!(direct.headers()["x-hop"], "1");
    recv(&mut gateway.seen).await;
    let relayed = messages(&generation.url)
        .header("x-test", "hop")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(relayed.status(), StatusCode::OK);
    assert!(relayed.headers().get("x-hop").is_none());
    assert_eq!(relayed.headers()["x-kept"], "1");
}

#[tokio::test]
async fn generations_belong_to_their_plugin_and_page() {
    let gateway = fake_gateway().await;
    let forward = ready(gateway.origin);
    let mut generation = associated(&forward, 1);
    // Another plugin's routes are its own: its push revokes nothing here.
    assert_eq!(
        forward
            .push(forward.page(), "other.plugin", "route-a", 5, true)
            .unwrap(),
        Pushed::Applied { revoked: 0 }
    );
    assert!(forward.seal("other.plugin", generation.id).is_err());
    assert!(forward.close("other.plugin", generation.id).is_err());
    let page = forward.page();
    forward.stop_all();
    // The old page's late push neither applies nor seeds the new page's route.
    assert!(forward.push(page, PLUGIN, "route-a", 57, true).is_err());
    assert!(forward.registry().routes.is_empty());
    assert_eq!(recv(&mut generation.events).await["type"], "closed");
    assert_eq!(
        messages(&generation.url)
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    forward
        .push(forward.page(), PLUGIN, "route-a", 1, true)
        .unwrap();
    let stale = forward.open(
        page,
        PLUGIN,
        "route-a",
        1,
        Harness::Goose,
        None,
        &inference(),
        &discovery(),
        channel().0,
    );
    assert_eq!(stale, Err("The page reloaded".into()));
}

#[tokio::test]
async fn refuses_to_open_without_a_gateway_or_valid_inputs() {
    let off = HostForward::new(None);
    off.push(off.page(), PLUGIN, "route-a", 1, true).unwrap();
    let opened = |forward: &HostForward, harness, session: Option<&str>, bundle| {
        forward.open(
            forward.page(),
            PLUGIN,
            "route-a",
            1,
            harness,
            session.map(Into::into),
            &bundle,
            &discovery(),
            channel().0,
        )
    };
    assert_eq!(
        opened(&off, Harness::Goose, None, inference()),
        Err("Gateway forwarding is off".into())
    );
    // A gateway without this harness's upstream, or on an insecure origin.
    let origin = fake_gateway().await.origin;
    let mut unrouted = config(origin).unwrap();
    unrouted.upstreams.clear();
    let mut insecure = config(origin).unwrap();
    insecure.gateway = "http://gateway.example".into();
    for gateway in [unrouted, insecure] {
        let forward = HostForward::new(Some(gateway));
        forward
            .push(forward.page(), PLUGIN, "route-a", 1, true)
            .unwrap();
        assert_eq!(
            opened(&forward, Harness::Goose, None, inference()),
            Err("Gateway forwarding is off".into())
        );
    }
    // Each harness opens only under its own capability's upstream.
    let mut claude_only = config(origin).unwrap();
    claude_only.upstreams.remove("goose");
    let forward = HostForward::new(Some(claude_only));
    forward
        .push(forward.page(), PLUGIN, "route-a", 1, true)
        .unwrap();
    assert_eq!(
        opened(&forward, Harness::Goose, None, inference()),
        Err("Gateway forwarding is off".into())
    );
    for origin in [
        "https://gateway.example/",
        "http://gateway.example",
        "https://u@gateway.example",
    ] {
        assert!(super::origin(origin).is_none(), "{origin}");
    }
    assert!(super::origin("https://gateway.example").is_some());
    let forward = ready(fake_gateway().await.origin);
    assert!(opened(&forward, Harness::Goose, Some("20261104_1"), inference()).is_err());
    assert!(opened(
        &forward,
        Harness::Goose,
        None,
        headers(&[("authorization", "x")])
    )
    .is_err());
    assert!(forward
        .push(forward.page(), PLUGIN, "a/b", 1, true)
        .is_err());
}

#[test]
fn ipc_shapes_match_the_typescript_bindings() {
    // src/features/host/forward.ts: ForwardOpened, ForwardPushed, ForwardEvent.
    let json = |value: serde_json::Result<serde_json::Value>| value.unwrap();
    assert_eq!(
        json(serde_json::to_value(Opened::Opened {
            id: 7,
            url: "http://127.0.0.1:1/h".into()
        })),
        serde_json::json!({ "type": "opened", "id": 7, "url": "http://127.0.0.1:1/h" })
    );
    assert_eq!(
        json(serde_json::to_value(Opened::Refused {
            current: 2,
            admits: false
        })),
        serde_json::json!({ "type": "refused", "current": 2, "admits": false })
    );
    assert_eq!(
        json(serde_json::to_value(Pushed::Applied { revoked: 1 })),
        serde_json::json!({ "type": "applied", "revoked": 1 })
    );
    assert_eq!(
        json(serde_json::to_value(Pushed::Stale)),
        serde_json::json!({ "type": "stale" })
    );
    for (event, expected) in [
        (
            ForwardEvent::Admitted {
                request: 1,
                class: Class::Discovery,
                child: false,
            },
            serde_json::json!({ "type": "admitted", "request": 1, "class": "discovery", "child": false }),
        ),
        (
            ForwardEvent::Finished {
                request: 1,
                status: None,
                aborted: true,
            },
            serde_json::json!({ "type": "finished", "request": 1, "status": null, "aborted": true }),
        ),
        (
            ForwardEvent::Refused {
                status: 410,
                reason: "generation_ended",
            },
            serde_json::json!({ "type": "refused", "status": 410, "reason": "generation_ended" }),
        ),
        (
            ForwardEvent::Closed,
            serde_json::json!({ "type": "closed" }),
        ),
    ] {
        assert_eq!(json(serde_json::to_value(event)), expected);
    }
    assert_eq!(
        json(serde_json::to_value(Registered::Registered)),
        serde_json::json!({ "type": "registered" })
    );
    assert_eq!(
        json(serde_json::to_value(Registered::Refused {
            reason: "child_cap"
        })),
        serde_json::json!({ "type": "refused", "reason": "child_cap" })
    );
    assert!(serde_json::from_value::<Harness>(serde_json::json!("claude")).is_err());
    assert_eq!(
        serde_json::from_value::<Harness>(serde_json::json!("goose")).unwrap(),
        Harness::Goose
    );
}

const PARENT: &str = "20261104_1";
const CHILD: &str = "20261104_2";

/// A goose generation associated with `PARENT`.
fn goose(forward: &HostForward) -> Opening {
    let generation = open(forward, Harness::Goose, 1);
    forward
        .associate(PLUGIN, generation.id, PARENT.into())
        .unwrap();
    generation
}
fn invoke(url: &str, session: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .post(format!("{url}/serving-endpoints/model-a/invocations"))
        .header("agent-session-id", session)
        .body("{}")
}
fn register(forward: &HostForward, id: u64, call: &str, child: &str) -> Registered {
    forward
        .register_child(PLUGIN, id, call.into(), child.into())
        .unwrap()
}
fn refused(reason: &'static str) -> Registered {
    Registered::Refused { reason }
}
fn pending(forward: &HostForward) -> usize {
    let registry = forward.registry();
    registry.generations.values().map(|g| g.pending.len()).sum()
}
/// Ready, with a deadline no test reaches, so a parked request stays parked
/// until the test releases it.
fn patient(origin: &str) -> HostForward {
    let mut forward = ready(origin);
    forward.rendezvous = Duration::from_secs(3600);
    forward
}
/// Waits until `count` requests are parked: an observed state, not a delay.
async fn parked(forward: &HostForward, count: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while pending(forward) != count {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("parked in time");
}
fn send(request: reqwest::RequestBuilder) -> tokio::task::JoinHandle<reqwest::Response> {
    tokio::spawn(async move { request.send().await.unwrap() })
}
/// A parked request's response, bounded well inside `patient`'s deadline so
/// a lost wake fails the test in seconds instead of holding it for an hour.
async fn answered(response: tokio::task::JoinHandle<reqwest::Response>) -> reqwest::Response {
    tokio::time::timeout(Duration::from_secs(5), response)
        .await
        .expect("answered in time")
        .unwrap()
}

#[tokio::test]
async fn a_registered_child_is_admitted_under_its_own_session() {
    let mut gateway = fake_gateway().await;
    let forward = ready(gateway.origin);
    let mut generation = goose(&forward);
    assert_eq!(
        register(&forward, generation.id, "call-1", CHILD),
        Registered::Registered
    );
    let response = invoke(&generation.url, CHILD).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let seen = recv(&mut gateway.seen).await;
    assert_eq!(seen.headers["agent-session-id"], CHILD);
    assert_eq!(seen.headers["x-gw-ctx-message-id"], MESSAGE);
    assert_eq!(
        recv(&mut generation.events).await,
        serde_json::json!({ "type": "admitted", "request": 1, "class": "inference", "child": true })
    );
    // The parent's own traffic is not a child's.
    invoke(&generation.url, PARENT).send().await.unwrap();
    recv(&mut generation.events).await;
    assert_eq!(recv(&mut generation.events).await["child"], false);
}

#[tokio::test]
async fn a_request_first_child_waits_dispatching_nothing_until_registered() {
    let mut gateway = fake_gateway().await;
    let forward = patient(gateway.origin);
    let generation = goose(&forward);
    let early = send(invoke(&generation.url, CHILD));
    parked(&forward, 1).await;
    assert!(gateway.seen.try_recv().is_err());
    assert_eq!(
        register(&forward, generation.id, "call-1", CHILD),
        Registered::Registered
    );
    assert_eq!(answered(early).await.status(), StatusCode::OK);
    assert_eq!(
        recv(&mut gateway.seen).await.headers["agent-session-id"],
        CHILD
    );
    assert!(gateway.seen.try_recv().is_err());
    assert_eq!(pending(&forward), 0);
}

#[tokio::test]
async fn an_unregistered_child_is_refused_at_the_deadline() {
    let mut gateway = fake_gateway().await;
    let mut forward = ready(gateway.origin);
    forward.rendezvous = Duration::from_millis(300);
    let mut generation = goose(&forward);
    // Only the outcome is asserted, never the brief parked state; the
    // request-first test proves parking.
    let started = std::time::Instant::now();
    let response = answered(send(invoke(&generation.url, CHILD))).await;
    assert!(started.elapsed() >= forward.rendezvous);
    assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
    assert!(response
        .text()
        .await
        .unwrap()
        .contains("gateway_child_unregistered"));
    assert_eq!(
        recv(&mut generation.events).await,
        serde_json::json!({ "type": "refused", "status": 504, "reason": "child_unregistered" })
    );
    assert!(gateway.seen.try_recv().is_err());
    assert_eq!(pending(&forward), 0);
    // A registration after expiry still admits a retry; expiry never did.
    register(&forward, generation.id, "call-1", CHILD);
    assert_eq!(
        answered(send(invoke(&generation.url, CHILD)))
            .await
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn parked_requests_are_capped_and_free_only_their_own_slot() {
    let gateway = fake_gateway().await;
    let forward = patient(gateway.origin);
    let mut generation = goose(&forward);
    let waiting: Vec<_> = (0..PENDING_CAP)
        .map(|n| send(invoke(&generation.url, &format!("child-{n}"))))
        .collect();
    parked(&forward, PENDING_CAP).await;
    let full = answered(send(invoke(&generation.url, "child-x"))).await;
    assert_eq!(full.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        recv(&mut generation.events).await,
        serde_json::json!({ "type": "refused", "status": 429, "reason": "child_pending_full" })
    );
    // A second request for child-0 cannot park; drop one harness request and
    // only its slot is freed.
    let mut waiting = waiting.into_iter();
    waiting.next().unwrap().abort();
    parked(&forward, PENDING_CAP - 1).await;
    let again = send(invoke(&generation.url, "child-1"));
    parked(&forward, PENDING_CAP).await;
    // Both requests for child-1 are woken by one registration.
    register(&forward, generation.id, "call-1", "child-1");
    assert_eq!(answered(again).await.status(), StatusCode::OK);
    assert_eq!(
        answered(waiting.next().unwrap()).await.status(),
        StatusCode::OK
    );
    assert_eq!(pending(&forward), PENDING_CAP - 2);
}

#[tokio::test]
async fn a_cancelled_request_leaves_its_same_child_sibling_parked() {
    let mut gateway = fake_gateway().await;
    let forward = patient(gateway.origin);
    let generation = goose(&forward);
    let cancelled = send(invoke(&generation.url, CHILD));
    parked(&forward, 1).await;
    let survivor = send(invoke(&generation.url, CHILD));
    parked(&forward, 2).await;
    cancelled.abort();
    parked(&forward, 1).await;
    assert_eq!(
        register(&forward, generation.id, "call-1", CHILD),
        Registered::Registered
    );
    assert_eq!(answered(survivor).await.status(), StatusCode::OK);
    assert_eq!(
        recv(&mut gateway.seen).await.headers["agent-session-id"],
        CHILD
    );
    assert_eq!(pending(&forward), 0);
    assert!(gateway.seen.try_recv().is_err());
}

#[tokio::test]
async fn seal_revocation_and_close_release_every_parked_request() {
    let gateway = fake_gateway().await;
    let forward = patient(gateway.origin);
    let generation = goose(&forward);
    let early = send(invoke(&generation.url, CHILD));
    parked(&forward, 1).await;
    forward.seal(PLUGIN, generation.id).unwrap();
    assert_eq!(answered(early).await.status(), StatusCode::GONE);
    assert_eq!(
        register(&forward, generation.id, "call-1", CHILD),
        refused("generation_ended")
    );
    assert_eq!(
        answered(send(invoke(&generation.url, CHILD)))
            .await
            .status(),
        StatusCode::GONE
    );

    let revoked = goose(&forward);
    let early = send(invoke(&revoked.url, CHILD));
    parked(&forward, 1).await;
    forward
        .push(forward.page(), PLUGIN, "route-a", 2, true)
        .unwrap();
    let response = answered(early).await;
    assert_eq!(response.status(), StatusCode::GONE);
    assert!(response
        .text()
        .await
        .unwrap()
        .contains("gateway_generation_revoked"));
    assert_eq!(
        register(&forward, revoked.id, "call-1", CHILD),
        refused("generation_revoked")
    );

    let closed = open(&forward, Harness::Goose, 2);
    forward.associate(PLUGIN, closed.id, PARENT.into()).unwrap();
    let early = send(invoke(&closed.url, CHILD));
    parked(&forward, 1).await;
    forward.close(PLUGIN, closed.id).unwrap();
    assert_eq!(answered(early).await.status(), StatusCode::GONE);
    assert_eq!(
        register(&forward, closed.id, "call-1", CHILD),
        refused("generation_ended")
    );
    assert_eq!(pending(&forward), 0);
}

#[tokio::test]
async fn registration_is_frozen_to_its_generation_and_parent() {
    let gateway = fake_gateway().await;
    let forward = ready(gateway.origin);
    let unassociated = open(&forward, Harness::Goose, 1);
    let a = goose(&forward);
    let b = goose(&forward);
    let contract = |id, call: &str, child: &str| {
        forward
            .register_child(PLUGIN, id, call.into(), child.into())
            .is_err()
    };
    assert!(contract(unassociated.id, "call-1", CHILD));
    assert!(contract(a.id, "call-1", PARENT));
    assert!(contract(a.id, "call/1", CHILD));
    assert!(contract(a.id, "call-1", ""));
    assert_eq!(
        forward
            .register_child("other.plugin", a.id, "call-1".into(), CHILD.into())
            .unwrap(),
        refused("generation_ended")
    );
    assert_eq!(
        register(&forward, a.id, "call-1", CHILD),
        Registered::Registered
    );
    assert_eq!(
        register(&forward, a.id, "call-1", CHILD),
        Registered::Registered
    );
    assert_eq!(
        register(&forward, a.id, "call-1", "20261104_3"),
        refused("child_call_conflict")
    );
    // Generation B never learns A's child; unknown sessions are never
    // admitted once B ends.
    forward.seal(PLUGIN, b.id).unwrap();
    assert_eq!(
        invoke(&b.url, CHILD).send().await.unwrap().status(),
        StatusCode::GONE
    );
    assert!(!forward
        .registry()
        .generations
        .values()
        .any(|g| g.id == b.id && g.children.contains(CHILD)));
    // Discovery is never parked or widened to children.
    let discovery = reqwest::Client::new()
        .get(format!("{}/api/2.0/serving-endpoints/m", a.url))
        .header("agent-session-id", CHILD)
        .send()
        .await
        .unwrap();
    assert_eq!(discovery.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn children_and_calls_have_their_own_bounds() {
    let gateway = fake_gateway().await;
    let forward = ready(gateway.origin);
    let generation = goose(&forward);
    for n in 0..CHILD_CAP {
        assert_eq!(
            register(
                &forward,
                generation.id,
                &format!("call-{n}"),
                &format!("child-{n}")
            ),
            Registered::Registered
        );
    }
    assert_eq!(
        register(&forward, generation.id, "call-new", "child-new"),
        refused("child_cap")
    );
    // A resume under a new call adds a call, not a child.
    for n in CHILD_CAP..CALL_CAP {
        assert_eq!(
            register(&forward, generation.id, &format!("call-{n}"), "child-0"),
            Registered::Registered
        );
    }
    let sizes = |forward: &HostForward| {
        let registry = forward.registry();
        let g = registry.generations.values().next().unwrap();
        (g.calls.len(), g.children.len())
    };
    assert_eq!(sizes(&forward), (CALL_CAP, CHILD_CAP));
    assert_eq!(
        register(&forward, generation.id, "call-0", "child-0"),
        Registered::Registered
    );
    assert_eq!(
        register(&forward, generation.id, "call-resume", "child-0"),
        refused("call_cap")
    );
    assert_eq!(sizes(&forward), (CALL_CAP, CHILD_CAP));
}

#[test]
fn goose_responses_route_is_inference() {
    // Pinned goose v1.57.0 posts Responses models here (databricks.rs stream()).
    assert_eq!(
        Harness::Goose.classify(&Method::POST, "/serving-endpoints/responses", None),
        Some(Class::Inference)
    );
}

#[tokio::test]
async fn goose_parent_and_child_requests_strip_authorization() {
    let mut gateway = fake_gateway().await;
    let forward = ready(gateway.origin);
    let mut generation = goose(&forward);
    assert_eq!(
        register(&forward, generation.id, "call-1", CHILD),
        Registered::Registered
    );
    for (index, (session, child, path)) in [
        (PARENT, false, "/serving-endpoints/model-a/invocations"),
        (PARENT, false, "/serving-endpoints/responses"),
        (CHILD, true, "/serving-endpoints/model-a/invocations"),
        (CHILD, true, "/serving-endpoints/responses"),
    ]
    .into_iter()
    .enumerate()
    {
        let response = reqwest::Client::new()
            .post(format!("{}{path}", generation.url))
            .header("Authorization", "Bearer owner-sentinel")
            .header("agent-session-id", session)
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let seen = recv(&mut gateway.seen).await;
        assert_eq!(seen.path, format!("/upstream/goose{path}"));
        assert!(seen.headers.get(header::AUTHORIZATION).is_none());
        assert_eq!(seen.headers["agent-session-id"], session);
        for (name, value) in inference() {
            assert_eq!(seen.headers.get_all(&name).iter().count(), 1, "{name}");
            assert_eq!(seen.headers[&name], value, "{name}");
        }
        assert_eq!(seen.body, Bytes::from_static(b"{}"));
        assert_eq!(
            recv(&mut generation.events).await,
            serde_json::json!({"type": "admitted", "request": index + 1, "class": "inference", "child": child})
        );
        assert_eq!(recv(&mut generation.events).await["type"], "finished");
    }
}
