//! Purpose-bound agent operations. Never return key material or unscoped plaintext.
use super::{origin, send, Result};
use crate::federated_identity::FederatedIdentity;
use crate::identity::IdentityHost;
use base64::{engine::general_purpose::STANDARD, Engine};
use buzz_agent_controller::AppAgents;
use hmac::{Hmac, Mac};
use nostr::key::{PublicKey as NostrPublicKey, SecretKey as NostrSecretKey};
use nostr::nips::nip44::{self, v2::ConversationKey};
use secp256k1::{schnorr::Signature, Keypair, Secp256k1, XOnlyPublicKey};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};

const HEX: &str = "0123456789abcdef";
fn key(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| HEX.as_bytes().contains(&b))
}
fn signature(secret: &[u8; 32], text: &str) -> Result<String> {
    let secp = Secp256k1::signing_only();
    let pair = Keypair::from_secret_key(
        &secp,
        &secp256k1::SecretKey::from_byte_array(*secret).map_err(|_| "Invalid identity")?,
    );
    Ok(secp
        .sign_schnorr_no_aux_rand(&Sha256::digest(text), &pair)
        .to_string())
}
fn relay(community: &str) -> Result<String> {
    let mut url = origin(community)?;
    url.set_scheme("wss").map_err(|_| "Invalid community")?;
    Ok(url.to_string().trim_end_matches('/').to_string())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AgentTarget {
    pubkey: String,
    owner: String,
    confirmed: Option<bool>,
}
#[tauri::command]
pub(crate) async fn relay_agent_resolve(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    target: AgentTarget,
) -> Result<Value> {
    let relay_url = relay(&community)?;
    host.with_key(move |secret, viewer| {
        if target.owner != viewer || !key(&target.pubkey) || target.pubkey == viewer || target.confirmed != Some(true) {
            return Err("Explicit owner community resolution required".into());
        }
        let proof = signature(secret, &format!("nostr:agent-community:{}:{relay_url}", target.pubkey))?;
        Ok(json!({"pubkey": target.pubkey, "relayUrl": relay_url, "owner": viewer, "signature": proof}))
    }).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LogTarget {
    id: String,
    pubkey: String,
    relay_url: String,
    nonce: String,
}
#[tauri::command]
pub(crate) async fn relay_agent_log_proof(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    target: LogTarget,
) -> Result<String> {
    let expected = relay(&community)?;
    if !target.relay_url.starts_with("wss://") {
        return Err("Log authorization unavailable".into());
    }
    let actual = relay(&target.relay_url.replacen("wss://", "https://", 1))?;
    if target.relay_url != actual {
        return Err("Log authorization unavailable".into());
    }
    host.with_key(move |secret, viewer| {
        if actual != expected
            || !key(&target.pubkey)
            || target.pubkey == viewer
            || target.id
                != format!(
                    "{}-{:x}",
                    target.pubkey,
                    Sha256::digest(expected.as_bytes())
                )
            || target.nonce.len() != 36
            || target.nonce.bytes().enumerate().any(|(i, b)| {
                if [8, 13, 18, 23].contains(&i) {
                    b != b'-'
                } else {
                    !b.is_ascii_hexdigit() || b.is_ascii_uppercase()
                }
            })
        {
            return Err("Log authorization unavailable".into());
        }
        signature(
            secret,
            &format!(
                "buzz-app:harness-log:v1:{}:{}:{}:{}",
                target.id, target.pubkey, expected, target.nonce
            ),
        )
    })
    .await
}

#[derive(Deserialize, serde::Serialize, Clone)]
pub(crate) struct AgentEvent {
    pub(crate) id: String,
    pub(crate) pubkey: String,
    pub(crate) sig: String,
    pub(crate) created_at: u64,
    pub(crate) kind: u16,
    pub(crate) tags: Vec<Vec<String>>,
    pub(crate) content: String,
}
fn verified(event: &AgentEvent) -> Result<()> {
    if !key(&event.id)
        || !key(&event.pubkey)
        || event.sig.len() != 128
        || event.content.len() > 87472
        || event.tags.len() > 64
        || event
            .tags
            .iter()
            .any(|tag| tag.len() > 16 || tag.iter().any(|item| item.len() > 4096))
    {
        return Err("Invalid agent envelope".into());
    }
    let bytes = serde_json::to_vec(&(
        0,
        &event.pubkey,
        event.created_at,
        event.kind,
        &event.tags,
        &event.content,
    ))
    .map_err(|_| "Invalid agent envelope")?;
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    if hex_digest(&digest) != event.id {
        return Err("Invalid agent envelope".into());
    }
    let pubkey = event
        .pubkey
        .parse::<XOnlyPublicKey>()
        .map_err(|_| "Invalid agent envelope")?;
    let sig = event
        .sig
        .parse::<Signature>()
        .map_err(|_| "Invalid agent envelope")?;
    Secp256k1::verification_only()
        .verify_schnorr(&sig, &digest, &pubkey)
        .map_err(|_| "Invalid agent envelope".into())
}
fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn exact(event: &AgentEvent, name: &str, value: &str) -> bool {
    let tags: Vec<_> = event
        .tags
        .iter()
        .filter(|tag| tag.first().map(String::as_str) == Some(name))
        .collect();
    tags.len() == 1 && tags[0].len() == 2 && tags[0][1] == value
}
fn single_memory_tag(event: &AgentEvent, name: &str, value: &str) -> bool {
    let mut tags = event
        .tags
        .iter()
        .filter(|tag| tag.first().map(String::as_str) == Some(name));
    tags.next()
        .is_some_and(|tag| tag.get(1).is_some_and(|item| item == value))
        && tags.next().is_none()
}
fn decrypt(secret: &[u8; 32], agent: &str, content: &str) -> Result<String> {
    let secret = NostrSecretKey::from_slice(secret).map_err(|_| "Invalid identity")?;
    let agent = NostrPublicKey::from_hex(agent).map_err(|_| "Invalid agent envelope")?;
    nip44::decrypt(&secret, &agent, content).map_err(|_| "Invalid encrypted agent envelope".into())
}
#[tauri::command]
pub(crate) async fn relay_agent_observer(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    event: AgentEvent,
) -> Result<Value> {
    origin(&community)?;
    host.with_key(move |secret, viewer| decode_observer_with_key(secret, viewer, &event))
        .await
}
fn decode_observer_with_key(secret: &[u8; 32], viewer: &str, event: &AgentEvent) -> Result<Value> {
    if event.kind != 24200 {
        return Err("Invalid observer envelope".into());
    }
    decode_archive(secret, viewer, event, false)
}
pub(crate) fn decode_archive(
    secret: &[u8; 32],
    viewer: &str,
    event: &AgentEvent,
    history: bool,
) -> Result<Value> {
    verified(event)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Invalid clock")?
        .as_secs();
    if !matches!(event.kind, 24200 | 44200)
        || !exact(event, "p", viewer)
        || !exact(event, "agent", &event.pubkey)
        || (event.kind == 24200 && !exact(event, "frame", "telemetry"))
        || event.created_at > now + 300
        || now.saturating_sub(event.created_at) > if history { 90 * 24 * 60 * 60 } else { 300 }
        || event.content.len() < 132
        || event.content.len() > 87472
    {
        return Err("Invalid observer envelope".into());
    }
    let text = decrypt(secret, &event.pubkey, &event.content)?;
    if text.len() > 65535 {
        return Err("Invalid observer frame".into());
    }
    serde_json::from_str::<Value>(&text).map_err(|_| "Invalid observer frame")?;
    Ok(
        json!({"id": event.id, "agent": event.pubkey, "createdAt": event.created_at, "plaintext": text}),
    )
}

// Preserve duplicate-key evidence before serde_json's Value map discards it.
// This visitor is recursive so unknown nested fields cannot hide ambiguous names.
struct Unique(Value);
impl<'de> serde::Deserialize<'de> for Unique {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        use serde::de::{Error, MapAccess, SeqAccess, Visitor};
        struct Visit;
        impl<'de> Visitor<'de> for Visit {
            type Value = Unique;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                write!(f, "unique JSON")
            }
            fn visit_bool<E: Error>(self, v: bool) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_i64<E: Error>(self, v: i64) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_u64<E: Error>(self, v: u64) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_f64<E: Error>(self, v: f64) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_str<E: Error>(self, v: &str) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_none<E: Error>(self) -> std::result::Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_unit<E: Error>(self) -> std::result::Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Unique, A::Error> {
                let mut result = Vec::new();
                while let Some(Unique(value)) = seq.next_element::<Unique>()? {
                    result.push(value);
                }
                Ok(Unique(Value::Array(result)))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Unique, A::Error> {
                let mut result = serde_json::Map::new();
                while let Some((name, Unique(value))) = map.next_entry::<String, Unique>()? {
                    if result.insert(name, value).is_some() {
                        return Err(A::Error::custom("duplicate memory field"));
                    }
                }
                Ok(Unique(Value::Object(result)))
            }
        }
        deserializer.deserialize_any(Visit)
    }
}
fn unique_json(text: &str) -> Result<Value> {
    serde_json::from_str::<Unique>(text)
        .map(|value| value.0)
        .map_err(|_| "Invalid memory body".into())
}

pub(crate) fn slug(s: &str) -> bool {
    if s == "core" {
        return true;
    }
    if s.len() > 255 || !s.starts_with("mem/") {
        return false;
    }
    s[4..].split('/').all(|part| {
        !part.is_empty()
            && part.len() <= 64
            && part.bytes().enumerate().all(|(i, b)| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || (i > 0 && (b == b'-' || b == b'_'))
            })
    })
}
/// Most events one memory query asks for. A memory body is at most 64 KiB, and
/// its ciphertext is base64 (about 4/3 larger) plus the event envelope, so a
/// page of 128 ordinary memory events (about 11 MiB at most) stays under the
/// 16 MiB response cap; a page that exceeds it (an event carrying unusually
/// many tags) fails the read. Few large pages keep the round trips few: about
/// 240 memories take 2.
const MEMORY_PAGE: usize = 128;
const MEMORY_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
/// Most memory events and decoded bytes one read keeps. A listing that
/// reaches either cap stops there and is returned partial.
const MEMORY_EVENTS: usize = 4096;
const MEMORY_DECODED_BYTES: usize = 8 * 1024 * 1024;

