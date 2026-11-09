// The real claude.sh switching releases in a throwaway home, as Buzz builds
// sharing one folder do.
import {
  type ExecFileOptions,
  execFile,
  type PromiseWithChild,
  spawn,
} from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { watch } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import script from "./claude.sh?raw";
import { PROTECTED_CLAUDE_VERSION } from "./security";

const execFileAsync = promisify(execFile);
const homes: string[] = [];
const runs: PromiseWithChild<unknown>[] = [];
afterEach(async () => {
  // A test that times out can leave launchers running, which would write into
  // its home as it is removed. Each stopped here is expected to fail. Taking
  // its homes off `homes` first makes `run` refuse any its body starts later.
  const removing = homes.splice(0);
  await Promise.all(
    runs.splice(0).map(async (running) => {
      const { child } = running;
      if (child.exitCode !== null || child.signalCode !== null) return;
      running.catch(() => {});
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }),
  );
  await Promise.all(
    removing.map((home) => rm(home, { recursive: true, force: true })),
  );
});

/** Runs `file`, which `afterEach` stops if the test leaves it running. */
function run(
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {},
) {
  // A timed-out test's body goes on after `afterEach`. Started in its home,
  // claude.sh would write into it as it is removed.
  const home = options.env?.HOME;
  if (home !== undefined && !homes.includes(home))
    throw new Error(`${home} is removed: its test has ended`);
  const running = execFileAsync(file, args, { ...options, encoding: "utf8" });
  runs.push(running);
  return running;
}

/** Buzz's claude-code folder in a new home, holding fake `releases` with `current`. */
async function disk(releases: readonly string[], current?: string) {
  const home = await mkdtemp(join(tmpdir(), "buzz-claude-"));
  homes.push(home);
  const dir =
    process.platform === "darwin"
      ? join(home, "Library/Application Support/Buzz/claude-code")
      : join(home, ".local/share/buzz/claude-code");
  for (const version of releases) {
    const binary = join(dir, version, "claude");
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, `#!/bin/sh\necho "${version}"\n`);
    await chmod(binary, 0o755);
  }
  if (current) await writeFile(join(dir, "current"), current);
  const step = (...args: string[]) =>
    run("bash", ["-c", script, "claude.sh", ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: home },
    });
  return {
    home,
    dir,
    step,
    /** Leaves no doubt the release `current` names still runs. */
    selected: async () => (await step("run", "--version")).stdout.trim(),
    folders: async () =>
      (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
  };
}

// Builds that fetched 0.2.0 and 0.3.0 switch in either order, or at once;
// none prunes what another made current.
it("keeps the newer release when it switches first", async () => {
  const first = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await first.step("use", "0.2.0");
  await first.step("use", "0.3.0");
  expect(await first.selected()).toBe("0.3.0");
});

it("keeps the newer release when an older one switches after it", async () => {
  const second = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await second.step("use", "0.3.0");
  await expect(second.step("use", "0.2.0")).rejects.toThrow();
  expect(await second.selected()).toBe("0.3.0");
});

it("keeps the release in use when builds switch at once", async () => {
  const both = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await Promise.allSettled([
    both.step("use", "0.2.0"),
    both.step("use", "0.3.0"),
  ]);
  const current = await readFile(join(both.dir, "current"), "utf8");
  expect(await both.selected()).toBe(current);
});

it("prunes older releases but keeps a newer one another build may be testing", async () => {
  const { step, folders } = await disk(
    ["0.1.0", "0.2.0", "0.3.0", "0.10.0"],
    "0.2.0",
  );
  await step("use", "0.3.0");
  expect(await folders()).toEqual(["0.10.0", "0.2.0", "0.3.0"]);
});

it("keeps the release protected agents run when it switches past it", async () => {
  const pinned = PROTECTED_CLAUDE_VERSION;
  const { step, folders } = await disk([pinned, "99.0.0", "99.1.0"], "99.0.0");
  await step("use", "99.1.0");
  expect(await folders()).toEqual([pinned, "99.0.0", "99.1.0"]);
});

