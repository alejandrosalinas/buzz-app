import { describe, expect, it, vi } from "vitest";
import type { BuzzClient, Memories, OwnerAccess } from "../../buzz-mcp/client";
import { callTool, memoryVersion } from "../../buzz-mcp/tools";
import { createAgentMemories } from "../../features/agents/memory";
import {
  promptMessage,
  promptSections,
} from "../../features/agents/activity-transcript";
import { RESUMED_PROMPT, TOP_LEVEL_PROMPT } from "../../buzz-mcp/prompt";
import type { Agent, Delivery } from "../../features/agents/service";
import type { AgentProtection } from "../../features/agent-protection/service";
import type { Host } from "../../features/host/service";
import type { EventData, RelayEvent } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { fakeSpawn, flush, gated } from "./goose-testing";
import { REQUEST_TIMEOUT_MS } from "./goose";
import { AcpSession } from "../../features/agent-harness/acp/session";
import { AgentSessions, AgentProcess } from "./sessions";
import {
  DEFAULT_CONFIG,
  GooseRuntime,
  sessionTitle,
  standalonePrompt,
} from "./runtime";

describe("sessionTitle", () => {
  it("names the agent, the channel and a thread's root", () => {
    expect(sessionTitle("Ada", "#general", "0123456789abcdef")).toBe(
      "Ada · #general · 01234567",
    );
    expect(sessionTitle(undefined, "DM")).toBe("Buzz agent · DM");
  });

  it("keeps the root when a long name is cut", () => {
    const title = sessionTitle("A".repeat(100), "#general", "0123456789");
    expect(title).toHaveLength(80);
    expect(title.endsWith(" · 01234567")).toBe(true);
  });
});

const self = "c".repeat(64);
const alice = "a".repeat(64);
const channel = "chan-1";
const message = (
  id: string,
  content: string,
  extra: Partial<EventData> = {},
): RelayEvent =>
  ({
    id: id.repeat(64).slice(0, 64),
    pubkey: alice,
    kind: 9,
    created_at: 100 + Number(id),
    content,
    tags: [
      ["h", channel],
      ["p", self],
    ],
    sig: "",
    ...extra,
  }) as RelayEvent;

/** A runtime for one agent of Alice's in `channel`, with fake goose. */
function setup(
  options: Readonly<{
    /** Channels that are the owner's own Solo chats; the owner is the viewer. */
    solo?: Set<string>;
    hold?: boolean;
    reply?: string;
    thread?: readonly EventData[];
    scope?: "thread" | "channel";
    /** The agent's `core` memory as the host keeps it. */
    core?: string | null;
    /** The channel's Canvas. */
    canvas?: string;
    repositories?: (scope: string | undefined) => string;
    protection?: AgentProtection;
    /** The owner session's native memory read. */
    memoryRead?: (
      pubkey: string,
      signal: AbortSignal,
      slug?: string,
    ) => Promise<Memories>;
    thinking?: NonNullable<Parameters<typeof fakeSpawn>[0]>["thinking"];
    /** Wraps the fake's `spawn`, as `gated(…).wrap` does. */
    wrap?: (spawn: ReturnType<typeof fakeSpawn>["spawn"]) => Host["spawn"];
  }> = {},
) {
  const fake = fakeSpawn({
    hold: options.hold ?? false,
    ...(options.protection && {
      history: [
        {
          sessionId: "session-1",
          title: "Protected conversation",
          cwd: "/home/test",
          updatedAt: "2026-10-29T00:00:00Z",
          conversation: [],
        },
      ],
    }),
    ...(options.thinking ? { thinking: options.thinking } : {}),
    ...(options.reply ? { reply: options.reply } : {}),
  });
  const readFile = vi.fn<NonNullable<Host["readFile"]>>();
  const spawnGoose = options.wrap?.(fake.spawn) ?? fake.spawn;
  const spawn = vi.fn<NonNullable<Host["spawn"]>>(async (id, options) => {
    if (id !== "read-protected") return spawnGoose(id, options);
    options?.onStdout?.(btoa("Private notes"));
    return {
      write: vi.fn(),
      end: vi.fn(),
      kill: vi.fn(),
      exited: Promise.resolve(0),
    };
  });
  const host = {
    spawn,
    resolveDirectory: fake.resolveDirectory,
    readFile,
    serveMcp: fake.serve,
    request: vi.fn(),
  } as unknown as Host;
  const read = vi.fn(async () => options.thread ?? []);
  const memories = {
    snapshot: () => ({ status: "ready", listing: { entries: [] } }),
    subscribe: () => () => {},
    refresh: async () => {},
    dispose: () => {},
  };
  const session = {
    read,
    agentMemories: {
      open: vi.fn(() => memories),
      ...(options.memoryRead ? { read: options.memoryRead } : {}),
    },
    channels: {
      list: () => ({
        channels: [
          {
            id: channel,
            name: "general",
            channelType: options.solo?.has(channel) ? "solo" : "stream",
            members: [],
          },
        ],
      }),
    },
    names: { resolve: (pubkey: string) => (pubkey === alice ? "Alice" : "") },
    profiles: {
      ensure: vi.fn(async () => {}),
      snapshot: () => new Map(),
    },
    channelWrites: { startingCanvas: () => undefined },
    canvas: {
      available: options.canvas !== undefined,
      read: vi.fn(async () =>
        options.canvas === undefined
          ? null
          : {
              pubkey: alice,
              kind: 40100,
              created_at: 1,
              tags: [],
              content: options.canvas,
            },
      ),
    },
  };
  // A reconnect is a new session to the same community.
  let connected = session;
  const relay = {
    snapshot: () => ({
      status: "ready",
      session: connected,
      viewer: alice,
      scope: `https://goose.example:${alice}`,
    }),
  } as unknown as RelayData;
  const core = vi.fn(async () => options.core);
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  } as Storage;
  const runtime = new GooseRuntime(
    host,
    () => relay,
    core,
    storage,
    undefined,
    options.repositories,
  );
  const published: { kind: number; content: string; tags: string[][] }[] = [];
  const agent = {
    key: self,
    pubkey: self,
    name: "Gander",
    owner: alice,
    ...(options.protection && { protection: options.protection }),
    publish: vi.fn(async (template: (typeof published)[number]) => {
      published.push(template);
      return {
        ...message(String(published.length), template.content),
        ...template,
      };
    }),
    query: vi.fn(async () => [] as RelayEvent[]),
    remember: vi.fn(async () => {}),
  };
  const run = (trigger: Delivery["trigger"], extra: Partial<Delivery> = {}) =>
    runtime.run({
      trigger,
      channelId: channel,
      agent,
      config: { ...DEFAULT_CONFIG, scope: options.scope ?? "thread" },
      signal: new AbortController().signal,
      workingUntil: () => undefined,
      ...extra,
    } as unknown as Delivery);
  const deliver = (event: RelayEvent, extra: Partial<Delivery> = {}) =>
    run({ type: "mention", event }, extra);
  const goose = () => fake.geese.find((process) => process.turns.length);
  const runOnce = (key: string, prompt: string) =>
    runtime.runOnce({
      delivery: {
        agent,
        channelId: channel,
        config: DEFAULT_CONFIG,
      },
      key,
      signal: new AbortController().signal,
      prompt: async () => prompt,
    } as unknown as Parameters<GooseRuntime["runOnce"]>[0]);
  return {
    agent,
    core,
    deliver,
    run,
    runOnce,
    fake,
    goose,
    published,
    read,
    readFile,
    runtime,
    spawn,
    memoryOpen: session.agentMemories.open,
    reconnect: () => {
      connected = { ...session };
    },
  };
}

it("reads a protected Goose file under containment and reviews the captured text before sending", async () => {
  const check = vi.fn<AgentProtection["check"]>().mockResolvedValue();
  const protection: AgentProtection = {
    key: "policy",
    stateKey: "revision",
    assertAvailable() {},
    check,
    processProtection: {
      readOnlyPaths: ["/controls"],
      hiddenPaths: ["/approval"],
    },
    spawn: (options) => f.fake.spawn("goose", options),
  };
  const f = setup({ hold: true, protection });
  try {
    await f.deliver(message("1", "Post my notes"));
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const process = f.goose();
    const sessionId = process?.turns[0]?.sessionId;
    if (!process || !sessionId) throw new Error("Goose turn did not start");
    expect(
      (
        await process.mcp(sessionId, "tools/call", {
          name: "send",
          arguments: { audience: "everyone", path: "notes.md" },
        })
      ).result,
    ).not.toMatchObject({ isError: true });
    expect(f.spawn).toHaveBeenCalledExactlyOnceWith(
      "read-protected",
      expect.objectContaining({
        cwd: DEFAULT_CONFIG.workspace,
        args: ["notes.md"],
        protection: protection.processProtection,
      }),
    );
    expect(f.readFile).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tool",
        content: expect.objectContaining({
          arguments: { audience: "everyone", text: "Private notes" },
        }),
      }),
      expect.anything(),
    );
    expect(f.published.at(-1)?.content).toBe("Private notes");
  } finally {
    f.runtime.dispose();
  }
});

