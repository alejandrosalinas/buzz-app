//! Loopback MCP servers a plugin serves to the agents it runs, over MCP's
//! Streamable HTTP transport. The listener and its token live here; each
//! JSON-RPC message is handed to the page that started the server, which
//! answers it. So a tool that signs with an agent's key runs in the app, and
//! the agent is given only the server's address and token.
//!
//! - It binds only `127.0.0.1`, on a port the OS picks. A random 256-bit token
//!   per server authorizes every request as `Authorization: Bearer <token>`.
//!   `Host` must name the bound address, and a request that sends `Origin`
//!   (a web page) is refused. Nothing is logged.
//! - The token admits one MCP session. The agent's `initialize` is answered
//!   with a random `Mcp-Session-Id`, and every later request must send it. An
//!   agent may save its server's token to disk (goose does), so a token read
//!   from there is useless once the agent connected. Before then, only
//!   `initialize`, `server/discover` and `ping` are answered. A second
//!   `initialize` means two clients hold the token, so the server stops: the
//!   one that claimed the session may not be the agent.
//! - A plugin can explicitly opt into a shared session for cooperating clients.
//!   Every client holding the token can initialize and obtain the same session
//!   ID. This forfeits stolen-token replay protection; use only when the handler
//!   fixes the identity and all clients intentionally share its authority.
//! - A refused request gets 404, never 401 or 403: MCP clients answer those
//!   by starting an OAuth sign-in.
//! - It answers in JSON, never SSE. `POST /mcp` carries one message: a request
//!   is answered with the page's reply, and a notification or response with
//!   202. `GET` and `DELETE` get 405: there is no server stream, and the
//!   session ends with the server.
//! - Each connection answers one request and closes. A client that closes
//!   before its answer drops the request; the page's late reply is refused.
//! - A server belongs to the plugin and the page that started it. It stops
//!   when the plugin closes it, when the page reloads, or when the app exits.
use crate::{loopback, with_manager, PluginManager};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{self, HeaderName};
use hyper::{Method, Request, Response, StatusCode};
use serde::Serialize;
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
mod authorization;
pub(crate) use authorization::plugin_host_mcp_authorize;
pub(crate) mod pairing;
pub(crate) use pairing::plugin_host_mcp_pairing;