/** Holds the switch lock, as a build that is switching does, until killed. */
async function hold(dir: string) {
  const holder = spawn("perl", [
    "-MFcntl=:flock",
    "-e",
    'open(my $l, ">>", $ARGV[0]) or die; flock($l, LOCK_EX) or die; $| = 1; print "held\\n"; sleep 60',
    join(dir, ".lock"),
  ]);
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  return holder;
}
/** Resolves once the switch with process `pid` is waiting for the lock. */
const waiting = (pid: number | undefined) =>
  expect
    .poll(() =>
      run("pgrep", ["-P", String(pid), "-x", "flock|perl"]).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);

it("waits for a switch in progress, and goes on once its holder is killed", async () => {
  const { dir, step, selected } = await disk(["0.1.0", "0.2.0"], "0.1.0");
  const holder = await hold(dir);
  // A timeout while `hold` waits lets `afterEach` remove the home first;
  // `step` then throws, and the holder must still be killed.
  let switching: ReturnType<typeof step>;
  try {
    switching = step("use", "0.2.0");
    await waiting(switching.child.pid);
    expect(await selected()).toBe("0.1.0");
  } finally {
    holder.kill("SIGKILL");
  }
  await switching;
  expect(await selected()).toBe("0.2.0");
});

it("leaves the release in use when its switch's release is pruned while it waits", async () => {
  const { dir, step, selected } = await disk(["0.1.0", "0.2.0"], "0.2.0");
  const holder = await hold(dir);
  let switching: ReturnType<typeof step>;
  try {
    switching = step("use", "0.1.0");
    await waiting(switching.child.pid);
    // The holder's own prune removes the older release this switch named.
    await rm(join(dir, "0.1.0"), { recursive: true });
  } finally {
    holder.kill("SIGKILL");
  }
  await expect(switching).rejects.toThrow("0.1.0 is no longer downloaded");
  expect(await selected()).toBe("0.2.0");
});

it("starts the release in use when switches prune the one it read", async () => {
  const { home, step, folders } = await disk(
    ["0.1.0", "0.2.0", "0.3.0"],
    "0.1.0",
  );
  // A `cat` that stops after its first read, of `current`, until `go`. It also
  // stops once a timed-out test's home is removed, or after 30 s in case the
  // worker died before removing it.
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "cat"),
    `#!/usr/bin/env bash\n/bin/cat "$@"\n[ -e "${bin}/read" ] && exit\n: >"${bin}/read"\nuntil [ -e "${bin}/go" ] || [ ! -d "${bin}" ] || [ "$SECONDS" -ge 30 ]; do sleep 0.05; done\n`,
  );
  await chmod(join(bin, "cat"), 0o755);
  let observed!: () => void;
  let failed!: (error: Error) => void;
  const read = new Promise<void>((resolve, reject) => {
    observed = resolve;
    failed = reject;
  });
  const watcher = watch(bin, (_event, name) => {
    if (name === "read") observed();
  });
  watcher.once("error", failed);
  const launching = run(
    "bash",
    ["-c", script, "claude.sh", "run", "--version"],
    {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home },
    },
  );
  try {
    // Observe the actual read event; process startup is not the behavior under test.
    await Promise.race([
      read,
      launching.then(() => {
        throw new Error("Launcher exited before reading current");
      }),
    ]);
    // Two builds switch past the release the launcher read, pruning it.
    await step("use", "0.2.0");
    await step("use", "0.3.0");
    expect(await folders()).not.toContain("0.1.0");
    await writeFile(join(bin, "go"), "");
    expect((await launching).stdout.trim()).toBe("0.3.0");
  } finally {
    watcher.close();
    // Fails once `afterEach` has removed a timed-out test's home.
    await writeFile(join(bin, "go"), "").catch(() => {});
    launching.child.kill();
    await launching.catch(() => {});
  }
});

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** A `curl` on PATH that counts its calls and saves `release` where -o names. */
async function downloads(home: string, release: string) {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "release"), release);
  await writeFile(
    join(bin, "curl"),
    `#!/bin/sh\necho >>"${bin}/calls"\nwhile [ "$1" != -o ]; do shift; done\n/bin/cp "${bin}/release" "$2"\n`,
  );
  await chmod(join(bin, "curl"), 0o755);
  return {
    install: (version: string, checksum: string) =>
      run(
        "bash",
        [
          "-c",
          script,
          "claude.sh",
          "install",
          version,
          "darwin-arm64",
          checksum,
        ],
        { env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home } },
      ),
    calls: () =>
      readFile(join(bin, "calls"), "utf8").then(
        (calls) => calls.split("\n").length - 1,
        () => 0,
      ),
  };
}
const release = (version: string) => `#!/bin/sh\necho "${version}"\n`;

