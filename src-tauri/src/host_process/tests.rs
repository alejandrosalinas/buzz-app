use super::*;
#[cfg(unix)]
use tauri::ipc::InvokeResponseBody;
#[cfg(unix)]
use tokio::sync::mpsc;

#[cfg(unix)]
fn channel() -> (
    Channel<ProcessEvent>,
    mpsc::UnboundedReceiver<serde_json::Value>,
) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            let _ = sender.send(serde_json::from_str(&json).unwrap());
        }
        Ok(())
    });
    (channel, receiver)
}

#[cfg(unix)]
fn command(program: &str, args: &[&str]) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.as_std_mut().process_group(0);
    command
}

/// Collects output until the exit event, which it returns last.
#[cfg(unix)]
async fn until_exit(
    events: &mut mpsc::UnboundedReceiver<serde_json::Value>,
) -> (String, String, serde_json::Value) {
    let (mut stdout, mut stderr) = (String::new(), String::new());
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("process event")
            .expect("open channel");
        match event["type"].as_str() {
            Some("stdout") => stdout.push_str(event["data"].as_str().unwrap()),
            Some("stderr") => stderr.push_str(event["data"].as_str().unwrap()),
            _ => return (stdout, stderr, event),
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn streams_stdin_to_stdout_until_input_closes() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    let handle = processes
        .start(
            0,
            "a.plugin".into(),
            "cat",
            command("cat", &[]),
            None,
            channel,
        )
        .unwrap();
    processes
        .write("a.plugin", handle, "one\n".into(), false)
        .await
        .unwrap();
    processes
        .write("a.plugin", handle, "two\n".into(), true)
        .await
        .unwrap();
    let (stdout, _, exit) = until_exit(&mut events).await;
    assert_eq!(stdout, "one\ntwo\n");
    assert_eq!(exit, serde_json::json!({"type": "exit", "code": 0}));
    assert!(processes.registry().entries.is_empty());
    assert_eq!(
        processes
            .write("a.plugin", handle, "late".into(), false)
            .await,
        Err("No such process".into())
    );
}

#[cfg(unix)]
#[tokio::test]
async fn its_buzz_credential_is_revoked_once_it_exits() {
    use crate::credential_service::tests::{ask, error, fixture, issued, RELAY};
    use hyper::StatusCode;
    let fixture = fixture();
    let (credential, token) = issued(&fixture).await;
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    let handle = processes
        .start(
            0,
            "p".into(),
            "cat",
            command("cat", &[]),
            Some(credential),
            channel,
        )
        .unwrap();
    let held = processes
        .owned("p", handle, |entry| entry.credential.clone())
        .unwrap()
        .unwrap();
    fixture
        .service
        .bind(&held, "p", None, fixture.agent.pubkey.clone(), RELAY.into())
        .await
        .unwrap();
    drop(held);
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(reply.0, StatusCode::OK);

    processes
        .write("p", handle, String::new(), true)
        .await
        .unwrap();
    until_exit(&mut events).await;
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply), (StatusCode::UNAUTHORIZED, "revoked"));
}

