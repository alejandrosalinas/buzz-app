use super::{now, template, Call, Channel, IdentityHost, Result, Update};
use crate::federated_identity::{agent::Admission, assertion, FederatedIdentity};
use buzz_agent_controller::{AppAgent, Secret};
use buzz_audio_client::{
    connection::{self, AudioSocket as Socket},
    encoder::AudioEncoder,
    jitter::PeerJitterBuffer,
    wire::parse_relay_frame,
};
use futures_util::{SinkExt, StreamExt};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    future::{pending, Future},
    time::Duration,
};
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;
use tokio_tungstenite::{
    tungstenite::{client::IntoClientRequest, handshake::client::Request, Message},
    Connector,
};
use tokio_util::sync::CancellationToken;
use url::Url;

type Peers = BTreeMap<u8, String>;

pub(super) struct Connection {
    pub(super) socket: Option<Socket>,
    pub(super) peers: BTreeMap<u8, String>,
    pub(super) expires_at: Option<Instant>,
    pub(super) cancellation: CancellationToken,
    /// Set only for an agent's seat: the one place its owner filter comes from.
    pub(super) seat: Option<Seat>,
}
/// An agent's seat: it hears only `owner`, and lasts only while `admission`
/// holds, which the heartbeat rechecks.
pub(super) struct Seat {
    owner: String,
    admission: Admission,
}

fn tls_config() -> Result<std::sync::Arc<rustls::ClientConfig>> {
    static CONFIG: std::sync::OnceLock<Result<std::sync::Arc<rustls::ClientConfig>>> =
        std::sync::OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
            if roots.is_empty() {
                return Err("System TLS certificates unavailable".into());
            }
            // reqwest and the updater enable different providers. Choose explicitly,
            // rather than letting rustls panic when both providers are compiled in.
            let config = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
                rustls::crypto::aws_lc_rs::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .map_err(|_| "Huddle TLS unavailable")?
            .with_root_certificates(roots)
            .with_no_client_auth();
            Ok(std::sync::Arc::new(config))
        })
        .clone()
}

fn roster(value: &Value) -> Result<Peers> {
    Ok(connection::parse_peers(value)?
        .into_iter()
        .map(|p| (p.index, p.pubkey))
        .collect())
}
pub(super) async fn connect(
    host: &IdentityHost,
    fi: &FederatedIdentity,
    call: &Call,
    room: &str,
) -> Result<Connection> {
    connect_via(host, fi, call, room, Connector::Rustls(tls_config()?)).await
}

async fn connect_via(
    host: &IdentityHost,
    fi: &FederatedIdentity,
    call: &Call,
    room: &str,
    connector: Connector,
) -> Result<Connection> {
    let community = super::origin(&call.community)?;
    // Issued for the community's HTTPS origin and the signing identity, like
    // every other relay route; without a NIP-FI session it carries nothing.
    let authorization = super::super::evidence(host, Some(fi), &community)
        .await?
        .ok_or("Huddle authorization unavailable")?;
    let request = audio_request(&community, room, authorization.header())?;
    let expires_at = authorization
        .assertion
        .as_ref()
        .map(|assertion| assertion.expires_at);
    let cancellation = fi.authorization_cancellation(&authorization)?;
    let (socket, peers) = fi
        .during_authorization(host, &authorization, open(host, call, request, connector))
        .await??;
    ensure_authorized(expires_at, &cancellation)?;
    Ok(Connection {
        socket: Some(socket),
        peers,
        expires_at,
        cancellation,
        seat: None,
    })
}

/// Seats an agent as itself: its socket and its NIP-42 `relay` tag both come
/// from the agent's own community, with the agent's NIP-FI evidence, if any.
pub(super) async fn seat(
    agent: &AppAgent,
    key: &Secret,
    admission: Admission,
    parent: &str,
    room: &str,
) -> Result<Connection> {
    seat_via(
        agent,
        key,
        admission,
        parent,
        room,
        Connector::Rustls(tls_config()?),
    )
    .await
}

async fn seat_via(
    agent: &AppAgent,
    key: &Secret,
    admission: Admission,
    parent: &str,
    room: &str,
    connector: Connector,
) -> Result<Connection> {
    let community = Url::parse(&agent.relay).map_err(|_| "Invalid Huddle relay")?;
    let request = audio_request(&community, room, admission.header())?;
    let joined = admission
        .run(
            false,
            connection::connect(
                request,
                Some(parent),
                Some(connector),
                |challenge| async move { agent.audio_auth(key, &challenge) },
            ),
        )
        .await?;
    Ok(Connection {
        socket: Some(joined.socket),
        peers: joined
            .peers
            .into_iter()
            .map(|p| (p.index, p.pubkey))
            .collect(),
        expires_at: admission.expires_at(),
        // An agent has no NIP-FI session to retire; the heartbeat rechecks it.
        cancellation: CancellationToken::new(),
        seat: Some(Seat {
            owner: agent.owner.clone(),
            admission,
        }),
    })
}

pub(super) fn ensure_authorized(
    expires_at: Option<Instant>,
    cancellation: &CancellationToken,
) -> Result<()> {
    if cancellation.is_cancelled() {
        return Err("Huddle authorization changed. Join again to reconnect.".into());
    }
    if expires_at.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err("Huddle authorization expired. Join again to reconnect.".into());
    }
    Ok(())
}

async fn authorization_guard<T>(
    expires_at: Option<Instant>,
    cancellation: &CancellationToken,
    operation: impl Future<Output = Result<T>>,
) -> Result<T> {
    let expiry = async {
        if let Some(deadline) = expires_at {
            tokio::time::sleep_until(deadline).await;
        } else {
            pending::<()>().await;
        }
    };
    tokio::pin!(expiry);
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err("Huddle authorization changed. Join again to reconnect.".into()),
        _ = &mut expiry => Err("Huddle authorization expired. Join again to reconnect.".into()),
        result = operation => result,
    }
}

/// The audio upgrade request: `Authorization` stays NIP-98 territory, so the
/// NIP-FI assertion travels in its own header, as on the main socket.
fn audio_request(community: &Url, room: &str, assertion: Option<&str>) -> Result<Request> {
    let mut url = community.clone();
    url.set_scheme("wss").map_err(|_| "Invalid Huddle relay")?;
    url.set_path(&format!("/huddle/{room}/audio"));
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "Invalid Huddle relay")?;
    if let Some(assertion) = assertion {
        request.headers_mut().insert(
            assertion::HEADER,
            assertion
                .parse()
                .map_err(|_| "Invalid federated authorization")?,
        );
    }
    Ok(request)
}

async fn open(
    host: &IdentityHost,
    call: &Call,
    request: Request,
    connector: Connector,
) -> Result<(Socket, Peers)> {
    // Use the same origin string as the existing desktop v2 client for NIP-42.
    let relay = super::origin(&call.community)?
        .as_str()
        .trim_end_matches('/')
        .replacen("https://", "wss://", 1);
    let joined = connection::connect(
        request,
        Some(&call.parent),
        Some(connector),
        |challenge| async move {
            host.sign(template(
                22242,
                vec![
                    vec!["relay".into(), relay],
                    vec!["challenge".into(), challenge],
                ],
                String::new(),
            ))
            .await
        },
    )
    .await?;
    Ok((
        joined.socket,
        joined
            .peers
            .into_iter()
            .map(|p| (p.index, p.pubkey))
            .collect(),
    ))
}

