//! Links `~/.local/bin/buzz` to the CLI bundled in the running app, so `buzz`
//! works in a terminal. Startup relinks a dangling link or one to a Buzz app's
//! CLI, so that link follows updates and moves; a link to another CLI stays.
//! Agents don't need it: `buzz-agent-command` puts its own `buzz` first.
use std::path::{Component, Path};

/// A `tauri dev` run, or a debug build, which a packaged debug bundle is
/// though it keeps the release identifier.
pub(crate) fn development(tauri_dev: bool) -> bool {
    tauri_dev || cfg!(debug_assertions)
}

/// Whether this app owns the link: only the installed release does. A
/// development build's would
/// dangle once its worktree goes, and an AppImage, a mounted disk image or an
/// App Translocation copy runs from a place that goes away.
pub(crate) fn owns(development: bool, identifier: &str, appimage: bool, cli: &Path) -> bool {
    !development
        && !appimage
        && !cli.starts_with("/Volumes")
        && !cli
            .components()
            .any(|part| part == Component::Normal("AppTranslocation".as_ref()))
        && identifier == crate::sign_out::legacy_identifier::CURRENT
}

/// Points `local_bin/buzz` at `cli`. Replaces a symlink that dangles or points
/// at a Buzz app's CLI, and leaves any other link, file or directory alone.
pub(crate) fn ensure(local_bin: &Path, cli: &Path) -> std::io::Result<()> {
    let link = local_bin.join("buzz");
    match link.symlink_metadata() {
        Ok(meta) if meta.file_type().is_symlink() => {
            let target = std::fs::read_link(&link)?;
            if target == cli {
                return Ok(());
            }
            let buzz = target.ends_with("Contents/Resources/bin/buzz")
                || target.ends_with("Buzz.app/Contents/MacOS/buzz");
            if link.exists() && !buzz {
                return Ok(());
            }
            std::fs::remove_file(&link)?;
        }
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(local_bin)?;
        }
        Err(error) => return Err(error),
    }
    std::os::unix::fs::symlink(cli, link)
}

#[cfg(test)]
mod tests {
    use super::{development, ensure, owns};
    use crate::sign_out::legacy_identifier::CURRENT;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::Path;

    /// A packaged debug bundle keeps the release identifier and isn't
    /// `tauri dev`; this debug test build stands in for it by profile.
    #[test]
    fn only_the_installed_release_owns_the_link() {
        assert!(
            cfg!(debug_assertions) && development(false),
            "a debug build is development"
        );
        let cli = Path::new("/Applications/Buzz.app/Contents/Resources/bin/buzz");
        assert!(!owns(development(false), CURRENT, false, cli));
        assert!(owns(false, CURRENT, false, cli));
        assert!(!owns(false, CURRENT, true, cli));
        assert!(!owns(false, "xyz.block.buzz.desktop.dev", false, cli));
        for temporary in [
            "/Volumes/Buzz/Buzz.app/Contents/Resources/bin/buzz",
            "/private/var/folders/x/AppTranslocation/1/d/Buzz.app/Contents/Resources/bin/buzz",
        ] {
            assert!(!owns(false, CURRENT, false, Path::new(temporary)));
        }
    }

    #[test]
    fn links_replaces_buzz_links_and_leaves_others() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let (cli, other) = (root.join("cli"), root.join("other"));
        let local_bin = root.join(".local/bin");
        let link = local_bin.join("buzz");
        ensure(&local_bin, &cli).unwrap();
        assert_eq!(
            fs::read_link(&link).unwrap(),
            cli,
            "created with its directory"
        );
        fs::remove_file(&link).unwrap();
        symlink(&other, &link).unwrap();
        ensure(&local_bin, &cli).unwrap();
        ensure(&local_bin, &cli).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), cli, "relinked");
        let bundled = root.join("Old.app/Contents/Resources/bin/buzz");
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, "").unwrap();
        fs::remove_file(&link).unwrap();
        symlink(&bundled, &link).unwrap();
        ensure(&local_bin, &cli).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), cli, "another Buzz's CLI");
        let custom = root.join("src/buzz/target/release/buzz");
        fs::create_dir_all(custom.parent().unwrap()).unwrap();
        fs::write(&custom, "").unwrap();
        fs::remove_file(&link).unwrap();
        symlink(&custom, &link).unwrap();
        ensure(&local_bin, &cli).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), custom, "the user's CLI");
        fs::remove_file(&link).unwrap();
        fs::write(&link, "mine").unwrap();
        ensure(&local_bin, &cli).unwrap();
        assert_eq!(fs::read_to_string(&link).unwrap(), "mine");
        fs::remove_file(&link).unwrap();
        fs::create_dir(&link).unwrap();
        ensure(&local_bin, &cli).unwrap();
        assert!(link.is_dir());
    }
}
