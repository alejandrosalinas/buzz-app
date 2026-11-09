use crate::{with_manager, PluginManager};
use buzzodz_plugins::{
    HostCommand, DEFAULT_HOST_COMMAND_OUTPUT_BYTES, MAX_HOST_COMMAND_OUTPUT_BYTES,
};
use std::ffi::{OsStr, OsString};
#[cfg(unix)]
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::AtomicI32;
#[cfg(unix)]
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

#[cfg(windows)]
pub(crate) mod windows_job {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use tokio::process::{Child, Command};
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
    };

    pub(crate) struct WindowsJob(OwnedHandle);

    impl WindowsJob {
        pub(crate) fn new() -> Option<Self> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return None;
            }
            let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job.0.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            };
            if configured == 0 {
                return None;
            }
            Some(job)
        }

        /// Termination is asynchronous; waits, bounded by `wait`, until no job process remains.
        pub(crate) async fn terminate(&self, wait: std::time::Duration) {
            unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) };
            let until = tokio::time::Instant::now() + wait;
            while self.active_processes() != Some(0) && tokio::time::Instant::now() < until {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }

        fn active_processes(&self) -> Option<u32> {
            let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            let queried = unsafe {
                QueryInformationJobObject(
                    self.0.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                )
            };
            (queried != 0).then_some(info.ActiveProcesses)
        }

        pub(super) fn assign(&self, child: &Child) -> bool {
            child.raw_handle().is_some_and(|handle| unsafe {
                AssignProcessToJobObject(self.0.as_raw_handle(), handle) != 0
            })
        }

        pub(super) fn spawn(&self, command: &mut Command) -> std::io::Result<Child> {
            self.spawn_with_check(command, 0, |_, _| {})
        }

        pub(crate) fn spawn_hidden(&self, command: &mut Command) -> std::io::Result<Child> {
            self.spawn_with_check(command, CREATE_NO_WINDOW, |_, _| {})
        }

        /// Fails with the operating system's reason when the program cannot
        /// start, such as a missing file.
        pub(super) fn spawn_with_check(
            &self,
            command: &mut Command,
            flags: u32,
            check: impl FnOnce(&Child, &OwnedHandle),
        ) -> std::io::Result<Child> {
            command
                .creation_flags(CREATE_SUSPENDED | flags)
                .kill_on_drop(true);
            let child = command.spawn()?;
            let unjobbed = || std::io::Error::other("it could not join its job");
            let primary_thread = child.id().and_then(primary_thread).ok_or_else(unjobbed)?;
            check(&child, &primary_thread);
            if !self.assign(&child) {
                return Err(unjobbed());
            }
            if unsafe { ResumeThread(primary_thread.as_raw_handle()) } != 1 {
                return Err(unjobbed());
            }
            Ok(child)
        }
    }

    fn primary_thread(process_id: u32) -> Option<OwnedHandle> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        if unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } == 0 {
            return None;
        }
        let mut thread_id = None;
        loop {
            if entry.th32OwnerProcessID == process_id
                && thread_id.replace(entry.th32ThreadID).is_some()
            {
                return None;
            }
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            if unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } == 0 {
                break;
            }
        }
        if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
            return None;
        }
        let handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id?) };
        if handle.is_null() {
            return None;
        }
        Some(unsafe { OwnedHandle::from_raw_handle(handle) })
    }
}

const DEADLINE: Duration = Duration::from_secs(5);

// Tokio kills only the direct child on future cancellation; the group also owns descendants.
#[cfg(unix)]
pub(crate) struct ProcessGroupGuard {
    pub(crate) process_id: i32,
    pub(crate) armed: bool,
}

#[cfg(unix)]
impl ProcessGroupGuard {
    pub(crate) fn kill(&self) {
        unsafe { libc::kill(-self.process_id, libc::SIGKILL) };
    }
}

#[cfg(unix)]
impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        if self.armed {
            self.kill();
        }
    }
}

/// Exposes a running command's process group, so app exit can kill it, and
/// withdraws it once the command has finished.
#[cfg(unix)]
struct PublishedGroup<'a>(&'a AtomicI32);

#[cfg(unix)]
impl<'a> PublishedGroup<'a> {
    fn new(group: &'a AtomicI32, process_id: i32) -> Self {
        group.store(process_id, Ordering::SeqCst);
        Self(group)
    }
}

