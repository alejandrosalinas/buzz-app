use super::policy::{classify, Verdict};
use super::*;
use crate::federated_identity::{agent::AgentTokens, FederatedIdentity};
use buzz_agent_controller::{AppAgent, Secret};

pub(crate) const RELAY: &str = "wss://relay.example";
const NOW: u64 = 1_800_000_000;

pub(crate) struct Fixture {
    pub(crate) service: CredentialService,
    pub(crate) host: AppAgentHost,
    pub(crate) identity: FederatedIdentity,
    pub(crate) agent: AppAgent,
    key: Secret,
    pub(crate) _dir: tempfile::TempDir,
    pub(crate) keychain: Arc<super::keychain::Memory>,
    pub(crate) notices: Arc<Mutex<Vec<Notice>>>,
}

pub(crate) fn fixture() -> Fixture {
    fixture_signed_in(FederatedIdentity::unconfigured())
}

/// The protection provider of [`protected_fixture`]'s agents.
pub(crate) const GUARD: &str = "guard";
/// A fixture whose agent's saved protection names [`GUARD`].
pub(crate) fn protected_fixture() -> Fixture {
    let fixture = fixture();
    protect(&fixture, &[&fixture.agent.pubkey]);
    fixture
}
/// Saves `provider`'s protection for the agent anew, at a new revision; a
/// switch of provider removes the old one first, as the app requires.
pub(crate) fn reprotect(fixture: &Fixture, provider: &str) {
    let agents = fixture.host.agents().unwrap();
    let current = || agents.get(&fixture.agent.pubkey, RELAY).unwrap();
    if provider != GUARD {
        agents
            .set_protection(
                &fixture.agent.pubkey,
                current().protection_revision,
                GUARD,
                None,
            )
            .unwrap();
    }
    agents
        .set_protection(
            &fixture.agent.pubkey,
            current().protection_revision,
            provider,
            Some(json!({"v": 2})),
        )
        .unwrap();
}
fn protect(fixture: &Fixture, pubkeys: &[&str]) {
    let agents = fixture.host.agents().unwrap();
    agents.upgrade_protection_storage().unwrap();
    for pubkey in pubkeys {
        agents
            .set_protection(pubkey, 0, GUARD, Some(json!({})))
            .unwrap();
    }
}

/// A second agent of `fixture`'s type and protection, held beside it.
pub(crate) fn second_agent(fixture: &Fixture) -> AppAgent {
    let second = Secret::generate().unwrap();
    let mut other = fixture.agent.clone();
    other.pubkey = second.pubkey().into();
    fixture.host.also_holding_for_test(
        fixture._dir.path().join("identities.json"),
        &[&fixture.agent, &other],
        second,
    );
    protect(fixture, &[&fixture.agent.pubkey, &other.pubkey]);
    other
}

/// A fixture whose NIP-FI session is `identity`.
pub(crate) fn fixture_signed_in(identity: FederatedIdentity) -> Fixture {
    let key = Secret::generate().unwrap();
    let agent = AppAgent {
        pubkey: key.pubkey().into(),
        relay: RELAY.into(),
        owner: Secret::generate().unwrap().pubkey().into(),
        auth: r#"["auth","owner","","sig"]"#.into(),
        agent_type: "p/t".into(),
        name: "Ada".into(),
        picture: None,
        profile: None,
        about: None,
        deleted: false,
        deleting: false,
        home: None,
        joining: false,
        protection: None,
        protection_revision: 0,
    };
    let tokens = AgentTokens::in_memory(identity.clone());
    fixture_with(agent, key, identity, tokens)
}

fn fixture_with(
    agent: AppAgent,
    key: Secret,
    identity: FederatedIdentity,
    tokens: AgentTokens,
) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let host = AppAgentHost::holding(
        dir.path().join("identities.json"),
        &agent,
        Secret::parse(&key.hex(), key.pubkey()).unwrap(),
        tokens,
    );
    let keychain = Arc::new(super::keychain::Memory::default());
    let notices = Arc::new(Mutex::new(Vec::new()));
    let service = service_over(
        &host,
        &identity,
        &keychain,
        &notices,
        IdentityHost::fixture(),
    );
    Fixture {
        service,
        keychain,
        notices,
        host,
        identity,
        agent,
        key,
        _dir: dir,
    }
}

/// A service as a new run of the app would make it, over `keychain`.
pub(crate) fn service_over(
    host: &AppAgentHost,
    identity: &FederatedIdentity,
    keychain: &Arc<super::keychain::Memory>,
    notices: &Arc<Mutex<Vec<Notice>>>,
    human: IdentityHost,
) -> CredentialService {
    let notices = notices.clone();
    let service = CredentialService::new(
        host.clone(),
        "xyz.block.buzz.test".into(),
        human,
        identity.clone(),
        Arc::new(keychain.clone()),
        Arc::new(move |notice| notices.lock().unwrap().push(notice)),
    );
    *service.0.pairings.communities.lock().unwrap() = Some(vec![RELAY.into()]);
    // The page's prompt is listening, as it is once the app shell shows.
    service.0.pairings.prompt(true);
    service
}

