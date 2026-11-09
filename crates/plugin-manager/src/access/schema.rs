//! The `repository-access.json` schema, shared with `build.rs`, which validates the
//! `BUZZ_BUILD_REPOSITORY_ACCESS` build input with it.
use serde_json::{Map, Value};
use std::path::Path;

type Result<T> = std::result::Result<T, String>;

pub(crate) const MAX_RULES: usize = 32;
pub(crate) const MAX_PROBLEMS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Macos,
    Linux,
    Windows,
}
impl Platform {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "macos" => Some(Self::Macos),
            "linux" => Some(Self::Linux),
            "windows" => Some(Self::Windows),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Rule {
    pub(crate) host: String,
    pub(crate) path_prefix: String,
    pub(crate) ssh_user: String,
    pub(crate) ssh_agent_socket: Option<String>,
    pub(crate) rewrite_https: bool,
    /// `None` applies on every platform.
    pub(crate) platforms: Option<Vec<Platform>>,
    pub(crate) built_in: bool,
}

pub(crate) struct File {
    pub(crate) rules: Vec<Rule>,
    pub(crate) built_in_rules: bool,
    pub(crate) problems: Vec<String>,
}

pub(crate) fn parse(text: &str) -> Result<File> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("Invalid JSON: {e}"))?;
    let Value::Object(mut root) = value else {
        return Err("Expected a JSON object".into());
    };
    match root.remove("version") {
        Some(Value::Number(version)) if version.as_u64() == Some(1) => {}
        Some(_) => return Err("Unsupported version; this Buzz reads version 1".into()),
        None => return Err("Missing version".into()),
    }
    let built_in_rules = match root.remove("builtInRules") {
        None => true,
        Some(Value::Bool(value)) => value,
        Some(_) => return Err("builtInRules must be true or false".into()),
    };
    let entries = match root.remove("rules") {
        None => vec![],
        Some(Value::Array(entries)) => entries,
        Some(_) => return Err("rules must be an array".into()),
    };
    let mut problems = vec![];
    let mut report = |message: String| {
        if problems.len() < MAX_PROBLEMS {
            problems.push(message);
        }
    };
    if entries.len() > MAX_RULES {
        report(format!(
            "Only the first {MAX_RULES} of {} rules are used",
            entries.len()
        ));
    }
    let mut rules = vec![];
    for (index, entry) in entries.into_iter().take(MAX_RULES).enumerate() {
        match parse_rule(entry) {
            Ok(rule) => rules.push(rule),
            Err(reason) => report(format!("Rule {}: {reason}", index + 1)),
        }
    }
    Ok(File {
        rules,
        built_in_rules,
        problems,
    })
}

fn parse_rule(entry: Value) -> Result<Rule> {
    let Value::Object(mut entry) = entry else {
        return Err("expected an object".into());
    };
    let host = required(&mut entry, "host")?;
    if host.len() > 253
        || host.starts_with('-')
        || !host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
    {
        return Err("host must be a lowercase host name without a port".into());
    }
    let path_prefix = required(&mut entry, "pathPrefix")?;
    if path_prefix.len() > 256
        || !path_prefix.starts_with('/')
        || !path_prefix.ends_with('/')
        || path_prefix.contains('%')
        || path_prefix.split('/').any(|segment| segment == "..")
        || path_prefix
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(
            "pathPrefix must start and end with / and contain no %, .. segment or whitespace"
                .into(),
        );
    }
    let ssh_user = required(&mut entry, "sshUser")?;
    if ssh_user.len() > 64
        || ssh_user.starts_with('-')
        || !ssh_user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
    {
        return Err("sshUser must be 1 to 64 letters, digits, dots, underscores or hyphens, not starting with a hyphen".into());
    }
    let ssh_agent_socket = match entry.remove("sshAgentSocket") {
        None => None,
        Some(Value::String(socket))
            if (Path::new(&socket).is_absolute() || socket.starts_with("~/"))
                && !socket.chars().any(char::is_control) =>
        {
            Some(socket)
        }
        Some(_) => return Err("sshAgentSocket must be an absolute path or start with ~/".into()),
    };
    if ssh_agent_socket.is_some() && cfg!(windows) {
        return Err("sshAgentSocket is not supported on Windows".into());
    }
    let rewrite_https = match entry.remove("rewriteHttps") {
        None => true,
        Some(Value::Bool(value)) => value,
        Some(_) => return Err("rewriteHttps must be true or false".into()),
    };
    let platforms = match entry.remove("platforms") {
        None => None,
        Some(Value::Array(names)) if !names.is_empty() => Some(
            names
                .iter()
                .map(|name| name.as_str().and_then(Platform::parse))
                .collect::<Option<Vec<_>>>()
                .ok_or("platforms must list only macos, linux or windows")?,
        ),
        Some(_) => return Err("platforms must list macos, linux or windows".into()),
    };
    Ok(Rule {
        host,
        path_prefix,
        ssh_user,
        ssh_agent_socket,
        rewrite_https,
        platforms,
        built_in: false,
    })
}

fn required(entry: &mut Map<String, Value>, key: &str) -> Result<String> {
    match entry.remove(key) {
        Some(Value::String(value)) if !value.is_empty() => Ok(value),
        _ => Err(format!("{key} is required and must be a string")),
    }
}
