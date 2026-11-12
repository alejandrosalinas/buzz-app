mod identity;
mod relay;

use buzz_pairing::{AbortReason, PairingSession, PayloadType, SessionState};
use futures_util::FutureExt;
use nostr::event::Event;
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Status {
    Connecting,
    Qr { svg: String, uri: String },
    Code { code: String },
    Transferring,
    Complete,
    Expired,
    Uncertain,
    Error { message: String },
    Cancelled,
}
#[derive(Clone, Copy)]
enum Decision {
    Confirm,
    Deny,
}
struct Active {
    id: String,
    cancel: CancellationToken,
    confirm: mpsc::Sender<Decision>,
    finished: CancellationToken,
    status: Status,
    payload_sent: bool,
}
/// The live attempt, and whether sign-out has closed pairing for good. The flag
/// is only read and written under the attempt lock.
#[derive(Clone, Default)]
pub struct Pairing(Arc<Mutex<Option<Active>>>, Arc<AtomicBool>);
// Cancels the attempt and returns its teardown signal and visible outcome. After
// possible publication, the attempt stays registered as its terminal outcome so
// later status reads cannot report an unsent cancellation.
fn stop(active: &mut Option<Active>) -> Option<(CancellationToken, Status)> {
    let old = active.as_mut()?;
    old.cancel.cancel();
    if !old.payload_sent {
        return active.take().map(|old| (old.finished, Status::Cancelled));
    }
    if !matches!(
        old.status,
        Status::Complete | Status::Uncertain | Status::Error { .. }
    ) {
        old.status = Status::Uncertain;
    }
    Some((old.finished.clone(), old.status.clone()))
}
impl Pairing {
    pub fn cancel_all(&self) {
        stop(&mut self.0.lock().unwrap_or_else(|error| error.into_inner()));
    }

    /// Signing out: cancel the live attempt before it can publish the key, and
    /// admit none until Buzz restarts. A payload already published stays uncertain.
    pub(crate) fn close(&self) {
        let mut active = self.0.lock().unwrap_or_else(|error| error.into_inner());
        self.1.store(true, Ordering::Relaxed);
        stop(&mut active);
    }

    /// Replace any live attempt, unless sign-out has closed pairing.
    fn admit(&self, attempt: Active) -> Result<(), String> {
        let mut active = self
            .0
            .lock()
            .map_err(|_| "Pairing is unavailable. Restart Buzz.")?;
        if self.1.load(Ordering::Relaxed) {
            return Err("Buzz is signing out.".into());
        }
        if let Some(old) = active.take() {
            old.cancel.cancel();
        }
        *active = Some(attempt);
        Ok(())
    }

    fn update(&self, id: &str, status: Status) {
        if let Ok(mut active) = self.0.lock() {
            if let Some(active) = active
                .as_mut()
                .filter(|a| a.id == id && !a.cancel.is_cancelled())
            {
                active.status = status;
            }
        }
    }
    // Serialized with cancellation: false means cancellation won and the payload
    // must not be published.
    fn mark_payload_sent(&self, id: &str) -> bool {
        let Ok(mut active) = self.0.lock() else {
            return false;
        };
        match active
            .as_mut()
            .filter(|a| a.id == id && !a.cancel.is_cancelled())
        {
            Some(active) => {
                active.payload_sent = true;
                true
            }
            None => false,
        }
    }
    fn expire(&self, id: &str) {
        self.fail(id, Status::Expired, true);
    }
    fn fail(&self, id: &str, status: Status, ambiguous: bool) {
        if let Ok(mut active) = self.0.lock() {
            if let Some(active) = active
                .as_mut()
                .filter(|a| a.id == id && !a.cancel.is_cancelled())
            {
                active.status = if active.payload_sent && ambiguous {
                    Status::Uncertain
                } else {
                    status
                };
            }
        }
    }

