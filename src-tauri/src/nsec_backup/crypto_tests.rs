use rustls::crypto::hpke::{EncapsulatedSecret, HpkePrivateKey};
use serde_json::Value;
use zeroize::Zeroizing;

use super::*;

#[derive(serde::Deserialize)]
struct Fixture {
    recipient_public_key_sec1_hex: String,
    recipient_private_key_hex: String,
    nostr_secret_key_hex: String,
    aad_hex: String,
    envelope: Value,
}

fn fixture() -> Fixture {
    // Shared with block/buzz#7849; all private values are synthetic.
    serde_json::from_str(include_str!("fixtures/hpke_nsec_backup_v1.json")).unwrap()
}

fn enrollment(envelope: &Value) -> Enrollment {
    let mut value = envelope.clone();
    value["recipient_public_key"] = URL_SAFE_NO_PAD
        .encode(hex::decode(fixture().recipient_public_key_sec1_hex).unwrap())
        .into();
    serde_json::from_value(value).unwrap()
}

fn seal_fixture(enrollment: &Enrollment, secret: &[u8; 32]) -> Result<Value, String> {
    let bytes = seal(
        enrollment,
        "backup/staging",
        "subject:01J8A4M7Q1G4X8S8M51FS7K2HX",
        "24653eac434488002cc06bbfb7f10fe18991e35f9fe4302dbea6d2353dc0ab1c",
        secret,
    )?;
    Ok(serde_json::from_slice(&bytes).unwrap())
}

fn open(envelope: &Value) -> Result<Zeroizing<Vec<u8>>, String> {
    let enrollment = enrollment(envelope);
    let context = validate(
        &enrollment,
        &enrollment.service_namespace,
        &enrollment.owner_id,
        &enrollment.nostr_pubkey,
    )?;
    DH_KEM_P256_HKDF_SHA256_AES_256
        .open(
            &EncapsulatedSecret(
                URL_SAFE_NO_PAD
                    .decode(envelope["enc"].as_str().unwrap())
                    .unwrap(),
            ),
            INFO,
            &associated_data(&enrollment, &context.backup_id, &context.pubkey),
            &URL_SAFE_NO_PAD
                .decode(envelope["ciphertext"].as_str().unwrap())
                .unwrap(),
            &HpkePrivateKey::from(hex::decode(fixture().recipient_private_key_hex).unwrap()),
        )
        .map(Zeroizing::new)
        .map_err(|_| FAILED.into())
}

#[test]
fn shared_backend_fixture_reconstructs_context_and_opens() {
    let fixture = fixture();
    let enrollment = enrollment(&fixture.envelope);
    let context = validate(
        &enrollment,
        &enrollment.service_namespace,
        &enrollment.owner_id,
        &enrollment.nostr_pubkey,
    )
    .unwrap();
    assert_eq!(
        hex::encode(associated_data(
            &enrollment,
            &context.backup_id,
            &context.pubkey
        )),
        fixture.aad_hex
    );
    assert_eq!(
        &*open(&fixture.envelope).unwrap(),
        &hex::decode(fixture.nostr_secret_key_hex).unwrap()
    );
}

#[test]
fn native_seal_matches_receiver_and_authenticates_all_metadata() {
    let original = seal_fixture(&enrollment(&fixture().envelope), &[0x42; 32]).unwrap();
    assert_eq!(&**open(&original).unwrap(), &[0x42; 32]);
    for (field, changed) in [
        ("recipient_key_id", "another-key"),
        ("service_namespace", "backup/production"),
        ("owner_id", "another-owner"),
        ("backup_id", "018f6f4e-83d1-7a4e-8c8e-4f914f7d31a3"),
        (
            "nostr_pubkey",
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        ),
    ] {
        let mut tampered = original.clone();
        tampered[field] = changed.into();
        assert!(open(&tampered).is_err(), "accepted changed {field}");
    }
    for field in ["enc", "ciphertext"] {
        let mut tampered = original.clone();
        let mut bytes = URL_SAFE_NO_PAD
            .decode(original[field].as_str().unwrap())
            .unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        tampered[field] = URL_SAFE_NO_PAD.encode(bytes).into();
        assert!(open(&tampered).is_err(), "accepted changed {field}");
    }
    let json = serde_json::to_string(&original).unwrap();
    assert!(!json.contains(&hex::encode([0x42; 32])));
    assert!(!json.contains("nsec1"));
}

