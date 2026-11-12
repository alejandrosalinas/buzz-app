// The part of the Claude agent type that runs agents, without its views: the
// desktop app registers it with its tabs, and a standalone host runs it alone.
import { syncedSettingsSchema, withSyncedSettings } from "./settings";
import type { AgentType, AgentHandle } from "../../features/agents/service";
import { type ClaudeRuntime, type Config, config } from "./runtime";

export const TYPE_ID = "claude-code";
/** A turn's run returns once Claude has it, so this bounds only the hand-over. */
const HANDOVER_MS = 2 * 60_000;

/** How agents of this type run on `runtime`. A turn first waits for `ready`
 * when given, such as for the first download of Claude, within its deadline. */
export const claudeRun = (
  runtime: ClaudeRuntime,
  ready?: (signal: AbortSignal, agent?: AgentHandle) => Promise<void>,
): Pick<
  AgentType<Config>,
  | "models"
  | "sessionAdmission"
  | "sessionControls"
  | "run"
  | "runOnce"
  | "timeoutMs"
  | "syncedSettings"
  | "resumes"
  | "readFile"
> => ({
  sessionAdmission: true,
  models: (agent) => runtime.models(agent.key, agent.config),
  sessionControls: {
    scope: (agent) => config(agent.config).scope,
    state: (agent, place) => runtime.sessionState(agent, place),
    run: (agent, place, action, reset) =>
      runtime.session(agent, place, action, reset),
    subscribe: (listener) => runtime.subscribe(listener),
  },
  run: async (delivery) => {
    await ready?.(delivery.signal, delivery.agent);
    return runtime.run(delivery);
  },
  runOnce: async (turn) => {
    await ready?.(turn.signal, turn.delivery.agent);
    return runtime.runOnce(turn);
  },
  readFile: (agent, path, signal) => runtime.workspaceFile(agent, path, signal),
  timeoutMs: HANDOVER_MS,
  syncedSettings: {
    schema: syncedSettingsSchema,
    withSynced: withSyncedSettings,
  },
  // Closing or reloading the app stops its turns; each resumed one carries on
  // in its saved session.
  resumes: true,
});
