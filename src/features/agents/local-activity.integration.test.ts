import { createLocalAgents } from "./local";
import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import type { LiveCallbacks } from "../relay/live";
import type { RelayData } from "../relay/service";
import { keypair, metadata, roster, message, profile } from "../relay/testing";
import { AgentsService, type AgentCommunities } from "./service";
import { createLocalAgentActivity, type WorkOutcome } from "./local-activity";
import { memoryStorage } from "./test-fakes";
import type { AgentsNative } from "./native";
import { threadWorkingAgents } from "./thread-working";
import { messageActivity } from "../../bundled/agent-activity/message-activity";
import { workingAgents } from "../../bundled/channels/working-agents";

it("carries a verified mention through host handover into all three scopes without observer events", async () => {
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const channel = "channel",
    origin = "https://relay.test",
    scope = `${origin}:${viewer.pubkey}`;
  const local = createLocalAgentActivity();
  const identities = createLocalAgents();
  let live!: LiveCallbacks;
  const records = [
    metadata(relay, channel, "Channel"),
    roster(relay, channel, [viewer.pubkey, agent.pubkey]),
    profile(agent, { name: "Local tester", is_agent: true }),
  ];
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: origin,
      media: () => undefined,
      query: async (filters) =>
        records.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { localAgents: local.reader, agentChoices: identities.agents },
  );
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const relayData = {
    snapshot: () => ({
      status: "ready",
      generation: 1,
      session: owner.session,
      scope,
      origin,
      viewer: viewer.pubkey,
    }),
    subscribe: () => () => {},
  } as unknown as RelayData;
  const native: AgentsNative = {
    list: async () => [
      {
        pubkey: agent.pubkey,
        name: "Local tester",
        owner: viewer.pubkey,
        relay: "wss://relay.test",
        type: "test/type",
        deleted: false,
      },
    ],
    portable: vi.fn(),
    beginDelete: vi.fn(),
    port: vi.fn(),
    setPicture: vi.fn(),
    setType: vi.fn(),
    join: vi.fn(),
    beginLeave: vi.fn(),
    media: vi.fn(),
    gitAuth: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    holdRemoval: vi.fn(),
    releaseRemoval: vi.fn(),
    remove: vi.fn(),
    forget: vi.fn(),
    publish: vi.fn(),
    query: vi.fn(async () => []),
    effectiveEdit: vi.fn(),
    searchProfiles: vi.fn(async () => undefined),
    upload: vi.fn(),
    remember: vi.fn(),
    publishProfile: vi.fn(async () => {}),
    claim: vi.fn(async () => true),
    release: vi.fn(async () => {}),
    keepAwake: vi.fn(async () => {}),
  };
  const service = new AgentsService(
    ctx,
    {
      snapshot: () => ({
        viewer: viewer.pubkey,
        selected: origin,
        memberships: [{ id: origin, name: "Test" }],
      }),
      subscribe: () => () => {},
      open: () => relayData,
    } as unknown as AgentCommunities,
    native,
    memoryStorage(),
    undefined,
    local,
  );
  identities.bind({
    snapshot: service.local,
    subscribe: service.subscribe,
    refresh: () => service.refresh(),
  });
  const plugin = ctx.extend({ pluginOwner: { id: "test", revision: "one" } });
  let finish!: (outcome: WorkOutcome) => void;
  const done = new Promise<WorkOutcome>((resolve) => {
    finish = resolve;
  });
  const run = vi.fn((delivery) => {
    delivery.workingUntil(done);
  });
  plugin.agents.register({
    id: "type",
    title: "Test",
    defaults: () => ({ config: {} }),
    run,
  });
  try {
    await vi.waitFor(() => expect(service.snapshot().status).toBe("ready"));
    await owner.session.channels.ensureList();
    live.state({ status: "connected", routes: [] });
    const root = message(
      viewer,
      channel,
      "Request",
      Math.floor(Date.now() / 1000),
      [["p", agent.pubkey]],
    );
    live.receive([root], { phase: "live", channelId: channel });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const snapshot = owner.session.agentActivity.snapshot;
    expect(
      owner.session.agentChoices.snapshot().identities.map((row) => row.pubkey),
    ).toContain(agent.pubkey);
    expect(workingAgents(snapshot(), channel)).toEqual([agent.pubkey]);
    expect(threadWorkingAgents(snapshot(), [], channel, root.id)).toEqual([
      agent.pubkey,
    ]);
    expect(messageActivity(snapshot(), channel, root.id)[0]?.state).toBe(
      "working",
    );
    expect(snapshot().records).toEqual([]);
    const followup = message(
      viewer,
      channel,
      "Follow-up",
      Math.floor(Date.now() / 1000),
      [
        ["e", root.id, "", "root"],
        ["e", root.id, "", "reply"],
        ["p", agent.pubkey],
      ],
    );
    live.receive([followup], { phase: "live", channelId: channel });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(messageActivity(snapshot(), channel, root.id)).toHaveLength(1);
    expect(messageActivity(snapshot(), channel, followup.id)).toHaveLength(1);
    const first = run.mock.calls[0]?.[0];
    const second = run.mock.calls[1]?.[0];
    // A harness acknowledgment changes presentation only; execution still waits
    // for its own outcome. The same agent stays working in this thread/channel.
    // The harness's stopper lands on the request's own row, and goes with it
    // once a newer message supersedes that request.
    const stopFirst = vi.fn(async () => {});
    const stopSecond = vi.fn(async () => {});
    first.interruptible(stopFirst);
    second.interruptible(stopSecond);
    const stoppable = (id: string) =>
      snapshot().local?.find((work) => work.messageId === id)?.stoppable;
    expect(stoppable(root.id)).toBe(true);
    expect(stoppable(followup.id)).toBe(true);
    expect(
      messageActivity(snapshot(), channel, followup.id)[0]?.stoppable,
    ).toBe(true);
    first.superseded();
    expect(stoppable(root.id)).toBeUndefined();
    await owner.session.agentActivity.interrupt(agent.pubkey, channel, root.id);
    expect(stopFirst).not.toHaveBeenCalled();
    expect(stopSecond).not.toHaveBeenCalled();
    expect(stoppable(followup.id)).toBe(true);
    second.acknowledged();
    second.step("Read", "notes.txt");
    expect(messageActivity(snapshot(), channel, root.id)).toEqual([]);
    expect(messageActivity(snapshot(), channel, followup.id)[0]?.step).toEqual({
      tool: "Read",
      target: "notes.txt",
    });
    expect(workingAgents(snapshot(), channel)).toEqual([agent.pubkey]);
    expect(threadWorkingAgents(snapshot(), [], channel, root.id)).toEqual([
      agent.pubkey,
    ]);
    // Late steps/outcomes on the old request cannot bring its bubble back.
    first.step("Edit", "old.txt");
    expect(messageActivity(snapshot(), channel, root.id)).toEqual([]);
    expect(
      snapshot().local?.find((work) => work.messageId === root.id),
    ).toMatchObject({ state: "superseded" });
    finish({ ok: false, error: "Provider unavailable" });
    await vi.waitFor(() =>
      expect(messageActivity(snapshot(), channel, followup.id)[0]?.state).toBe(
        "error",
      ),
    );
    expect(workingAgents(snapshot(), channel)).toEqual([]);
    expect(threadWorkingAgents(snapshot(), [], channel, root.id)).toEqual([]);
    expect(snapshot().records).toEqual([]);
  } finally {
    finish({ ok: true });
    await ctx.fiber.dispose();
    owner.dispose();
  }
});
