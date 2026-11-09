use super::*;
use std::cell::Cell;
use std::future::Future;

fn paths_for(root: &Path, service: &str) -> Paths {
    Paths {
        marker: root.join(marker_name("app", service)),
        finished: root.join(finished_name(service)),
        lock: root.join(LOCK),
        key_lock: root.join(key_lock_name(service)),
        ownership: root.join(AGENT_OWNERSHIP),
        app_data: root.join("app"),
        backups: root.join("nsec-backups").join(service),
        others: vec![root.join("webkit")],
        moves: Vec::new(),
        seeds: Vec::new(),
    }
}
fn fixture() -> (tempfile::TempDir, Paths) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let paths = paths_for(root, "identity");
    fs::create_dir_all(paths.app_data.join(OLD_AGENTS)).unwrap();
    fs::write(
        paths.app_data.join(OLD_AGENTS).join("agents.json"),
        "agents",
    )
    .unwrap();
    fs::create_dir_all(paths.app_data.join(AGENTS)).unwrap();
    fs::write(
        paths.app_data.join(AGENTS).join("identities.json"),
        "identities",
    )
    .unwrap();
    fs::write(paths.app_data.join("archive.sqlite3"), "archive").unwrap();
    fs::create_dir_all(&paths.others[0]).unwrap();
    fs::write(paths.others[0].join("localstorage"), "prefs").unwrap();
    (dir, paths)
}
/// What a launch runs once it owns the locks: the pending sign-out, if any.
fn finish_pending(
    paths: &Paths,
    remove_agent_keys: impl FnOnce(&Path) -> Result<(), String>,
    remove_key: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let Some(choices) = pending(&paths.marker)? else {
        return Ok(());
    };
    finish(paths, choices, remove_agent_keys, remove_key).map_err(|error| {
        eprintln!("buzz: sign out did not finish: {error}");
        FAILED.to_owned()
    })
}
fn no_agents(_: &Path) -> Result<(), String> {
    panic!("agent keys must not be touched")
}
fn mark(paths: &Paths, wipe: bool, remove_agents: bool) {
    write_marker(
        &paths.marker,
        Choices {
            wipe,
            remove_agents,
        },
    )
    .unwrap();
}
/// Listing without the instance lock file, which boot creates.
fn data(root: &Path) -> Vec<String> {
    listing(root)
        .into_iter()
        .filter(|path| !path.ends_with("instance.lock"))
        .collect()
}
/// Everything under `root` but the finished record, which is never removed.
fn listing(root: &Path) -> Vec<String> {
    let mut found: Vec<String> = walk(root, root);
    found.retain(|path| !path.ends_with("sign-outs-finished"));
    found.sort();
    found
}
fn walk(root: &Path, dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .flat_map(|entry| {
            let path = entry.unwrap().path();
            // Joined with `/` so the expected listings hold on Windows too,
            // where `display()` would use `\`.
            let name = path
                .strip_prefix(root)
                .unwrap()
                .components()
                .map(|part| part.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            if path.is_dir() {
                let mut nested = walk(root, &path);
                nested.push(format!("{name}/"));
                nested
            } else {
                vec![name]
            }
        })
        .collect()
}

#[test]
fn no_marker_leaves_everything_alone() {
    let (dir, paths) = fixture();
    let before = listing(dir.path());
    assert_eq!(
        finish_pending(&paths, |_| Ok(()), || panic!("key must not be touched")),
        Ok(())
    );
    assert_eq!(listing(dir.path()), before);
}

#[test]
fn sign_out_without_wipe_removes_only_the_key_and_marker() {
    let (dir, paths) = fixture();
    let before = listing(dir.path());
    mark(&paths, false, false);
    let removed = Cell::new(false);
    assert_eq!(
        finish_pending(
            &paths,
            |_| Ok(()),
            || {
                removed.set(true);
                Ok(())
            }
        ),
        Ok(())
    );
    assert!(removed.get());
    assert_eq!(listing(dir.path()), before);
}

#[test]
fn backup_choice_is_kept_on_plain_signout_and_erased_only_in_its_key_store_scope() {
    for wipe in [false, true] {
        let (dir, paths) = fixture();
        let other = dir.path().join("nsec-backups/identity.debug");
        for root in [&paths.backups, &other] {
            fs::create_dir_all(root).unwrap();
            for name in ["choice.json", "pending.json", "complete.json"] {
                fs::write(root.join(name), b"synthetic backup metadata").unwrap();
            }
        }
        mark(&paths, wipe, false);
        assert!(boot(&paths, no_agents, || Ok(())).is_ok());
        assert!(!paths.marker.exists());
        for name in ["choice.json", "pending.json", "complete.json"] {
            assert_eq!(paths.backups.join(name).exists(), !wipe);
            assert!(other.join(name).exists());
        }
    }
}

#[test]
fn backup_erase_finishes_before_marker_removal_and_a_failure_remains_retryable() {
    let (_dir, paths) = fixture();
    fs::create_dir_all(&paths.backups).unwrap();
    fs::write(paths.backups.join("pending.json"), b"synthetic ciphertext").unwrap();
    fs::create_dir(&paths.finished).unwrap();
    mark(&paths, true, false);
    assert!(boot(&paths, no_agents, || Ok(())).is_err());
    assert!(paths.marker.exists());
    assert!(!paths.backups.exists());
    fs::remove_dir(&paths.finished).unwrap();
    assert!(boot(&paths, no_agents, || Ok(())).is_ok());
    assert!(!paths.marker.exists());
}

#[cfg(unix)]
#[test]
fn backup_choice_erase_refuses_a_linked_parent_without_touching_its_destination() {
    let (dir, paths) = fixture();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(outside.path().join("identity")).unwrap();
    let retained = outside.path().join("identity/choice.json");
    let pending_backup = outside.path().join("identity/pending.json");
    fs::write(&retained, b"synthetic public consent").unwrap();
    fs::write(&pending_backup, b"synthetic ciphertext").unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("nsec-backups")).unwrap();
    mark(&paths, true, false);
    assert!(boot(&paths, no_agents, || panic!("key must not be touched")).is_err());
    assert!(paths.marker.exists());
    assert_eq!(fs::read(retained).unwrap(), b"synthetic public consent");
    assert_eq!(fs::read(pending_backup).unwrap(), b"synthetic ciphertext");
}

#[test]
fn wipe_with_kept_agents_preserves_protection_defaults_and_revision() {
    for remove_agents in [false, true] {
        let (_dir, paths) = fixture();
        let identities = paths.app_data.join(AGENTS).join("identities.json");
        fs::write(&identities, "[]").unwrap();
        let agents = buzz_agent_controller::AppAgents::open(identities.clone());
        let owner = "a".repeat(64);
        agents.upgrade_protection_storage().unwrap();
        agents
            .set_protection_defaults(
                &owner,
                0,
                "security.test",
                Some(serde_json::json!({"injection":true})),
            )
            .unwrap();
        let saved = agents.protection_defaults(&owner).unwrap();
        mark(&paths, true, remove_agents);
        finish_pending(&paths, |_| Ok(()), || Ok(())).unwrap();
        if remove_agents {
            assert!(!identities.with_file_name("protection.json").exists());
        } else {
            let retained = buzz_agent_controller::AppAgents::open(identities);
            assert_eq!(retained.protection_defaults(&owner).unwrap(), saved);
        }
    }
}

#[test]
fn wipe_keeps_agents_unless_they_are_removed_too() {
    for remove_agents in [false, true] {
        let (dir, paths) = fixture();
        mark(&paths, true, remove_agents);
        assert_eq!(finish_pending(&paths, |_| Ok(()), || Ok(())), Ok(()));
        let expected: &[&str] = if remove_agents {
            &[]
        } else {
            &[
                "app/",
                "app/agent-controller/",
                "app/agent-controller/agents.json",
                "app/agents/",
                "app/agents/identities.json",
            ]
        };
        assert_eq!(listing(dir.path()), expected);
    }
}

#[test]
fn key_removal_failure_restores_data_keeps_marker_and_the_retry_succeeds() {
    for remove_agents in [false, true] {
        let (dir, paths) = fixture();
        mark(&paths, true, remove_agents);
        let mut before = listing(dir.path());
        assert_eq!(
            finish_pending(&paths, |_| Ok(()), || Err("keychain denied".into())),
            Err(FAILED.into())
        );
        // Everything, including the marker, is exactly where it was.
        assert_eq!(listing(dir.path()), before);
        assert!(paths.marker.exists());

        assert_eq!(finish_pending(&paths, |_| Ok(()), || Ok(())), Ok(()));
        before = listing(dir.path());
        assert!(!before.iter().any(|path| path.contains("archive")));
        assert!(!paths.marker.exists());
    }
}

