import { nativeHookOutput } from "../hook-output";
import { CLAUDE_HOOK_EVENTS } from "./hooks";
import { repositoriesContext } from "../../features/communities/repositories";
// Claude agents: an agent type whose agents are Claude sessions on
// this computer. Each conversation the agent is in is one continuing session;
// Claude answers with the in-process Buzz tools.
import { isTauri } from "@tauri-apps/api/core";
import { type ComponentType, createElement } from "react";
import { pubkeyOf } from "../../features/agents/membership";
import { ownerReads, readyOwnerReads } from "../../features/agents/reads";
import { withProviderWords } from "../../features/agents/failure-words";
import { refusedByBuzz } from "./auth";
import type { PluginModule } from "../../plugins/api";
import { ClaudeLogoIcon } from "../../shared/design-system/icons";
import { claudeRun, TYPE_ID } from "./run";
import {
  followRecommended,
  recommendedRun,
} from "../../features/agents/recommended";
import type { AgentHandle } from "../../features/agents/service";
import { ClaudeDefaults } from "./defaults";
import { HARNESS } from "./attribution";
import { routeFor, upstreamFor } from "../../features/agents/gateway/route";
import { ClaudeRuntime, type Config, config, DEFAULT_CONFIG } from "./runtime";
import { ClaudeSetup, withScript } from "./setup";
import { createTabs } from "./tabs";
import { targetKey } from "../../features/navigation/targets";
import type { ClaudeConnection } from "./ClaudeSettings";
import { readUsage } from "./usage";

export { TYPE_ID };
/** How often Buzz's copy of Claude looks for a new release. */
const UPDATE_MS = 6 * 60 * 60_000;

