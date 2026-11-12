//! Purpose-bound native backup and optional recovery. No key or recovery credential crosses IPC.
mod crypto;
mod persistence;
pub(crate) use persistence::root as storage_root;

use crate::{
    federated_identity::FederatedIdentity,
    identity::IdentityHost,
    nsec_backup_config::Config,
    oauth_callback::{OAuthCallbackHost, OAuthRequest},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use buzz_nsec_backup::{Client, Recovery};
use secp256k1::{PublicKey, Secp256k1, SecretKey, XOnlyPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{async_runtime::JoinHandle, ipc::Channel};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;
use zeroize::Zeroizing;

const RETRY: &str = "Could not restore your identity. Try again.";
const CANCELED: &str = "Restore was canceled. Try again.";
/// Builderlab didn't answer: a network or connection failure, not a refusal.
const OFFLINE: &str = "Couldn't reach Builderlab. Check your connection and try again.";
// The renderer matches these two to offer manual key entry instead of a retry
// (`recoveryOff` in `src/features/identity/service.ts`).
const UNAVAILABLE: &str = "Backup recovery is unavailable.";
const REFUSED: &str = "Backup recovery is not offered for this account.";
/// Restore's own callback slot, so it never waits on a server's FI sign-in.
const RESTORE_CALLBACK_OWNER: &str = "nsec-restore";
type Result<T> = std::result::Result<T, String>;

struct Candidate {
    handle: String,
    pubkey: String,
    backup_id: String,
    secret: Box<Zeroizing<[u8; 32]>>,
}
#[derive(Serialize)]
pub(crate) struct PublicCandidate {
    handle: String,
    pubkey: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreResult {
    candidates: Vec<PublicCandidate>,
    current_pubkey: Option<String>,
    failed_count: usize,
}
#[derive(Serialize)]
pub(crate) struct RestoreStarted {
    attempt: String,
}
struct Restore {
    id: String,
    admission: Arc<Mutex<bool>>,
    callback: OAuthCallbackHost,
    callback_id: String,
    task: JoinHandle<()>,
    result: Option<oneshot::Receiver<Result<RestoreResult>>>,
    candidates: Vec<Candidate>,
    current: Option<String>,
    credential: Option<Zeroizing<String>>,
    subject: Option<String>,
    installing: bool,
}
impl Drop for Restore {
    fn drop(&mut self) {
        *self.admission.lock().unwrap_or_else(|e| e.into_inner()) = false;
        self.task.abort();
        let _ = self.callback.cancel(&self.callback_id);
    }
}
/// What the uploader last did for this device's key. `seq` orders snapshots
/// against pushed messages; `pass` answers a handoff's ticket.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupStatus {
    seq: u64,
    pass: u64,
    /// Storage root present and `source_allowed(Builderlab)`.
    builderlab: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    management: Option<Management>,
    #[serde(flatten)]
    progress: Progress,
}
/// Public presentation policy, separate from consent and the latest pass's health.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Management {
    pubkey: String,
    policy: &'static str,
    initial_backup_confirmed: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Progress {
    #[default]
    Idle,
    Running,
    Waiting {
        reason: Waiting,
    },
    Complete,
    Failed {
        kind: Failure,
    },
}
/// A pass that stopped before upload; the next wake (consent, a session, a bind's
/// retry) resolves it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Waiting {
    NoConsent,
    NoSession,
    NotLinked,
}
/// Why a pass failed. Every kind is retried on the next wake; which ones the UI
/// offers to retry, and their copy, belong to the renderer. No body crosses IPC.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Failure {
    Busy,
    SignedOut,
    NotOffered,
    OtherKeyLinked,
    InvalidService,
    Refused,
    Unreachable,
    Unconfirmed,
    Storage,
}
#[derive(Debug, PartialEq)]
enum Outcome {
    Idle,
    Complete,
    Waiting(Waiting),
}
#[derive(Debug, PartialEq)]
enum Stop {
    /// Retired or closed; the pass reports nothing.
    Canceled,
    Failed(Failure),
}
impl From<&str> for Stop {
    fn from(message: &str) -> Self {
        match message {
            CANCELED => Self::Canceled,
            crate::nsec_backup_choice::BUSY => Self::Failed(Failure::Busy),
            // Shared helpers fail with fixed strings for consent, record and key I/O.
            _ => Self::Failed(Failure::Storage),
        }
    }
}
impl From<String> for Stop {
    fn from(message: String) -> Self {
        message.as_str().into()
    }
}
/// Why an `Api` read failed. Recovery shows a refused account as `REFUSED` and
/// anything else as `RETRY`; a backup pass reports a rejected session as signed
/// out, a refused account as not offered and anything else as unreachable.
#[derive(Debug)]
enum ReadError {
    /// kgoose answers 401 for every expired, revoked, unknown or missing session
    /// credential on `me` and `current`; `me` also reports a session that has
    /// expired by this device's clock.
    SignedOut,
    /// A 403 on `current` (`me` only ever answers 401): the session lacks the
    /// Buzz user capability or the account its USER role (kgoose's
    /// `unauthorized`), which no retry or new sign-in changes.
    NotOffered,
    /// The request never got an answer (network, DNS, TLS).
    Unreachable,
    Other,
}
impl From<&str> for ReadError {
    fn from(_: &str) -> Self {
        Self::Other
    }
}
impl From<String> for ReadError {
    fn from(_: String) -> Self {
        Self::Other
    }
}
impl From<ReadError> for String {
    fn from(error: ReadError) -> Self {
        match error {
            ReadError::NotOffered => REFUSED,
            ReadError::Unreachable => OFFLINE,
            // A new sign-in may clear a rejected session.
            ReadError::SignedOut | ReadError::Other => RETRY,
        }
        .into()
    }
}
impl From<ReadError> for Stop {
    fn from(error: ReadError) -> Self {
        Self::Failed(match error {
            ReadError::SignedOut => Failure::SignedOut,
            ReadError::NotOffered => Failure::NotOffered,
            ReadError::Unreachable | ReadError::Other => Failure::Unreachable,
        })
    }
}
/// Enrollment or upload errors, which keep the HTTP status but never the body.
fn classify(error: buzz_nsec_backup::Error, upload: bool) -> Failure {
    use buzz_nsec_backup::Error::*;
    match error {
        HttpStatus(401) => Failure::SignedOut,
        HttpStatus(403) if upload => Failure::OtherKeyLinked,
        HttpStatus(403 | 404) => Failure::NotOffered,
        Transport | HttpStatus(429 | 500..) => Failure::Unreachable,
        HttpStatus(400..) => Failure::Refused,
        HttpStatus(_) => Failure::Unreachable,
        InvalidResponse | BodyTooLarge(_) if upload => Failure::Unconfirmed,
        InvalidServiceUrl | InvalidCredential | InvalidResponse | BodyTooLarge(_) => {
            Failure::InvalidService
        }
    }
}

