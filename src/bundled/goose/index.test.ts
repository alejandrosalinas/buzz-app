// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { AgentType } from "../../features/agents/service";
import { GooseRuntime } from "./runtime";
import { GooseSetup } from "./setup";
import { apply } from "./index";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
afterEach(() => vi.restoreAllMocks());

it("observes saved conversations with the status of open sessions", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  vi.spyOn(GooseRuntime.prototype, "conversations").mockReturnValue([
    { key: "room/r", at: 3, sessions: [] },
    { key: "dm", at: 2, sessions: [] },
    { key: "old", at: 1, sessions: [] },
  ]);
  vi.spyOn(GooseRuntime.prototype, "sessions").mockReturnValue([
    { key: "room/r", busy: true, sessionId: "s1", at: 3 },
    { key: "dm", busy: false, sessionId: "s2", at: 2 },
    // Open, though saving it failed.
    { key: "new", busy: true, sessionId: "s3", at: 4 },
    // A one-off turn joins no conversation.
    { key: "timer/x #1", busy: true },
  ]);
  let type: AgentType | undefined;
  apply({
    pluginOwner: { id: "buzz.goose", revision: "r1" },
    host: { request: vi.fn() },
    agentProtection: { registerModels: vi.fn() },
    agents: {
      register: (registered: AgentType) => {
        type = registered;
      },
      relay: () => undefined,
    },
    effect: vi.fn(),
  } as never);
  // A reload stops its turns, so the owner is asked to resume them.
  expect(type?.resumes).toBe(true);
  expect(
    type?.importShared?.({
      runtime: "goose",
      provider: "databricks_v2",
      model: "shared-model",
    }),
  ).toMatchObject({ provider: "databricks_v2", model: "shared-model" });
  expect(
    type?.importShared?.({ runtime: "buzz-agent", model: "shared-model" }),
  ).toBeUndefined();
  expect(
    type?.exportShared?.({ provider: "databricks_v2", model: "shared-model" }),
  ).toEqual({
    runtime: "goose",
    provider: "databricks_v2",
    model: "shared-model",
  });
  expect(type?.sessions?.list("a".repeat(64))).toEqual([
    { channelId: "new", at: 4, status: "Working" },
    { channelId: "room", root: "r", at: 3, status: "Working" },
    { channelId: "dm", at: 2, status: "Idle" },
    // A conversation whose session closed is unobserved, not idle.
    { channelId: "old", at: 1 },
  ]);
});

it("lists the models of the providers that answer when another's list fails", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  vi.spyOn(GooseSetup.prototype, "providers").mockResolvedValue({
    providers: [
      { id: "openai", name: "OpenAI", configured: true },
      { id: "broken", name: "Broken", configured: true },
      { id: "unset", name: "Unset", configured: false },
    ],
  } as unknown as Awaited<ReturnType<GooseSetup["providers"]>>);
  vi.spyOn(GooseSetup.prototype, "models").mockImplementation(async (id) => {
    if (id === "broken") throw new Error("provider is down");
    return [{ id: "gpt-5", label: "GPT-5" }] as Awaited<
      ReturnType<GooseSetup["models"]>
    >;
  });
  const registerModels = vi.fn();
  apply({
    pluginOwner: { id: "buzz.goose", revision: "r1" },
    host: { request: vi.fn() },
    agentProtection: { registerModels },
    agents: { register: vi.fn(), relay: () => undefined },
    effect: vi.fn(),
  } as never);
  const [registered] = registerModels.mock.calls[0] as [
    { models(): Promise<unknown> },
  ];
  await expect(registered.models()).resolves.toEqual([
    { provider: "openai", id: "gpt-5", label: "OpenAI · GPT-5" },
  ]);
});

