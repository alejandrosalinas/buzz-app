//! Native custody for agents the app runs through a plugin (Agents). The key
//! and owner attestation never enter the WebView; it asks for one bounded
//! event, read, upload or memory write at a time, and native signs and sends it
//! to the agent's community.
use buzz_agent_controller::{
    inline_picture, AppAgent, AppAgents, Carry, Credentials, OldStores, PlatformCredentials,
    PortSource, Portables, ProtectionBinding, ProtectionDefaults, Published, Removal, Secret,
    CREDENTIALS_BUSY,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::federated_identity::{
    agent::{Admission, AgentTokens, Stamp},
    assertion,
};

/// A NIP-98 `Authorization` header for one signed HTTP auth event.
fn authorization(event: Value) -> Result<String, String> {
    use base64::Engine;
    Ok(format!(
        "Nostr {}",
        base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_vec(&event).map_err(|_| "Could not authorize profile request")?)
    ))
}

const BUSY_WAITS: u32 = 50;
const BUSY_WAIT: std::time::Duration = std::time::Duration::from_millis(100);

/// The identity file (which locks its own writes across app instances) and its
/// own credential handle, so Agents never waits on, or fails with, the harness
/// agent controller (whose storage lock another app may hold).
#[derive(Clone)]
pub(crate) struct AppAgentHost {
    agents: Result<AppAgents, String>,
    /// Earlier agent systems' identities on this machine, which it can take over.
    old: Result<OldStores, String>,
    credentials: Arc<dyn Credentials>,
    /// Each key after its first read, so only create and first use reach the
    /// credential store, whose lock refuses rather than waits. Waiting on this
    /// lock instead lets concurrent publications queue for that first read.
    keys: Arc<Mutex<HashMap<String, Arc<Secret>>>>,
    /// One profile publication per agent at a time, in any of its communities,
    /// so each is newer than the last; Delete takes it too, so no publication
    /// outlives the key.
    profiles: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    removals: Arc<Mutex<Removals>>,
    hosting: Arc<Hosting>,
    /// Each agent's NIP-FI grant and assertions, for an organization's communities.
    tokens: AgentTokens,
    /// Serializes owner prompts, without holding cross-process identity/custody locks.
    protection_upgrade: Arc<Mutex<()>>,
}
impl AppAgentHost {
    /// `packaged` is false for a dev build, which steps aside for a packaged app.
    pub(crate) fn new(
        path: Result<PathBuf, String>,
        old: Result<OldStores, String>,
        packaged: bool,
        tokens: AgentTokens,
    ) -> Self {
        let hosts = path
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|path| Ok(path.parent().ok_or("Invalid agent storage")?.join("hosts")));
        let agents = path.and_then(|path| {
            let agents = AppAgents::open(path);
            if agents.protection_upgrade_needed()? {
                confirm_protection_storage(&agents, &Mutex::new(()), protection_upgrade_dialog)?;
            }
            // So an older build can read the list again.
            if let Err(error) = agents.upgrade() {
                eprintln!("Saved agent identities were not upgraded: {error}");
            }
            Ok(agents)
        });
        let listed = agents.clone();
        tokens.watch(move || {
            Ok(listed
                .clone()?
                .list()?
                .into_iter()
                .map(|agent| (agent.owner, agent.pubkey))
                .collect())
        });
        Self {
            agents,
            old,
            credentials: Arc::new(PlatformCredentials::default()),
            keys: Arc::default(),
            profiles: Arc::default(),
            removals: Arc::default(),
            hosting: Arc::new(Hosting {
                dir: hosts,
                packaged,
                held: Mutex::default(),
            }),
            tokens,
            protection_upgrade: Arc::default(),
        }
    }
    /// The saved identities, for readers outside Agents such as the inventory.
    pub(crate) fn agents(&self) -> Result<AppAgents, String> {
        self.agents.clone()
    }
    fn removals(&self) -> std::sync::MutexGuard<'_, Removals> {
        self.removals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    /// Lets go of the removals the page held, as a new page starts none.
    pub(crate) fn page_load(&self) {
        let mut removals = self.removals();
        removals.page += 1;
        removals.held.clear();
    }
    fn keys(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Secret>>> {
        self.keys
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    fn profile_turn(&self, pubkey: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.profiles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(pubkey.into())
            .or_default()
            .clone()
    }
    /// The agent's key; read from the credential store only on first use. A
    /// busy store (a harness start or another app holding it) is waited out for
    /// a few seconds, without holding up agents whose keys are already read.
    async fn key(&self, agent: AppAgent) -> Result<(AppAgent, Arc<Secret>), String> {
        let host = self.clone();
        blocking(move || {
            let mut waits = 0;
            loop {
                let mut keys = host.keys();
                if let Some(key) = keys.get(&agent.pubkey) {
                    return Ok((agent, key.clone()));
                }
                match agent.read_key(host.credentials.as_ref()) {
                    Err(error) if error == CREDENTIALS_BUSY && waits < BUSY_WAITS => {
                        drop(keys);
                        waits += 1;
                        std::thread::sleep(BUSY_WAIT);
                    }
                    read => {
                        let key = Arc::new(read?);
                        keys.insert(agent.pubkey.clone(), key.clone());
                        return Ok((agent, key));
                    }
                }
            }
        })
        .await
    }
    /// The agent, its key and its organization evidence, for one request.
    pub(crate) async fn signer(
        &self,
        pubkey: String,
        relay: String,
    ) -> Result<(AppAgent, Arc<Secret>, Admission), String> {
        self.signer_for(pubkey, relay, Duration::ZERO).await
    }
    /// As [`Self::signer`], with evidence valid for at least `valid_for`.
    async fn signer_for(
        &self,
        pubkey: String,
        relay: String,
        valid_for: Duration,
    ) -> Result<(AppAgent, Arc<Secret>, Admission), String> {
        let incarnation = self.tokens.stamp(&pubkey, &relay)?;
        self.signer_at(pubkey, relay, incarnation, valid_for).await
    }
    /// The owner's retirements so far, for a local caller's token issued now.
    pub(crate) fn caller_retirements(&self) -> u64 {
        self.tokens.retirements()
    }
    /// Whether the owner's identity was closed for good, so no local caller
    /// may be issued, bound or act again.
    pub(crate) fn caller_closed(&self) -> bool {
        self.tokens.identity_closed()
    }
    /// The agent and its current incarnation, for a local caller's token that
    /// acts as it from now on.
    pub(crate) async fn caller_stamp(
        &self,
        pubkey: String,
        relay: String,
    ) -> Result<(AppAgent, Stamp), String> {
        let incarnation = self.tokens.stamp(&pubkey, &relay)?;
        Ok((self.agent(pubkey, relay).await?, incarnation))
    }
    /// Whether a token issued at [`Self::caller_retirements`] and bound at
    /// [`Self::caller_stamp`] still acts: the agent was not deleted and the
    /// owner did not sign out or change account since.
    pub(crate) fn caller_live(
        &self,
        pubkey: &str,
        relay: &str,
        incarnation: Stamp,
        retirements: u64,
    ) -> bool {
        !self.tokens.identity_closed()
            && self.tokens.retirements() == retirements
            && self.tokens.admits(pubkey, relay, incarnation)
    }
    /// The agent and its key, for a local caller's operation that sends nothing.
    pub(crate) async fn caller_key(
        &self,
        pubkey: String,
        relay: String,
    ) -> Result<(AppAgent, Arc<Secret>), String> {
        self.key(self.agent(pubkey, relay).await?).await
    }
    /// As [`Self::signer_for`], for work stamped earlier with `incarnation`:
    /// deleting the agent since then refuses it.
    pub(crate) async fn signer_at(
        &self,
        pubkey: String,
        relay: String,
        incarnation: Stamp,
        valid_for: Duration,
    ) -> Result<(AppAgent, Arc<Secret>, Admission), String> {
        let (agent, key) = self.key(self.agent(pubkey, relay).await?).await?;
        let evidence = self
            .tokens
            .authorize_for(&agent, &key, incarnation, valid_for)
            .await?;
        Ok((agent, key, evidence))
    }
    /// Saves an imported identity with its key, opening the agent's next
    /// incarnation if it was deleted here before. Work that keeps the returned
    /// agent and key passes the returned incarnation to `evidence`, so a later
    /// deletion refuses it even after another import of the same key.
    async fn install(
        &self,
        prepared: buzz_agent_controller::NewAppAgent,
        auth: Vec<String>,
    ) -> Result<(AppAgent, Arc<Secret>, Stamp), String> {
        let host = self.clone();
        blocking(move || {
            let mut keys = host.keys();
            let (agent, key) =
                host.agents
                    .clone()?
                    .commit(prepared, &auth, host.credentials.as_ref())?;
            let key = Arc::new(key);
            keys.insert(agent.pubkey.clone(), key.clone());
            let incarnation = host.tokens.reopen_row(&agent.pubkey, &agent.relay)?;
            Ok((agent, key, incarnation))
        })
        .await
    }
    /// Uploads an imported agent's inline picture and saves its URL, as the
    /// installation `incarnation` returned by `install`.
    async fn imported_picture(
        &self,
        agent: &AppAgent,
        key: &Secret,
        incarnation: Stamp,
        mime: &str,
        bytes: Vec<u8>,
    ) -> Result<String, String> {
        let agents = self.agents.clone()?;
        let evidence = self.tokens.authorize(agent, key, incarnation).await?;
        let receipt = evidence
            .run(true, upload(agent, key, evidence.header(), bytes, mime))
            .await?;
        let url = receipt["url"].as_str().ok_or("Upload returned no URL")?;
        let (pubkey, relay, picture) = (
            agent.pubkey.clone(),
            agent.relay.clone(),
            Some(url.to_owned()),
        );
        blocking(move || evidence.commit(true, || agents.set_picture(&pubkey, &relay, picture)))
            .await?;
        Ok(url.to_owned())
    }
    /// Deletes its key in the community at `relay` once any profile publication
    /// in flight has settled, so the community's cleanup sees every profile it
    /// will ever have. The row stays, marked deleted, until the WebView has
    /// cleaned up the community and calls `app_agent_forget`. This copy of the
    /// app stops running the agent once it is in no community.
    async fn delete(&self, pubkey: String, relay: String) -> Result<(), String> {
        let page = self.removals().page;
        let turn = self.profile_turn(&pubkey);
        let _turn = turn.lock().await;
        // Its grant goes with its last community. Checked before the removal,
        // so a request in flight is refused rather than outliving the key.
        if self.holds_removal(page, &pubkey, &relay) {
            self.tokens.forget_row(&pubkey, &relay)?;
            if let Some(owner) = self.last_community(&pubkey, &relay).await? {
                self.tokens.forget(&owner, &pubkey).await?;
            }
        }
        let host = self.clone();
        blocking(move || {
            // Held across the deletion, so no publication re-reads the key meanwhile.
            let mut keys = host.keys();
            let agents = host.agents.clone()?;
            let removals = host.removals();
            if removals.page != page {
                return Err("The app reloaded while it was being removed".into());
            }
            let removal = removals
                .held
                .get(&pubkey)
                .filter(|removal| removal.is(&pubkey, &relay))
                .ok_or("Its removal from that community isn't held by this app")?;
            keys.remove(&pubkey);
            agents.remove(removal, host.credentials.as_ref())?;
            drop(removals);
            if !agents
                .list()?
                .iter()
                .any(|agent| agent.pubkey == pubkey && !agent.deleted)
            {
                host.hosting.held().remove(&pubkey);
            }
            Ok(())
        })
        .await
    }
    /// Whether this page holds the agent's removal from the community at `relay`.
    fn holds_removal(&self, page: u64, pubkey: &str, relay: &str) -> bool {
        let removals = self.removals();
        removals.page == page
            && removals
                .held
                .get(pubkey)
                .is_some_and(|removal| removal.is(pubkey, relay))
    }
    /// The agent's owner, if the community at `relay` is the last one where it
    /// has its key.
    async fn last_community(&self, pubkey: &str, relay: &str) -> Result<Option<String>, String> {
        let (host, pubkey, relay) = (self.clone(), pubkey.to_owned(), relay.to_owned());
        blocking(move || {
            let rows = host.agents.clone()?.list()?;
            let live =
                |agent: &&AppAgent| agent.pubkey == pubkey && !agent.deleted && !agent.joining;
            if rows.iter().filter(live).any(|agent| agent.relay != relay) {
                return Ok(None);
            }
            Ok(rows
                .iter()
                .filter(live)
                .find(|agent| agent.relay == relay)
                .map(|agent| agent.owner.clone()))
        })
        .await
    }
    /// The agent in the community at `relay`, if it still has its key there.
    /// One deleted elsewhere loses its cached key.
    async fn agent(&self, pubkey: String, relay: String) -> Result<AppAgent, String> {
        let host = self.clone();
        blocking(move || {
            let agent = host.agents.clone()?.get(&pubkey, &relay);
            if agent.is_err() {
                host.keys().remove(&pubkey);
            }
            agent
        })
        .await
    }
}

#[cfg(test)]
impl AppAgentHost {
    /// A host whose only agent is `agent`, saved at `path`, its key already read.
    pub(crate) fn holding(
        path: PathBuf,
        agent: &AppAgent,
        key: Secret,
        tokens: AgentTokens,
    ) -> Self {
        std::fs::write(&path, serde_json::to_vec(&[agent]).unwrap()).unwrap();
        let host = Self::new(Ok(path), Err("unused".into()), true, tokens);
        host.keys().insert(agent.pubkey.clone(), Arc::new(key));
        host
    }
    /// Saves `agents` in place of the held ones and holds `key` too.
    pub(crate) fn also_holding_for_test(&self, path: PathBuf, agents: &[&AppAgent], key: Secret) {
        std::fs::write(path, serde_json::to_vec(agents).unwrap()).unwrap();
        self.keys().insert(key.pubkey().into(), Arc::new(key));
    }
    /// This host reading keys from `credentials`, its key cache emptied.
    #[cfg(test)]
    pub(crate) fn with_credentials_for_test(mut self, credentials: Arc<dyn Credentials>) -> Self {
        self.credentials = credentials;
        self.keys().clear();
        self
    }
    pub(crate) fn forget_row_for_test(&self, pubkey: &str, relay: &str) {
        self.tokens.forget_row(pubkey, relay).unwrap();
    }
    pub(crate) fn reopen_row_for_test(&self, pubkey: &str, relay: &str) {
        self.tokens.reopen_row(pubkey, relay).unwrap();
    }
    /// Holds every key read until dropped, pausing work that needs a key.
    pub(crate) fn hold_keys_for_test(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Secret>>> {
        self.keys()
    }
}

/// Explicit native owner consent; no plugin argument can approve this upgrade.
fn confirm_protection_storage(
    agents: &AppAgents,
    prompt: &Mutex<()>,
    confirm: impl FnOnce() -> bool,
) -> Result<(), String> {
    let _prompt = prompt
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if agents.protection_storage_current()? {
        return Ok(());
    }
    if !confirm() {
        return Err("Agent storage upgrade cancelled. Saved agents and defaults were left unchanged. Restart Buzz to retry a cancelled startup upgrade.".into());
    }
    agents.upgrade_protection_storage()
}

fn protection_upgrade_dialog() -> bool {
    let result = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title("Upgrade local agents for protection?")
        .set_description("This is a one-way upgrade for ALL agents on this device. Older Buzz builds will no longer be able to list, run or remove any of these agents, even after protection is turned off.\n\nDevelopment Buzz shares these agents with the installed app. Close other Buzz builds before continuing and keep a compatible build installed. Agent identities and keys will be preserved.\n\nCancel leaves the saved files unchanged.")
        .set_buttons(rfd::MessageButtons::OkCancelCustom("Upgrade agents".into(), "Cancel".into()))
        .show();
    // Windows without common-controls-v6 falls back to the standard OK label.
    result == rfd::MessageDialogResult::Ok
        || result == rfd::MessageDialogResult::Custom("Upgrade agents".into())
}

/// Which running copy of the app runs each agent. Every copy on this machine
/// (the packaged app and any dev builds) shares the agent list and hears the
/// same events. The packaged app always runs what it can and holds
/// `<pubkey>.packaged` while it does; there is only ever one, since only a
/// release build with the release identifier counts and it is single-instance.
/// Dev builds step aside while that is held, and
/// otherwise run each agent from whichever holds `<pubkey>.lock`. The OS lets go
/// of both when a copy exits, however it exits.
struct Hosting {
    dir: Result<PathBuf, String>,
    packaged: bool,
    /// The lock file this copy holds per agent: `.packaged` or `.lock`.
    held: Mutex<HashMap<String, File>>,
}
impl Hosting {
    fn held(&self) -> std::sync::MutexGuard<'_, HashMap<String, File>> {
        self.held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    /// Whether this copy runs the agent. The packaged app always does, so a
    /// stuck dev build can never silence it. A dev build takes the agent if no
    /// other copy runs it, and lets go while the packaged app does.
    #[cfg(test)]
    fn claim(&self, pubkey: &str) -> Result<bool, String> {
        self.claim_validated(pubkey, || Ok(()))
    }
    /// Newly acquired custody is provisional until admission is validated.
    /// Validation errors leave an existing shared lock intact.
    #[allow(clippy::incompatible_msrv)] // `File` locking; see `sign_out::Instance`.
    fn claim_validated(
        &self,
        pubkey: &str,
        validate: impl FnOnce() -> Result<(), String>,
    ) -> Result<bool, String> {
        if pubkey.len() != 64
            || !pubkey
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err("Invalid agent".into());
        }
        let dir = self.dir.as_ref().map_err(Clone::clone)?;
        std::fs::create_dir_all(dir).map_err(|_| "Could not open agent hosting")?;
        let packaged = dir.join(format!("{pubkey}.packaged"));
        let mut held = self.held();
        if !self.packaged && !lock(open_lock(&packaged)?.try_lock_shared())? {
            held.remove(pubkey);
            return Ok(false);
        }
        if held.contains_key(pubkey) {
            validate()?;
            return Ok(true);
        }
        let path = if self.packaged {
            packaged
        } else {
            dir.join(format!("{pubkey}.lock"))
        };
        let file = open_lock(&path)?;
        if !lock(file.try_lock())? {
            return Ok(false);
        }
        validate()?;
        held.insert(pubkey.into(), file);
        Ok(true)
    }
    /// Policy writes require this copy's custody and no overlapping dev/packaged host.
    #[allow(clippy::incompatible_msrv)]
    fn protecting<T>(
        &self,
        pubkey: &str,
        change: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let held = self.held();
        if !held.contains_key(pubkey) {
            return Err("Change protection in the Buzz app that runs this agent".into());
        }
        let dir = self.dir.as_ref().map_err(Clone::clone)?;
        let other = open_lock(&dir.join(format!(
            "{pubkey}.{}",
            if self.packaged { "lock" } else { "packaged" }
        )))?;
        if !lock(other.try_lock())? {
            return Err("Quit the other copy of Buzz before changing protection".into());
        }
        // Both hosting locks stay held across the native CAS write.
        change()
    }
}
/// Whether a try at a lock took it; closing the file lets go.
#[allow(clippy::incompatible_msrv)]
fn lock(attempt: Result<(), TryLockError>) -> Result<bool, String> {
    match attempt {
        Ok(()) => Ok(true),
        Err(TryLockError::WouldBlock) => Ok(false),
        Err(TryLockError::Error(_)) => Err("Could not read agent hosting".into()),
    }
}
fn open_lock(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| "Could not open agent hosting lock".to_owned())
}

