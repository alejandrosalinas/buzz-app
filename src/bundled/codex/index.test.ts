import type { AgentExecutionBinding } from "../../features/agents/execution";
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentType } from "../../features/agents/service";
import { CodexLogoIcon } from "../../shared/design-system/icons";
import { CodexRuntime } from "./runtime";
import { CodexSetup } from "./setup";
import { CodexProvider } from "./tabs";
import { apply } from "./index";
import { apply as applyClaude } from "../claude-code/index";
import { apply as applyGoose } from "../goose/index";
import { apply as applyPi } from "../pi/index";

const desktop = vi.hoisted(() => ({ tauri: true }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => desktop.tauri }));

beforeEach(() => {
  desktop.tauri = true;
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
});
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

/** Applies the plugin to a stand-in context and returns the registered type. */
function applied(binding?: AgentExecutionBinding, applyType = apply) {
  let type: AgentType | undefined;
  const subscribe = () => () => undefined;
  const ctx = {
    agentProtection: { registerModels: vi.fn() },
    settingsCards: { register: vi.fn() },
    pluginOwner: { id: "buzz.codex", revision: "r1" },
    host: { spawn: vi.fn(), readFile: vi.fn(), request: vi.fn() },
    agents: {
      executionBinding: () => binding,
      inspectExecution: async () => binding,
      execution: async () => undefined,
      register: (registered: AgentType) => {
        type = registered;
      },
      snapshot: () => ({ status: "ready", agents: [], running: [] }),
      relay: () => undefined,
      subscribe,
    },
    effect: vi.fn(),
  };
  applyType(ctx as never);
  return type;
}

it.each([
  ["Claude", applyClaude],
  ["Goose", applyGoose],
  ["Pi", applyPi],
])("keeps session scope when switching between Codex and %s", (_, plugin) => {
  const codex = applied();
  const target = applied(undefined, plugin);
  const migrate = (
    source: AgentType | undefined,
    destination: AgentType | undefined,
    saved: unknown,
  ) =>
    destination?.adopt?.(
      source?.carry?.(saved) ?? {},
      destination.defaults().config,
    );
  for (const scope of ["thread", "channel", "community"]) {
    const switched = migrate(codex, target, {
      scope,
      instructions: "Triage.",
      model: "codex-only",
    });
    expect(switched).toMatchObject({
      scope,
      instructions: "Triage.",
      model: "",
    });
    expect(migrate(target, codex, switched)).toMatchObject({
      scope,
      instructions: "Triage.",
    });
  }
});

it("registers only where the desktop app can run codex and base64", () => {
  const check = vi.spyOn(CodexProvider.prototype, "check").mockResolvedValue();
  const type = applied();
  expect(check).not.toHaveBeenCalled();
  expect(type).toMatchObject({
    id: "codex",
    title: "Codex",
    Create: expect.any(Function),
    icon: CodexLogoIcon,
  });
  expect(type?.provider).toBeDefined();
  expect(type?.tabs?.map(({ title, role }) => [title, role])).toEqual([
    ["Settings", "settings"],
    ["Activity", "activity"],
  ]);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  expect(applied()).toBeDefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  expect(applied()).toBeUndefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  desktop.tauri = false;
  expect(applied()).toBeUndefined();
});

it("adopts an agent's instructions and compatible workspace without its model", () => {
  const type = applied();
  const saved = type?.defaults().config;
  expect(
    type?.adopt?.({ instructions: "Triage.", model: "gpt" } as never, saved),
  ).toEqual({ ...(saved as object), instructions: "Triage." });
  expect(type?.adopt?.({ workspace: "/work/code" }, saved)).toEqual({
    ...(saved as object),
    workspace: "/work/code",
  });
  expect(type?.adopt?.({ workspace: "~/code" }, saved)).toEqual({
    ...(saved as object),
    workspace: "~/code",
  });
  // A workspace Codex cannot run in stays the default.
  expect(type?.adopt?.({ workspace: "code" }, saved)).toEqual(saved);
  expect(
    type?.carry?.({ ...(saved as object), model: "gpt", instructions: " " }),
  ).toEqual({});
  expect(
    type?.carry?.({ instructions: "Triage.", workspace: "/work/code" }),
  ).toEqual({ instructions: "Triage.", workspace: "/work/code" });
  expect(type?.describeMigration?.(saved)).toEqual([
    { id: "model", label: "Model", isOverride: false },
    { id: "thinking", label: "Thinking", isOverride: false },
    { id: "voice", label: "Voice", isOverride: false },
    { id: "apps", label: "Codex apps and plugins", isOverride: false },
  ]);
  expect(
    type?.describeMigration?.({
      ...(saved as object),
      model: "gpt-5",
      effort: "high",
      scope: "channel",
      voice: "maple",
      apps: true,
    }),
  ).toEqual([
    { id: "model", label: "Model", isOverride: true },
    { id: "thinking", label: "Thinking", isOverride: true },
    { id: "voice", label: "Voice", isOverride: true },
    { id: "apps", label: "Codex apps and plugins", isOverride: true },
  ]);
  expect(type?.migrationWarning).toBe(
    "Any commands Codex left running will stop.",
  );
});

it("stops agents that stop running even when the agent list could not be read", () => {
  const sync = vi.spyOn(CodexRuntime.prototype, "sync");
  const agent = { pubkey: "agent", type: "buzz.codex/codex" };
  let state = { status: "ready", agents: [agent], running: [agent] };
  let notify = () => undefined;
  apply({
    agentProtection: { registerModels: vi.fn() },
    pluginOwner: { id: "buzz.codex" },
    host: { spawn: vi.fn(), request: vi.fn() },
    agents: {
      executionBinding: () => undefined,
      inspectExecution: async () => undefined,
      execution: async () => undefined,
      register: () => undefined,
      snapshot: () => state,
      relay: () => undefined,
      subscribe: (listener: () => undefined) => {
        notify = listener;
        return () => undefined;
      },
    },
    effect: vi.fn(),
  } as never);
  expect(sync).toHaveBeenLastCalledWith([agent]);
  // A failed refresh keeps the list; leaving the community then empties it.
  state = { ...state, status: "error", agents: [], running: [] };
  notify();
  expect(sync).toHaveBeenLastCalledWith([]);
});

