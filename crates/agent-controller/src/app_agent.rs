//! Identities for agents the app runs through a plugin (Agents). They are not
//! harness agents: there is no process, harness setting or controller record.
//! Native keeps each key and its owner attestation and signs only bounded kinds,
//! bounded requests to its community, and its memory.
//! The saved identities are the agent list: each row is one agent in one
//! community, and names its type and name. An agent in several communities has
//! a row in each, sharing its key, owner attestation, type and name.
use crate::config::{agent_id, canonical_key, canonical_relay};
use crate::secret::validate_attestation;
use crate::{Credentials, ProtectionBinding, ProtectionDefaults, Result, Secret};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// What a plugin agent may publish: a deletion (5), a reaction (7), a message
/// (9), a channel member change (9000, 9001), edit (9002), creation (9007),
/// deletion (9008), join (9021) or leave (9022), typing (20002), an edit of its
/// own message (40003), a shared note (30023), a channel canvas (40100), a
/// request to open a DM (41010), a repository announcement (30617) or an
/// artifact revision (45010). The relay decides which channel changes and
/// artifact edits it may make. Its profile (0) is the app's, and
/// its memory (30174) is written by `memory`.
const KINDS: [u16; 17] = [
    5, 7, 9, 9000, 9001, 9002, 9007, 9008, 9021, 9022, 20002, 30023, 30617, 40003, 40100, 41010,
    45010,
];

/// Content of a live channel Canvas (40100), in UTF-8 bytes. Mirrors
/// `LIVE_CANVAS_BYTES` in `canvas-limits.ts`.
pub const LIVE_CANVAS_BYTES: usize = 256 * 1024;
/// The largest complete signed Canvas event: the relay's 512 KiB frame less
/// the `["EVENT",…]` wrapper. Mirrors `CANVAS_MAX_EVENT_BYTES`.
pub const CANVAS_MAX_EVENT_BYTES: usize = 512 * 1024 - 16;

/// Whether an event of `kind` with `content` and `tags` is within the bounds
/// an agent's or a paired tool's events are signed under: Canvas content up to [`LIVE_CANVAS_BYTES`], other
/// content up to 64 KiB, and at most 256 tags of 4 KiB.
pub fn bounded(kind: u16, content: &str, tags: &[Vec<String>]) -> Result<()> {
    let content_limit = if kind == 40100 {
        LIVE_CANVAS_BYTES
    } else {
        64 * 1024
    };
    if content.len() > content_limit
        || tags.len() > 256
        || tags
            .iter()
            .any(|tag| tag.is_empty() || tag.iter().map(String::len).sum::<usize>() > 4096)
    {
        return Err("Event is too large".into());
    }
    Ok(())
}

/// Escaping can carry Canvas content within its limit past the relay's
/// frame, so check the complete event once every tag is present.
pub fn framed(kind: u16, event: serde_json::Value) -> Result<serde_json::Value> {
    if kind == 40100
        && serde_json::to_vec(&event)
            .map_err(|_| "Invalid agent event")?
            .len()
            > CANVAS_MAX_EVENT_BYTES
    {
        return Err("Event is too large".into());
    }
    Ok(event)
}

