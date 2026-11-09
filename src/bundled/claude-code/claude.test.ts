import { describe, expect, it, vi } from "vitest";
import { appClient } from "../../buzz-mcp/app-client";
import type { OwnerAccess } from "../../buzz-mcp/client";
import { callSessionTool } from "../../buzz-mcp/session-tools";
import type { AgentHandle } from "../../features/agents/service";
import { ClaudeProcess, stepLabel } from "./claude";
import {
  backgroundTasks,
  fakeSpawn,
  flush,
  sessionState,
} from "./claude-testing";

const launch = {
  cwd: "~/.buzz",
  systemPrompt: "<base>be useful</base>",
};

it("starts Claude as the SDK does and initializes it with the system prompt", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    model: "opus",
    effort: "high",
    sessionId: "new-session",
  });
  const [fake] = processes;
  expect(fake?.options.args).toEqual([
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--thinking-display",
    "summarized",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    "opus",
    "--effort",
    "high",
    "--session-id",
    "new-session",
  ]);
  expect(fake?.options).toMatchObject({
    cwd: "~/.buzz",
    env: {
      CLAUDECODE: null,
      CLAUDE_CODE_SESSION_ID: null,
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
    },
  });
  expect(fake?.received[0]).toMatchObject({
    type: "control_request",
    request: { subtype: "initialize", appendSystemPrompt: launch.systemPrompt },
  });
  expect(claude.sessionId).toBe("new-session");
  expect(claude.started).toBe(false);
});

it("lets its Buzz credential act as its agent before it initializes", async () => {
  const { spawn, processes } = fakeSpawn();
  const agent = { pubkey: "ab".repeat(32), relay: "wss://relay.example" };
  await ClaudeProcess.start(spawn, { ...launch, agent });
  const [fake] = processes;
  expect(fake?.options.agentCredential).toBe(true);
  expect(fake?.actedAs).toEqual([agent]);
  expect(fake?.received[0]).toMatchObject({
    request: { subtype: "initialize" },
  });
});

it("fails to start, and stops, when its credential cannot act as its agent", async () => {
  const { spawn, processes } = fakeSpawn();
  await expect(
    ClaudeProcess.start(
      async (id, options) => ({
        ...(await spawn(id, options)),
        actAs: async () => {
          throw new Error("revoked");
        },
      }),
      { ...launch, agent: { pubkey: "ab".repeat(32), relay: "wss://r" } },
    ),
  ).rejects.toThrow("revoked");
  expect(processes[0]?.killed).toBe(true);
  expect(processes[0]?.received).toEqual([]);
});

it("asks no credential for a discovery probe", async () => {
  const { spawn, processes } = fakeSpawn();
  await ClaudeProcess.start(spawn, { ...launch, discovery: true });
  expect(processes[0]?.options.agentCredential).toBe(false);
});

it("resolves a message once the session is idle, and keeps the process for the next", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
  });
  await expect(claude.send("hello")).resolves.toEqual({ ok: true });
  expect(claude.started).toBe(true);
  expect(claude.busy).toBe(false);
  await expect(claude.send("again")).resolves.toEqual({ ok: true });
  expect(processes).toHaveLength(1);
  expect(processes[0]?.prompts).toEqual(["hello", "again"]);
});

it("is active in a turn of its own or with background work, but not for ambient tasks", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
  });
  await claude.send("start a build");
  const quiet = vi.fn();
  claude.onQuiet = quiet;
  const [fake] = processes;
  expect(claude.active).toBe(false);
  backgroundTasks(fake, { ambient: true });
  expect(claude.active).toBe(false);
  backgroundTasks(fake, { ambient: true }, {});
  expect(claude.active).toBe(true);
  backgroundTasks(fake);
  expect(claude.active).toBe(false);
  sessionState(fake, "running");
  expect(claude.active).toBe(true);
  expect(claude.busy).toBe(false);
  await claude.interrupt();
  if (!fake) throw new Error("Expected Claude process");
  expect(interrupts(fake)).toHaveLength(1);
  sessionState(fake, "idle");
  expect(claude.active).toBe(false);
  expect(quiet).toHaveBeenCalledTimes(2);
  fake.hold = true;
  const later = claude.send("later");
  await flush();
  fake.finish({ error: "Provider failed" });
  await expect(later).resolves.toEqual({ ok: false, error: "Provider failed" });
});