    async fn cancel(&self, id: &str) -> Result<Status, String> {
        let stopped = {
            let mut active = self
                .0
                .lock()
                .map_err(|_| "Pairing is unavailable. Restart Buzz.")?;
            if active.as_ref().is_some_and(|a| a.id == id) {
                stop(&mut active)
            } else {
                None
            }
        };
        let Some((finished, status)) = stopped else {
            return Ok(Status::Cancelled);
        };
        tokio::time::timeout(Duration::from_secs(3), finished.cancelled())
            .await
            .map_err(|_| "Couldn’t cancel pairing. Close this window before trying again.")?;
        Ok(status)
    }
}

#[tauri::command]
pub async fn pairing_account(
    host: tauri::State<'_, crate::identity::IdentityHost>,
) -> Result<String, String> {
    host.with_key(|_, viewer| Ok(viewer.to_owned())).await
}
#[tauri::command]
pub fn pairing_status(pairing: tauri::State<'_, Pairing>, id: String) -> Result<Status, String> {
    let active = pairing
        .0
        .lock()
        .map_err(|_| "Pairing is unavailable. Restart Buzz.")?;
    Ok(active
        .as_ref()
        .filter(|a| a.id == id)
        .map(|a| a.status.clone())
        .unwrap_or(Status::Cancelled))
}
#[tauri::command]
pub async fn pairing_cancel(
    pairing: tauri::State<'_, Pairing>,
    id: String,
) -> Result<Status, String> {
    pairing.cancel(&id).await
}
fn decide(pairing: &Pairing, id: &str, decision: Decision) -> Result<(), String> {
    let mut active = pairing
        .0
        .lock()
        .map_err(|_| "Pairing is unavailable. Restart Buzz.")?;
    let active = active
        .as_mut()
        .filter(|a| a.id == id && matches!(a.status, Status::Code { .. }))
        .ok_or("This comparison is no longer available.")?;
    active
        .confirm
        .try_send(decision)
        .map_err(|_| "A pairing decision is already in progress.")?;
    // Keep Code visible to the native owner until the bounded denial finishes.
    // The client holds its own "cancelling" display state while polling for the result.
    if matches!(decision, Decision::Confirm) {
        active.status = Status::Transferring;
    }
    Ok(())
}
#[tauri::command]
pub fn pairing_confirm(pairing: tauri::State<'_, Pairing>, id: String) -> Result<(), String> {
    decide(&pairing, &id, Decision::Confirm)
}
#[tauri::command]
pub fn pairing_deny(pairing: tauri::State<'_, Pairing>, id: String) -> Result<(), String> {
    decide(&pairing, &id, Decision::Deny)
}
#[tauri::command]
pub fn pairing_start(
    pairing: tauri::State<'_, Pairing>,
    host: tauri::State<'_, crate::identity::IdentityHost>,
    id: String,
    viewer: String,
    community: String,
) -> Result<(), String> {
    if id.len() != 36 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Err("Unsupported pairing request.".into());
    }
    if viewer.len() != 64 || !viewer.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Choose your Buzz account before pairing.".into());
    }
    let origin = relay::community(&community)?;
    let (tx, rx) = mpsc::channel(1);
    let cancel = CancellationToken::new();
    let finished = CancellationToken::new();
    pairing.admit(Active {
        id: id.clone(),
        cancel: cancel.clone(),
        finished: finished.clone(),
        confirm: tx,
        status: Status::Connecting,
        payload_sent: false,
    })?;
    let host = host.inner().clone();
    let pairing = pairing.inner().clone();
    tauri::async_runtime::spawn(async move {
        let result = guard(run(&pairing, &host, &id, viewer, origin, rx, &cancel)).await;
        match result {
            Ok(()) => pairing.update(&id, Status::Complete),
            Err(Failure::Expired) => pairing.expire(&id),
            Err(failure) => {
                let ambiguous = matches!(failure, Failure::Transport(_));
                let (Failure::Transport(message) | Failure::Rejected(message)) = failure else {
                    unreachable!()
                };
                pairing.fail(&id, Status::Error { message }, ambiguous);
            }
        }
        finished.cancel();
    });
    Ok(())
}

#[derive(Debug)]
enum Failure {
    Expired,
    Transport(String),
    Rejected(String),
}
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self::Transport(message)
    }
}
impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        Self::Transport(message.into())
    }
}

