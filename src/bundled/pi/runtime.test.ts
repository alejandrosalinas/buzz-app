import { afterEach, expect, it, vi } from "vitest";
import {
  promptMessage,
  promptSections,
} from "../../features/agents/activity-transcript";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import { pubkeyOf } from "../../features/agents/membership";
import { ownerReads } from "../../features/agents/reads";
import type { MemoryEntry } from "../../features/agents/memory";
import type {
  Agent,
  AgentHandle,
  Delivery,
  StandaloneTurn,
} from "../../features/agents/service";
import type { EventData, RelayEvent } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { deferred, fakeHost, type Handler } from "./pi-testing";
import { type Config, DEFAULT_CONFIG, PiRuntime } from "./runtime";

afterEach(() => {
  vi.restoreAllMocks();
});

const self = "c".repeat(64);
const alice = "a".repeat(64);
const bob = "b".repeat(64);
const channel = "chan-1";
const CONVERSATION = 7;
const message = (
  id: string,
  content: string,
  extra: Partial<EventData> = {},
): RelayEvent =>
  ({
    id: id.repeat(64).slice(0, 64),
    pubkey: alice,
    kind: 9,
    created_at: 100,
    content,
    tags: [["h", channel]],
    sig: "",
    ...extra,
  }) as RelayEvent;
const root = message("1", "Build is red");
const reply = (id: string, content: string, created_at = 110) =>
  message(id, content, {
    created_at,
    tags: [
      ["h", channel],
      ["e", root.id, "", "reply"],
      ["p", self],
    ],
  });

function setup(
  handlers: Readonly<Record<string, Handler>> = {},
  added: readonly AddedTool[] = [],
  /** The channel's Canvas, as it reads now. */
  canvas?: { content: string; pubkey?: string },
  repositories?: (scope: string | undefined) => string,
) {
  let submissions = 0;
  const host = fakeHost({
    deliver: () => ({
      submission: ++submissions,
      conversation: CONVERSATION,
    }),
    once: () => ({ submission: ++submissions, conversation: 99 }),
    place: () => ({ seen: 0 }),
    unfinished: () => ({ submissions: [] }),
    wait: () => new Promise(() => {}),
    ...handlers,
  });
  /** Channels that are the owner's own Solo chats; the owner is the viewer. */
  const solo = new Set<string>();
  const session = {
    read: vi.fn(async () => [root]),
    agentMemories: {
      read: vi.fn(async () => ({
        entries: [] as readonly MemoryEntry[],
        partial: false,
      })),
    },
    channels: {
      list: () => ({
        channels: [
          { id: channel, name: "general", channelType: "stream", members: [] },
          ...[...solo].map((id) => ({ id, channelType: "solo", members: [] })),
        ],
      }),
    },
    names: {
      resolve: (pubkey: string) => (pubkey === alice ? "Alice" : undefined),
    },
    profiles: {
      ensure: vi.fn(async (): Promise<void> => {}),
      snapshot: () => new Map(),
      event: vi.fn((_key: string): RelayEvent | undefined => undefined),
    },
    channelWrites: { startingCanvas: () => undefined },
    canvas: {
      available: !!canvas,
      read: vi.fn(
        async () =>
          canvas && {
            pubkey: alice,
            kind: 40100,
            created_at: 100,
            tags: [],
            ...canvas,
          },
      ),
    },
  };
  const relay = {
    snapshot: () => ({
      status: "ready",
      session,
      viewer: alice,
      scope: `https://agent.example:${alice}`,
    }),
  } as unknown as RelayData;
  const core = vi.fn(async () => null as string | null | undefined);
  /** Whether `Agents.handle` gives the agent outside a run. */
  const connection = { live: true };
  const desktop = { spawn: host.spawn };
  const runtime = new PiRuntime(
    desktop,
    (key) => ownerReads(relay, pubkeyOf(key)),
    core,
    () => added,
    repositories,
    (key) =>
      connection.live && key === self
        ? (agent as unknown as AgentHandle)
        : undefined,
  );
  const published: { kind: number; content: string; tags: string[][] }[] = [];
  const agent = {
    key: self,
    pubkey: self,
    name: "Pi",
    owner: alice,
    publish: vi.fn(async (template: (typeof published)[number]) => {
      published.push(template);
      return { ...message(String(published.length), template.content) };
    }),
    query: vi.fn(async () => [] as RelayEvent[]),
    upload: vi.fn(),
    media: vi.fn(),
    remember: vi.fn(),
    handoff: vi.fn(),
    attention: {
      enabled: () => true,
      classifier: () => "unavailable" as const,
      show: vi.fn(),
      interests: vi.fn(() => ["ops"]),
      watches: vi.fn(() => []),
      write: vi.fn(),
    },
  };
  const deliver = (
    trigger: Delivery["trigger"],
    extra: Partial<Delivery<Config>> = {},
    presented = true,
  ) => {
    const receipt = {
      workingUntil: vi.fn<Delivery["workingUntil"]>(),
      ignored: vi.fn(),
      step: vi.fn(),
      acknowledged: vi.fn(),
      superseded: vi.fn(),
    };
    const run = runtime.run({
      trigger,
      channelId: channel,
      agent,
      config: DEFAULT_CONFIG,
      signal: new AbortController().signal,
      ...(presented
        ? receipt
        : { workingUntil: receipt.workingUntil, ignored: receipt.ignored }),
      ...extra,
    } as unknown as Delivery);
    return { run, ...receipt };
  };
  /** What the turn `workingUntil` was given settled with. */
  const settled = (receipt: {
    workingUntil: { mock: { calls: unknown[][] } };
  }) =>
    receipt.workingUntil.mock.calls[0]?.[0] as Promise<{
      ok: boolean;
      error?: string;
    }>;
  const runOnce = (
    key: string,
    text: string | undefined,
    signal = new AbortController().signal,
  ) =>
    runtime.runOnce({
      delivery: { agent, config: DEFAULT_CONFIG },
      key,
      signal,
      prompt: async () => text,
    } as unknown as StandaloneTurn);
  return {
    runtime,
    host,
    desktop,
    deliver,
    runOnce,
    settled,
    published,
    agent,
    session,
    solo,
    connection,
    core,
  };
}

it("contains delegated file reads with the current Pi handle's policy", async () => {
  const f = setup();
  const spawn = f.desktop.spawn;
  const read = vi.fn(
    async (
      _id: string,
      options: import("../../features/host/service").HostProcessOptions = {},
    ) => {
      options.onStdout?.(btoa("reviewed Pi file"));
      return {
        write: vi.fn(),
        end: vi.fn(),
        kill: vi.fn(),
        exited: Promise.resolve(0),
      };
    },
  );
  f.desktop.spawn = (id, options) =>
    id === "read-protected" ? read(id, options) : spawn(id, options);
  try {
    await f.deliver({ type: "mention", event: reply("2", "@Pi look") }).run;
    const processProtection = {
      readOnlyPaths: ["/controls"],
      hiddenPaths: ["/approval"],
    };
    Object.assign(f.agent, {
      protection: {
        processProtection,
        assertAvailable() {},
        check: async () => {},
      },
    });
    const result = await f.runtime.tool({
      agent: self,
      conversation: CONVERSATION,
      context: { channel, root: root.id },
      name: "send",
      arguments: { path: "report.md", audience: "everyone" },
    });
    expect(result.isError).not.toBe(true);
    expect(read).toHaveBeenCalledExactlyOnceWith(
      "read-protected",
      expect.objectContaining({
        args: ["report.md"],
        cwd: DEFAULT_CONFIG.workspace,
        protection: processProtection,
      }),
    );
    expect(f.published.at(-1)?.content).toBe("reviewed Pi file");
  } finally {
    await f.runtime.dispose();
  }
});

it("stops a protected file read when its tool call is aborted", async () => {
  const f = setup();
  const spawn = f.desktop.spawn;
  const started = deferred();
  const exit = deferred<number>();
  const kill = vi.fn(async () => exit.resolve(143));
  f.desktop.spawn = async (id, options) => {
    if (id !== "read-protected") return spawn(id, options);
    started.resolve();
    return { write: vi.fn(), end: vi.fn(), kill, exited: exit.promise };
  };
  try {
    await f.deliver({ type: "mention", event: reply("2", "@Pi look") }).run;
    Object.assign(f.agent, {
      protection: {
        processProtection: { readOnlyPaths: [], hiddenPaths: [] },
        assertAvailable() {},
        check: async () => {},
      },
    });
    const stop = new AbortController();
    const result = f.runtime.tool(
      {
        agent: self,
        conversation: CONVERSATION,
        context: { channel, root: root.id },
        name: "send",
        arguments: { path: "report.md", audience: "everyone" },
      },
      stop.signal,
    );
    await started.promise;
    expect(kill).not.toHaveBeenCalled();
    stop.abort();
    expect((await result).isError).toBe(true);
    expect(kill).toHaveBeenCalled();
  } finally {
    exit.resolve(0);
    await f.runtime.dispose();
  }
});

it("never opens a protected agent's storage in the shared host before its handle arrives", async () => {
  const { host, runtime } = setup();
  runtime.sync([
    {
      key: self,
      pubkey: self,
      config: DEFAULT_CONFIG,
      protection: { provider: "test", policy: {} },
    },
  ] as unknown as Agent[]);
  await expect(runtime.places(self)).rejects.toThrow(
    "The agent isn't connected yet",
  );
  expect(host.requests("places")).toEqual([]);
  expect(host.processes).toEqual([]);
});

