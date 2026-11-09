//! Secure records plus durable, nonsensitive refusal markers outside wiped app data.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::PathBuf, sync::Mutex};
use zeroize::{Zeroize, Zeroizing};

/// Not keyed by app identifier: like the human key, every Buzz copy of this
/// flavour shares each server's session per profile, and Sign out of Buzz
/// erases them all.
pub(crate) const SERVICE: &str = if cfg!(debug_assertions) {
    "xyz.block.buzz.desktop.federated-session.debug"
} else {
    "xyz.block.buzz.desktop.federated-session"
};
const MAX_BUNDLE: usize = 1024 * 1024;

pub(crate) type LoadedRecord = (Option<Zeroizing<Vec<u8>>>, Option<String>);
/// A secure item as read, if present.
type Item = Option<Zeroizing<Vec<u8>>>;

pub(crate) trait Store: Send + Sync {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str>;
    fn compare(
        &self,
        expected: Option<&[u8]>,
        replacement: Option<&[u8]>,
    ) -> Result<(), &'static str>;
    fn load(&self) -> Result<LoadedRecord, &'static str>;
    fn remove(&self, expected: &[u8], revision: &str) -> Result<(), &'static str>;
}

pub(crate) struct SecureStore {
    pub(super) account: String,
    pub(super) root: PathBuf,
    /// Whether grants share the session's item; otherwise each record is an
    /// item of its own, as before bundles.
    pub(super) bundled: bool,
}
/// Only macOS prompts once per item, and a Windows credential holds at most
/// 2,560 bytes, so only macOS bundles (as the native agent key bundle does).
pub(crate) const BUNDLED: bool = cfg!(target_os = "macos");

/// The one secure item per profile and configuration: the owner's session
/// record and every agent grant (or retirement record), each as its exact
/// bytes, so every update compares the slot it read. Grants outlive the session.
#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Bundle {
    bundle: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    grants: BTreeMap<String, String>,
}
impl Drop for Bundle {
    fn drop(&mut self) {
        self.session.zeroize();
        self.grants.values_mut().for_each(Zeroize::zeroize);
    }
}
/// Before bundles, the item held only the session record: read it as one.
fn decode(raw: &[u8]) -> Result<Bundle, &'static str> {
    if raw.len() > MAX_BUNDLE {
        return Err("storage-corrupt");
    }
    if let Ok(bundle) = serde_json::from_slice::<Bundle>(raw) {
        return if bundle.bundle == 1 {
            Ok(bundle)
        } else {
            Err("storage-corrupt")
        };
    }
    serde_json::from_slice::<super::Record>(raw).map_err(|_| "storage-corrupt")?;
    Ok(Bundle {
        bundle: 1,
        session: Some(text(raw)?),
        grants: BTreeMap::new(),
    })
}
fn text(raw: &[u8]) -> Result<String, &'static str> {
    String::from_utf8(raw.to_vec()).map_err(|_| "storage-corrupt")
}

// Session and grant transactions share one item. Serialize them within this
// process, so only another Buzz instance can find the account lock busy.
static TRANSACTIONS: Mutex<()> = Mutex::new(());

// Releasing the transaction must not wait for inherited/duplicated handles.
// This matches the existing credential-store account lock's explicit unlock.
// The file unlocks before the process guard (field 1) is released.
struct Transaction(
    std::fs::File,
    #[allow(dead_code)] std::sync::MutexGuard<'static, ()>,
);
impl Drop for Transaction {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

#[cfg(not(test))]
fn error(error: buzz_credential_store::Error) -> &'static str {
    use buzz_credential_store::Error;
    match error {
        Error::Denied => "storage-denied",
        Error::Corrupt => "storage-corrupt",
        Error::Busy => "storage-busy",
        Error::Changed | Error::Occupied => "session-changed",
        _ => "storage-unavailable",
    }
}

