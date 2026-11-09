use super::{authorization::Authorization, *};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::Manager;

const SERVICE: &str = "xyz.block.buzz.desktop.external-app-pairing.v1";
const LIFETIME: u64 = 30 * 24 * 60 * 60;
static LOCK: Mutex<()> = Mutex::new(());
static REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub(super) fn revision() -> u64 {
    REVISION.load(Ordering::SeqCst)
}

pub(super) fn begin(shared: &Shared, expected_revision: u64) -> Result<(), String> {
    let _lock = LOCK.lock().map_err(|_| "Pairing storage is busy")?;
    if revision() != expected_revision || shared.stop.is_cancelled() {
        return Err("Buzz approval is cancelled".into());
    }
    shared.pairing_pending.store(true, Ordering::SeqCst);
    Ok(())
}

fn publish(shared: &Shared, grant: Grant, expected_revision: u64) -> Result<(), String> {
    // The caller holds LOCK so revoke cannot split the save from publication.
    if revision() != expected_revision || shared.stop.is_cancelled() {
        return Err("Buzz approval is cancelled".into());
    }
    *shared
        .pairing
        .lock()
        .map_err(|_| "Pairing state unavailable")? = Some(grant);
    shared.pairing_pending.store(false, Ordering::SeqCst);
    Ok(())
}

fn cancel_servers(servers: &HostMcpServers) {
    for entry in servers.registry().entries.values() {
        if entry.shared.pairing_pending.load(Ordering::SeqCst)
            || entry
                .shared
                .pairing
                .lock()
                .map_or(true, |pairing| pairing.is_some())
        {
            entry.shared.stop.cancel();
        }
    }
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Approval {
    pub client: String,
    pub viewer: String,
    pub agent: String,
    pub community: String,
    pub scopes: Vec<String>,
}

impl Approval {
    // New approvals grant full agent access only. Saved narrow approvals still load and renew, but
    // grant no tools, so they never widen without new consent.
    fn valid_scopes(&self) -> bool {
        self.scopes == ["agent"]
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Grant {
    #[serde(skip)]
    account: PathBuf,
    pub id: String,
    secret: String,
    pub approval: Approval,
    pub expires_at: u64,
    counter: u64,
    state: String,
}

impl Grant {
    pub fn active(&self) -> Result<(), String> {
        self.check_current(load(&self.account)?.as_ref(), now()?)
    }
    fn check_current(&self, current: Option<&Grant>, now: u64) -> Result<(), String> {
        let current = current.ok_or("Buzz approval is revoked")?;
        if current.id != self.id
            || current.secret != self.secret
            || current.expires_at < self.expires_at
            || current.approval != self.approval
            || current.expires_at <= now
        {
            return Err("Buzz approval is revoked or expired".into());
        }
        Ok(())
    }
    fn reserve(&mut self, request: &Authorization) -> Result<(), String> {
        self.reserve_at(request, now()?)
    }
    fn reserve_at(&mut self, request: &Authorization, now: u64) -> Result<(), String> {
        self.check(request, now)?;
        let counter = request
            .resume
            .as_ref()
            .ok_or("Missing pairing proof")?
            .counter;
        if counter == 0 || counter > 999_999_999_999_999 || counter <= self.counter {
            return Err("Pairing request is already used".into());
        }
        self.counter = counter;
        self.state = request.state.clone();
        Ok(())
    }
    fn renew(&mut self, request: &Authorization, now: u64) -> Result<(), String> {
        self.check(request, now)?;
        let resume = request.resume.as_ref().ok_or("Missing pairing proof")?;
        if request.approval.as_ref() != Some(&self.approval)
            || self.counter != resume.counter
            || self.state != request.state
        {
            return Err("Buzz approval does not match this connection".into());
        }
        let expires_at = now
            .checked_add(LIFETIME)
            .filter(|expires_at| *expires_at >= self.expires_at)
            .ok_or("Cannot renew approval with this clock")?;
        self.expires_at = expires_at;
        Ok(())
    }
    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({"id": self.id, "approval": self.approval, "expires_at": self.expires_at})
    }
    pub fn descriptor(&self) -> serde_json::Value {
        serde_json::json!({"id": self.id, "secret": self.secret, "approval": self.approval, "expires_at": self.expires_at, "counter": self.counter})
    }
    fn mac(&self, value: serde_json::Value) -> Result<Hmac<Sha256>, String> {
        let key = URL_SAFE_NO_PAD
            .decode(&self.secret)
            .map_err(|_| "Invalid saved pairing")?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&key).map_err(|_| "Invalid saved pairing")?;
        mac.update(value.to_string().as_bytes());
        Ok(mac)
    }
    fn check(&self, request: &Authorization, now: u64) -> Result<(), String> {
        let resume = request.resume.as_ref().ok_or("Missing pairing proof")?;
        let proof = URL_SAFE_NO_PAD
            .decode(&resume.proof)
            .map_err(|_| "Invalid pairing proof")?;
        if self.id != resume.id || self.expires_at <= now {
            return Err("Buzz approval is revoked or expired".into());
        }
        self.mac(serde_json::json!([
            "buzz-resume-request-v1",
            self.id,
            resume.counter,
            request.callback,
            request.state,
            request.code_challenge
        ]))?
        .verify_slice(&proof)
        .map_err(|_| "Invalid pairing proof".into())
    }
    pub fn response_proof(
        &self,
        request: &Authorization,
        code: &str,
        endpoint: &str,
    ) -> Result<String, String> {
        Ok(URL_SAFE_NO_PAD.encode(
            self.mac(serde_json::json!([
                "buzz-resume-response-v1",
                self.id,
                self.counter,
                request.state,
                code,
                endpoint
            ]))?
            .finalize()
            .into_bytes(),
        ))
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Resume {
    pub id: String,
    pub counter: u64,
    pub proof: String,
}

fn now() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .map_err(|_| "Cannot read the pairing clock".into())
}

fn account<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|_| "Cannot resolve pairing storage".into())
}

