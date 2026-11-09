//! Long-lived processes a plugin starts from its manifest's `host.processes`:
//! stdin stays open for the plugin, and stdout and stderr stream back as they
//! arrive. A process belongs to the plugin that started it and to the page that
//! asked; it is killed when the plugin asks, when the page reloads, or when the
//! app exits. A page that reloaded hears nothing of it after. It runs with the
//! user's own access, with optional native containment for protected workers.
mod artifact;
mod claude_hooks;
mod protection;
use artifact::verify_artifact;
use claude_hooks::ClaudeHooks;
use protection::ProcessProtection;

use crate::credential_service::{CredentialService, Issued, ProtectedLaunch};
use crate::host_command::{effective_path, load_login_shell_path, resolve_program};
use crate::{with_manager, PluginManager};
use buzzodz_plugins::{HostProcess, ProcessArtifact};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsStr;
#[cfg(unix)]
use std::os::unix::process::CommandExt as _;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::Manager as _;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::oneshot;

/// The agent a protection provider launches a process for.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProtectedAgent {
    pubkey: String,
    relay: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProcessMcpConnection {
    url: String,
    headers: Vec<ProcessMcpHeader>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProcessMcpHeader {
    name: String,
    value: String,
}

/// Processes alive at once across all plugins.
const MAX_PROCESSES: usize = 64;
/// One write to a process's stdin.
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const READ_BYTES: usize = 64 * 1024;
/// How long a process asked to stop has before it is killed outright.
const STOP_GRACE: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum ProcessEvent {
    Stdout {
        data: String,
    },
    Stderr {
        data: String,
    },
    /// The last event. `code` is absent when a signal ended it.
    Exit {
        code: Option<i32>,
    },
}

struct Entry {
    hooks: Option<ClaudeHooks>,
    plugin: String,
    /// Its process group, which is its own pid.
    #[cfg_attr(not(unix), allow(dead_code))]
    group: Option<u32>,
    stdin: Option<Arc<tokio::sync::Mutex<ChildStdin>>>,
    stop: Option<oneshot::Sender<()>>,
    /// Its Buzz credential, revoked once it exits and this entry goes.
    credential: Option<Arc<Issued>>,
    /// Tokens for its agents' tools, never its own environment; revoked with it.
    tools: Arc<ToolCredentials>,
    /// The agent a protection provider launched it for, if one did.
    launch: Option<ProtectedLaunch>,
}

/// One token per agent a shared host runs, each handed only to that agent's
/// tool processes.
#[derive(Default)]
struct ToolCredentials(Mutex<Option<Vec<ToolCredential>>>);
struct ToolCredential {
    pubkey: String,
    relay: String,
    issued: Issued,
    env: zeroize::Zeroizing<String>,
}
impl ToolCredentials {
    fn revoke(&self) {
        let mut held = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        for tool in held.take().unwrap_or_default() {
            tool.issued.revoke();
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct HostProcesses {
    inner: Arc<Mutex<Registry>>,
}
#[derive(Default)]
struct Registry {
    next: u64,
    /// Counts page loads, so a spawn the page asked for before it reloaded is
    /// refused rather than left running with nobody listening.
    page: u64,
    entries: HashMap<u64, Entry>,
}
impl HostProcesses {
    fn registry(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    fn owned<T>(
        &self,
        plugin: &str,
        handle: u64,
        take: impl FnOnce(&mut Entry) -> T,
    ) -> Result<T, String> {
        let mut registry = self.registry();
        match registry.entries.get_mut(&handle) {
            Some(entry) if entry.plugin == plugin => Ok(take(entry)),
            _ => Err("No such process".into()),
        }
    }
    /// The current page load, for `start`.
    pub(crate) fn page(&self) -> u64 {
        self.registry().page
    }
    /// Starts `command`, owned by `plugin`, and streams its output to `on_event`,
    /// unless the page that asked during `page` has since gone.
    #[cfg(all(test, unix))]
    fn start(
        &self,
        page: u64,
        plugin: String,
        program: &str,
        command: Command,
        credential: Option<Issued>,
        on_event: Channel<ProcessEvent>,
    ) -> Result<u64, String> {
        self.start_guarded(
            page, plugin, program, command, credential, on_event, None, false, None,
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn start_guarded(
        &self,
        page: u64,
        plugin: String,
        program: &str,
        mut command: Command,
        credential: Option<Issued>,
        on_event: Channel<ProcessEvent>,
        read_lease: Option<crate::host_files::FileReadLease>,
        claude_hooks: bool,
        launch: Option<ProtectedLaunch>,
    ) -> Result<u64, String> {
        let state = self.clone();
        let credential = credential.map(Arc::new);
        let tools = Arc::new(ToolCredentials(Mutex::new(Some(Vec::new()))));
        let mut registry = self.registry();
        if registry.page != page {
            return Err("The page reloaded".into());
        }
        if registry.entries.len() >= MAX_PROCESSES {
            return Err("Too many processes are running".into());
        }
        // A job, unlike killing the child, also ends the helpers it starts.
        #[cfg(windows)]
        let job = crate::host_command::windows_job::WindowsJob::new()
            .ok_or_else(|| format!("Could not start {program}"))?;
        #[cfg(windows)]
        let mut child = job
            .spawn_hidden(&mut command)
            .map_err(|error| format!("Could not start {program}: {error}"))?;
        #[cfg(not(windows))]
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start {program}: {error}"))?;
        let handle = registry.next;
        let hooks = if claude_hooks {
            Some(ClaudeHooks::new(
                child.id().ok_or("Claude has no process group")?,
            ))
        } else {
            None
        };
        registry.next += 1;
        let (stop, stopped) = oneshot::channel();
        registry.entries.insert(
            handle,
            Entry {
                hooks: hooks.clone(),
                plugin,
                group: child.id(),
                stdin: child
                    .stdin
                    .take()
                    .map(|stdin| Arc::new(tokio::sync::Mutex::new(stdin))),
                stop: Some(stop),
                credential: credential.clone(),
                tools: tools.clone(),
                launch,
            },
        );
        drop(registry);

        let (gone, reader_gone) = oneshot::channel::<()>();
        let gone = Arc::new(Mutex::new(Some(gone)));
        let readers = [
            child.stdout.take().map(|out| {
                forward(
                    out,
                    Stream::Stdout,
                    on_event.clone(),
                    gone.clone(),
                    hooks.clone(),
                )
            }),
            child
                .stderr
                .take()
                .map(|err| forward(err, Stream::Stderr, on_event.clone(), gone.clone(), None)),
        ];
        #[cfg(unix)]
        let group = child.id().map(|pid| pid as i32);
        tauri::async_runtime::spawn(async move {
            let mut stopped = stopped;
            let mut reader_gone = reader_gone;
            let status = tokio::select! {
                status = child.wait() => status.ok(),
                _ = async {
                    // Only a sent signal counts: a closed pipe drops its sender,
                    // and a process may close its output and carry on.
                    tokio::select! {
                        Ok(()) = &mut stopped => {},
                        Ok(()) = &mut reader_gone => {},
                        else => std::future::pending::<()>().await,
                    }
                } => {
                    #[cfg(unix)]
                    if let Some(group) = group {
                        unsafe { libc::kill(-group, libc::SIGTERM) };
                    }
                    #[cfg(windows)]
                    job.terminate(STOP_GRACE).await;
                    match tokio::time::timeout(STOP_GRACE, child.wait()).await {
                        Ok(status) => status.ok(),
                        Err(_) => {
                            let _ = child.start_kill();
                            child.wait().await.ok()
                        }
                    }
                }
            };
            // Its token dies with it, even while a descendant that left its
            // group still holds the pipes or the environment.
            if let Some(credential) = &credential {
                credential.revoke();
            }
            tools.revoke();
            if let Some(hooks) = &hooks {
                hooks.close();
            }
            // Descendants that outlived it go with it.
            #[cfg(unix)]
            if let Some(group) = group {
                unsafe { libc::kill(-group, libc::SIGKILL) };
            }
            #[cfg(windows)]
            job.terminate(STOP_GRACE).await;
            for reader in readers.into_iter().flatten() {
                let _ = reader.await;
            }
            let mut registry = state.registry();
            registry.entries.remove(&handle);
            // A page that reloaded is told nothing: it stopped the process by
            // going, and may run until it unloads, taking the exit for a failure.
            let reloaded = registry.page != page;
            drop(registry);
            // The child and all output readers have actually settled. Release before
            // Exit so a caller awaiting its complete byte snapshot can then delete.
            drop(read_lease);
            if !reloaded {
                let _ = on_event.send(ProcessEvent::Exit {
                    code: status.and_then(|status| status.code()),
                });
            }
        });
        Ok(handle)
    }
    async fn write(
        &self,
        plugin: &str,
        handle: u64,
        data: String,
        close: bool,
    ) -> Result<(), String> {
        if data.len() > MAX_WRITE_BYTES {
            return Err("Write is too large".into());
        }
        let (stdin, hooks) = self.owned(plugin, handle, |entry| {
            (
                if close {
                    entry.stdin.take()
                } else {
                    entry.stdin.clone()
                },
                entry.hooks.clone(),
            )
        })?;
        let stdin = stdin.ok_or("The process input is closed")?;
        let mut stdin = stdin.lock().await;
        if let Some(hooks) = &hooks {
            hooks.input(data.as_bytes())?;
        }
        let written = async {
            stdin.write_all(data.as_bytes()).await?;
            stdin.flush().await
        };
        let result = written.await;
        if result.is_err() {
            if let Some(hooks) = hooks {
                hooks.trip();
            }
        }
        result.map_err(|_| "The process is not reading its input".into())
    }
    fn kill(&self, plugin: &str, handle: u64) -> Result<(), String> {
        if let Some(stop) = self.owned(plugin, handle, |entry| {
            entry.stdin = None;
            entry.stop.take()
        })? {
            let _ = stop.send(());
        }
        Ok(())
    }
    /// Stops every process, without telling the page: it is gone.
    pub(crate) fn stop_all(&self) {
        let mut registry = self.registry();
        registry.page += 1;
        for entry in registry.entries.values_mut() {
            entry.stdin = None;
            if let Some(stop) = entry.stop.take() {
                let _ = stop.send(());
            }
        }
    }
    /// Kills every process group at once: the app is exiting, and its async
    /// tasks will not run again to stop them. On Windows each process's job
    /// kills it when the app's handle to the job closes.
    pub(crate) fn shutdown(&self) {
        self.stop_all();
        #[cfg(unix)]
        for group in self
            .registry()
            .entries
            .values()
            .filter_map(|entry| entry.group)
        {
            unsafe { libc::kill(-(group as i32), libc::SIGKILL) };
        }
    }
}

#[derive(Clone, Copy)]
enum Stream {
    Stdout,
    Stderr,
}

/// Starts the declared process `process_id` with `args` after its declared
/// arguments. `env` adds variables (`null` removes one) to the app's own
/// environment, less any Buzz identity: an agent's key never leaves the app.
/// `secrets` names native-held secrets set after `env`, each only for the
/// processes it belongs to; a secret that is not saved is left unset.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn plugin_host_process_spawn<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    manager: tauri::State<'_, PluginManager>,
    processes: tauri::State<'_, HostProcesses>,
    id: String,
    revision: String,
    process_id: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, Option<String>>>,
    on_event: Channel<ProcessEvent>,
    mcp: Option<ProcessMcpConnection>,
    protection: Option<ProcessProtection>,
    agent_credential: Option<bool>,
    protected_agent: Option<ProtectedAgent>,
    secrets: Option<Vec<String>>,
) -> Result<u64, String> {
    // Any plugin process with either ID conservatively blocks managed deletion
    // app-wide, regardless of program/path. Attachment adapters use these IDs.
    // Reserve before awaits; the actual child/output monitor owns the lease.
    let read_lease = matches!(process_id.as_str(), "read" | "read-protected")
        .then(crate::host_files::FileReadLease::new)
        .transpose()?;
    let page = processes.page();
    let plugin = id.clone();
    let (declared, registry) = with_manager(manager, move |manager| {
        let registry = manager.storage_root().to_path_buf();
        manager
            .host_grants(&id, &revision)?
            .processes
            .into_iter()
            .find(|process| process.id == process_id)
            .ok_or_else(|| "Process is not declared".into())
            .map(|declared| (declared, registry))
    })
    .await?;
    if args.len() > 256 || args.iter().any(|arg| arg.contains('\0')) {
        return Err("Invalid process arguments".into());
    }
    let protected = protection.is_some();
    if protected {
        if !cfg!(target_os = "macos") {
            return Err("Protected workers require macOS".into());
        }
        // HMR sources are mutable outside the native-owned application bundle.
        if tauri::is_dev() {
            return Err("Use a packaged Buzz build for protected workers; development frontends are mutable".into());
        }
    }
    load_login_shell_path().await;
    let path = effective_path();
    let controls = if protected {
        Some(
            app.state::<crate::agent_state::AgentState>()
                .agents_root()?
                .to_path_buf(),
        )
    } else {
        None
    };
    let resources = app.path().resource_dir().ok();
    let descriptor = at_home(declared.clone())?;
    let launch_path = path.clone();
    let store = controls.as_ref().map(|root| root.join("artifacts"));
    // Native engines can be hundreds of MB; read/hash/copy off the async runtime.
    let program = tauri::async_runtime::spawn_blocking(move || {
        if let Some(store) = store {
            protected_program_path(&descriptor, || resources, &store)
        } else {
            program_path(&descriptor, || resources, &launch_path)
        }
    })
    .await
    .map_err(|_| "Artifact preparation failed")??;
    let artifact_parent = declared.artifact.as_ref().map(|_| {
        program
            .parent()
            .expect("absolute artifact path has a parent")
            .to_path_buf()
    });
    let helper = if mcp.is_some() {
        let resources = app.path().resource_dir().map_err(|_| "No app resources")?;
        Some(resources.join("bin").join(if cfg!(windows) {
            "buzz-agent-command.exe"
        } else {
            "buzz-agent-command"
        }))
    } else {
        None
    };
    let claude_hooks = runs_protected_claude(&plugin, &declared.id, protected);
    let mut command = if let Some(protection) = protection {
        let protection = protection.at_home()?;
        let controls = controls.ok_or("Agent controls are unavailable")?;
        std::fs::create_dir_all(&controls).map_err(|_| "Agent controls are unavailable")?;
        let executable =
            std::env::current_exe().map_err(|_| "Application executable is unavailable")?;
        let bundle = executable
            .ancestors()
            .find(|p| p.extension().is_some_and(|extension| extension == "app"))
            .map(std::path::Path::to_path_buf)
            .unwrap_or(executable);
        let mut protected_roots = vec![controls, bundle, registry];
        if let Some(parent) = artifact_parent {
            protected_roots.push(parent);
        }
        let profile = protection.profile(&protected_roots)?;
        process_command(
            &program,
            helper.as_deref(),
            Some(&profile),
            &declared.args,
            &args,
        )
    } else {
        process_command(&program, helper.as_deref(), None, &declared.args, &args)
    };
    let environment = env.unwrap_or_default();
    set_environment(
        &mut command,
        &path,
        &environment,
        &app.package_info().version.to_string(),
    )?;
    if protected {
        for name in std::env::vars_os()
            .map(|(name, _)| name)
            .chain(environment.keys().map(std::ffi::OsString::from))
        {
            let text = name.to_string_lossy();
            if matches!(
                text.as_ref(),
                "BASH_ENV" | "ENV" | "NODE_OPTIONS" | "NODE_PATH"
            ) || text.starts_with("LD_")
                || text.starts_with("DYLD_")
            {
                command.env_remove(name);
            }
        }
    }
    for secret in secrets.unwrap_or_default() {
        if secret != crate::claude_key::SECRET
            || !crate::claude_key::may_have(&plugin, &declared.id)
        {
            return Err("That secret is not available to this process".into());
        }
        if let Some(key) = app.state::<crate::claude_key::ClaudeKey>().key().await? {
            command.env(crate::claude_key::ENV, &*key);
        }
    }
    if let Some(mcp) = mcp {
        command.env(
            "BUZZ_AGENT_CONNECTION",
            serde_json::to_string(&mcp).map_err(|error| error.to_string())?,
        );
    }
    // Only a protected process may be launched for an agent, and only by the
    // provider that agent's saved protection names.
    let launch = match protected_agent {
        Some(_) if !protected => {
            return Err("Only a protected process is launched for an agent".into())
        }
        Some(agent) => Some(
            app.state::<CredentialService>()
                .protected_launch(&plugin, agent.pubkey, agent.relay)
                .await?,
        ),
        None => None,
    };
    // Acts for nobody until `plugin_host_process_bind_agent` names its agent.
    let credential = match agent_credential {
        Some(true) => app.state::<CredentialService>().issue().await?,
        _ => None,
    };
    let credential = credential.map(|(issued, env)| {
        command.env(crate::credential_service::ENV, &*env);
        issued
    });
    if let Some(cwd) = cwd {
        let directory = expand_home(&cwd)?;
        std::fs::create_dir_all(&directory)
            .map_err(|_| "Could not create the process directory")?;
        command.current_dir(directory);
    }
    #[cfg(unix)]
    command.as_std_mut().process_group(0);

    processes.start_guarded(
        page,
        plugin,
        &declared.program,
        command,
        credential,
        on_event,
        read_lease,
        claude_hooks,
        launch,
    )
}

/// Sets a process's environment: the app's own, less any Buzz identity it was
/// started with, plus the plugin's `environment` (`None` removes a variable).
/// `BUZZ_VERSION` is always this app's version, so a command can tell it runs
/// under Buzz.
fn set_environment(
    command: &mut Command,
    path: &OsStr,
    environment: &HashMap<String, Option<String>>,
    version: &str,
) -> Result<(), String> {
    // Never pass on an identity the app itself was started with.
    for (name, _) in std::env::vars_os() {
        let text = name.to_string_lossy();
        if text.starts_with("BUZZ_") || text.starts_with("NOSTR_") {
            command.env_remove(&name);
        }
    }
    command.env("PATH", path);
    for (name, value) in environment {
        if name.is_empty() || name.contains(['=', '\0']) {
            return Err("Invalid environment variable".into());
        }
        match value {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
    command.env("BUZZ_VERSION", version);
    Ok(())
}

/// The verified target stays inside the MCP prefix and the same containment.
fn process_command(
    program: &std::path::Path,
    helper: Option<&std::path::Path>,
    profile: Option<&str>,
    declared_args: &[String],
    args: &[String],
) -> Command {
    let executable = helper.unwrap_or(program);
    let mut command = if let Some(profile) = profile {
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command.args(["-p", profile]).arg(executable);
        command
    } else {
        Command::new(executable)
    };
    if helper.is_some() {
        command.arg("--launch").arg(program);
    }
    command
        .args(declared_args)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

/// Writes `data` to the process's stdin; `close` then ends its input.
#[tauri::command]
pub(crate) async fn plugin_host_process_write(
    processes: tauri::State<'_, HostProcesses>,
    id: String,
    handle: u64,
    data: String,
    close: bool,
) -> Result<(), String> {
    processes.write(&id, handle, data, close).await
}

/// Lets a process spawned with an agent credential act as that agent, once:
/// a spare harness process is bound when an agent takes it.
#[tauri::command]
pub(crate) async fn plugin_host_process_bind_agent(
    processes: tauri::State<'_, HostProcesses>,
    credentials: tauri::State<'_, CredentialService>,
    id: String,
    handle: u64,
    pubkey: String,
    relay: String,
) -> Result<(), String> {
    // None was issued where there is no transport (Windows): nothing to bind.
    let (credential, launch) = processes.owned(&id, handle, |entry| {
        (entry.credential.clone(), entry.launch.clone())
    })?;
    match credential {
        Some(issued) => {
            credentials
                .bind(&issued, &id, launch.as_ref(), pubkey, relay)
                .await
        }
        None => Ok(()),
    }
}

/// The environment value that lets this agent's tools, run by a host shared
/// by several agents, act as it; the same one for every call. It is revoked
/// once the host exits. None where there is no transport (Windows).
#[tauri::command]
pub(crate) async fn plugin_host_process_tool_credential(
    processes: tauri::State<'_, HostProcesses>,
    credentials: tauri::State<'_, CredentialService>,
    id: String,
    handle: u64,
    pubkey: String,
    relay: String,
) -> Result<Option<String>, String> {
    processes
        .tool_credential(&credentials, &id, handle, pubkey, relay)
        .await
}

impl HostProcesses {
    async fn tool_credential(
        &self,
        credentials: &CredentialService,
        id: &str,
        handle: u64,
        pubkey: String,
        relay: String,
    ) -> Result<Option<String>, String> {
        self.tool_credential_after_miss(credentials, id, handle, pubkey, relay, async {})
            .await
    }

    /// [`Self::tool_credential`], awaiting `after_miss` once no current token
    /// was found, so a test can hold competing callers past that point.
    async fn tool_credential_after_miss(
        &self,
        credentials: &CredentialService,
        id: &str,
        handle: u64,
        pubkey: String,
        relay: String,
        after_miss: impl std::future::Future<Output = ()>,
    ) -> Result<Option<String>, String> {
        let (tools, launch) = self.owned(id, handle, |entry| {
            (entry.tools.clone(), entry.launch.clone())
        })?;
        // A protected host's tokens all act for the agent it was launched
        // for, under its protection then: once that changes, none acts again.
        let protection_current = match &launch {
            Some(launch) => credentials.launch_current(launch).await,
            None => true,
        };
        // This agent's token, if it still acts. One outlived by the agent's
        // removal and re-adding, or by a sign-out, is dropped, which revokes it
        // for good, so a fresh one is issued for the agent as it is now.
        let current = |list: &mut Vec<ToolCredential>| {
            list.retain(|tool| {
                tool.pubkey != pubkey
                    || tool.relay != relay
                    || (protection_current && credentials.acts(&tool.issued))
            });
            list.iter()
                .find(|tool| tool.pubkey == pubkey && tool.relay == relay)
                .map(|tool| tool.env.to_string())
        };
        {
            let mut guard = tools.0.lock().unwrap_or_else(|poison| poison.into_inner());
            if let Some(env) = current(guard.as_mut().ok_or("The process has exited")?) {
                return Ok(Some(env));
            }
        }
        after_miss.await;
        let Some((issued, env)) = credentials.issue().await? else {
            return Ok(None);
        };
        credentials
            .bind(&issued, id, launch.as_ref(), pubkey.clone(), relay.clone())
            .await
            .inspect_err(|_| issued.revoke())?;
        let mut guard = tools.0.lock().unwrap_or_else(|poison| poison.into_inner());
        let Some(list) = guard.as_mut() else {
            issued.revoke();
            return Err("The process has exited".into());
        };
        // A concurrent call for the same agent won: keep one token.
        if let Some(env) = current(list) {
            issued.revoke();
            return Ok(Some(env));
        }
        let value = env.to_string();
        list.push(ToolCredential {
            pubkey,
            relay,
            issued,
            env,
        });
        Ok(Some(value))
    }
}

/// Asks the process to stop, then kills it and its descendants. Its `exit`
/// event follows.
#[tauri::command]
pub(crate) fn plugin_host_process_kill(
    processes: tauri::State<'_, HostProcesses>,
    id: String,
    handle: u64,
) -> Result<(), String> {
    processes.kill(&id, handle)
}

/// Streams one pipe to the page as text. A page that stops listening stops
/// the process too.
fn forward(
    mut pipe: impl AsyncRead + Unpin + Send + 'static,
    stream: Stream,
    channel: Channel<ProcessEvent>,
    gone: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    hooks: Option<ClaudeHooks>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut buffer = vec![0; READ_BYTES];
        let mut pending = Vec::new();
        loop {
            let read = match pipe.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            pending.extend_from_slice(&buffer[..read]);
            if let Some(hooks) = &hooks {
                if let Err(reason) = hooks.output(&buffer[..read]) {
                    // The guard has killed the worker; say why before it exits.
                    if reason != claude_hooks::STOPPED {
                        let _ = channel.send(ProcessEvent::Stderr {
                            data: format!("{reason}\n"),
                        });
                    }
                    break;
                }
            }
            let data = take_text(&mut pending);
            if data.is_empty() {
                continue;
            }
            let event = match stream {
                Stream::Stdout => ProcessEvent::Stdout { data },
                Stream::Stderr => ProcessEvent::Stderr { data },
            };
            if channel.send(event).is_err() {
                if let Some(gone) = gone
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take()
                {
                    let _ = gone.send(());
                }
                break;
            }
        }
    })
}

/// The complete UTF-8 text in `pending`, leaving a character split across
/// reads for the next one. Invalid bytes become U+FFFD.
fn take_text(pending: &mut Vec<u8>) -> String {
    let complete = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        // An incomplete trailing sequence waits for its remaining bytes.
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        Err(_) => pending.len(),
    };
    let rest = pending.split_off(complete);
    let text = String::from_utf8_lossy(pending).into_owned();
    *pending = rest;
    text
}

/// Only the protected Claude CLI speaks the hook protocol; the plugin's other
/// protected workers, such as its file reader, print arbitrary output.
fn runs_protected_claude(plugin: &str, process_id: &str, protected: bool) -> bool {
    protected
        && plugin == "buzz.claude-code"
        && matches!(
            process_id,
            "claude-protected-arm64" | "claude-protected-x64"
        )
}

/// A host command's artifact, verified where it is installed, as an
/// uncontained process's is.
pub(crate) fn verified_artifact(mut artifact: ProcessArtifact) -> Result<PathBuf, String> {
    artifact.path = expand_home(&artifact.path)?.to_string_lossy().into_owned();
    verify_artifact(&artifact)
}

/// A manifest may place an artifact under the user's home, written `~/…`.
fn at_home(mut declared: HostProcess) -> Result<HostProcess, String> {
    if let Some(artifact) = &mut declared.artifact {
        artifact.path = expand_home(&artifact.path)?.to_string_lossy().into_owned();
    }
    Ok(declared)
}

/// An absolute directory, or one under the user's home written `~/…`.
/// Where a declared program runs from. A bundled one is in the app's `bin`
/// resources, which `tauri dev` also copies beside the debug executable, and is
/// never looked up on `path`. Windows adds `.exe` to a path itself.
fn program_path(
    declared: &HostProcess,
    resources: impl FnOnce() -> Option<PathBuf>,
    path: &OsStr,
) -> Result<PathBuf, String> {
    if let Some(artifact) = &declared.artifact {
        return verify_artifact(artifact);
    }
    if !declared.bundled {
        return Ok(resolve_program(&declared.program, path));
    }
    let resources = resources().ok_or_else(|| format!("Could not start {}", declared.program))?;
    Ok(resources.join("bin").join(&declared.program))
}

/// Contained launches never resolve an executable on a worker-writable PATH.
fn protected_program_path(
    declared: &HostProcess,
    resources: impl FnOnce() -> Option<PathBuf>,
    store: &std::path::Path,
) -> Result<PathBuf, String> {
    if let Some(artifact) = &declared.artifact {
        return artifact::snapshot(artifact, store);
    }
    if !declared.bundled {
        return Err("Protected processes require a declared artifact or bundled executable".into());
    }
    program_path(declared, resources, OsStr::new(""))
}

/// The rest of a path written `~/…`, or on Windows also `~\…`.
pub(crate) fn under_home(path: &str) -> Option<&str> {
    path.strip_prefix("~/")
        .or_else(|| path.strip_prefix("~\\").filter(|_| cfg!(windows)))
}

pub(crate) fn expand_home(directory: &str) -> Result<PathBuf, String> {
    let path = if directory == "~" {
        home()?
    } else if let Some(rest) = under_home(directory) {
        home()?.join(rest)
    } else {
        PathBuf::from(directory)
    };
    if !path.is_absolute() {
        return Err("The process directory must be absolute".into());
    }
    Ok(path)
}
fn home() -> Result<PathBuf, String> {
    // Windows' own profile folder, never a `HOME` another tool set, such as
    // Git for Windows' `/c/Users/…`.
    #[cfg(windows)]
    let order = ["USERPROFILE", "HOME"];
    #[cfg(not(windows))]
    let order = ["HOME", "USERPROFILE"];
    order
        .into_iter()
        .find_map(std::env::var_os)
        .map(PathBuf::from)
        .ok_or_else(|| "No home directory".into())
}

#[cfg(test)]
mod tests;
