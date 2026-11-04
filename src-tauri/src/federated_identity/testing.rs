//! Crate-visible fixtures for owners outside this module that must prove they
//! carry NIP-FI evidence, without reaching into session internals.
use super::{tests, FederatedIdentity, Status};
use std::sync::Arc;

/// A signed-in session whose assertions come from `adapter_base` (a plain
/// loopback fixture) and whose community at `relay` requires NIP-FI.
pub(crate) fn signed_in(adapter_base: String, relay: &str, required: bool) -> FederatedIdentity {
    let owner = undiscovered(adapter_base, relay);
    owner.discovered(relay, required);
    owner
}
/// A signed-in, saved session whose identity origin and adapter are both
/// `origin`, a plain loopback fixture, so granted API calls and the adapter's
/// session route reach one test server.
pub(crate) fn signed_in_at(origin: String) -> FederatedIdentity {
    let store = Arc::new(tests::Memory::default());
    let mut owner = tests::at_adapter(store.clone(), origin.clone());
    Arc::get_mut(&mut owner.0)
        .unwrap()
        .config
        .as_mut()
        .unwrap()
        .identity_origin = origin;
    let session = tests::record();
    *store.raw.lock().unwrap() = Some(session.raw.clone());
    owner.install(session);
    owner
}
/// A signed-in session for an organization community at `relay` that has
/// not been discovered yet.
fn undiscovered(adapter_base: String, relay: &str) -> FederatedIdentity {
    let mut owner = tests::at_adapter(Arc::new(tests::Memory::default()), adapter_base);
    let authority = &relay["wss://".len()..];
    Arc::get_mut(&mut owner.0)
        .unwrap()
        .config
        .as_mut()
        .unwrap()
        .community_hosts = vec![authority.into()];
    owner.install(tests::record());
    owner
}

impl FederatedIdentity {
    fn install(&self, session: Arc<super::Session>) {
        let mut state = self.state();
        state.session = Some(session);
        state.snapshot.status = Status::SignedIn;
        state.restored = true;
    }
    pub(crate) fn sign_out_for_test(&self) {
        self.retire(Status::SignedOut, None);
    }
    /// Retires the current account and installs another in its place.
    pub(crate) fn switch_account_for_test(&self) {
        self.retire(Status::SignedOut, None);
        self.install(tests::record());
    }
}

/// An issuer that mints one assertion for `viewer` at `relay`: its base, the
/// assertion, and a handle yielding the request bodies it received.
pub(crate) async fn issuer(
    viewer: &str,
    relay: &str,
) -> (String, String, tokio::task::JoinHandle<Vec<String>>) {
    let minted = super::protocol::now().unwrap() as u64;
    let expires = minted + 60;
    let assertion = jwt(viewer, relay, minted, expires);
    let (base, server) = tests::adapter(vec![serde_json::json!({
        "assertion": assertion,
        "nostr_pubkey": viewer,
        "expires_at": expires,
    })])
    .await;
    let bodies = tokio::spawn(async move {
        server
            .await
            .unwrap()
            .into_iter()
            .map(|wire| String::from_utf8(wire.body).unwrap())
            .collect()
    });
    (base, assertion, bodies)
}

/// An unsigned NIP-FI JWT the client-side validator accepts for `relay`.
fn jwt(viewer: &str, relay: &str, minted: u64, expires: u64) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let claims = serde_json::json!({"nostr_pubkey":viewer,"aud":format!("https://{}",&relay[6..]),"iat":minted,"exp":expires});
    format!(
        "{}.{}.eA",
        URL_SAFE_NO_PAD.encode(br#"{"typ":"nip-fi+jwt","alg":"ES256"}"#),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}

/// The loopback certificate every native transport trusts in tests, and only
/// in tests: `127.0.0.1`, self-signed, generated once per test process.
fn certificate() -> &'static rcgen::CertifiedKey<rcgen::KeyPair> {
    static CERTIFICATE: std::sync::OnceLock<rcgen::CertifiedKey<rcgen::KeyPair>> =
        std::sync::OnceLock::new();
    CERTIFICATE
        .get_or_init(|| rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap())
}
pub(crate) fn trusted_root() -> reqwest::Certificate {
    reqwest::Certificate::from_der(certificate().cert.der()).unwrap()
}
/// The same root as a PEM file, for Git's `http.sslCAInfo`.
pub(crate) fn trusted_root_file() -> &'static std::path::Path {
    static FILE: std::sync::OnceLock<tempfile::TempPath> = std::sync::OnceLock::new();
    FILE.get_or_init(|| {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        std::io::Write::write_all(&mut file, certificate().cert.pem().as_bytes()).unwrap();
        file.into_temp_path()
    })
}
pub(crate) fn trusted_connector() -> tokio_tungstenite::Connector {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(certificate().cert.der().clone()).unwrap();
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    tokio_tungstenite::Connector::Rustls(Arc::new(
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    ))
}