#[derive(Default)]
struct State {
    closed: bool,
    epoch: u64,
    /// The latest renderer hand-off's counter.
    generation: Option<u64>,
    /// The NIP-FI session revision backups use. Only the public revision is
    /// kept; its token stays in `FederatedIdentity`.
    session: Option<String>,
    worker: Option<JoinHandle<()>>,
    rerun: bool,
    restore: Option<Restore>,
    restore_epoch: u64,
    /// Wake counter: every ticket handed out, and the number of the pass it starts.
    requested: u64,
    seq: u64,
    pass: u64,
    progress: Progress,
    management: Option<Management>,
    watcher: Option<Channel<BackupStatus>>,
}
impl State {
    fn retire(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.rerun = false;
        if let Some(worker) = self.worker.take() {
            worker.abort();
        }
    }
    fn retire_restore(&mut self) {
        self.restore_epoch = self.restore_epoch.wrapping_add(1);
        self.restore.take();
    }
}
#[derive(Clone)]
pub(crate) struct NsecBackupHost {
    state: Arc<Mutex<State>>,
    config: Arc<Option<Config>>,
    root: Option<PathBuf>,
    federated: Option<FederatedIdentity>,
}
impl Default for NsecBackupHost {
    fn default() -> Self {
        let config = crate::nsec_backup_config::configured(
            option_env!("BUZZ_NSEC_BACKUP_SERVICE_URL"),
            option_env!("BUZZ_NSEC_BACKUP_NAMESPACE"),
        )
        .ok()
        .flatten();
        Self {
            state: Default::default(),
            config: Arc::new(config),
            // Default test hosts never access the OS account's backup directory.
            root: if cfg!(test) { None } else { storage_root() },
            federated: None,
        }
    }
}
/// Whether this build was compiled with `BUZZ_NSEC_BACKUP_CONSENT=managed`.
/// build.rs rejects managed consent without configured backup.
fn managed_build() -> bool {
    crate::nsec_backup_config::managed(option_env!("BUZZ_NSEC_BACKUP_CONSENT"), true) == Ok(true)
}

