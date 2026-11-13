// @vitest-environment node
// The real launcher in a throwaway home, with a fake npm, starting a stand-in
// host on this Node: through pi.sh, as on Mac and Linux, and as `node -e`
// alone, as on Windows.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import launch from "./launch.mjs?raw";
import script from "./pi.sh?raw";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

/** What the stand-in host says of where it runs, and the line after the
 * launcher's, which is its own. */
const HOST = `
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).once("line", (line) => {
  console.log(JSON.stringify({ cwd: process.cwd(), data: process.argv[1], host: process.env.BUZZ_PI_HOST, line }));
  process.exit(0);
});`;
const PACKAGE = '{"name":"buzz-pi-host","private":true}';
const LOCK = '{"lockfileVersion":3}';

type Failed = Error & { code: number; stderr: string };

/** Runs `command` with `stdin`, to its stdout; rejects with its stderr. */
function run(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  stdin: string,
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          Object.assign(new Error(`exit ${code}: ${stderr}`), { code, stderr }),
        );
    });
    child.stdin.end(stdin);
  });
}

async function disk(npm = "mkdirSync(join(prefix, 'node_modules'))") {
  const home = await mkdtemp(join(tmpdir(), "buzz-pi-"));
  homes.push(home);
  const bin = join(home, "bin");
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  // Notes each install, then does what the test says, in the folder it got.
  const fake = join(home, "npm.js");
  const fakeNpm = (body: string) =>
    writeFile(
      fake,
      `const { appendFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(home, "npm.log"))}, args.join(" ") + "\\n");
const prefix = process.cwd();
${body}
`,
    );
  await fakeNpm(npm);
  const dir =
    process.platform === "darwin"
      ? join(home, "Library/Application Support/Buzz/pi")
      : join(home, ".local/share/buzz/pi");
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    SHELL: "/bin/false",
    BUZZ_PI_NPM: fake,
  };
  const payload = (lock: string) =>
    `${JSON.stringify({ host: HOST, package: PACKAGE, lock })}\nhello\n`;
  /** Starts the host through pi.sh, as on Mac and Linux. */
  const step = async (extra: Record<string, string> = {}, lock = LOCK) =>
    run(
      "bash",
      ["-c", script, "pi.sh", launch],
      { ...env, ...extra },
      payload(lock),
    );
  /** Starts the host as `node -e`, as on Windows. */
  const node = async (lock = LOCK) =>
    run(
      process.execPath,
      ["--input-type=module", "-e", launch],
      env,
      payload(lock),
    );
  return {
    home,
    bin,
    dir,
    step,
    node,
    fakeNpm,
    installs: async () =>
      (await readFile(join(home, "npm.log"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean),
    folders: async () => (await readdir(join(dir, "deps"))).sort(),
  };
}

it("installs the locked packages once, and runs the host in them", async () => {
  const pi = await disk();
  const first = JSON.parse(await pi.step());
  const [folder, ...others] = await pi.folders();
  expect(others).toEqual([]);
  expect(first).toEqual({
    cwd: expect.stringMatching(new RegExp(`/deps/${folder}$`)),
    data: pi.dir,
    host: "1",
    line: "hello",
  });
  expect(await pi.installs()).toEqual([
    expect.stringMatching(/^ci --ignore-scripts --omit=dev /),
  ]);
  // The next start uses them as they are, as does Node started alone.
  expect(JSON.parse(await pi.step())).toEqual(first);
  expect(JSON.parse(await pi.node())).toEqual(first);
  expect(await pi.installs()).toHaveLength(1);
  // Packages pinned otherwise go beside them.
  await pi.node('{"lockfileVersion":3,"packages":{}}');
  expect(await pi.folders()).toHaveLength(2);
});

it("leaves nothing of an install that failed, and installs again next time", async () => {
  const failing = await disk(
    "mkdirSync(join(prefix, 'node_modules')); process.exit(1)",
  );
  await expect(failing.node()).rejects.toMatchObject({
    stderr: expect.stringContaining("Pi could not install its packages"),
  });
  expect(await failing.folders()).toEqual([]);
  await failing.fakeNpm("");
  await failing.node();
  expect(await failing.installs()).toHaveLength(2);
  expect(await failing.folders()).toHaveLength(1);
});

it("says Pi needs a newer Node when the one it finds is too old", async () => {
  const pi = await disk();
  await rm(join(pi.bin, "node"));
  await writeFile(join(pi.bin, "node"), "#!/bin/sh\nexit 1\n");
  await chmod(join(pi.bin, "node"), 0o755);
  const failed = await pi.step().catch((error: Failed) => error);
  expect(failed).toMatchObject({
    code: 127,
    stderr: expect.stringContaining("Pi needs Node.js 22.19 or later."),
  });
});

it.skipIf(!existsSync("/bin/zsh"))(
  "finds the Node an interactive shell's rc file sets up, past what it prints",
  async () => {
    const pi = await disk();
    await rm(join(pi.bin, "node"));
    // A system Node must not bypass the shell lookup this test exercises.
    await writeFile(join(pi.bin, "node"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    // Only .zshrc, which a plain login shell skips, has this Node, which
    // notes that it ran.
    const managed = join(pi.home, "nvm");
    await mkdir(managed);
    await writeFile(
      join(managed, "node"),
      `#!/bin/sh\ntouch ${JSON.stringify(join(pi.home, "ran"))}\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    );
    await chmod(join(managed, "node"), 0o755);
    await writeFile(
      join(pi.home, ".zshrc"),
      `echo "Welcome back"\nexport PATH=${JSON.stringify(managed)}:$PATH\n`,
    );
    const out = await pi.step({ SHELL: "/bin/zsh" });
    expect(JSON.parse(out)).toMatchObject({ line: "hello" });
    expect(existsSync(join(pi.home, "ran"))).toBe(true);
  },
);
