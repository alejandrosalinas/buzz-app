//! Loopback forwarding from local goose to the
//! build's agent gateway, with Buzz's context headers composed in natively.
//! The harness is pointed at a generation's base URL and keeps its own
//! bodies, streaming, retries and cancellation. Native removes goose's
//! Authorization before forwarding and adds the reserved attribution headers
//! the page fixed when it opened the generation.
//!
//! - It binds only `127.0.0.1`, on a port the OS picks, shared by every
//!   generation. A generation's base URL carries its random 256-bit handle,
//!   minted here; the page names it only by a numeric ID. `Host` must name the
//!   bound address, and a request that sends `Origin` is refused. Nothing
//!   about a request is logged.
//! - Upstreams are fixed: the build's gateway origin plus the harness's base
//!   path, both from the build's private descriptor. The route allowlist is
//!   compiled, never configured: a request path must exactly match it, so no
//!   encoded, dotted or doubled segment, absolute form or query reaches the
//!   gateway, and redirects are never followed or passed on.
//! - Admission mirrors the page's reference reducer (`ADMISSION_VECTORS`): per
//!   route, the highest eligibility revision wins, a generation opens only at
//!   the current revision while it admits, and a higher revision terminally
//!   revokes what opened under an older one, aborting its streams. A request
//!   is admitted under the same lock that revocation takes.
//! - Inference must name the generation's harness session in the harness's own
//!   header. A generation opens for discovery only and is associated once,
//!   before its first prompt.
//! - Sealing is terminal: later requests get 410, which harnesses don't retry,
//!   while admitted streams finish. Closing forgets the handle (404) and aborts
//!   its streams. Neither leaves a record behind.
//! - A generation belongs to the plugin and page that opened it, and goes when
//!   the page reloads or the app exits.
use crate::{with_manager, PluginManager};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use http_body_util::{combinators::BoxBody, BodyExt, Full, Limited};
use hyper::body::{Body, Bytes, Frame, Incoming};
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::{server::conn::http1, service::service_fn, Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::future::Future;
use std::net::Ipv4Addr;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

/// Generations open at once across all plugins.
const MAX_GENERATIONS: usize = 64;
/// Routes a page may name, each holding only its revision.
const MAX_ROUTES: usize = 256;
const CONNECTIONS: usize = 128;
const HEAD_LIMIT: usize = 64 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const BODY_LIMIT: usize = 64 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// The whole reserved header block, counted as `name: value\r\n` lines.
const HEADER_BUDGET: usize = 2048;
/// Never forwarded: the connection's own, the address and anything a browser
/// adds, plus whatever `Connection` names.
const HOP: [&str; 10] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authorization",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "host",
    "origin",
];

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type Reply = Response<BoxBody<Bytes, BoxError>>;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Harness {
    Goose,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Class {
    /// Identity only: no turn, so the discovery headers.
    Discovery,
    /// One request of a turn, which must name the harness session.
    Inference,
}
impl Harness {
    /// The stable capability name the gateway descriptor configures this
    /// harness under. The IPC name stays the transport's own.
    fn capability(self) -> &'static str {
        match self {
            Harness::Goose => "goose",
        }
    }
    fn session_header(self) -> &'static str {
        match self {
            Harness::Goose => "agent-session-id",
        }
    }
    /// What the request is, from the exact routes goose-acp 1.57.0 sends.
    fn classify(self, method: &Method, path: &str, query: Option<&str>) -> Option<Class> {
        let segments: Vec<&str> = path.strip_prefix('/')?.split('/').collect();
        match (self, method, segments.as_slice(), query) {
            (Harness::Goose, &Method::GET, ["api", "2.0", "serving-endpoints"], None) => {
                Some(Class::Discovery)
            }
            (Harness::Goose, &Method::GET, ["api", "2.0", "serving-endpoints", model], None)
                if model_name(model) =>
            {
                Some(Class::Discovery)
            }
            (Harness::Goose, &Method::POST, ["serving-endpoints", model, "invocations"], None)
                if model_name(model) =>
            {
                Some(Class::Inference)
            }
            _ => None,
        }
    }
}

