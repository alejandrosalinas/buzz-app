import { afterEach, expect, it, vi } from "vitest";
import { fileStore, localStore } from "../../features/agents/state";
import {
  backgroundTasks,
  fakeSpawn,
  flush,
  sessionState,
} from "./claude-testing";
import type { ToolServer } from "./claude";
import {
  AgentSessions,
  IDLE_MS,
  localSessions,
  type SavedSession,
  Spare,
  type SessionStore,
} from "./sessions";

afterEach(() => {
  vi.useRealTimers();
});

const memoryStore = (): SessionStore & { all: Map<string, SavedSession> } => {
  const all = new Map<string, SavedSession>();
  return {
    all,
    get: (key) => all.get(key),
    set: (key, session) => void all.set(key, session),
    delete: (key) => void all.delete(key),
  };
};

function sessions(
  options: Partial<{
    known: Set<string>;
    strictResume: boolean;
    store: ReturnType<typeof memoryStore>;
    /** Every process keeps its turns open until finished. */
    hold: boolean;
    /** Holds each launch after it reads the settings, as a memory read does. */
    launched: Promise<void>;
    /** Holds each process's `initialize` write, as a stalled pipe would. */
    initialized: Promise<void>;
    /** The shared spare its new conversations look for. */
    spare: Spare;
    tools: ToolServer;
    started: (sessionId: string, systemPrompt: string) => void;
    agent: Readonly<{ pubkey: string; relay: string }>;
  }> = {},
) {
  const fake = fakeSpawn(options.known);
  const store = options.store ?? memoryStore();
  let model = "opus";
  let ids = 0;
  const spawn = (id: string, spawnOptions?: object) => {
    // The fake records each process as the call begins.
    const process = fake.spawn(id, spawnOptions);
    const started = fake.processes.at(-1);
    if (options.hold && started) started.hold = true;
    const { initialized } = options;
    if (!initialized) return process;
    return process.then((host) => ({
      ...host,
      write: async (data: string) => {
        if (data.includes('"subtype":"initialize"')) await initialized;
        return host.write(data);
      },
    }));
  };
  const pool = new AgentSessions({
    spawn,
    strictResume: !!options.strictResume,
    ...(options.spare ? { spare: options.spare } : {}),
    store,
    launch: async () => {
      const current = model;
      await options.launched;
      return {
        cwd: "/work",
        systemPrompt: "prompt",
        model: current,
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.agent ? { agent: options.agent } : {}),
      };
    },
    fingerprint: () => model,
    newId: () => `new-${++ids}`,
    ...(options.started ? { started: options.started } : {}),
  });
  const claudes = () =>
    fake.processes.filter((process) => process.id === "claude");
  return {
    pool,
    store,
    spawn,
    claudes,
    live: () => claudes().filter((process) => !process.killed),
    setModel: (next: string) => {
      model = next;
    },
  };
}

/** Sessions with a spare, spawned like their own processes. */
function withSpare(
  options: Parameters<typeof sessions>[0] = {},
  toolsKey?: () => string,
) {
  let ids = 0;
  let parts: ReturnType<typeof sessions> | undefined;
  const spare = new Spare(
    (id, spawnOptions) => {
      if (!parts) throw new Error("not ready");
      return parts.spawn(id, spawnOptions);
    },
    async (_conversation, message) => ({ from: "spare", message }),
    () => `spare-${++ids}`,
    toolsKey,
  );
  parts = sessions({ ...options, spare });
  return { ...parts, spare };
}

const tool = (process: { emit(message: object): void }, id: string) =>
  process.emit({
    type: "control_request",
    request_id: id,
    request: {
      subtype: "mcp_message",
      server_name: "buzz",
      message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    },
  });
const answered = (
  process: { received: Record<string, unknown>[] },
  id: string,
) =>
  process.received.find(
    (message) =>
      message.type === "control_response" &&
      (message.response as { request_id?: string }).request_id === id,
  )?.response;

it("starts a new conversation on the shared spare and warms another", async () => {
  const { pool, spare, store, claudes } = withSpare();
  spare.warm({ cwd: "/work", model: "opus" });
  await flush();
  expect(claudes()).toHaveLength(1);
  // Started before any agent asked: no prompt yet.
  expect(claudes()[0]?.received).toEqual([]);
  await expect(pool.deliver("c/root", "hello", 10)).resolves.toEqual({
    ok: true,
  });
  await flush();
  expect(claudes()).toHaveLength(2);
  const [used] = claudes();
  expect(used?.received[0]).toMatchObject({
    type: "control_request",
    request: { subtype: "initialize", appendSystemPrompt: "prompt" },
  });
  expect(used?.prompts).toEqual(["hello"]);
  expect(store.get("c/root")).toMatchObject({ id: "spare-1", seen: 10 });
  expect(pool.snapshot()).toEqual([{ key: "c/root", busy: false }]);
});

it("hands the spare's tools to the agent that takes it", async () => {
  const agentTools = vi.fn(async () => ({ from: "agent" }));
  const { pool, spare, claudes } = withSpare({ tools: agentTools });
  spare.warm({ cwd: "/work", model: "opus" });
  await flush();
  const [process] = claudes();
  if (!process) throw new Error("no spare");
  // Claude lists the tools as it starts, before any agent has the spare.
  tool(process, "early");
  await flush();
  expect(answered(process, "early")).toMatchObject({
    response: { mcp_response: { from: "spare" } },
  });
  await pool.deliver("c/root", "hi", 1);
  tool(process, "later");
  await flush();
  expect(answered(process, "later")).toMatchObject({
    response: { mcp_response: { from: "agent" } },
  });
});

