use super::*;
use std::sync::Mutex;

#[derive(Default)]
struct Memory {
    value: Mutex<Option<Vec<u8>>>,
    read_error: Mutex<Option<Error>>,
    write_error: Mutex<Option<Error>>,
    writes: Mutex<usize>,
    deletes: Mutex<usize>,
    fail_after_write: bool,
}
impl Backend for Memory {
    fn read(&self) -> Result<Zeroizing<Vec<u8>>> {
        if let Some(error) = *self.read_error.lock().unwrap() {
            return Err(error);
        }
        self.value
            .lock()
            .unwrap()
            .clone()
            .map(Zeroizing::new)
            .ok_or(Error::Absent)
    }
    fn write(&self, value: &str) -> Result<()> {
        *self.writes.lock().unwrap() += 1;
        if let Some(error) = *self.write_error.lock().unwrap() {
            return Err(error);
        }
        *self.value.lock().unwrap() = Some(value.as_bytes().to_vec());
        if self.fail_after_write {
            return Err(Error::Unavailable);
        }
        Ok(())
    }
    fn delete(&self) -> Result<()> {
        *self.deletes.lock().unwrap() += 1;
        self.value
            .lock()
            .unwrap()
            .take()
            .map(|_| ())
            .ok_or(Error::Absent)
    }
}
const SERVICE: &str = "fixture-service";
const ACCOUNT: &str = "human";

#[test]
fn first_create_round_trips_and_a_second_writer_cannot_replace_it() {
    let root = tempfile::tempdir().unwrap();
    let store = Memory::default();
    // Both callers previously observed absence; add must always reread under lock.
    assert_eq!(store.read(), Err(Error::Absent));
    assert_eq!(store.read(), Err(Error::Absent));
    add_entry(&store, root.path(), SERVICE, ACCOUNT, b"first").unwrap();
    assert_eq!(
        add_entry(&store, root.path(), SERVICE, ACCOUNT, b"second"),
        Err(Error::Occupied)
    );
    assert_eq!(store.read().unwrap().as_slice(), b"first");
    assert_eq!(*store.writes.lock().unwrap(), 1);
}

#[test]
fn add_holds_the_lock_through_the_fresh_read_and_write() {
    struct Probed<'a> {
        root: &'a Path,
        memory: Memory,
    }
    impl Probed<'_> {
        fn assert_competing_add_is_busy(&self) {
            // Re-enter at the backend boundary: deterministic contention without
            // threads, sleeps, or accessing the real OS credential store.
            let competitor = Memory::default();
            assert_eq!(
                add_entry(&competitor, self.root, SERVICE, ACCOUNT, b"competitor"),
                Err(Error::Busy)
            );
            assert_eq!(*competitor.writes.lock().unwrap(), 0);
        }
    }
    impl Backend for Probed<'_> {
        fn read(&self) -> Result<Zeroizing<Vec<u8>>> {
            self.assert_competing_add_is_busy();
            self.memory.read()
        }
        fn write(&self, value: &str) -> Result<()> {
            self.assert_competing_add_is_busy();
            self.memory.write(value)
        }
        fn delete(&self) -> Result<()> {
            panic!("add must never delete");
        }
    }

    let root = tempfile::tempdir().unwrap();
    let store = Probed {
        root: root.path(),
        memory: Memory::default(),
    };
    add_entry(&store, root.path(), SERVICE, ACCOUNT, b"first").unwrap();
    assert_eq!(store.memory.read().unwrap().as_slice(), b"first");
    assert_eq!(*store.memory.writes.lock().unwrap(), 1);
    assert_eq!(
        add_entry(&store.memory, root.path(), SERVICE, ACCOUNT, b"second"),
        Err(Error::Occupied)
    );
}

#[test]
fn read_failures_never_allow_an_upsert_or_cleanup() {
    for error in [
        Error::Denied,
        Error::Corrupt,
        Error::Unavailable,
        Error::Busy,
    ] {
        let root = tempfile::tempdir().unwrap();
        let store = Memory::default();
        *store.read_error.lock().unwrap() = Some(error);
        assert_eq!(
            add_entry(&store, root.path(), SERVICE, ACCOUNT, b"new"),
            Err(error)
        );
        assert_eq!(*store.writes.lock().unwrap(), 0);
        assert_eq!(*store.deletes.lock().unwrap(), 0);
    }
}

#[test]
fn failed_write_releases_the_lock_for_an_explicit_retry() {
    let root = tempfile::tempdir().unwrap();
    let store = Memory::default();
    *store.write_error.lock().unwrap() = Some(Error::Denied);
    assert_eq!(
        add_entry(&store, root.path(), SERVICE, ACCOUNT, b"new"),
        Err(Error::Denied)
    );
    assert!(store.value.lock().unwrap().is_none());
    *store.write_error.lock().unwrap() = None;
    add_entry(&store, root.path(), SERVICE, ACCOUNT, b"new").unwrap();
    assert_eq!(store.read().unwrap().as_slice(), b"new");
}

