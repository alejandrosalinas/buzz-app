//! Community-only status notes, compatible with classic Buzz's discovery reader.
use mesh_llm_host_runtime::crypto::OwnerKeypair;
use nostr::event::{EventBuilder, Kind, Tag};
use serde_json::{json, Value};

use crate::discovery_types::{
    dedupe_models, MeshModelOption, MeshServeTarget, MeshTargetCapacity, MESH_STATUS_KIND,
};
use crate::identity::{member_binding_bytes, member_endpoint_binding_bytes};
use crate::transport_policy::validate_advertised_endpoint;

/// Facts about this machine that members see beside its shared models.
/// Allowlisted: the chip name and rated memory. Hostnames are deliberately not
/// published: managed machines report asset tags, which name nothing useful
/// and leak inventory identifiers to the community.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LocalDevice {
    pub name: Option<String>,
    pub vram_gb: Option<f64>,
}

/// Survey this machine once per process; heartbeats reuse the answer. Memory
/// is the same rated capacity the model catalog shows as "AI memory".
pub fn local_device() -> &'static LocalDevice {
    static DEVICE: std::sync::OnceLock<LocalDevice> = std::sync::OnceLock::new();
    DEVICE.get_or_init(|| {
        let survey = mesh_llm_system::hardware::survey();
        LocalDevice {
            name: survey.gpu_name.as_deref().and_then(device_label),
            vram_gb: mesh_llm_system::vram::rated_capacity_gb(survey.vram_bytes)
                .map(|gb| gb as f64),
        }
    })
}

/// Trimmed and bounded; a blank OS report is no name rather than an empty one.
fn device_label(reported: &str) -> Option<String> {
    let name = reported.trim();
    (!name.is_empty()).then(|| name.chars().take(64).collect())
}

/// Project the pinned SDK wrapper; its payload is untyped JSON, not a typed model schema.
pub fn sdk_status_event(
    owner: &OwnerKeypair,
    member: &str,
    serving: bool,
    status: &mesh_llm_sdk::EmbeddedNodeStatus,
    device: &LocalDevice,
) -> anyhow::Result<EventBuilder> {
    status_event(
        owner,
        member,
        serving,
        Some(&status.payload),
        status.invite_token.as_deref(),
        Some(device),
    )
}