fn token(env: &str) -> String {
    let value: Value = serde_json::from_str(env).unwrap();
    value["token"].as_str().unwrap().to_owned()
}

pub(crate) async fn issued(fixture: &Fixture) -> (Issued, String) {
    let (issued, env) = fixture.service.issue().await.unwrap().unwrap();
    (issued, token(&env))
}

async fn bound(fixture: &Fixture) -> (Issued, String) {
    let (issued, token) = issued(fixture).await;
    fixture
        .service
        .bind(
            &issued,
            "p",
            None,
            fixture.agent.pubkey.clone(),
            RELAY.into(),
        )
        .await
        .unwrap();
    (issued, token)
}

pub(crate) async fn ask(
    fixture: &Fixture,
    token: &str,
    method: &str,
    params: &[&str],
) -> (StatusCode, Value) {
    let body = json!({ "id": "1", "method": method, "params": params }).to_string();
    respond(
        &fixture.service,
        Some(token),
        Some(1),
        body.as_bytes(),
        None,
    )
    .await
}

pub(crate) fn error(reply: &(StatusCode, Value)) -> (StatusCode, &str) {
    (reply.0, reply.1["error"].as_str().unwrap_or_default())
}

fn unsigned(kind: u16, tags: Value, created_at: u64) -> String {
    json!({ "kind": kind, "tags": tags, "content": "hi", "created_at": created_at }).to_string()
}

fn now() -> u64 {
    unix_now().unwrap()
}

#[tokio::test]
async fn the_environment_names_a_loopback_endpoint_and_a_fresh_token() {
    let fixture = fixture();
    let (_first, env) = fixture.service.issue().await.unwrap().unwrap();
    let (_second, other) = fixture.service.issue().await.unwrap().unwrap();
    let value: Value = serde_json::from_str(&env).unwrap();
    let url = value["url"].as_str().unwrap();
    assert!(url.starts_with("http://127.0.0.1:") && url.ends_with("/v1"));
    assert_eq!(token(&env).len(), 43, "256 bits, base64url");
    assert_ne!(token(&env), token(&other));
}

#[tokio::test]
async fn an_unbound_token_acts_for_nobody() {
    let fixture = fixture();
    let (_issued, token) = issued(&fixture).await;
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(
        error(&reply),
        (StatusCode::SERVICE_UNAVAILABLE, "unavailable")
    );
}

