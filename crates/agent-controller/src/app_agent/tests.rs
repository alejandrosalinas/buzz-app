use super::*;
use std::collections::BTreeMap;
use std::sync::Mutex;

thread_local! {
    // Fail one rename on this test's thread, after the preceding file committed.
    static FAIL_RENAME: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
pub(super) fn before_rename() -> Result<()> {
    FAIL_RENAME.with(|remaining| match remaining.get() {
        0 => Ok(()),
        n => {
            remaining.set(n - 1);
            if n == 1 {
                Err("Injected identity rename failure".into())
            } else {
                Ok(())
            }
        }
    })
}

const RELAY: &str = "wss://relay.example";

/// A row as builds before agents could be in several communities read it,
/// which refuses the whole list on a field it doesn't know.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct OlderRow {
    pubkey: String,
    relay: String,
    owner: String,
    auth: String,
    #[serde(rename = "type", default)]
    agent_type: String,
    #[serde(default)]
    name: String,
    picture: Option<String>,
    about: Option<String>,
    profile: Option<Published>,
    #[serde(default)]
    deleted: bool,
    #[serde(default)]
    deleting: bool,
}

#[derive(Default)]
struct Memory(Mutex<BTreeMap<String, String>>, Faults);
/// Credential-store operations to refuse, standing in for a denied or busy store.
#[derive(Default)]
struct Faults {
    add: std::sync::atomic::AtomicBool,
    read: std::sync::atomic::AtomicBool,
    delete: std::sync::atomic::AtomicBool,
}
/// Takes it out of the community at `relay`, as a copy of the app does.
fn remove(agents: &AppAgents, pubkey: &str, relay: &str, credentials: &Memory) -> Result<()> {
    agents.remove(&agents.hold_removal(pubkey, relay)?, credentials)
}
fn set(fault: &std::sync::atomic::AtomicBool, on: bool) {
    fault.store(on, std::sync::atomic::Ordering::SeqCst);
}
fn failing(fault: &std::sync::atomic::AtomicBool) -> Result<()> {
    if fault.load(std::sync::atomic::Ordering::SeqCst) {
        Err("Credential store refused".into())
    } else {
        Ok(())
    }
}
impl Credentials for Memory {
    fn read_legacy(&self, _: crate::LegacySource, _: &str) -> Result<Secret> {
        panic!("App agents never import")
    }
    fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>> {
        failing(&self.1.read)?;
        self.0
            .lock()
            .unwrap()
            .get(id)
            .map(|hex| Secret::parse(hex, pubkey))
            .transpose()
    }
    /// Never overwrites, as the platform stores don't.
    fn add(&self, id: &str, key: &Secret) -> Result<()> {
        failing(&self.1.add)?;
        match self.0.lock().unwrap().entry(id.into()) {
            std::collections::btree_map::Entry::Occupied(_) => Err("Already saved".into()),
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(key.hex().to_string());
                Ok(())
            }
        }
    }
    fn delete(&self, id: &str, _: &str) -> Result<()> {
        failing(&self.1.delete)?;
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

/// The owner `test_attestation` signs with.
fn owner() -> String {
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(&"a".repeat(64))).unwrap();
    auth[1].clone()
}
fn created(dir: &std::path::Path, credentials: &Memory) -> (AppAgents, AppAgent) {
    let agents = AppAgents::open(dir.join("agents/identities.json"));
    let prepared = AppAgents::prepare("https://relay.example/", &owner(), "p/t", "Ada").unwrap();
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(prepared.pubkey())).unwrap();
    let (agent, _) = agents.commit(prepared, &auth, credentials).unwrap();
    (agents, agent)
}

/// The rows, as `(pubkey, deleted)`.
fn rows(agents: &AppAgents) -> Vec<(String, bool)> {
    let list = agents.list().unwrap();
    list.into_iter()
        .map(|agent| (agent.pubkey, agent.deleted))
        .collect()
}

#[test]
fn creates_saves_and_removes_an_identity_with_its_key() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    assert_eq!(agent.relay, "wss://relay.example");
    assert_eq!(
        (agent.agent_type.as_str(), agent.name.as_str()),
        ("p/t", "Ada")
    );
    assert_eq!(agent.events_url(), "https://relay.example/events");
    assert_eq!(agents.list().unwrap(), std::slice::from_ref(&agent));
    assert_eq!(agents.get(&agent.pubkey, RELAY).unwrap(), agent);
    assert!(agent.read_key(&credentials).is_ok());
    // Only once its Delete started, the key goes at once; the row stays,
    // marked, for its community's cleanup.
    assert!(agents.hold_removal(&agent.pubkey, RELAY).is_err());
    assert!(agent.read_key(&credentials).is_ok());
    agents.begin_delete(&agent.pubkey).unwrap();
    let removal = agents.hold_removal(&agent.pubkey, RELAY).unwrap();
    agents.remove(&removal, &credentials).unwrap();
    assert_eq!(rows(&agents), [(agent.pubkey.clone(), true)]);
    assert!(agents.get(&agent.pubkey, RELAY).is_err());
    assert!(agents.rename(&agent.pubkey, "Bea").is_err());
    assert!(agent.read_key(&credentials).is_err());
    // Removing again is success.
    agents.remove(&removal, &credentials).unwrap();
    agents.forget(&agent.pubkey, RELAY).unwrap();
    assert!(agents.list().unwrap().is_empty());
}

#[test]
fn forgets_only_deleted_rows() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    agents.forget(&agent.pubkey, RELAY).unwrap();
    assert_eq!(agents.get(&agent.pubkey, RELAY).unwrap(), agent);
}

#[test]
fn an_unfinished_delete_keeps_its_key_and_refuses_import_from_any_copy() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let path = dir.path().join("agents/identities.json");
    let agents = AppAgents::open(path.clone());
    // Another copy of the app shares the same saved identities.
    let other = AppAgents::open(path);
    let key = Secret::generate().unwrap();
    let adopt = || {
        AppAgents::adopt(
            "https://relay.example/",
            &owner(),
            "p/t",
            Secret::parse(&key.hex(), key.pubkey()).unwrap(),
            "Ada",
            None,
            None,
        )
        .unwrap()
    };
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(key.pubkey())).unwrap();
    let (agent, _) = agents.commit(adopt(), &auth, &credentials).unwrap();
    agents.begin_delete(&agent.pubkey).unwrap();
    let saved = other.get(&agent.pubkey, RELAY).unwrap();
    assert!(saved.deleting && !saved.deleted);
    assert!(saved.read_key(&credentials).is_ok());
    assert_eq!(
        other.commit(adopt(), &auth, &credentials).err(),
        Some("That agent is already here".into())
    );
    // Only finishing the Delete lets it be imported again.
    remove(&agents, &agent.pubkey, RELAY, &credentials).unwrap();
    agents.forget(&agent.pubkey, RELAY).unwrap();
    let (back, _) = other.commit(adopt(), &auth, &credentials).unwrap();
    assert!(!back.deleting);
}

#[test]
fn re_import_takes_back_a_deleted_row() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let agents = AppAgents::open(dir.path().join("agents/identities.json"));
    let key = Secret::generate().unwrap();
    let adopt = || {
        AppAgents::adopt(
            "https://relay.example/",
            &owner(),
            "p/t",
            Secret::parse(&key.hex(), key.pubkey()).unwrap(),
            "Ada",
            None,
            None,
        )
        .unwrap()
    };
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(key.pubkey())).unwrap();
    let (agent, _) = agents.commit(adopt(), &auth, &credentials).unwrap();
    assert!(agents.commit(adopt(), &auth, &credentials).is_err());
    agents.begin_delete(&agent.pubkey).unwrap();
    remove(&agents, &agent.pubkey, RELAY, &credentials).unwrap();
    let (back, _) = agents.commit(adopt(), &auth, &credentials).unwrap();
    assert_eq!(rows(&agents), [(back.pubkey.clone(), false)]);
    // Its cleanup, if still running, has nothing to drop.
    agents.forget(&back.pubkey, RELAY).unwrap();
    assert_eq!(agents.get(&back.pubkey, RELAY).unwrap(), back);
}

