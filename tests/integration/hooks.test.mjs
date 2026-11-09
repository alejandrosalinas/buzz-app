import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
// Borrow the installed tools without letting pnpm repair the shared symlink target.
// This fixture intentionally has no workspace/patch config of its own.
env.pnpm_config_verify_deps_before_run = "false";
// These commits are disposable probe fixtures, never commits in the source checkout.
env.GIT_CONFIG_NOSYSTEM = "1";
env.GIT_CONFIG_GLOBAL = "/dev/null";
// Exercise production runner selection, not a fixture-only binary override.
delete env.LEFTHOOK_BIN;
// Replaces the push lanes to capture the exact bytes each one receives.
const recordPushInput = `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync((process.argv[2] ?? "unit") + "-input", readFileSync(0));
`;
function fixture(t, { install = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "buzz-hook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (cmd, args, overrides = {}) =>
    spawnSync(cmd, args, {
      cwd: dir,
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
  const git = (...args) => {
    const result = run("git", args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  };
  const read = (file) => readFileSync(path.join(dir, file), "utf8");
  git("init", "-q");
  git("config", "user.name", "Hook Test");
  git("config", "user.email", "hook-test@example.invalid");
  // Git 2.50+ commits detach `maintenance run --auto`, whose worktree-prune
  // task deletes a `.git/worktrees/<id>` entry that has no gitdir or lock yet.
  // The linked-worktree case would race that background process.
  git("config", "maintenance.auto", "false");
  write("untouched.ts", "export const unrelated = 1;\n");
  write("partial.ts", "export const first = 1;\nexport const second = 2;\n");
  git("add", ".");
  git("commit", "-qm", "fixture base");
  // The Biome config loads lint plugins by path; the fixture needs them too.
  const biomePlugins = JSON.parse(
    readFileSync(path.join(root, "biome.json"), "utf8"),
  ).overrides.flatMap((override) => override.plugins ?? []);
  const configFiles = [
    "biome.json",
    "package.json",
    "lefthook.yml",
    "justfile",
    // rustup selects the pinned toolchain from the working directory.
    "rust-toolchain.toml",
    "scripts",
    ...biomePlugins.map((plugin) => path.normalize(plugin)),
  ];
  for (const file of configFiles) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    cpSync(path.join(root, file), path.join(dir, file), { recursive: true });
  }
  symlinkSync(path.join(root, "bin"), path.join(dir, "bin"), "dir");
  symlinkSync(
    path.join(root, "node_modules"),
    path.join(dir, "node_modules"),
    "dir",
  );
  git("add", ...configFiles);
  git("commit", "-qm", "hook configuration");
  // Once per clone: the public recipe installs into the shared `.git/hooks`.
  if (install) {
    const installed = run(path.join(root, "bin/just"), ["hooks"]);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  }
  const commit = () => run("git", ["commit", "-qm", "probe"]);
  return { dir, run, git, write, read, commit };
}

test("every pre-push job receives the complete Git input without sharing a read cursor", (t) => {
  const f = fixture(t);
  // Keep the installed shim and production job configuration. Probe only the
  // stdin contract at the child boundary, including input larger than one read.
  f.write("scripts/check-push.mjs", recordPushInput);
  const refs =
    `refs/heads/probe ${"a".repeat(40)} refs/heads/probe ${"0".repeat(40)}\n`.repeat(
      1000,
    );
  const result = spawnSync(path.join(f.dir, ".git/hooks/pre-push"), [], {
    cwd: f.dir,
    env,
    input: refs,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const lane of ["unit", "--design", "--clippy"])
    assert.equal(
      f.read(`${lane}-input`),
      refs,
      `${lane} lost or duplicated Git refs`,
    );
});

test("installed hook formats fully staged files without rewriting borrowed dependencies or other work", (t) => {
  const dependencies = () =>
    [".modules.yaml", "virtua/lib/index.js"].map((file) =>
      readFileSync(path.join(root, "node_modules", file), "utf8"),
    );
  const installed = dependencies();
  const f = fixture(t);
  f.write("nested/space name.ts", "export const answer={value:42}\n");
  f.write("safe.ts", "export function count(){let value=1; return value;}\n");
  f.git("add", "nested/space name.ts", "safe.ts");
  f.write("untouched.ts", "export const unrelated = 99;\n");
  f.write("untracked.ts", "export const doNotAdd={value:1}\n");
  const result = f.commit();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(dependencies(), installed, "borrowed dependencies changed");
  assert.equal(
    f.git("show", "HEAD:nested/space name.ts"),
    "export const answer = { value: 42 };\n",
  );
  assert.match(f.git("show", "HEAD:safe.ts"), /const value = 1;/);
  assert.equal(f.read("untouched.ts"), "export const unrelated = 99;\n");
  assert.equal(
    f.git("show", "HEAD:untouched.ts"),
    "export const unrelated = 1;\n",
  );
  assert.equal(f.git("ls-files", "untracked.ts"), "");
  assert.equal(f.git("stash", "list"), "");
});

test("one installation serves every linked worktree", (t) => {
  const f = fixture(t);
  const sibling = path.join(f.dir, "sibling");
  f.git("worktree", "add", "-q", "--detach", sibling);
  for (const link of ["bin", "node_modules"])
    symlinkSync(path.join(root, link), path.join(sibling, link), "dir");
  writeFileSync(path.join(sibling, "probe.ts"), "export const value={a:1}\n");
  const git = (...args) => f.run("git", ["-C", sibling, ...args]);
  assert.equal(git("add", "probe.ts").status, 0);
  const result = git("commit", "-qm", "sibling");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    git("show", "HEAD:probe.ts").stdout,
    "export const value = { a: 1 };\n",
  );
});

for (const linked of [false, true]) {
  test(`non-lhm global hooks stay untouched when installing from ${linked ? "a linked worktree" : "the main checkout"}`, (t) => {
    const f = fixture(t, { install: false });
    const sibling = path.join(f.dir, "sibling");
    f.git("worktree", "add", "-q", "--detach", sibling);
    for (const link of ["bin", "node_modules"])
      symlinkSync(path.join(root, link), path.join(sibling, link), "dir");
    const globalHooks = path.join(f.dir, "global hooks");
    const sentinel = "#!/bin/sh\nexit 1\n";
    f.write("global hooks/pre-commit", sentinel);
    const config = `[core]\n hooksPath = "${globalHooks}"\n`;
    f.write("global-config", config);
    const isolated = {
      GIT_CONFIG_GLOBAL: path.join(f.dir, "global-config"),
    };
    const cwd = linked ? sibling : f.dir;
    const run = (cmd, args) =>
      spawnSync(cmd, args, {
        cwd,
        env: { ...env, ...isolated },
        encoding: "utf8",
      });
    const refused = run(path.join(root, "bin/just"), ["hooks"]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout + refused.stderr, /core.hooksPath/);
    assert.equal(f.read("global-config"), config);
    assert.equal(f.read("global hooks/pre-commit"), sentinel);
    assert.equal(existsSync(path.join(f.dir, ".git/hooks/pre-commit")), false);

    // Exercise the documented opt-in override from both invocation contexts.
    const common = run("git", [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    assert.equal(common.status, 0, common.stdout + common.stderr);
    const hooks = path.join(common.stdout.trim(), "hooks");
    assert.equal(path.isAbsolute(hooks), true);
    const configured = run("git", [
      "config",
      "--local",
      "core.hooksPath",
      hooks,
    ]);
    assert.equal(configured.status, 0, configured.stdout + configured.stderr);
    const installed = run(path.join(root, "bin/lefthook"), [
      "install",
      "--force",
    ]);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.equal(f.read("global-config"), config);
    assert.equal(f.read("global hooks/pre-commit"), sentinel);
    for (const checkout of [f.dir, sibling]) {
      writeFileSync(
        path.join(checkout, "probe.ts"),
        "export const value={a:1}\n",
      );
      const git = (...args) =>
        f.run("git", ["-C", checkout, ...args], isolated);
      assert.equal(
        git("config", "--get", "core.hooksPath").stdout.trim(),
        hooks,
      );
      assert.equal(git("add", "probe.ts").status, 0);
      const committed = git("commit", "-qm", "global path probe");
      assert.equal(committed.status, 0, committed.stdout + committed.stderr);
      assert.equal(
        git("show", "HEAD:probe.ts").stdout,
        "export const value = { a: 1 };\n",
      );
    }
  });
}

test("non-conflicting partial staging commits only the staged hunks and restores the rest", (t) => {
  const f = fixture(t);
  f.write("untouched.ts", "export const unrelated = 7;\n");
  f.git("stash", "push", "-qm", "existing user stash");
  f.write(
    "partial.ts",
    "export const first={value:1}\nexport const second = 2;\n",
  );
  f.git("add", "partial.ts");
  f.write(
    "partial.ts",
    "export const first={value:1}\nexport const second = 99;\n",
  );
  f.write("untouched.ts", "export const unrelated = 88;\n");
  const stashes = f.git("stash", "list");
  const result = f.commit();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    f.git("show", "HEAD:partial.ts"),
    "export const first = { value: 1 };\nexport const second = 2;\n",
  );
  assert.equal(
    f.read("partial.ts"),
    "export const first = { value: 1 };\nexport const second = 99;\n",
  );
  assert.equal(f.read("untouched.ts"), "export const unrelated = 88;\n");
  assert.equal(f.git("stash", "list"), stashes);
  assert.equal(
    existsSync(path.join(f.dir, ".git/info/lefthook-unstaged.patch")),
    false,
  );
});

test("a restore conflict blocks the commit and leaves index, files and unrelated edits as they were", (t) => {
  const f = fixture(t);
  f.write(
    "partial.ts",
    "export const first={value:1}\nexport const second = 2;\n",
  );
  f.write("fully.ts", "export const staged={value:1}\n");
  f.git("add", "partial.ts", "fully.ts");
  const index = f.git("write-tree");
  // The formatter rewrites the same line this unstaged hunk touches.
  const partial =
    "export const first={value:1} // note\nexport const second = 2;\n";
  f.write("partial.ts", partial);
  f.write("untouched.ts", "export const unrelated = 88;\n");
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stdout + result.stderr,
    /conflict while merging unstaged changes/,
  );
  assert.equal(f.git("write-tree"), index);
  assert.equal(f.read("partial.ts"), partial);
  assert.equal(f.read("fully.ts"), "export const staged={value:1}\n");
  assert.equal(f.read("untouched.ts"), "export const unrelated = 88;\n");
  assert.equal(f.git("stash", "list"), "");
});

test("warnings reject commit without unsafe fixes or index updates", (t) => {
  const f = fixture(t);
  const source = "export const first = (values: string[]) => values[0]!;\n";
  f.write("warning.ts", source);
  f.git("add", "warning.ts");
  const index = f.git("write-tree");
  const head = f.git("rev-parse", "HEAD");
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /noNonNullAssertion/);
  assert.equal(f.read("warning.ts"), source);
  assert.equal(f.git("write-tree"), index);
  assert.equal(f.git("rev-parse", "HEAD"), head);
});

test("Rust formatting restages only the staged file; referenced modules are formatted in place", (t) => {
  const f = fixture(t);
  f.write("main.rs", 'mod child;\nfn main(){println!("test");}\n');
  f.git("add", "main.rs");
  f.write("child.rs", "pub fn untouched( ){ }\n");
  const result = f.commit();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    f.git("show", "HEAD:main.rs"),
    'mod child;\nfn main() {\n    println!("test");\n}\n',
  );
  // rustfmt follows `mod child;` like `cargo fmt --all`; only staged files are restaged.
  assert.equal(f.read("child.rs"), "pub fn untouched() {}\n");
  assert.equal(f.git("ls-files", "child.rs"), "");
});

test("staged deletions and documentation-only commits do not rewrite source", (t) => {
  const f = fixture(t);
  f.git("rm", "partial.ts");
  f.write("notes.md", "# notes\n");
  f.git("add", "notes.md");
  f.write("untouched.ts", "export const unrelated={value:1}\n");
  const result = f.commit();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.git("ls-files", "partial.ts"), "");
  assert.equal(f.read("untouched.ts"), "export const unrelated={value:1}\n");
});

