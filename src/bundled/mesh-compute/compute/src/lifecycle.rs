//! Process-owned SDK worker. Startup is never aborted: it may already own an OS thread.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const JOIN_BUDGET: Duration = Duration::from_secs(120);
pub const MESH_STOP_TIMEOUT: Duration = Duration::from_secs(12);
use tokio::sync::{mpsc, oneshot, watch};

use crate::config::{ClientConfig, ServeConfig};
use crate::transport_policy::validate_advertised_endpoint;

// Same explicit policy for native initialization and embedded startup; never read
// the user's standalone Mesh config. File stays alive through initialization.
fn isolated_config() -> anyhow::Result<tempfile::NamedTempFile> {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new()?;
    file.write_all(b"[[plugin]]\nname = \"telemetry\"\nenabled = false\n\n[[plugin]]\nname = \"blobstore\"\nenabled = false\n" )?;
    Ok(file)
}

/// SDK status returned by the owned worker; payload remains untyped JSON.
pub use mesh_llm_embedded_runtime::EmbeddedMeshNodeStatus as NodeStatus;

#[derive(Debug)]
struct BeforeNode(anyhow::Error);
impl std::fmt::Display for BeforeNode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
impl std::error::Error for BeforeNode {}

type Observer = Arc<dyn Fn(Phase) + Send + Sync>;

type Operation<'a, T> = Pin<Box<dyn Future<Output = anyhow::Result<T>> + Send + 'a>>;

trait Node: Send + Sync + 'static {
    fn join(&self, token: String) -> Operation<'_, ()>;
    fn status(&self) -> Operation<'_, NodeStatus>;
    fn stop(self) -> Operation<'static, ()>;
}
impl Node for mesh_llm_embedded_runtime::EmbeddedMeshNodeHandle {
    fn join(&self, token: String) -> Operation<'_, ()> {
        Box::pin(self.join_token(token))
    }
    fn status(&self) -> Operation<'_, NodeStatus> {
        Box::pin(self.status())
    }
    fn stop(self) -> Operation<'static, ()> {
        Box::pin(self.stop())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", content = "reason", rename_all = "camelCase")]
pub enum Phase {
    Stopped,
    Starting,
    Ready,
    Stopping,
    /// Shutdown was not proved; replacement is deliberately refused.
    Failed(String),
}

struct Slot {
    phase: Phase,
    generation: u64,
    serving: bool,
    joining: bool,
    pending_tokens: HashSet<String>,
    retryable: bool,
    dial: Option<mpsc::Sender<String>>,
    stop: Option<watch::Sender<bool>>,
    status: Option<mpsc::Sender<oneshot::Sender<anyhow::Result<NodeStatus>>>>,
}

/// The Mesh node runs on its own process-wide runtime, so the app keeps its
/// default runtime. SDK model/download futures need 8 MiB worker stacks.
fn mesh_runtime() -> std::io::Result<tokio::runtime::Handle> {
    static RUNTIME: std::sync::OnceLock<Result<tokio::runtime::Runtime, String>> =
        std::sync::OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_name("mesh")
                .thread_stack_size(8 * 1024 * 1024)
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map(|runtime| runtime.handle().clone())
        .map_err(|error| std::io::Error::other(error.clone()))
}

