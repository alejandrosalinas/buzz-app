use super::*;
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::ipc::InvokeResponseBody;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Notify, Semaphore},
};

#[test]
fn hosted_backup_keeps_its_fixed_service_with_any_builderlab_build_target() {
    let service = Config {
        service_url: "https://app.builderlab.xyz/api/goose".into(),
        namespace: "backup/staging".into(),
    };
    for (origin, path) in [
        ("", ""),
        (
            "https://staging.builderlab.example",
            "/deployment/api/goose/",
        ),
        ("https://app.builderlab.xyz", "/staging/api/goose/"),
    ] {
        assert!(
            source_allowed_for(Source::Hosted, Some(&service), origin, path),
            "Builderlab target {origin}{path} must not change the hosted service"
        );
    }
    let wrong_service = Config {
        service_url: "https://app.builderlab.xyz/staging/api/goose".into(),
        namespace: "backup/staging".into(),
    };
    assert!(!source_allowed_for(
        Source::Hosted,
        Some(&wrong_service),
        "https://app.builderlab.xyz",
        "/api/goose/"
    ));
}

#[test]
fn builderlab_backup_requires_the_compiled_builderlab_api_path() {
    let service = Config {
        service_url: "https://app.builderlab.xyz/api/goose".into(),
        namespace: "backup/staging".into(),
    };
    assert!(source_allowed_for(
        Source::Builderlab,
        Some(&service),
        "https://app.builderlab.xyz",
        "/api/goose/"
    ));
    assert!(!source_allowed_for(
        Source::Builderlab,
        Some(&service),
        "https://staging.builderlab.example",
        "/api/goose/"
    ));
    assert!(!source_allowed_for(
        Source::Builderlab,
        Some(&service),
        "https://app.builderlab.xyz",
        "/staging/api/goose/"
    ));
    assert!(!source_allowed_for(
        Source::Builderlab,
        Some(&service),
        "https://app.builderlab.xyz",
        ""
    ));
}

