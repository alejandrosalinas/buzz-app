//! The `SKILL.md` skills in a local agent harness's skill folders, for the
//! composer's `/` menu. Reads each skill's front matter, never its body.
use std::io::Read as _;
use std::path::Path;

const MAX_ROOTS: usize = 8;
const MAX_ENTRIES: usize = 4096;
const MAX_SKILLS: usize = 512;
/// Front matter must end within this; a skill whose block doesn't is skipped.
const HEAD_BYTES: u64 = 16 * 1024;

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalSkill {
    name: String,
    description: String,
    path: String,
    display_path: String,
}

/// `name` and `description` from leading `---` front matter: one-line
/// scalars, or a folded or literal block for the description.
fn front_matter(text: &str) -> Option<(String, String)> {
    let mut lines = text.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let (mut name, mut description, mut block) = (None, String::new(), false);
    for line in lines {
        if line.trim_end() == "---" {
            return name.map(|name| (name, description));
        }
        if block && line.starts_with([' ', '\t']) {
            if !description.is_empty() {
                description.push(' ');
            }
            description.push_str(line.trim());
            continue;
        }
        block = false;
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        let unquoted = [('"', '"'), ('\'', '\'')]
            .iter()
            .find_map(|(open, close)| value.strip_prefix(*open)?.strip_suffix(*close))
            .unwrap_or(value);
        match key {
            "name" if !unquoted.is_empty() => name = Some(unquoted.to_owned()),
            "description" => {
                block = value.starts_with(['>', '|']);
                description = if block {
                    String::new()
                } else {
                    unquoted.to_owned()
                };
            }
            _ => {}
        }
    }
    None
}

/// A leading `$CODEX_HOME` names Codex's home as its launcher resolves it:
/// the variable when set, else `~/.codex`. A relative value names no folder.
fn codex_root(root: &str, codex_home: Option<&str>) -> Option<String> {
    let Some(rest) = root
        .strip_prefix("$CODEX_HOME")
        .filter(|rest| rest.is_empty() || rest.starts_with('/'))
    else {
        return Some(root.to_owned());
    };
    match codex_home.filter(|value| !value.is_empty()) {
        Some(value) if Path::new(value).is_absolute() => Some(format!("{value}{rest}")),
        Some(_) => None,
        None => Some(format!("~/.codex{rest}")),
    }
}

/// Each `<root>/<folder>/SKILL.md` with a named front matter, by name. The
/// first root to name a skill wins, and a missing root lists nothing. Follows
/// linked skill folders, as the harnesses do. Reads only; the caller names the
/// harness's folders.
pub(crate) fn skills(
    roots: &[String],
    home: Option<&Path>,
    codex_home: Option<&str>,
) -> Result<Vec<LocalSkill>, String> {
    if roots.len() > MAX_ROOTS {
        return Err("Too many skill folders.".into());
    }
    let mut found: Vec<LocalSkill> = Vec::new();
    for root in roots {
        let Some(root) = codex_root(root.trim(), codex_home) else {
            continue;
        };
        let root = crate::workspace_folder::expand(&root, home);
        if !root.is_absolute() {
            return Err("A skill folder must be absolute or under ~/.".into());
        }
        let entries = match std::fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Could not list {}: {error}", root.display())),
        };
        for entry in entries.flatten().take(MAX_ENTRIES) {
            let path = entry.path().join("SKILL.md");
            let mut head = Vec::new();
            if std::fs::File::open(&path)
                .and_then(|file| file.take(HEAD_BYTES).read_to_end(&mut head))
                .is_err()
            {
                continue;
            }
            let Some((name, description)) = front_matter(&String::from_utf8_lossy(&head)) else {
                continue;
            };
            let (Some(text), Ok(display_path)) =
                (path.to_str(), crate::workspace_folder::display(&path, home))
            else {
                continue;
            };
            if found.iter().any(|skill| skill.name == name) {
                continue;
            }
            if found.len() == MAX_SKILLS {
                return Err("There are more than 512 skills.".into());
            }
            found.push(LocalSkill {
                name,
                description,
                path: text.to_owned(),
                display_path,
            });
        }
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(found)
}