#[test]
fn a_wipe_interrupted_part_way_resumes_on_the_next_launch() {
    let (dir, paths) = fixture();
    mark(&paths, true, false);
    // Crash after moving app data aside, before returning the agent registry.
    fs::rename(&paths.app_data, trash(&paths.app_data)).unwrap();
    assert_eq!(finish_pending(&paths, |_| Ok(()), || Ok(())), Ok(()));
    assert_eq!(
        listing(dir.path()),
        [
            "app/",
            "app/agent-controller/",
            "app/agent-controller/agents.json",
            "app/agents/",
            "app/agents/identities.json"
        ]
    );
}

#[test]
fn an_interrupted_wipe_rolls_back_fully_when_the_key_cannot_be_removed() {
    let (dir, paths) = fixture();
    mark(&paths, true, false);
    let before = listing(dir.path());
    fs::rename(&paths.app_data, trash(&paths.app_data)).unwrap();
    assert!(finish_pending(&paths, |_| Ok(()), || Err("locked".into())).is_err());
    assert_eq!(listing(dir.path()), before);
}

#[test]
fn an_unreadable_marker_blocks_without_touching_the_key_or_data() {
    let (dir, paths) = fixture();
    fs::write(&paths.marker, "{\"wipe\":true}").unwrap();
    let before = listing(dir.path());
    assert!(finish_pending(&paths, |_| Ok(()), || panic!("key must not be touched")).is_err());
    assert_eq!(listing(dir.path()), before);
}

#[test]
fn a_debug_sign_out_never_touches_the_release_key_or_data() {
    let (dir, debug) = fixture();
    let debug = Paths {
        marker: dir.path().join(marker_name("app", "identity.debug")),
        ..debug
    };
    let release = paths_for(dir.path(), "identity");
    assert_ne!(debug.marker, release.marker);
    mark(&debug, true, true);
    let before = data(dir.path());
    // The release build launches first: its key and the shared folders stay put.
    assert!(boot(&release, no_agents, || panic!(
        "release key must not be touched"
    ))
    .is_ok());
    assert_eq!(data(dir.path()), before);
    assert!(debug.marker.exists());
}

#[test]
fn a_retry_clears_storage_recreated_after_the_key_was_removed() {
    let (dir, paths) = fixture();
    mark(&paths, true, false);
    // Trash cleanup fails once (a file where its folder should be).
    fs::write(trash(&paths.others[0]), "stuck").unwrap();
    assert!(finish_pending(&paths, |_| Ok(()), || Ok(())).is_err());
    assert!(paths.marker.exists());
    // Something recreates storage before the next launch.
    fs::create_dir_all(&paths.others[0]).unwrap();
    fs::write(paths.others[0].join("recreated"), "new").unwrap();
    fs::write(paths.app_data.join("recreated.sqlite3"), "new").unwrap();
    fs::remove_file(trash(&paths.others[0])).unwrap();
    // The key is already gone; the retry must still succeed and leave nothing.
    assert_eq!(finish_pending(&paths, |_| Ok(()), || Ok(())), Ok(()));
    assert_eq!(
        listing(dir.path()),
        [
            "app/",
            "app/agent-controller/",
            "app/agent-controller/agents.json",
            "app/agents/",
            "app/agents/identities.json"
        ]
    );
}

/// A child process another test is spawning holds inherited lock handles until
/// it execs, so a dropped instance's lock can take a moment to free.
fn admitted_once_free(instance: &Instance, choices: Choices) -> bool {
    wait_for(|| instance.begin(choices))
}
const PLAIN: Choices = Choices {
    wipe: false,
    remove_agents: false,
};
const WIPE: Choices = Choices {
    wipe: true,
    remove_agents: false,
};
#[test]
fn instances_share_the_lock_and_sign_out_needs_it_alone() {
    let (_dir, paths) = fixture();
    let first = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    let second = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    assert!(first.begin(WIPE).is_err());
    drop(second);
    assert!(admitted_once_free(&first, WIPE));
    // While one instance signs out, a new launch neither runs nor waits forever.
    assert_eq!(
        boot(&paths, no_agents, || panic!("no marker")).err(),
        Some(SIGNING_OUT.into())
    );
    assert_eq!(first.abort(WIPE, refuse("withdrawn")), refuse("withdrawn"));
    assert!(boot(&paths, no_agents, || panic!("no marker")).is_ok());
}

#[test]
fn a_second_sign_out_in_the_same_instance_is_refused() {
    let (_dir, paths) = fixture();
    let instance = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    instance.begin(WIPE).unwrap();
    assert_eq!(instance.begin(WIPE), Err(refuse(ALREADY)));
    // Concurrent calls race for the same guard; exactly one is admitted.
    instance.abort(WIPE, refuse("withdrawn"));
    let admitted = std::thread::scope(|scope| {
        let calls: Vec<_> = (0..8)
            .map(|_| scope.spawn(|| instance.begin(WIPE).is_ok()))
            .collect();
        calls
            .into_iter()
            .map(|call| call.join().unwrap())
            .filter(|&admitted| admitted)
            .count()
    });
    assert_eq!(admitted, 1);
}

#[test]
fn a_pending_sign_out_waits_for_the_restarting_instance_to_exit() {
    let (dir, paths) = fixture();
    let exiting = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    exiting.begin(WIPE).unwrap();
    mark(&paths, false, false);
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(30));
        drop(exiting);
    });
    let before = data(dir.path());
    assert!(boot(&paths, no_agents, || Ok(())).is_ok());
    release.join().unwrap();
    assert!(!paths.marker.exists());
    assert_eq!(
        data(dir.path()),
        before
            .into_iter()
            .filter(|path| !path.ends_with("sign-out-pending"))
            .collect::<Vec<_>>()
    );
}