/// A serving-endpoint name: no separator, dot segment or escape.
fn model_name(segment: &str) -> bool {
    (1..=128).contains(&segment.len())
        && !segment.starts_with('.')
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

/// An opaque ID the page or harness names: a route or a harness session.
fn opaque(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

/// The page's bundle as headers, refusing what the frontend's composer
/// refuses and what the contract's wire form never holds. It may set any of
/// the configured context headers, exactly as configured, and nothing else.
fn bundle(gateway: &Gateway, headers: &BTreeMap<String, String>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    let mut bytes = 0;
    for (name, value) in headers {
        if !gateway.context(name) {
            return Err("A gateway bundle may only set the context headers".into());
        }
        if value.is_empty() || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
            return Err("A gateway header has a non-printable value".into());
        }
        bytes += name.len() + value.len() + 4;
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| "Invalid header name")?;
        let value = HeaderValue::from_str(value).map_err(|_| "Invalid header value")?;
        map.insert(name, value);
    }
    if bytes > HEADER_BUDGET {
        return Err("The gateway headers exceed their 2048-byte budget".into());
    }
    Ok(map)
}

/// Whether `name` belongs to this connection alone: a fixed hop-by-hop name,
/// or one any of `headers`' `Connection` fields nominates, whatever its case.
fn hop(headers: &HeaderMap) -> impl Fn(&HeaderName) -> bool + '_ {
    move |name| {
        HOP.contains(&name.as_str())
            || headers
                .get_all(header::CONNECTION)
                .iter()
                .filter_map(|value| value.to_str().ok())
                .flat_map(|value| value.split(','))
                .any(|token| token.trim().eq_ignore_ascii_case(name.as_str()))
    }
}

/// `assembled` without the connection's headers or any reserved one, whatever
/// its case, then `bundle`: the one authoritative provenance set.
fn compose(gateway: &Gateway, assembled: &HeaderMap, bundle: &HeaderMap) -> HeaderMap {
    let mut composed = HeaderMap::with_capacity(assembled.len() + bundle.len());
    let hop = hop(assembled);
    for (name, value) in assembled {
        // Whatever its case, and with `_` for `-`, which some servers equate.
        if !hop(name) && !gateway.reserved(name.as_str()) {
            composed.append(name.clone(), value.clone());
        }
    }
    for (name, value) in bundle {
        composed.insert(name.clone(), value.clone());
    }
    composed
}

