use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;

#[test]
fn routes_cannot_retarget_credentials_or_expand_http_access() {
    for community in [
        "http://relay.test",
        "https://u:p@relay.test",
        "https://relay.test/path",
        "https://relay.test/?q",
        "https://relay.test/#x",
    ] {
        assert!(request_url(community, "/query", "POST").is_err());
    }
    for path in [
        "//other.test/query",
        "/query?target=x",
        "/api/admin",
        "/../query",
        "https://other.test/query",
    ] {
        assert!(request_url("https://relay.test", path, "POST").is_err());
    }
    for path in ["/api/invites", "/gifs/search", "/profiles/search"] {
        assert!(request_url("https://relay.test", path, "POST").is_ok());
        assert!(request_url("https://relay.test", path, "GET").is_err());
    }
    assert!(request_url("https://relay.test", "/gifs/other", "POST").is_err());
    assert!(request_url("https://relay.test", "/profiles/other", "POST").is_err());
    assert!(request_url("https://relay.test", "/events", "GET").is_err());
    assert_eq!(
        request_url("https://relay.test", "/query", "POST")
            .unwrap()
            .as_str(),
        "https://relay.test/query"
    );
}

#[test]
fn websocket_auth_is_bound_to_the_captured_community() {
    let mut event = EventTemplate {
        kind: 22242,
        created_at: 1,
        content: "".into(),
        tags: vec![
            vec!["relay".into(), "wss://relay.test".into()],
            vec!["challenge".into(), "nonce".into()],
        ],
    };
    assert!(validate_event("https://relay.test", &event).is_ok());
    assert!(validate_event("https://other.test", &event).is_err());
    event
        .tags
        .push(vec!["relay".into(), "wss://other.test".into()]);
    assert!(validate_event("https://relay.test", &event).is_err());
    event.kind = 27235;
    assert!(validate_event("https://relay.test", &event).is_err());
}

#[test]
fn leave_requests_sign_only_the_protected_empty_shape() {
    let leave = |content: &str, tags: Vec<Vec<String>>| EventTemplate {
        kind: 28936,
        created_at: 1,
        content: content.into(),
        tags,
    };
    let protected = || vec![vec!["-".to_string()]];
    assert!(validate_event("https://relay.test", &leave("", protected())).is_ok());
    for rejected in [
        leave("bye", protected()),
        leave("", vec![]),
        leave("", vec![vec!["-".into(), "x".into()]]),
        leave(
            "",
            vec![vec!["-".into()], vec!["h".into(), "channel".into()]],
        ),
        leave("", vec![vec!["p".into(), "a".repeat(64)]]),
    ] {
        assert!(validate_event("https://relay.test", &rejected).is_err());
    }
}

#[test]
fn typing_signs_only_empty_channel_or_thread_scope() {
    let channel = vec!["h".into(), "private-dm".into()];
    let reply = vec!["e".into(), "a".repeat(64), "".into(), "reply".into()];
    let root = vec!["e".into(), "b".repeat(64), "".into(), "root".into()];
    let pulse = |content: &str, tags: Vec<Vec<String>>| EventTemplate {
        kind: 20002,
        created_at: 1,
        content: content.into(),
        tags,
    };
    for tags in [
        vec![channel.clone()],
        vec![channel.clone(), reply.clone()],
        vec![channel.clone(), root.clone(), reply.clone()],
    ] {
        assert!(validate_event("https://relay.test", &pulse("", tags)).is_ok());
    }
    for rejected in [
        pulse("draft text", vec![channel.clone()]),
        pulse("", vec![]),
        pulse("", vec![channel.clone(), channel.clone()]),
        pulse("", vec![vec!["h".into(), "".into()]]),
        pulse("", vec![channel.clone(), root.clone()]),
        pulse("", vec![channel.clone(), reply.clone(), root]),
        pulse("", vec![channel.clone(), vec!["p".into(), "a".repeat(64)]]),
        pulse(
            "",
            vec![
                channel,
                vec!["e".into(), "bad".into(), "".into(), "reply".into()],
            ],
        ),
    ] {
        assert!(validate_event("https://relay.test", &rejected).is_err());
    }
}

#[test]
fn agent_presence_signs_only_a_status_and_agent_keys() {
    let presence = |content: &str, tags: Vec<Vec<String>>| EventTemplate {
        kind: 20003,
        created_at: 1,
        content: content.into(),
        tags,
    };
    let agents = |count: usize| {
        (0..count)
            .map(|_| vec!["p".to_string(), "a".repeat(64)])
            .collect::<Vec<_>>()
    };
    for accepted in [
        presence("online", agents(1)),
        presence("offline", agents(1)),
        presence("online", agents(256)),
    ] {
        assert!(validate_event("https://relay.test", &accepted).is_ok());
    }
    for rejected in [
        presence("away", agents(1)),
        presence("online", vec![]),
        presence("online", agents(257)),
        presence("online", vec![vec!["p".into(), "A".repeat(64)]]),
        presence("online", vec![vec!["e".into(), "a".repeat(64)]]),
        presence("online", vec![vec!["p".into(), "a".repeat(64), "x".into()]]),
    ] {
        assert!(validate_event("https://relay.test", &rejected).is_err());
    }
}

#[test]
fn member_commands_sign_only_the_broker_shape() {
    let command = |kind: u16, content: &str, tags: &[&[&str]]| EventTemplate {
        kind,
        created_at: 1,
        content: content.into(),
        tags: tags
            .iter()
            .map(|tag| tag.iter().map(|value| value.to_string()).collect())
            .collect(),
    };
    let key = "a".repeat(64);
    let p: &[&str] = &["p", &key];
    for accepted in [
        command(9030, "", &[p, &["role", "member"]]),
        command(9030, "", &[p, &["role", "admin"]]),
        command(9031, "", &[p]),
        command(9032, "", &[p, &["role", "admin"]]),
        command(9032, "", &[p, &["role", "member"]]),
    ] {
        assert!(validate_event("https://relay.test", &accepted).is_ok());
    }
    let upper = "A".repeat(64);
    for rejected in [
        // Owner is never granted, and add/role must name a role.
        command(9030, "", &[p, &["role", "owner"]]),
        command(9032, "", &[p, &["role", "owner"]]),
        command(9030, "", &[p]),
        command(9032, "", &[p]),
        // Remove carries the target only.
        command(9031, "", &[p, &["role", "member"]]),
        command(9030, "note", &[p, &["role", "member"]]),
        command(9031, "", &[&["p", &upper]]),
        command(9031, "", &[&["p", &key[1..]]]),
        command(9031, "", &[&["p", &key, "wss://relay.test"]]),
        command(9031, "", &[p, p]),
        command(9031, "", &[&["role", "member"], p]),
        command(9030, "", &[p, &["role", "member"], &["h", "channel"]]),
        command(9031, "", &[]),
        // Workspace profile edits stay outside this surface.
        command(9033, "", &[]),
    ] {
        assert!(validate_event("https://relay.test", &rejected).is_err());
    }
}

fn fixture_server(response: String) -> (Url, std::thread::JoinHandle<(String, String)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Url::parse(&format!("http://{}/query", listener.local_addr().unwrap())).unwrap();
    let task = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let count = socket.read(&mut buffer).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
            let text = String::from_utf8_lossy(&bytes);
            if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length: ")
                            .map(str::to_owned)
                    })
                    .map(|value| value.parse().unwrap())
                    .unwrap_or(0);
                if body.len() == length {
                    let result = (headers.into(), body.into());
                    socket.write_all(response.as_bytes()).unwrap();
                    return result;
                }
            }
        }
    });
    (url, task)
}

#[tokio::test]
async fn native_http_signs_exact_bytes_and_never_follows_redirects() {
    // HTTP is test-transport-only; the IPC boundary always requires HTTPS.
    let (url, task) = fixture_server("HTTP/1.1 302 Found\r\nLocation: https://other.test/\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into());
    let body = r#"[{"kinds":[0],"limit":5}]"#;
    use crate::network_diagnostics::{
        in_context, network_diagnostics_configure, network_diagnostics_read, Context, Level,
    };
    let _capture = crate::network_diagnostics::CAPTURE_TEST.lock().await;
    network_diagnostics_configure(Level::Debug, Some(true), None).unwrap();
    let operation_id = format!("read:{}:1", uuid::Uuid::new_v4());
    let result = in_context(
        Some(Context {
            operation_id: operation_id.clone(),
        }),
        send(
            &IdentityHost::fixture(),
            None,
            url.clone(),
            "POST",
            Some(body.into()),
            true,
            MAX_RESPONSE,
        ),
    )
    .await
    .unwrap();
    assert_eq!(result.status, 302);
    let (headers, sent) = task.join().unwrap();
    assert_eq!(sent, body);
    let encoded = headers
        .lines()
        .find_map(|line| line.strip_prefix("authorization: Nostr "))
        .unwrap();
    let event: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
    assert_eq!(event["kind"], 27235);
    assert_eq!(event["content"], "");
    assert_eq!(event["tags"][0], serde_json::json!(["u", url.as_str()]));
    assert_eq!(event["tags"][1], serde_json::json!(["method", "POST"]));
    assert_eq!(
        event["tags"][2],
        serde_json::json!(["payload", format!("{:x}", Sha256::digest(body.as_bytes()))])
    );
    // A fresh credential per dispatched request: a nonce and the current time.
    assert_eq!(event["tags"][3][0], "nonce");
    assert!(event["tags"][3][1]
        .as_str()
        .is_some_and(|nonce| !nonce.is_empty()));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    assert!(event["created_at"]
        .as_u64()
        .is_some_and(|at| now.abs_diff(at) <= 5));
    verify(&event);
    let diagnostics = network_diagnostics_read(None);
    let phases = diagnostics["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["operationId"] == operation_id)
        .collect::<Vec<_>>();
    for phase in ["http.authorization", "http.sign", "http.body"] {
        assert!(phases
            .iter()
            .any(|event| event["phase"] == phase && event["outcome"] == "started"));
        assert!(phases
            .iter()
            .any(|event| event["phase"] == phase && event["outcome"] == "completed"));
    }
    assert!(phases
        .iter()
        .any(|event| event["phase"] == "http.query" && event["status"] == 302));
    assert!(!diagnostics.to_string().contains(encoded));
    network_diagnostics_configure(Level::Info, Some(false), None).unwrap();
}

#[tokio::test]
async fn memory_response_limit_rejects_before_generic_transport_budget() {
    // The advertised size alone must be rejected. A multi-megabyte server write
    // blocks the fixture thread after the client closes on this header.
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        2 * 1024 * 1024 + 1
    );
    let (url, task) = fixture_server(response);
    let result = send(
        &IdentityHost::fixture(),
        None,
        url,
        "POST",
        Some("[]".into()),
        true,
        2 * 1024 * 1024,
    )
    .await;
    assert!(matches!(result, Err(ref message) if message == "Relay response is too large"));
    task.join().unwrap();
}

fn verify(event: &serde_json::Value) {
    let serialized = serde_json::to_vec(&serde_json::json!([
        0,
        event["pubkey"],
        event["created_at"],
        event["kind"],
        event["tags"],
        event["content"]
    ]))
    .unwrap();
    let hash = Sha256::digest(serialized);
    assert_eq!(event["id"], format!("{hash:x}"));
    let signature: secp256k1::schnorr::Signature = event["sig"].as_str().unwrap().parse().unwrap();
    let public: secp256k1::XOnlyPublicKey = event["pubkey"].as_str().unwrap().parse().unwrap();
    secp256k1::Secp256k1::verification_only()
        .verify_schnorr(&signature, &hash, &public)
        .unwrap();
}

#[test]
fn managed_agent_deletion_is_owner_only_through_existing_ipc() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .manage(FederatedIdentity::new().unwrap())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let sign = |event: serde_json::Value| {
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: "relay_sign".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                    "community": "https://relay.test", "event": event
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize::<serde_json::Value>().unwrap())
    };
    let owner = "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";
    let agent = "02".repeat(32);
    let coordinate = format!("30177:{owner}:{agent}");
    let deletion = serde_json::json!({
        "kind": 5, "created_at": 123, "content": "", "tags": [["a", coordinate]]
    });
    for tags in [
        serde_json::json!([["a", coordinate]]),
        serde_json::json!([
            ["a", coordinate],
            ["k", "30177"],
            ["client-id", "unregister"]
        ]),
    ] {
        let mut event = deletion.clone();
        event["tags"] = tags;
        let signed = sign(event.clone()).unwrap();
        assert_eq!(signed["pubkey"], owner);
        for field in ["kind", "created_at", "content", "tags"] {
            assert_eq!(signed[field], event[field]);
        }
        verify(&signed);
    }
    for tags in [
        serde_json::json!([]),
        serde_json::json!([["a"]]),
        serde_json::json!([["a", coordinate, "extra"]]),
        serde_json::json!([["a", format!("30177:{}:{agent}", "a".repeat(64))]]),
        serde_json::json!([["a", format!("30175:{owner}:{agent}")]]),
        serde_json::json!([["a", format!("30177:{owner}:")]]),
        serde_json::json!([["a", format!("30177:{owner}:{}", "A".repeat(64))]]),
        serde_json::json!([["a", format!("30177:{owner}:{agent}:extra")]]),
        serde_json::json!([["a", coordinate], ["a", coordinate]]),
        serde_json::json!([["a", coordinate], ["e", "b".repeat(64)]]),
        serde_json::json!([["a", coordinate], ["h", "channel"]]),
        serde_json::json!([["a", coordinate], ["k", "30175"]]),
        serde_json::json!([["a", coordinate], ["k", "30177"], ["k", "30177"]]),
        serde_json::json!([
            ["a", coordinate],
            ["client-id", "one"],
            ["client-id", "two"]
        ]),
    ] {
        let mut event = deletion.clone();
        event["tags"] = tags;
        assert!(sign(event.clone()).is_err(), "accepted {event}");
    }
    let mut event = deletion;
    event["content"] = serde_json::json!("unexpected content");
    assert!(sign(event).is_err());
}