it("hands an owner's mention to its thread's Pi conversation", async () => {
  const { host, deliver, published } = setup();
  const mention = reply("2", "@Pi can you look?");
  const turn = deliver(
    { type: "mention", event: mention },
    { model: "claude-x", effort: "high" },
  );
  await turn.run;
  const [open] = host.requests("open");
  const tools = ((open?.params.tools ?? []) as { name: string }[]).map(
    (tool) => tool.name,
  );
  expect(tools).toEqual(expect.arrayContaining(["send", "read"]));
  // Loaded up front or on search, and what the search can find.
  const listed = open?.params.tools as { name: string; load: string }[];
  expect(listed.find((tool) => tool.name === "send")?.load).toBe("always");
  expect(listed.find((tool) => tool.name === "watch_add")?.load).toBe("search");
  expect(String(open?.params.hint)).toContain("Search for the rest");
  const [delivered] = host.requests("deliver");
  expect(delivered?.params).toMatchObject({
    agent: self,
    key: `${channel}/${root.id}`,
    at: 110,
    context: { channel, root: root.id },
    request: mention.id,
    provider: "",
    model: "",
    // The owner's pick, apart, so a steer changes only what it names.
    pick: { model: "claude-x", thinking: "high" },
    cwd: "~/.buzz",
  });
  const text = String(delivered?.params.text);
  expect(text).toContain(`Thread root: ${root.id}`);
  expect(text).toMatch(/^<thread-context>\n/);
  expect(text).toContain(`"pubkey":"${alice}"`);
  expect(text).toContain("Build is red");
  expect(text).toContain('Request: "@Pi can you look?"');
  expect(promptMessage(promptSections(text)).text).toBe("@Pi can you look?");
  expect(String(delivered?.params.steer)).toContain("@Pi can you look?");
  expect(String(delivered?.params.instructions)).toContain(self);
  expect(turn.workingUntil).toHaveBeenCalledTimes(1);
  expect(published).toEqual([]);
});

it("keeps one agent's two communities' storage apart, each under its membership's key", async () => {
  const other = `${self}@other.example`;
  const { host, deliver, runtime, agent } = setup();
  const elsewhere = { ...agent, key: other } as unknown as Delivery["agent"];
  runtime.sync([
    { key: self, pubkey: self, config: DEFAULT_CONFIG },
    { key: other, pubkey: self, config: DEFAULT_CONFIG },
  ] as unknown as Agent[]);
  await deliver({ type: "mention", event: reply("2", "@Pi here") }).run;
  await deliver(
    { type: "mention", event: reply("3", "@Pi there") },
    { agent: elsewhere },
  ).run;
  expect(host.requests("open").map((open) => open.params.agent)).toEqual([
    self,
    other,
  ]);
  expect(host.requests("deliver").map((sent) => sent.params.agent)).toEqual([
    self,
    other,
  ]);
  // Both are the one identity, whose pubkey its instructions still name.
  expect(String(host.requests("deliver")[1]?.params.instructions)).toContain(
    `pubkey ${self}`,
  );
  // Leaving one community closes only that membership's storage.
  runtime.sync([{ key: self, pubkey: self, config: DEFAULT_CONFIG }] as never);
  await vi.waitFor(() =>
    expect(host.requests("close").map((close) => close.params.agent)).toEqual([
      other,
    ]),
  );
});

it("hands a conversation its own community repositories without changing its workspace", async () => {
  const repositories = vi.fn(
    () => "<community-repositories>/code/own</community-repositories>",
  );
  const { host, deliver } = setup({}, [], undefined, repositories);
  await deliver({ type: "mention", event: reply("2", "@Pi look") }).run;
  const [delivered] = host.requests("deliver");
  expect(repositories).toHaveBeenCalledWith(`https://agent.example:${alice}`);
  expect(String(delivered?.params.instructions)).toContain("/code/own");
  expect(delivered?.params.cwd).toBe("~/.buzz");
});

it("hands Pi the core memory apart from the instructions, and none it could not read", async () => {
  const turn = async (memory: string | undefined) => {
    const { host, deliver, core } = setup();
    core.mockResolvedValue(memory);
    await deliver({ type: "mention", event: reply("2", "@Pi look") }).run;
    return host.requests("deliver")[0]?.params ?? {};
  };
  const read = await turn("Remember the build");
  // Pi keeps a conversation's memory as it was shown, and refreshes only the
  // note that there is none.
  expect(read.core).toEqual({
    text: "<core-memory>\nRemember the build\n</core-memory>",
  });
  expect(String(read.instructions)).not.toContain("core-memory");
  expect(await turn(undefined)).not.toHaveProperty("core");
});

it("ends a turn's prompt with its conversation's instructions", async () => {
  const { host, deliver, agent } = setup();
  const conversationInstructions = vi.fn(() => ({
    plugin: "acme.tasks",
    text: "Review only.",
  }));
  Object.assign(agent, { conversationInstructions });
  await deliver({ type: "mention", event: reply("2", "@Pi look") }).run;
  expect(String(host.requests("deliver")[0]?.params.text)).toMatch(
    /<owner-instructions source="acme\.tasks">\n[\s\S]*\n\nReview only\.\n<\/owner-instructions>/,
  );
  // Keyed as its session is: the reply's thread.
  expect(conversationInstructions).toHaveBeenCalledWith(channel, root.id);
});

it("shows a conversation only the messages it was not shown, nor its own replies", async () => {
  const { host, deliver, session } = setup({ place: () => ({ seen: 105 }) });
  const later = (id: string, content: string, pubkey: string, at: number) => ({
    ...reply(id, content, at),
    pubkey,
  });
  session.read.mockResolvedValue([
    root,
    later("5", "Earlier from Pi", self, 107),
    later("6", "Bob checked it", bob, 108),
  ]);
  await deliver({ type: "mention", event: reply("2", "@Pi look") }).run;
  const text = String(host.requests("deliver")[0]?.params.text);
  expect(text).toContain("Bob checked it");
  expect(text).not.toContain("Build is red");
  expect(text).not.toContain("Earlier from Pi");
});

it("ignores a mention from someone who is not the owner", async () => {
  const { host, deliver } = setup();
  const turn = deliver({
    type: "mention",
    event: { ...reply("2", "@Pi rm -rf"), pubkey: bob },
  });
  await turn.run;
  expect(turn.ignored).toHaveBeenCalled();
  expect(host.processes).toEqual([]);
});

it("shows a conversation's activity on the request Pi took last", async () => {
  let entries = 0;
  const { host, deliver } = setup({
    // Pi says it took each request before it answers.
    deliver: (params, process) => {
      process.send({
        method: "event",
        params: {
          agent: self,
          conversation: CONVERSATION,
          type: "placed",
          request: params.request,
          entry: ++entries,
        },
      });
      return { submission: 1, conversation: CONVERSATION };
    },
  });
  const first = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await first.run;
  await vi.waitFor(() => expect(first.acknowledged).toHaveBeenCalled());
  const second = deliver({ type: "mention", event: reply("3", "@Pi also") });
  await vi.waitFor(() => expect(second.acknowledged).toHaveBeenCalled());
  expect(first.superseded).toHaveBeenCalled();
  host.processes[0]?.send({
    method: "event",
    params: {
      agent: self,
      conversation: CONVERSATION,
      type: "step",
      tool: "bash",
      target: "npm test",
    },
  });
  await vi.waitFor(() =>
    expect(second.step).toHaveBeenCalledWith("bash", "npm test"),
  );
  expect(first.step).not.toHaveBeenCalled();
});

it("says which conversations a request works in, and lists the agent's places", async () => {
  const answered = deferred<unknown>();
  const { runtime, deliver, settled } = setup({
    deliver: (params, process) => {
      process.send({
        method: "event",
        params: {
          agent: self,
          conversation: CONVERSATION,
          type: "placed",
          request: params.request,
          entry: 1,
        },
      });
      return { submission: 1, conversation: CONVERSATION };
    },
    wait: () => answered.promise,
    places: () => ({
      places: [
        { key: `${channel}/${root.id}`, conversation: CONVERSATION, seen: 110 },
        { key: "dm-1", conversation: 8, seen: 120 },
      ],
    }),
  });
  const changed = vi.fn();
  runtime.subscribe(changed);
  expect(runtime.working(self)).toEqual([]);
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await vi.waitFor(() => expect(runtime.working(self)).toEqual([CONVERSATION]));
  expect(changed).toHaveBeenCalled();
  // One view until it changes, as useSyncExternalStore needs.
  expect(runtime.working(self)).toBe(runtime.working(self));
  answered.resolve({ status: "done", answer: 1, text: "" });
  await settled(turn);
  expect(runtime.working(self)).toEqual([]);

  expect(await runtime.places(self)).toEqual([
    { key: "dm-1", conversation: 8, channelId: "dm-1", at: 120_000 },
    {
      key: `${channel}/${root.id}`,
      conversation: CONVERSATION,
      channelId: channel,
      root: root.id,
      at: 110_000,
    },
  ]);
});

it("posts nothing Pi wrote without `send`, for any request its run answered", async () => {
  // Text the agent writes outside `send` is narration, not a reply: it stays
  // in Pi's session, the agent's local activity.
  const answered = deferred();
  const { deliver, settled, published } = setup({
    wait: async () => {
      await answered.promise;
      return { status: "done", answer: 5, text: "I've replied to Alice." };
    },
  });
  const first = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await first.run;
  const second = deliver({ type: "mention", event: reply("3", "@Pi also") });
  await vi.waitFor(() => expect(second.workingUntil).toHaveBeenCalled());
  answered.resolve();
  await expect(settled(first)).resolves.toEqual({ ok: true });
  await expect(settled(second)).resolves.toEqual({ ok: true });
  expect(published).toEqual([]);
});

it.each([
  ["send", {}],
  ["reply_in_subthread", { parent: root.id }],
])(
  "runs Pi's Buzz tools in the conversation's thread, and posts nothing more after a final %s",
  async (name, extra) => {
    const answered = deferred();
    const { host, deliver, settled, published } = setup({
      wait: async () => {
        await answered.promise;
        return { status: "done", answer: 5, text: "Posted it." };
      },
    });
    const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
    await turn.run;
    const sent = await host.processes[0]?.tool({
      agent: self,
      conversation: CONVERSATION,
      context: { channel, root: root.id },
      name,
      arguments: { ...extra, text: "On it", audience: "everyone", final: true },
    });
    // A final message ends Pi's run.
    expect(sent?.result).toMatchObject({ final: true });
    expect(sent?.result).not.toMatchObject({ isError: true });
    answered.resolve();
    await expect(settled(turn)).resolves.toEqual({ ok: true });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: 9, content: "On it" });
    expect(published[0]?.tags).toContainEqual(["e", root.id, "", "reply"]);
  },
);