/// Each agent the page loaded now is taking out of a community; see
/// `AppAgents::hold_removal`.
#[derive(Default)]
struct Removals {
    /// Counts page loads, so a hold taken for an earlier page is let go.
    page: u64,
    held: HashMap<String, Removal>,
}

/// Runs blocking file and credential work off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "Native credential operation failed".to_owned())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppAgentSummary {
    pubkey: String,
    relay: String,
    owner: String,
    #[serde(rename = "type")]
    agent_type: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    picture: Option<String>,
    deleted: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    deleting: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    home: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    joining: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    protection: Option<ProtectionBinding>,
    protection_revision: u64,
}
impl From<AppAgent> for AppAgentSummary {
    fn from(agent: AppAgent) -> Self {
        Self {
            pubkey: agent.pubkey,
            relay: agent.relay,
            owner: agent.owner,
            agent_type: agent.agent_type,
            name: agent.name,
            picture: agent.picture,
            deleted: agent.deleted,
            deleting: agent.deleting,
            home: agent.home,
            joining: agent.joining,
            protection: agent.protection,
            protection_revision: agent.protection_revision,
        }
    }
}

/// A taken-over identity and the settings its old store kept for its new type.
#[derive(Serialize)]
pub(crate) struct Ported {
    agent: AppAgentSummary,
    carry: Carry,
    /// What did not come over, said to the person importing.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    notes: Vec<String>,
}

#[tauri::command]
pub(crate) async fn app_agent_list(
    state: tauri::State<'_, AppAgentHost>,
) -> Result<Vec<AppAgentSummary>, String> {
    let agents = state.agents.clone()?;
    blocking(move || Ok(agents.list()?.into_iter().map(Into::into).collect())).await
}

