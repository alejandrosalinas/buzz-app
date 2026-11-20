//! Kills WebKit helpers that WebKit dropped but left running.
//!
//! WebKit can stop reporting a helper after asking macOS to kill it. macOS
//! can refuse that request (WebKit bug 324797). A dropped GPU process leaves
//! the page blank. A dropped Networking process can keep storage locked.
//!
//! One main-thread timer records the GPU and Networking processes reported
//! by the main webview and its data store, with their start times. Each helper
//! type has a grace period before a still-matching process is killed. A helper
//! that exits on its own is forgotten instead.
//!
//! A helper the timer never saw reported is never killed. Checks pause while
//! the webview has no content process or a reported identity cannot be read.

/// Seconds between checks. WebKit reports a GPU process for the 3 s it waits.
#[cfg(target_os = "macos")]
const INTERVAL: f64 = 1.0;
/// Checks a GPU process must go unreported before it is killed.
const GPU_GRACE: u8 = 2;
/// Give Networking helpers more time to exit before recovery.
#[cfg(any(target_os = "macos", test))]
const NETWORK_GRACE: u8 = 10;

/// A process, told from a later one reusing its pid by when it started.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Process {
    pid: i32,
    started: (u64, u64),
}

struct Seen {
    process: Process,
    unreported: u8,
}

/// One check. `reported` is the helper WebKit reports now, and `running`
/// tells whether a helper seen earlier still runs. Returns the processes to
/// kill, which are forgotten: a failed kill is not retried.
fn abandoned(
    seen: &mut Vec<Seen>,
    reported: Option<Process>,
    grace: u8,
    running: impl Fn(Process) -> bool,
) -> Vec<Process> {
    let mut abandoned = Vec::new();
    seen.retain_mut(|entry| {
        if reported == Some(entry.process) {
            entry.unreported = 0;
            return true;
        }
        if !running(entry.process) {
            return false;
        }
        entry.unreported += 1;
        if entry.unreported < grace {
            return true;
        }
        abandoned.push(entry.process);
        false
    });
    if let Some(process) = reported {
        if seen.iter().all(|entry| entry.process != process) {
            seen.push(Seen {
                process,
                unreported: 0,
            });
        }
    }
    abandoned
}

/// One check of the reported content and helper pids, 0 for none.
/// `process` reads the identity of the expected helper binary.
///
/// A webview whose content process is gone reports no GPU process, even one
/// WebKit still uses for other webviews. That check is skipped: it kills
/// nothing and counts towards no grace.
fn check(
    seen: &mut Vec<Seen>,
    content: i32,
    helper: i32,
    process: impl Fn(i32) -> Option<Process>,
) -> Vec<Process> {
    check_with_grace(seen, content, helper, GPU_GRACE, process)
}

fn check_with_grace(
    seen: &mut Vec<Seen>,
    content: i32,
    helper: i32,
    grace: u8,
    process: impl Fn(i32) -> Option<Process>,
) -> Vec<Process> {
    if content <= 0 {
        return Vec::new();
    }
    let reported = if helper > 0 {
        let Some(reported) = process(helper) else {
            // An unreadable identity is not evidence that WebKit dropped it.
            return Vec::new();
        };
        Some(reported)
    } else {
        None
    };
    abandoned(seen, reported, grace, |earlier| {
        process(earlier.pid) == Some(earlier)
    })
}

#[cfg(target_os = "macos")]
pub(crate) use macos::install;

#[cfg(target_os = "macos")]
mod macos {
    use std::{cell::RefCell, ptr::NonNull};

    use block2::RcBlock;
    use objc2::{msg_send, rc::Weak, runtime::Bool, sel};
    use objc2_foundation::{NSObjectProtocol, NSTimer};
    use objc2_web_kit::WKWebView;
    use tauri::{AppHandle, Manager, Runtime};

    use super::{check, check_with_grace, Process, INTERVAL, NETWORK_GRACE};