#[test]
fn changes_only_a_live_agents_type() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    agents.set_type(&agent.pubkey, "q/u").unwrap();
    assert!(agents.set_type(&agent.pubkey, "").is_err());
    let changed = agents.get(&agent.pubkey, RELAY).unwrap();
    assert_eq!(
        changed,
        AppAgent {
            agent_type: "q/u".into(),
            ..agent.clone()
        }
    );
    agents.begin_delete(&agent.pubkey).unwrap();
    remove(&agents, &agent.pubkey, RELAY, &credentials).unwrap();
    assert!(agents.set_type(&agent.pubkey, "p/t").is_err());
}

#[test]
fn renames_and_profiles_replace_the_last_accepted_profile() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    let key = agent.read_key(&credentials).unwrap();
    let first = agent.profile_event(&key).unwrap();
    assert_eq!(first["kind"], 0);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(first["content"].as_str().unwrap()).unwrap(),
        serde_json::json!({"bot":true,"name":"Ada"})
    );
    let saved: Vec<String> = serde_json::from_str(&agent.auth).unwrap();
    assert_eq!(first["tags"], serde_json::json!([saved]));
    // An accepted profile from the future: the next must still be newer.
    let future = first["created_at"].as_u64().unwrap() + 100;
    let published = |created_at| Published {
        name: "Ada".into(),
        picture: None,
        about: None,
        created_at,
    };
    agents
        .published(&agent.pubkey, RELAY, published(future))
        .unwrap();
    agents
        .published(&agent.pubkey, RELAY, published(future - 1))
        .unwrap();
    agents.rename(&agent.pubkey, "  Bea ").unwrap();
    assert!(agents.rename(&agent.pubkey, " ").is_err());
    let renamed = agents.get(&agent.pubkey, RELAY).unwrap();
    assert_eq!(renamed.name, "Bea");
    assert_eq!(renamed.profile, Some(published(future)));
    let next = renamed.profile_event(&key).unwrap();
    assert_eq!(next["created_at"], future + 1);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(next["content"].as_str().unwrap()).unwrap(),
        serde_json::json!({"bot":true,"name":"Bea"})
    );
}

#[test]
fn a_set_picture_is_published_and_can_be_cleared() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    let key = agent.read_key(&credentials).unwrap();
    let url = "https://relay.example/media/abc";
    for refused in [
        "http://relay.example/a",
        "https://u:p@relay.example/a",
        "nope",
    ] {
        assert!(agents
            .set_picture(&agent.pubkey, RELAY, Some(refused.into()))
            .is_err());
    }
    agents
        .set_picture(&agent.pubkey, RELAY, Some(url.into()))
        .unwrap();
    let pictured = agents.get(&agent.pubkey, RELAY).unwrap();
    assert_eq!(pictured.picture.as_deref(), Some(url));
    assert!(!pictured.profile_is_current());
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            pictured.profile_event(&key).unwrap()["content"]
                .as_str()
                .unwrap()
        )
        .unwrap(),
        serde_json::json!({"bot":true,"name":"Ada","picture":url})
    );
    agents.set_picture(&agent.pubkey, RELAY, None).unwrap();
    assert_eq!(agents.get(&agent.pubkey, RELAY).unwrap().picture, None);
}

#[test]
fn a_failed_key_deletion_keeps_the_identity_for_a_retry() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    agents.begin_delete(&agent.pubkey).unwrap();
    let agent = agents.list().unwrap().remove(0);
    let removal = agents.hold_removal(&agent.pubkey, RELAY).unwrap();
    set(&credentials.1.delete, true);
    assert!(agents.remove(&removal, &credentials).is_err());
    assert_eq!(agents.list().unwrap(), std::slice::from_ref(&agent));
    assert!(agent.read_key(&credentials).is_ok());
    set(&credentials.1.delete, false);
    agents.remove(&removal, &credentials).unwrap();
    assert_eq!(rows(&agents), [(agent.pubkey, true)]);
    assert!(credentials.0.lock().unwrap().is_empty());
}

#[test]
fn a_failed_key_save_leaves_no_orphaned_key() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let agents = AppAgents::open(dir.path().join("identities.json"));
    let commit = |credentials: &Memory| {
        let prepared = AppAgents::prepare("wss://relay.example", &owner(), "p/t", "Ada").unwrap();
        let auth: Vec<String> =
            serde_json::from_str(&crate::secret::test_attestation(prepared.pubkey())).unwrap();
        agents.commit(prepared, &auth, credentials).map(drop)
    };
    // The store refuses the key: nothing is left behind.
    set(&credentials.1.add, true);
    assert!(commit(&credentials).is_err());
    assert!(agents.list().unwrap().is_empty());
    set(&credentials.1.add, false);
    // The key is saved but cannot be read back: it is deleted with its identity.
    set(&credentials.1.read, true);
    assert!(commit(&credentials).is_err());
    assert!(agents.list().unwrap().is_empty());
    assert!(credentials.0.lock().unwrap().is_empty());
    // ...and if it cannot be deleted either, its identity stays so `remove` can.
    set(&credentials.1.delete, true);
    assert!(commit(&credentials).is_err());
    let [stranded] = agents.list().unwrap().try_into().unwrap();
    set(&credentials.1.read, false);
    set(&credentials.1.delete, false);
    assert!(stranded.read_key(&credentials).is_ok());
    agents.begin_delete(&stranded.pubkey).unwrap();
    remove(&agents, &stranded.pubkey, RELAY, &credentials).unwrap();
    assert_eq!(rows(&agents), [(stranded.pubkey, true)]);
    assert!(credentials.0.lock().unwrap().is_empty());
}

#[test]
fn refuses_an_attestation_for_another_key_or_owner() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let agents = AppAgents::open(dir.path().join("identities.json"));
    let prepared = AppAgents::prepare("wss://relay.example", &owner(), "p/t", "Ada").unwrap();
    let other: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(&"b".repeat(64))).unwrap();
    assert!(agents.commit(prepared, &other, &credentials).is_err());
    let prepared =
        AppAgents::prepare("wss://relay.example", &"c".repeat(64), "p/t", "Ada").unwrap();
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(prepared.pubkey())).unwrap();
    assert!(agents.commit(prepared, &auth, &credentials).is_err());
    assert!(agents.list().unwrap().is_empty());
    assert!(credentials.0.lock().unwrap().is_empty());
}

#[test]
fn signs_only_bounded_kinds_with_the_saved_attestation() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (_, agent) = created(dir.path(), &credentials);
    let key = agent.read_key(&credentials).unwrap();
    let saved: Vec<String> = serde_json::from_str(&agent.auth).unwrap();
    for kind in [
        5, 7, 9, 9000, 9001, 9002, 9007, 9008, 9021, 9022, 20002, 30023, 30617, 40003, 40100,
        41010, 45010,
    ] {
        let tags = vec![
            vec!["auth".to_owned(), "forged".to_owned()],
            vec!["h".to_owned(), "channel".to_owned()],
            vec!["p".to_owned(), agent.owner.clone(), "admin".to_owned()],
        ];
        let event = agent.sign(&key, kind, "hi".into(), tags).unwrap();
        assert_eq!(event["kind"], kind);
        assert_eq!(event["pubkey"], agent.pubkey);
        let mut tags: Vec<Vec<String>> = serde_json::from_value(event["tags"].clone()).unwrap();
        if kind == 45010 {
            assert!(!tags.iter().any(|tag| tag[0] == "ms"));
        } else {
            let ms = tags.remove(tags.iter().position(|tag| tag[0] == "ms").unwrap());
            assert_eq!(ms[0], "ms");
            assert!(ms[1].parse::<u16>().unwrap() < 1000);
        }
        assert_eq!(
            tags,
            [
                vec!["h".to_owned(), "channel".to_owned()],
                vec!["p".to_owned(), agent.owner.clone(), "admin".to_owned()],
                saved.clone()
            ]
        );
    }
    // A plugin cannot pick its own `ms`, and events outside a channel get none.
    let forged = vec![
        vec!["h".to_owned(), "channel".to_owned()],
        vec!["ms".to_owned(), "999".to_owned()],
    ];
    let event = agent.sign(&key, 9, "hi".into(), forged).unwrap();
    let tags: Vec<Vec<String>> = serde_json::from_value(event["tags"].clone()).unwrap();
    assert_eq!(tags.iter().filter(|tag| tag[0] == "ms").count(), 1);
    let event = agent.sign(&key, 7, "+".into(), vec![]).unwrap();
    let tags: Vec<Vec<String>> = serde_json::from_value(event["tags"].clone()).unwrap();
    assert!(tags.iter().all(|tag| tag[0] != "ms"));
    for kind in [0, 1, 3, 9003, 10100, 24242, 27235, 30078, 30174, 40002] {
        assert!(agent.sign(&key, kind, String::new(), vec![]).is_err());
    }
    assert!(agent
        .sign(&key, 9, "x".repeat(64 * 1024 + 1), vec![])
        .is_err());
    assert!(agent.sign(&key, 9, String::new(), vec![vec![]]).is_err());
    let other = Secret::generate().unwrap();
    assert!(agent.sign(&other, 9, String::new(), vec![]).is_err());
    assert!(agent.http_auth(&other, &agent.events_url(), b"{}").is_err());
    for url in [
        agent.events_url(),
        agent.query_url(),
        agent.profile_search_url(),
    ] {
        let auth = agent.http_auth(&key, &url, b"{}").unwrap();
        assert_eq!(auth["kind"], 27235);
        assert_eq!(auth["tags"][0], serde_json::json!(["u", url]));
    }
    assert!(agent
        .http_auth(&key, "https://elsewhere.test/events", b"{}")
        .is_err());
    for url in [
        "https://id.test/api/v1/nip-fi/agent-grant",
        "https://id.test/v1/nip-fi/agent-assertion",
    ] {
        let auth = agent.issuer_auth(&key, url, b"{}").unwrap();
        assert_eq!(auth["tags"][0], serde_json::json!(["u", url]));
        assert!(agent.issuer_auth(&other, url, b"{}").is_err());
    }
    for url in [
        "https://id.test/v1/nip-fi/agent-grant?x",
        "https://id.test/v1/identity/assertions",
        agent.events_url().as_str(),
    ] {
        assert!(agent.issuer_auth(&key, url, b"{}").is_err());
    }
}

