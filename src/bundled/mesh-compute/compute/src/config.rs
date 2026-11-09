//! Host-only startup configuration. Never deserialize admission policy from plugin input.

use crate::transport_policy::{
    iroh_relay_mode, sdk_iroh_relay_config, validate_advertised_endpoint,
};
use mesh_llm_sdk::{client, MeshDiscoveryMode, TrustPolicy};
use std::path::PathBuf;
use std::time::Duration;

/// A consumer starts closed and learns dial targets through verified host discovery.
/// Serving reuses these host-owned transport and admission settings.
pub struct ClientConfig {
    pub api_port: u16,
    pub console_port: u16,
    pub owner_key: PathBuf,
    pub trusted_owners: Vec<String>,
    pub owner_id: String,
    pub join_token: Option<String>,
    pub mesh_name: Option<String>,
}

impl ClientConfig {
    pub fn build(self) -> anyhow::Result<client::EmbeddedClientConfig> {
        if self.api_port == 0 || self.console_port == 0 || self.api_port == self.console_port {
            anyhow::bail!("Mesh needs two distinct non-zero ports");
        }
        if !self.owner_key.is_absolute() {
            anyhow::bail!("Mesh owner keystore path must be absolute");
        }
        // Empty/unknown membership must not silently become TrustPolicy::Off.
        if self.trusted_owners.is_empty()
            || self
                .trusted_owners
                .iter()
                .any(|owner| owner.trim().is_empty())
        {
            anyhow::bail!("Verified Mesh owner admission is required");
        }
        if self.owner_id.trim().is_empty() {
            anyhow::bail!("Mesh owner identity is required");
        }
        let owners = normalized_roster(&Some(self.trusted_owners), &self.owner_id)
            .expect("roster supplied above");
        let (disabled, relays) = sdk_iroh_relay_config(iroh_relay_mode()?);
        let mut builder = client::EmbeddedClientConfig::builder()
            .api_port(self.api_port)
            .console_port(self.console_port)
            .owner_key(self.owner_key)
            .owner_required(true)
            .trust_policy(TrustPolicy::Allowlist)
            .trust_owners(owners)
            .disable_iroh_relays(disabled)
            .iroh_relays(relays)
            .publish(false)
            .auto_join(false)
            .discovery_mode(MeshDiscoveryMode::Nostr)
            .nostr_relays(Vec::<String>::new())
            .isolated_config(true)
            .console_ui(false)
            .startup_timeout(MESH_CLIENT_MANAGEMENT_TIMEOUT);
        if let Some(name) = self.mesh_name {
            builder = builder.mesh_name(name);
        }
        if let Some(token) = self.join_token {
            builder = builder.join_token(validate_advertised_endpoint(&token)?.join_token);
        }
        Ok(builder.build())
    }
}

/// Classic serving role on the same private community node, including solo serving.
pub struct ServeConfig {
    pub node: ClientConfig,
    pub model: String,
    pub max_vram_gb: Option<u64>,
}
impl ServeConfig {
    pub fn build(self) -> anyhow::Result<mesh_llm_sdk::serve::EmbeddedServeConfig> {
        let model = self.model.trim();
        if model.is_empty() {
            anyhow::bail!("Choose a model before sharing compute");
        }
        if self.max_vram_gb == Some(0) {
            anyhow::bail!("Shared compute memory limit must be positive");
        }
        let node = self.node.build()?;
        let mut config = mesh_llm_sdk::serve::EmbeddedServeConfig::builder()
            .model(model)
            .build();
        config.http = node.http;
        config.network = node.network;
        config.admission = node.admission;
        config.storage = node.storage;
        config.log_format = node.log_format;
        // Bounds SDK management readiness; Mesh owns subsequent model acquisition.
        config.startup_timeout = Duration::from_secs(180);
        config.serving.max_vram_gb = self.max_vram_gb.map(|gb| gb as f64);
        Ok(config)
    }
}

// Legacy management wait is deliberately longer than the ingress readiness deadline.
const MESH_CLIENT_MANAGEMENT_TIMEOUT: Duration = Duration::from_secs(365 * 24 * 60 * 60);

