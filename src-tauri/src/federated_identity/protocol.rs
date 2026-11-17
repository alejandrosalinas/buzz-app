//! Bounded native-only NIP-FA operations. Authentication bodies never reach IPC.
use reqwest::{Client, RequestBuilder};
use serde::de::DeserializeOwned;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

// Task-local observation keeps held-body tests independent of other requests.
#[cfg(test)]
tokio::task_local! {
    pub(super) static HEADERS_RECEIVED: std::sync::Arc<tokio::sync::Notify>;
}

// Tests pin the wall clock a token is validated against, so a fixture's
// relative `iat` cannot cross a second boundary before validation.
#[cfg(test)]
tokio::task_local! {
    pub(super) static WALL_NOW: SystemTime;
}
/// The wall-clock reading an issued token is validated against.
pub(super) fn wall_now() -> SystemTime {
    #[cfg(test)]
    if let Ok(pinned) = WALL_NOW.try_with(|pinned| *pinned) {
        return pinned;
    }
    SystemTime::now()
}

pub(super) const DEADLINE: Duration = Duration::from_secs(30);
/// How far ahead of this clock a signed timestamp may be, and how far a
/// verifier accepts one behind or ahead of its own (NIP-FI, NIP-98).
pub(crate) const CLOCK_SKEW_SECS: u64 = 120;
/// A response `Date` further than this from the local clock suggests the
/// local clock is off. It is a hint, never the cause of a refusal: the
/// supported skew reaches 120 s, and `Date` has one-second precision.
const CLOCK_HINT_SECS: i64 = 115;

/// The server's `Date` minus the local clock, sampled when the headers arrive,
/// when it is far enough off to suggest local skew. A missing or malformed
/// `Date` gives nothing.
pub(crate) fn clock_offset(date: Option<&str>) -> Option<i64> {
    let server = chrono::DateTime::parse_from_rfc2822(date?)
        .ok()?
        .timestamp();
    let offset = server - now().ok()?;
    (offset.abs() > CLOCK_HINT_SECS).then_some(offset)
}
/// A JWT NumericDate claim (RFC 7519 §2): any finite, non-negative JSON
/// number, so fractional seconds are valid. Callers round `iat` up, so a
/// lifetime against an `exp` that matches the issued expiry exactly is
/// `floor(exp − iat)` whole seconds.
pub(crate) fn numeric_date(claims: &serde_json::Value, name: &str) -> Option<f64> {
    claims
        .get(name)
        .and_then(serde_json::Value::as_f64)
        .filter(|date| date.is_finite() && *date >= 0.0)
}

pub(crate) fn now() -> Result<i64, &'static str> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .map_err(|_| "clock-unavailable")
}
pub(crate) fn expiry(value: &str) -> Result<i64, &'static str> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp())
        .map_err(|_| "invalid-expiry")
}
pub(crate) fn client() -> Result<Client, &'static str> {
    let builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(DEADLINE)
        .connect_timeout(Duration::from_secs(10));
    // Tests' loopback communities use one self-signed root.
    #[cfg(test)]
    let builder = builder.tls_certs_only([super::testing::trusted_root()]);
    builder.build().map_err(|_| "network-unavailable")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Failure {
    pub(crate) code: &'static str,
    pub(crate) session_denied: bool,
    /// `clock_offset` of a refusal's response: a diagnostic beside `code`,
    /// which keeps its meaning and handling.
    pub(crate) clock_offset: Option<i64>,
    /// The last answer before giving up, by retries or the deadline, was a 429.
    pub(crate) rate_limited: bool,
}
impl From<&'static str> for Failure {
    fn from(code: &'static str) -> Self {
        Self {
            code,
            session_denied: false,
            clock_offset: None,
            rate_limited: false,
        }
    }
}

