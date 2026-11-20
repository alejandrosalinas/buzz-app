// @vitest-environment jsdom
// The workflow wake against the real community lifecycle: provideRelay, its
// outer retry and its subscribers.
import { createLocalAgents } from "./local";
import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { subscribeRelayTraffic } from "../relay/live";
import { matchesEvent } from "../relay/projection";
import { provideRelay } from "../relay/service";
import type { ReadTransport } from "../relay/transport";
import { keypair, metadata, roster, signed, profile } from "../relay/testing";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { ownerReads, readyOwnerReads } from "./reads";
import { pubkeyOf } from "./membership";
import { localStore } from "./state";
import { AgentsService, type AgentCommunities, type Delivery } from "./service";
import { createLocalAgentActivity } from "./local-activity";
import { memoryStorage } from "./test-fakes";
import type { AgentsNative } from "./native";
import type { Host } from "../host/service";
import { ClaudeRuntime, config } from "../../bundled/claude-code/runtime";
import { claudeRun } from "../../bundled/claude-code/run";
import { fakeSpawn } from "../../bundled/claude-code/claude-testing";

vi.mock("@tauri-apps/api/core", async (actual) => ({
  ...(await actual<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(),
}));

class Socket {
  readyState = 1;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: (event?: unknown) => void;
  onerror?: () => void;
  sent: unknown[][] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
  }
  async receive(value: unknown) {
    await this.onmessage?.({ data: JSON.stringify(value) });
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fixture() {
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const channel = "5f0c6a2e-0000-4000-8000-000000000001",
    origin = "https://relay.test";
  const records = [
    metadata(relay, channel, "releases"),
    roster(relay, channel, [viewer.pubkey, agent.pubkey]),
    profile(agent, { name: "Scout", is_agent: true }),
  ];
  const sockets: Socket[] = [];
  /** Holds the next outer connect until released. */
  let connectGate: Promise<void> | undefined;
  const connect = async (): Promise<ReadTransport> => {
    await connectGate;
    return {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      archiveAuthority: relay.pubkey,
      scope: origin,
      media: () => undefined,
      query: async (filters: readonly ReadFilter[]) =>
        records.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
      subscribe(
        callbacks: Parameters<NonNullable<ReadTransport["subscribe"]>>[0],
      ) {
        return subscribeRelayTraffic(
          "wss://relay.test",
          async (t) => signed(viewer, t),
          viewer.pubkey,
          callbacks,
          () => {
            const socket = new Socket();
            sockets.push(socket);
            return socket as unknown as WebSocket;
          },
        );
      },
    } as unknown as ReadTransport;
  };
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const relayData = provideRelay(ctx, connect);
  const native = {
    list: async () => [
      {
        pubkey: agent.pubkey,
        name: "Scout",
        owner: viewer.pubkey,
        relay: "wss://relay.test",
        type: "test/claude",
        deleted: false,
      },
    ],
    query: vi.fn(async () => []),
    searchProfiles: vi.fn(async () => undefined),
    publishProfile: vi.fn(async () => {}),
    claim: vi.fn(async () => true),
    release: vi.fn(async () => {}),
    keepAwake: vi.fn(async () => {}),
    publish: vi.fn(async (_key: string, event: RelayEvent) => event),
  } as unknown as AgentsNative;
  const local = createLocalAgentActivity();
  const identities = createLocalAgents();
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
  const claude = fakeSpawn();
  /** The connection each workflow mention was checked through. */
  const acquired: unknown[] = [];
  /** A workflow mention started waiting for its community. */
  const waiting = vi.fn();
  /** The type's run settled. */
  const ran = vi.fn();
  const prompts = () =>
    claude.processes
      .flatMap((p) => p.prompts)
      .filter((text) => text.includes("Check the release notes.")).length;
  const runtime = new ClaudeRuntime(
    { spawn: claude.spawn } as unknown as Pick<Host, "spawn">,
    (key) => ownerReads(relayData, pubkeyOf(key)),
    async () => null,
    localStore(memoryStorage() as unknown as Storage),
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (handle, signal) => {
      waiting();
      const reads = await readyOwnerReads(relayData, handle, signal);
      acquired.push(reads?.connection);
      return reads;
    },
  );
  /** Holds Claude setup (claude-code/run.ts `ready`) until released. */
  let setupGate: Promise<void> | undefined;
  const setupEntered = vi.fn();
  const type = claudeRun(runtime, async () => {
    setupEntered();
    await setupGate;
  });
  const ignored = vi.fn();
  const failed = vi.fn();
  ctx.extend({ pluginOwner: { id: "test", revision: "one" } }).agents.register({
    id: "claude",
    title: "Claude",
    defaults: () => ({ config: {} }),
    ...type,
    run: async (delivery: Delivery) => {
      try {
        await type.run?.({
          ...delivery,
          ignored: (reason?: unknown) => {
            ignored(reason);
            return delivery.ignored?.(reason as never);
          },
        } as never);
      } catch (error) {
        failed(String(error));
        throw error;
      } finally {
        ran();
      }
    },
  } as never);
  const wake = signed(relay, {
    kind: 9,
    content: "@Scout Check the release notes.",
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", viewer.pubkey, "", "owner"],
      ["h", channel],
      ["buzz:workflow", "true"],
      ["buzz:workflow-owner", viewer.pubkey],
      ["p", agent.pubkey],
      ["buzz:workflow-mention", agent.pubkey],
    ],
  });
  const answered = new Set<unknown>();
  /** Authenticates the newest socket and ends each new REQ's replay. */
  const establish = async () => {
    await vi.waitFor(() => expect(sockets.at(-1)).toBeDefined(), {
      timeout: 10_000,
    });
    const socket = sockets.at(-1) as Socket;
    await socket.receive(["AUTH", "challenge"]);
    const auth = [...socket.sent]
      .reverse()
      .find((e) => e[0] === "AUTH")?.[1] as RelayEvent;
    await socket.receive(["OK", auth.id, true]);
    await sleep(1_000);
    for (const req of socket.sent.filter((e) => e[0] === "REQ")) {
      if (answered.has(req)) continue;
      answered.add(req);
      await socket.receive(["EOSE", req[1]]);
    }
    await sleep(100);
  };
  return {
    relayData,
    service,
    claude,
    ignored,
    failed,
    waiting,
    ran,
    setupEntered,
    holdSetup() {
      let release!: () => void;
      setupGate = new Promise<void>((r) => {
        release = r;
      });
      return release;
    },
    holdConnect() {
      let release!: () => void;
      connectGate = new Promise<void>((r) => {
        release = r;
      });
      return release;
    },
    async ready() {
      await vi.waitFor(
        () => expect(relayData.snapshot().status).toBe("ready"),
        { timeout: 10_000 },
      );
      await vi.waitFor(() => expect(service.snapshot().status).toBe("ready"));
      await establish();
    },
    /** The relay sends the wake on the newest socket's matching routes. */
    async sendWake() {
      const socket = sockets.at(-1) as Socket;
      let matched = 0;
      for (const req of socket.sent.filter((e) => e[0] === "REQ"))
        if ((req.slice(2) as ReadFilter[]).some((f) => matchesEvent(wake, f))) {
          matched++;
          await socket.receive(["EVENT", req[1], wake]);
        }
      return matched;
    },
    acquired,
    prompts,
    async dispose() {
      runtime.dispose();
      await ctx.fiber.dispose();
    },
  };
}

it("a wake whose community resets during Claude setup starts once through the replacement session", async () => {
  const f = await fixture();
  try {
    await f.ready();
    const first = f.relayData.snapshot().session;
    const releaseSetup = f.holdSetup();
    expect(await f.sendWake()).toBeGreaterThan(0);
    // Dispatched while ready; now held in Claude setup.
    await vi.waitFor(() => expect(f.setupEntered).toHaveBeenCalledOnce());
    const releaseConnect = f.holdConnect();
    f.relayData.retry();
    expect(f.relayData.snapshot().status).toBe("connecting");
    releaseSetup();
    // It waits for the community instead of refusing.
    await vi.waitFor(() => expect(f.waiting).toHaveBeenCalledOnce());
    expect(f.acquired).toEqual([]);
    expect(f.ran).not.toHaveBeenCalled();
    expect(f.ignored).not.toHaveBeenCalled();
    expect(f.prompts()).toBe(0);
    releaseConnect();
    await f.ready();
    await vi.waitFor(() => expect(f.prompts()).toBe(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(f.ran).toHaveBeenCalledOnce());
    expect(f.prompts()).toBe(1);
    expect(f.ignored).not.toHaveBeenCalled();
    expect(f.failed).not.toHaveBeenCalled();
    expect(f.acquired).toEqual([f.relayData.snapshot().session]);
    expect(f.acquired[0]).not.toBe(first);
  } finally {
    await f.dispose();
  }
}, 30_000);
