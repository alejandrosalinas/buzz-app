import { PRESET } from "../../features/agents/recommended";

export type Config = {
  model: string;
  effort: string;
  instructions: string;
  workspace: string;
  scope: "thread" | "channel";
  /** Leaves Codex's Apps and plugins features to its own configuration
   * instead of turning them off. This device's only, as Apps follow its
   * Codex sign-in; never for protected agents. */
  apps?: true;
  /** On Recommended, whose model and thinking level runs replace these. */
  preset?: typeof PRESET;
};
export type Model = {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
};
/** Buzz owns model preferences; an unset choice follows Codex's recommendation. */
export function resolveModel(selected: string, models: readonly Model[]) {
  return selected || models.find((model) => model.isDefault)?.model;
}
/** A turn uses the first supported choice, then the selected model's default. */
export function resolveEffort(
  model: Model,
  ...choices: (string | undefined)[]
) {
  return (
    choices.find(
      (choice) =>
        choice &&
        model.supportedReasoningEfforts.some(
          (level) => level.reasoningEffort === choice,
        ),
    ) ?? model.defaultReasoningEffort
  );
}
export const defaults: Config = {
  model: "",
  effort: "",
  instructions: "",
  workspace: "~/.buzz",
  scope: "thread",
};
export function config(raw: unknown): Config {
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    model: typeof value.model === "string" ? value.model : "",
    effort: typeof value.effort === "string" ? value.effort : "",
    instructions:
      typeof value.instructions === "string" ? value.instructions : "",
    workspace:
      typeof value.workspace === "string" && value.workspace.trim()
        ? value.workspace.trim()
        : defaults.workspace,
    scope: value.scope === "channel" ? "channel" : "thread",
    ...(value.apps === true ? { apps: true as const } : {}),
    ...(value.preset === PRESET ? { preset: PRESET } : {}),
  };
}
export const effortName = (effort: string) =>
  ({ xhigh: "Extra high", max: "Maximum", ultra: "Ultra" })[effort] ??
  `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;

export const absoluteWorkspace = (path: string) =>
  path.trim().startsWith("/") || /^[A-Za-z]:[\\/]/.test(path.trim());

/** An absolute path, or one under the home directory written `~/…`, which the
 * process host expands. */
export const validWorkspace = (path: string) =>
  /^~(\/|$)/.test(path.trim()) || absoluteWorkspace(path);
