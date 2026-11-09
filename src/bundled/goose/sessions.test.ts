import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Choice,
  REQUEST_TIMEOUT_MS,
  type ServeMcp,
  type Spawn,
  type ToolServer,
} from "./goose";
import { fakeSpawn, flush, gated } from "./goose-testing";
import {
  AgentSessions,
  IDLE_MS,
  type Launch,
  localSessions,
  type SavedConversation,
  ServerPool,
  AgentProcess,
  type SessionsOptions,
} from "./sessions";

const tools: ToolServer = async (_conversation, message) => ({
  jsonrpc: "2.0",
  id: message.id,
  result: {},
});

/** A goose shared by agents, and its first agent's sessions. */
const setup = (
  initial: Partial<Launch> = {},
  hold = false,
  {
    pool = new ServerPool(),
    serve,
    silent,
    onChange,
    store,
    started,
    wrap,
  }: Readonly<{
    pool?: ServerPool;
    started?: SessionsOptions["started"];
    onChange?: () => void;
    store?: Map<string, SavedConversation>;
    /** Wraps the fake's `serve`. */
    serve?: (serve: ServeMcp) => ServeMcp;
    silent?: readonly string[];
    /** Wraps the fake's `spawn`, as `gated(…).wrap` does. */
    wrap?: (spawn: ReturnType<typeof fakeSpawn>["spawn"]) => Spawn;
  }> = {},
) => {
  const fake = fakeSpawn({
    home: "/home/test",
    hold,
    ...(silent && { silent }),
    providers: [{ providerId: "openai", defaultModel: "gpt-default" }],
  });
  const process = new AgentProcess(
    wrap ? { ...fake, spawn: wrap(fake.spawn) } : fake,
    serve ? serve(fake.serve) : fake.serve,
  );
  /** Another agent in the same goose. */
  const agent = (
    initial: Partial<Launch> = {},
    agentTools: ToolServer = tools,
    onChange?: () => void,
  ) => {
    let settings: Launch = {
      workspace: "~/.buzz",
      systemPrompt: "prompt",
      ...initial,
    };
    let choice: Choice = { provider: "", model: "" };
    const sessions = new AgentSessions({
      resolveDirectory: fake.resolveDirectory,
      tools: agentTools,
      process,
      pool,
      ...(onChange && { onChange }),
      ...(store && {
        store,
      }),
      ...(started && { started }),
      launch: async () => settings,
      choice: () => choice,
      fingerprint: () =>
        JSON.stringify([settings.workspace, settings.systemPrompt]),
    });
    return {
      sessions,
      change: (next: Partial<Launch>, reconfigure = true) => {
        settings = { ...settings, ...next };
        if (reconfigure) sessions.reconfigure();
      },
      /** Picks a provider and model, as saving the agent's settings does. */
      choose: (next: Choice) => {
        choice = next;
        sessions.reconfigure();
      },
    };
  };
  return { fake, pool, process, agent, ...agent(initial, tools, onChange) };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A host that, like the app's, counts a server until its close finishes and
 * refuses one past `cap`. Closes finish once `release` is called. */
const host = (cap: number) => {
  let running = 0;
  let release!: () => void;
  const stopping = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    serve:
      (serve: ServeMcp): ServeMcp =>
      async (handler) => {
        if (running >= cap) throw "Too many MCP servers are running";
        running++;
        const server = await serve(handler);
        const closed = server.closed
          .then(() => stopping)
          .then(() => {
            running--;
          });
        return { ...server, closed };
      },
  };
};

