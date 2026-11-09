import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

// Use the local merge base, never fetch or install during a push. Every PR gets
// the full suites in CI; this is fast feedback, not proof for arbitrary refs or
// uncommitted work. A missing base conservatively runs the full JS unit suite.
const base = spawnSync(
  "git",
  ["merge-base", "HEAD", "refs/remotes/origin/main"],
  {
    encoding: "utf8",
  },
);
let args = ["run"];
if (base.status === 0) {
  const changed = (filter = "") =>
    execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        ...(filter ? [`--diff-filter=${filter}`] : []),
        `${base.stdout.trim()}...HEAD`,
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
  const full =
    files.some((file) => shared.test(file)) ||
    changed("D").some((file) => source.test(file));
  const related = new Set(files.filter((file) => source.test(file)));
  // These tests read files or load app composition outside Vitest's import graph.
  if (files.includes("src/shared/styles/tokens.css"))
    related.add("src/shared/theme/tokens.test.ts");
  if (files.includes("public/appearance-init.js"))
    related.add("src/shared/theme/service.test.ts");
  if (files.includes("vite.config.ts"))
    related.add("browser-host/vite-config.test.mjs");
  if (files.some((file) => file.startsWith("src/")))
    related.add("src/app/pages.integration.test.mjs");
  if (!design && !clippy && !full && !related.size) {
    console.log("No JS unit-test inputs changed; remaining checks run in CI.");
    process.exit(0);
  }
  if (!full)
    args = [
      "related",
      "--run",
      "--passWithNoTests",
      ...Array.from(related, (file) => resolve(file)),
    ];
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
const result = spawnSync(
  process.execPath,
  [resolve("node_modules/vitest/vitest.mjs"), ...args],
  { stdio: "inherit", env: childEnv() },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
