use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[derive(Default)]
pub(super) struct Memory {
    pub(super) raw: Mutex<Option<Zeroizing<Vec<u8>>>>,
    pub(super) compare_gate: Mutex<Option<super::agent::grant::tests::Gate>>,
    /// Holds the next read after it reads the item. `load` reads too.
    read_gate: Mutex<Option<super::agent::grant::tests::Gate>>,
    refusal: Mutex<Option<String>>,
    pub(super) denied: AtomicBool,
    reads: AtomicUsize,
}
impl Store for Memory {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let raw = self.raw.lock().unwrap().clone();
        if let Some((held, release)) = self.read_gate.lock().unwrap().take() {
            held.send(()).unwrap();
            release.recv().unwrap();
        }
        Ok(raw)
    }
    fn compare(
        &self,
        expected: Option<&[u8]>,
        replacement: Option<&[u8]>,
    ) -> Result<(), &'static str> {
        let mut raw = self.raw.lock().unwrap();
        if raw.as_ref().map(|v| v.as_slice()) != expected {
            return Err("session-changed");
        }
        if self.denied.load(Ordering::SeqCst) {
            return Err("storage-denied");
        }
        *raw = replacement.map(|value| Zeroizing::new(value.to_vec()));
        drop(raw);
        if let Some((held, release)) = self.compare_gate.lock().unwrap().take() {
            held.send(()).unwrap();
            release.recv().unwrap();
        }
        Ok(())
    }
    fn load(&self) -> Result<store::LoadedRecord, &'static str> {
        Ok((self.read()?, self.refusal.lock().unwrap().clone()))
    }
    fn remove(&self, expected: &[u8], revision: &str) -> Result<(), &'static str> {
        let mut raw = self.raw.lock().unwrap();
        if raw.as_ref().map(|value| value.as_slice()) != Some(expected) {
            return Err("session-changed");
        }
        *self.refusal.lock().unwrap() = Some(revision.into());
        if self.denied.load(Ordering::SeqCst) {
            return Err("storage-denied");
        }
        *raw = None;
        *self.refusal.lock().unwrap() = None;
        Ok(())
    }
}
pub(super) fn host(store: Arc<Memory>) -> FederatedIdentity {
    let config = Config::parse(r#"{"version":1,"id":"test","identityOrigin":"https://identity.example","adapterBase":"https://identity.example","apiBasePath":"/api/","communityHosts":["relay.example"]}"#).unwrap();
    FederatedIdentity::with_store(Some(config), "fingerprint".into(), "account".into(), store)
}
pub(super) fn record() -> Arc<Session> {
    let record = Record {
        version: 1,
        fingerprint: "fingerprint".into(),
        revision: uuid::Uuid::new_v4().to_string(),
        session_token: "fixture-session-token".into(),
        expires_at: "2099-01-01T00:00:00Z".into(),
        email: None,
    };
    let raw = Zeroizing::new(serde_json::to_vec(&record).unwrap());
    Arc::new(Session {
        record,
        raw,
        issued_at: 0,
    })
}

#[test]
fn each_community_routes_by_host_to_its_own_server() {
    let servers = config::compiled(
        Some(r#"{"version":1,"id":"bb-acme","identityOrigin":"https://acme.builderlab.xyz","communityHosts":["buzz.acme.builderlab.xyz"],"adapterBase":"https://acme.builderlab.xyz/api/goose","apiBasePath":"/api/goose/"}"#),
        None,
        None,
    )
    .unwrap();
    let server = |config: Config| {
        FederatedIdentity::with_store(
            Some(config),
            String::new(),
            String::new(),
            Arc::new(Memory::default()),
        )
    };
    let mut servers = servers.into_iter();
    let first = servers.next().unwrap();
    let public = server(servers.next().unwrap());
    let first = FederatedIdentity::build(
        Some(first),
        String::new(),
        String::new(),
        Arc::new(Memory::default()),
        vec![public.clone()],
        None,
    );
    let id = |relay: &str| {
        first
            .server_for(relay)
            .unwrap()
            .0
            .config
            .as_ref()
            .unwrap()
            .id
            .clone()
    };
    assert_eq!(id("wss://buzz.acme.builderlab.xyz"), "bb-acme");
    assert_eq!(id("wss://team.communities.buzz.xyz"), "bb-public");
    assert!(first
        .server_for("wss://team.communities.buzz.xyz")
        .unwrap()
        .is(&public));
    // A community no server covers stays with the first, which attaches no token.
    assert_eq!(id("wss://relay.example"), "bb-acme");
    assert_eq!(
        first
            .server_for_command(Some("https://Team.communities.buzz.xyz"), None)
            .unwrap()
            .0
            .config
            .as_ref()
            .unwrap()
            .id,
        "bb-public"
    );
    assert!(first.server_for_command(None, None).unwrap().is(&first));
    // Settings names a server by id: each signs out on its own.
    assert!(first
        .server_for_command(None, Some("bb-public"))
        .unwrap()
        .is(&public));
    assert!(first
        .server_for_command(None, Some("bb-acme"))
        .unwrap()
        .is(&first));
    assert!(first.server_for_command(None, Some("other")).is_err());
    assert_eq!(
        first
            .servers()
            .iter()
            .map(|server| server.0.config.as_ref().unwrap().id.as_str())
            .collect::<Vec<_>>(),
        ["bb-acme", "bb-public"]
    );
}

/// The build's first server, with `peers`, adding Builderlab customers'
/// servers when `customers`, without listing them.
pub(super) fn with_customers(
    first: Config,
    peers: Vec<FederatedIdentity>,
    customers: bool,
) -> FederatedIdentity {
    customers_listed_in(first, peers, customers.then_some(None))
}
/// The build's first server, adding Builderlab customers' servers when
/// `customers`, listed in its file if it has one.
pub(super) fn customers_listed_in(
    first: Config,
    peers: Vec<FederatedIdentity>,
    customers: Option<Option<std::path::PathBuf>>,
) -> FederatedIdentity {
    FederatedIdentity::build(
        Some(first),
        String::new(),
        String::new(),
        Arc::new(Memory::default()),
        peers,
        customers.map(|record| Customers {
            profile: "default".into(),
            record,
        }),
    )
}

#[test]
fn a_builderlab_customer_gets_its_own_server_unless_a_compiled_one_covers_it() {
    let mut servers = config::compiled(
        Some(r#"[{"version":1,"id":"bb-acme","identityOrigin":"https://acme.builderlab.xyz","communityHosts":["buzz.acme.builderlab.xyz"],"adapterBase":"https://acme.builderlab.xyz/api/goose","apiBasePath":"/api/goose/"},{"version":1,"id":"bb-taken","identityOrigin":"https://identity.example","communityHosts":["taken.example"],"adapterBase":"https://identity.example","apiBasePath":"/api/"}]"#),
        None,
        None,
    )
    .unwrap()
    .into_iter();
    let first = servers.next().unwrap();
    let peers: Vec<_> = servers
        .map(|config| {
            FederatedIdentity::with_store(
                Some(config),
                String::new(),
                String::new(),
                Arc::new(Memory::default()),
            )
        })
        .collect();
    let first = with_customers(first, peers, true);
    let prepared = Arc::new(Mutex::new(Vec::new()));
    first.on_peer(Arc::new({
        let prepared = prepared.clone();
        move |server: &FederatedIdentity| {
            prepared
                .lock()
                .unwrap()
                .push(server.config().unwrap().id.clone())
        }
    }));
    let id = |relay: &str| {
        first
            .server_for(relay)
            .unwrap()
            .config()
            .unwrap()
            .id
            .clone()
    };
    // A compiled server wins for its own host.
    assert_eq!(id("wss://buzz.acme.builderlab.xyz"), "bb-acme");
    assert_eq!(id("wss://buzz.other.builderlab.xyz"), "bb-other");
    let other = first.server_for("wss://buzz.other.builderlab.xyz").unwrap();
    assert!(first
        .server_for("https://BUZZ.other.builderlab.xyz:443")
        .unwrap()
        .is(&other));
    assert_eq!(
        other.config().unwrap().endpoint("/v1/session").as_str(),
        "https://other.builderlab.xyz/api/goose/v1/session"
    );
    assert!(first
        .server_for_command(None, Some("bb-other"))
        .unwrap()
        .is(&other));
    // A compiled server's id is never taken over, and other hosts stay unrouted.
    for relay in [
        "wss://buzz.taken.builderlab.xyz",
        "wss://buzz.a.b.builderlab.xyz",
        "wss://buzz.other.builderlab.xyz:8443",
        "wss://app.other.builderlab.xyz",
    ] {
        assert_eq!(id(relay), "bb-acme", "{relay}");
    }
    assert_eq!(
        first
            .servers()
            .iter()
            .map(|server| server.config().unwrap().id.as_str())
            .collect::<Vec<_>>(),
        ["bb-acme", "bb-taken", "bb-public", "bb-other"]
    );
    // Each added server is prepared once, before it is used.
    assert_eq!(*prepared.lock().unwrap(), ["bb-other"]);
    let late = Arc::new(AtomicUsize::new(0));
    first.on_peer(Arc::new({
        let late = late.clone();
        move |_: &FederatedIdentity| {
            late.fetch_add(1, Ordering::SeqCst);
        }
    }));
    assert_eq!(late.load(Ordering::SeqCst), 1);
    // Its saved session is found again after a restart: the same account.
    let restarted = with_customers(
        config::Config::parse(config::BUILT_IN).unwrap(),
        Vec::new(),
        true,
    );
    let account = |server: &FederatedIdentity, relay: &str| {
        server.server_for(relay).unwrap().0.account.clone()
    };
    assert_eq!(
        account(&restarted, "wss://buzz.other.builderlab.xyz"),
        other.0.account
    );
    assert_ne!(
        account(&restarted, "wss://buzz.third.builderlab.xyz"),
        other.0.account
    );
    // Closing closes them, and adds no more.
    first.close();
    assert!(other.closed());
    assert!(first
        .server_for("wss://buzz.fourth.builderlab.xyz")
        .unwrap()
        .is(&first));
    // Without the built-in server there are no customers' servers.
    let without = with_customers(
        config::Config::parse(config::BUILT_IN).unwrap(),
        Vec::new(),
        false,
    );
    assert!(without
        .server_for("wss://buzz.other.builderlab.xyz")
        .unwrap()
        .is(&without));
}

#[test]
fn a_builderlab_customer_server_is_added_again_at_every_launch() {
    let root = tempfile::tempdir().unwrap();
    let record = root.path().join("first.customers");
    let launch = || {
        customers_listed_in(
            config::Config::parse(config::BUILT_IN).unwrap(),
            Vec::new(),
            Some(Some(record.clone())),
        )
    };
    let ids = |first: &FederatedIdentity| {
        first
            .servers()
            .iter()
            .map(|server| server.config().unwrap().id.clone())
            .collect::<Vec<_>>()
    };
    let first = launch();
    let kept = first.server_for("wss://buzz.kept.builderlab.xyz").unwrap();
    first.server_for("wss://buzz.kept.builderlab.xyz").unwrap();
    assert_eq!(
        std::fs::read_to_string(&record).unwrap(),
        "buzz.kept.builderlab.xyz\n"
    );
    // A later launch adds it before any of its communities is routed, under
    // the same account, without listing it twice.
    let next = launch();
    assert_eq!(ids(&next), ["bb-public", "bb-kept"]);
    let again = next.server_for("wss://buzz.kept.builderlab.xyz").unwrap();
    assert_eq!(again.0.account, kept.0.account);
    assert_eq!(
        std::fs::read_to_string(&record).unwrap(),
        "buzz.kept.builderlab.xyz\n"
    );
    // The list names hosts, never servers: other lines add nothing.
    std::fs::write(
        &record,
        "buzz.kept.builderlab.xyz\nidentity.example\nbuzz.a.b.builderlab.xyz\n\n",
    )
    .unwrap();
    assert_eq!(ids(&launch()), ["bb-public", "bb-kept"]);
    // A server that could not be listed is not used.
    let unlisted = customers_listed_in(
        config::Config::parse(config::BUILT_IN).unwrap(),
        Vec::new(),
        Some(Some(root.path().join("missing").join("\0"))),
    );
    assert!(unlisted
        .server_for("wss://buzz.other.builderlab.xyz")
        .is_err());
    assert_eq!(ids(&unlisted), ["bb-public"]);
    // A full Buzz sign-out deletes the list.
    store::remove_all(root.path().into()).unwrap();
    assert!(!record.exists());
    assert_eq!(ids(&launch()), ["bb-public"]);
}

#[tokio::test]
async fn signing_out_of_one_server_keeps_the_others_session() {
    let mut configs = config::compiled(
        Some(r#"{"version":1,"id":"bb-acme","identityOrigin":"https://acme.builderlab.xyz","communityHosts":["buzz.acme.builderlab.xyz"],"adapterBase":"https://acme.builderlab.xyz/api/goose","apiBasePath":"/api/goose/"}"#),
        None,
        None,
    )
    .unwrap()
    .into_iter();
    let signed_in = |mut config: Config, peers| {
        // Sign-out revokes here, never at Builderlab.
        config.identity_origin = UNREACHABLE.into();
        let store = Arc::new(Memory::default());
        let session = record();
        *store.raw.lock().unwrap() = Some(session.raw.clone());
        let server = FederatedIdentity::build(
            Some(config),
            "fingerprint".into(),
            "account".into(),
            store.clone(),
            peers,
            None,
        );
        {
            let mut state = server.state();
            state.restored = true;
            state.session = Some(session);
            state.snapshot.status = Status::SignedIn;
        }
        (server, store)
    };
    let block = configs.next().unwrap();
    let (public, public_store) = signed_in(configs.next().unwrap(), Vec::new());
    let (first, first_store) = signed_in(block, vec![public.clone()]);
    let snapshot = first
        .server_for_command(None, Some("bb-public"))
        .unwrap()
        .sign_out(None)
        .await;
    assert!(snapshot.status == Status::SignedOut);
    assert!(public_store.raw.lock().unwrap().is_none());
    assert!(first.snapshot().status == Status::SignedIn);
    assert!(first_store.raw.lock().unwrap().is_some());
    // Only that server's session is revoked. Its logout fails, which
    // changes nothing.
    assert_eq!(super::agent::tests::bounded(revoked(&public)).await, 1);
    assert_eq!(revoked(&first).await, 0);
    let snapshot = public.snapshot();
    assert!(snapshot.status == Status::SignedOut);
    assert_eq!(snapshot.failure, None);
}

#[tokio::test]
async fn restored_snapshots_do_not_wait_for_an_interactive_operation() {
    use futures_util::FutureExt;
    let owner = host(Arc::new(Memory::default()));
    {
        let mut state = owner.state();
        state.restored = true;
        state.snapshot.status = Status::SigningIn;
    }
    let operation = owner.0.operation.lock().await;
    let snapshot = owner
        .restore()
        .now_or_never()
        .expect("a restored snapshot must not wait for the browser operation");
    assert!(snapshot.status == Status::SigningIn);
    drop(operation);
}

#[test]
fn a_callback_timeout_keeps_its_own_failure_code() {
    assert_eq!(callback_failure("Sign-in canceled."), "sign-in-canceled");
    assert_eq!(
        callback_failure(crate::oauth_callback::TIMED_OUT),
        "sign-in-timed-out"
    );
    assert_eq!(
        callback_failure("Sign-in listener failed"),
        "callback-refused"
    );
}

#[test]
fn the_login_start_asks_only_for_the_sign_up_screen_and_forced_login_it_was_given() {
    let config = host(Arc::new(Memory::default())).0.config.clone().unwrap();
    let start = "https://identity.example/v1/login/start?handoff_challenge=challenge&handoff_challenge_method=S256";
    for (signup, force_login, hints) in [
        (false, false, ""),
        (true, false, "&screen_hint=signup"),
        (false, true, "&prompt=login"),
        (true, true, "&screen_hint=signup&prompt=login"),
    ] {
        let asked = LoginStart {
            signup,
            force_login,
        };
        assert_eq!(
            login_start(&config, "challenge", asked).as_str(),
            format!("{start}{hints}")
        );
    }
}

#[tokio::test]
async fn cancel_releases_the_native_callback_before_a_replacement_login() {
    let owner = host(Arc::new(Memory::default()));
    let server = owner.0.fingerprint.as_str();
    let callbacks = crate::oauth_callback::OAuthCallbackHost::default();
    let url = "https://identity.example/v1/login/start";
    let attempt = callbacks
        .begin_federated(server, url.into(), |_| Ok(()), None)
        .unwrap();
    // A peer server's sign-in has its own slot and survives this server's cleanup.
    let peer = callbacks
        .begin_federated("peer", url.into(), |_| Ok(()), None)
        .unwrap();
    let guard = CallbackGuard(callbacks.clone(), attempt.id.clone());
    {
        let mut state = owner.state();
        state.restored = true;
        state.snapshot.status = Status::SigningIn;
        state.callback = Some(guard.clone());
    }
    owner.cancel_sign_in();
    let replacement = callbacks
        .begin_federated(server, url.into(), |_| Ok(()), None)
        .unwrap();
    owner.state().callback = Some(CallbackGuard(callbacks.clone(), replacement.id.clone()));
    owner.clear_callback(&attempt.id);
    assert_eq!(owner.state().callback.as_ref().unwrap().1, replacement.id);
    drop(guard); // The old future's cleanup cannot cancel the replacement.
    assert!(callbacks
        .begin_federated(server, url.into(), |_| Ok(()), None)
        .is_err());
    callbacks.cancel(&replacement.id).unwrap();
    let peer_url = url::Url::parse(&peer.callback_url).unwrap();
    let mut stream = tokio::net::TcpStream::connect(peer_url.authority())
        .await
        .unwrap();
    tokio::io::AsyncWriteExt::write_all(
        &mut stream,
        format!(
            "GET {}?code=peer HTTP/1.1\r\nHost: {}\r\n\r\n",
            peer_url.path(),
            peer_url.authority()
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let parameters = callbacks.wait(&peer.id).await.unwrap().parameters;
    assert_eq!(parameters, [("code".to_string(), "peer".to_string())]);
}

#[tokio::test]
async fn concurrent_absent_restore_reads_once_and_never_creates_an_account() {
    let store = Arc::new(Memory::default());
    let host = host(store.clone());
    let (a, b) = tokio::join!(host.restore(), host.restore());
    assert!(a.status == Status::SignedOut && b.status == Status::SignedOut);
    assert_eq!(store.reads.load(Ordering::SeqCst), 1);
    assert!(store.raw.lock().unwrap().is_none());
}

#[tokio::test]
async fn failed_sign_out_refuses_the_record_on_restart_until_deletion_succeeds() {
    let store = Arc::new(Memory::default());
    let session = record();
    *store.raw.lock().unwrap() = Some(session.raw.clone());
    let host = host(store.clone());
    {
        let mut state = host.state();
        state.session = Some(session.clone());
        state.snapshot.status = Status::SignedIn;
        state.restored = true;
    }
    let old_revision = host.snapshot().revision;
    store.denied.store(true, Ordering::SeqCst);
    let signed_out = host.sign_out(None).await;
    assert!(signed_out.status == Status::Unavailable);
    assert_eq!(signed_out.failure, Some("storage-denied"));
    // Settings offers Sign out again for it.
    assert_eq!(serde_json::to_value(&signed_out).unwrap()["cleanup"], true);
    assert!(!host.current(&old_revision));
    assert!(host.state().session.is_none());
    assert_eq!(
        store.refusal.lock().unwrap().as_deref(),
        Some(session.record.revision.as_str())
    );
    let restart = super::tests::host(store.clone());
    assert!(restart.restore().await.status == Status::Unavailable);
    assert!(restart.state().session.is_none());
    store.denied.store(false, Ordering::SeqCst);
    assert!(restart.restore().await.status == Status::SignedOut);
    assert!(store.raw.lock().unwrap().is_none());
    assert!(store.refusal.lock().unwrap().is_none());
}

#[tokio::test]
async fn stale_cleanup_cannot_delete_a_replacement_session() {
    let store = Arc::new(Memory::default());
    let old = record();
    let newer = record();
    *store.raw.lock().unwrap() = Some(newer.raw.clone());
    *store.refusal.lock().unwrap() = Some(newer.record.revision.clone());
    let host = host(store.clone());
    assert_eq!(host.remove(old).await.unwrap_err().code, "session-changed");
    assert_eq!(
        store.raw.lock().unwrap().as_ref().unwrap().as_slice(),
        newer.raw.as_slice()
    );
    assert_eq!(
        store.refusal.lock().unwrap().as_deref(),
        Some(newer.record.revision.as_str())
    );
}

#[tokio::test]
async fn corrupt_storage_is_unavailable_and_public_snapshots_have_no_secret() {
    let store = Arc::new(Memory::default());
    *store.raw.lock().unwrap() = Some(Zeroizing::new(b"not a record".to_vec()));
    let host = host(store.clone());
    let snapshot = host.restore().await;
    assert!(snapshot.status == Status::Unavailable);
    assert_eq!(snapshot.failure, Some("storage-corrupt"));
    assert_eq!(
        store.raw.lock().unwrap().as_ref().unwrap().as_slice(),
        b"not a record"
    );
    let session = record();
    {
        let mut state = host.state();
        state.session = Some(session);
        state.snapshot.status = Status::SignedIn;
    }
    let public = serde_json::to_value(host.snapshot()).unwrap();
    assert_eq!(public.as_object().unwrap().len(), 8);
    assert!(!public.to_string().contains("fixture-session-token"));
}

#[tokio::test]
async fn a_restore_that_fails_upstream_keeps_the_record_and_is_not_an_unfinished_sign_out() {
    let store = Arc::new(Memory::default());
    let session = record();
    *store.raw.lock().unwrap() = Some(session.raw.clone());
    let (base, server) =
        adapter_with_status(vec![(503, serde_json::json!({"error":"unavailable"})); 3]).await;
    let host = at_adapter(store.clone(), base);
    let snapshot = host.restore().await;
    assert!(snapshot.status == Status::Unavailable);
    assert_eq!(snapshot.failure, Some("network-unavailable"));
    // Signing out would delete a session that may still be valid.
    assert_eq!(serde_json::to_value(&snapshot).unwrap()["cleanup"], false);
    assert_eq!(store.raw.lock().unwrap().as_deref(), Some(&*session.raw));
    server.await.unwrap();
}

#[tokio::test]
async fn local_expiry_retires_a_cached_session_without_sending_it_upstream() {
    let store = Arc::new(Memory::default());
    let mut expired = record();
    let session = Arc::get_mut(&mut expired).unwrap();
    session.record.expires_at = "2000-01-01T00:00:00Z".into();
    session.raw = Zeroizing::new(serde_json::to_vec(&session.record).unwrap());
    *store.raw.lock().unwrap() = Some(session.raw.clone());
    let host = host(store.clone());
    {
        let mut state = host.state();
        state.session = Some(expired);
        state.snapshot.status = Status::SignedIn;
        state.restored = true;
    }
    let revision = host.snapshot().revision;
    assert!(host.restore().await.status == Status::ReauthenticationRequired);
    assert!(!host.current(&revision));
    assert!(host.state().session.is_none());
    assert!(store.raw.lock().unwrap().is_none());
    assert_eq!(revoked(&host).await, 0);
}

#[tokio::test]
async fn sign_out_of_buzz_revokes_nothing() {
    let (host, _) = signed_in_at(Arc::default(), UNREACHABLE.into(), "a@example.com");
    // Sign out of Buzz closes every server and removes their records itself.
    host.close();
    assert!(host.snapshot().status == Status::SignedOut);
    assert_eq!(revoked(&host).await, 0);
}

#[tokio::test]
async fn signing_out_revokes_the_session_at_the_server_once_without_waiting() {
    use super::agent::tests::bounded;
    use tokio::io::AsyncWriteExt;
    // Kgoose answers a session's logout with a redirect to its identity
    // provider. Following it would wait on `followed`, which never answers,
    // as a retry would wait on the logout route.
    let followed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let redirect = format!(
        "HTTP/1.1 302 Found\r\nLocation: http://{}/v2/logout\r\nContent-Length: 0\r\n\r\n",
        followed.local_addr().unwrap()
    );
    let failed = "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n".to_owned();
    for reply in [redirect, failed] {
        let logout = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let store = Arc::new(Memory::default());
        let (host, session) = signed_in_at(
            store.clone(),
            format!("http://{}", logout.local_addr().unwrap()),
            "a@example.com",
        );
        // Sign-out returns before the server answers its logout.
        let snapshot = bounded(host.sign_out(None)).await;
        assert!(snapshot.status == Status::SignedOut);
        assert_eq!(snapshot.failure, None);
        assert!(store.raw.lock().unwrap().is_none());
        let (credential, mut stream) = logout_request(&logout).await;
        assert_eq!(credential, session.record.session_token);
        stream.write_all(reply.as_bytes()).await.unwrap();
        assert_eq!(bounded(revoked(&host)).await, 1);
        let snapshot = host.snapshot();
        assert!(snapshot.status == Status::SignedOut);
        assert_eq!(snapshot.failure, None);
    }
}

#[tokio::test]
async fn a_401_recheck_ends_only_a_session_the_adapter_refuses() {
    let (base, server) = adapter_with_status(vec![
        (
            200,
            serde_json::json!({"expires_at":"2099-01-01T00:00:00Z"}),
        ),
        (401, serde_json::json!({"error":"session_expired"})),
    ])
    .await;
    let store = Arc::new(Memory::default());
    let host = at_adapter(store.clone(), base);
    let session = record();
    *store.raw.lock().unwrap() = Some(session.raw.clone());
    {
        let mut state = host.state();
        state.snapshot.revision = session.record.revision.clone();
        state.snapshot.status = Status::SignedIn;
        state.session = Some(session.clone());
        state.restored = true;
    }
    let revision = host.snapshot().revision;
    // A stale revision asks nothing.
    host.recheck("stale").await;
    host.recheck(&revision).await;
    assert!(host.current(&revision));
    assert!(host.snapshot().status == Status::SignedIn);
    host.recheck(&revision).await;
    assert!(!host.current(&revision));
    assert!(host.snapshot().status == Status::ReauthenticationRequired);
    assert!(host.state().session.is_none());
    assert!(store.raw.lock().unwrap().is_none());
    let seen = server.await.unwrap();
    assert_eq!(seen.len(), 2);
    assert!(seen
        .iter()
        .all(|wire| wire.target == "GET /mount/v1/session HTTP/1.1"));
}

#[tokio::test]
async fn account_changes_tell_expiry_and_refresh_from_sign_out_and_a_new_account() {
    let store = Arc::new(Memory::default());
    let host = host(store.clone());
    let changes = host.account_changes();
    let sign_in = |email: &str| {
        let mut state = host.state();
        host.signed_in(&mut state, Some(email.into()));
        changes.borrow().clone()
    };
    assert_eq!(sign_in("a@example.com"), Some(SessionChange::Refreshed));
    assert_eq!(sign_in("a@example.com"), Some(SessionChange::Refreshed));
    assert_eq!(
        sign_in("b@example.com"),
        Some(SessionChange::AccountChanged)
    );
    host.sign_out(None).await;
    assert_eq!(*changes.borrow(), Some(SessionChange::SignedOut));
    assert_eq!(sign_in("b@example.com"), Some(SessionChange::Refreshed));

    let mut expired = record();
    let session = Arc::get_mut(&mut expired).unwrap();
    session.record.expires_at = "2000-01-01T00:00:00Z".into();
    {
        let mut state = host.state();
        state.session = Some(expired);
        state.snapshot.status = Status::SignedIn;
        state.restored = true;
    }
    host.restore().await;
    assert_eq!(*changes.borrow(), Some(SessionChange::Expired));
    assert_eq!(host.state().account, Some(Some("b@example.com".into())));
}

#[test]
fn with_session_lends_the_token_only_while_signed_in() {
    let host = host(Arc::new(Memory::default()));
    assert!(host.with_session(|_, _, _| ()).is_none());
    host.state().session = Some(record());
    let revision = host.snapshot().revision;
    let lent = host.with_session(|token, current, _| (token.to_string(), current.to_owned()));
    assert_eq!(lent, Some(("fixture-session-token".into(), revision)));
    assert_ne!(
        host.agent_grant_key("owner", "a"),
        host.agent_grant_key("owner", "b")
    );
}

pub(super) struct Wire {
    pub(super) target: String,
    pub(super) headers: Vec<(String, String)>,
    pub(super) body: Vec<u8>,
}
pub(super) async fn adapter(
    replies: Vec<serde_json::Value>,
) -> (String, tokio::task::JoinHandle<Vec<Wire>>) {
    adapter_with_status(replies.into_iter().map(|reply| (200, reply)).collect()).await
}
pub(super) async fn adapter_with_status(
    replies: Vec<(u16, serde_json::Value)>,
) -> (String, tokio::task::JoinHandle<Vec<Wire>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/mount", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut seen = Vec::new();
        for (status, reply) in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
            }
            let text = String::from_utf8(head).unwrap();
            let mut lines = text.split("\r\n");
            let target = lines.next().unwrap().to_owned();
            let headers: Vec<_> = lines
                .filter_map(|line| line.split_once(':'))
                .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
                .collect();
            let size: usize = headers
                .iter()
                .find(|(name, _)| name == "content-length")
                .map_or(0, |(_, value)| value.parse().unwrap());
            let mut body = vec![0; size];
            socket.read_exact(&mut body).await.unwrap();
            seen.push(Wire {
                target,
                headers,
                body,
            });
            let body = reply.to_string();
            let reason = match status {
                200 => "OK",
                401 => "Unauthorized",
                403 => "Forbidden",
                429 => "Too Many Requests",
                503 => "Service Unavailable",
                _ => "Fixture Response",
            };
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len(),
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
        seen
    });
    (base, task)
}
/// A loopback origin no connection reaches, so a logout there fails at once.
pub(super) const UNREACHABLE: &str = "http://127.0.0.1:0";
/// Waits for every logout `host` started, and says how many there were.
pub(super) async fn revoked(host: &FederatedIdentity) -> usize {
    let started = std::mem::take(&mut *host.0.revocations.lock().unwrap());
    let count = started.len();
    for revocation in started {
        revocation.await.unwrap();
    }
    count
}
/// Reads the next request at `listener`, which must be the logout route
/// carrying a session only in `X-BB-Session-Credential`. Returns that
/// session, and the stream to answer on.
pub(super) async fn logout_request(
    listener: &tokio::net::TcpListener,
) -> (String, tokio::net::TcpStream) {
    use tokio::io::AsyncReadExt;
    let (mut stream, _) = super::agent::tests::bounded(listener.accept())
        .await
        .unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        head.push(stream.read_u8().await.unwrap());
    }
    let head = String::from_utf8(head).unwrap();
    let mut lines = head.split("\r\n");
    assert_eq!(lines.next(), Some("POST /api/v1/auth/logout HTTP/1.1"));
    let headers: Vec<_> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    assert!(
        headers
            .iter()
            .all(|(name, _)| name != "authorization" && name != "cookie"),
        "{head}"
    );
    let credentials: Vec<_> = headers
        .into_iter()
        .filter(|(name, _)| name == "x-bb-session-credential")
        .map(|(_, value)| value)
        .collect();
    assert_eq!(credentials.len(), 1, "{head}");
    (credentials[0].clone(), stream)
}
pub(super) fn at_adapter(store: Arc<Memory>, base: String) -> FederatedIdentity {
    let mut owner = host(store);
    // Plain loopback wire fixture only. Production Config::parse requires HTTPS.
    Arc::get_mut(&mut owner.0)
        .unwrap()
        .config
        .as_mut()
        .unwrap()
        .adapter_base = base;
    owner
}
// Accept a real loopback handoff without launching a browser; retain the FI guard.
async fn received_callback(owner: &FederatedIdentity) -> CallbackGuard {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let callbacks = crate::oauth_callback::OAuthCallbackHost::default();
    let attempt = callbacks
        .begin_federated(
            &owner.0.fingerprint,
            "https://identity.example/v1/login/start".into(),
            |_| Ok(()),
            Some("synthetic-browser".into()),
        )
        .unwrap();
    let guard = CallbackGuard(callbacks.clone(), attempt.id.clone());
    owner.state().callback = Some(guard.clone());
    let url = url::Url::parse(&attempt.callback_url).unwrap();
    let browser = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", url.port().unwrap()))
            .await
            .unwrap();
        stream
            .write_all(
                format!(
                    "GET {}?code=fixture HTTP/1.1\r\nHost: {}\r\n\r\n",
                    url.path(),
                    url.authority()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut html = String::new();
        stream.read_to_string(&mut html).await.unwrap();
        assert!(html.starts_with("HTTP/1.1 200"));
    };
    let (result, _) = tokio::join!(callbacks.wait(&attempt.id), browser);
    assert!(result.is_ok());
    guard
}

#[tokio::test]
async fn native_exchange_verification_persistence_and_restart_use_the_standard_contract() {
    let store = Arc::new(Memory::default());
    let (base,server) = adapter(vec![
        serde_json::json!({"session_token":"fixture-session-token","expires_at":"2099-01-01T00:00:00Z"}),
        serde_json::json!({"expires_at":"2098-12-31T19:00:00-05:00"}),
        serde_json::json!({"expires_at":"2099-01-01T00:00:00Z","email":"a@example.com"}),
    ]).await;
    let owner = at_adapter(store.clone(), base.clone());
    let revision = owner.snapshot().revision;
    let guard = received_callback(&owner).await;
    owner
        .finish_login(
            "single-use-code",
            "native-handoff-secret",
            &revision,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(owner.state().callback.as_ref().unwrap().1, guard.1);
    owner.clear_callback(&guard.1);
    assert!(owner.state().callback.is_none());
    let signed_in = owner.snapshot();
    assert!(signed_in.status == Status::SignedIn);
    assert!(signed_in.email.is_none());
    assert!(!serde_json::to_string(&signed_in)
        .unwrap()
        .contains("fixture-session-token"));
    let restarted = at_adapter(store, base);
    let restored = restarted.restore().await;
    assert!(restored.status == Status::SignedIn);
    assert_eq!(restored.revision, signed_in.revision);
    assert_eq!(restored.email.as_deref(), Some("a@example.com"));
    let seen = server.await.unwrap();
    assert_eq!(seen[0].target, "POST /mount/v1/login/exchange HTTP/1.1");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&seen[0].body).unwrap(),
        serde_json::json!({"code":"single-use-code","handoff_secret":"native-handoff-secret"})
    );
    assert!(!seen[0]
        .headers
        .iter()
        .any(|(name, _)| name == "authorization"));
    for check in &seen[1..] {
        assert_eq!(check.target, "GET /mount/v1/session HTTP/1.1");
        assert_eq!(
            check
                .headers
                .iter()
                .filter(|(name, _)| name == "authorization")
                .collect::<Vec<_>>(),
            vec![&(
                "authorization".into(),
                "Bearer fixture-session-token".into()
            )]
        );
        assert!(!check
            .headers
            .iter()
            .any(|(name, _)| name == "x-bb-session-credential"));
    }
}
#[tokio::test]
async fn invalid_exchange_and_unequal_fractional_expiry_never_persist() {
    for (exchange, checks) in [
        (
            serde_json::json!({"session_token":"bad\nheader","expires_at":"2099-01-01T00:00:00Z"}),
            vec![],
        ),
        (
            serde_json::json!({"session_token":"fixture-session-token","expires_at":"2099-01-01T00:00:00.100Z"}),
            vec![serde_json::json!({"expires_at":"2099-01-01T00:00:00.200Z"})],
        ),
        (
            serde_json::json!({"session_token":"fixture-session-token","expires_at":"2099-01-01T00:00:00Z"}),
            vec![serde_json::json!({"expires_at":"invalid"})],
        ),
    ] {
        let store = Arc::new(Memory::default());
        let (base, server) = adapter(std::iter::once(exchange).chain(checks).collect()).await;
        let owner = at_adapter(store.clone(), base);
        assert!(owner
            .finish_login(
                "code",
                "secret",
                &owner.snapshot().revision,
                &CancellationToken::new()
            )
            .await
            .is_err());
        assert!(store.raw.lock().unwrap().is_none());
        server.await.unwrap();
    }
}
#[tokio::test]
async fn retirement_during_verification_prevents_late_installation() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (started, observed) = tokio::sync::oneshot::channel();
    let (release, held) = tokio::sync::oneshot::channel();
    let mut started = Some(started);
    let mut held = Some(held);
    let server = tokio::spawn(async move {
        for n in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
            }
            if n == 0 {
                let text = String::from_utf8(head).unwrap();
                let length: usize = text
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|size| size.trim().parse().unwrap())
                    })
                    .unwrap();
                let mut body = vec![0; length];
                socket.read_exact(&mut body).await.unwrap();
            } else {
                started.take().unwrap().send(()).unwrap();
                let _ = held.take().unwrap().await;
            }
            let body = if n == 0 {
                r#"{"session_token":"fixture-session-token","expires_at":"2099-01-01T00:00:00Z"}"#
            } else {
                r#"{"expires_at":"2099-01-01T00:00:00Z"}"#
            };
            let _ = socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await;
            if n == 1 {
                break;
            }
        }
    });
    let store = Arc::new(Memory::default());
    let owner = at_adapter(store.clone(), base);
    let worker = owner.clone();
    let revision = owner.snapshot().revision;
    let cancel = owner.cancellation_for(&revision).unwrap();
    let login = tokio::spawn(async move {
        worker
            .finish_login("code", "secret", &revision, &cancel)
            .await
    });
    observed.await.unwrap();
    owner.sign_out(None).await;
    let _ = release.send(());
    assert!(login.await.unwrap().is_err());
    assert!(owner.snapshot().status == Status::SignedOut);
    assert!(store.raw.lock().unwrap().is_none());
    server.await.unwrap();
}