/// The OS secure items under `SERVICE`.
#[cfg(not(test))]
mod items {
    use super::{error, SERVICE};
    use std::path::Path;
    use zeroize::Zeroizing;
    pub(super) fn read(
        _: &Path,
        account: &str,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str> {
        match buzz_credential_store::read_session(SERVICE, account) {
            Ok(value) => Ok(Some(value)),
            Err(buzz_credential_store::Error::Absent) => Ok(None),
            Err(value) => Err(error(value)),
        }
    }
    pub(super) fn helper_selected(_: &Path) -> bool {
        cfg!(all(target_os = "macos", debug_assertions))
            && std::env::var_os("BUZZ_DEV_CREDENTIAL_HELPER").is_some()
    }
    pub(super) fn compare(
        _: &Path,
        account: &str,
        expected: Option<&[u8]>,
        replacement: Option<&[u8]>,
    ) -> Result<(), &'static str> {
        buzz_credential_store::compare_session(SERVICE, account, expected, replacement)
            .map_err(error)
    }
    pub(super) fn delete(_: &Path, account: &str) -> Result<(), &'static str> {
        match buzz_credential_store::delete_session(SERVICE, account) {
            Ok(()) | Err(buzz_credential_store::Error::Absent) => Ok(()),
            Err(value) => Err(error(value)),
        }
    }
}

/// Test builds never touch OS credentials: items live in memory for roots a
/// test opts in with `enable`, and every other root is unavailable.
#[cfg(test)]
pub(crate) mod items {
    use std::{collections::HashMap, path::Path, path::PathBuf, sync::Mutex};
    use zeroize::Zeroizing;
    type Items = HashMap<PathBuf, HashMap<String, Vec<u8>>>;
    static ITEMS: Mutex<Option<Items>> = Mutex::new(None);
    static UNCERTAIN: Mutex<Option<PathBuf>> = Mutex::new(None);
    static HELPER_ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);
    pub(crate) fn uncertain_write(root: &Path) {
        *HELPER_ROOT.lock().unwrap() = Some(root.into());
        *UNCERTAIN.lock().unwrap() = Some(root.into());
    }
    pub(super) fn helper_selected(root: &Path) -> bool {
        HELPER_ROOT.lock().unwrap().as_deref() == Some(root)
    }
    pub(crate) fn enable(root: &Path) {
        ITEMS
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .entry(root.into())
            .or_default();
    }
    pub(crate) fn with<T>(
        root: &Path,
        run: impl FnOnce(&mut HashMap<String, Vec<u8>>) -> T,
    ) -> Result<T, &'static str> {
        let mut items = ITEMS.lock().unwrap();
        let items = items.as_mut().and_then(|all| all.get_mut(root));
        items.map(run).ok_or("storage-unavailable")
    }
    pub(crate) fn read(
        root: &Path,
        account: &str,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str> {
        with(root, |items| {
            items.get(account).cloned().map(Zeroizing::new)
        })
    }
    pub(crate) fn compare(
        root: &Path,
        account: &str,
        expected: Option<&[u8]>,
        replacement: Option<&[u8]>,
    ) -> Result<(), &'static str> {
        with(root, |items| {
            if items.get(account).map(Vec::as_slice) != expected {
                return Err("session-changed");
            }
            match replacement {
                Some(value) => items.insert(account.into(), value.to_vec()),
                None => items.remove(account),
            };
            Ok(())
        })??;
        let mut uncertain = UNCERTAIN.lock().unwrap();
        if uncertain.as_deref() == Some(root) {
            uncertain.take();
            return Err("storage-unavailable");
        }
        Ok(())
    }
    pub(crate) fn delete(root: &Path, account: &str) -> Result<(), &'static str> {
        with(root, |items| {
            items.remove(account);
        })
    }
}

