import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ONBOARDING_TEST_SALT,
  portForPath,
  worktreePort,
} from "../../scripts/worktree-port.mjs";

// Expected values were cross-checked independently of portForPath with
// Python 3.14.5 and a separate Node one-liner, which agree on both:
// python3 -c "import hashlib,sys; h=int(hashlib.sha256(sys.argv[1].encode()).hexdigest(),16); print(10010 + h % 55000)" "$PATH_UNDER_TEST"
// Each is block/buzz's port for the same path (60252 and 42704) plus ten.
const KNOWN = [
  ["/tmp/buzz-worktree-port-fixture", 60262],
  ["/tmp/wörktree ✓", 42714],
];

test("portForPath is deterministic and stays in [10010, 65009]", () => {
  for (const [candidate, expected] of KNOWN) {
    assert.equal(portForPath(candidate), expected);
  }
  for (const candidate of ["", "/", "a".repeat(4096), KNOWN[0][0]]) {
    const port = portForPath(candidate);
    assert.ok(Number.isInteger(port), `${candidate}: ${port}`);
    assert.ok(port >= 10010 && port <= 65009, `${candidate}: ${port}`);
  }
  assert.notEqual(portForPath(`${KNOWN[0][0]}/`), KNOWN[0][1]);
});

test("portForPath remaps the browser-blocked default without colliding with same-path buzz ports", () => {
  // This path's unadjusted SHA-256 mapping is 10080 (Amanda), which browsers
  // reject even when an HTTP server successfully binds it.
  const candidate = "/Users/dev/buzz-app-worktrees/feature-5098";
  const digest = createHash("sha256").update(candidate, "utf8").digest("hex");
  const buzzBasePort = Number(10000n + (BigInt(`0x${digest}`) % 55000n));
  assert.equal(buzzBasePort + 10, 10080);
  assert.equal(portForPath(candidate), 10081);
  for (const offset of [0, 1, 100])
    assert.notEqual(portForPath(candidate), buzzBasePort + offset);
});

test("portForPath is block/buzz's base port plus ten when browser-safe", () => {
  // block/buzz's scripts/instance-env.sh one-liner, transcribed:
  // 10000 + sha256(path) % 55000. HMR is base + 1 and `just web` is base + 100,
  // so an offset of ten clears all three for a checkout at the same root.
  const [candidate] = KNOWN[0];
  const digest = createHash("sha256").update(candidate, "utf8").digest("hex");
  const buzzBasePort = Number(10000n + (BigInt(`0x${digest}`) % 55000n));
  assert.equal(portForPath(candidate), buzzBasePort + 10);
});

test("worktreePort hashes the Git toplevel, or the directory outside Git", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-worktree-port-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Git hooks export repository selectors; never let fixtures resolve to the real repo.
  for (const key of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ])
    delete process.env[key];
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8", stdio: "pipe" }).trim();
  const repo = path.join(directory, "repo");
  git("init", "--quiet", repo);
  const nested = path.join(repo, "nested", "deeper");
  mkdirSync(nested, { recursive: true });
  // Git reports the resolved root (on macOS, /private/var rather than /var).
  const toplevel = git("-C", nested, "rev-parse", "--show-toplevel");
  assert.equal(
    worktreePort(nested),
    portForPath(ONBOARDING_TEST_SALT + toplevel),
  );
  assert.equal(
    worktreePort(repo),
    portForPath(ONBOARDING_TEST_SALT + toplevel),
  );
  assert.equal(
    worktreePort(`${repo}${path.sep}`),
    portForPath(ONBOARDING_TEST_SALT + toplevel),
  );

  const plain = path.join(directory, "plain");
  mkdirSync(plain);
  assert.equal(worktreePort(plain), portForPath(ONBOARDING_TEST_SALT + plain));
  assert.equal(
    worktreePort(`${plain}${path.sep}`),
    portForPath(ONBOARDING_TEST_SALT + plain),
    "trailing separators do not change the fallback",
  );
});
