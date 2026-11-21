// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Generation,
  UNREACHED,
} from "../../features/agents/gateway/forwarding";
import type { ForwardChildRegistered } from "../../features/host/forward";
import {
  type ForwardedTurn,
  forwardedEnv,
  forwardedTurn,
  GATEWAY_TOKEN,
  NOT_CLOSED,
  NOT_KEPT,
  NOT_STOPPED,
} from "./forwarded";
import { GooseProcess, type ToolServer } from "./goose";
import { fakeSpawn, flush } from "./goose-testing";

const CHANGED = "The route changed";
const tools: ToolServer = async (_conversation, message) => ({
  jsonrpc: "2.0",
  id: message.id,
  result: {},
});
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

/** A generation native opened, recording what the turn asks of it. */
function generation(
  closes: () => Promise<void> = async () => undefined,
  registers: () => Promise<ForwardChildRegistered> = async () => ({
    type: "registered",
  }),
  admitted = true,
) {
  const calls: string[] = [];
  let revoked = false;
  let revoke!: () => void;
  const revocation = new Promise<void>((resolve) => (revoke = resolve));
  const value: Generation = {
    url: "http://127.0.0.1:4100/g1",
    revision: 1,
    isSealed: () => false,
    admitted: () => admitted,
    noProxy: "corp.example,127.0.0.1,localhost",
    seal: () => void calls.push("seal"),
    close: vi.fn(() => {
      calls.push("close");
      return closes();
    }),
    revoked: revocation,
    isRevoked: () => revoked,
    associate: async (session) => void calls.push(`associate ${session}`),
    registerChild: vi.fn(async (call: string, child: string) => {
      calls.push(`register ${call} ${child}`);
      return registers();
    }),
  };
  return {
    value,
    calls,
    revoke: () => {
      revoked = true;
      revoke();
    },
  };
}

