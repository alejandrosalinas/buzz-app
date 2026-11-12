//! Native IPC and filesystem contract; all roots are temporary app-data overrides.
use super::*;
use sha2::{Digest as _, Sha256};
use tauri::{
    test::{mock_builder, MockRuntime, INVOKE_KEY},
    Manager as _,
};

pub(crate) struct Fixture {
    pub(crate) temp: tempfile::TempDir,
    pub(crate) app: tauri::App<MockRuntime>,
    pub(crate) view: tauri::WebviewWindow<MockRuntime>,
    pub(crate) manager: buzzodz_plugins::Manager,
    pub(crate) revision: String,
}
impl Fixture {
    pub(crate) fn new(managed: bool, files: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let manager =
            buzzodz_plugins::Manager::open(Some(base.join("registry")), "test", false).unwrap();
        let source = base.join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        std::fs::write(source.join("manifest.json"), serde_json::to_vec(&serde_json::json!({
            "id":"example.bytes", "name":"Byte fixture", "apiVersion":1,
            "host":{"managedFiles":managed,"files":files,"networkOrigins":["https://example.test"],
                "processes":[{"id":"read","program":"cat"},{"id":"read-protected","program":"cat"}]}
        })).unwrap()).unwrap();
        buzzodz_plugins::sign_release(&source, &nostr::key::SecretKey::generate().to_secret_hex())
            .unwrap();
        let catalog = manager.install(&source).unwrap();
        let revision = catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.bytes")
            .unwrap()
            .revision
            .clone();
        manager.change("enable", "example.bytes").unwrap();
        let mut context = crate::app_context();
        context.config_mut().app.app_directories_override = Some(
            tauri::utils::config::AppDirectoriesOverride::Root(base.clone()),
        );
        let app = mock_builder()
            .manage(PluginManager(Ok(manager.clone())))
            .manage(crate::host_process::HostProcesses::default())
            .invoke_handler(crate::commands())
            .build(context)
            .unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        Self {
            temp,
            app,
            view,
            manager,
            revision,
        }
    }
    pub(crate) fn root(&self) -> PathBuf {
        self.app
            .path()
            .app_data_dir()
            .unwrap()
            .join("plugin-artifacts")
    }
    pub(crate) fn ipc(
        &self,
        command: &str,
        body: tauri::ipc::InvokeBody,
        headers: reqwest::header::HeaderMap,
    ) -> Result<tauri::ipc::InvokeResponseBody, String> {
        let (reply, result) = std::sync::mpsc::sync_channel(1);
        self.view.as_ref().clone().on_message(
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: self.view.url().unwrap(),
                body,
                headers,
                invoke_key: INVOKE_KEY.into(),
            },
            Box::new(move |_window, _command, response, _callback, _error| {
                let _ = reply.send(response);
            }),
        );
        match result
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("native fixture IPC watchdog")
        {
            tauri::ipc::InvokeResponse::Ok(body) => Ok(body),
            tauri::ipc::InvokeResponse::Err(error) => Err(error.0.to_string()),
        }
    }
    pub(crate) fn save(&self, bytes: &[u8], hash: &str) -> Result<serde_json::Value, String> {
        let headers = reqwest::header::HeaderMap::from_iter([
            (
                reqwest::header::HeaderName::from_static("x-buzz-plugin-id"),
                "example.bytes".parse().unwrap(),
            ),
            (
                reqwest::header::HeaderName::from_static("x-buzz-plugin-revision"),
                self.revision.parse().unwrap(),
            ),
            (
                reqwest::header::HeaderName::from_static("x-buzz-sha256"),
                hash.parse().unwrap(),
            ),
        ]);
        self.ipc(
            "plugin_host_save_bytes",
            tauri::ipc::InvokeBody::Raw(bytes.to_vec()),
            headers,
        )
        .map(|r| r.deserialize().unwrap())
    }
}
pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

// BYTE_WORK is process-wide, so fixtures that invoke an admitted command serialize.
static COMMANDS: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub(crate) fn commands() -> std::sync::MutexGuard<'static, ()> {
    COMMANDS.lock().unwrap()
}

