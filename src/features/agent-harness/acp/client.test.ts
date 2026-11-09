// The shared ACP client driving a plain-ACP harness, one without hooks.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fakeSpawn as fakeGoose,
  flush,
} from "../../../bundled/goose/goose-testing";
import { GOOSE } from "../../../bundled/goose/goose";
import { AgentProcess } from "../../../bundled/goose/sessions";
import type {
  HostMcpServer,
  HostProcess,
  HostProcessOptions,
} from "../../host/service";
import { AgentSessions, ServerPool, SHARED_POOL } from "./agent-sessions";
import { AcpProcess, REQUEST_TIMEOUT_MS } from "./process";
import type { AcpHooks, ToolServer } from "./types";

type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

const HOOKS: AcpHooks = {
  label: "Harness",
  program: "harness",
  missing: "Install the harness CLI.",
  env: { HOOK: "hook", SHARED: "hook" },
};

const tools: ToolServer = async (_conversation, message) => ({
  jsonrpc: "2.0",
  id: message.id,
  result: {},
});

/** A plain-ACP harness: `capabilities` is what `initialize` advertises. */
function fakeHarness(
  options: Readonly<{
    capabilities?: Record<string, unknown>;
    /** Requests it never answers. */
    silent?: readonly string[];
    /** Exits with this code as soon as it starts, as `env` does for a
     * missing program. */
    exitCode?: number;
    /** Turns stay open until finished. */
    hold?: boolean;
    /** Kill asks it to stop, and it never exits. */
    holdExit?: boolean;
    /** Rejects this many prompts first, as a harness signed out does. */
    rejectPrompts?: number;
    /** Every prompt is answered with this error. */
    promptError?: { code: number; message: string };
    /** Why a turn that ran ends. */
    stopReason?: string;
  }> = {},
) {
  const started: {
    options: HostProcessOptions;
    killed: boolean;
    kills: number;
  }[] = [];
  const received: Message[] = [];
  const turns: {
    sessionId: string;
    text: string;
    steered: string[];
    finish(): void;
  }[] = [];
  let servers = 0;
  let rejectPrompts = options.rejectPrompts ?? 0;
  const serve = async (): Promise<HostMcpServer> => {
    const index = ++servers;
    let stopped!: () => void;
    const closed = new Promise<void>((resolve) => (stopped = resolve));
    return {
      url: `http://127.0.0.1:${40_000 + index}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer token-${index}` }],
      close: async () => stopped(),
      closed,
    };
  };
  const spawn = async (
    _id: string,
    process: HostProcessOptions = {},
  ): Promise<HostProcess> => {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => (exit = resolve));
    let alive = true;
    const record = { options: process, killed: false, kills: 0 };
    started.push(record);
    const send = (message: Record<string, unknown>) =>
      queueMicrotask(() => {
        if (alive)
          process.onStdout?.(
            `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
          );
      });
    const reply = (id: Message["id"], result: unknown) => send({ id, result });
    /** Each session's running turn. */
    const running = new Map<string, (typeof turns)[number]>();
    const run = (sessionId: string, runId: string | null) =>
      send({
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "run", runId } },
      });
    const end = (code: number | null) => {
      if (!alive) return;
      alive = false;
      exit(code);
    };
    if (options.exitCode !== undefined) {
      const code = options.exitCode;
      queueMicrotask(() => {
        process.onStderr?.("env: harness: No such file or directory\n");
        end(code);
      });
    }
    let sessions = 0;
    return {
      write: async (data) => {
        if (!alive) throw new Error("Broken pipe");
        for (const line of data.split("\n").filter(Boolean)) {
          const message = JSON.parse(line) as Message;
          received.push(message);
          const { id, method, params = {} } = message;
          if (!method || options.silent?.includes(method)) continue;
          if (method === "initialize")
            reply(id, {
              protocolVersion: 1,
              agentCapabilities: options.capabilities ?? {
                mcpCapabilities: { http: true },
              },
            });
          else if (method === "session/new")
            reply(id, { sessionId: `session-${++sessions}` });
          else if (method === "session/close") reply(id, {});
          else if (method === "session/prompt" && rejectPrompts > 0) {
            rejectPrompts--;
            send({ id, error: { code: -32000, message: "Sign in first" } });
          } else if (method === "session/prompt" && options.promptError)
            send({ id, error: options.promptError });
          else if (method === "session/prompt") {
            const sessionId = String(params.sessionId);
            const text = (params.prompt as { text: string }[])[0]?.text ?? "";
            const runId = `run-${turns.length + 1}`;
            const turn = {
              sessionId,
              text,
              steered: [] as string[],
              finish: () => {
                running.delete(sessionId);
                run(sessionId, null);
                reply(id, { stopReason: options.stopReason ?? "end_turn" });
              },
            };
            turns.push(turn);
            running.set(sessionId, turn);
            run(sessionId, runId);
            if (!options.hold) turn.finish();
          } else if (method === "steer") {
            const turn = running.get(String(params.sessionId));
            if (turn && `run-${turns.indexOf(turn) + 1}` === params.runId) {
              turn.steered.push(String(params.text));
              reply(id, {});
            } else
              send({ id, error: { code: -32602, message: "No active run" } });
          }
        }
      },
      end: async () => undefined,
      kill: async () => {
        record.killed = true;
        record.kills++;
        if (!options.holdExit) end(null);
      },
      exited,
    };
  };
  const sent = (method: string) =>
    received.filter((message) => message.method === method);
  return { spawn, serve, started, received, turns, sent };
}

const start = (
  harness: ReturnType<typeof fakeHarness>,
  launch: Partial<Parameters<typeof AcpProcess.start>[2]> = {},
  hooks: AcpHooks = HOOKS,
) =>
  AcpProcess.start(harness.spawn, hooks, {
    cwd: "/work",
    serve: harness.serve,
    ...launch,
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("starting a harness", () => {
  it("passes the plugin's argv unchanged, with the Buzz identity removed last", async () => {
    const harness = fakeHarness();
    await start(harness, {
      args: ["cursor-agent", "acp", "--model", "x y"],
      env: {
        SHARED: "launch",
        BUZZ_PRIVATE_KEY: "nsec1leak",
        BUZZ_RELAY_URL: "wss://leak",
      },
    });
    const options = harness.started[0]?.options;
    expect(options?.args).toEqual(["cursor-agent", "acp", "--model", "x y"]);
    expect(options?.env).toEqual({
      HOOK: "hook",
      SHARED: "launch",
      BUZZ_PRIVATE_KEY: null,
      BUZZ_AUTH_TAG: null,
      BUZZ_RELAY_URL: null,
    });
  });

  it("refuses a harness that cannot take Buzz tools over HTTP MCP", async () => {
    for (const http of [false, undefined, "yes"]) {
      const harness = fakeHarness({
        capabilities: { mcpCapabilities: { http } },
      });
      await expect(start(harness)).rejects.toThrow(
        "This Harness cannot reach Buzz tools (no HTTP MCP support)",
      );
      expect(harness.started[0]?.killed).toBe(true);
    }
  });

  it("still fails a start at its time limit when the harness never exits, and gives the caller the harness", async () => {
    vi.useFakeTimers();
    const harness = fakeHarness({
      capabilities: { mcpCapabilities: { http: false } },
      holdExit: true,
    });
    let given: AcpProcess | undefined;
    let failure: unknown;
    const starting = start(harness, {
      onProcess: (acp) => (given = acp),
    }).catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.started[0]?.killed).toBe(true);
    expect(given?.running).toBe(true);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await starting;
    expect(failure).toEqual(
      new Error("This Harness cannot reach Buzz tools (no HTTP MCP support)"),
    );
    expect(given?.running).toBe(true);
  });

  const diagnosing: AcpHooks = { ...HOOKS, diagnoseStartup: true };

  it("names the install hint when the program is missing or cannot run", async () => {
    for (const exitCode of [127, 126]) {
      const harness = fakeHarness({ exitCode });
      await expect(start(harness, {}, diagnosing)).rejects.toThrow(
        "Install the harness CLI.",
      );
    }
  });

  it("reports another early exit as itself", async () => {
    const harness = fakeHarness({ exitCode: 1 });
    await expect(start(harness, {}, diagnosing)).rejects.toThrow(
      "env: harness: No such file or directory",
    );
  });

  it("reports goose's early exit by its code alone", async () => {
    for (const exitCode of [1, 127]) {
      const harness = fakeHarness({ exitCode });
      await expect(start(harness, {}, GOOSE)).rejects.toThrow(
        new Error(`goose exited (${exitCode})`),
      );
    }
  });

  it("stops a harness that never answers initialize", async () => {
    vi.useFakeTimers();
    const harness = fakeHarness({ silent: ["initialize"] });
    const starting = start(harness);
    const failed = expect(starting).rejects.toThrow(
      "Harness did not answer initialize in 60s",
    );
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    expect(harness.started[0]?.killed).toBe(true);
  });

  it("rejects at once when cancelled while it starts, even if it never exits", async () => {
    const harness = fakeHarness({ silent: ["initialize"], holdExit: true });
    const controller = new AbortController();
    const starting = start(harness, { signal: controller.signal });
    await flush();
    controller.abort(new Error("Check was cancelled"));
    await expect(starting).rejects.toThrow("Check was cancelled");
    expect(harness.started[0]?.killed).toBe(true);
  });

  it("leaves no request deadline behind when cancelled while it starts", async () => {
    vi.useFakeTimers();
    const harness = fakeHarness({ silent: ["initialize"], holdExit: true });
    const controller = new AbortController();
    const starting = start(harness, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("Check was cancelled"));
    await expect(starting).rejects.toThrow("Check was cancelled");
    // Only the background stop's own wait is left.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(harness.started[0]?.kills).toBe(1);
  });

  it("rejects at once when cancelled while the host is still starting it, and stops the late harness", async () => {
    const harness = fakeHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spawn: typeof harness.spawn = async (...args) => {
      await gate;
      return harness.spawn(...args);
    };
    const controller = new AbortController();
    const starting = AcpProcess.start(spawn, HOOKS, {
      cwd: "/work",
      serve: harness.serve,
      signal: controller.signal,
    });
    const outcome = starting.then(
      () => "started",
      (error: Error) => error.message,
    );
    await flush();
    controller.abort(new Error("Check was cancelled"));
    await flush();
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe(
      "Check was cancelled",
    );
    expect(harness.started).toEqual([]);
    release();
    await flush();
    expect(harness.started[0]?.killed).toBe(true);
  });

  it("starts nothing when already cancelled", async () => {
    const harness = fakeHarness();
    const controller = new AbortController();
    controller.abort(new Error("Removed"));
    await expect(start(harness, { signal: controller.signal })).rejects.toThrow(
      "Removed",
    );
    expect(harness.started).toEqual([]);
  });

  it("stops within its time limit, for a check that opens no session", async () => {
    const harness = fakeHarness();
    const acp = await start(harness);
    expect(acp.agentCapabilities).toEqual({ mcpCapabilities: { http: true } });
    await acp.stop();
    expect(harness.started[0]?.killed).toBe(true);
    expect(acp.running).toBe(false);
  });

  it("gives up waiting at the time limit for a harness that never exits", async () => {
    vi.useFakeTimers();
    const harness = fakeHarness({ holdExit: true });
    const acp = await start(harness);
    let stopped = false;
    const stopping = acp.stop(1_000).then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(harness.started[0]?.killed).toBe(true);
    expect(harness.sent("session/new")).toEqual([]);
  });
});

describe("a session with a steering hook", () => {
  it("steers a message sent while the next turn picks its model into that turn, not the finished one", async () => {
    let selecting: (() => void) | undefined;
    const hooks: AcpHooks = {
      ...HOOKS,
      steering: {
        runId: (update) =>
          update.sessionUpdate !== "run"
            ? null
            : typeof update.runId === "string"
              ? update.runId
              : undefined,
        steer: async (acp, sessionId, runId, text) => {
          await acp.request("steer", { sessionId, runId, text });
        },
      },
      // The second turn's model pick waits until released.
      select: (_acp, session, want) =>
        want.model === "slow"
          ? new Promise<void>((resolve) => {
              selecting = () => {
                session.chosen = want;
                resolve();
              };
            })
          : Promise.resolve(),
    };
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness, {}, hooks);
    const session = await acp.open({
      cwd: "/work",
      systemPrompt: "",
      choice: () => ({ provider: "", model: "" }),
    });
    const first = session.send("first");
    await flush();
    // Another model: queued as the next turn rather than steered.
    const second = session.send("second", {}, "slow");
    await flush();
    harness.turns[0]?.finish();
    await flush();
    expect(selecting).toBeDefined();
    const third = session.send("third");
    await flush();
    selecting?.();
    await flush();
    expect(harness.turns.map((turn) => turn.text)).toEqual(["first", "second"]);
    expect(harness.turns[1]?.steered).toEqual(["third"]);
    harness.turns[1]?.finish();
    await expect(Promise.all([first, second, third])).resolves.toHaveLength(3);
  });
  it("never steers a message stopped while it waits for the run's id", async () => {
    const hooks: AcpHooks = {
      ...HOOKS,
      steering: {
        // The run's id comes only when the test announces it.
        runId: (update) =>
          update.sessionUpdate === "announce" ? String(update.runId) : null,
        steer: async (acp, sessionId, runId, text) => {
          await acp.request("steer", { sessionId, runId, text });
        },
      },
    };
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness, {}, hooks);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const first = session.send("first");
    await flush();
    const second = session.send("second");
    await flush();
    session.interrupt();
    session.update({ sessionUpdate: "announce", runId: "run-1" });
    await flush();
    expect(harness.sent("steer")).toEqual([]);
    harness.turns[0]?.finish();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });
});

describe("a session without hooks", () => {
  it("leads the first prompt with the instructions, once, when ACP's systemPrompt is not advertised", async () => {
    const harness = fakeHarness();
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "Be Buzz." });
    const [opened] = harness.sent("session/new");
    expect(opened?.params).not.toHaveProperty("systemPrompt");
    expect(opened?.params).not.toHaveProperty("_meta");
    await session.send("first");
    await session.send("second");
    expect(harness.turns.map((turn) => turn.text)).toEqual([
      "Be Buzz.\n\nfirst",
      "second",
    ]);
  });

  it("keeps the instructions for the next prompt when the first is rejected", async () => {
    const harness = fakeHarness({ rejectPrompts: 1 });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "Be Buzz." });
    await expect(session.send("first")).resolves.toMatchObject({
      ok: false,
      error: "Sign in first",
    });
    await expect(session.send("second")).resolves.toMatchObject({ ok: true });
    expect(harness.turns.map((turn) => turn.text)).toEqual([
      "Be Buzz.\n\nsecond",
    ]);
  });

  it("sends the instructions as ACP's systemPrompt when advertised", async () => {
    const harness = fakeHarness({
      capabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: { systemPrompt: {} },
      },
    });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "Be Buzz." });
    expect(harness.sent("session/new")[0]?.params?.systemPrompt).toEqual({
      mode: "append",
      content: [{ type: "text", text: "Be Buzz." }],
    });
    await session.send("first");
    expect(harness.turns.map((turn) => turn.text)).toEqual(["first"]);
  });

  it("queues a message sent mid-turn as the next turn", async () => {
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const first = session.send("first");
    await flush();
    const second = session.send("second");
    await flush();
    expect(harness.turns.map((turn) => turn.text)).toEqual(["first"]);
    harness.turns[0]?.finish();
    await flush();
    expect(harness.turns.map((turn) => turn.text)).toEqual(["first", "second"]);
    harness.turns[1]?.finish();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
  });

  it("answers a check of work only while that work runs, not for work after it", async () => {
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const before = session.current();
    const first = session.send("first");
    await flush();
    const current = session.current();
    expect(current()).toBe(true);
    harness.turns[0]?.finish();
    await expect(first).resolves.toEqual({ ok: true });
    expect(current()).toBe(false);

    const second = session.send("second");
    await flush();
    expect(session.current()()).toBe(true);
    expect(current()).toBe(false);
    expect(before()).toBe(false);
    harness.turns[1]?.finish();
    await second;
  });

  it("keeps the harness's error code on a failed turn", async () => {
    const harness = fakeHarness({
      promptError: { code: -32000, message: "Authentication required" },
    });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    await expect(session.send("first")).resolves.toEqual({
      ok: false,
      error: "Authentication required",
      code: -32000,
    });
  });

  it("drops an earlier prompt's error code when a later one is refused", async () => {
    const harness = fakeHarness({ rejectPrompts: 1, stopReason: "refusal" });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    void session.send("first");
    // The latest message owns the burst's error.
    await expect(session.send("second")).resolves.toEqual({
      ok: false,
      error: "Harness refused the request",
    });
  });

  it("asks the harness to close a session only when it advertises close", async () => {
    for (const close of [undefined, {}]) {
      const harness = fakeHarness({
        capabilities: {
          mcpCapabilities: { http: true },
          sessionCapabilities: close ? { close } : {},
        },
      });
      const acp = await start(harness);
      const session = await acp.open({ cwd: "/work", systemPrompt: "" });
      await acp.close(session);
      expect(harness.sent("session/cancel")).toHaveLength(1);
      expect(harness.sent("session/close")).toHaveLength(close ? 1 : 0);
      expect(session.open).toBe(false);
    }
  });
});

describe("the shared server pool", () => {
  it("is used by every agent's sessions unless one is given", async () => {
    const harness = fakeHarness();
    const acp = await start(harness);
    const sessions = new AgentSessions({
      label: "Harness",
      resolveDirectory: async (path) => path,
      tools,
      process: { get: async () => acp },
      launch: async () => ({ workspace: "/work", systemPrompt: "" }),
      choice: () => ({ provider: "", model: "" }),
      fingerprint: () => "",
    });
    const before = SHARED_POOL.size;
    await sessions.deliver("conversation", "hello", 1);
    expect(SHARED_POOL.size).toBe(before + 1);
    sessions.dispose();
    await flush();
    expect(SHARED_POOL.size).toBe(before);
  });

  it("closes the idle session of either plugin to make room for the other", async () => {
    const pool = new ServerPool(1);
    const goose = fakeGoose({ home: "/home/test" });
    const harness = fakeHarness();
    const launch = async () => ({ workspace: "/work", systemPrompt: "" });
    const choice = () => ({ provider: "", model: "" });
    const gooseSessions = new AgentSessions({
      label: "goose",
      resolveDirectory: goose.resolveDirectory,
      tools,
      process: new AgentProcess(goose, goose.serve),
      pool,
      launch,
      choice,
      fingerprint: () => "",
    });
    const acp = await start(harness);
    const genericSessions = new AgentSessions({
      label: "Harness",
      resolveDirectory: async (path) => path,
      tools,
      process: { get: async () => acp },
      pool,
      launch,
      choice,
      fingerprint: () => "",
    });

    await gooseSessions.deliver("goose chat", "hello", 1);
    expect(gooseSessions.snapshot().map((item) => item.key)).toEqual([
      "goose chat",
    ]);
    await genericSessions.deliver("generic chat", "hello", 1);
    expect(gooseSessions.snapshot()).toEqual([]);
    expect(genericSessions.snapshot().map((item) => item.key)).toEqual([
      "generic chat",
    ]);
    expect(goose.geese[0]?.closed).toEqual(["session-1"]);

    await gooseSessions.deliver("goose chat", "again", 2);
    expect(genericSessions.snapshot()).toEqual([]);
    expect(pool.size).toBe(1);
    gooseSessions.dispose();
    genericSessions.dispose();
  });
});
