//! Native sign-in server session owners, one per compiled server. Secrets and
//! adapter responses never cross IPC.
pub(crate) mod access;
pub(crate) mod agent;
pub(crate) mod assertion;
pub(crate) mod config;
mod customers;
pub(crate) mod protocol;
pub(crate) mod socket;
pub(crate) mod store;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use config::Config;
use customers::Customers;
use protocol::{expiry, now, Failure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use store::Store;
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{watch, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Authority {
    id: String,
    identity_origin: String,
    api_base_path: String,
    sign_in: config::SignIn,
    organization: Option<String>,
    /// The community hosts this server covers, matched as `matches_relay`
    /// does; the front end routes with them instead of its own rules.
    community_hosts: Vec<String>,
}
#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Status {
    Unconfigured,
    SignedOut,
    SigningIn,
    Restoring,
    SignedIn,
    ReauthenticationRequired,
    Unavailable,
}
/// Why the signed-in account changed, for owners of state derived from it
/// (agent grants). Expiry and refresh keep the same account; only an explicit
/// sign-out or a different account mean derived state must go.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SessionChange {
    SignedOut,
    AccountChanged,
    Expired,
    Refreshed,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    status: Status,
    authority: Option<Authority>,
    revision: String,
    email: Option<String>,
    failure: Option<&'static str>,
    expires_at: Option<String>,
    /// The session ends soon; signing in again now keeps the app open.
    expiring: bool,
    /// A retired session's record is still stored because removing it
    /// failed. Signing out again retries the removal.
    cleanup: bool,
    /// Signing in again waits on the browser while this session stays live;
    /// `cancel_sign_in` ends only that wait. False once it commits.
    renewing: bool,
}

// No Debug, no IPC serialization. Only the secure store serializes this record.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Record {
    version: u8,
    fingerprint: String,
    pub(super) revision: String,
    session_token: String,
    expires_at: String,
    email: Option<String>,
}
impl Drop for Record {
    fn drop(&mut self) {
        self.session_token.zeroize();
    }
}
struct Session {
    record: Record,
    raw: Zeroizing<Vec<u8>>,
    /// Unix seconds at exchange, kept in memory only so the stored record
    /// stays readable by shipped builds; 0 for a restored session.
    issued_at: i64,
}
#[derive(Clone)]
struct CallbackGuard(crate::oauth_callback::OAuthCallbackHost, String);
impl Drop for CallbackGuard {
    fn drop(&mut self) {
        let _ = self.0.cancel(&self.1);
    }
}
struct State {
    snapshot: Snapshot,
    session: Option<Arc<Session>>,
    restored: bool,
    /// Completed restore attempts, shared by callers queued on operation. A
    /// sign-out ends every attempt begun before it.
    restore_attempt: u64,
    restore_retry_at: Option<tokio::time::Instant>,
    closed: bool,
    cancellation: CancellationToken,
    callback: Option<CallbackGuard>,
    /// A sign-in started while signed in; the current session stays live.
    renewal: Option<CancellationToken>,
    /// Last account seen signed in this run; tells a refresh from a new account.
    account: Option<Option<String>>,
    /// Bumped with every explicit sign-out, close or change of account, under
    /// the same lock as the change itself: derived agent credentials minted
    /// or stored under an older value are retired.
    retirements: u64,
    /// Set by an explicit sign-out and kept on disk (`Inner::signed_out`):
    /// the next sign-in asks for credentials instead of finishing on the
    /// browser's session as the account just signed out. Only a completed
    /// browser sign-in clears it; a restored session takes the file as it
    /// is, so a restore checked before another copy's sign-out cannot erase
    /// that sign-out. Expiry, refusals and close never set it.
    force_login: bool,
}
impl State {
    /// What a sign-in asks of the identity provider: the caller's `start`,
    /// with credentials after an explicit sign-out (`force_login`).
    fn asking(&self, start: LoginStart) -> LoginStart {
        LoginStart {
            force_login: start.force_login || self.force_login,
            ..start
        }
    }
}
struct Inner {
    config: Option<Config>,
    fingerprint: String,
    #[allow(dead_code)] // Consumed by the agent token client.
    account: String,
    store: Arc<dyn Store>,
    state: Mutex<State>,
    operation: AsyncMutex<()>,
    changes: watch::Sender<Snapshot>,
    account_changes: watch::Sender<Option<SessionChange>>,
    agent_tokens: Mutex<std::sync::Weak<agent::Inner>>,
    assertions: Mutex<assertion::AssertionCache>,
    discoveries: Mutex<assertion::DiscoveryCache>,
    retiring: Mutex<Option<Retiring>>,
    /// Holds the next renewal between recording its retirement and installing.
    #[cfg(test)]
    install_gate: Mutex<Option<testing::Gate>>,
    /// The build's other sign-in servers, each with its own session. Only the
    /// first server, the build's Builderlab, has them.
    peers: Vec<FederatedIdentity>,
    /// How this first server adds Builderlab customers' servers
    /// (`customers::builderlab_customer`), when the build trusts the built-in one.
    customers: Option<Customers>,
    /// Those servers, each added the first time one of its communities is
    /// routed, and again at every later launch (`Customers::record`).
    derived: Mutex<Vec<FederatedIdentity>>,
    /// What each added server gets, as compiled peers get it at startup.
    on_peer: Mutex<Vec<OnPeer>>,
    /// Where `State::force_login` is kept, so a restart still asks.
    signed_out: Option<std::path::PathBuf>,
    /// Each detached logout `revoke` started, so tests can wait for it.
    #[cfg(test)]
    revocations: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
    /// Each browser step's start URL, so tests can read what it asked for.
    #[cfg(test)]
    logins: Mutex<Vec<String>>,
}
/// Records durably, before a sign-out or change of account commits, what
/// else that retirement revokes; see [`FederatedIdentity::on_retire`]. The
/// change holds what it returns until it has committed or failed.
pub(crate) type Retiring = Arc<
    dyn Fn() -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Option<RetiringGuard>, String>> + Send>,
        > + Send
        + Sync,
>;
pub(crate) type RetiringGuard = Box<dyn Send + Sync>;
/// Prepares a server added after startup; see [`FederatedIdentity::on_peer`].
pub(crate) type OnPeer = Arc<dyn Fn(&FederatedIdentity) + Send + Sync>;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
/// A sign-in server's session. The app holds the build's first server, which
/// routes each community to its own server (`server_for`).
#[derive(Clone)]
pub(crate) struct FederatedIdentity(Arc<Inner>);

