#![cfg(all(target_os = "macos", debug_assertions))]

use buzz_credential_store::{
    compare_session, delete_session, dev_agent_store, read_human, read_session, Error,
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
        ("exit 10".into(), Err(Error::Absent)),
        ("exit 11".into(), Err(Error::Denied)),
        ("exit 12".into(), Err(Error::Corrupt)),
        ("exit 1".into(), Err(Error::Unavailable)),
        ("kill -TERM $$".into(), Err(Error::Unavailable)),
        ("exit 0".into(), Err(Error::Corrupt)),
        ("printf short".into(), Err(Error::Corrupt)),
        (format!("printf '{payload}x'"), Err(Error::Corrupt)),
        (
            format!("printf '{}'", "x".repeat(4096)),
            Err(Error::Corrupt),
        ),
        (format!("printf '{payload}'; exit 11"), Err(Error::Denied)),
    ] {
        fs::write(&helper, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(read_human().map(|value| value.to_vec()), expected);
    }

    fs::write(
        &helper,
        format!("#!/bin/sh\n[ $# = 0 ] || exit 11\nprintf '{payload}'\n"),
    )
    .unwrap();
    assert!(read_human().is_ok());
    std::env::set_var("BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE", "0");
    assert!(read_human().is_ok());
    std::env::set_var("BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE", "1");
    fs::write(
        &helper,
        format!("#!/bin/sh\n[ \"$1\" = --authorize ] || exit 11\nprintf '{payload}'\n"),
    )
    .unwrap();
    assert!(read_human().is_ok());
    std::env::remove_var("BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE");

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
        dev_agent_store(
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
    fs::write(&helper, format!(r##"#!/bin/sh
[ "$#" = 4 ] && [ "$1" = --session-store ] && [ "$3" = '{service}' ] && [ "$4" = '{account}' ] || exit 12
case "$2" in
  read) [ -f "$0.record" ] || exit 10; /bin/cat "$0.record" ;;
  replace) /bin/cat <&1 > "$0.record" ;;
  delete) /bin/rm -f "$0.record" ;;
  *) exit 12 ;;
esac
"##)).unwrap();
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
[ "$#" = 4 ] && [ "$1" = --session-store ] || exit 12
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
    fs::write(&helper, "#!/bin/sh\n/usr/bin/head -c 1048577 /dev/zero\n").unwrap();
    assert_eq!(read_session(service, &account), Err(Error::Corrupt));
    fs::write(&helper, "#!/bin/sh\n/bin/cat <&1 > /dev/null\n").unwrap();
    assert_eq!(
        compare_session(
            service,
            &account,
            Some(b""),
            Some(&vec![b'x'; 1024 * 1024 + 1])
        ),
        Err(Error::Unavailable)
    );
    for (bad_service, bad_account) in [
        ("xyz.block.buzz.desktop.federated-session", account.as_str()),
        (
            "xyz.block.buzz.desktop.federated-session.debug.other",
            account.as_str(),
        ),
        (service, "human"),
        (service, ""),
        (service, "1111"),
        (
            service,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ),
    ] {
        assert_eq!(
            read_session(bad_service, bad_account),
            Err(Error::Unavailable)
        );
    }

    std::env::set_var("BUZZ_DEV_CREDENTIAL_HELPER", "helper");
    assert_eq!(read_human(), Err(Error::Unavailable));
    std::env::set_var("BUZZ_DEV_CREDENTIAL_HELPER", "");
    assert_eq!(read_human(), Err(Error::Unavailable));
    std::env::remove_var("BUZZ_DEV_CREDENTIAL_HELPER");
}
