import { nativeHookOutput } from "../hook-output";
import { CODEX_HOOK_EVENTS } from "./hook-bridge";
import { repositoriesContext } from "../../features/communities/repositories";
import { isTauri } from "@tauri-apps/api/core";
import { pubkeyOf } from "../../features/agents/membership";
import { ownerReads, readyOwnerReads } from "../../features/agents/reads";
import type { PluginModule } from "../../plugins/api";
import { CodexLogoIcon } from "../../shared/design-system/icons";
import { type Config, config, defaults, validWorkspace } from "./config";
import { codexRun, TYPE_ID } from "./run";
import { CodexRuntime } from "./runtime";
import { CodexSetup, explainTurn, reviewHome, withScript } from "./setup";
import { CodexProvider, createTabs } from "./tabs";
import { readUsage } from "./usage";
import { reviewModel } from "./security-review";
import {
  candidatesFor,
  followRecommended,
  recommendationReady,
} from "../../features/agents/recommended";
import { AppServer, listModels } from "./rpc";
/** How often Buzz's copy of Codex looks for a new release. */
const UPDATE_MS = 6 * 60 * 60_000;
export const inject = ["agents", "host", "agentProtection"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start `codex`, and setup and file uploads run
  // `bash` and `base64`, which stock Windows lacks; no unusable type elsewhere.
  if (!isTauri() || !/Mac|Linux/i.test(navigator.platform)) return;
  const spawn = ctx.host.spawn && withScript(ctx.host.spawn.bind(ctx.host));
  const readFile = ctx.host.readFile?.bind(ctx.host);
  const setup = new CodexSetup(spawn, (input) => ctx.host.request(input));
  const start =
    spawn ??
    (async () => {
      throw new Error("Codex agents run only in the desktop app");
    });
  const providerController = new CodexProvider(
    start,
    ctx.agents.storage,
    setup,
    {
      request: (input) => ctx.host.request(input),
      ...(ctx.host.requestBytes
        ? { requestBytes: ctx.host.requestBytes.bind(ctx.host) }
        : {}),
    },
  );
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.codex"}/${TYPE_ID}`;
  const runtime = new CodexRuntime(
    start,
    (key) => ownerReads(ctx.agents.relay(key), pubkeyOf(key)),
    (key, signal) => ctx.agents.core(key, signal),
    ctx.agents.storage,
    (raw, remote) => providerController.resolve(raw, remote),
    () => ctx.agents.tools(),
    repositoriesContext,
    ctx.host.serveMcp
      ? {
          serve: ctx.host.serveMcp.bind(ctx.host),
          run: async (agent, session, event, input) => {
            return ((await ctx.agents.dispatchHook(
              typeKey,
              event,
              input,
              { agent, session },
              {
                accepts: (output) =>
                  !!output &&
                  typeof output === "object" &&
                  Object.keys(output).length > 0,
                milliseconds: event === "Interrupt" ? 2500 : 25000,
                compose: nativeHookOutput,
              },
            )) ?? {}) as Record<string, unknown>;
          },
        }
      : undefined,
    (key, session) => ctx.agents.execution(key, session),
    undefined,
    (key) => ctx.agents.inspectExecution(key),
    undefined,
    ctx.host,
    (pubkey) => ctx.agents.handle(pubkey),
    ctx.host.resolveDirectory?.bind(ctx.host),
    (agent, signal, channelId) =>
      readyOwnerReads(ctx.agents.relay(agent.key), agent, signal, channelId),
  );
  // Failed turns' notices link to where Codex signs in.
  runtime.explain = (notice) =>
    explainTurn(
      notice,
      `buzz://settings?section=agents&provider=${encodeURIComponent(typeKey)}`,
    );
  ctx.agentProtection.registerModels({
    label: "Codex",
    models: async () => {
      const rpc = new AppServer();
      try {
        await rpc.open(start);
        return (await listModels(rpc)).map((model) => ({
          id: model.model,
          label: model.displayName,
        }));
      } finally {
        await rpc.close();
      }
    },
    complete: (model, prompt, signal, protectedSpawn) =>
      reviewModel(protectedSpawn, model, prompt, signal, () =>
        reviewHome(start),
      ),
  });
  /** A Codex agent is running, so Buzz's copy is needed; unknown until the
   * agents have loaded. */
  let needed: boolean | undefined;
  // Agents that stop running stop their turns, and the last one stops the
  // server; switching communities or a reconnect does not.
  const sync = () => {
    const snapshot = ctx.agents.snapshot();
    if (snapshot.status === "loading") return;
    const running = snapshot.running.filter((agent) => agent.type === typeKey);
    runtime.sync(running);
    // Once loaded, and when the first Codex agent runs, the copy is brought
    // up to date; that is also when a first copy is downloaded.
    const was = needed;
    needed = running.some((agent) => !ctx.agents.executionBinding(agent.key));
    if (spawn && (was === undefined || (needed && !was))) {
      const updated = setup.update(needed);
      // Then, after the check that follows it (two first starts of Codex
      // race on its state), a usable copy's server starts so the first
      // mention skips its startup. One being installed is left to the mention.
      if (needed)
        void updated
          .then(() => providerController.check())
          .then(
            () => {
              if (
                needed &&
                !setup.snapshot().running &&
                providerController.snapshot().readiness === "ready"
              )
                runtime.warm();
            },
            () => undefined,
          );
    }
  };
  const offAgents = ctx.agents.subscribe(sync);
  const offProvider = providerController.subscribe(sync);
  sync();
  const timer =
    spawn && setInterval(() => void setup.update(needed ?? false), UPDATE_MS);
  ctx.effect(() => () => {
    needed = false;
    clearInterval(timer);
    offAgents();
    offProvider();
    providerController.dispose();
    runtime.dispose();
    setup.dispose();
  });
  const {
    Create,
    CreateModel,
    CreateThinking,
    DefaultControl,
    ProviderDialogBody,
    SettingsTab,
    ActivityTab,
  } = createTabs(providerController, runtime, start, setup, (key) =>
    ctx.agents.inspectExecution(key),
  );
  ctx.agents.register<Config>({
    id: TYPE_ID,
    conversationFolders: true,
    voice: async (seat) => {
      if (typeof RTCPeerConnection !== "function")
        throw new Error("Voice is unsupported on this device");
      // Protection is not known to review realtime input, so voice refuses it.
      if (seat.agent.protection)
        throw new Error("Voice is unavailable for protected agents");
      await setup.installed(seat.signal);
      const handle = ctx.agents.handle(seat.agent.key);
      if (!handle) throw new Error("The Codex agent is not running");
      return runtime.voice(seat, handle);
    },
    execution: true,
    hooks: { events: CODEX_HOOK_EVENTS },
    retire: (pubkey) => runtime.retire(pubkey),
    protection: true,
    title: "Codex",
    icon: CodexLogoIcon,
    description:
      "Codex on this computer, using its native coding tools and your account.",
    defaults: () => ({ config: { ...defaults } }),
    settingsProposal: {
      adapterModelAndEffort: true,
      compactAt: true,
      voice: true,
      apps: true,
      resolveRecommended: async () => {
        await recommendationReady();
        if (!candidatesFor(TYPE_ID).length) return null;
        if (providerController.recommended() === undefined)
          await providerController.check();
        return providerController.recommended() ?? null;
      },
    },
    readModelSettings: (saved, context) =>
      providerController.readModelSettings(saved, context),
    Create,
    CreateModel,
    createModelReportsReadiness: true,
    CreateThinking,
    importShared: (source) =>
      source.runtime === "codex" &&
      (!source.provider || source.provider === "openai")
        ? { ...defaults, model: source.model }
        : undefined,
    exportShared: (saved) => ({
      runtime: "codex",
      model: followRecommended(
        saved,
        config(saved),
        providerController.recommended(),
      ).model,
    }),
    adopt: (carry, saved) => ({
      ...saved,
      instructions: carry.instructions ?? saved.instructions,
      scope: carry.sessionScope ?? saved.scope,
      // Codex runs only in an absolute or home workspace.
      workspace:
        carry.workspace && validWorkspace(carry.workspace)
          ? carry.workspace
          : saved.workspace,
    }),
    carry: (saved) => {
      const { instructions, workspace, scope } = config(saved);
      return {
        ...(instructions.trim() && { instructions }),
        ...(workspace !== defaults.workspace && { workspace }),
        ...(scope !== defaults.scope && { sessionScope: scope }),
      };
    },
    describeMigration: (saved) => {
      const { model, effort, voice, apps } = config(saved);
      return [
        { id: "model", label: "Model", isOverride: Boolean(model.trim()) },
        {
          id: "thinking",
          label: "Thinking",
          isOverride: Boolean(effort),
        },
        { id: "voice", label: "Voice", isOverride: Boolean(voice) },
        // Another harness has no place for it, and Codex starts it off.
        { id: "apps", label: "Codex apps and plugins", isOverride: !!apps },
      ];
    },
    migrationWarning: "Any commands Codex left running will stop.",
    summary: (agent) =>
      followRecommended(
        agent.config,
        config(agent.config),
        providerController.recommended(),
      ).model || "Codex",
    recommends: (candidate) => providerController.recommends(candidate),
    ...(spawn &&
      readFile && {
        usage: async (agent, { since, signal }) => {
          if (await ctx.agents.inspectExecution(agent.key))
            throw new Error("Usage is unavailable for remote Codex agents.");
          return readUsage({ spawn, readFile }, agent, since, signal);
        },
      }),
    provider: {
      snapshot: providerController.snapshot,
      subscribe: providerController.subscribe,
      check: () => providerController.check(),
      DialogBody: ProviderDialogBody,
      DefaultControl,
    },
    sessions: {
      list: (key) => {
        const views = new Map(
          runtime.sessions(key).map((view) => [view.key, view.status]),
        );
        return runtime
          .conversations(key)
          .map(({ key, channelId, root, community, at }) => {
            const status = views.get(key);
            return {
              channelId,
              ...(community ? { community } : {}),
              ...(root && { root }),
              ...(at !== undefined && { at }),
              ...(status && { status }),
            };
          });
      },
      subscribe: runtime.subscribe,
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
    // A mention during the first download waits for it, within its deadline.
    ...codexRun(runtime, async (signal, agent) => {
      if (await ctx.agents.inspectExecution(agent)) return;
      await setup.installed(signal);
      if (providerController.snapshot().readiness === "checking")
        await providerController.check();
    }),
  });
};