const CHILD: &str = "BUZZ_SIGN_OUT_TEST_CHILD";
/// Set when the child signs out without wiping.
const CHILD_PLAIN: &str = "BUZZ_SIGN_OUT_TEST_CHILD_PLAIN";
/// The child's key service; `identity` when unset.
const CHILD_SERVICE: &str = "BUZZ_SIGN_OUT_TEST_CHILD_SERVICE";
/// Another Buzz process: boots, then on "go" tries to sign out and, if admitted,
/// holds on until the parent says (or closes its input). Closing its input
/// before "go" just exits, so it is a copy that only runs.
#[test]
fn child_instance() {
    let Some(root) = std::env::var_os(CHILD) else {
        return;
    };
    let service = std::env::var(CHILD_SERVICE).unwrap_or_else(|_| "identity".into());
    let paths = paths_for(Path::new(&root), &service);
    let instance = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    println!("child: booted");
    let mut input = std::io::stdin().lines();
    if input.next().is_none() {
        return;
    }
    let choices = if std::env::var_os(CHILD_PLAIN).is_some() {
        PLAIN
    } else {
        WIPE
    };
    if admitted_once_free(&instance, choices) {
        mark(&paths, choices.wipe, false);
        println!("child: signing out");
        input.next();
    } else {
        println!("child: refused");
    }
}
/// `child_instance` in a separate process, driven line by line.
struct Child {
    process: std::process::Child,
    input: Option<std::process::ChildStdin>,
    output: std::io::Lines<std::io::BufReader<std::process::ChildStdout>>,
}
impl Child {
    fn spawn(root: &Path) -> Self {
        Self::spawn_with(root, WIPE)
    }
    fn spawn_with(root: &Path, choices: Choices) -> Self {
        Self::spawn_as(root, "identity", choices)
    }
    /// A copy that only runs, signed in with `service`'s key.
    fn running(root: &Path, service: &str) -> Self {
        Self::spawn_as(root, service, WIPE)
    }
    fn spawn_as(root: &Path, service: &str, choices: Choices) -> Self {
        use std::io::BufRead;
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.env(CHILD_SERVICE, service);
        if !choices.wipe {
            command.env(CHILD_PLAIN, "1");
        }
        let mut process = command
            .args(["sign_out::tests::child_instance", "--exact", "--nocapture"])
            .env(CHILD, root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let input = process.stdin.take();
        let output = std::io::BufReader::new(process.stdout.take().unwrap()).lines();
        let mut child = Self {
            process,
            input,
            output,
        };
        assert_eq!(child.report(), "child: booted");
        child
    }
    fn report(&mut self) -> String {
        self.output
            .by_ref()
            .map(Result::unwrap)
            .find(|line| line.starts_with("child: "))
            .unwrap()
    }
    /// Let it try to sign out and return what it reports.
    fn go(&mut self) -> String {
        use std::io::Write;
        writeln!(self.input.as_mut().unwrap(), "go").unwrap();
        self.report()
    }
    /// Let it exit, reading the rest of its output so it never fails writing.
    fn finish(mut self) {
        drop(self.input.take());
        self.output.by_ref().for_each(drop);
        assert!(self.process.wait().unwrap().success());
    }
}

#[test]
fn across_processes_a_running_instance_blocks_sign_out_and_a_later_launch_finishes_it() {
    let (dir, paths) = fixture();
    // A launch that is already running refuses the other process's sign-out.
    let running = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    let mut child = Child::spawn(dir.path());
    assert_eq!(child.go(), "child: refused");
    child.finish();
    assert!(!paths.marker.exists());
    drop(running);
    // A launch that starts while the other process signs out waits until the
    // parent lets the child go, then finishes it.
    let mut child = Child::spawn(dir.path());
    assert_eq!(child.go(), "child: signing out");
    // Runs only once the launch has tried for the lock and is still waiting:
    // it lets the child go and waits for it to exit before the launch retries.
    let released = std::rc::Rc::new(Cell::new(false));
    let flag = released.clone();
    HANDOFF.set(Some(Box::new(move || {
        child.finish();
        flag.set(true);
    })));
    let removed = Cell::new(false);
    assert!(boot(&paths, no_agents, || {
        assert!(released.get(), "finished only after the child let go");
        removed.set(true);
        Ok(())
    })
    .is_ok());
    assert!(released.get());
    assert!(removed.get());
    assert!(!paths.marker.exists());
    assert_eq!(
        data(dir.path()),
        [
            "app/",
            "app/agent-controller/",
            "app/agent-controller/agents.json",
            "app/agents/",
            "app/agents/identities.json"
        ]
    );
}

#[test]
fn a_sign_out_committed_while_recovery_hands_the_lock_back_is_finished_too() {
    let (dir, paths) = fixture();
    mark(&paths, false, false);
    // In the gap after recovery lets go of the lock, another process launches
    // and commits a new sign-out.
    let root = dir.path().to_path_buf();
    HANDOFF.set(Some(Box::new(move || {
        let mut child = Child::spawn(&root);
        assert_eq!(child.go(), "child: signing out");
        child.finish();
    })));
    let removed = Cell::new(0);
    assert!(boot(&paths, no_agents, || {
        removed.set(removed.get() + 1);
        Ok(())
    })
    .is_ok());
    assert_eq!(removed.get(), 2);
    assert!(!paths.marker.exists());
}

#[test]
fn a_sign_out_committed_while_a_refused_one_lets_go_exits_natively() {
    let (dir, paths) = fixture();
    let instance = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    let mut child = Child::spawn_with(dir.path(), PLAIN);
    // Our upgrade is refused (the child shares); while we let go, it commits.
    HANDOFF.set(Some(Box::new(move || {
        assert_eq!(child.go(), "child: signing out");
        child.finish();
    })));
    let (closes, exited) = (Cell::new(0), Cell::new(false));
    let result = run(attempt(
        &instance,
        &paths,
        PLAIN,
        || async { Ok(()) },
        || closes.set(closes.get() + 1),
        || -> std::future::Ready<Result<(), String>> { panic!("agents must not stop") },
        || {
            assert_eq!(closes.get(), 1, "signing closes before the exit");
            exited.set(true);
            async { Err(refuse("exited")) }
        },
    ));
    assert!(exited.get());
    assert_eq!(result, Err(refuse("exited")));
    assert!(paths.marker.exists());
    // Not a usable retry: the guard stays taken.
    assert_eq!(instance.begin(WIPE), Err(refuse(ALREADY)));
}

/// Reading the kept registry's details fails while traversing and deleting it
/// stay allowed: the wipe must stop, not treat it as absent and delete it.
#[cfg(target_os = "macos")]
#[test]
fn an_uninspectable_kept_registry_stops_the_wipe_and_the_retry_keeps_it() {
    let (dir, paths) = fixture();
    mark(&paths, true, false);
    let before = listing(dir.path());
    let registry = paths.app_data.join(OLD_AGENTS);
    let chmod = |args: &[&str]| {
        let status = std::process::Command::new("chmod")
            .args(args)
            .arg(&registry)
            .status()
            .unwrap();
        assert!(status.success());
    };
    chmod(&["+a", "everyone deny readattr"]);
    assert!(registry.try_exists().is_err());
    let result = finish_pending(&paths, no_agents, || panic!("the human key stays"));
    // Removing every ACL entry needs no attribute read, unlike `-a`.
    chmod(&["-N"]);
    assert_eq!(result, Err(FAILED.into()));
    assert_eq!(listing(dir.path()), before);

    assert_eq!(finish_pending(&paths, no_agents, || Ok(())), Ok(()));
    assert_eq!(
        listing(dir.path()),
        [
            "app/",
            "app/agent-controller/",
            "app/agent-controller/agents.json",
            "app/agents/",
            "app/agents/identities.json"
        ]
    );
}

#[test]
fn a_first_launch_creates_a_missing_user_data_folder() {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths_for(&dir.path().join("missing/share"), "identity");
    assert!(boot(&paths, no_agents, || panic!("no marker")).is_ok());
    assert!(paths.lock.is_file() && paths.key_lock.is_file());
}

#[test]
fn every_identifier_shares_the_all_buzz_lock_and_each_key_has_its_own() {
    let (debug, release) = (
        Paths::resolve("dev.local.buzz.custom").unwrap(),
        Paths::resolve("dev.local.buzz.foundation").unwrap(),
    );
    assert_eq!(debug.lock, release.lock);
    assert_eq!(debug.key_lock, release.key_lock);
    assert_ne!(debug.marker, release.marker);
    assert_ne!(key_lock_name("identity"), key_lock_name("identity.debug"));
}

/// Another build signed in with a different key, e.g. a dev build beside the installed app.
const OTHER_KEY: &str = "identity.debug";

#[test]
fn plain_sign_out_needs_only_copies_using_the_same_key_closed() {
    let (dir, paths) = fixture();
    let other = Child::running(dir.path(), OTHER_KEY);
    let signing_out = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    assert_eq!(signing_out.begin(PLAIN), Ok(()));
    other.finish();
}

#[test]
fn plain_sign_out_is_refused_while_a_copy_using_the_same_key_runs() {
    let (dir, paths) = fixture();
    let same = Child::running(dir.path(), "identity");
    let signing_out = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    assert_eq!(signing_out.begin(PLAIN), Err(refuse(OTHERS)));
    drop(signing_out);
    // A pending plain sign-out waits for that copy too.
    mark(&paths, false, false);
    assert_eq!(
        boot(&paths, no_agents, || panic!("the key stays")).err(),
        Some(BUSY.into())
    );
    same.finish();
    assert!(boot(&paths, no_agents, || Ok(())).is_ok());
    assert!(!paths.marker.exists());
}

#[test]
fn wipe_is_refused_while_any_copy_runs() {
    let (dir, paths) = fixture();
    let other = Child::running(dir.path(), OTHER_KEY);
    let signing_out = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    assert_eq!(signing_out.begin(WIPE), Err(refuse(OTHERS_ALL)));
    drop(signing_out);
    // A pending wipe waits for every copy; a pending plain sign-out doesn't.
    mark(&paths, true, false);
    assert_eq!(
        boot(&paths, no_agents, || panic!("the key stays")).err(),
        Some(BUSY_ALL.into())
    );
    mark(&paths, false, false);
    assert!(boot(&paths, no_agents, || Ok(())).is_ok());
    assert!(!paths.marker.exists());
    other.finish();
}

/// A launch chose its locks for a plain sign-out; while it let go, another
/// process replaced it with a wipe and a copy with another key started. The
/// launch must not wipe holding only its key lock.
#[test]
fn a_sign_out_escalated_to_a_wipe_during_recovery_waits_for_every_copy() {
    let (dir, paths) = fixture();
    let mut wiping = Child::spawn(dir.path());
    mark(&paths, false, false);
    let before = data(dir.path());
    // The launch's first exclusive try fails (the child shares the key), then:
    let other = std::rc::Rc::new(Cell::new(None));
    let started = other.clone();
    let root = dir.path().to_path_buf();
    HANDOFF.set(Some(Box::new(move || {
        assert_eq!(wiping.go(), "child: signing out");
        wiping.finish();
        started.set(Some(Child::running(&root, OTHER_KEY)));
    })));
    assert_eq!(
        boot(&paths, no_agents, || panic!("the key stays")).err(),
        Some(BUSY_ALL.into())
    );
    assert_eq!(data(dir.path()), before);
    assert_eq!(pending(&paths.marker), Ok(Some(WIPE)));
    other.take().unwrap().finish();
    assert!(boot(&paths, no_agents, || Ok(())).is_ok());
    assert!(!paths.marker.exists());
    assert_eq!(
        data(dir.path()),
        [
            "app/",
            "app/agent-controller/",
            "app/agent-controller/agents.json",
            "app/agents/",
            "app/agents/identities.json"
        ]
    );
}

#[cfg(unix)]
#[test]
fn an_unreadable_registry_moves_nothing_and_the_retry_removes_agent_keys() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, paths) = fixture();
    mark(&paths, true, true);
    let before = listing(dir.path());
    let mode =
        |mode| fs::set_permissions(&paths.app_data, fs::Permissions::from_mode(mode)).unwrap();
    mode(0o000);
    let result = finish_pending(&paths, no_agents, || panic!("the human key stays"));
    mode(0o755);
    assert_eq!(result, Err(FAILED.into()));
    assert_eq!(listing(dir.path()), before);

    let removed = Cell::new(false);
    assert_eq!(
        finish_pending(
            &paths,
            |_| {
                removed.set(true);
                Ok(())
            },
            || Ok(())
        ),
        Ok(())
    );
    assert!(removed.get());
    assert!(listing(dir.path()).is_empty());
}

