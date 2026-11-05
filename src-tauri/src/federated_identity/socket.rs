//! Only upgrade/frame transport. The renderer retains subscriptions and reconnects.
use super::{config::canonical_relay, FederatedIdentity};
use crate::identity::IdentityHost;
use crate::network_diagnostics::{Context, Level, Phase};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, protocol::WebSocketConfig, Message,
};
use tokio_util::sync::CancellationToken;

struct Outgoing {
    data: String,
    diagnostic: Option<Context>,
    frame_sequence: Option<u64>,
    enqueued: Option<Instant>,
}
struct Connection {
    stop: CancellationToken,
    sender: mpsc::Sender<Outgoing>,
    start: Option<oneshot::Sender<()>>,
}
#[derive(Default)]
pub(crate) struct Sockets(Arc<Mutex<HashMap<String, Connection>>>);
impl Sockets {
    pub(crate) fn clear(&self) {
        for (_, connection) in self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain()
        {
            connection.stop.cancel();
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub(crate) enum SocketEvent {
    Text {
        data: String,
        #[serde(rename = "nativeAt")]
        native_at: Option<u64>,
        #[serde(rename = "frameSequence")]
        frame_sequence: Option<u64>,
    },
    /// The relay's close code and reason, when it sent a close frame.
    Closed {
        code: Option<u16>,
        reason: Option<String>,
    },
    /// The relay refused, after the upgrade, a connection sent without a token
    /// for missing evidence; `reason` is the sign-in reason, as for a `401`.
    Refused { reason: String },
    /// The assertion reached its refresh point; the renderer reconnects at
    /// once with a fresh one. Ends the socket before the relay's deadline.
    Renew,
}
#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SocketMode {
    Public,
    Native,
}

#[tauri::command]
pub(crate) async fn relay_socket_connect(
    sockets: tauri::State<'_, Sockets>,
    fi: tauri::State<'_, FederatedIdentity>,
    identity: tauri::State<'_, IdentityHost>,
    id: String,
    relay: String,
    on_event: Channel<SocketEvent>,
) -> Result<SocketMode, String> {
    uuid::Uuid::parse_str(&id).map_err(|_| "Invalid socket connection")?;
    let relay = canonical_relay(&relay)?;
    let stop = CancellationToken::new();
    let (sender, mut outgoing) = mpsc::channel(16);
    let (start, started) = oneshot::channel();
    {
        let mut live = sockets
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if live.len() >= 16 || live.contains_key(&id) {
            return Err("Native sockets are busy".into());
        }
        live.insert(
            id.clone(),
            Connection {
                stop: stop.clone(),
                sender,
                start: Some(start),
            },
        );
    }
    let connect = crate::network_diagnostics::in_context(
        Some(Context {
            operation_id: format!("socket:{id}"),
        }),
        upgrade(
            fi.inner(),
            identity.inner(),
            &relay,
            id.clone(),
            stop.clone(),
        ),
    );
    let result = tokio::select! { _ = stop.cancelled() => Err("Native socket canceled".into()), result = connect => result };
    let (mut socket, assertion, unsigned, cancel) = match result {
        Ok(Some(connection)) => connection,
        result => {
            sockets
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&id);
            return result.map(|_| SocketMode::Public);
        }
    };
    let host = fi.inner().clone();
    let identity = identity.inner().clone();
    let registry = sockets.0.clone();
    tauri::async_runtime::spawn(async move {
        let mut diagnostic = Phase::with_context(
            "socket.worker",
            &relay,
            Some(&id),
            Level::Info,
            Some(&Context {
                operation_id: format!("socket:{id}"),
            }),
        );
        // A connection without a token (the relay decides) never expires here.
        let expiry = async {
            match &assertion {
                Some(assertion) => tokio::time::sleep(assertion.renew_in()).await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(expiry);
        let mut closing: Option<(u16, String)> = None;
        let mut refused = None;
        let mut renew = false;
        let ready = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(10), started) => result.is_ok_and(|value| value.is_ok()),
            _ = cancel.cancelled() => false,
            _ = stop.cancelled() => false,
            _ = &mut expiry => { renew = true; false },
        };
        let metric_relay = url::Url::parse(&relay)
            .map(|url| url.authority().to_owned())
            .unwrap_or_else(|_| "unknown-relay".into());
        let mut received = 0_u64;
        if ready {
            let pump = async {
                loop {
                    tokio::select! {
                        data = outgoing.recv() => {
                            let Some(frame) = data else { break; };
                            let queue_ms = frame.enqueued.map(|instant| instant.elapsed().as_millis().min(u128::from(u64::MAX)) as u64);
                            let data = frame.data;
                            if let Some(assertion) = &assertion {
                                if host.admit_assertion(&identity, assertion).await.is_err() { diagnostic.reason = Some("assertion-retired"); break; }
                                // FI and NIP-42 must bind the same native key.
                                if let Ok(serde_json::Value::Array(frame)) = serde_json::from_str::<serde_json::Value>(&data) {
                                    if frame.first().and_then(|v| v.as_str()) == Some("AUTH") && frame.get(1).and_then(|v| v.get("pubkey")).and_then(|v| v.as_str()) != Some(assertion.viewer.as_str()) { diagnostic.reason = Some("viewer-mismatch"); break; }
                                }
                            }
                            let mut write = Phase::with_context("socket.write", &relay, Some(&id), Level::Debug, frame.diagnostic.as_ref());
                            write.frame_sequence = frame.frame_sequence;
                            write.bytes = Some(data.len());
                            write.queue_ms = queue_ms;
                            let bytes = data.len();
                            if let Err(error) = socket.send(Message::Text(data.into())).await {
                                write.reason = Some(socket_failure(&error));
                                write.socket_error(&error);
                                diagnostic.reason = Some(socket_failure(&error));
                                diagnostic.socket_error(&error);
                                break;
                            }
                            write.ok = true;
                            crate::network_diagnostics::frame(&metric_relay, true, bytes);
                        }
                        frame = socket.next() => {
                            if let Some(assertion) = &assertion {
                                if host.admit_assertion(&identity, assertion).await.is_err() { diagnostic.reason = Some("assertion-retired"); break; }
                            }
                            match frame {
                                Some(Ok(Message::Text(data))) => {
                                    crate::network_diagnostics::frame(&metric_relay, false, data.len());
                                    let detailed = crate::network_diagnostics::enabled(Level::Debug);
                                    if detailed { received += 1; }
                                    let native_at = if detailed { Some(crate::network_diagnostics::timestamp()) } else { None };
                                    if detailed {
                                        let mut receive = Phase::with_context("socket.receive", &relay, Some(&id), Level::Debug, Some(&Context {operation_id: format!("socket:{id}")}));
                                        receive.frame_sequence = Some(received);
                                        receive.bytes = Some(data.len());
                                        receive.ok = true;
                                    }
                                    refused = missing_evidence(unsigned, &data);
                                    if refused.is_some() || on_event.send(SocketEvent::Text {data:data.to_string(), native_at, frame_sequence:if detailed {Some(received)} else {None}}).is_err() { break; }
                                },
                                Some(Ok(Message::Ping(data))) => { if socket.send(Message::Pong(data)).await.is_err() { break; } },
                                Some(Ok(Message::Pong(_))) => {},
                                Some(Ok(Message::Close(frame))) => {
                                    closing = frame.map(|frame| (u16::from(frame.code), frame.reason.to_string()));
                                    break;
                                }
                                Some(Err(error)) => { diagnostic.reason = Some(socket_failure(&error)); diagnostic.socket_error(&error); break; },
                                _ => { diagnostic.reason = Some("stream-ended"); break; },
                            }
                        }
                    }
                }
            };
            tokio::select! {
                _ = cancel.cancelled() => diagnostic.reason = Some("session-retired"),
                _ = stop.cancelled() => { diagnostic.reason = Some("local-close"); diagnostic.ok = true; },
                _ = &mut expiry => { renew = true; diagnostic.reason = Some("planned-renewal"); diagnostic.ok = true; },
                _ = pump => {},
            }
        }
        // Do not flush queued protected frames after expiry or retirement.
        drop(socket);
        registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&id);
        // A policy close may end an expired or refused assertion: never reuse it.
        if let Some(assertion) = assertion
            .as_ref()
            .filter(|_| closing.as_ref().is_some_and(|(code, _)| *code == 1008))
        {
            host.reject_assertion(assertion).await;
        }
        let (code, reason) = match closing {
            Some((code, reason)) => (Some(code), Some(reason)),
            None => (None, None),
        };
        diagnostic.status = code;
        if code.is_some() {
            diagnostic.reason = Some("remote-close");
        }
        if refused.is_some() {
            diagnostic.reason = Some("missing-evidence");
        }
        let _ = on_event.send(match refused {
            Some(reason) => SocketEvent::Refused {
                reason: reason.into(),
            },
            None if renew => SocketEvent::Renew,
            None => SocketEvent::Closed { code, reason },
        });
    });
    Ok(SocketMode::Native)
}
#[tauri::command]
pub(crate) fn relay_socket_start(
    sockets: tauri::State<'_, Sockets>,
    id: String,
) -> Result<(), String> {
    sockets
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get_mut(&id)
        .and_then(|entry| entry.start.take())
        .ok_or("Native socket retired")?
        .send(())
        .map_err(|_| "Native socket retired".into())
}
#[tauri::command]
pub(crate) fn relay_socket_send(
    sockets: tauri::State<'_, Sockets>,
    id: String,
    data: String,
    diagnostic: Option<Context>,
    frame_sequence: Option<u64>,
) -> Result<(), String> {
    if data.len() > 1024 * 1024 {
        return Err("Socket frame too large".into());
    }
    let live = sockets
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let connection = live.get(&id).ok_or("Native socket retired")?;
    let mut phase = Phase::with_context(
        "socket.enqueue",
        "",
        Some(&id),
        Level::Debug,
        diagnostic.as_ref(),
    );
    phase.frame_sequence = frame_sequence;
    phase.bytes = Some(data.len());
    phase.queued = Some(connection.sender.max_capacity() - connection.sender.capacity());
    let result = connection.sender.try_send(Outgoing {
        data,
        diagnostic,
        frame_sequence,
        enqueued: crate::network_diagnostics::enabled(Level::Debug).then(Instant::now),
    });
    phase.ok = result.is_ok();
    result.map_err(|_| {
        phase.reason = Some("send-queue-full-or-closed");
        "Socket send queue is full".into()
    })
}
#[tauri::command]
pub(crate) fn relay_socket_close(
    sockets: tauri::State<'_, Sockets>,
    fi: tauri::State<'_, FederatedIdentity>,
    id: String,
) {
    fi.close_discovery(&id);
    if let Some(entry) = sockets
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&id)
    {
        entry.stop.cancel();
    }
}

