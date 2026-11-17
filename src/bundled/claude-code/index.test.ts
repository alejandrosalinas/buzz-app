// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SettingsCardsService } from "../../features/settings/service";
import type { AgentType } from "../../features/agents/service";
import { ClaudeRuntime } from "./runtime";
import { apply, inject } from "./index";
import { ClaudeAuth } from "./auth";
import { ClaudeSetup } from "./setup";
import type { ReactElement, FunctionComponent, ComponentProps } from "react";
import type { SettingsCard } from "../../features/settings/service";
import type { PageNavigation } from "../../features/navigation/service";
import { createNavigationController } from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import type { ClaudeConnection } from "./ClaudeSettings";
import { ClaudeDefaults } from "./defaults";
import { recommendedRun } from "../../features/agents/recommended";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
afterEach(() => vi.restoreAllMocks());

it.each([true, false])(
  "contributes auth-owned settings only when supplied (settings=%s)",
  async (settings) => {
    if (!settings)
      vi.spyOn(ClaudeAuth.prototype, "Settings", "get").mockReturnValue(
        undefined,
      );
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const root = new Context();
    root.provide("pluginStatus", {
      isActive: () => true,
      subscribe: () => () => {},
    });
    root.provide("agents", {
      register: vi.fn(),
      relay: () => undefined,
    } as never);
    root.provide("host", { request: vi.fn() } as never);
    root.provide("agentProtection", { registerModels: vi.fn() } as never);
    const controller = createNavigationController(createMemoryHistory());
    const navigation = controller.navigation;
    root.provide("navigation", navigation);
    const cards = new SettingsCardsService(root);
    const scope = root.extend({
      pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    });
    const fiber = scope.plugin({ apply, inject });
    try {
      await fiber.await();
      expect(cards.snapshot()).toMatchObject(
        settings
          ? [
              {
                key: "buzz.claude-code/credentials",
                title: "Claude",
                group: "Plugins",
              },
            ]
          : [],
      );
      if (settings) {
        const parent = {
          version: 1,
          kind: "settings",
          section: "buzz.claude-code/credentials",
          scope: null,
        } as const;
        const Card = cards.snapshot()[0]?.component as FunctionComponent<
          ComponentProps<SettingsCard["component"]>
        >;
        const presentation = () => {
          const { entry, attempt } = navigation.snapshot();
          controller.complete(attempt, { status: "opened" });
          const page = {
            target: entry.target,
            signal: attempt.signal,
          } as PageNavigation;
          return (
            Card({ active: () => true, navigation: page }) as ReactElement<{
              connection: ClaudeConnection;
            }>
          ).props.connection;
        };
        void navigation.open(parent);
        presentation().onOpenChange(true);
        expect(navigation.snapshot().entry.target).toEqual({
          ...parent,
          route: { version: 1, params: "connect" },
        });
        expect(presentation().open).toBe(true);
        navigation.back();
        expect(presentation().open).toBe(false);
        navigation.forward();
        expect(presentation().open).toBe(true);
        presentation().onOpenChange(false);
        expect(navigation.snapshot().entry.target).toEqual(parent);
        expect(navigation.snapshot().canGoForward).toBe(false);
      }
      await fiber.dispose();
      expect(cards.snapshot()).toEqual([]);
    } finally {
      controller.dispose();
      await root.fiber.dispose();
    }
  },
);

it("observes saved sessions with the live status of running ones", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const agent = "a".repeat(64);
  vi.spyOn(ClaudeRuntime.prototype, "conversations").mockReturnValue([
    {
      key: "room/r",
      agent,
      sessionId: "s1",
      channelId: "room",
      root: "r",
      at: 3,
    },
    { key: "dm", agent, sessionId: "s2", channelId: "dm", at: 2 },
    { key: "old", agent, sessionId: "s3", channelId: "old", at: 1 },
  ]);
  vi.spyOn(ClaudeRuntime.prototype, "sessions").mockReturnValue([
    { key: "room/r", busy: true },
    { key: "dm", busy: false },
  ]);
  let type: AgentType | undefined;
  apply({
    settingsCards: { register: vi.fn() },
    agentProtection: { registerModels: vi.fn() },
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    host: { request: vi.fn() },
    agents: {
      register: (registered: AgentType) => {
        type = registered;
      },
      relay: () => undefined,
    },
    effect: vi.fn(),
  } as never);
  expect(type?.sessions?.list(agent)).toEqual([
    { channelId: "room", root: "r", at: 3, status: "Working" },
    { channelId: "dm", at: 2, status: "Idle" },
    // A conversation with no running process is unobserved, not idle.
    { channelId: "old", at: 1 },
  ]);
});

