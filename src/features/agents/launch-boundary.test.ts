// The launch boundary: a mention goes through the real agents service, its
// runner and the start resolver into each real runtime, over a real relay
// session. The config the runtime actually uses comes from confirmed synced
// copies, the delivery carries their revision IDs, and the transport under
// the session sees no request at start beyond a turn's conversation reads,
// online or offline.
import { Context } from "@deepseek-ai/cordis";
import { finalizeEvent } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import type { Host, HostProcessOptions } from "../host/service";
import type { ReadFilter, RelayEvent } from "../relay/events";
import type { LiveCallbacks } from "../relay/live";
import type { RelayData } from "../relay/service";
import { createRelaySession } from "../relay/session";
import { keypair, message, metadata, profile, roster } from "../relay/testing";
import { AgentConfigStore, type Subject } from "./agent-config";
import { artifactD, readHead } from "./agent-config-artifacts";
import type { Mode } from "./agent-start";
import { createLocalAgentActivity } from "./local-activity";
import { type AgentReads, ownerReads } from "./reads";
import {
  type AgentCommunities,
  AgentsService,
  type AgentType,
  type ConfigBinding,
  type Delivery,
} from "./service";
import { fakeNative } from "./service-testing";
import { memoryStorage } from "./test-fakes";
import type { AgentStore } from "./store";
import { claudeRun } from "../../bundled/claude-code/run";
import { ClaudeRuntime } from "../../bundled/claude-code/runtime";
import { fakeSpawn as fakeClaude } from "../../bundled/claude-code/claude-testing";
import { codexRun } from "../../bundled/codex/run";
import { CodexRuntime } from "../../bundled/codex/runtime";
import type { Wire } from "../../bundled/codex/rpc";
import { gooseRun } from "../../bundled/goose/run";
import { GooseRuntime } from "../../bundled/goose/runtime";
import { fakeSpawn as fakeGoose } from "../../bundled/goose/goose-testing";

const owner = keypair();
const relayKey = keypair();
const agentKey = keypair();
const artifactKey = keypair();
const origin = "https://relay.example.test";
const channel = "0b8e2a3c-1d4f-4a5b-8c6d-7e8f9a0b1c2d";
const configChannel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const base = {
  owner: owner.pubkey,
  community: origin,
  subject: agentKey.pubkey,
  channel: configChannel,
};
const settingsSubject: Subject = { ...base, type: "buzz.agent.settings" };
const instructionsSubject: Subject = {
  ...base,
  type: "buzz.agent.instructions",
};

const revision = (body: object | null, op = "create") =>
  finalizeEvent(
    {
      kind: 45010,
      created_at: 1,
      content: body === null ? "" : JSON.stringify({ version: 1, ...body }),
      tags: [
        ["op", op],
        ["h", configChannel],
      ],
    },
    artifactKey.secret,
  ) as RelayEvent;

/** Confirmed copies in this device's storage, as a sync read installs them. */
function seed(storage: AgentStore, heads: [Subject, RelayEvent][]) {
  const store = new AgentConfigStore(storage);
  for (const [subject, head] of heads)
    store.applyRead(subject, store.capture(subject), {
      kind: "head",
      event: head,
    });
}

/** One request the transport saw: a read's filters, or an encrypted memory
 * listing (a request of its own, never a config read). */
type Request = {
  filters: readonly ReadFilter[];
  memory?: { agent: string; slug: string | undefined };
  failed: boolean;
  /** Whether every mention sent so far had finished when it was made. */
  afterRuns: boolean;
};

/** The one read a Codex turn makes of its conversation (§4.3): the mention
 * and its thread's replies, messages and their edits, in its channel, up to
 * the mention. */
const conversationRead = (sent: RelayEvent): readonly ReadFilter[] => {
  const window = { kinds: [40002, 9], "#h": [channel], until: sent.created_at };
  return [
    { ...window, ids: [sent.id], limit: 1 },
    { ...window, "#e": [sent.id], limit: 50 },
  ];
};

