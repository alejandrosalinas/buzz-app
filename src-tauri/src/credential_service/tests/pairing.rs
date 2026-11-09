use super::*;
use crate::federated_identity::testing;
use std::sync::atomic::Ordering;

const CLIENT: &str = "buzz-cli";

async fn pair_request(service: &CredentialService, params: &[&str]) -> (StatusCode, Value) {
    let body = json!({ "id": "p", "method": "pair", "params": params }).to_string();
    respond(service, None, Some(1), body.as_bytes(), None).await
}

/// The id of the request the page was asked about, once it was.
async fn asked(notices: &Arc<Mutex<Vec<Notice>>>) -> String {
    for _ in 0..200 {
        // The latest request still open.
        let open = {
            let notices = notices.lock().unwrap();
            let found = notices.iter().rev().find_map(|notice| match notice {
                Notice::Ask(request) => Some(request.id.clone()),
                _ => None,
            });
            let open = found.filter(|id| {
                !notices
                    .iter()
                    .any(|notice| matches!(notice, Notice::Closed(closed) if closed == id))
            });
            open
        };
        if let Some(id) = open {
            return id;
        }
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("no pairing request reached the page");
}

/// Pairs and approves; the paired token.
async fn paired(fixture: &Fixture) -> String {
    let service = fixture.service.clone();
    let pairing = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    let id = asked(&fixture.notices).await;
    fixture.service.0.pairings.answer(&id, true);
    let (status, reply) = pairing.await.unwrap();
    assert_eq!(status, StatusCode::OK, "{reply}");
    let result: Value = serde_json::from_str(reply["result"].as_str().unwrap()).unwrap();
    assert_eq!(result["relays"], json!([RELAY]));
    result["token"].as_str().unwrap().to_owned()
}

async fn human_pubkey() -> String {
    IdentityHost::fixture().viewer().await.unwrap()
}

#[tokio::test]
async fn an_approved_pairing_acts_as_the_human_on_its_relay() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let reply = ask(&fixture, &token, "describe", &[]).await;
    let described: Value = serde_json::from_str(reply.1["result"].as_str().unwrap()).unwrap();
    assert_eq!(described["role"], "owner");
    assert_eq!(described["pubkey"], human_pubkey().await);
    assert_eq!(described["relays"], json!([RELAY]));
    assert!(described.get("owner_pubkey").is_none());
    assert_eq!(ask(&fixture, &token, "auth_tag", &[]).await.1["result"], "");
}

#[tokio::test]
async fn only_the_digest_is_saved() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let saved = String::from_utf8(fixture.keychain.value.lock().unwrap().clone().unwrap()).unwrap();
    assert!(!saved.contains(&token));
    let digest: String = digest(&token).iter().map(|b| format!("{b:02x}")).collect();
    assert!(saved.contains(&digest));
}