async fn body(
    mut response: reqwest::Response,
    diagnostic: &mut crate::network_diagnostics::Phase,
) -> Result<Zeroizing<Vec<u8>>, Failure> {
    const LIMIT: usize = 64 * 1024;
    if response
        .headers()
        .iter()
        .map(|(name, value)| name.as_str().len() + value.len())
        .sum::<usize>()
        > 16 * 1024
        || response
            .content_length()
            .is_some_and(|length| length > LIMIT as u64)
    {
        return Err("response-too-large".into());
    }
    let mut body = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        diagnostic.http_error(&error);
        diagnostic.reason = Some("body-interrupted");
        Failure::from("network-unavailable")
    })? {
        if chunk.len() > LIMIT - body.len() {
            return Err("response-too-large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub(crate) async fn json<T: DeserializeOwned>(
    request: impl Fn() -> RequestBuilder,
) -> Result<T, Failure> {
    Ok(json_with(|| std::future::ready(Ok(request()))).await?.0)
}

/// `json`, building every transmitted attempt anew: a request carrying a
/// single-use proof signs a fresh one per attempt, so a retry is never
/// refused as a replay of the attempt before it. Also answers when the
/// attempt whose response came back started, sampled before it was built,
/// so a token's lifetime is counted from that attempt and not from an
/// earlier one that failed (the shared client lifetime rule).
pub(crate) async fn json_with<T: DeserializeOwned, F>(
    request: impl Fn() -> F,
) -> Result<(T, tokio::time::Instant), Failure>
where
    F: std::future::Future<Output = Result<RequestBuilder, Failure>>,
{
    // One total deadline includes bounded retry and Retry-After. Refusals and
    // invalid success bodies do not retry; no browser is launched here.
    // Set when a refusal's headers arrive, with their clock offset, so a
    // body that then outlasts the deadline still reports both.
    let terminal_headers = std::sync::Mutex::new(None::<Option<i64>>);
    let rate_limited = std::sync::atomic::AtomicBool::new(false);
    tokio::time::timeout(DEADLINE, async {
        for attempt in 0..3u64 {
            let mut diagnostic = crate::network_diagnostics::Phase::new(
                "federated.http",
                "",
                None,
                crate::network_diagnostics::Level::Debug,
            );
            let started = tokio::time::Instant::now();
            let response = request().await?.send().await;
            rate_limited.store(
                response
                    .as_ref()
                    .is_ok_and(|response| response.status().as_u16() == 429),
                std::sync::atomic::Ordering::Relaxed,
            );
            let retry = match response {
                Err(error) => {
                    diagnostic.reason = Some(crate::network_diagnostics::http_failure(&error));
                    diagnostic.http_error(&error);
                    Some(None)
                }
                Ok(response) => {
                    let status = response.status();
                    diagnostic.status = Some(status.as_u16());
                    if status.as_u16() == 429 || status.is_server_error() {
                        let delay = response
                            .headers()
                            .get("retry-after")
                            .and_then(|v| v.to_str().ok())
                            .and_then(retry_after);
                        Some(delay)
                    } else {
                        let clock_offset = (!status.is_success())
                            .then(|| {
                                clock_offset(
                                    response.headers().get("date").and_then(|v| v.to_str().ok()),
                                )
                            })
                            .flatten();
                        *terminal_headers
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner) =
                            (!status.is_success()).then_some(clock_offset);
                        #[cfg(test)]
                        let _ = HEADERS_RECEIVED.try_with(|received| received.notify_one());
                        let bytes = match body(response, &mut diagnostic).await {
                            Ok(bytes) => bytes,
                            Err(failure)
                                if status.is_success()
                                    && failure.code == "network-unavailable"
                                    && attempt < 2 =>
                            {
                                tokio::time::sleep(Duration::from_millis(
                                    250 * 2u64.pow(attempt as u32),
                                ))
                                .await;
                                continue;
                            }
                            Err(_) if !status.is_success() => {
                                return Err(Failure {
                                    clock_offset,
                                    .."adapter-refused".into()
                                })
                            }
                            Err(failure) => return Err(failure),
                        };
                        if status.is_success() {
                            let result = serde_json::from_slice(&bytes)
                                .map(|value| (value, started))
                                .map_err(|_| Failure::from("invalid-response"));
                            diagnostic.ok = result.is_ok();
                            return result;
                        }
                        let value: serde_json::Value =
                            serde_json::from_slice(&bytes).unwrap_or_default();
                        let code = value
                            .get("error")
                            .and_then(|v| {
                                v.as_str()
                                    .or_else(|| v.get("code").and_then(|v| v.as_str()))
                            })
                            .or_else(|| value.get("code").and_then(|v| v.as_str()));
                        let session_denied = status.as_u16() == 401
                            && matches!(code, Some("session_required" | "session_expired"));
                        let code = match code {
                            Some("binding_mismatch") => "binding-mismatch",
                            Some("authorization_denied") => "authorization-denied",
                            Some("invalid_proof") => "invalid-proof",
                            // Only the token route's 401: the grant itself is gone.
                            Some("invalid_grant") if status.as_u16() == 401 => "grant-refused",
                            _ if session_denied => "reauthentication-required",
                            _ => "adapter-refused",
                        };
                        diagnostic.reason = Some(code);
                        return Err(Failure {
                            code,
                            session_denied,
                            clock_offset,
                            rate_limited: false,
                        });
                    }
                }
            };
            if attempt == 2 {
                return Err("network-unavailable".into());
            }
            if let Some(delay) = retry {
                tokio::time::sleep(
                    delay.unwrap_or(Duration::from_millis(250 * 2u64.pow(attempt as u32))),
                )
                .await;
            }
        }
        Err("network-unavailable".into())
    })
    .await
    .unwrap_or_else(|_| {
        Err(
            match *terminal_headers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
            {
                Some(clock_offset) => Failure {
                    clock_offset,
                    .."adapter-refused".into()
                },
                None => "network-timeout".into(),
            },
        )
    })
    .map_err(|failure| Failure {
        rate_limited: rate_limited.load(std::sync::atomic::Ordering::Relaxed),
        ..failure
    })
}

fn retry_after(value: &str) -> Option<Duration> {
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let timestamp = chrono::DateTime::parse_from_rfc2822(value)
        .ok()?
        .timestamp();
    Some(Duration::from_secs(
        timestamp.saturating_sub(now().ok()?).max(0) as u64,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn truncated_response(
        status: u16,
        recover: bool,
    ) -> (usize, Result<serde_json::Value, Failure>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let counted = requests.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).await.unwrap();
                    request.push(byte[0]);
                }
                let number = counted.fetch_add(1, Ordering::SeqCst);
                let response = if recover && number > 0 {
                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into()
                } else {
                    format!("HTTP/1.1 {status} Test\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{{")
                };
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
            }
        });
        let client = client().unwrap();
        let result = json(|| client.get(&url)).await;
        // Completion of json is the barrier: no further retry can be scheduled.
        let count = requests.load(Ordering::SeqCst);
        server.abort();
        (count, result)
    }

    #[tokio::test]
    async fn truncated_terminal_responses_do_not_replay_the_adapter_request() {
        for status in [302, 400, 401, 403] {
            let (requests, result) = truncated_response(status, false).await;
            assert!(result.is_err());
            assert_eq!(requests, 1, "terminal HTTP {status} was retried");
        }
        let (requests, result) = truncated_response(200, true).await;
        assert_eq!(result.unwrap(), serde_json::json!({}));
        assert_eq!(
            requests, 2,
            "successful body transport failures should recover"
        );
    }

    #[tokio::test]
    async fn a_retry_after_past_the_deadline_keeps_the_rate_limit() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let (answered, waiting) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            socket
                .write_all(b"HTTP/1.1 429 Test\r\nRetry-After: 60\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            // The client closes only after classifying the 429.
            let _ = socket.read_to_end(&mut Vec::new()).await;
            answered.send(()).unwrap();
        });
        let client = client().unwrap();
        let advance = async {
            waiting.await.unwrap();
            tokio::time::pause();
            tokio::time::advance(DEADLINE + Duration::from_secs(1)).await;
        };
        let (result, ()) = tokio::join!(json::<serde_json::Value>(|| client.get(&url)), advance);
        tokio::time::resume();
        server.await.unwrap();
        let failure = result.unwrap_err();
        assert_eq!(failure.code, "network-timeout");
        assert!(failure.rate_limited);
    }
}
