//! Read-only host controls and private approval state for a protected worker.
//! Ordinary workspace and runtime-state writes retain the user's access.
use serde::Deserialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProcessProtection {
    pub read_only_paths: Vec<PathBuf>,
    pub hidden_paths: Vec<PathBuf>,
}
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl ProcessProtection {
    /// Paths may be under the user's home, written `~/…`, as directories are.
    pub(crate) fn at_home(mut self) -> Result<Self, String> {
        for path in self
            .read_only_paths
            .iter_mut()
            .chain(&mut self.hidden_paths)
        {
            if let Some(expanded) = path
                .to_str()
                .filter(|text| super::under_home(text).is_some())
                .map(super::expand_home)
            {
                *path = expanded?;
            }
        }
        Ok(self)
    }
    pub(crate) fn profile(&self, controls: &[PathBuf]) -> Result<String, String> {
        let paths = self
            .read_only_paths
            .iter()
            .map(|path| (path, true))
            .chain(self.hidden_paths.iter().chain(controls).map(|p| (p, false)));
        let mut roots = BTreeSet::new();
        let mut ancestors = BTreeSet::new();
        if self.read_only_paths.len() + self.hidden_paths.len() > 128 {
            return Err("Too many protection paths".into());
        }
        for (path, may_be_missing) in paths {
            if !path.is_absolute() || path.as_os_str().len() > 4096 {
                return Err("Protection paths must be absolute".into());
            }
            let original = path.clone();
            let path = path
                .canonicalize()
                .ok()
                .or_else(|| may_be_missing.then(|| missing_leaf(path)).flatten())
                .ok_or("Protection path is unavailable")?;
            for parent in path.ancestors().skip(1).filter(|p| *p != Path::new("/")) {
                ancestors.insert(parent.to_path_buf());
            }
            for parent in original
                .ancestors()
                .skip(1)
                .filter(|p| *p != Path::new("/"))
            {
                ancestors.insert(parent.to_path_buf());
            }
            roots.insert(original);
            roots.insert(path);
        }
        let quote = |p: &Path| {
            let text = p.to_str().ok_or("Invalid protection path")?;
            if text.chars().any(char::is_control) {
                return Err("Protection paths cannot contain control characters");
            }
            serde_json::to_string(text).map_err(|_| "Invalid protection path")
        };
        let mut writes = Vec::new();
        for path in roots {
            writes.push(format!("(subpath {})", quote(&path)?));
        }
        for path in ancestors {
            writes.push(format!("(literal {})", quote(&path)?));
        }
        let mut reads = Vec::new();
        for path in &self.hidden_paths {
            reads.push(format!(
                "(subpath {})",
                quote(
                    &path
                        .canonicalize()
                        .map_err(|_| "Private storage is unavailable")?
                )?
            ));
        }
        Ok(format!("(version 1)\n(allow default)\n(deny appleevent-send)\n(deny mach-lookup (global-name \"com.apple.coreservices.appleevents\"))\n(deny file-write* {})\n{}", writes.join(" "),
            if reads.is_empty() { String::new() } else { format!("(deny file-read* {})\n", reads.join(" ")) }))
    }
}

/// A read-only path that does not exist yet is protected by name below its nearest
/// existing, non-root ancestor, and so are the missing folders between them, so
/// nothing can be created, linked or renamed to it or to any folder on its way.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn missing_leaf(path: &Path) -> Option<PathBuf> {
    let mut tail = vec![];
    let mut existing = path;
    loop {
        match existing.symlink_metadata() {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tail.push(existing.file_name()?);
                existing = existing.parent()?;
            }
            Err(_) => return None,
        }
    }
    let base = existing.canonicalize().ok()?;
    (!tail.is_empty() && base != Path::new("/"))
        .then(|| tail.iter().rev().fold(base, |path, name| path.join(name)))
}