/// What one paged memory read may spend before it returns what it has,
/// marked partial.
struct MemoryBudget {
    /// Relay `/query` calls. The relay admits 300 per owner per minute, shared
    /// with every other read the app makes, so one listing takes at most 64
    /// (about a fifth). At 128 events a page that is more than
    /// `MEMORY_EVENTS`, so the event cap is the real listing limit.
    requests: usize,
    events: usize,
    /// Undecoded response bytes kept across pages. Ciphertext is base64 plus
    /// the event envelope, so 16 MiB covers the 8 MiB decoded cap.
    raw_bytes: usize,
    /// How long each page's fetch, and then its decode, may take.
    page_wait: std::time::Duration,
    /// One deadline for the whole command, from entry through decoding,
    /// under the frontend's 10 seconds so a partial listing arrives before
    /// the caller gives up. A streamed read has none: its pages reach the
    /// caller as they decode, so only `page_wait` bounds it.
    deadline: Option<tokio::time::Instant>,
}

impl MemoryBudget {
    fn new() -> Self {
        Self {
            requests: 64,
            events: MEMORY_EVENTS,
            raw_bytes: 16 * 1024 * 1024,
            page_wait: std::time::Duration::from_secs(9),
            deadline: Some(tokio::time::Instant::now() + std::time::Duration::from_secs(9)),
        }
    }

    fn streamed() -> Self {
        Self {
            deadline: None,
            ..Self::new()
        }
    }

    /// When a step starting now must finish: `page_wait` from now, or the
    /// read's deadline, plus `grace`, when that is sooner.
    fn stop(
        page_wait: std::time::Duration,
        deadline: Option<tokio::time::Instant>,
        grace: std::time::Duration,
    ) -> tokio::time::Instant {
        let step = tokio::time::Instant::now() + page_wait;
        deadline.map_or(step, |deadline| step.min(deadline + grace))
    }
}

/// What a memory read returns when its deadline passes before it decoded
/// anything.
fn unread_memories() -> Value {
    json!({"entries": [], "partial": true})
}

/// One memory query's answer: its records and response size, or the relay
/// refusing it for rate (429).
enum MemoryPage {
    Records(Vec<Option<Value>>, usize),
    Limited,
}

/// The `d` tag of memory `name`: an HMAC of the slug under the owner's
/// conversation key, so the relay never sees slugs.
fn memory_address(conversation: &ConversationKey, name: &str) -> Result<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(conversation.as_bytes())
        .map_err(|_| "Invalid memory address")?;
    mac.update(b"agent-memory/v1/d-tag\0");
    mac.update(name.as_bytes());
    Ok(hex_digest(&mac.finalize().into_bytes()))
}

/// The agent's memory as its owner reads it: every entry, or only entry `slug`
/// when given, which is read by its address instead of from the listing.
// Tauri injects the webview and states; the rest are the IPC arguments.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn relay_agent_memories_read<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    host: tauri::State<'_, IdentityHost>,
    fi: tauri::State<'_, FederatedIdentity>,
    community: String,
    agent: String,
    slug: Option<String>,
    id: Option<String>,
    on_page: Option<tauri::ipc::JavaScriptChannelId>,
) -> Result<Value> {
    let on_page = on_page.map(|channel| channel.channel_on(webview));
    let Some(id) = id else {
        return read_agent_memories(&host, &fi, community, agent, slug, None).await;
    };
    let id = super::upload_id(Some(&id)).map_err(|_| "Invalid memory read")?;
    let Some(cancelled) = super::read_cancels()
        .start(id)
        .map_err(|_| "Relay reads are busy")?
    else {
        return Err("Memory read cancelled".into());
    };
    // Dropping the read stops its paging, and a running decode at its next
    // record.
    let result = tokio::select! {
        biased;
        _ = cancelled => Err("Memory read cancelled".into()),
        result = read_agent_memories(&host, &fi, community, agent, slug, on_page) => result,
    };
    super::read_cancels().finish(id);
    result
}

/// Reads the listing; with `on_page`, each decoded page's new or changed
/// heads go there as they land. No overall deadline cuts a streamed read
/// short: at worst its 64 requests each wait out a page, about ten minutes,
/// until its view closes and cancels it.
async fn read_agent_memories(
    host: &IdentityHost,
    fi: &FederatedIdentity,
    community: String,
    agent: String,
    slug: Option<String>,
    on_page: Option<tauri::ipc::Channel<Value>>,
) -> Result<Value> {
    let url = origin(&community)?
        .join("/query")
        .map_err(|_| "Invalid community")?;
    if !key(&agent) || slug.as_deref().is_some_and(|name| !self::slug(name)) {
        return Err("Invalid memory target".into());
    }
    let budget = if on_page.is_some() {
        MemoryBudget::streamed()
    } else {
        MemoryBudget::new()
    };
    let deadline = MemoryBudget::stop(budget.page_wait, budget.deadline, Default::default());
    let Ok(viewer) =
        tokio::time::timeout_at(deadline, host.with_key(|_, viewer| Ok(viewer.to_owned()))).await
    else {
        return Ok(unread_memories());
    };
    let viewer = viewer?;
    if viewer == agent {
        return Err("Invalid memory target".into());
    }
    let mut filter =
        json!({"kinds":[30174], "authors":[agent], "#p":[viewer], "limit":MEMORY_PAGE});
    if let Some(name) = slug.clone() {
        let target = agent.clone();
        let address = host.with_key(move |secret, _| {
            let secret = NostrSecretKey::from_slice(secret).map_err(|_| "Invalid identity")?;
            let target = NostrPublicKey::from_hex(&target).map_err(|_| "Invalid memory target")?;
            memory_address(
                &ConversationKey::derive(&secret, &target).map_err(|_| "Invalid memory target")?,
                &name,
            )
        });
        let Ok(address) = tokio::time::timeout_at(deadline, address).await else {
            return Ok(unread_memories());
        };
        filter["#d"] = json!([address?]);
    }
    // However the read ends, cancelled or done, a decode still running on a
    // blocking worker stops at its next record and releases the identity.
    let ended = ReadEnd::default();
    let decode = |records, decoder, stop| {
        decode_page(host, &viewer, &agent, records, decoder, stop, ended.flag())
    };
    let mut listing = read_memories(
        budget,
        |cursor| {
            let mut page = filter.clone();
            if let Some((until, before_id)) = cursor {
                page["until"] = json!(until);
                page["before_id"] = json!(before_id);
            }
            memory_page(host, fi, url.clone(), page)
        },
        decode,
        |delta| {
            if let Some(channel) = &on_page {
                // A closed view no longer listens; its read is cancelled.
                let _ = channel.send(delta);
            }
        },
    )
    .await?;
    if let Some(name) = slug {
        if let Some(entries) = listing["entries"].as_array_mut() {
            entries.retain(|entry| entry["slug"] == name.as_str());
        }
    }
    Ok(listing)
}

