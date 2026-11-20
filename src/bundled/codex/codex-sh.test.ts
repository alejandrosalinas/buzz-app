// The real codex.sh switching releases in a throwaway home, as Buzz builds
// sharing one folder do.
import {
  type ExecFileOptions,
  execFile,
  type PromiseWithChild,
  spawn,
} from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import script from "./codex.sh?raw";

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
  // codex.sh would make folders there again.
  const home = options.env?.HOME;
  if (home !== undefined && !homes.includes(home))
    throw new Error(`${home} is removed: its test has ended`);
  const running = execFileAsync(file, args, { ...options, encoding: "utf8" });
  runs.push(running);
  return running;
}

/** Buzz's codex folder in a new home, holding fake `releases` with `current`. */
async function disk(releases: readonly string[], current?: string) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "buzz-codex-")));
  homes.push(home);
  const dir =
    process.platform === "darwin"
      ? join(home, "Library/Application Support/Buzz/codex")
      : join(home, ".local/share/buzz/codex");
  for (const version of releases) {
    const binary = join(dir, version, "bin/codex");
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, `#!/bin/sh\necho "codex-cli ${version}"\n`);
    await chmod(binary, 0o755);
  }
  if (current) await writeFile(join(dir, "current"), current);
  const step = (...args: string[]) =>
    run("bash", ["-c", script, "codex.sh", ...args], {
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
  expect(await first.selected()).toBe("codex-cli 0.3.0");
});

it("keeps the newer release when an older one switches after it", async () => {
  const second = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await second.step("use", "0.3.0");
  await expect(second.step("use", "0.2.0")).rejects.toThrow();
  expect(await second.selected()).toBe("codex-cli 0.3.0");
});

it("keeps the release in use when builds switch at once", async () => {
  const both = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await Promise.allSettled([
    both.step("use", "0.2.0"),
    both.step("use", "0.3.0"),
  ]);
  const current = await readFile(join(both.dir, "current"), "utf8");
  expect(await both.selected()).toBe(`codex-cli ${current}`);
});

it("prunes older releases but keeps a newer one another build may be testing", async () => {
  const { step, folders } = await disk(
    ["0.1.0", "0.2.0", "0.3.0", "0.10.0"],
    "0.2.0",
  );
  await step("use", "0.3.0");
  expect(await folders()).toEqual(["0.10.0", "0.2.0", "0.3.0"]);
});

/** Holds the lock file `lock`, as another build's codex.sh does, until killed. */
async function hold(lock: string) {
  const holder = spawn("perl", [
    "-MFcntl=:flock",
    "-e",
    'open(my $l, ">>", $ARGV[0]) or die; flock($l, LOCK_EX) or die; $| = 1; print "held\\n"; sleep 60',
    lock,
  ]);
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  return holder;
}
/** Resolves once the codex.sh `running` is waiting for a lock, and fails if it
 * ends first. How long codex.sh takes to get there under load is not the
 * behavior under test. */