#[test]
fn signs_live_canvas_up_to_its_content_and_complete_event_limits() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (_, agent) = created(dir.path(), &credentials);
    let key = agent.read_key(&credentials).unwrap();
    let h = || vec![vec!["h".to_owned(), "channel".to_owned()]];
    let event = agent
        .sign(&key, 40100, "x".repeat(LIVE_CANVAS_BYTES), h())
        .unwrap();
    assert_eq!(event["content"].as_str().unwrap().len(), LIVE_CANVAS_BYTES);
    assert!(serde_json::to_vec(&event).unwrap().len() <= CANVAS_MAX_EVENT_BYTES);
    assert!(agent
        .sign(&key, 40100, "x".repeat(LIVE_CANVAS_BYTES + 1), h())
        .is_err());
    // Within the content limit, but escaping doubles it past the event bound.
    assert!(agent
        .sign(&key, 40100, "\"".repeat(LIVE_CANVAS_BYTES), h())
        .is_err());
    // Other kinds keep the ordinary bound.
    assert!(agent.sign(&key, 9, "x".repeat(64 * 1024 + 1), h()).is_err());
    // A caller-built event has the same bounds.
    let built = |content: String| agent.sign_built(&key, 40100, content, h(), 1_800_000_000);
    let event = built("x".repeat(LIVE_CANVAS_BYTES)).unwrap();
    assert!(serde_json::to_vec(&event).unwrap().len() <= CANVAS_MAX_EVENT_BYTES);
    assert!(built("x".repeat(LIVE_CANVAS_BYTES + 1)).is_err());
    assert!(built("\"".repeat(LIVE_CANVAS_BYTES)).is_err());
}

#[test]
fn signs_artifact_revisions_without_a_timeline_ms_tag() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (_, agent) = created(dir.path(), &credentials);
    let key = agent.read_key(&credentials).unwrap();
    let saved: Vec<String> = serde_json::from_str(&agent.auth).unwrap();
    let tag = |name: &str, value: &str| vec![name.to_owned(), value.to_owned()];
    // A deletion allows only its envelope and the verified auth tag, so an
    // added `ms` would make the relay refuse it.
    let envelope = vec![
        tag("ar", "1"),
        tag("d", "7c4f2b1e-3a9d-5e8f-9b6a-2d1c0e4f8a73"),
        tag("h", "a07a0c8a-cfef-43c3-91f7-69bf8d5e32d7"),
        tag("type", "example.record"),
        tag("op", "delete"),
        tag("prev", &"a".repeat(64)),
    ];
    let mut supplied = envelope.clone();
    supplied.push(tag("ms", "999"));
    let event = agent.sign(&key, 45010, String::new(), supplied).unwrap();
    let tags: Vec<Vec<String>> = serde_json::from_value(event["tags"].clone()).unwrap();
    let mut expected = envelope;
    expected.push(saved);
    assert_eq!(tags, expected);
    assert_eq!(event["content"], "");
    let signed: nostr::event::Event = serde_json::from_value(event).unwrap();
    signed.verify().unwrap();
}

#[test]
fn signs_audio_auth_for_only_the_challenge_in_its_own_community() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (_, agent) = created(dir.path(), &credentials);
    let key = agent.read_key(&credentials).unwrap();
    let saved: Vec<String> = serde_json::from_str(&agent.auth).unwrap();
    let auth = agent.audio_auth(&key, "relay-challenge").unwrap();
    assert_eq!(auth["kind"], 22242);
    assert_eq!(auth["pubkey"], agent.pubkey);
    assert_eq!(auth["content"], "");
    let tags: Vec<Vec<String>> = serde_json::from_value(auth["tags"].clone()).unwrap();
    assert_eq!(
        tags,
        [
            vec!["relay".to_owned(), RELAY.to_owned()],
            vec!["challenge".to_owned(), "relay-challenge".to_owned()],
            saved
        ]
    );
    assert!(agent.audio_auth(&key, "").is_err());
    assert!(agent.audio_auth(&key, &"c".repeat(4097)).is_err());
    let other = Secret::generate().unwrap();
    assert!(agent.audio_auth(&other, "relay-challenge").is_err());
}

#[test]
fn signs_git_auth_for_one_repository_in_its_own_community() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (_, agent) = created(dir.path(), &credentials);
    let key = agent.read_key(&credentials).unwrap();
    let saved: Vec<String> = serde_json::from_str(&agent.auth).unwrap();
    let owner = "a".repeat(64);
    let (url, auth) = agent.git_auth(&key, &owner, "hive").unwrap();
    assert_eq!(url, format!("{}/git/{owner}/hive.git", agent.endpoint("")));
    assert_eq!(auth["kind"], 27235);
    assert_eq!(auth["pubkey"], agent.pubkey);
    let tags: Vec<Vec<String>> = serde_json::from_value(auth["tags"].clone()).unwrap();
    assert_eq!(
        tags,
        [
            vec!["u".to_owned(), url],
            vec!["method".to_owned(), "GET".to_owned()],
            saved
        ]
    );
    for (owner, repo) in [
        (owner.as_str(), ""),
        (owner.as_str(), ".hive"),
        (owner.as_str(), "a..b"),
        (owner.as_str(), "a/b"),
        (owner.as_str(), "hive?x=1"),
        (owner.as_str(), &"h".repeat(65)),
        ("not-a-key", "hive"),
        (&"A".repeat(64), "hive"),
    ] {
        assert!(agent.git_auth(&key, owner, repo).is_err(), "{owner}/{repo}");
    }
    let other = Secret::generate().unwrap();
    assert!(agent.git_auth(&other, &owner, "hive").is_err());
}