describe("AgentSessions", () => {
  it("maps conversation and one-off keys to their native sessions and the process each lives in", async () => {
    const { fake, sessions, process } = setup({}, true);
    const delivery = sessions.deliver("thread", "one", 1);
    const once = sessions.runOnce("watch", () => "two");
    try {
      await vi.waitFor(() => expect(fake.geese[0]?.turns).toHaveLength(2));
      const turns = fake.geese[0]?.turns ?? [];
      const normal = turns.find((turn) => turn.text === "one");
      const standalone = turns.find((turn) => turn.text === "two");
      expect(normal?.sessionId).toBeDefined();
      expect(standalone?.sessionId).toBeDefined();
      const running = await process.get();
      expect(sessions.serving("thread")?.sessionId).toBe(normal?.sessionId);
      expect(sessions.serving("thread")?.process).toBe(running);
      expect(sessions.serving("watch #1")?.sessionId).toBe(
        standalone?.sessionId,
      );
      expect(sessions.serving("watch #1")?.process).toBe(running);
      expect(sessions.serving("missing")).toBeUndefined();
      for (const turn of turns) turn.finish();
      await Promise.all([delivery, once]);
      expect(sessions.serving("watch #1")).toBeUndefined();
    } finally {
      sessions.dispose();
      await process.shutdown();
      await Promise.all([delivery, once]);
    }
    expect(sessions.serving("thread")).toBeUndefined();
  });

  it("serves each conversation from its own session in one process", async () => {
    const { fake, sessions } = setup();
    await sessions.deliver("a", "one", 1);
    await sessions.deliver("b", "two", 2);
    await sessions.deliver("a", "three", 3);
    expect(fake.geese).toHaveLength(1);
    const [goose] = fake.geese;
    expect(goose?.opened).toHaveLength(2);
    expect(goose?.turns.map((turn) => [turn.sessionId, turn.text])).toEqual([
      ["session-1", "one"],
      ["session-2", "two"],
      ["session-1", "three"],
    ]);
    expect(sessions.seen("a")).toBe(3);
  });

  it("opens sessions in the workspace as an absolute path", async () => {
    const { fake, sessions } = setup();
    await sessions.deliver("a", "one", 1);
    expect(fake.geese[0]?.options.cwd).toBe("/home/test");
    expect(fake.geese[0]?.opened[0]?.cwd).toBe("/home/test/.buzz");
  });

  it("opens every agent's sessions in one goose, each in its workspace with its tools", async () => {
    const { fake, sessions, agent } = setup();
    const ada = vi.fn(tools);
    const bo = vi.fn(tools);
    const first = agent({ workspace: "~/ada" }, ada);
    const second = agent({ workspace: "/work/bo" }, bo);
    await first.sessions.deliver("chan/root", "one", 1);
    await second.sessions.deliver("chan/root", "two", 2);
    await sessions.deliver("chan/root", "three", 3);
    expect(fake.geese).toHaveLength(1);
    const [goose] = fake.geese;
    expect(goose?.opened.map((session) => session.cwd)).toEqual([
      "/home/test/ada",
      "/work/bo",
      "/home/test/.buzz",
    ]);
    await goose?.mcp("session-2", "tools/list");
    expect(ada).not.toHaveBeenCalled();
    expect(bo).toHaveBeenCalledWith("chan/root", {
      id: expect.anything(),
      method: "tools/list",
      params: {},
    });
    await goose?.mcp("session-1", "tools/list");
    expect(ada).toHaveBeenCalledOnce();
    expect(bo).toHaveBeenCalledOnce();
  });

  it("opens one session for messages that arrive together", async () => {
    const { fake, sessions } = setup();
    await Promise.all([
      sessions.deliver("a", "one", 1),
      sessions.deliver("a", "two", 2),
    ]);
    expect(fake.geese[0]?.opened).toHaveLength(1);
  });

  it("interrupts the turn running in a conversation, and no other", async () => {
    const { fake, sessions } = setup({}, true);
    const one = sessions.deliver("a", "one", 1);
    const other = sessions.deliver("b", "other", 2);
    // Both turns are running before the interrupt.
    await vi.waitFor(() => expect(fake.geese[0]?.turns).toHaveLength(2));
    const [first, second] = fake.geese[0]?.turns ?? [];
    expect(first?.text).toContain("one");
    expect(second?.text).toContain("other");
    await sessions.interrupt("a");
    await flush();
    expect(fake.geese[0]?.cancelled).toEqual([first?.sessionId]);
    await expect(one).resolves.toEqual({ ok: true, stopped: true });
    second?.finish();
    await expect(other).resolves.toMatchObject({ ok: true });
  });

  it("interrupts a conversation once the session opening for it has its message", async () => {
    const { fake, sessions } = setup({}, true);
    const delivered = sessions.deliver("a", "one", 1);
    // Asked while the session still opens.
    await sessions.interrupt("a");
    await flush();
    expect(fake.geese[0]?.turns).toHaveLength(1);
    expect(fake.geese[0]?.cancelled).toEqual([
      fake.geese[0]?.turns[0]?.sessionId,
    ]);
    await expect(delivered).resolves.toMatchObject({ ok: true });
  });

  it("does nothing when asked to interrupt a conversation with no session", async () => {
    const { fake, sessions } = setup();
    await expect(sessions.interrupt("none")).resolves.toBeUndefined();
    await sessions.deliver("a", "one", 1);
    await sessions.interrupt("a");
    expect(fake.geese[0]?.cancelled).toEqual([]);
  });

  it("closes idle sessions when their settings change", async () => {
    const { fake, sessions, change } = setup();
    await sessions.deliver("a", "one", 1);
    change({ systemPrompt: "newer" });
    await flush(30);
    expect(fake.geese[0]?.closed).toEqual(["session-1"]);
    expect(sessions.seen("a")).toBe(0);
  });

  it("shows a reopened conversation everything again", async () => {
    const { fake, sessions, change } = setup();
    const fresh = vi.fn(async () => "everything so far");
    await sessions.deliver("a", "one", 1, { fresh });
    expect(fresh).not.toHaveBeenCalled();
    change({ systemPrompt: "newer" }, false);
    await sessions.deliver("a", "two", 2, { fresh });
    const [goose] = fake.geese;
    expect(fake.geese).toHaveLength(1);
    expect(goose?.closed).toEqual(["session-1"]);
    expect(goose?.prompts.get("session-2")).toBe("newer");
    expect(goose?.turns.at(-1)?.text).toBe("everything so far");
  });

  it("leaves only a conversation's first session for goose to name", async () => {
    const { fake, sessions, change } = setup();
    const named = vi.fn();
    await sessions.deliver("a", "one", 1, { title: "Buzz", named });
    change({ systemPrompt: "newer" }, false);
    await sessions.deliver("a", "two", 2, { title: "Buzz", named });
    // A reopened session would cost another naming call for a named chat.
    expect(
      fake.geese[0]?.opened.map(
        (session) => (session._meta as { sessionTitle?: string }).sessionTitle,
      ),
    ).toEqual([undefined, "Buzz"]);
  });

  it("switches the live session's provider and model between turns", async () => {
    const { fake, sessions, choose } = setup();
    await sessions.deliver("a", "one", 1);
    choose({ provider: "openai", model: "" });
    await sessions.deliver("a", "two", 2);
    choose({ provider: "openai", model: "gpt-4.1" });
    await sessions.deliver("a", "three", 3);
    choose({ provider: "openai", model: "" });
    await sessions.deliver("a", "four", 4);
    choose({ provider: "", model: "" });
    await sessions.deliver("a", "five", 5);
    expect(fake.geese).toHaveLength(1);
    const [goose] = fake.geese;
    expect(goose?.opened[0]?._meta).not.toHaveProperty("provider");
    expect(goose?.closed).toEqual([]);
    expect(new Set(goose?.turns.map((turn) => turn.sessionId))).toEqual(
      new Set(["session-1"]),
    );
    // A provider alone runs on its default model; `goose` is goose's config.
    expect(goose?.configured).toEqual([
      "session-1 provider=openai",
      "session-1 model=gpt-4.1",
      "session-1 model=gpt-default",
      "session-1 provider=goose",
    ]);
  });

  it("opens a session on the agent's provider, and sets its model before the turn", async () => {
    const { fake, sessions, choose } = setup();
    choose({ provider: "openai", model: "gpt-4.1" });
    await sessions.deliver("a", "one", 1);
    const [goose] = fake.geese;
    expect(goose?.env).toMatchObject({
      GOOSE_PROVIDER: null,
      GOOSE_MODEL: null,
    });
    expect(goose?.opened[0]?._meta).toMatchObject({ provider: "openai" });
    expect(goose?.configured).toEqual(["session-1 model=gpt-4.1"]);
    const methods = goose?.received.map((message) => message.method) ?? [];
    expect(methods.indexOf("session/set_config_option")).toBeLessThan(
      methods.indexOf("session/prompt"),
    );
  });

  it("applies a provider change made during a turn at the next turn", async () => {
    const { fake, sessions, choose } = setup({}, true);
    const first = sessions.deliver("a", "one", 1);
    await flush(30);
    choose({ provider: "openai", model: "" });
    const second = sessions.deliver("a", "two", 2);
    await flush(30);
    const [goose] = fake.geese;
    expect(goose?.turns[0]?.steered).toEqual(["two"]);
    expect(goose?.configured).toEqual([]);
    goose?.turns[0]?.finish();
    await Promise.all([first, second]);
    const third = sessions.deliver("a", "three", 3);
    await flush(30);
    expect(goose?.configured).toEqual(["session-1 provider=openai"]);
    expect(goose?.turns.map((turn) => turn.text)).toEqual(["one", "three"]);
    goose?.turns[1]?.finish();
    await expect(third).resolves.toEqual({ ok: true });
    expect(fake.geese).toHaveLength(1);
  });

  it("runs a turn on the model its message asked for, and the next on the agent's", async () => {
    const { fake, sessions, choose } = setup();
    choose({ provider: "openai", model: "" });
    await sessions.deliver("a", "one", 1, { model: "gpt-4.1" });
    await sessions.deliver("a", "two", 2);
    expect(fake.geese[0]?.configured).toEqual([
      "session-1 model=gpt-4.1",
      "session-1 model=gpt-default",
    ]);
    expect(fake.geese[0]?.turns.map((turn) => turn.sessionId)).toEqual([
      "session-1",
      "session-1",
    ]);
  });

  it("puts the live session on a chosen thinking level, and a new one on goose's own", async () => {
    const { fake, sessions, choose } = setup();
    await sessions.deliver("a", "one", 1);
    choose({ provider: "", model: "", effort: "high" });
    await sessions.deliver("a", "two", 2);
    choose({ provider: "openai", model: "", effort: "high" });
    await sessions.deliver("a", "three", 3);
    choose({ provider: "openai", model: "", effort: "low" });
    await sessions.deliver("a", "four", 4);
    const [goose] = fake.geese;
    // goose keeps a level across providers: it is set only when it changes.
    expect(goose?.configured).toEqual([
      "session-1 thinking_effort=high",
      "session-1 provider=openai",
      "session-1 thinking_effort=low",
    ]);
    expect(goose?.closed).toEqual([]);
    // goose names no value for its own level, so only a new session is on
    // it; the next turn opens one.
    choose({ provider: "openai", model: "" });
    await flush();
    expect(goose?.closed).toEqual([]);
    await sessions.deliver("a", "five", 5);
    expect(goose?.closed).toEqual(["session-1"]);
    expect(goose?.turns.map((turn) => turn.sessionId).at(-1)).toBe("session-2");
    expect(goose?.configured).toHaveLength(3);
  });

  it("keeps the conversation across turns on a picked thinking level", async () => {
    const { fake, sessions } = setup();
    await sessions.deliver("a", "one", 1, { effort: "high" });
    await sessions.deliver("a", "two", 2, { effort: "high" });
    const [goose] = fake.geese;
    expect(goose?.closed).toEqual([]);
    expect(goose?.configured).toEqual(["session-1 thinking_effort=high"]);
    expect(goose?.turns.map((turn) => turn.sessionId)).toEqual([
      "session-1",
      "session-1",
    ]);
    // A turn without a pick runs on goose's own level, in a new session.
    await sessions.deliver("a", "three", 3);
    expect(goose?.closed).toEqual(["session-1"]);
    expect(goose?.turns.map((turn) => turn.sessionId).at(-1)).toBe("session-2");
    expect(goose?.configured).toHaveLength(1);
  });

  it("fails a turn goose cannot switch, and switches at the next", async () => {
    const { fake, sessions, choose } = setup();
    await sessions.deliver("a", "one", 1);
    const [goose] = fake.geese;
    if (goose) goose.configError = "Unknown provider";
    choose({ provider: "nope", model: "" });
    await expect(sessions.deliver("a", "two", 2)).resolves.toEqual({
      ok: false,
      error: "goose could not switch its provider to nope: Unknown provider",
      undelivered: true,
    });
    expect(goose?.turns).toHaveLength(1);
    if (goose) delete goose.configError;
    await expect(sessions.deliver("a", "three", 3)).resolves.toEqual({
      ok: true,
    });
    expect(goose?.configured).toEqual(["session-1 provider=nope"]);
    expect(goose?.turns.map((turn) => turn.text)).toEqual(["one", "three"]);
  });

  it("reopens an idle session in a new workspace, in the same goose", async () => {
    const { fake, sessions, change } = setup();
    await sessions.deliver("a", "one", 1);
    change({ workspace: "~/other" });
    await sessions.deliver("a", "two", 2);
    expect(fake.geese).toHaveLength(1);
    const [goose] = fake.geese;
    expect(goose?.closed).toEqual(["session-1"]);
    expect(goose?.opened.map((session) => session.cwd)).toEqual([
      "/home/test/.buzz",
      "/home/test/other",
    ]);
    expect(goose?.killed).toBe(false);
  });

  it("reports a failed immediate compaction", async () => {
    const { fake, sessions } = setup();
    // Without a session there is nothing to compact.
    await expect(sessions.reset("a", "compact")).resolves.toEqual({ ok: true });
    await sessions.deliver("a", "one", 1);
    const goose = fake.geese[0];
    expect(goose?.turns.map((turn) => turn.text)).toEqual(["one"]);
    if (goose) goose.hold = true;
    const compacted = sessions.reset("a", "compact");
    await flush(30);
    // goose ends a failed compaction like any turn, saying why in its text.
    goose?.update("session-1", {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "Request failed: Resource not found (404)",
      },
    });
    await flush(30);
    goose?.turns[1]?.finish();
    await expect(compacted).resolves.toEqual({
      ok: false,
      error: "Request failed: Resource not found (404)",
    });
    expect(goose?.turns).toHaveLength(2);
  });

  it("answers in a new session when asked to", async () => {
    const { fake, sessions } = setup();
    await sessions.deliver("a", "one", 1);
    await sessions.reset("a", "new");
    await sessions.deliver("a", "two", 2);
    expect(fake.geese[0]?.closed).toEqual(["session-1"]);
    expect(fake.geese[0]?.turns.map((turn) => turn.sessionId)).toEqual([
      "session-1",
      "session-2",
    ]);
  });

  it("closes a quiet conversation's session", async () => {
    vi.useFakeTimers();
    const { fake, sessions } = setup();
    await sessions.deliver("a", "one", 1);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(fake.geese[0]?.closed).toEqual(["session-1"]);
    expect(sessions.snapshot()).toEqual([]);
    expect(sessions.seen("a")).toBe(0);
  });

  it("saves when each conversation last used its session, after the session closes too", async () => {
    vi.useFakeTimers();
    const store = new Map<string, SavedConversation>();
    const { sessions } = setup({}, false, { store });
    await sessions.deliver("a", "one", 1);
    const at = sessions.snapshot()[0]?.at;
    expect(store.get("a")).toEqual({ at, sessions: ["session-1"] });
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(sessions.snapshot()).toEqual([]);
    expect(store.get("a")).toEqual({ at, sessions: ["session-1"] });
    // A one-off turn joins no conversation.
    await sessions.runOnce("watch/x", () => "look");
    expect([...store.keys()]).toEqual(["a"]);
  });

  it("keeps a conversation's session ids as each message and reopening saves it, newest first", async () => {
    vi.useFakeTimers();
    const store = new Map<string, SavedConversation>([
      [
        "a",
        { at: 1, sessions: Array.from({ length: 10 }, (_, i) => `old-${i}`) },
      ],
    ]);
    const { sessions } = setup({}, false, { store });
    await sessions.deliver("a", "one", 1);
    await sessions.deliver("a", "two", 2);
    const first = store.get("a")?.sessions;
    expect(first?.[0]).toBe(sessions.snapshot()[0]?.sessionId);
    expect(first).toHaveLength(10);
    expect(first?.at(-1)).toBe("old-8");
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    await sessions.deliver("a", "three", 3);
    const reopened = sessions.snapshot()[0]?.sessionId;
    expect(reopened).not.toBe(first?.[0]);
    expect(store.get("a")?.sessions?.slice(0, 3)).toEqual([
      reopened,
      first?.[0],
      "old-0",
    ]);
  });

  it("says which conversation each session started for, and none for a one-off turn", async () => {
    vi.useFakeTimers();
    const started = vi.fn();
    const { sessions } = setup({}, false, { started });
    await sessions.deliver("chan/root", "one", 1);
    await sessions.runOnce("watch/x", () => "look");
    expect(started.mock.calls.map((call) => call[3])).toEqual([
      "chan/root",
      undefined,
    ]);
  });

  it("keeps delivering past a damaged saved conversation, saving it afresh", async () => {
    vi.useFakeTimers();
    for (const sessions of [{ not: "a list" }, "s9", null, [7, "kept"]]) {
      const store = new Map([
        ["a", { at: 1, sessions } as unknown as SavedConversation],
      ]);
      const { sessions: agent } = setup({}, false, { store });
      await agent.deliver("a", "one", 1);
      const id = agent.snapshot()[0]?.sessionId;
      expect(store.get("a")?.sessions).toEqual(
        Array.isArray(sessions) ? [id, "kept"] : [id],
      );
    }
  });

  it("dates a session by the messages it takes in and the turns it ends, not by a long turn keeping it open", async () => {
    vi.useFakeTimers();
    const { fake, sessions } = setup({}, true);
    const at = () => sessions.snapshot()[0]?.at ?? 0;
    const done = sessions.deliver("a", "one", 1);
    await vi.advanceTimersByTimeAsync(10);
    const started = at();
    expect(started).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1);
    expect(sessions.snapshot()).toMatchObject([{ key: "a", busy: true }]);
    expect(at()).toBe(started);
    fake.geese[0]?.turns[0]?.finish();
    await done;
    expect(at()).toBeGreaterThan(started);
  });

  it("drops every agent's sessions when goose exits, and starts it again", async () => {
    const { fake, sessions, agent } = setup();
    const other = agent();
    await sessions.deliver("a", "one", 1);
    await other.sessions.deliver("a", "two", 2);
    fake.geese[0]?.exit(1, "crashed");
    await flush(30);
    expect(sessions.snapshot()).toEqual([]);
    expect(other.sessions.snapshot()).toEqual([]);
    await expect(sessions.deliver("a", "three", 3)).resolves.toEqual({
      ok: true,
    });
    await expect(other.sessions.deliver("a", "four", 4)).resolves.toEqual({
      ok: true,
    });
    expect(fake.geese).toHaveLength(2);
    expect(fake.geese[1]?.opened).toHaveLength(2);
  });

  it("saves no conversation whose first message gave up before the session opened", async () => {
    const fake = fakeSpawn();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new Map<string, SavedConversation>();
    const sessions = new AgentSessions({
      resolveDirectory: fake.resolveDirectory,
      tools,
      process: new AgentProcess(fake, fake.serve),
      pool: new ServerPool(),
      store,
      launch: async () => {
        await held;
        return { workspace: "/w", systemPrompt: "" };
      },
      choice: () => ({ provider: "", model: "" }),
      fingerprint: () => "",
    });
    const abort = new AbortController();
    const late = sessions.deliver("a", "one", 1, { signal: abort.signal });
    await flush(30);
    abort.abort();
    await expect(late).resolves.toMatchObject({ ok: false });
    release();
    await flush(30);
    expect(sessions.snapshot()).toMatchObject([{ key: "a" }]);
    expect(store.size).toBe(0);
    await sessions.deliver("a", "two", 2);
    expect(store.has("a")).toBe(true);
    sessions.dispose();
  });

  it("reports why goose could not start", async () => {
    const fake = fakeSpawn({ http: false });
    const sessions = new AgentSessions({
      resolveDirectory: fake.resolveDirectory,
      tools,
      process: new AgentProcess(fake, fake.serve),
      pool: new ServerPool(),
      launch: async () => ({ workspace: "/w", systemPrompt: "" }),
      choice: () => ({ provider: "", model: "" }),
      fingerprint: () => "",
    });
    await expect(sessions.deliver("a", "one", 1)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/HTTP MCP/),
      undelivered: true,
    });
  });

  it("starts no goose for an agent removed while its sessions open", async () => {
    const fake = fakeSpawn();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launch = vi.fn(async () => {
      await held;
      return { workspace: "/w", systemPrompt: "" };
    });
    const sessions = new AgentSessions({
      resolveDirectory: fake.resolveDirectory,
      tools,
      process: new AgentProcess(fake, fake.serve),
      pool: new ServerPool(),
      launch,
      choice: () => ({ provider: "", model: "" }),
      fingerprint: () => "",
    });
    const delivering = sessions.deliver("a", "one", 1);
    const once = sessions.runOnce("watch/x", () => "look");
    await flush(30);
    expect(launch).toHaveBeenCalledTimes(2);
    sessions.dispose();
    release();
    await expect(delivering).resolves.toEqual({
      ok: false,
      error: "goose was stopped",
      undelivered: true,
    });
    await expect(once).resolves.toMatchObject({ ok: false });
    await flush(30);
    expect(fake.geese).toEqual([]);
  });

  it("runs a one-off turn in a session it then closes", async () => {
    const { fake, sessions } = setup();
    await expect(sessions.runOnce("watch/x", () => "look")).resolves.toEqual({
      ok: true,
    });
    const [goose] = fake.geese;
    expect(goose?.turns.map((turn) => turn.text)).toEqual(["look"]);
    expect(goose?.closed).toEqual(["session-1"]);
    expect(goose?.killed).toBe(false);
    expect(sessions.snapshot()).toEqual([]);
  });

  it("stops a one-off turn when its signal aborts", async () => {
    const { fake, sessions } = setup({}, true);
    const abort = new AbortController();
    const running = sessions.runOnce("timer/x", () => "wait", {
      signal: abort.signal,
    });
    await flush(30);
    abort.abort(new Error("The turn ran past its deadline"));
    await expect(running).resolves.toEqual({
      ok: false,
      error: "The turn ran past its deadline",
    });
    expect(fake.geese[0]?.cancelled).toEqual(["session-1"]);
  });

  it("gives up a one-off turn whose session is still opening, and closes it once open", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fake, sessions, pool } = setup({}, false, {
      serve: (serve) => async (handler) => {
        await gate;
        return serve(handler);
      },
    });
    const abort = new AbortController();
    const prompt = vi.fn(() => "look");
    const running = sessions.runOnce("watch/x", prompt, {
      signal: abort.signal,
    });
    await flush(30);
    abort.abort(new Error("The agent was removed"));
    await expect(running).resolves.toEqual({
      ok: false,
      error: "The agent was removed",
    });
    release();
    await flush(30);
    expect(prompt).not.toHaveBeenCalled();
    expect(fake.geese[0]?.closed).toEqual(["session-1"]);
    expect(fake.servers.map((server) => server.closed)).toEqual([true]);
    expect(pool.size).toBe(0);
  });

  it("opens one replacement session for messages that arrive while it reopens", async () => {
    vi.useFakeTimers();
    const { fake, sessions, pool, change } = setup();
    await sessions.deliver("a", "one", 1);
    change({ systemPrompt: "newer" }, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Rebuilding the conversation for the new session is held open.
    const fresh = vi.fn(async () => {
      await gate;
      return "everything so far";
    });
    const first = sessions.deliver("a", "two", 2, { fresh });
    const second = sessions.deliver("a", "three", 3, { fresh });
    await flush(30);
    expect(fresh).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
    const [goose] = fake.geese;
    expect(goose?.opened).toHaveLength(2);
    expect(goose?.turns.map((turn) => [turn.sessionId, turn.text])).toEqual([
      ["session-1", "one"],
      ["session-2", "everything so far"],
      ["session-2", "three"],
    ]);
    expect(sessions.snapshot()).toEqual([
      { key: "a", busy: false, sessionId: "session-2", at: Date.now() },
    ]);
    // Nothing is left open once the conversation goes quiet.
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(goose?.closed).toEqual(["session-1", "session-2"]);
    expect(fake.servers.map((server) => server.closed)).toEqual([true, true]);
    expect(pool.size).toBe(0);
  });

  it("stops waiting for a session that opens too late, and keeps it for the next message", async () => {
    const { fake, sessions, change } = setup();
    await sessions.deliver("a", "one", 1);
    change({ systemPrompt: "newer" }, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fresh = async () => {
      await gate;
      return "everything so far";
    };
    const abort = new AbortController();
    const late = sessions.deliver("a", "two", 2, {
      fresh,
      signal: abort.signal,
    });
    await flush(30);
    abort.abort();
    await expect(late).resolves.toEqual({
      ok: false,
      error: "goose did not start in time",
      undelivered: true,
    });
    release();
    await flush(30);
    await sessions.deliver("a", "three", 3);
    const [goose] = fake.geese;
    expect(goose?.opened).toHaveLength(2);
    expect(goose?.turns.map((turn) => [turn.sessionId, turn.text])).toEqual([
      ["session-1", "one"],
      ["session-2", "three"],
    ]);
  });

  it("sends nothing for a message that gives up waiting on another's session", async () => {
    const { fake, sessions, change } = setup();
    await sessions.deliver("a", "one", 1);
    change({ systemPrompt: "newer" }, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fresh = async () => {
      await gate;
      return "everything so far";
    };
    const opening = sessions.deliver("a", "two", 2, { fresh });
    await flush(30);
    const abort = new AbortController();
    const expired = sessions.deliver("a", "three", 3, {
      signal: abort.signal,
    });
    await flush(30);
    abort.abort();
    await expect(expired).resolves.toEqual({
      ok: false,
      error: "goose did not start in time",
      undelivered: true,
    });
    release();
    await expect(opening).resolves.toEqual({ ok: true });
    await flush(30);
    const [goose] = fake.geese;
    expect(goose?.turns.map((turn) => [turn.sessionId, turn.text])).toEqual([
      ["session-1", "one"],
      ["session-2", "everything so far"],
    ]);
    expect(goose?.turns[1]?.steered).toEqual([]);
  });

  it("stops a goose that hangs opening a session", async () => {
    vi.useFakeTimers();
    const { fake, sessions, pool } = setup({}, false, {
      silent: ["session/new"],
    });
    const opening = sessions.deliver("a", "one", 1);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await expect(opening).resolves.toEqual({
      ok: false,
      error: "goose could not start: goose did not answer session/new in 60s",
      undelivered: true,
    });
    expect(fake.geese[0]?.killed).toBe(true);
    expect(fake.servers.map((server) => server.closed)).toEqual([true]);
    expect(pool.size).toBe(0);
  });

  it("closes the least recently used idle session of any agent to make room", async () => {
    const pool = new ServerPool(2);
    const { fake, sessions: one, agent } = setup({}, false, { pool });
    const two = agent().sessions;
    await one.deliver("a", "one", 1);
    await one.deliver("b", "two", 2);
    await one.deliver("a", "three", 3);
    // `b` is now the least recently used.
    const [goose] = fake.geese;
    if (goose) goose.hold = true;
    const working = two.deliver("c", "four", 4);
    await flush(30);
    expect(goose?.closed).toEqual(["session-2"]);
    expect(one.snapshot().map((live) => live.key)).toEqual(["a"]);
    // `c` is working, so `a` closes for the next.
    if (goose) goose.hold = false;
    await one.deliver("d", "five", 5);
    expect(goose?.closed).toEqual(["session-2", "session-1"]);
    expect(two.snapshot().map((live) => live.key)).toEqual(["c"]);
    expect(pool.size).toBe(2);
    goose?.turns.find((turn) => turn.text === "four")?.finish();
    await working;
  });

  it("never closes a new session to make room before its first message is sent", async () => {
    const pool = new ServerPool(1);
    let evicted: unknown;
    const { fake, sessions } = setup({}, false, {
      pool,
      // Another conversation needs a server the moment this session opens.
      onChange: () => {
        if (fake.geese[0]?.turns.length) return;
        evicted ??= pool.evict() ?? null;
      },
    });
    await expect(sessions.deliver("a", "one", 1)).resolves.toEqual({
      ok: true,
    });
    expect(evicted).toBeNull();
    expect(fake.geese[0]?.turns.map((turn) => turn.text)).toEqual(["one"]);
  });

  it("asks for a server only once the session closed to make room has stopped", async () => {
    const pool = new ServerPool(1);
    const { release, serve } = host(1);
    const { fake, sessions } = setup({}, false, { pool, serve });
    await sessions.deliver("a", "one", 1);
    const second = sessions.deliver("b", "two", 2);
    await flush(30);
    expect(fake.geese[0]?.closed).toEqual(["session-1"]);
    expect(fake.servers).toHaveLength(1);
    release();
    await expect(second).resolves.toEqual({ ok: true });
    expect(sessions.snapshot().map((live) => live.key)).toEqual(["b"]);
  });

  it("makes room and tries once more when the host has no server free", async () => {
    // Other plugins hold the host's other servers.
    const { release, serve } = host(1);
    const { fake, sessions } = setup({}, false, { serve });
    await sessions.deliver("a", "one", 1);
    const second = sessions.deliver("b", "two", 2);
    await flush(30);
    expect(fake.geese[0]?.closed).toEqual(["session-1"]);
    expect(fake.servers).toHaveLength(1);
    release();
    await expect(second).resolves.toEqual({ ok: true });
    expect(sessions.snapshot().map((live) => live.key)).toEqual(["b"]);
  });

  it("closes only its own sessions when disposed, ending their turns", async () => {
    const { fake, sessions, agent } = setup();
    const other = agent();
    await other.sessions.deliver("a", "one", 1);
    const [goose] = fake.geese;
    if (goose) goose.hold = true;
    const working = sessions.deliver("a", "two", 2);
    await flush(30);
    sessions.dispose();
    await expect(working).resolves.toEqual({
      ok: false,
      error: "The session was closed",
    });
    await flush(30);
    expect(goose?.closed).toEqual(["session-2"]);
    expect(goose?.killed).toBe(false);
    await expect(sessions.deliver("a", "three", 3)).resolves.toMatchObject({
      ok: false,
    });
    expect(other.sessions.snapshot().map((live) => live.key)).toEqual(["a"]);
  });
});

/** `work`, and whether it has settled. */
const tracked = <T>(work: Promise<T>) => {
  const state = { settled: false, work };
  const settle = () => {
    state.settled = true;
  };
  work.then(settle, settle);
  return state;
};

describe("AgentSessions shutdown", () => {
  it.each(["a conversation", "a one-off turn", "a one-off turn given up"])(
    "waits for a session still opening for %s, and closes it once open",
    async (kind) => {
      const held = gated("session/new");
      const { fake, sessions } = setup({}, false, { wrap: held.wrap });
      const abort = new AbortController();
      const turn =
        kind === "a conversation"
          ? sessions.deliver("a", "one", 1)
          : sessions.runOnce("watch/x", () => "look", {
              signal: abort.signal,
            });
      await vi.waitFor(() => expect(held.waiting()).toHaveLength(1));
      if (kind === "a one-off turn given up")
        abort.abort(new Error("The agent was removed"));
      const shutdown = tracked(sessions.shutdown());
      await flush(30);
      expect(shutdown.settled).toBe(false);
      held.release();
      await shutdown.work;
      expect(fake.geese[0]?.closed).toEqual(["session-1"]);
      expect(fake.geese[0]?.turns).toEqual([]);
      await turn;
    },
  );

  it("creates no session for a delivery still rebuilding its text", async () => {
    const { fake, sessions, change } = setup();
    await sessions.deliver("a", "one", 1);
    change({ systemPrompt: "newer" });
    let release!: () => void;
    const rebuilding = new Promise<void>((resolve) => {
      release = resolve;
    });
    const late = sessions.deliver("a", "two", 2, {
      fresh: async () => {
        await rebuilding;
        return "two again";
      },
    });
    await flush(30);
    await sessions.shutdown();
    release();
    await expect(late).resolves.toEqual({
      ok: false,
      error: "goose was stopped",
      undelivered: true,
    });
    expect(fake.geese[0]?.opened).toHaveLength(1);
    expect(fake.servers).toHaveLength(1);
  });

  it("waits for every close, then rejects with the one that failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const held = gated("session/close", (id) => id === "session-1");
    const { sessions } = setup({}, false, { wrap: held.wrap });
    await sessions.deliver("a", "one", 1);
    await sessions.deliver("b", "two", 2);
    const shutdown = tracked(sessions.shutdown());
    await vi.waitFor(() =>
      expect(held.waiting()).toEqual(["session-1", "session-2"]),
    );
    held.release("session-1");
    await flush(30);
    expect(shutdown.settled).toBe(false);
    held.release();
    await expect(shutdown.work).rejects.toThrow("No active run");
  });

  it("waits for a close an idle session's eviction started", async () => {
    const held = gated("session/close");
    const { sessions, change } = setup({}, false, { wrap: held.wrap });
    await sessions.deliver("a", "one", 1);
    change({ systemPrompt: "newer" });
    await vi.waitFor(() => expect(held.waiting()).toEqual(["session-1"]));
    const shutdown = tracked(sessions.shutdown());
    await flush(30);
    expect(shutdown.settled).toBe(false);
    held.release();
    await shutdown.work;
  });

  it("fails again on retry while a close stays failed, and passes once goose has exited", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const held = gated("session/close", () => true);
    const { fake, sessions, change } = setup({}, false, { wrap: held.wrap });
    await sessions.deliver("a", "one", 1);
    change({ systemPrompt: "newer" });
    await vi.waitFor(() => expect(held.waiting()).toEqual(["session-1"]));
    held.release();
    await expect(sessions.shutdown()).rejects.toThrow("No active run");
    await expect(sessions.shutdown()).rejects.toThrow("No active run");
    fake.geese[0]?.exit(null);
    await flush(30);
    await expect(sessions.shutdown()).resolves.toBeUndefined();
  });
});