#[tokio::test]
async fn concurrent_failed_restores_share_one_attempt_then_recover_after_cooldown() {
    use super::agent::tests::{issuer_gated, settled};
    use futures_util::FutureExt;
    let store = Arc::new(Memory::default());
    *store.raw.lock().unwrap() = Some(record().raw.clone());
    let (held, reached) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let mut replies = vec![(503, serde_json::json!({"error":"unavailable"})); 3];
    replies.push((
        200,
        serde_json::json!({"expires_at":"2099-01-01T00:00:00Z", "email":"a@example.com"}),
    ));
    let (base, served) = issuer_gated(replies, 0, Some((held, released))).await;
    let owner = at_adapter(store.clone(), base);
    let first_owner = owner.clone();
    let first = tokio::spawn(async move { first_owner.restore().await });
    reached.await.unwrap();
    let second = owner.restore();
    let third = owner.restore();
    let fourth = owner.restore();
    tokio::pin!(second, third, fourth);
    // Poll each caller while the first verification is held. Each has entered
    // restore admission and is queued on the owner's operation lock.
    assert!(second.as_mut().now_or_never().is_none());
    assert!(third.as_mut().now_or_never().is_none());
    assert!(fourth.as_mut().now_or_never().is_none());
    release.send(()).unwrap();
    let (first, second, third, fourth) = tokio::join!(first, second, third, fourth);
    assert!([first.unwrap(), second, third, fourth]
        .iter()
        .all(|snapshot| snapshot.status == Status::Unavailable));
    assert_eq!(store.reads.load(Ordering::SeqCst), 1);
    assert!(owner.restore().await.status == Status::Unavailable);
    assert_eq!(store.reads.load(Ordering::SeqCst), 1);
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    tokio::time::resume();
    assert!(owner.restore().await.status == Status::SignedIn);
    assert_eq!(store.reads.load(Ordering::SeqCst), 2);
    assert_eq!(
        settled(served).await.len(),
        4,
        "one bounded failed attempt and one recovery verification"
    );
}

