//! Exact-source read-only legacy lookup and create-only native credential custody.
//! No environment, shell or fallback to another legacy service.
use crate::{Credentials, LegacySource, Result, Secret};
use std::collections::BTreeMap;
use std::sync::Arc;
use zeroize::{Zeroize, Zeroizing};

#[cfg(any(target_os = "macos", test))]
mod bundle;
#[cfg(any(target_os = "macos", test))]
mod bundle_lock;
mod platform;
#[cfg(test)]
mod tests;

const SERVICE: &str = "xyz.block.buzz.desktop.agents";
/// The service before 1.0. Reads copy a key found only there; deletes remove it too.
const PREVIOUS_SERVICE: &str = "dev.local.buzz.foundation.agents";
const MAX_BLOB: usize = 2 * 1024 * 1024;
/// Another operation, in this app or another, holds the store; it may be retried.
pub const BUSY: &str = "Credentials are busy; retry after the current operation finishes";

/// Why the earlier app's human key could not be read.
#[derive(Debug)]
pub struct LegacyHumanError {
    pub message: String,
    /// The store was busy or unavailable, as when it is locked, so a later read
    /// may succeed. Otherwise no usable key is there: none, access was denied,
    /// or it is malformed.
    pub transient: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    Absent,
    Occupied,
    Denied,
    Corrupt,
    Unavailable,
    Busy,
}
impl Failure {
    fn message(self) -> String {
        match self {
            Self::Absent => "Selected agent credential is absent",
            Self::Occupied => {
                "Destination agent credential already exists; nothing was overwritten"
            }
            Self::Denied => "Secure storage access was denied; allow access explicitly and retry",
            Self::Corrupt => "Selected secure-storage credential is malformed",
            Self::Busy => BUSY,
            Self::Unavailable => "The OS credential store is unavailable on this platform",
        }
        .into()
    }
}

// Real OS calls and fixture calls share the entire Credentials implementation.
trait Keychain: Send + Sync {
    fn legacy(
        &self,
        service: &str,
        account: &str,
    ) -> std::result::Result<Zeroizing<Vec<u8>>, Failure>;
    fn saved(
        &self,
        service: &str,
        account: &str,
    ) -> std::result::Result<Zeroizing<Vec<u8>>, Failure>;
    fn add(&self, service: &str, account: &str, value: &[u8]) -> std::result::Result<(), Failure>;
    fn delete(&self, service: &str, account: &str) -> std::result::Result<(), Failure>;
    /// Copy an item create-only under the lock deleting it takes; see
    /// `buzz_credential_store::copy`. The macOS bundle has its own lock.
    fn copy(&self, _: &str, _: &str, _: &str) -> std::result::Result<(), Failure> {
        Err(Failure::Unavailable)
    }
    #[cfg(any(target_os = "macos", test))]
    fn replace(&self, _: &str, _: &str, _: &[u8]) -> std::result::Result<(), Failure> {
        Err(Failure::Unavailable)
    }
    #[cfg(any(target_os = "macos", test))]
    fn bundle_lock(&self) -> std::result::Result<Box<dyn bundle::BundleLock>, Failure> {
        Err(Failure::Unavailable)
    }
}

pub struct PlatformCredentials {
    keychain: Arc<dyn Keychain>,
    #[cfg(any(target_os = "macos", test))]
    bundle: Option<bundle::Bundle>,
}
impl Default for PlatformCredentials {
    fn default() -> Self {
        Self {
            keychain: Arc::new(platform::OsKeychain),
            #[cfg(any(target_os = "macos", test))]
            bundle: cfg!(target_os = "macos").then(bundle::Bundle::default),
        }
    }
}

fn account(id: &str) -> Result<String> {
    // A credential ID must have the imported exact-key/community digest shape.
    let (pubkey, community) = id
        .split_once('-')
        .ok_or("Invalid agent credential identifier")?;
    if !crate::config::canonical_key(pubkey) || !crate::config::canonical_key(community) {
        return Err("Invalid agent credential identifier".into());
    }
    Ok(format!("agent:{id}"))
}