/// Servers running at once across all plugins.
const MAX_SERVERS: usize = 64;
const BODY_LIMIT: usize = 4 * 1024 * 1024;
const BODY_TIMEOUT: Duration = Duration::from_secs(30);
const REPLY_LIMIT: usize = 16 * 1024 * 1024;
const ENDPOINT: &str = "/mcp";
const SESSION: HeaderName = HeaderName::from_static("mcp-session-id");
const UNCLAIMED: u8 = 0;
const CLAIMING: u8 = 1;
const CLAIMED: u8 = 2;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum McpEvent {
    /// One JSON-RPC message, answered with `plugin_host_mcp_reply` naming
    /// `request`.
    Message { request: u64, body: String },
    /// The last event: the server stopped.
    Closed,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerInfo {
    handle: u64,
    /// `http://127.0.0.1:<port>/mcp`
    url: String,
    /// Sent by the agent as `Authorization: Bearer <token>`.
    token: String,
}

struct Shared {
    authority: String,
    token: String,
    /// The `Mcp-Session-Id` of the one session the token admits.
    session: String,
    /// `UNCLAIMED`, `CLAIMING` while an `initialize` waits for its answer, or
    /// `CLAIMED` once one succeeded.
    claim: AtomicU8,
    /// Explicitly let clients holding the token join the same session.
    shared_session: bool,
    authorization: Mutex<Option<authorization::Exchange>>,
    pairing: Mutex<Option<pairing::Grant>>,
    pairing_pending: AtomicBool,
    events: Channel<McpEvent>,
    stop: CancellationToken,
    pending: Mutex<Pending>,
}
#[derive(Default)]
struct Pending {
    next: u64,
    replies: HashMap<u64, oneshot::Sender<Option<String>>>,
}
impl Shared {
    fn pending(&self) -> MutexGuard<'_, Pending> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

struct Entry {
    plugin: String,
    shared: Arc<Shared>,
}

#[derive(Clone, Default)]
pub(crate) struct HostMcpServers {
    inner: Arc<Mutex<Registry>>,
}
#[derive(Default)]
struct Registry {
    next: u64,
    /// Counts page loads, so a server the page asked for before it reloaded
    /// is refused rather than left running with nobody answering.
    page: u64,
    entries: HashMap<u64, Entry>,
}
impl HostMcpServers {
    fn registry(&self) -> MutexGuard<'_, Registry> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
    fn owned(&self, plugin: &str, handle: u64) -> Result<Arc<Shared>, String> {
        match self.registry().entries.get(&handle) {
            Some(entry) if entry.plugin == plugin => Ok(entry.shared.clone()),
            _ => Err("No such MCP server".into()),
        }
    }
    /// The current page load, for `serve`.
    pub(crate) fn page(&self) -> u64 {
        self.registry().page
    }
    /// Starts a server owned by `plugin` whose messages go to `events`, unless
    /// the page that asked during `page` has since gone.
    fn serve(
        &self,
        page: u64,
        plugin: String,
        events: Channel<McpEvent>,
        shared_session: bool,
    ) -> Result<McpServerInfo, String> {
        let mut registry = self.registry();
        if registry.page != page {
            return Err("The page reloaded".into());
        }
        if registry.entries.len() >= MAX_SERVERS {
            return Err("Too many MCP servers are running".into());
        }
        let failed = |_| "Could not start the MCP server".to_owned();
        let (listener, authority) = loopback::bind().map_err(failed)?;
        let secret = || {
            let mut secret = [0; 32];
            getrandom::fill(&mut secret).map_err(|_| "Could not start the MCP server")?;
            Ok::<_, &str>(URL_SAFE_NO_PAD.encode(secret))
        };
        let token = secret()?;
        let shared = Arc::new(Shared {
            authority: authority.clone(),
            token: token.clone(),
            session: secret()?,
            claim: AtomicU8::new(UNCLAIMED),
            shared_session,
            authorization: Mutex::new(None),
            pairing: Mutex::new(None),
            pairing_pending: AtomicBool::new(false),
            events,
            stop: CancellationToken::new(),
            pending: Mutex::default(),
        });
        let handle = registry.next;
        registry.next += 1;
        registry.entries.insert(
            handle,
            Entry {
                plugin,
                shared: shared.clone(),
            },
        );
        drop(registry);
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            let answer = {
                let shared = shared.clone();
                move |request| {
                    let shared = shared.clone();
                    async move { answer(&shared, request).await }
                }
            };
            loopback::serve(listener, shared.stop.clone(), answer).await;
            state.registry().entries.remove(&handle);
            // Requests still waiting are answered 503 as their senders drop.
            shared.pending().replies.clear();
            let _ = shared.events.send(McpEvent::Closed);
        });
        Ok(McpServerInfo {
            handle,
            url: format!("http://{authority}{ENDPOINT}"),
            token,
        })
    }
    /// Answers `request` with `body`, or with 202 when there is none.
    fn reply(
        &self,
        plugin: &str,
        handle: u64,
        request: u64,
        body: Option<String>,
    ) -> Result<(), String> {
        if body.as_ref().is_some_and(|body| body.len() > REPLY_LIMIT) {
            return Err("Reply is too large".into());
        }
        let shared = self.owned(plugin, handle)?;
        let sender = shared.pending().replies.remove(&request);
        sender
            .ok_or("The request is no longer waiting")?
            .send(body)
            .map_err(|_| "The request is no longer waiting".into())
    }
    fn close(&self, plugin: &str, handle: u64) -> Result<(), String> {
        self.owned(plugin, handle)?.stop.cancel();
        Ok(())
    }
    /// Stops every server: the page that answered them is gone.
    pub(crate) fn stop_all(&self) {
        let mut registry = self.registry();
        registry.page += 1;
        for entry in registry.entries.values() {
            entry.shared.stop.cancel();
        }
    }
}