#[test]
fn raw_save_is_private_readable_and_not_implicitly_deduplicated() {
    let _serial = commands();
    let f = Fixture::new(true, true);
    let bytes = [0, 159, 255, 1];
    let hash = digest(&bytes);
    let before = wall_ms().unwrap();
    let saved = f.save(&bytes, &hash).unwrap();
    let path = saved["path"].as_str().unwrap();
    assert_eq!(saved["sha256"], hash);
    assert_eq!(saved["size"], 4);
    assert!(saved["expiresAt"].as_u64().unwrap() >= before + RETENTION_MS);
    assert_eq!(Path::new(path).parent().unwrap(), f.root());
    assert_eq!(
        artifact_expiry(Path::new(path).file_name().unwrap().to_str().unwrap()),
        saved["expiresAt"].as_u64()
    );
    let read = f
        .ipc(
            "plugin_host_read_file",
            tauri::ipc::InvokeBody::Json(serde_json::json!({
                "id":"example.bytes", "revision":f.revision, "path":path
            })),
            Default::default(),
        )
        .unwrap();
    match read {
        tauri::ipc::InvokeResponseBody::Raw(data) => assert_eq!(data, bytes),
        _ => panic!("expected raw read"),
    }
    let second = f.save(&bytes, &hash).unwrap();
    assert_ne!(saved["path"], second["path"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            std::fs::metadata(f.root()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    f.manager.change("disable", "example.bytes").unwrap();
    assert!(Path::new(path).exists()); // Disable is not erasure.
    assert!(f.save(&bytes, &hash).is_err());
}

#[test]
fn save_grant_does_not_grant_reading_and_fallback_never_creates_storage() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let saved = f.save(b"data", &digest(b"data")).unwrap();
    let error = f
        .ipc(
            "plugin_host_read_file",
            tauri::ipc::InvokeBody::Json(serde_json::json!({
                "id":"example.bytes", "revision":f.revision, "path":saved["path"]
            })),
            Default::default(),
        )
        .unwrap_err();
    assert!(error.contains("Files are not declared"));
    let f = Fixture::new(false, true);
    assert!(f
        .save(b"data", &digest(b"data"))
        .unwrap_err()
        .contains("not declared"));
    assert!(!f.root().exists());
    let f = Fixture::new(true, false);
    let error = f
        .ipc(
            "plugin_host_save_bytes",
            tauri::ipc::InvokeBody::Json(serde_json::json!([0, 159, 255])),
            Default::default(),
        )
        .unwrap_err();
    assert!(error.contains("raw bytes"));
    assert!(!f.root().exists());
    assert!(f
        .ipc(
            "plugin_host_save_bytes",
            tauri::ipc::InvokeBody::Raw(vec![1]),
            Default::default()
        )
        .unwrap_err()
        .contains("metadata"));
    assert!(!f.root().exists());
}

#[test]
fn invalid_input_hash_mismatch_and_deadline_leave_no_published_file() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let hash = digest(b"data");
    for (bytes, hash) in [
        (vec![], hash.clone()),
        (vec![0; MAX_SAVE_BYTES + 1], hash.clone()),
        (vec![1], "A".repeat(64)),
        (vec![1], "0".repeat(63)),
    ] {
        assert!(f.save(&bytes, &hash).unwrap_err().contains("Invalid"));
        assert!(!f.root().exists());
    }
    assert!(f
        .save(b"data", &"0".repeat(64))
        .unwrap_err()
        .contains("mismatch"));
    assert_eq!(std::fs::read_dir(f.root()).unwrap().count(), 1); // Only ownership lock.
    let result = save_managed(
        &f.root(),
        b"data",
        &hash,
        std::time::Instant::now(),
        &f.manager,
        "example.bytes",
        &f.revision,
    );
    assert!(result.err().unwrap().contains("expired"));
    assert_eq!(std::fs::read_dir(f.root()).unwrap().count(), 1);
    assert!(save_managed(
        &f.root(),
        b"data",
        &hash,
        std::time::Instant::now() + SAVE_WINDOW,
        &f.manager,
        "example.bytes",
        "stale"
    )
    .is_err());
}

#[test]
fn capacity_counts_unknown_zero_length_and_partial_files_without_eviction() {
    let f = Fixture::new(true, false);
    let _lock = managed_lock(&f.root()).unwrap();
    for i in 0..ROOT_FILES {
        std::fs::write(f.root().join(format!("unknown-{i}")), []).unwrap();
    }
    assert!(managed_capacity(&f.root(), 100, 1)
        .unwrap_err()
        .contains("full"));
    assert_eq!(std::fs::read_dir(f.root()).unwrap().count(), ROOT_FILES + 1);
    std::fs::write(f.root().join("overflow"), []).unwrap();
    assert!(managed_capacity(&f.root(), 100, 1)
        .unwrap_err()
        .contains("too many"));
    for entry in std::fs::read_dir(f.root()).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() != LOCK_NAME {
            std::fs::remove_file(entry.path()).unwrap();
        }
    }
    let partial = f.root().join("unknown-partial");
    let file = std::fs::File::create(&partial).unwrap();
    file.set_len(ROOT_BYTES).unwrap();
    assert!(managed_capacity(&f.root(), 100, 1)
        .unwrap_err()
        .contains("full"));
    assert_eq!(file.metadata().unwrap().len(), ROOT_BYTES);
    file.set_len(ROOT_BYTES - 1).unwrap();
    assert!(managed_capacity(&f.root(), 100, 1).is_ok());
}

