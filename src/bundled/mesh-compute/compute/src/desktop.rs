//! App-owned Mesh lifetime. Plugins cannot supply keystore paths or admission policy.

use tauri::Manager;

pub mod agent;
mod coordinator;
mod discovery;
pub mod host;
mod inference;
mod preferences;
mod publisher;
pub mod sharing;
pub mod widget;

/// Quit must finish even when the embedded node does not acknowledge Stop.
const SHUTDOWN_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

type Admission = (String, String, Vec<String>, Vec<nostr::event::Event>);

#[derive(Default)]
pub struct MeshHost {
    preparing: std::sync::Arc<inference::Fence>,
    inference: tokio::sync::Mutex<Option<inference::Gateway>>,
    sharing: std::sync::Mutex<Option<sharing::Share>>,
    preferences: std::sync::Mutex<preferences::Preferences>,
    lifecycle: std::sync::Arc<crate::lifecycle::Lifecycle>,
    lease: std::sync::Arc<crate::lease::Lease>,
    publisher: std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    coordinator: std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    admission: std::sync::Mutex<Option<Admission>>,
}

impl MeshHost {
    pub fn initialize_preferences(&self, path: Result<std::path::PathBuf, String>) {
        if let Ok(mut prefs) = self.preferences.lock() {
            prefs.initialize(path);
        }
    }
    /// Whether the embedded Mesh runtime (and its native libraries) ever started.
    pub fn runtime_started(&self) -> bool {
        self.lifecycle.launched()
    }

    pub fn shutdown(&self) {
        if let Ok(mut task) = self.coordinator.lock() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
        if let Ok(mut publisher) = self.publisher.lock() {
            if let Some(task) = publisher.take() {
                task.abort();
            }
        }
        self.lease.clear();
        // Same as block/buzz desktop: stop on a runtime task and cap the wait with an
        // OS timer. Blocking the AppKit thread on a Tokio timer hung Quit indefinitely.
        let lifecycle = std::sync::Arc::clone(&self.lifecycle);
        let (done, stopped) = std::sync::mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = done.send(lifecycle.stop_and_wait().await);
        });
        match stopped.recv_timeout(SHUTDOWN_WAIT) {
            Ok(Ok(())) => {}
            Ok(Err(error)) => eprintln!("Mesh shutdown could not be confirmed: {error}"),
            Err(_) => {
                self.lifecycle.stop();
                eprintln!("Mesh shutdown timed out; exiting without confirmation");
            }
        }
    }
}

#[tauri::command]
pub async fn mesh_compute_status(
    host: tauri::State<'_, MeshHost>,
) -> Result<serde_json::Value, String> {
    {
        let (saved, settings_error) = host
            .preferences
            .lock()
            .map(|prefs| (prefs.hint().cloned(), prefs.error().map(str::to_owned)))
            .unwrap_or_default();
        let runtime = if host.lifecycle.phase() == crate::lifecycle::Phase::Ready {
            host.lifecycle.status().await.ok()
        } else {
            None
        };
        let model_ready = runtime.as_ref().is_some_and(|status| {
            status
                .payload
                .get("llama_ready")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        });
        let activity = runtime
            .as_ref()
            .and_then(|status| crate::activity::snapshot(&status.payload));
        Ok(serde_json::json!({
            "modelReady": model_ready,
            "finishingJoin": host.lifecycle.finishing_join(),
            "boundCommunity": host.lease.current()?.map(|(_, community)| community),
            "activity": activity,
            "savedSharing": saved,
            "settingsError": settings_error,
            "lifecycle": host.lifecycle.phase(),
            "download": host.lifecycle.download_progress(),
            "reason": null,
            "sharing": host.sharing.lock().ok().and_then(|share| share.as_ref().map(|share| share.model.clone()))
        }))
    }
}

#[tauri::command]
pub async fn mesh_compute_stop(host: tauri::State<'_, MeshHost>) -> Result<(), String> {
    {
        stop_compute(&host).await
    }
}

