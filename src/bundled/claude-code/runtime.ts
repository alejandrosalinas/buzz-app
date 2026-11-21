import { readSubthread } from "../../features/relay/subthread";
import { ownerInstructions } from "../../features/agent-harness/plugin-instructions";
import {
  ProjectSource,
  NO_PROJECT,
} from "../../features/agent-harness/project";
import {
  COMMUNITY_SESSION,
  standaloneTurn,
  sessionScope,
  communityTurn,
  scopedSessionKey,
  scopeOfSession,
  rememberCommunitySource,
  sessionSource,
} from "../../features/agent-harness/session-scope";
import { protectionTranscript } from "./protection-transcript";
import { compactAt } from "../../features/agents/compact-at";
import type { PRESET } from "../../features/agents/recommended";
import { fileStore } from "../../features/agents/state";
import type { AgentExecution } from "../../features/agents/execution";
import { executionSpawn } from "./execution";
// Turns Agents deliveries into Claude turns. Each agent of this type has its
// own sessions; a delivery becomes a prompt in the harness format, sent to the
// session for its conversation; a standalone turn, such as a watch's or a
// timer's, runs as a one-off process. The run returns once the turn is handed over,
// so one agent works in several conversations at once. Claude acts in Buzz with
// the in-process Buzz tools, signed by the agent's native-held key; the runtime
// only reports a turn that fails.
import type { Context } from "../../buzz-mcp/client";
import type { InvocationSubthread } from "../../features/agents/session-admission";
import { RESUMED_PROMPT } from "../../buzz-mcp/prompt";
import { type Listing, respond } from "../../buzz-mcp/rpc";
import {
  type AddedTool,
  addedKey,
  sessionHint,
  turnNote,
  isFinalMessage,
} from "../../buzz-mcp/session-tools";
import {
  unsupportedSynced,
  unverifiedSynced,
} from "../../features/agents/agent-config";
import {
  mentionAuthority,
  workflowOf,
} from "../../features/agents/owner-attestation";
import {
  promptSections,
  type TranscriptTurn,
} from "../../features/agents/activity-transcript";
import { type AgentReads, workflowMarked } from "../../features/agents/reads";
import { localStore, type AgentStore } from "../../features/agents/store";
import {
  agentFolders,
  conversationFolder,
  conversationKey,
  existingFolder,
  startingFolder,
} from "../../features/agents/conversation-folders";
import type {
  Agent,
  AgentHandle,
  Agents,
  Delivery,
  Effort,
  Models,
  StandaloneTurn,
  TurnResult,
} from "../../features/agents/service";
import { pubkeyOf, type AgentKey } from "../../features/agents/membership";
import type { Host } from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import type { ChannelLabel } from "../../features/channels/channel-icon";
import { threadReference } from "../../features/relay/thread-reference";
import {
  wakeAnchor,
  wakeLands,
} from "../../features/agent-harness/plugin-wake";
import type { ClaudeModel, Settled, Spawn, ToolServer } from "./claude";
import { appClient, readFile, relayKeyOf } from "../../buzz-mcp/app-client";
import {
  MemoryReads,
  READ_TIMEOUT_MS,
  recentNotesSection,
} from "../../features/agent-harness/core-memory";
import { readAuthorNames } from "../../features/agent-harness/author-names";
import {
  readProject,
  worksElsewhere,
} from "../../features/agent-harness/project";
import {
  placeOf,
  replacedSections,
  sectionsOf,
} from "../../features/agent-harness/sections/compose";
import {
  referencedFolders,
  referencedSkills,
} from "../../features/agent-harness/referenced-folders";
import { SessionControls } from "../../features/agent-harness/session-control";
import type {
  SessionPlace,
  SessionControlAction,
  SessionState,
  SessionUsage,
} from "../../features/agents/service";
import {
  CONTEXT_LIMIT,
  type Scope,
  steerPrompt,
  systemPrompt,
  turnPrompt,
} from "./prompt";
import {
  AgentSessions,
  type Attribute,
  localSessions,
  Spare,
} from "./sessions";
import { PROTECTED, refused } from "./attribution";
import {
  bindSession,
  inferenceBundle,
  isBuzzUuid,
  isHex64,
  type SessionEvent,
  type TurnContext,
} from "../../features/agents/gateway/contract";
import type { EligibleRoute } from "../../features/agents/gateway/route";
import {
  readLatestTurns,
  readSessionTitle,
  readTranscript,
  withNotices,
  type Conversation,
  type SessionsPlace,
} from "./transcript";
import { sessionPrompts } from "../../features/agents/session-prompts";
import { standaloneSessions } from "../../features/agents/standalone-sessions";
import { withWakes } from "../../features/agents/session-usage";

/** The effort levels Claude lists, which a session can switch to between
 * turns. Claude runs `max` as `xhigh` in a stream-json session, so it is not
 * offered. */
export const effortChoices = (levels: readonly string[]): Effort[] =>
  [...new Set(levels)]
    .filter((id) => id !== "max")
    .map((id) => ({ id, label: effortLabel(id) }));
export const effortLabel = (id: string) =>
  id === "xhigh" ? "Extra high" : `${id.charAt(0).toUpperCase()}${id.slice(1)}`;

/** The effort levels a listed model takes. */
export const effortLevels = (model: ClaudeModel) =>
  model.supportsEffort === false ? [] : (model.supportedEffortLevels ?? []);

export type Config = Readonly<{
  /** A Claude model or alias; empty uses Claude's own default. */
  model: string;
  /** An effort level the model lists; empty uses Claude's own default. */
  effort: string;
  instructions: string;
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  /** Whether each thread is its own session, or the whole channel is one. */
  scope: Scope;
  /** The context size, in tokens, its sessions compact at; unset is
   * Claude's own. This device's only. */
  compactAt?: string;
  /** On Recommended, whose model and thinking level runs replace these. */
  preset?: typeof PRESET;
}>;
export const DEFAULT_CONFIG: Config = Object.freeze({
  model: "",
  effort: "",
  instructions: "",
  workspace: "~/.buzz",
  scope: "thread",
});
export const config = (value: unknown): Config => ({
  ...DEFAULT_CONFIG,
  ...(value && typeof value === "object" ? (value as Partial<Config>) : {}),
  scope: sessionScope((value as Partial<Config> | undefined)?.scope),
});

/** A saved session, for the owner's transcript list, with the channel's name
 * and kind when this community lists it. */
export type SavedConversation = Conversation &
  Partial<ChannelLabel> & {
    key: string;
    sessionId: string;
    at: number;
  };

/** A little over the host's grace (`STOP_GRACE`) before it kills a stopped
 * process. */
const STOP_WAIT_MS = 5_000;
const CONVERSATION_READ_TIMEOUT_MS = 4_000;
const CHAT = [9, 40002];

type Entry = {
  project: ProjectSource;
  protected?: boolean;
  sessions: AgentSessions;
  config: Config;
  /** The team sections of the latest run; a change restarts idle sessions. */
  team: string;
  /** The agent's name, for its prompt; a rename restarts idle sessions. */
  name?: string;
  /** Its `core` memory as its latest turn read it; a change restarts idle
   * sessions, which resume with their history. */
  memory?: string | null | undefined;
  /** The latest admitted delivery's handle, used by its running tools. */
  handle?: AgentHandle;
  /** Where each conversation's tools default to: its latest turn's thread. */
  contexts: Map<string, Context>;
  /** Records confirmed final publication by the admitted community wake. */
  wakePublished?: () => void;
  /** The folders each conversation's process may use: its Solo chat's
   * latest Canvas folders and every folder its owner referenced. */
  directories: Map<string, readonly string[]>;
  /** The folders each conversation's owner messages referenced. */
  referenced: Map<string, readonly string[]>;
  /** Session id → a hash of the base prompt its process was last given. */
  /** Each conversation's latest posting policy: when its turns were handed
   * over, and when all of them settled. */
  policies: Map<
    string,
    {
      solo: boolean;
      steerable?(model?: string, effort?: string): boolean;
      /** The running turn's effective model and effort picks. */
      picks?: Readonly<{
        model?: string | undefined;
        effort?: string | undefined;
      }>;
      handed: Promise<unknown>;
      settled: Promise<unknown>;
      cancel(): void;
    }
  >;
};

/** Where an agent's processes run, and with which model, effort and
 * compaction. */
const where = ({ workspace, model, effort, ...config }: Config) => {
  const tokens = compactAt(config.compactAt);
  return {
    cwd: workspace,
    ...(model.trim() ? { model: model.trim() } : {}),
    ...(effort ? { effort } : {}),
    ...(tokens ? { compactAt: tokens } : {}),
  };
};

/** How Claude lists the session tools: in full up front only those marked
 * `alwaysLoad`, and the rest by name until its tool search loads them, with
 * the server's instructions saying what they are. */
const listing = (added: readonly AddedTool[]): Listing => ({
  instructions: sessionHint(added),
  tool: ({ load, ...tool }) =>
    load === "always"
      ? { ...tool, _meta: { "anthropic/alwaysLoad": true } }
      : tool,
});

/** How long a session start waits for the agent's recent notes. */
const NOTES_WAIT_MS = 2_000;
/** What a remote Claude agent's Activity shows instead of its transcript. */
const REMOTE_TRANSCRIPTS =
  "Transcripts are unavailable for remote Claude agents";
/** The attribution notices kept for each agent, the oldest dropped first. */
const NOTICE_LIMIT = 100;

