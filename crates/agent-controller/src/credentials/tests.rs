use super::*;
use crate::{config::agent_id, AppAgents, OldStores, PortSource};
use serde_json::json;
use std::sync::Mutex;
const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

#[derive(Default)]
struct Fake {
    entries: Mutex<BTreeMap<(String, String), Vec<u8>>>,
    failure: Mutex<Option<Failure>>,
    calls: Mutex<Vec<(String, String, String)>>,
    lock_root: Mutex<Option<tempfile::TempDir>>,
    bad_write: Mutex<bool>,
}
impl Fake {
    fn put(&self, service: &str, account: &str, bytes: Vec<u8>) {
        self.entries
            .lock()
            .unwrap()
            .insert((service.into(), account.into()), bytes);
    }
    fn get(
        &self,
        operation: &str,
        service: &str,
        account: &str,
    ) -> std::result::Result<Zeroizing<Vec<u8>>, Failure> {
        self.calls
            .lock()
            .unwrap()
            .push((operation.into(), service.into(), account.into()));
        if let Some(error) = *self.failure.lock().unwrap() {
            return Err(error);
        }
        self.entries
            .lock()
            .unwrap()
            .get(&(service.into(), account.into()))
            .cloned()
            .map(Zeroizing::new)
            .ok_or(Failure::Absent)
    }
}
impl Keychain for Fake {
    fn bundle_lock(&self) -> std::result::Result<Box<dyn bundle::BundleLock>, Failure> {
        let mut root = self.lock_root.lock().unwrap();
        let root = root.get_or_insert_with(|| tempfile::tempdir().unwrap());
        bundle_lock::acquire_at(root.path()).map(|lock| Box::new(lock) as _)
    }
    fn replace(
        &self,
        service: &str,
        account: &str,
        bytes: &[u8],
    ) -> std::result::Result<(), Failure> {
        self.calls
            .lock()
            .unwrap()
            .push(("replace".into(), service.into(), account.into()));
        if let Some(error) = *self.failure.lock().unwrap() {
            return Err(error);
        }
        if *self.bad_write.lock().unwrap() {
            return Ok(());
        }
        self.put(service, account, bytes.to_vec());
        Ok(())
    }
    fn delete(&self, service: &str, account: &str) -> std::result::Result<(), Failure> {
        self.calls
            .lock()
            .unwrap()
            .push(("delete".into(), service.into(), account.into()));
        if let Some(error) = *self.failure.lock().unwrap() {
            return Err(error);
        }
        self.entries
            .lock()
            .unwrap()
            .remove(&(service.into(), account.into()))
            .map(|_| ())
            .ok_or(Failure::Absent)
    }
    fn legacy(
        &self,
        service: &str,
        account: &str,
    ) -> std::result::Result<Zeroizing<Vec<u8>>, Failure> {
        self.get("legacy", service, account)
    }
    fn saved(
        &self,
        service: &str,
        account: &str,
    ) -> std::result::Result<Zeroizing<Vec<u8>>, Failure> {
        self.get("saved", service, account)
    }
    fn copy(
        &self,
        previous: &str,
        service: &str,
        account: &str,
    ) -> std::result::Result<(), Failure> {
        match self.get("saved", previous, account) {
            Ok(bytes) => match self.add(service, account, &bytes) {
                Ok(()) | Err(Failure::Occupied) => Ok(()),
                Err(error) => Err(error),
            },
            Err(Failure::Absent) => Ok(()),
            Err(error) => Err(error),
        }
    }
    fn add(&self, service: &str, account: &str, bytes: &[u8]) -> std::result::Result<(), Failure> {
        self.calls
            .lock()
            .unwrap()
            .push(("add".into(), service.into(), account.into()));
        if let Some(error) = *self.failure.lock().unwrap() {
            return Err(error);
        }
        let mut entries = self.entries.lock().unwrap();
        match entries.entry((service.into(), account.into())) {
            std::collections::btree_map::Entry::Occupied(_) => Err(Failure::Occupied),
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(bytes.into());
                Ok(())
            }
        }
    }
}
fn fixture() -> (PlatformCredentials, Arc<Fake>) {
    let keychain = Arc::new(Fake::default());
    (
        PlatformCredentials {
            keychain: keychain.clone(),
            bundle: None,
        },
        keychain,
    )
}
#[test]
fn deletion_is_bound_to_this_apps_exact_credential_and_can_be_retried() {
    let (credentials, fake) = fixture();
    let id = agent_id(PUB, "wss://relay.example");
    let account = format!("agent:{id}");
    fake.put(SERVICE, &account, KEY.as_bytes().to_vec());
    fake.put("buzz-desktop", "secrets", blob());
    assert!(credentials.delete(&id, &"ab".repeat(32)).is_err());
    assert!(fake
        .entries
        .lock()
        .unwrap()
        .contains_key(&(SERVICE.into(), account.clone())));
    credentials.delete(&id, PUB).unwrap();
    credentials.delete(&id, PUB).unwrap();
    assert!(!fake
        .entries
        .lock()
        .unwrap()
        .contains_key(&(SERVICE.into(), account)));
    assert!(fake
        .entries
        .lock()
        .unwrap()
        .contains_key(&("buzz-desktop".into(), "secrets".into())));
}
fn blob() -> Vec<u8> {
    serde_json::to_vec(&json!({format!("agent:{PUB}"):KEY, "identity":"not-the-agent-key"}))
        .unwrap()
}