#[test]
fn agent_keys_go_first_and_an_interruption_retries_without_moving_anything() {
    let (dir, paths) = fixture();
    mark(&paths, true, true);
    let before = listing(dir.path());
    assert_eq!(
        finish_pending(
            &paths,
            |app_data| {
                assert!(app_data.join(OLD_AGENTS).join("agents.json").exists());
                assert!(app_data.join(AGENTS).join("identities.json").exists());
                Err("keychain interrupted".into())
            },
            || panic!("the human key waits for the agent keys")
        ),
        Err(FAILED.into())
    );
    assert_eq!(listing(dir.path()), before);
    let removed = Cell::new(false);
    assert_eq!(
        finish_pending(
            &paths,
            |_| {
                removed.set(true);
                Ok(())
            },
            || Ok(())
        ),
        Ok(())
    );
    assert!(removed.get());
    assert!(listing(dir.path()).is_empty());
}

#[test]
fn kept_agents_keep_only_their_list_settings_and_keys() {
    let (dir, paths) = fixture();
    let controller = paths.app_data.join(OLD_AGENTS);
    for file in [
        "defaults.json",
        "agents.previous.json",
        "controller.lock",
        "buzz-agent/oauth/databricks/0123abcd.json",
        "logs/agent.log",
        "runs/agent-1/tmp/scratch",
        "run-controls/agent-1/launch-protection.json",
        "control-write/staged",
        "something-new",
    ] {
        let path = controller.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "x").unwrap();
    }
    for file in ["identities.lock", "identities.tmp", "hosts/agent-1.lock"] {
        let path = paths.app_data.join(AGENTS).join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "x").unwrap();
    }
    mark(&paths, true, false);
    assert_eq!(finish_pending(&paths, no_agents, || Ok(())), Ok(()));
    assert_eq!(
        listing(dir.path()),
        [
            "app/",
            "app/agent-controller/",
            "app/agent-controller/agents.json",
            "app/agent-controller/defaults.json",
            "app/agents/",
            "app/agents/identities.json"
        ]
    );
    assert_eq!(fs::read(controller.join("agents.json")).unwrap(), b"agents");
    assert_eq!(fs::read(controller.join("defaults.json")).unwrap(), b"x");
    assert_eq!(
        fs::read(paths.app_data.join(AGENTS).join("identities.json")).unwrap(),
        b"identities"
    );
}

#[cfg(unix)]
#[test]
fn a_linked_kept_registry_stops_the_wipe_and_deletes_nothing_through_it() {
    let (dir, paths) = fixture();
    let controller = paths.app_data.join(OLD_AGENTS);
    let outside = dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let files = [
        ("agents.json", "a"),
        ("defaults.json", "d"),
        ("sentinel", "s"),
    ];
    for (name, body) in files {
        fs::write(outside.join(name), body).unwrap();
    }
    fs::remove_dir_all(&controller).unwrap();
    std::os::unix::fs::symlink(&outside, &controller).unwrap();
    mark(&paths, true, false);
    let result = finish_pending(&paths, no_agents, || panic!("the human key stays"));
    assert_eq!(result, Err(FAILED.to_owned()));
    assert!(paths.marker.exists());
    for (name, body) in files {
        assert_eq!(fs::read(outside.join(name)).unwrap(), body.as_bytes());
    }
    // A real registry in its place lets the retry finish.
    fs::remove_file(&controller).unwrap();
    fs::create_dir(&controller).unwrap();
    fs::write(controller.join("agents.json"), "agents").unwrap();
    assert_eq!(finish_pending(&paths, no_agents, || Ok(())), Ok(()));
    assert!(!paths.marker.exists());
    assert_eq!(fs::read(controller.join("agents.json")).unwrap(), b"agents");
    assert_eq!(fs::read(outside.join("sentinel")).unwrap(), b"s");
}

#[cfg(unix)]
#[test]
fn a_linked_wipe_folder_or_trash_stops_the_wipe() {
    for linked in ["webkit", "webkit.sign-out-trash", "app.sign-out-trash"] {
        let (dir, paths) = fixture();
        let outside = dir.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("sentinel"), "s").unwrap();
        let link = dir.path().join(linked);
        let _ = fs::remove_dir_all(&link);
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        mark(&paths, true, false);
        let result = finish_pending(&paths, no_agents, || panic!("the human key stays"));
        assert_eq!(result, Err(FAILED.to_owned()), "{linked}");
        assert!(paths.marker.exists());
        assert_eq!(fs::read(outside.join("sentinel")).unwrap(), b"s");
    }
}

#[test]
fn kept_agents_keep_their_keys() {
    let (_dir, paths) = fixture();
    mark(&paths, true, false);
    assert_eq!(finish_pending(&paths, no_agents, || Ok(())), Ok(()));
}

#[test]
fn debug_builds_sign_out_without_wipe_and_wipe_needs_default_plugin_storage() {
    assert_eq!(refusal(true, false, false, false, false), None);
    assert_eq!(refusal(true, false, false, true, false), Some(DEV_WIPE));
    assert_eq!(refusal(true, false, false, true, true), Some(DEV_WIPE));
    assert!(refusal(false, true, false, false, false)
        .unwrap()
        .contains("development broker"));
    assert!(refusal(false, false, true, true, false)
        .unwrap()
        .contains("BUZZODZ_HOME"));
    assert_eq!(refusal(false, false, true, false, false), None);
    assert_eq!(refusal(false, false, false, true, true), None);
}

fn choices(remove_agents: bool) -> Choices {
    Choices {
        wipe: true,
        remove_agents,
    }
}
fn run<F: Future>(future: F) -> F::Output {
    tauri::async_runtime::block_on(future)
}

#[test]
fn preparation_commits_the_marker_before_stopping_agents() {
    let (_dir, paths) = fixture();
    let marker = paths.marker.clone();
    let stopped = Cell::new(false);
    let closed = Cell::new(false);
    run(prepare(
        &paths,
        choices(true),
        || async { Ok(()) },
        || closed.set(true),
        || {
            assert!(marker.exists());
            assert!(closed.get(), "signing closes before agents stop");
            stopped.set(true);
            async { Ok(()) }
        },
    ))
    .unwrap();
    assert!(stopped.get());
}

#[test]
fn a_marker_write_failure_stops_nothing() {
    let (dir, mut paths) = fixture();
    paths.marker = dir.path().join("missing-folder/marker");
    let failure = run(prepare(
        &paths,
        choices(true),
        || async { Ok(()) },
        || panic!("nothing was committed"),
        || -> std::future::Ready<Result<(), String>> { panic!("agents must not stop") },
    ))
    .unwrap_err();
    assert_eq!(failure, refuse(NOT_PREPARED));
}

#[test]
fn a_shutdown_failure_keeps_the_marker_and_exits_natively() {
    let (_dir, paths) = fixture();
    let instance = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    let (closes, exited) = (Cell::new(0), Cell::new(false));
    let result = run(attempt(
        &instance,
        &paths,
        choices(false),
        || async { Ok(()) },
        || closes.set(closes.get() + 1),
        || async { Err("controller stuck".to_owned()) },
        || {
            // Once on commit, and again on the fenced path before the exit.
            assert_eq!(closes.get(), 2, "signing closes before the exit");
            exited.set(true);
            async { Err(refuse("exited")) }
        },
    ));
    assert!(exited.get());
    assert_eq!(result, Err(refuse("exited")));
    assert!(paths.marker.exists());
}

#[test]
fn a_pending_erase_waits_for_every_agent_supervisor_to_let_go() {
    let (_dir, paths) = fixture();
    mark(&paths, true, true);
    fs::create_dir_all(&paths.ownership).unwrap();
    let held = File::create(paths.ownership.join("agent-community.lock")).unwrap();
    #[allow(clippy::incompatible_msrv)]
    held.lock().unwrap();
    let before = data(paths.app_data.parent().unwrap());
    let refused = boot(
        &paths,
        |_| panic!("agent keys must stay"),
        || panic!("the key must stay"),
    );
    assert_eq!(refused.err(), Some(AGENT_STOPPING.to_owned()));
    assert_eq!(data(paths.app_data.parent().unwrap()), before);
    drop(held);
    let removed = Cell::new(0);
    let finished = boot(
        &paths,
        |_| {
            removed.set(removed.get() + 1);
            Ok(())
        },
        || {
            removed.set(removed.get() + 1);
            Ok(())
        },
    );
    assert_eq!(finished.err(), None);
    assert_eq!(removed.get(), 2);
    assert!(!paths.marker.exists());
}

