import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import {
  desktopOverlay,
  launchEnvironment,
  options,
  requireProduction,
} from "./desktop-config.mjs";

// A debug bundle for the one thing `just desktop` cannot do: macOS routes a URL
// scheme only to a bundled application, so testing OS deep links there needs a
// bundle registered with Launch Services. Windows and Linux can also use a debug
// build for packaged deep-link behavior; ordinary `just desktop` deliberately
// leaves the OS handler alone. All packaged builds use `buzz`.
// Release bundling stays a plain `pnpm tauri build`.
const args = process.argv.slice(2);
const { forwarded, rest } = options(args, []);
const launch = forwarded.includes("--launch");
for (let index = forwarded.length - 1; index >= 0; index--)
  if (forwarded[index] === "--launch") forwarded.splice(index, 1);
const root = fileURLToPath(new URL("../", import.meta.url));
// `--bundles app` is the cheapest bundle Launch Services will read; a caller who
// wants another format, or none, says so and keeps that choice.
const chose = forwarded.some(
  (arg) =>
    arg === "--bundles" ||
    arg.startsWith("--bundles=") ||
    arg === "--no-bundle",
);
if (launch && chose) {
  console.error(
    "--launch uses the default macOS app bundle and cannot be combined with bundle flags",
  );
  process.exit(1);
}
const artifactOption = forwarded.find(
  (arg) =>
    arg === "--target" ||
    arg.startsWith("--target=") ||
    arg === "-t" ||
    /^-t[^-]/.test(arg) ||
    arg === "--runner" ||
    arg.startsWith("--runner=") ||
    arg === "-r" ||
    /^-r[^-]/.test(arg) ||
    arg === "--config" ||
    arg.startsWith("--config=") ||
    arg === "-c" ||
    /^-c[^-]/.test(arg),
);
const artifactEnvironment = [
  "CARGO_TARGET_DIR",
  "CARGO_BUILD_TARGET",
  "TAURI_CONFIG",
].find((name) => process.env[name]);
if (launch && (artifactOption || artifactEnvironment)) {
  console.error(
    `--launch cannot resolve a custom app artifact from ${artifactOption ?? artifactEnvironment}`,
  );
  process.exit(1);
}
if (launch && process.platform !== "darwin") {
  console.error("--launch is available only on macOS");
  process.exit(1);
}
const defaults = chose ? ["--debug"] : ["--debug", "--bundles", "app"];
// Prepend, as `just desktop` does: Tauri treats everything after a bare positional
// as runner arguments, and a user's own --config must merge after ours to win. The
// overlay gives the bundle the development identifier and any worktree icon.
const config = desktopOverlay(root);
if (process.platform === "darwin") {
  const signingIdentity = loadEnv(
    "development",
    root,
    "BUZZ_DEV_SIGNING_IDENTITY",
  ).BUZZ_DEV_SIGNING_IDENTITY;
  if (signingIdentity) {
    config.bundle = {
      ...config.bundle,
      macOS: { signingIdentity },
    };
  }
}
forwarded.unshift("--config", JSON.stringify(config));
forwarded.push(...rest);
const env = launchEnvironment(root);
requireProduction({ ...loadEnv("production", root, "BUZZ_"), ...env });
const result = spawnSync(
  "pnpm",
  ["tauri", "build", ...defaults, ...forwarded],
  {
    stdio: "inherit",
    env,
  },
);
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
if (result.status !== 0) process.exit(result.status ?? 1);
if (launch) {
  if (!config.bundle?.macOS?.signingIdentity)
    console.warn(
      "Warning: this bundle is ad-hoc signed. macOS notifications may reject it; set BUZZ_DEV_SIGNING_IDENTITY to a stable code-signing certificate.",
    );
  const app = fileURLToPath(
    new URL("../target/debug/bundle/macos/Buzz.app", import.meta.url),
  );
  const opened = spawnSync("open", [app], { stdio: "inherit" });
  if (opened.error) console.error(opened.error.message);
  if (opened.signal) process.kill(process.pid, opened.signal);
  process.exit(opened.status ?? 1);
}