/** A turn's gateway route and frozen context, as `Delivery.gateway` has it. */
type Gateway = Readonly<{ route: EligibleRoute; turn: TurnContext }>;
/** The label of a base prompt that a saved session prompt got later. */
const BASE_LABEL = "base ";
/** The base prompt in a system prompt. */
const baseOf = (systemPrompt: string) =>
  promptSections(systemPrompt).find(({ tag }) => tag === "base")?.body ?? "";

/** A turn's run returns once Claude has it, so this bounds only the hand-over. */
export const HANDOVER_MS = 2 * 60_000;

export class ClaudeRuntime {
  private disposed = false;
  private readonly confirmedRemote = new Set<AgentKey>();
  private readonly remote = new Map<
    string,
    {
      agent: AgentKey;
      conversation: string;
      runtime: ClaudeRuntime;
      execution: AgentExecution;
    }
  >();
  private readonly opening = new Map<
    string,
    {
      agent: AgentKey;
      conversation: string;
      abort: AbortController;
      ready: Promise<ClaudeRuntime>;
    }
  >();
  private readonly agents = new Map<AgentKey, Entry>();
  private readonly memoryReads = new MemoryReads();
  private readonly listeners = new Set<() => void>();
  /** Each agent's last session list, kept until something changes so a view
   * reading it gets the same array back. */
  private readonly views = new Map<
    AgentKey,
    ReturnType<AgentSessions["snapshot"]>
  >();
  /** Solo chats whose title was already offered to the host this app run. */
  private readonly titled = new Set<string>();
  /** Each agent's turn notices, by the id of the message each ran from. */
  private readonly notices = new Map<AgentKey, Map<string, string>>();
  /** Counts changes of credentials, which start processes again. */
  private credentials = 0;
  /** One process started ahead of need, for any agent's next new conversation. */
  private readonly spare = new Spare(
    // Started ahead of need, it never stops a conversation to make room.
    (id, options) => this.spawn(id, options),
    (_conversation, message) =>
      respond(undefined, {}, message, this.added(), listing(this.added())),
    undefined,
    // A spare started with old credentials is not handed over either.
    () => JSON.stringify([addedKey(this.added()), this.credentials]),
  );

  constructor(
    private readonly host: Pick<Host, "spawn" | "resolveDirectory">,
    /** What each agent's turns read of its community, while it can be read. */
    private readonly reads: (key: AgentKey) => AgentReads | undefined,
    /** The agent's `core` memory as the host keeps it (`Agents.core`). */
    private readonly core: Agents["core"],
    private readonly storage: AgentStore = localStore(),
    private readonly resolveConfig: (
      raw: unknown,
      remote?: boolean,
    ) => Config = config,
    /** The tools plugins add to every session now. */
    private readonly added: () => readonly AddedTool[] = () => [],
    /** Desktop-local repository instructions; standalone hosts keep their own layout. */
    private readonly repositories: (scope: string | undefined) => string = () =>
      "",
    private readonly hook: (
      agent: string,
      session: string,
      event: string,
      input: unknown,
    ) => Promise<Record<string, unknown>> = async () => ({}),
    private readonly execution?: Agents["execution"],
    private readonly inspect?: Agents["inspectExecution"],
    private readonly bound: (agent: AgentKey) => boolean = () => false,
    private readonly target?: AgentExecution,
    private readonly targetKey?: string,
    /** The agent's reads once its community is ready, for a workflow's
     * mention that arrived while it reconnects; rejects when `signal` aborts. */
    private readonly readyReads?: (
      agent: AgentHandle,
      signal: AbortSignal,
      channelId: string | undefined,
    ) => Promise<AgentReads | undefined>,
    /** The agent's eligible gateway route for a session control, which has
     * no delivery; absent while Claude declares no harness. */
    private readonly gatewayRoute?: (
      agent: AgentKey,
    ) => EligibleRoute | undefined,
  ) {}

  /** A failed turn's error as its report says it, such as where to fix
   * Claude's credentials. */
  explain: (error: string) => string = (error) => error;
  /** Whether the Usage plugin is on, asked as each one-off turn starts: only
   * then is the turn's key kept with its session, for Usage. */
  usageOn: () => boolean = () => false;

  private executionKey(agent: AgentKey, conversation: string) {
    const scope = this.reads(agent)?.scope;
    if (!scope) throw new Error("Buzz is not connected");
    return `buzz.claude-code.sessions.execution.v1:${JSON.stringify([scope, agent, conversation])}`;
  }
  /** The folder a plugin gave the conversation, if any. Only the local
   * runtime keeps them; an execution target's conversations refuse one. */
  private folder(agent: AgentKey, key: string | undefined) {
    if (!key || this.target) return undefined;
    const reads = this.reads(agent);
    if (!reads) throw new Error("Buzz is not connected");
    return reads.scope
      ? conversationFolder(this.storage, reads.scope, agent, key)
      : undefined;
  }
  /** `folder`, for a launching session, which records that a conversation
   * without one starts in the workspace. */
  private startFolder(agent: AgentKey, key: string | undefined) {
    if (!key || this.target) return undefined;
    const reads = this.reads(agent);
    if (!reads) throw new Error("Buzz is not connected");
    return reads.scope
      ? startingFolder(this.storage, reads.scope, agent, key)
      : undefined;
  }
  /** Where the conversation's sessions ran: its own folder, or else the
   * agent's workspace. */
  private place(
    agent: AgentKey,
    key: string,
    workspace: string,
  ): SessionsPlace {
    const folder = this.reads(agent) && this.folder(agent, key);
    return folder ? { folder } : workspace;
  }
  /** Where each of the agent's sessions ran, with the ids this app saved
   * there, for its usage: its workspace and every folder its conversations
   * were given. A one-off turn runs in the workspace, so its sessions, which
   * `started` recorded, are listed there. */
  sessionPlaces(agent: AgentKey, workspace: string) {
    const scope = this.reads(agent)?.scope;
    const folders = scope
      ? agentFolders(this.storage, scope, agent)
      : new Map();
    const places = new Map<
      string,
      { place: SessionsPlace; saved: string[]; standalone: string[] }
    >([
      [
        "",
        {
          place: workspace,
          saved: [],
          standalone: standaloneSessions(this.storage, "claude-code", agent)
            .list()
            .map(({ id }) => id),
        },
      ],
    ]);
    for (const folder of folders.values())
      places.set(folder, { place: { folder }, saved: [], standalone: [] });
    for (const saved of this.conversations(agent))
      places.get(folders.get(saved.key) ?? "")?.saved.push(saved.sessionId);
    return [...places.values()];
  }
  private savedSessions(agent: AgentKey) {
    return localSessions(
      this.storage,
      agent,
      this.targetKey
        ? `buzz.claude-code.sessions.remote.v1:${this.targetKey}`
        : undefined,
      !!this.target,
    );
  }
  private record(text: string) {
    const value = JSON.parse(text) as { key?: unknown; intent?: unknown };
    if (
      typeof value?.key !== "string" ||
      !value.key ||
      (value.intent !== "new" && value.intent !== "existing")
    )
      throw new Error("Invalid saved Claude execution session");
    return value as { key: string; intent: "new" | "existing" };
  }
  private async connection(
    agent: AgentKey,
    conversation: string,
    signal?: AbortSignal,
  ): Promise<ClaudeRuntime> {
    if (this.disposed) throw new Error("Claude runtime is disposed");
    if (!this.execution)
      throw new Error("The remote Claude execution is unavailable");
    this.confirmedRemote.add(agent);
    if (this.disposed || this.retirements.has(agent))
      throw new Error("Claude runtime is retired");
    const key = this.executionKey(agent, conversation);
    const held = this.remote.get(key);
    if (held && !held.execution.signal.aborted) return held.runtime;
    const pending = this.opening.get(key);
    if (pending) return pending.ready;
    const abort = new AbortController();
    const cancel = () => abort.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const ready = (async () => {
      const saved = this.record(
        (await this.storage.read(key)) ??
          (await this.storage.add(
            key,
            JSON.stringify({ key: crypto.randomUUID(), intent: "new" }),
          )),
      );
      abort.signal.throwIfAborted();
      const execution = await this.execution?.(agent, {
        ...saved,
        signal: abort.signal,
      });
      if (!execution)
        throw new Error("The remote Claude binding is unavailable");
      try {
        if (this.disposed) throw new Error("Claude runtime is disposed");
        abort.signal.throwIfAborted();
        execution.signal.throwIfAborted();
        await this.storage.set(
          key,
          JSON.stringify({ key: saved.key, intent: "existing" }),
        );
        const savedKey = `buzz.claude-code.sessions.remote.v1:${saved.key}:${agent}`;
        const savedText = await this.storage.read(savedKey);
        const storage = fileStore(
          new Map(savedText === null ? [] : [[savedKey, savedText]]),
          (key, value) => this.storage.set(key, value),
          (key, value) => this.storage.add(key, value),
          (key) => this.storage.read(key),
          (prefix) => this.storage.scan(prefix),
        );
        abort.signal.throwIfAborted();
        execution.signal.throwIfAborted();
        const runtime = new ClaudeRuntime(
          { spawn: executionSpawn(execution) },
          (key) => (key === agent ? this.reads(key) : undefined),
          this.core,
          storage,
          (raw) => ({
            ...this.resolveConfig(raw, true),
            workspace: execution.workspace,
          }),
          this.added,
          () => "",
          this.hook,
          undefined,
          undefined,
          undefined,
          execution,
          saved.key,
          this.readyReads,
        );
        runtime.subscribe(() => this.notify());
        this.remote.set(key, { agent, conversation, runtime, execution });
        execution.signal.addEventListener(
          "abort",
          () => {
            runtime.dispose();
            this.notify();
          },
          { once: true },
        );
        this.notify();
        return runtime;
      } catch (error) {
        await execution.dispose();
        throw error;
      }
    })();
    this.opening.set(key, { agent, conversation, abort, ready });
    this.notify();
    try {
      return await ready;
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (this.opening.get(key)?.ready === ready) this.opening.delete(key);
      this.notify();
    }
  }
  /** The host's own spawn, not a copy: history read with it is kept for it,
   * and shared with the agents' usage. */
  private get spawn(): Spawn {
    const { spawn } = this.host;
    if (!spawn) throw new Error("Claude agents run only in the desktop app");
    return spawn;
  }

