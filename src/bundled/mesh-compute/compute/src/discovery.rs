//! Legacy discovery readers ported from block/buzz 5fdb2e536.
//! Callers must validate signed events and relay membership authority first.
use std::collections::{BTreeMap, BTreeSet};

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

use super::discovery_types::{
    dedupe_models, MeshAvailability, MeshModelOption, MeshServeTarget, MESH_STATUS_KIND,
};

/// Running-node status notes are refreshed every 45 seconds. Routing ignores
/// notes older than two minutes so crashed/offline devices stop contributing
/// compute without a relay-side cleanup job. Admission intentionally does not:
/// Buzz membership, rather than device liveness, is the trust boundary.
pub(super) const STATUS_FRESHNESS_SECS: u64 = 120;
pub const MESH_STATUS_PAGE_SIZE: usize = 100;

fn status_is_fresh(event: &nostr::event::Event, now: u64) -> bool {
    event
        .created_at
        .as_secs()
        .saturating_add(STATUS_FRESHNESS_SECS)
        >= now
}

fn dedupe_targets(targets: Vec<MeshServeTarget>) -> Vec<MeshServeTarget> {
    let mut by_endpoint_and_model = BTreeMap::<(String, String), MeshServeTarget>::new();
    for target in targets {
        by_endpoint_and_model
            .entry((target.endpoint_addr.clone(), target.model_id.clone()))
            .or_insert(target);
    }
    by_endpoint_and_model.into_values().collect()
}

