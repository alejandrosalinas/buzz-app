//! Quits on SIGTERM, SIGINT or SIGHUP as Quit does. Unhandled, the signal ends
//! Buzz before `shut_down` runs, and each agent, alone in its own process group,
//! outlives it with its input closed: Claude Code then cancels every remaining
//! tool call as if the owner had declined it, and keeps writing to the session
//! the next Buzz resumes.

use std::{future::poll_fn, task::Poll, time::Duration};

use tauri::{AppHandle, Manager, Runtime};
use tokio::signal::unix::{signal, Signal, SignalKind};

use crate::host_process::HostProcesses;

/// How long Quit may take before a signal ends Buzz anyway.
const QUIT_GRACE: Duration = Duration::from_secs(10);
const SIGNALS: [i32; 3] = [libc::SIGTERM, libc::SIGINT, libc::SIGHUP];

pub(crate) fn install<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(mut signals) = SIGNALS
            .into_iter()
            .filter(|&number| !ignored(number))
            .map(|number| Ok((number, signal(SignalKind::from_raw(number))?)))
            .collect::<std::io::Result<Vec<_>>>()
        else {
            eprintln!("Buzz cannot quit on a termination signal");
            return;
        };
        let number = next(&mut signals).await;
        app.exit(0);
        // A second signal, or a Quit that does not finish, still stops the
        // agents before Buzz goes.
        let _ = tokio::time::timeout(QUIT_GRACE, next(&mut signals)).await;
        app.state::<HostProcesses>().shutdown();
        // SAFETY: as after Mesh shutdown in `run`, skip only global destructors.
        unsafe { libc::_exit(128 + number) }
    });
}

/// Whether whoever launched Buzz asked it to ignore the signal, as `nohup`
/// does SIGHUP. Handling it would override that.
fn ignored(number: i32) -> bool {
    // SAFETY: with no new action, sigaction only reads the current one.
    unsafe {
        let mut action = std::mem::zeroed::<libc::sigaction>();
        libc::sigaction(number, std::ptr::null(), &mut action) == 0
            && action.sa_sigaction == libc::SIG_IGN
    }
}

/// The number of the next signal to arrive.
async fn next(signals: &mut [(i32, Signal)]) -> i32 {
    poll_fn(|cx| {
        signals
            .iter_mut()
            .find_map(|(number, signal)| signal.poll_recv(cx).is_ready().then_some(*number))
            .map_or(Poll::Pending, Poll::Ready)
    })
    .await
}