it("leaves a protected Buzz tool call to Goose's own tool review", async () => {
  const check = vi.fn<AgentProtection["check"]>().mockResolvedValue();
  const protection: AgentProtection = {
    key: "policy",
    stateKey: "revision",
    assertAvailable() {},
    check,
    processProtection: { readOnlyPaths: [], hiddenPaths: [] },
    spawn: (options) => f.fake.spawn("goose", options),
  };
  const f = setup({ hold: true, protection });
  try {
    await f.deliver(message("1", "Say hi"));
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const process = f.goose();
    const sessionId = process?.turns[0]?.sessionId;
    if (!process || !sessionId) throw new Error("Goose turn did not start");
    await process.mcp(sessionId, "tools/call", {
      name: "send",
      arguments: { audience: "everyone", text: "Howzit!" },
    });
    expect(check.mock.calls.map(([action]) => action.kind)).toEqual([
      "tool-result",
    ]);
    expect(f.published.at(-1)?.content).toBe("Howzit!");
  } finally {
    f.runtime.dispose();
  }
});

const protection = (key: string, f: () => ReturnType<typeof setup>) =>
  ({
    key,
    stateKey: "revision",
    processProtection: { readOnlyPaths: [], hiddenPaths: [] },
    assertAvailable: () => {},
    check: async () => {},
    spawn: (options) => f().fake.spawn("goose", options),
  }) satisfies AgentProtection;

it("starts a replacement provider's Goose worker once the previous one has exited", async () => {
  const f = setup({ protection: protection("policy-1", () => f) });
  try {
    await f.deliver(message("1", "First"));
    await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
    Object.assign(f.agent, { protection: protection("policy-2", () => f) });
    await f.deliver(message("2", "Second"));
    await vi.waitFor(() => expect(f.fake.geese[1]?.turns).toHaveLength(1));
    expect(f.fake.geese[0]?.killed).toBe(true);
  } finally {
    f.runtime.dispose();
  }
});

/** `protection(…)` whose worker, once killed, runs until the test calls its
 * `exit`, as a worker in its kill grace does. */
const holdingKill = (key: string, f: () => ReturnType<typeof setup>) =>
  ({
    ...protection(key, f),
    spawn: async (options) => {
      const process = await f().fake.spawn("goose", options);
      const goose = f().fake.geese.at(-1);
      return {
        ...process,
        kill: async () => {
          if (goose) goose.killed = true;
        },
      };
    },
  }) satisfies AgentProtection;

/** Replaces the provider twice while the first worker is in its kill grace,
 * with a turn waiting for a worker after each. */
async function replacedTwice(f: ReturnType<typeof setup>) {
  await f.deliver(message("1", "First"));
  await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
  Object.assign(f.agent, { protection: protection("policy-2", () => f) });
  const second = f.deliver(message("2", "Second"));
  await vi.waitFor(() => expect(f.fake.geese[0]?.killed).toBe(true));
  const third = vi.fn<AgentProtection["assertAvailable"]>();
  Object.assign(f.agent, {
    protection: { ...protection("policy-3", () => f), assertAvailable: third },
  });
  const turns = Promise.all([second, f.deliver(message("3", "Third"))]);
  await vi.waitFor(() => expect(third).toHaveBeenCalled());
  await flush(100);
  return turns;
}

it("starts one worker for providers replaced in turn, once every replaced one has exited", async () => {
  const f = setup({ protection: holdingKill("policy-1", () => f) });
  try {
    const turns = await replacedTwice(f);
    expect(f.fake.geese).toHaveLength(1);
    f.fake.geese[0]?.exit(null);
    await turns;
    // Both open in it, in either order.
    await vi.waitFor(() =>
      expect(
        f.fake.geese[1]?.turns
          .map((turn) => turn.text.match(/Request: "(\w+)"/)?.[1])
          .sort(),
      ).toEqual(["Second", "Third"]),
    );
    expect(f.fake.geese).toHaveLength(2);
  } finally {
    f.runtime.dispose();
  }
});

it("retires an agent once every replaced worker has exited, leaving none running", async () => {
  const f = setup({ protection: holdingKill("policy-1", () => f) });
  try {
    const turns = await replacedTwice(f);
    let retired = false;
    const retiring = f.runtime.retire(f.agent.key).then(() => {
      retired = true;
    });
    await flush(100);
    // Its turns waiting on the first worker hold it too; the check below is
    // what tells the replaced workers apart.
    expect(retired).toBe(false);
    f.fake.geese[0]?.exit(null);
    await retiring;
    await turns;
    // None outlives it, the one replaced before it started included.
    expect(f.fake.geese.filter((goose) => !goose.killed)).toEqual([]);
  } finally {
    f.runtime.dispose();
  }
});

it("reads a protected tool's native conversation from the worker in its kill grace without starting its replacement", async () => {
  const check = vi.fn<AgentProtection["check"]>().mockResolvedValue();
  const f = setup({
    hold: true,
    protection: { ...holdingKill("policy-1", () => f), check },
  });
  try {
    await f.deliver(message("1", "Post my notes"));
    await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
    const old = f.fake.geese[0];
    const sessionId = old?.turns[0]?.sessionId;
    if (!old || !sessionId) throw new Error("Goose turn did not start");
    Object.assign(f.agent, {
      protection: { ...protection("policy-2", () => f), check },
    });
    const second = f.deliver(message("2", "Second"));
    await vi.waitFor(() => expect(old.killed).toBe(true));
    const reply = await old.mcp(sessionId, "tools/call", {
      name: "send",
      arguments: { audience: "everyone", path: "notes.md" },
    });
    expect(reply.result).not.toMatchObject({ isError: true });
    expect(
      old.received.filter(
        (request) => request.method === "_goose/unstable/session/export",
      ),
    ).toEqual([
      expect.objectContaining({ params: { sessionId, format: "json" } }),
    ]);
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tool",
        content: expect.objectContaining({
          conversation: expect.objectContaining({ id: sessionId }),
        }),
      }),
      expect.anything(),
    );
    expect(f.fake.geese).toHaveLength(1);
    old.exit(null);
    await vi.waitFor(() =>
      expect(f.fake.geese[1]?.turns.map((turn) => turn.text)).toEqual([
        expect.stringContaining("Second"),
      ]),
    );
    await second;
  } finally {
    f.runtime.dispose();
  }
});

it("stops a protected Goose worker and allows a retry when retiring its sessions fails", async () => {
  const f = setup({ protection: protection("policy-1", () => f) });
  try {
    await f.deliver(message("1", "First"));
    await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
    const shutdown = vi
      .spyOn(AgentSessions.prototype, "shutdown")
      .mockRejectedValueOnce(new Error("stuck"));
    await expect(f.runtime.retire(f.agent.key)).rejects.toThrow("stuck");
    expect(f.fake.geese[0]?.killed).toBe(true);
    await f.runtime.retire(f.agent.key);
    // The retry finishes the sessions' retirement rather than finding it done.
    expect(shutdown).toHaveBeenCalledTimes(2);
    await f.deliver(message("2", "Second"));
    await vi.waitFor(() => expect(f.fake.geese[1]?.turns).toHaveLength(1));
  } finally {
    vi.restoreAllMocks();
    f.runtime.dispose();
  }
});

it("reports the retirement's own failure when stopping the worker fails too", async () => {
  const f = setup({ protection: protection("policy-1", () => f) });
  try {
    await f.deliver(message("1", "First"));
    await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
    vi.spyOn(AgentSessions.prototype, "shutdown").mockRejectedValueOnce(
      new Error("stuck"),
    );
    vi.spyOn(AgentProcess.prototype, "shutdown").mockRejectedValueOnce(
      new Error("worker"),
    );
    await expect(f.runtime.retire(f.agent.key)).rejects.toThrow("stuck");
  } finally {
    vi.restoreAllMocks();
    f.runtime.dispose();
  }
});

it("keeps an ordinary agent stopped after a failed retirement, with its own goose stopped, until a retirement succeeds", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const held = gated("session/close", () => true);
  const f = setup({ wrap: held.wrap });
  try {
    await f.deliver(message("1", "First"));
    await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
    const failed = expect(f.runtime.retire(f.agent.key)).rejects.toThrow(
      "No active run",
    );
    await vi.waitFor(() => expect(held.waiting()).toHaveLength(1));
    held.release();
    await failed;
    await f.deliver(message("2", "Second"));
    await vi.waitFor(() =>
      expect(f.published.at(-1)?.content).toContain("goose was stopped"),
    );
    expect(f.fake.geese).toHaveLength(1);
    expect(f.fake.geese[0]?.opened).toHaveLength(1);
    // Its goose is its own, so the failed retirement stopped it too, and
    // the next retirement has no unclosed session left.
    expect(f.fake.geese[0]?.killed).toBe(true);
    await f.runtime.retire(f.agent.key);
    await f.deliver(message("3", "Third"));
    await vi.waitFor(() => expect(f.fake.geese[1]?.turns).toHaveLength(1));
  } finally {
    f.runtime.dispose();
  }
});

it("does not retire past a failed open's unacknowledged session close", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const prompts = gated(
    "_goose/unstable/session/system-prompt/set",
    () => true,
  );
  const closes = gated("session/close", () => true);
  const f = setup({ wrap: (spawn) => closes.wrap(prompts.wrap(spawn)) });
  try {
    const delivery = f.deliver(message("1", "First"));
    await vi.waitFor(() => expect(prompts.waiting()).toHaveLength(1));
    prompts.release();
    await vi.waitFor(() => expect(closes.waiting()).toHaveLength(1));
    const retiring = f.runtime.retire(f.agent.key);
    closes.release();
    await expect(retiring).rejects.toThrow("No active run");
    await delivery;
  } finally {
    prompts.release();
    closes.release();
    f.runtime.dispose();
  }
});

