//! Retained download progress for the app-owned worker, using the SDK's output sink.
use mesh_llm_events::{ConsoleSessionMode, ModelProgressStatus, OutputEvent, OutputSink};
use std::sync::{Arc, Mutex};

/// Latest byte-level progress; a completed download is not inference readiness.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub label: String,
    pub file: Option<String>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub done: bool,
}

#[derive(Clone, Default)]
pub(crate) struct Progress(Arc<Mutex<Option<DownloadProgress>>>);
impl Progress {
    pub fn latest(&self) -> Option<DownloadProgress> {
        self.0.lock().ok().and_then(|progress| progress.clone())
    }
    pub fn clear(&self) {
        if let Ok(mut progress) = self.0.lock() {
            *progress = None;
        }
    }
    pub fn install(&self) {
        mesh_llm_events::set_output_sink(Arc::new(self.clone()));
    }
}
impl OutputSink for Progress {
    fn emit_event(&self, event: OutputEvent) -> std::io::Result<()> {
        if let OutputEvent::Warning { message, context }
        | OutputEvent::Error { message, context }
        | OutputEvent::Fatal { message, context } = &event
        {
            eprintln!(
                "Mesh runtime {}: {message}{}",
                event.event_name(),
                context
                    .as_ref()
                    .map(|value| format!(": {value}"))
                    .unwrap_or_default()
            );
        }
        if let OutputEvent::ModelDownloadProgress {
            label,
            file,
            downloaded_bytes,
            total_bytes,
            status,
        } = event
        {
            let mut progress = self
                .0
                .lock()
                .map_err(|_| std::io::Error::other("Mesh progress unavailable"))?;
            *progress = Some(DownloadProgress {
                label,
                file,
                downloaded_bytes,
                total_bytes,
                done: matches!(status, ModelProgressStatus::Ready),
            });
        }
        Ok(())
    }
    fn console_session_mode(&self) -> Option<ConsoleSessionMode> {
        Some(ConsoleSessionMode::InteractiveDashboard)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retains_bytes_and_resets_between_workers_without_claiming_node_readiness() {
        let progress = Progress::default();
        for status in [ModelProgressStatus::Downloading, ModelProgressStatus::Ready] {
            let done = matches!(status, ModelProgressStatus::Ready);
            progress
                .emit_event(OutputEvent::ModelDownloadProgress {
                    label: "fixture".into(),
                    file: Some("weights.gguf".into()),
                    downloaded_bytes: Some(64),
                    total_bytes: Some(128),
                    status,
                })
                .unwrap();
            let latest = progress.latest().unwrap();
            assert_eq!(latest.downloaded_bytes, Some(64));
            assert_eq!(latest.total_bytes, Some(128));
            assert_eq!(latest.done, done);
        }
        progress.clear();
        assert!(progress.latest().is_none());
        assert_eq!(
            progress.console_session_mode(),
            Some(ConsoleSessionMode::InteractiveDashboard)
        );
    }
}