/// The socket, its assertion, or the sign-in reason a connection sent without
/// one to an advertising relay keeps for its whole lifetime.
type Upgraded = (
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Option<super::assertion::Assertion>,
    Option<&'static str>,
    CancellationToken,
);

/// NIP-FI's missing-evidence Nostr text: a denial after the upgrade.
const MISSING_EVIDENCE: &str = "auth-required: authentication required";
/// The sign-in reason when `data` is the relay's missing-evidence refusal of
/// a connection sent without a token (`unsigned`); otherwise `None`.
fn missing_evidence(unsigned: Option<&'static str>, data: &str) -> Option<&'static str> {
    let unsigned = unsigned?;
    let Ok(serde_json::Value::Array(frame)) = serde_json::from_str(data) else {
        return None;
    };
    let text = match frame.first()?.as_str()? {
        "NOTICE" => frame.get(1),
        "CLOSED" => frame.get(2),
        "OK" if frame.get(2) == Some(&serde_json::Value::Bool(false)) => frame.get(3),
        _ => None,
    }?;
    (text.as_str()? == MISSING_EVIDENCE).then_some(unsigned)
}
/// The native upgrade to `relay`, or `None` when the community does not
/// advertise NIP-FI and the renderer connects instead. An advertising relay
/// is upgraded natively even without a token, so its missing-evidence `401`
/// can become the sign-in prompt; a shadow relay admits that upgrade.
async fn upgrade(
    fi: &FederatedIdentity,
    identity: &IdentityHost,
    relay: &str,
    id: String,
    stop: CancellationToken,
) -> Result<Option<Upgraded>, String> {
    let url = url::Url::parse(relay).map_err(|_| "Invalid relay")?;
    let mut authorization_phase = Phase::new("socket.authorization", relay, Some(&id), Level::Info);
    let authorization = fi
        .assertion_for_socket(identity, &url, id.clone(), stop)
        .await?;
    authorization_phase.ok = true;
    drop(authorization_phase);
    let (assertion, unsigned) = (authorization.assertion, authorization.unsigned);
    if assertion.is_none() && unsigned.is_none() {
        return Ok(None);
    }
    let cancel = match &assertion {
        Some(assertion) => {
            let cancel = fi.cancellation_for(&assertion.revision)?;
            fi.admit_assertion(identity, assertion).await?;
            cancel
        }
        None => CancellationToken::new(),
    };
    let mut request = relay
        .into_client_request()
        .map_err(|_| "Invalid native socket request")?;
    request.headers_mut().insert(
        tokio_tungstenite::tungstenite::http::header::USER_AGENT,
        crate::relay::user_agent()
            .parse()
            .map_err(|_| "Invalid native socket request")?,
    );
    if let Some(assertion) = &assertion {
        request.headers_mut().insert(
            super::assertion::HEADER,
            assertion
                .header
                .as_str()
                .parse()
                .map_err(|_| "Invalid federated authorization")?,
        );
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(1024 * 1024))
        .max_frame_size(Some(1024 * 1024));
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut diagnostic = Phase::new("socket.upgrade", relay, Some(&id), Level::Info);
    let (socket, _) = tokio::select! {
        _ = cancel.cancelled() => return Err("Federated session changed".into()),
        result = tokio::time::timeout(Duration::from_secs(30), tokio_tungstenite::connect_async_tls_with_config(request, Some(config), false, connector())) => match result.map_err(|_| { diagnostic.reason = Some("timeout"); "Native socket timed out" })? {
            Ok(connection) => connection,
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                diagnostic.status = Some(response.status().as_u16());
                diagnostic.reason = Some("upgrade-refused");
                // NIP-FI's fixed refusal classes: 401 wants fresh evidence,
                // 403 is a decision to stop, 503 is a temporary outage.
                return Err(match response.status().as_u16() {
                    401 => match &assertion {
                        Some(assertion) => {
                            fi.reject_assertion(assertion).await;
                            "relay-unauthorized"
                        }
                        // Missing evidence: the relay requires a token after all.
                        None => unsigned.unwrap_or("relay-unauthorized"),
                    },
                    403 => "relay-forbidden",
                    503 => "relay-unavailable",
                    _ => "Native socket upgrade refused",
                }
                .into());
            }
            Err(error) => { diagnostic.reason = Some(socket_failure(&error)); diagnostic.socket_error(&error); return Err("Native socket upgrade refused".into()); },
        },
    };
    if let Some(assertion) = &assertion {
        fi.admit_assertion(identity, assertion).await?;
    }
    // Only a connection sent without a token can be refused for missing it.
    let unsigned = unsigned.filter(|_| assertion.is_none());
    diagnostic.ok = true;
    Ok(Some((socket, assertion, unsigned, cancel)))
}

