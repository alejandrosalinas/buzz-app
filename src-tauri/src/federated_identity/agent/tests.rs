use super::grant::tests::MemoryGrants;
use super::*;
use crate::federated_identity::tests::{at_adapter, record, Memory};

pub(crate) struct Seen {
    pub(crate) target: String,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Vec<u8>,
}

/// Answers each request with the next `(status, body)`, then reports them.
pub(crate) async fn issuer(
    replies: Vec<(u16, serde_json::Value)>,
) -> (String, tokio::task::JoinHandle<Vec<Seen>>) {
    issuer_gated(replies, usize::MAX, None).await
}

/// Like `issuer`, but signals `held` on reading request `at` and answers it
/// only once `release` fires: a request held in flight, without sleeps.
pub(crate) async fn issuer_gated(
    replies: Vec<(u16, serde_json::Value)>,
    at: usize,
    gate: Option<(
        tokio::sync::oneshot::Sender<()>,
        tokio::sync::oneshot::Receiver<()>,
    )>,
) -> (String, tokio::task::JoinHandle<Vec<Seen>>) {
    let mut gate = gate;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/mount", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut seen = Vec::new();
        for (index, (status, reply)) in replies.into_iter().enumerate() {
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
            seen.push(Seen {
                target,
                headers,
                body,
            });
            if index == at {
                let (held, release) = gate.take().unwrap();
                held.send(()).unwrap();
                release.await.unwrap();
            }
            let reply = reply.to_string();
            let response = format!(
                "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
        seen
    });
    (base, task)
}

/// A failure bound, never an ordering: a regression that stops the issuer
/// short of its script fails with this message instead of hanging the suite.
pub(crate) async fn bounded<F: std::future::Future>(wait: F) -> F::Output {
    tokio::time::timeout(std::time::Duration::from_secs(10), wait)
        .await
        .expect("the scripted exchange never happened")
}
/// The requests the issuer served, once its whole script has been answered.
pub(crate) async fn settled(served: tokio::task::JoinHandle<Vec<Seen>>) -> Vec<Seen> {
    bounded(served).await.unwrap()
}

pub(crate) struct Fixture {
    pub(crate) tokens: AgentTokens,
    pub(crate) grants: Arc<MemoryGrants>,
    session_store: Arc<Memory>,
    pub(crate) agent: AppAgent,
    pub(crate) key: Secret,
}
/// Tokens over `identity`, whose fixture community advertises NIP-FI.
pub(crate) fn requiring(identity: FederatedIdentity, grants: Arc<MemoryGrants>) -> AgentTokens {
    let advertised = identity
        .0
        .discoveries
        .lock()
        .unwrap()
        .contains_key("wss://relay.example");
    if !advertised {
        identity.discovered("wss://relay.example", true);
    }
    AgentTokens::with_store(identity, grants)
}
/// An owner signed in as `a@example.com` at `base`, and one agent.
pub(crate) fn fixture(base: String) -> Fixture {
    fixture_at(base, "relay.example")
}
/// `fixture`, with the organization's community, and the agent, at `community`.
pub(crate) fn fixture_at(base: String, community: &str) -> Fixture {
    let session_store = Arc::new(Memory::default());
    let mut identity = at_adapter(session_store.clone(), base);
    Arc::get_mut(&mut identity.0)
        .unwrap()
        .config
        .as_mut()
        .unwrap()
        .community_hosts = vec![community.into()];
    let mut session = record();
    Arc::get_mut(&mut session).unwrap().record.email = Some("a@example.com".into());
    {
        // Signed in through account tracking, so a later account is a change.
        let mut state = identity.state();
        state.session = Some(session);
        state.account = Some(Some("a@example.com".into()));
    }
    identity.discovered(&format!("wss://{community}"), true);
    let grants = Arc::new(MemoryGrants::default());
    let key = Secret::generate().unwrap();
    let agent = AppAgent {
        pubkey: key.pubkey().into(),
        relay: format!("wss://{community}"),
        owner: "b".repeat(64),
        auth: r#"["auth","owner","conditions","sig"]"#.into(),
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
    Fixture {
        tokens: requiring(identity, grants.clone()),
        grants,
        session_store,
        agent,
        key,
    }
}
pub(crate) fn enrolled(owner: &str) -> serde_json::Value {
    serde_json::json!({
        "access_token": "grant-1",
        "issued_token_type": GRANT_TOKEN_TYPE,
        "token_type": "N_A",
        "expires_in": 691200,
        "nostr_owner_pubkey": owner,
        "nip_fi_issuer": "https://issuer.example",
    })
}

#[tokio::test]
async fn enrollment_exchanges_the_owner_session_with_only_the_agent_proof() {
    let (base, served) = issuer(vec![(200, enrolled(&"b".repeat(64)))]).await;
    let f = fixture(base);
    let admitted = f.tokens.admit().await.unwrap();
    let grant = f.tokens.grant(&f.agent, &f.key, admitted).await.unwrap();
    assert_eq!(
        (grant.token.as_str(), grant.account.as_str()),
        ("grant-1", "a@example.com")
    );
    // Stored, so a second use does not enroll again.
    assert!(f.tokens.grant(&f.agent, &f.key, admitted).await.is_ok());

    let seen = settled(served).await;
    assert_eq!(seen.len(), 1);
    let wire = &seen[0];
    assert_eq!(wire.target, "POST /mount/v1/nip-fi/agent-grant HTTP/1.1");
    let fields: Vec<(String, String)> = url::form_urlencoded::parse(&wire.body)
        .into_owned()
        .collect();
    let field = |name: &str| fields.iter().find(|(n, _)| n == name).unwrap().1.clone();
    assert_eq!(fields.len(), 7);
    assert_eq!(field("subject_token"), "fixture-session-token");
    assert_eq!(field("agent_pubkey"), f.agent.pubkey);
    assert_eq!(field("runtime"), "local");
    assert_eq!(field("owner_attestation"), f.agent.auth);
    assert_eq!(field("requested_token_type"), GRANT_TOKEN_TYPE);
    for ambient in ["authorization", "cookie", "x-bb-session"] {
        assert!(wire.headers.iter().all(|(name, _)| name != ambient));
    }
    let proof = &wire
        .headers
        .iter()
        .find(|(n, _)| n == "nostr-agent-proof")
        .unwrap()
        .1;
    let proof: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(&proof["Nostr ".len()..]).unwrap()).unwrap();
    assert_eq!(proof["pubkey"], f.agent.pubkey.as_str());
    let u = proof["tags"][0][1].as_str().unwrap();
    assert!(u.ends_with("/mount/v1/nip-fi/agent-grant"));
    use sha2::{Digest, Sha256};
    assert_eq!(
        proof["tags"][2][1],
        format!("{:x}", Sha256::digest(&wire.body)).as_str()
    );
}

#[tokio::test]
async fn enrollment_needs_a_session_and_refuses_another_owner() {
    let (base, served) = issuer(vec![(200, enrolled(&"c".repeat(64)))]).await;
    let f = fixture(base);
    f.tokens.admit().await.unwrap();
    assert!(f.tokens.grant(&f.agent, &f.key, 0).await.is_err());
    assert!(f
        .grants
        .read(&f.tokens.grant_key(&f.agent))
        .unwrap()
        .unwrap()
        .token
        .is_empty());
    settled(served).await;

    f.tokens.0.identity.state().session = None;
    assert_eq!(
        f.tokens
            .grant(&f.agent, &f.key, 0)
            .await
            .err()
            .map(|e| e.message),
        Some(SIGN_IN.into())
    );
}

pub(crate) fn jwt(agent: &AppAgent, claims: serde_json::Value) -> String {
    let now = now().unwrap() as u64;
    let mut base = serde_json::json!({
        "iss": "https://issuer.example",
        "aud": "https://relay.example",
        "nostr_pubkey": agent.pubkey,
        "nostr_owner_pubkey": agent.owner,
        "iat": now,
        "exp": now + 300,
    });
    for (name, value) in claims.as_object().unwrap() {
        base[name] = value.clone();
    }
    format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(br#"{"typ":"nip-fi-agent+jwt","alg":"ES256"}"#),
        URL_SAFE_NO_PAD.encode(base.to_string())
    )
}
pub(crate) fn issued(agent: &AppAgent, claims: serde_json::Value) -> serde_json::Value {
    let token = jwt(agent, claims);
    let exp = serde_json::from_slice::<serde_json::Value>(
        &URL_SAFE_NO_PAD
            .decode(token.split('.').nth(1).unwrap())
            .unwrap(),
    )
    .unwrap()["exp"]
        .clone();
    serde_json::json!({ "assertion": token, "nostr_pubkey": agent.pubkey, "expires_at": exp })
}

