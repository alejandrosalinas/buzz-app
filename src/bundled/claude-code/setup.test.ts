import { beforeEach, expect, it, vi } from "vitest";
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";
import type { Spawn } from "./claude";
import { fakeSpawn, MODELS, sessionState } from "./claude-testing";
import script from "./claude.sh?raw";
import manifest from "./manifest.json";
import { PROTECTED_CLAUDE_ROOT, PROTECTED_CLAUDE_VERSION } from "./security";
import { ClaudeAuth, type Step } from "./auth";
import { checkClaude, ClaudeSetup, MIN_VERSION, withScript } from "./setup";

/** Native's Claude key store (`claude_key.rs`): whether a key is saved. */
const nativeKey = vi.hoisted(() => ({ saved: true }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (command: string) =>
    command === "claude_api_key_status" ? nativeKey.saved : null,
}));
beforeEach(() => {
  nativeKey.saved = true;
});

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

const REVIEW_HOME =
  "/Users/me/Library/Application Support/Buzz/claude-code-review-home";
const KEY = "sk-ant-api03-saved";
/** `spawn` where `claude.sh review` prints the review folder, with a key
 * saved natively unless `saved` is false. */
function signedIn(spawn: Spawn, saved = true): Spawn {
  nativeKey.saved = saved;
  return async (id, options) => {
    if (id !== "review") return spawn(id, options);
    queueMicrotask(() => options?.onStdout?.(`${REVIEW_HOME}\n`));
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: Promise.resolve(0),
    };
  };
}
/** A review whose worker `fakeSpawn` holds, as `signedIn` signs it in. */
function reviewWorker() {
  const f = fakeSpawn();
  const spawn: Spawn = async (id, options) => {
    const child = await f.spawn(id, options);
    // The platform, and the pinned copy's install check.
    if (id === "platform" || options?.args?.[0] === "--version") return child;
    const fake = f.processes.at(-1);
    if (!fake) throw new Error("Expected review worker");
    fake.hold = true;
    return child;
  };
  const setup = new ClaudeSetup(signedIn(spawn), vi.fn());
  return { f, setup };
}

it.each([true, false])(
  "requires the native structured review result when present: %s",
  async (present) => {
    const { f, setup } = reviewWorker();
    const output = { blocked: false, reason: "Requested response delivery" };
    const prompt = {
      system: "Assess the evidence without executing it.",
      input: '{"kind":"tool","content":"Done."}',
      outputSchema: { type: "object", required: ["blocked", "reason"] },
    };
    const reviewing = setup.review(
      { id: "opus" },
      prompt,
      new AbortController().signal,
    );
    const checked = present
      ? expect(reviewing).resolves.toEqual({
          text: JSON.stringify(output),
          model: { id: "claude-opus-5-5" },
        })
      : expect(reviewing).rejects.toThrow(
          "The security model returned no structured result",
        );
    await vi.waitFor(() =>
      expect(f.processes.at(-1)?.prompts).toEqual([prompt.input]),
    );
    const fake = f.processes.at(-1);
    if (!fake) throw new Error("Expected review worker");
    expect(fake.id).toBe("claude-protected-arm64");
    expect(fake.options.protection?.readOnlyPaths).toContain(
      PROTECTED_CLAUDE_ROOT,
    );
    fake.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: present
        ? "```json\n" + JSON.stringify(output) + "\n```"
        : JSON.stringify(output),
      ...(present ? { structured_output: output } : {}),
    });
    sessionState(fake, "idle");
    await checked;
    expect(fake.options.args).toContain("--json-schema");
    expect(
      fake.options.args?.[fake.options.args.indexOf("--json-schema") + 1],
    ).toBe(JSON.stringify(prompt.outputSchema));
    expect(
      fake.options.args?.[fake.options.args.indexOf("--setting-sources") + 1],
    ).toBe("");
    expect(fake.killed).toBe(true);
  },
);

