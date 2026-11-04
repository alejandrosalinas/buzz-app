//! The app's decision service. Callers ask typed questions about a piece of
//! text: yes/no, a choice from fixed options, or a level on a scale. One
//! provider answers them in one call. The webview picks the provider; native
//! owns the endpoints, credentials, limits and answer checks, so every
//! provider returns the same checked answers or the same failure reasons.
//!
//! - `typesafe`: TypeSafe System One with the user's own TypeSafe key, which
//!   only native code reads (see `jev.rs`).
//! - `builderlab`: the build's Builderlab (`BUZZ_BUILDERLAB_URL`), with the
//!   Builderlab sign-in the webview holds. Builds without one have no
//!   `builderlab` endpoint. An FI build instead calls the API of its identity
//!   origin with the native NIP-FI session, which the webview never sees, as
//!   its other Builderlab calls do. It takes System One's request and answer shapes,
//!   answers with Jev unless asked for another model, and bills the
//!   request's community, so a call without one is not sent.
use crate::federated_identity::FederatedIdentity;
use crate::jev::JevHost;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

pub(crate) const JEV_MODEL: &str = crate::jev::MODEL;
const TYPESAFE: &str = "https://api.typesafe.ai/v1/systemone";
const BUILDERLAB_ROUTE: &str = "v3/builderlab/decisions";
const INPUT_LIMIT: usize = 128 * 1024;
const RESPONSE_LIMIT: usize = 64 * 1024;
const MAX_QUESTIONS: usize = 32;
const NAME_LIMIT: usize = 64;
/// Calls past this wait for a slot inside their deadline.
const MAX_IN_FLIGHT: usize = 16;
const TIMEOUT: Duration = Duration::from_secs(30);
const MIN_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Backend {
    Typesafe,
    Builderlab,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Question {
    YesNo {
        instructions: String,
    },
    /// Option value -> when to pick it.
    Choice {
        instructions: String,
        options: BTreeMap<String, String>,
    },
    /// Level labels, lowest first.
    Score {
        instructions: String,
        levels: Vec<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Request {
    pub(crate) state: String,
    pub(crate) questions: BTreeMap<String, Question>,
    /// How long the caller waits, at most 30 seconds.
    #[serde(default)]
    pub(crate) timeout_ms: Option<u64>,
    /// The Buzz community (its relay URL) the text comes from. Builderlab
    /// bills that community and refuses a call without one.
    #[serde(default)]
    pub(crate) community: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Answer {
    YesNo {
        probability: f64,
    },
    Choice {
        choice: String,
        confidence: f64,
        /// Option value -> probability.
        probabilities: BTreeMap<String, f64>,
    },
    Score {
        /// Where the answer falls on the 0-based scale; it can be fractional.
        score: f64,
        confidence: f64,
        /// Level index ("0", "1", …) -> probability.
        probabilities: BTreeMap<String, f64>,
    },
}

/// Why a decision has no answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Failure {
    /// `typesafe` has no saved key, or `builderlab` no sign-in.
    MissingCredentials,
    /// The provider refused the caller's credentials.
    Unauthorized,
    /// `builderlab` says the sign-in itself is no longer valid (401). Only
    /// this ends the shared sign-in; the Builderlab plugin reports it to the
    /// host as `unauthorized`.
    SessionExpired,
    /// The questions are malformed, or the service rejected them.
    InvalidRequest,
    InputLimit,
    Timeout,
    ServiceError,
    InvalidResponse,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub(crate) enum Decided {
    Answered {
        backend: Backend,
        model: String,
        answers: BTreeMap<String, Answer>,
    },
    Failed {
        backend: Backend,
        reason: Failure,
    },
}

/// The Builderlab sign-in a call sends.
pub(crate) enum SignIn {
    /// The legacy OAuth credential the webview holds.
    Session(Zeroizing<String>),
    /// An FI build's native session, which Builderlab takes as Bearer.
    Bearer(Zeroizing<String>),
}
impl SignIn {
    fn secret(&self) -> &str {
        match self {
            Self::Session(secret) | Self::Bearer(secret) => secret,
        }
    }
}

pub(crate) struct Endpoints {
    pub(crate) typesafe: String,
    /// `None` when the build has no Builderlab.
    pub(crate) builderlab: Option<String>,
}

/// The decisions route under the build's Builderlab API, whose path keeps any
/// deployment prefix, as sign-in does.
fn builderlab_endpoint(origin: &str, api_base_path: &str) -> Option<String> {
    Some(origin)
        .filter(|origin| !origin.is_empty())
        .map(|origin| format!("{origin}{api_base_path}{BUILDERLAB_ROUTE}"))
}

pub(crate) struct DecisionsHost {
    endpoints: Endpoints,
    slots: Arc<Semaphore>,
    timeout: Duration,
}

impl DecisionsHost {
    pub(crate) fn new() -> Self {
        Self::with(
            Endpoints {
                typesafe: TYPESAFE.into(),
                builderlab: builderlab_endpoint(
                    buzzodz_plugins::BUILDERLAB_ORIGIN,
                    buzzodz_plugins::BUILDERLAB_API_BASE_PATH,
                ),
            },
            TIMEOUT,
        )
    }
    pub(crate) fn with(endpoints: Endpoints, timeout: Duration) -> Self {
        Self {
            endpoints,
            slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT)),
            timeout,
        }
    }

    /// One call to one provider. The wait for a slot, the key read, the call
    /// and the response read share one deadline. Nothing is retried, and a
    /// failed provider never falls back to another. `session` is the
    /// Builderlab sign-in; other providers ignore it.
    pub(crate) async fn decide(
        &self,
        keys: &JevHost,
        backend: Backend,
        session: Option<SignIn>,
        request: Request,
    ) -> Decided {
        let failed = |reason| Decided::Failed { backend, reason };
        if let Err(reason) = validate(&request) {
            return failed(reason);
        }
        // Builderlab bills the community: without a relay URL for one, the
        // call is refused before anything is sent.
        let community = match backend {
            Backend::Typesafe => None,
            Backend::Builderlab => match request.community.as_deref().and_then(community_host) {
                Some(host) => Some(host),
                None => return failed(Failure::InvalidRequest),
            },
        };
        let body = match encode(backend, &request) {
            Ok(body) if body.len() <= INPUT_LIMIT => body,
            Ok(_) => return failed(Failure::InputLimit),
            Err(reason) => return failed(reason),
        };
        let timeout = request
            .timeout_ms
            .map(Duration::from_millis)
            .map_or(self.timeout, |t| t.clamp(MIN_TIMEOUT, self.timeout));
        let deadline = Instant::now() + timeout;
        let call = async {
            let _slot = self
                .slots
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| Failure::ServiceError)?;
            let client = client().ok_or(Failure::ServiceError)?;
            let post = match backend {
                Backend::Typesafe => match keys.key().await {
                    Ok(Some(key)) => client
                        .post(&self.endpoints.typesafe)
                        .bearer_auth(key.as_str()),
                    Ok(None) => return Err(Failure::MissingCredentials),
                    // Unreadable is not absent: the key may still be saved.
                    Err(_) => return Err(Failure::ServiceError),
                },
                Backend::Builderlab => {
                    let endpoint = self
                        .endpoints
                        .builderlab
                        .as_ref()
                        .ok_or(Failure::ServiceError)?;
                    let session = session
                        .as_ref()
                        .filter(|s| !s.secret().trim().is_empty())
                        .ok_or(Failure::MissingCredentials)?;
                    let post = client.post(endpoint);
                    #[cfg(debug_assertions)]
                    let post = if endpoint.starts_with("http://") {
                        post.header(
                            "Origin",
                            reqwest::Url::parse(endpoint)
                                .map_err(|_| Failure::ServiceError)?
                                .origin()
                                .ascii_serialization(),
                        )
                    } else {
                        post
                    };
                    match session {
                        SignIn::Session(credential) => {
                            post.header("x-bb-session-credential", credential.as_str())
                        }
                        SignIn::Bearer(token) => post.bearer_auth(token.as_str()),
                    }
                    .header("x-buzz-community", community.as_deref().unwrap_or_default())
                }
            };
            let response = post
                .header("content-type", "application/json")
                .header("accept", "application/json")
                .body(body)
                .send()
                .await
                .map_err(|_| Failure::ServiceError)?;
            let status = response.status().as_u16();
            match status {
                200 => {}
                // A redirect is a sign-in page, never an answer.
                300..=399 | 401 | 403 => {
                    if backend == Backend::Typesafe {
                        // The key may have been removed or replaced elsewhere.
                        keys.forget().await;
                    } else if status == 401 {
                        return Err(Failure::SessionExpired);
                    }
                    // A Builderlab 403 or redirect refuses decisions, not the
                    // sign-in that other Builderlab features share.
                    return Err(Failure::Unauthorized);
                }
                400 | 422 => return Err(Failure::InvalidRequest),
                _ => return Err(Failure::ServiceError),
            }
            let bytes = read_limited(response).await?;
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| Failure::InvalidResponse)?;
            decode(backend, &request, &value)
        };
        match tokio::time::timeout_at(deadline.into(), call).await {
            Ok(Ok((model, answers))) => Decided::Answered {
                backend,
                model,
                answers,
            },
            Ok(Err(reason)) => failed(reason),
            Err(_) => failed(Failure::Timeout),
        }
    }
}