/// An `https://` origin with nothing after it, as the descriptor requires.
fn origin(origin: &str) -> Option<url::Url> {
    let url = url::Url::parse(origin).ok()?;
    let loopback = cfg!(test) && url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
    ((url.scheme() == "https" || loopback) && url.origin().ascii_serialization() == origin)
        .then_some(url)
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum ForwardEvent {
    /// A request passed admission and was sent upstream.
    Admitted { request: u64, class: Class },
    /// An admitted request's upstream response ended: relayed whole, or
    /// aborted by the harness hanging up, a revocation or a close. `status` is
    /// what the harness was answered, if anything yet.
    Finished {
        request: u64,
        status: Option<u16>,
        aborted: bool,
    },
    /// A request this generation refused, and why.
    Refused { status: u16, reason: &'static str },
    /// The last event: the generation is gone.
    Closed,
}

/// A generation's event channel. Its last holder sends `Closed`: the registry
/// and every request still being admitted or answered hold it, so nothing
/// about the generation follows `Closed`.
struct Events(Channel<ForwardEvent>);
impl Events {
    fn send(&self, event: ForwardEvent) {
        let _ = self.0.send(event);
    }
}
impl Drop for Events {
    fn drop(&mut self) {
        self.send(ForwardEvent::Closed);
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Opened {
    Opened {
        id: u64,
        /// `http://127.0.0.1:<port>/<handle>`, the harness's base URL.
        url: String,
    },
    /// Not at the route's current revision, or it doesn't admit.
    Refused { current: u64, admits: bool },
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Pushed {
    Applied { revoked: usize },
    Stale,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Open,
    /// The turn ended: terminal, while admitted streams finish.
    Sealed,
    /// A higher revision or the page dropped it: terminal, streams aborted.
    Revoked,
}

struct Generation {
    id: u64,
    plugin: String,
    route: String,
    revision: u64,
    harness: Harness,
    session: Option<String>,
    inference: HeaderMap,
    discovery: HeaderMap,
    state: State,
    /// Cancelled by revocation or close, aborting every admitted stream.
    abort: CancellationToken,
    events: Arc<Events>,
    requests: u64,
}

#[derive(Clone, Copy, Default)]
struct Route {
    revision: u64,
    admits: bool,
}

#[derive(Default)]
struct Registry {
    next: u64,
    page: u64,
    /// By (plugin, route key).
    routes: HashMap<(String, String), Route>,
    /// By handle.
    generations: HashMap<String, Generation>,
}
impl Registry {
    fn handle_of(&self, plugin: &str, id: u64) -> Result<String, String> {
        self.generations
            .iter()
            .find(|(_, generation)| generation.id == id && generation.plugin == plugin)
            .map(|(handle, _)| handle.clone())
            .ok_or_else(|| "No such forwarding generation".into())
    }
    fn revoke(&mut self, handle: &str) {
        if let Some(generation) = self.generations.get_mut(handle) {
            generation.state = State::Revoked;
            generation.abort.cancel();
        }
    }
}

/// The build's agent gateway: its origin, context header names, reserved
/// prefixes and per-harness upstream bases.
type Gateway = buzzodz_plugins::gateway::Native;

#[derive(Clone)]
pub(crate) struct HostForward {
    /// `None` keeps forwarding off.
    gateway: Option<Arc<Gateway>>,
    inner: Arc<Mutex<Registry>>,
    /// The shared listener's address, bound on first use for the app's life.
    listener: Arc<Mutex<Option<String>>>,
}
impl Default for HostForward {
    fn default() -> Self {
        Self::new(buzzodz_plugins::agent_gateway().cloned())
    }
}
impl HostForward {
    fn new(gateway: Option<Gateway>) -> Self {
        Self {
            gateway: gateway.map(Arc::new),
            inner: Arc::default(),
            listener: Arc::default(),
        }
    }
    fn registry(&self) -> MutexGuard<'_, Registry> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
    /// The gateway's origin, or empty when forwarding is off.
    pub(crate) fn origin(&self) -> String {
        self.gateway
            .as_ref()
            .map(|gateway| gateway.gateway.clone())
            .unwrap_or_default()
    }
    pub(crate) fn page(&self) -> u64 {
        self.registry().page
    }

    /// Applies the page's eligibility for `route` when `revision` is higher
    /// than any it pushed, revoking what opened under an older revision.
    fn push(
        &self,
        page: u64,
        plugin: &str,
        route: &str,
        revision: u64,
        admits: bool,
    ) -> Result<Pushed, String> {
        if !opaque(route) {
            return Err("Invalid route".into());
        }
        let mut registry = self.registry();
        // A push the old page sent must not seed the new page's routes.
        if registry.page != page {
            return Err("The page reloaded".into());
        }
        let key = (plugin.to_owned(), route.to_owned());
        if !registry.routes.contains_key(&key) && registry.routes.len() >= MAX_ROUTES {
            return Err("Too many forwarding routes".into());
        }
        let current = registry.routes.entry(key).or_default();
        if revision <= current.revision {
            return Ok(Pushed::Stale);
        }
        *current = Route { revision, admits };
        let revoked: Vec<String> = registry
            .generations
            .iter()
            .filter(|(_, generation)| {
                generation.plugin == plugin
                    && generation.route == route
                    && generation.revision < revision
                    && generation.state != State::Revoked
            })
            .map(|(handle, _)| handle.clone())
            .collect();
        for handle in &revoked {
            registry.revoke(handle);
        }
        Ok(Pushed::Applied {
            revoked: revoked.len(),
        })
    }

    /// Opens a generation of `route` at `revision`, unless the page that asked
    /// during `page` has since gone.
    #[allow(clippy::too_many_arguments)]
    fn open(
        &self,
        page: u64,
        plugin: &str,
        route: &str,
        revision: u64,
        harness: Harness,
        session: Option<String>,
        inference: &BTreeMap<String, String>,
        discovery: &BTreeMap<String, String>,
        events: Channel<ForwardEvent>,
    ) -> Result<Opened, String> {
        let Some(gateway) = self.gateway.as_deref().filter(|g| {
            origin(&g.gateway).is_some() && g.upstreams.contains_key(harness.capability())
        }) else {
            return Err("Gateway forwarding is off".into());
        };
        if !opaque(route) {
            return Err("Invalid route".into());
        }
        // goose learns its session after discovery; association must be explicit.
        if session.is_some() {
            return Err("Invalid harness session".into());
        }
        let inference = bundle(gateway, inference)?;
        let discovery = bundle(gateway, discovery)?;
        let authority = self.listen()?;
        let mut registry = self.registry();
        if registry.page != page {
            return Err("The page reloaded".into());
        }
        let current = registry
            .routes
            .get(&(plugin.to_owned(), route.to_owned()))
            .copied()
            .unwrap_or_default();
        if !current.admits || current.revision != revision {
            return Ok(Opened::Refused {
                current: current.revision,
                admits: current.admits,
            });
        }
        if registry.generations.len() >= MAX_GENERATIONS {
            return Err("Too many forwarding generations are open".into());
        }
        let mut secret = [0; 32];
        getrandom::fill(&mut secret).map_err(|_| "Could not open the generation")?;
        let handle = URL_SAFE_NO_PAD.encode(secret);
        let id = registry.next;
        registry.next += 1;
        registry.generations.insert(
            handle.clone(),
            Generation {
                id,
                plugin: plugin.to_owned(),
                route: route.to_owned(),
                revision,
                harness,
                session,
                inference,
                discovery,
                state: State::Open,
                abort: CancellationToken::new(),
                events: Arc::new(Events(events)),
                requests: 0,
            },
        );
        Ok(Opened::Opened {
            id,
            url: format!("http://{authority}/{handle}"),
        })
    }

    /// Names a goose generation's session, once.
    fn associate(&self, plugin: &str, id: u64, session: String) -> Result<(), String> {
        if !opaque(&session) {
            return Err("Invalid harness session".into());
        }
        let mut registry = self.registry();
        let handle = registry.handle_of(plugin, id)?;
        let generation = registry.generations.get_mut(&handle).expect("found");
        if generation.harness != Harness::Goose || generation.session.is_some() {
            return Err("The generation's session is already set".into());
        }
        if generation.state != State::Open {
            return Err("The generation has ended".into());
        }
        generation.session = Some(session);
        Ok(())
    }

    fn seal(&self, plugin: &str, id: u64) -> Result<(), String> {
        let mut registry = self.registry();
        let handle = registry.handle_of(plugin, id)?;
        let generation = registry.generations.get_mut(&handle).expect("found");
        if generation.state == State::Open {
            generation.state = State::Sealed;
        }
        Ok(())
    }

    fn close(&self, plugin: &str, id: u64) -> Result<(), String> {
        let mut registry = self.registry();
        let handle = registry.handle_of(plugin, id)?;
        let generation = registry.generations.remove(&handle).expect("found");
        drop(registry);
        generation.abort.cancel();
        Ok(())
    }

    /// Forgets every route and generation: the page that owned them is gone.
    pub(crate) fn stop_all(&self) {
        let mut registry = self.registry();
        registry.page += 1;
        registry.routes.clear();
        let generations: Vec<Generation> = registry.generations.drain().map(|(_, g)| g).collect();
        drop(registry);
        for generation in generations {
            generation.abort.cancel();
        }
    }

    /// The shared listener's address, binding it on first use.
    fn listen(&self) -> Result<String, String> {
        let mut listener = self.listener.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(authority) = listener.as_ref() {
            return Ok(authority.clone());
        }
        // A failure isn't kept: the next open tries again.
        let failed = |_| "Could not start forwarding".to_owned();
        let socket = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(failed)?;
        socket.set_nonblocking(true).map_err(failed)?;
        let authority = socket.local_addr().map_err(failed)?.to_string();
        let state = self.clone();
        tauri::async_runtime::spawn(async move { accept(socket, state).await });
        *listener = Some(authority.clone());
        Ok(authority)
    }

    /// Admits one request under the lock that revocation takes, or refuses it.
    fn admit(&self, request: &Request<Incoming>) -> Result<Admitted, Refusal> {
        let authority = self
            .listener
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let host = request
            .headers()
            .get(header::HOST)
            .and_then(|host| host.to_str().ok());
        // An agent never sends `Origin`; a web page always does. Only an
        // origin-form target names a generation.
        if authority.is_none()
            || host != authority.as_deref()
            || request.headers().contains_key(header::ORIGIN)
            || request.uri().scheme().is_some()
            || request.uri().authority().is_some()
        {
            return Err(Refusal::unknown());
        }
        let path = request.uri().path();
        let (handle, rest) = path
            .strip_prefix('/')
            .and_then(|path| path.split_once('/'))
            .map(|(handle, rest)| (handle, format!("/{rest}")))
            .ok_or_else(Refusal::unknown)?;
        let mut registry = self.registry();
        let Some(generation) = registry.generations.get(handle) else {
            return Err(Refusal::unknown());
        };
        let route = (generation.plugin.clone(), generation.route.clone());
        let current = registry.routes.get(&route).copied().unwrap_or_default();
        let generation = registry.generations.get_mut(handle).expect("found");
        let refuse = |status, reason| Refusal {
            status,
            reason,
            events: Some(generation.events.clone()),
        };
        if generation.state != State::Open {
            return Err(refuse(StatusCode::GONE, "generation_ended"));
        }
        let Some(class) =
            generation
                .harness
                .classify(request.method(), &rest, request.uri().query())
        else {
            return Err(refuse(StatusCode::NOT_FOUND, "route_not_allowed"));
        };
        let named = request
            .headers()
            .get_all(generation.harness.session_header());
        let mut named = named.iter();
        let session = match (named.next(), named.next()) {
            (None, _) => None,
            (Some(value), None) => Some(value.to_str().unwrap_or_default()),
            (Some(_), Some(_)) => return Err(refuse(StatusCode::BAD_REQUEST, "session_ambiguous")),
        };
        let expected = generation.session.as_deref();
        // Before association, goose's discovery may already name its session.
        let matches = match (class, session, expected) {
            (Class::Inference, None, _) => false,
            (Class::Discovery, None, _) | (Class::Discovery, Some(_), None) => true,
            (_, Some(session), expected) => expected == Some(session),
        };
        if !matches {
            let reason = if expected.is_none() {
                "session_unassociated"
            } else {
                "session_mismatch"
            };
            return Err(refuse(StatusCode::BAD_REQUEST, reason));
        }
        if !current.admits || current.revision != generation.revision {
            return Err(refuse(StatusCode::GONE, "generation_revoked"));
        }
        generation.requests += 1;
        let headers = match class {
            Class::Inference => generation.inference.clone(),
            Class::Discovery => generation.discovery.clone(),
        };
        Ok(Admitted {
            request: generation.requests,
            class,
            harness: generation.harness,
            rest,
            headers,
            abort: generation.abort.clone(),
            events: generation.events.clone(),
        })
    }
}

struct Admitted {
    request: u64,
    class: Class,
    harness: Harness,
    rest: String,
    headers: HeaderMap,
    abort: CancellationToken,
    events: Arc<Events>,
}

struct Refusal {
    status: StatusCode,
    reason: &'static str,
    events: Option<Arc<Events>>,
}
impl Refusal {
    /// No generation, or not addressed to this listener: nothing to tell.
    fn unknown() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            reason: "unknown",
            events: None,
        }
    }
}

async fn accept(socket: std::net::TcpListener, state: HostForward) {
    let Ok(listener) = TcpListener::from_std(socket) else {
        return;
    };
    let connections = Arc::new(Semaphore::new(CONNECTIONS));
    loop {
        let Ok(permit) = connections.clone().acquire_owned().await else {
            return;
        };
        let accepted = listener.accept().await;
        let Ok((socket, _)) = accepted else {
            drop(permit);
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            let service = service_fn(move |request| {
                let state = state.clone();
                async move { Ok::<_, Infallible>(forward(&state, request).await) }
            });
            let _ = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEAD_TIMEOUT)
                .max_buf_size(HEAD_LIMIT)
                .serve_connection(TokioIo::new(socket), service)
                .await;
            drop(permit);
        });
    }
}

fn client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            // The harness owns retries; a redirect would leave the gateway.
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(CONNECT_TIMEOUT)
                .pool_idle_timeout(Duration::from_secs(30))
                .build()
                .ok()
        })
        .as_ref()
}

