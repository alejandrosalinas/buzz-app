// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SettingsCardsService } from "../../features/settings/service";
import type { AgentType } from "../../features/agents/service";
import { ClaudeRuntime } from "./runtime";
import { apply, inject } from "./index";
import { ClaudeAuth } from "./auth";
import { ClaudeSetup } from "./setup";

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
    root.provide("navigation", { open: vi.fn() } as never);
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
      await fiber.dispose();
      expect(cards.snapshot()).toEqual([]);
    } finally {
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
