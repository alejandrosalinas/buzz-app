//! Real command IPC admission plus internal loopback transport. No WebView fallback claim.
use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Barrier,
};
use tauri::{
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    Manager as _,
};

fn envelope(calls: &HostCalls) -> Once {
    let context = calls.context("main").unwrap();
    Once {
        boot: context.boot,
        page: context.page,
        activation: uuid::Uuid::new_v4().to_string(),
        call_id: uuid::Uuid::new_v4().to_string(),
    }
}
fn input() -> HostRequest {
    HostRequest {
        url: "https://example.test/submit".into(),
        method: "POST".into(),
        headers: BTreeMap::new(),
        body: Some("{}".into()),
        timeout_ms: Some(1000),
    }
}
fn ipc(
    view: &tauri::WebviewWindow<MockRuntime>,
    command: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    get_ipc_response(
        view,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: view.url().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map_err(|e| e.to_string())
    .map(|r| r.deserialize().unwrap())
}
struct App {
    _root: tempfile::TempDir,
    app: tauri::App<MockRuntime>,
    view: tauri::WebviewWindow<MockRuntime>,
    revision: String,
}
impl App {
    fn new(origin: &str) -> Self {
        Self::with_host(serde_json::json!({"networkOrigins":[origin]}))
    }
    fn with_host(host: serde_json::Value) -> Self {
        let root = tempfile::tempdir().unwrap();
        let manager =
            buzzodz_plugins::Manager::open(Some(root.path().join("data")), "test", false).unwrap();
        let source = root.path().join("plugin");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        std::fs::write(
            source.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "id":"example.replay", "name":"Replay fixture", "apiVersion":1,
                "host":host
            }))
            .unwrap(),
        )
        .unwrap();
        buzzodz_plugins::sign_release(&source, &nostr::key::SecretKey::generate().to_secret_hex())
            .unwrap();
        let installed = manager.install(&source).unwrap();
        let revision = installed
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.replay")
            .unwrap()
            .revision
            .clone();
        manager.change("enable", "example.replay").unwrap();
        let app = mock_builder()
            .manage(PluginManager(Ok(manager)))
            .manage(HostCalls::default())
            .invoke_handler(crate::commands())
            .build(crate::app_context())
            .unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        Self {
            _root: root,
            app,
            view,
            revision,
        }
    }
    fn body(&self, url: &str, once: Option<&Once>) -> serde_json::Value {
        let mut body = serde_json::json!({"id":"example.replay","revision":self.revision,
            "request":{"url":url,"method":"POST","body":"{}","timeoutMs":1000}});
        if let Some(once) = once {
            body["once"] = serde_json::to_value(once).unwrap();
        }
        body
    }
}

