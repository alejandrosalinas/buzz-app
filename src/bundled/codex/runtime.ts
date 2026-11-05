import type {
  AgentExecution,
  AgentExecutionSession,
} from "../../features/agents/execution";
import { CodexExecution } from "./execution";
import { callbackHookArgs, openHookBridge } from "./hook-bridge";
import type { Host } from "../../features/host/service";
import { nativeHookState } from "./hooks";
import { isFinalMessage } from "../../buzz-mcp/session-tools";
import type { WorkOutcome } from "../../features/agents/local-activity";
import type { AgentProtection } from "../../features/agent-protection/service";
import { nativeProtectionBridge } from "../../features/agent-protection/native-bridge";
import { fromOwner, workflowOf } from "../../features/agents/owner-attestation";
import {
  type ConversationWake,
  wakeAnchor,
  wakeLands,
} from "../../features/agent-harness/plugin-wake";
import type { AgentKey } from "../../features/agents/membership";
import type { AgentReads } from "../../features/agents/reads";
import {
  EACH_TURN,
  sessionPrompts,
} from "../../features/agents/session-prompts";
import { localStore, type AgentStore } from "../../features/agents/store";
import type {
  Agent,
  AgentHandle,
  Agents,
  Delivery,
  Models,
  StandaloneTurn,
  TurnResult,
} from "../../features/agents/service";
import type { EventData } from "../../features/relay/events";
import type { ChannelLabel } from "../../features/channels/channel-icon";
import { appClient, readFile } from "../../buzz-mcp/app-client";
import { readProject } from "../../features/agent-harness/project";
import { RESUMED_PROMPT } from "../../buzz-mcp/prompt";
import { MemoryReads } from "../../features/agent-harness/core-memory";
import { SessionControls } from "../../features/agent-harness/session-control";
import type {
  SessionPlace,
  SessionControlAction,
  SessionState,
} from "../../features/agents/service";
import type { Context } from "../../buzz-mcp/client";
import {
  type AddedTool,
  addedKey,
  callSessionTool,
  sessionHint,
  sessionTools,
  turnNote,
} from "../../buzz-mcp/session-tools";
import {
  config,
  resolveModel,
  defaults,
  absoluteWorkspace,
  effortName,
  validWorkspace,
  type Config,
} from "./config";
import { unsupportedSynced } from "../../features/agents/agent-config";
import { conversationHistory } from "./history";
import { buzzHome } from "./setup";
import {
  developerInstructions,
  rootOf,
  sessionName,
  turnContext,
  turnInput,
  type Conversation,
} from "./prompt";
import {
  AppServer,
  listModels,
  Refused,
  type Spawn,
  type ToolCall,
  type ToolReply,
} from "./rpc";
import { findConversation } from "./transcript";

type Request = {
  current?: () => boolean;
  /** The agent's community and owner, as `origin:viewer`. */
  scope: string;
  event: EventData;
  agent: AgentHandle;
  settings: Config;
  conversation: Conversation;
  /** A plugin's wake, for which `event` is its local anchor. */
  wake?: ConversationWake;
  wakeText?: Delivery["wakeText"];
  /** Latest request's thread, independent of session scope; absent in DMs. */
  toolRoot?: string;
  /** The agent's team sections, if it is on a team. */
  team: string;
  /** The Solo chat's workspace Canvas section, if it has one. */
  project?: string;
  /** The model and effort the owner picked for this turn. */
  model?: string;
  effort?: string;
  /** The synced settings in `settings`. */
  synced?: Delivery["synced"];
  /** Called once a final send answers this request, or one steered after it,
   * a steering rejection is posted in its place, or the turn ends normally.
   * `stopped` is that the owner's interrupt ended the turn. */
  answered: (stopped?: boolean) => void;
  /** A failed final delivery stays pending until this request gets a reply. */
  finalDelivery?: Error | true;
  step?: (tool: string, target?: string) => void;
  acknowledged?: () => void;
  superseded?: () => void;
  /** Takes a title for a new Solo chat; see `Delivery.named`. */
  named?: (title: string) => void;
  failActivity(reason: string): void;
  /** Given again after a reload stopped its turn partway. */
  resumed?: true;
  /** Notes plugins left for this turn, taken when its input is first built:
   * one that fails or is cancelled before then leaves them for the next. */
  notes?: readonly string[];
};
/** `at` is when the binding last took in a message or ended a turn; bindings
 * saved before it existed have none. `tools` is the `addedKey` of the
 * thread's tools, absent when plugins added none. `protection` is the
 * `stateKey` of the protection the thread ran under, absent when unprotected;
 * only a run under the same state resumes it. */
type Saved = {
  threadId: string;
  workspace: string;
  at?: number;
  tools?: string;
  /** A lost first-turn response must not be treated as an empty session. */
  pending?: true;
  protection?: string;
};
type Active = {
  /** The server this turn runs on; steering must reach the same process. */
  rpc: AppServer;
  threadId?: string;
  turnId?: string;
  ready: Promise<void>;
  steering: Promise<void>;
  reply: Request;
  finished: boolean;
  /** The owner stopped it, so its interruption is not reported. */
  stopped?: boolean;
  /** The one interrupt every Stop of this turn shares. */
  stopping?: Promise<void>;
  /** What the turn runs on, once resolved; a differing pick queues a turn. */
  model?: string;
  effort?: string;
  workspace: string;
  signal: AbortSignal;
  /** Every request this turn has taken in, the first and each steered one. */
  requests: Request[];
  /** Latest acknowledged mention per Buzz thread; independent of session scope. */
  activity: Map<string, Request>;
};
/** A watch or timer turn on an ephemeral thread of its own. Its tools have
 * no default destination and it answers no request. */
type Once = {
  threadId?: string;
  turnId?: string;
  finished: boolean;
  signal: AbortSignal;
  workspace: string;
  agent: AgentHandle;
  scope: string;
  /** Settles once the turn has ended and let go of its thread. */
  released: Promise<void>;
};
type Lane = {
  tail: Promise<void>;
  /** Turns waiting on `tail` to start; steering past them would reorder. */
  queued: number;
  active?: Active;
};
type Entry = {
  storageKey: string;
  abort: AbortController;
  /** Settles once the same agent's previous run has let go of its threads. */
  after: Promise<void>;
  lanes: Map<string, Lane>;
  saved: Record<string, Saved>;
  /** Standalone turns now running, for their tool calls to find. */
  onces: Set<Once>;
  /** Requests delivered and not yet taken into a turn, nor ended. */
  waiting: Set<Request>;
};
type Server = {
  protection?: AgentProtection;
  rpc: AppServer;
  opening: Promise<AppServer>;
  /** Threads this process has loaded, and the agent, by key, each belongs to. */
  threads: Map<string, AgentKey>;
  /** Starts a turn of a thread. What it returns takes why the provider refused
   * that turn's model input, if it said. */
  explainer?(threadId: string): () => string | undefined;
};
export type SessionView = { key: string; status: string; detail: string };
/** A saved binding, newest first, for the owner's transcript list, with the
 * channel's name and kind when this community lists it. */
export type SavedConversation = Partial<ChannelLabel> & {
  key: string;
  channelId: string;
  root?: string;
  threadId: string;
  at?: number;
};
/** How long a stopped turn's shells are looked for, and how often. Codex hands
 * one over about 50ms after the turn ends. */
const STOP_LINGER_MS = 1_000;
const LINGER_POLL_MS = 100;
/** The binding a run under `protection` may resume: threads never cross
 * protection state keys, protected or not. */
const resumable = (
  saved: Saved | undefined,
  protection: Pick<AgentProtection, "stateKey"> | undefined,
) => (saved?.protection === protection?.stateKey ? saved : undefined);
const input = (text: string) => [{ type: "text", text, text_elements: [] }];
/** Codex's own small model for titles, and its title rules. */
const TITLE_MODEL = "gpt-5.6-luna";
const TITLE_SCHEMA = {
  type: "object",
  properties: { title: { type: "string", minLength: 1, maxLength: 36 } },
  required: ["title"],
  additionalProperties: false,
};
const titlePrompt = (text: string) =>
  `Generate a concise, single-line task title of at most 36 characters and under five words where possible. Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.\n\nUser prompt:\n${[...text].slice(0, 800).join("")}`;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
/** Puts back the notes a request took, for a turn that never took it in. */
function restoreNotes(request: Request) {
  if (request.notes)
    request.agent.restoreNotes?.(
      request.conversation.channelId,
      request.notes,
      request.conversation.root,
    );
}
/** The note at the end of a request's turn input, if any. */
function noteOf(request: Request) {
  request.notes ??=
    request.agent.notes?.(
      request.conversation.channelId,
      request.conversation.root,
    ) ?? [];
  const notes = [
    request.resumed ? RESUMED_PROMPT : undefined,
    ...request.notes,
    turnNote(request.agent),
  ].filter(Boolean);
  return notes.length ? notes.join("\n\n") : undefined;
}
function textOf(event: EventData, name: string) {
  let text = event.content.trim().replace(/^🤖\s+/, "");
  if (text.startsWith(`@${name}`)) text = text.slice(name.length + 1).trim();
  return text;
}

/** Local agents share one app-server. Each remote session owns its server.
 * Each conversation carries its agent's workspace, instructions and tools.
 * Tool calls find their agent by thread and turn. */
