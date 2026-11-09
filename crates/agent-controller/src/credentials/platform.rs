use super::{Failure, Keychain};
use zeroize::Zeroizing;

pub(super) struct OsKeychain;

// Tests never compile live Keychain calls, including accidental default adapter use.
#[cfg(all(target_os = "macos", not(test)))]
mod macos {
    use super::*;
    use security_framework::item::{ItemClass, ItemSearchOptions};
    use security_framework::os::macos::{keychain::SecKeychain, passwords::find_generic_password};

    fn error(error: security_framework::base::Error) -> Failure {
        status(error.code())
    }
    impl Keychain for OsKeychain {
        fn legacy(&self, service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>, Failure> {
            // Legacy file-Keychain search list only. No DPK/per-key migration.
            observe("legacy-read", account, || {
                find_generic_password(None, service, account)
                    .map(|(password, _)| Zeroizing::new(password.to_vec()))
                    .map_err(error)
            })
        }
        fn saved(&self, service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>, Failure> {
            #[cfg(debug_assertions)]
            if let Some(result) = buzz_credential_store::dev_item("read", service, account, &[]) {
                return result.map_err(super::store_error);
            }
            // Read the same default Keychain that add writes, never a search-list match.
            observe("read", account, || {
                SecKeychain::default()
                    .map_err(error)?
                    .find_generic_password(service, account)
                    .map(|(password, _)| Zeroizing::new(password.to_vec()))
                    .map_err(error)
            })
        }
        fn add(&self, service: &str, account: &str, value: &[u8]) -> Result<(), Failure> {
            #[cfg(debug_assertions)]
            if let Some(result) = buzz_credential_store::dev_item("add", service, account, value) {
                return result.map(|_| ()).map_err(super::store_error);
            }
            observe("add", account, || {
                SecKeychain::default()
                    .map_err(error)?
                    .add_generic_password(service, account, value)
                    .map_err(error)
            })
        }
        fn replace(&self, service: &str, account: &str, value: &[u8]) -> Result<(), Failure> {
            #[cfg(debug_assertions)]
            if let Some(result) =
                buzz_credential_store::dev_item("replace", service, account, value)
            {
                return result.map(|_| ()).map_err(super::store_error);
            }
            // Updates the existing item in place; preserves its access controls.
            let keychain = SecKeychain::default().map_err(error)?;
            match observe("replace-read", account, || {
                keychain
                    .find_generic_password(service, account)
                    .map_err(error)
            }) {
                Ok((_, mut item)) => observe("update", account, || {
                    item.set_password(value).map_err(error)
                }),
                Err(Failure::Absent) => observe("add", account, || {
                    keychain
                        .add_generic_password(service, account, value)
                        .map_err(error)
                }),
                Err(problem) => Err(problem),
            }
        }
        fn bundle_lock(&self) -> Result<Box<dyn super::super::bundle::BundleLock>, Failure> {
            super::super::bundle_lock::acquire().map(|lock| Box::new(lock) as _)
        }
        fn delete(&self, service: &str, account: &str) -> Result<(), Failure> {
            #[cfg(debug_assertions)]
            if let Some(result) = buzz_credential_store::dev_item("delete", service, account, &[]) {
                return result.map(|_| ()).map_err(super::store_error);
            }
            let keychain = SecKeychain::default().map_err(error)?;
            ItemSearchOptions::new()
                .class(ItemClass::generic_password())
                .keychains(&[keychain])
                .service(service)
                .account(account)
                .delete()
                .map_err(error)
        }
    }
}

// Development terminal evidence only. Never format values, raw accounts, service
// names or OS error text. A Keychain call is NOT proof that an OS dialog appeared.
#[cfg(any(target_os = "macos", test))]
fn item_class(account: &str) -> &'static str {
    if account == super::bundle::ACCOUNT {
        "bundle"
    } else if account.starts_with("agent:") {
        "individual"
    } else {
        "legacy"
    }
}
#[cfg(any(target_os = "macos", test))]
fn observe<T>(
    operation: &'static str,
    account: &str,
    work: impl FnOnce() -> Result<T, Failure>,
) -> Result<T, Failure> {
    let begin = std::time::Instant::now();
    let report = |phase, outcome: Option<Failure>| {
        if cfg!(debug_assertions) {
            use std::io::Write;
            // Broken terminal output must never change credential custody.
            let _ = writeln!(std::io::stderr().lock(),
                "[agent-keychain] pid={} item={} operation={operation} phase={phase} failure={outcome:?} elapsed_ms={}",
                std::process::id(), item_class(account), begin.elapsed().as_millis());
        }
    };
    report("begin", None);
    let result = work();
    report("end", result.as_ref().err().copied());
    result
}

#[cfg(any(target_os = "macos", test))]
fn status(code: i32) -> Failure {
    match code {
        -25300 => Failure::Absent,
        -25299 => Failure::Occupied,
        -128 | -25293 | -25308 => Failure::Denied,
        -26275 => Failure::Corrupt,
        _ => Failure::Unavailable,
    }
}

#[cfg(any(
    not(any(target_os = "macos", target_os = "windows", target_os = "linux")),
    test
))]
impl Keychain for OsKeychain {
    fn legacy(&self, _: &str, _: &str) -> Result<Zeroizing<Vec<u8>>, Failure> {
        Err(Failure::Unavailable)
    }
    fn saved(&self, _: &str, _: &str) -> Result<Zeroizing<Vec<u8>>, Failure> {
        Err(Failure::Unavailable)
    }
    fn add(&self, _: &str, _: &str, _: &[u8]) -> Result<(), Failure> {
        Err(Failure::Unavailable)
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), Failure> {
        Err(Failure::Unavailable)
    }
}

