//! What the helper may be asked for. Everything here is pure, so it is tested
//! on every platform; the macOS adapter only runs requests this module accepts.

/// Bumped when the request format or the set of served items changes.
/// `just desktop me` installs one helper per protocol, so checkouts on
/// different protocols each keep a helper that understands them.
pub const PROTOCOL: u32 = 1;

/// Largest value read or written, in either direction.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const LIMIT: usize = 2 * 1024 * 1024;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const ABSENT: i32 = 10;
pub const DENIED: i32 = 11;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const CORRUPT: i32 = 12;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const OCCUPIED: i32 = 13;
pub const UNAVAILABLE: i32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Read,
    Add,
    Replace,
    Delete,
}

impl Operation {
    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "read" => Self::Read,
            "add" => Self::Add,
            "replace" => Self::Replace,
            "delete" => Self::Delete,
            _ => return None,
        })
    }
    /// Whether the app sends a value for this operation.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn takes_value(self) -> bool {
        matches!(self, Self::Add | Self::Replace)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Request {
    /// Whether a Keychain dialog may be shown for an item not yet approved.
    pub authorize: bool,
    pub operation: Operation,
    pub service: String,
    pub account: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Version,
    Item(Request),
}

/// `--version`, or `[--authorize] --item <operation> <service> <account>`.
/// A request for an item outside [`allowed`] is refused here, before any
/// peer check or Keychain call.
pub fn parse(args: &[String]) -> Result<Command, i32> {
    match args {
        [flag] if flag == "--version" => return Ok(Command::Version),
        _ => {}
    }
    let (authorize, rest) = match args.split_first() {
        Some((flag, rest)) if flag == "--authorize" => (true, rest),
        _ => (false, args),
    };
    let [mode, operation, service, account] = rest else {
        return Err(UNAVAILABLE);
    };
    if mode != "--item" {
        return Err(UNAVAILABLE);
    }
    let operation = Operation::parse(operation).ok_or(UNAVAILABLE)?;
    if !allowed(operation, service, account) {
        return Err(DENIED);
    }
    Ok(Command::Item(Request {
        authorize,
        operation,
        service: service.clone(),
        account: account.clone(),
    }))
}