fn pubkey(secret: [u8; 32]) -> String {
    PublicKey::from_secret_key(
        &Secp256k1::signing_only(),
        &SecretKey::from_byte_array(secret).unwrap(),
    )
    .x_only_public_key()
    .0
    .to_string()
}
fn recovery(keys: &[[u8; 32]], failed: usize) -> serde_json::Value {
    serde_json::json!({"backups":keys.iter().map(|key| serde_json::json!({
        "backup_id":uuid::Uuid::new_v4().to_string(), "nostr_pubkey":pubkey(*key), "secret_key":URL_SAFE_NO_PAD.encode(key)
    })).collect::<Vec<_>>(), "failed_backup_ids":(0..failed).map(|_|uuid::Uuid::new_v4().to_string()).collect::<Vec<_>>()})
}
struct FixtureState {
    me_status: u16,
    expires_at: String,
    mapping: Option<String>,
    mapping_status: u16,
    mapping_body: Option<serde_json::Value>,
    owner: String,
    namespace: String,
    enrollment_status: u16,
    recipient_id: String,
    recipient_key: Option<String>,
    subject: String,
    receipt_stored: bool,
    receipt_matches: bool,
    upload_status: u16,
    recovery_status: u16,
    recovery: serde_json::Value,
    requests: HashMap<String, usize>,
    uploads: Vec<Vec<u8>>,
    rows: HashMap<String, Vec<u8>>,
    /// Holds this route's response until `release_upload` gets a permit.
    pause_path: Option<&'static str>,
}
struct Service {
    root: String,
    state: Arc<Mutex<FixtureState>>,
    pause_upload: Arc<AtomicBool>,
    pause_current: Arc<AtomicBool>,
    upload_started: Arc<Notify>,
    release_upload: Arc<Semaphore>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Service {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Service {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(FixtureState {
            me_status: 200,
            expires_at: "2999-01-01T00:00:00Z".into(),
            mapping: Some(pubkey([1; 32])),
            mapping_status: 200,
            mapping_body: None,
            owner: "subject:synthetic-account".into(),
            namespace: "backup/staging".into(),
            enrollment_status: 200,
            recipient_id: "backup-key-2026-09".into(),
            recipient_key: None,
            subject: "synthetic-account".into(),
            receipt_stored: true,
            receipt_matches: true,
            upload_status: 200,
            recovery_status: 200,
            recovery: recovery(&[[1; 32]], 0),
            requests: HashMap::new(),
            uploads: Vec::new(),
            rows: HashMap::new(),
            pause_path: None,
        }));
        let pause_upload = Arc::new(AtomicBool::new(false));
        let pause_current = Arc::new(AtomicBool::new(false));
        let upload_started = Arc::new(Notify::new());
        let release_upload = Arc::new(Semaphore::new(0));
        let current = pause_current.clone();
        let (shared, pause, started, release) = (
            state.clone(),
            pause_upload.clone(),
            upload_started.clone(),
            release_upload.clone(),
        );
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let current = current.clone();
                let (shared, pause, started, release) = (
                    shared.clone(),
                    pause.clone(),
                    started.clone(),
                    release.clone(),
                );
                tokio::spawn(async move {
                    serve(stream, shared, pause, current, started, release).await;
                });
            }
        });
        Self {
            root,
            state,
            pause_upload,
            pause_current,
            upload_started,
            release_upload,
            task,
        }
    }
    fn host(&self, root: &std::path::Path) -> NsecBackupHost {
        NsecBackupHost {
            federated: None,
            state: Default::default(),
            config: Arc::new(Some(Config {
                service_url: self.root.clone(),
                namespace: "backup/staging".into(),
            })),
            root: Some(root.to_owned()),
        }
    }
    fn session(&self) -> Session {
        Session {
            source: Source::Hosted,
            auth: Auth::Credential(Zeroizing::new("synthetic-cli-credential".into())),
        }
    }
    async fn enable(&self, host: &NsecBackupHost) {
        host.set_choice(IdentityHost::fixture(), &pubkey([1; 32]), true, false)
            .await
            .unwrap();
    }
}
async fn serve(
    mut stream: TcpStream,
    shared: Arc<Mutex<FixtureState>>,
    pause: Arc<AtomicBool>,
    pause_current: Arc<AtomicBool>,
    started: Arc<Notify>,
    release: Arc<Semaphore>,
) {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 1024];
    let header_end = loop {
        let count = stream.read(&mut chunk).await.unwrap();
        if count == 0 {
            return;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let header = std::str::from_utf8(&bytes[..header_end])
        .unwrap()
        .to_owned();
    let path = header
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .to_owned();
    let length = header
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while bytes.len() < header_end + length {
        let count = stream.read(&mut chunk).await.unwrap();
        if count == 0 {
            return;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    let body = bytes[header_end..].to_vec();
    let lower = header.to_ascii_lowercase();
    assert!(
        path.ends_with("/exchange")
            || lower.contains("x-bb-session-credential: synthetic-cli-credential")
            || lower.contains("authorization: bearer fixture-session-token") // sadscan:disable np.http.2 (fake test token)
                && !lower.contains("x-bb-session-credential"),
        "{header}"
    );
    let (status, response) = {
        let mut state = shared.lock().unwrap();
        *state.requests.entry(path.clone()).or_default() += 1;
        match path.as_str() {
            "/v1/auth/login/exchange" => (200, serde_json::json!({"session_credential":"synthetic-cli-credential"})),
            "/v1/auth/me" => (state.me_status, serde_json::json!({"subject":state.subject,"expires_at":state.expires_at})),
            "/v1/buzz/nostr-identities/current" => (state.mapping_status,state.mapping_body.clone().unwrap_or_else(||serde_json::json!({"correlation_id":"synthetic-correlation","identity":state.mapping.as_ref().map(|key|serde_json::json!({"pubkey_hex":key}))}))),
            "/v1/buzz/nsec-backups/enrollment" => {
                let fixture: serde_json::Value = serde_json::from_str(include_str!("fixtures/hpke_nsec_backup_v1.json")).unwrap();
                (state.enrollment_status, serde_json::json!({"version":1,"suite":{"kem_id":16,"kdf_id":1,"aead_id":2},
                    "recipient_key_id":state.recipient_id,"service_namespace":state.namespace,"owner_id":state.owner,
                    "backup_id":uuid::Uuid::new_v4().to_string(),"nostr_pubkey":state.mapping,
                    "recipient_public_key":state.recipient_key.clone().unwrap_or_else(||URL_SAFE_NO_PAD.encode(hex::decode(fixture["recipient_public_key_sec1_hex"].as_str().unwrap()).unwrap()))}))
            },
            "/v1/buzz/nsec-backups" => {
                let envelope: serde_json::Value = serde_json::from_slice(&body).unwrap();
                let id = envelope["backup_id"].as_str().unwrap().to_owned();
                if let Some(previous) = state.rows.get(&id) { assert_eq!(previous, &body); }
                state.rows.insert(id.clone(),body.clone());
                state.uploads.push(body);
                (state.upload_status,serde_json::json!({"backup_id":if state.receipt_matches { id } else { uuid::Uuid::new_v4().to_string() },"stored":state.receipt_stored}))
            },
            "/v1/buzz/nsec-backups/recovery" => (state.recovery_status,state.recovery.clone()),
            _ => panic!("unexpected synthetic route {path}"),
        }
    };
    if (path == "/v1/buzz/nsec-backups" || path == "/v1/buzz/nsec-backups/recovery")
        && pause.load(Ordering::SeqCst)
        || path == "/v1/buzz/nostr-identities/current" && pause_current.load(Ordering::SeqCst)
        || shared.lock().unwrap().pause_path == Some(path.as_str())
    {
        started.notify_one();
        release.acquire().await.unwrap().forget();
    }
    let response = serde_json::to_vec(&response).unwrap();
    let header = format!("HTTP/1.1 {status} Synthetic\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",response.len());
    stream.write_all(header.as_bytes()).await.unwrap();
    let _ = stream.write_all(&response).await;
}

#[tokio::test]
async fn overlapping_binding_triggers_back_up_after_a_stale_missing_mapping_response() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    service.enable(&host).await;
    let identity = IdentityHost::fixture();
    service.state.lock().unwrap().mapping = None;
    service.pause_current.store(true, Ordering::SeqCst);
    host.state.lock().unwrap().sessions.push(service.session());
    host.trigger(identity.clone());
    service.upload_started.notified().await;
    service.state.lock().unwrap().mapping = Some(pubkey([1; 32]));
    for _ in 0..3 {
        host.trigger(identity.clone());
    }
    service.pause_current.store(false, Ordering::SeqCst);
    service.release_upload.add_permits(1);
    finish_background(&host).await;
    let state = service.state.lock().unwrap();
    assert_eq!(state.requests["/v1/buzz/nostr-identities/current"], 2);
    assert_eq!(state.uploads.len(), 1);
    assert_eq!(state.rows.len(), 1);
    drop(state);
    let record = persistence::LockedRecord::open(
        directory.path(),
        host.config.as_ref().as_ref().unwrap(),
        "synthetic-account",
        &pubkey([1; 32]),
    )
    .unwrap()
    .read()
    .unwrap()
    .unwrap();
    assert!(record.envelope.is_none());
}

#[tokio::test]
async fn retirement_cancels_a_queued_binding_pass_without_recreating_erased_records() {
    for signout in [false, true] {
        let service = Service::new().await;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("records");
        std::fs::create_dir(&root).unwrap();
        let host = service.host(&root);
        service.enable(&host).await;
        service.enable(&host).await;
        let identity = IdentityHost::fixture();
        service.pause_current.store(true, Ordering::SeqCst);
        host.state.lock().unwrap().sessions.push(service.session());
        host.trigger(identity.clone());
        service.upload_started.notified().await;
        host.trigger(identity.clone());
        let worker = host
            .state
            .lock()
            .unwrap()
            .worker
            .as_ref()
            .unwrap()
            .inner()
            .abort_handle();
        if signout {
            host.close();
        } else {
            host.document_load();
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while !worker.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        service.release_upload.add_permits(1);
        host.trigger(identity);
        finish_background(&host).await;
        assert!(!root.exists());
        let state = service.state.lock().unwrap();
        assert_eq!(state.requests["/v1/buzz/nostr-identities/current"], 1);
        assert!(state.uploads.is_empty());
    }
}

#[tokio::test]
async fn restart_retry_reuses_persisted_ciphertext_and_completion_prevents_more_slots() {
    // A lost acknowledgment retains ciphertext while the authenticated recipient is unchanged.
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    service.enable(&host).await;
    service.state.lock().unwrap().upload_status = 503;
    assert_eq!(
        host.backup(&IdentityHost::fixture(), &service.session(), 0)
            .await,
        Err(Stop::Failed(Failure::Unreachable))
    );
    let first = service.state.lock().unwrap().uploads[0].clone();
    service.state.lock().unwrap().upload_status = 200;
    let restarted = service.host(directory.path());
    restarted
        .set_choice(IdentityHost::fixture(), &pubkey([1; 32]), false, false)
        .await
        .unwrap();
    let baseline = service.state.lock().unwrap().requests.clone();
    assert_eq!(
        restarted
            .backup(&IdentityHost::fixture(), &service.session(), 0)
            .await,
        Ok(Outcome::Waiting(Waiting::NoConsent))
    );
    assert_eq!(service.state.lock().unwrap().requests, baseline);
    service.enable(&restarted).await;
    for _ in 0..2 {
        assert_eq!(
            restarted
                .backup(&IdentityHost::fixture(), &service.session(), 0)
                .await,
            Ok(Outcome::Complete)
        );
    }
    let state = service.state.lock().unwrap();
    assert_eq!(state.uploads, vec![first.clone(), first]);
    assert_eq!(state.rows.len(), 1);
    assert_eq!(state.requests["/v1/buzz/nsec-backups/enrollment"], 2);
}

#[tokio::test]
async fn invalid_receipts_and_changed_recipient_owner_cannot_settle_or_reseal_a_pending_backup() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    service.enable(&host).await;
    service.state.lock().unwrap().receipt_matches = false;
    assert!(host
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .is_err());
    service.state.lock().unwrap().receipt_matches = true;
    service.state.lock().unwrap().receipt_stored = false;
    assert!(host
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .is_err());
    service.state.lock().unwrap().receipt_stored = true;
    // A new authenticated owner gets a separate record, never the old owner's ciphertext.
    service.state.lock().unwrap().owner = "subject:other-synthetic-account".into();
    assert!(host
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .is_err());
    service.state.lock().unwrap().subject = "other-synthetic-account".into();
    host.backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .unwrap();
    let state = service.state.lock().unwrap();
    assert_eq!(state.uploads[0], state.uploads[1]);
    assert_ne!(state.uploads[1], state.uploads[2]);
    assert_eq!(state.rows.len(), 2);
}

#[tokio::test]
async fn mismatched_mapping_and_unwritable_pending_state_never_upload() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    service.enable(&host).await;
    service.state.lock().unwrap().mapping = Some(pubkey([2; 32]));
    assert_eq!(
        host.backup(&IdentityHost::fixture(), &service.session(), 0)
            .await,
        Err(Stop::Failed(Failure::OtherKeyLinked))
    );
    service.state.lock().unwrap().mapping = Some(pubkey([1; 32]));
    service.pause_current.store(true, Ordering::SeqCst);
    let task_host = host.clone();
    let session = service.session();
    let backup = tokio::spawn(async move {
        task_host
            .backup(&IdentityHost::fixture(), &session, 0)
            .await
    });
    service.upload_started.notified().await;
    let retained = directory.path().with_extension("retained");
    std::fs::rename(directory.path(), &retained).unwrap();
    std::fs::write(directory.path(), b"synthetic persistence failure").unwrap();
    service.release_upload.add_permits(1);
    let result = backup.await;
    std::fs::remove_file(directory.path()).unwrap();
    std::fs::rename(&retained, directory.path()).unwrap();
    assert_eq!(result.unwrap(), Err(Stop::Failed(Failure::Storage)));
    assert!(service.state.lock().unwrap().uploads.is_empty());
}

#[tokio::test]
async fn competing_workers_and_signout_keep_an_admitted_upload_pending() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    service.enable(&host).await;
    service.pause_upload.store(true, Ordering::SeqCst);
    let task_host = host.clone();
    let session = service.session();
    let upload = tokio::spawn(async move {
        task_host
            .backup(&IdentityHost::fixture(), &session, 0)
            .await
    });
    service.upload_started.notified().await;
    // Another copy holding this key's record lock is `busy`, retried on the next wake.
    assert_eq!(
        service
            .host(directory.path())
            .backup(&IdentityHost::fixture(), &service.session(), 0)
            .await,
        Err(Stop::Failed(Failure::Busy))
    );
    host.close();
    service.release_upload.add_permits(1);
    assert_eq!(upload.await.unwrap(), Err(Stop::Canceled));
    service.pause_upload.store(false, Ordering::SeqCst);
    service
        .host(directory.path())
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .unwrap();
    let state = service.state.lock().unwrap();
    assert_eq!(state.uploads.len(), 2);
    assert_eq!(state.uploads[0], state.uploads[1]);
    assert_eq!(state.rows.len(), 1);
}

#[test]
fn recovery_validates_scalars_and_metadata_and_deduplicates_public_choices() {
    let mut value = recovery(&[[1; 32], [2; 32], [1; 32]], 2);
    value["backups"].as_array_mut().unwrap().push(serde_json::json!({"backup_id":uuid::Uuid::new_v4().to_string(),"nostr_pubkey":pubkey([3;32]),"secret_key":URL_SAFE_NO_PAD.encode([1;32])}));
    value["backups"].as_array_mut().unwrap().push(serde_json::json!({"backup_id":uuid::Uuid::new_v4().to_string(),"nostr_pubkey":pubkey([1;32]),"secret_key":URL_SAFE_NO_PAD.encode([0;32])}));
    let (keys, failed) = candidates(serde_json::from_value(value).unwrap());
    assert_eq!(
        keys.iter()
            .map(|key| key.pubkey.clone())
            .collect::<Vec<_>>(),
        vec![pubkey([1; 32]), pubkey([2; 32])]
    );
    assert_ne!(keys[0].handle, keys[1].handle);
    assert_eq!(failed, 4);
}

