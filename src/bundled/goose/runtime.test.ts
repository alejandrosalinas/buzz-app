import { assignConversationFolder } from "../../features/agents/conversation-folders";
import { memoryStorage } from "../../features/agents/test-fakes";
import { workspaceCanvas } from "../../features/solo/workspace";
import type { SectionChoices } from "../../features/agent-harness/sections/choices";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import {
  type RecommendedRun,
  recommendedRun,
} from "../../features/agents/recommended";
import type { BuzzClient, Memories } from "../../buzz-mcp/client";
import { callTool, memoryVersion } from "../../buzz-mcp/tools";
import { createAgentMemories } from "../../features/agents/memory";
import {
  promptMessage,
  promptSections,
} from "../../features/agents/activity-transcript";
import { RESUMED_PROMPT, TOP_LEVEL_PROMPT } from "../../buzz-mcp/prompt";
import { STEER_NOTE, steerPrompt } from "../claude-code/prompt";
import { STEER } from "../../features/agents/activity-transcript";
import type { Agent, Delivery } from "../../features/agents/service";
import { localStore, type AgentStore } from "../../features/agents/store";
import {
  STANDALONE_PREFIX,
  standaloneSessions,
} from "../../features/agents/standalone-sessions";
import type { AgentProtection } from "../../features/agent-protection/service";
import type { Host } from "../../features/host/service";
import type { EventData, RelayEvent } from "../../features/relay/events";
import { eventDto } from "../../features/relay/events";
import { keypair, signed } from "../../features/relay/testing";
import type { RelayData } from "../../features/relay/service";
import { fakeSpawn, flush, gated } from "./goose-testing";
import { REQUEST_TIMEOUT_MS } from "./goose";
import { AcpSession } from "../../features/agent-harness/acp/session";
import { AgentProcess, AgentSessions, localSessions } from "./sessions";
import { gooseTurns, marked, unmarked } from "./transcript";
import { SHARED_POOL } from "../../features/agent-harness/acp/agent-sessions";
import {
  type ForwardNative,
  GatewayForwarding,
  type Inherited,
  NO_PROXY_UNREADABLE,
  UNREACHED,
} from "../../features/agents/gateway/forwarding";
import type { GatewayRoute } from "../../features/agents/gateway/route";
import { VECTOR_PROFILE } from "../../features/agents/gateway/vectors";
import type { ForwardOpen } from "../../features/host/forward";
import {
  type Config,
  DEFAULT_CONFIG,
  GooseRuntime,
  running,
  sessionTitle,
  standalonePrompt,
} from "./runtime";
import { explainTurn } from "./setup";

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
const bob = "b".repeat(64);
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
    added?: readonly AddedTool[];
    /** Where each session's start is kept; none is saved without one. */
    agentStore?: AgentStore;
    hold?: boolean;
    reply?: string;
    thread?: readonly EventData[];
    scope?: "thread" | "channel" | "community";
    /** The agent's `core` memory as the host keeps it. */
    core?: string | null;
    /** The channel's Canvas. */
    canvas?: string;
    repositories?: (scope: string | undefined) => string;
    resolveDirectory?: Host["resolveDirectory"];
    protection?: AgentProtection;
    /** The owner session's native memory read. */
    memoryRead?: (
      pubkey: string,
      signal: AbortSignal,
      slug?: string,
    ) => Promise<Memories>;
    thinking?: NonNullable<Parameters<typeof fakeSpawn>[0]>["thinking"];
    /** The community's relay workflow key. */
    workflowAuthority?: string;
    /** Wraps the fake's `spawn`, as `gated(…).wrap` does. */
    wrap?: (spawn: ReturnType<typeof fakeSpawn>["spawn"]) => Host["spawn"];
    forwarding?: GatewayForwarding;
    provider?: string;
    /** goose's own default provider. */
    defaultProvider?: () => Promise<string | undefined>;
    /** What agents on Recommended run on. */
    recommended?: RecommendedRun;
  }> = {},
) {
  const fake = fakeSpawn({
    hold: options.hold ?? false,
    load: true,
    // As goose lists it: a resumed session is put back on its default.
    providers: [
      { providerId: "databricks", defaultModel: "db-default" },
      { providerId: "databricks_v2", defaultModel: "db-v2-default" },
    ],
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
    resolveDirectory: options.resolveDirectory ?? fake.resolveDirectory,
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
    workflowAuthority: options.workflowAuthority,
    read,
    agentMemories: {
      open: vi.fn(() => memories),
      ...(options.memoryRead ? { read: options.memoryRead } : {}),
    },
    channels: {
      list: () => ({
        status: state.list,
        channels:
          state.list === "loading"
            ? []
            : [
                {
                  id: channel,
                  name: "general",
                  channelType: options.solo?.has(channel) ? "solo" : "stream",
                  members: [],
                },
              ],
      }),
      subscribeList: (listener: () => void) => {
        listListeners.add(listener);
        return () => listListeners.delete(listener);
      },
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
  // `retained`: a reconnecting relay keeps its session, not yet ready.
  const state: {
    status: string;
    retained?: boolean;
    list: "ready" | "loading";
  } = { status: "ready", list: "ready" };
  const listeners = new Set<() => void>();
  const listListeners = new Set<() => void>();
  const relay = {
    snapshot: () => ({
      status: state.status,
      session:
        state.status === "ready" || state.retained ? connected : undefined,
      viewer: alice,
      origin: "https://goose.example",
      scope: `https://goose.example:${alice}`,
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData;
  const core = vi.fn(async () => options.core);
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  } as Storage;
  /** Agent storage. */
  const agentStore: AgentStore = options.agentStore ?? memoryStorage();
  const runtime = new GooseRuntime(
    host,
    () => relay,
    core,
    storage,
    () => options.added ?? [],
    options.repositories,
    agentStore,
    options.recommended,
    options.forwarding,
    options.defaultProvider,
  );
  const published: { kind: number; content: string; tags: string[][] }[] = [];
  const agent = {
    key: self,
    pubkey: self,
    name: "Gander",
    owner: alice,
    relay: "wss://goose.example",
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
      config: {
        ...DEFAULT_CONFIG,
        scope: options.scope ?? "thread",
        ...(options.provider ? { provider: options.provider } : {}),
      },
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
    state,
    agent,
    core,
    storage,
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
    session,
    agentStore,
    memoryOpen: session.agentMemories.open,
    reconnect: () => {
      connected = { ...session };
    },
    /** The connection drops, until it is back. A reconnecting relay keeps
     * its session; only its status changes. */
    offline: () => {
      state.status = "connecting";
      state.retained = true;
    },
    /** How many wait for the connection to change. */
    listening: () => listeners.size,
    /** The connection is back. */
    online: () => {
      state.status = "ready";
      state.retained = false;
      for (const listener of [...listeners]) listener();
    },
    /** The community lists its channels again, until `listed`. */
    listing: () => {
      state.list = "loading";
    },
    /** How many wait for the channel list to change. */
    listWaiting: () => listListeners.size,
    /** The community has listed its channels. */
    listed: () => {
      state.list = "ready";
      for (const listener of [...listListeners]) listener();
    },
  };
}

it("reads a protected Goose file under containment and reviews the captured text before sending", async () => {
  const check = vi.fn<AgentProtection["check"]>().mockResolvedValue();
  const protection: AgentProtection = {
    key: "policy",
    stateKey: "revision",
    assertAvailable() {},
    checkEvidence: async () => {
      throw new Error("Unexpected streamed check in this fixture");
    },
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
    checkEvidence: async () => {
      throw new Error("Unexpected streamed check in this fixture");
    },
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
    checkEvidence: async () => {
      throw new Error("Unexpected streamed check in this fixture");
    },
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
      effort: "high",
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
    checkEvidence: async () => {
      throw new Error("Unexpected streamed check in this fixture");
    },
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
      checkEvidence: async () => {
        throw new Error("Unexpected streamed check in this fixture");
      },
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

  it.each([
    ["connecting", true],
    ["error", true],
    ["ready", false],
  ])(
    "checks archives in a name search while the relay is %s",
    async (status, warns) => {
      const f = setup({ hold: true });
      Object.assign(f.agent, {
        searchProfiles: vi.fn(async () => [
          {
            ...message("p", JSON.stringify({ name: "Bob" })),
            kind: 0,
            pubkey: bob,
          },
        ]),
      });
      await f.deliver(message("1", "@Gander who is Bob?"));
      await flush(100);
      Object.assign(f.state, { status, retained: true });
      const process = f.goose();
      const reply = await process?.mcp(
        process.turns[0]?.sessionId ?? "",
        "tools/call",
        { name: "users", arguments: { q: "bob" } },
      );
      const text = JSON.stringify(reply?.result);
      expect(text).toContain(bob);
      // Unknown until ready; a ready relay with no key archives no one.
      expect(text.includes("archive list could not be read")).toBe(warns);
    },
  );

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

  it("lists added tools and cancels a held write across Stop without reviving it in the next turn", async () => {
    let signal: AbortSignal | undefined;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = vi.fn();
    const tool: AddedTool = {
      name: "fixture_save",
      description: "Fixture write",
      inputSchema: { type: "object" },
      call: async (client) => {
        signal = client.signal;
        if (!signal) throw new Error("Cancellation required");
        signal.throwIfAborted();
        enter();
        await held;
        signal.throwIfAborted();
        write();
        return "saved";
      },
    };
    const f = setup({ hold: true, scope: "channel", added: [tool] });
    const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
    await f.deliver(message("1", "save"), { interruptible });
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const process = f.goose();
    const sessionId = process?.turns[0]?.sessionId;
    if (!process || !sessionId) throw new Error("Turn missing");
    expect(await process.mcp(sessionId, "tools/list")).toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: tool.name }),
        ]),
      },
    });
    const pending = process.mcp(sessionId, "tools/call", {
      name: tool.name,
      arguments: {},
    });
    try {
      await entered;
      expect(signal?.aborted).toBe(false);
      await interruptible.mock.calls[0]?.[0]();
      expect(signal?.aborted).toBe(true);
      await f.deliver(message("2", "next"));
      await vi.waitFor(() => expect(process.turns).toHaveLength(2));
      expect(signal?.aborted).toBe(true);
    } finally {
      release();
    }
    expect(await pending).toMatchObject({ result: { isError: true } });
    expect(write).not.toHaveBeenCalled();
    const old = signal;
    expect(
      await process.mcp(sessionId, "tools/call", {
        name: tool.name,
        arguments: {},
      }),
    ).not.toMatchObject({ result: { isError: true } });
    expect(signal).not.toBe(old);
    expect(signal?.aborted).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    process.turns[1]?.finish();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(
      await process.mcp(sessionId, "tools/call", {
        name: tool.name,
        arguments: {},
      }),
    ).toMatchObject({ result: { isError: true } });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("keeps steered work live, then cancels its plugin calls on a successful final send or retirement", async () => {
    const signals: AbortSignal[] = [];
    const f = setup({
      hold: true,
      scope: "channel",
      added: [
        {
          name: "fixture_signal",
          description: "Capture cancellation",
          inputSchema: { type: "object" },
          call: async (client) => {
            if (!client.signal) throw new Error("Cancellation required");
            client.signal.throwIfAborted();
            signals.push(client.signal);
            return "live";
          },
        },
      ],
    });
    try {
      await f.deliver(message("1", "first"));
      await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
      const process = f.goose();
      const id = process?.turns[0]?.sessionId;
      if (!process || !id) throw new Error("Missing turn");
      const capture = () =>
        process.mcp(id, "tools/call", { name: "fixture_signal" });
      await capture();
      await f.deliver(message("2", "steer"));
      await vi.waitFor(() => expect(process.turns[0]?.steered).toHaveLength(1));
      expect(signals[0]?.aborted).toBe(false);
      expect(
        await process.mcp(id, "tools/call", {
          name: "send",
          arguments: { text: "Finished", audience: "everyone", final: true },
          _meta: { "agent-tool-call-request-id": "final-call" },
        }),
      ).not.toMatchObject({ result: { isError: true } });
      // A burst with steered messages is not finished by a single final send.
      expect(signals[0]?.aborted).toBe(false);
      process.turns[0]?.finish();
      await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
      await f.deliver(message("3", "new work"));
      await vi.waitFor(() => expect(process.turns).toHaveLength(2));
      await capture();
      expect(signals[1]?.aborted).toBe(false);
      expect(
        await process.mcp(id, "tools/call", {
          name: "send",
          arguments: { text: "Done", audience: "everyone", final: true },
          _meta: { "agent-tool-call-request-id": "final-call" },
        }),
      ).not.toMatchObject({ result: { isError: true } });
      expect(signals[1]?.aborted).toBe(true);
      // The final tool result still reaches Goose before ACP cancel is sent.
      expect(process.cancelled).toHaveLength(0);
      process.update(id, {
        sessionUpdate: "tool_call_update",
        toolCallId: "final-call",
        status: "completed",
      });
      await vi.waitFor(() => expect(process.cancelled).toHaveLength(1));
      await f.deliver(message("4", "retire"));
      await vi.waitFor(() => expect(process.turns).toHaveLength(3));
      await capture();
      expect(signals[2]?.aborted).toBe(false);
      const retired = f.runtime.retire(self);
      expect(signals[2]?.aborted).toBe(true);
      await retired;
    } finally {
      f.runtime.dispose();
    }
  });

  it("returns no read that the owner's Stop overtook", async () => {
    let release!: () => void;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { deliver, goose } = setup({
      hold: true,
      memoryRead: async (_pubkey, _signal, slug) => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          entries: [
            { slug: slug ?? "core", body: "Read secrets", createdAt: 1 },
          ],
          partial: false,
        };
      },
    });
    const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
    await deliver(message("1", "@Gander read my notes"), { interruptible });
    await vi.waitFor(() => expect(goose()?.turns).toHaveLength(1));
    const process = goose();
    const sessionId = process?.turns[0]?.sessionId;
    if (!process || !sessionId) throw new Error("Goose turn did not start");
    const pending = process.mcp(sessionId, "tools/call", {
      name: "mem_get",
      arguments: { slug: "core" },
    });
    await reading;
    await interruptible.mock.calls[0]?.[0]();
    release();
    const reply = await pending;
    expect(reply?.result).toMatchObject({ isError: true });
    expect(JSON.stringify(reply)).not.toContain("Read secrets");
    expect(JSON.stringify(reply)).toContain("turn has ended");
  });

  it("answers a watch's or timer's Buzz calls while it runs, and none once it is stopped", async () => {
    let release: (() => void) | undefined;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = setup({
      hold: true,
      memoryRead: async (_pubkey, _signal, slug) => {
        if (slug === "mem/later") {
          entered();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return {
          entries: [
            { slug: slug ?? "core", body: `${slug} notes`, createdAt: 1 },
          ],
          partial: false,
        };
      },
    });
    const stop = new AbortController();
    const done = f.runtime.runOnce({
      delivery: { agent: f.agent, channelId: channel, config: DEFAULT_CONFIG },
      key: "timer/daily",
      signal: stop.signal,
      prompt: async () => "Check my notes.",
    } as unknown as Parameters<GooseRuntime["runOnce"]>[0]);
    try {
      await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
      const process = f.goose();
      const sessionId = process?.turns[0]?.sessionId;
      if (!process || !sessionId) throw new Error("Goose turn did not start");
      const call = (slug: string) =>
        process.mcp(sessionId, "tools/call", {
          name: "mem_get",
          arguments: { slug },
        });
      const memory = await call("core");
      expect(memory?.result).not.toMatchObject({ isError: true });
      expect(JSON.stringify(memory)).toContain("core notes");

      const pending = call("later");
      await reading;
      stop.abort(new Error("stopped"));
      await done;
      release?.();
      const refused = await pending;
      expect(refused?.result).toMatchObject({ isError: true });
      expect(JSON.stringify(refused)).not.toContain("later notes");
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

  it("builds the session's prompt with the owner's base section choices", async () => {
    const { agent, deliver, goose } = setup();
    Object.assign(agent, {
      promptSections: () => ({
        owner: {
          etiquette: { mode: "custom", text: "Be brief." },
          progress: { mode: "off" },
        },
      }),
    });
    await deliver(message("1", "@Gander hi"));
    const prompt = () => [...(goose()?.prompts.values() ?? [])].join();
    await vi.waitFor(() =>
      expect(prompt()).toContain(
        '## Etiquette\n<owner-section id="etiquette">\nBe brief.\n</owner-section>',
      ),
    );
    expect(prompt()).not.toContain("## Progress");
  });

  it("builds a conversation's prompt with the sections of the plugin that manages it, and updates it in place", async () => {
    const { agent, deliver, goose } = setup();
    const managedRoot = message("1", "@Gander hi");
    const otherRoot = message("2", "@Gander hi");
    let managed: SectionChoices = {
      plugin: {
        id: "example.plugin",
        sections: { "working-location": "Work in the task's folder." },
      },
    };
    const promptSections = vi.fn((channelId?: string, root?: string) =>
      channelId === channel && root === managedRoot.id ? managed : {},
    );
    Object.assign(agent, { promptSections });
    const wrapper =
      '## Working location\n<plugin-section id="working-location" plugin="example.plugin">\nWork in the task\'s folder.\n</plugin-section>';
    const promptOf = (turn: number) =>
      goose()?.prompts.get(goose()?.turns[turn]?.sessionId ?? "");
    await deliver(managedRoot);
    await vi.waitFor(() => expect(goose()?.turns).toHaveLength(1));
    await deliver(otherRoot);
    await vi.waitFor(() => expect(goose()?.turns).toHaveLength(2));
    expect(promptSections).toHaveBeenCalledWith(channel, managedRoot.id);
    expect(promptOf(0)).toContain(wrapper);
    expect(promptOf(0)).not.toContain("Make file changes on a new branch");
    expect(promptOf(0)).toContain("This session is one thread");
    // Another conversation of the same agent has the default rule.
    expect(promptOf(1)).not.toContain("<plugin-section id=");
    expect(promptOf(1)).toContain("Make file changes on a new branch");

    // The plugin clears its sections: the session gets the default in place.
    managed = {};
    const opened = goose()?.opened.length;
    await deliver(
      message("3", "@Gander again", {
        tags: [
          ["h", channel],
          ["e", managedRoot.id, "", "reply"],
          ["p", self],
        ],
      }),
    );
    await vi.waitFor(() => expect(goose()?.turns).toHaveLength(3));
    expect(goose()?.turns[2]?.sessionId).toBe(goose()?.turns[0]?.sessionId);
    expect(goose()?.opened).toHaveLength(opened ?? 0);
    expect(promptOf(2)).not.toContain("<plugin-section id=");
    expect(promptOf(2)).toContain("Make file changes on a new branch");
  });

  it("builds a one-off turn's prompt with no conversation's sections", async () => {
    const { agent, runOnce, goose } = setup();
    const promptSections = vi.fn(() => ({}));
    Object.assign(agent, { promptSections });
    await runOnce("timer/daily", "Post the daily summary.");
    // Asked as the session opens and as its turn starts.
    expect(promptSections.mock.calls).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ]);
    expect(goose()?.prompts.get(goose()?.turns[0]?.sessionId ?? "")).toContain(
      "This run joins no conversation",
    );
  });

  it("tells a Solo chat whose plugin gives the working location to read its Canvas's folders", async () => {
    const { agent, deliver, goose } = setup({
      solo: new Set([channel]),
      canvas: workspaceCanvas({
        folders: ["~/Development/app"],
        worktree: { location: "~/Development/trees", baseBranch: "main" },
        canvas: "Use the design system.",
      }),
    });
    Object.assign(agent, {
      // A Solo chat is one conversation, with no thread root.
      promptSections: (channelId?: string, root?: string): SectionChoices =>
        channelId === channel && !root
          ? {
              plugin: {
                id: "example.plugin",
                sections: { "working-location": "Work in the task's folder." },
              },
            }
          : {},
    });
    await deliver(message("1", "@Gander go"));
    await vi.waitFor(() => expect(goose()?.turns).toHaveLength(1));
    expect([...(goose()?.prompts.values() ?? [])].join()).toContain(
      '<plugin-section id="working-location" plugin="example.plugin">',
    );
    const turn = goose()?.turns[0]?.text;
    expect(turn).toContain("They are for reading.");
    expect(turn).not.toContain("create a new worktree");
  });

  it("reads a queued turn's Canvas with the working location its own turn's prompt has", async () => {
    const { agent, deliver, goose } = setup({
      solo: new Set([channel]),
      hold: true,
      canvas: workspaceCanvas({
        folders: ["~/Development/app"],
        worktree: { location: "~/Development/trees", baseBranch: "main" },
        canvas: "Use the design system.",
      }),
    });
    let managed = false;
    Object.assign(agent, {
      promptSections: (): SectionChoices =>
        managed
          ? {
              plugin: {
                id: "example.plugin",
                sections: { "working-location": "Work in the task's folder." },
              },
            }
          : {},
    });
    const config = { ...DEFAULT_CONFIG, provider: "openai" };
    await deliver(message("1", "@Gander go"), { config });
    await vi.waitFor(() => expect(goose()?.turns).toHaveLength(1));
    // Another model cannot join the running turn, so it waits for its own.
    await deliver(message("2", "@Gander also this"), { config, model: "o3" });
    // The plugin takes the working location before that turn starts.
    managed = true;
    goose()?.turns[0]?.finish();
    await vi.waitFor(() => expect(goose()?.turns).toHaveLength(2));
    const queued = goose()?.turns[1];
    expect(goose()?.prompts.get(queued?.sessionId ?? "")).toContain(
      '<plugin-section id="working-location" plugin="example.plugin">',
    );
    expect(queued?.text).toContain("They are for reading.");
    expect(queued?.text).not.toContain("create a new worktree");
    queued?.finish();
  });

  it("reads a queued turn's Canvas with the choices its turn took, when they change as it picks its model", async () => {
    // Held only for the queued turn's own model pick, after its prompt update.
    let picking: Promise<void> | undefined;
    let pick = () => {};
    let picked = false;
    const { agent, deliver, goose } = setup({
      solo: new Set([channel]),
      hold: true,
      canvas: workspaceCanvas({
        folders: ["~/Development/app"],
        worktree: { location: "~/Development/trees", baseBranch: "main" },
        canvas: "Use the design system.",
      }),
      wrap: (spawn) => async (id, options) => {
        const process = await spawn(id, options);
        return {
          ...process,
          write: async (data: string) => {
            if (
              picking &&
              data.includes('"method":"session/set_config_option"') &&
              data.includes('"o3"')
            ) {
              picked = true;
              await picking;
            }
            return process.write(data);
          },
        };
      },
    });
    let managed = true;
    Object.assign(agent, {
      promptSections: (): SectionChoices =>
        managed
          ? {
              plugin: {
                id: "example.plugin",
                sections: { "working-location": "Work in the task's folder." },
              },
            }
          : {},
    });
    const config = { ...DEFAULT_CONFIG, provider: "openai" };
    await deliver(message("1", "@Gander go"), { config });
    await vi.waitFor(() => expect(goose()?.turns).toHaveLength(1));
    picking = new Promise<void>((resolve) => {
      pick = resolve;
    });
    await deliver(message("2", "@Gander also this"), { config, model: "o3" });
    goose()?.turns[0]?.finish();
    await vi.waitFor(() => expect(picked).toBe(true));
    // The plugin gives the working location back once the turn's prompt
    // took its folder rule.
    managed = false;
    pick();
    await vi.waitFor(() => expect(goose()?.turns).toHaveLength(2));
    const queued = goose()?.turns[1];
    expect(goose()?.prompts.get(queued?.sessionId ?? "")).toContain(
      '<plugin-section id="working-location" plugin="example.plugin">',
    );
    expect(queued?.text).toContain("They are for reading.");
    expect(queued?.text).not.toContain("create a new worktree");
    queued?.finish();
  });

  it("reads a steer's Canvas as its running turn's prompt has the working location, and a new turn's as its own", async () => {
    const { agent, deliver, goose } = setup({
      solo: new Set([channel]),
      hold: true,
      canvas: workspaceCanvas({
        folders: ["~/Development/app"],
        worktree: { location: "~/Development/trees", baseBranch: "main" },
        canvas: "Use the design system.",
      }),
    });
    let managed = false;
    Object.assign(agent, {
      promptSections: (): SectionChoices =>
        managed
          ? {
              plugin: {
                id: "example.plugin",
                sections: { "working-location": "Work in the task's folder." },
              },
            }
          : {},
    });
    await deliver(message("1", "@Gander go"));
    await vi.waitFor(() => expect(goose()?.turns).toHaveLength(1));
    expect(goose()?.turns[0]?.text).toContain("create a new worktree");
    // The plugin takes the working location while that turn runs.
    managed = true;
    await deliver(message("2", "@Gander also this"));
    await vi.waitFor(() => expect(goose()?.turns[0]?.steered).toHaveLength(1));
    const steered = goose()?.turns[0]?.steered[0];
    expect(steered).toContain("create a new worktree");
    expect(steered).not.toContain("They are for reading.");
    goose()?.turns[0]?.finish();
    await deliver(message("3", "@Gander next"));
    await vi.waitFor(() => expect(goose()?.turns).toHaveLength(2));
    const next = goose()?.turns[1];
    expect(goose()?.prompts.get(next?.sessionId ?? "")).toContain(
      '<plugin-section id="working-location" plugin="example.plugin">',
    );
    expect(next?.text).toContain("They are for reading.");
    expect(next?.text).not.toContain("create a new worktree");
  });

  describe("a conversation given its own folder", () => {
    const scope = `https://goose.example:${alice}`;
    const root = message("1", "@Gander hi");
    const folders = (missing = new Set<string>()) =>
      vi.fn(async (path: string, options?: { create?: boolean }) => {
        if (options?.create === false && missing.has(path))
          throw new Error(`Could not find ${path}`);
        return path.replace(/^~/, "/home/test");
      });
    const assign = (
      store: AgentStore,
      conversation = `${channel}/${root.id}`,
    ) =>
      assignConversationFolder(
        store,
        scope,
        self,
        conversation,
        "/repos/worktree",
      );

    it("starts its session there and names the agent's workspace, and leaves other conversations in the workspace", async () => {
      const resolveDirectory = folders();
      const { agentStore, deliver, goose, published } = setup({
        resolveDirectory,
      });
      await assign(agentStore);
      await deliver(root);
      await vi.waitFor(() => expect(goose()?.turns).toHaveLength(1));
      await deliver(message("2", "@Gander hi"));
      await vi.waitFor(() => expect(goose()?.turns).toHaveLength(2));
      const promptOf = (turn: number) =>
        goose()?.prompts.get(goose()?.turns[turn]?.sessionId ?? "");
      expect(goose()?.opened[0]).toMatchObject({ cwd: "/repos/worktree" });
      expect(resolveDirectory).toHaveBeenCalledWith("/repos/worktree", {
        create: false,
      });
      expect(promptOf(0)).toContain(
        "<workspace>\nCurrent working directory: /repos/worktree\n</workspace>",
      );
      expect(promptOf(0)).toContain(
        "Your persistent workspace is at `/home/test/.buzz`, not in your working directory",
      );
      expect(promptOf(0)).toContain("This conversation has its own folder");
      expect(goose()?.opened[1]).toMatchObject({ cwd: "/home/test/.buzz" });
      expect(promptOf(1)).not.toContain("This conversation has its own folder");
      expect(published).toEqual([]);
    });

    it("refuses its turn, naming the folder, once the folder is gone", async () => {
      const missing = new Set<string>();
      const { agentStore, deliver, fake, published } = setup({
        resolveDirectory: folders(missing),
      });
      await assign(agentStore);
      missing.add("/repos/worktree");
      await deliver(root);
      await vi.waitFor(() =>
        expect(published.at(-1)?.content).toContain(
          "This conversation's folder /repos/worktree no longer exists",
        ),
      );
      // It never falls back to the workspace.
      expect(fake.geese.flatMap((process) => process.opened)).toEqual([]);
    });

    it("reads a file a tool names from the folder, also while Buzz reconnects", async () => {
      const { agentStore, deliver, goose, readFile, offline } = setup({
        hold: true,
      });
      readFile.mockResolvedValue(new TextEncoder().encode("From a file"));
      await assign(agentStore);
      await deliver(root);
      await flush(100);
      const process = goose();
      const send = () =>
        process?.mcp(process.turns[0]?.sessionId ?? "", "tools/call", {
          name: "send",
          arguments: { audience: "everyone", path: "notes.md" },
        });
      await send();
      offline();
      await send();
      expect(readFile.mock.calls).toEqual([
        ["notes.md", { cwd: "/repos/worktree" }],
        ["notes.md", { cwd: "/repos/worktree" }],
      ]);
    });

    it("starts a turn while Buzz reconnects in its folder, and routes one that comes then once it is back", async () => {
      const {
        agentStore,
        core,
        deliver,
        goose,
        listening,
        offline,
        online,
        published,
      } = setup({ resolveDirectory: folders() });
      await assign(agentStore);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reading!: () => void;
      const read = new Promise<void>((resolve) => {
        reading = resolve;
      });
      core.mockImplementationOnce(async () => {
        reading();
        await held;
        return undefined;
      });
      // Taken in while Buzz is connected; it starts while Buzz reconnects.
      const first = deliver(root);
      await read;
      offline();
      release();
      await first;
      await vi.waitFor(() => expect(goose()?.turns).toHaveLength(1));
      // Where one that comes now answers is not known until Buzz is back.
      const later = deliver(message("3", "@Gander hi"));
      await vi.waitFor(() => expect(listening()).toBe(1));
      expect(goose()?.turns).toHaveLength(1);
      online();
      await later;
      await vi.waitFor(() => expect(goose()?.turns).toHaveLength(2));
      expect(goose()?.opened.map((session) => session.cwd)).toEqual([
        "/repos/worktree",
        "/home/test/.buzz",
      ]);
      expect(published).toEqual([]);
    });

    it("answers a Solo chat that writes while Buzz reconnects in its own conversation", async () => {
      const { agentStore, deliver, goose, listening, offline, online } = setup({
        resolveDirectory: folders(),
        solo: new Set([channel]),
      });
      await assign(agentStore, channel);
      offline();
      const pending = deliver(message("1", "@Gander hi"));
      await vi.waitFor(() => expect(listening()).toBe(1));
      expect(goose()).toBeUndefined();
      online();
      await pending;
      await vi.waitFor(() => expect(goose()?.turns).toHaveLength(1));
      expect(goose()?.opened.map((session) => session.cwd)).toEqual([
        "/repos/worktree",
      ]);
    });

    it("answers a Solo chat once a connected community has listed its channels", async () => {
      const { agentStore, deliver, goose, listing, listWaiting, listed } =
        setup({ resolveDirectory: folders(), solo: new Set([channel]) });
      await assign(agentStore, channel);
      listing();
      const pending = deliver(message("1", "@Gander hi"));
      await vi.waitFor(() => expect(listWaiting()).toBe(1));
      expect(goose()).toBeUndefined();
      listed();
      await pending;
      await vi.waitFor(() => expect(goose()?.turns).toHaveLength(1));
      expect(goose()?.opened.map((session) => session.cwd)).toEqual([
        "/repos/worktree",
      ]);
    });

    it("refuses a folder once the conversation's first launch chose the workspace, before any session lists it", async () => {
      const held = gated("session/new");
      const { agentStore, deliver, runtime } = setup({
        hold: true,
        wrap: held.wrap,
        resolveDirectory: folders(),
      });
      try {
        void deliver(root);
        await vi.waitFor(() => expect(held.waiting()).toHaveLength(1));
        expect(runtime.sessions(self)).toEqual([]);
        await expect(assign(agentStore)).rejects.toThrow(
          "already started in the agent's workspace",
        );
        // Another conversation is still given its folder.
        await expect(
          assign(agentStore, `${channel}/${message("9", "x").id}`),
        ).resolves.toBe("/repos/worktree");
      } finally {
        held.release();
        runtime.dispose();
      }
    });

    it("lists a conversation whose session is opening before it says its sessions are listed", async () => {
      const held = gated("session/new");
      const { deliver, runtime } = setup({ hold: true, wrap: held.wrap });
      try {
        void deliver(root);
        await vi.waitFor(() => expect(held.waiting()).toHaveLength(1));
        let listed = false;
        const ready = runtime.listed(self).then(() => {
          listed = true;
        });
        await flush();
        // Nothing lists it yet, so a folder given now would come too late.
        expect(listed).toBe(false);
        expect(runtime.sessions(self)).toEqual([]);
        held.release();
        await ready;
        expect(runtime.sessions(self)).toMatchObject([
          { key: `${channel}/${root.id}`, at: expect.any(Number) },
        ]);
      } finally {
        held.release();
        runtime.dispose();
      }
    });

    it("tells a Solo chat that works there to read its Canvas's folders", async () => {
      const { agentStore, deliver, goose } = setup({
        solo: new Set([channel]),
        canvas: workspaceCanvas({
          folders: ["~/Development/app"],
          worktree: { location: "~/Development/trees", baseBranch: "main" },
          canvas: "Use the design system.",
        }),
      });
      // A Solo chat is one conversation, with no thread root.
      await assign(agentStore, channel);
      await deliver(root);
      await vi.waitFor(() => expect(goose()?.turns).toHaveLength(1));
      expect(goose()?.opened[0]).toMatchObject({ cwd: "/repos/worktree" });
      const turn = goose()?.turns[0]?.text;
      expect(turn).toContain("They are for reading.");
      expect(turn).not.toContain("create a new worktree");
    });

    it("keeps the Canvas's worktree rule for a community session when the chat kept a folder", async () => {
      const { agentStore, deliver, goose } = setup({
        scope: "community",
        solo: new Set([channel]),
        canvas: workspaceCanvas({
          folders: ["~/Development/app"],
          worktree: { location: "~/Development/trees", baseBranch: "main" },
          canvas: "Use the design system.",
        }),
      });
      // Assigned while the agent's sessions were per conversation: a
      // community session works in the agent's workspace instead.
      await assign(agentStore, channel);
      await deliver(root);
      await vi.waitFor(() => expect(goose()?.turns).toHaveLength(1));
      expect(goose()?.opened[0]?.cwd).not.toBe("/repos/worktree");
      const turn = goose()?.turns[0]?.text;
      expect(turn).toContain("create a new worktree");
      expect(turn).not.toContain("They are for reading.");
    });
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

  it("ends a turn's prompt with its conversation's instructions", async () => {
    const { agent, deliver, goose } = setup();
    const conversationInstructions = vi.fn(() => ({
      plugin: "acme.tasks",
      text: "Review only.",
    }));
    Object.assign(agent, { conversationInstructions });
    const mention = message("1", "@Gander hi");
    await deliver(mention);
    await vi.waitFor(() => expect(goose()?.turns).toHaveLength(1));
    expect(goose()?.turns[0]?.text).toMatch(
      /<owner-instructions source="acme\.tasks">\n[\s\S]*\n\nReview only\.\n<\/owner-instructions>/,
    );
    // Keyed as its notes are: the mention's thread session.
    expect(conversationInstructions).toHaveBeenCalledWith(channel, mention.id);
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
      // goose finds the conversation's sessions by these.
      tags: {
        "buzz.agent": self,
        "buzz.conversation": `${channel}/${"1".repeat(64)}`,
      },
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
    // Tagged as the agent's alone: it belongs to no conversation.
    expect(goose()?.opened[0]?._meta).toMatchObject({
      tags: { "buzz.agent": self },
    });
  });

  it("records a one-off session but not its timer while Usage is off, and removes what was kept past keeping", async () => {
    const items = new Map<string, string>();
    const agentStore = localStore({
      get length() {
        return items.size;
      },
      key: (index: number) => [...items.keys()][index] ?? null,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
      clear: () => items.clear(),
    });
    await standaloneSessions(agentStore, "goose", self, () => 0).add(
      "old",
      "timer/daily",
    );
    const { runOnce, runtime } = setup({ agentStore });
    await runOnce("timer/daily", "Post the daily summary.");
    await flush(100);
    const [start] = runtime.prompts(self).sessions();
    expect(start).toBeDefined();
    // Its id and start are kept, as for any one-off turn, but not its key.
    expect(
      [...items.keys()]
        .filter((key) => key.startsWith(STANDALONE_PREFIX))
        .flatMap((key) => JSON.parse(items.get(key) ?? "").sessions),
    ).toEqual([[start?.id, expect.any(Number)]]);
    const usage = {
      id: start?.id ?? "",
      revision: "r",
      gaps: [],
      startedAt: 1,
      lastAt: 2,
      observations: [],
    };
    await expect(runtime.withWakes(self, [usage])).resolves.toEqual([usage]);
  });

  it("tells which timer a one-off session was started for, and no conversation's", async () => {
    const items = new Map<string, string>();
    const { runOnce, deliver, runtime } = setup({
      agentStore: localStore({
        get length() {
          return items.size;
        },
        key: (index: number) => [...items.keys()][index] ?? null,
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
        removeItem: (key: string) => void items.delete(key),
        clear: () => items.clear(),
      }),
    });
    runtime.usageOn = () => true;
    await runOnce("timer/daily", "Post the daily summary.");
    await deliver(message("1", "@Gander hello"));
    await flush(100);
    const starts = runtime.prompts(self).sessions();
    expect(starts).toHaveLength(2);
    const usage = (id: string) => ({
      id,
      revision: id,
      gaps: [],
      startedAt: 1,
      lastAt: 2,
      observations: [],
    });
    await expect(
      runtime.withWakes(
        self,
        starts.map(({ id }) => usage(id)),
      ),
    ).resolves.toEqual([
      {
        ...usage(starts[0]?.id ?? ""),
        wake: "timer/daily",
        revision: expect.any(String),
      },
      usage(starts[1]?.id ?? ""),
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

  it("starts goose at a saved compaction threshold, keeping an open thread's session when it changes", async () => {
    const { agent, deliver, fake, runtime } = setup();
    const saved = (compactAt: string) =>
      runtime.sync([
        {
          ...agent,
          config: { ...DEFAULT_CONFIG, compactAt },
        } as unknown as Agent,
      ]);
    saved("150000");
    const first = message("1", "@Gander summarize this");
    await deliver(first);
    await flush(100);
    expect(fake.geese[0]?.env.GOOSE_AUTO_COMPACT_TOKEN_LIMIT).toBe("150000");
    saved("120000");
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
    // The thread keeps its session, in the goose it opened in.
    expect(fake.geese).toHaveLength(1);
    expect(fake.geese[0]?.closed).toEqual([]);
    expect(fake.geese[0]?.turns.map((turn) => turn.sessionId)).toEqual([
      "session-1",
      "session-1",
    ]);
    // Another thread's opens in a goose started at the new threshold.
    await deliver(message("3", "@Gander something else"));
    await flush(100);
    expect(fake.geese[1]?.env.GOOSE_AUTO_COMPACT_TOKEN_LIMIT).toBe("120000");
    expect(fake.geese[1]?.turns).toHaveLength(1);
    // An invalid saved value leaves goose its own.
    saved("50");
    await deliver(message("4", "@Gander one more"));
    await flush(100);
    expect(fake.geese[2]?.env).not.toHaveProperty(
      "GOOSE_AUTO_COMPACT_TOKEN_LIMIT",
    );
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

  describe("on Recommended", () => {
    // Synthetic candidates, best first, both for goose.
    const candidates = ["model-a", "model-b"].map((model) => ({
      harness: "goose",
      provider: "openai",
      model,
      effort: "max",
      label: model,
    }));
    beforeEach(() =>
      vi.stubEnv("VITE_BUZZ_RECOMMENDED_AGENT", JSON.stringify(candidates)),
    );
    afterEach(() => vi.unstubAllEnvs());
    const onIt = { ...DEFAULT_CONFIG, preset: "recommended" };

    it("runs on the first candidate still offered, found once per launch", async () => {
      const offered = vi.fn(async ({ model }: { model: string }) => {
        return model === "model-b";
      });
      const { deliver, fake } = setup({
        recommended: recommendedRun("goose", offered),
      });
      const first = message("1", "@Gander hi");
      await deliver(first, { config: onIt });
      await flush(100);
      expect(fake.geese[0]?.opened[0]?._meta).toMatchObject({
        provider: "openai",
      });
      expect(fake.geese[0]?.configured).toEqual([
        "session-1 model=model-b",
        "session-1 thinking_effort=max",
      ]);
      await deliver(
        message("2", "@Gander again", {
          tags: [
            ["h", channel],
            ["e", first.id, "", "reply"],
            ["p", self],
          ],
        }),
        { config: onIt },
      );
      await flush(100);
      // Model A was not offered; neither is asked about again.
      expect(offered.mock.calls.map(([{ model }]) => model)).toEqual([
        "model-a",
        "model-b",
      ]);
    });

    it("looks for nothing for a delivery it drops", async () => {
      const offered = vi.fn(async () => true);
      const { run } = setup({ recommended: recommendedRun("goose", offered) });
      const ignored = vi.fn();
      // A watch without an address comes as a standalone turn, so is dropped.
      await run({ type: "watch" } as unknown as Delivery["trigger"], {
        config: onIt,
        ignored,
      });
      expect(ignored).toHaveBeenCalledOnce();
      expect(offered).not.toHaveBeenCalled();
    });

    it("runs on goose's own default when no candidate is offered or the check fails", async () => {
      const offered = vi.fn(async ({ model }: { model: string }) => {
        if (model === "model-a") throw new Error("discovery failed");
        return false;
      });
      const { deliver, fake } = setup({
        recommended: recommendedRun("goose", offered),
      });
      await deliver(message("1", "@Gander hi"), { config: onIt });
      await flush(100);
      expect(offered).toHaveBeenCalledTimes(2);
      expect(fake.geese[0]?.turns).toHaveLength(1);
      expect(fake.geese[0]?.opened[0]?._meta).not.toHaveProperty("provider");
      expect(fake.geese[0]?.configured).toEqual([]);
    });
  });

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
  const accepted = vi.fn();
  await f.run(pluginWake(root.id), { accepted });
  await flush(100);
  expect(accepted).toHaveBeenCalledOnce();
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

const GOOSE_SETTINGS =
  "buzz://settings?section=agents&provider=buzz.goose%2Fgoose";
const REFUSED = `⚠️ I couldn't finish that: Goose's provider rejected its API key or sign-in. Head to [Settings](${GOOSE_SETTINGS}) to check its provider.`;
/** ACP's refusal for credentials, as goose 1.57 sends it. */
const AUTH_REQUIRED = {
  code: -32000,
  message: "Authentication required",
  data: { reason: "turn_failed" },
};

type FakeSpawn = ReturnType<typeof fakeSpawn>["spawn"];
/** A goose that answers each `method` request with `error`. */
const failing =
  (
    method: string,
    error: Readonly<{ code: number; message: string; data?: unknown }>,
  ) =>
  (spawn: FakeSpawn) =>
  async (id: string, options: NonNullable<Parameters<FakeSpawn>[1]> = {}) => {
    const process = await spawn(id, options);
    return {
      ...process,
      write: async (data: string) => {
        if (id !== "goose" || !data.includes(`"method":"${method}"`))
          return process.write(data);
        options.onStdout?.(
          `${JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(data).id, error })}\n`,
        );
      },
    };
  };

// As goose 1.57 fails a turn.
it.each([
  [
    "lacks its provider's key, linking Goose's Settings and quoting goose",
    "session/prompt",
    {
      code: -32603,
      message: "Internal error",
      data: "Error getting agent reply: Configuration value not found: ANTHROPIC_API_KEY",
    },
    `⚠️ I couldn't finish that: Goose is missing an API key (ANTHROPIC_API_KEY). Head to [Settings](${GOOSE_SETTINGS}) to add it.\n\ngoose said:\n> Internal error: Error getting agent reply: Configuration value not found: ANTHROPIC_API_KEY`,
  ],
  [
    "had its key refused, linking Goose's Settings and quoting goose",
    "session/prompt",
    AUTH_REQUIRED,
    `${REFUSED}\n\ngoose said:\n> Authentication required`,
  ],
  [
    "had its key refused opening the session, linking Goose's Settings and quoting goose",
    "session/new",
    AUTH_REQUIRED,
    `${REFUSED}\n\ngoose said:\n> goose could not start: Authentication required`,
  ],
  [
    "failed otherwise, in goose's words",
    "session/prompt",
    {
      code: -32603,
      message: "Internal error",
      data: "Error getting agent reply: Request failed: connection refused",
    },
    "⚠️ I couldn't finish that: Internal error: Error getting agent reply: Request failed: connection refused",
  ],
])("reports a turn whose goose %s", async (_, method, error, content) => {
  const f = setup({ wrap: failing(method, error) });
  f.runtime.explain = (failure) => explainTurn(failure, GOOSE_SETTINGS);
  try {
    await f.deliver(message("1", "@Gander hi"));
    await vi.waitFor(() =>
      expect(f.published.map((post) => post.content)).toEqual([content]),
    );
  } finally {
    f.runtime.dispose();
  }
});

it("gives the workflow reason for its owner's workflow mention that doesn't name it", async () => {
  const relay = keypair();
  const f = setup({ workflowAuthority: relay.pubkey });
  const ignored = vi.fn();
  await f.deliver(
    eventDto(
      signed(relay, {
        kind: 9,
        content: "@Agent workflow",
        tags: [
          ["h", channel],
          ["p", self],
          ["buzz:workflow", "true"],
          ["buzz:workflow-owner", alice],
        ],
      }),
    ),
    { ignored },
  );
  expect(ignored).toHaveBeenCalledExactlyOnceWith("workflow");
  expect(f.goose()).toBeUndefined();
});

it("waits for the community before it routes a mention, a workflow's or its owner's", async () => {
  const relay = keypair();
  const f = setup({ workflowAuthority: relay.pubkey });
  f.state.status = "connecting";
  const stop = new AbortController();
  const own = f.deliver(message("1", "Say hi"), { signal: stop.signal });
  const workflow = f.deliver(
    eventDto(
      signed(relay, {
        kind: 9,
        content: "@Agent workflow",
        tags: [
          ["h", channel],
          ["p", self],
          ["buzz:workflow", "true"],
          ["buzz:workflow-owner", alice],
        ],
      }),
    ),
    { signal: stop.signal },
  );
  await vi.waitFor(() => expect(f.listening()).toBe(2));
  stop.abort();
  await Promise.all([
    expect(own).rejects.toThrow("This turn could not start"),
    expect(workflow).rejects.toThrow("Workflow request could not start"),
  ]);
  expect(f.goose()).toBeUndefined();
});

it("ignores a workflow mention whose agent was replaced during the wait", async () => {
  const relay = keypair();
  const f = setup({ workflowAuthority: relay.pubkey });
  const ignored = vi.fn();
  // The community is ready, so the wait ends at once; the agent is gone by then.
  await f.deliver(
    eventDto(
      signed(relay, {
        kind: 9,
        content: "@Agent workflow",
        tags: [
          ["h", channel],
          ["p", self],
          ["buzz:workflow", "true"],
          ["buzz:workflow-owner", alice],
        ],
      }),
    ),
    { ignored, current: () => false },
  );
  expect(ignored).toHaveBeenCalledExactlyOnceWith();
  expect(f.goose()).toBeUndefined();
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

it("steers a channel session across threaded and top-level requests", async () => {
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
    await vi.waitFor(() =>
      expect(process.turns[0]?.steered).toEqual([
        expect.stringContaining("channel work"),
      ]),
    );
    const reply = await process.mcp(
      process.turns[0]?.sessionId ?? "",
      "tools/call",
      {
        name: "send",
        arguments: {
          audience: "everyone",
          text: "thread reply",
          reply: "1".repeat(64),
        },
      },
    );
    expect(reply.result).not.toMatchObject({ isError: true });
    const topLevelReply = await process.mcp(
      process.turns[0]?.sessionId ?? "",
      "tools/call",
      {
        name: "send",
        arguments: { channel, audience: "everyone", text: "channel reply" },
      },
    );
    expect(topLevelReply.result).not.toMatchObject({ isError: true });
    expect(
      f.published.map((post) => [
        post.content,
        post.tags.filter(([tag]) => tag === "e"),
      ]),
    ).toEqual([
      ["thread reply", [["e", "1".repeat(64), "", "reply"]]],
      ["channel reply", []],
    ]);
    expect(process.turns).toHaveLength(1);
    process.turns[0]?.finish();
  } finally {
    f.runtime.dispose();
  }
});

it("finishes a Solo turn under its policy when the chat is shared mid-turn", async () => {
  const solo = new Set([channel]);
  const f = setup({ hold: true, scope: "channel", solo });
  f.agent.query.mockResolvedValue([message("2", "after share")]);
  try {
    await f.deliver(message("1", "solo work"));
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const process = f.goose();
    if (!process) throw new Error("Expected Goose process");
    solo.delete(channel);
    await f.deliver(message("2", "after share"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // It waits for the Solo turn rather than steering into it.
    expect(process.turns[0]?.steered).toEqual([]);
    expect(process.turns).toHaveLength(1);
    process.turns[0]?.finish();
    await vi.waitFor(() => expect(process.turns).toHaveLength(2));
    expect(process.turns[1]?.text).toContain("after share");
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
    await f.run(
      {
        type: "plugin",
        plugin: "example",
        channel,
        topLevel: true,
        id: "f".repeat(64),
        at: 200_000,
        text: "channel work",
      },
      { effort: "high" },
    );
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
      effort: "high",
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

it("keeps steering a turn's effort through a follow-up without a pick", async () => {
  const f = setup({ hold: true, scope: "channel" });
  try {
    await f.deliver(message("1", "threaded work"), { effort: "high" });
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const process = f.goose();
    if (!process) throw new Error("Expected Goose process");
    const wake = (id: string, text: string) => ({
      type: "plugin" as const,
      plugin: "example",
      channel,
      topLevel: true as const,
      id: id.repeat(64),
      at: 200_000,
      text,
    });
    await f.run(wake("e", "no pick"));
    await f.run(wake("f", "high again"), { effort: "high" });
    await vi.waitFor(() =>
      expect(process.turns[0]?.steered).toEqual([
        expect.stringContaining("no pick"),
        expect.stringContaining("high again"),
      ]),
    );
    expect(process.turns).toHaveLength(1);
    process.turns[0]?.finish();
  } finally {
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
    await f.deliver(message("1", "threaded work"), { effort: "high" });
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
        effort: "high",
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
      effort: "high",
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

it("marks each fallback wake's prompt with its own turn, however rebuilt, and keeps its notice until the agent retires", async () => {
  const f = setup({ hold: true, scope: "channel" });
  const fallback = {
    gatewayFallback: { reason: "disabled", notice: "Ran without the gateway." },
  } as unknown as Partial<Delivery>;
  const MARK = /\n\n<buzz-turn id="([0-9a-f-]{36})"\/>$/;
  let instructions = "Old Interest instructions";
  try {
    await f.deliver(message("1", "threaded work"));
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    await f.run({ ...pluginWake(), topLevel: true, text: instructions }, {
      ...fallback,
      wakeText: async () => instructions,
    } as Partial<Delivery>);
    instructions = "Updated Interest instructions";
    f.goose()?.turns[0]?.finish();
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(2));
    // Rebuilt once its wait ends, under the turn it was given.
    const first = f.goose()?.turns[1]?.text.match(MARK)?.[1];
    expect(f.goose()?.turns[1]?.text).toContain(instructions);
    expect(f.runtime.notices(f.agent.key)).toEqual(
      new Map([[first, "Ran without the gateway."]]),
    );
    expect(f.goose()?.turns[0]?.text).not.toContain("buzz-turn");
    f.goose()?.turns[1]?.finish();
    // A wake through the gateway, or none, is never marked.
    await f.run({ ...pluginWake(), topLevel: true, text: "routed" });
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(3));
    expect(f.goose()?.turns[2]?.text).not.toContain("buzz-turn");
    f.goose()?.turns[2]?.finish();
    await f.run({ ...pluginWake(), topLevel: true, text: "again" }, fallback);
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(4));
    const second = f.goose()?.turns[3]?.text.match(MARK)?.[1];
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect([...f.runtime.notices(f.agent.key).keys()]).toEqual([first, second]);
    f.goose()?.turns[3]?.finish();
    // A failed retirement keeps them with the agent; one that ends drops them.
    vi.spyOn(AgentSessions.prototype, "shutdown").mockRejectedValueOnce(
      new Error("stuck"),
    );
    await expect(f.runtime.retire(f.agent.key)).rejects.toThrow("stuck");
    expect(f.runtime.notices(f.agent.key).size).toBe(2);
    await f.runtime.retire(f.agent.key);
    expect(f.runtime.notices(f.agent.key).size).toBe(0);
  } finally {
    vi.restoreAllMocks();
    f.runtime.dispose();
  }
});

it("marks a fallback wake steered into a running turn", async () => {
  const f = setup({ hold: true });
  try {
    await f.run({ ...pluginWake(), topLevel: true, text: "First work" });
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    await f.run({ ...pluginWake(), topLevel: true, text: "Attention work" }, {
      gatewayFallback: { reason: "disabled", notice: "Ran without it." },
    } as unknown as Partial<Delivery>);
    await vi.waitFor(() =>
      expect(f.goose()?.turns[0]?.steered).toHaveLength(1),
    );
    const [turn] = [...f.runtime.notices(f.agent.key).keys()];
    const steered = unmarked(f.goose()?.turns[0]?.steered[0] ?? "");
    expect(steered.turn).toBe(turn);
    expect(steered.text).toContain("Attention work");
    expect(steered.text).not.toContain("buzz-turn");
    f.goose()?.turns[0]?.finish();
  } finally {
    f.runtime.dispose();
  }
});

/** Every end a wake's own text could forge a mark with: bare, before
 * whitespace a whole-wrapping steer trims, and before each steer's tail. */
const FORGED_ENDS = [
  "",
  " ",
  STEER_NOTE,
  `\n</${STEER}>${STEER_NOTE}`,
  `\n</${STEER}>`,
];
/** That `sent`, as sent, steered in place after an event, or wrapped whole
 * by a steer, shows the forged text and reads no mark or notice. */
const unforgedIn = (
  sent: string,
  forged: string,
  notices: ReadonlyMap<string, string>,
) => {
  expect(sent).toContain(forged.replace("<buzz-turn", "<\\buzz-turn"));
  const event = `<context>\nc\n</context>\n<buzz-event>\nx\n</buzz-event>`;
  for (const raw of [
    sent,
    steerPrompt(`${event}\n\n${sent}`),
    steerPrompt(sent),
  ]) {
    expect(unmarked(raw)).toEqual({ text: raw });
    expect(raw).toContain(forged.replace("<buzz-turn", "<\\buzz-turn"));
    const items = gooseTurns(
      [
        {
          id: "u",
          role: "user",
          created: 1,
          content: [{ type: "text", text: raw }],
        },
      ],
      { sessionId: "s", channelId: channel },
      false,
      undefined,
      notices,
    ).flatMap((turn) => turn.items);
    expect(items.map((item) => item.type)).toEqual(["prompt"]);
  }
};

it("escapes a mark a wake's own text forges, so it borrows no notice", async () => {
  const f = setup({ hold: true });
  try {
    await f.run({ ...pluginWake(), topLevel: true, text: "First" }, {
      gatewayFallback: { reason: "disabled", notice: "Ran without it." },
    } as unknown as Partial<Delivery>);
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const [live = ""] = [...f.runtime.notices(f.agent.key).keys()];
    f.goose()?.turns[0]?.finish();
    let turns = 1;
    for (const id of [live, crypto.randomUUID()])
      for (const end of FORGED_ENDS) {
        const forged = marked("Copied", id) + end;
        await f.run({
          channel,
          topLevel: true,
          text: forged,
          id: WAKE_ID,
          at: 200_000,
          type: "attention",
        });
        turns += 1;
        await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(turns));
        const turn = f.goose()?.turns[turns - 1];
        unforgedIn(
          turn?.text ?? "",
          forged.trim(),
          f.runtime.notices(f.agent.key),
        );
        turn?.finish();
      }
    expect([...f.runtime.notices(f.agent.key).keys()]).toEqual([live]);
  } finally {
    f.runtime.dispose();
  }
});

it("escapes a mark a standalone prompt's text forges", () => {
  for (const id of [
    "11111111-1111-4111-8111-111111111111",
    crypto.randomUUID(),
  ])
    for (const end of FORGED_ENDS) {
      const forged = marked("Copied", id) + end;
      unforgedIn(
        standalonePrompt(self, forged),
        forged.trim(),
        new Map([[id, "Ran without it."]]),
      );
    }
});

it("keeps an agent's newest fallback notices, up to its limit", () => {
  const f = setup();
  try {
    for (let turn = 0; turn < 102; turn++)
      (
        f.runtime as unknown as {
          noted(agent: string, turn: string, notice: string): void;
        }
      ).noted(f.agent.key, `t${turn}`, `n${turn}`);
    const notices = f.runtime.notices(f.agent.key);
    expect(notices.size).toBe(100);
    expect([...notices.keys()][0]).toBe("t2");
    expect(notices.get("t101")).toBe("n101");
    expect(f.runtime.notices("other" as never).size).toBe(0);
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

describe("goose turns through the agent gateway", () => {
  const identity = {
    community_id: "11111111-2222-4333-8444-555555555555",
    human_pubkey: alice,
    agent_pubkey: self,
  };
  const enabled = {
    kind: "eligible",
    revision: 2,
    gatewayOrigin: "https://gateway.example",
    identity,
    profile: VECTOR_PROFILE,
    harnesses: ["goose"],
  } as const;
  const { headers } = VECTOR_PROFILE;
  /** The shared opener over a native side and route the test controls. */
  const gateway = (
    route: GatewayRoute = enabled,
    closeError?: Error,
    inherited: () => Promise<Inherited> = async () => ({
      lists: ["", ""],
      proxied: false,
    }),
  ) => {
    const opens: ForwardOpen[] = [];
    const calls: string[] = [];
    const native: ForwardNative = {
      push: vi.fn(async () => ({ type: "applied", revoked: 0 }) as const),
      open: vi.fn(async (_owner, options) => {
        opens.push(options);
        return {
          type: "opened" as const,
          id: opens.length,
          url: `http://127.0.0.1:9/g${opens.length}`,
        };
      }),
      associate: vi.fn(
        async (_owner, id, session) =>
          void calls.push(`associate ${id} ${session}`),
      ),
      register: vi.fn(async () => ({ type: "registered" }) as const),
      seal: vi.fn(async (_owner, id) => void calls.push(`seal ${id}`)),
      close: vi.fn(async (_owner, id) => {
        calls.push(`close ${id}`);
        if (closeError) throw closeError;
        opens[id - 1]?.onEvent({ type: "closed" });
      }),
    };
    const forwarding = new GatewayForwarding(
      { id: "buzz.goose", revision: "r1" },
      { upstream: "goose", native: "goose" },
      inherited,
      native,
      { routeFor: () => route, subscribeRoute: () => () => {} },
    );
    return { forwarding, opens, calls, native };
  };
  /** The runner's frozen `gateway` for a turn at `route`. */
  const dispatched = (route: typeof enabled = enabled) =>
    ({
      gateway: {
        route,
        turn: { channel_id: null, message_id: "1".repeat(64), thread_id: null },
        upstream: { base: "/goose" },
      },
    }) as unknown as Partial<Delivery>;
  const root = message("1", "Howzit");
  const key = `${channel}/${root.id}`;

  it("answers a forwarded turn's Buzz tool calls while it runs, and not after", async () => {
    const write = vi.fn();
    const tool: AddedTool = {
      name: "fixture_save",
      description: "Fixture write",
      inputSchema: { type: "object" },
      // A relay read checks that the call's turn is still running.
      call: async (client) => {
        await client.query([{ kinds: [1], limit: 1 }]);
        write();
        return "saved";
      },
    };
    const g = gateway();
    const f = setup({
      forwarding: g.forwarding,
      provider: "databricks",
      hold: true,
      added: [tool],
    });
    try {
      await f.deliver(root, dispatched());
      await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
      const goose = f.fake.geese[0];
      const sessionId = goose?.turns[0]?.sessionId;
      if (!goose || !sessionId) throw new Error("Forwarded turn missing");
      const call = () =>
        goose.mcp(sessionId, "tools/call", { name: tool.name, arguments: {} });
      expect(await call()).not.toMatchObject({ result: { isError: true } });
      expect(write).toHaveBeenCalledTimes(1);
      goose.turns[0]?.finish();
      await vi.waitFor(() => expect(g.calls).toContain("close 1"));
      // Its goose and Buzz tools' server are gone with it.
      await expect(call()).rejects.toThrow("No Buzz MCP server");
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      f.runtime.dispose();
    }
  });

  it("runs each turn in a goose of its own on its generation, resuming the session and binding it saved", async () => {
    const g = gateway();
    const f = setup({ forwarding: g.forwarding, provider: "databricks" });
    try {
      await f.deliver(root, dispatched());
      await vi.waitFor(() => expect(g.calls).toContain("close 1"));
      const saved = localSessions(f.storage, self).get(key);
      expect(saved?.sessions).toEqual(["session-1"]);
      expect(saved?.binding).toMatchObject({
        session: "session-1",
        value: { v: 1, identity },
      });
      await f.deliver(
        message("2", "Again", {
          tags: [
            ["h", channel],
            ["e", root.id, "", "reply"],
          ],
        }),
        dispatched(),
      );
      await vi.waitFor(() => expect(g.calls).toContain("close 2"));
      const [first, second] = f.fake.geese;
      // Never the shared goose: one per generation, each on its own URL.
      expect(f.fake.geese).toHaveLength(2);
      expect(first?.env.DATABRICKS_HOST).toBe("http://127.0.0.1:9/g1");
      expect(second?.env.DATABRICKS_HOST).toBe("http://127.0.0.1:9/g2");
      expect(first?.turns).toHaveLength(1);
      // Tagged as an ordinary session is, so its conversation finds it.
      expect(first?.opened[0]?._meta).toMatchObject({
        tags: { "buzz.conversation": key },
      });
      expect(second?.loaded).toEqual(["session-1"]);
      expect(second?.opened).toEqual([]);
      expect(second?.turns).toHaveLength(1);
      expect(g.opens[1]?.inference[headers.launcher_session]).toBe(
        g.opens[0]?.inference[headers.launcher_session],
      );
      expect(g.calls).toEqual([
        "associate 1 session-1",
        "seal 1",
        "close 1",
        "associate 2 session-1",
        "seal 2",
        "close 2",
      ]);
      expect(first?.killed && second?.killed).toBe(true);
      expect(f.published).toEqual([]);
      // The new session's prompt is kept once; the resumed one adds none.
      const prompts = f.runtime.prompts(self);
      await vi.waitFor(() =>
        expect(prompts.sessions()).toEqual([
          {
            id: "session-1",
            at: expect.any(Number),
            title: expect.any(String),
            conversation: key,
          },
        ]),
      );
      expect(prompts.get("session-1")).toEqual([
        { label: "", text: expect.stringContaining("Buzz") },
      ]);
    } finally {
      f.runtime.dispose();
    }
  });

  it("shows a forwarded turn working in the Activity snapshot until it settles", async () => {
    const g = gateway();
    const f = setup({
      forwarding: g.forwarding,
      provider: "databricks",
      hold: true,
    });
    try {
      f.runtime.subscribe(() => void f.runtime.sessions(self));
      await f.deliver(root, dispatched());
      await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
      expect(f.runtime.sessions(self)).toMatchObject([
        { key, busy: true, sessionId: "session-1" },
      ]);
      f.fake.geese[0]?.turns[0]?.finish();
      await vi.waitFor(() => expect(g.calls).toContain("close 1"));
      expect(f.runtime.sessions(self).filter((row) => row.busy)).toEqual([]);
    } finally {
      f.runtime.dispose();
    }
  });

  it("refuses a turn it can't forward, visibly and before anything spawns", async () => {
    const refusals: [Parameters<typeof setup>[0], string][] = [
      [{ provider: "databricks" }, "Buzz couldn't start forwarding"],
    ];
    for (const [options, error] of refusals) {
      const f = setup(options);
      try {
        await f.deliver(root, dispatched());
        await vi.waitFor(() => expect(f.published).toHaveLength(1));
        expect(f.published[0]?.content).toContain(error);
        expect(f.fake.geese).toEqual([]);
      } finally {
        f.runtime.dispose();
      }
    }
  });

  it("refuses a forwarded mention in community scope before starting Goose", async () => {
    const g = gateway();
    const f = setup({
      forwarding: g.forwarding,
      provider: "databricks",
      scope: "community",
    });
    try {
      await f.deliver(root, dispatched());
      await vi.waitFor(() =>
        expect(f.published[0]?.content).toContain(
          "Goose cannot use the agent gateway with Community session scope",
        ),
      );
      expect(g.opens).toEqual([]);
      expect(f.fake.geese).toEqual([]);
    } finally {
      f.runtime.dispose();
    }
  });

  it("keeps a forwarded goose's loopback requests off an inherited proxy, adding loopback to both no-proxy lists", async () => {
    const g = gateway(enabled, undefined, async () => ({
      lists: ["corp.example, 10.0.0.0/8", "internal localhost"],
      proxied: true,
    }));
    const f = setup({ forwarding: g.forwarding, provider: "databricks" });
    try {
      await f.deliver(root, dispatched());
      await vi.waitFor(() => expect(g.calls).toContain("close 1"));
      const list = "corp.example,10.0.0.0/8,internal,localhost,127.0.0.1";
      expect(f.fake.geese[0]?.env).toMatchObject({
        NO_PROXY: list,
        no_proxy: list,
      });
    } finally {
      f.runtime.dispose();
    }
  });

  it("refuses a forwarded turn whose proxy exceptions are unreadable, before anything spawns", async () => {
    const g = gateway(enabled, undefined, async () => {
      throw new Error("No host to read proxy exceptions");
    });
    const f = setup({ forwarding: g.forwarding, provider: "databricks" });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await f.deliver(root, dispatched());
      await vi.waitFor(() => expect(f.published).toHaveLength(1));
      expect(f.published[0]?.content).toContain(NO_PROXY_UNREADABLE);
      expect(g.opens).toEqual([]);
      expect(f.fake.geese).toEqual([]);
    } finally {
      warned.mockRestore();
      f.runtime.dispose();
    }
  });

  it("says no model request reached the gateway when a failed turn's only admitted request was discovery", async () => {
    const g = gateway();
    const f = setup({
      forwarding: g.forwarding,
      provider: "databricks",
      hold: true,
    });
    try {
      await f.deliver(root, dispatched());
      await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
      g.opens[0]?.onEvent({
        type: "admitted",
        request: 1,
        class: "discovery",
        child: false,
      });
      f.fake.geese[0]?.turns[0]?.finish("refusal");
      await vi.waitFor(() => expect(f.published).toHaveLength(1));
      expect(f.published[0]?.content).toContain(
        `${UNREACHED} goose refused the request`,
      );
    } finally {
      f.runtime.dispose();
    }
  });

  it.each(["databricks", "databricks_v2"])(
    "forwards on goose's %s default when the agent names none",
    async (provider) => {
      const g = gateway();
      const f = setup({
        forwarding: g.forwarding,
        defaultProvider: async () => provider,
      });
      try {
        await f.deliver(root, dispatched());
        await vi.waitFor(() => expect(g.calls).toContain("close 1"));
        expect(g.opens).toHaveLength(1);
        expect(f.fake.geese[0]?.env).toMatchObject({
          DATABRICKS_HOST: "http://127.0.0.1:9/g1",
          GOOSE_PROVIDER: provider,
          GOOSE_SUBAGENT_PROVIDER: provider,
        });
        expect(f.fake.geese[0]?.opened[0]?._meta).not.toHaveProperty(
          "provider",
        );
        expect(f.fake.geese[0]?.configured).toEqual([]);
        expect(f.published).toEqual([]);
      } finally {
        f.runtime.dispose();
      }
    },
  );

  it.each(["explicit", "Automatic"] as const)(
    "forwards a %s Databricks AI Gateway model and keeps its provider for delegates",
    async (selection) => {
      const provider = "databricks_v2";
      const model = "catalog.schema.model";
      const g = gateway();
      vi.stubEnv(
        "VITE_BUZZ_RECOMMENDED_AGENT",
        JSON.stringify({
          candidates: [
            {
              harness: "goose",
              provider,
              model,
              effort: "high",
              label: "Model",
            },
          ],
        }),
      );
      const f = setup({
        forwarding: g.forwarding,
        recommended: recommendedRun("goose", async () => true),
      });
      try {
        await f.deliver(root, {
          ...dispatched(),
          config: {
            ...DEFAULT_CONFIG,
            ...(selection === "Automatic"
              ? { preset: "recommended" }
              : { provider, model }),
          },
        });
        await vi.waitFor(() => expect(g.calls).toContain("close 1"));
        const goose = f.fake.geese[0];
        expect(goose?.opened[0]?._meta).toMatchObject({ provider });
        expect(goose?.configured).toContain(`session-1 model=${model}`);
        expect(goose?.env).toMatchObject({
          GOOSE_SUBAGENT_PROVIDER: provider,
          GOOSE_SUBAGENT_MODEL: model,
        });
      } finally {
        f.runtime.dispose();
        vi.unstubAllEnvs();
      }
    },
  );

  it.each<[string, Parameters<typeof setup>[0]]>([
    ["another provider", { provider: "openai" }],
    [
      "goose's default, another provider",
      { defaultProvider: async () => "openai" },
    ],
    ["goose's default, unread", { defaultProvider: async () => undefined }],
    [
      "goose's default, unreadable",
      { defaultProvider: () => Promise.reject(new Error("no goose")) },
    ],
  ])(
    "runs a dispatched turn on %s as it would without the gateway",
    async (_, options) => {
      const g = gateway();
      const f = setup({ ...options, forwarding: g.forwarding });
      try {
        await f.deliver(root, dispatched());
        await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
        expect(g.opens).toEqual([]);
        expect(f.goose()?.env.DATABRICKS_HOST).toBeUndefined();
        expect(f.published.map((event) => event.content)).not.toContainEqual(
          expect.stringContaining("gateway"),
        );
      } finally {
        f.runtime.dispose();
      }
    },
  );

  it("runs a protected agent's dispatched turn inside its containment, as it would without the gateway", async () => {
    const g = gateway();
    const f = setup({ forwarding: g.forwarding, provider: "databricks" });
    const policy = protection("policy-1", () => f);
    const spawn = vi.fn(policy.spawn);
    Object.assign(f.agent, { protection: { ...policy, spawn } });
    try {
      await f.deliver(root, dispatched());
      await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
      expect(g.opens).toEqual([]);
      expect(f.goose()?.env.DATABRICKS_HOST).toBeUndefined();
      // Started by the agent's protected spawn, not the plain one.
      expect(spawn).toHaveBeenCalledOnce();
      expect(f.published.map((event) => event.content)).not.toContainEqual(
        expect.stringContaining("gateway"),
      );
    } finally {
      f.runtime.dispose();
    }
  });

  it("runs a protected agent's standalone turn and compaction as it would without the gateway", async () => {
    const g = gateway();
    const f = setup({
      forwarding: g.forwarding,
      provider: "databricks",
      reply: "Compaction complete",
    });
    Object.assign(f.agent, { protection: protection("policy-1", () => f) });
    const agent = {
      ...f.agent,
      config: { ...DEFAULT_CONFIG, provider: "databricks" },
    } as unknown as Agent;
    try {
      f.runtime.sync([agent]);
      await expect(
        f.runtime.runOnce({
          delivery: {
            agent: f.agent,
            channelId: channel,
            config: { ...DEFAULT_CONFIG, provider: "databricks" },
            ...dispatched(),
          },
          key: "Timer",
          signal: new AbortController().signal,
          prompt: async () => "Check in",
        } as unknown as Parameters<GooseRuntime["runOnce"]>[0]),
      ).resolves.toMatchObject({ ok: true });
      await f.runtime.session(
        agent,
        { channelId: channel, root: root.id },
        "compact",
      );
      expect(g.opens).toEqual([]);
      expect(f.fake.geese.every((goose) => !goose.env.DATABRICKS_HOST)).toBe(
        true,
      );
    } finally {
      f.runtime.dispose();
    }
  });

  it("compacts as without the gateway, refusing nothing, once the agent's provider is another", async () => {
    const g = gateway();
    const f = setup({
      forwarding: g.forwarding,
      provider: "databricks",
      reply: "Compaction complete",
    });
    const place = { channelId: channel, root: root.id };
    try {
      await f.deliver(root, dispatched());
      await vi.waitFor(() => expect(g.calls).toContain("close 1"));
      const agent = {
        ...f.agent,
        config: { ...DEFAULT_CONFIG, provider: "openai" },
      } as unknown as Agent;
      f.runtime.sync([agent]);
      await f.runtime.session(agent, place, "compact");
      // goose's own compaction, which has no open session to compact.
      expect(g.opens).toHaveLength(1);
      expect(f.fake.geese).toHaveLength(1);
    } finally {
      f.runtime.dispose();
    }
  });

  it("resumes the session an ordinary turn saved once the conversation forwards, until New session", async () => {
    const g = gateway();
    const f = setup({ forwarding: g.forwarding, provider: "databricks" });
    const reply = (id: string, text: string) =>
      message(id, text, {
        tags: [
          ["h", channel],

          ["e", root.id, "", "reply"],
        ],
      });
    try {
      const agent = { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent;
      const place = { channelId: channel, root: root.id };
      // Before the membership routes through the gateway: the agent's own
      // goose, with no binding saved.
      await f.deliver(root);
      await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
      const [shared] = f.fake.geese;
      const ordinary = localSessions(f.storage, self).get(key);
      const [first] = ordinary?.sessions ?? [];
      expect(first).toBeDefined();
      expect(ordinary).not.toHaveProperty("binding");
      expect(g.native.open).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(f.runtime.sessionState(agent, place)).toBe("idle"),
      );

      // Forwarded: its own goose resumes that session, saving a binding
      // of its own with it.
      await f.deliver(reply("2", "Again"), dispatched());
      await vi.waitFor(() => expect(g.calls).toContain("close 1"));
      const resumed = f.fake.geese[1];
      expect(resumed).not.toBe(shared);
      expect(resumed?.env.DATABRICKS_HOST).toBe("http://127.0.0.1:9/g1");
      expect(resumed?.loaded).toEqual([first]);
      expect(resumed?.opened).toEqual([]);
      expect(resumed?.turns).toHaveLength(1);
      const bound = localSessions(f.storage, self).get(key);
      expect(bound?.sessions?.[0]).toBe(first);
      expect(bound?.binding).toMatchObject({
        session: first,
        value: { v: 1, identity },
      });
      expect(g.calls).toEqual([`associate 1 ${first}`, "seal 1", "close 1"]);
      await vi.waitFor(() =>
        expect(f.runtime.sessionState(agent, place)).toBe("idle"),
      );

      // New session: the next forwarded turn loads nothing, opening a
      // session under a fresh Buzz session of its own.
      await f.runtime.session(agent, place, "new");
      await f.deliver(reply("3", "Fresh"), dispatched());
      await vi.waitFor(() => expect(g.calls).toContain("close 2"));
      const reset = f.fake.geese[2];
      expect(reset?.loaded).toEqual([]);
      expect(reset?.opened).toHaveLength(1);
      const after = localSessions(f.storage, self).get(key);
      const opened = after?.sessions?.[0];
      // Each fake goose numbers its own sessions; what shows it is new is
      // that it was opened, not loaded.
      expect(opened).toBeDefined();
      expect(after?.next).toBeUndefined();
      expect(after?.binding).toMatchObject({ session: opened });
      expect(g.calls.slice(3)).toEqual([
        `associate 2 ${opened}`,
        "seal 2",
        "close 2",
      ]);
      expect(g.opens[1]?.inference[headers.launcher_session]).not.toBe(
        g.opens[0]?.inference[headers.launcher_session],
      );
      expect(f.published).toEqual([]);
    } finally {
      f.runtime.dispose();
    }
  });

  it("refuses a saved binding it can't read, keeping it, until New session", async () => {
    const g = gateway();
    const f = setup({ forwarding: g.forwarding, provider: "databricks" });
    try {
      const agent = { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent;
      const place = { channelId: channel, root: root.id };
      // Not a binding, no value at all, and no saved wrapper.
      for (const binding of [
        { session: "session-9", value: { v: 2 } },
        { session: "session-9", value: null },
        { session: 9 },
      ]) {
        const damaged = { at: 1, sessions: ["session-9"], binding };
        localSessions(f.storage, self).set(key, damaged);
        const before = f.published.length;
        await f.deliver(root, dispatched());
        await vi.waitFor(() => expect(f.published).toHaveLength(before + 1));
        expect(f.published.at(-1)?.content).toContain("unreadable");
        expect(localSessions(f.storage, self).get(key)).toEqual(damaged);
        await vi.waitFor(() =>
          expect(f.runtime.sessionState(agent, place)).toBe("idle"),
        );
      }
      expect(f.fake.geese).toEqual([]);
      expect(g.native.open).not.toHaveBeenCalled();
      await f.runtime.session(agent, place, "new");
      await f.deliver(root, dispatched());
      await vi.waitFor(() => expect(g.calls).toContain("close 1"));
      expect(f.fake.geese[0]?.opened).toHaveLength(1);
      expect(localSessions(f.storage, self).get(key)?.sessions).toEqual([
        "session-1",
        "session-9",
      ]);
    } finally {
      f.runtime.dispose();
    }
  });

  it.each(["databricks", "databricks_v2"])(
    "compacts a forwarded %s conversation's saved session through the gateway, or refuses",
    async (provider) => {
      const blocked: GatewayRoute = {
        kind: "blocked",
        revision: 3,
        gatewayOrigin: "https://gateway.example",
        reason: "network",
        message: "",
      };
      let route: GatewayRoute = enabled;
      const g = gateway();
      const forwarding = new GatewayForwarding(
        { id: "buzz.goose", revision: "r1" },
        { upstream: "goose", native: "goose" },
        async () => ({ lists: ["", ""], proxied: false }),
        g.native,
        { routeFor: () => route, subscribeRoute: () => () => {} },
      );
      const f = setup({
        forwarding,
        provider,
        reply: "Compaction complete",
      });
      const config = { ...DEFAULT_CONFIG, provider };
      const agent = { ...f.agent, config } as unknown as Agent;
      const place = { channelId: channel, root: root.id };
      try {
        await f.deliver(root, dispatched());
        await vi.waitFor(() => expect(g.calls).toContain("close 1"));
        await f.runtime.session(agent, place, "compact");
        const compacting = f.fake.geese[1];
        expect(compacting?.env.GOOSE_SUBAGENT_PROVIDER).toBe(provider);
        expect(compacting?.loaded).toEqual(["session-1"]);
        expect(compacting?.turns.map((turn) => turn.text)).toEqual([
          "/compact",
        ]);
        // The control's own context: its thread, and never a message.
        expect(g.opens[1]?.inference[headers.thread_id]).toBe(root.id);
        expect(g.opens[1]?.inference).not.toHaveProperty(headers.message_id);
        route = blocked;
        await expect(
          f.runtime.session(agent, place, "compact"),
        ).rejects.toThrow(
          "Couldn't compact through the agent gateway: Buzz couldn't reach the gateway.",
        );
        for (const reason of ["auth", "readiness_pending"] as const) {
          route = { ...blocked, reason, message: `Gateway ${reason}` };
          await expect(
            f.runtime.session(agent, place, "compact"),
          ).rejects.toThrow(route.message);
          expect(f.fake.geese).toHaveLength(2);
          expect(g.opens).toHaveLength(2);
        }
        route = { kind: "external", revision: 4 };
        await expect(
          f.runtime.session(agent, place, "compact"),
        ).rejects.toThrow("which this agent's turns don't use now");
        expect(f.fake.geese).toHaveLength(2);
      } finally {
        f.runtime.dispose();
      }
    },
  );

  it("keeps compacting a forwarded conversation through the gateway once a plugin's list leaves goose out", async () => {
    let route: GatewayRoute = enabled;
    let excluded = false;
    const g = gateway();
    const forwarding = new GatewayForwarding(
      { id: "buzz.goose", revision: "r1" },
      { upstream: "goose", native: "goose" },
      async () => ({ lists: ["", ""], proxied: false }),
      g.native,
      {
        routeFor: () => route,
        subscribeRoute: () => () => {},
        excludes: (harness) => excluded && harness === "goose",
      },
    );
    const f = setup({
      forwarding,
      provider: "databricks",
      reply: "Compaction complete",
    });
    const config = { ...DEFAULT_CONFIG, provider: "databricks" };
    const agent = { ...f.agent, config } as unknown as Agent;
    const place = { channelId: channel, root: root.id };
    try {
      await f.deliver(root, dispatched());
      await vi.waitFor(() => expect(g.calls).toContain("close 1"));
      // The gateway's own list leaving goose out, with no plugin's: as before.
      route = { ...enabled, harnesses: ["codex"] };
      await expect(f.runtime.session(agent, place, "compact")).rejects.toThrow(
        "which this agent's turns don't use now",
      );
      expect(g.opens).toHaveLength(1);
      // A plugin's list leaving it out: the saved session keeps its gateway.
      excluded = true;
      await f.runtime.session(agent, place, "compact");
      const compacting = f.fake.geese[1];
      expect(compacting?.loaded).toEqual(["session-1"]);
      expect(compacting?.turns.map((turn) => turn.text)).toEqual(["/compact"]);
      expect(g.opens).toHaveLength(2);
      expect(g.opens[1]?.inference[headers.launcher_session]).toBe(
        g.opens[0]?.inference[headers.launcher_session],
      );
      // The gateway refusing still fails, as it does for a listed harness.
      route = {
        kind: "blocked",
        revision: 3,
        gatewayOrigin: "https://gateway.example",
        reason: "auth",
        message: "Gateway auth",
      };
      await expect(f.runtime.session(agent, place, "compact")).rejects.toThrow(
        "Gateway auth",
      );
      expect(g.opens).toHaveLength(2);
    } finally {
      f.runtime.dispose();
    }
  });

  it("stops a forwarded turn on interrupt, posting nothing", async () => {
    const g = gateway();
    const f = setup({
      forwarding: g.forwarding,
      provider: "databricks",
      hold: true,
    });
    const agent = { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent;
    const place = { channelId: channel, root: root.id };
    try {
      await f.deliver(root, dispatched());
      await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
      expect(f.runtime.sessionState(agent, place)).toBe("active");
      await f.runtime.session(agent, place, "interrupt");
      await vi.waitFor(() => expect(g.calls).toContain("close 1"));
      expect(f.fake.geese[0]?.killed).toBe(true);
      await vi.waitFor(() =>
        expect(f.runtime.sessionState(agent, place)).toBe("idle"),
      );
      expect(f.published).toEqual([]);
    } finally {
      f.runtime.dispose();
    }
  });

  it("runs a standalone turn on a binding of its own, saving nothing, and the agent retires only once its goose has exited and closed", async () => {
    const g = gateway();
    const f = setup({ forwarding: g.forwarding, hold: true });
    try {
      const turn = f.runtime.runOnce({
        delivery: {
          agent: f.agent,
          channelId: channel,
          config: { ...DEFAULT_CONFIG, provider: "databricks" },
          ...dispatched(),
        },
        key: "Timer",
        signal: new AbortController().signal,
        prompt: async () => "Check in",
      } as unknown as Parameters<GooseRuntime["runOnce"]>[0]);
      await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
      const [goose] = f.fake.geese;
      if (goose) goose.holdExit = true;
      vi.useFakeTimers();
      try {
        goose?.turns[0]?.finish();
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(turn).resolves.toEqual({
          ok: false,
          error: expect.stringContaining("didn't stop"),
        });
      } finally {
        vi.useRealTimers();
      }
      await expect(f.runtime.retire(self)).rejects.toThrow("didn't stop");
      expect(g.calls).not.toContain("close 1");
      goose?.exit(null);
      await vi.waitFor(() => expect(g.calls).toContain("close 1"));
      await f.runtime.retire(self);
      expect(localSessions(f.storage, self).list()).toEqual([]);
      expect(f.runtime.prompts(self).sessions()).toMatchObject([
        { id: "session-1", conversation: null },
      ]);
    } finally {
      f.runtime.dispose();
    }
  });

  /** A standalone forwarded turn of the agent's. */
  const standalone = (
    f: ReturnType<typeof setup>,
    config: Partial<Config> & { preset?: "recommended" } = {},
  ) =>
    f.runtime.runOnce({
      delivery: {
        agent: f.agent,
        channelId: channel,
        config: { ...DEFAULT_CONFIG, provider: "databricks", ...config },
        current: () => true,
        ...dispatched(),
      },
      key: "Timer",
      signal: new AbortController().signal,
      prompt: async () => "Check in",
    } as unknown as Parameters<GooseRuntime["runOnce"]>[0]);

  /** A forwarded standalone turn of an agent whose one-off sessions are
   * recorded in `items`, run to its end. */
  const recorded = async (usage: boolean) => {
    const items = new Map<string, string>();
    const g = gateway();
    const f = setup({
      forwarding: g.forwarding,
      agentStore: localStore({
        get length() {
          return items.size;
        },
        key: (index: number) => [...items.keys()][index] ?? null,
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
        removeItem: (key: string) => void items.delete(key),
        clear: () => items.clear(),
      }),
    });
    f.runtime.usageOn = () => usage;
    try {
      const turn = standalone(f);
      await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
      f.fake.geese[0]?.turns[0]?.finish();
      f.fake.geese[0]?.exit(null);
      await turn;
      const kept = [...items.keys()]
        .filter((key) => key.startsWith(STANDALONE_PREFIX))
        .flatMap((key) => JSON.parse(items.get(key) ?? "").sessions);
      const session = {
        id: "session-1",
        revision: "r",
        gaps: [],
        startedAt: 1,
        lastAt: 2,
        observations: [],
      };
      return { kept, wakes: await f.runtime.withWakes(self, [session]) };
    } finally {
      f.runtime.dispose();
    }
  };

  it("tells which timer a forwarded standalone session was started for", async () => {
    const { kept, wakes } = await recorded(true);
    expect(kept).toEqual([["session-1", expect.any(Number), "Timer"]]);
    expect(wakes).toMatchObject([{ id: "session-1", wake: "Timer" }]);
  });

  it("records a forwarded standalone session but not its timer while Usage is off", async () => {
    const { kept, wakes } = await recorded(false);
    expect(kept).toEqual([["session-1", expect.any(Number)]]);
    expect(wakes[0]).not.toHaveProperty("wake");
  });

  it("refuses a forwarded standalone wake in community scope before starting Goose", async () => {
    const g = gateway();
    const f = setup({ forwarding: g.forwarding });
    try {
      await expect(
        standalone(f, { scope: "community" }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining(
          "Goose cannot use the agent gateway with Community session scope",
        ),
      });
      expect(g.opens).toEqual([]);
      expect(f.fake.geese).toEqual([]);
    } finally {
      f.runtime.dispose();
    }
  });

  it("uses the Automatic provider on the first standalone forwarded turn", async () => {
    const provider = "databricks_v2";
    const model = "catalog.schema.model";
    const g = gateway();
    vi.stubEnv(
      "VITE_BUZZ_RECOMMENDED_AGENT",
      JSON.stringify([
        { harness: "goose", provider, model, effort: "high", label: "Model" },
      ]),
    );
    const f = setup({
      forwarding: g.forwarding,
      recommended: recommendedRun("goose", async () => true),
    });
    try {
      await expect(
        standalone(f, { preset: "recommended", provider: "" }),
      ).resolves.toMatchObject({ ok: true });
      expect(g.opens).toHaveLength(1);
      expect(f.fake.geese[0]?.env.GOOSE_SUBAGENT_PROVIDER).toBe(provider);
      expect(f.fake.geese[0]?.configured).toContain(`session-1 model=${model}`);
    } finally {
      f.runtime.dispose();
      vi.unstubAllEnvs();
    }
  });
  /** A spawn whose goose comes up only once released. */
  const late = () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const wrap =
      (spawn: ReturnType<typeof fakeSpawn>["spawn"]): Host["spawn"] =>
      async (id, options) => {
        if (id === "goose") await released;
        return spawn(id, options);
      };
    return { wrap, release };
  };

  it("ends a standalone turn still starting when the agent retires, and waits for its goose to exit and close", async () => {
    const g = gateway();
    const gate = late();
    const f = setup({ forwarding: g.forwarding, wrap: gate.wrap });
    const turn = standalone(f);
    await vi.waitFor(() => expect(g.opens).toHaveLength(1));
    let retired = false;
    const retiring = f.runtime.retire(self).then(() => (retired = true));
    await flush(30);
    expect(retired).toBe(false);
    gate.release();
    await retiring;
    expect(f.fake.geese[0]?.killed).toBe(true);
    expect(f.fake.geese[0]?.opened).toEqual([]);
    expect(g.calls).toEqual(["seal 1", "close 1"]);
    await expect(turn).resolves.toEqual({ ok: true, undelivered: true });
  });

  it("ends a standalone turn's prompt when the agent retires, and waits for its goose to exit and close", async () => {
    const g = gateway();
    const f = setup({ forwarding: g.forwarding, hold: true });
    const turn = standalone(f);
    await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
    await f.runtime.retire(self);
    expect(f.fake.geese[0]?.cancelled).toContain("session-1");
    expect(f.fake.geese[0]?.killed).toBe(true);
    expect(g.calls).toContain("close 1");
    await expect(turn).resolves.toEqual({ ok: true, stopped: true });
  });

  it("stops a goose that comes up after the runtime was disposed", async () => {
    const g = gateway();
    const gate = late();
    const f = setup({ forwarding: g.forwarding, wrap: gate.wrap });
    const turn = standalone(f);
    await vi.waitFor(() => expect(g.opens).toHaveLength(1));
    f.runtime.dispose();
    gate.release();
    await expect(turn).resolves.toEqual({ ok: true, undelivered: true });
    expect(f.fake.geese[0]?.killed).toBe(true);
    expect(f.fake.geese[0]?.opened).toEqual([]);
    expect(g.calls).toEqual(["seal 1", "close 1"]);
  });

  it("refuses to retire an agent until a conversation's goose that did not stop has exited and closed", async () => {
    const g = gateway();
    const f = setup({
      forwarding: g.forwarding,
      provider: "databricks",
      hold: true,
    });
    await f.deliver(root, dispatched());
    await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
    const [goose] = f.fake.geese;
    if (goose) goose.holdExit = true;
    vi.useFakeTimers();
    try {
      goose?.turns[0]?.finish();
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(f.published).toHaveLength(1));
    expect(f.published[0]?.content).toContain("didn't stop");
    // Refused, never forgotten as clean: the entry and its barrier stay.
    await expect(f.runtime.retire(self)).rejects.toThrow("didn't stop");
    expect(g.calls).not.toContain("close 1");
    goose?.exit(null);
    await vi.waitFor(() => expect(g.calls).toContain("close 1"));
    await f.runtime.retire(self);
    expect(g.calls).toEqual(["associate 1 session-1", "seal 1", "close 1"]);
  });

  it("keeps failing to retire an agent whose conversation's generation native could not close, without blocking the conversation", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = gateway(enabled, new Error("close refused"));
    const again = message("2", "Again", {
      tags: [
        ["h", channel],
        ["e", root.id, "", "reply"],
      ],
    });
    const f = setup({
      forwarding: g.forwarding,
      provider: "databricks",
      thread: [root, again],
    });
    await f.deliver(root, dispatched());
    await vi.waitFor(() => expect(f.published).toHaveLength(1));
    expect(f.published[0]?.content).toContain("couldn't confirm");
    // Its goose exited, so the conversation's next message still runs,
    // resuming its session.
    await f.deliver(again, dispatched());
    await vi.waitFor(() => expect(g.calls).toContain("close 2"));
    expect(f.fake.geese[1]?.loaded).toEqual(["session-1"]);
    expect(f.fake.geese[1]?.turns).toHaveLength(1);
    await expect(f.runtime.retire(self)).rejects.toThrow("close refused");
    // Never forgotten as clean: a later retirement fails the same way.
    await expect(f.runtime.retire(self)).rejects.toThrow("close refused");
    warned.mockRestore();
  });

  it("shows a resumed turn only what its saved session has not been shown", async () => {
    const g = gateway();
    const reply = (id: string, content: string) =>
      message(id, content, {
        tags: [
          ["h", channel],
          ["e", root.id, "", "reply"],
        ],
      });
    const aside = reply("2", "An aside");
    const again = reply("3", "Again");
    const f = setup({
      forwarding: g.forwarding,
      provider: "databricks",
      thread: [root, aside, again, reply("4", "Once more")],
    });
    try {
      await f.deliver(root, dispatched());
      await vi.waitFor(() => expect(g.calls).toContain("close 1"));
      await f.deliver(again, dispatched());
      await vi.waitFor(() => expect(g.calls).toContain("close 2"));
      expect(f.fake.geese[1]?.turns[0]?.text).toContain("An aside");
      await f.deliver(reply("4", "Once more"), dispatched());
      await vi.waitFor(() => expect(g.calls).toContain("close 3"));
      const third = f.fake.geese[2]?.turns[0]?.text ?? "";
      expect(promptMessage(promptSections(third)).text).toBe("Once more");
      expect(third).not.toContain("An aside");
      expect(third).not.toContain("Again");
    } finally {
      f.runtime.dispose();
    }
  });

  it("holds a server in the shared pool for a forwarded turn's Buzz tools until it closes", async () => {
    const g = gateway();
    const f = setup({ forwarding: g.forwarding, hold: true });
    const before = SHARED_POOL.size;
    const turn = standalone(f);
    await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
    expect(SHARED_POOL.size).toBe(before + 1);
    f.fake.geese[0]?.turns[0]?.finish();
    await turn;
    await vi.waitFor(() => expect(SHARED_POOL.size).toBe(before));
    f.runtime.dispose();
  });

  it("gives up a forwarded message still waiting for its conversation at its deadline", async () => {
    const g = gateway();
    const f = setup({ forwarding: g.forwarding, provider: "databricks" });
    try {
      // The agent's entry, from a first turn elsewhere.
      await f.deliver(message("9", "Elsewhere"), dispatched());
      await vi.waitFor(() => expect(g.calls).toContain("close 1"));
      const { agents } = f.runtime as unknown as {
        agents: Map<string, { sessions: AgentSessions }>;
      };
      let release!: () => void;
      const holding = agents
        .get(self)
        ?.sessions.exclusive(
          key,
          () => new Promise<void>((resolve) => (release = resolve)),
        );
      await flush(10);
      const handover = new AbortController();
      await f.deliver(root, { ...dispatched(), signal: handover.signal });
      await flush(10);
      handover.abort(new Error("Handover expired"));
      await flush(10);
      release();
      await holding;
      await flush(30);
      expect(g.opens).toHaveLength(1);
      expect(f.fake.geese).toHaveLength(1);
      // As an ordinary message that waited too long says.
      expect(f.published).toHaveLength(1);
      expect(f.published[0]?.content).toContain("goose did not start in time");
    } finally {
      f.runtime.dispose();
    }
  });

  it("acknowledges a forwarded message once goose has taken it", async () => {
    const g = gateway();
    const f = setup({ forwarding: g.forwarding, provider: "databricks" });
    try {
      const acknowledged = vi.fn();
      await f.deliver(root, {
        ...dispatched(),
        step: vi.fn(),
        acknowledged,
      } as Partial<Delivery>);
      await vi.waitFor(() => expect(g.calls).toContain("close 1"));
      expect(acknowledged).toHaveBeenCalledTimes(1);
    } finally {
      f.runtime.dispose();
    }
  });
});

it("runs an agent on Recommended on the current candidate", () => {
  // A synthetic candidate.
  const candidate = {
    harness: "goose",
    provider: "databricks",
    model: "goose-model-b",
    effort: "high",
    label: "Model B",
  };
  const saved = { ...DEFAULT_CONFIG, preset: "recommended" };
  expect(running(saved, candidate)).toMatchObject({
    provider: "databricks",
    model: "goose-model-b",
    effort: "high",
  });
  // With none offered it runs on goose's own default.
  expect(running(saved, null)).toEqual(saved);
  expect(running(DEFAULT_CONFIG, candidate)).toEqual(DEFAULT_CONFIG);
});

it.each([
  ["mention", false],
  ["mention", true],
  ["attention", false],
  ["plugin", false],
] as const)(
  "steers one community session across source channels with %s (scope changed: %s)",
  async (type, changed) => {
    const f = setup({
      hold: true,
      scope: "community",
      solo: new Set([channel]),
      canvas: "SOURCE_CANVAS",
    });

    const conversationInstructions = vi.fn((source: string, root?: string) =>
      source === channel && !root
        ? { plugin: "acme.tasks", text: "SOURCE_ONLY" }
        : undefined,
    );
    Object.assign(f.agent, { conversationInstructions });
    const listed = f.session.channels.list();
    const firstChannel = listed.channels[0];
    if (!firstChannel) throw new Error("Expected the source channel");
    vi.spyOn(f.session.channels, "list").mockImplementation(() => ({
      ...listed,
      status: "ready",
      channels: [
        ...listed.channels,
        { ...firstChannel, id: "other", channelType: "stream" },
      ],
    }));
    try {
      await f.deliver(message("1", "first"));
      await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
      const process = f.goose();
      if (!process) throw new Error("No Goose process");
      const second = message("2", "second", {
        tags: [
          ["h", "other"],
          ["p", self],
        ],
      });
      if (type === "mention") await f.deliver(second, { channelId: "other" });
      else
        await f.run(
          {
            ...pluginWake(second.id),
            ...(type === "attention" ? { type } : { type, plugin: "github" }),
            channel: "other",
            text: "second",
          },
          { channelId: "other" },
        );
      await vi.waitFor(() => expect(process.turns[0]?.steered).toHaveLength(1));
      if (changed)
        f.runtime.sync([
          {
            ...f.agent,
            config: {
              ...DEFAULT_CONFIG,
              scope: "thread",
            },
          } as unknown as Agent,
        ]);
      expect(process.turns).toHaveLength(1);
      const steered = process.turns[0]?.steered[0];
      expect(steered).toContain("Session scope: community");
      expect(steered).toContain("other");
      expect(process.turns[0]?.text).toContain("SOURCE_ONLY");
      expect(process.turns[0]?.text).toContain("SOURCE_CANVAS");
      expect(steered).toContain("Disregard any earlier workspace Canvas");
      expect(steered).toContain("Disregard any earlier <owner-instructions>");
      expect(conversationInstructions).toHaveBeenCalledWith(channel, undefined);
      process.turns[0]?.finish();
    } finally {
      f.runtime.dispose();
    }
  },
);

it("interrupts an executing community wake when its deadline expires", async () => {
  const f = setup({ hold: true, scope: "community" });
  const abort = new AbortController();
  const done = f.runtime.runOnce({
    delivery: {
      agent: f.agent,
      config: { ...DEFAULT_CONFIG, scope: "community" },
      current: () => true,
    },
    key: "deadline",
    signal: abort.signal,
    prompt: async () => "check",
  } as unknown as Parameters<GooseRuntime["runOnce"]>[0]);
  void done.catch(() => {});
  try {
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    abort.abort(new Error("deadline"));
    await vi.waitFor(() => expect(f.goose()?.cancelled).toHaveLength(1));
  } finally {
    f.goose()?.turns[0]?.finish();
    await done.catch(() => {});
    f.runtime.dispose();
  }
});

it("stops only the queued community request selected by the user", async () => {
  const f = setup({ hold: true, scope: "community" });
  const interruptible = vi.fn();
  const workingUntil = vi.fn<Delivery["workingUntil"]>();
  const queuedPublish = vi.fn((...args: Parameters<typeof f.agent.publish>) =>
    f.agent.publish(...args),
  );
  try {
    await f.deliver(message("1", "first"), { workingUntil });
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const worker = f.goose();
    if (!worker) throw new Error("No Goose process");
    await f.deliver(message("2", "queued"), {
      effort: "high",
      interruptible,
      workingUntil,
      agent: {
        ...f.agent,
        publish: queuedPublish,
      } as unknown as Delivery["agent"],
    });
    const before = worker.received.filter(
      (i) => i.method === "session/cancel",
    ).length;
    await interruptible.mock.calls[0]?.[0]();
    expect(
      worker.received.filter((i) => i.method === "session/cancel"),
    ).toHaveLength(before);
    const sessionId = worker.turns[0]?.sessionId;
    if (!sessionId) throw new Error("missing session");
    await worker.mcp(sessionId, "tools/call", {
      name: "send",
      arguments: { text: "active reply", audience: "everyone" },
    });
    expect(queuedPublish).not.toHaveBeenCalled();
    expect(f.agent.publish).toHaveBeenCalled();
    worker.turns[0]?.finish();
    await Promise.all(workingUntil.mock.calls.map(([done]) => done));
    expect(worker.turns).toHaveLength(1);
  } finally {
    f.runtime.dispose();
  }
});

it("keeps tool defaults with the running community turn when a follow-up from another channel is dropped", async () => {
  const f = setup({ hold: true, scope: "community" });
  const listed = f.session.channels.list();
  const first = listed.channels[0];
  if (!first) throw new Error("missing channel");
  vi.spyOn(f.session.channels, "list").mockReturnValue({
    ...listed,
    channels: [...listed.channels, { ...first, id: "other" }],
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshing!: () => void;
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
  let live = true;
  try {
    await f.deliver(message("1", "first"));
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const worker = f.goose();
    const sessionId = worker?.turns[0]?.sessionId;
    if (!worker || !sessionId) throw new Error("No Goose turn");
    await f.run(
      { ...pluginWake("a".repeat(64)), channel: "other" },
      {
        config: { ...DEFAULT_CONFIG, scope: "community" },
        channelId: "other",
        wakeText,
        current: () => live,
      },
    );
    // The wake is withdrawn while its prompt is built again for delivery.
    await started;
    live = false;
    release();
    await flush(10);
    await worker.mcp(sessionId, "tools/call", {
      name: "send",
      arguments: { text: "Still here", audience: "everyone" },
    });
    expect(
      f.published.find((event) => event.content === "Still here")?.tags,
    ).toContainEqual(["h", channel]);
  } finally {
    release();
    f.goose()?.turns[0]?.finish();
    f.runtime.dispose();
  }
});

it("keeps the active Solo Canvas when a speculative community request is stopped", async () => {
  const f = setup({
    scope: "community",
    hold: true,
    solo: new Set([channel]),
    canvas: "SOURCE_CANVAS",
  });
  const workingUntil = vi.fn<Delivery["workingUntil"]>();
  const interruptible = vi.fn();
  const listed = f.session.channels.list();
  const first = listed.channels[0];
  if (!first) throw new Error("missing channel");
  vi.spyOn(f.session.channels, "list").mockReturnValue({
    ...listed,
    channels: [
      ...listed.channels,
      { ...first, id: "other", channelType: "stream" },
    ],
  });
  try {
    await f.deliver(message("1", "first"), { workingUntil });
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const worker = f.goose();
    if (!worker) throw new Error("missing worker");
    await f.deliver(
      message("2", "cancelled", {
        tags: [
          ["h", "other"],
          ["p", self],
        ],
      }),
      { channelId: "other", interruptible, workingUntil },
    );
    await interruptible.mock.calls[0]?.[0]();
    worker.turns[0]?.finish();
    await Promise.all(workingUntil.mock.calls.map(([done]) => done));
    f.session.canvas.read.mockRejectedValue(new Error("offline"));
    await f.deliver(message("3", "same Solo"), { workingUntil });
    await vi.waitFor(() => expect(worker.turns).toHaveLength(2));
    expect(worker.turns[1]?.text).toContain("SOURCE_CANVAS");
    worker.turns[1]?.finish();
  } finally {
    f.runtime.dispose();
  }
});

it("retains a community wake deadline after final publication until native idle", async () => {
  const f = setup({ hold: true, scope: "community" });
  f.agent.query.mockResolvedValue([message("1", "origin")]);
  const abort = new AbortController();
  const settled = vi.fn();
  const done = f.runtime
    .runOnce({
      delivery: {
        agent: f.agent,
        config: { ...DEFAULT_CONFIG, scope: "community" },
        current: () => true,
      },
      key: "deadline",
      signal: abort.signal,
      prompt: async () => "check",
    } as unknown as Parameters<GooseRuntime["runOnce"]>[0])
    .then(settled);
  void done.catch(() => {});
  try {
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const process = f.goose();
    if (!process) throw new Error("missing process");
    const reply = await process.mcp(
      process.turns[0]?.sessionId ?? "",
      "tools/call",
      {
        name: "send",
        arguments: {
          channel,
          reply: "1".repeat(64),
          text: "Done",
          audience: "everyone",
          final: true,
        },
        _meta: { "agent-tool-call-request-id": "wake-final" },
      },
    );
    expect(reply.result).not.toMatchObject({ isError: true });
    await vi.waitFor(() =>
      expect(f.published.some((event) => event.kind === 9)).toBe(true),
    );
    expect(settled).not.toHaveBeenCalled();
    process.silent.add("session/cancel");
    abort.abort(new Error("deadline"));
    await vi.waitFor(() =>
      expect(
        process.received.some((wire) => wire.method === "session/cancel"),
      ).toBe(true),
    );
    await done;
    expect(settled).toHaveBeenCalledWith({ ok: true });
    const workingUntil = vi.fn<Delivery["workingUntil"]>();
    await f.deliver(message("2", "after completed wake"), { workingUntil });
    await flush(10);
    expect(process.turns).toHaveLength(1);
    process.turns[0]?.finish();
    await vi.waitFor(() => expect(process.turns).toHaveLength(2));
    process.turns[1]?.finish();
    await Promise.all(workingUntil.mock.calls.map(([work]) => work));
  } finally {
    f.goose()?.turns[0]?.finish();
    await done.catch(() => {});
    f.runtime.dispose();
  }
});

it("retains the Solo Canvas when a stopped admitted source finishes preparation", async () => {
  const f = setup({
    scope: "community",
    solo: new Set([channel, "other"]),
    canvas: "RETAINED_CANVAS",
  });
  const workingUntil = vi.fn<Delivery["workingUntil"]>();
  const interruptible = vi.fn();

  const listed = f.session.channels.list();
  const firstChannel = listed.channels[0];
  if (!firstChannel) throw new Error("missing channel");
  vi.spyOn(f.session.channels, "list").mockReturnValue({
    ...listed,
    channels: [
      ...listed.channels,
      { ...firstChannel, id: "other", channelType: "solo" },
    ],
  });

  let release!: () => void;
  try {
    await f.deliver(message("1", "first"), { workingUntil });
    await Promise.all(workingUntil.mock.calls.map(([done]) => done));
    const read = f.session.canvas.read.getMockImplementation();
    if (!read) throw new Error("Missing Canvas reader");
    let reads = 0;
    const started = vi.fn();
    f.session.canvas.read.mockImplementation((...args) => {
      if (++reads === 1)
        return new Promise((resolve) => {
          started();
          release = () => resolve(null);
        });
      return read(...args);
    });
    const pending = f.deliver(
      message("2", "cancel", {
        tags: [
          ["h", "other"],
          ["p", self],
        ],
      }),
      { channelId: "other", interruptible, workingUntil },
    );
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    await interruptible.mock.calls[0]?.[0]();
    release();
    await pending;
    await Promise.all(workingUntil.mock.calls.map(([done]) => done));
    f.session.canvas.read.mockRejectedValue(new Error("offline"));
    await f.deliver(message("3", "same Solo"), { workingUntil });
    await Promise.all(workingUntil.mock.calls.map(([done]) => done));
    expect(f.goose()?.turns.at(-1)?.text).toContain("RETAINED_CANVAS");
  } finally {
    release?.();
    f.runtime.dispose();
  }
});

it("keeps addressed community admission ahead of a later wake during compaction", async () => {
  const f = setup({
    hold: true,
    scope: "community",
    reply: "Compaction complete",
  });
  const config = { ...DEFAULT_CONFIG, scope: "community" as const };
  const agent = { ...f.agent, config } as unknown as Agent;
  let wake: Promise<unknown> | undefined;
  try {
    await f.deliver(message("1", "first"));
    await vi.waitFor(() => expect(!!f.goose()?.turns.length).toBe(true));
    const worker = f.goose();
    if (!worker) throw new Error("missing worker");
    worker.turns[0]?.finish();
    await vi.waitFor(() =>
      expect(f.runtime.sessionState(agent, { channelId: channel })).toBe(
        "idle",
      ),
    );
    const compacted = f.runtime.session(
      agent,
      { channelId: channel },
      "compact",
    );
    await vi.waitFor(() => expect(worker.turns[1]?.text).toBe("/compact"));
    await f.deliver(message("2", "ADDRESSED_BEFORE_WAKE"));
    vi.useFakeTimers();
    wake = f.runtime
      .runOnce({
        delivery: {
          agent: f.agent as unknown as Delivery["agent"],
          config,
          current: () => true,
        },
        key: "later-wake",
        signal: new AbortController().signal,
        prompt: async () => "WAKE_AFTER_ADDRESSED",
      } as unknown as Parameters<typeof f.runtime.runOnce>[0])
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    worker.turns[1]?.finish();
    await compacted;
    await vi.waitFor(() => expect(worker.turns.length).toBe(3));
    expect(worker.turns[2]?.text).toContain("ADDRESSED_BEFORE_WAKE");
    worker.turns[2]?.finish();
    await vi.waitFor(() => expect(worker.turns.length).toBe(4));
    expect(worker.turns[3]?.text).toContain("WAKE_AFTER_ADDRESSED");
    worker.turns[3]?.finish();
    await wake;
  } finally {
    vi.useRealTimers();
    f.runtime.dispose();
    await wake;
  }
});

it("prepares an idle community wake only for handoff and native refresh", async () => {
  const f = setup({ hold: true, scope: "community" });
  const wakeText = vi.fn(async () => "CURRENT_INTEREST");
  try {
    const workingUntil = vi.fn<Delivery["workingUntil"]>();
    await f.deliver(message("1", "first"), { workingUntil });
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    f.goose()?.turns[0]?.finish();
    await workingUntil.mock.calls.at(-1)?.[0];
    await f.run({ ...pluginWake(), topLevel: true }, {
      wakeText,
    } as unknown as Partial<Delivery>);
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(2));
    expect(f.goose()?.turns[1]?.text).toContain("CURRENT_INTEREST");
    expect(wakeText).toHaveBeenCalledTimes(2);
    f.goose()?.turns[1]?.finish();
  } finally {
    f.runtime.dispose();
  }
});

it("reserves community work before source preparation", async () => {
  const f = setup({ scope: "community" });
  const config = { ...DEFAULT_CONFIG, scope: "community" as const };
  let release!: () => void;
  let mark!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    mark = resolve;
  });
  const original = (
    f.runtime as unknown as { follow(raw: unknown): Promise<void> }
  ).follow;
  let held = false;
  Object.assign(f.runtime, {
    follow: async (raw: unknown) => {
      if (!held) {
        held = true;
        mark();
        await gate;
      }
      return original.call(f.runtime, raw);
    },
  });
  let wake: Promise<unknown> | undefined;
  const turn = f.deliver(message("1", "ADDRESSED_BEFORE_SOURCE_WAKE"));
  try {
    await entered;
    wake = f.runtime.runOnce({
      delivery: { agent: f.agent, config, current: () => true },
      key: "source",
      signal: new AbortController().signal,
      prompt: async () => "WAKE_AFTER_SOURCE",
    } as unknown as Parameters<typeof f.runtime.runOnce>[0]);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    release();
    await turn;
    await wake;
    await vi.waitFor(() => expect(f.goose()?.turns.length).toBe(2));
    expect(f.goose()?.turns[0]?.text).toContain("ADDRESSED_BEFORE_SOURCE_WAKE");
    expect(f.goose()?.turns[1]?.text).toContain("WAKE_AFTER_SOURCE");
  } finally {
    vi.useRealTimers();
    release();
    f.runtime.dispose();
    await Promise.allSettled([turn, wake]);
  }
});

it("keeps deferred community admission in its captured session scope after settings change", async () => {
  const f = setup({ scope: "community" });
  let release!: () => void;
  let mark!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    mark = resolve;
  });
  const runtime = f.runtime as unknown as {
    turn(...args: unknown[]): Promise<{ key: string }>;
  };
  const original = runtime.turn;
  const keys: string[] = [];
  let held = false;
  vi.spyOn(runtime, "turn").mockImplementation(async (...args) => {
    if (!held) {
      held = true;
      mark();
      await gate;
    }
    const result = await original.apply(f.runtime, args);
    keys.push(result.key);
    return result;
  });
  const first = f.deliver(message("1", "FIRST_SCOPE"));
  let second: ReturnType<typeof f.deliver> | undefined;
  try {
    await entered;
    second = f.deliver(message("2", "DEFERRED_SCOPE"));
    await second;
    f.runtime.sync([
      {
        ...f.agent,
        config: { ...DEFAULT_CONFIG, scope: "thread" },
      } as unknown as Agent,
    ]);
    release();
    await first;
    await vi.waitFor(() => expect(keys.length).toBeGreaterThanOrEqual(2));
    expect(keys.every((key) => key === "@community")).toBe(true);
  } finally {
    release();
    f.runtime.dispose();
    await Promise.allSettled([first, second]);
  }
});

it.each(["community", "thread"] as const)(
  "uses the admitted %s scope for a standalone wake despite newer settings",
  async (scope) => {
    const f = setup();
    const config = { ...DEFAULT_CONFIG, scope };
    const newer = {
      ...DEFAULT_CONFIG,
      scope: scope === "community" ? "thread" : "community",
    };
    (
      f.runtime as unknown as {
        entry(agent: unknown, config: unknown): unknown;
      }
    ).entry(f.agent.key, newer);
    try {
      await expect(
        f.runtime.runOnce({
          delivery: { agent: f.agent, config, current: () => true },
          key: "captured-scope",
          signal: new AbortController().signal,
          prompt: async () => "CAPTURED_STANDALONE_SCOPE",
        } as unknown as Parameters<typeof f.runtime.runOnce>[0]),
      ).resolves.toMatchObject({ ok: true });
      const text = f.goose()?.turns[0]?.text ?? "";
      expect(text.includes("Session scope: community")).toBe(
        scope === "community",
      );
    } finally {
      f.runtime.dispose();
    }
  },
);

it.each(["mention", "attention", "thread", "channel"] as const)(
  "keeps active community ownership and unsuccessful queued %s completion after scope sync and Stop",
  async (kind) => {
    const f = setup({ hold: true, scope: "community" });
    const config = { ...DEFAULT_CONFIG, scope: "community" as const };
    const queuedPublish = vi.fn((...args: Parameters<typeof f.agent.publish>) =>
      f.agent.publish(...args),
    );
    const agent = {
      ...f.agent,
      publish: queuedPublish,
    } as unknown as Delivery["agent"];
    const held: PromiseLike<unknown>[] = [];
    const workingUntil: Delivery["workingUntil"] = (done) => held.push(done);
    const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
    await f.deliver(message("1", "held first"));
    await vi.waitFor(() => expect(f.goose()).toBeDefined());
    const worker = f.goose();
    if (!worker) throw new Error("Missing active native worker");
    try {
      f.runtime.sync([
        {
          ...f.agent,
          config: {
            ...config,
            scope: kind === "channel" ? "channel" : "thread",
          },
        } as unknown as Agent,
      ]);
      await f.runtime.run({
        trigger:
          kind !== "attention"
            ? { type: "mention", event: message("2", "queued second") }
            : {
                type: "attention",
                channel,
                root: message("2", "").id,
                id: "f".repeat(64),
                at: 200_000,
                text: "queued second",
              },
        channelId: channel,
        signal: new AbortController().signal,
        config:
          kind === "thread" || kind === "channel"
            ? { ...config, scope: kind }
            : config,
        agent,
        interruptible,
        workingUntil,
      } as unknown as Delivery);
      await interruptible.mock.calls[0]?.[0]();
      await worker.mcp(worker.turns[0]?.sessionId ?? "", "tools/call", {
        name: "send",
        arguments: { text: "active owner reply", audience: "everyone" },
      });
      expect(queuedPublish).not.toHaveBeenCalled();
      expect(f.agent.publish).toHaveBeenCalled();
      worker.turns[0]?.finish();
      const results = await Promise.all(held);
      if (kind === "mention" || kind === "attention")
        expect(results).toContainEqual(expect.objectContaining({ ok: false }));
      expect(worker.turns).toHaveLength(1);
    } finally {
      worker?.turns[0]?.finish();
      f.runtime.dispose();
    }
  },
);

it.each(["thread", "channel"] as const)(
  "preserves active community publication ownership when a promptless %s wake starts",
  async (scope) => {
    const f = setup({ hold: true, scope: "community" });
    await f.deliver(message("1", "active community"));
    await vi.waitFor(() => expect(f.goose()).toBeDefined());
    const worker = f.goose();
    if (!worker) throw new Error("Missing active native worker");
    try {
      let reached!: () => void;
      const entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const runtime = f.runtime as unknown as {
        entry(...args: unknown[]): unknown;
      };
      const original = runtime.entry.bind(runtime);
      vi.spyOn(runtime, "entry").mockImplementation((...args) => {
        const entry = original(...args);
        reached();
        return entry;
      });
      const prompt = vi.fn(async () => undefined);
      const wakePublish = vi.fn((...args: Parameters<typeof f.agent.publish>) =>
        f.agent.publish(...args),
      );
      const wake = f.runtime.runOnce({
        delivery: {
          agent: { ...f.agent, publish: wakePublish },
          config: { ...DEFAULT_CONFIG, scope },
          current: () => true,
        },
        key: "independent-wake",
        signal: new AbortController().signal,
        prompt,
      } as unknown as Parameters<typeof f.runtime.runOnce>[0]);
      await entered;
      await worker.mcp(worker.turns[0]?.sessionId ?? "", "tools/call", {
        name: "send",
        arguments: { text: "active reply", audience: "everyone" },
      });
      expect(wakePublish).not.toHaveBeenCalled();
      expect(f.agent.publish).toHaveBeenCalled();
      worker.turns[0]?.finish();
      await expect(wake).resolves.toMatchObject({ ok: true });
      expect(prompt).toHaveBeenCalledOnce();
    } finally {
      worker.turns[0]?.finish();
      f.runtime.dispose();
    }
  },
);

it.each(["thread", "channel"] as const)(
  "drains an active %s standalone wake before community ownership changes",
  async (scope) => {
    const f = setup({ hold: true });
    const wake = f.runtime.runOnce({
      delivery: {
        agent: f.agent,
        config: { ...DEFAULT_CONFIG, scope },
        current: () => true,
      },
      key: "old-scope-wake",
      signal: new AbortController().signal,
      prompt: async () => "held standalone wake",
    } as unknown as Parameters<typeof f.runtime.runOnce>[0]);
    await vi.waitFor(() => expect(f.goose()).toBeDefined());
    const worker = f.goose();
    if (!worker) throw new Error("Missing standalone native worker");
    const queuedPublish = vi.fn((...args: Parameters<typeof f.agent.publish>) =>
      f.agent.publish(...args),
    );
    const config = { ...DEFAULT_CONFIG, scope: "community" as const };
    try {
      f.runtime.sync([{ ...f.agent, config } as unknown as Agent]);
      await f.deliver(message("2", "community second"), {
        config,
        agent: {
          ...f.agent,
          publish: queuedPublish,
        } as unknown as Delivery["agent"],
      });
      await worker.mcp(worker.turns[0]?.sessionId ?? "", "tools/call", {
        name: "send",
        arguments: {
          text: "standalone owner output",
          channel,
          audience: "everyone",
        },
      });
      expect(queuedPublish).not.toHaveBeenCalled();
      expect(f.agent.publish).toHaveBeenCalled();
      worker.turns[0]?.finish();
      await expect(wake).resolves.toMatchObject({ ok: true });
      await vi.waitFor(() => expect(worker.turns).toHaveLength(2));
    } finally {
      for (const turn of worker.turns) turn.finish();
      f.runtime.dispose();
      await wake.catch(() => {});
    }
  },
);

it.each(["effort admission", "native prompt rejection", "rejected wake"])(
  "retains the Solo Canvas after %s",
  async (failure) => {
    const f = setup({
      scope: "community",
      solo: new Set([channel]),
      canvas: "RETAINED_CANVAS",
    });
    const listed = f.session.channels.list();
    const first = listed.channels[0];
    if (!first) throw new Error("missing channel");
    vi.spyOn(f.session.channels, "list").mockReturnValue({
      ...listed,
      channels: [
        ...listed.channels,
        { ...first, id: "other", channelType: "stream" },
      ],
    });
    const workingUntil = vi.fn<Delivery["workingUntil"]>();
    try {
      await f.deliver(message("1", "first"), { workingUntil });
      await Promise.all(workingUntil.mock.calls.map(([done]) => done));
      if (failure !== "effort admission") {
        const worker = f.fake.geese.find((process) => process.turns.length);
        if (!worker) throw new Error("missing worker");
        worker.rejectPrompt = true;
      }
      if (failure === "rejected wake") {
        await expect(
          f.runtime.runOnce({
            delivery: {
              agent: f.agent,
              config: { ...DEFAULT_CONFIG, scope: "community" },
              current: () => true,
            },
            key: "rejected",
            signal: new AbortController().signal,
            prompt: async () => "check",
          } as unknown as Parameters<GooseRuntime["runOnce"]>[0]),
        ).resolves.toMatchObject({ ok: false });
      } else {
        await f.deliver(
          message("2", "refused", {
            tags: [
              ["h", "other"],
              ["p", self],
            ],
          }),
          {
            channelId: "other",
            ...(failure === "effort admission"
              ? { synced: { effort: "high" } }
              : {}),
            workingUntil,
          },
        );
        await Promise.all(workingUntil.mock.calls.map(([done]) => done));
      }
      expect(f.fake.geese.flatMap((p) => p.turns)).toHaveLength(1);
      f.session.canvas.read.mockRejectedValue(new Error("offline"));
      await f.deliver(message("3", "back"), { workingUntil });
      await Promise.all(workingUntil.mock.calls.map(([done]) => done));
      expect(f.fake.geese.flatMap((p) => p.turns).at(-1)?.text).toContain(
        "RETAINED_CANVAS",
      );
    } finally {
      f.runtime.dispose();
    }
  },
);

it.each(["updated", "cleared"])(
  "retains a %s Solo Canvas after stopping its native turn",
  async (change) => {
    const f = setup({
      scope: "community",
      hold: true,
      solo: new Set([channel]),
      canvas: "PREVIOUS_CANVAS",
    });
    const config = { ...DEFAULT_CONFIG, scope: "community" as const };
    const agent = { ...f.agent, config } as unknown as Agent;
    try {
      await f.deliver(message("1", "first"));
      await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
      const worker = f.goose();
      if (!worker) throw new Error("missing Goose");
      worker.turns[0]?.finish();
      const head = await f.session.canvas.read();
      if (!head) throw new Error("missing Canvas");
      f.session.canvas.read.mockResolvedValue(
        change === "cleared"
          ? null
          : {
              ...head,
              created_at: 2,
              content: "UPDATED_CANVAS",
            },
      );
      await f.deliver(message("2", "refresh Canvas"));
      await vi.waitFor(() => expect(worker.turns).toHaveLength(2));
      await f.runtime.session(agent, { channelId: channel }, "interrupt");
      expect(worker.cancelled).toHaveLength(1);
      f.session.canvas.read.mockRejectedValue(new Error("offline"));
      await f.deliver(message("3", "after Stop"));
      await vi.waitFor(() => expect(worker.turns).toHaveLength(3));
      const text = worker.turns[2]?.text;
      expect(text).not.toContain("PREVIOUS_CANVAS");
      expect(text).toContain(
        change === "cleared"
          ? "Disregard any earlier workspace Canvas"
          : "UPDATED_CANVAS",
      );
      worker.turns[2]?.finish();
    } finally {
      f.runtime.dispose();
    }
  },
);

it("reaps an unresponsive Goose community wake after its deadline", async () => {
  const f = setup({ hold: true, scope: "community" });
  const config = { ...DEFAULT_CONFIG, scope: "community" as const };
  const abort = new AbortController();
  const done = f.runtime.runOnce({
    delivery: { agent: f.agent, config, current: () => true },
    key: "stalled",
    signal: abort.signal,
    prompt: async () => "check",
  } as unknown as Parameters<GooseRuntime["runOnce"]>[0]);
  void done.catch(() => {});
  try {
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const worker = f.goose();
    if (!worker) throw new Error("missing Goose");
    worker.silent.add("session/cancel");
    vi.useFakeTimers();
    abort.abort(new Error("deadline"));
    await vi.advanceTimersByTimeAsync(15_001);
    expect(worker.killed).toBe(true);
    vi.useRealTimers();
    await done.catch(() => {});
    await f.deliver(message("2", "next"));
    await vi.waitFor(() =>
      expect(f.fake.geese.flatMap((p) => p.turns)).toHaveLength(2),
    );
  } finally {
    vi.useRealTimers();
    f.goose()?.turns[0]?.finish();
    await done.catch(() => {});
    f.runtime.dispose();
  }
});

it.each(["thread", "channel", "community"] as const)(
  "keeps queued Goose work separate from compaction cancellation (%s)",
  async (scope) => {
    const f = setup({ hold: true, scope, reply: "Compaction complete" });
    const root = message("1", "first");
    const config = { ...DEFAULT_CONFIG, scope };
    const agent = { ...f.agent, config } as unknown as Agent;
    const place = { channelId: channel, root: root.id };
    const held: PromiseLike<unknown>[] = [];
    try {
      await f.deliver(root, { config });
      await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
      const worker = f.goose();
      if (!worker) throw new Error("Expected harness process");
      worker.turns[0]?.finish();
      await vi.waitFor(() =>
        expect(f.runtime.sessionState(agent, place)).toBe("idle"),
      );
      const compacted = f.runtime
        .session(agent, place, "compact")
        .catch((error) => error);
      await vi.waitFor(() => expect(worker.turns[1]?.text).toBe("/compact"));
      const reply = message("2", "queued after cancelled compaction", {
        tags: [
          ["h", channel],
          ["e", root.id, "", "reply"],
        ],
      });
      await f.deliver(reply, {
        config,
        workingUntil: (done) => held.push(done),
      });
      await f.runtime.session(agent, place, "interrupt");
      worker.turns[1]?.finish();
      await compacted;
      await vi.waitFor(() =>
        expect(worker.turns[2]?.text).toContain(
          "queued after cancelled compaction",
        ),
      );
      worker.turns[2]?.finish();
      await Promise.all(held);
    } finally {
      f.runtime.dispose();
    }
  },
);

it.each(["thread", "channel"] as const)(
  "stops only queued Goose work while compaction owns the harness (%s)",
  async (scope) => {
    const f = setup({ hold: true, scope, reply: "Compaction complete" });
    const root = message("1", "first");
    const config = { ...DEFAULT_CONFIG, scope };
    const agent = { ...f.agent, config } as unknown as Agent;
    const place = { channelId: channel, root: root.id };
    const held: PromiseLike<unknown>[] = [];
    const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
    try {
      await f.deliver(root, { config });
      await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
      const worker = f.goose();
      if (!worker) throw new Error("Expected harness process");
      worker.turns[0]?.finish();
      await vi.waitFor(() =>
        expect(f.runtime.sessionState(agent, place)).toBe("idle"),
      );
      const compacted = f.runtime
        .session(agent, place, "compact")
        .catch((error) => error);
      await vi.waitFor(() => expect(worker.turns[1]?.text).toBe("/compact"));
      const reply = message("2", "stopped queued input", {
        tags: [
          ["h", channel],
          ["e", root.id, "", "reply"],
        ],
      });
      await f.deliver(reply, {
        config,
        interruptible,
        workingUntil: (done) => held.push(done),
      });
      await vi.waitFor(() => expect(interruptible).toHaveBeenCalledOnce());
      await interruptible.mock.calls[0]?.[0]();
      expect(worker.cancelled).toHaveLength(0);
      worker.turns[1]?.finish();
      expect(await compacted).toBeUndefined();
      await Promise.all(held);
      expect(worker.turns).toHaveLength(2);
    } finally {
      f.runtime.dispose();
    }
  },
);