it("fails a review closed before any model without an API key", async () => {
  const spawned: string[] = [];
  const setup = new ClaudeSetup(
    signedIn(async (id) => {
      spawned.push(id);
      throw new Error(`${id} started`);
    }, false),
    vi.fn(),
  );
  await expect(
    setup.review(
      { id: "opus" },
      { system: "Assess.", input: "{}" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Claude needs an Anthropic API key.");
  expect(spawned).toEqual([]);
});

it("fails a review with the reader's own refusal, as off macOS", async () => {
  const spawned: string[] = [];
  const setup = new ClaudeSetup(async (id, options) => {
    spawned.push(id);
    if (id === "review")
      options?.onStderr?.("Claude security reviews need macOS\n");
    else throw new Error(`${id} started`);
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: Promise.resolve(2),
    };
  }, vi.fn());
  await expect(
    setup.review(
      { id: "opus" },
      { system: "Assess.", input: "{}" },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/^Claude security reviews need macOS$/);
  expect(spawned).toEqual(["review"]);
});

it("authenticates a review with its own folder and the key, over other credentials", async () => {
  const { f, setup } = reviewWorker();
  const reviewing = setup.review(
    { id: "opus" },
    { system: "Assess.", input: "{}" },
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(f.processes.at(-1)?.prompts).toEqual(["{}"]));
  const fake = f.processes.at(-1);
  if (!fake) throw new Error("Expected review worker");
  expect(fake.options.env).toMatchObject({
    CLAUDE_CONFIG_DIR: REVIEW_HOME,
    ANTHROPIC_AUTH_TOKEN: null,
    ANTHROPIC_BASE_URL: null,
    CLAUDE_CODE_API_BASE_URL: null,
    CLAUDE_CODE_SIMPLE: null,
    ANTHROPIC_UNIX_SOCKET: null,
    CLAUDE_CODE_REMOTE_SESSION_ID: null,
    CLAUDE_CODE_USE_BEDROCK: null,
    CLAUDE_CODE_USE_VERTEX: null,
    CLAUDE_CODE_USE_FOUNDRY: null,
    CLAUDE_CODE_USE_GATEWAY: null,
    CLAUDE_CODE_USE_MANTLE: null,
    CLAUDE_CODE_USE_ANTHROPIC_AWS: null,
    CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: null,
  });
  // Native code sets the key itself, over the environment.
  expect(fake.options.secrets).toEqual(["anthropic-api-key"]);
  expect(fake.options.env?.ANTHROPIC_API_KEY).toBeNull();
  expect(fake.options.cwd).toBe("~");
  expect(fake.options.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  expect(fake.options.args?.join(" ")).not.toContain(KEY);
  fake.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
  });
  sessionState(fake, "idle");
  await expect(reviewing).resolves.toMatchObject({ text: "ok" });
});

it.each([
  [
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    "Anthropic rejected the Claude API key.",
  ],
  [
    "Invalid API key · invalid x-api-key",
    "Anthropic rejected the Claude API key.",
  ],
  ["Overloaded", "Overloaded"],
])(
  "reports a review's key only when Anthropic refused it: %s",
  async (error, reported) => {
    const { f, setup } = reviewWorker();
    const reviewing = setup.review(
      { id: "opus" },
      { system: "Assess.", input: "{}" },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(f.processes.at(-1)?.prompts).toEqual(["{}"]));
    const fake = f.processes.at(-1);
    if (!fake) throw new Error("Expected review worker");
    fake.emit({
      type: "result",
      subtype: "success",
      is_error: true,
      result: error,
    });
    sessionState(fake, "idle");
    await expect(reviewing).rejects.toThrow(reported);
  },
);

/** A spawn whose processes print `output[args]` and exit with its code. */
function scripted(
  output: Record<string, { stdout?: string; code?: number } | Error>,
) {
  const calls: { id: string; args: readonly string[] }[] = [];
  const spawn = async (id: string, options: HostProcessOptions = {}) => {
    const args = options.args ?? [];
    calls.push({ id, args });
    const result = output[`${id} ${args.join(" ")}`.trim()];
    if (result instanceof Error) throw result;
    queueMicrotask(() => {
      if (result?.stdout) options.onStdout?.(result.stdout);
    });
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: new Promise<number | null>((resolve) =>
        setTimeout(() => resolve(result?.code ?? 0), 0),
      ),
    };
  };
  return { spawn, calls };
}

it("finds Claude missing when Buzz has no copy", async () => {
  const { spawn } = scripted({ "claude --version": { code: 127 } });
  await expect(checkClaude(spawn, new ClaudeAuth(spawn))).resolves.toEqual({
    state: "missing",
  });
  const setup = new ClaudeSetup(spawn);
  await setup.check();
  expect(setup.providerSnapshot()).toEqual({
    readiness: "attention",
    attentionLabel: "Install Claude integration",
  });
});

it("finds a copy older than Buzz needs outdated", async () => {
  const { spawn } = scripted({
    "claude --version": { stdout: "2.1.168 (Claude Code)\n" },
  });
  await expect(checkClaude(spawn, new ClaudeAuth(spawn))).resolves.toEqual({
    state: "outdated",
    version: "2.1.168",
  });
});

it("reports the version and whether an API key is saved", async () => {
  const signedOut = scripted({
    "claude --version": { stdout: "2.1.200 (Claude Code)\n" },
  });
  nativeKey.saved = false;
  await expect(
    checkClaude(signedOut.spawn, new ClaudeAuth(signedOut.spawn)),
  ).resolves.toEqual({ state: "signed-out", version: "2.1.200" });
  const signedOutSetup = new ClaudeSetup(signedOut.spawn);
  await signedOutSetup.check();
  expect(signedOutSetup.providerSnapshot()).toEqual({
    readiness: "attention",
    attentionLabel: "Add Claude API key",
  });
  nativeKey.saved = true;
  const ready = scripted({
    "claude --version": { stdout: "2.1.200 (Claude Code)\n" },
  });
  await expect(
    checkClaude(ready.spawn, new ClaudeAuth(ready.spawn)),
  ).resolves.toEqual({ state: "ready", version: "2.1.200" });
  const setup = new ClaudeSetup(ready.spawn);
  await setup.check();
  const refreshing = setup.check();
  expect(setup.providerSnapshot()).toEqual({ readiness: "ready" });
  await refreshing;
});

/** An authentication that signs in interactively, as a build may. */
class InteractiveAuth extends ClaudeAuth {
  override readonly signIn = (step: Step) =>
    step("claude", ["auth", "login"], "Sign-in");
  override async check() {
    return {};
  }
  override authorize(spawn: Spawn) {
    return spawn;
  }
}

it("runs an interactive sign-in, shows its output, and checks again after", async () => {
  const { spawn, calls } = scripted({
    "claude auth login": { stdout: "Opening browser…\n" },
    "claude --version": { stdout: "2.1.200\n" },
  });
  const setup = new ClaudeSetup(spawn, undefined, new InteractiveAuth(spawn));
  const run = setup.run("sign-in");
  expect(setup.snapshot().running).toBe("sign-in");
  await run;
  expect(setup.snapshot()).toMatchObject({
    running: undefined,
    output: "Opening browser…\n",
    status: { state: "ready", version: "2.1.200" },
  });
  expect(calls.map((call) => call.args.join(" "))).toEqual([
    "auth login",
    "--version",
  ]);
});

it("stops a step cancelled before its process was returned", async () => {
  const { spawn: check } = scripted({});
  let resolveSpawn!: (process: HostProcess) => void;
  let resolveExit!: (code: number | null) => void;
  const process: HostProcess & { killed?: boolean } = {
    write: async () => undefined,
    end: async () => undefined,
    kill: async () => {
      process.killed = true;
      resolveExit(null);
    },
    exited: new Promise((resolve) => {
      resolveExit = resolve;
    }),
  };
  const spawn: Spawn = (id, options) =>
    id === "claude" && options?.args?.[0] === "auth"
      ? new Promise((resolve) => {
          resolveSpawn = resolve;
        })
      : check(id, options);
  const setup = new ClaudeSetup(spawn, undefined, new InteractiveAuth(spawn));
  const run = setup.run("sign-in");
  expect(setup.snapshot().running).toBe("sign-in");
  await setup.cancel();
  resolveSpawn(process);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(process.killed).toBe(true);
  await run;
  expect(setup.snapshot()).toMatchObject({
    running: undefined,
    output: "\nSign-in ended (stopped).",
  });
});

it("explains that it needs the desktop app", async () => {
  const setup = new ClaudeSetup(undefined);
  await setup.check();
  expect(setup.snapshot().status).toEqual({
    state: "error",
    message: "Claude agents run only in the desktop app",
  });
  expect(setup.providerSnapshot()).toEqual({
    readiness: "attention",
    attentionLabel: "Claude Code needs attention",
  });
});

it("caches failed model discovery until retry and closes a late probe on disposal", async () => {
  const checks = scripted({
    "claude --version": { stdout: "2.1.200" },
  });
  let release!: (process: HostProcess) => void;
  const late = new Promise<HostProcess>((resolve) => {
    release = resolve;
  });
  const spawn = vi.fn<Spawn>(checks.spawn);
  const setup = new ClaudeSetup(spawn);
  await setup.check();
  spawn.mockRejectedValueOnce(new Error("probe failed"));
  await setup.loadModels();
  expect(setup.snapshot().modelsError).toBe("probe failed");
  await setup.loadModels();
  // The version and the failed probe.
  expect(spawn).toHaveBeenCalledTimes(2);
  spawn.mockImplementationOnce(() => late);
  const pending = setup.loadModels(true);
  expect(setup.snapshot().modelsChecking).toBe(true);
  setup.dispose();
  const kill = vi.fn(async () => undefined);
  release({
    write: async () => undefined,
    end: async () => undefined,
    kill,
    exited: Promise.resolve(null),
  });
  await pending;
  expect(kill).toHaveBeenCalled();
  expect(setup.snapshot().models).toEqual([]);
});

/** Health checks answer from a script; `claude` sessions answer like Claude. */
function discoverable() {
  const checks = scripted({
    "claude --version": { stdout: "2.1.200" },
  });
  const claude = fakeSpawn();
  const spawn = vi.fn<Spawn>(async (id, options) =>
    options?.args?.[0] === "--version"
      ? checks.spawn(id, options)
      : claude.spawn(id, options),
  );
  return { spawn, sessions: claude.processes };
}

it("offers the model catalog without the picker, discovering it once for concurrent callers", async () => {
  const { spawn, sessions } = discoverable();
  const setup = new ClaudeSetup(spawn);
  // Nothing has checked Claude or opened the picker yet.
  expect(setup.snapshot().models).toEqual([]);
  const [first, second] = await Promise.all([setup.catalog(), setup.catalog()]);
  expect(first.map((model) => model.value)).toEqual(
    MODELS.map((model) => model.value),
  );
  expect(second).toBe(first);
  expect(sessions).toHaveLength(1);
  await setup.catalog();
  expect(sessions).toHaveLength(1);
});

it("looks for the catalog again after a discovery that listed nothing", async () => {
  const { spawn, sessions } = discoverable();
  const setup = new ClaudeSetup(spawn);
  await setup.check();
  spawn.mockRejectedValueOnce(new Error("probe failed"));
  await expect(setup.catalog()).resolves.toEqual([]);
  expect(setup.snapshot().modelsError).toBe("probe failed");
  expect(await setup.catalog()).not.toEqual([]);
  expect(sessions).toHaveLength(1);
});

it("bounds a stalled discovery and releases it for an explicit retry", async () => {
  const checks = scripted({
    "claude --version": { stdout: "2.1.200" },
  });
  let exit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    exit = resolve;
  });
  const kill = vi.fn(async () => {
    exit(null);
  });
  const spawn = vi.fn<Spawn>(checks.spawn);
  const setup = new ClaudeSetup(spawn);
  await setup.check();
  spawn.mockResolvedValueOnce({
    write: async () => undefined,
    end: async () => undefined,
    kill,
    exited,
  });
  vi.useFakeTimers();
  try {
    const pending = setup.loadModels();
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(kill).toHaveBeenCalled();
    expect(setup.snapshot().modelsChecking).toBe(false);
    expect(setup.snapshot().modelsError).toBe(
      "Claude Code model discovery timed out",
    );
    spawn.mockRejectedValueOnce(new Error("retry reached the process"));
    await setup.loadModels(true);
    expect(setup.snapshot().modelsError).toBe("retry reached the process");
  } finally {
    setup.dispose();
    vi.useRealTimers();
  }
});