/// Whether [`ProcessProtection::profile`] can protect `path` as read-only.
pub(crate) fn protectable(path: &Path) -> bool {
    path.is_absolute() && (path.canonicalize().is_ok() || missing_leaf(path).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_relative_missing_and_excessive_paths() {
        let mut protection = ProcessProtection {
            read_only_paths: vec![PathBuf::from("relative")],
            hidden_paths: vec![],
        };
        assert!(protection.profile(&[]).is_err());
        // A missing read-only leaf needs an existing parent other than `/`.
        protection.read_only_paths = vec![PathBuf::from("/path-that-does-not-exist-buzz-security")];
        assert!(protection.profile(&[]).is_err());
        let dir = tempfile::tempdir().unwrap();
        protection.read_only_paths = vec![dir.path().join("missing").join("leaf")];
        assert!(
            protection.profile(&[]).is_ok(),
            "missing folders are protected too"
        );
        #[cfg(unix)]
        {
            let link = dir.path().join("dangling");
            std::os::unix::fs::symlink(dir.path().join("absent"), &link).unwrap();
            protection.read_only_paths = vec![link];
            assert!(protection.profile(&[]).is_err());
        }
        protection.read_only_paths = vec![];
        protection.hidden_paths = vec![dir.path().join("missing")];
        assert!(protection.profile(&[]).is_err());
        protection.hidden_paths = vec![];
        assert!(protection.profile(&[dir.path().join("missing")]).is_err());
        protection.read_only_paths = vec![std::env::temp_dir(); 129];
        assert!(protection.profile(&[]).is_err());
    }
    #[test]
    fn protects_a_missing_read_only_leaf_under_its_canonical_parent() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().canonicalize().unwrap();
        let profile = ProcessProtection {
            read_only_paths: vec![dir.path().join("config.tmp")],
            hidden_paths: vec![],
        }
        .profile(&[])
        .unwrap();
        let leaf = serde_json::to_string(parent.join("config.tmp").to_str().unwrap()).unwrap();
        assert!(profile.contains(&format!("(subpath {leaf})")));
    }
    #[test]
    fn paths_may_be_under_home() {
        let protection = ProcessProtection {
            read_only_paths: vec![PathBuf::from("~/tools"), PathBuf::from("/opt/tools")],
            hidden_paths: vec![PathBuf::from("~/private")],
        }
        .at_home()
        .unwrap();
        let home = super::super::expand_home("~").unwrap();
        assert_eq!(
            protection.read_only_paths,
            [home.join("tools"), PathBuf::from("/opt/tools")]
        );
        assert_eq!(protection.hidden_paths, [home.join("private")]);
    }
    #[test]
    #[cfg(unix)]
    fn refuses_control_characters_in_every_protection_path_role() {
        let dir = tempfile::tempdir().unwrap();
        for character in ['\u{1}', '\u{8}', '\u{c}', '\n', '\r', '\t', '\u{7f}'] {
            let path = dir.path().join(format!("private{character}"));
            std::fs::create_dir(&path).unwrap();
            for role in 0..3 {
                let protection = ProcessProtection {
                    read_only_paths: if role == 0 {
                        vec![path.clone()]
                    } else {
                        vec![]
                    },
                    hidden_paths: if role == 1 {
                        vec![path.clone()]
                    } else {
                        vec![]
                    },
                };
                let controls = if role == 2 {
                    vec![path.clone()]
                } else {
                    vec![]
                };
                assert_eq!(
                    protection.profile(&controls).unwrap_err(),
                    "Protection paths cannot contain control characters"
                );
            }
        }
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn kernel_denies_control_writes_and_private_reads_while_workspace_remains_writable() {
        let dir = tempfile::tempdir().unwrap();
        let controls = dir.path().join("controls");
        let private = dir.path().join("private");
        let workspace = dir.path().join("workspace");
        for path in [&controls, &private, &workspace] {
            std::fs::create_dir(path).unwrap();
        }
        let secret = private.join("decision");
        std::fs::write(&secret, "private").unwrap();
        let profile = ProcessProtection {
            read_only_paths: vec![],
            hidden_paths: vec![private],
        }
        .profile(std::slice::from_ref(&controls))
        .unwrap();
        let run = |script: &str, path: &Path| {
            std::process::Command::new("/usr/bin/sandbox-exec")
                .args(["-p", &profile, "/bin/sh", "-c", script, "sandbox-test"])
                .arg(path)
                .output()
                .unwrap()
        };
        assert!(run("printf allowed > \"$1\"", &workspace.join("note"))
            .status
            .success());
        assert!(!run("printf denied > \"$1\"", &controls.join("policy"))
            .status
            .success());
        let denied = run("cat \"$1\"", &secret);
        assert!(!denied.status.success());
        assert!(denied.stdout.is_empty());
        assert_eq!(std::fs::read_to_string(secret).unwrap(), "private");
        assert_eq!(
            std::fs::read_to_string(workspace.join("note")).unwrap(),
            "allowed"
        );
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn kernel_denies_creating_a_missing_read_only_leaf() {
        let dir = tempfile::tempdir().unwrap();
        let leaf = dir.path().join("config.tmp");
        let worker_file = dir.path().join("worker");
        std::fs::write(&worker_file, "worker").unwrap();
        let profile = ProcessProtection {
            read_only_paths: vec![leaf.clone()],
            hidden_paths: vec![],
        }
        .profile(&[])
        .unwrap();
        let run = |script: &str| {
            std::process::Command::new("/usr/bin/sandbox-exec")
                .args(["-p", &profile, "/bin/sh", "-c", script, "sandbox-test"])
                .arg(&leaf)
                .arg(&worker_file)
                .status()
                .unwrap()
                .success()
        };
        for script in [
            "printf planted > \"$1\"",
            "mkdir \"$1\"",
            "mv \"$2\" \"$1\"",
            "ln \"$2\" \"$1\"",
            "ln -s \"$2\" \"$1\"",
        ] {
            assert!(!run(script), "{script}");
            assert!(leaf.symlink_metadata().is_err(), "{script}");
        }
        assert!(run("printf allowed > \"$1.sibling\""));
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn kernel_denies_creating_the_missing_folders_of_a_read_only_path() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("policy");
        let leaf = folder.join("nested").join("managed-plugins.json");
        assert!(protectable(&leaf));
        assert!(!protectable(Path::new(
            "/no-such-buzz-folder/managed-plugins.json"
        )));
        let profile = ProcessProtection {
            read_only_paths: vec![leaf.clone()],
            hidden_paths: vec![],
        }
        .profile(&[])
        .unwrap();
        let run = |script: &str| {
            std::process::Command::new("/usr/bin/sandbox-exec")
                .args(["-p", &profile, "/bin/sh", "-c", script, "sandbox-test"])
                .arg(&folder)
                .arg(&leaf)
                .status()
                .unwrap()
                .success()
        };
        for script in [
            "mkdir -p \"$(dirname \"$2\")\" && printf planted > \"$2\"",
            "mkdir \"$1\"",
            "ln -s /tmp \"$1\"",
        ] {
            assert!(!run(script), "{script}");
            assert!(folder.symlink_metadata().is_err(), "{script}");
        }
        assert!(run("mkdir \"$1.sibling\""));
    }
}
