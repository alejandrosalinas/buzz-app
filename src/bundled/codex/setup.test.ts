import { expect, it, vi } from "vitest";
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";
import script from "./codex.sh?raw";
import type { Wire } from "./rpc";
import {
  buzzHome,
  checkCodex,
  CodexSetup,
  explainTurn,
  reviewHome,
  withScript,
} from "./setup";
import manifest from "./manifest.json";

it("declares protected file reads through the bundled helper with a positional path", () => {
  expect(
    manifest.host.processes.find((process) => process.id === "read-protected"),
  ).toEqual({
    id: "read-protected",
    program: "buzz-agent-command",
    bundled: true,
    args: [
      "--shell",
      `case "$1" in "~/"*) set -- "$HOME/\${1:2}";; esac; exec /usr/bin/base64 -i "$1"`,
      "buzz-read",
    ],
  });
});

type Result = { stdout?: string; stderr?: string; code: number | null };

/** A process that prints `result` and exits with its code. */
function finished(result: Result, options: HostProcessOptions = {}) {
  queueMicrotask(() => {
    if (result.stdout) options.onStdout?.(result.stdout);
    if (result.stderr) options.onStderr?.(result.stderr);
  });
  return {
    write: async () => undefined,
    end: async () => undefined,
    kill: async () => undefined,
    exited: new Promise<number | null>((resolve) =>
      setTimeout(() => resolve(result.code), 0),
    ),
  };
}

type Account = { account: unknown; requiresOpenaiAuth: boolean };
const SIGNED_OUT: Account = { account: null, requiresOpenaiAuth: true };

/** An app server that lists `models` models, reads `account`, and exits once its input ends. */
function appServer(
  models: number,
  options: HostProcessOptions = {},
  account = SIGNED_OUT,
) {
  let exit!: (code: number | null) => void;
  const process: HostProcess & { ended?: boolean } = {
    write: async (text) => {
      const wire: Wire = JSON.parse(text);
      if (wire.id == null) return;
      const result =
        wire.method === "model/list"
          ? {
              data: Array.from({ length: models }, (_, i) => ({
                model: `m${i}`,
              })),
              nextCursor: null,
            }
          : wire.method === "account/read"
            ? account
            : {};
      options.onStdout?.(`${JSON.stringify({ id: wire.id, result })}\n`);
    },
    end: async () => {
      process.ended = true;
      exit(0);
    },
    kill: async () => exit(null),
    exited: new Promise((resolve) => {
      exit = resolve;
    }),
  };
  return process;
}

/** A spawn whose processes print `output[args]` and exit with its code, and
 * whose app server reads `account`. */
function scripted(output: Record<string, Partial<Result>>, account?: Account) {
  const calls: { id: string; args: readonly string[] }[] = [];
  const spawn = async (id: string, options: HostProcessOptions = {}) => {
    const args = options.args ?? [];
    calls.push({ id, args });
    if (id === "app-server") return appServer(0, options, account);
    const result = output[`${id} ${args.join(" ")}`.trim()];
    return finished({ code: 0, ...result }, options);
  };
  return { spawn, calls };
}

it("finds Codex missing when Buzz has no copy", async () => {
  const { spawn } = scripted({ "codex --version": { code: 127 } });
  await expect(checkCodex(spawn)).resolves.toEqual({ state: "missing" });
});

it("reports the version and whether it is signed in", async () => {
  const signedOut = scripted({
    "codex --version": { stdout: "codex-cli 0.162.1\n" },
    "codex login status": { stderr: "Not logged in\n", code: 1 },
  });
  await expect(checkCodex(signedOut.spawn)).resolves.toEqual({
    state: "signed-out",
    version: "0.162.1",
  });
  const ready = scripted({
    "codex --version": { stdout: "codex-cli 0.162.1\n" },
    "codex login status": { stdout: "Logged in using ChatGPT\n" },
  });
  await expect(checkCodex(ready.spawn)).resolves.toEqual({
    state: "ready",
    version: "0.162.1",
  });
  // Stored sign-in is enough; the app server is not asked.
  expect(ready.calls.map((call) => call.id)).toEqual(["codex", "codex"]);
});

