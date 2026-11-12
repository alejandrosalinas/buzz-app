//! Git imports against real repositories: pinned commits, folder scope and partial clones.
use super::*;
use std::{
    io::{BufRead, BufReader},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

fn plain(directory: &Path, args: &[&str], input: &[u8]) -> String {
    let mut child = Command::new("git")
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .args(["-C"])
        .arg(directory)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

/// A bare repository that serves filtered fetches, like a Git host.
struct Hosted {
    dir: tempfile::TempDir,
    heads: BTreeMap<String, String>,
    clock: u64,
}
impl Hosted {
    fn new(format: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        plain(
            dir.path(),
            &[
                "init",
                "--bare",
                "--initial-branch=main",
                &format!("--object-format={format}"),
                "server.git",
            ],
            b"",
        );
        let hosted = Self {
            dir,
            heads: BTreeMap::new(),
            clock: 1_700_000_000,
        };
        hosted.configure("uploadpack.allowFilter", "true");
        hosted.configure("uploadpack.allowAnySHA1InWant", "true");
        hosted
    }
    fn path(&self) -> PathBuf {
        self.dir.path().join("server.git")
    }
    fn url(&self) -> String {
        format!("file://{}", self.path().display())
    }
    fn configure(&self, key: &str, value: &str) {
        plain(&self.path(), &["config", key, value], b"");
    }
    /// Commits `files` on `branch`, on top of the branch's last commit when it has one.
    fn commit(&mut self, branch: &str, files: &[(String, String)]) -> String {
        self.clock += 60;
        let mut stream = format!(
            "commit refs/heads/{branch}\ncommitter Fixture <fixture@example.invalid> {} +0000\ndata 1\nc\n",
            self.clock
        );
        if let Some(parent) = self.heads.get(branch) {
            stream.push_str(&format!("from {parent}\n"));
        }
        for (path, text) in files {
            stream.push_str(&format!(
                "M 100644 inline {path}\ndata {}\n{text}\n",
                text.len()
            ));
        }
        plain(&self.path(), &["fast-import", "--quiet"], stream.as_bytes());
        let head = plain(
            &self.path(),
            &["rev-parse", &format!("refs/heads/{branch}")],
            b"",
        );
        self.heads.insert(branch.into(), head.clone());
        head
    }
}

fn plugin_files(folder: &str, id: &str, version: &str) -> Vec<(String, String)> {
    vec![
        (
            format!("{folder}/manifest.json"),
            format!(r#"{{"id":"{id}","name":"{id}","apiVersion":1}}"#),
        ),
        (
            format!("{folder}/plugin.js"),
            format!("export function apply() {{}} // {version}"),
        ),
    ]
}

fn local_git(config: &[(&'static str, &'static str)]) -> Git {
    let mut git = Git::new().unwrap();
    git.config = [&[("protocol.file.allow", "always")], config].concat();
    git
}

fn pin(commit: &str) -> Option<RequiredCommit<'_>> {
    Some(RequiredCommit::parse(commit).unwrap())
}

fn read(
    url: &str,
    reference: &str,
    scope: Option<&str>,
    required: Option<&str>,
) -> Result<PreparedImport> {
    acquire(
        &mut local_git(&[]),
        "fixture",
        url,
        reference,
        scope,
        required.and_then(pin),
    )
}

fn bytes<'a>(prepared: &'a PreparedImport, path: &str) -> &'a str {
    std::str::from_utf8(&prepared.artifacts[path].bytes).unwrap()
}