async fn recover_with(service: &Service, host: &NsecBackupHost) -> Result<RestoreResult> {
    let callback = OAuthCallbackHost::default();
    let authorization = Arc::new(Mutex::new(String::new()));
    let capture = authorization.clone();
    let oauth = callback
        .begin(
            OAuthRequest {
                authorization_url: "https://signin.example/login".into(),
                callback_path: "/synthetic".into(),
                use_state: Some(true),
            },
            move |url| {
                *capture.lock().unwrap() = url.into();
                Ok(())
            },
        )
        .unwrap();
    let callback_url = oauth.callback_url.clone();
    let state = url::Url::parse(&authorization.lock().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .to_string();
    let id = "synthetic-attempt";
    let (_send, receive) = oneshot::channel();
    host.state.lock().unwrap().restore = Some(Restore {
        id: id.into(),
        admission: Arc::new(Mutex::new(true)),
        callback: callback.clone(),
        callback_id: oauth.id.clone(),
        task: tauri::async_runtime::spawn(std::future::pending()),
        result: Some(receive),
        candidates: Vec::new(),
        current: None,
        credential: None,
        subject: None,
        installing: false,
    });
    let task_host = host.clone();
    let task = tokio::spawn(async move {
        task_host
            .recover(
                0,
                id,
                callback,
                oauth.id,
                callback_url,
                Zeroizing::new("synthetic-verifier".into()),
            )
            .await
    });
    let callback_url = url::Url::parse(&oauth.callback_url).unwrap();
    let authority = format!("127.0.0.1:{}", callback_url.port().unwrap());
    let mut stream = TcpStream::connect(&authority).await.unwrap();
    stream.write_all(format!("GET /synthetic?state={state}&code=synthetic-code HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes()).await.unwrap();
    let result = task.await.unwrap();
    // Keep the service borrowed through completion; no OS credential store is involved.
    assert_eq!(
        service.state.lock().unwrap().requests.get("/v1/auth/me"),
        Some(&1)
    );
    result
}

#[tokio::test]
async fn native_recovery_preserves_empty_partial_all_failed_unavailable_and_refused_distinctions() {
    for (keys, failed, status) in [
        (vec![], 0, 200),
        (vec![], 2, 200),
        (vec![[1; 32], [2; 32]], 1, 200),
        (vec![], 0, 404),
        (vec![], 0, 403),
    ] {
        let service = Service::new().await;
        let directory = tempfile::tempdir().unwrap();
        let host = service.host(directory.path());
        service.state.lock().unwrap().recovery = recovery(&keys, failed);
        service.state.lock().unwrap().recovery_status = status;
        let result = recover_with(&service, &host).await;
        if status == 404 {
            assert_eq!(result.err().as_deref(), Some(UNAVAILABLE));
        } else if status == 403 {
            assert_eq!(result.err().as_deref(), Some(REFUSED));
        } else {
            let result = result.unwrap();
            assert_eq!(result.candidates.len(), keys.len());
            assert_eq!(result.failed_count, failed);
            assert_eq!(result.current_pubkey, Some(pubkey([1; 32])));
        }
        host.cancel("synthetic-attempt");
        host.cancel("synthetic-attempt");
    }
}

#[tokio::test]
async fn mapping_failure_never_becomes_a_missing_binding() {
    // A rejected session reads as any other failure here, unlike in a backup
    // pass; an account without Buzz access is refused, as by recovery itself.
    for (status, expected) in [(404, RETRY), (401, RETRY), (403, REFUSED)] {
        let service = Service::new().await;
        let directory = tempfile::tempdir().unwrap();
        service.state.lock().unwrap().mapping_status = status;
        let result = recover_with(&service, &service.host(directory.path())).await;
        assert_eq!(result.err().as_deref(), Some(expected), "status {status}");
        assert!(!service
            .state
            .lock()
            .unwrap()
            .requests
            .contains_key("/v1/buzz/nsec-backups/recovery"));
    }
}

#[tokio::test]
async fn recovered_completion_survives_restart_and_does_not_backup_again_after_binding() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    service.enable(&host).await;
    let config = host.config.as_ref().as_ref().unwrap();
    let recovered_id = uuid::Uuid::new_v4().to_string();
    persistence::remember_restored(
        directory.path(),
        config,
        "synthetic-account",
        &pubkey([1; 32]),
        &recovered_id,
    )
    .unwrap();
    service.state.lock().unwrap().mapping = Some(pubkey([2; 32]));
    assert!(service
        .host(directory.path())
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .is_err());
    service.state.lock().unwrap().mapping = Some(pubkey([1; 32]));
    service
        .host(directory.path())
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .unwrap();
    assert!(service.state.lock().unwrap().uploads.is_empty());
    assert_eq!(
        persistence::LockedRecord::open(
            directory.path(),
            config,
            "synthetic-account",
            &pubkey([1; 32])
        )
        .unwrap()
        .read()
        .unwrap()
        .unwrap()
        .backup_id,
        recovered_id
    );
    assert!(persistence::LockedRecord::open(
        directory.path(),
        config,
        "other-account",
        &pubkey([1; 32])
    )
    .unwrap()
    .read()
    .unwrap()
    .is_none());
}

#[tokio::test]
async fn known_missing_mapping_accepts_omitted_identity_but_malformed_success_is_retryable() {
    for response in [
        serde_json::json!({"correlation_id":"synthetic-correlation"}),
        serde_json::json!({}),
    ] {
        let service = Service::new().await;
        service.state.lock().unwrap().mapping_body = Some(response.clone());
        let result = Api::new(&service.root, "synthetic-cli-credential")
            .unwrap()
            .current()
            .await;
        if response.get("correlation_id").is_some() {
            assert_eq!(result.unwrap(), None);
        } else {
            assert!(result.is_err());
        }
    }
}

#[tokio::test]
async fn canceled_recovery_drops_candidates_and_a_late_response_cannot_publish_them() {
    for action in ["cancel", "reload", "close"] {
        let service = Service::new().await;
        let directory = tempfile::tempdir().unwrap();
        let host = service.host(directory.path());
        service.pause_upload.store(true, Ordering::SeqCst);
        let recovering = recover_with(&service, &host);
        tokio::pin!(recovering);
        tokio::select! {
            _ = service.upload_started.notified() => {},
            _ = &mut recovering => panic!("recovery completed before the fixture released it"),
        }
        match action {
            "cancel" => host.cancel("synthetic-attempt"),
            "reload" => host.document_load(),
            _ => host.close(),
        }
        service.release_upload.add_permits(1);
        assert_eq!(recovering.await.err().as_deref(), Some(CANCELED));
        assert!(host.state.lock().unwrap().restore.is_none());
    }
}

#[tokio::test]
async fn completion_persistence_failure_retains_the_same_pending_bytes_for_restart() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("records");
    let retained = directory.path().join("retained");
    let host = service.host(&root);
    service.enable(&host).await;
    service.pause_upload.store(true, Ordering::SeqCst);
    let session = service.session();
    let task_host = host.clone();
    let backup = tokio::spawn(async move {
        task_host
            .backup(&IdentityHost::fixture(), &session, 0)
            .await
    });
    service.upload_started.notified().await;
    std::fs::rename(&root, &retained).unwrap();
    std::fs::write(&root, b"synthetic persistence failure").unwrap();
    service.release_upload.add_permits(1);
    assert!(backup.await.unwrap().is_err());
    std::fs::remove_file(&root).unwrap();
    std::fs::rename(&retained, &root).unwrap();
    service.pause_upload.store(false, Ordering::SeqCst);
    service
        .host(&root)
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .unwrap();
    let state = service.state.lock().unwrap();
    assert_eq!(state.uploads.len(), 2);
    assert_eq!(state.uploads[0], state.uploads[1]);
    assert_eq!(state.rows.len(), 1);
}

#[tokio::test]
async fn absent_or_invalid_consent_never_contacts_the_backup_service() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    let identity = IdentityHost::fixture();
    let path = directory.path().join("choice.json");
    host.backup(&identity, &service.session(), 0).await.unwrap();
    assert!(service.state.lock().unwrap().requests.is_empty());
    service.enable(&host).await;
    let session = service.session();
    let queued = host.backup(&identity, &session, 0);
    host.set_choice(identity.clone(), &pubkey([1; 32]), false, false)
        .await
        .unwrap();
    queued.await.unwrap();
    assert!(service.state.lock().unwrap().requests.is_empty());
    service.enable(&host).await;
    let original: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for (field, value) in [
        ("automatic", serde_json::json!(false)),
        ("pubkey", serde_json::json!(pubkey([2; 32]))),
        ("service", serde_json::json!("https://other.example")),
        ("namespace", serde_json::json!("other")),
    ] {
        let mut changed = original.clone();
        changed[field] = value;
        std::fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
        host.backup(&identity, &service.session(), 0).await.unwrap();
        assert!(service.state.lock().unwrap().requests.is_empty());
    }
    std::fs::write(&path, b"corrupt").unwrap();
    assert_eq!(
        host.backup(&identity, &service.session(), 0).await,
        Err(Stop::Failed(Failure::Storage))
    );
    assert!(service.state.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn saving_consent_after_login_wakes_the_existing_uploader_and_disable_fences_later_passes() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    host.state.lock().unwrap().sessions.push(service.session());
    host.trigger(IdentityHost::fixture());
    finish_background(&host).await;
    assert!(service.state.lock().unwrap().requests.is_empty());
    service.pause_upload.store(true, Ordering::SeqCst);
    let started = service.upload_started.notified();
    host.set_choice(IdentityHost::fixture(), &pubkey([1; 32]), true, false)
        .await
        .unwrap();
    started.await;
    let other = service.host(directory.path());
    let refused = other
        .set_choice(IdentityHost::fixture(), &pubkey([1; 32]), false, false)
        .await;
    let choice = crate::nsec_backup_choice::read(
        &directory.path().join("choice.json"),
        host.config.as_ref().as_ref().unwrap(),
        &pubkey([1; 32]),
    );
    let still_enabled = choice.as_ref().ok().map(|choice| choice.automatic);
    drop(choice);
    service.release_upload.add_permits(1);
    finish_background(&host).await;
    assert!(refused.is_err());
    assert_eq!(still_enabled, Some(Some(true)));
    other
        .set_choice(IdentityHost::fixture(), &pubkey([1; 32]), false, false)
        .await
        .unwrap();
    let baseline = service.state.lock().unwrap().requests.clone();
    host.trigger(IdentityHost::fixture());
    finish_background(&host).await;
    assert_eq!(service.state.lock().unwrap().requests, baseline);
    assert_eq!(service.state.lock().unwrap().uploads.len(), 1);
}

#[tokio::test]
async fn a_managed_build_enables_backup_during_a_running_pass() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    service.enable(&host).await;
    service.pause_upload.store(true, Ordering::SeqCst);
    let started = service.upload_started.notified();
    host.state.lock().unwrap().sessions.push(service.session());
    host.trigger(IdentityHost::fixture());
    started.await;
    let (identity, path, key) = (
        IdentityHost::fixture(),
        directory.path().join("choice.json"),
        pubkey([1; 32]),
    );
    let config = host.config.as_ref().as_ref().unwrap();
    let set = |managed| {
        crate::nsec_backup_choice::set(&identity, &path, config, &key, true, managed, false)
    };
    let unmanaged = set(false).await.map(|choice| choice.automatic);
    let managed = set(true).await.map(|choice| choice.automatic);
    service.release_upload.add_permits(1);
    finish_background(&host).await;
    assert_eq!(unmanaged, Ok(Some(true)));
    assert_eq!(managed, Ok(Some(true)));
    assert_eq!(service.state.lock().unwrap().uploads.len(), 1);
}