#[test]
fn signs_uploads_and_memory_for_its_own_community_and_owner() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (_, agent) = created(dir.path(), &credentials);
    let key = agent.read_key(&credentials).unwrap();
    use sha2::{Digest, Sha256};
    let bytes = b"media body";
    let sha = format!("{:x}", Sha256::digest(bytes));
    let auth = agent.upload_auth(&key, &sha).unwrap();
    assert_eq!(auth["kind"], 24242);
    let tags: Vec<Vec<String>> = serde_json::from_value(auth["tags"].clone()).unwrap();
    assert_eq!(tags[1], ["x", sha.as_str()]);
    assert_eq!(
        tags[3],
        ["server", agent.relay.trim_start_matches("wss://")]
    );
    assert!(agent.upload_auth(&key, "not-a-hash").is_err());
    let get = agent.media_auth(&key).unwrap();
    assert_eq!(get["kind"], 24242);
    let tags: Vec<Vec<String>> = serde_json::from_value(get["tags"].clone()).unwrap();
    assert_eq!(tags[0], ["t", "get"]);
    assert_eq!(
        tags[2],
        ["server", agent.relay.trim_start_matches("wss://")]
    );
    let media = format!(
        "{}/media/{sha}.png",
        agent.relay.replacen("wss", "https", 1)
    );
    assert_eq!(agent.media_url(&media).unwrap(), media);
    assert_eq!(agent.media_url(&format!("{sha}.png")).unwrap(), media);
    assert!(agent.verify_media_hash(&media, &sha).is_ok());
    assert!(agent.verify_media_hash(&media, &"0".repeat(64)).is_err());
    let thumbnail = format!("{}/media/{sha}.thumb.jpg", agent.endpoint(""));
    assert!(agent.verify_media_hash(&thumbnail, &"0".repeat(64)).is_ok());
    let webp = format!("{}/media/{sha}.thumb.webp", agent.endpoint(""));
    assert!(agent.verify_media_hash(&webp, &"0".repeat(64)).is_ok());
    for input in [
        format!("https://elsewhere.test/media/{sha}.png"),
        format!("{media}?x=1"),
        format!("{sha}/../x"),
        format!("{sha}.PNG"),
        "not-a-hash".into(),
    ] {
        assert!(agent.media_url(&input).is_err(), "{input}");
    }
    let future = u64::MAX / 2;
    let memory = agent.memory(&key, "mem/notes", Some("hi"), future).unwrap();
    assert_eq!(memory["kind"], 30174);
    assert_eq!(memory["created_at"], future + 1);
    assert_eq!(memory["tags"][1], serde_json::json!(["p", agent.owner]));
    assert!(agent.memory(&key, "../notes", Some("hi"), 0).is_err());
    let other = Secret::generate().unwrap();
    assert!(agent.upload_auth(&other, &sha).is_err());
    assert!(agent.media_auth(&other).is_err());
    assert!(agent.memory(&other, "core", Some("hi"), 0).is_err());
}

#[test]
fn concurrent_writers_on_one_file_keep_every_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("agents/identities.json");
    let credentials = std::sync::Arc::new(Memory::default());
    let threads: Vec<_> = (0..8)
        .map(|_| {
            // Separate handles stand in for separate app instances.
            let agents = AppAgents::open(path.clone());
            let credentials = credentials.clone();
            std::thread::spawn(move || {
                let prepared =
                    AppAgents::prepare("https://relay.example/", &owner(), "p/t", "Ada").unwrap();
                let auth: Vec<String> =
                    serde_json::from_str(&crate::secret::test_attestation(prepared.pubkey()))
                        .unwrap();
                agents
                    .commit(prepared, &auth, credentials.as_ref())
                    .unwrap()
                    .0
                    .pubkey
            })
        })
        .collect();
    let mut made: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    let mut saved: Vec<_> = AppAgents::open(path)
        .list()
        .unwrap()
        .into_iter()
        .map(|agent| agent.pubkey)
        .collect();
    made.sort();
    saved.sort();
    assert_eq!(saved, made);
}

#[test]
fn an_adopted_key_keeps_its_identity_picture_and_shared_saved_key() {
    let credentials = Memory::default();
    let key = Secret::generate().unwrap();
    let pubkey = key.pubkey().to_owned();
    // A harness agent already keeps this key under the same community's ID.
    let id = agent_id(&pubkey, "wss://relay.example");
    credentials.add(&id, &key).unwrap();
    set(&credentials.1.add, true);
    let dirs: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
    let store = |n: usize| AppAgents::open(dirs[n].path().join("agents/identities.json"));
    let adopt = |picture: &str| {
        AppAgents::adopt(
            "https://relay.example/",
            &owner(),
            "p/t",
            Secret::parse(&key.hex(), &pubkey).unwrap(),
            "Ada",
            Some(picture.into()),
            Some("Reviews pull requests".into()),
        )
        .unwrap()
    };
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(&pubkey)).unwrap();
    let agents = store(0);
    let (agent, _) = agents
        .commit(
            adopt("https://relay.example/media/a.png"),
            &auth,
            &credentials,
        )
        .unwrap();
    assert_eq!(agent.pubkey, pubkey);
    assert!(!serde_json::to_value(&agent)
        .unwrap()
        .as_object()
        .unwrap()
        .contains_key("adopted"));
    assert_eq!(
        agents.get(&pubkey, RELAY).unwrap().about.as_deref(),
        Some("Reviews pull requests")
    );
    let profile = agent
        .profile_event(&agent.read_key(&credentials).unwrap())
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(profile["content"].as_str().unwrap()).unwrap(),
        serde_json::json!({"about":"Reviews pull requests","bot":true,"name":"Ada","picture":"https://relay.example/media/a.png"})
    );
    // Once here, it is not taken over again.
    let again = adopt("https://a.example/b.png");
    assert!(agents.commit(again, &auth, &credentials).is_err());
    // A shared key that fails to verify is left where it was.
    set(&credentials.1.read, true);
    assert!(store(1)
        .commit(adopt("https://a.example/b.png"), &auth, &credentials)
        .is_err());
    set(&credentials.1.read, false);
    assert!(credentials.read(&id, &pubkey).unwrap().is_some());
    assert!(rows(&store(1)).is_empty());
    // Inline pictures are not profile pictures.
    let (agent, _) = store(2)
        .commit(adopt("data:image/png;base64,AA"), &auth, &credentials)
        .unwrap();
    assert_eq!(agent.picture, None);
}

#[test]
fn an_adopted_key_that_cannot_be_saved_withdraws_only_its_row() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let agents = AppAgents::open(dir.path().join("agents/identities.json"));
    let key = Secret::generate().unwrap();
    let pubkey = key.pubkey().to_owned();
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(&pubkey)).unwrap();
    let adopt = || {
        AppAgents::adopt(
            "https://relay.example/",
            &owner(),
            "p/t",
            Secret::parse(&key.hex(), &pubkey).unwrap(),
            "Ada",
            None,
            None,
        )
        .unwrap()
    };
    set(&credentials.1.add, true);
    assert!(agents.commit(adopt(), &auth, &credentials).is_err());
    assert!(rows(&agents).is_empty());
    set(&credentials.1.add, false);
    let (agent, _) = agents.commit(adopt(), &auth, &credentials).unwrap();
    assert_eq!(agent.read_key(&credentials).unwrap().pubkey(), pubkey);
}

#[test]
fn deleting_keys_removes_every_agents_key_and_repeats_safely() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, first) = created(dir.path(), &credentials);
    let prepared = AppAgents::prepare("https://relay.example/", &owner(), "p/t", "Bea").unwrap();
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(prepared.pubkey())).unwrap();
    let (second, _) = agents.commit(prepared, &auth, &credentials).unwrap();
    agents.delete_keys(&credentials).unwrap();
    assert!(first.read_key(&credentials).is_err());
    assert!(second.read_key(&credentials).is_err());
    agents.delete_keys(&credentials).unwrap();
    // No saved identities is nothing to delete.
    AppAgents::open(dir.path().join("absent/identities.json"))
        .delete_keys(&credentials)
        .unwrap();
}

#[test]
fn saved_public_profile_survives_updates_and_is_signed() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    let mut saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&agents.path).unwrap()).unwrap();
    saved[0]["picture"] = "https://relay.example/media/a.png".into();
    saved[0]["about"] = "Reviews pull requests.\nKeeps changes small.".into();
    // Existing receipts predate picture/about tracking.
    saved[0]["profile"] = serde_json::json!({"name": "Ada", "createdAt": 500});
    std::fs::write(&agents.path, saved.to_string()).unwrap();
    agents.rename(&agent.pubkey, "Bea").unwrap();
    let reopened = AppAgents::open(agents.path.clone());
    let agent = reopened.get(&agent.pubkey, RELAY).unwrap();
    let event = agent
        .profile_event(&agent.read_key(&credentials).unwrap())
        .unwrap();
    let content: serde_json::Value =
        serde_json::from_str(event["content"].as_str().unwrap()).unwrap();
    assert_eq!(
        content,
        serde_json::json!({
            "name": "Bea", "bot": true,
            "picture": "https://relay.example/media/a.png",
            "about": "Reviews pull requests.\nKeeps changes small.",
        })
    );
    assert!(!agent.profile_is_current());
    reopened
        .published(
            &agent.pubkey,
            RELAY,
            Published {
                name: agent.name.clone(),
                picture: agent.picture.clone(),
                about: agent.about.clone(),
                created_at: event["created_at"].as_u64().unwrap(),
            },
        )
        .unwrap();
    assert!(reopened
        .get(&agent.pubkey, RELAY)
        .unwrap()
        .profile_is_current());
    let accepted = std::fs::read(&reopened.path).unwrap();
    // Each metadata-only change/clear must publish, even without a rename.
    for field in ["picture", "about"] {
        for replacement in [Some("https://relay.example/changed"), None] {
            let mut changed: serde_json::Value = serde_json::from_slice(&accepted).unwrap();
            changed[0][field] = serde_json::json!(replacement);
            std::fs::write(&reopened.path, changed.to_string()).unwrap();
            let changed = reopened.get(&agent.pubkey, RELAY).unwrap();
            assert!(!changed.profile_is_current());
            let event = changed
                .profile_event(&agent.read_key(&credentials).unwrap())
                .unwrap();
            let content: serde_json::Value =
                serde_json::from_str(event["content"].as_str().unwrap()).unwrap();
            assert_eq!(
                content.get(field).and_then(serde_json::Value::as_str),
                replacement
            );
        }
    }
    let event: nostr::event::Event = serde_json::from_value(event).unwrap();
    event.verify().unwrap();
}