test("formatter failure preserves index and unrelated edits", (t) => {
  const f = fixture(t);
  f.write("safe.ts", "export const value={a:1}\n");
  f.write("bad.ts", "export const first=(values:string[])=>values[0]!\n");
  f.git("add", "safe.ts", "bad.ts");
  f.write("untouched.ts", "export const unrelated=99\n");
  const index = f.git("write-tree");
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.equal(f.git("write-tree"), index);
  assert.equal(f.read("untouched.ts"), "export const unrelated=99\n");
  assert.match(f.read("safe.ts"), /value =/);
});

test("filename metacharacters and rename destination are literal", (t) => {
  const f = fixture(t);
  f.git("mv", "partial.ts", "renamed.ts");
  const names = ["-dash.ts", "line\nbreak.ts", "colon:name.ts"];
  for (const name of names) f.write(name, "export const value={a:1}\n");
  f.git("add", "--", ...names);
  const result = f.commit();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of names)
    assert.equal(
      f.git("show", `HEAD:${name}`),
      "export const value = { a: 1 };\n",
    );
  assert.equal(f.git("ls-files", "partial.ts"), "");
  assert.equal(f.git("ls-files", "renamed.ts"), "renamed.ts\n");
});

test("names Git would expand as globs are refused before any write", (t) => {
  const f = fixture(t);
  const source = "export const value={a:1}\n";
  f.write("bracket[1].ts", source);
  f.git("add", "--", "bracket[1].ts");
  // Lefthook's restage pathspec `bracket[1].ts` would also add this file.
  f.write("bracket1.ts", "export const untracked={a:2}\n");
  const index = f.git("write-tree");
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stdout + result.stderr,
    /glob pathspecs: bracket\[1\]\.ts/,
  );
  assert.equal(f.git("write-tree"), index);
  assert.equal(f.read("bracket[1].ts"), source);
  assert.equal(f.git("ls-files", "bracket1.ts"), "");
});

