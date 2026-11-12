//! Files a plugin that declares `host.files` reads, and directories it
//! resolves, with the user's own access, the same on every platform: no
//! program such as `base64` or `pwd` has to be on the computer for it.
use crate::host_process::{expand_home, under_home};
use crate::{with_manager, PluginManager};
use std::io::Read as _;
use std::path::{Path, PathBuf};

/// The largest file a plugin reads: the community's upload limit.
const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;
/// How long a read may take, as on a stalled network share, before its caller
/// is answered; the blocked read itself cannot be stopped.
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// Reads, and directory resolutions, under way at once, including ones stuck
/// past their timeout, so they cannot take every blocking thread the app has.
/// Each has its own places, so reads stuck on one share cannot keep Goose from
/// resolving the home it starts in.
static READS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(16);
static DIRECTORIES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

async fn granted(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
) -> Result<(), String> {
    let granted = with_manager(manager, move |manager| {
        Ok(manager.host_grants(&id, &revision)?.files)
    })
    .await?;
    if granted {
        Ok(())
    } else {
        Err("Files are not declared".into())
    }
}

/// Runs `work` on a blocking thread, holding one of `places` until it ends.
async fn bounded<T: Send + 'static>(
    places: &'static tokio::sync::Semaphore,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let place = places
        .try_acquire()
        .map_err(|_| "Too many file operations are under way; try again soon".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _place = place;
        work()
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Lists a folder with directory resolution's limit on blocking work, and
/// answers its caller with `late` after the read timeout.
pub(crate) async fn bounded_listing<T: Send + 'static>(
    late: &'static str,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::time::timeout(READ_TIMEOUT, bounded(&DIRECTORIES, work))
        .await
        .map_err(|_| late.to_string())?
}

/// `path`, absolute or `~/…` (`~\…` too on Windows), or else relative to
/// `cwd`, which is one of those.
fn locate(path: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
    if path.is_empty() || path.contains('\0') {
        return Err(format!("Cannot read {path}"));
    }
    if path == "~" || under_home(path).is_some() || Path::new(path).is_absolute() {
        return expand_home(path);
    }
    let cwd = cwd.ok_or_else(|| format!("Cannot read {path} without a directory"))?;
    let cwd = expand_home(cwd).map_err(|_| format!("Cannot read {path} from {cwd}"))?;
    Ok(cwd.join(path))
}