impl FederatedIdentity {
    pub(crate) fn new() -> Result<Self, String> {
        let servers = option_env!("BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG")
            .filter(|raw| !raw.is_empty())
            .map(Config::parse_list)
            .transpose()?
            .unwrap_or_default();
        let profile = std::env::var("BUZZODZ_PROFILE").unwrap_or_else(|_| "default".into());
        if profile.is_empty() || profile.len() > 128 {
            return Err("Invalid federated identity profile".into());
        }
        let customers = servers.iter().any(Config::is_built_in);
        let mut servers = servers.into_iter().map(Some);
        let first = servers.next().flatten();
        let peers = servers
            .map(|config| Self::open(config, &profile, Vec::new(), false))
            .collect::<Result<_, _>>()?;
        Self::open(first, &profile, peers, customers)
    }
    /// Each server's sessions are stored under its own descriptor, so a
    /// build's first server keeps the sessions it saved as the only one.
    fn open(
        config: Option<Config>,
        profile: &str,
        peers: Vec<FederatedIdentity>,
        customers: bool,
    ) -> Result<Self, String> {
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&config.as_ref().map(Config::identity))
                    .map_err(|_| "Invalid federated identity configuration")?
            )
        );
        let account = format!("{:x}", Sha256::digest(format!("{profile}\0{fingerprint}")));
        let root = store::root()?;
        let customers = customers.then(|| Customers {
            profile: profile.into(),
            record: Some(root.join(format!("{account}.customers"))),
        });
        let signed_out = Some(root.join(format!("{account}.signed-out")));
        let store = Arc::new(store::SecureStore {
            account: account.clone(),
            root,
            bundled: store::BUNDLED,
        });
        Ok(Self::build(
            config,
            fingerprint,
            account,
            store,
            peers,
            customers,
            signed_out,
        ))
    }
    #[cfg(test)]
    fn with_store(
        config: Option<Config>,
        fingerprint: String,
        account: String,
        store: Arc<dyn Store>,
    ) -> Self {
        Self::build(config, fingerprint, account, store, Vec::new(), None, None)
    }
    fn build(
        config: Option<Config>,
        fingerprint: String,
        account: String,
        store: Arc<dyn Store>,
        peers: Vec<FederatedIdentity>,
        customers: Option<Customers>,
        signed_out: Option<std::path::PathBuf>,
    ) -> Self {
        let force_login = signed_out.as_deref().is_some_and(std::path::Path::exists);
        let snapshot = Snapshot {
            status: if config.is_some() {
                Status::Restoring
            } else {
                Status::Unconfigured
            },
            authority: config.as_ref().map(|c| Authority {
                id: c.id.clone(),
                identity_origin: c.identity_origin.clone(),
                api_base_path: c.api_base_path.clone(),
                sign_in: c.sign_in,
                organization: c.organization.clone(),
                community_hosts: c.community_hosts.clone(),
            }),
            revision: uuid::Uuid::new_v4().to_string(),
            email: None,
            failure: None,
            expires_at: None,
            expiring: false,
            cleanup: false,
            renewing: false,
        };
        let (changes, _) = watch::channel(snapshot.clone());
        let (account_changes, _) = watch::channel(None);
        let identity = Self(Arc::new(Inner {
            config,
            fingerprint,
            account,
            store,
            state: Mutex::new(State {
                snapshot,
                session: None,
                restored: false,
                restore_attempt: 0,
                restore_retry_at: None,
                closed: false,
                retirements: 0,
                cancellation: CancellationToken::new(),
                callback: None,
                renewal: None,
                account: None,
                force_login,
            }),
            operation: AsyncMutex::new(()),
            changes,
            account_changes,
            #[cfg(test)]
            install_gate: Mutex::default(),
            agent_tokens: Mutex::default(),
            assertions: Mutex::new(Default::default()),
            discoveries: Mutex::new(Default::default()),
            retiring: Mutex::default(),
            peers,
            customers,
            derived: Mutex::default(),
            on_peer: Mutex::default(),
            signed_out,
            #[cfg(test)]
            revocations: Mutex::default(),
            #[cfg(test)]
            logins: Mutex::default(),
        }));
        // Every customer server added before, so its grants and session are
        // reachable whether or not its communities are still joined.
        let known = identity.0.customers.as_ref().map(Customers::hosts);
        for host in known.into_iter().flatten() {
            if let Err(error) = identity.server_for(&format!("wss://{host}")) {
                eprintln!("A Builderlab customer's sign-in server was not added: {error}");
            }
        }
        identity
    }
    /// The server for a canonical relay, chosen by its host from the
    /// compiled list, else the Builderlab customer's server its host names,
    /// never by the relay. A community no server covers stays with this one,
    /// which attaches no token for it.
    pub(crate) fn server_for(&self, relay: &str) -> Result<Self, String> {
        let compiled = || std::iter::once(self).chain(&self.0.peers);
        for server in compiled() {
            if let Some(config) = &server.0.config {
                if config.matches_relay(relay)? {
                    return Ok(server.clone());
                }
            }
        }
        let (Some(customers), Some(config)) =
            (&self.0.customers, customers::builderlab_customer(relay))
        else {
            return Ok(self.clone());
        };
        let same = |server: &Self| server.config().is_some_and(|c| c.id == config.id);
        // Held while the server is made and prepared, so it is used only once
        // every `on_peer` hook has run. No hook may route a community or list
        // servers (`server_for`, `servers`, `peers`): that would deadlock.
        let mut derived = lock(&self.0.derived);
        if let Some(server) = derived.iter().find(|server| same(server)) {
            return Ok(server.clone());
        }
        // A compiled server already has that id: the community has none.
        // Nor does it once the app is closing.
        if compiled().any(same) || self.closed() {
            return Ok(self.clone());
        }
        let host = config.community_hosts[0].clone();
        let server = Self::open(Some(config), &customers.profile, Vec::new(), false)?;
        // Listed first, so no grant is ever stored with a server a later
        // launch would not add again.
        customers.remember(&host)?;
        for prepare in lock(&self.0.on_peer).iter() {
            prepare(&server);
        }
        derived.push(server.clone());
        Ok(server)
    }
    /// Has every server added after startup, and each one added already,
    /// first get `prepare`. It runs holding the list of added servers, so it
    /// must not route a community or list servers (see `server_for`).
    pub(crate) fn on_peer(&self, prepare: OnPeer) {
        let derived = lock(&self.0.derived);
        for server in derived.iter() {
            prepare(server);
        }
        lock(&self.0.on_peer).push(prepare);
    }
    /// The other servers: compiled peers, then those added since.
    fn peers(&self) -> Vec<Self> {
        let mut peers = self.0.peers.clone();
        peers.extend(lock(&self.0.derived).iter().cloned());
        peers
    }
    /// This server, then its peers: every configured sign-in server.
    fn servers(&self) -> Vec<Self> {
        std::iter::once(self.clone())
            .chain(self.peers())
            .filter(|server| server.0.config.is_some())
            .collect()
    }
    /// The server named by a sign-in command, by community or by id: this
    /// one with neither.
    fn server_for_command(
        &self,
        relay: Option<&str>,
        server: Option<&str>,
    ) -> Result<Self, String> {
        match (relay, server) {
            (Some(relay), None) => self.server_for(&config::canonical_relay(relay)?),
            (None, Some(id)) => self
                .servers()
                .into_iter()
                .find(|server| server.0.config.as_ref().is_some_and(|c| c.id == id))
                .ok_or_else(|| "Unknown sign-in server".into()),
            (None, None) => Ok(self.clone()),
            (Some(_), Some(_)) => Err("Name a community or a sign-in server, not both".into()),
        }
    }
    pub(crate) fn is(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    /// Has every sign-out and change of account first record `retiring`
    /// durably; one it cannot record does not happen.
    pub(crate) fn on_retire(&self, retiring: Retiring) {
        *self
            .0
            .retiring
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(retiring);
    }
    pub(crate) async fn record_retirement(&self) -> Result<Option<RetiringGuard>, String> {
        let retiring = self
            .0
            .retiring
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        match retiring {
            Some(retiring) => retiring().await,
            None => Ok(None),
        }
    }
    fn publish(&self, state: &State) {
        self.0.changes.send_replace(state.snapshot.clone());
    }
    /// A build without NIP-FI configuration.
    #[cfg(test)]
    pub(crate) fn unconfigured() -> Self {
        let store = Arc::new(tests::Memory::default());
        Self::with_store(None, String::new(), String::new(), store)
    }
    pub(crate) fn snapshot(&self) -> Snapshot {
        self.state().snapshot.clone()
    }
    pub(crate) fn watch<R: tauri::Runtime>(&self, app: tauri::AppHandle<R>) {
        self.emit(app.clone(), "federated-identity");
        for peer in &self.0.peers {
            peer.emit(app.clone(), "federated-identity-community");
        }
        self.on_peer(Arc::new(move |peer| {
            peer.emit(app.clone(), "federated-identity-community");
        }));
    }
    fn emit<R: tauri::Runtime>(&self, app: tauri::AppHandle<R>, event: &'static str) {
        let mut changes = self.0.changes.subscribe();
        tauri::async_runtime::spawn(async move {
            while changes.changed().await.is_ok() {
                let snapshot = changes.borrow_and_update().clone();
                let _ = app.emit_to("main", event, snapshot);
            }
        });
    }
    pub(crate) fn cancellation_for(&self, revision: &str) -> Result<CancellationToken, String> {
        let state = self.state();
        if state.closed || state.snapshot.revision != revision {
            return Err("Federated session changed".into());
        }
        Ok(state.cancellation.clone())
    }
    #[allow(dead_code)] // Consumed by the agent token client.
    pub(crate) fn account_changes(&self) -> watch::Receiver<Option<SessionChange>> {
        self.0.account_changes.subscribe()
    }
    fn signal(&self, change: SessionChange) {
        self.0.account_changes.send_replace(Some(change));
    }
    /// Record a newly installed session's account and report refresh vs change.
    fn signed_in(&self, state: &mut State, email: Option<String>) {
        let change = match &state.account {
            Some(previous) if *previous != email => {
                state.retirements += 1;
                SessionChange::AccountChanged
            }
            _ => SessionChange::Refreshed,
        };
        state.account = Some(email);
        self.signal(change);
    }
    /// Make `session` current and watch for its expiry. The caller publishes
    /// and settles `State::force_login`.
    fn install_session(&self, state: &mut State, session: Arc<Session>) {
        state.snapshot.status = Status::SignedIn;
        state.snapshot.revision = session.record.revision.clone();
        state.snapshot.email = session.record.email.clone();
        state.snapshot.failure = None;
        state.snapshot.expires_at = Some(session.record.expires_at.clone());
        state.snapshot.expiring = false;
        state.snapshot.cleanup = false;
        self.signed_in(state, session.record.email.clone());
        self.watch_expiry(&session, state.cancellation.clone());
        state.session = Some(session);
    }
    /// Warn before the session ends, then end it at its expiry instead of
    /// waiting for the next assertion or 401 to notice.
    fn watch_expiry(&self, session: &Arc<Session>, cancel: CancellationToken) {
        let Ok(expires) = expiry(&session.record.expires_at) else {
            return;
        };
        let warn = warning_at(session.issued_at, expires);
        let revision = session.record.revision.clone();
        let owner = Arc::downgrade(&self.0);
        tokio::spawn(async move {
            let mut warned = false;
            loop {
                let Ok(now) = now() else { return };
                let wait = match due(now, warn, expires, warned) {
                    Due::Expire => break,
                    Due::Warn => {
                        warned = true;
                        let Some(owner) = owner.upgrade() else { return };
                        let owner = FederatedIdentity(owner);
                        let mut state = owner.state();
                        if state.closed || state.snapshot.revision != revision {
                            return;
                        }
                        state.snapshot.expiring = true;
                        owner.publish(&state);
                        continue;
                    }
                    Due::Wait(wait) => wait,
                };
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(wait) => {}
                }
            }
            if let Some(owner) = owner.upgrade() {
                FederatedIdentity(owner).restore().await;
            }
        });
    }
    /// This server's descriptor, signed in or not.
    pub(crate) fn config(&self) -> Option<&Config> {
        self.0.config.as_ref()
    }
    /// Lend the current session token to `use_session` without letting it escape.
    #[allow(dead_code)] // Consumed by the agent token client.
    pub(crate) fn with_session<T>(
        &self,
        use_session: impl FnOnce(&Zeroizing<String>, &str, &Config) -> T,
    ) -> Option<T> {
        let config = self.0.config.as_ref()?;
        let (token, revision) = {
            let state = self.state();
            let session = state.session.as_ref().filter(|_| !state.closed)?;
            (
                Zeroizing::new(session.record.session_token.clone()),
                state.snapshot.revision.clone(),
            )
        };
        Some(use_session(&token, &revision, config))
    }
    /// Secure-store account for an agent grant in this profile and deployment.
    #[allow(dead_code)] // Consumed by the agent token client.
    pub(crate) fn agent_grant_key(&self, owner: &str, agent: &str) -> String {
        store::agent_grant_key(&self.0.account, owner, agent)
    }
    /// The account a local pairing is bound to: the secure-store account and
    /// the signed-in email (`None` without NIP-FI or when signed out). `None`
    /// overall while that is not settled yet (restoring, signing in, expired,
    /// unavailable), so nothing is judged against a session still loading.
    pub(crate) fn pairing_account(&self) -> Option<(String, Option<String>)> {
        let state = self.state();
        let email = match state.snapshot.status {
            Status::SignedIn => state.snapshot.email.clone(),
            Status::Unconfigured | Status::SignedOut if !state.closed => None,
            _ => return None,
        };
        Some((self.0.account.clone(), email))
    }
    /// Whether the sign-in expired and the person must sign in again.
    pub(crate) fn expired(&self) -> bool {
        self.state().snapshot.status == Status::ReauthenticationRequired
    }
    /// How many times derived agent credentials have been retired this run.
    pub(crate) fn retirements(&self) -> u64 {
        self.state().retirements
    }
    /// Whether the identity was closed for good; nothing derived acts again.
    pub(crate) fn closed(&self) -> bool {
        self.state().closed
    }
    pub(crate) fn current(&self, revision: &str) -> bool {
        let state = self.state();
        !state.closed && state.snapshot.revision == revision
    }
    #[cfg(test)]
    fn retire(
        &self,
        status: Status,
        failure: Option<&'static str>,
    ) -> (Option<Arc<Session>>, String) {
        let mut state = self.state();
        let session = self.retire_state(&mut state, status, failure);
        (session, state.snapshot.revision.clone())
    }
    fn change_current(&self, revision: &str, status: Status, failure: Option<&'static str>) {
        let mut state = self.state();
        if state.closed || state.snapshot.revision != revision {
            return;
        }
        state.snapshot.status = status;
        state.snapshot.failure = failure;
        state.snapshot.cleanup = false;
        self.publish(&state);
    }
    /// Removing `revision`'s retired session from storage failed.
    fn cleanup_failed(&self, revision: &str, failure: &'static str) {
        let mut state = self.state();
        if state.closed || state.snapshot.revision != revision {
            return;
        }
        state.snapshot.status = Status::Unavailable;
        state.snapshot.failure = Some(failure);
        state.snapshot.cleanup = true;
        self.publish(&state);
    }
    /// Starts or ends a renewal's browser wait, and says so in the snapshot.
    fn set_renewal(&self, state: &mut State, renewal: Option<CancellationToken>) {
        let renewing = renewal.is_some();
        state.renewal = renewal;
        if state.snapshot.renewing != renewing {
            state.snapshot.renewing = renewing;
            self.publish(state);
        }
    }
    fn retire_state(
        &self,
        state: &mut State,
        status: Status,
        failure: Option<&'static str>,
    ) -> Option<Arc<Session>> {
        self.reset(state);
        state.snapshot.revision = uuid::Uuid::new_v4().to_string();
        state.snapshot.status = status;
        state.snapshot.email = None;
        state.snapshot.failure = failure;
        state.snapshot.expires_at = None;
        state.snapshot.expiring = false;
        state.snapshot.cleanup = false;
        let session = state.session.take();
        self.publish(state);
        session
    }
    /// End work tied to the current session, without changing the snapshot.
    fn reset(&self, state: &mut State) {
        self.0
            .assertions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        state.cancellation.cancel();
        // Synchronous cleanup lets a replacement login register immediately.
        state.callback.take();
        state.renewal = None;
        state.snapshot.renewing = false;
        state.cancellation = CancellationToken::new();
    }
    pub(crate) fn close(&self) {
        for peer in &self.0.peers {
            peer.close();
        }
        self.clear_discoveries();
        {
            let mut state = self.state();
            self.retire_state(&mut state, Status::SignedOut, None);
            state.closed = true;
            state.retirements += 1;
        }
        // After closing, so none is added that stays open (`server_for`).
        for peer in lock(&self.0.derived).iter() {
            peer.close();
        }
    }
    async fn storage<T: Send + 'static>(
        &self,
        run: impl FnOnce(Arc<dyn Store>) -> Result<T, &'static str> + Send + 'static,
    ) -> Result<T, Failure> {
        let store = self.0.store.clone();
        tauri::async_runtime::spawn_blocking(move || run(store))
            .await
            .map_err(|_| Failure::from("storage-unavailable"))?
            .map_err(Failure::from)
    }
    async fn remove(&self, session: Arc<Session>) -> Result<(), Failure> {
        self.storage(move |store| store.remove(&session.raw, &session.record.revision))
            .await
    }
    /// Remove the stored record of the session `revision` retired. Another
    /// Buzz copy may already have ended or replaced it: its refusal marker
    /// stays, so it can't restore here, and the newer session is left alone.
    async fn remove_retired(&self, session: Arc<Session>, revision: &str) {
        match self.remove(session).await {
            Err(failure) if failure.code != "session-changed" => {
                self.cleanup_failed(revision, failure.code)
            }
            _ => {}
        }
    }
    async fn verify(&self, record: &Record) -> Result<Option<String>, Failure> {
        if expiry(&record.expires_at)? <= now()? {
            return Err(Failure {
                code: "reauthentication-required",
                session_denied: true,
            });
        }
        #[derive(Deserialize)]
        struct Checked {
            expires_at: String,
            email: Option<String>,
        }
        let config = self.0.config.as_ref().ok_or("unconfigured")?;
        let client = protocol::client()?;
        let result: Checked = protocol::json(|| {
            client
                .get(config.endpoint("/v1/session"))
                .bearer_auth(&record.session_token)
        })
        .await?;
        let expected = chrono::DateTime::parse_from_rfc3339(&record.expires_at)
            .map_err(|_| "invalid-expiry")?;
        let actual = chrono::DateTime::parse_from_rfc3339(&result.expires_at)
            .map_err(|_| "invalid-expiry")?;
        if expected != actual || actual.timestamp() <= now()? {
            return Err("expiry-mismatch".into());
        }
        if result
            .email
            .as_ref()
            .is_some_and(|email| email.len() > 1024)
        {
            return Err("invalid-response".into());
        }
        Ok(result.email)
    }
    /// A granted call got 401. That alone never ends the session: ask the
    /// adapter once whether `revision`'s session still stands, and end it
    /// only when the adapter says it is gone.
    pub(crate) async fn recheck(&self, revision: &str) {
        let session = {
            let state = self.state();
            if state.closed || state.snapshot.revision != revision {
                return;
            }
            let Some(session) = state.session.clone() else {
                return;
            };
            session
        };
        let Err(failure) = self.verify(&session.record).await else {
            return;
        };
        if !failure.session_denied {
            return;
        }
        let retired = {
            let mut state = self.state();
            if state.closed || state.snapshot.revision != revision {
                return;
            }
            self.signal(SessionChange::Expired);
            self.retire_state(
                &mut state,
                Status::ReauthenticationRequired,
                Some(failure.code),
            )
            .map(|session| (session, state.snapshot.revision.clone()))
        };
        if let Some((session, revision)) = retired {
            self.remove_retired(session, &revision).await;
        }
    }
    pub(crate) async fn restore(&self) -> Snapshot {
        let attempt = {
            let state = self.state();
            let expired = state.session.as_ref().is_some_and(|session| {
                matches!((expiry(&session.record.expires_at), now()), (Ok(expiry), Ok(now)) if expiry <= now)
            });
            if self.0.config.is_none() || state.closed || (state.restored && !expired) {
                return state.snapshot.clone();
            }
            state.restore_attempt
        };
        let _operation = self.0.operation.lock().await;
        self.restore_locked(attempt).await;
        self.snapshot()
    }
    // Return this operation's revision so callers can fence concurrent retirement.
    async fn restore_locked(&self, attempt: u64) -> String {
        let (expired, revision) = {
            let mut state = self.state();
            let expired = state.session.as_ref().is_some_and(|session| {
                matches!((expiry(&session.record.expires_at), now()), (Ok(expiry), Ok(now)) if expiry <= now)
            });
            let session = if expired {
                self.signal(SessionChange::Expired);
                self.retire_state(
                    &mut state,
                    Status::ReauthenticationRequired,
                    Some("reauthentication-required"),
                )
                .map(|session| (session, state.snapshot.revision.clone()))
            } else {
                None
            };
            (session, state.snapshot.revision.clone())
        };
        if let Some((session, revision)) = expired {
            self.remove_retired(session, &revision).await;
        }
        {
            let state = self.state();
            if self.0.config.is_none()
                || state.restored
                || state.closed
                || state.restore_attempt != attempt
                || state
                    .restore_retry_at
                    .is_some_and(|at| at > tokio::time::Instant::now())
            {
                return revision;
            }
        }
        self.change_current(&revision, Status::Restoring, None);
        let result = async {
            let (raw, refusal) = self.storage(|store| store.load()).await?;
            let Some(raw) = raw else {
                return Ok(None);
            };
            if raw.len() > 64 * 1024 {
                return Err("storage-corrupt".into());
            }
            let mut record: Record =
                serde_json::from_slice(&raw).map_err(|_| Failure::from("storage-corrupt"))?;
            if record.version != 1
                || record.fingerprint != self.0.fingerprint
                || uuid::Uuid::parse_str(&record.revision).is_err()
                || record.session_token.is_empty()
                || record.session_token.len() > 4096
                || !record.session_token.bytes().all(|b| b.is_ascii_graphic())
            {
                return Err("storage-corrupt".into());
            }
            let refused = refusal.as_deref() == Some(&record.revision);
            let session = Arc::new(Session {
                record,
                raw,
                issued_at: 0,
            });
            if refused {
                self.remove(session).await?;
                return Ok(None);
            }
            let checked = self.verify(&session.record).await;
            match checked {
                Ok(email) => {
                    record = serde_json::from_slice(&session.raw)
                        .map_err(|_| Failure::from("storage-corrupt"))?;
                    record.email = email;
                    Ok(Some(Arc::new(Session {
                        record,
                        raw: session.raw.clone(),
                        issued_at: 0,
                    })))
                }
                Err(failure) if failure.session_denied => {
                    self.remove(session).await?;
                    Err(failure)
                }
                Err(failure) => Err(failure),
            }
        }
        .await;
        let (result, _retiring) = match result {
            Ok(Some(session)) => {
                match agent::AgentTokens::preparing_session(self, session.record.email.clone())
                    .await
                {
                    Ok(retiring) => (Ok(Some(session)), retiring),
                    Err(_) => (Err(Failure::from("storage-unavailable")), None),
                }
            }
            result => (result, None),
        };
        let mut state = self.state();
        // Cancellation is a completed attempt too: queued callers must not
        // verify its old stored record before sign-out finishes cleanup.
        state.restore_attempt += 1;
        if state.snapshot.revision != revision || state.closed {
            return revision;
        }
        state.restore_retry_at = match &result {
            Err(failure) if matches!(failure.code, "network-unavailable" | "network-timeout") => {
                Some(tokio::time::Instant::now() + std::time::Duration::from_secs(2))
            }
            _ => None,
        };
        state.restored = true;
        match result {
            Ok(Some(session)) => {
                self.install_session(&mut state, session);
                self.reread_signed_out(&mut state);
            }
            Ok(None) => state.snapshot.status = Status::SignedOut,
            Err(failure) => {
                if failure.session_denied {
                    self.signal(SessionChange::Expired);
                }
                state.snapshot.status = if failure.session_denied {
                    Status::ReauthenticationRequired
                } else {
                    Status::Unavailable
                };
                state.snapshot.failure = Some(failure.code);
                // A failed read or check is not permission to overwrite unknown state.
                state.restored = failure.session_denied;
            }
        }
        self.publish(&state);
        revision
    }
    /// A renewal that fails returns its failure code; it changes nothing else.
    /// `start` is what the browser step asks of the identity provider.
    pub(crate) async fn sign_in<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        start: LoginStart,
    ) -> Result<Snapshot, &'static str> {
        let (observed, attempt) = {
            let state = self.state();
            (state.snapshot.clone(), state.restore_attempt)
        };
        if observed.status == Status::SigningIn {
            return Ok(observed);
        }
        let operation = self.0.operation.lock().await;
        if !self.current(&observed.revision) {
            return Ok(self.snapshot());
        }
        // Other Buzz copies share this item: when one signed in after this
        // copy restored, restore its session instead of a browser sign-in.
        let signed_out = {
            let state = self.state();
            state.restored && state.session.is_none()
        };
        let attempt = if signed_out {
            let shared = matches!(self.storage(|store| store.read()).await, Ok(Some(_)));
            let mut state = self.state();
            // A sign-out or close during the read ends this sign-in.
            if state.closed || state.snapshot.revision != observed.revision {
                return Ok(state.snapshot.clone());
            }
            if shared {
                state.restored = false;
            }
            state.restore_attempt
        } else {
            attempt
        };
        let observed = self.restore_locked(attempt).await;
        let (revision, cancel, renewing, start) = {
            let mut state = self.state();
            if state.closed
                || state.snapshot.revision != observed
                || !state.restored
                || state.renewal.is_some()
                || self.0.config.is_none()
            {
                return Ok(state.snapshot.clone());
            }
            let start = state.asking(start);
            if state.session.is_some() {
                // Signing in again keeps the current session live until the
                // new one is installed; ending that session ends this attempt.
                let cancel = state.cancellation.child_token();
                self.set_renewal(&mut state, Some(cancel.clone()));
                (state.snapshot.revision.clone(), cancel, true, start)
            } else {
                // Admission and retirement are atomic with cancellation/sign-out.
                self.retire_state(&mut state, Status::SigningIn, None);
                (
                    state.snapshot.revision.clone(),
                    state.cancellation.clone(),
                    false,
                    start,
                )
            }
        };
        let result = self.login(app, &revision, &cancel, operation, start).await;
        if renewing {
            self.renewed(&revision, &cancel, result)?;
        } else if let Err(failure) = result {
            self.change_current(&revision, Status::SignedOut, Some(failure.code));
        }
        Ok(self.snapshot())
    }
    /// A renewal ended; on failure the current session stays as it was.
    fn renewed(
        &self,
        revision: &str,
        cancel: &CancellationToken,
        result: Result<(), Failure>,
    ) -> Result<(), &'static str> {
        let mut state = self.state();
        // Canceled, replaced or ended: whoever did that already settled it.
        if cancel.is_cancelled() || state.closed || state.snapshot.revision != revision {
            return Ok(());
        }
        self.set_renewal(&mut state, None);
        match result {
            Err(failure) if failure.code != "sign-in-canceled" => Err(failure.code),
            _ => Ok(()),
        }
    }
    async fn login<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        revision: &str,
        cancel: &CancellationToken,
        operation: tokio::sync::MutexGuard<'_, ()>,
        start: LoginStart,
    ) -> Result<(), Failure> {
        if cancel.is_cancelled() {
            return Err("sign-in-canceled".into());
        }
        let config = self.0.config.as_ref().ok_or("unconfigured")?;
        let mut bytes = Zeroizing::new([0u8; 32]);
        getrandom::fill(bytes.as_mut()).map_err(|_| "random-unavailable")?;
        let secret = Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes.as_ref()));
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(secret.as_bytes()));
        let login = login_start(config, &challenge, start);
        #[cfg(test)]
        self.0
            .logins
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(login.to_string());
        let callback = app.state::<crate::oauth_callback::OAuthCallbackHost>();
        let attempt = callback
            .begin_federated(
                &self.0.fingerprint,
                login.to_string(),
                |url| {
                    app.opener()
                        .open_url(url, None::<&str>)
                        .map_err(|_| "browser-unavailable".into())
                },
                crate::oauth_callback::capture_browser(app, login.as_str()),
            )
            .map_err(|_| "browser-unavailable")?;
        // Drop guards cancel only this callback when the whole login future is canceled.
        let _guard = CallbackGuard(callback.inner().clone(), attempt.id.clone());
        {
            let mut state = self.state();
            if state.closed || state.snapshot.revision != revision || cancel.is_cancelled() {
                return Err("sign-in-canceled".into());
            }
            state.callback = Some(_guard.clone());
        }
        // Serialize callback registration, not the user's browser interaction.
        drop(operation);
        let response = tokio::select! {
            _ = cancel.cancelled() => Err(Failure::from("sign-in-canceled")),
            result = callback.wait(&attempt.id) => result.map_err(|error| Failure::from(callback_failure(&error))),
        };
        let result = async {
            let response = response?;
            if response.parameters.iter().any(|(name, _)| name == "error") {
                return Err("login-refused".into());
            }
            let mut codes = response
                .parameters
                .into_iter()
                .filter(|(name, _)| name == "code");
            let code = Zeroizing::new(codes.next().ok_or("callback-refused")?.1);
            if codes.next().is_some() || code.is_empty() || code.len() > 4096 {
                return Err("callback-refused".into());
            }
            self.finish_login(code.as_str(), secret.as_str(), revision, cancel)
                .await
        }
        .await;
        if result.is_ok() {
            let (callback, app, owner) = (callback.inner().clone(), app.clone(), self.clone());
            // Publish sign-in immediately; the existing return owner handles its reading delay.
            tauri::async_runtime::spawn(async move {
                callback.complete(app, attempt.id.clone()).await;
                owner.clear_callback(&attempt.id);
                drop(_guard);
            });
        } else {
            self.clear_callback(&attempt.id);
        }
        result
    }

    fn clear_callback(&self, id: &str) {
        let mut state = self.state();
        if state.callback.as_ref().is_some_and(|guard| guard.1 == id) {
            state.callback.take();
        }
    }

    // Verified exchange and conditional installation form one native transaction.
    async fn finish_login(
        &self,
        code: &str,
        secret: &str,
        revision: &str,
        cancel: &CancellationToken,
    ) -> Result<(), Failure> {
        if cancel.is_cancelled() || !self.current(revision) {
            return Err("session-changed".into());
        }
        let config = self.0.config.as_ref().ok_or("unconfigured")?;
        #[derive(Deserialize)]
        struct Exchanged {
            session_token: String,
            expires_at: String,
        }
        impl Drop for Exchanged {
            fn drop(&mut self) {
                self.session_token.zeroize();
            }
        }
        let body = Zeroizing::new(
            serde_json::to_string(&serde_json::json!({"code":code,"handoff_secret":secret}))
                .map_err(|_| "invalid-request")?,
        );
        let client = protocol::client()?;
        let exchange: Exchanged = tokio::select! {
            _ = cancel.cancelled() => return Err("sign-in-canceled".into()),
            result = protocol::json(|| client.post(config.endpoint("/v1/login/exchange")).header("Content-Type", "application/json").body(body.as_str().to_owned())) => result?,
        };
        if exchange.session_token.is_empty()
            || exchange.session_token.len() > 4096
            || !exchange.session_token.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err("invalid-response".into());
        }
        let mut record = Record {
            version: 1,
            fingerprint: self.0.fingerprint.clone(),
            revision: uuid::Uuid::new_v4().to_string(),
            session_token: exchange.session_token.clone(),
            expires_at: exchange.expires_at.clone(),
            email: None,
        };
        record.email = tokio::select! {
            _ = cancel.cancelled() => return Err("sign-in-canceled".into()),
            result = self.verify(&record) => result?,
        };
        // Persistence/install/late cleanup still serialize with sign-out.
        let _operation = self.0.operation.lock().await;
        {
            let mut state = self.state();
            if cancel.is_cancelled() || state.closed || state.snapshot.revision != revision {
                return Err("session-changed".into());
            }
            // Commit point: past here a renewal can't be canceled, only ended
            // with its session, so nothing below has to undo a cancel.
            self.set_renewal(&mut state, None);
        }
        let changing = matches!(&self.state().account, Some(previous) if *previous != record.email);
        // Held until this renewal installs or fails.
        let _retiring = if changing {
            self.record_retirement()
                .await
                .map_err(|_| Failure::from("storage-unavailable"))?
        } else {
            None
        };
        #[cfg(test)]
        self.pass_install_gate().await;
        let prepared = agent::AgentTokens::preparing_session(self, record.email.clone())
            .await
            .map_err(|_| Failure::from("storage-unavailable"))?;
        let abandon = || async {
            if let Some(prepared) = prepared {
                prepared.abandon().await;
            }
        };
        let raw = Zeroizing::new(serde_json::to_vec(&record).map_err(|_| "storage-corrupt")?);
        let session = Arc::new(Session {
            record,
            raw,
            issued_at: now()?,
        });
        // A completed sign-in, including a renewal, is the newest choice: it
        // saves over whatever the shared item now holds, which another Buzz
        // copy may have written since this one restored. A write between the
        // read and the swap still fails as session-changed.
        let saved = session.clone();
        let written = self
            .storage(move |store| {
                let replacing = store.read()?;
                store.compare(
                    replacing.as_ref().map(|raw| raw.as_slice()),
                    Some(&saved.raw),
                )?;
                Ok(replacing)
            })
            .await;
        let replacing = match written {
            Ok(replacing) => replacing,
            Err(failure) => {
                abandon().await;
                return Err(failure);
            }
        };
        if !self.current(revision) {
            self.unsave(session, replacing).await?;
            abandon().await;
            return Err("session-changed".into());
        }
        let installed = {
            let mut state = self.state();
            if state.snapshot.revision == revision && !state.closed {
                if state.session.is_some() {
                    // A committed renewal keeps its return permission through the session reset.
                    let callback = state.callback.take();
                    self.reset(&mut state);
                    state.callback = callback;
                }
                // A completed browser sign-in is the account chosen.
                self.mark_signed_out(&mut state, false);
                self.install_session(&mut state, session.clone());
                self.publish(&state);
                true
            } else {
                false
            }
        };
        if !installed {
            self.unsave(session, replacing).await?;
            abandon().await;
            return Err("session-changed".into());
        }
        Ok(())
    }
    /// The session `session` was saved for ended before it was installed.
    /// Refuse `session` durably first, so a failure below never lets a restart
    /// restore it, then put back the record it replaced, which may be another
    /// copy's, for whoever ended that session to remove or leave alone. A
    /// failure leaves that removal to fail and report it.
    async fn unsave(
        &self,
        session: Arc<Session>,
        replaced: Option<Zeroizing<Vec<u8>>>,
    ) -> Result<(), Failure> {
        self.remove(session).await?;
        let Some(replaced) = replaced else {
            return Ok(());
        };
        self.storage(move |store| store.compare(None, Some(&replaced)))
            .await
    }
    pub(crate) fn cancel_sign_in(&self) {
        let mut state = self.state();
        if let Some(renewal) = state.renewal.take() {
            renewal.cancel();
            state.callback.take();
            self.set_renewal(&mut state, None);
        } else if state.snapshot.status == Status::SigningIn {
            self.retire_state(&mut state, Status::SignedOut, None);
        }
    }
    /// With agent grants, sign-out is `AgentTokens::sign_out`.
    /// With `expected`, only while that revision is current: a newer session
    /// is left signed in, and its snapshot answers.
    pub(crate) async fn sign_out(&self, expected: Option<&str>) -> Snapshot {
        match self.begin_sign_out(expected) {
            Some(retiring) => self.finish_sign_out(retiring).await,
            None => self.snapshot(),
        }
    }
    fn begin_sign_out(&self, expected: Option<&str>) -> Option<(Option<Arc<Session>>, String)> {
        let (session, revision) = {
            let mut state = self.state();
            if expected.is_some_and(|expected| state.snapshot.revision != expected) {
                return None;
            }
            let session = self.retire_state(&mut state, Status::SignedOut, None);
            // In the retirement's lock: no restore can take the new revision
            // and still be admitted on an older attempt.
            state.restore_attempt += 1;
            state.account = None;
            state.retirements += 1;
            self.mark_signed_out(&mut state, true);
            (session, state.snapshot.revision.clone())
        };
        self.signal(SessionChange::SignedOut);
        Some((session, revision))
    }
    /// Sets `State::force_login` and keeps it on disk, in the state lock, so
    /// the file follows the order of sign-outs and installs. A tiny local
    /// write, like `Customers::remember` in the `derived` lock. Always written
    /// or removed, since other Buzz copies with this profile share the file.
    /// A failed write still asks for credentials until this run ends or
    /// restores a session; a failed removal asks once more after a restart or
    /// restore. Neither changes the session.
    fn mark_signed_out(&self, state: &mut State, signed_out: bool) {
        state.force_login = signed_out;
        let Some(path) = &self.0.signed_out else {
            return;
        };
        let written = if signed_out {
            path.parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|()| std::fs::File::create(path))
                .and_then(|file| file.sync_all())
        } else {
            match std::fs::remove_file(path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                removed => removed,
            }
        };
        if written.is_err() {
            eprintln!("The sign-in server's sign-out mark could not be saved");
        }
    }
    /// Takes `State::force_login` from the shared file, for a restored
    /// session: the session may be older than another copy's sign-out, so
    /// only a browser sign-in, here or in another copy, clears it.
    fn reread_signed_out(&self, state: &mut State) {
        if let Some(path) = &self.0.signed_out {
            state.force_login = path.exists();
        }
    }
    async fn finish_sign_out(
        &self,
        (session, revision): (Option<Arc<Session>>, String),
    ) -> Snapshot {
        let _operation = self.0.operation.lock().await;
        let result = if let Some(session) = session {
            self.remove_retired(session.clone(), &revision).await;
            // Whatever the removal found: this copy's token only, never a
            // record read back from the item, which may be another copy's.
            self.revoke(&session);
            Ok(())
        } else {
            // Also retries an incomplete deletion or sign-out during restore.
            self.storage(|store| {
                if let Some(raw) = store.read()? {
                    let record: Record =
                        serde_json::from_slice(&raw).map_err(|_| "storage-corrupt")?;
                    store.remove(&raw, &record.revision)?;
                }
                Ok(())
            })
            .await
        };
        if let Err(failure) = result {
            self.cleanup_failed(&revision, failure.code);
        }
        self.snapshot()
    }
    /// Ask the server to end a signed-out session, so no copy of its token
    /// still works. Best effort: one detached attempt whose result is ignored,
    /// so sign-out never waits for it and works offline. Kgoose takes the
    /// session only in this header and answers with a redirect, not followed.
    fn revoke(&self, session: &Session) {
        let Some(config) = &self.0.config else { return };
        let (Ok(client), Ok(mut credential)) = (
            protocol::client(),
            reqwest::header::HeaderValue::from_str(&session.record.session_token),
        ) else {
            return;
        };
        credential.set_sensitive(true);
        let request = client
            .post(format!(
                "{}{}v1/auth/logout",
                config.identity_origin, config.api_base_path
            ))
            .header("X-BB-Session-Credential", credential);
        let _revocation = tauri::async_runtime::spawn(async move {
            let _ = request.send().await;
        });
        #[cfg(test)]
        self.0
            .revocations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(_revocation);
    }
}