export class CodexRuntime {
  private remote = new Map<
    string,
    {
      agent: AgentKey;
      runtime: CodexRuntime;
      execution: AgentExecution;
    }
  >();
  private disposed = false;
  private opening = new Map<
    string,
    {
      agent: AgentKey;
      abort: AbortController;
      ready: Promise<CodexRuntime>;
    }
  >();
  private entries = new Map<AgentKey, Entry>();
  private actions = new Map<
    AgentKey,
    Set<{ abort: AbortController; done: Promise<void> }>
  >();
  private server: Server | undefined;
  private protectedServers = new Map<AgentKey, Server>();
  private stopping = new Map<AgentKey, Promise<void>>();
  private stopped = new Map<AgentKey, Entry>();
  private disposals = new Map<
    AgentKey,
    Map<AgentExecution, { done: Promise<void>; failed: boolean }>
  >();
  private views = new Map<AgentKey, readonly SessionView[]>();
  private inventories = new Map<AgentKey, SavedConversation[] | null>();
  private inventoryReads = new Map<AgentKey, object>();
  private inventoryVersions = new Map<AgentKey, number>();
  private listeners = new Set<() => void>();
  /** Read-only model discovery, kept until effective model settings change. */
  private previews = new Map<
    AgentKey,
    { key: string; ready: Promise<Models> }
  >();
  private memoryReads = new MemoryReads();
  constructor(
    private readonly spawn: Spawn,
    /** What each agent's turns read of its community, while it can be read. */
    private readonly reads: (key: AgentKey) => AgentReads | undefined,
    /** The agent's `core` memory as the host keeps it (`Agents.core`). */
    private readonly core: Agents["core"],
    private readonly storage: AgentStore = localStore(),
    private readonly resolveConfig: (
      raw: unknown,
      remote?: boolean,
    ) => Config = config,
    /** The tools plugins add to every thread now. */
    private readonly added: () => readonly AddedTool[] = () => [],
    /** Desktop-local repository instructions; standalone hosts keep their own layout. */
    private readonly repositories: (scope: string | undefined) => string = () =>
      "",
    private readonly hooks?: {
      serve: NonNullable<Host["serveMcp"]>;
      run(
        agent: string,
        session: string,
        event: string,
        input: unknown,
      ): Promise<Record<string, unknown>>;
    },
    private readonly execution?: Agents["execution"],
    private readonly target?: AgentExecution,
    private readonly inspect?: Agents["inspectExecution"],
    private readonly targetKey?: string,
    private readonly protectionHost?: Pick<Host, "spawn" | "serveMcp">,
    private readonly handle: (pubkey: string) => AgentHandle | undefined = () =>
      undefined,
  ) {}
  private executionKey(agent: AgentKey, scope: string, conversation: string) {
    return `buzz.codex.sessions.execution.v1:${scope}:${agent}:${conversation}`;
  }
  private sessionRecord(text: string): {
    key: string;
    intent: "new" | "existing";
  } {
    const value = JSON.parse(text);
    if (
      !value ||
      typeof value.key !== "string" ||
      !value.key ||
      (value.intent !== "new" && value.intent !== "existing")
    )
      throw new Error("Invalid saved execution session");
    return value;
  }
  private async connection(
    agent: AgentKey,
    scope: string,
    conversation: string,
    signal?: AbortSignal,
  ): Promise<CodexRuntime> {
    if (this.disposed) throw new Error("Codex runtime is disposed");
    if (!this.execution || !(await this.inspect?.(agent))) return this;
    const key = this.executionKey(agent, scope, conversation);
    const held = this.remote.get(key);
    if (held && !held.execution.signal.aborted) return held.runtime;
    const pending = this.opening.get(key);
    if (pending) return pending.ready;
    const abort = new AbortController();
    const cancel = () => abort.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const lifetime = abort.signal;
    const ready = (async () => {
      const stored = this.sessionRecord(
        (await this.storage.read(key)) ??
          (await this.storage.add(
            key,
            JSON.stringify({ key: crypto.randomUUID(), intent: "new" }),
          )),
      );
      const sessionKey = stored.key;
      lifetime.throwIfAborted();
      const savedKey = this.storageKey(scope, agent, sessionKey);
      const saved = this.load(
        savedKey,
        await this.storage.read(savedKey),
        true,
      );
      const session: AgentExecutionSession = {
        key: sessionKey,
        intent: stored.intent,
        signal: lifetime,
      };
      const execution = await this.execution?.(agent, session);
      if (this.disposed || lifetime.aborted) {
        if (execution) await this.disposeExecution(agent, execution);
        throw new Error("Codex runtime is retired");
      }
      if (!execution) return this;
      try {
        if (stored.intent === "new")
          await this.storage.set(
            key,
            JSON.stringify({ key: sessionKey, intent: "existing" }),
          );
        lifetime.throwIfAborted();
        execution.signal.throwIfAborted();
      } catch (error) {
        await this.disposeExecution(agent, execution);
        throw error;
      }
      const transport = new CodexExecution(execution);
      const runtime = new CodexRuntime(
        transport.spawn,
        (key) => (key === agent ? this.reads(key) : undefined),
        this.core,
        this.storage,
        (raw) => ({
          ...this.resolveConfig(raw, true),
          workspace: execution.workspace,
        }),
        this.added,
        () => "",
        this.hooks && { serve: transport.serve, run: this.hooks.run },
        undefined,
        execution,
        undefined,
        sessionKey,
      );
      const update = () => {
        this.views.set(
          agent,
          [...this.remote.values()]
            .filter((entry) => entry.agent === agent)
            .flatMap((entry) => entry.runtime.sessions(agent)),
        );
        for (const listener of this.listeners) listener();
      };
      runtime.entry(agent, scope, saved);
      runtime.subscribe(update);
      this.remote.set(key, { agent, runtime, execution });
      execution.signal.addEventListener(
        "abort",
        () => {
          runtime.dispose();
          update();
        },
        { once: true },
      );
      return runtime;
    })();
    this.opening.set(key, { agent, abort, ready });
    for (const listener of this.listeners) listener();
    try {
      return await ready;
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (this.opening.get(key)?.ready === ready) this.opening.delete(key);
      for (const listener of this.listeners) listener();
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  sessions = (agent: AgentKey): readonly SessionView[] =>
    this.views.get(agent) ?? EMPTY;
  private readonly controls = new SessionControls(() => {
    for (const listener of this.listeners) listener();
  });
  private controlKey(agent: Agent, place: SessionPlace) {
    return JSON.stringify([
      place.channelId,
      this.resolveConfig(agent.config).scope === "channel"
        ? "channel"
        : (place.root ?? "channel"),
    ]);
  }
  sessionState(agent: Agent, place: SessionPlace): SessionState {
    const scope = this.reads(agent.key)?.scope;
    const remoteKey =
      scope &&
      this.executionKey(agent.key, scope, this.controlKey(agent, place));
    const remote = remoteKey ? this.remote.get(remoteKey) : undefined;
    const key = this.controlKey(agent, place);
    if (this.controls.compacting(`${agent.key}/${key}`)) return "compacting";
    if (remote?.runtime.sessionState(agent, place) === "compacting")
      return "compacting";
    if (this.controls.active(`${agent.key}/${key}`)) return "active";
    if (remote) return remote.runtime.sessionState(agent, place);
    if (remoteKey && this.opening.has(remoteKey)) return "active";
    return this.controls.active(`${agent.key}/${key}`) ||
      this.entries.get(agent.key)?.lanes.has(key)
      ? "active"
      : "idle";
  }
  session(agent: Agent, place: SessionPlace, action: SessionControlAction) {
    const abort = new AbortController();
    const pending = {
      abort,
      done: this.changeSession(agent, place, action, abort.signal),
    };
    const actions = this.actions.get(agent.key) ?? new Set();
    this.actions.set(agent.key, actions);
    actions.add(pending);
    return pending.done.finally(() => {
      actions.delete(pending);
      if (!actions.size) this.actions.delete(agent.key);
    });
  }
  private async changeSession(
    agent: Agent,
    place: SessionPlace,
    action: SessionControlAction,
    lifetime: AbortSignal,
  ): Promise<void> {
    const reads = this.reads(agent.key);
    const remote = await this.inspect?.(agent.key);
    lifetime.throwIfAborted();
    if (reads && remote) {
      const conversation = this.controlKey(agent, place);
      const key = this.executionKey(agent.key, reads.scope, conversation);
      if (action === "interrupt") {
        if (this.controls.interrupt(`${agent.key}/${conversation}`)) return;
        const pending = this.opening.get(key);
        if (pending) {
          pending.abort.abort();
          return;
        }
        const held = this.remote.get(key);
        if (held && !held.execution.signal.aborted)
          await held.runtime.session(agent, place, action);
        return;
      }
      if (this.sessionState(agent, place) !== "idle")
        throw new Error("Wait for the active turn to finish first.");
      if (action === "new")
        return this.controls.run(
          `${agent.key}/${conversation}`,
          action,
          async () => {
            await this.storage.set(
              key,
              JSON.stringify({ key: crypto.randomUUID(), intent: "new" }),
            );
            this.inventoryReads.delete(agent.key);
            this.inventories.set(
              agent.key,
              (this.inventories.get(agent.key) ?? []).filter(
                (row) => row.key !== conversation,
              ),
            );
            this.inventoryVersions.set(
              agent.key,
              this.conversationVersion(agent.key) + 1,
            );
            const prior = this.remote.get(key);
            this.remote.delete(key);
            prior?.runtime.dispose();
            if (prior) await this.disposeExecution(agent.key, prior.execution);
            this.views.set(
              agent.key,
              [...this.remote.values()]
                .filter((entry) => entry.agent === agent.key)
                .flatMap((entry) => entry.runtime.sessions(agent.key)),
            );
            for (const listener of this.listeners) listener();
          },
        );
      if ((await this.storage.read(key)) === null) {
        throw new Error("There is no session here to compact yet.");
      }
      const runtime = await this.connection(
        agent.key,
        reads.scope,
        conversation,
        lifetime,
      );
      return runtime.session(agent, place, action);
    }
    if (!reads) throw new Error("Connect to the agent's community first.");
    const key = this.controlKey(agent, place);
    const control = `${agent.key}/${key}`;
    const entry = this.entry(agent.key, reads.scope);
    if (action === "interrupt") {
      if (this.controls.interrupt(control)) return;
      const active = entry.lanes.get(key)?.active;
      if (active) await this.interrupt(entry, key, active.reply);
      return;
    }
    if (this.sessionState(agent, place) !== "idle")
      throw new Error("Wait for the active turn to finish first.");
    return this.controls.run(control, action, async (cancel) => {
      const signal = AbortSignal.any([entry.abort.signal, cancel, lifetime]);
      signal.throwIfAborted();
      const saved = entry.saved[key];
      if (action === "new") {
        if (!saved) return;
        delete entry.saved[key];
        try {
          await this.storage.set(entry.storageKey, JSON.stringify(entry.saved));
        } catch (error) {
          entry.saved[key] = saved;
          throw error;
        }
        this.forget(agent.key, key);
        return;
      }
      if (agent.protection && !this.handle(agent.key)?.protection)
        throw new Error("The protected agent has no live policy binding");
      const thread = resumable(saved, this.handle(agent.key)?.protection);
      if (!thread) throw new Error("There is no session here to compact yet.");
      const server = this.open(this.handle(agent.key));
      const rpc = await server.opening;
      const settings = this.resolveConfig(agent.config);
      const workspace = await this.workspace(settings.workspace);
      if (workspace !== thread.workspace)
        throw new Error(
          "The workspace changed. Send a message to start its session first.",
        );
      const { params, bridge } = await this.prepare(
        rpc,
        agent,
        settings,
        workspace,
        {},
      );
      try {
        signal.throwIfAborted();
        bridge?.bind(thread.threadId);
        await rpc.request("thread/resume", {
          ...params,
          threadId: thread.threadId,
          excludeTurns: true,
        });
        signal.throwIfAborted();
        await this.compact(rpc, signal, thread.threadId, agent.key, key);
        this.status(agent.key, key, "Idle");
      } catch (error) {
        this.status(
          agent.key,
          key,
          signal.aborted ? "Interrupted" : "Needs attention",
          message(error),
        );
        throw error;
      } finally {
        await bridge?.close();
        await rpc
          .request("thread/unsubscribe", { threadId: thread.threadId })
          .catch(() => undefined);
      }
    });
  }
  preview(agent: Agent): Promise<Models> {
    const handle = this.handle(agent.key);
    if (handle?.protection) this.assertRetired(agent.key, true);
    if (agent.protection && !handle?.protection)
      throw new Error("The protected agent has no live policy binding");
    handle?.protection?.assertAvailable();
    const settings = this.resolveConfig(agent.config);
    const key = JSON.stringify([
      settings.model,
      settings.effort,
      handle?.protection?.key,
    ]);
    const existing = this.previews.get(agent.key);
    if (existing?.key === key) return existing.ready;
    const ready = Promise.resolve().then(async () => {
      const binding = await this.inspect?.(agent.key);
      if (this.disposed) throw new Error("Codex runtime is disposed");
      if (this.previews.get(agent.key) !== entry)
        throw new Error("Codex model preview is retired");
      if (binding) {
        const remote = this.resolveConfig(agent.config, true);
        return {
          current: remote.model,
          sendDefaults: true,
          models: remote.model
            ? [{ id: remote.model, label: remote.model, efforts: [] }]
            : [],
        };
      }
      const server = this.open(handle);
      const rpc = server.rpc;
      await server.opening;
      const models = await listModels(rpc);
      const model = resolveModel(settings.model, models);
      const offered = models.map((row) => {
        const efforts = row.supportedReasoningEfforts.map(
          ({ reasoningEffort: id }) => ({ id, label: effortName(id) }),
        );
        // As a run picks it: the configured effort if the model has it.
        const effort = efforts.some((level) => level.id === settings.effort)
          ? settings.effort
          : row.defaultReasoningEffort;
        return {
          id: row.model,
          label: row.displayName || row.model,
          efforts,
          ...(effort ? { effort } : {}),
        };
      });
      // A configured model this Codex does not list still leaves the
      // listed ones to pick, so the picker stays.
      return !model || models.some((row) => row.model === model)
        ? { current: model ?? "", models: offered, sendDefaults: true }
        : {
            current: model,
            sendDefaults: true,
            models: [{ id: model, label: model, efforts: [] }, ...offered],
          };
    });
    const entry = { key, ready };
    this.previews.set(agent.key, entry);
    void ready.catch(() => {
      if (this.previews.get(agent.key) === entry)
        this.previews.delete(agent.key);
    });
    return ready;
  }

  private async workspace(path: string) {
    if (this.target) return this.target.resolveDirectory(this.target.workspace);
    if (absoluteWorkspace(path)) return path;
    let directory = "";
    const process = await this.spawn("workspace", {
      cwd: path,
      onStdout: (data) => {
        directory += data;
      },
    });
    const code = await process.exited;
    const workspace = directory.trim();
    if (code !== 0 || !absoluteWorkspace(workspace))
      throw new Error(`Could not resolve the Codex workspace ${path}.`);
    return workspace;
  }
  /** Copies `threadId` from the user's Codex home, if it is there. */
  private async adopt(threadId: string) {
    if (this.target) return;
    const process = await this.spawn("adopt", { args: [threadId] });
    await process.exited;
  }
  private status(agent: AgentKey, key: string, status: string, detail = "") {
    // A stopped agent's draining turns don't bring its sessions back.
    if (!this.entries.has(agent)) return;
    const others = this.sessions(agent).filter((view) => view.key !== key);
    this.views.set(agent, [
      ...others.slice(-31),
      { key, status, detail: detail.slice(0, 4000) },
    ]);
    for (const listener of this.listeners) listener();
  }
  /** Stops listing `key`'s session. */
  private forget(agent: AgentKey, key: string) {
    const views = this.sessions(agent);
    if (!views.some((view) => view.key === key)) return;
    this.views.set(
      agent,
      views.filter((view) => view.key !== key),
    );
    for (const listener of this.listeners) listener();
  }
  private disposeExecution(
    agent: AgentKey,
    execution: AgentExecution,
    retry = false,
  ) {
    const disposals = this.disposals.get(agent) ?? new Map();
    const prior = disposals.get(execution);
    if (prior && (!retry || !prior.failed)) return prior.done;
    const disposal = { done: Promise.resolve(), failed: false };
    this.disposals.set(agent, disposals);
    disposals.set(execution, disposal);
    disposal.done = Promise.resolve()
      .then(() => execution.dispose())
      .then(
        () => {
          disposals.delete(execution);
          if (!disposals.size) this.disposals.delete(agent);
        },
        (error) => {
          disposal.failed = true;
          throw error;
        },
      );
    return disposal.done;
  }
  retire(agent: AgentKey): Promise<void> {
    const prior = this.stopping.get(agent);
    const disposals = [...(this.disposals.get(agent)?.keys() ?? [])].map(
      (execution) => this.disposeExecution(agent, execution, true),
    );
    const entry = this.entries.get(agent) ?? this.stopped.get(agent);
    const protectedServer =
      this.protectedServers.get(agent) ?? this.unretired.get(agent);
    const actions = [...(this.actions.get(agent) ?? [])];
    for (const action of actions) action.abort.abort();
    entry?.abort.abort();
    if (entry) this.stopped.set(agent, entry);
    this.entries.delete(agent);
    this.views.delete(agent);
    this.previews.delete(agent);
    this.inventories.delete(agent);
    this.inventoryReads.delete(agent);
    this.inventoryVersions.delete(agent);
    const pending = [...this.opening.values()].filter(
      (opening) => opening.agent === agent,
    );
    for (const opening of pending) opening.abort.abort();
    const remotes = [...this.remote].filter(
      ([, remote]) => remote.agent === agent,
    );
    const stopped = Promise.allSettled([
      prior,
      ...disposals,
      ...actions.map((action) => action.done.catch(() => undefined)),
      ...(entry
        ? [
            (async () => {
              if (protectedServer) await this.shutdown(agent, protectedServer);
              const server = protectedServer ?? this.server;
              if (server) await this.stop(server, agent, entry);
              if (this.stopped.get(agent) === entry) this.stopped.delete(agent);
            })(),
          ]
        : []),
      ...(!entry && protectedServer
        ? [this.shutdown(agent, protectedServer)]
        : []),
      ...pending.map((opening) => opening.ready.catch(() => undefined)),
      ...remotes.map(async ([key, remote]) => {
        try {
          await remote.runtime.retire(agent);
        } finally {
          remote.runtime.dispose();
          await this.disposeExecution(agent, remote.execution);
        }
        if (this.remote.get(key) === remote) this.remote.delete(key);
      }),
    ]).then(async (results) => {
      const disposed = await Promise.allSettled(
        [...(this.disposals.get(agent)?.values() ?? [])].map(
          (disposal) => disposal.done,
        ),
      );
      const failure = [...results, ...disposed].find(
        (result) => result.status === "rejected",
      );
      if (failure?.status === "rejected") throw failure.reason;
    });
    this.stopping.set(agent, stopped);
    const clear = () => {
      if (this.stopping.get(agent) === stopped) this.stopping.delete(agent);
    };
    void stopped.then(clear, clear);
    for (const listener of this.listeners) listener();
    return stopped;
  }
  /** Protected servers whose retirement has not confirmed the process exited. */
  private readonly unretired = new Map<AgentKey, Server>();
  private assertRetired(agent: AgentKey, protectedStart = false) {
    if (
      this.unretired.has(agent) ||
      (protectedStart && this.stopping.has(agent))
    )
      throw new Error("This agent’s previous native sessions have not retired");
  }
  /** Closes a protected server; starts for its agent stay refused until the
   * process has exited. */
  private async shutdown(agent: AgentKey, server: Server) {
    this.unretired.set(agent, server);
    await server.rpc.close();
    // A pending start fails and closes its late process; the second close
    // repeats that close if it failed.
    await server.opening.catch(() => undefined);
    await server.rpc.close();
    if (this.unretired.get(agent) === server) this.unretired.delete(agent);
    if (this.protectedServers.get(agent) === server)
      this.protectedServers.delete(agent);
  }
  sync(agents: readonly Agent[]) {
    const present = new Set(agents.map((agent) => agent.key));
    const held = new Set([
      ...this.entries.keys(),
      ...this.protectedServers.keys(),
      ...this.unretired.keys(),
      ...this.stopped.keys(),
      ...this.disposals.keys(),
      ...this.actions.keys(),
      ...this.views.keys(),
      ...this.previews.keys(),
      ...this.inventories.keys(),
      ...this.inventoryReads.keys(),
      ...[...this.opening.values()].map((opening) => opening.agent),
      ...[...this.remote.values()].map((remote) => remote.agent),
    ]);
    for (const agent of held)
      if (!present.has(agent))
        void this.retire(agent).catch((error) =>
          console.error("Codex could not retire an agent", agent, error),
        );
    if (!present.size) {
      void this.server?.rpc.close();
      this.server = undefined;
    }
    for (const listener of this.listeners) listener();
  }
  /** Other agents share the server, so a stopped agent's turns interrupt
   * themselves. Then the shells its finished turns left are ended, which its
   * own process used to do by exiting. Until then, the same agent starting
   * again waits rather than resuming a thread that is still letting go. */
  private stop(server: Server, agent: AgentKey, entry: Entry) {
    const stopped = (async () => {
      await Promise.all([
        ...[...entry.lanes.values()].map((lane) =>
          lane.tail.catch(() => undefined),
        ),
        ...[...entry.onces].map((once) => once.released),
      ]);
      for (const [threadId, owner] of server.threads)
        if (owner === agent) {
          if (
            this.server !== server &&
            this.protectedServers.get(agent) !== server
          )
            return;
          await server.rpc.request("thread/backgroundTerminals/clean", {
            threadId,
          });
          server.threads.delete(threadId);
        }
    })();
    return stopped;
  }
  dispose() {
    this.disposed = true;
    for (const actions of this.actions.values())
      for (const action of actions) action.abort.abort();
    for (const opening of this.opening.values()) opening.abort.abort();
    for (const remote of this.remote.values()) {
      remote.runtime.dispose();
      void remote.execution.dispose();
    }
    this.remote.clear();
    this.previews.clear();
    this.inventories.clear();
    this.inventoryReads.clear();
    this.inventoryVersions.clear();
    for (const entry of this.entries.values()) entry.abort.abort();
    this.entries.clear();
    this.views.clear();
    this.stopping.clear();
    this.close();
  }
  /** Starts the shared server ahead of the first mention. */
  warm() {
    this.open();
  }
  private close() {
    for (const server of this.protectedServers.values())
      void server.rpc.close();
    this.protectedServers.clear();
    for (const server of this.unretired.values()) void server.rpc.close();
    this.unretired.clear();
    void this.server?.rpc.close();
    this.server = undefined;
  }
  private open(agent?: Pick<AgentHandle, "key" | "pubkey" | "protection">) {
    if (agent?.protection) {
      const protection = agent.protection;
      this.assertRetired(agent.key, true);
      protection.assertAvailable();
      // A prior worker with another key belongs to a replaced provider, which
      // is already stopping it; the replacement starts once it has exited.
      const prior = this.protectedServers.get(agent.key);
      if (prior?.protection?.key === protection.key) return prior;
      const host = this.protectionHost;
      if (!host?.serveMcp)
        throw new Error("Protected Codex requires the desktop security host");
      const serveMcp = host.serveMcp.bind(host);
      const rpc = new AppServer((call) => this.tool(call));
      const server: Server = {
        rpc,
        protection,
        threads: new Map(),
        opening: Promise.resolve(rpc),
      };
      server.opening = (async () => {
        await prior?.rpc.close();
        const bridge = await nativeProtectionBridge(serveMcp, protection);
        server.explainer = bridge.explainer;
        rpc.onMessage((wire) => {
          if (wire.method !== "connection/closed") return;
          void bridge.close();
          if (this.protectedServers.get(agent.key) !== server) return;
          this.protectedServers.delete(agent.key);
          // A failed connection can leave its process running; unless a
          // retirement already owns its close, it is tracked until it exits.
          if (!rpc.exited && !this.unretired.has(agent.key))
            void this.shutdown(agent.key, server).catch(() => undefined);
        });
        try {
          // Buzz's home, as `codex.sh run` sets it, so the engine's state and
          // sign-in are not the user's `~/.codex`; no home, no engine.
          const home = await buzzHome(this.spawn);
          return await rpc.open(
            (_id, options) =>
              protection.spawn({
                ...options,
                args: [
                  ...(options?.args ?? []),
                  "-c",
                  `sqlite_home=${home}`,
                  // Tool shells do not inherit the protection bridge's address and token.
                  "-c",
                  'shell_environment_policy.set.BUZZ_SECURITY_URL=""',
                  "-c",
                  'shell_environment_policy.set.BUZZ_SECURITY_TOKEN=""',
                ],
                env: {
                  ...bridge.env,
                  CODEX_HOME: home,
                  // Remote control would follow enrollments in worker-writable state.
                  CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
                  BASH_ENV: null,
                  ENV: null,
                  DYLD_INSERT_LIBRARIES: null,
                  DYLD_LIBRARY_PATH: null,
                  DYLD_FRAMEWORK_PATH: null,
                  LD_PRELOAD: null,
                  LD_LIBRARY_PATH: null,
                },
              }),
            defaults.workspace,
            true,
          );
        } catch (error) {
          await bridge.close();
          await rpc.close();
          throw error;
        }
      })();
      this.protectedServers.set(agent.key, server);
      void server.opening.catch(() => {
        if (this.protectedServers.get(agent.key) === server)
          this.protectedServers.delete(agent.key);
      });
      return server;
    }
    if (this.server) return this.server;
    const rpc = new AppServer((call) => this.tool(call));
    // Threads set their own cwd; the process just needs a directory that exists.
    const server: Server = {
      rpc,
      opening: rpc.open(
        (id, options) =>
          this.spawn(id, {
            ...options,
            args: [
              ...(options?.args ?? []),
              ...(this.hooks && !this.target ? callbackHookArgs : []),
            ],
          }),
        defaults.workspace,
      ),
      threads: new Map(),
    };
    // An exit fails current work and permits the next ordinary mention to reopen.
    rpc.onMessage((wire) => {
      if (wire.method === "connection/closed" && this.server === server)
        this.server = undefined;
    });
    void server.opening.catch(() => {
      if (this.server === server) this.server = undefined;
      void rpc.close();
    });
    this.server = server;
    return server;
  }
  private entry(
    agent: AgentKey,
    scope: string,
    initial?: Record<string, Saved>,
  ) {
    this.assertRetired(agent);
    const prior = this.entries.get(agent);
    if (prior) return prior;
    const saved = initial ?? this.load(this.storageKey(scope, agent));
    const entry: Entry = {
      storageKey: this.storageKey(scope, agent),
      abort: new AbortController(),
      after:
        this.stopping.get(agent) ??
        (this.stopped.has(agent) ? this.retire(agent) : Promise.resolve()),
      saved,
      lanes: new Map(),
      onces: new Set(),
      waiting: new Set(),
    };
    this.entries.set(agent, entry);
    return entry;
  }
  private load(
    storageKey: string,
    text = this.storage.get(storageKey),
    strict = !!this.target,
  ) {
    try {
      const stored: unknown = JSON.parse(text ?? "{}");
      if (
        strict &&
        (!stored ||
          typeof stored !== "object" ||
          Array.isArray(stored) ||
          Object.values(stored).some(
            (value) =>
              !value ||
              typeof value.threadId !== "string" ||
              typeof value.workspace !== "string",
          ))
      )
        throw new Error("Invalid saved Codex session");
      if (stored && typeof stored === "object" && !Array.isArray(stored))
        return Object.fromEntries(
          Object.entries(stored).filter(
            ([, value]) =>
              value &&
              typeof value.threadId === "string" &&
              typeof value.workspace === "string",
          ),
        ) as Record<string, Saved>;
    } catch (error) {
      if (strict) throw error;
      /* Start fresh after malformed local data. */
    }
    return {};
  }
  async listConversations(agent: AgentKey): Promise<SavedConversation[]> {
    const request = {};
    this.inventoryReads.set(agent, request);
    let rows: SavedConversation[] | null = null;
    if (await this.inspect?.(agent)) {
      const reads = this.reads(agent);
      if (!reads) throw new Error("The agent's community is unavailable.");
      rows = [];
      const prefix = `buzz.codex.sessions.execution.v1:${reads.scope}:${agent}:`;
      const pointers = await this.storage.scan(prefix);
      for (const text of Object.values(pointers)) {
        const key = this.storageKey(
          reads.scope,
          agent,
          this.sessionRecord(text).key,
        );
        rows.push(
          ...this.savedConversations(
            agent,
            this.load(key, await this.storage.read(key), true),
          ),
        );
      }
      rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    }
    if (!this.disposed && this.inventoryReads.get(agent) === request)
      this.inventories.set(agent, rows);
    return rows
      ? this.withHeldConversations(agent, rows)
      : this.localConversations(agent);
  }
  conversationVersion = (agent: AgentKey) =>
    this.inventoryVersions.get(agent) ?? 0;
  /** The last observed bindings, most recently used first. */
  conversations(agent: AgentKey): SavedConversation[] {
    if (this.inventories.has(agent)) {
      const rows = this.inventories.get(agent);
      return rows
        ? this.withHeldConversations(agent, rows)
        : this.localConversations(agent);
    }
    if (this.execution) {
      const scope = this.reads(agent)?.scope;
      if (scope) {
        const prefix = `buzz.codex.sessions.execution.v1:${scope}:${agent}:`;
        const remote = this.storage
          .keys()
          .filter((key) => key.startsWith(prefix))
          .flatMap((key) => {
            const stored = this.storage.get(key);
            if (!stored) return [];
            return this.savedConversations(
              agent,
              this.load(
                this.storageKey(scope, agent, this.sessionRecord(stored).key),
              ),
            );
          })
          .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
        const conversations = this.withHeldConversations(agent, remote);
        if (conversations.length) return conversations;
      }
    }
    return this.localConversations(agent);
  }
  private withHeldConversations(
    agent: AgentKey,
    saved: readonly SavedConversation[],
  ) {
    const held = [...this.remote.values()]
      .filter((entry) => entry.agent === agent)
      .flatMap((entry) => entry.runtime.conversations(agent));
    return [
      ...new Map([...saved, ...held].map((row) => [row.key, row])).values(),
    ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  }
  private localConversations(agent: AgentKey) {
    const reads = this.reads(agent);
    const saved =
      this.entries.get(agent)?.saved ??
      (reads ? this.load(this.storageKey(reads.scope, agent)) : {});
    return this.savedConversations(agent, saved);
  }
  private savedConversations(agent: AgentKey, saved: Record<string, Saved>) {
    const reads = this.reads(agent);
    return Object.entries(saved)
      .reverse()
      .flatMap(([key, { threadId, at }]) => {
        try {
          const [channelId, root] = JSON.parse(key) as unknown[];
          if (typeof channelId !== "string" || typeof root !== "string")
            return [];
          return [
            {
              key,
              channelId,
              ...reads?.channelLabel(channelId),
              ...(root === "channel" ? {} : { root }),
              threadId,
              ...(at === undefined ? {} : { at }),
            },
          ];
        } catch {
          return [];
        }
      })
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  }
  /** A display name for a pubkey in the agent's community, if known. */
  name(agent: AgentKey, pubkey: string) {
    return this.reads(agent)?.name(pubkey);
  }
  /** The agent's latest thread for a conversation that another build of the
   * app started, found by the name the agent gave it. */
  async find(
    agent: Readonly<{ key: AgentKey; name: string }>,
    place: Readonly<{ channelId: string; root?: string }>,
    signal: AbortSignal,
  ): Promise<SavedConversation | undefined> {
    if (this.target || (await this.inspect?.(agent.key))) return;
    const label = this.reads(agent.key)?.channelLabel(place.channelId);
    const found = await findConversation(
      this.spawn,
      { agent, ...place, ...(label ? { name: label.name } : {}) },
      signal,
    );
    return (
      found && {
        key: JSON.stringify([place.channelId, place.root ?? "channel"]),
        ...place,
        ...found,
      }
    );
  }
  /** The community's current name and kind for a channel, if it lists it;
   * `useOpenedSession` gives them to a thread `find` returned. */
  channelLabel(agent: AgentKey, channelId: string) {
    return this.reads(agent)?.channelLabel(channelId);
  }
  /** What each of the agent's threads started with. */
  prompts(agent: AgentKey) {
    return sessionPrompts(this.storage, "codex", agent);
  }
  private storageKey(
    scope: string,
    agent: AgentKey,
    sessionKey = this.targetKey,
  ) {
    // Resume restores the persisted tool schema, so a binding from before a
    // tool change starts fresh. v5 added channel and member management; v6
    // added the shared session tools; v7 added shared notes; v8 added agent
    // creation and changes; v9 added Attention delivery; v10 added plugin sources;
    // v11 added literal message keywords; v12 added self-handoff; v13 added
    // memory versions and search; v14 splits canvas into canvas_get and
    // canvas_set; v15 removes message keywords; v16 splits channel and
    // channels into the channel_* tools; v17 splits members into the
    // member_* tools.
    return `buzz.codex.sessions.v17:${scope}:${agent}${sessionKey ? `:session:${sessionKey}` : ""}`;
  }
  private save(request: Request, entry: Entry, key: string, saved: Saved) {
    // Reinserted so the bounded set keeps the most recently used bindings.
    delete entry.saved[key];
    entry.saved[key] = saved;
    // Retain a bounded set of bindings; this never deletes Codex's own history.
    entry.saved = Object.fromEntries(Object.entries(entry.saved).slice(-200));
    const savedWrite = this.storage.set(
      entry.storageKey,
      JSON.stringify(entry.saved),
    );
    if (this.target) return savedWrite;
    void savedWrite.catch((error: unknown) =>
      this.status(
        request.agent.key,
        key,
        "Session could not be saved",
        message(error),
      ),
    );
  }
  /** Dates the binding now, when it takes in a message or ends a turn. */
  private touch(request: Request, entry: Entry, key: string) {
    const saved = entry.saved[key];
    if (!saved) return;
    void Promise.resolve(
      this.save(request, entry, key, { ...saved, at: Date.now() }),
    ).catch((error) =>
      this.status(
        request.agent.key,
        key,
        "Session could not be saved",
        message(error),
      ),
    );

    for (const listener of this.listeners) listener();
  }
  async run(delivery: Delivery): Promise<void> {
    if (this.disposed) throw new Error("Codex runtime is disposed");
    delivery.signal.throwIfAborted();
    const { trigger, agent } = delivery;
    // Unaddressed watches and timers come as standalone turns (`runOnce`).
    if (
      trigger.type !== "mention" &&
      trigger.type !== "attention" &&
      trigger.type !== "plugin"
    )
      return delivery.ignored?.();
    // A wake is not a message to check: a plugin's is the owner's installed
    // code, and the agent's own handoff comes from a turn already acting
    // for the owner.
    const wake = trigger.type !== "mention" ? trigger : undefined;
    const event =
      trigger.type !== "mention" ? wakeAnchor(trigger) : trigger.event;
    const reads = this.reads(agent.key);
    if (
      trigger.type === "mention" &&
      !(await fromOwner(
        trigger.event,
        agent.owner,
        workflowOf(reads, agent.pubkey),
      ))
    ) {
      delivery.ignored?.();
      return;
    }
    delivery.signal.throwIfAborted();
    if (!reads) throw new Error("Connect to the agent's community first");
    const channelId = delivery.channelId;
    if (!channelId) throw new Error("The event has no unambiguous channel");
    const settings = this.resolveConfig(delivery.config);
    const channel = await reads.channel(channelId);
    const solo = await reads.soloChat(agent.owner, channelId, delivery.signal);
    const topLevel = solo || wake?.topLevel === true;
    if (wake && !wakeLands(wake, topLevel)) return delivery.ignored?.();
    // Only a Solo chat's Canvas is handed over.
    const canvas = reads.canvas?.bind(reads);
    const project = solo
      ? (await readProject(canvas && (() => canvas(channelId, agent.owner))))
          ?.section
      : undefined;
    // A stop during the reads deleted this agent's entry; recreating it would
    // reopen the agent.
    delivery.signal.throwIfAborted();
    const toolRoot = channel?.dm || topLevel ? undefined : rootOf(event);
    const root = settings.scope === "channel" ? undefined : toolRoot;
    delivery.signal.throwIfAborted();
    const conversationKey = JSON.stringify([channelId, root ?? "channel"]);
    if (await this.inspect?.(agent.key)) {
      const handoff = this.controls.deliver(
        `${agent.key}/${conversationKey}`,
        async () => {
          const runtime = await this.connection(
            agent.key,
            reads.scope,
            conversationKey,
            delivery.signal,
          );
          await runtime.run(delivery);
        },
      );
      return handoff.done;
    }
    if (this.disposed) throw new Error("Codex runtime is disposed");
    delivery.signal.throwIfAborted();
    let finishActivity!: (result: WorkOutcome) => void;
    const replied = new Promise<WorkOutcome>((resolve) => {
      finishActivity = resolve;
    });
    const answered = (stopped?: boolean) =>
      finishActivity(stopped ? { ok: true, stopped: true } : { ok: true });
    const failActivity = (error: string) =>
      finishActivity({ ok: false, error });
    delivery.workingUntil(replied);
    // Codex makes one more model call after a final send before its turn
    // ends; the agent is done working on this request once it has replied.
    const request: Request = {
      scope: reads.scope,
      ...(wake ? { current: delivery.current } : {}),
      event,
      ...(wake ? { wake } : {}),
      ...(delivery.wakeText ? { wakeText: delivery.wakeText } : {}),
      agent,
      settings,
      ...(toolRoot ? { toolRoot } : {}),
      ...(delivery.model ? { model: delivery.model } : {}),
      ...(delivery.effort ? { effort: delivery.effort } : {}),
      ...(delivery.synced ? { synced: delivery.synced } : {}),
      conversation: {
        channelId,
        name: channel?.name ?? channelId,
        ...(root ? { root } : {}),
        ...(topLevel ? { topLevel } : {}),
        ...(topLevel && !solo ? { threadReplies: true } : {}),
      },
      team: delivery.team ?? "",
      ...(project ? { project: `${project}\n` } : {}),
      answered,
      failActivity,
      ...(delivery.step ? { step: delivery.step } : {}),
      ...(delivery.acknowledged ? { acknowledged: delivery.acknowledged } : {}),
      ...(delivery.superseded ? { superseded: delivery.superseded } : {}),
      ...(trigger.type === "mention" && trigger.resumed
        ? { resumed: true }
        : {}),
      ...(solo && delivery.named ? { named: delivery.named } : {}),
    };
    if (!validWorkspace(settings.workspace)) {
      failActivity(
        "Choose an absolute workspace path or ~/.buzz in Codex settings first.",
      );
      await this.publish(
        request,
        "Choose an absolute or ~/… workspace path in Codex settings first.",
      );
      return;
    }
    const key = JSON.stringify([channelId, root ?? "channel"]);
    const entry = this.entry(agent.key, request.scope);
    entry.waiting.add(request);
    delivery.interruptible?.(() => this.interrupt(entry, key, request));
    const handoff = this.controls.deliver(
      `${agent.key}/${key}`,
      async (deferred) => {
        if (deferred) entry.abort.signal.throwIfAborted();
        else delivery.signal.throwIfAborted();
        const text = textOf(request.event, agent.name);
        let lane = entry.lanes.get(key);
        if (!lane) {
          lane = { tail: entry.after, queued: 0 };
          entry.lanes.set(key, lane);
        }
        if (lane.active) {
          const active = lane.active;
          let queued = false;
          const queue = () => {
            queued = true;
            this.start(request, text, key, lane, entry);
          };
          // Startup and history reads stay ordered without holding Agents delivery.
          const accepted = active.steering.then(async () => {
            try {
              await active.ready;
              if (entry.abort.signal.aborted) {
                request.failActivity("Codex was stopped");
                return;
              }
              // Steering cannot carry a model or effort pick, so a
              // differing pick waits for this turn and runs as the next one.
              // Everything after it queues too until the lane drains: steering
              // would run later messages first. A turn keeps the posting policy
              // it was admitted with, so a request under the other policy waits
              // for it too. A turn the owner stopped takes nothing more.
              if (
                active.finished ||
                active.stopped ||
                lane.queued ||
                request.conversation.topLevel !==
                  active.reply.conversation.topLevel ||
                (request.model && request.model !== active.model) ||
                (request.effort && request.effort !== active.effort)
              ) {
                queue();
                return;
              }
              const context = await this.history(request, entry.abort.signal);
              const wake = request.wake && {
                ...request.wake,
                text: (await request.wakeText?.()) ?? request.wake.text,
              };
              if (entry.abort.signal.aborted) {
                request.failActivity("Codex was stopped");
                return;
              }
              if (active.finished || active.stopped) {
                queue();
                return;
              }
              if (request.current && !request.current()) {
                entry.waiting.delete(request);
                request.answered();
                return;
              }
              await active.rpc.request("turn/steer", {
                threadId: active.threadId,
                expectedTurnId: active.turnId,
                input: input(
                  `${context}${request.project ?? ""}${turnInput(request.agent.key, request.event, request.conversation, text, true, noteOf(request), wake, this.reads(request.agent.key)?.authorNames?.(request.event.pubkey))}`,
                ),
              });
              active.reply = request;
              active.requests.push(request);
              entry.waiting.delete(request);
              this.touch(request, entry, key);
              this.acknowledgeActivity(active, request);
            } catch (error) {
              if (entry.abort.signal.aborted) {
                request.failActivity("Codex was stopped");
                return;
              }
              // A completion racing the request means this is the next ordinary turn.
              if (message(error) === "no active turn to steer") {
                queue();
                return;
              }
              // A refused steer took nothing in, so its notes are the next turn's.
              if (error instanceof Refused) restoreNotes(request);
              request.failActivity(
                `Steering was not accepted: ${message(error)}`,
              );
              await this.publish(
                request,
                `Steering was not accepted: ${message(error)}. Send another mention to continue.`,
              );
              // The running turn never took this request in, so nothing else
              // answers it: let go of its working hold now, not at that turn's end.
              request.answered();
            } finally {
              if (!queued) entry.waiting.delete(request);
            }
          });
          active.steering = accepted.catch((error) =>
            console.error("Codex steering failed", error),
          );
          return;
        }
        this.start(request, text, key, lane, entry);
      },
    );
    const handed = handoff.done.catch((error) => {
      entry.waiting.delete(request);
      request.failActivity(message(error));
      throw error;
    });
    if (!handoff.deferred) return handed;
    delivery.workingUntil(handed);
    void handed
      .catch(async (error) => {
        if (!entry.abort.signal.aborted)
          await this.publish(request, message(error));
      })
      .catch((error) => console.warn("Codex handover failed", error));
  }

  /** Runs a standalone turn, such as a watch's or a timer's: a new
   * ephemeral thread that joins no conversation and is not saved, stopped
   * when the turn's signal aborts. Asks for its prompt once the thread can
   * start, and starts none when the turn is no longer wanted. A failure is
   * logged, not posted. */
  async runOnce({
    delivery,
    key,
    signal: turnSignal,
    prompt,
  }: StandaloneTurn): Promise<TurnResult> {
    if (this.disposed) throw new Error("Codex runtime is disposed");
    const { agent } = delivery;
    const reads = this.reads(agent.key);
    if (!reads)
      return { ok: false, error: "Connect to the agent's community first" };
    const { scope } = reads;
    if (this.execution && (await this.inspect?.(agent.key))) {
      const conversation = `once:${crypto.randomUUID()}`;
      const storageKey = this.executionKey(agent.key, scope, conversation);
      let runtime: CodexRuntime | undefined;
      try {
        runtime = await this.connection(
          agent.key,
          scope,
          conversation,
          turnSignal,
        );
        return await runtime.runOnce({
          delivery,
          key,
          signal: turnSignal,
          prompt,
        });
      } finally {
        this.remote.delete(storageKey);
        runtime?.dispose();
        if (runtime?.target)
          await this.disposeExecution(agent.key, runtime.target);
        await this.storage.set(storageKey, null);
      }
    }
    if (this.disposed) throw new Error("Codex runtime is disposed");
    if (turnSignal.aborted)
      return { ok: false, error: message(turnSignal.reason) };
    const entry = this.entry(agent.key, scope);
    const settings = this.resolveConfig(delivery.config);
    const team = delivery.team ?? "";
    if (entry.abort.signal.aborted)
      return { ok: false, error: "Codex was stopped" };
    if (!validWorkspace(settings.workspace))
      return {
        ok: false,
        error:
          "Choose an absolute workspace path or ~/.buzz in Codex settings first.",
      };
    await entry.after;
    if (entry.abort.signal.aborted)
      return { ok: false, error: "Codex was stopped" };
    const server = this.open(agent);
    const signal = AbortSignal.any([entry.abort.signal, turnSignal]);
    let release!: () => void;
    const once: Once = {
      finished: false,
      signal,
      workspace: settings.workspace,
      agent,
      scope,
      released: new Promise((resolve) => {
        release = resolve;
      }),
    };
    const followed = follow(server.rpc, signal, once);
    entry.onces.add(once);
    let hookBridge: Awaited<ReturnType<typeof openHookBridge>> | undefined;
    try {
      const rpc = await server.opening;
      signal.throwIfAborted();
      const workspace = await this.workspace(settings.workspace);
      signal.throwIfAborted();
      once.workspace = workspace;
      const { params, model, effort, summary, bridge } = await this.prepare(
        rpc,
        agent,
        settings,
        workspace,
        {},
        delivery.synced,
      );
      hookBridge = bridge;
      const text = await prompt();
      if (text === undefined) return { ok: true };
      const memory = await this.core(agent.key, signal);
      signal.throwIfAborted();
      const started = await rpc.request<{ thread: { id: string } }>(
        "thread/start",
        {
          ...params,
          ephemeral: true,
          dynamicTools: dynamicTools(this.added()),
        },
      );
      once.threadId = started.thread.id;
      bridge?.bind(once.threadId);
      server.threads.set(once.threadId, agent.key);
      signal.throwIfAborted();
      if (!delivery.current()) return { ok: true };
      const turnStarted = await rpc.request<{ turn: { id: string } }>(
        "turn/start",
        {
          threadId: once.threadId,
          input: input(text),
          model,
          effort,
          ...summary,
          additionalContext: turnContext(
            agent,
            settings,
            team,
            memory,
            this.repositories(scope),
          ),
        },
      );
      once.turnId ??= turnStarted.turn.id;
      this.status(agent.key, key, "Working");
      const status = await followed.completed;
      if (status === "interrupted") {
        this.status(agent.key, key, "Interrupted");
        return { ok: false, error: "Codex’s turn was interrupted" };
      }
      // A finished wake leaves nothing to show; a failed one stays listed.
      this.forget(agent.key, key);
      return { ok: true };
    } catch (error) {
      if (!once.finished && once.threadId && once.turnId)
        await server.rpc
          .request("turn/interrupt", {
            threadId: once.threadId,
            turnId: once.turnId,
          })
          .catch(() => server.rpc.close());
      this.status(agent.key, key, "Needs attention", message(error));
      return { ok: false, error: message(error) };
    } finally {
      await hookBridge?.close();
      once.finished = true;
      followed.stop();
      const { threadId } = once;
      // Nothing resumes the thread, so the shells it left are ended now.
      if (threadId && server.threads.get(threadId) === agent.key) {
        await this.terminals(server.rpc, threadId).catch(() => undefined);
        server.threads.delete(threadId);
        await server.rpc
          .request("thread/unsubscribe", { threadId })
          .catch(() => undefined);
      }
      entry.onces.delete(once);
      release();
    }
  }

  /** Stops the turn in conversation `key` that took `request` in, once it
   * started. A request still waiting for its turn is not stopped. Stops of
   * one turn share its interrupt, so one that fails cannot undo another. */
  private interrupt(entry: Entry, key: string, request: Request) {
    if (entry.waiting.has(request))
      return Promise.reject(
        new Error("Codex has not started on this message yet"),
      );
    const active = entry.lanes.get(key)?.active;
    if (!active?.requests.includes(request) || active.finished)
      return Promise.resolve();
    active.stopped = true;
    active.stopping ??= (async () => {
      try {
        await active.ready;
        if (active.finished || !active.threadId || !active.turnId) return;
        await active.rpc.request("turn/interrupt", {
          threadId: active.threadId,
          turnId: active.turnId,
        });
      } catch (error) {
        // A turn that did not stop still reports how it ends, and can be
        // stopped again.
        delete active.stopping;
        if (!active.finished) active.stopped = false;
        throw error;
      }
    })();
    return active.stopping;
  }

  /** A positive harness response transfers presentation, not execution or
   * success. Watches have no bubble; mentions in other threads keep theirs,
   * and a top-level chat is one scope. */
  private acknowledgeActivity(active: Active, request: Request) {
    if (!request.step) return;
    const scope = request.conversation.topLevel
      ? request.conversation.channelId
      : rootOf(request.event);
    const prior = active.activity.get(scope);
    if (prior === request) return;
    prior?.superseded?.();
    active.activity.set(scope, request);
    request.acknowledged?.();
  }

  /** Compacts thread `threadId`, which runs as a turn of its own on it. */
  private async compact(
    rpc: AppServer,
    signal: AbortSignal,
    threadId: string,
    agent: AgentKey,
    key: string,
  ) {
    const turn: { threadId: string; turnId?: string; finished: boolean } = {
      threadId,
      finished: false,
    };
    // Keep following until the provider ends the turn, even if Interrupt is
    // clicked before its turn/started notification arrives.
    const followed = follow(rpc, new AbortController().signal, turn);
    let stopping: Promise<unknown> | undefined;
    const interrupt = () => {
      if (!signal.aborted || !turn.turnId || turn.finished) return;
      if (stopping) return;
      stopping = rpc
        .request("turn/interrupt", { threadId, turnId: turn.turnId })
        .catch(() => rpc.close());
    };
    const off = rpc.onMessage(interrupt);
    signal.addEventListener("abort", interrupt);
    try {
      signal.throwIfAborted();
      this.status(agent, key, "Compacting");
      await rpc.request("thread/compact/start", { threadId });
      const status = await followed.completed;
      signal.throwIfAborted();
      if (status !== "completed") throw new Error("Compaction was interrupted");
    } catch (error) {
      await rpc
        .request("thread/unsubscribe", { threadId })
        .catch(() => rpc.close());
      throw error;
    } finally {
      signal.removeEventListener("abort", interrupt);
      off();
      followed.stop();
    }
  }

  private start(
    request: Request,
    text: string,
    key: string,
    lane: Lane,
    entry: Entry,
  ) {
    const current = lane;
    current.queued++;
    const job = lane.tail
      .catch(() => undefined)
      .then(async () => {
        current.queued--;
        entry.waiting.delete(request);
        if (entry.abort.signal.aborted) {
          request.failActivity("Codex was stopped");
          return;
        }
        if (request.current && !request.current()) {
          request.answered();
          return;
        }
        try {
          await entry.after;
          await this.execute(request, text, key, current, entry);
        } catch (error) {
          request.failActivity(message(error));
          throw error;
        }
      });
    lane.tail = job;
    this.status(request.agent.key, key, "Starting");
    // Agents can deliver follow-ups and other conversations immediately.
    void job
      .catch(async (error) => {
        request.failActivity(message(error));
        const reason = `Codex could not start: ${message(error)}.`;
        this.status(request.agent.key, key, "Needs attention", reason);
        await this.publish(request, reason).catch((failure) =>
          console.error("Codex could not publish its failure", failure),
        );
      })
      .finally(() => {
        if (current.tail === job && !current.active) {
          entry.lanes.delete(key);
          for (const listener of this.listeners) listener();
        }
      });
    return job;
  }
  private async history(request: Request, signal: AbortSignal) {
    signal.throwIfAborted();
    const reads = this.reads(request.agent.key);
    if (reads?.scope !== request.scope)
      throw new Error("The community changed");
    // A chat its owner is still creating has nothing earlier to read.
    const starting = (await reads.channel(request.conversation.channelId))
      ?.starting;
    return conversationHistory(
      request.event,
      request.conversation,
      (filters) =>
        starting ? Promise.resolve([]) : reads.read(filters, signal),
      reads,
      reads.workflowAuthority(),
    );
  }
  // Tags the owner even when a sibling asked: tagging the sibling would wake
  // it, and two agents failing alike would wake each other without end.
  private publish(request: Request, content: string) {
    return request.agent.publish({
      kind: 9,
      content,
      tags: [
        ["h", request.conversation.channelId],
        ...(request.conversation.topLevel
          ? []
          : [["e", rootOf(request.event), "", "reply"]]),
        ["p", request.agent.owner],
      ],
    });
  }
  private async tool(call: ToolCall): Promise<ToolReply> {
    const entries = [...this.entries.values()];
    const matches = (turn?: { threadId?: string; turnId?: string }) =>
      turn?.threadId === call?.threadId && turn?.turnId === call?.turnId;
    const active = entries
      .flatMap((entry) => [...entry.lanes.values()])
      .map((lane) => lane.active)
      .find(matches);
    const once = active
      ? undefined
      : entries.flatMap((entry) => [...entry.onces]).find(matches);
    const turn = active ?? once;
    if (
      !turn ||
      call.namespace !== "buzz" ||
      !sessionTools(this.added()).some((tool) => tool.name === call.tool)
    )
      throw new Error("No active Buzz tool for this thread and turn");
    const check = () => {
      turn.signal.throwIfAborted();
      if (turn.finished) throw new Error("The Codex turn has ended");
    };
    check();
    if (
      !call.arguments ||
      typeof call.arguments !== "object" ||
      Array.isArray(call.arguments)
    )
      throw new Error("Buzz tool arguments must be an object");
    const args = call.arguments as Record<string, unknown>;
    const request = active?.reply;
    const answering = active ? [...active.requests] : [];
    const owner = request ?? (once as Once);
    const { agent } = owner;
    const client = appClient(agent, {
      // Its tool registry reviews every call, Buzz's dynamic tools included.
      nativeToolGate: true,
      protectionContext: async () => {
        const rpc =
          active?.rpc ??
          this.protectedServers.get(agent.key)?.rpc ??
          this.server?.rpc;
        if (!rpc) throw new Error("The protected Codex session is unavailable");
        return rpc.request("thread/read", {
          threadId: call.threadId,
          includeTurns: true,
        });
      },
      relayAuthor: this.reads(agent.key)?.relayAuthor?.(),
      signingAuthority: this.reads(agent.key)?.workflowAuthority(),
      read: (path) =>
        this.target
          ? this.target.readFile(path, { cwd: turn.workspace })
          : readFile(
              this.spawn,
              turn.workspace,
              path,
              turn.signal,
              agent.protection?.processProtection,
            ),
      check,
      signal: turn.signal,
      memories: async (slug) => {
        const listing = await this.memories(owner, turn.signal, slug);
        check();
        return listing;
      },
      remembered: () => {
        const reads = this.reads(agent.key);
        if (reads) this.memoryReads.forget(reads.connection, agent.pubkey);
      },
    });
    // A watch or timer turn has no default destination.
    const context: Context = request
      ? {
          channel: request.conversation.channelId,
          ...(request.toolRoot ? { root: request.toolRoot } : {}),
          ...(request.toolRoot && !request.conversation.root
            ? { wholeChannel: true }
            : {}),
          ...(request.conversation.topLevel &&
          !request.conversation.threadReplies
            ? { topLevel: true }
            : {}),
        }
      : {};
    const final = isFinalMessage(call.tool, args);
    const reply = await callSessionTool(
      this.target
        ? {
            ...client,
            media: async () => {
              this.target?.signal.throwIfAborted();
              throw new Error(
                "Media download is unavailable for remote Codex agents.",
              );
            },
          }
        : client,
      context,
      call.tool,
      args,
      this.added(),
    ).catch((error) => {
      if (final)
        for (const taken of answering)
          if (taken.finalDelivery !== true)
            taken.finalDelivery = new Error(message(error));
      throw error;
    });
    if (final) {
      for (const taken of answering) {
        taken.finalDelivery = true;
        taken.answered();
      }
    }
    return {
      success: true,
      contentItems:
        typeof reply === "string"
          ? [{ type: "inputText", text: reply }]
          : [
              {
                type: "inputImage",
                imageUrl: `data:${reply.type};base64,${reply.data}`,
              },
              ...(reply.text
                ? [{ type: "inputText" as const, text: reply.text }]
                : []),
            ],
    };
  }
  /** The agent's memory, or only entry `slug`, as its community's reads give
   * it. */
  private async memories(
    request: Pick<Request, "scope" | "agent">,
    signal: AbortSignal,
    slug?: string,
  ) {
    const { key, pubkey } = request.agent;
    const reads = this.reads(key);
    if (reads?.scope !== request.scope)
      throw new Error("Buzz is not connected to this community");
    const { connection } = reads;
    const listing = await this.memoryReads.read(reads, pubkey, signal, slug);
    signal.throwIfAborted();
    const current = this.reads(key);
    if (current?.scope !== request.scope || current.connection !== connection)
      throw new Error("Buzz is not connected to this community");
    return listing;
  }
  /** Stops the thread's shells. `linger` keeps looking that long: a command
   * a stopped turn was waiting on becomes a background terminal only just
   * after the turn ends. */
  private async terminals(rpc: AppServer, threadId: string, linger = 0) {
    // Interrupt acknowledges the turn, not the death of separately grouped shells.
    try {
      await rpc.request("thread/backgroundTerminals/clean", { threadId });
      const until = Date.now() + linger;
      // clean acknowledges submission. Direct termination is the completion
      // barrier for any shells still reported by the server.
      for (let cursor: string | null = null; ; ) {
        const page: {
          data: { processId: string }[];
          nextCursor: string | null;
        } = await rpc.request("thread/backgroundTerminals/list", {
          threadId,
          limit: 100,
          cursor,
        });
        await Promise.all(
          page.data.map((terminal) =>
            rpc.request("thread/backgroundTerminals/terminate", {
              threadId,
              processId: terminal.processId,
            }),
          ),
        );
        cursor = page.nextCursor;
        if (cursor) continue;
        if (Date.now() >= until) break;
        await new Promise((resolve) => setTimeout(resolve, LINGER_POLL_MS));
      }
      const remaining = await rpc.request<{ data: unknown[] }>(
        "thread/backgroundTerminals/list",
        { threadId, limit: 1 },
      );
      if (remaining.data.length)
        throw new Error("Codex background terminals could not be stopped");
    } catch (error) {
      // A failed cleanup must not leave shells unreachable behind an idle lane.
      await rpc.close();
      throw error;
    }
  }
  /** Titles a chat from its first message as Codex's own app does: one
   * structured turn on an ephemeral read-only thread, on its small title
   * model when the account has it. The host decides whether the chat takes it. */
  private async offerTitle(
    rpc: AppServer,
    named: (title: string) => void,
    text: string,
    stopped: AbortSignal,
    // The conversation's thread settings: its workspace, model, and Codex
    // config with MCP servers, plugins, apps and web search off.
    {
      cwd,
      model,
      config,
    }: Readonly<{
      cwd: string;
      model: string;
      config: Record<string, unknown>;
    }>,
  ) {
    const models = await listModels(rpc);
    const selected =
      models.find((row) => row.model === TITLE_MODEL) ??
      models.find((row) => row.model === model);
    if (!selected) return;
    const low = selected.supportedReasoningEfforts.some(
      (level) => level.reasoningEffort === "low",
    );
    const signal = AbortSignal.any([stopped, AbortSignal.timeout(60_000)]);
    const turn: { threadId?: string; turnId?: string; finished: boolean } = {
      finished: false,
    };
    let reply = "";
    const followed = follow(rpc, signal, turn, (method, item) => {
      if (method === "item/completed" && item.type === "agentMessage")
        reply = item.text ?? "";
    });
    try {
      const started = await rpc.request<{ thread: { id: string } }>(
        "thread/start",
        {
          model: selected.model,
          cwd,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
          config: {
            ...config,
            mcp_servers: Object.fromEntries(
              Object.entries(
                (config.mcp_servers ?? {}) as Record<
                  string,
                  Record<string, unknown>
                >,
              ).map(([name, server]) => [name, { ...server, enabled: false }]),
            ),
            ...(this.server?.rpc === rpc && this.hooks
              ? { "hooks.state": await nativeHookState(rpc, cwd, false) }
              : {}),
          },
        },
      );
      turn.threadId = started.thread.id;
      await rpc.request("turn/start", {
        threadId: turn.threadId,
        input: input(titlePrompt(text)),
        model: selected.model,
        ...(low ? { effort: "low" } : {}),
        outputSchema: TITLE_SCHEMA,
      });
      if ((await followed.completed) !== "completed" || stopped.aborted) return;
      const title = (JSON.parse(reply) as { title?: unknown }).title;
      if (typeof title === "string" && title.trim()) named(title.trim());
    } finally {
      followed.stop();
      if (turn.threadId)
        await rpc
          .request("thread/unsubscribe", { threadId: turn.threadId })
          .catch(() => undefined);
    }
  }

  /** What a thread for `agent` starts or resumes with in `workspace`, and the
   * model and effort its turn runs on: `pick`'s when available. */
  private async prepare(
    rpc: AppServer,
    agent: Pick<AgentHandle, "key" | "name" | "pubkey">,
    settings: Config,
    workspace: string,
    pick: Readonly<{ model?: string; effort?: string }>,
    synced?: Delivery["synced"],
  ) {
    const normalized = await rpc.request<{
      config: {
        mcp_servers?: Record<string, Record<string, unknown>>;
        model_reasoning_summary?: string | null;
        features?: { hooks?: boolean; codex_hooks?: boolean };
      };
    }>("config/read", { cwd: workspace });
    const models = await listModels(rpc);
    const own = resolveModel(settings.model, models);
    // Model and effort are per turn, so a pick changes nothing after it.
    const picked = models.find((row) => row.model === pick.model);
    const selected = picked ?? models.find((row) => row.model === own);
    if (!selected)
      throw new Error(
        "The selected Codex model is unavailable. Choose an available model in Settings.",
      );
    const model = selected.model;
    const supported = selected.supportedReasoningEfforts.map(
      (level) => level.reasoningEffort,
    );
    // A picked model may not support the configured effort.
    const effort =
      [pick.effort, settings.effort].find(
        (level) => level && supported.includes(level),
      ) ?? selected.defaultReasoningEffort;
    // A synced effort is the agent's on every device: never run another.
    const kept = synced?.effort;
    if (kept && !pick.model && !pick.effort && effort !== kept)
      throw new Error(unsupportedSynced("effort", kept, `Codex's ${model}`));
    const mcp = Object.fromEntries(
      Object.entries(normalized.config.mcp_servers ?? {}).map(
        ([name, server]) => [
          name,
          // CLI overrides replace this table; disabled servers still need a transport.
          {
            ...(typeof server.command === "string"
              ? { command: server.command }
              : { url: server.url }),
            enabled: false,
          },
        ],
      ),
    );
    const features = normalized.config.features;
    const disabled = (features?.hooks ?? features?.codex_hooks) === false;
    const hooks =
      !disabled && this.server?.rpc === rpc && this.hooks
        ? await nativeHookState(rpc, workspace)
        : undefined;
    const hookAdapter =
      !disabled && this.server?.rpc === rpc ? this.hooks : undefined;
    const bridge = hookAdapter
      ? await openHookBridge(hookAdapter.serve, (session, event, input) =>
          hookAdapter.run(agent.key, session, event, input),
        )
      : undefined;
    const params = {
      model,
      cwd: workspace,
      developerInstructions: developerInstructions(agent),
      approvalPolicy: "never",
      // Matches Claude's bypassPermissions; only the owner's mentions and the
      // agent's own watches and timers start work.
      sandbox: "danger-full-access",
      config: {
        ...(hooks ? { "hooks.state": hooks } : {}),
        web_search: "disabled",
        mcp_servers: { ...mcp, ...bridge?.config },
        "features.plugins": false,
        "features.apps": false,
      },
    };
    // Ask for reasoning summaries unless the user chose a summary mode.
    const summary = normalized.config.model_reasoning_summary
      ? {}
      : { summary: "auto" };
    return { params, model, effort, summary, bridge };
  }
  private async execute(
    request: Request,
    text: string,
    key: string,
    lane: Lane,
    entry: Entry,
  ) {
    let ready!: () => void;
    let notReady!: (error: unknown) => void;
    const turnAbort = new AbortController();
    const server = this.open(request.agent);
    // No deadline of our own: a turn runs until Codex ends it.
    const signal = AbortSignal.any([entry.abort.signal, turnAbort.signal]);
    const active: Active = {
      rpc: server.rpc,
      ready: new Promise((resolve, reject) => {
        ready = resolve;
        notReady = reject;
      }),
      steering: Promise.resolve(),
      reply: request,
      finished: false,
      workspace: request.settings.workspace,
      signal,
      requests: [request],
      activity: new Map(),
    };
    void active.ready.catch(() => undefined);
    lane.active = active;
    const { settings, agent } = request;
    const followed = follow(server.rpc, signal, active, (method, item) => {
      const step = method === "item/started" ? codexStep(item) : undefined;
      if (step)
        for (const taken of active.activity.values())
          taken.step?.(step.tool, step.target);
      if (method === "item/started" && item.command)
        this.status(agent.key, key, "Working", item.command);
      if (method === "item/completed" && item.type === "commandExecution")
        this.status(
          agent.key,
          key,
          "Working",
          `${item.command ?? ""}\n${item.aggregatedOutput ?? ""}`,
        );
    });
    let hookBridge: Awaited<ReturnType<typeof openHookBridge>> | undefined;
    let explain: (() => string | undefined) | undefined;
    try {
      const rpc = await server.opening;
      signal.throwIfAborted();
      // The process host expands ~/… and creates the directory; Codex's RPC needs
      // an absolute path rather than shell-style home notation.
      const workspace = await this.workspace(settings.workspace);
      signal.throwIfAborted();
      active.workspace = workspace;
      const saved = entry.saved[key];
      const existing = resumable(saved, agent.protection);
      const { params, model, effort, summary, bridge } = await this.prepare(
        rpc,
        agent,
        settings,
        workspace,
        request,
        request.synced,
      );
      hookBridge = bridge;
      active.model = model;
      active.effort = effort;
      // Resume restores the thread's tools, so one started with other added
      // tools starts fresh.
      const added = this.added();
      const tools = addedKey(added);
      const resuming =
        existing?.workspace === workspace && (existing.tools ?? "") === tools;
      type Started = { thread: { id: string; cwd: string } };
      const start = () =>
        rpc.request<Started>("thread/start", {
          ...params,
          dynamicTools: dynamicTools(added),
        });
      const resume = (threadId: string) =>
        rpc.request<Started>("thread/resume", {
          ...params,
          threadId,
          excludeTurns: true,
        });
      if (this.target && existing && !resuming)
        throw Object.assign(
          new Error(
            "The Codex workspace or tools changed. Start a new session to continue.",
          ),
          { code: "EXECUTION_SESSION_RESET_REQUIRED" },
        );
      let started: Started;
      // Only a thread started here keeps what it started with.
      let fresh = !resuming;
      if (resuming) {
        const { threadId } = existing;
        const missing = (error: unknown) => {
          if (message(error) !== `no rollout found for thread id ${threadId}`)
            throw error;
          if (this.target)
            throw Object.assign(
              new Error(
                "The remote Codex session cannot be restored. Start a new session to continue.",
              ),
              { code: "EXECUTION_SESSION_RESET_REQUIRED" },
            );
        };
        // A thread saved before Buzz had its own Codex home is in the user's;
        // continue a copy, or start fresh if there is none.
        started = await resume(threadId)
          .catch(async (error) => {
            missing(error);
            await this.adopt(threadId);
            return resume(threadId);
          })
          .catch(async (error) => {
            missing(error);
            fresh = true;
            return start();
          });
      } else started = await start();
      if (this.target && resuming && existing.pending) {
        const { pending: _, ...accepted } = existing;
        await this.save(request, entry, key, accepted);
      }
      active.threadId = started.thread.id;
      // A refusal outside this turn does not explain how it ends.
      explain = server.explainer?.(active.threadId);
      bridge?.bind(active.threadId);
      server.threads.set(active.threadId, agent.key);
      signal.throwIfAborted();
      await rpc.request("thread/name/set", {
        threadId: active.threadId,
        name: sessionName(agent, request.conversation),
      });
      const [context, memory] = await Promise.all([
        this.history(request, signal),
        this.core(request.agent.key, signal),
      ]);
      const wake = request.wake && {
        ...request.wake,
        text: (await request.wakeText?.()) ?? request.wake.text,
      };
      signal.throwIfAborted();
      if (request.current && !request.current()) {
        restoreNotes(request);
        request.answered();
        this.status(agent.key, key, "Idle");
        active.finished = true;
        ready();
        return;
      }
      const additionalContext = turnContext(
        agent,
        settings,
        request.team,
        memory,
        this.repositories(request.scope),
      );
      if (this.target && !resuming)
        await this.save(request, entry, key, {
          pending: true,
          threadId: started.thread.id,
          workspace,
          at: Date.now(),
          ...(tools ? { tools } : {}),
        });
      const turn = await rpc
        .request<{ turn: { id: string } }>("turn/start", {
          threadId: active.threadId,
          input: input(
            `${context}${request.project ?? ""}${turnInput(request.agent.key, request.event, request.conversation, text, false, noteOf(request), wake, this.reads(request.agent.key)?.authorNames?.(request.event.pubkey))}`,
          ),
          model,
          effort,
          ...summary,
          // Application context is a developer message that updates on each turn.
          additionalContext,
        })
        .catch(async (error: unknown) => {
          if (this.target && !resuming && error instanceof Refused) {
            const { [key]: _, ...saved } = entry.saved;
            await this.storage.set(entry.storageKey, JSON.stringify(saved));
            entry.saved = saved;
          }
          throw error;
        });

      active.turnId = turn.turn.id;
      if (fresh)
        void this.prompts(agent.key).save(
          this.targetKey
            ? JSON.stringify([this.targetKey, active.threadId])
            : active.threadId,
          [
            {
              label: "base",
              text: params.developerInstructions,
            },
            {
              label: EACH_TURN,
              text: Object.values(additionalContext)
                .map(({ value }) => value)
                .join(""),
            },
          ],
        );
      this.acknowledgeActivity(active, request);
      // A conversation new to this agent: name its Solo chat meanwhile.
      if (request.named && !saved && !server.protection)
        void this.offerTitle(
          rpc,
          request.named,
          text,
          entry.abort.signal,
          params,
        ).catch((error) => {
          if (!entry.abort.signal.aborted)
            console.warn("Codex could not title the chat", error);
        });
      // Empty threads have no resumable rollout until a user turn is accepted.
      await this.save(request, entry, key, {
        threadId: started.thread.id,
        workspace,
        at: Date.now(),
        ...(tools ? { tools } : {}),
        ...(agent.protection ? { protection: agent.protection.stateKey } : {}),
      });
      ready();
      this.status(agent.key, key, "Working");
      const status = await followed.completed;
      await active.steering;
      signal.throwIfAborted();
      if (status === "interrupted" && active.stopped) {
        for (const taken of active.requests) taken.answered(true);
        await this.terminals(rpc, active.threadId, STOP_LINGER_MS);
        this.status(agent.key, key, "Stopped");
      } else if (status === "interrupted") {
        for (const taken of active.requests)
          taken.failActivity("Codex’s turn was interrupted");
        await this.terminals(rpc, active.threadId);
        await this.publish(
          active.reply,
          "Codex’s turn was interrupted. Send another mention to continue.",
        );
        this.status(agent.key, key, "Interrupted");
      } else {
        const failed = active.requests.find(
          (taken) => taken.finalDelivery instanceof Error,
        )?.finalDelivery;
        if (failed instanceof Error) throw failed;
        // A turn may end without a reply when there is nothing new to say.
        for (const taken of active.requests) taken.answered();
        this.status(agent.key, key, "Idle");
      }
    } catch (error) {
      // Refused before any turn began, it took nothing in.
      if (error instanceof Refused && !active.turnId) restoreNotes(request);
      for (const taken of active.requests) taken.failActivity(message(error));
      const ended = active.finished;
      active.finished = true;
      notReady(error);
      await active.steering;
      // Other agents share the server, so even a stopped agent interrupts
      // its turn rather than ending the process.
      if (signal.aborted && !ended && active.threadId && active.turnId) {
        try {
          await server.rpc.request("turn/interrupt", {
            threadId: active.threadId,
            turnId: active.turnId,
          });
          await this.terminals(server.rpc, active.threadId);
        } catch {
          await server.rpc.close();
        }
      }
      const why = explain?.();
      if (!entry.abort.signal.aborted) {
        const reason = `Codex could not finish: ${message(error)}.`;
        await this.publish(active.reply, reason).catch((failure) =>
          console.error("Codex could not publish its failure", failure),
        );
        // The denied input may have shaped the provider's reason, so it shows
        // only on the owner's Activity tab, never in the thread agents read.
        this.status(
          agent.key,
          key,
          "Needs attention",
          why ? `${reason} Reason: ${why}` : reason,
        );
      }
    } finally {
      for (const taken of active.requests)
        taken.failActivity("Codex ended without a final reply");
      followed.stop();
      // A turn Codex took in has ended, however it ended.
      if (active.turnId && !entry.abort.signal.aborted)
        this.touch(request, entry, key);
      turnAbort.abort(new Error("The Codex turn has ended"));
      // Release the subscription before the next resume: loaded-thread rejoin
      // ignores instruction/config overrides while a client is subscribed.
      if (active.threadId)
        await server.rpc
          .request("thread/unsubscribe", { threadId: active.threadId })
          .catch(() => server.rpc.close());
      await hookBridge?.close();
      if (lane.active === active) delete lane.active;
    }
  }
}
/** A started or completed item, as the app-server reports it. */
type Item = {
  type: string;
  text?: string;
  phase?: string;
  command?: string;
  aggregatedOutput?: string;
};
/** Follows `turn`'s thread on `rpc`: notes its turn id, passes its items to
 * `onItem`, and settles `completed` with the turn's status. Rejects when the
 * turn fails, `signal` aborts or the connection closes. */
function follow(
  rpc: AppServer,
  signal: AbortSignal,
  turn: { threadId?: string; turnId?: string; finished: boolean },
  onItem?: (method: string, item: Item) => void,
) {
  let finish!: (status: string) => void;
  let fail!: (error: Error) => void;
  const completed = new Promise<string>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  void completed.catch(() => undefined);
  const abort = () => fail(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const off = rpc.onMessage((wire) => {
    const p = wire.params as
      | {
          threadId?: string;
          message?: string;
          turn?: { id: string; status: string; error?: { message: string } };
          item?: Item;
        }
      | undefined;
    if (wire.method === "connection/closed") {
      fail(new Error(p?.message ?? "Codex connection closed"));
      return;
    }
    if (!p || !turn.threadId || p.threadId !== turn.threadId) return;
    if (wire.method === "turn/started" && p.turn) turn.turnId = p.turn.id;
    if (p.item && wire.method) onItem?.(wire.method, p.item);
    if (wire.method === "turn/completed" && p.turn) {
      turn.finished = true;
      if (p.turn.status === "failed")
        fail(new Error(p.turn.error?.message ?? "Codex turn failed"));
      else finish(p.turn.status);
    }
  });
  return {
    completed,
    stop() {
      signal.removeEventListener("abort", abort);
      off();
    },
  };
}
/** The Buzz tools, with those plugins add, that a new thread gets. Codex
 * keeps a deferred tool from the model until its tool search finds it. Every
 * model in Codex's catalog has tool search (supports_search_tool); one
 * without it would not see deferred tools. */
const dynamicTools = (added: readonly AddedTool[]) => [
  {
    type: "namespace",
    name: "buzz",
    description: sessionHint(added),
    tools: sessionTools(added).map(({ load, ...tool }) => ({
      type: "function",
      ...tool,
      ...(load === "search" ? { deferLoading: true } : {}),
    })),
  },
];
const EMPTY: readonly SessionView[] = Object.freeze([]);

/** A started Codex item as a step, named in the shared step vocabulary.
 * Shapes follow codex app-server v2 `ThreadItem` / `CommandAction` (camelCase). */
export function codexStep(
  item: Record<string, unknown> | undefined,
): { tool: string; target?: string } | undefined {
  const text = (value: unknown) =>
    typeof value === "string" && value ? value : undefined;
  const step = (tool: string, target?: unknown) => {
    const on = text(target);
    return on ? { tool, target: on } : { tool };
  };
  const file = (value: unknown) => text(value)?.split("/").at(-1);
  switch (item?.type) {
    case "commandExecution": {
      const actions = Array.isArray(item.commandActions)
        ? (item.commandActions as Record<string, unknown>[])
        : [];
      const action = actions[0];
      if (action?.type === "read")
        return step("Read", text(action.name) ?? file(action.path));
      if (action?.type === "search") return step("Grep", action.query);
      if (action?.type === "listFiles") return step("ListFiles", action.path);
      return step(
        "Shell",
        programs(text(action?.command) ?? text(item.command)),
      );
    }
    case "fileChange": {
      const first = Array.isArray(item.changes)
        ? (item.changes[0] as { path?: unknown } | undefined)
        : undefined;
      return step("Edit", file(first?.path));
    }
    case "mcpToolCall":
    case "dynamicToolCall":
      return text(item.tool) ? step(String(item.tool)) : undefined;
    case "collabAgentToolCall":
      return step("Agent", item.prompt);
    case "webSearch":
      return step("WebSearch", item.query);
    case "imageView":
      return step("ImageView", file(item.path));
    case "plan":
      return step("TodoWrite");
    case "contextCompaction":
      return step("Compacting");
    case "reasoning":
      return step("Thinking");
    case "agentMessage":
      return step("Writing reply");
    default:
      return undefined;
  }
}

/** The programs a shell command runs ("mktemp, xargs"), without the login-shell
 * wrapper, arguments or quoted scripts. Raw commands stay in the transcript. */
export function programs(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const inner =
    /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1\s*$/.exec(
      command.trim(),
    )?.[2] ?? command;
  const segments: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of inner) {
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === "|" || char === ";" || char === "&" || char === "\n") {
      segments.push(current);
      current = "";
    } else current += char;
  }
  segments.push(current);
  const names = new Set<string>();
  for (const segment of segments) {
    const word = segment
      .trim()
      .split(/\s+/)
      .find((token) => token && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
    const name = word
      ?.replace(/^["']|["']$/g, "")
      .split("/")
      .at(-1);
    if (name && /^[\w.+-]+$/.test(name)) names.add(name);
  }
  const list = [...names];
  if (!list.length) return undefined;
  return list.length > 3
    ? `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`
    : list.join(", ");
}