/// The bytes of the file at `path`, at most 50 MB.
fn read(path: &str, cwd: Option<&str>) -> Result<Vec<u8>, String> {
    let full = locate(path, cwd)?;
    let failed = |error: std::io::Error| match error.kind() {
        // Callers tell a missing file from a failed read by this wording.
        std::io::ErrorKind::NotFound => format!("{path}: No such file"),
        _ => format!("Could not read {path}: {error}"),
    };
    // Windows refuses to open a folder at all, with "Access is denied".
    if full.is_dir() {
        return Err(format!("{path} is not a file"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    // Opening a FIFO without a writer would block until one came; without
    // waiting, it opens and then fails the check below. A file reads alike.
    // Windows counts pipes and devices as files; the timeout bounds those.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NONBLOCK);
    let file = options.open(&full).map_err(failed)?;
    let metadata = file.metadata().map_err(failed)?;
    if !metadata.is_file() {
        return Err(format!("{path} is not a file"));
    }
    let too_large = || format!("{path} is larger than 50 MB");
    if metadata.len() > MAX_READ_BYTES {
        return Err(too_large());
    }
    let mut data = Vec::new();
    // One more byte than allowed tells a file that grew past it.
    file.take(MAX_READ_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(failed)?;
    if data.len() as u64 > MAX_READ_BYTES {
        return Err(too_large());
    }
    Ok(data)
}

/// `path`, absolute or `~/…`, as an absolute directory without symbolic
/// links, created if missing.
fn directory(path: &str) -> Result<String, String> {
    let full = expand_home(path)?;
    std::fs::create_dir_all(&full).map_err(|error| format!("Could not create {path}: {error}"))?;
    // `dunce` keeps Windows paths in their ordinary `C:\…` form, which agents
    // and the programs they run expect, rather than `\\?\C:\…`.
    let resolved = dunce::canonicalize(&full).map_err(|_| format!("Could not find {path}"))?;
    resolved
        .into_os_string()
        .into_string()
        .map_err(|_| format!("{path} is not a UTF-8 path"))
}

/// Reads a file for a plugin that declares `host.files`. `path` is absolute,
/// `~/…`, or relative to `cwd`, which is absolute or `~/…`.
#[tauri::command]
pub(crate) async fn plugin_host_read_file(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    path: String,
    cwd: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    // Reserve before any await; a delete racing an admitted attachment read refuses.
    let lease = FileReadLease::new()?;
    granted(manager, id, revision).await?;
    let late = format!("Reading {path} took too long");
    tokio::time::timeout(
        READ_TIMEOUT,
        bounded(&READS, move || {
            let _lease = lease;
            read(&path, cwd.as_deref())
        }),
    )
    .await
    .map_err(|_| late)?
    .map(tauri::ipc::Response::new)
}

/// Resolves a directory for a plugin that declares `host.files`, creating it
/// if missing, as a process's `cwd` is.
#[tauri::command]
pub(crate) async fn plugin_host_resolve_directory(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    path: String,
) -> Result<String, String> {
    granted(manager, id, revision).await?;
    bounded(&DIRECTORIES, move || directory(&path)).await
}

/// Lists the repositories folder for a plugin that declares `host.files`,
/// checking that grant before touching the filesystem. The app's renderer
/// supplies the folder its community and account configured; the plugin never
/// chooses `path`.
#[tauri::command]
pub(crate) async fn plugin_host_repository_folders<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    path: String,
) -> Result<Vec<crate::repositories_folder::RepositoryFolder>, String> {
    use tauri::Manager as _;
    granted(manager, id, revision).await?;
    let home = app.path().home_dir().ok();
    bounded_listing(crate::repositories_folder::LATE, move || {
        crate::repositories_folder::folders(&path, home.as_deref())
    })
    .await
}

// One admitted byte operation; waiting never clones a raw save body. Tokio's
// semaphore preserves FIFO order. At most 16 callers can wait, within their own deadline.
pub(crate) static BYTE_WORK: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
pub(crate) static BYTE_WAITERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(16);
pub(crate) async fn byte_admission(
    deadline: tokio::time::Instant,
) -> Result<tokio::sync::SemaphorePermit<'static>, String> {
    if tokio::time::Instant::now() >= deadline {
        return Err("Byte operation timed out in admission".into());
    }
    let _waiting = BYTE_WAITERS
        .try_acquire()
        .map_err(|_| "Byte operation queue is full")?;
    let permit = tokio::time::timeout_at(deadline, BYTE_WORK.acquire())
        .await
        .map_err(|_| "Byte operation timed out in admission")?
        .map_err(|_| "Byte admission unavailable")?;
    if tokio::time::Instant::now() >= deadline {
        return Err("Byte operation timed out in admission".into());
    }
    Ok(permit)
}

// App-wide, conservative deletion exclusion: any plugin's host.readFile call or
// process named read/read-protected blocks every plugin's managed deletion.
// Leases outlive async waiters until the actual blocking/process work completes.
static FILE_READS: std::sync::Mutex<usize> = std::sync::Mutex::new(0);
pub(crate) struct FileReadLease;
impl FileReadLease {
    pub(crate) fn new() -> Result<Self, String> {
        let mut reads = FILE_READS
            .lock()
            .map_err(|_| "File read admission unavailable")?;
        *reads = reads.checked_add(1).ok_or("Too many file reads")?;
        Ok(Self)
    }
}
impl Drop for FileReadLease {
    fn drop(&mut self) {
        if let Ok(mut reads) = FILE_READS.lock() {
            *reads -= 1;
        }
    }
}
const MAX_SAVE_BYTES: usize = 16 * 1024 * 1024;
const ROOT_BYTES: u64 = 64 * 1024 * 1024;
const ROOT_FILES: usize = 16;
const SAVE_WINDOW: std::time::Duration = std::time::Duration::from_secs(30);
const RETENTION_MS: u64 = 86_430_000; // 24 hours plus the save window.
const LOCK_NAME: &str = ".ownership";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedBytes {
    path: String,
    size: usize,
    sha256: String,
    expires_at: u64,
}

fn managed_granted(
    manager: &buzzodz_plugins::Manager,
    id: &str,
    revision: &str,
) -> Result<(), String> {
    if !manager.host_grants(id, revision)?.managed_files {
        return Err("Managed files are not declared".into());
    }
    Ok(())
}

fn save_header(
    request: &tauri::ipc::Request<'_>,
    name: &str,
    max: usize,
) -> Result<String, String> {
    let value = request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty() && s.len() <= max)
        .ok_or("Invalid managed save metadata")?;
    Ok(value.to_owned())
}

#[tauri::command]
pub(crate) async fn plugin_host_save_bytes<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    manager: tauri::State<'_, PluginManager>,
    request: tauri::ipc::Request<'_>,
) -> Result<SavedBytes, String> {
    use tauri::Manager as _;
    let deadline = std::time::Instant::now() + SAVE_WINDOW;
    // Refuse JSON fallback before any body clone or filesystem operation.
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("Managed save body must be raw bytes; outcome may be unknown".into());
    };
    let id = save_header(&request, "x-buzz-plugin-id", 256)?;
    let revision = save_header(&request, "x-buzz-plugin-revision", 128)?;
    let hash = save_header(&request, "x-buzz-sha256", 64)?;
    validate_save(body, &hash)?;
    let place = byte_admission(tokio::time::Instant::from_std(deadline)).await?;
    let manager = manager.0.clone()?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("plugin-artifacts");
    let bytes = body.clone();
    let writer = managed_writer(place, move || {
        save_managed(&root, &bytes, &hash, deadline, &manager, &id, &revision)
    });
    tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), writer)
        .await
        .map_err(|_| "Managed save timed out; outcome unknown")?
        .map_err(|e| e.to_string())?
}

