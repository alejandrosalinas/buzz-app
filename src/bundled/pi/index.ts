import { piHookOutput } from "../hook-output";
// Pi agents: an agent type whose agents run on Pi durable on this computer,
// with any provider Pi supports. One Pi host runs them all, each with its own
// storage; each conversation the agent is in is one continuing, durable Pi
// conversation. Pi answers with the in-process Buzz tools.
import { isTauri } from "@tauri-apps/api/core";
import { pubkeyOf } from "../../features/agents/membership";
import { ownerReads } from "../../features/agents/reads";
import { repositoriesContext } from "../../features/communities/repositories";
import type { PluginModule } from "../../plugins/api";
import { PiLogoIcon } from "../../shared/design-system/icons";
import { type Config, config, DEFAULT_CONFIG, PiRuntime } from "./runtime";
import { createTabs } from "./tabs";

export const TYPE_ID = "pi";
/** A turn's run returns once Pi has it, so this bounds only the hand-over,
 * which includes the first install of Pi's packages. */
const HANDOVER_MS = 2 * 60_000;

export const inject = ["agents", "host", "agentProtection"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start the Pi host; no unusable type elsewhere.
  if (!isTauri()) return;
  const { agents, host } = ctx;
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.pi"}/${TYPE_ID}`;
  const runtime = new PiRuntime(
    host,
    (key) => ownerReads(agents.relay(key), pubkeyOf(key)),
    (key, signal) => agents.core(key, signal),
    () => agents.tools(),
    repositoriesContext,
    (key) => agents.handle(key),
    async (agent, session, event, input) => {
      return (
        (await agents.dispatchHook(
          typeKey,
          event,
          input,
          { agent, session },
          {
            accepts: (output) => output != null,
            milliseconds: 25000,
            compose: (output, pluginId) =>
              piHookOutput(output, pluginId, input),
          },
        )) ?? null
      );
    },
    (key, listener) => agents.relay(key)?.subscribe(listener) ?? (() => {}),
    agents.storage,
  );
  ctx.agentProtection.registerModels({
    label: "Pi",
    models: async () => {
      const { providers } = await runtime.setup.providers();
      const choices = await Promise.all(
        providers
          .filter((provider) => provider.configured)
          .map(async (provider) =>
            (await runtime.setup.models(provider.id)).map((model) => ({
              provider: provider.id,
              id: model.id,
              label: `${provider.name} · ${model.label}`,
            })),
          ),
      );
      return choices.flat();
    },
    complete: (model, prompt, signal) =>
      runtime.setup.review(model, prompt, signal),
  });
  const { ActivityTab, Create, CreateModel, SettingsTab } = createTabs({
    setup: runtime.setup,
    runtime,
  });
  const sync = () => {
    const snapshot = agents.snapshot();
    if (snapshot.status === "loading") return;
    runtime.sync(snapshot.running.filter((agent) => agent.type === typeKey));
  };
  if (host.spawn) {
    const unsubscribe = agents.subscribe(sync);
    sync();
    ctx.effect(() => () => {
      unsubscribe();
      runtime.dispose();
    });
  }

  agents.register<Config>({
    id: TYPE_ID,
    hooks: { events: ["beforeTool", "afterTool"] },
    retire: (pubkey) => runtime.retire(pubkey),
    protection: true,
    title: "Pi",
    icon: PiLogoIcon,
    description:
      "Pi on this computer, with any provider Pi supports. Each thread it is mentioned in is one continuing conversation.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    Create,
    CreateModel,
    createModelReportsReadiness: true,
    importShared: (source) =>
      source.runtime === "pi"
        ? {
            ...DEFAULT_CONFIG,
            model: source.model,
            provider: source.provider ?? "",
          }
        : undefined,
    exportShared: (saved) => {
      const { provider, model } = config(saved);
      return { runtime: "pi", ...(provider && { provider }), model };
    },
    adopt: (carry, saved) => ({
      ...saved,
      instructions: carry.instructions ?? saved.instructions,
      workspace: carry.workspace ?? saved.workspace,
    }),
    carry: (saved) => {
      const { instructions, workspace } = config(saved);
      return {
        ...(instructions.trim() && { instructions }),
        ...(workspace !== DEFAULT_CONFIG.workspace && { workspace }),
      };
    },
    summary: (agent) => {
      const { model, provider } = config(agent.config);
      return [provider, model].filter(Boolean).join(" · ") || "Pi";
    },
    ...(host.spawn && {
      usage: (agent, { since, signal }) =>
        runtime.usage(agent.key, since, signal),
    }),
    sessions: {
      list: (key) => runtime.sessions(key),
      subscribe: (listener) => runtime.subscribe(listener),
    },
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        splitSettings: true,
        component: SettingsTab,
      },
      {
        id: "activity",
        title: "Activity",
        role: "activity",
        component: ActivityTab,
      },
    ],
    sessionControls: {
      scope: (agent) => config(agent.config).scope,
      state: (agent, place) => runtime.sessionState(agent, place),
      run: (agent, place, action) => runtime.session(agent, place, action),
      subscribe: (listener) => runtime.subscribe(listener),
    },
    models: (agent) => runtime.models(agent),
    run: (delivery) => runtime.run(delivery),
    runOnce: (turn) => runtime.runOnce(turn),
    // Its host reader cannot be stopped once started.
    readFile: (agent, path, signal) => {
      signal.throwIfAborted();
      return runtime.workspaceFile(agent, path);
    },
    timeoutMs: HANDOVER_MS,
  });
};
