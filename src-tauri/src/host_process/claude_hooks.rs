//! Claude's callback timeout otherwise keeps the original result. A native
//! deadline kills the entire worker even when its frontend stops responding.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::oneshot, time::Instant};
const DEADLINE: Duration = Duration::from_secs(350);
/// Why the guard refuses a worker it stopped, or input to one that exited.
pub(super) const STOPPED: &str = "The protected Claude worker stopped";
// Only watchdog metadata is decoded. Large model/tool fields are skipped by
// serde while the complete line lives in an anonymous private temporary file.
#[derive(serde::Deserialize)]
struct ControlFrame {
    #[serde(rename = "type", default)]
    kind: String,
    request_id: Option<String>,
    request: Option<ControlRequest>,
    response: Option<ControlResponse>,
}
#[derive(serde::Deserialize)]
struct ControlRequest {
    subtype: Option<String>,
    callback_id: Option<String>,
}
#[derive(serde::Deserialize)]
struct ControlResponse {
    request_id: Option<String>,
    subtype: Option<String>,
    response: Option<ResponseObject>,
}
struct ResponseObject;
impl<'de> serde::Deserialize<'de> for ResponseObject {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = ResponseObject;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                while map
                    .next_entry::<serde::de::IgnoredAny, serde::de::IgnoredAny>()?
                    .is_some()
                {}
                Ok(ResponseObject)
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}
#[derive(Default)]
struct Frames {
    file: Option<std::fs::File>,
    nonempty: bool,
    generation: u64,
    deadline: Option<Instant>,
    cancel: Option<oneshot::Sender<()>>,
}
impl Frames {
    fn push(&mut self, data: &[u8], now: Instant) -> Result<Vec<ControlFrame>, String> {
        use std::io::{Seek, SeekFrom, Write};
        let mut frames = Vec::new();
        for part in data.split_inclusive(|byte| *byte == b'\n') {
            if self.file.is_none() {
                self.file =
                    Some(tempfile::tempfile().map_err(|_| "Cannot spool Claude control frame")?);
                self.generation = self.generation.wrapping_add(1);
                self.deadline = Some(now + DEADLINE);
            }
            if self.deadline.is_some_and(|deadline| deadline <= now) {
                return Err("Incomplete Claude control frame expired".into());
            }
            self.nonempty |= part.iter().any(|byte| !byte.is_ascii_whitespace());
            self.file
                .as_mut()
                .unwrap()
                .write_all(part)
                .map_err(|_| "Cannot spool Claude control frame")?;
            if part.last() == Some(&b'\n') {
                let mut file = self.file.take().unwrap();
                self.deadline = None;
                self.cancel = None;
                if self.nonempty {
                    file.seek(SeekFrom::Start(0))
                        .map_err(|_| "Cannot read Claude control frame")?;
                    let frame: ControlFrame =
                        serde_json::from_reader(std::io::BufReader::new(file))
                            .map_err(|_| "Invalid protected Claude frame")?;
                    frames.push(frame);
                }
                self.nonempty = false;
            }
        }
        Ok(frames)
    }
}

