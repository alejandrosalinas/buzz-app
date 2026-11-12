// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  dispatchAgentHooks,
  type AgentHookDispatchOptions,
  type AgentHookContext,
} from "../features/agents/hooks";
import { apply as claude } from "./claude-code";
import { apply as codex } from "./codex";
import { apply as pi } from "./pi";
import { ClaudeRuntime } from "./claude-code/runtime";
import { CodexRuntime } from "./codex/runtime";
import { PiRuntime } from "./pi/runtime";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("./claude-code/runtime", async (original) => {
  const actual = await original<typeof import("./claude-code/runtime")>();
  return {
    ...actual,
    ClaudeRuntime: vi.fn(class extends actual.ClaudeRuntime {}),
  };
});
vi.mock("./codex/runtime", async (original) => {
  const actual = await original<typeof import("./codex/runtime")>();
  return {
    ...actual,
    CodexRuntime: vi.fn(class extends actual.CodexRuntime {}),
  };
});
vi.mock("./pi/runtime", async (original) => {
  const actual = await original<typeof import("./pi/runtime")>();
  return { ...actual, PiRuntime: vi.fn(class extends actual.PiRuntime {}) };
});
afterEach(() => vi.restoreAllMocks());

it.each(["claude", "codex", "pi"] as const)(
  "labels registered %s adapter hook output",
  async (name) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
    let output: unknown =
      name === "pi" ? { block: "Wait" } : { decision: "block", reason: "Wait" };
    const dispatchHook = vi.fn(
      (
        harness: string,
        event: string,
        input: unknown,
        context: AgentHookContext,
        options: AgentHookDispatchOptions,
      ) =>
        dispatchAgentHooks(
          [
            {
              id: "reply",
              pluginId: "reply-first",
              harness,
              event,
              run: () => output,
            },
          ],
          input,
          context,
          options.accepts,
          options.milliseconds,
          options.compose,
        ),
    );
    ({ claude, codex, pi })[name]({
      pluginOwner: { id: `buzz.${name}`, revision: "r1" },
      host: { request: vi.fn(), serveMcp: vi.fn() },
      agents: {
        register: vi.fn(),
        relay: () => undefined,
        subscribe: () => () => {},
        snapshot: () => ({ status: "ready", running: [] }),
        dispatchHook,
      },
      settingsCards: { register: vi.fn() },
      agentProtection: { registerModels: vi.fn() },
      effect: vi.fn(),
    } as never);
    const hook =
      name === "claude"
        ? vi.mocked(ClaudeRuntime).mock.calls.at(-1)?.[7]
        : name === "codex"
          ? vi.mocked(CodexRuntime).mock.calls.at(-1)?.[7]?.run
          : vi.mocked(PiRuntime).mock.calls.at(-1)?.[6];
    expect(hook).toBeTypeOf("function");
    expect(await hook?.("a".repeat(64), "session", "PreToolUse", {})).toEqual(
      name === "pi"
        ? { block: "[Buzz plugin: reply-first] Wait" }
        : { decision: "block", reason: "[Buzz plugin: reply-first] Wait" },
    );
    expect(dispatchHook).toHaveBeenCalledOnce();
    if (name === "pi") {
      output = { output: [{ type: "text", text: '{"ok":true}' }] };
      expect(
        await hook?.("a".repeat(64), "session", "afterTool", {
          call: { parent: { taskId: "outer", callId: "outer-tool" } },
        }),
      ).toEqual(output);
      expect(
        await hook?.("a".repeat(64), "session", "afterTool", { call: {} }),
      ).toEqual({
        output: [
          { type: "text", text: "[Buzz plugin: reply-first]" },
          { type: "text", text: '{"ok":true}' },
        ],
      });
    }
  },
);