it("hands off from Pi to another of its conversations", async () => {
  const { host, deliver, agent } = setup();
  const metadata = message("8", "", { kind: 39000, tags: [["d", "chan-2"]] });
  const thread = message("9", "Deploy", { tags: [["h", "chan-2"]] });
  agent.query.mockImplementation(async (...filters: unknown[]) =>
    JSON.stringify(filters).includes("39000") ? [metadata] : [thread],
  );
  await deliver({ type: "mention", event: reply("2", "@Pi look") }).run;
  const result = (
    await host.processes[0]?.tool({
      agent: self,
      conversation: CONVERSATION,
      context: { channel, root: root.id },
      name: "self_handoff",
      arguments: { channel: "chan-2", thread: thread.id, text: "carry on" },
    })
  )?.result;
  expect(JSON.stringify(result)).toContain(`Handed off to thread ${thread.id}`);
  expect(agent.handoff).toHaveBeenCalledWith({
    channel: "chan-2",
    root: thread.id,
    text: "carry on",
    from: { channel, root: root.id },
  });
});

it("lists the tools plugins add, and runs them for Pi", async () => {
  const lookup = vi.fn<AddedTool["call"]>(async (_client, _context, args) => {
    if (args.q === "bad") throw new Error("No such thing");
    return `found ${String(args.q)}`;
  });
  const { host, deliver } = setup({}, [
    {
      name: "lookup",
      description: "Look it up",
      inputSchema: { type: "object" },
      call: lookup,
    },
  ]);
  await deliver({ type: "mention", event: reply("2", "@Pi look") }).run;
  const listed = host.requests("open")[0]?.params.tools as { name: string }[];
  expect(listed.at(-1)?.name).toBe("lookup");
  const call = async (q: string) =>
    (
      await host.processes[0]?.tool({
        agent: self,
        conversation: CONVERSATION,
        context: { channel, root: root.id },
        name: "lookup",
        arguments: { q },
      })
    )?.result;
  await expect(call("logs")).resolves.toEqual({
    content: [{ type: "text", text: "found logs" }],
  });
  expect(lookup).toHaveBeenCalledWith(
    expect.anything(),
    { channel, root: root.id },
    { q: "logs" },
  );
  await expect(call("bad")).resolves.toEqual({
    content: [{ type: "text", text: "No such thing" }],
    isError: true,
  });
});

it("reports a turn Pi left unanswered to the owner, in its thread", async () => {
  const { deliver, settled, published } = setup({
    wait: () => ({
      status: "unanswered",
      reason: "model_error",
      detail: "401 invalid x-api-key",
    }),
  });
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await expect(settled(turn)).resolves.toEqual({
    ok: false,
    error: "401 invalid x-api-key",
  });
  await vi.waitFor(() => expect(published).toHaveLength(1));
  expect(published[0]).toEqual({
    kind: 9,
    content: "⚠️ I couldn't finish that: 401 invalid x-api-key",
    tags: [
      ["h", channel],
      ["e", root.id, "", "reply"],
      ["p", alice],
    ],
  });
});

it("continues an owner's Solo chat at the top level, and reports its failures there", async () => {
  const { host, deliver, settled, published, solo } = setup({
    wait: ({ submission }) =>
      submission === 1
        ? { status: "done", answer: 5, text: "Here it is." }
        : { status: "unanswered", reason: "model_error", detail: "Overloaded" },
  });
  solo.add("solo-1");
  const me = (id: string) => message(id, "@Pi", { tags: [["h", "solo-1"]] });
  const answered = deliver(
    { type: "mention", event: me("2") },
    { channelId: "solo-1" },
  );
  await answered.run;
  await expect(settled(answered)).resolves.toEqual({ ok: true });
  expect(host.requests("deliver")[0]?.params).toMatchObject({
    key: "solo-1",
    context: { channel: "solo-1", topLevel: true },
  });
  const failed = deliver(
    { type: "mention", event: me("3") },
    { channelId: "solo-1" },
  );
  await vi.waitFor(() => expect(failed.workingUntil).toHaveBeenCalled());
  await expect(settled(failed)).resolves.toMatchObject({ ok: false });
  await vi.waitFor(() => expect(published).toHaveLength(1));
  expect(published.map((event) => event.tags)).toEqual([
    [
      ["h", "solo-1"],
      ["p", alice],
    ],
  ]);
});

/** A plugin's wake; its id is its own, which nothing may publish. */
const WAKE_ID = "9".repeat(64);
const pluginWake = (root?: string, where = channel) => ({
  type: "plugin" as const,
  plugin: "github",
  channel: where,
  ...(root ? { root } : {}),
  text: "CI failed: lint",
  id: WAKE_ID,
  at: 200_000,
});

it("takes a plugin's wake in its thread's conversation as the plugin's, and reports its failure at the thread's root", async () => {
  const { host, deliver, settled, published } = setup({
    wait: () => ({
      status: "unanswered",
      reason: "model_error",
      detail: "401 invalid x-api-key",
    }),
  });
  const turn = deliver(pluginWake(root.id));
  await turn.run;
  expect(turn.ignored).not.toHaveBeenCalled();
  const [delivered] = host.requests("deliver");
  expect(delivered?.params).toMatchObject({
    key: `${channel}/${root.id}`,
    context: { channel, root: root.id },
    request: `plugin/${WAKE_ID}`,
  });
  // Only an Attention wake saves its destination and refreshes its prompt.
  expect(delivered?.params).not.toHaveProperty("reply");
  expect(delivered?.params).not.toHaveProperty("refresh");
  const text = String(delivered?.params.text);
  expect(text).toContain('<plugin-wake plugin="github">');
  expect(text).toContain("neither your owner nor anyone in the channel");
  expect(text).toContain("CI failed: lint");
  expect(text).toContain(`Thread root: ${root.id}`);
  expect(text).toContain("Build is red");
  expect(text).not.toContain("<buzz-event");
  expect(text).not.toContain(WAKE_ID);
  await expect(settled(turn)).resolves.toMatchObject({ ok: false });
  await vi.waitFor(() => expect(published).toHaveLength(1));
  expect(published[0]?.tags).toEqual([
    ["h", channel],
    ["e", root.id, "", "reply"],
    ["p", alice],
  ]);
  expect(JSON.stringify(published)).not.toContain(WAKE_ID);
});

it("takes a wake with no thread only in a Solo chat", async () => {
  const { host, deliver, solo } = setup();
  const stream = deliver(pluginWake());
  await stream.run;
  expect(stream.ignored).toHaveBeenCalled();
  expect(host.requests("deliver")).toEqual([]);
  solo.add("solo-1");
  const chat = deliver(pluginWake(undefined, "solo-1"), {
    channelId: "solo-1",
  });
  await chat.run;
  expect(chat.ignored).not.toHaveBeenCalled();
  const [delivered] = host.requests("deliver");
  expect(delivered?.params).toMatchObject({
    key: "solo-1",
    context: { channel: "solo-1", topLevel: true },
  });
  expect(String(delivered?.params.text)).toContain(
    '<plugin-wake plugin="github">',
  );
  expect(String(delivered?.params.text)).not.toContain(WAKE_ID);
});

it("hands a Solo chat's Canvas to each turn, and no one else's", async () => {
  const { host, deliver, solo } = setup({}, [], {
    content: "Work in ~/src/app.",
  });
  solo.add("solo-1");
  const turn = deliver(
    {
      type: "mention",
      event: message("2", "@Pi", { tags: [["h", "solo-1"]] }),
    },
    { channelId: "solo-1" },
  );
  await turn.run;
  expect(String(host.requests("deliver")[0]?.params.text)).toContain(
    "Work in ~/src/app.",
  );
  // A thread is no Solo chat: its Canvas is not read.
  await deliver({ type: "mention", event: reply("3", "@Pi look") }).run;
  expect(String(host.requests("deliver")[1]?.params.text)).not.toContain(
    "workspace-canvas",
  );
});

it("stops a mention's run when the owner stops it, and posts nothing", async () => {
  const answered = deferred<unknown>();
  const { host, deliver, settled, published } = setup({
    wait: () => answered.promise,
    abort: () => {
      answered.resolve({ status: "unanswered", reason: "aborted" });
      return {};
    },
  });
  const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
  const turn = deliver(
    { type: "mention", event: reply("2", "@Pi look") },
    { interruptible },
  );
  await turn.run;
  expect(interruptible).toHaveBeenCalledTimes(1);
  await interruptible.mock.calls[0]?.[0]();
  expect(host.requests("abort")[0]?.params).toEqual({
    agent: self,
    conversation: CONVERSATION,
  });
  await expect(settled(turn)).resolves.toEqual({ ok: true, stopped: true });
  expect(published).toEqual([]);
});

it("settles a run that finishes despite the owner's stop as done, not stopped", async () => {
  const answered = deferred<unknown>();
  const { deliver, settled } = setup({
    wait: () => answered.promise,
    abort: () => {
      answered.resolve({ status: "done", answer: 5, text: "" });
      return {};
    },
  });
  const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
  const turn = deliver(
    { type: "mention", event: reply("2", "@Pi look") },
    { interruptible },
  );
  await turn.run;
  await interruptible.mock.calls[0]?.[0]();
  await expect(settled(turn)).resolves.toEqual({ ok: true });
});

it("settles a removed agent's aborted run as done, not stopped", async () => {
  const answered = deferred<unknown>();
  const { runtime, host, deliver, settled } = setup({
    wait: () => answered.promise,
  });
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await vi.waitFor(() => expect(host.requests("wait")).toHaveLength(1));
  runtime.sync([]);
  answered.resolve({ status: "unanswered", reason: "aborted" });
  await expect(settled(turn)).resolves.toEqual({ ok: true });
});

it("interrupts a run an earlier app left from its thread's session controls", async () => {
  const left = { submission: 41, conversation: 5, request: "d".repeat(64) };
  const stopped = deferred<unknown>();
  const { host, deliver, published, runtime } = setup({
    unfinished: () => ({
      submissions: [{ ...left, context: { channel, root: root.id } }],
    }),
    wait: ({ submission }) =>
      submission === left.submission ? stopped.promise : new Promise(() => {}),
    session: ({ action }) => {
      if (action === "interrupt")
        stopped.resolve({ status: "unanswered", reason: "aborted" });
    },
  });
  const agent = {
    key: self,
    pubkey: self,
    config: DEFAULT_CONFIG,
  } as unknown as Agent;
  const thread = { channelId: channel, root: root.id };
  expect(runtime.sessionState(agent, thread)).toBe("idle");
  await deliver({
    type: "mention",
    event: message("5", "@Pi elsewhere", {
      tags: [
        ["h", channel],
        ["p", self],
      ],
    }),
  }).run;
  expect(runtime.sessionState(agent, thread)).toBe("active");
  await runtime.session(agent, thread, "interrupt");
  expect(host.requests("session")[0]?.params).toEqual({
    agent: self,
    key: `${channel}/${root.id}`,
    action: "interrupt",
  });
  await vi.waitFor(() =>
    expect(runtime.sessionState(agent, thread)).toBe("idle"),
  );
  expect(published).toEqual([]);
});