#[test]
fn production_credential_adapter_selects_exact_legacy_service_and_account() {
    for (source, service, other) in [
        (LegacySource::Installed, "buzz-desktop", "buzz-desktop-dev"),
        (
            LegacySource::Development,
            "buzz-desktop-dev",
            "buzz-desktop",
        ),
    ] {
        let (credentials, fake) = fixture();
        fake.put(service, "secrets", blob());
        fake.put(other, "secrets", b"malformed-other-source".to_vec());
        assert_eq!(credentials.read_legacy(source, PUB).unwrap().pubkey(), PUB);
        assert_eq!(
            *fake.calls.lock().unwrap(),
            vec![("legacy".into(), service.into(), "secrets".into())]
        );
    }
}

#[test]
fn missing_denied_and_malformed_legacy_never_fall_back_or_write() {
    for selected in [LegacySource::Installed, LegacySource::Development] {
        for failure in [
            Some(Failure::Absent),
            Some(Failure::Denied),
            Some(Failure::Busy),
            Some(Failure::Corrupt),
            None,
        ] {
            let (credentials, fake) = fixture();
            *fake.failure.lock().unwrap() = failure;
            fake.put("buzz-desktop", "secrets", blob());
            fake.put("buzz-desktop-dev", "secrets", blob());
            if failure.is_none() {
                fake.put(
                    selected.keyring_service(),
                    "secrets",
                    b"RAW_SECRET_MALFORMED_JSON".to_vec(),
                );
            }
            let error = credentials.read_legacy(selected, PUB).err().unwrap();
            assert!(!error.contains("RAW_SECRET"));
            assert_eq!(
                *fake.calls.lock().unwrap(),
                vec![(
                    "legacy".into(),
                    selected.keyring_service().into(),
                    "secrets".into()
                )]
            );
        }
    }
}

#[test]
fn legacy_blob_rejects_wrong_keys_duplicates_and_unbounded_data() {
    for bytes in [
        b"{}".to_vec(),
        serde_json::to_vec(&json!({"identity":KEY})).unwrap(),
        serde_json::to_vec(&json!({format!("agent:{PUB}"):"0000000000000000000000000000000000000000000000000000000000000002"})).unwrap(),
        format!("{{\"agent:{PUB}\":\"{KEY}\",\"agent:{PUB}\":\"{KEY}\"}}").into_bytes(),
        serde_json::to_vec(&json!({format!("agent:{PUB}"):KEY, "other":12})).unwrap(),
        [blob(), vec![b' '; MAX_BLOB]].concat(),
    ] {
        let (credentials, fake) = fixture();
        fake.put("buzz-desktop", "secrets", bytes);
        assert!(credentials.read_legacy(LegacySource::Installed, PUB).is_err());
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
    }
}