/// Construct only the discovery fields; never publish the SDK's raw status or invite.
/// A consumer/stopped heartbeat carries owner bindings but no serving targets.
pub fn status_event(
    owner: &OwnerKeypair,
    member: &str,
    serving: bool,
    status: Option<&Value>,
    endpoint: Option<&str>,
    device: Option<&LocalDevice>,
) -> anyhow::Result<EventBuilder> {
    nostr::key::PublicKey::from_hex(member)?;
    let models = if serving {
        ready_models(status)
    } else {
        Vec::new()
    };
    let endpoint = if serving && !models.is_empty() {
        endpoint.map(validate_advertised_endpoint).transpose()?
    } else {
        None
    };
    let tokens = endpoint
        .as_ref()
        .map(|value| vec![value.join_token.clone()])
        .unwrap_or_default();
    let targets = endpoint
        .map(|endpoint| {
            models
                .iter()
                .map(|model| MeshServeTarget {
                    model_id: model.id.clone(),
                    model_name: model.name.clone(),
                    endpoint_addr: endpoint.join_token.clone(),
                    reporter_pubkey: None,
                    owner_id: None,
                    node_name: status
                        .and_then(|v| v["node_id"].as_str())
                        .map(str::to_owned),
                    capacity: device.and_then(|device| device.vram_gb).map(|vram_gb| {
                        MeshTargetCapacity {
                            vram_gb: Some(vram_gb),
                        }
                    }),
                    endpoint_id: Some(endpoint.endpoint_id.clone()),
                    device_id: None,
                    device_name: device.and_then(|device| device.name.clone()),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // Capacity is advertised only while serving; a consumer contributes none.
    let device = device.filter(|_| !targets.is_empty());
    let mut payload = json!({
        "ownerId": owner.owner_id(),
        "ownerVerifyingKey": hex::encode(owner.verifying_key().as_bytes()),
        "ownerBindingSig": hex::encode(owner.sign_bytes(&member_binding_bytes(member))),
        "ownerEndpointBindingSig": hex::encode(owner.sign_bytes(&member_endpoint_binding_bytes(member, &tokens))),
        "models": models,
        "serveTargets": targets,
    });
    // Top-level keys classic Buzz's snapshot reader already understands.
    if let Some(name) = device.and_then(|device| device.name.as_deref()) {
        payload["deviceName"] = json!(name);
    }
    if let Some(vram_gb) = device.and_then(|device| device.vram_gb) {
        payload["my_vram_gb"] = json!(vram_gb);
    }
    Ok(
        EventBuilder::new(Kind::Custom(MESH_STATUS_KIND as u16), payload.to_string()).tags([
            Tag::parse([
                "d",
                &format!("buzz-mesh-member-status:{}", owner.owner_id()),
            ])?,
            Tag::parse(["k", "buzz-mesh-status"])?,
        ]),
    )
}

// Ported from classic mesh_llm/mod.rs:847-912. Requested serving_models are not ready.
fn ready_models(status: Option<&Value>) -> Vec<MeshModelOption> {
    fn collect(value: &Value, out: &mut Vec<MeshModelOption>) {
        match value {
            Value::Array(values) => {
                for value in values {
                    collect(value, out);
                }
            }
            Value::Object(map) => {
                let id = ["model_id", "modelId", "model_ref", "modelRef", "id", "name"]
                    .iter()
                    .find_map(|key| map.get(*key))
                    .and_then(Value::as_str);
                if let Some(id) = id {
                    push(
                        out,
                        id,
                        map.get("display_name")
                            .or_else(|| map.get("displayName"))
                            .and_then(Value::as_str),
                    );
                } else {
                    for value in map.values().filter(|v| v.is_array() || v.is_object()) {
                        collect(value, out);
                    }
                }
            }
            Value::String(id) => push(out, id, None),
            _ => {}
        }
    }
    fn push(out: &mut Vec<MeshModelOption>, id: &str, name: Option<&str>) {
        let id = id.trim();
        if !id.is_empty() && !id.starts_with("http://") && !id.starts_with("https://") {
            out.push(MeshModelOption {
                id: id.into(),
                name: name.map(str::to_owned),
            });
        }
    }
    let mut models = Vec::new();
    if let Some(status) = status {
        for key in ["models", "hosted_models"] {
            if let Some(value) = status.get(key) {
                collect(value, &mut models);
            }
        }
        if let Some(runtime) = status["runtime"]["models"].as_array() {
            for model in runtime.iter().filter(|model| model["status"] == "ready") {
                collect(model, &mut models);
            }
        }
        // Mesh keys a cached GGUF as `local-gguf/sha256-…`; its own model
        // catalog (`/api/models` `display_name`) carries the readable ref.
        if let Some(names) = status[DISPLAY_NAMES_KEY].as_object() {
            for model in &mut models {
                let unnamed = model.name.as_deref().is_none_or(|name| name == model.id);
                if let (true, Some(name)) = (unnamed, names.get(&model.id).and_then(Value::as_str))
                {
                    model.name = Some(name.to_owned());
                }
            }
        }
    }
    dedupe_models(models)
}

/// Host-injected `{mesh model name: display name}` from Mesh's `/api/models`.
pub const DISPLAY_NAMES_KEY: &str = "buzz_display_names";

/// Project Mesh's `/api/models` response into the display-name map.
pub fn display_names_from_models(models: &Value) -> Value {
    let mut names = serde_json::Map::new();
    for model in models["mesh_models"].as_array().into_iter().flatten() {
        if let (Some(name), Some(display)) =
            (model["name"].as_str(), model["display_name"].as_str())
        {
            if name != display && !display.trim().is_empty() {
                names.insert(name.to_owned(), Value::String(display.to_owned()));
            }
        }
    }
    Value::Object(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_gguf_models_advertise_meshs_own_display_name() {
        // Shapes captured from a live Mesh 0.78.1 node serving a cached HF GGUF.
        let hash =
            "local-gguf/sha256-7756e8943d5ec98b1cd76895d33d20b8c8bf7609a71540fc9b6fa512bdedd0de";
        let catalog = json!({"mesh_models": [
            {"name": hash, "display_name": "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M"},
            {"name": "unsloth/Qwen3.5-9B-GGUF:Q4_K_M", "display_name": "unsloth/Qwen3.5-9B-GGUF:Q4_K_M"},
        ]});
        let mut raw = json!({
            "models": [hash],
            "runtime": {"models": [{"name": hash, "status": "ready"}]},
        });
        raw[DISPLAY_NAMES_KEY] = display_names_from_models(&catalog);
        let models = ready_models(Some(&raw));
        assert_eq!(models.len(), 1);
        // The routing id stays exactly what Mesh serves; only the label changes.
        assert_eq!(models[0].id, hash);
        assert_eq!(
            models[0].name.as_deref(),
            Some("unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M")
        );
        // Without Mesh's catalog the id is still published unchanged.
        raw.as_object_mut().unwrap().remove(DISPLAY_NAMES_KEY);
        assert_eq!(ready_models(Some(&raw))[0].name, None);
    }
    use crate::discovery::{availability_from_events, owner_ids_from_events};
    use nostr::event::FinalizeEvent;
    use nostr::key::Keys;

    #[test]
    fn rc4_schema_projects_ready_models_through_pinned_sdk_status_wrapper() {
        let raw: Value =
            serde_json::from_str(include_str!("../fixtures/sdk-status-ready.json")).unwrap();
        let owner = OwnerKeypair::generate();
        let member = Keys::generate();
        let token = crate::transport_policy::endpoint_token_for_test([iroh::TransportAddr::Ip(
            "192.168.1.20:9999".parse().unwrap(),
        )]);
        let sdk = mesh_llm_sdk::EmbeddedNodeStatus {
            api_base_url: "http://127.0.0.1:19337/v1".into(),
            console_url: "http://127.0.0.1:13131".into(),
            invite_token: Some(token.clone()),
            payload: raw.clone(),
        };
        let event = sdk_status_event(
            &owner,
            &member.public_key().to_hex(),
            true,
            &sdk,
            &LocalDevice::default(),
        )
        .unwrap()
        .finalize(&member)
        .unwrap();
        let payload: Value = serde_json::from_str(&event.content).unwrap();
        assert_eq!(payload["serveTargets"].as_array().unwrap().len(), 1);
        assert_eq!(
            payload["serveTargets"][0]["modelId"],
            raw["hosted_models"][0]
        );
        assert_eq!(payload["models"].as_array().unwrap().len(), 1);
        assert!(payload.get("runtime").is_none());
        // Independently exercise the runtime-only path used before hosted_models catches up.
        assert_eq!(
            ready_models(Some(&json!({"runtime": raw["runtime"]})))[0].id,
            raw["hosted_models"][0].as_str().unwrap()
        );
    }

    #[test]
    fn signed_note_round_trips_discovery_and_does_not_publish_standby_or_raw_status() {
        let member = Keys::generate();
        let owner = OwnerKeypair::generate();
        let token = crate::transport_policy::endpoint_token_for_test([iroh::TransportAddr::Ip(
            "192.168.1.20:9999".parse().unwrap(),
        )]);
        let raw = json!({"hosted_models":["ready-model"], "runtime":{"models":[{"id":"warming-model","status":"loading"}]}, "serving_models":["requested-only"], "secret":"do-not-publish"});
        let event = status_event(
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
        event.verify().unwrap();
        assert!(!event.content.contains("do-not-publish"));
        assert!(!event.content.contains("warming-model"));
        assert!(!event.content.contains("requested-only"));
        let membership = EventBuilder::new(Kind::Custom(13534), "")
            .tags([Tag::parse(["member", &member.public_key().to_hex()]).unwrap()])
            .finalize(&Keys::generate())
            .unwrap();
        // Even the legitimate Nostr member cannot substitute a dial pointer
        // without the Mesh owner's endpoint signature.
        let mut altered: Value = serde_json::from_str(&event.content).unwrap();
        altered["serveTargets"][0]["endpointAddr"] =
            json!(crate::transport_policy::endpoint_token_for_test([
                iroh::TransportAddr::Ip("192.168.1.21:9999".parse().unwrap())
            ]));
        let altered = EventBuilder::new(Kind::Custom(MESH_STATUS_KIND as u16), altered.to_string())
            .tags(event.tags.clone())
            .finalize(&member)
            .unwrap();
        assert!(availability_from_events(vec![membership.clone(), altered])
            .serve_targets
            .is_empty());
        let events = vec![membership.clone(), event];
        assert_eq!(owner_ids_from_events(&events), vec![owner.owner_id()]);
        let available = availability_from_events(events);
        assert_eq!(available.serve_targets.len(), 1);
        assert_eq!(available.serve_targets[0].model_id, "ready-model");
        let stopped = status_event(
            &owner,
            &member.public_key().to_hex(),
            false,
            Some(&raw),
            Some(&token),
            None,
        )
        .unwrap()
        .finalize(&member)
        .unwrap();
        assert!(!stopped.content.contains(&token));
        let events = vec![membership, stopped];
        assert_eq!(owner_ids_from_events(&events), vec![owner.owner_id()]);
        assert!(availability_from_events(events).serve_targets.is_empty());
    }

    #[test]
    fn invalid_endpoint_is_not_signed_and_only_ready_runtime_models_count() {
        let raw = json!({"runtime":{"models":[{"model_ref":"ready","status":"ready"},{"id":"pending","status":"standby"}]}});
        assert_eq!(ready_models(Some(&raw))[0].id, "ready");
        assert_eq!(ready_models(Some(&raw)).len(), 1);
        assert!(status_event(
            &OwnerKeypair::generate(),
            &Keys::generate().public_key().to_hex(),
            true,
            Some(&raw),
            Some("invalid-token"),
            None,
        )
        .is_err());
    }

    #[test]
    fn serving_note_names_the_device_and_its_memory_only_while_serving() {
        let member = Keys::generate();
        let owner = OwnerKeypair::generate();
        let token = crate::transport_policy::endpoint_token_for_test([iroh::TransportAddr::Ip(
            "192.168.1.20:9999".parse().unwrap(),
        )]);
        let raw = json!({"hosted_models": ["ready-model"]});
        let device = LocalDevice {
            name: device_label("  Apple M4 Max "),
            vram_gb: Some(64.0),
        };
        let membership = EventBuilder::new(Kind::Custom(13534), "")
            .tags([Tag::parse(["member", &member.public_key().to_hex()]).unwrap()])
            .finalize(&Keys::generate())
            .unwrap();
        let note = |serving| {
            status_event(
                &owner,
                &member.public_key().to_hex(),
                serving,
                Some(&raw),
                Some(&token),
                Some(&device),
            )
            .unwrap()
            .finalize(&member)
            .unwrap()
        };
        let serving = note(true);
        let payload: Value = serde_json::from_str(&serving.content).unwrap();
        // Classic Buzz reads these top-level keys; this app reads the targets.
        assert_eq!(payload["deviceName"], "Apple M4 Max");
        assert_eq!(payload["my_vram_gb"], 64.0);
        let target = &availability_from_events(vec![membership.clone(), serving]).serve_targets[0];
        assert_eq!(target.device_name.as_deref(), Some("Apple M4 Max"));
        assert_eq!(target.capacity.as_ref().and_then(|c| c.vram_gb), Some(64.0));
        // A stopped heartbeat contributes no capacity and names no device.
        let stopped = note(false);
        assert!(!stopped.content.contains("Apple M4 Max"));
        assert!(!stopped.content.contains("my_vram_gb"));
        assert_eq!(device_label("   "), None);
    }
}
