import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

const REVISION = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;

export function captureBuildIdentity(root, { mutable = false } = {}) {
  if (mutable) return { revision: null, state: "unknown" };
  let revision = null;
  try {
    const repository = execFileSync(
      "git",
      ["-C", root, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (realpathSync(repository) !== realpathSync(root))
      return { revision: null, state: "unknown" };
    const found = execFileSync(
      "git",
      ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (REVISION.test(found)) revision = found;
  } catch {}

  if (!revision) return { revision, state: "unknown" };

  try {
    const status = execFileSync(
      "git",
      [
        "-C",
        root,
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return { revision, state: status.trim() ? "dirty" : "clean" };
  } catch {
    return { revision, state: "unknown" };
  }
}
