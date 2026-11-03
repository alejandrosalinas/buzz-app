//! Buzz was `dev.local.buzz.foundation` before 1.0. Its first launch as
//! `xyz.block.buzz.desktop` renames what Tauri and the WebView keep under the
//! old identifier, with any sign-out trash and pending sign-out marker, so an
//! update keeps its data and still finishes a sign-out the old build committed.
//! Development builds shared that storage until they became `.dev`; the first
//! development launch copies the installed app's, leaving it in place. They
//! still share its Agents folder (`agents`).
use super::{agents_stopped, marker_name, trash, wait_for, AGENTS};
use std::fs::{self, File};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub(crate) const LEGACY: &str = "dev.local.buzz.foundation";
pub(crate) const CURRENT: &str = "xyz.block.buzz.desktop";
/// What `just desktop` and debug bundles run as on main. The onboarding-test
/// branch runs as its own identifier instead (`scripts/desktop-config.mjs`).
pub(crate) const DEV: &str = "xyz.block.buzz.desktop.dev";
const BUSY: &str = "Quit every other Buzz window, then open Buzz again to finish moving its storage. Nothing was moved.";
const AGENT_STOPPING: &str =
    "An agent is still stopping. Open Buzz again in a moment to finish moving its storage.";
const FAILED: &str = "Buzz couldn't finish moving its storage. Open Buzz again to retry.";
const SIGN_OUT_PENDING: &str = "Open the installed Buzz to finish signing out, then open this build again. Nothing was copied.";

/// Each path the legacy identifier names, with its new name. The release
/// identifier takes them all; development (`.dev`) only its own pending sign-out,
/// copying the rest (`seeds`); test identifiers none.
pub(super) fn moves(identifier: &str) -> Option<Vec<(PathBuf, PathBuf)>> {
    if identifier != CURRENT && identifier != DEV {
        return Some(Vec::new());
    }
    let data = dirs::data_dir()?;
    let service = buzz_credential_store::HUMAN_STORE;
    let marker = (
        data.join(marker_name(LEGACY, service)),
        data.join(marker_name(identifier, service)),
    );
    if identifier == DEV {
        return Some(vec![marker]);
    }
    // Where Tauri resolves app data, config, local data (the Windows and Linux
    // WebView) and cache, and macOS keeps WebKit storage.
    let mut bases = vec![
        data.clone(),
        dirs::config_dir()?,
        dirs::data_local_dir()?,
        dirs::cache_dir()?,
    ];
    #[cfg(target_os = "macos")]
    bases.push(dirs::home_dir()?.join("Library/WebKit"));
    bases.sort();
    bases.dedup();
    let mut moves: Vec<_> = bases
        .iter()
        .flat_map(|base| {
            let (old, new) = (base.join(LEGACY), base.join(CURRENT));
            [(trash(&old), trash(&new)), (old, new)]
        })
        .collect();
    moves.push(marker);
    Some(moves)
}

/// Where a first development launch copies the installed app's folders: config,
/// local data (the Windows and Linux WebView), macOS WebKit storage, and app data
/// last, since its copy marks the seed finished. Separate caches are left. None
/// unless this is the development identifier.
pub(super) fn seeds(identifier: &str) -> Option<Vec<PathBuf>> {
    if identifier != DEV {
        return Some(Vec::new());
    }
    let data = dirs::data_dir()?;
    let mut bases = vec![dirs::config_dir()?, dirs::data_local_dir()?];
    #[cfg(target_os = "macos")]
    bases.push(dirs::home_dir()?.join("Library/WebKit"));
    bases.retain(|base| *base != data);
    bases.sort();
    bases.dedup();
    bases.push(data);
    Some(bases)
}

/// The Agents folder for the app data at `app_data`. Development builds use the
/// installed app's, as they did before they became `.dev`, so both share one
/// agent list, its state and its hosting locks. Only while legacy storage is
/// still due to move do they keep their own: creating release storage beside it
/// would make the next release launch refuse to start.
pub(crate) fn agents(identifier: &str, app_data: &Path) -> PathBuf {
    let release = app_data.with_file_name(CURRENT);
    if identifier == DEV && (release.is_dir() || !app_data.with_file_name(LEGACY).exists()) {
        return release.join(AGENTS);
    }
    app_data.join(AGENTS)
}

