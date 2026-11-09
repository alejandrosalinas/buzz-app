//! Allowlisted relay-advertised inventory. Never exports routing tokens or owner bindings.
use crate::discovery_types::{AvailabilityState, MeshAvailability};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub unavailable: Option<String>,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub device_id: Option<String>,
    pub member_pubkey: String,
    pub model_id: String,
    pub model_name: Option<String>,
    pub device_name: Option<String>,
    pub vram_gb: Option<f64>,
}

/// Project only already-verified discovery results; preserve unavailable evidence.
pub fn project(availability: MeshAvailability) -> Inventory {
    let unavailable = if availability.state == AvailabilityState::Unavailable {
        Some(
            availability
                .reason
                .unwrap_or_else(|| "Community mesh is unavailable".into()),
        )
    } else {
        None
    };
    let entries = availability
        .serve_targets
        .into_iter()
        .filter_map(|target| {
            Some(Entry {
                device_id: target.device_id,
                member_pubkey: target.reporter_pubkey?,
                model_id: target.model_id,
                model_name: target.model_name,
                device_name: target.device_name,
                vram_gb: target
                    .capacity
                    .and_then(|capacity| capacity.vram_gb)
                    .filter(|value| value.is_finite() && *value >= 0.0),
            })
        })
        .collect();
    Inventory {
        unavailable,
        entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery_types::{MeshServeTarget, MeshTargetCapacity};

    #[test]
    fn projection_excludes_routing_secrets_and_keeps_member_fields() {
        let target = MeshServeTarget {
            model_id: "model".into(),
            model_name: Some("Model".into()),
            endpoint_addr: "secret-join-token".into(),
            reporter_pubkey: Some("member".into()),
            owner_id: Some("private-binding".into()),
            node_name: None,
            capacity: Some(MeshTargetCapacity {
                vram_gb: Some(32.0),
            }),
            endpoint_id: Some("endpoint".into()),
            device_id: Some("device-id".into()),
            device_name: Some("Workstation".into()),
        };
        let value = serde_json::to_value(project(MeshAvailability {
            state: AvailabilityState::Available,
            reason: None,
            models: vec![],
            serve_targets: vec![target],
        }))
        .unwrap();
        assert_eq!(
            value["entries"][0],
            serde_json::json!({
                "deviceId": "device-id", "memberPubkey": "member", "modelId": "model", "modelName": "Model",
                "deviceName": "Workstation", "vramGb": 32.0
            })
        );
        assert!(!value.to_string().contains("secret-join-token"));
        assert!(!value.to_string().contains("private-binding"));
    }

    #[test]
    fn unavailable_is_not_empty_success() {
        assert!(project(MeshAvailability::unavailable(
            "Buzz shared compute status is malformed"
        ))
        .unavailable
        .is_some());
        let empty = project(MeshAvailability {
            state: AvailabilityState::Empty,
            reason: Some("Any future display wording".into()),
            models: vec![],
            serve_targets: vec![],
        });
        assert!(empty.unavailable.is_none());
        assert!(empty.entries.is_empty());
    }
}