/// A descendant that left the process group keeps the output pipes open, so
/// the entry outlives the process; its token must not.
#[cfg(unix)]
#[tokio::test]
async fn its_buzz_credential_is_revoked_while_a_detached_descendant_holds_its_output() {
    use crate::credential_service::tests::{ask, error, fixture, issued, RELAY};
    use hyper::StatusCode;
    let fixture = fixture();
    let (credential, token) = issued(&fixture).await;
    let processes = HostProcesses::default();
    let (channel, _events) = channel();
    let dir = tempfile::tempdir().unwrap();
    let ready = dir.path().join("detached");
    // Ends the descendant however the test ends, releasing its pipes.
    struct Detached(std::path::PathBuf);
    impl Drop for Detached {
        fn drop(&mut self) {
            if let Ok(pid) = std::fs::read_to_string(&self.0) {
                let _ = std::process::Command::new("kill")
                    .args(["-9", pid.trim()])
                    .status();
            }
        }
    }
    let detached = Detached(ready.clone());
    let handle = processes
        .start(
            0,
            "p".into(),
            "sh",
            command(
                "sh",
                // `sh` waits for the descendant to report it left the group,
                // then for a line; the descendant holds the pipes until killed.
                &[
                    "-c",
                    r#"perl -e 'setpgrp(0, 0); open(F, ">", "$ARGV[0].tmp") or die; print F $$; close F; rename("$ARGV[0].tmp", $ARGV[0]); sleep' "$0" &
                    while [ ! -e "$0" ]; do sleep 0.01; done; read line"#,
                    ready.to_str().unwrap(),
                ],
            ),
            Some(credential),
            channel,
        )
        .unwrap();
    let held = processes
        .owned("p", handle, |entry| entry.credential.clone())
        .unwrap()
        .unwrap();
    fixture
        .service
        .bind(&held, "p", None, fixture.agent.pubkey.clone(), RELAY.into())
        .await
        .unwrap();
    assert_eq!(
        ask(&fixture, &token, "get_public_key", &[]).await.0,
        StatusCode::OK
    );
    processes
        .write("p", handle, "\n".into(), false)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while ask(&fixture, &token, "get_public_key", &[]).await.0 == StatusCode::OK {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the token outlived its process");
    // The output is still held open, so the entry has not gone yet.
    assert!(processes.registry().entries.contains_key(&handle));
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply), (StatusCode::UNAUTHORIZED, "revoked"));
    assert!(fixture
        .service
        .bind(&held, "p", None, fixture.agent.pubkey.clone(), RELAY.into())
        .await
        .is_err());
    // Releasing the pipes lets the entry go.
    drop(detached);
    tokio::time::timeout(Duration::from_secs(5), async {
        while processes.registry().entries.contains_key(&handle) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the entry outlived its output");
}

#[cfg(unix)]
#[tokio::test]
async fn reports_stderr_and_exit_code() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    processes
        .start(
            0,
            "a.plugin".into(),
            "sh",
            command("sh", &["-c", "echo oops >&2; exit 3"]),
            None,
            channel,
        )
        .unwrap();
    let (_, stderr, exit) = until_exit(&mut events).await;
    assert_eq!(stderr, "oops\n");
    assert_eq!(exit["code"], 3);
}

#[cfg(unix)]
#[tokio::test]
async fn only_the_owning_plugin_can_write_or_kill() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    let handle = processes
        .start(
            0,
            "a.plugin".into(),
            "cat",
            command("cat", &[]),
            None,
            channel,
        )
        .unwrap();
    assert!(processes
        .write("b.plugin", handle, "x".into(), false)
        .await
        .is_err());
    assert!(processes.kill("b.plugin", handle).is_err());
    processes.kill("a.plugin", handle).unwrap();
    let (_, _, exit) = until_exit(&mut events).await;
    assert_eq!(exit["type"], "exit");
}

#[cfg(unix)]
#[tokio::test]
async fn kill_ends_the_process_and_its_descendants() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    // The shell ignores the polite signal; its child would outlive it.
    let handle = processes
        .start(
            0,
            "a.plugin".into(),
            "sh",
            command("sh", &["-c", "trap '' TERM; sleep 30 & echo $!; wait"]),
            None,
            channel,
        )
        .unwrap();
    let child: i32 = loop {
        let event = events.recv().await.unwrap();
        if event["type"] == "stdout" {
            break event["data"].as_str().unwrap().trim().parse().unwrap();
        }
    };
    processes.kill("a.plugin", handle).unwrap();
    let (_, _, exit) = until_exit(&mut events).await;
    assert_eq!(exit["code"], serde_json::Value::Null);
    assert_dead(child).await;
}