/// Rename each legacy path that is still due, before this launch takes its
/// locks, once no other Buzz or agent runs. A failure exits; the next launch
/// resumes with what is still due.
#[allow(clippy::incompatible_msrv)] // File locking, like the owning sign_out module.
pub(super) fn migrate(
    moves: &[(PathBuf, PathBuf)],
    seeds: &[PathBuf],
    all: &File,
    ownership: &Path,
) -> Result<(), String> {
    // Every Buzz, older builds included, holds the all-Buzz lock shared while
    // it runs. Without the lock a scan is only a hint: one that finished the move
    // leaves nothing due, but a conflict may be a rename seen half done.
    let mut done = false;
    let ready = wait_for(|| {
        done =
            matches!(due(moves), Ok(due) if due.is_empty()) && matches!(seeding(seeds), Ok(false));
        if done {
            Ok(())
        } else {
            all.try_lock()
        }
    });
    if !ready {
        return Err(BUSY.into());
    }
    if done {
        return Ok(());
    }
    let moved = (|| {
        // Look again under the lock, so a conflict is reported before any wait.
        if due(moves)?.is_empty() && !seeding(seeds)? {
            return Ok(());
        }
        // An agent still stopping may write its folders; look once more after.
        if !wait_for(|| agents_stopped(ownership)) {
            return Err(AGENT_STOPPING.to_owned());
        }
        for (old, new) in due(moves)? {
            fs::rename(old, new).map_err(failed)?;
        }
        if seeding(seeds)? {
            seed(seeds).map_err(failed)?;
        }
        Ok(())
    })();
    all.unlock().map_err(failed)?;
    moved
}

/// The pairs still to move. Both paths present, after a rollback to an older
/// build for instance, refuses every move and any pending sign-out: neither copy
/// is safely the one to keep, and an erase would miss the legacy one. The refusal
/// names every such pair, so one round of moving them aside is enough.
fn due(moves: &[(PathBuf, PathBuf)]) -> Result<Vec<&(PathBuf, PathBuf)>, String> {
    let (mut due, mut conflicts) = (Vec::new(), String::new());
    for pair in moves {
        match (
            present(&pair.0).map_err(failed)?,
            present(&pair.1).map_err(failed)?,
        ) {
            (true, true) => conflicts.push_str(&format!(
                "\n{} beside {}",
                pair.0.display(),
                pair.1.display()
            )),
            (true, false) => due.push(pair),
            _ => {}
        }
    }
    if !conflicts.is_empty() {
        return Err(format!(
            "Buzz found storage from before 1.0 beside this version's:{conflicts}\nMove one of each pair elsewhere, then open Buzz again. Nothing was moved."
        ));
    }
    Ok(due)
}

/// Whether this development launch lacks app data the installed app has. It
/// refuses while the installed app has a sign-out to finish, so storage the user
/// asked to erase is never copied.
fn seeding(bases: &[PathBuf]) -> Result<bool, String> {
    let Some(data) = bases.last() else {
        return Ok(false);
    };
    if present(&data.join(DEV)).map_err(failed)? {
        return Ok(false);
    }
    let release = buzz_credential_store::human_store(false);
    let mut due = false;
    for source in [CURRENT, LEGACY] {
        if present(&data.join(marker_name(source, release))).map_err(failed)? {
            return Err(SIGN_OUT_PENDING.into());
        }
        due |= data.join(source).exists();
    }
    Ok(due)
}

/// Copy each folder this launch lacks through a sibling renamed into place, so
/// an interrupted seed leaves only what the next launch discards and redoes.
/// Each comes from wherever the installed app keeps it, since a release move
/// cut short leaves some under each name.
fn seed(bases: &[PathBuf]) -> std::io::Result<()> {
    for base in bases {
        let to = base.join(DEV);
        let Some(from) = [CURRENT, LEGACY]
            .map(|source| base.join(source))
            .into_iter()
            .find(|from| from.exists())
        else {
            continue;
        };
        if present(&to)? {
            continue;
        }
        let partial = base.join(format!("{DEV}.seeding"));
        match fs::remove_dir_all(&partial) {
            Err(error) if error.kind() != ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        // Development builds keep history in `archive-debug` (`archive/mod.rs`).
        let skip = (Some(base) == bases.last()).then_some("archive");
        // A linked folder copies what it links to, so the copy stands apart.
        copy(&fs::canonicalize(from)?, &partial, skip)?;
        fs::rename(&partial, &to)?;
    }
    Ok(())
}

/// Copies a tree with who else may read its folders (on Unix), leaving out
/// `skip` at its top and any link or special file inside, so the copy shares
/// nothing with the source.
fn copy(from: &Path, to: &Path, skip: Option<&str>) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(from)?;
    if metadata.is_dir() {
        fs::create_dir(to)?;
        // Never a folder its owner can't fill or clear, so an interrupted copy
        // is removed on retry.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = metadata.permissions().mode() | 0o700;
            fs::set_permissions(to, fs::Permissions::from_mode(mode))?;
        }
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            if skip.is_some_and(|skip| entry.file_name() == skip) {
                continue;
            }
            copy(&entry.path(), &to.join(entry.file_name()), None)?;
        }
    } else if metadata.is_file() {
        fs::copy(from, to)?;
    } else {
        eprintln!(
            "buzz: copy development storage: left out {}",
            from.display()
        );
    }
    Ok(())
}

fn failed(error: std::io::Error) -> String {
    eprintln!("buzz: move legacy storage: {error}");
    FAILED.to_owned()
}

/// Whether anything is at `path`. A link counts and is never followed: renaming
/// it moves the link, never what it points to.
fn present(path: &Path) -> std::io::Result<bool> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        other => other.map(|_| true),
    }
}