#[tokio::test]
async fn catalog_signing_admits_maximum_escaped_content_through_ipc() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .manage(FederatedIdentity::new().unwrap())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let sign = |event: &EventTemplate| {
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: "relay_sign".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                    "community": "https://relay.test", "event": event
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize::<serde_json::Value>().unwrap())
    };
    // Each `"` is two content bytes (`\"`) and four serialized bytes (`\\\"`).
    let agent = |size: usize| {
        let room = size - r#"{"display_name":"Big","system_prompt":""}"#.len();
        let pad = format!("{}{}", r#"\""#.repeat(room / 2), "a".repeat(room % 2));
        let content = format!(r#"{{"display_name":"Big","system_prompt":"{pad}"}}"#);
        assert_eq!(content.len(), size);
        EventTemplate {
            kind: 30175,
            created_at: 123,
            tags: vec![
                vec!["d".into(), "big".into()],
                vec!["shared".into(), "true".into()],
                vec!["client-id".into(), "a".repeat(36)],
            ],
            content,
        }
    };
    let largest = agent(65_535);
    let signed = sign(&largest).unwrap();
    verify(&signed);
    assert_eq!(signed["content"], largest.content);
    assert!(signed.to_string().len() > 128 * 1024);
    // The ordinary bound would refuse it, so the catalog route is load-bearing.
    assert!(IdentityHost::fixture().sign(largest).await.is_err());
    assert!(sign(&agent(65_536)).is_err());
}

#[test]
fn real_ipc_restores_identity_signs_and_rejects_invalid_requests() {
    // The path resolver reads HOME at runtime. Isolate it in a child rather
    // than changing process-global HOME under the parallel test runner.
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child.args([
        "--exact",
        "relay::tests::isolated_agent_ipc_probe",
        "--nocapture",
    ]);
    #[cfg(unix)]
    {
        let home = tempfile::tempdir().unwrap();
        #[cfg(target_os = "macos")]
        let path = home
            .path()
            .join("Library/Application Support/xyz.block.buzz.app/agents/managed-agents.json");
        #[cfg(target_os = "linux")]
        let path = home
            .path()
            .join(".local/share/xyz.block.buzz.app/agents/managed-agents.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "[]").unwrap();
        child.env("HOME", home.path()).env_remove("XDG_DATA_HOME");
        let output = child.env("BUZZ_AGENT_IPC_PROBE", "1").output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let output = child.env("BUZZ_ARCHIVE_RESTART", "1").output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[cfg(target_os = "windows")]
    {
        let output = child.env("BUZZ_AGENT_IPC_PROBE", "1").output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn isolated_agent_ipc_probe() {
    if std::env::var("BUZZ_AGENT_IPC_PROBE").as_deref() != Ok("1") {
        return;
    }
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::Manager;
    // The probe owns the spool dir, so it is removed when the probe returns
    // or panics.
    let spools = tempfile::tempdir().unwrap();
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .manage(FederatedIdentity::new().unwrap())
        .manage(Uploads::default())
        .manage(Spools::new(Ok(spools.path().to_owned())))
        .manage(crate::archive::ArchiveHost::default())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    app.manage(crate::app_agents::AppAgentHost::new(
        Ok(app
            .path()
            .app_data_dir()
            .unwrap()
            .join("agents/identities.json")),
        Err("unused".into()),
        false,
        crate::federated_identity::agent::AgentTokens::unconfigured(),
    ));
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let invoke = |cmd: &str, body: serde_json::Value| {
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize::<serde_json::Value>().unwrap())
    };
    // Empty uploads fail before allocating storage or networking.
    assert_eq!(
        invoke(
            "relay_upload_begin",
            serde_json::json!({"id":"empty", "size":0})
        )
        .unwrap_err(),
        serde_json::json!("File exceeds the supported upload limit")
    );
    invoke(
        "relay_upload_begin",
        serde_json::json!({"id":"chunked", "size":3}),
    )
    .unwrap();
    let mut headers = tauri::http::HeaderMap::new();
    headers.insert("x-buzz-upload-id", "chunked".parse().unwrap());
    headers.insert("x-buzz-upload-offset", "0".parse().unwrap());
    get_ipc_response(
        &view,
        tauri::webview::InvokeRequest {
            cmd: "relay_upload_chunk".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: view.url().unwrap(),
            body: tauri::ipc::InvokeBody::Raw(b"abc".to_vec()),
            headers: headers.clone(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .unwrap();
    headers.insert("x-buzz-community", "https://relay.test".parse().unwrap());
    // Fixed-mode rejection proves finalization/cleanup without an external server.
    headers.insert("x-buzz-preparation", "video:not-allowed".parse().unwrap());
    let response = get_ipc_response(
        &view,
        tauri::webview::InvokeRequest {
            cmd: "relay_upload".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: view.url().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
            headers,
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .unwrap()
    .deserialize::<serde_json::Value>()
    .unwrap();
    assert_eq!(response["body"], r#"{"code":"video"}"#);
    assert!(app.state::<Uploads>().lock().active.is_empty());
    invoke(
        "relay_upload_begin",
        serde_json::json!({"id":"chunked", "size":3}),
    )
    .unwrap();
    invoke("relay_upload_cancel", serde_json::json!({"id":"chunked"})).unwrap();
    let public = invoke("identity_restore", serde_json::json!({})).unwrap();
    #[cfg(unix)]
    {
        let archive = |request| {
            invoke(
                "relay_archive",
                serde_json::json!({
                    "community":"https://relay.test", "viewer":public, "request":request
                }),
            )
        };
        let settings = archive(serde_json::json!({"action":"settings"})).unwrap();
        let path = std::path::PathBuf::from(settings["path"].as_str().unwrap());
        assert!(path.starts_with(std::env::var("HOME").unwrap()));
        if std::env::var("BUZZ_ARCHIVE_RESTART").as_deref() != Ok("1") {
            for kind in [24200, 44200] {
                let event = crate::archive::tests::envelope(public.as_str().unwrap(), kind, 0);
                for _ in 0..2 {
                    let saved = archive(serde_json::json!({"action":"ingest","event":event,"revision":settings["revision"]})).unwrap();
                    assert_eq!(saved, serde_json::json!({"saved":true}));
                }
            }
        }
        for kind in [24200, 44200] {
            let fresh = crate::archive::tests::envelope(public.as_str().unwrap(), kind, 2);
            let stale = crate::archive::tests::envelope_at(
                public.as_str().unwrap(),
                kind,
                3,
                fresh.created_at - 301,
            );
            let wrong_viewer = crate::archive::tests::envelope(&fresh.pubkey, kind, 4);
            for invalid in [stale, wrong_viewer] {
                assert!(archive(serde_json::json!({"action":"ingest","event":invalid,"revision":settings["revision"]})).is_err());
            }
            let page = archive(serde_json::json!({"action":"read","kind":kind})).unwrap();
            assert_eq!(page["records"].as_array().unwrap().len(), 1);
            assert!(page["records"][0]["plaintext"]
                .as_str()
                .unwrap()
                .contains("archive-secret-marker"));
            assert_eq!(page["skipped"], 0);
        }
        let stored = archive(serde_json::json!({"action":"read","kind":24200})).unwrap();
        let event_id = stored["records"][0]["id"].as_str().unwrap().as_bytes();
        let mut found_event = false;
        for file in std::fs::read_dir(path.parent().unwrap()).unwrap() {
            let raw = std::fs::read(file.unwrap().path()).unwrap();
            found_event |= raw.windows(event_id.len()).any(|bytes| bytes == event_id);
            assert!(!raw
                .windows(b"archive-secret-marker".len())
                .any(|s| s == b"archive-secret-marker"));
            assert!(!raw.windows(b"channelId".len()).any(|s| s == b"channelId"));
        }
        assert!(found_event, "ciphertext scan must include a saved envelope");
        let isolated = invoke("relay_archive",serde_json::json!({"community":"https://other.test","viewer":public,"request":{"action":"read","kind":24200}})).unwrap();
        assert!(isolated["records"].as_array().unwrap().is_empty());
        if std::env::var("BUZZ_ARCHIVE_RESTART").as_deref() == Ok("1") {
            archive(serde_json::json!({"action":"clear","kind":24200})).unwrap();
            assert!(
                archive(serde_json::json!({"action":"read","kind":24200})).unwrap()["records"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(
                archive(serde_json::json!({"action":"read","kind":44200})).unwrap()["records"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
        }
    }
    let event = invoke(
        "relay_sign",
        serde_json::json!({
            "community": "https://relay.test", "event": {
                "kind": 9, "created_at": 123, "tags": [["h", "channel"]], "content": "IPC message"
            }
        }),
    )
    .unwrap();
    assert_eq!(event["pubkey"], public);
    verify(&event);

    let repository = format!("https://relay.test/git/{}/plugins", "a".repeat(64));
    app.state::<FederatedIdentity>()
        .discovered("wss://relay.test", false);
    let token = invoke(
        "relay_git_authorization",
        serde_json::json!({"community": "https://relay.test", "repository": repository}),
    )
    .unwrap();
    let auth: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(token.as_str().unwrap()).unwrap()).unwrap();
    verify(&auth);
    assert_eq!(auth["pubkey"], public);
    assert_eq!(auth["kind"], 27235);
    assert_eq!(
        auth["tags"],
        serde_json::json!([["u", repository], ["method", "GET"]])
    );
    assert!(invoke(
        "relay_git_authorization",
        serde_json::json!({"community": "https://relay.test", "repository": "https://other.test/git/x/y"}),
    )
    .is_err());

    // The old direct attestation IPC must be absent, not merely unused by the UI.
    assert!(invoke(
        "relay_agent_authorize",
        serde_json::json!({
            "community": "https://relay.test",
            "target": {"owner": public, "pubkey": "02".repeat(32)}
        }),
    )
    .is_err());
    let resolved = invoke("relay_agent_resolve", serde_json::json!({
        "community": "https://relay.test", "target": {"owner": public, "pubkey": "02".repeat(32), "confirmed": true}
    })).unwrap();
    assert_eq!(resolved["relayUrl"], "wss://relay.test");
    #[cfg(unix)]
    {
        let library = invoke("relay_agent_library", serde_json::json!({})).unwrap();
        assert_eq!(
            library,
            serde_json::json!({"definitions": [], "identities": []})
        );
        let path = app
            .path()
            .app_data_dir()
            .unwrap()
            .join("agents/identities.json");
        assert!(path.starts_with(std::env::var("HOME").unwrap()));
        let saved = serde_json::json!([{
            "pubkey": "a".repeat(64), "relay": "wss://relay.test", "owner": public,
            "auth": "private attestation", "type": "plugin/agent", "name": "Current agent",
            "picture": "https://images.example/current.png"
        }])
        .to_string();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &saved).unwrap();
        assert_eq!(
            invoke("relay_agent_library", serde_json::json!({})).unwrap(),
            serde_json::json!({"definitions": [], "identities": [{
                "pubkey": "a".repeat(64), "name": "Current agent", "avatar": "https://images.example/current.png"
            }]})
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), saved);
        std::fs::remove_file(&path).unwrap();
        assert!(app
            .path()
            .app_data_dir()
            .unwrap()
            .starts_with(std::env::var("HOME").unwrap()));
    }
    // Library IPC success is exercised against an isolated HOME on Unix.
    // Windows known-folder inventory is not isolated here; do not invoke its
    // reader until a test-only fixture can control that path.
    // Each must reach the command: a handler refusal is fine; an ACL refusal is not.
    for (command, input) in [
        (
            "relay_archive",
            serde_json::json!({"community":"https://relay.test", "viewer":"bad", "request":{"action":"settings"}}),
        ),
        (
            "relay_agent_memories_read",
            serde_json::json!({"community": "https://relay.test", "agent": public}),
        ),
        (
            "relay_agent_observer",
            serde_json::json!({"community": "https://relay.test", "event": {"id": "bad"}}),
        ),
        (
            "relay_agent_log_proof",
            serde_json::json!({"community": "https://relay.test", "target": {"id": "bad", "pubkey": public, "relayUrl": "wss://relay.test", "nonce": "bad"}}),
        ),
    ] {
        let result = invoke(command, input);
        assert!(
            !format!("{result:?}").contains(&format!("{command} not allowed")),
            "ACL blocked {command}"
        );
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let read = invoke(
        "relay_sign_read_state",
        serde_json::json!({
            "community": "https://relay.test", "intent": {"slot": "a".repeat(32), "createdAt": now,
                "blob": {"v": 1, "client_id": "fixture", "contexts": {"channel": now}}}
        }),
    )
    .unwrap();
    verify(&read);
    let decoded = invoke(
        "relay_decode_read_state",
        serde_json::json!({
            "community": "https://relay.test", "events": [read.clone()]
        }),
    )
    .unwrap();
    assert_eq!(decoded[0]["eventId"], read["id"]);
    assert!(invoke(
        "relay_publish_read_state",
        serde_json::json!({
            "community": "https://relay.test", "event": event
        })
    )
    .is_err());
    assert!(invoke("relay_http", serde_json::json!({
        "community": "https://relay.test", "path": "//other.test/query", "method": "POST", "body": "[]"
    })).is_err());
    assert!(invoke("relay_sign", serde_json::json!({
        "community": "https://relay.test", "event": {
            "kind": 22242, "created_at": 123, "tags": [["relay", "wss://other.test"], ["challenge", "nonce"]], "content": ""
        }
    })).is_err());
    let id = "11111111-1111-4111-8111-111111111111";
    assert!(invoke(
        "relay_sign",
        serde_json::json!({
            "community": "https://relay.test", "event": {
                "kind": 5, "created_at": 123,
                "tags": [["h", id], ["a", format!("30620:{}:{id}", "a".repeat(64))]], "content": ""
            }
        })
    )
    .is_err());
    let deletion = invoke("relay_sign", serde_json::json!({
        "community": "https://relay.test", "event": {
            "kind": 5, "created_at": 123,
            "tags": [["h", id], ["a", format!("30620:{}:{id}", public.as_str().unwrap())]], "content": ""
        }
    })).unwrap();
    verify(&deletion);
    assert!(invoke(
        "relay_workflow_runs",
        serde_json::json!({
            "community": "https://relay.test", "id": "../query", "cursor": null
        })
    )
    .unwrap_err()
    .to_string()
    .contains("Invalid workflow read"));
    assert!(invoke(
        "relay_project_git",
        serde_json::json!({
            "community": "https://relay.test",
            "id": "11111111-1111-4111-8111-111111111111",
            "read": { "owner": "a".repeat(64), "dtag": "../query" }
        })
    )
    .unwrap_err()
    .to_string()
    .contains("Invalid Git read"));
}

#[test]
fn managed_agent_registration_signs_as_owner_through_existing_ipc() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .manage(FederatedIdentity::new().unwrap())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let invoke = |cmd: &str, body: serde_json::Value| {
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize::<serde_json::Value>().unwrap())
    };
    let public = invoke("identity_restore", serde_json::json!({})).unwrap();
    let registration = serde_json::json!({
        "kind": 30177, "created_at": 123, "tags": [["d", "02".repeat(32)]],
        "content": r#"{"name":"Remote agent","parallelism":1,"respond_to":"owner-only"}"#
    });
    let registered = invoke(
        "relay_sign",
        serde_json::json!({
            "community": "https://relay.test", "event": registration
        }),
    )
    .unwrap();
    assert_eq!(registered["pubkey"], public);
    for field in ["kind", "created_at", "tags", "content"] {
        assert_eq!(registered[field], registration[field]);
    }
    verify(&registered);
}

#[tokio::test]
async fn signing_is_verifiable_and_does_not_export_a_key() {
    let event = IdentityHost::fixture()
        .sign(EventTemplate {
            kind: 9,
            created_at: 123,
            tags: vec![vec!["h".into(), "channel".into()]],
            content: "Hello\nfrom native".into(),
        })
        .await
        .unwrap();
    verify(&event);
    assert_eq!(
        event["pubkey"],
        "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"
    );
    assert!(!event.to_string().contains("nsec"));
    assert!(IdentityHost::default()
        .sign(EventTemplate {
            kind: 9,
            created_at: 0,
            tags: vec![],
            content: "".into()
        })
        .await
        .is_err());
}

#[test]
fn workflow_history_is_fixed_and_cannot_retarget_native_http() {
    let id = "11111111-1111-4111-8111-111111111111";
    let cursor = WorkflowCursor {
        before: "2026-09-29T20:00:00Z".into(),
        before_id: id.into(),
    };
    assert_eq!(workflow_runs_url("https://relay.test", id, Some(&cursor)).unwrap().as_str(),
        "https://relay.test/workflows/11111111-1111-4111-8111-111111111111/runs?limit=20&before=2026-09-29T20%3A00%3A00Z&before_id=11111111-1111-4111-8111-111111111111");
    for invalid in [
        "../query",
        "11111111-1111-4111-8111-111111111111?target=x",
        "11111111-1111-4111-8111-111111111111/../query",
    ] {
        assert!(workflow_runs_url("https://relay.test", invalid, None).is_err());
    }
    assert!(workflow_runs_url(
        "https://relay.test",
        id,
        Some(&WorkflowCursor {
            before: "2026-09-29T20:00:00Z&target=x".into(),
            before_id: id.into()
        })
    )
    .is_err());
    assert!(request_url(
        "https://relay.test",
        "/workflows/11111111-1111-4111-8111-111111111111/runs",
        "GET"
    )
    .is_err());
}

#[test]
fn workflow_signer_rejects_nonworkflow_deletes_and_invalid_commands() {
    let id = "11111111-1111-4111-8111-111111111111";
    let mut event = EventTemplate {
        kind: 5,
        created_at: 1,
        content: "".into(),
        tags: vec![
            vec!["h".into(), id.into()],
            vec!["a".into(), format!("30620:{}:{id}", "a".repeat(64))],
        ],
    };
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.tags[1][1] = format!("30030:{}:{id}", "a".repeat(64));
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[1][1] = format!("30620:{}:{id}", "a".repeat(64));
    event.tags.push(vec!["e".into(), "b".repeat(64)]);
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags.pop();
    event.kind = 46020;
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[1] = vec!["d".into(), id.into()];
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.content = "not empty".into();
    assert!(validate_event("https://relay.test", &event).is_err());
}

#[tokio::test]
async fn workflow_get_is_authenticated_without_payload_and_never_redirects() {
    let (mut url, task) = fixture_server("HTTP/1.1 302 Found\r\nLocation: https://other.test/\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into());
    url.set_path("/workflows/11111111-1111-4111-8111-111111111111/runs");
    url.set_query(Some("limit=20"));
    let response = send(
        &IdentityHost::fixture(),
        None,
        url.clone(),
        "GET",
        None,
        true,
        1024 * 1024,
    )
    .await
    .unwrap();
    assert_eq!(response.status, 302);
    let (headers, body) = task.join().unwrap();
    assert!(headers
        .starts_with("GET /workflows/11111111-1111-4111-8111-111111111111/runs?limit=20 HTTP/1.1"));
    assert!(body.is_empty());
    let encoded = headers
        .lines()
        .find_map(|line| line.strip_prefix("authorization: Nostr "))
        .unwrap();
    let event: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
    assert_eq!(event["tags"][0], serde_json::json!(["u", url.as_str()]));
    assert_eq!(event["tags"][1], serde_json::json!(["method", "GET"]));
    assert_eq!(event["tags"].as_array().unwrap().len(), 3);
    verify(&event);
}

#[test]
fn shared_kind_five_signer_accepts_message_and_reaction_deletion_only_in_broker_shape() {
    let id = "a".repeat(64);
    let mut event = EventTemplate {
        kind: 5,
        created_at: 123,
        content: String::new(),
        tags: vec![
            vec!["h".into(), "room".into()],
            vec!["e".into(), id.clone()],
            vec!["k".into(), "9".into()],
            vec!["client-id".into(), "intent".into()],
        ],
    };
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.created_at = 9_007_199_254_740_992;
    assert!(validate_event("https://relay.test", &event).is_err());
    event.created_at = 123;
    event.content = "not empty".into();
    assert!(validate_event("https://relay.test", &event).is_err());
    event.content.clear();
    event.tags[0][1].clear();
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[0][1] = "😀".repeat(128);
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.tags[0][1].push('😀');
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[0][1] = "room".into();
    event.tags[2][1] = "7".into();
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.tags[2][1] = "40002".into();
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.tags[2][1] = "30620".into();
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[2][1] = "9".into();
    event.tags.push(vec!["e".into(), id.clone()]);
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags.pop();
    event.tags[1][1] = "A".repeat(64);
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[1][1] = id;
    event.tags.push(vec!["a".into(), "30620:other:id".into()]);
    assert!(validate_event("https://relay.test", &event).is_err());
}

#[test]
fn shared_kind_five_signer_accepts_only_one_agent_record_deletion() {
    let owner = "a".repeat(64);
    let agent = "b".repeat(64);
    let mut event = EventTemplate {
        kind: 5,
        created_at: 123,
        content: String::new(),
        tags: vec![
            vec!["a".into(), format!("30177:{owner}:{agent}")],
            vec!["client-id".into(), "intent".into()],
        ],
    };
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.tags.pop();
    assert!(validate_event("https://relay.test", &event).is_ok());
    for coordinate in [
        format!("30175:{owner}:{agent}"),
        format!("30177:{owner}:{}", "B".repeat(64)),
        format!("30177:{owner}:{agent}:extra"),
        format!("30177:{owner}"),
    ] {
        event.tags[0][1] = coordinate;
        assert!(validate_event("https://relay.test", &event).is_err());
    }
    event.tags[0][1] = format!("30177:{owner}:{agent}");
    event.content = "reason".into();
    assert!(validate_event("https://relay.test", &event).is_err());
    event.content.clear();
    event
        .tags
        .push(vec!["a".into(), format!("30177:{owner}:{owner}")]);
    assert!(validate_event("https://relay.test", &event).is_err());
}

#[test]
fn native_write_commands_reach_handlers_through_production_ipc() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .manage(FederatedIdentity::new().unwrap())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let requests = [
        (
            "relay_channel_sign",
            serde_json::json!({"community":"https://relay.test","route":"channel-lifecycle","event":{"kind":9002,"created_at":1700000010,"content":"","tags":[["h","11111111-1111-4111-8111-111111111111"],["archived","true"]]}}),
        ),
        (
            "relay_kit_prepare",
            serde_json::json!({"community":"https://relay.test","record":{"version":1,"community":"https://relay.test","deleted":false,"value":{"type":"team","id":"mine","name":"Mine","agents":[]}}}),
        ),
        (
            "relay_kit_decode",
            serde_json::json!({"community":"https://relay.test","events":[]}),
        ),
        (
            "relay_kit_sign",
            serde_json::json!({"community":"invalid","event":{"kind":30078,"created_at":1,"content":"","tags":[]}}),
        ),
        (
            "relay_channel_publish",
            serde_json::json!({"community":"invalid","route":"channel-lifecycle","event":{}}),
        ),
        (
            "relay_direct_message",
            serde_json::json!({"community":"invalid","pubkeys":[]}),
        ),
    ];
    for (command, body) in requests {
        let result = get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        );
        if let Err(error) = result {
            assert!(
                !error.to_string().contains("not allowed"),
                "{command} blocked by ACL: {error}"
            );
        }
    }
}

#[test]
fn channel_commands_sign_archive_and_unarchive_and_reject_malformed_tags_through_ipc() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .manage(FederatedIdentity::new().unwrap())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let invoke = |tags: Vec<Vec<String>>| {
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: "relay_channel_sign".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                    "community": "https://relay.test", "route": "channel-lifecycle",
                    "event": { "kind": 9002, "created_at": 123, "content": "", "tags": tags }
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
    };
    let h = vec!["h".into(), uuid::Uuid::nil().to_string()];
    let archived = vec!["archived".into(), "true".into()];
    for value in ["true", "false"] {
        let tags = vec![h.clone(), vec!["archived".into(), value.into()]];
        let event: serde_json::Value = invoke(tags.clone()).unwrap().deserialize().unwrap();
        verify(&event);
        assert_eq!(event["tags"], serde_json::json!(tags));
        assert_eq!(event["kind"], 9002);
        assert_eq!(event["content"], "");
    }
    for tags in [
        vec![vec![], archived.clone()],
        vec![vec!["h".into()], archived.clone()],
        vec![h.clone(), vec!["archived".into()]],
        vec![h.clone(), vec!["archived".into(), "invalid".into()]],
        vec![h.clone(), h.clone()],
        vec![archived.clone(), h.clone()],
    ] {
        let error = match invoke(tags) {
            Ok(_) => panic!("invalid tag must reject"),
            Err(error) => error,
        };
        assert!(
            !error.to_string().contains("not allowed"),
            "ACL blocked command: {error}"
        );
    }
}

#[test]
fn creation_rejects_truncated_tags_through_existing_ipc() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .manage(FederatedIdentity::new().unwrap())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    for tag in [vec![], vec!["h"]] {
        let response = get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: "relay_sign".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                    "community": "https://relay.test",
                    "event": { "kind": 9007, "created_at": 123, "content": "", "tags": [
                        tag, ["name", "Team"], ["visibility", "private"], ["channel_type", "stream"]
                    ] }
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        );
        let error = match response {
            Ok(_) => panic!("malformed creation must reject before discovery"),
            Err(error) => error,
        };
        assert!(
            !error.to_string().contains("not allowed"),
            "ACL blocked command: {error}"
        );
    }
}

#[tokio::test]
async fn discovery_body_is_bounded_for_length_and_chunked_transfer() {
    for chunked in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let task = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 2048];
            loop {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0, "request ended before headers completed");
                bytes.extend_from_slice(&buffer[..count]);
                assert!(
                    bytes.len() <= 16 * 1024,
                    "request headers exceeded fixture limit"
                );
                if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            if chunked {
                socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
                // Valid chunked response, over the budget on the first chunk.
                socket
                    .write_all(format!("{:X}\r\n", MAX_BODY + 1).as_bytes())
                    .unwrap();
                socket.write_all(&vec![b'x'; MAX_BODY + 1]).unwrap();
                let _ = socket.write_all(b"\r\n0\r\n\r\n");
            } else {
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            MAX_BODY + 1
                        )
                        .as_bytes(),
                    )
                    .unwrap();
                // Headers alone must suffice: do not wait for the advertised body.
            }
        });
        let mut response = client().unwrap().get(url).send().await.unwrap();
        assert_eq!(
            read_bounded(&mut response, MAX_BODY, "interrupted", "oversized")
                .await
                .unwrap_err(),
            "oversized"
        );
        task.join().unwrap();
    }
}