it("answers both messages of a turn that took a second one mid-way", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
  });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  fake.hold = true;
  const first = claude.send("first");
  const second = claude.send("second");
  expect(claude.busy).toBe(true);
  let done = false;
  void first.then(() => {
    done = true;
  });
  await flush();
  expect(done).toBe(false);
  fake.finish();
  await expect(first).resolves.toEqual({ ok: true });
  await expect(second).resolves.toEqual({ ok: true });
});

it("runs a turn at the effort asked for, and the next without one at the session's own", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
  });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  await claude.send("plain");
  expect(fake.received.map((message) => message.type)).toEqual([
    "control_request",
    "user",
  ]);
  await claude.send("hard", { effort: "xhigh" });
  fake.hold = true;
  const quick = claude.send("quick", { effort: "low" });
  // Folded into the running turn, a message without an effort keeps it.
  const steer = claude.send("also");
  await flush();
  fake.finish();
  await Promise.all([quick, steer]);
  fake.hold = false;
  await claude.send("after");
  expect(fake.prompts).toEqual(["plain", "hard", "quick", "also", "after"]);
  expect(fake.efforts).toEqual(["high", "xhigh", "low", "low", "high"]);
  // The session's own level is read once, before the first change.
  expect(
    fake.received.filter(
      (message) =>
        (message.request as { subtype?: string } | undefined)?.subtype ===
        "get_settings",
    ),
  ).toHaveLength(1);
});

it("runs a turn on the model asked for, and the next without one on the session's own", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    model: "opus",
    sessionId: "s1",
  });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  await expect(claude.models()).resolves.toEqual(
    expect.arrayContaining([expect.objectContaining({ value: "haiku" })]),
  );
  await claude.send("plain");
  fake.hold = true;
  const quick = claude.send("quick", { model: "haiku" });
  // Folded into the running turn, a message without a model keeps it.
  const steer = claude.send("also");
  await flush();
  fake.finish();
  await Promise.all([quick, steer]);
  fake.hold = false;
  await claude.send("after");
  expect(fake.models).toEqual(["opus", "haiku", "haiku", "opus"]);
  // The session reports its own model, not the picked one.
  await expect(claude.readModel()).resolves.toBe("claude-opus-5-5");
  expect(
    fake.received
      .map((message) => message.request as { subtype?: string; model?: string })
      .filter((request) => request?.subtype === "set_model")
      .map((request) => request.model),
  ).toEqual(["haiku", "opus"]);
});

it("moves activity only when the exact follow-up is acknowledged, without ending the turn", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
  });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  fake.hold = true;
  // Hold acknowledgment explicitly, independently from turn completion.
  const emit = fake.emit;
  fake.emit = (message) => {
    if (message.isReplay !== true) emit(message);
  };
  const first = { step: vi.fn(), acknowledged: vi.fn(), superseded: vi.fn() };
  const second = { step: vi.fn(), acknowledged: vi.fn(), superseded: vi.fn() };
  const sent = claude.send("same text", first);
  const a = fake.received.find((m) => m.type === "user");
  if (!a) throw new Error("Expected first request");
  const tool = (name: string) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input: {} }] },
  });
  emit({ ...a, isReplay: true });
  expect(first.acknowledged).toHaveBeenCalledOnce();
  const steered = claude.send("same text", second);
  const b = fake.received.filter((m) => m.type === "user").at(-1);
  if (!b) throw new Error("Expected follow-up");
  emit(tool("Read"));
  expect(first.step).toHaveBeenLastCalledWith("Read", undefined);
  expect(second.step).not.toHaveBeenCalled();
  // Neither a tool result nor a same-text echo with an unknown id admits work.
  emit({ type: "user", uuid: b.uuid, message: { content: "tool result" } });
  emit({ ...b, uuid: "unknown", isReplay: true });
  expect(second.acknowledged).not.toHaveBeenCalled();
  emit({ ...b, isReplay: true });
  expect(first.superseded).toHaveBeenCalledOnce();
  expect(second.acknowledged).toHaveBeenCalledOnce();
  emit({ ...b, isReplay: true });
  const watched = claude.send("watched event");
  const watch = fake.received.filter((m) => m.type === "user").at(-1);
  emit({ ...watch, isReplay: true });
  emit(tool("Bash"));
  expect(first.step).not.toHaveBeenCalledWith("Bash", undefined);
  expect(second.step).toHaveBeenLastCalledWith("Bash", undefined);
  expect(first.superseded).toHaveBeenCalledOnce();
  const other = {
    step: vi.fn(),
    superseded: vi.fn(),
    activityScope: "other-thread",
  };
  const elsewhere = claude.send("other thread", other);
  const third = fake.received.filter((m) => m.type === "user").at(-1);
  emit({ ...third, isReplay: true });
  emit(tool("Grep"));
  expect(second.superseded).not.toHaveBeenCalled();
  expect(second.step).toHaveBeenLastCalledWith("Grep", undefined);
  expect(other.step).toHaveBeenLastCalledWith("Grep", undefined);
  expect(claude.busy).toBe(true);
  fake.finish();
  await watched;
  await elsewhere;
  await expect(sent).resolves.toEqual({ ok: true });
  await expect(steered).resolves.toEqual({ ok: true });
  emit(tool("Edit"));
  expect(second.step).not.toHaveBeenCalledWith("Edit", undefined);
});