/// The writer owns admission until actual completion, not merely until await ends.
fn managed_writer<T: Send + 'static>(
    place: tokio::sync::SemaphorePermit<'static>,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> tauri::async_runtime::JoinHandle<Result<T, String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let _place = place;
        work()
    })
}

fn validate_save(bytes: &[u8], hash: &str) -> Result<(), String> {
    if bytes.is_empty()
        || bytes.len() > MAX_SAVE_BYTES
        || hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid managed save bytes or SHA256".into());
    }
    Ok(())
}

fn wall_ms() -> Result<u64, String> {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    u64::try_from(ms).map_err(|_| "Invalid managed file clock".into())
}

fn private_metadata(path: &Path, directory: bool) -> Result<std::fs::Metadata, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink()
        || (if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        })
    {
        return Err("Managed storage must not contain links or unexpected file kinds".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || (!directory && metadata.nlink() != 1)
        {
            return Err("Managed storage is not private to this user".into());
        }
    }
    Ok(metadata)
}

fn private_options() -> std::fs::OpenOptions {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    options
}

// Explicit unlock matters when a concurrent fork temporarily inherits an open
// file description: close alone would leave flock held until that child execs.
struct ManagedLock(std::fs::File);
impl std::ops::Deref for ManagedLock {
    type Target = std::fs::File;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl Drop for ManagedLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

/// One verified fixed lock covers accounting through final eligibility/cleanup.
fn managed_lock(root: &Path) -> Result<ManagedLock, String> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    match builder.create(root) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.to_string()),
    }
    private_metadata(root, true)?;
    if dunce::canonicalize(root).map_err(|e| e.to_string())? != root {
        return Err("Managed storage path contains a link or alias".into());
    }
    let path = root.join(LOCK_NAME);
    let lock = match private_options().create_new(true).open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            private_metadata(&path, false)?;
            private_options().open(&path).map_err(|e| e.to_string())?
        }
        Err(e) => return Err(e.to_string()),
    };
    let metadata = private_metadata(&path, false)?;
    let opened = lock.metadata().map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if metadata.dev() != opened.dev() || metadata.ino() != opened.ino() {
            return Err("Managed storage ownership changed".into());
        }
    }
    if metadata.len() != 0 || !opened.is_file() {
        return Err("Invalid managed storage ownership file".into());
    }
    fs2::FileExt::try_lock_exclusive(&lock).map_err(|_| "Managed storage is busy")?;
    Ok(ManagedLock(lock))
}

