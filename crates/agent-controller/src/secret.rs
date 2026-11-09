use crate::Result;
use bech32::{primitives::decode::CheckedHrpstring, Bech32};
use secp256k1::{PublicKey, Secp256k1, SecretKey};
use zeroize::Zeroizing;

/// NIP-AR artifact revisions.
const ARTIFACT_KIND: u16 = 45010;

/// NIP-44 v2: 65,535 bytes pad to 65,536 with a two-byte prefix;
/// base64(1 version + 32 nonce + 2 length + 65,536 padded + 32 MAC)
/// is exactly 87,472 bytes, the native reader cap. At 65,536 the prefix grows
/// to six bytes and the result exceeds that cap. Count JSON escaping and UTF-8.
pub fn validate_snapshot_memory_envelope(slug: &str, body: &str) -> Result<()> {
    crate::config::visible_agent_text(body, true)?;
    let plaintext = if slug == "core" {
        serde_json::json!({"slug":slug,"profile":body})
    } else {
        serde_json::json!({"slug":slug,"value":body})
    };
    if plaintext.to_string().len() > 65_535 {
        return Err("Snapshot memory envelope exceeds the readable limit".into());
    }
    Ok(())
}

/// No Debug/Serialize: secret bytes never belong in a command result or log.
pub struct Secret {
    bytes: Zeroizing<[u8; 32]>,
    pubkey: String,
}
impl Secret {
    pub fn generate() -> Result<Self> {
        let mut bytes = Zeroizing::new([0; 32]);
        loop {
            getrandom::fill(bytes.as_mut()).map_err(|_| "Could not generate agent identity")?;
            if let Ok(mut key) = SecretKey::from_byte_array(*bytes) {
                let pubkey = PublicKey::from_secret_key(&Secp256k1::signing_only(), &key)
                    .x_only_public_key()
                    .0
                    .to_string();
                key.non_secure_erase();
                return Ok(Self { bytes, pubkey });
            }
        }
    }
    /// Merge only after verifying the exact agent's current kind-0 event.
    pub(crate) fn profile(
        &self,
        name: &str,
        picture: Option<&str>,
        update_name: bool,
        about: Option<&str>,
        auth: &str,
        existing: &[serde_json::Value],
    ) -> Result<serde_json::Value> {
        use serde_json::json;
        let existing = crate::profile::current(existing, &self.pubkey)?;
        let (mut content, mut tags, previous) = match existing {
            Some(profile) => (profile.content, profile.tags, Some(profile.created_at)),
            None => (
                serde_json::from_value(json!({"name": name, "display_name": name, "bot": true}))
                    .map_err(|_| "Could not initialize profile")?,
                vec![],
                None,
            ),
        };
        if update_name {
            content.insert("name".into(), json!(name));
            content.insert("display_name".into(), json!(name));
        }
        if let Some(about) = about {
            content.insert("about".into(), json!(about));
        }
        if let Some(picture) = picture {
            if picture.is_empty() {
                content.remove("picture");
            } else {
                content.insert("picture".into(), json!(picture));
            }
        }
        let auth: Vec<String> =
            serde_json::from_str(auth).map_err(|_| "Invalid owner authorization")?;
        tags.retain(|tag| tag.first().map(String::as_str) != Some("auth"));
        tags.push(auth);
        self.sign_event_after(0, crate::profile::bounded_content(content)?, tags, previous)
    }
    pub(crate) fn profile_auth(&self, url: &str, body: &[u8]) -> Result<serde_json::Value> {
        use sha2::{Digest, Sha256};
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).map_err(|_| "Could not authorize profile request")?;
        self.sign_event(
            27235,
            String::new(),
            vec![
                vec!["u".into(), url.into()],
                vec!["method".into(), "POST".into()],
                vec!["payload".into(), format!("{:x}", Sha256::digest(body))],
                vec![
                    "nonce".into(),
                    nonce.iter().map(|b| format!("{b:02x}")).collect(),
                ],
            ],
        )
    }
    /// A plain signed event; callers bound the kind and size. A channel event
    /// (one with an `h` tag) gets the `ms` tag the app's own outbox adds, read
    /// from the same clock as `created_at`, so the timeline orders it by
    /// millisecond instead of placing it at the start of its second. An
    /// artifact revision (45010) is state, not a timeline entry, and its
    /// deletion envelope allows no other tags, so it gets none.
    pub(crate) fn signed(
        &self,
        kind: u16,
        content: String,
        mut tags: Vec<Vec<String>>,
    ) -> Result<serde_json::Value> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "System clock is unavailable")?;
        tags.retain(|tag| tag.first().map(String::as_str) != Some("ms"));
        if kind != ARTIFACT_KIND
            && tags
                .iter()
                .any(|tag| tag.first().map(String::as_str) == Some("h"))
        {
            tags.push(vec!["ms".into(), now.subsec_millis().to_string()]);
        }
        self.sign_event_at(kind, content, tags, now.as_secs())
    }
    fn sign_event(
        &self,
        kind: u16,
        content: String,
        tags: Vec<Vec<String>>,
    ) -> Result<serde_json::Value> {
        self.sign_event_after(kind, content, tags, None)
    }
    pub(crate) fn sign_event_after(
        &self,
        kind: u16,
        content: String,
        tags: Vec<Vec<String>>,
        previous: Option<u64>,
    ) -> Result<serde_json::Value> {
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "System clock is unavailable")?
            .as_secs();
        // NIP-01 ties choose the lower event ID. A replacement must be newer.
        let created_at = previous.map_or(created_at, |at| created_at.max(at.saturating_add(1)));
        self.sign_event_at(kind, content, tags, created_at)
    }
    pub(crate) fn sign_event_at(
        &self,
        kind: u16,
        content: String,
        tags: Vec<Vec<String>>,
        created_at: u64,
    ) -> Result<serde_json::Value> {
        use secp256k1::Keypair;
        use serde_json::json;
        use sha2::{Digest, Sha256};
        let serialized =
            serde_json::to_vec(&json!([0, self.pubkey, created_at, kind, tags, content]))
                .map_err(|_| "Could not encode agent event")?;
        let hash = Sha256::digest(serialized);
        let mut secret =
            SecretKey::from_byte_array(*self.bytes).map_err(|_| "Invalid agent key")?;
        let mut pair = Keypair::from_secret_key(&Secp256k1::signing_only(), &secret);
        let signature = Secp256k1::signing_only()
            .sign_schnorr_no_aux_rand(&hash, &pair)
            .to_string();
        secret.non_secure_erase();
        pair.non_secure_erase();
        Ok(
            json!({"id": format!("{hash:x}"), "pubkey": self.pubkey, "created_at": created_at,
            "kind": kind, "tags": tags, "content": content, "sig": signature}),
        )
    }

    /// A single NIP-AE owner-addressed memory event; without a body, the
    /// tombstone that deletes a memory entry. Never return key material.
    pub fn memory_event(
        &self,
        owner: &str,
        slug: &str,
        body: Option<&str>,
        created_at: u64,
    ) -> Result<serde_json::Value> {
        use nostr::nips::nip44::v2;
        if !crate::config::canonical_key(owner)
            || !memory_slug(slug)
            || body.is_some_and(|body| body.len() > 64 * 1024)
        {
            return Err("Invalid snapshot memory entry".into());
        }
        let conversation = self
            .conversation(owner)
            .map_err(|_| "Invalid memory owner")?;
        let address = memory_address(&conversation, slug)?;
        let plaintext = match body {
            // NIP-AE defines no tombstone for core.
            None if slug == "core" => return Err("core cannot be deleted".into()),
            None => serde_json::json!({"slug":slug,"value":null}),
            Some(body) => {
                validate_snapshot_memory_envelope(slug, body)?;
                if slug == "core" {
                    serde_json::json!({"slug":slug,"profile":body})
                } else {
                    serde_json::json!({"slug":slug,"value":body})
                }
            }
        };
        let mut nonce = [0; 32];
        getrandom::fill(&mut nonce).map_err(|_| "Could not encrypt snapshot memory")?;
        let encrypted = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            v2::encrypt_to_bytes_with_nonce(&conversation, plaintext.to_string().as_bytes(), nonce)
                .map_err(|_| "Could not encrypt snapshot memory")?,
        );
        self.sign_event_at(
            30174,
            encrypted,
            vec![vec!["d".into(), address], vec!["p".into(), owner.into()]],
            created_at,
        )
    }

    /// The NIP-AE `d` tag of memory entry `slug` addressed to `peer`.
    pub fn memory_d_tag(&self, peer: &str, slug: &str) -> Result<String> {
        if !memory_slug(slug) {
            return Err("Invalid memory slug".into());
        }
        memory_address(&self.conversation(peer)?, slug)
    }
    /// NIP-44 v2 encryption from this key to `peer`.
    pub fn nip44_encrypt(&self, peer: &str, plaintext: &str) -> Result<String> {
        use nostr::nips::nip44::v2;
        let conversation = self.conversation(peer)?;
        let mut nonce = [0; 32];
        getrandom::fill(&mut nonce).map_err(|_| "Could not encrypt")?;
        let payload = v2::encrypt_to_bytes_with_nonce(&conversation, plaintext.as_bytes(), nonce)
            .map_err(|_| "Could not encrypt")?;
        Ok(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            payload,
        ))
    }
    /// NIP-44 v2 decryption of a payload `peer` encrypted to this key.
    pub fn nip44_decrypt(&self, peer: &str, payload: &str) -> Result<Zeroizing<String>> {
        use nostr::nips::nip44::v2;
        let conversation = self.conversation(peer)?;
        let payload = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, payload)
            .map_err(|_| "Invalid encrypted payload")?;
        let plaintext = Zeroizing::new(
            v2::decrypt_to_bytes(&conversation, &payload)
                .map_err(|_| "Invalid encrypted payload")?,
        );
        String::from_utf8(plaintext.to_vec())
            .map(Zeroizing::new)
            .map_err(|_| "Invalid encrypted payload".into())
    }
    fn conversation(&self, peer: &str) -> Result<nostr::nips::nip44::v2::ConversationKey> {
        use nostr::key::{PublicKey as NostrPublicKey, SecretKey as NostrSecretKey};
        let private =
            NostrSecretKey::from_slice(self.bytes.as_ref()).map_err(|_| "Invalid agent key")?;
        let public = NostrPublicKey::from_hex(peer).map_err(|_| "Invalid peer public key")?;
        nostr::nips::nip44::v2::ConversationKey::derive(&private, &public)
            .map_err(|_| "Invalid peer public key".into())
    }

    pub fn parse(text: &str, expected: &str) -> Result<Self> {
        let mut bytes = Zeroizing::new([0; 32]);
        if text.len() == 64 && text.bytes().all(|c| c.is_ascii_hexdigit()) {
            for (i, pair) in text.as_bytes().as_chunks::<2>().0.iter().enumerate() {
                let digit = |c: u8| {
                    if c <= b'9' {
                        c - b'0'
                    } else {
                        c.to_ascii_lowercase() - b'a' + 10
                    }
                };
                bytes[i] = digit(pair[0]) * 16 + digit(pair[1]);
            }
        } else {
            if text.len() != 63 || !text.starts_with("nsec1") {
                return Err("Agent key is malformed".into());
            }
            let checked =
                CheckedHrpstring::new::<Bech32>(text).map_err(|_| "Agent key is malformed")?;
            let mut values = checked.byte_iter();
            for b in bytes.iter_mut() {
                *b = values.next().ok_or("Agent key is malformed")?;
            }
            if values.next().is_some() {
                return Err("Agent key is malformed".into());
            }
        }
        Self::checked(bytes, expected)
    }
    /// The key `bytes` hold, which must be `expected`'s.
    pub fn from_bytes(bytes: &[u8; 32], expected: &str) -> Result<Self> {
        Self::checked(Zeroizing::new(*bytes), expected)
    }
    fn checked(bytes: Zeroizing<[u8; 32]>, expected: &str) -> Result<Self> {
        let mut key = SecretKey::from_byte_array(*bytes).map_err(|_| "Agent key is malformed")?;
        let pubkey = PublicKey::from_secret_key(&Secp256k1::signing_only(), &key)
            .x_only_public_key()
            .0
            .to_string();
        key.non_secure_erase();
        if pubkey != expected {
            return Err("Agent key does not match the selected identity".into());
        }
        Ok(Self { bytes, pubkey })
    }
    pub fn pubkey(&self) -> &str {
        &self.pubkey
    }
    pub fn hex(&self) -> Zeroizing<String> {
        use std::fmt::Write;
        let mut output = Zeroizing::new(String::with_capacity(64));
        for byte in self.bytes.iter() {
            write!(&mut *output, "{byte:02x}").expect("string formatting");
        }
        output
    }
}
/// Native OS adapter; tests inject isolated memory credentials. No silent fallback
/// to plaintext private-key files and no overwrite of existing or legacy entries.
pub trait Credentials: Send + Sync {
    /// A deliberate Start/Retry may reopen a previously refused unlock. Restore
    /// and observation must never turn denial into a series of automatic prompts.
    fn retry(&self) {}
    /// Read only this selected source; absence/denial must not search another service.
    fn read_legacy(&self, source: crate::LegacySource, pubkey: &str) -> Result<Secret>;
    fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>>;
    fn add(&self, id: &str, key: &Secret) -> Result<()>;
    /// Remove only this app's exact saved key. Absence is successful for retry.
    fn delete(&self, id: &str, pubkey: &str) -> Result<()>;
}