it("compacts or starts a new session only while idle, and hands a mention over once compaction ends", async () => {
  const compacted = deferred();
  const { host, deliver, settled, runtime, connection } = setup({
    wait: () => ({ status: "done", answer: 5, text: "" }),
    session: ({ action }) => (action === "compact" ? compacted.promise : {}),
  });
  const agent = {
    key: self,
    pubkey: self,
    config: DEFAULT_CONFIG,
  } as unknown as Agent;
  const thread = { channelId: channel, root: root.id };
  // Without the agent's handle, its left runs could not be taken on first.
  connection.live = false;
  await expect(runtime.session(agent, thread, "new")).rejects.toThrow(
    "isn't connected",
  );
  expect(host.requests("session")).toEqual([]);
  connection.live = true;
  // No mention is needed first.
  await runtime.session(agent, thread, "new");
  const first = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await first.run;
  await settled(first);
  await vi.waitFor(() =>
    expect(runtime.sessionState(agent, thread)).toBe("idle"),
  );
  const compacting = runtime.session(agent, thread, "compact");
  await vi.waitFor(() => expect(host.requests("session")).toHaveLength(1));
  expect(runtime.sessionState(agent, thread)).toBe("compacting");
  await expect(runtime.session(agent, thread, "new")).rejects.toThrow(
    "Wait for the active turn",
  );
  const later = deliver({ type: "mention", event: reply("3", "@Pi again") });
  // Released at once, and handed over after compaction.
  await later.run;
  expect(host.requests("deliver")).toHaveLength(1);
  compacted.resolve();
  await compacting;
  await settled(later);
  expect(host.requests("deliver")).toHaveLength(2);
  await vi.waitFor(() =>
    expect(runtime.sessionState(agent, thread)).toBe("idle"),
  );
  await runtime.session(agent, thread, "new");
  expect(host.requests("session").map((item) => item.params)).toEqual([
    { agent: self, key: `${channel}/${root.id}`, action: "new" },
    { agent: self, key: `${channel}/${root.id}`, action: "compact" },
    { agent: self, key: `${channel}/${root.id}`, action: "new" },
  ]);
});

it("refuses Compact or New when a run taken on first is in the same conversation", async () => {
  const left = { submission: 41, conversation: 5, request: "d".repeat(64) };
  const { host, runtime } = setup({
    unfinished: () => ({
      submissions: [{ ...left, context: { channel, root: root.id } }],
    }),
  });
  const agent = {
    key: self,
    pubkey: self,
    config: DEFAULT_CONFIG,
  } as unknown as Agent;
  const thread = { channelId: channel, root: root.id };
  expect(runtime.sessionState(agent, thread)).toBe("idle");
  await expect(runtime.session(agent, thread, "new")).rejects.toThrow(
    "Wait for the active turn",
  );
  expect(host.requests("session")).toEqual([]);
  expect(runtime.sessionState(agent, thread)).toBe("active");
});

it("sends no Compact that an Interrupt cut off while it was preparing", async () => {
  const listed = deferred<unknown>();
  const { host, runtime } = setup({ unfinished: () => listed.promise });
  const agent = {
    key: self,
    pubkey: self,
    config: DEFAULT_CONFIG,
  } as unknown as Agent;
  const thread = { channelId: channel, root: root.id };
  const compacting = runtime.session(agent, thread, "compact");
  await vi.waitFor(() => expect(host.requests("unfinished")).toHaveLength(1));
  expect(runtime.sessionState(agent, thread)).toBe("compacting");
  const interrupting = runtime.session(agent, thread, "interrupt");
  listed.resolve({ submissions: [] });
  await expect(compacting).rejects.toThrow("interrupted");
  await interrupting;
  expect(host.requests("session").map((item) => item.params)).toEqual([
    { agent: self, key: `${channel}/${root.id}`, action: "interrupt" },
  ]);
});

it("takes on a run an earlier app left before compacting, with no mention since", async () => {
  const left = { submission: 41, conversation: 5, request: "d".repeat(64) };
  const order: string[] = [];
  const { published, runtime } = setup({
    unfinished: () => {
      order.push("unfinished");
      return {
        submissions: [{ ...left, context: { channel, root: "other-root" } }],
      };
    },
    wait: () => ({
      status: "unanswered",
      reason: "error",
      detail: "400 Bad model",
    }),
    session: () => {
      order.push("session");
    },
  });
  const agent = {
    key: self,
    pubkey: self,
    config: DEFAULT_CONFIG,
  } as unknown as Agent;
  await runtime.session(
    agent,
    { channelId: channel, root: root.id },
    "compact",
  );
  // Taken on before Pi is asked anything that continues it.
  expect(order).toEqual(["unfinished", "session"]);
  await vi.waitFor(() =>
    expect(published.map((event) => event.content)).toEqual([
      expect.stringContaining("400 Bad model"),
    ]),
  );
  expect(published[0]?.tags).toContainEqual(["e", "other-root", "", "reply"]);
});

it("lists the agent's sessions from Pi's storage, and whether each works", async () => {
  const answered = deferred<unknown>();
  const key = `${channel}/${root.id}`;
  const { runtime, deliver, settled, host, agent } = setup({
    places: () => ({
      places: [
        { key, conversation: CONVERSATION, seen: 105 },
        { key: "chan-2", conversation: 3, seen: 90 },
      ],
    }),
    deliver: (params, process) => {
      process.send({
        method: "event",
        params: {
          agent: self,
          conversation: CONVERSATION,
          type: "placed",
          request: params.request,
          entry: 1,
        },
      });
      return { submission: 1, conversation: CONVERSATION };
    },
    wait: () => answered.promise,
  });
  const listener = vi.fn();
  runtime.subscribe(listener);
  // An agent that does not run here keeps its storage closed.
  expect(runtime.sessions(self)).toEqual([]);
  expect(host.requests("places")).toEqual([]);
  runtime.sync([{ ...agent, config: DEFAULT_CONFIG } as unknown as Agent]);
  // Read from storage on first ask; subscribers hear when it is in.
  expect(runtime.sessions(self)).toEqual([]);
  await vi.waitFor(() => expect(listener).toHaveBeenCalled());
  expect(runtime.sessions(self)).toEqual([
    { channelId: channel, root: root.id, at: 105_000 },
    { channelId: "chan-2", at: 90_000 },
  ]);
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await vi.waitFor(() => expect(turn.acknowledged).toHaveBeenCalled());
  expect(runtime.sessions(self)).toEqual([
    { channelId: channel, root: root.id, at: 110_000, status: "Working" },
    { channelId: "chan-2", at: 90_000, status: "Idle" },
  ]);
  answered.resolve({ status: "done", answer: 2, text: "" });
  await settled(turn);
  await vi.waitFor(() =>
    expect(runtime.sessions(self)[0]?.status).toBe("Idle"),
  );
});

it("waits for a turn again once the agent's failed storage is opened again", async () => {
  let waits = 0;
  const { host, deliver, settled, published } = setup({
    wait: () =>
      ++waits === 1
        ? { status: "reopen" }
        : { status: "done", answer: 5, text: "Resumed." },
  });
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await expect(settled(turn)).resolves.toEqual({ ok: true });
  expect(host.requests("open")).toHaveLength(2);
  expect(published).toEqual([]);
});

it("gives up on a turn whose agent's storage fails again once it is opened again", async () => {
  const { host, deliver, settled, published } = setup({
    wait: () => ({ status: "reopen" }),
  });
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await expect(settled(turn)).resolves.toEqual({
    ok: false,
    error: "Pi's storage for this agent keeps failing",
  });
  expect(host.requests("open")).toHaveLength(2);
  expect(host.requests("wait")).toHaveLength(2);
  await vi.waitFor(() => expect(published).toHaveLength(1));
  expect(published[0]?.content).toContain("keeps failing");
});

it("reports the failure of a run an earlier app left unfinished in its thread, once a delivery in another thread continues it", async () => {
  const left = { submission: 41, conversation: 5, request: "d".repeat(64) };
  const { host, deliver, published, runtime } = setup({
    unfinished: () => ({
      submissions: [{ ...left, context: { channel, root: root.id } }],
    }),
    wait: ({ submission }) =>
      submission === left.submission
        ? { status: "unanswered", reason: "error", detail: "400 Bad model" }
        : new Promise(() => {}),
  });
  const turn = deliver({
    type: "mention",
    event: message("5", "@Pi elsewhere", {
      tags: [
        ["h", channel],
        ["p", self],
      ],
    }),
  });
  await turn.run;
  await vi.waitFor(() => expect(published).toHaveLength(1));
  expect(published[0]).toMatchObject({
    content: expect.stringContaining("400 Bad model"),
    tags: [
      ["h", channel],
      ["e", root.id, "", "reply"],
      ["p", alice],
    ],
  });
  // Waited for before the delivery that continues it, and only once.
  const methods = host.processes[0]?.requests.map((item) => item.method);
  expect(methods?.indexOf("unfinished")).toBeLessThan(
    methods?.indexOf("deliver") ?? 0,
  );
  expect(host.requests("unfinished")).toHaveLength(1);
  expect(runtime.working(self)).not.toContain(left.conversation);
});

it("reports a run an earlier app left unfinished that fails, and stays silent for one stopped", async () => {
  const { deliver, published } = setup({
    unfinished: () => ({
      submissions: [
        {
          submission: 41,
          conversation: 5,
          request: "d".repeat(64),
          context: { channel, root: root.id },
        },
        {
          submission: 42,
          conversation: 6,
          request: "e".repeat(64),
          context: { channel },
        },
      ],
    }),
    wait: ({ submission }) =>
      submission === 41
        ? { status: "unanswered", reason: "error", detail: "400 Bad model" }
        : submission === 42
          ? { status: "unanswered", reason: "aborted" }
          : new Promise(() => {}),
  });
  await deliver({ type: "mention", event: reply("2", "@Pi look") }).run;
  await vi.waitFor(() => expect(published).toHaveLength(1));
  expect(published[0]?.content).toContain("400 Bad model");
});

