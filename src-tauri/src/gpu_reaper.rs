//! Kills a WebKit GPU process that WebKit dropped but left running.
//!
//! WebKit gives its GPU process 3 s to answer a page. After that it stops
//! reporting the process and asks launchd to kill it, which macOS refuses
//! (WebKit bug 324797). The page stays connected to the dropped process and
//! never paints: at login, Buzz opens to a window that stays empty. Once the
//! process is gone, WebKit starts a new one and the page paints, unreloaded.
//!
//! A main-thread timer records each GPU process the main webview reports,
//! with its start time. One that goes unreported for `GRACE` checks and is
//! still that process is killed. A process WebKit could shut down exits
//! within that time and is forgotten instead.
//!
//! A process the timer never saw reported is never killed. A check made while
//! the webview has no content process is skipped: WebKit then reports no GPU
//! process for it, dropped or not.

/// Seconds between checks. WebKit reports a GPU process for the 3 s it waits.
#[cfg(target_os = "macos")]
const INTERVAL: f64 = 1.0;
/// Checks a recorded process must go unreported before it is killed.
const GRACE: u8 = 2;

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

/// One check. `reported` is the GPU process WebKit reports now, and `running`
/// tells whether a process seen earlier still runs. Returns the processes to
/// kill, which are forgotten: a failed kill is not retried.
fn abandoned(
    seen: &mut Vec<Seen>,
    reported: Option<Process>,
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
        if entry.unreported < GRACE {
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

/// One check of the pids the webview reports for its content process and its
/// GPU process, 0 for none. `process` reads the identity of a GPU process.
///
/// A webview whose content process is gone reports no GPU process, even one
/// WebKit still uses for other webviews. That check is skipped: it kills
/// nothing and counts towards no grace.
fn check(
    seen: &mut Vec<Seen>,
    content: i32,
    gpu: i32,
    process: impl Fn(i32) -> Option<Process>,
) -> Vec<Process> {
    if content <= 0 {
        return Vec::new();
    }
    let reported = (gpu > 0).then(|| process(gpu)).flatten();
    abandoned(seen, reported, |earlier| {
        process(earlier.pid) == Some(earlier)
    })
}

#[cfg(target_os = "macos")]
pub(crate) use macos::install;

#[cfg(target_os = "macos")]
mod macos {
    use std::{cell::RefCell, ptr::NonNull};

    use block2::RcBlock;
    use objc2::{msg_send, rc::Weak, sel};
    use objc2_foundation::{NSObjectProtocol, NSTimer};
    use objc2_web_kit::WKWebView;
    use tauri::{AppHandle, Manager, Runtime};

    use super::{check, Process, INTERVAL};

    /// The executable of every WebKit GPU process.
    const GPU_BINARY: &[u8] = b"/com.apple.WebKit.GPU";

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

    /// Finder and login launches discard stderr, so also write to the unified log:
    /// log show --predicate 'process == "Buzz" AND eventMessage CONTAINS "GPU process"'
    fn log(message: &str) {
        eprintln!("{message}");
        if let Ok(message) = std::ffi::CString::new(message) {
            // SAFETY: "%s" takes the one NUL-terminated string passed.
            unsafe { libc::syslog(libc::LOG_NOTICE, c"%s".as_ptr(), message.as_ptr()) };
        }
    }

    pub(super) fn kill(process: Process) {
        // SAFETY: `kill` takes no pointers.
        if unsafe { libc::kill(process.pid, libc::SIGKILL) } == 0 {
            log(&format!(
                "Killed WebKit GPU process {} that WebKit dropped but left running",
                process.pid
            ));
        } else {
            log(&format!(
                "Could not kill WebKit GPU process {} that WebKit dropped: {}",
                process.pid,
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
            if !webview.respondsToSelector(sel!(_gpuProcessIdentifier))
                || !webview.respondsToSelector(sel!(_webProcessIdentifier))
            {
                log("This WebKit does not report its processes; not watching the GPU process");
                return;
            }
            let webview = Weak::from(webview);
            let seen = RefCell::new(Vec::new());
            let check = RcBlock::new(move |timer: NonNull<NSTimer>| {
                let Some(webview) = webview.load() else {
                    // SAFETY: the run loop supplies its live timer.
                    unsafe { timer.as_ref() }.invalidate();
                    return;
                };
                // SAFETY: the webview has these private properties, each a
                // `pid_t` that is 0 while it has no such launched process.
                let (content, gpu): (libc::pid_t, libc::pid_t) = unsafe {
                    (
                        msg_send![&*webview, _webProcessIdentifier],
                        msg_send![&*webview, _gpuProcessIdentifier],
                    )
                };
                let identity = |pid| process(pid, GPU_BINARY);
                for dropped in check(&mut seen.borrow_mut(), content, gpu, identity) {
                    kill(dropped);
                }
            });
            // SAFETY: the block only runs on this thread, the main thread,
            // whose run loop keeps the timer for the whole app.
            unsafe {
                NSTimer::scheduledTimerWithTimeInterval_repeats_block(INTERVAL, true, &check)
            };
        });
        if let Err(error) = installed {
            log(&format!("Could not watch the WebKit GPU process: {error}"));
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
    fn a_dropped_process_that_still_runs_is_killed_after_the_grace() {
        let mut seen = Vec::new();
        assert!(abandoned(&mut seen, Some(OLD), |_| true).is_empty());
        assert!(abandoned(&mut seen, Some(OLD), |_| true).is_empty());

        // WebKit gave up: the first unreported check only counts.
        assert!(abandoned(&mut seen, None, |_| true).is_empty());
        assert_eq!(abandoned(&mut seen, None, |_| true), [OLD]);

        // Killed once, whether or not the kill worked.
        assert!(seen.is_empty());
        assert!(abandoned(&mut seen, None, |_| true).is_empty());
    }

    #[test]
    fn a_process_that_exits_is_forgotten_not_killed() {
        let mut seen = Vec::new();
        abandoned(&mut seen, Some(OLD), |_| true);
        assert!(abandoned(&mut seen, None, |_| true).is_empty());
        // Gone, or its pid now belongs to another process.
        assert!(abandoned(&mut seen, None, |_| false).is_empty());
        assert!(seen.is_empty());
        assert!(abandoned(&mut seen, None, |_| true).is_empty());
    }

    #[test]
    fn a_process_reported_again_starts_a_new_grace() {
        let mut seen = Vec::new();
        abandoned(&mut seen, Some(OLD), |_| true);
        assert!(abandoned(&mut seen, None, |_| true).is_empty());
        assert!(abandoned(&mut seen, Some(OLD), |_| true).is_empty());
        assert!(abandoned(&mut seen, None, |_| true).is_empty());
        assert_eq!(abandoned(&mut seen, None, |_| true), [OLD]);
    }

    #[test]
    fn a_replacement_is_kept_while_the_dropped_process_is_killed() {
        let mut seen = Vec::new();
        abandoned(&mut seen, Some(OLD), |_| true);
        // Another page made WebKit start a new GPU process meanwhile.
        assert!(abandoned(&mut seen, Some(NEW), |_| true).is_empty());
        assert_eq!(abandoned(&mut seen, Some(NEW), |_| true), [OLD]);
        assert_eq!(pids(&seen), [NEW.pid]);
        assert!(abandoned(&mut seen, Some(NEW), |_| true).is_empty());
    }

    #[test]
    fn a_reused_pid_is_a_different_process() {
        let reused = Process {
            started: (300, 0),
            ..OLD
        };
        let mut seen = Vec::new();
        abandoned(&mut seen, Some(OLD), |_| true);
        // WebKit's next GPU process got the old pid: the old one is gone.
        assert!(abandoned(&mut seen, Some(reused), |process| process == reused).is_empty());
        assert!(abandoned(&mut seen, Some(reused), |process| process == reused).is_empty());
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].process, reused);
    }

    #[test]
    fn a_process_never_reported_is_never_killed() {
        let mut seen = Vec::new();
        for _ in 0..5 {
            assert!(abandoned(&mut seen, None, |_| true).is_empty());
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

    /// The identity read and the kill, on a child this test starts.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_process_is_identified_by_pid_start_time_and_binary() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("60")
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        let found = macos::process(pid, b"/sleep").unwrap();
        assert_eq!(found.pid, pid);
        assert_ne!(found.started, (0, 0));
        assert_eq!(macos::process(pid, b"/sleep"), Some(found));
        assert_eq!(macos::process(pid, b"/com.apple.WebKit.GPU"), None);

        macos::kill(found);
        assert!(!child.wait().unwrap().success());
        assert_eq!(macos::process(pid, b"/sleep"), None);
    }
}