/// NIP-AE's slug grammar: `core`, or `mem/` and lowercase path segments.
fn memory_slug(slug: &str) -> bool {
    slug == "core"
        || (slug.starts_with("mem/")
            && slug.len() <= 255
            && slug[4..].split('/').all(|part| {
                !part.is_empty()
                    && part.len() <= 64
                    && part.bytes().enumerate().all(|(i, byte)| {
                        if i == 0 {
                            byte.is_ascii_lowercase() || byte.is_ascii_digit()
                        } else {
                            byte.is_ascii_lowercase()
                                || byte.is_ascii_digit()
                                || byte == b'_'
                                || byte == b'-'
                        }
                    })
            }))
}
/// NIP-AE addressing: HMAC-SHA256 of the slug under the conversation key.
fn memory_address(
    conversation: &nostr::nips::nip44::v2::ConversationKey,
    slug: &str,
) -> Result<String> {
    use hmac::{Hmac, Mac};
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(conversation.as_bytes())
        .map_err(|_| "Invalid memory address")?;
    mac.update(b"agent-memory/v1/d-tag\0");
    mac.update(slug.as_bytes());
    Ok(format!("{:x}", mac.finalize().into_bytes()))
}

/// V1 starts only unrestricted, verified NIP-OA credentials. Conditional grants
/// remain saved but need event-aware readiness rather than a misleading Ready.
pub(crate) fn validate_attestation(raw: &str, agent: &str) -> Result<()> {
    use secp256k1::{schnorr::Signature, XOnlyPublicKey};
    use sha2::{Digest, Sha256};
    if raw.len() > 4096 {
        return Err("Saved owner attestation is too large".into());
    }
    let tag: Vec<String> =
        serde_json::from_str(raw).map_err(|_| "Saved owner attestation is malformed")?;
    if tag.len() != 4
        || tag[0] != "auth"
        || tag[1] == agent
        || !crate::config::canonical_key(&tag[1])
        || tag[3].len() != 128
        || !tag[3]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Saved owner attestation is malformed".into());
    }
    let owner: XOnlyPublicKey = tag[1].parse().map_err(|_| "Invalid attestation owner")?;
    let signature: Signature = tag[3]
        .parse()
        .map_err(|_| "Invalid owner attestation signature")?;
    let digest = Sha256::digest(format!("nostr:agent-auth:{agent}:{}", tag[2]));
    Secp256k1::verification_only()
        .verify_schnorr(&signature, &digest, &owner)
        .map_err(|_| "Owner attestation does not authorize this agent key")?;
    if !tag[2].is_empty() {
        return Err("Conditional owner attestations need event-aware readiness; this controller cannot start them yet".into());
    }
    Ok(())
}
#[cfg(test)]
pub(crate) fn test_attestation(agent: &str) -> String {
    use secp256k1::Keypair;
    use sha2::{Digest, Sha256};
    let secp = Secp256k1::new();
    let mut bytes = [0; 32];
    bytes[31] = 2;
    let pair = Keypair::from_secret_key(&secp, &SecretKey::from_byte_array(bytes).unwrap());
    let digest = Sha256::digest(format!("nostr:agent-auth:{agent}:"));
    let sig = secp.sign_schnorr_no_aux_rand(&digest, &pair);
    serde_json::to_string(&[
        "auth",
        &pair.x_only_public_key().0.to_string(),
        "",
        &sig.to_string(),
    ])
    .unwrap()
}

