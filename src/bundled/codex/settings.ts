// The agent settings that sync across devices (NIP-AP `buzz.agent.settings`):
// every per-agent setting except instructions, which have their own artifact.
// No credentials or env vars live in this config; the allowlist keeps it so.
import {
  pickSettings,
  type SettingsSchema,
  withSynced,
} from "../../features/agents/agent-config";
import { type Config, defaults, config as readConfig } from "./config";

export const syncedSettingsSchema = {
  voice: "string",
  model: "string",
  effort: "string",
  scope: ["thread", "channel", "community"],
} as const satisfies SettingsSchema;

export const syncedSettings = (config: Config) =>
  pickSettings(syncedSettingsSchema, readConfig(config));

/** Synced fields come only from `settings`, a left-out one from the default;
 * everything else stays this device's. */
export const withSyncedSettings = (
  config: Config,
  settings: Readonly<Record<string, string>>,
): Config =>
  readConfig(
    withSynced(
      syncedSettingsSchema,
      { ...defaults, voice: "" },
      config,
      settings,
    ),
  );