/// The failure code for a browser callback that did not arrive. A timeout keeps
/// its own code: the person may still be signing up or verifying their email.
fn callback_failure(error: &str) -> &'static str {
    match error {
        "Sign-in canceled." => "sign-in-canceled",
        crate::oauth_callback::TIMED_OUT => "sign-in-timed-out",
        _ => "callback-refused",
    }
}

/// When to warn that a session ends: 72 hours ahead, so a weekend can't
/// swallow the warning, but no earlier than halfway through its lifetime.
fn warning_at(issued: i64, expires: i64) -> i64 {
    const LEAD: i64 = 72 * 60 * 60;
    let lead = if issued > 0 {
        LEAD.min((expires - issued).max(0) / 2)
    } else {
        LEAD
    };
    expires - lead
}
#[derive(Debug, PartialEq, Eq)]
enum Due {
    Warn,
    Expire,
    Wait(std::time::Duration),
}
/// The expiry watch's next step at wall-clock `now`. Waits are capped
/// because the monotonic clock stops while the machine sleeps; after a wake
/// the wall clock decides.
fn due(now: i64, warn: i64, expires: i64, warned: bool) -> Due {
    const POLL: i64 = 60;
    if now >= expires {
        Due::Expire
    } else if !warned && now >= warn {
        Due::Warn
    } else {
        let next = if warned { expires } else { warn };
        Due::Wait(std::time::Duration::from_secs((next - now).min(POLL) as u64))
    }
}

