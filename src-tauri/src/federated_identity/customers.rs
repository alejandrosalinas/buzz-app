//! Builderlab customers' sign-in servers, derived from their communities'
//! hosts and listed so every launch adds them again.
use super::config::{canonical_relay, Config};
use url::Url;

/// The sign-in server of a Builderlab customer's community, derived from its
/// host: `buzz.{name}.builderlab.xyz` signs in at `https://{name}.builderlab.xyz`.
/// Only builds that trust the built-in server (`is_built_in`) use it, and a
/// compiled server that covers the host wins over it. Like a compiled host
/// pattern, it trusts Builderlab's DNS; the relay never names the server.
pub(super) fn builderlab_customer(relay: &str) -> Option<Config> {
    let relay = Url::parse(&canonical_relay(relay).ok()?).ok()?;
    let name = relay
        .host_str()?
        .strip_prefix("buzz.")?
        .strip_suffix(".builderlab.xyz")?;
    if relay.port().is_some()
        || name.is_empty()
        || name.len() > 63
        || name.starts_with('-')
        || name.ends_with('-')
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return None;
    }
    let origin = format!("https://{name}.builderlab.xyz");
    Config::parse(
        &serde_json::json!({"version": 1, "id": builderlab_customer_id(name),
            "identityOrigin": origin, "communityHosts": [format!("buzz.{name}.builderlab.xyz")],
            "adapterBase": format!("{origin}/api/goose"), "apiBasePath": "/api/goose/"})
        .to_string(),
    )
    .ok()
}

/// A customer server's id: `bb-{name}`, as Builderlab names its deployments
/// (the built-in one is `bb-public`), so the derived descriptor is identical
/// to one a build lists for the same deployment and finds the session that
/// build saved. Past the 64-byte limit (names of 61 to 63 bytes) it keeps the
/// name's first 44 bytes and adds 16 hex digits of its SHA-256, exactly 64
/// bytes, which no shorter name's plain id (at most 63) can equal.
fn builderlab_customer_id(name: &str) -> String {
    use sha2::{Digest, Sha256};
    let id = format!("bb-{name}");
    if id.len() < 64 {
        return id;
    }
    let digest = Sha256::digest(name.as_bytes());
    let hash: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!("bb-{}-{hash}", &name[..44])
}