#[tokio::test]
async fn sign_out_during_shared_restore_prevents_late_installation() {
    use super::agent::tests::{issuer_gated, settled};
    use futures_util::FutureExt;
    let store = Arc::new(Memory::default());
    *store.raw.lock().unwrap() = Some(record().raw.clone());
    let (held, reached) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let (base, served) = issuer_gated(
        vec![(
            200,
            serde_json::json!({"expires_at":"2099-01-01T00:00:00Z", "email":"a@example.com"}),
        )],
        0,
        Some((held, released)),
    )
    .await;
    let owner = at_adapter(store.clone(), base);
    let first_owner = owner.clone();
    let restoring = tokio::spawn(async move { first_owner.restore().await });
    reached.await.unwrap();
    let queued = owner.restore();
    tokio::pin!(queued);
    assert!(queued.as_mut().now_or_never().is_none());
    let retiring = owner.begin_sign_out(None).unwrap();
    release.send(()).unwrap();
    let (restored, queued, signed_out) =
        tokio::join!(restoring, queued, owner.finish_sign_out(retiring));
    assert!(restored.unwrap().status == Status::SignedOut);
    assert!(queued.status == Status::SignedOut && signed_out.status == Status::SignedOut);
    assert!(owner.state().session.is_none());
    assert!(store.raw.lock().unwrap().is_none());
    assert_eq!(settled(served).await.len(), 1);
}