fn artifact_expiry(name: &str) -> Option<u64> {
    let (expiry, id) = name.split_once('-')?;
    let expiry: u64 = expiry.parse().ok()?;
    let (id, owner) = if id.len() == 36 {
        (id, None)
    } else {
        let (id, owner) = id.split_at_checked(36)?;
        let owner = owner.strip_prefix('-')?;
        if owner.len() != 64
            || !owner
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return None;
        }
        (id, Some(owner))
    };
    let uuid = uuid::Uuid::parse_str(id).ok()?;
    let canonical = match owner {
        Some(owner) => format!("{expiry}-{uuid}-{owner}"),
        None => format!("{expiry}-{uuid}"),
    };
    (name == canonical).then_some(expiry)
}

fn managed_owner(id: &str) -> String {
    use sha2::{Digest as _, Sha256};
    format!("{:x}", Sha256::digest(id.as_bytes()))
}

/// Deletes only host-named files owned by this plugin; legacy unowned files refuse.
fn delete_managed(
    root: &Path,
    path: &str,
    manager: &buzzodz_plugins::Manager,
    id: &str,
    revision: &str,
) -> Result<(), String> {
    managed_granted(manager, id, revision)?;
    let path = Path::new(path);
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid managed file")?;
    if path.parent() != Some(root)
        || artifact_expiry(name).is_none()
        || !name.ends_with(&format!("-{}", managed_owner(id)))
    {
        return Err("Managed file is not owned by this plugin".into());
    }
    let _lock = managed_lock(root)?;
    let reads = FILE_READS
        .try_lock()
        .map_err(|_| "Managed file is in use by a file read")?;
    if *reads != 0 {
        return Err("Managed file is in use by a file read".into());
    }
    private_metadata(path, false)?;
    managed_granted(manager, id, revision)?;
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn plugin_host_delete_managed_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    path: String,
) -> Result<(), String> {
    use tauri::Manager as _;
    let deadline = tokio::time::Instant::now() + SAVE_WINDOW;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("plugin-artifacts");
    let manager = manager.0.clone()?;
    delete_with_admission(deadline, move || {
        delete_managed(&root, &path, &manager, &id, &revision)
    })
    .await
}

async fn delete_with_admission(
    deadline: tokio::time::Instant,
    work: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    // Same ordering as saves: byte permit, root lock, then nonblocking reader
    // exclusion. No filesystem work has started if admission refuses or expires.
    let place = byte_admission(deadline)
        .await
        .map_err(|error| format!("{error}; managed file not deleted"))?;
    let writer = managed_writer(place, work);
    // Once handed to the blocking pool, cancellation cannot prove no unlink.
    tokio::time::timeout_at(deadline, writer)
        .await
        .map_err(|_| "Managed deletion timed out; outcome unknown")?
        .map_err(|e| e.to_string())?
}