it("lets the spare's Buzz credential act as the agent that takes it", async () => {
  const agent = { pubkey: "ab".repeat(32), relay: "wss://relay.example" };
  const { pool, spare, claudes } = withSpare({ agent });
  spare.warm({ cwd: "/work", model: "opus" });
  await flush();
  const [process] = claudes();
  expect(process?.options.agentCredential).toBe(true);
  // Started before any agent asked: it acts for no one yet.
  expect(process?.actedAs).toEqual([]);
  await pool.deliver("c/root", "hi", 1);
  expect(process?.actedAs).toEqual([agent]);
});

it("hands over no spare that has run a turn without its prompt", async () => {
  const { pool, spare, claudes } = withSpare();
  spare.warm({ cwd: "/work", model: "opus" });
  await flush();
  const [used] = claudes();
  // Another Claude session messaged the spare, so its prompt is fixed.
  used?.emit({ type: "system", subtype: "init", session_id: "spare-1" });
  await pool.deliver("c/root", "hi", 1);
  await flush();
  expect(used?.killed).toBe(true);
  expect(used?.prompts).toEqual([]);
  expect(claudes().find((process) => process.prompts.length)?.prompts).toEqual([
    "hi",
  ]);
});

it("hands over no spare that lists other tools than there are now", async () => {
  let key = "";
  const { pool, spare, claudes } = withSpare({}, () => key);
  spare.warm({ cwd: "/work", model: "opus" });
  await flush();
  const [stale] = claudes();
  // A plugin added a tool after the spare listed the tools.
  key = "tasks";
  await pool.deliver("c/root", "hi", 1);
  await flush();
  expect(stale?.killed).toBe(true);
  expect(stale?.prompts).toEqual([]);
  const next = claudes().find((process) =>
    process.options.args?.includes("spare-2"),
  );
  expect(next?.killed).toBe(false);
});

it("serves whichever agent starts the next conversation", async () => {
  const one = withSpare();
  const two = sessions({ spare: one.spare });
  one.spare.warm({ cwd: "/work", model: "opus" });
  await flush();
  await one.pool.deliver("c/a", "for one", 1);
  await flush();
  await two.pool.deliver("c/b", "for two", 2);
  // Each took the spare (all started by the first's spawn); neither agent
  // started a process of its own.
  expect(one.claudes().map((process) => process.prompts)).toEqual([
    ["for one"],
    ["for two"],
    [],
  ]);
  expect(two.claudes()).toEqual([]);
});

it("starts a conversation elsewhere afresh, and the spare follows it", async () => {
  const { pool, spare, claudes } = withSpare();
  spare.warm({ cwd: "/other", model: "opus" }, { cwd: "/work", model: "opus" });
  await flush();
  const [other] = claudes();
  await pool.deliver("c/root", "hi", 1);
  await flush();
  expect(other?.killed).toBe(true);
  expect(other?.prompts).toEqual([]);
  const used = claudes().filter((process) => process.prompts.length);
  expect(used[0]?.options.args).toContain("new-1");
  const next = claudes().find((process) =>
    process.options.args?.includes("spare-2"),
  );
  expect(next?.options.cwd).toBe("/work");
  expect(next?.killed).toBe(false);
});

it("does not wait for a spare started elsewhere", async () => {
  // The spare for another folder never finishes starting.
  const spare = new Spare(
    () => new Promise(() => undefined),
    async () => ({}),
  );
  const { pool, claudes } = sessions({ spare });
  spare.warm({ cwd: "/other", model: "opus" });
  await expect(pool.deliver("c/root", "hi", 1)).resolves.toEqual({ ok: true });
  expect(claudes()[0]?.prompts).toEqual(["hi"]);
});

it("keeps a spare that fits any agent, and replaces one that fits none", async () => {
  const { spare, claudes } = withSpare();
  const work = { cwd: "/work", model: "opus" };
  const other = { cwd: "/other", model: "opus" };
  spare.warm(work);
  await flush();
  spare.warm(other, work);
  await flush();
  expect(claudes()).toHaveLength(1);
  spare.warm(other);
  await flush();
  expect(claudes()).toHaveLength(2);
  expect(claudes()[0]?.killed).toBe(true);
  expect(claudes()[1]?.options.cwd).toBe("/other");
});

it("starts no spare again after one dies, until a conversation starts", async () => {
  const { pool, spare, claudes } = withSpare();
  const where = { cwd: "/work", model: "opus" };
  spare.warm(where);
  await flush();
  claudes()[0]?.exit(1, "not signed in");
  await flush();
  spare.warm(where);
  await flush();
  expect(claudes()).toHaveLength(1);
  await pool.deliver("c/root", "hi", 1);
  await flush();
  // One for the conversation, and a spare again.
  expect(claudes()).toHaveLength(3);
});

it("continues a conversation in its own process, apart from others", async () => {
  const { pool, claudes } = sessions();
  await pool.deliver("c/one", "first", 1);
  await pool.deliver("c/two", "other", 2);
  await pool.deliver("c/one", "second", 3);
  const prompts = claudes().map((process) => process.prompts);
  expect(prompts).toContainEqual(["first", "second"]);
  expect(prompts).toContainEqual(["other"]);
});

