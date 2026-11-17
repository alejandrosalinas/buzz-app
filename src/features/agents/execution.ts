import type { Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";
import type { HostProcess, HostProcessOptions } from "../host/service";
import type { JsonValue } from "../navigation/targets";
import { AGENT_KEY, type AgentKey } from "./membership";
import type { AgentStore } from "./store";

export type AgentExecutionBinding = Readonly<{
  provider: string;
  config?: JsonValue;
}>;

export type AgentExecutionSession = Readonly<{
  key: string;
  intent: "new" | "existing";
  /** Aborting any open for this session ends its shared execution lifetime. */
  signal?: AbortSignal;
}>;

export type AgentExecutionTarget = Readonly<{
  workspace: string;
  spawn(program: string, options?: HostProcessOptions): Promise<HostProcess>;
  readFile(
    path: string,
    options?: Readonly<{ cwd?: string }>,
  ): Promise<Uint8Array>;
  resolveDirectory(path: string): Promise<string>;
  /** Shares pending cleanup and retries failed cleanup. */
  dispose(): Promise<void>;
}>;

export type AgentExecutionProvider = Readonly<{
  id: string;
  harnesses: readonly string[];
  connect(
    binding: AgentExecutionBinding,
    session: Readonly<{
      agent: AgentKey;
      key: string;
      intent: "new" | "existing";
      signal: AbortSignal;
    }>,
  ): Promise<AgentExecutionTarget>;
}>;

export type AgentExecution = AgentExecutionTarget &
  Readonly<{
    signal: AbortSignal;
  }>;

const PREFIX = "buzz.agent.execution.v1:";
const LOCAL = '"local"';
const ID = /^[a-z0-9][a-z0-9._-]*$/;
const TYPE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
function validate(binding: AgentExecutionBinding) {
  if (
    !TYPE.test(binding?.provider) ||
    Object.keys(binding).some((key) => key !== "provider" && key !== "config")
  )
    throw new Error("Invalid agent execution selection");
}

export function createAgentExecutions(root: Context, storage: AgentStore) {
  let stopped = false;
  const providers = createContributions<AgentExecutionProvider>(root);
  const bindingInFlight = new Set<AgentKey>();
  const opened = new Map<
    string,
    {
      harness: string;
      provider: string;
      revision: string;
      lifetime: AbortController;
      signal: AbortSignal;
      promise: Promise<AgentExecution>;
      execution: AgentExecution | undefined;
    }
  >();
  /** Each validated agent's last parsed binding with its text: name lookups
   * read every agent's binding per label, so unchanged text skips the parse. */
  const parsed = new Map<
    AgentKey,
    { text: string | null; binding: AgentExecutionBinding | undefined }
  >();
  /** Changes when a binding save starts and when it settles, and with each
   * storage change another window reports, so callers can skip rereading
   * every binding until it does. */
  let bindingChanges = 0;
  root.effect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(PREFIX)) bindingChanges++;
    };
    globalThis.addEventListener?.("storage", changed);
    return () => globalThis.removeEventListener?.("storage", changed);
  });
  const read = (agent: AgentKey): AgentExecutionBinding | undefined => {
    const last = parsed.get(agent);
    if (!last && !AGENT_KEY.test(agent))
      throw new Error("Invalid agent membership key");
    const text = storage.get(PREFIX + agent);
    if (last?.text === text) return last.binding;
    const binding = parse(text);
    parsed.set(agent, { text, binding });
    return binding;
  };
  const parse = (text: string | null): AgentExecutionBinding | undefined => {
    if (text === null || text === LOCAL) return;
    const binding = JSON.parse(text) as AgentExecutionBinding;
    validate(binding);
    return Object.freeze(binding);
  };
  const inspect = async (agent: AgentKey) => {
    if (!AGENT_KEY.test(agent)) throw new Error("Invalid agent membership key");
    if (bindingInFlight.has(agent))
      throw new Error("The execution binding is being saved");
    return parse(await storage.read(PREFIX + agent));
  };
  const providerFor = (binding: AgentExecutionBinding, harness: string) => {
    const provider = providers
      .snapshot()
      .find((item) => item.key === binding.provider);
    if (!provider)
      throw new Error(
        `Agent execution provider ${binding.provider} is unavailable`,
      );
    if (!provider.harnesses.includes(harness))
      throw new Error(`Agent execution provider does not support ${harness}`);
    return provider;
  };
  root.effect(() =>
    providers.subscribe(() => {
      for (const entry of opened.values())
        if (
          !providers
            .snapshot()
            .some(
              (provider) =>
                provider.key === entry.provider &&
                provider.revision === entry.revision,
            )
        )
          entry.lifetime.abort(
            new Error("The agent execution provider changed"),
          );
    }),
  );
  root.effect(() => () => {
    stopped = true;
    for (const entry of opened.values())
      entry.lifetime.abort(new Error("The agent execution stopped"));
  });
  return {
    read,
    bindingChanges: () => bindingChanges,
    inspect,
    register(ctx: Context, provider: AgentExecutionProvider) {
      if (
        !ID.test(provider.id) ||
        !provider.harnesses.length ||
        typeof provider.connect !== "function"
      )
        throw new Error(
          "An execution provider needs an id, harnesses and connect",
        );
      for (const harness of provider.harnesses)
        if (!ctx.pluginOwner?.agentExecution?.includes(harness))
          throw new Error(`Declare host.agentExecution access for ${harness}`);
      providers.register(ctx, {
        ...provider,
        harnesses: Object.freeze([...provider.harnesses]),
      });
    },
    async bind(
      ctx: Context,
      agent: AgentKey,
      harness: string,
      input: Readonly<{ id: string; config?: JsonValue }>,
    ) {
      if (!ctx.pluginOwner || !ID.test(input.id))
        throw new Error("Invalid execution provider");
      const binding = Object.freeze({
        provider: `${ctx.pluginOwner.id}/${input.id}`,
        ...(input.config === undefined ? {} : { config: input.config }),
      });
      validate(binding);
      providerFor(binding, harness);
      if (!AGENT_KEY.test(agent))
        throw new Error("Invalid agent membership key");
      const text = JSON.stringify(binding);
      if (bindingInFlight.has(agent))
        throw new Error("The execution binding is being saved");
      bindingInFlight.add(agent);
      try {
        if ((await storage.read(PREFIX + agent)) === LOCAL)
          await storage.set(PREFIX + agent, null);
        // The copy holds the binding as soon as the save starts.
        bindingChanges++;
        const saved = await storage.add(PREFIX + agent, text);
        if (saved !== text)
          throw new Error("The agent already has another execution binding");
      } finally {
        bindingInFlight.delete(agent);
        bindingChanges++;
      }
    },
    async check(agent: AgentKey, harness: string) {
      const saved = await inspect(agent);
      if (saved) providerFor(saved, harness);
    },
    async open(
      ctx: Context,
      agent: AgentKey,
      harness: string,
      session: AgentExecutionSession,
    ): Promise<AgentExecution | undefined> {
      if (!ctx.pluginOwner || !harness.startsWith(`${ctx.pluginOwner.id}/`))
        throw new Error("Only the native harness can open its agent execution");
      if (stopped) throw new Error("Agent execution is stopped");
      if (
        typeof session?.key !== "string" ||
        !session.key.trim() ||
        session.key.length > 512 ||
        [...session.key].some((character) => character.charCodeAt(0) < 32) ||
        (session.intent !== "new" && session.intent !== "existing")
      )
        throw new Error("Invalid execution session");
      session.signal?.throwIfAborted();
      if (bindingInFlight.has(agent))
        throw new Error("The execution binding is being saved");
      const key = JSON.stringify([agent, session.key]);
      const join = (entry: NonNullable<ReturnType<typeof opened.get>>) => {
        if (entry.harness !== harness)
          throw new Error("The execution session belongs to another harness");
        if (session.signal) {
          const caller = session.signal;
          const abort = () => entry.lifetime.abort(caller.reason);
          caller.addEventListener("abort", abort, { once: true });
          entry.signal.addEventListener(
            "abort",
            () => caller.removeEventListener("abort", abort),
            { once: true },
          );
        }
        return entry.promise;
      };
      const current = opened.get(key);
      if (current && !current.signal.aborted) return join(current);
      const saved = await inspect(agent);
      if (stopped) throw new Error("Agent execution is stopped");
      session.signal?.throwIfAborted();
      if (!saved) return;
      const provider = providerFor(saved, harness);
      const held = opened.get(key);
      if (held && !held.signal.aborted) return join(held);
      const lifetime = new AbortController();
      const signal = session.signal
        ? AbortSignal.any([lifetime.signal, session.signal])
        : lifetime.signal;
      const entry = {
        harness,
        provider: provider.key,
        revision: provider.revision,
        lifetime,
        signal,
        promise: undefined as unknown as Promise<AgentExecution>,
        execution: undefined as AgentExecution | undefined,
      };
      opened.set(key, entry);
      signal.addEventListener(
        "abort",
        () => {
          if (opened.get(key) === entry) opened.delete(key);
          void entry.execution
            ?.dispose()
            .catch((error) =>
              console.error(
                `Agent ${agent} session ${session.key} cleanup failed`,
                error,
              ),
            );
        },
        { once: true },
      );
      const connect = async () => {
        const connecting = Promise.resolve().then(() => {
          signal.throwIfAborted();
          return provider.connect(saved, {
            agent,
            key: session.key,
            intent: session.intent,
            signal,
          });
        });
        let aborted!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
          aborted = () => reject(signal.reason);
          signal.addEventListener("abort", aborted, { once: true });
        });
        let target: AgentExecutionTarget | undefined;
        try {
          target = await Promise.race([connecting, cancelled]);
          signal.throwIfAborted();
          if (
            typeof target.workspace !== "string" ||
            !target.workspace.startsWith("/") ||
            [...target.workspace].some(
              (character) => character.charCodeAt(0) < 32,
            )
          )
            throw new Error("The execution target needs an absolute workspace");
          const execution = wrap(target);
          entry.execution = execution;
          return execution;
        } catch (error) {
          lifetime.abort(error);
          if (target) await target.dispose();
          else
            void connecting
              .then(
                (late) => late.dispose(),
                () => {},
              )
              .catch((cleanup) =>
                console.error(
                  `Agent ${agent} session ${session.key} cleanup failed`,
                  cleanup,
                ),
              );
          throw error;
        } finally {
          signal.removeEventListener("abort", aborted);
        }
      };
      const wrap = (target: AgentExecutionTarget): AgentExecution => {
        const processes = new Set<HostProcess>();
        const check = () => {
          signal.throwIfAborted();
          if (!providers.snapshot().includes(provider))
            throw new Error("The agent execution provider changed");
        };
        let disposed: Promise<void> | undefined;
        const execution: AgentExecution = Object.freeze({
          workspace: target.workspace,
          signal,
          spawn: async (program, options) => {
            check();
            if (options?.mcp || options?.protection)
              throw new Error(
                "This execution path does not support native MCP servers or containment",
              );
            const process = await target.spawn(program, options);
            if (signal.aborted) {
              await process.kill();
              signal.throwIfAborted();
            }
            processes.add(process);
            void process.exited.then(() => processes.delete(process));
            return Object.freeze({
              write: async (data: string) => {
                check();
                await process.write(data);
              },
              end: async (data?: string) => {
                check();
                await process.end(data);
              },
              kill: () => process.kill(),
              exited: process.exited,
            });
          },
          readFile: async (path, options) => {
            check();
            const data = await target.readFile(path, options);
            check();
            return data;
          },
          resolveDirectory: async (path) => {
            check();
            const directory = await target.resolveDirectory(path);
            check();
            return directory;
          },
          dispose: () => {
            disposed ??= Promise.resolve()
              .then(() =>
                Promise.all([...processes].map((process) => process.kill())),
              )
              .then(() => undefined)
              .finally(() => target.dispose())
              .catch((error) => {
                disposed = undefined;
                throw error;
              });
            lifetime.abort(new Error("The agent execution stopped"));
            return disposed;
          },
        });
        return execution;
      };
      entry.promise = connect();
      return entry.promise;
    },
  };
}
