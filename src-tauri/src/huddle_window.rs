//! A presentation-only companion. Microphone, identity and call ownership stay in main.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{ipc::Channel, Manager, WebviewWindow};

type Result<T> = std::result::Result<T, String>;
const LABEL: &str = "huddle";
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct View {
    id: String,
    title: String,
    phase: String,
    #[serde(default)]
    error: Option<String>,
    muted: bool,
    level: f32,
    dark: bool,
    participants: Vec<Person>,
    #[serde(default)]
    audio_settings: Option<AudioSettings>,
    #[serde(default)]
    discussion: Option<Discussion>,
    #[serde(default)]
    discussion_open: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AudioSettings {
    inputs: Vec<AudioDevice>,
    outputs: Vec<AudioDevice>,
    input: String,
    output: String,
    output_supported: bool,
    loading: bool,
    busy: bool,
    error: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AudioDevice {
    id: String,
    label: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Discussion {
    #[serde(default)]
    composer: Option<String>,
    version: u64,
    history_limited: bool,
    status: String,
    error: Option<String>,
    writable: bool,
    sending: bool,
    sent: u64,
    has_more: bool,
    rows: Vec<DiscussionRow>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiscussionRow {
    id: String,
    author_id: String,
    channel_id: String,
    attachments: Vec<DiscussionAttachment>,
    author: String,
    picture: Option<String>,
    #[serde(default)]
    picture_url: Option<String>,
    text: String,
    #[serde(default)]
    mentions: Vec<String>,
    #[serde(default)]
    mention_names: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    edited: bool,
    #[serde(default)]
    attachment_seams: Vec<usize>,
    #[serde(default)]
    mention_references: Vec<String>,
    time: u64,
    delivery: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiscussionAttachment {
    url: String,
    kind: String,
    mime: Option<String>,
    size: Option<u64>,
    name: Option<String>,
    duration: Option<f64>,
    voice_note: Option<bool>,
    waveform: Option<Vec<u8>>,
    dimensions: Option<AttachmentDimensions>,
    blurhash: Option<String>,
    preview_url: Option<String>,
    source: Option<String>,
    preview_source: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AttachmentDimensions {
    width: u32,
    height: u32,
}
impl DiscussionAttachment {
    fn valid(&self) -> bool {
        matches!(self.kind.as_str(), "image" | "video" | "audio" | "file")
            && self.url.len() <= 8192
            && [&self.source, &self.preview_source, &self.preview_url]
                .iter()
                .all(|url| url.as_ref().is_none_or(|url| url.len() <= 8192))
            && self.name.as_ref().is_none_or(|name| name.len() <= 4096)
            && self.mime.as_ref().is_none_or(|mime| mime.len() <= 256)
            && self.blurhash.as_ref().is_none_or(|hash| hash.len() <= 256)
            && self.waveform.as_ref().is_none_or(|waveform| {
                !waveform.is_empty() && waveform.len() <= 100 && waveform.iter().all(|n| *n <= 100)
            })
            && self
                .duration
                .is_none_or(|duration| duration.is_finite() && (0.0..=86400.0).contains(&duration))
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Person {
    key: String,
    name: String,
    picture: Option<String>,
    own: bool,
    #[serde(default)]
    listening: bool,
    #[serde(default)]
    thinking: bool,
    #[serde(default)]
    level: f32,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Action {
    OpenLink,
    Join,
    Decline,
    RefreshAudio,
    InputDevice,
    OutputDevice,
    Mute,
    Leave,
    Minimize,
    Thread,
    Send,
    Older,
    Retry,
    RetryMessage,
    DiscardMessage,
    Closed,
}
#[derive(Clone, Serialize)]
pub(crate) struct Control {
    id: String,
    action: Action,
    text: Option<String>,
}
struct Session {
    view: View,
    actions: Channel<Control>,
    updates: Option<Channel<View>>,
}
#[derive(Default)]
pub(crate) struct HuddleWindow(Mutex<Option<Session>>);
impl HuddleWindow {
    /// Downloads are restricted to attachment sources supplied by the main owner.
    pub(crate) fn permits_download(&self, source: &str, name: &str) -> bool {
        self.0.lock().ok().is_some_and(|slot| {
            slot.as_ref().is_some_and(|session| {
                session.view.phase == "connected"
                    && session.view.discussion.as_ref().is_some_and(|discussion| {
                        discussion
                            .rows
                            .iter()
                            .flat_map(|row| &row.attachments)
                            .any(|attachment| {
                                attachment.source.as_deref() == Some(source)
                                    && attachment.name.as_deref().unwrap_or("") == name
                            })
                    })
            })
        })
    }
}
fn require<R: tauri::Runtime>(window: &WebviewWindow<R>, label: &str) -> Result<()> {
    if window.label() == label {
        Ok(())
    } else {
        Err("Wrong Huddle window".into())
    }
}
fn validate(view: &View) -> Result<()> {
    if uuid::Uuid::parse_str(&view.id).is_err()
        || view.title.len() > 4096
        || view.error.as_ref().is_some_and(|e| e.len() > 8192)
        || !matches!(
            view.phase.as_str(),
            "incoming" | "connecting" | "connected" | "leaving"
        )
        || !view.level.is_finite()
        || !(0.0..=1.0).contains(&view.level)
        || view.participants.len() > 256
        || view.audio_settings.as_ref().is_some_and(|a| {
            a.inputs.len() > 128
                || a.outputs.len() > 128
                || a.input.len() > 4096
                || a.output.len() > 4096
                || a.error.as_ref().is_some_and(|e| e.len() > 8192)
                || a.inputs
                    .iter()
                    .chain(&a.outputs)
                    .any(|d| d.id.len() > 4096 || d.label.len() > 4096)
        })
        || view.discussion.as_ref().is_some_and(|d| {
            d.composer
                .as_ref()
                .is_some_and(|t| uuid::Uuid::parse_str(t).is_err())
                || !matches!(d.status.as_str(), "loading" | "ready" | "error")
                || d.error.as_ref().is_some_and(|e| e.len() > 8192)
                || d.rows.len() > 200
                || d.rows.iter().any(|r| {
                    r.id.len() > 128
                        || r.author_id.len() > 128
                        || r.channel_id.len() > 128
                        || r.attachments.iter().any(|a| !a.valid())
                        || !matches!(
                            r.delivery.as_str(),
                            "sending" | "accepted" | "unknown" | "failed" | "seen"
                        )
                        || r.author.len() > 4096
                        || r.text.len() > 65536
                        || r.picture.as_ref().is_some_and(|p| p.len() > 8192)
                        || r.picture_url.as_ref().is_some_and(|p| p.len() > 8192)
                })
        })
        || view.participants.iter().any(|p| {
            !p.level.is_finite()
                || !(0.0..=1.0).contains(&p.level)
                || p.key.len() > 128
                || p.name.len() > 4096
                || p.picture.as_ref().is_some_and(|s| s.len() > 8192)
        })
    {
        return Err("Invalid Huddle presentation".into());
    }
    Ok(())
}
fn closed_notice(
    actions: Channel<Control>,
    id: String,
) -> impl Fn(&tauri::WindowEvent) + Send + Sync + 'static {
    let actions = Mutex::new(Some(actions));
    move |event| {
        if !matches!(event, tauri::WindowEvent::Destroyed) {
            return;
        }
        let Some(actions) = actions.lock().ok().and_then(|mut slot| slot.take()) else {
            return;
        };
        let id = id.clone();
        // Channel send AND final drop evaluate JavaScript. Neither may reenter
        // Wry while it destroys its window map under a mutable RefCell borrow.
        tauri::async_runtime::spawn_blocking(move || {
            let _ = actions.send(Control {
                id,
                action: Action::Closed,
                text: None,
            });
        });
    }
}
/// A reloaded renderer cannot inherit request actions, including acceptance in progress.
#[tauri::command]
pub(crate) fn huddle_window_reset_incoming<R: tauri::Runtime>(
    window: WebviewWindow<R>,
) -> Result<()> {
    require(&window, "main")?;
    reset_incoming(window.app_handle());
    Ok(())
}
fn reset_incoming<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let host = app.state::<HuddleWindow>();
    let pending = host.0.lock().ok().and_then(|slot| {
        slot.as_ref()
            .filter(|s| matches!(s.view.phase.as_str(), "incoming" | "connecting"))
            .map(|s| s.view.id.clone())
    });
    if let Some(id) = pending {
        retire(app, &id);
    }
}

#[tauri::command]
pub(crate) async fn huddle_window_open<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    host: tauri::State<'_, HuddleWindow>,
    view: View,
    actions: Channel<Control>,
) -> Result<()> {
    require(&window, "main")?;
    validate(&view)?;
    let incoming = view.phase == "incoming";
    let id = view.id.clone();
    let on_closed = closed_notice(actions.clone(), id.clone());
    {
        let mut slot = host.0.lock().map_err(|_| "Huddle window unavailable")?;
        let updates = slot.as_mut().and_then(|s| s.updates.take());
        if let Some(updates) = &updates {
            let _ = updates.send(view.clone());
        }
        *slot = Some(Session {
            view,
            actions,
            updates,
        });
    }
    let app = window.app_handle();
    let companion = match app.get_webview_window(LABEL) {
        Some(existing) => existing,
        None => tauri::WebviewWindowBuilder::new(
            app,
            LABEL,
            tauri::WebviewUrl::App("huddle.html".into()),
        )
        .title("Huddle — Buzz")
        .inner_size(520.0, 560.0)
        .min_inner_size(360.0, 400.0)
        .center()
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?,
    };
    companion.on_window_event(on_closed);
    // Call completion may race native window creation. It retires the session;
    // this post-build check also removes a window created after that retirement.
    if !incoming && !app.state::<crate::relay::Huddles>().contains(&id) {
        retire(app, &id);
        return Err("This Huddle has ended".into());
    }
    companion.show().map_err(|e| e.to_string())?;
    companion.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn huddle_window_update<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    host: tauri::State<'_, HuddleWindow>,
    id: String,
    view: Option<View>,
) -> Result<()> {
    require(&window, "main")?;
    if let Some(view) = &view {
        validate(view)?;
        if view.id != id {
            return Err("Huddle presentation changed".into());
        }
    }
    let mut slot = host.0.lock().map_err(|_| "Huddle window unavailable")?;
    let Some(session) = slot.as_mut().filter(|s| s.view.id == id) else {
        return Ok(());
    };
    if let Some(mut view) = view {
        // Activity-only patches omit the unchanged message list. Watch still
        // receives the complete cached presentation after a renderer reload.
        let patch = view.clone();
        if view.discussion_open && view.discussion.is_none() {
            view.discussion = session.view.discussion.clone();
        } else if !view.discussion_open {
            view.discussion = None;
        }
        if session.view.discussion.is_some() != view.discussion.is_some() {
            if let Some(companion) = window.app_handle().get_webview_window(LABEL) {
                let scale = companion.scale_factor().map_err(|e| e.to_string())?;
                let size = companion
                    .inner_size()
                    .map_err(|e| e.to_string())?
                    .to_logical::<f64>(scale);
                let opening = view.discussion.is_some();
                companion
                    .set_min_size(Some(tauri::LogicalSize::new(
                        if opening { 720.0 } else { 360.0 },
                        400.0,
                    )))
                    .map_err(|e| e.to_string())?;
                companion
                    .set_size(tauri::LogicalSize::new(
                        (size.width + if opening { 360.0 } else { -360.0 }).max(if opening {
                            720.0
                        } else {
                            360.0
                        }),
                        size.height,
                    ))
                    .map_err(|e| e.to_string())?;
            }
        }
        if let Some(updates) = &session.updates {
            let _ = updates.send(patch);
        }
        session.view = view;
    } else {
        *slot = None;
        // Serialize teardown against open. JS also fences pending opens by call ID.
        if let Some(companion) = window.app_handle().get_webview_window(LABEL) {
            companion.destroy().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn huddle_window_watch<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    host: tauri::State<'_, HuddleWindow>,
    updates: Channel<View>,
) -> Result<()> {
    require(&window, LABEL)?;
    let mut slot = host.0.lock().map_err(|_| "Huddle window unavailable")?;
    let session = slot.as_mut().ok_or("This Huddle has ended")?;
    updates
        .send(session.view.clone())
        .map_err(|e| e.to_string())?;
    session.updates = Some(updates);
    Ok(())
}
#[tauri::command]
pub(crate) fn huddle_window_action<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    host: tauri::State<'_, HuddleWindow>,
    id: String,
    action: Action,
    text: Option<String>,
) -> Result<()> {
    require(&window, LABEL)?;
    if matches!(action, Action::Closed) {
        return Err("Window closure is native-owned".into());
    }
    if matches!(
        action,
        Action::Send | Action::RetryMessage | Action::DiscardMessage
    ) {
        if text
            .as_ref()
            .is_none_or(|t| t.trim().is_empty() || t.len() > 65536)
        {
            return Err("Invalid Huddle message".into());
        }
    } else if matches!(action, Action::OpenLink) {
        if text.as_ref().is_none_or(|url| {
            !url.get(..5)
                .is_some_and(|scheme| scheme.eq_ignore_ascii_case("buzz:"))
                || url.len() > 8192
        }) {
            return Err("Invalid Huddle link".into());
        }
    } else if matches!(action, Action::InputDevice | Action::OutputDevice) {
        if text.as_ref().is_none_or(|id| id.len() > 4096) {
            return Err("Invalid audio device".into());
        }
    } else if text.is_some() {
        return Err("Unexpected Huddle message".into());
    }
    let slot = host.0.lock().map_err(|_| "Huddle window unavailable")?;
    let session = slot
        .as_ref()
        .filter(|s| s.view.id == id)
        .ok_or("This Huddle has ended")?;
    session
        .actions
        .send(Control { id, action, text })
        .map_err(|e| e.to_string())
}

/// Called by native call completion too, including expiry after a renderer crash.
pub(crate) fn retire<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) {
    let Some(host) = app.try_state::<HuddleWindow>() else {
        return;
    };
    let Ok(mut slot) = host.0.lock() else {
        return;
    };
    if slot.as_ref().is_none_or(|s| s.view.id == id) {
        *slot = None;
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.destroy();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn window_destruction_sends_and_drops_channel_off_the_event_thread() {
        use std::sync::mpsc;
        use std::thread;
        use std::time::Duration;

        struct DropThread(mpsc::Sender<(&'static str, thread::ThreadId)>);
        impl Drop for DropThread {
            fn drop(&mut self) {
                let _ = self.0.send(("drop", thread::current().id()));
            }
        }
        let (sender, receiver) = mpsc::channel();
        let dropped = DropThread(sender.clone());
        let actions = Channel::new(move |_| {
            let _keep_until_channel_drop = &dropped;
            sender.send(("send", thread::current().id())).unwrap();
            Ok(())
        });
        let notice = closed_notice(actions, "call".into());
        notice(&tauri::WindowEvent::Destroyed);
        notice(&tauri::WindowEvent::Destroyed);
        drop(notice);
        for expected in ["send", "drop"] {
            let (event, thread) = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(event, expected);
            assert_ne!(thread, thread::current().id());
        }
        assert!(receiver.recv().is_err());
    }
    fn view(id: &str) -> View {
        View {
            id: id.into(),
            title: "Design".into(),
            phase: "connected".into(),
            error: None,
            muted: false,
            level: 0.0,
            dark: false,
            participants: vec![],
            discussion: None,
            discussion_open: false,
            audio_settings: None,
        }
    }
    #[test]
    fn retry_error_survives_the_native_dto_and_is_bounded() {
        let mut presentation = view("00000000-0000-4000-8000-000000000001");
        presentation.error = Some("Microphone denied".into());
        assert!(validate(&presentation).is_ok());
        let decoded: View =
            serde_json::from_value(serde_json::to_value(&presentation).unwrap()).unwrap();
        assert_eq!(decoded.error.as_deref(), Some("Microphone denied"));
        presentation.error = Some("x".repeat(8193));
        assert!(validate(&presentation).is_err());
    }
    #[test]
    fn audio_settings_survive_the_native_dto_and_limit_device_data() {
        let mut presentation = view("00000000-0000-4000-8000-000000000001");
        presentation.audio_settings = Some(AudioSettings {
            inputs: vec![AudioDevice {
                id: "mic".into(),
                label: "USB mic".into(),
            }],
            outputs: vec![],
            input: "mic".into(),
            output: "".into(),
            output_supported: true,
            loading: false,
            busy: false,
            error: None,
        });
        assert!(validate(&presentation).is_ok());
        let encoded = serde_json::to_value(&presentation).unwrap();
        assert_eq!(encoded["audioSettings"]["input"], "mic");
        assert!(serde_json::from_value::<View>(encoded).is_ok());
        presentation.audio_settings.as_mut().unwrap().inputs[0].id = "x".repeat(4097);
        assert!(validate(&presentation).is_err());
    }
    #[test]
    fn voice_note_metadata_round_trips_and_bounds_waveform() {
        let value = serde_json::json!({
            "url": "https://relay.example/voice-note.m4a", "kind": "audio",
            "mime": "audio/mp4", "voiceNote": true, "duration": 1.5,
            "waveform": [0, 25, 100]
        });
        let attachment: DiscussionAttachment = serde_json::from_value(value).unwrap();
        assert!(attachment.valid());
        let encoded = serde_json::to_value(&attachment).unwrap();
        assert_eq!(encoded["voiceNote"], true);
        assert_eq!(encoded["waveform"], serde_json::json!([0, 25, 100]));
        let mut decoded: DiscussionAttachment = serde_json::from_value(encoded).unwrap();
        assert!(decoded.valid());
        decoded.waveform = Some(vec![101]);
        assert!(!decoded.valid());
        decoded.waveform = Some(vec![1; 101]);
        assert!(!decoded.valid());
    }
    #[test]
    fn discussion_delivery_and_attachments_survive_the_native_dto() {
        let mut presentation = view("00000000-0000-4000-8000-000000000001");
        presentation.discussion = Some(Discussion {
            composer: None,
            version: 1,
            history_limited: false,
            status: "ready".into(),
            error: None,
            writable: true,
            sending: false,
            sent: 0,
            has_more: false,
            rows: vec![DiscussionRow {
                id: "same-event".into(),
                author_id: "ab".repeat(32),
                channel_id: "room".into(),
                attachments: vec![serde_json::from_value(serde_json::json!({
                    "url": "https://relay.example/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
                    "kind": "image", "mime": "image/png", "name": "photo.png", "size": 123,
                    "dimensions": { "width": 640, "height": 480 },
                    "source": "http://buzz-media.localhost/https%3A%2F%2Frelay.example%2Fmedia%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
                    "previewUrl": "https://relay.example/media/preview.png",
                    "previewSource": "http://buzz-media.localhost/preview.png"
                }))
                .unwrap()],
                author: "Alex".into(),
                picture: Some("http://buzz-media.localhost/avatar".into()),
                picture_url: Some("https://relay.example/avatar.png".into()),
                text: "Hello".into(),
                mentions: vec!["cd".repeat(32)],
                mention_names: [("cd".repeat(32), "Taylor".into())].into(),
                edited: false,
                attachment_seams: vec![3],
                mention_references: vec!["ef".repeat(32)],
                time: 1,
                delivery: "unknown".into(),
            }],
        });
        let encoded = serde_json::to_value(&presentation).unwrap();
        let decoded: View = serde_json::from_value(encoded).unwrap();
        let row = &decoded.discussion.as_ref().unwrap().rows[0];
        assert_eq!(row.mentions, vec!["cd".repeat(32)]);
        assert_eq!(row.mention_references, vec!["ef".repeat(32)]);
        assert_eq!(row.mention_names[&"cd".repeat(32)], "Taylor");
        assert_eq!(row.attachment_seams, vec![3]);
        assert!(!row.edited);
        let host = HuddleWindow::default();
        let source = "http://buzz-media.localhost/https%3A%2F%2Frelay.example%2Fmedia%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png";
        assert!(!host.permits_download(source, "photo.png"));
        *host.0.lock().unwrap() = Some(Session {
            view: presentation.clone(),
            actions: Channel::new(|_| Ok(())),
            updates: None,
        });
        assert!(host.permits_download(source, "photo.png"));
        assert!(!host.permits_download(source, "other.png"));
        assert!(!host.permits_download(source, ""));
        assert!(!host.permits_download("http://buzz-media.localhost/other.png", "photo.png"));
        host.0.lock().unwrap().as_mut().unwrap().view.phase = "leaving".into();
        assert!(!host.permits_download(source, "photo.png"));
        host.0.lock().unwrap().as_mut().unwrap().view.discussion = None;
        host.0.lock().unwrap().as_mut().unwrap().view.phase = "connected".into();
        assert!(!host.permits_download(source, "photo.png"));
        let serialized = serde_json::to_value(&presentation).unwrap();
        assert_eq!(serialized["discussion"]["rows"][0]["delivery"], "unknown");
        assert_eq!(
            serialized["discussion"]["rows"][0]["authorId"],
            "ab".repeat(32)
        );
        assert_eq!(serialized["discussion"]["rows"][0]["channelId"], "room");
        assert_eq!(
            serialized["discussion"]["rows"][0]["pictureUrl"],
            "https://relay.example/avatar.png"
        );
        let restored: View = serde_json::from_value(serialized.clone()).unwrap();
        assert_eq!(serde_json::to_value(&restored).unwrap(), serialized);
        assert!(validate(&restored).is_ok());
        let mut legacy = serialized.clone();
        legacy["discussion"]["rows"][0]
            .as_object_mut()
            .unwrap()
            .remove("pictureUrl");
        let legacy: View = serde_json::from_value(legacy).unwrap();
        assert!(legacy.discussion.as_ref().unwrap().rows[0]
            .picture_url
            .is_none());
        assert!(validate(&legacy).is_ok());
        presentation.discussion.as_mut().unwrap().rows[0].picture_url = Some("é".repeat(4097));
        assert!(validate(&presentation).is_err());
        presentation.discussion.as_mut().unwrap().rows[0].picture_url = None;
        let attachment = &mut presentation.discussion.as_mut().unwrap().rows[0].attachments[0];
        attachment.kind = "invalid".into();
        assert!(validate(&presentation).is_err());
        presentation.discussion.as_mut().unwrap().rows[0].attachments[0].kind = "image".into();
        presentation.discussion.as_mut().unwrap().rows[0].delivery = "invalid".into();
        assert!(validate(&presentation).is_err());
    }
    #[test]
    fn native_completion_retires_only_its_own_presentation() {
        let app = tauri::test::mock_builder()
            .manage(HuddleWindow::default())
            .build(crate::app_context())
            .unwrap();
        tauri::WebviewWindowBuilder::new(&app, LABEL, tauri::WebviewUrl::default())
            .build()
            .unwrap();
        let current = "00000000-0000-4000-8000-000000000001";
        let host = app.state::<HuddleWindow>();
        *host.0.lock().unwrap() = Some(Session {
            view: view(current),
            actions: Channel::new(|_| Ok(())),
            updates: None,
        });
        retire(app.handle(), "old-call");
        assert!(host.0.lock().unwrap().is_some());
        assert!(app.get_webview_window(LABEL).is_some());
        retire(app.handle(), current);
        assert!(host.0.lock().unwrap().is_none());
    }
    #[test]
    fn renderer_restart_clears_requests_but_preserves_connected_calls() {
        let app = tauri::test::mock_builder()
            .manage(HuddleWindow::default())
            .build(crate::app_context())
            .unwrap();
        let id = "00000000-0000-4000-8000-000000000001";
        let host = app.state::<HuddleWindow>();
        *host.0.lock().unwrap() = Some(Session {
            view: view(id),
            actions: Channel::new(|_| Ok(())),
            updates: None,
        });
        reset_incoming(app.handle());
        assert!(host.0.lock().unwrap().is_some());
        for phase in ["incoming", "connecting"] {
            let mut request = view(id);
            request.phase = phase.into();
            assert!(validate(&request).is_ok());
            *host.0.lock().unwrap() = Some(Session {
                view: request,
                actions: Channel::new(|_| Ok(())),
                updates: None,
            });
            reset_incoming(app.handle());
            assert!(host.0.lock().unwrap().is_none());
        }
    }
    #[test]
    fn composer_capability_is_optional_and_requires_a_uuid() {
        let id = "00000000-0000-4000-8000-000000000001";
        let mut value = serde_json::to_value(view(id)).unwrap();
        value["discussion"] = serde_json::json!({
            "version": 1, "historyLimited": false, "status": "ready",
            "error": null, "writable": true, "sending": false,
            "sent": 0, "hasMore": false, "rows": []
        });
        assert!(validate(&serde_json::from_value(value.clone()).unwrap()).is_ok());
        value["discussion"]["composer"] = serde_json::json!(id);
        assert!(validate(&serde_json::from_value(value.clone()).unwrap()).is_ok());
        value["discussion"]["composer"] = serde_json::json!("not-a-capability");
        assert!(validate(&serde_json::from_value(value).unwrap()).is_err());
    }
    #[test]
    fn companion_has_no_call_or_identity_authority() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/huddle.json")).unwrap();
        assert_eq!(capability["webviews"], serde_json::json!(["huddle"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!([
                "allow-huddle-window-watch",
                "allow-huddle-window-action",
                "allow-media-download",
                "allow-clipboard-write-text",
                { "identifier": "opener:allow-open-url", "allow": [{ "url": "https://*" }, { "url": "http://*" }] }
            ])
        );
        assert!(serde_json::from_str::<Action>("\"start\"").is_err());
        assert!(validate(&view("bad-id")).is_err());
    }
}