#[tokio::test]
async fn a_declined_pairing_is_denied_and_saves_nothing() {
    let fixture = fixture();
    let service = fixture.service.clone();
    let pairing = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    let id = asked(&fixture.notices).await;
    fixture.service.0.pairings.answer(&id, false);
    assert_eq!(
        error(&pairing.await.unwrap()),
        (StatusCode::FORBIDDEN, "denied")
    );
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

#[tokio::test]
async fn nothing_is_asked_while_no_prompt_is_mounted() {
    let fixture = fixture();
    // One unmount more than mounted leaves none, not a negative count.
    fixture.service.0.pairings.prompt(false);
    fixture.service.0.pairings.prompt(false);
    for _ in 0..3 {
        let reply = pair_request(&fixture.service, &[CLIENT, RELAY]).await;
        assert_eq!(
            error(&reply),
            (StatusCode::SERVICE_UNAVAILABLE, "unavailable")
        );
        assert_eq!(
            reply.1["message"],
            "Buzz can't ask you yet; finish signing in or setting up in Buzz, then pair again"
        );
    }
    assert!(!fixture
        .notices
        .lock()
        .unwrap()
        .iter()
        .any(|notice| matches!(notice, Notice::Ask(_))));
    // A fourth request in the window pairs: the refusals spent no rate slot.
    fixture.service.0.pairings.prompt(true);
    paired(&fixture).await;
}

#[tokio::test]
async fn a_page_load_unmounts_every_prompt() {
    let fixture = fixture();
    fixture.service.0.pairings.prompt(true);
    fixture.service.page_load();
    let reply = pair_request(&fixture.service, &[CLIENT, RELAY]).await;
    assert_eq!(
        error(&reply),
        (StatusCode::SERVICE_UNAVAILABLE, "unavailable")
    );
    // The new page's prompt.
    fixture.service.0.pairings.prompt(true);
    paired(&fixture).await;
}

#[tokio::test]
async fn a_page_load_declines_the_request_it_left_waiting() {
    let fixture = fixture();
    let service = fixture.service.clone();
    let pairing = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    asked(&fixture.notices).await;
    // The new page never heard it, so nobody can answer it.
    fixture.service.page_load();
    let reply = pairing.await.unwrap();
    assert_eq!(error(&reply), (StatusCode::FORBIDDEN, "denied"));
    assert_eq!(reply.1["message"], "Pairing was declined in Buzz");
    // A retry isn't held behind it as "another pairing request is waiting".
    fixture.service.0.pairings.prompt(true);
    paired(&fixture).await;
}

#[tokio::test(start_paused = true)]
async fn an_unanswered_pairing_needs_approval_and_closes_its_prompt() {
    let fixture = fixture();
    let reply = pair_request(&fixture.service, &[CLIENT, RELAY]).await;
    assert_eq!(error(&reply), (StatusCode::FORBIDDEN, "approval_required"));
    let id = fixture
        .notices
        .lock()
        .unwrap()
        .iter()
        .find_map(|notice| match notice {
            Notice::Ask(request) => Some(request.id.clone()),
            _ => None,
        })
        .unwrap();
    assert!(fixture
        .notices
        .lock()
        .unwrap()
        .iter()
        .any(|notice| matches!(notice, Notice::Closed(closed) if *closed == id)));
    // A late answer issues nothing.
    fixture.service.0.pairings.answer(&id, true);
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

#[tokio::test]
async fn one_request_waits_at_a_time_and_three_per_window() {
    let fixture = fixture();
    let service = fixture.service.clone();
    let first = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    let id = asked(&fixture.notices).await;
    let second = pair_request(&fixture.service, &[CLIENT, RELAY]).await;
    assert_eq!(
        error(&second),
        (StatusCode::TOO_MANY_REQUESTS, "rate_limited")
    );
    fixture.service.0.pairings.answer(&id, false);
    first.await.unwrap();
    // Paused only now: the human's key is read off this runtime, and while a
    // request waits that idle time would jump its clock past the approval.
    tokio::time::pause();
    for _ in 0..2 {
        let reply = pair_request(&fixture.service, &[CLIENT, RELAY]).await;
        assert_eq!(error(&reply).1, "approval_required");
    }
    let fourth = pair_request(&fixture.service, &[CLIENT, RELAY]).await;
    assert_eq!(
        error(&fourth),
        (StatusCode::TOO_MANY_REQUESTS, "rate_limited")
    );
    assert!(fourth.1["retry_after"].as_u64().is_some());
}

#[tokio::test]
async fn bad_pairing_parameters_never_reach_the_page() {
    let fixture = fixture();
    for params in [
        &["", RELAY][..],
        &[CLIENT, "https://relay.example"],
        &[CLIENT],
    ] {
        let reply = pair_request(&fixture.service, params).await;
        assert_eq!(error(&reply).1, "invalid_request", "{params:?}");
    }
    assert!(fixture.notices.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_pairing_survives_a_restart_once_the_session_restores() {
    let mut fixture = fixture();
    let session = testing::restoring();
    session.finish_restore_for_test();
    fixture.service = service_over(
        &fixture.host,
        &session,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture(),
    );
    let token = paired(&fixture).await;
    // A new run: same keychain, a session still restoring at launch.
    let session = testing::restoring();
    let restarted = service_over(
        &fixture.host,
        &session,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture(),
    );
    fixture.service = restarted;
    let early = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(
        error(&early),
        (StatusCode::SERVICE_UNAVAILABLE, "unavailable")
    );
    assert!(
        fixture.keychain.value.lock().unwrap().is_some(),
        "kept while restoring"
    );
    session.finish_restore_for_test();
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(reply.1["result"], human_pubkey().await);
}

#[tokio::test]
async fn a_pairing_under_another_human_is_revoked_and_deleted() {
    let mut fixture = fixture();
    let token = paired(&fixture).await;
    fixture.service = service_over(
        &fixture.host,
        &fixture.identity,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture_without_key(true),
    );
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply), (StatusCode::UNAUTHORIZED, "revoked"));
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

#[tokio::test]
async fn revoking_and_clearing_stop_a_pairing() {
    let fixture = fixture();
    let first = paired(&fixture).await;
    let second = paired(&fixture).await;
    let listed = fixture.service.0.pairings.list().await.unwrap();
    assert_eq!(listed.len(), 2);
    let id = serde_json::to_value(&listed[0]).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    fixture.service.0.pairings.revoke(&id).await.unwrap();
    assert_eq!(
        error(&ask(&fixture, &first, "get_public_key", &[]).await).1,
        "revoked"
    );
    assert_eq!(
        ask(&fixture, &second, "get_public_key", &[]).await.0,
        StatusCode::OK
    );
    fixture.service.clear_pairings().await.unwrap();
    assert_eq!(
        error(&ask(&fixture, &second, "get_public_key", &[]).await).1,
        "revoked"
    );
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

#[tokio::test]
async fn a_pairing_unused_past_its_disuse_period_is_revoked() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let mut saved: Vec<Value> =
        serde_json::from_slice(fixture.keychain.value.lock().unwrap().as_ref().unwrap()).unwrap();
    saved[0]["last_used"] = json!(now() - super::super::pairing::DISUSE - 1);
    *fixture.keychain.value.lock().unwrap() = Some(serde_json::to_vec(&saved).unwrap());
    // The earlier run has exited.
    drop(fixture.service);
    let restarted = Fixture {
        service: service_over(
            &fixture.host,
            &fixture.identity,
            &fixture.keychain,
            &fixture.notices,
            IdentityHost::fixture(),
        ),
        ..fixture
    };
    let reply = ask(&restarted, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "revoked");
    assert!(restarted.keychain.value.lock().unwrap().is_none());
}

#[tokio::test]
async fn a_keychain_failure_issues_nothing_and_keeps_rows() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    fixture.keychain.fail_write.store(true, Ordering::SeqCst);
    let service = fixture.service.clone();
    let pairing = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    let id = loop {
        let ids: Vec<String> = fixture
            .notices
            .lock()
            .unwrap()
            .iter()
            .filter_map(|n| match n {
                Notice::Ask(request) => Some(request.id.clone()),
                _ => None,
            })
            .collect();
        if ids.len() == 2 {
            break ids[1].clone();
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    fixture.service.0.pairings.answer(&id, true);
    let reply = pairing.await.unwrap();
    assert_eq!(error(&reply).1, "unavailable");
    assert!(reply.1["result"].as_str().unwrap().is_empty());
    let listed = fixture.service.0.pairings.list().await.unwrap();
    let id = serde_json::to_value(&listed[0]).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(fixture.service.0.pairings.revoke(&id).await.is_err());
    assert_eq!(
        ask(&fixture, &token, "get_public_key", &[]).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn an_unreadable_keychain_admits_no_pairing() {
    let mut fixture = fixture();
    let token = paired(&fixture).await;
    fixture.keychain.fail_read.store(true, Ordering::SeqCst);
    fixture.service = service_over(
        &fixture.host,
        &fixture.identity,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture(),
    );
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "unavailable");
    assert!(fixture.service.0.pairings.list().await.is_err());
}

#[tokio::test]
async fn a_paired_token_signs_only_what_the_policy_allows() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let ordinary = unsigned(9, json!([]), now());
    let reply = ask(&fixture, &token, "sign_event", &[&ordinary]).await;
    let signed: Value = serde_json::from_str(reply.1["result"].as_str().unwrap()).unwrap();
    assert_eq!(signed["pubkey"], human_pubkey().await);
    let profile = unsigned(0, json!([]), now());
    let reply = ask(&fixture, &token, "sign_event", &[&profile]).await;
    assert_eq!(error(&reply), (StatusCode::FORBIDDEN, "denied"));
    let message = reply.1["message"].as_str().unwrap();
    assert!(message.contains("can't be signed by a local tool"));
}

/// A paired tool's Canvas is bounded as an agent's is: by its content, then
/// by its complete event, not by the 64 KiB other kinds are signed under.
#[tokio::test]
async fn a_paired_token_signs_a_canvas_within_the_canvas_bounds() {
    use buzz_agent_controller::LIVE_CANVAS_BYTES;
    let fixture = fixture();
    let token = paired(&fixture).await;
    let sign = |kind: u16, content: String| {
        json!({ "kind": kind, "tags": [["h", "channel"]], "content": content, "created_at": now() })
            .to_string()
    };
    for content in ["a".repeat(100 * 1024), "a".repeat(LIVE_CANVAS_BYTES)] {
        let reply = ask(
            &fixture,
            &token,
            "sign_event",
            &[&sign(40100, content.clone())],
        )
        .await;
        assert_eq!(reply.0, StatusCode::OK, "{}: {}", content.len(), reply.1);
        let signed: nostr::event::Event =
            serde_json::from_str(reply.1["result"].as_str().unwrap()).unwrap();
        signed.verify().unwrap();
        assert_eq!(signed.content.len(), content.len());
    }
    let over = sign(40100, "a".repeat(LIVE_CANVAS_BYTES + 1));
    let reply = ask(&fixture, &token, "sign_event", &[&over]).await;
    assert_eq!(error(&reply), (StatusCode::BAD_REQUEST, "invalid_request"));
    // Within the content bound, but escaping carries the event past its frame:
    // first its commitment, then only its id and signature.
    let escaped = sign(40100, "\u{1}".repeat(LIVE_CANVAS_BYTES));
    let reply = ask(&fixture, &token, "sign_event", &[&escaped]).await;
    assert_eq!(error(&reply), (StatusCode::BAD_REQUEST, "invalid_request"));
    let created_at = now();
    let human = human_pubkey().await;
    let commitment = |content: &str| {
        serde_json::to_vec(&json!([
            0,
            human,
            created_at,
            40100,
            [["h", "channel"]],
            content
        ]))
        .unwrap()
        .len()
    };
    let target = buzz_agent_controller::CANVAS_MAX_EVENT_BYTES - 100 - commitment("");
    let content = "\u{1}".repeat(target / 6) + &"a".repeat(target % 6);
    assert!(content.len() <= LIVE_CANVAS_BYTES);
    assert!(commitment(&content) <= buzz_agent_controller::CANVAS_MAX_EVENT_BYTES);
    let framed = json!({ "kind": 40100, "tags": [["h", "channel"]], "content": content, "created_at": created_at })
        .to_string();
    let reply = ask(&fixture, &token, "sign_event", &[&framed]).await;
    assert_eq!(error(&reply), (StatusCode::BAD_REQUEST, "invalid_request"));
    // Every other kind keeps the default bound.
    let message = sign(9, "a".repeat(100 * 1024));
    let reply = ask(&fixture, &token, "sign_event", &[&message]).await;
    assert_eq!(error(&reply), (StatusCode::BAD_REQUEST, "invalid_request"));
}

/// A paired request admitted before its pairing is revoked, or every pairing
/// is, returns no signature and no plaintext.
#[tokio::test(flavor = "multi_thread")]
async fn revocation_while_a_paired_request_runs_withholds_the_result() {
    for clear_all in [false, true] {
        for method in ["sign_event", "nip44_decrypt"] {
            let fixture = fixture();
            let token = paired(&fixture).await;
            let peer = buzz_agent_controller::Secret::generate().unwrap();
            let human = human_pubkey().await;
            let params = match method {
                "sign_event" => vec![unsigned(9, json!([]), now())],
                _ => vec![
                    peer.pubkey().to_owned(),
                    peer.nip44_encrypt(&human, "secret").unwrap(),
                ],
            };
            let gate = fixture.service.0.owner_call_gate.write().await;
            let (service, waiting) = (fixture.service.clone(), token.clone());
            let body = json!({ "id": "1", "method": method, "params": params }).to_string();
            let request = tokio::spawn(async move {
                respond(&service, Some(&waiting), Some(1), body.as_bytes(), None).await
            });
            // Admitted: it spent one request of its rate, and now waits at the call.
            while !fixture
                .service
                .0
                .owner_budgets
                .lock()
                .unwrap()
                .contains_key(&digest(&token))
            {
                tokio::task::yield_now().await;
            }
            assert!(!request.is_finished());
            if clear_all {
                fixture.service.clear_pairings().await.unwrap();
            } else {
                let listed = fixture.service.0.pairings.list().await.unwrap();
                let id = serde_json::to_value(&listed[0]).unwrap()["id"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                fixture.service.0.pairings.revoke(&id).await.unwrap();
            }
            drop(gate);
            let reply = request.await.unwrap();
            assert_eq!(
                error(&reply),
                (StatusCode::UNAUTHORIZED, "revoked"),
                "clear_all={clear_all} {method}"
            );
            assert_eq!(reply.1["result"], "", "clear_all={clear_all} {method}");
        }
    }
}

#[tokio::test]
async fn the_listener_and_its_advertisement_start_without_agents() {
    let fixture = fixture();
    let home = tempfile::tempdir().unwrap();
    let url = fixture
        .service
        .0
        .endpoint
        .get_or_try_init(|| fixture.service.listen())
        .await
        .unwrap()
        .clone();
    super::super::advertise::write(home.path(), "xyz.block.buzz.test", &url).unwrap();
    let file = super::super::advertise::path(home.path(), "xyz.block.buzz.test");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(file.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let body: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(
        body,
        json!({ "instance": "xyz.block.buzz.test", "url": url })
    );
    super::super::advertise::remove(home.path(), "xyz.block.buzz.test");
    assert!(!file.exists());
}

/// A sign-out the keychain refuses to save, after which the same account
/// returns: the pairing stays revoked in this run and the next, and its
/// rows go once the keychain works.
#[tokio::test]
async fn a_failed_revoke_all_keeps_pairings_revoked_until_it_is_saved() {
    let mut fixture = fixture();
    let token = paired(&fixture).await;
    fixture.keychain.fail_write.store(true, Ordering::SeqCst);
    assert!(fixture.service.clear_pairings().await.is_err());
    fixture.identity.same_account_again_for_test();
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "unavailable");
    assert!(fixture.keychain.value.lock().unwrap().is_some());

    // The next run, under the same human and account, still owes it.
    fixture.service = service_over(
        &fixture.host,
        &fixture.identity,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture(),
    );
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "unavailable");
    fixture.keychain.fail_write.store(false, Ordering::SeqCst);
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "revoked");
    assert!(fixture.keychain.value.lock().unwrap().is_none());
    assert!(!fixture.keychain.owed.load(Ordering::SeqCst));
}

/// The session's retirement count fences a request on its own, with no
/// watcher: a sign-out and the same account returning revokes.
#[tokio::test]
async fn a_sign_out_revokes_even_when_the_same_account_returns() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    fixture.identity.same_account_again_for_test();
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "revoked");
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

/// Approved, then a revoke-all begins while its record is being saved: the
/// revoke-all removes it and the token is never returned.
#[tokio::test(flavor = "multi_thread")]
async fn an_approval_saved_during_a_revoke_all_returns_no_token() {
    let fixture = fixture();
    let (entered, entered_rx) = std::sync::mpsc::channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    *fixture.keychain.gate.lock().unwrap() = Some(super::super::keychain::Gate {
        entered,
        release: release_rx,
    });
    let service = fixture.service.clone();
    let pairing = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    let id = asked(&fixture.notices).await;
    fixture.service.0.pairings.answer(&id, true);
    tokio::task::spawn_blocking(move || entered_rx.recv().unwrap())
        .await
        .unwrap();
    // Fences at the call; its save waits behind the approval's.
    let clearing = fixture.service.clear_pairings();
    release.send(()).unwrap();
    let reply = pairing.await.unwrap();
    assert_eq!(error(&reply).1, "denied");
    assert!(reply.1["result"].is_null() || reply.1["result"].as_str().unwrap().is_empty());
    clearing.await.unwrap();
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

/// Approved, then its community is removed while its record is being saved:
/// the removal waits for the save, which removes the record, and the token is
/// never returned.
#[tokio::test(flavor = "multi_thread")]
async fn an_approval_saved_during_a_community_removal_returns_no_token() {
    let fixture = fixture();
    let (entered, entered_rx) = std::sync::mpsc::channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    *fixture.keychain.gate.lock().unwrap() = Some(super::super::keychain::Gate {
        entered,
        release: release_rx,
    });
    let service = fixture.service.clone();
    let pairing = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    let id = asked(&fixture.notices).await;
    fixture.service.0.pairings.answer(&id, true);
    tokio::task::spawn_blocking(move || entered_rx.recv().unwrap())
        .await
        .unwrap();
    let service = fixture.service.clone();
    let removing =
        tokio::spawn(async move { service.0.pairings.set_communities(Vec::new()).await });
    // Wait until the removal has published its list; it cannot complete
    // while the save is paused.
    while fixture
        .service
        .0
        .pairings
        .communities
        .lock()
        .unwrap()
        .as_ref()
        != Some(&Vec::new())
    {
        tokio::task::yield_now().await;
    }
    assert!(!removing.is_finished());
    release.send(()).unwrap();
    removing.await.unwrap();
    // Once the removal completed, no token is saved.
    assert!(fixture.keychain.value.lock().unwrap().is_none());
    let (status, reply) = pairing.await.unwrap();
    assert_eq!(status, StatusCode::FORBIDDEN, "{reply}");
    assert_eq!(
        reply["message"],
        format!("{RELAY} isn't a community in Buzz; add it first")
    );
    assert!(reply["result"].is_null() || reply["result"].as_str().unwrap().is_empty());
}

/// Approved after a revoke-all has been saved: nothing is saved.
#[tokio::test]
async fn an_approval_after_a_revoke_all_saves_nothing() {
    let fixture = fixture();
    let service = fixture.service.clone();
    let pairing = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    let id = asked(&fixture.notices).await;
    fixture.service.clear_pairings().await.unwrap();
    fixture.service.0.pairings.answer(&id, true);
    assert_eq!(error(&pairing.await.unwrap()).1, "denied");
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

/// A sign-out records the revoke-all before it commits, so a run that ends
/// before any request or watcher follows it still revokes next launch.
#[tokio::test]
async fn a_sign_out_then_a_restart_before_its_revoke_still_revokes() {
    let mut fixture = fixture();
    let token = paired(&fixture).await;
    let tokens = AgentTokens::in_memory(fixture.identity.clone());
    let before = fixture.identity.retirements();
    // This fixture has no agents to wipe, which fails after the sign-out.
    let _ = tokens.sign_out(None).await;
    assert_eq!(fixture.identity.retirements(), before + 1, "signed out");
    assert!(fixture.keychain.owed.load(Ordering::SeqCst));
    assert!(fixture.keychain.value.lock().unwrap().is_some());

    // The next run's session knows nothing of the sign-out.
    let session = testing::restoring();
    session.finish_restore_for_test();
    fixture.service = service_over(
        &fixture.host,
        &session,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture(),
    );
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "revoked");
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

/// A revoke-all that can record neither its marker nor the cleared records
/// is reported as unrecorded, and a sign-out that needs it does not happen.
#[tokio::test]
async fn an_unrecorded_revoke_all_is_reported_and_stops_a_sign_out() {
    let fixture = fixture();
    paired(&fixture).await;
    fixture.keychain.fail_owed.store(true, Ordering::SeqCst);
    fixture.keychain.fail_write.store(true, Ordering::SeqCst);
    let unrevoked = fixture.service.clear_pairings().await.unwrap_err();
    assert!(!unrevoked.recorded);

    let tokens = AgentTokens::in_memory(fixture.identity.clone());
    let before = fixture.identity.retirements();
    assert!(tokens.sign_out(None).await.is_err());
    assert_eq!(fixture.identity.retirements(), before, "nothing signed out");

    // With the marker saved, only the records wait.
    fixture.keychain.fail_owed.store(false, Ordering::SeqCst);
    assert!(fixture.service.clear_pairings().await.unwrap_err().recorded);
    assert!(fixture.keychain.owed.load(Ordering::SeqCst));
}

/// A renewal into another account records the revoke-all before it
/// installs, so a run that ends before anything follows the change still
/// revokes next launch, even back under the original account.
#[tokio::test]
async fn an_account_change_then_a_restart_before_its_revoke_still_revokes() {
    let mut fixture = fixture_signed_in(testing::renewing_into_another_account().await);
    let token = paired(&fixture).await;
    fixture.identity.renew_for_test().await.unwrap();
    assert_eq!(
        fixture.identity.email_for_test().as_deref(),
        Some("b@example.com")
    );
    assert!(fixture.keychain.owed.load(Ordering::SeqCst));
    assert!(fixture.keychain.value.lock().unwrap().is_some());

    // The next run, back under the original account, knows nothing of it.
    let session = testing::renewing_into_another_account().await;
    fixture.service = service_over(
        &fixture.host,
        &session,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture(),
    );
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "revoked");
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

/// A renewal into another account whose revoke-all cannot be recorded does
/// not change the account.
#[tokio::test]
async fn an_account_change_whose_revoke_cannot_be_recorded_does_not_happen() {
    let fixture = fixture_signed_in(testing::renewing_into_another_account().await);
    let token = paired(&fixture).await;
    fixture.keychain.fail_owed.store(true, Ordering::SeqCst);
    let before = fixture.identity.retirements();
    assert!(fixture.identity.renew_for_test().await.is_err());
    assert_eq!(
        fixture.identity.email_for_test().as_deref(),
        Some("a@example.com")
    );
    assert_eq!(fixture.identity.retirements(), before);
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(reply.1["result"], human_pubkey().await);
}

/// While a recorded sign-out or change of account is under way, an owner
/// that has not loaded yet neither uses up the marker nor approves a pairing
/// under the old account; once it commits, a restart still revokes.
#[tokio::test]
async fn nothing_pairs_while_a_recorded_retirement_is_under_way() {
    let mut fixture = fixture();
    let token = paired(&fixture).await;
    // A fresh run's owner, not yet loaded.
    fixture.service = service_over(
        &fixture.host,
        &fixture.identity,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture(),
    );
    let recorded = fixture.identity.record_retirement().await.unwrap();
    assert!(recorded.is_some());
    let (_, reply) = pair_request(&fixture.service, &[CLIENT, RELAY]).await;
    assert_eq!(reply["error"], "unavailable", "{reply}");
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "unavailable");
    assert!(fixture.keychain.owed.load(Ordering::SeqCst), "marker kept");

    // The change commits, and the run ends before anything follows it.
    fixture.identity.same_account_again_for_test();
    drop(recorded);
    assert!(fixture.keychain.owed.load(Ordering::SeqCst));
    let session = testing::restoring();
    session.finish_restore_for_test();
    fixture.service = service_over(
        &fixture.host,
        &session,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture(),
    );
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "revoked");
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

/// A real renewal into another account, paused after it records its
/// revoke-all and before it installs, refuses pairing meanwhile; once it
/// commits, the marker remains and a restart revokes.
#[tokio::test]
async fn a_renewal_paused_before_it_installs_refuses_pairing_then_a_restart_revokes() {
    let mut fixture = fixture_signed_in(testing::renewing_into_another_account().await);
    let token = paired(&fixture).await;
    let gate = fixture.identity.gate_install_for_test();
    let identity = fixture.identity.clone();
    let renewal = tokio::spawn(async move { identity.renew_for_test().await });
    gate.reached.notified().await;

    assert!(fixture.keychain.owed.load(Ordering::SeqCst), "recorded");
    let (_, reply) = pair_request(&fixture.service, &[CLIENT, RELAY]).await;
    assert_eq!(reply["error"], "unavailable", "{reply}");
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "unavailable");

    gate.resume.notify_one();
    renewal.await.unwrap().unwrap();
    assert_eq!(
        fixture.identity.email_for_test().as_deref(),
        Some("b@example.com")
    );
    assert!(fixture.keychain.owed.load(Ordering::SeqCst), "marker kept");

    let session = testing::renewing_into_another_account().await;
    fixture.service = service_over(
        &fixture.host,
        &session,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture(),
    );
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "revoked");
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

/// Two apps over one keychain item: only the first serves pairings, so the
/// second neither admits one the first revoked nor writes it back, and after a
/// restart it stays revoked.
#[tokio::test]
async fn a_second_app_over_the_same_pairings_serves_none_of_them() {
    let mut fixture = fixture();
    let token = paired(&fixture).await;
    let second = service_over(
        &fixture.host,
        &fixture.identity,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture(),
    );
    let body = json!({ "id": "1", "method": "get_public_key", "params": [] }).to_string();
    let reply = respond(&second, Some(&token), Some(1), body.as_bytes(), None).await;
    assert_eq!(
        error(&reply),
        (StatusCode::SERVICE_UNAVAILABLE, "unavailable")
    );
    assert!(second.start().await.is_err(), "not advertised for pairing");
    let listed = fixture.service.0.pairings.list().await.unwrap();
    let id = serde_json::to_value(&listed[0]).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    fixture.service.0.pairings.revoke(&id).await.unwrap();
    // A write from the second app would have saved its own read of the records.
    let reply = pair_request(&second, &[CLIENT, RELAY]).await;
    assert_eq!(error(&reply).1, "unavailable");
    second.clear_pairings().await.unwrap();
    assert!(fixture.keychain.value.lock().unwrap().is_none());
    drop(second);
    fixture.service = service_over(
        &fixture.host,
        &fixture.identity,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture(),
    );
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply), (StatusCode::UNAUTHORIZED, "revoked"));
}