#[tokio::test]
async fn a_bound_token_is_its_agent_and_never_another() {
    let fixture = fixture();
    let (issued, token) = bound(&fixture).await;
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(reply.1["result"], fixture.agent.pubkey.as_str());
    // Binding again to the same agent is harmless; to another is refused.
    fixture
        .service
        .bind(
            &issued,
            "p",
            None,
            fixture.agent.pubkey.clone(),
            RELAY.into(),
        )
        .await
        .unwrap();
    let other = Secret::generate().unwrap();
    assert!(fixture
        .service
        .bind(&issued, "p", None, other.pubkey().into(), RELAY.into())
        .await
        .is_err());
    let described: Value = serde_json::from_str(
        ask(&fixture, &token, "describe", &[]).await.1["result"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(described["role"], "agent");
    assert_eq!(described["owner_pubkey"], fixture.agent.owner.as_str());
    assert_eq!(described["relays"], json!([RELAY]));
    assert_eq!(described["instance"], "xyz.block.buzz.test");
    assert!(!described["methods"]
        .as_array()
        .unwrap()
        .contains(&json!("pair")));
}

/// A protection provider binds only the agent it launched a process for;
/// the agent's own plugin binds it as before.
#[tokio::test]
async fn a_protection_provider_binds_only_the_agent_it_launched() {
    let fixture = protected_fixture();
    let pubkey = fixture.agent.pubkey.clone();
    let other = second_agent(&fixture);
    let launch = fixture
        .service
        .protected_launch(GUARD, pubkey.clone(), RELAY.into())
        .await
        .unwrap();
    // Not for an unrelated plugin, nor for an agent it does not protect.
    assert!(fixture
        .service
        .protected_launch("other", pubkey.clone(), RELAY.into())
        .await
        .is_err());
    let unprotected = self::fixture();
    assert!(unprotected
        .service
        .protected_launch(GUARD, unprotected.agent.pubkey.clone(), RELAY.into())
        .await
        .is_err());
    let (held, token) = issued(&fixture).await;
    // Its launch for this agent lends nothing for another of its agents, nor
    // to another plugin, nor without the launch.
    for (plugin, launched, agent) in [
        (GUARD, Some(&launch), &other.pubkey),
        ("other", Some(&launch), &pubkey),
        (GUARD, None, &pubkey),
    ] {
        assert!(fixture
            .service
            .bind(&held, plugin, launched, agent.clone(), RELAY.into())
            .await
            .is_err());
    }
    assert_eq!(
        error(&ask(&fixture, &token, "get_public_key", &[]).await),
        (StatusCode::SERVICE_UNAVAILABLE, "unavailable")
    );
    fixture
        .service
        .bind(&held, GUARD, Some(&launch), pubkey.clone(), RELAY.into())
        .await
        .unwrap();
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(reply.1["result"], pubkey.as_str());
    // The agent's own plugin still binds it.
    let (own, token) = issued(&fixture).await;
    fixture
        .service
        .bind(&own, "p", None, pubkey.clone(), RELAY.into())
        .await
        .unwrap();
    assert_eq!(
        ask(&fixture, &token, "get_public_key", &[]).await.1["result"],
        pubkey.as_str()
    );
}

/// A token bound through a protected launch stops acting for good once the
/// agent's protection changes or names another provider; so does its launch.
#[tokio::test]
async fn a_protection_change_revokes_a_launched_token() {
    for provider in [GUARD, "other"] {
        let fixture = protected_fixture();
        let pubkey = fixture.agent.pubkey.clone();
        let launch = fixture
            .service
            .protected_launch(GUARD, pubkey.clone(), RELAY.into())
            .await
            .unwrap();
        let (held, token) = issued(&fixture).await;
        fixture
            .service
            .bind(&held, GUARD, Some(&launch), pubkey.clone(), RELAY.into())
            .await
            .unwrap();
        assert_eq!(
            ask(&fixture, &token, "get_public_key", &[]).await.0,
            StatusCode::OK
        );
        reprotect(&fixture, provider);
        let reply = ask(&fixture, &token, "get_public_key", &[]).await;
        assert_eq!(reply.0, StatusCode::UNAUTHORIZED, "provider={provider}");
        assert!(!fixture.service.acts(&held), "provider={provider}");
        assert!(!fixture.service.launch_current(&launch).await);
        let (fresh, _) = issued(&fixture).await;
        assert!(fixture
            .service
            .bind(&fresh, GUARD, Some(&launch), pubkey.clone(), RELAY.into())
            .await
            .is_err());
    }
}

/// One agent's key, whose first read signals `held` and waits for `release`.
struct KeyGate {
    key: Secret,
    held: std::sync::mpsc::Sender<()>,
    release: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}
impl buzz_agent_controller::Credentials for KeyGate {
    fn read_legacy(
        &self,
        _: buzz_agent_controller::LegacySource,
        _: &str,
    ) -> Result<Secret, String> {
        unreachable!()
    }
    fn read(&self, _: &str, pubkey: &str) -> Result<Option<Secret>, String> {
        if let Some(release) = self.release.lock().unwrap().take() {
            self.held.send(()).unwrap();
            release.recv().unwrap();
        }
        Secret::parse(&self.key.hex(), pubkey).map(Some)
    }
    fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
        unreachable!()
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), String> {
        unreachable!()
    }
}

/// A launched token's request held reading the key, past the protection
/// check before it runs, while the agent's protection changes, returns
/// nothing: the check after it ran revokes it on its own.
#[tokio::test(flavor = "multi_thread")]
async fn a_protection_change_mid_request_withholds_the_result() {
    for provider in [GUARD, "other"] {
        let fixture = protected_fixture();
        let pubkey = fixture.agent.pubkey.clone();
        let (held_tx, held) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let host = fixture
            .host
            .clone()
            .with_credentials_for_test(Arc::new(KeyGate {
                key: Secret::parse(&fixture.key.hex(), fixture.key.pubkey()).unwrap(),
                held: held_tx,
                release: Mutex::new(Some(release_rx)),
            }));
        let service = service_over(
            &host,
            &fixture.identity,
            &fixture.keychain,
            &fixture.notices,
            IdentityHost::fixture(),
        );
        let launch = service
            .protected_launch(GUARD, pubkey.clone(), RELAY.into())
            .await
            .unwrap();
        let (issued, env) = service.issue().await.unwrap().unwrap();
        let token = token(&env);
        service
            .bind(&issued, GUARD, Some(&launch), pubkey, RELAY.into())
            .await
            .unwrap();
        let body =
            json!({ "id": "1", "method": "sign_event", "params": [unsigned(9, json!([]), now())] })
                .to_string();
        let request = tokio::spawn({
            let (service, token) = (service.clone(), token.clone());
            async move { respond(&service, Some(&token), Some(1), body.as_bytes(), None).await }
        });
        // The key is read only once the check before the request has passed.
        tokio::task::spawn_blocking(move || held.recv())
            .await
            .unwrap()
            .unwrap();
        reprotect(&fixture, provider);
        release.send(()).unwrap();
        let reply = request.await.unwrap();
        assert_eq!(
            error(&reply),
            (StatusCode::UNAUTHORIZED, "revoked"),
            "provider={provider}"
        );
        assert_eq!(reply.1["result"], "", "provider={provider}");
        let body = json!({ "id": "1", "method": "get_public_key", "params": [] }).to_string();
        let after = respond(&service, Some(&token), Some(1), body.as_bytes(), None).await;
        assert_eq!(after.0, StatusCode::UNAUTHORIZED, "provider={provider}");
    }
}

#[tokio::test]
async fn a_plugin_binds_only_agents_of_its_own_type() {
    let fixture = fixture();
    let (issued, token) = issued(&fixture).await;
    for plugin in ["other", "", "p/t"] {
        assert!(fixture
            .service
            .bind(
                &issued,
                plugin,
                None,
                fixture.agent.pubkey.clone(),
                RELAY.into()
            )
            .await
            .is_err());
    }
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(
        error(&reply),
        (StatusCode::SERVICE_UNAVAILABLE, "unavailable")
    );
}

#[tokio::test]
async fn a_token_stops_with_its_process() {
    let fixture = fixture();
    let (issued, token) = bound(&fixture).await;
    drop(issued);
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply), (StatusCode::UNAUTHORIZED, "revoked"));
}

