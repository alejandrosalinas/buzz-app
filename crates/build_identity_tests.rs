use super::build_identity::{capture, compiled, BuildIdentity, SourceState};
use std::{fs, path::Path, process::Command};

fn run_git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(["-C", root.to_str().unwrap()])
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", root.join(".unused-global-git-config"))
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "git {:?} failed", args);
}

#[test]
fn reports_distinct_source_states_without_promoting_unknown_to_clean() {
    let revision = "a".repeat(40);
    assert_eq!(
        compiled(Some(&revision), Some("clean")),
        BuildIdentity {
            revision: Some(revision.clone()),
            state: SourceState::Clean,
        }
    );
    assert_eq!(
        compiled(Some(&revision), Some("dirty")),
        BuildIdentity {
            revision: Some(revision),
            state: SourceState::Dirty,
        }
    );
    assert_eq!(
        compiled(None, Some("clean")),
        BuildIdentity {
            revision: None,
            state: SourceState::Unknown,
        }
    );
    assert_eq!(
        compiled(Some(&"c".repeat(40)), Some("dirty")).state,
        SourceState::Dirty
    );
    assert_eq!(
        compiled(Some(&"c".repeat(40)), Some("unrecognized")).state,
        SourceState::Unknown
    );
    assert_eq!(
        compiled(Some("not-a-revision"), Some("clean")),
        BuildIdentity {
            revision: None,
            state: SourceState::Unknown,
        }
    );
    assert_eq!(
        compiled(Some(&"b".repeat(40)), None).state,
        SourceState::Unknown
    );
}

#[test]
fn source_archives_without_git_remain_buildable_and_unknown() {
    let directory = tempfile::tempdir().unwrap();
    assert_eq!(
        capture(directory.path()),
        BuildIdentity {
            revision: None,
            state: SourceState::Unknown,
        }
    );
    let root = directory.path();
    run_git(root, &["init", "--quiet", "--template="]);
    run_git(root, &["config", "user.name", "Build identity test"]);
    run_git(
        root,
        &["config", "user.email", "build-identity@example.org"],
    );
    run_git(root, &["config", "commit.gpgsign", "false"]);
    fs::write(root.join(".gitignore"), "archive/\n").unwrap();
    run_git(root, &["add", "."]);
    run_git(root, &["commit", "--quiet", "-m", "enclosing source"]);
    let archive = root.join("archive");
    fs::create_dir(&archive).unwrap();
    assert_eq!(capture(&archive), compiled(None, None));
}

#[test]
fn reports_repository_changes_outside_the_native_manifest_directory() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let native = root.join("src-tauri");
    let crate_source = root.join("crates/build_identity.rs");
    fs::create_dir_all(&native).unwrap();
    fs::create_dir_all(crate_source.parent().unwrap()).unwrap();
    fs::write(native.join("build.rs"), "fn main() {}\n").unwrap();
    fs::write(&crate_source, "pub fn source() {}\n").unwrap();

    run_git(root, &["init", "--quiet", "--template="]);
    run_git(root, &["config", "user.name", "Build identity test"]);
    run_git(root, &["config", "commit.gpgsign", "false"]);
    run_git(
        root,
        &["config", "user.email", "build-identity@example.org"],
    );
    run_git(root, &["add", "."]);
    run_git(root, &["commit", "--quiet", "-m", "initial source"]);

    fs::write(&crate_source, "pub fn source() { /* changed */ }\n").unwrap();

    assert_eq!(capture(root).state, SourceState::Dirty);
}