it("settles on each result when Claude does not report idle", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(
    (id, options) => spawn(id, { ...options, env: {} }),
    { ...launch, sessionId: "s1" },
  );
  expect(processes[0]?.options.env).toEqual({});
  await expect(claude.send("hello")).resolves.toEqual({ ok: true });
  expect(claude.busy).toBe(false);
});

it("reports a turn that ends in an error with Claude's own words", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
  });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  fake.hold = true;
  const sent = claude.send("hello");
  await flush();
  fake.finish({ error: "Credit balance is too low" });
  await expect(sent).resolves.toEqual({
    ok: false,
    error: "Credit balance is too low",
  });
});

const interrupts = (fake: { received: Record<string, unknown>[] }) =>
  fake.received.filter(
    (message) =>
      message.type === "control_request" &&
      (message.request as { subtype?: string }).subtype === "interrupt",
  );
/** Ends the open turn as Claude does one stopped in the middle of a tool;
 * an older `claude` reports no idle. */
const abortTools = (
  fake: { emit(message: Record<string, unknown>): void },
  idle = true,
) => {
  fake.emit({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "aborted_tools",
    result: "Tool use was interrupted",
    session_id: "s1",
  });
  if (idle)
    fake.emit({
      type: "system",
      subtype: "session_state_changed",
      state: "idle",
      session_id: "s1",
    });
};

it("interrupts a running turn with a control request, and does nothing when idle", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
  });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  await claude.interrupt();
  expect(interrupts(fake)).toEqual([]);
  fake.hold = true;
  const sent = claude.send("hello");
  await flush();
  await claude.interrupt();
  expect(interrupts(fake)).toEqual([
    expect.objectContaining({ request: { subtype: "interrupt" } }),
  ]);
  fake.finish();
  await expect(sent).resolves.toEqual({ ok: true });
  await claude.interrupt();
  expect(interrupts(fake)).toHaveLength(1);
});

it("settles a stopped turn that Claude ends as aborted tools as stopped, not failed", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
  });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  fake.hold = true;
  const sent = claude.send("hello");
  await flush();
  await claude.interrupt();
  abortTools(fake);
  await expect(sent).resolves.toEqual({ ok: true, stopped: true });
  expect(claude.busy).toBe(false);
});

/** A Claude whose Buzz tools run through the real app client: `owner_channel_list`
 * holds its first read until `release`, and any other tool reads a memory.
 * With `holdStops`, Claude answers a Stop only when the test does. */
