use super::*;

#[test]
fn inline_csp_hash_matches_html_newline_normalization() {
    let expected =
        base64::engine::general_purpose::STANDARD.encode(Sha256::digest("first\nsecond\nthird\n"));
    for source in [
        "first\nsecond\nthird\n",
        "first\r\nsecond\r\nthird\r\n",
        "first\rsecond\rthird\r",
        "first\r\nsecond\rthird\n",
    ] {
        assert_eq!(inline_csp_hash(source), expected);
    }
    assert_ne!(inline_csp_hash("first\nsecond\nthird"), expected);
}

fn options(path: &str) -> OAuthRequest {
    OAuthRequest {
        authorization_url: "https://provider.example/authorize?client_id=buzz&scope=a%20b&scope=c"
            .into(),
        callback_path: path.into(),
        use_state: true,
    }
}

#[derive(Debug, PartialEq)]
struct Started {
    id: String,
    callback_url: String,
    authorization: url::Url,
}

const OWNER: &str = "owner";

fn start(host: &OAuthCallbackHost, request: OAuthRequest) -> Result<Started, String> {
    start_as(host, OWNER, request)
}

fn start_as(
    host: &OAuthCallbackHost,
    owner: &str,
    request: OAuthRequest,
) -> Result<Started, String> {
    let mut opened = None;
    let attempt = host.begin(owner, request, |url| {
        opened = Some(url::Url::parse(url).unwrap());
        Ok(())
    })?;
    let authorization = opened.unwrap();
    let callback_url = attempt.callback_url;
    assert_eq!(
        authorization
            .query_pairs()
            .find(|(name, _)| name == "redirect_uri")
            .unwrap()
            .1,
        callback_url,
    );
    Ok(Started {
        id: attempt.id,
        callback_url,
        authorization,
    })
}

fn begin(host: &OAuthCallbackHost, path: String) -> Result<Started, String> {
    start(
        host,
        OAuthRequest {
            use_state: false,
            ..options(&path)
        },
    )
}

// Existing transport-only cases exercise the explicit custom-protocol mode.
fn parse_callback(
    bytes: &[u8],
    authority: &str,
    path: &str,
) -> (u16, &'static str, Option<OAuthCallback>) {
    super::parse_callback(bytes, authority, path, None)
}

fn response(parameters: &[(&str, &str)]) -> OAuthCallback {
    OAuthCallback {
        parameters: parameters
            .iter()
            .map(|(name, value)| ((*name).into(), (*value).into()))
            .collect(),
    }
}

#[test]
fn selected_path_must_be_a_canonical_absolute_path_without_query_or_fragment() {
    let state = OAuthCallbackHost::default();
    for path in [
        "",
        "callback",
        "//evil.example/callback",
        "/callback?x=y",
        "/callback#x",
        "/a/../callback",
        "/\\evil.example/callback",
        "/callback with spaces",
    ] {
        assert_eq!(
            begin(&state, path.into()),
            Err("Invalid callback path".into())
        );
    }
    assert!(state.0.lock().unwrap().is_empty());
}

fn request(authority: &str, target: &str, extra: &str) -> Vec<u8> {
    format!("GET {target} HTTP/1.1\r\nHost: {authority}\r\n{extra}\r\n").into_bytes()
}

#[test]
fn callback_requires_the_exact_loopback_host_and_selected_path() {
    let host = "127.0.0.1:4567";
    let path = "/callback/random";
    for bytes in [
        request("evil.example", "/callback/random?code=x", ""),
        request(host, "//evil.example/callback/random?code=x", ""),
        request(
            host,
            "/callback/random?code=x",
            "Origin: https://evil.example\r\n",
        ),
        request(host, "/callback/random?code=x", "Host: 127.0.0.1:4567\r\n"),
        request(host, "/callback/random?code=x#fragment", ""),
        b"POST /callback/random?code=x HTTP/1.1\r\nHost: 127.0.0.1:4567\r\n\r\n".to_vec(),
    ] {
        let (status, _, code) = parse_callback(&bytes, host, path);
        assert_eq!(status, 400);
        assert!(code.is_none());
    }
    for target in ["/callback/wrong?code=x", "/wrong/../callback/random?code=x"] {
        assert_eq!(
            parse_callback(&request(host, target, ""), host, path).0,
            404
        );
    }
}