#[tokio::test]
async fn sidebar_ipc_only_decodes_verified_self_coordinates_and_signs_valid_payloads() {
    let host = IdentityHost::fixture();
    let payload =
        serde_json::json!({"version":1,"channels":{"channel":{"starred":true,"updatedAt":1}}});
    let event = host
        .sign_sidebar("channel-stars".into(), payload.clone(), 1)
        .await
        .unwrap();
    verify(&event);
    assert_eq!(
        host.decode_sidebar(vec![event.clone()]).await.unwrap()["channel-stars"],
        payload
    );
    assert!(host
        .decode_sidebar(vec![event.clone(), event.clone()])
        .await
        .is_err());
    assert!(host.decode_sidebar(vec![event.clone(); 5]).await.is_err());
    let mut tampered = event.clone();
    tampered["content"] = serde_json::json!("changed");
    assert!(host.decode_sidebar(vec![tampered]).await.is_err());
    let mut wrong_coordinate = event.clone();
    wrong_coordinate["tags"][0][1] = serde_json::json!("unknown");
    assert!(host.decode_sidebar(vec![wrong_coordinate]).await.is_err());
    assert!(host
        .sign_sidebar("other".into(), payload.clone(), 1)
        .await
        .is_err());
    assert!(host.sign_sidebar("channel-stars".into(), serde_json::json!({"version":1,"channels":{"c":{"starred":"not boolean","updatedAt":1}}}), 1).await.is_err());
    let other = IdentityHost::fixture()
        .sign_sidebar(
            "channel-sort".into(),
            serde_json::json!({"version":1,"groups":{}}),
            1,
        )
        .await
        .unwrap();
    assert_eq!(
        host.decode_sidebar(vec![other]).await.unwrap()["channel-sort"]["version"],
        1
    );
}

#[tokio::test]
async fn event_writer_admits_sidebar_records_and_recipes_by_their_own_coordinate() {
    let host = IdentityHost::fixture();
    let community = "https://relay.test";
    for (coordinate, payload) in [
        (
            "channel-sections",
            serde_json::json!({"version":1,"sections":[{"id":"group","name":"Group","order":0}],"assignments":{"channel":"group"}}),
        ),
        (
            "channel-stars",
            serde_json::json!({"version":1,"channels":{"channel":{"starred":true,"updatedAt":1}}}),
        ),
        (
            "channel-mutes",
            serde_json::json!({"version":1,"channels":{"channel":{"muted":true,"updatedAt":1}}}),
        ),
        (
            "channel-sort",
            serde_json::json!({"version":1,"groups":{"channels":"recent"}}),
        ),
        (
            "channel-filter",
            serde_json::json!({"version":1,"groups":{"channels":"active"}}),
        ),
    ] {
        let event = host
            .sign_sidebar(coordinate.into(), payload, 1)
            .await
            .unwrap();
        admit_app_data(&host, &event, community).await.unwrap();
    }
    let sidebar = host
        .sign_sidebar(
            "channel-sort".into(),
            serde_json::json!({"version":1,"groups":{}}),
            1,
        )
        .await
        .unwrap();
    let mut tampered = sidebar.clone();
    tampered["content"] = serde_json::json!("changed");
    assert!(admit_app_data(&host, &tampered, community).await.is_err());
    let mut foreign = sidebar.clone();
    foreign["pubkey"] = serde_json::json!("02".repeat(32));
    assert!(admit_app_data(&host, &foreign, community).await.is_err());

    // Anything outside the sidebar coordinates is still held to the recipe contract.
    let sign = |tags: Vec<Vec<String>>, content: String| {
        host.sign(crate::identity::EventTemplate {
            kind: 30078,
            created_at: 1,
            content,
            tags,
        })
    };
    let recipe = serde_json::json!({"version":1,"community":community,"deleted":false,
        "value":{"type":"team","id":"team-one","name":"Team","agents":[]}});
    let ciphertext = host.kit_cipher(recipe.to_string(), true).await.unwrap();
    let coordinate = "buzz-channel-kit-v1:https%3A%2F%2Frelay.test:team:team-one";
    let kit_tags = |d: &str| {
        vec![
            vec!["d".to_owned(), d.to_owned()],
            vec!["t".to_owned(), "buzz-channel-kit-v1".to_owned()],
        ]
    };
    let valid = sign(kit_tags(coordinate), ciphertext.clone())
        .await
        .unwrap();
    admit_app_data(&host, &valid, community).await.unwrap();
    // A recipe cannot borrow a sidebar coordinate, and a sidebar record cannot borrow another.
    for d in ["channel-sections", "read-state:other", "unknown"] {
        let event = sign(kit_tags(d), ciphertext.clone()).await.unwrap();
        assert!(admit_app_data(&host, &event, community).await.is_err());
    }
    let mut duplicate = kit_tags(coordinate);
    duplicate.push(vec!["d".to_owned(), "channel-stars".to_owned()]);
    let event = sign(duplicate, ciphertext).await.unwrap();
    assert!(admit_app_data(&host, &event, community).await.is_err());
}