async function ownerTurns(env?: Record<string, string>) {
  const { spawn, processes } = fakeSpawn();
  const stops: string[] = [];
  let holdStops = false;
  const listing = {
    execution: { agent: "agent", owner: "owner", community: "relay" },
    channels: [
      {
        id: "c",
        name: "Owner secrets",
        type: "stream" as const,
        visibility: "private" as const,
        archived: false,
      },
    ],
    partial: false,
  };
  let release: (() => void) | undefined;
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const channels = vi.fn<OwnerAccess["channels"]>(async () => {
    if (channels.mock.calls.length === 1) {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return listing;
  });
  const ownerAccess = {
    channels,
    channel: vi.fn(),
    members: vi.fn(),
    held: vi.fn<OwnerAccess["held"]>(),
  };
  const signals: AbortSignal[] = [];
  const tools = vi.fn(
    async (_conversation: unknown, message: unknown, signal: AbortSignal) => {
      signals.push(signal);
      const { id, params } = message as {
        id: number;
        params: { name: string };
      };
      const client = appClient(
        {
          pubkey: "agent",
          key: "agent",
          ownerAccess,
        } as unknown as AgentHandle,
        {
          read: vi.fn(),
          memories: async () => ({
            entries: [{ slug: "core", body: "core notes", createdAt: 1 }],
            partial: false,
          }),
          signal,
        },
      );
      const name = params.name;
      const args = name === "mem_get" ? { slug: "core" } : {};
      return callSessionTool(client, {}, name, args).then(
        (text) => ({ jsonrpc: "2.0", id, result: { content: [{ text }] } }),
        (error: Error) => ({
          jsonrpc: "2.0",
          id,
          result: { isError: true, content: [{ text: error.message }] },
        }),
      );
    },
  );
  const claude = await ClaudeProcess.start(
    async (id, options) => {
      const process = await spawn(id, env ? { ...options, env } : options);
      return {
        ...process,
        write: async (data: string) => {
          const stop = holdStops && data.includes('"subtype":"interrupt"');
          if (!stop) return process.write(data);
          stops.push(JSON.parse(data).request_id);
        },
      };
    },
    { ...launch, sessionId: "s1", tools },
  );
  claude.conversation = "chan/root";
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  const answer = async (requestId: string) => {
    const of = (message: Record<string, unknown>) =>
      (message.response as { request_id?: string } | undefined)?.request_id ===
      requestId;
    await vi.waitFor(() => expect(fake.received.some(of)).toBe(true));
    return JSON.stringify(fake.received.find(of));
  };
  const ask = (requestId: string, name = "owner_channel_list") =>
    fake.emit({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "mcp_message",
        server_name: "buzz",
        message: {
          jsonrpc: "2.0",
          id: requestId,
          method: "tools/call",
          params: { name },
        },
      },
    });
  const answerStop = (requestId: string | undefined) =>
    fake.emit({
      type: "control_response",
      response: { subtype: "success", request_id: requestId },
    });
  return {
    claude,
    fake,
    stops,
    holdStops: () => {
      holdStops = true;
    },
    answerStop,
    ownerAccess,
    signals,
    reading,
    ask,
    answer,
    release: () => release?.(),
  };
}

it("withholds an owner read an unprotected Stop overtook, which later work cannot revive", async () => {
  const t = await ownerTurns();
  try {
    t.fake.hold = true;
    const stopped = t.claude.send("list my channels");
    await flush();
    t.ask("r1");
    await t.reading;
    await t.claude.interrupt();
    t.release();
    const refused = await t.answer("r1");
    expect(refused).toContain('"isError":true');
    expect(refused).not.toContain("Owner secrets");
    expect(t.ownerAccess.held).not.toHaveBeenCalled();
    abortTools(t.fake);
    await expect(stopped).resolves.toEqual({ ok: true, stopped: true });

    // The next message is new work; the stopped call stays stopped.
    void t.claude.send("again");
    await flush();
    t.ask("r2");
    expect(await t.answer("r2")).toContain("Owner secrets");
    expect(t.signals[0]?.aborted).toBe(true);
    expect(t.signals[1]?.aborted).toBe(false);
  } finally {
    t.release();
    t.fake.finish();
  }
});

it("answers a turn of its own after a Stop, while a call held across the Stop stays refused", async () => {
  const t = await ownerTurns();
  try {
    t.fake.hold = true;
    const stopped = t.claude.send("list my channels");
    await flush();
    t.ask("r1");
    await t.reading;
    await t.claude.interrupt();
    abortTools(t.fake);
    await expect(stopped).resolves.toEqual({ ok: true, stopped: true });

    // A finished background task starts a turn with no message from Buzz.
    sessionState(t.fake, "running");
    t.ask("r2", "mem_get");
    t.ask("r3");
    const memory = await t.answer("r2");
    expect(memory).not.toContain('"isError":true');
    expect(memory).toContain("core notes");
    expect(await t.answer("r3")).toContain("Owner secrets");

    t.release();
    const refused = await t.answer("r1");
    expect(refused).toContain('"isError":true');
    expect(refused).not.toContain("Owner secrets");
    expect(t.ownerAccess.held).toHaveBeenCalledTimes(1);
    sessionState(t.fake, "idle");
  } finally {
    t.release();
  }
});