const CHECKSUM = "a".repeat(64);

/** Buzz's copy on a fake disk, and downloads.claude.ai offering `latest`. */
function releases(
  latest: string,
  { current, broken }: { current?: string; broken?: string } = {},
) {
  const state = {
    current,
    offline: false,
    fetched: [] as string[],
    used: [] as string[],
  };
  const claude = fakeSpawn();
  const spawn = async (id: string, options: HostProcessOptions = {}) => {
    const args = options.args ?? [];
    if (id === "claude" && args.includes("stream-json"))
      return claude.spawn(id, options);
    const version = options.env?.BUZZ_CLAUDE_VERSION ?? state.current;
    let result: { stdout?: string; stderr?: string; code: number } = {
      code: 0,
    };
    if (id === "platform") result = { stdout: "Darwin arm64\n", code: 0 };
    else if (id === "install") {
      state.fetched.push(args.join(" "));
      if (state.offline) result = { code: 1 };
    } else if (id === "use") state.current = args[0];
    else if (args[0] === "--version")
      result = !version
        ? { code: 127 }
        : version === broken
          ? { stderr: "Killed: 9", code: 137 }
          : { stdout: `${version} (Claude Code)\n`, code: 0 };
    if (id === "use") state.used.push(args.join(" "));
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
  };
  const requests: string[] = [];
  const request = async ({ url }: { url: string }) => {
    requests.push(url);
    const path = url.replace(
      "https://downloads.claude.ai/claude-code-releases/",
      "",
    );
    const body =
      path === "latest"
        ? `${latest}\n`
        : path === `${latest}/manifest.json`
          ? JSON.stringify({
              platforms: { "darwin-arm64": { checksum: CHECKSUM } },
            })
          : undefined;
    return { status: body ? 200 : 404, headers: {}, body: body ?? "" };
  };
  return { spawn, request, requests, state, claude };
}