test("staged icon checks reject CommonJS subpaths without changing the index", (t) => {
  const f = fixture(t);
  f.write(
    "probe.cjs",
    'const icon = require("lucide-react/dist/cjs/icons/x.js");\nmodule.exports = icon;\n',
  );
  f.git("add", "probe.cjs");
  const index = f.git("write-tree");
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stdout + result.stderr,
    /Use shared\/design-system\/icons/,
  );
  assert.equal(f.git("write-tree"), index);
});

function pushFixture(t, changes) {
  const f = fixture(t);
  // Run the real design guards against the real palette, not fake success scripts.
  const tokens = "src/shared/design-system/styles/tokens.css";
  f.write(tokens, readFileSync(path.join(root, tokens), "utf8"));
  f.write("tests/fixtures/design-system/probe.ts", "export const value = 1;\n");
  f.write(
    "tsconfig.design.json",
    JSON.stringify({
      compilerOptions: { types: [], skipLibCheck: true },
      include: ["tests/fixtures/design-system"],
    }),
  );
  f.git("add", "src", "tests", "tsconfig.design.json");
  f.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "design baseline");
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  for (const [file, content] of Object.entries(changes)) f.write(file, content);
  f.git("add", "--", ...Object.keys(changes));
  // Seed source commits independently of formatting: this fixture exercises push.
  f.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "push probe");
  f.git("init", "--bare", "-q", "remote.git");
  // A fake Vitest executable records the production hook's selected arguments.
  // It lives only in this disposable repository, never the source node_modules.
  rmSync(path.join(f.dir, "node_modules"));
  mkdirSync(path.join(f.dir, "node_modules"));
  // Replace the borrowed bin/ with a fake cargo plus the real pinned hook
  // tools: push fixtures exercise the Clippy lane's contract without paying
  // a real cargo build, exactly like the fake Vitest below.
  rmSync(path.join(f.dir, "bin"));
  mkdirSync(path.join(f.dir, "bin"));
  for (const tool of ["node", "pnpm", "lefthook"]) {
    symlinkSync(
      path.join(root, `bin/${tool}`),
      path.join(f.dir, `bin/${tool}`),
      "file",
    );
  }
  writeFileSync(
    path.join(f.dir, "bin/cargo"),
    `#!/bin/sh
if [ "$1" = "clippy" ]; then
  printf '%s\\n' "$@" > cargo-args
  exit "\${BUZZ_FAKE_CARGO_STATUS:-0}"
fi
exit 2
`,
    { mode: 0o755 },
  );
  symlinkSync(
    path.join(root, "node_modules/typescript"),
    path.join(f.dir, "node_modules/typescript"),
    "dir",
  );
  // The adoption guard parses CSS and scans the plugin examples directory.
  symlinkSync(
    path.join(root, "node_modules/postcss"),
    path.join(f.dir, "node_modules/postcss"),
    "dir",
  );
  mkdirSync(path.join(f.dir, "examples/plugins"), { recursive: true });
  // The icon guard parses real JS/TS using the pinned build-tool parser.
  symlinkSync(
    path.join(root, "node_modules/rolldown"),
    path.join(f.dir, "node_modules/rolldown"),
    "dir",
  );
  f.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { types: [], skipLibCheck: true },
      include: ["src", "untouched.ts", "vitest.config.ts"],
    }),
  );
  f.write(
    "node_modules/vitest/vitest.mjs",
    `import { existsSync, readFileSync, writeFileSync } from "node:fs";
writeFileSync("push-args.json", JSON.stringify(process.argv.slice(2)));
process.exit(existsSync("push-exit") ? Number(readFileSync("push-exit", "utf8")) : 0);
`,
  );
  const push = (ref = "HEAD:refs/heads/probe") =>
    f.run("git", ["push", "./remote.git", ref]);
  const args = () => JSON.parse(f.read("push-args.json"));
  return { ...f, push, args };
}