#[tokio::test]
async fn deleting_the_agent_revokes_its_tokens_for_good() {
    let fixture = fixture();
    let (issued, token) = bound(&fixture).await;
    fixture
        .host
        .forget_row_for_test(&fixture.agent.pubkey, RELAY);
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply), (StatusCode::UNAUTHORIZED, "revoked"));
    // Not even an import of the same key brings this token back.
    fixture
        .host
        .reopen_row_for_test(&fixture.agent.pubkey, RELAY);
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply), (StatusCode::UNAUTHORIZED, "revoked"));
    assert!(fixture
        .service
        .bind(
            &issued,
            "p",
            None,
            fixture.agent.pubkey.clone(),
            RELAY.into()
        )
        .await
        .is_err());
}

#[tokio::test]
async fn signing_out_revokes_every_token() {
    let fixture = fixture();
    let (_issued, token) = bound(&fixture).await;
    fixture.identity.sign_out(None).await;
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply), (StatusCode::UNAUTHORIZED, "revoked"));
}

#[tokio::test]
async fn a_spare_issued_before_sign_out_never_acts() {
    let fixture = fixture();
    // One asked before it is taken, one taken first: neither binds or acts.
    let (asked, asked_token) = issued(&fixture).await;
    let (taken, taken_token) = issued(&fixture).await;
    fixture.identity.sign_out(None).await;
    let reply = ask(&fixture, &asked_token, "get_public_key", &[]).await;
    assert_eq!(error(&reply), (StatusCode::UNAUTHORIZED, "revoked"));
    assert!(fixture
        .service
        .bind(
            &asked,
            "p",
            None,
            fixture.agent.pubkey.clone(),
            RELAY.into()
        )
        .await
        .is_err());
    assert!(fixture
        .service
        .bind(
            &taken,
            "p",
            None,
            fixture.agent.pubkey.clone(),
            RELAY.into()
        )
        .await
        .is_err());
    for token in [&asked_token, &taken_token] {
        let reply = ask(&fixture, token, "get_public_key", &[]).await;
        assert_eq!(error(&reply), (StatusCode::UNAUTHORIZED, "revoked"));
    }
    // A token issued after it acts.
    let (_issued, token) = bound(&fixture).await;
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(reply.0, StatusCode::OK);
}

#[derive(Clone, Copy, Debug)]
enum Revocation {
    Exit,
    Deletion,
    SignOut,
}

/// A request admitted before its token is revoked, that then waits for the
/// agent's key, returns no signature and no plaintext.
#[tokio::test(flavor = "multi_thread")]
// The held key lock is the gate that pauses the request.
#[allow(clippy::await_holding_lock)]
async fn revocation_while_a_key_is_read_withholds_the_result() {
    for revocation in [Revocation::Exit, Revocation::Deletion, Revocation::SignOut] {
        for method in ["sign_event", "nip44_decrypt"] {
            let fixture = fixture();
            let (issued, token) = bound(&fixture).await;
            let owner = fixture.agent.owner.clone();
            let params = match method {
                "sign_event" => vec![unsigned(9, json!([]), now())],
                _ => vec![
                    owner.clone(),
                    fixture.key.nip44_encrypt(&owner, "secret").unwrap(),
                ],
            };
            let key = digest(&token);
            let keys = fixture.host.hold_keys_for_test();
            let (service, waiting) = (fixture.service.clone(), token.clone());
            let body = json!({ "id": "1", "method": method, "params": params }).to_string();
            let request = tokio::spawn(async move {
                respond(&service, Some(&waiting), Some(1), body.as_bytes(), None).await
            });
            // Admitted: it spent one request of its rate, and now waits for the key.
            while !fixture.service.callers()[&key].spent() {
                tokio::task::yield_now().await;
            }
            assert!(!request.is_finished());
            match revocation {
                Revocation::Exit => drop(issued),
                Revocation::Deletion => fixture
                    .host
                    .forget_row_for_test(&fixture.agent.pubkey, RELAY),
                Revocation::SignOut => drop(fixture.identity.sign_out(None).await),
            }
            drop(keys);
            let reply = request.await.unwrap();
            assert_eq!(
                error(&reply),
                (StatusCode::UNAUTHORIZED, "revoked"),
                "{revocation:?} {method}"
            );
            assert_eq!(reply.1["result"], "", "{revocation:?} {method}");
        }
    }
}

