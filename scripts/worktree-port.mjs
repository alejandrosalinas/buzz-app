import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

// block/buzz's formula with the base offset by ten: sha256(absolute worktree
// root) -> 10010 + digest % 55000, so the result lies in [10010, 65009].
// The one browser-blocked port in this range, 10080, moves to 10081:
// https://fetch.spec.whatwg.org/#port-blocking
// block/buzz's scripts/instance-env.sh maps the same input with
// 10000 + digest % 55000, then uses base + 1 for HMR and base + 100 for
// `just web`. Our offset of ten (eleven for that exception) clears all three
// for the same path. Different paths hash independently and can collide;
// the two repositories' ranges are not disjoint. Use --port when occupied.
// Hashing the path rather than the branch keeps the port, and with it Tauri's
// config and Cargo's warm build, stable across branch switches inside a worktree.
export function portForPath(path) {
  const digest = createHash("sha256").update(path, "utf8").digest("hex");
  const port = Number(10010n + (BigInt(`0x${digest}`) % 55000n));
  return port === 10080 ? 10081 : port;
}

// The onboarding-test branch salts the hashed root. An unbundled run keeps its
// WebView storage per origin in one folder every `just desktop` shares, so a
// checkout switched to this branch must not reuse its usual origin's storage.
export const ONBOARDING_TEST_SALT = "onboarding-test:";

// The worktree root reported by Git; outside a checkout, the directory itself.
// A missing git or a plain directory is an ordinary outcome, not an exception,
// so this reads spawnSync's exit status rather than catching a throw.
export function worktreePort(dir) {
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return portForPath(
    ONBOARDING_TEST_SALT +
      (git.status === 0 ? git.stdout.trim() : resolve(dir)),
  );
}
