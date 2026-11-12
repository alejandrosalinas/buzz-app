import { expect, it, vi } from "vitest";
import { AGENT_KEY } from "../../features/agents/membership";
import hostSource from "./host.mjs?raw";
import manifest from "./manifest.json";
import type { AgentProtection } from "../../features/agent-protection/service";
import { Pi, PiStopped } from "./pi";
import { deferred, fakeHost, type FakeProcess } from "./pi-testing";

const handlers = () => ({ tool: vi.fn(), event: vi.fn() });
const evidence = (worker: FakeProcess, operation: string, params: object) =>
  worker.tool(params, `buzz/security/evidence/${operation}`);
/** Sends one action over the evidence protocol, as host.mjs does. */
async function review(worker: FakeProcess, action: Record<string, unknown>) {
  const { content, ...metadata } = action;
  const id = crypto.randomUUID();
  const data = Buffer.from(JSON.stringify(content));
  await evidence(worker, "begin", { id, ...metadata });
  await evidence(worker, "chunk", {
    id,
    sequence: 0,
    data: data.toString("base64"),
  });
  return evidence(worker, "finish", { id, sequence: 1, bytes: data.length });
}

it("declares file reads through the bundled helper with a positional path", () => {
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

it("starts the host once, with the install script, and pairs each answer with its request", async () => {
  const slow = deferred<object>();
  const host = fakeHost({
    first: () => slow.promise,
    second: (params) => ({ echo: params.value }),
  });
  const pi = new Pi(() => host.spawn, handlers());
  const first = pi.request("first");
  const second = pi.request("second", { value: 2 });
  await expect(second).resolves.toEqual({ echo: 2 });
  slow.resolve({ done: 1 });
  await expect(first).resolves.toEqual({ done: 1 });
  expect(host.processes).toHaveLength(1);
  const [process] = host.processes;
  expect(process?.id).toBe("pi-sh");
  expect(process?.options.cwd).toBe("~");
  expect(process?.options.args?.[1]).toBe("pi.sh");
  expect(process?.options.args?.at(-1)).toContain("BUZZ_PI_HOST");
  // The packages it installs are the ones the lock pins.
  expect(process?.launched?.lock).toContain('"lockfileVersion"');
  expect(process?.launched?.host).toContain("export function serve");
});

it("starts Node itself on Windows, which has no bash", async () => {
  vi.stubGlobal("navigator", { platform: "Win32" });
  try {
    const host = fakeHost({ first: () => ({ ok: true }) });
    const pi = new Pi(() => host.spawn, handlers());
    await expect(pi.request("first")).resolves.toEqual({ ok: true });
    const [process] = host.processes;
    expect(process?.id).toBe("node");
    expect(process?.options.args).toHaveLength(1);
    expect(process?.options.args?.[0]).toContain("BUZZ_PI_HOST");
    expect(process?.launched?.lock).toContain('"lockfileVersion"');
  } finally {
    vi.unstubAllGlobals();
  }
});

it("reads messages split across chunks, and several in one", async () => {
  // Its answer comes from the test, in pieces.
  const host = fakeHost(
    { first: () => new Promise(() => {}) },
    { ready: false },
  );
  const events = handlers();
  const pi = new Pi(() => host.spawn, events);
  const started = pi.request("first");
  await vi.waitFor(() => expect(host.processes).toHaveLength(1));
  const stdout = host.processes[0]?.options.onStdout;
  stdout?.('{"method":"rea');
  stdout?.(
    'dy","params":{}}\n{"method":"event","params":{"agent":"a","conversation":1,"type":"step","tool":"bash"}}\n',
  );
  await vi.waitFor(() => expect(host.requests("first")).toHaveLength(1));
  stdout?.('{"id":1,"result":{"ok":true}}');
  stdout?.("\n");
  await expect(started).resolves.toEqual({ ok: true });
  expect(events.event).toHaveBeenCalledWith({
    agent: "a",
    conversation: 1,
    type: "step",
    tool: "bash",
  });
});

it("says why a host could not start, and starts another for the next request", async () => {
  const host = fakeHost({ ping: () => ({ pong: true }) }, { ready: false });
  const pi = new Pi(() => host.spawn, handlers());
  const failed = pi.request("ping");
  await vi.waitFor(() => expect(host.processes).toHaveLength(1));
  host.processes[0]?.exit(
    127,
    "Installing…\nPi needs Node.js 22.19 or later. Install it from nodejs.org or with Homebrew, then try again.\n",
  );
  const error = await failed.catch((reason: unknown) => reason);
  expect(error).not.toBeInstanceOf(PiStopped);
  expect((error as Error).message).toBe(
    "Pi needs Node.js 22.19 or later. Install it from nodejs.org or with Homebrew, then try again.",
  );
  const retried = pi.request("ping");
  await vi.waitFor(() => expect(host.processes).toHaveLength(2));
  host.processes[1]?.send({ method: "ready", params: {} });
  await expect(retried).resolves.toEqual({ pong: true });
});

it("fails what a running host had not answered when it stops", async () => {
  const host = fakeHost({ wait: () => new Promise(() => {}) });
  const pi = new Pi(() => host.spawn, handlers());
  const waiting = pi.request("wait");
  await vi.waitFor(() => expect(host.requests("wait")).toHaveLength(1));
  host.processes[0]?.exit(1, "FATAL: out of memory\n");
  const error = await waiting.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(PiStopped);
  expect((error as Error).message).toBe("Pi stopped: FATAL: out of memory");
});

it("names Node's error, not its version, when a host crashes", async () => {
  const host = fakeHost({ wait: () => new Promise(() => {}) });
  const pi = new Pi(() => host.spawn, handlers());
  const waiting = pi.request("wait");
  await vi.waitFor(() => expect(host.requests("wait")).toHaveLength(1));
  host.processes[0]?.exit(
    1,
    "file:///host.mjs:9\n  throw new Error(x);\n  ^\n\nTypeError: x is not a function\n    at file:///host.mjs:9:3\n\nNode.js v22.19.0\n",
  );
  const error = await waiting.catch((reason: unknown) => reason);
  expect((error as Error).message).toBe(
    "Pi stopped: TypeError: x is not a function",
  );
});

it("runs the tools the host calls, and sends back each result or error", async () => {
  const host = fakeHost();
  const tool = vi
    .fn()
    .mockResolvedValueOnce({ content: [{ type: "text", text: "sent" }] })
    .mockRejectedValueOnce(new Error("No such channel"));
  const pi = new Pi(() => host.spawn, { tool, event: vi.fn() });
  await pi.request("open");
  const process = host.processes[0];
  const call = {
    agent: "a",
    conversation: 3,
    context: { channel: "c" },
    name: "send",
    arguments: { text: "hi" },
  };
  await expect(process?.tool(call)).resolves.toMatchObject({
    result: { content: [{ type: "text", text: "sent" }] },
  });
  expect(tool).toHaveBeenCalledWith(call, expect.any(AbortSignal));
  await expect(process?.tool(call)).resolves.toMatchObject({
    error: "No such channel",
  });
});

it("cancels a Buzz tool when its run stops or the host goes", async () => {
  const host = fakeHost();
  const signals: AbortSignal[] = [];
  const tool = vi.fn(
    (_call: unknown, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const pi = new Pi(() => host.spawn, { tool, event: vi.fn() });
  await pi.request("open");
  const process = host.processes[0];
  const call = {
    agent: "a",
    conversation: 3,
    context: {},
    name: "send",
    arguments: { text: "hi" },
  };
  const stopped = process?.tool(call);
  void process?.tool(call);
  await vi.waitFor(() => expect(signals).toHaveLength(2));
  process?.send({ method: "security_cancel", params: { id: "h1" } });
  await expect(stopped).resolves.toHaveProperty("error");
  expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
  process?.exit(1);
  await vi.waitFor(() => expect(signals[1]?.aborted).toBe(true));
});

it("closes the host's stdin to stop it, and refuses requests after", async () => {
  const host = fakeHost();
  const pi = new Pi(() => host.spawn, handlers());
  await pi.request("open");
  const process = host.processes[0];
  const disposed = pi.dispose();
  await vi.waitFor(() => expect(process?.ended).toBe(true));
  process?.exit(0);
  await disposed;
  expect(process?.killed).toBe(false);
  await expect(pi.request("open")).rejects.toThrow("Pi has stopped");
});

it("accepts in the host the membership keys the app names agents with", () => {
  // host.mjs cannot import the app's pattern, so it keeps a copy that names
  // the agent's storage file: it must stay the same, and path-safe.
  const copy = /^const AGENT_KEY = (\/.*\/);$/m.exec(hostSource)?.[1];
  expect(copy).toBe(`/${AGENT_KEY.source}/`);
});

it.each(["dispose", "exit", "retire", "policy"])(
  "retires completed protection checks with their Pi connection (%s)",
  async (retirement) => {
    const agent = "a".repeat(64);
    const checkEvidence = vi.fn<AgentProtection["checkEvidence"]>(
      async (_action, source) => {
        for await (const _part of source.read()) {
          /* consume */
        }
      },
    );
    let gate: AgentProtection = {
      key: "a:1",
      stateKey: "a:1",
      checkEvidence,
      check: async () => {
        throw new Error("Unexpected object check in this fixture");
      },
      assertAvailable() {},
      processProtection: { readOnlyPaths: [], hiddenPaths: [] },
      spawn: async () => {
        throw new Error("Unused protected runtime");
      },
    };
    const host = fakeHost(
      {
        runtime: () => ({
          file: "/runtime/deps/host.mjs",
          node: "/runtime/node/bin/node",
          codeRoot: "/runtime/deps",
          nodeRoot: "/runtime/node",
          data: "/runtime/state",
          auth: "/runtime/auth",
        }),
      },
      { close: true },
    );
    const pi = new Pi(
      () => host.spawn,
      handlers(),
      () => gate,
    );
    const action = {
      kind: "context",
      session: "native-session",
      content: "reviewed input",
    };
    try {
      await pi.request("open", { agent });
      const worker = host.processes.find(
        (process) => process.options.protection,
      );
      if (!worker) throw new Error("Missing protected worker");
      await expect(review(worker, action)).resolves.toMatchObject({
        result: { allowed: true },
      });
      const signal = checkEvidence.mock.calls[0]?.[2];
      expect(signal?.aborted).toBe(false);
      if (retirement === "dispose") await pi.dispose();
      else {
        if (retirement === "exit") worker.exit(1);
        else if (retirement === "retire") await pi.retire(agent);
        else gate = { ...gate, key: "a:2", stateKey: "a:2" };
        if (retirement === "exit")
          await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        await pi.request("open", { agent });
        const next = host.processes
          .filter((process) => process.options.protection)
          .at(-1);
        expect(next).not.toBe(worker);
        if (!next) throw new Error("Missing replacement worker");
        await expect(review(next, action)).resolves.toMatchObject({
          result: { allowed: true },
        });
        expect(checkEvidence.mock.calls[1]?.[2].aborted).toBe(false);
      }
      expect(signal?.aborted).toBe(true);
    } finally {
      await pi.dispose();
    }
  },
);

it("isolates protected agents, contains their runtime code and cancels a native check", async () => {
  const entered = deferred();
  let waiting: AbortSignal | undefined;
  const gates = new Map<string, AgentProtection>();
  const make = (key: string): AgentProtection => ({
    key,
    stateKey: key,
    assertAvailable: vi.fn(),
    processProtection: {
      readOnlyPaths: ["/security/provider"],
      hiddenPaths: ["/security/approvals"],
    },
    spawn: async () => {
      throw new Error("Unused protected runtime");
    },
    checkEvidence: vi.fn(async (_action, _source, signal) => {
      waiting = signal;
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      });
    }),
    check: async () => {
      throw new Error("Unexpected object check in this fixture");
    },
  });
  const a = "a".repeat(64),
    b = "b".repeat(64);
  gates.set(a, make("a:1"));
  gates.set(b, make("b:1"));
  const host = fakeHost(
    {
      runtime: () => ({
        file: "/runtime/deps/version/host.mjs",
        node: "/runtime/node/bin/node",
        codeRoot: "/runtime/deps",
        nodeRoot: "/runtime/node",
        data: "/runtime/state",
        auth: "/runtime/auth",
      }),
    },
    { close: true },
  );
  const pi = new Pi(
    () => host.spawn,
    handlers(),
    (agent) => gates.get(agent),
  );
  try {
    await Promise.all([
      pi.request("open", { agent: a }),
      pi.request("open", { agent: b }),
    ]);
    const protectedHosts = host.processes.filter(
      (process) => process.options.protection,
    );
    expect(protectedHosts).toHaveLength(2);
    const worker = protectedHosts.find((process) =>
      process.options.args?.at(-1)?.includes(a),
    );
    if (!worker) throw new Error("Missing protected worker");
    expect(worker.id).toBe("pi-protected-sh");
    expect(
      manifest.host.processes.find((process) => process.id === worker.id),
    ).toMatchObject({
      program: "buzz-agent-command",
      bundled: true,
      args: ["--shell"],
    });
    expect(worker.options.args?.[0]).toContain("--disable-sigusr1");
    expect(worker.options.env).toMatchObject({
      BASH_ENV: null,
      ENV: null,
      NODE_OPTIONS: null,
      NODE_PATH: null,
      DYLD_INSERT_LIBRARIES: null,
    });
    expect(worker.options.protection).toEqual({
      readOnlyPaths: ["/security/provider", "/runtime/deps", "/runtime/node"],
      hiddenPaths: ["/security/approvals"],
    });
    const id = crypto.randomUUID();
    await expect(
      evidence(worker, "begin", { id, kind: "tool", session: "1" }),
    ).resolves.toMatchObject({ result: { id } });
    await entered.promise;
    await expect(evidence(worker, "cancel", { id })).resolves.toMatchObject({
      result: { allowed: false },
    });
    expect(waiting?.aborted).toBe(true);
    // Each worker's evidence reaches only its own agent's provider.
    expect(gates.get(b)?.checkEvidence).not.toHaveBeenCalled();
    gates.set(a, make("a:2"));
    await pi.request("open", { agent: a });
    expect(worker.ended).toBe(true);
    expect(
      host.processes.filter((process) => process.options.protection),
    ).toHaveLength(3);
  } finally {
    await pi.dispose();
  }
});