impl SecureStore {
    fn marker(&self, revision: &str) -> Result<PathBuf, &'static str> {
        let revision = uuid::Uuid::parse_str(revision).map_err(|_| "storage-corrupt")?;
        Ok(self
            .root
            .join(format!("{}.{revision}.refused", self.account)))
    }
    fn index(&self) -> PathBuf {
        self.root.join(format!("{}.record", self.account))
    }
    /// Every cooperating FI reader/writer holds this account lock across both
    /// the secure-record operation and its nonsensitive refusal marker.
    fn lock(&self) -> Result<Transaction, &'static str> {
        let process = TRANSACTIONS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        fs::create_dir_all(&self.root).map_err(|_| "storage-unavailable")?;
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join(format!("{}.lock", self.account)))
            .map_err(|_| "storage-unavailable")?;
        // std reports contention as WouldBlock on every OS, including
        // Windows' lock violation, as the credential-store lock relies on.
        file.try_lock().map_err(|error| match error {
            fs::TryLockError::WouldBlock => "storage-busy",
            fs::TryLockError::Error(_) => "storage-unavailable",
        })?;
        Ok(Transaction(file, process))
    }
    fn refused(&self, revision: &str) -> Result<Option<String>, &'static str> {
        match fs::read_to_string(self.marker(revision)?) {
            Ok(contents) if contents == revision => Ok(Some(contents)),
            Ok(_) => Err("storage-corrupt"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("storage-unavailable"),
        }
    }
    fn refuse(&self, revision: &str) -> Result<(), &'static str> {
        fs::create_dir_all(&self.root).map_err(|_| "storage-unavailable")?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(self.marker(revision)?)
            .map_err(|_| "storage-unavailable")?;
        use std::io::Write;
        file.write_all(revision.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "storage-unavailable")
    }
    fn clear_refusal(&self, revision: &str) -> Result<(), &'static str> {
        match fs::remove_file(self.marker(revision)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("storage-unavailable"),
        }
    }
    /// The item as read, and the bundle it holds.
    fn bundle(&self) -> Result<(Item, Bundle), &'static str> {
        let raw = items::read(&self.root, &self.account)?;
        let bundle = match raw.as_deref() {
            Some(raw) => decode(raw)?,
            None => Bundle::default(),
        };
        Ok((raw, bundle))
    }
    /// Replaces the item read as `current` with `bundle`, deleting it once
    /// empty, and returns what it wrote. Session replacements through a helper
    /// remain refused until their write succeeds.
    fn save(&self, current: Option<&[u8]>, bundle: &mut Bundle) -> Result<Item, &'static str> {
        // Register before writing any secret. Buzz identity deletion walks these
        // public account keys even after configuration or profile changes.
        fs::create_dir_all(&self.root).map_err(|_| "storage-unavailable")?;
        fs::write(self.index(), b"1").map_err(|_| "storage-unavailable")?;
        bundle.bundle = 1;
        let next = if bundle.session.is_none() && bundle.grants.is_empty() {
            None
        } else if !self.bundled {
            // Never drop grants another platform's bundle may hold.
            if !bundle.grants.is_empty() {
                return Err("storage-corrupt");
            }
            bundle
                .session
                .as_ref()
                .map(|session| Zeroizing::new(session.as_bytes().to_vec()))
        } else {
            let next = serde_json::to_vec(&*bundle).map_err(|_| "storage-corrupt")?;
            Some(Zeroizing::new(next))
        };
        if next.as_ref().is_some_and(|next| next.len() > MAX_BUNDLE) {
            return Err("storage-unavailable");
        }
        items::compare(
            &self.root,
            &self.account,
            current,
            next.as_deref().map(Vec::as_slice),
        )?;
        Ok(next)
    }
    /// Compare-and-swap the session slot, keeping every grant.
    fn swap(
        &self,
        expected: Option<&[u8]>,
        replacement: Option<&[u8]>,
    ) -> Result<(), &'static str> {
        let (raw, mut bundle) = self.bundle()?;
        if bundle.session.as_deref().map(str::as_bytes) != expected {
            return Err("session-changed");
        }
        let guarded = match replacement {
            Some(value) if items::helper_selected(&self.root) => {
                let record: super::Record =
                    serde_json::from_slice(value).map_err(|_| "storage-corrupt")?;
                if self.refused(&record.revision)?.is_none() {
                    self.refuse(&record.revision)?;
                    Some(record.revision.clone())
                } else {
                    None
                }
            }
            _ => None,
        };
        bundle.session.zeroize();
        bundle.session = replacement.map(text).transpose()?;
        self.save(raw.as_deref().map(Vec::as_slice), &mut bundle)?;
        if let Some(revision) = guarded {
            self.clear_refusal(&revision)?;
        }
        Ok(())
    }
    /// The store for `key`'s own item, as before bundles.
    fn item(&self, key: &str) -> Self {
        Self {
            account: key.into(),
            root: self.root.clone(),
            bundled: false,
        }
    }
    /// The grant (or retirement) record at `key`. Only absence from a
    /// successfully loaded bundle moves the pre-bundle item at `key` into it,
    /// and that item is deleted once the bundle holding it is written and
    /// read back.
    pub(crate) fn grant(&self, key: &str) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str> {
        if !self.bundled {
            let _transaction = self.item(key).lock()?;
            return items::read(&self.root, key);
        }
        let _transaction = self.lock()?;
        let (raw, mut bundle) = self.bundle()?;
        if let Some(value) = bundle.grants.get(key) {
            return Ok(Some(Zeroizing::new(value.as_bytes().to_vec())));
        }
        let Some(value) = items::read(&self.root, key)? else {
            return Ok(None);
        };
        bundle.grants.insert(key.into(), text(&value)?);
        let written = self.save(raw.as_deref().map(Vec::as_slice), &mut bundle)?;
        if items::read(&self.root, &self.account)?.as_deref() != written.as_deref() {
            return Err("storage-corrupt");
        }
        self.retire_item(key);
        Ok(Some(value))
    }
    /// Replaces or, with `None`, deletes the grant record at `key`. A deletion
    /// removes the pre-bundle item first, so a failure never lets a later read
    /// move it back; a write saves the bundle first, which reads then prefer.
    pub(crate) fn set_grant(&self, key: &str, value: Option<&[u8]>) -> Result<(), &'static str> {
        if !self.bundled {
            let item = self.item(key);
            let _transaction = item.lock()?;
            let Some(value) = value else {
                return self.forget_item(key);
            };
            // Registered before the write, so a full Buzz sign-out erases it.
            fs::write(item.index(), b"1").map_err(|_| "storage-unavailable")?;
            let current = items::read(&self.root, key)?;
            return items::compare(
                &self.root,
                key,
                current.as_deref().map(Vec::as_slice),
                Some(value),
            );
        }
        let _transaction = self.lock()?;
        let (raw, mut bundle) = self.bundle()?;
        let raw = raw.as_deref().map(Vec::as_slice);
        match value {
            Some(value) => {
                if let Some(mut old) = bundle.grants.insert(key.into(), text(value)?) {
                    old.zeroize();
                }
                self.save(raw, &mut bundle)?;
                self.retire_item(key);
                Ok(())
            }
            None => {
                self.forget_item(key)?;
                match bundle.grants.remove(key) {
                    Some(mut old) => {
                        old.zeroize();
                        self.save(raw, &mut bundle).map(drop)
                    }
                    None => Ok(()),
                }
            }
        }
    }
    /// Cleans up the pre-bundle item at `key` once the bundle holds its
    /// record. The commit stands: a failed cleanup keeps the item and its
    /// index, which the bundle's copy overrides, for the next write or delete
    /// of `key`, or the boot erase owner, to retry.
    fn retire_item(&self, key: &str) {
        let _ = self.forget_item(key);
    }
    /// Deletes the pre-bundle item at `key`, then its index entry. A failed
    /// deletion keeps the entry for the boot erase owner.
    fn forget_item(&self, key: &str) -> Result<(), &'static str> {
        items::delete(&self.root, key)?;
        match fs::remove_file(self.root.join(format!("{key}.record"))) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("storage-unavailable"),
        }
    }
}