/// Generates a key for `owner` in `destination`, has the signed-in owner attest
/// it, and saves both. Nothing is saved unless all three succeed.
#[tauri::command]
pub(crate) async fn app_agent_create(
    state: tauri::State<'_, AppAgentHost>,
    identity: tauri::State<'_, crate::identity::IdentityHost>,
    destination: String,
    owner: String,
    agent_type: String,
    name: String,
) -> Result<AppAgentSummary, String> {
    let agents = state.agents.clone()?;
    let prepared = AppAgents::prepare(&destination, &owner, &agent_type, &name)?;
    let auth = identity
        .inner()
        .authorize_agent(owner, prepared.pubkey().to_owned())
        .await?;
    let host = state.inner().clone();
    blocking(move || {
        // Held so no first key read meets this write in the credential store.
        let mut keys = host.keys();
        host.credentials.retry();
        let (agent, key) = agents.commit(prepared, &auth, host.credentials.as_ref())?;
        keys.insert(agent.pubkey.clone(), Arc::new(key));
        Ok(agent.into())
    })
    .await
}

/// Reads the owner's defaults without changing storage.
#[tauri::command]
pub(crate) async fn app_agent_protection_defaults(
    host: tauri::State<'_, AppAgentHost>,
    owner: String,
) -> Result<ProtectionDefaults, String> {
    let agents = host.agents()?;
    blocking(move || agents.protection_defaults(&owner)).await
}
#[tauri::command]
/// Changes only plugin defaults, after any required owner storage confirmation.
pub(crate) async fn app_agent_set_protection_defaults(
    host: tauri::State<'_, AppAgentHost>,
    owner: String,
    revision: u64,
    provider: String,
    policy: Option<Value>,
) -> Result<(), String> {
    let agents = host.agents()?;
    let prompt = host.protection_upgrade.clone();
    blocking(move || {
        confirm_protection_storage(&agents, &prompt, protection_upgrade_dialog)?;
        agents.set_protection_defaults(&owner, revision, &provider, policy)
    })
    .await
}
#[tauri::command]
pub(crate) async fn app_agent_set_protection(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    revision: u64,
    provider: String,
    policy: Option<Value>,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    let hosting = state.hosting.clone();
    let prompt = state.protection_upgrade.clone();
    blocking(move || {
        confirm_protection_storage(&agents, &prompt, protection_upgrade_dialog)?;
        hosting.protecting(&pubkey, || {
            agents.set_protection(&pubkey, revision, &provider, policy)
        })
    })
    .await
}

/// Identities earlier agent systems saved on this machine, as Agents could take
/// them over; the caller leaves out its own.
#[tauri::command]
pub(crate) async fn app_agent_portable(
    state: tauri::State<'_, AppAgentHost>,
) -> Result<Portables, String> {
    let old = state.old.clone()?;
    blocking(move || Ok(old.list())).await
}

#[derive(Deserialize)]
pub(crate) struct ConvertedPicture {
    source: String,
    png: String,
}

fn port_picture(
    original: &str,
    converted: Option<&ConvertedPicture>,
) -> Option<(&'static str, Vec<u8>)> {
    // Bind the WebView's rendering to the picture actually read for this import.
    if original.starts_with("data:image/svg+xml,") {
        if let Some(converted) = converted.filter(|picture| picture.source == original) {
            if let Some(("image/png", bytes)) = inline_picture(&converted.png) {
                if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                    return Some(("image/png", bytes));
                }
            }
        }
    }
    inline_picture(original)
}

/// Takes over an earlier identity with its key, name, picture and description,
/// as `app_agent_create` does for a new one, and reports its carried settings.
/// Its old store keeps it.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri passes each IPC field as an argument.
pub(crate) async fn app_agent_port(
    state: tauri::State<'_, AppAgentHost>,
    identity: tauri::State<'_, crate::identity::IdentityHost>,
    source: PortSource,
    pubkey: String,
    destination: String,
    owner: String,
    agent_type: String,
    converted_picture: Option<ConvertedPicture>,
) -> Result<Ported, String> {
    // Unavailable storage refuses before the old store gives up its key.
    state.agents.clone()?;
    let old = state.old.clone()?;
    let credentials = state.credentials.clone();
    let (found, key) = blocking(move || {
        credentials.retry();
        let mut waits = 0;
        loop {
            match old.take(source, &pubkey, credentials.as_ref()) {
                Err(error) if error == CREDENTIALS_BUSY && waits < BUSY_WAITS => {
                    waits += 1;
                    std::thread::sleep(BUSY_WAIT);
                }
                taken => return taken,
            }
        }
    })
    .await?;
    let prepared = AppAgents::adopt(
        &destination,
        &owner,
        &agent_type,
        key,
        &found.name,
        found.picture.clone(),
        found.about.clone(),
    )?;
    let auth = identity
        .inner()
        .authorize_agent(owner, prepared.pubkey().to_owned())
        .await?;
    let (mut agent, key, incarnation) = state.install(prepared, auth).await?;
    let mut notes = vec![];
    // Old Buzz kept some pictures inline; the community serves the upload. The
    // agent comes over without it if that fails, which the import reports.
    let inline = found
        .picture
        .as_deref()
        .filter(|url| url.starts_with("data:"));
    let prepared_picture = inline.and_then(|url| port_picture(url, converted_picture.as_ref()));
    if inline.is_some() && prepared_picture.is_none() {
        notes.push(format!(
            "{} came over without its picture, which isn't a PNG, JPEG, GIF or WebP image under 6 MB.",
            agent.name
        ));
    }
    if let Some((mime, bytes)) = prepared_picture {
        match state
            .imported_picture(&agent, &key, incarnation, mime, bytes)
            .await
        {
            Ok(url) => agent.picture = Some(url),
            Err(error) => {
                eprintln!("Imported agent picture was not saved: {error}");
                notes.push(format!("{} came over without its picture.", agent.name));
            }
        }
    }
    Ok(Ported {
        agent: agent.into(),
        carry: found.carry,
        notes,
    })
}

#[tauri::command]
pub(crate) async fn app_agent_rename(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    name: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.rename(&pubkey, &name)).await
}

#[tauri::command]
pub(crate) async fn app_agent_set_type(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    agent_type: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.set_type(&pubkey, &agent_type)).await
}

/// Sets its picture in the community at `relay`, one that community serves.
#[tauri::command]
pub(crate) async fn app_agent_set_picture(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    picture: Option<String>,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.set_picture(&pubkey, &relay, picture)).await
}

/// Adds the agent, as it is in the community at `from`, to the community at
/// `destination`, with the same key and owner attestation; see `AppAgents::join`.
#[tauri::command]
pub(crate) async fn app_agent_join(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    from: String,
    destination: String,
    picture: Option<String>,
) -> Result<AppAgentSummary, String> {
    let host = state.inner().clone();
    blocking(move || {
        // Held so no first key read meets this write in the credential store.
        let _keys = host.keys();
        host.credentials.retry();
        let agents = host.agents.clone()?;
        let agent = agents.join(
            &pubkey,
            &from,
            &destination,
            picture,
            host.credentials.as_ref(),
        )?;
        host.tokens.reopen_row(&agent.pubkey, &agent.relay)?;
        Ok(agent.into())
    })
    .await
}

#[tauri::command]
pub(crate) async fn app_agent_delete(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
) -> Result<(), String> {
    state.delete(pubkey, relay).await
}

#[tauri::command]
pub(crate) async fn app_agent_begin_delete(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.begin_delete(&pubkey)).await
}

/// Starts its leaving the community at `relay`; see `AppAgents::begin_leave`.
#[tauri::command]
pub(crate) async fn app_agent_begin_leave(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.begin_leave(&pubkey, &relay)).await
}