test("installed pre-push forwards stdin and runs related tests with literal paths", (t) => {
  const name = "src/space [name]\nname.ts";
  const f = pushFixture(t, { [name]: "export const value = 1;\n" });
  const result = f.push();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.args(), [
    "related",
    "--run",
    "--passWithNoTests",
    path.join(f.git("rev-parse", "--show-toplevel").trim(), name),
    path.join(
      f.git("rev-parse", "--show-toplevel").trim(),
      "src/app/pages.integration.test.mjs",
    ),
  ]);
  assert.equal(f.git("stash", "list"), "");
});

for (const name of [
  "browser-host/relay-broker.mjs",
  "scripts/developer-settings.ts",
  "scripts/live-setup-probe.mjs",
]) {
  test(`${name} selects related tests and deletion selects the full suite`, (t) => {
    const f = pushFixture(t, { [name]: "export const value = 1;\n" });
    const result = f.push();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(f.args(), [
      "related",
      "--run",
      "--passWithNoTests",
      path.join(f.git("rev-parse", "--show-toplevel").trim(), name),
    ]);
    f.git("update-ref", "refs/remotes/origin/main", "HEAD");
    f.git("rm", name);
    f.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "delete source");
    const deleted = f.push();
    assert.equal(deleted.status, 0, deleted.stdout + deleted.stderr);
    assert.deepEqual(f.args(), ["run"]);
  });
}