#[test]
fn a_busy_or_unavailable_store_is_a_transient_legacy_human_failure() {
    for failure in [Failure::Busy, Failure::Unavailable] {
        let (credentials, fake) = fixture();
        *fake.failure.lock().unwrap() = Some(failure);
        let error = credentials
            .read_legacy_human(LegacySource::Installed)
            .err()
            .unwrap();
        assert!(error.transient, "{error:?}");
        assert_eq!(error.message, failure.message());
    }
}

#[test]
fn legacy_human_reads_only_the_installed_identity_entry() {
    let human = serde_json::to_vec(&json!({"identity":"nsec-text", format!("agent:{PUB}"):KEY}));
    let human = human.unwrap();
    let agents_only = serde_json::to_vec(&json!({format!("agent:{PUB}"):KEY})).unwrap();
    let duplicate = br#"{"identity":"a","identity":"b"}"#.to_vec();
    let oversized = [human.clone(), vec![b' '; MAX_BLOB]].concat();
    for (bytes, failure, expected) in [
        (Some(human), None, Ok("nsec-text")),
        (Some(agents_only), None, Err("No identity")),
        (None, None, Err("No identity")),
        (Some(duplicate), None, Err("malformed")),
        (Some(oversized), None, Err("malformed")),
        (None, Some(Failure::Denied), Err("denied")),
    ] {
        let (credentials, fake) = fixture();
        *fake.failure.lock().unwrap() = failure;
        if let Some(bytes) = bytes {
            fake.put("buzz-desktop", "secrets", bytes);
        }
        fake.put("buzz-desktop-dev", "secrets", blob());
        match (
            credentials.read_legacy_human(LegacySource::Installed),
            expected,
        ) {
            (Ok(value), Ok(text)) => assert_eq!(value.as_str(), text),
            (Err(error), Err(text)) => {
                assert!(error.message.contains(text), "{error:?}");
                assert!(!error.transient, "{error:?}");
            }
            (result, _) => panic!("unexpected {:?}", result.map(|_| ())),
        }
        // One read of the selected source; nothing is written or deleted.
        assert_eq!(
            *fake.calls.lock().unwrap(),
            vec![("legacy".into(), "buzz-desktop".into(), "secrets".into())]
        );
    }
}

#[test]
fn destination_is_separate_exact_bound_create_only_and_verified() {
    let (credentials, fake) = fixture();
    let id = agent_id(PUB, "wss://relay.example");
    let account = format!("agent:{id}");
    assert!(credentials.read(&id, PUB).unwrap().is_none());
    credentials
        .add(&id, &Secret::parse(KEY, PUB).unwrap())
        .unwrap();
    assert_eq!(*credentials.read(&id, PUB).unwrap().unwrap().hex(), KEY);
    assert!(credentials
        .add(&id, &Secret::parse(KEY, PUB).unwrap())
        .unwrap_err()
        .contains("already exists"));
    // An absent key is looked for under the service before 1.0 too, then
    // read again.
    assert_eq!(
        *fake.calls.lock().unwrap(),
        [
            ("saved", SERVICE),
            ("saved", PREVIOUS_SERVICE),
            ("saved", SERVICE),
            ("add", SERVICE),
            ("saved", SERVICE),
            ("add", SERVICE)
        ]
        .map(|(op, service)| (op.into(), service.into(), account.clone()))
    );
    assert_eq!(fake.entries.lock().unwrap().len(), 1);
    *fake.failure.lock().unwrap() = Some(Failure::Denied);
    assert!(credentials.read(&id, PUB).is_err()); // denied != absent
    *fake.failure.lock().unwrap() = None;
    fake.put(
        "xyz.block.buzz.desktop.agents",
        &account,
        b"0000000000000000000000000000000000000000000000000000000000000002".to_vec(),
    );
    assert!(credentials.read(&id, PUB).is_err()); // never substitute identity
    fake.calls.lock().unwrap().clear();
    assert!(credentials.read("identity", PUB).is_err());
    assert!(credentials.read(&id, &"ab".repeat(32)).is_err());
    assert!(credentials
        .add(
            &agent_id(&"ab".repeat(32), "wss://relay.example"),
            &Secret::parse(KEY, PUB).unwrap()
        )
        .is_err());
    assert!(fake.calls.lock().unwrap().is_empty());
}