/** A transport that answers from `records`, recording every request it sees.
 * While `offline`, every request fails as an unreachable relay's does. */
function countedTransport(records: RelayEvent[]) {
  const requests: Request[] = [];
  const state = { offline: false, afterRuns: () => false };
  let live!: LiveCallbacks;
  const transport = {
    viewer: owner.pubkey,
    relayAuthor: relayKey.pubkey,
    scope: origin,
    media: () => undefined,
    async query(filters: readonly ReadFilter[]) {
      const request = {
        filters,
        failed: state.offline,
        afterRuns: state.afterRuns(),
      };
      requests.push(request);
      if (state.offline) throw new Error("Relay unreachable");
      return records.filter((event) =>
        filters.some((filter) => filter.kinds?.includes(event.kind)),
      );
    },
    async readAgentMemories(agent: string, _: AbortSignal, slug?: string) {
      requests.push({
        filters: [],
        memory: { agent, slug },
        failed: state.offline,
        afterRuns: state.afterRuns(),
      });
      if (state.offline) throw new Error("Relay unreachable");
      return { entries: [], partial: false };
    },
    subscribe(callbacks: LiveCallbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  };
  return { transport, requests, state, live: () => live };
}

const disposals: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Listing the agent in its community is not under test here.
vi.mock("./relay-removal", async (actual) => ({
  ...(await actual<typeof import("./relay-removal")>()),
  publishAgentRecord: vi.fn(async () => {}),
}));

async function setup<Config>(
  typeId: string,
  runs: (
    relay: (pubkey: string) => RelayData | undefined,
    reads: (pubkey: string) => AgentReads | undefined,
    core: AgentsService["core"],
  ) => Pick<
    AgentType<Config>,
    "run" | "runOnce" | "timeoutMs" | "syncedSettings"
  >,
  defaults: Config,
  heads: [Subject, RelayEvent][],
  binding: ConfigBinding,
  initialMessages: RelayEvent[] = [],
) {
  const storage = memoryStorage();
  seed(storage, heads);
  const counted = countedTransport([
    metadata(relayKey, channel, "general"),
    roster(relayKey, channel, [owner.pubkey, agentKey.pubkey]),
    profile(owner, { name: "Owner" }),
    profile(agentKey, { name: typeId, is_agent: true }),
    ...heads.map(([, head]) => head),
    ...initialMessages,
  ]);
  const session = createRelaySession(counted.transport);
  disposals.push(() => session.dispose());
  const relayData = {
    snapshot: () => ({
      status: "ready",
      generation: 1,
      session: session.session,
      scope: `${origin}:${owner.pubkey}`,
      origin,
      viewer: owner.pubkey,
    }),
    subscribe: () => () => {},
  } as unknown as RelayData;
  const communities = {
    snapshot: () => ({
      viewer: owner.pubkey,
      selected: origin,
      memberships: [{ id: origin, name: "Test" }],
    }),
    subscribe: () => () => {},
    open: () => relayData,
  } as unknown as AgentCommunities;
  const native = fakeNative([
    {
      pubkey: agentKey.pubkey,
      name: typeId,
      owner: owner.pubkey,
      relay: "wss://relay.example.test",
      type: `buzz/${typeId}`,
      deleted: false,
    },
  ]);
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const activity = createLocalAgentActivity();
  /** Each start's binding lookup: one per start attempt. */
  const attempts = vi.fn(() => binding);
  const service = new AgentsService(
    ctx,
    communities,
    native,
    storage,
    undefined,
    activity,
    undefined,
    attempts,
  );
  disposals.push(() => ctx.fiber.dispose());
  const plugin = ctx.extend({
    pluginOwner: Object.freeze({ id: "buzz", revision: "one" }),
  });
  const deliveries: Delivery<Config>[] = [];
  const real = runs(
    (pubkey) => service.relay(pubkey),
    (pubkey) => ownerReads(service.relay(pubkey), pubkey),
    (pubkey, signal) => service.core(pubkey, signal),
  );
  plugin.agents.register<Config>({
    id: typeId,
    title: typeId,
    defaults: () => ({ config: defaults }),
    ...real,
    run: (delivery) => {
      deliveries.push(delivery);
      return real.run?.(delivery);
    },
  });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("ready"));
  // Settle every cache a start may consult before counting begins.
  session.session.channels.ensureList();
  counted.live().state({ status: "connected", routes: [] });
  await vi.waitFor(() =>
    expect(service.snapshot().agents.map((agent) => agent.pubkey)).toContain(
      agentKey.pubkey,
    ),
  );
  // Discovery lists the channel only once it has applied its access change,
  // which would cancel reads still in flight.
  await vi.waitFor(() =>
    expect(session.session.channels.list()).toMatchObject({
      status: "ready",
      channels: [expect.objectContaining({ id: channel })],
    }),
  );
  await session.session.profiles.ensure([owner.pubkey, agentKey.pubkey]);
  await service.core(agentKey.pubkey);
  counted.requests.length = 0;
  let at = Math.floor(Date.now() / 1000);
  let mentions = 0;
  counted.state.afterRuns = () =>
    activity.reader
      .work()
      .filter((work) => !["waiting", "working"].includes(work.state)).length ===
    mentions;
  /** A new top-level mention from the owner: a new conversation. */
  const mention = (root?: string) => {
    mentions++;
    const sent = message(owner, channel, "@agent hello", ++at, [
      ["p", agentKey.pubkey],
      ...(root ? [["e", root, "", "reply"]] : []),
    ]);
    counted.live().receive([sent], { phase: "live", channelId: channel });
    return sent;
  };
  return {
    service,
    native,
    plugin,
    session: session.session,
    requests: counted.requests,
    transport: counted.state,
    deliveries,
    activity,
    attempts,
    mention,
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

/** The runner's refresh of the agent's `core` memory once its work has
 * ended, for a later start that never waits on it (`runner.ts` `release`). */
const postRunCoreRefresh = (request: Request) =>
  request.afterRuns &&
  request.memory?.agent === agentKey.pubkey &&
  request.memory.slug === "core";

/** A Claude Code start's read of one of the agent's recent notes, by slug
 * (`recentNotesSection`). */
const recentNotesRead = (request: Request) =>
  request.memory?.agent === agentKey.pubkey &&
  /^mem\/notes\/\d{4}-\d{2}-\d{2}$/.test(request.memory.slug ?? "");

/** Apart from the post-run core refresh, and with `notes` a start's recent
 * notes reads, the recorded requests are exactly one conversation read for
 * each of `conversations`, in order: an extra, a wider or a different read
 * fails. */
function expectOnlyAllowed(
  f: Fixture,
  conversations: readonly RelayEvent[] = [],
  notes = false,
) {
  expect(
    f.requests
      .filter(
        (request) =>
          !postRunCoreRefresh(request) && !(notes && recentNotesRead(request)),
      )
      .map((request) => request.filters),
  ).toEqual(conversations.map(conversationRead));
}

const synced = (mode: Mode = "synced") => ({
  settings: { mode, subject: settingsSubject },
  instructions: { mode, subject: instructionsSubject },
});

/** Synced copies for `agentType`: these settings, and instructions. */
function heads(agentType: string, settings: Record<string, string>) {
  const s = revision({ agentType, settings });
  const i = revision({ text: "SYNCED INSTRUCTIONS" });
  return {
    revisions: [s.id, i.id],
    seeded: [
      [settingsSubject, s],
      [instructionsSubject, i],
    ] as [Subject, RelayEvent][],
  };
}

/** The same counter records a real config sync read once the relay is back. */
async function expectCounterSeesSync(f: Fixture) {
  f.transport.offline = false;
  f.requests.length = 0;
  const read = f.session.snapshotRead;
  if (!read) throw new Error("snapshotRead unavailable");
  await readHead(
    read,
    configChannel,
    await artifactD("buzz.agent.settings", configChannel),
  );
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.filters[0]).toMatchObject({
    kinds: [45010],
    "#h": [configChannel],
  });
}

it("starts Claude sessions from the synced copies, with no relay request but recent notes online or offline", async () => {
  const claude = fakeClaude();
  const host = { spawn: claude.spawn, request: vi.fn() } as unknown as Host;
  const { revisions, seeded } = heads("buzz/claude-code", {
    model: "synced-model",
    scope: "thread",
  });
  const f = await setup(
    "claude-code",
    (_relay, reads, core) =>
      claudeRun(new ClaudeRuntime(host, reads, core, memoryStorage())),
    {
      model: "local-model",
      effort: "",
      instructions: "LOCAL INSTRUCTIONS",
      workspace: "/this/device",
      scope: "thread",
    },
    seeded,
    synced(),
  );
  const prompted = (index: number) =>
    vi.waitFor(() =>
      expect(JSON.stringify(claude.processes[index]?.received)).toContain(
        "SYNCED INSTRUCTIONS",
      ),
    );
  f.mention();
  await prompted(0);
  const [first] = claude.processes;
  expect(first?.model).toBe("synced-model");
  expect(first?.options.cwd).toBe("/this/device");
  expect(JSON.stringify(first?.received)).not.toContain("LOCAL INSTRUCTIONS");
  expect(f.deliveries[0]?.revisions).toEqual(revisions);
  expectOnlyAllowed(f, [], true);

  // The relay goes away; the next conversation starts from the same copies.
  f.transport.offline = true;
  f.mention();
  await prompted(1);
  expect(claude.processes[1]?.model).toBe("synced-model");
  expect(JSON.stringify(claude.processes[1]?.received)).not.toContain(
    "LOCAL INSTRUCTIONS",
  );
  expect(f.deliveries[1]?.revisions).toEqual(revisions);
  expectOnlyAllowed(f, [], true);
  await expectCounterSeesSync(f);
});

/** A Codex app server that answers what a thread and a turn need. */
function fakeCodex() {
  const sent: Wire[] = [];
  let options: HostProcessOptions | undefined;
  const emit = (value: Wire) =>
    options?.onStdout?.(`${JSON.stringify(value)}\n`);
  const process = {
    write: async (data: string) => {
      const request: Wire = JSON.parse(data);
      sent.push(request);
      if (request.id == null || !request.method) return;
      const params = request.params as Record<string, unknown>;
      const result =
        request.method === "thread/start"
          ? { thread: { id: `thread-${sent.length}`, cwd: params.cwd } }
          : request.method === "turn/start"
            ? { turn: { id: `turn-${sent.length}` } }
            : request.method === "model/list"
              ? {
                  data: ["local-model", "synced-model"].map((model) => ({
                    model,
                    displayName: model,
                    isDefault: model === "local-model",
                    defaultReasoningEffort: "low",
                    supportedReasoningEfforts: ["low", "high"].map(
                      (reasoningEffort) => ({
                        reasoningEffort,
                        description: "",
                      }),
                    ),
                  })),
                  nextCursor: null,
                }
              : request.method === "config/read"
                ? { config: {} }
                : {};
      emit({ id: request.id, result });
      // Each turn finishes at once, so the next conversation can start.
      if (request.method === "turn/start")
        emit({
          method: "turn/completed",
          params: {
            threadId: params.threadId,
            turn: { ...(result as { turn: object }).turn, status: "completed" },
          },
        });
    },
    end: async () => {},
    kill: async () => {},
    exited: new Promise<number | null>(() => {}),
  };
  const spawn = async (id: string, value?: HostProcessOptions) => {
    if (id === "workspace") {
      value?.onStdout?.(`${value.cwd ?? ""}\n`);
      return { ...process, exited: Promise.resolve(0) };
    }
    options = value;
    return process;
  };
  return { spawn, sent };
}

it("starts a Codex thread and a turn from the synced copies; offline, only its conversation reads fail", async () => {
  const codex = fakeCodex();
  const { revisions, seeded } = heads("buzz/codex", {
    model: "synced-model",
    effort: "high",
    scope: "thread",
  });
  const f = await setup(
    "codex",
    (_relay, reads, core) =>
      codexRun(new CodexRuntime(codex.spawn, reads, core, memoryStorage())),
    {
      model: "local-model",
      effort: "low",
      instructions: "LOCAL INSTRUCTIONS",
      workspace: "/this/device",
      scope: "thread",
    },
    seeded,
    synced(),
  );
  const starts = (method: string) =>
    codex.sent.filter((wire) => wire.method === method);
  const outcome = (id: string) =>
    f.activity.reader.work().find((work) => work.messageId === id);
  f.plugin.agents.registerSessionRouter({
    id: "tasks",
    ready: async () => {},
    matches: () => true,
    prepare: async (input) => ({
      association: { task: input.source.root ?? "channel" },
    }),
  });
  const first = f.mention();
  await vi.waitFor(() => expect(outcome(first.id)?.state).toBe("done"));
  expect(outcome(first.id)?.session).toMatchObject({
    router: "buzz/tasks",
    association: { task: first.id },
  });
  const [thread] = starts("thread/start");
  expect(thread?.params).toMatchObject({
    model: "synced-model",
    cwd: "/this/device",
  });
  const sentToCodex = JSON.stringify(codex.sent);
  expect(sentToCodex).toContain("SYNCED INSTRUCTIONS");
  expect(sentToCodex).not.toContain("LOCAL INSTRUCTIONS");
  expect(starts("turn/start")).toHaveLength(1);
  expect(starts("turn/start")[0]?.params).toMatchObject({ effort: "high" });
  expect(f.deliveries[0]?.revisions).toEqual(revisions);
  expectOnlyAllowed(f, [first]);

  // Offline until the second mention ends: the thread still opens from the
  // copies, and the turn fails on its conversation reads alone (§4.3).
  f.transport.offline = true;
  f.requests.length = 0;
  const second = f.mention();
  await vi.waitFor(() => expect(outcome(second.id)?.state).toBe("error"));
  expect(outcome(second.id)?.error).toBe("Relay unreachable");
  expect(starts("thread/start")).toHaveLength(2);
  expect(starts("thread/start")[1]?.params).toMatchObject({
    model: "synced-model",
    cwd: "/this/device",
  });
  expect(starts("turn/start")).toHaveLength(1);
  expect(f.deliveries[1]?.revisions).toEqual(revisions);
  // Until the run ended, the turn's conversation read was all it asked, and
  // it failed.
  expectOnlyAllowed(f, [second]);
  expect(
    f.requests.filter((request) => !postRunCoreRefresh(request)),
  ).toMatchObject([{ failed: true }]);
  await expectCounterSeesSync(f);
});

const GOOSE_LOCAL = {
  model: "local-model",
  provider: "local-provider",
  effort: "",
  instructions: "LOCAL INSTRUCTIONS",
  workspace: "/this/device",
  scope: "thread" as const,
};

function gooseHost() {
  const goose = fakeGoose({
    providers: [
      { providerId: "synced-provider", models: [{ modelId: "synced-model" }] },
    ],
    supported: ["synced-model"],
  });
  const host = {
    spawn: goose.spawn,
    resolveDirectory: goose.resolveDirectory,
    readFile: vi.fn(),
    serveMcp: goose.serve,
  } as unknown as Host;
  return { goose, host };
}

it("starts Goose sessions from the synced copies, with no relay request online or offline", async () => {
  const { goose, host } = gooseHost();
  const { revisions, seeded } = heads("buzz/goose", {
    model: "synced-model",
    provider: "synced-provider",
    scope: "thread",
  });
  const f = await setup(
    "goose",
    (relay, _reads, core) => gooseRun(new GooseRuntime(host, relay, core)),
    { ...GOOSE_LOCAL },
    seeded,
    synced(),
  );
  f.mention();
  const process = () => goose.geese[0];
  await vi.waitFor(() => expect(process()?.turns).toHaveLength(1));
  const used = () => JSON.stringify([process()?.opened, process()?.configured]);
  expect(used()).toContain("synced-model");
  expect(used()).toContain("synced-provider");
  expect(used()).not.toContain("local-model");
  expect(process()?.opened[0]).toMatchObject({ cwd: "/this/device" });
  const prompts = () =>
    JSON.stringify([...(process()?.prompts.values() ?? [])]);
  expect(prompts()).toContain("SYNCED INSTRUCTIONS");
  expect(prompts()).not.toContain("LOCAL INSTRUCTIONS");
  expect(f.deliveries[0]?.revisions).toEqual(revisions);
  expectOnlyAllowed(f);

  f.transport.offline = true;
  f.mention();
  await vi.waitFor(() => expect(process()?.turns).toHaveLength(2));
  expect(process()?.opened).toHaveLength(2);
  expect(f.deliveries[1]?.revisions).toEqual(revisions);
  expectOnlyAllowed(f);
  await expectCounterSeesSync(f);
});

it("refuses to start from deleted synced settings once: no launch, the reason on the mention, no retry", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { goose, host } = gooseHost();
  const deleted = revision(null, "delete");
  const { seeded } = heads("buzz/goose", { model: "synced-model" });
  const f = await setup(
    "goose",
    (relay, _reads, core) => gooseRun(new GooseRuntime(host, relay, core)),
    { ...GOOSE_LOCAL },
    [[settingsSubject, deleted], seeded[1] as [Subject, RelayEvent]],
    synced(),
  );
  f.attempts.mockClear();
  const sent = f.mention();
  const work = () =>
    f.activity.reader.work().filter((item) => item.messageId === sent.id);
  await vi.waitFor(() => expect(work()[0]?.state).toBe("error"));
  expect(work()).toEqual([
    expect.objectContaining({
      state: "error",
      error: "Settings were deleted — restore from History",
    }),
  ]);
  // Past the service's next tick, which runs whatever is still queued.
  await vi.advanceTimersByTimeAsync(6_000);
  expect(f.attempts).toHaveBeenCalledTimes(1);
  expect(work()).toHaveLength(1);
  expect(f.deliveries).toEqual([]);
  expect(goose.geese).toEqual([]);
  expectOnlyAllowed(f);
});

