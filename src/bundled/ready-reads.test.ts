// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { RelayData } from "../features/relay/service";
import { apply as claude } from "./claude-code/index";
import { apply as codex } from "./codex/index";
import { apply as pi } from "./pi/index";

/** The runtimes each plugin made, as it built them. */
const built = vi.hoisted(() => [] as object[]);
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("./claude-code/runtime", async (actual) => {
  const real = await actual<typeof import("./claude-code/runtime")>();
  class ClaudeRuntime extends real.ClaudeRuntime {
    constructor(...args: ConstructorParameters<typeof real.ClaudeRuntime>) {
      super(...args);
      built.push(this);
    }
  }
  return { ...real, ClaudeRuntime };
});
vi.mock("./codex/runtime", async (actual) => {
  const real = await actual<typeof import("./codex/runtime")>();
  class CodexRuntime extends real.CodexRuntime {
    constructor(...args: ConstructorParameters<typeof real.CodexRuntime>) {
      super(...args);
      built.push(this);
    }
  }
  return { ...real, CodexRuntime };
});
vi.mock("./pi/runtime", async (actual) => {
  const real = await actual<typeof import("./pi/runtime")>();
  class PiRuntime extends real.PiRuntime {
    constructor(...args: ConstructorParameters<typeof real.PiRuntime>) {
      super(...args);
      built.push(this);
    }
  }
  return { ...real, PiRuntime };
});
afterEach(() => {
  built.length = 0;
  localStorage.clear();
  vi.restoreAllMocks();
});

const owner = "a".repeat(64);
const pubkey = "b".repeat(64);
/** An agent of another community, so its membership key is not its pubkey. */
const agent = {
  key: `${pubkey}@relay.example`,
  pubkey,
  owner,
  relay: "wss://relay.example",
};
const session = {
  workflowAuthority: "c".repeat(64),
  channels: {
    list: () => ({
      status: "ready",
      channels: [{ id: "dm", channelType: "dm" }],
    }),
    subscribeList: () => () => {},
  },
};
/** The agent's community, connecting until the test makes it ready. */
function community() {
  let snapshot: object = { status: "connecting", generation: 1 };
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  } as unknown as RelayData;
  return {
    relay,
    ready() {
      snapshot = {
        status: "ready",
        generation: 2,
        origin: "https://relay.example",
        viewer: owner,
        scope: `https://relay.example:${owner}`,
        session,
      };
      for (const listener of [...listeners]) listener();
    },
  };
}

it.each([
  ["Claude", claude],
  ["Codex", codex],
  ["Pi", pi],
])(
  "gives %s's runtime the agent's community reads once ready",
  async (_name, apply) => {
    const c = community();
    const communities = vi.fn((key: string) =>
      key === agent.key ? c.relay : undefined,
    );
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    apply({
      settingsCards: { register: vi.fn() },
      agentProtection: { registerModels: vi.fn() },
      pluginOwner: { id: "buzz.test", revision: "r1" },
      host: { spawn: vi.fn(), readFile: vi.fn(), request: vi.fn() },
      agents: {
        register: vi.fn(),
        relay: communities,
        execution: async () => undefined,
        inspectExecution: async () => undefined,
        executionBinding: () => undefined,
        snapshot: () => ({ status: "ready", agents: [], running: [] }),
        subscribe: () => () => {},
      },
      effect: vi.fn(),
    } as never);
    expect(built).toHaveLength(1);
    const { readyReads } = built[0] as {
      readyReads?: (
        agent: unknown,
        signal: AbortSignal,
        channelId: string | undefined,
      ) => Promise<{ connection: unknown } | undefined>;
    };
    const settled = vi.fn();
    const reads = readyReads?.(agent, new AbortController().signal, "dm");
    void reads?.then(settled, settled);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A community still connecting holds the reads back.
    expect(settled).not.toHaveBeenCalled();
    c.ready();
    expect((await reads)?.connection).toBe(session);
    expect(communities).toHaveBeenCalledWith(agent.key);
  },
);
