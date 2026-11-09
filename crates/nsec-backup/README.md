# Native nsec backup HTTP client

The caller supplies a trusted service root (with an optional path prefix) and a
BBIdentity **native CLI** session credential. Use HTTPS; HTTP is allowed only on
loopback for local development. Do not take this configuration from a renderer.
Sign-in, credential custody, HPKE sealing, and key selection/installation remain
with the caller. This crate has no app or IPC wiring.

```rust,no_run
use buzz_nsec_backup::{Client, Error, Recovery, UploadReceipt};

async fn backup_and_recover(
    trusted_root: &str,
    native_session: &str,
    presealed_envelope_json: &[u8],
) -> Result<(UploadReceipt, Recovery), Error> {
    let client = Client::new(trusted_root, native_session)?;
    let receipt = client.upload(presealed_envelope_json).await?;
    let recovery = client.recover().await?;
    // Each backup exposes public metadata and decoded bytes via secret_key().
    Ok((receipt, recovery))
}
```

Call `enroll()` before sealing; the encryption layer must validate its version,
suite, metadata, and recipient public key. Upload sends the supplied JSON bytes
unchanged, up to 4096 bytes, with no automatic retries. Keep those same bytes for
a caller-initiated retry. Redirects are rejected and requests time out after 30 seconds.

Recovery reads the backup service's JSON list of backups and failed IDs. It
preserves every returned backup and failed ID in order, including successful
responses with only failed IDs. `Error::HttpStatus(404)` can mean no backups or an
unavailable recovery endpoint; it does not prove that no backups exist. Other
status codes, transport failures, malformed responses, and size violations remain
separate. Recovery reads are bounded to 64 KiB, sufficient for 100 backups.

Owned response buffers, encoded secrets, and decoded keys use best-effort
zeroization. Client/recovery diagnostics omit credentials and secrets; errors omit
response bodies. Caller copies and HTTP/JSON framework allocations are not
guaranteed wiped. No live KMS test has been performed.
