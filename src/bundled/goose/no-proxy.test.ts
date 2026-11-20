// @vitest-environment node
// The manifest's exact `no-proxy` step, as `buzz-agent-command --shell` runs
// it (`bash -p -c`), read back through `readNoProxy`.
import { spawn as run } from "node:child_process";
import { expect, it } from "vitest";
import type { Spawn } from "./goose";
import manifest from "./manifest.json";
import { readNoProxy } from "./setup";

const step = manifest.host.processes.find(
  (process) => process.id === "no-proxy",
);

/** Everything the step printed, across runs. */
const printed: string[] = [];
/** Runs the step under `env` alone, as the host spawns it. */
const spawnWith =
  (env: Record<string, string>): Spawn =>
  async (id, options = {}) => {
    expect(id).toBe("no-proxy");
    expect(options.args ?? []).toEqual([]);
    const [flag, script, argv0] = step?.args ?? [];
    expect(flag).toBe("--shell");
    const child = run("/bin/bash", ["-p", "-c", script ?? "", argv0 ?? ""], {
      env: { PATH: "/usr/bin:/bin", ...env },
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      printed.push(data);
      options.onStdout?.(data);
    });
    child.stderr.on("data", (data: string) => options.onStderr?.(data));
    return {
      write: async () => {},
      end: async () => {},
      kill: async () => void child.kill(),
      exited: new Promise((resolve) => child.on("exit", resolve)),
    };
  };

it("declares a fixed no-proxy step through the bundled helper, with no arguments", () => {
  expect(step).toMatchObject({
    program: "buzz-agent-command",
    bundled: true,
    args: ["--shell", expect.any(String), "buzz-no-proxy"],
  });
});

it("reads both no-proxy lists as set, whatever they hold, and whether ALL_PROXY or HTTP(S)_PROXY names a proxy", async () => {
  const lists = {
    NO_PROXY: "corp.example, 10.0.0.0/8",
    no_proxy: "é *.internal",
  };
  const secret = "http://user:hunter2@proxy.example:3128";
  for (const name of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ])
    await expect(
      readNoProxy(spawnWith({ ...lists, [name]: secret })),
    ).resolves.toEqual({
      lists: ["corp.example, 10.0.0.0/8", "é *.internal"],
      proxied: true,
    });
  await expect(readNoProxy(spawnWith({}))).resolves.toEqual({
    lists: ["", ""],
    proxied: false,
  });
  // A proxy's value, which may hold a password, is never printed.
  expect(printed.join("")).not.toContain("hunter2");
});

it("fails rather than passing when the step's output isn't its own", async () => {
  const answer =
    (stdout: string, code: number): Spawn =>
    async (_id, options = {}) => {
      options.onStdout?.(stdout);
      return {
        write: async () => {},
        end: async () => {},
        kill: async () => {},
        exited: Promise.resolve(code),
      };
    };
  await expect(readNoProxy(answer("\n\ndirect\n", 1))).rejects.toThrow();
  await expect(readNoProxy(answer("\n\nmaybe\n", 0))).rejects.toThrow(
    "The proxy exceptions are unreadable",
  );
  await expect(readNoProxy(answer("", 0))).rejects.toThrow();
});
