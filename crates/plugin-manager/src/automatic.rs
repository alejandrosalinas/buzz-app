//! Applies version 2 managed entries that ask for `install` or `update` to be
//! automatic. They take effect only in a policy signed by the build's signer; an
//! unsigned policy's entries arrive here already reduced to recommendations. Only
//! content-pinned versions install: a URL entry's SHA-256 or a Git entry's full
//! commit. An update that changes host access or publisher is left for the person's
//! review, and a plugin Buzz installed or the person removed is never installed
//! automatically again.
use crate::{
    atomic_write, effective_grants, err,
    imports::{self, PreparedImport, RequiredCommit},
    managed::{state, Install, Managed, ManagedPlugin, ManagedSource, ManagedState, Update},
    Catalog, InstallSource, Manager, PluginInfo, Registry, Result,
};
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashSet},
    fs,
    sync::{Arc, Mutex},
};

const RECEIPT: &str = "managed-automatic.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: String,
    pub name: String,
    pub revision: String,
    pub action: Action,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Installed,
    Updated,
}

/// Per app run: one apply at a time, each pinned version tried at most once, and the
/// changes made so far for Settings and the shell to report.
#[derive(Clone, Default)]
pub(crate) struct Session {
    running: Arc<Mutex<()>>,
    attempted: Arc<Mutex<HashSet<String>>>,
    changes: Arc<Mutex<Vec<Change>>>,
}
impl Session {
    pub(crate) fn changes(&self) -> Vec<Change> {
        self.changes.lock().map(|c| c.clone()).unwrap_or_default()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Plan {
    Install,
    Update,
}

fn plan(plugin: &ManagedPlugin, catalog: &Catalog) -> Option<Plan> {
    match state(plugin, catalog) {
        ManagedState::Missing if plugin.install == Install::Automatic => Some(Plan::Install),
        ManagedState::Outdated if plugin.update == Update::Automatic => Some(Plan::Update),
        _ => None,
    }
}

fn pin(plugin: &ManagedPlugin) -> String {
    match &plugin.source {
        ManagedSource::Url { sha256, .. } => format!("{}@{sha256}", plugin.id),
        ManagedSource::Git { commit, path, .. } => format!("{}@{commit}:{path}", plugin.id),
    }
}

/// Whether `managed` has an automatic entry that this run has not tried yet. Cheap
/// enough to ask on every catalog read.
pub(crate) fn due(session: &Session, managed: &Managed, catalog: &Catalog) -> bool {
    let Managed::Ready { plugins, .. } = managed else {
        return false;
    };
    let Ok(attempted) = session.attempted.lock() else {
        return false;
    };
    plugins.iter().any(|entry| {
        plan(&entry.plugin, catalog).is_some() && !attempted.contains(&pin(&entry.plugin))
    })
}

/// Reads the pinned version. The caller's network and Git access apply.
pub(crate) fn fetch(manager: &Manager, plugin: &ManagedPlugin) -> Result<PreparedImport> {
    match &plugin.source {
        ManagedSource::Url { url, sha256 } => {
            imports::prepare_url(url, sha256, imports::download(url)?)
        }
        ManagedSource::Git {
            repository,
            reference,
            commit,
            path,
        } => imports::prepare_git_authorized(
            repository,
            reference,
            Some(path),
            Some(RequiredCommit::parse(commit)?),
            None,
            None,
            None,
            &manager.repository_access(),
        ),
    }
}

pub(crate) fn apply(
    manager: &Manager,
    fetch: &dyn Fn(&Manager, &ManagedPlugin) -> Result<PreparedImport>,
) -> Result<Vec<Change>> {
    let session = &manager.automatic;
    let Ok(_running) = session.running.try_lock() else {
        return Ok(vec![]);
    };
    if manager.external_plugins_paused() {
        return Ok(vec![]);
    }
    let catalog = manager.catalog()?;
    let Managed::Ready { plugins, .. } = manager.managed(&catalog) else {
        return Ok(vec![]);
    };
    if let Err(reason) = record_installed(manager, &plugins, &catalog) {
        eprintln!("Could not record automatically managed plugins: {reason}");
    }
    let mut changes = vec![];
    for entry in plugins {
        let plugin = entry.plugin;
        let Some(plan) = plan(&plugin, &catalog) else {
            continue;
        };
        if !session.attempted.lock().map_err(err)?.insert(pin(&plugin)) {
            continue;
        }
        let installed = catalog.plugins.iter().find(|p| p.manifest.id == plugin.id);
        match apply_one(manager, &plugin, installed, plan, fetch) {
            Ok(Some(change)) => changes.push(change),
            Ok(None) => {}
            Err(reason) => eprintln!("Could not apply managed plugin {}: {reason}", plugin.id),
        }
    }
    if let Ok(mut all) = session.changes.lock() {
        all.extend(changes.iter().cloned());
    }
    Ok(changes)
}

/// Records every installed plugin that an automatic entry names, so an install whose
/// record failed to save is still never repeated once the person removes it.
fn record_installed(
    manager: &Manager,
    plugins: &[crate::managed::ManagedEntry],
    catalog: &Catalog,
) -> Result<()> {
    let ids = plugins
        .iter()
        .filter(|entry| entry.plugin.install == Install::Automatic)
        .filter(|entry| {
            catalog
                .plugins
                .iter()
                .any(|p| p.manifest.id == entry.plugin.id)
        })
        .map(|entry| entry.plugin.id.as_str())
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(());
    }
    let _lock = manager.lock()?;
    let mut receipt = read_receipt(manager)?;
    if ids.iter().all(|id| receipt.contains(*id)) {
        return Ok(());
    }
    receipt.extend(ids.into_iter().map(str::to_owned));
    write_receipt(manager, &receipt)
}

/// `None` when the pinned version must go to the person's review instead, or the
/// plugin or the policy changed while it was being fetched.
fn apply_one(
    manager: &Manager,
    plugin: &ManagedPlugin,
    installed: Option<&PluginInfo>,
    plan: Plan,
    fetch: &dyn Fn(&Manager, &ManagedPlugin) -> Result<PreparedImport>,
) -> Result<Option<Change>> {
    if plan == Plan::Install && read_receipt(manager)?.contains(&plugin.id) {
        return Ok(None);
    }
    let prepared = fetch(manager, plugin)?;
    let path = match &plugin.source {
        ManagedSource::Url { .. } => ".",
        ManagedSource::Git { path, .. } => path,
    };
    let candidate = prepared
        .preview
        .candidates
        .iter()
        .find(|c| c.path == path && c.manifest.id == plugin.id)
        .ok_or("The pinned version is not this plugin")?;
    let expected = match (plan, installed) {
        (Plan::Update, Some(installed)) => {
            let unchanged = effective_grants(candidate.manifest.host.clone().unwrap_or_default())
                == effective_grants(installed.manifest.host.clone().unwrap_or_default());
            if !unchanged || candidate.publisher != installed.publisher {
                return Ok(None);
            }
            Some((installed.revision.clone(), installed.update_source.clone()))
        }
        (Plan::Update, None) => return Ok(None),
        (Plan::Install, _) => None,
    };
    let change = Change {
        id: plugin.id.clone(),
        name: candidate.manifest.name.clone(),
        revision: candidate.revision.clone(),
        action: match plan {
            Plan::Install => Action::Installed,
            Plan::Update => Action::Updated,
        },
    };
    // A fetch can take a minute. Under the registry lock, recheck that the policy
    // still authorizes exactly this operation and that the plugin is as it was.
    let check = |registry: &Registry| -> Result<Option<bool>> {
        if manager.managed_entry(&plugin.id).as_ref() != Some(plugin) {
            return Ok(None);
        }
        let current = registry.installed.get(&plugin.id);
        Ok(match (&expected, current) {
            (None, None) if !read_receipt(manager)?.contains(&plugin.id) => Some(true),
            (Some((revision, source)), Some(current))
                if current.current == *revision
                    && current.current_source == *source
                    && matches!(
                        current.current_source,
                        Some(InstallSource::Git(_) | InstallSource::Url(_))
                    ) =>
            {
                Some(false)
            }
            _ => None,
        })
    };
    let record = || match plan {
        Plan::Install => remember(manager, &plugin.id),
        Plan::Update => Ok(()),
    };
    Ok(prepared
        .install_if(manager, path, check, record)?
        .then_some(change))
}

fn read_receipt(manager: &Manager) -> Result<BTreeSet<String>> {
    match fs::read(manager.root.join(RECEIPT)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(err),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeSet::new()),
        Err(error) => Err(err(error)),
    }
}