    /// The executable of every WebKit GPU process.
    const GPU_BINARY: &[u8] = b"/com.apple.WebKit.GPU";
    const NETWORK_BINARY: &[u8] = b"/com.apple.WebKit.Networking";

    /// The running process `pid`, if its executable path ends with `binary`.
    pub(super) fn process(pid: libc::pid_t, binary: &[u8]) -> Option<Process> {
        // SAFETY: all zeroes is a valid `proc_bsdinfo`.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let mut path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: each call writes at most the size given into its buffer.
        let (read, length) = unsafe {
            (
                libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size),
                libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32),
            )
        };
        (read == size && path[..length.max(0) as usize].ends_with(binary)).then_some(Process {
            pid,
            started: (info.pbi_start_tvsec, info.pbi_start_tvusec),
        })
    }

    /// Finder and login launches discard stderr, so also use the unified log.
    /// Filter Buzz's messages for "WebKit".
    fn log(message: &str) {
        eprintln!("{message}");
        if let Ok(message) = std::ffi::CString::new(message) {
            // SAFETY: "%s" takes the one NUL-terminated string passed.
            unsafe { libc::syslog(libc::LOG_NOTICE, c"%s".as_ptr(), message.as_ptr()) };
        }
    }

    pub(super) fn kill(expected: Process, binary: &[u8], kind: &str) {
        // Recheck at the signal boundary, not only during the timer's sample.
        if process(expected.pid, binary) != Some(expected) {
            log(&format!(
                "Skipped signaling WebKit {kind} process {} because its identity no longer matched",
                expected.pid
            ));
            return;
        }
        // SAFETY: `kill` takes no pointers.
        if unsafe { libc::kill(expected.pid, libc::SIGKILL) } == 0 {
            log(&format!(
                "Killed WebKit {kind} process {} that WebKit dropped but left running",
                expected.pid
            ));
        } else {
            log(&format!(
                "Could not kill WebKit {kind} process {} that WebKit dropped: {}",
                expected.pid,
                std::io::Error::last_os_error()
            ));
        }
    }

    pub(crate) fn install<R: Runtime>(app: &AppHandle<R>) {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let installed = window.with_webview(|webview| {
            // SAFETY: Wry's macOS webview is a WKWebView.
            let webview = unsafe { &*webview.inner().cast::<WKWebView>() };
            let gpu_supported = webview.respondsToSelector(sel!(_gpuProcessIdentifier));
            // SAFETY: Tauri provides this WKWebView on the main thread.
            let store = unsafe { webview.configuration().websiteDataStore() };
            let network_supported = store.respondsToSelector(sel!(_networkProcessIdentifier))
                && store.respondsToSelector(sel!(_networkProcessExists));
            if !webview.respondsToSelector(sel!(_webProcessIdentifier))
                || (!gpu_supported && !network_supported)
            {
                log("This WebKit does not report its processes; not watching its helpers");
                return;
            }
            let webview = Weak::from(webview);
            let gpu_seen = RefCell::new(Vec::new());
            let network_seen = RefCell::new(Vec::new());
            let check = RcBlock::new(move |timer: NonNull<NSTimer>| {
                let Some(webview) = webview.load() else {
                    // SAFETY: the run loop supplies its live timer.
                    unsafe { timer.as_ref() }.invalidate();
                    return;
                };
                // SAFETY: selector availability was checked above. Each pid
                // is 0 while WebKit has no such launched process.
                let content: libc::pid_t = unsafe { msg_send![&*webview, _webProcessIdentifier] };
                if gpu_supported {
                    let gpu = unsafe { msg_send![&*webview, _gpuProcessIdentifier] };
                    let identity = |pid| process(pid, GPU_BINARY);
                    for dropped in check(&mut gpu_seen.borrow_mut(), content, gpu, identity) {
                        kill(dropped, GPU_BINARY, "GPU");
                    }
                }
                if network_supported {
                    // SAFETY: the timer runs on the main thread with a live WKWebView.
                    let store = unsafe { webview.configuration().websiteDataStore() };
                    // The pid getter starts a process if no proxy exists.
                    // Read only an existing proxy; this watcher must not launch one.
                    let exists: Bool = unsafe { msg_send![&*store, _networkProcessExists] };
                    let network = if exists.as_bool() {
                        unsafe { msg_send![&*store, _networkProcessIdentifier] }
                    } else {
                        0
                    };
                    let identity = |pid| process(pid, NETWORK_BINARY);
                    for dropped in check_with_grace(
                        &mut network_seen.borrow_mut(),
                        content,
                        network,
                        NETWORK_GRACE,
                        identity,
                    ) {
                        kill(dropped, NETWORK_BINARY, "Networking");
                    }
                }
            });
            // SAFETY: the block only runs on this thread, the main thread,
            // whose run loop keeps the timer for the whole app.
            unsafe {
                NSTimer::scheduledTimerWithTimeInterval_repeats_block(INTERVAL, true, &check)
            };
        });
        if let Err(error) = installed {
            log(&format!("Could not watch WebKit helpers: {error}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: Process = Process {
        pid: 41,
        started: (100, 0),
    };
    const NEW: Process = Process {
        pid: 42,
        started: (200, 0),
    };

    fn pids(seen: &[Seen]) -> Vec<i32> {
        seen.iter().map(|entry| entry.process.pid).collect()
    }

    #[test]
    fn a_dropped_process_is_signaled_after_its_configured_grace() {
        for grace in [GPU_GRACE, NETWORK_GRACE] {
            let mut seen = Vec::new();
            assert!(abandoned(&mut seen, Some(OLD), grace, |_| true).is_empty());

            // Each missing check before the limit only counts.
            for _ in 1..grace {
                assert!(abandoned(&mut seen, None, grace, |_| true).is_empty());
            }
            assert_eq!(abandoned(&mut seen, None, grace, |_| true), [OLD]);

            // Signaled once, whether or not the signal worked.
            assert!(seen.is_empty());
            assert!(abandoned(&mut seen, None, grace, |_| true).is_empty());
        }
    }

    #[test]
    fn a_process_that_exits_is_forgotten_not_killed() {
        let mut seen = Vec::new();
        abandoned(&mut seen, Some(OLD), GPU_GRACE, |_| true);
        assert!(abandoned(&mut seen, None, GPU_GRACE, |_| true).is_empty());
        // Gone, or its pid now belongs to another process.
        assert!(abandoned(&mut seen, None, GPU_GRACE, |_| false).is_empty());
        assert!(seen.is_empty());
        assert!(abandoned(&mut seen, None, GPU_GRACE, |_| true).is_empty());
    }

    #[test]
    fn a_process_reported_again_starts_a_new_grace() {
        let mut seen = Vec::new();
        abandoned(&mut seen, Some(OLD), GPU_GRACE, |_| true);
        assert!(abandoned(&mut seen, None, GPU_GRACE, |_| true).is_empty());
        assert!(abandoned(&mut seen, Some(OLD), GPU_GRACE, |_| true).is_empty());
        assert!(abandoned(&mut seen, None, GPU_GRACE, |_| true).is_empty());
        assert_eq!(abandoned(&mut seen, None, GPU_GRACE, |_| true), [OLD]);
    }

    #[test]
    fn a_replacement_is_kept_while_the_dropped_process_is_killed() {
        let mut seen = Vec::new();
        abandoned(&mut seen, Some(OLD), GPU_GRACE, |_| true);
        // Another page made WebKit start a new GPU process meanwhile.
        assert!(abandoned(&mut seen, Some(NEW), GPU_GRACE, |_| true).is_empty());
        assert_eq!(abandoned(&mut seen, Some(NEW), GPU_GRACE, |_| true), [OLD]);
        assert_eq!(pids(&seen), [NEW.pid]);
        assert!(abandoned(&mut seen, Some(NEW), GPU_GRACE, |_| true).is_empty());
    }

    #[test]
    fn a_reused_pid_is_a_different_process() {
        let reused = Process {
            started: (300, 0),
            ..OLD
        };
        let mut seen = Vec::new();
        abandoned(&mut seen, Some(OLD), GPU_GRACE, |_| true);
        // WebKit's next GPU process got the old pid: the old one is gone.
        assert!(
            abandoned(&mut seen, Some(reused), GPU_GRACE, |process| process
                == reused)
            .is_empty()
        );
        assert!(
            abandoned(&mut seen, Some(reused), GPU_GRACE, |process| process
                == reused)
            .is_empty()
        );
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].process, reused);
    }

    #[test]
    fn a_process_never_reported_is_never_killed() {
        let mut seen = Vec::new();
        for _ in 0..5 {
            assert!(abandoned(&mut seen, None, GPU_GRACE, |_| true).is_empty());
        }
    }

    #[test]
    fn a_check_without_a_content_process_is_skipped() {
        let healthy = |pid| (pid == OLD.pid).then_some(OLD);
        let mut seen = Vec::new();
        assert!(check(&mut seen, 7, OLD.pid, healthy).is_empty());

        // The content process crashed. WebKit reports no GPU process for this
        // webview and still uses OLD for its other webviews.
        for _ in 0..5 {
            assert!(check(&mut seen, 0, 0, healthy).is_empty());
        }
        assert_eq!(pids(&seen), [OLD.pid]);

        // Reloaded. The skipped checks counted towards no grace, and a
        // process WebKit then drops is still killed.
        assert!(check(&mut seen, 8, 0, healthy).is_empty());
        assert_eq!(check(&mut seen, 8, 0, healthy), [OLD]);
    }

    #[test]
    fn an_unreadable_reported_identity_pauses_the_grace() {
        let healthy = |pid| (pid == OLD.pid).then_some(OLD);
        let mut seen = Vec::new();
        check(&mut seen, 7, OLD.pid, healthy);
        assert!(check(&mut seen, 7, 0, healthy).is_empty());

        for _ in 0..5 {
            // The first lookup fails, but a later lookup could succeed.
            let first = std::cell::Cell::new(true);
            assert!(check(&mut seen, 7, OLD.pid, |pid| {
                if first.replace(false) {
                    None
                } else {
                    healthy(pid)
                }
            })
            .is_empty());
        }

        // The skipped checks neither forgot the helper nor spent its grace.
        assert_eq!(check(&mut seen, 7, 0, healthy), [OLD]);
    }

    /// The identity read and the kill, on a child this test starts.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_process_is_identified_by_pid_start_time_and_binary() {
        use std::{
            io::{Read, Write},
            os::unix::process::ExitStatusExt,
            process::{Command, Stdio},
        };

        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = child.stdout.take().unwrap();
        let mut assert_alive = || {
            input.write_all(b"alive\n").unwrap();
            let mut echoed = [0; 6];
            output.read_exact(&mut echoed).unwrap();
            assert_eq!(&echoed, b"alive\n");
        };
        assert_alive();

        let pid = child.id() as i32;
        let found = macos::process(pid, b"/cat").unwrap();
        assert_eq!(found.pid, pid);
        assert_ne!(found.started, (0, 0));
        assert_eq!(macos::process(pid, b"/cat"), Some(found));
        assert_eq!(macos::process(pid, b"/com.apple.WebKit.GPU"), None);

        let other_identity = Process {
            started: (found.started.0, found.started.1 + 1),
            ..found
        };
        macos::kill(other_identity, b"/cat", "test");
        assert_alive();
        macos::kill(found, b"/com.apple.WebKit.Networking", "Networking");
        assert_alive();

        macos::kill(found, b"/cat", "test");
        drop(input);
        assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGKILL));
        assert_eq!(macos::process(pid, b"/cat"), None);
    }
}