#[test]
fn actual_ipc_decodes_explicit_envelope_and_preserves_omitted_once_callers() {
    // Loopback TLS is deliberately untrusted: command admission/one connection is real;
    // positive HTTP POST bytes are tested separately below, without a TLS test bypass.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("https://{}/submit", listener.local_addr().unwrap());
    let origin = reqwest::Url::parse(&url)
        .unwrap()
        .origin()
        .ascii_serialization();
    let fixture = App::new(&origin);
    let calls = fixture.app.state::<HostCalls>();
    let once = envelope(&calls);
    let server = std::thread::spawn(move || {
        // An ordinary call and the protected call each attempt TLS, then fail.
        for _ in 0..2 {
            drop(listener.accept().unwrap());
        }
    });
    let context = ipc(
        &fixture.view,
        "plugin_host_call_context",
        serde_json::json!({}),
    )
    .unwrap();
    assert_eq!(
        context,
        serde_json::json!({"boot":once.boot,"page":once.page})
    );
    assert_eq!(
        ipc(
            &fixture.view,
            "plugin_host_call_context",
            serde_json::json!({})
        )
        .unwrap(),
        context
    );
    let ordinary = fixture.body(&url, None);
    assert!(ipc(&fixture.view, "plugin_host_request", ordinary)
        .unwrap_err()
        .contains("Host request failed"));
    assert_eq!(calls.claims.lock().unwrap().consumed.len(), 0);
    let body = fixture.body(&url, Some(&once));
    assert!(ipc(&fixture.view, "plugin_host_request", body.clone())
        .unwrap_err()
        .contains("Host request failed"));
    assert!(ipc(&fixture.view, "plugin_host_request", body.clone())
        .unwrap_err()
        .contains("already consumed"));
    server.join().unwrap();
    let mut changed = body.clone();
    changed["request"]["body"] = "different".into();
    assert!(ipc(&fixture.view, "plugin_host_request", changed)
        .unwrap_err()
        .contains("payload conflict"));
    for key in ["boot", "activation", "callId"] {
        for alias in [
            body["once"][key].as_str().unwrap().to_uppercase(),
            body["once"][key].as_str().unwrap().replace('-', ""),
        ] {
            let mut bad = body.clone();
            bad["once"][key] = alias.into();
            assert!(ipc(&fixture.view, "plugin_host_request", bad)
                .unwrap_err()
                .contains("Invalid protected"));
        }
    }
    let mut bad = body.clone();
    bad["once"]["unexpected"] = true.into();
    assert!(ipc(&fixture.view, "plugin_host_request", bad)
        .unwrap_err()
        .contains("unknown field"));
    let mut bad = body.clone();
    bad["once"]["page"] = (-1).into();
    assert!(ipc(&fixture.view, "plugin_host_request", bad).is_err());
    let mut stale = body.clone();
    stale["once"]["boot"] = uuid::Uuid::new_v4().to_string().into();
    assert!(ipc(&fixture.view, "plugin_host_request", stale)
        .unwrap_err()
        .contains("Stale"));
    // Revoking and restoring a current grant must not rearm its old claim.
    let manager = fixture.app.state::<PluginManager>();
    manager
        .0
        .as_ref()
        .unwrap()
        .change("disable", "example.replay")
        .unwrap();
    assert!(ipc(&fixture.view, "plugin_host_request", body.clone()).is_err());
    manager
        .0
        .as_ref()
        .unwrap()
        .change("enable", "example.replay")
        .unwrap();
    assert!(ipc(&fixture.view, "plugin_host_request", body.clone())
        .unwrap_err()
        .contains("already consumed"));
    calls.page_load();
    assert!(ipc(&fixture.view, "plugin_host_request", body)
        .unwrap_err()
        .contains("Stale"));
    assert_eq!(calls.claims.lock().unwrap().consumed.len(), 0);
    let other = tauri::WebviewWindowBuilder::new(&fixture.app, "other", Default::default())
        .build()
        .unwrap();
    // Existing capability permits only main; it denies before command extraction.
    for command in ["plugin_host_call_context", "plugin_host_request"] {
        let error = ipc(&other, command, fixture.body(&url, Some(&envelope(&calls)))).unwrap_err();
        assert!(error.contains("not allowed"), "{error}");
    }
    // Defense in depth still refuses a non-main caller if an ACL later broadens.
    assert!(calls.context("other").err().unwrap().contains("main view"));
    assert!(calls
        .consume(
            "other",
            "post",
            "p",
            "r",
            &envelope(&calls),
            input().fingerprint()
        )
        .unwrap_err()
        .contains("Invalid protected"));
}

#[test]
fn denied_ipc_requests_never_consume_dispatch_authority() {
    let fixture = App::new("https://example.test");
    let calls = fixture.app.state::<HostCalls>();
    let once = envelope(&calls);
    let body = fixture.body("https://example.test/submit", Some(&once));
    let mut cases = Vec::new();
    let mut value = body.clone();
    value["revision"] = "stale".into();
    cases.push(value);
    let mut value = body.clone();
    value["request"]["url"] = "https://other.test/submit".into();
    cases.push(value);
    let mut value = body.clone();
    value["request"]["url"] = "http://example.test/submit".into();
    cases.push(value);
    let mut value = body.clone();
    value["request"]["method"] = "GET".into();
    cases.push(value);
    let mut value = body.clone();
    value["request"]["headers"] = serde_json::json!({"cookie":"secret"});
    cases.push(value);
    let mut value = body.clone();
    value["request"]["body"] = "x".repeat(MAX_REQUEST_BYTES + 1).into();
    cases.push(value);
    let mut value = body.clone();
    value["request"]["timeoutMs"] = 0.into();
    cases.push(value);
    for value in cases {
        assert!(ipc(&fixture.view, "plugin_host_request", value).is_err());
    }
    fixture
        .app
        .state::<PluginManager>()
        .0
        .as_ref()
        .unwrap()
        .change("disable", "example.replay")
        .unwrap();
    assert!(ipc(&fixture.view, "plugin_host_request", body).is_err());
    assert!(calls.claims.lock().unwrap().consumed.is_empty());
}

