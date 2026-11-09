//! Client-side Huddle owner. Uses the existing relay's ephemeral channels and v2 audio.
//! No key, arbitrary signer, or arbitrary WebSocket endpoint is exposed to plugins.
mod audio;

use super::{origin, request_url, send, verify_signature, Result};
use crate::federated_identity::FederatedIdentity;
use crate::identity::{EventTemplate, IdentityHost};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tokio::sync::{mpsc, watch};

/// Calls by id: at most one is the person's own, and at most one per agent
/// they bring, so each identity holds one seat.
#[derive(Clone, Default)]
pub(crate) struct Huddles(Arc<Mutex<HashMap<String, Active>>>);
impl Huddles {
    /// Retire calls owned by the main document, including pending admission.
    pub(crate) fn stop_all(&self) {
        if let Ok(calls) = self.0.lock() {
            for active in calls.values() {
                let _ = active.stop.send(true);
            }
        }
    }

    pub(crate) fn contains(&self, id: &str) -> bool {
        self.0.lock().is_ok_and(|calls| calls.contains_key(id))
    }
    fn claim(&self, id: String, call: Active) -> Result<()> {
        let mut calls = self.0.lock().map_err(|_| "Huddles unavailable")?;
        if calls.contains_key(&id) || calls.values().any(|a| a.agent == call.agent) {
            return Err(match call.agent {
                None => "Leave your current Huddle first",
                Some(_) => "This agent is already in a Huddle",
            }
            .into());
        }
        calls.insert(id, call);
        Ok(())
    }
}
struct Active {
    /// The agent this call seats, or `None` for the person's own call.
    agent: Option<String>,
    stop: watch::Sender<bool>,
    done: watch::Receiver<bool>,
    pcm: mpsc::Sender<Vec<f32>>,
    touched: Arc<AtomicU64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Call {
    id: String,
    community: String,
    viewer: String,
    parent: String,
    room: Option<String>,
    /// An agent of `viewer` to seat in the existing `room`, signing as itself.
    #[serde(default)]
    agent: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Update {
    Connected {
        room: String,
        participants: Vec<String>,
    },
    Participants {
        participants: Vec<String>,
    },
    Audio {
        peer: String,
        samples: Vec<f32>,
    },
    Ended {
        error: Option<String>,
    },
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn lease_time() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs()
}
fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
fn validate(call: &Call) -> Result<()> {
    origin(&call.community)?;
    if !uuid(&call.id)
        || !uuid(&call.parent)
        || !super::hex_key(&call.viewer)
        || call
            .room
            .as_ref()
            .is_some_and(|id| !uuid(id) || id == &call.parent)
        || call
            .agent
            .as_ref()
            .is_some_and(|agent| !super::hex_key(agent) || call.room.is_none())
    {
        return Err("Invalid Huddle destination".into());
    }
    Ok(())
}
fn check_cancelled(stop: &watch::Receiver<bool>, touched: &AtomicU64) -> Result<()> {
    if *stop.borrow() || lease_time().saturating_sub(touched.load(Ordering::Relaxed)) > 20 {
        Err("Huddle cancelled".into())
    } else {
        Ok(())
    }
}
fn template(kind: u16, tags: Vec<Vec<String>>, content: String) -> EventTemplate {
    EventTemplate {
        kind,
        created_at: now(),
        tags,
        content,
    }
}
fn lifecycle(kind: u16, parent: &str, room: &str) -> EventTemplate {
    template(
        kind,
        vec![vec!["h".into(), parent.into()]],
        json!({"ephemeral_channel_id": room}).to_string(),
    )
}
fn create(room: &str, parent: &str) -> EventTemplate {
    template(
        9007,
        vec![
            vec!["h".into(), room.into()],
            vec!["name".into(), "Huddle".into()],
            vec!["visibility".into(), "private".into()],
            vec!["channel_type".into(), "stream".into()],
            vec![
                "about".into(),
                format!("Buzz Huddle (buzz.huddles/v1)\nparent:{parent}"),
            ],
            vec!["ttl".into(), "3600".into()],
        ],
        String::new(),
    )
}
fn confirm_member(room: &str, viewer: &str) -> EventTemplate {
    template(
        9000,
        vec![
            vec!["h".into(), room.into()],
            vec!["p".into(), viewer.into()],
        ],
        String::new(),
    )
}
async fn publish(
    host: &IdentityHost,
    fi: &FederatedIdentity,
    community: &str,
    event: EventTemplate,
    viewer: &str,
) -> Result<()> {
    let operation = match event.kind {
        9007 => "create the Huddle room",
        9000 => "confirm Huddle chat membership",
        48100 => "announce the Huddle in this chat",
        9002 => "close the temporary Huddle room",
        _ => "update the Huddle",
    };
    let signed = host.sign(event).await?;
    if signed["pubkey"] != viewer {
        return Err("Your identity changed. Reopen Huddles.".into());
    }
    let expected = signed["id"]
        .as_str()
        .ok_or("Invalid signed Huddle event")?
        .to_owned();
    let reply = send(
        host,
        Some(fi),
        request_url(community, "/events", "POST")?,
        "POST",
        Some(signed.to_string()),
        true,
        65536,
    )
    .await?;
    publication_receipt(reply.status, &reply.body, &expected, operation)
}

fn publication_receipt(status: u16, body: &str, expected: &str, operation: &str) -> Result<()> {
    let value = serde_json::from_str::<Value>(body).ok();
    let reason = value
        .as_ref()
        .and_then(|value| {
            value["error"]
                .as_str()
                .or_else(|| value["message"].as_str())
        })
        .map(|reason| {
            // Relay refusal text is display-only: bounded plain text, never markup or logs.
            reason
                .chars()
                .filter(|c| !c.is_control())
                .take(300)
                .collect::<String>()
        })
        .filter(|reason| !reason.trim().is_empty());
    if !(200..300).contains(&status) {
        return Err(format!(
            "Couldn’t {operation} (HTTP {status}){}",
            reason
                .map(|reason| format!(": {reason}"))
                .unwrap_or_default()
        ));
    }
    let value = value.ok_or_else(|| format!("Invalid receipt while trying to {operation}"))?;
    // Same /events acknowledgement contract as ordinary client publications.
    if value["event_id"] != expected || value["accepted"] != true {
        return Err(format!(
            "Relay did not accept the request to {operation}{}",
            reason
                .map(|reason| format!(": {reason}"))
                .unwrap_or_default()
        ));
    }
    Ok(())
}

async fn admit_membership(
    host: &IdentityHost,
    fi: &FederatedIdentity,
    call: &Call,
) -> Result<bool> {
    if host.viewer().await? != call.viewer {
        return Err("Your identity changed. Reopen Huddles.".into());
    }
    let info = send(
        host,
        Some(fi),
        origin(&call.community)?,
        "GET",
        None,
        false,
        65536,
    )
    .await?;
    let info: Value = serde_json::from_str(&info.body).map_err(|_| "Relay identity unavailable")?;
    let authority = info["self"]
        .as_str()
        .or(info["pubkey"].as_str())
        .filter(|s| super::hex_key(s))
        .ok_or("Relay identity unavailable")?;
    let mut channels = vec![call.parent.as_str()];
    if let Some(room) = &call.room {
        channels.push(room.as_str());
    }
    let filters: Vec<Value> = channels
        .iter()
        .map(|channel| json!({"kinds":[39002], "authors":[authority], "#d":[channel], "limit":1, "consistency":"strong"}))
        .collect();
    let reply = send(
        host,
        Some(fi),
        request_url(&call.community, "/query", "POST")?,
        "POST",
        Some(serde_json::to_string(&filters).map_err(|_| "Invalid membership query")?),
        true,
        1024 * 1024,
    )
    .await?;
    if !(200..300).contains(&reply.status) {
        return Err("Could not verify channel membership".into());
    }
    let events: Vec<Value> =
        serde_json::from_str(&reply.body).map_err(|_| "Invalid channel membership")?;
    let allowed = membership_allows(&events, authority, &call.viewer, &channels);
    if !allowed {
        return Err("You must belong to this Huddle or its original chat to join".into());
    }
    Ok(call
        .room
        .as_ref()
        .is_some_and(|room| membership_allows(&events, authority, &call.viewer, &[room.as_str()])))
}

async fn while_audio_authorized<T>(
    connection: &mut audio::Connection,
    operation: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    let Some(expires_at) = connection.expires_at else {
        return operation.await;
    };
    let cancellation = connection.cancellation.clone();
    tokio::pin!(operation);
    tokio::select! {
        biased;
        result = &mut operation => result,
        _ = cancellation.cancelled() => {
            drop(connection.socket.take());
            match operation.as_mut().await {
                Err(error) => Err(error),
                Ok(_) => Err("Huddle authorization changed. Join again to reconnect.".into()),
            }
        }
        _ = tokio::time::sleep_until(expires_at) => {
            drop(connection.socket.take());
            operation.as_mut().await?;
            Err("Huddle authorization expired. Join again to reconnect.".into())
        }
    }
}
// Only relay-signed current rosters count. Joining an existing room may use
// either roster; creating a room still supplies only its parent. The audio
// endpoint remains authoritative for creator linkage, archive state and access.
fn membership_allows(events: &[Value], authority: &str, viewer: &str, channels: &[&str]) -> bool {
    channels.iter().any(|channel| {
        events
            .iter()
            .filter(|e| {
                verify_signature(e).is_ok()
                    && e["kind"] == 39002
                    && e["pubkey"] == authority
                    && has_tag(e, "d", channel)
            })
            .max_by(|a, b| {
                a["created_at"]
                    .as_u64()
                    .cmp(&b["created_at"].as_u64())
                    .then_with(|| b["id"].as_str().cmp(&a["id"].as_str()))
            })
            .is_some_and(|e| has_tag(e, "p", viewer))
    })
}

fn has_tag(event: &Value, name: &str, value: &str) -> bool {
    event["tags"]
        .as_array()
        .is_some_and(|tags| tags.iter().any(|t| t[0] == name && t[1] == value))
}

#[tauri::command]
pub(crate) fn huddle_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    host: tauri::State<'_, IdentityHost>,
    fi: tauri::State<'_, FederatedIdentity>,
    agents: tauri::State<'_, crate::app_agents::AppAgentHost>,
    huddles: tauri::State<'_, Huddles>,
    call: Call,
    updates: Channel<Update>,
) -> Result<()> {
    validate(&call)?;
    let (stop, cancelled) = watch::channel(false);
    let (done, finished) = watch::channel(false);
    // Drop excess microphone frames instead of accumulating seconds of delayed speech.
    let (pcm, receiver) = mpsc::channel(5);
    let touched = Arc::new(AtomicU64::new(lease_time()));
    huddles.claim(
        call.id.clone(),
        Active {
            agent: call.agent.clone(),
            stop,
            done: finished,
            pcm,
            touched: touched.clone(),
        },
    )?;
    let host = host.inner().clone();
    let fi = fi.inner().clone();
    let agents = agents.inner().clone();
    let huddles = huddles.inner().clone();
    tauri::async_runtime::spawn(async move {
        let result = match &call.agent {
            None => {
                run(
                    &host,
                    &fi,
                    &call,
                    &updates,
                    cancelled.clone(),
                    receiver,
                    touched,
                )
                .await
            }
            Some(agent) => {
                let seat = (&agents, agent.as_str());
                seat_agent(
                    &host,
                    seat,
                    &call,
                    &updates,
                    cancelled.clone(),
                    receiver,
                    touched,
                )
                .await
            }
        };
        let error = result.err().filter(|_| !*cancelled.borrow());
        let _ = updates.send(Update::Ended { error });
        if let Ok(mut calls) = huddles.0.lock() {
            calls.remove(&call.id);
        }
        if call.agent.is_none() {
            crate::huddle_window::retire(&app, &call.id);
        }
        let _ = done.send(true);
    });
    Ok(())
}

/// Seats the viewer's agent in an existing room as itself: no room creation,
/// announcement or membership publication, which stay the person's. The relay
/// admits it as a delegated agent; it hears only its owner.
async fn seat_agent(
    host: &IdentityHost,
    (agents, agent): (&crate::app_agents::AppAgentHost, &str),
    call: &Call,
    updates: &Channel<Update>,
    mut stop: watch::Receiver<bool>,
    pcm: mpsc::Receiver<Vec<f32>>,
    touched: Arc<AtomicU64>,
) -> Result<()> {
    let room = call
        .room
        .as_deref()
        .ok_or("Agents join an existing Huddle")?;
    check_cancelled(&stop, &touched)?;
    if host.viewer().await? != call.viewer {
        return Err("Your identity changed. Reopen Huddles.".into());
    }
    let (agent, key, admission) = agents.signer(agent.into(), call.community.clone()).await?;
    if agent.owner != call.viewer {
        return Err("Only its owner can bring an agent into a Huddle".into());
    }
    check_cancelled(&stop, &touched)?;
    let connection = tokio::select! {
        _ = stop.changed() => return Err("Huddle cancelled".into()),
        result = tokio::time::timeout(Duration::from_secs(15), audio::seat(&agent, &key, admission, &call.parent, room)) => result.map_err(|_| "Huddle connection timed out")??,
    };
    check_cancelled(&stop, &touched)?;
    audio::ensure_authorized(connection.expires_at, &connection.cancellation)?;
    updates
        .send(Update::Connected {
            room: room.into(),
            participants: connection.peers.values().cloned().collect(),
        })
        .map_err(|_| "Huddle view closed")?;
    audio::run(connection, pcm, stop.clone(), updates, &touched).await
}

async fn run(
    host: &IdentityHost,
    fi: &FederatedIdentity,
    call: &Call,
    updates: &Channel<Update>,
    mut stop: watch::Receiver<bool>,
    pcm: mpsc::Receiver<Vec<f32>>,
    touched: Arc<AtomicU64>,
) -> Result<()> {
    check_cancelled(&stop, &touched)?;
    let room_membership_confirmed = tokio::select! {
        _ = stop.changed() => return Err("Huddle cancelled".into()),
        result = admit_membership(host, fi, call) => result?,
    };
    check_cancelled(&stop, &touched)?;
    let room = call
        .room
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let creating = call.room.is_none();
    let mut attempted_create = false;
    let mut advertised = false;
    let result = async {
        if creating {
            attempted_create = true;
            // Do not cancel an in-flight publication: its outcome may be uncertain.
            publish(host, fi, &call.community, create(&room, &call.parent), &call.viewer).await?;
            check_cancelled(&stop, &touched)?;
            // Once the advisory might be visible, another person can join. Never
            // archive that shared room on our own failed/cancelled connection.
            advertised = true;
            publish(host, fi, &call.community, lifecycle(48100, &call.parent, &room), &call.viewer).await?;
        }
        check_cancelled(&stop, &touched)?;
        let mut connection = tokio::select! {
            _ = stop.changed() => return Err("Huddle cancelled".into()),
            result = tokio::time::timeout(Duration::from_secs(15), audio::connect(host, fi, call, &room)) => result.map_err(|_| "Huddle connection timed out")??,
        };
        check_cancelled(&stop, &touched)?;
        audio::ensure_authorized(connection.expires_at, &connection.cancellation)?;
        if !creating && !room_membership_confirmed {
            // Audio can add parent-chat members directly in the database without
            // updating NIP-29 discovery. Once audio has admitted this identity,
            // self PUT_USER republishes the signed roster without changing roles.
            // Never use audio participation itself as chat write authority.
            while_audio_authorized(
                &mut connection,
                publish(host, fi, &call.community, confirm_member(&room, &call.viewer), &call.viewer),
            ).await?;
            check_cancelled(&stop, &touched)?;
            audio::ensure_authorized(connection.expires_at, &connection.cancellation)?;
            let confirmed = tokio::select! {
                _ = stop.changed() => return Err("Huddle cancelled".into()),
                result = while_audio_authorized(&mut connection, admit_membership(host, fi, call)) => result?,
            };
            audio::ensure_authorized(connection.expires_at, &connection.cancellation)?;
            if !confirmed {
                return Err("Huddle chat membership could not be confirmed. Try joining again.".into());
            }
        }
        check_cancelled(&stop, &touched)?;
        audio::ensure_authorized(connection.expires_at, &connection.cancellation)?;
        updates.send(Update::Connected { room: room.clone(), participants: connection.peers.values().cloned().collect() }).map_err(|_| "Huddle view closed")?;
        audio::run(
            connection,
            pcm,
            stop.clone(),
            updates,
            &touched,
        )
        .await
    }.await;
    // Only unadvertised creation can be rolled back without ending someone else's
    // call. Otherwise socket/TTL cleanup belongs to the existing relay.
    if attempted_create && !advertised {
        let archive = template(
            9002,
            vec![
                vec!["h".into(), room.clone()],
                vec!["archived".into(), "true".into()],
            ],
            String::new(),
        );
        let cleanup = publish(host, fi, &call.community, archive, &call.viewer).await;
        if cleanup.is_err() {
            return Err(format!(
                "{}. The temporary Huddle could not be closed; it will expire.",
                result.err().unwrap_or_else(|| "Huddle cancelled".into())
            ));
        }
    }
    result
}

#[tauri::command]
pub(crate) async fn huddle_close(huddles: tauri::State<'_, Huddles>, id: String) -> Result<()> {
    let done = {
        let calls = huddles.0.lock().map_err(|_| "Huddles unavailable")?;
        calls.get(&id).map(|a| {
            let _ = a.stop.send(true);
            a.done.clone()
        })
    };
    if let Some(mut done) = done {
        if !*done.borrow() {
            let _ = done.changed().await;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn huddle_touch(huddles: tauri::State<'_, Huddles>, id: String) -> Result<()> {
    let calls = huddles.0.lock().map_err(|_| "Huddles unavailable")?;
    if let Some(a) = calls.get(&id) {
        a.touched.store(lease_time(), Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn huddle_pcm(
    huddles: tauri::State<'_, Huddles>,
    id: String,
    samples: Vec<f32>,
) -> Result<()> {
    if samples.len() != 960 || samples.iter().any(|s| !s.is_finite() || s.abs() > 1.0) {
        return Err("Invalid Huddle audio frame".into());
    }
    let calls = huddles.0.lock().map_err(|_| "Huddles unavailable")?;
    if let Some(a) = calls.get(&id).filter(|a| !*a.stop.borrow()) {
        let _ = a.pcm.try_send(samples);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Huddle membership and publication send exactly the issued assertion to
    /// a community that requires NIP-FI, and nothing to one that does not.
    fn authority(community: &crate::federated_identity::testing::Community) -> String {
        community.origin.as_str().trim_end_matches('/').into()
    }
    async fn membership(required: bool) {
        use crate::federated_identity::testing::{community, reply};
        let community = community(required).await;
        let relay = format!(r#"{{"self":"{}"}}"#, "a".repeat(64));
        let server = community.serve(vec![reply("200 OK", &relay), reply("200 OK", "[]")]);
        let call = Call {
            id: uuid::Uuid::new_v4().to_string(),
            community: authority(&community),
            viewer: community.host.viewer().await.unwrap(),
            parent: uuid::Uuid::new_v4().to_string(),
            room: None,
            agent: None,
        };
        let _ = admit_membership(&community.host, &community.fi, &call).await;
        let heads = server.heads().await;
        assert!(heads[0].starts_with("GET / "), "{}", heads[0]);
        community.assert_uncarried(&heads[0]);
        assert!(heads[1].starts_with("POST /query "), "{}", heads[1]);
        community.assert_carried(&heads[1]);
    }
    #[tokio::test]
    async fn membership_attaches_for_required_discovery() {
        membership(true).await;
    }
    #[tokio::test]
    async fn membership_omits_for_ordinary_discovery() {
        membership(false).await;
    }

    async fn publication(required: bool) {
        use crate::federated_identity::testing::{community, reply};
        let community = community(required).await;
        let server = community.serve(vec![reply("200 OK", "{}")]);
        let viewer = community.host.viewer().await.unwrap();
        let event = confirm_member(&uuid::Uuid::new_v4().to_string(), &viewer);
        let _ = publish(
            &community.host,
            &community.fi,
            &authority(&community),
            event,
            &viewer,
        )
        .await;
        let heads = server.heads().await;
        assert!(heads[0].starts_with("POST /events "), "{}", heads[0]);
        community.assert_carried(&heads[0]);
    }
    #[tokio::test]
    async fn publish_attaches_for_required_discovery() {
        publication(true).await;
    }
    #[tokio::test]
    async fn publish_omits_for_ordinary_discovery() {
        publication(false).await;
    }
    /// A held call slot for `agent`, and the receiver that sees it stopped.
    fn held(agent: Option<String>) -> (Active, watch::Receiver<bool>) {
        let (stop, cancelled) = watch::channel(false);
        let (_, done) = watch::channel(false);
        let (pcm, _) = mpsc::channel(1);
        let touched = Arc::new(AtomicU64::new(lease_time()));
        let call = Active {
            agent,
            stop,
            done,
            pcm,
            touched,
        };
        (call, cancelled)
    }
    #[test]
    fn each_identity_holds_one_seat_and_teardown_stops_them_all() {
        let huddles = Huddles::default();
        let (ada, bob) = (Some("a".repeat(64)), Some("b".repeat(64)));
        let (own, own_cancelled) = held(None);
        let (seat, seat_cancelled) = held(ada.clone());
        huddles.claim("own".into(), own).unwrap();
        huddles.claim("ada".into(), seat).unwrap();
        huddles.claim("bob".into(), held(bob).0).unwrap();
        assert_eq!(
            huddles.claim("own2".into(), held(None).0).unwrap_err(),
            "Leave your current Huddle first"
        );
        assert_eq!(
            huddles.claim("ada2".into(), held(ada).0).unwrap_err(),
            "This agent is already in a Huddle"
        );
        assert!(
            huddles.claim("ada".into(), held(None).0).is_err(),
            "ids are unique"
        );

        huddles.stop_all();
        assert!(*own_cancelled.borrow());
        assert!(
            *seat_cancelled.borrow(),
            "agents' seats end with the document"
        );
        // Keep the slots until asynchronous audio teardown finishes.
        assert!(huddles.contains("own") && huddles.contains("ada"));
        huddles.stop_all();
    }

    #[tokio::test]
    async fn cancellation_interrupts_initial_membership_read() {
        // Accept the TLS connection without answering: admission must be pending
        // when cancellation arrives, rather than racing a completed request.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = IdentityHost::fixture();
        let call = Call {
            id: uuid::Uuid::new_v4().to_string(),
            community: format!("https://{}", listener.local_addr().unwrap()),
            viewer: host.viewer().await.unwrap(),
            parent: uuid::Uuid::new_v4().to_string(),
            room: None,
            agent: None,
        };
        let updates = Channel::new(|_| panic!("Cancelled admission must not connect"));
        let (stop, cancelled) = watch::channel(false);
        let (_pcm, receiver) = mpsc::channel(1);
        let fi = FederatedIdentity::new().unwrap();
        let pending = run(
            &host,
            &fi,
            &call,
            &updates,
            cancelled,
            receiver,
            Arc::new(AtomicU64::new(lease_time())),
        );
        tokio::pin!(pending);
        let (_socket, _) = tokio::select! {
            connection = listener.accept() => connection.unwrap(),
            result = &mut pending => panic!("Admission ended before cancellation: {result:?}"),
        };
        stop.send(true).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .expect("Cancellation must not wait for the relay timeout");
        assert_eq!(result.unwrap_err(), "Huddle cancelled");
    }

    #[tokio::test]
    async fn existing_room_membership_does_not_require_parent_access() {
        let host = IdentityHost::fixture();
        let authority = host.viewer().await.unwrap();
        let viewer = "ab".repeat(32);
        let room = host
            .sign(EventTemplate {
                kind: 39002,
                created_at: 1_700_000_000,
                tags: vec![
                    vec!["d".into(), "room".into()],
                    vec!["p".into(), viewer.clone()],
                ],
                content: String::new(),
            })
            .await
            .unwrap();
        assert!(membership_allows(
            std::slice::from_ref(&room),
            &authority,
            &viewer,
            &["parent", "room"]
        ));
        assert!(!membership_allows(
            std::slice::from_ref(&room),
            &authority,
            &viewer,
            &["parent"]
        ));
        assert!(!membership_allows(
            std::slice::from_ref(&room),
            &viewer,
            &viewer,
            &["room"]
        ));
        let mut forged = room.clone();
        forged["tags"][0][1] = json!("parent");
        assert!(!membership_allows(
            &[forged],
            &authority,
            &viewer,
            &["parent"]
        ));
        let revoked = host
            .sign(EventTemplate {
                kind: 39002,
                created_at: 1_700_000_000,
                tags: vec![vec!["d".into(), "room".into()]],
                content: String::new(),
            })
            .await
            .unwrap();
        assert!(!membership_allows(
            &[revoked],
            &authority,
            &viewer,
            &["parent", "room"]
        ));
    }
    #[tokio::test]
    async fn membership_confirmation_cannot_be_signed_by_a_replacement_identity() {
        let host = IdentityHost::fixture();
        let viewer = "ab".repeat(32);
        let result = publish(
            &host,
            &FederatedIdentity::new().unwrap(),
            "https://relay.test",
            confirm_member("room", &viewer),
            &viewer,
        )
        .await;
        assert_eq!(result, Err("Your identity changed. Reopen Huddles.".into()));
    }
    #[test]
    fn chat_membership_confirmation_only_targets_self_and_preserves_role() {
        let event = confirm_member("room", "viewer");
        assert_eq!(event.kind, 9000);
        assert_eq!(event.tags, vec![vec!["h", "room"], vec!["p", "viewer"]]);
        assert!(event.content.is_empty());
    }
    #[test]
    fn huddle_templates_match_existing_protocol() {
        let room = uuid::Uuid::new_v4().to_string();
        let parent = uuid::Uuid::new_v4().to_string();
        let e = create(&room, &parent);
        assert_eq!(e.kind, 9007);
        assert!(super::super::channel_writes::creation(&e));
        assert_eq!(e.tags[5], ["ttl", "3600"]);
        assert_eq!(
            e.tags[4],
            [
                "about",
                &format!("Buzz Huddle (buzz.huddles/v1)\nparent:{parent}")
            ]
        );
        assert_eq!(e.tags[2], ["visibility", "private"]);
        let e = lifecycle(48100, &parent, &room);
        assert_eq!(e.tags, vec![vec!["h", &parent]]);
        assert_eq!(
            serde_json::from_str::<Value>(&e.content).unwrap(),
            json!({"ephemeral_channel_id":room})
        );
    }
    #[test]
    fn publication_errors_identify_the_step_and_bounded_relay_reason() {
        let operation = "announce the Huddle in this chat";
        assert_eq!(publication_receipt(400, r#"{"error":"invalid: channel is archived"}"#, "id", operation),
            Err("Couldn’t announce the Huddle in this chat (HTTP 400): invalid: channel is archived".into()));
        assert_eq!(
            publication_receipt(502, "not JSON", "id", operation),
            Err("Couldn’t announce the Huddle in this chat (HTTP 502)".into())
        );
        let body = json!({"error":format!("\n{}\u{1b}", "x".repeat(500))}).to_string();
        let error = publication_receipt(400, &body, "id", operation).unwrap_err();
        assert!(error.ends_with(&"x".repeat(300)));
        assert!(!error.contains('\n'));
        assert_eq!(
            publication_receipt(200, r#"{"event_id":"id","accepted":true}"#, "id", operation),
            Ok(())
        );
        assert!(publication_receipt(
            200,
            r#"{"event_id":"other","accepted":true}"#,
            "id",
            operation
        )
        .is_err());
        assert!(publication_receipt(
            200,
            r#"{"event_id":"id","accepted":false,"message":"duplicate"}"#,
            "id",
            operation
        )
        .unwrap_err()
        .ends_with(": duplicate"));
    }
    /// Seats the agent `owner` holds in a community that would accept any dial,
    /// with `viewer` on the call: the refusal, and whether anything was dialed.
    async fn seated(owner: &str, viewer: Option<&str>) -> (String, bool) {
        use buzz_agent_controller::{AppAgent, Secret};
        let community = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = community.local_addr().unwrap();
        let key = Secret::generate().unwrap();
        let agent: AppAgent = serde_json::from_value(json!({
            "pubkey": key.pubkey(), "relay": format!("wss://{address}"), "owner": owner,
            "auth": r#"["auth","owner","conditions","sig"]"#, "type": "p/t", "name": "Ada"
        }))
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let agents = crate::app_agents::AppAgentHost::holding(
            dir.path().join("identities.json"),
            &agent,
            key,
            crate::federated_identity::agent::AgentTokens::unconfigured(),
        );
        let host = IdentityHost::fixture();
        let call = Call {
            id: uuid::Uuid::new_v4().to_string(),
            community: format!("https://{address}/"),
            viewer: match viewer {
                Some(viewer) => viewer.into(),
                None => host.viewer().await.unwrap(),
            },
            parent: uuid::Uuid::new_v4().to_string(),
            room: Some(uuid::Uuid::new_v4().to_string()),
            agent: Some(agent.pubkey.clone()),
        };
        validate(&call).unwrap();
        let (_stop, stop) = watch::channel(false);
        let (_pcm, pcm) = mpsc::channel(1);
        let updates = Channel::new(|_| panic!("a refused seat reports nothing"));
        let touched = Arc::new(AtomicU64::new(lease_time()));
        let seat = (&agents, agent.pubkey.as_str());
        let seating = seat_agent(&host, seat, &call, &updates, stop, pcm, touched);
        tokio::select! {
            biased;
            _ = community.accept() => ("dialed".into(), true),
            refused = tokio::time::timeout(Duration::from_secs(5), seating) => {
                (refused.expect("the seat was never refused").unwrap_err(), false)
            }
        }
    }
    #[tokio::test]
    async fn an_agent_is_dialed_in_only_by_its_signed_in_owner() {
        let viewer = IdentityHost::fixture().viewer().await.unwrap();
        // Control: the detector sees the dial an owner's seat makes.
        assert_eq!(seated(&viewer, None).await, ("dialed".into(), true));
    }
    #[tokio::test]
    async fn another_accounts_agent_is_refused_before_any_dial() {
        // The person on the call is the one signed in; the agent is another's.
        assert_eq!(
            seated(&"b".repeat(64), None).await,
            (
                "Only its owner can bring an agent into a Huddle".into(),
                false
            )
        );
    }
    #[tokio::test]
    async fn a_changed_identity_is_refused_before_any_dial() {
        // The agent is the call's viewer's, but someone else is signed in now.
        let other = "c".repeat(64);
        assert_ne!(IdentityHost::fixture().viewer().await.unwrap(), other);
        assert_eq!(
            seated(&other, Some(&other)).await,
            ("Your identity changed. Reopen Huddles.".into(), false)
        );
    }

    #[test]
    fn destination_rejects_paths_credentials_and_noncanonical_ids() {
        let mut call = Call {
            id: uuid::Uuid::new_v4().to_string(),
            community: "https://relay.example".into(),
            viewer: "a".repeat(64),
            parent: uuid::Uuid::new_v4().to_string(),
            room: None,
            agent: None,
        };
        assert!(validate(&call).is_ok());
        call.community = "https://relay.example/other".into();
        assert!(validate(&call).is_err());
        call.community = "https://user@relay.example".into();
        assert!(validate(&call).is_err());
        call.community = "https://relay.example".into();
        call.room = Some(call.parent.clone());
        assert!(validate(&call).is_err());
        // An agent is a canonical key, and only joins an existing room.
        call.agent = Some("b".repeat(64));
        assert!(validate(&call).is_err());
        call.room = Some(uuid::Uuid::new_v4().to_string());
        assert!(validate(&call).is_ok());
        call.agent = Some("B".repeat(64));
        assert!(validate(&call).is_err());
        call.agent = Some("b".repeat(63));
        assert!(validate(&call).is_err());
    }
}
