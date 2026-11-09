//! Paired tools: `pair`, and requests made with a paired token, which act as
//! the human under the same operation policy as an agent's.
use super::pairing::{Approver, Human, Record};
use super::{digest, on_relay, permitted, unsupported};
use super::{full_budgets, spend, CredentialService, Failure, Unsigned};
use crate::identity::EventTemplate;
use buzz_agent_controller::{bounded, framed, CANVAS_MAX_EVENT_BYTES};
use serde_json::json;
use std::net::SocketAddr;

const STARTING: &str = "Buzz is still starting; retry shortly";

impl CredentialService {
    /// The human paired tools act as, once the key and NIP-FI are settled.
    pub(super) async fn human(&self) -> Human {
        self.0.pairings.follow(self.0.session.retirements());
        if self.0.agents.caller_closed() {
            return Human::Absent;
        }
        let pubkey = match self.0.identity.saved_viewer().await {
            Ok(Some(pubkey)) => pubkey,
            Ok(None) => return Human::Absent,
            Err(_) => return Human::Pending(STARTING),
        };
        match self.0.session.pairing_account() {
            Some((store_account, fi_account)) => Human::Ready(Approver {
                pubkey,
                store_account,
                fi_account,
            }),
            None if self.0.session.expired() => {
                Human::Pending("Your Builderlab sign-in expired; sign in again in Buzz")
            }
            None => Human::Pending(STARTING),
        }
    }

    /// `connection` is the caller's address and this service's, which name
    /// the process asking.
    pub(super) async fn pair(
        &self,
        params: &[String],
        connection: Option<(SocketAddr, SocketAddr)>,
    ) -> Result<String, Failure> {
        let [client, relay] = params else {
            return Err(Failure::new("invalid_request", "Wrong parameters for pair"));
        };
        let process = || async move {
            let (peer, service) = connection?;
            super::peer::name(peer, service).await
        };
        let (token, approver) = self
            .0
            .pairings
            .pair(client, relay, process, || self.human())
            .await?;
        Ok(json!({
            "token": token,
            "instance": self.0.instance,
            "pubkey": approver.pubkey,
            "relays": [relay],
        })
        .to_string())
    }

    pub(super) async fn owner_request(
        &self,
        token: &str,
        method: &str,
        params: &[String],
    ) -> Result<String, Failure> {
        let (record, generation) = self.0.pairings.admit(token, self.human().await).await?;
        {
            let mut budgets = self
                .0
                .owner_budgets
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            spend(
                budgets.entry(digest(token)).or_insert_with(full_budgets),
                method,
            )?;
        }
        let pubkey = match self.human().await {
            Human::Ready(approver) => approver.pubkey,
            _ => return Err(Failure::revoked()),
        };
        #[cfg(test)]
        drop(self.0.owner_call_gate.read().await);
        let result = self.owner_call(&record, &pubkey, method, params).await;
        // Revoked, or the human changed, while it ran: whatever it made stays here.
        let still = matches!(self.human().await, Human::Ready(now) if now == record.approved_by);
        if !still || !self.0.pairings.holds(&record.id, generation) {
            return Err(Failure::revoked());
        }
        result
    }

    async fn owner_call(
        &self,
        record: &Record,
        pubkey: &str,
        method: &str,
        params: &[String],
    ) -> Result<String, Failure> {
        let identity = &self.0.identity;
        // The human key, lent to one purpose-bound operation.
        async fn with_secret<T: Send + 'static>(
            identity: &crate::identity::IdentityHost,
            action: impl FnOnce(&buzz_agent_controller::Secret) -> Result<T, String> + Send + 'static,
        ) -> Result<T, Failure> {
            identity
                .with_key(move |key, viewer| {
                    action(&buzz_agent_controller::Secret::from_bytes(key, viewer)?)
                })
                .await
                .map_err(|error| Failure::new("invalid_request", &error))
        }
        match (method, params) {
            ("describe", []) => Ok(self.described(pubkey, None, &record.relay)),
            ("get_public_key", []) => Ok(pubkey.to_owned()),
            ("sign_event", [event]) => {
                let event = Unsigned::parse(event, pubkey)?;
                permitted(&event, &record.relay)?;
                bounded(event.kind, &event.content, &event.tags)
                    .map_err(|error| Failure::new("invalid_request", &error))?;
                // A Canvas is bounded by its content above and its complete
                // event below, as an agent's is; every other kind by 64 KiB.
                let limit = if event.kind == 40100 {
                    CANVAS_MAX_EVENT_BYTES
                } else {
                    64 * 1024
                };
                let kind = event.kind;
                identity
                    .sign_bounded(
                        EventTemplate {
                            created_at: event.created_at,
                            kind,
                            tags: event.tags,
                            content: event.content,
                        },
                        limit,
                    )
                    .await
                    .and_then(|signed| framed(kind, signed))
                    .map(|signed| signed.to_string())
                    .map_err(|error| Failure::new("invalid_request", &error))
            }
            ("nip44_encrypt", [peer, plaintext]) => {
                let (peer, plaintext) = (peer.clone(), plaintext.clone());
                with_secret(identity, move |key| key.nip44_encrypt(&peer, &plaintext)).await
            }
            ("nip44_decrypt", [peer, payload]) => {
                let (peer, payload) = (peer.clone(), payload.clone());
                with_secret(identity, move |key| {
                    key.nip44_decrypt(&peer, &payload)
                        .map(|text| text.to_string())
                })
                .await
            }
            ("engram_d_tag", [peer, slug]) => {
                let (peer, slug) = (peer.clone(), slug.clone());
                with_secret(identity, move |key| key.memory_d_tag(&peer, &slug)).await
            }
            ("federated_identity", [relay]) => {
                on_relay(relay, &record.relay)?;
                let url = url::Url::parse(relay)
                    .map_err(|_| Failure::new("invalid_request", "Invalid relay URL"))?;
                let authorization = self
                    .0
                    .session
                    .assertion_for_relay(identity, &url)
                    .await
                    .map_err(Failure::unavailable)?;
                // The contract's result is the assertion itself; the caller adds `Bearer `.
                Ok(authorization
                    .header()
                    .and_then(|header| header.strip_prefix("Bearer "))
                    .unwrap_or_default()
                    .to_owned())
            }
            // An owner's events carry no NIP-OA tag.
            ("auth_tag", []) => Ok(String::new()),
            (method, _) => Err(unsupported(method)),
        }
    }
}
