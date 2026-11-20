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
import {
  AgentSessions,
  association,
  type Exclusive,
  type SavedConversation,
  savedConversation,
  ServerPool,
  SHARED_POOL,
} from "./agent-sessions";
import { AcpProcess, REQUEST_TIMEOUT_MS, TOOL_SERVER } from "./process";
import { AcpSession } from "./session";
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
    /** Every `session/load` is answered with this error. */
    loadError?: { code: number; message: string };
    /** Every `session/load` is answered with this result; `{}` by default. */
    loadResult?: unknown;
    /** Each `session/close` waits in `closes` to be answered. */
    holdClose?: boolean;
    /** Every `session/close` is answered with this error. */
    closeError?: { code: number; message: string };
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
    finish(error?: { code: number; message: string }): void;
  }[] = [];
  const closes: (() => void)[] = [];
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
          else if (method === "session/close" && options.closeError)
            send({ id, error: options.closeError });
          else if (method === "session/close" && options.holdClose)
            closes.push(() => reply(id, {}));
          else if (method === "session/close") reply(id, {});
          else if (method === "session/load" && options.loadError)
            send({ id, error: options.loadError });
          else if (method === "session/load") {
            // As goose does: the saved conversation replays before the answer.
            for (const sessionUpdate of ["user_message_chunk", "tool_call"])
              send({
                method: "session/update",
                params: {
                  sessionId: params.sessionId,
                  update: { sessionUpdate, toolCallId: "call-1" },
                },
              });
            reply(id, "loadResult" in options ? options.loadResult : {});
          } else if (method === "session/prompt" && rejectPrompts > 0) {
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
              finish: (error?: { code: number; message: string }) => {
                running.delete(sessionId);
                run(sessionId, null);
                if (error) send({ id, error });
                else
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
  return { spawn, serve, started, received, turns, sent, closes };
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
  it("confirms delivery when the run starts before a later prompt error", async () => {
    const hooks: AcpHooks = {
      ...HOOKS,
      steering: {
        runId: (update) =>
          update.sessionUpdate === "run" && typeof update.runId === "string"
            ? update.runId
            : null,
        steer: async () => {},
      },
    };
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness, {}, hooks);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const delivered = vi.fn();
    const settled = vi.fn();
    const prompt = session.send("first", { delivered }).then(settled);
    try {
      await flush();
      expect(harness.turns).toHaveLength(1);
      expect(settled).not.toHaveBeenCalled();
      expect(delivered).toHaveBeenCalledOnce();
      harness.turns[0]?.finish({ code: -32000, message: "Run failed" });
      await prompt;
      expect(settled).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, error: "Run failed" }),
      );
      expect(delivered).toHaveBeenCalledOnce();
    } finally {
      await acp.stop();
    }
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
  it("lets an observer see each update and whether a prompt is in flight", async () => {
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const seen: [unknown, boolean][] = [];
    // The fake harness also announces its runs.
    session.observe = (update, prompting) => {
      if (update.sessionUpdate !== "run")
        seen.push([update.sessionUpdate, prompting]);
    };
    // Outside a prompt, as a replay would arrive.
    session.update({ sessionUpdate: "tool_call_update" });
    const turn = session.send("first");
    await flush();
    session.update({ sessionUpdate: "tool_call" });
    harness.turns[0]?.finish();
    await turn;
    session.update({ sessionUpdate: "tool_call_update" });
    expect(seen).toEqual([
      ["tool_call_update", false],
      ["tool_call", true],
      ["tool_call_update", false],
    ]);
  });
  it("handles each update and answer even when its observer throws", async () => {
    const harness = fakeHarness();
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    session.observe = () => {
      throw new Error("observer broke");
    };
    try {
      await expect(session.send("first")).resolves.toMatchObject({ ok: true });
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

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

  it("cancels captured work on Stop, final settlement, failure and close, independently per session", async () => {
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const other = await acp.open({ cwd: "/work", systemPrompt: "" });
    expect(session.signal.aborted).toBe(true);
    const first = session.send("first");
    const parallel = other.send("other");
    await flush();
    const old = session.signal;
    const isolated = other.signal;
    session.interrupt();
    expect(old.aborted).toBe(true);
    expect(isolated.aborted).toBe(false);
    const second = session.send("second");
    expect(session.signal.aborted).toBe(true);
    harness.turns[0]?.finish();
    await flush();
    const fresh = session.signal;
    expect(fresh).not.toBe(old);
    expect(fresh.aborted).toBe(false);
    expect(old.aborted).toBe(true);
    session.finished("final-call");
    expect(fresh.aborted).toBe(true);
    expect(session.working).toBe(true);
    await second;
    harness.turns[2]?.finish();
    await first;
    await acp.close(other);
    expect(isolated.aborted).toBe(true);
    await parallel;
    const failed = session.send("failure");
    await flush();
    const failing = session.signal;
    session.fail("failure");
    expect(failing.aborted).toBe(true);
    await expect(failed).resolves.toMatchObject({ ok: false });
  });

  it("aborts work when a prompt fails, without waiting for a process close", async () => {
    const harness = fakeHarness({
      promptError: { code: -32000, message: "failed" },
    });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const done = session.send("first");
    const signal = session.signal;
    expect(signal.aborted).toBe(false);
    await expect(done).resolves.toMatchObject({ ok: false });
    expect(signal.aborted).toBe(true);
    expect(session.open).toBe(true);
  });

  it("forwards an aborted signal before session/new and while idle, and aborts active calls on process exit", async () => {
    const fake = fakeGoose({ hold: true });
    const signals: AbortSignal[] = [];
    const handler: ToolServer = async (_conversation, message, signal) => {
      if (!signal) throw new Error("Missing cancellation");
      signals.push(signal);
      return { jsonrpc: "2.0", id: message.id, result: {} };
    };
    const acp = await AcpProcess.start(fake.spawn, GOOSE, {
      cwd: "/work",
      serve: async (dispatch) => {
        await dispatch({ id: 1, method: "tools/list" });
        return fake.serve(dispatch);
      },
    });
    const session = await acp.open({
      cwd: "/work",
      systemPrompt: "",
      tools: handler,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    const process = fake.geese[0];
    if (!process) throw new Error("Missing process");
    await process.mcp(session.id, "tools/list");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    const done = session.send("first");
    await vi.waitFor(() => expect(process.turns).toHaveLength(1));
    await process.mcp(session.id, "tools/call", { name: "fixture" });
    const active = signals.at(-1);
    expect(active?.aborted).toBe(false);
    process.exit(1, "failed");
    await acp.exited;
    expect(active?.aborted).toBe(true);
    await expect(done).resolves.toMatchObject({ ok: false });
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

describe("resuming a saved session", () => {
  const LOADS = {
    mcpCapabilities: { http: true },
    loadSession: true,
    sessionCapabilities: { close: {} },
  };

  it("loads it with fresh tools, never seeing its replay, naming or new-session meta", async () => {
    const names = vi.fn(async () => true);
    const newSessionMeta = vi.fn(() => ({}));
    const systemPrompt = vi.fn(async () => undefined);
    const hooks: AcpHooks = { ...HOOKS, names, newSessionMeta, systemPrompt };
    const harness = fakeHarness({ capabilities: LOADS });
    const acp = await start(harness, {}, hooks);
    const first = await acp.open({
      cwd: "/work",
      systemPrompt: "Be Buzz.",
      tools,
    });
    await acp.close(first);
    names.mockClear();
    newSessionMeta.mockClear();
    systemPrompt.mockClear();
    const updates = vi.spyOn(AcpSession.prototype, "update");
    const seen: unknown[] = [];
    const named = vi.fn();
    try {
      const session = await acp.open({
        cwd: "/work",
        systemPrompt: "Be Buzz.",
        title: "A new title",
        named,
        tools,
        load: first.id,
        onSession: (opened) => {
          opened.observe = (update) => seen.push(update);
        },
      });
      await flush();
      expect(session.id).toBe(first.id);
      expect(updates).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
      expect(harness.sent("session/new")).toHaveLength(1);
      // The first session's server was token-1; its token is never reused.
      expect(harness.sent("session/load")[0]?.params).toEqual({
        sessionId: first.id,
        cwd: "/work",
        mcpServers: [
          {
            type: "http",
            name: TOOL_SERVER,
            url: "http://127.0.0.1:40002/mcp",
            headers: [{ name: "Authorization", value: "Bearer token-2" }],
          },
        ],
      });
      expect(names).not.toHaveBeenCalled();
      expect(newSessionMeta).not.toHaveBeenCalled();
      expect(named).not.toHaveBeenCalled();
      // Set under its key again, which replaces it rather than adding one.
      expect(systemPrompt).toHaveBeenCalledExactlyOnceWith(
        acp,
        first.id,
        "Be Buzz.",
        undefined,
      );
    } finally {
      updates.mockRestore();
    }
  });

  it("leads no prompt with the instructions its conversation already holds", async () => {
    const harness = fakeHarness({ capabilities: LOADS });
    const acp = await start(harness);
    const session = await acp.open({
      cwd: "/work",
      systemPrompt: "Be Buzz.",
      load: "saved-1",
    });
    await session.send("next");
    expect(harness.turns.map((turn) => turn.text)).toEqual(["next"]);
  });

  it("refuses, never opening a new session, without loadSession or when the load fails", async () => {
    const without = fakeHarness();
    const plain = await start(without);
    await expect(
      plain.open({ cwd: "/work", systemPrompt: "", load: "saved-1" }),
    ).rejects.toThrow("This Harness cannot resume a session");
    expect(without.sent("session/load")).toEqual([]);
    expect(without.sent("session/new")).toEqual([]);

    const failing = fakeHarness({
      capabilities: LOADS,
      loadError: { code: -32002, message: "Session not found: saved-1" },
    });
    const acp = await start(failing);
    await expect(
      acp.open({ cwd: "/work", systemPrompt: "", tools, load: "saved-1" }),
    ).rejects.toThrow("Session not found: saved-1");
    expect(failing.sent("session/new")).toEqual([]);
    // Nothing holds the id: a later load may try again.
    failing.sent("session/load").length = 0;
    await expect(
      acp.open({ cwd: "/work", systemPrompt: "", load: "saved-1" }),
    ).rejects.toThrow("Session not found: saved-1");
  });

  it("refuses a system prompt it would have to send with session/new", async () => {
    const harness = fakeHarness({
      capabilities: {
        ...LOADS,
        sessionCapabilities: { close: {}, systemPrompt: {} },
      },
    });
    const acp = await start(harness);
    await expect(
      acp.open({ cwd: "/work", systemPrompt: "Be Buzz.", load: "saved-1" }),
    ).rejects.toThrow(
      "This Harness cannot resume a session with its system prompt",
    );
    expect(harness.sent("session/load")).toEqual([]);
  });

  it("resumes a session whose load answers null, keeping its tools", async () => {
    const harness = fakeHarness({ capabilities: LOADS, loadResult: null });
    const acp = await start(harness);
    const session = await acp.open({
      cwd: "/work",
      systemPrompt: "",
      tools,
      load: "saved-1",
    });
    expect(session.id).toBe("saved-1");
    expect(session.open).toBe(true);
    // Its tools' server stays up with it.
    let stopped = false;
    void session.server?.closed.then(() => (stopped = true));
    await flush();
    expect(stopped).toBe(false);
  });

  it("lets one open own a saved session at a time", async () => {
    const harness = fakeHarness({ capabilities: LOADS });
    const acp = await start(harness);
    const loading = acp.open({
      cwd: "/work",
      systemPrompt: "",
      load: "saved-1",
    });
    await expect(
      acp.open({ cwd: "/work", systemPrompt: "", load: "saved-1" }),
    ).rejects.toThrow("This Harness session is already open");
    const session = await loading;
    await expect(
      acp.open({ cwd: "/work", systemPrompt: "", load: "saved-1" }),
    ).rejects.toThrow("This Harness session is already open");
    expect(harness.sent("session/load")).toHaveLength(1);
    await acp.close(session);
    await expect(
      acp.open({ cwd: "/work", systemPrompt: "", load: "saved-1" }),
    ).resolves.toMatchObject({ id: "saved-1" });
  });

  it("waits for the harness to acknowledge a close before loading it again", async () => {
    const harness = fakeHarness({
      capabilities: { ...LOADS, sessionCapabilities: {} },
    });
    const acp = await start(harness);
    const session = await acp.open({
      cwd: "/work",
      systemPrompt: "",
      load: "saved-1",
    });
    await acp.close(session);
    await expect(
      acp.open({ cwd: "/work", systemPrompt: "", load: "saved-1" }),
    ).rejects.toThrow("This Harness session has not finished closing");
    expect(harness.sent("session/load")).toHaveLength(1);
  });
});

describe("holding a conversation", () => {
  const CLOSES = {
    mcpCapabilities: { http: true },
    sessionCapabilities: { close: {} },
  };
  function held(
    harness: ReturnType<typeof fakeHarness>,
    acp: AcpProcess,
    launch = async () => ({ workspace: "/work", systemPrompt: "" }),
  ) {
    const saved = new Map<string, SavedConversation>();
    const sessions = new AgentSessions({
      label: "Harness",
      resolveDirectory: async (path) => path,
      tools,
      process: { get: async () => acp },
      launch,
      choice: () => ({ provider: "", model: "" }),
      fingerprint: () => "",
      store: {
        get: (key) => saved.get(key),
        set: (key, value) => saved.set(key, value),
      },
    });
    return { sessions, saved, harness };
  }
  const deferred = <T = void>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };

  it("starts its work only once the old session's close is acknowledged, and messages wait for it", async () => {
    const harness = fakeHarness({ capabilities: CLOSES, holdClose: true });
    const { sessions } = held(harness, await start(harness));
    await sessions.deliver("chat", "hello", 1);
    const order: string[] = [];
    const holding = sessions.exclusive("chat", async ({ saved }) => {
      order.push(`work ${saved}`);
      return "done";
    });
    await flush();
    const later = sessions
      .deliver("chat", "later", 2)
      .then(() => order.push("later"));
    await flush();
    expect(harness.sent("session/close")).toHaveLength(1);
    expect(order).toEqual([]);
    expect(sessions.active("chat")).toBe(true);
    harness.closes.shift()?.();
    await expect(holding).resolves.toBe("done");
    await later;
    expect(order).toEqual(["work session-1", "later"]);
    expect(harness.turns.map((turn) => turn.text)).toEqual(["hello", "later"]);
    expect(harness.sent("session/delete")).toEqual([]);
  });

  it("never starts its work after a close the harness failed, deleting nothing", async () => {
    const harness = fakeHarness({
      capabilities: CLOSES,
      closeError: { code: -32000, message: "close failed" },
    });
    const { sessions, saved } = held(harness, await start(harness));
    await sessions.deliver("chat", "hello", 1);
    const before = saved.get("chat");
    const work = vi.fn(async () => undefined);
    await expect(sessions.exclusive("chat", work)).rejects.toThrow(
      "close failed",
    );
    // The failed close stays failed: the next hold is refused too.
    await expect(sessions.exclusive("chat", work)).rejects.toThrow(
      "close failed",
    );
    expect(work).not.toHaveBeenCalled();
    expect(sessions.active("chat")).toBe(false);
    expect(saved.get("chat")).toEqual(before);
    expect(harness.sent("session/delete")).toEqual([]);
  });

  it("leaves other conversations alone", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    await sessions.deliver("other", "hello", 1);
    const working = deferred();
    const holding = sessions.exclusive("chat", () => working.promise);
    await flush();
    await expect(sessions.deliver("other", "again", 2)).resolves.toMatchObject({
      ok: true,
    });
    expect(harness.sent("session/close")).toEqual([]);
    working.resolve();
    await holding;
  });

  it("lets one caller in at a time once an opening session settles", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const launching = deferred();
    const { sessions } = held(harness, await start(harness), async () => {
      await launching.promise;
      return { workspace: "/work", systemPrompt: "" };
    });
    const opening = sessions.deliver("chat", "hello", 1);
    await flush();
    const first = deferred();
    const entered: string[] = [];
    const a = sessions.exclusive("chat", () => {
      entered.push("a");
      return first.promise;
    });
    const b = sessions.exclusive("chat", async () => {
      entered.push("b");
    });
    launching.resolve();
    await opening;
    await flush();
    expect(entered).toEqual(["a"]);
    first.resolve();
    await Promise.all([a, b]);
    expect(entered).toEqual(["a", "b"]);
  });

  it("tells its work of an interrupt at once, without waiting for it", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    const working = deferred();
    let signal: AbortSignal | undefined;
    const holding = sessions.exclusive("chat", (held) => {
      signal = held.signal;
      return working.promise;
    });
    await flush();
    await sessions.interrupt("chat");
    expect(signal?.aborted).toBe(true);
    expect(sessions.active("chat")).toBe(true);
    working.resolve();
    await holding;
    expect(sessions.active("chat")).toBe(false);
  });

  it("never starts work interrupted while it waits for a close", async () => {
    const harness = fakeHarness({ capabilities: CLOSES, holdClose: true });
    const { sessions } = held(harness, await start(harness));
    await sessions.deliver("chat", "hello", 1);
    const work = vi.fn(async () => undefined);
    const holding = sessions.exclusive("chat", work);
    await flush();
    await sessions.interrupt("chat");
    harness.closes.shift()?.();
    await expect(holding).rejects.toThrow("Harness was stopped");
    expect(work).not.toHaveBeenCalled();
    expect(sessions.active("chat")).toBe(false);
  });

  it("is aborted by dispose, and shutdown waits for its work", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    const working = deferred();
    let signal: AbortSignal | undefined;
    const holding = sessions.exclusive("chat", (held) => {
      signal = held.signal;
      return working.promise;
    });
    await flush();
    let shut = false;
    const shutting = sessions.shutdown().then(() => (shut = true));
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(shut).toBe(false);
    working.resolve();
    await Promise.all([holding, shutting]);
    await expect(
      sessions.exclusive("chat", async () => undefined),
    ).rejects.toThrow("Harness was stopped");
  });

  it("queues the conversation's holds and messages, not others, until a session its work left running exits", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    const exited = deferred<number | null>();
    await sessions.exclusive("chat", async ({ outlives }) => {
      outlives(exited.promise);
    });
    const work = vi.fn(async () => undefined);
    const holding = sessions.exclusive("chat", work);
    const waiting = sessions.deliver("chat", "after", 1);
    // A whole turn elsewhere: time enough for an unblocked one to run.
    await expect(
      sessions.deliver("other", "meanwhile", 1),
    ).resolves.toMatchObject({ ok: true });
    expect(sessions.active("chat")).toBe(true);
    expect(work).not.toHaveBeenCalled();
    expect(harness.turns.map((turn) => turn.text)).toEqual(["meanwhile"]);
    exited.resolve(0);
    await holding;
    expect(work).toHaveBeenCalledOnce();
    await expect(waiting).resolves.toMatchObject({ ok: true });
    expect(harness.turns.map((turn) => turn.text)).toEqual([
      "meanwhile",
      "after",
    ]);
  });

  it("keeps both paths refused when a left-running session's exit cannot be observed", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const harness = fakeHarness({ capabilities: CLOSES });
      const { sessions } = held(harness, await start(harness));
      const exited = deferred<number | null>();
      await sessions.exclusive("chat", async ({ outlives }) => {
        outlives(exited.promise);
      });
      const waiting = sessions.deliver("chat", "after", 1);
      exited.reject(new Error("exit unobservable"));
      await expect(waiting).resolves.toMatchObject({
        ok: false,
        error: "Harness could not confirm this conversation's session ended",
        undelivered: true,
      });
      const work = vi.fn(async () => undefined);
      await expect(sessions.exclusive("chat", work)).rejects.toThrow(
        "Harness could not confirm this conversation's session ended",
      );
      expect(work).not.toHaveBeenCalled();
      expect(harness.turns).toEqual([]);
    } finally {
      warned.mockRestore();
    }
  });

  it("waits for every session its work left running, whichever exits last", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    const first = deferred<number | null>();
    const second = deferred<number | null>();
    await sessions.exclusive("chat", async ({ outlives }) => {
      outlives(first.promise);
      outlives(second.promise);
    });
    const waiting = sessions.deliver("chat", "after", 1);
    second.resolve(0);
    // A whole turn elsewhere: time enough for an unblocked one to run.
    await expect(
      sessions.deliver("other", "meanwhile", 1),
    ).resolves.toMatchObject({ ok: true });
    expect(sessions.active("chat")).toBe(true);
    expect(harness.turns.map((turn) => turn.text)).toEqual(["meanwhile"]);
    first.resolve(0);
    await expect(waiting).resolves.toMatchObject({ ok: true });
    expect(harness.turns.map((turn) => turn.text)).toEqual([
      "meanwhile",
      "after",
    ]);
  });

  it("keeps the conversation refused when an earlier left-running session's exit cannot be observed", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const harness = fakeHarness({ capabilities: CLOSES });
      const { sessions } = held(harness, await start(harness));
      const first = deferred<number | null>();
      const second = deferred<number | null>();
      await sessions.exclusive("chat", async ({ outlives }) => {
        outlives(first.promise);
        outlives(second.promise);
      });
      first.reject(new Error("exit unobservable"));
      second.resolve(0);
      await expect(sessions.deliver("chat", "after", 1)).resolves.toMatchObject(
        {
          ok: false,
          error: "Harness could not confirm this conversation's session ended",
          undelivered: true,
        },
      );
      expect(warned).toHaveBeenCalledOnce();
      expect(harness.turns).toEqual([]);
    } finally {
      warned.mockRestore();
    }
  });

  it("refuses a left-running session named after its work settled", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    let late: ((done: Promise<unknown>) => void) | undefined;
    await sessions.exclusive("chat", async ({ outlives }) => {
      late = outlives;
    });
    expect(() => late?.(new Promise(() => {}))).toThrow(
      "Harness has released this conversation",
    );
    await expect(sessions.deliver("chat", "after", 1)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("lets a message waiting on a left-running session give up, or stop", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    await sessions.exclusive("chat", async ({ outlives }) => {
      outlives(new Promise(() => {}));
    });
    const giving = new AbortController();
    const given = sessions.deliver("chat", "abandoned", 1, {
      signal: giving.signal,
    });
    const stopped = sessions.deliver("chat", "stopped", 1);
    await flush();
    giving.abort();
    await expect(given).resolves.toMatchObject({
      ok: false,
      undelivered: true,
    });
    sessions.dispose();
    await expect(stopped).resolves.toMatchObject({
      ok: false,
      error: "Harness was stopped",
      undelivered: true,
    });
    expect(harness.turns).toEqual([]);
  });

  it("counts as the conversation's session for the next message", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    await sessions.exclusive("chat", async () => undefined);
    const named = vi.fn();
    await sessions.deliver("chat", "stale", 1, {
      fresh: async () => "rebuilt",
      named,
    });
    expect(harness.turns.map((turn) => turn.text)).toEqual(["rebuilt"]);
  });

  it("keeps a session only while it holds the conversation, and releases it on failure", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions, saved } = held(harness, await start(harness));
    let late: ((id: string, binding: unknown) => boolean) | undefined;
    await sessions.exclusive("chat", async ({ keep }) => {
      expect(keep("saved-1", "b1")).toBe(true);
      late = keep;
    });
    expect(saved.get("chat")).toMatchObject({
      sessions: ["saved-1"],
      binding: { session: "saved-1", value: "b1" },
    });
    expect(late?.("saved-2", "b2")).toBe(false);
    expect(saved.get("chat")?.sessions).toEqual(["saved-1"]);
    await expect(
      sessions.exclusive("chat", async ({ saved: newest }) => {
        throw new Error(`could not load ${newest}`);
      }),
    ).rejects.toThrow("could not load saved-1");
    expect(sessions.active("chat")).toBe(false);
  });

  it("ends a hold queued behind a left-running session on interrupt, never running it", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    const exited = deferred<number | null>();
    await sessions.exclusive("chat", async ({ outlives }) => {
      outlives(exited.promise);
    });
    const work = vi.fn(async () => undefined);
    const queued = sessions.exclusive("chat", work);
    await flush();
    await sessions.interrupt("chat");
    await expect(queued).rejects.toThrow("Harness was stopped");
    exited.resolve(0);
    await flush();
    expect(work).not.toHaveBeenCalled();
    expect(sessions.active("chat")).toBe(false);
  });

  it("ends a queued hold on its caller's signal, or on dispose", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    await sessions.exclusive("chat", async ({ outlives }) => {
      outlives(new Promise(() => {}));
    });
    const work = vi.fn(async () => undefined);
    const giving = new AbortController();
    const given = sessions.exclusive("chat", work, giving.signal);
    const stopped = sessions.exclusive("chat", work);
    await flush();
    giving.abort();
    await expect(given).rejects.toThrow("Harness was stopped");
    sessions.dispose();
    await expect(stopped).rejects.toThrow("Harness was stopped");
    expect(work).not.toHaveBeenCalled();
  });

  it("refuses a hold queued behind a left-running session whose exit then cannot be observed", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const harness = fakeHarness({ capabilities: CLOSES });
      const { sessions } = held(harness, await start(harness));
      const exited = deferred<number | null>();
      await sessions.exclusive("chat", async ({ outlives }) => {
        outlives(exited.promise);
      });
      const work = vi.fn(async () => undefined);
      const queued = sessions.exclusive("chat", work);
      await flush();
      exited.reject(new Error("exit unobservable"));
      await expect(queued).rejects.toThrow(
        "Harness could not confirm this conversation's session ended",
      );
      expect(work).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });
});