it("installs the latest release once it passes its test", async () => {
  const { spawn, request, state, claude } = releases("2.1.300");
  const setup = new ClaudeSetup(spawn, request);
  await setup.run("install");
  expect(state.fetched).toEqual([`2.1.300 darwin-arm64 ${CHECKSUM}`]);
  // The test ran the new release, not the copy in use.
  expect(claude.processes[0]?.options.env?.BUZZ_CLAUDE_VERSION).toBe("2.1.300");
  expect(claude.processes[0]?.killed).toBe(true);
  expect(state.used).toEqual(["2.1.300"]);
  expect(setup.snapshot()).toMatchObject({
    running: undefined,
    notice: undefined,
    status: { state: "ready", version: "2.1.300" },
  });
});

it("keeps the copy in use when a new release fails its test", async () => {
  const { spawn, request, state } = releases("2.1.300", {
    current: "2.1.200",
    broken: "2.1.300",
  });
  const setup = new ClaudeSetup(spawn, request);
  await setup.update(false);
  expect(state.fetched).toHaveLength(1);
  expect(state.used).toEqual([]);
  expect(setup.snapshot()).toMatchObject({
    notice:
      "Claude 2.1.300 failed its test: Killed: 9. Buzz keeps using 2.1.200.",
    status: { state: "ready", version: "2.1.200" },
  });
  // A refused release is not downloaded again, unless the person asks.
  await setup.update(false);
  expect(state.fetched).toHaveLength(1);
  await setup.run("install");
  expect(state.fetched).toHaveLength(2);
});

