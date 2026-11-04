//! Public backup consent. This module never exposes a secret or makes a network request.
use crate::{identity::IdentityHost, nsec_backup_config::Config};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, String>;
const FAILED: &str = "Could not read or save your identity backup choice.";
/// Another pass holds the consent lock or a key's record lock; the uploader
/// reports it as `busy`.
pub(crate) const BUSY: &str = "A backup is in progress. Wait for it to finish and try again.";

#[derive(Serialize)]
pub(crate) struct BackupChoice {
    pub(crate) available: bool,
    pub(crate) pubkey: String,
    pub(crate) automatic: Option<bool>,
    // Retain this value through an upload. A successful choice change cannot race it.
    #[serde(skip)]
    _lease: Option<Lease>,
}

/// A held advisory lock, released when dropped.
pub(crate) struct Lease(fs::File);
impl Drop for Lease {
    fn drop(&mut self) {
        // fork/dup can retain the open-file description after our descriptor
        // closes. Explicitly release ownership when the operation finishes.
        let _ = fs2::FileExt::unlock(&self.0);
    }
}
#[cfg(test)]
impl Lease {
    /// The descriptor a child spawned while this is held inherits until it execs.
    pub(crate) fn inherited(&self) -> fs::File {
        self.0.try_clone().unwrap()
    }
}

pub(crate) fn lease(file: fs::File, exclusive: bool) -> std::io::Result<Lease> {
    if exclusive {
        fs2::FileExt::try_lock_exclusive(&file)?;
    } else {
        fs2::FileExt::try_lock_shared(&file)?;
    }
    Ok(Lease(file))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    pubkey: String,
    service: String,
    namespace: String,
    automatic: bool,
}

/// The original native backup owner uses the same key-custody namespace.
pub(crate) fn root() -> Option<PathBuf> {
    #[cfg(unix)]
    let home = nix::unistd::User::from_uid(nix::unistd::Uid::effective())
        .ok()
        .flatten()
        .map(|user| user.dir);
    #[cfg(windows)]
    let home = dirs::home_dir();
    #[cfg(not(any(unix, windows)))]
    let home: Option<PathBuf> = None;
    home.filter(|path| path.is_absolute()).map(|path| {
        path.join(".buzz-foundation/nsec-backups")
            .join(buzz_credential_store::HUMAN_STORE)
    })
}

fn path() -> Result<PathBuf> {
    root()
        .map(|root| root.join("choice.json"))
        .ok_or_else(|| FAILED.into())
}

fn config() -> Result<Option<Config>> {
    crate::nsec_backup_config::configured(
        option_env!("BUZZ_NSEC_BACKUP_SERVICE_URL"),
        option_env!("BUZZ_NSEC_BACKUP_NAMESPACE"),
    )
}

fn lock(path: &Path, exclusive: bool) -> Result<Lease> {
    fs::create_dir_all(path.parent().ok_or(FAILED)?).map_err(|_| FAILED)?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("lock"))
        .map_err(|_| FAILED)?;
    lease(file, exclusive).map_err(|_| BUSY.into())
}

/// Only `Some(true)` authorizes backup. Keep the returned value alive until completion.
pub(crate) fn read(path: &Path, config: &Config, pubkey: &str) -> Result<BackupChoice> {
    let lease = lock(path, false)?;
    Ok(BackupChoice {
        available: true,
        pubkey: pubkey.into(),
        automatic: saved(path, config, pubkey)?,
        _lease: Some(lease),
    })
}

/// The choice saved for `pubkey`. The caller holds the choice lock.
fn saved(path: &Path, config: &Config, pubkey: &str) -> Result<Option<bool>> {
    let record: Option<Record> = match fs::File::open(path) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(4097)
                .read_to_end(&mut bytes)
                .map_err(|_| FAILED)?;
            if bytes.len() > 4096 {
                return Err(FAILED.into());
            }
            Some(serde_json::from_slice(&bytes).map_err(|_| FAILED)?)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(FAILED.into()),
    };
    // An opt-out holds for its key under every service, namespace and version,
    // so no build change turns backup on; an opt-in holds only where it was saved.
    Ok(record
        .filter(|record| {
            record.pubkey == pubkey
                && (!record.automatic
                    || record.version == 1
                        && record.service == config.service_url
                        && record.namespace == config.namespace)
        })
        .map(|record| record.automatic))
}