it("steers a conversation that is still working instead of queueing", async () => {
  const { pool, claudes } = sessions({ hold: true });
  const first = pool.deliver("c/root", "first", 1);
  await flush();
  const process = claudes()[0];
  if (!process) throw new Error("no process");
  const second = pool.deliver("c/root", "plain", 2, { steer: "steer" });
  await flush();
  expect(process.prompts).toEqual(["first", "steer"]);
  expect(pool.snapshot()).toEqual([{ key: "c/root", busy: true }]);
  process.finish();
  await expect(first).resolves.toEqual({ ok: true });
  await expect(second).resolves.toEqual({ ok: true });
});

const interruptsOf = (process: { received: Record<string, unknown>[] }) =>
  process.received.filter(
    (message) =>
      message.type === "control_request" &&
      (message.request as { subtype?: string }).subtype === "interrupt",
  );

it("interrupts the process working on a conversation, and only that one", async () => {
  const { pool, claudes } = sessions({ hold: true });
  const first = pool.deliver("c/one", "first", 1);
  const other = pool.deliver("c/two", "other", 2);
  await flush();
  const [one, two] = claudes().filter((process) => process.prompts.length);
  if (!one || !two) throw new Error("no processes");
  await pool.interrupt("c/one");
  expect(interruptsOf(one)).toHaveLength(1);
  expect(interruptsOf(two)).toHaveLength(0);
  one.finish();
  two.finish();
  await Promise.all([first, other]);
});

it("interrupts a conversation whose process is still starting once it has the message", async () => {
  const { pool, claudes } = sessions({ hold: true });
  const delivered = pool.deliver("c/root", "first", 1);
  // Asked before the process exists.
  const stopped = pool.interrupt("c/root");
  await stopped;
  const process = claudes().find((claude) => claude.prompts.length);
  expect(process?.prompts).toEqual(["first"]);
  expect(process && interruptsOf(process)).toHaveLength(1);
  process?.finish();
  await delivered;
});

it("does nothing when asked to interrupt a conversation with no running turn", async () => {
  const { pool, claudes } = sessions();
  await expect(pool.interrupt("c/none")).resolves.toBeUndefined();
  await pool.deliver("c/root", "first", 1);
  await pool.interrupt("c/root");
  for (const process of claudes())
    expect(interruptsOf(process)).toHaveLength(0);
});

it("opens one process for messages that arrive together in a new conversation", async () => {
  const { pool, claudes } = sessions();
  await Promise.all([
    pool.deliver("c/root", "one", 1),
    pool.deliver("c/root", "two", 2),
  ]);
  const used = claudes().filter((process) => process.prompts.length);
  expect(used).toHaveLength(1);
  expect(used[0]?.prompts).toEqual(["one", "two"]);
});

it("resumes a saved conversation after its process stops", async () => {
  vi.useFakeTimers();
  const store = memoryStore();
  const started = vi.fn();
  const { pool, claudes } = sessions({ store, started });
  await pool.deliver("c/root", "first", 1);
  const first = claudes()[0];
  vi.advanceTimersByTime(IDLE_MS + 1);
  expect(first?.killed).toBe(true);
  expect(pool.snapshot()).toEqual([]);
  await pool.deliver("c/root", "later", 5);
  const resumed = claudes().at(-1);
  expect(resumed?.options.args).toContain("--resume");
  expect(resumed?.options.args).toContain("new-1");
  expect(resumed?.prompts).toEqual(["later"]);
  expect(store.get("c/root")).toMatchObject({ id: "new-1", seen: 5 });
  // Only the new session tells what it started with; the resume does not.
  expect(started.mock.calls).toEqual([["new-1", "prompt"]]);
});

it("bounds a channel session's thread history while retaining recently used threads", async () => {
  const { pool, store, claudes } = sessions();
  try {
    // This dataset exercises the 200-entry retention bound.
    for (let index = 0; index < 200; index++)
      await pool.deliver("channel", "work", index + 1, {
        contextRoot: `root-${index}`,
      });
    await pool.deliver("channel", "continue", 201, { contextRoot: "root-0" });
    await pool.deliver("channel", "new thread", 202, {
      contextRoot: "root-200",
    });
    const saved = store.get("channel");
    expect(Object.keys(saved?.threads ?? {})).toHaveLength(200);
    expect(saved?.threads).toMatchObject({ "root-0": 201, "root-200": 202 });
    expect(saved?.threads).not.toHaveProperty("root-1");
    expect(claudes()).toHaveLength(1);
  } finally {
    pool.dispose();
  }
});

it("saves when a session takes in a message or ends a turn, not while a long turn keeps it open", async () => {
  vi.useFakeTimers();
  const store = memoryStore();
  const { pool, claudes } = sessions({ store, hold: true });
  const at = () => store.get("c/root")?.at ?? 0;
  const done = pool.deliver("c/root", "work", 1);
  await vi.advanceTimersByTimeAsync(10);
  const started = at();
  expect(started).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(IDLE_MS + 1);
  expect(claudes()[0]?.killed).toBe(false);
  expect(at()).toBe(started);
  claudes()[0]?.finish();
  await done;
  expect(at()).toBeGreaterThan(started);
});

it("keeps a conversation's process while its background work runs", async () => {
  vi.useFakeTimers();
  const { pool, claudes } = sessions();
  await pool.deliver("c/root", "start a build", 1);
  const [process] = claudes();
  backgroundTasks(process, {});
  vi.advanceTimersByTime(IDLE_MS * 3 - 1000);
  expect(process?.killed).toBe(false);
  // The build ends, and Claude reports it in a turn of its own.
  backgroundTasks(process);
  sessionState(process, "running");
  sessionState(process, "idle");
  vi.advanceTimersByTime(IDLE_MS - 1);
  expect(process?.killed).toBe(false);
  vi.advanceTimersByTime(1);
  expect(process?.killed).toBe(true);
});

