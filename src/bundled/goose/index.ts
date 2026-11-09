import { repositoriesContext } from "../../features/communities/repositories";
// goose agents: an agent type whose agents are goose on this computer, all in
// one `goose-acp` process. Each conversation an agent is in is one ACP session
// in it; goose answers with the in-process Buzz tools, served to it over
// loopback HTTP MCP.
import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { GooseLogoIcon } from "../../shared/design-system/icons";
import { type Config, config, DEFAULT_CONFIG, GooseRuntime } from "./runtime";
import { gooseRun } from "./run";
import { GooseSetup, REVIEW_REFUSED } from "./setup";
import { createTabs } from "./tabs";
import { GooseHistory } from "./transcript";
import { readUsage } from "./usage";

export const TYPE_ID = "goose";

export const inject = ["agents", "host", "agentProtection"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start `goose-acp`; no unusable type elsewhere.
  if (!isTauri()) return;
  const { agents, host } = ctx;
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.goose"}/${TYPE_ID}`;
  const runtime = new GooseRuntime(
    host,
    agents.relay,
    (key, signal) => agents.core(key, signal),
    localStorage,
    () => agents.tools(),
    repositoriesContext,
    agents.storage,
  );
  const desktop =
    host.spawn && host.resolveDirectory
      ? {
          spawn: host.spawn.bind(host),
          resolveDirectory: host.resolveDirectory.bind(host),
        }
      : undefined;
  const setup = new GooseSetup(desktop, () => runtime.defaultsChanged());
  ctx.agentProtection.registerModels({
    label: "Goose",
    models: async () => {
      const { providers } = await setup.providers();
      const listed = await Promise.allSettled(
        providers
          .filter(
            (provider) =>
              provider.configured && !REVIEW_REFUSED.has(provider.id),
          )
          .map(async (provider) =>
            (await setup.models(provider.id)).map((model) => ({
              provider: provider.id,
              id: model.id,
              label: `${provider.name} · ${model.label}`,
            })),
          ),
      );
      return listed.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      );
    },
    complete: (model, prompt, signal, protectedSpawn) =>
      setup.review(model, prompt, signal, protectedSpawn),
  });
  const history = new GooseHistory(desktop);
  const {
    Create,
    CreateModel,
    CreateThinking,
    SettingsTab,
    ActivityTab,
    DefaultControl,
    ProviderDialogBody,
  } = createTabs({
    setup,
    runtime,
    history,
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
    retire: (pubkey) => runtime.retire(pubkey),
    protection: true,
    title: "Goose",
    icon: GooseLogoIcon,
    description:
      "goose on this computer, with any provider goose supports. Each thread it is mentioned in is one continuing session.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    importShared: (source) =>
      source.runtime === "goose" || source.runtime === "goose-ai"
        ? {
            ...DEFAULT_CONFIG,
            model: source.model,
            provider: source.provider ?? "",
          }
        : undefined,
    exportShared: (saved) => {
      const { provider, model } = config(saved);
      return { runtime: "goose", ...(provider && { provider }), model };
    },
    Create,
    CreateModel,
    CreateThinking,
    createModelReportsReadiness: true,
    provider: {
      snapshot: setup.snapshot,
      subscribe: setup.subscribe,
      check: setup.check,
      DialogBody: ProviderDialogBody,
      DefaultControl,
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
      return [provider, model].filter(Boolean).join(" · ") || "Goose";
    },
    sessions: {
      list: (key) => {
        const live = runtime.sessions(key);
        const busy = new Map(live.map((view) => [view.key, view.busy]));
        const used = new Map(
          runtime.conversations(key).map(({ key, at }) => [key, at]),
        );
        // Open ones are listed even when saving them failed. A one-off turn
        // joins no conversation.
        for (const { key, at } of live) if (at !== undefined) used.set(key, at);
        return [...used]
          .sort(([, a], [, b]) => b - a)
          .map(([key, at]) => {
            const [channelId = key, root] = key.split("/");
            const working = busy.get(key);
            return {
              channelId,
              ...(root && { root }),
              at,
              ...(working !== undefined && {
                status: working ? "Working" : "Idle",
              }),
            };
          });
      },
      subscribe: (listener) => runtime.subscribe(listener),
    },
    ...(desktop && {
      usage: (agent, { since, signal }) =>
        readUsage(
          history,
          agent.key,
          config(agent.config).workspace,
          since,
          signal,
        ),
    }),
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
    models: (agent) => setup.picks(config(agent.config)),
    ...gooseRun(runtime),
  });
};