it.each([
  {
    name: "Claude",
    start: async (effort: string) => {
      const claude = fakeClaude();
      const host = { spawn: claude.spawn, request: vi.fn() } as unknown as Host;
      const { seeded } = heads("buzz/claude-code", {
        model: "haiku",
        effort,
        scope: "thread",
      });
      const f = await setup(
        "claude-code",
        (_relay, reads, core) =>
          claudeRun(new ClaudeRuntime(host, reads, core, memoryStorage())),
        { ...GOOSE_LOCAL, model: "haiku", effort: "low" },
        seeded,
        synced(),
      );
      return {
        f,
        prompted: () =>
          claude.processes.reduce((sum, item) => sum + item.prompts.length, 0),
      };
    },
  },
  {
    name: "Codex",
    start: async (effort: string) => {
      const codex = fakeCodex();
      const { seeded } = heads("buzz/codex", {
        model: "synced-model",
        effort,
        scope: "thread",
      });
      const f = await setup(
        "codex",
        (_relay, reads, core) =>
          codexRun(new CodexRuntime(codex.spawn, reads, core, memoryStorage())),
        { ...GOOSE_LOCAL, model: "local-model", effort: "low" },
        seeded,
        synced(),
      );
      return {
        f,
        prompted: () =>
          codex.sent.filter((wire) => wire.method === "turn/start").length,
      };
    },
  },
  {
    name: "goose",
    start: async (effort: string) => {
      const { goose, host } = gooseHost();
      const { seeded } = heads("buzz/goose", {
        model: "synced-model",
        provider: "synced-provider",
        effort,
        scope: "thread",
      });
      const f = await setup(
        "goose",
        (relay, _reads, core) => gooseRun(new GooseRuntime(host, relay, core)),
        { ...GOOSE_LOCAL },
        seeded,
        synced(),
      );
      return {
        f,
        prompted: () =>
          goose.geese.reduce((sum, item) => sum + item.turns.length, 0),
      };
    },
  },
])(
  "refuses $name a synced effort its model lacks, with the reason on the mention",
  async ({ start }) => {
    const { f, prompted } = await start("max");
    const sent = f.mention();
    const work = () =>
      f.activity.reader.work().find((item) => item.messageId === sent.id);
    await vi.waitFor(() => expect(work()?.state).toBe("error"));
    expect(work()?.error).toContain('synced effort "max"');
    expect(f.deliveries[0]?.synced).toMatchObject({ effort: "max" });
    expect(prompted()).toBe(0);
  },
);