#[test]
fn expiry_sweeps_only_strict_host_names_at_the_wall_clock_boundary() {
    let f = Fixture::new(true, false);
    let _lock = managed_lock(&f.root()).unwrap();
    let id = uuid::Uuid::new_v4();
    let expired = f.root().join(format!("100-{id}"));
    let retained = f.root().join(format!("101-{id}"));
    let unknown = f.root().join(format!("0100-{id}"));
    for path in [&expired, &retained, &unknown] {
        std::fs::write(path, [1]).unwrap();
    }
    managed_capacity(&f.root(), 99, 1).unwrap();
    assert!(expired.exists());
    managed_capacity(&f.root(), 100, 1).unwrap();
    assert!(!expired.exists());
    assert!(retained.exists());
    assert!(unknown.exists());
    managed_capacity(&f.root(), 101, 1).unwrap();
    assert!(!retained.exists());
    assert!(unknown.exists());
}

#[test]
fn ownership_lock_rejects_independent_open_and_exclusive_create_never_overwrites() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let lock = managed_lock(&f.root()).unwrap();
    assert!(managed_lock(&f.root()).err().unwrap().contains("busy"));
    let path = f.root().join("existing");
    std::fs::write(&path, b"original").unwrap();
    assert!(private_options().create_new(true).open(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"original");
    drop(lock);
    managed_lock(&f.root()).expect("released root gate must be immediately available");
}

