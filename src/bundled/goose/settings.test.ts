import { expect, it } from "vitest";
import {
  settingsProblem,
  syncedSettings,
} from "../../features/agents/agent-config";
import {
  syncedSettings as claude,
  syncedSettingsSchema as claudeSchema,
} from "../claude-code/settings";
import {
  syncedSettings as codex,
  syncedSettingsSchema as codexSchema,
} from "../codex/settings";
import {
  onRecommended,
  withRecommended,
} from "../../features/agents/recommended";
import { config as readCodex } from "../codex/config";
import {
  DEFAULT_CONFIG as gooseDefaults,
  config as readGoose,
} from "./runtime";
import {
  syncedSettings as goose,
  syncedSettingsSchema as gooseSchema,
  withSyncedSettings,
} from "./settings";

it("syncs every agent setting except instructions and the device-local folder", () => {
  const base = {
    model: "m",
    effort: "high",
    instructions: "secret plan",
    workspace: "~/w",
    scope: "thread" as const,
  };
  expect(claude(base)).toEqual({
    model: "m",
    effort: "high",
    scope: "thread",
  });
  expect(codex(base)).toEqual({
    model: "m",
    effort: "high",
    scope: "thread",
  });
  expect(goose({ ...gooseDefaults, provider: "p", instructions: "x" })).toEqual(
    {
      model: "",
      provider: "p",
      effort: "",
      scope: "thread",
    },
  );
  for (const [schema, settings] of [
    [claudeSchema, claude(base)],
    [codexSchema, codex(base)],
    [gooseSchema, goose(gooseDefaults)],
  ] as const)
    expect(settingsProblem(schema, settings)).toBeUndefined();
});

it("applies only allowlisted synced fields over local config", () => {
  const local = { ...gooseDefaults, instructions: "mine" };
  expect(
    withSyncedSettings(local, {
      model: "m2",
      instructions: "theirs",
      workspace: "/srv",
    }),
  ).toEqual({ ...local, model: "m2" });
});

it("rejects a remote workspace setting as an unknown key for every agent type", () => {
  for (const [agentType, schema] of [
    ["claude-code", claudeSchema],
    ["codex", codexSchema],
    ["goose", gooseSchema],
  ] as const) {
    const content = JSON.stringify({
      version: 1,
      agentType,
      settings: { workspace: "~/w" },
    });
    expect(syncedSettings(content, agentType, schema)).toEqual({
      problem: 'Unknown setting "workspace"',
    });
  }
});

it("keeps Recommended out of synced settings, so older versions never see an unknown key", () => {
  const recommended = readGoose(
    withRecommended({ ...gooseDefaults, model: "m", effort: "high" }),
  );
  const codexRecommended = readCodex(
    withRecommended({
      model: "m",
      effort: "high",
      instructions: "",
      workspace: "~/.buzz",
      scope: "thread",
    }),
  );
  expect(recommended).toMatchObject({ preset: "recommended" });
  expect(codexRecommended).toMatchObject({ preset: "recommended" });
  // What it publishes is what any version accepts: no new key, and no model
  // settings of its own a synced-level check could hold against it.
  expect(goose(recommended)).toEqual({
    model: "",
    provider: "",
    effort: "",
    scope: "thread",
  });
  expect(codex(codexRecommended)).toEqual({
    model: "",
    effort: "",
    scope: "thread",
  });
  expect(settingsProblem(gooseSchema, goose(recommended))).toBeUndefined();
  expect(settingsProblem(codexSchema, codex(codexRecommended))).toBeUndefined();
});

it("keeps this device's mark through a synced revision until one names a model", () => {
  const local = readGoose(withRecommended(gooseDefaults));
  const kept = withSyncedSettings(local, goose(local));
  expect(onRecommended(kept)).toBe(true);
  // A model chosen elsewhere, or restored from History, takes it off.
  const chosen = withSyncedSettings(local, { ...goose(local), model: "m" });
  expect(onRecommended(chosen)).toBe(false);
  expect(chosen.model).toBe("m");
});