async fn guard(
    future: impl std::future::Future<Output = Result<(), Failure>>,
) -> Result<(), Failure> {
    std::panic::AssertUnwindSafe(future)
        .catch_unwind()
        .await
        .unwrap_or_else(|_| {
            Err("Pairing stopped unexpectedly. Create a new code and try again.".into())
        })
}

async fn run(
    pairing: &Pairing,
    host: &crate::identity::IdentityHost,
    id: &str,
    viewer: String,
    origin: url::Url,
    mut confirm: mpsc::Receiver<Decision>,
    cancel: &CancellationToken,
) -> Result<(), Failure> {
    let origin_string = origin.as_str().trim_end_matches('/').to_string();
    let payload = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Ok(()),
        result = identity::prepare(host, viewer, origin_string) => result?,
    };
    let setup = async {
        let relay_url = relay::discover(&origin).await?;
        let (session, qr) = PairingSession::new_source(relay_url.to_string());
        let connection_started = tokio::time::Instant::now();
        let mut socket = relay::connect(&relay_url, Duration::from_secs(10)).await?;
        let (pending, auth) = relay::subscribe(&mut socket, &session, &relay_url).await?;
        let uri = Zeroizing::new(buzz_pairing::qr::encode_qr(&qr));
        let svg = crate::qr::render(&uri, crate::qr::Variant::Light)
            .map_err(|()| "Couldn’t create the pairing code.")?;
        Ok::<_, Failure>((
            Exchange {
                session,
                payload: Some(payload),
            },
            socket,
            relay_url,
            pending,
            auth,
            svg,
            uri.to_string(),
            connection_started,
        ))
    };
    let (mut exchange, mut socket, relay_url, pending, mut auth, svg, uri, connection_started) = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Ok(()),
        result = tokio::time::timeout(Duration::from_secs(35), setup) =>
            result.map_err(|_| Failure::Transport("Pairing setup timed out. Check your connection and try again.".into()))??,
    };
    // Keep protocol expiry aligned with display, but renew before the transport cap.
    exchange.session.start_source_lifetime();
    let deadline = exchange_deadline(&exchange.session, connection_started);
    pairing.update(id, Status::Qr { svg, uri });
    exchange_until_deadline(
        ExchangeContext {
            pairing,
            id,
            relay_url: &relay_url,
            pending,
        },
        &mut exchange,
        &mut socket,
        &mut auth,
        &mut confirm,
        cancel,
        deadline,
    )
    .await
}

// The supported sidecar closes connections after 120 seconds. Start before the
// handshake and reserve five seconds so expiry wins over its disconnect. Setup
// consumes this budget; arbitrary transport failures still remain errors.
const CONNECTION_BUDGET: Duration = Duration::from_secs(115);

fn exchange_deadline(
    session: &PairingSession,
    connection_started: tokio::time::Instant,
) -> tokio::time::Instant {
    tokio::time::Instant::from_std(session.deadline()).min(connection_started + CONNECTION_BUDGET)
}

struct ExchangeContext<'a> {
    pairing: &'a Pairing,
    id: &'a str,
    relay_url: &'a url::Url,
    pending: Vec<Event>,
}

async fn exchange_until_deadline(
    context: ExchangeContext<'_>,
    exchange: &mut Exchange,
    socket: &mut relay::Socket,
    auth: &mut relay::Authentication,
    confirm: &mut mpsc::Receiver<Decision>,
    cancel: &CancellationToken,
    deadline: tokio::time::Instant,
) -> Result<(), Failure> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            // Once transfer construction has consumed the payload, publication may
            // already have reached the phone. An abort would interrupt its import.
            if exchange.payload.is_some() {
                abort(exchange, socket).await;
            }
            Ok(())
        }
        _ = tokio::time::sleep_until(deadline) => Err(Failure::Expired),
        result = exchange_loop(context, exchange, socket, auth, confirm) => result,
    }
}

