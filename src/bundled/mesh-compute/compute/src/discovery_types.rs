use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MeshModelOption {
    pub id: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeshServeTarget {
    pub model_id: String,
    pub model_name: Option<String>,
    pub endpoint_addr: String,
    /// Buzz member that signed the discovery note containing this target.
    /// Populated after signature/membership validation; never trusted from the
    /// note payload itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reporter_pubkey: Option<String>,
    /// Per-runtime MeshLLM owner identity verified by the signed Buzz status.
    /// Distinguishes two devices logged into the same Buzz member account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    pub node_name: Option<String>,
    pub capacity: Option<MeshTargetCapacity>,
    #[serde(default)]
    pub endpoint_id: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeshTargetCapacity {
    pub vram_gb: Option<f64>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AvailabilityState {
    #[default]
    Unavailable,
    Empty,
    Available,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeshAvailability {
    #[serde(default)]
    pub state: AvailabilityState,
    pub reason: Option<String>,
    pub models: Vec<MeshModelOption>,
    pub serve_targets: Vec<MeshServeTarget>,
}

impl MeshAvailability {
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            state: AvailabilityState::Unavailable,
            reason: Some(reason.into()),
            models: Vec::new(),
            serve_targets: Vec::new(),
        }
    }
}

pub(crate) fn dedupe_models(models: Vec<MeshModelOption>) -> Vec<MeshModelOption> {
    // Key by canonical id so `@main` / non-`@main` forms of the same model
    // dedup together. Display the canonical (stripped) id so the UI shows one
    // stable label; selection still matches because the picker canonicalizes
    // both sides too.
    let mut by_id = BTreeMap::<String, Option<String>>::new();
    for model in models {
        by_id
            .entry(canonical_model_id(&model.id))
            .and_modify(|name| {
                if name.is_none() {
                    *name = model.name.clone();
                }
            })
            .or_insert(model.name);
    }
    by_id
        .into_iter()
        .map(|(id, name)| MeshModelOption { id, name })
        .collect()
}
pub const MESH_STATUS_KIND: u64 = 30003;

fn canonical_model_id(value: &str) -> String {
    value.trim().replace("@main", "")
}