it("keeps a conversation's process through a turn Claude starts itself", async () => {
  vi.useFakeTimers();
  const { pool, claudes } = sessions();
  await pool.deliver("c/root", "hi", 1);
  const [process] = claudes();
  sessionState(process, "running");
  vi.advanceTimersByTime(IDLE_MS * 2 - 1000);
  sessionState(process, "idle");
  vi.advanceTimersByTime(IDLE_MS - 1);
  expect(process?.killed).toBe(false);
  vi.advanceTimersByTime(1);
  expect(process?.killed).toBe(true);
});

it("applies new settings over background work once no reply is running", async () => {
  const { pool, claudes, setModel } = sessions();
  await pool.deliver("c/root", "start a build", 1);
  const [process] = claudes();
  backgroundTasks(process, {});
  setModel("sonnet");
  pool.reconfigure();
  await flush();
  expect(process?.killed).toBe(true);
  await pool.deliver("c/root", "again", 2);
  expect(claudes().at(-1)?.options.args).toEqual(
    expect.arrayContaining(["--resume", "new-1", "--model", "sonnet"]),
  );
});

it("starts over when a saved session no longer loads", async () => {
  const store = memoryStore();
  store.set("c/root", { id: "lost", seen: 4, at: 1 });
  const { pool, claudes } = sessions({ store });
  await expect(
    pool.deliver("c/root", "hello", 9, {
      fresh: async () => "hello, with the thread so far",
    }),
  ).resolves.toEqual({ ok: true });
  const [failed, fresh] = claudes();
  expect(failed?.options.args).toContain("lost");
  expect(fresh?.options.args).toContain("--session-id");
  expect(fresh?.prompts).toEqual(["hello, with the thread so far"]);
  expect(store.get("c/root")).toMatchObject({ id: "new-1", seen: 9 });
});

it("compacts a quiet conversation's saved session in place", async () => {
  vi.useFakeTimers();
  const store = memoryStore();
  const { pool, claudes } = sessions({ store });
  await pool.deliver("c/root", "first", 4);
  vi.advanceTimersByTime(IDLE_MS + 1);
  await expect(pool.compact("c/root")).resolves.toEqual({ ok: true });
  const resumed = claudes().at(-1);
  expect(resumed?.options.args).toContain("--resume");
  expect(resumed?.prompts).toEqual(["/compact"]);
  expect(store.get("c/root")).toMatchObject({ id: "new-1", seen: 4 });
});

it("has no session to compact before a conversation starts", async () => {
  const { pool, claudes } = sessions();
  await expect(pool.compact("c/root")).resolves.toEqual({ ok: true });
  expect(claudes().filter((process) => process.prompts.length)).toEqual([]);
});

it("reports a compaction that failed", async () => {
  const { pool, claudes } = sessions({ hold: true });
  const first = pool.deliver("c/root", "first", 1);
  await flush();
  claudes()[0]?.finish();
  await first;
  const compacted = pool.compact("c/root");
  await flush();
  const process = claudes()[0];
  process?.emit({
    type: "system",
    subtype: "status",
    status: null,
    compact_result: "failed",
    compact_error: "Not enough messages to compact.",
  });
  process?.finish();
  await expect(compacted).resolves.toEqual({
    ok: false,
    error: "Not enough messages to compact.",
  });
});

it("keeps the live session if its durable reset fails, then forgets it on retry", async () => {
  const { pool, store, claudes } = sessions();
  try {
    await pool.deliver("c/root", "one", 1);
    const process = claudes()[0];
    if (!process) throw new Error("Expected Claude process");
    vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("Disk full"));
    await expect(pool.forget("c/root")).rejects.toThrow("Disk full");
    expect(process.killed).toBe(false);
    expect(store.get("c/root")?.id).toBe("new-1");
    await pool.forget("c/root");
    expect(process.killed).toBe(true);
    expect(store.get("c/root")).toBeUndefined();
    await pool.deliver("c/root", "two", 2);
    expect(claudes()[1]?.options.args).not.toContain("--resume");
  } finally {
    pool.dispose();
  }
});

it("runs a turn with the model and effort it was delivered with, starting over included", async () => {
  const store = memoryStore();
  store.set("c/root", { id: "lost", seen: 4, at: 1 });
  const { pool, claudes } = sessions({ store });
  await pool.deliver("c/root", "hello", 9, {
    fresh: async () => "hello again",
    pick: { model: "haiku", effort: "low" },
  });
  await pool.deliver("c/root", "next", 10);
  const fresh = claudes().find((process) => process.prompts.length);
  expect(fresh?.prompts).toEqual(["hello again", "next"]);
  expect(fresh?.models).toEqual(["haiku", "opus"]);
  expect(fresh?.efforts).toEqual(["low", "high"]);
});

it("runs any number of conversations at once", async () => {
  const { pool, live } = sessions({ hold: true });
  for (let index = 0; index < 12; index++)
    void pool.deliver(`c/${index}`, "hi", index);
  await flush();
  expect(live()).toHaveLength(12);
  expect(pool.snapshot().every((session) => session.busy)).toBe(true);
});