// A build stopped between `install` and `use` leaves the release whole but none in use.
it("uses a downloaded release that matches its checksum without downloading it again", async () => {
  const { home, dir, step, selected } = await disk(["0.2.0"]);
  const binary = join(dir, "0.2.0", "claude");
  await chmod(binary, 0o644);
  const { install, calls } = await downloads(home, "unused");
  const { stdout } = await install(
    "0.2.0",
    sha256(await readFile(binary, "utf8")),
  );
  expect(stdout).toContain("Claude 0.2.0 is already downloaded.");
  expect(await calls()).toBe(0);
  await expect(selected()).rejects.toThrow("Claude is not installed");
  await step("use", "0.2.0");
  expect(await selected()).toBe("0.2.0");
});

// A release this user cannot chmod, such as one another account wrote, is still used.
it("uses an executable matching release without changing its mode", async () => {
  const { home, dir } = await disk(["0.2.0"]);
  const binary = join(dir, "0.2.0", "claude");
  const { install, calls } = await downloads(home, "unused");
  await writeFile(join(home, "bin", "chmod"), "#!/bin/sh\nexit 1\n");
  await chmod(join(home, "bin", "chmod"), 0o755);
  const { stdout } = await install(
    "0.2.0",
    sha256(await readFile(binary, "utf8")),
  );
  expect(stdout).toContain("Claude 0.2.0 is already downloaded.");
  expect(await calls()).toBe(0);
});

it("downloads again over a matching release it cannot make executable", async () => {
  const { home, dir, step, selected } = await disk([]);
  const binary = join(dir, "0.2.0", "claude");
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, release("0.2.0"));
  await chmod(binary, 0o644);
  const { install, calls } = await downloads(home, release("0.2.0"));
  // Refuses only the cached file, so the download can still mark its own copy executable.
  await writeFile(
    join(home, "bin", "chmod"),
    '#!/bin/sh\ncase "$2" in */claude) exit 1 ;; esac\nexec /bin/chmod "$@"\n',
  );
  await chmod(join(home, "bin", "chmod"), 0o755);
  await install("0.2.0", sha256(release("0.2.0")));
  expect(await calls()).toBe(1);
  expect(await readFile(binary, "utf8")).toBe(release("0.2.0"));
  await step("use", "0.2.0");
  expect(await selected()).toBe("0.2.0");
});

it("downloads again over a release that does not match its checksum", async () => {
  const { home, dir } = await disk([]);
  const binary = join(dir, "0.2.0", "claude");
  await mkdir(dirname(binary), { recursive: true });
  // Cut short, as a copy written some other way may be.
  await writeFile(binary, release("0.2.0").slice(0, 12));
  const { install, calls } = await downloads(home, release("0.2.0"));
  await install("0.2.0", sha256(release("0.2.0")));
  expect(await calls()).toBe(1);
  expect(await readFile(binary, "utf8")).toBe(release("0.2.0"));
});

