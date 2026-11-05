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

pub(super) const DEADLINE: Duration = Duration::from_secs(30);
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
}
impl From<&'static str> for Failure {
    fn from(code: &'static str) -> Self {
        Self {
            code,
            session_denied: false,
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
    // One total deadline includes bounded retry and Retry-After. Refusals and
    // invalid success bodies do not retry; no browser is launched here.
    let terminal_headers = std::sync::atomic::AtomicBool::new(false);
    tokio::time::timeout(DEADLINE, async {
        for attempt in 0..3u64 {
            let mut diagnostic = crate::network_diagnostics::Phase::new(
                "federated.http",
                "",
                None,
                crate::network_diagnostics::Level::Debug,
            );
            let response = request().send().await;
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
                        terminal_headers
                            .store(!status.is_success(), std::sync::atomic::Ordering::Relaxed);
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
                            Err(_) if !status.is_success() => return Err("adapter-refused".into()),
                            Err(failure) => return Err(failure),
                        };
                        if status.is_success() {
                            let result = serde_json::from_slice(&bytes)
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
    .map_err(|_| {
        Failure::from(
            if terminal_headers.load(std::sync::atomic::Ordering::Relaxed) {
                "adapter-refused"
            } else {
                "network-timeout"
            },
        )
    })?
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
}