it("does nothing when the copy is already the latest", async () => {
  const { spawn, request, state } = releases("2.1.300", { current: "2.1.300" });
  await new ClaudeSetup(spawn, request).update(true);
  expect(state.fetched).toEqual([]);
});

it("refuses a release older than Buzz needs", async () => {
  const { spawn, request, state } = releases("2.1.100");
  const setup = new ClaudeSetup(spawn, request);
  await setup.run("install");
  expect(state.fetched).toEqual([]);
  expect(setup.snapshot().output).toContain(
    `Claude 2.1.100 is older than Buzz needs (${MIN_VERSION}).`,
  );
});

it("waits for a Claude agent before the first download", async () => {
  const { spawn, request, requests } = releases("2.1.300");
  const setup = new ClaudeSetup(spawn, request);
  await setup.update(false);
  expect(requests).toEqual([]);
  await setup.update(true);
  expect(requests).toHaveLength(2);
});

it("starts Claude and its install steps as steps of claude.sh", async () => {
  const { spawn, calls } = scripted({});
  const run = withScript(spawn);
  await run("claude", { args: ["--version"] });
  await run("use", { args: ["2.1.300"] });
  await run("platform");
  await run("claude-protected-arm64", { args: ["--version"] });
  expect(calls).toEqual([
    { id: "claude-sh", args: [script, "claude.sh", "run", "--version"] },
    { id: "claude-sh", args: [script, "claude.sh", "use", "2.1.300"] },
    { id: "platform", args: [] },
    { id: "claude-protected-arm64", args: ["--version"] },
  ]);
});

