#![cfg(all(target_os = "macos", debug_assertions))]

use buzz_credential_store::{
    add, compare_session, delete, delete_session, dev_item, read_human, read_session, replace,
    Error,
};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;

#[test]
fn human_restore_uses_the_selected_helper_and_fails_closed() {
    let directory = tempfile::tempdir().unwrap();
    let helper = directory.path().join("helper");
    std::env::set_var("BUZZ_DEV_CREDENTIAL_HELPER", &helper);
    std::env::remove_var("BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE");
    assert_eq!(read_human(), Err(Error::Unavailable));

    let payload = "x".repeat(63);
    for (body, expected) in [
        (
            format!("printf '{payload}'"),
            Ok(payload.as_bytes().to_vec()),
        ),
        // Absent under both the current and the pre-1.0 service.
        ("exit 10".into(), Err(Error::Absent)),
        ("exit 11".into(), Err(Error::Denied)),
        ("exit 12".into(), Err(Error::Corrupt)),
        ("exit 13".into(), Err(Error::Occupied)),
        ("exit 1".into(), Err(Error::Unavailable)),
        ("kill -TERM $$".into(), Err(Error::Unavailable)),
        (format!("printf '{payload}'; exit 11"), Err(Error::Denied)),
    ] {
        fs::write(&helper, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(read_human().map(|value| value.to_vec()), expected);
    }

    fs::write(
        &helper,
        format!(
            "#!/bin/sh\n[ \"$*\" = '--item read xyz.block.buzz.desktop.identity.debug human' ] || exit 11\nprintf '{payload}'\n"
        ),
    )
    .unwrap();
    assert!(read_human().is_ok());
    std::env::set_var("BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE", "0");
    assert!(read_human().is_ok());
    std::env::set_var("BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE", "1");
    fs::write(
        &helper,
        format!(
            "#!/bin/sh\n[ \"$*\" = '--authorize --item read xyz.block.buzz.desktop.identity.debug human' ] || exit 11\nprintf '{payload}'\n"
        ),
    )
    .unwrap();
    assert!(read_human().is_ok());
    std::env::remove_var("BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE");

    // `just desktop me` reads the release key through the helper too, and a
    // refused release read never falls back to the debug key.
    std::env::set_var("BUZZ_DEV_RELEASE_KEY", "1");
    fs::write(
        &helper,
        format!(
            "#!/bin/sh\n[ \"$*\" = '--item read xyz.block.buzz.desktop.identity human' ] || exit 12\nprintf '{payload}'\n"
        ),
    )
    .unwrap();
    assert_eq!(&*read_human().unwrap(), payload.as_bytes());
    fs::write(
        &helper,
        format!("#!/bin/sh\ncase \"$4\" in *.debug) printf '{payload}' ;; *) exit 11 ;; esac\n"),
    )
    .unwrap();
    assert_eq!(read_human(), Err(Error::Denied));
    std::env::remove_var("BUZZ_DEV_RELEASE_KEY");

    fs::write(
        &helper,
        format!("#!/bin/sh\n/bin/sleep 60 &\necho $! > \"$0.child\"\nprintf '{payload}'\n"),
    )
    .unwrap();
    let retained = read_human();
    let pid = fs::read_to_string(helper.with_extension("child")).unwrap();
    assert!(Command::new("/bin/kill")
        .args(["-TERM", pid.trim()])
        .status()
        .unwrap()
        .success());
    assert_eq!(retained, Err(Error::Unavailable));

    fs::write(
        &helper,
        "#!/bin/sh\necho $$ > \"$0.pid\"\nexec /bin/sleep 60\n",
    )
    .unwrap();
    assert_eq!(read_human(), Err(Error::Unavailable));
    let pid = fs::read_to_string(helper.with_extension("pid")).unwrap();
    assert!(!Command::new("/bin/kill")
        .args(["-0", pid.trim()])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success());

    let agent = |operation, value: &[u8]| {
        dev_item(
            operation,
            "xyz.block.buzz.desktop.agents",
            "agent-bundle-v1",
            value,
        )
        .unwrap()
        .map(|value| value.to_vec())
    };
    for (body, expected) in [
        ("printf '{}'", Ok(b"{}".to_vec())),
        ("exit 10", Err(Error::Absent)),
        ("exit 11", Err(Error::Denied)),
        ("exit 12", Err(Error::Corrupt)),
        ("exit 13", Err(Error::Occupied)),
        ("exit 1", Err(Error::Unavailable)),
    ] {
        fs::write(&helper, format!("#!/bin/sh\n{body}\n")).unwrap();
        assert_eq!(agent("read", &[]), expected);
        if expected.is_err() {
            assert_eq!(agent("replace", &vec![b'x'; 2 * 1024 * 1024]), expected);
        }
    }
    fs::write(&helper, "#!/bin/sh\n/bin/cat <&1 > /dev/null\n").unwrap();
    assert_eq!(agent("replace", &vec![b'x'; 2 * 1024 * 1024]), Ok(vec![]));
    assert_eq!(
        agent("replace", &vec![b'x'; 2 * 1024 * 1024 + 1]),
        Err(Error::Unavailable)
    );
    fs::write(&helper, "#!/bin/sh\nprintf unexpected\n").unwrap();
    assert_eq!(agent("delete", &[]), Err(Error::Corrupt));
    fs::write(&helper, "#!/bin/sh\n/usr/bin/head -c 2097153 /dev/zero\n").unwrap();
    assert_eq!(agent("read", &[]), Err(Error::Corrupt));

    let service = "xyz.block.buzz.desktop.federated-session.debug";
    let account = "1".repeat(64);
    for (body, expected) in [
        ("exit 10", Error::Absent),
        ("exit 11", Error::Denied),
        ("exit 12", Error::Corrupt),
        ("exit 1", Error::Unavailable),
    ] {
        fs::write(&helper, format!("#!/bin/sh\n{body}\n")).unwrap();
        assert_eq!(read_session(service, &account), Err(expected));
        assert_eq!(
            compare_session(service, &account, None, Some(b"new")),
            Err(expected)
        );
        assert_eq!(delete_session(service, &account), Err(expected));
    }
    fs::write(
        &helper,
        format!(
            r##"#!/bin/sh
[ "$#" = 4 ] && [ "$1" = --item ] && [ "$3" = '{service}' ] && [ "$4" = '{account}' ] || exit 12
case "$2" in
  read) [ -f "$0.record" ] || exit 10; /bin/cat "$0.record" ;;
  replace) /bin/cat <&1 > "$0.record" ;;
  delete) /bin/rm -f "$0.record" ;;
  *) exit 12 ;;