/** A forwarded turn on a fake goose: what it ran, and its retirement. */
function setup(
  options: Parameters<typeof fakeSpawn>[0] = {},
  turn: Partial<ForwardedTurn> = {},
  native = generation(),
) {
  const fake = fakeSpawn({ load: true, ...options });
  const controller = new AbortController();
  const retirements: Promise<void>[] = [];
  const exits: Promise<void>[] = [];
  const kept: string[] = [];
  const order = native.calls;
  const run = (changes: Partial<ForwardedTurn> = {}) =>
    forwardedTurn(
      {
        open: async () => native.value,
        start: (env, onProcess) =>
          GooseProcess.start(fake.spawn, {
            cwd: "/work",
            env,
            serve: fake.serve,
            onProcess,
          }),
        launch: async () => ({ cwd: "/work", systemPrompt: "prompt" }),
        tools,
        provider: "databricks",
        choice: () => ({ provider: "databricks", model: "" }),
        conversation: "chat",
        prompt: async (fresh) => {
          order.push(`prompt ${fresh}`);
          return "hello";
        },
        keep: (session) => {
          order.push(`keep ${session}`);
          kept.push(session);
          return true;
        },
        outlives: (retired, exited) => {
          retirements.push(retired);
          exits.push(exited);
        },
        signal: controller.signal,
        ...turn,
        ...changes,
      },
      CHANGED,
    );
  return { fake, controller, retirements, exits, kept, native, order, run };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a forwarded goose turn", () => {
  it("runs one prompt in a new session of its own goose on the generation, then retires both in order", async () => {
    const started = vi.fn();
    const { fake, native, order, retirements, run } = setup({}, { started });
    await expect(run()).resolves.toMatchObject({ ok: true });
    // A new session's prompt is recorded once it is kept.
    expect(started).toHaveBeenCalledExactlyOnceWith("session-1");
    const [goose] = fake.geese;
    expect(fake.geese).toHaveLength(1);
    expect(goose?.env).toMatchObject({
      DATABRICKS_HOST: "http://127.0.0.1:4100/g1",
      // The fixed bearer, never a token of the owner's.
      DATABRICKS_TOKEN: GATEWAY_TOKEN,
      NO_PROXY: "corp.example,127.0.0.1,localhost",
      no_proxy: "corp.example,127.0.0.1,localhost",
      GOOSE_DISABLE_SESSION_NAMING: "true",
      // A delegate stays on the gateway's provider.
      GOOSE_SUBAGENT_PROVIDER: "databricks",
    });
    // On the provider's default model, a delegate takes the parent's.
    expect(goose?.env).not.toHaveProperty("GOOSE_SUBAGENT_MODEL");
    expect(goose?.opened).toHaveLength(1);
    expect(goose?.turns.map((turn) => turn.text)).toEqual(["hello"]);
    // Saved and named before its prompt; closed only after its exit.
    expect(order).toEqual([
      "keep session-1",
      "associate session-1",
      "prompt true",
      "seal",
      "close",
    ]);
    expect(goose?.closed).toEqual(["session-1"]);
    expect(goose?.killed).toBe(true);
    expect(retirements).toHaveLength(1);
    await expect(retirements[0]).resolves.toBeUndefined();
    expect(native.value.close).toHaveBeenCalledOnce();
  });

  it("leads a sent turn's failure with UNREACHED only when no model request was admitted", async () => {
    for (const admitted of [false, true]) {
      const native = generation(undefined, undefined, admitted);
      const { fake, run } = setup({ hold: true }, {}, native);
      const turn = run();
      while (!fake.geese[0]?.turns.length) await flush();
      fake.geese[0]?.turns[0]?.finish("refusal");
      await expect(turn).resolves.toEqual({
        ok: false,
        error: admitted
          ? "goose refused the request"
          : `${UNREACHED} goose refused the request`,
      });
    }
    // A turn that never prompted had nothing to admit.
    const { run } = setup(
      {},
      { keep: () => false },
      generation(undefined, undefined, false),
    );
    await expect(run()).resolves.toEqual({ ok: false, error: NOT_KEPT });
  });

  it("gives every forwarded goose the same fixed, nonsecret bearer", async () => {
    const { fake, run } = setup();
    await expect(run()).resolves.toMatchObject({ ok: true });
    await expect(run({ model: "m-turn" })).resolves.toMatchObject({ ok: true });
    expect(fake.geese.map((goose) => goose.env.DATABRICKS_TOKEN)).toEqual([
      GATEWAY_TOKEN,
      GATEWAY_TOKEN,
    ]);
    // Set beside the generation, it is what the process's environment
    // holds whatever the app's own carries.
    expect(
      forwardedEnv(
        { url: "http://127.0.0.1:4100/g9", noProxy: "127.0.0.1,localhost" },
        {
          provider: "databricks",
          choice: () => ({ provider: "databricks", model: "" }),
        },
      ),
    ).toMatchObject({
      DATABRICKS_HOST: "http://127.0.0.1:4100/g9",
      DATABRICKS_TOKEN: GATEWAY_TOKEN,
    });
    expect(GATEWAY_TOKEN).toBe("buzz-agent-gateway-placeholder");
  });

  it("pins a delegate's model to the turn's, else the agent's", async () => {
    const choice = () => ({ provider: "databricks", model: "m-agent" });
    const { fake, run } = setup({}, { choice });
    await expect(run()).resolves.toMatchObject({ ok: true });
    await expect(run({ model: "m-turn" })).resolves.toMatchObject({ ok: true });
    expect(fake.geese.map((goose) => goose.env)).toEqual([
      expect.objectContaining({
        GOOSE_SUBAGENT_PROVIDER: "databricks",
        GOOSE_SUBAGENT_MODEL: "m-agent",
      }),
      expect.objectContaining({
        GOOSE_SUBAGENT_PROVIDER: "databricks",
        GOOSE_SUBAGENT_MODEL: "m-turn",
      }),
    ]);
  });

  it("pins a delegate to the gateway's provider when the agent inherits goose's default", async () => {
    const { fake, run } = setup(
      {},
      { choice: () => ({ provider: "", model: "" }) },
    );
    await expect(run()).resolves.toMatchObject({ ok: true });
    expect(fake.geese[0]?.env).toMatchObject({
      GOOSE_SUBAGENT_PROVIDER: "databricks",
    });
  });

  it("resumes the saved session it is given, never a new one", async () => {
    const started = vi.fn();
    const { fake, order, run } = setup(
      { providers: [{ providerId: "databricks", defaultModel: "db-default" }] },
      { load: "s-saved", started },
    );
    await expect(run()).resolves.toMatchObject({ ok: true });
    const [goose] = fake.geese;
    expect(goose?.loaded).toEqual(["s-saved"]);
    // A resumed session's prompt was recorded when it was new.
    expect(started).not.toHaveBeenCalled();
    expect(goose?.opened).toEqual([]);
    // Put back on the gateway's provider, whatever it was saved with.
    expect(goose?.configured).toEqual([
      "s-saved provider=databricks",
      "s-saved model=db-default",
    ]);
    expect(goose?.prompts.get("s-saved")).toBe("prompt");
    expect(order.slice(0, 3)).toEqual([
      "keep s-saved",
      "associate s-saved",
      "prompt false",
    ]);
  });

  it("puts a resumed session with no pick back on its provider's default model, whatever it was saved on", async () => {
    const { fake, run } = setup(
      { providers: [{ providerId: "databricks", defaultModel: "db-default" }] },
      { load: "s-saved" },
    );
    await expect(run()).resolves.toMatchObject({ ok: true });
    // goose keeps a saved model when its provider is set again unchanged.
    expect(fake.geese[0]?.configured).toEqual([
      "s-saved provider=databricks",
      "s-saved model=db-default",
    ]);
    // A pick, or goose's own default provider, needs no second switch.
    await expect(run({ model: "m-turn" })).resolves.toMatchObject({ ok: true });
    await expect(
      run({ choice: () => ({ provider: "", model: "" }) }),
    ).resolves.toMatchObject({ ok: true });
    expect(fake.geese.slice(1).map((goose) => goose.configured)).toEqual([
      ["s-saved provider=databricks", "s-saved model=m-turn"],
      ["s-saved provider=goose"],
    ]);
  });

  it("fails a resumed turn goose can't put back on its provider, prompting nothing", async () => {
    const { fake, native, run } = setup({}, { load: "s-saved" });
    const result = await run({
      launch: async () => {
        const [goose] = fake.geese;
        if (goose) goose.configError = "Unknown provider";
        return { cwd: "/work", systemPrompt: "prompt" };
      },
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("goose could not switch its provider");
    expect(fake.geese[0]?.turns).toEqual([]);
    expect(native.calls.slice(-2)).toEqual(["seal", "close"]);
  });

  it("fails a session goose can't resume, prompting nothing, and still retires", async () => {
    const { fake, native, order, run } = setup({}, { load: "s-saved" });
    const turn = run();
    await flush();
    const [goose] = fake.geese;
    if (goose) goose.loadError = "Session not found";
    await expect(turn).resolves.toEqual({
      ok: false,
      error: "Session not found",
    });
    expect(goose?.opened).toEqual([]);
    expect(goose?.turns).toEqual([]);
    expect(goose?.killed).toBe(true);
    expect(order).toEqual(["seal", "close"]);
    expect(native.value.close).toHaveBeenCalledOnce();
  });

  it("refuses to prompt a session it could not save, recording no prompt", async () => {
    const started = vi.fn();
    const { fake, order, run } = setup(
      {},
      {
        keep: () => false,
        started,
      },
    );
    await expect(run()).resolves.toEqual({ ok: false, error: NOT_KEPT });
    expect(started).not.toHaveBeenCalled();
    expect(fake.geese[0]?.turns).toEqual([]);
    expect(order).toEqual(["seal", "close"]);
  });

  it("starts nothing when the generation can't open, and is cancelled when it was aborted", async () => {
    const { fake, controller, run } = setup();
    await expect(
      run({
        open: async () => {
          throw new Error("Buzz couldn't start forwarding");
        },
      }),
    ).resolves.toEqual({ ok: false, error: "Buzz couldn't start forwarding" });
    controller.abort();
    await expect(
      run({
        open: async () => {
          throw new Error("aborted");
        },
      }),
    ).resolves.toEqual({ ok: true, undelivered: true });
    expect(fake.geese).toEqual([]);
  });

  it("closes the generation once a goose that could not start has exited", async () => {
    const { fake, native, order, retirements, run } = setup({ http: false });
    await expect(run()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("no HTTP MCP support"),
    });
    expect(fake.geese).toHaveLength(1);
    expect(order).toEqual(["seal", "close"]);
    expect(retirements).toHaveLength(1);
    expect(native.value.close).toHaveBeenCalledOnce();
  });

  it("stops a goose that comes up after the turn was cancelled, closing the generation only once it exits", async () => {
    const spawned = deferred();
    // A goose that never answers is stopped, not waited on.
    const { fake, controller, native, run } = setup({ silent: ["initialize"] });
    const spawn = fake.spawn;
    const turn = run({
      start: (env, onProcess) =>
        GooseProcess.start(
          async (id, options) => {
            await spawned.promise;
            return spawn(id, options);
          },
          { cwd: "/work", env, serve: fake.serve, onProcess },
        ),
    });
    await flush();
    controller.abort();
    await flush();
    // Nothing can be closed before the late goose is known to have exited.
    expect(native.value.close).not.toHaveBeenCalled();
    spawned.resolve();
    await expect(turn).resolves.toEqual({ ok: true, undelivered: true });
    expect(fake.geese[0]?.killed).toBe(true);
    expect(fake.geese[0]?.opened).toEqual([]);
    expect(native.value.close).toHaveBeenCalledOnce();
  });

  it("stops its prompt on interrupt, then retires", async () => {
    const { fake, controller, native, run } = setup({ hold: true });
    const turn = run();
    while (!fake.geese[0]?.turns.length) await flush();
    controller.abort();
    await expect(turn).resolves.toEqual({ ok: true, stopped: true });
    const [goose] = fake.geese;
    expect(goose?.cancelled).toContain("session-1");
    expect(goose?.closed).toEqual(["session-1"]);
    expect(goose?.killed).toBe(true);
    expect(native.value.close).toHaveBeenCalledOnce();
  });

  it("fails with the route change when the generation is revoked mid-prompt, whatever the prompt then says", async () => {
    const native = generation();
    const { fake, controller, run } = setup({ hold: true }, {}, native);
    const turn = run();
    while (!fake.geese[0]?.turns.length) await flush();
    native.revoke();
    await flush();
    // The interrupt its route change causes counts as no cancel.
    controller.abort();
    await expect(turn).resolves.toEqual({ ok: false, error: CHANGED });
    expect(fake.geese[0]?.killed).toBe(true);
    expect(native.value.close).toHaveBeenCalledOnce();
  });

  it("fails a turn whose delegated child could not be registered, and waits for a registration before succeeding", async () => {
    const answer = deferred<ForwardChildRegistered>();
    const native = generation(undefined, () => answer.promise);
    const { fake, run } = setup({ hold: true }, {}, native);
    const turn = run();
    while (!fake.geese[0]?.turns.length) await flush();
    const [goose] = fake.geese;
    goose?.update("session-1", {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "delegate · reviewer",
      _meta: { goose: { toolCall: { toolName: "delegate" } } },
    });
    goose?.update("session-1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      _meta: { goose: { subagentSessionId: "child-1" } },
    });
    await flush();
    goose?.turns[0]?.finish();
    await flush(30);
    // The prompt has ended; its registration has not been answered.
    expect(native.value.registerChild).toHaveBeenCalledWith(
      "call-1",
      "child-1",
    );
    expect(native.value.close).not.toHaveBeenCalled();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    answer.resolve({ type: "refused", reason: "child_cap" });
    await expect(turn).resolves.toEqual({ ok: false, error: "child_cap" });
    expect(warned).toHaveBeenCalled();
  });

  it("ends an interrupt during a pending registration, retiring the goose", async () => {
    const native = generation(undefined, () => new Promise(() => {}));
    const { fake, controller, run } = setup({ hold: true }, {}, native);
    const turn = run();
    while (!fake.geese[0]?.turns.length) await flush();
    const [goose] = fake.geese;
    goose?.update("session-1", {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "delegate · reviewer",
      _meta: { goose: { toolCall: { toolName: "delegate" } } },
    });
    goose?.update("session-1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      _meta: { goose: { subagentSessionId: "child-1" } },
    });
    await flush();
    goose?.turns[0]?.finish();
    await flush(30);
    controller.abort();
    await expect(turn).resolves.toEqual({ ok: true, stopped: true });
    expect(goose?.killed).toBe(true);
    expect(native.value.close).toHaveBeenCalledOnce();
  });

  it("fails visibly, keeping the generation open, while its goose has not exited", async () => {
    vi.useFakeTimers();
    try {
      const { fake, native, retirements, run } = setup();
      const turn = run({
        start: (env, onProcess) =>
          GooseProcess.start(fake.spawn, {
            cwd: "/work",
            env,
            serve: fake.serve,
            onProcess: (started) => {
              const [goose] = fake.geese;
              if (goose) goose.holdExit = true;
              onProcess(started);
            },
          }),
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const [goose] = fake.geese;
      await expect(turn).resolves.toEqual({ ok: false, error: NOT_STOPPED });
      expect(native.value.close).not.toHaveBeenCalled();
      // The conversation waits on its exit, then native's close.
      let retired = false;
      void retirements[0]?.then(() => (retired = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(retired).toBe(false);
      goose?.exit(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(native.value.close).toHaveBeenCalledOnce();
      expect(retired).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a turn that ran when native could not close its generation", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = new Error("close refused");
    const native = generation(() => Promise.reject(refused));
    const { fake, retirements, exits, run } = setup({}, {}, native);
    await expect(run()).resolves.toEqual({ ok: false, error: NOT_CLOSED });
    expect(fake.geese[0]?.turns).toHaveLength(1);
    // Its retirement fails too: nothing confirms the generation ended. Its
    // process did exit, so the conversation is free.
    await expect(retirements[0]).rejects.toBe(refused);
    await expect(exits[0]).resolves.toBeUndefined();
    expect(warned).toHaveBeenCalled();
  });
});