/// Resolve the mesh admission roster from relay status and membership events.
///
/// Only status notes signed by a currently listed NIP-43 direct member
/// contribute an owner id. This removes stale notes from former members and
/// ignores notes from nonmembers. If the relay has no membership snapshot, the
/// roster is empty and MeshLLM admission therefore remains self-only.
///
/// Admission deliberately ignores status freshness: membership is the trust
/// boundary, and a member whose device is offline (stale status) is still a
/// member. Gating admission on freshness caused the allowlist — and therefore
/// the serving node — to churn whenever any member's app went online or
/// offline. Freshness still gates *routing* (see `availability_from_events`):
/// stale nodes are never selected as serve targets. Revocation is unaffected:
/// a member removed from the NIP-43 roster leaves the intersection at the next
/// roster poll regardless of how fresh their last status is.
pub fn owner_ids_from_events(events: &[nostr::event::Event]) -> Vec<String> {
    let Some(members) = latest_membership_list(events) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = events
        .iter()
        .filter(|event| event.kind.as_u16() as u64 == MESH_STATUS_KIND)
        .filter(|event| {
            reporter_pubkey_from_status_event(event)
                .is_some_and(|reporter| members.contains(&reporter.to_ascii_lowercase()))
        })
        .filter_map(owner_id_from_status_event)
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

fn latest_membership_list(events: &[nostr::event::Event]) -> Option<BTreeSet<String>> {
    events
        .iter()
        .filter(|event| event.kind.as_u16() == 13_534)
        .max_by_key(|event| event.created_at)
        .map(|event| {
            event
                .tags
                .iter()
                .filter_map(|tag| {
                    let slice = tag.as_slice();
                    let name = slice.first()?;
                    if name != "member" && name != "p" {
                        return None;
                    }
                    slice
                        .get(1)
                        .map(|pubkey| pubkey.trim().to_ascii_lowercase())
                })
                .filter(|pubkey| !pubkey.is_empty())
                .collect()
        })
}

/// Join tokens for other machines only. This machine's own advert (same Mesh
/// owner) can outlive its runtime by a heartbeat, and joining it makes the SDK
/// reject the token as its own node id and retry forever.
pub fn peer_join_tokens(targets: Vec<MeshServeTarget>, own_owner: &str) -> Vec<String> {
    targets
        .into_iter()
        .filter(|target| target.owner_id.as_deref() != Some(own_owner))
        .map(|target| target.endpoint_addr)
        .collect()
}

pub fn current_member_pubkeys(events: &[nostr::event::Event]) -> Vec<String> {
    latest_membership_list(events)
        .map(BTreeSet::into_iter)
        .map(Iterator::collect)
        .unwrap_or_default()
}

/// Whether the relay actually returned a NIP-43 membership snapshot (kind
/// 13534) in `events`.
///
/// The relay publishes an explicit membership event even for a zero-member
/// community, so its presence is what makes an empty roster *authoritative*.
/// Callers use this to distinguish "the community genuinely has no members"
/// (snapshot present, zero `member` tags) from "no snapshot came back at all"
/// (a transient relay gap / replication lag). Only the former may shrink the
/// admission roster; the latter must be surfaced as an error so the reconcile
/// loop keeps the current allowlist instead of restarting to self-only.
pub fn has_membership_snapshot(events: &[nostr::event::Event]) -> bool {
    events.iter().any(|event| event.kind.as_u16() == 13_534)
}

fn owner_id_from_status_event(event: &nostr::event::Event) -> Option<String> {
    let content = serde_json::from_str::<serde_json::Value>(&event.content).ok()?;
    let owner_id = content
        .get("ownerId")
        .or_else(|| content.get("owner_id"))?
        .as_str()?
        .trim();
    let verifying_key_bytes: [u8; 32] =
        hex::decode(content.get("ownerVerifyingKey")?.as_str()?.trim())
            .ok()?
            .try_into()
            .ok()?;
    let derived_owner = hex::encode(Sha256::digest(verifying_key_bytes));
    if owner_id != derived_owner {
        return None;
    }
    let signature_bytes = hex::decode(content.get("ownerBindingSig")?.as_str()?.trim()).ok()?;
    let signature = Signature::from_slice(&signature_bytes).ok()?;
    let verifying_key = VerifyingKey::from_bytes(&verifying_key_bytes).ok()?;
    verifying_key
        .verify(
            &super::identity::member_binding_bytes(&event.pubkey.to_hex()),
            &signature,
        )
        .ok()?;
    Some(owner_id.to_string())
}

fn endpoint_binding_is_valid(event: &nostr::event::Event, content: &serde_json::Value) -> bool {
    let Some(endpoint_tokens) = super::identity::advertised_endpoint_tokens(content) else {
        return false;
    };
    let Some(verifying_key_bytes) = content
        .get("ownerVerifyingKey")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .and_then(|value| hex::decode(value).ok())
        .and_then(|value| <[u8; 32]>::try_from(value).ok())
    else {
        return false;
    };
    let Some(signature) = content
        .get("ownerEndpointBindingSig")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .and_then(|value| hex::decode(value).ok())
        .and_then(|value| Signature::from_slice(&value).ok())
    else {
        return false;
    };
    let Ok(verifying_key) = VerifyingKey::from_bytes(&verifying_key_bytes) else {
        return false;
    };
    verifying_key
        .verify(
            &super::identity::member_endpoint_binding_bytes(
                &event.pubkey.to_hex(),
                &endpoint_tokens,
            ),
            &signature,
        )
        .is_ok()
}

pub fn availability_from_events(events: Vec<nostr::event::Event>) -> MeshAvailability {
    if events.is_empty() {
        return MeshAvailability::unavailable("Buzz shared compute status is not published yet");
    }
    let Some(members) = latest_membership_list(&events) else {
        return MeshAvailability::unavailable(
            "Buzz shared compute is waiting for the current member roster",
        );
    };

    // Status is replaceable per member pubkey, so a query returns multiple
    // events. Aggregate only current members: a removed member's last status
    // must not remain selectable after their admission is revoked.
    let mut all_targets = Vec::<MeshServeTarget>::new();
    let mut all_models = Vec::<MeshModelOption>::new();
    let mut saw_valid_status = false;

    let now = nostr::types::time::Timestamp::now().as_secs();
    for event in events {
        if event.kind.as_u16() as u64 != MESH_STATUS_KIND
            || !status_is_fresh(&event, now)
            || !members.contains(&event.pubkey.to_hex().to_ascii_lowercase())
        {
            continue;
        }
        let Ok(content) = serde_json::from_str::<serde_json::Value>(&event.content) else {
            continue;
        };
        let Some(owner_id) = owner_id_from_status_event(&event) else {
            continue;
        };
        if !endpoint_binding_is_valid(&event, &content) {
            continue;
        }
        saw_valid_status = true;
        let reporter_pubkey = event.pubkey.to_hex().to_ascii_lowercase();
        let mut serve_targets = content
            .get("serveTargets")
            .or_else(|| content.get("serve_targets"))
            .cloned()
            .and_then(|value| serde_json::from_value::<Vec<MeshServeTarget>>(value).ok())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|mut target| {
                let validated =
                    super::transport_policy::validate_advertised_endpoint(&target.endpoint_addr)
                        .ok()?;
                target.endpoint_addr = validated.join_token;
                target.reporter_pubkey = Some(reporter_pubkey.clone());
                target.owner_id = Some(owner_id.clone());
                if target.endpoint_id.is_none() {
                    target.endpoint_id = Some(validated.endpoint_id);
                }
                if target.device_id.is_none() {
                    target.device_id = target.endpoint_id.clone();
                }
                if target.device_name.is_none() {
                    target.device_name = target
                        .node_name
                        .clone()
                        .or_else(|| target.endpoint_id.as_deref().map(short_endpoint_label));
                }
                Some(target)
            })
            .collect::<Vec<_>>();

        let mut models = content
            .get("models")
            .cloned()
            .and_then(|value| serde_json::from_value::<Vec<MeshModelOption>>(value).ok())
            .unwrap_or_else(|| {
                dedupe_models(
                    serve_targets
                        .iter()
                        .map(|target| MeshModelOption {
                            id: target.model_id.clone(),
                            name: target.model_name.clone(),
                        })
                        .collect(),
                )
            });
        all_targets.append(&mut serve_targets);
        all_models.append(&mut models);
    }

    if !saw_valid_status {
        return MeshAvailability::unavailable("Buzz shared compute status is malformed");
    }

    let serve_targets = dedupe_targets(all_targets);
    let models = dedupe_models(all_models);
    let available = !serve_targets.is_empty();
    MeshAvailability {
        state: if available {
            crate::discovery_types::AvailabilityState::Available
        } else {
            crate::discovery_types::AvailabilityState::Empty
        },
        reason: if available {
            None
        } else {
            Some("no Buzz shared compute serving members are available".to_string())
        },
        models,
        serve_targets,
    }
}

