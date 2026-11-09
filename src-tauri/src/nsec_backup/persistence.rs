//! Encrypted retry bytes and public completion evidence, shared by cooperating desktop copies.
use super::{Config, Result};
use buzz_nsec_backup::Enrollment;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const FAILED: &str = "Backup retry state is unavailable";
const LIMIT: u64 = 16 * 1024;

pub(crate) use crate::nsec_backup_choice::root;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    version: u8,
    service: String,
    namespace: String,
    subject: String,
    owner: String,
    recipient_id: String,
    recipient_key: String,
    pubkey: String,
    pub(super) backup_id: String,
    pub(super) envelope: Option<String>,
}
impl Record {
    pub(super) fn new(config: &Config, subject: &str, enrollment: &Enrollment) -> Self {
        Self {
            version: 1,
            service: config.service_url.clone(),
            namespace: config.namespace.clone(),
            subject: subject.to_owned(),
            owner: enrollment.owner_id.clone(),
            recipient_id: enrollment.recipient_key_id.clone(),
            recipient_key: enrollment.recipient_public_key.clone(),
            pubkey: enrollment.nostr_pubkey.clone(),
            backup_id: enrollment.backup_id.clone(),
            envelope: None,
        }
    }
    pub(super) fn matches(
        &self,
        config: &Config,
        subject: &str,
        enrollment: &Enrollment,
    ) -> Result<bool> {
        self.matches_identity(config, subject, &enrollment.nostr_pubkey)?;
        if self.owner != enrollment.owner_id {
            return Err(FAILED.into());
        }
        if let Some(envelope) = self.envelope.as_ref() {
            if envelope.len() > 4096 {
                return Err(FAILED.into());
            }
            let value: serde_json::Value = serde_json::from_str(envelope).map_err(|_| FAILED)?;
            if value["backup_id"] != self.backup_id
                || value["nostr_pubkey"] != self.pubkey
                || value["owner_id"] != self.owner
                || value["recipient_key_id"] != self.recipient_id
                || value["service_namespace"] != self.namespace
            {
                return Err(FAILED.into());
            }
        }
        Ok(self.recipient_id == enrollment.recipient_key_id
            && self.recipient_key == enrollment.recipient_public_key)
    }
    pub(super) fn matches_identity(
        &self,
        config: &Config,
        subject: &str,
        pubkey: &str,
    ) -> Result<()> {
        if self.version != 1
            || self.service != config.service_url
            || self.namespace != config.namespace
            || self.subject != subject
            || self.pubkey != pubkey
            || uuid::Uuid::parse_str(&self.backup_id)
                .ok()
                .is_none_or(|id| id.to_string() != self.backup_id)
        {
            return Err(FAILED.into());
        }
        Ok(())
    }
}
pub(super) struct LockedRecord {
    _lock: crate::nsec_backup_choice::Lease,
    root: PathBuf,
    path: PathBuf,
}
impl LockedRecord {
    pub(super) fn open(root: &Path, config: &Config, subject: &str, pubkey: &str) -> Result<Self> {
        fs::create_dir_all(root).map_err(|_| FAILED)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(|_| FAILED)?;
        }
        let mut digest = Sha256::new();
        for field in [
            config.service_url.as_str(),
            config.namespace.as_str(),
            buzz_credential_store::HUMAN_STORE,
            subject,
            pubkey,
        ] {
            digest.update((field.len() as u64).to_be_bytes());
            digest.update(field.as_bytes());
        }
        let name = format!("{:x}", digest.finalize());
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join(format!("{name}.lock")))
            .map_err(|_| FAILED)?;
        Ok(Self {
            // The file opened, so a refused lock is another pass holding this key's record.
            _lock: crate::nsec_backup_choice::lease(lock, true)
                .map_err(|_| crate::nsec_backup_choice::BUSY)?,
            root: root.to_owned(),
            path: root.join(format!("{name}.json")),
        })
    }
    pub(super) fn read(&self) -> Result<Option<Record>> {
        self.read_bytes()?
            .map(|bytes| serde_json::from_slice(&bytes).map_err(|_| FAILED.into()))
            .transpose()
    }
    fn read_bytes(&self) -> Result<Option<Vec<u8>>> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(FAILED.into()),
        };
        let mut bytes = Vec::new();
        file.take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| FAILED)?;
        if bytes.len() as u64 > LIMIT {
            return Err(FAILED.into());
        }
        Ok(Some(bytes))
    }
    pub(super) fn write(&self, record: &Record) -> Result<()> {
        self.write_bytes(&serde_json::to_vec(record).map_err(|_| FAILED)?)
    }
    fn write_bytes(&self, bytes: &[u8]) -> Result<()> {
        if bytes.len() as u64 > LIMIT {
            return Err(FAILED.into());
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root).map_err(|_| FAILED)?;
        temporary.write_all(bytes).map_err(|_| FAILED)?;
        temporary.as_file().sync_all().map_err(|_| FAILED)?;
        temporary.persist(&self.path).map_err(|_| FAILED)?;
        #[cfg(unix)]
        File::open(&self.root)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| FAILED)?;
        Ok(())
    }
}