/// Holds its removal from the community at `relay` for this copy of the app,
/// until `app_agent_release_removal`; see `AppAgents::hold_removal`.
#[tauri::command]
pub(crate) async fn app_agent_hold_removal(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
) -> Result<(), String> {
    let host = state.inner().clone();
    let page = host.removals().page;
    blocking(move || {
        let removal = host.agents.clone()?.hold_removal(&pubkey, &relay)?;
        let mut removals = host.removals();
        // A page that loaded meanwhile holds none, so it is let go.
        if removals.page != page {
            return Err("The app reloaded while it was being removed".into());
        }
        removals.held.insert(pubkey, removal);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) fn app_agent_release_removal(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
) {
    let held = &mut state.removals().held;
    if held
        .get(&pubkey)
        .is_some_and(|removal| removal.is(&pubkey, &relay))
    {
        held.remove(&pubkey);
    }
}

#[tauri::command]
pub(crate) async fn app_agent_forget(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.forget(&pubkey, &relay)).await
}

/// Whether this copy of the app runs the agent; see `Hosting`.
#[tauri::command]
pub(crate) async fn app_agent_claim(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    revision: Option<u64>,
) -> Result<bool, String> {
    let hosting = state.hosting.clone();
    let agents = state.agents.clone()?;
    blocking(move || {
        hosting.claim_validated(&pubkey, || {
            let current = agents
                .list()?
                .into_iter()
                .find(|agent| agent.pubkey == pubkey && !agent.deleted)
                .ok_or("No such agent on this device")?;
            if current.protection_revision != revision.unwrap_or(0) {
                return Err("Agent protection changed; refresh before running this agent".into());
            }
            Ok(())
        })
    })
    .await
}

/// Lets another copy of the app run the agent, as when this one cannot.
#[tauri::command]
pub(crate) fn app_agent_release(state: tauri::State<'_, AppAgentHost>, pubkey: String) {
    state.hosting.held().remove(&pubkey);
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AppAgentEvent {
    kind: u16,
    content: String,
    #[serde(default)]
    tags: Vec<Vec<String>>,
}

/// Signs one event as the agent and posts it to the agent's own community.
#[tauri::command]
pub(crate) async fn app_agent_publish(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    event: AppAgentEvent,
) -> Result<Value, String> {
    let (agent, key, evidence) = state.signer(pubkey, relay).await?;
    let signed = agent.sign(&key, event.kind, event.content, event.tags)?;
    let event_id = signed
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Invalid agent event")?
        .to_owned();
    evidence
        .run(true, post(&agent, &key, evidence.header(), signed))
        .await
        .map_err(|error| publish_error(&event_id, error))
}

fn publish_error(event_id: &str, error: String) -> String {
    if error == "Write result could not be confirmed; it may have completed. Inspect the existing operation before retrying." {
        format!("Agent event {event_id} unconfirmed; it may or may not have been accepted")
    } else {
        error
    }
}

/// Publishes changed public metadata. Safe to call any time; one publication
/// runs per agent at a time and records only what its community accepted.
#[tauri::command]
pub(crate) async fn app_agent_publish_profile(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
) -> Result<(), String> {
    let turn = state.profile_turn(&pubkey);
    let _turn = turn.lock().await;
    let incarnation = state.tokens.stamp(&pubkey, &relay)?;
    let agent = state.agent(pubkey, relay).await?;
    if agent.profile_is_current() {
        return Ok(());
    }
    let (agent, key) = state.key(agent).await?;
    let evidence = state.tokens.authorize(&agent, &key, incarnation).await?;
    let signed = evidence
        .run(
            true,
            post(&agent, &key, evidence.header(), agent.profile_event(&key)?),
        )
        .await?;
    let created_at = signed
        .get("created_at")
        .and_then(Value::as_u64)
        .ok_or("Invalid agent event")?;
    let agents = state.agents.clone()?;
    blocking(move || {
        evidence.commit(true, || {
            agents.published(
                &agent.pubkey,
                &agent.relay,
                Published {
                    name: agent.name,
                    picture: agent.picture,
                    about: agent.about,
                    created_at,
                },
            )
        })
    })
    .await
}

/// Reads from the agent's community as the agent, so it sees what the agent
/// may see rather than what the owner may.
#[tauri::command]
pub(crate) async fn app_agent_query(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    filters: Vec<Value>,
) -> Result<Value, String> {
    if filters.is_empty() || filters.len() > 8 {
        return Err("Agents read with one to eight filters".into());
    }
    let (agent, key, evidence) = state.signer(pubkey, relay).await?;
    evidence
        .run(false, read(&agent, &key, evidence.header(), &filters))
        .await
}

async fn read(
    agent: &AppAgent,
    key: &Secret,
    evidence: Option<&str>,
    filters: &[Value],
) -> Result<Value, String> {
    let bytes = serde_json::to_vec(filters).map_err(|_| "Could not encode agent read")?;
    let (status, body) = signed_read(agent, key, evidence, agent.query_url(), bytes).await?;
    if !status.is_success() {
        return Err(format!(
            "The community refused the agent read: {}",
            reason(status, &body)
        ));
    }
    serde_json::from_slice(&body).map_err(|_| "Invalid agent read".into())
}

/// Posts a read body to one of the agent's community endpoints, signed as the
/// agent, and returns the status and bounded body.
async fn signed_read(
    agent: &AppAgent,
    key: &Secret,
    evidence: Option<&str>,
    url: String,
    bytes: Vec<u8>,
) -> Result<(reqwest::StatusCode, Vec<u8>), String> {
    let response = attach(client()?.post(&url), evidence)
        .timeout(Duration::from_secs(20))
        .header("Content-Type", "application/json")
        .header(
            "Authorization",
            authorization(agent.http_auth(key, &url, &bytes)?)?,
        )
        .header("x-auth-tag", &agent.auth)
        .body(bytes)
        .send()
        .await
        .map_err(|_| "Agent read failed")?;
    let status = response.status();
    Ok((status, bounded(response, READ_LIMIT).await?))
}

/// Searches the agent's community for profiles whose `name` or `display_name`
/// matches `query`, best match first, as the agent. `None` means the community
/// has no profile name search (it answered 404 or 405), so the caller uses
/// NIP-50 search instead.
#[tauri::command]
pub(crate) async fn app_agent_search_profiles(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    query: String,
    limit: u32,
) -> Result<Option<Value>, String> {
    let (agent, key, evidence) = state.signer(pubkey, relay).await?;
    evidence
        .run(
            false,
            search_profiles(&agent, &key, evidence.header(), &query, limit),
        )
        .await
}

async fn search_profiles(
    agent: &AppAgent,
    key: &Secret,
    evidence: Option<&str>,
    query: &str,
    limit: u32,
) -> Result<Option<Value>, String> {
    let bytes = serde_json::to_vec(&serde_json::json!({ "query": query, "limit": limit }))
        .map_err(|_| "Could not encode profile search")?;
    let (status, body) =
        signed_read(agent, key, evidence, agent.profile_search_url(), bytes).await?;
    if matches!(
        status,
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::METHOD_NOT_ALLOWED
    ) {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!(
            "The community refused the profile search: {}",
            reason(status, &body)
        ));
    }
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|_| "Invalid profile search".into())
}

/// The largest file an agent uploads, as base64 through the WebView.
const UPLOAD_LIMIT: usize = 50 * 1024 * 1024;

/// A `type/subtype` MIME, lowercase, without parameters.
fn mime_type(value: &str) -> Option<String> {
    let mime = value.split(';').next()?.trim().to_ascii_lowercase();
    let (kind, subtype) = mime.split_once('/')?;
    let token = |part: &str| {
        !part.is_empty()
            && part.len() <= 127
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".+-_".contains(&b))
    };
    (token(kind) && token(subtype)).then_some(mime)
}

/// Uploads one file (base64 `data` of type `mime`) to the agent's community
/// as the agent, and returns the community's description of it.
#[tauri::command]
pub(crate) async fn app_agent_upload(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    data: String,
    mime: String,
) -> Result<Value, String> {
    use base64::Engine;
    // The type is a hint: the community sniffs the bytes and decides what it
    // accepts, as it does for the owner's own attachments.
    let mime = mime_type(&mime).ok_or("Invalid upload type")?;
    if data.len() > UPLOAD_LIMIT / 3 * 4 + 4 {
        return Err("Agents upload files up to 50 MB".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "Invalid upload data")?;
    let (agent, key, evidence) = state.signer(pubkey, relay).await?;
    evidence
        .run(true, upload(&agent, &key, evidence.header(), bytes, &mime))
        .await
}

/// Uploads one blob to the agent's community as the agent.
async fn upload(
    agent: &AppAgent,
    key: &Secret,
    evidence: Option<&str>,
    bytes: Vec<u8>,
    mime: &str,
) -> Result<Value, String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let auth = serde_json::to_vec(&agent.upload_auth(key, &sha256)?)
        .map_err(|_| "Could not authorize upload")?;
    let response = attach(client()?.put(agent.upload_url()), evidence)
        .timeout(Duration::from_secs(120))
        .header("Content-Type", mime)
        .header("X-SHA-256", &sha256)
        .header(
            "Authorization",
            format!(
                "Nostr {}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(auth)
            ),
        )
        .header("x-auth-tag", &agent.auth)
        .body(bytes)
        .send()
        .await
        .map_err(|_| "Agent upload unconfirmed")?;
    let status = response.status();
    let body = bounded(response, 64 * 1024).await?;
    if !status.is_success() {
        return Err(format!(
            "The community refused the upload: {}",
            reason(status, &body)
        ));
    }
    serde_json::from_slice(&body).map_err(|_| "Invalid upload receipt".into())
}

/// The URL of repository `repo` of `owner` in the agent's community, and the
/// headers Git sends there as the agent for the next minute, one per line:
/// `Authorization`, then the agent's sign-in evidence when the community
/// requires it. The key stays native. These are the only assertion headers
/// that leave native code: the NIP-98 proof grants only that repository for 60
/// seconds; the assertion is scoped to the relay for its issuer's lifetime and
/// is bound to the agent's key (NIP-FI, Assertion–key binding).
#[tauri::command]
pub(crate) async fn app_agent_git_auth(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    owner: String,
    repo: String,
) -> Result<Value, String> {
    let (agent, key, evidence) = state.signer_for(pubkey, relay, GIT_EVIDENCE).await?;
    let (url, auth) = agent.git_auth(&key, &owner, &repo)?;
    let auth = serde_json::to_vec(&auth).map_err(|_| "Could not authorize Git")?;
    evidence.dispatch()?;
    Ok(serde_json::json!({ "url": url, "header": git_headers(&auth, evidence.header()) }))
}

/// How long the Git headers must stay valid: the minute the `repo` tool
/// promises, and a margin for a command that starts at its end.
const GIT_EVIDENCE: Duration = Duration::from_secs(70);

/// Git's header lines for a signed `auth` and the agent's sign-in `evidence`.
fn git_headers(auth: &[u8], evidence: Option<&str>) -> String {
    use base64::Engine;
    let auth = format!(
        "Authorization: Nostr {}",
        base64::engine::general_purpose::STANDARD.encode(auth)
    );
    match evidence {
        Some(evidence) => format!("{auth}\n{}: {evidence}", assertion::HEADER),
        None => auth,
    }
}

/// The largest image an agent is shown. Claude takes 5 MiB of base64 on its
/// strictest hosts, and base64 is 4 characters per 3 bytes.
const MEDIA_LIMIT: u64 = 5 * 1024 * 1024 / 4 * 3;
/// The largest file an agent saves: the community's largest upload, a video.
const MEDIA_FILE_LIMIT: u64 = 500 * 1024 * 1024;
/// Images an agent can be shown.
const SHOWN_TYPES: [&str; 4] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/// One media blob saved for an agent, and the image itself when it can be shown.
#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct AgentMedia {
    path: String,
    #[serde(rename = "type")]
    mime: String,
    size: u64,
    /// Base64, only for an image within [`MEDIA_LIMIT`].
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
}

/// Downloads one of its community's media blobs (its URL or `sha256[.ext]`)
/// as the agent, of any type the community serves. It is saved to a local file
/// so the agent's own tools can open it; an image is also returned to be shown.
/// The file goes in the OS temp dir, as the Node MCP server saves it, so the OS
/// removes it later; the agent needs it only for its turn.
#[tauri::command]
pub(crate) async fn app_agent_media(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    url: String,
) -> Result<AgentMedia, String> {
    use base64::Engine;
    let dir = std::env::temp_dir().join("buzz-agent-media");
    let (agent, key, evidence) = state.signer(pubkey, relay).await?;
    let url = agent.media_url(&url)?;
    let auth =
        serde_json::to_vec(&agent.media_auth(&key)?).map_err(|_| "Could not authorize media")?;
    evidence.dispatch()?;
    let response = attach(client()?.get(&url), evidence.header())
        .timeout(Duration::from_secs(600))
        .header(
            "Authorization",
            format!(
                "Nostr {}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(auth)
            ),
        )
        .header("x-auth-tag", &agent.auth)
        .send()
        .await
        .map_err(|_| "Agent media request failed")?;
    let result = save_media_admitted(&agent, &url, response, &dir, Some(&evidence)).await;
    evidence.commit(false, || result)
}

