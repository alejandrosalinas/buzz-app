//! Browser sign-in startup and loopback OAuth authorization-code responses.
//! RFC 8252 §§7.3, 8.3, 8.4, 8.9; RFC 6749 §§4.1.2, 4.1.2.1; RFC 9700 §2.1.
//! See this folder's README.md for ownership and limits.
mod focus;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
pub(crate) use focus::capture as capture_browser;
use focus::READABLE_DELAY;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    task::JoinHandle,
};

/// Rejection when no callback arrives in time; the app tells it apart from a failure.
pub(crate) const TIMED_OUT: &str = "Sign-in timed out. Try again.";

#[derive(Debug, PartialEq)]
pub(crate) struct OAuthCallback {
    // Preserve ordering and duplicates so the caller can validate known parameters.
    pub(crate) parameters: Vec<(String, String)>,
}
#[derive(Debug, PartialEq)]
pub(crate) struct OAuthAttempt {
    pub(crate) id: String,
    // Reuse this exact redirect_uri in token exchange (RFC 6749 §4.1.3).
    pub(crate) callback_url: String,
}
pub(crate) struct OAuthRequest {
    pub(crate) authorization_url: String,
    pub(crate) callback_path: String,
    pub(crate) use_state: bool,
}
type CallbackResult = Result<OAuthCallback, String>;
struct Attempt {
    id: String,
    result: Option<oneshot::Receiver<CallbackResult>>,
    task: JoinHandle<()>,
    retain_result: bool,
    focus: focus::FocusReturn,
}
impl Drop for Attempt {
    fn drop(&mut self) {
        self.task.abort();
        self.focus.cancel(Some(&self.id));
    }
}
/// One pending attempt per owner, keyed by the caller's owner key.
#[derive(Clone, Default)]
pub(crate) struct OAuthCallbackHost(Arc<Mutex<HashMap<String, Attempt>>>);

impl OAuthCallbackHost {
    pub(crate) fn document_load(
        &self,
        label: &str,
        event: tauri::webview::PageLoadEvent,
    ) -> Result<(), String> {
        if label == "main" && event == tauri::webview::PageLoadEvent::Started {
            // The new document cannot recover the previous plugin's attempt ID.
            self.0.lock().map_err(|_| "Sign-in unavailable")?.clear();
        }
        Ok(())
    }

    pub(crate) fn begin(
        &self,
        owner: &str,
        request: OAuthRequest,
        open: impl FnOnce(&str) -> Result<(), String>,
    ) -> Result<OAuthAttempt, String> {
        self.begin_with_parameter(owner, request, "redirect_uri", open, None)
    }

    /// NIP-FA binds its handoff secret instead of requiring echoed OAuth state.
    /// The attempt and all callback values stay inside the native session owner.
    pub(crate) fn begin_federated(
        &self,
        owner: &str,
        authorization_url: String,
        open: impl FnOnce(&str) -> Result<(), String>,
        browser: Option<String>,
    ) -> Result<OAuthAttempt, String> {
        self.begin_with_parameter(
            owner,
            OAuthRequest {
                authorization_url,
                callback_path: format!("/federated/{}", uuid::Uuid::new_v4()),
                use_state: false,
            },
            "return_to",
            open,
            browser,
        )
    }