#[test]
fn expiry_warning_leads_by_72_hours_or_half_the_lifetime() {
    const HOUR: i64 = 60 * 60;
    let issued = 1_000_000;
    let week = issued + 7 * 24 * HOUR;
    assert_eq!(warning_at(issued, week), week - 72 * HOUR);
    let shift = issued + 8 * HOUR;
    assert_eq!(warning_at(issued, shift), issued + 4 * HOUR);
    // Records saved before issue time was kept warn 72 hours ahead.
    assert_eq!(warning_at(0, week), week - 72 * HOUR);
}

#[test]
fn expiry_watch_follows_the_wall_clock_across_sleep() {
    use std::time::Duration;
    let (warn, expires) = (1_000, 2_000);
    assert_eq!(
        due(0, warn, expires, false),
        Due::Wait(Duration::from_secs(60))
    );
    assert_eq!(
        due(990, warn, expires, false),
        Due::Wait(Duration::from_secs(10))
    );
    assert_eq!(due(warn, warn, expires, false), Due::Warn);
    assert_eq!(
        due(1_990, warn, expires, true),
        Due::Wait(Duration::from_secs(10))
    );
    assert_eq!(due(expires, warn, expires, true), Due::Expire);
    // Waking past both points ends the session without a stale warning.
    assert_eq!(due(5_000, warn, expires, false), Due::Expire);
}

