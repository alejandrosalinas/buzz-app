// Host-owned protection bindings. Providers are installed plugins; model input
// cannot select an agent, a policy, or the provider that checks its action.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent, RegisteredAgentType } from "../agents/service";
import type { Host, HostProcess, ProcessProtection } from "../host/service";
import type {
  ReviewPrompt,
  ReviewModel,
  ReviewModelProvider,
  ProtectedSpawn,
} from "./models";

import {
  isTextSource,
  jsonPieces,
  snapshotJSON,
  writeJSON,
  type TextSource,
} from "./json-stream";

export type ProtectionBinding = Readonly<{ provider: string; policy: unknown }>;
export type ProtectionAction = Readonly<{
  kind: "context" | "tool" | "tool-result";
  session: string;
  content: unknown;
  command?: string;
}>;
export type ProtectionPhases = Readonly<
  Record<ProtectionAction["kind"], boolean>
>;
export const ALL_PHASES: ProtectionPhases = Object.freeze({
  context: true,
  tool: true,
  "tool-result": true,
});
export type ProtectionRequest = ProtectionAction &
  Readonly<{
    agent: Readonly<{ id: string; pubkey: string; name: string }>;
    relay: string;
    runtime: string;
    policy: unknown;
  }>;
/** A denial its provider explained, for Buzz to show people. */
export type ProtectionDenial = Readonly<{ allowed: false; reason: string }>;
export type ProtectionProvider = Readonly<{
  /** Streaming admission. No total size limit is imposed by Buzz. The provider
   * must consume the complete JSON evidence before approving. */
  checkEvidence(
    request: Omit<ProtectionRequest, "content">,
    evidence: TextSource,
    signal: AbortSignal,
  ): Promise<boolean | ProtectionDenial>;
  phases?(policy: unknown): ProtectionPhases;
  processProtection: ProcessProtection;
  /** Runtime owner to a process declared by this protection plugin. */
  runtimeProcesses?: Readonly<Record<string, string>>;
}>;
export type AgentProtection = Readonly<{
  phases?: ProtectionPhases;
  /** Changes when the saved policy or registered provider changes. */
  key: string;
  /** Stable native policy revision, for isolated durable runtime state. */
  stateKey: string;
  processProtection: ProcessProtection;
  /** Starts this agent's plugin-supplied engine under its captured containment. */
  spawn: ProtectedSpawn;
  assertAvailable(): void;
  check(action: ProtectionAction, signal: AbortSignal): Promise<void>;
  checkEvidence(
    action: Omit<ProtectionAction, "content">,
    evidence: TextSource,
    signal: AbortSignal,
  ): Promise<void>;
}>;
/** Its message is all the agent sees; `reason` is the provider's explanation,
 * for people. */