it.each([
  ["reports idle", undefined],
  ["settles per result", {}],
])(
  "keeps a message sent while a Stop lands in the stopped turn, when Claude %s",
  async (_, env) => {
    const t = await ownerTurns(env);
    const idle = !env;
    t.fake.hold = true;
    const stopped = t.claude.send("list my channels");
    await flush();
    if (idle) sessionState(t.fake, "running");
    await t.claude.interrupt();
    const folded = t.claude.send("and my DMs");
    await flush();
    // A call the stopped turn makes late is still stopped.
    t.ask("r1", "mem_get");
    t.ask("r2");
    expect(await t.answer("r1")).toContain('"isError":true');
    expect(await t.answer("r2")).toContain('"isError":true');
    expect(t.ownerAccess.channels).not.toHaveBeenCalled();
    let settled = false;
    void stopped.then(() => {
      settled = true;
    });
    abortTools(t.fake, false);
    await flush();
    // Claude that reports idle settles there, not at the result.
    expect(settled).toBe(!idle);
    if (idle) sessionState(t.fake, "idle");
    await expect(stopped).resolves.toEqual({ ok: true, stopped: true });
    await expect(folded).resolves.toEqual({ ok: true, stopped: true });

    // The next message is new work, with ordinary and owner calls.
    const next = t.claude.send("next");
    await flush();
    t.ask("r3", "mem_get");
    t.ask("r4");
    expect(await t.answer("r3")).toContain("core notes");
    await t.reading;
    t.release();
    expect(await t.answer("r4")).toContain("Owner secrets");
    t.fake.finish();
    await expect(next).resolves.toEqual({ ok: true });
  },
);

it("stops a turn that starts while an earlier Stop awaits Claude's answer", async () => {
  const t = await ownerTurns();
  t.holdStops();
  t.fake.hold = true;
  const sent = t.claude.send("list my channels");
  await flush();
  const first = t.claude.interrupt();
  abortTools(t.fake);
  await expect(sent).resolves.toEqual({ ok: true, stopped: true });

  // Claude starts a turn of its own before answering the first Stop.
  sessionState(t.fake, "running");
  const second = t.claude.interrupt();
  expect(t.stops).toHaveLength(2);
  t.ask("r1", "mem_get");
  expect(await t.answer("r1")).toContain('"isError":true');
  t.answerStop(t.stops[0]);
  t.answerStop(t.stops[1]);
  await expect(first).resolves.toBeUndefined();
  await expect(second).resolves.toBeUndefined();
  sessionState(t.fake, "idle");
});

it("asks Claude once for Stops made together, which share its refusal", async () => {
  const t = await ownerTurns();
  t.fake.hold = true;
  t.fake.interruptError = "not now";
  const sent = t.claude.send("list my channels");
  await flush();
  const first = t.claude.interrupt();
  const second = t.claude.interrupt();
  await expect(first).rejects.toThrow("Claude did not stop: not now");
  await expect(second).rejects.toThrow("Claude did not stop: not now");
  expect(interrupts(t.fake)).toHaveLength(1);
  // Claude refused, so the turn and its calls go on.
  t.ask("r1", "mem_get");
  expect(await t.answer("r1")).toContain("core notes");
  t.fake.finish();
  await expect(sent).resolves.toEqual({ ok: true });
});

it("keeps work stopped when Claude refuses a repeated Stop", async () => {
  const t = await ownerTurns();
  t.fake.hold = true;
  const sent = t.claude.send("list my channels");
  await flush();
  await t.claude.interrupt();
  t.fake.interruptError = "already stopping";
  await expect(t.claude.interrupt()).rejects.toThrow(
    "Claude did not stop: already stopping",
  );
  t.ask("r1", "mem_get");
  expect(await t.answer("r1")).toContain('"isError":true');
  abortTools(t.fake);
  await expect(sent).resolves.toEqual({ ok: true, stopped: true });
});

it("still reports aborted tools as a failure when the owner did not stop the turn", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
  });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  fake.hold = true;
  const sent = claude.send("hello");
  await flush();
  abortTools(fake);
  await expect(sent).resolves.toEqual({
    ok: false,
    error: "Tool use was interrupted",
  });
});

