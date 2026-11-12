//! Credential primitives shared by human and agent identity owners.
//! Password encoding matches keyring's native Windows UTF-16 / Linux UTF-8 format.
//! Create-only writes, copies and deletes are serialized across cooperating app processes, not profiles.
//! Locks contain no secrets; missing/locked/broken secure storage never falls back.
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::path::Path;
#[cfg(any(target_os = "windows", target_os = "linux", test))]
use zeroize::Zeroize;
use zeroize::Zeroizing;

#[cfg(all(not(test), target_os = "macos", debug_assertions))]
mod dev_helper;

/// Debug-only: the selected local helper's answer for one item, or `None` when
/// no helper is configured. A helper failure never permits OS access.
#[cfg(all(not(test), target_os = "macos", debug_assertions))]
pub fn dev_item(
    operation: &str,
    service: &str,
    account: &str,
    value: &[u8],
) -> Option<Result<Zeroizing<Vec<u8>>>> {
    std::env::var_os("BUZZ_DEV_CREDENTIAL_HELPER")
        .map(|helper| dev_helper::item(&helper, operation, service, account, value))
}

pub const HUMAN_ACCOUNT: &str = "human";
pub const HUMAN_SERVICE: &str = human_service(cfg!(debug_assertions));
/// The human key's service before 1.0, which reads copy from.
pub const PREVIOUS_HUMAN_SERVICE: &str = human_store(cfg!(debug_assertions));
/// Names the files kept for the human key store: sign-out records and locks,
/// backups. It stays the service from before 1.0, so files older builds wrote
/// are still found.
pub const HUMAN_STORE: &str = human_store(cfg!(debug_assertions));

pub const fn human_service(debug: bool) -> &'static str {
    if debug {
        "xyz.block.buzz.desktop.identity.debug"
    } else {
        "xyz.block.buzz.desktop.identity"
    }
}

pub const fn human_store(debug: bool) -> &'static str {
    if debug {
        "dev.local.buzz.foundation.identity.debug"
    } else {
        "dev.local.buzz.foundation.identity"
    }
}