#[tokio::test]
async fn sidebar_decoder_interoperates_with_nostr_tools_nip44_v2() {
    // Produced with nostr-tools 2.25.2, private key [1; 32].
    let event: serde_json::Value = serde_json::from_str(r#"{"kind":30078,"created_at":1700000000,"tags":[["d","channel-mutes"],["t","channel-mutes"]],"content":"Ajhdtq+PsGhpLGhyo0hAN55quGVmOE8/p0id4UVmJPz/Aki5aZUHWBymErqORblF9uPjX6XD5DjFJDR18qIHIIullzAvPKE5z336CV5caxsevvNkXoeRk7U0xVpk+piVfM9z2+cgyuJoG3cGMzFp78/53XHDvsEUgtE9Wv8kgvj5vQc=","pubkey":"1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f","id":"e4471969b8f1b27fad968343db8deb4346c3e530c69b548f68a6adb31f99628c","sig":"14064569d6085363f32865b2204037c4a5769a09f116209fda3790feef12e6672d1806c7626c6857d0696cfe43f39ed4a8dc13d965989300ec757fb3a2fd44cd"}"#).unwrap();
    assert_eq!(
        IdentityHost::fixture()
            .decode_sidebar(vec![event])
            .await
            .unwrap()["channel-mutes"],
        serde_json::json!({"version":1,"channels":{"cross":{"muted":true,"updatedAt":1}}})
    );
}

#[tokio::test]
async fn sidebar_signer_matches_projection_lengths_and_preserves_unknown_sort_entries() {
    let host = IdentityHost::fixture();
    let unicode = "界".repeat(120);
    let groups = serde_json::json!({"version":1,"sections":[{"id":"group","name":unicode,"order":0}],"assignments":{"c":"group"}});
    let event = host
        .sign_sidebar("channel-sections".into(), groups.clone(), 1)
        .await
        .unwrap();
    assert_eq!(
        host.decode_sidebar(vec![event]).await.unwrap()["channel-sections"],
        groups
    );
    // A valid head from another client must remain writable after a native move.
    let mut existing = groups.clone();
    existing["assignments"]["other"] = serde_json::json!("group");
    let event = host
        .sign_sidebar("channel-sections".into(), existing.clone(), 2)
        .await
        .unwrap();
    assert_eq!(
        host.decode_sidebar(vec![event]).await.unwrap()["channel-sections"],
        existing
    );
    // Same preservation vector as browser-host/sidebar-sort.test.mjs: unrelated modes,
    // section keys and top-level metadata survive an override update.
    let sort = serde_json::json!({"version":1,"future":{"x":1},"groups":{
        "channels":"recent","section:elsewhere":"recent","future":"next-mode","section:work":"recent"
    }});
    let event = host
        .sign_sidebar("channel-sort".into(), sort.clone(), 1)
        .await
        .unwrap();
    assert_eq!(
        host.decode_sidebar(vec![event]).await.unwrap()["channel-sort"],
        sort
    );
    assert!(host.sign_sidebar("channel-sections".into(), serde_json::json!({"version":1,"sections":[{"id":"group","name":"界".repeat(257),"order":0}],"assignments":{}}), 1).await.is_err());
}

#[tokio::test]
async fn sidebar_signer_supports_large_records_without_expanding_general_signing() {
    let host = IdentityHost::fixture();
    let channels: serde_json::Map<String, serde_json::Value> = (0..500)
        .map(|i| {
            (
                format!("{i:08x}-1234-1234-1234-123456789abc"),
                serde_json::json!({"starred":true,"updatedAt":1700000000000_u64}),
            )
        })
        .collect();
    let event = host
        .sign_sidebar(
            "channel-stars".into(),
            serde_json::json!({"version":1,"channels":channels}),
            1,
        )
        .await
        .unwrap();
    verify(&event);
    assert!(event["content"].as_str().unwrap().len() > 64 * 1024);
    assert_eq!(
        host.decode_sidebar(vec![event]).await.unwrap()["channel-stars"]["channels"]
            .as_object()
            .unwrap()
            .len(),
        500
    );
    let muted: serde_json::Map<String, serde_json::Value> = (0..500)
        .map(|i| {
            (
                format!("{i:08x}-1234-1234-1234-123456789abc"),
                serde_json::json!({"muted":i % 2 == 0,"updatedAt":1700000000000_u64}),
            )
        })
        .collect();
    let event = host
        .sign_sidebar(
            "channel-mutes".into(),
            serde_json::json!({"version":1,"channels":muted}),
            1,
        )
        .await
        .unwrap();
    verify(&event);
    assert_eq!(
        host.decode_sidebar(vec![event]).await.unwrap()["channel-mutes"]["channels"]
            .as_object()
            .unwrap()
            .len(),
        500
    );
    let assignments: serde_json::Map<String, serde_json::Value> = (0..1000)
        .map(|i| {
            (
                format!("{i:08x}-1234-1234-1234-123456789abc"),
                serde_json::json!("group"),
            )
        })
        .collect();
    let event = host.sign_sidebar("channel-sections".into(), serde_json::json!({
        "version":1,"sections":[{"id":"group","name":"Work","order":0}],"assignments":assignments
    }), 1).await.unwrap();
    verify(&event);
    assert_eq!(
        host.decode_sidebar(vec![event]).await.unwrap()["channel-sections"]["assignments"]
            .as_object()
            .unwrap()
            .len(),
        1000
    );
    assert!(host
        .sign(EventTemplate {
            kind: 9,
            created_at: 1,
            tags: vec![],
            content: "x".repeat(65_536)
        })
        .await
        .is_err());
}

#[tokio::test]
async fn sidebar_signer_and_decoder_match_broker_plaintext_boundaries() {
    let host = IdentityHost::fixture();
    // Unknown string sort modes are preserved by both clients; use one to place
    // actual JSON exactly on each wire-format and application budget boundary.
    let prefix = r#"{"groups":{"future":""#;
    let suffix = r#""},"version":1}"#;
    for size in [65_408, 65_409, 65_535, 65_536, 128 * 1024] {
        let filler = "x".repeat(size - prefix.len() - suffix.len());
        let payload = serde_json::json!({"version":1,"groups":{"future":filler}});
        assert_eq!(serde_json::to_string(&payload).unwrap().len(), size);
        let event = host
            .sign_sidebar("channel-sort".into(), payload.clone(), 1)
            .await
            .unwrap();
        verify(&event);
        assert_eq!(
            host.decode_sidebar(vec![event]).await.unwrap()["channel-sort"],
            payload
        );
    }
    let oversized = serde_json::json!({
        "version":1,"groups":{"future":"x".repeat(128 * 1024 - prefix.len() - suffix.len() + 1)}
    });
    assert_eq!(
        serde_json::to_string(&oversized).unwrap().len(),
        128 * 1024 + 1
    );
    assert_eq!(
        host.sign_sidebar("channel-sort".into(), oversized, 1)
            .await
            .unwrap_err(),
        "Sidebar plaintext budget exceeded"
    );
}

#[tokio::test]
async fn sidebar_decoder_accepts_broker_extended_length_sections_alongside_other_preferences() {
    let host = IdentityHost::fixture();
    let section = "12345678-1234-1234-1234-123456789abc";
    let assignments: serde_json::Map<String, serde_json::Value> = (0..1000)
        .map(|i| {
            (
                format!("{i:08x}-1234-1234-1234-123456789abc"),
                serde_json::json!(section),
            )
        })
        .collect();
    let sections = serde_json::json!({"version":1,"sections":[{"id":section,"name":"Work","order":0}],"assignments":assignments});
    assert!(serde_json::to_vec(&sections).unwrap().len() > 65_535);
    let mut events = vec![host
        .sign_sidebar("channel-sections".into(), sections.clone(), 1)
        .await
        .unwrap()];
    for coordinate in ["channel-stars", "channel-mutes", "channel-sort"] {
        let payload = if coordinate == "channel-sort" {
            serde_json::json!({"version":1,"groups":{}})
        } else {
            serde_json::json!({"version":1,"channels":{}})
        };
        events.push(
            host.sign_sidebar(coordinate.into(), payload, 1)
                .await
                .unwrap(),
        );
    }
    let decoded = host.decode_sidebar(events).await.unwrap();
    assert_eq!(decoded["channel-sections"], sections);
    assert_eq!(decoded["channel-stars"]["version"], 1);
    assert_eq!(decoded["channel-mutes"]["version"], 1);
    assert_eq!(decoded["channel-sort"]["version"], 1);
}

#[tokio::test]
async fn sidebar_decoder_accepts_four_maximum_plaintext_records_and_bounds_total_upload() {
    let host = IdentityHost::fixture();
    let mut events = Vec::new();
    for coordinate in [
        "channel-sort",
        "channel-sections",
        "channel-stars",
        "channel-mutes",
    ] {
        // Preserved top-level data can fill the plaintext budget without
        // bypassing each coordinate's validated schema or the signer boundary.
        let mut value = match coordinate {
            "channel-sort" => serde_json::json!({"version":1,"groups":{},"future":""}),
            "channel-sections" => {
                serde_json::json!({"version":1,"sections":[],"assignments":{},"future":""})
            }
            _ => serde_json::json!({"version":1,"channels":{},"future":""}),
        };
        let overhead = serde_json::to_vec(&value).unwrap().len();
        value["future"] = serde_json::json!("x".repeat(128 * 1024 - overhead));
        assert_eq!(serde_json::to_vec(&value).unwrap().len(), 128 * 1024);
        events.push(
            host.sign_sidebar(coordinate.into(), value, 1)
                .await
                .unwrap(),
        );
    }
    let request_len = serde_json::to_vec(&events).unwrap().len();
    assert!(request_len > 512 * 1024 && request_len < 768 * 1024);
    assert_eq!(
        host.decode_sidebar(events)
            .await
            .unwrap()
            .as_object()
            .unwrap()
            .len(),
        4
    );
}

#[tokio::test]
async fn sidebar_decoder_loads_four_populated_bounded_coordinates() {
    let host = IdentityHost::fixture();
    let section = "00000000-1234-1234-1234-123456789abc";
    let assignments: serde_json::Map<String, serde_json::Value> = (0..1000)
        .map(|i| {
            (
                format!("{i:08x}-1234-1234-1234-123456789abc"),
                serde_json::json!(section),
            )
        })
        .collect();
    let sections: serde_json::Value =
        serde_json::json!({"version":1,"sections":[],"assignments":assignments});
    let named_sections: Vec<_> = (0..100)
        .map(|i| serde_json::json!({"id":format!("{i:08x}-1234-1234-1234-123456789abc"),"name":"N".repeat(198),"order":i}))
        .collect();
    let mut sections = sections;
    sections["sections"] = serde_json::json!(named_sections);
    let mut events = vec![host
        .sign_sidebar("channel-sections".into(), sections.clone(), 1)
        .await
        .unwrap()];
    for (coordinate, field) in [("channel-stars", "starred"), ("channel-mutes", "muted")] {
        let channels: serde_json::Map<String, serde_json::Value> = (0..500)
            .map(|i| {
                (
                    format!("{i:08x}-5678-1234-1234-123456789abc"),
                    serde_json::json!({field: true, "updatedAt": 1_700_000_000_000_u64}),
                )
            })
            .collect();
        let event = host
            .sign_sidebar(
                coordinate.into(),
                serde_json::json!({"version":1,"channels":channels}),
                1,
            )
            .await
            .unwrap();
        assert_eq!(
            host.decode_sidebar(vec![event.clone()]).await.unwrap()[coordinate]["channels"]
                .as_object()
                .unwrap()
                .len(),
            500
        );
        events.push(event);
    }
    let sort = serde_json::json!({"version":1,"groups":{"channels":"recent"}});
    events.push(
        host.sign_sidebar("channel-sort".into(), sort.clone(), 1)
            .await
            .unwrap(),
    );
    let request_bytes = serde_json::to_vec(&events).unwrap().len();
    assert!(
        request_bytes > 256 * 1024,
        "fixture must cross old aggregate budget: {request_bytes}"
    );
    let decoded = host.decode_sidebar(events).await.unwrap();
    assert_eq!(decoded["channel-sections"], sections);
    assert_eq!(
        decoded["channel-stars"]["channels"]
            .as_object()
            .unwrap()
            .len(),
        500
    );
    assert_eq!(
        decoded["channel-mutes"]["channels"]
            .as_object()
            .unwrap()
            .len(),
        500
    );
    assert_eq!(decoded["channel-sort"], sort);
}

#[test]
fn js_signs_emoji_sets_but_never_blossom_tokens() {
    let template = |kind| EventTemplate {
        kind,
        created_at: 1,
        content: "Upload attachment".into(),
        tags: vec![vec!["t".into(), "upload".into()]],
    };
    assert!(validate_event("https://relay.test", &template(30030)).is_ok());
    assert!(validate_event("https://relay.test", &template(24242)).is_err());
}

#[test]
fn media_proxy_only_reaches_relay_blobs() {
    let hash = "a".repeat(64);
    for target in [
        format!("https://relay.test/media/{hash}"),
        format!("https://relay.test/media/{hash}.png"),
        format!("https://relay.test:8443/media/{hash}.thumb.jpg"),
    ] {
        assert!(media_url(&target).is_some(), "{target}");
    }
    for target in [
        format!("http://relay.test/media/{hash}"),
        format!("https://u:p@relay.test/media/{hash}"),
        format!("https://relay.test/media/{hash}?x=1"),
        format!("https://relay.test/media/{hash}#x"),
        format!("https://relay.test/media/{hash}?"),
        format!("https://relay.test/media/{hash}#"),
        format!("https://relay.test/media/{hash}.png#buzz-anim=https%3A%2F%2Frelay.test%2Fmedia%2F{hash}.png"),
        format!("https://relay.test/media/{hash}.tar.gz"),
        format!("https://relay.test/upload/{hash}"),
        format!("https://relay.test/media/{}", "A".repeat(64)),
        format!("https://relay.test/media/{hash}/../../query"),
        format!("https://relay.test/media/{hash}.PNG"),
        "https://relay.test/media/abc".into(),
        "file:///etc/passwd".into(),
    ] {
        assert!(media_url(&target).is_none(), "{target}");
    }
}

#[test]
fn native_downloads_only_accept_authenticated_media_urls() {
    let hash = "a".repeat(64);
    let target = format!("https://relay.test/media/{hash}.pdf");
    let encoded: String =
        percent_encoding::utf8_percent_encode(&target, percent_encoding::NON_ALPHANUMERIC)
            .to_string();
    for url in [
        format!("buzz-media://localhost/{encoded}"),
        format!("http://buzz-media.localhost/{encoded}"),
    ] {
        assert!(download_target(&url).is_some(), "{url}");
    }
    for url in [
        format!("buzz-media://evil.test/{encoded}"),
        format!("http://buzz-media.localhost.evil.test/{encoded}"),
        format!("https://buzz-media.localhost/{encoded}"),
        format!("buzz-media://localhost:123/{encoded}"),
        format!("buzz-media://localhost/{encoded}?q=1"),
        format!("buzz-media://localhost/{encoded}#fragment"),
        format!("buzz-media://u:p@localhost/{encoded}"),
        format!(
            "buzz-media://localhost/{}",
            percent_encoding::utf8_percent_encode(
                "https://relay.test/query",
                percent_encoding::NON_ALPHANUMERIC
            )
        ),
    ] {
        assert!(download_target(&url).is_none(), "{url}");
    }
}

#[test]
fn clipboard_decodes_pixels_and_rejects_invalid_or_oversized_images() {
    use image::{ImageEncoder as _, Rgba, RgbaImage};
    let pixels = RgbaImage::from_fn(2, 1, |x, _| {
        if x == 0 {
            Rgba([255, 0, 0, 255])
        } else {
            Rgba([0, 80, 200, 128])
        }
    });
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(pixels.as_raw(), 2, 1, image::ExtendedColorType::Rgba8)
        .unwrap();
    assert_eq!(
        clipboard_pixels(&png).unwrap(),
        (2, 1, pixels.clone().into_raw())
    );
    let mut webp = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut webp)
        .write_image(pixels.as_raw(), 2, 1, image::ExtendedColorType::Rgba8)
        .unwrap();
    assert_eq!(clipboard_pixels(&webp).unwrap(), (2, 1, pixels.into_raw()));
    assert!(clipboard_pixels(b"not an image").is_err());
    assert!(clipboard_pixels(&vec![0; 50 * 1024 * 1024 + 1]).is_err());

    // A valid, compressible image exceeds the 50 MiB expanded RGBA cap.
    let huge = RgbaImage::from_pixel(4096, 4096, Rgba([1, 2, 3, 255]));
    let mut encoded = Vec::new();
    image::codecs::png::PngEncoder::new(&mut encoded)
        .write_image(huge.as_raw(), 4096, 4096, image::ExtendedColorType::Rgba8)
        .unwrap();
    assert!(encoded.len() < 50 * 1024 * 1024);
    assert!(clipboard_pixels(&encoded).is_err());
}

#[test]
fn clipboard_bounds_embedded_webp_vp8_frames_before_decode() {
    fn chunk(tag: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut bytes = tag.to_vec();
        bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(data);
        if data.len() & 1 != 0 {
            bytes.push(0);
        }
        bytes
    }
    fn webp(chunks: &[u8]) -> Vec<u8> {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&(chunks.len() as u32 + 4).to_le_bytes());
        bytes.extend_from_slice(b"WEBP");
        bytes.extend_from_slice(chunks);
        bytes
    }
    let vp8 = |width: u16, height: u16| {
        let mut header = [0, 0, 0, 0x9d, 0x01, 0x2a, 0, 0, 0, 0];
        header[6..8].copy_from_slice(&width.to_le_bytes());
        header[8..10].copy_from_slice(&height.to_le_bytes());
        chunk(b"VP8 ", &header)
    };
    let mut static_chunks = chunk(b"VP8X", &[0, 0, 0, 0, 63, 0, 0, 63, 0, 0]);
    static_chunks.extend(vp8(64, 64));
    assert!(check_webp_vp8_frames(&webp(&static_chunks), 64 * 64 * 4).is_ok());
    assert!(check_webp_vp8_frames(&webp(&static_chunks), 4 * 4 * 384 - 1).is_err());
    let mut mismatch = chunk(b"VP8X", &[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    mismatch.extend(vp8(64, 64));
    assert!(check_webp_vp8_frames(&webp(&mismatch), 64 * 64 * 4).is_err());

    // Padded VP8 planes have their own bound; odd dimensions must not lower
    // the existing (unpadded) RGBA output cap.
    let mut odd = chunk(b"VP8X", &[0, 0, 0, 0, 32, 0, 0, 32, 0, 0]);
    odd.extend(vp8(33, 33));
    assert!(check_webp_vp8_frames(&webp(&odd), 33 * 33 * 4).is_ok());
    assert!(check_webp_vp8_frames(&webp(&odd), 9 * 384 - 1).is_err());

    // The first animated frame nests VP8 after a 16-byte ANMF header.
    let mut frame = vec![0; 16];
    frame[6] = 63;
    frame[9] = 63;
    frame.extend(vp8(64, 64));
    let mut animated_chunks = chunk(b"VP8X", &[2, 0, 0, 0, 63, 0, 0, 63, 0, 0]);
    animated_chunks.extend(chunk(b"ANMF", &frame));
    assert!(check_webp_vp8_frames(&webp(&animated_chunks), 4 * 4 * 384 - 1).is_err());
    assert!(check_webp_vp8_frames(&webp(&animated_chunks), 64 * 64 * 4).is_ok());
    frame[6] = 0;
    assert!(check_webp_vp8_frames(&webp(&chunk(b"ANMF", &frame)), 64 * 64 * 4).is_err());
    frame[6] = 63;
    frame.pop();
    assert!(check_webp_vp8_frames(&webp(&chunk(b"ANMF", &frame)), 64 * 64 * 4).is_err());

    let mut alpha_frame = vec![0; 16];
    alpha_frame[6] = 63;
    alpha_frame[9] = 63;
    alpha_frame.extend(chunk(b"ALPH", &[0]));
    alpha_frame.extend(vp8(64, 64));
    assert!(check_webp_vp8_frames(&webp(&chunk(b"ANMF", &alpha_frame)), 64 * 64 * 4).is_ok());
    let vp8_tag = alpha_frame
        .windows(4)
        .position(|bytes| bytes == b"VP8 ")
        .unwrap();
    alpha_frame[vp8_tag..vp8_tag + 4].copy_from_slice(b"JUNK");
    assert!(check_webp_vp8_frames(&webp(&chunk(b"ANMF", &alpha_frame)), 64 * 64 * 4).is_err());
    alpha_frame.truncate(vp8_tag);
    assert!(check_webp_vp8_frames(&webp(&chunk(b"ANMF", &alpha_frame)), 64 * 64 * 4).is_err());

    let mut trailing = webp(&static_chunks);
    trailing.extend(vp8(64, 64));
    assert!(check_webp_vp8_frames(&trailing, 64 * 64 * 4).is_err());
}

#[test]
fn file_downloads_need_a_safe_name_and_bounded_raw_bytes() {
    use tauri::ipc::InvokeBody;
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    // Each request fails before a file is written.
    let save = |name: &str, body: InvokeBody| {
        let mut headers = tauri::http::HeaderMap::new();
        headers.insert("x-buzz-file-name", name.parse().unwrap());
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: "file_download".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body,
                headers,
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|_| ())
        .unwrap_err()
    };
    for name in [
        "",
        "..%2Fsecret.png",
        "a%3Ab.png",
        "CON",
        "Ada.agent.png%20",
        "%FF",
        "report.pdf",
        "report.json",
        "other.diagnostics.json",
        "buzz-network-report.txt",
        "..%2Fbuzz-network-report.diagnostics.json",
    ] {
        assert_eq!(
            save(name, InvokeBody::Raw(vec![1])),
            "Invalid file name",
            "{name}"
        );
    }
    let name = "Ada%20%F0%9F%A4%96.agent.png";
    assert_eq!(
        save(name, InvokeBody::Json(serde_json::json!({}))),
        "File body must be raw bytes"
    );
    assert_eq!(save(name, InvokeBody::Raw(Vec::new())), "Invalid file");
    assert_eq!(
        save(name, InvokeBody::Raw(vec![0; FILE_DOWNLOAD_MAX + 1])),
        "Invalid file"
    );
}

