use crate::{Error, Result};
use std::ffi::OsStr;
use std::io::Read;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

pub(super) fn read(helper: &OsStr) -> Result<Zeroizing<Vec<u8>>> {
    if !Path::new(helper).is_absolute() {
        return Err(Error::Unavailable);
    }
    let authorize = std::env::var_os("BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE").as_deref()
        == Some(OsStr::new("1"));
    let timeout = Duration::from_secs(if authorize { 120 } else { 5 });
    let deadline = Instant::now() + timeout;
    let (channel, helper_channel) = UnixStream::pair().map_err(|_| Error::Unavailable)?;
    let mut command = Command::new(helper);
    if authorize {
        command.arg("--authorize");
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::from(OwnedFd::from(helper_channel)))
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| Error::Unavailable)?;
    // Command retains a socket copy. Close it so an exited helper produces EOF.
    drop(command);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::Unavailable);
            }
        }
    };
    match status.code() {
        Some(0) => {}
        Some(10) => return Err(Error::Absent),
        Some(11) => return Err(Error::Denied),
        Some(12) => return Err(Error::Corrupt),
        _ => return Err(Error::Unavailable),
    }
    // The helper has exited. A retained socket in another process is a failure.
    channel
        .set_nonblocking(true)
        .map_err(|_| Error::Unavailable)?;
    let mut value = Zeroizing::new(Vec::with_capacity(64));
    channel
        .take(64)
        .read_to_end(&mut value)
        .map_err(|_| Error::Unavailable)?;
    if value.len() != 63 {
        return Err(Error::Corrupt);
    }
    Ok(value)
}

pub(super) fn agent(
    helper: &OsStr,
    operation: &str,
    service: &str,
    account: &str,
    value: &[u8],
) -> Result<Zeroizing<Vec<u8>>> {
    if !matches!(
        service,
        "xyz.block.buzz.desktop.agents" | "dev.local.buzz.foundation.agents"
    ) || !(account == "agent-bundle-v1" || account.starts_with("agent:"))
    {
        return Err(Error::Unavailable);
    }
    store(
        helper,
        "--agent-store",
        operation,
        service,
        account,
        value,
        2 * 1024 * 1024,
    )
}

pub(super) fn session(
    helper: &OsStr,
    operation: &str,
    service: &str,
    account: &str,
    value: &[u8],
) -> Result<Zeroizing<Vec<u8>>> {
    if service != "xyz.block.buzz.desktop.federated-session.debug"
        || account.len() != 64
        || !account
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(Error::Unavailable);
    }
    store(
        helper,
        "--session-store",
        operation,
        service,
        account,
        value,
        1024 * 1024,
    )
}

fn store(
    helper: &OsStr,
    store: &str,
    operation: &str,
    service: &str,
    account: &str,
    value: &[u8],
    limit: usize,
) -> Result<Zeroizing<Vec<u8>>> {
    use nix::poll::{poll, PollFd, PollFlags, PollTimeout};
    use std::io::Write;
    use std::net::Shutdown;

    if !Path::new(helper).is_absolute()
        || !matches!(operation, "read" | "replace" | "delete")
        || value.len() > limit
        || (operation != "replace" && !value.is_empty())
    {
        return Err(Error::Unavailable);
    }
    let authorize = std::env::var_os("BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE").as_deref()
        == Some(OsStr::new("1"));
    let timeout = Duration::from_secs(if authorize { 120 } else { 5 });
    let deadline = Instant::now() + timeout;
    let (mut channel, helper_channel) = UnixStream::pair().map_err(|_| Error::Unavailable)?;
    let mut command = Command::new(helper);
    if authorize {
        command.arg("--authorize");
    }
    let mut child = command
        .args([store, operation, service, account])
        .stdin(Stdio::null())
        .stdout(Stdio::from(OwnedFd::from(helper_channel)))
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| Error::Unavailable)?;
    drop(command);
    let exchange = (|| {
        let mut pending = value;
        while !pending.is_empty() {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or(Error::Unavailable)?;
            channel
                .set_write_timeout(Some(remaining))
                .map_err(|_| Error::Unavailable)?;
            let count = channel.write(pending).map_err(|_| Error::Unavailable)?;
            if count == 0 {
                return Err(Error::Unavailable);
            }
            pending = &pending[count..];
        }
        match channel.shutdown(Shutdown::Write) {
            // macOS can close the peer before its buffered reply is read.
            Err(error)
                if operation != "replace" && error.kind() == std::io::ErrorKind::NotConnected => {}
            result => result.map_err(|_| Error::Unavailable)?,
        }
        let mut output = Zeroizing::new(Vec::new());
        let mut buffer = Zeroizing::new([0; 8192]);
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or(Error::Unavailable)?;
            let ready = {
                let mut descriptors = [PollFd::new(channel.as_fd(), PollFlags::POLLIN)];
                poll(
                    &mut descriptors,
                    PollTimeout::try_from(remaining).map_err(|_| Error::Unavailable)?,
                )
            };
            match ready {
                Err(nix::errno::Errno::EINTR) => continue,
                Ok(0) | Err(_) => return Err(Error::Unavailable),
                Ok(_) => {}
            }
            let count = channel.read(&mut *buffer).map_err(|_| Error::Unavailable)?;
            if count == 0 {
                break;
            }
            if output.len() + count > if operation == "read" { limit } else { 0 } {
                return Err(Error::Corrupt);
            }
            output.extend_from_slice(&buffer[..count]);
        }
        Ok(output)
    })();
    // A helper can reject a write before it reads the payload.
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break match status.code() {
                    Some(0) => Ok(()),
                    Some(10) => Err(Error::Absent),
                    Some(11) => Err(Error::Denied),
                    Some(12) => Err(Error::Corrupt),
                    Some(13) => Err(Error::Occupied),
                    _ => Err(Error::Unavailable),
                }
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => break Err(Error::Unavailable),
        }
    };
    let result = status.and(exchange);
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}