/// The limits every provider accepts.
fn validate(request: &Request) -> Result<(), Failure> {
    let text = |s: &str| !s.trim().is_empty();
    if !text(&request.state) || request.questions.is_empty() {
        return Err(Failure::InvalidRequest);
    }
    if request.questions.len() > MAX_QUESTIONS {
        return Err(Failure::InvalidRequest);
    }
    for (name, question) in &request.questions {
        if !text(name) || name.chars().count() > NAME_LIMIT {
            return Err(Failure::InvalidRequest);
        }
        let ok = match question {
            Question::YesNo { instructions } => text(instructions),
            Question::Choice {
                instructions,
                options,
            } => {
                text(instructions)
                    && (2..=255).contains(&options.len())
                    && options.keys().all(|value| text(value))
            }
            Question::Score {
                instructions,
                levels,
            } => {
                text(instructions)
                    && (2..=10).contains(&levels.len())
                    && levels.iter().all(|l| text(l))
            }
        };
        if !ok {
            return Err(Failure::InvalidRequest);
        }
    }
    Ok(())
}

fn instructions(question: &Question) -> &str {
    match question {
        Question::YesNo { instructions }
        | Question::Choice { instructions, .. }
        | Question::Score { instructions, .. } => instructions,
    }
}

fn encode(backend: Backend, request: &Request) -> Result<Vec<u8>, Failure> {
    let body = match backend {
        // Builderlab's System One: the question's type is its field. No
        // `model`, so Jev answers.
        Backend::Builderlab => {
            let questions: serde_json::Map<String, Value> = request
                .questions
                .iter()
                .map(|(name, q)| {
                    let mut question = json!({ "instructions": instructions(q) });
                    let (key, typed) = match q {
                        Question::YesNo { .. } => ("noul", json!({})),
                        Question::Choice { options, .. } => {
                            ("choice", json!({ "options": options }))
                        }
                        Question::Score { levels, .. } => ("score", json!({ "levels": levels })),
                    };
                    question[key] = typed;
                    (name.clone(), question)
                })
                .collect();
            json!({ "state": request.state, "questions": questions })
        }
        // TypeSafe's own `/v1/systemone`: a `type` and its `criteria`.
        Backend::Typesafe => {
            let questions: serde_json::Map<String, Value> = request
                .questions
                .iter()
                .map(|(name, q)| {
                    let question = match q {
                        Question::YesNo { instructions } => {
                            json!({ "type": "noul", "instructions": instructions })
                        }
                        Question::Choice {
                            instructions,
                            options,
                        } => json!({ "type": "choice", "instructions": instructions, "criteria": options }),
                        Question::Score {
                            instructions,
                            levels,
                        } => json!({ "type": "score", "instructions": instructions, "criteria": levels }),
                    };
                    (name.clone(), question)
                })
                .collect();
            json!({ "state": request.state, "model": JEV_MODEL, "questions": questions })
        }
    };
    serde_json::to_vec(&body).map_err(|_| Failure::InputLimit)
}