impl NsecBackupHost {
    pub(crate) fn with_federated_identity(mut self, federated: FederatedIdentity) -> Self {
        self.federated = Some(federated);
        self
    }
    pub(crate) async fn set_choice(
        &self,
        identity: IdentityHost,
        pubkey: &str,
        automatic: bool,
        unless_saved: bool,
    ) -> Result<crate::nsec_backup_choice::BackupChoice> {
        let config = self.config.as_ref().as_ref().ok_or(UNAVAILABLE)?;
        let path = self.root.as_ref().ok_or(UNAVAILABLE)?.join("choice.json");
        let managed = managed_build();
        let choice = crate::nsec_backup_choice::set(
            &identity,
            &path,
            config,
            pubkey,
            automatic,
            managed,
            unless_saved,
        )
        .await?;
        if automatic {
            self.trigger(identity);
        }
        Ok(choice)
    }
    pub(crate) fn document_load(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.retire();
        state.retire_restore();
        state.session = None;
        // The hand-off counter restarts with each renderer document.
        state.generation = None;
        // The watcher stays: a stale channel drops sends, and the new document registers.
        // A consent wait belonged to a cleared session, so it ends too.
        if matches!(
            state.progress,
            Progress::Running
                | Progress::Waiting {
                    reason: Waiting::NoConsent
                }
        ) {
            self.publish(&mut state, Progress::Idle);
        }
    }
    pub(crate) fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.closed = true;
        state.retire();
        state.retire_restore();
        state.session = None;
    }
    pub(crate) fn local_key_installed(&self, identity: IdentityHost) {
        if let Ok(mut state) = self.state.lock() {
            state.retire();
            state.retire_restore();
            state.management = None;
            self.publish(&mut state, Progress::Idle);
        }
        self.trigger(identity);
    }
    fn valid(&self, epoch: u64) -> Result<()> {
        let state = self.state.lock().map_err(|_| CANCELED)?;
        if state.closed || state.epoch != epoch {
            Err(CANCELED.into())
        } else {
            Ok(())
        }
    }
    fn builderlab(&self) -> bool {
        self.root.is_some() && self.service_allowed()
    }
    fn status(&self) -> BackupStatus {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.snapshot(&state)
    }
    async fn initialize_management(&self, identity: &IdentityHost) -> Result<()> {
        let epoch = self.state.lock().map_err(|_| RETRY)?.epoch;
        let pubkey = identity.saved_viewer().await?;
        let receipt = pubkey.as_deref().is_some_and(|pubkey| self.receipt(pubkey));
        let mut state = self.state.lock().map_err(|_| RETRY)?;
        if state.closed || state.epoch != epoch {
            return Err(CANCELED.into());
        }
        if let Some(pubkey) = pubkey {
            self.management_for(&mut state, &pubkey, receipt);
        } else {
            state.management = None;
        }
        let progress = state.progress.clone();
        self.publish(&mut state, progress);
        Ok(())
    }
    /// Whether this device holds a confirmed backup receipt for `pubkey`, under
    /// any account. It needs no network, so a launch offline or signed out
    /// still shows a backed-up key as backed up.
    fn receipt(&self, pubkey: &str) -> bool {
        match (self.config.as_ref(), self.root.as_ref()) {
            (Some(config), Some(root)) => persistence::confirmed(root, config, pubkey),
            _ => false,
        }
    }
    /// Starts `pubkey`'s presentation from `receipt`, the device's durable
    /// evidence; a pass for the signed-in account then confirms or clears it.
    fn management_for(&self, state: &mut State, pubkey: &str, receipt: bool) {
        if state
            .management
            .as_ref()
            .is_some_and(|m| m.pubkey == pubkey)
        {
            return;
        }
        state.management = Some(Management {
            pubkey: pubkey.into(),
            policy: if managed_build() {
                "organization-managed"
            } else {
                "self-managed"
            },
            initial_backup_confirmed: receipt,
        });
    }
    fn snapshot(&self, state: &State) -> BackupStatus {
        BackupStatus {
            seq: state.seq,
            pass: state.pass,
            builderlab: self.builderlab(),
            management: state.management.clone(),
            progress: state.progress.clone(),
        }
    }
    /// Callers hold the state lock, so pushed messages leave in `seq` order.
    fn publish(&self, state: &mut State, progress: Progress) {
        state.seq += 1;
        state.progress = progress;
        let status = self.snapshot(state);
        if let Some(watcher) = &state.watcher {
            // A reloaded webview's stale channel drops the message; the new page reads the snapshot.
            let _ = watcher.send(status);
        }
    }
    fn watch(&self, channel: Channel<BackupStatus>) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).watcher = Some(channel);
    }
    fn service_allowed(&self) -> bool {
        service_allowed_for(
            self.config.as_ref().as_ref(),
            buzzodz_plugins::BUILDERLAB_ORIGIN,
            buzzodz_plugins::BUILDERLAB_API_BASE_PATH,
        )
    }
    /// Hands over the NIP-FI session revision backups use, or `None` once it
    /// ended. A stale `generation` changes nothing.
    fn session(
        &self,
        generation: u64,
        federated: Option<String>,
        identity: IdentityHost,
    ) -> Result<Option<u64>> {
        if !self.service_allowed() {
            return Ok(None);
        }
        self.handoff(generation, federated, identity)
    }
    fn handoff(
        &self,
        generation: u64,
        federated: Option<String>,
        identity: IdentityHost,
    ) -> Result<Option<u64>> {
        if federated
            .as_deref()
            .is_some_and(|revision| !self.federated_current(revision))
        {
            return Err("Invalid backup session".into());
        }
        // Read the receipt outside the lock; it applies only if the key is
        // still the one it was read for.
        let shown = self
            .state
            .lock()
            .map_err(|_| "Backup unavailable")?
            .management
            .as_ref()
            .map(|management| management.pubkey.clone());
        let receipt = shown.as_deref().is_some_and(|pubkey| self.receipt(pubkey));
        let mut state = self.state.lock().map_err(|_| "Backup unavailable")?;
        if state.closed || state.generation.is_some_and(|seen| generation <= seen) {
            return Ok(None);
        }
        state.generation = Some(generation);
        let active = state.session.take().is_some();
        if federated.is_none() && !active {
            return Ok(None);
        }
        state.retire();
        state.session = federated;
        // A new account starts again from the device's receipts: what an
        // earlier account's pass cleared or confirmed no longer applies, and
        // its own pass confirms or clears the key. Signing out keeps the
        // presentation.
        if state.session.is_some() {
            if let Some(management) = &mut state.management {
                management.initial_backup_confirmed =
                    receipt && shown.as_deref() == Some(management.pubkey.as_str());
            }
        }
        drop(state);
        Ok(self.trigger(identity))
    }
    /// Stops a session as signed out once its revision is retired, so a
    /// request built under it is not sent after a native sign-out.
    fn still_signed_in(&self, revision: &str) -> std::result::Result<(), Stop> {
        if self.federated_current(revision) {
            Ok(())
        } else {
            Err(Stop::Failed(Failure::SignedOut))
        }
    }
    fn federated_current(&self, revision: &str) -> bool {
        self.federated
            .as_ref()
            .is_some_and(|fi| fi.with_session(|_, current, _| current == revision) == Some(true))
    }
    /// The session's FI token, resolved now; `None` once the revision retired.
    fn token(&self, revision: &str) -> Option<Zeroizing<String>> {
        self.federated
            .as_ref()?
            .with_session(|token, current, _| (current == revision).then(|| token.clone()))
            .flatten()
    }
    fn api(&self, revision: &str, root: &str) -> std::result::Result<Api, Stop> {
        let token = self
            .token(revision)
            .ok_or(Stop::Failed(Failure::SignedOut))?;
        Api::bearer(root, &token).map_err(|_| Stop::Failed(Failure::Unreachable))
    }
    fn client(&self, revision: &str, root: &str) -> std::result::Result<Client, Stop> {
        let token = self
            .token(revision)
            .ok_or(Stop::Failed(Failure::SignedOut))?;
        Client::bearer(root, &token).map_err(|error| Stop::Failed(classify(error, false)))
    }
    fn retry(&self, identity: IdentityHost) -> Option<u64> {
        // Only a handed-over session can be retried.
        self.state.lock().ok()?.session.as_ref()?;
        self.trigger(identity)
    }
    /// Wake the uploader. The ticket is the number of a pass that starts after this
    /// call, or `None` when no pass will.
    fn trigger(&self, identity: IdentityHost) -> Option<u64> {
        if self.config.is_none() || self.root.is_none() {
            return None;
        }
        let mut state = self.state.lock().ok()?;
        if state.closed {
            return None;
        }
        if state
            .worker
            .as_ref()
            .is_some_and(|task| !task.inner().is_finished())
        {
            state.requested += 1;
            state.rerun = true;
            return Some(state.requested);
        }
        let Some(session) = state.session.clone() else {
            // A pass retired by a null handoff ends here, with no outcome of its own;
            // numbering it as the latest ticket settles a queued rerun's ticket too.
            // A consent wait belonged to the session that is gone, so it ends too.
            if matches!(
                state.progress,
                Progress::Running
                    | Progress::Waiting {
                        reason: Waiting::NoConsent
                    }
            ) {
                state.pass = state.requested;
                self.publish(
                    &mut state,
                    Progress::Waiting {
                        reason: Waiting::NoSession,
                    },
                );
            }
            return None;
        };
        let epoch = state.epoch;
        state.rerun = false;
        state.requested += 1;
        state.pass = state.requested;
        self.publish(&mut state, Progress::Running);
        let host = self.clone();
        state.worker = Some(tauri::async_runtime::spawn(async move {
            loop {
                let outcome = host.backup(&identity, &session, epoch).await;
                if outcome.is_err() {
                    eprintln!("Automatic identity backup deferred");
                }
                let Ok(mut state) = host.state.lock() else {
                    return;
                };
                // A retired pass never reports; the next pass's `running` replaces it.
                if state.closed || state.epoch != epoch {
                    return;
                }
                let progress = match outcome {
                    Ok(Outcome::Complete) => {
                        // Complete comes only from a scoped persisted receipt or a
                        // confirmed upload, after checking this account's binding.
                        if let Some(management) = &mut state.management {
                            management.initial_backup_confirmed = true;
                        }
                        Progress::Complete
                    }
                    Ok(Outcome::Waiting(reason)) => {
                        // The signed-in account has no key linked, so it holds
                        // no backup of this one, whatever a receipt says. This
                        // is in memory only: the receipt still proves a backup
                        // exists on some account, so the next launch or
                        // handoff shows it again until a pass answers.
                        if reason == Waiting::NotLinked {
                            if let Some(management) = &mut state.management {
                                management.initial_backup_confirmed = false;
                            }
                        }
                        Progress::Waiting { reason }
                    }
                    Err(Stop::Failed(kind)) => {
                        // Another key is linked: this one is not backed up
                        // with this account. Any other failure is a re-check
                        // that did not finish, not a missing backup.
                        if kind == Failure::OtherKeyLinked {
                            if let Some(management) = &mut state.management {
                                management.initial_backup_confirmed = false;
                            }
                        }
                        Progress::Failed { kind }
                    }
                    Ok(Outcome::Idle) | Err(Stop::Canceled) => Progress::Idle,
                };
                host.publish(&mut state, progress);
                // Consume overlapping lifecycle events in this worker, without a timer.
                if std::mem::take(&mut state.rerun) {
                    state.pass = state.requested;
                    host.publish(&mut state, Progress::Running);
                    continue;
                }
                state.worker = None;
                return;
            }
        }));
        Some(state.pass)
    }
    async fn backup(
        &self,
        identity: &IdentityHost,
        session: &str,
        epoch: u64,
    ) -> std::result::Result<Outcome, Stop> {
        let config = self.config.as_ref().as_ref().ok_or(UNAVAILABLE)?;
        self.valid(epoch)?;
        let pubkey = match identity.saved_viewer().await {
            Ok(Some(pubkey)) => pubkey,
            // Without a local key there is nothing to describe.
            Ok(None) => return Ok(Outcome::Idle),
            // A denied, busy or locked store is not an absent key.
            Err(_) => return Err(Stop::Failed(Failure::Storage)),
        };
        let receipt = self.receipt(&pubkey);
        {
            let mut state = self.state.lock().map_err(|_| RETRY)?;
            if state.closed || state.epoch != epoch {
                return Err(Stop::Canceled);
            }
            self.management_for(&mut state, &pubkey, receipt);
        }
        // Hold consent's shared lease until this pass ends, including persisted retries.
        let Some(_consent) = crate::nsec_backup_choice::admit(
            &self.root.as_ref().ok_or(UNAVAILABLE)?.join("choice.json"),
            config,
            &pubkey,
            managed_build(),
        )?
        else {
            return Ok(Outcome::Waiting(Waiting::NoConsent));
        };
        self.valid(epoch)?;
        let api = self.api(session, &config.service_url)?;
        let account = api.me().await?;
        self.valid(epoch)?;
        self.still_signed_in(session)?;
        match api.current().await? {
            None => return Ok(Outcome::Waiting(Waiting::NotLinked)),
            Some(current) if current != pubkey => {
                return Err(Stop::Failed(Failure::OtherKeyLinked))
            }
            Some(_) => {}
        }
        let locked = {
            let state = self.state.lock().map_err(|_| RETRY)?;
            if state.closed || state.epoch != epoch {
                return Err(CANCELED.into());
            }
            persistence::LockedRecord::open(
                self.root.as_ref().ok_or(RETRY)?,
                config,
                &account.subject,
                &pubkey,
            )?
        };
        self.valid(epoch)?;
        let record = locked.read()?;
        if let Some(record) = record.as_ref() {
            record.matches_identity(config, &account.subject, &pubkey)?;
            if record.envelope.is_none() {
                return Ok(Outcome::Complete);
            }
        }
        let client = self.client(session, &config.service_url)?;
        let enrollment = match client.enroll().await {
            Ok(enrollment) => enrollment,
            // Enrollment refuses an account with no binding; a later bind resolves it.
            Err(buzz_nsec_backup::Error::HttpStatus(409)) => {
                return Ok(Outcome::Waiting(Waiting::NotLinked))
            }
            Err(error) => return Err(Stop::Failed(classify(error, false))),
        };
        self.valid(epoch)?;
        crypto::validate_enrollment(
            &enrollment,
            &config.namespace,
            &enrollment.owner_id,
            &pubkey,
        )
        .map_err(|_| Stop::Failed(Failure::InvalidService))?;
        let mut record = match record {
            Some(record) if record.matches(config, &account.subject, &enrollment)? => record,
            _ => {
                let mut record = persistence::Record::new(config, &account.subject, &enrollment);
                let namespace = config.namespace.clone();
                let expected = pubkey.clone();
                let owner = enrollment.owner_id.clone();
                let bytes = identity
                    .with_key(move |secret, local| {
                        if local != expected {
                            return Err("Backup identity mismatch".into());
                        }
                        Ok(crypto::seal(&enrollment, &namespace, &owner, local, secret))
                    })
                    .await?
                    .map_err(|_| Stop::Failed(Failure::InvalidService))?;
                record.envelope = Some(String::from_utf8(bytes).map_err(|_| RETRY)?);
                let state = self.state.lock().map_err(|_| RETRY)?;
                if state.closed || state.epoch != epoch {
                    return Err(CANCELED.into());
                }
                locked.write(&record)?;
                drop(state);
                record
            }
        };
        let Some(envelope) = record.envelope.as_ref() else {
            return Ok(Outcome::Complete);
        };
        self.valid(epoch)?;
        self.still_signed_in(session)?;
        let receipt = client
            .upload(envelope.as_bytes())
            .await
            .map_err(|error| Stop::Failed(classify(error, true)))?;
        if !receipt.stored || receipt.backup_id != record.backup_id {
            return Err(Stop::Failed(Failure::Unconfirmed));
        }
        let state = self.state.lock().map_err(|_| RETRY)?;
        if state.closed || state.epoch != epoch {
            return Err(CANCELED.into());
        }
        record.envelope = None;
        locked.write(&record)?;
        Ok(Outcome::Complete)
    }
    fn valid_restore(&self, epoch: u64) -> Result<()> {
        let state = self.state.lock().map_err(|_| CANCELED)?;
        if state.closed || state.restore_epoch != epoch {
            Err(CANCELED.into())
        } else {
            Ok(())
        }
    }
    async fn begin<R: tauri::Runtime>(
        &self,
        identity: IdentityHost,
        callback: OAuthCallbackHost,
        app: tauri::AppHandle<R>,
    ) -> Result<RestoreStarted> {
        let epoch = {
            let state = self.state.lock().map_err(|_| RETRY)?;
            if state.closed {
                return Err(CANCELED.into());
            }
            state.restore_epoch
        };
        let config = self.config.as_ref().as_ref().ok_or(UNAVAILABLE)?;
        identity.require_missing().await?;
        let mut random = Zeroizing::new([0u8; 32]);
        getrandom::fill(random.as_mut()).map_err(|_| RETRY)?;
        let verifier = Zeroizing::new(URL_SAFE_NO_PAD.encode(random.as_ref()));
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut login =
            url::Url::parse(&format!("{}/v1/auth/login", config.service_url)).map_err(|_| RETRY)?;
        login
            .query_pairs_mut()
            .append_pair("type", "cli")
            .append_pair("product", "buzz")
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        let mut state = self.state.lock().map_err(|_| RETRY)?;
        if state.closed || state.restore_epoch != epoch {
            return Err(CANCELED.into());
        }
        if state.restore.is_some() {
            return Err("A restore is already in progress".into());
        }
        let oauth = callback.begin(
            RESTORE_CALLBACK_OWNER,
            OAuthRequest {
                authorization_url: login.into(),
                callback_path: format!("/callback/{}", uuid::Uuid::new_v4()),
                use_state: true,
            },
            |url| {
                app.opener()
                    .open_url(url, None::<&str>)
                    .map_err(|_| RETRY.to_owned())
            },
        )?;
        let id = uuid::Uuid::new_v4().to_string();
        let (send, receive) = oneshot::channel();
        let admission = Arc::new(Mutex::new(true));
        let host = self.clone();
        let worker_id = id.clone();
        let oauth_id = oauth.id.clone();
        let worker_callback = callback.clone();
        let task = tauri::async_runtime::spawn(async move {
            let result = host
                .recover(
                    epoch,
                    &worker_id,
                    worker_callback,
                    oauth_id,
                    oauth.callback_url,
                    verifier,
                )
                .await;
            let _ = send.send(result);
        });
        state.restore = Some(Restore {
            id: id.clone(),
            admission,
            callback,
            callback_id: oauth.id,
            task,
            result: Some(receive),
            candidates: Vec::new(),
            current: None,
            credential: None,
            subject: None,
            installing: false,
        });
        Ok(RestoreStarted { attempt: id })
    }
    async fn recover(
        &self,
        epoch: u64,
        id: &str,
        callback: OAuthCallbackHost,
        oauth_id: String,
        redirect: String,
        verifier: Zeroizing<String>,
    ) -> Result<RestoreResult> {
        let parameters = callback.wait(&oauth_id).await.map_err(|error| {
            if error == crate::oauth_callback::TIMED_OUT {
                crate::oauth_callback::TIMED_OUT
            } else {
                RETRY
            }
        })?;
        self.valid_restore(epoch)?;
        if let Some((_, error)) = parameters
            .parameters
            .iter()
            .find(|(name, _)| name == "error")
        {
            // RFC 6749 4.1.2.1: the user declined or closed the sign-in page.
            return Err(if error == "access_denied" {
                CANCELED
            } else {
                RETRY
            }
            .into());
        }
        let mut codes = parameters
            .parameters
            .iter()
            .filter(|(name, _)| name == "code");
        let code = codes.next().map(|(_, code)| code.as_str()).ok_or(RETRY)?;
        if codes.next().is_some() {
            return Err(RETRY.into());
        }
        let config = self.config.as_ref().as_ref().ok_or(UNAVAILABLE)?;
        let credential = Api::exchange(&config.service_url, code, &verifier, &redirect).await?;
        let api = Api::new(&config.service_url, &credential)?;
        let account = api.me().await?;
        self.valid_restore(epoch)?;
        let current = api.current().await?;
        let client = Client::new(&config.service_url, &credential).map_err(|_| RETRY)?;
        let recovered = client.recover().await.map_err(|error| match error {
            buzz_nsec_backup::Error::HttpStatus(404) => UNAVAILABLE.to_owned(),
            // Not a private org, or no Buzz user role: no retry changes it.
            buzz_nsec_backup::Error::HttpStatus(403) => REFUSED.to_owned(),
            buzz_nsec_backup::Error::Transport => OFFLINE.to_owned(),
            _ => RETRY.to_owned(),
        })?;
        let (candidates, failed_count) = candidates(recovered);
        let summary = RestoreResult {
            candidates: candidates
                .iter()
                .map(|key| PublicCandidate {
                    handle: key.handle.clone(),
                    pubkey: key.pubkey.clone(),
                })
                .collect(),
            current_pubkey: current.clone(),
            failed_count,
        };
        let mut state = self.state.lock().map_err(|_| CANCELED)?;
        if state.closed || state.restore_epoch != epoch {
            return Err(CANCELED.into());
        }
        let attempt = state
            .restore
            .as_mut()
            .filter(|attempt| attempt.id == id)
            .ok_or(CANCELED)?;
        attempt.candidates = candidates;
        attempt.current = current;
        attempt.credential = Some(credential);
        attempt.subject = Some(account.subject);
        Ok(summary)
    }
    async fn wait(&self, id: &str) -> Result<RestoreResult> {
        let receive = self
            .state
            .lock()
            .map_err(|_| CANCELED)?
            .restore
            .as_mut()
            .filter(|attempt| attempt.id == id)
            .and_then(|attempt| attempt.result.take())
            .ok_or(CANCELED)?;
        receive.await.map_err(|_| CANCELED.to_owned())?
    }
    fn cancel(&self, id: &str) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .restore
            .as_ref()
            .is_some_and(|attempt| attempt.id == id)
        {
            state.restore.take();
        }
    }
    async fn install(&self, identity: IdentityHost, id: &str, handle: &str) -> Result<String> {
        let (pubkey, backup_id, credential, subject, current, admission, epoch) = {
            let mut state = self.state.lock().map_err(|_| CANCELED)?;
            if state.closed {
                return Err(CANCELED.into());
            }
            let epoch = state.restore_epoch;
            let attempt = state
                .restore
                .as_mut()
                .filter(|attempt| attempt.id == id && !attempt.installing)
                .ok_or(CANCELED)?;
            let key = attempt
                .candidates
                .iter()
                .find(|key| key.handle == handle)
                .ok_or("Choose an identity to restore")?;
            let credential = attempt.credential.clone().ok_or(CANCELED)?;
            let subject = attempt.subject.clone().ok_or(CANCELED)?;
            attempt.installing = true;
            (
                key.pubkey.clone(),
                key.backup_id.clone(),
                credential,
                subject,
                attempt.current.clone(),
                attempt.admission.clone(),
                epoch,
            )
        };
        let result = async {
            let config = self.config.as_ref().as_ref().ok_or(UNAVAILABLE)?;
            let api = Api::new(&config.service_url, &credential)?;
            if api.current().await? != current {
                return Err("Your account identity changed. Sign in again.".into());
            }
            self.valid_restore(epoch)?;
            let secret = {
                let state = self.state.lock().map_err(|_| CANCELED)?;
                let attempt = state
                    .restore
                    .as_ref()
                    .filter(|attempt| attempt.id == id)
                    .ok_or(CANCELED)?;
                let key = attempt
                    .candidates
                    .iter()
                    .find(|key| key.handle == handle)
                    .ok_or(CANCELED)?;
                if self
                    .root
                    .as_ref()
                    .ok_or_else(|| RETRY.to_owned())
                    .and_then(|root| {
                        persistence::remember_restored(root, config, &subject, &pubkey, &backup_id)
                    })
                    .is_err()
                {
                    eprintln!("Automatic identity backup completion deferred");
                }
                Zeroizing::new(**key.secret)
            };
            self.valid_restore(epoch)?;
            identity
                .install_recovered(secret, pubkey.clone(), admission)
                .await
        }
        .await;
        if result.is_ok() {
            {
                let mut state = self.state.lock().map_err(|_| CANCELED)?;
                if !state.closed
                    && state.restore_epoch == epoch
                    && state
                        .restore
                        .as_ref()
                        .is_some_and(|attempt| attempt.id == id)
                {
                    state.restore.take();
                }
            }
            // The account already holds this key's backup, so it stays backed
            // up with no prompt unless its owner saved a choice; saving wakes
            // the uploader.
            if self
                .set_choice(identity.clone(), &pubkey, true, true)
                .await
                .is_err()
            {
                eprintln!("Automatic identity backup consent deferred");
                self.trigger(identity);
            }
        } else if let Ok(mut state) = self.state.lock() {
            if let Some(attempt) = state.restore.as_mut().filter(|attempt| attempt.id == id) {
                attempt.installing = false;
            }
        }
        result
    }
}

