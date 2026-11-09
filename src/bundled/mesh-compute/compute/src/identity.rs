//! Legacy Mesh owner identity, separate from the host-owned Nostr key.
use mesh_llm_host_runtime::crypto::{
    keystore_exists, keystore_metadata, load_keystore, load_owner_keypair_from_keychain,
    save_keystore, OwnerKeychainLoadError, OwnerKeypair,
};
use std::path::Path;

/// Preserve the host-selected owner identity, unlocking encrypted files through the SDK.
/// Only encrypted files consult the native credential store; this never writes credentials.
pub fn ensure_owner_at(path: &Path) -> anyhow::Result<String> {
    Ok(load_owner_at(path)?.owner_id())
}

/// Load the same owner for signing discovery; encrypted files use the existing loader.
pub fn load_owner_at(path: &Path) -> anyhow::Result<OwnerKeypair> {
    load_owner_with(path, load_owner_keypair_from_keychain)
}

#[cfg(test)]
fn ensure_owner_with(
    path: &Path,
    unlock: impl FnOnce(&Path) -> Result<OwnerKeypair, OwnerKeychainLoadError>,
) -> anyhow::Result<String> {
    Ok(load_owner_with(path, unlock)?.owner_id())
}

fn load_owner_with(
    path: &Path,
    unlock: impl FnOnce(&Path) -> Result<OwnerKeypair, OwnerKeychainLoadError>,
) -> anyhow::Result<OwnerKeypair> {
    let key = if keystore_exists(path) {
        if keystore_metadata(path)?.encrypted {
            unlock(path).map_err(|error| match error {
                OwnerKeychainLoadError::NoEntry => anyhow::anyhow!(
                    "Mesh identity is encrypted, but its unlock secret is not in the OS credential store. Unlock or configure this identity with mesh-llm before starting Mesh in Buzz. The existing keystore was not changed."
                ),
                OwnerKeychainLoadError::Crypto(error) => anyhow::anyhow!(
                    "Could not unlock the existing Mesh identity through the OS credential store: {error}. Check credential access and the identity with mesh-llm, then retry. The existing keystore was not changed."
                ),
            })?
        } else {
            load_keystore(path, None)?
        }
    } else {
        let key = OwnerKeypair::generate();
        save_keystore(path, &key, None, false)?;
        key
    };
    Ok(key)
}

use sha2::{Digest, Sha256};
pub fn member_binding_bytes(member_pubkey: &str) -> Vec<u8> {
    format!(
        "buzz-mesh-owner-binding-v1:{}",
        member_pubkey.trim().to_ascii_lowercase()
    )
    .into_bytes()
}

/// Canonical bytes binding a member-associated node identity to the exact set
/// of endpoint tokens in its status event.
pub fn member_endpoint_binding_bytes(member_pubkey: &str, endpoint_tokens: &[String]) -> Vec<u8> {
    let mut endpoints = endpoint_tokens
        .iter()
        .map(|token| token.trim())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    endpoints.sort_unstable();
    endpoints.dedup();

    let mut digest = Sha256::new();
    for endpoint in endpoints {
        digest.update((endpoint.len() as u64).to_be_bytes());
        digest.update(endpoint.as_bytes());
    }
    format!(
        "buzz-mesh-owner-endpoint-binding-v1:{}:{}",
        member_pubkey.trim().to_ascii_lowercase(),
        hex::encode(digest.finalize())
    )
    .into_bytes()
}

/// Extract endpoint tokens from a status payload using the same canonical
/// field rules for publication and verification.
pub fn advertised_endpoint_tokens(payload: &serde_json::Value) -> Option<Vec<String>> {
    let Some(targets) = payload
        .get("serveTargets")
        .or_else(|| payload.get("serve_targets"))
    else {
        return Some(Vec::new());
    };
    let targets = targets.as_array()?;
    targets
        .iter()
        .map(|target| {
            target
                .get("endpointAddr")
                .or_else(|| target.get("endpoint_addr"))?
                .as_str()
                .map(str::trim)
                .filter(|token| !token.is_empty())
                .map(ToString::to_string)
        })
        .collect()
}

/// Resolve the same SDK-owned path as legacy Desktop.
pub fn default_owner_path() -> anyhow::Result<std::path::PathBuf> {
    Ok(mesh_llm_host_runtime::crypto::default_keystore_path()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mesh_llm_host_runtime::crypto::CryptoError;

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "buzz-mesh-owner-{}-{}",
                std::process::id(),
                OwnerKeypair::generate().owner_id()
            )))
        }
        fn path(&self) -> std::path::PathBuf {
            self.0.join("owner.json")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn encrypted_owner_uses_credential_loader_and_preserves_file() {
        let fixture = Fixture::new();
        let path = fixture.path();
        let key = OwnerKeypair::generate();
        save_keystore(&path, &key, Some("fixture-secret"), false).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(load_keystore(&path, None).is_err());
        let owner = ensure_owner_with(&path, |requested| {
            assert_eq!(requested, path);
            // Inject only the credential boundary: real encrypted-file decryption.
            load_keystore(requested, Some("fixture-secret")).map_err(OwnerKeychainLoadError::Crypto)
        })
        .unwrap();
        assert_eq!(owner, key.owner_id());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn failed_unlock_never_replaces_or_decrypts_the_file() {
        let fixture = Fixture::new();
        let path = fixture.path();
        save_keystore(
            &path,
            &OwnerKeypair::generate(),
            Some("fixture-secret"),
            false,
        )
        .unwrap();
        let before = std::fs::read(&path).unwrap();
        for failure in [
            OwnerKeychainLoadError::NoEntry,
            OwnerKeychainLoadError::Crypto(CryptoError::KeychainAccessDenied {
                reason: "fixture denial".into(),
            }),
            OwnerKeychainLoadError::Crypto(CryptoError::KeychainUnavailable {
                reason: "fixture unavailable".into(),
            }),
            OwnerKeychainLoadError::Crypto(
                load_keystore(&path, Some("wrong-secret")).err().unwrap(),
            ),
        ] {
            let error = ensure_owner_with(&path, |_| Err(failure))
                .unwrap_err()
                .to_string();
            assert!(error.contains("credential"), "{error}");
            assert!(error.contains("not changed"), "{error}");
            assert!(!error.contains("fixture-secret"));
            assert_eq!(std::fs::read(&path).unwrap(), before);
        }
    }

    #[test]
    fn new_and_plaintext_owners_do_not_consult_credentials() {
        let fixture = Fixture::new();
        let path = fixture.path();
        let owner = ensure_owner_with(&path, |_| panic!("unexpected credential access")).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert_eq!(
            ensure_owner_with(&path, |_| panic!("unexpected credential access")).unwrap(),
            owner
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn malformed_existing_file_is_not_replaced() {
        let fixture = Fixture::new();
        std::fs::create_dir_all(&fixture.0).unwrap();
        let path = fixture.path();
        std::fs::write(&path, "invalid fixture").unwrap();
        assert!(ensure_owner_with(&path, |_| panic!("unexpected credential access")).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "invalid fixture");
    }
}