#[cfg(test)]
mod memory_tests {
    use super::*;
    use base64::Engine;
    use hmac::{Hmac, Mac};
    use nostr::{
        key::{PublicKey as NostrPublicKey, SecretKey as NostrSecretKey},
        nips::nip44::v2::{self, ConversationKey},
    };
    use sha2::Sha256;
    #[test]
    fn owner_can_decrypt_new_agent_memory_without_exposing_a_key() {
        let agent = Secret::generate().unwrap();
        let owner = Secret::generate().unwrap();
        let owner_key = NostrSecretKey::from_slice(owner.bytes.as_ref()).unwrap();
        let agent_key = NostrPublicKey::from_hex(agent.pubkey()).unwrap();
        let conversation = ConversationKey::derive(&owner_key, &agent_key).unwrap();
        for (slug, body, field) in [
            ("core", "remember café", "profile"),
            ("mem/one", "value", "value"),
        ] {
            let event = agent
                .memory_event(owner.pubkey(), slug, Some(body), 100)
                .unwrap();
            assert_eq!(event["kind"], 30174);
            assert_eq!(event["pubkey"], agent.pubkey());
            assert_eq!(event["tags"][1], serde_json::json!(["p", owner.pubkey()]));
            let mut mac = Hmac::<Sha256>::new_from_slice(conversation.as_bytes()).unwrap();
            mac.update(b"agent-memory/v1/d-tag\0");
            mac.update(slug.as_bytes());
            assert_eq!(
                event["tags"][0],
                serde_json::json!(["d", format!("{:x}", mac.finalize().into_bytes())])
            );
            let ciphertext = Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                event["content"].as_str().unwrap(),
            )
            .unwrap();
            let decoded: serde_json::Value =
                serde_json::from_slice(&v2::decrypt_to_bytes(&conversation, &ciphertext).unwrap())
                    .unwrap();
            assert_eq!(decoded[field], body);
            assert_eq!(decoded["slug"], slug);
            assert!(!event.to_string().contains(body));
            assert!(!event.to_string().contains("nsec1"));
        }
        let tombstone = agent
            .memory_event(owner.pubkey(), "mem/one", None, 101)
            .unwrap();
        let ciphertext = Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            tombstone["content"].as_str().unwrap(),
        )
        .unwrap();
        let decoded: serde_json::Value =
            serde_json::from_slice(&v2::decrypt_to_bytes(&conversation, &ciphertext).unwrap())
                .unwrap();
        assert_eq!(decoded, serde_json::json!({"slug":"mem/one","value":null}));
    }
    #[test]
    fn invalid_memory_never_builds_an_event() {
        let agent = Secret::generate().unwrap();
        let owner = Secret::generate().unwrap();
        for slug in ["mem/", "mem/../x", "mem/UPPER", "other"] {
            assert!(agent
                .memory_event(owner.pubkey(), slug, Some("text"), 100)
                .is_err());
        }
        assert!(agent
            .memory_event(owner.pubkey(), "core", Some(&"x".repeat(65537)), 100)
            .is_err());
        assert!(agent
            .memory_event(owner.pubkey(), "core", None, 100)
            .is_err());
    }
}

#[cfg(test)]
mod snapshot_memory_visibility_tests {
    use super::validate_snapshot_memory_envelope;

    #[test]
    fn rejects_hidden_context_and_accepts_multilingual_word_final_joiners() {
        for hidden in [
            "before\u{202e}after",
            "before\u{200b}after",
            "before\u{e0061}after",
        ] {
            assert!(validate_snapshot_memory_envelope("core", hidden).is_err());
        }
        for body in ["അവന്‍", "“അവന്‍” അവന്‍।", "അവന്‍ വന്നു\r\nفارسی‌زبان 👩‍💻"]
        {
            assert!(validate_snapshot_memory_envelope("core", body).is_ok());
        }
    }
}