/// A JSON error the harness surfaces as an API error, with nothing echoed.
fn error(status: StatusCode, reason: &str) -> Reply {
    let body = format!(
        r#"{{"type":"error","error":{{"type":"invalid_request_error","message":"gateway_{reason}"}}}}"#
    );
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(
            Full::new(Bytes::from(body))
                .map_err(|never| match never {})
                .boxed(),
        )
        .unwrap_or_default()
}

async fn forward(state: &HostForward, request: Request<Incoming>) -> Reply {
    let admitted = match state.admit(&request) {
        Ok(admitted) => admitted,
        Err(refusal) => {
            if let Some(events) = refusal.events {
                events.send(ForwardEvent::Refused {
                    status: refusal.status.as_u16(),
                    reason: refusal.reason,
                });
            }
            return error(refusal.status, refusal.reason);
        }
    };
    let Admitted {
        request: id,
        class,
        harness,
        rest,
        headers: bundle,
        abort,
        events,
    } = admitted;
    events.send(ForwardEvent::Admitted { request: id, class });
    let mut finished = Finished {
        events,
        request: id,
        status: None,
        done: false,
    };
    let query = request.uri().query().map(|query| format!("?{query}"));
    // Only validated parts: the origin, a validated base and an allowlisted
    // path. The parse is defence in depth against anything that could move it.
    let Some((gateway, origin, base)) = state.gateway.as_deref().and_then(|gateway| {
        Some((
            gateway,
            origin(&gateway.gateway)?,
            gateway.upstreams.get(harness.capability())?,
        ))
    }) else {
        return finished.answer(StatusCode::BAD_GATEWAY, "upstream_invalid");
    };
    let target = format!(
        "{}{base}{rest}{}",
        gateway.gateway,
        query.unwrap_or_default()
    );
    let target = match url::Url::parse(&target) {
        Ok(target)
            if target.origin() == origin.origin() && target.path() == format!("{base}{rest}") =>
        {
            target
        }
        _ => return finished.answer(StatusCode::BAD_GATEWAY, "upstream_invalid"),
    };
    let Some(client) = client() else {
        return finished.answer(StatusCode::BAD_GATEWAY, "upstream_unavailable");
    };
    let (parts, body) = request.into_parts();
    let mut headers = compose(gateway, &parts.headers, &bundle);
    headers.remove(header::AUTHORIZATION);
    let upstream = client
        .request(parts.method, target)
        .headers(headers)
        .body(reqwest::Body::wrap(Limited::new(body, BODY_LIMIT)))
        .send();
    let response = tokio::select! {
        response = upstream => response,
        () = abort.cancelled() => {
            let reply = finished.answer(StatusCode::GONE, "generation_revoked");
            finished.done = false;
            return reply;
        }
    };
    // Answered here, so the harness's own retry policy sees a 502.
    let Ok(response) = response else {
        return finished.answer(StatusCode::BAD_GATEWAY, "upstream_failed");
    };
    let status = response.status();
    if status.is_redirection() && status != StatusCode::NOT_MODIFIED {
        return finished.answer(StatusCode::BAD_GATEWAY, "upstream_redirected");
    }
    finished.status = Some(status.as_u16());
    let mut reply = Response::builder().status(status);
    {
        let hop = hop(response.headers());
        for (name, value) in response.headers() {
            if !hop(name) && name != header::SET_COOKIE {
                reply = reply.header(name, value);
            }
        }
    }
    let body = relay(reqwest::Body::from(response), abort, finished);
    reply.body(body.boxed()).unwrap_or_default()
}