#[cfg(unix)]
#[test]
fn links_public_root_and_unexpected_directories_fail_closed() {
    use std::os::unix::fs::{symlink, PermissionsExt as _};
    let f = Fixture::new(true, false);
    symlink(f.temp.path(), f.root()).unwrap();
    assert!(managed_lock(&f.root()).is_err());
    std::fs::remove_file(f.root()).unwrap();
    std::fs::create_dir(f.root()).unwrap();
    std::fs::set_permissions(f.root(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(managed_lock(&f.root()).is_err());
    std::fs::set_permissions(f.root(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let lock_path = f.root().join(LOCK_NAME);
    symlink(f.temp.path().join("absent"), &lock_path).unwrap();
    assert!(managed_lock(&f.root()).is_err());
    std::fs::remove_file(&lock_path).unwrap();
    let _lock = managed_lock(&f.root()).unwrap();
    let path = f.root().join("unexpected");
    std::fs::create_dir(&path).unwrap();
    assert!(managed_capacity(&f.root(), 100, 1).is_err());
    std::fs::remove_dir(&path).unwrap();
    symlink(f.temp.path(), &path).unwrap();
    assert!(managed_capacity(&f.root(), 100, 1).is_err());
}

#[test]
fn timed_out_managed_writer_holds_actual_byte_permit_and_root_lock_through_cleanup() {
    // Hold process-wide fixture serialization outside the async task until it completes.
    let _serial = commands();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let f = Fixture::new(true, false);
            let root = f.root();
            let held_root = root.clone();
            let place = BYTE_WORK.try_acquire().unwrap();
            let (started, ready) = tokio::sync::oneshot::channel();
            let (release, released) = std::sync::mpsc::channel();
            let writer = managed_writer(place, move || {
                let _lock = managed_lock(&held_root)?;
                let partial = held_root.join("partial");
                std::fs::write(&partial, b"partial").unwrap();
                started.send(()).unwrap();
                released
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                std::fs::remove_file(partial).unwrap();
                Ok(())
            });
            tokio::time::timeout(std::time::Duration::from_secs(5), ready)
                .await
                .unwrap()
                .unwrap();
            // Already elapsed async deadline; the very same production writer keeps ownership.
            let end = tokio::time::Instant::now();
            assert!(tokio::time::timeout_at(end, writer).await.is_err());
            assert!(BYTE_WORK.try_acquire().is_err());
            assert!(managed_lock(&root).err().unwrap().contains("busy"));
            assert!(root.join("partial").exists());
            release.send(()).unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    if let Ok(permit) = BYTE_WORK.try_acquire() {
                        drop(permit);
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(!root.join("partial").exists());
            assert!(managed_lock(&root).is_ok());
        });
}

#[cfg(unix)]
#[test]
fn expired_deletion_failure_stays_counted_and_never_evicts_unknown_files() {
    use std::os::unix::fs::PermissionsExt as _;
    let f = Fixture::new(true, false);
    let _lock = managed_lock(&f.root()).unwrap();
    for _ in 0..ROOT_FILES {
        std::fs::write(f.root().join(format!("100-{}", uuid::Uuid::new_v4())), [1]).unwrap();
    }
    std::fs::set_permissions(f.root(), std::fs::Permissions::from_mode(0o500)).unwrap();
    let result = managed_capacity(&f.root(), 100, 1);
    let count = std::fs::read_dir(f.root()).unwrap().count();
    std::fs::set_permissions(f.root(), std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.err().unwrap().contains("full"));
    assert_eq!(count, ROOT_FILES + 1);
}

#[test]
fn independent_process_cannot_enter_a_held_root_gate() {
    // A spawned child can inherit another fixture's flock until exec/exit.
    // Keep fork/exec outside other fixtures' immediate post-drop assertions.
    let _serial = commands();
    let f = Fixture::new(true, false);
    let lock = managed_lock(&f.root()).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "host_files::managed_tests::root_gate_child",
            "--nocapture",
        ])
        .env("BUZZ_TEST_MANAGED_ROOT", f.root())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("child root gate watchdog");
        }
        std::thread::yield_now();
    };
    assert!(status.success());
    drop(lock);
    assert!(managed_lock(&f.root()).is_ok());
}

