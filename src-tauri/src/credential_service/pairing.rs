//! `pair`: a command-line tool asks to act as the human; the human approves
//! it in Buzz. Only each token's SHA-256 is kept, in the OS keychain, bound
//! to the human, store account and NIP-FI account that approved it.
use super::keychain::{Keychain, Lease, LEASED};
use super::{digest, unix_now, Failure};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::time::Instant;

/// How long a request waits for the human.
pub(crate) const APPROVAL: Duration = Duration::from_secs(120);
/// A paired token unused this long is revoked.
pub(crate) const DISUSE: u64 = 30 * 24 * 60 * 60;
/// `last_used` reaches the keychain at most this often.
const TOUCH_EVERY: u64 = 10 * 60;
/// Requests allowed per window.
const PAIRS: usize = 3;
const PAIR_WINDOW: Duration = Duration::from_secs(10 * 60);

/// Who approved a pairing. A pairing acts only while all three still hold.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Approver {
    pub(crate) pubkey: String,
    pub(crate) store_account: String,
    pub(crate) fi_account: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Record {
    pub(crate) id: String,
    /// Hex SHA-256 of the token.
    digest: String,
    pub(crate) client: String,
    pub(crate) relay: String,
    pub(crate) created: u64,
    pub(crate) last_used: u64,
    pub(crate) approved_by: Approver,
}

/// One row of the paired-tools list.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Listed {
    id: String,
    client: String,
    relay: String,
    created: u64,
    last_used: u64,
    expires: u64,
}

/// What the page is told.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Request {
    pub(crate) id: String,
    pub(crate) client: String,
    pub(crate) relay: String,
    pub(crate) process: Option<String>,
    pub(crate) expires_in: u64,
}
#[derive(Clone, Debug)]
pub(crate) enum Notice {
    /// Ask the human.
    Ask(Request),
    /// The request with this id is over: answered, expired or abandoned.
    Closed(String),
    /// The list changed.
    Changed,
}
pub(crate) type Notify = Arc<dyn Fn(Notice) + Send + Sync>;