for (const [file, content] of [
  ["notes.md", "# notes\n"],
  ["docs/probe.md", "# docs\n"],
]) {
  test(`${file}-only push skips all validation jobs`, (t) => {
    const f = pushFixture(t, { [file]: content });
    f.write("src/bad.css", ".root { gap: 8px; }\n");
    const result = f.push();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(
      result.stdout + result.stderr,
      /No JS unit-test inputs changed/,
    );
    assert.match(
      result.stdout + result.stderr,
      /No design-system inputs changed/,
    );
    assert.match(result.stdout + result.stderr, /No Rust inputs changed/);
    assert.throws(() => f.args(), /ENOENT/);
  });
}

for (const path of [
  "crates/probe/src/lib.rs",
  "src/bundled/mesh-compute/compute/src/lib.rs",
]) {
  test(`${path}-only push runs Clippy and blocks the push on a lint failure`, (t) => {
    const f = pushFixture(t, {
      [path]: "pub fn value() -> usize {\n    2\n}\n",
    });
    const result = f.push();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /Pre-push: Clippy/);
    if (path.startsWith("crates/"))
      assert.match(
        result.stdout + result.stderr,
        /No JS unit-test inputs changed/,
      );
    else
      assert.ok(
        f
          .args()
          .some((arg) => arg.endsWith("src/app/pages.integration.test.mjs")),
      );
    assert.deepEqual(f.read("cargo-args").trim().split("\n"), [
      "clippy",
      "--workspace",
      "--locked",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ]);
    const failed = f.run(
      "git",
      ["push", "./remote.git", "HEAD:refs/heads/fail"],
      {
        BUZZ_FAKE_CARGO_STATUS: "1",
      },
    );
    assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
    assert.match(failed.stdout + failed.stderr, /Pre-push: Clippy/);
    assert.notEqual(
      f.run("git", ["--git-dir=remote.git", "rev-parse", "refs/heads/fail"])
        .status,
      0,
      "push reached the remote despite the Clippy failure",
    );
  });
}

