import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { worktreeIcon } from "./worktree-icon.mjs";

// The environment a launcher gives Tauri: the process plus every `BUZZ_` value
// in repository-root `.env.local`. Like the native build, it skips Vite's mode
// files; unlike it, values are always literal (no `$VAR` expansion, quoted or
// not), as in the frontend's Builderlab URL reader. Process values win,
// including an explicit empty one. Names without the `BUZZ_` prefix stay out:
// the file can hold unrelated settings and credentials. Updater inputs stay
// release-only, from the process environment.
export function launchEnvironment(root) {
  let text = "";
  try {
    text = readFileSync(join(root, ".env.local"), "utf8");
  } catch (error) {
    // Never echo the file: it can contain unrelated local credentials.
    if (error?.code !== "ENOENT") throw new Error("Could not read .env.local");
  }
  const local = Object.entries(parseEnv(text.replace(/^\uFEFF/, ""))).filter(
    ([name]) => name.startsWith("BUZZ_") && !name.startsWith("BUZZ_UPDATER_"),
  );
  return { ...Object.fromEntries(local), ...process.env };
}

// Pull `--<name> <value>` and `--<name>=<value>` out of a launcher's arguments.
// Scanning stops at `--`, after which everything belongs to Tauri's runner, and the
// last occurrence wins, as it does for Tauri's own repeated flags. A named option
// with no value yields "", which every caller rejects rather than silently deriving.
export function options(args, names) {
  const values = {};
  const forwarded = [];
  let index = 0;
  for (; index < args.length && args[index] !== "--"; index++) {
    const arg = args[index];
    const name = names.find(
      (candidate) =>
        arg === `--${candidate}` || arg.startsWith(`--${candidate}=`),
    );
    if (name === undefined) forwarded.push(arg);
    else
      values[name] =
        arg === `--${name}`
          ? (args[++index] ?? "")
          : arg.slice(name.length + 3);
  }
  return { values, forwarded, rest: args.slice(index) };
}

// The onboarding-test branch runs as its own app: no storage is copied from the
// installed or development Buzz, its Agents folder is its own (see
// `src-tauri/src/sign_out/legacy_identifier.rs`), and its Keychain items are
// under `xyz.block.buzz.desktop.onboarding-test.*`. See ONBOARDING_TEST.md.
const ONBOARDING_TEST_IDENTIFIER = "xyz.block.buzz.desktop.onboarding-test";

// Production Builderlab, as release builds and `vite.config.ts` default to.
const PRODUCTION_BUILDERLAB_URL = "https://app.builderlab.xyz";
// Inputs that would point the build away from production or fake first run.
// Empty counts as unset, except BUZZ_BUILDERLAB_URL, where empty disables it.
export const NON_PRODUCTION = [
  "BUZZ_DEV_VIEWER",
  "BUZZ_DEV_CREDENTIAL_HELPER",
  "BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE",
  "BUZZ_DEV_FIRST_RUN_ACCOUNT",
  "BUZZ_DEV_OPEN_RELAY",
  "BUZZ_RELAY_URL",
  "BUZZ_COMMUNITY_ALIASES",
  "BUZZ_BUILDERLAB_APPS_DOMAIN",
  "BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG",
  "BUZZ_BUILD_ENTERPRISE_AUTH_RELAYS",
  "BUZZ_BUILD_ENTERPRISE_AUTH_ADAPTER_BASE_URL",
  "BUZZ_NSEC_BACKUP_SERVICE_URL",
  "BUZZ_NSEC_BACKUP_NAMESPACE",
  "BUZZ_DEFAULT_COMMUNITY_URL",
  "BUZZODZ_HOME",
];

/** Refuse a launch environment that isn't production's first run. `env` is
 * the launch environment over Vite's for the mode it builds, so a value in any
 * file Vite reads counts unless the launch overrides it. */
export function requireProduction(env) {
  const set = NON_PRODUCTION.filter((name) => env[name]);
  const builderlab = env.BUZZ_BUILDERLAB_URL;
  if (builderlab !== undefined && builderlab !== PRODUCTION_BUILDERLAB_URL)
    set.unshift("BUZZ_BUILDERLAB_URL");
  if (set.length === 0) return;
  console.error(
    `The onboarding-test build runs against production only. Remove ${set.join(", ")} from .env.local and the shell environment, then retry.`,
  );
  process.exit(1);
}

export function desktopOverlay(root) {
  const config = { identifier: ONBOARDING_TEST_IDENTIFIER };
  const icon = worktreeIcon(root);
  if (icon) config.bundle = { icon: [icon] };
  return config;
}

// Each worktree owns one native MCP test instance (docs/native-mcp.md), so
// relaunches keep its app data and its client finds it rather than another
// worktree's. The bridge scans 100 ports up from its base, so bases are 100
// apart, in [20000, 59900]. native_mcp.rs checks the identifier shape and
// that the base is within 1024-65436.
export function nativeMcpInstance(root) {
  const digest = createHash("sha256").update(root, "utf8").digest("hex");
  return {
    identifier: `dev.local.buzz.foundation.nexus-test-${digest.slice(0, 12)}`,
    port: 20000 + Number(BigInt(`0x${digest}`) % 400n) * 100,
  };
}