async fn stop_compute(host: &MeshHost) -> Result<(), String> {
    let _guard = host.preparing.interrupt(None).await;
    {
        let mut sharing = host
            .sharing
            .lock()
            .map_err(|_| "Mesh sharing unavailable")?;
        *sharing = None;
    }
    host.lease.clear();
    *host
        .admission
        .lock()
        .map_err(|_| "Mesh admission unavailable")? = None;
    host.lifecycle.stop();
    host.lifecycle
        .stop_and_wait()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn mesh_compute_start(
    app: tauri::AppHandle,
    host: tauri::State<'_, MeshHost>,
    identity: tauri::State<'_, crate::desktop::host::Identity>,
    lease: String,
) -> Result<(), String> {
    start(&app, host.inner(), identity.inner(), &lease).await
}

async fn start(
    app: &tauri::AppHandle,
    host: &MeshHost,
    identity: &crate::desktop::host::Identity,
    lease: &str,
) -> Result<(), String> {
    use crate::startup_log;
    let began = std::time::Instant::now();
    let _guard = host.preparing.lock().await;
    startup_log::stage(
        "prepared",
        &format!("wait_ms={}", began.elapsed().as_millis()),
    );
    let result = start_prepared(app, host, identity, lease).await;
    startup_log::stage(
        "start_requested",
        &format!(
            "ok={} start_ms={}",
            result.is_ok(),
            began.elapsed().as_millis()
        ),
    );
    result
}

async fn start_prepared(
    app: &tauri::AppHandle,
    host: &MeshHost,
    identity: &crate::desktop::host::Identity,
    lease: &str,
) -> Result<(), String> {
    host.lease.community(lease)?;
    if matches!(
        host.lifecycle.phase(),
        crate::lifecycle::Phase::Starting | crate::lifecycle::Phase::Ready
    ) {
        return Ok(());
    }
    if host.lifecycle.phase() != crate::lifecycle::Phase::Stopped {
        return Err("Previous Mesh runtime shutdown is not confirmed".into());
    }
    let community = host.lease.community(lease)?;
    let discovery_began = std::time::Instant::now();
    let (owners, targets, evidence) = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        discovery::read(identity, &community),
    )
    .await
    .map_err(|_| {
        crate::startup_log::stage("discovery_read", "ok=false timeout");
        "Community discovery timed out"
    })??;
    crate::startup_log::stage(
        "discovery_read",
        &format!(
            "targets={} read_ms={}",
            targets.len(),
            discovery_began.elapsed().as_millis()
        ),
    );
    start_with_evidence(app, identity, lease, owners, targets, evidence, false).await
}

async fn start_with_evidence(
    app: &tauri::AppHandle,
    identity: &crate::desktop::host::Identity,
    lease: &str,
    mut owners: Vec<String>,
    targets: Vec<crate::discovery_types::MeshServeTarget>,
    evidence: Vec<nostr::event::Event>,
    recovering_admission: bool,
) -> Result<(), String> {
    let host = app.state::<MeshHost>();
    let community = host.lease.community(lease)?;
    let viewer = identity.viewer().await?;
    let sharing = host
        .sharing
        .lock()
        .map_err(|_| "Mesh sharing unavailable")?
        .clone();
    let path = mesh_owner_path()?;
    let owner = crate::identity::ensure_owner_at(&path).map_err(|error| error.to_string())?;
    // Never dial this machine's own advert; it can outlive the runtime it names.
    let targets = crate::discovery::peer_join_tokens(targets, &owner);
    if targets.is_empty() && sharing.is_none() && !recovering_admission {
        return Err(
            "No live community member is sharing compute; start serving on a member first".into(),
        );
    }
    host.lease.with_current(lease, |_| {
        owners.push(owner.clone());
        let admission = (
            uuid::Uuid::new_v4().to_string(),
            owner.clone(),
            owners.clone(),
            evidence,
        );
        let mut targets = targets.into_iter();
        let api_port = mesh_port("BUZZ_MESH_API_PORT", 19337)?;
        let console_port = mesh_port("BUZZ_MESH_CONSOLE_PORT", 13131)?;
        ensure_ports_free(&[api_port, console_port])?;
        let node = crate::config::ClientConfig {
            api_port,
            console_port,
            owner_key: path,
            owner_id: owner,
            trusted_owners: owners,
            join_token: targets.next(),
            mesh_name: Some(crate::config::mesh_name_for_relay(&community)),
        };
        match sharing {
            Some(share) => host.lifecycle.serve_observed(
                crate::config::ServeConfig {
                    node,
                    model: share.model.clone(),
                    max_vram_gb: share.max_vram_gb,
                },
                sharing::observer(
                    app.clone(),
                    preferences::Config::pending(viewer, community.clone(), &share),
                ),
            ),
            None => host.lifecycle.start(node),
        }
        .map_err(|error| error.to_string())?;
        *host
            .admission
            .lock()
            .map_err(|_| "Mesh admission unavailable")? = Some(admission);
        host.preferences
            .lock()
            .map_err(|_| "Mesh settings unavailable")?
            .clear_runtime_error();
        queue_targets(targets, |token| {
            host.lifecycle
                .dial(token)
                .map_err(|error| error.to_string())
        });
        Ok(())
    })
}