it("lists no review models for the providers Goose reviews refuse", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  vi.spyOn(GooseSetup.prototype, "providers").mockResolvedValue({
    providers: ["openai", "github_copilot", "codex", "cursor-agent"].map(
      (id) => ({ id, name: id, configured: true }),
    ),
  } as unknown as Awaited<ReturnType<GooseSetup["providers"]>>);
  vi.spyOn(GooseSetup.prototype, "models").mockResolvedValue([
    { id: "model", label: "Model" },
  ] as Awaited<ReturnType<GooseSetup["models"]>>);
  const registerModels = vi.fn();
  apply({
    pluginOwner: { id: "buzz.goose", revision: "r1" },
    host: { request: vi.fn() },
    agentProtection: { registerModels },
    agents: { register: vi.fn(), relay: () => undefined },
    effect: vi.fn(),
  } as never);
  const [registered] = registerModels.mock.calls[0] as [
    { models(): Promise<unknown> },
  ];
  await expect(registered.models()).resolves.toEqual([
    { provider: "openai", id: "model", label: "openai · Model" },
  ]);
});

it("links a failed turn's refused key to Goose's own Agent setup, quoting goose", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  // The runtime the plugin made, as its sessions list reads it.
  let runtime: GooseRuntime | undefined;
  vi.spyOn(GooseRuntime.prototype, "conversations").mockImplementation(
    function (this: GooseRuntime) {
      runtime = this;
      return [];
    },
  );
  vi.spyOn(GooseRuntime.prototype, "sessions").mockReturnValue([]);
  let type: AgentType | undefined;
  apply({
    pluginOwner: { id: "buzz.goose", revision: "r1" },
    host: { request: vi.fn() },
    agentProtection: { registerModels: vi.fn() },
    agents: {
      register: (registered: AgentType) => {
        type = registered;
      },
      relay: () => undefined,
    },
    effect: vi.fn(),
  } as never);
  type?.sessions?.list("a".repeat(64));
  expect(runtime?.explain("Authentication required")).toBe(
    "Goose's provider rejected its API key or sign-in. Head to [Settings](buzz://settings?section=agents&provider=buzz.goose%2Fgoose) to check its provider.\n\ngoose said:\n> Authentication required",
  );
});

it("recommends a candidate only on a set-up provider whose live list has its model", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  vi.spyOn(GooseSetup.prototype, "providers").mockResolvedValue({
    providers: [
      { id: "provider-a", name: "A", configured: true },
      { id: "broken", name: "Broken", configured: true },
      { id: "unset", name: "Unset", configured: false },
    ],
  } as unknown as Awaited<ReturnType<GooseSetup["providers"]>>);
  const models = vi
    .spyOn(GooseSetup.prototype, "models")
    .mockImplementation(async (id) => {
      if (id === "broken") throw new Error("discovery failed");
      return [{ id: "model-a", label: "model-a" }] as Awaited<
        ReturnType<GooseSetup["models"]>
      >;
    });
  vi.spyOn(GooseSetup.prototype, "efforts").mockResolvedValue({
    current: "low",
    levels: ["low", "high"],
  });
  let type: AgentType | undefined;
  apply({
    pluginOwner: { id: "buzz.goose", revision: "r1" },
    host: { request: vi.fn() },
    agentProtection: { registerModels: vi.fn() },
    agents: {
      register: (registered: AgentType) => {
        type = registered;
      },
      relay: () => undefined,
    },
    effect: vi.fn(),
  } as never);
  const candidate = (provider: string, model: string, effort = "high") => ({
    harness: "goose",
    provider,
    model,
    effort,
    label: "Model A",
  });
  await expect(
    type?.recommends?.(candidate("provider-a", "model-a")),
  ).resolves.toBe(true);
  // The model is offered, but not on the candidate's thinking level, which
  // goose would refuse each turn.
  await expect(
    type?.recommends?.(candidate("provider-a", "model-a", "max")),
  ).resolves.toBe(false);
  // The provider is ready but doesn't offer the model.
  await expect(
    type?.recommends?.(candidate("provider-a", "model-z")),
  ).resolves.toBe(false);
  // Discovery fails; the pick treats a rejection as not ready.
  await expect(
    type?.recommends?.(candidate("broken", "model-a")),
  ).rejects.toThrow("discovery failed");
  // A provider not set up is never asked for its models.
  models.mockClear();
  await expect(type?.recommends?.(candidate("unset", "model-a"))).resolves.toBe(
    false,
  );
  expect(models).not.toHaveBeenCalled();
});