fn unit(value: Option<&Value>) -> Result<f64, Failure> {
    match value.and_then(Value::as_f64) {
        Some(p) if (0.0..=1.0).contains(&p) => Ok(p),
        _ => Err(Failure::InvalidResponse),
    }
}

/// The answers, checked against the questions: every question answered with
/// its own type, a known choice, a level on the scale, values within 0–1.
fn decode(
    backend: Backend,
    request: &Request,
    value: &Value,
) -> Result<(String, BTreeMap<String, Answer>), Failure> {
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .ok_or(Failure::InvalidResponse)?
        .to_owned();
    // TypeSafe is pinned to one model; Builderlab answers on its own.
    if backend == Backend::Typesafe && model != JEV_MODEL {
        return Err(Failure::InvalidResponse);
    }
    if model.is_empty() {
        return Err(Failure::InvalidResponse);
    }
    let Some(Value::Object(raw)) = value.get("answers") else {
        return Err(Failure::InvalidResponse);
    };
    let mut answers = BTreeMap::new();
    for (name, question) in &request.questions {
        let answer = raw.get(name).ok_or(Failure::InvalidResponse)?;
        // TypeSafe puts the typed body beside a `type` tag; Builderlab wraps
        // it under the type's field.
        let (body, kind) = match backend {
            Backend::Typesafe => (answer, answer.get("type").and_then(Value::as_str)),
            Backend::Builderlab => {
                let mut typed = ["noul", "choice", "score"]
                    .into_iter()
                    .filter_map(|k| answer.get(k).map(|b| (b, Some(k))));
                match (typed.next(), typed.next()) {
                    // Exactly one typed body; more than one is ambiguous.
                    (Some(only), None) => only,
                    _ => return Err(Failure::InvalidResponse),
                }
            }
        };
        let decoded = match (question, kind) {
            (Question::YesNo { .. }, Some("noul")) => Answer::YesNo {
                // TypeSafe's value is the field itself; Builderlab's is in it.
                probability: unit(match backend {
                    Backend::Typesafe => body.get("noul"),
                    Backend::Builderlab => body.get("value"),
                })?,
            },
            (Question::Choice { options, .. }, Some("choice")) => {
                let choice = body
                    .get("choice")
                    .and_then(Value::as_str)
                    .filter(|c| options.contains_key(*c))
                    .ok_or(Failure::InvalidResponse)?
                    .to_owned();
                let probabilities = list_or_map(body.get("probabilities"), "value", |key| {
                    options.contains_key(key)
                })?;
                Answer::Choice {
                    choice,
                    confidence: unit(body.get("confidence"))?,
                    probabilities,
                }
            }
            (Question::Score { levels, .. }, Some("score")) => {
                let score = body
                    .get("score")
                    .and_then(Value::as_f64)
                    .filter(|s| *s >= 0.0 && *s <= (levels.len() - 1) as f64)
                    .ok_or(Failure::InvalidResponse)?;
                let in_scale = |key: &str| key.parse::<usize>().is_ok_and(|i| i < levels.len());
                let probabilities = list_or_map(body.get("probabilities"), "level", in_scale)?;
                Answer::Score {
                    score,
                    confidence: unit(body.get("confidence"))?,
                    probabilities,
                }
            }
            _ => return Err(Failure::InvalidResponse),
        };
        answers.insert(name.clone(), decoded);
    }
    Ok((model, answers))
}

