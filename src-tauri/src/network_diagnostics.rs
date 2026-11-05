//! Local metadata only. No request/response bodies, headers, or raw errors enter this store.
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
mod context;
mod session_file;
mod traffic;
use std::sync::atomic::{AtomicU64, Ordering};
static CAPTURE: AtomicU64 = AtomicU64::new(0);
pub(crate) fn collecting() -> bool {
    CAPTURE.load(Ordering::Relaxed) & 7 != 0
}
pub(crate) fn enabled(level: Level) -> bool {
    let observed = CAPTURE.load(Ordering::Relaxed);
    let mut current = observed & 7;
    if current >= Level::Debug as u64 && observed >> 3 != 0 && timestamp() >= observed >> 3 {
        // Expiry and level share one atomic state: stale expiry cannot re-enable
        // a disabled recorder or overwrite a concurrent reconfiguration.
        current = match CAPTURE.compare_exchange(
            observed,
            Level::Info as u64,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => Level::Info as u64,
            Err(actual) => actual & 7,
        };
    }
    current != 0 && current >= level as u64
}
pub(crate) fn frame(relay: &str, outgoing: bool, bytes: usize) {
    if !collecting() {
        return;
    }
    let mut store = recorder();
    if store.active && store.level != Level::Silent {
        store
            .traffic_counts
            .frame(relay, outgoing, bytes, timestamp());
    }
}
pub(crate) use context::{in_context, Context};
use session_file::SessionFile;

// Native integration tests share the process capture level.
#[cfg(test)]
pub(crate) static CAPTURE_TEST: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, PartialOrd)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Level {
    Silent,
    Error,
    Warn,
    #[default]
    Info,
    Debug,
    Trace,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    sequence: u64,
    at: u64,
    level: Level,
    phase: &'static str,
    outcome: &'static str,
    relay: String,
    connection: Option<String>,
    operation: String,
    ms: u64,
    status: Option<u16>,
    queued: Option<usize>,
    reason: Option<&'static str>,
    operation_id: Option<String>,
    error: Option<context::SafeError>,
    frame_sequence: Option<u64>,
    bytes: Option<usize>,
    queue_ms: Option<u64>,
}
#[derive(Default)]
struct Recorder {
    active: bool,
    directory: Option<std::path::PathBuf>,
    traffic_counts: traffic::Traffic,
    level: Level,
    expiry: Option<Instant>,
    sequence: u64,
    dropped: u64,
    lifecycle: VecDeque<Event>,
    traffic: VecDeque<Event>,
    archive: Option<SessionFile>,
    archive_error: Option<String>,
}
impl Recorder {
    fn effective_level(&mut self) -> Level {
        if self.expiry.is_some_and(|expiry| Instant::now() >= expiry) {
            self.level = Level::Info;
            self.expiry = None;
        }
        self.level
    }
    fn record(&mut self, mut event: Event) {
        if !self.active || event.level > self.effective_level() {
            return;
        }
        self.sequence += 1;
        event.sequence = self.sequence;
        if let Some(archive) = &self.archive {
            let _ = archive.append(vec![
                serde_json::json!({ "source": "native", "event": event }),
            ]);
        }
        let (list, limit) = if event.level >= Level::Debug {
            (&mut self.traffic, 1500)
        } else {
            (&mut self.lifecycle, 500)
        };
        list.push_back(event);
        if list.len() > limit {
            list.pop_front();
            self.dropped += 1;
        }
    }
}

pub(crate) fn initialize<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let mut store = recorder();
    match app.path().app_data_dir() {
        Ok(directory) => store.directory = Some(directory.join("network-diagnostics")),
        Err(_) => store.archive_error = Some("Session log directory unavailable".into()),
    }
}

fn session_file() -> Result<SessionFile, String> {
    let store = recorder();
    store.archive.clone().ok_or_else(|| {
        store
            .archive_error
            .clone()
            .unwrap_or_else(|| "Session log unavailable".into())
    })
}

pub(crate) fn flush_on_exit() {
    if let Ok(archive) = session_file() {
        let _ = archive.flush();
    }
}
fn recorder() -> std::sync::MutexGuard<'static, Recorder> {
    static STORE: OnceLock<Mutex<Recorder>> = OnceLock::new();
    STORE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Records starts and completion across early returns and cancellation. Each