fn managed_capacity(root: &Path, now: u64, incoming: usize) -> Result<(), String> {
    let mut seen = 0;
    let (mut count, mut bytes) = (0, 0u64);
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() == LOCK_NAME {
            continue;
        }
        seen += 1;
        if seen > ROOT_FILES {
            return Err("Managed storage has too many entries".into());
        }
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("Managed storage contains an unexpected entry".into());
        }
        if entry
            .file_name()
            .to_str()
            .and_then(artifact_expiry)
            .is_some_and(|t| t <= now)
            && std::fs::remove_file(entry.path()).is_ok()
        {
            continue;
        }
        count += 1;
        bytes = bytes
            .checked_add(metadata.len())
            .ok_or("Managed storage accounting overflow")?;
    }
    if count >= ROOT_FILES
        || bytes
            .checked_add(incoming as u64)
            .is_none_or(|n| n > ROOT_BYTES)
    {
        return Err("Managed storage is full".into());
    }
    Ok(())
}

fn save_managed(
    root: &Path,
    bytes: &[u8],
    hash: &str,
    deadline: std::time::Instant,
    manager: &buzzodz_plugins::Manager,
    id: &str,
    revision: &str,
) -> Result<SavedBytes, String> {
    use std::io::Write as _;
    save_managed_with_io(
        ManagedSave {
            root,
            bytes,
            hash,
            deadline,
            manager,
            id,
            revision,
        },
        |file, bytes| file.write_all(bytes),
        std::fs::File::sync_all,
        |root| {
            #[cfg(unix)]
            std::fs::File::open(root)?.sync_all()?;
            #[cfg(not(unix))]
            let _ = root;
            Ok(())
        },
    )
}

struct ManagedSave<'a> {
    root: &'a Path,
    bytes: &'a [u8],
    hash: &'a str,
    deadline: std::time::Instant,
    manager: &'a buzzodz_plugins::Manager,
    id: &'a str,
    revision: &'a str,
}