it("ends the watch and timer runs an earlier app left once every left mention is marked, before any wait", async () => {
  // Left before a mention whose thread is looked up. Ending them is modelled
  // as continuing Pi, as aborting a conversation does: the mention sends.
  const later = reply("8", "@Pi older");
  const looked = deferred();
  const { host, deliver, published, runtime, session } = setup({
    unfinished: () => ({
      submissions: [
        { submission: 51, conversation: 9, request: "timer/left" },
        { submission: 52, conversation: 10, request: "watch/left" },
        {
          submission: 42,
          conversation: 6,
          request: later.id,
          context: { channel },
        },
      ],
    }),
    drop: async (_params, process) => {
      await process.tool({
        agent: self,
        conversation: 6,
        context: { channel, root: root.id },
        name: "send",
        arguments: { text: "Sent itself", audience: "everyone" },
      });
    },
    wait: ({ submission }) =>
      submission === 42
        ? { status: "done", answer: 9, text: "Sent itself" }
        : new Promise(() => {}),
  });
  session.read.mockImplementation(async (filters?: { ids?: string[] }[]) => {
    if (!filters?.[0]?.ids?.includes(later.id)) return [root];
    await looked.promise;
    return [later];
  });
  const run = deliver({ type: "mention", event: reply("2", "@Pi look") }).run;
  await vi.waitFor(() =>
    expect(session.read).toHaveBeenCalledWith(
      [{ ids: [later.id], limit: 1 }],
      expect.anything(),
    ),
  );
  expect(host.requests("drop")).toEqual([]);
  looked.resolve();
  await run;
  expect(host.requests("drop").map((item) => item.params)).toEqual([
    {
      agent: self,
      submissions: [
        { submission: 51, conversation: 9 },
        { submission: 52, conversation: 10 },
      ],
    },
  ]);
  const methods = host.processes[0]?.requests.map((item) => item.method) ?? [];
  expect(methods.indexOf("drop")).toBeLessThan(methods.indexOf("wait"));
  await vi.waitFor(() => expect(runtime.working(self)).not.toContain(6));
  expect(runtime.working(self)).not.toContain(9);
  expect(published.map(({ content }) => content)).toEqual(["Sent itself"]);
});

it("keeps a standalone turn of this app's when it lists left runs again", async () => {
  let own: string | undefined;
  let waits = 0;
  const { host, runOnce } = setup({
    once: ({ request }) => {
      own = String(request);
      return { submission: 51, conversation: 9 };
    },
    unfinished: () => ({
      submissions: own
        ? [{ submission: 51, conversation: 9, request: own }]
        : [],
    }),
    // Its storage fails once, so it is opened again and left runs listed again.
    wait: () =>
      ++waits === 1
        ? { status: "reopen" }
        : { status: "done", answer: 5, text: "Done." },
  });
  await expect(runOnce("watch", "Check the build")).resolves.toEqual({
    ok: true,
  });
  expect(host.requests("unfinished")).toHaveLength(2);
  expect(host.requests("drop")).toEqual([]);
});

it("hands over no turn and waits for no left run while Pi could not end a left standalone run, and ends it at the next turn first", async () => {
  // Pi continues every run once asked anything: one left for no one is
  // ended before any wait, or not continued at all.
  let drops = 0;
  const left = {
    submission: 42,
    conversation: 6,
    request: "d".repeat(64),
    context: { channel, root: root.id },
  };
  const { host, deliver, settled, published, runtime } = setup({
    unfinished: () => ({
      submissions: [
        { submission: 51, conversation: 9, request: "timer/left" },
        left,
      ],
    }),
    drop: () => {
      if (++drops === 1) throw new Error("database is locked");
    },
  });
  const first = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await first.run.catch(() => undefined);
  await expect(settled(first)).resolves.toEqual({
    ok: false,
    error: "database is locked",
  });
  expect(host.requests("deliver")).toEqual([]);
  expect(host.requests("wait")).toEqual([]);
  expect(runtime.working(self)).not.toContain(left.conversation);
  await vi.waitFor(() => expect(published).toHaveLength(1));
  expect(published[0]?.content).toContain("database is locked");

  await deliver({ type: "mention", event: reply("3", "@Pi again") }).run;
  expect(host.requests("drop")).toHaveLength(2);
  const methods = host.processes[0]?.requests.map((item) => item.method) ?? [];
  expect(methods.lastIndexOf("drop")).toBeLessThan(methods.indexOf("wait"));
  expect(methods.lastIndexOf("drop")).toBeLessThan(methods.indexOf("deliver"));
  expect(host.requests("wait").map((item) => item.params.submission)).toContain(
    left.submission,
  );
});

it("ends a standalone run left for no one before it waits again in an agent opened again", async () => {
  // Its storage failed while a watch's run was abandoned: ended before the
  // wait that would continue it.
  let waits = 0;
  let reopened = false;
  const { host, deliver, settled } = setup({
    open: () => {
      if (host.requests("open").length > 1) reopened = true;
    },
    unfinished: () => ({
      submissions: reopened
        ? [{ submission: 51, conversation: 9, request: "watch/abandoned" }]
        : [],
    }),
    wait: () =>
      ++waits === 1
        ? { status: "reopen" }
        : { status: "done", answer: 5, text: "Resumed." },
  });
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await expect(settled(turn)).resolves.toEqual({ ok: true });
  const methods = host.processes[0]?.requests.map((item) => item.method) ?? [];
  expect(methods.slice(methods.indexOf("wait") + 1)).toEqual([
    "open",
    "unfinished",
    "drop",
    "wait",
  ]);
});

it("waits for no run again in an agent opened again while Pi could not end a standalone run left for no one", async () => {
  let reopened = false;
  const { host, deliver, settled } = setup({
    open: () => {
      if (host.requests("open").length > 1) reopened = true;
    },
    unfinished: () => ({
      submissions: reopened
        ? [{ submission: 51, conversation: 9, request: "watch/abandoned" }]
        : [],
    }),
    drop: () => {
      throw new Error("database is locked");
    },
    wait: () => ({ status: "reopen" }),
  });
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await expect(settled(turn)).resolves.toEqual({
    ok: false,
    error: "database is locked",
  });
  expect(host.requests("wait")).toHaveLength(1);
});

it("posts only the sends of a left run that sent once another left run's wait continued it", async () => {
  // The second run's thread is looked up; the first's wait continues every
  // run, and the second sends its answer itself.
  const later = reply("8", "@Pi older");
  const looked = deferred();
  const sent = deferred();
  const { host, deliver, published, runtime, session } = setup({
    unfinished: () => ({
      submissions: [
        {
          submission: 41,
          conversation: 5,
          request: "d".repeat(64),
          context: { channel, root: root.id },
        },
        {
          submission: 42,
          conversation: 6,
          request: later.id,
          context: { channel },
        },
      ],
    }),
    wait: async ({ submission }, process) => {
      if (submission === 41) {
        await process.tool({
          agent: self,
          conversation: 6,
          context: { channel, root: root.id },
          name: "send",
          arguments: { text: "Sent itself", audience: "everyone" },
        });
        sent.resolve();
        return new Promise(() => {});
      }
      if (submission === 42) {
        await sent.promise;
        return { status: "done", answer: 9, text: "Sent itself" };
      }
      return new Promise(() => {});
    },
  });
  session.read.mockImplementation(async (filters?: { ids?: string[] }[]) => {
    if (!filters?.[0]?.ids?.includes(later.id)) return [root];
    await looked.promise;
    return [later];
  });
  const run = deliver({ type: "mention", event: reply("2", "@Pi look") }).run;
  await vi.waitFor(() =>
    expect(session.read).toHaveBeenCalledWith(
      [{ ids: [later.id], limit: 1 }],
      expect.anything(),
    ),
  );
  expect(host.requests("wait")).toEqual([]);
  looked.resolve();
  await run;
  await vi.waitFor(() => expect(runtime.working(self)).not.toContain(6));
  expect(published.map(({ content }) => content)).toEqual(["Sent itself"]);
});

it("reports left runs of a conversation threads share in their mentions' thread, and lists left runs again after a failed listing", async () => {
  // Mentions in the thread, whose shared conversation's context has no root.
  const answered = reply("8", "@Pi old");
  const failed = reply("9", "@Pi older");
  let listings = 0;
  const { deliver, published, session } = setup({
    unfinished: () => {
      if (++listings === 1) throw new Error("busy");
      return {
        submissions: [answered, failed].map((event, index) => ({
          submission: 41 + index,
          conversation: 5,
          request: event.id,
          context: { channel },
        })),
      };
    },
    wait: ({ submission }) =>
      submission === 41
        ? { status: "unanswered", reason: "error", detail: "500 Overloaded" }
        : submission === 42
          ? { status: "unanswered", reason: "error", detail: "400 Bad model" }
          : new Promise(() => {}),
  });
  session.read.mockImplementation(async (filters?: { ids?: string[] }[]) =>
    [answered, failed, root].filter((event) =>
      (filters?.[0]?.ids ?? [root.id]).includes(event.id),
    ),
  );
  // A turn that could not list them hands nothing over, and says so.
  await deliver({ type: "mention", event: reply("2", "@Pi look") }).run.catch(
    () => undefined,
  );
  await vi.waitFor(() => expect(published).toHaveLength(1));
  expect(published[0]?.content).toContain("busy");
  await deliver({ type: "mention", event: reply("3", "@Pi again") }).run;
  await vi.waitFor(() => expect(published).toHaveLength(3));
  expect(published.slice(1).map(({ content }) => content)).toEqual([
    expect.stringContaining("500 Overloaded"),
    expect.stringContaining("400 Bad model"),
  ]);
  for (const { tags } of published)
    expect(tags.slice(0, 2)).toEqual([
      ["h", channel],
      ["e", root.id, "", "reply"],
    ]);
});