#[cfg(unix)]
impl Drop for PublishedGroup<'_> {
    fn drop(&mut self) {
        self.0.store(0, Ordering::SeqCst);
    }
}

#[tauri::command]
pub(crate) async fn plugin_host_run_command(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    command_id: String,
    input: Option<String>,
) -> Result<Option<String>, String> {
    let operation = async {
        let command = with_manager(manager, move |manager| {
            manager
                .host_grants(&id, &revision)?
                .commands
                .into_iter()
                .find(|command| command.id == command_id)
                .ok_or_else(|| "Command is not declared".into())
        })
        .await
        .ok()?;
        run_command(&command, input.as_deref(), DEADLINE).await
    };
    Ok(tokio::time::timeout(DEADLINE, operation)
        .await
        .ok()
        .flatten())
}

#[cfg(target_os = "macos")]
static LOGIN_SHELL_PATH: tokio::sync::OnceCell<Option<OsString>> =
    tokio::sync::OnceCell::const_new();
#[cfg(target_os = "macos")]
static LOGIN_SHELL_PROBE_GROUP: AtomicI32 = AtomicI32::new(0);
#[cfg(target_os = "macos")]
const LOGIN_SHELL_DEADLINE: Duration = Duration::from_secs(10);
#[cfg(target_os = "macos")]
const LOGIN_SHELL_PATH_MARKER: &str = "__BUZZ_LOGIN_SHELL_PATH__";

/// Reads PATH from the user's login shell once, so later calls to
/// [`effective_path`] see it. Apps opened from Finder only inherit launchd's
/// `/usr/bin:/bin:/usr/sbin:/sbin`, which would run system tools, such as an
/// older Apple git, instead of the ones the user's terminal finds.
pub(crate) async fn load_login_shell_path() {
    #[cfg(target_os = "macos")]
    LOGIN_SHELL_PATH
        .get_or_init(|| async {
            use std::io::IsTerminal as _;
            // Started from a terminal, Buzz already has that shell's PATH, and an
            // interactive probe would stop on the terminal it cannot take over.
            if std::io::stdin().is_terminal() {
                return None;
            }
            let shell = crate::terminal::resolve_shell(std::env::var("SHELL").ok().as_deref());
            let path = login_shell_path(
                Path::new(&shell),
                LOGIN_SHELL_DEADLINE,
                &LOGIN_SHELL_PROBE_GROUP,
            )
            .await;
            if path.is_none() {
                eprintln!(
                    "Could not read PATH from login shell {shell}; agents use the app's PATH"
                );
            }
            path
        })
        .await;
}

/// Kills a login-shell probe still running when the app exits: its async task
/// will not run again to enforce the deadline.
pub(crate) fn stop_login_shell_probe() {
    #[cfg(target_os = "macos")]
    kill_published_group(&LOGIN_SHELL_PROBE_GROUP);
}

#[cfg(target_os = "macos")]
fn kill_published_group(group: &AtomicI32) {
    let process_id = group.load(Ordering::SeqCst);
    if process_id > 0 {
        unsafe { libc::kill(-process_id, libc::SIGKILL) };
    }
}

#[cfg(target_os = "macos")]
async fn login_shell_path(shell: &Path, deadline: Duration, group: &AtomicI32) -> Option<OsString> {
    // External commands only, so any shell's syntax runs it and PATH arrives
    // colon-separated even from shells that keep it as a list, such as fish.
    let script = format!(
        "/usr/bin/printf {LOGIN_SHELL_PATH_MARKER}; /usr/bin/printenv PATH; /usr/bin/printf {LOGIN_SHELL_PATH_MARKER}"
    );
    // Profiles can check BUZZ_RESOLVING_ENVIRONMENT to skip slow setup, and
    // DISABLE_AUTO_UPDATE stops Oh My Zsh from prompting to update.
    let args = [
        "DISABLE_AUTO_UPDATE=true",
        "BUZZ_RESOLVING_ENVIRONMENT=1",
        &shell.to_string_lossy(),
        "-l",
        "-i",
        "-c",
        &script,
    ]
    .map(String::from);
    // Profiles may print banners or exit non-zero after setting PATH.
    let (output, _) = run_output_with_input(
        Path::new("/usr/bin/env"),
        &args,
        deadline,
        OsStr::new(""),
        1 << 20,
        None,
        Some(group),
    )
    .await?;
    let path = output
        .split(LOGIN_SHELL_PATH_MARKER)
        .nth(1)?
        .trim_end_matches('\n');
    (!path.is_empty()).then(|| path.into())
}