#[test]
fn root_gate_child() {
    // Set only by the isolated parent fixture, never application configuration.
    if let Some(root) = std::env::var_os("BUZZ_TEST_MANAGED_ROOT") {
        assert!(managed_lock(Path::new(&root))
            .err()
            .unwrap()
            .contains("busy"));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SaveBoundary {
    BeforeWrite,
    PartialWrite,
    FileSync,
    #[cfg(unix)]
    DirectorySync,
    Revoke,
}

fn save_failure_at(boundary: SaveBoundary) {
    use std::io::Write as _;
    let _serial = commands();
    let f = Fixture::new(true, false);
    let root = f.root();
    drop(managed_lock(&root).unwrap());
    let retained = root.join(format!(
        "{}-{}",
        wall_ms().unwrap() + RETENTION_MS,
        uuid::Uuid::new_v4()
    ));
    let unknown = root.join("unknown-sentinel");
    for path in [&retained, &unknown] {
        std::fs::write(path, b"untouched").unwrap();
    }
    let bytes = b"actual-save-bytes";
    let manager = f.manager.clone();
    let revision = f.revision.clone();
    let writer_root = root.clone();
    let place = BYTE_WORK.try_acquire().unwrap();
    let (started, ready) = std::sync::mpsc::sync_channel(1);
    let (release, released) = std::sync::mpsc::sync_channel(1);
    // Release on assertion unwind as well; the writer also has its own watchdog.
    struct Release(Option<std::sync::mpsc::SyncSender<()>>);
    impl Drop for Release {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }
    let release = Release(Some(release));
    let writer = managed_writer(place, move || {
        let gate = || {
            started.send(()).unwrap();
            released
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
        };
        let failure = || std::io::Error::other(format!("injected {boundary:?}"));
        save_managed_with_io(
            ManagedSave {
                root: &writer_root,
                bytes,
                hash: &digest(bytes),
                deadline: std::time::Instant::now() + SAVE_WINDOW,
                manager: &manager,
                id: "example.bytes",
                revision: &revision,
            },
            |file, bytes| {
                if boundary == SaveBoundary::BeforeWrite {
                    gate();
                    return Err(failure());
                }
                if boundary == SaveBoundary::PartialWrite {
                    file.write_all(&bytes[..4])?;
                    gate();
                    return Err(failure());
                }
                file.write_all(bytes)?;
                if boundary == SaveBoundary::Revoke {
                    gate();
                }
                Ok(())
            },
            |file| {
                if boundary == SaveBoundary::FileSync {
                    gate();
                    return Err(failure());
                }
                file.sync_all()
            },
            |root| {
                #[cfg(unix)]
                {
                    if boundary == SaveBoundary::DirectorySync {
                        gate();
                        return Err(failure());
                    }
                    std::fs::File::open(root)?.sync_all()?;
                }
                #[cfg(not(unix))]
                let _ = root;
                Ok(())
            },
        )
    });
    ready
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("actual save boundary watchdog");
    let entries: Vec<_> = std::fs::read_dir(&root)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap() != LOCK_NAME && *p != retained && *p != unknown)
        .collect();
    assert_eq!(
        entries.len(),
        1,
        "exclusive actual save file exists at the held boundary"
    );
    let actual = std::fs::read(&entries[0]).unwrap();
    let expected = match boundary {
        SaveBoundary::BeforeWrite => &bytes[..0],
        SaveBoundary::PartialWrite => &bytes[..4],
        _ => &bytes[..],
    };
    assert_eq!(
        actual, expected,
        "inspect real file before operation failure/revocation"
    );
    assert!(BYTE_WORK.try_acquire().is_err());
    assert!(managed_lock(&root).err().unwrap().contains("busy"));
    if boundary == SaveBoundary::Revoke {
        f.manager.change("disable", "example.bytes").unwrap();
    }
    drop(release);
    let result = tauri::async_runtime::block_on(async {
        tokio::time::timeout(std::time::Duration::from_secs(5), writer).await
    })
    .expect("actual writer completion watchdog")
    .unwrap();
    let error = result
        .err()
        .expect("actual save must refuse SavedBytes/path metadata");
    if boundary == SaveBoundary::Revoke {
        assert!(error.contains("disabled or updated"), "{error}");
    } else {
        assert!(error.contains(&format!("injected {boundary:?}")), "{error}");
    }
    assert!(
        !entries[0].exists(),
        "common failure cleanup must remove the actual save file"
    );
    for path in [&retained, &unknown] {
        assert_eq!(std::fs::read(path).unwrap(), b"untouched");
    }
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 3);
    let _place = BYTE_WORK
        .try_acquire()
        .expect("actual writer released byte admission");
    let _lock = managed_lock(&root).expect("actual writer released filesystem ownership");
    managed_capacity(&root, wall_ms().unwrap(), bytes.len()).unwrap();
}

