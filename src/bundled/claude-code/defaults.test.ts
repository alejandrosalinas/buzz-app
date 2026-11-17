// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { recommendedRun } from "../../features/agents/recommended";
import { localStore } from "../../features/agents/store";
import { ClaudeDefaults } from "./defaults";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllEnvs();
});

it("reads changed device defaults, mixed overrides and unknown native settings without rewriting the agent", async () => {
  const defaults = new ClaudeDefaults(localStore());
  const saved = { model: "", effort: "", workspace: "/project" };
  const read = () => defaults.readModelSettings(saved);
  expect(read()).toEqual({
    model: { source: "default", resolved: { unavailable: "unknown" } },
    effort: { source: "default", resolved: { unavailable: "unknown" } },
  });
  await defaults.save({ model: "opus", effort: "high" });
  expect(read()).toEqual({
    model: { source: "default", resolved: { value: "opus", source: "device" } },
    effort: {
      source: "default",
      resolved: { value: "high", source: "device" },
    },
  });
  await defaults.save({ model: "sonnet", effort: "low" });
  expect(read().model).toEqual({
    source: "default",
    resolved: { value: "sonnet", source: "device" },
  });
  expect(defaults.readModelSettings({ ...saved, effort: "high" })).toEqual({
    model: {
      source: "default",
      resolved: { value: "sonnet", source: "device" },
    },
    effort: {
      source: "configured",
      value: "high",
      resolved: { value: "high", source: "configured" },
    },
  });
  // An explicit other model does not inherit the device's thinking level.
  expect(defaults.readModelSettings({ ...saved, model: "opus" })).toEqual({
    model: {
      source: "configured",
      value: "opus",
      resolved: { value: "opus", source: "configured" },
    },
    effort: { source: "default", resolved: { unavailable: "unknown" } },
  });
  expect(saved).toEqual({ model: "", effort: "", workspace: "/project" });
  expect(defaults.readModelSettings({ model: "  opus  " }).model).toEqual({
    source: "configured",
    value: "  opus  ",
    resolved: { value: "opus", source: "configured" },
  });
  expect(
    defaults.readModelSettings(saved, { execution: "remote" }).model,
  ).toEqual({ source: "default", resolved: { unavailable: "remote" } });
  expect(
    defaults.readModelSettings(saved, { execution: "unavailable" }).model,
  ).toEqual({
    source: "default",
    resolved: { unavailable: "execution-unavailable" },
  });
});

it.each([true, false])(
  "reads cached Recommended policy and its device fallback (offered=%s)",
  async (available) => {
    vi.stubEnv(
      "VITE_BUZZ_RECOMMENDED_AGENT",
      JSON.stringify([
        {
          harness: "claude-code",
          model: "model-a",
          effort: "high",
          label: "A",
        },
      ]),
    );
    const offered = vi.fn(async () => available);
    const policy = recommendedRun("claude-code", offered);
    const defaults = new ClaudeDefaults(localStore(), policy);
    await defaults.save({ model: "sonnet", effort: "low" });
    const saved = { preset: "recommended" };
    expect(defaults.readModelSettings(saved).model).toEqual({
      source: "recommended",
      resolved: { unavailable: "not-loaded" },
    });
    expect(offered).not.toHaveBeenCalled();
    await defaults.follow(saved);
    expect(defaults.readModelSettings(saved)).toEqual({
      model: {
        source: "recommended",
        resolved: {
          value: available ? "model-a" : "sonnet",
          source: available ? "recommended" : "device",
        },
      },
      effort: {
        source: "recommended",
        resolved: {
          value: available ? "high" : "low",
          source: available ? "recommended" : "device",
        },
      },
    });
    expect(offered).toHaveBeenCalledOnce();
  },
);