#[test]
fn a_plain_sign_out_does_not_wait_for_agent_supervisors() {
    let (_dir, paths) = fixture();
    mark(&paths, false, false);
    fs::create_dir_all(&paths.ownership).unwrap();
    let held = File::create(paths.ownership.join("agent-community.lock")).unwrap();
    #[allow(clippy::incompatible_msrv)]
    held.lock().unwrap();
    assert!(boot(&paths, no_agents, || Ok(())).is_ok());
    assert!(!paths.marker.exists());
}

/// An outside folder holding `files`, for links to point at.
#[cfg(unix)]
fn outside(dir: &Path, files: &[&str]) -> PathBuf {
    let outside = dir.join("outside");
    for file in files {
        let path = outside.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, file.as_bytes()).unwrap();
    }
    outside
}
#[cfg(unix)]
fn unchanged(outside: &Path, files: &[&str]) {
    for file in files {
        assert_eq!(fs::read(outside.join(file)).unwrap(), file.as_bytes());
    }
}

#[cfg(unix)]
#[test]
fn a_linked_storage_parent_is_trusted_and_only_buzz_folder_under_it_goes() {
    let (dir, mut paths) = fixture();
    let files = ["sentinel", "app/localstorage"];
    let outside = outside(dir.path(), &files);
    let parent = dir.path().join("Library-WebKit");
    std::os::unix::fs::symlink(&outside, &parent).unwrap();
    paths.others = vec![parent.join("app")];
    mark(&paths, true, false);
    assert_eq!(finish_pending(&paths, no_agents, || Ok(())), Ok(()));
    assert!(fs::symlink_metadata(&parent).unwrap().is_symlink());
    assert!(!outside.join("app").exists());
    unchanged(&outside, &["sentinel"]);
}

#[cfg(unix)]
#[test]
fn rollback_never_moves_through_an_app_data_swapped_for_a_link() {
    let (dir, paths) = fixture();
    let files = ["agent-controller/sentinel"];
    let outside = outside(dir.path(), &files);
    mark(&paths, true, false);
    let result = finish_pending(&paths, no_agents, || {
        fs::rename(&paths.app_data, dir.path().join("displaced")).unwrap();
        std::os::unix::fs::symlink(&outside, &paths.app_data).unwrap();
        Err("keychain busy".into())
    });
    assert_eq!(result, Err(FAILED.to_owned()));
    assert!(paths.marker.exists());
    assert_eq!(
        listing(&outside),
        ["agent-controller/", "agent-controller/sentinel"]
    );
    unchanged(&outside, &files);
    // With the real app data back, the retry finishes and leaves outside alone.
    fs::remove_file(&paths.app_data).unwrap();
    fs::rename(dir.path().join("displaced"), &paths.app_data).unwrap();
    assert_eq!(finish_pending(&paths, no_agents, || Ok(())), Ok(()));
    assert!(!paths.marker.exists());
    unchanged(&outside, &files);
}

#[cfg(unix)]
#[test]
fn a_kept_registry_recreated_as_a_link_in_trash_fails_and_the_retry_finishes() {
    let (dir, paths) = fixture();
    let files = ["sentinel"];
    let outside = outside(dir.path(), &files);
    let link = trash(&paths.app_data).join(OLD_AGENTS);
    mark(&paths, true, false);
    let result = finish_pending(&paths, no_agents, || {
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        Ok(())
    });
    assert_eq!(result, Err(FAILED.to_owned()));
    assert!(paths.marker.exists());
    assert!(fs::symlink_metadata(&link).unwrap().is_symlink());
    unchanged(&outside, &files);
    fs::remove_file(&link).unwrap();
    assert_eq!(finish_pending(&paths, no_agents, || Ok(())), Ok(()));
    assert!(!paths.marker.exists());
    assert_eq!(
        fs::read(paths.app_data.join(OLD_AGENTS).join("agents.json")).unwrap(),
        b"agents"
    );
    unchanged(&outside, &files);
}

#[cfg(unix)]
#[test]
fn a_wipe_folder_or_trash_recreated_as_a_link_fails_and_the_retry_finishes() {
    for linked in ["webkit", "webkit.sign-out-trash"] {
        let (dir, paths) = fixture();
        let files = ["sentinel"];
        let outside = outside(dir.path(), &files);
        let link = dir.path().join(linked);
        mark(&paths, true, false);
        let result = finish_pending(&paths, no_agents, || {
            let _ = fs::rename(&link, dir.path().join("displaced"));
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            Ok(())
        });
        assert_eq!(result, Err(FAILED.to_owned()), "{linked}");
        assert!(paths.marker.exists());
        unchanged(&outside, &files);
        fs::remove_file(&link).unwrap();
        fs::create_dir(&link).unwrap();
        assert_eq!(finish_pending(&paths, no_agents, || Ok(())), Ok(()));
        assert!(!paths.marker.exists());
        assert!(!link.exists());
        unchanged(&outside, &files);
    }
}

#[cfg(unix)]
#[test]
fn a_linked_wipe_folder_refuses_before_any_marker() {
    let (dir, paths) = fixture();
    let controller = paths.app_data.join(OLD_AGENTS);
    fs::remove_dir_all(&controller).unwrap();
    std::os::unix::fs::symlink(dir.path(), &controller).unwrap();
    let failure = run(prepare(
        &paths,
        choices(false),
        || -> std::future::Ready<Result<(), Failure>> { panic!("paired tools stay") },
        || panic!("nothing was committed"),
        || -> std::future::Ready<Result<(), String>> { panic!("agents must not stop") },
    ))
    .unwrap_err();
    assert_eq!(failure, refuse(LINKED));
    assert!(!paths.marker.exists());
}

/// Paired tools that can't be revoked refuse the sign-out before its commit.
#[test]
fn unrevoked_paired_tools_refuse_before_any_marker() {
    let (_dir, paths) = fixture();
    let failure = run(prepare(
        &paths,
        choices(false),
        || async { Err(refuse("unrevoked")) },
        || panic!("nothing was committed"),
        || -> std::future::Ready<Result<(), String>> { panic!("agents must not stop") },
    ))
    .unwrap_err();
    assert_eq!(failure, refuse("unrevoked"));
    assert!(!paths.marker.exists());
}