// The same bounded best-effort notification serves explicit rejection and teardown.
async fn abort(exchange: &mut Exchange, socket: &mut relay::Socket) {
    if let Ok(Some(event)) = exchange.session.abort(AbortReason::UserDenied) {
        let _ = tokio::time::timeout(Duration::from_secs(2), relay::send(socket, &event)).await;
    }
}

async fn exchange_loop(
    context: ExchangeContext<'_>,
    exchange: &mut Exchange,
    socket: &mut relay::Socket,
    auth: &mut relay::Authentication,
    confirm: &mut mpsc::Receiver<Decision>,
) -> Result<(), Failure> {
    let ExchangeContext {
        pairing,
        id,
        relay_url,
        pending,
    } = context;
    let mut pending = std::collections::VecDeque::from(pending);
    loop {
        let output = if let Some(event) = pending.pop_front() {
            exchange.receive(&event).map_err(Failure::Rejected)?
        } else {
            loop {
                let output = tokio::select! {
                    Some(decision) = confirm.recv() => match decision {
                        Decision::Confirm => exchange.confirm().map_err(Failure::Rejected)?,
                        Decision::Deny => {
                            if exchange.session.state() != SessionState::Confirming {
                                return Err(Failure::Rejected("This comparison is no longer available.".into()));
                            }
                            abort(exchange, socket).await;
                            return Err(Failure::Rejected("Pairing was canceled.".into()));
                        }
                    },
                    message = relay::next(socket) => {
                        let message = message?;
                        if auth.handle(socket, &exchange.session, relay_url, &message).await? { continue; }
                        if let Some(event) = relay::event(&message) {
                            exchange.receive(&event).map_err(Failure::Rejected)?
                        } else { continue; }
                    }
                };
                break output;
            }
        };
        let payload_index = output.events.len().checked_sub(1);
        for (index, event) in output.events.into_iter().enumerate() {
            if output.status == Some(Status::Transferring) && Some(index) == payload_index {
                // Once publication begins, cancellation of the await cannot prove
                // that the phone did not receive and import this payload.
                if !pairing.mark_payload_sent(id) {
                    abort(exchange, socket).await;
                    return Ok(());
                }
            }
            relay::send(socket, &event).await?;
            auth.unacknowledged.push(event);
        }
        if let Some(status) = output.status {
            if status == Status::Complete {
                return Ok(());
            }
            if let Status::Error { message } = status {
                return Err(Failure::Rejected(message));
            }
            pairing.update(id, status);
        }
    }
}

struct Exchange {
    session: PairingSession,
    payload: Option<Zeroizing<String>>,
}
#[derive(Default)]
struct Output {
    events: Vec<Event>,
    status: Option<Status>,
}
impl Exchange {
    fn transfer(&mut self, proof: Event) -> Result<Output, String> {
        let payload = self
            .payload
            .take()
            .ok_or("This pairing code has already been used.")?;
        let event = self
            .session
            .send_payload(PayloadType::Custom, payload)
            .map_err(|_| "Couldn’t prepare the pairing transfer.")?;
        Ok(Output {
            events: vec![proof, event],
            status: Some(Status::Transferring),
        })
    }
    fn confirm(&mut self) -> Result<Output, String> {
        let proof = self
            .session
            .confirm_sas()
            .map_err(|_| "This confirmation has expired. Try pairing again.")?;
        self.transfer(proof)
    }
    fn receive(&mut self, event: &Event) -> Result<Output, String> {
        if self.session.handle_abort(event).is_ok() {
            return Err("Pairing was cancelled on your phone. Try again when you’re ready.".into());
        }
        if let Ok(code) = self.session.handle_offer(event) {
            return Ok(Output {
                events: vec![],
                status: Some(Status::Code { code }),
            });
        }

        match self.session.handle_complete(event) {
            Ok(()) => {
                return Ok(Output {
                    events: vec![],
                    status: Some(Status::Complete),
                })
            }
            Err(_) if self.session.state() == SessionState::Aborted => {
                return Err("Your phone couldn’t save the account. Try pairing again.".into())
            }
            Err(_) => {}
        }
        Ok(Output::default())
    }
}
#[cfg(test)]
mod tests;

#[cfg(test)]
mod relay_tests;