#[test]
fn download_names_are_safe_and_collisions_do_not_overwrite() {
    let url = Url::parse(&format!("https://relay.test/media/{}.pdf", "a".repeat(64))).unwrap();
    for invalid in [
        "",
        ".",
        "..",
        "../secret",
        "a/b",
        "a\\b",
        "a:b",
        "a\n.txt",
        "a?.pdf",
        "a*.pdf",
        "a\".pdf",
        "a<.pdf",
        "a>.pdf",
        "a|.pdf",
        "CON",
        "con.txt",
        "NUL.pdf",
        "COM1.txt",
        "LPT9",
        "report.",
        "report ",
        "invoice\u{202e}fdp.command",
        "\u{2066}file\u{2069}.pdf",
    ] {
        assert_eq!(
            download_name(invalid, &url),
            url.path().rsplit('/').next().unwrap()
        );
    }
    assert_eq!(
        download_name("Annual report.pdf", &url),
        "Annual report.pdf"
    );
    let dir = std::env::temp_dir().join(format!("buzz-download-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let first = save_download(&dir, "report.pdf", b"first").unwrap();
    let second = save_download(&dir, "report.pdf", b"second").unwrap();
    assert_eq!(first.file_name().unwrap(), "report.pdf");
    assert_eq!(second.file_name().unwrap(), "report (1).pdf");
    assert_eq!(std::fs::read(&first).unwrap(), b"first");
    assert_eq!(std::fs::read(&second).unwrap(), b"second");
    let snapshot = save_download(&dir, "Ada.agent.png", b"first").unwrap();
    assert_eq!(snapshot.file_name().unwrap(), "Ada.agent.png");
    let again = save_download(&dir, "Ada.agent.png", b"second").unwrap();
    assert_eq!(again.file_name().unwrap(), "Ada (1).agent.png");
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        let mut value = [0u8; 128];
        let length = unsafe {
            libc::fgetxattr(
                std::fs::File::open(&first).unwrap().as_raw_fd(),
                c"com.apple.quarantine".as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        assert!(length > 0, "missing quarantine mark");
        assert!(std::str::from_utf8(&value[..length as usize])
            .unwrap()
            .starts_with("0081;"));
    }
    #[cfg(target_os = "windows")]
    {
        let stream = format!("{}:Zone.Identifier", first.display());
        assert_eq!(
            std::fs::read(stream).unwrap(),
            b"[ZoneTransfer]\r\nZoneId=3\r\n"
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn media_ranges_are_single_and_bounded() {
    assert_eq!(media_range("bytes=0-"), Some((0, 4194303)));
    assert_eq!(media_range("bytes=10-20"), Some((10, 20)));
    assert_eq!(media_range("bytes=100-999999999"), Some((100, 4194403)));
    assert!(media_range(&format!("bytes={}-", u64::MAX)).is_none());
    for value in [
        "bytes=-500",
        "bytes=5-1",
        "bytes=0-1,4-5",
        "items=0-1",
        "bytes=x-",
    ] {
        assert!(media_range(value).is_none(), "{value}");
    }
}

#[test]
fn media_types_render_only_images_video_and_audio() {
    assert_eq!(
        media_type(Some("image/PNG; x=1")),
        ("image/png".into(), false)
    );
    assert_eq!(media_type(Some("video/mp4")), ("video/mp4".into(), false));
    assert_eq!(media_type(Some("audio/mpeg")), ("audio/mpeg".into(), false));
    for value in [
        Some("image/svg+xml"),
        Some("text/html"),
        Some("image/"),
        None,
    ] {
        assert_eq!(
            media_type(value),
            ("application/octet-stream".into(), true),
            "{value:?}"
        );
    }
}

fn blossom_event(headers: &str) -> serde_json::Value {
    let encoded = headers
        .lines()
        .find_map(|line| line.strip_prefix("authorization: Nostr "))
        .unwrap();
    let event: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
    verify(&event);
    event
}

fn tag<'a>(event: &'a serde_json::Value, name: &str) -> Vec<&'a str> {
    event["tags"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|tag| tag[0] == name)
        .map(|tag| tag[1].as_str().unwrap())
        .collect()
}

/// The relay's strict NIP-FI rules: one each of `t`, `server`, `expiration`,
/// expiry within 60 s of creation, non-empty content.
fn assert_strict(event: &serde_json::Value, verb: &str, server: &str) {
    assert_eq!(event["kind"], 24242);
    assert_ne!(event["content"], "");
    assert_eq!(tag(event, "t"), [verb]);
    assert_eq!(tag(event, "server"), [server]);
    let expiration: u64 = tag(event, "expiration")[0].parse().unwrap();
    assert_eq!(tag(event, "expiration").len(), 1);
    assert_eq!(expiration, event["created_at"].as_u64().unwrap() + 60);
}

#[tokio::test]
async fn media_proxy_signs_a_fresh_get_and_forwards_only_the_range() {
    let (base, task) = fixture_server(
        "HTTP/1.1 206 Partial Content\r\nContent-Type: text/html\r\nContent-Range: bytes 0-3/10\r\nContent-Length: 4\r\nConnection: close\r\n\r\n<b>x".into(),
    );
    let url = base.join(&format!("/media/{}", "a".repeat(64))).unwrap();
    let response = fetch_media(
        &IdentityHost::fixture(),
        None,
        url.clone(),
        Some("bytes=0-3".into()),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(response.body(), b"<b>x");
    let header = |name| response.headers().get(name).unwrap().to_str().unwrap();
    assert_eq!(header("content-type"), "application/octet-stream");
    assert_eq!(header("content-disposition"), "attachment");
    assert_eq!(header("x-content-type-options"), "nosniff");
    assert_eq!(header("content-range"), "bytes 0-3/10");
    let (headers, _) = task.join().unwrap();
    assert!(headers.starts_with(&format!("GET {} ", url.path())));
    assert!(headers.lines().any(|line| line == "range: bytes=0-3"));
    assert!(!headers.contains("cookie"));
    let server = &url[url::Position::BeforeHost..url::Position::AfterPort];
    assert_strict(&blossom_event(&headers), "get", server);
}

/// Serves `blob` by `Range`, failing the first `failures` requests with 503,
/// and records every upstream `Range` header.
pub(super) fn ranged_media_server(
    blob: Vec<u8>,
    failures: usize,
) -> (Url, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let ranges = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = ranges.clone();
    std::thread::spawn(move || {
        for socket in listener.incoming() {
            let mut socket = socket.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
            }
            let headers = String::from_utf8_lossy(&bytes).into_owned();
            let range = headers
                .lines()
                .find_map(|line| line.strip_prefix("range: bytes="))
                .unwrap()
                .to_owned();
            let count = {
                let mut seen = seen.lock().unwrap();
                seen.push(format!("bytes={range}"));
                seen.len()
            };
            if count <= failures {
                socket
                    .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .unwrap();
                continue;
            }
            let (first, last) = range.split_once('-').unwrap();
            let first: usize = first.parse().unwrap();
            if first >= blob.len() {
                let head = format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", blob.len());
                socket.write_all(head.as_bytes()).unwrap();
                continue;
            }
            let last = last.parse::<usize>().unwrap().min(blob.len() - 1);
            let body = &blob[first..=last];
            let head = format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Range: bytes {first}-{last}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                blob.len(),
                body.len()
            );
            socket.write_all(head.as_bytes()).unwrap();
            socket.write_all(body).unwrap();
        }
    });
    (base, ranges)
}

pub(super) fn media_blob(length: u64) -> Vec<u8> {
    (0..length).map(|index| (index % 251) as u8).collect()
}

#[tokio::test]
async fn tiny_media_reads_share_one_signed_block_fetch() {
    let blob = media_blob(3000);
    let (base, ranges) = ranged_media_server(blob.clone(), 0);
    let url = base
        .join(&format!("/media/{}.mp4", "c".repeat(64)))
        .unwrap();
    let host = IdentityHost::fixture();
    // AVFoundation's opening reads, two of them racing from separate players.
    let (header, atom) = tokio::join!(
        media_blocks::read(&host, None, &url, 0, 7, WHOLE_VIDEO_MAX),
        media_blocks::read(&host, None, &url, 32, 39, WHOLE_VIDEO_MAX),
    );
    let (header, atom) = (header.unwrap(), atom.unwrap());
    assert_eq!(header.body(), &blob[0..8]);
    assert_eq!(atom.body(), &blob[32..40]);
    let tail = media_blocks::read(
        &host,
        None,
        &url,
        2990,
        2990 + 4 * 1024 * 1024 - 1,
        WHOLE_VIDEO_MAX,
    )
    .await
    .unwrap();
    assert_eq!(tail.status(), 206);
    assert_eq!(tail.body(), &blob[2990..]);
    let header = |name| tail.headers().get(name).unwrap().to_str().unwrap();
    assert_eq!(header("content-range"), "bytes 2990-2999/3000");
    assert_eq!(header("content-type"), "video/mp4");
    assert_eq!(header("accept-ranges"), "bytes");
    assert_eq!(header("x-content-type-options"), "nosniff");
    assert_eq!(
        *ranges.lock().unwrap(),
        [format!("bytes=0-{}", media_blocks::BLOCK - 1)]
    );
}

#[tokio::test]
async fn media_reads_span_blocks_and_stop_at_the_blob_end() {
    let block = media_blocks::BLOCK;
    let blob = media_blob(block + 100);
    let (base, ranges) = ranged_media_server(blob.clone(), 0);
    let url = base
        .join(&format!("/media/{}.mp4", "d".repeat(64)))
        .unwrap();
    let host = IdentityHost::fixture();
    let across = media_blocks::read(&host, None, &url, block - 4, block + 3, WHOLE_VIDEO_MAX)
        .await
        .unwrap();
    assert_eq!(across.body(), &blob[block as usize - 4..block as usize + 4]);
    assert_eq!(
        across.headers()["content-range"],
        format!("bytes {}-{}/{}", block - 4, block + 3, block + 100)
    );
    assert_eq!(
        media_blocks::read(&host, None, &url, block + 100, block + 200, WHOLE_VIDEO_MAX)
            .await
            .unwrap_err(),
        416
    );
    assert_eq!(
        *ranges.lock().unwrap(),
        [
            format!("bytes=0-{}", block - 1),
            format!("bytes={block}-{}", 2 * block - 1),
        ]
    );
}

#[tokio::test]
async fn failed_media_blocks_are_fetched_again() {
    let blob = media_blob(64);
    let (base, ranges) = ranged_media_server(blob.clone(), 1);
    let url = base
        .join(&format!("/media/{}.mp4", "e".repeat(64)))
        .unwrap();
    let host = IdentityHost::fixture();
    assert_eq!(
        media_blocks::read(&host, None, &url, 0, 7, WHOLE_VIDEO_MAX)
            .await
            .unwrap_err(),
        503
    );
    let retried = media_blocks::read(&host, None, &url, 0, 7, WHOLE_VIDEO_MAX)
        .await
        .unwrap();
    assert_eq!(retried.body(), &blob[..8]);
    assert_eq!(ranges.lock().unwrap().len(), 2);
}

/// Answers each connection with the next canned response, ignoring the request.
fn scripted_media_server(
    responses: Vec<Vec<u8>>,
) -> (Url, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let served = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = served.clone();
    std::thread::spawn(move || {
        for (socket, response) in listener.incoming().zip(responses) {
            let mut socket = socket.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
            }
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            // The client may hang up on an oversized body.
            let _ = socket.write_all(&response);
        }
    });
    (base, served)
}

pub(super) fn media_response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: video/mp4\r\n{headers}Connection: close\r\n\r\n"
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

#[tokio::test]
async fn range_ignoring_upstreams_keep_the_whole_response_fallback() {
    let block = media_blocks::BLOCK;
    for (name, length) in [("f", 64), ("0", block + 64)] {
        let blob = media_blob(length);
        let whole = String::from_utf8_lossy(&media_response(
            "200 OK",
            &format!("Content-Length: {length}\r\n"),
            &[],
        ))
        .replace("video/mp4", "audio/mpeg")
        .into_bytes();
        let whole = [whole, blob.clone()].concat();
        let (base, served) = scripted_media_server(vec![whole.clone(), whole]);
        let url = base
            .join(&format!("/media/{}.mp3", name.repeat(64)))
            .unwrap();
        let host = IdentityHost::fixture();
        for _ in 0..2 {
            let response = media_blocks::read(&host, None, &url, 0, 7, WHOLE_VIDEO_MAX)
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            assert_eq!(response.body(), &blob);
            assert!(response.headers().get("content-range").is_none());
        }
        // A whole response is never cached as a block.
        assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 2);
    }
}

/// Spool tests share the process-wide spool list and open-file count.
pub(super) static SPOOL_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Ignores `Range` and sends `blob` whole as a 200, with `length` as its
/// `Content-Length`, in 64 KiB writes `pace` apart. Counts requests and
/// connections the client hung up on.
pub(super) fn whole_media_server(
    blob: Vec<u8>,
    length: Option<u64>,
    pace: Duration,
) -> (
    Url,
    std::sync::Arc<std::sync::atomic::AtomicUsize>,
    std::sync::Arc<std::sync::atomic::AtomicUsize>,
) {
    use std::sync::{atomic::AtomicUsize, atomic::Ordering, Arc};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let (served, hung_up) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let (count, hangups) = (served.clone(), hung_up.clone());
    let blob = Arc::new(blob);
    std::thread::spawn(move || {
        for socket in listener.incoming() {
            let mut socket = socket.unwrap();
            let (blob, count, hangups) = (blob.clone(), count.clone(), hangups.clone());
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                    let count = socket.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                }
                assert!(String::from_utf8_lossy(&bytes).contains("range: bytes="));
                count.fetch_add(1, Ordering::SeqCst);
                let length = length.map_or(String::new(), |length| {
                    format!("Content-Length: {length}\r\n")
                });
                let head = media_response("200 OK", &length, &[]);
                let sent = socket.write_all(&head).and_then(|()| {
                    for chunk in blob.chunks(64 * 1024) {
                        socket.write_all(chunk)?;
                        socket.flush()?;
                        std::thread::sleep(pace);
                    }
                    Ok(())
                });
                if sent.is_err() {
                    hangups.fetch_add(1, Ordering::SeqCst);
                }
            });
        }
    });
    (base, served, hung_up)
}

/// Waits for every spool file to be deleted, as idle eviction must do.
pub(super) async fn spool_files_deleted() {
    for _ in 0..100 {
        if media_spool::open_files() == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{} spool files remain", media_spool::open_files());
}

#[tokio::test]
async fn range_ignoring_videos_are_spooled_and_answered_as_exact_ranges() {
    let _serial = SPOOL_TESTS.lock().await;
    let block = media_blocks::BLOCK;
    let length = 3 * block + 17;
    let blob = media_blob(length);
    let (base, served, _) = whole_media_server(blob.clone(), Some(length), Duration::ZERO);
    let url = base
        .join(&format!("/media/{}.mp4", "2".repeat(64)))
        .unwrap();
    let host = IdentityHost::fixture();
    let limit = WHOLE_VIDEO_MAX;
    // Two players open the video at once; they share one spool.
    let (header, tail) = tokio::join!(
        media_blocks::read(&host, None, &url, 0, 7, limit),
        media_blocks::read(&host, None, &url, length - 8, length + 100, limit),
    );
    let (header, tail) = (header.unwrap(), tail.unwrap());
    assert_eq!(header.status(), 206);
    assert_eq!(header.body(), &blob[..8]);
    assert_eq!(
        header.headers()["content-range"],
        format!("bytes 0-7/{length}")
    );
    assert_eq!(header.headers()["content-type"], "video/mp4");
    assert_eq!(header.headers()["accept-ranges"], "bytes");
    assert_eq!(header.headers()["x-content-type-options"], "nosniff");
    assert_eq!(tail.body(), &blob[length as usize - 8..]);
    assert_eq!(
        tail.headers()["content-range"],
        format!("bytes {}-{}/{length}", length - 8, length - 1)
    );
    // A seek across blocks reads the same file.
    let seek = media_blocks::read(&host, None, &url, 2 * block - 4, 2 * block + 3, limit)
        .await
        .unwrap();
    assert_eq!(
        seek.body(),
        &blob[2 * block as usize - 4..2 * block as usize + 4]
    );
    assert_eq!(
        media_blocks::read(&host, None, &url, length, length + 8, limit)
            .await
            .unwrap_err(),
        416
    );
    assert!(served.load(std::sync::atomic::Ordering::SeqCst) <= 2);
    spool_files_deleted().await;
}

#[tokio::test]
async fn whole_videos_follow_the_configured_limit_boundary() {
    let _serial = SPOOL_TESTS.lock().await;
    let host = IdentityHost::fixture();
    // A configured limit other than the default.
    let limit = 2 * media_blocks::BLOCK + 5;
    for (name, length, sent_length, expected) in [
        ("3", limit, true, Ok(())),
        ("4", limit + 1, true, Err(413)),
        ("5", limit, false, Ok(())),
        ("6", limit + 1, false, Err(413)),
    ] {
        let blob = media_blob(length);
        let (base, served, _) =
            whole_media_server(blob.clone(), sent_length.then_some(length), Duration::ZERO);
        let url = base
            .join(&format!("/media/{}.mp4", name.repeat(64)))
            .unwrap();
        let read = media_blocks::read(&host, None, &url, length - 4, length - 1, limit).await;
        match expected {
            Ok(()) => {
                let read = read.unwrap();
                assert_eq!(read.body(), &blob[length as usize - 4..], "{name}");
                assert_eq!(
                    read.headers()["content-range"],
                    format!("bytes {}-{}/{length}", length - 4, length - 1)
                );
            }
            Err(status) => {
                assert_eq!(read.unwrap_err(), status, "{name}");
                // A rejected video is fetched again, never answered from a spool.
                assert_eq!(
                    media_blocks::read(&host, None, &url, 0, 7, limit)
                        .await
                        .unwrap_err(),
                    status
                );
                assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 2);
            }
        }
    }
    spool_files_deleted().await;
}

#[tokio::test]
async fn truncated_whole_videos_fail_and_are_fetched_again() {
    let _serial = SPOOL_TESTS.lock().await;
    let blob = media_blob(media_blocks::BLOCK + 9);
    let length = blob.len() as u64 + 10;
    let (base, served, _) = whole_media_server(blob, Some(length), Duration::ZERO);
    let url = base
        .join(&format!("/media/{}.mp4", "7".repeat(64)))
        .unwrap();
    let host = IdentityHost::fixture();
    for _ in 0..2 {
        assert_eq!(
            media_blocks::read(&host, None, &url, length - 4, length - 1, WHOLE_VIDEO_MAX)
                .await
                .unwrap_err(),
            502
        );
    }
    assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 2);
    spool_files_deleted().await;
}