it("runs a one-off turn in a new session that is never saved", async () => {
  const store = memoryStore();
  const { pool, claudes } = sessions({ store });
  await expect(pool.runOnce("timer/a", () => "wake")).resolves.toEqual({
    ok: true,
  });
  const claude = claudes().find((process) => process.prompts.includes("wake"));
  expect(claude?.options.args).toContain("--session-id");
  expect(claude?.killed).toBe(true);
  expect(pool.snapshot()).toEqual([]);
  expect(store.get("timer/a #1")).toBeUndefined();
});

it("asks a one-off turn for its prompt only once its process is ready", async () => {
  let release!: () => void;
  const launched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, claudes } = sessions({ launched });
  // It went stale while its process started, as a watch turned off would.
  let stale = false;
  const prompt = vi.fn(() => (stale ? undefined : "wake"));
  const waiting = pool.runOnce("watch/a", prompt);
  await flush();
  expect(prompt).not.toHaveBeenCalled();
  stale = true;
  release();
  await expect(waiting).resolves.toEqual({ ok: true });
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(claudes().some((process) => process.prompts.includes("wake"))).toBe(
    false,
  );
});

it("stops and waits for processes still starting when it shuts down", async () => {
  let release!: () => void;
  const initialized = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, claudes } = sessions({ initialized });
  const starting = [
    pool.metadata(),
    pool.deliver("c/root", "hi", 1),
    pool.runOnce("timer/a", () => "work"),
  ];
  try {
    await vi.waitFor(() => expect(claudes()).toHaveLength(3));
    // The host only signals them; they exit later, as after a grace period.
    for (const claude of claudes()) claude.exitOnKill = false;
    let stopped = false;
    const shutdown = pool.shutdown().then(() => {
      stopped = true;
    });
    await flush();
    expect(claudes().map((claude) => claude.killed)).toEqual([
      true,
      true,
      true,
    ]);
    expect(stopped).toBe(false);
    for (const claude of claudes()) claude.exit(null);
    await shutdown;
  } finally {
    release();
    await Promise.allSettled(starting);
  }
});

it("stops and waits for a spare it took when it shuts down", async () => {
  let release!: () => void;
  const initialized = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, spare, claudes } = withSpare({ initialized });
  spare.warm({ cwd: "/work", model: "opus" });
  await flush();
  const [taken] = claudes();
  if (!taken) throw new Error("no spare");
  const delivering = pool.deliver("c/root", "hello", 10);
  try {
    // Taking it starts the next spare; the rest of the handover queues no
    // timer, so it is initializing as the agent's after one turn of the loop.
    await vi.waitFor(() => expect(claudes()).toHaveLength(2));
    await flush();
    taken.exitOnKill = false;
    let stopped = false;
    const shutdown = pool.shutdown().then(() => {
      stopped = true;
    });
    await flush();
    expect(taken.killed).toBe(true);
    expect(stopped).toBe(false);
    taken.exit(null);
    await shutdown;
  } finally {
    release();
    spare.dispose();
    await delivering;
  }
});

it("starts no process for a conversation still launching when it shuts down", async () => {
  let release!: () => void;
  const launched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, claudes } = sessions({ launched });
  const delivering = pool.deliver("c/root", "hi", 1);
  try {
    await flush();
    await pool.shutdown();
  } finally {
    release();
  }
  await expect(delivering).resolves.toMatchObject({ ok: false });
  expect(claudes()).toEqual([]);
});

it("keeps a one-off turn's entry until its process has exited", async () => {
  const { pool, claudes } = sessions({ hold: true });
  const stop = new AbortController();
  let settled = false;
  const done = pool
    .runOnce("timer/slow", () => "work", stop.signal)
    .then((result) => {
      settled = true;
      return result;
    });
  await flush();
  const claude = claudes().find((process) => process.prompts.includes("work"));
  // The host only signals it; it exits later, as after a grace period.
  if (claude) claude.exitOnKill = false;
  stop.abort(new Error("The turn ran past its deadline"));
  await flush();
  expect(claude?.killed).toBe(true);
  expect(settled).toBe(false);
  expect(pool.snapshot().map((session) => session.key)).toContain(
    "timer/slow #1",
  );
  claude?.exit(null);
  await expect(done).resolves.toEqual({
    ok: false,
    error: "The turn ran past its deadline",
  });
  expect(pool.snapshot().map((session) => session.key)).not.toContain(
    "timer/slow #1",
  );
});

it("gives up a one-off turn whose process is still starting", async () => {
  let release!: () => void;
  const launched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, claudes } = sessions({ launched });
  const stop = new AbortController();
  const prompt = vi.fn(() => "wake");
  const done = pool.runOnce("watch/a", prompt, stop.signal);
  await flush();
  expect(claudes()).toEqual([]);
  stop.abort(new Error("The agent was removed"));
  await expect(done).resolves.toEqual({
    ok: false,
    error: "The agent was removed",
  });
  expect(pool.snapshot()).toEqual([]);
  // The process that starts afterwards is stopped, never asked to work.
  release();
  await flush();
  expect(claudes()).toHaveLength(1);
  expect(claudes()[0]?.killed).toBe(true);
  expect(prompt).not.toHaveBeenCalled();
});

it("stops a one-off turn's process given up while it initializes", async () => {
  let release!: () => void;
  const initialized = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, claudes } = sessions({ initialized });
  const stop = new AbortController();
  const prompt = vi.fn(() => "wake");
  const done = pool.runOnce("watch/a", prompt, stop.signal);
  await flush();
  expect(claudes()).toHaveLength(1);
  stop.abort(new Error("The agent was removed"));
  try {
    await expect(done).resolves.toEqual({
      ok: false,
      error: "The agent was removed",
    });
    // Stopped while its initialize write is still held.
    expect(claudes()[0]?.killed).toBe(true);
  } finally {
    release();
  }
  await flush();
  expect(prompt).not.toHaveBeenCalled();
  expect(claudes()).toHaveLength(1);
});