test("JS-only pushes skip Clippy; the lane stays independent of unit-test skip", (t) => {
  const f = pushFixture(t, { "src/value.ts": "export const value = 1;\n" });
  const result = f.push();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /No Rust inputs changed/);
  assert.throws(() => f.read("cargo-args"), /ENOENT/);
});

test("shared config and unknown base conservatively run all JS unit tests", (t) => {
  const f = pushFixture(t, { "vitest.config.ts": "export default {};\n" });
  const shared = f.push();
  assert.equal(shared.status, 0, shared.stdout + shared.stderr);
  assert.match(shared.stdout + shared.stderr, /App foundations: no private/);
  assert.deepEqual(f.args(), ["run"]);
  f.git("update-ref", "-d", "refs/remotes/origin/main");
  const missing = f.push("HEAD:refs/heads/without-base");
  assert.equal(missing.status, 0, missing.stdout + missing.stderr);
  assert.match(missing.stdout + missing.stderr, /App foundations: no private/);
  assert.deepEqual(f.args(), ["run"]);
});

test("source deletion runs all JS tests instead of losing dependency coverage", (t) => {
  const f = pushFixture(t, { "src/deleted.ts": "export const value = 1;\n" });
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  f.git("rm", "src/deleted.ts");
  f.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "delete source");
  assert.equal(f.push().status, 0);
  assert.deepEqual(f.args(), ["run"]);
});

test("a type error blocks the actual Git push before unit tests", (t) => {
  const f = pushFixture(t, {
    "src/type-error.ts": 'export const value: number = "wrong";\n',
  });
  const result = f.push();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /TS2322/);
  assert.throws(() => f.args(), /ENOENT/);
  assert.notEqual(
    f.run("git", ["--git-dir=remote.git", "rev-parse", "refs/heads/probe"])
      .status,
    0,
  );
});

test("failing related tests block the actual Git push", (t) => {
  const f = pushFixture(t, { "src/failing.ts": "export const value = 1;\n" });
  f.write("push-exit", "1");
  assert.notEqual(f.push().status, 0);
  assert.notEqual(
    f.run("git", ["--git-dir=remote.git", "rev-parse", "refs/heads/probe"])
      .status,
    0,
  );
  assert.equal(f.args()[0], "related");
});

test("non-HEAD and deletion pushes do not pretend to test another commit", (t) => {
  const f = pushFixture(t, { "src/value.ts": "export const value = 1;\n" });
  f.write("src/bad.css", ".root { gap: 8px; }\n");
  const other = f.push("HEAD^:refs/heads/old");
  assert.equal(other.status, 0, other.stdout + other.stderr);
  assert.match(other.stdout + other.stderr, /Non-HEAD refs rely on PR CI/);
  assert.throws(() => f.args(), /ENOENT/);
  assert.equal(f.push(":refs/heads/old").status, 0);
  assert.throws(() => f.args(), /ENOENT/);
});

for (const [input, testFile] of [
  ["src/shared/styles/tokens.css", "src/shared/theme/tokens.test.ts"],
  ["public/appearance-init.js", "src/shared/theme/service.test.ts"],
  ["vite.config.ts", "browser-host/vite-config.test.mjs"],
]) {
  test(`pre-push selects the unit test that reads ${input} directly`, (t) => {
    const f = pushFixture(t, { [input]: "/* changed */\n" });
    assert.equal(f.push().status, 0);
    assert.equal(f.args()[0], "related");
    assert.ok(
      f
        .args()
        .includes(
          path.join(f.git("rev-parse", "--show-toplevel").trim(), testFile),
        ),
    );
  });
}

test("missing Vitest fails closed without installing dependencies", (t) => {
  const f = pushFixture(t, { "src/value.ts": "export const value = 1;\n" });
  rmSync(path.join(f.dir, "node_modules/vitest"), { recursive: true });
  const result = f.push();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /MODULE_NOT_FOUND/);
});