it("ends a plugin wake's run an earlier app left, unless that would end a mention's left in its conversation", async () => {
  const alone = `plugin/${"e".repeat(64)}`;
  const another = `plugin/${"d".repeat(64)}`;
  const shared = `plugin/${"f".repeat(64)}`;
  const later = reply("8", "@Pi also check the docs");
  const left = (submission: number, conversation: number, request: string) => ({
    submission,
    conversation,
    request,
    context: { channel },
  });
  const ended = deferred();
  const { host, deliver, published, runtime, session } = setup({
    unfinished: () => ({
      submissions: [
        left(61, 11, alone),
        left(62, 12, shared),
        left(63, 12, later.id),
        left(64, 13, another),
      ],
    }),
    abort: () => ended.promise,
    wait: ({ submission }) =>
      submission === 63
        ? { status: "unanswered", reason: "error", detail: "400 Bad model" }
        : new Promise(() => {}),
  });
  session.read.mockImplementation(async (filters?: { ids?: string[] }[]) =>
    [later, root].filter((event) =>
      (filters?.[0]?.ids ?? [root.id]).includes(event.id),
    ),
  );
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  // Every wake's run is marked before any conversation is aborted, as an
  // abort continues the runs not yet marked.
  await vi.waitFor(() => expect(host.requests("abort")).toHaveLength(1));
  expect(host.requests("drop").map((item) => item.params)).toEqual([
    {
      agent: self,
      submissions: [
        { submission: 61, conversation: 11 },
        { submission: 64, conversation: 13 },
      ],
    },
  ]);
  // Its conversation is aborted too, so a turn handed to it next starts a run
  // rather than joining one that ends without taking it.
  expect(host.requests("deliver")).toEqual([]);
  ended.resolve();
  await turn.run;
  expect(host.requests("abort").map((item) => item.params)).toEqual([
    { agent: self, conversation: 11 },
    { agent: self, conversation: 13 },
  ]);
  expect(host.requests("deliver")).toHaveLength(1);
  // The run the wake shares goes on, and reports in the mention's thread.
  await vi.waitFor(() => expect(published).toHaveLength(1));
  expect(published[0]?.content).toContain("400 Bad model");
  expect(published[0]?.tags.slice(0, 2)).toEqual([
    ["h", channel],
    ["e", root.id, "", "reply"],
  ]);
  expect(runtime.working(self)).not.toContain(11);
  // A wake's request is never looked for on the relay.
  expect(JSON.stringify(session.read.mock.calls)).not.toContain("plugin/");
});

it("still reports a left mention's failure when aborting a later wake's conversation fails", async () => {
  const later = reply("8", "@Pi also check the docs");
  const left = (submission: number, conversation: number, request: string) => ({
    submission,
    conversation,
    request,
    context: { channel },
  });
  const { host, deliver, settled, published, session } = setup({
    unfinished: () => ({
      submissions: [
        left(61, 11, `plugin/${"e".repeat(64)}`),
        left(64, 13, `plugin/${"d".repeat(64)}`),
        left(63, 12, later.id),
      ],
    }),
    abort: ({ conversation }) => {
      if (conversation === 13) throw new Error("database is locked");
    },
    wait: ({ submission }) =>
      submission === 63
        ? { status: "unanswered", reason: "error", detail: "400 Bad model" }
        : new Promise(() => {}),
  });
  session.read.mockImplementation(async (filters?: { ids?: string[] }[]) =>
    [later, root].filter((event) =>
      (filters?.[0]?.ids ?? [root.id]).includes(event.id),
    ),
  );
  const first = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await first.run.catch(() => undefined);
  await expect(settled(first)).resolves.toEqual({
    ok: false,
    error: "database is locked",
  });
  expect(host.requests("deliver")).toEqual([]);
  // The first abort continued the mention's run, which is still waited for.
  await vi.waitFor(() =>
    expect(published.map((event) => event.content)).toContainEqual(
      expect.stringContaining("400 Bad model"),
    ),
  );
});

it("waits silently for a left wake a queued mention is behind, whose failure fails the mention", async () => {
  const later = reply("8", "@Pi also check the docs");
  const failed = {
    status: "unanswered",
    reason: "model_error",
    detail: "invalid api key",
  };
  // The host fails what is queued behind a failed run once that run's own
  // request is waited for.
  const withdrawn = deferred<typeof failed>();
  const left = (submission: number, request: string) => ({
    submission,
    conversation: 12,
    request,
    context: { channel },
  });
  const { host, deliver, published, runtime, session } = setup({
    unfinished: () => ({
      submissions: [left(62, `plugin/${"f".repeat(64)}`), left(63, later.id)],
    }),
    wait: ({ submission }) => {
      if (submission === 62) {
        withdrawn.resolve(failed);
        return failed;
      }
      return submission === 63 ? withdrawn.promise : new Promise(() => {});
    },
  });
  session.read.mockImplementation(async (filters?: { ids?: string[] }[]) =>
    [later, root].filter((event) =>
      (filters?.[0]?.ids ?? [root.id]).includes(event.id),
    ),
  );
  await deliver({ type: "mention", event: reply("2", "@Pi look") }).run;
  expect(host.requests("drop")).toEqual([]);
  expect(host.requests("abort")).toEqual([]);
  // Only the mention reports the failure, in its thread, once settled after
  // the wake.
  await vi.waitFor(() => expect(runtime.working(self)).not.toContain(12));
  expect(published).toHaveLength(1);
  expect(published[0]?.content).toContain("invalid api key");
  expect(published[0]?.tags.slice(0, 2)).toEqual([
    ["h", channel],
    ["e", root.id, "", "reply"],
  ]);
  expect(
    host.requests("wait").filter((item) => item.params.submission === 62),
  ).toEqual([
    expect.objectContaining({ params: { agent: self, submission: 62 } }),
  ]);
});

it("waits for a turn again in a new host when the host stops", async () => {
  let hosts = 0;
  const { host, deliver, settled, published } = setup({
    // The first host stops before it answers; the next one, which continues
    // the run from Pi's storage, does.
    wait: (_params, process) => {
      if (++hosts === 1) {
        queueMicrotask(() => process.exit(1, "Killed\n"));
        return new Promise(() => {});
      }
      return { status: "done", answer: 5, text: "Resumed." };
    },
  });
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await expect(settled(turn)).resolves.toEqual({ ok: true });
  expect(host.processes).toHaveLength(2);
  // What the stopped host left for no one is ended before the wait continues it.
  expect(host.processes[1]?.requests.map((request) => request.method)).toEqual([
    "open",
    "unfinished",
    "wait",
  ]);
  expect(published).toEqual([]);
});

it("hands a turn to the next host when the host stops before it answers", async () => {
  let hosts = 0;
  const { host, deliver, settled } = setup({
    // The first host may have taken the turn; the next finds it by request.
    deliver: (_params, process) => {
      if (++hosts === 1) {
        queueMicrotask(() => process.exit(1, "Killed\n"));
        return new Promise(() => {});
      }
      return { submission: 1, conversation: CONVERSATION };
    },
    wait: () => ({ status: "done", answer: 5, text: "Done." }),
  });
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await expect(settled(turn)).resolves.toEqual({ ok: true });
  const delivered = host.requests("deliver");
  expect(delivered).toHaveLength(2);
  expect(delivered[1]?.params).toEqual(delivered[0]?.params);
  expect(host.processes[1]?.requests[0]?.method).toBe("open");
});

it("ends what the stopped host left before the retried hand-over", async () => {
  const left = { submission: 41, conversation: 7, request: "chan/one-off" };
  const { host, deliver, settled } = setup({
    deliver: (_params, process) => {
      if (process === host.processes[0]) {
        queueMicrotask(() => process.exit(1, "Killed\n"));
        return new Promise(() => {});
      }
      return { submission: 1, conversation: CONVERSATION };
    },
    // Listed only once the next host opens.
    unfinished: (_params, process) => ({
      submissions: process === host.processes[0] ? [] : [left],
    }),
    wait: () => ({ status: "done", answer: 5, text: "Done." }),
  });
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await expect(settled(turn)).resolves.toEqual({ ok: true });
  expect(
    host.processes[1]?.requests.map((request) => request.method).slice(0, 4),
  ).toEqual(["open", "unfinished", "drop", "deliver"]);
  expect(host.requests("drop")[0]?.params).toMatchObject({
    submissions: [{ submission: 41, conversation: 7 }],
  });
});

it.each(["mention", "standalone"] as const)(
  "takes on left runs again after a %s turn gave up on its run",
  async (kind) => {
    let waits = 0;
    const { host, deliver, settled, runOnce } = setup({
      // The first two hosts stop while it waits, and the turn gives up.
      wait: (_params, process) => {
        if (++waits <= 2) {
          queueMicrotask(() => process.exit(1, "Killed\n"));
          return new Promise(() => {});
        }
        return { status: "done", answer: 5, text: "Done." };
      },
    });
    if (kind === "mention") {
      const first = deliver({ type: "mention", event: reply("2", "@Pi look") });
      await first.run;
      await expect(settled(first)).resolves.toMatchObject({ ok: false });
    } else
      await expect(runOnce("chan", "check")).resolves.toMatchObject({
        ok: false,
      });
    expect(host.processes).toHaveLength(2);
    const next = deliver({ type: "mention", event: reply("3", "@Pi again") });
    await next.run;
    await expect(settled(next)).resolves.toEqual({ ok: true });
    const methods =
      host.processes[2]?.requests.map((item) => item.method) ?? [];
    expect(methods.indexOf("unfinished")).toBeGreaterThan(-1);
    expect(methods.indexOf("unfinished")).toBeLessThan(
      methods.indexOf("deliver"),
    );
  },
);

it("cancels a mention still being handed over when Interrupt is pressed", async () => {
  const placing = deferred<unknown>();
  let places = 0;
  const { host, deliver, settled, published, runtime } = setup({
    place: () => (++places === 1 ? placing.promise : { seen: 0 }),
    wait: () => ({ status: "done", answer: 5, text: "Done." }),
  });
  const agent = {
    key: self,
    pubkey: self,
    config: DEFAULT_CONFIG,
  } as unknown as Agent;
  const thread = { channelId: channel, root: root.id };
  const first = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await vi.waitFor(() => expect(host.requests("place")).toHaveLength(1));
  expect(runtime.sessionState(agent, thread)).toBe("active");
  const interrupting = runtime.session(agent, thread, "interrupt");
  placing.resolve({ seen: 0 });
  await first.run;
  await interrupting;
  await expect(settled(first)).resolves.toEqual({ ok: true });
  expect(host.requests("deliver")).toEqual([]);
  expect(published).toEqual([]);
  // A later mention is handed over as usual.
  const later = deliver({ type: "mention", event: reply("3", "@Pi again") });
  await later.run;
  await expect(settled(later)).resolves.toEqual({ ok: true });
  expect(host.requests("deliver")).toHaveLength(1);
});