#[test]
fn macos_status_codes_are_sanitized() {
    for (code, expected) in [
        (-25300, Failure::Absent),
        (-25299, Failure::Occupied),
        (-128, Failure::Denied),
        (-25293, Failure::Denied),
        (-25308, Failure::Denied),
        (-26275, Failure::Corrupt),
        (-1, Failure::Unavailable),
    ] {
        assert_eq!(status(code), expected);
    }
}

#[cfg(all(any(target_os = "windows", target_os = "linux"), not(test)))]
mod keyring_platform {
    use super::store_error as error;
    use super::*;
    use buzz_credential_store as credentials;
    impl Keychain for OsKeychain {
        fn legacy(&self, service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>, Failure> {
            // Exact selected legacy blob, read-only; keyring decodes Windows UTF-16.
            credentials::read(service, account).map_err(error)
        }
        fn saved(&self, service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>, Failure> {
            credentials::read(service, account).map_err(error)
        }
        fn add(&self, service: &str, account: &str, value: &[u8]) -> Result<(), Failure> {
            credentials::add(service, account, value).map_err(error)
        }
        fn delete(&self, service: &str, account: &str) -> Result<(), Failure> {
            credentials::delete(service, account).map_err(error)
        }
        fn copy(&self, previous: &str, service: &str, account: &str) -> Result<(), Failure> {
            credentials::copy(previous, service, account).map_err(error)
        }
    }
}

#[test]
fn diagnostics_classify_without_exposing_accounts_and_preserve_results() {
    assert_eq!(item_class(super::bundle::ACCOUNT), "bundle");
    assert_eq!(item_class("agent:PRIVATE_SENTINEL"), "individual");
    assert_eq!(item_class("PRIVATE_SENTINEL"), "legacy");
    let mut calls = 0;
    // The value deliberately implements neither Debug nor Display.
    struct PrivateValue;
    let result = observe("read", "PRIVATE_SENTINEL", || {
        calls += 1;
        Ok(PrivateValue)
    });
    assert!(result.is_ok());
    assert_eq!(calls, 1);
    for failure in [
        Failure::Absent,
        Failure::Occupied,
        Failure::Denied,
        Failure::Corrupt,
        Failure::Unavailable,
        Failure::Busy,
    ] {
        assert!(
            matches!(observe::<PrivateValue>("read", "PRIVATE_SENTINEL", || Err(failure)), Err(actual) if actual == failure)
        );
    }
}

#[cfg(all(
    not(test),
    any(
        target_os = "windows",
        target_os = "linux",
        all(target_os = "macos", debug_assertions)
    )
))]
fn store_error(error: buzz_credential_store::Error) -> Failure {
    use buzz_credential_store::Error;
    match error {
        Error::Absent => Failure::Absent,
        Error::Occupied => Failure::Occupied,
        Error::Denied => Failure::Denied,
        Error::Corrupt => Failure::Corrupt,
        Error::Unavailable | Error::Changed => Failure::Unavailable,
        Error::Busy => Failure::Busy,
    }
}