#[test]
fn incremental_native_build_refreshes_dependency_and_git_only_changes() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("repository");
    let native = root.join("src-tauri");
    fs::create_dir_all(native.join("src")).unwrap();
    fs::create_dir_all(root.join("dependency/src")).unwrap();
    fs::create_dir_all(root.join("crates")).unwrap();
    fs::create_dir_all(root.join("src/bundled/mesh-compute/compute")).unwrap();
    for (path, contents) in [
        ("src/features/archive/schema.sql", "schema"),
        ("src/bundled/example/manifest.json", "manifest"),
        ("public/example.svg", "asset"),
    ] {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }
    fs::write(root.join(".gitignore"), "/target/\n").unwrap();
    fs::write(
        root.join("Cargo.toml"),
        "[workspace]\nmembers = [\"src-tauri\", \"dependency\"]\nresolver = \"2\"\n",
    )
    .unwrap();
    fs::write(
        native.join("Cargo.toml"),
        "[package]\nname = \"identity-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\
         [dependencies]\nidentity-dependency = { path = \"../dependency\" }\n\
         [build-dependencies]\nserde = { version = \"1\", features = [\"derive\"] }\n",
    )
    .unwrap();
    let dependency_manifest = root.join("dependency/Cargo.toml");
    let manifest =
        "[package]\nname = \"identity-dependency\"\nversion = \"0.1.0\"\nedition = \"2021\"\n";
    fs::write(&dependency_manifest, manifest).unwrap();
    fs::write(
        root.join("dependency/src/lib.rs"),
        "pub fn version() -> &'static str { env!(\"CARGO_PKG_VERSION\") }\n",
    )
    .unwrap();
    fs::write(
        root.join("crates/build_identity.rs"),
        include_str!("build_identity.rs"),
    )
    .unwrap();
    fs::write(root.join("src/bundled/mesh-compute/compute/.keep"), "").unwrap();
    fs::write(
        native.join("build.rs"),
        r#"#[path = "../crates/build_identity.rs"]
mod build_identity;
fn main() {
    use std::io::Write;
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    std::fs::OpenOptions::new().create(true).append(true)
        .open(manifest.join("../target/identity-build-count")).unwrap()
        .write_all(b"build\n").unwrap();
    build_identity::configure_native_build(manifest);
}
"#,
    )
    .unwrap();
    fs::write(
        native.join("src/main.rs"),
        r#"fn main() {
    println!("{} {} {} {}|{}|{}", env!("BUZZ_NATIVE_SOURCE_REVISION"),
        env!("BUZZ_NATIVE_SOURCE_STATE"), identity_dependency::version(),
        include_str!("../../src/features/archive/schema.sql"),
        include_str!("../../src/bundled/example/manifest.json"),
        include_str!("../../public/example.svg"));
}
"#,
    )
    .unwrap();
    let cargo = |root: &Path, command: &str| {
        let output = Command::new(env!("CARGO"))
            .args([command, "--offline", "--quiet", "-p", "identity-fixture"])
            .current_dir(root)
            .env_remove("CARGO_TARGET_DIR")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", root.join(".unused-global-git-config"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "cargo {command} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    cargo(&root, "build");
    run_git(&root, &["init", "--quiet", "--template="]);
    run_git(&root, &["config", "user.name", "Build identity test"]);
    run_git(
        &root,
        &["config", "user.email", "build-identity@example.org"],
    );
    run_git(&root, &["config", "commit.gpgsign", "false"]);
    run_git(&root, &["add", "."]);
    run_git(&root, &["commit", "--quiet", "-m", "initial source"]);
    let worktree = directory.path().join("worktree");
    run_git(
        &root,
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "fixture",
            worktree.to_str().unwrap(),
        ],
    );
    let revision = capture(&worktree).revision.unwrap();
    assert_eq!(
        cargo(&worktree, "run"),
        format!("{revision} clean 0.1.0 schema|manifest|asset")
    );
    let build_count = || {
        fs::read(worktree.join("target/identity-build-count"))
            .unwrap()
            .len()
    };
    let initial_count = build_count();
    run_git(
        &worktree,
        &["update-ref", "refs/remotes/origin/fixture", "HEAD"],
    );
    assert_eq!(
        cargo(&worktree, "run"),
        format!("{revision} clean 0.1.0 schema|manifest|asset")
    );
    assert_eq!(
        build_count(),
        initial_count,
        "unrelated remote ref rebuilt native image"
    );

    for (path, original, expected) in [
        (
            "src/features/archive/schema.sql",
            "schema",
            "changed|manifest|asset",
        ),
        (
            "src/bundled/example/manifest.json",
            "manifest",
            "schema|changed|asset",
        ),
        ("public/example.svg", "asset", "schema|manifest|changed"),
    ] {
        fs::write(worktree.join(path), "changed").unwrap();
        assert_eq!(
            cargo(&worktree, "run"),
            format!("{revision} dirty 0.1.0 {expected}"),
            "included input {path} did not refresh native source state"
        );
        fs::write(worktree.join(path), original).unwrap();
        assert_eq!(
            cargo(&worktree, "run"),
            format!("{revision} clean 0.1.0 schema|manifest|asset")
        );
    }

    // Cargo relinks a normal dependency, without changing the build script or Rust sources.
    fs::write(
        worktree.join("dependency/Cargo.toml"),
        manifest.replace("0.1.0", "0.2.0"),
    )
    .unwrap();
    assert_eq!(
        cargo(&worktree, "run"),
        format!("{revision} dirty 0.2.0 schema|manifest|asset")
    );

    run_git(&worktree, &["add", "."]);
    run_git(&worktree, &["commit", "--quiet", "-m", "update dependency"]);
    let revision = capture(&worktree).revision.unwrap();
    assert_eq!(
        cargo(&worktree, "run"),
        format!("{revision} clean 0.2.0 schema|manifest|asset")
    );
    run_git(&worktree, &["pack-refs", "--all"]);
    assert_eq!(
        cargo(&worktree, "run"),
        format!("{revision} clean 0.2.0 schema|manifest|asset")
    );
    let packed_count = build_count();
    assert_eq!(
        cargo(&worktree, "run"),
        format!("{revision} clean 0.2.0 schema|manifest|asset")
    );
    assert_eq!(
        build_count(),
        packed_count,
        "unchanged packed ref rebuilt native image"
    );
    run_git(
        &root,
        &[
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "unrelated branch",
        ],
    );
    assert_eq!(
        cargo(&worktree, "run"),
        format!("{revision} clean 0.2.0 schema|manifest|asset")
    );
    assert_eq!(
        build_count(),
        packed_count,
        "unrelated worktree commit rebuilt native image"
    );
    run_git(&worktree, &["config", "core.logAllRefUpdates", "false"]);
    run_git(
        &worktree,
        &[
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "move packed ref",
        ],
    );
    let revision = capture(&worktree).revision.unwrap();
    assert_eq!(
        cargo(&worktree, "run"),
        format!("{revision} clean 0.2.0 schema|manifest|asset")
    );

    fs::remove_file(root.join(".git/logs/refs/heads/fixture")).unwrap();
    run_git(&worktree, &["pack-refs", "--all"]);
    assert_eq!(
        cargo(&worktree, "run"),
        format!("{revision} clean 0.2.0 schema|manifest|asset")
    );
    run_git(
        &worktree,
        &["commit", "--quiet", "--allow-empty", "-m", "without reflog"],
    );
    let revision = capture(&worktree).revision.unwrap();
    assert_eq!(
        cargo(&worktree, "run"),
        format!("{revision} clean 0.2.0 schema|manifest|asset")
    );
}