/// Signed in at `base`, which serves both the adapter and the identity origin.
pub(super) fn signed_in_at(
    store: Arc<Memory>,
    base: String,
    email: &str,
) -> (FederatedIdentity, Arc<Session>) {
    let origin = url::Url::parse(&base)
        .unwrap()
        .origin()
        .ascii_serialization();
    let mut host = at_adapter(store.clone(), base);
    Arc::get_mut(&mut host.0)
        .unwrap()
        .config
        .as_mut()
        .unwrap()
        .identity_origin = origin;
    let mut current = record();
    let session = Arc::get_mut(&mut current).unwrap();
    session.record.email = Some(email.into());
    session.raw = Zeroizing::new(serde_json::to_vec(&session.record).unwrap());
    *store.raw.lock().unwrap() = Some(current.raw.clone());
    {
        let mut state = host.state();
        state.restored = true;
        host.install_session(&mut state, current.clone());
    }
    (host, current)
}

#[tokio::test]
async fn signing_in_adopts_a_session_another_copy_saved() {
    let (base, server) = adapter(vec![
        serde_json::json!({"expires_at":"2099-01-01T00:00:00Z","email":"a@example.com"}),
    ])
    .await;
    let store = Arc::new(Memory::default());
    let host = at_adapter(store.clone(), base);
    assert!(host.restore().await.status == Status::SignedOut);
    // Another Buzz copy sharing the item signs in after this one restored.
    let other = record();
    *store.raw.lock().unwrap() = Some(other.raw.clone());
    // The fixture's plain-HTTP login URL fails a browser sign-in at once.
    let app = tauri::test::mock_builder()
        .manage(crate::oauth_callback::OAuthCallbackHost::default())
        .build(crate::app_context())
        .unwrap();
    let snapshot = host
        .sign_in(app.handle(), LoginStart::default())
        .await
        .unwrap();
    assert!(snapshot.status == Status::SignedIn);
    assert_eq!(snapshot.failure, None);
    assert_eq!(snapshot.revision, other.record.revision);
    assert_eq!(snapshot.email.as_deref(), Some("a@example.com"));
    let seen = server.await.unwrap();
    assert_eq!(seen[0].target, "GET /mount/v1/session HTTP/1.1");
}