#[tokio::test]
async fn abandoned_whole_video_downloads_stop_and_delete_their_file() {
    let _serial = SPOOL_TESTS.lock().await;
    let blob = media_blob(16 * media_blocks::BLOCK);
    let length = blob.len() as u64;
    // 64 KiB per 20 ms: the whole video would take over five seconds.
    let (base, _, hung_up) =
        whole_media_server(blob.clone(), Some(length), Duration::from_millis(20));
    let url = base
        .join(&format!("/media/{}.mp4", "8".repeat(64)))
        .unwrap();
    let host = IdentityHost::fixture();
    let first = media_blocks::read(&host, None, &url, 0, 7, WHOLE_VIDEO_MAX)
        .await
        .unwrap();
    assert_eq!(first.body(), &blob[..8]);
    assert_eq!(media_spool::open_files(), 1);
    // The player closes: no further reads arrive.
    spool_files_deleted().await;
    for _ in 0..100 {
        if hung_up.load(std::sync::atomic::Ordering::SeqCst) == 1 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the abandoned download kept its upstream connection");
}

/// Waits until the server has seen `count` hang-ups.
pub(super) async fn hung_up(hung_up: &std::sync::atomic::AtomicUsize, count: usize) {
    for _ in 0..100 {
        if hung_up.load(std::sync::atomic::Ordering::SeqCst) >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("an abandoned download kept its upstream connection");
}

pub(super) async fn spool_files_reach(count: usize) {
    for _ in 0..100 {
        if media_spool::open_files() == count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "{} spool files, expected {count}",
        media_spool::open_files()
    );
}

#[tokio::test]
async fn a_third_live_video_evicts_the_oldest_download_and_its_file() {
    let _serial = SPOOL_TESTS.lock().await;
    let blob = media_blob(media_blocks::BLOCK);
    let length = blob.len() as u64;
    // Without a length every read waits for the whole copy, about 0.6 s here.
    let (base, _, hangups) = whole_media_server(blob.clone(), None, Duration::from_millis(40));
    let host = std::sync::Arc::new(IdentityHost::fixture());
    let load = |name: &str| {
        let url = base
            .join(&format!("/media/{}.mp4", name.repeat(64)))
            .unwrap();
        let host = host.clone();
        tokio::spawn(async move {
            media_blocks::read(&host, None, &url, length - 4, length - 1, WHOLE_VIDEO_MAX).await
        })
    };
    let first = load("a");
    spool_files_reach(1).await;
    let second = load("b");
    spool_files_reach(2).await;
    let third = load("c");
    // Admitting the third waits for the oldest file to be deleted.
    let mut most = 0;
    while !third.is_finished() {
        most = most.max(media_spool::open_files());
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(most <= 2, "{most} spool files");
    assert_eq!(first.await.unwrap().unwrap_err(), 503);
    for load in [second.await.unwrap(), third.await.unwrap()] {
        assert_eq!(load.unwrap().body(), &blob[length as usize - 4..]);
    }
    hung_up(&hangups, 1).await;
    spool_files_deleted().await;
}

/// Sends `blob` whole to the first two requests, but only once both have
/// arrived, so their two 200 heads reach the client together.
fn paired_whole_media_server(blob: Vec<u8>) -> Url {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    std::thread::spawn(move || {
        let mut sockets: Vec<_> = listener
            .incoming()
            .take(2)
            .map(|socket| socket.unwrap())
            .collect();
        for socket in &mut sockets {
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
            }
        }
        let length = format!("Content-Length: {}\r\n", blob.len());
        for socket in &mut sockets {
            socket
                .write_all(&media_response("200 OK", &length, &[]))
                .unwrap();
        }
        let blob = std::sync::Arc::new(blob);
        for mut socket in sockets {
            let blob = blob.clone();
            std::thread::spawn(move || socket.write_all(&blob));
        }
    });
    base
}

#[tokio::test]
async fn concurrent_opens_of_one_new_video_evict_only_one_player() {
    let _serial = SPOOL_TESTS.lock().await;
    let blob = media_blob(2 * media_blocks::BLOCK + 17);
    let length = blob.len() as u64;
    // Without a length every read of these waits for the whole copy (1.3 s).
    let (old, _, _) = whole_media_server(blob.clone(), None, Duration::from_millis(40));
    let new = paired_whole_media_server(blob.clone());
    let url = |base: &Url, name: &str| {
        base.join(&format!("/media/{}.mp4", name.repeat(64)))
            .unwrap()
    };
    let urls = [url(&old, "d"), url(&old, "e"), url(&new, "f")];
    let host = std::sync::Arc::new(IdentityHost::fixture());
    let load = |url: &Url, start: u64, end: u64| {
        let (host, url) = (host.clone(), url.clone());
        tokio::spawn(async move {
            media_blocks::read(&host, None, &url, start, end, WHOLE_VIDEO_MAX).await
        })
    };
    let first = load(&urls[0], length - 4, length - 1);
    spool_files_reach(1).await;
    let second = load(&urls[1], length - 4, length - 1);
    spool_files_reach(2).await;
    // Holding both spools keeps their files, so the first admission of the
    // third video waits for a file while the second one arrives.
    let pinned = [
        media_spool::cached(&urls[0]).unwrap(),
        media_spool::cached(&urls[1]).unwrap(),
    ];
    // As the players' connections would, past their reads.
    let holds = [
        media_spool::hold(&urls[0]).unwrap(),
        media_spool::hold(&urls[1]).unwrap(),
    ];
    // Reads in two blocks of a third video fetch separately; both upstream
    // 200s reach admission together while both files are taken.
    let opening = load(&urls[2], 0, 7);
    let seek = load(&urls[2], length - 4, length - 1);
    while !first.is_finished() && !second.is_finished() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    // Room for a second, unneeded eviction to show before the files free up.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !(first.is_finished() && second.is_finished()),
        "one player's spool is enough to make room"
    );
    drop(pinned);
    assert_eq!(opening.await.unwrap().unwrap().body(), &blob[..8]);
    assert_eq!(
        seek.await.unwrap().unwrap().body(),
        &blob[length as usize - 4..]
    );
    // The new player's connection, while the old players' copies finish.
    let new_hold = media_spool::hold(&urls[2]).unwrap();
    let old_reads = [first.await.unwrap(), second.await.unwrap()];
    let evicted = old_reads
        .iter()
        .filter(|read| read.as_ref().err() == Some(&503))
        .count();
    assert_eq!(evicted, 1);
    for read in old_reads.into_iter().flatten() {
        assert_eq!(read.body(), &blob[length as usize - 4..]);
    }
    assert_eq!(media_spool::open_files(), 2);
    drop(new_hold);
    drop(holds);
    spool_files_deleted().await;
}

#[tokio::test]
async fn a_closed_player_waiting_for_an_unknown_length_stops_the_download() {
    let _serial = SPOOL_TESTS.lock().await;
    let blob = media_blob(16 * media_blocks::BLOCK);
    // Over five seconds to copy.
    let (base, _, hangups) = whole_media_server(blob, None, Duration::from_millis(20));
    let url = base
        .join(&format!("/media/{}.mp4", "9".repeat(64)))
        .unwrap();
    let host = std::sync::Arc::new(IdentityHost::fixture());
    let read = {
        let (host, url) = (host.clone(), url.clone());
        tokio::spawn(
            async move { media_blocks::read(&host, None, &url, 0, 7, WHOLE_VIDEO_MAX).await },
        )
    };
    spool_files_reach(1).await;
    // The player's connection closes, dropping the read it waits on.
    read.abort();
    assert!(read.await.unwrap_err().is_cancelled());
    spool_files_deleted().await;
    hung_up(&hangups, 1).await;
}

#[tokio::test]
async fn a_closed_player_waiting_on_a_seek_stops_the_download() {
    let _serial = SPOOL_TESTS.lock().await;
    let blob = media_blob(16 * media_blocks::BLOCK);
    let length = blob.len() as u64;
    let (base, _, hangups) =
        whole_media_server(blob.clone(), Some(length), Duration::from_millis(20));
    let url = base
        .join(&format!("/media/{}.mp4", "a".repeat(64)))
        .unwrap();
    let host = IdentityHost::fixture();
    let first = media_blocks::read(&host, None, &url, 0, 7, WHOLE_VIDEO_MAX)
        .await
        .unwrap();
    assert_eq!(first.body(), &blob[..8]);
    // A seek near the end waits for bytes; then the player closes.
    let seek = media_blocks::read(&host, None, &url, length - 8, length - 1, WHOLE_VIDEO_MAX);
    assert!(tokio::time::timeout(Duration::from_millis(500), seek)
        .await
        .is_err());
    spool_files_deleted().await;
    hung_up(&hangups, 1).await;
}

#[tokio::test]
async fn a_waiting_read_keeps_a_slow_download_alive() {
    let _serial = SPOOL_TESTS.lock().await;
    let blob = media_blob(8 * media_blocks::BLOCK);
    let length = blob.len() as u64;
    // About 2.6 s to copy, over twice the idle window.
    let (base, _, hangups) = whole_media_server(blob.clone(), None, Duration::from_millis(20));
    let url = base
        .join(&format!("/media/{}.mp4", "b".repeat(64)))
        .unwrap();
    let host = IdentityHost::fixture();
    let read = media_blocks::read(&host, None, &url, length - 4, length - 1, WHOLE_VIDEO_MAX).await;
    assert_eq!(read.unwrap().body(), &blob[length as usize - 4..]);
    assert_eq!(hangups.load(std::sync::atomic::Ordering::SeqCst), 0);
    spool_files_deleted().await;
}

#[tokio::test]
async fn invalid_partial_media_blocks_are_rejected_and_retried() {
    let block = media_blocks::BLOCK;
    let blob = media_blob(3000);
    let oversized = media_blob(2 * block);
    let partial = |range: &str, body: &[u8]| {
        let length = format!("Content-Length: {}\r\n", body.len());
        let range = if range.is_empty() {
            String::new()
        } else {
            format!("Content-Range: {range}\r\n")
        };
        media_response("206 Partial Content", &format!("{range}{length}"), body)
    };
    let cases = [
        (partial("", &blob), 502),
        (partial("bytes 0-x/3000", &blob), 502),
        (partial("bytes 8-15/3000", &blob[8..16]), 502),
        (partial("bytes 0-7/3000", &blob[..8]), 502),
        (
            partial(
                &format!("bytes 0-{}/{}", 2 * block - 1, 4 * block),
                &oversized,
            ),
            413,
        ),
        // No Content-Length: the 1 MiB cap applies while buffering.
        (
            media_response(
                "206 Partial Content",
                &format!("Content-Range: bytes 0-{}/{}\r\n", 2 * block - 1, 4 * block),
                &oversized,
            ),
            413,
        ),
    ];
    let expected: Vec<u16> = cases.iter().map(|(_, status)| *status).collect();
    let mut responses: Vec<Vec<u8>> = cases.into_iter().map(|(response, _)| response).collect();
    responses.push(partial("bytes 0-2999/3000", &blob));
    let (base, served) = scripted_media_server(responses);
    let url = base
        .join(&format!("/media/{}.mp4", "1".repeat(64)))
        .unwrap();
    let host = IdentityHost::fixture();
    for status in expected.iter() {
        assert_eq!(
            media_blocks::read(&host, None, &url, 0, 7, WHOLE_VIDEO_MAX)
                .await
                .unwrap_err(),
            *status
        );
    }
    let read = media_blocks::read(&host, None, &url, 0, 7, WHOLE_VIDEO_MAX)
        .await
        .unwrap();
    assert_eq!(read.status(), 206);
    assert_eq!(read.body(), &blob[..8]);
    assert_eq!(read.headers()["content-range"], "bytes 0-7/3000");
    // Rejections were never cached; the valid block now is.
    assert_eq!(
        media_blocks::read(&host, None, &url, 2992, 2999, WHOLE_VIDEO_MAX)
            .await
            .unwrap()
            .body(),
        &blob[2992..]
    );
    assert_eq!(
        served.load(std::sync::atomic::Ordering::SeqCst),
        expected.len() + 1
    );
}

#[tokio::test]
async fn media_proxy_passes_relay_denials_through_without_a_body() {
    let (base, task) = fixture_server(
        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into(),
    );
    let url = base.join(&format!("/media/{}", "b".repeat(64))).unwrap();
    assert_eq!(
        fetch_media(&IdentityHost::fixture(), None, url, None)
            .await
            .unwrap_err(),
        401
    );
    task.join().unwrap();
}

async fn upload(
    host: &IdentityHost,
    url: Url,
    kind: Option<&str>,
    bytes: Vec<u8>,
    progress: Option<UploadProgress>,
) -> Result<RelayResponse> {
    validate_upload_size(bytes.len())?;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source");
    std::fs::write(&path, bytes).unwrap();
    let hash = upload_spool::hash_file(&path)?;
    upload_file(host, None, url, kind, path, hash, progress).await
}

fn upload_descriptor(bytes: &[u8]) -> serde_json::Value {
    let hash = format!("{:x}", Sha256::digest(bytes));
    serde_json::json!({
        "url": format!("/media/{hash}"),
        "type": "application/octet-stream",
        "sha256": hash,
        "size": bytes.len(),
    })
}

fn upload_reply(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[tokio::test]
async fn upload_signs_the_exact_bytes_it_sends() {
    // ASCII: the fixture server compares lengths on decoded text.
    let body = b"PNG fixture bytes".to_vec();
    let hash = format!("{:x}", Sha256::digest(&body));
    let descriptor = upload_descriptor(&body).to_string();
    let (base, task) = fixture_server(upload_reply("201 Created", &descriptor));
    let url = base.join("/upload").unwrap();
    let result = upload(
        &IdentityHost::fixture(),
        url.clone(),
        Some("image/png"),
        body.clone(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        (result.status, result.body.as_str()),
        (201, descriptor.as_str())
    );
    let (headers, sent) = task.join().unwrap();
    assert_eq!(sent.as_bytes(), body);
    assert!(headers.starts_with("PUT /upload "));
    assert!(headers
        .lines()
        .any(|line| line == format!("x-sha-256: {hash}")));
    assert!(headers
        .lines()
        .any(|line| line == "content-type: image/png"));
    let event = blossom_event(&headers);
    let server = &url[url::Position::BeforeHost..url::Position::AfterPort];
    assert_strict(&event, "upload", server);
    assert_eq!(tag(&event, "x"), [hash.as_str()]);
    assert!(
        upload(&IdentityHost::fixture(), url, None, Vec::new(), None)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn upload_rejects_descriptors_for_different_bytes() {
    let body = b"abc";
    let descriptor = upload_descriptor(body);
    let mut wrong_size = descriptor.clone();
    wrong_size["size"] = serde_json::json!(4);
    let mut string_size = descriptor.clone();
    string_size["size"] = serde_json::json!("3");
    let mut missing_hash = descriptor.clone();
    missing_hash.as_object_mut().unwrap().remove("sha256");
    let mut missing_size = descriptor;
    missing_size.as_object_mut().unwrap().remove("size");
    for response in [
        upload_descriptor(b"xyz").to_string(),
        wrong_size.to_string(),
        string_size.to_string(),
        missing_hash.to_string(),
        missing_size.to_string(),
        "null".into(),
        "not JSON".into(),
    ] {
        let (base, task) = fixture_server(upload_reply("200 OK", &response));
        let result = upload(
            &IdentityHost::fixture(),
            base.join("/upload").unwrap(),
            None,
            body.to_vec(),
            None,
        )
        .await;
        assert_eq!(task.join().unwrap().1.as_bytes(), body);
        assert!(result.is_err(), "accepted upload response: {response}");
    }
}

#[tokio::test]
async fn upload_preserves_relay_failure_responses() {
    for (status, code) in [("401 Unauthorized", 401), ("413 Content Too Large", 413)] {
        let body = r#"{"code":"denied"}"#;
        let (base, task) = fixture_server(upload_reply(status, body));
        let result = upload(
            &IdentityHost::fixture(),
            base.join("/upload").unwrap(),
            None,
            b"abc".to_vec(),
            None,
        )
        .await
        .unwrap();
        task.join().unwrap();
        assert_eq!((result.status, result.body.as_str()), (code, body));
        assert_eq!(result.headers["content-type"], "application/json");
    }
}

#[tokio::test]
async fn upload_reports_bytes_handed_to_the_connection() {
    // Four 64 KiB chunks, ASCII for the fixture server's text comparison.
    let body = vec![b'a'; 3 * UPLOAD_CHUNK + 1];
    let (base, task) = fixture_server(upload_reply(
        "200 OK",
        &upload_descriptor(&body).to_string(),
    ));
    let reports = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = reports.clone();
    let channel = tauri::ipc::Channel::new(move |message| {
        let tauri::ipc::InvokeResponseBody::Json(json) = message else {
            panic!("progress must be JSON");
        };
        sink.lock()
            .unwrap()
            .push(serde_json::from_str::<serde_json::Value>(&json).unwrap());
        Ok(())
    });
    let result = upload(
        &IdentityHost::fixture(),
        base.join("/upload").unwrap(),
        Some("image/png"),
        body.clone(),
        Some(channel),
    )
    .await
    .unwrap();
    assert_eq!(result.status, 200);
    let (headers, sent) = task.join().unwrap();
    assert_eq!(sent.as_bytes(), body);
    assert!(headers
        .lines()
        .any(|line| line == format!("content-length: {}", body.len())));
    let total = body.len();
    assert_eq!(
        *reports.lock().unwrap(),
        [UPLOAD_CHUNK, 2 * UPLOAD_CHUNK, 3 * UPLOAD_CHUNK, total]
            .map(|sent| serde_json::json!({ "sent": sent, "total": total }))
    );
}

#[tokio::test]
async fn single_chunk_upload_reports_its_whole_body() {
    let reports = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = reports.clone();
    use futures_util::StreamExt;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source");
    std::fs::write(&path, vec![0; 5263]).unwrap();
    let file = std::fs::File::open(path).unwrap();
    let chunks = file_chunks(file, 5263, move |sent| sink.lock().unwrap().push(sent));
    assert_eq!(chunks.collect::<Vec<_>>().await.len(), 1);
    assert_eq!(
        *reports.lock().unwrap(),
        [UploadSent {
            sent: 5263,
            total: 5263
        }]
    );
}

#[tokio::test]
async fn progress_reports_change_by_whole_percent_only() {
    let reports = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = reports.clone();
    use futures_util::StreamExt;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source");
    let file = std::fs::File::create(&path).unwrap();
    file.set_len((1000 * UPLOAD_CHUNK) as u64).unwrap();
    drop(file);
    let file = std::fs::File::open(path).unwrap();
    let chunks = file_chunks(file, (1000 * UPLOAD_CHUNK) as u64, move |sent| {
        sink.lock().unwrap().push(sent.sent)
    });
    assert_eq!(chunks.collect::<Vec<_>>().await.len(), 1000);
    let reports = reports.lock().unwrap();
    // Percent 0 (first nine chunks) through 100, once each.
    assert_eq!(reports.len(), 101);
    assert!(reports.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(reports.last(), Some(&(1000 * UPLOAD_CHUNK as u64)));
}

#[test]
fn uploads_cancel_before_or_during_and_reject_duplicates() {
    let uploads = Uploads::default();
    let mut running = uploads.start("a").unwrap().unwrap();
    assert!(uploads.start("a").is_err());
    uploads.cancel("a");
    assert!(running.try_recv().is_ok());
    uploads.finish("a");
    // A cancel that overtakes its upload stops it from starting, once.
    uploads.cancel("b");
    assert!(uploads.start("b").unwrap().is_none());
    assert!(uploads.start("b").unwrap().is_some());
    for id in ["", "a/b", &"x".repeat(65)] {
        assert!(upload_id(Some(id)).is_err(), "{id}");
    }
    assert!(upload_id(None).is_err());
}

#[test]
fn late_cancels_cannot_exhaust_upload_admission() {
    let uploads = Uploads::default();
    for n in 0..128 {
        let id = n.to_string();
        let _running = uploads.start(&id).unwrap().unwrap();
        uploads.finish(&id);
        uploads.cancel(&id); // Renderer received completion after native finished.
    }
    assert!(uploads.start("fresh").unwrap().is_some());
    assert_eq!(uploads.lock().pending.len(), 64);
    // Early rejection before `start` has the same late-cancel path.
    uploads.cancel("rejected-before-start");
    assert!(uploads.start("another").unwrap().is_some());
    // Even when active admission is full, a pre-cancelled ID never starts.
    let mut held = Vec::new();
    for n in 0..62 {
        held.push(uploads.start(&format!("active-{n}")).unwrap().unwrap());
    }
    uploads.cancel("queued");
    assert!(uploads.start("queued").unwrap().is_none());
    assert!(uploads.start("overflow").is_err());
    uploads.finish("active-0");
    assert!(uploads.start("overflow").unwrap().is_some());
    uploads.finish("active-1");
    let mut active = uploads.start("active").unwrap().unwrap();
    uploads.cancel("active");
    assert!(active.try_recv().is_ok());
}

#[tokio::test]
async fn read_state_codec_round_trips_and_rejects_foreign_intent() {
    let host = IdentityHost::fixture();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let blob = serde_json::json!({"v":1,"client_id":"fixture","contexts":{"channel":now}});
    let signed = host
        .sign_read_state("a".repeat(32), now, blob.clone())
        .await
        .unwrap();
    verify(&signed);
    let decoded = host.decode_read_state(vec![signed.clone()]).await.unwrap();
    assert_eq!(decoded[0]["eventId"], signed["id"]);
    assert_eq!(decoded[0]["blob"], blob);
    assert!(host
        .sign_read_state("x".repeat(32), now, blob.clone())
        .await
        .is_err());
    assert!(host
        .sign_read_state("a".repeat(32), now - 120, blob)
        .await
        .is_err());
    let mut tampered = signed.clone();
    tampered["tags"] = serde_json::json!([["d", "channel-sort"], ["t", "read-state"]]);
    assert!(host.decode_read_state(vec![tampered]).await.is_err());
    let mut duplicate = signed.clone();
    duplicate["tags"] = serde_json::json!([
        ["d", "read-state:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
        ["d", "channel-sort"],
        ["t", "read-state"]
    ]);
    assert!(host.decode_read_state(vec![duplicate]).await.is_err());
    assert!(host.decode_read_state(vec![signed; 17]).await.is_err());
}

#[test]
fn general_signing_never_accepts_read_state_kind() {
    let event = EventTemplate {
        kind: 30078,
        created_at: 0,
        tags: vec![],
        content: String::new(),
    };
    assert!(validate_event("https://relay.test", &event).is_err());
}

#[tokio::test]
#[ignore = "local performance measurement; run with --ignored --nocapture"]
async fn measure_preference_batch_decode() {
    let host = IdentityHost::fixture();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let blob = serde_json::json!({"v":1,"client_id":"fixture","contexts":{"channel":now}});
    let event = host
        .sign_read_state("a".repeat(32), now, blob)
        .await
        .unwrap();
    let events = vec![event; 16];
    host.decode_read_state(events.clone()).await.unwrap();
    let started = Instant::now();
    for _ in 0..100 {
        std::hint::black_box(host.decode_read_state(events.clone()).await.unwrap());
    }
    eprintln!(
        "read-state batch: 16 slots, 100 iterations: {:?}",
        started.elapsed()
    );
}

#[test]
fn upload_hash_reads_exact_bytes_from_disk() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source");
    std::fs::write(&path, b"upload bytes").unwrap();
    let (size, hash) = upload_spool::hash_file(&path).unwrap();
    assert_eq!(size, 12);
    assert_eq!(hash, format!("{:x}", Sha256::digest(b"upload bytes")));
    std::fs::write(&path, []).unwrap();
    assert!(upload_spool::hash_file(&path).is_err());
    assert!(validate_upload_size(0).is_err());
    assert!(validate_upload_size(MAX_UPLOAD + 1).is_err());
    assert!(validate_upload_size(MAX_UPLOAD).is_ok());
}

#[tokio::test]
async fn preference_batches_reject_invalid_ciphertext_after_signature_verification() {
    let host = IdentityHost::fixture();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let sidebar = host
        .sign_sidebar(
            "channel-stars".into(),
            serde_json::json!({"version":1,"channels":{}}),
            now,
        )
        .await
        .unwrap();
    let read = host
        .sign_read_state(
            "a".repeat(32),
            now,
            serde_json::json!({"v":1,"client_id":"fixture","contexts":{"channel":now}}),
        )
        .await
        .unwrap();
    for (event, sidebar_record) in [(sidebar, true), (read, false)] {
        let payload = STANDARD.decode(event["content"].as_str().unwrap()).unwrap();
        let mut version = payload.clone();
        version[0] = 3;
        let mut mac = payload;
        *mac.last_mut().unwrap() ^= 1;
        for content in [
            STANDARD.encode(version),
            STANDARD.encode(mac),
            "invalid base64".into(),
        ] {
            let invalid = host
                .sign(EventTemplate {
                    created_at: now,
                    kind: 30078,
                    tags: serde_json::from_value(event["tags"].clone()).unwrap(),
                    content,
                })
                .await
                .unwrap();
            verify(&invalid);
            let result = if sidebar_record {
                host.decode_sidebar(vec![invalid]).await
            } else {
                host.decode_read_state(vec![invalid]).await
            };
            assert!(result.is_err());
        }
    }
}

#[test]
fn canvas_signing_shape_matches_shared_contract() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../src/features/channel-templates/canvas-signing-contract.json"
    ))
    .unwrap();
    let cases = cases.as_array().unwrap();
    assert!(!cases.is_empty(), "shared Canvas signing corpus is empty");
    for case in cases {
        // Tag shape plus EventTemplate deserialization, not IPC wiring, broker
        // freshness, the native signing budget or publication.
        let event = serde_json::from_value::<EventTemplate>(serde_json::json!({
            "kind": 40100, "created_at": 100, "content": "# Plan", "tags": case["tags"]
        }));
        let accepted = if case["deserializes"] == false {
            assert!(event.is_err(), "{}", case["name"]);
            false
        } else {
            let event = event.unwrap_or_else(|error| panic!("{}: {error}", case["name"]));
            validate_event("https://relay.test", &event).is_ok()
        };
        assert_eq!(
            accepted,
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn canvas_content_is_bounded_in_utf8_bytes() {
    let mut event = EventTemplate {
        kind: 40100,
        created_at: 100,
        content: "é".repeat(LIVE_CANVAS_BYTES / 2),
        tags: vec![vec![
            "h".into(),
            "11111111-1111-4111-8111-111111111111".into(),
        ]],
    };
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.content.push('x');
    assert!(validate_event("https://relay.test", &event).is_err());
}

#[test]
fn canvas_limits_mirror_the_shared_policy() {
    let policy = include_str!("../../../src/features/channel-templates/canvas-limits.ts");
    assert_eq!(LIVE_CANVAS_BYTES, 256 * 1024);
    assert!(policy.contains("export const LIVE_CANVAS_BYTES = 256 * 1024;"));
    assert_eq!(CANVAS_MAX_EVENT_BYTES, 512 * 1024 - 16);
    assert!(policy.contains("export const CANVAS_FRAME_BYTES = 512 * 1024;"));
    assert!(policy.contains("export const CANVAS_MAX_EVENT_BYTES = CANVAS_FRAME_BYTES - 16;"));
    let model = include_str!("../../../src/features/channel-templates/model.ts");
    assert!(model.contains("export const TEMPLATE_CANVAS_BYTES = 24 * 1024;"));
    // The agent signer keeps its own copy.
    assert_eq!(buzz_agent_controller::LIVE_CANVAS_BYTES, LIVE_CANVAS_BYTES);
    assert_eq!(
        buzz_agent_controller::CANVAS_MAX_EVENT_BYTES,
        CANVAS_MAX_EVENT_BYTES
    );
}

#[tokio::test]
async fn canvas_signing_through_ipc_bounds_content_and_the_complete_event() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let sign = |content: String| {
        let event = EventTemplate {
            kind: 40100,
            created_at: 1_700_000_000,
            content,
            tags: vec![vec![
                "h".into(),
                "11111111-1111-4111-8111-111111111111".into(),
            ]],
        };
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: "relay_sign".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                    "community": "https://relay.test", "event": event
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize::<serde_json::Value>().unwrap())
    };
    let size = |event: &serde_json::Value| serde_json::to_vec(event).unwrap().len();
    let largest = sign("x".repeat(LIVE_CANVAS_BYTES)).unwrap();
    assert_eq!(
        largest["content"].as_str().unwrap().len(),
        LIVE_CANVAS_BYTES
    );
    assert!(sign("x".repeat(LIVE_CANVAS_BYTES + 1)).is_err());

    // Quotes escape to two bytes, so in-limit content can make a complete
    // event exactly at, then one byte over, the relay's bound.
    let overhead = size(&sign(String::new()).unwrap());
    let quotes = CANVAS_MAX_EVENT_BYTES - overhead - LIVE_CANVAS_BYTES;
    let escaped = |extra: usize| {
        format!(
            "{}{}",
            "\"".repeat(quotes + extra),
            "x".repeat(LIVE_CANVAS_BYTES - quotes - extra)
        )
    };
    let boundary = sign(escaped(0)).unwrap();
    assert_eq!(size(&boundary), CANVAS_MAX_EVENT_BYTES);
    assert_eq!(
        sign(escaped(1)).unwrap_err(),
        serde_json::json!("Relay event is too large")
    );
}

#[test]
fn member_commands_sign_through_production_ipc() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .manage(FederatedIdentity::new().unwrap())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let sign = |event: &serde_json::Value| {
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: "relay_sign".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                    "community": "https://relay.test", "event": event
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize::<serde_json::Value>().unwrap())
    };
    let target = "a".repeat(64);
    let command = |kind: u16, tags: serde_json::Value| serde_json::json!({ "kind": kind, "created_at": 1, "content": "", "tags": tags });
    for event in [
        command(9030, serde_json::json!([["p", target], ["role", "member"]])),
        command(9030, serde_json::json!([["p", target], ["role", "admin"]])),
        command(9031, serde_json::json!([["p", target]])),
        command(9032, serde_json::json!([["p", target], ["role", "admin"]])),
        command(9032, serde_json::json!([["p", target], ["role", "member"]])),
    ] {
        let signed = sign(&event).unwrap();
        assert_eq!(
            signed["pubkey"],
            "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"
        );
        for field in ["kind", "created_at", "content", "tags"] {
            assert_eq!(signed[field], event[field]);
        }
        verify(&signed);
    }
    // An owner grant is refused by the host before any key use.
    for event in [
        command(9030, serde_json::json!([["p", target], ["role", "owner"]])),
        command(9032, serde_json::json!([["p", target], ["role", "owner"]])),
    ] {
        assert!(sign(&event).is_err(), "signed {event}");
    }
}

#[tokio::test]
async fn git_authorization_covers_only_this_communitys_repositories() {
    let owner = "a".repeat(64);
    let host = IdentityHost::fixture();
    let repository = format!("https://relay.test/git/{owner}/plugins");
    let token = git_authorization(
        &host,
        &git_repository("https://relay.test", &repository).unwrap(),
    )
    .await
    .unwrap();
    let auth: serde_json::Value = serde_json::from_slice(&STANDARD.decode(token).unwrap()).unwrap();
    verify(&auth);
    assert_eq!(auth["pubkey"], host.viewer().await.unwrap());
    assert_eq!(auth["kind"], 27235);
    assert_eq!(
        auth["tags"],
        serde_json::json!([["u", repository], ["method", "GET"]])
    );
    for repository in [
        format!("https://relay.test/git/{owner}/plugins"),
        format!("https://relay.test/git/{owner}/plugins.git"),
        format!("https://relay.test/git/{owner}/plugins."),
        format!("https://relay.test/git/{owner}/plugins..git"),
        format!("https://relay.test/git/{owner}/{}", "n".repeat(64)),
        format!("https://relay.test/git/{owner}/{}.git", "n".repeat(64)),
    ] {
        assert_eq!(
            git_repository("https://relay.test/", &repository)
                .unwrap()
                .as_str(),
            repository
        );
    }
    for repository in [
        format!("https://other.test/git/{owner}/plugins"),
        format!("http://relay.test/git/{owner}/plugins"),
        format!("https://relay.test:444/git/{owner}/plugins"),
        format!("https://me@relay.test/git/{owner}/plugins"),
        format!("https://relay.test/git/{owner}/plugins/"),
        format!("https://relay.test/git/{owner}/plugins?service=git-receive-pack"),
        format!("https://relay.test/git/{owner}/plugins#x"),
        format!("https://relay.test/git/{owner}/.hidden"),
        format!("https://relay.test/git/{owner}/a..b"),
        format!("https://relay.test/git/{owner}/a..b.git"),
        format!("https://relay.test/git/{owner}/.git"),
        format!("https://relay.test/git/{owner}/..git"),
        format!("https://relay.test/git/{owner}/{}", "n".repeat(65)),
        format!("https://relay.test/git/{owner}/{}.git", "n".repeat(65)),
        format!("https://relay.test/git/{}/plugins", "A".repeat(64)),
        format!("https://relay.test/api/{owner}/plugins"),
        format!("https://relay.test/git/{owner}/plugins/info/refs"),
        format!("https://RELAY.test/git/{owner}/plugins"),
        "https://relay.test/query".into(),
    ] {
        assert!(
            git_repository("https://relay.test/", &repository).is_err(),
            "{repository}"
        );
    }
}

#[tokio::test]
async fn spool_processing_cleans_after_upstream_and_conversion_failures() {
    for preparation in [None, Some("video:avi")] {
        let parent = tempfile::tempdir().unwrap();
        let spools = Spools::new(Ok(parent.path().to_owned()));
        let uploads = Uploads::default();
        spools.begin(&uploads, "failure", 3).unwrap();
        spools.append("failure", 0, b"bad").unwrap();
        let (spool, mut cancel) = spools.take("failure").unwrap();
        let path = spool.directory.path().to_owned();
        // Closed loopback port for upstream failure; invalid AVI for conversion.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("http://{}/upload", listener.local_addr().unwrap())).unwrap();
        drop(listener);
        let result = process_spool(
            &IdentityHost::fixture(),
            None,
            url,
            spool,
            (None, preparation),
            None,
            &mut cancel,
        )
        .await;
        if preparation.is_some() {
            assert!(result.unwrap().status >= 400);
        } else {
            assert!(result.is_err());
        }
        assert!(!path.exists());
        assert!(spools.begin(&uploads, "next", 3).is_ok());
    }
}

#[tokio::test]
async fn cancelled_spool_processing_never_starts_upstream_and_cleans() {
    let parent = tempfile::tempdir().unwrap();
    let spools = Spools::new(Ok(parent.path().to_owned()));
    let uploads = Uploads::default();
    spools.begin(&uploads, "cancel", 3).unwrap();
    spools.append("cancel", 0, b"abc").unwrap();
    let (spool, mut cancel) = spools.take("cancel").unwrap();
    let path = spool.directory.path().to_owned();
    uploads.cancel("cancel");
    assert!(process_spool(
        &IdentityHost::fixture(),
        None,
        Url::parse("https://relay.test/upload").unwrap(),
        spool,
        (None, None),
        None,
        &mut cancel
    )
    .await
    .is_err());
    assert!(!path.exists());
}

#[tokio::test]
async fn converted_spool_streams_signed_output_then_removes_both_files() {
    let program =
        crate::host_command::resolve_program("ffmpeg", &crate::host_command::effective_path());
    if !program.exists() {
        eprintln!("ffmpeg unavailable: converted-spool integration not executed");
        return;
    }
    let parent = tempfile::tempdir().unwrap();
    let input = parent.path().join("input.avi");
    assert!(std::process::Command::new(program)
        .args([
            "-y",
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=16x16:r=1",
            "-t",
            "1",
            "-c:v",
            "mpeg4"
        ])
        .arg(&input)
        .status()
        .unwrap()
        .success());
    let bytes = std::fs::read(&input).unwrap();
    let spools = Spools::new(Ok(parent.path().join("spools")));
    let uploads = Uploads::default();
    spools.begin(&uploads, "converted", bytes.len()).unwrap();
    for (index, chunk) in bytes.chunks(UPLOAD_CHUNK).enumerate() {
        spools
            .append("converted", index * UPLOAD_CHUNK, chunk)
            .unwrap();
    }
    let (spool, mut cancel) = spools.take("converted").unwrap();
    let path = spool.directory.path().to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Url::parse(&format!("http://{}/upload", listener.local_addr().unwrap())).unwrap();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut block = [0; 4096];
        loop {
            let read = socket.read(&mut block).unwrap();
            assert!(read > 0);
            bytes.extend_from_slice(&block[..read]);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let header = String::from_utf8(bytes[..end].to_vec()).unwrap();
                let size: usize = header
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .unwrap()
                    .parse()
                    .unwrap();
                if bytes.len() == end + 4 + size {
                    let descriptor = upload_descriptor(&bytes[end + 4..]).to_string();
                    socket
                        .write_all(upload_reply("200 OK", &descriptor).as_bytes())
                        .unwrap();
                    return (header, bytes[end + 4..].to_vec());
                }
            }
        }
    });
    let response = process_spool(
        &IdentityHost::fixture(),
        None,
        url,
        spool,
        (None, Some("video:avi")),
        None,
        &mut cancel,
    )
    .await
    .unwrap();
    assert_eq!(response.status, 200);
    let (header, body) = server.join().unwrap();
    assert!(body.windows(4).any(|part| part == b"ftyp"));
    assert_ne!(body, bytes);
    assert!(header.lines().any(|line| line == "content-type: video/mp4"));
    let hash = format!("{:x}", Sha256::digest(&body));
    assert_eq!(tag(&blossom_event(&header), "x"), [hash.as_str()]);
    assert_eq!(response.body, upload_descriptor(&body).to_string());
    assert!(!path.exists());
}