/// A second app refused the lease never advertised, so quitting leaves the
/// first app's advertisement, which that app removes when it quits.
#[cfg(unix)]
#[tokio::test]
async fn only_the_app_that_advertised_removes_the_advertisement() {
    let fixture = fixture();
    let home = tempfile::tempdir().unwrap();
    let file = super::super::advertise::path(home.path(), "xyz.block.buzz.test");
    fixture
        .service
        .start_in(Some(home.path().to_owned()))
        .await
        .unwrap();
    let second = service_over(
        &fixture.host,
        &fixture.identity,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture(),
    );
    assert!(second.start_in(Some(home.path().to_owned())).await.is_err());
    second.stop();
    assert!(file.exists(), "the first app is still discoverable");
    fixture.service.stop();
    assert!(!file.exists());
}

/// A lease that cannot be taken or checked is not another app's: the clear
/// is not reported done, and with no owed marker sign-out refuses it.
#[tokio::test]
async fn a_lease_that_cannot_be_checked_does_not_clear_the_pairings() {
    let fixture = fixture();
    fixture.keychain.fail_lease.store(true, Ordering::SeqCst);
    fixture.keychain.fail_owed.store(true, Ordering::SeqCst);
    let cleared = fixture.service.clear_pairings().await;
    assert!(matches!(cleared, Err(ref unrevoked) if !unrevoked.recorded));
    assert!(!crate::sign_out::pairings_allow(&cleared, false));
    fixture.keychain.fail_owed.store(false, Ordering::SeqCst);
    let cleared = fixture.service.clear_pairings().await;
    assert!(matches!(cleared, Err(ref unrevoked) if unrevoked.recorded));
    assert!(fixture.keychain.owed.load(Ordering::SeqCst));
}