/// network owner keeps its existing error/result semantics.
pub(crate) struct Phase {
    started: Option<Instant>,
    event: Option<Event>,
    pub(crate) ok: bool,
    pub(crate) status: Option<u16>,
    pub(crate) queued: Option<usize>,
    pub(crate) reason: Option<&'static str>,
    pub(crate) frame_sequence: Option<u64>,
    pub(crate) bytes: Option<usize>,
    pub(crate) queue_ms: Option<u64>,
}
impl Phase {
    pub(crate) fn new(
        phase: &'static str,
        relay: &str,
        connection: Option<&str>,
        level: Level,
    ) -> Self {
        Self::with_context(phase, relay, connection, level, None)
    }
    pub(crate) fn with_context(
        phase: &'static str,
        relay: &str,
        connection: Option<&str>,
        level: Level,
        context: Option<&Context>,
    ) -> Self {
        if !enabled(level) {
            return Self {
                started: None,
                event: None,
                ok: false,
                status: None,
                queued: None,
                reason: None,
                frame_sequence: None,
                bytes: None,
                queue_ms: None,
            };
        }
        let event = Event {
            sequence: 0,
            at: timestamp(),
            level,
            phase,
            outcome: "started",
            relay: url::Url::parse(relay)
                .ok()
                .map(|url| url.origin().ascii_serialization())
                .unwrap_or_else(|| "unknown-relay".into()),
            connection: connection.map(str::to_owned),
            operation: uuid::Uuid::new_v4().to_string(),
            ms: 0,
            status: None,
            queued: None,
            reason: None,
            operation_id: context
                .map(|context| context.operation_id.clone())
                .or_else(context::operation_id),
            error: None,
            frame_sequence: None,
            bytes: None,
            queue_ms: None,
        };
        recorder().record(event.clone());
        Self {
            started: Some(Instant::now()),
            event: Some(event),
            ok: false,
            status: None,
            queued: None,
            reason: None,
            frame_sequence: None,
            bytes: None,
            queue_ms: None,
        }
    }
    pub(crate) fn http_error(&mut self, error: &reqwest::Error) {
        if enabled(Level::Debug) {
            if let Some(event) = &mut self.event {
                event.error = Some(context::SafeError::http(error));
            }
        }
    }
    pub(crate) fn socket_error(&mut self, error: &tokio_tungstenite::tungstenite::Error) {
        if enabled(Level::Debug) {
            if let Some(event) = &mut self.event {
                event.error = Some(context::SafeError::transport(error));
            }
        }
    }
}
impl Drop for Phase {
    fn drop(&mut self) {
        let Some(event) = &mut self.event else {
            return;
        };
        let Some(started) = self.started else {
            return;
        };
        if !collecting() {
            return;
        }
        event.at = timestamp();
        event.ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        event.outcome = if self.ok {
            "completed"
        } else {
            "failed-or-cancelled"
        };
        event.status = self.status;
        event.queued = self.queued;
        event.reason = self.reason;
        event.frame_sequence = self.frame_sequence;
        event.bytes = self.bytes;
        event.queue_ms = self.queue_ms;
        if !self.ok {
            event.level = Level::Warn;
            if event.error.is_none() {
                event.error = Some(context::SafeError::local(
                    self.reason.unwrap_or("failed-or-cancelled"),
                ));
            }
        }
        recorder().record(event.clone());
    }
}
pub(crate) fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}
pub(crate) fn http_failure(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_body() {
        "body"
    } else {
        "transport"
    }
}