/// Deleting the agent while its request reads the saved agent answers
/// `revoked`, not the failed read's `unavailable`.
#[tokio::test(flavor = "multi_thread")]
// The held key lock is the gate that pauses the request.
#[allow(clippy::await_holding_lock)]
async fn deletion_while_the_agent_is_read_answers_revoked() {
    let fixture = fixture();
    let (_issued, token) = bound(&fixture).await;
    let key = digest(&token);
    // The saved row is gone, so the read fails, and waits on the keys to
    // forget this agent's.
    std::fs::write(fixture._dir.path().join("identities.json"), "[]").unwrap();
    let keys = fixture.host.hold_keys_for_test();
    let (service, waiting) = (fixture.service.clone(), token.clone());
    let request = tokio::spawn(async move {
        let body = json!({ "id": "1", "method": "auth_tag", "params": [] }).to_string();
        respond(&service, Some(&waiting), Some(1), body.as_bytes(), None).await
    });
    while !fixture.service.callers()[&key].spent() {
        tokio::task::yield_now().await;
    }
    assert!(!request.is_finished());
    fixture
        .host
        .forget_row_for_test(&fixture.agent.pubkey, RELAY);
    drop(keys);
    let reply = request.await.unwrap();
    assert_eq!(error(&reply), (StatusCode::UNAUTHORIZED, "revoked"));
}

#[tokio::test]
async fn an_unknown_token_is_revoked_and_a_missing_one_too() {
    let fixture = fixture();
    let reply = ask(&fixture, "not-a-token", "get_public_key", &[]).await;
    assert_eq!(error(&reply), (StatusCode::UNAUTHORIZED, "revoked"));
    let body = json!({ "id": "1", "method": "describe", "params": [] }).to_string();
    let reply = respond(&fixture.service, None, Some(1), body.as_bytes(), None).await;
    assert_eq!(error(&reply), (StatusCode::UNAUTHORIZED, "revoked"));
}

#[tokio::test]
async fn versions_and_envelopes_are_checked_first() {
    let fixture = fixture();
    let (_issued, token) = bound(&fixture).await;
    let body = json!({ "id": "7", "method": "describe", "params": [] }).to_string();
    let reply = respond(
        &fixture.service,
        Some(&token),
        Some(2),
        body.as_bytes(),
        None,
    )
    .await;
    assert_eq!(
        error(&reply),
        (StatusCode::BAD_REQUEST, "unsupported_version")
    );
    assert_eq!(reply.1["versions"], json!([1]));
    assert_eq!(reply.1["id"], "7");
    let reply = respond(&fixture.service, Some(&token), None, body.as_bytes(), None).await;
    assert_eq!(
        error(&reply),
        (StatusCode::BAD_REQUEST, "unsupported_version")
    );
    let reply = respond(&fixture.service, Some(&token), Some(1), b"{}", None).await;
    assert_eq!(error(&reply), (StatusCode::BAD_REQUEST, "invalid_request"));
    let reply = ask(&fixture, &token, "sign_event", &[]).await;
    assert_eq!(error(&reply), (StatusCode::BAD_REQUEST, "invalid_request"));
    let reply = ask(&fixture, &token, "connect", &[]).await;
    assert_eq!(error(&reply), (StatusCode::BAD_REQUEST, "unknown_method"));
    // Unknown fields are ignored.
    let body =
        json!({ "id": "8", "method": "get_public_key", "params": [], "extra": 1 }).to_string();
    let reply = respond(
        &fixture.service,
        Some(&token),
        Some(1),
        body.as_bytes(),
        None,
    )
    .await;
    assert_eq!(reply.1["result"], fixture.agent.pubkey.as_str());
}

#[tokio::test]
async fn ordinary_events_are_signed_as_built() {
    let fixture = fixture();
    let (_issued, token) = bound(&fixture).await;
    let event = unsigned(9, json!([["h", "channel"]]), 1_700_000_000);
    let reply = ask(&fixture, &token, "sign_event", &[&event]).await;
    let signed: Value = serde_json::from_str(reply.1["result"].as_str().unwrap()).unwrap();
    assert_eq!(signed["pubkey"], fixture.agent.pubkey.as_str());
    assert_eq!(signed["created_at"], 1_700_000_000);
    assert_eq!(signed["tags"], json!([["h", "channel"]]));
    let event: nostr::event::Event = serde_json::from_value(signed).unwrap();
    event.verify().unwrap();
}

#[tokio::test]
async fn sensitive_and_unknown_kinds_are_not_signed() {
    let fixture = fixture();
    let (_issued, token) = bound(&fixture).await;
    for kind in [0, 3, 5, 9000, 9021, 30177, 30617, 46030] {
        let reply = ask(
            &fixture,
            &token,
            "sign_event",
            &[&unsigned(kind, json!([]), NOW)],
        )
        .await;
        assert_eq!(error(&reply), (StatusCode::FORBIDDEN, "denied"), "{kind}");
        let message = reply.1["message"].as_str().unwrap();
        assert!(
            message.contains("can't be signed by a local tool"),
            "{kind}"
        );
    }
    let reply = ask(
        &fixture,
        &token,
        "sign_event",
        &[&unsigned(4, json!([]), NOW)],
    )
    .await;
    assert_eq!(error(&reply), (StatusCode::FORBIDDEN, "denied"));
    assert!(reply.1["message"].as_str().unwrap().contains("Kind 4"));
}