pub(crate) fn effective_path() -> OsString {
    let path = std::env::var_os("PATH").unwrap_or_default();
    #[cfg(target_os = "macos")]
    {
        let path = if path.is_empty() {
            OsString::from("/usr/bin:/bin")
        } else {
            path
        };
        compose_path(
            std::env::var_os("HOME").as_deref(),
            LOGIN_SHELL_PATH.get().cloned().flatten().as_deref(),
            &path,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        path
    }
}

#[cfg(target_os = "macos")]
fn compose_path(home: Option<&OsStr>, login_shell: Option<&OsStr>, inherited: &OsStr) -> OsString {
    // Per-user installs, such as Claude's official installer, come first:
    // an older system-wide copy in /usr/local/bin would otherwise run instead,
    // and installing again could not replace it.
    let mut directories = home
        .map(|home| Path::new(home).join(".local/bin"))
        .into_iter()
        .collect::<Vec<_>>();
    let candidates = login_shell
        .into_iter()
        .chain([inherited])
        .flat_map(std::env::split_paths)
        .chain(["/opt/homebrew/bin".into(), "/usr/local/bin".into()]);
    for directory in candidates {
        if !directory.as_os_str().is_empty() && !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    std::env::join_paths(directories).unwrap_or_else(|_| inherited.to_owned())
}

pub(crate) fn resolve_program(program: &str, effective_path: &OsStr) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;

        if let Some(executable) = std::env::split_paths(effective_path)
            .map(|path| path.join(program))
            .find(|path| {
                std::fs::metadata(path).is_ok_and(|metadata| {
                    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
                })
            })
        {
            return executable;
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = effective_path;
    PathBuf::from(program)
}

async fn run_command(
    command: &HostCommand,
    input: Option<&str>,
    deadline: Duration,
) -> Option<String> {
    if command
        .max_input_bytes
        .is_some_and(|limit| !(1..=buzzodz_plugins::MAX_HOST_COMMAND_INPUT_BYTES).contains(&limit))
        || input.is_some_and(|value| {
            command
                .max_input_bytes
                .is_none_or(|limit| value.len() as u64 > limit)
        })
    {
        return None;
    }
    let path = effective_path();
    let max_output_bytes = command
        .max_output_bytes
        .unwrap_or(DEFAULT_HOST_COMMAND_OUTPUT_BYTES);
    if !(1..=MAX_HOST_COMMAND_OUTPUT_BYTES).contains(&max_output_bytes) {
        return None;
    }
    let program = match command.artifact.clone() {
        Some(artifact) => {
            tokio::task::spawn_blocking(move || crate::host_process::verified_artifact(artifact))
                .await
                .ok()?
                .ok()?
        }
        None => resolve_program(&command.program, &path),
    };
    run(
        &program,
        &command.args,
        deadline,
        &path,
        max_output_bytes,
        input,
    )
    .await
}

async fn run(
    executable: &Path,
    args: &[String],
    deadline: Duration,
    path: &OsStr,
    max_output_bytes: u64,
    input: Option<&str>,
) -> Option<String> {
    let (output, status) = run_output_with_input(
        executable,
        args,
        deadline,
        path,
        max_output_bytes,
        input,
        None,
    )
    .await?;
    status.success().then_some(output)
}

async fn run_output_with_input(
    executable: &Path,
    args: &[String],
    deadline: Duration,
    path: &OsStr,
    max_output_bytes: u64,
    input: Option<&str>,
    group: Option<&AtomicI32>,
) -> Option<(String, std::process::ExitStatus)> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if !path.is_empty() {
        command.env("PATH", path);
    }
    #[cfg(unix)]
    command.as_std_mut().process_group(0);

    #[cfg(windows)]
    let _job = windows_job::WindowsJob::new()?;
    #[cfg(windows)]
    let mut child = _job.spawn(&mut command).ok()?;
    #[cfg(not(windows))]
    let mut child = command.spawn().ok()?;
    #[cfg(unix)]
    let mut process_group = ProcessGroupGuard {
        process_id: child.id()? as i32,
        armed: true,
    };
    #[cfg(unix)]
    let _published = group.map(|group| PublishedGroup::new(group, process_group.process_id));
    #[cfg(not(unix))]
    let _ = group;
    let stdout = child.stdout.take()?;
    let output = tokio::time::timeout(deadline, async {
        let writer = async {
            if let Some(input) = input {
                let mut stdin = child.stdin.take()?;
                stdin.write_all(input.as_bytes()).await.ok()?;
                stdin.shutdown().await.ok()?;
            }
            Some(())
        };
        let reader = async {
            let mut bytes = Vec::new();
            stdout
                .take(max_output_bytes + 1)
                .read_to_end(&mut bytes)
                .await
                .ok()?;
            if bytes.len() as u64 > max_output_bytes {
                return None;
            }
            Some(bytes)
        };
        // A command may produce output before reading its input.
        let (written, bytes) = tokio::join!(writer, reader);
        written?;
        let bytes = bytes?;
        let status = child.wait().await.ok()?;
        #[cfg(unix)]
        {
            process_group.armed = false;
        }
        Some((bytes, status))
    })
    .await;

    if let Ok(Some((bytes, status))) = output {
        return Some((String::from_utf8(bytes).ok()?, status));
    }

    #[cfg(unix)]
    process_group.kill();
    let _ = child.start_kill();
    let _ = child.wait().await;
    #[cfg(unix)]
    {
        process_group.armed = false;
    }
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::{effective_path, run as run_with_path};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    async fn run(executable: &Path, args: &[String], deadline: Duration) -> Option<String> {
        run_with_path(
            executable,
            args,
            deadline,
            &effective_path(),
            super::DEFAULT_HOST_COMMAND_OUTPUT_BYTES,
            None,
        )
        .await
    }

    fn executable(script: &str) -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tool");
        crate::test_executable::write_executable(&path, format!("#!/bin/sh\n{script}\n"));
        (directory, path)
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn per_user_installs_come_before_system_wide_ones() {
        let home = std::env::var_os("HOME").unwrap();
        let path = effective_path();
        let directories = std::env::split_paths(&path).collect::<Vec<_>>();
        let first = |directory: &Path| directories.iter().position(|item| item == directory);
        assert_eq!(first(&Path::new(&home).join(".local/bin")), Some(0));
        assert!(first(Path::new("/usr/local/bin")) > Some(0));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn login_shell_order_wins_over_the_launchd_path() {
        let path = super::compose_path(
            Some("/Users/me".as_ref()),
            Some("/opt/homebrew/bin:/usr/bin:/bin".as_ref()),
            "/usr/bin:/bin:/usr/sbin:/sbin".as_ref(),
        );
        assert_eq!(
            path,
            "/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin"
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn login_shell_path_is_read_past_profile_output() {
        let (_directory, shell) = executable(
            "[ \"$DISABLE_AUTO_UPDATE$BUZZ_RESOLVING_ENVIRONMENT\" = true1 ] || exit\n\
             echo 'Last login: Tue'; PATH=/opt/homebrew/bin:/usr/bin; eval \"$4\"; exit 1",
        );
        assert_eq!(
            super::login_shell_path(&shell, Duration::from_secs(2), &Default::default()).await,
            Some("/opt/homebrew/bin:/usr/bin".into())
        );
        let (_directory, shell) = executable("echo 'no PATH here'");
        assert_eq!(
            super::login_shell_path(&shell, Duration::from_secs(2), &Default::default()).await,
            None
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn app_exit_kills_a_running_login_shell_probe() {
        use std::sync::atomic::{AtomicI32, Ordering};
        static GROUP: AtomicI32 = AtomicI32::new(0);
        let (_directory, shell) = executable("sleep 30");
        let probe = tokio::spawn(async move {
            super::login_shell_path(&shell, Duration::from_secs(30), &GROUP).await
        });
        let process_id = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match GROUP.load(Ordering::SeqCst) {
                    0 => tokio::task::yield_now().await,
                    process_id => break process_id,
                }
            }
        })
        .await
        .expect("probe did not start");
        super::kill_published_group(&GROUP);
        let result = tokio::time::timeout(Duration::from_secs(2), probe)
            .await
            .expect("probe outlived the kill")
            .unwrap();
        assert_eq!(result, None);
        assert_eq!(GROUP.load(Ordering::SeqCst), 0);
        assert_eq!(unsafe { libc::kill(process_id, 0) }, -1);
    }

    #[tokio::test]
    async fn larger_output_requires_a_bounded_manifest_opt_in() {
        let (_directory, path) =
            executable("/usr/bin/head -c 5000 /dev/zero | /usr/bin/tr '\\000' x");
        let mut command = super::HostCommand {
            id: "inventory".into(),
            program: "env".into(),
            args: vec![path.to_string_lossy().into_owned()],
            max_output_bytes: None,
            max_input_bytes: None,
            artifact: None,
        };
        assert_eq!(
            super::run_command(&command, None, Duration::from_secs(2)).await,
            None
        );
        command.max_output_bytes = Some(5000);
        assert_eq!(
            super::run_command(&command, None, Duration::from_secs(2)).await,
            Some("x".repeat(5000))
        );
        command.max_output_bytes = Some(4999);
        assert_eq!(
            super::run_command(&command, None, Duration::from_secs(2)).await,
            None
        );
        for limit in [0, super::MAX_HOST_COMMAND_OUTPUT_BYTES + 1] {
            command.max_output_bytes = Some(limit);
            assert_eq!(
                super::run_command(&command, None, Duration::from_secs(2)).await,
                None
            );
        }
    }

    #[tokio::test]
    async fn artifact_commands_run_only_verified_bytes() {
        use sha2::{Digest, Sha256};
        let (directory, _) = executable("");
        let path = directory.path().canonicalize().unwrap().join("status");
        crate::test_executable::write_executable(&path, "#!/bin/sh\nprintf verified\n");
        let sha256 = format!("{:x}", Sha256::digest(fs::read(&path).unwrap()));
        // A PATH-resolved `env` would print "fallback" instead.
        let command: super::HostCommand = serde_json::from_value(serde_json::json!({
            "id": "status", "program": "env", "args": ["printf", "fallback"],
            "artifact": {"path": path, "sha256": sha256},
        }))
        .unwrap();
        assert_eq!(
            super::run_command(&command, None, Duration::from_secs(2)).await,
            Some("verified".into())
        );
        crate::test_executable::write_executable(&path, "#!/bin/sh\nprintf planted\n");
        assert_eq!(
            super::run_command(&command, None, Duration::from_secs(2)).await,
            None
        );
    }

    #[tokio::test]
    async fn stdin_is_exact_data_and_output_is_drained_concurrently() {
        let (_directory, path) = executable("printf 'prefix'; cat");
        let input = "$(touch injected)\nreview decision";
        assert_eq!(
            run_with_path(
                &path,
                &[],
                Duration::from_secs(1),
                &effective_path(),
                65536,
                Some(input)
            )
            .await,
            Some(format!("prefix{input}"))
        );
        let (_directory, path) = executable("head -c 16384 /dev/zero; cat");
        let input = "x".repeat(16384);
        let output = run_with_path(
            &path,
            &[],
            Duration::from_secs(2),
            &effective_path(),
            65536,
            Some(&input),
        )
        .await
        .unwrap();
        assert_eq!(output.len(), 32768);
    }

    #[tokio::test]
    async fn undeclared_and_oversized_input_do_not_launch_the_command() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("executed");
        let mut command: buzzodz_plugins::HostCommand = serde_json::from_value(serde_json::json!({
            "id": "review", "program": "touch", "args": [marker]
        }))
        .unwrap();
        assert_eq!(
            super::run_command(&command, Some("data"), Duration::from_secs(1)).await,
            None
        );
        command.max_input_bytes = Some(1);
        assert_eq!(
            super::run_command(&command, Some("data"), Duration::from_secs(1)).await,
            None
        );
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn passes_exact_args_without_shell_interpretation() {
        let (_directory, path) = executable(
            "[ \"$#\" -eq 2 ] && [ \"$1\" = status ] && [ \"$2\" = '--mode=ready;echo injected' ] || exit 1\nprintf 'ready \\n'",
        );
        assert_eq!(
            run(
                &path,
                &["status".into(), "--mode=ready;echo injected".into()],
                Duration::from_secs(1)
            )
            .await,
            Some("ready \n".into())
        );
    }

    #[tokio::test]
    async fn env_shebang_uses_the_path_that_resolved_the_command() {
        let directory = tempfile::tempdir().unwrap();
        let interpreter = directory.path().join("fixture-runtime");
        crate::test_executable::write_executable(&interpreter, "#!/bin/sh\nexec /bin/sh \"$@\"\n");
        let tool = directory.path().join("tool");
        crate::test_executable::write_executable(
            &tool,
            "#!/usr/bin/env fixture-runtime\nprintf 'ready\\n'\n",
        );
        let path =
            std::env::join_paths([Path::new("/usr/bin"), Path::new("/bin"), directory.path()])
                .unwrap();

        #[cfg(target_os = "macos")]
        assert_eq!(super::resolve_program("tool", &path), tool);
        assert_eq!(
            run_with_path(
                &tool,
                &[],
                Duration::from_secs(5),
                &path,
                super::DEFAULT_HOST_COMMAND_OUTPUT_BYTES,
                None
            )
            .await,
            Some("ready\n".into())
        );
    }

    #[tokio::test]
    async fn returns_none_for_failures_and_invalid_utf8() {
        let (_directory, path) = executable("echo 'private stderr' >&2; exit 1");
        assert_eq!(run(&path, &[], Duration::from_secs(1)).await, None);
        let (_directory, path) = executable("printf '\\377'");
        assert_eq!(run(&path, &[], Duration::from_secs(1)).await, None);
        assert_eq!(
            run(
                PathBuf::from("missing-tool-executable").as_path(),
                &[],
                Duration::from_secs(1)
            )
            .await,
            None
        );
    }

    #[tokio::test]
    async fn rejects_large_output_without_waiting_for_the_process() {
        let (_directory, path) = executable("yes x");
        let started = Instant::now();
        assert_eq!(run(&path, &[], Duration::from_secs(1)).await, None);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn kills_a_stalled_command_at_the_deadline() {
        let (_directory, path) = executable("sleep 10");
        let started = Instant::now();
        assert_eq!(run(&path, &[], Duration::from_millis(50)).await, None);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn aborting_the_read_kills_the_cli_process() {
        let (_directory, path) = executable("printf '%s' \"$$\" > \"$0.pid\"\nexec sleep 10");
        let marker = path.with_extension("pid");
        let reader = tokio::spawn(async move { run(&path, &[], Duration::from_secs(5)).await });
        let process_id = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Ok(process_id) = fs::read_to_string(&marker) {
                    if let Ok(process_id) = process_id.parse::<i32>() {
                        break process_id;
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("fake command did not start");

        reader.abort();
        assert!(reader.await.unwrap_err().is_cancelled());
        let exited = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let result =
                    unsafe { libc::waitpid(process_id, std::ptr::null_mut(), libc::WNOHANG) };
                if result == process_id
                    || (result == -1
                        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD))
                {
                    break;
                }
                assert_eq!(result, 0);
                tokio::task::yield_now().await;
            }
        })
        .await;
        if exited.is_err() {
            unsafe { libc::kill(-process_id, libc::SIGKILL) };
            unsafe { libc::waitpid(process_id, std::ptr::null_mut(), 0) };
        }
        assert!(exited.is_ok(), "aborted command left the child running");
    }

    #[tokio::test]
    async fn aborting_the_read_kills_descendants() {
        let (_directory, path) =
            executable("sleep 10 &\nprintf '%s' \"$!\" > \"$0.childpid\"\nwait");
        let marker = path.with_extension("childpid");
        let reader = tokio::spawn(async move { run(&path, &[], Duration::from_secs(5)).await });
        let process_id = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Ok(process_id) = fs::read_to_string(&marker) {
                    if let Ok(process_id) = process_id.parse::<i32>() {
                        break process_id;
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("descendant did not start");

        reader.abort();
        assert!(reader.await.unwrap_err().is_cancelled());
        let exited = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if unsafe { libc::kill(process_id, 0) } == -1
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        if exited.is_err() {
            unsafe { libc::kill(process_id, libc::SIGKILL) };
        }
        assert!(exited.is_ok(), "aborted command left a descendant running");
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::{effective_path, run, windows_job::WindowsJob};
    use std::fs;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::{Path, PathBuf};
    use std::process::Stdio;
    use std::time::Duration;
    use tokio::process::Command;
    use windows_sys::Win32::Foundation::{ERROR_INVALID_PARAMETER, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, ResumeThread, SuspendThread, TerminateProcess, WaitForSingleObject,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    fn command_script(directory: &Path) -> (PathBuf, PathBuf) {
        let script = directory.join("spawn-child.ps1");
        let marker = directory.join("child.pid");
        let marker_literal = marker.to_string_lossy().replace('\'', "''");
        fs::write(
            &script,
            format!(
                "$child = Start-Process -FilePath ping.exe -ArgumentList '-n 30 127.0.0.1' -PassThru -WindowStyle Hidden\n[System.IO.File]::WriteAllText('{marker_literal}', [string]$child.Id)\n$child.WaitForExit()\n"
            ),
        )
        .unwrap();
        (script, marker)
    }

    async fn descendant_id(marker: &Path) -> u32 {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if let Ok(process_id) = fs::read_to_string(marker) {
                    if let Ok(process_id) = process_id.parse::<u32>() {
                        break process_id;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("descendant did not start")
    }

    fn assert_descendant_exited(process_id: u32) {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, process_id) };
        if handle.is_null() {
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(ERROR_INVALID_PARAMETER as i32),
                "failed to inspect descendant"
            );
            return;
        }
        let process = unsafe { OwnedHandle::from_raw_handle(handle) };
        let result = unsafe { WaitForSingleObject(process.as_raw_handle(), 3_000) };
        if result != WAIT_OBJECT_0 {
            unsafe { TerminateProcess(process.as_raw_handle(), 1) };
        }
        assert_eq!(result, WAIT_OBJECT_0, "command left a descendant running");
    }

    #[tokio::test]
    async fn command_starts_only_after_job_assignment() {
        let directory = tempfile::tempdir().unwrap();
        let (script, marker) = command_script(directory.path());
        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                script.to_str().unwrap(),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let job = WindowsJob::new().unwrap();
        let child = job
            .spawn_with_check(&mut command, 0, |_, thread| {
                let previous_count = unsafe { SuspendThread(thread.as_raw_handle()) };
                let restored_count = unsafe { ResumeThread(thread.as_raw_handle()) };
                assert_eq!(previous_count, 1, "command ran before job assignment");
                assert_eq!(restored_count, 2);
                assert!(!marker.exists(), "command ran before job assignment");
            })
            .unwrap();
        let process_id = descendant_id(&marker).await;
        drop(job);
        assert_descendant_exited(process_id);
        drop(child);
    }

    #[tokio::test]
    async fn cancellation_kills_descendants() {
        let directory = tempfile::tempdir().unwrap();
        let (script, marker) = command_script(directory.path());
        let reader = tokio::spawn(async move {
            run(
                Path::new("powershell.exe"),
                &[
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                    "-File".into(),
                    script.to_string_lossy().into_owned(),
                ],
                Duration::from_secs(10),
                &effective_path(),
                super::DEFAULT_HOST_COMMAND_OUTPUT_BYTES,
                None,
            )
            .await
        });
        let process_id = descendant_id(&marker).await;
        reader.abort();
        assert!(reader.await.unwrap_err().is_cancelled());
        assert_descendant_exited(process_id);
    }

    #[tokio::test]
    async fn timeout_kills_descendants() {
        let directory = tempfile::tempdir().unwrap();
        let (script, marker) = command_script(directory.path());
        let reader = tokio::spawn(async move {
            run(
                Path::new("powershell.exe"),
                &[
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                    "-File".into(),
                    script.to_string_lossy().into_owned(),
                ],
                Duration::from_secs(5),
                &effective_path(),
                super::DEFAULT_HOST_COMMAND_OUTPUT_BYTES,
                None,
            )
            .await
        });
        let process_id = descendant_id(&marker).await;
        assert_eq!(reader.await.unwrap(), None);
        assert_descendant_exited(process_id);
    }
}