#[tokio::test]
async fn a_managed_build_admits_a_pass_whatever_choice_is_saved() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("choice.json");
    let config = production();
    let config = config.as_ref().as_ref().unwrap();
    let (identity, key) = (IdentityHost::fixture(), pubkey([1; 32]));
    let admit = |managed| crate::nsec_backup_choice::admit(&path, config, &key, managed);
    let set = |automatic| {
        crate::nsec_backup_choice::set(&identity, &path, config, &key, automatic, false, false)
    };
    // Missing, opted out, then malformed.
    assert!(admit(false).unwrap().is_none());
    assert!(admit(true).unwrap().is_some());
    set(false).await.unwrap();
    assert!(admit(false).unwrap().is_none());
    let held = admit(true).unwrap();
    assert!(held.is_some());
    assert_eq!(
        set(false).await.map(|choice| choice.automatic),
        Err(crate::nsec_backup_choice::BUSY.into())
    );
    // Only a managed build enables an opted-out key while a pass holds the lease.
    assert_eq!(
        set(true).await.map(|choice| choice.automatic),
        Err(crate::nsec_backup_choice::BUSY.into())
    );
    assert_eq!(
        crate::nsec_backup_choice::set(&identity, &path, config, &key, true, true, false)
            .await
            .map(|choice| choice.automatic),
        Ok(Some(true))
    );
    drop(held);
    std::fs::write(&path, b"corrupt").unwrap();
    assert!(admit(false).is_err());
    assert!(admit(true).unwrap().is_some());
}

#[tokio::test]
async fn enabling_backup_again_during_its_own_pass_returns_the_saved_choice() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    service.enable(&host).await;
    service.pause_upload.store(true, Ordering::SeqCst);
    let started = service.upload_started.notified();
    host.state.lock().unwrap().sessions.push(service.session());
    host.trigger(IdentityHost::fixture());
    started.await;
    let enabled = host
        .set_choice(IdentityHost::fixture(), &pubkey([1; 32]), true, false)
        .await
        .map(|choice| choice.automatic);
    service.release_upload.add_permits(1);
    finish_background(&host).await;
    assert_eq!(enabled, Ok(Some(true)));
    assert_eq!(service.state.lock().unwrap().uploads.len(), 1);
}

#[tokio::test]
async fn enabling_backup_while_another_copy_holds_consent_writes_it_or_reports_busy() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    let path = directory.path().join("choice.json");
    let config = host.config.clone();
    let config = config.as_ref().as_ref().unwrap();
    let seen = record(&host, true);
    host.state.lock().unwrap().sessions.push(service.session());
    // No saved choice, then an opt-out: neither may be skipped as already on.
    for saved in [None, Some(false)] {
        if let Some(automatic) = saved {
            host.set_choice(IdentityHost::fixture(), &pubkey([1; 32]), automatic, false)
                .await
                .unwrap();
        }
        // What another copy's pass holds until it ends.
        let held = crate::nsec_backup_choice::read(&path, config, &pubkey([1; 32])).unwrap();
        let refused = host
            .set_choice(IdentityHost::fixture(), &pubkey([1; 32]), true, false)
            .await;
        assert_eq!(
            refused.err().as_deref(),
            Some(crate::nsec_backup_choice::BUSY)
        );
        drop(held);
        assert_eq!(
            crate::nsec_backup_choice::read(&path, config, &pubkey([1; 32]))
                .unwrap()
                .automatic,
            saved
        );
    }
    assert!(statuses(&seen).is_empty());
    host.set_choice(IdentityHost::fixture(), &pubkey([1; 32]), true, false)
        .await
        .unwrap();
    finish_background(&host).await;
    assert_eq!(statuses(&seen), ["1 running", "1 complete"]);
    assert_eq!(service.state.lock().unwrap().uploads.len(), 1);
}

#[test]
fn source_generations_and_teardown_fence_retired_work_without_another_sources_logout() {
    // No filesystem or worker is configured; exercise purpose-specific credential ownership.
    let host = NsecBackupHost {
        federated: None,
        state: Default::default(),
        root: None,
        config: Arc::new(Some(Config {
            service_url: "https://app.builderlab.xyz/api/goose".into(),
            namespace: "backup/staging".into(),
        })),
    };
    host.session(
        Source::Hosted,
        3,
        Some("synthetic-session".into()),
        IdentityHost::fixture(),
    )
    .unwrap();
    let epoch = host.state.lock().unwrap().epoch;
    host.session(Source::Hosted, 2, None, IdentityHost::fixture())
        .unwrap();
    assert!(host.valid(epoch).is_ok());
    host.session(Source::Hosted, 4, None, IdentityHost::fixture())
        .unwrap();
    assert!(host.valid(epoch).is_err());
    assert!(host.state.lock().unwrap().sessions.is_empty());
    host.session(
        Source::Hosted,
        5,
        Some("synthetic-session".into()),
        IdentityHost::fixture(),
    )
    .unwrap();
    let epoch = host.state.lock().unwrap().epoch;
    host.document_load();
    assert!(host.valid(epoch).is_err());
    assert!(host.state.lock().unwrap().sessions.is_empty());
    host.close();
    host.session(
        Source::Hosted,
        7,
        Some("synthetic-session".into()),
        IdentityHost::fixture(),
    )
    .unwrap();
    assert!(host.state.lock().unwrap().sessions.is_empty());
}

async fn finish_background(host: &NsecBackupHost) {
    let worker = host.state.lock().unwrap().worker.take();
    if let Some(worker) = worker {
        worker.await.unwrap();
    }
}

#[tokio::test]
async fn explicit_current_and_historical_install_commit_selected_key_and_durable_completion() {
    for selected in [[1; 32], [2; 32]] {
        let service = Service::new().await;
        service.state.lock().unwrap().recovery = recovery(&[[2; 32], [1; 32], [1; 32]], 0);
        let directory = tempfile::tempdir().unwrap();
        let host = service.host(directory.path());
        let identity = crate::identity::tests::missing_fixture();
        let recovered = recover_with(&service, &host).await.unwrap();
        let chosen = recovered
            .candidates
            .iter()
            .find(|key| key.pubkey == pubkey(selected))
            .unwrap();
        assert_eq!(
            host.install(identity.clone(), "synthetic-attempt", &chosen.handle)
                .await
                .unwrap(),
            pubkey(selected)
        );
        assert_eq!(identity.viewer().await.unwrap(), pubkey(selected));
        assert_eq!(
            host.wait("synthetic-attempt").await.err().as_deref(),
            Some(CANCELED)
        );
        assert!(host.state.lock().unwrap().sessions.is_empty());
        finish_background(&host).await;
        let config = host.config.as_ref().as_ref().unwrap();
        let record = persistence::LockedRecord::open(
            directory.path(),
            config,
            "synthetic-account",
            &pubkey(selected),
        )
        .unwrap()
        .read()
        .unwrap()
        .unwrap();
        assert!(record.envelope.is_none());
        let state = service.state.lock().unwrap();
        assert!(state.uploads.is_empty());
        assert!(!state
            .requests
            .contains_key("/v1/buzz/nsec-backups/enrollment"));
        assert_eq!(state.mapping, Some(pubkey([1; 32])));
        drop(state);
        assert_eq!(
            crate::nsec_backup_choice::read(
                &directory.path().join("choice.json"),
                config,
                &pubkey(selected),
            )
            .unwrap()
            .automatic,
            Some(true)
        );
    }
}