#[tokio::test]
async fn a_sign_out_during_the_shared_item_read_ends_signed_out() {
    use futures_util::FutureExt;
    let (base, server) = adapter(vec![
        serde_json::json!({"expires_at":"2099-01-01T00:00:00Z","email":"a@example.com"}),
    ])
    .await;
    let store = Arc::new(Memory::default());
    let host = at_adapter(store.clone(), base);
    assert!(host.restore().await.status == Status::SignedOut);
    // Another Buzz copy sharing the item signs in after this one restored.
    *store.raw.lock().unwrap() = Some(record().raw.clone());
    let (held, reading) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    *store.read_gate.lock().unwrap() = Some((held, released));
    let app = tauri::test::mock_builder()
        .manage(crate::oauth_callback::OAuthCallbackHost::default())
        .build(crate::app_context())
        .unwrap();
    let (worker, handle) = (host.clone(), app.handle().clone());
    let signing_in =
        tokio::spawn(async move { worker.sign_in(&handle, LoginStart::default()).await });
    tokio::task::spawn_blocking(move || reading.recv().unwrap())
        .await
        .unwrap();
    let signing_out = host.finish_sign_out(host.begin_sign_out(None).unwrap());
    tokio::pin!(signing_out);
    // Sign-in holds the operation lock, so the sign-out's cleanup waits.
    assert!(signing_out.as_mut().now_or_never().is_none());
    release.send(()).unwrap();
    let (signed_in, signed_out) = tokio::join!(signing_in, signing_out);
    let signed_in = signed_in.unwrap().unwrap();
    assert!(signed_in.status == Status::SignedOut && signed_out.status == Status::SignedOut);
    assert!(host.state().session.is_none());
    assert!(store.raw.lock().unwrap().is_none());
    // Both have returned, so a verification would have been answered by now.
    assert!(!server.is_finished(), "the shared record was verified");
    server.abort();
}