#[test]
fn old_adopted_flags_are_read_then_dropped_without_relaxing_the_schema() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    let original = serde_json::to_value(agents.list().unwrap()).unwrap();
    for adopted in [false, true] {
        let mut saved = original.clone();
        saved[0]["adopted"] = adopted.into();
        std::fs::write(&agents.path, saved.to_string()).unwrap();
        assert_eq!(agents.get(&agent.pubkey, RELAY).unwrap(), agent);
        agents.rename(&agent.pubkey, "Bea").unwrap();
        let rewritten: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&agents.path).unwrap()).unwrap();
        assert!(!rewritten[0].as_object().unwrap().contains_key("adopted"));
    }
    for (field, value) in [
        ("adopted", serde_json::json!("true")),
        ("unknown", serde_json::json!(true)),
    ] {
        let mut saved = original.clone();
        saved[0][field] = value;
        std::fs::write(&agents.path, saved.to_string()).unwrap();
        assert!(agents.list().is_err());
    }
}

#[test]
fn joins_communities_and_leaves_them_one_at_a_time() {
    const OTHER: &str = "wss://other.example";
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    let path = dir.path().join("agents/identities.json");
    let read = |name: &str| {
        serde_json::from_slice::<serde_json::Value>(
            &std::fs::read(path.with_file_name(name)).unwrap(),
        )
        .unwrap()
    };
    // Older builds read the plain list, in the fields they know, and nothing
    // of the communities the agent was added to.
    let saved = || {
        let saved = read("identities.json");
        for row in saved.as_array().unwrap() {
            assert!(serde_json::from_value::<OlderRow>(row.clone()).is_ok());
        }
        saved
    };
    assert_eq!(saved().as_array().unwrap().len(), 1);

    let picture = "https://other.example/media/a.png";
    let joined = agents
        .join(
            &agent.pubkey,
            RELAY,
            "https://other.example/",
            Some(picture.into()),
            &credentials,
        )
        .unwrap();
    assert_eq!(
        (
            joined.relay.as_str(),
            joined.picture.as_deref(),
            &joined.auth
        ),
        (OTHER, Some(picture), &agent.auth)
    );
    assert_eq!(
        joined.read_key(&credentials).unwrap().pubkey(),
        agent.pubkey
    );
    assert!(agents
        .join(&agent.pubkey, RELAY, OTHER, None, &credentials)
        .is_err());
    assert_eq!(saved().as_array().unwrap().len(), 1);
    assert_eq!(read(JOINED).as_array().unwrap().len(), 1);
    assert_eq!(agents.list().unwrap(), [agent.clone(), joined.clone()]);

    // Names and types are the agent's; pictures and profiles each community's.
    agents.rename(&agent.pubkey, "Bea").unwrap();
    agents.set_picture(&agent.pubkey, RELAY, None).unwrap();
    let [here, there] = agents.list().unwrap().try_into().unwrap();
    assert_eq!((here.name.as_str(), there.name.as_str()), ("Bea", "Bea"));
    assert_eq!(
        (here.picture, there.picture.as_deref()),
        (None, Some(picture))
    );

    // Leaving one community keeps the agent, and its key, in the other.
    agents.begin_leave(&agent.pubkey, OTHER).unwrap();
    assert!(agents
        .join(&agent.pubkey, RELAY, OTHER, None, &credentials)
        .is_err());
    assert!(agents.begin_leave(&agent.pubkey, RELAY).is_err());
    // One copy of the app takes it out at a time, from before its cleanup
    // there until its row goes.
    let removal = agents.hold_removal(&agent.pubkey, OTHER).unwrap();
    let late = AppAgents::open(path.clone());
    assert!(late.hold_removal(&agent.pubkey, OTHER).is_err());
    agents.remove(&removal, &credentials).unwrap();
    agents.forget(&agent.pubkey, OTHER).unwrap();
    drop(removal);
    assert_eq!(saved().as_array().unwrap().len(), 1);
    assert_eq!(read(JOINED), serde_json::json!([]));
    assert!(agents
        .get(&agent.pubkey, RELAY)
        .unwrap()
        .read_key(&credentials)
        .is_ok());

    // Added again, the other copy's removal, started before, can't take it.
    let back = agents
        .join(&agent.pubkey, RELAY, OTHER, None, &credentials)
        .unwrap();
    assert!(late.hold_removal(&agent.pubkey, OTHER).is_err());
    assert!(back.read_key(&credentials).is_ok());

    // Delete marks every community; none can be joined while it runs.
    agents.begin_delete(&agent.pubkey).unwrap();
    assert!(agents.list().unwrap().iter().all(|agent| agent.deleting));
    remove(&agents, &agent.pubkey, RELAY, &credentials).unwrap();
    assert!(agents
        .join(&agent.pubkey, OTHER, RELAY, None, &credentials)
        .is_err());
    remove(&agents, &agent.pubkey, OTHER, &credentials).unwrap();
    assert!(credentials.0.lock().unwrap().is_empty());
}

#[test]
fn a_membership_keeps_its_home_once_the_home_is_left() {
    const OTHER: &str = "wss://other.example";
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    let joined = agents
        .join(&agent.pubkey, RELAY, OTHER, None, &credentials)
        .unwrap();
    assert_eq!(joined.home.as_deref(), Some(RELAY));
    agents.begin_leave(&agent.pubkey, RELAY).unwrap();
    remove(&agents, &agent.pubkey, RELAY, &credentials).unwrap();
    agents.forget(&agent.pubkey, RELAY).unwrap();
    // Kept from older builds, which would take the bare pubkey's state for it.
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&agents.path).unwrap()).unwrap();
    assert_eq!(saved, serde_json::json!([]));
    let [there] = agents.list().unwrap().try_into().unwrap();
    assert_eq!(there.home.as_deref(), Some(RELAY));
    // Back home, it is the home row again, which older builds read.
    let home = agents
        .join(&agent.pubkey, OTHER, RELAY, None, &credentials)
        .unwrap();
    assert_eq!(home.home, None);
    let saved: Vec<OlderRow> =
        serde_json::from_slice(&std::fs::read(&agents.path).unwrap()).unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(agents.list().unwrap().len(), 2);
}

#[test]
fn a_join_a_crash_cut_short_is_no_membership_until_it_is_added_again() {
    const OTHER: &str = "wss://other.example";
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    // As `join` saves it before the key: the app quit between them.
    agents
        .update(|rows| {
            rows.push(AppAgent {
                relay: OTHER.into(),
                home: Some(RELAY.into()),
                joining: true,
                ..agent.clone()
            });
            Ok(())
        })
        .unwrap();
    // Its only key stays: the joining row is not a community it stays in.
    assert!(agents.begin_leave(&agent.pubkey, RELAY).is_err());
    assert!(agents.get(&agent.pubkey, OTHER).is_err());
    // Adding it again finishes it.
    let joined = agents
        .join(&agent.pubkey, RELAY, OTHER, None, &credentials)
        .unwrap();
    assert!(!joined.joining);
    assert_eq!(agents.list().unwrap(), [agent.clone(), joined.clone()]);
    assert!(joined.read_key(&credentials).is_ok());
    let crash = || {
        agents
            .update(|rows| {
                rows.iter_mut()
                    .for_each(|row| row.joining = row.relay == OTHER);
                Ok(())
            })
            .unwrap()
    };
    // So does adding it again after the app quit with its key saved.
    crash();
    assert_eq!(
        agents
            .join(&agent.pubkey, RELAY, OTHER, None, &credentials)
            .unwrap(),
        joined
    );
    // Or the removal of its last community takes it first, with its key, as
    // Delete and Forget do.
    crash();
    agents.begin_delete(&agent.pubkey).unwrap();
    remove(&agents, &agent.pubkey, RELAY, &credentials).unwrap();
    agents.forget(&agent.pubkey, RELAY).unwrap();
    assert!(agents.list().unwrap().is_empty());
    assert!(credentials.0.lock().unwrap().is_empty());
}

