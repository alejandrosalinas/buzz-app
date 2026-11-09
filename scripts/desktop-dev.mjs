import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import {
  desktopOverlay,
  launchEnvironment,
  options,
} from "./desktop-config.mjs";
import { prepareCredentialHelper } from "./dev-credential-helper.mjs";
import { worktreePort } from "./worktree-port.mjs";

// `me` (from `just desktop me`) signs in with the release build's key, read-only.
// Only this argument sets the variable: .env.local is copied into every
// worktree, agents' included, so it must never turn this on.
const me = process.argv[2] === "me";
const args = process.argv.slice(me ? 3 : 2);
// Anywhere else it would pass to Tauri and quietly use the debug key.
const end = args.indexOf("--");
if ((end === -1 ? args : args.slice(0, end)).includes("me")) {
  const others = args.filter(
    (arg, index) => arg !== "me" || (end !== -1 && index > end),
  );
  console.error(
    `\`me\` must come first: just desktop me ${others.join(" ")}`.trimEnd(),
  );
  process.exit(1);
}
const { values, forwarded, rest } = options(args, ["port"]);
if (
  values.port !== undefined &&
  (!/^[0-9]+$/.test(values.port) ||
    Number(values.port) < 1 ||
    Number(values.port) > 65535)
) {
  console.error("--port must be an integer between 1 and 65535.");
  process.exit(1);
}
const port = values.port === undefined ? undefined : Number(values.port);

const help = forwarded.some((arg) => arg === "--help" || arg === "-h");
const root = fileURLToPath(new URL("../", import.meta.url));
const env = launchEnvironment(root);
delete env.BUZZ_DEV_RELEASE_KEY;
if (me) env.BUZZ_DEV_RELEASE_KEY = "1";
// On macOS `me` also routes Keychain items through a helper it installs once,
// so approvals survive rebuilds. Like the release key, only `me` turns it on.
for (const name of [
  "BUZZ_DEV_CREDENTIAL_HELPER",
  "BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE",
  "BUZZ_DEV_HELPER_SIGNING",
])
  delete env[name];
if (me && !help && process.platform === "darwin") {
  try {
    const { helper, identity } = prepareCredentialHelper(root);
    env.BUZZ_DEV_CREDENTIAL_HELPER = helper;
    // Any item may still need its one approval, so a dialog may show.
    env.BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE = "1";
    env.BUZZ_DEV_HELPER_SIGNING = identity;
    // `tauri dev` starts the app with `cargo run`, which starts it through this.
    const runner = fileURLToPath(new URL("./dev-sign-run.sh", import.meta.url));
    for (const triple of ["AARCH64_APPLE_DARWIN", "X86_64_APPLE_DARWIN"])
      env[`CARGO_TARGET_${triple}_RUNNER`] = runner;
  } catch (error) {
    console.warn(
      `Keychain helper unavailable (${error.message}); Keychain may ask for each saved item.`,
    );
  }
}
// Give Rust the development frontend's effective public pin (including an
// explicit empty override), so native agent starts select the signer the
// frontend actually uses.
env.BUZZ_DEV_VIEWER =
  loadEnv("development", root, "BUZZ_DEV_VIEWER").BUZZ_DEV_VIEWER ?? "";
// Stage the bundled helpers before Tauri compiles, outside its dev-server timeout.
if (!help) {
  // Stage for the target Tauri is given, as Tauri tells beforeBuildCommand.
  const at = forwarded.findIndex((arg) => arg === "--target" || arg === "-t");
  const triple =
    at === -1
      ? forwarded.find((arg) => arg.startsWith("--target="))?.slice(9)
      : forwarded[at + 1];
  const helper = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./build-agent-command.mjs", import.meta.url)),
      "--dev",
    ],
    {
      stdio: "inherit",
      env: triple ? { ...env, TAURI_ENV_TARGET_TRIPLE: triple } : env,
    },
  );
  if (helper.error) throw helper.error;
  if (helper.status !== 0) process.exit(helper.status ?? 1);
  const goose = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./build-goose-acp.mjs", import.meta.url)), "--dev"],
    {
      stdio: "inherit",
      env: triple ? { ...env, TAURI_ENV_TARGET_TRIPLE: triple } : env,
    },
  );
  if (goose.error) console.error(goose.error.message);
  if (goose.signal) process.kill(process.pid, goose.signal);
  // Work that never touches Goose should still start; Goose then says
  // goose-acp is missing.
  if (goose.status !== 0)
    console.warn("goose-acp did not stage; Goose agents will not start.");
  const cli = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./build-buzz-cli.mjs", import.meta.url)), "--dev"],
    {
      stdio: "inherit",
      env: triple ? { ...env, TAURI_ENV_TARGET_TRIPLE: triple } : env,
    },
  );
  if (cli.error) console.error(cli.error.message);
  if (cli.signal) process.kill(process.pid, cli.signal);
  if (cli.status !== 0)
    console.warn("buzz did not stage; the bundled buzz CLI will be missing.");
}
const config = desktopOverlay(root);
// Tauri's own --port controls its static-file server, not our Vite server.
// Without --port, each worktree derives its own stable port; vite.config.ts
// derives the same one, so devUrl and Vite's strict port cannot disagree.
const devPort = port ?? worktreePort(root);
config.build = {
  devUrl: `http://localhost:${devPort}`,
  beforeDevCommand: `pnpm dev:desktop --port ${devPort}`,
};
if (!help)
  console.log(
    `Desktop dev server on ${config.build.devUrl}` +
      (port === undefined
        ? " (derived from the worktree path; pass --port to override)"
        : ""),
  );
// Prepend: Tauri treats everything after a bare positional as runner args.
// Explicit user configs merge afterward and retain precedence.
forwarded.unshift("--config", JSON.stringify(config));
// Runner/application arguments after -- belong to Tauri, including any --port.
forwarded.push(...rest);
const result = spawnSync("pnpm", ["tauri", "dev", ...forwarded], {
  stdio: "inherit",
  env,
});
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