/// The real command handler and generated ACL behind a main webview.
fn production_app() -> (
    tauri::App<tauri::test::MockRuntime>,
    tauri::WebviewWindow<tauri::test::MockRuntime>,
) {
    let app = tauri::test::mock_builder()
        .manage(crate::identity::IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (app, view)
}
fn invoke(
    view: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    tauri::test::get_ipc_response(
        view,
        tauri::webview::InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: view.url().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|body| body.deserialize().unwrap())
}

#[test]
fn production_acl_lets_the_dialog_ask_why_wipe_is_unavailable() {
    let (_app, view) = production_app();
    // Tests are debug builds, where wipe is refused.
    assert_eq!(
        invoke(&view, "sign_out_wipe_refusal", serde_json::json!({})).unwrap(),
        serde_json::json!(DEV_WIPE)
    );
}

#[test]
fn production_acl_lets_sign_out_reach_native_validation() {
    let (_app, view) = production_app();
    let error = invoke(
        &view,
        "sign_out",
        serde_json::json!({"wipe": false, "removeAgents": true}),
    )
    .unwrap_err();
    assert_eq!(
        error,
        serde_json::json!({
            "message": "Removing agents is part of erasing this device"
        })
    );
}

/// While this instance lets go of its locks, another sign-out is committed and
/// a restarted launch finishes it, removing the marker. Returns the fenced attempt.
/// `identifier` names the app that finishes it; it shares this instance's key.
fn finished_in_the_gap(
    dir: &Path,
    paths: &Paths,
    choices: Choices,
    identifier: &str,
) -> Result<(), Failure> {
    let instance = boot(paths, no_agents, || panic!("no marker")).ok().unwrap();
    // Plain: a copy sharing the key refuses the upgrade. Wipe: a copy with
    // another key refuses the all-Buzz lock.
    let running = if choices.wipe {
        Child::running(dir, OTHER_KEY)
    } else {
        Child::running(dir, "identity")
    };
    let mut gap = paths_for(dir, "identity");
    gap.marker = dir.join(marker_name(identifier, "identity"));
    HANDOFF.set(Some(Box::new(move || {
        running.finish();
        mark(&gap, choices.wipe, false);
        drop(boot(&gap, no_agents, || Ok(())).ok().unwrap());
        assert!(!gap.marker.exists(), "the sign-out finished");
    })));
    let closes = Cell::new(0);
    let result = run(attempt(
        &instance,
        paths,
        choices,
        || async { Ok(()) },
        || closes.set(closes.get() + 1),
        || -> std::future::Ready<Result<(), String>> { panic!("agents must not stop") },
        || {
            assert_eq!(closes.get(), 1, "signing closes before the exit");
            async { Err(refuse("exited")) }
        },
    ));
    assert_eq!(instance.begin(WIPE), Err(refuse(ALREADY)));
    result
}

#[test]
fn a_sign_out_finished_while_a_refused_one_lets_go_exits_natively() {
    let (dir, paths) = fixture();
    assert_eq!(
        finished_in_the_gap(dir.path(), &paths, PLAIN, "app"),
        Err(refuse("exited"))
    );
}

#[test]
fn a_wipe_finished_while_a_refused_one_lets_go_exits_natively() {
    let (dir, paths) = fixture();
    assert_eq!(
        finished_in_the_gap(dir.path(), &paths, WIPE, "app"),
        Err(refuse("exited"))
    );
}

#[test]
fn a_sign_out_finished_by_another_identifier_using_the_key_exits_natively() {
    let (dir, paths) = fixture();
    assert_eq!(
        finished_in_the_gap(dir.path(), &paths, PLAIN, "other"),
        Err(refuse("exited"))
    );
}

#[test]
fn a_sign_out_finished_before_launch_does_not_fence_a_later_refusal() {
    let (dir, paths) = fixture();
    mark(&paths, false, false);
    let instance = boot(&paths, no_agents, || Ok(())).ok().unwrap();
    assert!(paths.finished.exists());
    let running = Child::running(dir.path(), "identity");
    assert_eq!(instance.begin(PLAIN), Err(refuse(OTHERS)));
    running.finish();
}

#[test]
fn agents_rename_moves_once_and_retains_exact_identity_bytes() {
    let (_dir, paths) = fixture();
    let old = paths.app_data.join(migrate_agents::LEGACY);
    let new = paths.app_data.join(AGENTS);
    fs::rename(&new, &old).unwrap();
    let instance = boot(&paths, no_agents, || panic!("no sign-out")).unwrap();
    assert!(!old.exists());
    assert_eq!(
        fs::read(new.join("identities.json")).unwrap(),
        b"identities"
    );
    drop(instance);
    fs::write(new.join("identities.json"), "updated").unwrap();
    let _reopened = boot(&paths, no_agents, || panic!("no sign-out")).unwrap();
    assert_eq!(fs::read(new.join("identities.json")).unwrap(), b"updated");
}

#[test]
fn agents_rename_refuses_conflicts_and_a_running_old_copy() {
    let (_dir, paths) = fixture();
    let old = paths.app_data.join(migrate_agents::LEGACY);
    let new = paths.app_data.join(AGENTS);
    fs::create_dir(&old).unwrap();
    fs::write(old.join("identities.json"), "old").unwrap();
    assert!(boot(&paths, no_agents, || Ok(())).is_err());
    assert_eq!(
        fs::read(new.join("identities.json")).unwrap(),
        b"identities"
    );
    assert_eq!(fs::read(old.join("identities.json")).unwrap(), b"old");
    fs::remove_dir_all(&old).unwrap();
    let running = boot(&paths, no_agents, || Ok(())).unwrap();
    fs::rename(&new, &old).unwrap();
    assert!(boot(&paths, no_agents, || Ok(())).is_err());
    assert!(!new.exists());
    assert_eq!(
        fs::read(old.join("identities.json")).unwrap(),
        b"identities"
    );
    drop(running);
    assert!(boot(&paths, no_agents, || Ok(())).is_ok());
}

#[cfg(unix)]
#[test]
fn agents_rename_rejects_symlinks_without_touching_the_target() {
    let (dir, paths) = fixture();
    let outside = dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("identities.json"), "outside").unwrap();
    std::os::unix::fs::symlink(&outside, paths.app_data.join(migrate_agents::LEGACY)).unwrap();
    assert!(boot(&paths, no_agents, || Ok(())).is_err());
    assert_eq!(
        fs::read(outside.join("identities.json")).unwrap(),
        b"outside"
    );
}

#[test]
fn agents_rename_runs_after_pending_erase_keeps_legacy_identities() {
    let (_dir, paths) = fixture();
    let old = paths.app_data.join(migrate_agents::LEGACY);
    let new = paths.app_data.join(AGENTS);
    fs::rename(&new, &old).unwrap();
    mark(&paths, true, false);
    let _instance = boot(&paths, no_agents, || Ok(())).unwrap();
    assert!(!old.exists());
    assert_eq!(
        fs::read(new.join("identities.json")).unwrap(),
        b"identities"
    );
    assert!(!paths.app_data.join("archive.sqlite3").exists());
}

/// Rename the fixture's folders, their trash and marker to how the legacy
/// identifier left them, and move them back at launch.
fn legacy(paths: Paths) -> Paths {
    let old = |path: &Path| {
        let mut name = std::ffi::OsString::from("old-");
        name.push(path.file_name().unwrap());
        path.with_file_name(name)
    };
    let mut moves = Vec::new();
    for path in std::iter::once(&paths.app_data).chain(&paths.others) {
        moves.push((trash(&old(path)), trash(path)));
        moves.push((old(path), path.clone()));
    }
    moves.push((old(&paths.marker), paths.marker.clone()));
    for (old, new) in &moves {
        if new.exists() {
            fs::rename(new, old).unwrap();
        }
    }
    Paths { moves, ..paths }
}

#[test]
fn legacy_storage_moves_once_at_launch() {
    let (dir, paths) = fixture();
    let before = data(dir.path());
    let paths = legacy(paths);
    assert_ne!(data(dir.path()), before);
    let instance = boot(&paths, no_agents, || panic!("no sign-out")).unwrap();
    assert_eq!(data(dir.path()), before);
    drop(instance);
    fs::write(paths.app_data.join("archive.sqlite3"), "updated").unwrap();
    let _again = boot(&paths, no_agents, || panic!("no sign-out")).unwrap();
    assert_eq!(
        fs::read(paths.app_data.join("archive.sqlite3")).unwrap(),
        b"updated"
    );
}

#[test]
fn a_sign_out_the_legacy_build_committed_finishes_after_the_move() {
    let (dir, paths) = fixture();
    mark(&paths, true, false);
    let paths = legacy(paths);
    // An erase that stopped part-way left trash under the legacy name.
    fs::create_dir_all(&paths.moves[2].0).unwrap();
    fs::write(paths.moves[2].0.join("localstorage"), "prefs").unwrap();
    let removed = Cell::new(false);
    let _instance = boot(&paths, no_agents, || {
        removed.set(true);
        Ok(())
    })
    .unwrap();
    assert!(removed.get());
    assert_eq!(
        data(dir.path()),
        [
            "app/",
            "app/agent-controller/",
            "app/agent-controller/agents.json",
            "app/agents/",
            "app/agents/identities.json",
        ]
    );
}

#[test]
fn legacy_storage_beside_current_storage_moves_nothing_and_signs_nothing_out() {
    let (dir, paths) = fixture();
    mark(&paths, true, true);
    let paths = legacy(paths);
    // An older build ran again after the move: its storage and a current
    // plain sign-out sit beside a legacy erase.
    mark(&paths, false, false);
    fs::create_dir(&paths.others[0]).unwrap();
    // A stopping agent doesn't hide the conflict behind a wait.
    fs::create_dir_all(&paths.ownership).unwrap();
    let held = File::create(paths.ownership.join("agent-community.lock")).unwrap();
    #[allow(clippy::incompatible_msrv)]
    held.lock().unwrap();
    let before = data(dir.path());
    let refused = boot(&paths, no_agents, || panic!("the key must stay"))
        .err()
        .unwrap();
    // Every conflicting pair is named at once.
    for (old, new) in [&paths.moves[3], &paths.moves[4]] {
        assert!(refused.contains(&format!("{} beside {}", old.display(), new.display())));
    }
    assert!(refused.contains("Nothing was moved"));
    assert_eq!(data(dir.path()), before);
    drop(held);
    fs::remove_file(&paths.moves[4].0).unwrap();
    let before = data(dir.path());
    assert!(boot(&paths, no_agents, || panic!("the key must stay")).is_err());
    assert_eq!(data(dir.path()), before);
}

#[test]
fn a_move_interrupted_part_way_finishes_with_the_pending_legacy_sign_out() {
    let len = legacy(fixture().1).moves.len();
    // Renames run in order with the marker last, so any stop leaves a prefix
    // moved and the legacy marker pending.
    for moved in 1..len {
        let (dir, paths) = fixture();
        mark(&paths, true, false);
        let paths = legacy(paths);
        for (old, new) in paths.moves[..moved].iter().filter(|(old, _)| old.exists()) {
            fs::rename(old, new).unwrap();
        }
        let removed = Cell::new(false);
        let _instance = boot(&paths, no_agents, || {
            removed.set(true);
            Ok(())
        })
        .unwrap();
        assert!(removed.get(), "{moved} moved");
        assert_eq!(
            data(dir.path()),
            [
                "app/",
                "app/agent-controller/",
                "app/agent-controller/agents.json",
                "app/agents/",
                "app/agents/identities.json",
            ],
            "{moved} moved"
        );
    }
}