pub(super) fn remember_restored(
    root: &Path,
    config: &Config,
    subject: &str,
    pubkey: &str,
    backup_id: &str,
) -> Result<()> {
    let slot = LockedRecord::open(root, config, subject, pubkey)?;
    if let Some(existing) = slot.read()? {
        existing.matches_identity(config, subject, pubkey)?;
    }
    // Authenticated recovery proves this key is stored, even if an earlier upload is uncertain.
    let record = Record {
        version: 1,
        service: config.service_url.clone(),
        namespace: config.namespace.clone(),
        subject: subject.to_owned(),
        owner: String::new(),
        recipient_id: String::new(),
        recipient_key: String::new(),
        pubkey: pubkey.to_owned(),
        backup_id: backup_id.to_owned(),
        envelope: None,
    };
    slot.write(&record)
}

/// Whether any account's record on this device confirms a stored backup of
/// `pubkey` under the build's service and namespace: an upload the service
/// receipted, or a restore from it. Unreadable records count as no backup.
pub(super) fn confirmed(root: &Path, config: &Config, pubkey: &str) -> bool {
    let Ok(entries) = fs::read_dir(root) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        // Only regular files: never a link or a pipe that could block the read.
        entry.file_type().is_ok_and(|kind| kind.is_file())
            && path
                .extension()
                .is_some_and(|extension| extension == "json")
            && File::open(&path).is_ok_and(|file| {
                let mut bytes = Vec::new();
                file.take(LIMIT + 1).read_to_end(&mut bytes).is_ok()
                    && bytes.len() as u64 <= LIMIT
                    && serde_json::from_slice::<Record>(&bytes).is_ok_and(|record| {
                        record.envelope.is_none()
                            && record
                                .matches_identity(config, &record.subject, pubkey)
                                .is_ok()
                    })
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_released_record_lock_is_free_even_while_a_spawned_child_still_shares_it() {
        let root = tempfile::tempdir().unwrap();
        let config = Config {
            service_url: "https://backup.example".into(),
            namespace: "buzz-test".into(),
        };
        let open = || LockedRecord::open(root.path(), &config, "subject", "pubkey");
        let held = open().unwrap();
        let child = held._lock.inherited();
        // Another copy still holding the record is refused at once, as busy.
        assert_eq!(
            open().err().as_deref(),
            Some(crate::nsec_backup_choice::BUSY)
        );
        drop(held);
        assert!(open().is_ok());
        drop(child);
    }

    #[test]
    fn only_a_finished_record_for_the_key_confirms_its_backup_under_any_account() {
        let root = tempfile::tempdir().unwrap();
        let config = Config {
            service_url: "https://backup.example".into(),
            namespace: "buzz-test".into(),
        };
        assert!(!confirmed(root.path(), &config, "pubkey"));
        let backup_id = uuid::Uuid::new_v4().to_string();
        let record = |subject: &str, envelope: Option<&str>| Record {
            version: 1,
            service: config.service_url.clone(),
            namespace: config.namespace.clone(),
            subject: subject.into(),
            owner: String::new(),
            recipient_id: String::new(),
            recipient_key: String::new(),
            pubkey: "pubkey".into(),
            backup_id: backup_id.clone(),
            envelope: envelope.map(Into::into),
        };
        // An upload still pending is no backup yet.
        let pending = LockedRecord::open(root.path(), &config, "alex", "pubkey").unwrap();
        pending.write(&record("alex", Some("{}"))).unwrap();
        drop(pending);
        assert!(!confirmed(root.path(), &config, "pubkey"));
        // Another service's record says nothing about this build's.
        let elsewhere = Config {
            service_url: "https://other.example".into(),
            namespace: config.namespace.clone(),
        };
        assert!(!confirmed(root.path(), &elsewhere, "pubkey"));
        // A finished one confirms it, whichever account saved it.
        let done = LockedRecord::open(root.path(), &config, "sam", "pubkey").unwrap();
        done.write(&record("sam", None)).unwrap();
        drop(done);
        assert!(confirmed(root.path(), &config, "pubkey"));
        assert!(!confirmed(root.path(), &config, "another"));
        // A restore's record confirms it too; unreadable files never do.
        remember_restored(root.path(), &config, "kim", "restored", &backup_id).unwrap();
        fs::write(root.path().join("corrupt.json"), b"{").unwrap();
        fs::write(
            root.path().join("large.json"),
            vec![b' '; LIMIT as usize + 1],
        )
        .unwrap();
        assert!(confirmed(root.path(), &config, "restored"));
    }
}