#[cfg(unix)]
#[tokio::test]
async fn stop_all_ends_every_process() {
    let processes = HostProcesses::default();
    let (first, mut first_events) = channel();
    let (second, mut second_events) = channel();
    processes
        .start(
            0,
            "a.plugin".into(),
            "cat",
            command("cat", &[]),
            None,
            first,
        )
        .unwrap();
    processes
        .start(
            0,
            "b.plugin".into(),
            "cat",
            command("cat", &[]),
            None,
            second,
        )
        .unwrap();
    processes.stop_all();
    // The page that reloaded hears no exit: each channel closes without one.
    for events in [&mut first_events, &mut second_events] {
        while let Some(event) = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("the channel stays open after the process stops")
        {
            assert_ne!(event["type"], "exit");
        }
    }
    assert!(processes.registry().entries.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_page_that_stops_listening_stops_the_process() {
    let processes = HostProcesses::default();
    let channel = Channel::new(|_| Err(tauri::Error::FailedToReceiveMessage));
    let handle = processes
        .start(
            0,
            "a.plugin".into(),
            "sh",
            command("sh", &["-c", "echo hi; sleep 30"]),
            None,
            channel,
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while processes.registry().entries.contains_key(&handle) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("process stopped");
}

#[cfg(unix)]
#[tokio::test]
async fn a_spawn_from_before_a_reload_is_refused() {
    let processes = HostProcesses::default();
    let page = processes.page();
    processes.stop_all();
    let (channel, _events) = channel();
    let refused = processes.start(
        page,
        "a.plugin".into(),
        "cat",
        command("cat", &[]),
        None,
        channel,
    );
    assert_eq!(refused.err().as_deref(), Some("The page reloaded"));
    assert!(processes.registry().entries.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_process_may_close_its_output_and_carry_on() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    processes
        .start(
            0,
            "a.plugin".into(),
            "sh",
            command("sh", &["-c", "exec >&- 2>&-; sleep 1; exit 4"]),
            None,
            channel,
        )
        .unwrap();
    let (_, _, exit) = until_exit(&mut events).await;
    assert_eq!(exit["code"], 4);
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_kills_every_group_without_waiting() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    processes
        .start(
            0,
            "a.plugin".into(),
            "sh",
            command("sh", &["-c", "trap '' TERM; sleep 30 & echo $!; wait"]),
            None,
            channel,
        )
        .unwrap();
    let child: i32 = loop {
        let event = events.recv().await.unwrap();
        if event["type"] == "stdout" {
            break event["data"].as_str().unwrap().trim().parse().unwrap();
        }
    };
    processes.shutdown();
    assert_dead(child).await;
}

#[test]
fn text_waits_for_a_split_character() {
    let mut pending = "héllo".as_bytes()[..2].to_vec();
    assert_eq!(take_text(&mut pending), "h");
    assert_eq!(pending, [0xc3]);
    pending.extend_from_slice(&"héllo".as_bytes()[2..]);
    assert_eq!(take_text(&mut pending), "éllo");
    assert!(pending.is_empty());
    let mut invalid = vec![b'a', 0xff, b'b'];
    assert_eq!(take_text(&mut invalid), "a\u{fffd}b");
}

#[test]
fn directories_are_absolute_or_under_home() {
    let home = home().unwrap();
    assert_eq!(expand_home("~").unwrap(), home);
    assert_eq!(expand_home("~/.buzz").unwrap(), home.join(".buzz"));
    assert!(expand_home("relative/dir").is_err());
    assert!(expand_home("~other/dir").is_err());
}

/// Waits until `pid` has died. A process its new parent has not reaped yet
/// still answers kill(0), as a zombie, so a zombie counts as dead.
#[cfg(unix)]
async fn assert_dead(pid: i32) {
    let dead = || {
        (unsafe { libc::kill(pid, 0) }) != 0
            || std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .is_ok_and(|out| out.stdout.trim_ascii_start().starts_with(b"Z"))
    };
    let until = std::time::Instant::now() + Duration::from_secs(5);
    while !dead() && std::time::Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(dead(), "descendant survived");
}

#[test]
fn a_bundled_program_runs_from_the_app_bin_never_path() {
    // A goose-acp on PATH, which a bundled declaration must not pick.
    let path = tempfile::tempdir().unwrap();
    std::fs::write(path.path().join("goose-acp"), "").unwrap();
    let process = |bundled: bool| -> HostProcess {
        serde_json::from_value(serde_json::json!({
            "id": "goose",
            "program": "goose-acp",
            "bundled": bundled,
        }))
        .unwrap()
    };
    let path = path.path().as_os_str();
    assert_eq!(
        program_path(
            &process(true),
            || Some(PathBuf::from("/app/resources")),
            path
        )
        .unwrap(),
        PathBuf::from("/app/resources/bin/goose-acp")
    );
    assert!(program_path(&process(true), || None, path).is_err());
    // Only a bundled program asks for the resources.
    assert!(program_path(&process(false), || unreachable!(), path).is_ok());
}

#[test]
fn artifacts_may_be_under_home() {
    let process = |path: &str| -> HostProcess {
        serde_json::from_value(serde_json::json!({
            "id": "agent", "program": "agent",
            "artifact": { "path": path, "sha256": "a".repeat(64) }
        }))
        .unwrap()
    };
    let path = |declared: HostProcess| declared.artifact.unwrap().path;
    assert_eq!(
        PathBuf::from(path(at_home(process("~/tools/agent")).unwrap())),
        expand_home("~").unwrap().join("tools/agent")
    );
    assert_eq!(path(at_home(process("/opt/agent")).unwrap()), "/opt/agent");
}

#[cfg(unix)]
#[tokio::test]
async fn the_hook_guard_says_why_it_stopped_a_worker() {
    let processes = HostProcesses::default();
    let (sender, mut events) = channel();
    let script = "echo not-json; exec sleep 30";
    processes
        .start_guarded(
            0,
            "a.plugin".into(),
            "sh",
            command("/bin/sh", &["-c", script]),
            None,
            sender,
            None,
            true,
            None,
        )
        .unwrap();
    let (stdout, stderr, _) = until_exit(&mut events).await;
    assert_eq!(stdout, "");
    assert_eq!(stderr, "Invalid protected Claude frame\n");
}

#[cfg(unix)]
#[tokio::test]
async fn a_guarded_worker_s_last_frame_reaches_the_page_after_it_exits() {
    let dir = tempfile::tempdir().unwrap();
    let gate = dir.path().join("gate");
    assert!(std::process::Command::new("/usr/bin/mkfifo")
        .arg(&gate)
        .status()
        .unwrap()
        .success());
    let path = gate.to_str().unwrap().to_owned();
    // The worker writes its last frame only once the page holds its first,
    // then exits; the page holds the reader until the host has reaped it.
    let script = r#"echo "{\"type\":\"system\",\"pid\":$$}"; read _ < "$1"; echo '{"type":"result"}'; exit 1"#;
    let (sender, mut events) = mpsc::unbounded_channel();
    let held = std::sync::atomic::AtomicBool::new(false);
    let channel = Channel::new(move |body| {
        let InvokeResponseBody::Json(json) = body else {
            return Ok(());
        };
        let event: serde_json::Value = serde_json::from_str(&json).unwrap();
        if event["type"] == "stdout" && !held.swap(true, std::sync::atomic::Ordering::SeqCst) {
            let first: serde_json::Value =
                serde_json::from_str(event["data"].as_str().unwrap().trim()).unwrap();
            let pid = first["pid"].as_i64().unwrap() as i32;
            std::fs::write(&gate, "\n").unwrap();
            // This blocks a Tauri runtime worker; a second one must reap the child.
            let start = std::time::Instant::now();
            while unsafe { libc::kill(pid, 0) } == 0 {
                assert!(start.elapsed() < Duration::from_secs(10), "not reaped");
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        let _ = sender.send(event);
        Ok(())
    });
    let processes = HostProcesses::default();
    processes
        .start_guarded(
            0,
            "a.plugin".into(),
            "sh",
            command("/bin/sh", &["-c", script, "sh", &path]),
            None,
            channel,
            None,
            true,
            None,
        )
        .unwrap();
    let (stdout, stderr, exit) = until_exit(&mut events).await;
    assert!(stdout.ends_with("{\"type\":\"result\"}\n"), "{stdout:?}");
    assert_eq!(stderr, "");
    assert_eq!(exit["code"], 1);
}

#[test]
fn only_the_protected_claude_cli_gets_the_hook_guard() {
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../src/bundled/claude-code/manifest.json"
    ))
    .unwrap();
    let declared = manifest["host"]["processes"].as_array().unwrap();
    let cli = ["claude-protected-arm64", "claude-protected-x64"];
    for process in declared {
        let id = process["id"].as_str().unwrap();
        // The pinned CLI artifacts are the only declared processes that run
        // the CLI under protection; the protected file reader prints raw base64.
        assert_eq!(process["artifact"].is_object(), cli.contains(&id), "{id}");
        assert_eq!(
            runs_protected_claude("buzz.claude-code", id, true),
            cli.contains(&id),
            "{id}"
        );
        assert!(!runs_protected_claude("buzz.claude-code", id, false));
        assert!(!runs_protected_claude("other.plugin", id, true));
    }
}

#[test]
fn protected_launch_refuses_path_programs_and_preserves_bundled_resolution() {
    let store = tempfile::tempdir().unwrap();
    let mut process: HostProcess =
        serde_json::from_value(serde_json::json!({"id":"shell", "program":"bash"})).unwrap();
    assert!(protected_program_path(&process, || unreachable!(), store.path()).is_err());
    process.bundled = true;
    process.program = "buzz-agent-command".into();
    assert_eq!(
        protected_program_path(
            &process,
            || Some(PathBuf::from("/app/resources")),
            store.path()
        )
        .unwrap(),
        PathBuf::from("/app/resources/bin/buzz-agent-command")
    );
}

#[test]
#[cfg(unix)]
fn artifact_program_requires_exact_executable_and_sibling_bytes() {
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let executable = root.join("agent");
    let sibling = root.join("runtime.js");
    std::fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(&sibling, "original").unwrap();
    let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
    let process: HostProcess = serde_json::from_value(serde_json::json!({
        "id": "agent", "program": "agent", "artifact": {
            "path": executable.to_str().unwrap(),
            "sha256": hash(b"#!/bin/sh\nexit 0\n"),
            "siblings": [{"name": "runtime.js", "sha256": hash(b"original")}]
        }
    }))
    .unwrap();
    assert_eq!(
        program_path(&process, || unreachable!(), OsStr::new("")),
        Ok(executable.clone())
    );
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(program_path(&process, || unreachable!(), OsStr::new("")).is_err());
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(&sibling, "changed").unwrap();
    assert!(program_path(&process, || unreachable!(), OsStr::new("")).is_err());
    std::fs::write(&sibling, "original").unwrap();
    std::fs::remove_file(&executable).unwrap();
    let target = root.join("actual");
    std::fs::write(&target, "#!/bin/sh\nexit 0\n").unwrap();
    symlink(&target, &executable).unwrap();
    assert!(program_path(&process, || unreachable!(), OsStr::new("")).is_err());
}

#[test]
fn process_mcp_connection_has_an_explicit_wire_shape() {
    let connection = serde_json::json!({
        "url": "http://127.0.0.1:1234/mcp",
        "headers": [{ "name": "Authorization", "value": "Bearer agent" }]
    });
    let parsed: super::ProcessMcpConnection = serde_json::from_value(connection.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), connection);
    for invalid in [
        serde_json::json!({"url": "http://127.0.0.1:1234/mcp", "headers": [], "extra": true}),
        serde_json::json!({"url": "http://127.0.0.1:1234/mcp", "headers": [{"name": "Authorization", "value": "Bearer agent", "extra": true}]}),
        serde_json::json!({"url": "http://127.0.0.1:1234/mcp"}),
    ] {
        assert!(serde_json::from_value::<super::ProcessMcpConnection>(invalid).is_err());
    }
}

#[tokio::test]
#[cfg(target_os = "macos")]
async fn protected_launches_keep_the_startup_agents_root_when_release_storage_appears() {
    use crate::agent_state::AgentState;
    use crate::sign_out::legacy_identifier::{agents, CURRENT, DEV, LEGACY};
    use sha2::{Digest, Sha256};
    use std::path::Path;

    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    std::fs::create_dir(base.join(LEGACY)).unwrap();
    let app_data = base.join(DEV);
    let startup_root = agents(DEV, &app_data);
    assert_eq!(startup_root, app_data.join("agents"));
    let state = AgentState::new(Ok(startup_root.join("state")));
    state.set("marker", Some("before")).unwrap();
    let identities = startup_root.join("identities.json");
    std::fs::write(&identities, "identities").unwrap();
    let declaration: HostProcess = serde_json::from_value(serde_json::json!({
        "id": "worker", "program": "worker", "artifact": {
            "path": "/usr/bin/true",
            "sha256": format!("{:x}", Sha256::digest(std::fs::read("/usr/bin/true").unwrap()))
        }
    }))
    .unwrap();
    let protection = ProcessProtection {
        read_only_paths: vec![],
        hidden_paths: vec![],
    };
    let first_root = state.agents_root().unwrap().to_path_buf();
    let first_target = protected_program_path(
        &declaration,
        || unreachable!(),
        &first_root.join("artifacts"),
    )
    .unwrap();
    let first_profile = protection.profile(&[first_root]).unwrap();
    let run = |profile: &str, script: &str, path: &Path| {
        let mut command = process_command(
            Path::new("/bin/sh"),
            None,
            Some(profile),
            &[],
            &[
                "-c".into(),
                script.into(),
                "worker".into(),
                path.to_str().unwrap().into(),
            ],
        );
        command.env_clear();
        command
    };
    // A contained worker can create this sibling; it must not redirect later launches.
    let release = base.join(CURRENT);
    let created = run(&first_profile, "/bin/mkdir \"$1\"", &release)
        .output()
        .await
        .unwrap();
    assert!(created.status.success(), "{created:?}");
    assert_eq!(agents(DEV, &app_data), release.join("agents"));

    let second_root = state.agents_root().unwrap().to_path_buf();
    assert_eq!(second_root, startup_root);
    let staged = protected_program_path(
        &declaration,
        || unreachable!(),
        &second_root.join("artifacts"),
    )
    .unwrap();
    assert_eq!(staged, first_target);
    assert!(staged.starts_with(startup_root.join("artifacts")));
    assert!(!release.join("agents").exists());
    let second_profile = protection.profile(&[second_root]).unwrap();
    state.set("marker", Some("after")).unwrap();
    for profile in [&first_profile, &second_profile] {
        for path in [
            identities.clone(),
            startup_root.join("state/marker"),
            startup_root.join("artifacts/untrusted"),
        ] {
            let write = run(profile, "printf breached > \"$1\"", &path)
                .output()
                .await
                .unwrap();
            assert!(!write.status.success(), "write allowed: {path:?}");
        }
        // The owner can chmod its staged file; the worker's profile must forbid it.
        let chmod = run(profile, "/bin/chmod u+w \"$1\"", &staged)
            .output()
            .await
            .unwrap();
        assert!(!chmod.status.success(), "staged artifact was writable");
    }
    assert_eq!(std::fs::read_to_string(identities).unwrap(), "identities");
    assert_eq!(state.load().unwrap()["marker"], "after");
}

#[test]
#[cfg(target_os = "macos")]
fn snapshot_mcp_and_containment_keep_the_verified_target_and_argument_order() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let source = root.join("agent");
    let bytes = std::fs::read("/usr/bin/true").unwrap();
    std::fs::write(&source, &bytes).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o755)).unwrap();
    use sha2::{Digest, Sha256};
    let artifact = buzzodz_plugins::ProcessArtifact {
        path: source.to_str().unwrap().into(),
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        siblings: vec![],
    };
    let store = root.join("artifacts");
    let target = artifact::snapshot(&artifact, &store).unwrap();
    std::fs::write(source, b"replaced original").unwrap();
    let profile = ProcessProtection {
        read_only_paths: vec![],
        hidden_paths: vec![],
    }
    .profile(&[root])
    .unwrap();
    let helper = std::path::Path::new("/app/resources/bin/buzz-agent-command");
    let command = process_command(
        &target,
        Some(helper),
        Some(&profile),
        &["--stdio".into()],
        &["--session".into()],
    );
    assert_eq!(command.as_std().get_program(), "/usr/bin/sandbox-exec");
    assert_eq!(
        command.as_std().get_args().collect::<Vec<_>>(),
        [
            OsStr::new("-p"),
            OsStr::new(&profile),
            helper.as_os_str(),
            OsStr::new("--launch"),
            target.as_os_str(),
            OsStr::new("--stdio"),
            OsStr::new("--session")
        ]
    );
    assert!(std::process::Command::new("/usr/bin/sandbox-exec")
        .args(["-p", &profile])
        .arg(&target)
        .status()
        .unwrap()
        .success());
}