it("keeps an addressed Attention wake when a session association declines", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const codex = fakeCodex();
  const root = message(owner, channel, "Task root", 999);
  const { seeded } = heads("buzz/codex", {
    model: "synced-model",
    effort: "high",
    scope: "channel",
  });
  const f = await setup(
    "codex",
    (_relay, reads, core) =>
      codexRun(new CodexRuntime(codex.spawn, reads, core, memoryStorage())),
    {
      model: "local-model",
      effort: "low",
      instructions: "",
      workspace: "/this/device",
      scope: "channel",
    },
    seeded,
    synced(),
    [root],
  );
  f.native.query.mockResolvedValue([root]);
  f.plugin.agents.controlAttention();
  const prepare = vi.fn(async () => undefined);
  f.plugin.agents.registerSessionRouter({
    id: "decline",
    ready: async () => {},
    matches: () => true,
    prepare,
  });
  await f.service.save(agentKey.pubkey, {
    attentionEnabled: true,
    attention: {
      "interest/task": { type: "interest", instructions: "Check the task" },
      "watch/tick": {
        type: "timer",
        interest_id: "task",
        prompt: "Check",
        enabled: true,
        interval_secs: 60,
        armed_at: 1_000,
        max_occurrences: 1,
        expires_at: null,
        channel,
        root: root.id,
      },
    },
  });
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() =>
    expect(
      codex.sent.filter((wire) => wire.method === "turn/start"),
    ).toHaveLength(1),
  );
  expect(prepare).toHaveBeenCalledOnce();
  expect(f.deliveries.map((delivery) => delivery.trigger.type)).toEqual([
    "attention",
  ]);
});