/// What the browser step asks of the identity provider (`login_start`).
#[derive(Clone, Copy, Default)]
pub(crate) struct LoginStart {
    /// The sign-up screen. Only an explicit Create account asks for it: kgoose
    /// answers the hint with Auth0's sign-up even over an existing session, so
    /// a restart, which usually follows sign-up, must not.
    signup: bool,
    /// Credentials over the browser's session, which would otherwise finish
    /// the sign-in as the account Use a different account just left. After
    /// an explicit sign-out the server asks for them whatever the caller
    /// passes (`State::force_login`).
    force_login: bool,
}

/// The browser step's start URL.
fn login_start(config: &Config, challenge: &str, start: LoginStart) -> url::Url {
    let mut login = config.endpoint("/v1/login/start");
    login
        .query_pairs_mut()
        .append_pair("handoff_challenge", challenge)
        .append_pair("handoff_challenge_method", "S256");
    if start.signup {
        login.query_pairs_mut().append_pair("screen_hint", "signup");
    }
    if start.force_login {
        login.query_pairs_mut().append_pair("prompt", "login");
    }
    login
}

// `relay` names the community a sign-in is for and `server` a sign-in
// server's id; with neither, the build's Builderlab.
#[tauri::command]
pub(crate) async fn federated_identity_snapshot(
    host: tauri::State<'_, FederatedIdentity>,
    relay: Option<String>,
    server: Option<String>,
) -> Result<Snapshot, String> {
    Ok(host
        .server_for_command(relay.as_deref(), server.as_deref())?
        .restore()
        .await)
}
/// Every configured sign-in server's session, the build's Builderlab first.
#[tauri::command]
pub(crate) async fn federated_identity_servers(
    host: tauri::State<'_, FederatedIdentity>,
) -> Result<Vec<Snapshot>, String> {
    let mut snapshots = Vec::new();
    for server in host.servers() {
        snapshots.push(server.restore().await);
    }
    Ok(snapshots)
}
/// Whether a community requires NIP-FI, from the `/info` discovery its
/// server shares with admission. A community that doesn't is reached with the
/// key alone, whatever that server's session does.
#[tauri::command]
pub(crate) async fn federated_identity_requires(
    host: tauri::State<'_, FederatedIdentity>,
    relay: String,
) -> Result<bool, String> {
    let relay = config::canonical_relay(&relay)?;
    host.server_for(&relay)?
        .requires_federated_identity(&relay)
        .await
}
/// The user asked to try a community again: its next admission asks the
/// issuer again instead of repeating a refusal cached this session (NIP-FA).
#[tauri::command]
pub(crate) fn federated_identity_ask_again(
    host: tauri::State<'_, FederatedIdentity>,
    relay: String,
) -> Result<(), String> {
    let relay = config::canonical_relay(&relay)?;
    // Only a server that exists has refusals cached, so asking again never
    // makes one (or records its host). Keys end with the relay, so other
    // communities keep theirs.
    for server in host.servers() {
        server.forget_refusals(&relay);
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn federated_identity_sign_in<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    host: tauri::State<'_, FederatedIdentity>,
    relay: Option<String>,
    server: Option<String>,
    signup: Option<bool>,
    force_login: Option<bool>,
) -> Result<Snapshot, String> {
    let start = LoginStart {
        signup: signup.unwrap_or(false),
        force_login: force_login.unwrap_or(false),
    };
    let server = host.server_for_command(relay.as_deref(), server.as_deref())?;
    server.sign_in(&app, start).await.map_err(String::from)
}
#[tauri::command]
pub(crate) fn federated_identity_cancel_sign_in(
    host: tauri::State<'_, FederatedIdentity>,
    relay: Option<String>,
    server: Option<String>,
) -> Result<(), String> {
    host.server_for_command(relay.as_deref(), server.as_deref())?
        .cancel_sign_in();
    Ok(())
}
#[tauri::command]
pub(crate) async fn federated_identity_sign_out(
    host: tauri::State<'_, FederatedIdentity>,
    tokens: tauri::State<'_, agent::AgentTokens>,
    relay: Option<String>,
    server: Option<String>,
    revision: Option<String>,
) -> Result<Snapshot, String> {
    let server = host.server_for_command(relay.as_deref(), server.as_deref())?;
    match tokens.for_server(&server) {
        Some(tokens) => tokens.sign_out(revision.as_deref()).await,
        None => Ok(server.sign_out(revision.as_deref()).await),
    }
}

#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;