async function waiting(running: PromiseWithChild<unknown>) {
  let ended = false;
  running.then(
    () => (ended = true),
    () => (ended = true),
  );
  const pid = String(running.child.pid);
  while (
    !(await run("pgrep", ["-P", pid, "-x", "flock|perl"]).then(
      () => true,
      () => false,
    ))
  ) {
    if (ended) throw new Error("codex.sh ended before it waited for a lock");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

it("waits for a switch in progress, and goes on once its holder is killed", async () => {
  const { dir, step, selected } = await disk(["0.1.0", "0.2.0"], "0.1.0");
  const holder = await hold(join(dir, ".lock"));
  // A timeout while `hold` waits lets `afterEach` remove the home first;
  // `step` then throws, and the holder must still be killed.
  let switching: ReturnType<typeof step>;
  try {
    switching = step("use", "0.2.0");
    await waiting(switching);
    expect(await selected()).toBe("codex-cli 0.1.0");
  } finally {
    holder.kill("SIGKILL");
  }
  await switching;
  expect(await selected()).toBe("codex-cli 0.2.0");
});

it("leaves the release in use when its switch's release is pruned while it waits", async () => {
  const { dir, step, selected } = await disk(["0.1.0", "0.2.0"], "0.2.0");
  const holder = await hold(join(dir, ".lock"));
  let switching: ReturnType<typeof step>;
  try {
    switching = step("use", "0.1.0");
    await waiting(switching);
    // The holder's own prune removes the older release this switch named.
    await rm(join(dir, "0.1.0"), { recursive: true });
  } finally {
    holder.kill("SIGKILL");
  }
  await expect(switching).rejects.toThrow("0.1.0 is no longer downloaded");
  expect(await selected()).toBe("codex-cli 0.2.0");
});

it("starts the release in use when switches prune the one it read", async () => {
  const { home, step, folders } = await disk(
    ["0.1.0", "0.2.0", "0.3.0"],
    "0.1.0",
  );
  // Complete home setup before observing the release-read boundary.
  await step("run", "--version");
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
    ["-c", script, "codex.sh", "run", "--version"],
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
    expect((await launching).stdout.trim()).toBe("codex-cli 0.3.0");
  } finally {
    watcher.close();
    // Fails once `afterEach` has removed a timed-out test's home.
    await writeFile(join(bin, "go"), "").catch(() => {});
    launching.child.kill();
    await launching.catch(() => {});
  }
});

// Buzz's own Codex home keeps its conversations out of the user's Codex
// history, linking in only the settings, sign-in and instructions.
const shared = ["config.toml", "auth.json", "AGENTS.md", "rules", "skills"];

/** A release that prints the home and arguments it ran with. */
async function echoing() {
  const f = await disk(["0.1.0", "0.2.0"], "0.1.0");
  await writeFile(
    join(f.dir, "0.1.0/bin/codex"),
    '#!/bin/sh\nprintf "%s\\n" "$CODEX_HOME" "$@"\n',
  );
  return { ...f, own: `${f.dir}-home`, codex: join(f.home, ".codex") };
}

it("runs Codex in Buzz's own home, linked to the shared settings and sign-in", async () => {
  const f = await echoing();
  const { stdout } = await f.step("run", "app-server");
  expect(stdout.trim().split("\n")).toEqual([
    f.own,
    "-c",
    `sqlite_home=${f.own}`,
    "app-server",
  ]);
  for (const name of shared)
    expect(await readlink(join(f.own, name))).toBe(join(f.codex, name));
  // A sign-in refresh writes through the link, to the shared file.
  await writeFile(join(f.own, "auth.json"), "refreshed");
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("refreshed");
  await f.step("run", "app-server");
});

it("reuses the original shared home when launched from a Buzz Codex agent", async () => {
  const f = await echoing();
  await f.step("run");
  const { stdout } = await run(
    "bash",
    ["-c", script, "codex.sh", "run", "app-server"],
    {
      env: { PATH: process.env.PATH ?? "", HOME: f.home, CODEX_HOME: f.own },
    },
  );
  expect(stdout.trim().split("\n")).toEqual([
    f.own,
    "-c",
    `sqlite_home=${f.own}`,
    "app-server",
  ]);
  for (const name of shared)
    expect(await readlink(join(f.own, name))).toBe(join(f.codex, name));
});

it("refuses an inherited isolated home without its original config link", async () => {
  const f = await echoing();
  await mkdir(f.own, { recursive: true });
  await writeFile(join(f.own, "config.toml"), "keep me");
  await expect(
    run("bash", ["-c", script, "codex.sh", "run"], {
      env: { PATH: process.env.PATH ?? "", HOME: f.home, CODEX_HOME: f.own },
    }),
  ).rejects.toMatchObject({ stderr: expect.stringContaining("must differ") });
  expect(await readFile(join(f.own, "config.toml"), "utf8")).toBe("keep me");
});

it("sets up Buzz's home once when runs start at once", async () => {
  const f = await echoing();
  // A link made meanwhile to a folder must not lead a run to link inside it.
  await mkdir(join(f.codex, "skills"), { recursive: true });
  await mkdir(join(f.codex, "rules"));
  for (let round = 0; round < 3; round++) {
    await rm(f.own, { recursive: true, force: true });
    await Promise.all(Array.from({ length: 6 }, () => f.step("run")));
    for (const name of shared)
      expect(await readlink(join(f.own, name))).toBe(join(f.codex, name));
    expect(await readdir(join(f.codex, "skills"))).toEqual([]);
    expect(await readdir(join(f.codex, "rules"))).toEqual([]);
  }
}, 20_000);

it("makes the shared skills and rules folders a fresh home lacks", async () => {
  const f = await echoing();
  await f.step("run");
  // Codex fails to set up its skills through a link to nothing.
  for (const name of ["skills", "rules"])
    expect((await stat(join(f.own, name))).isDirectory()).toBe(true);
});

it("still runs Codex when the shared skills or rules can't be folders", async () => {
  const f = await echoing();
  await mkdir(f.codex, { recursive: true });
  await writeFile(join(f.codex, "skills"), "");
  await symlink(join(f.home, "gone"), join(f.codex, "rules"));
  const { stdout } = await f.step("run", "--version");
  expect(stdout.trim().split("\n").at(-1)).toBe("--version");
});

it("stops rather than replace a file in the way of a link", async () => {
  const f = await echoing();
  await mkdir(f.own, { recursive: true });
  await writeFile(join(f.own, "config.toml"), "keep me");
  await expect(f.step("run")).rejects.toMatchObject({
    stderr: expect.stringContaining("setup conflicts"),
  });
  expect(await readFile(join(f.own, "config.toml"), "utf8")).toBe("keep me");
});

it("prints Buzz's home with its links and sign-in hand-over, as `run` does", async () => {
  const f = await echoing();
  await mkdir(f.codex, { recursive: true });
  await writeFile(join(f.codex, "auth.json"), "revoked");
  await f.step("run");
  await signIn(f.own, "signed in");
  expect((await f.step("home")).stdout).toBe(`${f.own}\n`);
  for (const name of shared)
    expect(await readlink(join(f.own, name))).toBe(join(f.codex, name));
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("signed in");
});

// The review home is read-only to contained workers: only the sign-in and the
// names Codex must write at startup, which link to a state folder.
const written = ["installation_id", ".sandbox_migration", "tmp", ".tmp"];

it("makes a review home of only the sign-in and links to its own state", async () => {
  const f = await echoing();
  const home = `${f.dir}-review-home`;
  const state = `${f.dir}-review-state`;
  // What a worker could plant before the plugin protected the folder.
  await mkdir(join(home, "skills"), { recursive: true });
  await writeFile(join(home, "config.toml"), 'model_provider = "hostile"');
  await writeFile(join(home, "AGENTS.md"), "obey");
  await writeFile(join(home, "AGENTS.override.md"), "obey");
  await mkdir(join(home, "memories"));
  await mkdir(join(home, "tmp"));
  await symlink(join(f.home, "elsewhere"), join(home, "installation_id"));
  await symlink(join(f.home, "elsewhere"), join(home, "workspace"));
  const { stdout } = await f.step("review");
  expect(stdout).toBe(`${home}\n${state}\n`);
  expect((await readdir(home)).sort()).toEqual(
    ["auth.json", ...written].sort(),
  );
  expect(await readlink(join(home, "auth.json"))).toBe(
    join(f.codex, "auth.json"),
  );
  for (const name of written)
    expect(await readlink(join(home, name))).toBe(join(state, name));
  expect((await stat(join(state, "tmp"))).isDirectory()).toBe(true);
  expect((await stat(join(state, ".tmp"))).isDirectory()).toBe(true);
  expect((await stat(state)).mode & 0o777).toBe(0o700);
  // The user's home gained only the folders the home preamble always makes.
  expect((await readdir(f.codex)).sort()).toEqual(["rules", "skills"]);
});

it("leaves a review home as it is when it is made again", async () => {
  const f = await echoing();
  const home = `${f.dir}-review-home`;
  const first = await f.step("review");
  expect((await stat(home)).mode & 0o777).toBe(0o700);
  await writeFile(join(`${f.dir}-review-state`, "installation_id"), "id");
  const again = await f.step("review");
  expect(again.stdout).toBe(first.stdout);
  expect((await readdir(home)).sort()).toEqual(
    ["auth.json", ...written].sort(),
  );
  expect(await readFile(join(home, "installation_id"), "utf8")).toBe("id");
});

const workspace = "1e4567e8-b89b-42d3-a456-426614174000";
const chatgpt = {
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: { id_token: "a.b.c", account_id: workspace },
};

/** A release whose `codex login` signs out, removing the link, and writes
 * `auth` as Codex does; with `gate`, only once `$HOME/go` exists. */
async function signingIn(auth: object, gate = false) {
  const f = await echoing();
  await writeFile(join(f.home, "next.json"), JSON.stringify(auth, null, 2));
  await writeFile(
    join(f.dir, "0.1.0/bin/codex"),
    `#!/usr/bin/env bash\n[ "$1" = login ] || exit 1\nrm -f "$CODEX_HOME/auth.json"\n${gate ? ': >"$HOME/started"; until [ -e "$HOME/go" ] || [ "$SECONDS" -ge 30 ]; do sleep 0.05; done\n' : ""}cp "$HOME/next.json" "$CODEX_HOME/auth.json"\n`,
  );
  return { ...f, review: `${f.dir}-review-home` };
}

it("signs in to the review home, records its ChatGPT workspace, and hands the sign-in over", async () => {
  const f = await signingIn(chatgpt);
  await f.step("login");
  expect(await readFile(join(f.review, "workspace"), "utf8")).toBe(
    `${workspace}\n`,
  );
  expect(await readlink(join(f.review, "auth.json"))).toBe(
    join(f.codex, "auth.json"),
  );
  const { stdout } = await f.step("review");
  expect(stdout).toBe(`${f.review}\n${f.dir}-review-state\n${workspace}\n`);
  expect(
    JSON.parse(await readFile(join(f.codex, "auth.json"), "utf8")),
  ).toEqual(chatgpt);
});

// Only macOS's `mv -h` replaces a link to a folder; containment is macOS-only.
it.runIf(process.platform === "darwin")(
  "never moves a review sign-in into a folder the shared sign-in links to",
  async () => {
    const f = await signingIn(chatgpt);
    const folder = join(f.home, "protected");
    await mkdir(folder);
    await mkdir(f.codex, { recursive: true });
    await symlink(folder, join(f.codex, "auth.json"));
    await f.step("login");
    expect(await readdir(folder)).toEqual([]);
    expect(
      JSON.parse(await readFile(join(f.own, "auth.json"), "utf8")),
    ).toEqual(chatgpt);
  },
);

it("records no workspace for an API key sign-in, so reviews refuse it", async () => {
  const f = await signingIn({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" });
  await f.step("review");
  await writeFile(join(f.review, "workspace"), "earlier\n");
  await expect(f.step("login")).resolves.toMatchObject({
    stderr: expect.stringContaining("it names no ChatGPT workspace"),
  });
  expect(await readdir(f.review)).not.toContain("workspace");
  expect((await f.step("review")).stdout.trim().split("\n")).toHaveLength(2);
});

it("prints no workspace once the shared sign-in names another, so reviews ask for a Buzz sign-in", async () => {
  const f = await signingIn(chatgpt);
  await f.step("login");
  // Hands the sign-in over.
  expect((await f.step("review")).stdout).toContain(workspace);
  for (const auth of [
    { ...chatgpt, tokens: { ...chatgpt.tokens, account_id: "other" } },
    { auth_mode: "apikey", OPENAI_API_KEY: "sk-test" },
  ]) {
    await writeFile(join(f.codex, "auth.json"), JSON.stringify(auth, null, 2));
    expect((await f.step("review")).stdout).toBe(
      `${f.review}\n${f.dir}-review-state\n`,
    );
  }
});

it("records no workspace when Codex saves no sign-in", async () => {
  const f = await echoing();
  await mkdir(f.codex);
  await writeFile(join(f.codex, "auth.json"), JSON.stringify(chatgpt, null, 2));
  await expect(f.step("login")).rejects.toMatchObject({
    stderr: expect.stringContaining("Codex did not save a sign-in"),
  });
  expect(await readdir(`${f.dir}-review-home`)).not.toContain("workspace");
});

it("keeps the shared sign-in when a sign-in is cancelled", async () => {
  const f = await echoing();
  await mkdir(f.codex);
  const auth = JSON.stringify(chatgpt, null, 2);
  await writeFile(join(f.codex, "auth.json"), auth);
  const review = `${f.dir}-review-home`;
  await f.step("review");
  // As Codex does, it revokes the sign-in it finds, then stops.
  await writeFile(
    join(f.dir, "0.1.0/bin/codex"),
    '#!/bin/sh\n[ ! -e "$CODEX_HOME/auth.json" ] || cp "$CODEX_HOME/auth.json" "$HOME/revoked"\nrm -f "$CODEX_HOME/auth.json"\nexit 1\n',
  );
  await expect(f.step("login")).rejects.toMatchObject({ code: 1 });
  expect(await readdir(f.home)).not.toContain("revoked");
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe(auth);
  await f.step("review");
  expect(await readlink(join(review, "auth.json"))).toBe(
    join(f.codex, "auth.json"),
  );
});

it("signs in to Buzz's home, as before, when Codex keeps sign-ins in the keyring", async () => {
  const f = await echoing();
  await mkdir(f.codex);
  await writeFile(
    join(f.codex, "config.toml"),
    'cli_auth_credentials_store = "keyring"\n',
  );
  const review = `${f.dir}-review-home`;
  await f.step("review");
  await writeFile(join(review, "workspace"), "earlier\n");
  const { stdout, stderr } = await f.step("login");
  expect(stdout.trim().split("\n")).toEqual([
    f.own,
    "-c",
    `sqlite_home=${f.own}`,
    "login",
  ]);
  expect(stderr).toContain("can't use a sign-in kept in the keyring");
  expect(await readdir(review)).not.toContain("workspace");
  expect(await readlink(join(review, "auth.json"))).toBe(
    join(f.codex, "auth.json"),
  );
});

it("makes a review wait for a sign-in in progress", async () => {
  const f = await signingIn(chatgpt, true);
  // Signing in again, so the sign-in that review sees names the workspace.
  await mkdir(f.codex);
  await writeFile(join(f.codex, "auth.json"), JSON.stringify(chatgpt, null, 2));
  // Watched from before login starts, so its `started` can't be missed.
  let started!: () => void;
  let failed!: (error: Error) => void;
  const signing = new Promise<void>((resolve, reject) => {
    started = resolve;
    failed = reject;
  });
  const watcher = watch(f.home, (_event, name) => {
    if (name === "started") started();
  });
  watcher.once("error", failed);
  const login = f.step("login");
  try {
    // Observe the sign-in actually holding the lock. How long codex.sh takes
    // to get there under load is not the behavior under test.
    await Promise.race([
      signing,
      login.then(() => {
        throw new Error("Login exited before it started signing in");
      }),
    ]);
    const review = f.step("review");
    await waiting(review);
    await writeFile(join(f.home, "go"), "");
    await login;
    expect((await review).stdout).toContain(workspace);
  } finally {
    watcher.close();
    // Fails once `afterEach` has removed a timed-out test's home.
    await writeFile(join(f.home, "go"), "").catch(() => {});
    await login.catch(() => {});
  }
});

/** Signs in as `codex login` does in Buzz's home: it signs out, removing the
 * link, and writes the new sign-in in its place. */
async function signIn(own: string, auth: string) {
  await rm(join(own, "auth.json"));
  await writeFile(join(own, "auth.json"), auth, { mode: 0o600 });
}

it("hands a sign-in made in Buzz's home to the shared one, and links it again", async () => {
  const f = await echoing();
  await mkdir(f.codex, { recursive: true });
  await writeFile(join(f.codex, "auth.json"), "revoked");
  await f.step("run");
  await signIn(f.own, "signed in");
  await f.step("run");
  expect(await readlink(join(f.own, "auth.json"))).toBe(
    join(f.codex, "auth.json"),
  );
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("signed in");
});

it("keeps a newer shared sign-in over the one in Buzz's home", async () => {
  const f = await echoing();
  await f.step("run");
  await signIn(f.own, "older");
  await utimes(join(f.own, "auth.json"), 1_000, 1_000);
  await writeFile(join(f.codex, "auth.json"), "signed in");
  await f.step("run");
  expect(await readlink(join(f.own, "auth.json"))).toBe(
    join(f.codex, "auth.json"),
  );
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("signed in");
});

it("replaces the user's own linked sign-in with a private file, as `codex login` does", async () => {
  const f = await echoing();
  await f.step("run");
  // The user keeps their sign-in elsewhere and links it into their Codex home.
  // Buzz can't tell that link from one a contained worker made.
  const kept = join(f.home, "dotfiles-auth.json");
  await writeFile(kept, "first", { mode: 0o600 });
  await symlink("../dotfiles-auth.json", join(f.codex, "auth.json"));
  await signIn(f.own, "second");
  await f.step("run");
  const auth = await lstat(join(f.codex, "auth.json"));
  expect(auth.isFile()).toBe(true);
  expect(auth.mode & 0o777).toBe(0o600);
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("second");
  expect(await readFile(kept, "utf8")).toBe("first");
});

it("never writes a handed-over sign-in through a link to a file", async () => {
  const f = await echoing();
  await f.step("run");
  // A contained worker can write both homes, but not this checker.
  const checker = join(f.home, "protected/engine.py");
  await mkdir(dirname(checker));
  await writeFile(checker, "checker");
  await utimes(checker, 1_000, 1_000);
  await symlink(checker, join(f.codex, "auth.json"));
  await signIn(f.own, "planted");
  await f.step("run");
  expect(await readFile(checker, "utf8")).toBe("checker");
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("planted");
});

// Only macOS's `mv -h` replaces a link to a folder; containment is macOS-only.
it.runIf(process.platform === "darwin")(
  "never moves a handed-over sign-in into a linked folder",
  async () => {
    const f = await echoing();
    await f.step("run");
    const folder = join(f.home, "protected");
    await mkdir(folder);
    await utimes(folder, 1_000, 1_000);
    await symlink(folder, join(f.codex, "auth.json"));
    await signIn(f.own, "planted");
    await f.step("run");
    expect(await readdir(folder)).toEqual([]);
    expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("planted");
  },
);

it("leaves the shared sign-in alone when another run hands it over while it waits", async () => {
  const f = await echoing();
  await f.step("run");
  await signIn(f.own, "signed in");
  const holder = await hold(`${f.dir}-home.lock`);
  let waiter: ReturnType<typeof f.step>;
  let handed: number;
  try {
    waiter = f.step("run");
    await waiting(waiter);
    // The run holding the lock hands the sign-in over and links it again.
    await writeFile(join(f.codex, "auth.json"), "signed in");
    await rm(join(f.own, "auth.json"));
    await symlink(join(f.codex, "auth.json"), join(f.own, "auth.json"));
    handed = (await stat(join(f.codex, "auth.json"))).ino;
  } finally {
    holder.kill("SIGKILL");
  }
  await waiter;
  // Replacing it again could undo a refresh Codex has written since.
  expect((await stat(join(f.codex, "auth.json"))).ino).toBe(handed);
});

it("leaves a sign-in Codex is still writing in Buzz's home", async () => {
  const f = await echoing();
  await mkdir(f.codex, { recursive: true });
  await writeFile(join(f.codex, "auth.json"), "signed in");
  await f.step("run");
  await signIn(f.own, "");
  await expect(f.step("run")).rejects.toMatchObject({
    stderr: expect.stringContaining("setup conflicts"),
  });
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("signed in");
  expect(await readFile(join(f.own, "auth.json"), "utf8")).toBe("");
});

it("keeps a sign-in it fails to hand over, and hands it over on the next run", async () => {
  const f = await echoing();
  await f.step("run");
  await writeFile(join(f.codex, "auth.json"), "revoked");
  await utimes(join(f.codex, "auth.json"), 500, 500);
  await signIn(f.own, "signed in");
  await utimes(join(f.own, "auth.json"), 1_000, 1_000);
  // An `mv` that fails to move the sign-in, as across volumes on a full disk.
  const bin = join(f.home, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "mv"),
    '#!/bin/sh\ncase "$*" in *-home/auth.json*) exit 1 ;; esac\nexec /bin/mv "$@"\n',
  );
  await chmod(join(bin, "mv"), 0o755);
  await expect(
    run("bash", ["-c", script, "codex.sh", "run"], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: f.home },
    }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("couldn't save the Codex sign-in"),
  });
  // Left as it was, so not newer than the sign-in still waiting in Buzz's home.
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("revoked");
  await f.step("run");
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("signed in");
  expect(await readlink(join(f.own, "auth.json"))).toBe(
    join(f.codex, "auth.json"),
  );
});