  /** Makes a place when the host already runs all the processes it allows,
   * which every plugin's processes share: stops the spare, else the
   * conversation process of any agent that has been idle longest, and waits
   * for it to exit, or until the host has had time to kill it. False when
   * neither is there to stop. Idle processes
   * would stop on their own after `IDLE_MS`; until then they hold places a
   * new conversation needs. */
  async room() {
    // The spare, started ahead of need, goes before any conversation's. Both
    // are chosen now: a wait that runs out never stops another later.
    let stopping = this.spare.free();
    if (!stopping) {
      let idlest: ReturnType<AgentSessions["idlest"]>;
      for (const entry of this.agents.values()) {
        const candidate = entry.sessions.idlest();
        if (candidate && (!idlest || candidate.used < idlest.used))
          idlest = candidate;
      }
      if (!idlest) return false;
      stopping = idlest.stop();
    }
    // A descendant holding its output can keep it from ever reporting exit;
    // its place may still be held, so the caller then asks again.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      stopping,
      new Promise((done) => (timer = setTimeout(done, STOP_WAIT_MS))),
    ]);
    clearTimeout(timer);
    return true;
  }

  /** Brings the runtime in line with this type's agents: changed settings
   * restart idle sessions, removed agents stop, and a spare waits while any
   * agent is here. */
  private readonly retirements = new Map<string, Promise<void>>();
  async retire(pubkey: string) {
    this.controls.interrupt(`${pubkey}/${COMMUNITY_SESSION}`, true);
    let retiring = this.retirements.get(pubkey);
    if (!retiring) {
      retiring = (async () => {
        const entry = this.agents.get(pubkey);
        this.agents.delete(pubkey);
        this.notices.delete(pubkey);
        for (const pending of this.opening.values())
          if (pending.agent === pubkey)
            pending.abort.abort(new Error("Claude is retired"));
        await Promise.allSettled(
          [...this.opening.values()]
            .filter((item) => item.agent === pubkey)
            .map((item) => item.ready),
        );
        await entry?.sessions.shutdown();
        const cleaned = await Promise.allSettled(
          [...this.remote]
            .filter(([, remote]) => remote.agent === pubkey)
            .map(async ([key, remote]) => {
              await remote.runtime.retire(pubkey);
              await remote.execution.dispose();
              this.remote.delete(key);
            }),
        );
        const failed = cleaned.filter((result) => result.status === "rejected");
        if (failed.length)
          throw new AggregateError(
            failed.map((result) => result.reason),
            "Claude target cleanup failed",
          );
      })();
      this.retirements.set(pubkey, retiring);
    }
    try {
      await retiring;
    } finally {
      // A failed retirement is not kept: the agent can start again, and its
      // old processes are not stopped again.
      if (this.retirements.get(pubkey) === retiring)
        this.retirements.delete(pubkey);
    }
  }
  sync(agents: readonly Agent[]) {
    const current = new Set(agents.map((agent) => agent.key));
    // Deleted, signed out or its community disconnected: either way its
    // processes stop. Saved sessions stay so it resumes when it is back.
    for (const key of this.agents.keys())
      if (!current.has(key)) void this.retire(key).catch(() => undefined);
    for (const agent of agents) {
      if (this.retirements.has(agent.key)) continue;
      const next = this.resolveConfig(
        agent.config,
        this.bound(agent.key) || this.confirmedRemote.has(agent.key),
      );
      const entry = this.agents.get(agent.key);
      if (!entry) {
        const created = this.entry(agent, next);
        created.name = agent.name;
        continue;
      }
      entry.protected = !!agent.protection;
      if (
        JSON.stringify(entry.config) !== JSON.stringify(next) ||
        entry.name !== agent.name
      ) {
        entry.config = next;
        entry.name = agent.name;
        entry.sessions.reconfigure();
      }
    }
    for (const remote of this.remote.values())
      remote.runtime.sync(agents.filter((agent) => agent.key === remote.agent));
    this.spare.warm(
      ...agents
        .filter(
          (agent) =>
            !agent.protection &&
            !this.target &&
            !(this.bound(agent.key) || this.confirmedRemote.has(agent.key)),
        )
        .map((agent) => where(this.resolveConfig(agent.config))),
    );
    this.notify();
  }

  async isRemote(agent: AgentKey) {
    const remote = !!(this.target || (await this.inspect?.(agent)));
    if (remote) this.confirmedRemote.add(agent);
    return remote;
  }
  /** A file as the agent's processes read one here: in its saved workspace.
   * On an execution target only a conversation's session can read it. */
  async workspaceFile(agent: Agent, path: string, signal: AbortSignal) {
    if (await this.isRemote(agent.key))
      throw new Error(
        `This agent reads files only in a conversation on its execution target, not ${path}`,
      );
    return readFile(
      this.spawn,
      this.resolveConfig(agent.config).workspace,
      path,
      signal,
    );
  }

  /** The models the agent's next turn can run on, with their effort levels.
   * Without a pick it uses its own: the configured one, or else the one its
   * sessions report. `default` duplicates a listed model, so it is not offered. */
  async models(agent: AgentKey, raw?: unknown): Promise<Models> {
    if (await this.isRemote(agent)) {
      const current = this.resolveConfig(
        raw ?? this.agents.get(agent)?.config,
        true,
      ).model;
      return {
        current,
        models: current ? [{ id: current, label: current, efforts: [] }] : [],
      };
    }
    const { current, models } = await this.catalog(agent);
    return { current, models };
  }

  /** `models`, saying whether Claude itself lists the current model. */
  private async catalog(agent: AgentKey) {
    const entry = this.agents.get(agent);
    const configured = entry?.config.model.trim();
    const {
      models: listed,
      model: reported,
      effort,
    } = (await entry?.sessions.metadata()) ?? { models: [] };
    // A turn without a pick keeps the session's effort on any model.
    const resting = (efforts: readonly Effort[]) =>
      effort && efforts.some((level) => level.id === effort) ? { effort } : {};
    const own = configured || reported || "";
    const offered = listed.filter((model) => model.value !== "default");
    const models = offered.map((model) => {
      const offeredEfforts = effortChoices(effortLevels(model));
      return {
        id: model.value,
        label: modelName(model.resolvedModel ?? model.value),
        efforts: offeredEfforts,
        ...resting(offeredEfforts),
      };
    });
    const current =
      offered.find(
        (model) => own === model.value || own === model.resolvedModel,
      )?.value ?? own;
    if (models.some((model) => model.id === current))
      return { current, models, listed: true };
    // An own model Claude does not list is still the one it runs, at any
    // effort a listed model has.
    const ownEfforts = effortChoices(offered.flatMap(effortLevels));
    return {
      current,
      models: [
        {
          id: current,
          label: current ? modelName(current) : "Claude",
          efforts: ownEfforts,
          ...resting(ownEfforts),
        },
        ...models,
      ],
      listed: false,
    };
  }

  /** Conversations each agent has running, for its status view. */
  sessions(agent: AgentKey): ReturnType<AgentSessions["snapshot"]> {
    let view = this.views.get(agent);
    if (!view) {
      view =
        this.bound(agent) || this.confirmedRemote.has(agent)
          ? [...this.remote.values()]
              .filter((item) => item.agent === agent)
              .flatMap((item) => item.runtime.sessions(agent))
          : (this.agents.get(agent)?.sessions.snapshot() ?? []);
      this.views.set(agent, view);
    }
    return view;
  }
  /** The agent's saved sessions, most recently used first. */
  conversations(agent: AgentKey): SavedConversation[] {
    const reads = this.reads(agent);
    const saved =
      this.bound(agent) || this.confirmedRemote.has(agent)
        ? this.storage
            .keys()
            .filter((key) =>
              key.startsWith("buzz.claude-code.sessions.execution.v1:"),
            )
            .flatMap((key) => {
              const [scope, owner] = JSON.parse(
                key.slice("buzz.claude-code.sessions.execution.v1:".length),
              ) as string[];
              if (owner !== agent || scope !== reads?.scope) return [];
              const session = this.record(this.storage.get(key) ?? "null");
              return localSessions(
                this.storage,
                agent,
                `buzz.claude-code.sessions.remote.v1:${session.key}`,
              ).list();
            })
        : this.savedSessions(agent).list();
    return saved.map(([key, saved]) => {
      const { channelId, root, ...location } = sessionSource(
        this.storage,
        agent,
        key,
      );
      return {
        key,
        agent,
        sessionId: saved.id,
        ...location,
        channelId,
        ...(root ? { root } : {}),
        ...reads?.channelLabel(channelId),
        at: saved.at,
      };
    });
  }
  /** A conversation's transcript, found from the workspace it ran in. */
  async transcript(
    conversation: Conversation,
    workspace: string,
    working: boolean,
    signal: AbortSignal,
  ) {
    if (await this.inspect?.(conversation.agent))
      // Where the gateway would attribute it, also say that it isn't.
      throw new Error(
        this.gatewayRoute?.(conversation.agent)
          ? `${REMOTE_TRANSCRIPTS}. They aren't attributed in the agent gateway yet.`
          : `${REMOTE_TRANSCRIPTS}.`,
      );
    const prompts = this.prompts(conversation.agent);
    return readTranscript(
      this.spawn,
      this.place(
        conversation.agent,
        conversation.community
          ? COMMUNITY_SESSION
          : conversationKey(conversation.channelId, conversation.root),
        workspace,
      ),
      conversation,
      working,
      signal,
      (pubkey) => this.reads(conversation.agent)?.name(pubkey),
    ).then(
      (transcript) =>
        transcript && {
          ...transcript,
          turns: withNotices(
            prompts.shown(transcript.turns),
            this.notices.get(conversation.agent) ?? new Map(),
          ),
        },
    );
  }
  /** Keeps a turn's notice for its Activity, by the id of the message it
   * ran from, while the app runs. */
  private noted(agent: AgentKey, uuid: string, notice: string) {
    const notices = this.notices.get(agent) ?? new Map<string, string>();
    notices.set(uuid, notice);
    for (const oldest of notices.keys()) {
      if (notices.size <= NOTICE_LIMIT) break;
      notices.delete(oldest);
    }
    this.notices.set(agent, notices);
    this.notify();
  }

  /** The latest whole turns of a conversation's saved session, or undefined
   * when it has none to read that way. Its sessions' prompts are shown
   * once: not again on a session whose earlier turns `held` keeps. */
  async latestTurns(
    conversation: Conversation,
    workspace: string,
    working: boolean,
    signal: AbortSignal,
    held: readonly TranscriptTurn[],
  ) {
    if (await this.inspect?.(conversation.agent)) return undefined;
    const read = await readLatestTurns(
      this.spawn,
      this.place(
        conversation.agent,
        conversation.community
          ? COMMUNITY_SESSION
          : conversationKey(conversation.channelId, conversation.root),
        workspace,
      ),
      conversation,
      working,
      signal,
      (pubkey) => this.reads(conversation.agent)?.name(pubkey),
    );
    if (!read) return undefined;
    // Turns older than all `held` keeps are left.
    const ids = new Set(held.map((turn) => turn.turnId));
    const turns = read.slice(
      Math.max(
        read.findIndex((turn) => ids.has(turn.turnId)),
        0,
      ),
    );
    const at = held.findIndex((turn) => turn.turnId === turns[0]?.turnId);
    const kept = new Set(
      held.slice(0, Math.max(at, 0)).map((t) => t.sessionId),
    );
    // Decorated as a full read is, since these replace the turns it showed.
    return withNotices(
      this.prompts(conversation.agent)
        .shown(turns)
        .map((turn, index) =>
          kept.has(turn.sessionId) ? (turns[index] ?? turn) : turn,
        ),
      this.notices.get(conversation.agent) ?? new Map(),
    );
  }
  /** `sessions` with, for each a standalone turn started, the key it ran
   * under. */
  withWakes(agent: AgentKey, sessions: readonly SessionUsage[]) {
    return withWakes(
      sessions,
      standaloneSessions(this.storage, "claude-code", agent).list(),
    );
  }
  /** What each of the agent's sessions started with. */
  private prompts(agent: AgentKey) {
    return sessionPrompts(this.storage, "claude-code", agent);
  }
  /** The agent's latest session for a conversation that another build of the
   * app started, found in the workspace's Claude Code history. */
  async find(
    agent: AgentKey,
    place: Readonly<{ channelId: string; root?: string }>,
    workspace: string,
    signal: AbortSignal,
    community = false,
  ): Promise<SavedConversation | undefined> {
    if (await this.inspect?.(agent)) return undefined;
    const transcript = await readTranscript(
      this.spawn,
      this.place(
        agent,
        community
          ? COMMUNITY_SESSION
          : conversationKey(place.channelId, place.root),
        workspace,
      ),
      { agent, ...place, ...(community ? { community: true } : {}) },
      false,
      signal,
    );
    const last = transcript?.turns.at(-1);
    if (!last?.sessionId) return undefined;
    return {
      key: community
        ? COMMUNITY_SESSION
        : place.root
          ? `${place.channelId}/${place.root}`
          : place.channelId,
      agent,
      sessionId: last.sessionId,
      ...place,
      ...(community ? { community: true as const } : {}),
      at: last.endedAt ?? last.startedAt,
    };
  }
  /** The community's current name and kind for a channel, if it lists it;
   * `useOpenedSession` gives them to a session `find` returned. */
  channelLabel(agent: AgentKey, channelId: string) {
    return this.reads(agent)?.channelLabel(channelId);
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    this.views.clear();
    // One subscriber's error must not stop the others, or a stop in progress.
    for (const listener of this.listeners)
      try {
        listener();
      } catch (error) {
        console.error("A Claude session subscriber failed", error);
      }
  }
  private readonly controls = new SessionControls(() => this.notify());
  private controlKey(agent: Agent, place: SessionPlace) {
    return scopedSessionKey(
      place.isolated ? "thread" : config(agent.config).scope,
      place.channelId,
      place.root,
    );
  }
  sessionState(agent: Agent, place: SessionPlace): SessionState {
    const key = this.controlKey(agent, place);
    if (this.controls.compacting(`${agent.key}/${key}`)) return "compacting";
    if (this.controls.active(`${agent.key}/${key}`)) return "active";
    if (this.bound(agent.key) || this.confirmedRemote.has(agent.key)) {
      if (
        [...this.opening.values()].some(
          (entry) => entry.agent === agent.key && entry.conversation === key,
        )
      )
        return "active";
      return (
        [...this.remote.values()]
          .find(
            (entry) => entry.agent === agent.key && entry.conversation === key,
          )
          ?.runtime.sessionState(agent, place) ?? "idle"
      );
    }
    if (this.controls.compacting(`${agent.key}/${key}`)) return "compacting";
    const entry = this.agents.get(agent.key);
    return this.controls.active(`${agent.key}/${key}`) ||
      entry?.policies.has(key) ||
      entry?.sessions.active(key)
      ? "active"
      : "idle";
  }
  async session(
    agent: Agent,
    place: SessionPlace,
    action: SessionControlAction,
    reset?: (change: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const key = this.controlKey(agent, place);
    if (await this.inspect?.(agent.key)) {
      if (action === "interrupt") {
        const control = `${agent.key}/${key}`;
        const compacting = this.controls.compacting(control);
        if (this.controls.interrupt(control) && !compacting) return;
        for (const pending of this.opening.values())
          if (pending.agent === agent.key && pending.conversation === key)
            pending.abort.abort(new Error("Claude was stopped"));
        const remote = [...this.remote.values()].find(
          (entry) => entry.agent === agent.key && entry.conversation === key,
        );
        await remote?.runtime.session(agent, place, action);
        return;
      }
      const remoteKey = this.executionKey(agent.key, key);
      if (this.sessionState(agent, place) !== "idle")
        throw new Error("Wait for the active turn to finish first.");
      return this.controls.run(
        `${agent.key}/${key}`,
        action,
        async (signal) => {
          if (action === "new") {
            const change = async () => {
              const held = this.remote.get(remoteKey);
              if (held) {
                await held.runtime.retire(agent.key);
                await held.execution.dispose();
              }
              signal.throwIfAborted();
              await this.storage.set(
                remoteKey,
                JSON.stringify({ key: crypto.randomUUID(), intent: "new" }),
              );
              this.remote.delete(remoteKey);
              this.notify();
            };
            await (reset ? reset(change) : change());
            return;
          }
          const stored = await this.storage.read(remoteKey);
          if (!stored) return;
          const saved = this.record(stored);
          const text = await this.storage.read(
            `buzz.claude-code.sessions.remote.v1:${saved.key}:${agent.key}`,
          );
          const session = JSON.parse(text ?? "{}")[key];
          if (!session?.id || session.pending) return;
          signal.throwIfAborted();
          const runtime = await this.connection(agent.key, key, signal);
          await runtime.session(agent, place, action);
        },
      );
    }
    const control = `${agent.key}/${key}`;
    const entry = this.entry(
      agent,
      this.target ? this.resolveConfig(agent.config) : config(agent.config),
    );
    if (action === "interrupt") {
      if (!this.controls.compacting(control)) entry.policies.get(key)?.cancel();
      this.controls.interrupt(control);
      await entry.sessions.interrupt(key);
      return;
    }
    if (this.sessionState(agent, place) !== "idle")
      throw new Error("Wait for the active turn to finish first.");
    return this.controls.run(control, action, async (signal) => {
      signal.throwIfAborted();
      if (action === "new") {
        const change = () => entry.sessions.forget(key);
        await (reset ? reset(change) : change());
      } else {
        // Under the control's own context where the gateway enables Claude;
        // otherwise it runs on Claude's own headers, never refused.
        const route = this.gatewayRoute?.(agent.key);
        const result = await entry.sessions.compact(
          key,
          this.attribution(
            agent.key,
            route && {
              route,
              turn: controlTurn(place, config(agent.config).scope),
            },
            "resume",
            warned,
          ),
          signal,
        );
        signal.throwIfAborted();
        if (!result.ok) throw new Error(result.error);
      }
      signal.throwIfAborted();
    });
  }

  /** The credentials changed: idle sessions stop, to start again with the new
   * ones, and busy ones when they next fall idle. */
  restart() {
    this.credentials++;
    for (const entry of this.agents.values()) entry.sessions.reconfigure();
  }

  dispose() {
    this.controls.dispose();
    this.disposed = true;
    for (const pending of this.opening.values())
      pending.abort.abort(new Error("Claude was stopped"));
    for (const held of this.remote.values()) {
      held.runtime.dispose();
      void held.execution
        .dispose()
        .catch((error) =>
          console.error(`Claude agent ${held.agent} cleanup failed`, error),
        );
    }
    this.spare.dispose();
    for (const entry of this.agents.values()) entry.sessions.dispose();
    this.agents.clear();
  }

  run(delivery: Delivery): Promise<void> {
    return this.admitDelivery(delivery);
  }
  private async admitDelivery(
    delivery: Delivery,
    reserved = false,
    admittedDeferred = false,
  ): Promise<void> {
    const {
      trigger,
      agent,
      config: raw,
      channelId,
      model,
      effort,
      synced,
      team,
      workingUntil,
      current,
      wakeText,
      ignored,
      signal,
      step,
      acknowledged,
      accepted,
      superseded,
      interruptible,
      named,
      gateway,
      gatewayFallback,
    } = delivery;
    const settings = this.resolveConfig(
      raw,
      this.bound(agent.key) || this.confirmedRemote.has(agent.key),
    );
    // Unaddressed watches and timers come as standalone turns (`runOnce`).
    if (
      trigger.type !== "mention" &&
      trigger.type !== "attention" &&
      trigger.type !== "plugin"
    )
      return ignored?.();
    // A wake is not a message to check: a plugin's is the owner's installed
    // code, and the agent's own handoff comes from a turn already acting
    // for the owner.
    const wake = trigger.type !== "mention" ? trigger : undefined;
    // Claude runs commands as you; mentions need owner or delegated authority.
    if (trigger.type === "mention") {
      // A workflow's mention waits out a reconnect; the check below decides.
      const ready = workflowMarked(trigger.event, agent.owner)
        ? this.readyReads
        : undefined;
      const reads = ready
        ? await ready(
            agent,
            signal,
            channelId ?? trigger.event.tags.find((tag) => tag[0] === "h")?.[1],
          )
        : this.reads(agent.key);
      if (ready) {
        signal.throwIfAborted();
        if (current && !current()) return ignored?.();
      }
      const authority = await mentionAuthority(
        trigger.event,
        agent.owner,
        workflowOf(reads, agent.pubkey),
      );
      if (authority !== "owner") return ignored?.(authority);
    }
    signal.throwIfAborted();
    if (settings.scope === "community" && !reserved)
      return this.controls.admit(
        `${agent.key}/${COMMUNITY_SESSION}`,
        delivery,
        (accepted, deferred) => this.admitDelivery(accepted, true, deferred),
      );
    const entry = this.entry(agent, settings);
    if (
      (settings.scope !== "community" &&
        !entry.policies.has(COMMUNITY_SESSION)) ||
      !entry.handle
    ) {
      entry.handle = agent;
      entry.team = team ?? "";
    }
    // A pick is the owner's for this turn; otherwise a synced effort holds.
    const kept = !model && !effort ? synced?.effort : undefined;
    const admit = async () => {
      const refused = kept && (await this.refusal(agent.key, kept));
      if (refused) throw new Error(refused);
    };
    const event =
      trigger.type !== "mention" ? wakeAnchor(trigger) : trigger.event;
    const channel =
      channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1] ?? undefined;
    if (!channel) return;
    const solo =
      (await this.reads(agent.key)?.soloChat(agent.owner, channel, signal)) ??
      false;
    const topLevel = solo || wake?.topLevel === true;
    if (wake && !wakeLands(wake, topLevel)) return ignored?.();
    // Frozen with the policy: a scope change while this waits must not move
    // its prompt to another conversation than the one it is delivered to.
    const native = await this.key(
      settings.scope,
      agent,
      event,
      channel,
      topLevel,
    );
    const route =
      !topLevel && native.source.root
        ? await delivery.routeConversation?.(
            {
              source: native.source,
              conversation: {
                channelId: channel,
                ...(native.key === COMMUNITY_SESSION
                  ? { community: true }
                  : native.key !== channel
                    ? { root: native.source.root }
                    : {}),
              },
            },
            signal,
          )
        : undefined;
    const key = route
      ? scopedSessionKey("thread", channel, route.parent)
      : native.key;
    const source = route
      ? { channelId: channel, root: route.parent }
      : native.source;
    const replyRoot =
      route?.parent ?? threadReference(event)?.rootId ?? event.id;
    await rememberCommunitySource(this.storage, agent.key, key, channel);
    const admission = (deferred: boolean) =>
      delivery.prepareSession?.(
        {
          source: wake
            ? {
                channelId: channel,
                ...(source.root && wake.root
                  ? { root: route?.parent ?? wake.root }
                  : {}),
              }
            : source,
          conversation: {
            channelId: channel,
            ...(key === COMMUNITY_SESSION
              ? { community: true }
              : key !== channel
                ? { root: replyRoot }
                : {}),
          },
        },
        deferred,
      );

    let session = delivery.session;
    let sessionContext = delivery.sessionContext;
    signal.throwIfAborted();
    if (this.execution && (await this.inspect?.(agent.key))) {
      if (this.folder(agent.key, key))
        throw new Error(
          "Conversation folders are unavailable for agents on an execution target",
        );
      const handoff = this.controls.deliver(
        `${agent.key}/${key}`,
        async (deferred) => {
          deferred ||= admittedDeferred;
          const handover = deferred && AbortSignal.timeout(HANDOVER_MS);
          if (this.agents.get(agent.key) !== entry) return;
          const admitted = await admission(deferred);
          session = admitted?.session ?? session;
          sessionContext = admitted?.context ?? sessionContext;

          const runtime = await this.connection(
            agent.key,
            key,
            deferred ? undefined : signal,
          );
          if (reserved || !deferred) delivery.signal.throwIfAborted();
          const lifetime = deferred ? runtime.target?.signal : signal;
          if (!lifetime)
            throw new Error("The remote Claude lifetime is unavailable");
          // Held work's deadline passed while it waited, so its hand-over
          // gets its own from now; the turn itself outlives it.
          const accepted = handover
            ? AbortSignal.any([lifetime, handover])
            : lifetime;
          await runtime.run({
            ...delivery,
            routeConversation: async () => route,
            ...(session ? { session } : {}),
            ...(sessionContext ? { sessionContext } : {}),
            signal: accepted,
          });
        },
      );
      if (handoff.deferred && !reserved) {
        workingUntil(handoff.done);
        return;
      }
      return handoff.done;
    }
    const prior = entry.policies.get(key);
    // A turn keeps the posting policy it was admitted with: a request in a
    // Solo chat shared since, or the reverse, waits for its turns to settle
    // rather than steering into them and changing their tools' context.
    const same =
      key === COMMUNITY_SESSION
        ? entry.config.scope === "community" &&
          prior?.steerable?.(model, effort) === true
        : prior?.solo === solo;
    const wait =
      key === COMMUNITY_SESSION || entry.policies.has(COMMUNITY_SESSION)
        ? Promise.all(
            [...entry.policies.entries()].map(([other, policy]) =>
              same && other === key ? policy.handed : policy.settled,
            ),
          )
        : prior && (same ? prior.handed : prior.settled);
    let delivered!: Promise<Settled>;
    let interrupted = false;
    let submitted = false;
    // Keep an idle process available until delivery takes over.
    const arriving = entry.sessions.incoming(key);
    const handoff = this.controls.deliver(
      `${agent.key}/${key}`,
      async (deferred) => {
        deferred ||= admittedDeferred;
        // Accepted deferred work belongs to the captured agent lifetime, not
        // the short deadline for handing a message to the harness.
        if (this.agents.get(agent.key) !== entry) {
          delivered = Promise.resolve({ ok: true });
          return;
        }
        if (reserved || !deferred) signal.throwIfAborted();
        const admitted = await admission(deferred);
        session = admitted?.session ?? session;
        sessionContext = admitted?.context ?? sessionContext;
        const turnContext = [sessionContext, route?.turnContext]
          .filter(Boolean)
          .join("\n\n");
        // `fresh` is for a session that has been shown nothing yet.
        let acceptProject: (() => void) | undefined;
        const prompt = async (fresh: boolean) => {
          const wakePrompt = wake
            ? ((await wakeText?.()) ?? wake.text)
            : undefined;
          const turn = await this.turn(
            entry,
            agent,
            event,
            channel,
            key,
            topLevel,
            fresh,
            solo,
            () => !interrupted && (!current || current()),
            route,
          );
          acceptProject = turn.acceptProject;
          const text = turnPrompt({
            ...turn,
            agent: agent.key,
            channelLevel: topLevel && !solo,
            ...(wake
              ? { wake: { ...wake, text: wakePrompt ?? wake.text } }
              : {}),
          });
          return {
            contextRoot: turn.contextRoot,
            text:
              trigger.type === "mention" && trigger.resumed
                ? `${text}\n\n${RESUMED_PROMPT}`
                : text,
          };
        };
        await wait;
        if (interrupted) {
          delivered = Promise.resolve({ ok: true });
          return;
        }
        const { text: prepared, contextRoot } = await prompt(false);
        if (interrupted) {
          delivered = Promise.resolve({ ok: true });
          return;
        }
        entry.handle = agent;
        entry.team = team ?? "";
        // Plugins' notes wait until the turn is handed over, so one that
        // fails or is cancelled before then leaves them for the next.
        const noteRoot =
          topLevel ||
          key === channel ||
          (key === COMMUNITY_SESSION && !source.root)
            ? undefined
            : replyRoot;
        const notes = agent.notes?.(channel, noteRoot) ?? [];
        const text = [
          turnContext,
          this.review(entry, prepared, notes, channel, noteRoot, key),
        ]
          .filter(Boolean)
          .join("\n\n");
        // A conversation's tools default to its thread; a session shared by
        // several threads is told which to reply in instead. Set only once
        // Claude takes the message, so a dropped one leaves the running turn's.
        const context = {
          ...(session ? { session } : {}),
          ...(topLevel
            ? { channel, ...(solo ? { topLevel } : {}) }
            : key === channel || (key === COMMUNITY_SESSION && !source.root)
              ? { channel }
              : {
                  channel,
                  root: replyRoot,
                  ...(route ? { sourceRoot: route.root } : {}),
                }),
        };
        submitted = true;
        delivered = entry.sessions.deliver(key, text, event.created_at, {
          current: () => !interrupted && (!current || current()),
          ...(wake
            ? {
                refresh: async (fresh = false) => {
                  const text = this.review(
                    entry,
                    (await prompt(fresh)).text,
                    notes,
                    channel,
                    noteRoot,
                    key,
                  );
                  return [turnContext, text].filter(Boolean).join("\n\n");
                },
              }
            : {}),
          steer: steerPrompt(text),
          fresh: async () =>
            [
              turnContext,
              this.review(
                entry,
                (await prompt(true)).text,
                notes,
                channel,
                noteRoot,
                key,
              ),
            ]
              .filter(Boolean)
              .join("\n\n"),
          ...(contextRoot ? { contextRoot } : {}),
          activityScope: topLevel ? channel : replyRoot,
          ...(step ? { step } : {}),
          delivered: () => acceptProject?.(),
          ...(acknowledged ? { acknowledged } : {}),
          accepted: () => {
            entry.contexts.set(key, context);
            accepted?.();
          },
          ...(superseded ? { superseded } : {}),
          pick: {
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
          },
          admit,
          // Mentions already show the host's fallback under the request.
          ...this.turnAttribution(
            agent.key,
            gateway,
            wake ? gatewayFallback?.notice : undefined,
          ),
        });
        void delivered.then(
          (result) => {
            if (result.undelivered)
              agent.restoreNotes?.(channel, notes, noteRoot);
          },
          () => undefined,
        );
      },
    );
    const handed = handoff.done;
    void handed.then(arriving, arriving);
    const done = handed.then(
      async () => {
        const result = await delivered;
        return reserved && interrupted && (!submitted || result.undelivered)
          ? { ...result, ok: false, stopped: true as const }
          : result;
      },
      (error: unknown): Settled => ({ ok: false, error: String(error) }),
    );
    let foregroundDone = false;
    void done.then(() => {
      foregroundDone = true;
    });
    // A steer without a pick runs on the turn's own picks.
    const picks = same
      ? {
          model: model ?? prior?.picks?.model,
          effort: effort ?? prior?.picks?.effort,
        }
      : { model, effort };
    const policy = {
      solo,
      steerable: (nextModel?: string, nextEffort?: string) =>
        !interrupted &&
        !foregroundDone &&
        (!nextModel || nextModel === picks.model) &&
        (!nextEffort || nextEffort === picks.effort),
      picks,
      cancel() {
        interrupted = true;
        prior?.cancel();
      },
      handed: handed.catch(() => undefined),
      settled: Promise.allSettled([
        wait,
        same ? prior?.settled : undefined,
        done,
      ]).then(() =>
        key === COMMUNITY_SESSION ? entry.sessions.idle(key) : undefined,
      ),
    };
    entry.policies.set(key, policy);
    void policy.settled.then(() => {
      if (entry.policies.get(key) !== policy) return;
      entry.policies.delete(key);
      this.notify();
    });
    interruptible?.(() => {
      interrupted = true;
      return submitted ? entry.sessions.interrupt(key) : Promise.resolve();
    });
    // Deliveries keep their order: a later one waits on this handover, and
    // one with nothing to wait for is handed over before `run` returns.
    if (!wait && !handoff.deferred && !admittedDeferred) await handed;
    // The turn outlives `run`, which the host is told so it shows it as working.
    workingUntil(done);
    this.notify();
    this.watch(done, async (error) => {
      if (error)
        await this.report(agent, channel, event, error, topLevel, route);
    });
    if (solo && named && settings.scope !== "community")
      void this.offerTitle(done, agent.key, key, settings.workspace, named);
  }

  /** After a Solo chat's turn, offers the host the title Claude Code generated
   * for its session, once. The host decides whether the chat takes it. */
  private async offerTitle(
    done: Promise<Settled>,
    agent: AgentKey,
    key: string,
    workspace: string,
    named: (title: string) => void,
  ) {
    if (this.target) return;
    const once = `${agent}:${key}`;
    if (this.titled.has(once)) return;
    this.titled.add(once);
    if (!(await done).ok) {
      // A failed turn has offered no title; a successful retry may still name it.
      this.titled.delete(once);
      return;
    }
    const signal = AbortSignal.timeout(30_000);
    // Claude Code writes the title alongside the first reply; give it a moment.
    for (const wait of [0, 3_000, 10_000]) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const session = this.savedSessions(agent).get(key)?.id;
      if (!session || signal.aborted) return;
      try {
        const title = await readSessionTitle(
          this.spawn,
          this.place(agent, key, workspace),
          session,
          signal,
        );
        if (title) return named(title);
      } catch (error) {
        console.warn("Claude could not read its session title", error);
        return;
      }
    }
  }

  /** Runs a watch or timer outside its source conversation. Only community
   * scope reuses a saved session. */
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
    { delivery, key, signal, prompt }: StandaloneTurn,
    reserved = false,
    published = () => {},
  ): Promise<TurnResult> {
    const settings = this.resolveConfig(delivery.config);
    if (settings.scope === "community" && !reserved)
      return this.controls.wake(
        `${delivery.agent.key}/${COMMUNITY_SESSION}`,
        signal,
        (signal) =>
          this.standalone({ delivery, key, signal, prompt }, true, published),
      );
    const { agent, team } = delivery;
    if (await this.inspect?.(agent.key)) {
      const shared = settings.scope === "community";
      const conversation = shared
        ? COMMUNITY_SESSION
        : `once:${crypto.randomUUID()}`;
      const record = this.executionKey(agent.key, conversation);
      try {
        signal.throwIfAborted();
        const remote = await this.connection(agent.key, conversation, signal);
        return await remote.runOnce(
          { delivery, key, signal, prompt },
          published,
        );
      } finally {
        if (!shared) {
          const held = this.remote.get(record);
          if (held) {
            await held.runtime.retire(agent.key);
            await held.execution.dispose();
            this.remote.delete(record);
          }
          await this.storage.set(record, null);
        }
      }
    }
    const entry = this.entry(agent, settings);
    if (settings.scope !== "community" && !reserved)
      return standaloneTurn(
        entry.policies,
        signal,
        (signal) =>
          this.standalone({ delivery, key, signal, prompt }, true, published),
        () => this.notify(),
      );
    if (settings.scope !== "community" || !entry.handle) {
      entry.handle = agent;
      entry.team = team ?? "";
    }
    const refused = await this.refusal(agent.key, delivery.synced?.effort);
    if (refused) return { ok: false, error: refused };
    if (settings.scope !== "community")
      entry.memory = await this.core(agent.key);
    const done =
      settings.scope === "community"
        ? communityTurn(
            entry.policies,
            signal,
            this.controls,
            `${agent.key}/${COMMUNITY_SESSION}`,
            async (signal) => {
              entry.memory = await this.core(agent.key);
              const text = await prompt();
              if (text === undefined || !delivery.current())
                return { ok: true };
              signal.throwIfAborted();
              entry.handle = agent;
              entry.team = team ?? "";
              entry.directories.delete(COMMUNITY_SESSION);
              entry.contexts.set(COMMUNITY_SESSION, {});
              let stopping: Promise<void> | undefined;
              const stop = () => {
                stopping = entry.sessions
                  .interrupt(COMMUNITY_SESSION, true)
                  .catch((error) =>
                    console.error("Claude could not stop expired work", error),
                  );
              };
              signal.addEventListener("abort", stop, { once: true });
              entry.wakePublished = published;
              try {
                const result = await entry.sessions.deliver(
                  COMMUNITY_SESSION,
                  [
                    `<context>\nScope: standalone\nSession scope: community\nAgent: ${agent.key}\n</context>\n\n${NO_PROJECT.section}\n\n${text}`,
                    ownerInstructions(undefined, true),
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                  0,
                  {
                    current: () => !signal.aborted && delivery.current(),
                    delivered: () =>
                      entry.project.resolve(undefined, NO_PROJECT),
                    ...this.turnAttribution(
                      agent.key,
                      delivery.gateway,
                      delivery.gatewayFallback?.notice,
                    ),
                  },
                );
                await entry.sessions.idle(COMMUNITY_SESSION);
                return result;
              } finally {
                signal.removeEventListener("abort", stop);
                if (entry.wakePublished === published)
                  delete entry.wakePublished;
                await stopping;
              }
            },
            () => this.notify(),
          )
        : entry.sessions.runOnce(
            key,
            prompt,
            signal,
            this.attribution(agent.key, delivery.gateway, "standalone", warned),
          );
    this.notify();
    return done.finally(() => this.notify());
  }

  /** Attaches this prompt's attribution notice to its Activity entry. */
  private turnAttribution(
    agent: AgentKey,
    gateway: Gateway | undefined,
    fallback?: string,
  ) {
    let notice = fallback;
    const apply = this.attribution(agent, gateway, "resume", (text) => {
      notice = text;
    });
    const attribute: Attribute = (process, saved) => {
      // A retry on another process starts from the fallback again.
      notice = fallback;
      return apply(process, saved);
    };
    return {
      attribute,
      submitted: (uuid: string) => {
        if (notice) this.noted(agent, uuid, notice);
      },
    };
  }

  /** How a new turn sets its gateway attribution: the shared contract's
   * bundle for `gateway` over the process's own custom headers, or, without
   * one, the process's own headers back. Its binding is the saved one for
   * `resume` and a fresh unsaved one for `standalone`. Anything that keeps
   * it unattributed is `noted`; the turn always runs. */
  private attribution(
    agent: AgentKey,
    gateway: Gateway | undefined,
    event: Extract<SessionEvent, "resume" | "standalone">,
    noted: (notice: string) => void,
  ): Attribute {
    return async (process, saved) => {
      // Remote Claude is outside this rollout: its settings are never read
      // or changed. Its Activity says so (`transcript`).
      if (this.target) return undefined;
      // Its pinned launch reads none of the person's settings, so no gateway.
      if (gateway && this.agents.get(agent)?.protected) {
        noted(PROTECTED);
        return undefined;
      }
      const restore = async (notice?: string) => {
        const failed = await process.attribute(undefined);
        const shown = notice ?? failed;
        if (shown) noted(shown);
      };
      if (!gateway) {
        await restore();
        return undefined;
      }
      const { route, turn } = gateway;
      let bound: ReturnType<typeof bindSession>;
      try {
        bound = bindSession(route, saved, event);
      } catch (error) {
        await restore(
          refused(error instanceof Error ? error.message : String(error)),
        );
        return undefined;
      }
      // A saved binding for someone else is never replaced here: only New
      // session starts another.
      if (!bound.ok) {
        await restore(refused(bound.message));
        return undefined;
      }
      const bundle = inferenceBundle(route.profile, bound.binding, turn);
      if (!bundle.ok) {
        await restore(refused(bundle.message));
        return bound.binding;
      }
      const notice = await process.attribute({
        origin: route.gatewayOrigin,
        profile: route.profile,
        headers: bundle.value,
      });
      if (notice) noted(notice);
      return bound.binding;
    };
  }

  /** Why a new process can't run a synced effort, which is the agent's on
   * every device and never swapped for a default (NIP-AP). */
  private async refusal(agent: AgentKey, kept: string | undefined) {
    if (!kept) return undefined;
    const { current, models, listed } = await this.catalog(agent);
    const own = models.find((model) => model.id === current);
    // A model Claude doesn't list has no levels to check the effort against.
    if (!listed || !own)
      return unverifiedSynced("effort", kept, own?.label ?? "Claude");
    if (!own.efforts.some(({ id }) => id === kept))
      return unsupportedSynced("effort", kept, own.label);
    return undefined;
  }

  /** `text` with the notes plugins left for the turn and the Buzz tools'
   * end-of-turn note for its conversation, when there are any. */
  private review(
    entry: Entry,
    text: string,
    notes: readonly string[],
    channelId: string,
    root: string | undefined,
    key: string,
  ) {
    return [
      text,
      ...notes,
      turnNote(entry.handle, channelId, root, key === COMMUNITY_SESSION),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private watch(
    done: Promise<{ ok: boolean; error?: string }>,
    after: (error?: string) => unknown,
  ) {
    void done
      .then((result) => after(result.ok ? undefined : result.error))
      .catch((error) => console.warn("Claude turn failed", error))
      .finally(() => this.notify());
  }

  /** Says in the thread that a turn failed, so nobody waits on it. Tells the
   * owner even when a sibling asked: tagging the sibling would wake it, and two
   * agents failing alike would wake each other without end. */
  private report(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    error: string,
    topLevel: boolean,
    route?: InvocationSubthread,
  ) {
    return agent
      .publish({
        kind: 9,
        content: `⚠️ I couldn't finish that: ${this.explain(error.slice(0, 500))}`,
        tags: [
          ["h", channel],
          ...(topLevel
            ? []
            : [
                ...(route ? [["e", route.root, "", "root"]] : []),
                [
                  "e",
                  route?.parent ?? threadReference(event)?.rootId ?? event.id,
                  "",
                  "reply",
                ],
              ]),
          ["p", agent.owner],
        ],
      })
      .catch((failure) =>
        console.warn("Claude could not report a failed turn", failure),
      );
  }

  /** The conversation the event's turn goes to: a Solo chat or DM is one
   * conversation, as is a channel for an agent with channel scope. */
  private async key(
    scope: Scope,
    agent: Pick<Agent, "key">,
    event: EventData,
    channelId: string,
    topLevel: boolean,
  ) {
    const summary = await this.reads(agent.key)?.channel(channelId);
    const root = threadReference(event)?.rootId ?? event.id;
    return {
      key: scopedSessionKey(
        scope,
        channelId,
        topLevel || summary?.dm ? undefined : root,
      ),
      source: {
        channelId,
        ...(summary?.dm !== true ? { root } : {}),
      },
    };
  }

  /** Where the event's turn goes, and what its prompt needs. */
  private async turn(
    entry: Entry,
    agent: Pick<Agent, "key" | "pubkey">,
    event: EventData,
    channelId: string,
    key: string,
    topLevel: boolean,
    fresh = false,
    solo = topLevel,
    current = () => true,
    route?: InvocationSubthread,
  ) {
    const reads = this.reads(agent.key);
    const [summary, memory] = await Promise.all([
      reads?.channel(channelId),
      this.core(agent.key),
    ]);
    // Read as each turn starts, so a change made in any conversation restarts
    // this one's idle session on its next message.
    entry.memory = memory;
    const dm = summary?.dm === true;
    const thread = threadReference(event);
    const rootId = route?.root ?? thread?.rootId ?? event.id;
    // The conversation it was admitted to, not the scope as it is now.
    const scope: Scope = scopeOfSession(key, channelId);
    // Sharing a session does not mean it has seen every thread in the channel.
    const contextRoot =
      scope === "community"
        ? `${channelId}/${!dm && !topLevel ? rootId : "channel"}`
        : scope === "channel" && !dm && !topLevel
          ? rootId
          : undefined;
    const seen = fresh ? 0 : entry.sessions.seen(key, contextRoot);
    // Read alongside the conversation: only a Solo chat's Canvas is handed over.
    const canvas = reads?.canvas?.bind(reads);
    const owner = entry.handle?.owner;
    const reading = solo
      ? readProject(
          canvas && owner ? () => canvas(channelId, owner) : undefined,
          worksElsewhere(
            reads ? this.folder(agent.key, key) : undefined,
            sectionsOf(entry.handle, key),
          ),
        )
      : Promise.resolve(undefined);
    let earlier: readonly EventData[] = [];
    // A chat its owner is still creating has nothing earlier to read.
    if (reads && !summary?.starting && (thread || dm || topLevel))
      try {
        const budget = AbortSignal.timeout(CONVERSATION_READ_TIMEOUT_MS);
        const events = await reads.read(
          thread && !topLevel
            ? [
                {
                  ids: [...new Set([rootId, ...(route ? [route.parent] : [])])],
                  "#h": [channelId],
                  limit: route ? 2 : 1,
                },
                { kinds: CHAT, "#h": [channelId], "#e": [rootId], limit: 200 },
              ]
            : [{ kinds: CHAT, "#h": [channelId], limit: CONTEXT_LIMIT + 1 }],
          budget,
        );
        earlier = events
          .filter(
            (item) =>
              CHAT.includes(item.kind) &&
              item.tags.some(
                ([key, value]) => key === "h" && value === channelId,
              ) &&
              item.id !== event.id &&
              item.created_at <= event.created_at,
          )
          .sort((a, b) => a.created_at - b.created_at);
        if (route && event.id !== route.parent) {
          earlier = (
            await readSubthread(
              earlier,
              { channel: channelId, root: route.root, anchor: route.parent },
              CHAT,
              (filters) => reads.read(filters, budget),
            )
          ).events;
        }
      } catch (error) {
        earlier = [];
        console.warn("Claude could not read the conversation", error);
      }
    const unseen = earlier.filter(
      (item) =>
        item.created_at > seen && (!seen || item.pubkey !== agent.pubkey),
    );
    const signingAuthority = reads?.workflowAuthority();
    const [names, loadedProject, folders] = await Promise.all([
      readAuthorNames(
        reads,
        [event, ...unseen.slice(-CONTEXT_LIMIT)],
        signingAuthority,
      ),
      reading,
      referencedFolders(event, owner, reads?.scope),
    ]);
    const commit = current();
    const project =
      scope === "community" && commit
        ? entry.project.preview(channelId, solo ? loadedProject : NO_PROJECT)
        : loadedProject;
    const referenced = [
      ...new Set([
        ...(entry.referenced.get(key) ?? []),
        ...folders.directories,
      ]),
    ];
    if (commit && referenced.length) entry.referenced.set(key, referenced);
    // An unread Canvas keeps the folders the chat had, not restarting it.
    const directories = [
      ...new Set([
        ...(project ? project.directories : (entry.directories.get(key) ?? [])),
        ...referenced,
      ]),
    ];
    if (commit) {
      if (directories.length) entry.directories.set(key, directories);
      else if (project) entry.directories.delete(key);
    }
    const section = [
      project?.section,
      folders.section,
      referencedSkills(event, owner, agent.pubkey),
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      key,
      event,
      scope,
      topLevel,
      channel: {
        id: channelId,
        ...(summary?.name ? { name: summary.name } : {}),
        dm,
      },
      ...(route
        ? {
            thread: { rootId: route.parent, parentId: route.parent },
            sourceRoot: route.root,
          }
        : thread
          ? { thread }
          : {}),
      context: unseen,
      contextRoot,
      total: earlier.length + 1,
      names,
      ...(signingAuthority ? { signingAuthority } : {}),
      ...(section ? { project: section } : {}),
      ...(scope === "community" && project
        ? { acceptProject: () => entry.project.resolve(channelId, project) }
        : {}),
    };
  }

  /** Its entry, made with the agent's protection however it is first used,
   * so a protected agent never launches unprotected before `sync`. */
  private entry(
    {
      key: agent,
      protection,
      name,
    }: Readonly<{ key: AgentKey; protection?: unknown; name?: string }>,
    initial: Config,
  ): Entry {
    if (this.retirements.has(agent))
      throw new Error("This agent’s previous native sessions have not retired");
    const existing = this.agents.get(agent);
    if (existing) return existing;
    const entry: Entry = {
      project: new ProjectSource(),
      protected: !!protection,
      ...(name ? { name } : {}),
      config: initial,
      team: "",
      sessions: undefined as unknown as AgentSessions,
      contexts: new Map(),
      policies: new Map(),
      directories: new Map(),
      referenced: new Map(),
    };
    // Each process reads files where it was started, and keeps the tool list
    // it was given, until it is replaced.
    const tools =
      (cwd: string): ToolServer =>
      async (conversation, message, signal, check) => {
        const handle = entry.handle;
        const client = () =>
          handle &&
          appClient(handle, {
            // Its PreToolUse hook reviews every tool, Buzz's included.
            ...(!this.target && check ? { nativeCall: check } : {}),
            nativeToolGate: true,
            // Execution-target reads come from somewhere other than this
            // desktop; suppress managed-attachment hints at publish so a
            // remote source cannot trigger local managed cleanup. No remote
            // deletion is added.
            localAttachments: !this.target,
            captureProtectionContext: async () => {
              if (!conversation)
                throw new Error(
                  "The native Claude conversation is unavailable",
                );
              return entry.sessions.captureProtectionContext(conversation);
            },
            relayAuthor: this.reads(agent)?.relayAuthor?.(),
            signingAuthority: relayKeyOf(this.reads(agent)),
            read: (path) =>
              this.target
                ? this.target.readFile(path, { cwd })
                : readFile(
                    this.spawn,
                    cwd,
                    path,
                    undefined,
                    handle.protection?.processProtection,
                  ),
            memories: (slug) => this.memories(agent, slug),
            remembered: () => this.forget(agent),
            signal,
            callSignal: signal,
          });
        const context =
          (conversation && entry.contexts.get(conversation)) || {};
        const published =
          conversation === COMMUNITY_SESSION ? entry.wakePublished : undefined;
        const reply = await respond(
          client,
          context,
          message,
          this.added(),
          listing(this.added()),
        );
        const call = message as {
          method?: string;
          params?: { name?: unknown; arguments?: unknown };
        } | null;
        const result = (reply as { result?: { isError?: boolean } }).result;
        if (
          call?.method === "tools/call" &&
          result &&
          !result.isError &&
          isFinalMessage(call.params?.name, call.params?.arguments)
        )
          published?.();
        return reply;
      };
    const saved = this.savedSessions(agent);
    entry.sessions = new AgentSessions({
      spawn: (id, options) => this.spawn(id, options),
      room: () => this.room(),
      ...(!this.target ? { spare: this.spare } : {}),
      strictResume: !!this.target,
      store: {
        get: (key) => {
          const value = saved.get(key);
          return value?.protection === entry.handle?.protection?.stateKey
            ? value
            : undefined;
        },
        set: (key, value) =>
          saved.set(key, {
            ...value,
            ...(entry.handle?.protection
              ? { protection: entry.handle.protection.stateKey }
              : {}),
          }),
        delete: (key) => saved.delete(key),
      },
      started: (session, text, once) => {
        if (this.target) return;
        void this.prompts(agent).save(
          session,
          [{ label: "", text }],
          // A one-off turn's session is outside any conversation.
          once ? { at: Date.now(), title: "", conversation: null } : undefined,
        );
        // Its transcript names no conversation, so only this says it is the
        // agent's, for its usage; the saved prompts drop old sessions.
        // Its key is kept only while Usage is on.
        if (once)
          void standaloneSessions(this.storage, "claude-code", agent).add(
            session,
            this.usageOn() ? once : undefined,
          );
      },
      // The saved prompt shows the base sections again when a session
      // resumes on other ones than it shows last. It is read from what is
      // saved, so this also holds after the app starts again.
      resumed: (session, text) => {
        if (this.target) return;
        const base = baseOf(text);
        const parts = this.prompts(agent).get(session) ?? [];
        const shown =
          parts.filter(({ label }) => label.startsWith(BASE_LABEL)).at(-1)
            ?.text ??
          (parts[0] && baseOf(parts[0].text));
        if (shown !== undefined && shown !== base)
          void this.prompts(agent).add(session, {
            label: `${BASE_LABEL}${new Date().toISOString()}`,
            text: base,
          });
      },
      onChange: () => this.notify(),
      fingerprint: (key) =>
        JSON.stringify([
          key ? (entry.directories.get(key) ?? []) : [],
          this.reads(agent) ? this.folder(agent, key) : undefined,
          entry.config.model,
          entry.config.effort,
          entry.config.compactAt,
          entry.config.workspace,
          entry.config.instructions,
          entry.config.scope,
          entry.team,
          entry.name,
          entry.memory,
          addedKey(this.added()),
          this.credentials,
        ]),
      // A change gives the session the new prompt at its next turn.
      sections: (key) => replacedSections(sectionsOf(entry.handle, key)),
      launch: async (key) => {
        const { workspace, instructions, scope } = entry.config;
        const gate = entry.handle?.protection;
        if (entry.protected && !gate)
          throw new Error("The protected agent has no live policy binding");
        gate?.assertAvailable();
        // A conversation given its own folder starts there, never in the
        // workspace, which stays within reach as an absolute path.
        const assigned = await this.startFolder(agent, key);
        const resolve = this.host.resolveDirectory?.bind(this.host);
        const folder = assigned && (await existingFolder(resolve, assigned));
        const home = folder && (await resolve?.(workspace));
        // Notes are read once per process: a new note doesn't restart a
        // session, and a slow read starts it without them. Core memory is the
        // copy the fingerprint holds, once a turn has read it.
        const [memory, notes] = await Promise.all([
          "memory" in entry ? entry.memory : this.core(agent),
          recentNotesSection((slug) =>
            this.memories(agent, slug, AbortSignal.timeout(NOTES_WAIT_MS)),
          ),
        ]);
        const shared = key ? entry.directories.get(key) : undefined;
        const directories = home ? [home, ...(shared ?? [])] : shared;
        const cwd = folder || workspace;
        const handle = entry.handle;
        const sections = sectionsOf(handle, key);
        return {
          ...where(entry.config),
          cwd,
          ...(gate
            ? {
                protection: {
                  gate,
                  history: (path: string, signal: AbortSignal) =>
                    protectionTranscript(
                      this.spawn,
                      workspace,
                      path,
                      signal,
                      gate.processProtection,
                    ),
                },
              }
            : {}),
          ...(!this.target && directories ? { directories } : {}),
          ...(handle
            ? { agent: { pubkey: handle.pubkey, relay: handle.relay } }
            : {}),
          hook: (session, event, input) =>
            this.hook(agent, session, event, input),
          tools: tools(cwd),
          systemPrompt: systemPrompt({
            scope,
            cwd,
            ...(home ? { workspace: home } : {}),
            repositories: this.repositories(this.reads(agent)?.scope),
            ...(entry.name
              ? { agent: { name: entry.name, pubkey: pubkeyOf(agent) } }
              : {}),
            instructions,
            team: entry.team,
            ...(memory === undefined ? {} : { memory }),
            notes,
            sections,
            place: placeOf(key),
          }),
        };
      },
    });
    this.agents.set(agent, entry);
    return entry;
  }

  /** The agent's memory, or only entry `slug`, as its community's reads give
   * it. `stop` ends the read sooner than its own limit. */
  private memories(agent: AgentKey, slug?: string, stop?: AbortSignal) {
    const reads = this.reads(agent);
    if (!reads) return Promise.reject(new Error("Buzz is not connected"));
    const limit = AbortSignal.timeout(READ_TIMEOUT_MS);
    return this.memoryReads.read(
      reads,
      pubkeyOf(agent),
      stop ? AbortSignal.any([limit, stop]) : limit,
      slug,
    );
  }
  private forget(agent: AgentKey) {
    const reads = this.reads(agent);
    if (reads) this.memoryReads.forget(reads.connection, pubkeyOf(agent));
  }
}

/** `claude-opus-5-5` reads as `Opus 5.5`, and an alias such as `opus` as
 * `Opus`. Anything else is shown as it is. */
export function modelName(model: string) {
  const id =
    /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/.exec(model);
  const family = id?.[1] ?? (/^[a-z]+$/.test(model) ? model : undefined);
  if (!family) return model;
  const name = family[0]?.toUpperCase() + family.slice(1);
  return id ? `${name} ${id[2]}${id[3] ? `.${id[3]}` : ""}` : name;
}

/** A session control's own context: its channel, and its thread only for a
 * thread's session; it carries no message. */
const controlTurn = (place: SessionPlace, scope: string): TurnContext =>
  Object.freeze({
    channel_id: isBuzzUuid(place.channelId) ? place.channelId : null,
    message_id: null,
    thread_id: scope !== "channel" && isHex64(place.root) ? place.root : null,
  });
/** A notice with no turn in Activity to show on: a compaction's or a
 * standalone turn's. It names no setting's value. */
const warned = (notice: string) => console.warn(notice);