fn mesh_owner_path() -> Result<std::path::PathBuf, String> {
    crate::identity::default_owner_path().map_err(|error| error.to_string())
}
/// Fails closed when another mesh-llm (standalone or another Buzz) already
/// holds a port, rather than adopting its listener as ours.
fn ensure_ports_free(ports: &[u16]) -> Result<(), String> {
    for port in ports {
        std::net::TcpListener::bind(("127.0.0.1", *port)).map_err(|_| {
            format!("Port {port} is in use. Is another mesh-llm running? Stop it and try again.")
        })?;
    }
    Ok(())
}

fn mesh_port(name: &str, fallback: u16) -> Result<u16, String> {
    match std::env::var(name) {
        Ok(value) => value
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .ok_or_else(|| format!("Invalid {name}")),
        Err(std::env::VarError::NotPresent) => Ok(fallback),
        Err(_) => Err(format!("Invalid {name}")),
    }
}

pub(crate) async fn retire_selection(
    host: &MeshHost,
    community: &str,
    viewer: &str,
) -> Result<(), String> {
    let changing = host
        .preferences
        .lock()
        .map_err(|_| "Mesh settings unavailable")?
        .requires_retirement(
            host.lease
                .current()?
                .as_ref()
                .map(|(_, community)| community.as_str()),
            community,
            viewer,
        );
    if changing {
        // Retire pending launches first; running agents must exit before port reuse.
        let previous = host.lease.current()?;
        host.lease.clear();
        let stopped = host
            .lifecycle
            .stop_and_wait()
            .await
            .map_err(|error| error.to_string());
        if let Err(error) = stopped {
            host.lease.restore(previous)?;
            return Err(error);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn mesh_compute_select(
    app: tauri::AppHandle,
    host: tauri::State<'_, MeshHost>,
    identity: tauri::State<'_, crate::desktop::host::Identity>,
    community: String,
    restore_sharing: Option<bool>,
    replace_existing: Option<bool>,
) -> Result<String, String> {
    let community = agent::community_origin(&community)?;
    let viewer = identity.viewer().await?;
    let viewer_changed = host
        .preferences
        .lock()
        .map_err(|_| "Mesh settings unavailable")?
        .viewer_changed(&viewer);
    if !viewer_changed && !replace_existing.unwrap_or(false) {
        if let Some((lease, _)) = host.lease.current()? {
            // Ordinary selection describes the view, not a replacement request.
            return Ok(lease);
        }
    }
    let _guard = host.preparing.interrupt(None).await;
    retire_selection(&host, &community, &viewer).await?;
    let lease = host
        .lease
        .try_select_with(community.clone(), viewer_changed, || {
            let mut sharing = host
                .sharing
                .lock()
                .map_err(|_| "Mesh sharing unavailable")?;
            *sharing = None;
            host.lifecycle.stop();
            Ok(())
        })?;
    host.preferences
        .lock()
        .map_err(|_| "Mesh settings unavailable")?
        .select(viewer, community);
    let restore = host
        .preferences
        .lock()
        .map_err(|_| "Mesh settings unavailable")?
        .hint()
        .filter(|config| config.enabled && restore_sharing.unwrap_or(true))
        .cloned();
    publisher::ensure_started(app.clone(), &host)?;
    coordinator::ensure_started(app.clone(), &host)?;
    let restore = if host
        .sharing
        .lock()
        .map_err(|_| "Mesh sharing unavailable")?
        .is_none()
    {
        restore
    } else {
        None
    };
    if restore.is_some() {
        crate::startup_log::stage("entry", "from=restore");
        // Selection may follow release while the old worker is still stopping.
        // Confirm shutdown before restoring; never hold a synchronous lock across await.
        if let Err(error) = host.lifecycle.stop_and_wait().await {
            host.preferences
                .lock()
                .map_err(|_| "Mesh settings unavailable")?
                .set_error(error.to_string());
            return Ok(lease);
        }
    }
    drop(_guard);
    if let Some(config) = restore {
        // Mesh owns acquisition; discovery re-verifies membership before start.
        if let Err(error) = sharing::mesh_compute_share(
            app.clone(),
            lease.clone(),
            Some(config.model),
            config.max_vram_gb,
            Some(config.auto),
            None,
        )
        .await
        {
            host.preferences
                .lock()
                .map_err(|_| "Mesh settings unavailable")?
                .set_error(error);
        }
    }
    Ok(lease)
}
#[tauri::command]
pub async fn mesh_compute_release<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    host: tauri::State<'_, MeshHost>,
    lease: String,
) -> Result<(), String> {
    if host.lease.community(&lease).is_err() {
        return Ok(());
    }
    let _guard = host.preparing.interrupt(Some(&lease)).await;
    if host.lease.community(&lease).is_ok() {
        host.lease.with_current(&lease, |_| {
            let mut sharing = host
                .sharing
                .lock()
                .map_err(|_| "Mesh sharing unavailable")?;
            *sharing = None;
            host.lifecycle.stop();
            Ok(())
        })?;
        host.lease.revoke(&lease)?;
        *host
            .admission
            .lock()
            .map_err(|_| "Mesh admission unavailable")? = None;
    }
    Ok(())
}

fn queue_targets(
    targets: impl IntoIterator<Item = String>,
    mut dial: impl FnMut(&str) -> Result<(), String>,
) {
    for token in targets {
        if dial(&token).is_err() {
            eprintln!("Mesh discovery target could not be queued; client remains started");
        }
    }
}

#[cfg(test)]
mod queue_tests {
    #[test]
    fn rejected_secondary_target_does_not_fail_the_started_operation() {
        let mut calls = 0;
        super::queue_targets(["first".into(), "second".into()], |_| {
            calls += 1;
            if calls == 2 {
                Err("fixture rejection".into())
            } else {
                Ok(())
            }
        });
        assert_eq!(calls, 2);
    }
}

/// Turn off saved automatic sharing for this viewer and community without a lease
/// or a confirmed runtime shutdown. Consent only: the runtime replacement fence,
/// lease and live lifecycle are untouched, so this can never start or stop Mesh.
#[tauri::command]
pub async fn mesh_compute_disarm(
    host: tauri::State<'_, MeshHost>,
    identity: tauri::State<'_, crate::desktop::host::Identity>,
    community: String,
    expected_viewer: String,
) -> Result<(), String> {
    let community = agent::community_origin(&community)?;
    // No lease fences this write, so a request issued for one identity must never
    // be reinterpreted for whichever identity is current when it arrives.
    let viewer = identity.viewer().await?;
    if viewer != expected_viewer {
        return Err("Identity changed before turning off Mesh sharing".into());
    }
    let _guard = host.preparing.lock().await;
    if identity.viewer().await? != viewer {
        return Err("Identity changed before turning off Mesh sharing".into());
    }
    disarm_saved(&host, viewer, community)
}

fn disarm_saved(host: &MeshHost, viewer: String, community: String) -> Result<(), String> {
    let mut prefs = host
        .preferences
        .lock()
        .map_err(|_| "Mesh settings unavailable")?;
    prefs.select(viewer, community);
    prefs.disarm()
}

/// Signed relay advertisements, not live node health. Does not start Mesh.
#[tauri::command]
pub async fn mesh_compute_inventory(
    host: tauri::State<'_, MeshHost>,
    identity: tauri::State<'_, crate::desktop::host::Identity>,
    community: String,
) -> Result<serde_json::Value, String> {
    {
        let mut inventory = discovery::inventory(identity.inner(), &community).await?;
        name_entries(&host, &mut inventory.entries).await;
        serde_json::to_value(inventory).map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub async fn mesh_compute_catalog() -> Result<crate::catalog::Catalog, String> {
    tokio::task::spawn_blocking(crate::catalog::catalog)
        .await
        .map_err(|error| format!("Mesh catalog task failed: {error}"))?
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use tauri::Manager;

    #[test]
    fn hash_only_adverts_use_known_names_or_an_honest_fallback() {
        let entry = |id: &str, name: Option<&str>| crate::inventory::Entry {
            device_id: None,
            member_pubkey: "m".into(),
            model_id: id.into(),
            model_name: name.map(str::to_owned),
            device_name: None,
            vram_gb: None,
        };
        let known =
            "local-gguf/sha256-acd36c32a5ecd1b01db5806d19bc2fdbac3f23920120c3f0b1acdf571f57a399";
        let unknown =
            "local-gguf/sha256-7756e8943d5ec98b1cd76895d33d20b8c8bf7609a71540fc9b6fa512bdedd0de";
        let mut entries = vec![
            entry(known, Some(known)),
            entry(unknown, None),
            entry("unsloth/Real-GGUF:Q4", Some("unsloth/Real-GGUF:Q4")),
            entry("named", Some("Friendly")),
        ];
        let mut names = serde_json::Map::new();
        names.insert(known.into(), "unsloth/Qwen3.5-9B-GGUF:Q4_K_M".into());
        apply_names(&mut entries, &names);
        assert_eq!(
            entries[0].model_name.as_deref(),
            Some("unsloth/Qwen3.5-9B-GGUF:Q4_K_M")
        );
        // The routing id stays exact; the label is honest, not the hash.
        assert_eq!(entries[1].model_id, unknown);
        assert_eq!(
            entries[1].model_name.as_deref(),
            Some("Model name unavailable (7756e8943d5e)")
        );
        assert_eq!(
            entries[2].model_name.as_deref(),
            Some("unsloth/Real-GGUF:Q4")
        );
        assert_eq!(entries[3].model_name.as_deref(), Some("Friendly"));
        // Non-ASCII ids must not split a character.
        let mut odd = vec![entry("local-gguf/sha256-aaaaaaaaaaaé-tail", None)];
        apply_names(&mut odd, &serde_json::Map::new());
        assert_eq!(
            odd[0].model_name.as_deref(),
            Some("Model name unavailable (aaaaaaaaaaaé)")
        );
    }

    #[test]
    fn disarm_without_a_lease_persists_only_for_that_viewer_and_community() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mesh-sharing.json");
        let host = MeshHost::default();
        host.initialize_preferences(Ok(path.clone()));
        let community = "https://fixture.example";
        {
            let mut prefs = host.preferences.lock().unwrap();
            prefs.select("viewer".into(), community.into());
            let share = sharing::Share {
                model: "fixture".into(),
                max_vram_gb: None,
            };
            let mut config =
                preferences::Config::pending("viewer".into(), community.into(), &share);
            config.enabled = true;
            prefs.checkpoint(config).unwrap();
        }
        // No lease exists (lost after a failed selection); the lifecycle is not consulted.
        assert!(host.lease.current().unwrap().is_none());
        let phase = host.lifecycle.phase();
        disarm_saved(&host, "other-viewer".into(), community.into()).unwrap();
        disarm_saved(&host, "viewer".into(), "https://other.example".into()).unwrap();
        let mut reopened = preferences::Preferences::default();
        reopened.initialize(Ok(path.clone()));
        reopened.select("viewer".into(), community.into());
        assert!(reopened.hint().unwrap().enabled);
        disarm_saved(&host, "viewer".into(), community.into()).unwrap();
        let mut reopened = preferences::Preferences::default();
        reopened.initialize(Ok(path));
        reopened.select("viewer".into(), community.into());
        assert!(!reopened.hint().unwrap().enabled);
        assert_eq!(reopened.hint().unwrap().model, "fixture");
        assert_eq!(host.lifecycle.phase(), phase);
        assert!(host.lease.current().unwrap().is_none());
    }

    #[tokio::test]
    async fn disarm_command_rejects_a_request_issued_for_another_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mesh-sharing.json");
        let identity: host::Identity =
            std::sync::Arc::new(host::FixtureIdentity("fixture-viewer".into()));
        let viewer = identity.viewer().await.unwrap();
        let community = "https://fixture.example";
        let host = MeshHost::default();
        host.initialize_preferences(Ok(path.clone()));
        {
            let mut prefs = host.preferences.lock().unwrap();
            prefs.select(viewer.clone(), community.into());
            let share = sharing::Share {
                model: "fixture".into(),
                max_vram_gb: None,
            };
            let mut config = preferences::Config::pending(viewer.clone(), community.into(), &share);
            config.enabled = true;
            prefs.checkpoint(config).unwrap();
        }
        let app = tauri::test::mock_builder()
            .manage(host)
            .manage(identity)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let error =
            mesh_compute_disarm(app.state(), app.state(), community.into(), "retired".into())
                .await
                .unwrap_err();
        assert!(error.contains("Identity changed"));
        let mut reopened = preferences::Preferences::default();
        reopened.initialize(Ok(path.clone()));
        reopened.select(viewer.clone(), community.into());
        assert!(reopened.hint().unwrap().enabled);
        mesh_compute_disarm(app.state(), app.state(), community.into(), viewer.clone())
            .await
            .unwrap();
        let mut reopened = preferences::Preferences::default();
        reopened.initialize(Ok(path));
        reopened.select(viewer, community.into());
        assert!(!reopened.hint().unwrap().enabled);
    }

    #[tokio::test]
    async fn release_and_reopen_preserve_saved_sharing_but_expire_the_lease() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mesh-sharing.json");
        let host = MeshHost::default();
        host.initialize_preferences(Ok(path.clone()));
        let community = "https://fixture.example";
        let lease = host.lease.select(community.into()).unwrap();
        let share = sharing::Share {
            model: "fixture".into(),
            max_vram_gb: None,
        };
        {
            let mut prefs = host.preferences.lock().unwrap();
            prefs.select("viewer".into(), community.into());
            let mut config =
                preferences::Config::pending("viewer".into(), community.into(), &share);
            config.enabled = true;
            prefs.checkpoint(config).unwrap();
        }
        *host.sharing.lock().unwrap() = Some(share);
        let app = tauri::test::mock_builder()
            .manage(host)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        mesh_compute_release(app.handle().clone(), app.state(), lease.clone())
            .await
            .unwrap();
        let host = app.state::<MeshHost>();
        assert!(host.lease.community(&lease).is_err());
        assert!(host.sharing.lock().unwrap().is_none());
        let mut reopened = preferences::Preferences::default();
        reopened.initialize(Ok(path));
        reopened.select("viewer".into(), "https://other.example".into());
        assert!(reopened.hint().is_none());
        reopened.select("viewer".into(), community.into());
        assert!(reopened.hint().unwrap().enabled);
        assert_eq!(reopened.hint().unwrap().model, "fixture");
        // A late disposal of the old lease cannot release a new selection.
        let next = host.lease.select(community.into()).unwrap();
        mesh_compute_release(app.handle().clone(), app.state(), lease)
            .await
            .unwrap();
        assert!(host.lease.community(&next).is_ok());
    }
}

/// Label `local-gguf/sha256-…` advertisements (older publishers) with the readable
/// ref from this node's own Mesh catalog, when Mesh is running here.
async fn name_entries(host: &MeshHost, entries: &mut [crate::inventory::Entry]) {
    let unnamed =
        |e: &crate::inventory::Entry| e.model_name.as_deref().is_none_or(|n| n == e.model_id);
    if !entries.iter().any(unnamed) {
        return;
    }
    // 1. A running local node knows peers' readable refs from Mesh's own catalog.
    let mut names = serde_json::Map::new();
    if host.lifecycle.phase() == crate::lifecycle::Phase::Ready {
        if let Ok(status) = host.lifecycle.status().await {
            if let Some(serde_json::Value::Object(map)) =
                publisher::display_names(&status.console_url).await
            {
                names = map;
            }
        }
    }
    apply_names(entries, &names);
}

/// Label hash-only entries from known names; never present a hash as a name.
fn apply_names(
    entries: &mut [crate::inventory::Entry],
    names: &serde_json::Map<String, serde_json::Value>,
) {
    for entry in entries
        .iter_mut()
        .filter(|e| e.model_name.as_deref().is_none_or(|n| n == e.model_id))
    {
        if let Some(name) = names.get(&entry.model_id).and_then(|v| v.as_str()) {
            entry.model_name = Some(name.to_owned());
        } else if let Some(hash) = entry.model_id.strip_prefix("local-gguf/") {
            // Character-safe: signed adverts carry arbitrary strings.
            let short: String = hash
                .trim_start_matches("sha256-")
                .chars()
                .take(12)
                .collect();
            entry.model_name = Some(format!("Model name unavailable ({short})"));
        }
    }
}

#[cfg(test)]
mod port_tests {
    #[test]
    fn occupied_port_fails_closed_and_free_port_passes() {
        let held = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        let error = super::ensure_ports_free(&[port]).unwrap_err();
        assert!(error.contains(&format!("Port {port} is in use")));
        drop(held);
        super::ensure_ports_free(&[port]).unwrap();
    }
}