/// Set when its memory read ends, however it ends: dropping the read drops
/// it too, so decodes the read started stop.
#[derive(Default)]
struct ReadEnd(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl ReadEnd {
    fn flag(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        self.0.clone()
    }
}

impl Drop for ReadEnd {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Decodes `records` into `decoder` under the identity, stopping at `stop`
/// or once `ended` is set.
fn decode_page<'a>(
    host: &'a IdentityHost,
    viewer: &str,
    agent: &str,
    records: Vec<Option<Value>>,
    decoder: MemoryDecoding,
    stop: std::time::Instant,
    ended: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> impl std::future::Future<Output = Result<()>> + 'a {
    let (viewer, agent) = (viewer.to_owned(), agent.to_owned());
    host.with_key(move |secret, now| {
        decode_memory_events(&decoder, secret, now, &viewer, &agent, &records, || {
            ended.load(std::sync::atomic::Ordering::Relaxed) || std::time::Instant::now() >= stop
        })
    })
}

/// One page of the memory listing at `url`, sent with the community's
/// assertion when it requires NIP-FI.
async fn memory_page(
    host: &IdentityHost,
    fi: &FederatedIdentity,
    url: url::Url,
    page: Value,
) -> Result<MemoryPage> {
    let response = send(
        host,
        Some(fi),
        url,
        "POST",
        Some(json!([page]).to_string()),
        true,
        MEMORY_RESPONSE_BYTES,
    )
    .await?;
    if response.status == 429 {
        return Ok(MemoryPage::Limited);
    }
    if response.status == 401 || response.status == 403 {
        return Err("MemoryDenied".into());
    }
    if response.status != 200 || response.body.len() > MEMORY_RESPONSE_BYTES {
        return Err("Memory read failed".into());
    }
    Ok(MemoryPage::Records(
        memory_wire_records(&response.body)?,
        response.body.len(),
    ))
}

type MemoryDecoding = std::sync::Arc<std::sync::Mutex<MemoryDecoder>>;

/// How long decoding a page fetched in time may run past the read's deadline;
/// the read still answers within the frontend's 10 seconds.
const MEMORY_DECODE_GRACE: std::time::Duration = std::time::Duration::from_millis(500);

/// Pages through the listing with `page` and hands each page's new records
/// to `decode` as it arrives, with the instant decoding must stop by. A
/// decode still running then is no longer waited on, but everything already
/// decoded stays in the listing, marked partial.
async fn read_memories<P, F, D, G>(
    budget: MemoryBudget,
    page: P,
    decode: D,
    progress: impl Fn(Value),
) -> Result<Value>
where
    P: FnMut(Option<(u64, String)>) -> F,
    F: std::future::Future<Output = Result<MemoryPage>>,
    D: Fn(Vec<Option<Value>>, MemoryDecoding, std::time::Instant) -> G,
    G: std::future::Future<Output = Result<()>>,
{
    let decoder = MemoryDecoding::default();
    let (page_wait, deadline) = (budget.page_wait, budget.deadline);
    let progress = &progress;
    let (_, partial) = read_memory_pages(budget, page, |records| {
        let stop = MemoryBudget::stop(page_wait, deadline, MEMORY_DECODE_GRACE);
        let decoding = decode(records, decoder.clone(), stop.into_std());
        let decoder = decoder.clone();
        async move {
            let done = match tokio::time::timeout_at(stop, decoding).await {
                Ok(done) => done,
                Err(_) => {
                    decoder.lock().unwrap_or_else(|e| e.into_inner()).partial = true;
                    Ok(())
                }
            };
            let delta = decoder.lock().unwrap_or_else(|e| e.into_inner()).delta();
            progress(delta);
            done
        }
    })
    .await?;
    let mut decoder = decoder.lock().unwrap_or_else(|e| e.into_inner());
    decoder.partial |= partial;
    Ok(decoder.listing())
}

/// Reads newest first, a page at a time, until a short page. The relay orders
/// by `created_at DESC, id ASC` and resumes after the `(until, before_id)`
/// cursor taken from the last event of the previous page, so entries sharing
/// one second still page through. The listing is partial, keeping the pages
/// already read, when it exhausts `budget`, the relay answers 429, or a full
/// page brings nothing new (a relay ignoring `before_id`), which stops the
/// read instead of looping.
async fn read_memory_pages<F, P, K, G>(
    budget: MemoryBudget,
    mut page: P,
    mut keep: K,
) -> Result<(Vec<Option<Value>>, bool)>
where
    P: FnMut(Option<(u64, String)>) -> F,
    F: std::future::Future<Output = Result<MemoryPage>>,
    K: FnMut(Vec<Option<Value>>) -> G,
    G: std::future::Future<Output = Result<()>>,
{
    let mut events = Vec::new();
    let mut pending = None;
    let partial = (async {
        read_memory_pages_into(&budget, &mut page, &mut keep, &mut events, &mut pending).await
    })
    .await;
    // The last page kept still decodes, whatever stopped the paging.
    if let Some(kept) = pending {
        Box::pin(kept).await?;
    }
    Ok((events, partial?))
}

/// The paging loop of `read_memory_pages`. Each page's `keep` runs while the
/// next page is fetched, and finishes before the following one starts, so
/// pages still decode in order. The last one is left in `pending`.
async fn read_memory_pages_into<F, P, K, G>(
    budget: &MemoryBudget,
    page: &mut P,
    keep: &mut K,
    events: &mut Vec<Option<Value>>,
    pending: &mut Option<G>,
) -> Result<bool>
where
    P: FnMut(Option<(u64, String)>) -> F,
    F: std::future::Future<Output = Result<MemoryPage>>,
    K: FnMut(Vec<Option<Value>>) -> G,
    G: std::future::Future<Output = Result<()>>,
{
    let mut seen = std::collections::HashSet::new();
    let mut cursor = None;
    let mut raw_bytes = 0usize;
    for _ in 0..budget.requests {
        let stop = MemoryBudget::stop(budget.page_wait, budget.deadline, Default::default());
        let fetch = tokio::time::timeout_at(stop, page(cursor.clone()));
        let kept = pending.take();
        let (answer, kept) = tokio::join!(fetch, async move {
            match kept {
                Some(kept) => kept.await,
                None => Ok(()),
            }
        });
        kept?;
        let Ok(answer) = answer else {
            return Ok(true);
        };
        let MemoryPage::Records(records, bytes) = answer? else {
            return Ok(true);
        };
        raw_bytes += bytes;
        if raw_bytes > budget.raw_bytes {
            return Ok(true);
        }
        let full = records.len() >= MEMORY_PAGE;
        let mut fresh = Vec::new();
        for record in records {
            let value = record.as_ref();
            let id = value.and_then(|v| v.get("id")).and_then(Value::as_str);
            if id.is_some_and(|id| !seen.insert(id.to_owned())) {
                continue;
            }
            if let (Some(id), Some(time)) = (
                id,
                value
                    .and_then(|v| v.get("created_at"))
                    .and_then(Value::as_u64),
            ) {
                cursor = Some((time, id.to_owned()));
            }
            fresh.push(record);
        }
        let added = !fresh.is_empty();
        let over = fresh.len() > budget.events - events.len();
        fresh.truncate(budget.events - events.len());
        *pending = Some(keep(fresh.clone()));
        events.extend(fresh);
        if over {
            return Ok(true);
        }
        if !full {
            return Ok(false);
        }
        if !added || events.len() == budget.events {
            return Ok(true);
        }
    }
    Ok(true)
}

// Validate the complete array grammar before projecting members. RawValue
// preserves syntactically valid members that Value cannot represent (for
// example lone surrogates, overflowing numbers or deep unknown fields).
fn memory_wire_records(body: &str) -> Result<Vec<Option<Value>>> {
    let records: Vec<Box<serde_json::value::RawValue>> =
        serde_json::from_str(body).map_err(|_| "Memory read failed")?;
    if records.len() > MEMORY_PAGE {
        return Err("Memory read failed".into());
    }
    Ok(records
        .iter()
        .map(|raw| serde_json::from_str(raw.get()).ok())
        .collect())
}
/// The entries a memory read has decoded so far. Pages decode into it as
/// they arrive, so whatever stops the read keeps what was already decoded.
#[derive(Default)]
struct MemoryDecoder {
    heads: BTreeMap<String, (u64, String, Value)>,
    decoded_bytes: usize,
    partial: bool,
    /// The decoded-byte cap was reached; later events are not taken.
    full: bool,
    /// Slugs whose head changed since the last `delta`.
    changed: std::collections::BTreeSet<String>,
}

impl MemoryDecoder {
    fn listing(&self) -> Value {
        Self::listed(self.heads.values().map(|(_, _, entry)| entry), self.partial)
    }

    /// The heads that changed since the last call, as a listing: what a
    /// streamed read sends after each page.
    fn delta(&mut self) -> Value {
        let changed = std::mem::take(&mut self.changed);
        Self::listed(
            changed
                .iter()
                .filter_map(|name| self.heads.get(name).map(|(_, _, entry)| entry)),
            self.partial,
        )
    }

    fn listed<'a>(heads: impl Iterator<Item = &'a Value>, partial: bool) -> Value {
        let (deleted, entries): (Vec<_>, Vec<_>) = heads.partition(|entry| entry["body"].is_null());
        let mut listing = json!({"entries": entries, "partial": partial});
        // A write that recreates a deleted slug must be dated after its tombstone.
        if !deleted.is_empty() {
            listing["deleted"] = deleted
                .into_iter()
                .map(|entry| json!({"slug": entry["slug"], "createdAt": entry["createdAt"]}))
                .collect();
        }
        listing
    }
}

/// Decodes `events` alone into a listing.
#[cfg(test)]
fn decode_memories_with_key(
    secret: &[u8; 32],
    viewer: &str,
    captured_viewer: &str,
    agent: &str,
    events: &[Option<Value>],
    expired: impl Fn() -> bool,
) -> Result<Value> {
    let decoder = std::sync::Mutex::new(MemoryDecoder::default());
    decode_memory_events(
        &decoder,
        secret,
        viewer,
        captured_viewer,
        agent,
        events,
        expired,
    )?;
    let listing = decoder.lock().unwrap_or_else(|e| e.into_inner()).listing();
    Ok(listing)
}