it("drops a delivery queued while its agent retires, without posting that goose stopped", async () => {
  const held = gated("session/close");
  const f = setup({ hold: true, scope: "channel", wrap: held.wrap });
  f.agent.query.mockResolvedValue([message("1", "threaded work")]);
  const restoreNotes = vi.fn();
  try {
    await f.deliver(message("1", "threaded work"));
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    await f.run({ ...pluginWake(), topLevel: true }, {
      agent: { ...f.agent, restoreNotes },
    } as unknown as Partial<Delivery>);
    const retiring = f.runtime.retire(f.agent.key);
    // The retirement cancels the running turn, which frees the queued wake.
    await vi.waitFor(() =>
      expect(restoreNotes).toHaveBeenCalledWith(channel, [], undefined),
    );
    expect(held.waiting()).toHaveLength(1);
    expect(f.goose()?.turns).toHaveLength(1);
    held.release();
    await retiring;
    // Only the turn the retirement ended says so; the queued wake is dropped.
    expect(f.published.map((post) => post.content)).toEqual([
      "⚠️ I couldn't finish that: The session was closed",
    ]);
  } finally {
    held.release();
    f.runtime.dispose();
  }
});

it("stops an agent's Goose only once its retirement has closed its sessions", async () => {
  const held = gated("session/close");
  const f = setup({ wrap: held.wrap });
  try {
    f.runtime.sync([
      { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent,
    ]);
    await f.deliver(message("1", "First"));
    await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
    f.runtime.sync([]);
    await vi.waitFor(() => expect(held.waiting()).toHaveLength(1));
    await flush(30);
    expect(f.fake.geese[0]?.killed).toBe(false);
    held.release();
    await vi.waitFor(() => expect(f.fake.geese[0]?.killed).toBe(true));
    expect(f.fake.geese[0]?.closed).toEqual(["session-1"]);
  } finally {
    held.release();
    f.runtime.dispose();
  }
});

it("stops a protected tool's native session read that Goose does not answer in time", async () => {
  const held = gated("_goose/unstable/session/export");
  const check = vi.fn<AgentProtection["check"]>().mockResolvedValue();
  const protectedAgent: AgentProtection = {
    ...protection("policy-1", () => f),
    check,
    spawn: (options) => held.wrap(f.fake.spawn)("goose", options),
  };
  const f = setup({ hold: true, protection: protectedAgent });
  try {
    await f.deliver(message("1", "Post my notes"));
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const process = f.goose();
    const sessionId = process?.turns[0]?.sessionId;
    if (!process || !sessionId) throw new Error("Goose turn did not start");
    vi.useFakeTimers();
    let answered = false;
    const reply = process
      .mcp(sessionId, "tools/call", {
        name: "send",
        arguments: { audience: "everyone", path: "notes.md" },
      })
      .then((message) => {
        answered = true;
        return message;
      });
    await flush(100);
    expect(held.waiting()).toEqual([sessionId]);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    expect((await reply).result).toMatchObject({ isError: true });
    expect(f.fake.geese[0]?.killed).toBe(true);
    expect(check).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    f.runtime.dispose();
  }
});

it.each(["retire", "dispose"] as const)(
  "cancels a pending protected tool before %s completes",
  async (end) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const checking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reviewSignal: AbortSignal | undefined;
    const protection: AgentProtection = {
      key: "policy-1",
      stateKey: "revision-1",
      processProtection: { readOnlyPaths: [], hiddenPaths: [] },
      assertAvailable: () => {},
      spawn: (options) => f.fake.spawn("goose", options),
      check: async (action, signal) => {
        if (action.kind !== "tool") return;
        expect(action.content).toMatchObject({
          arguments: { text: "Private notes" },
        });
        reviewSignal = signal;
        entered();
        // A late reviewer may ignore cancellation and still approve.
        await gate;
      },
    };
    const f = setup({ hold: true, protection });
    let pending:
      | ReturnType<NonNullable<ReturnType<typeof f.goose>>["mcp"]>
      | undefined;
    try {
      await f.deliver(message("1", "Post my notes"));
      await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
      const process = f.goose();
      const sessionId = process?.turns[0]?.sessionId;
      if (!process || !sessionId) throw new Error("Goose turn did not start");
      pending = process.mcp(sessionId, "tools/call", {
        name: "send",
        arguments: { audience: "everyone", path: "notes.md" },
      });
      await Promise.race([
        checking,
        pending.then((reply) => {
          throw new Error(
            `Tool returned before review: ${JSON.stringify(reply)}`,
          );
        }),
      ]);
      expect(f.spawn).toHaveBeenCalledWith(
        "read-protected",
        expect.objectContaining({
          args: ["notes.md"],
          protection: protection.processProtection,
        }),
      );
      expect(f.published).toEqual([]);
      if (end === "retire") await f.runtime.retire(f.agent.key);
      else f.runtime.dispose();
      release();
      expect((await pending).result).toMatchObject({ isError: true });
      expect(f.readFile).not.toHaveBeenCalled();
      expect(reviewSignal?.aborted).toBe(true);
    } finally {
      release();
      await pending;
      f.runtime.dispose();
    }
  },
);

