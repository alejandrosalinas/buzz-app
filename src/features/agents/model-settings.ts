/** A current selection, never evidence of an active turn's override. */
export type AgentModelResolution = Readonly<
  | {
      value: string;
      source: "configured" | "device" | "provider" | "recommended";
    }
  | {
      unavailable:
        | "not-loaded"
        | "unknown"
        | "remote"
        | "unsupported"
        | "execution-unavailable";
    }
>;
export type AgentModelSettingsContext = Readonly<{
  execution: "local" | "remote" | "unavailable";
  /** Confirmed synced choices that execution must preserve or refuse. */
  synced?: Readonly<Record<string, string>>;
}>;
/** Saved policy stays distinct from the selection it resolves to here. */
export type AgentModelSetting = Readonly<
  (
    | { source: "configured"; value: string }
    | { source: "default" | "recommended" | "unavailable" }
  ) & { resolved?: AgentModelResolution }
>;

export type AgentModelSettings = Readonly<{
  model: AgentModelSetting;
  effort: AgentModelSetting;
  /** Only types with a separate provider choice include this field. */
  provider?: AgentModelSetting;
}>;
export type AgentModelSettingsReadout =
  | AgentModelSettings
  | Readonly<{ unavailable: string }>;

/** Types opt in with their parsed settings. Only these public fields leave
 * the type. Resolution uses existing state without starting discovery. */
export function readModelSettings(
  config: { model: unknown; effort: unknown; provider?: unknown },
  options: {
    provider?: boolean;
    recommended?: boolean;
    resolved?: Readonly<{
      model: AgentModelResolution;
      effort: AgentModelResolution;
    }>;
  } = {},
): AgentModelSettings {
  const read = (value: unknown): AgentModelSetting =>
    options.recommended
      ? { source: "recommended" }
      : typeof value !== "string"
        ? { source: "unavailable" }
        : value
          ? { source: "configured", value }
          : { source: "default" };
  return {
    model: {
      ...read(config.model),
      ...(options.resolved && { resolved: options.resolved.model }),
    },
    effort: {
      ...read(config.effort),
      ...(options.resolved && { resolved: options.resolved.effort }),
    },
    ...(options.provider && { provider: read(config.provider) }),
  };
}