it("is ready without an OpenAI sign-in when its model provider needs none", async () => {
  const signedOut = {
    "codex --version": { stdout: "codex-cli 0.163.0\n" },
    "codex login status": { stderr: "Not logged in\n", code: 1 },
  };
  const own = scripted(signedOut, { account: null, requiresOpenaiAuth: false });
  await expect(checkCodex(own.spawn)).resolves.toEqual({
    state: "ready",
    version: "0.163.0",
  });
  expect(own.calls.map((call) => call.id)).toEqual([
    "codex",
    "codex",
    "app-server",
  ]);
  const openai = scripted(signedOut, SIGNED_OUT);
  await expect(checkCodex(openai.spawn)).resolves.toEqual({
    state: "signed-out",
    version: "0.163.0",
  });
});

it("stops asking an app server that does not answer within the check's bound", async () => {
  const { spawn } = scripted({
    "codex --version": { stdout: "codex-cli 0.163.0\n" },
    "codex login status": { stderr: "Not logged in\n", code: 1 },
  });
  let ended = false;
  let started!: () => void;
  const starting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const silent = async (id: string, options: HostProcessOptions = {}) => {
    if (id !== "app-server") return spawn(id, options);
    // The check arms its bound right after starting the app server.
    vi.useFakeTimers();
    started();
    let exit!: (code: number | null) => void;
    return {
      write: async () => undefined,
      end: async () => {
        ended = true;
        exit(0);
      },
      kill: async () => exit(null),
      exited: new Promise<number | null>((resolve) => {
        exit = resolve;
      }),
    };
  };
  try {
    let status: unknown;
    void checkCodex(silent).then((result) => {
      status = result;
    });
    await starting;
    await vi.advanceTimersByTimeAsync(14_999);
    expect(status).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(status).toEqual({ state: "signed-out", version: "0.163.0" });
    expect(ended).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("runs sign-in, shows its output, and checks again after", async () => {
  const { spawn, calls } = scripted({
    login: { stdout: "Starting local login server…\n" },
    "codex --version": { stdout: "codex-cli 0.162.1\n" },
  });
  const setup = new CodexSetup(spawn);
  const run = setup.run("login");
  expect(setup.snapshot().running).toBe("login");
  await run;
  expect(setup.snapshot()).toMatchObject({
    running: undefined,
    output: "Starting local login server…\n",
    status: { state: "ready", version: "0.162.1" },
  });
  // Signing in through the review home, which records its workspace.
  expect(calls.map((call) => `${call.id} ${call.args.join(" ")}`)).toEqual([
    "login ",
    "codex --version",
    "codex login status",
  ]);
});

it("explains that it needs the desktop app", async () => {
  const setup = new CodexSetup(undefined);
  await setup.check();
  expect(setup.snapshot().status).toEqual({
    state: "error",
    message: "Codex agents run only in the desktop app",
  });
});

const CHECKSUM = "a".repeat(64);
const ASSET = "codex-package-aarch64-apple-darwin.tar.gz";

/** Buzz's copy on a fake disk, and releases.openai.com offering `latest`. */
function releases(
  latest: string,
  {
    current,
    broken,
    asset = ASSET,
  }: { current?: string; broken?: string; asset?: string } = {},
) {
  const state = {
    current,
    offline: false,
    fetched: [] as string[],
    used: [] as string[],
    servers: [] as (ReturnType<typeof appServer> & {
      version: string | undefined;
    })[],
  };
  const spawn = async (id: string, options: HostProcessOptions = {}) => {
    const args = options.args ?? [];
    const version = options.env?.BUZZ_CODEX_VERSION ?? state.current;
    if (id === "app-server") {
      const server = Object.assign(
        appServer(version === broken ? 0 : 1, options),
        { version },
      );
      state.servers.push(server);
      return server;
    }
    let result: Result = { code: 0 };
    if (id === "platform") result = { stdout: "Darwin arm64\n", code: 0 };
    else if (id === "install") {
      state.fetched.push(args.join(" "));
      if (state.offline) result = { code: 1 };
    } else if (id === "use") {
      state.current = args[0];
      state.used.push(args.join(" "));
    } else if (args[0] === "--version")
      result = version
        ? { stdout: `codex-cli ${version}\n`, code: 0 }
        : { code: 127 };
    return finished(result, options);
  };
  const requests: string[] = [];
  const request = async ({ url }: { url: string }) => {
    requests.push(url);
    const body =
      url === "https://releases.openai.com/codex/channels/latest"
        ? JSON.stringify({
            tag_name: `rust-v${latest}`,
            assets: [
              { name: asset, digest: `sha256:${CHECKSUM}` },
              { name: `${asset}.sigstore`, digest: `sha256:${"b".repeat(64)}` },
            ],
          })
        : undefined;
    return { status: body ? 200 : 404, headers: {}, body: body ?? "" };
  };
  return { spawn, request, requests, state };
}

it("installs the latest release once it passes its test", async () => {
  const { spawn, request, state } = releases("0.163.0");
  const setup = new CodexSetup(spawn, request);
  await setup.run("install");
  expect(state.fetched).toEqual([`0.163.0 aarch64-apple-darwin ${CHECKSUM}`]);
  // The test ran the new release, not the copy in use, and closed it.
  expect(state.servers).toHaveLength(1);
  expect(state.servers[0]?.version).toBe("0.163.0");
  expect(state.servers[0]?.ended).toBe(true);
  expect(state.used).toEqual(["0.163.0"]);
  expect(setup.snapshot()).toMatchObject({
    running: undefined,
    notice: undefined,
    status: { state: "ready", version: "0.163.0" },
  });
});

it("keeps the copy in use when a new release fails its test", async () => {
  const { spawn, request, state } = releases("0.163.0", {
    current: "0.162.1",
    broken: "0.163.0",
  });
  const setup = new CodexSetup(spawn, request);
  await setup.update(false);
  expect(state.fetched).toHaveLength(1);
  expect(state.used).toEqual([]);
  expect(setup.snapshot()).toMatchObject({
    notice:
      "Codex 0.163.0 failed its test: it did not list its models. Buzz keeps using 0.162.1.",
    status: { state: "ready", version: "0.162.1" },
  });
  // A refused release is not downloaded again, unless the person asks.
  await setup.update(false);
  expect(state.fetched).toHaveLength(1);
  await setup.run("install");
  expect(state.fetched).toHaveLength(2);
});

it("does nothing when the copy is already the latest", async () => {
  const { spawn, request, state } = releases("0.162.1", {
    current: "0.162.1",
  });
  await new CodexSetup(spawn, request).update(true);
  expect(state.fetched).toEqual([]);
});

it("refuses a release without a checksum for this computer", async () => {
  const { spawn, request, state } = releases("0.163.0", {
    asset: "codex-package-x86_64-apple-darwin.tar.gz",
  });
  const setup = new CodexSetup(spawn, request);
  await setup.run("install");
  expect(state.fetched).toEqual([]);
  expect(setup.snapshot().output).toContain(
    "Codex 0.163.0 lists no checksum for aarch64-apple-darwin",
  );
});

it("waits for a Codex agent before the first download", async () => {
  const { spawn, request, requests } = releases("0.163.0");
  const setup = new CodexSetup(spawn, request);
  await setup.update(false);
  expect(requests).toEqual([]);
  await setup.update(true);
  expect(requests).toHaveLength(1);
});

it("starts Codex, its app server and install steps as steps of codex.sh", async () => {
  const { spawn, calls } = scripted({});
  const run = withScript(spawn);
  await run("codex", { args: ["--version"] });
  await run("app-server");
  await run("use", { args: ["0.163.0"] });
  await run("login");
  await run("platform");
  expect(calls).toEqual([
    { id: "codex-sh", args: [script, "codex.sh", "run", "--version"] },
    { id: "codex-sh", args: [script, "codex.sh", "run", "app-server"] },
    { id: "codex-sh", args: [script, "codex.sh", "use", "0.163.0"] },
    { id: "codex-sh", args: [script, "codex.sh", "login"] },
    { id: "platform", args: [] },
  ]);
});

it("looks up Buzz's homes, and refuses a step that prints no home", async () => {
  const good = scripted({
    home: { stdout: "/buzz/codex-home\n" },
    review: { stdout: "/buzz/review-home\n/buzz/review-state\nworkspace-1\n" },
  });
  await expect(buzzHome(good.spawn)).resolves.toBe("/buzz/codex-home");
  await expect(reviewHome(good.spawn)).resolves.toEqual({
    home: "/buzz/review-home",
    state: "/buzz/review-state",
    workspace: "workspace-1",
  });
  const empty = scripted({ home: { stdout: "" }, review: { stdout: "/a\n" } });
  await expect(buzzHome(empty.spawn)).rejects.toThrow("home is unavailable");
  await expect(reviewHome(empty.spawn)).rejects.toThrow(
    "review is unavailable",
  );
});

/** `releases` whose first `id` process waits until `release` is called. */
function held(disk: ReturnType<typeof releases>, id: string) {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let first = true;
  const spawn = async (name: string, options?: HostProcessOptions) => {
    if (name === id && first) {
      first = false;
      started();
      await gate;
    }
    return disk.spawn(name, options);
  };
  return { spawn, waiting, release };
}

it("holds a delivery while it downloads the first copy", async () => {
  const disk = releases("0.163.0");
  const { spawn, waiting, release } = held(disk, "install");
  const setup = new CodexSetup(spawn, disk.request);
  const update = setup.update(true);
  await waiting;
  let delivered = false;
  const delivery = setup.installed(new AbortController().signal).then(() => {
    delivered = true;
  });
  // Settles only once the held download does, which nothing has released.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(delivered).toBe(false);
  release();
  await Promise.all([update, delivery]);
  expect(disk.state.used).toEqual(["0.163.0"]);
  expect(setup.snapshot().status).toMatchObject({ version: "0.163.0" });
});

it("stops holding a delivery when its deadline passes", async () => {
  const disk = releases("0.163.0");
  const { spawn, waiting, release } = held(disk, "install");
  const setup = new CodexSetup(spawn, disk.request);
  const update = setup.update(true);
  await waiting;
  const deadline = new AbortController();
  const delivery = setup.installed(deadline.signal);
  deadline.abort(new Error("timed out"));
  await expect(delivery).rejects.toThrow("timed out");
  release();
  await update;
});

it("does not hold deliveries while it updates a copy in use", async () => {
  const disk = releases("0.163.0", { current: "0.162.1" });
  const { spawn, waiting, release } = held(disk, "install");
  const setup = new CodexSetup(spawn, disk.request);
  const update = setup.update(false);
  await waiting;
  await setup.installed(new AbortController().signal);
  release();
  await update;
});

it("holds a delivery that arrives while it first looks for its copy", async () => {
  const disk = releases("0.163.0");
  const { spawn, waiting, release } = held(disk, "codex");
  const setup = new CodexSetup(spawn, disk.request);
  const update = setup.update(true);
  await waiting;
  let used: string[] | undefined;
  const delivery = setup.installed(new AbortController().signal).then(() => {
    used = [...disk.state.used];
  });
  release();
  await Promise.all([update, delivery]);
  // Released only once the first copy was in use.
  expect(used).toEqual(["0.163.0"]);
});

it("tries the first download again when a mention finds no copy", async () => {
  const disk = releases("0.163.0");
  const setup = new CodexSetup(disk.spawn, disk.request);
  disk.state.offline = true;
  await setup.update(true);
  expect(setup.snapshot().status).toEqual({ state: "missing" });
  disk.state.offline = false;
  await setup.installed(new AbortController().signal);
  expect(disk.state.fetched).toHaveLength(2);
  expect(disk.state.used).toEqual(["0.163.0"]);
});

const SETTINGS = "buzz://settings?section=agents&provider=buzz.codex%2Fcodex";
const NOT_SIGNED_IN = `Codex isn't signed in. Head to [Settings](${SETTINGS}) to sign in.`;

it("quotes Codex's words after the link, without the notice around them", () => {
  const words =
    "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";
  for (const notice of [
    `Codex could not finish: ${words}.`,
    `Codex could not start: ${words}.`,
  ])
    expect(explainTurn(notice, SETTINGS)).toBe(
      `${NOT_SIGNED_IN}\n\nCodex said:\n> ${words}`,
    );
  // A failed handover reports Codex's error as it is.
  expect(explainTurn(`Error: ${words}`, SETTINGS)).toBe(
    `${NOT_SIGNED_IN}\n\nCodex said:\n> Error: ${words}`,
  );
});

it("quotes at most 500 characters of Codex's words, marking the cut", () => {
  const words = `Missing bearer or basic authentication ${"x".repeat(600)}`;
  expect(explainTurn(`Codex could not finish: ${words}.`, SETTINGS)).toBe(
    `${NOT_SIGNED_IN}\n\nCodex said:\n> ${words.slice(0, 500)}…`,
  );
});

it("leaves a notice it can't explain exactly as Codex's runtime wrote it", () => {
  const notice = "Codex could not finish: model busy.";
  expect(explainTurn(notice, SETTINGS)).toBe(notice);
});