/** A Mac on which the host starts the pinned protected copy once
 * `installed`, and whose install step installs it unless `broken`, or
 * exits 1 when `failed`. */
function pinnedRelease(state: {
  installed: boolean;
  broken?: boolean;
  failed?: boolean;
}) {
  const calls: string[] = [];
  const pinned: { protection?: unknown; killed: boolean }[] = [];
  const spawn = async (id: string, options: HostProcessOptions = {}) => {
    const args = options.args ?? [];
    calls.push(`${id} ${args.join(" ")}`.trim());
    if (id === "platform") options.onStdout?.("Darwin arm64\n");
    if (id === "install") state.installed = !state.broken && !state.failed;
    const protectedCopy = id === "claude-protected-arm64";
    const started = { protection: options.protection, killed: false };
    if (protectedCopy) pinned.push(started);
    if (protectedCopy && !state.installed)
      throw new Error("Artifact is unreadable");
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => {
        started.killed = true;
      },
      // The hook guard kills a protected copy that prints `--version`.
      exited: Promise.resolve(
        protectedCopy ? null : id === "install" && state.failed ? 1 : 0,
      ),
    };
  };
  const request = async () => ({
    status: 200,
    headers: {},
    body: JSON.stringify({
      platforms: { "darwin-arm64": { checksum: CHECKSUM } },
    }),
  });
  return { spawn, request, calls, pinned };
}

it("installs the pinned protected release only when the host refuses its copy", async () => {
  const signal = new AbortController().signal;
  const present = pinnedRelease({ installed: true });
  await new ClaudeSetup(present.spawn, present.request).protectedInstalled(
    signal,
  );
  expect(present.calls).toEqual([
    "platform",
    "claude-protected-arm64 --version",
  ]);
  const missing = pinnedRelease({ installed: false });
  await new ClaudeSetup(missing.spawn, missing.request).protectedInstalled(
    signal,
  );
  expect(missing.calls).toEqual([
    "platform",
    "claude-protected-arm64 --version",
    "platform",
    `install ${PROTECTED_CLAUDE_VERSION} darwin-arm64 ${CHECKSUM}`,
    "claude-protected-arm64 --version",
  ]);
});