test("a subdirectory push with multiple refs still tests HEAD", (t) => {
  const f = pushFixture(t, { "src/value.ts": "export const value = 1;\n" });
  const result = f.run("git", [
    "-C",
    "src",
    "push",
    path.join(f.dir, "remote.git"),
    "HEAD^:refs/heads/old",
    "HEAD:refs/heads/current",
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Non-HEAD refs rely on PR CI/);
  assert.equal(f.args()[0], "related");
  assert.match(result.stdout + result.stderr, /App foundations: no private/);
  f.write("src/bad.css", ".root { gap: 8px; }\n");
  const blocked = f.run("git", [
    "-C",
    "src",
    "push",
    path.join(f.dir, "remote.git"),
    "HEAD^:refs/heads/old-again",
    "HEAD:refs/heads/current-again",
  ]);
  assert.notEqual(blocked.status, 0, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout + blocked.stderr, /custom spacing/);
});

test("raw activity CSS blocks an actual push; shared tokens pass without hook writes", (t) => {
  const file = "src/features/agents/ActivityRows.module.css";
  const bad = ".root { margin: 12px 16px -8px; font-weight: 600; }\n";
  const f = pushFixture(t, { [file]: bad });
  const index = f.git("write-tree");
  const result = f.push();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /custom spacing/);
  assert.match(result.stdout + result.stderr, /custom font weight/);
  assert.equal(f.read(file), bad);
  assert.equal(f.git("write-tree"), index);
  // Unit tests may finish independently; a design failure still blocks the push.
  assert.notEqual(
    f.run("git", ["--git-dir=remote.git", "rev-parse", "refs/heads/probe"])
      .status,
    0,
  );
  f.write(
    file,
    ".root { margin: var(--space-3) var(--space-4) calc(-1 * var(--space-2)); font-weight: var(--type-weight-medium); }\n",
  );
  f.git("add", file);
  f.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "use tokens");
  const fixed = f.push();
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  assert.match(fixed.stdout + fixed.stderr, /App foundations: no private/);
});

for (const file of [
  "tests/fixtures/design-system/probe.ts",
  "scripts/design-system/check-app-foundations.mjs",
]) {
  test(`design-only change to ${file} runs guards before the unit-test skip`, (t) => {
    const f = pushFixture(t, {
      [file]: file.endsWith(".ts")
        ? "export const value = 2;\n"
        : `${readFileSync(path.join(root, file), "utf8")}\n// guard probe\n`,
    });
    // Pre-push has the same documented working-tree scope as types and Vitest.
    f.write("src/bad.css", ".root { gap: 8px; }\n");
    const blocked = f.push();
    assert.notEqual(blocked.status, 0, blocked.stdout + blocked.stderr);
    assert.match(blocked.stdout + blocked.stderr, /custom spacing/);
    rmSync(path.join(f.dir, "src/bad.css"));
    const passed = f.push();
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout + passed.stderr, /App foundations: no private/);
    assert.throws(() => f.args(), /ENOENT/);
  });
}

test("the design tsconfig rejects viewer type errors before a design-only push", (t) => {
  const f = pushFixture(t, {
    "tests/fixtures/design-system/probe.ts":
      'export const value: number = "wrong";\n',
  });
  const result = f.push();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /TS2322/);
  assert.throws(() => f.args(), /ENOENT/);
});

test("a missing design config blocks pushing without dependency repair", (t) => {
  const f = pushFixture(t, {
    "src/probe.css": ".root { gap: var(--space-2); }\n",
  });
  rmSync(path.join(f.dir, "tsconfig.design.json"));
  const result = f.push();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /TS5058/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /Already up to date|Progress: resolved/,
  );
});

test("missing design TypeScript fails closed without recreating dependencies", (t) => {
  const f = pushFixture(t, {
    "tests/fixtures/design-system/probe.ts": "export const value = 2;\n",
  });
  rmSync(path.join(f.dir, "node_modules/typescript"));
  const result = f.run(
    "git",
    ["push", "./remote.git", "HEAD:refs/heads/probe"],
    {
      pnpm_config_verify_deps_before_run: "true",
    },
  );
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /MODULE_NOT_FOUND/);
  assert.equal(existsSync(path.join(f.dir, "node_modules/typescript")), false);
  assert.throws(() => f.args(), /ENOENT/);
});

test("the design lane disables dependency auto-repair even when inherited as true", (t) => {
  const f = pushFixture(t, {
    "tests/fixtures/design-system/probe.ts": "export const value = 2;\n",
  });
  // This fixture intentionally lacks most package.json dependencies. Without the
  // production flag pnpm would attempt to repair it before running the guards.
  const result = f.run(
    "git",
    ["push", "./remote.git", "HEAD:refs/heads/probe"],
    {
      pnpm_config_verify_deps_before_run: "true",
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /App foundations: no private/);
  assert.equal(existsSync(path.join(f.dir, "node_modules/react")), false);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /Already up to date|Progress: resolved/,
  );
});

