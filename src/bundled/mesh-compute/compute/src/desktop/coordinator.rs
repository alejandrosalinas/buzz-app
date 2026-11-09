//! Donor roster and peer-join duties, scoped to the app-owned node.
use crate::{
    discovery::{availability_from_events, current_member_pubkeys, owner_ids_from_events},
    lifecycle::Phase,
    roster::{Decision, Observation, Reconcile},
};
use std::time::Duration;
use tauri::Manager;

pub(super) fn ensure_started(app: tauri::AppHandle, host: &super::MeshHost) -> Result<(), String> {
    let mut task = host
        .coordinator
        .lock()
        .map_err(|_| "Mesh coordinator unavailable")?;
    if task
        .as_ref()
        .is_some_and(|task| !task.inner().is_finished())
    {
        return Ok(());
    }
    *task = Some(tauri::async_runtime::spawn(async move {
        let mut generation = None;
        let mut roster = Reconcile::default();
        let mut roster_at = tokio::time::Instant::now() + Duration::from_secs(60);
        let mut delay = Duration::from_secs(15);
        loop {
            tokio::time::sleep(delay).await;
            let check_roster = tokio::time::Instant::now() >= roster_at;
            if check_roster {
                roster_at = tokio::time::Instant::now() + Duration::from_secs(60);
            }
            match reconcile(&app, &mut generation, &mut roster, check_roster).await {
                Ok(()) => delay = Duration::from_secs(15),
                Err(error) => {
                    eprintln!("Mesh community reconciliation failed: {error}");
                    delay = (delay * 2).min(Duration::from_secs(120));
                }
            }
        }
    }));
    Ok(())
}