/// Consent's shared lease for a backup pass, or `None` when backup is not
/// authorized. A key with no saved choice waits too: the renderer fills it in.
/// A managed build ignores the saved choice, so even a malformed one cannot
/// stop backup.
pub(crate) fn admit(
    path: &Path,
    config: &Config,
    pubkey: &str,
    managed: bool,
) -> Result<Option<Lease>> {
    if managed {
        return lock(path, false).map(Some);
    }
    let choice = read(path, config, pubkey)?;
    Ok(choice._lease.filter(|_| choice.automatic == Some(true)))
}

/// Saves `automatic` for `pubkey`. With `unless_saved`, a choice already saved
/// for it stands and is returned instead. The check holds the write's
/// exclusive lock, so a choice another copy saves meanwhile is never replaced.
pub(crate) async fn set(
    identity: &IdentityHost,
    path: &Path,
    config: &Config,
    pubkey: &str,
    automatic: bool,
    managed: bool,
    unless_saved: bool,
) -> Result<BackupChoice> {
    if identity.viewer().await? != pubkey {
        return Err("This device’s identity changed. Read its backup choice again.".into());
    }
    let _lease = match lock(path, true) {
        Ok(lease) => lease,
        // A managed build's running pass backs up this key whatever is saved,
        // so turning automatic backup on while it holds the lease changes nothing.
        Err(error) if automatic && managed && error == BUSY => {
            return Ok(BackupChoice {
                available: true,
                pubkey: pubkey.into(),
                automatic: Some(true),
                _lease: None,
            });
        }
        // Only a pass with this exact consent holds the shared lease past its
        // read, so turning backup on again while it runs changes nothing, and
        // neither does keeping a saved choice. Any other choice reports busy
        // rather than dropping the consent.
        Err(error) if automatic && error == BUSY => {
            let current = read(path, config, pubkey)?;
            if current.automatic != Some(true) && !(unless_saved && current.automatic.is_some()) {
                return Err(error);
            }
            return Ok(BackupChoice {
                _lease: None,
                ..current
            });
        }
        Err(error) => return Err(error),
    };
    if unless_saved {
        if let Some(saved) = saved(path, config, pubkey)? {
            return Ok(BackupChoice {
                available: true,
                pubkey: pubkey.into(),
                automatic: Some(saved),
                _lease: None,
            });
        }
    }
    let record = Record {
        version: 1,
        pubkey: pubkey.into(),
        service: config.service_url.clone(),
        namespace: config.namespace.clone(),
        automatic,
    };
    let mut staged =
        tempfile::NamedTempFile::new_in(path.parent().ok_or(FAILED)?).map_err(|_| FAILED)?;
    staged
        .write_all(&serde_json::to_vec(&record).map_err(|_| FAILED)?)
        .map_err(|_| FAILED)?;
    staged.as_file().sync_all().map_err(|_| FAILED)?;
    staged.persist(path).map_err(|_| FAILED)?;
    #[cfg(unix)]
    fs::File::open(path.parent().ok_or(FAILED)?)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| FAILED)?;
    Ok(BackupChoice {
        available: true,
        pubkey: pubkey.into(),
        automatic: Some(automatic),
        _lease: None,
    })
}

#[tauri::command]
pub(crate) async fn nsec_backup_choice(
    identity: tauri::State<'_, IdentityHost>,
) -> Result<BackupChoice> {
    let pubkey = identity.viewer().await?;
    let Some(config) = config()? else {
        return Ok(BackupChoice {
            available: false,
            pubkey,
            automatic: None,
            _lease: None,
        });
    };
    read(&path()?, &config, &pubkey)
}

#[tauri::command]
pub(crate) async fn nsec_backup_set_choice(
    host: tauri::State<'_, crate::nsec_backup::NsecBackupHost>,
    identity: tauri::State<'_, IdentityHost>,
    pubkey: String,
    automatic: bool,
    unless_saved: Option<bool>,
) -> Result<BackupChoice> {
    host.set_choice(
        identity.inner().clone(),
        &pubkey,
        automatic,
        unless_saved == Some(true),
    )
    .await
}

#[cfg(test)]
mod tests;