#[test]
fn full_claims_reset_only_on_page_advance_and_stale_boot_poison_overflow_fail_closed() {
    let calls = HostCalls::default();
    let first = envelope(&calls);
    let payload = input().fingerprint();
    calls
        .consume("main", "post", "p", "r", &first, payload)
        .unwrap();
    for _ in 1..1024 {
        calls
            .consume("main", "post", "p", "r", &envelope(&calls), payload)
            .unwrap();
    }
    assert!(calls
        .consume("main", "post", "p", "r", &envelope(&calls), payload)
        .unwrap_err()
        .contains("capacity"));
    assert!(calls
        .consume("main", "post", "p", "r", &first, payload)
        .unwrap_err()
        .contains("already consumed"));
    calls.page_load();
    assert!(calls.claims.lock().unwrap().consumed.is_empty());
    // Freed capacity never admits the original envelope, even with identical tags/payload.
    assert!(calls
        .consume("main", "post", "p", "r", &first, payload)
        .unwrap_err()
        .contains("Stale"));
    let mut current = envelope(&calls);
    current.activation = first.activation.clone();
    current.call_id = first.call_id.clone();
    current.page = calls.context("main").unwrap().page;
    calls
        .consume("main", "post", "p", "r", &current, payload)
        .unwrap();
    assert!(calls
        .consume("main", "post", "p", "r", &current, payload)
        .unwrap_err()
        .contains("already consumed"));
    assert!(HostCalls::default()
        .consume("main", "post", "p", "r", &first, payload)
        .unwrap_err()
        .contains("Stale"));
    let exhausted = HostCalls::default();
    exhausted.claims.lock().unwrap().page = Some(9_007_199_254_740_991);
    exhausted.page_load();
    assert!(exhausted.context("main").is_err());
    let poisoned = Arc::new(HostCalls::default());
    let other = poisoned.clone();
    assert!(std::thread::spawn(move || {
        let _lock = other.claims.lock().unwrap();
        panic!("fixture poison");
    })
    .join()
    .is_err());
    poisoned.page_load();
    assert!(poisoned.context("main").is_err());
}