impl Store for SecureStore {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str> {
        let (_, bundle) = self.bundle()?;
        Ok(bundle
            .session
            .as_ref()
            .map(|session| Zeroizing::new(session.as_bytes().to_vec())))
    }
    fn compare(
        &self,
        expected: Option<&[u8]>,
        replacement: Option<&[u8]>,
    ) -> Result<(), &'static str> {
        let _transaction = self.lock()?;
        self.swap(expected, replacement)
    }
    fn load(&self) -> Result<LoadedRecord, &'static str> {
        let _transaction = self.lock()?;
        let raw = self.read()?;
        let refusal = match raw.as_ref() {
            Some(raw) if raw.len() <= 64 * 1024 => {
                let record: super::Record =
                    serde_json::from_slice(raw).map_err(|_| "storage-corrupt")?;
                self.refused(&record.revision)?
            }
            Some(_) => return Err("storage-corrupt"),
            None => None,
        };
        Ok((raw, refusal))
    }
    fn remove(&self, expected: &[u8], revision: &str) -> Result<(), &'static str> {
        // Refusal must also survive contention with another Buzz instance.
        // Revision-scoped files cannot overwrite a newer record's refusal.
        self.refuse(revision)?;
        let _transaction = self.lock()?;
        self.swap(Some(expected), None)?;
        self.clear_refusal(revision)
    }
}