it("keeps a worker whose initialize failed until it has exited, though its start fails at the time limit", async () => {
  vi.useFakeTimers();
  const fake = fakeSpawn();
  let kills = 0;
  const spawn: typeof fake.spawn = async (id, options = {}) => {
    const process = await fake.spawn(id, options);
    return {
      ...process,
      write: async (data) => {
        if (!data.includes('"method":"initialize"')) return process.write(data);
        const { id: request } = JSON.parse(data);
        options.onStdout?.(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request,
            error: { code: -32603, message: "init failed" },
          })}\n`,
        );
      },
      // Asked to stop, it exits only once the test lets it.
      kill: async () => void kills++,
    };
  };
  const process = new AgentProcess({ ...fake, spawn }, fake.serve);
  const starting = tracked(process.get());
  // A failed start waits 5 s for its worker to exit, then fails anyway.
  await vi.advanceTimersByTimeAsync(4_999);
  expect(kills).toBe(1);
  expect(starting.settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(starting.settled).toBe(true);
  await expect(starting.work).rejects.toThrow("init failed");
  // Asked for again while it is exiting, it is the same failed start.
  const again = process.get();
  expect(again).toBe(starting.work);
  await flush(30);
  expect(fake.geese).toHaveLength(1);
  const shutdown = tracked(process.shutdown());
  await vi.advanceTimersByTimeAsync(5_000);
  await flush(30);
  expect(shutdown.settled).toBe(false);
  expect(kills).toBe(2);
  fake.geese[0]?.exit(null);
  await shutdown.work;
  await expect(again).rejects.toThrow("init failed");
  // Once it has exited, the next call starts another.
  const retry = process.get();
  retry.catch(() => undefined);
  await flush(30);
  expect(fake.geese).toHaveLength(2);
  fake.geese[1]?.exit(null);
  await expect(retry).rejects.toThrow("init failed");
});

it("repeats a failed kill on the next retirement", async () => {
  const fake = fakeSpawn();
  let kills = 0;
  const spawn: typeof fake.spawn = async (id, options) => ({
    ...(await fake.spawn(id, options)),
    // The first kill fails; it exits only once the test lets it.
    kill: async () => {
      if (++kills === 1) throw new Error("kill failed");
    },
  });
  const process = new AgentProcess({ ...fake, spawn }, fake.serve);
  await process.get();
  await expect(process.shutdown()).rejects.toThrow("kill failed");
  const shutdown = tracked(process.shutdown());
  await flush(30);
  expect(kills).toBe(2);
  expect(shutdown.settled).toBe(false);
  fake.geese[0]?.exit(null);
  await shutdown.work;
});

it("keeps saved conversations per agent in storage, most recent first", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  } as Storage;
  const one = localSessions(storage, "one");
  one.set("c/root", { at: 1 });
  one.set("dm", { at: 3 });
  localSessions(storage, "two").set("c/root", { at: 2 });
  expect(localSessions(storage, "one").list()).toEqual([
    ["dm", { at: 3 }],
    ["c/root", { at: 1 }],
  ]);
  expect(localSessions(storage, "two").list()).toEqual([["c/root", { at: 2 }]]);
  expect(one.get("dm")).toEqual({ at: 3 });
  one.set("dm", { at: 4, sessions: ["s1"] });
  expect(localSessions(storage, "one").get("dm")).toEqual({
    at: 4,
    sessions: ["s1"],
  });
  data.set(
    "buzz.goose.sessions.v1",
    JSON.stringify({
      one: {
        kept: {
          at: 5,
          sessions: [
            "s1",
            "s1",
            3,
            "x".repeat(300),
            ...Array.from({ length: 12 }, (_, i) => `n${i}`),
          ],
        },
        legacy: { at: 4 },
        list: { at: 6, sessions: { 0: "s" } },
        infinite: { at: null },
        far: { at: -1e20 },
        empty: null,
      },
      two: "damaged",
    }),
  );
  expect(one.list()).toEqual([
    [
      "kept",
      {
        at: 5,
        sessions: ["s1", ...Array.from({ length: 9 }, (_, i) => `n${i}`)],
      },
    ],
    ["legacy", { at: 4 }],
  ]);
  expect(localSessions(storage, "two").list()).toEqual([]);
  data.set("buzz.goose.sessions.v1", "not json");
  expect(one.list()).toEqual([]);
});

it("drops a source delivery invalidated during session startup", async () => {
  const fake = fakeSpawn();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sessions = new AgentSessions({
    resolveDirectory: fake.resolveDirectory,
    tools,
    process: new AgentProcess(fake, fake.serve),
    pool: new ServerPool(),
    launch: async () => {
      await held;
      return { workspace: "/w", systemPrompt: "" };
    },
    choice: () => ({ provider: "", model: "" }),
    fingerprint: () => "",
  });
  let current = true;
  const late = sessions.deliver("source", "cancelled wake", 1, {
    current: () => current,
  });
  await flush(30);
  current = false;
  release();
  await expect(late).resolves.toMatchObject({ undelivered: true });
  await sessions.deliver("other", "ordinary message", 2);
  expect(
    fake.geese
      .flatMap((g) => g.turns)
      .some((t) => JSON.stringify(t).includes("cancelled wake")),
  ).toBe(false);
  sessions.dispose();
});

it.each([false, true])(
  "keeps history unseen when a source is cancelled during provider selection (existing: %s)",
  async (existing) => {
    const fake = fakeSpawn();
    let release!: () => void;
    let selecting!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      selecting = resolve;
    });
    const spawn: typeof fake.spawn = async (id, options) => {
      const process = await fake.spawn(id, options);
      return {
        ...process,
        write: async (data) => {
          if (
            id === "goose" &&
            data.includes('"method":"session/set_config_option"')
          ) {
            selecting();
            await held;
          }
          return process.write(data);
        },
      };
    };
    let choice: Choice = { provider: "", model: "" };
    const sessions = new AgentSessions({
      resolveDirectory: fake.resolveDirectory,
      tools,
      process: new AgentProcess({ ...fake, spawn }, fake.serve),
      pool: new ServerPool(),
      launch: async () => ({ workspace: "/w", systemPrompt: "" }),
      choice: () => choice,
      fingerprint: () => "",
    });
    if (existing) await sessions.deliver("source", "earlier", 1);
    choice = { provider: "openai", model: "gpt-4.1" };
    let current = true;
    const late = sessions.deliver("source", "cancelled history", 10, {
      current: () => current,
    });
    try {
      await started;
      current = false;
    } finally {
      release();
    }
    await expect(late).resolves.toMatchObject({ undelivered: true });
    expect(sessions.seen("source")).toBe(existing ? 1 : 0);
    await sessions.deliver("source", "ordinary message with history", 5);
    expect(sessions.seen("source")).toBe(5);
    expect(fake.geese.flatMap((g) => g.turns).map((t) => t.text)).toEqual([
      ...(existing ? ["earlier"] : []),
      "ordinary message with history",
    ]);
    sessions.dispose();
  },
);

it("drops standalone output invalidated after its prompt is built", async () => {
  const { sessions, fake } = setup();
  let current = true;
  const result = await sessions.runOnce(
    "source/check",
    () => {
      current = false;
      return "cancelled output";
    },
    { current: () => current },
  );
  expect(result.ok).toBe(true);
  expect(fake.geese.flatMap((process) => process.turns)).toEqual([]);
  sessions.dispose();
});

it.each(["startup", "provider"] as const)(
  "refreshes an Attention prompt after %s waits",
  async (boundary) => {
    const fake = fakeSpawn();
    let release!: () => void;
    let waiting!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const spawn: typeof fake.spawn = async (id, options) => {
      const process = await fake.spawn(id, options);
      return {
        ...process,
        write: async (data) => {
          if (
            boundary === "provider" &&
            id === "goose" &&
            data.includes('"method":"session/set_config_option"')
          ) {
            waiting();
            await gate;
          }
          return process.write(data);
        },
      };
    };
    const sessions = new AgentSessions({
      resolveDirectory: fake.resolveDirectory,
      tools,
      process: new AgentProcess({ ...fake, spawn }, fake.serve),
      pool: new ServerPool(),
      launch: async () => {
        if (boundary === "startup") {
          waiting();
          await gate;
        }
        return { workspace: "/w", systemPrompt: "" };
      },
      choice: () => ({ provider: "openai", model: "gpt-4.1" }),
      fingerprint: () => "",
    });
    let instructions = "Old Interest instructions";
    const late = sessions.deliver("source", instructions, 1, {
      refresh: async () => instructions,
    });
    try {
      await started;
      instructions = "Updated Interest instructions";
    } finally {
      release();
    }
    await late;
    expect(fake.geese.flatMap((g) => g.turns).map((t) => t.text)).toEqual([
      instructions,
    ]);
    sessions.dispose();
  },
);