#[test]
fn fingerprints_bind_exact_fields_and_absence_not_ambiguous_concatenation() {
    let original = input();
    let expected = original.fingerprint();
    for field in [
        "url",
        "method",
        "body",
        "timeout",
        "header-name",
        "header-value",
    ] {
        let mut changed = input();
        match field {
            "url" => changed.url.push('/'),
            "method" => changed.method = "PUT".into(),
            "body" => changed.body = Some("{ }".into()),
            "timeout" => changed.timeout_ms = None,
            "header-name" => {
                changed.headers.insert("a".into(), "bc".into());
            }
            _ => {
                changed.headers.insert("ab".into(), "c".into());
            }
        }
        assert_ne!(changed.fingerprint(), expected, "{field}");
    }
    let mut absent = input();
    absent.body = None;
    let mut empty = input();
    empty.body = Some("".into());
    assert_ne!(absent.fingerprint(), empty.fingerprint());
    absent.headers = BTreeMap::from([("a".into(), "bc".into())]);
    empty = input();
    empty.body = None;
    empty.headers = BTreeMap::from([("ab".into(), "c".into())]);
    assert_ne!(absent.fingerprint(), empty.fingerprint());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_consumption_lost_reply_and_transport_failure_send_one_post() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for success in [true, false] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = reqwest::Url::parse(&format!("http://{}/submit", listener.local_addr().unwrap()))
            .unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        let (started_tx, started) = tokio::sync::oneshot::channel();
        let (release, held) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0; 1024];
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                assert_ne!(n, 0);
                bytes.extend_from_slice(&buf[..n]);
                if bytes.ends_with(b"\r\n\r\n{}") {
                    break;
                }
            }
            assert!(bytes.starts_with(b"POST /submit HTTP/1.1"));
            seen.fetch_add(1, Ordering::SeqCst);
            started_tx.send(()).unwrap();
            held.await.unwrap();
            if success {
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                    )
                    .await
                    .unwrap();
            }
            listener.into_std().unwrap()
        });
        let calls = Arc::new(HostCalls::default());
        let once = Arc::new(envelope(&calls));
        let barrier = Arc::new(Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let calls = calls.clone();
                let once = once.clone();
                let barrier = barrier.clone();
                let url = url.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    calls
                        .consume("main", "post", "p", "r", &once, input().fingerprint())
                        .map(|()| {
                            tauri::async_runtime::block_on(send_request_with_policy(
                                url,
                                reqwest::Method::POST,
                                HeaderMap::new(),
                                Some("{}".into()),
                                DEADLINE,
                                true,
                            ))
                        })
                })
            })
            .collect();
        started.await.unwrap();
        // The first result is held/possibly lost; replay must already refuse.
        assert!(calls
            .consume("main", "post", "p", "r", &once, input().fingerprint())
            .unwrap_err()
            .contains("already consumed"));
        release.send(()).unwrap();
        let server_listener = server.await.unwrap();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|r| r.is_err()).count(), 1);
        assert_eq!(
            results.into_iter().find_map(Result::ok).unwrap().is_ok(),
            success
        );
        // With the admitted sender completed, no hidden retry connection may be queued.
        let listener = server_listener;
        assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
        assert!(calls
            .consume("main", "post", "p", "r", &once, input().fingerprint())
            .is_err());
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn concurrent_actual_command_replay_attempts_one_connection_before_ambiguous_completion() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("https://{}/submit", listener.local_addr().unwrap());
    let origin = reqwest::Url::parse(&url)
        .unwrap()
        .origin()
        .ascii_serialization();
    let fixture = App::new(&origin);
    let once = envelope(&fixture.app.state::<HostCalls>());
    let body = fixture.body(&url, Some(&once));
    let (seen_tx, seen) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel();
    let count = Arc::new(AtomicUsize::new(0));
    let accepted = count.clone();
    let server = std::thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        accepted.fetch_add(1, Ordering::SeqCst);
        seen_tx.send(()).unwrap();
        let _ = held.recv();
        drop(socket);
        listener
    });
    let view = fixture.view.clone();
    let first_body = body.clone();
    let first = std::thread::spawn(move || ipc(&view, "plugin_host_request", first_body));
    seen.recv().unwrap();
    assert!(ipc(&fixture.view, "plugin_host_request", body.clone())
        .unwrap_err()
        .contains("already consumed"));
    release.send(()).unwrap();
    let listener = server.join().unwrap();
    assert!(first
        .join()
        .unwrap()
        .unwrap_err()
        .contains("Host request failed"));
    assert!(ipc(&fixture.view, "plugin_host_request", body)
        .unwrap_err()
        .contains("already consumed"));
    listener.set_nonblocking(true).unwrap();
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn deadline_and_cancellation_do_not_rearm_a_consumed_transport_call() {
    use tokio::io::AsyncReadExt;
    for cancel in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = reqwest::Url::parse(&format!("http://{}/submit", listener.local_addr().unwrap()))
            .unwrap();
        let calls = HostCalls::default();
        let once = envelope(&calls);
        let payload = input().fingerprint();
        calls
            .consume("main", "post", "p", "r", &once, payload)
            .unwrap();
        let (seen_tx, seen) = tokio::sync::oneshot::channel();
        let (release, held) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            assert!(socket.read(&mut bytes).await.unwrap() > 0);
            seen_tx.send(()).unwrap();
            held.await.unwrap();
            listener
        });
        let sending = tokio::spawn(send_request_with_policy(
            url,
            reqwest::Method::POST,
            HeaderMap::new(),
            Some("{}".into()),
            Duration::from_secs(1),
            true,
        ));
        seen.await.unwrap();
        if cancel {
            sending.abort();
            assert!(sending.await.err().unwrap().is_cancelled());
        } else {
            assert!(sending.await.unwrap().is_err());
        }
        assert!(calls
            .consume("main", "post", "p", "r", &once, payload)
            .unwrap_err()
            .contains("already consumed"));
        release.send(()).unwrap();
        let listener = server.await.unwrap().into_std().unwrap();
        assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
    }
}

const PNG_UPLOAD: &[u8] = b"\x89PNG\r\n\x1a\n\0\x9f\xff";