it.each(["thread", "channel"] as const)(
  "resets the association with the native %s session",
  async (scope) => {
    const codex = fakeCodex();
    const { seeded } = heads("buzz/codex", {
      model: "synced-model",
      effort: "high",
      scope,
    });
    const f = await setup(
      "codex",
      (_relay, reads, core) =>
        codexRun(new CodexRuntime(codex.spawn, reads, core, memoryStorage())),
      {
        model: "local-model",
        effort: "low",
        instructions: "",
        workspace: "/this/device",
        scope,
      },
      seeded,
      synced(),
    );
    f.plugin.agents.registerSessionRouter({
      id: "tasks",
      ready: async () => {},
      matches: () => true,
      prepare: async (input) => ({
        association: input.association ?? { task: input.sessionKey },
      }),
    });
    const first = f.mention();
    const work = () =>
      f.activity.reader.work().find((row) => row.messageId === first.id);
    await vi.waitFor(() => expect(work()?.state).toBe("done"));
    const prior = work()?.session?.sessionKey;
    const agent = f.service.find(agentKey.pubkey);
    if (!agent) throw new Error("Expected the local agent");
    const place = { channelId: channel, root: first.id };
    await vi.waitFor(() =>
      expect(f.service.sessionState(agent.key, place)).toBe("idle"),
    );
    await f.service.session(agent.key, place, "new");
    const next = f.mention(first.id);
    await vi.waitFor(() =>
      expect(
        f.activity.reader.work().find((row) => row.messageId === next.id)
          ?.state,
      ).toBe("done"),
    );
    const current = f.activity.reader
      .work()
      .find((row) => row.messageId === next.id)?.session?.sessionKey;
    expect(current).toBeTruthy();
    expect(current).not.toBe(prior);
    expect(
      codex.sent.filter((wire) => wire.method === "thread/start"),
    ).toHaveLength(2);
  },
);