/// The human a pairing acts as, as far as it is known yet.
pub(crate) enum Human {
    /// Settled and signed in to Buzz.
    Ready(Approver),
    /// No human identity here: no pairing acts.
    Absent,
    /// Not settled: still loading, or the sign-in expired. Why, for the caller.
    Pending(&'static str),
}

pub(crate) struct Pairings {
    keychain: Arc<dyn Keychain>,
    notify: Notify,
    /// Serializes keychain writes; each writes the then-current records.
    write: tokio::sync::Mutex<()>,
    state: Mutex<State>,
    /// This app's sole use of the keychain item, taken before the records are
    /// first read and held for good; without it nothing is read or written.
    lease: Mutex<Option<Lease>>,
    /// The communities saved in Buzz, as the page last reported them; `None`
    /// until it has. A tool pairs only for one of these.
    pub(super) communities: Mutex<Option<Vec<String>>>,
}
#[derive(Default)]
struct State {
    /// `None` until read; a failed read admits nothing.
    records: Option<Result<Vec<Record>, String>>,
    /// When `last_used` last reached the keychain.
    flushed: u64,
    /// The request waiting for the human: its id, relay and answer.
    pending: Option<(String, String, oneshot::Sender<bool>)>,
    asked: VecDeque<Instant>,
    /// Prompts the page has listening to ask the human; with none, nothing is
    /// asked, since nobody could answer.
    prompts: usize,
    /// Bumped by every revoke-all; a token admitted, or an approval begun,
    /// under an earlier one never acts or is saved.
    generation: u64,
    /// A revoke-all is not yet saved: nothing acts until it is.
    owed: bool,
    /// The NIP-FI retirements already revoked for (see [`Pairings::follow`]).
    retirements: u64,
    /// Sign-outs and changes of account recorded but not yet over; see
    /// [`Pairings::record_retirement`].
    retiring: usize,
}

/// Whether `relay` is one of `communities`, compared as whole URLs.
fn is_saved(communities: &[String], relay: &str) -> bool {
    communities
        .iter()
        .any(|community| super::policy::same_relay(&as_relay(community), relay))
}

/// A community URL as the relay URL a tool names: `https` as `wss`, `http`
/// as `ws`.
fn as_relay(url: &str) -> String {
    match url.split_once("://") {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("https") => format!("wss://{rest}"),
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("http") => format!("ws://{rest}"),
        _ => url.into(),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl Pairings {
    pub(crate) fn new(keychain: Arc<dyn Keychain>, notify: Notify) -> Self {
        Self {
            keychain,
            notify,
            write: tokio::sync::Mutex::new(()),
            state: Mutex::default(),
            lease: Mutex::default(),
            communities: Mutex::default(),
        }
    }

    /// Records the communities saved in Buzz, as WebSocket or HTTP URLs.
    /// A request waiting for the human whose community is gone is declined.
    /// Returns once no approval saved under the old list remains: an approval
    /// mid-save holds the write lock and, on seeing its community gone,
    /// removes its record before releasing it.
    pub(crate) async fn set_communities(&self, communities: Vec<String>) {
        {
            let mut saved = self
                .communities
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let mut state = self.state();
            if let Some((.., relay, _)) = &state.pending {
                if !is_saved(&communities, relay) {
                    // Dropping the sender declines it.
                    state.pending = None;
                }
            }
            *saved = Some(communities);
        }
        drop(self.write.lock().await);
    }

    /// Whether `relay` is a saved community, compared as a whole URL.
    fn saved(&self, relay: &str) -> Result<bool, Failure> {
        let communities = self
            .communities
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let communities = communities
            .as_ref()
            .ok_or_else(|| Failure::new("unavailable", "Buzz is starting; try again"))?;
        Ok(is_saved(communities, relay))
    }
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes the records' lease, unless this app already holds it.
    pub(crate) fn lease(&self) -> Result<(), String> {
        let mut lease = self.lease.lock().unwrap_or_else(PoisonError::into_inner);
        if lease.is_none() {
            *lease = Some(self.keychain.lease()?);
        }
        Ok(())
    }

    /// The records, read once under the lease; a failed read is retried on
    /// the next call.
    async fn loaded(&self) -> Result<Vec<Record>, String> {
        let _write = self.write.lock().await;
        self.loaded_locked().await
    }
    async fn loaded_locked(&self) -> Result<Vec<Record>, String> {
        if let Some(Ok(records)) = &self.state().records {
            return Ok(records.clone());
        }
        self.lease()?;
        let keychain = self.keychain.clone();
        let read = tokio::task::spawn_blocking(move || {
            // A revoke-all an earlier run could not save is still owed.
            let owed = keychain.owed();
            keychain.read().map(|value| (owed, value))
        })
        .await
        .unwrap_or_else(|_| Err("Paired tools could not be read".into()))
        .and_then(|(owed, value)| {
            if owed {
                self.state().owed = true;
            }
            match value {
                None => Ok(Vec::new()),
                Some(bytes) => serde_json::from_slice::<Vec<Record>>(&bytes)
                    .map_err(|_| "Saved paired tools are unreadable".into()),
            }
        });
        self.state().records = Some(read.clone());
        read
    }

    /// Finishes an owed revoke-all first; while it cannot be saved, nothing
    /// is admitted or issued.
    pub(crate) async fn settled(&self) -> Result<(), String> {
        let _write = self.write.lock().await;
        if self.state().retiring > 0 {
            return Err("Paired tools are being revoked".into());
        }
        self.loaded_locked().await?;
        if self.state().owed {
            self.clear_locked()
                .await
                .map_err(|unrevoked| unrevoked.message)?;
        }
        Ok(())
    }

    /// Applies `change` to the current records and saves them durably; the
    /// in-memory records change only once the keychain has. A `None` change
    /// saves nothing.
    async fn mutate<T>(
        &self,
        change: impl FnOnce(&mut Vec<Record>) -> Option<T>,
    ) -> Result<Option<T>, String> {
        let _write = self.write.lock().await;
        self.mutate_locked(change).await
    }
    /// [`Self::mutate`], for a caller already holding the write lock.
    async fn mutate_locked<T>(
        &self,
        change: impl FnOnce(&mut Vec<Record>) -> Option<T>,
    ) -> Result<Option<T>, String> {
        let mut records = self.loaded_locked().await?;
        let Some(out) = change(&mut records) else {
            return Ok(None);
        };
        let value = (!records.is_empty())
            .then(|| serde_json::to_vec(&records))
            .transpose()
            .map_err(|_| "Paired tools could not be saved")?;
        let keychain = self.keychain.clone();
        tokio::task::spawn_blocking(move || keychain.write(value.as_deref()))
            .await
            .unwrap_or_else(|_| Err("Paired tools could not be saved".into()))?;
        let mut state = self.state();
        state.records = Some(Ok(records));
        state.flushed = unix_now().unwrap_or(0);
        drop(state);
        (self.notify)(Notice::Changed);
        Ok(Some(out))
    }

    /// The current revoke-all generation, while none is owed.
    fn generation(&self) -> Option<u64> {
        let state = self.state();
        (!state.owed).then_some(state.generation)
    }

    /// The pairing `token` names, if it still acts as `human`: an expired
    /// one, or one approved by anyone else, is deleted and answers `revoked`.
    /// Also returns the generation it was admitted under, for [`Self::holds`].
    pub(crate) async fn admit(&self, token: &str, human: Human) -> Result<(Record, u64), Failure> {
        let key = hex(&digest(token));
        self.settled().await.map_err(Failure::unavailable)?;
        let generation = self.generation().ok_or_else(Failure::revoked)?;
        let records = self.loaded().await.map_err(Failure::unavailable)?;
        let record = records
            .into_iter()
            .find(|record| record.digest == key)
            .ok_or_else(Failure::revoked)?;
        let now = unix_now()?;
        let acts = match &human {
            Human::Pending(message) => return Err(Failure::new("unavailable", message)),
            Human::Absent => false,
            Human::Ready(approver) => *approver == record.approved_by,
        };
        if !acts || now.saturating_sub(record.last_used) > DISUSE {
            self.mutate(|records| {
                records.retain(|r| r.id != record.id);
                Some(())
            })
            .await
            .map_err(Failure::unavailable)?;
            return Err(Failure::revoked());
        }
        self.touch(&record.id, now).await;
        Ok((record, generation))
    }

    /// Whether the pairing still exists and no revoke-all has begun since
    /// `generation`, for a result about to be returned.
    pub(crate) fn holds(&self, id: &str, generation: u64) -> bool {
        let state = self.state();
        !state.owed
            && state.generation == generation
            && matches!(&state.records, Some(Ok(records)) if records.iter().any(|r| r.id == id))
    }

    /// Records a use; it is saved with the next write, or now if the last
    /// save is older than [`TOUCH_EVERY`]. A lost save only expires it sooner.
    async fn touch(&self, id: &str, now: u64) {
        let due = {
            let mut state = self.state();
            if let Some(Ok(records)) = &mut state.records {
                if let Some(record) = records.iter_mut().find(|r| r.id == id) {
                    record.last_used = now;
                }
            }
            now.saturating_sub(state.flushed) >= TOUCH_EVERY
        };
        if due {
            let _ = self.mutate(|_| Some(())).await;
        }
    }

    /// Asks the human to approve `client` acting as them on `relay`; on
    /// approval saves the new token's digest, then returns the token.
    /// `human` is asked once now and again once approved, so an account
    /// change while the prompt is open issues nothing.
    /// `process` names the caller, only for a request that will be asked.
    pub(crate) async fn pair<F, Fut, P>(
        &self,
        client: &str,
        relay: &str,
        process: impl FnOnce() -> P,
        human: F,
    ) -> Result<(String, Approver), Failure>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Human>,
        P: std::future::Future<Output = Option<String>>,
    {
        let valid_client =
            (1..=64).contains(&client.chars().count()) && !client.chars().any(char::is_control);
        let valid_relay = url::Url::parse(relay)
            .is_ok_and(|url| matches!(url.scheme(), "ws" | "wss") && url.host().is_some());
        if !valid_client || !valid_relay {
            return Err(Failure::new("invalid_request", "Invalid pairing request"));
        }
        // Refused before anyone is asked or notified.
        if !self.saved(relay)? {
            return Err(Failure::new(
                "denied",
                &format!("{relay} isn't a community in Buzz; add it first"),
            ));
        }
        let approver = match human().await {
            Human::Ready(approver) => approver,
            Human::Absent => return Err(Failure::new("denied", "Set up Buzz first")),
            Human::Pending(message) => return Err(Failure::new("unavailable", message)),
        };
        self.settled().await.map_err(Failure::unavailable)?;
        let generation = self
            .generation()
            .ok_or_else(|| Failure::new("unavailable", "Paired tools are being revoked"))?;
        let id = uuid::Uuid::new_v4().to_string();
        let unsaved = || {
            Failure::new(
                "denied",
                &format!("{relay} isn't a community in Buzz; add it first"),
            )
        };
        let answer = {
            // Under the lock a removal cancels under: it either finds this
            // request pending or is seen here, so no removed community waits.
            let communities = self
                .communities
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if !communities
                .as_ref()
                .is_some_and(|communities| is_saved(communities, relay))
            {
                return Err(unsaved());
            }
            let mut state = self.state();
            // Before the rate limit: a request nobody could see spends no slot.
            if state.prompts == 0 {
                return Err(Failure::new(
                    "unavailable",
                    "Buzz can't ask you yet; finish signing in or setting up in Buzz, then pair again",
                ));
            }
            let now = Instant::now();
            while state
                .asked
                .front()
                .is_some_and(|at| now.duration_since(*at) >= PAIR_WINDOW)
            {
                state.asked.pop_front();
            }
            let wait = if state.pending.is_some() {
                Some(APPROVAL)
            } else if state.asked.len() >= PAIRS {
                state
                    .asked
                    .front()
                    .map(|at| PAIR_WINDOW - now.duration_since(*at))
            } else {
                None
            };
            if let Some(wait) = wait {
                return Err(Failure {
                    code: "rate_limited",
                    message: "Another pairing request is waiting or too many were made".into(),
                    retry_after: Some(wait.as_secs().max(1)),
                });
            }
            let (send, answer) = oneshot::channel();
            state.pending = Some((id.clone(), relay.into(), send));
            state.asked.push_back(now);
            answer
        };
        // Whatever ends the wait, even the caller hanging up, closes the prompt.
        let mut closing = Closing(self, id.clone(), false);
        let process = process().await;
        {
            // Asked under the lock removal and admission take, so no later
            // request's Ask can precede this one's. `notify` only tells the
            // page, never back into the pairings.
            let state = self.state();
            // A removal during the lookup cancelled it: nothing was asked.
            if !state
                .pending
                .as_ref()
                .is_some_and(|(pending, ..)| *pending == id)
            {
                return Err(unsaved());
            }
            closing.2 = true;
            (self.notify)(Notice::Ask(Request {
                id: id.clone(),
                client: client.into(),
                relay: relay.into(),
                process,
                expires_in: APPROVAL.as_secs(),
            }));
        }
        match tokio::time::timeout(APPROVAL, answer).await {
            Ok(Ok(true)) => {}
            Ok(_) if !self.saved(relay)? => return Err(unsaved()),
            Ok(_) => return Err(Failure::new("denied", "Pairing was declined in Buzz")),
            Err(_) => {
                return Err(Failure::new(
                    "approval_required",
                    "Nobody approved the pairing in Buzz in time",
                ))
            }
        }
        match human().await {
            Human::Ready(now) if now == approver => {}
            _ => return Err(Failure::new("denied", "Your Buzz account changed")),
        }
        let token =
            super::new_token().map_err(|_| Failure::new("unavailable", "Could not pair"))?;
        let now = unix_now()?;
        let record = Record {
            id,
            digest: hex(&digest(&token)),
            client: client.into(),
            relay: relay.into(),
            created: now,
            last_used: now,
            approved_by: approver.clone(),
        };
        let account_changed = || Failure::new("denied", "Your Buzz account changed");
        // Saved only under the generation it was approved in, and returned
        // only if no revoke-all began while it was saved: that one removes it.
        // A community removed while it was saved is seen before the write
        // lock is released, which the removal waits for, and removes it.
        let _write = self.write.lock().await;
        let mut unsaved_community = false;
        let id = record.id.clone();
        self.mutate_locked(|records| {
            if self.generation() != Some(generation) {
                return None;
            }
            unsaved_community = !self.saved(relay).unwrap_or(false);
            (!unsaved_community).then(|| records.push(record))
        })
        .await
        .map_err(Failure::unavailable)?
        .ok_or_else(|| {
            if unsaved_community {
                unsaved()
            } else {
                account_changed()
            }
        })?;
        if !self.saved(relay).unwrap_or(false) {
            self.mutate_locked(|records| {
                records.retain(|record| record.id != id);
                Some(())
            })
            .await
            .map_err(Failure::unavailable)?;
            return Err(unsaved());
        }
        drop(_write);
        if self.generation() != Some(generation) {
            return Err(account_changed());
        }
        Ok((token.to_string(), approver))
    }

    /// The human's answer to request `id`; a stale id does nothing.
    pub(crate) fn answer(&self, id: &str, approve: bool) {
        let pending = {
            let mut state = self.state();
            match &state.pending {
                Some((current, ..)) if current == id => state.pending.take(),
                _ => None,
            }
        };
        if let Some((.., send)) = pending {
            let _ = send.send(approve);
        }
    }

    /// The page mounted (`true`) or unmounted a prompt that asks the human.
    pub(crate) fn prompt(&self, mounted: bool) {
        let mut state = self.state();
        state.prompts = if mounted {
            state.prompts + 1
        } else {
            state.prompts.saturating_sub(1)
        };
    }
    /// A new page has mounted no prompt yet, and never heard a request still
    /// waiting: dropping its sender declines it, as the old page's unmount
    /// would have.
    pub(crate) fn page_load(&self) {
        let mut state = self.state();
        state.prompts = 0;
        state.pending = None;
    }

    pub(crate) async fn list(&self) -> Result<Vec<Listed>, String> {
        self.settled().await?;
        Ok(self
            .loaded()
            .await?
            .into_iter()
            .map(|record| Listed {
                expires: record.last_used + DISUSE,
                id: record.id,
                client: record.client,
                relay: record.relay,
                created: record.created,
                last_used: record.last_used,
            })
            .collect())
    }

    /// Revokes one pairing, once its deletion is saved.
    pub(crate) async fn revoke(&self, id: &str) -> Result<(), String> {
        self.mutate(|records| {
            records.retain(|record| record.id != id);
            Some(())
        })
        .await
        .map(drop)
    }

    /// Revokes every pairing, on sign-out or a change of account. Nothing
    /// admitted or approved before this call acts or is saved from the moment
    /// it is made, before its future runs; until the revocation is saved, none
    /// acts at all, in this run or, through the owed marker, the next.
    pub(crate) fn clear(&self) -> impl std::future::Future<Output = Result<(), Unrevoked>> + '_ {
        self.fence(&mut self.state());
        async move {
            let _write = self.write.lock().await;
            self.clear_locked().await
        }
    }

    /// Records durably that a revoke-all is owed, before a sign-out or change
    /// of account commits, so a run that ends before [`Pairings::follow`]'s
    /// revoke is saved still finishes it next launch. A transition that then
    /// fails leaves it owed: a refused pairing is safe, a reused one is not.
    /// Until `release` (which the returned guard calls), nothing settles the
    /// marker and no pairing is approved or admitted, so none can be saved
    /// under the old account behind a marker already used up.
    pub(crate) async fn record_retirement(&self) -> Result<(), String> {
        let _write = self.write.lock().await;
        let keychain = self.keychain.clone();
        tokio::task::spawn_blocking(move || keychain.set_owed(true))
            .await
            .unwrap_or_else(|_| Err("Paired tools could not be revoked".into()))?;
        self.state().retiring += 1;
        Ok(())
    }
    /// Ends a [`Pairings::record_retirement`]: after a commit,
    /// [`Pairings::follow`] fences as for any retirement; after a failure,
    /// the marker stays for the next launch.
    pub(crate) fn release(&self) {
        let mut state = self.state();
        state.retiring = state.retiring.saturating_sub(1);
    }

    fn fence(&self, state: &mut State) {
        state.generation += 1;
        state.owed = true;
        // Dropping the sender declines the open prompt.
        state.pending = None;
    }

    /// Revokes every pairing, from now, once the NIP-FI session reports a
    /// sign-out, close or change of account it has not yet revoked for.
    /// Every request calls it with the session's current count, so revoking
    /// never waits on a watcher, and a sign-out followed by the same account
    /// returning still counts.
    pub(crate) fn follow(&self, retirements: u64) {
        let mut state = self.state();
        if state.retirements != retirements {
            state.retirements = retirements;
            self.fence(&mut state);
        }
    }

    /// Saves an owed revoke-all: the marker first, so a refused clear is
    /// still owed next launch, then the records, then the marker's removal.
    async fn clear_locked(&self) -> Result<(), Unrevoked> {
        match self.lease() {
            Ok(()) => {}
            // Another app holds the records: this one never read or saved
            // any, so none acts here, and it must not write over that app's.
            Err(message) if message == LEASED => return Ok(()),
            // Unchecked, the records may be this app's: the clear is owed.
            Err(message) => {
                let keychain = self.keychain.clone();
                let recorded = tokio::task::spawn_blocking(move || keychain.set_owed(true).is_ok())
                    .await
                    .unwrap_or(false);
                return Err(Unrevoked { recorded, message });
            }
        }
        let keychain = self.keychain.clone();
        tokio::task::spawn_blocking(move || {
            let recorded = keychain.set_owed(true).is_ok();
            keychain
                .write(None)
                .map_err(|message| Unrevoked { recorded, message })?;
            // Once the records are cleared, the marker no longer matters: one
            // that cannot be removed only revokes again next launch.
            let _ = keychain.set_owed(false);
            Ok(())
        })
        .await
        .unwrap_or_else(|_| {
            Err(Unrevoked {
                recorded: false,
                message: "Paired tools could not be revoked".into(),
            })
        })?;
        let mut state = self.state();
        state.records = Some(Ok(Vec::new()));
        state.owed = false;
        drop(state);
        (self.notify)(Notice::Changed);
        Ok(())
    }
}

/// A revoke-all whose records are not yet cleared. `recorded` says the owed
/// marker was saved, so the next launch still finishes it.
#[derive(Debug)]
pub(crate) struct Unrevoked {
    pub(crate) recorded: bool,
    pub(crate) message: String,
}

/// Ends the request with id `.1`; closes its prompt once `.2` says it was asked.
struct Closing<'a>(&'a Pairings, String, bool);
impl Drop for Closing<'_> {
    fn drop(&mut self) {
        let mut state = self.0.state();
        if state.pending.as_ref().is_some_and(|(id, ..)| *id == self.1) {
            state.pending = None;
        }
        drop(state);
        if self.2 {
            (self.0.notify)(Notice::Closed(self.1.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, OnceLock, TryLockError};

    /// A request is asked under the state lock that removal and admission
    /// take, so neither can come between its pending check and its Ask.
    #[tokio::test]
    async fn a_request_is_asked_under_the_state_lock() {
        let pairings: Arc<OnceLock<Arc<Pairings>>> = Arc::default();
        let (asked_send, asked) = std::sync::mpsc::channel();
        let notify: Notify = {
            let pairings = pairings.clone();
            Arc::new(move |notice| {
                if let Notice::Ask(request) = notice {
                    let held = matches!(
                        pairings.get().unwrap().state.try_lock(),
                        Err(TryLockError::WouldBlock)
                    );
                    asked_send.send((request.id, held)).unwrap();
                }
            })
        };
        let keychain = Arc::new(super::super::keychain::Memory::default());
        let made = Arc::new(Pairings::new(Arc::new(keychain), notify));
        pairings.set(made.clone()).ok();
        let relay = "wss://relay.example";
        made.set_communities(vec![relay.into()]).await;
        made.prompt(true);
        let pairing = tokio::spawn({
            let made = made.clone();
            async move {
                let human = || async {
                    Human::Ready(Approver {
                        pubkey: "a".repeat(64),
                        store_account: "account".into(),
                        fi_account: None,
                    })
                };
                made.pair("buzz-cli", relay, || async { None }, human)
                    .await
                    .map(|_| ())
            }
        });
        let (id, held) = tokio::task::spawn_blocking(move || asked.recv().unwrap())
            .await
            .unwrap();
        assert!(held, "Ask was emitted without the state lock");
        made.answer(&id, false);
        assert_eq!(pairing.await.unwrap().err().unwrap().code, "denied");
    }
}
