import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureBuildIdentity } from "./build-identity.mjs";

const directories = [];

function repository() {
  const root = mkdtempSync(join(tmpdir(), "buzz-build-identity-"));
  directories.push(root);
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", `core.hooksPath=${join(root, ".git/disabled-hooks")}`, ...args],
      {
        cwd: root,
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: join(root, ".unused-global-git-config"),
        },
      },
    );
  git("init", "--quiet", "--template=");
  git("config", "user.name", "Buzz Test");
  git("config", "user.email", "buzz-test@example.org");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "source.txt"), "source\n");
  git("add", "source.txt");
  git("commit", "--quiet", "-m", "initial source");
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("captures a committed production source as clean and a mutable edit as dirty", () => {
  const root = repository();
  const clean = captureBuildIdentity(root);
  expect(clean.revision).toBe(
    execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  );
  expect(clean.state).toBe("clean");

  writeFileSync(join(root, "source.txt"), "edited source\n");
  expect(captureBuildIdentity(root)).toEqual({
    revision: clean.revision,
    state: "dirty",
  });
});

it("keeps a dev server or a source archive unknown without failing configuration", () => {
  const root = repository();
  expect(captureBuildIdentity(root, { mutable: true })).toEqual({
    revision: null,
    state: "unknown",
  });

  const archive = mkdtempSync(join(tmpdir(), "buzz-build-archive-"));
  directories.push(archive);
  expect(captureBuildIdentity(archive)).toEqual({
    revision: null,
    state: "unknown",
  });
});

it("does not borrow an enclosing repository's clean revision for a source archive", () => {
  const root = repository();
  const archive = join(root, "archive");
  mkdirSync(archive);
  expect(captureBuildIdentity(archive)).toEqual({
    revision: null,
    state: "unknown",
  });
});