/// Streams `upstream` to the harness from a task of its own, so revocation,
/// a close or the harness hanging up drops the upstream response even while
/// the harness stops reading.
fn relay(mut upstream: reqwest::Body, abort: CancellationToken, finished: Finished) -> Relayed {
    let (frames, received) = mpsc::channel(1);
    let stop = abort.clone();
    tauri::async_runtime::spawn(async move {
        // Owned whole, so it reports when the task ends. A body known to be
        // complete is, whenever the harness lets go of it.
        let mut finished = finished;
        finished.done = upstream.is_end_stream();
        while !finished.done {
            let frame = tokio::select! {
                biased;
                () = stop.cancelled() => return,
                () = frames.closed() => return,
                frame = upstream.frame() => frame,
            };
            let Some(frame) = frame else {
                finished.done = true;
                return;
            };
            let failed = frame.is_err();
            tokio::select! {
                biased;
                () = stop.cancelled() => return,
                sent = frames.send(frame.map_err(BoxError::from)) => {
                    if sent.is_err() || failed {
                        return;
                    }
                }
            }
            finished.done = upstream.is_end_stream();
        }
    });
    Relayed {
        received,
        abort: Box::pin(abort.cancelled_owned()),
        aborted: false,
    }
}

/// Reports an admitted request's end once, however its response ends.
struct Finished {
    events: Arc<Events>,
    request: u64,
    status: Option<u16>,
    done: bool,
}
impl Finished {
    /// Answers the harness here, completing the request.
    fn answer(&mut self, status: StatusCode, reason: &str) -> Reply {
        self.status = Some(status.as_u16());
        self.done = true;
        error(status, reason)
    }
}
impl Drop for Finished {
    fn drop(&mut self) {
        self.events.send(ForwardEvent::Finished {
            request: self.request,
            status: self.status,
            aborted: !self.done,
        });
    }
}