describe("GooseRuntime", () => {
  it("reads a file a tool names from the agent's workspace through the host", async () => {
    const { deliver, goose, published, readFile } = setup({ hold: true });
    readFile.mockResolvedValueOnce(new TextEncoder().encode("From a file"));
    await deliver(message("1", "@Gander post my notes"));
    await flush(100);
    const process = goose();
    const reply = await process?.mcp(
      process.turns[0]?.sessionId ?? "",
      "tools/call",
      { name: "send", arguments: { audience: "everyone", path: "notes.md" } },
    );
    expect(reply?.result).not.toMatchObject({ isError: true });
    expect(readFile).toHaveBeenCalledWith("notes.md", {
      cwd: DEFAULT_CONFIG.workspace,
    });
    expect(published.at(-1)?.content).toBe("From a file");
  });

  it("continues an owner's Solo chat as one channel session posted at the top level", async () => {
    const earlier = message("1", "Earlier in the chat", {
      tags: [["h", channel]],
    });
    const first = message("2", "@Gander first");
    // A reply in an old thread of the chat is still the one conversation.
    const later = message("3", "@Gander more", {
      tags: [
        ["h", channel],
        ["e", earlier.id, "", "reply"],
        ["p", self],
      ],
    });
    const { agent, deliver, goose, published, read } = setup({
      solo: new Set([channel]),
      hold: true,
      thread: [earlier],
    });
    agent.query.mockImplementation(async () => [first]);
    await deliver(first);
    await flush(100);
    const process = goose();
    const turn = process?.turns[0];
    expect(turn?.text).toContain("Scope: channel");
    expect(turn?.text).toContain(`IMPORTANT: ${TOP_LEVEL_PROMPT}`);
    expect(turn?.text).toContain("Earlier in the chat");
    // A new session is shown the chat itself, not a thread.
    expect(read).toHaveBeenCalledWith(
      [{ kinds: [9, 40002], "#h": [channel], limit: 13 }],
      expect.anything(),
    );
    const sessionId = turn?.sessionId ?? "";
    const reply = await process?.mcp(sessionId, "tools/call", {
      name: "send",
      arguments: { audience: "everyone", text: "x", reply: first.id },
    });
    expect(reply?.result).toEqual({
      content: [
        {
          type: "text",
          text: "This chat stays at the top level: send again without reply.",
        },
      ],
      isError: true,
    });
    await deliver(later);
    await flush(100);
    expect(process?.turns).toHaveLength(1);
    expect(turn?.steered).toHaveLength(1);
    process?.exit(1, "Error: Invalid API key\n");
    await flush(100);
    // The turn both mentions joined reports its failure once, at the chat's
    // top level.
    expect(published.map((event) => event.tags)).toEqual([
      [
        ["h", channel],
        ["p", alice],
      ],
    ]);
  });

  it("hands the host a stopper that cancels the mention's running turn", async () => {
    const { deliver, goose } = setup({ hold: true });
    const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
    await deliver(message("1", "@Gander hi"), { interruptible });
    await flush(100);
    expect(interruptible).toHaveBeenCalledTimes(1);
    const process = goose();
    expect(process?.cancelled).toEqual([]);
    await interruptible.mock.calls[0]?.[0]();
    await flush(100);
    expect(process?.cancelled).toEqual([process?.turns[0]?.sessionId]);
  });

  it("returns no owner read that the owner's Stop overtook", async () => {
    const { agent, deliver, goose } = setup({ hold: true });
    let release!: () => void;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const channels = vi.fn<OwnerAccess["channels"]>(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        execution: { agent: self, owner: alice, community: "relay" },
        channels: [
          {
            id: channel,
            name: "Owner secrets",
            type: "stream",
            visibility: "private",
            archived: false,
          },
        ],
        partial: false,
      };
    });
    const held = vi.fn<OwnerAccess["held"]>();
    Object.assign(agent, { ownerAccess: { channels, held } });
    const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
    await deliver(message("1", "@Gander list my channels"), { interruptible });
    await vi.waitFor(() => expect(goose()?.turns).toHaveLength(1));
    const process = goose();
    const sessionId = process?.turns[0]?.sessionId;
    if (!process || !sessionId) throw new Error("Goose turn did not start");
    const pending = process.mcp(sessionId, "tools/call", {
      name: "owner_channel_list",
      arguments: {},
    });
    await reading;
    await interruptible.mock.calls[0]?.[0]();
    release();
    const reply = await pending;
    expect(reply?.result).toMatchObject({ isError: true });
    expect(JSON.stringify(reply)).not.toContain("Owner secrets");
    expect(JSON.stringify(reply)).toContain("turn has ended");
    expect(channels).toHaveBeenCalledOnce();
  });

  it("answers a watch's or timer's Buzz calls while it runs, and none once it is stopped", async () => {
    const f = setup({
      hold: true,
      memoryRead: async (_pubkey, _signal, slug) => ({
        entries: [{ slug: slug ?? "core", body: "core notes", createdAt: 1 }],
        partial: false,
      }),
    });
    const listing = {
      execution: { agent: self, owner: alice, community: "relay" },
      channels: [
        {
          id: channel,
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
      if (channels.mock.calls.length > 1) {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return listing;
    });
    Object.assign(f.agent, {
      ownerAccess: { channels, held: vi.fn<OwnerAccess["held"]>() },
    });
    const stop = new AbortController();
    const done = f.runtime.runOnce({
      delivery: { agent: f.agent, channelId: channel, config: DEFAULT_CONFIG },
      key: "timer/daily",
      signal: stop.signal,
      prompt: async () => "Check my channels.",
    } as unknown as Parameters<GooseRuntime["runOnce"]>[0]);
    try {
      await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
      const process = f.goose();
      const sessionId = process?.turns[0]?.sessionId;
      if (!process || !sessionId) throw new Error("Goose turn did not start");
      const call = (name: string) =>
        process.mcp(sessionId, "tools/call", {
          name,
          arguments: name === "mem_get" ? { slug: "core" } : {},
        });
      const memory = await call("mem_get");
      expect(memory?.result).not.toMatchObject({ isError: true });
      expect(JSON.stringify(memory)).toContain("core notes");
      const owned = await call("owner_channel_list");
      expect(owned?.result).not.toMatchObject({ isError: true });
      expect(JSON.stringify(owned)).toContain("Owner secrets");

      const pending = call("owner_channel_list");
      await reading;
      stop.abort(new Error("stopped"));
      await done;
      release?.();
      const refused = await pending;
      expect(refused?.result).toMatchObject({ isError: true });
      expect(JSON.stringify(refused)).not.toContain("Owner secrets");
      expect(JSON.stringify(refused)).toContain("turn has ended");
    } finally {
      release?.();
      stop.abort();
      await done;
    }
  });

  it("posts nothing goose wrote without `send`", async () => {
    // Text the agent writes outside `send` is narration, not a reply.
    for (const reply of ["I've replied to Will.", "Plain answer"]) {
      const { deliver, published, runtime } = setup({ reply });
      let activity: Promise<unknown> = Promise.resolve();
      await deliver(message("1", "@Gander hi"), {
        workingUntil: (done: Promise<unknown>) => {
          activity = done;
        },
      });
      expect(await activity, reply).toMatchObject({ ok: true, text: reply });
      // The turn's report step ends by notifying, after any post it makes.
      await new Promise<void>((resolve) => {
        const stop = runtime.subscribe(() => {
          stop();
          resolve();
        });
      });
      expect(published, reply).toEqual([]);
    }
  });

  it("tells a subscriber when a new conversation's first turn starts working", async () => {
    const { deliver, goose, runtime } = setup({ hold: true });
    // As a view does: each notification reads the snapshot again.
    runtime.subscribe(() => void runtime.sessions(self));
    expect(runtime.sessions(self)).toEqual([]);
    await deliver(message("1", "@Gander hi"));
    await flush(100);
    expect(goose()?.turns).toHaveLength(1);
    expect(runtime.sessions(self)).toMatchObject([{ busy: true }]);
    goose()?.turns[0]?.finish();
    await flush(100);
    expect(runtime.sessions(self)).toMatchObject([{ busy: false }]);
  });

  it("posts a channel session's burst once, in the latest message's thread", async () => {
    const reply = (id: string, root: EventData): RelayEvent =>
      message(id, "@Gander", {
        tags: [
          ["h", channel],
          ["e", root.id, "", "reply"],
          ["p", self],
        ],
      });
    const one = message("1", "First thread");
    const two = message("2", "Second thread");
    const { deliver, goose, published } = setup({
      scope: "channel",
      hold: true,
    });
    await deliver(reply("3", one));
    await flush(100);
    await deliver(reply("4", two));
    await flush(100);
    const process = goose();
    expect(process?.turns).toHaveLength(1);
    expect(process?.turns[0]?.steered).toHaveLength(1);
    process?.exit(1, "crashed\n");
    await flush(100);
    expect(published.map((event) => event.tags)).toEqual([
      [
        ["h", channel],
        ["e", two.id, "", "reply"],
        ["p", alice],
      ],
    ]);
  });

  it("starts a session from the host's core memory, reading none from the relay", async () => {
    const { core, deliver, goose, memoryOpen } = setup({
      core: "I am Gander.",
    });
    await deliver(message("1", "@Gander hi"));
    await flush(100);
    expect([...(goose()?.prompts.values() ?? [])].join()).toContain(
      "<core-memory>\nI am Gander.\n</core-memory>",
    );
    expect(core).toHaveBeenCalledWith(self);
    expect(memoryOpen).not.toHaveBeenCalled();
  });

  it("leaves a Solo chat's session for goose to name, and offers that name", async () => {
    const solo = setup({ hold: true, solo: new Set([channel]) });
    const named = vi.fn();
    await solo.deliver(message("1", "@Gander fix the login bug"), { named });
    await flush(100);
    const process = solo.goose();
    expect(process?.opened[0]?._meta).not.toHaveProperty("sessionTitle");
    process?.update(process.turns[0]?.sessionId ?? "", {
      sessionUpdate: "session_info_update",
      title: "Fix login bug",
      _meta: { messageCount: 1, userSetName: false },
    });
    await flush(100);
    expect(named).toHaveBeenCalledExactlyOnceWith("Fix login bug");
    // A channel's session keeps Buzz's title, which goose never replaces.
    const team = setup({ hold: true });
    await team.deliver(message("1", "@Gander hi"), { named: vi.fn() });
    await flush(100);
    expect(team.goose()?.opened[0]?._meta).toMatchObject({
      sessionTitle: "Buzz agent · #general · 11111111",
    });
  });

  it("names the agent in a timer's prompt, so its session is listed as the agent's", async () => {
    const { runOnce, goose } = setup();
    await expect(
      runOnce("timer/daily", "Post the daily summary."),
    ).resolves.toEqual({ ok: true });
    expect(goose()?.turns.map((turn) => turn.text)).toEqual([
      standalonePrompt(self, "Post the daily summary."),
    ]);
  });

  it("switches a saved provider in the live session without restarting goose", async () => {
    const { agent, deliver, fake, runtime } = setup();
    const saved = (config: typeof DEFAULT_CONFIG) =>
      runtime.sync([{ ...agent, config } as unknown as Agent]);
    saved(DEFAULT_CONFIG);
    const first = message("1", "@Gander which model?");
    await deliver(first);
    await flush(100);
    saved({ ...DEFAULT_CONFIG, provider: "openai" });
    await deliver(
      message("2", "@Gander and now?", {
        tags: [
          ["h", channel],
          ["e", first.id, "", "reply"],
          ["p", self],
        ],
      }),
    );
    await flush(100);
    expect(fake.geese).toHaveLength(1);
    const [goose] = fake.geese;
    expect(goose?.env).toMatchObject({ GOOSE_PROVIDER: null });
    expect(goose?.closed).toEqual([]);
    expect(goose?.turns.map((turn) => turn.sessionId)).toEqual([
      "session-1",
      "session-1",
    ]);
    expect(goose?.configured).toEqual(["session-1 provider=openai"]);
  });

  it.each(["", "openai"])(
    "refreshes inherited defaults without replacing explicit provider %s",
    async (provider) => {
      const { agent, deliver, fake, runtime } = setup();
      runtime.sync([
        {
          ...agent,
          config: { ...DEFAULT_CONFIG, provider },
        } as unknown as Agent,
      ]);
      const first = message("1", "@Gander first");
      await deliver(first);
      await flush(100);
      runtime.defaultsChanged();
      await deliver(
        message("2", "@Gander next", {
          tags: [
            ["h", channel],
            ["e", first.id, "", "reply"],
            ["p", self],
          ],
        }),
      );
      await flush(100);
      expect(fake.geese[0]?.turns.map((turn) => turn.sessionId)).toEqual([
        "session-1",
        provider ? "session-1" : "session-2",
      ]);
    },
  );

  it("runs a mention on the agent's thinking level", async () => {
    const { deliver, fake } = setup();
    await deliver(message("1", "@Gander think"), {
      config: { ...DEFAULT_CONFIG, effort: "max" },
    });
    await flush(100);
    expect(fake.geese[0]?.configured).toEqual([
      "session-1 thinking_effort=max",
    ]);
  });

  it("runs a mention on the model its owner picked", async () => {
    const { deliver, fake } = setup();
    await deliver(message("1", "@Gander hi"), {
      config: { ...DEFAULT_CONFIG, provider: "openai" },
      model: "o3",
    });
    await flush(100);
    expect(fake.geese[0]?.configured).toEqual(["session-1 model=o3"]);
  });

  it("runs a mention on the thinking level its owner picked", async () => {
    const { deliver, fake } = setup();
    await deliver(message("1", "@Gander think"), {
      config: { ...DEFAULT_CONFIG, effort: "low" },
      effort: "high",
    });
    await flush(100);
    expect(fake.geese[0]?.configured).toEqual([
      "session-1 thinking_effort=high",
    ]);
  });

  it("keeps one agent's sessions in two communities apart", async () => {
    const { agent, run, runtime } = setup();
    const other = `${self}@other.example`;
    const running = (...keys: string[]) =>
      runtime.sync(
        keys.map(
          (key) =>
            ({ key, pubkey: self, config: DEFAULT_CONFIG }) as unknown as Agent,
        ),
      );
    running(self, other);
    await run({ type: "mention", event: message("1", "@Gander here") }, {});
    await run(
      { type: "mention", event: message("2", "@Gander there") },
      { agent: { ...agent, key: other } as unknown as Delivery["agent"] },
    );
    await flush(100);
    expect(runtime.conversations(self)).toHaveLength(1);
    expect(runtime.conversations(other)).toHaveLength(1);
    // Leaving one community stops only its membership's sessions.
    running(self);
    expect(runtime.sessions(other)).toEqual([]);
    expect(runtime.conversations(self)).toHaveLength(1);
  });

  it("refuses a synced level the selected model lacks before its prompt, unless a pick names one", async () => {
    const { deliver, runtime, agent, fake, published } = setup({
      thinking: { o3: { current: "off", levels: ["off"] } },
    });
    const config = {
      ...DEFAULT_CONFIG,
      provider: "openai",
      model: "o3",
      effort: "high",
    };
    const refused =
      "This agent's synced effort \"high\" isn't offered by goose's o3. Change it in Settings.";
    await deliver(message("1", "@Gander think"), {
      config,
      synced: { effort: "high" },
    });
    await flush(100);
    expect(fake.geese[0]?.turns).toEqual([]);
    expect(published.at(-1)?.content).toContain(refused);
    // A watch or timer is checked the same way.
    await expect(
      runtime.runOnce({
        delivery: {
          agent,
          channelId: channel,
          config,
          synced: { effort: "high" },
        },
        key: "timer/daily",
        signal: new AbortController().signal,
        prompt: async () => "Post the summary.",
      } as unknown as Parameters<GooseRuntime["runOnce"]>[0]),
    ).resolves.toEqual({ ok: false, error: refused, undelivered: true });
    expect(fake.geese[0]?.turns).toEqual([]);
    // The owner's pick runs on its own level.
    await deliver(message("2", "@Gander think"), {
      config,
      synced: { effort: "high" },
      effort: "off",
    });
    await flush(100);
    expect(fake.geese[0]?.turns.map((turn) => turn.text)).toHaveLength(1);
  });

  it("runs each agent in its own goose, which stops once that agent goes", async () => {
    const { agent, deliver, fake, runtime } = setup();
    const other = {
      ...agent,
      key: "d".repeat(64),
      pubkey: "d".repeat(64),
      name: "Drake",
    };
    const running = (...agents: (typeof agent)[]) =>
      runtime.sync(
        agents.map(
          (item) => ({ ...item, config: DEFAULT_CONFIG }) as unknown as Agent,
        ),
      );
    running(agent, other);
    await deliver(message("1", "@Gander hi"));
    await flush(100);
    const [goose] = fake.geese;
    expect(goose?.killed).toBe(false);
    // Its credential, in its own process, acts as this agent only.
    expect(goose?.options.agentCredential).toBe(true);
    expect(goose?.actedAs?.pubkey).toBe(agent.pubkey);
    running(other);
    await flush(30);
    expect(goose?.killed).toBe(true);
    expect(fake.geese).toHaveLength(1);
  });
});