#[tokio::test]
async fn a_restored_key_stays_backed_up_and_its_next_pass_completes_without_uploading() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    let identity = crate::identity::tests::missing_fixture();
    let handle = recover_with(&service, &host).await.unwrap().candidates[0]
        .handle
        .clone();
    let seen = record(&host, true);
    host.install(identity.clone(), "synthetic-attempt", &handle)
        .await
        .unwrap();
    // A later Builderlab sign-in, as on a new device.
    host.state.lock().unwrap().sessions.push(service.session());
    host.trigger(identity);
    finish_background(&host).await;
    assert_eq!(statuses(&seen), ["1 running", "1 complete"]);
    let state = service.state.lock().unwrap();
    assert!(state.uploads.is_empty());
    assert!(!state
        .requests
        .contains_key("/v1/buzz/nsec-backups/enrollment"));
}

#[tokio::test]
async fn a_restored_key_keeps_its_saved_opt_out() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    // Kept by a plain sign-out of Buzz.
    host.set_choice(IdentityHost::fixture(), &pubkey([1; 32]), false, false)
        .await
        .unwrap();
    let identity = crate::identity::tests::missing_fixture();
    let handle = recover_with(&service, &host).await.unwrap().candidates[0]
        .handle
        .clone();
    host.install(identity, "synthetic-attempt", &handle)
        .await
        .unwrap();
    finish_background(&host).await;
    let config = host.config.as_ref().as_ref().unwrap();
    assert_eq!(
        crate::nsec_backup_choice::read(
            &directory.path().join("choice.json"),
            config,
            &pubkey([1; 32]),
        )
        .unwrap()
        .automatic,
        Some(false)
    );
}

#[tokio::test]
async fn install_mapping_change_leaves_candidate_retryable_without_key_adoption() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("records");
    let host = service.host(&root);
    let identity = crate::identity::tests::missing_fixture();
    let recovered = recover_with(&service, &host).await.unwrap();
    let handle = &recovered.candidates[0].handle;
    service.state.lock().unwrap().mapping = Some(pubkey([2; 32]));
    assert!(host
        .install(identity.clone(), "synthetic-attempt", handle)
        .await
        .is_err());
    identity.require_missing().await.unwrap();
    service.state.lock().unwrap().mapping = Some(pubkey([1; 32]));
    assert_eq!(
        host.install(identity.clone(), "synthetic-attempt", handle)
            .await
            .unwrap(),
        pubkey([1; 32])
    );
    finish_background(&host).await;
    assert_eq!(identity.viewer().await.unwrap(), pubkey([1; 32]));
}

#[tokio::test]
async fn completion_bookkeeping_failure_does_not_block_selected_secure_store_installation() {
    for corrupt_json in [false, true] {
        let service = Service::new().await;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("records");
        let host = service.host(&root);
        let identity = crate::identity::tests::missing_fixture();
        let recovered = recover_with(&service, &host).await.unwrap();
        if corrupt_json {
            let _slot = persistence::LockedRecord::open(
                &root,
                host.config.as_ref().as_ref().unwrap(),
                "synthetic-account",
                &pubkey([1; 32]),
            )
            .unwrap();
            let path = std::fs::read_dir(&root)
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path()
                .with_extension("json");
            std::fs::write(path, b"synthetic corrupt JSON").unwrap();
        } else {
            std::fs::write(&root, b"synthetic unavailable backup directory").unwrap();
        }
        assert_eq!(
            host.install(
                identity.clone(),
                "synthetic-attempt",
                &recovered.candidates[0].handle
            )
            .await
            .unwrap(),
            pubkey([1; 32])
        );
        finish_background(&host).await;
        assert_eq!(identity.viewer().await.unwrap(), pubkey([1; 32]));
        assert!(service.state.lock().unwrap().uploads.is_empty());
    }
}

#[tokio::test]
async fn secure_store_write_failure_keeps_native_candidate_for_retry_after_access_recovers() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    let (identity, allow_writes) = crate::identity::tests::write_denied_fixture();
    let recovered = recover_with(&service, &host).await.unwrap();
    let handle = &recovered.candidates[0].handle;
    assert!(host
        .install(identity.clone(), "synthetic-attempt", handle)
        .await
        .is_err());
    identity.require_missing().await.unwrap();
    allow_writes();
    assert_eq!(
        host.install(identity.clone(), "synthetic-attempt", handle)
            .await
            .unwrap(),
        pubkey([1; 32])
    );
    finish_background(&host).await;
    assert_eq!(identity.viewer().await.unwrap(), pubkey([1; 32]));
}

#[tokio::test]
async fn cancel_during_install_mapping_wait_fences_a_late_response_and_invalidates_handle() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    let identity = crate::identity::tests::missing_fixture();
    let recovered = recover_with(&service, &host).await.unwrap();
    let handle = recovered.candidates[0].handle.clone();
    service.pause_current.store(true, Ordering::SeqCst);
    let task_host = host.clone();
    let task_identity = identity.clone();
    let task_handle = handle.clone();
    let installing = tokio::spawn(async move {
        task_host
            .install(task_identity, "synthetic-attempt", &task_handle)
            .await
    });
    service.upload_started.notified().await;
    host.cancel("synthetic-attempt");
    service.release_upload.add_permits(1);
    assert_eq!(installing.await.unwrap().err().as_deref(), Some(CANCELED));
    identity.require_missing().await.unwrap();
    assert_eq!(
        host.install(identity, "synthetic-attempt", &handle)
            .await
            .err()
            .as_deref(),
        Some(CANCELED)
    );
}

#[tokio::test]
async fn pending_backup_reseals_when_the_authenticated_recipient_rotates() {
    for change_key in [false, true] {
        let service = Service::new().await;
        let directory = tempfile::tempdir().unwrap();
        let host = service.host(directory.path());
        service.enable(&host).await;
        service.state.lock().unwrap().upload_status = 503;
        assert!(host
            .backup(&IdentityHost::fixture(), &service.session(), 0)
            .await
            .is_err());
        {
            let mut state = service.state.lock().unwrap();
            if change_key {
                let fixture: serde_json::Value =
                    serde_json::from_str(include_str!("fixtures/hpke_nsec_backup_v1.json"))
                        .unwrap();
                state.recipient_key = Some(fixture["envelope"]["enc"].as_str().unwrap().into());
            } else {
                state.recipient_id = "backup-key-rotated".into();
            }
            state.upload_status = 200;
        }
        let restarted = service.host(directory.path());
        restarted
            .backup(&IdentityHost::fixture(), &service.session(), 0)
            .await
            .unwrap();
        restarted
            .backup(&IdentityHost::fixture(), &service.session(), 0)
            .await
            .unwrap();
        let state = service.state.lock().unwrap();
        assert_eq!(state.uploads.len(), 2);
        let old: serde_json::Value = serde_json::from_slice(&state.uploads[0]).unwrap();
        let new: serde_json::Value = serde_json::from_slice(&state.uploads[1]).unwrap();
        assert_ne!(old["backup_id"], new["backup_id"]);
        assert_ne!(old["ciphertext"], new["ciphertext"]);
        assert_eq!(new["recipient_key_id"], state.recipient_id);
        assert_eq!(new["owner_id"], old["owner_id"]);
        assert_eq!(new["nostr_pubkey"], old["nostr_pubkey"]);
        assert_eq!(state.requests["/v1/buzz/nsec-backups/enrollment"], 2);
    }
}

#[test]
fn signing_out_the_latest_source_retains_the_other_sources_session() {
    let host = NsecBackupHost {
        federated: None,
        state: Default::default(),
        root: None,
        config: Arc::new(Some(Config {
            service_url: "https://app.builderlab.xyz/api/goose".into(),
            namespace: "backup/staging".into(),
        })),
    };
    // Start with an admitted secondary session, independent of optional build origins.
    host.state.lock().unwrap().sessions.push(Session {
        source: Source::Builderlab,
        auth: Auth::Credential(Zeroizing::new("synthetic-builderlab-session".into())),
    });
    host.session(
        Source::Hosted,
        1,
        Some("synthetic-hosted-session".into()),
        IdentityHost::fixture(),
    )
    .unwrap();
    host.session(Source::Hosted, 2, None, IdentityHost::fixture())
        .unwrap();
    assert!(host
        .state
        .lock()
        .unwrap()
        .sessions
        .last()
        .is_some_and(|s| s.source == Source::Builderlab));
    host.session(
        Source::Hosted,
        3,
        Some("synthetic-hosted-session".into()),
        IdentityHost::fixture(),
    )
    .unwrap();
    host.retry(Source::Builderlab, IdentityHost::fixture());
    let epoch = host.state.lock().unwrap().epoch;
    host.session(Source::Hosted, 4, None, IdentityHost::fixture())
        .unwrap();
    assert!(host.valid(epoch).is_ok());
    assert!(host
        .state
        .lock()
        .unwrap()
        .sessions
        .last()
        .is_some_and(|s| s.source == Source::Builderlab
            && matches!(&s.auth, Auth::Credential(c) if c.as_str() == "synthetic-builderlab-session")));
}