fn hex64(account: &str) -> bool {
    account.len() == 64
        && account
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Accounts the app derives itself: ASCII letters, digits and `.-_:`, bounded.
fn plain(account: &str, prefix: &str) -> bool {
    account.len() > prefix.len()
        && account.len() <= 256
        && account.starts_with(prefix)
        && account[prefix.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-_:".contains(&byte))
}

/// The exact debug-build items `just desktop me` reads and writes, and the
/// release human key, which it may only read.
pub fn allowed(operation: Operation, service: &str, account: &str) -> bool {
    use Operation::*;
    match service {
        // The release build's key, for `me`: read only, never copied or changed.
        "xyz.block.buzz.desktop.identity" | "dev.local.buzz.foundation.identity" => {
            operation == Read && account == "human"
        }
        // The debug build's own key is create-only; paired-tool records beside it are mutable.
        "xyz.block.buzz.desktop.identity.debug" | "dev.local.buzz.foundation.identity.debug" => {
            if account == "human" {
                operation != Replace
            } else {
                plain(account, "credential-pairings.v1.")
            }
        }
        "xyz.block.buzz.desktop.agents" | "dev.local.buzz.foundation.agents" => {
            account == "agent-bundle-v1" || plain(account, "agent:")
        }
        "xyz.block.buzz.desktop.federated-session.debug" => hex64(account),
        "xyz.block.buzz.desktop.jev-key.debug" | "dev.local.buzz.foundation.jev-key.debug" => {
            account == "typesafe"
        }
        "xyz.block.buzz.desktop.claude-api-key.debug" => account == "anthropic",
        "xyz.block.buzz.desktop.external-app-pairing.v1" => hex64(account),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(text: &str) -> Vec<String> {
        text.split(' ').map(String::from).collect()
    }

    #[test]
    fn parses_version_and_items() {
        assert_eq!(parse(&args("--version")), Ok(Command::Version));
        assert_eq!(
            parse(&args(
                "--authorize --item read xyz.block.buzz.desktop.identity human"
            )),
            Ok(Command::Item(Request {
                authorize: true,
                operation: Operation::Read,
                service: "xyz.block.buzz.desktop.identity".into(),
                account: "human".into(),
            }))
        );
        assert!(matches!(
            parse(&args(
                "--item add xyz.block.buzz.desktop.identity.debug human"
            )),
            Ok(Command::Item(Request {
                authorize: false,
                operation: Operation::Add,
                ..
            }))
        ));
    }

    #[test]
    fn rejects_malformed_requests() {
        for bad in [
            "",
            "--item",
            "--item read xyz.block.buzz.desktop.identity",
            "--item read xyz.block.buzz.desktop.identity human extra",
            "--agent-store read xyz.block.buzz.desktop.agents agent-bundle-v1",
            "--session-store read xyz.block.buzz.desktop.federated-session.debug x",
            "--item copy xyz.block.buzz.desktop.identity human",
            "--authorize --authorize --item read xyz.block.buzz.desktop.identity human",
            "--item read xyz.block.buzz.desktop.identity human --authorize",
        ] {
            assert_eq!(parse(&args(bad)), Err(UNAVAILABLE), "{bad}");
        }
    }

    #[test]
    fn serves_only_the_listed_items() {
        use Operation::*;
        let hex = "0123456789abcdef".repeat(4);
        for (operation, service, account) in [
            (Read, "xyz.block.buzz.desktop.identity", "human"),
            (Read, "dev.local.buzz.foundation.identity", "human"),
            (Read, "xyz.block.buzz.desktop.identity.debug", "human"),
            (Add, "xyz.block.buzz.desktop.identity.debug", "human"),
            (Delete, "xyz.block.buzz.desktop.identity.debug", "human"),
            (Read, "dev.local.buzz.foundation.identity.debug", "human"),
            (
                Replace,
                "xyz.block.buzz.desktop.identity.debug",
                "credential-pairings.v1.main-1",
            ),
            (Replace, "xyz.block.buzz.desktop.agents", "agent-bundle-v1"),
            (Read, "dev.local.buzz.foundation.agents", "agent:abc-def"),
            (
                Replace,
                "xyz.block.buzz.desktop.federated-session.debug",
                hex.as_str(),
            ),
            (
                Delete,
                "xyz.block.buzz.desktop.federated-session.debug",
                hex.as_str(),
            ),
            (Replace, "xyz.block.buzz.desktop.jev-key.debug", "typesafe"),
            (Read, "dev.local.buzz.foundation.jev-key.debug", "typesafe"),
            (
                Replace,
                "xyz.block.buzz.desktop.claude-api-key.debug",
                "anthropic",
            ),
            (
                Replace,
                "xyz.block.buzz.desktop.external-app-pairing.v1",
                hex.as_str(),
            ),
        ] {
            assert!(
                allowed(operation, service, account),
                "{operation:?} {service} {account}"
            );
        }
        let upper = "0123456789ABCDEF".repeat(4);
        for (operation, service, account) in [
            // The release key is never written, copied over or deleted.
            (Add, "xyz.block.buzz.desktop.identity", "human"),
            (Replace, "xyz.block.buzz.desktop.identity", "human"),
            (Delete, "xyz.block.buzz.desktop.identity", "human"),
            (Delete, "dev.local.buzz.foundation.identity", "human"),
            (
                Read,
                "xyz.block.buzz.desktop.identity",
                "credential-pairings.v1.main",
            ),
            // The debug key is create-only.
            (Replace, "xyz.block.buzz.desktop.identity.debug", "human"),
            (Read, "xyz.block.buzz.desktop.identity.debug", "other"),
            (
                Read,
                "xyz.block.buzz.desktop.identity.debug",
                "credential-pairings.v1.",
            ),
            (
                Read,
                "xyz.block.buzz.desktop.identity.debug",
                "credential-pairings.v1.a/b",
            ),
            (Read, "xyz.block.buzz.desktop.agents", "secrets"),
            (Read, "xyz.block.buzz.desktop.agents", "agent:"),
            // Release-build sessions and keys belong to the release app.
            (
                Read,
                "xyz.block.buzz.desktop.federated-session",
                hex.as_str(),
            ),
            (
                Read,
                "xyz.block.buzz.desktop.federated-session.debug",
                upper.as_str(),
            ),
            (
                Read,
                "xyz.block.buzz.desktop.federated-session.debug",
                "human",
            ),
            (Read, "xyz.block.buzz.desktop.jev-key", "typesafe"),
            (Read, "xyz.block.buzz.desktop.claude-api-key", "anthropic"),
            (
                Read,
                "xyz.block.buzz.desktop.claude-api-key.debug",
                "openai",
            ),
            // Old Buzz and anything else.
            (Read, "buzz-desktop", "secrets"),
            (Read, "app.buzz.onedotzero", "identity"),
            (Read, "", ""),
        ] {
            assert!(
                !allowed(operation, service, account),
                "{operation:?} {service} {account}"
            );
        }
        assert_eq!(
            parse(&args("--item read buzz-desktop secrets")),
            Err(DENIED)
        );
    }
}