async fn answer(
    shared: &Arc<Shared>,
    request: Request<Incoming>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    if request.uri().path() == "/authorize/exchange" {
        return Ok(authorization::exchange(shared, request).await);
    }
    let (status, body, joined) = match refuse(shared, &request) {
        Err(status) => (status, None, false),
        Ok(named) => {
            let body = Limited::new(request.into_body(), BODY_LIMIT).collect();
            match tokio::time::timeout(BODY_TIMEOUT, body).await {
                Ok(Ok(body)) => match String::from_utf8(body.to_bytes().into()) {
                    Ok(body) => match join(shared, named, &body) {
                        Ok(join) => {
                            let claim = (join == Join::Claiming).then(|| Claim {
                                shared,
                                claimed: false,
                            });
                            let (status, reply) = forward(shared, body).await;
                            let joined = match claim {
                                Some(claim) => claim.settle(status, reply.as_deref()),
                                None => join == Join::Inside,
                            };
                            (status, reply, joined)
                        }
                        Err(status) => (status, None, false),
                    },
                    Err(_) => (StatusCode::BAD_REQUEST, None, false),
                },
                _ => (StatusCode::BAD_REQUEST, None, false),
            }
        }
    };
    let mut response = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store");
    if joined && (status == StatusCode::OK || status == StatusCode::ACCEPTED) {
        response = response.header(SESSION, &shared.session);
    }
    if status == StatusCode::OK {
        response = response.header(header::CONTENT_TYPE, "application/json");
    }
    if status == StatusCode::METHOD_NOT_ALLOWED {
        response = response.header(header::ALLOW, "POST");
    }
    Ok(response
        .body(Full::new(body.unwrap_or_default().into()))
        .unwrap_or_default())
}

/// Hands `body` to the page and waits for its answer.
async fn forward(shared: &Shared, body: String) -> (StatusCode, Option<String>) {
    struct Waiting<'a>(&'a Shared, u64);
    impl Drop for Waiting<'_> {
        fn drop(&mut self) {
            self.0.pending().replies.remove(&self.1);
        }
    }
    let (sender, receiver) = oneshot::channel();
    let request = {
        let mut pending = shared.pending();
        let request = pending.next;
        pending.next += 1;
        pending.replies.insert(request, sender);
        request
    };
    let _waiting = Waiting(shared, request);
    if pairing::forward(shared, McpEvent::Message { request, body })
        .await
        .is_err()
    {
        // Nobody is listening: the page that started it is gone.
        shared.stop.cancel();
        return (StatusCode::SERVICE_UNAVAILABLE, None);
    }
    match receiver.await {
        Ok(Some(reply)) => (StatusCode::OK, Some(reply)),
        Ok(None) => (StatusCode::ACCEPTED, None),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, None),
    }
}