#[test]
fn a_pin_older_than_the_tip_installs_that_commit_in_either_hash_format() {
    for format in ["sha1", "sha256"] {
        let mut hosted = Hosted::new(format);
        let old = hosted.commit("main", &plugin_files("plugins/one", "example.one", "old"));
        let tip = hosted.commit("main", &plugin_files("plugins/one", "example.one", "new"));
        let length = if format == "sha1" { 40 } else { 64 };
        assert_eq!((old.len(), tip.len()), (length, length));

        let pinned = read(&hosted.url(), "main", None, Some(&old)).unwrap();
        assert_eq!(pinned.preview.commit.as_deref(), Some(old.as_str()));
        assert!(bytes(&pinned, "plugins/one").contains("// old"), "{format}");

        let upper = read(&hosted.url(), "main", None, Some(&old.to_uppercase())).unwrap();
        assert_eq!(upper.preview.commit.as_deref(), Some(old.as_str()));

        let unpinned = read(&hosted.url(), "main", None, None).unwrap();
        assert_eq!(unpinned.preview.commit.as_deref(), Some(tip.as_str()));
        assert!(bytes(&unpinned, "plugins/one").contains("// new"));

        let source = pinned.git_source.as_ref().unwrap();
        assert_eq!(source.commit.as_deref(), Some(old.as_str()));

        let other = if length == 40 { 64 } else { 40 };
        for wrong in ["0".repeat(length), "0".repeat(other)] {
            let refused = read(&hosted.url(), "main", None, Some(&wrong))
                .err()
                .unwrap();
            assert!(
                refused.contains("does not match"),
                "{format} {wrong}: {refused}"
            );
        }
    }
}

#[test]
fn a_pin_must_be_reachable_from_the_named_reference() {
    let mut hosted = Hosted::new("sha1");
    let old = hosted.commit("main", &plugin_files("plugins/one", "example.one", "old"));
    hosted.commit("main", &plugin_files("plugins/one", "example.one", "new"));
    let side = hosted.commit("side", &plugin_files("plugins/one", "example.one", "side"));
    let url = hosted.url();

    let refused = read(&url, "main", None, Some(&side)).err().unwrap();
    assert!(
        refused.contains(&format!("Commit {side} is not on main")),
        "{refused}"
    );
    let refused = read(&url, "side", None, Some(&old)).err().unwrap();
    assert!(
        refused.contains(&format!("Commit {old} is not on side")),
        "{refused}"
    );
    let refused = read(&url, "", None, Some(&side)).err().unwrap();
    assert!(refused.contains("repository default branch"), "{refused}");

    assert!(read(&url, "", None, Some(&old)).is_ok());
    assert!(read(&url, "side", None, Some(&side)).is_ok());
    let missing = read(&url, "gone", None, Some(&old)).err().unwrap();
    assert!(missing.contains("Could not read gone"), "{missing}");
}

#[test]
fn a_folder_scope_ignores_more_than_the_file_limit_outside_it() {
    let mut hosted = Hosted::new("sha1");
    let mut files = plugin_files("plugins/one", "example.one", "one");
    files.extend(plugin_files("plugins/two", "example.two", "two"));
    files.extend((0..=MAX_ENTRIES).map(|index| (format!("bulk/file-{index}.txt"), "x".into())));
    let old = hosted.commit("main", &files);
    hosted.commit("main", &plugin_files("plugins/one", "example.one", "newer"));
    let url = hosted.url();

    let whole = read(&url, "main", None, None).err().unwrap();
    assert!(
        whole.contains("more than 20,000 files; enter the folder"),
        "{whole}"
    );
    let bulk = read(&url, "main", Some("bulk"), None).err().unwrap();
    assert!(bulk.contains("bulk has more than 20,000 files"), "{bulk}");

    let scoped = read(&url, "main", Some("plugins/one"), None).unwrap();
    let paths: Vec<_> = scoped.preview.candidates.iter().map(|c| &c.path).collect();
    assert_eq!(paths, ["plugins/one"]);
    assert!(scoped.preview.warnings.is_empty());
    assert!(bytes(&scoped, "plugins/one").contains("// newer"));

    let pinned = read(&url, "main", Some("plugins/two"), Some(&old)).unwrap();
    assert_eq!(pinned.preview.commit.as_deref(), Some(old.as_str()));
    assert_eq!(pinned.preview.candidates.len(), 1);
    assert_eq!(pinned.preview.candidates[0].path, "plugins/two");

    let parent = read(&url, "main", Some("plugins"), Some(&old)).unwrap();
    assert_eq!(parent.preview.candidates.len(), 2);
}