it("checks the pinned copy contained, never the download folder's file", async () => {
  const { spawn, request, pinned } = pinnedRelease({ installed: false });
  await new ClaudeSetup(spawn, request).protectedInstalled(
    new AbortController().signal,
  );
  const protection = {
    readOnlyPaths: [PROTECTED_CLAUDE_ROOT],
    hiddenPaths: [],
  };
  // The preflight the host refused, then the check after the install.
  expect(pinned).toEqual([
    { protection, killed: false },
    { protection, killed: true },
  ]);
});

it("fails a protected install whose copy the host still refuses", async () => {
  const { spawn, request } = pinnedRelease({ installed: false, broken: true });
  await expect(
    new ClaudeSetup(spawn, request).protectedInstalled(
      new AbortController().signal,
    ),
  ).rejects.toThrow("Artifact is unreadable");
});

it("reports a failed install step without checking the pinned copy again", async () => {
  const { spawn, request, calls } = pinnedRelease({
    installed: false,
    failed: true,
  });
  await expect(
    new ClaudeSetup(spawn, request).protectedInstalled(
      new AbortController().signal,
    ),
  ).rejects.toThrow("The protected Claude runtime could not be installed");
  expect(calls).toEqual([
    "platform",
    "claude-protected-arm64 --version",
    "platform",
    `install ${PROTECTED_CLAUDE_VERSION} darwin-arm64 ${CHECKSUM}`,
  ]);
});

it("ends a wait cancelled during the pinned copy's preflight", async () => {
  const disk = pinnedRelease({ installed: true });
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const checking = new Promise<void>((resolve) => {
    started = resolve;
  });
  const spawn = async (id: string, options?: HostProcessOptions) => {
    if (id === "claude-protected-arm64") {
      started();
      await gate;
    }
    return disk.spawn(id, options);
  };
  try {
    const caller = new AbortController();
    const cancelled = new ClaudeSetup(spawn, disk.request).protectedInstalled(
      caller.signal,
    );
    await checking;
    const reason = new Error("cancelled");
    caller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
  } finally {
    release();
  }
});