/// Key of one agent's grant inside the owner's bundle, and of its item from
/// before bundles: same profile and deployment scoping, its own key.
pub(crate) fn agent_grant_key(account: &str, owner: &str, agent: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}",
        Sha256::digest(format!("agent-grant\0{account}\0{owner}\0{agent}"))
    )
}

pub(crate) fn root() -> Result<PathBuf, &'static str> {
    dirs::data_dir()
        .map(|path| path.join(format!(".{SERVICE}")))
        .ok_or("storage-unavailable")
}

/// Called before the existing boot owner deletes the human key or opens a WebView.
pub(crate) fn remove_all(root: PathBuf) -> Result<(), String> {
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Federated session removal could not access storage".into()),
    };
    for entry in entries {
        let entry = entry.map_err(|_| "Federated session removal failed")?;
        let path = entry.path();
        let extension = path.extension().and_then(|value| value.to_str());
        // Builderlab customers' servers, listed so each launch adds them
        // (`Customers`): with their sessions and grants gone, so is the list.
        if extension == Some("customers") {
            match fs::remove_file(&path) {
                Ok(()) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err("Federated session removal failed".into()),
            }
        }
        if extension != Some("record") {
            continue;
        }
        let account = path.file_stem().and_then(|value| value.to_str());
        let Some(account) = account else { continue };
        if account.len() != 64 || !account.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let store = SecureStore {
            account: account.to_owned(),
            root: root.clone(),
            bundled: BUNDLED,
        };
        let _transaction = store.lock()?;
        // The boot owner's durable pending sign-out fences all app activity.
        // Wiping an indexed slot needs neither its schema nor read permission.
        items::delete(&root, account)?;
        fs::remove_file(path).map_err(|_| "Federated session index removal failed")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The account lock as another Buzz instance holds it.
    fn elsewhere(store: &SecureStore) -> fs::File {
        fs::create_dir_all(&store.root).unwrap();
        let path = store.root.join(format!("{}.lock", store.account));
        let file = fs::File::create(path).unwrap();
        file.try_lock().unwrap();
        file
    }
    fn secure(root: &tempfile::TempDir) -> SecureStore {
        items::enable(root.path());
        SecureStore {
            account: "ab".repeat(32),
            root: root.path().into(),
            bundled: true,
        }
    }
    fn item(store: &SecureStore, account: &str) -> Option<Vec<u8>> {
        items::read(&store.root, account)
            .unwrap()
            .map(|raw| raw.to_vec())
    }

    #[test]
    fn identity_wipe_ignores_stray_indices_and_retains_failed_deletions() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("stray.record"), b"unrelated").unwrap();
        assert!(remove_all(root.path().into()).is_ok());
        let account = "ab".repeat(32);
        let index = root.path().join(format!("{account}.record"));
        fs::write(&index, b"1").unwrap();
        let store = SecureStore {
            account,
            root: root.path().into(),
            bundled: true,
        };
        let held = elsewhere(&store);
        assert_eq!(remove_all(root.path().into()), Err("storage-busy".into()));
        assert!(index.exists());
        drop(held);
        // This root denies secure-store access. A failed delete must leave
        // its index for the boot owner's pending sign-out retry.
        assert_eq!(
            remove_all(root.path().into()),
            Err("storage-unavailable".into())
        );
        assert!(index.exists());
    }

    #[test]
    fn one_item_holds_the_session_and_every_grant_and_the_wipe_erases_it() {
        let root = tempfile::tempdir().unwrap();
        let store = secure(&root);
        let session = super::super::tests::record();
        store.compare(None, Some(&session.raw)).unwrap();
        let (first, second) = (
            agent_grant_key(&store.account, "owner", "one"),
            agent_grant_key(&store.account, "owner", "two"),
        );
        store.set_grant(&first, Some(b"grant one")).unwrap();
        store.set_grant(&second, Some(b"retiring")).unwrap();
        assert_eq!(items::with(root.path(), |all| all.len()), Ok(1));
        assert_eq!(store.read().unwrap().unwrap().as_slice(), &session.raw[..]);
        assert_eq!(
            store.grant(&first).unwrap().unwrap().as_slice(),
            b"grant one"
        );

        // Each update compares the whole item: a stale session is refused and
        // changes nothing, and the session's removal keeps every grant.
        let stale = super::super::tests::record();
        assert_eq!(
            store.compare(Some(&stale.raw), None),
            Err("session-changed")
        );
        store
            .remove(&session.raw, &session.record.revision)
            .unwrap();
        assert!(store.refused(&session.record.revision).unwrap().is_none());
        assert!(store.read().unwrap().is_none());
        assert_eq!(
            store.grant(&second).unwrap().unwrap().as_slice(),
            b"retiring"
        );
        // The item goes once its last record does.
        store.set_grant(&first, None).unwrap();
        store.set_grant(&first, None).unwrap();
        assert!(item(&store, &store.account).is_some());
        store.set_grant(&second, None).unwrap();
        assert!(item(&store, &store.account).is_none());

        store.set_grant(&first, Some(b"grant one")).unwrap();
        assert!(store.index().exists());
        remove_all(root.path().into()).unwrap();
        assert!(item(&store, &store.account).is_none());
        assert!(!store.index().exists());
    }

    #[test]
    fn uncertain_helper_save_keeps_the_replacement_refused() {
        let root = tempfile::tempdir().unwrap();
        let store = secure(&root);
        let previous = super::super::tests::record();
        let replacement = super::super::tests::record();
        store.compare(None, Some(&previous.raw)).unwrap();
        items::uncertain_write(root.path());
        assert_eq!(
            store.compare(Some(&previous.raw), Some(&replacement.raw)),
            Err("storage-unavailable")
        );
        let (stored, refusal) = store.load().unwrap();
        assert_eq!(stored.unwrap().as_slice(), replacement.raw.as_slice());
        assert_eq!(
            refusal.as_deref(),
            Some(replacement.record.revision.as_str())
        );
        assert_eq!(
            store.remove(&previous.raw, &previous.record.revision),
            Err("session-changed")
        );
        assert!(store
            .refused(&replacement.record.revision)
            .unwrap()
            .is_some());
        let next = super::super::tests::record();
        store
            .compare(Some(&replacement.raw), Some(&next.raw))
            .unwrap();
        let (stored, refusal) = store.load().unwrap();
        assert_eq!(stored.unwrap().as_slice(), next.raw.as_slice());
        assert!(refusal.is_none());
    }

    #[test]
    fn a_session_item_from_before_bundles_is_read_and_replaced_in_place() {
        let root = tempfile::tempdir().unwrap();
        let store = secure(&root);
        let session = super::super::tests::record();
        items::compare(root.path(), &store.account, None, Some(&session.raw)).unwrap();
        let (raw, refusal) = store.load().unwrap();
        assert_eq!(raw.unwrap().as_slice(), &session.raw[..]);
        assert!(refusal.is_none());

        let key = agent_grant_key(&store.account, "owner", "agent");
        store.set_grant(&key, Some(b"grant")).unwrap();
        assert_eq!(store.read().unwrap().unwrap().as_slice(), &session.raw[..]);
        let renewed = super::super::tests::record();
        store
            .compare(Some(&session.raw), Some(&renewed.raw))
            .unwrap();
        assert_eq!(store.read().unwrap().unwrap().as_slice(), &renewed.raw[..]);
        assert_eq!(store.grant(&key).unwrap().unwrap().as_slice(), b"grant");

        // Anything else is corrupt, never an empty bundle to write over.
        items::compare(
            root.path(),
            &store.account,
            item(&store, &store.account).as_deref(),
            Some(b"{}"),
        )
        .unwrap();
        assert_eq!(store.read().err(), Some("storage-corrupt"));
        assert_eq!(
            store.set_grant(&key, Some(b"other")),
            Err("storage-corrupt")
        );
        assert_eq!(
            item(&store, &store.account).as_deref(),
            Some(b"{}".as_slice())
        );
    }

    #[test]
    fn grant_items_from_before_bundles_move_in_only_from_a_loaded_bundle() {
        let root = tempfile::tempdir().unwrap();
        let store = secure(&root);
        let (key, other) = (
            agent_grant_key(&store.account, "owner", "agent"),
            agent_grant_key(&store.account, "owner", "other"),
        );
        let index = |key: &str| root.path().join(format!("{key}.record"));
        for key in [&key, &other] {
            items::compare(root.path(), key, None, Some(b"old grant")).unwrap();
            fs::write(index(key), b"1").unwrap();
        }

        // An unreadable bundle never takes or loses the old item.
        items::compare(root.path(), &store.account, None, Some(b"corrupt")).unwrap();
        assert_eq!(store.grant(&key).err(), Some("storage-corrupt"));
        assert!(item(&store, &key).is_some() && index(&key).exists());
        items::delete(root.path(), &store.account).unwrap();

        // Moved in, then the old item and its index go.
        assert_eq!(store.grant(&key).unwrap().unwrap().as_slice(), b"old grant");
        assert!(item(&store, &key).is_none() && !index(&key).exists());
        assert_eq!(store.grant(&key).unwrap().unwrap().as_slice(), b"old grant");
        // The bundle's copy wins over an old item that reappears.
        items::compare(root.path(), &key, None, Some(b"stale")).unwrap();
        assert_eq!(store.grant(&key).unwrap().unwrap().as_slice(), b"old grant");
        // A write or delete also retires the old item, so it cannot move back.
        store.set_grant(&key, Some(b"new grant")).unwrap();
        assert!(item(&store, &key).is_none());
        store.set_grant(&other, None).unwrap();
        assert!(item(&store, &other).is_none() && !index(&other).exists());
        assert!(store.grant(&other).unwrap().is_none());
        assert_eq!(store.grant(&key).unwrap().unwrap().as_slice(), b"new grant");
    }

    #[test]
    fn a_committed_grant_stands_when_cleaning_up_its_old_item_fails() {
        let root = tempfile::tempdir().unwrap();
        let store = secure(&root);
        let (written, migrated) = (
            agent_grant_key(&store.account, "owner", "written"),
            agent_grant_key(&store.account, "owner", "migrated"),
        );
        // A directory where the index file belongs makes its removal fail.
        for key in [&written, &migrated] {
            items::compare(root.path(), key, None, Some(b"old grant")).unwrap();
            fs::create_dir(root.path().join(format!("{key}.record"))).unwrap();
        }
        assert_eq!(store.set_grant(&written, Some(b"reservation")), Ok(()));
        assert_eq!(
            store.grant(&written).unwrap().unwrap().as_slice(),
            b"reservation"
        );
        assert_eq!(
            store.grant(&migrated).unwrap().unwrap().as_slice(),
            b"old grant"
        );
        // The index stays for a retry, which an explicit delete still reports.
        assert!(root.path().join(format!("{migrated}.record")).exists());
        assert_eq!(store.set_grant(&migrated, None), Err("storage-unavailable"));
        assert!(store.grant(&migrated).unwrap().is_some());
    }

    #[test]
    fn without_bundles_each_record_keeps_an_item_within_the_windows_limit() {
        let root = tempfile::tempdir().unwrap();
        let store = SecureStore {
            bundled: false,
            ..secure(&root)
        };
        let session = super::super::tests::record();
        store.compare(None, Some(&session.raw)).unwrap();
        let grant = [b'g'; 600];
        let keys: Vec<_> = (0..8)
            .map(|agent| agent_grant_key(&store.account, "owner", &agent.to_string()))
            .collect();
        for key in &keys {
            store.set_grant(key, Some(&grant)).unwrap();
            assert!(root.path().join(format!("{key}.record")).exists());
        }
        // A Windows credential holds 2,560 bytes of UTF-16: no item grows
        // with the number of agents, and the session item is the bare record.
        let sizes = items::with(root.path(), |all| {
            all.values().map(Vec::len).collect::<Vec<_>>()
        });
        let sizes = sizes.unwrap();
        assert_eq!(sizes.len(), 1 + keys.len());
        assert!(sizes.iter().all(|size| size * 2 <= 2560));
        assert_eq!(item(&store, &store.account).unwrap(), session.raw.to_vec());
        assert_eq!(
            store.grant(&keys[0]).unwrap().unwrap().as_slice(),
            &grant[..]
        );

        store
            .remove(&session.raw, &session.record.revision)
            .unwrap();
        assert!(item(&store, &store.account).is_none());
        store.set_grant(&keys[0], None).unwrap();
        assert!(!root.path().join(format!("{}.record", keys[0])).exists());
        assert!(store.grant(&keys[0]).unwrap().is_none());
        remove_all(root.path().into()).unwrap();
        assert_eq!(items::with(root.path(), |all| all.len()), Ok(0));
    }

    #[test]
    fn grant_and_session_transactions_in_one_process_queue_rather_than_fail() {
        let root = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(secure(&root));
        let keys: Vec<_> = (0..8)
            .map(|agent| agent_grant_key(&store.account, "owner", &agent.to_string()))
            .collect();
        std::thread::scope(|scope| {
            for key in &keys {
                let store = store.clone();
                scope.spawn(move || store.set_grant(key, Some(b"grant")).unwrap());
            }
        });
        for key in &keys {
            assert!(store.grant(key).unwrap().is_some());
        }
        // Another instance holding the lock is still reported, not waited on.
        let held = elsewhere(&store);
        assert_eq!(store.grant(&keys[0]).err(), Some("storage-busy"));
        drop(held);
    }

    #[test]
    fn a_stale_copys_removal_keeps_its_refusal_and_the_newer_session() {
        let root = tempfile::tempdir().unwrap();
        // Two Buzz copies on one item: B replaces the session A still holds.
        let (a, b) = (secure(&root), secure(&root));
        let (old, newer) = (super::super::tests::record(), super::super::tests::record());
        a.compare(None, Some(&old.raw)).unwrap();
        b.compare(Some(&old.raw), Some(&newer.raw)).unwrap();
        assert_eq!(
            a.remove(&old.raw, &old.record.revision),
            Err("session-changed")
        );
        assert_eq!(b.read().unwrap().unwrap().as_slice(), &newer.raw[..]);
        // A's old record stays refused if it is ever put back.
        assert!(a.refused(&old.record.revision).unwrap().is_some());
    }

    #[test]
    fn failed_removal_still_refuses_only_the_known_revision() {
        let root = tempfile::tempdir().unwrap();
        let store = SecureStore {
            account: "fixture".into(),
            root: root.path().into(),
            bundled: true,
        };
        let old = uuid::Uuid::new_v4().to_string();
        let newer = uuid::Uuid::new_v4().to_string();
        store.refuse(&newer).unwrap();
        let held = elsewhere(&store);
        assert_eq!(
            store.remove(b"known in-memory record", &old),
            Err("storage-busy")
        );
        assert_eq!(store.refused(&old).unwrap().as_deref(), Some(old.as_str()));
        assert_eq!(
            store.refused(&newer).unwrap().as_deref(),
            Some(newer.as_str())
        );
        drop(held);
        let inherited = {
            let transaction = store.lock().unwrap();
            transaction.0.try_clone().unwrap()
        };
        store.clear_refusal(&old).unwrap();
        // This root denies secure-store access instead of touching OS credentials.
        assert_eq!(
            store.remove(b"known in-memory record", &old),
            Err("storage-unavailable")
        );
        assert_eq!(store.refused(&old).unwrap().as_deref(), Some(old.as_str()));
        assert_eq!(
            store.refused(&newer).unwrap().as_deref(),
            Some(newer.as_str())
        );
        store.clear_refusal(&old).unwrap();
        assert!(store.refused(&old).unwrap().is_none());
        assert_eq!(
            store.refused(&newer).unwrap().as_deref(),
            Some(newer.as_str())
        );
        drop(inherited);
    }
}
