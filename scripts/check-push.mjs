import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
process.chdir(git("rev-parse", "--show-toplevel"));
const gitLocalEnv = new Set(
  git("rev-parse", "--local-env-vars").split("\n").filter(Boolean),
);
const childEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  for (const key of gitLocalEnv) delete env[key];
  return env;
};
const head = git("rev-parse", "HEAD");
const design = process.argv.includes("--design");
const clippy = process.argv.includes("--clippy");
const refs = readFileSync(0, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split(/\s+/));
const updates = refs.filter(([, sha]) => !/^0+$/.test(sha));
if (updates.some(([, sha]) => sha !== head))
  console.warn("Non-HEAD refs rely on PR CI; local tests only exercise HEAD.");
if (!updates.some(([, sha]) => sha === head)) process.exit(0);

// Use the nearest local base, never fetch or install during a push: the merge
// base with origin/main, or the remote ref's tip when this push fast-forwards
// it (except for Clippy). That tip was pushed already, with any main it merged,
// so a stale origin/main does not select main's commits again.
// This hook never runs the full JS unit suite: every PR gets it in CI, and
// dependency and config changes are left to CI. This is fast feedback, not
// proof for arbitrary refs or uncommitted work. Without a base, only the type
// check runs.
const gitRun = (...args) => spawnSync("git", args, { encoding: "utf8" });
const bases = [gitRun("merge-base", "HEAD", "refs/remotes/origin/main")]
  .filter((result) => result.status === 0)
  .map((result) => result.stdout.trim());
// One destination only: another ref's first push needs the full branch diff.
const pushed = updates.filter(([, sha]) => sha === head);
for (const [, , , remote] of pushed)
  if (
    !clippy &&
    pushed.length === 1 &&
    !/^0+$/.test(remote) &&
    gitRun("merge-base", "--is-ancestor", remote, "HEAD").status === 0
  )
    bases.push(remote);