/** A goose turn calling the Buzz tools, whose native memory reads each wait
 * for the test to answer them. */
async function memoryTurn() {
  const reads: { slug?: string; answer(body: string): void }[] = [];
  const memoryRead = vi.fn(
    (_pubkey: string, _signal: AbortSignal, slug?: string) =>
      new Promise<Memories>((done) =>
        reads.push({
          ...(slug === undefined ? {} : { slug }),
          answer: (body) =>
            done({
              entries: [{ slug: slug ?? "core", body, createdAt: 1 }],
              partial: false,
            }),
        }),
      ),
  );
  const turn = setup({ hold: true, memoryRead });
  await turn.deliver(message("1", "@Gander remember"));
  await flush(100);
  const process = turn.goose();
  const sessionId = process?.turns[0]?.sessionId ?? "";
  const call = async (name: string, args: Record<string, unknown>) =>
    (await process?.mcp(sessionId, "tools/call", { name, arguments: args }))
      ?.result as { content: { text: string }[]; isError?: boolean };
  const text = (reply: ReturnType<typeof call>) =>
    reply.then((result) => result.content[0]?.text);
  /** A memory's text as mem_get gives it, after its version line. */
  const body = (reply: ReturnType<typeof call>) =>
    text(reply).then((value) =>
      value?.replace(/^version: [0-9a-f]{16}\n\n/, ""),
    );
  return { ...turn, reads, memoryRead, call, text, body };
}