it("starts the server once Codex is updated and checked, only while a Codex agent runs", async () => {
  /** What the next update and check leave behind. */
  let left: { running?: "install"; readiness: string } = { readiness: "ready" };
  /** Held updates and checks, released in order. */
  const held: (() => void)[] = [];
  const hold = (target: object, change: () => object) =>
    new Promise<void>((resolve) => {
      held.push(() => {
        const own = target as { state: object };
        own.state = { ...own.state, ...change() };
        resolve();
      });
    });
  const update = vi
    .spyOn(CodexSetup.prototype, "update")
    .mockImplementation(function (this: CodexSetup) {
      return hold(this, () => ({ running: left.running }));
    });
  const check = vi
    .spyOn(CodexProvider.prototype, "check")
    .mockImplementation(function (this: CodexProvider) {
      return hold(this, () => ({ readiness: left.readiness }));
    });
  const warm = vi
    .spyOn(CodexRuntime.prototype, "warm")
    .mockImplementation(() => undefined);
  vi.spyOn(CodexRuntime.prototype, "sync").mockImplementation(() => undefined);
  const release = async () => {
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
    held.shift()?.();
  };
  // Every step is a microtask, so a macrotask has seen the chain through.
  const settled = () => new Promise((resolve) => setTimeout(resolve));
  const agent = { pubkey: "agent", type: "buzz.codex/codex" };
  let state = { status: "ready", agents: [agent], running: [agent] };
  let notify = () => undefined;
  const restart = () => {
    state = { ...state, running: [] };
    notify();
    state = { ...state, running: [agent] };
    notify();
  };
  let cleanup: () => void = () => undefined;
  apply({
    agentProtection: { registerModels: vi.fn() },
    pluginOwner: { id: "buzz.codex" },
    host: { spawn: vi.fn(), request: vi.fn() },
    agents: {
      executionBinding: () => undefined,
      inspectExecution: async () => undefined,
      execution: async () => undefined,
      register: () => undefined,
      snapshot: () => state,
      relay: () => undefined,
      subscribe: (listener: () => undefined) => {
        notify = listener;
        return () => undefined;
      },
    },
    effect: (setup: () => () => void) => {
      cleanup = setup();
    },
  } as never);
  expect(update).toHaveBeenLastCalledWith(true);
  await release();
  // Two first starts of Codex race on its state, so the check goes first.
  await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
  await settled();
  expect(warm).not.toHaveBeenCalled();
  await release();
  await vi.waitFor(() => expect(warm).toHaveBeenCalledOnce());

  // An agent that stops meanwhile, a Codex that needs attention, and an
  // install in progress all leave the start to the mention.
  restart();
  state = { ...state, running: [] };
  notify();
  await release();
  await release();
  await settled();
  expect(warm, "stopped").toHaveBeenCalledOnce();
  for (const next of [
    { readiness: "attention" },
    { readiness: "ready", running: "install" as const },
  ]) {
    left = next;
    restart();
    await release();
    await release();
    await settled();
    expect(warm, JSON.stringify(next)).toHaveBeenCalledOnce();
  }
  // Nor does a plugin disposed meanwhile start one.
  left = { readiness: "ready" };
  restart();
  await release();
  cleanup();
  await release();
  await settled();
  expect(update).toHaveBeenCalledTimes(5);
  expect(warm).toHaveBeenCalledOnce();
});

it("observes each saved conversation as a session, read-only", () => {
  vi.spyOn(CodexRuntime.prototype, "conversations").mockReturnValue([
    {
      key: JSON.stringify(["room", "r".repeat(64)]),
      channelId: "room",
      root: "r".repeat(64),
      threadId: "t1",
      at: 2000,
    },
    { key: JSON.stringify(["dm", "channel"]), channelId: "dm", threadId: "t2" },
    { key: "shared", channelId: "dm", threadId: "shared", community: true },
  ]);
  expect(applied()?.sessions?.list("a".repeat(64))).toEqual([
    { channelId: "room", root: "r".repeat(64), at: 2000 },
    { channelId: "dm" },
    { channelId: "dm", community: true },
  ]);
});

it("preserves a compatible shared Codex model", () => {
  const type = applied();
  expect(
    type?.importShared?.({
      runtime: "codex",
      provider: "openai",
      model: "gpt-shared",
    }),
  ).toMatchObject({ model: "gpt-shared" });
  expect(
    type?.importShared?.({ runtime: "buzz-agent", model: "gpt-shared" }),
  ).toBeUndefined();
  expect(
    type?.importShared?.({
      runtime: "codex",
      provider: "other",
      model: "gpt-shared",
    }),
  ).toBeUndefined();
  const shared = type?.exportShared?.({ model: "gpt-shared" });
  expect(shared).toEqual({ runtime: "codex", model: "gpt-shared" });
  expect(type?.importShared?.(shared ?? { model: "" })).toMatchObject({
    model: "gpt-shared",
  });
});

it("reports remote usage as unavailable before reading desktop history", async () => {
  const type = applied({
    provider: "test/guest",
  });
  if (!type?.usage) throw new Error("Codex usage is not registered");
  await expect(
    type.usage({ key: "a".repeat(64) } as never, {
      since: 0,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Usage is unavailable for remote Codex agents");
});