#[test]
fn callback_rejects_missing_empty_duplicate_or_oversized_code() {
    let host = "127.0.0.1:4567";
    let path = "/callback/random";
    for query in [
        "",
        "?code=",
        "?code=a&code=b",
        &format!("?code={}", "a".repeat(4097)),
    ] {
        let (_, _, code) =
            parse_callback(&request(host, &format!("{path}{query}"), ""), host, path);
        assert!(code.is_none());
    }
}

async fn send(url: &url::Url, target: &str, extra: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", url.port().unwrap()))
        .await
        .unwrap();
    stream
        .write_all(&request(
            &format!("127.0.0.1:{}", url.port().unwrap()),
            target,
            extra,
        ))
        .await
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    response
}

#[tokio::test]
async fn real_listener_preserves_callback_parameters_and_closes_after_completion() {
    let state = OAuthCallbackHost::default();
    let attempt = begin(&state, "/oauth2redirect/provider".into()).unwrap();
    let id = attempt.id.as_str();
    let url = url::Url::parse(&attempt.callback_url).unwrap();
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert!(uuid::Uuid::parse_str(id).is_ok());
    assert!(!url.as_str().contains(id));
    let wait = state.wait(id);
    let browser = async {
        assert!(send(&url, "/callback/wrong?code=x", "")
            .await
            .starts_with("HTTP/1.1 404"));
        assert!(send(&url, &format!("{}?code=a&code=b", url.path()), "")
            .await
            .starts_with("HTTP/1.1 400"));
        // Keep a second connection queued behind the callback. Its identity stays
        // tied to this listener even if another test later reuses the port.
        let address = ("127.0.0.1", url.port().unwrap());
        let mut callback = TcpStream::connect(address).await.unwrap();
        let queued = TcpStream::connect(address).await.unwrap();
        callback
            .write_all(&request(
                &format!("127.0.0.1:{}", url.port().unwrap()),
                &format!(
                    "{}?code=one%2Btime&state=attempt%2Bstate&extra=a&extra=b",
                    url.path()
                ),
                "",
            ))
            .await
            .unwrap();
        let mut response = String::new();
        callback.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("Cache-Control: no-store"));
        assert!(response.contains("Referrer-Policy: no-referrer"));
        assert!(response.contains("<title>Builderlab sign-in</title>"));
        assert!(response.contains("role=\"img\" aria-label=\"Builderlab\""));
        assert!(response.contains(include_str!("../../../public/builderlab-mark.svg")));
        assert!(response.contains("<h1 id=\"heading\">Signing you in…</h1>"));
        assert!(!response.contains("Return to the app to finish verification."));
        assert!(response.contains("data-complete=\"true\""));
        assert!(response.contains("data-close-delay=\"3\""));
        assert!(response.contains("Closing this window automatically</span>"));
        assert!(response.contains("You can close this window.</span>"));
        assert!(response.contains("id=\"close-spinner\""));
        assert!(!response.contains("{{"));
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        let style = body
            .split_once("<style>")
            .unwrap()
            .1
            .split_once("</style>")
            .unwrap()
            .0;
        let parsed_style = style.replace("\r\n", "\n").replace('\r', "\n");
        let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(parsed_style));
        assert!(headers.contains(&format!("style-src 'sha256-{hash}'")));
        assert!(headers.contains("default-src 'none'"));
        assert!(headers.contains("img-src data:;"));
        assert!(headers.contains("font-src data:;"));
        let font = style
            .split_once("url(\"data:font/woff2;base64,")
            .unwrap()
            .1
            .split_once('"')
            .unwrap()
            .0;
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(font)
                .unwrap(),
            include_bytes!("inter-latin.woff2")
        );
        let artwork = body
            .split_once("src=\"data:image/webp;base64,")
            .unwrap()
            .1
            .split_once('"')
            .unwrap()
            .0;
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(artwork)
                .unwrap(),
            include_bytes!("cubes.webp")
        );
        assert!(headers.contains("base-uri 'none'; frame-ancestors 'none'"));
        assert!(headers.contains(&format!("Content-Length: {}\r\n", body.len())));
        assert!(!headers.contains("unsafe-inline"));
        let script = body
            .split_once("<script>")
            .unwrap()
            .1
            .split_once("</script>")
            .unwrap()
            .0;
        assert_eq!(script, include_str!("page.js"));
        let parsed_script = script.replace("\r\n", "\n").replace('\r', "\n");
        let script_hash =
            base64::engine::general_purpose::STANDARD.encode(Sha256::digest(parsed_script));
        assert!(headers.contains(&format!("script-src 'sha256-{script_hash}'")));
        assert_eq!(body.matches("<script").count(), 1);
        assert!(!response.contains("one+time"));
        assert!(!response.contains("attempt"));
        assert!(!response.contains("one%2Btime"));
        queued
    };
    let (result, mut queued) = tokio::join!(wait, browser);
    let expected = response(&[
        ("code", "one+time"),
        ("state", "attempt+state"),
        ("extra", "a"),
        ("extra", "b"),
    ]);
    assert_eq!(result, Ok(expected));
    assert!(state.0.lock().unwrap().is_empty());
    state.cancel(id).unwrap();
    let mut byte = [0];
    let closed = tokio::time::timeout(Duration::from_secs(5), queued.read(&mut byte))
        .await
        .expect("completed callback must close queued connections");
    match closed {
        Ok(0) => (),
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => (),
        other => panic!("expected queued connection to close, got {other:?}"),
    }
    assert!(state.wait(id).await.is_err());
}