#[test]
fn a_failed_join_leaves_the_agent_where_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    set(&credentials.1.add, true);
    assert!(agents
        .join(
            &agent.pubkey,
            RELAY,
            "wss://other.example",
            None,
            &credentials
        )
        .is_err());
    assert_eq!(agents.list().unwrap(), std::slice::from_ref(&agent));
    assert!(agent.read_key(&credentials).is_ok());
}

#[test]
fn reads_an_earlier_development_build_s_versioned_list_and_saves_it_apart() {
    const OTHER: &str = "wss://other.example";
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    let joined = agents
        .join(&agent.pubkey, RELAY, OTHER, None, &credentials)
        .unwrap();
    let rows = agents.list().unwrap();
    // It saved an agent added back to its home with `home`.
    let mut saved = serde_json::to_value(&rows).unwrap();
    saved[0]["home"] = RELAY.into();
    std::fs::write(
        &agents.path,
        serde_json::json!({ "version": 2, "agents": saved }).to_string(),
    )
    .unwrap();
    // Its versioned list holds every row; the other file is read only after.
    std::fs::write(agents.joined(), "[]").unwrap();
    assert_eq!(agents.list().unwrap(), rows);
    // Opening the app saves it apart, unchanged, before anything else does.
    agents.upgrade().unwrap();
    let saved: Vec<OlderRow> =
        serde_json::from_slice(&std::fs::read(&agents.path).unwrap()).unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(agents.list().unwrap(), rows);
    assert_eq!(agents.get(&agent.pubkey, OTHER).unwrap(), joined);
}

#[test]
fn the_plain_list_older_builds_edit_holds_the_agent_s_name_type_and_rows() {
    const OTHER: &str = "wss://other.example";
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    agents
        .join(&agent.pubkey, RELAY, OTHER, None, &credentials)
        .unwrap();
    // As an older build renames and retypes it, or as a write cut short
    // between the files leaves only the added rows changed.
    let edit = |change: &dyn Fn(&mut Vec<serde_json::Value>)| {
        let mut rows: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(&agents.path).unwrap()).unwrap();
        change(&mut rows);
        std::fs::write(&agents.path, serde_json::to_vec(&rows).unwrap()).unwrap();
    };
    edit(&|rows| {
        rows[0]["name"] = "Bea".into();
        rows[0]["type"] = "plugin/other".into();
    });
    for row in agents.list().unwrap() {
        assert_eq!(
            (row.name.as_str(), row.agent_type.as_str()),
            ("Bea", "plugin/other")
        );
    }
    // An agent an older build imported again where it was added is that row.
    edit(&|rows| {
        let mut again = rows[0].clone();
        again["relay"] = OTHER.into();
        rows.push(again);
    });
    let rows = agents.list().unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|row| row.home.is_none()));
}

#[test]
fn refuses_an_unknown_list_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("identities.json");
    std::fs::write(&path, r#"{"version":99,"agents":[]}"#).unwrap();
    assert!(AppAgents::open(path).list().is_err());
}

#[test]
fn a_join_holds_off_other_apps_until_it_settles() {
    const OTHER: &str = "wss://other.example";
    /// Checks, as this app's Join saves the key, that another app can't take
    /// the keys lock, which its Join or removal of a key waits on.
    struct Contended<'a>(&'a Memory, &'a std::path::Path);
    impl Credentials for Contended<'_> {
        fn read_legacy(&self, source: crate::LegacySource, pubkey: &str) -> Result<Secret> {
            self.0.read_legacy(source, pubkey)
        }
        fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>> {
            self.0.read(id, pubkey)
        }
        fn add(&self, id: &str, key: &Secret) -> Result<()> {
            let lock = std::fs::File::options()
                .write(true)
                .create(true)
                .truncate(false)
                .open(self.1)
                .unwrap();
            assert!(matches!(
                lock.try_lock(),
                Err(std::fs::TryLockError::WouldBlock)
            ));
            self.0.add(id, key)
        }
        fn delete(&self, id: &str, pubkey: &str) -> Result<()> {
            self.0.delete(id, pubkey)
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    let lock = dir.path().join("agents/identities.keys.lock");
    let joined = agents
        .join(
            &agent.pubkey,
            RELAY,
            OTHER,
            None,
            &Contended(&credentials, &lock),
        )
        .unwrap();
    // The other app's Join, once it has the lock, finds it added.
    let other = AppAgents::open(dir.path().join("agents/identities.json"));
    let refused = other.join(&agent.pubkey, RELAY, OTHER, None, &credentials);
    assert!(refused.unwrap_err().contains("already in that community"));
    assert_eq!(agents.list().unwrap(), [agent.clone(), joined.clone()]);
    assert!(joined.read_key(&credentials).is_ok());
}

#[test]
fn a_save_cut_short_leaves_a_new_membership_with_its_key() {
    const OTHER: &str = "wss://other.example";
    // Create, and a Join back to the home as it settles, fail saving the
    // second file after the plain list saved the row.
    for joining_home in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let credentials = Memory::default();
        let (agents, source) = created(dir.path(), &credentials);
        std::fs::write(agents.joined(), "[]").unwrap();
        let prepared = AppAgents::prepare(RELAY, &owner(), "p/t", "Bea").unwrap();
        let auth: Vec<String> =
            serde_json::from_str(&crate::secret::test_attestation(prepared.pubkey())).unwrap();
        let pubkey = if joining_home {
            agents
                .join(&source.pubkey, RELAY, OTHER, None, &credentials)
                .unwrap();
            agents.begin_leave(&source.pubkey, RELAY).unwrap();
            remove(&agents, &source.pubkey, RELAY, &credentials).unwrap();
            agents.forget(&source.pubkey, RELAY).unwrap();
            FAIL_RENAME.set(4);
            let joined = agents
                .join(&source.pubkey, OTHER, RELAY, None, &credentials)
                .unwrap();
            assert!(!joined.joining);
            joined.pubkey
        } else {
            FAIL_RENAME.set(2);
            agents
                .commit(prepared, &auth, &credentials)
                .unwrap()
                .0
                .pubkey
        };
        assert_eq!(FAIL_RENAME.get(), 0);
        let reopened = AppAgents::open(agents.path.clone());
        let saved = reopened.get(&pubkey, RELAY).unwrap();
        assert!(!saved.joining);
        assert!(saved.read_key(&credentials).is_ok());
        let plain: Vec<OlderRow> =
            serde_json::from_slice(&std::fs::read(&agents.path).unwrap()).unwrap();
        assert!(plain.iter().any(|row| row.pubkey == pubkey));
    }
}

#[test]
fn protection_is_committed_with_identity_and_changed_with_revision_and_provider_ownership() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let agents = AppAgents::open(dir.path().join("agents/identities.json"));
    agents.upgrade_protection_storage().unwrap();
    let binding = ProtectionBinding {
        provider: "security.test".into(),
        policy: serde_json::json!({"mode":"human"}),
    };
    agents
        .set_protection_defaults(&owner(), 0, "security.test", Some(binding.policy.clone()))
        .unwrap();
    let prepared = AppAgents::prepare("https://relay.example/", &owner(), "p/t", "Ada").unwrap();
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(prepared.pubkey())).unwrap();
    let (agent, _) = agents.commit(prepared, &auth, &credentials).unwrap();
    assert_eq!(
        agents.get(&agent.pubkey, RELAY).unwrap().protection,
        Some(binding)
    );
    assert_eq!(agent.protection_revision, 1);
    let other = AppAgents::open(agents.path.clone());
    assert!(other
        .set_protection(&agent.pubkey, 1, "other.plugin", None)
        .is_err());
    agents
        .set_protection(
            &agent.pubkey,
            1,
            "security.test",
            Some(serde_json::json!({"mode":"delegate"})),
        )
        .unwrap();
    assert!(other
        .set_protection(&agent.pubkey, 1, "security.test", None)
        .is_err());
    assert!(other
        .set_protection(&agent.pubkey, 2, "bad/plugin", None)
        .is_err());
    assert!(other
        .set_protection(
            &agent.pubkey,
            2,
            "security.test",
            Some(serde_json::json!([]))
        )
        .is_err());
    assert_eq!(
        other.get(&agent.pubkey, RELAY).unwrap().protection_revision,
        2
    );
    other
        .set_protection(&agent.pubkey, 2, "security.test", None)
        .unwrap();
    assert!(agents
        .get(&agent.pubkey, RELAY)
        .unwrap()
        .protection
        .is_none());
    assert!(agent.read_key(&credentials).is_ok());
}