describe("goose memory reads", () => {
  it("does not share a read with a replacement connection", async () => {
    const { reads, memoryRead, call, body, reconnect } = await memoryTurn();
    const before = body(call("mem_get", { slug: "core" }));
    await vi.waitFor(() => expect(memoryRead).toHaveBeenCalledTimes(1));
    reconnect();
    const after = body(call("mem_get", { slug: "core" }));
    // The new connection reads for itself, even while the old read waits.
    await vi.waitFor(() => expect(memoryRead).toHaveBeenCalledTimes(2));
    reads[1]?.answer("as the new connection");
    reads[0]?.answer("as the old connection");
    await expect(after).resolves.toBe("as the new connection");
    await expect(before).resolves.toBe("as the old connection");
  });

  it("does not share a read that started before a write", async () => {
    const { agent, reads, memoryRead, call, text, body } = await memoryTurn();
    const before = body(call("mem_get", { slug: "core" }));
    await vi.waitFor(() => expect(memoryRead).toHaveBeenCalledTimes(1));
    const saved = text(
      call("mem_set", {
        slug: "notes",
        text: "new",
        expected: await memoryVersion("old notes"),
      }),
    );
    await vi.waitFor(() => expect(memoryRead).toHaveBeenCalledTimes(2));
    reads[1]?.answer("old notes");
    await expect(saved).resolves.toMatch(/^saved; version [0-9a-f]{16}$/);
    expect(agent.remember).toHaveBeenCalledWith("mem/notes", "new", 1);
    const after = body(call("mem_get", { slug: "core" }));
    await vi.waitFor(() => expect(memoryRead).toHaveBeenCalledTimes(3));
    reads[0]?.answer("before the write");
    await expect(before).resolves.toBe("before the write");
    // The old read finishing must not drop the newer one.
    const later = body(call("mem_get", { slug: "core" }));
    reads[2]?.answer("after the write");
    await expect(after).resolves.toBe("after the write");
    await expect(later).resolves.toBe("after the write");
    expect(memoryRead).toHaveBeenCalledTimes(3);
  });

  it("keeps a shared read for the others when one caller stops waiting", async () => {
    const { reads, memoryRead, call, body } = await memoryTurn();
    vi.useFakeTimers();
    // AbortSignal.timeout runs on real time; put it on the fake clock.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("", "TimeoutError")),
        ms,
      );
      return controller.signal;
    });
    try {
      const first = call("mem_get", { slug: "core" });
      await vi.advanceTimersByTimeAsync(5_000);
      const second = body(call("mem_get", { slug: "core" }));
      await vi.advanceTimersByTimeAsync(5_000);
      // The first caller's own bound passed; the read it started goes on.
      await expect(first).resolves.toMatchObject({ isError: true });
      reads[0]?.answer("shared");
      await expect(second).resolves.toBe("shared");
      expect(memoryRead).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("gives a tool the partial listing a slow native read answers", async () => {
    vi.useFakeTimers();
    // AbortSignal.timeout runs on real time; put it on the fake clock.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("", "TimeoutError")),
        ms,
      );
      return controller.signal;
    });
    try {
      const relay = {
        snapshot: () => ({
          status: "ready",
          session: { agentMemories: slowMemories(alice) },
        }),
      } as unknown as RelayData;
      const runtime = new GooseRuntime(
        {} as Host,
        () => relay,
        async () => null,
      ) as unknown as {
        memories(
          pubkey: string,
          slug?: string,
        ): ReturnType<BuzzClient["memories"]>;
      };
      const client = {
        memories: (slug?: string) => runtime.memories(self, slug),
      } as unknown as BuzzClient;
      const reply = callTool(client, {}, "mem_get", {});
      await vi.advanceTimersByTimeAsync(9_500);
      await expect(reply).resolves.toMatch(
        /^mem\/a .*\nThis list is incomplete: some memory could not be read\.$/,
      );
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

/** A native read that pages until its deadline and answers partial at 9.5
 * seconds, behind the session's real serialized memory reads. */
function slowMemories(viewer: string) {
  return createAgentMemories(
    () =>
      new Promise((done) =>
        setTimeout(
          () =>
            done({
              entries: [
                {
                  slug: "mem/a",
                  body: "a",
                  eventId: "e".repeat(64),
                  createdAt: 1,
                },
              ],
              partial: true,
            }),
          9_500,
        ),
      ),
    viewer,
    () => true,
  ).capability;
}

/** A plugin's wake; its id is its own, which nothing may publish. */
const WAKE_ID = "9".repeat(64);
const pluginWake = (root?: string) => ({
  type: "plugin" as const,
  plugin: "github",
  channel,
  ...(root ? { root } : {}),
  text: "CI failed: lint",
  id: WAKE_ID,
  at: 200_000,
});

it("takes a plugin's wake in its thread's session, as the plugin's and not a message", async () => {
  const root = message("1", "@Gander watch my PR");
  const f = setup();
  await f.deliver(root);
  await flush(100);
  await f.run(pluginWake(root.id));
  await flush(100);
  const goose = f.goose();
  expect(goose?.turns).toHaveLength(2);
  expect(goose?.turns[1]?.sessionId).toBe(goose?.turns[0]?.sessionId);
  const text = goose?.turns[1]?.text ?? "";
  expect(text).toContain('<plugin-wake plugin="github">');
  expect(text).toContain("neither your owner nor anyone in the channel");
  expect(text).toContain("CI failed: lint");
  expect(text).not.toContain("<buzz-event");
  expect(text).not.toContain(WAKE_ID);
});

it("reports a failed wake at its thread's root, never at the wake's own id", async () => {
  const root = "1".repeat(64);
  const f = setup({ hold: true });
  await f.run(pluginWake(root));
  await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
  f.goose()?.exit(1, "Error: boom\n");
  await vi.waitFor(() =>
    expect(f.published.some((event) => event.kind === 9)).toBe(true),
  );
  for (const event of f.published.filter(({ kind }) => kind === 9))
    expect(event.tags).toContainEqual(["e", root, "", "reply"]);
  expect(JSON.stringify(f.published)).not.toContain(WAKE_ID);
});

it("takes a wake with no thread only in a Solo chat", async () => {
  const ignored = vi.fn();
  const stream = setup();
  await stream.run(pluginWake(), { ignored });
  await flush(100);
  expect(ignored).toHaveBeenCalled();
  expect(stream.goose()).toBeUndefined();
  const solo = setup({ solo: new Set([channel]) });
  await solo.run(pluginWake());
  await flush(100);
  const text = solo.goose()?.turns[0]?.text ?? "";
  expect(text).toContain('<plugin-wake plugin="github">');
  expect(text).not.toContain(WAKE_ID);
});

it("shows a turn a reload stopped what it already posted, and to carry on", async () => {
  const mention = message("1", "@Gander count to 60");
  const inThread = (id: string, content: string, pubkey: string) =>
    message(id, content, {
      pubkey,
      tags: [
        ["h", channel],
        ["e", mention.id, "", "reply"],
      ],
    });
  const progress = inThread("2", "Counted to 10", self);
  const aside = inThread("3", "Looks good so far", alice);
  const f = setup({ thread: [mention, progress, aside] });
  await f.deliver(mention);
  await flush(100);
  // A first delivery is shown nothing after its mention.
  const first = f.goose()?.turns[0]?.text ?? "";
  expect(first).not.toContain("Counted to 10");
  expect(first).not.toContain(RESUMED_PROMPT);

  const g = setup({ thread: [mention, progress, aside] });
  await g.run({ type: "mention", event: mention, resumed: true });
  await flush(100);
  expect(g.read).toHaveBeenCalledWith(
    [
      { ids: [mention.id], "#h": [channel], limit: 1 },
      { kinds: [9, 40002], "#h": [channel], "#e": [mention.id], limit: 200 },
    ],
    expect.anything(),
  );
  const resumed = g.goose()?.turns[0]?.text ?? "";
  expect(resumed).toContain("Counted to 10");
  expect(resumed).toContain("Looks good so far");
  expect(promptMessage(promptSections(resumed)).text).toBe(
    "@Gander count to 60",
  );
  expect(resumed).toContain(RESUMED_PROMPT);

  // The session has been shown them, so the thread's next turn is not.
  await g.deliver(inThread("4", "@Gander faster", alice));
  await flush(100);
  const next = g.goose()?.turns[1]?.text ?? "";
  expect(promptMessage(promptSections(next)).text).toBe("@Gander faster");
  expect(next).not.toContain("Looks good so far");
  expect(next).not.toContain(RESUMED_PROMPT);
});

it("shows each resumed thread its own progress in one channel session", async () => {
  const first = message("1", "@Gander count in one");
  const second = message("2", "@Gander count in two");
  const progress = (id: string, root: RelayEvent, content: string) =>
    message(id, content, {
      pubkey: self,
      tags: [
        ["h", channel],
        ["e", root.id, "", "reply"],
      ],
    });
  // Each thread's progress is newer than both mentions.
  const replies = [
    progress("5", second, "Two reached 10"),
    progress("6", first, "One reached 10"),
  ];
  const f = setup({ scope: "channel" });
  f.read.mockImplementation((async (filters: { "#e"?: string[] }[]) =>
    replies.filter((reply) =>
      filters.some((filter) =>
        filter["#e"]?.includes(reply.tags[1]?.[1] ?? ""),
      ),
    )) as never);
  await f.run({ type: "mention", event: first, resumed: true });
  await flush(100);
  await f.run({ type: "mention", event: second, resumed: true });
  await flush(100);
  const turns = f.goose()?.turns ?? [];
  expect(turns).toHaveLength(2);
  expect(turns[1]?.sessionId).toBe(turns[0]?.sessionId);
  expect(turns[0]?.text).toContain("One reached 10");
  // The session's watermark is past it, but it never saw this thread.
  expect(turns[1]?.text).toContain("Two reached 10");
});

it("leaves a later thread's context unseen after a resume in a channel session", async () => {
  const first = message("1", "@Gander count in one");
  const reply = (
    id: string,
    root: RelayEvent,
    content: string,
    pubkey: string,
  ) =>
    message(id, content, {
      pubkey,
      tags: [
        ["h", channel],
        ["e", root.id, "", "reply"],
      ],
    });
  const second = message("2", "Start of two");
  // Older than the resumed thread's progress, but never read.
  const instruction = reply("3", second, "Use the blue palette", alice);
  const progress = reply("4", first, "One reached 10", self);
  const mention = reply("5", second, "@Gander go", alice);
  const events = [first, second, instruction, progress, mention];
  const f = setup({ scope: "channel" });
  f.read.mockImplementation((async (filters: { "#e"?: string[] }[]) =>
    events.filter((event) =>
      filters.some(
        (filter) =>
          filter["#e"]?.includes(event.tags[1]?.[1] ?? "") ||
          (filter as { ids?: string[] }).ids?.includes(event.id),
      ),
    )) as never);
  await f.run({ type: "mention", event: first, resumed: true });
  await flush(100);
  await f.deliver(mention);
  await flush(100);
  const turns = f.goose()?.turns ?? [];
  expect(turns).toHaveLength(2);
  expect(turns[1]?.sessionId).toBe(turns[0]?.sessionId);
  expect(turns[0]?.text).toContain("One reached 10");
  expect(turns[1]?.text).toContain("Use the blue palette");
});

it("ends a turn's prompt with the notes plugins left for it in its channel", async () => {
  const f = setup();
  const notes = vi.fn((at: string) =>
    at === channel ? ["(I interrupted your reply)"] : [],
  );
  await f.deliver(message("1", "@Gander go on"), {
    agent: { ...f.agent, notes },
  } as unknown as Partial<Delivery>);
  await flush(100);
  expect(f.goose()?.turns[0]?.text).toMatch(
    /\n\n\(I interrupted your reply\)$/,
  );
  expect(notes).toHaveBeenCalledOnce();
  expect(notes).toHaveBeenCalledWith(channel, "1".repeat(64));
});

it.each([false, true])(
  "hands a turn the notes plugins left while it was being prepared, and keeps them for the next when it is cancelled first (cancelled: %s)",
  async (cancelled) => {
    const f = setup();
    const pending: Record<string, string[]> = {};
    const notes = vi.fn((at: string) => (pending[at] ?? []).splice(0));
    const note = () => {
      pending[channel] = ["(I interrupted your reply)"];
    };
    // One left before a cancelled turn stays for the next.
    if (cancelled) note();
    let release!: () => void;
    const reading = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.read.mockImplementationOnce(async () => {
      await reading;
      return [];
    });
    const controller = new AbortController();
    const done = f.deliver(
      message("1", "@Gander go on", {
        tags: [
          ["h", channel],
          ["p", self],
          ["e", "d".repeat(64), "", "reply"],
        ],
      }),
      {
        agent: { ...f.agent, notes },
        signal: controller.signal,
      } as unknown as Partial<Delivery>,
    );
    await vi.waitFor(() => expect(f.read).toHaveBeenCalled());
    if (cancelled) controller.abort();
    else note();
    release();
    if (cancelled) {
      await expect(done).rejects.toMatchObject({ name: "AbortError" });
      expect(pending[channel]).toEqual(["(I interrupted your reply)"]);
      return;
    }
    await done;
    await flush(100);
    expect(f.goose()?.turns[0]?.text).toMatch(
      /\n\n\(I interrupted your reply\)$/,
    );
    expect(pending[channel]).toEqual([]);
  },
);

it("keeps the notes of a turn goose never started for the next, ahead of newer ones", async () => {
  const f = setup();
  const pending: Record<string, string[]> = {
    [channel]: ["(I interrupted your reply)"],
  };
  const notes = vi.fn((at: string) => (pending[at] ?? []).splice(0));
  const restoreNotes = vi.fn((at: string, kept: readonly string[]) => {
    pending[at] = [...kept, ...(pending[at] ?? [])];
  });
  vi.spyOn(AgentSessions.prototype, "deliver").mockImplementationOnce(
    async () => {
      pending[channel] = ["(newer)"];
      return {
        ok: false,
        error: "goose did not start in time",
        undelivered: true,
      };
    },
  );
  await f.deliver(message("1", "@Gander go on"), {
    agent: { ...f.agent, notes, restoreNotes },
  } as unknown as Partial<Delivery>);
  await flush(100);
  expect(pending[channel]).toEqual(["(I interrupted your reply)", "(newer)"]);
});

it("gives a turn refused before its prompt its notes back, and the next turn sends them", async () => {
  const f = setup();
  const pending: Record<string, string[]> = { [channel]: ["(plugin note)"] };
  const notes = vi.fn((at: string) => (pending[at] ?? []).splice(0));
  const restoreNotes = vi.fn((at: string, kept: readonly string[]) => {
    pending[at] = [...kept, ...(pending[at] ?? [])];
  });
  const agent = { ...f.agent, notes, restoreNotes };
  // Its model can't be selected, so goose never sees the first prompt.
  vi.spyOn(
    AcpSession.prototype as unknown as { select: () => Promise<void> },
    "select",
  ).mockRejectedValueOnce(new Error("no such model"));
  await f.deliver(message("1", "@Gander go on"), {
    agent,
  } as unknown as Partial<Delivery>);
  await flush(100);
  expect(pending[channel]).toEqual(["(plugin note)"]);
  await f.deliver(message("2", "@Gander again"), {
    agent,
  } as unknown as Partial<Delivery>);
  await flush(100);
  expect(f.goose()?.turns.at(-1)?.text).toContain("(plugin note)");
});

it("hands a Solo chat's Canvas to each turn, and a shared channel's to none", async () => {
  const solo = setup({ solo: new Set([channel]), canvas: "Use tokens." });
  await solo.deliver(message("1", "@Gander hi"));
  await flush(100);
  expect(solo.goose()?.turns[0]?.text).toContain(
    "<workspace-canvas>\nThis Solo chat's Canvas",
  );
  expect(solo.goose()?.turns[0]?.text).toContain("Use tokens.");
  // A cleared Canvas replaces it with an explicit "none".
  const cleared = setup({ solo: new Set([channel]), canvas: "" });
  await cleared.deliver(message("1", "@Gander hi"));
  await flush(100);
  expect(cleared.goose()?.turns[0]?.text).toContain(
    "Disregard any earlier workspace Canvas",
  );
  const shared = setup({ canvas: "Steer me" });
  await shared.deliver(message("1", "@Gander hi"));
  await flush(100);
  expect(shared.goose()?.turns[0]?.text).not.toContain("workspace-canvas");
});

it("compacts idle Goose immediately, keeps active controls through the turn, and resets without a message", async () => {
  const f = setup({ hold: true, reply: "Compaction complete" });
  const root = message("1", "hello");
  const place = { channelId: channel, root: root.id };
  const agent = { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent;
  try {
    await f.deliver(root);
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const goose = f.goose();
    if (!goose) throw new Error("Expected Goose process");
    expect(f.runtime.sessionState(agent, place)).toBe("active");
    await expect(f.runtime.session(agent, place, "new")).rejects.toThrow(
      "active turn",
    );
    goose.turns[0]?.finish();
    await vi.waitFor(() =>
      expect(f.runtime.sessionState(agent, place)).toBe("idle"),
    );
    const compacted = f.runtime.session(agent, place, "compact");
    await vi.waitFor(() => expect(goose.turns[1]?.text).toBe("/compact"));
    expect(goose.turns).toHaveLength(2);
    expect(f.runtime.sessionState(agent, place)).toBe("compacting");
    expect(
      f.runtime.sessionState(agent, { ...place, root: "another-thread" }),
    ).toBe("idle");
    goose.turns[1]?.finish();
    await compacted;
    await f.runtime.session(agent, place, "new");
    await f.deliver(
      message("2", "next", {
        tags: [
          ["h", channel],
          ["e", root.id, "", "reply"],
        ],
      }),
    );
    await vi.waitFor(() => expect(goose.turns).toHaveLength(3));
    expect(goose.turns[2]?.sessionId).not.toBe(goose.turns[0]?.sessionId);
  } finally {
    f.runtime.dispose();
  }
});

it("hands Goose its own community repositories while retaining the session workspace", async () => {
  const repositories = vi.fn(
    () => "<community-repositories>/code/goose</community-repositories>",
  );
  const { runtime, deliver, goose } = setup({ repositories });
  try {
    await deliver(message("1", "@Gander work"));
    await flush(100);
    expect(repositories).toHaveBeenCalledWith(`https://goose.example:${alice}`);
    expect([...(goose()?.prompts.values() ?? [])].join()).toContain(
      "/code/goose",
    );
    expect(goose()?.opened[0]).toMatchObject({ cwd: "/home/test/.buzz" });
  } finally {
    runtime.dispose();
  }
});

it.each(["completed", "stopped"])(
  "keeps an accepted Goose handoff past its deadline and respects its lifetime (%s)",
  async (outcome) => {
    const f = setup({ hold: true, reply: "Compaction complete" });
    const root = message("1", "hello");
    const place = { channelId: channel, root: root.id };
    const agent = { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent;
    const handover = new AbortController();
    const held: PromiseLike<unknown>[] = [];
    try {
      await f.deliver(root);
      await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
      const goose = f.goose();
      if (!goose) throw new Error("Expected Goose process");
      goose.turns[0]?.finish();
      await vi.waitFor(() =>
        expect(f.runtime.sessionState(agent, place)).toBe("idle"),
      );
      const compacted = f.runtime
        .session(agent, place, "compact")
        .catch((error) => error);
      await vi.waitFor(() => expect(goose.turns[1]?.text).toBe("/compact"));
      let returned = false;
      const reply = message("2", "queued after compact", {
        tags: [
          ["h", channel],
          ["e", root.id, "", "reply"],
        ],
      });
      const admitted = f
        .deliver(reply, {
          signal: handover.signal,
          workingUntil: (done) => held.push(done),
        })
        .then(() => {
          returned = true;
        });
      try {
        await vi.waitFor(() => expect(returned).toBe(true));
        handover.abort(new Error("Handover expired"));
      } finally {
        if (outcome === "stopped") f.runtime.sync([]);
        else goose.turns[1]?.finish();
        const result = await compacted;
        if (outcome === "stopped") expect(result).toBeInstanceOf(Error);
        else expect(result).toBeUndefined();
        await admitted;
      }
      if (outcome === "stopped") {
        await Promise.all(held);
        expect(goose.turns).toHaveLength(2);
        expect(f.fake.geese).toHaveLength(1);
        return;
      }
      await vi.waitFor(() => expect(goose.turns).toHaveLength(3));
      expect(goose.turns[2]?.text).toContain("queued after compact");
      goose.turns[2]?.finish();
      await Promise.all(held);
    } finally {
      f.runtime.dispose();
    }
  },
);

it("delivers a rootless subscription to its channel without publishing its anchor", async () => {
  const f = setup({ hold: true, canvas: "Only Solo chats supply this" });
  await f.run({ ...pluginWake(), type: "attention", topLevel: true });
  await flush(100);
  const text = f.goose()?.turns[0]?.text ?? "";
  expect(text).not.toContain("<plugin-wake");
  expect(text).not.toContain(TOP_LEVEL_PROMPT);
  expect(text).toContain("unless the Interest instructions");
  expect(text).not.toContain(WAKE_ID);
  expect(text).not.toContain("Only Solo chats supply this");
  f.goose()?.exit(1, "Error: boom\n");
  await vi.waitFor(() =>
    expect(f.published.some((event) => event.kind === 9)).toBe(true),
  );
  for (const event of f.published.filter(({ kind }) => kind === 9))
    expect(event.tags.some((tag) => tag[0] === "e")).toBe(false);
  expect(JSON.stringify(f.published)).not.toContain(WAKE_ID);
});

it("keeps a shared session's posting policy until its active turn settles", async () => {
  const f = setup({ hold: true, scope: "channel" });
  f.agent.query.mockResolvedValue([message("1", "threaded work")]);
  try {
    await f.deliver(message("1", "threaded work"));
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const process = f.goose();
    if (!process) throw new Error("Expected Goose process");
    const next = f.run({
      type: "plugin",
      plugin: "example",
      channel,
      topLevel: true,
      id: "f".repeat(64),
      at: 200_000,
      text: "channel work",
    });
    await next;
    const reply = await process.mcp(
      process.turns[0]?.sessionId ?? "",
      "tools/call",
      {
        name: "send",
        arguments: {
          audience: "everyone",
          text: "thread reply",
          final: true,
          reply: "1".repeat(64),
        },
      },
    );
    expect(reply.result).not.toMatchObject({ isError: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(process.turns).toHaveLength(1);
    expect(process.turns[0]?.steered).toEqual([]);
    process.turns[0]?.finish();
    await vi.waitFor(() => expect(process.turns).toHaveLength(2));
    expect(process.turns[1]?.text).toContain("channel work");
    process.turns[1]?.finish();
  } finally {
    f.runtime.dispose();
  }
});

it("session Interrupt discards a channel wake queued behind threaded work", async () => {
  const f = setup({ hold: true, scope: "channel" });
  f.agent.query.mockResolvedValue([message("1", "threaded work")]);
  try {
    await f.deliver(message("1", "threaded work"));
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const process = f.goose();
    if (!process) throw new Error("Expected Goose process");
    await f.run({
      type: "plugin",
      plugin: "example",
      channel,
      topLevel: true,
      id: "f".repeat(64),
      at: 200_000,
      text: "channel work",
    });
    await f.runtime.session(
      {
        ...f.agent,
        config: { ...DEFAULT_CONFIG, scope: "channel" },
      } as unknown as Agent,
      { channelId: channel, root: "1".repeat(64) },
      "interrupt",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(process.cancelled).toHaveLength(1);
    expect(process.turns).toHaveLength(1);
    expect(process.turns[0]?.steered).toEqual([]);
  } finally {
    f.runtime.dispose();
  }
});

it("Interrupt during a queued prompt rebuild restores notes without starting a turn", async () => {
  const f = setup({ hold: true, scope: "channel" });
  let release!: () => void;
  const reading = new Promise<RelayEvent[]>((resolve) => {
    release = () => resolve([]);
  });
  const restoreNotes = vi.fn();
  const notes = vi.fn(() => ["pending note"]);
  const workingUntil = vi.fn<Delivery["workingUntil"]>();
  try {
    await f.deliver(message("1", "threaded work"));
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const process = f.goose();
    if (!process) throw new Error("Expected Goose process");
    await f.run({ ...pluginWake(), topLevel: true }, {
      agent: { ...f.agent, notes, restoreNotes },
      workingUntil,
    } as unknown as Partial<Delivery>);
    f.read.mockImplementationOnce(() => reading);
    process.turns[0]?.finish();
    await vi.waitFor(() => expect(notes).toHaveBeenCalledTimes(1));
    expect(
      f.runtime.sessionState(
        {
          ...f.agent,
          config: { ...DEFAULT_CONFIG, scope: "channel" },
        } as unknown as Agent,
        { channelId: channel },
      ),
    ).toBe("active");
    await f.runtime.session(
      {
        ...f.agent,
        config: { ...DEFAULT_CONFIG, scope: "channel" },
      } as unknown as Agent,
      { channelId: channel },
      "interrupt",
    );
    release();
    await workingUntil.mock.calls[0]?.[0];
    await vi.waitFor(() =>
      expect(restoreNotes).toHaveBeenCalledWith(
        channel,
        ["pending note"],
        undefined,
      ),
    );
    expect(process.turns).toHaveLength(1);
  } finally {
    release();
    f.runtime.dispose();
  }
});

it("keeps a queued Goose prompt in its admitted scope after settings change", async () => {
  const f = setup({ hold: true, scope: "channel" });
  try {
    await f.run({ ...pluginWake(), topLevel: true });
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const process = f.goose();
    if (!process) throw new Error("Expected Goose process");
    await f.deliver(message("1", "threaded work"));
    f.runtime.sync([
      {
        ...f.agent,
        config: { ...DEFAULT_CONFIG, scope: "thread" },
      } as unknown as Agent,
    ]);
    process.turns[0]?.finish();
    await vi.waitFor(() =>
      expect(f.fake.geese.flatMap((p) => p.turns)).toHaveLength(2),
    );
    expect(f.fake.geese.flatMap((p) => p.turns)[1]?.text).toContain(
      "Scope: channel",
    );
    f.fake.geese.flatMap((p) => p.turns)[1]?.finish();
  } finally {
    f.runtime.dispose();
  }
});

it("notifies subscribers when the final Goose posting policy settles", async () => {
  const f = setup({ hold: true, scope: "channel" });
  const agent = {
    ...f.agent,
    config: { ...DEFAULT_CONFIG, scope: "channel" },
  } as unknown as Agent;
  const place = { channelId: channel };
  const states: string[] = [];
  const unsubscribe = f.runtime.subscribe(() => {
    states.push(f.runtime.sessionState(agent, place));
  });
  try {
    await f.deliver(message("1", "threaded work"));
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    expect(states.at(-1)).toBe("active");
    f.goose()?.turns[0]?.finish();
    await vi.waitFor(() =>
      expect(f.runtime.sessionState(agent, place)).toBe("idle"),
    );
    expect(states.at(-1)).toBe("idle");
  } finally {
    unsubscribe();
    f.runtime.dispose();
  }
});

it("keeps an accepted policy wait after its handover deadline and reconfiguration", async () => {
  const f = setup({ hold: true, scope: "channel" });
  const handover = new AbortController();
  const workingUntil = vi.fn<Delivery["workingUntil"]>();
  try {
    await f.deliver(message("1", "threaded work"));
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    await f.run(
      { ...pluginWake(), topLevel: true },
      {
        signal: handover.signal,
        workingUntil,
      },
    );
    handover.abort(new Error("Handover expired"));
    f.runtime.sync([
      {
        ...f.agent,
        config: {
          ...DEFAULT_CONFIG,
          scope: "channel",
          instructions: "Updated instructions",
        },
      } as unknown as Agent,
    ]);
    f.goose()?.turns[0]?.finish();
    await vi.waitFor(() =>
      expect(f.fake.geese.flatMap((p) => p.turns)).toHaveLength(2),
    );
    f.fake.geese.flatMap((p) => p.turns)[1]?.finish();
    await workingUntil.mock.calls[0]?.[0];
    expect(JSON.stringify(f.published)).not.toContain(
      "goose did not start in time",
    );
  } finally {
    f.runtime.dispose();
  }
});

it("refreshes a queued subscription's instructions when its policy wait ends", async () => {
  const f = setup({ hold: true, scope: "channel" });
  let instructions = "Old Interest instructions";
  try {
    await f.deliver(message("1", "threaded work"));
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    await f.run({ ...pluginWake(), topLevel: true, text: instructions }, {
      wakeText: async () => instructions,
    } as unknown as Partial<Delivery>);
    instructions = "Updated Interest instructions";
    f.goose()?.turns[0]?.finish();
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(2));
    expect(f.goose()?.turns[1]?.text).toContain(instructions);
    expect(f.goose()?.turns[1]?.text).not.toContain(
      "Old Interest instructions",
    );
    f.goose()?.turns[1]?.finish();
  } finally {
    f.runtime.dispose();
  }
});

it("refreshes Attention instructions after Goose startup", async () => {
  const f = setup({ hold: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.core.mockImplementationOnce(async () => {
    await gate;
    return undefined;
  });
  let instructions = "Old Interest instructions";
  try {
    await f.run(
      { ...pluginWake(), topLevel: true, text: instructions },
      {
        wakeText: async () => instructions,
      },
    );
    await vi.waitFor(() => expect(f.core).toHaveBeenCalled());
    instructions = "Updated Interest instructions";
    release();
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    expect(f.goose()?.turns[0]?.text).toContain(instructions);
    expect(f.goose()?.turns[0]?.text).not.toContain(
      "Old Interest instructions",
    );
    f.goose()?.turns[0]?.finish();
  } finally {
    release();
    f.runtime.dispose();
  }
});

it("drops an Attention wake stopped while its final prompt refresh waits", async () => {
  const f = setup();
  let release!: () => void;
  let refreshing!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    refreshing = resolve;
  });
  let builds = 0;
  const wakeText = async () => {
    if (++builds === 2) {
      refreshing();
      await gate;
    }
    return "Attention work";
  };
  const interruptible = vi.fn();
  const workingUntil = vi.fn<Delivery["workingUntil"]>();
  try {
    await f.run(
      { ...pluginWake(), topLevel: true },
      { wakeText, interruptible, workingUntil },
    );
    await started;
    await vi.waitFor(() => expect(interruptible).toHaveBeenCalled());
    await interruptible.mock.calls[0]?.[0]();
    release();
    await Promise.all(workingUntil.mock.calls.map(([done]) => done));
    expect(f.fake.geese.flatMap((g) => g.turns)).toEqual([]);
  } finally {
    release();
    f.runtime.dispose();
  }
});

it("keeps foreign-channel roots out of conversation context", async () => {
  const root = message("1", "Private root", {
    tags: [["h", "another-channel"]],
  });
  const mention = message("2", "@Goose look", {
    tags: [
      ["h", channel],
      ["e", root.id, "", "reply"],
    ],
  });
  const f = setup({ thread: [root], hold: true });
  await f.deliver(mention);
  await flush(100);
  expect(f.goose()?.turns[0]?.text).toContain("@Goose look");
  expect(f.goose()?.turns[0]?.text).not.toContain("Private root");
  expect(f.read).toHaveBeenCalledWith(
    [
      { ids: [root.id], "#h": [channel], limit: 1 },
      { kinds: [9, 40002], "#h": [channel], "#e": [root.id], limit: 200 },
    ],
    expect.anything(),
  );
});