async fn reconcile(
    app: &tauri::AppHandle,
    generation: &mut Option<String>,
    roster: &mut Reconcile,
    check_roster: bool,
) -> Result<(), String> {
    let host = app.state::<super::MeshHost>();
    let identity = app.state::<crate::desktop::host::Identity>();
    let Some((lease, community)) = host.lease.current()? else {
        return Ok(());
    };
    if !matches!(host.lifecycle.phase(), Phase::Starting | Phase::Ready) {
        return Ok(());
    }
    let Some((node, owner, owners, admitted_evidence)) = host
        .admission
        .lock()
        .map_err(|_| "Mesh admission unavailable")?
        .clone()
    else {
        return Ok(());
    };
    if generation.as_ref() != Some(&node) {
        *generation = Some(node.clone());
        *roster = Reconcile::default();
    }
    let viewer = identity.viewer().await?;
    // A successful membership read must take effect before optional status reads.
    let membership = match tokio::time::timeout(
        Duration::from_secs(10),
        super::discovery::read_membership(&identity, &community),
    )
    .await
    {
        Ok(Ok(events)) => events,
        result => {
            roster.observe(&owners, Observation::ReadFailed, false);
            return Err(match result {
                Ok(Err(error)) => error,
                _ => "Community membership read timed out".into(),
            });
        }
    };
    let admitted_at = admitted_evidence
        .iter()
        .filter(|event| event.kind.as_u16() == 13534)
        .map(|event| event.created_at)
        .max();
    let observed_at = membership.iter().map(|event| event.created_at).max();
    if observed_at < admitted_at {
        return Err("Ignoring older Mesh membership snapshot".into());
    }
    let removed = !current_member_pubkeys(&membership).contains(&viewer);
    let retained_records = retained_evidence(&admitted_evidence, &membership);
    let mut retained = owner_ids_from_events(&retained_records);
    retained.push(owner.clone());
    // Serialize admission against Share, Stop, selection, and agent startup.
    let shrinking = removed || owners.iter().any(|id| !retained.contains(id));
    let _guard = if shrinking {
        host.preparing.interrupt(Some(&lease)).await
    } else {
        host.preparing.lock().await
    };
    host.lease.community(&lease)?;
    if identity.viewer().await? != viewer {
        return Err("Identity changed during Mesh reconciliation".into());
    }
    if host
        .admission
        .lock()
        .map_err(|_| "Mesh admission unavailable")?
        .as_ref()
        .map(|value| &value.0)
        != Some(&node)
    {
        return Ok(());
    }
    if !matches!(host.lifecycle.phase(), Phase::Starting | Phase::Ready) {
        return Ok(());
    }
    if !removed && owners.iter().any(|id| !retained.contains(id)) {
        // Authoritative removal is not a liveness short-read. Stop the old admission
        // before trying optional discovery; a failed restart remains safely stopped.
        host.lifecycle
            .stop_and_wait()
            .await
            .map_err(|e| e.to_string())?;
        // Restart only with retained admission; failed status discovery cannot widen it.
        return recover_routes(
            &membership,
            &retained_records,
            &retained,
            async {
                tokio::time::timeout(
                    Duration::from_secs(10),
                    super::discovery::read_events(&identity, &community),
                )
                .await
                .map_err(|_| "Community status discovery timed out".to_owned())?
            },
            |targets| {
                super::start_with_evidence(
                    app,
                    &identity,
                    &lease,
                    retained.clone(),
                    targets,
                    retained_records.clone(),
                    true,
                )
            },
        )
        .await;
    }

    if removed {
        // Stop is requested even if lease revocation or agent cleanup fails.
        host.lifecycle.stop();
        host.lease.revoke(&lease)?;
        finish_revocation(async { Ok(()) }, async {
            host.lifecycle
                .stop_and_wait()
                .await
                .map_err(|error| error.to_string())
        })
        .await?;
        return Err("Community membership was removed; shared compute has stopped".into());
    }
    let events = tokio::time::timeout(
        Duration::from_secs(10),
        super::discovery::read_events(&identity, &community),
    )
    .await
    .map_err(|_| "Community status discovery timed out")??;
    // A second status read cannot roll back the separately verified roster.
    let events = retained_evidence(&events, &membership);
    if check_roster {
        let mut fresh = owner_ids_from_events(&events);
        fresh.push(owner.clone());
        let observation = Observation::Members(fresh);
        match roster.observe(
            &owners,
            observation,
            host.lifecycle.phase() == Phase::Starting,
        ) {
            Decision::ViewerRemoved => {
                host.lease.revoke(&lease)?;
                *host
                    .admission
                    .lock()
                    .map_err(|_| "Mesh admission unavailable")? = None;
                host.preferences
                    .lock()
                    .map_err(|_| "Mesh settings unavailable")?
                    .set_error(
                        "Community membership was removed; shared compute has stopped".into(),
                    );
                host.lifecycle
                    .stop_and_wait()
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
            Decision::Grow(_) | Decision::Shrink(_) => {
                // Keep saved sharing intent; this is not the user's Stop sharing.
                host.lifecycle
                    .stop_and_wait()
                    .await
                    .map_err(|e| e.to_string())?;
                let result = super::start_prepared(app, &host, &identity, &lease).await;
                if let Err(error) = &result {
                    host.preferences.lock().map_err(|_| "Mesh settings unavailable")?
                        .set_error(format!("Shared compute could not restart after membership changed: {error}. Reconnect to retry."));
                }
                return result;
            }
            Decision::Keep | Decision::AwaitConfirmation => {}
        }
    }
    if host.lifecycle.phase() != Phase::Ready {
        return Ok(());
    }
    let status = host.lifecycle.status().await.map_err(|e| e.to_string())?;
    let peers = visible_peer_ids(&status.payload);
    let availability = availability_from_events(events);
    let mut failure = None;
    for target in availability.serve_targets.into_iter().filter(|target| {
        target.owner_id.as_deref() != Some(owner.as_str())
            && !target_is_visible(target.endpoint_id.as_deref(), &peers)
    }) {
        host.lease.community(&lease)?;
        if let Err(error) = host.lifecycle.dial(&target.endpoint_addr) {
            failure = Some(error.to_string());
        }
    }
    failure.map_or(Ok(()), Err)
}

async fn finish_revocation(
    agents: impl std::future::Future<Output = Result<(), String>>,
    node: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), String> {
    let (agents, node) = tokio::join!(agents, node);
    node?;
    agents
}

// Optional routing failure must not prevent rebuilding the reduced admission.
async fn recover_routes<F, R>(
    membership: &[nostr::event::Event],
    admitted: &[nostr::event::Event],
    owners: &[String],
    discovery: F,
    restart: impl FnOnce(Vec<crate::discovery_types::MeshServeTarget>) -> R,
) -> Result<(), String>
where
    F: std::future::Future<Output = Result<Vec<nostr::event::Event>, String>>,
    R: std::future::Future<Output = Result<(), String>>,
{
    let events = discovery.await;
    restart(retained_targets(
        events.as_deref().unwrap_or(admitted),
        membership,
        owners,
    ))
    .await
}

// Fresh routes may be used only for the retained admission set. They never widen it.
fn retained_targets(
    events: &[nostr::event::Event],
    membership: &[nostr::event::Event],
    owners: &[String],
) -> Vec<crate::discovery_types::MeshServeTarget> {
    availability_from_events(retained_evidence(events, membership))
        .serve_targets
        .into_iter()
        .filter(|target| {
            target
                .owner_id
                .as_ref()
                .is_some_and(|owner| owners.contains(owner))
        })
        .collect()
}

// Reuse only previously verified owner bindings; new admission needs full discovery.
fn retained_evidence(
    admitted: &[nostr::event::Event],
    membership: &[nostr::event::Event],
) -> Vec<nostr::event::Event> {
    let members = current_member_pubkeys(membership);
    membership
        .iter()
        .filter(|event| event.kind.as_u16() == 13534)
        .chain(admitted.iter().filter(|event| {
            event.kind.as_u16() != 13534 && members.contains(&event.pubkey.to_hex())
        }))
        .cloned()
        .collect()
}

fn visible_peer_ids(payload: &serde_json::Value) -> Vec<String> {
    payload
        .get("peers")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|peer| peer.get("id").and_then(serde_json::Value::as_str))
        .map(|id| id.trim().to_ascii_lowercase())
        .filter(|id| !id.is_empty())
        .collect()
}
fn target_is_visible(endpoint: Option<&str>, peers: &[String]) -> bool {
    let Some(endpoint) = endpoint else {
        return false;
    };
    let endpoint = endpoint.trim().to_ascii_lowercase();
    !endpoint.is_empty()
        && peers.iter().any(|peer| {
            !peer.is_empty() && (endpoint.starts_with(peer) || peer.starts_with(&endpoint))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_membership_revokes_captured_owner_without_status_and_never_admits_new_owner() {
        use nostr::{
            event::{EventBuilder, FinalizeEvent, Kind, Tag},
            key::Keys,
        };
        let relay = Keys::generate();
        let a = Keys::generate();
        let b = Keys::generate();
        let new = Keys::generate();
        let dir = tempfile::tempdir().unwrap();
        let owner_a = crate::identity::load_owner_at(&dir.path().join("a.json")).unwrap();
        let owner_b = crate::identity::load_owner_at(&dir.path().join("b.json")).unwrap();
        let roster =
            |members: &[&Keys]| {
                EventBuilder::new(Kind::Custom(13534), "")
                    .tags(members.iter().map(|member| {
                        Tag::parse(["member", &member.public_key().to_hex()]).unwrap()
                    }))
                    .finalize(&relay)
                    .unwrap()
            };
        let status = |member: &Keys, owner| {
            crate::publication::status_event(
                owner,
                &member.public_key().to_hex(),
                false,
                None,
                None,
                None,
            )
            .unwrap()
            .finalize(member)
            .unwrap()
        };
        let admitted = vec![
            roster(&[&a, &b]),
            status(&a, &owner_a),
            status(&b, &owner_b),
        ];
        let membership = vec![roster(&[&a, &new])];
        // Optional advertisements are unavailable: only captured bindings are present.
        let retained = retained_evidence(&admitted, &membership);
        assert_eq!(owner_ids_from_events(&retained), vec![owner_a.owner_id()]);
        assert!(!retained.iter().any(|event| event.pubkey == b.public_key()));
        assert_eq!(current_member_pubkeys(&retained).len(), 2);
    }

    #[tokio::test]
    async fn recovery_uses_fresh_retained_routes_not_expired_admission_or_new_owners() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        use nostr::{
            event::{EventBuilder, FinalizeEvent, Kind, Tag},
            key::Keys,
            types::time::Timestamp,
        };
        let relay = Keys::generate();
        let member = Keys::generate();
        let newcomer = Keys::generate();
        let dir = tempfile::tempdir().unwrap();
        let owner = crate::identity::load_owner_at(&dir.path().join("owner.json")).unwrap();
        let new_owner = crate::identity::load_owner_at(&dir.path().join("new.json")).unwrap();
        let token = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "id": hex::encode(owner.verifying_key().as_bytes()),
                "addrs": [{"Ip": "192.168.1.20:47916"}]
            }))
            .unwrap(),
        );
        let raw = serde_json::json!({"hosted_models": ["fixture-model"]});
        let old = crate::publication::status_event(
            &owner,
            &member.public_key().to_hex(),
            true,
            Some(&raw),
            Some(&token),
            None,
        )
        .unwrap()
        .custom_created_at(Timestamp::from_secs(Timestamp::now().as_secs() - 180))
        .finalize(&member)
        .unwrap();
        let fresh = crate::publication::status_event(
            &owner,
            &member.public_key().to_hex(),
            true,
            Some(&raw),
            Some(&token),
            None,
        )
        .unwrap()
        .finalize(&member)
        .unwrap();
        let new = crate::publication::status_event(
            &new_owner,
            &newcomer.public_key().to_hex(),
            true,
            Some(&raw),
            Some(&token),
            None,
        )
        .unwrap()
        .finalize(&newcomer)
        .unwrap();
        let membership = vec![EventBuilder::new(Kind::Custom(13534), "")
            .tags([
                Tag::parse(["member", &member.public_key().to_hex()]).unwrap(),
                Tag::parse(["member", &newcomer.public_key().to_hex()]).unwrap(),
            ])
            .finalize(&relay)
            .unwrap()];
        let owners = vec![owner.owner_id()];
        assert!(retained_targets(std::slice::from_ref(&old), &membership, &owners).is_empty());
        recover_routes(
            &membership,
            &[old],
            &owners,
            async { Ok(vec![fresh, new]) },
            |targets| {
                assert_eq!(targets.len(), 1);
                assert_eq!(targets[0].owner_id.as_ref(), Some(&owner.owner_id()));
                std::future::ready(Ok(()))
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn revocation_finishes_node_stop_even_when_agent_cleanup_fails() {
        let stopped = std::cell::Cell::new(false);
        let error = finish_revocation(async { Err("agent cleanup failed".into()) }, async {
            stopped.set(true);
            Ok(())
        })
        .await
        .unwrap_err();
        assert!(stopped.get());
        assert_eq!(error, "agent cleanup failed");
        assert_eq!(
            finish_revocation(async { Err("agent failed".into()) }, async {
                Err("node failed".into())
            })
            .await
            .unwrap_err(),
            "node failed"
        );
    }

    #[tokio::test]
    async fn removal_restarts_with_empty_routes_when_optional_discovery_fails() {
        let restarted = std::cell::Cell::new(false);
        recover_routes(
            &[],
            &[],
            &["retained-owner".into()],
            async { Err("relay unavailable".into()) },
            |targets| {
                assert!(targets.is_empty());
                restarted.set(true);
                std::future::ready(Ok(()))
            },
        )
        .await
        .unwrap();
        assert!(restarted.get());
        let error = recover_routes(
            &[],
            &[],
            &[],
            async { Err("relay unavailable".into()) },
            |_| std::future::ready(Err("restart failed".into())),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "restart failed");
    }

    #[test]
    fn donor_peer_shape_and_short_ids_are_preserved() {
        let peers = visible_peer_ids(
            &serde_json::json!({"peers":[{"id":" ABC123 "},{"id":"def456"},{"name":"ignored"}]}),
        );
        assert_eq!(peers, ["abc123", "def456"]);
        assert!(target_is_visible(Some("ABC1234567890"), &peers));
        assert!(!target_is_visible(Some("other"), &peers));
        assert!(!target_is_visible(Some("  "), &peers));
        assert!(!target_is_visible(None, &peers));
    }
}