const distance = (base) => Number(git("rev-list", "--count", `${base}..HEAD`));
const base = bases.sort((a, b) => distance(a) - distance(b))[0];
let args;
if (base) {
  const changed = (filter = "") =>
    execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        ...(filter ? [`--diff-filter=${filter}`] : []),
        `${base}...HEAD`,
        "--",
      ],
      { encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean);
  const files = changed();
  const source =
    /^(?:vite\.config\.ts|(?:src|browser-host)\/.*\.(?:[cm]?[jt]sx?)|scripts\/(?:developer-settings(?:\.test)?\.(?:ts|mjs)|live-setup-probe(?:\.test)?\.mjs))$/s;
  const shared =
    /^(?:package\.json|pnpm-lock\.yaml|vitest\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|tests\/relay-config\.ts|bin\/)/;
  const rust =
    /^(?:crates\/|src-tauri\/|src\/bundled\/mesh-compute\/compute\/|bin\/|rust-toolchain[^/]*|Cargo\.(?:toml|lock)|clippy\.toml)/;
  if (clippy) {
    if (!files.some((file) => rust.test(file))) {
      console.log(
        "No Rust inputs changed; Clippy runs in CI; remaining checks run in CI.",
      );
      process.exit(0);
    }
  }
  if (design) {
    const input =
      /^(?:src\/.*\.(?:css|tsx?|jsx?)$|tests\/fixtures\/design-system(?:\/|\.html$)|scripts\/design-system\/|(?:vite|vitest)\.design\.config\.|scripts\/check-push\.mjs$|lefthook\.yml$)/s;
    if (!files.some((file) => shared.test(file) || input.test(file))) {
      console.log(
        "No design-system inputs changed; remaining checks run in CI.",
      );
      process.exit(0);
    }
  }
  const deleted = changed("D").filter((file) => source.test(file));
  const related = new Set(
    files.filter((file) => source.test(file) && !deleted.includes(file)),
  );
  // tsc fails on dangling imports it checks. Test the files that named a
  // deleted module at the base and still exist, which covers the references it
  // does not check (mocks, .mjs, Vite queries such as ?raw).
  for (const file of importers(deleted)) related.add(file);
  // These tests read files or load app composition outside Vitest's import graph.
  if (files.includes("src/shared/styles/tokens.css"))
    related.add("src/shared/theme/tokens.test.ts");
  if (files.includes("public/appearance-init.js"))
    related.add("src/shared/theme/service.test.ts");
  // The author package builds with its own tsconfig and the pinned pnpm.
  if (
    files.some((file) =>
      /^(?:tsconfig\.author\.json|bin\/(?:pnpm|\.pnpm-[^/]*))$/.test(file),
    )
  )
    related.add("src/plugins/author.test.mjs");
  if (files.includes("vite.config.ts"))
    related.add("browser-host/vite-config.test.mjs");
  if (files.some((file) => file.startsWith("src/")))
    related.add("src/app/pages.integration.test.mjs");
  // Shared configuration and dependency changes get the type check only.
  const checks =
    related.size ||
    deleted.length ||
    files.some(
      (file) =>
        shared.test(file) || /^(?:pnpm-workspace\.yaml|patches\/)/.test(file),
    );
  if (!design && !clippy && !checks) {
    console.log("No JS unit-test inputs changed; remaining checks run in CI.");
    process.exit(0);
  }
  if (related.size)
    args = [
      "related",
      "--run",
      "--passWithNoTests",
      ...Array.from(related, (file) => resolve(file)),
    ];
}
function importers(deleted) {
  if (!deleted.length) return [];
  const module = (file) =>
    posix
      .normalize(file)
      .replace(/\.[cm]?[jt]sx?$/, "")
      .replace(/\/index$/, "");
  const targets = new Set(deleted.map(module));
  const lines = gitRun(
    "grep",
    "-z",
    "-I",
    "-F",
    ...Array.from(targets, (file) => ["-e", posix.basename(file)]).flat(),
    base,
    "--",
    "src",
    "browser-host",
    "scripts",
    "tests",
  ).stdout.split("\n");
  const found = new Set();
  for (const line of lines) {
    const [name, text = ""] = line.split("\0");
    const file = name.slice(base.length + 1);
    if (found.has(file) || deleted.includes(file)) continue;
    for (const [, spec] of text.matchAll(/["'`]([./][^"'`\s?]*)/g))
      if (
        targets.has(
          module(
            spec.startsWith("/")
              ? spec.slice(1)
              : posix.join(posix.dirname(file), spec),
          ),
        )
      )
        found.add(file);
  }
  if (!found.size) return [];
  return gitRun("ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...found)
    .stdout.split("\0")
    .filter(Boolean);
}
if (clippy) {
  console.log("Pre-push: Clippy; no installs, tests or browsers.");
  const result = spawnSync(
    resolve("bin/cargo"),
    [
      // Same invocation as the `native` CI lane and `just scan`; the excluded
      // vendored patch is still compiled through its workspace dependents.
      "clippy",
      "--workspace",
      "--locked",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
    { stdio: "inherit", env: childEnv() },
  );
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
if (design) {
  console.log("Pre-push: design types and guards; no installs or builds.");
  // Reuse CI's scripts without pnpm's dependency auto-repair during a push.
  for (const [command, args] of [
    [
      process.execPath,
      [
        resolve("node_modules/typescript/bin/tsc"),
        "-p",
        "tsconfig.design.json",
      ],
    ],
    [resolve("bin/pnpm"), ["run", "design:check"]],
  ]) {
    const result = spawnSync(command, args, {
      stdio: "inherit",
      env: childEnv({ pnpm_config_verify_deps_before_run: "false" }),
    });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}
console.log(
  "Pre-push: TypeScript and JS unit tests; no installs, native builds or browsers.",
);
const types = spawnSync(
  process.execPath,
  [resolve("node_modules/typescript/bin/tsc"), "--noEmit"],
  { stdio: "inherit", env: childEnv() },
);
if (types.error) console.error(types.error.message);
if (types.status !== 0) process.exit(types.status ?? 1);
if (!args) {
  console.log(
    "Type check only: no related unit tests; the full suite runs in CI.",
  );
  process.exit(0);
}
const result = spawnSync(
  process.execPath,
  [resolve("node_modules/vitest/vitest.mjs"), ...args],
  { stdio: "inherit", env: childEnv() },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