#[tauri::command]
pub(crate) fn network_diagnostics_configure(
    level: Level,
    enabled: Option<bool>,
    reset_at: Option<u64>,
) -> Result<(), String> {
    let expiry = reset_at
        .map(|until| {
            if until == 0 || until > 8_640_000_000_000_000 {
                return Err("Invalid capture reset time");
            }
            Instant::now()
                .checked_add(Duration::from_millis(until.saturating_sub(timestamp())))
                .ok_or("Invalid capture reset time")
        })
        .transpose()?;
    let mut store = recorder();
    let active = enabled.unwrap_or(store.active);
    if !active {
        CAPTURE.store(0, Ordering::Relaxed);
    }
    if active && store.archive.is_none() {
        if let Some(directory) = &store.directory {
            store.archive = Some(SessionFile::start(directory)?);
        } else if let Some(error) = &store.archive_error {
            return Err(error.clone());
        }
    }
    if active && level != Level::Silent && (!store.active || store.level == Level::Silent) {
        store.traffic_counts = Default::default();
    }
    store.active = active;
    store.level = level;
    store.expiry = if active && level >= Level::Debug {
        expiry
    } else {
        None
    };
    let mode = if !active {
        0
    } else if level >= Level::Debug {
        (reset_at.unwrap_or(0) << 3) | level as u64
    } else {
        level as u64
    };
    CAPTURE.store(mode, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub(crate) fn network_diagnostics_read(recent: Option<bool>) -> serde_json::Value {
    let mut store = recorder();
    let level = store.effective_level();
    let mut events: Vec<_> = if recent == Some(false) {
        Vec::new()
    } else {
        store
            .lifecycle
            .iter()
            .chain(&store.traffic)
            .cloned()
            .collect()
    };
    events.sort_by_key(|event| event.sequence);
    let archive = serde_json::json!({
        "path": store.archive.as_ref().map(|archive| archive.path.to_string_lossy()),
        "error": store.archive_error.clone().or_else(|| store.archive.as_ref().and_then(SessionFile::error)),
    });
    let traffic = store.traffic_counts.snapshot(timestamp());
    let writer = store.archive.as_ref().map(SessionFile::backlog);
    serde_json::json!({ "active":store.active, "traffic":traffic, "writer":writer, "level": level, "dropped": store.dropped, "events": events, "archive": archive, "platform": std::env::consts::OS, "version": env!("CARGO_PKG_VERSION") })
}
#[tauri::command]
pub(crate) async fn network_diagnostics_clear() -> Result<(), String> {
    let archive = session_file()?;
    let received = {
        let mut store = recorder();
        // Enqueue the disk cutoff while holding the same lock as record().
        // Records arriving afterward survive in both file and recent history.
        let received = archive.clear()?;
        store.lifecycle.clear();
        store.traffic.clear();
        store.dropped = 0;
        store.traffic_counts = Default::default();
        received
    };
    tauri::async_runtime::spawn_blocking(move || {
        received
            .recv()
            .map_err(|_| "Session log writer stopped".to_owned())
    })
    .await
    .map_err(|_| "Session log writer stopped")??
}

#[tauri::command]
pub(crate) fn network_diagnostics_append(events: Vec<serde_json::Value>) -> Result<(), String> {
    if !collecting() {
        return Ok(());
    }
    // Limit each IPC batch, not the session history. Only existing metadata
    // fields cross this main-window-only boundary; no file paths or raw bodies.
    if events.len() > 64
        || events.iter().any(|event| {
            event.as_object().is_none_or(|fields| {
                fields.keys().any(|key| {
                    !matches!(
                        key.as_str(),
                        "sequence"
                            | "at"
                            | "level"
                            | "event"
                            | "relay"
                            | "connection"
                            | "reason"
                            | "ms"
                            | "status"
                            | "bytes"
                            | "count"
                            | "delayMs"
                            | "attempt"
                            | "shown"
                            | "recovering"
                            | "sources"
                            | "detail"
                            | "reauthorized"
                            | "operationId"
                            | "parentId"
                            | "consumerId"
                            | "owner"
                            | "phase"
                            | "outcome"
                            | "cancellation"
                            | "deadlineMs"
                            | "dueAt"
                            | "latenessMs"
                            | "nativeAt"
                            | "frameSequence"
                            | "subscriptionId"
                            | "error"
                            | "metrics"
                    )
                })
            }) || event.to_string().len() > 16 * 1024
        })
    {
        return Err("Invalid diagnostics metadata".into());
    }
    let archive = session_file()?;
    let events = events
        .into_iter()
        .map(|event| serde_json::json!({"source":"client", "event":event}))
        .collect();
    archive.append(events)
}

#[tauri::command]
pub(crate) async fn network_diagnostics_export<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<String, String> {
    let directory = app
        .path()
        .download_dir()
        .map_err(|_| "Downloads unavailable")?;
    let archive = session_file()?;
    let metadata = serde_json::json!({
        "version": 2, "host": "desktop", "exportedAt": timestamp(),
        "platform": std::env::consts::OS, "appVersion": env!("CARGO_PKG_VERSION"),
        "level": recorder().effective_level(),
    });
    tauri::async_runtime::spawn_blocking(move || archive.export(directory, metadata))
        .await
        .map_err(|_| "Session log writer stopped")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(level: Level) -> Event {
        Event {
            sequence: 0,
            at: 0,
            level,
            phase: "test",
            outcome: "completed",
            relay: "https://relay.test".into(),
            connection: None,
            operation: "operation".into(),
            ms: 0,
            status: None,
            queued: None,
            reason: None,
            operation_id: None,
            error: None,
            frame_sequence: None,
            bytes: None,
            queue_ms: None,
        }
    }
    #[tokio::test]
    async fn disabled_capture_is_lazy_and_info_counts_frames_without_detailed_records() {
        let _capture = CAPTURE_TEST.lock().await;
        let directory = tempfile::tempdir().unwrap();
        {
            let mut store = recorder();
            store.directory = Some(directory.path().join("logs"));
            store.archive = None;
        }
        network_diagnostics_configure(Level::Info, Some(false), None).unwrap();
        frame("relay.test", true, 10);
        drop(Phase::new(
            "disabled",
            "wss://relay.test",
            None,
            Level::Info,
        ));
        assert!(!directory.path().join("logs").exists());
        network_diagnostics_configure(Level::Info, Some(true), None).unwrap();
        frame("relay.test", true, 10);
        frame("relay.test", false, 20);
        let mut phase = Phase::new("socket.write", "wss://relay.test", None, Level::Debug);
        assert!(phase.event.is_none());
        phase.ok = true;
        drop(phase);
        let snapshot = network_diagnostics_read(None);
        assert_eq!(snapshot["traffic"][0]["session"]["txFrames"], 1);
        assert_eq!(snapshot["traffic"][0]["session"]["rxBytes"], 20);
        let archive = session_file().unwrap();
        archive.flush().unwrap();
        assert_eq!(std::fs::metadata(&archive.path).unwrap().len(), 0);
        network_diagnostics_configure(Level::Info, Some(false), None).unwrap();
        frame("relay.test", true, 30);
        assert_eq!(
            network_diagnostics_read(None)["traffic"][0]["session"]["txFrames"],
            1
        );
        let mut store = recorder();
        store.archive = None;
        store.directory = None;
    }

    #[test]
    fn traffic_is_bounded_without_evicting_lifecycle_and_expiry_stops_detail() {
        let mut store = Recorder {
            active: true,
            level: Level::Trace,
            ..Default::default()
        };
        store.record(event(Level::Warn));
        for _ in 0..1600 {
            store.record(event(Level::Debug));
        }
        assert_eq!(store.traffic.len(), 1500);
        assert_eq!(store.lifecycle.len(), 1);
        assert_eq!(store.dropped, 100);
        store.expiry = Some(Instant::now());
        store.record(event(Level::Trace));
        assert_eq!(store.traffic.len(), 1500);
        assert!(store.level == Level::Info);
        store.level = Level::Silent;
        store.record(event(Level::Error));
        assert_eq!(store.lifecycle.len(), 1);
    }

    #[tokio::test]
    async fn capture_gate_expires_detail_and_respects_disable_and_reconfiguration() {
        let _capture = CAPTURE_TEST.lock().await;
        network_diagnostics_configure(Level::Debug, Some(true), None).unwrap();
        assert_eq!(CAPTURE.load(Ordering::Relaxed) >> 3, 0);
        assert!(enabled(Level::Debug));
        assert_eq!(network_diagnostics_read(Some(false))["level"], "debug");
        let until = timestamp() + 120_000;
        network_diagnostics_configure(Level::Trace, Some(true), Some(until)).unwrap();
        assert_eq!(CAPTURE.load(Ordering::Relaxed) >> 3, until);
        assert!(enabled(Level::Trace));
        network_diagnostics_configure(Level::Trace, Some(true), None).unwrap();
        assert!(recorder().expiry.is_none());
        assert!(enabled(Level::Trace));
        assert!(network_diagnostics_configure(Level::Trace, Some(true), Some(0)).is_err());
        assert!(network_diagnostics_configure(Level::Trace, Some(true), Some(u64::MAX)).is_err());
        assert!(enabled(Level::Trace));
        network_diagnostics_configure(Level::Trace, Some(true), Some(timestamp() - 1)).unwrap();
        assert!(!enabled(Level::Trace));
        assert_eq!(network_diagnostics_read(Some(false))["level"], "info");
        CAPTURE.store(
            ((timestamp() - 1) << 3) | Level::Debug as u64,
            Ordering::Relaxed,
        );
        assert!(!enabled(Level::Debug));
        assert!(enabled(Level::Info));
        assert!(collecting());
        CAPTURE.store(0, Ordering::Relaxed);
        assert!(!enabled(Level::Info));
        assert!(!collecting());
        CAPTURE.store(
            ((timestamp() + 900_000) << 3) | Level::Trace as u64,
            Ordering::Relaxed,
        );
        assert!(enabled(Level::Trace));
        assert!(collecting());
        network_diagnostics_configure(Level::Info, Some(false), None).unwrap();
    }

    #[test]
    fn session_export_keeps_evicted_records_and_clear_does_not_touch_earlier_sessions() {
        let directory = tempfile::tempdir().unwrap();
        let archive = SessionFile::start(directory.path()).unwrap();
        let previous = SessionFile::start(directory.path()).unwrap();
        previous
            .append(vec![
                serde_json::json!({"source":"client","event":{"event":"previous-launch"}}),
            ])
            .unwrap();
        previous.flush().unwrap();
        let mut store = Recorder {
            active: true,
            level: Level::Debug,
            archive: Some(archive.clone()),
            ..Default::default()
        };
        store.record(event(Level::Warn));
        for _ in 0..2100 {
            store.record(event(Level::Debug));
        }
        archive
            .append(vec![
                serde_json::json!({"source":"client","event":{"event":"last-client-event"}}),
            ])
            .unwrap();
        assert_eq!(store.traffic.len(), 1500);
        let path = archive
            .export(
                directory.path().to_owned(),
                serde_json::json!({"version":2}),
            )
            .unwrap();
        let report: serde_json::Value =
            serde_json::from_reader(std::fs::File::open(&path).unwrap()).unwrap();
        let events = report["events"].as_array().unwrap();
        assert_eq!(events.len(), 2102);
        assert_eq!(events[0]["event"]["level"], "warn");
        assert_eq!(events[2100]["event"]["sequence"], 2101);
        assert_eq!(events[2101]["event"]["event"], "last-client-event");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&archive.path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        archive.clear().unwrap().recv().unwrap().unwrap();
        archive
            .append(vec![
                serde_json::json!({"source":"client","event":{"event":"after-clear"}}),
            ])
            .unwrap();
        let cleared = archive
            .export(
                directory.path().to_owned(),
                serde_json::json!({"version":2}),
            )
            .unwrap();
        let report: serde_json::Value =
            serde_json::from_reader(std::fs::File::open(cleared).unwrap()).unwrap();
        assert_eq!(report["events"].as_array().unwrap().len(), 1);
        assert_eq!(report["events"][0]["event"]["event"], "after-clear");
        assert!(std::fs::read_to_string(&previous.path)
            .unwrap()
            .contains("previous-launch"));
        assert!(std::fs::metadata(path).unwrap().len() > 0);
    }

    #[test]
    fn unavailable_directories_fail_without_removing_the_session() {
        let directory = tempfile::tempdir().unwrap();
        let blocked = directory.path().join("file");
        std::fs::write(&blocked, "not a directory").unwrap();
        assert!(SessionFile::start(&blocked).is_err());
        let archive = SessionFile::start(directory.path()).unwrap();
        archive
            .append(vec![
                serde_json::json!({"source":"client","event":{"event":"retained"}}),
            ])
            .unwrap();
        assert!(archive
            .export(blocked, serde_json::json!({"version":2}))
            .is_err());
        let path = archive
            .export(
                directory.path().to_owned(),
                serde_json::json!({"version":2}),
            )
            .unwrap();
        assert!(std::fs::read_to_string(path).unwrap().contains("retained"));
    }
}