#[test]
fn a_folder_that_does_not_exist_at_the_commit_is_an_error() {
    let mut hosted = Hosted::new("sha1");
    let old = hosted.commit("main", &plugin_files("plugins/one", "example.one", "old"));
    hosted.commit(
        "main",
        &plugin_files("plugins/later", "example.later", "later"),
    );
    let url = hosted.url();

    for required in [None, Some(old.as_str())] {
        let error = read(&url, "main", Some("plugins/nope"), required)
            .err()
            .unwrap();
        assert!(error.contains("has no folder plugins/nope"), "{error}");
    }
    let error = read(&url, "main", Some("plugins/later"), Some(&old))
        .err()
        .unwrap();
    assert!(error.contains("has no folder plugins/later"), "{error}");
}

#[test]
fn invalid_folders_are_rejected_before_any_git_work() {
    for invalid in [
        "/plugins",
        "../plugins",
        "plugins/..",
        "plugins/../one",
        "plugins\\one",
        "plugins//one",
        "plugins/",
        "plugins/./one",
        "./plugins",
        ":(top)plugins",
        "plugins/one\n",
        &"a/".repeat(300),
    ] {
        assert!(
            repository_folder(invalid).is_err(),
            "{invalid:?} was accepted"
        );
        let error = prepare_git_authorized(
            "https://example.invalid/acme/plugins",
            "",
            Some(invalid),
            None,
            None,
            None,
            None,
            &crate::access::built_in(),
        )
        .err()
        .unwrap();
        assert!(!error.contains("Git could not"), "{invalid:?}: {error}");
    }
    for whole in ["", "."] {
        assert_eq!(repository_folder(whole).unwrap(), None);
    }
    for valid in ["plugins", "plugins/one", "dist/acme.two", "my plugins/v 1"] {
        assert_eq!(repository_folder(valid).unwrap(), Some(valid));
    }
}

#[test]
fn saved_folders_keep_update_checks_scoped_to_the_installed_plugin() {
    let mut hosted = Hosted::new("sha1");
    let mut files = plugin_files("plugins/one", "example.one", "one");
    files.extend(plugin_files("plugins/two", "example.two", "two"));
    hosted.commit("main", &files);
    let url = hosted.url();

    let prepared = read(&url, "main", None, None).unwrap();
    assert_eq!(prepared.preview.candidates.len(), 2);
    let home = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
    let catalog = prepared
        .install(&manager, &prepared.preview.token, "plugins/one")
        .unwrap();
    let installed = catalog
        .plugins
        .iter()
        .find(|plugin| plugin.manifest.id == "example.one")
        .unwrap();
    let Some(InstallSource::Git(saved)) = installed.update_source.clone() else {
        panic!("the Git source is saved");
    };
    assert_eq!(saved.path, "plugins/one");

    hosted.commit(
        "main",
        &plugin_files("plugins/two", "example.two", "changed"),
    );
    let unchanged = read(&url, "main", Some(&saved.path), None).unwrap();
    assert_eq!(unchanged.preview.candidates.len(), 1);
    assert_eq!(unchanged.preview.candidates[0].path, saved.path);
    assert_eq!(unchanged.preview.candidates[0].revision, installed.revision);

    hosted.commit(
        "main",
        &plugin_files("plugins/one", "example.one", "changed"),
    );
    let updated = read(&url, "main", Some(&saved.path), None).unwrap();
    assert_eq!(updated.preview.candidates.len(), 1);
    assert_ne!(updated.preview.candidates[0].revision, installed.revision);
}

#[test]
fn a_blob_read_fetches_only_the_files_that_are_listed() {
    let mut hosted = Hosted::new("sha1");
    let mut files = plugin_files("plugins/one", "example.one", "one");
    files.push(("plugins/one/README.md".into(), "# One".into()));
    files.push(("plugins/big/data.bin".into(), "x".repeat(4096)));
    let commit = hosted.commit("main", &files);
    let mut git = local_git(&[]);
    let prepared = acquire(
        &mut git,
        "fixture",
        &hosted.url(),
        "main",
        Some("plugins/one"),
        pin(&commit),
    )
    .unwrap();
    assert_eq!(prepared.preview.candidates.len(), 1);
    let big = plain(
        &hosted.path(),
        &["rev-parse", &format!("{commit}:plugins/big/data.bin")],
        b"",
    );
    let probe = |oid: &str| {
        let mut command = git.command();
        command
            .env("GIT_NO_LAZY_FETCH", "1")
            .args(["-C", "repository", "cat-file", "-e", oid]);
        git.run_command(command, 1024).is_ok()
    };
    assert!(probe(&plain(
        &hosted.path(),
        &["rev-parse", &format!("{commit}:plugins/one/plugin.js")],
        b""
    )));
    assert!(!probe(&big), "files outside the folder were downloaded");
}