/// One saved identity. The key itself stays in the OS credential store.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppAgent {
    pub pubkey: String,
    /// Canonical `wss://` origin of the community this row is the agent in.
    pub relay: String,
    pub owner: String,
    /// The owner's NIP-OA `auth` tag as a JSON array string.
    pub auth: String,
    /// The agent type's key, `pluginId/typeId`, set at create and changed by
    /// `set_type`. Rows saved before it was recorded read as an unavailable
    /// type with no name.
    #[serde(rename = "type", default)]
    pub agent_type: String,
    #[serde(default)]
    pub name: String,
    /// Public profile metadata, published as kind-0 picture and about.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    /// The last profile this row's community accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<Published>,
    /// Its key is gone from this community. The row stays until its community
    /// confirms it left its channels and was archived, which the owner signs,
    /// not the agent.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
    /// Its Delete, or its leaving this community, started and has not
    /// finished. It keeps its key, so it cannot be imported again, and no copy
    /// of the app runs it in this community.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleting: bool,
    /// The `wss://` origin of the agent's home community, the first it was
    /// in, on a row `join` added elsewhere; absent, this row's community is its
    /// home.
    /// Its home membership keeps the state saved under its bare pubkey, so
    /// every copy of the app must agree on it whichever rows remain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
    /// `join` saved it and has not yet saved its key: no copy of the app
    /// runs it, and it does not count as a community the agent stays in. One
    /// a crash left is taken back by adding the agent there again, or goes
    /// with its Delete.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub joining: bool,
    /// The installed plugin and policy required before this identity can act.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protection: Option<ProtectionBinding>,
    /// Device-wide monotonic generation for policy CAS and isolated runtime state.
    #[serde(default, skip_serializing_if = "zero_revision")]
    pub protection_revision: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Published {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    pub created_at: u64,
}
impl AppAgent {
    /// Whether it is this agent in the community at `relay`, with its key there.
    fn live(&self, pubkey: &str, relay: &str) -> bool {
        self.pubkey == pubkey && self.relay == relay && !self.deleted && !self.joining
    }
    fn credential_id(&self) -> String {
        agent_id(&self.pubkey, &self.relay)
    }
    /// The community's HTTP endpoints for writes, reads, profile name search,
    /// uploads and media; nothing else is ever sent to.
    pub fn events_url(&self) -> String {
        self.endpoint("/events")
    }
    pub fn query_url(&self) -> String {
        self.endpoint("/query")
    }
    pub fn profile_search_url(&self) -> String {
        self.endpoint("/profiles/search")
    }
    pub fn upload_url(&self) -> String {
        self.endpoint("/upload")
    }
    /// Its community's URL for one media blob, from that URL or its
    /// `sha256[.ext]` name. Media elsewhere is refused.
    pub fn media_url(&self, input: &str) -> Result<String> {
        let base = self.endpoint("/media/");
        let name = input.trim();
        let name = name.strip_prefix(base.as_str()).unwrap_or(name);
        let parts: Vec<&str> = name.split('.').collect();
        let ext = |part: &str| {
            !part.is_empty()
                && part.len() <= 8
                && part
                    .bytes()
                    .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
        };
        let valid = match parts.as_slice() {
            [hash] => crate::config::canonical_key(hash),
            [hash, part] => crate::config::canonical_key(hash) && ext(part),
            [hash, "thumb", "jpg" | "webp"] => crate::config::canonical_key(hash),
            _ => false,
        };
        if !valid {
            return Err("Agents fetch only their community's media".into());
        }
        Ok(format!("{base}{name}"))
    }
    /// Confirms a downloaded media body's SHA-256 (lowercase hex) matches the
    /// hash in its community URL.
    pub fn verify_media_hash(&self, url: &str, sha256: &str) -> Result<()> {
        let canonical = self.media_url(url)?;
        let expected = canonical
            .rsplit('/')
            .next()
            .and_then(|name| name.get(..64))
            .ok_or("Invalid media hash")?;
        if canonical.ends_with(".thumb.jpg") || canonical.ends_with(".thumb.webp") {
            // Thumbnails are derived images, but keep the source blob's name.
            return Ok(());
        }
        if sha256 != expected {
            return Err("Media did not match its SHA-256".into());
        }
        Ok(())
    }
    fn endpoint(&self, path: &str) -> String {
        format!("{}{path}", self.relay.replacen("wss://", "https://", 1))
    }
    pub fn read_key(&self, credentials: &dyn Credentials) -> Result<Secret> {
        credentials
            .read(&self.credential_id(), &self.pubkey)?
            .ok_or_else(|| "Agent key unavailable".into())
    }
    /// Signs one bounded event as this agent with its owner attestation attached.
    pub fn sign(
        &self,
        key: &Secret,
        kind: u16,
        content: String,
        tags: Vec<Vec<String>>,
    ) -> Result<serde_json::Value> {
        if !KINDS.contains(&kind) {
            return Err(
                "Agents can sign messages, edits, reactions, deletions, notes, channel changes, repositories and artifacts only"
                    .into(),
            );
        }
        bounded(kind, &content, &tags)?;
        let tags = self.attested(key, tags)?;
        framed(kind, key.signed(kind, content, tags)?)
    }
    /// Signs an event a local caller built, unchanged, as this agent. The
    /// caller's credential service has already classified its kind; this keeps
    /// the size bounds every agent event has.
    pub fn sign_built(
        &self,
        key: &Secret,
        kind: u16,
        content: String,
        tags: Vec<Vec<String>>,
        created_at: u64,
    ) -> Result<serde_json::Value> {
        if key.pubkey() != self.pubkey {
            return Err("Agent identity changed".into());
        }
        bounded(kind, &content, &tags)?;
        framed(kind, key.sign_event_at(kind, content, tags, created_at)?)
    }
    /// Whether the community accepted this row's current public metadata.
    pub fn profile_is_current(&self) -> bool {
        self.profile.as_ref().is_some_and(|last| {
            last.name == self.name && last.picture == self.picture && last.about == self.about
        })
    }
    /// Its profile as this row describes it, replacing the last one accepted.
    pub fn profile_event(&self, key: &Secret) -> Result<serde_json::Value> {
        valid_name(&self.name)?;
        let mut content = serde_json::json!({ "name": self.name, "bot": true });
        if let Some(picture) = &self.picture {
            content["picture"] = picture.as_str().into();
        }
        if let Some(about) = &self.about {
            content["about"] = about.as_str().into();
        }
        let content = content.to_string();
        let tags = self.attested(key, vec![])?;
        key.sign_event_after(
            0,
            content,
            tags,
            self.profile.as_ref().map(|p| p.created_at),
        )
    }
    fn attested(&self, key: &Secret, mut tags: Vec<Vec<String>>) -> Result<Vec<Vec<String>>> {
        if key.pubkey() != self.pubkey {
            return Err("Agent identity changed".into());
        }
        let auth: Vec<String> =
            serde_json::from_str(&self.auth).map_err(|_| "Invalid owner authorization")?;
        tags.retain(|tag| tag.first().map(String::as_str) != Some("auth"));
        tags.push(auth);
        Ok(tags)
    }
    /// NIP-98 authorization for posting `body` to this agent's community, as
    /// a write (`/events`), a read (`/query`) or a profile name search
    /// (`/profiles/search`).
    pub fn http_auth(&self, key: &Secret, url: &str, body: &[u8]) -> Result<serde_json::Value> {
        if key.pubkey() != self.pubkey {
            return Err("Agent identity changed".into());
        }
        if url != self.events_url() && url != self.query_url() && url != self.profile_search_url() {
            return Err("Agents post only to their community".into());
        }
        key.profile_auth(url, body)
    }
    /// NIP-98 authorization for this agent's own NIP-FI enrollment
    /// (`/v1/nip-fi/agent-grant`) or token request (`/v1/nip-fi/agent-assertion`)
    /// at its owner's identity issuer, whose origin the caller takes from the
    /// app's build configuration.
    pub fn issuer_auth(&self, key: &Secret, url: &str, body: &[u8]) -> Result<serde_json::Value> {
        if key.pubkey() != self.pubkey {
            return Err("Agent identity changed".into());
        }
        let path = url
            .split_once("://")
            .and_then(|(_, rest)| rest.find('/').map(|at| &rest[at..]));
        if !path.is_some_and(|path| {
            !path.contains(['?', '#'])
                && (path.ends_with("/v1/nip-fi/agent-grant")
                    || path.ends_with("/v1/nip-fi/agent-assertion"))
        }) {
            return Err("Agents authorize only their own enrollment and tokens".into());
        }
        key.profile_auth(url, body)
    }
    /// NIP-98 authorization for Git over HTTP to repository `repo` of `owner`
    /// in its community, and the URL it is bound to. Git reuses it for every
    /// request of one clone, fetch or push; the community honors it for a minute.
    pub fn git_auth(
        &self,
        key: &Secret,
        owner: &str,
        repo: &str,
    ) -> Result<(String, serde_json::Value)> {
        let name = repo.len() <= 64
            && !repo.starts_with('.')
            && !repo.contains("..")
            && repo
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'));
        if repo.is_empty() || !name || !crate::config::canonical_key(owner) {
            return Err("Invalid repository".into());
        }
        let url = self.endpoint(&format!("/git/{owner}/{repo}.git"));
        let tags = self.attested(
            key,
            vec![
                vec!["u".into(), url.clone()],
                vec!["method".into(), "GET".into()],
            ],
        )?;
        Ok((url, key.signed(27235, String::new(), tags)?))
    }
    /// NIP-42 authentication (22242) of a Huddle audio socket in its own
    /// community: it answers only the relay's `challenge`, with the owner
    /// attestation the relay links the agent to its owner by.
    pub fn audio_auth(&self, key: &Secret, challenge: &str) -> Result<serde_json::Value> {
        if challenge.is_empty() || challenge.len() > 4096 {
            return Err("Invalid Huddle challenge".into());
        }
        let tags = self.attested(
            key,
            vec![
                vec!["relay".into(), self.relay.clone()],
                vec!["challenge".into(), challenge.into()],
            ],
        )?;
        key.signed(22242, String::new(), tags)
    }
    /// Blossom authorization (24242) to upload the blob with this SHA-256 to
    /// its community, valid for a minute.
    pub fn upload_auth(&self, key: &Secret, sha256: &str) -> Result<serde_json::Value> {
        if !crate::config::canonical_key(sha256) {
            return Err("Invalid upload hash".into());
        }
        self.blossom_auth(
            key,
            "Upload file",
            vec![
                vec!["t".into(), "upload".into()],
                vec!["x".into(), sha256.into()],
            ],
        )
    }
    /// Blossom authorization (24242) to fetch media from its community, valid
    /// for a minute.
    pub fn media_auth(&self, key: &Secret) -> Result<serde_json::Value> {
        self.blossom_auth(key, "Get media", vec![vec!["t".into(), "get".into()]])
    }
    fn blossom_auth(
        &self,
        key: &Secret,
        content: &str,
        mut tags: Vec<Vec<String>>,
    ) -> Result<serde_json::Value> {
        if key.pubkey() != self.pubkey {
            return Err("Agent identity changed".into());
        }
        let expiration = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "System clock is unavailable")?
            .as_secs()
            + 60;
        let server = self.relay.trim_start_matches("wss://");
        tags.push(vec!["expiration".into(), expiration.to_string()]);
        tags.push(vec!["server".into(), server.into()]);
        key.sign_event_after(24242, content.into(), tags, None)
    }
    /// Its memory entry `slug`, encrypted to its owner and newer than the
    /// entry it replaces (`after`, that entry's `created_at`); without a body,
    /// the tombstone that deletes it.
    pub fn memory(
        &self,
        key: &Secret,
        slug: &str,
        body: Option<&str>,
        after: u64,
    ) -> Result<serde_json::Value> {
        if key.pubkey() != self.pubkey {
            return Err("Agent identity changed".into());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "System clock is unavailable")?
            .as_secs();
        key.memory_event(&self.owner, slug, body, now.max(after.saturating_add(1)))
    }
}

