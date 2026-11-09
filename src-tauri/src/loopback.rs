//! The loopback HTTP listener the MCP servers and the credential service
//! share: it binds `127.0.0.1` on a port the OS picks and serves each
//! connection one request with hyper. Callers keep their own handling.
use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::{server::conn::http1, service::service_fn, Request, Response};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::convert::Infallible;
use std::future::Future;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

/// Open connections per listener: an agent may make several calls at once.
const CONNECTIONS: usize = 32;
/// hyper's smallest read buffer, which bounds a request head.
const HEAD_LIMIT: usize = 8192;
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);

/// The address a request's connection came from, in its extensions.
#[derive(Clone, Copy)]
pub(crate) struct Peer(pub(crate) std::net::SocketAddr);

/// Binds synchronously, so the address is known before anyone connects, and
/// returns the listener with its `127.0.0.1:<port>` authority.
pub(crate) fn bind() -> std::io::Result<(std::net::TcpListener, String)> {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let authority = listener.local_addr()?.to_string();
    Ok((listener, authority))
}

/// Serves `listener` with `answer` until `stop` is cancelled, which also ends
/// the connections still open.
pub(crate) async fn serve<A, F>(listener: std::net::TcpListener, stop: CancellationToken, answer: A)
where
    A: Fn(Request<Incoming>) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Result<Response<Full<Bytes>>, Infallible>> + Send + 'static,
{
    let Ok(listener) = TcpListener::from_std(listener) else {
        return;
    };
    let connections = Arc::new(Semaphore::new(CONNECTIONS));
    loop {
        let accepted = tokio::select! {
            accepted = async {
                let permit = connections.clone().acquire_owned().await.ok()?;
                Some((permit, listener.accept().await))
            } => accepted,
            () = stop.cancelled() => return,
        };
        let Some((permit, accepted)) = accepted else {
            return;
        };
        let Ok((socket, peer)) = accepted else {
            drop(permit);
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let (answer, stop) = (answer.clone(), stop.clone());
        tauri::async_runtime::spawn(async move {
            // One request per connection. hyper drops a request whose client
            // closes before its answer.
            let connection = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEAD_TIMEOUT)
                .max_buf_size(HEAD_LIMIT)
                .keep_alive(false)
                .serve_connection(
                    TokioIo::new(socket),
                    service_fn(move |mut request: Request<Incoming>| {
                        request.extensions_mut().insert(Peer(peer));
                        answer(request)
                    }),
                );
            tokio::select! {
                _ = connection => {}
                () = stop.cancelled() => {}
            }
            drop(permit);
        });
    }
}