it("installs the pinned release before a review that needs it", async () => {
  const { spawn, request, calls } = pinnedRelease({
    installed: false,
    broken: true,
  });
  await expect(
    new ClaudeSetup(signedIn(spawn), request).review(
      { id: "opus" },
      { system: "Assess.", input: "{}" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Artifact is unreadable");
  expect(calls).toContain(
    `install ${PROTECTED_CLAUDE_VERSION} darwin-arm64 ${CHECKSUM}`,
  );
  expect(calls.filter((call) => call.includes("stream-json"))).toEqual([]);
});

/** `pinnedRelease`'s manifest, answered only once `release` is called. */
function heldManifest(disk: ReturnType<typeof pinnedRelease>) {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetching = new Promise<void>((resolve) => {
    started = resolve;
  });
  let fetches = 0;
  const request = async () => {
    fetches++;
    started();
    await gate;
    return disk.request();
  };
  return { request, fetching, release, fetches: () => fetches };
}

it("ends a cancelled wait for the pinned copy while its download continues", async () => {
  const disk = pinnedRelease({ installed: false });
  const manifest = heldManifest(disk);
  const setup = new ClaudeSetup(disk.spawn, manifest.request);
  try {
    const first = new AbortController();
    const cancelled = setup.protectedInstalled(first.signal);
    await manifest.fetching;
    first.abort(new Error("cancelled"));
    await expect(cancelled).rejects.toThrow("cancelled");
    const joined = setup.protectedInstalled(new AbortController().signal);
    // Its preflight is refused too, while the download is still held.
    await vi.waitFor(() =>
      expect(
        disk.calls.filter(
          (call) => call === "claude-protected-arm64 --version",
        ),
      ).toHaveLength(2),
    );
    manifest.release();
    await joined;
  } finally {
    manifest.release();
  }
  expect(manifest.fetches()).toBe(1);
  expect(disk.calls.filter((call) => call.startsWith("install "))).toHaveLength(
    1,
  );
});

it("counts the protected install wait in a review's 60 s budget", async () => {
  const disk = pinnedRelease({ installed: false });
  const manifest = heldManifest(disk);
  const deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(deadline.signal);
  const setup = new ClaudeSetup(signedIn(disk.spawn), manifest.request);
  try {
    const reviewing = setup.review(
      { id: "opus" },
      { system: "Assess.", input: "{}" },
      new AbortController().signal,
    );
    await manifest.fetching;
    expect(timeout).toHaveBeenCalledWith(60_000);
    deadline.abort(new Error("timed out"));
    await expect(reviewing).rejects.toThrow("timed out");
  } finally {
    timeout.mockRestore();
    manifest.release();
  }
  // The download carries on, through its check of the installed copy.
  await vi.waitFor(() => expect(disk.pinned.at(-1)?.killed).toBe(true));
  expect(disk.calls).toContain(
    `install ${PROTECTED_CLAUDE_VERSION} darwin-arm64 ${CHECKSUM}`,
  );
});

it("pins the protected release where claude.sh installs it", () => {
  const path = `${PROTECTED_CLAUDE_ROOT}/${PROTECTED_CLAUDE_VERSION}/claude`;
  const artifact = { path, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) };
  expect(
    manifest.host.processes.filter((process) =>
      process.id.startsWith("claude-protected-"),
    ),
  ).toEqual([
    { id: "claude-protected-arm64", program: "claude", artifact },
    { id: "claude-protected-x64", program: "claude", artifact },
  ]);
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
  const disk = releases("2.1.300");
  const { spawn, waiting, release } = held(disk, "install");
  const setup = new ClaudeSetup(spawn, disk.request);
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
  expect(disk.state.used).toEqual(["2.1.300"]);
  expect(setup.snapshot().status).toMatchObject({ version: "2.1.300" });
});

it("stops holding a delivery when its deadline passes", async () => {
  const disk = releases("2.1.300");
  const { spawn, waiting, release } = held(disk, "install");
  const setup = new ClaudeSetup(spawn, disk.request);
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
  const disk = releases("2.1.300", { current: "2.1.200" });
  const { spawn, waiting, release } = held(disk, "install");
  const setup = new ClaudeSetup(spawn, disk.request);
  const update = setup.update(false);
  await waiting;
  await setup.installed(new AbortController().signal);
  release();
  await update;
});

it("holds a delivery that arrives while it first looks for its copy", async () => {
  const disk = releases("2.1.300");
  const { spawn, waiting, release } = held(disk, "claude");
  const setup = new ClaudeSetup(spawn, disk.request);
  const update = setup.update(true);
  await waiting;
  let used: string[] | undefined;
  const delivery = setup.installed(new AbortController().signal).then(() => {
    used = [...disk.state.used];
  });
  release();
  await Promise.all([update, delivery]);
  // Released only once the first copy was in use.
  expect(used).toEqual(["2.1.300"]);
});

it("tries the first download again when a mention finds no copy", async () => {
  const disk = releases("2.1.300");
  const setup = new ClaudeSetup(disk.spawn, disk.request);
  disk.state.offline = true;
  await setup.update(true);
  expect(setup.snapshot().status).toEqual({ state: "missing" });
  disk.state.offline = false;
  await setup.installed(new AbortController().signal);
  expect(disk.state.fetched).toHaveLength(2);
  expect(disk.state.used).toEqual(["2.1.300"]);
});