// Ported from legacy normalized_roster; only the identity argument is narrowed to its ID.
fn normalized_roster(
    trusted_owner_ids: &Option<Vec<String>>,
    owner_id: &str,
) -> Option<Vec<String>> {
    let ids = trusted_owner_ids.as_ref()?;
    let mut owners: Vec<String> = ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    owners.push(owner_id.to_owned());
    owners.sort();
    owners.dedup();
    Some(owners)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> ClientConfig {
        ClientConfig {
            api_port: 19337,
            console_port: 13131,
            owner_key: std::env::temp_dir().join("buzz-mesh-test-owner.json"),
            trusted_owners: vec!["fixture-owner".into()],
            owner_id: "self-owner".into(),
            join_token: None,
            mesh_name: Some("fixture-community".into()),
        }
    }

    #[test]
    fn solo_serving_has_no_remote_target_and_keeps_private_self_admission() {
        let mut node = config();
        node.trusted_owners = vec![node.owner_id.clone()];
        let result = ServeConfig {
            node,
            model: " fixture-model ".into(),
            max_vram_gb: Some(16),
        }
        .build()
        .unwrap();
        assert_eq!(result.serving.models, vec!["fixture-model"]);
        assert_eq!(result.serving.max_vram_gb, Some(16.0));
        assert_eq!(result.startup_timeout, Duration::from_secs(180));
        assert!(result.network.join_tokens.is_empty());
        assert!(!result.network.publish);
        assert!(!result.network.auto_join);
        assert!(result.network.nostr_relays.is_empty());
        assert_eq!(result.admission.trust_policy, Some(TrustPolicy::Allowlist));
        assert!(result.admission.owner_required);
        assert_eq!(result.admission.trusted_owners, vec!["self-owner"]);
        assert!(result.storage.isolated_config);
    }

    #[test]
    fn serving_rejects_missing_model_invalid_limit_and_missing_roster() {
        assert!(ServeConfig {
            node: config(),
            model: "  ".into(),
            max_vram_gb: None
        }
        .build()
        .is_err());
        assert!(ServeConfig {
            node: config(),
            model: "model".into(),
            max_vram_gb: Some(0)
        }
        .build()
        .is_err());
        let mut node = config();
        node.trusted_owners.clear();
        assert!(ServeConfig {
            node,
            model: "model".into(),
            max_vram_gb: None
        }
        .build()
        .is_err());
    }

    #[test]
    fn client_is_private_and_uses_explicit_owner_path() {
        let expected_path = config().owner_key;
        let result = config().build().unwrap();
        assert!(!result.network.publish);
        assert!(!result.network.auto_join);
        assert!(result.network.nostr_relays.is_empty());
        assert!(result.network.join_tokens.is_empty());
        assert!(result.storage.isolated_config);
        assert_eq!(result.admission.owner_key, Some(expected_path));
        assert!(result.admission.owner_required);
        assert_eq!(
            result.network.mesh_name.as_deref(),
            Some("fixture-community")
        );
        assert_eq!(result.startup_timeout, MESH_CLIENT_MANAGEMENT_TIMEOUT);
        assert_eq!(
            result.admission.trusted_owners,
            vec!["fixture-owner", "self-owner"]
        );
        assert_eq!(result.admission.trust_policy, Some(TrustPolicy::Allowlist));
    }

    #[test]
    fn normalizes_roster_without_losing_self() {
        assert_eq!(normalized_roster(&None, "self"), None);
        assert_eq!(
            normalized_roster(
                &Some(vec![" peer ".into(), "peer".into(), "".into()]),
                "self"
            ),
            Some(vec!["peer".into(), "self".into()])
        );
    }

    #[test]
    fn accepts_validated_initial_dial_target() {
        let mut request = config();
        let token = crate::transport_policy::endpoint_token_for_test([iroh::TransportAddr::Ip(
            "192.168.1.20:47916".parse().unwrap(),
        )]);
        request.join_token = Some(token.clone());
        assert_eq!(request.build().unwrap().network.join_tokens, vec![token]);
        let mut request = config();
        request.join_token = Some("invalid".into());
        assert!(request.build().is_err());
    }

    #[test]
    fn rejects_missing_admission_and_invalid_ports_or_paths() {
        let mut request = config();
        request.trusted_owners.clear();
        assert!(request.build().is_err());
        let mut request = config();
        request.console_port = request.api_port;
        assert!(request.build().is_err());
        let mut request = config();
        request.api_port = 0;
        assert!(request.build().is_err());
        let mut request = config();
        request.owner_key = "relative.json".into();
        assert!(request.build().is_err());
    }
}

/// Legacy community name derivation: hash the relay URL origin, preserving its scheme.
pub fn mesh_name_for_relay(relay_url: &str) -> String {
    use sha2::{Digest, Sha256};
    let normalized = url::Url::parse(relay_url.trim())
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|_| relay_url.trim().trim_end_matches('/').to_ascii_lowercase());
    let digest = hex::encode(Sha256::digest(normalized.as_bytes()));
    format!("buzz-community-{}", &digest[..32])
}

#[cfg(test)]
mod mesh_name_tests {
    #[test]
    fn matches_legacy_fixture_origin_hash() {
        assert_eq!(
            super::mesh_name_for_relay("wss://meshllm.communities.buzz.xyz/"),
            "buzz-community-d91dbf16b4343b6383e4ff067f7d9ecc"
        );
        assert_eq!(
            super::mesh_name_for_relay("wss://meshllm.communities.buzz.xyz/path"),
            super::mesh_name_for_relay("wss://meshllm.communities.buzz.xyz")
        );
    }
}
