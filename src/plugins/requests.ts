// What an agent may do with this device's plugins. Reading is direct; a
// change that starts or deletes plugin code is a request the person using
// Buzz confirms on a card in the agent's conversation, or in Settings, since
// plugins are not sandboxed.
import { gitScope } from "./git-scope";
import { samePluginRelease } from "./same-release";
import type {
  Catalog,
  ManagedPlugins,
  ManagementAction,
  PluginImports,
} from "./types";

export type PluginRequester = Readonly<{
  pubkey: string;
  name: string;
  /** Whether the agent can still ask; a removed agent's requests are refused. */
  live?(): boolean;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Absent where no plugin manager runs. */
    pluginRequests?: PluginRequests;
  }
}
export type PluginRequests = ReturnType<typeof createPluginRequests>;

export type PluginRequestAction = "install" | "update" | "enable" | "remove";
/** A change an agent asked for, waiting for the person using Buzz. */
export type PluginRequest = Readonly<{
  id: string;
  requester: Readonly<{ pubkey: string; name: string }>;
  action: PluginRequestAction;
  pluginId: string;
  pluginName: string;
  /** What install and update review: the commit the agent saw, so the code
   * the owner confirms cannot change after the request. */
  source?: Readonly<{
    repository: string;
    reference: string;
    path: string;
    commit: string;
  }>;
  /** The agent's own words, shown to the owner as plain text. */
  reason: string;
}>;
export type PluginRequestInput = Readonly<{
  action: PluginRequestAction;
  id?: string | undefined;
  repository?: string | undefined;
  reference?: string | undefined;
  path?: string | undefined;
  commit?: string | undefined;
  reason: string;
}>;
type Decision = "approved" | "declined";
export type DecidedPluginRequest = PluginRequest & { state: Decision };

/** As agent creation drafts are: few, and only until the app restarts. */
const PENDING_MAX = 16;
/** Decisions an agent can still read back. */
const SETTLED_MAX = 64;
const REASON_MAX = 500;
/** Settings enables these only after checking admin access. */
const ADMIN_PLUGINS = ["buzz.moderation", "buzz.relay-staff"];
/** The native import signs a Buzz-hosted repository's read with the owner's
 * key (see `relay::git_repository`), which an agent must not trigger. */
const BUZZ_HOSTED = /^\/git\/[0-9a-f]{64}\/[^/]+\/?$/i;
/** Native code trims Unicode whitespace, U+0085 among it, which `new URL`
 * does not. A string this side cannot read as Buzz-hosted could be one there. */
const UNTRIMMED = /[\s\p{Cc}]/u;
const buzzHosted = (repository: string) => {
  try {
    return BUZZ_HOSTED.test(new URL(repository).pathname);
  } catch {
    return false;
  }
};

/** The plugin operations one agent's tools reach, bound to that agent. */
export type AgentPlugins = ReturnType<
  ReturnType<typeof createPluginRequests>["forAgent"]
>;