fn socket_failure(error: &tokio_tungstenite::tungstenite::Error) -> &'static str {
    use tokio_tungstenite::tungstenite::Error;
    match error {
        Error::Io(error) if error.kind() == std::io::ErrorKind::TimedOut => "timeout",
        Error::Io(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
            "connection-refused"
        }
        Error::Io(_) => "io",
        Error::Tls(_) => "tls",
        Error::Protocol(_) => "protocol",
        Error::Capacity(_) => "capacity",
        _ => "transport",
    }
}

/// Tests' loopback communities use one self-signed root.
fn connector() -> Option<tokio_tungstenite::Connector> {
    #[cfg(test)]
    return Some(super::testing::trusted_connector());
    #[cfg(not(test))]
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::federated_identity::testing::{community, reply};

    fn relay(community: &super::super::testing::Community) -> String {
        format!("wss://{}", community.origin.authority())
    }

    #[tokio::test]
    async fn diagnostics_distinguish_queued_frames_from_writes_and_native_receives() {
        use crate::network_diagnostics::{network_diagnostics_configure, network_diagnostics_read};
        use tauri::{ipc::InvokeResponseBody, Manager};
        let _capture = crate::network_diagnostics::CAPTURE_TEST.lock().await;
        network_diagnostics_configure(Level::Debug, Some(true), None).unwrap();
        let community = community(true).await;
        let server = community.serve_socket(|mut socket| async move {
            let Some(Ok(Message::Text(frame))) = socket.next().await else {
                panic!("no frame")
            };
            assert_eq!(
                frame.as_str(),
                r#"["REQ","private-subscription",{"kinds":[9]}]"#
            );
            socket
                .send(Message::Text(r#"["EOSE","private-subscription"]"#.into()))
                .await
                .unwrap();
        });
        let app = tauri::test::mock_builder()
            .manage(Sockets::default())
            .manage(community.fi.clone())
            .manage(community.host.clone())
            .build(crate::app_context())
            .unwrap();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let on_event = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                let _ = sender.send(serde_json::from_str::<serde_json::Value>(&json).unwrap());
            }
            Ok(())
        });
        let id = uuid::Uuid::new_v4().to_string();
        let operation = format!("subscription:{}", uuid::Uuid::new_v4());
        let mode = relay_socket_connect(
            app.state(),
            app.state(),
            app.state(),
            id.clone(),
            relay(&community),
            on_event,
        )
        .await
        .unwrap();
        assert!(matches!(mode, SocketMode::Native));
        relay_socket_send(
            app.state(),
            id.clone(),
            r#"["REQ","private-subscription",{"kinds":[9]}]"#.into(),
            Some(Context {
                operation_id: operation.clone(),
            }),
            Some(7),
        )
        .unwrap();
        let before = network_diagnostics_read(None);
        let queued = before["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["operationId"] == operation)
            .collect::<Vec<_>>();
        assert!(queued
            .iter()
            .any(|event| event["phase"] == "socket.enqueue" && event["outcome"] == "completed"));
        assert!(!queued.iter().any(|event| event["phase"] == "socket.write"));
        relay_socket_start(app.state(), id.clone()).unwrap();
        let received = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(received["type"], "text");
        assert_eq!(received["frameSequence"], 1);
        assert!(received["nativeAt"].is_u64());
        let after = network_diagnostics_read(None);
        let peer = url::Url::parse(&relay(&community))
            .unwrap()
            .authority()
            .to_owned();
        let traffic = after["traffic"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["relay"] == peer)
            .unwrap();
        assert_eq!(traffic["session"]["txFrames"], 1);
        assert_eq!(traffic["session"]["rxFrames"], 1);
        assert_eq!(
            traffic["session"]["txBytes"],
            r#"["REQ","private-subscription",{"kinds":[9]}]"#.len()
        );
        assert_eq!(
            traffic["session"]["rxBytes"],
            r#"["EOSE","private-subscription"]"#.len()
        );
        let events = after["events"].as_array().unwrap();
        let write = events
            .iter()
            .find(|event| {
                event["operationId"] == operation
                    && event["phase"] == "socket.write"
                    && event["outcome"] == "completed"
            })
            .unwrap();
        assert_eq!(write["frameSequence"], 7);
        assert!(write["queueMs"].is_u64());
        assert!(events.iter().any(|event| event["connection"] == id
            && event["phase"] == "socket.receive"
            && event["frameSequence"] == 1));
        assert!(!after.to_string().contains("private-subscription"));
        relay_socket_close(app.state(), app.state(), id);
        community.assert_carried(&server.await.unwrap());
        network_diagnostics_configure(Level::Info, Some(false), None).unwrap();
    }

    /// The upgrade request carries exactly the issued assertion; the relay's
    /// refusal ends the attempt after it is captured.
    #[tokio::test]
    async fn upgrade_attaches_for_required_discovery() {
        let community = community(true).await;
        let server = community.serve(vec![reply("403 Forbidden", "{}")]);
        let connection = uuid::Uuid::new_v4().to_string();
        let result = upgrade(
            &community.fi,
            &community.host,
            &relay(&community),
            connection.clone(),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(result.err().as_deref(), Some("relay-forbidden"));
        let heads = server.heads().await;
        assert!(
            heads[0].to_ascii_lowercase().contains("upgrade: websocket"),
            "{}",
            heads[0]
        );
        assert!(
            heads[0]
                .lines()
                .any(|line| line.eq_ignore_ascii_case("user-agent: Buzz")),
            "{}",
            heads[0]
        );
        community.assert_carried(&heads[0]);
        let diagnostics = crate::network_diagnostics::network_diagnostics_read(None);
        let event = diagnostics["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|event| {
                event["connection"] == connection
                    && event["phase"] == "socket.upgrade"
                    && event["status"] == 403
            })
            .expect("native upgrade refusal is diagnosable");
        assert_eq!(event["reason"], "upgrade-refused");
        let token = heads[0]
            .lines()
            .find_map(|line| line.split_once("Bearer ").map(|(_, token)| token.trim()))
            .unwrap();
        assert!(!diagnostics.to_string().contains(token));
    }

    /// Ordinary discovery leaves the socket public: no native upgrade, so no
    /// request that could carry an assertion.
    #[tokio::test]
    async fn upgrade_omits_for_ordinary_discovery() {
        let community = community(false).await;
        let server = community.serve(vec![reply("403 Forbidden", "{}")]);
        let result = upgrade(
            &community.fi,
            &community.host,
            &relay(&community),
            uuid::Uuid::new_v4().to_string(),
            CancellationToken::new(),
        )
        .await;
        assert!(matches!(result, Ok(None)));
        assert!(server.received().is_empty());
    }

    /// A signed-out client still upgrades to an advertising relay, plainly: a
    /// shadow relay admits it, and NIP-42 runs over the native socket.
    #[tokio::test]
    async fn upgrade_without_session_goes_plainly_to_an_advertising_relay() {
        let community = community(true).await;
        community.fi.sign_out_for_test();
        let server = community.serve_socket(|mut relay| async move {
            relay
                .send(Message::Text(r#"["AUTH","challenge"]"#.into()))
                .await
                .unwrap();
            let Some(Ok(Message::Text(auth))) = relay.next().await else {
                panic!("no AUTH")
            };
            assert_eq!(auth.as_str(), r#"["AUTH",{"id":"auth"}]"#);
            relay
                .send(Message::Text(r#"["OK","auth",true,""]"#.into()))
                .await
                .unwrap();
        });
        let (mut socket, assertion, unsigned, _) = upgrade(
            &community.fi,
            &community.host,
            &relay(&community),
            uuid::Uuid::new_v4().to_string(),
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(assertion.is_none());
        let Some(Ok(Message::Text(challenge))) = socket.next().await else {
            panic!("no challenge")
        };
        assert_eq!(challenge.as_str(), r#"["AUTH","challenge"]"#);
        socket
            .send(Message::Text(r#"["AUTH",{"id":"auth"}]"#.into()))
            .await
            .unwrap();
        let Some(Ok(Message::Text(ok))) = socket.next().await else {
            panic!("no OK")
        };
        assert_eq!(ok.as_str(), r#"["OK","auth",true,""]"#);
        // Admitted frames pass through; only the canonical refusal is one.
        assert_eq!(missing_evidence(unsigned, &ok), None);
        community.assert_uncarried(&server.await.unwrap());
    }

    /// That connection keeps its unsigned context, so the relay's later
    /// missing-evidence text becomes the sign-in reason, as its `401` does.
    #[tokio::test]
    async fn missing_evidence_text_after_upgrade_without_session_asks_for_sign_in() {
        let community = community(true).await;
        community.fi.sign_out_for_test();
        let _server = community.serve_socket(|mut relay| async move {
            relay
                .send(Message::Text(
                    r#"["NOTICE","auth-required: authentication required"]"#.into(),
                ))
                .await
                .unwrap();
            let _ = relay.next().await;
        });
        let (mut socket, _, unsigned, _) = upgrade(
            &community.fi,
            &community.host,
            &relay(&community),
            uuid::Uuid::new_v4().to_string(),
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
        let Some(Ok(Message::Text(frame))) = socket.next().await else {
            panic!("no refusal")
        };
        assert_eq!(
            missing_evidence(unsigned, &frame),
            Some("Federated sign-in is required")
        );
        for refusal in [
            r#"["CLOSED","sub","auth-required: authentication required"]"#,
            r#"["OK","auth",false,"auth-required: authentication required"]"#,
        ] {
            assert_eq!(missing_evidence(unsigned, refusal), unsigned);
        }
        // Other refusals keep their ordinary handling.
        for other in [
            r#"["NOTICE","restricted: evidence rejected"]"#,
            r#"["CLOSED","sub","auth-required: please authenticate"]"#,
            r#"["EVENT","sub",{"content":"auth-required: authentication required"}]"#,
            r#"["OK","auth",true,"auth-required: authentication required"]"#,
        ] {
            assert_eq!(missing_evidence(unsigned, other), None);
        }
    }

    /// A connection that sent a token keeps no unsigned context: the same text
    /// is not a sign-in refusal. (A relay that does not advertise NIP-FI is
    /// never upgraded natively; see `upgrade_omits_for_ordinary_discovery`.)
    #[tokio::test]
    async fn missing_evidence_text_after_signed_upgrade_is_not_a_sign_in_refusal() {
        let community = community(true).await;
        let server = community.serve_socket(|_| async {});
        let (_, assertion, unsigned, _) = upgrade(
            &community.fi,
            &community.host,
            &relay(&community),
            uuid::Uuid::new_v4().to_string(),
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(assertion.is_some());
        assert_eq!(unsigned, None);
        assert_eq!(
            missing_evidence(
                unsigned,
                r#"["NOTICE","auth-required: authentication required"]"#
            ),
            None
        );
        community.assert_carried(&server.await.unwrap());
    }

    /// An enforcing relay's missing-evidence 401 to that plain upgrade becomes
    /// the sign-in reason the app prompts for.
    #[tokio::test]
    async fn missing_evidence_refusal_without_session_asks_for_sign_in() {
        let community = community(true).await;
        community.fi.sign_out_for_test();
        let server = community.serve(vec![reply("401 Unauthorized", "authentication required\n")]);
        let result = upgrade(
            &community.fi,
            &community.host,
            &relay(&community),
            uuid::Uuid::new_v4().to_string(),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(
            result.err().as_deref(),
            Some("Federated sign-in is required")
        );
        community.assert_uncarried(&server.heads().await[0]);
    }
}