struct Pending {
    deadline: Instant,
    _cancel: oneshot::Sender<()>,
}
#[derive(Default)]
struct State {
    output: Frames,
    input: Frames,
    pending: HashMap<String, Pending>,
    failed: bool,
    /// Nothing is left to kill or answer, but its last output still drains.
    exited: bool,
}
#[derive(Clone)]
pub(super) struct ClaudeHooks {
    state: Arc<Mutex<State>>,
    #[cfg_attr(not(unix), allow(dead_code))]
    group: u32,
}
impl ClaudeHooks {
    pub fn new(group: u32) -> Self {
        Self {
            state: Arc::default(),
            group,
        }
    }
    pub fn close(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.exited = true;
        state.pending.clear();
        state.input = Frames::default();
        state.output = Frames::default();
    }
    pub fn trip(&self) {
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.failed || state.exited {
                return;
            }
            state.failed = true;
            state.pending.clear();
            state.input = Frames::default();
            state.output = Frames::default();
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.group as i32), libc::SIGKILL);
        }
    }
    pub fn output(&self, data: &[u8]) -> Result<(), String> {
        self.observe(data, true)
    }
    pub fn input(&self, data: &[u8]) -> Result<(), String> {
        self.observe(data, false)
    }
    fn observe(&self, data: &[u8], output: bool) -> Result<(), String> {
        self.observe_at(data, output, Instant::now())
    }
    fn observe_at(&self, data: &[u8], output: bool, now: Instant) -> Result<(), String> {
        let mut timers = Vec::new();
        let mut frame_timer = None;
        let result = (|| {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.failed || (state.exited && !output) {
                return Err(STOPPED.into());
            }
            if state.exited {
                return Ok(());
            }
            let buffer = if output {
                &mut state.output
            } else {
                &mut state.input
            };
            let before = buffer.generation;
            let frames = buffer.push(data, now)?;
            if buffer.generation != before {
                if let Some(deadline) = buffer.deadline {
                    let (cancel, cancelled) = oneshot::channel();
                    buffer.cancel = Some(cancel);
                    frame_timer = Some((buffer.generation, deadline, cancelled));
                }
            }
            for frame in frames {
                if output && frame.kind == "control_request" {
                    let Some(request) = frame
                        .request
                        .filter(|request| request.subtype.as_deref() == Some("hook_callback"))
                    else {
                        continue;
                    };
                    let callback = request.callback_id.as_deref().unwrap_or_default();
                    if !matches!(
                        callback,
                        "security-tool"
                            | "security-incoming"
                            | "security-incomplete"
                            | "security-session"
                    ) {
                        continue;
                    }
                    let id = frame
                        .request_id
                        .as_deref()
                        .filter(|id| !id.is_empty() && id.len() <= 4096)
                        .ok_or("Invalid security callback")?
                        .to_string();
                    if state.pending.len() >= 16 || state.pending.contains_key(&id) {
                        return Err("Invalid concurrent security callback".into());
                    }
                    let deadline = now + DEADLINE;
                    let (cancel, cancelled) = oneshot::channel();
                    state.pending.insert(
                        id.clone(),
                        Pending {
                            deadline,
                            _cancel: cancel,
                        },
                    );
                    timers.push((id, deadline, cancelled));
                } else if !output && frame.kind == "control_response" {
                    let Some(response) = frame.response else {
                        continue;
                    };
                    if let Some(id) = response.request_id.as_deref() {
                        if let Some(pending) = state.pending.get(id) {
                            if pending.deadline <= now
                                || response.subtype.as_deref() != Some("success")
                                || response.response.is_none()
                            {
                                return Err(
                                    "A failed or late security callback cannot resume Claude"
                                        .into(),
                                );
                            }
                            state.pending.remove(id);
                        }
                    }
                }
            }
            Ok(())
        })();
        if result.is_err() {
            self.trip();
            return result;
        }
        if let Some((generation, deadline, mut cancelled)) = frame_timer {
            let guard = self.clone();
            tauri::async_runtime::spawn(async move {
                tokio::select! {
                    _ = tokio::time::sleep_until(deadline) => {},
                    _ = &mut cancelled => return,
                }
                let overdue = {
                    let state = guard
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let frame = if output { &state.output } else { &state.input };
                    !state.exited
                        && frame.generation == generation
                        && frame.deadline == Some(deadline)
                };
                if overdue {
                    guard.trip();
                }
            });
        }
        for (id, deadline, mut cancelled) in timers {
            let guard = self.clone();
            tauri::async_runtime::spawn(async move {
                tokio::select! {
                    _=tokio::time::sleep_until(deadline)=>{
                        let overdue=guard.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).pending.get(&id).is_some_and(|pending|pending.deadline==deadline);
                        if overdue {guard.trip();}
                    },
                    _=&mut cancelled=>{},
                }
            });
        }
        result
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    fn request(id: &str) -> Vec<u8> {
        format!("{}\n",serde_json::json!({"type":"control_request","request_id":id,"request":{"subtype":"hook_callback","callback_id":"security-tool"}})).into_bytes()
    }
    fn response(id: &str, subtype: &str) -> Vec<u8> {
        format!("{}\n",serde_json::json!({"type":"control_response","response":{"request_id":id,"subtype":subtype,"response":{}}})).into_bytes()
    }
    fn worker() -> tokio::process::Child {
        let mut command = tokio::process::Command::new("/bin/sleep");
        command.arg("60").kill_on_drop(true);
        command.as_std_mut().process_group(0);
        command.spawn().unwrap()
    }
    #[test]
    fn an_exited_worker_s_output_drains_but_its_input_is_refused() {
        let guard = ClaudeHooks::new(0);
        guard.close();
        assert_eq!(guard.output(&request("late")), Ok(()));
        assert_eq!(guard.input(b"{}\n"), Err(STOPPED.into()));
    }
    #[tokio::test]
    async fn fragmented_responses_cannot_release_a_different_callback() {
        let mut child = worker();
        let guard = ClaudeHooks::new(child.id().unwrap());
        let frame = request("first");
        guard.output(&frame[..8]).unwrap();
        guard.output(&frame[8..]).unwrap();
        guard.input(&response("other", "success")).unwrap();
        assert_eq!(guard.state.lock().unwrap().pending.len(), 1);
        guard.input(&response("first", "success")).unwrap();
        assert!(guard.state.lock().unwrap().pending.is_empty());
        assert!(child.try_wait().unwrap().is_none());
        guard.close();
        child.kill().await.unwrap();
    }
    #[tokio::test]
    async fn large_review_frames_remain_guarded_and_incomplete_frames_expire() {
        let mut child = worker();
        let guard = ClaudeHooks::new(child.id().unwrap());
        let mut frame: serde_json::Value = serde_json::from_slice(&request("large")).unwrap();
        frame["request"]["input"] = serde_json::json!({"prompt": "x".repeat(20 * 1024 * 1024)});
        let mut frame = serde_json::to_vec(&frame).unwrap();
        frame.push(b'\n');
        guard.output(&frame).unwrap();
        assert_eq!(guard.state.lock().unwrap().pending.len(), 1);
        guard.input(&response("large", "success")).unwrap();
        assert!(guard.state.lock().unwrap().pending.is_empty());
        assert!(child.try_wait().unwrap().is_none());
        let now = Instant::now();
        guard.observe_at(b"{", true, now).unwrap();
        assert!(guard.observe_at(b" ", true, now + DEADLINE).is_err());
        assert!(!tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success());
    }
    #[tokio::test]
    async fn failed_or_late_callback_kills_the_worker() {
        for late in [false, true] {
            let mut child = worker();
            let guard = ClaudeHooks::new(child.id().unwrap());
            guard.output(&request("review")).unwrap();
            let result = if late {
                guard.observe_at(
                    &response("review", "success"),
                    false,
                    Instant::now() + DEADLINE,
                )
            } else {
                guard.input(&response("review", "error"))
            };
            assert!(result.is_err());
            assert!(!tokio::time::timeout(Duration::from_secs(5), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success());
        }
    }
    #[tokio::test]
    async fn native_timeout_needs_no_frontend_response() {
        let mut child = worker();
        let guard = ClaudeHooks::new(child.id().unwrap());
        guard
            .observe_at(&request("stalled"), true, Instant::now() - DEADLINE)
            .unwrap();
        assert!(!tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success());
    }
}