/// Lists skills for the trusted app renderer, which names the folders of the
/// agent's harness.
#[tauri::command]
pub(crate) async fn local_skills_list<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    roots: Vec<String>,
) -> Result<Vec<LocalSkill>, String> {
    use tauri::Manager as _;
    let home = app.path().home_dir().ok();
    let codex_home = std::env::var("CODEX_HOME").ok();
    crate::host_files::bounded_listing("Listing skills took too long", move || {
        skills(&roots, home.as_deref(), codex_home.as_deref())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_names_and_descriptions_from_front_matter_only() {
        assert_eq!(
            front_matter("---\nname: review\ndescription: \"Reviews a diff\"\n---\nname: body"),
            Some(("review".into(), "Reviews a diff".into()))
        );
        assert_eq!(
            front_matter("---\nname: 'notes'\ndescription: >-\n  Folded\n  lines\nother: x\n---\n"),
            Some(("notes".into(), "Folded lines".into()))
        );
        assert_eq!(front_matter("---\ndescription: unnamed\n---\n"), None);
        assert_eq!(front_matter("name: review\n"), None);
        assert_eq!(front_matter("---\nname: unterminated\n"), None);
    }

    #[test]
    fn lists_each_named_skill_once_by_name() {
        let temp = tempfile::tempdir().unwrap();
        let home = dunce::canonicalize(temp.path()).unwrap();
        let skill = |root: &str, folder: &str, text: &str| {
            let dir = home.join(root).join(folder);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), text).unwrap();
        };
        skill(
            ".claude/skills",
            "write",
            "---\nname: write\ndescription: Prose\n---\n",
        );
        skill(".claude/skills", "plain", "# No front matter\n");
        skill(
            ".agents/skills",
            "dup",
            "---\nname: write\ndescription: Other\n---\n",
        );
        skill(".agents/skills", "audit", "---\nname: audit\n---\n");
        std::fs::write(home.join(".claude/skills/README.md"), "not a skill").unwrap();
        let roots = ["~/.claude/skills", "~/.agents/skills", "~/.missing/skills"].map(String::from);
        let listed = skills(&roots, Some(&home), None).unwrap();
        let names: Vec<_> = listed.iter().map(|skill| skill.name.as_str()).collect();
        assert_eq!(names, ["audit", "write"]);
        assert_eq!(listed[1].description, "Prose");
        assert_eq!(listed[1].display_path, "~/.claude/skills/write/SKILL.md");
        assert_eq!(
            listed[1].path,
            home.join(".claude/skills/write/SKILL.md").to_str().unwrap()
        );
        assert!(skills(&["relative".into()], Some(&home), None).is_err());
        assert!(skills(
            &vec![String::from("~/.claude/skills"); 9],
            Some(&home),
            None
        )
        .is_err());
    }

    #[test]
    fn caps_what_one_listing_reads() {
        let temp = tempfile::tempdir().unwrap();
        let home = dunce::canonicalize(temp.path()).unwrap();
        let root = home.join("skills");
        let skill = |folder: &str, text: &str| {
            std::fs::create_dir_all(root.join(folder)).unwrap();
            std::fs::write(root.join(folder).join("SKILL.md"), text).unwrap();
        };
        // Front matter that does not close within the read head is no skill.
        let padding = "x".repeat(HEAD_BYTES as usize);
        skill(
            "long",
            &format!("---\nname: long\ndescription: {padding}\n---\n"),
        );
        skill("short", "---\nname: short\n---\n");
        let roots = ["~/skills".to_string()];
        let names: Vec<_> = skills(&roots, Some(&home), None)
            .unwrap()
            .into_iter()
            .map(|skill| skill.name)
            .collect();
        assert_eq!(names, ["short"]);
        for index in 0..MAX_SKILLS {
            skill(&format!("s{index}"), &format!("---\nname: s{index}\n---\n"));
        }
        assert_eq!(
            skills(&roots, Some(&home), None).unwrap_err(),
            "There are more than 512 skills."
        );
    }

    #[cfg(unix)]
    #[test]
    fn follows_a_linked_skill_folder() {
        let temp = tempfile::tempdir().unwrap();
        let home = dunce::canonicalize(temp.path()).unwrap();
        let shared = home.join("shared/review");
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::write(shared.join("SKILL.md"), "---\nname: review\n---\n").unwrap();
        std::fs::create_dir_all(home.join(".codex/skills")).unwrap();
        std::os::unix::fs::symlink(&shared, home.join(".codex/skills/review")).unwrap();
        let listed = skills(&["~/.codex/skills".into()], Some(&home), None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].display_path, "~/.codex/skills/review/SKILL.md");
    }

    #[test]
    fn reads_codex_skills_from_the_launcher_home() {
        let temp = tempfile::tempdir().unwrap();
        let home = dunce::canonicalize(temp.path()).unwrap();
        for (root, name) in [
            (".codex/skills/a", "default"),
            ("profile/skills/a", "profile"),
        ] {
            std::fs::create_dir_all(home.join(root)).unwrap();
            std::fs::write(
                home.join(root).join("SKILL.md"),
                format!("---\nname: {name}\n---\n"),
            )
            .unwrap();
        }
        let names = |codex_home: Option<&str>| -> Vec<String> {
            skills(&["$CODEX_HOME/skills".into()], Some(&home), codex_home)
                .unwrap()
                .into_iter()
                .map(|skill| skill.name)
                .collect()
        };
        let profile = home.join("profile");
        assert_eq!(names(Some(profile.to_str().unwrap())), ["profile"]);
        assert_eq!(names(None), ["default"]);
        assert_eq!(names(Some("")), ["default"]);
        assert!(
            names(Some("profile")).is_empty(),
            "A relative home names no folder"
        );
        assert!(
            skills(&["$CODEX_HOMES/skills".into()], Some(&home), None).is_err(),
            "Only the whole variable name is replaced"
        );
    }
}