#[tokio::test]
async fn an_agent_assertion_is_minted_with_the_grant_validated_and_reused() {
    let key = Secret::generate().unwrap();
    let mut probe = fixture("http://unused".into()).agent;
    probe.pubkey = key.pubkey().into();
    let reply = issued(&probe, serde_json::json!({}));
    let (base, served) = issuer(vec![(200, enrolled(&"b".repeat(64))), (200, reply)]).await;
    let mut f = fixture(base);
    f.agent.pubkey = key.pubkey().into();
    f.key = key;

    let first = f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .unwrap();
    assert!(first.starts_with("Bearer ") && first.contains('.'));
    let again = f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(*first, *again);

    let seen = settled(served).await;
    assert_eq!(seen.len(), 2, "the cached assertion is reused");
    let mint = &seen[1];
    assert_eq!(
        mint.target,
        "POST /mount/v1/nip-fi/agent-assertion HTTP/1.1"
    );
    let header = |name: &str| {
        mint.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(header("authorization"), Some("Bearer grant-1"));
    assert!(header("nostr-authorization").unwrap().starts_with("Nostr "));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&mint.body).unwrap(),
        serde_json::json!({ "nostr_pubkey": f.agent.pubkey, "relay_url": "wss://relay.example" })
    );
}

#[tokio::test]
async fn evidence_needed_for_longer_replaces_a_cached_assertion_expiring_sooner() {
    let key = Secret::generate().unwrap();
    let mut probe = fixture("http://unused".into()).agent;
    probe.pubkey = key.pubkey().into();
    let now = super::now().unwrap() as u64;
    let short = issued(&probe, serde_json::json!({ "exp": now + 60 }));
    let long = issued(&probe, serde_json::json!({}));
    let (base, served) = issuer(vec![
        (200, enrolled(&"b".repeat(64))),
        (200, short),
        (200, long),
    ])
    .await;
    let mut f = fixture(base);
    f.agent.pubkey = key.pubkey().into();
    f.key = key;
    let header = |admission: Admission| admission.header().unwrap().to_owned();

    let first = header(
        f.tokens
            .authorize(&f.agent, &f.key, Stamp::default())
            .await
            .unwrap(),
    );
    // A minute left is enough for one request now, so it is reused for that.
    let again = header(
        f.tokens
            .authorize(&f.agent, &f.key, Stamp::default())
            .await
            .unwrap(),
    );
    assert_eq!(first, again);
    let lasting = header(
        f.tokens
            .authorize_for(&f.agent, &f.key, Stamp::default(), Duration::from_secs(70))
            .await
            .unwrap(),
    );
    assert_ne!(
        first, lasting,
        "a header that must outlast it is minted anew"
    );
    assert_eq!(settled(served).await.len(), 3);
}

#[tokio::test]
async fn evidence_minted_shorter_than_needed_is_refused() {
    let key = Secret::generate().unwrap();
    let mut probe = fixture("http://unused".into()).agent;
    probe.pubkey = key.pubkey().into();
    let now = super::now().unwrap() as u64;
    let short = issued(&probe, serde_json::json!({ "exp": now + 60 }));
    let (base, served) = issuer(vec![(200, enrolled(&"b".repeat(64))), (200, short)]).await;
    let mut f = fixture(base);
    f.agent.pubkey = key.pubkey().into();
    f.key = key;

    let error = f
        .tokens
        .authorize_for(&f.agent, &f.key, Stamp::default(), Duration::from_secs(70))
        .await
        .err()
        .expect("a header that would expire mid-command is refused");
    assert_eq!(error, super::SHORT_LIVED);
    // The same assertion still serves a request made now.
    assert!(f
        .tokens
        .authorize(&f.agent, &f.key, Stamp::default())
        .await
        .unwrap()
        .header()
        .is_some());
    assert_eq!(settled(served).await.len(), 2);
}

#[test]
fn agent_assertions_must_name_this_agent_owner_issuer_and_community() {
    let f = fixture("http://unused".into());
    let grant = Grant::new(
        f.agent.owner.clone(),
        f.agent.pubkey.clone(),
        "a@example.com".into(),
        "https://issuer.example".into(),
        "g".into(),
    );
    let now = now().unwrap() as u64;
    let check = |claims: serde_json::Value| {
        let token = jwt(&f.agent, claims);
        validate(
            &token,
            &f.agent,
            &grant,
            "wss://relay.example",
            now + 300,
            now,
        )
    };
    assert!(check(serde_json::json!({})).is_ok());
    for wrong in [
        serde_json::json!({ "nostr_pubkey": "c".repeat(64) }),
        serde_json::json!({ "nostr_owner_pubkey": "c".repeat(64) }),
        serde_json::json!({ "iss": "https://other.example" }),
        serde_json::json!({ "aud": "https://other.example" }),
        serde_json::json!({ "exp": now + 299 }),
        serde_json::json!({ "iat": now + 60 }),
    ] {
        assert!(check(wrong).is_err());
    }
    let human = format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(br#"{"typ":"nip-fi+jwt"}"#),
        jwt(&f.agent, serde_json::json!({}))
            .split('.')
            .nth(1)
            .unwrap()
    );
    assert!(validate(
        &human,
        &f.agent,
        &grant,
        "wss://relay.example",
        now + 300,
        now
    )
    .is_err());
}

#[tokio::test]
async fn a_community_outside_the_organization_gets_no_assertion() {
    let mut f = fixture("http://unused".into());
    f.agent.relay = "wss://elsewhere.example".into();
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_none());
}

fn refused_grant() -> (u16, serde_json::Value) {
    (401, serde_json::json!({ "error": "invalid_grant" }))
}

#[tokio::test]
async fn a_refused_grant_is_replaced_once_then_the_agent_stops() {
    let key = Secret::generate().unwrap();
    let mut probe = fixture("http://unused".into()).agent;
    probe.pubkey = key.pubkey().into();
    let owner = "b".repeat(64);
    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        refused_grant(),
        (200, enrolled(&owner)),
        (200, issued(&probe, serde_json::json!({}))),
    ])
    .await;
    let mut f = fixture(base);
    f.agent.pubkey = key.pubkey().into();
    f.key = key;
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    let seen = settled(served).await;
    assert!(seen[2].target.contains("agent-grant"), "re-enrolled once");
    assert_eq!(f.grants.0.lock().unwrap().len(), 1);

    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        refused_grant(),
        (200, enrolled(&owner)),
        refused_grant(),
    ])
    .await;
    let f = fixture(base);
    assert_eq!(
        f.tokens
            .evidence(&f.agent, &f.key, 0)
            .await
            .err()
            .as_deref(),
        Some(STOPPED)
    );
    // Stopped: no further enrollment or mint is attempted.
    assert_eq!(
        f.tokens
            .evidence(&f.agent, &f.key, 0)
            .await
            .err()
            .as_deref(),
        Some(STOPPED)
    );
    assert_eq!(settled(served).await.len(), 4);
    let stopped = f
        .grants
        .read(&f.tokens.grant_key(&f.agent))
        .unwrap()
        .unwrap();
    assert!(stopped.token.is_empty(), "no refused token is kept");
    assert!(stopped.stopped.is_some(), "terminal stop survives restart");
}

#[tokio::test]
async fn concurrent_refusals_share_the_one_re_enrollment() {
    let owner = "b".repeat(64);
    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        refused_grant(),
        (200, enrolled(&owner)),
        refused_grant(),
    ])
    .await;
    let f = fixture(base);
    let (a, b) = tokio::join!(
        f.tokens.evidence(&f.agent, &f.key, 0),
        f.tokens.evidence(&f.agent, &f.key, 0)
    );
    assert_eq!(a.err().as_deref(), Some(STOPPED));
    assert_eq!(b.err().as_deref(), Some(STOPPED));
    assert_eq!(settled(served).await.len(), 4);
}

#[tokio::test]
async fn an_unreachable_issuer_during_recovery_does_not_stop_the_agent() {
    let key = Secret::generate().unwrap();
    let mut probe = fixture("http://unused".into()).agent;
    probe.pubkey = key.pubkey().into();
    let owner = "b".repeat(64);
    let unavailable = || (503, serde_json::json!({ "error": "issuance_unavailable" }));
    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        refused_grant(),
        unavailable(),
        unavailable(),
        unavailable(),
        (200, enrolled(&owner)),
        (200, issued(&probe, serde_json::json!({}))),
    ])
    .await;
    let mut f = fixture(base);
    f.agent.pubkey = key.pubkey().into();
    f.key = key;
    let failed = f.tokens.evidence(&f.agent, &f.key, 0).await.unwrap_err();
    assert_ne!(failed, STOPPED);
    let pending = f
        .grants
        .read(&f.tokens.grant_key(&f.agent))
        .unwrap()
        .unwrap();
    assert!(pending.token.is_empty(), "the refused token is gone");
    assert!(pending.replacement && pending.stopped.is_none());
    // The next request resumes the same one replacement.
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    assert_eq!(settled(served).await.len(), 7);
}