/// Streams a media response to `dir`, named by its hash, checking the hash.
#[cfg(test)]
async fn save_media(
    agent: &AppAgent,
    url: &str,
    response: reqwest::Response,
    dir: &Path,
) -> Result<AgentMedia, String> {
    save_media_admitted(agent, url, response, dir, None).await
}
async fn save_media_admitted(
    agent: &AppAgent,
    url: &str,
    mut response: reqwest::Response,
    dir: &Path,
    admission: Option<&Admission>,
) -> Result<AgentMedia, String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    use std::io::Write;
    let status = response.status();
    if !status.is_success() {
        let body = bounded(response, 64 * 1024).await.unwrap_or_default();
        return Err(format!(
            "The community refused the media: {}",
            reason(status, &body)
        ));
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(mime_type)
        .unwrap_or_else(|| "application/octet-stream".into());
    let shown = SHOWN_TYPES.contains(&mime.as_str());
    std::fs::create_dir_all(dir).map_err(|_| "Media storage unavailable")?;
    let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|_| "Media storage unavailable")?;
    let mut hash = Sha256::new();
    let mut size = 0u64;
    let mut image = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Agent media request failed")?
    {
        size += chunk.len() as u64;
        if size > MEDIA_FILE_LIMIT {
            return Err("Media over 500 MiB cannot be saved".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk)
            .map_err(|_| "Media could not be saved")?;
        if shown && size <= MEDIA_LIMIT {
            image.extend_from_slice(&chunk);
        }
    }
    agent.verify_media_hash(url, &format!("{:x}", hash.finalize()))?;
    // The blob's own name, so the same media is saved once; with an extension
    // from its type when the URL gives none.
    let mut name = url.rsplit('/').next().unwrap_or_default().to_owned();
    if !name.contains('.') {
        if let Some(ext) = mime
            .split_once('/')
            .map(|(_, subtype)| subtype)
            .filter(|ext| ext.len() <= 8 && ext.bytes().all(|b| b.is_ascii_alphanumeric()))
        {
            name = format!("{name}.{ext}");
        }
    }
    let path = dir.join(name);
    let persist = || {
        file.persist(&path)
            .map(drop)
            .map_err(|_| "Media could not be saved".to_owned())
    };
    if let Some(admission) = admission {
        admission.commit(false, persist)?;
    } else {
        persist()?;
    }
    Ok(AgentMedia {
        path: path.to_string_lossy().into_owned(),
        data: (shown && size <= MEDIA_LIMIT)
            .then(|| base64::engine::general_purpose::STANDARD.encode(&image)),
        mime,
        size,
    })
}

/// Writes one memory entry, encrypted to the agent's owner; a null body
/// deletes it. `after` is the `created_at` of the entry it replaces, or 0.
#[tauri::command]
pub(crate) async fn app_agent_remember(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    slug: String,
    body: Option<String>,
    after: u64,
) -> Result<Value, String> {
    let (agent, key, evidence) = state.signer(pubkey, relay).await?;
    let signed = agent.memory(&key, &slug, body.as_deref(), after)?;
    evidence
        .run(true, post(&agent, &key, evidence.header(), signed))
        .await
}

/// Adds the agent's NIP-FI assertion, beside its NIP-98 `Authorization`, for
/// a community of the owner's organization.
fn attach(request: reqwest::RequestBuilder, evidence: Option<&str>) -> reqwest::RequestBuilder {
    match evidence {
        Some(evidence) => request.header(assertion::HEADER, evidence),
        None => request,
    }
}

/// One client for every agent request, so frequent small posts such as
/// typing pulses reuse a connection instead of opening a new one each time.
/// Each request sets its own timeout.
fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, reqwest::Error>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                // A connection idle across sleep may be dead; open a new one.
                .pool_idle_timeout(Duration::from_secs(30))
                .build()
        })
        .as_ref()
        .map_err(|_| "Agent client unavailable".into())
}

/// The most an agent read returns. Mirrors `CANVAS_READ_BYTES` in
/// `canvas-limits.ts`, which sizes Canvas history pages to fit it.
const READ_LIMIT: usize = 8 * 1024 * 1024;