it("shares a Claude agent's model as the claude runtime and imports it back", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  let type: AgentType | undefined;
  apply({
    settingsCards: { register: vi.fn() },
    agentProtection: { registerModels: vi.fn() },
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    host: { request: vi.fn() },
    agents: {
      register: (registered: AgentType) => {
        type = registered;
      },
      relay: () => undefined,
    },
    effect: vi.fn(),
  } as never);
  const shared = type?.exportShared?.({ model: "opus", workspace: "/private" });
  expect(shared).toEqual({ runtime: "claude", model: "opus" });
  expect(type?.importShared?.(shared ?? { model: "" })).toMatchObject({
    model: "opus",
    workspace: "~/.buzz",
  });
  expect(
    type?.importShared?.({ runtime: "goose", model: "opus" }),
  ).toBeUndefined();
});

it("registers review models from the discovered catalog", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.spyOn(ClaudeSetup.prototype, "catalog").mockResolvedValue([
    { value: "opus", displayName: "Opus" },
    { value: "haiku" },
  ] as never);
  const registerModels = vi.fn();
  apply({
    settingsCards: { register: vi.fn() },
    agentProtection: { registerModels },
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    host: { request: vi.fn() },
    agents: { register: vi.fn(), relay: () => undefined },
    effect: vi.fn(),
  } as never);
  await expect(registerModels.mock.calls[0]?.[0].models()).resolves.toEqual([
    { id: "opus", label: "Opus" },
    { id: "haiku", label: "haiku" },
  ]);
});

it.each([true, false])(
  "links failed turns to the available auth setup (settings=%s)",
  async (keySettings) => {
    if (!keySettings)
      vi.spyOn(ClaudeAuth.prototype, "Settings", "get").mockReturnValue(
        undefined,
      );
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    // The runtime the plugin made, as its sessions list reads it.
    let runtime: ClaudeRuntime | undefined;
    vi.spyOn(ClaudeRuntime.prototype, "conversations").mockImplementation(
      function (this: ClaudeRuntime) {
        runtime = this;
        return [];
      },
    );
    vi.spyOn(ClaudeRuntime.prototype, "sessions").mockReturnValue([]);
    let type: AgentType | undefined;
    apply({
      settingsCards: { register: vi.fn() },
      agentProtection: { registerModels: vi.fn() },
      pluginOwner: { id: "buzz.claude-code", revision: "r1" },
      host: { request: vi.fn() },
      agents: {
        register: (registered: AgentType) => {
          type = registered;
        },
        relay: () => undefined,
      },
      effect: vi.fn(),
    } as never);
    type?.sessions?.list("a".repeat(64));
    const settings = keySettings
      ? "buzz://settings?section=buzz.claude-code%2Fcredentials"
      : "buzz://settings?section=agents&provider=buzz.claude-code%2Fclaude-code";
    const missing = await new ClaudeAuth(undefined)
      .authorize(async () => {
        throw new Error("unreachable");
      }, true)("claude")
      .then(
        () => "",
        (error: unknown) => String(error),
      );
    // Buzz refused to start Claude: there are no words of Claude's to quote.
    expect(runtime?.explain(missing)).toBe(
      `Claude is missing an API key. Head to [Settings](${settings}) to add one.`,
    );
    expect(runtime?.explain("Invalid API key · Fix external API key")).toBe(
      `Anthropic rejected Claude's API key. It may have been revoked or run out of credit. Head to [Settings](${settings}) to replace it.\n\nClaude said:\n> Invalid API key · Fix external API key`,
    );
    expect(runtime?.explain("Error: overloaded")).toBe("Error: overloaded");
  },
);