    fn begin_with_parameter(
        &self,
        owner: &str,
        request: OAuthRequest,
        callback_parameter: &str,
        open: impl FnOnce(&str) -> Result<(), String>,
        browser: Option<String>,
    ) -> Result<OAuthAttempt, String> {
        let mut authorization =
            url::Url::parse(&request.authorization_url).map_err(|_| "Invalid authorization URL")?;
        if authorization.scheme() != "https"
            || !authorization.username().is_empty()
            || authorization.password().is_some()
            || authorization.fragment().is_some()
        {
            return Err("Invalid authorization URL".into());
        }
        if authorization
            .query_pairs()
            .any(|(name, _)| name == "state" || name == "redirect_uri" || name == "return_to")
        {
            return Err("Invalid authorization parameters".into());
        }
        let path = request.callback_path;
        let redirect = url::Url::parse(&format!("http://127.0.0.1{path}"))
            .map_err(|_| "Invalid callback path")?;
        if !path.starts_with('/')
            || path.starts_with("//")
            || path.len() > 1024
            || redirect.path() != path
            || redirect.query().is_some()
            || redirect.fragment().is_some()
        {
            return Err("Invalid callback path".into());
        }
        let mut attempts = self.0.lock().map_err(|_| "Sign-in unavailable")?;
        // A consumed handoff can be replaced while only its focus return remains.
        if attempts.get(owner).is_some_and(|attempt| {
            let returning =
                attempt.result.is_none() && attempt.focus.deadline(&attempt.id).is_some();
            !returning && (attempt.retain_result || !attempt.task.is_finished())
        }) {
            return Err("An OAuth callback is already pending".into());
        }
        // Binding is synchronous so cancellation cannot overtake listener registration.
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| "Could not start the sign-in listener")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Could not start the sign-in listener")?;
        let authority = listener
            .local_addr()
            .map_err(|_| "Could not start the sign-in listener")?
            .to_string();
        let listener =
            TcpListener::from_std(listener).map_err(|_| "Could not start the sign-in listener")?;
        let callback = format!("http://{authority}{path}");
        authorization
            .query_pairs_mut()
            .append_pair(callback_parameter, &callback);
        // Native-owned, single-use CSRF correlation (RFC 8252 §8.9; RFC 9700 §2.1).
        // Disabled only for an explicit custom-protocol compatibility exception.
        let expected_state = if request.use_state {
            let mut random = [0; 32];
            getrandom::fill(&mut random).map_err(|_| "Could not start sign-in")?;
            let value = URL_SAFE_NO_PAD.encode(random);
            authorization.query_pairs_mut().append_pair("state", &value);
            Some(value)
        } else {
            None
        };
        // Generic OAuth keeps Builderlab presentation and browser-close behavior.
        let builderlab = callback_parameter == "redirect_uri";
        let id = uuid::Uuid::new_v4().to_string();
        let focus = focus::FocusReturn::default();
        focus.arm(&id, browser);
        let completion = (focus.clone(), id.clone());
        let (send, receive) = oneshot::channel();
        let task = tokio::spawn(async move {
            let result = tokio::time::timeout(
                Duration::from_secs(600),
                receive_callback(
                    listener,
                    &authority,
                    &path,
                    expected_state.as_deref(),
                    builderlab,
                ),
            )
            .await
            .unwrap_or_else(|_| Err(TIMED_OUT.into()));
            completion.0.received(
                &completion.1,
                result.as_ref().is_ok_and(|callback| {
                    !callback.parameters.iter().any(|(name, _)| name == "error")
                }),
            );
            let _ = send.send(result);
        });
        attempts.insert(
            owner.to_owned(),
            Attempt {
                id: id.clone(),
                result: Some(receive),
                task,
                // A native FI login retains its completed handoff until wait/cancel.
                // Generic OAuth keeps its existing finished-task replacement rule.
                retain_result: callback_parameter == "return_to",
                focus,
            },
        );
        drop(attempts);
        if open(authorization.as_str()).is_err() {
            self.cancel(&id)?;
            return Err("Could not open the sign-in browser".into());
        }
        Ok(OAuthAttempt {
            id,
            callback_url: callback,
        })
    }

    pub(crate) async fn wait(&self, id: &str) -> CallbackResult {
        let receiver = self
            .0
            .lock()
            .map_err(|_| "Sign-in unavailable")?
            .values_mut()
            .find(|attempt| attempt.id == id)
            .and_then(|attempt| attempt.result.take())
            .ok_or("Sign-in is no longer available")?;
        let result = receiver
            .await
            .unwrap_or_else(|_| Err("Sign-in canceled.".into()));
        // The listener is finished, but a captured browser return survives
        // until verification completes or its attempt guard is canceled.
        let returning = self
            .0
            .lock()
            .map_err(|_| "Sign-in unavailable")?
            .values()
            .find(|attempt| attempt.id == id)
            .is_some_and(|attempt| attempt.focus.deadline(id).is_some());
        if result.is_err() || !returning {
            self.cancel(id)?;
        }
        result
    }

    pub(crate) async fn complete<R: tauri::Runtime>(&self, app: tauri::AppHandle<R>, id: String) {
        let focus = self.0.lock().ok().and_then(|attempts| {
            attempts
                .values()
                .find(|attempt| attempt.id == id)
                .map(|attempt| attempt.focus.clone())
        });
        if let Some(focus) = focus {
            focus.complete(app, id.clone()).await;
        }
        let _ = self.cancel(&id);
    }

    pub(crate) fn cancel(&self, id: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "Sign-in unavailable")?
            .retain(|_, attempt| attempt.id != id);
        Ok(())
    }
}

async fn receive_callback(
    listener: TcpListener,
    authority: &str,
    path: &str,
    expected_state: Option<&str>,
    builderlab: bool,
) -> CallbackResult {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|_| "Sign-in listener failed")?;
        // Bound slow/oversize requests; malformed callbacks do not consume the attempt.
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            callback(&mut stream, authority, path, expected_state, builderlab),
        )
        .await;
        if let Ok(Some(response)) = result {
            // Release the socket before publishing completion to the waiting caller.
            drop(listener);
            return Ok(response);
        }
    }
}

async fn callback(
    stream: &mut TcpStream,
    authority: &str,
    path: &str,
    expected_state: Option<&str>,
    builderlab: bool,
) -> Option<OAuthCallback> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 1024];
    while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
        let count = stream.read(&mut chunk).await.ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > 8192 {
            reply(stream, 400, "Invalid callback", builderlab).await;
            return None;
        }
    }
    let (status, message, result) = parse_callback(&bytes, authority, path, expected_state);
    reply(stream, status, message, builderlab).await;
    result
}