function lhmFixture(t) {
  const f = fixture(t, { install: false });
  const upstream = path.join(f.dir, "upstream ' $ hooks");
  for (const name of ["pre-commit", "pre-push"]) {
    f.write(
      path.relative(f.dir, path.join(upstream, name)),
      `#!/bin/sh\nexec "${process.env.BUZZ_REAL_LHM}" run-hook ${name} "$@"\n`,
    );
    chmodSync(path.join(upstream, name), 0o755);
  }
  f.write("global-config", `[core]\n hooksPath = "${upstream}"\n`);
  f.write(
    "system/lefthook.yml",
    `pre-commit:
  commands:
    sentinel:
      run: git show :probe.ts > real-lhm-source
pre-push:
  commands:
    sentinel:
      run: cat > real-lhm-input
      use_stdin: true
`,
  );
  // An empty user file parses as null and wipes the merge; `{}` is the empty layer.
  f.write("absent-user.yml", "{}\n");
  const isolated = {
    GIT_CONFIG_GLOBAL: path.join(f.dir, "global-config"),
    LHM_SYSTEM_CONFIG: path.join(f.dir, "system"),
    LHM_USER_CONFIG: path.join(f.dir, "absent-user.yml"),
  };
  // Exercise the documented activation command, rather than manufacturing PATH.
  const activated = f.run(
    "/bin/bash",
    ["-c", 'eval "$(./bin/hermit env --activate)" && env -0'],
    isolated,
  );
  assert.equal(activated.status, 0, activated.stdout + activated.stderr);
  for (const entry of activated.stdout.split("\0").filter(Boolean)) {
    const equals = entry.indexOf("=");
    isolated[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  const selected = f.run(
    "/bin/sh",
    ["-c", "command -v lefthook; lefthook version"],
    isolated,
  );
  assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  assert.equal(selected.stdout, `${root}bin/lefthook\n2.2.2\n`);
  return { ...f, isolated };
}

test("real lhm composes isolated system commands with the repository jobs", {
  skip: !process.env.BUZZ_REAL_LHM,
}, (t) => {
  const f = lhmFixture(t);
  const { isolated } = f;
  const sibling = path.join(f.dir, "sibling");
  f.git("worktree", "add", "-q", "--detach", sibling);
  for (const link of ["bin", "node_modules"])
    symlinkSync(path.join(root, link), path.join(sibling, link), "dir");
  const before = f.read("global-config");
  const refused = f.run(path.join(root, "bin/just"), ["hooks"], isolated);
  assert.notEqual(refused.status, 0);
  assert.equal(f.read("global-config"), before);
  assert.equal(existsSync(path.join(f.dir, ".git/hooks/pre-commit")), false);
  for (const checkout of [f.dir, sibling]) {
    writeFileSync(
      path.join(checkout, "probe.ts"),
      "export const value={a:1}\n",
    );
    const git = (...args) => f.run("git", ["-C", checkout, ...args], isolated);
    assert.equal(git("add", "probe.ts").status, 0);
    const commit = git("commit", "-qm", "real lhm");
    assert.equal(commit.status, 0, commit.stdout + commit.stderr);
    assert.equal(
      git("show", "HEAD:probe.ts").stdout,
      "export const value = { a: 1 };\n",
    );
    // The machine's command ran after the jobs, before Lefthook restaged fixes.
    assert.equal(
      readFileSync(path.join(checkout, "real-lhm-source"), "utf8"),
      "export const value={a:1}\n",
    );
  }
  assert.equal(f.read("global-config"), before);
  f.write("scripts/check-push.mjs", recordPushInput);
  f.git("init", "--bare", "-q", "remote.git");
  const push = f.run(
    "git",
    ["push", "./remote.git", "HEAD:refs/heads/probe"],
    isolated,
  );
  assert.equal(push.status, 0, push.stdout + push.stderr);
  for (const lane of ["unit", "--design", "--clippy"])
    assert.equal(f.read(`${lane}-input`), f.read("real-lhm-input"));
  assert.match(f.read("real-lhm-input"), /refs\/heads\/probe/);
});