#[tokio::test]
async fn an_event_naming_another_identity_is_denied() {
    let fixture = fixture();
    let (_issued, token) = bound(&fixture).await;
    let event = json!({
        "kind": 9, "tags": [], "content": "", "created_at": NOW,
        "pubkey": Secret::generate().unwrap().pubkey(),
    })
    .to_string();
    let reply = ask(&fixture, &token, "sign_event", &[&event]).await;
    assert_eq!(error(&reply), (StatusCode::FORBIDDEN, "denied"));
}

#[tokio::test]
async fn auth_proofs_are_signed_only_for_its_community_and_now() {
    let fixture = fixture();
    let (_issued, token) = bound(&fixture).await;
    let at = now();
    let http = unsigned(
        27235,
        json!([["u", "https://relay.example/query"], ["method", "POST"]]),
        at,
    );
    assert_eq!(
        ask(&fixture, &token, "sign_event", &[&http]).await.0,
        StatusCode::OK
    );
    let elsewhere = unsigned(
        27235,
        json!([
            ["u", "https://adapter.example/v1/identity/assertions"],
            ["method", "POST"]
        ]),
        at,
    );
    let reply = ask(&fixture, &token, "sign_event", &[&elsewhere]).await;
    assert_eq!(error(&reply), (StatusCode::FORBIDDEN, "denied"));
    let stale = unsigned(
        27235,
        json!([["u", "https://relay.example/query"], ["method", "POST"]]),
        at - 120,
    );
    let reply = ask(&fixture, &token, "sign_event", &[&stale]).await;
    assert_eq!(error(&reply), (StatusCode::FORBIDDEN, "denied"));
}

#[test]
fn the_policy_binds_each_proof_to_the_community() {
    let tags = |value: Value| serde_json::from_value::<Vec<Vec<String>>>(value).unwrap();
    let verdict = |kind, value, at| classify(kind, &tags(value), at, NOW, RELAY);
    // NIP-42: its relay, one challenge.
    assert_eq!(
        verdict(
            22242,
            json!([["relay", "wss://Relay.Example/"], ["challenge", "c"]]),
            NOW
        ),
        Verdict::Sign
    );
    assert_eq!(
        verdict(
            22242,
            json!([["relay", "wss://relay.example:443"], ["challenge", "c"]]),
            NOW
        ),
        Verdict::Sign
    );
    // Another community on the same host, or not a relay URL at all.
    for other in [
        "wss://other.example",
        "wss://relay.example/other",
        "wss://relay.example/?community=other",
        "wss://relay.example:8443",
        "ws://relay.example",
        "https://relay.example",
    ] {
        assert!(
            matches!(
                verdict(22242, json!([["relay", other], ["challenge", "c"]]), NOW),
                Verdict::Deny(_)
            ),
            "{other}"
        );
    }
    assert!(matches!(
        verdict(22242, json!([["relay", RELAY]]), NOW),
        Verdict::Deny(_)
    ));
    assert!(matches!(
        verdict(
            22242,
            json!([["relay", RELAY], ["relay", RELAY], ["challenge", "c"]]),
            NOW
        ),
        Verdict::Deny(_)
    ));
    // NIP-98: its origin, any path; one method; no other origin or port.
    assert_eq!(
        verdict(
            27235,
            json!([
                ["u", "https://relay.example:443/media/abc"],
                ["method", "GET"]
            ]),
            NOW + 60
        ),
        Verdict::Sign
    );
    assert!(matches!(
        verdict(
            27235,
            json!([["u", "https://relay.example:8443/"], ["method", "GET"]]),
            NOW
        ),
        Verdict::Deny(_)
    ));
    assert!(matches!(
        verdict(
            27235,
            json!([["u", "https://user@relay.example/"], ["method", "GET"]]),
            NOW
        ),
        Verdict::Deny(_)
    ));
    assert!(matches!(
        verdict(
            27235,
            json!([["u", "http://relay.example/"], ["method", "GET"]]),
            NOW
        ),
        Verdict::Deny(_)
    ));
    assert!(matches!(
        verdict(27235, json!([["u", "https://relay.example/"]]), NOW),
        Verdict::Deny(_)
    ));
    assert!(matches!(
        verdict(
            27235,
            json!([["u", "https://relay.example/"], ["method", "GET"]]),
            NOW - 61
        ),
        Verdict::Deny(_)
    ));
    // Blossom: its server, upload or get, expiring within a minute.
    let blossom = |t: &str, server: &str, expiration: u64| {
        verdict(
            24242,
            json!([
                ["t", t],
                ["server", server],
                ["expiration", expiration.to_string()]
            ]),
            NOW,
        )
    };
    assert_eq!(blossom("upload", "relay.example", NOW + 60), Verdict::Sign);
    assert_eq!(blossom("get", "RELAY.example", NOW), Verdict::Sign);
    assert!(matches!(
        blossom("delete", "relay.example", NOW + 60),
        Verdict::Deny(_)
    ));
    assert!(matches!(
        blossom("get", "cdn.example", NOW + 60),
        Verdict::Deny(_)
    ));
    assert!(matches!(
        blossom("get", "relay.example", NOW + 61),
        Verdict::Deny(_)
    ));
    // A local community over plain WebSockets keeps its port and scheme.
    let local = "ws://localhost:3000";
    let tags_for = tags(json!([
        ["u", "http://localhost:3000/events"],
        ["method", "POST"]
    ]));
    assert_eq!(classify(27235, &tags_for, NOW, NOW, local), Verdict::Sign);
    let tags_for = tags(json!([
        ["u", "http://localhost:3001/events"],
        ["method", "POST"]
    ]));
    assert!(matches!(
        classify(27235, &tags_for, NOW, NOW, local),
        Verdict::Deny(_)
    ));
}

