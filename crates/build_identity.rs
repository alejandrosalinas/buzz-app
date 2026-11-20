use serde::Serialize;
use std::{path::Path, process::Command};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceState {
    Clean,
    Dirty,
    Unknown,
}

impl SourceState {
    fn parse(value: Option<&str>) -> Self {
        match value {
            Some("clean") => Self::Clean,
            Some("dirty") => Self::Dirty,
            _ => Self::Unknown,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Dirty => "dirty",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildIdentity {
    pub revision: Option<String>,
    pub state: SourceState,
}

pub fn compiled(revision: Option<&str>, state: Option<&str>) -> BuildIdentity {
    let revision = revision.and_then(valid_revision).map(str::to_owned);
    let state = if revision.is_some() {
        SourceState::parse(state)
    } else {
        SourceState::Unknown
    };
    BuildIdentity { revision, state }
}

pub fn configure_native_build(manifest_dir: &Path) {
    let root = manifest_dir.parent().unwrap_or(manifest_dir);
    for path in [
        "src-tauri/src",
        "src-tauri/Cargo.toml",
        "Cargo.toml",
        "Cargo.lock",
        "crates",
        "src",
        "public",
    ] {
        println!("cargo:rerun-if-changed={}", root.join(path).display());
    }
    let identity = capture(root);
    if identity.revision.is_some() {
        // Resolve through Git: linked worktrees keep HEAD and refs in different directories.
        let reference = git(root, &["symbolic-ref", "--quiet", "HEAD"]);
        for name in ["HEAD", "packed-refs"]
            .into_iter()
            .chain(reference.as_deref().map(str::trim))
        {
            if let Some(path) = git(root, &["rev-parse", "--git-path", name]) {
                let path = root.join(path.trim());
                // A packed branch may gain a loose ref on commit. Prefer its existing
                // reflog to the shared parent directory; keep the parent fallback without
                // a reflog, and skip absent packed-refs so no-op builds stay no-ops.
                let path = if name.starts_with("refs/") && !path.exists() {
                    git(root, &["rev-parse", "--git-path", &format!("logs/{name}")])
                        .map(|log| root.join(log.trim()))
                        .filter(|log| log.is_file())
                        .unwrap_or(path)
                } else {
                    path
                };
                let watched = if name.starts_with("refs/") {
                    path.ancestors().find(|path| path.exists())
                } else {
                    path.exists().then_some(path.as_path())
                };
                if let Some(watched) = watched {
                    println!("cargo:rerun-if-changed={}", watched.display());
                }
            }
        }
    }
    println!(
        "cargo:rustc-env=BUZZ_NATIVE_SOURCE_REVISION={}",
        identity.revision.as_deref().unwrap_or_default()
    );
    println!(
        "cargo:rustc-env=BUZZ_NATIVE_SOURCE_STATE={}",
        identity.state.as_str()
    );
}

pub fn capture(root: &Path) -> BuildIdentity {
    let repository_root = git(root, &["rev-parse", "--show-toplevel"])
        .and_then(|path| Path::new(path.trim()).canonicalize().ok());
    if repository_root.is_none() || repository_root != root.canonicalize().ok() {
        return compiled(None, None);
    }
    let revision = git(root, &["rev-parse", "--verify", "HEAD^{commit}"]);
    let status = git(
        root,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
        ],
    );
    from_git_outputs(revision.as_deref(), status.as_deref())
}

fn from_git_outputs(revision: Option<&str>, status: Option<&str>) -> BuildIdentity {
    let revision = revision.and_then(valid_revision).map(str::to_owned);
    let state = match (revision.as_ref(), status) {
        (Some(_), Some(status)) => SourceState::parse(Some(if status.trim().is_empty() {
            "clean"
        } else {
            "dirty"
        })),
        _ => SourceState::Unknown,
    };
    BuildIdentity { revision, state }
}

fn valid_revision(value: &str) -> Option<&str> {
    let value = value.trim();
    let valid_length = matches!(value.len(), 40 | 64);
    (valid_length && value.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(value)
}

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(["-C", root.to_str()?])
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).ok())
        .flatten()
}