/// Verifies and decrypts `events` newest first into `decoder`, which it locks
/// only to take each entry. It stops, marking the listing partial, once
/// `expired` says the read's time is up or the kept entries reach
/// `MEMORY_DECODED_BYTES`.
fn decode_memory_events(
    decoder: &std::sync::Mutex<MemoryDecoder>,
    secret: &[u8; 32],
    viewer: &str,
    captured_viewer: &str,
    agent: &str,
    events: &[Option<Value>],
    expired: impl Fn() -> bool,
) -> Result<()> {
    if !key(agent) || agent == viewer || viewer != captured_viewer || events.len() > MEMORY_EVENTS {
        return Err("Invalid memory target".into());
    }

    let secret_key = NostrSecretKey::from_slice(secret).map_err(|_| "Invalid identity")?;
    let public_key = NostrPublicKey::from_hex(agent).map_err(|_| "Invalid memory target")?;
    let conversation =
        ConversationKey::derive(&secret_key, &public_key).map_err(|_| "Invalid memory target")?;
    let lock = || decoder.lock().unwrap_or_else(|e| e.into_inner());
    for raw in events {
        if lock().full {
            break;
        }
        if expired() {
            lock().partial = true;
            break;
        }
        let candidate = (|| -> Result<(String, u64, String, Value)> {
            let event = AgentEvent::deserialize(raw.as_ref().ok_or("Invalid memory envelope")?)
                .map_err(|_| "Invalid memory envelope")?;
            verified(&event)?;
            let d = event
                .tags
                .iter()
                .filter(|tag| tag.first().map(String::as_str) == Some("d"))
                .collect::<Vec<_>>();
            if event.kind != 30174
                || event.pubkey != agent
                || d.len() != 1
                || d[0].len() < 2
                || !single_memory_tag(&event, "p", viewer)
                || !key(&d[0][1])
            {
                return Err("Invalid memory envelope".into());
            }
            let payload = STANDARD
                .decode(&event.content)
                .map_err(|_| "Invalid memory envelope")?;
            // Reuse the batch's ECDH result and decode base64 only once.
            // v2::decrypt_to_bytes authenticates but does not check the version byte.
            if payload.first() != Some(&2) {
                return Err("Invalid memory envelope".into());
            }
            let text = String::from_utf8(
                nip44::v2::decrypt_to_bytes(&conversation, &payload)
                    .map_err(|_| "Invalid memory envelope")?,
            )
            .map_err(|_| "Invalid memory envelope")?;
            if STANDARD.encode(&payload) != event.content
                || nip44::v2::encrypt_to_bytes_with_nonce(
                    &conversation,
                    text.as_bytes(),
                    payload[1..33]
                        .try_into()
                        .map_err(|_| "Invalid memory envelope")?,
                )
                .map_err(|_| "Invalid memory envelope")?
                    != payload
            {
                return Err("Invalid memory envelope".into());
            }
            let value = unique_json(&text)?;
            let name = value
                .get("slug")
                .and_then(Value::as_str)
                .ok_or("Invalid memory slug")?;
            if !slug(name) {
                return Err("Invalid memory slug".into());
            }
            if memory_address(&conversation, name)? != d[0][1] {
                return Err("Invalid memory address".into());
            }
            let body = if name == "core" {
                value.get("profile").filter(|v| v.is_string())
            } else {
                value.get("value").filter(|v| v.is_string() || v.is_null())
            }
            .ok_or("Invalid memory body")?;
            Ok((
                name.to_owned(),
                event.created_at,
                event.id.clone(),
                json!({"slug": name, "body": body, "eventId": event.id, "createdAt": event.created_at}),
            ))
        })();
        if expired() {
            lock().partial = true;
            break;
        }
        let mut decoder = lock();
        let MemoryDecoder {
            heads,
            decoded_bytes,
            partial,
            full,
            changed,
        } = &mut *decoder;
        match candidate {
            Ok((name, timestamp, id, entry)) => {
                let previous = heads.get(&name);
                if previous.is_none_or(|(time, previous_id, _)| {
                    timestamp > *time || (timestamp == *time && id < *previous_id)
                }) {
                    let added = serde_json::to_vec(&entry)
                        .map_err(|_| "Invalid memory listing")?
                        .len();
                    let removed = previous.map_or(0, |(_, _, old)| {
                        serde_json::to_vec(old).map_or(0, |bytes| bytes.len())
                    });
                    let total = decoded_bytes.saturating_add(added).saturating_sub(removed);
                    if total > MEMORY_DECODED_BYTES {
                        *partial = true;
                        *full = true;
                        break;
                    }
                    *decoded_bytes = total;
                    changed.insert(name.clone());
                    heads.insert(name, (timestamp, id, entry));
                }
            }
            Err(_) => *partial = true,
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn relay_agent_library(
    host: tauri::State<'_, IdentityHost>,
    state: tauri::State<'_, crate::app_agents::AppAgentHost>,
    community: String,
) -> Result<Value> {
    origin(&community)?;
    let viewer = host.with_key(|_, viewer| Ok(viewer.to_owned())).await?;
    let agents = state
        .agents()
        .map_err(|_| "Current Buzz library unavailable")?;
    tauri::async_runtime::spawn_blocking(move || read_agent_library(&agents, &community, &viewer))
        .await
        .map_err(|_| "Current Buzz library unavailable".to_owned())?
}

/// Public display metadata for the identities Agents saved, read through their
/// owner so both share one schema.
fn read_agent_library(agents: &AppAgents, community: &str, viewer: &str) -> Result<Value> {
    // Match the saved canonical wss address, including DNS's trailing-dot alias.
    let mut destination = origin(community)?;
    let host = destination
        .host_str()
        .ok_or("Invalid community")?
        .trim_end_matches('.')
        .to_owned();
    destination
        .set_host(Some(&host))
        .map_err(|_| "Invalid community")?;
    destination
        .set_scheme("wss")
        .map_err(|_| "Invalid community")?;
    let destination = destination.as_str().trim_end_matches('/');
    let rows = agents
        .list()
        .map_err(|_| "Current Buzz library unavailable")?;
    let mut identities = Vec::new();
    let mut keys = HashSet::new();
    for agent in rows.into_iter().filter(|agent| {
        !agent.deleted && !agent.joining && agent.owner == viewer && agent.relay == destination
    }) {
        if !key(&agent.pubkey) || agent.name.encode_utf16().count() > 256 {
            return Err("Current Buzz library unavailable".into());
        }
        let avatar = agent.picture.as_deref().and_then(|source| {
            let source = source.trim();
            let data_image = ["png", "jpeg", "webp", "gif"].iter().any(|format| {
                source
                    .strip_prefix(&format!("data:image/{format};base64,"))
                    .is_some_and(|encoded| {
                        let unpadded = encoded.trim_end_matches('=');
                        !unpadded.is_empty()
                            && unpadded
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
                    })
            });
            if source.len() <= 512 * 1024 && data_image {
                return Some(source.to_owned());
            }
            if source.len() > 2048 {
                return None;
            }
            let url = url::Url::parse(source).ok()?;
            if url.scheme() == "https" && url.username().is_empty() && url.password().is_none() {
                Some(url.to_string())
            } else {
                None
            }
        });
        // One identity may be configured in several communities.
        if !keys.insert(agent.pubkey.clone()) {
            continue;
        }
        let mut item = json!({"pubkey":agent.pubkey,"name":agent.name});
        if let Some(avatar) = avatar {
            item["avatar"] = json!(avatar);
        }
        identities.push(item);
    }
    Ok(json!({"definitions":[],"identities":identities}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_identity_library_contract() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/agent-identity-library.json"
        ))
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("identities.json");
        let agents = AppAgents::open(path.clone());
        assert_eq!(
            read_agent_library(&agents, "https://relay.example", &"d".repeat(64)).unwrap(),
            json!({"definitions": [], "identities": []})
        );
        for case in cases {
            let bytes = serde_json::to_vec(&case["rows"]).unwrap();
            std::fs::write(&path, &bytes).unwrap();
            let result = read_agent_library(&agents, "https://relay.example", &"d".repeat(64));
            if let Some(expected) = case.get("scopedExpected").or_else(|| case.get("expected")) {
                assert_eq!(&result.unwrap(), expected, "{}", case["name"]);
                assert_eq!(
                    &read_agent_library(&agents, "https://RELAY.example.:443/", &"d".repeat(64))
                        .unwrap(),
                    expected,
                    "canonical {}",
                    case["name"]
                );
            } else {
                assert!(result.is_err(), "{}", case["name"]);
            }
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }

    /// A memory page sends exactly the issued assertion to a community that
    /// requires NIP-FI, and nothing to one that does not.
    async fn memory(required: bool) {
        use crate::federated_identity::testing::{community, reply};
        let community = community(required).await;
        let server = community.serve(vec![reply("200 OK", "[]")]);
        let _ = memory_page(
            &community.host,
            &community.fi,
            community.origin.join("/query").unwrap(),
            json!({"kinds": [30078], "limit": 1}),
        )
        .await;
        community.assert_carried(&server.heads().await[0]);
    }
    #[tokio::test]
    async fn memory_page_attaches_for_required_discovery() {
        memory(true).await;
    }
    #[tokio::test]
    async fn memory_page_omits_for_ordinary_discovery() {
        memory(false).await;
    }

    fn fixture() -> ([u8; 32], String) {
        let secret = [1; 32];
        let secp = Secp256k1::signing_only();
        let pair = Keypair::from_secret_key(
            &secp,
            &secp256k1::SecretKey::from_byte_array(secret).unwrap(),
        );
        (secret, pair.x_only_public_key().0.to_string())
    }
    fn signed_event(
        secret: &[u8; 32],
        kind: u16,
        tags: Vec<Vec<String>>,
        content: String,
    ) -> AgentEvent {
        let pair = Keypair::from_secret_key(
            &Secp256k1::signing_only(),
            &secp256k1::SecretKey::from_byte_array(*secret).unwrap(),
        );
        let pubkey = pair.x_only_public_key().0.to_string();
        let created_at = 1_700_000_000;
        let bytes =
            serde_json::to_vec(&json!([0, pubkey, created_at, kind, tags, content])).unwrap();
        let id = hex_digest(&Sha256::digest(bytes));
        let pair = Keypair::from_secret_key(
            &Secp256k1::signing_only(),
            &secp256k1::SecretKey::from_byte_array(*secret).unwrap(),
        );
        let sig = Secp256k1::signing_only()
            .sign_schnorr_no_aux_rand(
                &Sha256::digest(
                    serde_json::to_vec(&json!([0, pubkey, created_at, kind, tags, content]))
                        .unwrap(),
                ),
                &pair,
            )
            .to_string();
        AgentEvent {
            id,
            pubkey,
            sig,
            created_at,
            kind,
            tags,
            content,
        }
    }

    #[test]
    fn exact_agent_envelopes_and_unique_memory_fields() {
        let (secret, viewer) = fixture();
        let event = signed_event(
            &secret,
            24200,
            vec![vec!["p".into(), viewer.clone()]],
            "cipher".into(),
        );
        assert!(verified(&event).is_ok());
        let mut forged = event.clone();
        forged.tags.push(vec!["p".into(), viewer.clone()]);
        assert!(verified(&forged).is_err());
        assert!(!exact(&forged, "p", &viewer));
        assert!(unique_json(r#"{"slug":"core","nested":{"a":1,"a":2}}"#).is_err());
        assert!(unique_json(r#"{"slug":"core","nested":{"a":1,"b":2}}"#).is_ok());
        assert!(!slug("mem/a//b"));
        assert!(slug("mem/a/b_2"));
    }
    #[test]
    fn snapshot_memory_events_round_trip_through_native_owner_reader() {
        let agent_key = buzz_agent_controller::Secret::generate().unwrap();
        let agent = agent_key.pubkey().to_owned();
        let owner_bytes = [2; 32];
        let owner = signed_event(&owner_bytes, 1, vec![], String::new()).pubkey;
        let events = [
            ("core", "private fixture core"),
            ("mem/one", "private fixture entry"),
        ]
        .into_iter()
        .map(|(slug, body)| {
            Some(
                agent_key
                    .memory_event(&owner, slug, Some(body), 1_700_000_001)
                    .unwrap(),
            )
        })
        .collect::<Vec<_>>();
        let listing =
            decode_memories_with_key(&owner_bytes, &owner, &owner, &agent, &events, || false)
                .unwrap();
        assert_eq!(listing["partial"], false);
        assert_eq!(listing["entries"][0]["body"], "private fixture core");
        assert_eq!(listing["entries"][1]["body"], "private fixture entry");
        assert!(listing.get("deleted").is_none());
        assert_ne!(agent, owner);
    }

    #[test]
    fn a_deleted_entry_reports_its_tombstone_so_a_recreation_can_follow_it() {
        let agent_key = buzz_agent_controller::Secret::generate().unwrap();
        let agent = agent_key.pubkey().to_owned();
        let owner_bytes = [2; 32];
        let owner = signed_event(&owner_bytes, 1, vec![], String::new()).pubkey;
        let event = |body, created_at| {
            Some(
                agent_key
                    .memory_event(&owner, "mem/one", body, created_at)
                    .unwrap(),
            )
        };
        let read = |events: &[Option<Value>]| {
            decode_memories_with_key(&owner_bytes, &owner, &owner, &agent, events, || false)
                .unwrap()
        };
        // An entry dated ahead of the clock, then the tombstone that follows it.
        let mut events = vec![
            event(Some("kept"), 4_000_000_000),
            event(None, 4_000_000_001),
        ];
        let listing = read(&events);
        assert_eq!(listing["entries"], json!([]));
        assert_eq!(
            listing["deleted"],
            json!([{"slug": "mem/one", "createdAt": 4_000_000_001u64}])
        );
        // A recreation dated after the reported tombstone is the entry again.
        let after = listing["deleted"][0]["createdAt"].as_u64().unwrap();
        events.push(event(Some("again"), after + 1));
        let listing = read(&events);
        assert_eq!(listing["entries"][0]["body"], "again");
        assert!(listing.get("deleted").is_none());
    }

    #[test]
    fn encrypted_memory_and_observer_fixtures() {
        let (viewer_secret, viewer) = fixture();
        let agent_secret = [2; 32];
        let agent_key = NostrSecretKey::from_slice(&agent_secret).unwrap();
        let agent = signed_event(&agent_secret, 1, vec![], String::new()).pubkey;
        let conversation =
            ConversationKey::derive(&agent_key, &NostrPublicKey::from_hex(&viewer).unwrap())
                .unwrap();
        let encrypt = |text: &str| {
            STANDARD.encode(
                nip44::v2::encrypt_to_bytes_with_nonce(&conversation, text.as_bytes(), [7; 32])
                    .unwrap(),
            )
        };
        let address = |name: &str| {
            let mut mac = Hmac::<Sha256>::new_from_slice(conversation.as_bytes()).unwrap();
            mac.update(b"agent-memory/v1/d-tag\0");
            mac.update(name.as_bytes());
            hex_digest(&mac.finalize().into_bytes())
        };
        let memory = signed_event(
            &agent_secret,
            30174,
            vec![
                vec!["d".into(), address("core")],
                vec!["p".into(), viewer.clone()],
            ],
            encrypt(r#"{"slug":"core","profile":"remember this"}"#),
        );
        assert_eq!(memory.pubkey, agent);
        let result = decode_memories_with_key(
            &viewer_secret,
            &viewer,
            &viewer,
            &agent,
            &[Some(json!(memory))],
            || false,
        )
        .unwrap();
        assert_eq!(result["entries"][0]["body"], "remember this");
        assert_eq!(result["partial"], false);
        // The low-level decoder must not admit unsupported versions, bad MACs,
        // or non-UTF-8 plaintext after switching to a batch-local key.
        let payload = STANDARD.decode(&memory.content).unwrap();
        let mut wrong_version = payload.clone();
        wrong_version[0] = 3;
        let mut bad_mac = payload;
        *bad_mac.last_mut().unwrap() ^= 1;
        let invalid_utf8 =
            nip44::v2::encrypt_to_bytes_with_nonce(&conversation, &[0xff], [7; 32]).unwrap();
        for content in [
            STANDARD.encode(wrong_version),
            STANDARD.encode(bad_mac),
            STANDARD.encode(invalid_utf8),
            "invalid base64".into(),
        ] {
            let invalid = signed_event(&agent_secret, 30174, memory.tags.clone(), content);
            let decoded = decode_memories_with_key(
                &viewer_secret,
                &viewer,
                &viewer,
                &agent,
                &[Some(json!(memory)), Some(json!(invalid))],
                || false,
            )
            .unwrap();
            assert_eq!(decoded["entries"].as_array().unwrap().len(), 1);
            assert_eq!(decoded["entries"][0]["body"], "remember this");
            assert_eq!(decoded["partial"], true);
        }
        let listing_wire = format!("[{},{{\"unknown\":\"\\ud800\"}}]", json!(memory));
        let wire = memory_wire_records(&listing_wire).unwrap();
        assert!(wire[1].is_none());
        let with_invalid =
            decode_memories_with_key(&viewer_secret, &viewer, &viewer, &agent, &wire, || false)
                .unwrap();
        assert_eq!(with_invalid["entries"][0]["body"], "remember this");
        assert_eq!(with_invalid["partial"], true);
        let reverse_wire = format!("[{{\"unknown\":1e400}},{}]", json!(memory));
        let reverse = decode_memories_with_key(
            &viewer_secret,
            &viewer,
            &viewer,
            &agent,
            &memory_wire_records(&reverse_wire).unwrap(),
            || false,
        )
        .unwrap();
        assert_eq!(reverse["entries"][0]["body"], "remember this");
        assert_eq!(reverse["partial"], true);
        for broken in [
            "{}",
            "[{},]",
            "[1,,2]",
            "[1]tail",
            "[1,2",
            "[1}]",
            "[{\"valid\":1} {\"valid\":2}]",
            "[1,abc]",
            "[1,{\"a\":1,}]",
            "[1,{'a':1}]",
            "[1,{\"a\":\"\\q\"}]",
            "[1,{\"a\":[1,]}]",
            "\u{000c}[]",
        ] {
            assert!(memory_wire_records(broken).is_err(), "{broken}");
        }
        let deep = format!(
            "[{},{{\"unknown\":{}}}]",
            json!(memory),
            "[".repeat(200) + "0" + &"]".repeat(200)
        );
        let deep_records = memory_wire_records(&deep).unwrap();
        assert!(deep_records[1].is_none());
        let deep_listing = decode_memories_with_key(
            &viewer_secret,
            &viewer,
            &viewer,
            &agent,
            &deep_records,
            || false,
        )
        .unwrap();
        assert_eq!(deep_listing["entries"][0]["body"], "remember this");
        assert_eq!(deep_listing["partial"], true);
        let hinted = signed_event(
            &agent_secret,
            30174,
            vec![
                vec!["d".into(), address("core"), "extra".into()],
                vec!["p".into(), viewer.clone(), "wss://relay.test".into()],
            ],
            encrypt(r#"{"slug":"core","profile":"hinted"}"#),
        );
        assert_eq!(
            decode_memories_with_key(
                &viewer_secret,
                &viewer,
                &viewer,
                &agent,
                &[Some(json!(hinted))],
                || false
            )
            .unwrap()["entries"][0]["body"],
            "hinted"
        );
        let tombstone = signed_event(
            &agent_secret,
            30174,
            vec![
                vec!["d".into(), address("mem/note")],
                vec!["p".into(), viewer.clone()],
            ],
            encrypt(r#"{"slug":"mem/note","value":null}"#),
        );
        let deleted = decode_memories_with_key(
            &viewer_secret,
            &viewer,
            &viewer,
            &agent,
            &[Some(json!(tombstone))],
            || false,
        )
        .unwrap();
        assert_eq!(deleted["entries"].as_array().unwrap().len(), 0);
        let bad_address = signed_event(
            &agent_secret,
            30174,
            vec![
                vec!["d".into(), address("mem/other")],
                vec!["p".into(), viewer.clone()],
            ],
            encrypt(r#"{"slug":"core","profile":"wrong address"}"#),
        );
        let partial = decode_memories_with_key(
            &viewer_secret,
            &viewer,
            &viewer,
            &agent,
            &[Some(json!(bad_address))],
            || false,
        )
        .unwrap();
        assert_eq!(partial["partial"], true);
        let mut tampered = memory.clone();
        let swapped = if &tampered.content[100..101] == "A" {
            "B"
        } else {
            "A"
        };
        tampered.content.replace_range(100..101, swapped);
        resign(&mut tampered, &agent_secret);
        let rejected = decode_memories_with_key(
            &viewer_secret,
            &viewer,
            &viewer,
            &agent,
            &[Some(json!(tampered))],
            || false,
        )
        .unwrap();
        assert_eq!(rejected["entries"].as_array().unwrap().len(), 0);
        assert_eq!(rejected["partial"], true);
        assert!(
            decode_memories_with_key(&viewer_secret, &agent, &viewer, &agent, &[], || false)
                .is_err()
        );

        let observer = signed_event(
            &agent_secret,
            24200,
            vec![
                vec!["p".into(), viewer.clone()],
                vec!["agent".into(), agent.clone()],
                vec!["frame".into(), "telemetry".into()],
            ],
            encrypt(r#"{"type":"status","message":"active"}"#),
        );
        // A historical fixture is deliberately stale; make a freshly signed envelope.
        let mut observer = observer;
        observer.created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        resign(&mut observer, &agent_secret);
        assert_eq!(
            decode_observer_with_key(&viewer_secret, &viewer, &observer).unwrap()["agent"],
            agent
        );
        let mut historical = observer.clone();
        historical.created_at -= 3600;
        resign(&mut historical, &agent_secret);
        assert!(decode_observer_with_key(&viewer_secret, &viewer, &historical).is_err());
        assert_eq!(
            decode_archive(&viewer_secret, &viewer, &historical, true).unwrap()["plaintext"],
            r#"{"type":"status","message":"active"}"#
        );
        assert!(decode_archive(&viewer_secret, &agent, &historical, true).is_err());
        historical.created_at -= 90 * 24 * 60 * 60;
        resign(&mut historical, &agent_secret);
        assert!(decode_archive(&viewer_secret, &viewer, &historical, true).is_err());
        observer.tags.push(vec!["p".into(), viewer.clone()]);
        resign(&mut observer, &agent_secret);
        assert!(decode_observer_with_key(&viewer_secret, &viewer, &observer).is_err());
        assert!(decode_archive(&viewer_secret, &viewer, &observer, true).is_err());
    }

    #[test]
    #[ignore = "local performance measurement; run with --ignored --nocapture"]
    fn measure_memory_batch_decode() {
        let (secret, viewer) = fixture();
        let agent_secret = [2; 32];
        let agent = signed_event(&agent_secret, 1, vec![], String::new()).pubkey;
        let conversation = ConversationKey::derive(
            &NostrSecretKey::from_slice(&agent_secret).unwrap(),
            &NostrPublicKey::from_hex(&viewer).unwrap(),
        )
        .unwrap();
        let events: Vec<_> = (0..256)
            .map(|index| {
                let name = format!("mem/note-{index}");
                let mut mac = Hmac::<Sha256>::new_from_slice(conversation.as_bytes()).unwrap();
                mac.update(b"agent-memory/v1/d-tag\0");
                mac.update(name.as_bytes());
                let content = json!({"slug": name, "value": "x".repeat(1024)}).to_string();
                let encrypted = STANDARD.encode(
                    nip44::v2::encrypt_to_bytes_with_nonce(
                        &conversation,
                        content.as_bytes(),
                        [7; 32],
                    )
                    .unwrap(),
                );
                Some(json!(signed_event(
                    &agent_secret,
                    30174,
                    vec![
                        vec!["d".into(), hex_digest(&mac.finalize().into_bytes())],
                        vec!["p".into(), viewer.clone()],
                    ],
                    encrypted
                )))
            })
            .collect();
        for _ in 0..2 {
            decode_memories_with_key(&secret, &viewer, &viewer, &agent, &events, || false).unwrap();
        }
        let started = std::time::Instant::now();
        for _ in 0..20 {
            let result =
                decode_memories_with_key(&secret, &viewer, &viewer, &agent, &events, || false)
                    .unwrap();
            assert_eq!(result["entries"].as_array().unwrap().len(), 256);
            assert_eq!(result["partial"], false);
            std::hint::black_box(result);
        }
        eprintln!(
            "memory batch: 256 x 1 KiB, 20 iterations: {:?}",
            started.elapsed()
        );
    }

    /// Pages `events` the way the relay answers `until`, `before_id` and
    /// `limit` (`created_at DESC, id ASC`), recording each cursor asked for.
    /// With `honor_before_id` false it acts like a relay that drops the
    /// cursor id and applies an inclusive `until` only.
    async fn paged_with(
        events: &[Value],
        asked: &std::sync::Mutex<Vec<Option<(u64, String)>>>,
        honor_before_id: bool,
        budget: MemoryBudget,
    ) -> (Vec<Option<Value>>, bool) {
        let mut events = events.to_vec();
        events.sort_by(|a, b| {
            b["created_at"]
                .as_u64()
                .cmp(&a["created_at"].as_u64())
                .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
        });
        let events = &events;
        read_memory_pages(
            budget,
            |cursor| {
                asked.lock().unwrap().push(cursor.clone());
                let page: Vec<_> = events
                    .iter()
                    .filter(|event| {
                        let time = event["created_at"].as_u64().unwrap();
                        let id = event["id"].as_str().unwrap();
                        cursor.as_ref().is_none_or(|(until, before_id)| {
                            time < *until
                                || (time == *until && (!honor_before_id || id > before_id.as_str()))
                        })
                    })
                    .take(MEMORY_PAGE)
                    .cloned()
                    .map(Some)
                    .collect();
                async move { Ok(MemoryPage::Records(page, 100)) }
            },
            |_| async { Ok(()) },
        )
        .await
        .unwrap()
    }

    /// A budget that only the event cap limits.
    fn roomy() -> MemoryBudget {
        MemoryBudget {
            requests: usize::MAX,
            raw_bytes: usize::MAX,
            ..MemoryBudget::new()
        }
    }

    async fn paged(
        events: &[Value],
        asked: &std::sync::Mutex<Vec<Option<(u64, String)>>>,
    ) -> (Vec<Option<Value>>, bool) {
        paged_with(events, asked, true, roomy()).await
    }

    /// `count` signed memory events with `body`-byte values, the last one
    /// `core`, newest first at two to a second, and the keys to read them.
    fn memory_events(count: u64, body: usize) -> ([u8; 32], String, String, Vec<Value>) {
        let (viewer_secret, viewer) = fixture();
        let agent_secret = [2; 32];
        let agent = signed_event(&agent_secret, 1, vec![], String::new()).pubkey;
        let conversation = ConversationKey::derive(
            &NostrSecretKey::from_slice(&agent_secret).unwrap(),
            &NostrPublicKey::from_hex(&viewer).unwrap(),
        )
        .unwrap();
        let events = (0..count)
            .map(|index| {
                let name = if index == count - 1 {
                    "core".to_owned()
                } else {
                    format!("mem/note-{index}")
                };
                let field = if name == "core" { "profile" } else { "value" };
                let content = json!({"slug": name, field: "x".repeat(body)}).to_string();
                let mut event = signed_event(
                    &agent_secret,
                    30174,
                    vec![
                        vec!["d".into(), memory_address(&conversation, &name).unwrap()],
                        vec!["p".into(), viewer.clone()],
                    ],
                    STANDARD.encode(
                        nip44::v2::encrypt_to_bytes_with_nonce(
                            &conversation,
                            content.as_bytes(),
                            [7; 32],
                        )
                        .unwrap(),
                    ),
                );
                event.created_at = 1_700_000_000 + (count - index) / 2;
                resign(&mut event, &agent_secret);
                json!(event)
            })
            .collect();
        (viewer_secret, viewer, agent, events)
    }

    #[test]
    fn memory_decode_stops_partial_at_its_byte_cap_or_deadline() {
        let records = |events: &[Value]| events.iter().cloned().map(Some).collect::<Vec<_>>();
        // 140 entries of 60 KiB decode to more than 8 MiB: the newest that
        // fit are kept, marked partial.
        let (secret, viewer, agent, events) = memory_events(140, 60 * 1024);
        let listing =
            decode_memories_with_key(&secret, &viewer, &viewer, &agent, &records(&events), || {
                false
            })
            .unwrap();
        let entries = listing["entries"].as_array().unwrap();
        assert_eq!(listing["partial"], true);
        assert!(entries.len() > 100 && entries.len() < 140);
        assert!(entries.iter().any(|entry| entry["slug"] == "mem/note-0"));
        assert!(!entries.iter().any(|entry| entry["slug"] == "core"));
        // Paging used up the time and the deadline passes during decoding:
        // the entries decoded before it are kept, marked partial.
        let (secret, viewer, agent, events) = memory_events(40, 64);
        let checks = std::cell::Cell::new(0);
        let listing =
            decode_memories_with_key(&secret, &viewer, &viewer, &agent, &records(&events), || {
                // Checked before each record and before keeping it.
                checks.set(checks.get() + 1);
                checks.get() > 20
            })
            .unwrap();
        assert_eq!(listing["partial"], true);
        assert_eq!(listing["entries"].as_array().unwrap().len(), 10);
    }

    /// Reads `events` a page at a time through `read_memories`, each page
    /// arriving at once and the page after the last never, and decodes each
    /// on a blocking thread as the native command does, sleeping `stall`
    /// after the first `decoded` events of the first page.
    async fn read_through(
        events: Vec<Value>,
        deadline: std::time::Duration,
        stall: Option<(usize, std::time::Duration)>,
    ) -> (Value, std::time::Duration) {
        let (secret, viewer, agent, _) = memory_events(1, 0);
        let started = tokio::time::Instant::now();
        let budget = MemoryBudget {
            deadline: Some(started + deadline),
            ..MemoryBudget::new()
        };
        let mut pages = events
            .chunks(MEMORY_PAGE)
            .map(<[Value]>::to_vec)
            .collect::<Vec<_>>();
        pages.reverse();
        let first = std::sync::atomic::AtomicBool::new(true);
        // The pending page would hang a read that ignored its deadline; this
        // bound fails it instead. The callers assert the real time bound.
        let read = read_memories(
            budget,
            |_| {
                let page = pages.pop();
                async move {
                    let Some(page) = page else {
                        return std::future::pending().await;
                    };
                    Ok(MemoryPage::Records(page.into_iter().map(Some).collect(), 1))
                }
            },
            |records, decoder, stop| {
                let (viewer, agent) = (viewer.clone(), agent.clone());
                let stall =
                    stall.filter(|_| first.swap(false, std::sync::atomic::Ordering::SeqCst));
                async move {
                    tokio::task::spawn_blocking(move || {
                        let expired = || std::time::Instant::now() >= stop;
                        let split = stall.map_or(records.len(), |(n, _)| n);
                        decode_memory_events(
                            &decoder,
                            &secret,
                            &viewer,
                            &viewer,
                            &agent,
                            &records[..split],
                            expired,
                        )?;
                        if let Some((_, pause)) = stall {
                            std::thread::sleep(pause);
                        }
                        decode_memory_events(
                            &decoder,
                            &secret,
                            &viewer,
                            &viewer,
                            &agent,
                            &records[split..],
                            expired,
                        )
                    })
                    .await
                    .unwrap()
                }
            },
            |_| {},
        );
        let listing = tokio::time::timeout(std::time::Duration::from_secs(5), read)
            .await
            .expect("memory read outlived its deadline")
            .unwrap();
        (listing, started.elapsed())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn memory_read_keeps_what_it_decoded_when_its_deadline_passes() {
        let ms = std::time::Duration::from_millis;
        // Two full pages arrive and decode, then the deadline passes while
        // the third is awaited. Their entries come back, partial, within the
        // grace.
        let (_, _, _, events) = memory_events(2 * MEMORY_PAGE as u64, 64);
        let (listing, took) = read_through(events, ms(300), None).await;
        assert_eq!(listing["partial"], true);
        assert_eq!(
            listing["entries"].as_array().unwrap().len(),
            2 * MEMORY_PAGE
        );
        assert!(took < ms(300) + MEMORY_DECODE_GRACE + ms(100), "{took:?}");
        // A decode still running when the grace ends is not waited on, and
        // the entries it already decoded are kept.
        let (_, _, _, events) = memory_events(16, 64);
        let (listing, took) = read_through(
            events,
            ms(100),
            Some((6, std::time::Duration::from_secs(3))),
        )
        .await;
        assert_eq!(listing["partial"], true);
        assert_eq!(listing["entries"].as_array().unwrap().len(), 6);
        assert!(took < ms(100) + MEMORY_DECODE_GRACE + ms(100), "{took:?}");
    }

    #[tokio::test]
    async fn memory_listing_pages_past_the_event_and_response_caps() {
        // 300 entries of 8 KiB: more than the old 256-event limit and more
        // than two pages, with two entries to each second so pages split
        // seconds.
        let (viewer_secret, viewer, agent, events) = memory_events(300, 8 * 1024);
        let asked = std::sync::Mutex::new(Vec::new());
        let (records, partial) = paged(&events, &asked).await;
        assert!(!partial);
        assert_eq!(records.len(), 300);
        assert_eq!(asked.lock().unwrap().len(), 3);
        // About 240 memories, as one owner has, take 2 requests.
        let asked = std::sync::Mutex::new(Vec::new());
        let (some, partial) = paged(&events[..240], &asked).await;
        assert!(!partial);
        assert_eq!(some.len(), 240);
        assert_eq!(asked.lock().unwrap().len(), 2);
        let listing =
            decode_memories_with_key(&viewer_secret, &viewer, &viewer, &agent, &records, || false)
                .unwrap();
        assert_eq!(listing["partial"], false);
        assert_eq!(listing["entries"].as_array().unwrap().len(), 300);
        // A read by address asks only for that entry's `d` tag, which the
        // relay matches against the stored event.
        let core = &events[299]["tags"][0][1];
        let addressed: Vec<_> = events
            .iter()
            .filter(|event| &event["tags"][0][1] == core)
            .cloned()
            .map(Some)
            .collect();
        let single =
            decode_memories_with_key(&viewer_secret, &viewer, &viewer, &agent, &addressed, || {
                false
            })
            .unwrap();
        assert_eq!(single["entries"][0]["slug"], "core");
        assert_eq!(single["entries"][0]["body"], "x".repeat(8 * 1024));
    }

    fn stub(index: u64, time: u64) -> Value {
        json!({"id": format!("{index:064x}"), "created_at": time})
    }

    #[tokio::test]
    async fn memory_listing_pages_through_entries_sharing_one_second() {
        let none = || std::sync::Mutex::new(Vec::new());
        // Exactly one page in one second, nothing older: the cursor page is
        // empty, so the listing is complete.
        let exact: Vec<_> = (0..MEMORY_PAGE as u64).map(|i| stub(i, 5)).collect();
        let asked = none();
        let (records, partial) = paged(&exact, &asked).await;
        assert!(!partial);
        assert_eq!(records.len(), MEMORY_PAGE);
        assert_eq!(
            *asked.lock().unwrap(),
            vec![None, Some((5, format!("{:064x}", MEMORY_PAGE - 1)))]
        );
        // More than a page in one second.
        let tied: Vec<_> = (0..MEMORY_PAGE as u64 * 2 + 3)
            .map(|i| stub(i, 5))
            .collect();
        let (records, partial) = paged(&tied, &none()).await;
        assert!(!partial);
        assert_eq!(records.len(), tied.len());
        // A tied run followed by older entries.
        let mixed: Vec<_> = (0..MEMORY_PAGE as u64 + 5)
            .map(|i| stub(i, 9))
            .chain((10_000..10_040).map(|i| stub(i, 20_000 - i)))
            .collect();
        let (records, partial) = paged(&mixed, &none()).await;
        assert!(!partial);
        assert_eq!(records.len(), mixed.len());
        let ids: std::collections::HashSet<_> = records
            .iter()
            .map(|r| r.as_ref().unwrap()["id"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(ids.len(), mixed.len());
    }

    #[tokio::test]
    async fn memory_listing_marks_a_stalled_or_capped_read_partial() {
        // A relay that ignores `before_id` repeats the tied page: the read
        // stops partial instead of looping.
        let tied: Vec<_> = (0..MEMORY_PAGE as u64 * 2).map(|i| stub(i, 5)).collect();
        let asked = std::sync::Mutex::new(Vec::new());
        let (records, partial) = paged_with(&tied, &asked, false, roomy()).await;
        assert!(partial);
        assert_eq!(records.len(), MEMORY_PAGE);
        assert_eq!(asked.lock().unwrap().len(), 2);
        let many: Vec<_> = (0..MEMORY_EVENTS as u64 + 40)
            .map(|index| stub(index, 1_000_000 - index))
            .collect();
        let (records, partial) = paged(&many, &std::sync::Mutex::new(Vec::new())).await;
        assert!(partial);
        assert_eq!(records.len(), MEMORY_EVENTS);
        // One past the cap, two to a second: the last page is short, and the
        // cap still applies.
        let over: Vec<_> = (0..MEMORY_EVENTS as u64 + 1)
            .map(|index| stub(index, 1_000_000 - index / 2))
            .collect();
        let (records, partial) = paged(&over, &std::sync::Mutex::new(Vec::new())).await;
        assert!(partial);
        assert_eq!(records.len(), MEMORY_EVENTS);
    }

    #[tokio::test]
    async fn memory_listing_stops_partial_at_its_request_and_byte_budgets() {
        let many: Vec<_> = (0..4 * MEMORY_PAGE as u64)
            .map(|i| stub(i, 10_000 - i))
            .collect();
        let asked = std::sync::Mutex::new(Vec::new());
        let budget = MemoryBudget {
            requests: 3,
            ..roomy()
        };
        let (records, partial) = paged_with(&many, &asked, true, budget).await;
        assert!(partial);
        assert_eq!(records.len(), 3 * MEMORY_PAGE);
        assert_eq!(asked.lock().unwrap().len(), 3);
        // Each stub page reports 100 bytes: the third page passes 250.
        let budget = MemoryBudget {
            raw_bytes: 250,
            ..roomy()
        };
        let (records, partial) = paged_with(&many, &asked, true, budget).await;
        assert!(partial);
        assert_eq!(records.len(), 2 * MEMORY_PAGE);
    }

    #[tokio::test(start_paused = true)]
    async fn memory_listing_keeps_its_pages_on_rate_limit_or_deadline() {
        let full = || {
            (0..MEMORY_PAGE as u64)
                .map(|i| Some(stub(i, 1_000 - i)))
                .collect::<Vec<_>>()
        };
        let mut calls = 0;
        let (records, partial) = read_memory_pages(
            roomy(),
            |_| {
                calls += 1;
                let answer = if calls == 1 {
                    MemoryPage::Records(full(), 1)
                } else {
                    MemoryPage::Limited
                };
                async move { Ok(answer) }
            },
            |_| async { Ok(()) },
        )
        .await
        .unwrap();
        assert!(partial);
        assert_eq!(records.len(), MEMORY_PAGE);
        // Pages of 4 seconds each: the third crosses the 9-second deadline
        // for the whole read.
        let mut calls = 0u64;
        let (records, partial) = read_memory_pages(
            MemoryBudget::new(),
            |_| {
                calls += 1;
                let page: Vec<_> = (0..MEMORY_PAGE as u64)
                    .map(|i| Some(stub(calls * 1_000 + i, 1_000_000 - calls * 1_000 - i)))
                    .collect();
                async move {
                    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                    Ok(MemoryPage::Records(page, 1))
                }
            },
            |_| async { Ok(()) },
        )
        .await
        .unwrap();
        assert!(partial);
        assert_eq!(records.len(), 2 * MEMORY_PAGE);
    }

    #[tokio::test(start_paused = true)]
    async fn streamed_memory_read_completes_past_the_old_deadline_with_pages_overlapping() {
        // 20 pages of 1 second each, then a short one: far past the 9-second
        // deadline a non-streamed read keeps, yet a streamed one completes.
        let mut calls = 0u64;
        let kept = std::sync::Mutex::new(Vec::new());
        let started = tokio::time::Instant::now();
        let (records, partial) = read_memory_pages(
            MemoryBudget::streamed(),
            |_| {
                calls += 1;
                let size = if calls <= 20 { MEMORY_PAGE as u64 } else { 3 };
                let page: Vec<_> = (0..size)
                    .map(|i| Some(stub(calls * 1_000 + i, 1_000_000 - calls * 1_000 - i)))
                    .collect();
                async move {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    Ok(MemoryPage::Records(page, 1))
                }
            },
            |records| {
                let first = records[0].as_ref().unwrap()["id"].clone();
                let kept = &kept;
                async move {
                    // Decoding takes as long as a fetch, and overlaps the next one.
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    kept.lock().unwrap().push(first);
                    Ok(())
                }
            },
        )
        .await
        .unwrap();
        assert!(!partial);
        assert_eq!(records.len(), 20 * MEMORY_PAGE + 3);
        // Pages were kept in the order they were read.
        let kept = kept.into_inner().unwrap();
        let expected: Vec<_> = (1..=21u64)
            .map(|n| json!(format!("{:064x}", n * 1_000)))
            .collect();
        assert_eq!(kept, expected);
        // 21 fetches overlapped with 21 decodes: about 22 seconds, not 42.
        assert!(
            started.elapsed() < std::time::Duration::from_secs(23),
            "{:?}",
            started.elapsed()
        );
        // A page that stalls still ends the read, partial, after its own wait.
        let (records, partial) = read_memory_pages(
            MemoryBudget::streamed(),
            |_| async {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                Ok(MemoryPage::Records(Vec::new(), 1))
            },
            |_| async { Ok(()) },
        )
        .await
        .unwrap();
        assert!(partial);
        assert!(records.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ending_a_memory_read_stops_its_blocking_decode_and_frees_the_identity() {
        let host = IdentityHost::fixture();
        let (_, viewer, agent, events) = memory_events(MEMORY_EVENTS as u64, 64);
        let decoder = MemoryDecoding::default();
        let ended = ReadEnd::default();
        let far = std::time::Instant::now() + std::time::Duration::from_secs(60);
        let (worker, kept, flag) = (host.clone(), decoder.clone(), ended.flag());
        let records = events.into_iter().map(Some).collect();
        let decoding = tokio::spawn(async move {
            decode_page(&worker, &viewer, &agent, records, kept, far, flag).await
        });
        // Wait until the blocking worker is decoding, then cancel the read.
        while decoder.lock().unwrap().heads.is_empty() {
            tokio::task::yield_now().await;
        }
        drop(ended);
        decoding.abort();
        let started = std::time::Instant::now();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            host.with_key(|_, _| Ok(())),
        )
        .await
        .expect("the identity is released")
        .unwrap();
        let decoder = decoder.lock().unwrap();
        assert!(decoder.partial);
        assert!(
            decoder.heads.len() < MEMORY_EVENTS,
            "{}",
            decoder.heads.len()
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn streamed_memory_read_reports_each_pages_heads_as_they_decode() {
        let (secret, viewer, agent, events) = memory_events(2 * MEMORY_PAGE as u64 + 8, 64);
        let mut pages = events
            .chunks(MEMORY_PAGE)
            .map(<[Value]>::to_vec)
            .collect::<Vec<_>>();
        pages.reverse();
        let deltas = std::sync::Mutex::new(Vec::new());
        let listing = read_memories(
            MemoryBudget::streamed(),
            |_| {
                let page = pages.pop().unwrap_or_default();
                async move { Ok(MemoryPage::Records(page.into_iter().map(Some).collect(), 1)) }
            },
            |records, decoder, stop| {
                let (viewer, agent) = (viewer.clone(), agent.clone());
                async move {
                    tokio::task::spawn_blocking(move || {
                        decode_memory_events(
                            &decoder,
                            &secret,
                            &viewer,
                            &viewer,
                            &agent,
                            &records,
                            || std::time::Instant::now() >= stop,
                        )
                    })
                    .await
                    .unwrap()
                }
            },
            |delta| deltas.lock().unwrap().push(delta),
        )
        .await
        .unwrap();
        let deltas = deltas.into_inner().unwrap();
        let sizes: Vec<_> = deltas
            .iter()
            .map(|delta| delta["entries"].as_array().unwrap().len())
            .collect();
        assert_eq!(sizes, [MEMORY_PAGE, MEMORY_PAGE, 8]);
        assert_eq!(listing["partial"], false);
        let mut streamed: Vec<_> = deltas
            .iter()
            .flat_map(|delta| delta["entries"].as_array().unwrap().clone())
            .collect();
        streamed.sort_by(|a, b| a["slug"].as_str().cmp(&b["slug"].as_str()));
        assert_eq!(&streamed, listing["entries"].as_array().unwrap());
    }

    fn resign(event: &mut AgentEvent, secret: &[u8; 32]) {
        let bytes = serde_json::to_vec(&json!([
            0,
            event.pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content
        ]))
        .unwrap();
        let digest = Sha256::digest(bytes);
        event.id = hex_digest(&digest);
        let pair = Keypair::from_secret_key(
            &Secp256k1::signing_only(),
            &secp256k1::SecretKey::from_byte_array(*secret).unwrap(),
        );
        event.sig = Secp256k1::signing_only()
            .sign_schnorr_no_aux_rand(&digest, &pair)
            .to_string();
    }

    #[test]
    fn proof_domains_are_not_retargetable() {
        let (secret, viewer) = fixture();
        let auth = signature(&secret, &format!("nostr:agent-auth:{viewer}:")).unwrap();
        let scoped = signature(
            &secret,
            &format!("nostr:agent-community:{viewer}:wss://relay.test"),
        )
        .unwrap();
        assert_ne!(auth, scoped);
        assert_eq!(relay("https://relay.test").unwrap(), "wss://relay.test");
        assert!(relay("https://relay.test/path").is_err());
    }
}