/// A key awaiting its owner attestation. Dropping a generated one discards it.
pub struct NewAppAgent {
    key: Secret,
    relay: String,
    owner: String,
    agent_type: String,
    name: String,
    picture: Option<String>,
    about: Option<String>,
    /// An earlier agent system's key, which may already be saved under this ID.
    adopted: bool,
}
impl NewAppAgent {
    pub fn pubkey(&self) -> &str {
        self.key.pubkey()
    }
    pub fn owner(&self) -> &str {
        &self.owner
    }
}

/// The saved identities, a JSON file under app data and, beside it, one with the
/// rows `join` added (`JOINED`). Reads see whole files (writes rename into
/// place); each read-modify-write holds a file lock beside them, since more than
/// one app instance can share the directory.
#[derive(Clone)]
pub struct AppAgents {
    path: PathBuf,
}

#[derive(Clone, Copy)]
struct IdentityFormat {
    version: u64,
    protection_clock: u64,
}
impl IdentityFormat {
    fn next_revision(&mut self) -> Result<u64> {
        if self.protection_clock >= MAX_PROTECTION_REVISION {
            return Err("Protection revision exhausted".into());
        }
        self.protection_clock += 1;
        Ok(self.protection_clock)
    }
}
impl AppAgents {
    pub fn open(path: PathBuf) -> Self {
        Self { path }
    }
    /// Every row, deleted ones included.
    pub fn list(&self) -> Result<Vec<AppAgent>> {
        self.read().map(|(rows, _)| rows)
    }
    /// Saves an earlier development build's versioned list apart, as `write`
    /// does, so older builds can read it again.
    pub fn upgrade(&self) -> Result<()> {
        if self.read()?.1.version == MULTI_COMMUNITY && !self.protection_upgrade_needed()? {
            self.update(|_| Ok(()))?;
        }
        Ok(())
    }
    /// Whether the owner has already opted this device's store into protection.
    pub fn protection_storage_current(&self) -> Result<bool> {
        Ok(self.read()?.1.version == PROTECTED_IDENTITIES)
    }
    /// Earlier protection previews need confirmation before any further edits.
    pub fn protection_upgrade_needed(&self) -> Result<bool> {
        let (agents, format) = self.read()?;
        Ok(format.version != PROTECTED_IDENTITIES
            && (format.version == LEGACY_PROTECTED_IDENTITIES
                || agents
                    .iter()
                    .any(|a| a.protection.is_some() || a.protection_revision > 0)
                || self.protection_used()?))
    }
    /// Called only after native owner confirmation. Re-read under the lock so
    /// another app's writes during confirmation are retained. Never changes keys.
    pub fn upgrade_protection_storage(&self) -> Result<()> {
        self.locked(|| {
            let (agents, mut format) = self.read()?;
            if format.version == PROTECTED_IDENTITIES {
                return Ok(());
            }
            format.version = PROTECTED_IDENTITIES;
            self.write(&agents, format)
        })
    }
    /// Every row, the persisted format and its monotonic protection clock.
    fn read(&self) -> Result<(Vec<AppAgent>, IdentityFormat)> {
        let malformed = || "Saved agent identities are malformed".to_owned();
        let made = match read_rows(&self.path)? {
            None => vec![],
            Some(serde_json::Value::Array(rows)) => parse_rows(rows)?,
            Some(serde_json::Value::Object(mut saved))
                if matches!(
                    saved.get("version").and_then(serde_json::Value::as_u64),
                    Some(MULTI_COMMUNITY | LEGACY_PROTECTED_IDENTITIES | PROTECTED_IDENTITIES)
                ) =>
            {
                let format = saved["version"].as_u64().ok_or_else(malformed)?;
                if saved.len() != if format == PROTECTED_IDENTITIES { 3 } else { 2 } {
                    return Err(malformed());
                }
                let Some(serde_json::Value::Array(rows)) = saved.remove("agents") else {
                    return Err(malformed());
                };
                let mut rows = parse_rows(rows)?;
                let highest = rows
                    .iter()
                    .map(|a| a.protection_revision)
                    .max()
                    .unwrap_or(0);
                let clock = if format == PROTECTED_IDENTITIES {
                    saved
                        .get("protectionClock")
                        .and_then(serde_json::Value::as_u64)
                        .filter(|clock| *clock >= highest && *clock <= MAX_PROTECTION_REVISION)
                        .ok_or_else(malformed)?
                } else {
                    highest
                };
                // It saved an agent added back to its home with `home`.
                for row in &mut rows {
                    if row.home.as_ref() == Some(&row.relay) {
                        row.home = None;
                    }
                }
                // Version 2 was also used by an earlier protection build that
                // did not understand split memberships. Do not discard keys
                // that build may have left in the sidecar.
                if format == MULTI_COMMUNITY
                    && (rows
                        .iter()
                        .any(|row| row.protection.is_some() || row.protection_revision > 0)
                        || self.protection_used()?)
                {
                    let sidecar = match read_rows(&self.joined())? {
                        None => vec![],
                        Some(serde_json::Value::Array(rows)) => parse_rows(rows)?,
                        Some(_) => return Err(malformed()),
                    };
                    if sidecar.iter().any(|other| {
                        !rows
                            .iter()
                            .any(|row| row.pubkey == other.pubkey && row.relay == other.relay)
                    }) {
                        return Err("An earlier protection preview saved incomplete version-2 identities. No automatic repair is available; restore a complete identities backup before retrying. Saved files and keys were left unchanged.".into());
                    }
                }
                return Ok((
                    rows,
                    IdentityFormat {
                        version: format,
                        protection_clock: clock,
                    },
                ));
            }
            Some(_) => return Err(malformed()),
        };
        let joined = match read_rows(&self.joined())? {
            None => vec![],
            Some(serde_json::Value::Array(rows)) => parse_rows(rows)?,
            Some(_) => return Err(malformed()),
        };
        // Older builds edit only the plain list: an agent they imported again
        // where it was added takes that row's place, and its home row, while
        // it has one, holds the agent's name and type, so neither they nor a
        // write cut short between the files leaves its rows disagreeing. A row
        // in both is one a write moved to the plain list.
        let joined: Vec<AppAgent> = joined
            .into_iter()
            .filter(|row| {
                !made
                    .iter()
                    .any(|other| other.pubkey == row.pubkey && other.relay == row.relay)
            })
            .map(|mut row| {
                if let Some(home) = made.iter().find(|home| {
                    home.pubkey == row.pubkey
                        && row.home.as_ref() == Some(&home.relay)
                        && !home.deleted
                }) {
                    row.name.clone_from(&home.name);
                    row.agent_type.clone_from(&home.agent_type);
                }
                row
            })
            .collect();
        let rows: Vec<AppAgent> = made.into_iter().chain(joined).collect();
        validate_protection(&rows)?;
        let clock = rows
            .iter()
            .map(|a| a.protection_revision)
            .max()
            .unwrap_or(0);
        Ok((
            rows,
            IdentityFormat {
                version: 0,
                protection_clock: clock,
            },
        ))
    }
    /// Where the rows `join` added are saved, beside the others.
    fn joined(&self) -> PathBuf {
        self.path.with_file_name(JOINED)
    }
    /// An agent that still has its key in the community at `relay`.
    pub fn get(&self, pubkey: &str, relay: &str) -> Result<AppAgent> {
        let relay = canonical_relay(relay)?;
        self.list()?
            .into_iter()
            .find(|agent| agent.live(pubkey, &relay))
            .ok_or_else(|| "No such agent on this device".into())
    }
    /// Runs `change` on the saved list while holding the cross-process lock, and
    /// saves what it returns.
    fn update<T>(&self, change: impl FnOnce(&mut Vec<AppAgent>) -> Result<T>) -> Result<T> {
        self.update_state(|agents, _| change(agents))
    }
    fn update_state<T>(
        &self,
        change: impl FnOnce(&mut Vec<AppAgent>, &mut IdentityFormat) -> Result<T>,
    ) -> Result<T> {
        let _lock = self.lock("lock")?;
        let (mut agents, mut format) = self.read()?;
        let result = change(&mut agents, &mut format)?;
        self.write(&agents, format)?;
        Ok(result)
    }
    /// Takes the cross-process lock in the file beside the list with
    /// `extension`, which is held until the returned file is dropped, or its
    /// process ends.
    fn lock(&self, extension: &str) -> Result<std::fs::File> {
        let dir = self.path.parent().ok_or("Invalid agent identity storage")?;
        std::fs::create_dir_all(dir).map_err(|_| "Could not create agent identity storage")?;
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options
            .open(self.path.with_extension(extension))
            .map_err(|_| "Could not open agent identity lock")?;
        lock.lock().map_err(|_| "Could not lock agent identities")?;
        Ok(lock)
    }
    /// Takes the lock a Join holds from saving its row until its key and row
    /// are settled, and that removing keys waits on, so no other app changes a
    /// membership's key meanwhile. A row still joining under it is one a
    /// crash left.
    fn keys_lock(&self) -> Result<std::fs::File> {
        self.lock("keys.lock")
    }
    fn locked<T>(&self, change: impl FnOnce() -> Result<T>) -> Result<T> {
        let _lock = self.lock("lock")?;
        change()
    }
    /// Opted-in stores retain the complete version-4 envelope and clock on
    /// every write. Legacy stores use the compatible split layout below;
    /// protection cannot convert them without explicit native confirmation.
    /// Saves the agents' memberships elsewhere than their homes, and Joins not
    /// yet settled, apart from the others, which stay the plain list older
    /// builds read: they refuse a row with fields they don't know, and would
    /// take a membership's state for the one under its bare pubkey. A row moves
    /// only to the plain list, as its Join settles, which is saved first, so a
    /// write cut short leaves it in both, where the plain one is read. From an
    /// earlier development build's versioned list, the other rows are saved
    /// first instead, as the list still holds every row until it is replaced.
    fn write(&self, agents: &[AppAgent], format: IdentityFormat) -> Result<()> {
        if format.version == PROTECTED_IDENTITIES {
            return save_rows(
                &self.path,
                &serde_json::json!({
                    "version": PROTECTED_IDENTITIES, "agents": agents,
                    "protectionClock": format.protection_clock,
                }),
            );
        }
        if format.version == LEGACY_PROTECTED_IDENTITIES
            || (format.version == MULTI_COMMUNITY && self.protection_used()?)
            || agents
                .iter()
                .any(|agent| agent.protection.is_some() || agent.protection_revision > 0)
        {
            return Err(PROTECTION_UPGRADE_REQUIRED.into());
        }
        let (joined, made): (Vec<&AppAgent>, Vec<&AppAgent>) = agents
            .iter()
            .partition(|agent| agent.home.is_some() || agent.joining);
        let path = self.joined();
        let save_joined = || {
            if !joined.is_empty() || path.exists() {
                save_rows(&path, &joined)?;
            }
            Ok(())
        };
        if format.version == MULTI_COMMUNITY {
            save_joined()?;
            save_rows(&self.path, &made)
        } else {
            save_rows(&self.path, &made)?;
            save_joined()
        }
    }
    /// Changes the agent in the community at `relay`, while it has its key there.
    fn edit(&self, pubkey: &str, relay: &str, change: impl FnOnce(&mut AppAgent)) -> Result<()> {
        let relay = canonical_relay(relay)?;
        self.update(|agents| {
            let agent = agents
                .iter_mut()
                .find(|agent| agent.live(pubkey, &relay))
                .ok_or("No such agent on this device")?;
            change(agent);
            Ok(())
        })
    }
    /// Changes the agent in every community it still has its key in.
    fn edit_all(&self, pubkey: &str, change: impl Fn(&mut AppAgent)) -> Result<()> {
        self.update(|agents| {
            let mut found = false;
            for agent in agents
                .iter_mut()
                .filter(|agent| agent.pubkey == pubkey && !agent.deleted)
            {
                change(agent);
                found = true;
            }
            if !found {
                return Err("No such agent on this device".into());
            }
            Ok(())
        })
    }
    fn defaults_path(&self) -> PathBuf {
        self.path.with_file_name("protection.json")
    }
    fn read_defaults(&self) -> Result<std::collections::BTreeMap<String, ProtectionDefaults>> {
        let bytes = match std::fs::read(self.defaults_path()) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Default::default());
            }
            Err(_) => return Err("Could not read protection defaults".into()),
        };
        let saved: std::collections::BTreeMap<String, ProtectionDefaults> =
            serde_json::from_slice(&bytes).map_err(|_| "Protection defaults are malformed")?;
        for (owner, value) in &saved {
            if !canonical_key(owner) || value.revision > 9_007_199_254_740_991 {
                return Err("Protection defaults are malformed".into());
            }
            if let Some(binding) = &value.defaults {
                binding.validate()?;
            }
        }
        Ok(saved)
    }
    fn protection_used(&self) -> Result<bool> {
        Ok(self
            .read_defaults()?
            .values()
            .any(|value| value.revision > 0 || value.defaults.is_some()))
    }
    pub fn protection_defaults(&self, owner: &str) -> Result<ProtectionDefaults> {
        if !canonical_key(owner) {
            return Err("Choose a signed-in owner".into());
        }
        Ok(self.read_defaults()?.remove(owner).unwrap_or_default())
    }
    pub fn set_protection_defaults(
        &self,
        owner: &str,
        revision: u64,
        provider: &str,
        policy: Option<serde_json::Value>,
    ) -> Result<()> {
        if !canonical_key(owner) {
            return Err("Choose a signed-in owner".into());
        }
        ProtectionBinding {
            provider: provider.into(),
            policy: serde_json::json!({}),
        }
        .validate()?;
        let binding = policy.map(|policy| ProtectionBinding {
            provider: provider.into(),
            policy,
        });
        if let Some(binding) = &binding {
            binding.validate()?;
        }
        self.locked(|| {
            let mut saved = self.read_defaults()?;
            let value = saved.entry(owner.into()).or_default();
            if value.revision != revision {
                return Err("Protection settings changed; refresh and retry".into());
            }
            if value
                .defaults
                .as_ref()
                .is_some_and(|b| b.provider != provider)
            {
                return Err("Another protection plugin owns these defaults".into());
            }
            if revision >= 9_007_199_254_740_991 {
                return Err("Protection revision exhausted".into());
            }
            *value = ProtectionDefaults {
                revision: revision + 1,
                defaults: binding,
            };
            let path = self.defaults_path();
            let temp = path.with_extension("tmp");
            let bytes =
                serde_json::to_vec(&saved).map_err(|_| "Could not encode protection defaults")?;
            // Install the fail-closed barrier before another build could see defaults
            // it does not understand. Failure keeps the previous defaults authoritative.
            let (agents, format) = self.read()?;
            if format.version != PROTECTED_IDENTITIES {
                return Err(PROTECTION_UPGRADE_REQUIRED.into());
            }
            self.write(&agents, format)?;
            std::fs::write(&temp, bytes).map_err(|_| "Could not save protection defaults")?;
            #[cfg(test)]
            tests::before_rename()?;
            std::fs::rename(&temp, &path).map_err(|_| "Could not save protection defaults".into())
        })
    }
    /// Compare and replace under the identity file's cross-process lock.
    pub fn set_protection(
        &self,
        pubkey: &str,
        revision: u64,
        provider: &str,
        policy: Option<serde_json::Value>,
    ) -> Result<()> {
        ProtectionBinding {
            provider: provider.into(),
            policy: serde_json::json!({}),
        }
        .validate()?;
        let binding = policy.map(|policy| ProtectionBinding {
            provider: provider.into(),
            policy,
        });
        if let Some(value) = &binding {
            value.validate()?;
        }
        self.update_state(|agents, format| {
            if format.version != PROTECTED_IDENTITIES {
                return Err(PROTECTION_UPGRADE_REQUIRED.into());
            }
            let members: Vec<_> = agents
                .iter_mut()
                .filter(|a| a.pubkey == pubkey && !a.deleted)
                .collect();
            if members.is_empty() {
                return Err("No such agent on this device".into());
            }
            if members
                .iter()
                .any(|agent| agent.deleting || agent.protection_revision != revision)
            {
                return Err("Agent protection changed; refresh and retry".into());
            }
            if members.iter().any(|agent| {
                agent
                    .protection
                    .as_ref()
                    .is_some_and(|b| b.provider != provider)
            }) {
                return Err("Another protection plugin owns this agent".into());
            }
            let next = format.next_revision()?;
            for agent in members {
                agent.protection = binding.clone();
                agent.protection_revision = next;
            }
            Ok(())
        })
    }
    pub fn prepare(
        destination: &str,
        owner: &str,
        agent_type: &str,
        name: &str,
    ) -> Result<NewAppAgent> {
        let mut agent = Self::adopt(
            destination,
            owner,
            agent_type,
            Secret::generate()?,
            name,
            None,
            None,
        )?;
        agent.adopted = false;
        Ok(agent)
    }
    /// As `prepare`, for a key an earlier agent system saved, so the agent keeps
    /// its identity and public profile metadata.
    pub fn adopt(
        destination: &str,
        owner: &str,
        agent_type: &str,
        key: Secret,
        name: &str,
        picture: Option<String>,
        about: Option<String>,
    ) -> Result<NewAppAgent> {
        if !canonical_key(owner) {
            return Err("Choose a signed-in owner".into());
        }
        valid_type(agent_type)?;
        Ok(NewAppAgent {
            relay: canonical_relay(destination)?,
            key,
            owner: owner.into(),
            agent_type: agent_type.into(),
            name: valid_name(name)?,
            picture: picture.filter(|url| crate::port::public_picture(url)),
            about,
            adopted: true,
        })
    }
    /// Saves the identity, then the key, so a saved key always has an identity to
    /// delete it by. If the key cannot be saved, the identity is withdrawn once
    /// its key is known to be gone; otherwise it stays for `remove` to retry.
    /// An attestation for another key or owner is refused. Returns the key too,
    /// so its first use needs no credential read.
    pub fn commit(
        &self,
        prepared: NewAppAgent,
        auth: &[String],
        credentials: &dyn Credentials,
    ) -> Result<(AppAgent, Secret)> {
        let auth = serde_json::to_string(auth).map_err(|_| "Invalid owner authorization")?;
        validate_attestation(&auth, prepared.key.pubkey())?;
        let tag: Vec<String> =
            serde_json::from_str(&auth).map_err(|_| "Invalid owner authorization")?;
        if tag[1] != prepared.owner {
            return Err("Agent authorization belongs to another owner".into());
        }
        let mut agent = AppAgent {
            pubkey: prepared.key.pubkey().into(),
            relay: prepared.relay,
            owner: prepared.owner,
            auth,
            agent_type: prepared.agent_type,
            name: prepared.name,
            picture: prepared.picture,
            about: prepared.about,
            profile: None,
            deleted: false,
            deleting: false,
            home: None,
            joining: false,
            protection: None,
            protection_revision: 0,
        };
        let id = agent.credential_id();
        // A harness agent saved for the same community keeps this key under the
        // same ID. It is shared, never added again or deleted on failure here.
        let shared = prepared.adopted && credentials.read(&id, &agent.pubkey)?.is_some();
        let mut pushed = false;
        let added = self.update_state(|agents, format| {
            // A deleted row awaiting its community cleanup is taken back.
            if prepared.adopted
                && agents
                    .iter()
                    .any(|saved| saved.pubkey == agent.pubkey && !saved.deleted)
            {
                return Err("That agent is already here".into());
            }
            agent.protection = self.protection_defaults(&agent.owner)?.defaults;
            if format.version == PROTECTED_IDENTITIES {
                agent.protection_revision = format.next_revision()?;
            }
            agents.retain(|saved| saved.pubkey != agent.pubkey || saved.relay != agent.relay);
            agents.push(agent.clone());
            pushed = true;
            Ok(())
        });
        // When only the other file failed to save, the row is on disk, and
        // that file holds the same rows as before, so its key is saved too.
        if let Err(error) = added {
            if !pushed || !self.list()?.contains(&agent) {
                return Err(error);
            }
        }
        if shared {
            return Ok((agent, prepared.key));
        }
        let saved = credentials.add(&id, &prepared.key).and_then(|()| {
            agent
                .read_key(credentials)
                .map(drop)
                .map_err(|_| "New agent key could not be verified".into())
        });
        if let Err(error) = saved {
            // Another writer may have saved the same adopted key meanwhile; that
            // copy is theirs as much as this agent's.
            if prepared.adopted && matches!(credentials.read(&id, &agent.pubkey), Ok(Some(_))) {
                return Ok((agent, prepared.key));
            }
            if prepared.adopted || credentials.delete(&id, &agent.pubkey).is_ok() {
                let _ = self.update(|agents| {
                    agents
                        .retain(|saved| saved.pubkey != agent.pubkey || saved.relay != agent.relay);
                    Ok(())
                });
            }
            return Err(error);
        }
        Ok((agent, prepared.key))
    }
    /// Adds the agent, as it is in the community at `from`, to the community at
    /// `destination`: the same key, owner attestation, type and name, with
    /// `picture` (one that community serves) and its own profile there. Saves the
    /// row as joining, then the key under the row's own ID, then the row as
    /// joined, so a crash between them never leaves a membership without its
    /// key, all under the keys lock, so another app's Join or removal waits
    /// for it to settle. Refused while it is leaving `from` or being deleted,
    /// and while it is in `destination` or still leaving it; a deleted row
    /// there awaiting cleanup, or one a crash left joining, is taken back.
    pub fn join(
        &self,
        pubkey: &str,
        from: &str,
        destination: &str,
        picture: Option<String>,
        credentials: &dyn Credentials,
    ) -> Result<AppAgent> {
        let (from, relay) = (canonical_relay(from)?, canonical_relay(destination)?);
        if picture
            .as_deref()
            .is_some_and(|url| !crate::port::public_picture(url))
        {
            return Err("Use an HTTPS image URL without credentials".into());
        }
        let _keys = self.keys_lock()?;
        let source = self.get(pubkey, &from)?;
        let key = source.read_key(credentials)?;
        let agent = self.update(|agents| {
            let source = agents
                .iter()
                .find(|agent| agent.live(pubkey, &from))
                .ok_or("No such agent on this device")?;
            if source.deleting {
                return Err(format!("{} is being deleted", source.name));
            }
            if let Some(there) = agents.iter().find(|agent| agent.live(pubkey, &relay)) {
                return Err(if there.deleting {
                    format!("{} is still leaving that community", there.name)
                } else {
                    format!("{} is already in that community", there.name)
                });
            }
            let agent = AppAgent {
                relay: relay.clone(),
                picture: picture.clone(),
                profile: None,
                deleted: false,
                deleting: false,
                // Back in its home, it is the home row again.
                home: Some(source.home.clone().unwrap_or_else(|| source.relay.clone()))
                    .filter(|home| *home != relay),
                joining: true,
                ..source.clone()
            };
            agents.retain(|saved| saved.pubkey != pubkey || saved.relay != relay);
            agents.push(agent.clone());
            Ok(agent)
        })?;
        let id = agent.credential_id();
        // A Join a crash cut short may have saved the key already: only this
        // agent's key reads back under its ID.
        let saved = if agent.read_key(credentials).is_ok() {
            Ok(())
        } else {
            credentials.add(&id, &key).and_then(|()| {
                agent
                    .read_key(credentials)
                    .map(drop)
                    .map_err(|_| "Agent key could not be verified".into())
            })
        };
        saved.inspect_err(|_| {
            if credentials.delete(&id, pubkey).is_ok() {
                let _ = self.update(|agents| {
                    agents.retain(|saved| {
                        saved.pubkey != pubkey || saved.relay != relay || !saved.joining
                    });
                    Ok(())
                });
            }
        })?;
        // The verified key stays: a row still joining settles when it is added
        // again. When only the other file failed to save, the plain list holds
        // the row settled, though another app may have renamed it since.
        let mut settling = false;
        let joined = self.update(|agents| {
            let joined = agents
                .iter_mut()
                .find(|saved| saved.pubkey == pubkey && saved.relay == relay)
                .filter(|saved| !saved.deleted && saved.joining)
                .ok_or("The agent was removed while it was being added")?;
            joined.joining = false;
            settling = true;
            Ok(joined.clone())
        });
        if joined.is_err() && settling {
            if let Some(settled) = self
                .list()?
                .into_iter()
                .find(|saved| saved.live(pubkey, &relay))
            {
                return Ok(settled);
            }
        }
        joined
    }
    /// Renames it in every community it is in.
    pub fn rename(&self, pubkey: &str, name: &str) -> Result<()> {
        let name = valid_name(name)?;
        self.edit_all(pubkey, |agent| agent.name = name.clone())
    }
    /// Makes it an agent of another type in every community it is in; its
    /// identity and profiles stay.
    pub fn set_type(&self, pubkey: &str, agent_type: &str) -> Result<()> {
        valid_type(agent_type)?;
        self.edit_all(pubkey, |agent| agent.agent_type = agent_type.into())
    }
    /// Sets or, with `None`, clears its profile picture in the community at
    /// `relay`: an `https` URL without credentials, which that community serves.
    pub fn set_picture(&self, pubkey: &str, relay: &str, picture: Option<String>) -> Result<()> {
        if picture
            .as_deref()
            .is_some_and(|url| !crate::port::public_picture(url))
        {
            return Err("Use an HTTPS image URL without credentials".into());
        }
        self.edit(pubkey, relay, |agent| agent.picture = picture)
    }
    /// Records a profile the community at `relay` accepted, unless a newer one
    /// already is.
    pub fn published(&self, pubkey: &str, relay: &str, profile: Published) -> Result<()> {
        self.edit(pubkey, relay, |agent| {
            if agent
                .profile
                .as_ref()
                .is_none_or(|last| last.created_at < profile.created_at)
            {
                agent.profile = Some(profile);
            }
        })
    }
    /// Marks its Delete as started in every community it is in, which only
    /// finishing it there clears. From here, it joins no other community.
    pub fn begin_delete(&self, pubkey: &str) -> Result<()> {
        self.edit_all(pubkey, |agent| agent.deleting = true)
    }
    /// Marks its leaving the community at `relay` as started, which only
    /// finishing it clears. Refused unless it stays in another community: its
    /// last one goes with Delete, which deletes the agent.
    pub fn begin_leave(&self, pubkey: &str, relay: &str) -> Result<()> {
        let relay = canonical_relay(relay)?;
        self.update(|agents| {
            let stays = agents.iter().any(|agent| {
                agent.pubkey == pubkey
                    && agent.relay != relay
                    && !agent.deleted
                    && !agent.joining
                    && !agent.deleting
            });
            let agent = agents
                .iter_mut()
                .find(|agent| agent.live(pubkey, &relay))
                .ok_or("No such agent on this device")?;
            if !stays && !agent.deleting {
                return Err("Its last community goes only when it is deleted".into());
            }
            agent.deleting = true;
            Ok(())
        })
    }
    /// Takes, for this copy of the app, taking the agent out of the community at
    /// `relay`, once its Delete or leaving there started. Its cleanup there and
    /// `remove` run under it, so no other copy's cleanup runs alongside, and
    /// once its row goes none can start, nor reach a membership added there
    /// again since. Held until the returned value is dropped, or its process
    /// ends. Refused while another holds it for the agent in any community.
    #[allow(clippy::incompatible_msrv)] // `File` locking, as `lock` does.
    pub fn hold_removal(&self, pubkey: &str, relay: &str) -> Result<Removal> {
        let relay = canonical_relay(relay)?;
        let removing = || -> Result<AppAgent> {
            let agent = self
                .list()?
                .into_iter()
                .find(|agent| agent.pubkey == pubkey && agent.relay == relay && !agent.deleted)
                .ok_or("No such agent on this device")?;
            if !agent.deleting {
                return Err(format!(
                    "{} isn't being removed from that community",
                    agent.name
                ));
            }
            Ok(agent)
        };
        let agent = removing()?;
        let dir = self.path.parent().ok_or("Invalid agent identity storage")?;
        let dir = dir.join("removals");
        std::fs::create_dir_all(&dir).map_err(|_| "Could not create agent identity storage")?;
        // The pubkey is a row's, so hex: a plain file name.
        let held = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join(format!("{}.lock", agent.pubkey)))
            .map_err(|_| "Could not open agent identity lock")?;
        match held.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(format!(
                    "{} is being removed in another copy of the app. Try again once it's done.",
                    agent.name
                ));
            }
            Err(std::fs::TryLockError::Error(_)) => {
                return Err("Could not lock agent identities".into());
            }
        }
        // Read again under it, as another copy may have finished meanwhile.
        removing()?;
        Ok(Removal {
            pubkey: agent.pubkey,
            relay,
            _held: held,
        })
    }
    /// Deletes its key in the community `removal` holds, then marks that row
    /// deleted, so a failed deletion can be retried. Its rows in other
    /// communities keep their own copies of the key. With the last of them goes
    /// any Join a crash cut short, first, so nothing is left with a key and no
    /// agent shown. Absence is success.
    pub fn remove(&self, removal: &Removal, credentials: &dyn Credentials) -> Result<()> {
        let (pubkey, relay) = (removal.pubkey.as_str(), removal.relay.as_str());
        let _keys = self.keys_lock()?;
        let rows = self.list()?;
        let Some(agent) = rows
            .iter()
            .find(|agent| agent.pubkey == pubkey && agent.relay == relay && !agent.deleted)
        else {
            return Ok(());
        };
        // Under the keys lock, a joining row is no Join under way.
        let last = !rows
            .iter()
            .any(|other| other.relay != relay && other.live(pubkey, &other.relay));
        let unfinished: Vec<&AppAgent> = rows
            .iter()
            .filter(|other| {
                last && other.pubkey == pubkey
                    && other.relay != relay
                    && other.joining
                    && !other.deleted
            })
            .collect();
        for other in &unfinished {
            credentials.delete(&other.credential_id(), pubkey)?;
        }
        credentials.delete(&agent.credential_id(), pubkey)?;
        self.update(|agents| {
            agents.retain(|saved| {
                !unfinished.iter().any(|other| {
                    saved.pubkey == pubkey && saved.relay == other.relay && saved.joining
                })
            });
            if let Some(agent) = agents
                .iter_mut()
                .find(|agent| agent.pubkey == pubkey && agent.relay == relay && !agent.deleted)
            {
                agent.deleted = true;
            }
            Ok(())
        })
    }
    /// Deletes every key it still has, as an erase that removes agents does
    /// before the rows go with app data. Absence is success, so it repeats safely.
    pub fn delete_keys(&self, credentials: &dyn Credentials) -> Result<()> {
        let _keys = self.keys_lock()?;
        for agent in self.list()?.into_iter().filter(|agent| !agent.deleted) {
            credentials.delete(&agent.credential_id(), &agent.pubkey)?;
        }
        Ok(())
    }
    /// Drops its deleted row in the community at `relay` once that community
    /// has been cleaned up.
    pub fn forget(&self, pubkey: &str, relay: &str) -> Result<()> {
        let relay = canonical_relay(relay)?;
        self.update(|agents| {
            agents.retain(|agent| agent.pubkey != pubkey || agent.relay != relay || !agent.deleted);
            Ok(())
        })
    }
}