#[test]
fn adoption_uses_production_adapter_and_reads_back_create_only_destination() {
    let legacy = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let root = legacy
        .path()
        .join(LegacySource::Development.app_directory())
        .join("agents");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("managed-agents.json"),
        serde_json::to_vec(&json!([
            {"pubkey":PUB, "relay_url":"wss://relay.example", "name":"Fixture"}
        ]))
        .unwrap(),
    )
    .unwrap();
    let (credentials, fake) = fixture();
    fake.put("buzz-desktop-dev", "secrets", blob());
    let old = OldStores {
        harness: dest.path().join("missing.json"),
        data_dir: legacy.path().into(),
    };
    assert_eq!(old.list().agents.len(), 1);
    assert!(fake.calls.lock().unwrap().is_empty());
    let store = AppAgents::open(dest.path().join("identities.json"));
    adopt(&old, &store, &credentials);
    let id = agent_id(PUB, "wss://relay.example");
    let account = format!("agent:{id}");
    assert_eq!(
        *fake.calls.lock().unwrap(),
        vec![
            ("legacy".into(), "buzz-desktop-dev".into(), "secrets".into()),
            (
                "saved".into(),
                "xyz.block.buzz.desktop.agents".into(),
                account.clone()
            ),
            ("saved".into(), PREVIOUS_SERVICE.into(), account.clone()),
            (
                "saved".into(),
                "xyz.block.buzz.desktop.agents".into(),
                account.clone()
            ),
            (
                "add".into(),
                "xyz.block.buzz.desktop.agents".into(),
                account.clone()
            ),
            (
                "saved".into(),
                "xyz.block.buzz.desktop.agents".into(),
                account
            ),
        ]
    );
    let snapshot = store.list().unwrap();
    assert_eq!(snapshot[0].pubkey, PUB);
    assert!(!serde_json::to_string(&snapshot).unwrap().contains(KEY));
}

#[test]
fn default_platform_cannot_access_keychain_in_unit_tests() {
    let credentials = PlatformCredentials::default();
    assert!(credentials
        .read_legacy(LegacySource::Installed, PUB)
        .is_err());
    let id = agent_id(PUB, "wss://relay.example");
    assert!(credentials.read(&id, PUB).is_err());
    assert!(credentials
        .add(&id, &Secret::parse(KEY, PUB).unwrap())
        .is_err());
}

