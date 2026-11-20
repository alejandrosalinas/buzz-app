//! An old bundle's `buzz` CLI path can resolve to this app's `Buzz` on macOS.
//! Recognize only its command names and options, leaving OS launch arguments
//! and deep links to the desktop host. Never inspect or log command payloads.
use std::ffi::OsStr;

pub(crate) fn is_legacy_cli_arg(arg: &OsStr) -> bool {
    let Some(arg) = arg.to_str() else {
        return false;
    };
    // Inspect only argv[1]. A deep link or an OS launch option may have values
    // that happen to match CLI words; those are not CLI invocations.
    let option = arg.split_once('=').map_or(arg, |(name, _)| name);
    matches!(
        arg,
        "help"
            | "agents"
            | "auth"
            | "messages"
            | "channels"
            | "canvas"
            | "sidebar"
            | "reactions"
            | "emoji"
            | "gifs"
            | "huddles"
            | "dms"
            | "users"
            | "workflows"
            | "feed"
            | "social"
            | "notes"
            | "repos"
            | "projects"
            | "patches"
            | "issues"
            | "pr"
            | "media"
            | "upload"
            | "mem"
            | "pack"
            | "moderation"
            | "--help"
            | "-h"
            | "--version"
            | "-V"
    ) || matches!(
        option,
        "--relay" | "--private-key" | "--auth-tag" | "--format"
    )
}

#[cfg(test)]
mod tests {
    use super::is_legacy_cli_arg;

    #[test]
    fn recognizes_legacy_commands_and_global_options() {
        for arg in [
            "help",
            "agents",
            "auth",
            "messages",
            "channels",
            "canvas",
            "sidebar",
            "reactions",
            "emoji",
            "gifs",
            "huddles",
            "dms",
            "users",
            "workflows",
            "feed",
            "social",
            "notes",
            "repos",
            "projects",
            "patches",
            "issues",
            "pr",
            "media",
            "upload",
            "mem",
            "pack",
            "moderation",
            "--help",
            "-h",
            "--version",
            "-V",
            "--relay",
            "--relay=https://example.com",
            "--private-key",
            "--private-key=secret",
            "--auth-tag",
            "--auth-tag={}",
            "--format",
            "--format=compact",
        ] {
            assert!(is_legacy_cli_arg(arg.as_ref()), "{arg}");
        }
    }

    #[test]
    fn preserves_deep_links_and_unrecognized_launch_arguments() {
        for arg in [
            "buzz://message?channel=messages&id=help",
            "buzz://channel/general",
            "buzz://channel/gifs",
            "buzz://join?relay=wss://example.com&code=notes",
            "-psn_0_12345",
            "-NSDocumentRevisionsDebugMode",
            "--allow-file-access-from-files",
            "--",
            "",
            "Messages",
            "messages.txt",
            "messages=send",
            "--formatting",
            "--help=something",
        ] {
            assert!(!is_legacy_cli_arg(arg.as_ref()), "{arg}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn preserves_non_unicode_launch_arguments() {
        use std::os::unix::ffi::OsStrExt;
        assert!(!is_legacy_cli_arg(std::ffi::OsStr::from_bytes(b"\xff")));
    }
}