#[test]
fn every_kind_has_one_class() {
    let classes = |kind| classify(kind, &[], NOW, NOW, RELAY);
    for kind in [7, 9, 30174, 20001, 24200, 40002, 41010, 45010, 46020, 1621] {
        assert_eq!(classes(kind), Verdict::Sign, "{kind}");
    }
    for kind in [
        0, 3, 5, 9005, 9044, 10002, 10100, 28936, 30621, 41011, 45011,
    ] {
        assert!(
            matches!(classes(kind), Verdict::Deny(reason) if reason.contains("use Buzz")),
            "{kind}"
        );
    }
    for kind in [1, 4, 1059, 24243, 24245, 30350, 39000] {
        assert!(matches!(classes(kind), Verdict::Deny(_)), "{kind}");
    }
}

#[tokio::test]
async fn encryption_and_memory_addresses_act_as_the_agent() {
    let fixture = fixture();
    let (_issued, token) = bound(&fixture).await;
    let owner = fixture.agent.owner.clone();
    let reply = ask(&fixture, &token, "nip44_encrypt", &[&owner, "secret"]).await;
    let payload = reply.1["result"].as_str().unwrap().to_owned();
    assert_eq!(
        &*fixture.key.nip44_decrypt(&owner, &payload).unwrap(),
        "secret"
    );
    let reply = ask(&fixture, &token, "nip44_decrypt", &[&owner, &payload]).await;
    assert_eq!(reply.1["result"], "secret");
    let reply = ask(&fixture, &token, "nip44_decrypt", &[&owner, "garbage"]).await;
    assert_eq!(error(&reply), (StatusCode::BAD_REQUEST, "invalid_request"));
    // The d tag the app's own memory writes use.
    let written = fixture
        .key
        .memory_event(&owner, "mem/notes", Some("x"), NOW)
        .unwrap();
    let reply = ask(&fixture, &token, "engram_d_tag", &[&owner, "mem/notes"]).await;
    assert_eq!(reply.1["result"], written["tags"][0][1]);
    let reply = ask(&fixture, &token, "engram_d_tag", &[&owner, "Not A Slug"]).await;
    assert_eq!(error(&reply), (StatusCode::BAD_REQUEST, "invalid_request"));
}

#[tokio::test]
async fn evidence_and_auth_tag_come_from_the_agent() {
    let fixture = fixture();
    let (_issued, token) = bound(&fixture).await;
    let reply = ask(&fixture, &token, "auth_tag", &[]).await;
    assert_eq!(reply.1["result"], fixture.agent.auth.as_str());
    // No enterprise sign-in for this relay: no evidence to send.
    let reply = ask(&fixture, &token, "federated_identity", &[RELAY]).await;
    assert_eq!(reply, (StatusCode::OK, json!({ "id": "1", "result": "" })));
    let reply = ask(
        &fixture,
        &token,
        "federated_identity",
        &["wss://Relay.Example/"],
    )
    .await;
    assert_eq!(reply, (StatusCode::OK, json!({ "id": "1", "result": "" })));
    for other in [
        "wss://other.example",
        "wss://relay.example/other",
        "https://relay.example",
    ] {
        let reply = ask(&fixture, &token, "federated_identity", &[other]).await;
        assert_eq!(error(&reply), (StatusCode::FORBIDDEN, "denied"), "{other}");
    }
}