fn bundled(fake: Arc<Fake>) -> PlatformCredentials {
    PlatformCredentials {
        keychain: fake,
        bundle: Some(bundle::Bundle::default()),
    }
}
#[test]
fn bundle_migration_verifies_and_preserves_rollback_then_reopens_with_one_read() {
    let fake = Arc::new(Fake::default());
    let credentials = bundled(fake.clone());
    let ids = [
        agent_id(PUB, "wss://one.example"),
        agent_id(PUB, "wss://two.example"),
    ];
    for id in &ids {
        fake.put(SERVICE, &account(id).unwrap(), KEY.as_bytes().to_vec());
    }
    for id in &ids {
        assert_eq!(*credentials.read(id, PUB).unwrap().unwrap().hex(), KEY);
    }
    for id in &ids {
        assert!(fake
            .entries
            .lock()
            .unwrap()
            .contains_key(&(SERVICE.into(), account(id).unwrap())));
    }
    let reopened = bundled(fake.clone());
    fake.calls.lock().unwrap().clear();
    for _ in 0..2 {
        for id in &ids {
            assert_eq!(*reopened.read(id, PUB).unwrap().unwrap().hex(), KEY);
        }
    }
    assert_eq!(
        *fake.calls.lock().unwrap(),
        vec![("saved".into(), SERVICE.into(), bundle::ACCOUNT.into())]
    );
}
#[test]
fn bundle_denial_is_shared_until_explicit_retry_and_never_falls_back() {
    let fake = Arc::new(Fake::default());
    let credentials = bundled(fake.clone());
    let id = agent_id(PUB, "wss://relay.example");
    fake.put(SERVICE, &account(&id).unwrap(), KEY.as_bytes().to_vec());
    *fake.failure.lock().unwrap() = Some(Failure::Denied);
    assert!(credentials.read(&id, PUB).err().unwrap().contains("denied"));
    *fake.failure.lock().unwrap() = None;
    assert!(credentials.read(&id, PUB).is_err());
    assert_eq!(fake.calls.lock().unwrap().len(), 1);
    credentials.retry();
    assert!(credentials.read(&id, PUB).unwrap().is_some());
}
#[test]
fn bundle_readback_failure_retains_original_and_explicit_retry_migrates() {
    let fake = Arc::new(Fake::default());
    let credentials = bundled(fake.clone());
    let id = agent_id(PUB, "wss://relay.example");
    fake.put(SERVICE, &account(&id).unwrap(), KEY.as_bytes().to_vec());
    *fake.bad_write.lock().unwrap() = true;
    assert!(credentials.read(&id, PUB).is_err());
    assert!(fake
        .entries
        .lock()
        .unwrap()
        .contains_key(&(SERVICE.into(), account(&id).unwrap())));
    *fake.bad_write.lock().unwrap() = false;
    credentials.retry();
    assert!(credentials.read(&id, PUB).unwrap().is_some());
}
#[test]
fn bundle_writers_merge_fresh_and_delete_invalidates_other_session_cache() {
    let fake = Arc::new(Fake::default());
    let one = bundled(fake.clone());
    let two = bundled(fake.clone());
    let ids = [
        agent_id(PUB, "wss://one.example"),
        agent_id(PUB, "wss://two.example"),
    ];
    let key = Secret::parse(KEY, PUB).unwrap();
    one.add(&ids[0], &key).unwrap();
    assert!(two.read(&ids[0], PUB).unwrap().is_some());
    two.add(&ids[1], &key).unwrap();
    assert!(one.read(&ids[1], PUB).unwrap().is_some());
    assert!(one.add(&ids[0], &key).is_err());
    fake.put(SERVICE, &account(&ids[0]).unwrap(), KEY.as_bytes().to_vec());
    one.delete(&ids[0], PUB).unwrap();
    assert!(two.read(&ids[0], PUB).unwrap().is_none());
    assert!(two.read(&ids[1], PUB).unwrap().is_some());
    one.delete(&ids[0], PUB).unwrap();
    assert!(bundled(fake).read(&ids[1], PUB).unwrap().is_some());
}
#[test]
fn corrupt_bundle_never_reads_individual_items_or_writes() {
    let id = agent_id(PUB, "wss://relay.example");
    let account = account(&id).unwrap();
    for bytes in [
        b"not-json".to_vec(),
        format!("{{\"{account}\":\"{KEY}\",\"{account}\":\"{KEY}\"}}").into_bytes(),
        serde_json::to_vec(
            &json!({&account: "0000000000000000000000000000000000000000000000000000000000000002"}),
        )
        .unwrap(),
        serde_json::to_vec(&json!({"human": KEY})).unwrap(),
        vec![b' '; MAX_BLOB + 1],
    ] {
        let fake = Arc::new(Fake::default());
        fake.put(SERVICE, bundle::ACCOUNT, bytes);
        fake.put(SERVICE, &account, KEY.as_bytes().to_vec());
        assert!(bundled(fake.clone()).read(&id, PUB).is_err());
        assert_eq!(
            *fake.calls.lock().unwrap(),
            vec![("saved".into(), SERVICE.into(), bundle::ACCOUNT.into())]
        );
    }
}

#[test]
fn busy_and_corrupt_individual_migration_do_not_poison_other_agents() {
    let fake = Arc::new(Fake::default());
    let credentials = bundled(fake.clone());
    let bad = agent_id(PUB, "wss://bad.example");
    let good = agent_id(PUB, "wss://good.example");
    fake.put(SERVICE, &account(&bad).unwrap(), b"malformed".to_vec());
    fake.put(SERVICE, &account(&good).unwrap(), KEY.as_bytes().to_vec());
    let lock = fake.bundle_lock().unwrap();
    assert!(credentials.read(&good, PUB).is_err());
    drop(lock);
    assert!(credentials.read(&bad, PUB).is_err());
    // No retry reset: the next restore row can still migrate and start.
    assert!(credentials.read(&good, PUB).unwrap().is_some());
}