it("forgets a stop once its turn ends, so a later failure is reported", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
  });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  fake.hold = true;
  const stopped = claude.send("first");
  await flush();
  await claude.interrupt();
  abortTools(fake);
  await expect(stopped).resolves.toEqual({ ok: true, stopped: true });
  const next = claude.send("second");
  await flush();
  fake.finish({ error: "Credit balance is too low" });
  await expect(next).resolves.toEqual({
    ok: false,
    error: "Credit balance is too low",
  });
});

it("does not carry a stopped turn of its own into the next message", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
  });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  sessionState(fake, "running");
  await claude.interrupt();
  abortTools(fake);
  expect(claude.active).toBe(false);
  await expect(claude.send("next")).resolves.toEqual({ ok: true });
});

it("throws when Claude refuses to stop, and reports a later real error", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
  });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  fake.hold = true;
  fake.interruptError = "not now";
  const sent = claude.send("hello");
  await flush();
  await expect(claude.interrupt()).rejects.toThrow(
    "Claude did not stop: not now",
  );
  fake.finish({ error: "Credit balance is too low" });
  await expect(sent).resolves.toEqual({
    ok: false,
    error: "Credit balance is too low",
  });
});

it("fails what is waiting when the process exits, with its last stderr line", async () => {
  const { spawn } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    resume: "gone",
  });
  expect(claude.sessionId).toBe("gone");
  await expect(claude.send("hello")).resolves.toEqual({
    ok: false,
    error: "No conversation found with session ID: gone",
  });
  expect(claude.running).toBe(false);
  expect(claude.started).toBe(false);
  await expect(claude.send("more")).resolves.toMatchObject({ ok: false });
});

it("allows tool use and acknowledges hooks it is asked about", async () => {
  const { spawn, processes } = fakeSpawn();
  await ClaudeProcess.start(spawn, { ...launch, sessionId: "s1" });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  fake.emit({
    type: "control_request",
    request_id: "r1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "ls" },
    },
  });
  fake.emit({
    type: "control_request",
    request_id: "r2",
    request: { subtype: "hook_callback", callback_id: "h" },
  });
  fake.emit({
    type: "control_request",
    request_id: "r3",
    request: { subtype: "mcp_message" },
  });
  await flush();
  const responses = fake.received
    .filter((message) => message.type === "control_response")
    .map((message) => message.response);
  expect(responses).toEqual([
    {
      subtype: "success",
      request_id: "r1",
      response: { behavior: "allow", updatedInput: { command: "ls" } },
    },
    { subtype: "success", request_id: "r2", response: {} },
    {
      subtype: "error",
      request_id: "r3",
      error: "Buzz does not handle mcp_message",
    },
  ]);
});

it("cancels a Buzz tool that is still running when its process stops", async () => {
  const { spawn, processes } = fakeSpawn();
  const signals: AbortSignal[] = [];
  const tools = vi.fn(
    (_conversation: unknown, _message: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<never>(() => {});
    },
  );
  const claude = await ClaudeProcess.start(spawn, { ...launch, tools });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  fake.emit({
    type: "control_request",
    request_id: "r1",
    request: {
      subtype: "mcp_message",
      server_name: "buzz",
      message: { jsonrpc: "2.0", id: 3, method: "tools/call" },
    },
  });
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  expect(signals[0]?.aborted).toBe(false);
  await claude.kill();
  expect(signals[0]?.aborted).toBe(true);
});