fn upload_metadata(fixture: &App, once: &Once, url: &str) -> serde_json::Value {
    serde_json::json!({"id":"example.replay","revision":fixture.revision,
        "once":once,"upload":{"url":url,"field":"image","name":"image.png",
        "contentType":"image/png","fields":{"label":"test"}}})
}
fn upload_ipc(
    fixture: &App,
    metadata: &serde_json::Value,
    body: tauri::ipc::InvokeBody,
) -> Result<serde_json::Value, String> {
    get_ipc_response(
        &fixture.view,
        tauri::webview::InvokeRequest {
            cmd: "plugin_host_upload_bytes_once".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: fixture.view.url().unwrap(),
            body,
            headers: HeaderMap::from_iter([(
                HeaderName::from_static("x-buzz-upload"),
                HeaderValue::from_str(&metadata.to_string()).unwrap(),
            )]),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map_err(|e| e.to_string())
    .map(|r| r.deserialize().unwrap())
}
#[test]
fn public_images_alone_cannot_authorize_an_upload() {
    let _serial = crate::host_files::managed_tests::commands();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("https://{}/upload", listener.local_addr().unwrap());
    let fixture = App::with_host(serde_json::json!({"publicImages":true}));
    let calls = fixture.app.state::<HostCalls>();
    let metadata = upload_metadata(&fixture, &envelope(&calls), &url);
    let error = upload_ipc(
        &fixture,
        &metadata,
        tauri::ipc::InvokeBody::Raw(PNG_UPLOAD.to_vec()),
    )
    .unwrap_err();
    assert!(error.contains("not declared"), "{error}");
    listener.set_nonblocking(true).unwrap();
    assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
}

#[test]
fn upload_raw_ipc_consumes_once_without_files_and_binds_bytes_and_metadata() {
    let _serial = crate::host_files::managed_tests::commands();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("https://{}/upload", listener.local_addr().unwrap());
    let origin = reqwest::Url::parse(&url)
        .unwrap()
        .origin()
        .ascii_serialization();
    let fixture = App::new(&origin);
    let calls = fixture.app.state::<HostCalls>();
    let once = envelope(&calls);
    let metadata = upload_metadata(&fixture, &once, &url);
    let server = std::thread::spawn(move || {
        drop(listener.accept().unwrap());
        listener
    });
    let raw = || tauri::ipc::InvokeBody::Raw(PNG_UPLOAD.to_vec());
    let dispatch_error = upload_ipc(&fixture, &metadata, raw()).unwrap_err();
    assert!(dispatch_error.contains("Host request failed; outcome unknown"));
    let listener = server.join().unwrap();
    assert!(upload_ipc(&fixture, &metadata, raw())
        .unwrap_err()
        .contains("already consumed"));
    assert!(upload_ipc(
        &fixture,
        &metadata,
        tauri::ipc::InvokeBody::Raw([PNG_UPLOAD, b"changed"].concat())
    )
    .unwrap_err()
    .contains("payload conflict"));
    for key in ["url", "field", "name", "fields"] {
        let mut changed = metadata.clone();
        if key == "fields" {
            changed["upload"][key]["label"] = "changed".into();
        } else {
            changed["upload"][key] =
                format!("{}x", changed["upload"][key].as_str().unwrap()).into();
        }
        assert!(
            upload_ipc(&fixture, &changed, raw())
                .unwrap_err()
                .contains("payload conflict"),
            "{key}"
        );
    }
    // Tauri's JSON fallback cannot dispatch, even when the original result was lost.
    let fallback_error = upload_ipc(
        &fixture,
        &metadata,
        tauri::ipc::InvokeBody::Json(serde_json::json!([0, 159, 255])),
    )
    .unwrap_err();
    assert!(fallback_error.contains("raw bytes"));
    assert!(fallback_error.contains("outcome may be unknown"));
    calls.page_load();
    assert!(upload_ipc(&fixture, &metadata, raw())
        .unwrap_err()
        .contains("Stale"));
    listener.set_nonblocking(true).unwrap();
    assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
}

#[test]
fn upload_ipc_rejects_invalid_data_and_authority_before_consuming() {
    let _serial = crate::host_files::managed_tests::commands();
    let fixture = App::new("https://example.test");
    let calls = fixture.app.state::<HostCalls>();
    let metadata = upload_metadata(&fixture, &envelope(&calls), "https://example.test/upload");
    for bytes in [
        vec![],
        vec![0; MAX_RESPONSE_BYTES + 1],
        b"not an image".to_vec(),
        b"\xff\xd8\xff\xe0".to_vec(),
        b"RIFF\x04\0\0\0WEBP".to_vec(),
    ] {
        assert!(upload_ipc(&fixture, &metadata, tauri::ipc::InvokeBody::Raw(bytes)).is_err());
    }
    for (path, value) in [
        (
            vec!["upload", "url"],
            serde_json::json!("http://example.test/"),
        ),
        (
            vec!["upload", "url"],
            serde_json::json!("https://other.test/"),
        ),
        (vec!["upload", "field"], serde_json::json!("bad\r\nfield")),
        (vec!["upload", "name"], serde_json::json!("bad\"name")),
        (vec!["upload", "contentType"], serde_json::json!("a\r\nb")),
        (
            vec!["upload", "contentType"],
            serde_json::json!("image/gif"),
        ),
        (
            vec!["upload", "contentType"],
            serde_json::json!("image/jpeg"),
        ),
        (
            vec!["upload", "contentType"],
            serde_json::json!("image/webp"),
        ),
        (
            vec!["upload", "contentType"],
            serde_json::json!("image/png;charset=utf-8"),
        ),
        (vec!["upload", "name"], serde_json::json!("../image.png")),
        (vec!["upload", "name"], serde_json::json!("dir\\image.png")),
        (vec!["upload", "name"], serde_json::json!(".hidden.png")),
        (vec!["upload", "name"], serde_json::json!("x".repeat(257))),
        (
            vec!["upload", "fields"],
            serde_json::json!({"bad/name":"text"}),
        ),
        (
            vec!["upload", "fields"],
            serde_json::json!({"file":{"name":"image.png"}}),
        ),
        (vec!["upload", "fields"], serde_json::json!({"count":1})),
        (
            vec!["upload", "fields"],
            serde_json::json!((0..17)
                .map(|i| (format!("field_{i}"), "text"))
                .collect::<BTreeMap<_, _>>()),
        ),
        (
            vec!["upload", "fields"],
            serde_json::json!({"huge":"x".repeat(16384)}),
        ),
        (vec!["upload", "path"], serde_json::json!("/not/a/file")),
        (
            vec!["upload", "headers"],
            serde_json::json!({"Cookie":"secret"}),
        ),
        (vec!["revision"], serde_json::json!("stale")),
        (vec!["once", "activation"], serde_json::json!("invalid")),
        (
            vec!["once", "boot"],
            serde_json::json!(uuid::Uuid::new_v4().to_string()),
        ),
        (vec!["once", "page"], serde_json::json!(999)),
    ] {
        let mut bad = metadata.clone();
        let mut at = &mut bad;
        for part in path {
            at = &mut at[part];
        }
        *at = value;
        assert!(upload_ipc(
            &fixture,
            &bad,
            tauri::ipc::InvokeBody::Raw(PNG_UPLOAD.to_vec())
        )
        .is_err());
    }
    fixture
        .app
        .state::<PluginManager>()
        .0
        .as_ref()
        .unwrap()
        .change("disable", "example.replay")
        .unwrap();
    assert!(upload_ipc(
        &fixture,
        &metadata,
        tauri::ipc::InvokeBody::Raw(PNG_UPLOAD.to_vec())
    )
    .is_err());
    assert!(calls.claims.lock().unwrap().consumed.is_empty());
}

#[test]
fn upload_validation_and_fingerprint_bind_full_binary_and_plain_metadata() {
    let mut upload: ByteUpload = serde_json::from_value(serde_json::json!({
        "url":"https://example.test/upload","field":"image","name":"image.png",
        "contentType":"image/png","fields":{"label":"hello"}
    }))
    .unwrap();
    assert!(validate_byte_upload(&upload, PNG_UPLOAD).is_ok());
    let mut maximum = vec![0; MAX_RESPONSE_BYTES];
    maximum[..PNG_UPLOAD.len()].copy_from_slice(PNG_UPLOAD);
    assert!(validate_byte_upload(&upload, &maximum).is_ok());
    let original = upload.fingerprint(&[0, 159, 255]).unwrap();
    assert_ne!(original, upload.fingerprint(&[0, 159, 254]).unwrap());
    upload.fields.insert("label".into(), "different".into());
    assert_ne!(original, upload.fingerprint(&[0, 159, 255]).unwrap());
    for field in ["url", "field", "name", "contentType", "fields"] {
        let mut value = serde_json::to_value(&upload).unwrap();
        if field == "fields" {
            value[field] = serde_json::json!({"ab":"c"});
        } else {
            value[field] = format!("{}x", value[field].as_str().unwrap()).into();
        }
        let changed: ByteUpload = serde_json::from_value(value).unwrap();
        assert_ne!(
            upload.fingerprint(&[1]).unwrap(),
            changed.fingerprint(&[1]).unwrap()
        );
    }
    upload.fields = BTreeMap::from([("ab".into(), "c".into())]);
    let framed = upload.fingerprint(PNG_UPLOAD).unwrap();
    upload.fields = BTreeMap::from([("a".into(), "bc".into())]);
    assert_ne!(framed, upload.fingerprint(PNG_UPLOAD).unwrap());
    upload.fields = BTreeMap::from([("x".into(), "x".repeat(8193))]);
    assert!(validate_byte_upload(&upload, PNG_UPLOAD).is_err());
}

#[test]
fn upload_requires_an_allowed_type_and_matching_magic_bytes() {
    let mut upload: ByteUpload = serde_json::from_value(serde_json::json!({
        "url":"https://example.test/upload","field":"image","name":"image.png",
        "contentType":"image/png"
    }))
    .unwrap();
    let images: [(&str, &[u8]); 3] = [
        ("image/png", PNG_UPLOAD),
        ("image/jpeg", b"\xff\xd8\xff\xe0binary"),
        ("image/webp", b"RIFF\x04\0\0\0WEBP"),
    ];
    for (declared, bytes) in images {
        upload.content_type = declared.into();
        assert!(validate_byte_upload(&upload, bytes).is_ok(), "{declared}");
        for (_, other) in images {
            if bytes != other {
                assert!(validate_byte_upload(&upload, other).is_err(), "{declared}");
            }
        }
        let signature_length = match declared {
            "image/png" => 8,
            "image/jpeg" => 3,
            _ => 12,
        };
        for length in 0..signature_length {
            assert!(
                validate_byte_upload(&upload, &bytes[..length]).is_err(),
                "{declared}: {length}"
            );
        }
        assert!(validate_byte_upload(&upload, b"not an image").is_err());
    }
    for declared in [
        "image/gif",
        "application/octet-stream",
        "image/svg+xml",
        "image/PNG",
        "image/png;charset=utf-8",
        "",
    ] {
        upload.content_type = declared.into();
        assert!(
            validate_byte_upload(&upload, PNG_UPLOAD).is_err(),
            "{declared}"
        );
    }
}

#[test]
fn upload_requires_one_safe_filename() {
    let mut upload: ByteUpload = serde_json::from_value(serde_json::json!({
        "url":"https://example.test/upload","field":"image","name":"image.png",
        "contentType":"image/png","fields":{"label":"café\ncaption"}
    }))
    .unwrap();
    for name in [
        "",
        ".",
        "..",
        ".image.png",
        "../image.png",
        "dir/image.png",
        "dir\\image.png",
        "image\0.png",
        "image\n.png",
        "image\u{7f}.png",
        "bad\"name.png",
        "image name.png",
        "café.png",
        "image:stream.png",
    ] {
        upload.name = name.into();
        assert!(
            validate_byte_upload(&upload, PNG_UPLOAD).is_err(),
            "{name:?}"
        );
    }
    upload.name = "x".repeat(256);
    assert!(validate_byte_upload(&upload, PNG_UPLOAD).is_ok());
    upload.name.push('x');
    assert!(validate_byte_upload(&upload, PNG_UPLOAD).is_err());
    upload.name = "image-1_test.png".into();
    assert!(validate_byte_upload(&upload, PNG_UPLOAD).is_ok());
}

#[test]
fn upload_requires_small_text_fields_with_safe_names() {
    let mut upload: ByteUpload = serde_json::from_value(serde_json::json!({
        "url":"https://example.test/upload","field":"image","name":"image.png",
        "contentType":"image/png","fields":{"label":"café\ncaption"}
    }))
    .unwrap();
    assert!(validate_byte_upload(&upload, PNG_UPLOAD).is_ok());
    for name in [
        "a/b",
        "",
        ".hidden",
        "a/b",
        "a\\b",
        "a\r\nb",
        "a:b",
        "a;filename=x",
        "é",
        "a b",
        "bad\"name",
    ] {
        upload.fields.clear();
        upload.field = name.into();
        assert!(
            validate_byte_upload(&upload, PNG_UPLOAD).is_err(),
            "{name:?}"
        );
        upload.field = "image".into();
        upload.fields = BTreeMap::from([(name.into(), "text".into())]);
        assert!(
            validate_byte_upload(&upload, PNG_UPLOAD).is_err(),
            "{name:?}"
        );
    }
    upload.fields = BTreeMap::from([("x".repeat(256), "text".into())]);
    upload.field = "x".repeat(256);
    assert!(validate_byte_upload(&upload, PNG_UPLOAD).is_ok());
    upload.field = "image".into();
    upload.fields = (0..16)
        .map(|i| (format!("field_{i}"), "text".into()))
        .collect();
    assert!(validate_byte_upload(&upload, PNG_UPLOAD).is_ok());
    upload.fields.insert("seventeenth".into(), "text".into());
    assert!(validate_byte_upload(&upload, PNG_UPLOAD).is_err());
    upload.fields = BTreeMap::from([("label".into(), "é".repeat(4096))]);
    assert!(validate_byte_upload(&upload, PNG_UPLOAD).is_ok());
    upload.fields.get_mut("label").unwrap().push('x');
    assert!(validate_byte_upload(&upload, PNG_UPLOAD).is_err());
    upload.fields = BTreeMap::from([("x".repeat(257), "text".into())]);
    assert!(validate_byte_upload(&upload, PNG_UPLOAD).is_err());
    upload.fields.clear();
    upload.field = "x".repeat(257);
    assert!(validate_byte_upload(&upload, PNG_UPLOAD).is_err());
    for value in [
        serde_json::json!(1),
        serde_json::json!({"file":"image.png"}),
        serde_json::json!(["text"]),
        serde_json::Value::Null,
    ] {
        let mut metadata = serde_json::to_value(&upload).unwrap();
        metadata["fields"] = serde_json::json!({"label":value});
        assert!(serde_json::from_value::<ByteUpload>(metadata).is_err());
    }
}

#[tokio::test]
async fn upload_transport_preserves_binary_multipart_and_never_follows_redirects_or_retries() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for reply in [true, false] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = reqwest::Url::parse(&format!("http://{}/upload", listener.local_addr().unwrap()))
            .unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            loop {
                let n = socket.read(&mut buffer).await.unwrap();
                assert_ne!(n, 0);
                request.extend_from_slice(&buffer[..n]);
                if let Some(split) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..split]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .unwrap()
                        .parse()
                        .unwrap();
                    if request.len() == split + 4 + length {
                        break;
                    }
                }
            }
            assert!(request.starts_with(b"POST /upload HTTP/1.1"));
            let split = request.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            let headers = String::from_utf8_lossy(&request[..split]);
            let boundary = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-type: multipart/form-data; boundary="))
                .unwrap();
            assert!(!headers.to_ascii_lowercase().contains("cookie:"));
            let expected = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"label\"\r\n\r\ncafé\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"image.png\"\r\nContent-Type: image/png\r\n\r\n");
            let mut body = expected.into_bytes();
            body.extend(PNG_UPLOAD);
            body.extend(format!("\r\n--{boundary}--\r\n").as_bytes());
            assert_eq!(&request[split + 4..], body);
            if reply {
                socket.write_all(b"HTTP/1.1 307 Temporary Redirect\r\nLocation: https://other.test/\r\nSet-Cookie: secret=1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
            }
            listener
        });
        let upload: ByteUpload = serde_json::from_value(serde_json::json!({"url":url.as_str(),"field":"image","name":"image.png","contentType":"image/png","fields":{"label":"café"}})).unwrap();
        let result = send_byte_upload(url, &upload, PNG_UPLOAD).await;
        if reply {
            let response = result.unwrap();
            assert_eq!(response.status, 307);
            assert_eq!(response.body, "{}");
            assert!(!response.headers.contains_key("set-cookie"));
        } else {
            assert!(result.unwrap_err().contains("Host request failed"));
        }
        let listener = server.await.unwrap().into_std().unwrap();
        assert!(matches!(listener.accept(),Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
    }
}