fn signed_in_again(f: &Fixture, email: &str) {
    let identity = &f.tokens.0.identity;
    let mut session = record();
    Arc::get_mut(&mut session).unwrap().record.email = Some(email.into());
    let mut state = identity.state();
    state.session = Some(session);
    identity.signed_in(&mut state, Some(email.into()));
}
/// Lists the fixture's agent, as the agent host does, without the watcher.
fn listing(f: &Fixture) {
    let listed = (f.agent.owner.clone(), f.agent.pubkey.clone());
    let _ = f
        .tokens
        .0
        .agents
        .set(Arc::new(move || Ok(vec![listed.clone()])));
}
fn keyed(owner: &str) -> (Secret, AppAgent) {
    let key = Secret::generate().unwrap();
    let mut agent = fixture("http://unused".into()).agent;
    agent.pubkey = key.pubkey().into();
    agent.owner = owner.into();
    (key, agent)
}

#[tokio::test]
async fn sign_out_then_sign_in_before_the_watcher_runs_retires_cached_and_stored_credentials() {
    let owner = "b".repeat(64);
    let (key, probe) = keyed(&owner);
    let mint = || (200, issued(&probe, serde_json::json!({})));
    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        mint(),
        (200, enrolled(&owner)),
        mint(),
    ])
    .await;
    let mut f = fixture(base);
    (f.agent, f.key) = (probe.clone(), key);
    listing(&f);
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());

    // The watcher would only see `Refreshed`: the sign-out was overwritten.
    f.tokens.0.identity.sign_out(None).await;
    signed_in_again(&f, "a@example.com");
    assert_eq!(
        f.tokens.0.identity.account_changes().borrow().clone(),
        Some(SessionChange::Refreshed)
    );

    // Neither the cached assertion nor the stored grant is reused.
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    let seen = settled(served).await;
    assert!(seen[2].target.contains("agent-grant"), "enrolled anew");
    assert_eq!(seen.len(), 4);
}

#[tokio::test]
async fn a_new_account_retires_the_cached_assertion() {
    let owner = "b".repeat(64);
    let (key, probe) = keyed(&owner);
    let mint = || (200, issued(&probe, serde_json::json!({})));
    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        mint(),
        (200, enrolled(&owner)),
        mint(),
    ])
    .await;
    let mut f = fixture(base);
    (f.agent, f.key) = (probe.clone(), key);
    listing(&f);
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    signed_in_again(&f, "b@example.com");
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    assert_eq!(settled(served).await.len(), 4);
}

