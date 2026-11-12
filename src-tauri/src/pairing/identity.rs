use nostr::key::{Keys, SecretKey};
use nostr::nips::nip19::ToBech32;
use zeroize::Zeroizing;

pub(super) async fn prepare(
    host: &crate::identity::IdentityHost,
    viewer: String,
    origin: String,
) -> Result<Zeroizing<String>, String> {
    host.with_key(move |secret, current| {
        if current != viewer {
            return Err("The active account changed. Reopen Pair mobile.".into());
        }
        let secret =
            SecretKey::from_slice(secret).map_err(|_| "Couldn’t read your Buzz account.")?;
        payload(&Keys::new(secret), &viewer, &origin)
    })
    .await
}

pub(super) fn payload(
    keys: &Keys,
    expected: &str,
    relay: &str,
) -> Result<Zeroizing<String>, String> {
    if keys.public_key().to_hex() != expected {
        return Err("The saved Buzz account has changed. Reopen Pair mobile and try again.".into());
    }
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        relay_url: &'a str,
        pubkey: &'a str,
        nsec: &'a str,
    }
    let secret = Zeroizing::new(
        keys.secret_key()
            .to_bech32()
            .map_err(|_| "Couldn’t prepare your Buzz account.")?,
    );
    serde_json::to_string(&Payload {
        relay_url: relay,
        pubkey: expected,
        nsec: &secret,
    })
    .map(Zeroizing::new)
    .map_err(|_| "Couldn’t prepare your Buzz account.".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn current_native_identity_is_the_only_payload_source() {
        let host = crate::identity::IdentityHost::fixture();
        let viewer = host.viewer().await.unwrap();
        assert!(prepare(&host, "f".repeat(64), "https://relay.test".into())
            .await
            .is_err());
        let data = prepare(&host, viewer.clone(), "https://relay.test".into())
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&data).unwrap();
        assert_eq!(parsed["pubkey"], viewer);
        assert_eq!(
            Keys::parse(parsed["nsec"].as_str().unwrap())
                .unwrap()
                .public_key()
                .to_hex(),
            viewer
        );
        assert!(prepare(
            &crate::identity::IdentityHost::default(),
            viewer,
            "https://relay.test".into()
        )
        .await
        .is_err());
    }
    #[test]
    fn account_pin_is_checked_before_export() {
        let keys = Keys::generate();
        assert!(payload(
            &keys,
            &Keys::generate().public_key().to_hex(),
            "https://relay.test"
        )
        .is_err());
        let data = payload(&keys, &keys.public_key().to_hex(), "https://relay.test").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&data).unwrap();
        assert_eq!(parsed["relayUrl"], "https://relay.test");
        assert_eq!(
            Keys::parse(parsed["nsec"].as_str().unwrap())
                .unwrap()
                .public_key(),
            keys.public_key()
        );
    }
}