struct Smart {
    base: String,
    seen: Arc<Mutex<Vec<Vec<String>>>>,
    refuse_first_fetch: Arc<AtomicBool>,
}

/// Serves `root` over HTTP with `git http-backend`, recording every request's headers.
fn serve(root: PathBuf, refuse_first_fetch: bool) -> Smart {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let smart = Smart {
        base: format!("http://{}", listener.local_addr().unwrap()),
        seen: Arc::default(),
        refuse_first_fetch: Arc::new(AtomicBool::new(refuse_first_fetch)),
    };
    let (seen, refuse) = (smart.seen.clone(), smart.refuse_first_fetch.clone());
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            respond(stream, &root, &seen, &refuse);
        }
    });
    smart
}

fn respond(
    stream: TcpStream,
    root: &Path,
    seen: &Mutex<Vec<Vec<String>>>,
    refuse_first_fetch: &AtomicBool,
) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request = String::new();
    reader.read_line(&mut request).unwrap();
    let mut parts = request.split_whitespace();
    let (method, target) = (parts.next().unwrap(), parts.next().unwrap());
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let mut headers = vec![];
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line.trim().is_empty() {
            break;
        }
        headers.push(line.trim().to_owned());
    }
    let header = |name: &str| {
        headers.iter().find_map(|line| {
            let (key, value) = line.split_once(": ")?;
            key.eq_ignore_ascii_case(name).then(|| value.to_owned())
        })
    };
    assert!(header("Transfer-Encoding").is_none(), "{headers:?}");
    let mut body = vec![0; header("Content-Length").map_or(0, |n| n.parse().unwrap())];
    std::io::Read::read_exact(&mut reader, &mut body).unwrap();
    seen.lock().unwrap().push(headers.clone());
    let mut stream = stream;
    if method == "POST"
        && String::from_utf8_lossy(&body).contains("command=fetch")
        && refuse_first_fetch.swap(false, Ordering::SeqCst)
    {
        write!(
            stream,
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        return;
    }
    let mut cgi = Command::new("git");
    cgi.arg("http-backend")
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_PROJECT_ROOT", root)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("REQUEST_METHOD", method)
        .env("PATH_INFO", path)
        .env("QUERY_STRING", query)
        .env("REMOTE_ADDR", "127.0.0.1")
        .env("CONTENT_LENGTH", body.len().to_string())
        .env("CONTENT_TYPE", header("Content-Type").unwrap_or_default());
    if let Some(protocol) = header("Git-Protocol") {
        cgi.env("GIT_PROTOCOL", protocol);
    }
    if let Some(encoding) = header("Content-Encoding") {
        cgi.env("HTTP_CONTENT_ENCODING", encoding);
    }
    let mut child = cgi
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(&body).unwrap();
    let output = child.wait_with_output().unwrap().stdout;
    let split = output
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap();
    let (head, payload) = (&output[..split], &output[split + 4..]);
    let mut status = "200 OK".to_owned();
    let mut response = String::new();
    for line in String::from_utf8_lossy(head).lines() {
        match line.strip_prefix("Status: ") {
            Some(value) => status = value.to_owned(),
            None => response.push_str(&format!("{line}\r\n")),
        }
    }
    write!(
        stream,
        "HTTP/1.1 {status}\r\n{response}Content-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    )
    .unwrap();
    stream.write_all(payload).unwrap();
}

fn authorized(git: &mut Git, url: &str) {
    git.authorization = Some((url.into(), "dG9rZW4=".into()));
    git.federated_header = Some("Bearer fixture-assertion".into());
    git.config.push(("protocol.http.allow", "always"));
}

#[test]
fn authorization_reaches_every_request_including_lazy_blob_fetches() {
    let mut hosted = Hosted::new("sha1");
    let mut files = plugin_files("plugins/one", "example.one", "one");
    files.extend(plugin_files("plugins/two", "example.two", "two"));
    let old = hosted.commit("main", &files);
    hosted.commit("main", &plugin_files("plugins/one", "example.one", "newer"));
    let smart = serve(hosted.dir.path().into(), false);
    let url = format!("{}/server.git", smart.base);

    let mut git = Git::new().unwrap();
    authorized(&mut git, &url);
    let prepared = acquire(
        &mut git,
        "fixture",
        &url,
        "main",
        Some("plugins/one"),
        pin(&old),
    )
    .unwrap();
    assert!(bytes(&prepared, "plugins/one").contains("// one"));

    let two = plain(
        &hosted.path(),
        &["rev-parse", &format!("{old}:plugins/two/plugin.js")],
        b"",
    );
    let requests = smart.seen.lock().unwrap().len();
    git.run(&["-C", "repository", "cat-file", "blob", &two], LIMIT)
        .unwrap();
    let seen = smart.seen.lock().unwrap();
    assert!(seen.len() > requests, "the blob was not fetched on demand");
    assert!(seen.len() >= 6, "{}", seen.len());
    for head in seen.iter() {
        assert!(
            head.iter()
                .any(|line| line == "Authorization: Nostr dG9rZW4="),
            "{head:?}"
        );
        assert!(
            head.iter()
                .any(|line| line == "Nostr-Federated-Identity: Bearer fixture-assertion"),
            "{head:?}"
        );
    }
}

#[test]
fn a_host_that_refuses_a_commit_by_its_id_falls_back_to_the_reference_tip() {
    let mut hosted = Hosted::new("sha1");
    let old = hosted.commit("main", &plugin_files("plugins/one", "example.one", "old"));
    let tip = hosted.commit("main", &plugin_files("plugins/one", "example.one", "new"));
    for (required, outcome) in [(&tip, "installs"), (&old, "is refused")] {
        let smart = serve(hosted.dir.path().into(), true);
        let url = format!("{}/server.git", smart.base);
        let mut git = Git::new().unwrap();
        git.config.push(("protocol.http.allow", "always"));
        let result = acquire(&mut git, "fixture", &url, "main", None, pin(required));
        assert!(!smart.refuse_first_fetch.load(Ordering::SeqCst));
        if outcome == "installs" {
            let prepared = result.unwrap();
            assert_eq!(prepared.preview.commit.as_deref(), Some(tip.as_str()));
        } else {
            let error = result.err().unwrap();
            assert!(error.contains("could not be fetched directly"), "{error}");
            assert!(
                error.contains(&format!("commit {tip}, which does not match")),
                "{error}"
            );
        }
    }
}

#[test]
fn a_host_that_refuses_files_by_their_id_is_read_from_a_complete_tip_clone() {
    let mut hosted = Hosted::new("sha1");
    hosted.configure("uploadpack.allowAnySHA1InWant", "false");
    let old = hosted.commit("main", &plugin_files("plugins/one", "example.one", "old"));
    let tip = hosted.commit("main", &plugin_files("plugins/one", "example.one", "new"));
    let v0 = || local_git(&[("protocol.version", "0")]);

    let mut filtered = v0();
    filtered.clone_tip(&hosted.url(), "main", false).unwrap();
    let refused = filtered.read_plugins("fixture".into(), &tip, None).err();
    assert_eq!(refused.as_deref(), Some(BLOBS_REFUSED));

    for required in [None, Some(tip.as_str())] {
        let prepared = acquire(
            &mut v0(),
            "fixture",
            &hosted.url(),
            "main",
            Some("plugins/one"),
            required.and_then(pin),
        )
        .unwrap();
        assert_eq!(prepared.preview.commit.as_deref(), Some(tip.as_str()));
        assert!(bytes(&prepared, "plugins/one").contains("// new"));
    }
    let error = acquire(&mut v0(), "fixture", &hosted.url(), "main", None, pin(&old))
        .err()
        .unwrap();
    assert!(
        error.contains(&format!("commit {tip}, which does not match")),
        "{error}"
    );
}