fn parse_callback(
    bytes: &[u8],
    authority: &str,
    path: &str,
    expected_state: Option<&str>,
) -> (u16, &'static str, Option<OAuthCallback>) {
    let invalid = (400, "Invalid callback", None);
    let Ok(text) = std::str::from_utf8(bytes) else {
        return invalid;
    };
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split_whitespace();
    let (Some("GET"), Some(target), Some("HTTP/1.1" | "HTTP/1.0"), None) =
        (first.next(), first.next(), first.next(), first.next())
    else {
        return invalid;
    };
    if !target.starts_with('/') || target.starts_with("//") {
        return invalid;
    }
    let mut hosts = Vec::new();
    for line in lines.take_while(|line| !line.is_empty()) {
        let Some((name, value)) = line.split_once(':') else {
            return invalid;
        };
        if name.eq_ignore_ascii_case("origin") {
            return invalid;
        }
        if name.eq_ignore_ascii_case("host") {
            hosts.push(value.trim());
        }
    }
    if hosts != [authority] {
        return invalid;
    }
    let Ok(url) = url::Url::parse(&format!("http://{authority}{target}")) else {
        return invalid;
    };
    if target.split('?').next() != Some(path) || url.path() != path {
        return (404, "Not found", None);
    }
    if url.fragment().is_some() {
        return invalid;
    }
    let fields: Vec<_> = url.query_pairs().into_owned().collect();
    if let Some(expected) = expected_state {
        let mut states = fields.iter().filter(|(name, _)| name == "state");
        if states.next().map(|(_, value)| value.as_str()) != Some(expected)
            || states.next().is_some()
        {
            return invalid;
        }
    }
    if fields.iter().any(|(name, _)| name == "error") {
        return (
            400,
            "Sign-in failed. Return to the app to retry.",
            Some(OAuthCallback { parameters: fields }),
        );
    }
    let codes: Vec<_> = fields.iter().filter(|(name, _)| name == "code").collect();
    if codes.len() != 1 || codes[0].1.is_empty() || codes[0].1.len() > 4096 {
        return invalid;
    }
    (
        200,
        "Return to the app to finish verification.",
        Some(OAuthCallback { parameters: fields }),
    )
}

fn inline_csp_hash(source: &str) -> String {
    // HTML parsing normalizes CRLF and lone CR before CSP hashes inline text.
    // include_str! preserves checkout line endings, including Windows CRLF.
    let source = source.replace("\r\n", "\n").replace('\r', "\n");
    base64::engine::general_purpose::STANDARD.encode(Sha256::digest(source.as_bytes()))
}

async fn reply(stream: &mut TcpStream, status: u16, message: &str, builderlab: bool) {
    // All copy comes from the fixed responses above, never from callback values.
    let heading = match status {
        200 if builderlab => "Signing you in…",
        200 => "Sign-in received",
        404 => "Page not found",
        _ => "Sign-in needs attention",
    };
    let style = include_str!("page.css").replace(
        "{{font}}",
        &base64::engine::general_purpose::STANDARD.encode(include_bytes!("inter-latin.woff2")),
    );
    let style_hash = inline_csp_hash(&style);
    let mut policy = format!("default-src 'none'; img-src data:; font-src data:; style-src 'sha256-{style_hash}'; base-uri 'none'; frame-ancestors 'none'");
    let script = include_str!("page.js");
    let script_hash = inline_csp_hash(script);
    policy.push_str(&format!("; script-src 'sha256-{script_hash}'"));
    let script = format!("<script>{script}</script>");
    let artwork = base64::engine::general_purpose::STANDARD.encode(include_bytes!("cubes.webp"));
    let artwork = include_str!("artwork.html").replace("{{artwork}}", &artwork);
    let provider = if builderlab { "Builderlab" } else { "Buzz" };
    let mark = if builderlab {
        include_str!("../../../public/builderlab-mark.svg")
    } else {
        include_str!("../../../public/buzz-mark.svg")
    };
    let label = if builderlab { "" } else { "<span>Buzz</span>" };
    let brand = include_str!("brand.html")
        .replace("{{provider}}", provider)
        .replace("{{mark}}", mark)
        .replace("{{label}}", label);
    // Replace whole HTML comments so the template remains valid on its own.
    let body = include_str!("page.html")
        .replace("<!-- {{pageBrand}} -->", &brand)
        .replace("<!-- {{style}} -->", &format!("<style>{style}</style>"))
        .replace("<!-- {{script}} -->", &script)
        .replace("<!-- {{artwork}} -->", &artwork)
        .replace("<!-- {{closeHint}} -->", include_str!("close-hint.html"))
        .replace("{{provider}}", provider)
        .replace("{{complete}}", if status == 200 { "true" } else { "false" })
        .replace("{{closeDelay}}", &READABLE_DELAY.as_secs().to_string())
        .replace("{{heading}}", heading)
        .replace(
            "{{message}}",
            if builderlab && status == 200 {
                ""
            } else {
                message
            },
        );
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Bad Request",
    };
    let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Security-Policy: {policy}\r\nReferrer-Policy: no-referrer\r\n\r\n{body}", body.len());
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

#[cfg(test)]
mod tests;