/// The relayed body, failed rather than ended when the generation is revoked
/// or closed, so the harness sees a broken stream, never a short complete one.
struct Relayed {
    received: mpsc::Receiver<Result<Frame<Bytes>, BoxError>>,
    abort: Pin<Box<WaitForCancellationFutureOwned>>,
    aborted: bool,
}
impl Body for Relayed {
    type Data = Bytes;
    type Error = BoxError;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        if self.aborted {
            return Poll::Ready(None);
        }
        if self.abort.as_mut().poll(context).is_ready() {
            self.aborted = true;
            return Poll::Ready(Some(Err("Forwarding generation revoked".into())));
        }
        self.received.poll_recv(context)
    }
}

/// Whether `id` may forward: it declares the gateway as a network origin.
async fn granted(
    manager: tauri::State<'_, PluginManager>,
    origin: String,
    id: String,
    revision: String,
) -> Result<(), String> {
    if origin.is_empty() {
        return Err("Gateway forwarding is off".into());
    }
    let granted = with_manager(manager, move |manager| {
        Ok(manager
            .host_grants(&id, &revision)?
            .network_origins
            .contains(&origin))
    })
    .await?;
    if granted {
        Ok(())
    } else {
        Err("The agent gateway is not declared".into())
    }
}

/// Pushes `route`'s eligibility at `route_revision`.
#[tauri::command]
pub(crate) async fn plugin_host_forward_admission(
    manager: tauri::State<'_, PluginManager>,
    forward: tauri::State<'_, HostForward>,
    id: String,
    revision: String,
    route: String,
    route_revision: u64,
    admits: bool,
) -> Result<Pushed, String> {
    let page = forward.page();
    granted(manager, forward.origin(), id.clone(), revision).await?;
    forward.push(page, &id, &route, route_revision, admits)
}