#[test]
fn actual_save_operation_failures_refuse_and_clean_up_under_writer_ownership() {
    for boundary in [
        SaveBoundary::BeforeWrite,
        SaveBoundary::PartialWrite,
        SaveBoundary::FileSync,
        #[cfg(unix)]
        SaveBoundary::DirectorySync,
    ] {
        save_failure_at(boundary);
    }
}

#[test]
fn actual_save_observes_disable_after_real_write_before_final_eligibility() {
    save_failure_at(SaveBoundary::Revoke);
}

#[test]
fn own_managed_delete_refuses_other_plugins_legacy_paths_and_active_reads() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let saved = f.save(b"owned", &digest(b"owned")).unwrap();
    let path = saved["path"].as_str().unwrap();
    let remove = |path: &str, id: &str| {
        f.ipc(
            "plugin_host_delete_managed_file",
            tauri::ipc::InvokeBody::Json(serde_json::json!({
                "id":id,"revision":f.revision,"path":path
            })),
            Default::default(),
        )
    };
    assert!(remove(path, "other.plugin").is_err());
    // A different enabled plugin with the same capability still has no ownership.
    let source = f.temp.path().join("other-source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
    std::fs::write(
        source.join("manifest.json"),
        serde_json::to_vec(&serde_json::json!({
            "id":"other.plugin","name":"Other","apiVersion":1,"host":{"managedFiles":true}
        }))
        .unwrap(),
    )
    .unwrap();
    buzzodz_plugins::sign_release(&source, &nostr::key::SecretKey::generate().to_secret_hex())
        .unwrap();
    let catalog = f.manager.install(&source).unwrap();
    let other = catalog
        .plugins
        .iter()
        .find(|p| p.manifest.id == "other.plugin")
        .unwrap();
    f.manager.change("enable", "other.plugin").unwrap();
    let error = f
        .ipc(
            "plugin_host_delete_managed_file",
            tauri::ipc::InvokeBody::Json(serde_json::json!({
                "id":"other.plugin","revision":other.revision,"path":path
            })),
            Default::default(),
        )
        .unwrap_err();
    assert!(error.contains("not owned"));
    assert!(delete_managed(&f.root(), path, &f.manager, "example.bytes", "stale").is_err());

    assert!(remove(
        f.temp.path().join("outside").to_str().unwrap(),
        "example.bytes"
    )
    .is_err());
    let legacy = f
        .root()
        .join(format!("9999999999999-{}", uuid::Uuid::new_v4()));
    std::fs::write(&legacy, b"legacy").unwrap();
    assert!(remove(legacy.to_str().unwrap(), "example.bytes").is_err());
    // This is the exact shared lease held by the native reader until its byte snapshot completes.
    let lease = FileReadLease::new().unwrap();
    assert!(remove(path, "example.bytes")
        .unwrap_err()
        .contains("in use"));
    assert_eq!(std::fs::read(path).unwrap(), b"owned");
    drop(lease);
    remove(path, "example.bytes").unwrap();
    assert!(!Path::new(path).exists());
    assert!(legacy.exists());
    assert!(remove(path, "example.bytes").is_err());
}