describe("saved sessions under holds", () => {
  const CLOSES = {
    mcpCapabilities: { http: true },
    sessionCapabilities: { close: {} },
  };
  const deferred = <T = void>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  const sessionsWith = (
    saved = new Map<string, SavedConversation>(),
    hold = false,
  ) => {
    const harness = fakeHarness({ capabilities: CLOSES, hold });
    const acp = start(harness);
    const sessions = new AgentSessions({
      label: "Harness",
      resolveDirectory: async (path) => path,
      tools,
      process: { get: () => acp },
      launch: async () => ({ workspace: "/work", systemPrompt: "" }),
      choice: () => ({ provider: "", model: "" }),
      fingerprint: () => "",
      store: {
        get: (key) => saved.get(key),
        set: (key, value) => saved.set(key, value),
      },
    });
    return { sessions, saved, harness };
  };
  /** What held work is given for `key`, taking nothing. */
  const read = (sessions: AgentSessions, key = "chat") =>
    sessions.exclusive(key, async (held) => ({
      saved: held.saved,
      reset: held.reset,
      binding: held.binding,
    }));

  it("reads what held work saved only with the session it saved it with", () => {
    const at = 1;
    expect(association(undefined)).toBeUndefined();
    expect(association({ at, sessions: ["s1"] })).toBeUndefined();
    expect(
      association({
        at,
        sessions: ["s1"],
        binding: { session: "s1", value: { v: 1 } },
      }),
    ).toEqual({ value: { v: 1 } });
    // A value that can't be read is still that session's: never none.
    expect(
      association({
        at,
        sessions: ["s1"],
        binding: { session: "s1", value: null },
      }),
    ).toEqual({ value: null });
    expect(
      association({
        at,
        sessions: ["s2", "s1"],
        binding: { session: "s1", value: 1 },
      }),
    ).toBeUndefined();
    for (const binding of [
      null,
      "s1",
      ["s1", 1],
      {},
      { session: "s1" },
      { value: 1 },
      { session: "s1", value: 1, extra: 1 },
      { session: 1, value: 1 },
      { session: "", value: 1 },
      { session: "s".repeat(257), value: 1 },
    ])
      expect(association({ at, sessions: ["s1"], binding })).toBe("malformed");
  });

  it("reads what is stored raw, however damaged, and the reset marker only as written", () => {
    const binding = { session: 7, junk: [1] };
    const read = savedConversation({
      at: 1,
      sessions: ["s1"],
      binding,
      next: "new",
    });
    expect(read).toEqual({ at: 1, sessions: ["s1"], binding, next: "new" });
    expect(read?.binding).toBe(binding);
    expect(savedConversation({ at: 1, binding: null })).toEqual({
      at: 1,
      binding: null,
    });
    expect(savedConversation({ at: 1, next: "other" })).toEqual({ at: 1 });
  });

  it("gives a forwarded session's value back, but a fresh one after an ordinary session replaced it", async () => {
    const { sessions, saved } = sessionsWith();
    await sessions.exclusive("chat", async ({ keep }) => {
      expect(keep("g1", { b: "B" })).toBe(true);
    });
    expect(await read(sessions)).toEqual({
      saved: "g1",
      reset: false,
      binding: { value: { b: "B" } },
    });
    await expect(
      sessions.deliver("chat", "ordinary", 1),
    ).resolves.toMatchObject({ ok: true });
    const ordinary = saved.get("chat")?.sessions?.[0];
    expect(ordinary).not.toBe("g1");
    expect(saved.get("chat")?.binding).toEqual({
      session: "g1",
      value: { b: "B" },
    });
    expect(await read(sessions)).toEqual({
      saved: ordinary,
      reset: false,
      binding: undefined,
    });
  });

  it("gives the same value back after a reload, whatever its turn did", async () => {
    const saved = new Map<string, SavedConversation>();
    const first = sessionsWith(saved).sessions;
    await expect(
      first.exclusive("chat", async ({ keep }) => {
        expect(keep("g1", { b: "B" })).toBe(true);
        throw new Error("the prompt failed");
      }),
    ).rejects.toThrow("the prompt failed");
    first.dispose();
    const reloaded = sessionsWith(
      new Map(JSON.parse(JSON.stringify([...saved]))),
    ).sessions;
    expect(await read(reloaded)).toEqual({
      saved: "g1",
      reset: false,
      binding: { value: { b: "B" } },
    });
  });

  it("does not count a session as saved unless the store reads it back", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sessions, saved } = sessionsWith();
      const set = vi.spyOn(saved, "set");
      set.mockImplementationOnce(() => saved);
      set.mockImplementationOnce(() => {
        throw new Error("quota");
      });
      await sessions.exclusive("chat", async ({ keep }) => {
        expect(keep("g1", "B")).toBe(false);
        expect(keep("g1", "B")).toBe(false);
        expect(keep("g1", "B")).toBe(true);
      });
    } finally {
      warned.mockRestore();
    }
  });

  it("starts New session over, reading nothing stored, and keeps every session listed until one replaces it", async () => {
    const saved = new Map<string, SavedConversation>([
      ["chat", { at: 1, sessions: ["g1", "g0"], binding: { session: 7 } }],
    ]);
    const { sessions } = sessionsWith(saved);
    expect((await read(sessions)).binding).toBe("malformed");
    await expect(sessions.reset("chat", "new")).resolves.toEqual({ ok: true });
    expect(saved.get("chat")).toEqual({
      at: 1,
      sessions: ["g1", "g0"],
      binding: { session: 7 },
      next: "new",
    });
    expect(await read(sessions)).toEqual({
      saved: undefined,
      reset: true,
      binding: undefined,
    });
    // A replacement that fails to start keeps it all.
    await expect(
      sessions.exclusive("chat", async () => {
        throw new Error("could not start");
      }),
    ).rejects.toThrow("could not start");
    expect(saved.get("chat")?.next).toBe("new");
    await sessions.exclusive("chat", async ({ keep }) => {
      expect(keep("g2", "C")).toBe(true);
    });
    expect(saved.get("chat")).toMatchObject({
      sessions: ["g2", "g1", "g0"],
      binding: { session: "g2", value: "C" },
    });
    expect(saved.get("chat")).not.toHaveProperty("next");
  });

  it("keeps the open session when New session cannot be saved", async () => {
    // A store that keeps the old record once frozen.
    let frozen = false;
    const saved = new (class extends Map<string, SavedConversation> {
      override set(key: string, value: SavedConversation) {
        if (!frozen) super.set(key, value);
        return this;
      }
    })();
    const { sessions, harness } = sessionsWith(saved);
    await expect(sessions.deliver("chat", "first", 1)).resolves.toMatchObject({
      ok: true,
    });
    frozen = true;
    await expect(sessions.reset("chat", "new")).resolves.toEqual({
      ok: false,
      error: "Harness could not save New session",
    });
    // Nothing was closed: the next message runs in the same session.
    expect(harness.sent("session/close")).toEqual([]);
    await expect(sessions.deliver("chat", "again", 2)).resolves.toMatchObject({
      ok: true,
    });
    expect(harness.sent("session/new")).toHaveLength(1);
    expect(harness.turns.map((turn) => turn.text)).toEqual(["first", "again"]);
  });

  it("lets an ordinary session that replaces the newest end New session, and nothing else", async () => {
    const saved = new Map<string, SavedConversation>([
      [
        "chat",
        { at: 1, sessions: ["g1"], binding: { session: "g1", value: "B" } },
      ],
    ]);
    const { sessions } = sessionsWith(saved);
    await sessions.reset("chat", "new");
    await expect(
      sessions.deliver("chat", "ordinary", 1),
    ).resolves.toMatchObject({ ok: true });
    const record = saved.get("chat");
    expect(record?.sessions?.[1]).toBe("g1");
    expect(record).not.toHaveProperty("next");
    expect(record?.binding).toEqual({ session: "g1", value: "B" });
  });

  it("refuses New session, writing nothing, once a left-running session could not be confirmed ended", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const saved = new Map<string, SavedConversation>();
      const { sessions } = sessionsWith(saved);
      const exited = deferred<number | null>();
      await sessions.exclusive("chat", async ({ keep, outlives }) => {
        keep("g1", "B");
        outlives(exited.promise);
      });
      exited.reject(new Error("exit unobservable"));
      await flush();
      const before = saved.get("chat");
      await expect(sessions.reset("chat", "new")).resolves.toEqual({
        ok: false,
        error: "Harness could not confirm this conversation's session ended",
      });
      expect(saved.get("chat")).toBe(before);
    } finally {
      warned.mockRestore();
    }
  });

  it("waits for a held turn before New session marks the conversation", async () => {
    const saved = new Map<string, SavedConversation>();
    const { sessions } = sessionsWith(saved);
    const working = deferred();
    const turn = sessions.exclusive("chat", async ({ keep }) => {
      await working.promise;
      keep("g1", "B");
    });
    await flush();
    const resetting = sessions.reset("chat", "new");
    await flush();
    expect(saved.get("chat")).toBeUndefined();
    working.resolve();
    await turn;
    await expect(resetting).resolves.toEqual({ ok: true });
    expect(saved.get("chat")?.next).toBe("new");
  });

  it("does nothing more once New session or compaction is interrupted while it waits for the turn", async () => {
    for (const action of ["new", "compact"] as const) {
      const saved = new Map<string, SavedConversation>();
      const { sessions, harness } = sessionsWith(saved, true);
      const forwarded = vi.fn(
        async (_held: Exclusive) => ({ ok: true }) as const,
      );
      const delivered = sessions.deliver("chat", "one", 1);
      while (!harness.turns.length) await flush();
      // This harness confirms delivery when it finishes the prompt.
      expect(saved.has("chat")).toBe(false);
      const resetting = sessions.reset("chat", action, forwarded);
      await flush();
      await sessions.interrupt("chat");
      harness.turns[0]?.finish();
      await delivered;
      await expect(resetting).resolves.toEqual({
        ok: false,
        error: "Harness was stopped",
      });
      expect(saved.get("chat")).toEqual({
        at: expect.any(Number),
        sessions: [harness.turns[0]?.sessionId],
      });
      expect(forwarded).not.toHaveBeenCalled();
      expect(harness.turns.map((turn) => turn.text)).toEqual(["one"]);
      // The session it waited on is still the conversation's.
      const again = sessions.deliver("chat", "two", 2);
      while (harness.turns.length < 2) await flush();
      harness.turns[1]?.finish();
      await again;
      expect(harness.turns.map((turn) => turn.sessionId)).toEqual([
        harness.turns[0]?.sessionId,
        harness.turns[0]?.sessionId,
      ]);
      expect(harness.sent("session/new")).toHaveLength(1);
    }
  });

  it("refuses to keep no value at all, writing nothing", async () => {
    const saved = new Map<string, SavedConversation>();
    const { sessions } = sessionsWith(saved);
    await sessions.exclusive("chat", async ({ keep }) => {
      expect(keep("g1", undefined)).toBe(false);
    });
    expect(saved.get("chat")).toBeUndefined();
  });

  it("chooses compaction under the hold: the open session, a forwarded one, or nothing", async () => {
    const saved = new Map<string, SavedConversation>();
    const { sessions } = sessionsWith(saved);
    const forwarded = vi.fn(
      async (_held: Exclusive) => ({ ok: true }) as const,
    );
    // Nothing saved: nothing to do.
    await expect(sessions.reset("chat", "compact", forwarded)).resolves.toEqual(
      {
        ok: true,
      },
    );
    expect(forwarded).not.toHaveBeenCalled();
    await sessions.exclusive("chat", async ({ keep }) => {
      keep("g1", "B");
    });
    await expect(sessions.reset("chat", "compact", forwarded)).resolves.toEqual(
      {
        ok: true,
      },
    );
    expect(forwarded).toHaveBeenCalledOnce();
    expect(forwarded.mock.calls[0]?.[0]).toMatchObject({
      saved: "g1",
      binding: { value: "B" },
    });
    // Damage goes to the forwarded path, which refuses it, never to nothing.
    saved.set("chat", { at: 1, sessions: ["g1"], binding: { session: 7 } });
    await sessions.reset("chat", "compact", forwarded);
    expect(forwarded.mock.calls[1]?.[0]).toMatchObject({
      binding: "malformed",
    });
    // After New session there is nothing to compact.
    await sessions.reset("chat", "new");
    await sessions.reset("chat", "compact", forwarded);
    expect(forwarded).toHaveBeenCalledTimes(2);
  });
});