/// Whether the backup service is the build's own Builderlab, whose NIP-FI
/// session backs it up.
fn service_allowed_for(
    config: Option<&Config>,
    builderlab_origin: &str,
    builderlab_api_base_path: &str,
) -> bool {
    config
        .and_then(|config| url::Url::parse(&config.service_url).ok())
        .is_some_and(|url| {
            let path = format!("{}/", url.path().trim_end_matches('/'));
            !builderlab_origin.is_empty()
                && url.origin().ascii_serialization() == builderlab_origin
                && path == builderlab_api_base_path
        })
}

fn valid_credential(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && value.bytes().all(|c| (33..=126).contains(&c))
}
fn public_key(value: &str) -> Result<String> {
    let public: XOnlyPublicKey = value.parse().map_err(|_| RETRY)?;
    if public.to_string() != value {
        return Err(RETRY.into());
    }
    Ok(value.to_owned())
}
fn candidates(recovered: Recovery) -> (Vec<Candidate>, usize) {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    let mut failed = recovered.failed_backup_ids.len();
    for backup in recovered.backups {
        let verified = (|| -> Result<String> {
            if uuid::Uuid::parse_str(&backup.backup_id)
                .map_err(|_| RETRY)?
                .to_string()
                != backup.backup_id
            {
                return Err(RETRY.into());
            }
            let mut scalar = SecretKey::from_byte_array(*backup.secret_key()).map_err(|_| RETRY)?;
            let derived = PublicKey::from_secret_key(&Secp256k1::signing_only(), &scalar)
                .x_only_public_key()
                .0
                .to_string();
            scalar.non_secure_erase();
            if derived != public_key(&backup.nostr_pubkey)? {
                return Err(RETRY.into());
            }
            Ok(derived)
        })();
        match verified {
            Ok(pubkey) if seen.insert(pubkey.clone()) => candidates.push(Candidate {
                handle: uuid::Uuid::new_v4().to_string(),
                pubkey,
                backup_id: backup.backup_id.clone(),
                secret: Box::new(Zeroizing::new(*backup.secret_key())),
            }),
            Ok(_) => {}
            Err(_) => failed += 1,
        }
    }
    (candidates, failed)
}