struct Receiver {
    jitter: PeerJitterBuffer,
    last_packet: tokio::time::Instant,
}
struct Codec {
    encoder: AudioEncoder,
    receivers: BTreeMap<u8, Receiver>,
    /// The only pubkey decoded, if any. Indices are reused, so it is checked
    /// on every frame, by pubkey, before any decoder exists.
    only: Option<String>,
}
impl Codec {
    fn new(only: Option<String>) -> Result<Self> {
        Ok(Self {
            encoder: AudioEncoder::new()?,
            receivers: BTreeMap::new(),
            only,
        })
    }
    fn insert(&mut self, frame: &[u8], peers: &Peers) -> Result<()> {
        if frame.len() > 4009 {
            return Ok(());
        }
        let Some((index, header, payload)) = parse_relay_frame(frame) else {
            return Ok(());
        };
        let Some(peer) = peers.get(&index) else {
            return Ok(());
        };
        if self.only.as_ref().is_some_and(|only| only != peer) {
            return Ok(());
        }
        if let std::collections::btree_map::Entry::Vacant(entry) = self.receivers.entry(index) {
            entry.insert(Receiver {
                jitter: PeerJitterBuffer::new(index)
                    .map_err(|e| format!("Audio decoder unavailable: {e}"))?,
                last_packet: tokio::time::Instant::now(),
            });
        }
        if let Some(receiver) = self.receivers.get_mut(&index) {
            // Malformed or excessively late media must not end the call.
            if receiver
                .jitter
                .insert_packet(header.seq, header.ts_48k, payload)
                .is_ok()
            {
                receiver.last_packet = tokio::time::Instant::now();
            }
        }
        Ok(())
    }
    fn play(
        &mut self,
        peers: &Peers,
        mut emit: impl FnMut(String, Vec<f32>) -> Result<()>,
    ) -> Result<()> {
        // A person may have several devices. Each tick still carries only
        // 10 ms per person to the shared playout, never concatenated devices.
        let mut mixed: BTreeMap<String, Vec<f32>> = BTreeMap::new();
        for (index, receiver) in &mut self.receivers {
            if receiver.last_packet.elapsed() > Duration::from_millis(500)
                && receiver.jitter.is_empty()
            {
                continue;
            }
            if let Some(peer) = peers.get(index) {
                let (samples, _) = receiver
                    .jitter
                    .get_audio()
                    .map_err(|e| format!("Huddle playback failed: {e}"))?;
                match mixed.entry(peer.clone()) {
                    std::collections::btree_map::Entry::Vacant(entry) => {
                        entry.insert(samples);
                    }
                    std::collections::btree_map::Entry::Occupied(mut entry) => {
                        for (sum, sample) in entry.get_mut().iter_mut().zip(samples) {
                            *sum += sample;
                        }
                    }
                }
            }
        }
        for (peer, mut samples) in mixed {
            // Clip once after summing, so opposite-polarity sources can cancel.
            for sample in &mut samples {
                *sample = sample.clamp(-1.0, 1.0);
            }
            emit(peer, samples)?;
        }
        Ok(())
    }
    fn replace(&mut self, peers: &mut Peers, next: Peers) {
        self.receivers.retain(|i, _| peers.get(i) == next.get(i));
        *peers = next;
    }
    fn joined(&mut self, peers: &mut Peers, delta: Peers) {
        let mut next = peers.clone();
        next.extend(delta);
        self.replace(peers, next);
    }
}

