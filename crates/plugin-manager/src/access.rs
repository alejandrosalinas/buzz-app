//! Repository access rules: a local JSON file, beside the profile folders, that says which
//! repository sources Git reads over which SSH user and agent socket. Imports never read the
//! user's Git or SSH configuration, so this file is the only way to declare such access.
//! A rule can change only the scheme, the SSH user and the agent socket; the host, port and
//! path stay as the user entered them.
use crate::{managed::read_file, Result};
pub use schema::Platform;
use schema::{parse, Rule};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

mod schema;

pub const FILE_NAME: &str = "repository-access.json";
pub const PATH_ENV: &str = "BUZZ_REPOSITORY_ACCESS";
/// Rules a distributor compiles in as the defaults, in the file's schema; `build.rs`
/// validates it, and empty means no default rules.
const BUILD_RULES: &str = env!("BUZZ_BUILD_REPOSITORY_ACCESS");
const MAX_BYTES: u64 = 64 * 1024;

impl Platform {
    pub fn current() -> Option<Self> {
        if cfg!(target_os = "macos") {
            Some(Self::Macos)
        } else if cfg!(target_os = "linux") {
            Some(Self::Linux)
        } else if cfg!(windows) {
            Some(Self::Windows)
        } else {
            None
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    Absent,
    /// The file as a whole cannot be used; only the built-in rules apply.
    Invalid {
        reason: String,
    },
    Ready,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccessRules {
    rules: Vec<Rule>,
    pub problems: Vec<String>,
    pub path: Option<PathBuf>,
    pub status: Status,
}

/// The build's default rules, tried after the file's.
fn built_in_rules() -> Vec<Rule> {
    rules_from_build(BUILD_RULES)
}

fn rules_from_build(raw: &str) -> Vec<Rule> {
    if raw.is_empty() {
        return vec![];
    }
    let file = parse(raw).expect("build.rs validates BUZZ_BUILD_REPOSITORY_ACCESS");
    file.rules
        .into_iter()
        .map(|rule| Rule {
            built_in: true,
            ..rule
        })
        .collect()
}

pub fn built_in() -> AccessRules {
    AccessRules {
        rules: built_in_rules(),
        problems: vec![],
        path: None,
        status: Status::Absent,
    }
}

/// `BUZZ_REPOSITORY_ACCESS` when set, otherwise the file beside the profile folders. Never
/// fails: an unusable file leaves the build's default rules in place and reports why.
pub fn load(root: &Path, env: Option<OsString>) -> AccessRules {
    load_with(root, env, built_in_rules())
}

fn load_with(root: &Path, env: Option<OsString>, defaults: Vec<Rule>) -> AccessRules {
    let mut access = AccessRules {
        rules: defaults.clone(),
        problems: vec![],
        path: None,
        status: Status::Absent,
    };
    let path = match env.filter(|value| !value.is_empty()) {
        Some(value) if Path::new(&value).is_absolute() => PathBuf::from(value),
        Some(_) => {
            access.status = Status::Invalid {
                reason: format!("{PATH_ENV} must be an absolute path"),
            };
            return access;
        }
        None => root.join(FILE_NAME),
    };
    access.path = Some(path.clone());
    let parsed = match read_file(&path, "Repository access file", MAX_BYTES) {
        Ok(None) => return access,
        Ok(Some(text)) => parse(&text),
        Err(reason) => Err(reason),
    };
    match parsed {
        Ok(file) => {
            access.rules = file.rules;
            if file.built_in_rules {
                access.rules.extend(defaults);
            }
            access.problems = file.problems;
            access.status = Status::Ready;
        }
        Err(reason) => access.status = Status::Invalid { reason },
    }
    access
}

/// The clone URL and agent socket Git uses for a source; the saved source is unchanged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transport {
    pub clone_url: String,
    /// `None` keeps the process's inherited `SSH_AUTH_SOCK`.
    pub ssh_auth_sock: Option<PathBuf>,
    /// `<host><pathPrefix>` of the rule that matched, for diagnostics.
    pub rule: Option<String>,
}

impl AccessRules {
    /// `repository` must already be accepted by `imports::repository_url`.
    pub fn resolve(
        &self,
        repository: &str,
        relay_authorized: bool,
        home: &Path,
    ) -> Result<Transport> {
        let inherited_agent =
            std::env::var_os("SSH_AUTH_SOCK").is_some_and(|socket| !socket.is_empty());
        self.resolve_for(
            repository,
            relay_authorized,
            home,
            Platform::current(),
            inherited_agent,
        )
    }
    fn resolve_for(
        &self,
        repository: &str,
        relay_authorized: bool,
        home: &Path,
        platform: Option<Platform>,
        inherited_agent: bool,
    ) -> Result<Transport> {
        let direct = Transport {
            clone_url: repository.into(),
            ssh_auth_sock: None,
            rule: None,
        };
        let url = url::Url::parse(repository).map_err(crate::err)?;
        // Git decodes SSH paths, so `%2F..` could leave the prefix after it was checked.
        let (Some(host), false) = (url.host_str(), url.path().contains('%')) else {
            return Ok(direct);
        };
        for rule in &self.rules {
            let platform_matches = rule
                .platforms
                .as_ref()
                .is_none_or(|platforms| platform.is_some_and(|p| platforms.contains(&p)));
            if !platform_matches
                || !host.eq_ignore_ascii_case(&rule.host)
                || !url.path().starts_with(&rule.path_prefix)
            {
                continue;
            }
            let ssh = url.scheme() == "ssh"
                && url.username() == rule.ssh_user
                && url.port().is_none_or(|port| port == 22);
            let https = url.scheme() == "https" && url.port().is_none();
            // The first matching rule decides an HTTPS source, so an SSH-only file rule
            // overrides a later rewrite. Relay authorization is an HTTP header scoped to the
            // entered URL; SSH would drop it.
            if https && (!rule.rewrite_https || relay_authorized) {
                return Ok(direct);
            }
            if !(ssh || https) {
                continue;
            }
            let ssh_auth_sock = match &rule.ssh_agent_socket {
                Some(socket) => match agent_socket(socket, home)? {
                    Some(path) => Some(path),
                    None => continue,
                },
                None if inherited_agent => None,
                // Without an agent the SSH read would fail where anonymous HTTPS may succeed.
                None => continue,
            };
            return Ok(Transport {
                clone_url: if https {
                    format!("ssh://{}@{host}{}", rule.ssh_user, url.path())
                } else {
                    repository.into()
                },
                ssh_auth_sock,
                rule: Some(format!("{}{}", rule.host, rule.path_prefix)),
            });
        }
        Ok(direct)
    }
}

/// `None` when nothing exists at the path, so the rule does not apply.
fn agent_socket(socket: &str, home: &Path) -> Result<Option<PathBuf>> {
    let path = match socket.strip_prefix("~/") {
        Some(relative) => home.join(relative),
        None => PathBuf::from(socket),
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        match std::fs::metadata(&path) {
            Ok(metadata) if metadata.file_type().is_socket() => Ok(Some(path)),
            Ok(_) => Err(format!(
                "SSH agent path is not a socket: {}",
                path.display()
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!(
                "Cannot read SSH agent socket {}: {error}",
                path.display()
            )),
        }
    }
    // Rules with sockets are dropped when loading on Windows.
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(None)
    }
}

impl AccessRules {
    /// The text `buzzodz plugin access [URL]` prints. Fails only for a URL imports reject.
    pub fn describe(&self, repository: Option<&str>, home: &Path) -> Result<String> {
        use std::fmt::Write as _;

        let repository = repository.map(crate::imports::repository_url).transpose()?;
        let path = self
            .path
            .as_ref()
            .map_or("none".into(), |path| path.display().to_string());
        let status = match &self.status {
            Status::Absent => "absent".into(),
            Status::Invalid { reason } => format!("unusable: {reason}"),
            Status::Ready => "ready".into(),
        };
        let mut text = format!("File: {path} ({status})\n");
        for problem in &self.problems {
            let _ = writeln!(text, "Problem: {problem}");
        }
        text.push_str("Rules, in the order they are tried:\n");
        for rule in &self.rules {
            let agent = rule
                .ssh_agent_socket
                .as_ref()
                .map_or("inherited agent".into(), |socket| format!("agent {socket}"));
            let https = if rule.rewrite_https {
                "HTTPS read over SSH"
            } else {
                "SSH only"
            };
            let platforms = rule
                .platforms
                .as_ref()
                .map_or("all platforms".into(), |platforms| {
                    platforms
                        .iter()
                        .map(|platform| match platform {
                            Platform::Macos => "macos",
                            Platform::Linux => "linux",
                            Platform::Windows => "windows",
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                });
            let origin = if rule.built_in { " (built in)" } else { "" };
            let _ = writeln!(
                text,
                "  {}{} as {}, {agent}, {https}, {platforms}{origin}",
                rule.host, rule.path_prefix, rule.ssh_user
            );
        }
        if let Some(repository) = repository {
            let _ = writeln!(text, "URL: {repository}");
            match self.resolve(&repository, false, home) {
                Ok(transport) => {
                    let _ = writeln!(
                        text,
                        "Rule: {}\nGit reads: {}\nAgent socket: {}",
                        transport.rule.as_deref().unwrap_or("none"),
                        transport.clone_url,
                        transport
                            .ssh_auth_sock
                            .as_ref()
                            .map_or("inherited".into(), |socket| socket.display().to_string())
                    );
                }
                Err(error) => {
                    let _ = writeln!(text, "Error: {error}");
                }
            }
        }
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::schema::*;
    use super::*;
    use std::fs;

    /// A distributor's `BUZZ_BUILD_REPOSITORY_ACCESS`.
    const BUILD: &str = r#"{"version": 1, "rules": [{"host": "github.com", "pathPrefix": "/example-org/", "sshUser": "org-1", "sshAgentSocket": "~/Library/Application Support/example-ssh-agent/agent.sock", "platforms": ["macos"]}]}"#;
    fn built_in_rules() -> Vec<Rule> {
        rules_from_build(BUILD)
    }
    fn built_in() -> AccessRules {
        AccessRules {
            rules: built_in_rules(),
            ..super::built_in()
        }
    }
    fn load(root: &Path, env: Option<OsString>) -> AccessRules {
        load_with(root, env, built_in_rules())
    }

    fn rule(host: &str, prefix: &str, user: &str) -> Rule {
        Rule {
            host: host.into(),
            path_prefix: prefix.into(),
            ssh_user: user.into(),
            ssh_agent_socket: None,
            rewrite_https: true,
            platforms: None,
            built_in: false,
        }
    }
    fn problems(text: &str) -> Vec<String> {
        parse(text).unwrap().problems
    }

    fn access(text: &str) -> AccessRules {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join(FILE_NAME), text).unwrap();
        load(root.path(), None)
    }
    fn direct(repository: &str) -> Transport {
        Transport {
            clone_url: repository.into(),
            ssh_auth_sock: None,
            rule: None,
        }
    }
    const ORG_SOCKET: &str = "Library/Application Support/example-ssh-agent/agent.sock";
    #[cfg(unix)]
    fn agent(path: &Path) -> std::os::unix::net::UnixListener {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::os::unix::net::UnixListener::bind(path).unwrap()
    }
    fn macos(access: &AccessRules, repository: &str, home: &Path) -> Result<Transport> {
        access.resolve_for(repository, false, home, Some(Platform::Macos), false)
    }

    #[cfg(unix)]
    #[test]
    fn built_in_selection_is_limited_to_its_prefix() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let _agent = agent(&home.path().join(ORG_SOCKET));
        for repository in [
            "https://github.com/other-org/plugin.git",
            "https://github.com:8443/example-org/plugin.git",
            "https://github.com.example/example-org/plugin.git",
            "https://github.com/example-org/plugin%2F..%2F..%2Fother",
            "ssh://org-1@github.com/example-org/plugin%2F..%2F..%2Fother",
            "ssh://git@github.com/example-org/plugin.git",
            "ssh://org-1@github.com/other-org/plugin.git",
            "ssh://org-1@github.com.example/example-org/plugin.git",
            "ssh://org-1@github.com:2222/example-org/plugin.git",
        ] {
            assert_eq!(
                macos(&built_in(), repository, home.path()).unwrap(),
                direct(repository),
                "{repository}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn built_in_reads_https_over_ssh() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let repository = "https://github.com/example-org/plugin.git";
        assert_eq!(
            macos(&built_in(), repository, home.path()).unwrap(),
            direct(repository)
        );

        let socket = home.path().join(ORG_SOCKET);
        let _agent = agent(&socket);
        let expected = Transport {
            clone_url: "ssh://org-1@github.com/example-org/plugin.git".into(),
            ssh_auth_sock: Some(socket.clone()),
            rule: Some("github.com/example-org/".into()),
        };
        assert_eq!(
            macos(&built_in(), repository, home.path()).unwrap(),
            expected
        );
        let ssh = "ssh://org-1@github.com/example-org/plugin.git";
        assert_eq!(macos(&built_in(), ssh, home.path()).unwrap(), expected);
        let port_22 = "ssh://org-1@github.com:22/example-org/plugin.git";
        assert_eq!(
            macos(&built_in(), port_22, home.path()).unwrap(),
            Transport {
                clone_url: port_22.into(),
                ..expected
            }
        );

        assert_eq!(
            built_in()
                .resolve_for(repository, true, home.path(), Some(Platform::Macos), false)
                .unwrap(),
            direct(repository)
        );
        for platform in [Some(Platform::Linux), Some(Platform::Windows), None] {
            assert_eq!(
                built_in()
                    .resolve_for(repository, false, home.path(), platform, true)
                    .unwrap(),
                direct(repository),
                "{platform:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn agent_may_be_absent_but_must_be_a_socket_when_present() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let repository = "ssh://org-1@github.com/example-org/plugin.git";
        assert_eq!(
            macos(&built_in(), repository, home.path()).unwrap(),
            direct(repository)
        );
        let socket = home.path().join(ORG_SOCKET);
        fs::create_dir_all(socket.parent().unwrap()).unwrap();
        fs::write(&socket, "").unwrap();
        assert_eq!(
            macos(&built_in(), repository, home.path()).unwrap_err(),
            format!("SSH agent path is not a socket: {}", socket.display())
        );
    }

    #[cfg(unix)]
    #[test]
    fn file_rules_rewrite_other_hosts_and_shadow_built_ins() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let team_socket = home.path().join("team.sock");
        let _team = agent(&team_socket);
        let _org = agent(&home.path().join(ORG_SOCKET));
        let access = access(&format!(
            r#"{{"version": 1, "rules": [
                {{"host": "git.example.com", "pathPrefix": "/team/", "sshUser": "git", "sshAgentSocket": "{}"}},
                {{"host": "github.com", "pathPrefix": "/example-org/", "sshUser": "org-1", "sshAgentSocket": "~/team.sock"}},
                {{"host": "github.com", "pathPrefix": "/ssh-only/", "sshUser": "git", "sshAgentSocket": "~/team.sock", "rewriteHttps": false}},
                {{"host": "github.com", "pathPrefix": "/linux/", "sshUser": "git", "sshAgentSocket": "~/team.sock", "platforms": ["linux"]}},
                {{"host": "github.com", "pathPrefix": "/missing/", "sshUser": "git", "sshAgentSocket": "~/missing.sock"}}
            ]}}"#,
            team_socket.display()
        ));
        let team = |clone_url: &str, rule: &str| Transport {
            clone_url: clone_url.into(),
            ssh_auth_sock: Some(team_socket.clone()),
            rule: Some(rule.into()),
        };
        assert_eq!(
            macos(
                &access,
                "https://git.example.com/team/plugin.git",
                home.path()
            )
            .unwrap(),
            team(
                "ssh://git@git.example.com/team/plugin.git",
                "git.example.com/team/"
            )
        );
        assert_eq!(
            macos(
                &access,
                "https://github.com/example-org/plugin.git",
                home.path()
            )
            .unwrap(),
            team(
                "ssh://org-1@github.com/example-org/plugin.git",
                "github.com/example-org/"
            )
        );
        assert_eq!(
            macos(
                &access,
                "https://github.com/ssh-only/plugin.git",
                home.path()
            )
            .unwrap(),
            direct("https://github.com/ssh-only/plugin.git")
        );
        assert_eq!(
            macos(
                &access,
                "ssh://git@github.com/ssh-only/plugin.git",
                home.path()
            )
            .unwrap(),
            team(
                "ssh://git@github.com/ssh-only/plugin.git",
                "github.com/ssh-only/"
            )
        );
        assert_eq!(
            macos(&access, "https://github.com/linux/plugin.git", home.path()).unwrap(),
            direct("https://github.com/linux/plugin.git")
        );
        assert_eq!(
            access
                .resolve_for(
                    "https://github.com/linux/plugin.git",
                    false,
                    home.path(),
                    Some(Platform::Linux),
                    false
                )
                .unwrap(),
            team("ssh://git@github.com/linux/plugin.git", "github.com/linux/")
        );
        assert_eq!(
            macos(
                &access,
                "https://github.com/missing/plugin.git",
                home.path()
            )
            .unwrap(),
            direct("https://github.com/missing/plugin.git")
        );
        assert_eq!(
            access
                .resolve_for(
                    "https://git.example.com/team/plugin.git",
                    true,
                    home.path(),
                    Some(Platform::Macos),
                    false
                )
                .unwrap(),
            direct("https://git.example.com/team/plugin.git")
        );
        assert_eq!(
            macos(
                &access,
                "https://git.example.com/team/a%2F..%2F..%2Fother",
                home.path()
            )
            .unwrap(),
            direct("https://git.example.com/team/a%2F..%2F..%2Fother")
        );
    }

    #[cfg(unix)]
    #[test]
    fn ssh_only_file_rule_shadows_the_built_in_https_rewrite() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let team_socket = home.path().join("team.sock");
        let _team = agent(&team_socket);
        let _org = agent(&home.path().join(ORG_SOCKET));
        let access = access(
            r#"{"version": 1, "rules": [{"host": "github.com", "pathPrefix": "/example-org/", "sshUser": "org-1", "sshAgentSocket": "~/team.sock", "rewriteHttps": false}]}"#,
        );
        let https = "https://github.com/example-org/plugin.git";
        assert_eq!(macos(&access, https, home.path()).unwrap(), direct(https));
        let ssh = "ssh://org-1@github.com/example-org/plugin.git";
        assert_eq!(
            macos(&access, ssh, home.path()).unwrap(),
            Transport {
                clone_url: ssh.into(),
                ssh_auth_sock: Some(team_socket),
                rule: Some("github.com/example-org/".into()),
            }
        );
    }

    #[test]
    fn socketless_rules_need_an_inherited_agent() {
        let home = tempfile::tempdir().unwrap();
        let access = access(
            r#"{"version": 1, "rules": [{"host": "github.com", "pathPrefix": "/example-org/", "sshUser": "git"}]}"#,
        );
        let repository = "https://github.com/example-org/plugin.git";
        assert_eq!(
            macos(&access, repository, home.path()).unwrap(),
            direct(repository)
        );
        assert_eq!(
            access
                .resolve_for(repository, false, home.path(), Some(Platform::Macos), true)
                .unwrap(),
            Transport {
                clone_url: "ssh://git@github.com/example-org/plugin.git".into(),
                ssh_auth_sock: None,
                rule: Some("github.com/example-org/".into()),
            }
        );
    }

    #[test]
    fn describes_the_file_rules_and_a_url() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(FILE_NAME);
        let built_in_line = "  github.com/example-org/ as org-1, agent ~/Library/Application Support/example-ssh-agent/agent.sock, HTTPS read over SSH, macos (built in)";
        assert_eq!(
            load(root.path(), None).describe(None, home.path()).unwrap(),
            format!(
                "File: {} (absent)\nRules, in the order they are tried:\n{built_in_line}\n",
                path.display()
            )
        );

        fs::write(&path, r#"{"version": 2}"#).unwrap();
        assert_eq!(
            load(root.path(), None).describe(None, home.path()).unwrap(),
            format!("File: {} (unusable: Unsupported version; this Buzz reads version 1)\nRules, in the order they are tried:\n{built_in_line}\n", path.display())
        );
        assert_eq!(
            load(root.path(), Some("relative.json".into())).describe(None, home.path()).unwrap(),
            format!("File: none (unusable: {PATH_ENV} must be an absolute path)\nRules, in the order they are tried:\n{built_in_line}\n")
        );

        fs::write(
            &path,
            r#"{"version": 1, "rules": [
                {"host": "github.com", "pathPrefix": "/example-org/", "sshUser": "git", "rewriteHttps": false, "platforms": ["linux", "windows"]},
                {"host": "github.com", "pathPrefix": "/bad/"}
            ]}"#,
        )
        .unwrap();
        let ready = load(root.path(), None);
        assert_eq!(
            ready.describe(None, home.path()).unwrap(),
            format!(
                "File: {} (ready)\nProblem: Rule 2: sshUser is required and must be a string\nRules, in the order they are tried:\n  github.com/example-org/ as git, inherited agent, SSH only, linux, windows\n{built_in_line}\n",
                path.display()
            )
        );
        let described = ready
            .describe(Some("https://example.com/owner/plugin"), home.path())
            .unwrap();
        assert!(
            described.ends_with("\nURL: https://example.com/owner/plugin\nRule: none\nGit reads: https://example.com/owner/plugin\nAgent socket: inherited\n"),
            "{described}"
        );
        assert!(ready
            .describe(Some("file:///tmp/plugin"), home.path())
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn describes_a_matched_rule_and_a_socket_error() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let socket = home.path().join("team.sock");
        let _agent = agent(&socket);
        fs::write(home.path().join("file.sock"), "").unwrap();
        let access = access(
            r#"{"version": 1, "builtInRules": false, "rules": [
                {"host": "git.example.com", "pathPrefix": "/team/", "sshUser": "git", "sshAgentSocket": "~/team.sock"},
                {"host": "git.example.com", "pathPrefix": "/file/", "sshUser": "git", "sshAgentSocket": "~/file.sock"}
            ]}"#,
        );
        let described = access
            .describe(Some("https://git.example.com/team/plugin.git"), home.path())
            .unwrap();
        assert!(
            described.ends_with(&format!(
                "\nURL: https://git.example.com/team/plugin.git\nRule: git.example.com/team/\nGit reads: ssh://git@git.example.com/team/plugin.git\nAgent socket: {}\n",
                socket.display()
            )),
            "{described}"
        );
        let described = access
            .describe(Some("https://git.example.com/file/plugin.git"), home.path())
            .unwrap();
        assert!(
            described.ends_with(&format!(
                "\nURL: https://git.example.com/file/plugin.git\nError: SSH agent path is not a socket: {}\n",
                home.path().join("file.sock").display()
            )),
            "{described}"
        );
    }

    #[test]
    fn empty_build_input_has_no_default_rules() {
        assert!(rules_from_build("").is_empty());
    }

    #[test]
    fn build_rules_are_marked_built_in() {
        let access = built_in();
        assert_eq!(access.status, Status::Absent);
        assert_eq!(
            access.rules,
            vec![Rule {
                host: "github.com".into(),
                path_prefix: "/example-org/".into(),
                ssh_user: "org-1".into(),
                ssh_agent_socket: Some(
                    "~/Library/Application Support/example-ssh-agent/agent.sock".into()
                ),
                rewrite_https: true,
                platforms: Some(vec![Platform::Macos]),
                built_in: true,
            }]
        );
    }

    // Windows drops rules with agent sockets.
    #[cfg(unix)]
    #[test]
    fn parses_every_field_and_defaults() {
        let file = parse(
            r#"{"version": 1, "unknown": 0, "rules": [
                {"host": "git.example.com", "pathPrefix": "/team/", "sshUser": "git",
                 "sshAgentSocket": "/run/agent.sock", "rewriteHttps": false,
                 "platforms": ["linux", "macos"], "note": "ignored"},
                {"host": "github.com", "pathPrefix": "/example-org/", "sshUser": "git"}
            ]}"#,
        )
        .unwrap();
        assert!(file.problems.is_empty(), "{:?}", file.problems);
        assert!(file.built_in_rules);
        let mut first = rule("git.example.com", "/team/", "git");
        first.ssh_agent_socket = Some("/run/agent.sock".into());
        first.rewrite_https = false;
        first.platforms = Some(vec![Platform::Linux, Platform::Macos]);
        assert_eq!(
            file.rules,
            vec![first, rule("github.com", "/example-org/", "git")]
        );
        let home = parse(r#"{"version": 1, "rules": [{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git", "sshAgentSocket": "~/agent.sock"}]}"#).unwrap();
        assert_eq!(
            home.rules[0].ssh_agent_socket.as_deref(),
            Some("~/agent.sock")
        );
        assert!(
            !parse(r#"{"version": 1, "builtInRules": false}"#)
                .unwrap()
                .built_in_rules
        );
    }

    #[test]
    fn each_invalid_field_drops_only_its_rule() {
        let valid = r#"{"host": "github.com", "pathPrefix": "/ok/", "sshUser": "git"}"#;
        for (invalid, field) in [
            (r#"[]"#, "object"),
            (r#"{"pathPrefix": "/a/", "sshUser": "git"}"#, "host"),
            (
                r#"{"host": "GitHub.com", "pathPrefix": "/a/", "sshUser": "git"}"#,
                "host",
            ),
            (
                r#"{"host": "github.com:22", "pathPrefix": "/a/", "sshUser": "git"}"#,
                "host",
            ),
            (
                r#"{"host": "git%68ub.com", "pathPrefix": "/a/", "sshUser": "git"}"#,
                "host",
            ),
            (
                r#"{"host": "-github.com", "pathPrefix": "/a/", "sshUser": "git"}"#,
                "host",
            ),
            (
                r#"{"host": "", "pathPrefix": "/a/", "sshUser": "git"}"#,
                "host",
            ),
            (
                &format!(
                    r#"{{"host": "{}", "pathPrefix": "/a/", "sshUser": "git"}}"#,
                    "a".repeat(254)
                ),
                "host",
            ),
            (r#"{"host": "github.com", "sshUser": "git"}"#, "pathPrefix"),
            (
                r#"{"host": "github.com", "pathPrefix": "a/", "sshUser": "git"}"#,
                "pathPrefix",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a", "sshUser": "git"}"#,
                "pathPrefix",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a%2F/", "sshUser": "git"}"#,
                "pathPrefix",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/../b/", "sshUser": "git"}"#,
                "pathPrefix",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a b/", "sshUser": "git"}"#,
                "pathPrefix",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a\tb/", "sshUser": "git"}"#,
                "pathPrefix",
            ),
            (
                &format!(
                    r#"{{"host": "github.com", "pathPrefix": "/{}/", "sshUser": "git"}}"#,
                    "a".repeat(255)
                ),
                "pathPrefix",
            ),
            (r#"{"host": "github.com", "pathPrefix": "/a/"}"#, "sshUser"),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "-oProxyCommand"}"#,
                "sshUser",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git@evil"}"#,
                "sshUser",
            ),
            (
                &format!(
                    r#"{{"host": "github.com", "pathPrefix": "/a/", "sshUser": "{}"}}"#,
                    "a".repeat(65)
                ),
                "sshUser",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git", "sshAgentSocket": "agent.sock"}"#,
                "sshAgentSocket",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git", "sshAgentSocket": 1}"#,
                "sshAgentSocket",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git", "rewriteHttps": "no"}"#,
                "rewriteHttps",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git", "platforms": "macos"}"#,
                "platforms",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git", "platforms": ["beos"]}"#,
                "platforms",
            ),
            (
                r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git", "platforms": []}"#,
                "platforms",
            ),
        ] {
            let file = parse(&format!(
                r#"{{"version": 1, "rules": [{invalid}, {valid}]}}"#
            ))
            .unwrap();
            assert_eq!(
                file.rules,
                vec![rule("github.com", "/ok/", "git")],
                "{invalid}"
            );
            assert_eq!(file.problems.len(), 1, "{invalid}");
            assert!(
                file.problems[0].starts_with("Rule 1: "),
                "{:?}",
                file.problems
            );
            assert!(
                file.problems[0].contains(field),
                "{field}: {:?}",
                file.problems
            );
        }
    }

    #[test]
    fn rejects_unusable_files_as_a_whole() {
        for (text, reason) in [
            ("[]", "Expected a JSON object"),
            ("{", "Invalid JSON"),
            (r#"{"rules": []}"#, "Missing version"),
            (r#"{"version": 2}"#, "Unsupported version"),
            (r#"{"version": 1, "rules": {}}"#, "rules must be an array"),
            (
                r#"{"version": 1, "builtInRules": "no"}"#,
                "builtInRules must be true or false",
            ),
        ] {
            let error = parse(text).err().unwrap_or_else(|| panic!("{text} parsed"));
            assert!(error.starts_with(reason), "{text}: {error}");
        }
    }

    #[test]
    fn caps_rules() {
        let rules =
            vec![r#"{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git"}"#; MAX_RULES + 1];
        let file = parse(&format!(
            r#"{{"version": 1, "rules": [{}]}}"#,
            rules.join(",")
        ))
        .unwrap();
        assert_eq!(file.rules.len(), MAX_RULES);
        assert_eq!(
            file.problems,
            vec!["Only the first 32 of 33 rules are used"]
        );
        let invalid = vec!["[]"; MAX_RULES];
        assert_eq!(
            problems(&format!(
                r#"{{"version": 1, "rules": [{}]}}"#,
                invalid.join(",")
            ))
            .len(),
            MAX_PROBLEMS
        );
    }

    #[test]
    fn load_orders_file_rules_before_built_ins_and_falls_back_to_them() {
        let root = tempfile::tempdir().unwrap();
        let absent = load(root.path(), None);
        assert_eq!(absent.status, Status::Absent);
        assert_eq!(absent.path, Some(root.path().join(FILE_NAME)));
        assert_eq!(absent.rules, built_in_rules());

        let file = root.path().join(FILE_NAME);
        fs::write(&file, r#"{"version": 1, "rules": [{"host": "github.com", "pathPrefix": "/a/", "sshUser": "git"}, []]}"#).unwrap();
        let ready = load(root.path(), None);
        assert_eq!(ready.status, Status::Ready);
        let mut expected = vec![rule("github.com", "/a/", "git")];
        expected.extend(built_in_rules());
        assert_eq!(ready.rules, expected);
        assert_eq!(ready.problems.len(), 1);

        fs::write(
            &file,
            r#"{"version": 1, "builtInRules": false, "rules": []}"#,
        )
        .unwrap();
        assert!(load(root.path(), None).rules.is_empty());

        fs::write(&file, r#"{"version": 2}"#).unwrap();
        let invalid = load(root.path(), None);
        assert!(matches!(invalid.status, Status::Invalid { .. }));
        assert_eq!(invalid.rules, built_in_rules());

        fs::write(&file, vec![b' '; MAX_BYTES as usize + 1]).unwrap();
        assert_eq!(
            load(root.path(), None).status,
            Status::Invalid {
                reason: "Repository access file exceeds 64 KiB".into()
            }
        );
    }

    #[test]
    fn env_override_must_be_absolute() {
        let root = tempfile::tempdir().unwrap();
        let elsewhere = root.path().join("elsewhere.json");
        fs::write(&elsewhere, r#"{"version": 1, "builtInRules": false}"#).unwrap();
        let overridden = load(Path::new("/nonexistent"), Some(elsewhere.clone().into()));
        assert_eq!(overridden.path, Some(elsewhere));
        assert!(overridden.rules.is_empty());

        let relative = load(root.path(), Some("relative.json".into()));
        assert_eq!(
            relative.status,
            Status::Invalid {
                reason: format!("{PATH_ENV} must be an absolute path")
            }
        );
        assert_eq!(relative.rules, built_in_rules());
        assert_eq!(load(root.path(), Some("".into())).status, Status::Absent);
    }
}