#[test]
fn byte_admission_is_fifo_bounded_and_expired_waiters_release_capacity() {
    let _serial = commands();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .unwrap()
        .block_on(async {
            use std::future::Future;
            use std::task::{Context, Poll, Waker};
            let held = BYTE_WORK.acquire().await.unwrap();
            let end = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
            let mut first = Box::pin(byte_admission(end));
            let mut second = Box::pin(byte_admission(end));
            let mut cx = Context::from_waker(Waker::noop());
            assert!(first.as_mut().poll(&mut cx).is_pending());
            assert!(second.as_mut().poll(&mut cx).is_pending());
            let mut rest = Vec::new();
            for _ in 2..16 {
                let mut waiter = Box::pin(byte_admission(end));
                assert!(waiter.as_mut().poll(&mut cx).is_pending());
                rest.push(waiter);
            }
            assert!(byte_admission(end).await.unwrap_err().contains("queue"));
            drop(held);
            // Polling the second first must not allow it to jump the FIFO queue.
            assert!(second.as_mut().poll(&mut cx).is_pending());
            let Poll::Ready(Ok(permit)) = first.as_mut().poll(&mut cx) else {
                panic!("first waiter not admitted")
            };
            assert!(second.as_mut().poll(&mut cx).is_pending());
            drop(permit);
            let permit = second.await.unwrap();
            tokio::time::advance(std::time::Duration::from_secs(1)).await;
            for waiter in rest {
                assert!(waiter.await.unwrap_err().contains("timed out"));
            }
            drop(permit);
            assert!(byte_admission(end).await.is_err());
            drop(
                byte_admission(tokio::time::Instant::now() + SAVE_WINDOW)
                    .await
                    .unwrap(),
            );
        });
}

#[test]
fn root_gate_unlocks_even_when_another_process_inherits_the_open_description() {
    let f = Fixture::new(true, false);
    let lock = managed_lock(&f.root()).unwrap();
    // try_clone models an inherited descriptor sharing the same flock description.
    let inherited = lock.try_clone().unwrap();
    drop(lock);
    let next =
        managed_lock(&f.root()).expect("guard drop must unlock before the inherited fd closes");
    drop(inherited);
    drop(next);
}

#[test]
fn concurrent_native_saves_queue_instead_of_refusing_the_second_plugin_operation() {
    let _serial = commands();
    let held = BYTE_WORK.try_acquire().unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let jobs: Vec<_> = [b"one", b"two"]
        .into_iter()
        .map(|bytes| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let f = Fixture::new(true, false);
                barrier.wait();
                let saved = f.save(bytes, &digest(bytes)).unwrap();
                assert_eq!(
                    std::fs::read(saved["path"].as_str().unwrap()).unwrap(),
                    bytes
                );
                saved
            })
        })
        .collect();
    barrier.wait();
    let watchdog = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while BYTE_WAITERS.available_permits() != 14 {
        assert!(
            std::time::Instant::now() < watchdog,
            "both commands must reach admission"
        );
        std::thread::yield_now();
    }
    drop(held);
    let saved: Vec<_> = jobs.into_iter().map(|job| job.join().unwrap()).collect();
    assert_ne!(saved[0]["path"], saved[1]["path"]);
}

#[cfg(unix)]
#[test]
fn process_attachment_reader_blocks_delete_until_output_and_killed_child_complete() {
    let _serial = commands();
    tauri::async_runtime::block_on(async {
        let f = Fixture::new(true, false);
        let saved = f
            .save(b"process-source", &digest(b"process-source"))
            .unwrap();
        let path = saved["path"].as_str().unwrap();
        let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                let _ = events.send(serde_json::from_str::<serde_json::Value>(&json).unwrap());
            }
            Ok(())
        });
        let handle = crate::host_process::plugin_host_process_spawn(
            f.app.handle().clone(),
            f.app.state(),
            f.app.state(),
            "example.bytes".into(),
            f.revision.clone(),
            "read".into(),
            Vec::new(),
            None,
            None,
            channel,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        // cat is held on stdin; its actual monitor owns the admitted reader lease.
        assert!(
            delete_managed(&f.root(), path, &f.manager, "example.bytes", &f.revision)
                .unwrap_err()
                .contains("in use")
        );
        crate::host_process::plugin_host_process_write(
            f.app.state(),
            "example.bytes".into(),
            handle,
            "ready\n".into(),
            false,
        )
        .await
        .unwrap();
        let event = received.recv().await.unwrap();
        assert_eq!(event["type"], "stdout");
        crate::host_process::plugin_host_process_kill(
            f.app.state(),
            "example.bytes".into(),
            handle,
        )
        .unwrap();
        // Kill is a request, not proof of actual completion. Until Exit the lease must not be dropped early.
        while let Some(event) = tokio::time::timeout(SAVE_WINDOW, received.recv())
            .await
            .unwrap()
        {
            if event["type"] == "exit" {
                break;
            }
        }
        delete_managed(&f.root(), path, &f.manager, "example.bytes", &f.revision).unwrap();
    });
}

