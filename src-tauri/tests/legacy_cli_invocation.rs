//! Exercise the real executable: these commands must exit before any GUI or
//! single-instance initialization, even with no configured desktop identity.
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn invoke(args: &[&str]) -> Output {
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_Buzz"))
        .args(args)
        .env("HOME", home.path())
        .env("XDG_CONFIG_HOME", home.path())
        .env("XDG_DATA_HOME", home.path())
        .env("XDG_CACHE_HOME", home.path())
        .env("APPDATA", home.path())
        .env("LOCALAPPDATA", home.path())
        // Directory overrides do not isolate Keychain. If recognition regresses,
        // this existing refusal stops run() before identity, erase work or IPC.
        .env("BUZZ_NATIVE_MCP_PORT", "invalid")
        .env("BUZZ_DEV_VIEWER", "")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("Legacy CLI invocation started a long-running app instead of exiting");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    child.wait_with_output().unwrap()
}

#[test]
fn legacy_cli_commands_fail_without_echoing_payloads() {
    for args in [
        vec!["--help"],
        vec!["messages", "send", "--content", "private-message-payload"],
        vec!["gifs", "search", "private-gif-query"],
        vec!["auth", "login", "private-auth-payload"],
        vec!["huddles", "join", "private-huddle-payload"],
        vec!["sidebar", "sort", "list", "private-sidebar-payload"],
        vec!["--private-key=private-key-payload", "messages", "list"],
        vec!["--format", "compact", "channels", "list"],
    ] {
        let output = invoke(&args);
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains("Buzz desktop app"));
        assert!(stderr.contains("no CLI command was executed"));
        assert!(stderr.contains("Buzz.app/Contents/Resources/bin/buzz"));
        assert!(!stderr.contains("private-message-payload"));
        assert!(!stderr.contains("private-gif-query"));
        assert!(!stderr.contains("private-auth-payload"));
        assert!(!stderr.contains("private-huddle-payload"));
        assert!(!stderr.contains("private-sidebar-payload"));
        assert!(!stderr.contains("private-key-payload"));
    }
}

#[test]
fn ordinary_launch_arguments_reach_the_pre_identity_startup_refusal() {
    for args in [
        vec![],
        vec!["buzz://message?channel=messages&id=help"],
        vec!["-psn_0_12345"],
        vec!["-NSDocumentRevisionsDebugMode", "messages"],
        vec!["unknown-launch-argument", "messages"],
        vec!["--", "messages", "send"],
    ] {
        let output = invoke(&args);
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.starts_with("Cannot enable native MCP: "), "{stderr}");
        assert!(!stderr.contains("no CLI command was executed"));
    }
}