fn account_id(path: &Path) -> String {
    format!("{:x}", Sha256::digest(path.as_os_str().as_encoded_bytes()))
}

fn lock(path: &Path) -> Result<std::fs::File, String> {
    std::fs::create_dir_all(path).map_err(|_| "Cannot open pairing storage")?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.join(".external-app-pairing.lock"))
        .map_err(|_| "Cannot open pairing storage")?;
    fs2::FileExt::try_lock_exclusive(&file).map_err(|_| "Pairing storage is busy")?;
    Ok(file)
}

pub(crate) fn revoke(path: &Path) -> Result<(), String> {
    let _lock = LOCK.lock().map_err(|_| "Pairing storage is busy")?;
    let _file = lock(path)?;
    clear(path)
}

fn load(account: &Path) -> Result<Option<Grant>, String> {
    match buzz_credential_store::read(SERVICE, &account_id(account)) {
        Ok(bytes) => {
            let mut grant: Grant =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid saved pairing")?;
            let opaque = |value: &str| {
                URL_SAFE_NO_PAD
                    .decode(value)
                    .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == value)
            };
            if bytes.len() > 8192
                || !opaque(&grant.id)
                || !opaque(&grant.secret)
                || grant.counter > 999_999_999_999_999
            {
                return Err("Invalid saved pairing".into());
            }
            grant.account = account.into();
            Ok(Some(grant))
        }
        Err(buzz_credential_store::Error::Absent) => Ok(None),
        Err(_) => Err("Cannot read the saved Buzz approval".into()),
    }
}
fn save(account: &Path, grant: &Grant) -> Result<(), String> {
    let bytes =
        zeroize::Zeroizing::new(serde_json::to_vec(grant).map_err(|_| "Cannot encode pairing")?);
    buzz_credential_store::replace(SERVICE, &account_id(account), &bytes)
        .map_err(|_| "Cannot save the Buzz approval".into())
}
fn clear(account: &Path) -> Result<(), String> {
    match buzz_credential_store::delete(SERVICE, &account_id(account)) {
        Ok(()) | Err(buzz_credential_store::Error::Absent) => Ok(()),
        Err(_) => Err("Cannot revoke the saved Buzz approval".into()),
    }
}