#[tokio::test]
async fn login_session_changes_leave_recovery_and_selected_installation_alive() {
    for during_install in [false, true] {
        let service = Service::new().await;
        let directory = tempfile::tempdir().unwrap();
        let host = service.host(directory.path());
        // Admit normal source events on the configured origin; HTTP stays on the loopback fixture.
        let login = NsecBackupHost {
            federated: None,
            state: host.state.clone(),
            root: None,
            config: Arc::new(Some(Config {
                service_url: "https://app.builderlab.xyz/api/goose".into(),
                namespace: "backup/staging".into(),
            })),
        };
        let identity = crate::identity::tests::missing_fixture();
        if during_install {
            let recovered = recover_with(&service, &host).await.unwrap();
            service.pause_current.store(true, Ordering::SeqCst);
            let installing = host.install(
                identity.clone(),
                "synthetic-attempt",
                &recovered.candidates[0].handle,
            );
            tokio::pin!(installing);
            tokio::select! {
                _ = service.upload_started.notified() => {},
                _ = &mut installing => panic!("install completed before the fixture released it"),
            }
            let changed = login.session(
                Source::Hosted,
                1,
                Some("synthetic-plugin-session".into()),
                identity.clone(),
            );
            service.release_upload.add_permits(1);
            changed.unwrap();
            assert_eq!(installing.await.unwrap(), pubkey([1; 32]));
            assert_eq!(identity.viewer().await.unwrap(), pubkey([1; 32]));
            let state = host.state.lock().unwrap();
            assert_eq!(state.sessions.len(), 1);
            assert!(matches!(
                &state.sessions[0].auth,
                Auth::Credential(c) if c.as_str() == "synthetic-plugin-session"
            ));
        } else {
            service.pause_upload.store(true, Ordering::SeqCst);
            let recovering = recover_with(&service, &host);
            tokio::pin!(recovering);
            tokio::select! {
                _ = service.upload_started.notified() => {},
                _ = &mut recovering => panic!("recovery completed before the fixture released it"),
            }
            let changes: Vec<_> = [
                (1, Some("synthetic-plugin-session".into())),
                (2, None),
                (3, Some("synthetic-refreshed-session".into())),
            ]
            .into_iter()
            .map(|(generation, credential)| {
                login.session(Source::Hosted, generation, credential, identity.clone())
            })
            .collect();
            service.release_upload.add_permits(1);
            for changed in changes {
                changed.unwrap();
            }
            assert_eq!(recovering.await.unwrap().candidates.len(), 1);
            host.cancel("synthetic-attempt");
        }
    }
}

/// Watch statuses as the renderer does. An undelivered channel records each send
/// and fails it, like a reloaded page's.
fn record(host: &NsecBackupHost, delivered: bool) -> Arc<Mutex<Vec<serde_json::Value>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let output = seen.clone();
    host.watch(Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            output
                .lock()
                .unwrap()
                .push(serde_json::from_str(&json).unwrap());
        }
        if delivered {
            Ok(())
        } else {
            Err(tauri::Error::WebviewNotFound)
        }
    }));
    seen
}
/// Each message as `"<pass> <status>"`, with `:<reason>` or `:<kind>` when present.
fn statuses(seen: &Mutex<Vec<serde_json::Value>>) -> Vec<String> {
    seen.lock()
        .unwrap()
        .iter()
        .map(|status| {
            let name = status["status"].as_str().unwrap();
            let pass = status["pass"].as_u64().unwrap();
            match status.get("reason").or(status.get("kind")) {
                Some(detail) => format!("{pass} {name}:{}", detail.as_str().unwrap()),
                None => format!("{pass} {name}"),
            }
        })
        .collect()
}
fn worker(host: &NsecBackupHost) -> tokio::task::AbortHandle {
    host.state
        .lock()
        .unwrap()
        .worker
        .as_ref()
        .unwrap()
        .inner()
        .abort_handle()
}
async fn retired(worker: &tokio::task::AbortHandle) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !worker.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
/// A pass that stops before uploading fails here with what it reported, not a hang.
async fn upload_started(service: &Service, seen: &Mutex<Vec<serde_json::Value>>) {
    let started = service.upload_started.notified();
    if tokio::time::timeout(Duration::from_secs(5), started)
        .await
        .is_err()
    {
        panic!("No upload started; the pass reported {:?}", statuses(seen));
    }
}
fn production() -> Arc<Option<Config>> {
    Arc::new(Some(Config {
        service_url: "https://app.builderlab.xyz/api/goose".into(),
        namespace: "backup/staging".into(),
    }))
}

#[tokio::test]
async fn a_pass_publishes_running_then_its_outcome_under_the_returned_ticket() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    let seen = record(&host, true);
    service.enable(&host).await;
    host.state.lock().unwrap().sessions.push(service.session());
    assert_eq!(host.trigger(IdentityHost::fixture()), Some(1));
    finish_background(&host).await;
    assert_eq!(statuses(&seen), ["1 running", "1 complete"]);
    let messages = seen.lock().unwrap().clone();
    assert!(messages[0]["seq"].as_u64() < messages[1]["seq"].as_u64());
    assert_eq!(serde_json::to_value(host.status()).unwrap(), messages[1]);
    // A later wake finds the record complete and uploads nothing more.
    assert_eq!(host.trigger(IdentityHost::fixture()), Some(2));
    finish_background(&host).await;
    assert_eq!(
        statuses(&seen),
        ["1 running", "1 complete", "2 running", "2 complete"]
    );
    let messages = seen.lock().unwrap().clone();
    assert!(messages
        .windows(2)
        .all(|pair| pair[0]["seq"].as_u64() < pair[1]["seq"].as_u64()));
    assert_eq!(service.state.lock().unwrap().uploads.len(), 1);
}

#[tokio::test]
async fn each_stopped_pass_publishes_its_waiting_reason_or_failure_kind() {
    type Knob = fn(&mut FixtureState);
    let cases: [(Knob, &str); 24] = [
        (|s| s.mapping = None, "waiting:not_linked"),
        (
            |s| s.mapping = Some(pubkey([2; 32])),
            "failed:other_key_linked",
        ),
        (|s| s.mapping_status = 500, "failed:unreachable"),
        // kgoose's answer to an expired, revoked or unknown session credential.
        (|s| s.me_status = 401, "failed:signed_out"),
        (|s| s.mapping_status = 401, "failed:signed_out"),
        // A session `me` accepts but this device's clock has already expired.
        (
            |s| s.expires_at = "2000-01-01T00:00:00Z".into(),
            "failed:signed_out",
        ),
        // A missing capability or USER role on `current`, which no retry or
        // sign-in changes; kgoose's own refusal for the role is `unauthorized`.
        (|s| s.mapping_status = 403, "failed:not_offered"),
        (
            |s| {
                s.mapping_status = 403;
                s.mapping_body = Some(serde_json::json!({
                    "error": {"code": "unauthorized", "message": "synthetic"},
                    "correlation_id": "synthetic-correlation",
                }));
            },
            "failed:not_offered",
        ),
        // Every other status stays unreachable.
        (|s| s.me_status = 500, "failed:unreachable"),
        (|s| s.enrollment_status = 409, "waiting:not_linked"),
        (|s| s.enrollment_status = 403, "failed:not_offered"),
        (|s| s.enrollment_status = 404, "failed:not_offered"),
        (|s| s.enrollment_status = 401, "failed:signed_out"),
        (|s| s.enrollment_status = 503, "failed:unreachable"),
        (
            |s| s.recipient_key = Some("malformed".into()),
            "failed:invalid_service",
        ),
        (
            |s| s.namespace = "backup/other".into(),
            "failed:invalid_service",
        ),
        (|s| s.upload_status = 400, "failed:refused"),
        (|s| s.upload_status = 409, "failed:refused"),
        (|s| s.upload_status = 413, "failed:refused"),
        (|s| s.upload_status = 403, "failed:other_key_linked"),
        (|s| s.upload_status = 404, "failed:not_offered"),
        (|s| s.upload_status = 503, "failed:unreachable"),
        (|s| s.receipt_matches = false, "failed:unconfirmed"),
        (|s| s.receipt_stored = false, "failed:unconfirmed"),
    ];
    for (index, (knob, expected)) in cases.into_iter().enumerate() {
        let service = Service::new().await;
        let directory = tempfile::tempdir().unwrap();
        let host = service.host(directory.path());
        let seen = record(&host, true);
        service.enable(&host).await;
        knob(&mut service.state.lock().unwrap());
        host.state.lock().unwrap().sessions.push(service.session());
        host.trigger(IdentityHost::fixture());
        finish_background(&host).await;
        assert_eq!(
            statuses(&seen),
            ["1 running".to_owned(), format!("1 {expected}")],
            "case {index}"
        );
    }
    // Another app copy holding the consent lock is `busy`, not a storage failure.
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    service.enable(&host).await;
    let lock = std::fs::OpenOptions::new()
        .write(true)
        .open(directory.path().join("choice.lock"))
        .unwrap();
    fs2::FileExt::try_lock_exclusive(&lock).unwrap();
    assert_eq!(
        host.backup(&IdentityHost::fixture(), &service.session(), 0)
            .await,
        Err(Stop::Failed(Failure::Busy))
    );
    // Only a confirmed absent key is idle; a key that cannot be read is storage.
    for (identity, expected) in [
        (IdentityHost::fixture_without_key(true), Ok(Outcome::Idle)),
        (
            IdentityHost::fixture_without_key(false),
            Err(Stop::Failed(Failure::Storage)),
        ),
    ] {
        assert_eq!(
            host.backup(&identity, &service.session(), 0).await,
            expected
        );
    }
    assert!(service.state.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn wakes_during_a_pass_queue_one_rerun_whose_pass_covers_their_tickets() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    let seen = record(&host, true);
    let identity = IdentityHost::fixture();
    service.enable(&host).await;
    service.pause_upload.store(true, Ordering::SeqCst);
    host.state.lock().unwrap().sessions.push(service.session());
    assert_eq!(host.trigger(identity.clone()), Some(1));
    upload_started(&service, &seen).await;
    assert_eq!(host.trigger(identity.clone()), Some(2));
    assert_eq!(host.retry(Source::Hosted, identity), Some(3));
    service.pause_upload.store(false, Ordering::SeqCst);
    service.release_upload.add_permits(1);
    finish_background(&host).await;
    assert_eq!(
        statuses(&seen),
        ["1 running", "1 complete", "3 running", "3 complete"]
    );
    assert_eq!(service.state.lock().unwrap().uploads.len(), 1);
}

#[tokio::test]
async fn a_key_install_supersedes_a_pass_that_then_reports_nothing() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    let seen = record(&host, true);
    service.enable(&host).await;
    service.pause_upload.store(true, Ordering::SeqCst);
    host.state.lock().unwrap().sessions.push(service.session());
    host.trigger(IdentityHost::fixture());
    upload_started(&service, &seen).await;
    let first = worker(&host);
    // Hold the next pass until the retired one has released its record lock.
    service.pause_current.store(true, Ordering::SeqCst);
    host.local_key_installed(IdentityHost::fixture());
    retired(&first).await;
    upload_started(&service, &seen).await;
    service.pause_current.store(false, Ordering::SeqCst);
    service.pause_upload.store(false, Ordering::SeqCst);
    service.release_upload.add_permits(2);
    finish_background(&host).await;
    assert_eq!(statuses(&seen), ["1 running", "2 running", "2 complete"]);
}