pub(super) async fn run(
    mut connection: Connection,
    mut pcm: mpsc::Receiver<Vec<f32>>,
    mut stop: watch::Receiver<bool>,
    updates: &Channel<Update>,
    touched: &std::sync::atomic::AtomicU64,
) -> Result<()> {
    ensure_authorized(connection.expires_at, &connection.cancellation)?;
    let (mut sink, mut socket) = connection
        .socket
        .take()
        .ok_or("Huddle audio connection closed")?
        .split();
    let mut peers = connection.peers;
    let expires_at = connection.expires_at;
    let authorization_cancellation = connection.cancellation;
    let seat = connection.seat;
    let mut codec = Codec::new(seat.as_ref().map(|seat| seat.owner.clone()))?;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut playout = tokio::time::interval(Duration::from_millis(10));
    playout.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
    let mut last_received = tokio::time::Instant::now();
    authorization_guard(expires_at, &authorization_cancellation, async {
        // Writes queue to their own future, so a stalled send never blocks
        // receive or playout. A full queue drops the newest, as `huddle_pcm` does.
        let (out, mut outbound) = mpsc::channel(5);
        let writer = async move {
            while let Some(message) = outbound.recv().await {
                tokio::time::timeout(Duration::from_secs(2), sink.send(message)).await.map_err(|_| "Huddle connection stalled")?.map_err(|_| "Huddle disconnected")?;
            }
            let _ = sink.close().await;
            Result::Ok(())
        };
        tokio::pin!(writer);
        loop {
            if *stop.borrow() {
                break;
            }
            tokio::select! {
                biased;
                _ = stop.changed() => break,
                // Ends only on a failed send while `out` is alive.
                result = &mut writer => return result,
                // Cleanup must not be starved by a continuously ready audio stream.
                // Admit the finite real-time packet backlog before catch-up pulls.
                // Stop/heartbeat still preempt; socket input already precedes mic input.
                _ = heartbeat.tick() => {
                    super::check_cancelled(&stop, touched)?;
                    if let Some(seat) = &seat { seat.admission.dispatch()?; }
                    if last_received.elapsed() > Duration::from_secs(30) { return Err("Huddle connection timed out. You can join again.".into()); }
                    let _ = out.try_send(Message::Ping(now().to_be_bytes().to_vec().into()));
                }
                packet = socket.next() => {
                    last_received = tokio::time::Instant::now();
                    match packet {
                        Some(Ok(Message::Binary(frame))) => {
                            codec.insert(&frame, &peers)?;
                        }
                        Some(Ok(Message::Text(text))) => {
                            let value: Value = serde_json::from_str(&text).map_err(|_| "Invalid Huddle update")?;
                            match value["type"].as_str() {
                                Some("joined") => {
                                    // Mesh joins are deltas. Preserve already connected peers.
                                    codec.joined(&mut peers, roster(&value)?);
                                }
                                Some("roster") => {
                                    let next = roster(&value)?;
                                    codec.replace(&mut peers, next);
                                }
                                Some("left") => {
                                    if let Some(i) = value["peer_index"].as_u64().filter(|i| *i <= 255) {
                                        peers.remove(&(i as u8));
                                        codec.receivers.remove(&(i as u8));
                                    }
                                }
                                Some("error") => return Err("The relay ended this Huddle connection".into()),
                                _ => continue,
                            }
                            updates.send(Update::Participants {participants:peers.values().cloned().collect()}).map_err(|_| "Huddle view closed")?;
                        }
                        Some(Ok(Message::Ping(bytes))) => {
                            let _ = out.try_send(Message::Pong(bytes));
                        }
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Err("Huddle disconnected. You can join again.".into()),
                        _ => {},
                    }
                }
                scheduled = playout.tick() => {
                    codec.play(&peers, |peer, samples| updates.send(Update::Audio { peer, samples }).map_err(|_| "Huddle view closed".into()))?;
                    // Let socket I/O progress between overdue pulls before polling input again.
                    if tokio::time::Instant::now().saturating_duration_since(scheduled)
                        >= Duration::from_millis(10)
                    {
                        tokio::task::yield_now().await;
                    }
                }
                samples = pcm.recv() => {
                    let Some(samples) = samples else { break; };
                    let frame = codec.encoder.encode(&samples)?;
                    let _ = out.try_send(Message::Binary(frame.into()));
                }
            }
        }
        // Stop still sends what was accepted (at most five messages and the one
        // in flight), then closes, all within the old close bound.
        drop(out);
        let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_audio_client::encoder::FRAME_SAMPLES;
    use futures_util::Sink;
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };
    use tokio::sync::oneshot;

    struct PendingSendSink {
        started: Option<oneshot::Sender<()>>,
        release: oneshot::Receiver<()>,
        queued: bool,
    }

    impl Sink<Message> for PendingSendSink {
        type Error = std::convert::Infallible;

        fn poll_ready(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(
            mut self: Pin<&mut Self>,
            _: Message,
        ) -> std::result::Result<(), Self::Error> {
            self.queued = true;
            Ok(())
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            context: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>> {
            let this = self.get_mut();
            if let Some(started) = this.started.take() {
                let _ = started.send(());
            }
            if !this.queued {
                return Poll::Ready(Ok(()));
            }
            match Pin::new(&mut this.release).poll(context) {
                Poll::Pending => Poll::Pending,
                Poll::Ready(_) => {
                    this.queued = false;
                    Poll::Ready(Ok(()))
                }
            }
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    async fn pending_send_error(expire: bool) -> String {
        let (started, mut observed) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let mut socket = PendingSendSink {
            started: Some(started),
            release: released,
            queued: false,
        };
        let cancellation = CancellationToken::new();
        let expires_at = expire.then(|| Instant::now() + Duration::from_secs(1));
        let result = {
            let sending = authorization_guard(expires_at, &cancellation, async {
                tokio::time::timeout(
                    Duration::from_secs(2),
                    socket.send(Message::Ping(vec![1].into())),
                )
                .await
                .map_err(|_| "Huddle connection stalled")?
                .map_err(|_| "Huddle disconnected")?;
                Ok(())
            });
            tokio::pin!(sending);
            tokio::select! {
                biased;
                _ = &mut observed => {},
                result = &mut sending => panic!("fixture send completed before its gate opened: {result:?}"),
            }
            if expire {
                tokio::time::advance(Duration::from_secs(1)).await;
            } else {
                cancellation.cancel();
            }
            let completion = tokio::time::timeout(Duration::from_secs(1), &mut sending);
            tokio::pin!(completion);
            tokio::select! {
                biased;
                result = &mut completion => result.expect("authorization retirement must interrupt the pending send"),
                _ = tokio::time::advance(Duration::from_secs(1)) => panic!("pending send ignored authorization retirement"),
            }
        };
        assert!(socket.queued, "the send reached the gated flush boundary");
        release.send(()).expect("release the fixture send gate");
        drop(socket);
        result.unwrap_err()
    }

    #[tokio::test(start_paused = true)]
    async fn expiry_and_session_retirement_abort_a_pending_audio_send() {
        assert_eq!(
            pending_send_error(true).await,
            "Huddle authorization expired. Join again to reconnect."
        );
        assert_eq!(
            pending_send_error(false).await,
            "Huddle authorization changed. Join again to reconnect."
        );
    }

    async fn active_call_error(expire: bool) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (started, observed) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut started = Some(started);
            while let Some(frame) = socket.next().await {
                match frame {
                    Ok(Message::Ping(payload)) => {
                        if let Some(started) = started.take() {
                            let _ = started.send(());
                        }
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .unwrap();
        let deadline = expire.then(|| Instant::now() + Duration::from_secs(1));
        let authorization_cancellation = CancellationToken::new();
        let retire = authorization_cancellation.clone();
        let (_pcm_sender, pcm) = mpsc::channel(1);
        let (_stop_sender, stop) = watch::channel(false);
        let updates = Channel::new(|_| Ok(()));
        let touched =
            std::sync::Arc::new(std::sync::atomic::AtomicU64::new(super::super::lease_time()));
        let run = tokio::spawn(async move {
            run(
                Connection {
                    socket: Some(socket),
                    peers: Peers::new(),
                    expires_at: deadline,
                    cancellation: authorization_cancellation,
                    seat: None,
                },
                pcm,
                stop,
                &updates,
                &touched,
            )
            .await
        });
        observed.await.unwrap();
        if expire {
            tokio::time::advance(Duration::from_secs(2)).await;
        } else {
            retire.cancel();
        }
        let error = run.await.unwrap().unwrap_err();
        server.await.unwrap();
        error
    }

    #[tokio::test(start_paused = true)]
    async fn established_audio_stops_at_assertion_expiry_and_session_retirement() {
        assert_eq!(
            active_call_error(true).await,
            "Huddle authorization expired. Join again to reconnect."
        );
        assert_eq!(
            active_call_error(false).await,
            "Huddle authorization changed. Join again to reconnect."
        );
    }

    /// An agent of owner `b…` in `relay`, attested by a fixed `auth` tag.
    fn agent(key: &Secret, relay: String) -> AppAgent {
        serde_json::from_value(json!({
            "pubkey": key.pubkey(), "relay": relay, "owner": "b".repeat(64),
            "auth": r#"["auth","owner","conditions","sig"]"#, "type": "p/t", "name": "Ada"
        }))
        .unwrap()
    }

    /// An agent's seat ends at its next heartbeat once the agent is deleted or
    /// leaves the community; it has no session to retire it sooner.
    #[tokio::test]
    async fn a_seat_ends_when_its_agent_is_removed() {
        use crate::federated_identity::agent::AgentTokens;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(frame)) = socket.next().await {
                if matches!(frame, Message::Close(_)) {
                    break;
                }
            }
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .unwrap();
        let key = Secret::generate().unwrap();
        let agent = agent(&key, "wss://relay.example".into());
        let tokens = AgentTokens::unconfigured();
        let stamp = tokens.stamp(&agent.pubkey, &agent.relay).unwrap();
        let admission = tokens.authorize(&agent, &key, stamp).await.unwrap();
        tokens.forget_row(&agent.pubkey, &agent.relay).unwrap();
        let (_pcm, pcm) = mpsc::channel(1);
        let (_stop, stop) = watch::channel(false);
        let touched =
            std::sync::Arc::new(std::sync::atomic::AtomicU64::new(super::super::lease_time()));
        let connection = Connection {
            socket: Some(socket),
            peers: Peers::new(),
            expires_at: None,
            cancellation: CancellationToken::new(),
            seat: Some(Seat {
                owner: agent.owner,
                admission,
            }),
        };
        let ended = tokio::time::timeout(
            Duration::from_secs(5),
            run(connection, pcm, stop, &Channel::new(|_| Ok(())), &touched),
        )
        .await
        .expect("a removed agent kept its seat");
        assert_eq!(ended.unwrap_err(), "This agent was deleted");
        drop(server);
    }

    #[test]
    fn the_audio_upgrade_carries_the_assertion_only_in_its_own_header() {
        let community = Url::parse("https://relay.example/").unwrap();
        let request = audio_request(&community, "room", Some("Bearer jwt")).unwrap();
        assert_eq!(request.uri(), "wss://relay.example/huddle/room/audio");
        assert_eq!(request.headers()[assertion::HEADER], "Bearer jwt");
        assert!(request.headers().get("authorization").is_none());

        // Without a NIP-FI session the upgrade is exactly the old bare URL.
        let bare = audio_request(&community, "room", None).unwrap();
        assert!(bare.headers().get(assertion::HEADER).is_none());
        assert!(bare.headers().get("authorization").is_none());
    }
    mod wire {
        use super::*;
        use crate::federated_identity::testing;
        use std::sync::Arc;
        use tokio::{
            io::AsyncReadExt,
            net::{TcpListener, TcpStream},
            sync::oneshot,
        };
        use tokio_rustls::{server::TlsStream, TlsAcceptor};
        use tokio_tungstenite::{tungstenite::handshake::server, WebSocketStream};

        const FAILURE_BOUND: Duration = Duration::from_secs(5);

        type Stream = TlsStream<TcpStream>;

        /// A loopback TLS relay; `tls()` gives the client connector trusting only it.
        struct Relay(TcpListener, TlsAcceptor);
        impl Relay {
            async fn accept(&self) -> Stream {
                let (tcp, _) = self.0.accept().await.unwrap();
                self.1.accept(tcp).await.unwrap()
            }
        }
        fn tls() -> (TlsAcceptor, Connector) {
            let cert = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
            let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
            let server = rustls::ServerConfig::builder_with_provider(provider.clone())
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(
                    vec![cert.cert.der().clone()],
                    rustls::pki_types::PrivateKeyDer::Pkcs8(
                        cert.signing_key.serialize_der().into(),
                    ),
                )
                .unwrap();
            let mut roots = rustls::RootCertStore::empty();
            roots.add(cert.cert.der().clone()).unwrap();
            let client = rustls::ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(roots)
                .with_no_client_auth();
            (
                TlsAcceptor::from(Arc::new(server)),
                Connector::Rustls(Arc::new(client)),
            )
        }

        /// A loopback community on a non-default port. `required` is whether its
        /// discovery demands NIP-FI; the session starts signed in.
        async fn community(
            required: bool,
        ) -> (
            Relay,
            Connector,
            IdentityHost,
            FederatedIdentity,
            Call,
            String,
            (String, tokio::task::JoinHandle<Vec<String>>),
        ) {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let (acceptor, connector) = tls();
            let relay = format!("wss://{}", listener.local_addr().unwrap());
            let host = IdentityHost::fixture();
            let viewer = host.viewer().await.unwrap();
            let (issuer, token, bodies) = testing::issuer(&viewer, &relay).await;
            let fi = testing::signed_in(issuer, &relay, required);
            let call = Call {
                id: uuid::Uuid::new_v4().to_string(),
                community: format!("https://{}/", &relay[6..]),
                viewer,
                parent: uuid::Uuid::new_v4().to_string(),
                room: None,
                agent: None,
            };
            (
                Relay(listener, acceptor),
                connector,
                host,
                fi,
                call,
                relay,
                (token, bodies),
            )
        }

        async fn upgrade(
            relay: &Relay,
        ) -> (
            WebSocketStream<Stream>,
            String,
            tokio_tungstenite::tungstenite::http::HeaderMap,
        ) {
            let stream = relay.accept().await;
            let (seen, head) = std::sync::mpsc::channel();
            // tungstenite fixes the callback's error type.
            #[allow(clippy::result_large_err)]
            let socket = tokio_tungstenite::accept_hdr_async(
                stream,
                move |request: &server::Request, response: server::Response| {
                    seen.send((request.uri().to_string(), request.headers().clone()))
                        .unwrap();
                    Ok(response)
                },
            )
            .await
            .unwrap();
            let (uri, headers) = head.recv().unwrap();
            (socket, uri, headers)
        }

        async fn send(socket: &mut WebSocketStream<Stream>, value: Value) {
            socket
                .send(Message::Text(value.to_string().into()))
                .await
                .unwrap();
        }

        /// The relay half of a successful join; returns the client's auth message.
        async fn admit(socket: &mut WebSocketStream<Stream>, viewer: &str) -> Value {
            send(
                socket,
                json!({"type":"challenge","challenge":"relay-challenge"}),
            )
            .await;
            let Some(Ok(Message::Text(auth))) = socket.next().await else {
                panic!("expected the NIP-42 auth message");
            };
            send(
                socket,
                json!({"type":"joined","peer_index":0,"peers":[{"peer_index":0,"pubkey":viewer}]}),
            )
            .await;
            serde_json::from_str(&auth).unwrap()
        }

        #[tokio::test]
        async fn connect_sends_the_community_assertion_and_signs_nip42_with_the_same_key() {
            let (listener, connector, host, fi, call, relay, (token, issued)) =
                community(true).await;
            let connecting = connect_via(&host, &fi, &call, "room", connector);
            let relay_side = async {
                let (mut socket, uri, headers) = upgrade(&listener).await;
                (admit(&mut socket, &call.viewer).await, uri, headers)
            };
            let (joined, (auth, uri, headers)) = tokio::join!(connecting, relay_side);
            let joined = joined.unwrap();
            assert!(joined.socket.is_some());
            assert_eq!(joined.peers, Peers::from([(0, call.viewer.clone())]));
            assert!(joined.expires_at.is_some());
            assert!(!joined.cancellation.is_cancelled());

            let requested: Value = serde_json::from_str(&issued.await.unwrap()[0]).unwrap();
            assert_eq!(
                requested["relay_url"], relay,
                "issued for the community origin and port"
            );
            assert_eq!(uri, "/huddle/room/audio");
            assert_eq!(
                headers["host"],
                &relay[6..],
                "the community's host and port"
            );
            assert_eq!(headers[assertion::HEADER], format!("Bearer {token}"));
            assert!(headers.get("authorization").is_none());

            let event: nostr::event::Event = serde_json::from_value(auth["event"].clone()).unwrap();
            event.verify().unwrap();
            assert_eq!(
                event.pubkey.to_hex(),
                call.viewer,
                "NIP-42 signed by the asserted key"
            );
            let event = serde_json::to_value(event).unwrap();
            assert_eq!(event["kind"], 22242);
            assert_eq!(
                event["tags"],
                json!([["relay", relay], ["challenge", "relay-challenge"]])
            );
            assert_eq!(auth["parent_channel_id"], call.parent);
        }

        #[tokio::test]
        async fn connect_without_a_required_session_sends_no_assertion() {
            let (listener, connector, host, fi, call, _, _) = community(false).await;
            fi.sign_out_for_test();
            let connecting = connect_via(&host, &fi, &call, "room", connector);
            let relay_side = async {
                let (mut socket, _, headers) = upgrade(&listener).await;
                admit(&mut socket, &call.viewer).await;
                headers
            };
            let (joined, headers) = tokio::join!(connecting, relay_side);
            joined.unwrap();
            assert!(headers.get(assertion::HEADER).is_none());
            assert!(headers.get("authorization").is_none());
        }

        /// Signed out of an advertising community, the huddle connects plainly
        /// and the relay decides (a shadow relay admits it).
        #[tokio::test]
        async fn signed_out_connects_plainly_to_an_advertising_relay() {
            let (listener, connector, host, fi, call, _, _) = community(true).await;
            fi.sign_out_for_test();
            let connecting = connect_via(&host, &fi, &call, "room", connector);
            let relay_side = async {
                let (mut socket, _, headers) = upgrade(&listener).await;
                admit(&mut socket, &call.viewer).await;
                headers
            };
            let (joined, headers) = tokio::join!(connecting, relay_side);
            joined.unwrap();
            assert!(headers.get(assertion::HEADER).is_none());
            assert!(headers.get("authorization").is_none());
        }

        /// An agent's seat signs NIP-42 as the agent, for its own community,
        /// with its owner's attestation, and is born filtering for that owner.
        #[tokio::test]
        async fn an_agent_seat_signs_as_itself_and_hears_only_its_owner() {
            use crate::federated_identity::agent::AgentTokens;
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let (acceptor, connector) = tls();
            let listener = Relay(listener, acceptor);
            let key = Secret::generate().unwrap();
            let agent = agent(&key, format!("wss://{}", listener.0.local_addr().unwrap()));
            let tokens = AgentTokens::unconfigured();
            let stamp = tokens.stamp(&agent.pubkey, &agent.relay).unwrap();
            let admission = tokens.authorize(&agent, &key, stamp).await.unwrap();
            let parent = uuid::Uuid::new_v4().to_string();
            let seating = seat_via(&agent, &key, admission, &parent, "room", connector);
            let relay_side = async {
                let (mut socket, uri, headers) = upgrade(&listener).await;
                (
                    admit(&mut socket, &agent.pubkey).await,
                    uri,
                    headers,
                    socket,
                )
            };
            let (seated, (auth, uri, headers, socket)) = tokio::join!(seating, relay_side);
            let seated = seated.unwrap();
            assert_eq!(uri, "/huddle/room/audio");
            assert!(headers.get(assertion::HEADER).is_none(), "a plain relay");
            assert_eq!(
                seated.seat.as_ref().map(|seat| &seat.owner),
                Some(&agent.owner)
            );

            let event: nostr::event::Event = serde_json::from_value(auth["event"].clone()).unwrap();
            event.verify().unwrap();
            assert_eq!(event.pubkey.to_hex(), agent.pubkey);
            let event = serde_json::to_value(event).unwrap();
            assert_eq!(
                event["tags"],
                json!([
                    ["relay", agent.relay],
                    ["challenge", "relay-challenge"],
                    ["auth", "owner", "conditions", "sig"]
                ])
            );
            assert_eq!(auth["parent_channel_id"], parent);

            // Seated, it plays its owner and never the stranger beside them.
            let (owner, stranger) = (agent.owner.clone(), "c".repeat(64));
            let heard = Arc::new(std::sync::Mutex::new(Vec::new()));
            let updates = Channel::new({
                let heard = heard.clone();
                move |body| {
                    let tauri::ipc::InvokeResponseBody::Json(json) = body else {
                        panic!("updates are JSON");
                    };
                    let update: Value = serde_json::from_str(&json).unwrap();
                    if update["type"] == "audio" {
                        heard
                            .lock()
                            .unwrap()
                            .push(update["peer"].as_str().unwrap().to_owned());
                    }
                    Ok(())
                }
            });
            let (_pcm, pcm) = mpsc::channel(1);
            let (stop, stopped) = watch::channel(false);
            let touched = Arc::new(std::sync::atomic::AtomicU64::new(
                super::super::super::lease_time(),
            ));
            let mut relay = socket;
            let playing = run(seated, pcm, stopped, &updates, &touched);
            let relay_side = async {
                send(
                    &mut relay,
                    json!({"type":"joined","peers":[
                    {"peer_index":1,"pubkey":owner},{"peer_index":2,"pubkey":stranger}]}),
                )
                .await;
                let mut encoder = AudioEncoder::new().unwrap();
                for index in [2, 1] {
                    let frame = encoder.encode(&vec![0.1; FRAME_SAMPLES]).unwrap();
                    relay
                        .send(Message::Binary([vec![index], frame].concat().into()))
                        .await
                        .unwrap();
                }
                tokio::time::timeout(FAILURE_BOUND, async {
                    while heard.lock().unwrap().len() < 3 {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .expect("the owner was never heard");
                stop.send(true).unwrap();
            };
            let (played, ()) = tokio::join!(playing, relay_side);
            played.unwrap();
            assert!(heard.lock().unwrap().iter().all(|peer| *peer == owner));
        }

        /// In its organization's community, a seat's upgrade carries exactly
        /// the agent's own assertion, minted for that community.
        #[tokio::test]
        async fn an_agent_seat_carries_its_own_assertion_to_its_community() {
            use crate::federated_identity::agent::tests::{enrolled, fixture_at, issued, issuer};
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let (acceptor, connector) = tls();
            let listener = Relay(listener, acceptor);
            let authority = listener.0.local_addr().unwrap().to_string();
            let probe = fixture_at("http://unused".into(), &authority);
            let minted = issued(&probe.agent, json!({"aud": format!("https://{authority}")}));
            let token = minted["assertion"].as_str().unwrap().to_owned();
            let (base, served) =
                issuer(vec![(200, enrolled(&probe.agent.owner)), (200, minted)]).await;
            let f = fixture_at(base, &authority);
            let (agent, key) = (probe.agent, probe.key);
            let stamp = f.tokens.stamp(&agent.pubkey, &agent.relay).unwrap();
            let admission = f.tokens.authorize(&agent, &key, stamp).await.unwrap();
            served.await.unwrap();
            let parent = uuid::Uuid::new_v4().to_string();
            let seating = seat_via(&agent, &key, admission, &parent, "room", connector);
            let relay_side = async {
                let (mut socket, _, headers) = upgrade(&listener).await;
                admit(&mut socket, &agent.pubkey).await;
                headers
            };
            let (seated, headers) = tokio::join!(seating, relay_side);
            assert!(seated.unwrap().expires_at.is_some());
            let carried: Vec<_> = headers.get_all(assertion::HEADER).iter().collect();
            assert_eq!(carried, [format!("Bearer {token}").as_str()]);
            assert!(headers.get("authorization").is_none());
        }

        /// Retire the session at `gate`, then let the relay continue: the retired
        /// connect must end without authenticating or returning a socket.
        async fn retired_at(gate: &str, retire: impl FnOnce(&FederatedIdentity)) {
            let (listener, connector, host, fi, call, _, _) = community(true).await;
            let connecting = connect_via(&host, &fi, &call, "room", connector);
            tokio::pin!(connecting);
            let (reached, at_gate) = oneshot::channel();
            let (release, released) = oneshot::channel::<()>();
            let relay_side = tokio::spawn({
                let gate = gate.to_owned();
                async move {
                    if gate == "upgrade" {
                        // The upgrade request has arrived; withhold the response.
                        let mut stream = listener.accept().await;
                        let mut head = Vec::new();
                        while !head.ends_with(b"\r\n\r\n") {
                            head.push(stream.read_u8().await.unwrap());
                        }
                        reached.send(()).unwrap();
                        released.await.unwrap();
                        let mut rest = Vec::new();
                        // EOF: the client hung up instead of waiting.
                        let _ = stream.read_to_end(&mut rest).await;
                        rest.is_empty()
                    } else {
                        // Upgraded; the client now waits for the challenge.
                        let (mut socket, _, _): (WebSocketStream<Stream>, _, _) =
                            upgrade(&listener).await;
                        reached.send(()).unwrap();
                        released.await.unwrap();
                        let _ = socket
                            .send(Message::Text(
                                json!({"type":"challenge","challenge":"late"})
                                    .to_string()
                                    .into(),
                            ))
                            .await;
                        !matches!(socket.next().await, Some(Ok(Message::Text(_))))
                    }
                }
            });
            tokio::select! {
                _ = at_gate => {}
                result = &mut connecting => panic!("connect ended before the {gate} gate: {:?}", result.map(|_| ())),
            }
            retire(&fi);
            let result = tokio::time::timeout(FAILURE_BOUND, &mut connecting)
                .await
                .unwrap_or_else(|_| panic!("retired connect at the {gate} gate kept waiting"));
            assert_eq!(
                result.map(|_| ()).unwrap_err(),
                "Federated authorization changed"
            );
            release.send(()).unwrap();
            let silent = tokio::time::timeout(FAILURE_BOUND, relay_side)
                .await
                .unwrap()
                .unwrap();
            assert!(silent, "retired work sent more after the {gate} gate");
        }

        #[tokio::test]
        async fn sign_out_during_the_upgrade_ends_the_connect() {
            retired_at("upgrade", FederatedIdentity::sign_out_for_test).await;
        }

        #[tokio::test]
        async fn account_switch_during_the_upgrade_ends_the_connect() {
            retired_at("upgrade", FederatedIdentity::switch_account_for_test).await;
        }

        #[tokio::test]
        async fn sign_out_while_awaiting_the_challenge_sends_no_auth() {
            retired_at("challenge", FederatedIdentity::sign_out_for_test).await;
        }

        #[tokio::test]
        async fn account_switch_while_awaiting_the_challenge_sends_no_auth() {
            retired_at("challenge", FederatedIdentity::switch_account_for_test).await;
        }
    }

    #[test]
    fn tls_uses_an_explicit_provider_with_system_trust() {
        assert!(tls_config().is_ok());
    }

    #[test]
    fn mesh_join_delta_keeps_existing_speakers_and_reuse_clears_playout() {
        let mut codec = Codec::new(None).unwrap();
        let mut peers = BTreeMap::from([(1, "a".repeat(64)), (2, "b".repeat(64))]);
        let frame = [
            vec![1],
            codec.encoder.encode(&vec![0.1; FRAME_SAMPLES]).unwrap(),
        ]
        .concat();
        codec.insert(&frame, &peers).unwrap();
        codec.joined(
            &mut peers,
            roster(&json!({"peers":[{"peer_index":3,"pubkey":"c".repeat(64)}]})).unwrap(),
        );
        assert_eq!(peers.len(), 3);
        assert!(codec.receivers.contains_key(&1));
        let mut heard = Vec::new();
        codec
            .play(&peers, |peer, samples| {
                assert_eq!(samples.len(), 480);
                assert!(samples.iter().all(|s| s.is_finite()));
                heard.push(peer);
                Ok(())
            })
            .unwrap();
        assert_eq!(heard, vec!["a".repeat(64)]);
        codec.joined(&mut peers, BTreeMap::from([(1, "d".repeat(64))]));
        assert!(!codec.receivers.contains_key(&1));
        assert_eq!(peers.len(), 3);
        codec.insert(&frame, &peers).unwrap();
        codec.replace(&mut peers, BTreeMap::new());
        assert!(codec.receivers.is_empty());
    }

    /// A frame of `index` speaking.
    fn spoken(codec: &mut Codec, index: u8) -> Vec<u8> {
        [
            vec![index],
            codec.encoder.encode(&vec![0.1; FRAME_SAMPLES]).unwrap(),
        ]
        .concat()
    }

    #[tokio::test(start_paused = true)]
    async fn catch_up_allows_async_opus_input_between_missed_pulls() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        };
        use tokio_tungstenite::{tungstenite::protocol::Role, MaybeTlsStream, WebSocketStream};

        // A peer writer becomes runnable after the first recovery pull. This proves
        // catch-up fairness through actual socket I/O, not arrival of every TLS
        // record before recovery or a guarantee that yielding always drives I/O.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (client, relay) = tokio::join!(
            tokio::net::TcpStream::connect(listener.local_addr().unwrap()),
            listener.accept()
        );
        let socket = WebSocketStream::from_raw_socket(
            MaybeTlsStream::Plain(client.unwrap()),
            Role::Client,
            None,
        )
        .await;
        let mut relay =
            WebSocketStream::from_raw_socket(relay.unwrap().0, Role::Server, None).await;
        let mut encoder = Codec::new(None).unwrap();
        let mut sample_index = 0;
        let mut frame = move || {
            let samples: Vec<_> = (0..FRAME_SAMPLES)
                .map(|_| {
                    let sample =
                        (sample_index as f32 * 440.0 * std::f32::consts::TAU / 48000.0).sin() * 0.2;
                    sample_index += 1;
                    sample
                })
                .collect();
            [vec![1], encoder.encoder.encode(&samples).unwrap()].concat()
        };
        for _ in 0..4 {
            relay.feed(Message::Binary(frame().into())).await.unwrap();
        }
        relay.flush().await.unwrap();
        let (write, writing) = oneshot::channel();
        let writer = tokio::spawn(async move {
            writing.await.unwrap();
            for _ in 0..10 {
                relay.feed(Message::Binary(frame().into())).await.unwrap();
            }
            relay.flush().await.unwrap();
            while let Some(Ok(message)) = relay.next().await {
                if matches!(message, Message::Close(_)) {
                    break;
                }
            }
        });

        let connection = Connection {
            socket: Some(socket),
            peers: BTreeMap::from([(1, "a".repeat(64))]),
            expires_at: None,
            cancellation: CancellationToken::new(),
            seat: None,
        };
        let (_pcm, pcm) = mpsc::channel(1);
        let (stop, stopped) = watch::channel(false);
        let started = Arc::new(AtomicBool::new(false));
        let recovering = Arc::new(AtomicBool::new(false));
        let heard = Arc::new(Mutex::new(Vec::<(Instant, Vec<f32>)>::new()));
        let updates = Channel::new({
            let started = started.clone();
            let recovering = recovering.clone();
            let heard = heard.clone();
            let write = Mutex::new(Some(write));
            move |body| {
                let tauri::ipc::InvokeResponseBody::Json(json) = body else {
                    panic!("updates are JSON")
                };
                let update: Value = serde_json::from_str(&json).unwrap();
                if update["type"] == "audio" {
                    started.store(true, Ordering::SeqCst);
                    if recovering.load(Ordering::SeqCst) {
                        let mut heard = heard.lock().unwrap();
                        heard.push((
                            Instant::now(),
                            serde_json::from_value(update["samples"].clone()).unwrap(),
                        ));
                        if let Some(write) = write.lock().unwrap().take() {
                            write.send(()).unwrap();
                        }
                        if heard.len() == 20 {
                            stop.send(true).unwrap();
                        }
                    }
                }
                Ok(())
            }
        });
        let (paused, pausing) = oneshot::channel();
        let (resume, resuming) = oneshot::channel();
        let owner = tokio::spawn(async move {
            let touched = std::sync::atomic::AtomicU64::new(super::super::lease_time());
            let running = run(connection, pcm, stopped, &updates, &touched);
            tokio::pin!(running);
            // Suspend at an observable startup boundary without exposing a new
            // production pause hook. Network input has not been pre-peeked.
            std::future::poll_fn(|cx| {
                assert!(
                    running.as_mut().poll(cx).is_pending(),
                    "owner ended during startup"
                );
                if started.load(Ordering::SeqCst) {
                    Poll::Ready(())
                } else {
                    Poll::Pending
                }
            })
            .await;
            paused.send(()).unwrap();
            resuming.await.unwrap();
            running.await
        });
        pausing.await.unwrap();
        tokio::time::advance(Duration::from_millis(200)).await;
        let resumed_at = Instant::now();
        recovering.store(true, Ordering::SeqCst);
        resume.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), owner)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        {
            let heard = heard.lock().unwrap();
            assert_eq!(heard.len(), 20, "all missed pulls must run");
            assert!(
                heard.iter().all(|(at, _)| *at == resumed_at),
                "missed pulls must complete before future ticks"
            );
            let tail = &heard.last().unwrap().1;
            let rms =
                (tail.iter().map(|sample| sample * sample).sum::<f32>() / tail.len() as f32).sqrt();
            assert!(
                rms > 0.02,
                "catch-up concealed asynchronously available speech: tail RMS {rms}"
            );
        }
        writer.await.unwrap();
    }

    /// A relay that is not reading yet, and a client whose next send blocks:
    /// both kernel buffers and its WebSocket write buffer are full of large
    /// filler messages, so the stream stays valid for when the relay reads.
    async fn stalled() -> (
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        Socket,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (client, relay) = tokio::join!(
            tokio::net::TcpStream::connect(listener.local_addr().unwrap()),
            listener.accept()
        );
        let (relay, socket) = tokio::join!(
            tokio_tungstenite::accept_async(relay.unwrap().0),
            tokio_tungstenite::client_async(
                "ws://relay/",
                tokio_tungstenite::MaybeTlsStream::Plain(client.unwrap()),
            )
        );
        let (relay, mut socket) = (relay.unwrap(), socket.unwrap().0);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let filler = Message::Binary(vec![0; 65536].into());
            match tokio::time::timeout(Duration::from_millis(100), socket.feed(filler)).await {
                Ok(fed) => fed.unwrap(),
                Err(_) => break,
            }
            assert!(Instant::now() < deadline, "the client's send never blocked");
        }
        (relay, socket)
    }

    #[tokio::test]
    async fn a_stalled_write_does_not_stall_playout() {
        // The relay keeps speaking but never reads, so every send blocks.
        // Playout must keep pulling meanwhile.
        let (mut relay, socket) = stalled().await;
        let speaker = tokio::spawn(async move {
            let mut codec = Codec::new(None).unwrap();
            loop {
                let frame = spoken(&mut codec, 1);
                if relay.send(Message::Binary(frame.into())).await.is_err() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        });
        let (mic, pcm) = mpsc::channel(1);
        let talker = tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(1));
            while mic.send(vec![0.3; FRAME_SAMPLES]).await.is_ok() {
                tick.tick().await;
            }
        });
        let heard = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let updates = Channel::new({
            let heard = heard.clone();
            move |body| {
                let tauri::ipc::InvokeResponseBody::Json(json) = body else {
                    panic!("updates are JSON")
                };
                if json.contains(r#""type":"audio""#) {
                    heard.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                Ok(())
            }
        });
        let (stop, stopped) = watch::channel(false);
        let touched = std::sync::atomic::AtomicU64::new(super::super::lease_time());
        let connection = Connection {
            socket: Some(socket),
            peers: BTreeMap::from([(1, "a".repeat(64))]),
            expires_at: None,
            cancellation: CancellationToken::new(),
            seat: None,
        };
        let running = run(connection, pcm, stopped, &updates, &touched);
        tokio::pin!(running);
        let _ = tokio::time::timeout(Duration::from_secs(1), &mut running).await;
        let pulls = heard.load(std::sync::atomic::Ordering::SeqCst);
        stop.send(true).unwrap();
        let _ = running.await;
        talker.abort();
        speaker.abort();
        // 100 pulls are due in 1 s; a blocked send loop delivers a handful.
        assert!(
            pulls >= 50,
            "playout stalled behind a blocked send: {pulls} pulls in 1 s"
        );
    }

    #[tokio::test]
    async fn outbound_recovers_after_a_stalled_write() {
        use buzz_audio_client::wire::FrameHeader;
        let (mut relay, socket) = stalled().await;
        let (mic, pcm) = mpsc::channel(1);
        let (stop, stopped) = watch::channel(false);
        let (roster, mut rostered) = mpsc::unbounded_channel();
        let updates = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                if json.contains(r#""type":"participants""#) {
                    let _ = roster.send(());
                }
            }
            Ok(())
        });
        let running = tokio::spawn(async move {
            let touched = std::sync::atomic::AtomicU64::new(super::super::lease_time());
            let connection = Connection {
                socket: Some(socket),
                peers: Peers::new(),
                expires_at: None,
                cancellation: CancellationToken::new(),
                seat: None,
            };
            run(connection, pcm, stopped, &updates, &touched).await
        });
        let wire = |frame: &[u8]| {
            let (header, _) = FrameHeader::parse(frame).unwrap();
            assert_eq!(header.ts_48k, header.seq as u32 * FRAME_SAMPLES as u32);
            header.seq
        };
        let mut seqs = Vec::new();
        // The heartbeat's Ping, as the number of frames the relay read before it.
        let mut ping = None;
        let recovered = async {
            // The relay reads nothing yet, so one send stays in flight and five
            // messages fill the queue. Sending frame k+1 waits until the loop
            // has taken frame k. Frames after the queue fills are encoded,
            // spending sequence numbers, and dropped.
            for _ in 0..10 {
                mic.send(vec![0.1; FRAME_SAMPLES]).await.unwrap();
            }
            // Frame 9 still waits in the channel. Once it is taken, the loop has
            // offered it to the full queue; taken later, after the relay starts
            // reading, it would find a free slot.
            drop(mic.reserve().await.unwrap());
            // The heartbeat's first tick fires about 1 ms in. Let it fire while
            // the queue is still full: the loop polls the heartbeat before the
            // socket, so by the roster update below its Ping has been offered
            // to the stalled queue, and admitted or dropped.
            tokio::time::sleep(Duration::from_millis(5)).await;
            // The socket is read in order, so the roster update proves the probe
            // was handled while the queue was still full: the explicit Pong was
            // dropped, and any probe Pong on the wire is tungstenite's own.
            relay
                .feed(Message::Ping(b"probe".to_vec().into()))
                .await
                .unwrap();
            relay
                .feed(Message::Text(r#"{"type":"roster","peers":[]}"#.into()))
                .await
                .unwrap();
            relay.flush().await.unwrap();
            rostered.recv().await.unwrap();
            let (mut ponged, mut fillers) = (false, 0);
            while seqs.len() < 5 || !ponged {
                match relay.next().await.unwrap().unwrap() {
                    Message::Binary(frame) if frame.len() == 65536 => fillers += 1,
                    Message::Binary(frame) => seqs.push(wire(&frame)),
                    Message::Ping(_) => ping = Some(seqs.len()),
                    Message::Pong(payload) => ponged |= &payload[..] == b"probe",
                    _ => {}
                }
            }
            assert!(fillers > 0);
            for _ in 0..3 {
                mic.send(vec![0.1; FRAME_SAMPLES]).await.unwrap();
            }
            while seqs.last() != Some(&12) {
                match relay.next().await.unwrap().unwrap() {
                    Message::Binary(frame) => seqs.push(wire(&frame)),
                    Message::Ping(_) => ping = Some(seqs.len()),
                    _ => {}
                }
            }
        };
        // Recovery must finish well inside the 2 s stall bound.
        tokio::time::timeout(Duration::from_millis(1500), recovered)
            .await
            .expect("outbound did not recover");
        // The stall admits six messages: the send in flight and five queued.
        // The next heartbeat is 10 s away, so a Ping read was one of the six,
        // beside frames 0-4. Otherwise it was dropped, and frames 0-5 were.
        let admitted: u16 = if ping.is_some() { 5 } else { 6 };
        assert_eq!(
            seqs,
            (0..admitted).chain(10..=12).collect::<Vec<_>>(),
            "six admitted (the Ping after {ping:?} frames), then the drop gap"
        );
        // A clean stop, here with the queue already drained, closes in bound.
        stop.send(true).unwrap();
        let closed =
            async { while !matches!(relay.next().await, Some(Ok(Message::Close(_))) | None) {} };
        tokio::time::timeout(Duration::from_secs(3), closed)
            .await
            .unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(3), running).await;
        assert_eq!(ended.unwrap().unwrap(), Ok(()));
    }

    #[test]
    fn an_agent_seat_never_decodes_anyone_but_its_owner() {
        let (owner, stranger) = ("a".repeat(64), "c".repeat(64));
        let mut codec = Codec::new(Some(owner.clone())).unwrap();
        let mut peers = BTreeMap::from([(1, owner.clone()), (2, stranger.clone())]);
        let (from_owner, from_stranger) = (spoken(&mut codec, 1), spoken(&mut codec, 2));
        codec.insert(&from_stranger, &peers).unwrap();
        assert!(codec.receivers.is_empty(), "a stranger reached a decoder");
        codec.insert(&from_owner, &peers).unwrap();
        assert_eq!(codec.receivers.keys().collect::<Vec<_>>(), [&1]);

        // The owner leaves and the stranger is given the owner's old index: the
        // filter is by pubkey, so the reused index is still not heard.
        codec.replace(&mut peers, BTreeMap::from([(1, stranger.clone())]));
        codec.insert(&from_owner, &peers).unwrap();
        assert!(
            codec.receivers.is_empty(),
            "a reused index reached a decoder"
        );
        // The owner rejoins elsewhere, also from a second device: both are heard.
        codec.joined(
            &mut peers,
            BTreeMap::from([(3, owner.clone()), (4, owner.clone())]),
        );
        for index in [1, 2, 3, 4] {
            let frame = spoken(&mut codec, index);
            codec.insert(&frame, &peers).unwrap();
        }
        assert_eq!(codec.receivers.keys().collect::<Vec<_>>(), [&3, &4]);
        let mut heard = Vec::new();
        codec
            .play(&peers, |peer, _| {
                heard.push(peer);
                Ok(())
            })
            .unwrap();
        assert_eq!(heard, [owner]);
    }

    #[test]
    fn playout_mixes_devices_per_person_and_clamps_only_the_final_sum() {
        let mut peers = BTreeMap::from([
            (1, "owner".into()),
            (2, "owner".into()),
            (3, "owner".into()),
            (4, "other".into()),
        ]);
        let mut codec = Codec::new(None).unwrap();
        let mut controls: Vec<_> = (0..4).map(|_| Codec::new(None).unwrap()).collect();
        // Two positive streams plus one inverted stream expose intermediate
        // clipping. A separate person's stream must remain separate.
        for (i, control) in controls.iter_mut().enumerate() {
            let index = (i + 1) as u8;
            for seq in 0..10 {
                let samples: Vec<_> = (0..FRAME_SAMPLES)
                    .map(|n| {
                        let phase =
                            (seq * FRAME_SAMPLES + n) as f32 * 440.0 * std::f32::consts::TAU
                                / 48000.0;
                        phase.sin() * if i == 2 { -0.5 } else { 0.9 }
                    })
                    .collect();
                let packet = [vec![index], control.encoder.encode(&samples).unwrap()].concat();
                codec.insert(&packet, &peers).unwrap();
                control.insert(&packet, &peers).unwrap();
            }
        }
        let pull = |codec: &mut Codec, peers: &Peers| {
            let mut heard = BTreeMap::new();
            codec
                .play(peers, |peer, samples| {
                    assert!(
                        heard.insert(peer, samples).is_none(),
                        "more than one frame per person per tick"
                    );
                    Ok(())
                })
                .unwrap();
            heard
        };
        let mut clipped = false;
        let mut distinguishes_intermediate_clip = false;
        for _ in 0..12 {
            let heard = pull(&mut codec, &peers);
            assert_eq!(heard.len(), 2);
            let reference: Vec<_> = controls
                .iter_mut()
                .map(|c| pull(c, &peers).into_values().next().unwrap())
                .collect();
            assert_eq!(heard["other"], reference[3]);
            assert_eq!(heard["owner"].len(), 480);
            for (i, actual) in heard["owner"].iter().enumerate() {
                let sum = reference[0][i] + reference[1][i] + reference[2][i];
                clipped |= sum.abs() > 1.0;
                let expected = sum.clamp(-1.0, 1.0);
                let premature = ((reference[0][i] + reference[1][i]).clamp(-1.0, 1.0)
                    + reference[2][i])
                    .clamp(-1.0, 1.0);
                distinguishes_intermediate_clip |= (expected - premature).abs() > 0.01;
                assert!((actual - expected).abs() < 0.00001);
            }
        }
        assert!(clipped, "fixture must exercise clipping");
        assert!(
            distinguishes_intermediate_clip,
            "fixture must expose premature clipping"
        );
        codec.replace(&mut peers, BTreeMap::from([(4, "other".into())]));
        let heard = pull(&mut codec, &peers);
        assert_eq!(heard.keys().collect::<Vec<_>>(), ["other"]);
    }

    #[test]
    fn malformed_frames_and_rosters_are_bounded() {
        assert!(roster(&json!({"peers":[{"peer_index":256,"pubkey":"a".repeat(64)}]})).is_err());
        assert!(roster(&json!({"peers":[{"peer_index":0,"pubkey":"bad"}]})).is_err());
        let mut codec = Codec::new(None).unwrap();
        for frame in [vec![0; 8], vec![0; 40010], vec![0; 50]] {
            codec.insert(&frame, &Peers::new()).unwrap();
        }
        assert!(codec.receivers.is_empty());
    }
}