/// A signed-in viewer and an organization community on loopback TLS. Its
/// `/info` discovery document requires NIP-FI or not; `token` is the one
/// assertion its issuer mints.
pub(crate) struct Community {
    pub(crate) fi: FederatedIdentity,
    pub(crate) host: crate::identity::IdentityHost,
    /// `https://127.0.0.1:<port>/`.
    pub(crate) origin: url::Url,
    required: bool,
    token: String,
    listener: Arc<tokio::net::TcpListener>,
    acceptor: tokio_rustls::TlsAcceptor,
}
pub(crate) async fn community(required: bool) -> Community {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let authority = listener.local_addr().unwrap().to_string();
    let host = crate::identity::IdentityHost::fixture();
    let viewer = host.viewer().await.unwrap();
    let relay = format!("wss://{authority}");
    let (adapter, token, _) = issuer(&viewer, &relay).await;
    let key =
        rustls::pki_types::PrivateKeyDer::Pkcs8(certificate().signing_key.serialize_der().into());
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let server = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![certificate().cert.der().clone()], key)
        .unwrap();
    Community {
        fi: undiscovered(adapter, &relay),
        host,
        origin: url::Url::parse(&format!("https://{authority}/")).unwrap(),
        required,
        token,
        listener: Arc::new(listener),
        acceptor: tokio_rustls::TlsAcceptor::from(Arc::new(server)),
    }
}
impl Community {
    /// Answers discovery at `/info` whenever asked, and every other request
    /// with the next of `replies`, one connection each, recording those other
    /// requests' heads in order.
    pub(crate) fn serve(&self, replies: Vec<String>) -> Served {
        let (listener, acceptor) = (self.listener.clone(), self.acceptor.clone());
        let discovery = self.discovery();
        let heads = Arc::new(std::sync::Mutex::new(Vec::new()));
        let expected = replies.len();
        let recorded = heads.clone();
        let task = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut replies = replies.into_iter();
            while replies.len() > 0 {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut stream = acceptor.accept(tcp).await.unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    head.push(stream.read_u8().await.unwrap());
                }
                let head = String::from_utf8(head).unwrap();
                let answer = if head.starts_with("GET /info ") {
                    discovery.clone()
                } else {
                    recorded.lock().unwrap().push(head);
                    replies.next().unwrap()
                };
                stream.write_all(answer.as_bytes()).await.unwrap();
                let _ = stream.shutdown().await;
            }
        });
        Served {
            task,
            heads,
            expected,
        }
    }
    /// Answers discovery at `/info`, then accepts the next request as a
    /// WebSocket (`101`) and runs `script` on it. Yields that request's head.
    pub(crate) fn serve_socket<F, Fut>(&self, script: F) -> tokio::task::JoinHandle<String>
    where
        F: FnOnce(
                tokio_tungstenite::WebSocketStream<
                    tokio_rustls::server::TlsStream<tokio::net::TcpStream>,
                >,
            ) -> Fut
            + Send
            + 'static,
        Fut: std::future::Future<Output = ()> + Send,
    {
        let (listener, acceptor) = (self.listener.clone(), self.acceptor.clone());
        let discovery = self.discovery();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut stream = acceptor.accept(tcp).await.unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    head.push(stream.read_u8().await.unwrap());
                }
                let head = String::from_utf8(head).unwrap();
                if head.starts_with("GET /info ") {
                    stream.write_all(discovery.as_bytes()).await.unwrap();
                    let _ = stream.shutdown().await;
                    continue;
                }
                let key = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("sec-websocket-key")
                            .then(|| value.trim().to_owned())
                    })
                    .unwrap();
                let accept =
                    tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
                stream
                    .write_all(
                        format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").as_bytes(),
                    )
                    .await
                    .unwrap();
                script(
                    tokio_tungstenite::WebSocketStream::from_raw_socket(
                        stream,
                        tokio_tungstenite::tungstenite::protocol::Role::Server,
                        None,
                    )
                    .await,
                )
                .await;
                return head;
            }
        })
    }
    fn discovery(&self) -> String {
        if self.required {
            reply(
                "200 OK",
                r#"{"limitation":{"federated_identity":true},"federated_identity":{"core":"client-attached","assertion_freshness":{"class":"offline-jwt"}}}"#,
            )
        } else {
            reply("200 OK", "{}")
        }
    }
    /// Asserts `head` carries exactly the issued assertion if the community
    /// requires NIP-FI, and none otherwise; never as `Authorization`.
    pub(crate) fn assert_carried(&self, head: &str) {
        if !self.required {
            return self.assert_uncarried(head);
        }
        let carried: Vec<_> = head
            .lines()
            .filter_map(|line| line.split_once(':'))
            .filter(|(name, _)| name.eq_ignore_ascii_case(super::assertion::HEADER))
            .map(|(_, value)| value.trim().to_owned())
            .collect();
        assert_eq!(carried, [format!("Bearer {}", self.token)], "{head}");
        assert!(
            !head.to_ascii_lowercase().contains("authorization: bearer"),
            "{head}"
        );
    }
    /// Asserts `head` carries no assertion in any header or casing.
    pub(crate) fn assert_uncarried(&self, head: &str) {
        let lower = head.to_ascii_lowercase();
        assert!(
            !lower.contains(&super::assertion::HEADER.to_ascii_lowercase()),
            "{head}"
        );
        assert!(!lower.contains("bearer"), "{head}");
        assert!(!head.contains(&self.token), "{head}");
    }
}
/// A running `Community::serve`.
pub(crate) struct Served {
    task: tokio::task::JoinHandle<()>,
    heads: Arc<std::sync::Mutex<Vec<String>>>,
    expected: usize,
}
impl Served {
    /// The recorded heads once every expected request has arrived; fails
    /// within five seconds naming the first request that never did.
    pub(crate) async fn heads(mut self) -> Vec<String> {
        let finished =
            tokio::time::timeout(std::time::Duration::from_secs(5), &mut self.task).await;
        let heads = self.received();
        match finished {
            Ok(result) => result.unwrap(),
            Err(_) => {
                self.task.abort();
                panic!(
                    "request {} of {} never arrived; received {heads:?}",
                    heads.len() + 1,
                    self.expected
                );
            }
        }
        heads
    }
    /// The heads recorded so far.
    pub(crate) fn received(&self) -> Vec<String> {
        self.heads.lock().unwrap().clone()
    }
}
impl Drop for Served {
    fn drop(&mut self) {
        self.task.abort();
    }
}
/// A complete response with a JSON body that closes its connection.
pub(crate) fn reply(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}