#[derive(Deserialize)]
struct Account {
    subject: String,
    expires_at: String,
}
#[derive(Deserialize)]
struct Exchange {
    #[serde(deserialize_with = "credential")]
    session_credential: Zeroizing<String>,
}
fn credential<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> std::result::Result<Zeroizing<String>, D::Error> {
    let value = Zeroizing::new(String::deserialize(input)?);
    if !valid_credential(&value) {
        return Err(serde::de::Error::custom("Invalid session"));
    }
    Ok(value)
}
struct Api {
    http: reqwest::Client,
    root: String,
    header: reqwest::header::HeaderName,
    credential: reqwest::header::HeaderValue,
}
impl Api {
    fn new(root: &str, credential: &str) -> Result<Self> {
        Self::build(
            root,
            reqwest::header::HeaderName::from_static("x-bb-session-credential"),
            credential,
        )
    }
    /// Authenticates with an FI session token as `Authorization: Bearer`.
    fn bearer(root: &str, token: &str) -> Result<Self> {
        Self::build(
            root,
            reqwest::header::AUTHORIZATION,
            &Zeroizing::new(format!("Bearer {token}")),
        )
    }
    fn build(root: &str, header: reqwest::header::HeaderName, credential: &str) -> Result<Self> {
        let mut value = reqwest::header::HeaderValue::from_str(credential).map_err(|_| RETRY)?;
        value.set_sensitive(true);
        Ok(Self {
            http: Self::http(root)?,
            root: root.to_owned(),
            header,
            credential: value,
        })
    }
    fn http(root: &str) -> Result<reqwest::Client> {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(30));
        if root.starts_with("http:") {
            builder = builder.no_proxy();
        }
        builder.build().map_err(|_| RETRY.into())
    }
    async fn exchange(
        root: &str,
        code: &str,
        verifier: &str,
        redirect: &str,
    ) -> Result<Zeroizing<String>> {
        #[derive(Serialize)]
        struct Request<'a> {
            code: &'a str,
            code_verifier: &'a str,
            redirect_uri: &'a str,
        }
        let body = Zeroizing::new(
            serde_json::to_vec(&Request {
                code,
                code_verifier: verifier,
                redirect_uri: redirect,
            })
            .map_err(|_| RETRY)?,
        );
        let response = Self::http(root)?
            .post(format!("{root}/v1/auth/login/exchange"))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(bytes::Bytes::from_owner(body))
            .send()
            .await
            .map_err(|_| OFFLINE)?;
        let value: Exchange =
            serde_json::from_slice(&Self::body(response).await?).map_err(|_| RETRY)?;
        Ok(value.session_credential)
    }
    async fn request(
        &self,
        path: &str,
        post: bool,
    ) -> std::result::Result<Zeroizing<Vec<u8>>, ReadError> {
        let url = format!("{}{path}", self.root);
        let request = if post {
            self.http
                .post(url)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body("{}")
        } else {
            self.http.get(url)
        };
        let response = request
            .header(&self.header, &self.credential)
            .send()
            .await
            .map_err(|_| ReadError::Unreachable)?;
        match response.status() {
            reqwest::StatusCode::UNAUTHORIZED => return Err(ReadError::SignedOut),
            reqwest::StatusCode::FORBIDDEN => return Err(ReadError::NotOffered),
            _ => {}
        }
        Ok(Self::body(response).await?)
    }
    async fn body(mut response: reqwest::Response) -> Result<Zeroizing<Vec<u8>>> {
        if !response.status().is_success()
            || response.content_length().is_some_and(|len| len > 8192)
        {
            return Err(RETRY.into());
        }
        let mut body = Zeroizing::new(Vec::with_capacity(8192));
        while let Some(chunk) = response.chunk().await.map_err(|_| RETRY)? {
            if chunk.len() > 8192 - body.len() {
                return Err(RETRY.into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
    async fn me(&self) -> std::result::Result<Account, ReadError> {
        let account: Account = serde_json::from_slice(&self.request("/v1/auth/me", false).await?)
            .map_err(|_| RETRY)?;
        let expiry = chrono::DateTime::parse_from_rfc3339(&account.expires_at)
            .map_err(|_| RETRY)?
            .timestamp();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| RETRY)?
            .as_secs();
        if account.subject.is_empty()
            || account.subject.len() > 1024
            || account.subject.chars().any(char::is_control)
        {
            return Err(RETRY.into());
        }
        // Expired by this device's clock; a new sign-in clears it, a retry cannot.
        if expiry <= now as i64 {
            return Err(ReadError::SignedOut);
        }
        Ok(account)
    }
    async fn current(&self) -> std::result::Result<Option<String>, ReadError> {
        let value: serde_json::Value = serde_json::from_slice(
            &self
                .request("/v1/buzz/nostr-identities/current", true)
                .await?,
        )
        .map_err(|_| RETRY)?;
        if value.get("error").is_some_and(|error| !error.is_null()) {
            return Err(RETRY.into());
        }
        let known = value
            .get("correlation_id")
            .and_then(|id| id.as_str())
            .is_some_and(|id| !id.is_empty());
        match value.get("identity") {
            Some(serde_json::Value::Null) if known => Ok(None),
            Some(identity) => Ok(Some(public_key(
                identity
                    .get("pubkey_hex")
                    .and_then(|key| key.as_str())
                    .ok_or(RETRY)?,
            )?)),
            None if known => Ok(None),
            _ => Err(RETRY.into()),
        }
    }
}

#[tauri::command]
pub(crate) fn nsec_backup_available(host: tauri::State<'_, NsecBackupHost>) -> bool {
    host.config.is_some()
}
/// Whether this device has confirmed that a backup of `pubkey` is stored, by any
/// account: first-run sign-in replaces only a key that is safe to replace.
#[tauri::command]
pub(crate) fn nsec_backup_confirmed(
    host: tauri::State<'_, NsecBackupHost>,
    pubkey: String,
) -> bool {
    host.receipt(&pubkey)
}
/// The ticket of the pass this handoff starts, if any.
#[tauri::command]
pub(crate) fn nsec_backup_session(
    host: tauri::State<'_, NsecBackupHost>,
    identity: tauri::State<'_, IdentityHost>,
    generation: u64,
    federated: Option<String>,
) -> Result<Option<u64>> {
    host.session(generation, federated, identity.inner().clone())
}
#[tauri::command]
pub(crate) fn nsec_backup_retry(
    host: tauri::State<'_, NsecBackupHost>,
    identity: tauri::State<'_, IdentityHost>,
) -> Option<u64> {
    host.retry(identity.inner().clone())
}
#[tauri::command]
pub(crate) async fn nsec_backup_state(
    host: tauri::State<'_, NsecBackupHost>,
    identity: tauri::State<'_, IdentityHost>,
) -> Result<BackupStatus> {
    host.initialize_management(&identity).await?;
    Ok(host.status())
}
/// Replace the status watcher. Register before reading `nsec_backup_state`, then keep
/// whichever status has the higher `seq`.
#[tauri::command]
pub(crate) fn nsec_backup_watch<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    host: tauri::State<'_, NsecBackupHost>,
    on_event: Channel<BackupStatus>,
) -> Result<()> {
    if window.label() != "main" {
        return Err("Backup status belongs to the main window".into());
    }
    host.watch(on_event);
    Ok(())
}
#[tauri::command]
pub(crate) async fn nsec_restore_begin<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    host: tauri::State<'_, NsecBackupHost>,
    identity: tauri::State<'_, IdentityHost>,
    callback: tauri::State<'_, OAuthCallbackHost>,
) -> Result<RestoreStarted> {
    host.begin(identity.inner().clone(), callback.inner().clone(), app)
        .await
}
#[tauri::command]
pub(crate) async fn nsec_restore_wait(
    host: tauri::State<'_, NsecBackupHost>,
    attempt: String,
) -> Result<RestoreResult> {
    host.wait(&attempt).await
}
#[tauri::command]
pub(crate) async fn nsec_restore_install(
    host: tauri::State<'_, NsecBackupHost>,
    identity: tauri::State<'_, IdentityHost>,
    attempt: String,
    handle: String,
) -> Result<String> {
    host.install(identity.inner().clone(), &attempt, &handle)
        .await
}
#[tauri::command]
pub(crate) fn nsec_restore_cancel(host: tauri::State<'_, NsecBackupHost>, attempt: String) {
    host.cancel(&attempt);
}

#[cfg(test)]
#[path = "nsec_backup/tests.rs"]
mod tests;
