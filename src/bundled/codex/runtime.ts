import { withTimeout } from "../../plugins/timeout";
import { ownerInstructions } from "../../features/agent-harness/plugin-instructions";
import {
  ProjectSource,
  NO_PROJECT,
  type Project,
} from "../../features/agent-harness/project";
import {
  COMMUNITY_SESSION,
  abortable,
  rememberCommunitySource,
  sessionSource,
} from "../../features/agent-harness/session-scope";
import { openVoice } from "./voice";
import { isHuddleRoom } from "../../features/huddle/lifecycle";
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
import {
  mentionAuthority,
  workflowOf,
} from "../../features/agents/owner-attestation";
import {
  type ConversationWake,
  wakeAnchor,
  wakeLands,
} from "../../features/agent-harness/plugin-wake";
import { compactAt } from "../../features/agents/compact-at";
import {
  composeBase,
  sectionsKey,
  sectionUpdates,
  startedSections,
  type StartedSections,
} from "../../features/agent-harness/sections/compose";
import { type Facts, LAYOUT } from "../../features/agent-harness/sections";
import type { AgentKey } from "../../features/agents/membership";
import { type AgentReads, workflowMarked } from "../../features/agents/reads";
import {
  EACH_TURN,
  sessionPrompts,
} from "../../features/agents/session-prompts";
import { localStore, type AgentStore } from "../../features/agents/store";
import {
  conversationFolder,
  conversationKey,
  existingFolder,
} from "../../features/agents/conversation-folders";
import type {
  Agent,
  AgentHandle,
  AgentVoiceSeat,
  AgentVoiceConnection,
  Agents,
  Delivery,
  Models,
  StandaloneTurn,
  TurnResult,
} from "../../features/agents/service";
import type { EventData } from "../../features/relay/events";
import { CREDENTIAL_ENV } from "../../features/host/service";
import { isRetryableRead } from "../../features/relay/read-retry";
import { threadReference } from "../../features/relay/thread-reference";
import type { ChannelLabel } from "../../features/channels/channel-icon";
import { appClient, readFile } from "../../buzz-mcp/app-client";
import { readAuthorNames } from "../../features/agent-harness/author-names";
import { project, readCanvas } from "../../features/agent-harness/project";
import {
  referencedFolders,
  referencedSkills,
} from "../../features/agent-harness/referenced-folders";
import { RESUMED_PROMPT } from "../../buzz-mcp/prompt";
import {
  abortable as readUntilAborted,
  MemoryReads,
} from "../../features/agent-harness/core-memory";
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
  resolveEffort,
  defaults,
  absoluteWorkspace,
  effortName,
  validWorkspace,
  type Config,
} from "./config";
import {
  unsupportedSynced,
  unverifiedSynced,
} from "../../features/agents/agent-config";
import { conversationHistory } from "./history";
import { buzzHome } from "./setup";
import {
  contextText,
  developerInstructions,
  rootOf,
  sessionName,
  sessionPlace,
  turnContext,
  turnInput,
  type Conversation,
} from "./prompt";
import {
  AppServer,
  listModels,
  listVoices,
  Refused,
  RequestTimeout,
  type Spawn,
  type ToolCall,
  type ToolReply,
} from "./rpc";
import { findConversation } from "./transcript";

const scopedKey = (scope: Config["scope"], channel: string, root?: string) =>
  JSON.stringify([
    scope === "community" ? COMMUNITY_SESSION : channel,
    scope === "thread" && root ? root : "channel",
  ]);

type Request = {
  current?: () => boolean;
  /** Settles once Codex accepts or refuses this request's steer. */
  steering?: Promise<void>;
  unaddressed?: Pick<StandaloneTurn, "prompt" | "signal">;
  /** The agent's community and owner, as `origin:viewer`. */
  scope: string;
  event?: EventData;
  /** Publish/activity root; unlike toolRoot, retained in DMs. */
  replyRoot?: string;
  agent: AgentHandle;
  settings: Config;
  conversation: Conversation;
  /** Presentation scope, independent of the harness session and reply routing. */
  activityScope: string;
  /** A plugin's wake, for which `event` is its local anchor. */
  wake?: ConversationWake;
  wakeText?: Delivery["wakeText"];
  /** Latest request's thread, independent of session scope; absent in DMs. */
  toolRoot?: string;
  /** The agent's team sections, if it is on a team. */
  team: string;
  session?: Delivery["session"];
  sessionContext?: string;
  /** The Solo chat's workspace Canvas section, if it has one. */
  project?: string;
  /** `project` for a turn that works where `elsewhere` says. */
  projectAt?: (elsewhere: boolean) => string | undefined;
  canvas?: Project;
  solo?: boolean;
  /** The model and effort the owner picked for this turn. */
  model?: string;
  effort?: string;
  /** The synced settings in `settings`. */
  synced?: Delivery["synced"];
  /** Called once a final send answers this request, or one steered after it
   * (in its conversation, for a community session), a steering rejection is
   * posted in its place, or the turn ends normally.
   * `stopped` is that the owner's interrupt ended the turn. */
  answered: (stopped?: boolean) => void;
  /** A failed final delivery stays pending until this request gets a reply. */
  finalDelivery?: Error | true;
  step?: (tool: string, target?: string) => void;
  acknowledged?: (input?: Readonly<{ steering?: true }>) => void;
  accepted?: () => void;
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
type TextRequest = Request & { event: EventData; adopted?: never };
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
  /** The base sections the thread started with, which it keeps: a turn is
   * sent the ones that differ now. `shown` is the `key` of the sections its
   * saved prompt last showed. A thread from before they were kept has none. */
  sections?: StartedSections & { shown?: string };
};
type Active = {
  /** The server this turn runs on; steering must reach the same process. */
  rpc: AppServer;
  threadId?: string;
  turnId?: string;
  ready: Promise<void>;
  released: Promise<void>;
  nativeCompleted?: Promise<string>;
  voiceRetirement?: Promise<void>;
  rejectedSpeech?: Promise<void>;
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
  /** Whether it works elsewhere, which its Canvas states the rule from. */
  elsewhere?: boolean;
  signal: AbortSignal;
  tools: AbortController;
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
/** A queued turn that later messages join once it starts. */
type Next = {
  request: TextRequest;
  began: Promise<Active | undefined>;
  begin: (active?: Active) => void;
};
type Lane = {
  tail: Promise<void>;
  /** Turns waiting on `tail` to start; steering past them would reorder. */
  queued: number;
  /** The latest of them. */
  next?: Next;
  /** Messages behind a turn, each steered or queued in arrival order. */
  steering: Promise<void>;
  /** How many of them are still being placed. */
  behind: number;
  active?: Active;
  voice?: {
    loaded: Loaded;
    signal: AbortSignal;
    restore(): Promise<void>;
    rejectedSpeechClosing?: Promise<void>;
    /** Ends the seat, and tells its owner why. */
    end(error: Error): void;
  };
  voiceOpening?: true;
};
type Entry = {
  project: ProjectSource;
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

/** The community request a send answers: the one its ID names, else the one
 * at its explicit destination, else a wake with no destination of its own.
 * An unknown ID needs an explicit destination. */
function addressed(
  args: Record<string, unknown>,
  answering: readonly Request[],
  strict: boolean,
  place: Place,
) {
  const id =
    typeof args.request === "string" ? args.request.trim().toLowerCase() : "";
  const named = id && answering.find((pending) => pending.event?.id === id);
  if (named) return named;
  const channel =
    typeof args.channel === "string" ? args.channel : place.channel;
  if (typeof channel !== "string") {
    if (id && strict)
      throw new Error(
        `Request ${id} is not part of this turn. Pass channel, and reply for a thread, to say where this goes.`,
      );
    return undefined;
  }
  const scope = place.thread ?? channel;
  return (
    answering.find(
      (pending) =>
        pending.conversation.channelId === channel &&
        pending.activityScope === scope,
    ) ??
    answering.find((pending) => pending.unaddressed) ??
    null
  );
}

type Place = { channel?: string; thread?: string };

/** Where a send's `reply` or `parent` posts: a reply to any message in a
 * thread is in the thread, and a subthread in its parent's channel, as the
 * tools post them. */
async function placeOf(
  agent: AgentHandle,
  args: Record<string, unknown>,
  answering: readonly Request[],
): Promise<Place> {
  const id = [args.reply, args.parent]
    .find((id): id is string => typeof id === "string")
    ?.trim()
    .toLowerCase();
  if (!id) return {};
  // A reply to a request's own message, or in its thread, answers it there,
  // a DM's at its top level included.
  const known = answering.find(
    ({ activityScope, event }) => activityScope === id || event?.id === id,
  );
  if (known)
    return {
      channel: known.conversation.channelId,
      thread: known.activityScope,
    };
  const [event] = await agent.query([{ ids: [id], limit: 1 }]).catch(() => []);
  if (!event) return { thread: id };
  const channel = event.tags.find(([name]) => name === "h")?.[1];
  return {
    ...(channel ? { channel } : {}),
    thread: threadReference(event)?.rootId ?? event.id,
  };
}

/** The conversation's lane. A new community lane waits for every other lane. */
function laneFor(entry: Entry, key: string, community: boolean) {
  let lane = entry.lanes.get(key);
  if (!lane) {
    lane = {
      tail: community
        ? Promise.all([
            entry.after,
            ...[...entry.lanes.values()].map((other) => other.tail),
          ]).then(() => {})
        : entry.after,
      queued: 0,
      steering: Promise.resolve(),
      behind: 0,
    };
    entry.lanes.set(key, lane);
  }
  return lane;
}

type Loaded = Awaited<ReturnType<CodexRuntime["loadThread"]>>;
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
  community?: true;
  root?: string;
  threadId: string;
  at?: number;
};
/** How long a stopped turn's shells are looked for, and how often. Codex hands
 * one over about 50ms after the turn ends. */
const STOP_LINGER_MS = 1_000;
// An acknowledged interrupt may never produce its completion notification.
const INTERRUPTED_TURN_COMPLETION_MS = 30_000;
const LINGER_POLL_MS = 100;
/** The binding a run under `protection` may resume: threads never cross
 * protection state keys, protected or not. */
const resumable = (
  saved: Saved | undefined,
  protection: Pick<AgentProtection, "stateKey"> | undefined,
) => (saved?.protection === protection?.stateKey ? saved : undefined);
/** What picks a thread's base sections: `home` is the agent's workspace when
 * the thread runs in a folder of the conversation's own. */
const baseFacts = (
  settings: Config,
  home?: string,
  place?: Facts["place"],
): Facts => ({
  scope: settings.scope,
  ownFolder: home,
  place,
});
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
    request.sessionContext,
    request.resumed ? RESUMED_PROMPT : undefined,
    ...request.notes,
    turnNote(
      request.agent,
      request.conversation.channelId,
      request.conversation.root,
      request.settings.scope === "community",
    ),
  ].filter(Boolean);
  return notes.length ? notes.join("\n\n") : undefined;
}
function textOf(event: EventData, name: string) {
  let text = event.content.trim().replace(/^🤖\s+/, "");
  if (text.startsWith(`@${name}`)) text = text.slice(name.length + 1).trim();
  return text;
}