it("starts nothing for a one-off turn given up before it runs", async () => {
  const { pool, claudes } = sessions();
  const prompt = vi.fn(() => "wake");
  await expect(
    pool.runOnce(
      "timer/a",
      prompt,
      AbortSignal.abort(new Error("The agent was removed")),
    ),
  ).resolves.toEqual({ ok: false, error: "The agent was removed" });
  await flush();
  expect(claudes()).toEqual([]);
  expect(prompt).not.toHaveBeenCalled();
  expect(pool.snapshot()).toEqual([]);
});

it("starts again with settings saved while a conversation's process started", async () => {
  let release!: () => void;
  const launched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, claudes, setModel } = sessions({ launched });
  const done = pool.deliver("c/root", "hi", 1);
  await flush();
  setModel("sonnet");
  pool.reconfigure();
  release();
  await expect(done).resolves.toEqual({ ok: true });
  const [old] = claudes();
  expect(old?.options.args).toContain("opus");
  expect(old?.killed).toBe(true);
  const used = claudes().filter((process) => process.prompts.length);
  expect(used).toHaveLength(1);
  expect(used[0]?.options.args).toContain("sonnet");
});

it("restarts idle processes when settings change", async () => {
  const { pool, claudes, setModel } = sessions();
  await pool.deliver("c/root", "hi", 1);
  await flush();
  const [conversation] = claudes();
  setModel("sonnet");
  pool.reconfigure();
  await flush();
  expect(conversation?.killed).toBe(true);
  await pool.deliver("c/root", "again", 2);
  const resumed = claudes().at(-1);
  expect(resumed?.options.args).toEqual(
    expect.arrayContaining(["--resume", "new-1", "--model", "sonnet"]),
  );
});

it("stops every process when disposed", async () => {
  const { pool, spare, claudes } = withSpare();
  spare.warm({ cwd: "/work", model: "opus" });
  await pool.deliver("c/root", "hi", 1);
  await flush();
  pool.dispose();
  spare.dispose();
  await flush();
  expect(claudes()).toHaveLength(2);
  expect(claudes().every((process) => process.killed)).toBe(true);
  await expect(pool.deliver("c/root", "late", 2)).resolves.toMatchObject({
    ok: false,
  });
  expect(claudes()).toHaveLength(2);
});

it("starts no spare for a conversation that starts after its agents are gone", async () => {
  let release!: () => void;
  const launched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, spare, live } = withSpare({ launched });
  spare.warm({ cwd: "/work", model: "opus" });
  const done = pool.deliver("c/root", "hi", 1);
  await flush();
  // As the runtime does when its last agent goes, mid-launch.
  pool.dispose();
  spare.warm();
  release();
  await expect(done).resolves.toMatchObject({ ok: false });
  await flush();
  expect(live()).toEqual([]);
});

/** Agent storage over `data`, which saves as it is set. */
const mapStore = (data: Map<string, string>) =>
  localStore({
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  } as Storage);
/** Waits for the saves already started. */
const settled = () => new Promise((resolve) => setTimeout(resolve));

it("keeps saved sessions per agent in storage", () => {
  const data = new Map<string, string>();
  const storage = mapStore(data);
  const one = localSessions(storage, "one");
  const two = localSessions(storage, "two");
  one.set("c/root", { id: "s1", seen: 3, at: 1 });
  two.set("c/root", { id: "s2", seen: 4, at: 2 });
  expect(localSessions(storage, "one").get("c/root")?.id).toBe("s1");
  expect(two.get("c/root")?.id).toBe("s2");
  one.delete("c/root");
  expect(one.get("c/root")).toBeUndefined();
  expect(two.get("c/root")?.id).toBe("s2");
  expect([...data.keys()].sort()).toEqual([
    "buzz.claude-code.sessions.v1:one",
    "buzz.claude-code.sessions.v1:two",
  ]);
  data.set("buzz.claude-code.sessions.v1:one", "not json");
  expect(one.get("c/root")).toBeUndefined();
});

it("reads an agent's sessions from the shared value until it saves its own", async () => {
  const data = new Map<string, string>([
    [
      "buzz.claude-code.sessions.v1",
      JSON.stringify({
        one: { "c/root": { id: "s1", seen: 3, at: 1 } },
        two: { "c/root": { id: "s2", seen: 4, at: 2 } },
      }),
    ],
  ]);
  const storage = mapStore(data);
  const one = localSessions(storage, "one");
  expect(one.get("c/root")?.id).toBe("s1");
  one.delete("c/root");
  expect(one.get("c/root")).toBeUndefined();
  expect(localSessions(storage, "two").get("c/root")?.id).toBe("s2");
  localSessions(storage, "two").set("c/other", { id: "s3", seen: 1, at: 3 });
  await settled();
  expect(data.has("buzz.claude-code.sessions.v1")).toBe(false);
  expect(localSessions(storage, "two").get("c/root")?.id).toBe("s2");
});