/// Opens a generation for one harness process. Its events arrive on
/// `on_event`; the harness is given only the returned URL.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn plugin_host_forward_open(
    manager: tauri::State<'_, PluginManager>,
    forward: tauri::State<'_, HostForward>,
    id: String,
    revision: String,
    route: String,
    route_revision: u64,
    harness: Harness,
    session: Option<String>,
    inference: BTreeMap<String, String>,
    discovery: BTreeMap<String, String>,
    on_event: Channel<ForwardEvent>,
) -> Result<Opened, String> {
    let page = forward.page();
    granted(manager, forward.origin(), id.clone(), revision).await?;
    forward.open(
        page,
        &id,
        &route,
        route_revision,
        harness,
        session,
        &inference,
        &discovery,
        on_event,
    )
}

/// Names a goose generation's session before its first prompt.
#[tauri::command]
pub(crate) fn plugin_host_forward_associate(
    forward: tauri::State<'_, HostForward>,
    id: String,
    generation: u64,
    session: String,
) -> Result<(), String> {
    forward.associate(&id, generation, session)
}

/// Ends the generation's admission for good; admitted streams finish.
#[tauri::command]
pub(crate) fn plugin_host_forward_seal(
    forward: tauri::State<'_, HostForward>,
    id: String,
    generation: u64,
) -> Result<(), String> {
    forward.seal(&id, generation)
}

/// Forgets the generation and aborts its streams. Its `closed` event follows.
#[tauri::command]
pub(crate) fn plugin_host_forward_close(
    forward: tauri::State<'_, HostForward>,
    id: String,
    generation: u64,
) -> Result<(), String> {
    forward.close(&id, generation)
}

#[cfg(test)]
mod tests;