pub(super) fn authorize<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: &Authorization,
    expected_revision: u64,
    shared: &Shared,
) -> Result<Option<Grant>, String> {
    let _lock = LOCK.lock().map_err(|_| "Pairing storage is busy")?;
    if revision() != expected_revision {
        return Err("Buzz approval is cancelled".into());
    }
    let account = account(app)?;
    let _file = lock(&account)?;
    match (&request.approval, &request.resume) {
        (None, None) => Ok(None),
        (Some(approval), resume) => {
            if resume.is_some() {
                let mut grant = load(&account)?.ok_or("Buzz approval is revoked")?;
                grant.renew(request, now()?)?;
                save(&account, &grant)?;
                publish(shared, grant.clone(), expected_revision)?;
                return Ok(Some(grant));
            }
            let pubkey = |value: &str| {
                value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            };
            if approval.client.is_empty()
                || approval.client.len() > 80
                || !pubkey(&approval.viewer)
                || approval.agent.len() > 600
                || !approval.agent.get(..64).is_some_and(pubkey)
                || !approval.valid_scopes()
                || url::Url::parse(&approval.community).is_err()
            {
                return Err("Invalid Buzz approval".into());
            }
            let secret = || {
                let mut bytes = [0; 32];
                getrandom::fill(&mut bytes).map_err(|_| "Cannot create a pairing")?;
                Ok::<_, String>(URL_SAFE_NO_PAD.encode(bytes))
            };
            let grant = Grant {
                account: account.clone(),
                id: secret()?,
                secret: secret()?,
                approval: approval.clone(),
                expires_at: now()? + LIFETIME,
                counter: 0,
                state: String::new(),
            };
            save(&account, &grant)?;
            publish(shared, grant.clone(), expected_revision)?;
            Ok(Some(grant))
        }
        _ => Err("Missing Buzz approval".into()),
    }
}

pub(super) async fn forward(shared: &Shared, event: McpEvent) -> Result<(), String> {
    let grant = shared
        .pairing
        .lock()
        .map_err(|_| "Pairing state unavailable")?
        .clone();
    let Some(grant) = grant else {
        return shared
            .events
            .send(event)
            .map_err(|_| "The page is unavailable".into());
    };
    let stop = shared.stop.clone();
    let events = shared.events.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = LOCK.lock().map_err(|_| "Pairing storage is busy")?;
        if stop.is_cancelled() {
            return Err("MCP session is closed".into());
        }
        let _file = lock(&grant.account)?;
        grant.active()?;
        events
            .send(event)
            .map_err(|_| "The page is unavailable".into())
    })
    .await
    .map_err(|_| "Cannot check Buzz approval")?
}