// Keep OS operations private and local; admission, result and cleanup stay in one sequence.
fn save_managed_with_io(
    input: ManagedSave<'_>,
    write: impl FnOnce(&mut std::fs::File, &[u8]) -> std::io::Result<()>,
    sync_file: impl FnOnce(&std::fs::File) -> std::io::Result<()>,
    sync_directory: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<SavedBytes, String> {
    use sha2::{Digest as _, Sha256};
    let ManagedSave {
        root,
        bytes,
        hash,
        deadline,
        manager,
        id,
        revision,
    } = input;
    validate_save(bytes, hash)?;
    managed_granted(manager, id, revision)?;
    let _lock = managed_lock(root)?;
    let now = wall_ms()?;
    let expiry = now
        .checked_add(RETENTION_MS)
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or("Invalid managed file expiry")?;
    managed_capacity(root, now, bytes.len())?;
    let path = root.join(format!(
        "{expiry}-{}-{}",
        uuid::Uuid::new_v4(),
        managed_owner(id)
    ));
    let path_text = path
        .to_str()
        .ok_or("Managed file path is not UTF-8")?
        .to_owned();
    if std::time::Instant::now() >= deadline {
        return Err("Managed save expired".into());
    }
    // Exclusive final names: a collision is a refusal, never adoption/overwrite.
    let mut file = private_options()
        .create_new(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        write(&mut file, bytes).map_err(|e| e.to_string())?;
        if format!("{:x}", Sha256::digest(bytes)) != hash {
            return Err("Managed save SHA256 mismatch".into());
        }
        sync_file(&file).map_err(|e| e.to_string())?;
        sync_directory(root).map_err(|e| e.to_string())?;
        managed_granted(manager, id, revision)?;
        if std::time::Instant::now() >= deadline {
            return Err("Managed save expired".into());
        }
        Ok(SavedBytes {
            path: path_text,
            size: bytes.len(),
            sha256: hash.into(),
            expires_at: expiry,
        })
    })();
    drop(file);
    if result.is_err() {
        let _ = std::fs::remove_file(&path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_files_by_absolute_or_relative_path() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("-project")).unwrap();
        let file = root.path().join("-project").join("a.bin");
        std::fs::write(&file, [0, 159, 255]).unwrap();
        let cwd = root.path().to_str().unwrap();

        assert_eq!(read(file.to_str().unwrap(), None).unwrap(), [0, 159, 255]);
        // A name starting `-` is a path, never an option.
        assert_eq!(read("-project/a.bin", Some(cwd)).unwrap(), [0, 159, 255]);
        assert!(read("-project/missing", Some(cwd))
            .unwrap_err()
            .contains("No such file"));
        assert!(read("-project", Some(cwd))
            .unwrap_err()
            .contains("not a file"));
        #[cfg(unix)]
        {
            let fifo = root.path().join("fifo");
            let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            assert!(read("fifo", Some(cwd)).unwrap_err().contains("not a file"));
        }
        #[cfg(windows)]
        assert_eq!(
            locate(r"~\a.bin", None).unwrap(),
            expand_home("~").unwrap().join("a.bin")
        );
        assert!(read("a.bin", None).is_err());
        assert!(read("", Some(cwd)).is_err());
        assert!(read("a.bin", Some("relative")).is_err());
    }

    #[test]
    fn refuses_files_over_the_limit() {
        let root = tempfile::tempdir().unwrap();
        let file = std::fs::File::create(root.path().join("large")).unwrap();
        file.set_len(MAX_READ_BYTES + 1).unwrap();
        assert!(read("large", root.path().to_str())
            .unwrap_err()
            .contains("larger than 50 MB"));
    }

    #[test]
    fn resolves_and_creates_directories() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("new").join("workspace");
        let resolved = directory(path.to_str().unwrap()).unwrap();
        assert!(Path::new(&resolved).is_dir());
        assert!(Path::new(&resolved).is_absolute());
        assert_eq!(
            resolved,
            dunce::canonicalize(&path).unwrap().to_str().unwrap()
        );
        assert!(directory("relative").is_err());
    }

    #[test]
    fn repository_folders_check_the_file_grant_before_listing() {
        let list = |fixture: &managed_tests::Fixture, command: &str, body: serde_json::Value| {
            fixture
                .ipc(
                    command,
                    tauri::ipc::InvokeBody::Json(body),
                    Default::default(),
                )
                .map(|body| body.deserialize::<serde_json::Value>().unwrap())
        };
        let granted = managed_tests::Fixture::new(false, true);
        let root = dunce::canonicalize(granted.temp.path())
            .unwrap()
            .join("repos");
        std::fs::create_dir_all(root.join("checkout")).unwrap();
        let path = root.to_str().unwrap();
        let expected = serde_json::json!([{
            "name": "checkout",
            "path": root.join("checkout").to_str().unwrap(),
            "displayPath": root.join("checkout").to_str().unwrap(),
        }]);
        let plugin = |fixture: &managed_tests::Fixture, revision: &str, path: &str| {
            let body =
                serde_json::json!({ "id": "example.bytes", "revision": revision, "path": path });
            list(fixture, "plugin_host_repository_folders", body)
        };
        assert_eq!(plugin(&granted, &granted.revision, path).unwrap(), expected);
        assert!(plugin(&granted, "stale", path).is_err());
        assert_eq!(
            list(
                &granted,
                "repositories_folder_list",
                serde_json::json!({ "path": path })
            )
            .unwrap(),
            expected
        );
        // Refused before any filesystem work: a missing folder reports the grant.
        let ungranted = managed_tests::Fixture::new(false, false);
        let missing = root.join("absent");
        assert_eq!(
            plugin(&ungranted, &ungranted.revision, missing.to_str().unwrap()).unwrap_err(),
            "\"Files are not declared\""
        );
        assert_eq!(
            plugin(&ungranted, &ungranted.revision, path).unwrap_err(),
            "\"Files are not declared\""
        );
        assert!(
            plugin(&granted, &granted.revision, missing.to_str().unwrap())
                .unwrap_err()
                .contains("unavailable")
        );
    }
}

#[cfg(test)]
#[path = "host_files/managed_tests.rs"]
pub(crate) mod managed_tests;