#[test]
fn lock_contention_blocks_create_and_delete_but_not_other_namespaces() {
    let root = tempfile::tempdir().unwrap();
    let store = Memory::default();
    let lock = acquire(root.path(), SERVICE, ACCOUNT).unwrap();
    // Model a descriptor inherited by a concurrently spawning process. Closing
    // only our descriptor must not leave the completed operation holding a lock.
    let inherited = lock.0.try_clone().unwrap();
    assert_eq!(
        add_entry(&store, root.path(), SERVICE, ACCOUNT, b"new"),
        Err(Error::Busy)
    );
    assert_eq!(
        delete_entry(&store, root.path(), SERVICE, ACCOUNT),
        Err(Error::Busy)
    );
    assert_eq!(*store.writes.lock().unwrap(), 0);
    assert_eq!(*store.deletes.lock().unwrap(), 0);
    let other_account = acquire(root.path(), SERVICE, "agent").unwrap();
    let other_service = acquire(root.path(), "other-service", ACCOUNT).unwrap();
    drop((lock, other_account, other_service));
    add_entry(&store, root.path(), SERVICE, ACCOUNT, b"new").unwrap();
    delete_entry(&store, root.path(), SERVICE, ACCOUNT).unwrap();
    assert_eq!(store.read(), Err(Error::Absent));
    let reacquired = acquire(root.path(), SERVICE, ACCOUNT).unwrap();
    drop(inherited);
    assert!(matches!(
        acquire(root.path(), SERVICE, ACCOUNT),
        Err(Error::Busy)
    ));
    drop(reacquired);
}

#[test]
fn error_mapping_is_typed_and_contains_no_backend_detail() {
    assert_eq!(error(keyring::Error::NoEntry), Error::Absent);
    assert_eq!(
        error(keyring::Error::NoStorageAccess(Box::new(
            std::io::Error::other("PRIVATE")
        ))),
        Error::Denied
    );
    assert_eq!(
        error(keyring::Error::PlatformFailure(Box::new(
            std::io::Error::other("PRIVATE")
        ))),
        Error::Unavailable
    );
    assert_eq!(
        error(keyring::Error::BadEncoding(b"PRIVATE".to_vec())),
        Error::Corrupt
    );
    assert_eq!(error(keyring::Error::Ambiguous(vec![])), Error::Corrupt);
}

#[test]
fn another_process_observes_the_same_lock_and_can_retry_after_release() {
    let root = tempfile::tempdir().unwrap();
    let lock = acquire(root.path(), SERVICE, ACCOUNT).unwrap();
    let run = |expected: &str| {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::lock_child", "--nocapture"])
            .env("BUZZ_CREDENTIAL_LOCK_TEST_ROOT", root.path())
            .env("BUZZ_CREDENTIAL_LOCK_TEST_EXPECTED", expected)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("LOCK_CHILD_CHECKED"));
    };
    run("busy");
    drop(lock);
    run("ready");
}

#[test]
fn lock_child() {
    let Some(root) = std::env::var_os("BUZZ_CREDENTIAL_LOCK_TEST_ROOT") else {
        return;
    };
    let result = acquire(Path::new(&root), SERVICE, ACCOUNT);
    match std::env::var("BUZZ_CREDENTIAL_LOCK_TEST_EXPECTED")
        .unwrap()
        .as_str()
    {
        "busy" => assert!(matches!(result, Err(Error::Busy))),
        "ready" => assert!(result.is_ok()),
        _ => panic!("Invalid fixture expectation"),
    }
    println!("LOCK_CHILD_CHECKED");
}

#[test]
fn ambiguous_write_outcomes_are_not_adopted_or_deleted() {
    let root = tempfile::tempdir().unwrap();
    let store = Memory {
        fail_after_write: true,
        ..Memory::default()
    };
    assert_eq!(
        add_entry(&store, root.path(), SERVICE, ACCOUNT, b"new"),
        Err(Error::Unavailable)
    );
    assert_eq!(
        add_entry(&store, root.path(), SERVICE, ACCOUNT, b"retry"),
        Err(Error::Occupied)
    );
    assert_eq!(*store.value.lock().unwrap(), Some(b"new".to_vec()));
    assert_eq!(*store.writes.lock().unwrap(), 1);
    assert_eq!(*store.deletes.lock().unwrap(), 0);
}

#[test]
fn home_override_does_not_split_the_lock_namespace() {
    // Child-only environment changes; neither process creates a real lock/store.
    let root = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "tests::home_child", "--nocapture"])
        .env("HOME", root.path())
        .env("USERPROFILE", root.path())
        .env("XDG_DATA_HOME", root.path())
        .env("BUZZ_CREDENTIAL_HOME_EXPECTED", lock_root().unwrap())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("HOME_CHILD_CHECKED"));
}