it("keeps an agent in the shared sessions value until its own is saved", async () => {
  const name = "buzz.claude-code.sessions.v1";
  const shared = JSON.stringify({
    one: { "c/root": { id: "s1", seen: 3, at: 1 } },
  });
  const disk = new Map([[name, shared]]);
  const save = vi.fn(async (key: string, value: string | null) => {
    if (key !== name) throw new Error("disk full");
    if (value === null) disk.delete(key);
    else disk.set(key, value);
  });
  const storage = fileStore(new Map(disk), save);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  localSessions(storage, "one").set("c/other", { id: "s2", seen: 1, at: 2 });
  await settled();
  error.mockRestore();
  expect(warn).toHaveBeenCalledWith(
    "Claude sessions were not saved",
    expect.objectContaining({ message: "disk full" }),
  );
  warn.mockRestore();
  expect(disk.get(name)).toBe(shared);
  // The next start still resumes the saved session.
  const restarted = fileStore(new Map(disk), save);
  expect(localSessions(restarted, "one").get("c/root")?.id).toBe("s1");
});

it("shares a temporary metadata lookup, releases its process, and refreshes after settings change", async () => {
  const { pool, claudes, live, setModel } = sessions();
  const [first, second] = await Promise.all([pool.metadata(), pool.metadata()]);
  expect(first).toEqual(second);
  expect(first.model).toBe("claude-opus-5-5");
  expect(claudes()).toHaveLength(1);
  expect(live()).toHaveLength(0);
  await pool.metadata();
  expect(claudes()).toHaveLength(1);
  setModel("haiku");
  pool.reconfigure();
  expect((await pool.metadata()).model).toBe("claude-haiku-5-5");
  expect(live()).toHaveLength(0);
  pool.dispose();
});

it("does not start metadata discovery after its agent is disposed during launch", async () => {
  let release!: () => void;
  const launched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, claudes } = sessions({ launched });
  const result = pool.metadata();
  await flush();
  pool.dispose();
  const stopped = expect(result).rejects.toThrow("stopped");
  release();
  await stopped;
  expect(claudes()).toHaveLength(0);
});

it("marks a message whose process could not start as never delivered", async () => {
  const launched = Promise.reject(new Error("no settings"));
  launched.catch(() => undefined);
  const { pool } = sessions({ launched });
  await expect(pool.deliver("a", "one", 1)).resolves.toEqual({
    ok: false,
    error: "Claude could not start",
    undelivered: true,
  });
});

it.each(["delete", "fresh"])(
  "marks a message never delivered when starting over from a lost session fails (%s)",
  async (failing) => {
    const store = memoryStore();
    store.set("c/root", { id: "lost", seen: 4, at: 1 });
    const { pool } = sessions({ store });
    if (failing === "delete")
      vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("Disk full"));
    try {
      await expect(
        pool.deliver("c/root", "hello", 9, {
          fresh: async () => {
            if (failing === "fresh") throw new Error("Disk full");
            return "hello again";
          },
        }),
      ).resolves.toEqual({
        ok: false,
        error: "Claude could not start over: Disk full",
        undelivered: true,
      });
    } finally {
      pool.dispose();
    }
  },
);

it("drops a cancelled source delivery after process startup without stopping another conversation", async () => {
  let release!: () => void;
  const launched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, claudes } = sessions({ launched });
  let current = true;
  const stale = pool.deliver("source", "cancelled wake", 1, {
    current: () => current,
  });
  await flush();
  current = false;
  release();
  await expect(stale).resolves.toMatchObject({ ok: true, undelivered: true });
  expect(pool.seen("source")).toBe(0);
  await pool.deliver("other", "ordinary message", 2);
  expect(claudes().some((p) => p.prompts.includes("cancelled wake"))).toBe(
    false,
  );
  expect(claudes().some((p) => p.prompts.includes("ordinary message"))).toBe(
    true,
  );
});

it.each([false, true])(
  "keeps messages behind an Attention refresh (existing: %s)",
  async (existing) => {
    const f = sessions({ hold: !existing });
    if (existing) {
      await f.pool.deliver("c/root", "warm", 1);
      const live = f.live()[0];
      if (!live) throw new Error("fixture");
      live.hold = true;
    }
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = f.pool.deliver("c/root", "wake", 2, {
      refresh: async () => {
        ready();
        await gate;
        return "refreshed wake";
      },
    });
    await entered;
    const second = f.pool.deliver("c/root", "later mention", 3);
    try {
      await flush();
      expect(f.claudes().flatMap((process) => process.prompts)).not.toContain(
        "later mention",
      );
      release();
      await flush();
      expect(f.live()[0]?.prompts.slice(-2)).toEqual([
        "refreshed wake",
        "later mention",
      ]);
    } finally {
      release();
      f.pool.dispose();
      await Promise.all([first, second]);
    }
  },
);

it.each([false, true])(
  "reopens a process reconfigured during Attention refresh (existing: %s)",
  async (existing) => {
    const f = sessions();
    if (existing) await f.pool.deliver("c/root", "warm", 1);
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.fn(async () => {
      ready();
      await gate;
      return "refreshed wake";
    });
    const done = f.pool.deliver("c/root", "wake", 2, { refresh });
    try {
      await entered;
      const old = f.live()[0];
      if (!old) throw new Error("fixture");
      f.setModel("sonnet");
      f.pool.reconfigure();
      release();
      await expect(done).resolves.toEqual({ ok: true });
      expect(old.prompts).not.toContain("refreshed wake");
      expect(f.live()[0]?.prompts).toEqual(["refreshed wake"]);
      expect(f.live()[0]?.options.args).toContain("sonnet");
    } finally {
      release();
      f.pool.dispose();
      await done;
    }
  },
);

