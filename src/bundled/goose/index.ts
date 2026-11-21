import { repositoriesContext } from "../../features/communities/repositories";
import { usageOn } from "../../features/agents/standalone-sessions";
// goose agents: an agent type whose agents are goose on this computer, all in
// one `goose-acp` process. Each conversation an agent is in is one ACP session
// in it; goose answers with the in-process Buzz tools, served to it over
// loopback HTTP MCP.
import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { GooseLogoIcon } from "../../shared/design-system/icons";
import { GatewayForwarding } from "../../features/agents/gateway/forwarding";
import { upstreamFor } from "../../features/agents/gateway/route";
import {
  type Config,
  config,
  DEFAULT_CONFIG,
  GooseRuntime,
  running,
} from "./runtime";
import {
  type RecommendedCandidate,
  onRecommended,
  recommendedRun,
} from "../../features/agents/recommended";
import { REQUEST_TIMEOUT_MS } from "./goose";
import { gooseRun } from "./run";
import { readModelSettings } from "../../features/agents/model-settings";
import { explainTurn, GooseSetup, readNoProxy, REVIEW_REFUSED } from "./setup";
import { createTabs } from "./tabs";
import { GooseHistory } from "./transcript";
import { readUsage } from "./usage";

export const TYPE_ID = "goose";
/** The harness goose declares to the gateway, its descriptor upstream key. */
export const HARNESS = "goose";
export const inject = ["agents", "host", "agentProtection", "settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start `goose-acp`; no unusable type elsewhere.
  if (!isTauri()) return;
  const { agents, host } = ctx;
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.goose"}/${TYPE_ID}`;
  // goose is bundled: a candidate needs only its provider and model offered.
  const offered = (candidate: RecommendedCandidate) => setup.offers(candidate);
  const recommended = recommendedRun(TYPE_ID, offered);
  const runtime = new GooseRuntime(
    host,
    agents.relay,
    (key, signal) => agents.core(key, signal),
    localStorage,
    () => agents.tools(),
    repositoriesContext,
    agents.storage,
    recommended,
    // Without a goose upstream in this build, the runner sends every turn
    // without the gateway, so nothing forwards.
    ctx.pluginOwner && upstreamFor(HARNESS)
      ? new GatewayForwarding(
          ctx.pluginOwner,
          { upstream: HARNESS, native: "goose" },
          async () => {
            // Without a host to read them, a forwarded goose could send its
            // loopback requests to a proxy, so nothing opens.
            if (!host.spawn)
              throw new Error("No host to read proxy exceptions");
            return readNoProxy(host.spawn.bind(host));
          },
        )
      : undefined,
    // Read at a forwarded turn, after `setup` exists.
    () => setup.defaultProvider(),
  );
  runtime.usageOn = usageOn(ctx.settingsCards);
  const desktop =
    host.spawn && host.resolveDirectory
      ? {
          spawn: host.spawn.bind(host),
          resolveDirectory: host.resolveDirectory.bind(host),
        }
      : undefined;
  const setup = new GooseSetup(desktop, () => runtime.defaultsChanged());
  // Failed turns' reports link to where goose's provider keys are set up.
  runtime.explain = (error) =>
    explainTurn(
      error,
      `buzz://settings?section=agents&provider=${encodeURIComponent(typeKey)}`,
    );
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
    recommended,
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
    // Declares its harness to the gateway, which forwards its agents' turns
    // where their membership routes through it.
    gateway: { harness: HARNESS },
    retire: (pubkey) => runtime.retire(pubkey),
    protection: true,
    conversationFolders: true,
    conversationSections: true,
    notes: true,
    title: "Goose",
    icon: GooseLogoIcon,
    description:
      "goose on this computer, with any provider goose supports. Each thread it is mentioned in is one continuing session.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    settingsProposal: { compactAt: true, resolveRecommended: recommended.find },
    readModelSettings: (saved) =>
      readModelSettings(config(saved), {
        provider: true,
        recommended: onRecommended(saved),
      }),
    importShared: (source) =>
      source.runtime === "goose" || source.runtime === "goose-ai"
        ? {
            ...DEFAULT_CONFIG,
            model: source.model,
            provider: source.provider ?? "",
          }
        : undefined,
    exportShared: (saved) => {
      const { provider, model } = running(saved, recommended.current());
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
      scope: carry.sessionScope ?? saved.scope,
      workspace: carry.workspace ?? saved.workspace,
    }),
    carry: (saved) => {
      const { instructions, workspace, scope } = config(saved);
      return {
        ...(instructions.trim() && { instructions }),
        ...(workspace !== DEFAULT_CONFIG.workspace && { workspace }),
        ...(scope !== DEFAULT_CONFIG.scope && { sessionScope: scope }),
      };
    },
    summary: (agent) => {
      const { model, provider } = running(agent.config, recommended.current());
      return [provider, model].filter(Boolean).join(" · ") || "Goose";
    },
    sessions: {
      ready: (agentKey) => runtime.listed(agentKey),
      // The sessions `list` remembers are the latest 200 conversations; goose
      // keeps the rest, and finds them by tag.
      history: (agent, conversation) =>
        history.started(
          config(agent.config).workspace,
          agent.key,
          conversation,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ),
      list: (agentKey) => {
        const live = runtime.sessions(agentKey);
        const busy = new Map(live.map((view) => [view.key, view.busy]));
        const used = new Map(
          runtime.conversations(agentKey).map(({ key, at }) => [key, at]),
        );
        // Open ones are listed even when saving them failed. A one-off turn
        // joins no conversation.
        for (const { key, at } of live) if (at !== undefined) used.set(key, at);
        return [...used]
          .sort(([, a], [, b]) => b - a)
          .map(([key, at]) => {
            const { channelId, root, community } = runtime.source(
              agentKey,
              key,
            );
            const working = busy.get(key);
            return {
              channelId,
              ...(community && { community }),
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
      usage: async (agent, { since, signal }) =>
        runtime.withWakes(
          agent.key,
          await readUsage(
            history,
            agent.key,
            config(agent.config).workspace,
            since,
            signal,
            [...new Set(runtime.folders(agent.key).values())],
          ),
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
    recommends: offered,
    ...gooseRun(runtime),
  });
};