#[test]
fn managed_deletes_queue_behind_a_held_save_and_each_other() {
    use std::io::Write as _;
    let _serial = commands();
    let f = Fixture::new(true, false);
    let paths: Vec<_> = [b"first", b"other"]
        .into_iter()
        .map(|bytes| {
            f.save(bytes, &digest(bytes)).unwrap()["path"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    let root = f.root();
    let manager = f.manager.clone();
    let revision = f.revision.clone();
    let place = BYTE_WORK.try_acquire().unwrap();
    let (started, ready) = std::sync::mpsc::sync_channel(1);
    let (release, released) = std::sync::mpsc::sync_channel(1);
    // Unwind also releases the held actual write, rather than stranding a worker.
    struct Release(Option<std::sync::mpsc::SyncSender<()>>);
    impl Drop for Release {
        fn drop(&mut self) {
            if let Some(tx) = self.0.take() {
                let _ = tx.send(());
            }
        }
    }
    let release = Release(Some(release));
    let writer = managed_writer(place, move || {
        save_managed_with_io(
            ManagedSave {
                root: &root,
                bytes: b"saving",
                hash: &digest(b"saving"),
                deadline: std::time::Instant::now() + SAVE_WINDOW,
                manager: &manager,
                id: "example.bytes",
                revision: &revision,
            },
            |file, bytes| {
                file.write_all(bytes)?;
                started.send(()).unwrap();
                released.recv_timeout(SAVE_WINDOW).unwrap();
                Ok(())
            },
            std::fs::File::sync_all,
            |_| Ok(()),
        )
    });
    ready.recv_timeout(SAVE_WINDOW).unwrap();
    let deletions: Vec<_> = paths
        .iter()
        .map(|path| {
            let view = f.view.clone();
            let body = serde_json::json!({"id":"example.bytes","revision":f.revision,"path":path});
            std::thread::spawn(move || {
                tauri::test::get_ipc_response(
                    &view,
                    tauri::webview::InvokeRequest {
                        cmd: "plugin_host_delete_managed_file".into(),
                        callback: tauri::ipc::CallbackFn(0),
                        error: tauri::ipc::CallbackFn(1),
                        url: view.url().unwrap(),
                        body: tauri::ipc::InvokeBody::Json(body),
                        headers: Default::default(),
                        invoke_key: INVOKE_KEY.into(),
                    },
                )
                .map_err(|e| e.to_string())
            })
        })
        .collect();
    let watchdog = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while BYTE_WAITERS.available_permits() != 14 {
        assert!(
            !deletions.iter().any(|job| job.is_finished()),
            "delete must queue, not refuse the held root"
        );
        assert!(
            std::time::Instant::now() < watchdog,
            "deletion admission watchdog"
        );
        std::thread::yield_now();
    }
    for path in &paths {
        assert!(Path::new(path).exists());
    }
    drop(release);
    tauri::async_runtime::block_on(writer).unwrap().unwrap();
    for job in deletions {
        job.join().unwrap().unwrap();
    }
    for path in paths {
        assert!(!Path::new(&path).exists());
    }
}

#[test]
fn queued_managed_delete_timeout_never_dispatches_or_reports_unknown_outcome() {
    let _serial = commands();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .unwrap()
        .block_on(async {
            let _held = BYTE_WORK.acquire().await.unwrap();
            let dispatched = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let seen = dispatched.clone();
            let error =
                delete_with_admission(tokio::time::Instant::now() + SAVE_WINDOW, move || {
                    seen.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                })
                .await
                .unwrap_err();
            assert!(error.contains("not deleted"), "{error}");
            assert!(!error.contains("unknown"), "{error}");
            assert!(!dispatched.load(std::sync::atomic::Ordering::SeqCst));
            assert_eq!(BYTE_WAITERS.available_permits(), 16);
        });
}