#[tokio::test]
async fn cancellation_unblocks_wait_and_stale_cancel_does_not_end_a_new_attempt() {
    let state = OAuthCallbackHost::default();
    let first = start(&state, options("/callback/legacy-nonce")).unwrap().id;
    assert!(begin(&state, "/callback/other".into()).is_err());
    let wait = state.wait(&first);
    let cancel = async {
        state.cancel(&first).unwrap();
    };
    let (result, ()) = tokio::join!(wait, cancel);
    assert_eq!(result, Err("Sign-in canceled.".into()));
    let attempt = begin(&state, "/callback/new-nonce".into()).unwrap();
    let second = attempt.id;
    assert_ne!(first, second);
    let url = url::Url::parse(&attempt.callback_url).unwrap();
    state.cancel(&first).unwrap();
    let target = format!("{}?code=next", url.path());
    let (result, _) = tokio::join!(state.wait(&second), send(&url, &target, ""));
    assert_eq!(result, Ok(response(&[("code", "next")])));
}

#[tokio::test(start_paused = true)]
async fn abandoned_listener_expires_and_can_be_replaced() {
    let state = OAuthCallbackHost::default();
    let id = start(&state, options("/oauth2redirect/provider"))
        .unwrap()
        .id;
    assert_eq!(state.wait(&id).await, Err(TIMED_OUT.into()));
    let next = start(&state, options("/oauth2redirect/provider"))
        .unwrap()
        .id;
    state.cancel(&next).unwrap();
}

#[tokio::test]
async fn main_document_reload_cancels_wait_and_allows_new_sign_in() {
    use tauri::webview::PageLoadEvent::{Finished, Started};

    let state = OAuthCallbackHost::default();
    let first = start(&state, options("/callback/old")).unwrap().id;
    let peer = start_as(&state, "peer", options("/callback/peer"))
        .unwrap()
        .id;
    for (label, event) in [("browser-content", Started), ("main", Finished)] {
        state.document_load(label, event).unwrap();
        assert_eq!(state.0.lock().unwrap()[OWNER].id, first);
        assert_eq!(state.0.lock().unwrap()["peer"].id, peer);
    }
    let reload = async {
        state.document_load("main", Started).unwrap();
        let attempt = begin(&state, "/callback/new".into()).unwrap();
        let next = attempt.id;
        let url = url::Url::parse(&attempt.callback_url).unwrap();
        let target = format!("{}?code=new-login", url.path());
        let (result, _) = tokio::join!(state.wait(&next), send(&url, &target, ""));
        assert_eq!(result, Ok(response(&[("code", "new-login")])));
    };
    let (result, peer, ()) = tokio::join!(biased; state.wait(&first), state.wait(&peer), reload);
    assert_eq!(result, Err("Sign-in canceled.".into()));
    assert_eq!(peer, Err("Sign-in canceled.".into()));
}