/// Status filter for admission and availability queries.
///
/// Deliberately has no `since` bound: status events are parameterized
/// replaceable (one per member), and admission must see a member's latest
/// owner binding even when that member has been offline for longer than
/// [`STATUS_FRESHNESS_SECS`]. Freshness is applied *after* the query, and only
/// where it belongs — routing (`availability_from_events`), never admission
/// (`owner_ids_from_events`).
pub fn mesh_status_filter() -> serde_json::Value {
    serde_json::json!({
        "kinds": [MESH_STATUS_KIND],
        "#k": ["buzz-mesh-status"],
        "limit": MESH_STATUS_PAGE_SIZE
    })
}

pub fn relay_membership_filter() -> serde_json::Value {
    serde_json::json!({
        "kinds": [13534],
        "limit": 1
    })
}

fn reporter_pubkey_from_status_event(event: &nostr::event::Event) -> Option<String> {
    // Discovery notes are signed by the member that owns the MeshLLM identity.
    // The generic relay only stores/queries them; it is not an identity oracle.
    Some(event.pubkey.to_hex())
}

fn short_endpoint_label(endpoint_id: &str) -> String {
    endpoint_id.chars().take(12).collect()
}

/// Keep independently verified records; a bad member note cannot veto the community.
/// The authority is obtained by the host from this community's NIP-11 `self`.
pub fn verify_evidence(
    events: Vec<nostr::event::Event>,
    authority: &nostr::key::PublicKey,
) -> anyhow::Result<Vec<nostr::event::Event>> {
    let events: Vec<_> = events
        .into_iter()
        .filter(|event| {
            let expected = match event.kind.as_u16() {
                13534 => &event.pubkey == authority,
                30003 => {
                    event.tags.iter().any(|tag| {
                        let values = tag.as_slice();
                        values.first().map(String::as_str) == Some("k")
                            && values.get(1).map(String::as_str) == Some("buzz-mesh-status")
                    }) && serde_json::from_str::<serde_json::Value>(&event.content)
                        .is_ok_and(|value| value.is_object())
                }
                _ => false,
            };
            let accepted = expected && event.verify().is_ok();
            if !accepted {
                // Never echo member-controlled content, credentials or dial tokens.
                eprintln!(
                    "Mesh discovery discarded event {}: invalid signature, shape or authority",
                    event.id
                );
            }
            accepted
        })
        .collect();
    if !has_membership_snapshot(&events) {
        anyhow::bail!("Relay returned no verified membership snapshot from its authority");
    }
    Ok(events)
}

