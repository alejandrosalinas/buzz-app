// Stage the bundled buzz CLI the way a desktop build does, then run the staged file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const stage = spawnSync(
  process.execPath,
  [join(root, "scripts/build-buzz-cli.mjs"), "--dev"],
  { stdio: "inherit" },
);
if (stage.status !== 0) process.exit(stage.status ?? 1);
const binary = join(
  root,
  "src-tauri/resources/bin",
  process.platform === "win32" ? "buzz.exe" : "buzz",
);
const help = spawnSync(binary, ["--help"], { encoding: "utf8" });
if (help.error) throw help.error;
if (help.status !== 0 || !/\bUsage:\s+buzz\b/.test(help.stdout)) {
  console.error(`${binary} --help failed (${help.status})`);
  console.error(help.stdout, help.stderr);
  process.exit(1);
}
console.log(`${binary} --help ok`);

// Derive the inventory from the CLI we actually bundle, rather than copying the
// guard's list. Only two-space entries are roots; deeper entries are subcommands.
const commands = [...help.stdout.matchAll(/^ {2}([a-z][a-z-]*)\s/gm)].map(
  (match) => match[1],
);
assert(
  commands.length > 0,
  "Bundled CLI help advertised no top-level commands",
);
const optionsHelp = help.stdout.split(/^Options:\s*$/m)[1];
assert(optionsHelp, "Bundled CLI help advertised no root Options section");
const options = [
  ...optionsHelp.matchAll(/^ {2}(?:-\w, )? *(--[a-z][a-z-]*)\b/gm),
]
  .map((match) => match[1])
  .filter((option) => option !== "--help");
assert(options.length > 0, "Bundled CLI help advertised no root options");
const invocations = [
  ...commands,
  ...options.flatMap((option) => [option, `${option}=contract-test`]),
];
// Integration tests build the real executable with the workspace test feature
// graph. CI's following test run reuses this build instead of compiling another
// dependency graph with cargo build.
const build = spawnSync(
  "cargo",
  ["test", "--workspace", "--locked", "--no-run"],
  { cwd: root, stdio: "inherit" },
);
if (build.error) throw build.error;
assert.equal(build.status, 0, "Could not build the desktop executable");
const desktop = resolve(
  root,
  process.env.CARGO_TARGET_DIR || "target",
  "debug",
  process.platform === "win32" ? "Buzz.exe" : "Buzz",
);
const home = mkdtempSync(join(tmpdir(), "buzz-cli-contract-"));
try {
  for (const command of invocations) {
    const result = spawnSync(desktop, [command], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: home,
        XDG_DATA_HOME: home,
        XDG_CACHE_HOME: home,
        APPDATA: home,
        LOCALAPPDATA: home,
        // Fail before identity/Keychain access if a command escapes the guard.
        BUZZ_NATIVE_MCP_PORT: "invalid",
        BUZZ_DEV_VIEWER: "",
      },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 1, `${command}: expected bad-input exit`);
    assert.equal(result.stdout, "", `${command}: unexpected stdout`);
    assert.match(
      result.stderr,
      /^This executable is the Buzz desktop app;/,
      `${command}: expected migration diagnostic`,
    );
    assert.match(result.stderr, /no CLI command was executed/);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log(
  `Desktop rejects all ${commands.length} bundled CLI commands and ${options.length} root options (bare and =value)`,
);
