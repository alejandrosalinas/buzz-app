//! Every invocation captures one community URL; no authority cache crosses communities.
use crate::desktop::host::Identity as IdentityHost;
use crate::{
    discovery::{availability_from_events, current_member_pubkeys, owner_ids_from_events},
    discovery_query,
};
use nostr::key::PublicKey;

pub(super) async fn read(
    host: &IdentityHost,
    community: &str,
) -> Result<
    (
        Vec<String>,
        Vec<crate::discovery_types::MeshServeTarget>,
        Vec<nostr::event::Event>,
    ),
    String,
> {
    let events = member_events(host, community).await?;
    let owners = owner_ids_from_events(&events);
    let targets = availability_from_events(events.clone()).serve_targets;
    Ok((owners, targets, events))
}

/// Read authoritative membership independently of optional model advertisements.
pub(super) async fn read_membership(
    host: &IdentityHost,
    community: &str,
) -> Result<Vec<nostr::event::Event>, String> {
    let viewer = host.viewer().await?;
    let info = host.relay_read(community, None).await?;
    let authority = info
        .get("self")
        .and_then(serde_json::Value::as_str)
        .ok_or("Relay did not advertise its identity")?;
    let authority = PublicKey::from_hex(authority).map_err(|_| "Invalid relay identity")?;
    let data = host
        .relay_read(
            community,
            Some(crate::discovery::authoritative_membership_filter(
                &authority,
            )),
        )
        .await?;
    let values = data.as_array().ok_or("Invalid Mesh membership response")?;
    let events = values
        .iter()
        .cloned()
        .filter_map(|value| serde_json::from_value(value).ok())
        .collect();
    let events =
        crate::discovery::verify_evidence(events, &authority).map_err(|error| error.to_string())?;
    if host.viewer().await? != viewer {
        return Err("Identity changed during Mesh membership read".into());
    }
    Ok(events)
}

pub(super) async fn read_events(
    host: &IdentityHost,
    community: &str,
) -> Result<Vec<nostr::event::Event>, String> {
    let viewer = host.viewer().await?;
    let info = host.relay_read(community, None).await?;
    let authority = info
        .get("self")
        .and_then(serde_json::Value::as_str)
        .ok_or("Relay did not advertise its identity")?;
    let authority = PublicKey::from_hex(authority).map_err(|_| "Invalid relay identity")?;
    let events = discovery_query::discover(&authority, |filter| async move {
        let data = host
            .relay_read(community, Some(filter))
            .await
            .map_err(std::io::Error::other)?;
        let values = data
            .as_array()
            .ok_or_else(|| std::io::Error::other("Invalid Mesh query result"))?;
        Ok(values.clone())
    })
    .await
    .map_err(|error| error.to_string())?;
    if host.viewer().await? != viewer {
        return Err("Identity changed during Mesh discovery".into());
    }
    Ok(events)
}

pub(super) async fn inventory(
    host: &IdentityHost,
    community: &str,
) -> Result<crate::inventory::Inventory, String> {
    let events = member_events(host, community).await?;
    Ok(crate::inventory::project(availability_from_events(
        events.clone(),
    )))
}

async fn member_events(
    host: &IdentityHost,
    community: &str,
) -> Result<Vec<nostr::event::Event>, String> {
    let events = read_events(host, community).await?;
    if !current_member_pubkeys(&events).contains(&host.viewer().await?) {
        return Err("Current identity is not a member of this Mesh community".into());
    }
    Ok(events)
}