/// The app owns this across plugin/page lifetimes. Dropping it requests shutdown.
pub struct Lifecycle {
    slot: Arc<Mutex<Slot>>,
    progress: crate::progress::Progress,
    /// Set by the first launch; native libraries stay loaded for the process.
    launched: std::sync::atomic::AtomicBool,
}
impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            progress: crate::progress::Progress::default(),
            launched: std::sync::atomic::AtomicBool::new(false),
            slot: Arc::new(Mutex::new(Slot {
                phase: Phase::Stopped,
                generation: 0,
                serving: false,
                joining: false,
                pending_tokens: HashSet::new(),
                retryable: false,
                dial: None,
                stop: None,
                status: None,
            })),
        }
    }
}
impl Lifecycle {
    /// Whether this process has ever started the embedded Mesh node.
    pub fn launched(&self) -> bool {
        self.launched.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn phase(&self) -> Phase {
        self.slot.lock().expect("mesh slot poisoned").phase.clone()
    }

    pub fn generation(&self) -> u64 {
        self.slot.lock().expect("mesh slot poisoned").generation
    }

    /// Ask the owned SDK handle for status; never discover a node by a guessed port.
    pub async fn status(&self) -> anyhow::Result<NodeStatus> {
        let (reply, result) = oneshot::channel();
        {
            let slot = self
                .slot
                .lock()
                .map_err(|_| anyhow::anyhow!("Mesh slot unavailable"))?;
            if slot.phase != Phase::Ready {
                anyhow::bail!("Mesh status is not ready");
            }
            slot.status
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Mesh worker unavailable"))?
                .try_send(reply)
                .map_err(|_| anyhow::anyhow!("Mesh status request is already pending"))?;
        }
        result
            .await
            .map_err(|_| anyhow::anyhow!("Mesh stopped during status read"))?
    }

    /// The pinned SDK finishes an already queued peer join before Shutdown.
    pub fn finishing_join(&self) -> bool {
        self.slot
            .lock()
            .map(|slot| slot.joining && slot.phase == Phase::Stopping)
            .unwrap_or(false)
    }

    pub fn start(&self, request: ClientConfig) -> anyhow::Result<()> {
        let config = request.build()?;
        self.launch(async move { mesh_llm_embedded_runtime::start_embedded_node(config).await })
    }

    /// Share a local model through the same exclusive SDK slot as consumers.
    pub fn serve(&self, request: ServeConfig) -> anyhow::Result<()> {
        self.serve_observed(request, |_| {})
    }

    /// Notify the host of worker transitions for fenced persistence checkpoints.
    /// Observers run outside the slot lock and must not block on async work.
    pub fn serve_observed(
        &self,
        request: ServeConfig,
        observe: impl Fn(Phase) + Send + Sync + 'static,
    ) -> anyhow::Result<()> {
        let mut config = request.build()?;
        let isolated = isolated_config()?;
        config.storage.config_path = Some(isolated.path().to_owned());
        let progress = self.progress.clone();
        self.launch_observed(
            async move {
                progress.install();
                mesh_llm_host_runtime::initialize_host_runtime_with_config(Some(isolated.path()))
                    .await
                    .map_err(BeforeNode)?;
                // Serving resolves and acquires its own artifacts (including layer packages).
                // A separate GGUF download here duplicates acquisition.
                mesh_llm_embedded_runtime::start_embedded_node(config).await
            },
            true,
            Arc::new(observe),
        )
    }

    /// Byte progress from the current worker, retained across UI remounts.
    pub fn download_progress(&self) -> Option<crate::progress::DownloadProgress> {
        self.progress.latest()
    }

    fn launch<N: Node>(
        &self,
        startup: impl Future<Output = anyhow::Result<N>> + Send + 'static,
    ) -> anyhow::Result<()> {
        self.launch_role(startup, false)
    }

    /// True only for the installed, ready serving worker, never for startup intent.
    pub fn is_serving(&self) -> bool {
        self.slot
            .lock()
            .map(|slot| slot.phase == Phase::Ready && slot.serving)
            .unwrap_or(false)
    }

    fn launch_role<N: Node>(
        &self,
        startup: impl Future<Output = anyhow::Result<N>> + Send + 'static,
        serving: bool,
    ) -> anyhow::Result<()> {
        self.launch_observed(startup, serving, Arc::new(|_| {}))
    }

    fn launch_observed<N: Node>(
        &self,
        startup: impl Future<Output = anyhow::Result<N>> + Send + 'static,
        serving: bool,
        observe: Observer,
    ) -> anyhow::Result<()> {
        let mut slot = self.slot.lock().expect("mesh slot poisoned");
        if slot.phase != Phase::Stopped {
            anyhow::bail!("Previous Mesh runtime shutdown is not confirmed");
        }
        let runtime = mesh_runtime()?;
        self.launched
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.progress.clear();
        let (dial, mut pending) = mpsc::channel::<String>(64);
        let (status, mut reads) = mpsc::channel::<oneshot::Sender<anyhow::Result<NodeStatus>>>(1);
        let (stop, mut stopping) = watch::channel(false);
        slot.retryable = false;
        slot.pending_tokens.clear();
        slot.phase = Phase::Starting;
        slot.generation += 1;
        slot.serving = serving;
        slot.dial = Some(dial);
        slot.stop = Some(stop);
        slot.status = Some(status);
        let shared = self.slot.clone();
        drop(slot);
        // Detached from the caller's request lifetime, intentionally not abortable by IPC.
        let launched = std::time::Instant::now();
        runtime.spawn(async move {
            let started = startup.await;
            crate::startup_log::stage(
                "sdk_start_returned",
                &format!("ok={} launch_ms={}", started.is_ok(), launched.elapsed().as_millis()),
            );
            let node = match started {
                Ok(node) => node,
                Err(error) => {
                    let phase = Phase::Failed(format!("{error:#}"));
                    {
                        let mut slot = shared.lock().expect("mesh slot poisoned");
                        slot.retryable = error.downcast_ref::<BeforeNode>().is_some();
                        slot.phase = phase.clone();
                        if slot.retryable { slot.stop = None; slot.status = None; slot.dial = None; }
                    }
                    observe(phase);
                    return;
                }
            };
            {
                let mut slot = shared.lock().expect("mesh slot poisoned");
                if slot.phase == Phase::Starting { slot.phase = Phase::Ready; }
            }
            let phase = shared.lock().expect("mesh slot poisoned").phase.clone();
            observe(phase);
            loop {
                if *stopping.borrow() { break; }
                tokio::select! {
                    biased;
                    _ = stopping.changed() => break,
                    request = reads.recv() => {
                        let Some(reply) = request else { break; };
                        // Status is cancellable; unlike startup it creates no runtime.
                        tokio::select! {
                            biased;
                            _ = stopping.changed() => break,
                            result = tokio::time::timeout(Duration::from_secs(10), node.status()) => {
                                let result = result.unwrap_or_else(|_| Err(anyhow::anyhow!("Mesh status read timed out")));
                                let _ = reply.send(result);
                            }
                        }
                    }
                    token = pending.recv() => {
                        let Some(token) = token else { break; };
                        shared.lock().expect("mesh slot poisoned").joining = true;
                        // SDK Join queues work inside its serial control loop. Keep just one
                        // in flight; dropping its response does NOT cancel the SDK operation.
                        let joining = node.join(token.clone());
                        tokio::pin!(joining);
                        loop {
                            tokio::select! {
                                biased;
                                _ = stopping.changed() => break,
                                result = &mut joining => {
                                    if let Err(error) = result {
                                        eprintln!("Mesh peer join failed; keeping node running: {error:#}");
                                    }
                                    {
                                        let mut slot = shared.lock().expect("mesh slot poisoned");
                                        slot.joining = false;
                                        slot.pending_tokens.remove(&token);
                                    }
                                    break;
                                }
                                request = reads.recv() => {
                                    let Some(reply) = request else { break; };
                                    tokio::select! {
                                        biased;
                                        _ = stopping.changed() => break,
                                        result = tokio::time::timeout(Duration::from_secs(10), node.status()) => {
                                            let _ = reply.send(result.unwrap_or_else(|_| Err(anyhow::anyhow!("Mesh status read timed out"))));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            drop(pending); // Never enqueue another SDK join after Stop.
            let stop_budget = if shared.lock().expect("mesh slot poisoned").joining {
                JOIN_BUDGET + MESH_STOP_TIMEOUT
            } else { MESH_STOP_TIMEOUT };
            // A timeout is not proof of shutdown: retain Failed and reject replacement.
            let result = match tokio::time::timeout(stop_budget, node.stop()).await {
                Ok(result) => result,
                Err(_) => Err(anyhow::anyhow!("Mesh shutdown timed out; restart Buzz before starting another runtime")),
            };
            let mut slot = shared.lock().expect("mesh slot poisoned");
            slot.phase = match result {
                Ok(()) => Phase::Stopped,
                Err(error) => Phase::Failed(format!("{error:#}")),
            };
            slot.joining = false;
            slot.pending_tokens.clear();
            slot.dial = None;
            slot.stop = None;
            slot.status = None;
            let phase = slot.phase.clone();
            drop(slot);
            observe(phase);
        });
        Ok(())
    }

    /// Tokens come from host discovery; transport validation also applies to queued joins.
    pub fn dial(&self, token: &str) -> anyhow::Result<()> {
        let token = validate_advertised_endpoint(token)?.join_token;
        self.enqueue(token)
    }
    fn enqueue(&self, token: String) -> anyhow::Result<()> {
        let mut slot = self.slot.lock().expect("mesh slot poisoned");
        if !matches!(slot.phase, Phase::Starting | Phase::Ready) {
            anyhow::bail!("Mesh runtime is not accepting dial targets");
        }
        if slot.pending_tokens.contains(&token) {
            return Ok(());
        }
        slot.dial
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Mesh worker is unavailable"))?
            .try_send(token.clone())
            .map_err(|_| anyhow::anyhow!("Mesh dial queue is full or unavailable"))?;
        slot.pending_tokens.insert(token);
        Ok(())
    }

    /// Caller timeout never cancels startup or changes the slot to Stopped.
    pub async fn stop_and_wait(&self) -> anyhow::Result<()> {
        {
            let mut slot = self
                .slot
                .lock()
                .map_err(|_| anyhow::anyhow!("Mesh slot unavailable"))?;
            if slot.retryable {
                slot.phase = Phase::Stopped;
                slot.retryable = false;
            }
        }
        self.stop();
        let budget = if self.slot.lock().expect("mesh slot poisoned").joining {
            JOIN_BUDGET + MESH_STOP_TIMEOUT
        } else {
            MESH_STOP_TIMEOUT
        };
        tokio::time::timeout(budget, async {
            loop {
                match self.phase() {
                    Phase::Stopped => return Ok(()),
                    Phase::Failed(reason) => anyhow::bail!(reason),
                    _ => tokio::time::sleep(Duration::from_millis(25)).await,
                }
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("Finishing stop; restart Buzz if this persists"))?
    }

    pub fn stop(&self) {
        let mut slot = self.slot.lock().expect("mesh slot poisoned");
        if let Some(stop) = &slot.stop {
            let _ = stop.send(true);
            if !matches!(slot.phase, Phase::Failed(_)) {
                slot.phase = Phase::Stopping;
            }
        }
    }
}
impl Drop for Lifecycle {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    struct FakeNode {
        stopped: oneshot::Sender<()>,
        release: oneshot::Receiver<()>,
        joined: mpsc::UnboundedSender<String>,
    }
    impl Node for FakeNode {
        fn join(&self, token: String) -> Operation<'_, ()> {
            Box::pin(async move {
                self.joined.send(token)?;
                Ok(())
            })
        }
        fn status(&self) -> Operation<'_, NodeStatus> {
            Box::pin(async {
                Ok(NodeStatus {
                    api_base_url: "fixture".into(),
                    console_url: "fixture".into(),
                    invite_token: None,
                    payload: serde_json::json!({"hosted_models":["fixture-model"]}),
                })
            })
        }
        fn stop(self) -> Operation<'static, ()> {
            Box::pin(async move {
                let _ = self.stopped.send(());
                self.release.await?;
                Ok(())
            })
        }
    }
    fn fixture() -> (
        FakeNode,
        oneshot::Receiver<()>,
        oneshot::Sender<()>,
        mpsc::UnboundedReceiver<String>,
    ) {
        let (stopped, observed) = oneshot::channel();
        let (release, gate) = oneshot::channel();
        let (joined, received) = mpsc::unbounded_channel();
        (
            FakeNode {
                stopped,
                release: gate,
                joined,
            },
            observed,
            release,
            received,
        )
    }
    #[tokio::test]
    async fn known_pre_node_failure_can_retry_but_unknown_startup_failure_cannot() {
        let owner = Lifecycle::default();
        owner
            .launch(async {
                Err::<FakeNode, _>(BeforeNode(anyhow::anyhow!("download failed")).into())
            })
            .unwrap();
        while owner.phase() == Phase::Starting {
            tokio::task::yield_now().await;
        }
        assert!(matches!(owner.phase(), Phase::Failed(_)));
        owner.stop_and_wait().await.unwrap();
        let (node, stopped, release, _) = fixture();
        owner.launch(async { Ok(node) }).unwrap();
        owner.stop();
        stopped.await.unwrap();
        release.send(()).unwrap();
        wait_stopped(&owner).await;
        owner
            .launch(async { Err::<FakeNode, _>(anyhow::anyhow!("uncertain runtime")) })
            .unwrap();
        while owner.phase() == Phase::Starting {
            tokio::task::yield_now().await;
        }
        assert!(owner.stop_and_wait().await.is_err());
        assert!(matches!(owner.phase(), Phase::Failed(_)));
    }

    struct JoiningNode {
        inner: FakeNode,
        began: mpsc::UnboundedSender<()>,
        release_join: watch::Receiver<bool>,
        fail: bool,
    }
    impl Node for JoiningNode {
        fn join(&self, _: String) -> Operation<'_, ()> {
            Box::pin(async move {
                self.began.send(())?;
                let mut gate = self.release_join.clone();
                if !*gate.borrow() {
                    gate.changed().await?;
                }
                if self.fail {
                    anyhow::bail!("unreachable peer");
                }
                Ok(())
            })
        }
        fn status(&self) -> Operation<'_, NodeStatus> {
            self.inner.status()
        }
        fn stop(self) -> Operation<'static, ()> {
            self.inner.stop()
        }
    }
    #[tokio::test]
    async fn failed_peer_join_keeps_ready_and_next_status_works() {
        let owner = Lifecycle::default();
        let (inner, stopped, release, _) = fixture();
        let (began, mut observed) = mpsc::unbounded_channel();
        let (_open, gate) = watch::channel(true);
        owner
            .launch(async {
                Ok(JoiningNode {
                    inner,
                    began,
                    release_join: gate,
                    fail: true,
                })
            })
            .unwrap();
        owner.enqueue("failed-peer".into()).unwrap();
        observed.recv().await.unwrap();
        owner.status().await.unwrap();
        assert_eq!(owner.phase(), Phase::Ready);
        owner.stop();
        stopped.await.unwrap();
        release.send(()).unwrap();
        wait_stopped(&owner).await;
    }
    #[tokio::test]
    async fn held_join_allows_status_and_stop_discards_queued_peers() {
        let owner = Lifecycle::default();
        let (inner, stopped, release, _) = fixture();
        let (began, mut observed) = mpsc::unbounded_channel();
        let (_open, gate) = watch::channel(false);
        owner
            .launch(async {
                Ok(JoiningNode {
                    inner,
                    began,
                    release_join: gate,
                    fail: false,
                })
            })
            .unwrap();
        owner.enqueue("held-peer".into()).unwrap();
        observed.recv().await.unwrap();
        owner.enqueue("must-not-dial".into()).unwrap();
        assert!(owner.status().await.is_ok());
        assert_eq!(owner.phase(), Phase::Ready);
        owner.stop();
        stopped.await.unwrap();
        assert!(owner.finishing_join());
        release.send(()).unwrap();
        wait_stopped(&owner).await;
        assert!(observed.recv().await.is_none());
    }

    #[tokio::test]
    async fn repeated_pending_and_inflight_targets_are_coalesced_and_can_retry() {
        let owner = Lifecycle::default();
        let (inner, stopped, release, _) = fixture();
        let (began, mut observed) = mpsc::unbounded_channel();
        let (open, gate) = watch::channel(false);
        let (start, startup) = oneshot::channel();
        owner
            .launch(async move {
                startup.await?;
                Ok(JoiningNode {
                    inner,
                    began,
                    release_join: gate,
                    fail: true,
                })
            })
            .unwrap();
        for _ in 0..100 {
            owner.enqueue("same-peer".into()).unwrap();
        }
        assert_eq!(owner.slot.lock().unwrap().pending_tokens.len(), 1);
        start.send(()).unwrap();
        observed.recv().await.unwrap();
        for _ in 0..100 {
            owner.enqueue("same-peer".into()).unwrap();
        }
        assert_eq!(owner.slot.lock().unwrap().pending_tokens.len(), 1);
        open.send(true).unwrap();
        while owner
            .slot
            .lock()
            .unwrap()
            .pending_tokens
            .contains("same-peer")
        {
            tokio::task::yield_now().await;
        }
        // Completion is the barrier: no duplicate queued work remains.
        assert!(observed.try_recv().is_err());
        owner.enqueue("same-peer".into()).unwrap();
        observed.recv().await.unwrap();
        owner.stop();
        stopped.await.unwrap();
        release.send(()).unwrap();
        wait_stopped(&owner).await;
        assert!(owner.slot.lock().unwrap().pending_tokens.is_empty());
    }

    #[tokio::test]
    async fn serving_requires_ready_worker_and_clears_on_stop_or_failure() {
        let owner = Lifecycle::default();
        let (node, stopped, release, _) = fixture();
        let (enter, gate) = oneshot::channel();
        owner
            .launch_role(
                async move {
                    gate.await?;
                    Ok(node)
                },
                true,
            )
            .unwrap();
        assert!(!owner.is_serving());
        enter.send(()).unwrap();
        while owner.phase() == Phase::Starting {
            tokio::task::yield_now().await;
        }
        assert!(owner.is_serving());
        owner.stop();
        stopped.await.unwrap();
        assert!(!owner.is_serving());
        release.send(()).unwrap();
        wait_stopped(&owner).await;
        owner
            .launch_role(
                async { Err::<FakeNode, _>(anyhow::anyhow!("load failed")) },
                true,
            )
            .unwrap();
        while owner.phase() == Phase::Starting {
            tokio::task::yield_now().await;
        }
        assert!(matches!(owner.phase(), Phase::Failed(_)));
        assert!(!owner.is_serving());
    }
    #[tokio::test]
    async fn observer_sees_ready_then_stop_outside_slot_lock_and_failure_before_replacement() {
        let owner = Lifecycle::default();
        let (node, stopped, release, _) = fixture();
        let (events, mut observed) = mpsc::unbounded_channel();
        let slot = owner.slot.clone();
        owner
            .launch_observed(
                async { Ok(node) },
                true,
                Arc::new(move |phase| {
                    assert!(
                        slot.try_lock().is_ok(),
                        "observer cannot run under the slot lock"
                    );
                    events.send(phase).unwrap();
                }),
            )
            .unwrap();
        assert_eq!(observed.recv().await, Some(Phase::Ready));
        owner.stop();
        stopped.await.unwrap();
        release.send(()).unwrap();
        assert_eq!(observed.recv().await, Some(Phase::Stopped));
        let (events, mut observed) = mpsc::unbounded_channel();
        owner
            .launch_observed(
                async { Err::<FakeNode, _>(anyhow::anyhow!("load failed")) },
                true,
                Arc::new(move |phase| {
                    events.send(phase).unwrap();
                }),
            )
            .unwrap();
        assert_eq!(
            observed.recv().await,
            Some(Phase::Failed("load failed".into()))
        );
        assert!(owner
            .start(ClientConfig {
                api_port: 1,
                console_port: 2,
                owner_key: std::env::temp_dir().join("fixture"),
                owner_id: "fixture".into(),
                trusted_owners: vec!["fixture".into()],
                join_token: None,
                mesh_name: None,
            })
            .is_err());
    }

    async fn wait_stopped(owner: &Lifecycle) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while owner.phase() != Phase::Stopped {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn status_reads_the_owned_node_only_after_start_and_rejects_after_stop() {
        let owner = Lifecycle::default();
        assert_eq!(owner.generation(), 0);
        assert!(owner.status().await.is_err());
        let (node, stopped, release, mut joined) = fixture();
        owner.launch(async { Ok(node) }).unwrap();
        assert_eq!(owner.generation(), 1);
        owner.enqueue("ready-barrier".into()).unwrap();
        joined.recv().await.unwrap();
        assert_eq!(
            owner.status().await.unwrap().payload["hosted_models"][0],
            "fixture-model"
        );
        owner.stop();
        stopped.await.unwrap();
        assert!(owner.status().await.is_err());
        release.send(()).unwrap();
        wait_stopped(&owner).await;
        let (node, stopped, release, mut joined) = fixture();
        owner.launch(async { Ok(node) }).unwrap();
        assert_eq!(owner.generation(), 2);
        owner.enqueue("ready-barrier".into()).unwrap();
        joined.recv().await.unwrap();
        owner.stop();
        stopped.await.unwrap();
        release.send(()).unwrap();
        wait_stopped(&owner).await;
    }

    #[tokio::test]
    async fn stop_during_start_retains_worker_and_blocks_replacement_until_shutdown() {
        let owner = Lifecycle::default();
        let (node, stopped, release, _) = fixture();
        let (start, gate) = oneshot::channel();
        owner
            .launch(async {
                gate.await?;
                Ok(node)
            })
            .unwrap();
        owner.stop();
        assert_eq!(owner.phase(), Phase::Stopping);
        let (rejected, _, _, _) = fixture();
        assert!(owner.launch(async { Ok(rejected) }).is_err());
        start.send(()).unwrap();
        stopped.await.unwrap();
        assert_eq!(owner.phase(), Phase::Stopping);
        let (next, _, _, _) = fixture();
        assert!(owner.launch(async { Ok(next) }).is_err());
        release.send(()).unwrap();
        wait_stopped(&owner).await;
        let (next, stopped, release, _) = fixture();
        owner.launch(async { Ok(next) }).unwrap();
        owner.stop();
        stopped.await.unwrap();
        release.send(()).unwrap();
        wait_stopped(&owner).await;
    }
    #[tokio::test]
    async fn queued_dial_is_delivered_after_start_and_failed_shutdown_blocks_restart() {
        let owner = Lifecycle::default();
        let (node, stopped, release, mut joined) = fixture();
        let (start, gate) = oneshot::channel();
        owner
            .launch(async {
                gate.await?;
                Ok(node)
            })
            .unwrap();
        owner.enqueue("host-validated-token".into()).unwrap();
        start.send(()).unwrap();
        assert_eq!(joined.recv().await.as_deref(), Some("host-validated-token"));
        owner.stop();
        stopped.await.unwrap();
        drop(release);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !matches!(owner.phase(), Phase::Failed(_)) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let (next, _, _, _) = fixture();
        assert!(owner.launch(async { Ok(next) }).is_err());
    }
    #[tokio::test(start_paused = true)]
    async fn ready_stop_timeout_never_permits_replacement() {
        let owner = Lifecycle::default();
        let (node, stopped, _release, mut joined) = fixture();
        owner.launch(async { Ok(node) }).unwrap();
        owner.enqueue("barrier".into()).unwrap();
        joined.recv().await.unwrap();
        assert_eq!(owner.phase(), Phase::Ready);
        owner.stop();
        stopped.await.unwrap();
        tokio::time::advance(MESH_STOP_TIMEOUT).await;
        while !matches!(owner.phase(), Phase::Failed(_)) {
            tokio::task::yield_now().await;
        }
        let (next, _, _, _) = fixture();
        assert!(owner.launch(async { Ok(next) }).is_err());
    }
}

#[cfg(test)]
mod embedded_join_test {
    use super::*;
    #[tokio::test]
    #[ignore = "isolated real SDK test; requires BUZZ_MESH_JOIN_TEST=1 and sanitized environment"]
    async fn real_embedded_unreachable_join_keeps_status_and_stops() {
        assert_eq!(std::env::var("BUZZ_MESH_JOIN_TEST").as_deref(), Ok("1"));
        assert_eq!(std::env::var("BUZZ_MESH_IROH_RELAYS").as_deref(), Ok("0"));
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("owner.json");
        let owner = crate::identity::ensure_owner_at(&path).unwrap();
        let first = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let second = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let api_port = first.local_addr().unwrap().port();
        let console_port = second.local_addr().unwrap().port();
        let request = ClientConfig {
            api_port,
            console_port,
            owner_key: path,
            owner_id: owner.clone(),
            trusted_owners: vec![owner],
            join_token: None,
            mesh_name: Some("isolated-buzz-join-regression".into()),
        };
        drop((first, second));
        let runtime = Lifecycle::default();
        runtime.start(request).unwrap();
        let ready = tokio::time::timeout(Duration::from_secs(30), async {
            while runtime.phase() == Phase::Starting {
                tokio::task::yield_now().await;
            }
            assert_eq!(runtime.phase(), Phase::Ready);
        })
        .await;
        if ready.is_err() {
            let _ = runtime.stop_and_wait().await;
        }
        ready.unwrap();
        let dead = crate::transport_policy::endpoint_token_for_test([iroh::TransportAddr::Ip(
            ([127, 0, 0, 1], 9).into(),
        )]);
        // Exercise the worker/SDK directly; public discovery intentionally rejects loopback.
        runtime.enqueue(dead).unwrap();
        while !runtime.slot.lock().unwrap().joining {
            tokio::task::yield_now().await;
        }
        let status = tokio::time::timeout(Duration::from_secs(12), runtime.status()).await;
        let stopped = runtime.stop_and_wait().await;
        assert!(status.unwrap().is_ok());
        stopped.unwrap();
        assert_eq!(runtime.phase(), Phase::Stopped);
        for port in [api_port, console_port] {
            std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
        }
    }
}