it("serves the Buzz tools over the pipe and ends a turn on a final send or subthread reply", async () => {
  const { spawn, processes } = fakeSpawn();
  const tools = vi.fn(async (_conversation: unknown, message: unknown) => ({
    jsonrpc: "2.0",
    id: (message as { id: number }).id,
    result: { content: [{ type: "text", text: "sent" }] },
  }));
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
    tools,
  });
  claude.conversation = "chan/root";
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  const config =
    fake.options.args?.[fake.options.args.indexOf("--mcp-config") + 1];
  expect(JSON.parse(config ?? "{}")).toEqual({
    // Each tool says whether it loads up front, not the server.
    mcpServers: { buzz: { type: "sdk", name: "buzz" } },
  });
  expect(fake.received[0]).toMatchObject({
    request: {
      sdkMcpServers: ["buzz"],
      hooks: {
        PostToolUse: [
          { hookCallbackIds: ["buzz:PostToolUse"] },
          {
            matcher: "mcp__buzz__(send|reply_in_subthread)",
            hookCallbackIds: ["final"],
          },
        ],
      },
    },
  });
  fake.hold = true;
  void claude.send("hi");
  const call = { jsonrpc: "2.0", id: 3, method: "tools/call" };
  fake.emit({
    type: "control_request",
    request_id: "r1",
    request: { subtype: "mcp_message", server_name: "buzz", message: call },
  });
  const hook = (final: boolean, tool = "send") => ({
    type: "control_request",
    request_id: `final-${tool}-${final}`,
    request: {
      subtype: "hook_callback",
      callback_id: "final",
      input: {
        tool_name: `mcp__buzz__${tool}`,
        tool_input: { text: "done", final },
        tool_response: [{ type: "text", text: "sent" }],
      },
    },
  });
  fake.emit(hook(false));
  fake.emit(hook(true));
  fake.emit(hook(true, "reply_in_subthread"));
  await flush();
  expect(tools).toHaveBeenCalledWith(
    "chan/root",
    call,
    expect.any(AbortSignal),
  );
  const responses = fake.received
    .filter((message) => message.type === "control_response")
    .map((message) => message.response);
  expect(responses).toEqual([
    { subtype: "success", request_id: "final-send-false", response: {} },
    {
      subtype: "success",
      request_id: "final-send-true",
      response: { continue: false },
    },
    {
      subtype: "success",
      request_id: "final-reply_in_subthread-true",
      response: { continue: false },
    },
    {
      subtype: "success",
      request_id: "r1",
      response: {
        mcp_response: {
          jsonrpc: "2.0",
          id: 3,
          result: { content: [{ type: "text", text: "sent" }] },
        },
      },
    },
  ]);
});

it("reads messages split across output chunks", async () => {
  let stdout: ((data: string) => void) | undefined;
  const claude = await ClaudeProcess.start(
    async (_id, options) => {
      stdout = options?.onStdout;
      return {
        write: async () => undefined,
        end: async () => undefined,
        kill: async () => undefined,
        exited: new Promise(() => undefined),
      };
    },
    { ...launch, sessionId: "s1" },
  );
  const line = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "s2",
  });
  stdout?.(line.slice(0, 10));
  expect(claude.started).toBe(false);
  stdout?.(`${line.slice(10)}\n`);
  expect(claude.started).toBe(true);
  expect(claude.sessionId).toBe("s2");
});

describe("stepLabel", () => {
  const msg = (content: unknown) => ({
    type: "assistant",
    message: { content },
  });
  it("names the latest tool with its target, thought or reply block", () => {
    expect(
      stepLabel(
        msg([
          { type: "tool_use", name: "Read", input: { file_path: "/a/b.txt" } },
        ]),
      ),
    ).toEqual({ tool: "Read", target: "b.txt" });
    expect(
      stepLabel(
        msg([
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "ls", description: "List files" },
          },
        ]),
      ),
    ).toEqual({ tool: "Bash", target: "List files" });
    expect(
      stepLabel(msg([{ type: "tool_use", name: "mcp__buzz__send_message" }])),
    ).toEqual({ tool: "send_message" });
    expect(stepLabel(msg([{ type: "thinking" }]))).toEqual({
      tool: "Thinking",
    });
    expect(stepLabel(msg([{ type: "text", text: "hi" }]))).toEqual({
      tool: "Writing reply",
    });
    expect(stepLabel(msg("text"))).toBeUndefined();
    expect(stepLabel({ type: "assistant" })).toBeUndefined();
  });
});

it("dispatches SDK callbacks using the process session, independent of payload claims", async () => {
  const { spawn, processes } = fakeSpawn();
  const hook = vi.fn(async () => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    },
  }));
  const process = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "owned",
    tools: async () => ({}),
    hook,
  });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  fake.emit({
    type: "control_request",
    request_id: "hook1",
    request: {
      subtype: "hook_callback",
      callback_id: "buzz:PreToolUse",
      input: { session_id: "forged", tool_name: "Bash" },
    },
  });
  await flush();
  expect(hook).toHaveBeenCalledWith("owned", "PreToolUse", {
    session_id: "forged",
    tool_name: "Bash",
  });
  expect(fake.received).toContainEqual({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "hook1",
      response: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
        },
      },
    },
  });
  await process.kill();
});