#[test]
fn legacy_storage_waits_for_other_copies_and_stopping_agents() {
    let (dir, paths) = fixture();
    let paths = legacy(paths);
    let running = boot(&paths_for(dir.path(), OTHER_KEY), no_agents, || {
        panic!("no sign-out")
    })
    .unwrap();
    let before = data(dir.path());
    assert!(boot(&paths, no_agents, || panic!("no sign-out")).is_err());
    assert_eq!(data(dir.path()), before);
    drop(running);
    fs::create_dir_all(&paths.ownership).unwrap();
    let held = File::create(paths.ownership.join("agent-community.lock")).unwrap();
    #[allow(clippy::incompatible_msrv)]
    held.lock().unwrap();
    let before = data(dir.path());
    assert!(boot(&paths, no_agents, || panic!("no sign-out")).is_err());
    assert_eq!(data(dir.path()), before);
    drop(held);
    let _instance = boot(&paths, no_agents, || panic!("no sign-out")).unwrap();
    assert!(paths.app_data.join("archive.sqlite3").exists());
    assert!(!paths.moves[1].0.exists());
}

#[test]
fn a_launch_waiting_on_a_copy_that_finished_the_move_carries_on() {
    let (dir, paths) = fixture();
    let before = data(dir.path());
    let paths = legacy(paths);
    let running = boot(&paths_for(dir.path(), OTHER_KEY), no_agents, || {
        panic!("no sign-out")
    })
    .unwrap();
    // The running copy moves everything while this launch waits for its lock.
    let moves = paths.moves.clone();
    HANDOFF.set(Some(Box::new(move || {
        for (old, new) in moves.iter().filter(|(old, _)| old.exists()) {
            fs::rename(old, new).unwrap();
        }
    })));
    let _instance = boot(&paths, no_agents, || panic!("no sign-out")).unwrap();
    assert_eq!(data(dir.path()), before);
    drop(running);
}

#[test]
fn a_conflict_seen_without_the_lock_is_confirmed_under_it() {
    let (dir, paths) = fixture();
    let before = data(dir.path());
    let paths = legacy(paths);
    let running = boot(&paths_for(dir.path(), OTHER_KEY), no_agents, || {
        panic!("no sign-out")
    })
    .unwrap();
    // The running copy has moved everything; a stray legacy folder stands in for
    // a scan that read it before that rename and its new name after.
    for (old, new) in &paths.moves {
        if old.exists() {
            fs::rename(old, new).unwrap();
        }
    }
    let stray = paths.moves[1].0.clone();
    fs::create_dir(&stray).unwrap();
    HANDOFF.set(Some(Box::new(move || {
        let _ = fs::remove_dir(&stray);
    })));
    let _instance = boot(&paths, no_agents, || panic!("no sign-out")).unwrap();
    assert_eq!(data(dir.path()), before);
    drop(running);
}

#[cfg(unix)]
#[test]
fn a_linked_legacy_folder_moves_as_the_link() {
    let (dir, paths) = fixture();
    let paths = legacy(paths);
    let outside = outside(dir.path(), &["localstorage"]);
    fs::remove_dir_all(&paths.moves[3].0).unwrap();
    std::os::unix::fs::symlink(&outside, &paths.moves[3].0).unwrap();
    let _instance = boot(&paths, no_agents, || panic!("no sign-out")).unwrap();
    assert_eq!(fs::read_link(&paths.others[0]).unwrap(), outside);
    unchanged(&outside, &["localstorage"]);
}

#[test]
fn only_the_current_identifier_takes_every_folder_the_legacy_one_used() {
    use legacy_identifier::{moves, CURRENT, LEGACY};
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    assert_eq!(config["identifier"], CURRENT);
    assert_eq!(
        moves("dev.local.buzz.foundation.nexus-test-012345abcdef"),
        Some(Vec::new())
    );
    let (legacy, current) = (
        Paths::resolve(LEGACY).unwrap(),
        Paths::resolve(CURRENT).unwrap(),
    );
    // Older builds take the same all-Buzz lock, so the move waits for them.
    assert_eq!(legacy.lock, current.lock);
    let moves = current.moves;
    assert!(moves.contains(&(legacy.marker, current.marker)));
    for path in std::iter::once(current.app_data).chain(current.others) {
        for path in [trash(&path), path] {
            let old = path.with_file_name(
                path.file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .replace(CURRENT, LEGACY),
            );
            assert!(moves.contains(&(old, path)));
        }
    }
}

/// Development seed bases under `root`, app data last, with the installed
/// app's folders under `source`.
fn installed(root: &Path, source: &str) -> Vec<PathBuf> {
    let seeds = vec![root.join("seed-webkit"), root.join("seed-data")];
    for (base, file) in seeds.iter().zip(["localstorage", "archive.sqlite3"]) {
        fs::create_dir_all(base.join(source).join("nested")).unwrap();
        fs::write(base.join(source).join("nested").join(file), source).unwrap();
    }
    fs::create_dir_all(seeds[1].join(source).join("archive")).unwrap();
    seeds
}

#[test]
fn a_first_development_launch_copies_the_installed_storage_once() {
    use legacy_identifier::{CURRENT, DEV, LEGACY};
    let (dir, paths) = fixture();
    let seeds = installed(dir.path(), CURRENT);
    installed(dir.path(), LEGACY);
    let paths = Paths {
        seeds: seeds.clone(),
        ..paths
    };
    let instance = boot(&paths, no_agents, || panic!("no sign-out")).unwrap();
    drop(instance);
    for (base, file) in seeds.iter().zip(["localstorage", "archive.sqlite3"]) {
        // The 1.0 folders win over the legacy ones, and stay in place.
        for name in [CURRENT, DEV] {
            assert_eq!(
                fs::read(base.join(name).join("nested").join(file)).unwrap(),
                CURRENT.as_bytes()
            );
        }
        assert!(!base.join(format!("{DEV}.seeding")).exists());
    }
    // Development builds never read the release archive.
    assert!(seeds[1].join(CURRENT).join("archive").exists());
    assert!(!seeds[1].join(DEV).join("archive").exists());
    let archive = seeds[1].join(DEV).join("nested/archive.sqlite3");
    fs::write(&archive, "updated").unwrap();
    fs::remove_dir_all(seeds[0].join(DEV)).unwrap();
    let _again = boot(&paths, no_agents, || panic!("no sign-out")).unwrap();
    assert_eq!(fs::read(&archive).unwrap(), b"updated");
    assert!(!seeds[0].join(DEV).exists());
}

#[test]
fn an_interrupted_development_seed_finishes_at_the_next_launch() {
    use legacy_identifier::{DEV, LEGACY};
    let (dir, paths) = fixture();
    let seeds = installed(dir.path(), LEGACY);
    // The last launch copied the first folder, then stopped part-way through app data.
    fs::create_dir_all(seeds[0].join(DEV)).unwrap();
    fs::create_dir_all(seeds[1].join(format!("{DEV}.seeding"))).unwrap();
    fs::write(seeds[1].join(format!("{DEV}.seeding/stale")), "").unwrap();
    let paths = Paths {
        seeds: seeds.clone(),
        ..paths
    };
    let _instance = boot(&paths, no_agents, || panic!("no sign-out")).unwrap();
    assert_eq!(fs::read_dir(seeds[0].join(DEV)).unwrap().count(), 0);
    assert_eq!(
        fs::read(seeds[1].join(DEV).join("nested/archive.sqlite3")).unwrap(),
        LEGACY.as_bytes()
    );
    assert!(!seeds[1].join(DEV).join("stale").exists());
    assert!(!seeds[1].join(format!("{DEV}.seeding")).exists());
}

#[test]
fn development_launches_copy_the_installed_storage_and_take_only_their_sign_out() {
    use legacy_identifier::{moves, seeds, CURRENT, DEV, LEGACY};
    assert!(include_str!("../../../scripts/desktop-config.mjs").contains(&format!("\"{DEV}\"")));
    let (legacy, dev) = (
        Paths::resolve(LEGACY).unwrap(),
        Paths::resolve(DEV).unwrap(),
    );
    assert_eq!(moves(DEV), Some(vec![(legacy.marker, dev.marker)]));
    assert_eq!(dev.seeds.last(), dirs::data_dir().as_ref());
    // Each folder copied is one the release build moves; caches aren't copied.
    let release = moves(CURRENT).unwrap();
    for base in &dev.seeds {
        assert!(release.contains(&(base.join(LEGACY), base.join(CURRENT))));
    }
    // Windows keeps caches in local data, which holds WebView2's storage.
    let cache = dirs::cache_dir().unwrap();
    assert!(cache == dirs::data_local_dir().unwrap() || !dev.seeds.contains(&cache));
    assert_eq!(seeds(CURRENT), Some(Vec::new()));
    assert_eq!(seeds(LEGACY), Some(Vec::new()));
}