it("recommends a candidate only when Claude is signed in and lists its model and level", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  let ready = true;
  // As a check of the installed Claude reports its sign-in.
  vi.spyOn(ClaudeSetup.prototype, "check").mockImplementation(
    async function (this: { state: object }) {
      this.state = {
        ...this.state,
        status: { state: ready ? "ready" : "signed-out" },
      };
    },
  );
  vi.spyOn(ClaudeSetup.prototype, "catalog").mockResolvedValue([
    // An alias resolves to the pinned model a candidate may name.
    {
      value: "opus",
      resolvedModel: "model-a",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
    },
    { value: "model-b" },
  ] as never);
  let type: AgentType | undefined;
  apply({
    settingsCards: { register: vi.fn() },
    agentProtection: { registerModels: vi.fn() },
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    host: { request: vi.fn() },
    agents: {
      register: (registered: AgentType) => {
        type = registered;
      },
      relay: () => undefined,
    },
    effect: vi.fn(),
  } as never);
  const candidate = (model: string, effort = "high") => ({
    harness: "claude-code",
    model,
    effort,
    label: "Model A",
  });
  await expect(type?.recommends?.(candidate("model-a"))).resolves.toBe(true);
  await expect(type?.recommends?.(candidate("opus"))).resolves.toBe(true);
  // A model without levels takes none; one with them needs the candidate's.
  await expect(type?.recommends?.(candidate("model-b"))).resolves.toBe(true);
  await expect(type?.recommends?.(candidate("model-a", "max"))).resolves.toBe(
    false,
  );
  await expect(type?.recommends?.(candidate("model-z"))).resolves.toBe(false);
  // Signed out: a fresh setup's check says so, and nothing is listed.
  ready = false;
  const signedOut = new ClaudeSetup(vi.fn() as never);
  await expect(signedOut.offers(candidate("model-a"))).resolves.toBe(false);
});

it("runs an agent on Recommended on the candidate, else on the device default", async () => {
  vi.stubEnv(
    "VITE_BUZZ_RECOMMENDED_AGENT",
    JSON.stringify([
      { harness: "claude-code", model: "model-a", effort: "high", label: "A" },
    ]),
  );
  try {
    const data = new Map<string, string>();
    const storage = {
      keys: () => [...data.keys()],
      get: (key: string) => data.get(key) ?? null,
      read: async (key: string) => data.get(key) ?? null,
      scan: async (prefix: string) =>
        Object.fromEntries([...data].filter(([key]) => key.startsWith(prefix))),
      set: async (key: string, value: string | null) => {
        if (value === null) data.delete(key);
        else data.set(key, value);
      },
      add: async (_key: string, value: string) => value,
    };
    let offered = true;
    const run = recommendedRun("claude-code", async () => offered);
    const defaults = new ClaudeDefaults(storage, run);
    await defaults.save({ model: "model-d", effort: "low" });
    const saved = { preset: "recommended", instructions: "Be brief." };
    // Until found it inherits the device default, as a blank agent does.
    expect(defaults.resolve(saved).model).toBe("model-d");
    // The runtime, which resolved it before the finding, is told to again.
    const changed = vi.fn();
    defaults.subscribe(changed);
    await run.find();
    expect(changed).toHaveBeenCalled();
    expect(defaults.resolve(saved)).toMatchObject({
      model: "model-a",
      effort: "high",
    });
    // Off Recommended, its own settings are untouched.
    expect(defaults.resolve({ model: "own" }).model).toBe("own");
    offered = false;
    const none = recommendedRun("claude-code", async () => offered);
    await none.find();
    expect(new ClaudeDefaults(storage, none).resolve(saved).model).toBe(
      "model-d",
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

it("finds what an agent on Recommended runs on before its first run here", async () => {
  vi.stubEnv(
    "VITE_BUZZ_RECOMMENDED_AGENT",
    JSON.stringify([
      { harness: "claude-code", model: "model-a", effort: "high", label: "A" },
    ]),
  );
  try {
    const offered = vi.fn(async () => true);
    const run = recommendedRun("claude-code", offered);
    const data = new Map<string, string>();
    const defaults = new ClaudeDefaults(
      {
        keys: () => [...data.keys()],
        get: (key: string) => data.get(key) ?? null,
        read: async (key: string) => data.get(key) ?? null,
        scan: async () => ({}),
        set: async () => {},
        add: async (_key: string, value: string) => value,
      },
      run,
    );
    // Off Recommended it asks nothing.
    await defaults.follow({ model: "own" });
    expect(offered).not.toHaveBeenCalled();
    const saved = { preset: "recommended" };
    await defaults.follow(saved);
    expect(defaults.resolve(saved)).toMatchObject({
      model: "model-a",
      effort: "high",
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