#[test]
fn malformed_saved_protection_never_becomes_an_unprotected_identity() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, _) = created(dir.path(), &credentials);
    let original = serde_json::to_value(agents.list().unwrap()).unwrap();
    for binding in [
        serde_json::json!({"provider":"bad/plugin","policy":{}}),
        serde_json::json!({"provider":"security.test","policy":null}),
    ] {
        let mut saved = original.clone();
        saved[0]["protection"] = binding;
        std::fs::write(&agents.path, saved.to_string()).unwrap();
        assert!(agents.list().is_err());
    }
    let mut saved = original;
    saved[0]["protectionRevision"] = serde_json::json!(9_007_199_254_740_992_u64);
    std::fs::write(&agents.path, saved.to_string()).unwrap();
    assert!(agents.list().is_err());
}

#[test]
fn defaults_are_native_authority_even_for_an_already_prepared_creation_in_another_app() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let path = dir.path().join("agents/identities.json");
    let first = AppAgents::open(path.clone());
    first.upgrade_protection_storage().unwrap();
    let second = AppAgents::open(path);
    let prepared = AppAgents::prepare("https://relay.example/", &owner(), "p/t", "Ada").unwrap();
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(prepared.pubkey())).unwrap();
    first
        .set_protection_defaults(
            &owner(),
            0,
            "security.test",
            Some(serde_json::json!({"mode":"human"})),
        )
        .unwrap();
    assert!(second
        .set_protection_defaults(&owner(), 0, "security.test", None)
        .is_err());
    assert!(second
        .set_protection_defaults(&owner(), 1, "other.plugin", None)
        .is_err());
    let (created, _) = second.commit(prepared, &auth, &credentials).unwrap();
    assert_eq!(created.protection.unwrap().provider, "security.test");
    first
        .set_protection_defaults(&owner(), 1, "security.test", None)
        .unwrap();
    assert!(second
        .protection_defaults(&owner())
        .unwrap()
        .defaults
        .is_none());
    assert_eq!(second.protection_defaults(&owner()).unwrap().revision, 2);
    std::fs::write(first.defaults_path(), "invalid").unwrap();
    let prepared = AppAgents::prepare("https://relay.example/", &owner(), "p/t", "Bea").unwrap();
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(prepared.pubkey())).unwrap();
    assert!(second.commit(prepared, &auth, &credentials).is_err());
}

#[test]
fn failed_credential_creation_cleans_up_even_if_defaults_become_malformed() {
    struct Refuse {
        memory: Memory,
        defaults: PathBuf,
    }
    impl Credentials for Refuse {
        fn read_legacy(&self, source: crate::LegacySource, id: &str) -> Result<Secret> {
            self.memory.read_legacy(source, id)
        }
        fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>> {
            self.memory.read(id, pubkey)
        }
        fn add(&self, _id: &str, _key: &Secret) -> Result<()> {
            std::fs::write(&self.defaults, "invalid").unwrap();
            Err("refused".into())
        }
        fn delete(&self, id: &str, pubkey: &str) -> Result<()> {
            self.memory.delete(id, pubkey)
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let agents = AppAgents::open(dir.path().join("identities.json"));
    let prepared = AppAgents::prepare("wss://relay.example", &owner(), "p/t", "Ada").unwrap();
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(prepared.pubkey())).unwrap();
    let credentials = Refuse {
        memory: Memory::default(),
        defaults: agents.defaults_path(),
    };
    assert!(agents.commit(prepared, &auth, &credentials).is_err());
    assert!(agents.list().unwrap().is_empty());
}

#[test]
fn protection_is_atomic_across_memberships_and_joining_preserves_the_source_policy() {
    const OTHER: &str = "wss://other.example";
    const THIRD: &str = "wss://third.example";
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    agents.upgrade_protection_storage().unwrap();
    let original = serde_json::json!({"mode":"human"});
    agents
        .set_protection(&agent.pubkey, 0, "security.test", Some(original.clone()))
        .unwrap();
    agents
        .join(&agent.pubkey, RELAY, OTHER, None, &credentials)
        .unwrap();
    agents
        .set_protection_defaults(
            &owner(),
            0,
            "security.test",
            Some(serde_json::json!({"mode":"delegate"})),
        )
        .unwrap();
    let third = agents
        .join(&agent.pubkey, OTHER, THIRD, None, &credentials)
        .unwrap();
    assert_eq!(third.protection.as_ref().unwrap().policy, original);
    assert_eq!(third.protection_revision, 1);
    // A Join paused between saving its row and key must receive the same policy.
    let mut saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&agents.path).unwrap()).unwrap();
    saved["agents"][2]["joining"] = true.into();
    std::fs::write(&agents.path, saved.to_string()).unwrap();
    agents
        .set_protection(&agent.pubkey, 1, "security.test", None)
        .unwrap();
    assert!(agents
        .list()
        .unwrap()
        .iter()
        .all(|row| row.protection.is_none() && row.protection_revision == 2));
    assert!(agents
        .set_protection(&agent.pubkey, 1, "security.test", Some(original))
        .is_err());
    saved = serde_json::from_slice(&std::fs::read(&agents.path).unwrap()).unwrap();
    saved["agents"][1]["protectionRevision"] = 1.into();
    std::fs::write(&agents.path, saved.to_string()).unwrap();
    assert!(agents.list().is_err());
}

#[test]
fn protected_identity_envelope_is_sticky_and_ignores_old_membership_sidecars() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    agents.upgrade_protection_storage().unwrap();
    agents
        .set_protection(
            &agent.pubkey,
            0,
            "security.test",
            Some(serde_json::json!({})),
        )
        .unwrap();
    agents
        .join(
            &agent.pubkey,
            RELAY,
            "wss://other.example",
            None,
            &credentials,
        )
        .unwrap();
    agents
        .set_protection(&agent.pubkey, 1, "security.test", None)
        .unwrap();
    std::fs::write(agents.joined(), "malformed stale sidecar").unwrap();
    agents.upgrade().unwrap();
    agents.rename(&agent.pubkey, "Renamed").unwrap();
    assert_eq!(agents.list().unwrap().len(), 2);
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&agents.path).unwrap()).unwrap();
    assert_eq!(saved["version"], PROTECTED_IDENTITIES);
    assert_eq!(saved["agents"].as_array().unwrap().len(), 2);
    // The old plain-list reader cannot silently drop the protection fields.
    assert!(serde_json::from_value::<Vec<OlderRow>>(saved).is_err());
}

#[test]
fn defaults_install_the_old_reader_barrier_before_activation_even_without_agents() {
    for fail_at in [0, 1, 2] {
        let dir = tempfile::tempdir().unwrap();
        let agents = AppAgents::open(dir.path().join("agents/identities.json"));
        agents.upgrade_protection_storage().unwrap();
        FAIL_RENAME.set(fail_at);
        let result = agents.set_protection_defaults(
            &owner(),
            0,
            "security.test",
            Some(serde_json::json!({})),
        );
        assert_eq!(FAIL_RENAME.get(), 0);
        let defaults = agents.protection_defaults(&owner()).unwrap();
        if fail_at == 0 {
            result.unwrap();
            assert!(defaults.defaults.is_some());
        } else {
            assert!(result.is_err());
            assert!(defaults.defaults.is_none());
        }
        {
            let saved: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&agents.path).unwrap()).unwrap();
            assert_eq!(saved["version"], PROTECTED_IDENTITIES);
            agents.upgrade().unwrap();
            assert!(agents.list().unwrap().is_empty());
        }
    }
}