#[test]
fn upload_waits_for_shared_byte_admission_before_consuming_or_connecting() {
    let _serial = crate::host_files::managed_tests::commands();
    let held = crate::host_files::BYTE_WORK.try_acquire().unwrap();
    let (setup_tx, setup) = std::sync::mpsc::sync_channel(1);
    let (seen_tx, seen) = std::sync::mpsc::sync_channel(1);
    let sender = std::thread::spawn(move || {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("https://{}/upload", listener.local_addr().unwrap());
        let origin = reqwest::Url::parse(&url)
            .unwrap()
            .origin()
            .ascii_serialization();
        let fixture = App::new(&origin);
        let once = envelope(&fixture.app.state::<HostCalls>());
        let metadata = upload_metadata(&fixture, &once, &url);
        let app = fixture.app.handle().clone();
        setup_tx.send((app, listener)).unwrap();
        let result = upload_ipc(
            &fixture,
            &metadata,
            tauri::ipc::InvokeBody::Raw(PNG_UPLOAD.to_vec()),
        );
        seen_tx.send(result).unwrap();
    });
    let (app, listener) = setup.recv_timeout(Duration::from_secs(5)).unwrap();
    let watchdog = std::time::Instant::now() + Duration::from_secs(5);
    while crate::host_files::BYTE_WAITERS.available_permits() != 15 {
        if let Ok(result) = seen.try_recv() {
            panic!("upload did not queue: {result:?}");
        }
        assert!(
            std::time::Instant::now() < watchdog,
            "upload admission watchdog"
        );
        std::thread::yield_now();
    }
    assert!(app
        .state::<HostCalls>()
        .claims
        .lock()
        .unwrap()
        .consumed
        .is_empty());
    assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
    drop(held);
    // Complete the attempted TLS once, without adding a production trust bypass.
    loop {
        match listener.accept() {
            Ok((socket, _)) => {
                drop(socket);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    std::time::Instant::now() < watchdog,
                    "upload connection watchdog"
                );
                std::thread::yield_now();
            }
            other => panic!("upload listener: {other:?}"),
        }
    }
    assert!(seen
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap_err()
        .contains("Host request failed"));
    sender.join().unwrap();
    assert_eq!(
        app.state::<HostCalls>()
            .claims
            .lock()
            .unwrap()
            .consumed
            .len(),
        1
    );
}