/// An expired sign-in tells a paired tool to sign in again, not to wait.
#[tokio::test]
async fn an_expired_sign_in_asks_for_a_new_one() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    fixture.service.0.session.expire_for_test();
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(
        error(&reply),
        (StatusCode::SERVICE_UNAVAILABLE, "unavailable")
    );
    assert!(reply.1["message"]
        .as_str()
        .unwrap()
        .contains("sign in again in Buzz"));
}

#[tokio::test]
async fn a_community_not_saved_here_is_refused_before_anyone_is_asked() {
    let fixture = fixture();
    for relay in [
        "wss://other.example",
        "wss://relay.example/team/",
        "wss://relay.example/?team=a",
        "ws://relay.example",
    ] {
        let (status, reply) = pair_request(&fixture.service, &[CLIENT, relay]).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{reply}");
        assert_eq!(reply["error"], "denied");
        assert_eq!(
            reply["message"],
            format!("{relay} isn't a community in Buzz; add it first")
        );
    }
    assert!(fixture.notices.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_saved_community_matches_as_a_whole_normalized_url() {
    let fixture = fixture();
    // The page reports communities as HTTP or WebSocket URLs.
    fixture
        .service
        .0
        .pairings
        .set_communities(vec!["https://relay.example".into()])
        .await;
    let service = fixture.service.clone();
    let pairing =
        tokio::spawn(
            async move { pair_request(&service, &[CLIENT, "WSS://Relay.Example:443/"]).await },
        );
    let id = asked(&fixture.notices).await;
    fixture.service.0.pairings.answer(&id, false);
    assert_eq!(
        pairing.await.unwrap().1["message"],
        "Pairing was declined in Buzz"
    );
}

#[tokio::test]
async fn pairing_waits_until_the_page_reports_its_communities() {
    let fixture = fixture();
    *fixture.service.0.pairings.communities.lock().unwrap() = None;
    let (status, reply) = pair_request(&fixture.service, &[CLIENT, RELAY]).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{reply}");
    assert!(fixture.notices.lock().unwrap().is_empty());
}

#[tokio::test]
async fn removing_the_community_declines_the_waiting_request() {
    let fixture = fixture();
    let service = fixture.service.clone();
    let pairing = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    let id = asked(&fixture.notices).await;
    fixture.service.0.pairings.set_communities(Vec::new()).await;
    let (status, reply) = pairing.await.unwrap();
    assert_eq!(status, StatusCode::FORBIDDEN, "{reply}");
    assert_eq!(
        reply["message"],
        format!("{RELAY} isn't a community in Buzz; add it first")
    );
    // The prompt closed, and a late Allow issues nothing.
    assert!(fixture
        .notices
        .lock()
        .unwrap()
        .iter()
        .any(|notice| matches!(notice, Notice::Closed(closed) if *closed == id)));
    fixture.service.0.pairings.answer(&id, true);
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

#[tokio::test]
async fn the_caller_is_looked_up_only_for_a_request_that_is_asked() {
    let fixture = fixture();
    let pairings = &fixture.service.0.pairings;
    let unlooked = || async { panic!("a refused request looked up its caller") };
    let human = || async { crate::credential_service::pairing::Human::Absent };
    let refused = pairings
        .pair(CLIENT, "wss://other.example", unlooked, human)
        .await;
    assert_eq!(refused.err().unwrap().code, "denied");
    // One request waits; the next is rate limited without a lookup.
    let service = fixture.service.clone();
    let waiting = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    let id = asked(&fixture.notices).await;
    let ready = || fixture.service.human();
    let limited = pairings.pair(CLIENT, RELAY, unlooked, ready).await;
    assert_eq!(limited.err().unwrap().code, "rate_limited");
    pairings.answer(&id, false);
    waiting.await.unwrap();
}

const REMOVED: &str = "wss://removed.example";

/// A request for a removed community ended `code`, with nothing asked and
/// nothing left pending: the remaining community pairs unthrottled.
async fn a_removal_left_nothing_waiting(fixture: &Fixture, code: &str) {
    assert_eq!(code, "denied");
    assert!(fixture.notices.lock().unwrap().is_empty());
    let service = fixture.service.clone();
    let next = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    let id = asked(&fixture.notices).await;
    fixture.service.0.pairings.answer(&id, false);
    let (status, reply) = next.await.unwrap();
    assert_eq!(status, StatusCode::FORBIDDEN, "{reply}");
    assert_eq!(reply["message"], "Pairing was declined in Buzz");
}

#[tokio::test]
async fn a_removal_during_identity_loading_asks_nothing() {
    let fixture = fixture();
    let pairings = &fixture.service.0.pairings;
    pairings
        .set_communities(vec![RELAY.into(), REMOVED.into()])
        .await;
    let removing = std::sync::atomic::AtomicBool::new(true);
    let human = || async {
        if removing.swap(false, Ordering::SeqCst) {
            pairings.set_communities(vec![RELAY.into()]).await;
        }
        fixture.service.human().await
    };
    let unlooked = || async { panic!("a removed request looked up its caller") };
    let removed = pairings.pair(CLIENT, REMOVED, unlooked, human).await;
    a_removal_left_nothing_waiting(&fixture, removed.err().unwrap().code).await;
}

#[tokio::test]
async fn a_removal_during_the_process_lookup_asks_nothing() {
    let fixture = fixture();
    let pairings = &fixture.service.0.pairings;
    pairings
        .set_communities(vec![RELAY.into(), REMOVED.into()])
        .await;
    let lookup = || async {
        pairings.set_communities(vec![RELAY.into()]).await;
        Some("buzz".to_owned())
    };
    let removed = pairings
        .pair(CLIENT, REMOVED, lookup, || fixture.service.human())
        .await;
    a_removal_left_nothing_waiting(&fixture, removed.err().unwrap().code).await;
}