#[tokio::test]
async fn a_sign_out_refuses_a_restore_begun_before_it() {
    let (base, server) = adapter(vec![
        serde_json::json!({"expires_at":"2099-01-01T00:00:00Z","email":"a@example.com"}),
    ])
    .await;
    let store = Arc::new(Memory::default());
    let host = at_adapter(store.clone(), base);
    assert!(host.restore().await.status == Status::SignedOut);
    *store.raw.lock().unwrap() = Some(record().raw.clone());
    // As sign-in does once it finds another copy's session, before restoring.
    let attempt = {
        let mut state = host.state();
        state.restored = false;
        state.restore_attempt
    };
    let (_, revision) = host.begin_sign_out(None).unwrap();
    host.restore_locked(attempt).await;
    let snapshot = host.snapshot();
    assert!(snapshot.status == Status::SignedOut);
    assert_eq!(snapshot.revision, revision);
    assert!(host.state().session.is_none());
    assert!(!server.is_finished(), "the shared record was verified");
    server.abort();
}

#[tokio::test]
async fn signing_out_after_another_copy_ended_or_replaced_the_session_is_signed_out() {
    let mut replacement = record();
    let session = Arc::get_mut(&mut replacement).unwrap();
    session.record.session_token = "newer-session-token".into();
    session.raw = Zeroizing::new(serde_json::to_vec(&session.record).unwrap());
    for newer in [None, Some(replacement)] {
        let logout = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let store = Arc::new(Memory::default());
        let (host, current) = signed_in_at(
            store.clone(),
            format!("http://{}", logout.local_addr().unwrap()),
            "a@example.com",
        );
        // Another Buzz copy sharing the item signed out, or in again.
        *store.raw.lock().unwrap() = newer.as_ref().map(|session| session.raw.clone());
        let snapshot = host.sign_out(None).await;
        assert!(snapshot.status == Status::SignedOut);
        assert_eq!(snapshot.failure, None);
        assert_eq!(
            store.raw.lock().unwrap().as_deref(),
            newer.as_ref().map(|session| &*session.raw)
        );
        // This copy's session is revoked, never the newer one.
        let (credential, _) = logout_request(&logout).await;
        assert_eq!(credential, current.record.session_token);
        assert_eq!(super::agent::tests::bounded(revoked(&host)).await, 1);
    }
}

#[tokio::test]
async fn an_expired_session_ends_without_removing_a_newer_one_another_copy_saved() {
    let mut expired = record();
    let session = Arc::get_mut(&mut expired).unwrap();
    session.record.expires_at = "2000-01-01T00:00:00Z".into();
    session.raw = Zeroizing::new(serde_json::to_vec(&session.record).unwrap());
    let newer = record();
    // Another Buzz copy replaced the record; or the removal itself fails.
    for (stored, denied) in [(&newer, false), (&expired, true)] {
        let store = Arc::new(Memory::default());
        *store.raw.lock().unwrap() = Some(stored.raw.clone());
        store.denied.store(denied, Ordering::SeqCst);
        let host = host(store.clone());
        {
            let mut state = host.state();
            state.session = Some(expired.clone());
            state.snapshot.status = Status::SignedIn;
            state.restored = true;
        }
        let snapshot = host.restore().await;
        let cleanup = serde_json::to_value(&snapshot).unwrap()["cleanup"].clone();
        if denied {
            assert!(snapshot.status == Status::Unavailable);
            assert_eq!(snapshot.failure, Some("storage-denied"));
            assert_eq!(cleanup, true);
        } else {
            assert!(snapshot.status == Status::ReauthenticationRequired);
            assert_eq!(snapshot.failure, Some("reauthentication-required"));
            assert_eq!(cleanup, false);
        }
        assert_eq!(store.raw.lock().unwrap().as_deref(), Some(&*stored.raw));
    }
}

#[tokio::test]
async fn the_expiry_watch_warns_then_ends_the_session_at_expiry() {
    let store = Arc::new(Memory::default());
    let (host, _) = signed_in_at(
        store.clone(),
        "https://identity.example".into(),
        "a@example.com",
    );
    let now = now().unwrap();
    let mut short = record();
    let session = Arc::get_mut(&mut short).unwrap();
    session.issued_at = now - 2;
    session.record.expires_at = chrono::DateTime::from_timestamp(now + 2, 0)
        .unwrap()
        .to_rfc3339();
    session.raw = Zeroizing::new(serde_json::to_vec(&session.record).unwrap());
    *store.raw.lock().unwrap() = Some(short.raw.clone());
    let mut changes = host.0.changes.subscribe();
    {
        let mut state = host.state();
        host.reset(&mut state);
        host.install_session(&mut state, short);
    }
    assert!(!host.snapshot().expiring);
    let warned = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        changes.wait_for(|snapshot| snapshot.expiring),
    )
    .await
    .is_ok();
    assert!(warned);
    assert!(host.snapshot().status == Status::SignedIn);
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        changes.wait_for(|snapshot| snapshot.status == Status::ReauthenticationRequired),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(host.state().session.is_none());
    // The retired record is removed after the retirement is published.
    let _operation = host.0.operation.lock().await;
    assert!(store.raw.lock().unwrap().is_none());
}

#[tokio::test]
async fn signing_in_again_keeps_the_session_until_the_new_one_is_installed() {
    let (base, server) = adapter(vec![
        serde_json::json!({"session_token":"renewed-session-token","expires_at":"2099-02-01T00:00:00Z"}),
        serde_json::json!({"expires_at":"2099-02-01T00:00:00Z","email":"a@example.com"}),
    ])
    .await;
    let store = Arc::new(Memory::default());
    let (host, old) = signed_in_at(store.clone(), base, "a@example.com");
    let guard = received_callback(&host).await;
    let changes = host.account_changes();
    let retirements = host.retirements();
    let revision = host.snapshot().revision;
    let cancel = {
        let mut state = host.state();
        let cancel = state.cancellation.child_token();
        state.renewal = Some(cancel.clone());
        cancel
    };
    // The old session still lends its token while the browser flow runs.
    assert_eq!(
        host.with_session(|token, _, _| token.to_string())
            .as_deref(),
        Some("fixture-session-token")
    );
    host.finish_login("code", "secret", &revision, &cancel)
        .await
        .unwrap();
    assert_eq!(host.renewed(&revision, &cancel, Ok(())), Ok(()));
    let snapshot = host.snapshot();
    assert!(snapshot.status == Status::SignedIn);
    assert_ne!(snapshot.revision, revision);
    assert_eq!(snapshot.expires_at.as_deref(), Some("2099-02-01T00:00:00Z"));
    assert!(host.state().renewal.is_none());
    assert_eq!(host.state().callback.as_ref().unwrap().1, guard.1);
    assert_eq!(
        host.with_session(|token, _, _| token.to_string())
            .as_deref(),
        Some("renewed-session-token")
    );
    assert_ne!(store.raw.lock().unwrap().as_deref(), Some(&*old.raw));
    assert_eq!(*changes.borrow(), Some(SessionChange::Refreshed));
    assert_eq!(host.retirements(), retirements);
    host.retire(Status::SignedOut, None);
    assert!(host.state().callback.is_none());
    server.await.unwrap();
}