/** A turn's run returns once Codex has it, so this bounds only the hand-over. */
export const HANDOVER_MS = 2 * 60_000;

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
  private closingSharedServer: Server | undefined;
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
  /** A failed turn's notice as the thread reads it, such as where to sign
   * Codex in again. */
  explain: (notice: string) => string = (notice) => notice;
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
    private readonly resolveDirectory?: Host["resolveDirectory"],
    /** The agent's reads once its community is ready, for a workflow's
     * mention that arrived while it reconnects; rejects when `signal` aborts. */
    private readonly readyReads?: (
      agent: AgentHandle,
      signal: AbortSignal,
      channelId: string | undefined,
    ) => Promise<AgentReads | undefined>,
  ) {}
  /** The folder a plugin gave the conversation, if any. Only the local
   * runtime keeps them; an execution target's conversations refuse one. */
  private folder(
    scope: string,
    agent: AgentKey,
    channelId: string,
    root?: string,
  ) {
    if (this.target) return undefined;
    return conversationFolder(
      this.storage,
      scope,
      agent,
      conversationKey(channelId, root),
    );
  }
  /** Where a conversation's thread runs: the folder it was given, which must
   * still exist, with the agent's workspace as `home`; or else that
   * workspace. Both absolute. */
  private async conversationPlace(
    scope: string,
    agent: AgentKey,
    conversation: Readonly<{ channelId: string; root?: string }>,
    settings: Config,
  ): Promise<{ cwd: string; home?: string }> {
    const assigned =
      settings.scope === "community"
        ? undefined
        : this.folder(scope, agent, conversation.channelId, conversation.root);
    const workspace = await this.workspace(settings.workspace);
    if (!assigned) return { cwd: workspace };
    return {
      cwd: await existingFolder(this.resolveDirectory, assigned),
      home: workspace,
    };
  }
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
        undefined,
        undefined,
        undefined,
        this.readyReads,
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
    return scopedKey(
      this.resolveConfig(agent.config).scope,
      place.channelId,
      place.root,
    );
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
  session(
    agent: Agent,
    place: SessionPlace,
    action: SessionControlAction,
    reset?: (change: () => Promise<void>) => Promise<void>,
  ) {
    const abort = new AbortController();
    const pending = {
      abort,
      done: this.changeSession(agent, place, action, abort.signal, reset),
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
    reset?: (change: () => Promise<void>) => Promise<void>,
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
            const change = async () => {
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
              if (prior)
                await this.disposeExecution(agent.key, prior.execution);
              this.views.set(
                agent.key,
                [...this.remote.values()]
                  .filter((entry) => entry.agent === agent.key)
                  .flatMap((entry) => entry.runtime.sessions(agent.key)),
              );
              for (const listener of this.listeners) listener();
            };
            await (reset ? reset(change) : change());
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
      if (key === scopedKey("community", ""))
        for (const request of entry.waiting)
          if (request.settings.scope === "community") {
            request.current = () => false;
            request.answered(true);
          }
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
        const change = async () => {
          if (!saved) return;
          delete entry.saved[key];
          try {
            await this.storage.set(
              entry.storageKey,
              JSON.stringify(entry.saved),
            );
          } catch (error) {
            entry.saved[key] = saved;
            throw error;
          }
          this.forget(agent.key, key);
          return;
        };
        await (reset ? reset(change) : change());
        return;
      }
      if (agent.protection && !this.handle(agent.key)?.protection)
        throw new Error("The protected agent has no live policy binding");
      const thread = resumable(saved, this.handle(agent.key)?.protection);
      if (!thread) throw new Error("There is no session here to compact yet.");
      const server = this.open(this.handle(agent.key));
      const rpc = await server.opening;
      const settings = this.resolveConfig(agent.config);
      const conversation = {
        channelId: place.channelId,
        ...(settings.scope === "channel" || !place.root
          ? {}
          : { root: place.root }),
      };
      const { cwd: workspace, home } = await this.conversationPlace(
        reads.scope,
        agent.key,
        conversation,
        settings,
      );
      if (workspace !== thread.workspace)
        throw new Error(
          "The workspace changed. Send a message to start its session first.",
        );
      await rpc.confirmThreadReleased(thread.threadId);
      signal.throwIfAborted();
      const { params, bridge } = await this.prepare(
        rpc,
        agent,
        settings,
        workspace,
        {},
        undefined,
        home,
        sessionPlace(conversation),
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
        await rpc.releaseThread(thread.threadId).catch(() => undefined);
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
        const effort = resolveEffort(row, settings.effort);
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

  /** A file as the agent's turns read one here: in its saved workspace. On
   * an execution target only a conversation's session can read it. */
  async workspaceFile(agent: Agent, path: string, signal: AbortSignal) {
    if (this.target || (await this.inspect?.(agent.key)))
      throw new Error(
        `This agent reads files only in a conversation on its execution target, not ${path}`,
      );
    const saved = this.resolveConfig(agent.config).workspace;
    if (!validWorkspace(saved))
      throw new Error(
        "Choose an absolute workspace path or ~/.buzz in Codex settings first.",
      );
    const workspace = await this.workspace(saved);
    signal.throwIfAborted();
    return readFile(this.spawn, workspace, path, signal);
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
    this.controls.interrupt(
      `${agent}/${scopedKey("community", COMMUNITY_SESSION)}`,
      true,
    );
    const prior = this.stopping.get(agent);
    const disposals = [...(this.disposals.get(agent)?.keys() ?? [])].map(
      (execution) => this.disposeExecution(agent, execution, true),
    );
    const entry = this.entries.get(agent) ?? this.stopped.get(agent);
    const protectedServer =
      this.protectedServers.get(agent) ?? this.unretired.get(agent);
    const sharedServer = this.server;
    const closingSharedServer = this.closingSharedServer;
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
              await this.stop(protectedServer ?? sharedServer, agent, entry);
              if (!protectedServer)
                await this.waitForSharedExit(
                  closingSharedServer ?? this.closingSharedServer,
                );
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
  private stop(server: Server | undefined, agent: AgentKey, entry: Entry) {
    const stopped = (async () => {
      await Promise.all([
        ...[...entry.lanes.values()].map((lane) =>
          lane.tail.catch(() => undefined),
        ),
        ...[...entry.onces].map((once) => once.released),
      ]);
      if (!server) return;
      for (const [threadId, owner] of server.threads)
        if (owner === agent) {
          if (
            this.server !== server &&
            this.protectedServers.get(agent) !== server
          )
            return;
          await server.rpc
            .request("thread/backgroundTerminals/clean", { threadId })
            .catch((error) => {
              // Codex closes a thread left idle, which ends its shells.
              if (message(error) !== `thread not found: ${threadId}`)
                throw error;
            });
          server.threads.delete(threadId);
        }
    })();
    return stopped;
  }
  dispose() {
    this.controls.dispose();
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
  private async waitForSharedExit(server: Server | undefined) {
    if (!server) return;
    await server.opening.catch(() => {});
    await server.rpc.close();
    if (this.closingSharedServer === server)
      this.closingSharedServer = undefined;
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
    const open = () =>
      rpc.open(
        (id, options) =>
          this.spawn(id, {
            ...options,
            args: [
              ...(options?.args ?? []),
              ...(this.hooks && !this.target ? callbackHookArgs : []),
            ],
          }),
        defaults.workspace,
      );
    const previous = this.closingSharedServer;
    const server: Server = {
      rpc,
      opening: previous ? this.waitForSharedExit(previous).then(open) : open(),
      threads: new Map(),
    };
    rpc.onMessage((wire) => {
      if (wire.method !== "connection/closed" || this.server !== server) return;
      this.server = undefined;
      if (rpc.exited) return;
      // Disconnecting rejects native followers before the process itself exits.
      this.closingSharedServer = server;
      void this.waitForSharedExit(server).catch(() => {});
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
      project: new ProjectSource(),
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
          let [channelId, root] = JSON.parse(key) as unknown[];
          const community = channelId === COMMUNITY_SESSION;
          if (community)
            channelId = sessionSource(
              this.storage,
              agent,
              COMMUNITY_SESSION,
            ).channelId;
          if (typeof channelId !== "string" || typeof root !== "string")
            return [];
          return [
            {
              key,
              channelId,
              ...(community ? { community: true as const } : {}),
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
    community = false,
  ): Promise<SavedConversation | undefined> {
    if (this.target || (await this.inspect?.(agent.key))) return;
    const label = this.reads(agent.key)?.channelLabel(place.channelId);
    const found = await findConversation(
      this.spawn,
      {
        agent,
        ...place,
        ...(community ? { community: true } : {}),
        ...(label ? { name: label.name } : {}),
      },
      signal,
    );
    return (
      found && {
        key: scopedKey(
          community ? "community" : "thread",
          place.channelId,
          place.root,
        ),
        ...place,
        ...(community ? { community: true as const } : {}),
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
    // channels into the channel_* tools; v17 split members into the
    // member_* tools; v18 adds search and removes read's q.
    return `buzz.codex.sessions.v18:${scope}:${agent}${sessionKey ? `:session:${sessionKey}` : ""}`;
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
  voice(
    seat: AgentVoiceSeat,
    agent: AgentHandle,
  ): Promise<AgentVoiceConnection> {
    return this.openVoice(seat, agent);
  }
  private async openVoice(
    seat: AgentVoiceSeat,
    agent: AgentHandle,
    finishPreemption?: () => Promise<void>,
  ): Promise<AgentVoiceConnection> {
    if (this.disposed) throw new Error("Codex runtime is disposed");
    seat.signal.throwIfAborted();
    // Protection is not known to review realtime input, so voice refuses it.
    if (seat.agent.protection || agent.protection)
      throw new Error("Voice is unavailable for protected agents");
    // Voice runs on this computer; a plugin execution target has no voice seat.
    if (await this.inspect?.(agent.key))
      throw new Error("Voice is unsupported for agents on an execution target");
    seat.signal.throwIfAborted();
    const reads = this.reads(agent.key);
    if (!reads) throw new Error("Connect to the agent's community first");
    const settings = this.resolveConfig(seat.config);
    if (!validWorkspace(settings.workspace))
      throw new Error("Choose an absolute Codex workspace first");
    const { channelId } = seat.conversation;
    const key = scopedKey(settings.scope, channelId);
    if (settings.scope === "community" && !finishPreemption) {
      let connection: AgentVoiceConnection | undefined;
      // Previously queued work can take the native lane before voice.
      const failed = new AbortController();
      let interrupted = Promise.resolve();
      let interrupting: Active | undefined;
      const interrupt = () => {
        if (seat.signal.aborted) return;
        const entry = this.entries.get(agent.key);
        const active = entry?.lanes.get(key)?.active;
        if (entry && active && !active.finished && active !== interrupting) {
          interrupting = active;
          interrupted = this.interruptForVoice(entry, key, active);
          void interrupted.catch((error) => failed.abort(error));
        }
      };
      const off = this.subscribe(interrupt);
      interrupt();
      const handoff = this.controls.deliver(
        `${agent.key}/${key}`,
        async (_deferred, signal) => {
          await interrupted;
          connection = await this.openVoice(
            {
              ...seat,
              signal: AbortSignal.any([seat.signal, signal, failed.signal]),
            },
            agent,
            () => {
              off();
              return interrupted;
            },
          );
        },
        true,
      );
      try {
        await abortable(
          handoff.done,
          AbortSignal.any([seat.signal, failed.signal]),
        );
      } catch (error) {
        handoff.cancel();
        void handoff.done.catch(() => {});
        throw error;
      } finally {
        off();
      }
      if (!connection) throw new Error("Voice startup was interrupted");
      return connection;
    }
    await rememberCommunitySource(
      this.storage,
      agent.key,
      settings.scope === "community" ? COMMUNITY_SESSION : channelId,
      channelId,
    );
    seat.signal.throwIfAborted();
    const entry = this.entry(agent.key, reads.scope);
    const lane = laneFor(entry, key, settings.scope === "community");
    if (lane.voice || lane.voiceOpening)
      throw new Error("This conversation already has a voice seat");
    lane.voiceOpening = true;
    try {
      const active = lane.active;
      if (active && !finishPreemption)
        await this.interruptForVoice(entry, key, active);
    } catch (error) {
      delete lane.voiceOpening;
      if (
        !lane.active &&
        !lane.queued &&
        !lane.behind &&
        !lane.voice &&
        entry.lanes.get(key) === lane
      )
        entry.lanes.delete(key);
      throw error;
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([
      seat.signal,
      entry.abort.signal,
      abort.signal,
    ]);
    const request: Request = {
      scope: reads.scope,
      agent,
      settings,
      team: seat.team ?? "",
      ...(seat.synced ? { synced: seat.synced } : {}),
      activityScope: channelId,
      conversation: {
        channelId,
        name: reads.channelLabel(channelId)?.name ?? channelId,
        ...(settings.scope === "community" ? { community: true } : {}),
        topLevel: true,
      },
      answered() {},
      failActivity: (reason) => {
        if (reason !== "Codex ended without a final reply")
          this.status(agent.key, key, "Needs attention", reason);
      },
    };
    const server = this.open(agent);
    let loaded: Loaded | undefined;
    let media: Awaited<ReturnType<typeof openVoice>> | undefined;
    let delegatedThinking = false;
    let realtimeThinking = false;
    const thinking = () =>
      seat.thinking?.(delegatedThinking || realtimeThinking);
    let off = () => {};
    let closing: Promise<void> | undefined;
    const close = (rejected?: { typed: Active; drained: Promise<void> }) => {
      if (closing) return closing;
      signal.removeEventListener("abort", onAbort);
      abort.abort();
      off();
      // Stop media, await the surviving typed turn, then unsubscribe.
      // New text waits on closing, installed as lane.tail below.
      const tail = lane.tail;
      const opened = media;
      // Text already queued also waits for this close on rejected speech,
      // so the close can wait only for the typed turn that preceded it.
      const drained = rejected
        ? Promise.all([rejected.typed.released, rejected.drained])
        : tail.catch(() => {});
      closing = (async () => {
        await Promise.all([opened?.close(), drained]);
        if (media !== opened) await media?.close();
        if (loaded) {
          await server.rpc.releaseThread(loaded.threadId).catch(() => {});
          await loaded.bridge?.close();
        }
        delete lane.voice;
        if (!lane.active && !lane.queued && entry.lanes.get(key) === lane)
          entry.lanes.delete(key);
      })();
      if (rejected && lane.voice) {
        lane.voice.rejectedSpeechClosing = closing;
        lane.tail = Promise.all([tail.catch(() => {}), closing]).then(() => {});
        void lane.tail.catch((error) =>
          console.error("Codex could not retire the Huddle seat", error),
        );
      } else {
        lane.tail = closing;
      }
      return closing;
    };
    const onAbort = () => {
      void close();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const opening = lane.tail
      .catch(() => {})
      .then(async () => {
        if (finishPreemption) await finishPreemption();
        signal.throwIfAborted();
        await entry.after;
        signal.throwIfAborted();
        const rpc = await server.opening;
        const voice = settings.voice;
        if (voice) {
          signal.throwIfAborted();
          const voices = await readUntilAborted(
            listVoices(rpc).catch(() => undefined),
            signal,
          );
          if (!voices)
            throw new Error(
              seat.synced?.voice
                ? unverifiedSynced("voice", voice, "this Codex")
                : `Couldn't check the selected Codex voice "${voice}". Try again, or change it in Settings.`,
            );
          if (!voices.includes(voice))
            throw new Error(
              seat.synced?.voice
                ? unsupportedSynced("voice", voice, "this Codex")
                : `The selected Codex voice "${voice}" is unavailable. Choose an available voice in Settings.`,
            );
        }
        const memory = await this.core(agent.key, signal);
        const policy = () =>
          settings.scope === "community"
            ? [NO_PROJECT.section, turnNote(agent, channelId, undefined, true)]
                .filter(Boolean)
                .join("\n\n")
            : "";
        const voiceInstructions = (updates?: string) =>
          `${contextText(agent, settings, request.team, memory, this.repositories(reads.scope), updates)}\nFor every spoken request, apply the room's current source policy below, replacing policies retained from other conversations.\n${policy()}\nVoice work acts for owner ${agent.owner}. Buzz tools default to room ${channelId} at top level. This is the room's existing conversation. A turn that starts with <realtime_delegation> is a spoken request: the voice model speaks only your final answer, so put the result there in a few plain spoken sentences, not in a send. When you delegate, say only a short acknowledgement, then wait: never state a fact the delegated work has not returned yet.`;
        loaded = await this.loadThread(
          request,
          entry,
          key,
          signal,
          server,
          rpc,
          voiceInstructions(),
        );
        // Realtime start adds these instructions again, so they carry the
        // same section updates as the injected message.
        const instructions = voiceInstructions(loaded.updates);
        // A resumed thread keeps its first developer message, not resume's.
        if (!loaded.fresh)
          await rpc.request("thread/inject_items", {
            threadId: loaded.threadId,
            items: [
              {
                type: "message",
                role: "developer",
                content: [{ type: "input_text", text: instructions }],
              },
            ],
          });
        signal.throwIfAborted();
        const sections = this.showSections(agent.key, entry, key, loaded);
        const threadId = loaded.threadId;
        lane.voice = {
          loaded,
          signal,
          end(error) {
            void close();
            seat.ended(error);
          },
          restore: async () => {
            if (settings.scope !== "community") return;
            try {
              await rpc.request("thread/inject_items", {
                threadId,
                items: [
                  {
                    type: "message",
                    role: "developer",
                    content: [
                      {
                        type: "input_text",
                        text: `For the next spoken request in this room, replace the previous source policy:\n${policy()}`,
                      },
                    ],
                  },
                ],
              });
              signal.throwIfAborted();
              entry.project.resolve(channelId, NO_PROJECT);
            } catch (error) {
              if (!signal.aborted) {
                void close();
                seat.ended(new Error(message(error)));
              }
              throw error;
            }
          },
        };
        off = rpc.onMessage(({ method, params }) => {
          const p = params as
            | {
                threadId?: string;
                turn?: { id: string };
                role?: string;
                text?: string;
              }
            | undefined;
          if (signal.aborted || p?.threadId !== threadId) return;
          if (method === "turn/started" || method === "turn/completed") {
            delegatedThinking = method === "turn/started";
            thinking();
          }
          const active = lane.active;
          if (
            method === "turn/started" &&
            p.turn &&
            settings.scope === "community" &&
            active &&
            (active.finished || !active.threadId) &&
            !Object.hasOwn(active.reply, "adopted")
          ) {
            const drained = this.drainRejectedSpeech(rpc, threadId, p.turn.id);
            active.rejectedSpeech = drained;
            void close({ typed: active, drained });
            seat.ended(
              new Error(
                active.finished
                  ? "Room instructions are still being restored. Rejoin the Huddle and repeat your request."
                  : "The shared session is preparing another turn. Rejoin the Huddle and repeat your request.",
              ),
            );
            return;
          }
          if (
            method === "turn/started" &&
            p.turn &&
            (!lane.active || lane.active.finished)
          ) {
            // execute installs the normal Request synchronously, before the next RPC tool call.
            const previous = lane.tail;
            const delegated = this.execute(
              { ...request, adopted: p.turn.id },
              "",
              key,
              lane,
              entry,
            );
            lane.tail = Promise.all([previous, delegated]).then(() => {});
          }
          if (
            method === "thread/realtime/transcript/done" &&
            p.text?.trim() &&
            ["user", "assistant"].includes(p.role ?? "")
          ) {
            void seat
              .transcript(p.role === "user" ? "owner" : "agent", p.text)
              .catch((error) => {
                if (!signal.aborted) seat.ended(new Error(message(error)));
              });
          }
        });
        media = await openVoice(
          rpc,
          threadId,
          signal,
          seat.output,
          (error) => {
            void close();
            seat.ended(error);
          },
          instructions,
          (active) => {
            realtimeThinking = active;
            thinking();
          },
          settings.voice,
        );
        signal.throwIfAborted();
        if (settings.scope === "community")
          entry.project.resolve(channelId, NO_PROJECT);
        this.save(request, entry, key, {
          threadId,
          workspace: loaded.workspace,
          at: Date.now(),
          ...(loaded.tools ? { tools: loaded.tools } : {}),
          ...(agent.protection
            ? { protection: agent.protection.stateKey }
            : {}),
          ...(sections ? { sections } : {}),
        });
        return { input: media.input, close };
      });
    // Reserve startup in the ordinary lane; later text work waits for it.
    lane.tail = opening.then(
      () => {},
      () => {},
    );
    try {
      return await opening;
    } catch (error) {
      await close();
      throw error;
    } finally {
      delete lane.voiceOpening;
    }
  }
  run(delivery: Delivery): Promise<void> {
    return this.admitDelivery(delivery);
  }
  private async admitDelivery(
    delivery: Delivery,
    reserved = false,
    admittedDeferred = false,
  ): Promise<void> {
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
    // A workflow's mention waits out a reconnect; the check below decides.
    const ready =
      trigger.type === "mention" && workflowMarked(trigger.event, agent.owner)
        ? this.readyReads
        : undefined;
    const reads = ready
      ? await ready(agent, delivery.signal, delivery.channelId)
      : this.reads(agent.key);
    if (ready) {
      delivery.signal.throwIfAborted();
      if (delivery.current && !delivery.current()) return delivery.ignored?.();
    }
    if (trigger.type === "mention") {
      const authority = await mentionAuthority(
        trigger.event,
        agent.owner,
        workflowOf(reads, agent.pubkey),
      );
      if (authority !== "owner") return delivery.ignored?.(authority);
    }
    delivery.signal.throwIfAborted();
    if (!reads) throw new Error("Connect to the agent's community first");
    const channelId = delivery.channelId;
    if (!channelId) throw new Error("The event has no unambiguous channel");
    const settings = this.resolveConfig(delivery.config);
    if (settings.scope === "community" && !reserved)
      return this.controls.admit(
        `${agent.key}/${scopedKey("community", COMMUNITY_SESSION)}`,
        delivery,
        (accepted, deferred) => this.admitDelivery(accepted, true, deferred),
      );
    const channel = await reads.channel(channelId);
    const solo = await reads.soloChat(agent.owner, channelId, delivery.signal);
    const huddle = isHuddleRoom(channel?.about);
    const topLevel = solo || huddle || wake?.topLevel === true;
    if (wake && !wakeLands(wake, topLevel)) return delivery.ignored?.();
    // Only a Solo chat's Canvas is handed over.
    const canvas = reads.canvas?.bind(reads);
    const [canvasRead, folders] = await Promise.all([
      solo
        ? readCanvas(canvas && (() => canvas(channelId, agent.owner)))
        : undefined,
      referencedFolders(event, agent.owner, reads.scope),
    ]);
    const skills = referencedSkills(event, agent.owner, agent.pubkey);
    // The Canvas states the rule for its folders from whether the
    // conversation has one of its own, which a plugin can assign as its
    // session is admitted. A turn renders it again for where it works.
    // A community session works in the agent's workspace, as
    // `conversationPlace` has it, whatever folder the chat kept.
    const canvasProjectOf = (
      elsewhere = settings.scope !== "community" &&
        // A Solo chat is one conversation, with no thread root.
        Boolean(this.folder(reads.scope, agent.key, channelId)),
    ) => canvasRead && project(canvasRead.text, elsewhere);
    const projectOf = (elsewhere?: boolean) =>
      [
        settings.scope === "community"
          ? undefined
          : canvasProjectOf(elsewhere)?.section,
        folders.section,
        skills,
      ]
        .filter(Boolean)
        .join("\n\n") || undefined;
    const canvasProject = canvasProjectOf();
    const projectText = projectOf();
    // A stop during the reads deleted this agent's entry; recreating it would
    // reopen the agent.
    delivery.signal.throwIfAborted();
    const toolRoot = channel?.dm || topLevel ? undefined : rootOf(event);
    const root = settings.scope === "channel" ? undefined : toolRoot;
    delivery.signal.throwIfAborted();
    const conversationKey = scopedKey(settings.scope, channelId, root);
    await rememberCommunitySource(
      this.storage,
      agent.key,
      settings.scope === "community" ? COMMUNITY_SESSION : channelId,
      channelId,
    );
    const sourceRoot = wake ? wake.root : rootOf(event);
    const admission = (deferred: boolean) =>
      delivery.prepareSession?.(
        {
          source: {
            channelId,
            ...(!channel?.dm && sourceRoot ? { root: sourceRoot } : {}),
          },
          conversation: {
            channelId,
            ...(settings.scope === "community"
              ? { community: true }
              : root
                ? { root }
                : {}),
          },
        },
        deferred,
      );

    if (await this.inspect?.(agent.key)) {
      if (
        settings.scope !== "community" &&
        this.folder(reads.scope, agent.key, channelId, root)
      )
        throw new Error(
          "Conversation folders are unavailable for agents on an execution target",
        );
      const handoff = this.controls.deliver(
        `${agent.key}/${conversationKey}`,
        async (deferred) => {
          deferred ||= admittedDeferred;
          const handover = deferred && AbortSignal.timeout(HANDOVER_MS);
          const admitted = await admission(deferred);
          const runtime = await this.connection(
            agent.key,
            reads.scope,
            conversationKey,
            deferred ? undefined : delivery.signal,
          );
          if (reserved || !deferred) delivery.signal.throwIfAborted();
          const lifetime = deferred ? runtime.target?.signal : delivery.signal;
          if (!lifetime)
            throw new Error("The remote Codex lifetime is unavailable");
          // Held work's deadline passed while it waited, so its hand-over
          // gets its own from now; the turn itself outlives it.
          const accepted = handover
            ? AbortSignal.any([lifetime, handover])
            : lifetime;
          await runtime.run({
            ...delivery,
            ...(admitted
              ? { session: admitted.session, sessionContext: admitted.context }
              : {}),
            signal: accepted,
          });
        },
      );
      if (handoff.deferred && !reserved) {
        delivery.workingUntil(handoff.done);
        return;
      }
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
    const request: TextRequest = {
      scope: reads.scope,
      ...(wake ? { current: delivery.current } : {}),
      event,
      ...(!topLevel ? { replyRoot: rootOf(event) } : {}),
      ...(wake ? { wake } : {}),
      ...(delivery.wakeText ? { wakeText: delivery.wakeText } : {}),
      agent,
      settings,
      ...(toolRoot ? { toolRoot } : {}),
      ...(delivery.model ? { model: delivery.model } : {}),
      ...(delivery.effort ? { effort: delivery.effort } : {}),
      ...(delivery.synced ? { synced: delivery.synced } : {}),
      activityScope: topLevel
        ? channelId
        : (threadReference(event)?.rootId ??
          (channel?.dm ? channelId : event.id)),
      conversation: {
        channelId,
        name: channel?.name ?? channelId,
        ...(settings.scope === "community" ? { community: true } : {}),
        ...(root ? { root } : {}),
        ...(topLevel ? { topLevel } : {}),
        ...(topLevel && !solo && !huddle ? { threadReplies: true } : {}),
      },
      team: delivery.team ?? "",
      ...(delivery.session ? { session: delivery.session } : {}),
      ...(delivery.sessionContext
        ? { sessionContext: delivery.sessionContext }
        : {}),
      ...(canvasProject ? { canvas: canvasProject } : {}),
      ...(solo ? { solo: true } : {}),
      ...(projectText ? { project: `${projectText}\n` } : {}),
      projectAt: (elsewhere: boolean) => {
        const text = projectOf(elsewhere);
        return text && `${text}\n`;
      },
      answered,
      failActivity,
      ...(delivery.accepted ? { accepted: delivery.accepted } : {}),
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
    const key = conversationKey;
    const entry = this.entry(agent.key, request.scope);
    // Reserve the shared position before asynchronous admission can yield.
    const communityLane =
      settings.scope === "community" ? laneFor(entry, key, true) : undefined;
    const activeCommunityTurn = communityLane?.active;
    const nextCommunityTurn = communityLane?.queued
      ? communityLane.next
      : undefined;
    const communityTarget =
      nextCommunityTurn?.request ?? activeCommunityTurn?.reply;
    const targetModel = nextCommunityTurn
      ? nextCommunityTurn.request.model
      : activeCommunityTurn?.model;
    const targetEffort = nextCommunityTurn
      ? nextCommunityTurn.request.effort
      : activeCommunityTurn?.effort;
    const queueCommunity =
      communityLane &&
      (!communityTarget ||
        (!nextCommunityTurn &&
          (activeCommunityTurn?.finished || activeCommunityTurn?.stopped)) ||
        communityLane.voice ||
        communityLane.voiceOpening ||
        communityTarget.unaddressed ||
        (request.model && request.model !== targetModel) ||
        (request.effort && request.effort !== targetEffort));
    entry.waiting.add(request);
    delivery.interruptible?.(() => this.interrupt(entry, key, request));
    const handoff = this.controls.deliver(
      `${agent.key}/${key}`,
      async (deferred) => {
        deferred ||= admittedDeferred;
        if (deferred) entry.abort.signal.throwIfAborted();
        else delivery.signal.throwIfAborted();
        const admitted = await admission(deferred);
        if (admitted) {
          request.session = admitted.session;
          if (admitted.context !== undefined)
            request.sessionContext = admitted.context;
          else delete request.sessionContext;
        }
        const admittedProject = projectOf();
        if (admittedProject) request.project = `${admittedProject}\n`;
        else delete request.project;
        const admittedCanvas = canvasProjectOf();
        if (admittedCanvas) request.canvas = admittedCanvas;
        else delete request.canvas;
        if (queueCommunity) return;
        const text = textOf(request.event, agent.name);
        const lane = laneFor(entry, key, false);
        if (lane.active || lane.queued || lane.behind) {
          const current = lane;
          let queued = false;
          const queue = () => {
            queued = true;
            this.start(request, text, key, current, entry);
          };
          const steer = async (active: Active) => {
            try {
              await active.ready;
              if (entry.abort.signal.aborted) {
                request.failActivity("Codex was stopped");
                return;
              }
              // Steering cannot carry a model or effort pick, so a
              // differing pick waits for this turn and runs as the next one.
              // Messages after it join that turn instead: steering would run
              // them first. A turn keeps the posting policy it was admitted
              // with, so a request in a Solo chat shared since, or the
              // reverse, waits for it too. A turn the owner stopped takes
              // nothing more.
              if (
                active.finished ||
                active.stopped ||
                (!communityLane && !request.solo !== !active.reply.solo) ||
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
              request.accepted?.();
              const project = communityLane
                ? entry.project.preview(
                    request.conversation.channelId,
                    request.solo ? request.canvas : NO_PROJECT,
                  ).section
                : undefined;
              const steered = active.rpc.request("turn/steer", {
                threadId: active.threadId,
                expectedTurnId: active.turnId,
                input: input(
                  `${context}${project ? `${project}\n\n` : ""}${(active.elsewhere === undefined ? request.project : request.projectAt?.(active.elsewhere)) ?? ""}${turnInput(request.agent.key, request.event, request.conversation, text, true, noteOf(request), wake, this.reads(request.agent.key)?.authorNames?.(request.event.pubkey))}`,
                ),
              });
              request.steering = steered.then(
                () => void delete request.steering,
                () => void delete request.steering,
              );
              await steered;
              if (communityLane)
                entry.project.resolve(
                  request.conversation.channelId,
                  request.solo ? request.canvas : NO_PROJECT,
                );
              // A wake steering in from elsewhere leaves unaddressed sends
              // answering the turn's destination; a message moves them.
              if (
                communityLane ||
                !request.wake ||
                (request.conversation.channelId ===
                  active.reply.conversation.channelId &&
                  request.replyRoot === active.reply.replyRoot)
              )
                active.reply = request;
              active.requests.push(request);
              entry.waiting.delete(request);
              this.touch(request, entry, key);
              this.acknowledgeActivity(active, request, true);
            } catch (error) {
              if (entry.abort.signal.aborted) {
                request.failActivity("Codex was stopped");
                return;
              }
              // A completion racing the request, or a turn that never
              // started, means this is the next ordinary turn.
              if (
                !active.turnId ||
                message(error) === "no active turn to steer"
              ) {
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
          };
          current.behind++;
          // Startup and history reads stay ordered without holding Agents delivery.
          const accepted = current.steering
            .then(async () => {
              // Behind a queued turn, a message joins it once it starts, so a
              // backlog clears in one turn rather than one turn per message.
              const active = communityLane
                ? await (nextCommunityTurn?.began ?? activeCommunityTurn)
                : current.queued
                  ? await current.next?.began
                  : current.active;
              if (!active) return queue();
              const steered = steer(active);
              // The turn ends only once what it may take in is placed.
              active.steering = Promise.all([
                active.steering,
                steered.catch(() => {}),
              ]).then(() => {});
              await steered;
            })
            .finally(() => current.behind--);
          current.steering = accepted.catch((error) =>
            console.error("Codex steering failed", error),
          );
          if (communityLane) await current.steering;
          return;
        }
        this.start(request, text, key, lane, entry);
      },
    );
    if (queueCommunity)
      this.start(
        request,
        textOf(request.event, agent.name),
        key,
        communityLane,
        entry,
        handoff.done.then(
          () => true,
          () => false,
        ),
      );
    const handed = handoff.done.catch((error) => {
      entry.waiting.delete(request);
      request.failActivity(message(error));
      throw error;
    });
    if (!handoff.deferred && !admittedDeferred) return handed;
    delivery.workingUntil(handed);
    void handed
      .catch(async (error) => {
        if (!entry.abort.signal.aborted)
          await this.publish(request, message(error));
      })
      .catch((error) => console.warn("Codex handover failed", error));
  }

  /** Runs an unaddressed wake without a default posting destination. Community
   * scope retains it in the shared session; other scopes use an ephemeral
   * thread. Asks for its prompt when admitted and logs failures without posting. */
  async runOnce(
    turn: StandaloneTurn,
    published?: () => void,
  ): Promise<TurnResult> {
    let answered = false;
    try {
      const result = await this.standalone(turn, false, () => {
        answered = true;
        published?.();
      });
      return answered ? { ok: true } : result;
    } catch (error) {
      if (answered) return { ok: true };
      throw error;
    }
  }
  private async standalone(
    { delivery, key, signal: turnSignal, prompt }: StandaloneTurn,
    reserved = false,
    published = () => {},
  ): Promise<TurnResult> {
    if (this.disposed) throw new Error("Codex runtime is disposed");
    if (this.resolveConfig(delivery.config).scope === "community" && !reserved)
      return this.controls.wake(
        `${delivery.agent.key}/${scopedKey("community", COMMUNITY_SESSION)}`,
        turnSignal,
        (signal) =>
          this.standalone({ delivery, key, signal, prompt }, true, published),
      );
    const { agent } = delivery;
    const reads = this.reads(agent.key);
    if (!reads)
      return { ok: false, error: "Connect to the agent's community first" };
    const { scope } = reads;
    const settings = this.resolveConfig(delivery.config);
    if (settings.scope === "community") {
      const key = scopedKey(settings.scope, COMMUNITY_SESSION);
      if (this.execution && (await this.inspect?.(agent.key))) {
        const runtime = await this.connection(
          agent.key,
          scope,
          key,
          turnSignal,
        );
        return runtime.runOnce(
          { delivery, key, signal: turnSignal, prompt },
          published,
        );
      }
      if (this.disposed) throw new Error("Codex runtime is disposed");
      const entry = this.entry(agent.key, scope);
      const lane = laneFor(entry, key, true);
      let outcome: TurnResult = { ok: true };
      const request: TextRequest = {
        scope,
        agent,
        settings,
        team: delivery.team ?? "",
        current: () => !turnSignal.aborted && delivery.current(),
        unaddressed: { prompt, signal: turnSignal },
        activityScope: COMMUNITY_SESSION,
        conversation: {
          channelId: COMMUNITY_SESSION,
          name: "Community",
          community: true,
        },
        event: {
          id: crypto.randomUUID(),
          pubkey: agent.pubkey,
          kind: 9,
          content: "",
          created_at: Date.now() / 1000,
          tags: [],
        } as EventData,
        ...(delivery.synced ? { synced: delivery.synced } : {}),
        answered(stopped) {
          if (request.finalDelivery === true) published();
          else if (stopped) outcome = { ok: false, error: "Codex was stopped" };
        },
        failActivity(error) {
          if (error !== "Codex ended without a final reply")
            outcome = { ok: false, error };
        },
      };
      entry.waiting.add(request);
      try {
        const handoff = this.controls.deliver(
          `${agent.key}/${key}`,
          async () => {},
        );
        const job = this.start(
          request,
          "",
          key,
          lane,
          entry,
          handoff.done.then(() => true),
        );
        await abortable(Promise.all([handoff.done, job]), turnSignal);
      } catch (error) {
        return { ok: false, error: message(error) };
      } finally {
        entry.waiting.delete(request);
      }
      return outcome;
    }
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
        undefined,
        "standalone",
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
          .catch(() => server.rpc.close("turn interrupt"));
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

  /** Drops a queued community request or stops the turn that took it in.
   * Stops of one turn share its interrupt, so one that fails cannot undo another. */
  private interrupt(
    entry: Entry,
    key: string,
    request: Request,
  ): Promise<void> {
    if (entry.waiting.has(request)) {
      if (request.settings.scope !== "community")
        return Promise.reject(
          new Error("Codex has not started on this message yet"),
        );
      // Codex is still deciding on its steer: stop the turn it joins, or drop it.
      if (request.steering)
        return request.steering.then(() => this.interrupt(entry, key, request));
      request.current = () => false;
      request.answered(true);
      return Promise.resolve();
    }
    const active = entry.lanes.get(key)?.active;
    if (!active?.requests.includes(request) || active.finished)
      return Promise.resolve();
    active.stopped = true;
    active.tools.abort(new Error("The owner stopped the turn"));
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
        if (!active.finished) {
          active.stopped = false;
          active.tools = new AbortController();
        }
        throw error;
      }
    })();
    return active.stopping;
  }

  private async interruptForVoice(entry: Entry, key: string, active: Active) {
    await this.interrupt(entry, key, active.reply);
    if (active.finished || !active.nativeCompleted) return;
    try {
      await withTimeout(
        active.nativeCompleted.catch(() => {}),
        "Codex did not finish the turn while opening the Huddle",
        INTERRUPTED_TURN_COMPLETION_MS,
      );
    } catch (error) {
      active.voiceRetirement = active.rpc.close();
      await active.voiceRetirement;
      throw error;
    }
  }

  /** A positive harness response transfers presentation, not execution or
   * success. Watches have no bubble; mentions in other threads keep theirs,
   * and a top-level chat is one scope. */
  private acknowledgeActivity(
    active: Active,
    request: Request,
    steering = false,
  ) {
    if (request.step) {
      const scope = request.activityScope;
      const prior = active.activity.get(scope);
      if (prior === request) return;
      prior?.superseded?.();
      active.activity.set(scope, request);
    }
    request.acknowledged?.(steering ? { steering: true } : undefined);
  }

  private async drainRejectedSpeech(
    rpc: AppServer,
    threadId: string,
    turnId: string,
  ) {
    // This turn cannot use the seat's signal: closing media aborts it.
    const followed = follow(rpc, undefined, {
      threadId,
      turnId,
      finished: false,
    });
    try {
      await this.drainInterruptedTurn(rpc, threadId, {
        id: turnId,
        completed: followed.completed,
      });
    } finally {
      followed.stop();
    }
  }

  private async drainInterruptedTurn(
    rpc: AppServer,
    threadId: string,
    turn?: { id: string; completed: Promise<string> },
  ) {
    try {
      if (turn) {
        await rpc.request("turn/interrupt", { threadId, turnId: turn.id });
        await withTimeout(
          turn.completed,
          "Codex did not finish the interrupted turn",
          INTERRUPTED_TURN_COMPLETION_MS,
        );
      }
      await this.terminals(rpc, threadId, STOP_LINGER_MS);
    } catch {
      await rpc.close();
    }
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
        .catch(() => rpc.close("turn interrupt"));
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
        .catch(() => rpc.close("thread unsubscribe"));
      throw error;
    } finally {
      signal.removeEventListener("abort", interrupt);
      off();
      followed.stop();
    }
  }

  private start(
    request: TextRequest,
    text: string,
    key: string,
    lane: Lane,
    entry: Entry,
    admitted?: Promise<boolean>,
  ) {
    const current = lane;
    current.queued++;
    let began!: (active?: Active) => void;
    const next: Next = {
      request,
      began: new Promise((resolve) => (began = resolve)),
      begin: (active) => {
        next.begin = () => {};
        current.queued--;
        began(active);
      },
    };
    current.next = next;
    const job = lane.tail
      .catch(() => undefined)
      .then(async () => {
        const ready = admitted ? await admitted : true;
        // A server-started voice turn can arrive after this job was queued.
        while (current.active || current.voice?.rejectedSpeechClosing)
          await (current.active?.released ??
            current.voice?.rejectedSpeechClosing);
        entry.waiting.delete(request);
        if (!ready) return;
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
          // A rerun waits for the retired Huddle seat to let go of the lane.
          while (await this.execute(request, text, key, current, entry, next))
            await current.voice?.rejectedSpeechClosing;
        } catch (error) {
          request.failActivity(message(error));
          throw error;
        }
      })
      // Messages that joined a turn that never began queue on their own.
      .finally(() => next.begin());
    lane.tail = job;
    this.status(request.agent.key, key, "Starting");
    // Agents can deliver follow-ups and other conversations immediately.
    void job
      .catch(async (error) => {
        entry.waiting.delete(request);
        request.failActivity(message(error));
        const reason = `Codex could not start: ${message(error)}.`;
        this.status(request.agent.key, key, "Needs attention", reason);
        await this.publish(request, reason).catch((failure) =>
          console.error("Codex could not publish its failure", failure),
        );
      })
      .finally(() => {
        if (
          current.tail === job &&
          !current.active &&
          !current.voice &&
          !current.voiceOpening
        ) {
          entry.lanes.delete(key);
          if (this.entries.get(request.agent.key) !== entry) return;
          if (
            this.sessions(request.agent.key).find((view) => view.key === key)
              ?.status === "Starting"
          )
            this.status(request.agent.key, key, "Idle");
          else for (const listener of this.listeners) listener();
        }
      });
    return job;
  }
  private async history(request: TextRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    const reads = this.reads(request.agent.key);
    if (reads?.scope !== request.scope)
      throw new Error("The community changed");
    if (request.unaddressed) return "";
    try {
      // A chat its owner is still creating has nothing earlier to read.
      const starting = (await reads.channel(request.conversation.channelId))
        ?.starting;
      return await conversationHistory(
        request.event,
        request.conversation,
        (filters) =>
          starting ? Promise.resolve([]) : reads.read(filters, signal),
        reads,
        reads.workflowAuthority(),
      );
    } catch (error) {
      // The relay session already retried; a slow relay costs the turn its
      // earlier messages, not the turn itself.
      if (signal.aborted || !isRetryableRead(error)) throw error;
      console.warn("Codex could not read the conversation", error);
      // Without history, the turn still names who asked.
      await readAuthorNames(reads, [request.event]);
      return "";
    }
  }
  // Tags the owner even when a sibling asked: tagging the sibling would wake
  // it, and two agents failing alike would wake each other without end.
  /** Posts a failure where the turn still owes an answer. The latest
   * conversation gets `content`; another a community turn took in gets a
   * generic retry notice, so one conversation's details stay out of it. */
  private async publishOwed(active: Active, content: string) {
    const where = (taken: Request) =>
      `${taken.conversation.channelId}/${taken.replyRoot ?? ""}`;
    if (
      !active.reply.conversation.community &&
      active.requests.every((taken) => where(taken) === where(active.reply))
    )
      return void (await this.publish(active.reply, content));
    const owed = new Map<string, Request>();
    for (const taken of active.requests)
      if (taken.finalDelivery !== true) owed.set(where(taken), taken);
    const latest = where(active.reply);
    await Promise.all(
      [...owed].map(([key, taken]) =>
        this.publish(
          taken,
          key === latest
            ? content
            : "Codex could not finish this request. Send another mention to retry.",
        ),
      ),
    );
  }
  private publish(request: Request, content: string) {
    if (request.unaddressed) return Promise.resolve();
    return request.agent.publish({
      kind: 9,
      content: this.explain(content),
      tags: [
        ["h", request.conversation.channelId],
        ...(request.replyRoot !== undefined
          ? [["e", request.replyRoot, "", "reply"]]
          : []),
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
    const signal = active
      ? AbortSignal.any([turn.signal, active.tools.signal])
      : turn.signal;
    const check = () => {
      signal.throwIfAborted();
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
    const answering = active ? [...active.requests] : [];
    // Undefined uses the default destination; null is an explicit one that
    // answers no request in this turn.
    const community = active?.reply.settings.scope === "community";
    // Only a community turn or one spanning destinations picks a request by
    // its routing arguments; elsewhere a request ID only attributes the send.
    const spanning =
      community ||
      new Set(answering.map((taken) => taken.activityScope)).size > 1;
    const target =
      active &&
      spanning &&
      (call.tool === "send" || call.tool === "reply_in_subthread")
        ? addressed(
            args,
            answering,
            community,
            await placeOf(active.reply.agent, args, answering),
          )
        : undefined;
    const request = target ?? active?.reply;
    const owner = request ?? (once as Once);
    const { agent } = owner;
    const client = () =>
      appClient(agent, {
        // Its tool registry reviews every call, Buzz's dynamic tools included.
        ...(!this.target ? { nativeCall: check } : {}),
        nativeToolGate: true,
        // Execution-target reads come from somewhere other than this desktop;
        // suppress managed-attachment hints at publish so a remote source cannot
        // trigger local managed cleanup. No remote deletion is added.
        localAttachments: !this.target,
        protectionContext: async () => {
          const rpc =
            active?.rpc ??
            this.protectedServers.get(agent.key)?.rpc ??
            this.server?.rpc;
          if (!rpc)
            throw new Error("The protected Codex session is unavailable");
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
                signal,
                agent.protection?.processProtection,
              ),
        check,
        signal,
        callSignal: signal,
        memories: async (slug) => {
          const listing = await this.memories(owner, signal, slug);
          check();
          return listing;
        },
        remembered: () => {
          const reads = this.reads(agent.key);
          if (reads) this.memoryReads.forget(reads.connection, agent.pubkey);
        },
      });
    // A watch or timer turn has no default destination.
    const context: Context =
      request && !request.unaddressed
        ? {
            ...(request.session ? { session: request.session } : {}),
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
    // A turn spanning destinations answers each with its own final send.
    const settling =
      request?.conversation.community || spanning
        ? target === null
          ? []
          : answering.filter(
              (taken) => taken.activityScope === request?.activityScope,
            )
        : answering;
    const reply = await callSessionTool(
      () =>
        this.target
          ? {
              ...client(),
              media: async () => {
                this.target?.signal.throwIfAborted();
                throw new Error(
                  "Media download is unavailable for remote Codex agents.",
                );
              },
            }
          : client(),
      context,
      call.tool,
      args,
      this.added(),
    ).catch((error) => {
      if (final)
        for (const taken of settling)
          if (taken.finalDelivery !== true)
            taken.finalDelivery = new Error(message(error));
      throw error;
    });
    if (final) {
      for (const taken of settling) {
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
      await rpc.close("background terminal cleanup");
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
    // config. The title thread turns MCP servers, plugins and apps off
    // whatever the conversation allows.
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
            "features.plugins": false,
            "features.apps": false,
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

  /** The model and effort a turn runs on: `pick`'s when available. */
  private async turnModel(
    rpc: AppServer,
    settings: Config,
    pick: Readonly<{ model?: string; effort?: string }>,
    synced?: Delivery["synced"],
  ) {
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
    // A picked model may not support the configured effort.
    const effort = resolveEffort(selected, pick.effort, settings.effort);
    // A synced effort is the agent's on every device: never run another.
    const kept = synced?.effort;
    if (kept && !pick.model && !pick.effort && effort !== kept)
      throw new Error(unsupportedSynced("effort", kept, `Codex's ${model}`));
    return { model, effort };
  }

  /** What a thread for `agent` starts or resumes with in `workspace`, and the
   * model and effort its turn runs on: `pick`'s when available. */
  private async prepare(
    rpc: AppServer,
    // Protected when it has a policy, bound or not yet.
    agent: Pick<
      AgentHandle,
      "key" | "name" | "pubkey" | "relay" | "promptSections"
    > & {
      protection?: unknown;
    },
    settings: Config,
    workspace: string,
    pick: Readonly<{ model?: string; effort?: string }>,
    synced?: Delivery["synced"],
    /** The agent's workspace, when `workspace` is the conversation's folder. */
    home?: string,
    /** What the thread is, for its Session Model. */
    place?: Facts["place"],
  ) {
    const normalized = await rpc.request<{
      config: {
        mcp_servers?: Record<string, Record<string, unknown>>;
        model_reasoning_summary?: string | null;
        features?: { hooks?: boolean; codex_hooks?: boolean };
      };
    }>("config/read", { cwd: workspace });
    const { model, effort } = await this.turnModel(rpc, settings, pick, synced);
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
    // Codex sets it on this thread's commands only; app-server has none.
    const credential = await rpc.toolCredential(agent);
    // Read once: what the thread is told and what its saved prompt shows
    // come from the same choices.
    const choices = agent.promptSections?.();
    const base = composeBase(baseFacts(settings, home, place), choices);
    const params = {
      model,
      cwd: workspace,
      developerInstructions: developerInstructions(agent, base.text),
      approvalPolicy: "never",
      // Matches Claude's bypassPermissions; only the owner's mentions and the
      // agent's own watches and timers start work.
      sandbox: "danger-full-access",
      config: {
        ...(hooks ? { "hooks.state": hooks } : {}),
        web_search: "disabled",
        mcp_servers: { ...mcp, ...bridge?.config },
        ...(settings.apps && !agent.protection
          ? {}
          : { "features.plugins": false, "features.apps": false }),
        ...(credential && {
          [`shell_environment_policy.set.${CREDENTIAL_ENV}`]: credential,
        }),
        // Codex compacts at the lower of this and its own limit.
        ...(compactAt(settings.compactAt) && {
          model_auto_compact_token_limit: compactAt(settings.compactAt),
        }),
      },
    };
    // Ask for reasoning summaries unless the user chose a summary mode.
    const summary = normalized.config.model_reasoning_summary
      ? {}
      : { summary: "auto" };
    return { params, model, effort, summary, bridge, base, choices };
  }
  /** Shared thread setup; a voice seat retains it between delegated turns. */
  /** A thread's key in its saved prompts. */
  private promptKey(threadId: string) {
    return this.targetKey
      ? JSON.stringify([this.targetKey, threadId])
      : threadId;
  }

  /** The sections to save for `loaded`'s thread. Its saved prompt shows them
   * again when they changed since it last did; the binding has what it last
   * showed, as a seat's typed and spoken turns share one loaded thread. Only
   * the binding of this thread counts: a fresh replacement has shown none. */
  private showSections(
    agentKey: AgentKey,
    entry: Entry,
    key: string,
    { threadId, fresh, sections, base, updates }: Loaded,
  ): Saved["sections"] {
    if (!sections) return undefined;
    const binding = entry.saved[key];
    const last =
      (binding?.threadId === threadId ? binding.sections?.shown : undefined) ??
      sections.shown;
    if (fresh || base.key === (last ?? sectionsKey(sections.parts)))
      return last ? { ...sections, shown: last } : sections;
    void this.prompts(agentKey).add(this.promptKey(threadId), {
      label: `base-section-updates ${new Date().toISOString()}`,
      // Without the block's tag lines, so it is shown under the label.
      text: updates
        ? updates.split("\n").slice(1, -1).join("\n")
        : "Every section is as the thread's base instructions give it.",
    });
    return { ...sections, shown: base.key };
  }

  /** Whether a thread that started with `sections` can be given `base`.
   * One from before its sections were kept cannot be told which of them
   * the owner changed, so it starts fresh once. A remote thread is kept by
   * design, as restarting it would stop the conversation with a reset
   * error: it keeps the sections it started with until the owner chooses
   * New. */
  private keepsSections(
    sections: Saved["sections"],
    base: Pick<ReturnType<typeof composeBase>, "custom">,
  ) {
    return !base.custom || sections?.layout === LAYOUT || !!this.target;
  }

  async loadThread(
    request: Request,
    entry: Entry,
    key: string,
    signal: AbortSignal,
    server: Server,
    rpc: AppServer,
    voiceInstructions?: string,
  ) {
    const { settings, agent } = request;
    // The process host expands ~/… and creates the directory; Codex's RPC needs
    // an absolute path rather than shell-style home notation.
    const { cwd: workspace, home } = await this.conversationPlace(
      request.scope,
      agent.key,
      request.conversation,
      settings,
    );
    signal.throwIfAborted();
    const saved = entry.saved[key];
    const existing = resumable(saved, agent.protection);
    const { params, model, effort, summary, bridge, base, choices } =
      await this.prepare(
        rpc,
        agent,
        settings,
        workspace,
        request,
        request.synced,
        home,
        sessionPlace(request.conversation),
      );
    if (voiceInstructions) {
      Object.assign(params.config, {
        "realtime.type": "conversational",
        "features.realtime_conversation": true,
      });
      params.developerInstructions += `\n${voiceInstructions}`;
    }
    let threadId: string | undefined;
    try {
      // Resume restores the thread's tools, so one started with other added
      // tools starts fresh.
      const added = this.added();
      const tools = addedKey(added);
      const resuming =
        existing?.workspace === workspace &&
        (existing.tools ?? "") === tools &&
        this.keepsSections(existing.sections, base);
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
        await rpc.confirmThreadReleased(threadId);
        signal.throwIfAborted();
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
      threadId = started.thread.id;
      bridge?.bind(threadId);
      server.threads.set(threadId, agent.key);
      signal.throwIfAborted();
      await rpc.request("thread/name/set", {
        threadId: threadId,
        name: sessionName(agent, request.conversation),
      });
      // Only a thread started here has the current sections.
      const sections: Saved["sections"] = fresh
        ? startedSections(base.parts)
        : existing?.sections;
      const facts = baseFacts(
        settings,
        home,
        sessionPlace(request.conversation),
      );
      return {
        threadId,
        workspace,
        // Where it works, which its Canvas states the rule from.
        elsewhere: Boolean(home),
        params,
        model,
        effort,
        summary,
        bridge,
        tools,
        saved,
        existing,
        resuming,
        fresh,
        base,
        facts,
        sections,
        updates: fresh
          ? ""
          : sectionUpdates(existing?.sections, facts, choices),
      };
    } catch (error) {
      if (threadId) await rpc.releaseThread(threadId).catch(() => {});
      await bridge?.close();
      throw error;
    }
  }

  private async execute(
    request: TextRequest | (Request & { adopted: string }),
    text: string,
    key: string,
    lane: Lane,
    entry: Entry,
    next?: Next,
  ) {
    const { adopted } = request;
    let ready!: () => void;
    let notReady!: (error: unknown) => void;
    let release!: () => void;
    const turnAbort = new AbortController();
    const server = this.open(request.agent);
    // No deadline of our own: a turn runs until Codex ends it.
    const signal = AbortSignal.any([
      entry.abort.signal,
      turnAbort.signal,
      ...(request.unaddressed ? [request.unaddressed.signal] : []),
      ...(adopted && lane.voice ? [lane.voice.signal] : []),
    ]);
    const active: Active = {
      rpc: server.rpc,
      ...(adopted && lane.voice
        ? { threadId: lane.voice.loaded.threadId, turnId: adopted }
        : {}),
      ready: new Promise((resolve, reject) => {
        ready = resolve;
        notReady = reject;
      }),
      released: new Promise((resolve) => {
        release = resolve;
      }),
      steering: Promise.resolve(),
      reply: request,
      finished: false,
      workspace: lane.voice?.loaded.workspace ?? request.settings.workspace,
      signal,
      tools: new AbortController(),
      requests: [request],
      activity: new Map(),
    };
    void active.ready.catch(() => undefined);
    lane.active = active;
    next?.begin(active);
    const { settings, agent } = request;
    // A community wake can report its deadline before Codex has stopped.
    const waitForNative = request.unaddressed !== undefined;
    const followed = follow(
      server.rpc,
      waitForNative ? undefined : signal,
      active,
      (method, item) => {
        if (signal.aborted) return;
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
      },
    );
    active.nativeCompleted = followed.completed;
    let hookBridge: Awaited<ReturnType<typeof openHookBridge>> | undefined;
    let explain: (() => string | undefined) | undefined;
    let turnFailed = false;
    let turnMayBeRunning = adopted !== undefined;
    /** The voice seat whose thread this turn runs on, if any. */
    let seat: Lane["voice"];
    try {
      const rpc = await server.opening;
      signal.throwIfAborted();
      const standaloneText = request.unaddressed
        ? await request.unaddressed.prompt()
        : undefined;
      if (
        request.unaddressed &&
        (standaloneText === undefined || !request.current?.())
      ) {
        active.finished = true;
        ready();
        return;
      }
      seat = lane.voice;
      // A seat keeps its loaded thread between turns, and the owner can
      // change a section meanwhile: its turns get the sections as they are.
      const choices = seat && agent.promptSections?.();
      if (
        seat &&
        adopted === undefined &&
        !this.keepsSections(
          seat.loaded.sections,
          composeBase(seat.loaded.facts, choices),
        )
      ) {
        // Typed work goes on in a fresh thread, which the seat joins next.
        seat.end(
          new Error(
            "The base instructions changed. Join the huddle again to use them.",
          ),
        );
        seat = undefined;
      }
      const loaded =
        seat?.loaded ??
        (await this.loadThread(request, entry, key, signal, server, rpc));
      // A typed turn on a seat's thread still runs on its own picks.
      const { model, effort } =
        seat && adopted === undefined
          ? await this.turnModel(rpc, settings, request, request.synced)
          : loaded;
      const {
        threadId,
        workspace,
        params,
        summary,
        bridge,
        tools,
        saved,
        resuming,
        fresh,
        sections,
      } = loaded;
      const base = seat ? composeBase(loaded.facts, choices) : loaded.base;
      const updates = seat
        ? sectionUpdates(sections, loaded.facts, choices)
        : loaded.updates;
      // The seat owns the subscription. The typed follower can claim its
      // native turn only once the typed request is about to be sent.
      if (!seat || adopted !== undefined || settings.scope !== "community")
        active.threadId = threadId;
      // A refusal outside this turn does not explain how it ends.
      explain = server.explainer?.(threadId);
      active.workspace = workspace;
      active.elsewhere = loaded.elsewhere;
      active.model = model;
      active.effort = effort;
      // The seat owns its retained bridge; individual turns must not close it.
      hookBridge = seat ? undefined : bridge;
      if (request.adopted !== undefined) {
        ready();
      } else {
        const [context, memory] = await Promise.all([
          this.history(request, signal),
          this.core(request.agent.key, signal),
        ]);
        const wake = request.wake && {
          ...request.wake,
          text: (await request.wakeText?.()) ?? request.wake.text,
        };
        const additionalContext = turnContext(
          agent,
          settings,
          request.team,
          memory,
          this.repositories(request.scope),
          updates,
        );
        signal.throwIfAborted();
        if (request.current && !request.current()) {
          restoreNotes(request);
          request.answered();
          this.status(agent.key, key, "Idle");
          active.finished = true;
          ready();
          return;
        }
        if (this.target && !resuming)
          await this.save(request, entry, key, {
            pending: true,
            threadId,
            workspace,
            at: Date.now(),
            ...(tools ? { tools } : {}),
            ...(sections ? { sections } : {}),
          });
        if (active.rejectedSpeech) await active.rejectedSpeech;
        // Speech that would not stop closed this app-server: start again on a new one.
        const again =
          active.rejectedSpeech !== undefined &&
          rpc.exited &&
          request.current?.() !== false;
        if (
          again ||
          signal.aborted ||
          (request.current && !request.current())
        ) {
          if (this.target && !resuming) {
            // An empty remote thread has no rollout to resume on the next request.
            const { [key]: _, ...kept } = entry.saved;
            await this.storage.set(entry.storageKey, JSON.stringify(kept));
            entry.saved = kept;
          }
          signal.throwIfAborted();
          restoreNotes(request);
          if (again) active.requests = [];
          else {
            request.answered();
            this.status(agent.key, key, "Idle");
          }
          active.finished = true;
          ready();
          return again;
        }
        signal.throwIfAborted();
        request.accepted?.();
        // A folder assigned since it was admitted can differ from where
        // its thread works, which its Canvas states the rule from.
        if (active.elsewhere !== undefined && request.projectAt) {
          const placed = request.projectAt(active.elsewhere);
          if (placed) request.project = placed;
          else delete request.project;
        }
        if (settings.scope === "community")
          request.project =
            [
              entry.project.preview(
                request.unaddressed
                  ? undefined
                  : request.conversation.channelId,
                request.solo ? request.canvas : NO_PROJECT,
              ).section,
              request.project,
            ]
              .filter(Boolean)
              .join("\n\n") + "\n\n";
        active.threadId = threadId;
        const turnParams = {
          threadId: active.threadId,
          input: input(
            (standaloneText === undefined
              ? undefined
              : [
                  `<context>\n${JSON.stringify({ agent: agent.key, session_scope: "community" })}\n</context>`,
                  request.project,
                  standaloneText,
                  ownerInstructions(undefined, true),
                ]
                  .filter(Boolean)
                  .join("\n\n")) ??
              `${context}${request.project ?? ""}${turnInput(request.agent.key, request.event, request.conversation, text, false, noteOf(request), wake, this.reads(request.agent.key)?.authorNames?.(request.event.pubkey))}`,
          ),
          model,
          effort,
          ...summary,
          // Application context is a developer message that updates on each turn.
          additionalContext,
        };
        // A lost start reply can leave an accepted turn running without its ID.
        turnMayBeRunning = true;
        const turn = await rpc
          .request<{ turn: { id: string } }>("turn/start", turnParams)
          .catch(async (error: unknown) => {
            if (error instanceof Refused) {
              if (!active.turnId) turnMayBeRunning = false;
              if (this.target && !resuming) {
                const { [key]: _, ...kept } = entry.saved;
                await this.storage.set(entry.storageKey, JSON.stringify(kept));
                entry.saved = kept;
              }
            }
            throw error;
          });
        if (settings.scope === "community")
          entry.project.resolve(
            request.unaddressed ? undefined : request.conversation.channelId,
            request.solo ? request.canvas : NO_PROJECT,
          );
        active.turnId = turn.turn.id;
        const session = this.promptKey(threadId);
        // A seat's turns get the sections as they are now, also on the
        // fresh thread it loaded.
        const saving = this.showSections(agent.key, entry, key, {
          ...loaded,
          fresh: fresh && !seat,
          base,
          updates,
        });
        if (fresh)
          void this.prompts(agent.key).save(session, [
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
          ]);
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
          threadId,
          workspace,
          at: Date.now(),
          ...(tools ? { tools } : {}),
          ...(agent.protection
            ? { protection: agent.protection.stateKey }
            : {}),
          ...(saving ? { sections: saving } : {}),
        });
        ready();
        this.status(agent.key, key, "Working");
      }
      const status = await (waitForNative
        ? abortable(followed.completed, signal)
        : followed.completed);
      await active.steering;
      // Closing the seat after Codex completed does not undo its spoken reply.
      if (adopted === undefined || !active.finished) signal.throwIfAborted();
      if (status === "interrupted" && active.stopped) {
        for (const taken of active.requests) taken.answered(true);
        await this.terminals(rpc, threadId, STOP_LINGER_MS);
        this.status(agent.key, key, "Stopped");
      } else if (status === "interrupted") {
        for (const taken of active.requests)
          taken.failActivity("Codex’s turn was interrupted");
        await this.terminals(rpc, threadId);
        await this.publishOwed(
          active,
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
      turnFailed = true;
      // Refused before any turn began, it took nothing in.
      if (error instanceof Refused && !active.turnId) restoreNotes(request);
      for (const taken of active.requests) taken.failActivity(message(error));
      const ended = active.finished;
      const drainingWake = waitForNative && signal.aborted;
      if (!drainingWake) active.finished = true;
      notReady(error);
      await active.steering;
      // Other agents share the server, so even a stopped agent interrupts
      // its turn rather than ending the process.
      if (
        signal.aborted &&
        (!ended || drainingWake) &&
        active.threadId &&
        active.turnId
      ) {
        if (drainingWake) {
          await this.drainInterruptedTurn(
            server.rpc,
            active.threadId,
            active.finished
              ? undefined
              : { id: active.turnId, completed: followed.completed },
          );
        } else {
          try {
            await server.rpc.request("turn/interrupt", {
              threadId: active.threadId,
              turnId: active.turnId,
            });
            turnMayBeRunning = false;
            await this.terminals(server.rpc, active.threadId);
          } catch {
            await server.rpc.close("turn interrupt");
          }
        }
      }
      active.finished = true;
      const why = explain?.();
      if (!signal.aborted) {
        const reason = `Codex could not finish: ${message(error)}.`;
        await this.publishOwed(active, reason).catch((failure) =>
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
      // A turn Codex took in has ended, however it ended.
      if (active.turnId && !entry.abort.signal.aborted)
        this.touch(request, entry, key);
      if (
        adopted === undefined &&
        settings.scope === "community" &&
        lane.voice &&
        !lane.voice.signal.aborted
      )
        await lane.voice.restore().catch(() => {});
      turnAbort.abort(new Error("The Codex turn has ended"));
      try {
        // Loaded-thread rejoin ignores config overrides while subscribed.
        if (active.threadId && !seat)
          await server.rpc
            .releaseThread(active.threadId)
            .catch(async (error) => {
              if (turnMayBeRunning && !followed.sawCompletion)
                return server.rpc.close("thread unsubscribe");
              if (
                !turnFailed &&
                (this.server === server ||
                  this.protectedServers.get(agent.key) === server)
              )
                this.status(agent.key, key, "Needs attention", message(error));
              if (error instanceof RequestTimeout)
                await server.rpc.closeIfUnresponsive();
            });
      } finally {
        followed.stop();
        try {
          await hookBridge?.close();
          if (active.voiceRetirement)
            await active.voiceRetirement.catch(() => {});
        } finally {
          if (lane.active === active) {
            delete lane.active;
            if (
              request.unaddressed?.signal.aborted &&
              !entry.abort.signal.aborted
            )
              this.status(agent.key, key, "Stopped");
          }
          release();
        }
      }
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
  signal: AbortSignal | undefined,
  turn: { threadId?: string; turnId?: string; finished: boolean },
  onItem?: (method: string, item: Item) => void,
) {
  let finish!: (status: string) => void;
  let fail!: (error: Error) => void;
  let sawCompletion = false;
  const completed = new Promise<string>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  void completed.catch(() => undefined);
  const abort = () => fail(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
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
    if (p.turn && turn.turnId && p.turn.id !== turn.turnId) return;
    const terminalTurn = wire.method === "turn/completed" ? p.turn : undefined;
    // Local failure can settle the caller before Codex settles the turn.
    if (terminalTurn) sawCompletion = true;
    if (turn.finished) return;
    if (wire.method === "turn/started" && p.turn) turn.turnId = p.turn.id;
    if (p.item && wire.method) onItem?.(wire.method, p.item);
    if (terminalTurn) {
      turn.finished = true;
      if (terminalTurn.status === "failed")
        fail(new Error(terminalTurn.error?.message ?? "Codex turn failed"));
      else finish(terminalTurn.status);
    }
  });
  return {
    completed,
    get sawCompletion() {
      return sawCompletion;
    },
    stop() {
      signal?.removeEventListener("abort", abort);
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
