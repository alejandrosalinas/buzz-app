/** Saved selection policy, never evidence of an active turn's model. */
export type AgentModelSetting = Readonly<
  | { source: "configured"; value: string }
  | { source: "default" | "recommended" | "unavailable" }
>;

export type AgentModelSettings = Readonly<{
  model: AgentModelSetting;
  effort: AgentModelSetting;
  /** Only types with a separate provider choice include this field. */
  provider?: AgentModelSetting;
}>;

/** Types opt in with their parsed settings. Only these public fields leave
 * the type; defaults stay unresolved without starting discovery or a harness. */
export function readModelSettings(
  config: { model: unknown; effort: unknown; provider?: unknown },
  options: { provider?: boolean; recommended?: boolean } = {},
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
    model: read(config.model),
    effort: read(config.effort),
    ...(options.provider && { provider: read(config.provider) }),
  };
}
