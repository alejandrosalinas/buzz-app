//! The advertisement a command-line tool discovers this app by:
//! `~/.buzz-foundation/credential-providers/<instance>.json`, `{instance,url}`.
//! It holds no secret; written atomically, removed on quit.
use std::path::{Path, PathBuf};

pub(crate) fn path(home: &Path, instance: &str) -> PathBuf {
    home.join(".buzz-foundation/credential-providers")
        .join(format!("{instance}.json"))
}

#[cfg(unix)]
pub(crate) fn write(home: &Path, instance: &str, url: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
    let file = path(home, instance);
    let dir = file.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    let temp = dir.join(format!(".{instance}.{}.tmp", std::process::id()));
    let body = serde_json::json!({ "instance": instance, "url": url }).to_string();
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)?;
    out.write_all(body.as_bytes())?;
    out.sync_all()?;
    std::fs::rename(&temp, &file)
}

pub(crate) fn remove(home: &Path, instance: &str) {
    let _ = std::fs::remove_file(path(home, instance));
}