#[test]
fn context_length_framing_preserves_identifier_boundaries() {
    let mut first = enrollment(&fixture().envelope);
    first.recipient_key_id = "ab".into();
    first.service_namespace = "c".into();
    let bytes = seal(
        &first,
        "c",
        &first.owner_id,
        &first.nostr_pubkey,
        &[0x42; 32],
    )
    .unwrap();
    let mut changed: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(&**open(&changed).unwrap(), &[0x42; 32]);
    changed["recipient_key_id"] = "a".into();
    changed["service_namespace"] = "bc".into();
    assert!(open(&changed).is_err());
}

#[test]
fn sealing_rejects_untrusted_context_invalid_scalar_and_mismatched_key() {
    let enrollment = enrollment(&fixture().envelope);
    for (namespace, owner, pubkey) in [
        (
            "backup/production",
            enrollment.owner_id.as_str(),
            enrollment.nostr_pubkey.as_str(),
        ),
        (
            enrollment.service_namespace.as_str(),
            "another-owner",
            enrollment.nostr_pubkey.as_str(),
        ),
        (
            enrollment.service_namespace.as_str(),
            enrollment.owner_id.as_str(),
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        ),
    ] {
        assert!(seal(&enrollment, namespace, owner, pubkey, &[0x42; 32]).is_err());
    }
    for secret in [[0; 32], [0xff; 32], [0x43; 32]] {
        assert!(seal_fixture(&enrollment, &secret).is_err());
    }
}

#[test]
fn enrollment_rejects_wrong_suite_noncanonical_metadata_and_recipient_keys() {
    let original = fixture().envelope;
    for (path, value) in [
        ("/version", Value::from(2)),
        ("/suite/kem_id", Value::from(0x20)),
        ("/suite/kdf_id", Value::from(2)),
        ("/suite/aead_id", Value::from(1)),
        ("/recipient_key_id", Value::from("")),
        ("/recipient_key_id", Value::from("x".repeat(256))),
        ("/recipient_key_id", Value::from("key\nvalue")),
        ("/owner_id", Value::from("owner\u{0085}value")),
        (
            "/backup_id",
            Value::from("018F6F4E-83D1-7A4E-8C8E-4F914F7D31A2"),
        ),
        ("/backup_id", Value::from("not-a-uuid")),
        (
            "/nostr_pubkey",
            Value::from("24653EAC434488002CC06BBFB7F10FE18991E35F9FE4302DBEA6D2353DC0AB1C"),
        ),
    ] {
        let mut changed = original.clone();
        *changed.pointer_mut(path).unwrap() = value;
        let changed = enrollment(&changed);
        assert!(
            seal(
                &changed,
                &changed.service_namespace,
                &changed.owner_id,
                &changed.nostr_pubkey,
                &[0x42; 32],
            )
            .is_err(),
            "accepted {path}"
        );
    }
    let mut off_curve = [0; 65];
    off_curve[0] = 0x04;
    for recipient in [
        "A".repeat(86),
        "A".repeat(1_000_000),
        format!("{}=", enrollment(&original).recipient_public_key),
        "!".repeat(87),
        URL_SAFE_NO_PAD.encode([0; 65]),
        URL_SAFE_NO_PAD.encode(off_curve),
    ] {
        let mut changed = enrollment(&original);
        changed.recipient_public_key = recipient;
        assert!(seal_fixture(&changed, &[0x42; 32]).is_err());
    }
}

#[test]
fn rfc9180_base_p256_sha256_aes256_vector_opens() {
    // RFC 9180 pinned CFRG vector, tuple KEM=16/KDF=1/AEAD=2:
    // https://github.com/cfrg/draft-irtf-cfrg-hpke/blob/5f503c564da00b0687b3de75f1dfbdfc4079ad31/test-vectors.json
    let opened = DH_KEM_P256_HKDF_SHA256_AES_256.open(
        &EncapsulatedSecret(hex::decode("04c06b4f6bebc7bb495cb797ab753f911aff80aefb86fd8b6fcc35525f3ab5f03e0b21bd31a86c6048af3cb2d98e0d3bf01da5cc4c39ff5370d331a4f1f7d5a4e0").unwrap()),
        &hex::decode("4f6465206f6e2061204772656369616e2055726e").unwrap(),
        &hex::decode("436f756e742d30").unwrap(),
        &hex::decode("58c61a45059d0c5704560e9d88b564a8b63f1364b8d1fcb3c4c6ddc1d291742465e902cd216f8908da49f8f96f").unwrap(),
        &HpkePrivateKey::from(hex::decode("317f915db7bc629c48fe765587897e01e282d3e8445f79f27f65d031a88082b2").unwrap()),
    ).unwrap();
    assert_eq!(
        opened,
        hex::decode("4265617574792069732074727574682c20747275746820626561757479").unwrap()
    );
}