#[test]
fn failed_first_protected_write_preserves_the_previous_identity_policy() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    agents.upgrade_protection_storage().unwrap();
    FAIL_RENAME.set(1);
    assert!(agents
        .set_protection(
            &agent.pubkey,
            0,
            "security.test",
            Some(serde_json::json!({}))
        )
        .is_err());
    let reopened = AppAgents::open(agents.path.clone());
    let saved = reopened.get(&agent.pubkey, RELAY).unwrap();
    assert!(saved.protection.is_none());
    assert_eq!(saved.protection_revision, 0);
    reopened
        .set_protection(
            &agent.pubkey,
            0,
            "security.test",
            Some(serde_json::json!({})),
        )
        .unwrap();
    assert_eq!(
        agents
            .get(&agent.pubkey, RELAY)
            .unwrap()
            .protection_revision,
        1
    );
}

#[test]
fn legacy_split_files_cannot_disagree_about_global_protection() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    let joined = agents
        .join(
            &agent.pubkey,
            RELAY,
            "wss://other.example",
            None,
            &credentials,
        )
        .unwrap();
    let mut home = agent.clone();
    home.protection = Some(ProtectionBinding {
        provider: "security.test".into(),
        policy: serde_json::json!({}),
    });
    home.protection_revision = 1;
    std::fs::write(&agents.path, serde_json::to_vec(&vec![home]).unwrap()).unwrap();
    std::fs::write(agents.joined(), serde_json::to_vec(&vec![joined]).unwrap()).unwrap();
    assert!(agents.list().is_err());
}

#[test]
fn protected_v2_cannot_silently_discard_a_membership_sidecar() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    let joined = agents
        .join(
            &agent.pubkey,
            RELAY,
            "wss://other.example",
            None,
            &credentials,
        )
        .unwrap();
    let mut home = agent.clone();
    home.protection = Some(ProtectionBinding {
        provider: "security.test".into(),
        policy: serde_json::json!({}),
    });
    home.protection_revision = 1;
    let old = serde_json::json!({"version":2,"agents":[home.clone()]});
    std::fs::write(&agents.path, old.to_string()).unwrap();
    std::fs::write(
        agents.joined(),
        serde_json::to_vec(&vec![joined.clone()]).unwrap(),
    )
    .unwrap();
    assert!(agents.list().is_err());
    // A complete version-2 list still ignores represented stale sidecar rows.
    let mut complete = joined;
    complete.protection = home.protection.clone();
    complete.protection_revision = home.protection_revision;
    std::fs::write(
        &agents.path,
        serde_json::json!({"version":2,"agents":[home,complete]}).to_string(),
    )
    .unwrap();
    assert_eq!(agents.list().unwrap().len(), 2);
}

#[test]
fn legacy_v2_with_defaults_cannot_downgrade_the_old_reader_barrier() {
    let dir = tempfile::tempdir().unwrap();
    let agents = AppAgents::open(dir.path().join("identities.json"));
    agents.upgrade_protection_storage().unwrap();
    agents
        .set_protection_defaults(&owner(), 0, "security.test", Some(serde_json::json!({})))
        .unwrap();
    std::fs::write(&agents.path, r#"{"version":2,"agents":[]}"#).unwrap();
    assert!(agents.protection_upgrade_needed().unwrap());
    agents.upgrade_protection_storage().unwrap();
    agents.upgrade().unwrap();
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&agents.path).unwrap()).unwrap();
    assert_eq!(saved["version"], PROTECTED_IDENTITIES);
    assert!(agents
        .protection_defaults(&owner())
        .unwrap()
        .defaults
        .is_some());
}

#[test]
fn protection_writes_require_explicit_storage_upgrade_and_leave_old_data_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    let before = std::fs::read(&agents.path).unwrap();
    assert!(!agents.protection_storage_current().unwrap());
    assert!(!agents.protection_upgrade_needed().unwrap());
    assert!(agents
        .set_protection(
            &agent.pubkey,
            0,
            "security.test",
            Some(serde_json::json!({}))
        )
        .unwrap_err()
        .contains("confirmation"));
    assert!(agents
        .set_protection_defaults(&owner(), 0, "security.test", None)
        .unwrap_err()
        .contains("confirmation"));
    assert_eq!(std::fs::read(&agents.path).unwrap(), before);
    assert!(!agents.defaults_path().exists());
    assert_eq!(agent.read_key(&credentials).unwrap().pubkey(), agent.pubkey);
}

#[test]
fn confirmed_legacy_upgrade_preserves_rows_and_uses_the_highest_deleted_revision() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, mut agent) = created(dir.path(), &credentials);
    agent.protection_revision = 9;
    let mut deleted = agent.clone();
    deleted.relay = "wss://other.example".into();
    deleted.deleted = true;
    deleted.protection_revision = 50;
    let rows = vec![agent.clone(), deleted];
    std::fs::write(
        &agents.path,
        serde_json::json!({"version":3,"agents":rows}).to_string(),
    )
    .unwrap();
    assert!(agents.protection_upgrade_needed().unwrap());
    assert!(agents.rename(&agent.pubkey, "Unconfirmed").is_err());
    agents.upgrade_protection_storage().unwrap();
    assert_eq!(agents.list().unwrap(), rows);
    assert!(!agents.protection_upgrade_needed().unwrap());
    agents
        .set_protection(
            &agent.pubkey,
            9,
            "security.test",
            Some(serde_json::json!({})),
        )
        .unwrap();
    assert_eq!(
        agents
            .get(&agent.pubkey, RELAY)
            .unwrap()
            .protection_revision,
        51
    );
}

#[test]
fn forgetting_the_last_identity_cannot_reuse_its_revision_after_readoption() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    let key = agent.read_key(&credentials).unwrap();
    agents.upgrade_protection_storage().unwrap();
    agents
        .set_protection(
            &agent.pubkey,
            0,
            "security.test",
            Some(serde_json::json!({"mode":"old"})),
        )
        .unwrap();
    let stale_revision = agents
        .get(&agent.pubkey, RELAY)
        .unwrap()
        .protection_revision;
    agents.begin_delete(&agent.pubkey).unwrap();
    remove(&agents, &agent.pubkey, RELAY, &credentials).unwrap();
    agents.forget(&agent.pubkey, RELAY).unwrap();
    assert!(agents.list().unwrap().is_empty());
    let reopened = AppAgents::open(agents.path.clone());
    reopened
        .set_protection_defaults(
            &owner(),
            0,
            "security.test",
            Some(serde_json::json!({"mode":"new"})),
        )
        .unwrap();
    let prepared = AppAgents::adopt(RELAY, &owner(), "p/t", key, "Ada", None, None).unwrap();
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(prepared.pubkey())).unwrap();
    let (new, _) = reopened.commit(prepared, &auth, &credentials).unwrap();
    assert!(new.protection_revision > stale_revision);
    assert_eq!(
        new.protection.as_ref().unwrap().policy,
        serde_json::json!({"mode":"new"})
    );
    assert!(reopened
        .set_protection(&new.pubkey, stale_revision, "security.test", None)
        .is_err());
}

#[test]
fn protected_clock_rejects_missing_invalid_or_exhausted_state_without_partial_writes() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, mut agent) = created(dir.path(), &credentials);
    agent.protection_revision = 5;
    for clock in [
        serde_json::Value::Null,
        serde_json::json!(-1),
        serde_json::json!(4),
        serde_json::json!(1.5),
        serde_json::json!(9_007_199_254_740_992_u64),
    ] {
        let saved =
            serde_json::json!({"version":4,"agents":[agent.clone()],"protectionClock":clock});
        std::fs::write(&agents.path, saved.to_string()).unwrap();
        assert!(agents.list().is_err());
    }
    let saved = serde_json::json!({"version":4,"agents":[agent.clone()],"protectionClock":MAX_PROTECTION_REVISION});
    std::fs::write(&agents.path, saved.to_string()).unwrap();
    let before = std::fs::read(&agents.path).unwrap();
    assert!(agents
        .set_protection(&agent.pubkey, 5, "security.test", None)
        .unwrap_err()
        .contains("exhausted"));
    assert_eq!(std::fs::read(&agents.path).unwrap(), before);
    // Defaults and ordinary edits preserve the same exhausted clock; they do not allocate.
    agents
        .set_protection_defaults(&owner(), 0, "security.test", None)
        .unwrap();
    agents.rename(&agent.pubkey, "Renamed").unwrap();
    assert_eq!(
        agents.read().unwrap().1.protection_clock,
        MAX_PROTECTION_REVISION
    );
}
