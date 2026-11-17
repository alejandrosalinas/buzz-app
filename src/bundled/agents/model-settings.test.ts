// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { AgentType } from "../../features/agents/service";
import { apply as claude } from "../claude-code";
import { apply as codex } from "../codex";
import { apply as goose } from "../goose";
import { apply as pi } from "../pi";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it.each([
  { name: "Claude Code", apply: claude, provider: false, recommended: true },
  { name: "Codex", apply: codex, provider: false, recommended: true },
  { name: "goose", apply: goose, provider: true, recommended: true },
  { name: "Pi", apply: pi, provider: true, recommended: false },
])(
  "$name exposes only saved model selections without host I/O",
  ({ name, apply, provider, recommended }) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    let type: AgentType | undefined;
    const request = vi.fn();
    apply({
      host: { request },
      agentProtection: { registerModels: vi.fn() },
      settingsCards: { register: vi.fn() },
      agents: {
        register: (registered: AgentType) => {
          type = registered;
        },
        relay: () => undefined,
        subscribe: () => () => {},
        snapshot: () => ({ status: "ready", running: [] }),
      },
      effect: vi.fn(),
    } as never);
    if (!type?.readModelSettings)
      throw new Error("Missing model settings read");
    const saved = {
      model: "model-a",
      effort: "high",
      provider: "provider-a",
      apiKey: "private-key",
      workspace: "/private/path",
      instructions: "private instructions",
    };
    const before = structuredClone(saved);
    expect(type.readModelSettings(saved)).toEqual({
      model: { source: "configured", value: "model-a" },
      effort: { source: "configured", value: "high" },
      ...(provider && {
        provider: { source: "configured", value: "provider-a" },
      }),
    });
    expect(type.readModelSettings(type.defaults().config)).toEqual({
      model: { source: "default" },
      effort: { source: "default" },
      ...(provider && { provider: { source: "default" } }),
    });
    expect(type.readModelSettings({ ...saved, effort: "" })).toMatchObject({
      model: { source: "configured", value: "model-a" },
      effort: { source: "default" },
    });
    expect(
      type.readModelSettings({ ...saved, effort: { secret: "invalid" } }),
    ).toMatchObject({
      effort: { source: name === "Codex" ? "default" : "unavailable" },
    });
    if (recommended) {
      expect(type.readModelSettings({ preset: "recommended" })).toEqual({
        model: { source: "recommended" },
        effort: { source: "recommended" },
        ...(provider && { provider: { source: "recommended" } }),
      });
    }
    expect(saved).toEqual(before);
    expect(request).not.toHaveBeenCalled();
  },
);