#[tokio::test]
async fn a_null_handoff_reports_no_session_only_for_a_running_pass() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    // Admit hosted handoffs on the production origin; HTTP stays on the loopback fixture.
    let login = NsecBackupHost {
        federated: None,
        state: host.state.clone(),
        root: Some(directory.path().to_owned()),
        config: production(),
    };
    let seen = record(&host, true);
    service.enable(&host).await;
    service.pause_upload.store(true, Ordering::SeqCst);
    host.state.lock().unwrap().sessions.push(service.session());
    host.trigger(IdentityHost::fixture());
    upload_started(&service, &seen).await;
    let first = worker(&host);
    // A wake during the pass holds a rerun ticket, which the retirement settles.
    assert_eq!(host.trigger(IdentityHost::fixture()), Some(2));
    assert_eq!(
        login.session(Source::Hosted, 1, None, IdentityHost::fixture()),
        Ok(None)
    );
    retired(&first).await;
    assert_eq!(statuses(&seen), ["1 running", "2 waiting:no_session"]);
    service.pause_upload.store(false, Ordering::SeqCst);
    service.release_upload.add_permits(1);
    host.state.lock().unwrap().sessions.push(service.session());
    host.trigger(IdentityHost::fixture());
    finish_background(&host).await;
    assert_eq!(
        login.session(Source::Hosted, 2, None, IdentityHost::fixture()),
        Ok(None)
    );
    assert_eq!(
        statuses(&seen),
        [
            "1 running",
            "2 waiting:no_session",
            "3 running",
            "3 complete"
        ]
    );
}

#[tokio::test]
async fn a_null_handoff_ends_a_consent_wait_as_no_session() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    // Admit hosted handoffs on the production origin; no request is sent.
    let host = NsecBackupHost {
        config: production(),
        ..service.host(directory.path())
    };
    let seen = record(&host, true);
    let credential = Some("synthetic-session".to_owned());
    assert_eq!(
        host.session(Source::Hosted, 1, credential, IdentityHost::fixture()),
        Ok(Some(1))
    );
    finish_background(&host).await;
    // Signing out leaves nothing to consent for.
    assert_eq!(
        host.session(Source::Hosted, 2, None, IdentityHost::fixture()),
        Ok(None)
    );
    assert_eq!(
        statuses(&seen),
        ["1 running", "1 waiting:no_consent", "1 waiting:no_session"]
    );
    assert!(service.state.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn a_document_load_mid_pass_or_consent_wait_reports_idle_and_the_new_watcher_sees_later_passes(
) {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    // The reloaded document holds no session, so nothing is waiting for its consent.
    let waiting = record(&host, true);
    host.state.lock().unwrap().sessions.push(service.session());
    host.trigger(IdentityHost::fixture());
    finish_background(&host).await;
    host.document_load();
    assert_eq!(
        statuses(&waiting),
        ["1 running", "1 waiting:no_consent", "1 idle"]
    );
    let stale = record(&host, false);
    service.enable(&host).await;
    service.pause_upload.store(true, Ordering::SeqCst);
    host.state.lock().unwrap().sessions.push(service.session());
    host.trigger(IdentityHost::fixture());
    upload_started(&service, &stale).await;
    let first = worker(&host);
    host.document_load();
    retired(&first).await;
    assert_eq!(statuses(&stale), ["2 running", "2 idle"]);
    let current = record(&host, true);
    service.pause_upload.store(false, Ordering::SeqCst);
    service.release_upload.add_permits(1);
    host.state.lock().unwrap().sessions.push(service.session());
    host.trigger(IdentityHost::fixture());
    finish_background(&host).await;
    assert_eq!(statuses(&stale).len(), 2);
    assert_eq!(statuses(&current), ["3 running", "3 complete"]);
}

#[tokio::test]
async fn a_pass_without_consent_waits_without_a_request() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    let seen = record(&host, true);
    host.state.lock().unwrap().sessions.push(service.session());
    assert_eq!(host.trigger(IdentityHost::fixture()), Some(1));
    finish_background(&host).await;
    assert_eq!(statuses(&seen), ["1 running", "1 waiting:no_consent"]);
    assert!(service.state.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn an_unlinked_pass_waits_until_a_retry_after_binding_completes_it() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    let seen = record(&host, true);
    service.enable(&host).await;
    service.state.lock().unwrap().mapping = None;
    host.state.lock().unwrap().sessions.push(service.session());
    host.trigger(IdentityHost::fixture());
    finish_background(&host).await;
    assert_eq!(statuses(&seen), ["1 running", "1 waiting:not_linked"]);
    service.state.lock().unwrap().mapping = Some(pubkey([1; 32]));
    assert_eq!(host.retry(Source::Hosted, IdentityHost::fixture()), Some(2));
    finish_background(&host).await;
    assert_eq!(
        statuses(&seen),
        [
            "1 running",
            "1 waiting:not_linked",
            "2 running",
            "2 complete"
        ]
    );
    assert_eq!(service.state.lock().unwrap().uploads.len(), 1);
}

#[tokio::test]
async fn handoffs_and_retries_return_a_ticket_only_when_a_pass_will_start() {
    // No consent is saved, so admitted passes stop before any request.
    let directory = tempfile::tempdir().unwrap();
    let host = NsecBackupHost {
        federated: None,
        state: Default::default(),
        root: Some(directory.path().to_owned()),
        config: production(),
    };
    let foreign = NsecBackupHost {
        federated: None,
        state: Default::default(),
        root: Some(directory.path().to_owned()),
        config: Arc::new(Some(Config {
            service_url: "https://backup.example/api/goose".into(),
            namespace: "backup/staging".into(),
        })),
    };
    let identity = IdentityHost::fixture();
    let credential = || Some("synthetic-session".to_owned());
    assert_eq!(host.retry(Source::Hosted, identity.clone()), None);
    assert_eq!(
        host.session(Source::Hosted, 1, None, identity.clone()),
        Ok(None)
    );
    assert_eq!(
        host.session(Source::Hosted, 2, credential(), identity.clone()),
        Ok(Some(1))
    );
    assert_eq!(
        host.session(Source::Hosted, 2, credential(), identity.clone()),
        Ok(None)
    );
    assert_eq!(host.retry(Source::Hosted, identity.clone()), Some(2));
    assert_eq!(
        foreign.session(Source::Hosted, 3, credential(), identity.clone()),
        Ok(None)
    );
    finish_background(&host).await;
    assert_eq!(
        host.session(Source::Hosted, 4, None, identity.clone()),
        Ok(None)
    );
    host.close();
    assert_eq!(
        host.session(Source::Hosted, 5, credential(), identity.clone()),
        Ok(None)
    );
    assert_eq!(host.retry(Source::Hosted, identity), None);
    assert_eq!(host.status().pass, 2);
}

fn signed_in() -> (FederatedIdentity, String) {
    let fi = crate::federated_identity::testing::signed_in(
        "http://127.0.0.1:1".into(),
        "wss://relay.example",
        false,
    );
    let revision = fi
        .with_session(|_, revision, _| revision.to_owned())
        .unwrap();
    (fi, revision)
}

#[tokio::test]
async fn a_federated_session_sends_the_current_fi_token_as_bearer_only() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let (fi, revision) = signed_in();
    let host = NsecBackupHost {
        federated: Some(fi),
        ..service.host(directory.path())
    };
    service.enable(&host).await;
    let session = Session {
        source: Source::Builderlab,
        auth: Auth::Federated(revision),
    };
    // The fixture rejects any request without the Bearer token or with the legacy header.
    assert_eq!(
        host.backup(&IdentityHost::fixture(), &session, 0).await,
        Ok(Outcome::Complete)
    );
    let requests = service.state.lock().unwrap().requests.clone();
    for path in [
        "/v1/auth/me",
        "/v1/buzz/nostr-identities/current",
        "/v1/buzz/nsec-backups/enrollment",
        "/v1/buzz/nsec-backups",
    ] {
        assert_eq!(requests[path], 1, "{path}");
    }
}