#[tokio::test]
async fn a_canceled_or_failed_renewal_leaves_the_session_intact() {
    let (base, server) =
        adapter_with_status(vec![(400, serde_json::json!({"error":"invalid_grant"}))]).await;
    let store = Arc::new(Memory::default());
    let (host, old) = signed_in_at(store.clone(), base, "a@example.com");
    let revision = host.snapshot().revision;
    let renew = || {
        let mut state = host.state();
        let cancel = state.cancellation.child_token();
        state.renewal = Some(cancel.clone());
        cancel
    };

    let canceled = renew();
    host.cancel_sign_in();
    assert!(canceled.is_cancelled());
    let result = host
        .finish_login("code", "secret", &revision, &canceled)
        .await;
    assert_eq!(host.renewed(&revision, &canceled, result), Ok(()));

    let failed = renew();
    let result = host
        .finish_login("code", "secret", &revision, &failed)
        .await;
    assert!(result.is_err());
    // Only the caller hears about it; the snapshot's failure is for others.
    assert!(host.renewed(&revision, &failed, result).is_err());

    let snapshot = host.snapshot();
    assert!(snapshot.status == Status::SignedIn);
    assert_eq!(snapshot.revision, revision);
    assert!(snapshot.failure.is_none());
    assert!(host.state().renewal.is_none());
    assert!(Arc::ptr_eq(host.state().session.as_ref().unwrap(), &old));
    assert_eq!(store.raw.lock().unwrap().as_deref(), Some(&*old.raw));
    server.await.unwrap();
}

#[tokio::test]
async fn a_renewal_into_another_account_retires_derived_state() {
    let (base, server) = adapter(vec![
        serde_json::json!({"session_token":"other-session-token","expires_at":"2099-02-01T00:00:00Z"}),
        serde_json::json!({"expires_at":"2099-02-01T00:00:00Z","email":"b@example.com"}),
    ])
    .await;
    let store = Arc::new(Memory::default());
    let (host, _) = signed_in_at(store, base, "a@example.com");
    let changes = host.account_changes();
    let retirements = host.retirements();
    let revision = host.snapshot().revision;
    let cancel = host.state().cancellation.child_token();
    host.finish_login("code", "secret", &revision, &cancel)
        .await
        .unwrap();
    assert_eq!(*changes.borrow(), Some(SessionChange::AccountChanged));
    assert_eq!(host.retirements(), retirements + 1);
    assert_eq!(host.snapshot().email.as_deref(), Some("b@example.com"));
    server.await.unwrap();
}

/// Holds `host`'s renewal into b@example.com once its record is saved over
/// `shared`, another copy's record (with none, `host`'s own), runs
/// `meanwhile`, then lets it finish.
async fn renewal_held_after_saving(
    shared: Option<Arc<Session>>,
    meanwhile: impl FnOnce(&FederatedIdentity, &Memory),
) -> (
    FederatedIdentity,
    Arc<Memory>,
    Arc<Session>,
    String,
    Result<(), Failure>,
) {
    let (base, server) = adapter(vec![
        serde_json::json!({"session_token":"other-session-token","expires_at":"2099-02-01T00:00:00Z"}),
        serde_json::json!({"expires_at":"2099-02-01T00:00:00Z","email":"b@example.com"}),
    ])
    .await;
    let store = Arc::new(Memory::default());
    let (host, old) = signed_in_at(store.clone(), base, "a@example.com");
    if let Some(shared) = shared {
        *store.raw.lock().unwrap() = Some(shared.raw.clone());
    }
    let revision = host.snapshot().revision;
    let cancel = {
        let mut state = host.state();
        let cancel = state.cancellation.child_token();
        state.renewal = Some(cancel.clone());
        cancel
    };
    let (held, saved) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    *store.compare_gate.lock().unwrap() = Some((held, released));
    let worker = host.clone();
    let (login_revision, login_cancel) = (revision.clone(), cancel.clone());
    let login = tokio::spawn(async move {
        worker
            .finish_login("code", "secret", &login_revision, &login_cancel)
            .await
    });
    tokio::task::spawn_blocking(move || saved.recv().unwrap())
        .await
        .unwrap();
    meanwhile(&host, &store);
    release.send(()).unwrap();
    let result = login.await.unwrap();
    server.await.unwrap();
    (host, store, old, revision, result)
}

#[tokio::test]
async fn a_renewal_past_its_commit_point_ignores_cancel() {
    let (host, store, old, revision, result) =
        renewal_held_after_saving(None, |host, _| host.cancel_sign_in()).await;
    // Cancel came too late to stop it, so it completes whole.
    assert!(result.is_ok());
    let snapshot = host.snapshot();
    assert!(snapshot.status == Status::SignedIn);
    assert_ne!(snapshot.revision, revision);
    assert_eq!(snapshot.email.as_deref(), Some("b@example.com"));
    let current = host.state().session.clone().unwrap();
    assert!(!Arc::ptr_eq(&current, &old));
    assert_eq!(store.raw.lock().unwrap().as_deref(), Some(&*current.raw));
}

#[tokio::test]
async fn a_renewal_whose_session_ends_while_saving_is_refused_even_if_rollback_fails() {
    let (host, store, old, _, result) = renewal_held_after_saving(None, |host, store| {
        // The session ends (as sign-out does) and storage starts failing.
        host.retire(Status::SignedOut, None);
        store.denied.store(true, Ordering::SeqCst);
    })
    .await;
    assert!(result.is_err());
    assert!(host.state().session.is_none());
    // The replacement is still stored, but refused before anything else.
    assert_ne!(store.raw.lock().unwrap().as_deref(), Some(&*old.raw));
    store.denied.store(false, Ordering::SeqCst);
    let restarted = at_adapter(store.clone(), "https://identity.example".into());
    assert!(restarted.restore().await.status == Status::SignedOut);
    assert!(store.raw.lock().unwrap().is_none());
}

#[tokio::test]
async fn a_stale_renewal_saves_over_the_session_another_copy_left() {
    // Another Buzz copy sharing the item renewed, or signed out, since this
    // copy restored.
    for other in [Some(record()), None] {
        let (base, server) = adapter(vec![
            serde_json::json!({"session_token":"renewed-session-token","expires_at":"2099-02-01T00:00:00Z"}),
            serde_json::json!({"expires_at":"2099-02-01T00:00:00Z","email":"a@example.com"}),
        ])
        .await;
        let store = Arc::new(Memory::default());
        let (host, _) = signed_in_at(store.clone(), base, "a@example.com");
        *store.raw.lock().unwrap() = other.as_ref().map(|session| session.raw.clone());
        let revision = host.snapshot().revision;
        let cancel = {
            let mut state = host.state();
            let cancel = state.cancellation.child_token();
            state.renewal = Some(cancel.clone());
            cancel
        };
        let result = host
            .finish_login("code", "secret", &revision, &cancel)
            .await;
        assert_eq!(host.renewed(&revision, &cancel, result), Ok(()));
        let snapshot = host.snapshot();
        assert!(snapshot.status == Status::SignedIn);
        assert_ne!(snapshot.revision, revision);
        let current = host.state().session.clone().unwrap();
        assert_eq!(current.record.session_token, "renewed-session-token");
        assert_eq!(store.raw.lock().unwrap().as_deref(), Some(&*current.raw));
        server.await.unwrap();
    }
}

#[tokio::test]
async fn a_renewal_ended_after_saving_puts_back_the_session_it_replaced() {
    // Another Buzz copy renewed since this one restored.
    let other = record();
    let (host, store, _, _, result) = renewal_held_after_saving(Some(other.clone()), |host, _| {
        host.retire(Status::SignedOut, None);
    })
    .await;
    assert_eq!(result.unwrap_err().code, "session-changed");
    assert!(host.state().session.is_none());
    // The other copy's record is back, not this copy's old one.
    assert_eq!(store.raw.lock().unwrap().as_deref(), Some(&*other.raw));
}
