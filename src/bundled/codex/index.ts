import { nativeHookOutput } from "../hook-output";
import { CODEX_HOOK_EVENTS } from "./hook-bridge";
import { repositoriesContext } from "../../features/communities/repositories";
import { isTauri } from "@tauri-apps/api/core";
import { pubkeyOf } from "../../features/agents/membership";
import { ownerReads } from "../../features/agents/reads";
import type { PluginModule } from "../../plugins/api";
import { CodexLogoIcon } from "../../shared/design-system/icons";
import { type Config, config, defaults, validWorkspace } from "./config";
import { codexRun, TYPE_ID } from "./run";
import { CodexRuntime } from "./runtime";
import { CodexSetup, reviewHome, withScript } from "./setup";
import { CodexProvider, createTabs } from "./tabs";
import { readUsage } from "./usage";
import { reviewModel } from "./security-review";
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
    Create,
    CreateModel,
    createModelReportsReadiness: true,
    CreateThinking,
    importShared: (source) =>
      source.runtime === "codex" &&
      (!source.provider || source.provider === "openai")
        ? { ...defaults, model: source.model }
        : undefined,
    exportShared: (saved) => ({ runtime: "codex", model: config(saved).model }),
    adopt: (carry, saved) => ({
      ...saved,
      instructions: carry.instructions ?? saved.instructions,
      // Codex runs only in an absolute or home workspace.
      workspace:
        carry.workspace && validWorkspace(carry.workspace)
          ? carry.workspace
          : saved.workspace,
    }),
    carry: (saved) => {
      const { instructions, workspace } = config(saved);
      return {
        ...(instructions.trim() && { instructions }),
        ...(workspace !== defaults.workspace && { workspace }),
      };
    },
    describeMigration: (saved) => {
      const { model, effort, scope } = config(saved);
      return [
        { id: "model", label: "Model", isOverride: Boolean(model.trim()) },
        {
          id: "thinking",
          label: "Thinking",
          isOverride: Boolean(effort),
        },
        {
          id: "sessions",
          label: "Sessions",
          isOverride: scope !== defaults.scope,
          unchangedKey: scope,
        },
      ];
    },
    migrationWarning: "Any commands Codex left running will stop.",
    summary: (agent) => config(agent.config).model || "Codex",
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
          .map(({ key, channelId, root, at }) => {
            const status = views.get(key);
            return {
              channelId,
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
