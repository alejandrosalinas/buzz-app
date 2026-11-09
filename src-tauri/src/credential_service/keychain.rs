//! Where paired-token records persist: one OS keychain item per app instance,
//! under the human key's service, so debug and release builds never share.
use zeroize::Zeroizing;

pub(crate) trait Keychain: Send + Sync {
    /// The saved records, or `None` when none are saved.
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String>;
    /// Replaces the saved records; `None` deletes them.
    fn write(&self, value: Option<&[u8]>) -> Result<(), String>;
    /// Whether a revoke-all is owed: set before the records are cleared and
    /// unset once they are, so a clear that fails is finished next launch.
    fn owed(&self) -> bool;
    fn set_owed(&self, owed: bool) -> Result<(), String>;
    /// This app's sole use of the records, held until the lease is dropped.
    /// Another running app over the same item is refused: it would admit and
    /// rewrite records from a stale read, bringing back a revoked pairing.
    fn lease(&self) -> Result<Lease, String>;
}

/// Held for as long as this app serves the records; see [`Keychain::lease`].
pub(crate) type Lease = Box<dyn Send + Sync>;
pub(crate) const LEASED: &str = "Another Buzz is serving paired tools; quit it, then retry";
/// The lease could not be taken or checked, so no other app is known to hold it.
pub(crate) const UNLEASED: &str = "Paired tools could not be checked";

/// The lease on the records an owed-clear marker at `marker` belongs to: an
/// exclusive lock on a file beside it, released when its process exits.
#[cfg_attr(test, allow(dead_code))]
fn lease_at(marker: &std::path::Path) -> Result<Lease, String> {
    if let Some(dir) = marker.parent() {
        std::fs::create_dir_all(dir).map_err(|_| UNLEASED.to_string())?;
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(marker.with_extension("lease"))
        .map_err(|_| UNLEASED.to_string())?;
    fs2::FileExt::try_lock_exclusive(&file).map_err(|e| {
        if e.kind() == fs2::lock_contended_error().kind() {
            LEASED
        } else {
            UNLEASED
        }
        .to_string()
    })?;
    Ok(Box::new(file))
}

/// The owed-clear marker, a file beside the app's data: kept apart from the
/// keychain so a keychain that refuses the clear can still record it.
#[cfg_attr(test, allow(dead_code))]
fn marker_owed(path: &std::path::Path) -> bool {
    // Unreadable counts as owed: a refusal is safe, a reused pairing is not.
    !matches!(std::fs::metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
}
#[cfg_attr(test, allow(dead_code))]
fn set_marker(path: &std::path::Path, owed: bool) -> Result<(), String> {
    let failed = |_| "Paired tools could not be revoked".to_string();
    if owed {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(failed)?;
        }
        std::fs::write(path, b"").map_err(failed)
    } else {
        match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(failed(e)),
            _ => Ok(()),
        }
    }
}

#[cfg_attr(test, allow(dead_code))]
pub(crate) fn account(instance: &str) -> String {
    format!("credential-pairings.v1.{instance}")
}

/// Saves `value`, or deletes on `None`. Saved records are updated in place,
/// never deleted first, so a failed write keeps them.
#[cfg_attr(test, allow(dead_code))]
fn save(
    value: Option<&[u8]>,
    replace: impl FnOnce(&[u8]) -> Result<(), buzz_credential_store::Error>,
    delete: impl FnOnce() -> Result<(), buzz_credential_store::Error>,
) -> Result<(), String> {
    let failed = |_| "Paired tools could not be saved to secure storage".to_string();
    match value {
        Some(value) => replace(value).map_err(failed),
        None => match delete() {
            Ok(()) | Err(buzz_credential_store::Error::Absent) => Ok(()),
            Err(error) => Err(failed(error)),
        },
    }
}

/// The keychain account, and the owed-clear marker's path.
#[cfg(not(test))]
pub(crate) struct Os(pub(crate) String, pub(crate) std::path::PathBuf);

#[cfg(all(
    not(test),
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
impl Keychain for Os {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        use buzz_credential_store as store;
        match store::read(store::HUMAN_SERVICE, &self.0) {
            Ok(value) => Ok(Some(value)),
            Err(store::Error::Absent) => Ok(None),
            Err(_) => Err("Paired tools could not be read from secure storage".into()),
        }
    }
    fn write(&self, value: Option<&[u8]>) -> Result<(), String> {
        use buzz_credential_store as store;
        save(
            value,
            |value| store::replace(store::HUMAN_SERVICE, &self.0, value),
            || store::delete(store::HUMAN_SERVICE, &self.0),
        )
    }
    fn owed(&self) -> bool {
        marker_owed(&self.1)
    }
    fn set_owed(&self, owed: bool) -> Result<(), String> {
        set_marker(&self.1, owed)
    }
    fn lease(&self) -> Result<Lease, String> {
        lease_at(&self.1)
    }
}