it("lets go of the hand-over lock before Codex starts", async () => {
  const f = await echoing();
  const started = join(f.home, "started");
  await writeFile(
    join(f.dir, "0.1.0/bin/codex"),
    `#!/bin/sh\n[ -e "${started}" ] && exit\n: >"${started}"\nexec sleep 60\n`,
  );
  await mkdir(f.own, { recursive: true });
  await writeFile(join(f.own, "auth.json"), "first", { mode: 0o600 });
  let observed!: () => void, failed!: (error: Error) => void;
  const boundary = new Promise<void>((resolve, reject) => {
    observed = resolve;
    failed = reject;
  });
  const watcher = watch(f.home, (_event, name) => {
    if (name === "started") observed();
  });
  watcher.once("error", failed);
  // An app server that stays up, as Buzz's does, must not hold up the next run.
  const first = f.step("run");
  try {
    await Promise.race([
      boundary,
      first.then(() => {
        throw new Error("Codex exited before its startup boundary");
      }),
    ]);
    await signIn(f.own, "second");
    await f.step("run");
    expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("second");
  } finally {
    watcher.close();
    first.child.kill();
    await first.catch(() => {});
  }
});

it("keeps Buzz's conversations when switching releases", async () => {
  const f = await echoing();
  await f.step("run");
  await mkdir(join(f.own, "sessions"));
  await writeFile(join(f.own, "sessions/rollout.jsonl"), "history");
  await f.step("use", "0.2.0");
  expect(await readFile(join(f.own, "sessions/rollout.jsonl"), "utf8")).toBe(
    "history",
  );
  expect(await readlink(join(f.own, "skills"))).toBe(join(f.codex, "skills"));
});