#[tokio::test]
async fn attempts_from_different_owners_resolve_independently() {
    let host = OAuthCallbackHost::default();
    let server = host
        .begin_federated(
            "server-a",
            "https://identity.example/v1/login/start".into(),
            |_| Ok(()),
            None,
        )
        .unwrap();
    let restore = start_as(&host, "restore", options("/callback/restore")).unwrap();
    // Each owner keeps its single slot while the other's attempt is pending.
    assert!(host
        .begin_federated(
            "server-a",
            "https://identity.example/v1/login/start".into(),
            |_| { panic!("A pending owner must not launch a second attempt") },
            None,
        )
        .is_err());
    assert!(start_as(&host, "restore", options("/callback/other")).is_err());
    let server_url = url::Url::parse(&server.callback_url).unwrap();
    let restore_url = url::Url::parse(&restore.callback_url).unwrap();
    assert_ne!(server_url.port(), restore_url.port());
    // Another attempt's path does not reach this attempt's listener.
    let stray = send(&server_url, &format!("{}?code=x", restore_url.path()), "").await;
    assert!(stray.starts_with("HTTP/1.1 404"));
    let state = restore
        .authorization
        .query_pairs()
        .find(|(name, _)| name == "state")
        .unwrap()
        .1
        .into_owned();
    let target = format!("{}?code=restore&state={state}", restore_url.path());
    let (result, _) = tokio::join!(host.wait(&restore.id), send(&restore_url, &target, ""));
    assert_eq!(
        result,
        Ok(response(&[("code", "restore"), ("state", &state)]))
    );
    // Cancelling one owner leaves the other's attempt pending.
    let peer = host
        .begin_federated(
            "server-b",
            "https://peer.example/v1/login/start".into(),
            |_| Ok(()),
            None,
        )
        .unwrap();
    host.cancel(&server.id).unwrap();
    assert_eq!(
        host.wait(&server.id).await,
        Err("Sign-in is no longer available".into())
    );
    let peer_url = url::Url::parse(&peer.callback_url).unwrap();
    let target = format!("{}?code=peer", peer_url.path());
    let (result, _) = tokio::join!(host.wait(&peer.id), send(&peer_url, &target, ""));
    assert_eq!(result, Ok(response(&[("code", "peer")])));
    assert!(host.0.lock().unwrap().is_empty());
}