it("downloads again when a stopped download left only its partial file", async () => {
  const { home, dir } = await disk([]);
  const binary = join(dir, "0.2.0", "claude");
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(`${binary}.4242`, release("0.2.0"));
  const { install, calls } = await downloads(home, release("0.2.0"));
  await install("0.2.0", sha256(release("0.2.0")));
  expect(await calls()).toBe(1);
  expect(await readFile(binary, "utf8")).toBe(release("0.2.0"));
});

it("does not use a link to a release that matches its checksum", async () => {
  const { home, dir } = await disk([]);
  const target = join(home, "elsewhere");
  await writeFile(target, release("0.2.0"));
  await mkdir(join(dir, "0.2.0"), { recursive: true });
  await symlink(target, join(dir, "0.2.0", "claude"));
  const { install, calls } = await downloads(home, release("0.2.0"));
  await install("0.2.0", sha256(release("0.2.0")));
  expect(await calls()).toBe(1);
  expect((await lstat(join(dir, "0.2.0", "claude"))).isSymbolicLink()).toBe(
    false,
  );
});

it("keeps a mismatched download from being used", async () => {
  const { home, dir, step, selected } = await disk(["0.1.0"], "0.1.0");
  const { install, calls } = await downloads(home, release("0.2.0"));
  await expect(install("0.2.0", sha256("something else"))).rejects.toThrow(
    "The download did not match its checksum",
  );
  expect(await calls()).toBe(1);
  await expect(readdir(join(dir, "0.2.0"))).resolves.toEqual([]);
  await expect(step("use", "0.2.0")).rejects.toThrow("no longer downloaded");
  expect(await selected()).toBe("0.1.0");
});

// An empty digest from a hash that failed must not match: the checksum itself is refused.
it("refuses a checksum that is not 64 hex digits before reusing or downloading", async () => {
  const { home, dir } = await disk(["0.2.0"]);
  const { install, calls } = await downloads(home, release("0.2.0"));
  const digest = sha256(release("0.2.0"));
  for (const checksum of [
    "",
    digest.slice(1),
    digest.toUpperCase(),
    `${digest.slice(1)}/`,
  ])
    await expect(install("0.2.0", checksum)).rejects.toThrow(
      "Invalid checksum",
    );
  expect(await calls()).toBe(0);
  expect(await readFile(join(dir, "0.2.0", "claude"), "utf8")).toBe(
    release("0.2.0"),
  );
});

/** claude.sh's review step in a new home. */
async function reviewHome() {
  const { home } = await disk([]);
  const review = join(
    home,
    "Library/Application Support/Buzz/claude-code-review-home",
  );
  return {
    home,
    review,
    reviewFolder: () => {
      const running = run("bash", ["-c", script, "claude.sh", "review"], {
        env: { PATH: process.env.PATH ?? "", HOME: home },
      });
      running.child.stdin?.end();
      return running as Promise<{ stdout: string; stderr: string }>;
    },
  };
}

it.skipIf(process.platform !== "darwin")(
  "makes reviews' own folder privately on first use and prints it",
  async () => {
    const { review, reviewFolder } = await reviewHome();
    await expect(reviewFolder()).resolves.toEqual({
      stdout: `${review}\n`,
      stderr: "",
    });
    expect((await lstat(review)).mode & 0o777).toBe(0o700);
    await expect(reviewFolder()).resolves.toEqual({
      stdout: `${review}\n`,
      stderr: "",
    });
  },
);

it.skipIf(process.platform !== "darwin")(
  "refuses a review folder that is a link",
  async () => {
    const { home, review, reviewFolder } = await reviewHome();
    const target = join(home, "elsewhere");
    await mkdir(target);
    await mkdir(dirname(review), { recursive: true });
    await symlink(target, review);
    const reading = reviewFolder();
    await expect(reading).rejects.toThrow(
      "The Claude review folder is not a folder",
    );
    await reading.catch((error: { stdout: string }) =>
      expect(error.stdout).toBe(""),
    );
  },
);