async fn bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Agent request failed")? {
        if body.len() + chunk.len() > limit {
            return Err("Agent response is too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Why the community refused, from its JSON body when it gives one.
fn reason(status: reqwest::StatusCode, body: &[u8]) -> String {
    let receipt: Value =
        serde_json::from_slice(&body[..body.len().min(16 * 1024)]).unwrap_or(Value::Null);
    receipt
        .get("message")
        .or_else(|| receipt.get("error"))
        .and_then(Value::as_str)
        .map(|text| text.chars().take(300).collect::<String>())
        .unwrap_or_else(|| format!("status {}", status.as_u16()))
}

async fn post(
    agent: &AppAgent,
    key: &Secret,
    evidence: Option<&str>,
    signed: Value,
) -> Result<Value, String> {
    let event_id = signed
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Invalid agent event")?
        .to_owned();
    let bytes = serde_json::to_vec(&signed).map_err(|_| "Could not encode agent event")?;
    let response = attach(client()?.post(agent.events_url()), evidence)
        .timeout(Duration::from_secs(20))
        .header("Content-Type", "application/json")
        .header(
            "Authorization",
            authorization(agent.http_auth(key, &agent.events_url(), &bytes)?)?,
        )
        .header("x-auth-tag", &agent.auth)
        .body(bytes)
        .send()
        .await
        .map_err(|_| {
            format!("Agent event {event_id} unconfirmed; it may or may not have been accepted")
        })?;
    let status = response.status();
    let body = response.bytes().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "The community refused the agent event: {}",
            reason(status, &body)
        ));
    }
    let receipt: Value =
        serde_json::from_slice(&body[..body.len().min(16 * 1024)]).unwrap_or(Value::Null);
    if receipt.get("accepted").and_then(Value::as_bool) != Some(true)
        || receipt.get("event_id").and_then(Value::as_str) != Some(event_id.as_str())
    {
        return Err(format!(
            "Agent event {event_id} unconfirmed; it may or may not have been accepted"
        ));
    }
    Ok(signed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn imported_emoji_png_is_bound_to_the_current_source() {
        let original = "data:image/svg+xml,legacy";
        let mut converted = ConvertedPicture {
            source: original.into(),
            png: "data:image/png;base64,iVBORw0KGgo=".into(),
        };
        assert_eq!(
            port_picture(original, Some(&converted)),
            Some(("image/png", b"\x89PNG\r\n\x1a\n".to_vec()))
        );
        assert!(port_picture(original, None).is_none());
        assert!(port_picture("data:image/svg+xml,changed", Some(&converted)).is_none());
        for refused in [
            "data:image/svg+xml;base64,PHN2Zz4=",
            "data:image/png;base64,!!",
            "data:image/png;base64,iVBO",
            "data:image/jpeg;base64,iVBORw0KGgo=",
        ] {
            converted.png = refused.into();
            assert!(port_picture(original, Some(&converted)).is_none());
        }
        converted.png = format!("data:image/png;base64,{}", "A".repeat(8 * 1024 * 1024 + 1));
        assert!(port_picture(original, Some(&converted)).is_none());
        assert_eq!(
            port_picture("data:image/png;base64,iVBO", Some(&converted)),
            Some(("image/png", vec![0x89, 0x50, 0x4e]))
        );
    }

    #[test]
    fn git_headers_add_sign_in_evidence_only_when_present() {
        assert_eq!(git_headers(b"{}", None), "Authorization: Nostr e30=");
        assert_eq!(
            git_headers(b"{}", Some("Bearer token")),
            "Authorization: Nostr e30=\nNostr-Federated-Identity: Bearer token"
        );
    }

    #[test]
    fn declining_storage_upgrade_leaves_files_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("identities.json");
        std::fs::write(&path, "[]").unwrap();
        let agents = AppAgents::open(path.clone());
        assert!(confirm_protection_storage(&agents, &Mutex::new(()), || false).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "[]");
        assert!(!dir.path().join("protection.json").exists());
        assert!(!agents.protection_storage_current().unwrap());
    }

    #[test]
    fn storage_confirmation_holds_no_identity_lock_and_keeps_concurrent_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("identities.json");
        let key = Secret::generate().unwrap();
        let agent = agent_at("wss://home.example".into(), &key);
        std::fs::write(&path, serde_json::to_vec(&vec![agent.clone()]).unwrap()).unwrap();
        let agents = AppAgents::open(path.clone());
        confirm_protection_storage(&agents, &Mutex::new(()), || {
            let other = AppAgents::open(path);
            other.rename(&agent.pubkey, "Concurrent rename").unwrap();
            other.upgrade_protection_storage().unwrap();
            other
                .set_protection(
                    &agent.pubkey,
                    0,
                    "security.test",
                    Some(serde_json::json!({})),
                )
                .unwrap();
            true
        })
        .unwrap();
        let kept = agents.get(&agent.pubkey, &agent.relay).unwrap();
        assert_eq!(kept.name, "Concurrent rename");
        assert_eq!(kept.protection_revision, 1);
    }

    #[test]
    fn concurrent_local_protection_saves_share_one_upgrade_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let agents = AppAgents::open(dir.path().join("identities.json"));
        let prompt = Arc::new(Mutex::new(()));
        let shown = Arc::new(AtomicU32::new(0));
        let (entered, started) = std::sync::mpsc::channel();
        let (allow, allowed) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let first_agents = agents.clone();
            let first_prompt = prompt.clone();
            let first_shown = shown.clone();
            let first = scope.spawn(move || {
                confirm_protection_storage(&first_agents, &first_prompt, || {
                    first_shown.fetch_add(1, Ordering::SeqCst);
                    entered.send(()).unwrap();
                    allowed.recv().unwrap();
                    true
                })
            });
            started.recv().unwrap();
            let second = scope.spawn(|| {
                confirm_protection_storage(&agents, &prompt, || {
                    shown.fetch_add(1, Ordering::SeqCst);
                    true
                })
            });
            allow.send(()).unwrap();
            first.join().unwrap().unwrap();
            second.join().unwrap().unwrap();
        });
        assert_eq!(shown.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn uncertain_evidence_keeps_the_signed_event_id() {
        let id = "a".repeat(64);
        assert_eq!(
            publish_error(
                &id,
                "Write result could not be confirmed; it may have completed. Inspect the existing operation before retrying.".into(),
            ),
            format!("Agent event {id} unconfirmed; it may or may not have been accepted")
        );
        assert_eq!(
            publish_error(&id, "The community refused the agent event: blocked".into()),
            "The community refused the agent event: blocked"
        );
    }

    /// One saved key, behind a store that is busy for the first few reads.
    struct Busy(Mutex<Option<String>>, AtomicU32);
    impl Credentials for Busy {
        fn read_legacy(
            &self,
            _: buzz_agent_controller::LegacySource,
            _: &str,
        ) -> Result<Secret, String> {
            unreachable!()
        }
        fn read(&self, _: &str, pubkey: &str) -> Result<Option<Secret>, String> {
            if self.1.load(Ordering::SeqCst) > 0 {
                self.1.fetch_sub(1, Ordering::SeqCst);
                return Err(CREDENTIALS_BUSY.into());
            }
            self.0
                .lock()
                .unwrap()
                .as_ref()
                .map(|hex| Secret::parse(hex, pubkey))
                .transpose()
        }
        fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
            unreachable!()
        }
        fn delete(&self, _: &str, _: &str) -> Result<(), String> {
            self.0.lock().unwrap().take();
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_first_key_read_waits_out_a_busy_store() {
        let key = Secret::generate().unwrap();
        let host = AppAgentHost {
            agents: Err("unused".into()),
            old: Err("unused".into()),
            credentials: Arc::new(Busy(
                Mutex::new(Some(key.hex().to_string())),
                AtomicU32::new(3),
            )),
            keys: Arc::default(),
            profiles: Arc::default(),
            removals: Arc::default(),
            hosting: Arc::new(hosting(Err("unused".into()), true)),
            tokens: AgentTokens::unconfigured(),
            protection_upgrade: Arc::default(),
        };
        let agent = AppAgent {
            pubkey: key.pubkey().into(),
            relay: "wss://relay.example".into(),
            owner: "a".repeat(64),
            auth: "[]".into(),
            agent_type: "p/t".into(),
            name: "Ada".into(),
            picture: None,
            profile: None,
            about: None,
            deleted: false,
            deleting: false,
            home: None,
            joining: false,
            protection: None,
            protection_revision: 0,
        };
        let (_, read) = host.key(agent).await.unwrap();
        assert_eq!(read.pubkey(), key.pubkey());
    }

    #[test]
    fn a_membership_reaches_the_webview_with_its_home_and_whether_it_is_joining() {
        let key = Secret::generate().unwrap();
        let home = agent_at("wss://home.example".into(), &key);
        let summary = |agent| serde_json::to_value(AppAgentSummary::from(agent)).unwrap();
        let at_home = summary(home.clone());
        assert!(at_home.get("home").is_none() && at_home.get("joining").is_none());
        let joined = AppAgent {
            relay: "wss://other.example".into(),
            home: Some(home.relay.clone()),
            joining: true,
            ..home
        };
        let joined = summary(joined);
        assert_eq!(joined["home"], "wss://home.example");
        assert_eq!(joined["joining"], true);
    }

    #[tokio::test]
    async fn delete_waits_for_a_profile_and_refuses_a_reloaded_pages_hold() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("identities.json");
        let key = Secret::generate().unwrap();
        let agent = AppAgent {
            deleting: true,
            ..agent_at("wss://relay.example".into(), &key)
        };
        std::fs::write(&path, serde_json::to_vec(&[&agent]).unwrap()).unwrap();
        let mut host = AppAgentHost::new(
            Ok(path),
            Err("unused".into()),
            true,
            AgentTokens::unconfigured(),
        );
        host.credentials = Arc::new(Busy(
            Mutex::new(Some(key.hex().to_string())),
            AtomicU32::new(0),
        ));
        let agents = host.agents().unwrap();
        host.keys().insert(agent.pubkey.clone(), Arc::new(key));
        host.removals().held.insert(
            agent.pubkey.clone(),
            agents.hold_removal(&agent.pubkey, &agent.relay).unwrap(),
        );
        let turn = host.profile_turn(&agent.pubkey);
        let publishing = turn.lock().await;
        let mut deleting = Box::pin(host.delete(agent.pubkey.clone(), agent.relay.clone()));
        // Poll through the generation capture into the held publication lock.
        assert!(matches!(
            futures_util::poll!(&mut deleting),
            std::task::Poll::Pending
        ));
        host.page_load();
        host.removals().held.insert(
            agent.pubkey.clone(),
            agents.hold_removal(&agent.pubkey, &agent.relay).unwrap(),
        );
        drop(publishing);
        assert_eq!(
            deleting.await.unwrap_err(),
            "The app reloaded while it was being removed"
        );
        assert_eq!(agents.list().unwrap(), std::slice::from_ref(&agent));
        assert!(agent.read_key(host.credentials.as_ref()).is_ok());
        assert!(host.keys().contains_key(&agent.pubkey));
        assert!(host.removals().held.contains_key(&agent.pubkey));
        // Only the current page may finish cleanup using its own hold.
        host.delete(agent.pubkey.clone(), agent.relay.clone())
            .await
            .unwrap();
        assert!(agents.list().unwrap()[0].deleted);
        assert!(agent.read_key(host.credentials.as_ref()).is_err());
        assert!(!host.keys().contains_key(&agent.pubkey));
        agents.forget(&agent.pubkey, &agent.relay).unwrap();
        assert!(agents.list().unwrap().is_empty());
    }

    /// Saved keys in memory; `gate` holds the next read once it is called.
    #[derive(Default)]
    struct Gated(
        Mutex<HashMap<String, String>>,
        Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
    );
    impl Credentials for Gated {
        fn read_legacy(
            &self,
            _: buzz_agent_controller::LegacySource,
            _: &str,
        ) -> Result<Secret, String> {
            unreachable!()
        }
        fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>, String> {
            let gate = self.1.lock().unwrap().take();
            if let Some((held, release)) = gate {
                held.send(()).unwrap();
                release.recv().unwrap();
            }
            let saved = self.0.lock().unwrap().get(id).cloned();
            saved.map(|hex| Secret::parse(&hex, pubkey)).transpose()
        }
        fn add(&self, id: &str, key: &Secret) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(id.into(), key.hex().to_string());
            Ok(())
        }
        fn delete(&self, id: &str, _: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    /// The owner's NIP-OA tag for `agent`, from a fixed owner key.
    fn attestation(agent: &str) -> Vec<String> {
        use secp256k1::{Keypair, Secp256k1, SecretKey};
        use sha2::{Digest, Sha256};
        let secp = Secp256k1::new();
        let mut bytes = [0; 32];
        bytes[31] = 2;
        let pair = Keypair::from_secret_key(&secp, &SecretKey::from_byte_array(bytes).unwrap());
        let digest = Sha256::digest(format!("nostr:agent-auth:{agent}:"));
        let sig = secp.sign_schnorr_no_aux_rand(&digest, &pair);
        vec![
            "auth".into(),
            pair.x_only_public_key().0.to_string(),
            String::new(),
            sig.to_string(),
        ]
    }

    /// Starts the agent's Delete and holds its removal, as the page does.
    fn hold_removal(host: &AppAgentHost, agent: &AppAgent) {
        let agents = host.agents().unwrap();
        agents.begin_delete(&agent.pubkey).unwrap();
        let removal = agents.hold_removal(&agent.pubkey, &agent.relay).unwrap();
        host.removals().held.insert(agent.pubkey.clone(), removal);
    }

    #[tokio::test]
    async fn deletion_refuses_a_request_holding_the_key_and_a_re_import_works_again() {
        use crate::federated_identity::agent::tests::{enrolled, fixture, issued, issuer, settled};
        let key = Secret::generate().unwrap();
        let owner = attestation(key.pubkey())[1].clone();
        let probe = agent_at("wss://relay.example".into(), &key);
        let probe = AppAgent {
            owner: owner.clone(),
            ..probe
        };
        let (base, served) = issuer(vec![
            (200, enrolled(&owner)),
            (200, issued(&probe, serde_json::json!({}))),
        ])
        .await;
        let f = fixture(base);
        let dir = tempfile::tempdir().unwrap();
        let credentials = Arc::new(Gated::default());
        let host = AppAgentHost {
            agents: Ok(AppAgents::open(dir.path().join("identities.json"))),
            old: Err("unused".into()),
            credentials: credentials.clone(),
            keys: Arc::default(),
            profiles: Arc::default(),
            removals: Arc::default(),
            hosting: Arc::new(hosting(Err("unused".into()), true)),
            tokens: f.tokens.clone(),
            protection_upgrade: Arc::default(),
        };
        let import = |key: &Secret| {
            let key = Secret::parse(&key.hex(), key.pubkey()).unwrap();
            let auth = attestation(key.pubkey());
            let prepared = AppAgents::adopt(
                "https://relay.example/",
                &owner,
                "p/t",
                key,
                "Ada",
                None,
                None,
            )
            .unwrap();
            let host = host.clone();
            async move { host.install(prepared, auth).await.unwrap() }
        };
        let (agent, _, old_incarnation) = import(&key).await;
        host.keys().clear();

        // A request reads the agent, then is held reading its key.
        let (held_tx, held) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        *credentials.1.lock().unwrap() = Some((held_tx, release_rx));
        let stale = tokio::spawn({
            let host = host.clone();
            let (pubkey, relay) = (agent.pubkey.clone(), agent.relay.clone());
            async move { host.signer(pubkey, relay).await.map(drop) }
        });
        tokio::task::spawn_blocking(move || held.recv())
            .await
            .unwrap()
            .unwrap();
        hold_removal(&host, &agent);
        let deleting = tokio::spawn({
            let host = host.clone();
            let (pubkey, relay) = (agent.pubkey.clone(), agent.relay.clone());
            async move { host.delete(pubkey, relay).await }
        });
        crate::federated_identity::agent::tests::bounded(async {
            while !host.tokens.closed(&agent.pubkey) {
                tokio::task::yield_now().await;
            }
        })
        .await;
        release.send(()).unwrap();
        assert_eq!(
            stale.await.unwrap().err().as_deref(),
            Some("This agent was deleted")
        );
        deleting.await.unwrap().unwrap();
        assert!(f.grants.0.lock().unwrap().is_empty(), "nothing persisted");

        // The same key imported again enrolls and works; the old request's
        // incarnation stays refused.
        let (agent, key, _) = import(&key).await;
        let (_, _, evidence) = host
            .signer(agent.pubkey.clone(), agent.relay.clone())
            .await
            .unwrap();
        assert!(evidence.header().is_some());
        assert_eq!(
            host.tokens
                .evidence(&agent, &key, old_incarnation.key)
                .await
                .err()
                .as_deref(),
            Some("This agent was deleted")
        );
        let seen = settled(served).await;
        assert_eq!(
            seen.len(),
            2,
            "only the re-imported agent's grant and assertion"
        );
    }

    #[tokio::test]
    async fn leaving_one_community_keeps_the_grant_until_the_last_goes() {
        let f = crate::federated_identity::agent::tests::fixture("http://unused".into());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("identities.json");
        let key = Secret::generate().unwrap();
        let home = agent_at("wss://home.example".into(), &key);
        let other = agent_at("wss://other.example".into(), &key);
        std::fs::write(&path, serde_json::to_vec(&[&home, &other]).unwrap()).unwrap();
        let host = AppAgentHost {
            agents: Ok(AppAgents::open(path)),
            old: Err("unused".into()),
            credentials: Arc::new(Gated::default()),
            keys: Arc::default(),
            profiles: Arc::default(),
            removals: Arc::default(),
            hosting: Arc::new(hosting(Err("unused".into()), true)),
            tokens: f.tokens.clone(),
            protection_upgrade: Arc::default(),
        };
        let agents = host.agents().unwrap();

        agents.begin_leave(&other.pubkey, &other.relay).unwrap();
        let removal = agents.hold_removal(&other.pubkey, &other.relay).unwrap();
        host.removals().held.insert(other.pubkey.clone(), removal);
        host.delete(other.pubkey.clone(), other.relay.clone())
            .await
            .unwrap();
        assert!(!host.tokens.closed(&home.pubkey), "still in its home");
        host.removals().held.remove(&other.pubkey);

        hold_removal(&host, &home);
        host.delete(home.pubkey.clone(), home.relay.clone())
            .await
            .unwrap();
        assert!(host.tokens.closed(&home.pubkey));
    }

    #[tokio::test]
    async fn an_import_held_past_its_deletion_does_not_upload_with_a_re_import() {
        use crate::federated_identity::agent::tests::{enrolled, fixture, issued, issuer, settled};
        let key = Secret::generate().unwrap();
        let owner = attestation(key.pubkey())[1].clone();
        let probe = AppAgent {
            owner: owner.clone(),
            ..agent_at("wss://relay.example".into(), &key)
        };
        let (base, served) = issuer(vec![
            (200, enrolled(&owner)),
            (200, issued(&probe, serde_json::json!({}))),
        ])
        .await;
        let f = fixture(base);
        let dir = tempfile::tempdir().unwrap();
        let host = AppAgentHost {
            agents: Ok(AppAgents::open(dir.path().join("identities.json"))),
            old: Err("unused".into()),
            credentials: Arc::new(Gated::default()),
            keys: Arc::default(),
            profiles: Arc::default(),
            removals: Arc::default(),
            hosting: Arc::new(hosting(Err("unused".into()), true)),
            tokens: f.tokens.clone(),
            protection_upgrade: Arc::default(),
        };
        let import = || {
            let key = Secret::parse(&key.hex(), key.pubkey()).unwrap();
            let auth = attestation(key.pubkey());
            let prepared = AppAgents::adopt(
                "https://relay.example/",
                &owner,
                "p/t",
                key,
                "Ada",
                None,
                None,
            )
            .unwrap();
            let host = host.clone();
            async move { host.install(prepared, auth).await.unwrap() }
        };

        // Import I installs, then its picture work is held while the agent is
        // deleted and the same key is imported again as import II.
        let (old_agent, old_key, old_incarnation) = import().await;
        hold_removal(&host, &old_agent);
        host.delete(old_agent.pubkey.clone(), old_agent.relay.clone())
            .await
            .unwrap();
        let (agent, _, _) = import().await;
        let (_, _, evidence) = host
            .signer(agent.pubkey.clone(), agent.relay.clone())
            .await
            .unwrap();
        assert!(evidence.header().is_some(), "import II works");

        let stale = host
            .imported_picture(&old_agent, &old_key, old_incarnation, "image/png", vec![1])
            .await;
        assert_eq!(stale.err().as_deref(), Some("This agent was deleted"));
        assert_eq!(
            settled(served).await.len(),
            2,
            "only import II's grant and assertion"
        );
    }

    /// Answers one HTTP request with `status` and `body`, and returns the
    /// request it read.
    async fn answer_once(
        status: &'static str,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let served = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 4096];
            loop {
                let read = socket.read(&mut chunk).await.unwrap();
                request.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&request);
                if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if rest.len() >= length {
                        break;
                    }
                }
            }
            let reply = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8(request).unwrap()
        });
        (origin, served)
    }

    fn agent_at(relay: String, key: &Secret) -> AppAgent {
        AppAgent {
            pubkey: key.pubkey().into(),
            relay,
            owner: "a".repeat(64),
            auth: "[]".into(),
            agent_type: "p/t".into(),
            name: "Ada".into(),
            picture: None,
            profile: None,
            about: None,
            deleted: false,
            deleting: false,
            home: None,
            joining: false,
            protection: None,
            protection_revision: 0,
        }
    }

    /// Serves `body` as `mime` once, and returns the response to a GET of `path`.
    async fn media_response(
        mime: &'static str,
        body: &'static [u8],
        path: &str,
    ) -> (String, reqwest::Response) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await.unwrap();
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: {mime}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(head.as_bytes()).await.unwrap();
            socket.write_all(body).await.unwrap();
        });
        let response = reqwest::get(format!("{origin}{path}")).await.unwrap();
        (origin, response)
    }

    #[tokio::test]
    async fn media_of_any_type_is_saved_by_its_hash_and_only_images_are_shown() {
        use base64::Engine;
        use sha2::{Digest, Sha256};
        let key = Secret::generate().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let video: &'static [u8] = b"\0\0\0\x18ftypmp42 not really a video";
        let sha = format!("{:x}", Sha256::digest(video));
        let path = format!("/media/{sha}");
        let (origin, response) = media_response("video/mp4", video, &path).await;
        let agent = agent_at(origin.clone(), &key);
        let saved = save_media(&agent, &format!("{origin}{path}"), response, dir.path())
            .await
            .unwrap();
        let file = dir.path().join(format!("{sha}.mp4"));
        assert_eq!(
            saved,
            AgentMedia {
                path: file.to_string_lossy().into_owned(),
                mime: "video/mp4".into(),
                size: video.len() as u64,
                data: None,
            }
        );
        assert_eq!(std::fs::read(&file).unwrap(), video);

        let image: &'static [u8] = b"\x89PNG\r\n\x1a\n pixels";
        let sha = format!("{:x}", Sha256::digest(image));
        let path = format!("/media/{sha}.png");
        let (origin, response) = media_response("image/png; charset=binary", image, &path).await;
        let saved = save_media(
            &agent_at(origin.clone(), &key),
            &format!("{origin}{path}"),
            response,
            dir.path(),
        )
        .await
        .unwrap();
        assert_eq!(saved.mime, "image/png");
        assert_eq!(
            saved.data,
            Some(base64::engine::general_purpose::STANDARD.encode(image))
        );
        assert!(saved.path.ends_with(&format!("{sha}.png")));
    }

    #[tokio::test]
    async fn media_that_does_not_match_its_hash_is_not_saved() {
        let key = Secret::generate().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = format!("/media/{}.pdf", "0".repeat(64));
        let (origin, response) = media_response("application/pdf", b"%PDF-1.7", &path).await;
        let saved = save_media(
            &agent_at(origin.clone(), &key),
            &format!("{origin}{path}"),
            response,
            dir.path(),
        )
        .await;
        assert_eq!(saved, Err("Media did not match its SHA-256".into()));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn upload_types_are_hints_of_any_kind_but_must_be_well_formed() {
        assert_eq!(
            mime_type("Application/PDF; x=1").as_deref(),
            Some("application/pdf")
        );
        assert_eq!(
            mime_type("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
                .as_deref(),
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        );
        for bad in ["", "pdf", "a/", "/b", "a/b c", "a/b\r\nx: y"] {
            assert_eq!(mime_type(bad), None, "{bad:?}");
        }
    }

    #[tokio::test]
    async fn profile_search_posts_the_query_signed_and_returns_the_ranked_events() {
        let key = Secret::generate().unwrap();
        let (origin, served) = answer_once("200 OK", r#"[{"kind":0}]"#).await;
        let found = search_profiles(
            &agent_at(origin, &key),
            &key,
            Some("Bearer agent.jwt.sig"),
            "wes",
            40,
        )
        .await
        .unwrap();
        assert_eq!(found, Some(serde_json::json!([{ "kind": 0 }])));
        let request = served.await.unwrap().to_ascii_lowercase();
        assert!(request.starts_with("post /profiles/search http/1.1"));
        // The organization's assertion rides beside the agent's own NIP-98 proof.
        assert!(request.contains("authorization: nostr "));
        assert!(request.contains("nostr-federated-identity: bearer agent.jwt.sig"));
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body, serde_json::json!({ "query": "wes", "limit": 40 }));
    }

    #[tokio::test]
    async fn profile_search_reports_a_missing_endpoint_and_fails_on_other_errors() {
        let key = Secret::generate().unwrap();
        for status in ["404 Not Found", "405 Method Not Allowed"] {
            let (origin, served) = answer_once(status, "").await;
            let found = search_profiles(&agent_at(origin, &key), &key, None, "wes", 40).await;
            assert_eq!(found, Ok(None), "{status}");
            served.await.unwrap();
        }
        let (origin, served) = answer_once(
            "500 Internal Server Error",
            r#"{"error":"profile search error"}"#,
        )
        .await;
        let failed = search_profiles(&agent_at(origin, &key), &key, None, "wes", 40).await;
        assert_eq!(
            failed,
            Err("The community refused the profile search: profile search error".into())
        );
        served.await.unwrap();
    }

    fn hosting(dir: Result<PathBuf, String>, packaged: bool) -> Hosting {
        Hosting {
            dir,
            packaged,
            held: Mutex::default(),
        }
    }

    #[test]
    fn failed_admission_releases_only_newly_acquired_custody() {
        for packaged in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let agent = "a".repeat(64);
            let one = hosting(Ok(dir.path().join("hosts")), packaged);
            let other = hosting(Ok(dir.path().join("hosts")), packaged);
            assert!(one
                .claim_validated(&agent, || Err("changed revision".into()))
                .is_err());
            assert!(other.claim(&agent).unwrap());
            other.held().remove(&agent);
            assert!(one.claim(&agent).unwrap());
            assert!(one
                .claim_validated(&agent, || Err("read failed".into()))
                .is_err());
            assert!(!other.claim(&agent).unwrap());
        }
    }

    #[test]
    fn protection_changes_require_current_and_exclusive_hosting() {
        let dir = tempfile::tempdir().unwrap();
        let agent = "a".repeat(64);
        let dev = hosting(Ok(dir.path().join("hosts")), false);
        let packaged = hosting(Ok(dir.path().join("hosts")), true);
        assert!(dev.protecting(&agent, || Ok(())).is_err());
        assert!(dev.claim(&agent).unwrap());
        assert!(dev.protecting(&agent, || Ok(())).is_ok());
        assert!(packaged.claim(&agent).unwrap());
        // A packaged takeover alone does not mean the dev process has stopped.
        assert!(packaged.protecting(&agent, || Ok(())).is_err());
        assert!(dev.protecting(&agent, || Ok(())).is_err());
        assert!(!dev.claim(&agent).unwrap());
        assert!(packaged.protecting(&agent, || Ok(())).is_ok());
    }

    #[test]
    fn one_copy_runs_each_agent_until_it_lets_go() {
        let dir = tempfile::tempdir().unwrap();
        let (first, second) = ("a".repeat(64), "b".repeat(64));
        let one = hosting(Ok(dir.path().join("hosts")), false);
        let other = hosting(Ok(dir.path().join("hosts")), false);
        assert!(one.claim(&first).unwrap());
        assert!(one.claim(&first).unwrap());
        assert!(!other.claim(&first).unwrap());
        assert!(other.claim(&second).unwrap());
        // As when that copy quits.
        drop(one);
        assert!(other.claim(&first).unwrap());
        assert!(other.claim("../x").is_err());
    }

    #[test]
    fn a_packaged_app_runs_what_it_can_and_dev_builds_let_go() {
        let dir = tempfile::tempdir().unwrap();
        let (agent, other) = ("a".repeat(64), "b".repeat(64));
        let dev = hosting(Ok(dir.path().join("hosts")), false);
        let packaged = hosting(Ok(dir.path().join("hosts")), true);
        assert!(dev.claim(&agent).unwrap());
        assert!(dev.claim(&other).unwrap());
        // The packaged app runs it at once, though the dev build had it first,
        assert!(packaged.claim(&agent).unwrap());
        // and the dev build lets go at its next claim.
        assert!(!dev.claim(&agent).unwrap());
        assert!(packaged.claim(&agent).unwrap());
        // A second dev build cannot take it either.
        let another = hosting(Ok(dir.path().join("hosts")), false);
        assert!(!another.claim(&agent).unwrap());
        // One the packaged app does not ask for stays with the dev build.
        assert!(dev.claim(&other).unwrap());
        // As when it can no longer run it.
        packaged.held().remove(&agent);
        assert!(dev.claim(&agent).unwrap());
        assert!(!another.claim(&agent).unwrap());
    }

    #[test]
    fn dev_builds_let_go_while_the_installed_app_runs_an_agent() {
        use crate::sign_out::legacy_identifier::{agents, CURRENT, DEV};
        let data = tempfile::tempdir().unwrap();
        // Where each copy's agent list puts its locks, with separate app data.
        let hosts =
            |identifier: &str| Ok(agents(identifier, &data.path().join(identifier)).join("hosts"));
        let agent = "a".repeat(64);
        let dev = hosting(hosts(DEV), false);
        assert!(dev.claim(&agent).unwrap());
        let packaged = hosting(hosts(CURRENT), true);
        assert!(packaged.claim(&agent).unwrap());
        assert!(!dev.claim(&agent).unwrap());
        let another = hosting(hosts(DEV), false);
        assert!(!another.claim(&agent).unwrap());
        // As when the installed app quits.
        drop(packaged);
        assert!(dev.claim(&agent).unwrap());
        assert!(!another.claim(&agent).unwrap());
    }
    #[tokio::test]
    async fn late_media_body_is_not_committed_after_agent_deletion() {
        use crate::federated_identity::agent::tests::response_fixture;
        use sha2::{Digest, Sha256};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for change in ["delete", "sign-out", "expiry"] {
            let f = response_fixture().await;
            let admission = f
                .tokens
                .authorize(&f.agent, &f.key, Stamp::default())
                .await
                .unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let body = b"held media";
            let url = format!("{origin}/media/{:x}", Sha256::digest(body));
            let (release, released) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(socket.read_u8().await.unwrap());
                }
                socket
                    .write_all(
                        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len())
                            .as_bytes(),
                    )
                    .await
                    .unwrap();
                released.await.unwrap();
                socket.write_all(body).await.unwrap();
            });
            admission.dispatch().unwrap();
            let response = reqwest::get(&url).await.unwrap();
            // Headers prove dispatch; the fixture holds all body bytes meanwhile.
            match change {
                "delete" => f
                    .tokens
                    .forget(&f.agent.owner, &f.agent.pubkey)
                    .await
                    .unwrap(),
                "sign-out" => {
                    f.tokens.sign_out(None).await.unwrap();
                }
                _ => {
                    tokio::time::pause();
                    tokio::time::advance(Duration::from_secs(600)).await;
                }
            }
            release.send(()).unwrap();
            let dir = tempfile::tempdir().unwrap();
            let agent = AppAgent {
                relay: origin,
                ..f.agent
            };
            let result =
                save_media_admitted(&agent, &url, response, dir.path(), Some(&admission)).await;
            server.await.unwrap();
            if change == "expiry" {
                tokio::time::resume();
                assert!(
                    result.is_ok(),
                    "elapsed assertion TTL cannot retire an admitted download"
                );
                assert!(admission.dispatch().is_err());
            } else {
                assert!(result.is_err());
                assert_eq!(
                    std::fs::read_dir(dir.path()).unwrap().count(),
                    0,
                    "no completed or staging file survives"
                );
            }
        }
    }

    #[tokio::test]
    async fn scheduled_picture_commit_cannot_overwrite_a_reimported_row() {
        let key = Secret::generate().unwrap();
        let owner = attestation(key.pubkey())[1].clone();
        let dir = tempfile::tempdir().unwrap();
        let host = AppAgentHost {
            agents: Ok(AppAgents::open(dir.path().join("identities.json"))),
            old: Err("unused".into()),
            credentials: Arc::new(Gated::default()),
            keys: Arc::default(),
            profiles: Arc::default(),
            removals: Arc::default(),
            hosting: Arc::new(hosting(Err("unused".into()), true)),
            tokens: AgentTokens::unconfigured(),
            protection_upgrade: Arc::default(),
        };
        let import = || {
            let prepared = AppAgents::adopt(
                "https://relay.example/",
                &owner,
                "p/t",
                Secret::parse(&key.hex(), key.pubkey()).unwrap(),
                "Ada",
                None,
                None,
            )
            .unwrap();
            let host = host.clone();
            let auth = attestation(key.pubkey());
            async move { host.install(prepared, auth).await.unwrap() }
        };
        let (old, key, incarnation) = import().await;
        let other = host
            .agents()
            .unwrap()
            .join(
                &old.pubkey,
                &old.relay,
                "wss://other.example",
                None,
                host.credentials.as_ref(),
            )
            .unwrap();
        let other_admission = host
            .tokens
            .authorize(&other, &key, incarnation)
            .await
            .unwrap();
        let admission = host
            .tokens
            .authorize(&old, &key, incarnation)
            .await
            .unwrap();
        let (held, reached) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let agents = host.agents().unwrap();
        let updating = blocking(move || {
            held.send(()).unwrap();
            released.recv().unwrap();
            admission.commit(true, || {
                agents.set_picture(
                    &old.pubkey,
                    &old.relay,
                    Some("https://relay.example/media/old".into()),
                )
            })
        });
        let replace = async {
            tokio::task::spawn_blocking(move || reached.recv().unwrap())
                .await
                .unwrap();
            let old = host
                .agents()
                .unwrap()
                .list()
                .unwrap()
                .into_iter()
                .find(|agent| agent.relay == "wss://relay.example")
                .unwrap();
            let agents = host.agents().unwrap();
            agents.begin_leave(&old.pubkey, &old.relay).unwrap();
            let removal = agents.hold_removal(&old.pubkey, &old.relay).unwrap();
            host.removals().held.insert(old.pubkey.clone(), removal);
            host.delete(old.pubkey.clone(), old.relay.clone())
                .await
                .unwrap();
            host.removals().held.remove(&old.pubkey);
            let new = host
                .agents()
                .unwrap()
                .join(
                    &old.pubkey,
                    "wss://other.example",
                    "wss://relay.example",
                    None,
                    host.credentials.as_ref(),
                )
                .unwrap();
            host.tokens.reopen_row(&new.pubkey, &new.relay).unwrap();
            host.agents()
                .unwrap()
                .set_picture(
                    &new.pubkey,
                    &new.relay,
                    Some("https://relay.example/media/new".into()),
                )
                .unwrap();
            release.send(()).unwrap();
        };
        let (result, ()) = tokio::join!(updating, replace);
        other_admission.dispatch().unwrap();
        other_admission.commit(false, || Ok(())).unwrap();
        assert!(result.is_err());
        assert_eq!(
            host.agents()
                .unwrap()
                .list()
                .unwrap()
                .iter()
                .find(|agent| !agent.deleted && agent.relay == "wss://relay.example")
                .unwrap()
                .picture
                .as_deref(),
            Some("https://relay.example/media/new")
        );
    }
    #[tokio::test]
    async fn query_body_held_past_sign_out_is_not_admitted() {
        use crate::federated_identity::agent::tests::response_fixture;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let f = response_fixture().await;
        let admission = f
            .tokens
            .authorize(&f.agent, &f.key, Stamp::default())
            .await
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (held, reached) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                head.push(socket.read_u8().await.unwrap());
            }
            let text = String::from_utf8(head).unwrap();
            let length: usize = text
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .map(str::to_owned)
                })
                .unwrap()
                .parse()
                .unwrap();
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n[")
                .await
                .unwrap();
            held.send(()).unwrap();
            released.await.unwrap();
            socket.write_all(b"]").await.unwrap();
            text
        });
        // Use the loopback server as the community transport; all credentials
        // and assertions are synthetic. Exercise the production signed read.
        let agent = AppAgent {
            relay: origin,
            ..f.agent.clone()
        };
        let filters = vec![serde_json::json!({"kinds":[1]})];
        let query = admission.run(false, read(&agent, &f.key, admission.header(), &filters));
        let retire = async {
            reached.await.unwrap();
            f.tokens.sign_out(None).await.unwrap();
            release.send(()).unwrap();
        };
        let (result, ()) = tokio::join!(query, retire);
        assert!(result.is_err(), "a retired query returned its parsed body");
        assert!(server.await.unwrap().contains("nostr-federated-identity:"));
    }
    #[test]
    fn read_limit_mirrors_the_canvas_read_budget() {
        let policy = include_str!("../../src/features/channel-templates/canvas-limits.ts");
        assert_eq!(READ_LIMIT, 8 * 1024 * 1024);
        assert!(policy.contains("export const CANVAS_READ_BYTES = 8 * 1024 * 1024;"));
    }
    #[tokio::test]
    async fn bounded_admits_the_limit_and_refuses_one_byte_over() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (size, admitted) in [(READ_LIMIT, true), (READ_LIMIT + 1, false)] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(socket.read_u8().await.unwrap());
                }
                let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {size}\r\n\r\n");
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(&vec![b'x'; size]).await;
            });
            let response = reqwest::get(&url).await.unwrap();
            let body = bounded(response, READ_LIMIT).await;
            assert_eq!(body.map(|b| b.len()).ok(), admitted.then_some(size));
            server.abort();
        }
    }
}