#[tokio::test]
async fn evidence_is_the_bare_assertion_the_cli_prefixes_once() {
    use crate::federated_identity::agent::tests as agent;
    let probe = agent::fixture("http://unused".into());
    let reply = agent::issued(&probe.agent, json!({}));
    let (base, served) = agent::issuer(vec![
        (200, agent::enrolled(&probe.agent.owner)),
        (200, reply),
    ])
    .await;
    let signed_in = agent::fixture(base);
    let (agent_row, key) = (probe.agent, probe.key);
    let fixture = fixture_with(
        agent_row,
        key,
        FederatedIdentity::unconfigured(),
        signed_in.tokens.clone(),
    );
    let (_issued, token) = bound(&fixture).await;
    let reply = ask(&fixture, &token, "federated_identity", &[RELAY]).await;
    let jwt = reply.1["result"].as_str().unwrap().to_owned();
    assert_eq!(jwt.split('.').count(), 3, "a compact JWT: {jwt}");
    assert!(!jwt.contains(' '), "no scheme: {jwt}");
    // What the CLI sends: exactly one scheme in front of the assertion.
    let header = format!("Bearer {jwt}");
    assert_eq!(header.matches("Bearer ").count(), 1);
    assert_eq!(agent::settled(served).await.len(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_token_is_rate_limited_and_recovers() {
    let fixture = fixture();
    let (_issued, token) = bound(&fixture).await;
    for _ in 0..BURST as usize {
        assert_eq!(
            ask(&fixture, &token, "get_public_key", &[]).await.0,
            StatusCode::OK
        );
    }
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(
        error(&reply),
        (StatusCode::TOO_MANY_REQUESTS, "rate_limited")
    );
    assert_eq!(reply.1["retry_after"], 1);
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(
        ask(&fixture, &token, "get_public_key", &[]).await.0,
        StatusCode::OK
    );
}

#[tokio::test(start_paused = true)]
async fn each_method_has_its_own_rate_budget() {
    let fixture = fixture();
    let (_issued, token) = bound(&fixture).await;
    for _ in 0..BURST as usize {
        ask(&fixture, &token, "get_public_key", &[]).await;
    }
    assert_eq!(
        error(&ask(&fixture, &token, "get_public_key", &[]).await),
        (StatusCode::TOO_MANY_REQUESTS, "rate_limited")
    );
    assert_eq!(
        ask(&fixture, &token, "auth_tag", &[]).await.0,
        StatusCode::OK
    );
}

/// After the identity closes for good, a spawn that reaches `issue` gets no
/// token, and a token issued or bound before it never acts again.
#[tokio::test]
async fn a_closed_identity_issues_binds_and_acts_for_nobody() {
    let fixture = fixture();
    let (acting, acting_token) = bound(&fixture).await;
    let (spare, _) = issued(&fixture).await;
    fixture.identity.close();
    assert!(fixture.service.issue().await.is_err());
    assert!(fixture
        .service
        .bind(
            &spare,
            "p",
            None,
            fixture.agent.pubkey.clone(),
            RELAY.into()
        )
        .await
        .is_err());
    let reply = ask(&fixture, &acting_token, "get_public_key", &[]).await;
    assert_eq!(error(&reply), (StatusCode::UNAUTHORIZED, "revoked"));
    drop(acting);
}

#[tokio::test]
async fn the_listener_answers_only_its_callers() {
    let fixture = fixture();
    let (_issued, env) = fixture.service.issue().await.unwrap().unwrap();
    let value: Value = serde_json::from_str(&env).unwrap();
    let (url, token) = (
        value["url"].as_str().unwrap(),
        value["token"].as_str().unwrap(),
    );
    let client = reqwest::Client::new();
    let body = json!({ "id": "1", "method": "describe", "params": [] }).to_string();
    let post = |url: &str| {
        client
            .post(url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Buzz-Credential-Provider", "1")
            .header("Content-Type", "application/json")
            .body(body.clone())
    };
    // An unbound token, but a caller: answered in the envelope.
    let reply = post(url).send().await.unwrap();
    assert_eq!(reply.status(), StatusCode::SERVICE_UNAVAILABLE.as_u16());
    assert_eq!(reply.headers()["cache-control"], "no-store");
    let reply: Value = serde_json::from_slice(&reply.bytes().await.unwrap()).unwrap();
    assert_eq!(reply["error"], "unavailable");
    // A web page, another host name, or another path hears nothing.
    let page = post(url)
        .header("Origin", "https://evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(page.status(), 404);
    assert!(page.bytes().await.unwrap().is_empty());
    let host = post(url).header("Host", "localhost").send().await.unwrap();
    assert_eq!(host.status(), 404);
    let path = post(&url.replace("/v1", "/v2")).send().await.unwrap();
    assert_eq!(path.status(), 404);
    let get = client.get(url).send().await.unwrap();
    assert_eq!(get.status(), 405);
}

/// Run only inside the re-launched copy below, never in the shared test runner.
#[test]
fn inherited_child() {
    if std::env::var_os("BUZZ_TEST_INHERITED_CHILD").is_none() {
        return;
    }
    drop_inherited();
    let child = std::process::Command::new("sh")
        .args(["-c", "printf %s \"${BUZZ_CREDENTIAL_PROVIDER-unset}\""])
        .output()
        .unwrap();
    print!("child saw [{}]", String::from_utf8_lossy(&child.stdout));
}

#[test]
fn a_launch_token_reaches_no_child_the_app_spawns() {
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "credential_service::tests::inherited_child",
            "--nocapture",
        ])
        .env("BUZZ_TEST_INHERITED_CHILD", "1")
        .env(ENV, "sentinel-token")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{stdout}");
    assert!(stdout.contains("child saw [unset]"), "{stdout}");
}

mod pairing;