/// The profile Builderlab customers' servers are added for, and where they
/// are listed.
pub(super) struct Customers {
    pub(super) profile: String,
    /// The community host of every customer server added, one per line, so
    /// the next launch adds each again even once none of its communities
    /// remain: its saved session stays in Settings, and deleting an agent
    /// still retires its grant there (`AgentTokens::forget`). Hosts only,
    /// nothing secret; a full Buzz sign-out deletes it (`store::remove_all`).
    /// `None` keeps no list, for tests: no launch adds a server again.
    pub(super) record: Option<std::path::PathBuf>,
}
impl Customers {
    pub(super) fn hosts(&self) -> Vec<String> {
        let Some(record) = &self.record else {
            return Vec::new();
        };
        match std::fs::read_to_string(record) {
            Ok(hosts) => hosts.lines().map(str::to_owned).collect(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(_) => {
                eprintln!("Builderlab customers' sign-in servers could not be read");
                Vec::new()
            }
        }
    }
    /// Lists `host`, durably, before its server is used.
    pub(super) fn remember(&self, host: &str) -> Result<(), String> {
        let Some(record) = &self.record else {
            return Ok(());
        };
        if self.hosts().iter().any(|known| known == host) {
            return Ok(());
        }
        use std::io::Write;
        let failed = |_| "The sign-in server could not be recorded".to_string();
        if let Some(root) = record.parent() {
            std::fs::create_dir_all(root).map_err(failed)?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(record)
            .map_err(failed)?;
        file.write_all(format!("{host}\n").as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::federated_identity::config::{self, SignIn};

    #[test]
    fn a_builderlab_customer_server_is_derived_from_its_host() {
        let config = builderlab_customer("wss://buzz.acme-2.builderlab.xyz").unwrap();
        assert_eq!(config.id, "bb-acme-2");
        assert_eq!(config.identity_origin, "https://acme-2.builderlab.xyz");
        assert_eq!(
            config.endpoint("/v1/login/start").as_str(),
            "https://acme-2.builderlab.xyz/api/goose/v1/login/start"
        );
        assert!(config.sign_in == SignIn::OnDemand && config.organization.is_none());
        assert!(config
            .matches_relay("wss://buzz.acme-2.builderlab.xyz")
            .unwrap());
        assert!(!config
            .matches_relay("wss://buzz.other.builderlab.xyz")
            .unwrap());
        for relay in [
            "wss://buzz.builderlab.xyz",
            "wss://buzz..builderlab.xyz",
            "wss://buzz.a.b.builderlab.xyz",
            "wss://buzz.-acme.builderlab.xyz",
            "wss://buzz.acme-.builderlab.xyz",
            "wss://buzz.acme.builderlab.xyz:8443",
            "wss://buzz.acme.builderlab.xyz/path",
            "wss://buzz.acme.builderlab.xyz.example",
            "wss://xbuzz.acme.builderlab.xyz",
            "wss://acme.builderlab.xyz",
            "ws://buzz.acme.builderlab.xyz",
            &format!("wss://buzz.{}.builderlab.xyz", "a".repeat(64)),
        ] {
            assert!(builderlab_customer(relay).is_none(), "{relay}");
        }
        let built_in = Config::parse(config::BUILT_IN).unwrap();
        assert!(built_in.is_built_in());
        assert!(!config.is_built_in());
        // Presentation is not identity.
        let mut presented = built_in.clone();
        presented.organization = Some("Builderlab".into());
        assert!(presented.is_built_in());
    }

    #[test]
    fn every_valid_tenant_label_gets_a_bounded_distinct_id() {
        let id = |name: &str| {
            builderlab_customer(&format!("wss://buzz.{name}.builderlab.xyz"))
                .unwrap()
                .id
        };
        let plain = "a".repeat(60);
        assert_eq!(id(&plain), format!("bb-{plain}"));
        assert_eq!(id(&plain).len(), 63);
        let mut ids = std::collections::BTreeSet::new();
        for name in [
            "a".repeat(61),
            "a".repeat(62),
            "a".repeat(63),
            "a".repeat(62) + "b",
        ] {
            let id = id(&name);
            assert_eq!(id.len(), 64, "{name}");
            assert!(id.starts_with(&format!("bb-{}-", &name[..44])));
            // Stable across launches, so its saved session is found again.
            assert_eq!(
                id,
                builderlab_customer(&format!("wss://buzz.{name}.builderlab.xyz"))
                    .unwrap()
                    .id
            );
            assert!(ids.insert(id));
        }
        // A name spelled like another's hashed id gets an id of its own.
        let hashed = id(&"a".repeat(63));
        let lookalike = &hashed["bb-".len()..];
        assert_eq!(lookalike.len(), 61);
        assert_ne!(id(lookalike), hashed);
    }

    #[test]
    fn a_derived_server_finds_the_session_a_listed_one_saved() {
        // A build listing the same deployment (presentation aside) saves its
        // session under the same fingerprint, so a build deriving it reuses it.
        let listed = Config::parse(
            r#"{"version":1,"id":"bb-acme","identityOrigin":"https://acme.builderlab.xyz","communityHosts":["buzz.acme.builderlab.xyz"],"adapterBase":"https://acme.builderlab.xyz/api/goose","apiBasePath":"/api/goose/","signIn":"at-launch","organization":"Acme"}"#,
        )
        .unwrap();
        let derived = builderlab_customer("wss://buzz.acme.builderlab.xyz").unwrap();
        assert_eq!(
            serde_json::to_value(derived.identity()).unwrap(),
            serde_json::to_value(listed.identity()).unwrap()
        );
    }
}