/// Only the captured relay authority may supply membership, never member notes.
pub fn authoritative_membership_filter(authority: &nostr::key::PublicKey) -> serde_json::Value {
    let mut filter = relay_membership_filter();
    filter["authors"] = serde_json::json!([authority.to_hex()]);
    filter
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{
        event::{EventBuilder, FinalizeEvent},
        key::Keys,
    };

    #[test]
    fn rejects_missing_wrong_author_and_corrupt_membership() {
        let keys = Keys::generate();
        let other = Keys::generate();
        let event = EventBuilder::new(nostr::event::Kind::Custom(13534), "")
            .finalize(&keys)
            .unwrap();
        assert!(verify_evidence(vec![], &keys.public_key()).is_err());
        assert!(verify_evidence(vec![event.clone()], &other.public_key()).is_err());
        assert!(verify_evidence(vec![event.clone()], &keys.public_key()).is_ok());
        let mut corrupt = event;
        corrupt.content = "tampered".into();
        assert!(verify_evidence(vec![corrupt], &keys.public_key()).is_err());
    }
    #[test]
    fn bad_member_notes_do_not_hide_a_valid_target() {
        use mesh_llm_host_runtime::crypto::OwnerKeypair;
        use nostr::event::{Kind, Tag};
        let relay = Keys::generate();
        let member = Keys::generate();
        let attacker = Keys::generate();
        let owner = OwnerKeypair::generate();
        let token = crate::transport_policy::endpoint_token_for_test([iroh::TransportAddr::Ip(
            "192.168.1.20:47916".parse().unwrap(),
        )]);
        let content = serde_json::json!({
            "ownerId": owner.owner_id(),
            "ownerVerifyingKey": hex::encode(owner.verifying_key().as_bytes()),
            "ownerBindingSig": hex::encode(owner.sign_bytes(&crate::identity::member_binding_bytes(&member.public_key().to_hex()))),
            "ownerEndpointBindingSig": hex::encode(owner.sign_bytes(&crate::identity::member_endpoint_binding_bytes(&member.public_key().to_hex(), std::slice::from_ref(&token)))),
            "serveTargets": [{"modelId":"fixture", "endpointAddr":token}]
        });
        let roster = EventBuilder::new(Kind::Custom(13534), "")
            .tags([Tag::parse(["member", &member.public_key().to_hex()]).unwrap()])
            .finalize(&relay)
            .unwrap();
        let status = EventBuilder::new(Kind::Custom(30003), content.to_string())
            .tags([Tag::parse(["k", "buzz-mesh-status"]).unwrap()])
            .finalize(&member)
            .unwrap();
        let mut tampered = status.clone();
        tampered.content = "tampered".into();
        let foreign_roster = EventBuilder::new(Kind::Custom(13534), "")
            .finalize(&attacker)
            .unwrap();
        let verified = verify_evidence(
            vec![roster, status, tampered, foreign_roster],
            &relay.public_key(),
        )
        .unwrap();
        assert_eq!(verified.len(), 2);
        assert_eq!(owner_ids_from_events(&verified), vec![owner.owner_id()]);
        let available = availability_from_events(verified);
        assert_eq!(available.serve_targets.len(), 1);
        assert_eq!(available.serve_targets[0].model_id, "fixture");
        assert_eq!(
            authoritative_membership_filter(&relay.public_key())["authors"],
            serde_json::json!([relay.public_key().to_hex()])
        );
    }
}

#[cfg(test)]
#[path = "discovery_regression_tests.rs"]
mod regression_tests;