/// Sanitized outcomes. Only `Absent` permits creation of a new credential.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Absent,
    Occupied,
    Changed,
    Denied,
    Corrupt,
    /// Several Secret Service items match one service and account. Reads and
    /// deletes both refuse, and Buzz can't tell which item is the key.
    Ambiguous,
    Unavailable,
    Busy,
}
type Result<T> = std::result::Result<T, Error>;

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn error(value: keyring::Error) -> Error {
    match value {
        keyring::Error::NoEntry => Error::Absent,
        keyring::Error::NoStorageAccess(_) => Error::Denied,
        keyring::Error::BadEncoding(mut bytes) => {
            bytes.zeroize();
            Error::Corrupt
        }
        keyring::Error::Ambiguous(_) => Error::Ambiguous,
        _ => Error::Unavailable,
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
trait Backend {
    fn read(&self) -> Result<Zeroizing<Vec<u8>>>;
    fn write(&self, value: &str) -> Result<()>;
    fn delete(&self) -> Result<()>;
}

// Unit tests cannot accidentally call the real OS adapter.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
impl Backend for keyring::Entry {
    fn read(&self) -> Result<Zeroizing<Vec<u8>>> {
        self.get_password()
            .map(|value| Zeroizing::new(value.into_bytes()))
            .map_err(error)
    }
    fn write(&self, value: &str) -> Result<()> {
        self.set_password(value).map_err(error)
    }
    fn delete(&self) -> Result<()> {
        self.delete_credential().map_err(error)
    }
}

#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
fn entry(service: &str, account: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(service, account).map_err(error)
}

fn lock_root() -> Result<std::path::PathBuf> {
    // Resolve the OS account, not HOME/XDG overrides, profile, worktree or temp
    // paths: all processes writing the same per-user entry must share its lock.
    #[cfg(unix)]
    let home = nix::unistd::User::from_uid(nix::unistd::Uid::effective())
        .map_err(|_| Error::Unavailable)?
        .map(|user| user.dir);
    #[cfg(windows)]
    let home = dirs::home_dir(); // Windows Known Folder API, not environment.
    home.filter(|path| path.is_absolute())
        .map(|path| path.join(".buzz-foundation/credential-locks"))
        .ok_or(Error::Unavailable)
}

/// Read an exact service/account without consulting any other credential.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
pub fn read(service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>> {
    entry(service, account)?.read()
}

/// Add a credential only if a fresh read under its interprocess lock is absent.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
pub fn add(service: &str, account: &str, value: &[u8]) -> Result<()> {
    add_entry(
        &entry(service, account)?,
        &lock_root()?,
        service,
        account,
        value,
    )
}

/// Write a credential whether or not one is saved, under the same lock as
/// creates and deletes. For settings a person replaces, never for identities.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
pub fn replace(service: &str, account: &str, value: &[u8]) -> Result<()> {
    replace_entry(
        &entry(service, account)?,
        &lock_root()?,
        service,
        account,
        value,
    )
}

/// Delete only the exact credential, serialized with this app's creates/deletes.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
pub fn delete(service: &str, account: &str) -> Result<()> {
    delete_entry(&entry(service, account)?, &lock_root()?, service, account)
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn add_entry(
    entry: &impl Backend,
    root: &Path,
    service: &str,
    account: &str,
    value: &[u8],
) -> Result<()> {
    let value = std::str::from_utf8(value).map_err(|_| Error::Corrupt)?;
    let _lock = acquire(root, service, account)?;
    match entry.read() {
        Ok(_) => return Err(Error::Occupied),
        Err(Error::Absent) => {}
        Err(error) => return Err(error),
    }
    entry.write(value)
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn replace_entry(
    entry: &impl Backend,
    root: &Path,
    service: &str,
    account: &str,
    value: &[u8],
) -> Result<()> {
    let value = std::str::from_utf8(value).map_err(|_| Error::Corrupt)?;
    let _lock = acquire(root, service, account)?;
    entry.write(value)
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn delete_entry(entry: &impl Backend, root: &Path, service: &str, account: &str) -> Result<()> {
    let _lock = acquire(root, service, account)?;
    entry.delete()
}

struct Lock(File);

impl Drop for Lock {
    fn drop(&mut self) {
        // fork/dup can retain the open-file description after our descriptor
        // closes. Explicitly release ownership when the operation finishes.
        let _ = self.0.unlock();
    }
}

fn acquire(root: &Path, service: &str, account: &str) -> Result<Lock> {
    if !root.is_absolute() {
        return Err(Error::Unavailable);
    }
    fs::create_dir_all(root).map_err(|_| Error::Unavailable)?;
    let mut hash = Sha256::new();
    hash.update(service.as_bytes());
    hash.update([0]);
    hash.update(account.as_bytes());
    let path = root.join(format!("{:x}.lock", hash.finalize()));
    // The file is never read, written, truncated or removed; it contains no
    // secrets. These advisory locks coordinate this app, not hostile OS peers.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| Error::Unavailable)?;
    // Unlike a blocking lock, contention cannot strand an IPC worker behind a
    // second process's credential-consent dialog. Retry is explicitly user-driven.
    file.try_lock().map_err(|e| match e {
        std::fs::TryLockError::WouldBlock => Error::Busy,
        std::fs::TryLockError::Error(_) => Error::Unavailable,
    })?;
    Ok(Lock(file))
}

/// Read an item under its current service or, absent there, copy the one
/// saved under its service from before 1.0 to it (see [`copy`]), keeping the
/// old item for older builds. A key saved under the current service wins, even
/// if it differs: it may be newer. Every failure is returned, never absence.
pub fn read_or_copy<T, E>(
    current: impl Fn() -> std::result::Result<Option<T>, E>,
    copy: impl FnOnce() -> std::result::Result<(), E>,
) -> std::result::Result<Option<T>, E> {
    if let Some(value) = current()? {
        return Ok(Some(value));
    }
    let copied = copy();
    // Another copy of the app may have saved it first.
    match current()? {
        Some(value) => Ok(Some(value)),
        None => copied.map(|()| None),
    }
}

/// Copy the item saved under `previous` to `service`, create-only. It holds the
/// previous item's lock, which deleting that item takes too, so no delete falls
/// between the read and the write to have the copy bring a deleted key back. An
/// absent previous item, or a current one another copy saved first, leaves
/// nothing to do.
#[cfg(all(
    not(test),
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
pub fn copy(previous: &str, service: &str, account: &str) -> Result<()> {
    copy_with(
        &lock_root()?,
        previous,
        account,
        || read(previous, account),
        |value| add(service, account, value),
    )
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
fn copy_with(
    root: &Path,
    previous: &str,
    account: &str,
    read: impl FnOnce() -> Result<Zeroizing<Vec<u8>>>,
    add: impl FnOnce(&[u8]) -> Result<()>,
) -> Result<()> {
    let _lock = acquire(root, previous, account)?;
    match read() {
        Ok(value) => match add(&value) {
            Ok(()) | Err(Error::Occupied) => Ok(()),
            Err(error) => Err(error),
        },
        Err(Error::Absent) => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(not(test))]
fn optional(result: Result<Zeroizing<Vec<u8>>>) -> Result<Option<Zeroizing<Vec<u8>>>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(Error::Absent) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Whether this is a debug build `just desktop me` started, which signs in with
/// the release build's human key. Only that launcher sets the variable.
pub fn reads_release_human() -> bool {
    cfg!(debug_assertions)
        && std::env::var_os("BUZZ_DEV_RELEASE_KEY").as_deref() == Some(std::ffi::OsStr::new("1"))
}

/// The human identity the desktop app signs with. A `just desktop me` build reads
/// the release build's key, read-only: it never copies, replaces or deletes it,
/// and creates, imports and Sign out still use only its own item. With no release
/// key saved it falls back to its own.
#[cfg(not(test))]
pub fn read_human() -> Result<Zeroizing<Vec<u8>>> {
    release_or_own(
        reads_release_human(),
        |service| read(service, HUMAN_ACCOUNT),
        read_own_human,
    )
}

/// The release key, under its current service or the one from before 1.0, else
/// this build's own. Only absence falls through: a denied or broken read of the
/// release key never swaps in another key.
fn release_or_own(
    release: bool,
    read: impl Fn(&str) -> Result<Zeroizing<Vec<u8>>>,
    own: impl FnOnce() -> Result<Zeroizing<Vec<u8>>>,
) -> Result<Zeroizing<Vec<u8>>> {
    if release {
        for service in [human_service(false), human_store(false)] {
            match read(service) {
                Err(Error::Absent) => {}
                result => return result,
            }
        }
    }
    own()
}

/// Read only this build's own human identity; never create or select another
/// key. One saved before 1.0 is copied to the current service first.
#[cfg(not(test))]
pub fn read_own_human() -> Result<Zeroizing<Vec<u8>>> {
    read_or_copy(
        || optional(read(HUMAN_SERVICE, HUMAN_ACCOUNT)),
        || copy(PREVIOUS_HUMAN_SERVICE, HUMAN_SERVICE, HUMAN_ACCOUNT),
    )?
    .ok_or(Error::Absent)
}

/// Read the human identity without copying it: under the current service, else
/// the one from before 1.0. For tools other than the desktop app, since a
/// Keychain item trusts only the binary that created it.
#[cfg(not(test))]
pub fn find_human() -> Result<Zeroizing<Vec<u8>>> {
    match read(HUMAN_SERVICE, HUMAN_ACCOUNT) {
        Err(Error::Absent) => read(PREVIOUS_HUMAN_SERVICE, HUMAN_ACCOUNT),
        result => result,
    }
}

/// Read the human identity saved under its service from before 1.0.
#[cfg(not(test))]
pub fn read_previous_human() -> Result<Zeroizing<Vec<u8>>> {
    read(PREVIOUS_HUMAN_SERVICE, HUMAN_ACCOUNT)
}

/// Read an exact service/account from the default Keychain, which `add` writes.
#[cfg(all(not(test), target_os = "macos"))]
pub fn read(service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>> {
    #[cfg(debug_assertions)]
    if let Some(result) = dev_item("read", service, account, &[]) {
        return result;
    }
    use security_framework::os::macos::keychain::SecKeychain;
    SecKeychain::default()
        .map_err(mac_error)?
        .find_generic_password(service, account)
        .map(|(password, _)| Zeroizing::new(password.to_vec()))
        .map_err(mac_error)
}

/// Add a credential; Keychain refuses to replace a saved one.
#[cfg(all(not(test), target_os = "macos"))]
pub fn add(service: &str, account: &str, value: &[u8]) -> Result<()> {
    #[cfg(debug_assertions)]
    if let Some(result) = dev_item("add", service, account, value) {
        return result.map(|_| ());
    }
    use security_framework::os::macos::keychain::SecKeychain;
    SecKeychain::default()
        .map_err(mac_error)?
        .add_generic_password(service, account, value)
        .map_err(mac_error)
}

/// Write a credential whether or not one is saved, updating a saved item in
/// place so a failed write keeps it. For settings, never for identities.
#[cfg(all(not(test), target_os = "macos"))]
pub fn replace(service: &str, account: &str, value: &[u8]) -> Result<()> {
    use security_framework::os::macos::keychain::SecKeychain;
    let _lock = acquire(&lock_root()?, service, account)?;
    #[cfg(debug_assertions)]
    if let Some(result) = dev_item("replace", service, account, value) {
        return result.map(|_| ());
    }
    let keychain = SecKeychain::default().map_err(mac_error)?;
    match keychain.find_generic_password(service, account) {
        Ok((_, mut item)) => item.set_password(value).map_err(mac_error),
        Err(error) if mac_error(error) == Error::Absent => keychain
            .add_generic_password(service, account, value)
            .map_err(mac_error),
        Err(error) => Err(mac_error(error)),
    }
}

/// Delete only the exact credential, under the same lock as [`copy`], and
/// confirm it is gone: Keychain's delete reports no failure.
#[cfg(all(not(test), target_os = "macos"))]
pub fn delete(service: &str, account: &str) -> Result<()> {
    use security_framework::os::macos::keychain::SecKeychain;
    let _lock = acquire(&lock_root()?, service, account)?;
    #[cfg(debug_assertions)]
    if let Some(result) = dev_item("delete", service, account, &[]) {
        return result.map(|_| ());
    }
    let keychain = SecKeychain::default().map_err(mac_error)?;
    let (_, item) = keychain
        .find_generic_password(service, account)
        .map_err(mac_error)?;
    item.delete();
    match keychain.find_generic_password(service, account) {
        Ok(_) => Err(Error::Unavailable),
        Err(error) => match mac_error(error) {
            Error::Absent => Ok(()),
            error => Err(error),
        },
    }
}

#[cfg(all(not(test), target_os = "macos"))]
fn mac_error(error: security_framework::base::Error) -> Error {
    match error.code() {
        -25300 => Error::Absent,
        -25299 => Error::Occupied,
        -128 | -25293 | -25308 => Error::Denied,
        _ => Error::Unavailable,
    }
}

#[cfg(all(
    not(test),
    not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
))]
fn read(_: &str, _: &str) -> Result<Zeroizing<Vec<u8>>> {
    Err(Error::Unavailable)
}

#[cfg(all(
    not(test),
    not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
))]
fn copy(_: &str, _: &str, _: &str) -> Result<()> {
    Err(Error::Unavailable)
}

#[cfg(test)]
mod tests;

/// Session records have a distinct mutable owner. Human-key `add` remains create-only.
/// Erase an indexed session without reading its contents or knowing its schema.
#[cfg(not(test))]
pub fn delete_session(service: &str, account: &str) -> Result<()> {
    if !service.starts_with("xyz.block.buzz.desktop.federated-session") {
        return Err(Error::Denied);
    }
    let _lock = acquire(&lock_root()?, service, account)?;
    #[cfg(all(target_os = "macos", debug_assertions))]
    if let Some(result) = dev_item("delete", service, account, &[]) {
        return result.map(|_| ());
    }
    #[cfg(target_os = "macos")]
    return security_framework::passwords::delete_generic_password(service, account)
        .map_err(mac_error);
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    return entry(service, account)?.delete();
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Err(Error::Unavailable)
}

/// Session records have a distinct mutable owner. Human-key `add` remains create-only.
/// Compare the entire previously read record under the same interprocess lock.
#[cfg(not(test))]
pub fn compare_session(
    service: &str,
    account: &str,
    expected: Option<&[u8]>,
    replacement: Option<&[u8]>,
) -> Result<()> {
    if !service.starts_with("xyz.block.buzz.desktop.federated-session") {
        return Err(Error::Denied);
    }
    let _lock = acquire(&lock_root()?, service, account)?;
    let current = match read_session(service, account) {
        Ok(value) => Some(value),
        Err(Error::Absent) => None,
        Err(error) => return Err(error),
    };
    if current.as_deref().map(|v| v.as_slice()) != expected {
        return Err(Error::Changed);
    }
    let result = session_write(service, account, replacement);
    #[cfg(all(target_os = "macos", debug_assertions))]
    if result == Err(Error::Unavailable) && std::env::var_os("BUZZ_DEV_CREDENTIAL_HELPER").is_some()
    {
        let stored = match read_session(service, account) {
            Ok(value) => Some(value),
            Err(Error::Absent) => None,
            Err(_) => return result,
        };
        if stored.as_deref().map(|value| value.as_slice()) == replacement {
            return Ok(());
        }
    }
    result
}

#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
pub fn read_session(service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>> {
    read(service, account)
}

#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
fn session_write(service: &str, account: &str, value: Option<&[u8]>) -> Result<()> {
    let entry = entry(service, account)?;
    match value {
        Some(value) => entry.write(std::str::from_utf8(value).map_err(|_| Error::Corrupt)?),
        None => match entry.delete() {
            Err(Error::Absent) => Ok(()),
            result => result,
        },
    }
}

#[cfg(all(not(test), target_os = "macos"))]
pub fn read_session(service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>> {
    #[cfg(debug_assertions)]
    if let Some(result) = dev_item("read", service, account, &[]) {
        return result;
    }
    use security_framework::os::macos::keychain::SecKeychain;
    SecKeychain::default()
        .map_err(mac_error)?
        .find_generic_password(service, account)
        .map(|(password, _)| Zeroizing::new(password.to_vec()))
        .map_err(mac_error)
}

#[cfg(all(not(test), target_os = "macos"))]
fn session_write(service: &str, account: &str, value: Option<&[u8]>) -> Result<()> {
    #[cfg(debug_assertions)]
    if let Some(result) = dev_item(
        if value.is_some() { "replace" } else { "delete" },
        service,
        account,
        value.unwrap_or_default(),
    ) {
        return match result {
            Err(Error::Absent) if value.is_none() => Ok(()),
            result => result.map(|_| ()),
        };
    }
    use security_framework::os::macos::keychain::SecKeychain;
    let keychain = SecKeychain::default().map_err(mac_error)?;
    match (keychain.find_generic_password(service, account), value) {
        (Ok((_, mut item)), Some(value)) => item.set_password(value).map_err(mac_error),
        (Err(error), Some(value)) if mac_error(error) == Error::Absent => keychain
            .add_generic_password(service, account, value)
            .map(|_| ())
            .map_err(mac_error),
        (Ok((_, item)), None) => {
            item.delete();
            match read_session(service, account) {
                Err(Error::Absent) => Ok(()),
                Ok(_) => Err(Error::Unavailable),
                Err(error) => Err(error),
            }
        }
        (Err(error), None) if mac_error(error) == Error::Absent => Ok(()),
        (Err(error), _) => Err(mac_error(error)),
    }
}

#[cfg(all(
    not(test),
    not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
))]
pub fn read_session(_: &str, _: &str) -> Result<Zeroizing<Vec<u8>>> {
    Err(Error::Unavailable)
}
#[cfg(all(
    not(test),
    not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
))]
fn session_write(_: &str, _: &str, _: Option<&[u8]>) -> Result<()> {
    Err(Error::Unavailable)
}