#[test]
fn home_child() {
    let Some(expected) = std::env::var_os("BUZZ_CREDENTIAL_HOME_EXPECTED") else {
        return;
    };
    assert_eq!(lock_root().unwrap(), std::path::PathBuf::from(expected));
    println!("HOME_CHILD_CHECKED");
}
#[test]
fn human_identity_slots_stay_separate() {
    assert_eq!(HUMAN_ACCOUNT, "human");
    assert_eq!(
        human_service(true),
        "xyz.block.buzz.desktop.onboarding-test.identity.debug"
    );
    assert_eq!(
        human_service(false),
        "xyz.block.buzz.desktop.onboarding-test.identity"
    );
    assert_eq!(HUMAN_SERVICE, human_service(cfg!(debug_assertions)));
    assert_eq!(
        human_store(true),
        "dev.local.buzz.foundation.onboarding-test.identity.debug"
    );
    assert_eq!(
        human_store(false),
        "dev.local.buzz.foundation.onboarding-test.identity"
    );
    assert_eq!(HUMAN_STORE, human_store(cfg!(debug_assertions)));
    assert_eq!(PREVIOUS_HUMAN_SERVICE, HUMAN_STORE);
}

#[test]
fn replace_overwrites_or_creates_under_the_shared_lock() {
    let root = tempfile::tempdir().unwrap();
    let store = Memory::default();
    replace_entry(&store, root.path(), SERVICE, "setting", b"first").unwrap();
    replace_entry(&store, root.path(), SERVICE, "setting", b"second").unwrap();
    assert_eq!(store.read().unwrap().as_slice(), b"second");
    let _held = acquire(root.path(), SERVICE, "setting").unwrap();
    assert_eq!(
        replace_entry(&store, root.path(), SERVICE, "setting", b"third"),
        Err(Error::Busy)
    );
    assert_eq!(store.read().unwrap().as_slice(), b"second");
}

#[test]
fn read_or_copy_copies_only_when_absent_and_returns_what_is_saved() {
    use std::cell::RefCell;
    let saved = RefCell::new(None);
    let current = || Ok::<_, Error>(*saved.borrow());
    // Nothing to copy: absence, never a stale value.
    assert_eq!(read_or_copy(current, || Ok(())), Ok(None));
    let copy = || {
        *saved.borrow_mut() = Some("old");
        Ok(())
    };
    assert_eq!(read_or_copy(current, copy), Ok(Some("old")));
    // Saved under the current service: nothing is copied again.
    *saved.borrow_mut() = Some("new");
    assert_eq!(read_or_copy(current, || panic!("copied")), Ok(Some("new")));
}

#[test]
fn read_or_copy_returns_failures_and_accepts_a_copy_another_app_made() {
    let none = || Ok::<Option<&str>, Error>(None);
    assert_eq!(
        read_or_copy(
            || Err::<Option<&str>, _>(Error::Denied),
            || panic!("copied")
        ),
        Err(Error::Denied)
    );
    assert_eq!(
        read_or_copy(none, || Err(Error::Denied)),
        Err(Error::Denied)
    );
    // Another app saved it while this copy was refused: its key is read back.
    let saved = std::cell::RefCell::new(None);
    let raced = || {
        *saved.borrow_mut() = Some("old");
        Err(Error::Busy)
    };
    assert_eq!(read_or_copy(|| Ok(*saved.borrow()), raced), Ok(Some("old")));
}

#[test]
fn copy_holds_the_previous_items_lock_so_deleting_it_waits() {
    let root = tempfile::tempdir().unwrap();
    let previous = Memory::default();
    *previous.value.lock().unwrap() = Some(b"key".to_vec());
    let added = Mutex::new(None);
    copy_with(
        root.path(),
        SERVICE,
        ACCOUNT,
        || {
            // A delete between the read and the write is refused, not lost.
            assert_eq!(
                delete_entry(&previous, root.path(), SERVICE, ACCOUNT),
                Err(Error::Busy)
            );
            previous.read()
        },
        |value| {
            *added.lock().unwrap() = Some(value.to_vec());
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(added.lock().unwrap().as_deref(), Some(&b"key"[..]));
    // After the copy, the delete goes through.
    delete_entry(&previous, root.path(), SERVICE, ACCOUNT).unwrap();
    // Absent: nothing to add. Saved first by another copy: nothing to do.
    let absent = || Err(Error::Absent);
    copy_with(root.path(), SERVICE, ACCOUNT, absent, |_| panic!("added")).unwrap();
    let saved = || Ok(Zeroizing::new(b"key".to_vec()));
    copy_with(root.path(), SERVICE, ACCOUNT, saved, |_| {
        Err(Error::Occupied)
    })
    .unwrap();
    assert_eq!(
        copy_with(root.path(), SERVICE, ACCOUNT, saved, |_| Err(Error::Denied)),
        Err(Error::Denied)
    );
}