#[test]
fn development_builds_use_the_installed_agents_unless_legacy_storage_is_due() {
    use legacy_identifier::{agents, CURRENT, DEV, LEGACY};
    let dir = tempfile::tempdir().unwrap();
    let app_data = |identifier: &str| dir.path().join(identifier);
    // With no installed storage, as after an erase that removed agents, never
    // the stale copy in `.dev`.
    assert_eq!(agents(DEV, &app_data(DEV)), app_data(CURRENT).join(AGENTS));
    fs::create_dir(app_data(LEGACY)).unwrap();
    // Before the installed app moves its storage, it is never created.
    assert_eq!(agents(DEV, &app_data(DEV)), app_data(DEV).join(AGENTS));
    assert!(!app_data(CURRENT).exists());
    fs::rename(app_data(LEGACY), app_data(CURRENT)).unwrap();
    assert_eq!(agents(DEV, &app_data(DEV)), app_data(CURRENT).join(AGENTS));
    assert_eq!(
        agents(CURRENT, &app_data(CURRENT)),
        app_data(CURRENT).join(AGENTS)
    );
    assert_eq!(
        agents("test", &app_data("test")),
        app_data("test").join(AGENTS)
    );
}

#[test]
fn a_split_release_move_seeds_each_folder_from_where_it_is() {
    use legacy_identifier::{CURRENT, DEV, LEGACY};
    let (dir, paths) = fixture();
    // The release move renamed app data, then stopped before WebKit.
    let seeds = installed(dir.path(), LEGACY);
    fs::rename(seeds[1].join(LEGACY), seeds[1].join(CURRENT)).unwrap();
    let paths = Paths {
        seeds: seeds.clone(),
        ..paths
    };
    let _instance = boot(&paths, no_agents, || panic!("no sign-out")).unwrap();
    assert!(seeds[0].join(DEV).join("nested/localstorage").exists());
    assert!(seeds[1].join(DEV).join("nested/archive.sqlite3").exists());
}

#[test]
fn a_development_seed_waits_for_the_installed_app_to_finish_signing_out() {
    use legacy_identifier::{DEV, LEGACY};
    let (dir, paths) = fixture();
    let seeds = installed(dir.path(), LEGACY);
    let marker = seeds[1].join(marker_name(
        LEGACY,
        buzz_credential_store::human_store(false),
    ));
    fs::write(&marker, "").unwrap();
    let paths = Paths {
        seeds: seeds.clone(),
        ..paths
    };
    let error = boot(&paths, no_agents, || panic!("no sign-out"))
        .err()
        .unwrap();
    assert!(error.contains("finish signing out"), "{error}");
    assert!(!seeds[0].join(DEV).exists() && !seeds[1].join(DEV).exists());
    fs::remove_file(&marker).unwrap();
    let _instance = boot(&paths, no_agents, || panic!("no sign-out")).unwrap();
    assert!(seeds[1].join(DEV).join("nested/archive.sqlite3").exists());
}

#[cfg(unix)]
#[test]
fn a_development_seed_never_links_into_the_installed_storage() {
    use legacy_identifier::{DEV, LEGACY};
    use std::os::unix::fs::symlink;
    let (dir, paths) = fixture();
    let seeds = installed(dir.path(), LEGACY);
    // The installed app data lives elsewhere, and links to a folder inside it.
    let moved = dir.path().join("moved");
    fs::rename(seeds[1].join(LEGACY), &moved).unwrap();
    symlink(&moved, seeds[1].join(LEGACY)).unwrap();
    symlink(moved.join("nested"), moved.join("link")).unwrap();
    let paths = Paths {
        seeds: seeds.clone(),
        ..paths
    };
    let _instance = boot(&paths, no_agents, || panic!("no sign-out")).unwrap();
    let copy = seeds[1].join(DEV);
    assert!(fs::symlink_metadata(&copy).unwrap().is_dir());
    assert!(copy.join("nested/archive.sqlite3").exists());
    assert!(fs::symlink_metadata(copy.join("link")).is_err());
}

#[cfg(unix)]
#[test]
fn a_development_seed_keeps_folder_access_and_retries_past_read_only_ones() {
    use legacy_identifier::{DEV, LEGACY};
    use std::os::unix::fs::PermissionsExt;
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    let (dir, paths) = fixture();
    let seeds = installed(dir.path(), LEGACY);
    let (private, sealed) = (seeds[1].join(LEGACY), seeds[1].join(LEGACY).join("nested"));
    fs::set_permissions(&private, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&sealed, fs::Permissions::from_mode(0o555)).unwrap();
    let paths = Paths {
        seeds: seeds.clone(),
        ..paths
    };
    drop(boot(&paths, no_agents, || panic!("no sign-out")).unwrap());
    let copy = seeds[1].join(DEV);
    assert_eq!((mode(&copy), mode(&copy.join("nested"))), (0o700, 0o755));
    // A copy cut short leaves the same tree staged; the retry clears and redoes it.
    fs::rename(&copy, seeds[1].join(format!("{DEV}.seeding"))).unwrap();
    let _instance = boot(&paths, no_agents, || panic!("no sign-out")).unwrap();
    assert!(copy.join("nested/archive.sqlite3").exists());
    assert!(!seeds[1].join(format!("{DEV}.seeding")).exists());
    assert_eq!((mode(&private), mode(&sealed)), (0o700, 0o555));
    fs::set_permissions(&sealed, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn a_sign_out_an_older_build_finished_removes_the_current_key_once() {
    let (_dir, paths) = fixture();
    let removed = Cell::new(0);
    let seen = paths.finished.with_file_name(format!(
        ".{}.sign-outs-seen",
        buzz_credential_store::HUMAN_STORE
    ));
    let launch = || {
        let instance = boot(&paths, no_agents, || Ok(())).unwrap();
        forget_signed_out_key(&instance, || {
            // Decided and removed holding the record alone: another launch
            // reads it only once this one has recorded the count.
            #[allow(clippy::incompatible_msrv)]
            let held = File::open(seen.with_file_name(format!(
                "{}.lock",
                seen.file_name().unwrap().to_str().unwrap()
            )))
            .unwrap()
            .try_lock_shared()
            .is_err();
            assert!(held);
            removed.set(removed.get() + 1);
            Ok(())
        })
    };
    // The first launch only starts counting.
    launch().unwrap();
    launch().unwrap();
    assert_eq!(removed.get(), 0);
    // An older build finishes a sign-out, removing only the previous key.
    fs::write(&paths.finished, ".").unwrap();
    launch().unwrap();
    assert_eq!(removed.get(), 1);
    launch().unwrap();
    assert_eq!(removed.get(), 1);
    // A failed removal records nothing, so the next launch retries.
    fs::write(&paths.finished, "..").unwrap();
    let instance = boot(&paths, no_agents, || Ok(())).unwrap();
    assert_eq!(
        forget_signed_out_key(&instance, || Err("denied".into())),
        Err(FAILED.into())
    );
    drop(instance);
    launch().unwrap();
    assert_eq!(removed.get(), 2);
    // A malformed record starts counting again, replaced whole.
    fs::write(&seen, b"\xff\xfe not a count").unwrap();
    launch().unwrap();
    assert_eq!(removed.get(), 2);
    assert_eq!(fs::read_to_string(&seen).unwrap(), "2");
    // A failed folder sync fails every launch until one succeeds, even once
    // the count reads back as recorded.
    fs::write(&paths.finished, "...").unwrap();
    let instance = boot(&paths, no_agents, || Ok(())).unwrap();
    let unsynced = |_: &Path| Err(std::io::Error::other("sync"));
    let remove = || {
        removed.set(removed.get() + 1);
        Ok(())
    };
    assert_eq!(
        reconcile_sign_outs(&instance, remove, unsynced),
        Err(FAILED.into())
    );
    assert_eq!(fs::read_to_string(&seen).unwrap(), "3");
    assert_eq!(
        reconcile_sign_outs(&instance, || panic!("removed"), unsynced),
        Err(FAILED.into())
    );
    let synced = Cell::new(false);
    reconcile_sign_outs(
        &instance,
        || panic!("removed"),
        |_| {
            synced.set(true);
            Ok(())
        },
    )
    .unwrap();
    assert!(synced.get());
    assert_eq!(removed.get(), 3);
}

/// A plain sign-out goes ahead once the pairing revoke-all is owed; sign out
/// and erase needs it done; a marker that could not be saved stops both.
#[test]
fn pairing_revoke_all_policy_for_sign_out() {
    use crate::credential_service::Unrevoked;
    let failed = |recorded| -> Result<(), Unrevoked> {
        Err(Unrevoked {
            recorded,
            message: "keychain".into(),
        })
    };
    for wipe in [false, true] {
        assert!(pairings_allow(&Ok(()), wipe));
        assert!(!pairings_allow(&failed(false), wipe), "unsaved marker");
    }
    assert!(pairings_allow(&failed(true), false), "plain sign-out");
    assert!(!pairings_allow(&failed(true), true), "sign out and erase");
}