it("drops a wake disposed during its Attention refresh", async () => {
  const f = sessions();
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = f.pool.deliver("c/root", "wake", 2, {
    refresh: async () => {
      ready();
      await gate;
      return "refreshed wake";
    },
  });
  await entered;
  f.pool.dispose();
  release();
  await expect(done).resolves.toMatchObject({ ok: false, undelivered: true });
  expect(f.claudes().flatMap((process) => process.prompts)).not.toContain(
    "refreshed wake",
  );
});

it("releases a conversation handover when its refresh fails", async () => {
  const f = sessions();
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = f.pool.deliver("c/root", "wake", 1, {
    refresh: async () => {
      ready();
      await gate;
      throw new Error("read failed");
    },
  });
  const failed = expect(first).rejects.toThrow("read failed");
  await entered;
  const second = f.pool.deliver("c/root", "later mention", 2);
  release();
  try {
    await failed;
    await expect(second).resolves.toEqual({ ok: true });
    expect(f.live()[0]?.prompts).toEqual(["later mention"]);
  } finally {
    f.pool.dispose();
  }
});

it("retains a missing remote session until the owner starts a new session", async () => {
  const store = memoryStore();
  store.set("room", { id: "missing", seen: 10, at: 1 });
  const { pool, claudes } = sessions({ store, strictResume: true });
  try {
    await expect(pool.deliver("room", "continue", 20)).resolves.toMatchObject({
      ok: false,
      error:
        "The remote Claude session cannot be restored. Start a new session to continue.",
    });
    expect(store.get("room")?.id).toBe("missing");
    expect(claudes()).toHaveLength(1);
    await pool.forget("room");
    await expect(pool.deliver("room", "new", 30)).resolves.toEqual({
      ok: true,
    });
    expect(store.get("room")?.id).toBe("new-1");
  } finally {
    await pool.shutdown();
  }
});

it("waits for a remote session save before it sends the first prompt", async () => {
  const store = memoryStore();
  let submitting = false;
  let saved!: () => void;
  const gate = new Promise<void>((resolve) => {
    saved = resolve;
  });
  const write = store.set;
  store.set = (key, value) => {
    if (value.pending) return write(key, value);
    submitting = true;
    return gate.then(() => write(key, value));
  };
  const { pool, claudes } = sessions({ store, strictResume: true });
  const sent = pool.deliver("room", "hello", 10);
  try {
    await vi.waitFor(() => expect(submitting).toBe(true));
    expect(store.get("room")?.pending).toBe(true);
    expect(claudes()[0]?.prompts).toEqual([]);
  } finally {
    saved();
  }
  await expect(sent).resolves.toEqual({ ok: true });
  expect(claudes()[0]?.prompts).toEqual(["hello"]);
  await pool.shutdown();
});

it("retries an unsent remote session in the same pool after restart", async () => {
  const store = memoryStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = store.set;
  store.set = (key, value) => {
    write(key, value);
    return gate;
  };
  const first = sessions({ store, strictResume: true });
  let current = true;
  const unsent = first.pool.deliver("room", "old", 1, {
    current: () => current,
  });
  try {
    await vi.waitFor(() => expect(store.get("room")?.pending).toBe(true));
    current = false;
  } finally {
    release();
  }
  await expect(unsent).resolves.toMatchObject({ ok: true, undelivered: true });
  expect(first.claudes().flatMap((process) => process.prompts)).toEqual([]);
  await first.pool.shutdown();
  store.set = write;
  const restored = sessions({ store, strictResume: true });
  try {
    await expect(restored.pool.deliver("room", "retry", 2)).resolves.toEqual({
      ok: true,
    });
    expect(restored.claudes().flatMap((process) => process.prompts)).toEqual([
      "retry",
    ]);
    expect(store.get("room")?.pending).toBeUndefined();
  } finally {
    await restored.pool.shutdown();
  }
});

it("uses current settings after a remote session save waits", async () => {
  const store = memoryStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = store.set;
  store.set = (key, value) => {
    write(key, value);
    return gate;
  };
  const f = sessions({ store, strictResume: true });
  const sent = f.pool.deliver("room", "hello", 1);
  try {
    await vi.waitFor(() => expect(store.get("room")?.pending).toBe(true));
    f.setModel("haiku");
    f.pool.reconfigure();
  } finally {
    release();
  }
  try {
    await expect(sent).resolves.toEqual({ ok: true });
    expect(
      f
        .claudes()
        .filter((process) => process.prompts.length)
        .map((process) => process.model),
    ).toEqual(["haiku"]);
  } finally {
    await f.pool.shutdown();
  }
});

it("settles a failed remote save and permits the next delivery", async () => {
  const store = memoryStore();
  const write = store.set;
  let fail = true;
  store.set = (key, value) => {
    if (fail && !value.pending) {
      return Promise.reject(new Error("disk unavailable"));
    }
    return write(key, value);
  };
  const f = sessions({ store, strictResume: true });
  try {
    await expect(f.pool.deliver("room", "one", 1)).resolves.toMatchObject({
      ok: false,
      error: "disk unavailable",
    });
    expect(f.pool.active("room")).toBe(false);
    expect(f.claudes().flatMap((process) => process.prompts)).toEqual([]);
    fail = false;
    await expect(f.pool.deliver("room", "two", 2)).resolves.toEqual({
      ok: true,
    });
    expect(f.claudes().flatMap((process) => process.prompts)).toEqual(["two"]);
  } finally {
    await f.pool.shutdown();
  }
});
