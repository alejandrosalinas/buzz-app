use super::*;
use crate::lease::Lease;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;

#[tokio::test]
async fn replacement_waits_for_stream_and_rejects_old_requests_on_reused_port() {
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let requests = Arc::new(AtomicUsize::new(0));
    let upstream = Router::new().route(
        "/v1/chat/completions",
        post({
            let started = started.clone();
            let release = release.clone();
            let requests = requests.clone();
            move || {
                let started = started.clone();
                let release = release.clone();
                let requests = requests.clone();
                async move {
                    let first = requests.fetch_add(1, Ordering::SeqCst) == 0;
                    let body = futures_util::stream::once(async move {
                        if first {
                            started.notify_one();
                            release.notified().await;
                        }
                        Ok::<_, std::io::Error>(Bytes::from_static(b"data: done\n\n"))
                    });
                    (
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        Body::from_stream(body),
                    )
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let lease = Arc::new(Lease::default());
    let a = lease.select("https://a.example".into()).unwrap();
    let replacement = Arc::new(Fence::default());
    let gateway = Gateway::start(replacement.clone(), {
        let lease = lease.clone();
        Arc::new(move |id| lease.with_current(id, |_| Ok(port)))
    })
    .await
    .unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let url = format!("{}/chat/completions", gateway.base_url(&a));
    let pending = tokio::spawn({
        let client = client.clone();
        let url = url.clone();
        async move {
            client
                .post(url)
                .body("A prompt")
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap()
        }
    });
    started.notified().await;
    // Upstream headers have arrived, but its body is deliberately held. The
    // actual forwarding path must still own the same lock replacement takes.
    assert!(replacement.try_lock().is_err());
    release.notify_one();
    assert_eq!(pending.await.unwrap(), "data: done\n\n");
    let b = {
        let _guard = replacement.lock().await;
        lease.select("https://b.example".into()).unwrap()
    };
    let rejected = client.post(url).body("late A prompt").send().await.unwrap();
    assert_eq!(rejected.status(), StatusCode::CONFLICT);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    let accepted = client
        .post(format!("{}/chat/completions", gateway.base_url(&b)))
        .body("B prompt")
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.text().await.unwrap(), "data: done\n\n");
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    drop(gateway);
    server.abort();
}

#[tokio::test]
async fn unknown_lease_never_connects_and_upstream_failure_releases_replacement() {
    let replacement = Arc::new(Fence::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let gateway = Gateway::start(
        replacement.clone(),
        Arc::new(move |id| {
            if id == "valid" {
                Ok(port)
            } else {
                Err("retired".into())
            }
        }),
    )
    .await
    .unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (id, expected) in [
        ("retired", StatusCode::CONFLICT),
        ("valid", StatusCode::BAD_GATEWAY),
    ] {
        let response = client
            .post(format!("{}/chat/completions", gateway.base_url(id)))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        assert!(replacement.try_lock().is_ok());
    }
}

#[tokio::test]
async fn stop_cancels_a_held_body_and_retires_its_ingress_before_returning() {
    use crate::desktop::{stop_compute, MeshHost};
    let host = Arc::new(MeshHost::default());
    let lease = host.lease.select("https://a.example".into()).unwrap();
    let started = Arc::new(Notify::new());
    let requests = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = Router::new().route(
        "/v1/chat/completions",
        post({
            let started = started.clone();
            let requests = requests.clone();
            move || {
                let started = started.clone();
                requests.fetch_add(1, Ordering::SeqCst);
                async move {
                    let stream = futures_util::stream::once(async move {
                        started.notify_one();
                        std::future::pending::<Result<Bytes, std::io::Error>>().await
                    });
                    Body::from_stream(stream)
                }
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let gateway = Gateway::start(host.preparing.clone(), {
        let lease = host.lease.clone();
        Arc::new(move |id| lease.with_current(id, |_| Ok(port)))
    })
    .await
    .unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let url = format!("{}/chat/completions", gateway.base_url(&lease));
    let request = tokio::spawn({
        let client = client.clone();
        let url = url.clone();
        async move {
            client
                .post(url)
                .body("private A prompt")
                .send()
                .await
                .unwrap()
                .text()
                .await
        }
    });
    started.notified().await;
    assert!(host.preparing.try_lock().is_err());
    // No release of the upstream gate: production Stop must cancel it itself.
    tokio::time::timeout(std::time::Duration::from_secs(2), stop_compute(&host))
        .await
        .unwrap()
        .unwrap();
    assert!(host.lease.current().unwrap().is_none());
    assert!(host.preparing.try_lock().is_ok());
    let rejected = client.post(url).send().await.unwrap();
    assert_eq!(rejected.status(), StatusCode::CONFLICT);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    request.await.unwrap().ok();
    drop(gateway);
    server.abort();
}

#[tokio::test]
async fn persistence_lock_and_delayed_old_management_do_not_cancel_new_requests() {
    let fence = Arc::new(Fence::default());
    let (held, a) = fence.request("A").await;
    let read = fence.lock();
    tokio::pin!(read);
    assert!(futures_util::poll!(&mut read).is_pending());
    assert!(
        !a.is_cancelled(),
        "persistence-only access does not interrupt"
    );
    drop(held);
    drop(read.await);
    let replacing = fence.interrupt(Some("A")).await;
    let delayed = fence.interrupt(Some("A"));
    tokio::pin!(delayed);
    assert!(futures_util::poll!(&mut delayed).is_pending());
    drop(replacing);
    drop(delayed.await);
    let (held, b) = fence.request("B").await;
    let stale = fence.interrupt(Some("A"));
    tokio::pin!(stale);
    assert!(futures_util::poll!(&mut stale).is_pending());
    assert!(!b.is_cancelled(), "an old operation cannot cancel B");
    drop(held);
    drop(stale.await);
    assert!(!b.is_cancelled());
}

#[tokio::test]
async fn dropping_downstream_body_retires_held_upstream_without_management() {
    let replacement = Arc::new(Fence::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = Router::new().route(
        "/v1/chat/completions",
        post(|| async {
            let first = futures_util::stream::once(async {
                Ok::<_, std::io::Error>(Bytes::from_static(b"first"))
            });
            Body::from_stream(first.chain(futures_util::stream::pending()))
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let state = Forward {
        replacement: replacement.clone(),
        target: Arc::new(move |_| Ok(port)),
        client: reqwest::Client::builder().no_proxy().build().unwrap(),
    };
    let response = forward(State(state), Path("A".into()), Bytes::new()).await;
    let mut body = response.into_body().into_data_stream();
    assert_eq!(body.next().await.unwrap().unwrap(), "first");
    assert!(replacement.try_lock().is_err());
    drop(body);
    let released = tokio::time::timeout(std::time::Duration::from_secs(2), replacement.lock())
        .await
        .unwrap();
    drop(released);
    server.abort();
}

#[tokio::test]
async fn interrupt_cancels_both_requests_queued_before_first_admission() {
    let fence = Fence::default();
    let held = fence.lock().await;
    let first = fence.request("A");
    let second = fence.request("A");
    tokio::pin!(first, second);
    assert!(futures_util::poll!(&mut first).is_pending());
    assert!(futures_util::poll!(&mut second).is_pending());
    drop(held);
    let (first_guard, first_cancel) = first.await;
    let stopping = fence.interrupt(Some("A"));
    tokio::pin!(stopping);
    assert!(futures_util::poll!(&mut stopping).is_pending());
    assert!(first_cancel.is_cancelled());
    drop(first_guard);
    let (second_guard, second_cancel) = second.await;
    assert!(
        second_cancel.is_cancelled(),
        "queued request must not forward"
    );
    drop(second_guard);
    drop(stopping.await);
}
