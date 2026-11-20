import { expect, it } from "vitest";
import { config, defaults } from "./config";
import {
  syncedSettings,
  syncedSettingsSchema,
  withSyncedSettings,
} from "./settings";
import { settingsProblem } from "../../features/agents/agent-config";

it("round-trips each agent's voice through saved and synced settings", () => {
  for (const voice of ["cove", "maple", ""]) {
    const saved = config(JSON.parse(JSON.stringify({ ...defaults, voice })));
    expect(saved.voice).toBe(voice || undefined);
    const synced = syncedSettings(saved);
    expect(settingsProblem(syncedSettingsSchema, synced)).toBeUndefined();
    expect(
      withSyncedSettings({ ...defaults, voice: "sol" }, synced).voice,
    ).toBe(voice || undefined);
  }
});
it("defaults old settings instead of inheriting this device's voice", () => {
  expect(
    withSyncedSettings({ ...defaults, voice: "maple" }, {}).voice,
  ).toBeUndefined();
  expect(config({}).voice).toBeUndefined();
});
it.each([null, 123])("does not send an unsupported local voice %s", (voice) => {
  expect(config({ voice }).voice).toBeUndefined();
});
it("preserves catalog voices across hosts and rejects non-text synced values", () => {
  expect(config({ voice: "future-voice" }).voice).toBe("future-voice");
  expect(settingsProblem(syncedSettingsSchema, { voice: 123 })).toBeDefined();
  expect(syncedSettings(config({}))).not.toHaveProperty("voice");
});

it("publishes defaults and cleared voices in the previous client's settings shape", async () => {
  const { fields } = await import("../../features/agents/community-config");
  const previousSchema = {
    model: "string",
    effort: "string",
    scope: ["thread", "channel"],
  } as const;
  for (const raw of [{}, { voice: "" }, { ...defaults, voice: "" }]) {
    const saved = config(raw);
    const agent = {
      pubkey: "a".repeat(64),
      name: "Example",
      type: "codex",
      config: saved,
      schema: syncedSettingsSchema,
    };
    const body = fields("settings", agent, saved);
    expect(settingsProblem(previousSchema, body.settings)).toBeUndefined();
    expect(body.settings).not.toHaveProperty("voice");
  }
  const saved = config({ voice: "maple" });
  const body = fields(
    "settings",
    {
      pubkey: "a".repeat(64),
      name: "Example",
      type: "codex",
      config: saved,
      schema: syncedSettingsSchema,
    },
    saved,
  );
  expect(body.settings).toHaveProperty("voice", "maple");
});
