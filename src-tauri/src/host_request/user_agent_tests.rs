use super::*;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

async fn server(method: &'static str) -> (reqwest::Url, tokio::task::JoinHandle<Vec<String>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url =
        reqwest::Url::parse(&format!("http://{}/test", listener.local_addr().unwrap())).unwrap();
    let task = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(5), async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                assert!(request.len() < MAX_HEADER_BYTES);
                request.push(socket.read_u8().await.unwrap());
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with(&format!("{method} /test HTTP/1.1\r\n")));
            let length = request
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .map_or(0, |(_, value)| value.trim().parse::<usize>().unwrap());
            assert!(length <= MAX_HEADER_BYTES);
            // Consume the multipart body before closing, avoiding a TCP reset.
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
            request
                .lines()
                .filter_map(|line| line.split_once(':'))
                .filter(|(name, _)| name.eq_ignore_ascii_case("user-agent"))
                .map(|(_, value)| value.trim().to_owned())
                .collect()
        })
        .await
        .unwrap()
    });
    (url, task)
}

#[tokio::test]
async fn ordinary_and_protected_requests_default_user_agent_and_preserve_overrides() {
    for protected in [false, true] {
        for supplied in [
            None,
            Some(("User-Agent", "ExamplePlugin/1.0")),
            Some(("uSeR-aGeNt", "ExamplePlugin/1.0")),
            Some(("user-agent", "")),
        ] {
            let mut input = HostRequest {
                url: "https://example.test/test".into(),
                method: "GET".into(),
                headers: BTreeMap::new(),
                body: None,
                timeout_ms: None,
            };
            if let Some((name, value)) = supplied {
                input.headers.insert(name.into(), value.into());
            }
            let (_, method, headers) = validate_request(&input).unwrap();
            let (url, server) = server("GET").await;
            let response = send_request_with_policy(
                url,
                method,
                headers,
                input.body,
                Duration::from_secs(5),
                protected,
            )
            .await
            .unwrap();
            assert_eq!(response.status, 200);
            let expected = supplied.map_or_else(crate::relay::user_agent, |(_, value)| value);
            assert_eq!(server.await.unwrap(), [expected], "protected={protected}");
        }
    }
}

#[tokio::test]
async fn byte_download_sends_default_user_agent() {
    let (url, server) = server("GET").await;
    // Match plugin_host_request_bytes: use the shared production client.
    let (status, _, bytes) = read_bytes(
        client(false)
            .unwrap()
            .get(url)
            .timeout(Duration::from_secs(5)),
        2,
    )
    .await
    .unwrap();
    assert_eq!(status, 200);
    assert_eq!(bytes, b"{}");
    assert_eq!(server.await.unwrap(), [crate::relay::user_agent()]);
}

#[tokio::test]
async fn one_shot_byte_upload_sends_default_user_agent() {
    let (url, server) = server("POST").await;
    let upload = ByteUpload {
        url: url.to_string(),
        field: "image".into(),
        name: "example.png".into(),
        content_type: "image/png".into(),
        fields: BTreeMap::new(),
    };
    let response = send_byte_upload(url, &upload, b"\x89PNG\r\n\x1a\n")
        .await
        .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.body, "{}");
    assert_eq!(server.await.unwrap(), [crate::relay::user_agent()]);
}