fn write_receipt(manager: &Manager, ids: &BTreeSet<String>) -> Result<()> {
    atomic_write(
        &manager.root.join(RECEIPT),
        &serde_json::to_vec(ids).map_err(err)?,
    )
}

/// Records that `id` must not be installed automatically again in this profile. The
/// caller holds the registry lock.
fn remember(manager: &Manager, id: &str) -> Result<()> {
    let mut ids = read_receipt(manager)?;
    if ids.insert(id.to_owned()) {
        write_receipt(manager, &ids)?;
    }
    Ok(())
}

/// [`remember`] for a removal, before the registry drops the plugin. A record that
/// cannot be parsed already stops every automatic install, so the removal goes ahead
/// without it; any other failure stops the removal.
pub(crate) fn remember_removal(manager: &Manager, id: &str) -> Result<()> {
    let bytes = match fs::read(manager.root.join(RECEIPT)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => b"[]".to_vec(),
        Err(error) => return Err(format!("Could not record the removal: {error}")),
    };
    let Ok(mut ids) = serde_json::from_slice::<BTreeSet<String>>(&bytes) else {
        return Ok(());
    };
    if ids.insert(id.to_owned()) {
        write_receipt(manager, &ids)
            .map_err(|reason| format!("Could not record the removal: {reason}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        hash,
        imports::prepare_unsigned_artifact,
        managed::{signature_path, FILE_NAME},
        GitSource,
    };
    use std::{cell::RefCell, collections::HashMap, path::Path};

    const BASE: &str = "https://plugins.example.org/";
    const KEY: &str = "0202020202020202020202020202020202020202020202020202020202020202";
    const OTHER_KEY: &str = "0303030303030303030303030303030303030303030303030303030303030303";

    fn signer() -> String {
        nostr::key::Keys::new(nostr::key::SecretKey::parse(KEY).unwrap())
            .public_key()
            .to_hex()
    }

    struct Fixture {
        home: tempfile::TempDir,
        sources: tempfile::TempDir,
        artifacts: RefCell<HashMap<String, Vec<u8>>>,
        fetched: RefCell<Vec<String>>,
    }
    impl Fixture {
        fn new() -> Self {
            Self {
                home: tempfile::tempdir().unwrap(),
                sources: tempfile::tempdir().unwrap(),
                artifacts: Default::default(),
                fetched: Default::default(),
            }
        }
        fn manager(&self) -> Manager {
            let mut manager =
                Manager::open(Some(self.home.path().to_path_buf()), "default", false).unwrap();
            manager.policy_signer = Some(signer());
            manager
        }
        /// Packs a plugin and serves it; returns its URL entry fields.
        fn artifact(&self, id: &str, code: &str, host: &str) -> (String, String) {
            let dir = self.sources.path().join(hash(code.as_bytes()));
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("manifest.json"),
                format!(r#"{{"id":"{id}","name":"Example {id}","apiVersion":1{host}}}"#),
            )
            .unwrap();
            fs::write(dir.join("plugin.js"), code).unwrap();
            let bytes = prepare_unsigned_artifact(&dir).unwrap();
            let sha256 = hash(&bytes);
            let url = format!("{BASE}{id}-{sha256}.json");
            self.artifacts.borrow_mut().insert(url.clone(), bytes);
            (url, sha256)
        }
        fn policy_path(&self) -> std::path::PathBuf {
            self.home.path().join(FILE_NAME)
        }
        /// Writes the policy unsigned; see [`Self::policy`].
        fn unsigned_policy(&self, entries: &[(&str, &(String, String), &str)]) {
            let plugins = entries
                .iter()
                .map(|(id, (url, sha256), modes)| {
                    format!(r#"{{"id":"{id}","url":"{url}","sha256":"{sha256}"{modes}}}"#)
                })
                .collect::<Vec<_>>()
                .join(",");
            fs::write(
                self.policy_path(),
                format!(r#"{{"version":2,"source":"Example Org","plugins":[{plugins}]}}"#),
            )
            .unwrap();
            let _ = fs::remove_file(signature_path(&self.policy_path()));
        }
        /// Writes the policy signed by the managers' signer.
        fn policy(&self, entries: &[(&str, &(String, String), &str)]) {
            self.unsigned_policy(entries);
            crate::sign_policy(&self.policy_path(), KEY).unwrap();
        }
        fn apply(&self, manager: &Manager) -> Vec<Change> {
            let fetch = |_: &Manager, plugin: &ManagedPlugin| {
                let ManagedSource::Url { url, sha256 } = &plugin.source else {
                    panic!("expected a URL entry");
                };
                self.fetched.borrow_mut().push(url.clone());
                let bytes = self
                    .artifacts
                    .borrow()
                    .get(url)
                    .cloned()
                    .ok_or("HTTP 404")?;
                imports::prepare_url(url, sha256, bytes)
            };
            apply(manager, &fetch).unwrap()
        }
    }
    fn info(manager: &Manager, id: &str) -> Option<PluginInfo> {
        manager
            .catalog()
            .unwrap()
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == id)
    }
    const AUTO: &str = r#","install":"automatic","update":"automatic""#;

    #[test]
    fn installs_once_enabled_and_remembers_a_removal() {
        let fixture = Fixture::new();
        let one = fixture.artifact("example.one", "export function apply() {}", "");
        fixture.policy(&[("example.one", &one, AUTO)]);
        let manager = fixture.manager();
        let changes = fixture.apply(&manager);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].action, Action::Installed);
        assert_eq!(changes[0].name, "Example example.one");
        let installed = info(&manager, "example.one").unwrap();
        assert!(installed.enabled);
        assert_eq!(installed.revision, one.1);
        let Managed::Ready { automatic, .. } = manager.managed(&manager.catalog().unwrap()) else {
            panic!("expected a usable policy");
        };
        assert_eq!(automatic, changes);
        assert!(fixture.apply(&manager).is_empty());

        manager.change("remove", "example.one").unwrap();
        // A later app run, with a fresh session, still leaves it removed.
        let later = fixture.manager();
        let catalog = later.catalog().unwrap();
        assert!(due(&later.automatic, &later.managed(&catalog), &catalog));
        assert!(fixture.apply(&later).is_empty());
        assert!(info(&later, "example.one").is_none());
        assert!(!due(&later.automatic, &later.managed(&catalog), &catalog));
        assert_eq!(fixture.fetched.borrow().len(), 1);
    }

    #[test]
    fn a_plugin_the_person_installed_then_removed_is_not_installed_automatically() {
        let fixture = Fixture::new();
        let one = fixture.artifact("example.one", "export function apply() {}", "");
        fixture.policy(&[("example.one", &one, AUTO)]);
        let manager = fixture.manager();
        let bytes = fixture.artifacts.borrow()[&one.0].clone();
        let prepared = imports::prepare_url(&one.0, &one.1, bytes).unwrap();
        prepared
            .install(&manager, &prepared.preview.token, ".")
            .unwrap();
        manager.change("remove", "example.one").unwrap();
        assert!(fixture.apply(&fixture.manager()).is_empty());
        assert!(info(&manager, "example.one").is_none());
    }

    #[test]
    fn an_unreadable_record_stops_installs_but_not_updates() {
        let fixture = Fixture::new();
        let v1 = fixture.artifact("example.two", "export function apply() {} // 1", "");
        fixture.policy(&[("example.two", &v1, AUTO)]);
        fixture.apply(&fixture.manager());
        let one = fixture.artifact("example.one", "export function apply() {}", "");
        let v2 = fixture.artifact("example.two", "export function apply() {} // 2", "");
        fixture.policy(&[("example.one", &one, AUTO), ("example.two", &v2, AUTO)]);
        fs::write(
            fixture.home.path().join("profiles/default").join(RECEIPT),
            "{",
        )
        .unwrap();
        let manager = fixture.manager();
        let changes = fixture.apply(&manager);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].action, Action::Updated);
        assert!(info(&manager, "example.one").is_none());
        let catalog = manager.catalog().unwrap();
        assert!(!due(
            &manager.automatic,
            &manager.managed(&catalog),
            &catalog
        ));
    }

    #[test]
    fn a_plugin_the_person_changes_during_the_fetch_is_left_alone() {
        let fixture = Fixture::new();
        let v1 = fixture.artifact("example.one", "export function apply() {} // 1", "");
        fixture.policy(&[("example.one", &v1, AUTO)]);
        fixture.apply(&fixture.manager());
        let v2 = fixture.artifact("example.one", "export function apply() {} // 2", "");
        fixture.policy(&[("example.one", &v2, AUTO)]);
        let manager = fixture.manager();
        let bytes = fixture.artifacts.borrow()[&v2.0].clone();
        let fetch = |manager: &Manager, _: &ManagedPlugin| {
            manager.change("remove", "example.one")?;
            imports::prepare_url(&v2.0, &v2.1, bytes.clone())
        };
        assert!(apply(&manager, &fetch).unwrap().is_empty());
        assert!(info(&manager, "example.one").is_none());
    }

    #[test]
    fn updates_to_the_pin_only_while_access_and_publisher_stay_the_same() {
        let fixture = Fixture::new();
        let v1 = fixture.artifact("example.one", "export function apply() {} // 1", "");
        fixture.policy(&[("example.one", &v1, AUTO)]);
        fixture.apply(&fixture.manager());
        let manager = fixture.manager();
        manager.change("disable", "example.one").unwrap();

        let v2 = fixture.artifact("example.one", "export function apply() {} // 2", "");
        fixture.policy(&[("example.one", &v2, AUTO)]);
        let changes = fixture.apply(&manager);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].action, Action::Updated);
        let updated = info(&manager, "example.one").unwrap();
        assert_eq!(updated.revision, v2.1);
        assert!(!updated.enabled, "an update keeps the enabled state");

        let wider = fixture.artifact(
            "example.one",
            "export function apply() {} // 3",
            r#","host":{"files":true}"#,
        );
        fixture.policy(&[("example.one", &wider, AUTO)]);
        assert!(fixture.apply(&manager).is_empty());
        assert_eq!(info(&manager, "example.one").unwrap().revision, v2.1);
        let catalog = manager.catalog().unwrap();
        let Managed::Ready { plugins, .. } = manager.managed(&catalog) else {
            panic!("expected a usable policy");
        };
        assert_eq!(plugins[0].state, ManagedState::Outdated, "left for review");
        assert!(!due(
            &manager.automatic,
            &manager.managed(&catalog),
            &catalog
        ));
    }

    #[test]
    fn review_entries_and_manual_installs_are_left_alone() {
        let fixture = Fixture::new();
        let one = fixture.artifact("example.one", "export function apply() {}", "");
        let two = fixture.artifact("example.two", "export function apply() {}", "");
        fixture.policy(&[
            ("example.one", &one, ""),
            (
                "example.two",
                &two,
                r#","install":"manual","update":"automatic""#,
            ),
        ]);
        let manager = fixture.manager();
        assert!(fixture.apply(&manager).is_empty());
        assert!(fixture.fetched.borrow().is_empty());
        assert!(info(&manager, "example.one").is_none());
        assert!(info(&manager, "example.two").is_none());
    }

    #[test]
    fn a_failed_pin_is_tried_once_per_run() {
        let fixture = Fixture::new();
        let missing = (format!("{BASE}gone.json"), "a".repeat(64));
        fixture.policy(&[("example.one", &missing, AUTO)]);
        let manager = fixture.manager();
        assert!(fixture.apply(&manager).is_empty());
        assert!(fixture.apply(&manager).is_empty());
        assert_eq!(fixture.fetched.borrow().len(), 1);
        assert!(fixture.apply(&fixture.manager()).is_empty());
        assert_eq!(fixture.fetched.borrow().len(), 2, "a new run tries again");
        assert!(!fs::exists(manager.root.join(RECEIPT)).unwrap());
    }

    #[test]
    fn a_publisher_change_is_left_for_review() {
        let fixture = Fixture::new();
        let v1 = fixture.artifact("example.one", "export function apply() {} // 1", "");
        fixture.policy(&[("example.one", &v1, AUTO)]);
        let manager = fixture.manager();
        fixture.apply(&manager);
        let signed = fixture.sources.path().join("signed");
        fs::create_dir_all(&signed).unwrap();
        fs::write(
            signed.join("manifest.json"),
            r#"{"id":"example.one","name":"Example example.one","apiVersion":1}"#,
        )
        .unwrap();
        fs::write(signed.join("plugin.js"), "export function apply() {} // 2").unwrap();
        crate::sign_release(&signed, &"01".repeat(32)).unwrap();
        let v2 = (format!("{BASE}signed.json"), "b".repeat(64));
        fixture.policy(&[("example.one", &v2, AUTO)]);
        let fetch = |_: &Manager, _: &ManagedPlugin| imports::prepare_folder(Path::new(&signed));
        assert!(apply(&manager, &fetch).unwrap().is_empty());
        assert_eq!(info(&manager, "example.one").unwrap().revision, v1.1);
    }

    fn installed(id: &str, origin: &'static str, source: Option<InstallSource>) -> PluginInfo {
        let mut info = crate::managed::tests::installed(id, source, origin);
        info.revision = "0".repeat(64);
        info
    }

    #[test]
    fn a_url_entry_may_replace_a_git_install_but_never_a_folder_or_bundled_one() {
        let url = ManagedPlugin {
            id: "example.one".into(),
            source: ManagedSource::Url {
                url: format!("{BASE}one.json"),
                sha256: "a".repeat(64),
            },
            install: Install::Recommend,
            update: Update::Automatic,
        };
        let git = Some(InstallSource::Git(GitSource {
            repository: "https://github.com/example-org/plugins".into(),
            reference: "main".into(),
            path: ".".into(),
            commit: None,
        }));
        let folder = Some(InstallSource::Folder(
            crate::ReloadSource::folder(std::env::temp_dir(), ".".into()).unwrap(),
        ));
        for (origin, source, expected) in [
            ("external", git.clone(), Some(Plan::Update)),
            ("external", folder, None),
            ("external", None, None),
            ("bundled", git, None),
        ] {
            let plugin = installed("example.one", origin, source);
            let catalog = Catalog {
                profile: "default".into(),
                location: String::new(),
                plugins: vec![plugin],
            };
            assert_eq!(plan(&url, &catalog), expected);
        }
        let review = ManagedPlugin {
            update: Update::Review,
            ..url
        };
        let catalog = Catalog {
            profile: "default".into(),
            location: String::new(),
            plugins: vec![installed(
                "example.one",
                "external",
                Some(InstallSource::Url(crate::UrlSource {
                    url: format!("{BASE}old.json"),
                    sha256: "b".repeat(64),
                })),
            )],
        };
        assert_eq!(plan(&review, &catalog), None);
    }

    fn modes(manager: &Manager) -> (bool, Vec<(Install, Update)>) {
        let Managed::Ready {
            signed, plugins, ..
        } = manager.managed(&manager.catalog().unwrap())
        else {
            panic!("expected a usable policy");
        };
        (
            signed,
            plugins
                .iter()
                .map(|entry| (entry.plugin.install, entry.plugin.update))
                .collect(),
        )
    }

    #[test]
    fn only_a_policy_the_build_signer_signed_installs_or_updates() {
        let fixture = Fixture::new();
        let one = fixture.artifact("example.one", "export function apply() {}", "");
        let manual = r#","install":"manual","update":"automatic""#;
        let entries = [("example.one", &one, AUTO), ("example.two", &one, manual)];
        let advisory = (
            false,
            vec![
                (Install::Recommend, Update::Review),
                (Install::Manual, Update::Review),
            ],
        );
        let manager = fixture.manager();

        fixture.unsigned_policy(&entries);
        assert_eq!(modes(&manager), advisory);
        assert!(fixture.apply(&manager).is_empty());

        fixture.unsigned_policy(&entries);
        crate::sign_policy(&fixture.policy_path(), OTHER_KEY).unwrap();
        assert_eq!(modes(&manager), advisory, "another key");
        assert!(fixture.apply(&fixture.manager()).is_empty());

        fixture.policy(&entries);
        let signed = fs::read_to_string(fixture.policy_path()).unwrap();
        fs::write(fixture.policy_path(), format!("{signed} ")).unwrap();
        assert_eq!(modes(&manager), advisory, "bytes changed after signing");

        let mut unconfigured = fixture.manager();
        unconfigured.policy_signer = None;
        fixture.policy(&entries);
        assert_eq!(modes(&unconfigured), advisory, "no signer in the build");
        assert!(fixture.apply(&unconfigured).is_empty());
        assert!(fixture.fetched.borrow().is_empty());

        let (signed, _) = modes(&manager);
        assert!(signed);
        let manager = fixture.manager();
        assert_eq!(fixture.apply(&manager).len(), 1);
        assert!(info(&manager, "example.one").is_some());
    }

    #[test]
    fn a_policy_that_changes_during_the_fetch_must_still_authorize_the_install() {
        let fixture = Fixture::new();
        let one = fixture.artifact("example.one", "export function apply() {} // 1", "");
        let two = fixture.artifact("example.one", "export function apply() {} // 2", "");
        let bytes = fixture.artifacts.borrow()[&one.0].clone();
        let changes: [&dyn Fn(); 4] = [
            &|| fixture.policy(&[("example.one", &one, r#","update":"automatic""#)]),
            &|| fixture.policy(&[("example.one", &two, AUTO)]),
            &|| fixture.policy(&[]),
            &|| fixture.unsigned_policy(&[("example.one", &one, AUTO)]),
        ];
        for (index, change) in changes.iter().enumerate() {
            fixture.policy(&[("example.one", &one, AUTO)]);
            let manager = fixture.manager();
            let fetch = |_: &Manager, _: &ManagedPlugin| {
                change();
                imports::prepare_url(&one.0, &one.1, bytes.clone())
            };
            assert!(
                apply(&manager, &fetch).unwrap().is_empty(),
                "change {index}"
            );
            assert!(info(&manager, "example.one").is_none(), "change {index}");
        }
    }

    #[test]
    fn an_update_needs_the_same_source_not_just_the_same_bytes() {
        let fixture = Fixture::new();
        let v1 = fixture.artifact("example.one", "export function apply() {} // 1", "");
        fixture.policy(&[("example.one", &v1, AUTO)]);
        fixture.apply(&fixture.manager());
        let v2 = fixture.artifact("example.one", "export function apply() {} // 2", "");
        fixture.policy(&[("example.one", &v2, AUTO)]);
        let manager = fixture.manager();
        let folder = fixture
            .sources
            .path()
            .join(hash(b"export function apply() {} // 1"));
        let bytes = fixture.artifacts.borrow()[&v2.0].clone();
        let fetch = |manager: &Manager, _: &ManagedPlugin| {
            manager.install(&folder)?;
            imports::prepare_url(&v2.0, &v2.1, bytes.clone())
        };
        assert!(apply(&manager, &fetch).unwrap().is_empty());
        let kept = info(&manager, "example.one").unwrap();
        assert_eq!(kept.revision, v1.1, "the same bytes, now from a folder");
        assert!(matches!(kept.update_source, Some(InstallSource::Folder(_))));
    }

    #[test]
    fn an_install_waits_for_a_removal_recorded_during_the_fetch() {
        let fixture = Fixture::new();
        let one = fixture.artifact("example.one", "export function apply() {}", "");
        fixture.policy(&[("example.one", &one, AUTO)]);
        let manager = fixture.manager();
        let bytes = fixture.artifacts.borrow()[&one.0].clone();
        let fetch = |manager: &Manager, _: &ManagedPlugin| {
            let prepared = imports::prepare_url(&one.0, &one.1, bytes.clone())?;
            prepared.install(manager, &prepared.preview.token, ".")?;
            manager.change("remove", "example.one")?;
            imports::prepare_url(&one.0, &one.1, bytes.clone())
        };
        assert!(apply(&manager, &fetch).unwrap().is_empty());
        assert!(info(&manager, "example.one").is_none());
    }

    #[test]
    fn an_installed_plugin_an_automatic_entry_names_is_recorded() {
        let fixture = Fixture::new();
        let one = fixture.artifact("example.one", "export function apply() {}", "");
        fixture.policy(&[("example.one", &one, AUTO)]);
        let manager = fixture.manager();
        let bytes = fixture.artifacts.borrow()[&one.0].clone();
        let prepared = imports::prepare_url(&one.0, &one.1, bytes).unwrap();
        prepared
            .install(&manager, &prepared.preview.token, ".")
            .unwrap();
        assert!(fixture.apply(&manager).is_empty());
        assert!(read_receipt(&manager).unwrap().contains("example.one"));
    }

    #[test]
    fn a_removal_is_recorded_before_it_is_committed() {
        let fixture = Fixture::new();
        let one = fixture.artifact("example.one", "export function apply() {}", "");
        fixture.policy(&[("example.one", &one, AUTO)]);
        let manager = fixture.manager();
        fixture.apply(&manager);
        let receipt = manager.root.join(RECEIPT);
        fs::remove_file(&receipt).unwrap();
        fs::create_dir(&receipt).unwrap();
        let Err(error) = manager.change("remove", "example.one") else {
            panic!("expected the removal to fail");
        };
        assert!(error.contains("Could not record the removal"), "{error}");
        assert!(
            info(&manager, "example.one").is_some(),
            "nothing was removed"
        );

        fs::remove_dir(&receipt).unwrap();
        fs::write(&receipt, "{").unwrap();
        manager.change("remove", "example.one").unwrap();
        assert!(info(&manager, "example.one").is_none());
        assert!(
            fixture.apply(&fixture.manager()).is_empty(),
            "an unreadable record stops installs"
        );
    }

    #[test]
    fn an_automatic_install_is_enabled_and_recorded_with_its_install() {
        let fixture = Fixture::new();
        let one = fixture.artifact("example.one", "export function apply() {}", "");
        fixture.policy(&[("example.one", &one, AUTO)]);
        let manager = fixture.manager();
        fixture.apply(&manager);
        let registry: serde_json::Value =
            serde_json::from_slice(&fs::read(manager.root.join("registry.json")).unwrap()).unwrap();
        assert_eq!(registry["installed"]["example.one"]["enabled"], true);
        assert!(read_receipt(&manager).unwrap().contains("example.one"));
    }
}