#[test]
fn rollback_delete_then_reimport_reuses_retained_bundle_without_writing() {
    let legacy = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let root = legacy
        .path()
        .join(LegacySource::Development.app_directory())
        .join("agents");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("managed-agents.json"),
        serde_json::to_vec(&json!([
            {"pubkey": PUB, "name": "Fixture"}
        ]))
        .unwrap(),
    )
    .unwrap();
    let (old_credentials, fake) = fixture();
    fake.put("buzz-desktop-dev", "secrets", blob());
    let path = dest.path().join("identities.json");
    let store = AppAgents::open(path.clone());
    let old = OldStores {
        harness: dest.path().join("missing.json"),
        data_dir: legacy.path().into(),
    };
    adopt(&old, &store, &old_credentials);
    let id = agent_id(PUB, "wss://relay.example");

    // Upgrade migrates the individual credential, retaining the rollback copy.
    let credentials = bundled(fake.clone());
    assert!(credentials.read(&id, PUB).unwrap().is_some());
    drop(credentials);
    // An older Foundation build removes only the individual item and settings.
    old_credentials.delete(&id, PUB).unwrap();
    std::fs::remove_file(&path).unwrap();
    assert!(store.list().unwrap().is_empty());
    assert!(old_credentials.read(&id, PUB).unwrap().is_none());
    let before = fake.entries.lock().unwrap().clone();
    assert!(before.contains_key(&(SERVICE.into(), bundle::ACCOUNT.into())));

    // Re-upgrade takes the actual native import path, not a direct add probe.
    let credentials = bundled(fake.clone());
    fake.calls.lock().unwrap().clear();
    adopt(&old, &store, &credentials);
    assert_eq!(store.list().unwrap().len(), 1);
    assert_eq!(store.list().unwrap()[0].pubkey, PUB);
    assert_eq!(
        *fake.calls.lock().unwrap(),
        vec![
            ("legacy".into(), "buzz-desktop-dev".into(), "secrets".into()),
            ("saved".into(), SERVICE.into(), bundle::ACCOUNT.into()),
        ]
    );
    assert_eq!(*fake.entries.lock().unwrap(), before);
    // Re-import reuses custody; it does not weaken the create-only API.
    assert!(credentials
        .add(&id, &Secret::parse(KEY, PUB).unwrap())
        .is_err());
}

/// Exercise adoption through the real OS adapter with an isolated keychain.
fn adopt(old: &OldStores, store: &AppAgents, credentials: &PlatformCredentials) {
    let (found, key) = old.take(PortSource::Development, PUB, credentials).unwrap();
    let auth: Vec<String> = serde_json::from_str(&crate::secret::test_attestation(PUB)).unwrap();
    let prepared = AppAgents::adopt(
        "wss://relay.example",
        &auth[1],
        "p/t",
        key,
        &found.name,
        found.picture,
        found.about,
    )
    .unwrap();
    store.commit(prepared, &auth, credentials).unwrap();
}

#[test]
fn reads_copy_a_key_saved_before_one_point_oh_and_deletes_remove_both_names() {
    let (credentials, fake) = fixture();
    let id = agent_id(PUB, "wss://relay.example");
    let account = account(&id).unwrap();
    fake.put(PREVIOUS_SERVICE, &account, KEY.as_bytes().to_vec());
    assert_eq!(*credentials.read(&id, PUB).unwrap().unwrap().hex(), KEY);
    let saved = |service: &str| {
        fake.entries
            .lock()
            .unwrap()
            .contains_key(&(service.into(), account.clone()))
    };
    // Copied, and kept for older builds.
    assert!(saved(SERVICE) && saved(PREVIOUS_SERVICE));
    fake.calls.lock().unwrap().clear();
    credentials.delete(&id, PUB).unwrap();
    assert_eq!(
        *fake.calls.lock().unwrap(),
        [("delete", PREVIOUS_SERVICE), ("delete", SERVICE)].map(|(op, service)| (
            op.into(),
            service.into(),
            account.clone()
        ))
    );
    assert!(credentials.read(&id, PUB).unwrap().is_none());
    // A failed read under the previous service is never absence.
    fake.put(PREVIOUS_SERVICE, &account, b"malformed".to_vec());
    assert!(credentials.read(&id, PUB).is_err());
}