#[tokio::test]
async fn expiry_and_same_account_refresh_keep_the_grant_and_assertion() {
    let owner = "b".repeat(64);
    let (key, probe) = keyed(&owner);
    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        (200, issued(&probe, serde_json::json!({}))),
    ])
    .await;
    let mut f = fixture(base);
    (f.agent, f.key) = (probe.clone(), key);
    listing(&f);
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    let identity = &f.tokens.0.identity;
    identity.retire(
        crate::federated_identity::Status::ReauthenticationRequired,
        None,
    );
    identity.signal(SessionChange::Expired);
    signed_in_again(&f, "a@example.com");
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    assert_eq!(settled(served).await.len(), 2);
    assert_eq!(f.grants.0.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_mint_in_flight_across_sign_out_is_neither_returned_nor_cached() {
    let owner = "b".repeat(64);
    let (key, probe) = keyed(&owner);
    let (held_tx, held) = tokio::sync::oneshot::channel();
    let (release, release_rx) = tokio::sync::oneshot::channel();
    let (base, served) = issuer_gated(
        vec![
            (200, enrolled(&owner)),
            (200, issued(&probe, serde_json::json!({}))),
        ],
        1,
        Some((held_tx, release_rx)),
    )
    .await;
    let mut f = fixture(base);
    (f.agent, f.key) = (probe.clone(), key);
    listing(&f);
    let f = Arc::new(f);
    let call = {
        let f = f.clone();
        tokio::spawn(async move { f.tokens.evidence(&f.agent, &f.key, 0).await })
    };
    bounded(held).await.unwrap();
    f.tokens.0.identity.sign_out(None).await;
    release.send(()).unwrap();
    assert_eq!(call.await.unwrap().err().as_deref(), Some(CHANGED));
    assert!(f
        .tokens
        .slot(&f.agent.pubkey)
        .lock()
        .await
        .assertion
        .is_none());
    settled(served).await;
    // The next request is admitted only after the wipe.
    assert!(f.tokens.evidence(&f.agent, &f.key, 0).await.is_err());
    assert!(
        f.grants.0.lock().unwrap().is_empty(),
        "the old grant is wiped"
    );
}

#[tokio::test]
async fn an_enrollment_committing_after_sign_out_stores_nothing() {
    let f = fixture("http://unused".into());
    listing(&f);
    let retirements = f.tokens.admit().await.unwrap();
    f.tokens.0.identity.sign_out(None).await;
    let grant = Grant::new(
        f.agent.owner.clone(),
        f.agent.pubkey.clone(),
        "a@example.com".into(),
        "https://issuer.example".into(),
        "g".into(),
    );
    assert_eq!(
        f.tokens
            .commit(&f.agent, grant, retirements)
            .await
            .err()
            .as_deref(),
        Some(CHANGED)
    );
    assert!(f.grants.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn deletion_refuses_requests_already_queued_for_the_agent() {
    let owner = "b".repeat(64);
    let (key, probe) = keyed(&owner);
    let (held_tx, held) = tokio::sync::oneshot::channel();
    let (release, release_rx) = tokio::sync::oneshot::channel();
    let (base, served) = issuer_gated(
        vec![
            (200, enrolled(&owner)),
            (200, issued(&probe, serde_json::json!({}))),
        ],
        0,
        Some((held_tx, release_rx)),
    )
    .await;
    let mut f = fixture(base);
    (f.agent, f.key) = (probe.clone(), key);
    let f = Arc::new(f);
    let spawn_evidence = || {
        let f = f.clone();
        tokio::spawn(async move { f.tokens.evidence(&f.agent, &f.key, 0).await })
    };
    // One request enrolls; deletion and a stale request queue behind it.
    let first = spawn_evidence();
    bounded(held).await.unwrap();
    let forget = {
        let f = f.clone();
        tokio::spawn(async move { f.tokens.forget(&f.agent.owner, &f.agent.pubkey).await })
    };
    // Deletion closes the agent before it waits for the request in flight.
    bounded(async {
        while !f.tokens.closed(&f.agent.pubkey) {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let stale = spawn_evidence();
    release.send(()).unwrap();
    // The request in flight settles refused too: its agent is gone.
    assert_eq!(first.await.unwrap().err().as_deref(), Some(DELETED));
    forget.await.unwrap().unwrap();
    assert_eq!(stale.await.unwrap().err().as_deref(), Some(DELETED));
    assert_eq!(
        settled(served).await.len(),
        2,
        "no enrollment after deletion"
    );
    assert!(f.grants.0.lock().unwrap().is_empty());
    assert_eq!(
        f.tokens
            .evidence(&f.agent, &f.key, 0)
            .await
            .err()
            .as_deref(),
        Some(DELETED)
    );
}

#[tokio::test]
async fn a_replacement_refused_after_a_transient_failure_stops_without_a_second_exchange() {
    let owner = "b".repeat(64);
    let unavailable = || (503, serde_json::json!({ "error": "issuance_unavailable" }));
    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        refused_grant(),
        (200, enrolled(&owner)),
        unavailable(),
        unavailable(),
        unavailable(),
        refused_grant(),
    ])
    .await;
    let f = fixture(base);
    let failed = f.tokens.evidence(&f.agent, &f.key, 0).await.unwrap_err();
    assert_ne!(failed, STOPPED);
    let at = f.tokens.grant_key(&f.agent);
    assert!(f.grants.read(&at).unwrap().unwrap().replacement);
    let (a, b) = tokio::join!(
        f.tokens.evidence(&f.agent, &f.key, 0),
        f.tokens.evidence(&f.agent, &f.key, 0)
    );
    assert_eq!(a.err().as_deref(), Some(STOPPED));
    assert_eq!(b.err().as_deref(), Some(STOPPED));
    assert_eq!(
        settled(served).await.len(),
        7,
        "one exchange, no third grant"
    );
    let stopped = f
        .grants
        .read(&f.tokens.grant_key(&f.agent))
        .unwrap()
        .unwrap();
    assert!(stopped.token.is_empty() && stopped.stopped.is_some());
}

#[tokio::test]
async fn a_replacement_that_mints_after_a_transient_failure_becomes_ordinary() {
    let owner = "b".repeat(64);
    let (key, probe) = keyed(&owner);
    let unavailable = || (503, serde_json::json!({ "error": "issuance_unavailable" }));
    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        refused_grant(),
        (200, enrolled(&owner)),
        unavailable(),
        unavailable(),
        unavailable(),
        (200, issued(&probe, serde_json::json!({}))),
    ])
    .await;
    let mut f = fixture(base);
    (f.agent, f.key) = (probe.clone(), key);
    assert!(f.tokens.evidence(&f.agent, &f.key, 0).await.is_err());
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    assert_eq!(settled(served).await.len(), 7, "no second exchange");
    let at = f.tokens.grant_key(&f.agent);
    assert!(!f.grants.read(&at).unwrap().unwrap().replacement);
}

#[tokio::test]
async fn a_new_sign_in_lifts_a_stop_and_deletion_retires_the_grant() {
    let (base, served) = issuer(vec![(200, enrolled(&"b".repeat(64)))]).await;
    let f = fixture(base);
    listing(&f);
    let at = f.tokens.grant_key(&f.agent);
    let mut grant = Grant::new(
        f.agent.owner.clone(),
        f.agent.pubkey.clone(),
        "a@example.com".into(),
        String::new(),
        String::new(),
    );
    grant.stopped = Some(
        f.tokens
            .0
            .identity
            .state()
            .session
            .as_ref()
            .unwrap()
            .record
            .revision
            .clone(),
    );
    f.grants.write(&at, &grant).unwrap();
    signed_in_again(&f, "a@example.com");
    f.tokens
        .follow(Some(SessionChange::Refreshed))
        .await
        .unwrap();
    let admitted = f.tokens.admit().await.unwrap();
    let renewed = f.tokens.grant(&f.agent, &f.key, admitted).await.unwrap();
    assert_eq!(renewed.token, "grant-1");
    f.tokens
        .forget(&f.agent.owner, &f.agent.pubkey)
        .await
        .unwrap();
    assert!(
        f.grants.0.lock().unwrap().is_empty(),
        "deletion retires the grant and stop"
    );
    assert_eq!(settled(served).await.len(), 1);
}

/// A grant for the fixture's agent, enrolled by `account`, stored directly.
fn stored(f: &Fixture, account: &str) {
    let grant = Grant::new(
        f.agent.owner.clone(),
        f.agent.pubkey.clone(),
        account.into(),
        "https://issuer.example".into(),
        "g".into(),
    );
    f.grants
        .write(&f.tokens.grant_key(&f.agent), &grant)
        .unwrap();
}
/// A new process over the same profile's storage: nothing in memory, no
/// session restored yet.
fn restarted(f: &Fixture, base: String) -> AgentTokens {
    let fresh = fixture(base);
    {
        let mut state = fresh.tokens.0.identity.state();
        state.session = None;
        state.account = None;
    }
    let tokens = requiring(fresh.tokens.0.identity.clone(), f.grants.clone());
    let listed = (f.agent.owner.clone(), f.agent.pubkey.clone());
    let _ = tokens
        .0
        .agents
        .set(Arc::new(move || Ok(vec![listed.clone()])));
    tokens
}

#[tokio::test]
async fn an_organization_sign_out_revokes_its_session_at_the_server() {
    use crate::federated_identity::tests::{logout_request, revoked};
    let logout = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = crate::federated_identity::testing::signed_in_at(format!(
        "http://{}",
        logout.local_addr().unwrap()
    ));
    let tokens = AgentTokens::with_store(identity.clone(), Arc::new(MemoryGrants::default()));
    let _ = tokens.0.agents.set(Arc::new(|| Ok(Vec::new())));
    let snapshot = tokens.sign_out(None).await.unwrap();
    assert!(snapshot.status == crate::federated_identity::Status::SignedOut);
    let (credential, _) = logout_request(&logout).await;
    assert_eq!(credential, "fixture-session-token");
    assert_eq!(bounded(revoked(&identity)).await, 1);
}

#[tokio::test]
async fn an_organization_sign_out_whose_grant_deletion_fails_resumes_it_after_restart() {
    let (base, served) = issuer(vec![]).await;
    let f = fixture(base.clone());
    listing(&f);
    stored(&f, "a@example.com");
    f.grants.failing(true);
    assert!(f.tokens.sign_out(None).await.is_err());

    // Restarted before the cleanup finished: the grant is neither used nor
    // restored while it cannot be deleted.
    let tokens = restarted(&f, base);
    assert!(tokens.evidence(&f.agent, &f.key, 0).await.is_err());
    assert!(f
        .grants
        .0
        .lock()
        .unwrap()
        .contains_key(&f.tokens.grant_key(&f.agent)));
    // The next attempt finishes the cleanup first, then has nothing to use.
    f.grants.failing(false);
    assert_eq!(
        tokens.evidence(&f.agent, &f.key, 0).await.err().as_deref(),
        Some(SIGN_IN)
    );
    assert!(
        f.grants.0.lock().unwrap().is_empty(),
        "grant and record wiped"
    );
    assert!(
        settled(served).await.is_empty(),
        "no grant or assertion call"
    );
}

#[tokio::test]
async fn a_grant_write_past_its_check_does_not_survive_a_concurrent_sign_out() {
    let f = Arc::new(fixture("http://unused".into()));
    listing(&f);
    let retirements = f.tokens.admit().await.unwrap();
    let (held_tx, held) = std::sync::mpsc::channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    f.grants.gate((held_tx, release_rx));
    let grant = Grant::new(
        f.agent.owner.clone(),
        f.agent.pubkey.clone(),
        "a@example.com".into(),
        "https://issuer.example".into(),
        "g".into(),
    );
    let write = {
        let f = f.clone();
        tokio::spawn(async move { f.tokens.commit(&f.agent, grant, retirements).await })
    };
    bounded(tokio::task::spawn_blocking(move || held.recv()))
        .await
        .unwrap()
        .unwrap();
    // The write has passed its check. Sign-out runs until it waits on the
    // transaction the write holds; only then is the write released. Were the
    // two not one transaction, sign-out would finish first and the write would
    // land after its wipe.
    let (contended_tx, contended) = std::sync::mpsc::channel();
    *f.tokens.0.contended.lock().unwrap() = Some(contended_tx);
    let sign_out = {
        let f = f.clone();
        tokio::spawn(async move { f.tokens.sign_out(None).await })
    };
    // Sign-out drops the sender unsignalled if it never waits.
    let waited = bounded(tokio::task::spawn_blocking(move || {
        contended.recv().is_ok()
    }))
    .await
    .unwrap();
    release.send(()).unwrap();
    assert!(write.await.unwrap().is_ok());
    assert!(waited, "sign-out did not wait for the write's transaction");
    assert!(bounded(sign_out).await.unwrap().is_ok());
    assert!(
        f.grants.0.lock().unwrap().is_empty(),
        "no retired grant survives"
    );
}

#[tokio::test]
async fn another_account_as_the_first_sign_in_after_restart_retires_the_cached_grant() {
    let owner = "b".repeat(64);
    let (key, probe) = keyed(&owner);
    let mint = || (200, issued(&probe, serde_json::json!({})));
    let (base, served) = issuer(vec![mint(), (200, enrolled(&owner)), mint()]).await;
    let mut f = fixture(base.clone());
    (f.agent, f.key) = (probe.clone(), key);
    stored(&f, "a@example.com");
    let tokens = restarted(&f, base);
    // With no session restored, A's grant mints as it should.
    assert!(tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());

    let f = Fixture { tokens, ..f };
    signed_in_again(&f, "b@example.com");
    assert_eq!(
        f.tokens.0.identity.account_changes().borrow().clone(),
        Some(SessionChange::Refreshed),
        "the process saw no account before B"
    );
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    let seen = settled(served).await;
    assert!(seen[1].target.contains("agent-grant"), "B enrolled anew");
    let at = f.tokens.grant_key(&f.agent);
    assert_eq!(
        f.grants.read(&at).unwrap().unwrap().account,
        "b@example.com"
    );
}

#[tokio::test]
async fn another_first_sign_in_retires_the_grant_even_once_that_session_has_expired() {
    // The watcher follows B's sign-in before it expires, or sees both as one change.
    for watched_before_expiry in [true, false] {
        let owner = "b".repeat(64);
        let (key, probe) = keyed(&owner);
        let (base, served) = issuer(vec![(200, issued(&probe, serde_json::json!({})))]).await;
        let mut f = fixture(base.clone());
        (f.agent, f.key) = (probe.clone(), key);
        stored(&f, "a@example.com");
        let tokens = restarted(&f, base.clone());
        assert!(tokens
            .evidence(&f.agent, &f.key, 0)
            .await
            .unwrap()
            .is_some());

        // B is the first sign-in, with no agent call while it lasts.
        let f = Fixture { tokens, ..f };
        signed_in_again(&f, "b@example.com");
        let identity = f.tokens.0.identity.clone();
        let watch = || f.tokens.follow(identity.account_changes().borrow().clone());
        if watched_before_expiry {
            watch().await.unwrap();
        }
        // B's session expires and the restore owner removes it.
        {
            let mut state = identity.state();
            let session = Arc::get_mut(state.session.as_mut().unwrap()).unwrap();
            session.record.expires_at = "2000-01-01T00:00:00Z".into();
            state.restored = true;
        }
        identity.restore().await;
        assert!(identity.state().session.is_none());
        watch().await.unwrap();

        // A's grant neither mints nor comes back, here or after a restart.
        assert_eq!(
            f.tokens
                .evidence(&f.agent, &f.key, 0)
                .await
                .err()
                .as_deref(),
            Some(SIGN_IN)
        );
        let tokens = restarted(&f, base);
        assert_eq!(
            tokens.evidence(&f.agent, &f.key, 0).await.err().as_deref(),
            Some(SIGN_IN)
        );
        assert!(
            f.grants.0.lock().unwrap().is_empty(),
            "grant and record wiped"
        );
        assert_eq!(settled(served).await.len(), 1, "only A's first mint");
    }
}

#[tokio::test]
async fn the_same_account_as_the_first_sign_in_after_restart_keeps_the_grant() {
    let owner = "b".repeat(64);
    let (key, probe) = keyed(&owner);
    let (base, served) = issuer(vec![(200, issued(&probe, serde_json::json!({})))]).await;
    let mut f = fixture(base.clone());
    (f.agent, f.key) = (probe.clone(), key);
    stored(&f, "a@example.com");
    let tokens = restarted(&f, base);
    assert!(tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    // Without a session, and then signed in as A, the assertion is reused.
    assert!(tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    let f = Fixture { tokens, ..f };
    signed_in_again(&f, "a@example.com");
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    assert_eq!(settled(served).await.len(), 1);
    assert!(f
        .grants
        .0
        .lock()
        .unwrap()
        .contains_key(&f.tokens.grant_key(&f.agent)));
}

#[tokio::test]
async fn retirement_survives_a_crash_after_session_persistence_before_the_watcher_runs() {
    for expired in [false, true] {
        let (key, agent) = keyed(&"b".repeat(64));
        let session =
            serde_json::json!({"expires_at":"2099-01-01T00:00:00Z", "email":"b@example.com"});
        let mut replies = vec![
            (
                200,
                serde_json::json!({"session_token":"new-session", "expires_at":"2099-01-01T00:00:00Z"}),
            ),
            (200, session.clone()),
        ];
        if !expired {
            replies.extend([
                (200, session),
                (200, enrolled(&agent.owner)),
                (200, issued(&agent, serde_json::json!({}))),
            ]);
        }
        let (base, served) = issuer(replies).await;
        let mut f = fixture(base.clone());
        (f.agent, f.key) = (agent, key);
        listing(&f); // Deliberately do not start the asynchronous watcher.
        stored(&f, "a@example.com");
        let (held, reached) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        *f.session_store.compare_gate.lock().unwrap() = Some((held, released));
        let identity = f.tokens.0.identity.clone();
        // A fresh sign-in; one started while signed in replaces the session.
        identity.retire(super::super::Status::SigningIn, None);
        let revision = identity.snapshot().revision;
        let cancel = identity.state().cancellation.clone();
        let login = tokio::spawn(async move {
            identity
                .finish_login("code", "secret", &revision, &cancel)
                .await
        });
        bounded(tokio::task::spawn_blocking(move || reached.recv().unwrap()))
            .await
            .unwrap();
        // The new session has reached durable storage, but is not published.
        // The marker must already exist even if the process dies right here.
        let pending = f.grants.pending(&f.tokens.retiring_key()).unwrap();
        login.abort();
        release.send(()).unwrap();
        let _ = login.await;
        assert!(
            pending,
            "session persistence preceded durable grant retirement"
        );
        if expired {
            let mut raw = f.session_store.raw.lock().unwrap();
            let mut record: serde_json::Value =
                serde_json::from_slice(raw.as_ref().unwrap()).unwrap();
            record["expires_at"] = "2000-01-01T00:00:00Z".into();
            *raw = Some(Zeroizing::new(serde_json::to_vec(&record).unwrap()));
        }
        let identity = at_adapter(f.session_store.clone(), base);
        let tokens = requiring(identity.clone(), f.grants.clone());
        let fresh = Fixture { tokens, ..f };
        listing(&fresh);
        identity.restore().await;
        let evidence = fresh.tokens.evidence(&fresh.agent, &fresh.key, 0).await;
        if expired {
            assert_eq!(evidence.err().as_deref(), Some(SIGN_IN));
        } else {
            assert!(evidence.unwrap().is_some());
            assert_eq!(
                fresh
                    .grants
                    .read(&fresh.tokens.grant_key(&fresh.agent))
                    .unwrap()
                    .unwrap()
                    .account,
                "b@example.com"
            );
        }
        let seen = settled(served).await;
        assert!(
            seen.iter().all(|request| !request
                .headers
                .iter()
                .any(|(name, value)| name == "authorization" && value == "Bearer g")),
            "A's retired grant reached issuance"
        );
    }
}

#[tokio::test]
async fn an_abandoned_switch_withdraws_only_its_own_retirement() {
    for already in [false, true] {
        let (base, served) = issuer(vec![
            (
                200,
                serde_json::json!({"session_token":"new-session", "expires_at":"2099-01-01T00:00:00Z"}),
            ),
            (
                200,
                serde_json::json!({"expires_at":"2099-01-01T00:00:00Z", "email":"b@example.com"}),
            ),
        ])
        .await;
        let f = fixture(base);
        listing(&f);
        stored(&f, "a@example.com");
        if already {
            f.grants
                .set_pending(&f.tokens.retiring_key(), true)
                .unwrap();
        }
        let identity = &f.tokens.0.identity;
        let revision = identity.snapshot().revision;
        let cancel = identity.state().cancellation.child_token();
        // Storage refuses B's save after preparation marked A's grants for
        // retirement.
        f.session_store
            .denied
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            identity
                .finish_login("code", "secret", &revision, &cancel)
                .await
                .unwrap_err()
                .code,
            "storage-denied"
        );
        assert!(f.session_store.raw.lock().unwrap().is_none());
        assert_eq!(f.grants.pending(&f.tokens.retiring_key()).unwrap(), already);
        assert!(f
            .grants
            .read(&f.tokens.grant_key(&f.agent))
            .unwrap()
            .is_some());
        assert_eq!(settled(served).await.len(), 2);
    }
}

#[tokio::test]
async fn a_failed_retirement_record_prevents_installing_another_account() {
    let (base, served) = issuer(vec![
        (
            200,
            serde_json::json!({"session_token":"new-session", "expires_at":"2099-01-01T00:00:00Z"}),
        ),
        (
            200,
            serde_json::json!({"expires_at":"2099-01-01T00:00:00Z", "email":"b@example.com"}),
        ),
    ])
    .await;
    let f = fixture(base);
    listing(&f);
    stored(&f, "a@example.com");
    f.grants.fail_pending(true);
    let identity = &f.tokens.0.identity;
    let revision = identity.snapshot().revision;
    let cancel = identity.state().cancellation.clone();
    assert_eq!(
        identity
            .finish_login("code", "secret", &revision, &cancel)
            .await
            .unwrap_err()
            .code,
        "storage-unavailable"
    );
    assert!(f.session_store.raw.lock().unwrap().is_none());
    assert_eq!(f.tokens.account().as_deref(), Some("a@example.com"));
    assert_eq!(settled(served).await.len(), 2);
}

#[tokio::test]
async fn an_interrupted_account_wipe_records_retirement_before_its_first_delete() {
    let (base, served) = issuer(vec![]).await;
    let f = fixture(base.clone());
    stored(&f, "a@example.com");
    let (_, other) = keyed(&f.agent.owner);
    let other_key = f.tokens.grant_key(&other);
    f.grants
        .write(
            &other_key,
            &Grant::new(
                other.owner.clone(),
                other.pubkey.clone(),
                "a@example.com".into(),
                "issuer".into(),
                "g".into(),
            ),
        )
        .unwrap();
    let listed = vec![
        (f.agent.owner.clone(), f.agent.pubkey.clone()),
        (other.owner, other.pubkey),
    ];
    let first_listing = listed.clone();
    f.tokens
        .0
        .agents
        .set(Arc::new(move || Ok(first_listing.clone())))
        .ok()
        .unwrap();
    *f.grants.4.lock().unwrap() = Some(1);
    signed_in_again(&f, "b@example.com");
    assert!(f
        .tokens
        .follow(Some(SessionChange::AccountChanged))
        .await
        .is_err());
    assert!(f.grants.pending(&f.tokens.retiring_key()).unwrap());
    *f.grants.4.lock().unwrap() = None;
    // A fresh process sees the marker even before restoring B's session.
    let identity = at_adapter(Arc::new(Memory::default()), base);
    let tokens = requiring(identity, f.grants.clone());
    tokens
        .0
        .agents
        .set(Arc::new(move || Ok(listed.clone())))
        .ok()
        .unwrap();
    assert_eq!(
        tokens.evidence(&f.agent, &f.key, 0).await.err().as_deref(),
        Some(SIGN_IN)
    );
    assert!(!f.grants.pending(&f.tokens.retiring_key()).unwrap());
    assert!(f.grants.0.lock().unwrap().is_empty());
    assert!(settled(served).await.is_empty());
}

#[tokio::test]
async fn sign_out_does_not_hold_the_wipe_lock_while_waiting_for_session_persistence() {
    let f = fixture("http://unused".into());
    listing(&f);
    let identity = f.tokens.0.identity.clone();
    let mut changes = identity.account_changes();
    let operation = identity.0.operation.lock().await;
    let tokens = f.tokens.clone();
    let signing_out = tokio::spawn(async move { tokens.sign_out(None).await });
    bounded(changes.changed()).await.unwrap();
    let wipe_available = f.tokens.0.wiping.try_lock().is_ok();
    drop(operation);
    bounded(signing_out).await.unwrap().unwrap();
    assert!(
        wipe_available,
        "restore/install must be able to finish before sign-out takes the session operation"
    );
}

#[tokio::test]
async fn terminal_refusals_survive_a_reload_of_the_same_persisted_session() {
    for stage in [0, 1, 2] {
        let owner = "b".repeat(64);
        let denied = || (403, serde_json::json!({"error":"authorization_denied"}));
        let mut replies = if stage == 0 {
            vec![denied()]
        } else {
            let mut replies = vec![(200, enrolled(&owner)), refused_grant()];
            if stage == 1 {
                replies.push(denied());
            } else {
                replies.extend([(200, enrolled(&owner)), refused_grant()]);
            }
            replies
        };
        replies.push((
            200,
            serde_json::json!({"expires_at":"2099-01-01T00:00:00Z", "email":"a@example.com"}),
        ));
        let (base, served) = issuer(replies).await;
        let f = fixture(base.clone());
        listing(&f);
        *f.session_store.raw.lock().unwrap() = Some(
            f.tokens
                .0
                .identity
                .state()
                .session
                .as_ref()
                .unwrap()
                .raw
                .clone(),
        );
        assert!(f.tokens.evidence(&f.agent, &f.key, 0).await.is_err());
        // Recreate both native owners and reload the actual serialized session.
        let identity = at_adapter(f.session_store.clone(), base);
        let tokens = requiring(identity.clone(), f.grants.clone());
        let fresh = Fixture { tokens, ..f };
        listing(&fresh);
        identity.restore().await;
        for _ in 0..2 {
            assert_eq!(
                fresh
                    .tokens
                    .evidence(&fresh.agent, &fresh.key, 0)
                    .await
                    .err()
                    .as_deref(),
                Some(STOPPED),
                "stage {stage} must not re-enroll or mint"
            );
        }
        assert_eq!(settled(served).await.len(), [2, 4, 5][stage]);
    }
}

#[tokio::test]
async fn an_agent_request_is_not_sent_without_a_durable_reservation() {
    let (base, served) = issuer(vec![]).await;
    let f = fixture(base);
    f.grants.fail_writes(true);
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap_err()
        .contains("storage"));
    let tokens = requiring(f.tokens.0.identity.clone(), f.grants.clone());
    assert!(tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap_err()
        .contains("storage"));
    assert!(settled(served).await.is_empty());
}

#[tokio::test]
async fn failure_to_release_a_transient_reservation_keeps_the_agent_stopped_after_restart() {
    let (held, reached) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let unavailable = || (503, serde_json::json!({"error":"unavailable"}));
    let (base, served) = issuer_gated(
        vec![
            unavailable(),
            unavailable(),
            unavailable(),
            (
                200,
                serde_json::json!({"expires_at":"2099-01-01T00:00:00Z", "email":"a@example.com"}),
            ),
        ],
        2,
        Some((held, released)),
    )
    .await;
    let f = fixture(base.clone());
    listing(&f);
    *f.session_store.raw.lock().unwrap() = Some(
        f.tokens
            .0
            .identity
            .state()
            .session
            .as_ref()
            .unwrap()
            .raw
            .clone(),
    );
    let failing_storage = async {
        bounded(reached).await.unwrap();
        f.grants.fail_writes(true);
        release.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(f.tokens.evidence(&f.agent, &f.key, 0), failing_storage);
    assert!(result.unwrap_err().contains("storage"));
    let identity = at_adapter(f.session_store.clone(), base);
    let tokens = requiring(identity.clone(), f.grants.clone());
    let fresh = Fixture { tokens, ..f };
    listing(&fresh);
    identity.restore().await;
    assert_eq!(
        fresh
            .tokens
            .evidence(&fresh.agent, &fresh.key, 0)
            .await
            .err()
            .as_deref(),
        Some(STOPPED)
    );
    assert_eq!(settled(served).await.len(), 4);
}

#[tokio::test]
async fn an_empty_account_scan_cannot_turn_a_late_reservation_into_an_old_account_grant() {
    let (base, served) = issuer(vec![
        (
            200,
            serde_json::json!({"session_token":"new-session", "expires_at":"2099-01-01T00:00:00Z"}),
        ),
        (
            200,
            serde_json::json!({"expires_at":"2099-01-01T00:00:00Z", "email":"b@example.com"}),
        ),
    ])
    .await;
    let f = fixture(base.clone());
    listing(&f);
    let (held, reached) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    *lock(&f.tokens.0.before_commit) = Some((held, released));
    let acquire = f.tokens.evidence(&f.agent, &f.key, 0);
    let control = async {
        bounded(reached).await.unwrap();
        assert!(f
            .grants
            .read(&f.tokens.grant_key(&f.agent))
            .unwrap()
            .is_none());
        let identity = f.tokens.0.identity.clone();
        // The real sign-in admission retires the previous session before login.
        // finish_login alone would leave an A session usable artificially.
        identity.retire(super::super::Status::SigningIn, None);
        let revision = identity.snapshot().revision;
        let cancel = identity.state().cancellation.clone();
        let (saved, persisted) = std::sync::mpsc::channel();
        let (publish, publication) = std::sync::mpsc::channel();
        *f.session_store.compare_gate.lock().unwrap() = Some((saved, publication));
        let login = tokio::spawn(async move {
            identity
                .finish_login("code", "secret", &revision, &cancel)
                .await
        });
        bounded(tokio::task::spawn_blocking(move || {
            persisted.recv().unwrap()
        }))
        .await
        .unwrap();
        // B's empty scan and durable session write finished; publication is held.
        assert!(!f.grants.pending(&f.tokens.retiring_key()).unwrap());
        release.send(()).unwrap();
        (login, publish)
    };
    let (result, (login, publish)) = tokio::join!(acquire, control);
    assert!(result.is_err());
    let grant = f
        .grants
        .read(&f.tokens.grant_key(&f.agent))
        .unwrap()
        .unwrap();
    assert!(
        grant.token.is_empty(),
        "the late reservation became an A credential"
    );
    login.abort();
    publish.send(()).unwrap();
    let _ = login.await;
    {
        let mut raw = f.session_store.raw.lock().unwrap();
        let mut record: serde_json::Value = serde_json::from_slice(raw.as_ref().unwrap()).unwrap();
        record["expires_at"] = "2000-01-01T00:00:00Z".into();
        *raw = Some(Zeroizing::new(serde_json::to_vec(&record).unwrap()));
    }
    let identity = at_adapter(f.session_store.clone(), base);
    let tokens = requiring(identity.clone(), f.grants.clone());
    let fresh = Fixture { tokens, ..f };
    listing(&fresh);
    identity.restore().await;
    assert!(fresh
        .tokens
        .evidence(&fresh.agent, &fresh.key, 0)
        .await
        .is_err());
    let seen = settled(served).await;
    assert_eq!(seen.len(), 2);
    assert!(
        seen.iter()
            .all(|request| !request.target.contains("agent-")),
        "A reached enrollment or minting"
    );
}

pub(crate) async fn response_fixture() -> Fixture {
    let mut f = fixture(String::new());
    let (base, served) = issuer(vec![
        (200, enrolled(&f.agent.owner)),
        (200, issued(&f.agent, serde_json::json!({}))),
    ])
    .await;
    // Keep the assertion and grant keyed to this agent, with the loopback issuer.
    let identity = at_adapter(f.session_store.clone(), base);
    {
        let mut state = identity.state();
        state.session = f.tokens.0.identity.state().session.clone();
        state.account = Some(Some("a@example.com".into()));
    }
    f.tokens = requiring(identity, f.grants.clone());
    listing(&f);
    f.tokens
        .authorize(&f.agent, &f.key, Stamp::default())
        .await
        .unwrap();
    assert_eq!(settled(served).await.len(), 2);
    f
}

#[tokio::test]
async fn response_admission_fences_explicit_retirement_but_not_elapsed_ttl_or_session_expiry() {
    for change in ["sign-out", "account", "delete", "grant", "expiry"] {
        let f = response_fixture().await;
        let admission = f
            .tokens
            .authorize(&f.agent, &f.key, Stamp::default())
            .await
            .unwrap();
        let (held, reached) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let read = admission.run(false, async {
            held.send(()).unwrap();
            released.await.unwrap();
            Ok("body")
        });
        let retire = async {
            reached.await.unwrap();
            match change {
                "sign-out" => {
                    f.tokens.sign_out(None).await.unwrap();
                }
                "account" => signed_in_again(&f, "b@example.com"),
                "delete" => {
                    f.tokens
                        .forget(&f.agent.owner, &f.agent.pubkey)
                        .await
                        .unwrap();
                }
                "grant" => {
                    lock(&f.tokens.0.incarnations)
                        .entry(f.agent.pubkey.clone())
                        .or_default()
                        .grants += 1;
                }
                _ => {
                    f.tokens.0.identity.retire(
                        crate::federated_identity::Status::ReauthenticationRequired,
                        None,
                    );
                    tokio::time::pause();
                    tokio::time::advance(std::time::Duration::from_secs(600)).await;
                }
            }
            release.send(()).unwrap();
        };
        let (result, ()) = tokio::join!(read, retire);
        if change == "expiry" {
            tokio::time::resume();
            assert_eq!(result.unwrap(), "body");
            assert!(
                admission.dispatch().is_err(),
                "expired assertion dispatched anew"
            );
        } else {
            assert!(result.is_err(), "late response survived {change}");
        }
    }
}

#[tokio::test]
async fn a_transmitted_agent_write_is_uncertain_after_retirement_and_never_replayed() {
    let f = response_fixture().await;
    let admission = f
        .tokens
        .authorize(&f.agent, &f.key, Stamp::default())
        .await
        .unwrap();
    let (held, reached) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let dispatched = std::sync::atomic::AtomicUsize::new(0);
    let write = admission.run(true, async {
        dispatched.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        held.send(()).unwrap();
        released.await.unwrap();
        Ok(())
    });
    let retire = async {
        reached.await.unwrap();
        f.tokens.sign_out(None).await.unwrap();
        release.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(write, retire);
    assert!(result.unwrap_err().contains("may have completed"));
    assert_eq!(dispatched.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn local_commit_keeps_its_retirement_guard_until_the_write_finishes() {
    let f = response_fixture().await;
    let admission = f
        .tokens
        .authorize(&f.agent, &f.key, Stamp::default())
        .await
        .unwrap();
    let (held, reached) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let (contended, waiting) = std::sync::mpsc::channel();
    *lock(&f.tokens.0.contended) = Some(contended);
    let worker = admission.clone();
    let writing = tokio::task::spawn_blocking(move || {
        worker.commit(true, || {
            held.send(()).unwrap();
            released.recv().unwrap();
            Ok("committed before retirement")
        })
    });
    bounded(tokio::task::spawn_blocking(move || reached.recv().unwrap()))
        .await
        .unwrap();
    let tokens = f.tokens.clone();
    let signing_out = tokio::spawn(async move { tokens.sign_out(None).await });
    // This existing fixture signal proves sign-out reached the held lock;
    // it cannot record retirement in the middle of the local write.
    bounded(tokio::task::spawn_blocking(move || waiting.recv().unwrap()))
        .await
        .unwrap();
    release.send(()).unwrap();
    assert_eq!(
        writing.await.unwrap().unwrap(),
        "committed before retirement"
    );
    signing_out.await.unwrap().unwrap();
    assert!(admission.commit(false, || Ok(())).is_err());
}

#[tokio::test]
async fn removing_one_row_keeps_another_rows_admission_and_the_shared_durable_grant() {
    let f = response_fixture().await;
    let survivor = f
        .tokens
        .authorize(&f.agent, &f.key, Stamp::default())
        .await
        .unwrap();
    let grant_before = f.grants.0.lock().unwrap().clone();
    let removed = AppAgent {
        relay: "wss://other.example".into(),
        ..f.agent.clone()
    };
    let stamp = f.tokens.stamp(&removed.pubkey, &removed.relay).unwrap();
    let stale = f.tokens.authorize(&removed, &f.key, stamp).await.unwrap();
    assert!(
        stale.header().is_none(),
        "this row is outside the configured organization"
    );
    f.tokens
        .forget_row(&removed.pubkey, &removed.relay)
        .unwrap();
    let fresh = f
        .tokens
        .reopen_row(&removed.pubkey, &removed.relay)
        .unwrap();
    assert!(stale.commit(false, || Ok(())).is_err());
    assert!(survivor.header().is_some());
    survivor.dispatch().unwrap();
    survivor.commit(false, || Ok(())).unwrap();
    assert_eq!(
        f.grants.0.lock().unwrap().clone(),
        grant_before,
        "row replacement changed the shared grant"
    );
    f.tokens.authorize(&removed, &f.key, fresh).await.unwrap();
    // The final key removal still closes every community operation.
    f.tokens
        .forget(&f.agent.owner, &f.agent.pubkey)
        .await
        .unwrap();
    assert!(survivor.commit(false, || Ok(())).is_err());
}

#[tokio::test]
async fn a_covered_community_without_nip_fi_runs_agent_operations_tokenless_while_signed_out() {
    let f = fixture("http://unused".into());
    let identity = at_adapter(Arc::new(Memory::default()), "http://unused".into());
    identity.discovered("wss://relay.example", false);
    let tokens = AgentTokens::with_store(identity, f.grants.clone());
    let admission = tokens
        .authorize(&f.agent, &f.key, Stamp::default())
        .await
        .unwrap();
    assert!(admission.header().is_none());
    assert_eq!(admission.run(true, async { Ok(7) }).await.unwrap(), 7);
    // Undiscoverable: nothing is sent, not even without a token.
    let identity = at_adapter(Arc::new(Memory::default()), "http://unused".into());
    let tokens = AgentTokens::with_store(identity, f.grants.clone());
    assert!(tokens
        .authorize(&f.agent, &f.key, Stamp::default())
        .await
        .is_err());
}

#[tokio::test]
async fn each_agent_enrolls_with_the_server_its_community_routes_to() {
    let template = fixture("http://unused".into());
    let home = template.agent.clone();
    let peer_key = Secret::generate().unwrap();
    let peer_agent = AppAgent {
        pubkey: peer_key.pubkey().into(),
        relay: "wss://peer.example".into(),
        ..home.clone()
    };
    // Each server has its own session token, account, grant and issuer.
    let peer_enrolled = {
        let mut reply = enrolled(&home.owner);
        reply["access_token"] = "peer-grant".into();
        reply["nip_fi_issuer"] = "https://peer-issuer.example".into();
        reply
    };
    let (base, served) = issuer(vec![
        (200, enrolled(&home.owner)),
        (200, issued(&home, serde_json::json!({}))),
    ])
    .await;
    let (peer_base, peer_served) = issuer(vec![
        (200, peer_enrolled),
        (
            200,
            issued(
                &peer_agent,
                serde_json::json!({ "aud": "https://peer.example", "iss": "https://peer-issuer.example" }),
            ),
        ),
    ])
    .await;
    let signed_in = |identity: &FederatedIdentity, token: &str, email: &str| {
        let mut session = record();
        let record = &mut Arc::get_mut(&mut session).unwrap().record;
        record.email = Some(email.into());
        record.session_token = token.into();
        let mut state = identity.state();
        state.session = Some(session);
        state.account = Some(Some(email.into()));
    };
    let mut config = super::super::config::Config::parse(r#"{"version":1,"id":"peer","identityOrigin":"https://peer-identity.example","adapterBase":"https://peer-identity.example","apiBasePath":"/api/","communityHosts":["peer.example"]}"#).unwrap();
    config.adapter_base = peer_base;
    let peer = FederatedIdentity::with_store(
        Some(config),
        "fingerprint".into(),
        "peer-account".into(),
        Arc::new(Memory::default()),
    );
    let mut first = at_adapter(Arc::new(Memory::default()), base);
    Arc::get_mut(&mut first.0).unwrap().peers = vec![peer.clone()];
    signed_in(&first, "first-session", "a@example.com");
    signed_in(&peer, "peer-session", "p@example.com");
    first.discovered(&home.relay, true);
    peer.discovered(&peer_agent.relay, true);
    let tokens = AgentTokens::with_store(first.clone(), template.grants.clone());
    tokens.watch({
        let listed = vec![
            (home.owner.clone(), home.pubkey.clone()),
            (home.owner.clone(), peer_agent.pubkey.clone()),
        ];
        move || Ok(listed.clone())
    });
    for (agent, key) in [(&home, &template.key), (&peer_agent, &peer_key)] {
        let evidence = tokens.evidence(agent, key, 0).await.unwrap().unwrap();
        assert!(evidence.starts_with("Bearer "));
    }
    // Each enrollment spends its own server's session; each mint its own grant.
    for (seen, session, grant) in [
        (settled(served).await, "first-session", "grant-1"),
        (settled(peer_served).await, "peer-session", "peer-grant"),
    ] {
        assert_eq!(seen.len(), 2);
        let form: HashMap<String, String> = url::form_urlencoded::parse(&seen[0].body)
            .into_owned()
            .collect();
        assert_eq!(form["subject_token"], session);
        assert!(seen[1]
            .headers
            .iter()
            .any(|(name, value)| name == "authorization" && *value == format!("Bearer {grant}")));
    }
    // The first server's grants keep the key they had as the only server.
    let first_key = super::super::store::agent_grant_key("account", &home.owner, &home.pubkey);
    assert_eq!(first_key, first.agent_grant_key(&home.owner, &home.pubkey));
    let peer_grant_key = peer.agent_grant_key(&home.owner, &peer_agent.pubkey);
    let stored = |key: &str| template.grants.read(key).unwrap();
    assert_eq!(stored(&first_key).unwrap().token, "grant-1");
    assert_eq!(stored(&peer_grant_key).unwrap().token, "peer-grant");
    assert!(stored(&first.agent_grant_key(&home.owner, &peer_agent.pubkey)).is_none());
    assert!(stored(&peer.agent_grant_key(&home.owner, &home.pubkey)).is_none());

    // Signing out of the peer retires only its grant.
    tokens
        .for_server(&peer)
        .unwrap()
        .sign_out(None)
        .await
        .unwrap();
    assert!(stored(&peer_grant_key).is_none());
    assert!(stored(&first_key).is_some());
    // Deleting an agent removes its grant from every server.
    let peer_home_key = peer.agent_grant_key(&home.owner, &home.pubkey);
    template
        .grants
        .write(&peer_home_key, &stored(&first_key).unwrap())
        .unwrap();
    tokens.forget(&home.owner, &home.pubkey).await.unwrap();
    assert!(stored(&first_key).is_none());
    assert!(stored(&peer_home_key).is_none());
}

#[tokio::test]
async fn a_revision_fenced_sign_out_leaves_a_newer_session_and_its_grants() {
    let (base, _served) = issuer(vec![]).await;
    let f = fixture(base);
    listing(&f);
    stored(&f, "b@example.com");
    let rejected = f.tokens.0.identity.snapshot().revision;
    // A renewal installs B before the fenced sign-out retires anything.
    signed_in_again(&f, "b@example.com");
    {
        let mut state = f.tokens.0.identity.state();
        state.snapshot.status = crate::federated_identity::Status::SignedIn;
        state.snapshot.revision = uuid::Uuid::new_v4().to_string();
    }
    let newer = f.tokens.0.identity.snapshot();
    assert_ne!(newer.revision, rejected);
    // With the retirement marker unwritable, the stale sign-out still never
    // touches it: no retirement is left for recovery or a restart to act on.
    f.grants.fail_pending(true);
    let snapshot = f.tokens.sign_out(Some(&rejected)).await.unwrap();
    f.grants.fail_pending(false);
    assert!(snapshot.status == crate::federated_identity::Status::SignedIn);
    assert_eq!(snapshot.revision, newer.revision);
    assert!(!f.grants.pending(&f.tokens.retiring_key()).unwrap());
    assert!(f
        .grants
        .read(&f.tokens.grant_key(&f.agent))
        .unwrap()
        .is_some());
    // The matching revision still signs out.
    let snapshot = f.tokens.sign_out(Some(&newer.revision)).await.unwrap();
    assert!(snapshot.status == crate::federated_identity::Status::SignedOut);
}

#[tokio::test]
async fn a_builderlab_customer_server_added_later_gets_its_own_tokens() {
    let first = crate::federated_identity::tests::with_customers(
        crate::federated_identity::config::Config::parse(
            crate::federated_identity::config::BUILT_IN,
        )
        .unwrap(),
        Vec::new(),
        true,
    );
    // Added before the tokens exist, and after.
    let early = first.server_for("wss://buzz.early.builderlab.xyz").unwrap();
    let tokens = AgentTokens::in_memory(first.clone());
    tokens.watch(|| Ok(Vec::new()));
    let late = first.server_for("wss://buzz.late.builderlab.xyz").unwrap();
    for (server, relay) in [
        (&early, "wss://buzz.early.builderlab.xyz"),
        (&late, "wss://buzz.late.builderlab.xyz"),
    ] {
        let own = tokens.for_server(server).unwrap();
        assert!(own.0.identity.is(server));
        // It follows the owner's account, as compiled servers' tokens do.
        assert!(own.0.agents.get().is_some());
        assert!(tokens.server_for(relay).unwrap().0.identity.is(server));
    }
    // A community routed by its host alone reaches it too.
    assert!(tokens
        .server_for("wss://buzz.third.builderlab.xyz")
        .unwrap()
        .0
        .identity
        .is(&first.server_for("wss://buzz.third.builderlab.xyz").unwrap()));
    assert_eq!(tokens.servers().len(), 4);
}

#[tokio::test]
async fn deleting_an_agent_retires_its_grant_with_a_customer_no_longer_joined() {
    use crate::federated_identity::{config, tests::customers_listed_in};
    let root = tempfile::tempdir().unwrap();
    let record = root.path().join("first.customers");
    let launch = || {
        customers_listed_in(
            config::Config::parse(config::BUILT_IN).unwrap(),
            Vec::new(),
            Some(Some(record.clone())),
        )
    };
    let grants = Arc::new(MemoryGrants::default());
    let (owner, agent) = ("owner", "agent");
    // The agent enrolled with a customer whose community was then removed.
    let customer = launch()
        .server_for("wss://buzz.gone.builderlab.xyz")
        .unwrap();
    let at = customer.agent_grant_key(owner, agent);
    grants
        .write(
            &at,
            &Grant::new(
                owner.into(),
                agent.into(),
                "a@example.com".into(),
                "https://gone.builderlab.xyz".into(),
                "grant".into(),
            ),
        )
        .unwrap();
    // After a restart, no community routes to it, yet deleting the agent
    // retires that grant, so importing its key again cannot reuse it.
    let tokens = AgentTokens::with_store(launch(), grants.clone());
    tokens.forget(owner, agent).await.unwrap();
    assert!(grants.read(&at).unwrap().is_none());
    let again = AgentTokens::with_store(launch(), grants.clone());
    let server = again
        .for_server(
            &again
                .0
                .identity
                .server_for("wss://buzz.gone.builderlab.xyz")
                .unwrap(),
        )
        .unwrap();
    assert_eq!(server.0.identity.agent_grant_key(owner, agent), at);
    assert!(grants.read(&at).unwrap().is_none());
}

#[tokio::test]
async fn a_server_added_once_the_first_has_a_supplier_follows_the_account() {
    let first = crate::federated_identity::tests::with_customers(
        crate::federated_identity::config::Config::parse(
            crate::federated_identity::config::BUILT_IN,
        )
        .unwrap(),
        Vec::new(),
        true,
    );
    let tokens = AgentTokens::in_memory(first.clone());
    // `watch` sets the first server's supplier before listing servers, so one
    // added in between gets it from `with_stores`; `watch` then offers it again.
    tokens.follow_account(Arc::new(|| Ok(Vec::new())));
    let added = first.server_for("wss://buzz.race.builderlab.xyz").unwrap();
    tokens.watch(|| Ok(Vec::new()));
    assert!(tokens.for_server(&added).unwrap().0.agents.get().is_some());
}