it("copies a saved thread from the user's home once, never over Buzz's copy", async () => {
  const { home, dir, step } = await disk([]);
  const day = "sessions/2026/10/14";
  const name = "rollout-2026-10-14T14-32-19-thread-1.jsonl";
  await mkdir(join(home, ".codex", day), { recursive: true });
  // The Codex app is mid-write: the last line has no end yet.
  await writeFile(join(home, ".codex", day, name), '{"a":1}\n{"b"');
  await step("adopt", "thread-1");
  const copy = join(`${dir}-home`, day, name);
  expect(await readFile(copy, "utf8")).toBe('{"a":1}\n{"b"\n');
  await writeFile(copy, "continued in Buzz\n");
  await step("adopt", "thread-1");
  expect(await readFile(copy, "utf8")).toBe("continued in Buzz\n");
  // Nothing to copy is not an error.
  await step("adopt", "thread-2");
  await expect(step("adopt", "../thread-1")).rejects.toThrow("Invalid thread");
  expect(await readdir(join(`${dir}-home`, day))).toEqual([name]);
});

/** A saved thread's path in both homes, and a checker a contained worker can't
 * read or write, though it can write both homes. */
async function adopting() {
  const f = await disk([]);
  const path = "sessions/2026/10/14/rollout-2026-10-14T14-32-19-thread-1.jsonl";
  const checker = join(f.home, "protected/engine.py");
  await mkdir(dirname(checker));
  await writeFile(checker, "checker\n");
  const rollout = join(f.home, ".codex", path);
  await mkdir(dirname(rollout), { recursive: true });
  return { ...f, checker, rollout, copy: join(`${f.dir}-home`, path) };
}