esac
"##
        ),
    )
    .unwrap();
    assert_eq!(read_session(service, &account), Err(Error::Absent));
    compare_session(service, &account, None, Some(b"saved")).unwrap();
    assert_eq!(&*read_session(service, &account).unwrap(), b"saved");
    assert_eq!(
        compare_session(service, &account, None, Some(b"wrong")),
        Err(Error::Changed)
    );
    assert_eq!(&*read_session(service, &account).unwrap(), b"saved");
    compare_session(service, &account, Some(b"saved"), Some(b"updated")).unwrap();
    assert_eq!(&*read_session(service, &account).unwrap(), b"updated");
    compare_session(service, &account, Some(b"updated"), None).unwrap();
    assert_eq!(read_session(service, &account), Err(Error::Absent));
    compare_session(service, &account, None, None).unwrap();
    compare_session(service, &account, None, Some(b"saved")).unwrap();
    delete_session(service, &account).unwrap();
    assert_eq!(read_session(service, &account), Err(Error::Absent));

    fs::write(
        &helper,
        r##"#!/bin/sh
[ "$#" = 4 ] && [ "$1" = --item ] || exit 12
case "$2" in
  read) [ -f "$0.record" ] || exit 10; /bin/cat "$0.record" ;;
  replace) /bin/cat <&1 > "$0.record"; exit 1 ;;
  delete) /bin/rm -f "$0.record"; exit 1 ;;
esac
"##,
    )
    .unwrap();
    compare_session(service, &account, None, Some(b"committed")).unwrap();
    assert_eq!(&*read_session(service, &account).unwrap(), b"committed");
    compare_session(service, &account, Some(b"committed"), None).unwrap();
    assert_eq!(read_session(service, &account), Err(Error::Absent));

    fs::write(&helper, "#!/bin/sh\nprintf unexpected\n").unwrap();
    assert_eq!(delete_session(service, &account), Err(Error::Corrupt));
    fs::write(&helper, "#!/bin/sh\n/usr/bin/head -c 2097153 /dev/zero\n").unwrap();
    assert_eq!(read_session(service, &account), Err(Error::Corrupt));
    fs::write(&helper, "#!/bin/sh\n/bin/cat <&1 > /dev/null\n").unwrap();
    assert_eq!(
        compare_session(
            service,
            &account,
            Some(b""),
            Some(&vec![b'x'; 2 * 1024 * 1024 + 1])
        ),
        Err(Error::Unavailable)
    );
    // Plain item writes reach the helper as their own operations, with the value.
    fs::write(
        &helper,
        r##"#!/bin/sh
[ "$#" = 4 ] && [ "$1" = --item ] && [ "$3" = xyz.block.buzz.desktop.claude-api-key.debug ] && [ "$4" = anthropic ] || exit 12
case "$2" in
  add) [ -f "$0.item" ] && exit 13; /bin/cat <&1 > "$0.item" ;;
  replace) /bin/cat <&1 > "$0.item" ;;
  read) [ -f "$0.item" ] || exit 10; /bin/cat "$0.item" ;;
  delete) [ -f "$0.item" ] || exit 10; /bin/rm "$0.item" ;;
  *) exit 12 ;;
esac
"##,
    )
    .unwrap();
    let (claude, key) = ("xyz.block.buzz.desktop.claude-api-key.debug", "anthropic");
    add(claude, key, b"first").unwrap();
    assert_eq!(add(claude, key, b"second"), Err(Error::Occupied));
    assert_eq!(
        &*buzz_credential_store::read(claude, key).unwrap(),
        b"first"
    );
    replace(claude, key, b"second").unwrap();
    assert_eq!(
        &*buzz_credential_store::read(claude, key).unwrap(),
        b"second"
    );
    delete(claude, key).unwrap();
    assert_eq!(buzz_credential_store::read(claude, key), Err(Error::Absent));
    assert_eq!(delete(claude, key), Err(Error::Absent));

    std::env::set_var("BUZZ_DEV_CREDENTIAL_HELPER", "helper");
    assert_eq!(read_human(), Err(Error::Unavailable));
    std::env::set_var("BUZZ_DEV_CREDENTIAL_HELPER", "");
    assert_eq!(read_human(), Err(Error::Unavailable));
    std::env::remove_var("BUZZ_DEV_CREDENTIAL_HELPER");
}