it("hands over no queued mention of an agent removed while it waited", async () => {
  const first = deferred<object>();
  let delivers = 0;
  const { runtime, host, deliver, settled, published } = setup({
    deliver: () =>
      ++delivers === 1
        ? first.promise
        : { submission: 2, conversation: CONVERSATION },
  });
  const one = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await vi.waitFor(() => expect(host.requests("deliver")).toHaveLength(1));
  const two = deliver({ type: "mention", event: reply("3", "@Pi and this") });
  await two.run;
  runtime.sync([]);
  first.resolve({ submission: 1, conversation: CONVERSATION });
  await one.run;
  await expect(settled(two)).resolves.toEqual({ ok: true });
  expect(host.requests("deliver")).toHaveLength(1);
  expect(host.requests("open")).toHaveLength(1);
  expect(published).toEqual([]);
});

it("leaves a removed agent's turn in Pi's storage without a report", async () => {
  const closing = deferred();
  const { runtime, host, deliver, settled, published } = setup({
    // Closed, the agent is not open for the wait.
    wait: async () => {
      await closing.promise;
      throw new Error("The agent is not open");
    },
    close: () => closing.resolve(),
  });
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await vi.waitFor(() => expect(host.requests("wait")).toHaveLength(1));
  runtime.sync([]);
  await expect(settled(turn)).resolves.toEqual({ ok: true });
  expect(host.requests("close")[0]?.params).toEqual({ agent: self });
  expect(published).toEqual([]);
});

