//! Signed-event regressions adapted from classic Buzz's discovery tests.
use super::*;
use mesh_llm_host_runtime::crypto::OwnerKeypair;
use nostr::{
    event::{EventBuilder, FinalizeEvent, Kind, Tag},
    key::Keys,
    types::time::Timestamp,
};
use serde_json::{json, Value};

fn roster(relay: &Keys, members: &[&Keys]) -> nostr::event::Event {
    EventBuilder::new(Kind::Custom(13534), "")
        .tags(
            members
                .iter()
                .map(|member| Tag::parse(["member", &member.public_key().to_hex()]).unwrap()),
        )
        .finalize(relay)
        .unwrap()
}

fn status(member: &Keys, owner: &OwnerKeypair, port: u16) -> nostr::event::Event {
    let token = crate::transport_policy::endpoint_token_for_test([iroh::TransportAddr::Ip(
        ([192, 168, 1, 20], port).into(),
    )]);
    crate::publication::status_event(
        owner,
        &member.public_key().to_hex(),
        true,
        Some(&json!({"hosted_models": ["fixture-model"]})),
        Some(&token),
        None,
    )
    .unwrap()
    .finalize(member)
    .unwrap()
}

fn resign(member: &Keys, event: &nostr::event::Event, payload: Value) -> nostr::event::Event {
    EventBuilder::new(event.kind, payload.to_string())
        .tags(event.tags.clone())
        .finalize(member)
        .unwrap()
}

#[test]
fn spoofed_owner_and_cross_member_binding_cannot_admit_or_route() {
    let relay = Keys::generate();
    let member = Keys::generate();
    let other = Keys::generate();
    let owner = OwnerKeypair::generate();
    let good = status(&member, &owner, 47916);
    let membership = roster(&relay, &[&member]);
    let valid =
        verify_evidence(vec![membership.clone(), good.clone()], &relay.public_key()).unwrap();
    assert_eq!(owner_ids_from_events(&valid), vec![owner.owner_id()]);
    assert_eq!(availability_from_events(valid).serve_targets.len(), 1);

    let mut spoofed: Value = serde_json::from_str(&good.content).unwrap();
    spoofed["ownerId"] = json!("0".repeat(64));
    let cross_member = status(&other, &owner, 47916);
    for payload in [
        spoofed,
        serde_json::from_str(&cross_member.content).unwrap(),
    ] {
        // Both envelopes really are signed by the current member. It is the
        // claimed Mesh owner/binding, not the outer event signature, that fails.
        let bad = resign(&member, &good, payload);
        let verified = verify_evidence(vec![membership.clone(), bad], &relay.public_key()).unwrap();
        assert_eq!(verified.len(), 2);
        assert!(owner_ids_from_events(&verified).is_empty());
        assert!(availability_from_events(verified).serve_targets.is_empty());
    }
}

#[test]
fn removal_excludes_fresh_status_from_both_admission_and_routing() {
    let relay = Keys::generate();
    let member = Keys::generate();
    let removed = Keys::generate();
    let owner = OwnerKeypair::generate();
    let removed_owner = OwnerKeypair::generate();
    let good = status(&member, &owner, 47916);
    let removed_status = status(&removed, &removed_owner, 47917);
    let before = verify_evidence(
        vec![
            roster(&relay, &[&member, &removed]),
            good.clone(),
            removed_status.clone(),
        ],
        &relay.public_key(),
    )
    .unwrap();
    let mut expected = vec![owner.owner_id(), removed_owner.owner_id()];
    expected.sort();
    assert_eq!(owner_ids_from_events(&before), expected);
    assert_eq!(availability_from_events(before).serve_targets.len(), 2);

    let after = verify_evidence(
        vec![roster(&relay, &[&member]), good, removed_status],
        &relay.public_key(),
    )
    .unwrap();
    assert_eq!(owner_ids_from_events(&after), vec![owner.owner_id()]);
    let targets = availability_from_events(after).serve_targets;
    assert_eq!(targets.len(), 1);
    assert_eq!(
        targets[0].owner_id.as_deref(),
        Some(owner.owner_id().as_str())
    );
}

#[test]
fn stale_status_preserves_membership_admission_but_not_routing() {
    let relay = Keys::generate();
    let member = Keys::generate();
    let owner = OwnerKeypair::generate();
    let fresh = status(&member, &owner, 47916);
    let membership = roster(&relay, &[&member]);
    let control =
        verify_evidence(vec![membership.clone(), fresh.clone()], &relay.public_key()).unwrap();
    assert_eq!(availability_from_events(control).serve_targets.len(), 1);
    // Deliberately ancient timestamp, not a wall-clock boundary race.
    let stale = EventBuilder::new(fresh.kind, fresh.content)
        .tags(fresh.tags)
        .custom_created_at(Timestamp::from(1))
        .finalize(&member)
        .unwrap();
    let events = verify_evidence(vec![membership, stale], &relay.public_key()).unwrap();
    assert_eq!(owner_ids_from_events(&events), vec![owner.owner_id()]);
    assert!(availability_from_events(events).serve_targets.is_empty());
}

#[test]
fn one_member_can_advertise_two_distinct_owner_devices() {
    let relay = Keys::generate();
    let member = Keys::generate();
    let first = OwnerKeypair::generate();
    let second = OwnerKeypair::generate();
    let a = status(&member, &first, 47916);
    let b = status(&member, &second, 47917);
    assert_ne!(
        a.tags, b.tags,
        "devices need separate replaceable-event keys"
    );
    let events =
        verify_evidence(vec![roster(&relay, &[&member]), a, b], &relay.public_key()).unwrap();
    let mut expected = vec![first.owner_id(), second.owner_id()];
    expected.sort();
    assert_eq!(owner_ids_from_events(&events), expected);
    let targets = availability_from_events(events).serve_targets;
    assert_eq!(targets.len(), 2);
    let mut actual: Vec<_> = targets
        .iter()
        .map(|target| target.owner_id.clone().unwrap())
        .collect();
    actual.sort();
    assert_eq!(actual, expected);
    assert_ne!(targets[0].endpoint_addr, targets[1].endpoint_addr);
}

#[test]
fn a_restarting_consumer_never_joins_its_own_lingering_advert() {
    // Share Off stops the serve runtime, then a consumer restarts for running
    // agents. This machine's serving note is still fresh at that moment; joining
    // it made the SDK reject its own node id and retry forever.
    let relay = Keys::generate();
    let member = Keys::generate();
    let this_machine = OwnerKeypair::generate();
    let other_machine = OwnerKeypair::generate();
    let own = status(&member, &this_machine, 47916);
    let peer = status(&member, &other_machine, 47917);
    let events = verify_evidence(
        vec![roster(&relay, &[&member]), own, peer],
        &relay.public_key(),
    )
    .unwrap();
    let targets = availability_from_events(events).serve_targets;
    assert_eq!(targets.len(), 2);
    let peer_token = targets
        .iter()
        .find(|target| target.owner_id.as_deref() == Some(other_machine.owner_id().as_str()))
        .map(|target| target.endpoint_addr.clone())
        .unwrap();
    assert_eq!(
        peer_join_tokens(targets.clone(), &this_machine.owner_id()),
        vec![peer_token]
    );
    // Alone in the community, there is nothing to join: not a retry loop.
    let alone = targets
        .into_iter()
        .filter(|target| target.owner_id.as_deref() == Some(this_machine.owner_id().as_str()))
        .collect();
    assert!(peer_join_tokens(alone, &this_machine.owner_id()).is_empty());
}