impl PlatformCredentials {
    fn legacy_map(&self, source: LegacySource) -> std::result::Result<SecretMap, Failure> {
        let bytes = self.keychain.legacy(source.keyring_service(), "secrets")?;
        if bytes.len() > MAX_BLOB {
            return Err(Failure::Corrupt);
        }
        serde_json::from_slice(&bytes).map_err(|_| Failure::Corrupt)
    }
    /// The human key the selected earlier app saved, for a person's explicit
    /// bring-over. Read-only; the caller validates and persists it.
    pub fn read_legacy_human(
        &self,
        source: LegacySource,
    ) -> std::result::Result<Zeroizing<String>, LegacyHumanError> {
        match self.legacy_map(source) {
            Ok(map) => map
                .0
                .get("identity")
                .map(|value| Zeroizing::new(value.clone())),
            Err(Failure::Absent) => None,
            Err(failure) => {
                return Err(LegacyHumanError {
                    transient: matches!(failure, Failure::Busy | Failure::Unavailable),
                    message: failure.message(),
                })
            }
        }
        .ok_or_else(|| LegacyHumanError {
            message: "No identity from the earlier Buzz app was found".into(),
            transient: false,
        })
    }
}

impl Credentials for PlatformCredentials {
    fn retry(&self) {
        #[cfg(any(target_os = "macos", test))]
        if let Some(bundle) = &self.bundle {
            bundle.retry();
        }
    }
    fn read_legacy(&self, source: LegacySource, pubkey: &str) -> Result<Secret> {
        if !crate::config::canonical_key(pubkey) {
            return Err("Invalid selected agent identity".into());
        }
        let map = self.legacy_map(source).map_err(Failure::message)?;
        let value = map
            .0
            .get(&format!("agent:{pubkey}"))
            .ok_or_else(|| Failure::Absent.message())?;
        Secret::parse(value, pubkey)
    }
    fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>> {
        let account = account(id)?;
        if id.split_once('-').map(|(key, _)| key) != Some(pubkey) {
            return Err("Credential identifier does not match the selected agent".into());
        }
        #[cfg(any(target_os = "macos", test))]
        if let Some(bundle) = &self.bundle {
            return bundle.read(self.keychain.as_ref(), &account, pubkey);
        }
        let saved = |service| match self.keychain.saved(service, &account) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(Failure::Absent) => Ok(None),
            Err(error) => Err(error),
        };
        let bytes = buzz_credential_store::read_or_copy(
            || saved(SERVICE),
            || self.keychain.copy(PREVIOUS_SERVICE, SERVICE, &account),
        )
        .map_err(Failure::message)?;
        let Some(bytes) = bytes else {
            return Ok(None);
        };
        if bytes.len() > 64 {
            return Err(Failure::Corrupt.message());
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| Failure::Corrupt.message())?;
        Secret::parse(text, pubkey).map(Some)
    }
    fn add(&self, id: &str, key: &Secret) -> Result<()> {
        let account = account(id)?;
        if id.split_once('-').map(|(pubkey, _)| pubkey) != Some(key.pubkey()) {
            return Err("Credential identifier does not match the selected agent".into());
        }
        #[cfg(any(target_os = "macos", test))]
        if let Some(bundle) = &self.bundle {
            return bundle.add(self.keychain.as_ref(), &account, key);
        }
        let value = key.hex();
        self.keychain
            .add(SERVICE, &account, value.as_bytes())
            .map_err(Failure::message)
    }
    fn delete(&self, id: &str, pubkey: &str) -> Result<()> {
        let account = account(id)?;
        if id.split_once('-').map(|(key, _)| key) != Some(pubkey) {
            return Err("Credential identifier does not match the selected agent".into());
        }
        #[cfg(any(target_os = "macos", test))]
        if let Some(bundle) = &self.bundle {
            return bundle.delete(self.keychain.as_ref(), &account);
        }
        // The previous item first: reads copy it while the current one is absent.
        for service in [PREVIOUS_SERVICE, SERVICE] {
            match self.keychain.delete(service, &account) {
                Ok(()) | Err(Failure::Absent) => {}
                Err(error) => return Err(error.message()),
            }
        }
        Ok(())
    }
}

// Wipe all parsed values, including when parsing fails mid-map. Reject duplicate
// accounts rather than choosing a different key by JSON ordering.
#[derive(Default)]
struct SecretMap(BTreeMap<String, String>);
impl Drop for SecretMap {
    fn drop(&mut self) {
        for value in self.0.values_mut() {
            value.zeroize();
        }
    }
}
impl<'de> serde::Deserialize<'de> for SecretMap {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = SecretMap;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a credential map")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut entries: A,
            ) -> std::result::Result<SecretMap, A::Error> {
                let mut map = SecretMap::default();
                while let Some(key) = entries.next_key::<String>()? {
                    if map.0.contains_key(&key) {
                        return Err(serde::de::Error::custom("duplicate credential"));
                    }
                    let value = entries.next_value::<String>()?;
                    map.0.insert(key, value);
                }
                Ok(map)
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}