/// Probabilities as a map or a list of `{<key>, probability}`, with every key
/// known to the question. Missing means none were reported.
fn list_or_map(
    value: Option<&Value>,
    key: &str,
    known: impl Fn(&str) -> bool,
) -> Result<BTreeMap<String, f64>, Failure> {
    let check = |k: String, p: Option<&Value>| -> Result<(String, f64), Failure> {
        if !known(&k) {
            return Err(Failure::InvalidResponse);
        }
        Ok((k, unit(p)?))
    };
    match value {
        None | Some(Value::Null) => Ok(BTreeMap::new()),
        Some(Value::Object(map)) => map.iter().map(|(k, p)| check(k.clone(), Some(p))).collect(),
        Some(Value::Array(list)) => list
            .iter()
            .map(|entry| {
                let k = match entry.get(key) {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Number(n)) => n.to_string(),
                    _ => return Err(Failure::InvalidResponse),
                };
                check(k, entry.get("probability"))
            })
            .collect(),
        _ => Err(Failure::InvalidResponse),
    }
}

/// The community as Builderlab names it: the relay's host, lowercase, with
/// its port only when not the scheme's default. `None` when it is not a relay
/// URL.
fn community_host(community: &str) -> Option<String> {
    let url = reqwest::Url::parse(community.trim()).ok()?;
    if !matches!(url.scheme(), "wss" | "ws" | "https" | "http") {
        return None;
    }
    let host = url.host_str()?.trim_end_matches('.');
    if host.is_empty() {
        return None;
    }
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

async fn read_limited(mut response: reqwest::Response) -> Result<Vec<u8>, Failure> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::ServiceError)? {
        if bytes.len() + chunk.len() > RESPONSE_LIMIT {
            return Err(Failure::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn client() -> Option<&'static reqwest::Client> {
    static CLIENT: std::sync::OnceLock<Option<reqwest::Client>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                // A redirect is a sign-in page, never an answer; never follow it.
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .build()
                .ok()
        })
        .as_ref()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DevelopmentSession {
    origin: String,
    revision: String,
}
#[cfg(debug_assertions)]
fn development_endpoint(origin: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(origin).map_err(|_| "Invalid development origin")?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        || url.port().is_none()
        || url.origin().ascii_serialization() != origin
    {
        return Err("Invalid development origin".into());
    }
    Ok(format!("{origin}/api/builderlab/decisions"))
}

/// The FI session `revision`, if it is still the current one, the work it
/// owns, and the decisions route under the identity origin's API, where the
/// build's other Builderlab calls go.
fn federated_sign_in(
    fi: &FederatedIdentity,
    revision: &str,
) -> Option<(CancellationToken, Option<String>, SignIn)> {
    let cancel = fi.cancellation_for(revision).ok()?;
    fi.with_session(|token, current, config| {
        (current == revision).then(|| {
            (
                cancel,
                builderlab_endpoint(&config.identity_origin, &config.api_base_path),
                SignIn::Bearer(token.clone()),
            )
        })
    })
    .flatten()
}

/// Builderlab with an FI build's native session. Only the session the caller
/// started under may answer: a sign-out or account switch during the call
/// drops its answer. A 401 refuses this call only: the adapter, asked once in
/// the background, decides whether the session ended, as for other granted
/// calls.
async fn decide_federated(
    host: &DecisionsHost,
    keys: &JevHost,
    fi: &FederatedIdentity,
    revision: &str,
    request: Request,
) -> Decided {
    let backend = Backend::Builderlab;
    let ended = Decided::Failed {
        backend,
        reason: Failure::MissingCredentials,
    };
    let Some((cancel, builderlab, session)) = federated_sign_in(fi, revision) else {
        return ended;
    };
    let scoped = DecisionsHost {
        endpoints: Endpoints {
            typesafe: host.endpoints.typesafe.clone(),
            builderlab,
        },
        slots: host.slots.clone(),
        timeout: host.timeout,
    };
    let decided = tokio::select! {
        biased;
        () = cancel.cancelled() => return ended,
        decided = scoped.decide(keys, backend, Some(session), request) => decided,
    };
    if cancel.is_cancelled() {
        return ended;
    }
    match decided {
        Decided::Failed {
            reason: Failure::SessionExpired,
            ..
        } => {
            let (fi, revision) = (fi.clone(), revision.to_owned());
            tokio::spawn(async move { fi.recheck(&revision).await });
            Decided::Failed {
                backend,
                reason: Failure::Unauthorized,
            }
        }
        decided => decided,
    }
}

/// An FI session asks Builderlab only, and never with another sign-in.
fn federated_alone(backend: Backend, session: bool, broker: bool) -> Result<(), String> {
    if backend != Backend::Builderlab || session || broker {
        return Err("Invalid federated session".into());
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri passes each IPC field as an argument.
pub(crate) async fn decide(
    keys: tauri::State<'_, JevHost>,
    host: tauri::State<'_, DecisionsHost>,
    fi: tauri::State<'_, FederatedIdentity>,
    backend: Backend,
    request: Request,
    session: Option<String>,
    broker: Option<DevelopmentSession>,
    federated: Option<String>,
) -> Result<Decided, String> {
    // An FI build names its native session by revision; the token stays here.
    if let Some(revision) = federated {
        federated_alone(backend, session.is_some(), broker.is_some())?;
        return Ok(decide_federated(&host, &keys, &fi, &revision, request).await);
    }
    if let Some(broker) = broker {
        #[cfg(not(debug_assertions))]
        {
            let _ = (broker.origin, broker.revision);
            return Err("Development sign-in unavailable".into());
        }
        #[cfg(debug_assertions)]
        {
            if backend != Backend::Builderlab || session.is_some() || broker.revision.is_empty() {
                return Err("Invalid development session".into());
            }
            let scoped = DecisionsHost {
                endpoints: Endpoints {
                    typesafe: host.endpoints.typesafe.clone(),
                    builderlab: Some(development_endpoint(&broker.origin)?),
                },
                slots: host.slots.clone(),
                timeout: host.timeout,
            };
            return Ok(scoped
                .decide(
                    &keys,
                    backend,
                    Some(SignIn::Session(Zeroizing::new(broker.revision))),
                    request,
                )
                .await);
        }
    }
    let session = session.map(|s| SignIn::Session(Zeroizing::new(s)));
    Ok(host.decide(&keys, backend, session, request).await)
}

#[cfg(test)]
#[path = "decisions_tests.rs"]
mod tests;