#[tokio::test]
async fn running_upstream_cancellation_closes_request_and_cleans_spool() {
    let parent = tempfile::tempdir().unwrap();
    let spools = Spools::new(Ok(parent.path().to_owned()));
    let uploads = Uploads::default();
    spools.begin(&uploads, "running", 3).unwrap();
    spools.append("running", 0, b"abc").unwrap();
    let (spool, mut cancel) = spools.take("running").unwrap();
    let path = spool.directory.path().to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Url::parse(&format!("http://{}/upload", listener.local_addr().unwrap())).unwrap();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut block = [0; 4096];
        loop {
            let read = socket.read(&mut block).unwrap();
            assert!(read > 0);
            bytes.extend_from_slice(&block[..read]);
            if bytes.ends_with(b"abc") {
                break;
            }
        }
        entered.send(()).unwrap();
        // Stall the response, not the scheduler: cancellation must close it.
        socket.read(&mut block).unwrap()
    });
    let host = IdentityHost::fixture();
    let work = process_spool(&host, None, url, spool, (None, None), None, &mut cancel);
    tokio::pin!(work);
    tokio::select! {
        _ = ready => uploads.cancel("running"),
        _ = &mut work => panic!("upload settled before fixture gate"),
    }
    assert_eq!(work.await.err().unwrap(), "Upload cancelled");
    assert_eq!(
        tokio::task::spawn_blocking(move || server.join().unwrap())
            .await
            .unwrap(),
        0
    );
    assert!(!path.exists());
}