/// One copy of the app taking an agent out of a community: see
/// `AppAgents::hold_removal`. Dropping it lets go.
#[derive(Debug)]
pub struct Removal {
    pubkey: String,
    relay: String,
    _held: std::fs::File,
}
impl Removal {
    /// Whether it is the agent's removal from the community at `relay`.
    pub fn is(&self, pubkey: &str, relay: &str) -> bool {
        canonical_relay(relay).is_ok_and(|relay| self.pubkey == pubkey && self.relay == relay)
    }
}

/// The version of the list earlier development builds saved once an agent was
/// in several communities.
const MULTI_COMMUNITY: u64 = 2;
const LEGACY_PROTECTED_IDENTITIES: u64 = 3;
const PROTECTED_IDENTITIES: u64 = 4;
const MAX_PROTECTION_REVISION: u64 = 9_007_199_254_740_991;
const PROTECTION_UPGRADE_REQUIRED: &str =
    "Owner confirmation is required to upgrade local agent storage for protection";
fn zero_revision(value: &u64) -> bool {
    *value == 0
}
/// The file beside the saved identities with the rows `join` added.
pub const JOINED: &str = "memberships.json";

/// Saved rows as this build reads them. Older development builds persisted
/// `adopted`; only that obsolete field is ignored, and all other row/schema
/// checks still apply.
fn parse_rows(mut rows: Vec<serde_json::Value>) -> Result<Vec<AppAgent>> {
    let malformed = || "Saved agent identities are malformed".to_owned();
    for row in &mut rows {
        if let Some(adopted) = row.as_object_mut().and_then(|row| row.remove("adopted")) {
            if !adopted.is_boolean() {
                return Err(malformed());
            }
        }
    }
    let agents: Vec<AppAgent> =
        serde_json::from_value(serde_json::Value::Array(rows)).map_err(|_| malformed())?;
    validate_protection(&agents)?;
    Ok(agents)
}
fn validate_protection(agents: &[AppAgent]) -> Result<()> {
    let malformed = || "Saved agent identities are malformed".to_owned();
    for agent in agents {
        if let Some(binding) = &agent.protection {
            binding.validate().map_err(|_| malformed())?;
        }
        if agent.protection_revision > 9_007_199_254_740_991 {
            return Err(malformed());
        }
        if !agent.deleted
            && agents.iter().any(|other| {
                !other.deleted
                    && other.pubkey == agent.pubkey
                    && (other.protection != agent.protection
                        || other.protection_revision != agent.protection_revision)
            })
        {
            return Err(malformed());
        }
    }
    Ok(())
}
/// The JSON saved at `path`; none when there is no file.
fn read_rows(path: &Path) -> Result<Option<serde_json::Value>> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "Saved agent identities are malformed".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not read saved agent identities".into()),
    }
}
/// Replaces the rows saved at `path` whole.
fn save_rows<T: Serialize + ?Sized>(path: &Path, rows: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(rows).map_err(|_| "Could not encode agent identities")?;
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, bytes).map_err(|_| "Could not save agent identities")?;
    #[cfg(test)]
    tests::before_rename()?;
    std::fs::rename(&temp, path).map_err(|_| "Could not save agent identities".into())
}

fn valid_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
        return Err("Name the agent in one line".into());
    }
    Ok(name.into())
}
fn valid_type(agent_type: &str) -> Result<()> {
    if agent_type.is_empty() || agent_type.len() > 256 {
        return Err("Choose an agent type".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