it("runs a standalone turn in a one-off conversation", async () => {
  const { host, runOnce, published } = setup({
    wait: () => ({ status: "done", answer: 5, text: "Nothing to report." }),
  });
  await expect(runOnce("timer/t1", "Run t1")).resolves.toEqual({ ok: true });
  const [once] = host.requests("once");
  expect(String(once?.params.request)).toMatch(/^timer\/t1\//);
  expect(once?.params.text).toBe("Run t1");
  expect(host.requests("deliver")).toEqual([]);
  // A wake's answer is for Pi alone; it acts with its tools.
  expect(published).toEqual([]);
});

it("starts no standalone turn once its prompt is no longer wanted", async () => {
  const { host, runOnce } = setup();
  await expect(runOnce("watch/w1", undefined)).resolves.toEqual({ ok: true });
  expect(host.requests("once")).toEqual([]);
});

it("stops a standalone turn's conversation when its signal aborts", async () => {
  const waiting = deferred<unknown>();
  const { host, runOnce } = setup({
    wait: () => waiting.promise,
    abort: () => {
      waiting.resolve({ status: "unanswered", reason: "aborted" });
      return {};
    },
  });
  const stop = new AbortController();
  const turn = runOnce("timer/t1", "Run t1", stop.signal);
  await vi.waitFor(() => expect(host.requests("wait")).toHaveLength(1));
  stop.abort();
  await expect(turn).resolves.toEqual({
    ok: false,
    error: "The turn was stopped",
  });
  expect(host.requests("abort")[0]?.params).toEqual({
    agent: self,
    conversation: 99,
  });
});

it("offers the provider's models with the thinking levels each supports", async () => {
  let defaults = { provider: "anthropic", model: "claude-x", thinking: "high" };
  const { runtime } = setup({
    defaults: () => defaults,
    models: () => [
      { id: "claude-x", name: "Claude X", thinking: ["off", "low", "high"] },
      { id: "claude-y", name: "Claude Y", thinking: ["off"] },
    ],
  });
  const agent = {
    key: self,
    pubkey: self,
    config: DEFAULT_CONFIG,
  } as Agent<Config>;
  await expect(runtime.models(agent)).resolves.toEqual({
    current: "claude-x",
    models: [
      {
        id: "claude-x",
        label: "Claude X",
        efforts: [
          { id: "off", label: "Off" },
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
        effort: "high",
      },
      {
        id: "claude-y",
        label: "Claude Y",
        efforts: [{ id: "off", label: "Off" }],
        effort: "off",
      },
    ],
  });
  // The agent's saved level is Pi's, or the nearest a model has.
  const saved = {
    key: self,
    pubkey: self,
    config: { ...DEFAULT_CONFIG, effort: "medium" },
  } as Agent<Config>;
  const efforts = (await runtime.models(saved)).models.map(
    (model) => model.effort,
  );
  expect(efforts).toEqual(["high", "off"]);
  // Pi's settings as they are now: the pi command changes them.
  defaults = { provider: "anthropic", model: "claude-y", thinking: "low" };
  await expect(runtime.models(agent)).resolves.toMatchObject({
    current: "claude-y",
    models: [{ effort: "low" }, { effort: "off" }],
  });
});

it("runs a turn at the agent's saved thinking level, apart from a pick", async () => {
  const { host, deliver } = setup();
  await deliver(
    { type: "mention", event: reply("2", "@Pi look") },
    { config: { ...DEFAULT_CONFIG, effort: "low" } },
  ).run;
  expect(host.requests("deliver")[0]?.params).toMatchObject({
    thinking: "low",
    pick: {},
  });
});

it.each([undefined, root.id])(
  "delivers an addressed subscription and reports its failure at the configured destination (root: %s)",
  async (destinationRoot) => {
    const { host, deliver, settled, published, runtime } = setup({
      wait: () => ({
        status: "unanswered",
        reason: "error",
        detail: "400 Bad model",
      }),
    });
    try {
      const receipt = deliver({
        type: "attention",
        channel,
        ...(destinationRoot ? { root: destinationRoot } : { topLevel: true }),
        id: "f".repeat(64),
        at: 200_000,
        text: "CI changed",
      });
      await receipt.run;
      expect(receipt.ignored).not.toHaveBeenCalled();
      await expect(settled(receipt)).resolves.toMatchObject({ ok: false });
      const delivered = host.requests("deliver")[0]?.params;
      expect(delivered?.context).toEqual(
        destinationRoot ? { channel, root: destinationRoot } : { channel },
      );
      expect(delivered?.text).not.toContain("<plugin-wake");
      expect(delivered?.text).toContain("CI changed");
      await vi.waitFor(() => expect(published).toHaveLength(1));
      expect(published[0]?.tags.filter((tag) => tag[0] === "e")).toEqual(
        destinationRoot ? [["e", destinationRoot, "", "reply"]] : [],
      );
      expect(JSON.stringify(published)).not.toContain("f".repeat(64));
    } finally {
      runtime.dispose();
    }
  },
);

it("persists a channel-scoped wake's reply thread separately from its tool context", async () => {
  const f = setup();
  try {
    await f.deliver(
      {
        type: "attention",
        channel,
        root: root.id,
        id: "f".repeat(64),
        at: 200_000,
        text: "CI changed",
      },
      { config: { ...DEFAULT_CONFIG, scope: "channel" } },
    ).run;
    expect(f.host.requests("deliver")[0]?.params).toMatchObject({
      key: channel,
      context: { channel },
      reply: { channel, root: root.id, topLevel: false },
    });
  } finally {
    f.runtime.dispose();
  }
});

it.each([false, true])(
  "recovers a wake at its saved destination (channel-level: %s)",
  async (topLevel) => {
    const f = setup({
      unfinished: () => ({
        submissions: [
          {
            submission: 41,
            conversation: 5,
            request: "f".repeat(64),
            context: { channel },
            reply: { channel, root: root.id, topLevel },
          },
        ],
      }),
      wait: ({ submission }) =>
        submission === 41
          ? { status: "unanswered", reason: "error", detail: "400 Bad model" }
          : new Promise(() => {}),
    });
    try {
      await f.deliver({ type: "mention", event: reply("2", "@Pi hi") }).run;
      await vi.waitFor(() => expect(f.published).toHaveLength(1));
      expect(f.published[0]?.tags.filter((tag) => tag[0] === "e")).toEqual(
        topLevel ? [] : [["e", root.id, "", "reply"]],
      );
    } finally {
      f.runtime.dispose();
    }
  },
);

it("starts no standalone source turn invalidated during core-memory loading", async () => {
  const f = setup({
    wait: () => ({ status: "done", answer: 5, text: "Stale" }),
  });
  const memory = deferred<string | null>();
  f.core.mockImplementationOnce(() => memory.promise);
  let valid = true;
  try {
    const running = f.runtime.runOnce({
      delivery: {
        agent: f.agent,
        config: DEFAULT_CONFIG,
        current: () => valid,
      },
      key: "source/build",
      signal: new AbortController().signal,
      prompt: async () => "Build finished",
    } as unknown as StandaloneTurn);
    await vi.waitFor(() => expect(f.core).toHaveBeenCalledTimes(1));
    valid = false;
    memory.resolve(null);
    await expect(running).resolves.toEqual({ ok: true });
    expect(f.host.requests("once")).toEqual([]);
  } finally {
    memory.resolve(null);
    f.runtime.dispose();
  }
});

it("keeps mention activity when a watch joins without presentation callbacks", async () => {
  const f = setup({
    deliver: (params, process) => {
      process.send({
        method: "event",
        params: {
          agent: self,
          conversation: CONVERSATION,
          type: "placed",
          request: params.request,
          entry: 1,
        },
      });
      return { submission: 1, conversation: CONVERSATION };
    },
  });
  try {
    const mention = f.deliver({
      type: "mention",
      event: reply("2", "@Pi work"),
    });
    await mention.run;
    await vi.waitFor(() => expect(mention.acknowledged).toHaveBeenCalled());
    const watch = f.deliver(
      {
        type: "attention",
        channel,
        root: root.id,
        id: "f".repeat(64),
        at: 200_000,
        text: "Update",
      },
      {},
      false,
    );
    await watch.run;
    await vi.waitFor(() => expect(f.host.requests("deliver")).toHaveLength(2));
    f.runtime.event({
      agent: self,
      conversation: CONVERSATION,
      type: "placed",
      request: "f".repeat(64),
      entry: 2,
    });
    f.runtime.event({
      agent: self,
      conversation: CONVERSATION,
      type: "step",
      tool: "read",
    });
    expect(mention.superseded).not.toHaveBeenCalled();
    expect(mention.step).toHaveBeenCalledWith("read", undefined);
  } finally {
    f.runtime.dispose();
  }
});

it("waits for a recovered threaded wake before changing the shared conversation to channel posting", async () => {
  const old = deferred<unknown>();
  const f = setup({
    unfinished: () => ({
      submissions: [
        {
          submission: 41,
          conversation: CONVERSATION,
          request: "e".repeat(64),
          context: { channel },
          reply: { channel, root: root.id, topLevel: false },
        },
      ],
    }),
    wait: ({ submission }) =>
      submission === 41
        ? old.promise
        : Promise.resolve({ status: "done", answer: 10, text: "New answer" }),
  });
  try {
    const next = f.deliver(
      {
        type: "attention",
        channel,
        topLevel: true,
        id: "f".repeat(64),
        at: 200_000,
        text: "Update",
      },
      { config: { ...DEFAULT_CONFIG, scope: "channel" } },
    );
    await vi.waitFor(() => expect(f.host.requests("wait")).toHaveLength(1));
    expect(f.host.requests("deliver")).toHaveLength(0);
    old.resolve({ status: "done", answer: 5, text: "Recovered answer" });
    await next.run;
    expect(f.host.requests("deliver")).toHaveLength(1);
  } finally {
    old.resolve({ status: "unanswered", reason: "aborted" });
    f.runtime.dispose();
  }
});

it("does not retry a subscription cancelled while Pi reopens", async () => {
  const reopening = deferred<unknown>();
  let current = true;
  const f = setup({
    open: () => (f.host.requests("open").length > 1 ? reopening.promise : {}),
    deliver: (_params, process) => {
      if (f.host.requests("deliver").length === 1) {
        queueMicrotask(() => process.exit(1, "Killed\n"));
        return new Promise(() => {});
      }
      return { submission: 1, conversation: CONVERSATION };
    },
    wait: () => ({ status: "done", answer: 5, text: "Cancelled work" }),
  });
  const turn = f.deliver(
    {
      type: "attention",
      channel,
      root: root.id,
      id: "f".repeat(64),
      at: 200_000,
      text: "subscription",
    },
    { current: () => current },
  );
  try {
    await vi.waitFor(() => expect(f.host.requests("open")).toHaveLength(2));
    current = false;
    reopening.resolve({});
    await turn.run;
    await expect(f.settled(turn)).resolves.toEqual({ ok: true });
    expect(f.host.requests("deliver")).toHaveLength(1);
    expect(f.published).toEqual([]);
  } finally {
    reopening.resolve({});
    f.runtime.dispose();
  }
});

it("refreshes Attention instructions after model preparation", async () => {
  const memory = deferred<string | null>();
  const f = setup();
  let instructions = "Old Interest instructions";
  const wakeText = vi.fn(async () => instructions);
  f.core.mockImplementationOnce(() => memory.promise);
  try {
    const receipt = f.deliver(
      {
        type: "attention",
        channel,
        root: root.id,
        id: "f".repeat(64),
        at: 200_000,
        text: instructions,
      },
      { wakeText },
    );
    await vi.waitFor(() => expect(f.core).toHaveBeenCalled());
    instructions = "Updated Interest instructions";
    memory.resolve(null);
    await receipt.run;
    expect(f.host.requests("deliver")[0]?.params.text).toContain(instructions);
    expect(f.host.requests("deliver")[0]?.params.text).not.toContain(
      "Old Interest instructions",
    );
  } finally {
    memory.resolve(null);
    f.runtime.dispose();
  }
});

it.each([true, false])(
  "refreshes or drops an Attention wake after the host queue (current: %s)",
  async (valid) => {
    const queued = deferred<void>();
    let instructions = "Old Interest instructions";
    let current = true;
    let refreshed: unknown;
    const f = setup({
      deliver: async (params, process) => {
        await queued.promise;
        if (params.refresh) {
          const answer = await process.tool(
            { agent: self, request: params.request },
            "prompt",
          );
          refreshed = answer.result;
          if (!answer.result) return false;
        }
        return { submission: 1, conversation: CONVERSATION };
      },
    });
    try {
      const receipt = f.deliver(
        {
          type: "attention",
          channel,
          root: root.id,
          id: "f".repeat(64),
          at: 200_000,
          text: instructions,
        },
        { wakeText: async () => instructions, current: () => current },
      );
      await vi.waitFor(() =>
        expect(f.host.requests("deliver")).toHaveLength(1),
      );
      instructions = "Updated Interest instructions";
      current = valid;
      queued.resolve();
      await receipt.run;
      if (valid) {
        expect(refreshed).toMatchObject({
          text: expect.stringContaining(instructions),
          steer: expect.stringContaining(instructions),
        });
        expect(JSON.stringify(refreshed)).not.toContain(
          "Old Interest instructions",
        );
      } else {
        expect(refreshed).toBe(false);
        await expect(f.settled(receipt)).resolves.toEqual({ ok: true });
        expect(f.published).toEqual([]);
      }
    } finally {
      queued.resolve();
      f.runtime.dispose();
    }
  },
);

it("keeps foreign-channel roots out of conversation context", async () => {
  const f = setup();
  f.session.read.mockResolvedValue([
    { ...root, tags: [["h", "another-channel"]], content: "Private root" },
  ]);
  await f.deliver({ type: "mention", event: reply("2", "@Pi look") }).run;
  expect(String(f.host.requests("deliver")[0]?.params.text)).toContain(
    "@Pi look",
  );
  expect(String(f.host.requests("deliver")[0]?.params.text)).not.toContain(
    "Private root",
  );
});

/** The owner's connection to the agent's community, as the relay has it: a
 * session whose channel list the community changes, replaced when the relay
 * reconnects. */
function relayFixture() {
  const session = () => {
    const listeners = new Set<() => void>();
    const unsubscribe = vi.fn();
    let channels = [{ id: channel, name: "general", channelType: "stream" }];
    return {
      channels: {
        list: () => ({ channels }),
        subscribeList: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            unsubscribe();
            listeners.delete(listener);
          };
        },
      },
      unsubscribe,
      /** Whether a channel-list listener is attached now. */
      listening: () => listeners.size > 0,
      /** The community made the channel private. */
      lock() {
        channels = [{ ...channels[0], private: true } as (typeof channels)[0]];
        for (const listener of listeners) listener();
      },
    };
  };
  const listeners = new Set<() => void>();
  let snapshot: { status: string; session: ReturnType<typeof session> } = {
    status: "connecting",
    session: session(),
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData;
  const runtime = new PiRuntime(
    { spawn: fakeHost().spawn },
    (key) => ownerReads(relay, pubkeyOf(key)),
    vi.fn(async () => null),
    undefined,
    undefined,
    undefined,
    undefined,
    (_key, listener) => relay.subscribe(listener),
  );
  return {
    runtime,
    session: () => snapshot.session,
    /** Whether anything follows the relay's snapshot. */
    followed: () => listeners.size > 0,
    /** The relay is ready with a new session. */
    connect() {
      snapshot = { status: "ready", session: session() };
      for (const listener of listeners) listener();
    },
    /** The relay's state changed without replacing its session. */
    tick() {
      for (const listener of listeners) listener();
    },
  };
}

it("tells of channel changes once the agent's community connects after Activity subscribed", () => {
  const relay = relayFixture();
  const changed = vi.fn();
  relay.runtime.subscribeChannels(self, changed);
  expect(relay.session().listening()).toBe(false);
  expect(relay.runtime.channelLabel(self, channel)).toBeUndefined();

  relay.connect();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(relay.session().listening()).toBe(true);
  expect(relay.runtime.channelLabel(self, channel)).toEqual({
    name: "general",
    channelType: "stream",
  });
  relay.session().lock();
  expect(changed).toHaveBeenCalledTimes(2);
  expect(relay.runtime.channelLabel(self, channel)).toMatchObject({
    private: true,
  });
});

it("follows the community's connection when the relay replaces its session", () => {
  const relay = relayFixture();
  relay.connect();
  const first = relay.session();
  const changed = vi.fn();
  relay.runtime.subscribeChannels(self, changed);
  relay.tick();
  expect(changed).not.toHaveBeenCalled();

  relay.connect();
  expect(first.unsubscribe).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledTimes(1);
  first.lock();
  expect(changed).toHaveBeenCalledTimes(1);
  relay.session().lock();
  expect(changed).toHaveBeenCalledTimes(2);
  expect(relay.runtime.channelLabel(self, channel)).toMatchObject({
    private: true,
  });
});

it("lets go of whichever channel-list listener it holds when Activity unsubscribes", () => {
  const relay = relayFixture();
  relay.connect();
  const changed = vi.fn();
  const stop = relay.runtime.subscribeChannels(self, changed);
  relay.connect();
  const current = relay.session();
  expect(current.listening()).toBe(true);

  stop();
  expect(current.unsubscribe).toHaveBeenCalledTimes(1);
  expect(current.listening()).toBe(false);
  expect(relay.followed()).toBe(false);
  current.lock();
  relay.connect();
  expect(changed).toHaveBeenCalledTimes(1);
});

it.each(["stop", "retire"])(
  "keeps a protected final answer local after %s",
  async (mode) => {
    const answered = deferred<unknown>();
    const check = vi.fn(async () => {});
    const f = setup({
      wait: () => answered.promise,
      abort: () => ({}),
      runtime: () => ({
        file: "/runtime/host.mjs",
        node: "/node/bin/node",
        codeRoot: "/runtime",
        nodeRoot: "/node",
        data: "/data",
        auth: "/auth",
      }),
    });
    let stop!: () => Promise<void>;
    const turn = f.deliver(
      { type: "mention", event: reply("2", "@Pi look") },
      {
        interruptible: (fn) => {
          stop = fn;
        },
      },
    );
    await turn.run;
    Object.assign(f.agent, {
      protection: {
        key: "test",
        stateKey: "test",
        processProtection: { readOnlyPaths: [], hiddenPaths: [] },
        assertAvailable() {},
        check,
      },
    });
    if (mode === "stop") await stop();
    else await f.runtime.retire(self);
    answered.resolve({
      status: "done",
      answer: 5,
      text: "The build is green.",
    });
    await f.settled(turn);
    expect(f.published).toEqual([]);
    expect(check).not.toHaveBeenCalled();
  },
);