#[test]
fn upload_ingress_commands_validate_raw_chunks_and_finalize_owned_bytes() {
    use tauri::{
        test::{get_ipc_response, mock_builder, INVOKE_KEY},
        Manager as _,
    };
    let parent = tempfile::tempdir().unwrap();
    let app = mock_builder()
        .manage(Uploads::default())
        .manage(Spools::new(Ok(parent.path().to_owned())))
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let invoke = |command: &str, body, id: Option<&str>, offset: Option<&str>| {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(id) = id {
            headers.insert("x-buzz-upload-id", id.parse().unwrap());
        }
        if let Some(offset) = offset {
            headers.insert("x-buzz-upload-offset", offset.parse().unwrap());
        }
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body,
                headers,
                invoke_key: INVOKE_KEY.into(),
            },
        )
    };
    for (id, offset, body) in [
        (
            "missing-offset",
            None,
            tauri::ipc::InvokeBody::Raw(b"abc".to_vec()),
        ),
        (
            "invalid-offset",
            Some("bad"),
            tauri::ipc::InvokeBody::Raw(b"abc".to_vec()),
        ),
        (
            "json",
            Some("0"),
            tauri::ipc::InvokeBody::Json(serde_json::json!([1, 2, 3])),
        ),
        (
            "large",
            Some("0"),
            tauri::ipc::InvokeBody::Raw(vec![0; UPLOAD_CHUNK + 1]),
        ),
        ("empty", Some("0"), tauri::ipc::InvokeBody::Raw(Vec::new())),
    ] {
        invoke(
            "relay_upload_begin",
            tauri::ipc::InvokeBody::Json(serde_json::json!({"id": id, "size": 3})),
            None,
            None,
        )
        .unwrap();
        assert!(invoke("relay_upload_chunk", body, Some(id), offset).is_err());
        assert!(app.state::<Spools>().take(id).is_err());
        assert!(app.state::<Uploads>().lock().active.is_empty());
    }
    assert!(invoke(
        "relay_upload_chunk",
        tauri::ipc::InvokeBody::Raw(vec![1]),
        None,
        Some("0")
    )
    .is_err());
    invoke(
        "relay_upload_begin",
        tauri::ipc::InvokeBody::Json(serde_json::json!({"id": "valid", "size": 3})),
        None,
        None,
    )
    .unwrap();
    invoke(
        "relay_upload_chunk",
        tauri::ipc::InvokeBody::Raw(b"a".to_vec()),
        Some("valid"),
        Some("0"),
    )
    .unwrap();
    invoke(
        "relay_upload_chunk",
        tauri::ipc::InvokeBody::Raw(b"bc".to_vec()),
        Some("valid"),
        Some("1"),
    )
    .unwrap();
    let (spool, _) = app.state::<Spools>().take("valid").unwrap();
    assert_eq!(std::fs::read(spool.source()).unwrap(), b"abc");
    assert_eq!(spool.hash, format!("{:x}", Sha256::digest(b"abc")));
    app.state::<Uploads>().finish("valid");
}

#[tokio::test]
async fn snapshot_media_read_preserves_auth_and_enforces_the_tighter_file_cap() {
    for (body, limit, expected) in [("safe", 4, Ok(())), ("large", 4, Err(413u16))] {
        let (base, task) = fixture_server(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
        ));
        let url = base.join(&format!("/media/{}", "a".repeat(64))).unwrap();
        let response =
            fetch_media_bounded(&IdentityHost::fixture(), None, url.clone(), None, limit).await;
        assert_eq!(
            response.as_ref().map(|_| ()).map_err(|status| *status),
            expected
        );
        if let Ok(response) = response {
            assert_eq!(response.body(), body.as_bytes());
        }
        let (headers, _) = task.join().unwrap();
        let server = &url[url::Position::BeforeHost..url::Position::AfterPort];
        assert_strict(&blossom_event(&headers), "get", server);
    }
}

#[tokio::test]
async fn artifact_signing_through_ipc_admits_a_maximum_config_event_and_bounds_the_full_event() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let sign = |event: &EventTemplate| {
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: "relay_sign".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                    "community": "https://relay.test", "event": event
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize::<serde_json::Value>().unwrap())
    };
    // A valid maximum instructions snapshot (131,072 content bytes) whose
    // text is all quotes, so every content byte escapes again when signed.
    let shell = r#"{"version":1,"text":""}"#;
    let room = 131_072 - shell.len();
    let text = format!("{}{}", "\"".repeat(room / 2), "a".repeat(room % 2));
    let content = serde_json::json!({ "version": 1, "text": text }).to_string();
    assert_eq!(content.len(), 131_072);
    // The NIP-AP envelope plus fifteen preserved, fully escaping 4 KiB tags.
    let mut tags: Vec<Vec<String>> = vec![
        vec!["ar".into(), "1".into()],
        vec!["d".into(), "6ba7b811-9dad-11d1-80b4-00c04fd430c8".into()],
        vec!["h".into(), "6ba7b811-9dad-11d1-80b4-00c04fd430c8".into()],
        vec!["type".into(), "buzz.agent.instructions".into()],
        vec!["title".into(), "x".repeat(512)],
        vec!["op".into(), "update".into()],
        vec!["prev".into(), "f".repeat(64)],
        vec!["team".into(), "t".repeat(64)],
    ];
    tags.extend((0..15).map(|_| vec!["x".into(), "\"".repeat(4096)]));
    let event = |kind, tags: &Vec<Vec<String>>| EventTemplate {
        created_at: 9_007_199_254_740_991,
        kind,
        tags: tags.clone(),
        content: content.clone(),
    };
    let largest = event(45010, &tags);
    let signed = sign(&largest).unwrap();
    verify(&signed);
    assert_eq!(signed["content"], largest.content);
    let size = serde_json::to_vec(&signed).unwrap().len();
    assert!(size > 300 * 1024, "maximum config event is {size}");
    assert!(
        size <= ARTIFACT_MAX_EVENT_BYTES,
        "{size} > {ARTIFACT_MAX_EVENT_BYTES}"
    );
    // The same event under an ordinary kind is refused by the same command.
    assert!(sign(&event(9, &tags)).is_err());

    // Pad a tag until the signed commitment sits just under the limit: the
    // commitment check admits it, but the complete event (id, pubkey key,
    // sig) is over the relay's limit and must be refused.
    let pubkey = signed["pubkey"].as_str().unwrap();
    let commitment = |tags: &Vec<Vec<String>>| {
        let e = event(45010, tags);
        serde_json::to_vec(&serde_json::json!([
            0,
            pubkey,
            e.created_at,
            e.kind,
            e.tags,
            e.content
        ]))
        .unwrap()
        .len()
    };
    let room = ARTIFACT_MAX_EVENT_BYTES - 8 - commitment(&tags) - r#",["x",""]"#.len();
    tags.push(vec!["x".into(), "y".repeat(room)]);
    assert_eq!(commitment(&tags), ARTIFACT_MAX_EVENT_BYTES - 8);
    assert_eq!(
        sign(&event(45010, &tags)).unwrap_err(),
        serde_json::json!("Relay event is too large")
    );
}

#[test]
fn media_cors_allows_only_the_window_origin() {
    for (page, origin) in [
        ("tauri://localhost/index.html", Some("tauri://localhost")),
        ("http://tauri.localhost/", Some("http://tauri.localhost")),
        (
            "http://localhost:41884/#/channel",
            Some("http://localhost:41884"),
        ),
        ("data:text/html,hi", None),
    ] {
        let url = Url::parse(page).unwrap();
        assert_eq!(
            window_origin(&url)
                .as_ref()
                .map(|value| value.to_str().unwrap()),
            origin,
            "{page}"
        );
    }
}

/// Each native HTTP transport sends exactly the issued assertion to a
/// community that requires NIP-FI, discovered through its real `/info`,
/// and nothing to one that does not.
mod federated_header {
    use super::*;
    use crate::federated_identity::testing::{community, reply};

    async fn http(required: bool) {
        let community = community(required).await;
        let server = community.serve(vec![reply("200 OK", "[]")]);
        let response = send(
            &community.host,
            Some(&community.fi),
            community.origin.join("/query").unwrap(),
            "POST",
            Some("[]".into()),
            true,
            1024,
        )
        .await
        .unwrap();
        assert_eq!(response.status, 200);
        let head = &server.heads().await[0];
        assert!(
            head.lines()
                .any(|line| line.eq_ignore_ascii_case("user-agent: Buzz")),
            "{head}"
        );
        community.assert_carried(head);
    }
    #[tokio::test]
    async fn http_attaches_for_required_discovery() {
        http(true).await;
    }
    #[tokio::test]
    async fn http_omits_for_ordinary_discovery() {
        http(false).await;
    }

    async fn uploads(required: bool) {
        let community = community(required).await;
        let bytes = b"PNG fixture bytes";
        let server = community.serve(vec![reply("200 OK", &upload_descriptor(bytes).to_string())]);
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source");
        std::fs::write(&path, bytes).unwrap();
        let hash = upload_spool::hash_file(&path).unwrap();
        let response = upload_file(
            &community.host,
            Some(&community.fi),
            community.origin.join("/upload").unwrap(),
            Some("image/png"),
            path,
            hash,
            None,
        )
        .await
        .unwrap();
        assert_eq!(response.status, 200);
        community.assert_carried(&server.heads().await[0]);
    }
    #[tokio::test]
    async fn upload_attaches_for_required_discovery() {
        uploads(true).await;
    }
    #[tokio::test]
    async fn upload_omits_for_ordinary_discovery() {
        uploads(false).await;
    }

    /// Signed out, a send and an upload to an advertising relay go without a
    /// token; an enforcing relay's missing-evidence 401 becomes the sign-in
    /// reason, and a 403 stays an ordinary response.
    #[tokio::test]
    async fn http_without_session_turns_missing_evidence_refusal_into_sign_in() {
        let community = community(true).await;
        community.fi.sign_out_for_test();
        let server = community.serve(vec![
            reply("401 Unauthorized", "authentication required\n"),
            reply("401 Unauthorized", "authentication required\n"),
            reply("403 Forbidden", "{}"),
        ]);
        let refused = send(
            &community.host,
            Some(&community.fi),
            community.origin.join("/query").unwrap(),
            "POST",
            Some("[]".into()),
            true,
            1024,
        )
        .await;
        assert_eq!(
            refused.err().as_deref(),
            Some("Federated sign-in is required")
        );
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source");
        std::fs::write(&path, b"PNG fixture bytes").unwrap();
        let hash = upload_spool::hash_file(&path).unwrap();
        let uploaded = upload_file(
            &community.host,
            Some(&community.fi),
            community.origin.join("/upload").unwrap(),
            Some("image/png"),
            path,
            hash,
            None,
        )
        .await;
        assert_eq!(
            uploaded.err().as_deref(),
            Some("Federated sign-in is required")
        );
        let forbidden = send(
            &community.host,
            Some(&community.fi),
            community.origin.join("/query").unwrap(),
            "POST",
            Some("[]".into()),
            true,
            1024,
        )
        .await
        .unwrap();
        assert_eq!(forbidden.status, 403);
        for head in server.heads().await {
            community.assert_uncarried(&head);
        }
    }

    fn media_reply() -> String {
        "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 4\r\nConnection: close\r\n\r\nPNG!".into()
    }
    fn media_url(community: &crate::federated_identity::testing::Community) -> Url {
        community
            .origin
            .join(&format!("/media/{}.png", "a".repeat(64)))
            .unwrap()
    }
    async fn download(required: bool) {
        let community = community(required).await;
        let server = community.serve(vec![media_reply()]);
        let response = fetch_media(
            &community.host,
            Some(&community.fi),
            media_url(&community),
            None,
        )
        .await
        .unwrap();
        assert_eq!(response.status(), 200);
        community.assert_carried(&server.heads().await[0]);
    }
    #[tokio::test]
    async fn media_download_attaches_for_required_discovery() {
        download(true).await;
    }
    #[tokio::test]
    async fn media_download_omits_for_ordinary_discovery() {
        download(false).await;
    }

    async fn stream_block(required: bool) {
        let community = community(required).await;
        let server = community.serve(vec![media_reply()]);
        let _ = media_blocks::read(
            &community.host,
            Some(&community.fi),
            &media_url(&community),
            0,
            3,
            MAX_MEDIA as u64,
        )
        .await;
        community.assert_carried(&server.heads().await[0]);
    }
    #[tokio::test]
    async fn media_stream_attaches_for_required_discovery() {
        stream_block(true).await;
    }
    #[tokio::test]
    async fn media_stream_omits_for_ordinary_discovery() {
        stream_block(false).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelled_native_reads_close_their_connection_and_writes_refuse_an_id() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Url::parse(&format!("http://{}/query", listener.local_addr().unwrap())).unwrap();
    let (connections, accepted) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            if connections.send(stream).is_err() {
                break;
            }
        }
    });
    let id = "22222222-2222-4222-8222-222222222222";
    let read = tokio::spawn(async move {
        let host = IdentityHost::fixture();
        let request = send(
            &host,
            None,
            url,
            "POST",
            Some("[]".into()),
            true,
            MAX_RESPONSE,
        );
        cancellable(Some(id), "POST", "/query", request).await
    });
    let mut stream = accepted.recv_timeout(Duration::from_secs(5)).unwrap();
    relay_http_cancel(id.into()).unwrap();
    assert_eq!(read.await.unwrap().unwrap().status, CANCELLED_READ);
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut buffer = [0; 4096];
    let closed = loop {
        match stream.read(&mut buffer) {
            Ok(0) => break true,
            Ok(_) => continue,
            Err(error) => break error.kind() == std::io::ErrorKind::ConnectionReset,
        }
    };
    assert!(closed, "a cancelled read kept its relay connection open");

    // A cancel that overtakes its read IPC still wins.
    let early = "33333333-3333-4333-8333-333333333333";
    relay_http_cancel(early.into()).unwrap();
    let response = cancellable(Some(early), "POST", "/profiles/search", async {
        unreachable!("an already cancelled read must not be sent")
    })
    .await
    .unwrap();
    assert_eq!(response.status, CANCELLED_READ);

    // A dispatched write may already have reached the relay.
    let Err(error) = cancellable(Some(id), "POST", "/events", async {
        unreachable!("a write with a cancel id must not be sent")
    })
    .await
    else {
        panic!("a write accepted a cancel id");
    };
    assert!(error.to_string().contains("cannot be cancelled"));
}

#[tokio::test]
async fn native_signature_checks_reject_tampered_and_malformed_claims() {
    let secp = secp256k1::Secp256k1::new();
    let keys = secp256k1::Keypair::from_secret_key(
        &secp,
        &secp256k1::SecretKey::from_byte_array([7; 32]).unwrap(),
    );
    let digest = [9u8; 32];
    let claim = |id: [u8; 32], sig: &str| SignatureClaim {
        id: id.iter().map(|b| format!("{b:02x}")).collect(),
        pubkey: keys.x_only_public_key().0.to_string(),
        sig: sig.into(),
    };
    let sig = secp.sign_schnorr_no_aux_rand(&digest, &keys).to_string();
    let checked = relay_verify_signatures(vec![
        claim(digest, &sig),
        claim([8; 32], &sig),
        claim(digest, &"0".repeat(128)),
        claim(digest, "zz"),
    ])
    .await
    .unwrap();
    assert_eq!(checked, [true, false, false, false]);
}

#[tokio::test]
async fn finished_native_reads_release_their_cancel_slot() {
    // More completed reads than the registry holds, some failing: each frees its id.
    for read in 0..100 {
        let id = format!("{read:08}-4444-4444-8444-444444444444");
        let result = cancellable(Some(&id), "POST", "/query", async move {
            if read % 2 == 0 {
                Ok(cancelled_read())
            } else {
                Err("relay down".into())
            }
        })
        .await;
        match result {
            Ok(_) => assert_eq!(read % 2, 0),
            Err(error) => assert_eq!(error.to_string(), "relay down"),
        }
    }
}
