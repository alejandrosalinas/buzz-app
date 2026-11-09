//! Serving intent belongs to the selected community and the existing node.
use tauri::Manager;

pub(super) fn observer(
    app: tauri::AppHandle,
    config: super::preferences::Config,
) -> impl Fn(crate::lifecycle::Phase) + Send + Sync + 'static {
    let reached_ready = std::sync::atomic::AtomicBool::new(false);
    move |phase| {
        if phase == crate::lifecycle::Phase::Ready {
            reached_ready.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let host = app.state::<super::MeshHost>();
        // Same-community UI remounts rotate the lease without replacing the worker.
        // Bind checkpoints to the still-selected community and exact intent instead.
        let result = host
            .lease
            .for_community(&config.community)
            .and_then(|lease| {
                host.lease.with_current(&lease, |_| {
                    let mut intent = host
                        .sharing
                        .lock()
                        .map_err(|_| "Mesh sharing unavailable")?;
                    if intent.as_ref().is_none_or(|share| {
                        share.model != config.model || share.max_vram_gb != config.max_vram_gb
                    }) {
                        return Ok(());
                    }
                    let result = host
                        .preferences
                        .lock()
                        .map_err(|_| "Mesh settings unavailable")?
                        .phase(
                            &config,
                            &phase,
                            reached_ready.load(std::sync::atomic::Ordering::SeqCst),
                        );
                    if matches!(phase, crate::lifecycle::Phase::Failed(_)) {
                        *intent = None;
                    }
                    result
                })
            });
        if let Err(error) = result {
            eprintln!("Mesh sharing checkpoint: {error}");
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Share {
    pub model: String,
    pub max_vram_gb: Option<u64>,
}
impl Share {
    fn new(model: String, max_vram_gb: Option<u64>) -> Result<Self, String> {
        let model = crate::catalog::canonical_curated_model_id(&model).to_owned();
        if model.is_empty() {
            return Err("Choose a model before sharing compute".into());
        }
        if max_vram_gb == Some(0) {
            return Err("Shared compute memory limit must be positive".into());
        }
        Ok(Self { model, max_vram_gb })
    }
}

#[tauri::command]
pub async fn mesh_compute_share(
    app: tauri::AppHandle,
    lease: String,
    model: Option<String>,
    max_vram_gb: Option<u64>,
    auto: Option<bool>,
    reset_only: Option<bool>,
) -> Result<(), String> {
    let automatic = auto.unwrap_or(false);
    let resetting = reset_only.unwrap_or(false);
    let host = app.state::<super::MeshHost>();
    let identity = app.state::<crate::desktop::host::Identity>();
    let stopping = model.is_none();
    let viewer = identity.viewer().await?;
    let member = viewer.clone();
    {
        host.lease.community(&lease)?;
        let persistence_only = resetting
            || (stopping
                && host
                    .sharing
                    .lock()
                    .map_err(|_| "Mesh sharing unavailable")?
                    .is_none());
        let _guard = if persistence_only {
            host.preparing.lock().await
        } else {
            host.preparing.interrupt(Some(&lease)).await
        };
        let community = host.lease.community(&lease)?;
        let needs_reset_model = resetting
            && host
                .preferences
                .lock()
                .map_err(|_| "Mesh settings unavailable")?
                .hint()
                .is_none();
        // Auto follows the hosting ladder and its quarter-memory budget; an explicit
        // limit from the caller still wins.
        let recommended = if (automatic && model.is_some() && !resetting) || needs_reset_model {
            Some(
                tokio::task::spawn_blocking(crate::catalog::recommended_model)
                    .await
                    .map_err(|error| format!("Mesh hardware survey failed: {error}"))?,
            )
        } else {
            None
        };
        let share = if resetting {
            None
        } else {
            model
                .map(|model| match recommended.clone() {
                    Some(auto) => Share::new(auto.model, max_vram_gb.or(auto.max_vram_gb)),
                    None => Share::new(model, max_vram_gb),
                })
                .transpose()?
        };
        if resetting {
            return host.lease.with_current(&lease, |_| {
                let mut prefs = host
                    .preferences
                    .lock()
                    .map_err(|_| "Mesh settings unavailable")?;
                let mut config = prefs.hint().cloned().unwrap_or_else(|| {
                    super::preferences::Config::pending(
                        viewer.clone(),
                        community.clone(),
                        &Share {
                            model: recommended
                                .as_ref()
                                .map(|auto| auto.model.clone())
                                .unwrap_or_default(),
                            max_vram_gb: None,
                        },
                    )
                });
                config.auto = true;
                // Preserve the current resolved model and consent; reset never starts or stops.
                prefs.checkpoint(config)
            });
        }
        if stopping
            && host
                .sharing
                .lock()
                .map_err(|_| "Mesh sharing unavailable")?
                .is_none()
        {
            // Failure can clear live intent while leaving the saved model armed.
            host.preferences
                .lock()
                .map_err(|_| "Mesh settings unavailable")?
                .disarm()?;
            return Ok(()); // Share Off must leave an existing consumer alone.
        }
        if !stopping
            && changing_state(
                &host.lifecycle.phase(),
                host.sharing
                    .lock()
                    .map_err(|_| "Mesh sharing unavailable")?
                    .is_some(),
            )
        {
            return Err("Mesh is changing state; wait before sharing again".into());
        }
        // Explicit Share Off clears intent even if shutdown cannot be confirmed.
        // The failed lifecycle still refuses replacement; never silently re-serve.
        if stopping {
            host.lease.with_current(&lease, |_| {
                let mut sharing = host
                    .sharing
                    .lock()
                    .map_err(|_| "Mesh sharing unavailable")?;
                host.preferences
                    .lock()
                    .map_err(|_| "Mesh settings unavailable")?
                    .disarm()?;
                *sharing = None;
                Ok(())
            })?;
        }
        if let Some(share) = &share {
            host.lease.with_current(&lease, |_| {
                host.preferences
                    .lock()
                    .map_err(|_| "Mesh settings unavailable")?
                    .checkpoint({
                        let mut config =
                            super::preferences::Config::pending(viewer, community, share);
                        config.auto = automatic;
                        config
                    })
            })?;
        }
        if !stopping {
            // Do not replace the worker until its shutdown is confirmed.
            host.lifecycle
                .stop_and_wait()
                .await
                .map_err(|e| e.to_string())?;
            host.lease.with_current(&lease, |_| {
                *host
                    .sharing
                    .lock()
                    .map_err(|_| "Mesh sharing unavailable")? = share;
                Ok(())
            })?;
        }
    }
    // Reuses discovery and the same private SDK slot. Solo serving needs no target.
    if stopping {
        finish_off(&ProdOff {
            app: &app,
            host: &host,
            identity: &identity,
            lease: &lease,
            member: &member,
        })
        .await
    } else {
        crate::startup_log::stage("entry", "from=share");
        let result = super::start(&app, &host, &identity, &lease).await;
        if result.is_err() {
            let _ = host.lease.with_current(&lease, |_| {
                *host
                    .sharing
                    .lock()
                    .map_err(|_| "Mesh sharing unavailable")? = None;
                Ok(())
            });
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn serving_requires_a_model_and_positive_memory_limit() {
        assert!(Share::new("  ".into(), None).is_err());
        assert!(Share::new("model".into(), Some(0)).is_err());
        assert_eq!(
            Share::new(" model ".into(), Some(16)).unwrap(),
            Share {
                model: "model".into(),
                max_vram_gb: Some(16),
            }
        );
    }
}

/// Whether Share On must wait. A serve runtime that is starting and any
/// shutdown are left to finish. A consumer client that is still connecting
/// owns no sharing intent, and a join that never settles must not lock the
/// member out of sharing, so it is stopped (confirmed) and replaced.
fn changing_state(phase: &crate::lifecycle::Phase, serving: bool) -> bool {
    use crate::lifecycle::Phase;
    match phase {
        Phase::Stopping => true,
        Phase::Starting => serving,
        _ => false,
    }
}

#[cfg(test)]
mod changing_state_tests {
    use super::changing_state;
    use crate::lifecycle::Phase;

    #[test]
    fn only_a_connecting_consumer_may_be_replaced_by_share_on() {
        assert!(!changing_state(&Phase::Starting, false));
        assert!(changing_state(&Phase::Starting, true));
        assert!(changing_state(&Phase::Stopping, false));
        assert!(changing_state(&Phase::Stopping, true));
        assert!(!changing_state(&Phase::Ready, false));
        assert!(!changing_state(&Phase::Stopped, false));
    }
}

/// Effects of a Share Off after consent is cleared. Production drives the real
/// lifecycle, publisher and host; tests substitute a recording fake.
pub(super) trait OffEffects {
    /// Stop only if the captured lease is still current; `Ok(false)` means retired.
    async fn stop(&self) -> Result<bool, String>;
    fn community(&self) -> Option<String>;
    async fn has_consumers(&self) -> bool;
    async fn withdraw(&self, community: &str);
    async fn start_client(&self) -> Result<(), String>;
    fn report(&self, error: String);
}

/// Confirmed stop, then withdraw the serving advert (legacy `mesh_stop_node`),
/// then re-arm one consumer client only when running Mesh agents need it (legacy
/// coordinator → `ensure_relay_mesh_for_record`). A failed stop does neither; a
/// retired lease withdraws nothing it no longer owns. Re-arm failure keeps the
/// cleared consent but is reported on the existing settings-error surface.
pub(super) async fn finish_off(fx: &impl OffEffects) -> Result<(), String> {
    if !fx.stop().await? {
        // A replacement owns the slot now: touch nothing of it.
        return Ok(());
    }
    let Some(community) = fx.community() else {
        return Ok(());
    };
    fx.withdraw(&community).await;
    if fx.has_consumers().await {
        if let Err(error) = fx.start_client().await {
            fx.report(format!(
                "Sharing is off, but shared compute for running agents could not restart: {error}"
            ));
        }
    }
    Ok(())
}

/// Validate the captured lease inside the acquired `preparing` guard before the
/// destructive stop, so a delayed Off can never stop a replacement's node.
async fn stop_if_current(host: &super::MeshHost, lease: &str) -> Result<bool, String> {
    if host.lease.community(lease).is_err() {
        return Ok(false);
    }
    let _guard = host.preparing.interrupt(Some(lease)).await;
    if host.lease.community(lease).is_err() {
        return Ok(false);
    }
    host.lifecycle
        .stop_and_wait()
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}

struct ProdOff<'a> {
    app: &'a tauri::AppHandle,
    host: &'a super::MeshHost,
    identity: &'a crate::desktop::host::Identity,
    lease: &'a str,
    member: &'a str,
}

impl OffEffects for ProdOff<'_> {
    async fn stop(&self) -> Result<bool, String> {
        stop_if_current(self.host, self.lease).await
    }
    fn community(&self) -> Option<String> {
        self.host.lease.community(self.lease).ok()
    }
    async fn has_consumers(&self) -> bool {
        // Agents prepare inference per turn, which restarts the client on demand.
        false
    }
    async fn withdraw(&self, community: &str) {
        super::publisher::publish_stopped(self.identity, community, self.member).await;
    }
    async fn start_client(&self) -> Result<(), String> {
        super::start(self.app, self.host, self.identity, self.lease).await
    }
    fn report(&self, error: String) {
        eprintln!("{error}");
        // Only the still-current selection's settings may carry this error.
        let _ = self.host.lease.with_current(self.lease, |_| {
            self.host
                .preferences
                .lock()
                .map_err(|_| "Mesh settings unavailable")?
                .set_error(error);
            Ok(())
        });
    }
}

#[cfg(test)]
mod off_tests {
    use super::*;
    use std::sync::Mutex;

    struct Fake {
        stop: Result<bool, String>,
        lease: bool,
        consumers: bool,
        start: Result<(), String>,
        calls: Mutex<Vec<String>>,
    }
    impl Fake {
        fn new(
            stop: Result<bool, String>,
            lease: bool,
            consumers: bool,
            start: Result<(), String>,
        ) -> Self {
            Self {
                stop,
                lease,
                consumers,
                start,
                calls: Mutex::new(Vec::new()),
            }
        }
        fn log(&self, call: &str) {
            self.calls.lock().unwrap().push(call.into());
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }
    impl OffEffects for Fake {
        async fn stop(&self) -> Result<bool, String> {
            self.log("stop");
            self.stop.clone()
        }
        fn community(&self) -> Option<String> {
            self.lease.then(|| "https://a.example".into())
        }
        async fn has_consumers(&self) -> bool {
            self.consumers
        }
        async fn withdraw(&self, community: &str) {
            self.log(&format!("withdraw:{community}"));
        }
        async fn start_client(&self) -> Result<(), String> {
            self.log("start_client");
            self.start.clone()
        }
        fn report(&self, error: String) {
            self.log(&format!("report:{error}"));
        }
    }

    #[tokio::test]
    async fn confirmed_off_with_running_consumers_stops_withdraws_then_starts_one_client() {
        let fx = Fake::new(Ok(true), true, true, Ok(()));
        finish_off(&fx).await.unwrap();
        assert_eq!(
            fx.calls(),
            ["stop", "withdraw:https://a.example", "start_client"]
        );
    }

    #[tokio::test]
    async fn no_consumers_withdraw_only_and_failed_stop_does_neither() {
        let fx = Fake::new(Ok(true), true, false, Ok(()));
        finish_off(&fx).await.unwrap();
        assert_eq!(fx.calls(), ["stop", "withdraw:https://a.example"]);
        let fx = Fake::new(Err("Mesh shutdown timed out".into()), true, true, Ok(()));
        assert_eq!(
            finish_off(&fx).await.unwrap_err(),
            "Mesh shutdown timed out"
        );
        assert_eq!(fx.calls(), ["stop"]);
    }

    #[tokio::test]
    async fn delayed_off_never_stops_a_replacement_node() {
        let host = std::sync::Arc::new(super::super::MeshHost::default());
        let old = host.lease.select("https://a.example".into()).unwrap();
        // Off's stop is queued behind a replacement holding `preparing`.
        let held = host.preparing.lock().await;
        let (h, lease) = (host.clone(), old.clone());
        let off = tokio::spawn(async move { stop_if_current(&h, &lease).await });
        tokio::task::yield_now().await;
        let replacement = host.lease.select("https://b.example".into()).unwrap();
        drop(held);
        assert_eq!(off.await.unwrap(), Ok(false), "retired Off must not stop");
        assert!(host.lease.community(&replacement).is_ok());
        assert_eq!(stop_if_current(&host, &replacement).await, Ok(true));
    }

    #[tokio::test]
    async fn retired_lease_withdraws_nothing_and_starts_no_replacement() {
        let fx = Fake::new(Ok(false), true, true, Ok(()));
        finish_off(&fx).await.unwrap();
        assert_eq!(fx.calls(), ["stop"]);
    }

    #[tokio::test]
    async fn rearm_failure_keeps_off_successful_but_reports_the_cause() {
        // e.g. discovery found no sharer: start returns before any lifecycle change.
        let fx = Fake::new(
            Ok(true),
            true,
            true,
            Err("No live community member is sharing compute".into()),
        );
        finish_off(&fx).await.unwrap();
        let calls = fx.calls();
        assert_eq!(
            &calls[..3],
            ["stop", "withdraw:https://a.example", "start_client"]
        );
        assert!(calls[3].starts_with("report:Sharing is off, but shared compute for running agents could not restart: No live community member"));
    }
}