#[tokio::test]
async fn a_federated_session_is_signed_out_once_its_revision_is_not_current() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    for change in [
        FederatedIdentity::sign_out_for_test as fn(&FederatedIdentity),
        FederatedIdentity::switch_account_for_test,
    ] {
        let (fi, revision) = signed_in();
        let host = NsecBackupHost {
            federated: Some(fi.clone()),
            ..service.host(directory.path())
        };
        service.enable(&host).await;
        change(&fi);
        let session = Session {
            source: Source::Builderlab,
            auth: Auth::Federated(revision),
        };
        assert_eq!(
            host.backup(&IdentityHost::fixture(), &session, 0).await,
            Err(Stop::Failed(Failure::SignedOut))
        );
        assert!(service.state.lock().unwrap().requests.is_empty());
    }
    // A host without FI can never resolve a federated session.
    let host = service.host(directory.path());
    let session = Session {
        source: Source::Builderlab,
        auth: Auth::Federated("revision".into()),
    };
    assert_eq!(
        host.backup(&IdentityHost::fixture(), &session, 0).await,
        Err(Stop::Failed(Failure::SignedOut))
    );
}

#[tokio::test]
async fn a_native_sign_out_mid_pass_stops_the_next_federated_request() {
    for (paused, next) in [
        ("/v1/auth/me", "/v1/buzz/nostr-identities/current"),
        ("/v1/buzz/nsec-backups/enrollment", "/v1/buzz/nsec-backups"),
    ] {
        let service = Service::new().await;
        let directory = tempfile::tempdir().unwrap();
        let (fi, revision) = signed_in();
        let host = NsecBackupHost {
            federated: Some(fi.clone()),
            ..service.host(directory.path())
        };
        service.enable(&host).await;
        service.state.lock().unwrap().pause_path = Some(paused);
        let session = Session {
            source: Source::Builderlab,
            auth: Auth::Federated(revision),
        };
        let pass =
            tokio::spawn(async move { host.backup(&IdentityHost::fixture(), &session, 0).await });
        service.upload_started.notified().await;
        // No renderer handoff: only the native session changes.
        fi.sign_out_for_test();
        service.release_upload.add_permits(1);
        assert_eq!(
            pass.await.unwrap(),
            Err(Stop::Failed(Failure::SignedOut)),
            "{paused}"
        );
        assert!(
            !service.state.lock().unwrap().requests.contains_key(next),
            "{next}"
        );
    }
}

#[test]
fn a_federated_handoff_stores_only_the_revision_and_requires_the_current_one() {
    if buzzodz_plugins::BUILDERLAB_ORIGIN.is_empty() {
        return;
    }
    let granted = format!(
        "{}{}",
        buzzodz_plugins::BUILDERLAB_ORIGIN,
        buzzodz_plugins::BUILDERLAB_API_BASE_PATH.trim_end_matches('/')
    );
    let (fi, revision) = signed_in();
    let host = |federated| NsecBackupHost {
        federated,
        state: Default::default(),
        root: None,
        config: Arc::new(Some(Config {
            service_url: granted.clone(),
            namespace: "backup/staging".into(),
        })),
    };
    let identity = IdentityHost::fixture();
    let federated = host(Some(fi.clone()));
    let handoff = |host: &NsecBackupHost, generation, source, credential, federated| {
        host.session_from_ipc(source, generation, credential, federated, identity.clone())
    };
    // Stale revisions, both and an FI-less host are refused without consuming
    // the generation.
    for (host, source, credential, revision) in [
        (&federated, Source::Builderlab, None, "stale".to_owned()),
        (
            &federated,
            Source::Builderlab,
            Some("synthetic-session".to_owned()),
            revision.clone(),
        ),
        (&host(None), Source::Builderlab, None, revision.clone()),
    ] {
        assert_eq!(
            handoff(host, 1, source, credential, Some(revision)),
            Err("Invalid backup session".into())
        );
        assert!(host.state.lock().unwrap().sessions.is_empty());
        assert_eq!(host.state.lock().unwrap().generations, [None, None]);
    }
    // FI is Builderlab's alone: an admitted Hosted service refuses it. A
    // service other than the FI identity root is ignored before that, so the
    // adapter session never reaches another deployment.
    let serving = |service_url: &str| NsecBackupHost {
        config: Arc::new(Some(Config {
            service_url: service_url.into(),
            namespace: "backup/staging".into(),
        })),
        ..host(Some(fi.clone()))
    };
    for (service_url, source, expected) in [
        (
            "https://app.builderlab.xyz/api/goose",
            Source::Hosted,
            Err("Invalid backup session".into()),
        ),
        ("https://other.example/api/goose", Source::Hosted, Ok(None)),
        (
            "https://other.example/api/goose",
            Source::Builderlab,
            Ok(None),
        ),
    ] {
        let host = serving(service_url);
        assert_eq!(
            handoff(&host, 1, source, None, Some(revision.clone())),
            expected,
            "{service_url}"
        );
        assert!(host.state.lock().unwrap().sessions.is_empty());
        assert_eq!(host.state.lock().unwrap().generations, [None, None]);
    }
    assert_eq!(
        handoff(
            &federated,
            1,
            Source::Builderlab,
            None,
            Some(revision.clone())
        ),
        Ok(None)
    );
    let state = federated.state.lock().unwrap();
    assert!(matches!(
        state.sessions.as_slice(),
        [Session { source: Source::Builderlab, auth: Auth::Federated(stored) }] if *stored == revision
    ));
    drop(state);
    // A null handoff retires it, as for a credential.
    assert_eq!(
        handoff(&federated, 2, Source::Builderlab, None, None),
        Ok(None)
    );
    assert!(federated.state.lock().unwrap().sessions.is_empty());
}

#[test]
fn the_legacy_handoff_shape_is_unchanged() {
    let host = NsecBackupHost {
        federated: None,
        state: Default::default(),
        root: None,
        config: production(),
    };
    let identity = IdentityHost::fixture();
    assert_eq!(
        host.session_from_ipc(
            Source::Hosted,
            1,
            Some("synthetic-session".into()),
            None,
            identity.clone()
        ),
        Ok(None)
    );
    assert!(matches!(
        host.state.lock().unwrap().sessions.as_slice(),
        [Session { auth: Auth::Credential(c), .. }] if c.as_str() == "synthetic-session"
    ));
    assert_eq!(
        host.session_from_ipc(Source::Hosted, 2, None, None, identity.clone()),
        Ok(None)
    );
    assert!(host.state.lock().unwrap().sessions.is_empty());
    assert_eq!(
        host.session_from_ipc(Source::Hosted, 3, Some("not valid".into()), None, identity),
        Err("Invalid backup session".into())
    );
}

#[test]
fn statuses_serialize_flat_and_report_whether_builderlab_backup_can_run() {
    let status = |progress| {
        serde_json::to_value(BackupStatus {
            seq: 7,
            pass: 3,
            builderlab: true,
            progress,
        })
        .unwrap()
    };
    let wire = |fields: serde_json::Value| {
        let mut value = serde_json::json!({"seq":7,"pass":3,"builderlab":true});
        value
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        value
    };
    for (progress, name) in [
        (Progress::Idle, "idle"),
        (Progress::Running, "running"),
        (Progress::Complete, "complete"),
    ] {
        assert_eq!(status(progress), wire(serde_json::json!({"status":name})));
    }
    for (reason, name) in [
        (Waiting::NoConsent, "no_consent"),
        (Waiting::NoSession, "no_session"),
        (Waiting::NotLinked, "not_linked"),
    ] {
        assert_eq!(
            status(Progress::Waiting { reason }),
            wire(serde_json::json!({"status":"waiting","reason":name}))
        );
    }
    for (kind, name) in [
        (Failure::Busy, "busy"),
        (Failure::SignedOut, "signed_out"),
        (Failure::NotOffered, "not_offered"),
        (Failure::OtherKeyLinked, "other_key_linked"),
        (Failure::InvalidService, "invalid_service"),
        (Failure::Refused, "refused"),
        (Failure::Unreachable, "unreachable"),
        (Failure::Unconfirmed, "unconfirmed"),
        (Failure::Storage, "storage"),
    ] {
        assert_eq!(
            status(Progress::Failed { kind }),
            wire(serde_json::json!({"status":"failed","kind":name}))
        );
    }
    let directory = tempfile::tempdir().unwrap();
    let granted = format!(
        "{}{}",
        buzzodz_plugins::BUILDERLAB_ORIGIN,
        buzzodz_plugins::BUILDERLAB_API_BASE_PATH.trim_end_matches('/')
    );
    for (root, service_url, builderlab) in [
        (None, granted.as_str(), false),
        (
            Some(directory.path()),
            "https://backup.example/api/goose",
            false,
        ),
        (
            Some(directory.path()),
            granted.as_str(),
            !buzzodz_plugins::BUILDERLAB_ORIGIN.is_empty(),
        ),
    ] {
        let host = NsecBackupHost {
            federated: None,
            state: Default::default(),
            root: root.map(ToOwned::to_owned),
            config: Arc::new(Some(Config {
                service_url: service_url.into(),
                namespace: "backup/staging".into(),
            })),
        };
        assert_eq!(
            serde_json::to_value(host.status()).unwrap(),
            serde_json::json!({"seq":0,"pass":0,"builderlab":builderlab,"status":"idle"}),
            "{service_url}"
        );
    }
}