/// A shared host never carries a token; each agent's tools get their own,
/// the same each time, which dies with the host.
#[cfg(unix)]
#[tokio::test]
async fn a_shared_hosts_tool_credential_is_its_agents_and_ends_with_it() {
    use crate::credential_service::tests::{ask, fixture, RELAY};
    use hyper::StatusCode;
    let fixture = fixture();
    let processes = HostProcesses::default();
    let (channel, _events) = channel();
    let handle = processes
        .start(
            0,
            "p".into(),
            "sh",
            command("sh", &["-c", "read line"]),
            None,
            channel,
        )
        .unwrap();
    let pubkey = fixture.agent.pubkey.clone();
    let env = processes
        .tool_credential(&fixture.service, "p", handle, pubkey.clone(), RELAY.into())
        .await
        .unwrap()
        .unwrap();
    let again = processes
        .tool_credential(&fixture.service, "p", handle, pubkey.clone(), RELAY.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(env, again);
    let token: serde_json::Value = serde_json::from_str(&env).unwrap();
    let token = token["token"].as_str().unwrap();
    let reply = ask(&fixture, token, "get_public_key", &[]).await;
    assert_eq!(reply.0, StatusCode::OK);
    assert_eq!(reply.1["result"], pubkey.as_str());
    // Only the plugin's own agents.
    assert!(processes
        .tool_credential(
            &fixture.service,
            "other",
            handle,
            pubkey.clone(),
            RELAY.into()
        )
        .await
        .is_err());
    processes
        .write("p", handle, "\n".into(), false)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while ask(&fixture, token, "get_public_key", &[]).await.0 == StatusCode::OK {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the token outlived its host");
}

/// A shared host serving `fixture`'s agent and a second one that keeps it
/// alive, with the second agent's token issued first.
#[cfg(unix)]
async fn shared_host(
    fixture: &crate::credential_service::tests::Fixture,
) -> (HostProcesses, u64, String) {
    use crate::credential_service::tests::RELAY;
    let second = buzz_agent_controller::Secret::generate().unwrap();
    let mut other = fixture.agent.clone();
    other.pubkey = second.pubkey().into();
    fixture.host.also_holding_for_test(
        fixture._dir.path().join("identities.json"),
        &[&fixture.agent, &other],
        second,
    );
    let processes = HostProcesses::default();
    let (channel, _events) = channel();
    let handle = processes
        .start(
            0,
            "p".into(),
            "sh",
            command("sh", &["-c", "read line"]),
            None,
            channel,
        )
        .unwrap();
    processes
        .tool_credential(
            &fixture.service,
            "p",
            handle,
            other.pubkey.clone(),
            RELAY.into(),
        )
        .await
        .unwrap()
        .unwrap();
    (processes, handle, other.pubkey)
}

#[cfg(unix)]
fn env_token(env: &str) -> String {
    serde_json::from_str::<serde_json::Value>(env).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// A token outlived by its agent's removal and re-adding, or by a sign-out,
/// is replaced while the host lives on; the old one stays revoked.
#[cfg(unix)]
#[tokio::test]
async fn a_shared_host_replaces_a_token_its_agent_outlived() {
    use crate::credential_service::tests::{ask, fixture, RELAY};
    use hyper::StatusCode;
    for sign_out in [false, true] {
        let fixture = fixture();
        let (processes, handle, other) = shared_host(&fixture).await;
        let pubkey = fixture.agent.pubkey.clone();
        let credential = || {
            processes.tool_credential(&fixture.service, "p", handle, pubkey.clone(), RELAY.into())
        };
        let old = env_token(&credential().await.unwrap().unwrap());
        let other_env = processes
            .tool_credential(&fixture.service, "p", handle, other.clone(), RELAY.into())
            .await
            .unwrap()
            .unwrap();
        if sign_out {
            fixture.identity.sign_out(None).await;
        } else {
            fixture.host.forget_row_for_test(&pubkey, RELAY);
            fixture.host.reopen_row_for_test(&pubkey, RELAY);
        }
        let fresh = env_token(&credential().await.unwrap().unwrap());
        assert_ne!(fresh, old, "sign_out={sign_out}");
        let reply = ask(&fixture, &fresh, "get_public_key", &[]).await;
        assert_eq!(reply.0, StatusCode::OK, "sign_out={sign_out}");
        assert_eq!(reply.1["result"], pubkey.as_str());
        assert_eq!(env_token(&credential().await.unwrap().unwrap()), fresh);
        let reply = ask(&fixture, &old, "get_public_key", &[]).await;
        assert_eq!(reply.0, StatusCode::UNAUTHORIZED, "sign_out={sign_out}");
        // The other agent's token is untouched by a removal, and replaced
        // after a sign-out like every other.
        let other_again = processes
            .tool_credential(&fixture.service, "p", handle, other.clone(), RELAY.into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(other_again == other_env, !sign_out, "sign_out={sign_out}");
    }
}

/// Two calls replacing the same stale token at once, both held past their
/// cache miss so each issues a replacement, settle on one fresh one.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn concurrent_replacements_of_a_stale_token_keep_one() {
    use crate::credential_service::tests::{ask, fixture, RELAY};
    use hyper::StatusCode;
    let fixture = fixture();
    let (processes, handle, _other) = shared_host(&fixture).await;
    let pubkey = fixture.agent.pubkey.clone();
    let old = env_token(
        &processes
            .tool_credential(&fixture.service, "p", handle, pubkey.clone(), RELAY.into())
            .await
            .unwrap()
            .unwrap(),
    );
    fixture.host.forget_row_for_test(&pubkey, RELAY);
    fixture.host.reopen_row_for_test(&pubkey, RELAY);
    let missed = tokio::sync::Barrier::new(2);
    let replace = || {
        processes.tool_credential_after_miss(
            &fixture.service,
            "p",
            handle,
            pubkey.clone(),
            RELAY.into(),
            async {
                missed.wait().await;
            },
        )
    };
    let (first, second) = tokio::join!(replace(), replace());
    let (first, second) = (
        env_token(&first.unwrap().unwrap()),
        env_token(&second.unwrap().unwrap()),
    );
    assert_eq!(first, second);
    assert_ne!(first, old);
    assert_eq!(
        ask(&fixture, &first, "get_public_key", &[]).await.0,
        StatusCode::OK
    );
    // The losing replacement was revoked, so only one token for this agent is held.
    assert_eq!(
        env_token(
            &processes
                .tool_credential(&fixture.service, "p", handle, pubkey.clone(), RELAY.into())
                .await
                .unwrap()
                .unwrap()
        ),
        first
    );
}

/// A protected Codex host's tool credential: only for the agent its
/// protection provider launched it for, and only to that provider.
#[cfg(unix)]
#[tokio::test]
async fn a_protected_hosts_tool_credential_is_only_its_launched_agents() {
    use crate::credential_service::tests::{ask, protected_fixture, second_agent, GUARD, RELAY};
    let fixture = protected_fixture();
    let pubkey = fixture.agent.pubkey.clone();
    let other = second_agent(&fixture);
    let launch = fixture
        .service
        .protected_launch(GUARD, pubkey.clone(), RELAY.into())
        .await
        .unwrap();
    let processes = HostProcesses::default();
    let start = |launch| {
        let (channel, _events) = channel();
        processes
            .start_guarded(
                0,
                GUARD.into(),
                "sh",
                command("sh", &["-c", "read line"]),
                None,
                channel,
                None,
                false,
                launch,
            )
            .unwrap()
    };
    let launched = start(Some(launch));
    let unlaunched = start(None);
    let env = processes
        .tool_credential(
            &fixture.service,
            GUARD,
            launched,
            pubkey.clone(),
            RELAY.into(),
        )
        .await
        .unwrap()
        .unwrap();
    let token: serde_json::Value = serde_json::from_str(&env).unwrap();
    let reply = ask(
        &fixture,
        token["token"].as_str().unwrap(),
        "get_public_key",
        &[],
    )
    .await;
    assert_eq!(reply.1["result"], pubkey.as_str());
    for (handle, agent) in [(launched, &other.pubkey), (unlaunched, &pubkey)] {
        assert!(processes
            .tool_credential(&fixture.service, GUARD, handle, agent.clone(), RELAY.into())
            .await
            .is_err());
    }
    // A protection change, or a switch of provider, revokes its token.
    crate::credential_service::tests::reprotect(&fixture, "other");
    let token = token["token"].as_str().unwrap();
    assert_eq!(
        ask(&fixture, token, "get_public_key", &[]).await.0,
        hyper::StatusCode::UNAUTHORIZED
    );
    assert!(processes
        .tool_credential(
            &fixture.service,
            GUARD,
            launched,
            pubkey.clone(),
            RELAY.into()
        )
        .await
        .is_err());
}

/// The same for a change of policy under the same provider.
#[cfg(unix)]
#[tokio::test]
async fn a_protection_change_revokes_a_protected_hosts_tool_credential() {
    use crate::credential_service::tests::{ask, protected_fixture, reprotect, GUARD, RELAY};
    let fixture = protected_fixture();
    let pubkey = fixture.agent.pubkey.clone();
    let launch = fixture
        .service
        .protected_launch(GUARD, pubkey.clone(), RELAY.into())
        .await
        .unwrap();
    let processes = HostProcesses::default();
    let (channel, _events) = channel();
    let handle = processes
        .start_guarded(
            0,
            GUARD.into(),
            "sh",
            command("sh", &["-c", "read line"]),
            None,
            channel,
            None,
            false,
            Some(launch),
        )
        .unwrap();
    let credential = || {
        processes.tool_credential(
            &fixture.service,
            GUARD,
            handle,
            pubkey.clone(),
            RELAY.into(),
        )
    };
    let env = credential().await.unwrap().unwrap();
    let token = env_token(&env);
    reprotect(&fixture, GUARD);
    assert!(credential().await.is_err());
    assert_eq!(
        ask(&fixture, &token, "get_public_key", &[]).await.0,
        hyper::StatusCode::UNAUTHORIZED
    );
}

#[test]
fn every_process_is_told_the_buzz_version_a_plugin_cannot_change() {
    let get = |command: &Command, name: &str| {
        command
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == name)
            .and_then(|(_, value)| value.map(|value| value.to_string_lossy().into_owned()))
    };
    for plugin_value in [Some("spoofed".to_string()), None] {
        let mut command = Command::new("/usr/bin/true");
        let environment = HashMap::from([
            ("BUZZ_VERSION".to_string(), plugin_value),
            ("PLUGIN_SETTING".to_string(), Some("kept".to_string())),
        ]);
        set_environment(&mut command, OsStr::new("/bin"), &environment, "0.7.12").unwrap();
        assert_eq!(get(&command, "BUZZ_VERSION").as_deref(), Some("0.7.12"));
        assert_eq!(get(&command, "PLUGIN_SETTING").as_deref(), Some("kept"));
        assert_eq!(get(&command, "PATH").as_deref(), Some("/bin"));
    }
}