#[cfg(all(
    not(test),
    not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
))]
impl Keychain for Os {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        Err("Secure storage is not available on this platform".into())
    }
    fn write(&self, _: Option<&[u8]>) -> Result<(), String> {
        Err("Secure storage is not available on this platform".into())
    }
    fn owed(&self) -> bool {
        marker_owed(&self.1)
    }
    fn set_owed(&self, owed: bool) -> Result<(), String> {
        set_marker(&self.1, owed)
    }
    fn lease(&self) -> Result<Lease, String> {
        lease_at(&self.1)
    }
}

/// An in-memory keychain whose reads and writes can be made to fail, and
/// whose next write can be held at a gate.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct Memory {
    pub(crate) value: std::sync::Mutex<Option<Vec<u8>>>,
    pub(crate) owed: std::sync::atomic::AtomicBool,
    pub(crate) fail_read: std::sync::atomic::AtomicBool,
    pub(crate) fail_write: std::sync::atomic::AtomicBool,
    pub(crate) fail_owed: std::sync::atomic::AtomicBool,
    pub(crate) fail_lease: std::sync::atomic::AtomicBool,
    /// Whether a service holds its lease.
    pub(crate) leased: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Taken by the next write: it reports entering, then waits for release.
    pub(crate) gate: std::sync::Mutex<Option<Gate>>,
}
#[cfg(test)]
pub(crate) struct Gate {
    pub(crate) entered: std::sync::mpsc::Sender<()>,
    pub(crate) release: std::sync::mpsc::Receiver<()>,
}
#[cfg(test)]
impl Keychain for std::sync::Arc<Memory> {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        if self.fail_read.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("read failed".into());
        }
        Ok(self.value.lock().unwrap().clone().map(Zeroizing::new))
    }
    fn write(&self, value: Option<&[u8]>) -> Result<(), String> {
        let gate = self.gate.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.entered.send(()).unwrap();
            gate.release.recv().unwrap();
        }
        if self.fail_write.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("write failed".into());
        }
        *self.value.lock().unwrap() = value.map(<[u8]>::to_vec);
        Ok(())
    }
    fn owed(&self) -> bool {
        self.owed.load(std::sync::atomic::Ordering::SeqCst)
    }
    fn set_owed(&self, owed: bool) -> Result<(), String> {
        if self.fail_owed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("marker failed".into());
        }
        self.owed.store(owed, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
    fn lease(&self) -> Result<Lease, String> {
        use std::sync::atomic::Ordering::SeqCst;
        if self.fail_lease.load(SeqCst) {
            return Err(UNLEASED.into());
        }
        struct Held(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Held {
            fn drop(&mut self) {
                self.0.store(false, SeqCst);
            }
        }
        self.leased
            .compare_exchange(false, true, SeqCst, SeqCst)
            .map_err(|_| LEASED.to_string())?;
        Ok(Box::new(Held(self.leased.clone())))
    }
}

#[cfg(test)]
mod tests {
    use buzz_credential_store::Error;
    use std::cell::RefCell;

    /// A store whose update fails after the old item is found: the old
    /// records must survive, so nothing may delete them first.
    #[test]
    fn a_failed_update_keeps_the_saved_records() {
        let saved = RefCell::new(Some(b"old".to_vec()));
        let result = super::save(
            Some(b"new"),
            |_| Err(Error::Unavailable),
            || {
                *saved.borrow_mut() = None;
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(saved.borrow().as_deref(), Some(&b"old"[..]));
    }

    #[test]
    fn none_deletes_and_absent_is_fine() {
        assert!(super::save(None, |_| unreachable!(), || Err(Error::Absent)).is_ok());
        assert!(super::save(None, |_| unreachable!(), || Err(Error::Unavailable)).is_err());
    }

    /// The owed-clear marker, on disk: missing is not owed, present is, and
    /// setting it creates its directory.
    #[test]
    fn the_owed_marker_is_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("nested").join("pairings.owed");
        assert!(!super::marker_owed(&marker));
        super::set_marker(&marker, true).unwrap();
        assert!(super::marker_owed(&marker));
        super::set_marker(&marker, true).unwrap();
        super::set_marker(&marker, false).unwrap();
        assert!(!super::marker_owed(&marker));
        // Unsetting an absent marker is fine.
        super::set_marker(&marker, false).unwrap();
    }

    /// A marker that cannot be checked counts as owed.
    #[test]
    fn an_unreadable_marker_is_owed() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file");
        std::fs::write(&file, b"").unwrap();
        // A path under a regular file cannot be read as missing.
        assert!(super::marker_owed(&file.join("pairings.owed")));
    }

    /// The lease is a lock on a file beside the marker: a second taker is
    /// refused as leased until the first is dropped.
    #[test]
    fn the_lease_is_exclusive_until_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("nested").join("pairings.owed");
        let lease = super::lease_at(&marker).unwrap();
        assert!(marker.with_extension("lease").exists());
        assert_eq!(
            super::lease_at(&marker).err().as_deref(),
            Some(super::LEASED)
        );
        drop(lease);
        assert!(super::lease_at(&marker).is_ok());
    }
}
