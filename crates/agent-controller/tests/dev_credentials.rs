#![cfg(all(target_os = "macos", debug_assertions))]

use buzz_agent_controller::{Credentials, PlatformCredentials, Secret};
use std::fs;
use std::os::unix::fs::PermissionsExt;

#[test]
fn debug_agents_use_the_helper_for_create_restore_and_delete() {
    const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    let directory = tempfile::tempdir().unwrap();
    let helper = directory.path().join("helper");
    let id = format!("{PUB}-{}", "a".repeat(64));
    let key = Secret::parse(KEY, PUB).unwrap();
    std::env::set_var("BUZZ_DEV_CREDENTIAL_HELPER", &helper);
    std::env::remove_var("BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE");
    let write_helper = |body: &str| {
        fs::write(&helper, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    };
    write_helper(
        r#"
[ "$1" = --agent-store ] || exit 11
[ "$3" = xyz.block.buzz.desktop.onboarding-test.agents ] || exit 10
[ "$4" = agent-bundle-v1 ] || exit 10
case "$2" in
  read) [ -f "$0.bundle" ] || exit 10; /bin/cat "$0.bundle" ;;
  replace) /bin/cat <&1 > "$0.bundle" ;;
  *) exit 1 ;;
esac
"#,
    );
    let credentials = PlatformCredentials::default();
    assert!(credentials.read(&id, PUB).unwrap().is_none());
    credentials.add(&id, &key).unwrap();
    assert!(credentials
        .add(&id, &key)
        .unwrap_err()
        .contains("already exists"));
    let restored = PlatformCredentials::default();
    assert_eq!(
        restored.read(&id, PUB).unwrap().unwrap().hex().as_str(),
        KEY
    );
    restored.delete(&id, PUB).unwrap();
    // The original instance must see the mutation, even with a cached key.
    assert!(credentials.read(&id, PUB).unwrap().is_none());
    assert_eq!(
        fs::read_to_string(helper.with_extension("bundle")).unwrap(),
        "{}"
    );

    for (body, expected) in [
        ("exit 11", "denied"),
        ("exit 12", "malformed"),
        ("exit 1", "unavailable"),
        ("printf '{'", "malformed"),
    ] {
        write_helper(body);
        let credentials = PlatformCredentials::default();
        assert!(credentials.read(&id, PUB).err().unwrap().contains(expected));
        credentials.retry();
        assert!(credentials.add(&id, &key).unwrap_err().contains(expected));
        assert!(credentials.delete(&id, PUB).unwrap_err().contains(expected));
    }
    // An invalid helper must not allow a cached bundle to bypass setup validation.
    std::env::set_var("BUZZ_DEV_CREDENTIAL_HELPER", "relative-helper");
    let credentials = PlatformCredentials::default();
    assert!(credentials
        .add(&id, &key)
        .unwrap_err()
        .contains("unavailable"));
    assert!(credentials.read(&id, PUB).is_err());
    assert!(credentials.delete(&id, PUB).is_err());
    std::env::remove_var("BUZZ_DEV_CREDENTIAL_HELPER");
}