/// Whether an authorized `POST /mcp` names the session, or the status that
/// refuses `request`.
fn refuse(shared: &Shared, request: &Request<Incoming>) -> Result<bool, StatusCode> {
    let token = header(request, header::AUTHORIZATION)
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    if header(request, header::HOST) != Some(shared.authority.as_str())
        // An agent never sends one; a web page always does.
        || request.headers().contains_key(header::ORIGIN)
        || request.uri().path() != ENDPOINT
        || !same(token.as_bytes(), shared.token.as_bytes())
    {
        return Err(StatusCode::NOT_FOUND);
    }
    // No server stream for `GET` and no session for `DELETE` to end.
    if request.method() != Method::POST {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    let json = header(request, header::CONTENT_TYPE)
        .and_then(|value| value.split(';').next())
        .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("application/json"));
    if !json {
        return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    let length = header(request, header::CONTENT_LENGTH).and_then(|value| value.parse().ok());
    if length.is_some_and(|length: usize| length > BODY_LIMIT) {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    match header(request, SESSION) {
        Some(session) if same(session.as_bytes(), shared.session.as_bytes()) => Ok(true),
        Some(_) => Err(StatusCode::NOT_FOUND),
        None => Ok(false),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Join {
    /// Before the session, as `server/discover` is.
    Outside,
    /// The `initialize` that claims the session once it succeeds.
    Claiming,
    /// In the session.
    Inside,
}

/// Where `body` stands to the session, or the status that refuses it.
fn join(shared: &Shared, named: bool, body: &str) -> Result<Join, StatusCode> {
    #[derive(serde::Deserialize)]
    struct Message {
        method: Option<String>,
    }
    let state = shared.claim.load(Ordering::SeqCst);
    if named {
        return if state == CLAIMED {
            Ok(Join::Inside)
        } else {
            Err(StatusCode::NOT_FOUND)
        };
    }
    let method = serde_json::from_str::<Message>(body)
        .ok()
        .and_then(|message| message.method);
    match method.as_deref() {
        Some("initialize") => {
            if shared.shared_session {
                return Ok(Join::Claiming);
            }
            if shared
                .claim
                .compare_exchange(UNCLAIMED, CLAIMING, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return Ok(Join::Claiming);
            }
            // Another client has the token too, and may hold the session.
            shared.stop.cancel();
            Err(StatusCode::NOT_FOUND)
        }
        Some("server/discover" | "ping") if state != CLAIMED => Ok(Join::Outside),
        _ => Err(StatusCode::NOT_FOUND),
    }
}

/// Holds the session for an `initialize` until it is answered. A success
/// claims it; a failure, or a client that hung up first, releases it.
struct Claim<'a> {
    shared: &'a Shared,
    claimed: bool,
}
impl Claim<'_> {
    fn settle(mut self, status: StatusCode, reply: Option<&str>) -> bool {
        #[derive(serde::Deserialize)]
        struct Reply {
            result: Option<serde::de::IgnoredAny>,
        }
        self.claimed = status == StatusCode::OK
            && reply
                .and_then(|reply| serde_json::from_str::<Reply>(reply).ok())
                .is_some_and(|reply| reply.result.is_some());
        if self.claimed {
            self.shared.claim.store(CLAIMED, Ordering::SeqCst);
        }
        self.claimed
    }
}
impl Drop for Claim<'_> {
    fn drop(&mut self) {
        // Only the claim this guard holds is released.
        if !self.claimed && !self.shared.shared_session {
            let _ = self.shared.claim.compare_exchange(
                CLAIMING,
                UNCLAIMED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
        }
    }
}

pub(crate) fn header(request: &Request<Incoming>, name: HeaderName) -> Option<&str> {
    request.headers().get(name)?.to_str().ok()
}

/// Compares the token without exposing how much of it matched.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// Starts a loopback MCP server for a plugin that declares `host.mcp`. Each
/// message arrives on `on_event` and is answered with `plugin_host_mcp_reply`.
#[tauri::command]
pub(crate) async fn plugin_host_mcp_serve(
    manager: tauri::State<'_, PluginManager>,
    servers: tauri::State<'_, HostMcpServers>,
    id: String,
    revision: String,
    on_event: Channel<McpEvent>,
    shared_session: Option<bool>,
) -> Result<McpServerInfo, String> {
    let page = servers.page();
    let plugin = id.clone();
    let granted = with_manager(manager, move |manager| {
        Ok(manager.host_grants(&id, &revision)?.mcp)
    })
    .await?;
    if !granted {
        return Err("MCP servers are not declared".into());
    }
    servers.serve(page, plugin, on_event, shared_session.unwrap_or(false))
}

/// Answers a message with the JSON-RPC `body`; without one, with 202.
#[tauri::command]
pub(crate) fn plugin_host_mcp_reply(
    servers: tauri::State<'_, HostMcpServers>,
    id: String,
    handle: u64,
    request: u64,
    body: Option<String>,
) -> Result<(), String> {
    servers.reply(&id, handle, request, body)
}

/// Stops the server. Its `closed` event follows.
#[tauri::command]
pub(crate) fn plugin_host_mcp_close(
    servers: tauri::State<'_, HostMcpServers>,
    id: String,
    handle: u64,
) -> Result<(), String> {
    servers.close(&id, handle)
}

#[cfg(test)]
mod tests;
