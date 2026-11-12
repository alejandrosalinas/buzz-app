use std::path::Path;

/// Read-only validation. Never creates a folder, replaces a symlink, or moves repositories.
fn validate(value: &str, home: Option<&Path>) -> Result<String, String> {
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return Err("Choose a valid repositories folder.".into());
    }
    let path = crate::workspace_folder::expand(value.trim(), home);
    if !path.is_absolute() {
        return Err("Choose an absolute folder path or a path under ~/.".into());
    }
    let path = path
        .canonicalize()
        .map_err(|_| "The repositories folder is unavailable. Choose an existing folder.")?;
    if !path.is_dir() || std::fs::read_dir(&path).is_err() {
        return Err("Choose a folder you can access, not a file.".into());
    }
    crate::workspace_folder::display(&path, home)
}

const MAX_ENTRIES: usize = 4096;
pub(crate) const LATE: &str = "Listing the repositories folder took too long";
const MAX_BYTES: usize = 1024 * 1024;

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryFolder {
    name: String,
    path: String,
    display_path: String,
}

/// The configured folder's immediate real directories, by name, with absolute
/// paths. Follows the folder itself if it is a symbolic link, never a child
/// one. Rejects past 4096 entries or a 1 MiB result, never returning part of a
/// listing. Reads only; the caller supplies the configured folder.
pub(crate) fn folders(value: &str, home: Option<&Path>) -> Result<Vec<RepositoryFolder>, String> {
    let unavailable = || "The configured repositories folder is unavailable.".to_string();
    let path = crate::workspace_folder::expand(value.trim(), home);
    if value.len() > 8192 || value.chars().any(char::is_control) || !path.is_absolute() {
        return Err(unavailable());
    }
    // `dunce` keeps Windows paths in their ordinary `C:\…` form.
    let root = dunce::canonicalize(&path).map_err(|_| unavailable())?;
    if !root.is_dir() {
        return Err(unavailable());
    }
    let failed = |error| format!("Could not list the repositories folder: {error}");
    let mut children = Vec::new();
    let mut bytes = 2; // JSON array brackets, plus each entry and comma below.
    for (index, entry) in std::fs::read_dir(&root).map_err(failed)?.enumerate() {
        if index >= MAX_ENTRIES {
            return Err("The repositories folder has more than 4096 entries.".into());
        }
        let entry = entry.map_err(failed)?;
        if !entry.file_type().map_err(failed)?.is_dir() {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "The repositories folder has a non-UTF-8 folder name.".to_string())?;
        let path = root.join(&name);
        let child = RepositoryFolder {
            display_path: crate::workspace_folder::display(&path, home)?,
            path: path
                .into_os_string()
                .into_string()
                .map_err(|_| "The repositories folder is not a UTF-8 path.".to_string())?,
            name,
        };
        bytes += serde_json::to_vec(&child)
            .map_err(|error| error.to_string())?
            .len()
            + usize::from(!children.is_empty());
        if bytes > MAX_BYTES {
            return Err("The repositories folder listing is larger than 1 MiB.".into());
        }
        children.push(child);
    }
    children.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(children)
}

/// Lists `path` for the trusted app renderer, which reads the configured
/// folder from its community and account. Native code does not know that
/// preference; it checks only the folder it lists. Plugins use
/// `plugin_host_repository_folders`, which checks their file grant first.
#[tauri::command]
pub(crate) async fn repositories_folder_list<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<Vec<RepositoryFolder>, String> {
    use tauri::Manager as _;
    let home = app.path().home_dir().ok();
    crate::host_files::bounded_listing(LATE, move || folders(&path, home.as_deref())).await
}

#[tauri::command]
pub(crate) async fn repositories_folder_validate<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<String, String> {
    use tauri::Manager as _;
    let home = app.path().home_dir().ok();
    tauri::async_runtime::spawn_blocking(move || validate(&path, home.as_deref()))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_existing_accessible_directories_are_accepted_without_mutation() {
        let root = std::env::temp_dir().join(format!("buzz-repositories-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("checkout.txt");
        std::fs::write(&file, "keep this checkout").unwrap();
        let home = root.canonicalize().unwrap();
        for value in ["~", "~/", home.to_str().unwrap()] {
            assert_eq!(validate(value, Some(&home)).unwrap(), "~");
        }
        assert!(validate("relative", Some(&root)).is_err());
        assert!(validate(file.to_str().unwrap(), Some(&root)).is_err());
        assert!(validate(root.join("missing").to_str().unwrap(), Some(&root)).is_err());
        assert!(!root.join("missing").exists());
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "keep this checkout"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lists_only_immediate_real_directories_in_name_order() {
        let home = tempfile::tempdir().unwrap();
        let home = dunce::canonicalize(home.path()).unwrap();
        let root = home.join("repos");
        std::fs::create_dir_all(root.join("z-source/nested")).unwrap();
        std::fs::create_dir(root.join("a-not-git")).unwrap();
        std::fs::write(root.join("file"), "not a directory").unwrap();
        let listed = folders("~/repos", Some(&home)).unwrap();
        assert_eq!(
            listed,
            ["a-not-git", "z-source"].map(|name| RepositoryFolder {
                name: name.into(),
                path: root.join(name).to_str().unwrap().into(),
                display_path: format!("~/repos/{name}"),
            })
        );
        assert_eq!(folders(root.to_str().unwrap(), None).unwrap().len(), 2);
        let missing = root.join("absent");
        assert!(folders(missing.to_str().unwrap(), None).is_err());
        assert!(!missing.exists());
        assert!(folders(root.join("file").to_str().unwrap(), None).is_err());
        assert!(folders("relative", Some(&home)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn follows_a_linked_folder_but_not_linked_children_and_keeps_permission_errors() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(outside.path().join("checkout")).unwrap();
        symlink(outside.path(), root.path().join("linked")).unwrap();
        symlink(root.path().join("missing"), root.path().join("dangling")).unwrap();
        assert!(folders(root.path().to_str().unwrap(), None)
            .unwrap()
            .is_empty());
        let linked = folders(root.path().join("linked").to_str().unwrap(), None).unwrap();
        assert_eq!(linked[0].name, "checkout");
        assert_eq!(
            Path::new(&linked[0].path).parent(),
            Some(dunce::canonicalize(outside.path()).unwrap().as_path())
        );
        if unsafe { libc::geteuid() } != 0 {
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o000)).unwrap();
            let result = folders(root.path().to_str().unwrap(), None);
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
            assert!(result.is_err());
        }
    }

    #[test]
    fn rejects_entry_and_serialized_output_overflow() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..MAX_ENTRIES {
            std::fs::write(root.path().join(index.to_string()), "").unwrap();
        }
        assert!(folders(root.path().to_str().unwrap(), None)
            .unwrap()
            .is_empty());
        std::fs::write(root.path().join("overflow"), "").unwrap();
        assert!(folders(root.path().to_str().unwrap(), None)
            .unwrap_err()
            .contains("4096"));
        let root = tempfile::tempdir().unwrap();
        for index in 0..2000 {
            std::fs::create_dir(root.path().join(format!("{index:04}{}", "x".repeat(196))))
                .unwrap();
        }
        assert!(folders(root.path().to_str().unwrap(), None)
            .unwrap_err()
            .contains("1 MiB"));
    }
}