export const inject = [
  "agents",
  "host",
  "agentProtection",
  "navigation",
  "settingsCards",
];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start `claude`, and setup and file uploads run
  // `bash` and `base64`, which stock Windows lacks; no unusable type elsewhere.
  if (!isTauri() || !/Mac|Linux/i.test(navigator.platform)) return;
  const { agents, host } = ctx;
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.claude-code"}/${TYPE_ID}`;
  const spawn = host.spawn && withScript(host.spawn.bind(host));
  const readFile = host.readFile?.bind(host);
  const setup = new ClaudeSetup(spawn, (input) => host.request(input));
  // Older replacement auth implementations need not provide key management.
  const { Settings } = setup.auth as {
    Settings?: ComponentType<{
      setup: ClaudeSetup;
      active(): boolean;
      connection?: ClaudeConnection | undefined;
    }>;
  };
  if (Settings)
    ctx.settingsCards.register({
      id: "credentials",
      title: "Claude",
      icon: ClaudeLogoIcon,
      group: "Plugins",
      component: ({ active, navigation }) => {
        let connection: ClaudeConnection | undefined;
        if (navigation?.target.kind === "settings") {
          const { route, ...parent } = navigation.target;
          const target = {
            ...parent,
            route: { version: 1, params: "connect" },
          } as const;
          connection = {
            open: route?.version === 1 && route.params === "connect",
            onOpenChange(open) {
              if (!active()) return;
              if (open) {
                if (!navigation.signal.aborted)
                  void ctx.navigation.open(target);
              } else {
                ctx.navigation.dismiss(
                  (candidate) => targetKey(candidate) === targetKey(target),
                  parent,
                );
              }
            },
          };
        }
        return createElement(Settings, { setup, active, connection });
      },
    });
  ctx.agentProtection.registerModels({
    label: "Claude",
    models: async () =>
      (await setup.catalog()).map((model) => ({
        id: model.value,
        label: model.displayName ?? model.value,
      })),
    complete: (model, prompt, signal) => setup.review(model, prompt, signal),
  });
  // A candidate needs Claude signed in and its model and level listed.
  const recommended = recommendedRun(TYPE_ID, (candidate) =>
    setup.offers(candidate),
  );
  const providerDefaults = new ClaudeDefaults(agents.storage, recommended);
  /** What an agent on Recommended runs on, found before its first run. */
  const follow = (agent: AgentHandle | undefined) =>
    providerDefaults.follow(
      agents.snapshot().running.find((item) => item.key === agent?.key)?.config,
    );
  // No turn starts without credentials.
  const runtime = new ClaudeRuntime(
    {
      ...(spawn ? { spawn: setup.auth.authorize(spawn, true) } : {}),
      ...(host.resolveDirectory
        ? { resolveDirectory: host.resolveDirectory.bind(host) }
        : {}),
    },
    (key) => ownerReads(agents.relay(key), pubkeyOf(key)),
    (key, signal) => agents.core(key, signal),
    agents.storage,
    (raw, remote) => (remote ? config(raw) : providerDefaults.resolve(raw)),
    () => agents.tools(),
    repositoriesContext,
    async (agent, session, event, input) => {
      return ((await agents.dispatchHook(
        typeKey,
        event,
        input,
        { agent, session },
        {
          accepts: (output) =>
            !!output &&
            typeof output === "object" &&
            Object.keys(output).length > 0,
          milliseconds: 25000,
          compose: nativeHookOutput,
        },
      )) ?? {}) as Record<string, unknown>;
    },
    (key, session) => agents.execution(key, session),
    (key) => agents.inspectExecution(key),
    (key) => !!agents.executionBinding(key),
    undefined,
    undefined,
    (agent, signal, channelId) =>
      readyOwnerReads(agents.relay(agent.key), agent, signal, channelId),
    // A session control's route, as the runner decides a turn's.
    (key) => {
      const route = routeFor(key);
      return route.kind === "eligible" &&
        route.harnesses.includes(HARNESS) &&
        upstreamFor(HARNESS)
        ? route
        : undefined;
    },
  );
  /** A Claude agent is running, so Buzz's copy is needed; unknown until the
   * agents have loaded. */
  let needed: boolean | undefined;
  const sync = () => {
    const snapshot = agents.snapshot();
    // Agents that stop running, the app signing out included, stop their
    // processes; switching communities does not.
    if (snapshot.status === "loading") return;
    const running = snapshot.running.filter((agent) => agent.type === typeKey);
    runtime.sync(running);
    // Once loaded, and when the first Claude agent runs, the copy is brought
    // up to date; that is also when a first copy is downloaded.
    const was = needed;
    needed = running.some((agent) => !agents.executionBinding(agent.key));
    if (was === undefined || (needed && !was)) void setup.update(needed);
  };
  // One spare session waits for whichever running agent needs it next.
  if (spawn) {
    const unsubscribe = agents.subscribe(sync);
    const unsubscribeDefaults = providerDefaults.subscribe(sync);
    const unsubscribeAuth = setup.auth.subscribe(() => runtime.restart());
    sync();
    const timer = setInterval(
      () => void setup.update(needed ?? false),
      UPDATE_MS,
    );
    ctx.effect(() => () => {
      clearInterval(timer);
      unsubscribe();
      unsubscribeDefaults();
      unsubscribeAuth();
      runtime.dispose();
      setup.dispose();
    });
  }

  const destination = Settings
    ? { section: `${ctx.pluginOwner?.id ?? "buzz.claude-code"}/credentials` }
    : { section: "agents", provider: typeKey };
  const settingsLink = `buzz://settings?${new URLSearchParams(destination)}`;
  const openSetup = () =>
    void ctx.navigation.open({ version: 1, kind: "settings", ...destination });
  // Failed turns' reports link to the same place, then quote Claude. Buzz's
  // own refusal to start Claude isn't Claude's words, and the link says it.
  runtime.explain = (error) => {
    const explained = setup.auth.explainTurn(error, settingsLink);
    return explained === error || refusedByBuzz(error)
      ? explained
      : withProviderWords(explained, "Claude", error);
  };
  const {
    Create,
    CreateAction,
    CreateConfiguration,
    CreateModel,
    CreateThinking,
    DefaultControl,
    ProviderDialogBody,
    SettingsTab,
    ActivityTab,
  } = createTabs({
    setup,
    defaults: providerDefaults,
    runtime,
    openSetup,
    recommended,
  });
  agents.register<Config>({
    id: TYPE_ID,
    // Declares its harness to the gateway, which attributes its turns. Only
    // attributes: Claude keeps its own endpoint, so the route never holds
    // or fails a turn.
    gateway: { harness: HARNESS, mode: "attribution" },
    execution: true,
    conversationFolders: true,
    conversationSections: true,
    notes: true,
    hooks: { events: CLAUDE_HOOK_EVENTS },
    retire: (pubkey) => runtime.retire(pubkey),
    protection: true,
    title: "Claude",
    icon: ClaudeLogoIcon,
    description:
      "Claude on this computer. Each thread it is mentioned in is one continuing session.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    settingsProposal: {
      compactAt: "unprotected",
      resolveRecommended: recommended.find,
    },
    readModelSettings: (saved, context) =>
      providerDefaults.readModelSettings(saved, context),
    Create,
    CreateAction,
    CreateConfiguration,
    CreateModel,
    createModelReportsReadiness: true,
    CreateThinking,
    importShared: (source) =>
      source.runtime === "claude" &&
      (!source.provider || source.provider === "anthropic")
        ? { ...DEFAULT_CONFIG, model: source.model }
        : undefined,
    exportShared: (saved) => ({
      runtime: "claude",
      model: followRecommended(saved, config(saved), recommended.current())
        .model,
    }),
    recommends: (candidate) => setup.offers(candidate),
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
    describeMigration: (saved) => {
      const { model, effort } = config(saved);
      return [
        { id: "model", label: "Model", isOverride: Boolean(model.trim()) },
        { id: "thinking", label: "Thinking", isOverride: Boolean(effort) },
      ];
    },
    summary: (agent) =>
      followRecommended(
        agent.config,
        config(agent.config),
        recommended.current(),
      ).model || "Claude",
    ...(spawn &&
      readFile && {
        usage: async (agent, { since, signal }) => {
          if (await agents.inspectExecution(agent.key))
            throw new Error("Usage is unavailable for remote Claude agents.");
          // Its workspace's sessions, and those of each conversation folder.
          const found = await Promise.all(
            runtime
              .sessionPlaces(agent.key, config(agent.config).workspace)
              .map(({ place, saved, standalone }) =>
                readUsage(
                  { spawn, readFile },
                  place,
                  agent.key,
                  saved,
                  since,
                  signal,
                  standalone,
                ),
              ),
          );
          return found.flat().sort((a, b) => b.lastAt - a.lastAt);
        },
      }),
    provider: {
      snapshot: setup.providerSnapshot,
      subscribe: setup.subscribe,
      check: () => setup.check(),
      /** Settings' row updates or signs in with one click. A missing copy
       * has no action: its row opens DialogBody, so the download note is
       * seen before the download starts. */
      get attentionAction() {
        const state = setup.snapshot();
        if (state.running) return undefined;
        return state.status?.state === "outdated"
          ? () => void setup.run("install")
          : state.status?.state === "signed-out" && setup.auth.signIn
            ? () => void setup.run("sign-in")
            : undefined;
      },
      DialogBody: ProviderDialogBody,
      DefaultControl,
    },
    sessions: {
      list: (key) => {
        const busy = new Map(
          runtime.sessions(key).map((view) => [view.key, view.busy]),
        );
        return runtime
          .conversations(key)
          .map(({ key, channelId, root, community, at }) => {
            const working = busy.get(key);
            return {
              channelId,
              ...(community ? { community } : {}),
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
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        splitSettings: true,
        reconcilesConfig: true,
        component: SettingsTab,
      },
      {
        id: "activity",
        title: "Activity",
        role: "activity",
        component: ActivityTab,
      },
    ],
    // A mention during the first download waits for it, within its deadline.
    ...claudeRun(runtime, async (signal, agent) => {
      // A remote target runs Recommended on its own default.
      if (agent && (await agents.inspectExecution(agent.key))) return;
      await (agent?.protection
        ? setup.protectedInstalled(signal, () => runtime.room())
        : setup.installed(signal));
      await follow(agent);
    }),
  });
};