#[tauri::command]
pub(crate) async fn plugin_host_mcp_pairing<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    manager: tauri::State<'_, PluginManager>,
    servers: tauri::State<'_, HostMcpServers>,
    id: String,
    revision: String,
    operation: String,
    request: Option<Authorization>,
) -> Result<Option<serde_json::Value>, String> {
    if id != "buzz.agents" {
        return Err("Only Agents can manage external approval".into());
    }
    let granted = with_manager(manager, move |manager| {
        Ok(manager.host_grants(&id, &revision)?.mcp)
    })
    .await?;
    if !granted {
        return Err("MCP servers are not declared".into());
    }
    let servers = servers.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = LOCK.lock().map_err(|_| "Pairing storage is busy")?;
        let account = account(&app)?;
        let _file = lock(&account)?;
        if operation == "revoke" {
            REVISION.fetch_add(1, Ordering::SeqCst);
            clear(&account)?;
            cancel_servers(&servers);
            return Ok(None);
        }
        let Some(mut grant) = load(&account)? else {
            return Ok(None);
        };
        if grant.expires_at <= now()? {
            clear(&account)?;
            return Ok(None);
        }
        match operation.as_str() {
            "get" => {}
            "resume" => {
                let request = request.ok_or("Missing pairing request")?;
                super::authorization::callback(&request)?;
                grant.reserve(&request)?;
                save(&account, &grant)?;
            }
            _ => return Err("Unknown pairing operation".into()),
        }
        Ok(Some(grant.public()))
    })
    .await
    .map_err(|_| "Cannot check Buzz approval")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_approvals_grant_only_full_agent_access() {
        let mut approval = grant().approval;
        approval.scopes = vec!["agent".into()];
        assert!(approval.valid_scopes());
        for scopes in [
            vec![],
            vec!["read"],
            vec!["read", "post"],
            vec!["create"],
            vec!["read", "post", "create"],
            vec!["agent", "read"],
            vec!["agent", "agent"],
            vec!["manage"],
        ] {
            approval.scopes = scopes.iter().map(|scope| (*scope).into()).collect();
            assert!(!approval.valid_scopes(), "{scopes:?}");
        }
    }

    fn grant() -> Grant {
        Grant {
            account: "test-only".into(),
            id: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk".into(),
            secret: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc".into(),
            approval: Approval {
                client: "Test client".into(),
                viewer: "a".repeat(64),
                agent: "b".repeat(64),
                community: "https://example.test".into(),
                scopes: vec!["read".into()],
            },
            expires_at: u64::MAX,
            counter: 0,
            state: String::new(),
        }
    }
    fn request() -> Authorization {
        Authorization {
            callback: "http://127.0.0.1:1234/buzz/authorize".into(),
            state: "A".repeat(43),
            code_challenge: format!("{}A", "B".repeat(42)),
            approval: None,
            resume: Some(Resume {
                id: grant().id,
                counter: 1,
                proof: "qH9judhRwAJ50VJGXgDjDqeicXa4Lo7qUERD1PNzOnM".into(),
            }),
        }
    }

    fn renewal_request(saved: &Grant, counter: u64) -> Authorization {
        let mut request = request();
        request.approval = Some(saved.approval.clone());
        let proof = saved
            .mac(serde_json::json!([
                "buzz-resume-request-v1",
                saved.id,
                counter,
                request.callback,
                request.state,
                request.code_challenge
            ]))
            .unwrap()
            .finalize()
            .into_bytes();
        request.resume.as_mut().unwrap().counter = counter;
        request.resume.as_mut().unwrap().proof = URL_SAFE_NO_PAD.encode(proof);
        request
    }

    #[tokio::test]
    async fn revoke_cancels_pending_and_published_approval_without_closing_other_servers() {
        let servers = HostMcpServers::default();
        let serve = |plugin: &str| {
            let info = servers
                .serve(
                    servers.page(),
                    plugin.into(),
                    Channel::new(|_| Ok(())),
                    false,
                )
                .unwrap();
            servers.owned(plugin, info.handle).unwrap()
        };
        let pending = serve("buzz.agents");
        let published = serve("buzz.agents");
        let legacy = serve("buzz.agents");
        let generic = serve("other-plugin");
        let expected_revision = revision();
        begin(&pending, expected_revision).unwrap();
        begin(&published, expected_revision).unwrap();
        {
            let _lock = LOCK.lock().unwrap();
            publish(&published, grant(), expected_revision).unwrap();
            assert!(pending.pairing.lock().unwrap().is_none());
            REVISION.fetch_add(1, Ordering::SeqCst);
            cancel_servers(&servers);
            assert!(pending.stop.is_cancelled());
            assert!(published.stop.is_cancelled());
            assert!(!legacy.stop.is_cancelled());
            assert!(!generic.stop.is_cancelled());
            assert!(publish(&pending, grant(), expected_revision).is_err());
            assert!(pending.pairing.lock().unwrap().is_none());
        }
        servers.stop_all();
    }

    #[tokio::test]
    async fn cancelled_server_cannot_publish_approval_at_the_current_revision() {
        let servers = HostMcpServers::default();
        let info = servers
            .serve(
                servers.page(),
                "buzz.agents".into(),
                Channel::new(|_| Ok(())),
                false,
            )
            .unwrap();
        let shared = servers.owned("buzz.agents", info.handle).unwrap();
        let _lock = LOCK.lock().unwrap();
        let expected_revision = revision();
        shared.stop.cancel();
        assert!(publish(&shared, grant(), expected_revision).is_err());
        assert!(shared.pairing.lock().unwrap().is_none());
        servers.stop_all();
    }

    #[test]
    fn valid_reconnects_renew_the_same_approval_for_thirty_days() {
        let mut saved = grant();
        saved.expires_at = 3_592_000;
        let initial = saved.clone();
        for (counter, now, expected_expiry) in [
            (1, 2_728_000, 5_320_000),
            (2, 4_456_000, 7_048_000),
            (3, 6_184_000, 8_776_000),
        ] {
            let request = renewal_request(&saved, counter);
            let previous = saved.clone();
            saved.reserve_at(&request, now).unwrap();
            assert_eq!(saved.expires_at, previous.expires_at);
            saved.renew(&request, now).unwrap();
            assert_eq!(saved.expires_at, expected_expiry);
            assert_eq!(saved.counter, counter);
            assert_eq!(saved.id, initial.id);
            assert_eq!(saved.secret, initial.secret);
            assert!(saved.approval == initial.approval);
            assert!(previous.check_current(Some(&saved), now).is_ok());
        }
        assert!(initial.check_current(Some(&saved), 6_184_000).is_ok());
        assert!(saved.check_current(Some(&initial), 2_728_000).is_err());
        assert!(initial.check_current(None, 6_184_000).is_err());
    }

    #[test]
    fn renewal_refuses_expired_approval_and_invalid_connection_context() {
        let mut saved = grant();
        saved.expires_at = 3_592_000;
        let request = renewal_request(&saved, 1);
        saved.reserve_at(&request, 2_728_000).unwrap();
        for field in [
            "expired",
            "expiry",
            "proof",
            "viewer",
            "agent",
            "community",
            "scopes",
            "counter",
            "state",
            "clock",
        ] {
            let mut candidate = saved.clone();
            let mut request = request.clone();
            let mut now = 2_728_000;
            match field {
                "expired" => now = 3_592_001,
                "expiry" => now = 3_592_000,
                "proof" => request.resume.as_mut().unwrap().proof = "A".repeat(43),
                "viewer" => request.approval.as_mut().unwrap().viewer = "c".repeat(64),
                "agent" => request.approval.as_mut().unwrap().agent = "d".repeat(64),
                "community" => {
                    request.approval.as_mut().unwrap().community = "https://other.test".into()
                }
                "scopes" => request
                    .approval
                    .as_mut()
                    .unwrap()
                    .scopes
                    .push("post".into()),
                "counter" => candidate.counter = 2,
                "state" => candidate.state = "D".repeat(43),
                _ => now = 999_999,
            }
            assert!(candidate.renew(&request, now).is_err(), "{field}");
            assert_eq!(candidate.expires_at, saved.expires_at, "{field}");
        }
        assert!(saved
            .reserve_at(&renewal_request(&saved, 2), 3_592_000)
            .is_err());
    }

    #[test]
    fn storage_lock_excludes_other_handles_and_releases_on_close() {
        let directory = tempfile::tempdir().unwrap();
        let first = lock(directory.path()).unwrap();
        assert!(lock(directory.path()).is_err());
        drop(first);
        assert!(lock(directory.path()).is_ok());
    }

    #[test]
    fn reconnect_reserves_a_counter_and_retains_it_across_restart() {
        let mut saved = grant();
        saved.reserve(&request()).unwrap();
        let bytes = serde_json::to_vec(&saved).unwrap();
        let mut restored: Grant = serde_json::from_slice(&bytes).unwrap();
        assert!(restored
            .reserve(&request())
            .unwrap_err()
            .contains("already used"));
        assert_eq!(restored.approval.scopes, ["read"]);
        let mut next = request();
        next.resume.as_mut().unwrap().counter = 3;
        let proof = saved
            .mac(serde_json::json!([
                "buzz-resume-request-v1",
                saved.id,
                3,
                next.callback,
                next.state,
                next.code_challenge
            ]))
            .unwrap()
            .finalize()
            .into_bytes();
        next.resume.as_mut().unwrap().proof = URL_SAFE_NO_PAD.encode(proof);
        restored.reserve(&next).unwrap();
        assert_eq!(restored.counter, 3);
    }

    #[test]
    fn reconnect_proof_binds_each_request_field() {
        for field in ["callback", "state", "challenge", "id", "counter", "proof"] {
            let mut request = request();
            match field {
                "callback" => request.callback = "http://127.0.0.1:1235/buzz/authorize".into(),
                "state" => request.state = "D".repeat(43),
                "challenge" => request.code_challenge = "E".repeat(43),
                "id" => request.resume.as_mut().unwrap().id = "F".repeat(43),
                "counter" => request.resume.as_mut().unwrap().counter = 2,
                _ => request.resume.as_mut().unwrap().proof = "G".repeat(43),
            }
            assert!(grant().reserve(&request).is_err(), "{field}");
        }
    }

    #[test]
    fn response_proof_binds_the_new_endpoint_and_code() {
        let mut grant = grant();
        grant.reserve(&request()).unwrap();
        assert_eq!(
            grant
                .response_proof(
                    &request(),
                    &format!("{}A", "C".repeat(42)),
                    "http://127.0.0.1:4321/authorize/exchange"
                )
                .unwrap(),
            "JWWtY80VOE03eKoROm4OnmnvvtLwrBnQtfwy7GN1PGI"
        );
        assert!(grant.public().get("secret").is_none());
    }

    #[test]
    fn revoked_expired_and_changed_approval_cannot_dispatch() {
        let saved = grant();
        assert!(saved.check_current(Some(&saved), 1_000).is_ok());
        assert!(saved.check_current(None, 1_000).is_err());
        for field in [
            "id",
            "secret",
            "viewer",
            "agent",
            "community",
            "scopes",
            "expiry",
        ] {
            let mut current = saved.clone();
            match field {
                "id" => current.id = "new-grant".into(),
                "secret" => current.secret = "changed".into(),
                "viewer" => current.approval.viewer = "c".repeat(64),
                "agent" => current.approval.agent = "d".repeat(64),
                "community" => current.approval.community = "https://other.test".into(),
                "scopes" => current.approval.scopes.push("post".into()),
                _ => current.expires_at = 0,
            }
            assert!(
                saved.check_current(Some(&current), 1_000).is_err(),
                "{field}"
            );
        }
    }
}
