// The part of the goose agent type that runs agents, without its views.
import type { AgentType } from "../../features/agents/service";
import { type Config, config, type GooseRuntime } from "./runtime";
import { syncedSettingsSchema, withSyncedSettings } from "./settings";

/** A turn's run returns once goose has it, so this bounds only the hand-over. */
const HANDOVER_MS = 2 * 60_000;

/** How agents of this type run on `runtime`. */
export const gooseRun = (
  runtime: GooseRuntime,
): Pick<
  AgentType<Config>,
  | "sessionControls"
  | "run"
  | "runOnce"
  | "timeoutMs"
  | "syncedSettings"
  | "resumes"
  | "readFile"
> => ({
  sessionControls: {
    scope: (agent) => config(agent.config).scope,
    state: (agent, place) => runtime.sessionState(agent, place),
    run: (agent, place, action) => runtime.session(agent, place, action),
    subscribe: (listener) => runtime.subscribe(listener),
  },
  run: (delivery) => runtime.run(delivery),
  runOnce: (turn) => runtime.runOnce(turn),
  // Its host reader cannot be stopped once started.
  readFile: (agent, path, signal) => {
    signal.throwIfAborted();
    return runtime.workspaceFile(agent, path);
  },
  timeoutMs: HANDOVER_MS,
  syncedSettings: {
    schema: syncedSettingsSchema,
    withSynced: withSyncedSettings,
  },
  // Closing or reloading the app stops its turns; each resumed one carries on
  // in a new session shown what it already did in the conversation.
  resumes: true,
});