export class ProtectionDenied extends Error {
  readonly reason: string | undefined;
  constructor(reason?: string) {
    super("Agent action denied by its protection policy");
    this.reason = reason;
  }
}
// One bounded line of a provider's explanation, or none.
const explanation = (value: unknown) => {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join() !== "allowed,reason"
  )
    return undefined;
  const { allowed, reason } = value as Record<string, unknown>;
  if (allowed !== false || typeof reason !== "string") return undefined;
  const line = [...reason.replace(/[\p{C}\p{Z}\s]+/gu, " ").trim()];
  if (!line.length) return undefined;
  return line.length > 300 ? `${line.slice(0, 299).join("")}…` : line.join("");
};
export type ProtectionDefaults = {
  revision: number;
  defaults: ProtectionBinding | null;
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const validBinding = (value: unknown): value is ProtectionBinding => {
  if (!value || typeof value !== "object") return false;
  const { provider, policy } = value as ProtectionBinding;
  return (
    typeof provider === "string" &&
    /^[a-z0-9._-]{1,160}$/.test(provider) &&
    !!policy &&
    typeof policy === "object" &&
    !Array.isArray(policy) &&
    new TextEncoder().encode(JSON.stringify(policy)).length <= 32768
  );
};
const blank = (): ProtectionDefaults => ({ revision: 0, defaults: null });

export class AgentProtectionService extends Service {
  readonly available = true;
  readonly version = 3;
  readonly writeJSON = writeJSON;
  readonly encodeJSON = jsonPieces;
  private providers = new Map<
    string,
    {
      value: ProtectionProvider;
      abort: AbortController;
      epoch: number;
      spawn: Host["spawn"];
      /** Its review spawn for each model runtime, kept for its lifetime. */
      reviewers: Map<string, ProtectedSpawn>;
    }
  >();
  private epoch = 0;
  private modelProviders = new Map<string, ReviewModelProvider>();
  constructor(
    ctx: Context,
    private current: () => {
      owner: string | undefined;
      agents: readonly Agent[];
      types?: readonly Pick<
        RegisteredAgentType,
        "key" | "protection" | "protectionUnavailable"
      >[];
    },
    private native: {
      read(owner: string): Promise<ProtectionDefaults>;
      save(
        owner: string,
        revision: number,
        provider: string,
        policy: unknown | null,
      ): Promise<void>;
      update(
        pubkey: string,
        revision: number,
        provider: string,
        policy: unknown | null,
      ): Promise<void>;
    },
  ) {
    super(ctx, "agentProtection");
    ctx.effect(() => () => {
      for (const provider of this.providers.values()) provider.abort.abort();
      this.providers.clear();
    });
  }
  private owner() {
    const owner = this.current().owner;
    if (!owner || !/^[a-f0-9]{64}$/.test(owner))
      throw new Error("Connect to an agent community first");
    return owner;
  }
  private plugin() {
    const id = this.ctx.pluginOwner?.id;
    if (!id) throw new Error("Only an installed plugin configures protection");
    return id;
  }
  /** Each runtime retains credential and provider ownership. */
  registerModels(provider: ReviewModelProvider) {
    const id = this.plugin();
    this.modelProviders.set(id, provider);
    return this.ctx.effect(() => () => {
      if (this.modelProviders.get(id) === provider)
        this.modelProviders.delete(id);
    });
  }
  async modelChoices() {
    const rows = await Promise.all(
      [...this.modelProviders].map(async ([runtime, provider]) => ({
        runtime,
        label: provider.label,
        models: await provider.models().catch(() => []),
      })),
    );
    return rows;
  }
  /** Bounded, tool-free inference; the calling plugin owns prompts and parsing. */
  async complete(
    model: ReviewModel,
    prompt: ReviewPrompt,
    signal: AbortSignal,
    requester?: Readonly<{
      agent: Readonly<{ pubkey: string }>;
      relay: string;
    }>,
  ) {
    const caller = this.plugin();
    signal.throwIfAborted();
    if (model.runtime === "agent") {
      const agent =
        requester && /^[a-f0-9]{64}$/.test(requester.agent.pubkey)
          ? this.current().agents.find(
              (agent) =>
                agent.pubkey === requester.agent.pubkey &&
                agent.relay === requester.relay,
            )
          : undefined;
      if (!agent)
        throw new Error("The requesting agent is no longer available");
      const config = agent.config as { provider?: string; model?: string };
      model = {
        runtime: agent.type.split("/")[0] ?? "",
        provider: config.provider ?? "",
        id: config.model ?? "",
      };
    }
    const provider = this.modelProviders.get(model.runtime);
    if (!provider)
      throw new Error("The selected review model's runtime is unavailable");
    if (
      typeof prompt.system !== "string" ||
      (typeof prompt.input !== "string" && !isTextSource(prompt.input)) ||
      (prompt.outputSchema !== undefined &&
        (!prompt.outputSchema ||
          typeof prompt.outputSchema !== "object" ||
          Array.isArray(prompt.outputSchema)))
    )
      throw new Error("Invalid model completion prompt");
    const protection = this.providers.get(caller);
    // The same spawn for every review, so the runtime can keep its worker;
    // revoking the provider kills it.
    let spawn = protection?.reviewers.get(model.runtime);
    if (protection?.value.runtimeProcesses?.[model.runtime] && !spawn) {
      spawn = this.runtimeSpawn(caller, protection, model.runtime);
      protection.reviewers.set(model.runtime, spawn);
    }
    const result = await provider.complete(
      {
        id: model.id,
        ...(model.provider === undefined ? {} : { provider: model.provider }),
      },
      {
        ...copy({
          system: prompt.system,
          ...(prompt.outputSchema ? { outputSchema: prompt.outputSchema } : {}),
        }),
        input: isTextSource(prompt.input)
          ? {
              read: async function* () {
                for await (const part of (prompt.input as TextSource).read()) {
                  signal.throwIfAborted();
                  yield part;
                }
                signal.throwIfAborted();
              },
            }
          : prompt.input,
      },
      signal,
      spawn,
    );
    signal.throwIfAborted();
    if (this.modelProviders.get(model.runtime) !== provider)
      throw new Error("The review model's runtime changed");
    return {
      text: result.text,
      model: { ...result.model, runtime: model.runtime },
    };
  }
  async snapshot() {
    const { owner, agents, types } = this.current();
    const saved = owner ? await this.native.read(owner) : blank();
    return copy({
      revision: saved.revision,
      defaults: saved.defaults,
      agents: [
        ...new Map(agents.map((agent) => [agent.pubkey, agent])).values(),
      ]
        .filter((a) => a.place === "here" && a.owner === owner)
        .map((a) => ({
          id: a.pubkey,
          pubkey: a.pubkey,
          name: a.name,
          type: a.type,
          revision: a.protectionRevision ?? 0,
          binding: a.protection ?? null,
          coverage:
            types?.find((type) => type.key === a.type)?.protection === true
              ? { supported: true }
              : {
                  supported: false,
                  reason:
                    types?.find((type) => type.key === a.type)
                      ?.protectionUnavailable ??
                    "This runtime does not support complete protection checks.",
                },
        })),
    });
  }
  register(value: ProtectionProvider) {
    const id = this.plugin();
    if (
      typeof value.checkEvidence !== "function" ||
      !value.processProtection ||
      !Array.isArray(value.processProtection.readOnlyPaths) ||
      !Array.isArray(value.processProtection.hiddenPaths)
    )
      throw new Error("A protection provider needs a checker");
    if (
      value.runtimeProcesses !== undefined &&
      (!value.runtimeProcesses ||
        typeof value.runtimeProcesses !== "object" ||
        Array.isArray(value.runtimeProcesses) ||
        Object.entries(value.runtimeProcesses).some(
          ([runtime, process]) =>
            !/^[a-z0-9._-]{1,160}$/.test(runtime) ||
            typeof process !== "string" ||
            !/^[a-z0-9._-]{1,160}$/.test(process),
        ))
    )
      throw new Error("Invalid protected runtime processes");
    const host = this.ctx.host;
    const next = {
      value: {
        ...value,
        processProtection: copy(value.processProtection),
        runtimeProcesses: copy(value.runtimeProcesses ?? {}),
      },
      spawn: host?.spawn?.bind(host),
      abort: new AbortController(),
      epoch: ++this.epoch,
      reviewers: new Map<string, ProtectedSpawn>(),
    };
    this.providers.get(id)?.abort.abort();
    this.providers.set(id, next);
    const dispose = () => {
      next.abort.abort();
      if (this.providers.get(id) === next) this.providers.delete(id);
    };
    this.ctx.effect(() => dispose);
    return { dispose };
  }
  private runtimeSpawn(
    id: string,
    provider: NonNullable<ReturnType<typeof this.providers.get>>,
    runtime: string,
    agent?: Readonly<{ pubkey: string; relay: string }>,
  ): ProtectedSpawn {
    const processId = provider.value.runtimeProcesses?.[runtime];
    const spawn = provider.spawn;
    const assertAvailable = () => {
      if (provider.abort.signal.aborted || this.providers.get(id) !== provider)
        throw new Error("The required protection plugin is unavailable");
    };
    return async (options) => {
      assertAvailable();
      if (!processId || !spawn)
        throw new Error(
          "Install the protection plugin's complete runtime bundle",
        );
      let process: HostProcess | undefined;
      const stop = () => void process?.kill();
      const stopped = provider.abort.signal;
      stopped.addEventListener("abort", stop, { once: true });
      try {
        process = await spawn(processId, {
          ...options,
          protection: copy(provider.value.processProtection),
          ...(agent && { protectedAgent: agent }),
        });
        assertAvailable();
      } catch (error) {
        stopped.removeEventListener("abort", stop);
        await process?.kill();
        throw error;
      }
      void process.exited.finally(() =>
        stopped.removeEventListener("abort", stop),
      );
      return process;
    };
  }
  async saveDefaults(revision: number, policy: unknown | null) {
    const provider = this.plugin();
    if (policy !== null && !validBinding({ provider, policy }))
      throw new Error("Invalid protection policy");
    await this.native.save(this.owner(), revision, provider, copy(policy));
  }
  async saveAgent(pubkey: string, revision: number, policy: unknown | null) {
    const agent = this.current().agents.find(
      (a) => a.pubkey === pubkey && a.place === "here",
    );
    if (!agent || agent.owner !== this.owner())
      throw new Error("No such local agent in this community");
    const provider = this.plugin();
    if (policy !== null && !validBinding({ provider, policy }))
      throw new Error("Invalid protection policy");
    return this.native.update(pubkey, revision, provider, copy(policy));
  }
  bind(
    agent: Pick<
      Agent,
      | "pubkey"
      | "key"
      | "owner"
      | "name"
      | "type"
      | "relay"
      | "protection"
      | "protectionRevision"
    >,
  ): AgentProtection | undefined {
    if (!agent.protection) return;
    const binding = copy(agent.protection);
    const provider = this.providers.get(binding.provider);
    const phases = copy(
      provider?.value.phases?.(copy(binding.policy)) ?? ALL_PHASES,
    );
    if (
      Object.keys(phases).sort().join(",") !== "context,tool,tool-result" ||
      Object.values(phases).some((value) => typeof value !== "boolean")
    )
      throw new Error("Invalid protection phases");
    const membership = agent.key ?? agent.pubkey;
    const key = `${membership}:${binding.provider}:${agent.protectionRevision ?? 0}:${provider?.epoch ?? "missing"}`;
    const assertAvailable = () => {
      if (
        !provider ||
        provider.abort.signal.aborted ||
        this.providers.get(binding.provider) !== provider
      )
        throw new Error("The required protection plugin is unavailable");
    };
    const inspect = async (
      action: ProtectionAction,
      stopped: AbortSignal,
      input?: TextSource,
    ) => {
      stopped.throwIfAborted();
      assertAvailable();
      if (phases[action.kind] === false) return;
      if (!provider)
        throw new Error("The required protection plugin is unavailable");
      const deadline = new AbortController();
      const signal = AbortSignal.any([
        stopped,
        provider.abort.signal,
        deadline.signal,
      ]);
      const { content, ...metadata } = action;
      const request = copy({
        ...metadata,
        policy: binding.policy,
        agent: { id: agent.pubkey, pubkey: agent.pubkey, name: agent.name },
        relay: agent.relay,
        runtime: agent.type,
      });
      const owned = input ? undefined : snapshotJSON(content);
      let consumed = false,
        reading = false;
      const evidence: TextSource = {
        read: async function* () {
          if (reading) throw new Error("Evidence can be consumed only once");
          reading = true;
          for await (const part of input ? input.read() : jsonPieces(owned)) {
            signal.throwIfAborted();
            yield part;
          }
          signal.throwIfAborted();
          consumed = true;
        },
      };
      let stop!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        stop = () => reject(new Error("Protected action was cancelled"));
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
      });
      let allowed: unknown = false;
      let reason: string | undefined;
      const timeout = setTimeout(
        () =>
          deadline.abort(
            new DOMException(
              "The operation was aborted due to timeout",
              "TimeoutError",
            ),
          ),
        310_000,
      );
      try {
        allowed = await Promise.race([
          provider.value.checkEvidence(request, evidence, signal),
          cancelled,
        ]);
        reason = explanation(allowed);
      } catch {
        /* A failed checker denies. */
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", stop);
      }
      signal.throwIfAborted();
      if (allowed !== true || !consumed) throw new ProtectionDenied(reason);
    };
    return Object.freeze({
      key,
      phases: Object.freeze(phases),
      stateKey: `v4:${membership}:${binding.provider}:${agent.protectionRevision ?? 0}`,
      assertAvailable,
      spawn: provider
        ? this.runtimeSpawn(
            binding.provider,
            provider,
            agent.type.split("/")[0] ?? "",
            { pubkey: agent.pubkey, relay: agent.relay },
          )
        : async () => {
            throw new Error("The required protection plugin is unavailable");
          },
      processProtection: copy(
        provider?.value.processProtection ?? {
          readOnlyPaths: [],
          hiddenPaths: [],
        },
      ),
      check: (action: ProtectionAction, signal: AbortSignal) =>
        inspect(action, signal),
      checkEvidence: (
        action: Omit<ProtectionAction, "content">,
        evidence: TextSource,
        signal: AbortSignal,
      ) => inspect({ ...action, content: undefined }, signal, evidence),
    });
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    agentProtection: AgentProtectionService;
  }
}