#[test]
fn bundle_reads_copy_previous_entries_and_deletes_remove_every_copy() {
    let fake = Arc::new(Fake::default());
    let credentials = bundled(fake.clone());
    let [bundled_id, individual_id, other_id] =
        ["one", "two", "three"].map(|name| agent_id(PUB, &format!("wss://{name}.example")));
    let previous = serde_json::to_vec(&json!({
        account(&bundled_id).unwrap(): KEY,
        account(&other_id).unwrap(): KEY,
    }))
    .unwrap();
    fake.put(PREVIOUS_SERVICE, bundle::ACCOUNT, previous.clone());
    fake.put(
        PREVIOUS_SERVICE,
        &account(&bundled_id).unwrap(),
        KEY.as_bytes().to_vec(),
    );
    fake.put(
        PREVIOUS_SERVICE,
        &account(&individual_id).unwrap(),
        KEY.as_bytes().to_vec(),
    );
    for id in [&bundled_id, &individual_id] {
        assert_eq!(*credentials.read(id, PUB).unwrap().unwrap().hex(), KEY);
    }
    let current = fake.entries.lock().unwrap()[&(SERVICE.into(), bundle::ACCOUNT.into())].clone();
    let current: BTreeMap<String, String> = serde_json::from_slice(&current).unwrap();
    assert_eq!(
        current
            .into_keys()
            .collect::<std::collections::BTreeSet<_>>(),
        [&bundled_id, &individual_id]
            .map(|id| account(id).unwrap())
            .into()
    );
    // The previous bundle and items stay for older builds.
    assert_eq!(
        fake.entries.lock().unwrap()[&(PREVIOUS_SERVICE.into(), bundle::ACCOUNT.into())],
        previous
    );

    credentials.delete(&bundled_id, PUB).unwrap();
    credentials.delete(&individual_id, PUB).unwrap();
    for id in [&bundled_id, &individual_id] {
        assert!(credentials.read(id, PUB).unwrap().is_none());
        assert!(bundled(fake.clone()).read(id, PUB).unwrap().is_none());
    }
    let entries = fake.entries.lock().unwrap().clone();
    let previous: BTreeMap<String, String> =
        serde_json::from_slice(&entries[&(PREVIOUS_SERVICE.into(), bundle::ACCOUNT.into())])
            .unwrap();
    // Only what was deleted is gone; another agent's entry stays.
    assert_eq!(
        previous.keys().collect::<Vec<_>>(),
        [&account(&other_id).unwrap()]
    );
    assert_eq!(
        entries
            .keys()
            .filter(|(_, account)| account != bundle::ACCOUNT)
            .count(),
        0
    );
}

#[test]
fn a_malformed_previous_bundle_fails_only_agents_it_could_hold() {
    let fake = Arc::new(Fake::default());
    let credentials = bundled(fake.clone());
    let [saved, missing] =
        ["one", "two"].map(|name| agent_id(PUB, &format!("wss://{name}.example")));
    fake.put(SERVICE, &account(&saved).unwrap(), KEY.as_bytes().to_vec());
    assert!(credentials.read(&saved, PUB).unwrap().is_some());
    fake.put(PREVIOUS_SERVICE, bundle::ACCOUNT, b"malformed".to_vec());
    assert!(credentials
        .read(&missing, PUB)
        .err()
        .unwrap()
        .contains("malformed"));
    assert!(bundled(fake.clone()).read(&saved, PUB).unwrap().is_some());
    assert!(credentials.read(&saved, PUB).unwrap().is_some());
    // Deleting one fails closed and keeps every copy, rather than leaving the
    // key in a bundle that can't be rewritten.
    assert!(credentials
        .delete(&saved, PUB)
        .unwrap_err()
        .contains("malformed"));
    assert!(credentials.read(&saved, PUB).unwrap().is_some());
    assert_eq!(
        fake.entries.lock().unwrap()[&(PREVIOUS_SERVICE.into(), bundle::ACCOUNT.into())],
        b"malformed"
    );
}