it("never copies a saved thread that is a link", async () => {
  const { checker, rollout, copy, step } = await adopting();
  await symlink(checker, rollout);
  await step("adopt", "thread-1");
  await expect(lstat(copy)).rejects.toThrow("ENOENT");
});

it("never copies a saved thread through a link planted in its way", async () => {
  const { home, checker, rollout, copy } = await adopting();
  await writeFile(rollout, "planted\n");
  await mkdir(dirname(copy), { recursive: true });
  // Planted at the copy's temporary name, which the launcher's pid predicts:
  // `exec` keeps the pid.
  await expect(
    run(
      "bash",
      [
        "-c",
        'ln -s "$1" "$2.$$" && exec bash -c "$3" codex.sh adopt thread-1',
        "plant",
        checker,
        copy,
        script,
      ],
      { env: { PATH: process.env.PATH ?? "", HOME: home } },
    ),
  ).rejects.toThrow("cannot overwrite existing file");
  expect(await readFile(checker, "utf8")).toBe("checker\n");
  expect((await stat(checker)).nlink).toBe(1);
  await expect(lstat(copy)).rejects.toThrow("ENOENT");
});

it("never hard-links a file a link swapped in for the copy points to", async () => {
  const { home, checker, rollout, copy } = await adopting();
  await writeFile(rollout, "planted\n");
  // A `tail` that swaps the new copy for a link first, as a worker could then.
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "tail"),
    `#!/bin/sh\nfor f; do :; done\ncase "$f" in *.jsonl.*) rm -f "$f"; ln -s "${checker}" "$f" ;; esac\nexec /usr/bin/tail "$@"\n`,
  );
  await chmod(join(bin, "tail"), 0o755);
  await run("bash", ["-c", script, "codex.sh", "adopt", "thread-1"], {
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home },
  });
  expect(await readFile(checker, "utf8")).toBe("checker\n");
  expect((await stat(checker)).nlink).toBe(1);
  expect((await lstat(copy)).isSymbolicLink()).toBe(true);
});