#[test]
fn startup_rejects_unsafe_urls_and_conflicting_owned_parameters_before_launch() {
    let host = OAuthCallbackHost::default();
    let invalid = [
        OAuthRequest {
            authorization_url: "http://provider.example/authorize".into(),
            ..options("/callback")
        },
        OAuthRequest {
            authorization_url: "https://user:secret@provider.example/authorize".into(),
            ..options("/callback")
        },
        OAuthRequest {
            authorization_url: "https://provider.example/authorize#fragment".into(),
            ..options("/callback")
        },
        OAuthRequest {
            authorization_url: "not a URL".into(),
            ..options("/callback")
        },
        OAuthRequest {
            authorization_url: "https://provider.example/authorize?st%61te=caller".into(),
            ..options("/callback")
        },
        OAuthRequest {
            authorization_url: "https://provider.example/authorize?state=caller".into(),
            use_state: false,
            ..options("/callback")
        },
        OAuthRequest {
            authorization_url: "https://provider.example/authorize?redirect_uri=caller".into(),
            ..options("/callback")
        },
        OAuthRequest {
            authorization_url: "https://provider.example/authorize?redirect%5Furi=caller".into(),
            ..options("/callback")
        },
    ];
    for request in invalid {
        assert!(host
            .begin(OWNER, request, |_| panic!(
                "Invalid startup must not launch"
            ))
            .is_err());
        assert!(host.0.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn default_state_rejects_invalid_success_and_error_callbacks_then_completes_once() {
    let host = OAuthCallbackHost::default();
    let attempt = start(&host, options("/oauth2redirect/provider")).unwrap();
    let authorization = &attempt.authorization;
    assert_eq!(
        authorization
            .query_pairs()
            .filter(|(name, _)| name == "scope")
            .map(|(_, value)| value.into_owned())
            .collect::<Vec<_>>(),
        ["a b", "c"]
    );
    assert_eq!(
        authorization
            .query_pairs()
            .filter(|(name, _)| name == "redirect_uri")
            .count(),
        1
    );
    let state = authorization
        .query_pairs()
        .find(|(name, _)| name == "state")
        .unwrap()
        .1
        .into_owned();
    assert_eq!(URL_SAFE_NO_PAD.decode(&state).unwrap().len(), 32);
    assert_ne!(state, attempt.id);
    let url = url::Url::parse(&attempt.callback_url).unwrap();
    assert!(!url.as_str().contains(&state));
    assert!(!url.as_str().contains(&attempt.id));
    for response in ["code=one", "error=access_denied"] {
        for suffix in [
            String::new(),
            "&state=wrong".into(),
            format!("&state={state}&state={state}"),
        ] {
            let html = send(&url, &format!("{}?{response}{suffix}", url.path()), "").await;
            assert!(html.starts_with("HTTP/1.1 400"));
            assert!(html.contains("Invalid callback"));
            assert!(html.contains("<h1 id=\"heading\">Sign-in needs attention</h1>"));
            assert!(html.contains("data-complete=\"false\""));
            assert!(!html.contains(&state));
            assert!(!html.contains("access_denied"));
            assert!(host.0.lock().unwrap().contains_key(OWNER));
        }
    }
    let target = format!("{}?code=one&state={state}", url.path());
    let (result, html) = tokio::join!(host.wait(&attempt.id), send(&url, &target, ""));
    assert_eq!(result, Ok(response(&[("code", "one"), ("state", &state)])));
    assert!(html.starts_with("HTTP/1.1 200"));
    assert!(!html.contains(&state));
    assert!(host.0.lock().unwrap().is_empty());
    assert!(host.wait(&attempt.id).await.is_err());
    let next = start(&host, options("/oauth2redirect/provider")).unwrap();
    let next_state = next
        .authorization
        .query_pairs()
        .find(|(name, _)| name == "state")
        .unwrap()
        .1
        .into_owned();
    assert_ne!(state, next_state);
    let next_url = url::Url::parse(&next.callback_url).unwrap();
    assert!(send(&next_url, &target, "")
        .await
        .starts_with("HTTP/1.1 400"));
    let next_target = format!(
        "{}?error=access_denied&state={next_state}&error_description=private+detail&error_uri=https%3A%2F%2Fprovider.example%2Fhelp",
        next_url.path()
    );
    let (result, html) = tokio::join!(host.wait(&next.id), send(&next_url, &next_target, ""));
    assert_eq!(
        result,
        Ok(response(&[
            ("error", "access_denied"),
            ("state", &next_state),
            ("error_description", "private detail"),
            ("error_uri", "https://provider.example/help")
        ]))
    );
    assert!(html.starts_with("HTTP/1.1 400"));
    assert!(html.contains("<h1 id=\"heading\">Sign-in needs attention</h1>"));
    assert!(html.contains("data-complete=\"false\""));
    assert!(!html.contains("access_denied"));
    assert!(!html.contains(&next_state));
    assert!(!html.contains("private detail"));
    assert!(!html.contains("provider.example/help"));
    assert!(host.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn redirect_uri_is_used_even_with_state_disabled() {
    let host = OAuthCallbackHost::default();
    let attempt = start(
        &host,
        OAuthRequest {
            use_state: false,
            ..options("/callback/random")
        },
    )
    .unwrap();
    assert!(!attempt
        .authorization
        .query_pairs()
        .any(|(name, _)| name == "state"));
    assert_eq!(
        attempt
            .authorization
            .query_pairs()
            .filter(|(name, _)| name == "redirect_uri")
            .count(),
        1
    );
    let url = url::Url::parse(&attempt.callback_url).unwrap();
    // Disabled means no validation, even for duplicate unsolicited state.
    let target = format!("{}?code=one&state=a&state=b", url.path());
    let (result, _) = tokio::join!(host.wait(&attempt.id), send(&url, &target, ""));
    assert_eq!(
        result,
        Ok(response(&[("code", "one"), ("state", "a"), ("state", "b")]))
    );
}

#[tokio::test]
async fn launch_failure_cleans_up_but_cannot_cancel_a_replacement_after_reload() {
    let host = OAuthCallbackHost::default();
    assert_eq!(
        host.begin(OWNER, options("/callback"), |_| Err(
            "private-launch-error".into()
        )),
        Err("Could not open the sign-in browser".into())
    );
    assert!(host.0.lock().unwrap().is_empty());
    let mut next = None;
    assert_eq!(
        host.begin(OWNER, options("/callback"), |_| {
            host.document_load("main", tauri::webview::PageLoadEvent::Started)?;
            next = Some(start(&host, options("/callback"))?);
            Err("private-launch-error".into())
        }),
        Err("Could not open the sign-in browser".into())
    );
    let next = next.unwrap();
    assert_eq!(host.0.lock().unwrap()[OWNER].id, next.id);
    host.cancel(&next.id).unwrap();
}

#[tokio::test]
async fn federated_handoff_uses_return_to_without_legacy_oauth_fields_and_keeps_its_result() {
    let host = OAuthCallbackHost::default();
    let mut opened = None;
    let attempt = host.begin_federated(
        OWNER,
        "https://identity.example/prefix/v1/login/start?handoff_challenge=fixture&handoff_challenge_method=S256".into(),
        |url| { opened = Some(url::Url::parse(url).unwrap()); Ok(()) },
        Some("synthetic-browser".into()),
    ).unwrap();
    let opened = opened.unwrap();
    let params: Vec<_> = opened.query_pairs().into_owned().collect();
    assert_eq!(opened.path(), "/prefix/v1/login/start");
    assert_eq!(
        params
            .iter()
            .filter(|(name, _)| name == "return_to")
            .count(),
        1
    );
    assert!(!params
        .iter()
        .any(|(name, _)| matches!(name.as_str(), "state" | "redirect_uri" | "type" | "product")));
    let callback = url::Url::parse(&attempt.callback_url).unwrap();
    assert_eq!(callback.host_str(), Some("127.0.0.1"));
    assert!(callback.port().is_some_and(|port| port > 0));
    for (target, status, message) in [
        ("/wrong?code=fixture-code".to_string(), "404", "Not found"),
        (
            format!("{}?code=", callback.path()),
            "400",
            "Invalid callback",
        ),
    ] {
        let html = send(&callback, &target, "").await;
        assert!(html.starts_with(&format!("HTTP/1.1 {status}")));
        assert_federated_callback(&html, message);
        assert!(html.contains("data-complete=\"false\""));
        assert!(html.contains(if status == "404" {
            "<h1 id=\"heading\">Page not found</h1>"
        } else {
            "<h1 id=\"heading\">Sign-in needs attention</h1>"
        }));
    }
    let html = send(
        &callback,
        &format!("{}?code=fixture-code", callback.path()),
        "",
    )
    .await;
    assert!(html.starts_with("HTTP/1.1 200"));
    assert_federated_callback(&html, "Return to the app to finish verification.");
    assert!(html.contains("<h1 id=\"heading\">Sign-in received</h1>"));
    assert!(html.contains("data-complete=\"true\""));
    assert!(!html.contains("fixture-code"));
    assert!(host
        .begin(OWNER, options("/other"), |_| panic!(
            "A completed but unconsumed callback still owns the listener"
        ))
        .is_err());
    assert_eq!(
        host.wait(&attempt.id).await.unwrap(),
        response(&[("code", "fixture-code")])
    );
    assert!(host.wait(&attempt.id).await.is_err());
    assert!(host
        .0
        .lock()
        .unwrap()
        .values()
        .find(|a| a.id == attempt.id)
        .unwrap()
        .focus
        .deadline(&attempt.id)
        .is_some());
    host.cancel(&attempt.id).unwrap();
    let next = start(&host, options("/other")).unwrap();
    host.cancel(&next.id).unwrap();
}

fn assert_federated_callback(response: &str, message: &str) {
    let (headers, body) = response.split_once("\r\n\r\n").unwrap();
    assert!(body.contains("<title>Buzz sign-in</title>"));
    assert!(body.contains("data-provider=\"Buzz\""));
    assert!(body.contains("role=\"img\" aria-label=\"Buzz\""));
    assert!(body.contains(include_str!("../../../public/buzz-mark.svg")));
    assert!(body.contains("<span>Buzz</span>"));
    assert!(body.contains(&format!("<p>{message}</p>")));
    assert!(body.contains("<main aria-labelledby=\"heading\">"));
    assert!(body.contains("name=\"viewport\""));
    assert!(!body.contains("{{"));
    assert!(!body.contains("Builderlab"));
    assert!(body.contains(include_str!("page.js")));
    let parsed_script = include_str!("page.js")
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let script_hash =
        base64::engine::general_purpose::STANDARD.encode(Sha256::digest(parsed_script));
    assert!(headers.contains(&format!("script-src 'sha256-{script_hash}'")));
    assert!(body.contains("Closing this window automatically"));
    assert!(body.contains("id=\"close-spinner\""));
    let (shell, card) = body
        .split_once("<main aria-labelledby=\"heading\">")
        .unwrap();
    assert!(shell.contains("class=\"brand\""));
    assert!(!card.contains("class=\"brand\""));
    assert!(shell.contains("class=\"artwork\" aria-hidden=\"true\""));
    let artwork = body
        .split_once("data:image/webp;base64,")
        .unwrap()
        .1
        .split_once('"')
        .unwrap()
        .0;
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(artwork)
            .unwrap(),
        include_bytes!("cubes.webp")
    );
    assert!(body.contains("data-close-delay=\"3\""));
    let style = body
        .split_once("<style>")
        .unwrap()
        .1
        .split_once("</style>")
        .unwrap()
        .0;
    let parsed_style = style.replace("\r\n", "\n").replace('\r', "\n");
    let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(parsed_style));
    assert!(headers.contains(&format!("style-src 'sha256-{hash}'")));
    assert!(headers.contains("default-src 'none'"));
    assert!(headers.contains("img-src data:;"));
    assert!(headers.contains("font-src data:;"));
    assert!(headers.contains("base-uri 'none'; frame-ancestors 'none'"));

    assert!(!headers.contains("unsafe-inline"));
    assert!(headers.contains("Cache-Control: no-store\r\n"));
    assert!(headers
        .split("\r\n")
        .any(|header| header == "Referrer-Policy: no-referrer"));
    assert!(headers.contains(&format!("Content-Length: {}\r\n", body.len())));
}

#[tokio::test]
async fn a_renewal_can_replace_a_consumed_callback_during_its_return_delay() {
    use futures_util::FutureExt;

    let host = OAuthCallbackHost::default();
    let authorization = "https://identity.example/v1/login/start";
    let first = host
        .begin_federated(
            OWNER,
            authorization.into(),
            |_| Ok(()),
            Some("browser".into()),
        )
        .unwrap();
    let focus = host.0.lock().unwrap()[OWNER].focus.clone();
    let wait = host.wait(&first.id);
    tokio::pin!(wait);
    assert!(wait.as_mut().now_or_never().is_none());
    assert!(host
        .begin_federated(
            OWNER,
            authorization.into(),
            |_| panic!("Still pending"),
            None
        )
        .is_err());
    let url = url::Url::parse(&first.callback_url).unwrap();
    assert!(send(&url, &format!("{}?code=fixture", url.path()), "")
        .await
        .starts_with("HTTP/1.1 200"));
    assert_eq!(wait.await.unwrap(), response(&[("code", "fixture")]));

    // Freeze only after the real loopback response, so I/O cannot auto-advance time.
    tokio::time::pause();
    let deadline = focus.deadline(&first.id).unwrap();
    assert!(tokio::time::Instant::now() < deadline);
    let mut opened = false;
    let renewal = host
        .begin_federated(
            OWNER,
            authorization.into(),
            |_| {
                opened = true;
                Ok(())
            },
            Some("next-browser".into()),
        )
        .unwrap();
    assert!(opened);
    assert!(tokio::time::Instant::now() < deadline);
    assert!(focus.deadline(&first.id).is_none());
    host.cancel(&first.id).unwrap(); // The preceding return's cleanup is stale.
    assert_eq!(host.0.lock().unwrap()[OWNER].id, renewal.id);
    assert!(host
        .begin_federated(
            OWNER,
            authorization.into(),
            |_| panic!("Renewal pending"),
            None
        )
        .is_err());
    host.cancel(&renewal.id).unwrap();
}

#[tokio::test]
async fn concurrent_servers_keep_independent_return_permissions_until_cancel_or_reload() {
    let host = OAuthCallbackHost::default();
    let mut completed = Vec::new();
    for owner in ["server-a", "server-b"] {
        let attempt = host
            .begin_federated(
                owner,
                "https://identity.example/v1/login/start".into(),
                |_| Ok(()),
                Some("synthetic-browser".into()),
            )
            .unwrap();
        let url = url::Url::parse(&attempt.callback_url).unwrap();
        let html = send(&url, &format!("{}?code=fixture", url.path()), "").await;
        assert!(html.starts_with("HTTP/1.1 200"));
        host.wait(&attempt.id).await.unwrap();
        let focus = host.0.lock().unwrap()[owner].focus.clone();
        assert!(focus.deadline(&attempt.id).is_some());
        completed.push((attempt.id, focus));
    }
    let [(first, first_focus), (second, second_focus)] = completed.as_slice() else {
        panic!("Both servers must complete their own callback");
    };
    host.cancel(first).unwrap();
    assert!(first_focus.deadline(first).is_none());
    assert!(second_focus.deadline(second).is_some());
    host.cancel(first).unwrap();
    assert!(second_focus.deadline(second).is_some());
    host.document_load("main", tauri::webview::PageLoadEvent::Started)
        .unwrap();
    assert!(second_focus.deadline(second).is_none());
}

#[tokio::test]
async fn federated_error_uses_buzz_presentation_and_keeps_private_details_native() {
    let host = OAuthCallbackHost::default();
    let attempt = host
        .begin_federated(
            OWNER,
            "https://organization.example/v1/login/start".into(),
            |_| Ok(()),
            None,
        )
        .unwrap();
    let callback = url::Url::parse(&attempt.callback_url).unwrap();
    let html = send(
        &callback,
        &format!(
            "{}?error=access_denied&error_description=private-detail",
            callback.path()
        ),
        "",
    )
    .await;
    assert!(html.starts_with("HTTP/1.1 400"));
    assert_federated_callback(&html, "Sign-in failed. Return to the app to retry.");
    assert!(html.contains("<h1 id=\"heading\">Sign-in needs attention</h1>"));
    assert!(html.contains("data-complete=\"false\""));
    assert!(!html.contains("private-detail"));
    assert!(!html.contains("access_denied"));
    assert_eq!(
        host.wait(&attempt.id).await.unwrap(),
        response(&[
            ("error", "access_denied"),
            ("error_description", "private-detail")
        ])
    );
}
