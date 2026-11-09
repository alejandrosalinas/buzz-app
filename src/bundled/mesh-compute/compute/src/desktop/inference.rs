//! Lease-bound loopback ingress for plugin harnesses. Replacement uses the same
//! mutex as forwarding, held until the upstream response body ends or is dropped.
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use futures_util::StreamExt;
use std::sync::Arc;
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(super) struct Fence {
    lock: Arc<Mutex<()>>,
    cancellation: std::sync::Mutex<(Option<String>, CancellationToken)>,
}
impl Fence {
    pub(super) async fn lock(&self) -> OwnedMutexGuard<()> {
        self.lock.clone().lock_owned().await
    }
    /// Cancel only requests belonging to the captured selection. Stale management
    /// must not cancel a newer selection while waiting for the shared lock.
    pub(super) async fn interrupt(&self, lease: Option<&str>) -> OwnedMutexGuard<()> {
        {
            let active = self.cancellation.lock().unwrap();
            if lease.is_none() || active.0.as_deref() == lease {
                active.1.cancel();
            }
        }
        let guard = self.lock().await;
        let mut active = self.cancellation.lock().unwrap();
        if active.1.is_cancelled() {
            *active = (None, CancellationToken::new());
        }
        guard
    }
    pub(super) async fn request(&self, lease: &str) -> (OwnedMutexGuard<()>, CancellationToken) {
        let queued = self.cancellation.lock().unwrap().1.clone();
        let guard = self.lock().await;
        if queued.is_cancelled() {
            return (guard, queued);
        }
        self.cancellation.lock().unwrap().0 = Some(lease.to_owned());
        (guard, queued)
    }
    #[cfg(test)]
    fn try_lock(&self) -> Result<tokio::sync::MutexGuard<'_, ()>, tokio::sync::TryLockError> {
        self.lock.try_lock()
    }
}

type Target = Arc<dyn Fn(&str) -> Result<u16, String> + Send + Sync>;

#[derive(Clone)]
struct Forward {
    replacement: Arc<Fence>,
    target: Target,
    client: reqwest::Client,
}

pub(super) struct Gateway {
    port: u16,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Gateway {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Gateway {
    pub(super) async fn start(replacement: Arc<Fence>, target: Target) -> Result<Self, String> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(std::time::Duration::from_secs(240))
            .build()
            .map_err(|e| e.to_string())?;
        let router = Router::new()
            .route("/{lease}/v1/chat/completions", post(forward))
            .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
            .with_state(Forward {
                replacement,
                target,
                client,
            });
        let task = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                eprintln!("Mesh inference gateway stopped: {error}");
            }
        });
        Ok(Self { port, task })
    }

    pub(super) fn base_url(&self, lease: &str) -> String {
        format!("http://127.0.0.1:{}/{lease}/v1", self.port)
    }
}

async fn forward(State(state): State<Forward>, Path(lease): Path<String>, body: Bytes) -> Response {
    // FIFO lock: a queued replacement precedes later old-generation requests.
    // Validate only after acquisition, never against evidence captured before it.
    let (guard, cancel) = state.replacement.request(&lease).await;
    if cancel.is_cancelled() {
        return (StatusCode::CONFLICT, "Mesh request retired").into_response();
    }
    let port = match (state.target)(&lease) {
        Ok(port) => port,
        Err(_) => return (StatusCode::CONFLICT, "Mesh selection expired").into_response(),
    };
    let request = state
        .client
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .bearer_auth("mesh-local")
        .header(header::CONTENT_TYPE, "application/json")
        .body(body)
        .send();
    let response = tokio::select! {
        biased;
        _ = cancel.cancelled() => return (StatusCode::CONFLICT, "Mesh request retired").into_response(),
        response = request => match response {
            Ok(response) => response,
            Err(_) => return (StatusCode::BAD_GATEWAY, "Mesh inference failed").into_response(),
        }
    };
    let status = response.status();
    let content_type = response.headers().get(header::CONTENT_TYPE).cloned();
    // A producer owns upstream and the guard independently of downstream polling.
    // Cancellation must also work when a slow client fills the output buffer.
    let (send, receive) = tokio::sync::mpsc::channel(1);
    let task = tokio::spawn(async move {
        let _guard = guard;
        let mut stream = response.bytes_stream();
        loop {
            let chunk = tokio::select! {
                biased;
                _ = cancel.cancelled() => break,
                chunk = stream.next() => match chunk { Some(chunk) => chunk, None => break },
            };
            let failed = chunk.is_err();
            tokio::select! {
                biased;
                _ = cancel.cancelled() => break,
                result = send.send(chunk) => if result.is_err() { break; },
            }
            if failed {
                break;
            }
        }
    });
    let stream = futures_util::stream::unfold(
        (receive, StreamTask(task)),
        |(mut receive, task)| async move { receive.recv().await.map(|chunk| (chunk, (receive, task))) },
    );
    let mut output = Response::new(Body::from_stream(stream));
    *output.status_mut() = status;
    if let Some(content_type) = content_type {
        output
            .headers_mut()
            .insert(header::CONTENT_TYPE, content_type);
    }
    output
}

struct StreamTask(tokio::task::JoinHandle<()>);
impl Drop for StreamTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
mod tests;
