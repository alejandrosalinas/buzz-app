import { execFileSync, spawn as spawnProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Host } from "../../features/host/service";
import { createGit } from "./git";

export const nodeSpawn: NonNullable<Host["spawn"]> = async (_id, options) => {
  const child = spawnProcess("git", [...(options?.args ?? [])], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      ...options?.env,
    } as NodeJS.ProcessEnv,
  });
  child.stdout.setEncoding("utf8").on("data", (d) => options?.onStdout?.(d));
  child.stderr.setEncoding("utf8").on("data", (d) => options?.onStderr?.(d));
  child.stdin.on("error", () => {});
  const exited = new Promise<number | null>((done) => child.on("close", done));
  return {
    write: async (data) => void child.stdin.write(data),
    end: async (data) => void child.stdin.end(data),
    kill: async () => void child.kill(),
    exited,
  };
};

export const realGit = () => createGit(nodeSpawn);

export function sh(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

export function repo(files: Record<string, string> = { "a.txt": "one\n" }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "changesets-")));
  sh(dir, "init", "-q", "-b", "main");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  sh(dir, "add", "--all");
  sh(dir, "commit", "-q", "-m", "first");
  return dir;
}

export function only<T>(items: readonly (T | undefined)[]): T {
  const [item] = items;
  if (item === undefined) throw new Error("Expected one item.");
  return item;
}