export function createPluginRequests({
  catalog,
  imports,
  change,
  error,
  managed = () => undefined,
}: Readonly<{
  /** The current catalog; undefined while settings load or need recovery. */
  catalog(): Catalog | undefined;
  imports: PluginImports | undefined;
  change(action: ManagementAction, id: string): Promise<boolean>;
  /** The last management error, after `change` returns false. */
  error(): string | null;
  /** The organization's recommendations, which an agent must not bypass. */
  managed?(): ManagedPlugins | undefined;
}>) {
  let pending: readonly PluginRequest[] = [];
  const settled = new Map<string, DecidedPluginRequest>();
  const listeners = new Set<() => void>();
  const log = (request: PluginRequest, state: string) =>
    console.info("plugin_request", {
      id: request.id,
      action: request.action,
      pluginId: request.pluginId,
      requester: request.requester.pubkey,
      state,
    });
  const plugins = () => {
    const current = catalog();
    if (!current)
      throw new Error("Plugin settings are not ready. Try again shortly.");
    return current.plugins;
  };
  const installed = (id: string) => {
    const plugin = plugins().find((item) => item.manifest.id === id);
    if (!plugin) throw new Error(`No plugin ${id} is installed`);
    return plugin;
  };
  async function apply(action: ManagementAction, id: string) {
    if (!(await change(action, id)))
      throw new Error(error() ?? "Plugin settings are busy. Try again.");
  }
  const gitImports = () => {
    if (!imports) throw new Error("Plugin installs require the desktop app");
    return imports;
  };
  // A recommended plugin installs and updates only at the commit its policy
  // pins, from Settings.
  const conflict = (id: string) => {
    const policy = managed();
    return policy?.status === "ready" &&
      policy.plugins.some((item) => item.id === id)
      ? `${id} follows ${policy.source}'s recommendation; install or update it from the recommendation in Settings`
      : undefined;
  };
  const unmanaged = (id: string) => {
    const refusal = conflict(id);
    if (refusal) throw new Error(refusal);
  };
  async function check(
    repository: string,
    reference: string,
    commit?: string,
    path?: string,
  ) {
    if (UNTRIMMED.test(repository))
      throw new Error(
        "repository must not contain whitespace or control characters",
      );
    if (buzzHosted(repository))
      throw new Error(
        "Ask your owner to add plugins from Buzz-hosted repositories in Settings",
      );
    const scope = gitScope(commit, path);
    const preview = scope.length
      ? await gitImports().checkGit(repository, reference, undefined, ...scope)
      : await gitImports().checkGit(repository, reference);
    if (!preview?.candidates.length)
      throw new Error(
        ["No built plugins found.", ...(preview?.warnings ?? [])].join(" "),
      );
    return preview;
  }
  async function pinned(
    repository: string,
    reference: string,
    wanted: string | undefined,
    path?: string,
  ) {
    const preview = await check(repository, reference, wanted, path);
    const commit = preview.commit?.toLowerCase();
    if (!commit) throw new Error("The repository did not report a commit");
    if (wanted && wanted.toLowerCase() !== commit)
      throw new Error(`The repository is at ${commit}, not ${wanted}`);
    return { preview, commit };
  }
  async function install(input: PluginRequestInput) {
    if (!input.repository) throw new Error("repository is required to install");
    const reference = input.reference ?? "";
    const { preview, commit } = await pinned(
      input.repository,
      reference,
      input.commit,
      input.path,
    );
    const paths = preview.candidates.map((item) => item.path).join(", ");
    const candidate = input.path
      ? preview.candidates.find((item) => item.path === input.path)
      : preview.candidates.length === 1
        ? preview.candidates[0]
        : undefined;
    if (!candidate)
      throw new Error(
        input.path
          ? `No built plugin at ${input.path}. Found: ${paths}`
          : `Choose a path: ${paths}`,
      );
    const { id, name } = candidate.manifest;
    if (input.id && input.id !== id)
      throw new Error(
        `The plugin at ${candidate.path} is ${id}, not ${input.id}`,
      );
    unmanaged(id);
    const existing = plugins().find((item) => item.manifest.id === id);
    if (existing?.source === "bundled")
      throw new Error("That plugin id is reserved");
    if (existing)
      throw new Error(`${id} is already installed; request an update`);
    return {
      pluginId: id,
      pluginName: name,
      source: {
        repository: input.repository,
        reference,
        path: candidate.path,
        commit,
      },
    };
  }
  async function target(input: PluginRequestInput) {
    if (input.action === "install") return install(input);
    if (!input.id) throw new Error(`id is required to ${input.action}`);
    const plugin = installed(input.id);
    const { id, name } = plugin.manifest;
    const bundled = plugin.source === "bundled";
    if (input.action === "enable" && plugin.enabled)
      throw new Error(`${id} is already enabled`);
    if (input.action === "enable" && bundled && ADMIN_PLUGINS.includes(id))
      throw new Error(`${id} needs admin access; enable it in Settings`);
    if (input.action === "remove" && bundled)
      throw new Error("Bundled plugins cannot be removed");
    if (input.action !== "update") return { pluginId: id, pluginName: name };
    if (bundled) throw new Error("Bundled plugins update with Buzz");
    unmanaged(id);
    const recorded = plugin.updateSource;
    if (!recorded || !("repository" in recorded))
      throw new Error(`${id} was not installed from Git`);
    const reference = input.reference ?? recorded.reference;
    const { preview, commit } = await pinned(
      recorded.repository,
      reference,
      input.commit,
      recorded.path,
    );
    const where = reference || "The default branch";
    const candidate = preview.candidates.find(
      (item) => item.path === recorded.path && item.manifest.id === id,
    );
    if (!candidate)
      throw new Error(`${where} has no ${id} at ${recorded.path}`);
    if (samePluginRelease(candidate, plugin))
      throw new Error(`${id} is already at ${where}'s version`);
    return {
      pluginId: id,
      pluginName: name,
      source: {
        repository: recorded.repository,
        reference,
        path: recorded.path,
        commit,
      },
    };
  }

  function forAgent(requester: PluginRequester) {
    return {
      async list() {
        return {
          plugins: plugins().map((plugin) => {
            const source = plugin.updateSource;
            const waiting = pending.find(
              (item) => item.pluginId === plugin.manifest.id,
            );
            return {
              id: plugin.manifest.id,
              name: plugin.manifest.name,
              enabled: plugin.enabled,
              bundled: plugin.source === "bundled",
              revision: plugin.revision,
              source:
                plugin.source === "bundled"
                  ? { kind: "bundled" as const }
                  : source && "repository" in source
                    ? {
                        kind: "git" as const,
                        repository: source.repository,
                        reference: source.reference,
                        ...(source.commit && { commit: source.commit }),
                      }
                    : { kind: "folder" as const },
              ...(waiting && {
                pendingRequest: { id: waiting.id, action: waiting.action },
              }),
            };
          }),
        };
      },
      // Disabling stops code and is undone by an enable request, so it needs
      // no review.
      async disable(id: string) {
        installed(id);
        if (id === "buzz.channels")
          throw new Error("Channels is required and cannot be disabled");
        await apply("disable", id);
        console.info("plugin_disable", {
          pluginId: id,
          requester: requester.pubkey,
        });
        return { id, enabled: false as const };
      },
      async discover(repository: string, reference = "") {
        const preview = await check(repository, reference);
        const installed = new Set(plugins().map((item) => item.manifest.id));
        return {
          commit: preview.commit,
          candidates: preview.candidates.map(({ path, manifest }) => ({
            path,
            id: manifest.id,
            name: manifest.name,
            apiVersion: manifest.apiVersion,
            ...(manifest.host && { host: manifest.host }),
            alreadyInstalled: installed.has(manifest.id),
          })),
        };
      },
      async request(input: PluginRequestInput) {
        const reason = input.reason.trim();
        if (!reason) throw new Error("reason is required");
        if (reason.length > REASON_MAX)
          throw new Error(`reason must be at most ${REASON_MAX} characters`);
        const change = await target(input);
        // Checked after reading the repository, which takes a while.
        if (requester.live && !requester.live())
          throw new Error("The requesting agent is no longer available");
        if (pending.some((item) => item.pluginId === change.pluginId))
          throw new Error(
            `A request for ${change.pluginId} is already pending`,
          );
        if (pending.length >= PENDING_MAX)
          throw new Error("Review the pending plugin requests first");
        const request: PluginRequest = {
          id: crypto.randomUUID(),
          requester: { pubkey: requester.pubkey, name: requester.name },
          action: input.action,
          ...change,
          reason,
        };
        pending = [...pending, request];
        log(request, "pending");
        notify();
        return {
          requestId: request.id,
          applied: false as const,
          action: request.action,
          pluginName: request.pluginName,
        };
      },
      status(requestId: string) {
        const request =
          pending.find((item) => item.id === requestId) ??
          settled.get(requestId);
        // Unknown ids include every request from before the app restarted.
        if (request?.requester.pubkey !== requester.pubkey)
          return { state: "expired" as const };
        return {
          state: "state" in request ? request.state : ("pending" as const),
          action: request.action,
          pluginId: request.pluginId,
        };
      },
    };
  }
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    forAgent,
    /** Why a queued install or update can no longer be confirmed: a
     * recommendation added since the request now sets its commit. */
    conflict,
    /** Oldest first, for the owner to review. */
    pending: () => pending,
    /** A request the owner has settled on this device, until the app restarts
     * or newer decisions push it out. The same object each time, as a
     * subscriber's snapshot. */
    decided: (id: string) => settled.get(id),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Records the owner's decision once the reviewed change is applied, or
     * refused. */
    settle(id: string, state: Decision) {
      const request = pending.find((item) => item.id === id);
      if (!request) return;
      pending = pending.filter((item) => item !== request);
      settled.set(id, { ...request, state });
      for (const old of settled.keys()) {
        if (settled.size <= SETTLED_MAX) break;
        settled.delete(old);
      }
      log(request, state);
      notify();
    },
  };
}
