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
// Turns Agents deliveries into goose turns. Each agent of this type runs in
// its own `goose-acp` process; a delivery becomes a prompt in the harness format,
// sent to the agent's ACP session for its conversation; a watch or timer wake
// runs as a one-off turn in a new session, in its Interest's lane. The run
// returns once the turn is handed over, so one agent works in several
// conversations at once.
// goose acts in Buzz with the in-process Buzz tools over loopback HTTP MCP,
// signed by the agent's native-held key; the runtime only reports a turn that
// fails.
import type { Context } from "../../buzz-mcp/client";
import {
  MemoryReads,
  READ_TIMEOUT_MS,
} from "../../features/agent-harness/core-memory";
import { RESUMED_PROMPT } from "../../buzz-mcp/prompt";
import { respond } from "../../buzz-mcp/rpc";
import { appClient, readFile, relayKeyOf } from "../../buzz-mcp/app-client";
import {
  type AddedTool,
  addedKey,
  turnNote,
} from "../../buzz-mcp/session-tools";
import {
  mentionAuthority,
  type Agent,
  type AgentHandle,
  type Agents,
  type Delivery,
  type StandaloneTurn,
  type TurnResult,
} from "../../features/agents/service";
import { compactAt } from "../../features/agents/compact-at";
import { workflowOf } from "../../features/agents/owner-attestation";
import {
  agentFolders,
  conversationFolder,
  existingFolder,
  startingFolder,
} from "../../features/agents/conversation-folders";
import {
  ownerReads,
  readyOwnerReads,
  workflowMarked,
} from "../../features/agents/reads";
import {
  followRecommended,
  onRecommended,
  type RecommendedCandidate,
  type RecommendedRun,
} from "../../features/agents/recommended";
import { soloChat } from "../../features/agents/solo-chat";
import { SessionControls } from "../../features/agent-harness/session-control";
import type {
  SessionPlace,
  SessionControlAction,
  SessionState,
} from "../../features/agents/service";
import { type AgentKey, pubkeyOf } from "../../features/agents/membership";
import { sessionPrompts } from "../../features/agents/session-prompts";
import { localStore, type AgentStore } from "../../features/agents/store";
import type { Host } from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { threadReference } from "../../features/relay/thread-reference";
import {
  wakeAnchor,
  wakeLands,
} from "../../features/agent-harness/plugin-wake";
import {
  CONTEXT_LIMIT,
  type Scope,
  systemPrompt,
  turnPrompt,
} from "../claude-code/prompt";
import { readAuthorNames } from "../../features/agent-harness/author-names";
import {
  ownerCanvas,
  project,
  readCanvas,
  worksElsewhere,
} from "../../features/agent-harness/project";
import type { Exclusive } from "../../features/agent-harness/acp/agent-sessions";
import {
  placeOf,
  sectionsOf,
} from "../../features/agent-harness/sections/compose";
import type { SectionChoices } from "../../features/agent-harness/sections/choices";
import {
  bindSession,
  type TurnContext,
} from "../../features/agents/gateway/contract";
import {
  CHANGED,
  compactRefusal,
  controlTurn,
  FORWARDING_PROTECTED,
  type GatewayForwarding,
  UNAVAILABLE,
} from "../../features/agents/gateway/forwarding";
import {
  type EligibleRoute,
  fallbackNotice,
} from "../../features/agents/gateway/route";
import {
  type ActivityReceipt,
  GooseProcess,
  REQUEST_TIMEOUT_MS,
  type ServeMcp,
  type Settled,
  type ToolServer,
} from "./goose";
import { forwardedTurn, GATEWAY_PROVIDER } from "./forwarded";
import { marked, sessionTags, unforged } from "./transcript";
import {
  absolute,
  AgentProcess,
  AgentSessions,
  localSessions,
} from "./sessions";

export type Config = Readonly<{
  /** A model the provider offers; empty uses the provider's default, or the
   * goose config's when no provider is named. */
  model: string;
  /** A goose provider; empty uses the goose config's. */
  provider: string;
  /** A thinking level goose offers for the model; empty uses goose's. */
  effort: string;
  instructions: string;
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  /** Whether each thread is its own session, or the whole channel is one. */
  scope: Scope;
  /** The context size, in tokens, its sessions compact at, when below
   * goose's own; unset is goose's default. This device's only. */
  compactAt?: string;
}>;
export const DEFAULT_CONFIG: Config = Object.freeze({
  model: "",
  provider: "",
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
/** What an agent runs on: its config, with `candidate`'s provider, model and
 * thinking level in place of its own while it is on Recommended. */
export const running = (
  value: unknown,
  candidate: RecommendedCandidate | null | undefined,
): Config => followRecommended(value, config(value), candidate);

const CONVERSATION_READ_TIMEOUT_MS = 4_000;
const CHAT = [9, 40002];
const TITLE_LIMIT = 80;

/** A watch's or timer's prompt, after a context naming the agent as a
 * conversation's first prompt does, so its session is listed as the agent's. */
export function standalonePrompt(
  agent: string,
  text: string,
  community = false,
) {
  return unforged(
    `<context>\nScope: standalone\n${community ? "Session scope: community\n" : ""}Agent: ${agent}\n</context>\n\n${text}`,
  );
}

/** A session's title in goose, as harness agents name theirs:
 * `Agent · #channel`, and the thread's root when each thread is a session.
 * A Solo chat's first session keeps it only if goose names no sessions. */
export function sessionTitle(
  agent: string | undefined,
  place: string,
  root?: string,
) {
  const suffix = root ? ` · ${root.slice(0, 8)}` : "";
  const title = `${agent?.trim() || "Buzz agent"} · ${place}`
    .replace(/\s+/g, " ")
    .slice(0, TITLE_LIMIT - suffix.length)
    .trim();
  return `${title}${suffix}`;
}

type Entry = {
  project: ProjectSource;
  lifetime: AbortController;
  protected?: boolean;
  /** Its own goose, stopped once the agent goes. */
  goose: AgentProcess;
  worker?: AgentProcess;
  workerKey?: string;
  /** Every replaced provider's worker, which its successor waits out. */
  stopping?: Promise<void>;
  sessions: AgentSessions;
  /** The Buzz tools its sessions serve, forwarded ones' included. */
  tools: ToolServer;
  /** Forwarded turns, each from before it starts until it has retired,
   * which retiring the agent ends and waits for; one whose retirement failed
   * stays. */
  retiring: Set<Owned>;
  /** Forwarded turns running, by conversation, for its status view: their
   * sessions run outside `sessions`. */
  forwarding: Map<string, Readonly<{ sessionId?: string; at: number }>>;
  config: Config;
  /** The team sections of the latest run; a change reopens idle sessions. */
  team: string;
  /** The agent's name, for its prompt; a rename reopens idle sessions. */
  name?: string;
  /** The latest admitted delivery's handle, used by its running tools. */
  handle?: AgentHandle;
  /** Where each conversation's tools default to: its latest turn's thread. */
  contexts: Map<string, Context>;
  /** The folder each conversation's latest session started in, when a
   * plugin gave it one: its file reads use it while Buzz reconnects. */
  folders: Map<string, string>;
  /** The section choices each conversation's session prompt was last built
   * with: a message that steers its turn reads its Canvas with these. */
  located: Map<string, SectionChoices | undefined>;
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

export class GooseRuntime {
  private readonly agents = new Map<string, Entry>();
  private readonly memoryReads = new MemoryReads();
  private readonly listeners = new Set<() => void>();
  private readonly views = new Map<
    AgentKey,
    ReturnType<AgentSessions["snapshot"]>
  >();
  /** A failed turn's error as its report says it, such as where to fix
   * goose's provider key. */
  explain: (error: string) => string = (error) => error;

  constructor(
    private readonly host: Host,
    /** The owner's connection to each agent's own community. */
    private readonly relay: (key: AgentKey) => RelayData | undefined,
    /** The agent's `core` memory as the host keeps it (`Agents.core`). */
    private readonly core: Agents["core"],
    private readonly storage: Storage = globalThis.localStorage,
    /** The tools plugins add to every session now. */
    private readonly added: () => readonly AddedTool[] = () => [],
    /** Desktop-local repository instructions; standalone hosts keep their own layout. */
    private readonly repositories: (scope: string | undefined) => string = () =>
      "",
    /** Agent storage, where what each session started with is kept. */
    private readonly agentStore: AgentStore = localStore(),
    /** What agents on Recommended run on; found at the first such run. */
    private readonly recommended?: RecommendedRun,
    /** Opens forwarded turns' generations; absent without a plugin owner. */
    private readonly forwarding?: GatewayForwarding,
    /** goose's own default provider, which an agent naming none runs on. */
    private readonly defaultProvider: () => Promise<
      string | undefined
    > = async () => undefined,
  ) {
    // Once found, agents on Recommended take it up.
    this.unfollow = recommended?.subscribe(() => this.sync(this.synced));
  }
  private readonly unfollow: (() => void) | undefined;
  private synced: readonly Agent[] = [];
  private settings(raw: unknown) {
    return running(raw, this.recommended?.current());
  }
  /** Finds what agents on Recommended run on before `raw`'s first run. */
  private async follow(raw: unknown) {
    if (!this.recommended || !onRecommended(raw)) return;
    // Only the first waits; a later retry, after nothing was offered, runs
    // alongside.
    const finding = this.recommended.find();
    if (this.recommended.current() === undefined) await finding;
  }

  /** What each of the agent's sessions started with. */
  prompts(agent: AgentKey) {
    return sessionPrompts(this.agentStore, "goose", agent);
  }
  /** Fallback notices, by the turn whose prompt was marked with each, kept
   * only while the app runs: a reload, or goose compacting the prompt away,
   * loses them. */
  private readonly noticed = new Map<AgentKey, Map<string, string>>();
  notices(agent: AgentKey): ReadonlyMap<string, string> {
    return this.noticed.get(agent) ?? new Map();
  }
  private noted(agent: AgentKey, turn: string, notice: string) {
    const notices = this.noticed.get(agent) ?? new Map<string, string>();
    notices.set(turn, notice);
    for (const oldest of notices.keys()) {
      if (notices.size <= NOTICE_LIMIT) break;
      notices.delete(oldest);
    }
    this.noticed.set(agent, notices);
  }

  /** Every folder a plugin gave the agent's conversations, by conversation. */
  folders(agent: AgentKey): ReadonlyMap<string, string> {
    const scope = ownerReads(this.relay(agent), pubkeyOf(agent))?.scope;
    return scope ? agentFolders(this.agentStore, scope, agent) : new Map();
  }
  /** The folder a plugin gave the conversation, if any; a one-off turn has
   * none. A reconnecting relay keeps its scope, so a turn that starts then
   * still finds the folder. */
  private folder(agent: AgentKey, key: string | undefined) {
    if (!key) return undefined;
    const scope = this.relay(agent)?.snapshot().scope;
    if (!scope) throw new Error("Buzz is not connected");
    return conversationFolder(this.agentStore, scope, agent, key);
  }
  /** `folder`, for a launching session, which records that a conversation
   * without one starts in the workspace. A community session has none. */
  private startFolder(agent: AgentKey, key: string | undefined) {
    if (!key || key === COMMUNITY_SESSION) return undefined;
    const scope = this.relay(agent)?.snapshot().scope;
    if (!scope) throw new Error("Buzz is not connected");
    return startingFolder(this.agentStore, scope, agent, key);
  }

  /** A file as the agent's sessions read one: in its saved workspace. */
  workspaceFile(agent: Agent, path: string) {
    return this.desktop.readFile(path, { cwd: config(agent.config).workspace });
  }

  /** The desktop host's methods goose agents run with. */
  private get desktop() {
    const { host } = this;
    if (!host.spawn || !host.resolveDirectory || !host.readFile)
      throw new Error("goose agents run only in the desktop app");
    return {
      spawn: host.spawn.bind(host),
      resolveDirectory: host.resolveDirectory.bind(host),
      readFile: host.readFile.bind(host),
    };
  }
  private get serve(): ServeMcp {
    const serve = this.host.serveMcp?.bind(this.host);
    if (!serve) throw new Error("goose agents run only in the desktop app");
    return serve;
  }

  /** Brings the runtime in line with this type's agents: changed settings
   * reopen idle sessions, and removed agents stop, each with its goose. */
  private defaultsRevision = 0;

  /** Reopen inherited sessions on their next idle turn after Goose defaults save. */
  defaultsChanged() {
    this.defaultsRevision++;
    for (const entry of this.agents.values())
      if (!entry.config.provider.trim()) entry.sessions.reconfigure();
  }

  private readonly retirements = new Map<string, Promise<void>>();
  async retire(pubkey: string) {
    this.controls.interrupt(`${pubkey}/${COMMUNITY_SESSION}`, true);
    let retiring = this.retirements.get(pubkey);
    if (!retiring) {
      retiring = (async () => {
        const entry = this.agents.get(pubkey);
        entry?.lifetime.abort(new Error("The Goose agent was retired"));
        // Gone while it retires, so its queued deliveries drop silently.
        this.agents.delete(pubkey);
        let failure: { error: unknown } | undefined;
        try {
          await entry?.sessions.shutdown();
        } catch (error) {
          failure = { error };
        }
        // Each forwarded turn ends, retiring in order, within its own
        // timeouts; one whose process has yet to exit, or whose generation
        // native did not close, keeps the agent from retiring.
        const owned = [...(entry?.retiring ?? [])];
        await Promise.allSettled(owned.map((turn) => turn.ended));
        const left = owned.find((turn) => entry?.retiring.has(turn));
        if (left) failure ??= { error: left.failed ?? new Error(NOT_RETIRED) };
        try {
          await entry?.stopping;
          await entry?.worker?.shutdown();
          await entry?.goose.shutdown();
        } catch (error) {
          failure ??= { error };
        }
        if (!failure) {
          this.noticed.delete(pubkey);
          return;
        }
        // Back, stopped, until a later retirement closes what is left.
        if (entry) this.agents.set(pubkey, entry);
        throw failure.error;
      })();
      this.retirements.set(pubkey, retiring);
    }
    try {
      await retiring;
    } finally {
      // A failed retirement is retried by the next one, not kept.
      if (this.retirements.get(pubkey) === retiring)
        this.retirements.delete(pubkey);
    }
  }
  sync(agents: readonly Agent[]) {
    this.synced = agents;
    const current = new Set(agents.map((agent) => agent.key));
    for (const key of this.agents.keys())
      if (!current.has(key)) void this.retire(key).catch(() => undefined);
    for (const agent of agents) {
      if (this.retirements.has(agent.key)) continue;
      const next = this.settings(agent.config);
      const entry = this.agents.get(agent.key);
      if (!entry) {
        const created = this.entry(agent.key, next);
        created.name = agent.name;
        created.protected = !!agent.protection;
      } else if (
        JSON.stringify(entry.config) !== JSON.stringify(next) ||
        entry.name !== agent.name
      ) {
        entry.config = next;
        entry.name = agent.name;
        entry.sessions.reconfigure();
      }
    }
    this.notify();
  }

  /** Conversations each agent has a session for, for its status view. */
  sessions(agent: AgentKey) {
    let view = this.views.get(agent);
    if (!view) {
      const entry = this.agents.get(agent);
      const forwarded = [...(entry?.forwarding ?? [])].map(
        ([key, { sessionId, at }]) => ({
          key,
          busy: true,
          ...(sessionId ? { sessionId } : {}),
          at,
        }),
      );
      // A forwarded turn holds its conversation, so it stands for it.
      view = [
        ...(entry?.sessions.snapshot() ?? []).filter(
          (row) => !entry?.forwarding.has(row.key),
        ),
        ...forwarded,
      ];
      this.views.set(agent, view);
    }
    return view;
  }
  /** Resolves once `sessions` lists each conversation whose session is
   * opening now. */
  async listed(agent: AgentKey) {
    await this.agents.get(agent)?.sessions.opened();
  }
  /** A person's name in the agent's community, if known. */
  name(agent: AgentKey, pubkey: string) {
    const snapshot = this.relay(agent)?.snapshot();
    const session = snapshot?.status === "ready" ? snapshot.session : undefined;
    return (
      session?.names.resolve(pubkey) ??
      session?.profiles.snapshot().get(pubkey)?.name
    );
  }
  source(agent: AgentKey, key: string) {
    return sessionSource(this.agentStore, agent, key);
  }
  /** The agent's saved conversations, most recently used first. Removing an
   * agent keeps them. */
  conversations(agent: AgentKey) {
    return localSessions(this.storage, agent)
      .list()
      .map(([key, { at, sessions = [] }]) => ({ key, at, sessions }));
  }
  /** The community's current name and kind for a channel, if it lists it. */
  channelLabel(agent: AgentKey, channelId: string) {
    return ownerReads(this.relay(agent), pubkeyOf(agent))?.channelLabel(
      channelId,
    );
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    this.views.clear();
    for (const listener of this.listeners) listener();
  }
  private readonly controls = new SessionControls(() => this.notify());
  private controlKey(agent: Agent, place: SessionPlace) {
    return scopedSessionKey(
      config(agent.config).scope,
      place.channelId,
      place.root,
    );
  }
  sessionState(agent: Agent, place: SessionPlace): SessionState {
    const key = this.controlKey(agent, place);
    if (this.controls.compacting(`${agent.key}/${key}`)) return "compacting";
    return this.controls.active(`${agent.key}/${key}`) ||
      this.agents.get(agent.key)?.policies.has(key) ||
      this.agents.get(agent.key)?.sessions.active(key)
      ? "active"
      : "idle";
  }
  async session(
    agent: Agent,
    place: SessionPlace,
    action: SessionControlAction,
  ) {
    const key = this.controlKey(agent, place);
    const control = `${agent.key}/${key}`;
    const entry = this.entry(agent.key, this.settings(agent.config));
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
      // A saved session a forwarded turn left compacts through the gateway
      // too, under the control's own context, or fails visibly; one whose
      // agent's provider the gateway doesn't serve compacts as any other.
      const through =
        action === "compact" &&
        key !== COMMUNITY_SESSION &&
        !!this.forwarding &&
        (await this.forwards(entry, agent));
      if (through) signal.throwIfAborted();
      const result = await entry.sessions.reset(
        key,
        action,
        through
          ? (held) => this.compact(entry, agent, place, held, signal)
          : undefined,
      );
      signal.throwIfAborted();
      if (!result.ok) throw new Error(result.error);
    });
  }

  dispose() {
    this.controls.dispose();
    this.unfollow?.();
    for (const entry of this.agents.values()) {
      entry.lifetime.abort(new Error("The Goose runtime was disposed"));
      entry.sessions.dispose();
      entry.worker?.stop();
      entry.goose.stop();
    }
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
      team,
      model,
      effort,
      synced,
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
      gateway: offered,
      gatewayFallback,
    } = delivery;
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
    const resumed = trigger.type === "mention" && !!trigger.resumed;
    // goose runs commands as you; mentions need owner or delegated authority.
    if (trigger.type === "mention") {
      // A workflow's mention waits out a reconnect; the check below decides.
      const ready = workflowMarked(trigger.event, agent.owner);
      const reads = ready
        ? await readyOwnerReads(
            this.relay(agent.key),
            agent,
            signal,
            channelId ?? trigger.event.tags.find((tag) => tag[0] === "h")?.[1],
          )
        : ownerReads(this.relay(agent.key), agent.pubkey);
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
      signal.throwIfAborted();
    }
    if (this.settings(raw).scope === "community" && !reserved)
      return this.controls.admit(
        `${agent.key}/${COMMUNITY_SESSION}`,
        delivery,
        (accepted, deferred) => this.admitDelivery(accepted, true, deferred),
      );
    // Found only for a delivery it takes, so nothing it drops starts goose.
    await this.follow(raw);
    const entry = this.entry(agent.key, this.settings(raw));
    if (
      (this.settings(raw).scope !== "community" &&
        !entry.policies.has(COMMUNITY_SESSION)) ||
      !entry.handle
    ) {
      entry.handle = agent;
      entry.team = team ?? "";
    }
    const event =
      trigger.type !== "mention" ? wakeAnchor(trigger) : trigger.event;
    const channel =
      channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1] ?? undefined;
    if (!channel) return;
    // Where it answers needs the channel's kind, which a reconnecting
    // community, or one still listing its channels, does not know yet: it
    // waits, as a workflow's mention does, rather than answer a Solo chat or
    // a DM as a thread. A community that knows it answers at once.
    await readyOwnerReads(
      this.relay(agent.key),
      agent,
      signal,
      channel,
      "This turn",
    );
    signal.throwIfAborted();
    if (current && !current()) return ignored?.();
    // Frozen for the turn: its key, prompt, tools and posts all follow it.
    const solo = await soloChat(
      () => this.relay(agent.key),
      agent.owner,
      channel,
      signal,
    );
    const topLevel = solo || wake?.topLevel === true;
    if (wake && !wakeLands(wake, topLevel)) return ignored?.();
    const gateway = offered && (await this.routed(entry, offered));
    if (offered && !admittedDeferred) signal.throwIfAborted();
    // A wake run without the gateway says so beside its prompt in Activity:
    // its prompt ends with a mark naming the turn. A wake is always sent as
    // `refresh` rebuilds it, steered or queued, so only that is marked.
    const marking = wake && gatewayFallback ? crypto.randomUUID() : undefined;
    if (marking && gatewayFallback)
      this.noted(agent.key, marking, gatewayFallback.notice);
    // `fresh` is for a session that has been shown nothing yet.
    let acceptProject: (() => void) | undefined;
    const prompt = async (
      fresh: boolean,
      admitted?: string,
      current = () => true,
    ) => {
      const wakePrompt = wake ? ((await wakeText?.()) ?? wake.text) : undefined;
      const turn = await this.turn(
        entry,
        this.settings(raw).scope,
        agent,
        event,
        channel,
        topLevel,
        fresh,
        resumed,
        solo,
        admitted,
        current,
      );
      acceptProject = turn.acceptProject;
      const { choices, ...shown } = turn;
      const { channel: where } = shown;
      const woken = wake && {
        wake: { ...wake, text: wakePrompt ?? wake.text },
      };
      const said = turnPrompt({
        ...shown,
        agent: agent.key,
        channelLevel: topLevel && !solo,
        ...woken,
      });
      const text = resumed ? `${said}\n\n${RESUMED_PROMPT}` : said;
      return {
        key: shown.key,
        dm: where.dm,
        shown: shown.shown,
        place: where.name
          ? `#${where.name}`
          : where.dm
            ? "DM"
            : where.id.slice(0, 8),
        text,
        choices,
      };
    };
    const prepared =
      this.settings(raw).scope === "community"
        ? undefined
        : await prompt(false);
    const key = prepared?.key ?? COMMUNITY_SESSION;
    if (!gateway)
      await rememberCommunitySource(this.agentStore, agent.key, key, channel);
    signal.throwIfAborted();
    let noteRoot: string | undefined;
    let notes: ReturnType<NonNullable<AgentHandle["notes"]>> = [];
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
    let delivered!: ReturnType<AgentSessions["deliver"]>;
    let interrupted = false;
    const valid = () => !interrupted && (!current || current());
    let submitted = false;
    const handoff = this.controls.deliver(
      `${agent.key}/${key}`,
      async (deferred) => {
        deferred ||= admittedDeferred;
        // Accepted deferred work belongs to the captured agent lifetime, not
        // the short deadline for handing a message to the harness.
        if (this.agents.get(agent.key) !== entry) {
          delivered = Promise.resolve({ ok: true, undelivered: true });
          return;
        }
        if (!deferred) signal.throwIfAborted();
        await wait;
        if (interrupted || this.agents.get(agent.key) !== entry) {
          delivered = Promise.resolve({ ok: true, undelivered: true });
          return;
        }
        if (gateway && key === COMMUNITY_SESSION) {
          delivered = Promise.resolve({
            ok: false,
            error: COMMUNITY_FORWARDING_UNSUPPORTED,
            undelivered: true,
          });
          return;
        }
        entry.handle = agent;
        entry.team = team ?? "";
        const turn = prepared ?? (await prompt(false, key, valid));
        const { place, shown, dm } = turn;
        // Plugins' notes wait until the turn is handed over, so one that
        // fails or is cancelled before then leaves them for the next.
        noteRoot =
          topLevel || key === channel || (key === COMMUNITY_SESSION && dm)
            ? undefined
            : (threadReference(event)?.rootId ?? event.id);
        notes = agent.notes?.(channel, noteRoot) ?? [];
        const built = wait && prepared ? await prompt(false, key, valid) : turn;
        const text = this.review(
          entry,
          built.text,
          notes,
          channel,
          noteRoot,
          key,
        );
        if (interrupted || this.agents.get(agent.key) !== entry) {
          delivered = Promise.resolve({ ok: true, undelivered: true });
          return;
        }
        // Set only once goose takes the message, so a dropped one leaves the
        // running turn's tool defaults.
        const context = topLevel
          ? { channel, ...(solo ? { topLevel } : {}) }
          : key === channel || (key === COMMUNITY_SESSION && dm)
            ? { channel }
            : { channel, root: threadReference(event)?.rootId ?? event.id };
        submitted = true;
        const activity = {
          activityScope: topLevel
            ? channel
            : (threadReference(event)?.rootId ?? event.id),
          ...(step ? { step } : {}),
          delivered: () => acceptProject?.(),
          ...(acknowledged ? { acknowledged } : {}),
          accepted: () => {
            entry.contexts.set(key, context);
            accepted?.();
          },
          ...(superseded ? { superseded } : {}),
        };
        const options = {
          title: sessionTitle(
            entry.name,
            key === COMMUNITY_SESSION ? "Community" : place,
            key.split("/")[1],
          ),
          ...(!deferred && !wait ? { signal } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          // A pick runs on its own level; a synced one is checked.
          ...(synced?.effort && !model && !effort
            ? { kept: synced.effort }
            : {}),
        };
        if (gateway) {
          delivered = this.forwarded(entry, agent.key, key, gateway, {
            ...options,
            activity: { ...activity, current: valid },
            prompt: async (fresh) => {
              if (!valid()) return undefined;
              // A wake is rebuilt as it is sent, as a refresh would be.
              if (!fresh && !wake) return { text, shown };
              const rebuilt = await prompt(fresh, key, valid);
              return {
                text: this.review(
                  entry,
                  rebuilt.text,
                  notes,
                  channel,
                  noteRoot,
                  key,
                ),
                shown: rebuilt.shown,
              };
            },
          });
          return;
        }
        delivered = entry.sessions.deliver(key, text, shown, {
          ...options,
          ...activity,
          ...(wake ? { current } : {}),
          // Built again as it is handed over: a wake, to read what is
          // current; a session closed since, for what the new one has not
          // been shown; and a message whose session took other section
          // choices while it waited, so its Canvas says what the
          // instructions of the turn it joins or starts say.
          refresh: async (fresh = false) => {
            const same =
              JSON.stringify(this.installed(entry, channel, key) ?? null) ===
              built.choices;
            const ready =
              wake || fresh || !same ? await prompt(fresh, key, valid) : built;
            const text = this.review(
              entry,
              ready.text,
              notes,
              channel,
              noteRoot,
              key,
            );
            return marking ? marked(text, marking) : text;
          },
          // A Solo chat takes the name goose gives its first session.
          ...(solo && named ? { named } : {}),
        });
      },
    );
    const handed = handoff.done;
    const done = handed
      .then(async () => {
        const result = await delivered;
        return key === COMMUNITY_SESSION &&
          interrupted &&
          (!submitted || result.undelivered)
          ? { ...result, ok: false, stopped: true as const }
          : result;
      })
      .catch((error) => ({
        ok: false,
        error: String(error),
        undelivered: true,
      }));
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
      handed,
      settled: Promise.all([same ? prior?.settled : undefined, done]).then(() =>
        entry.sessions.idle(key),
      ),
      cancel() {
        interrupted = true;
        prior?.cancel();
      },
    };
    entry.policies.set(key, policy);
    void policy.settled.then(() => {
      if (entry.policies.get(key) !== policy) return;
      entry.policies.delete(key);
      this.notify();
    });
    if (!wait && !handoff.deferred && !admittedDeferred) await handed;
    workingUntil(done);
    interruptible?.(() => {
      interrupted = true;
      if (submitted && key !== COMMUNITY_SESSION) policy.cancel();
      return submitted ? entry.sessions.interrupt(key) : Promise.resolve();
    });
    this.notify();
    void done
      .then((result) => {
        if (result.undelivered) agent.restoreNotes?.(channel, notes, noteRoot);
        // Of the messages one turn answered, only one has its error. An
        // answer goose wrote without `send` stays in local activity.
        if (result.error !== undefined)
          return this.report(agent, channel, event, result.error, topLevel);
      })
      .catch((error) => console.warn("goose turn failed", error))
      .finally(() => this.notify());
  }

  /** Runs a standalone turn, such as a watch's or a timer's, in a one-off
   * session that joins no conversation. */
  async runOnce(turn: StandaloneTurn): Promise<TurnResult> {
    let answered = false;
    try {
      const result = await this.standalone(turn, false, () => {
        answered = true;
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
    answered = () => {},
  ): Promise<TurnResult> {
    const settings = this.settings(delivery.config);
    if (settings.scope === "community" && !reserved)
      return this.controls.wake(
        `${delivery.agent.key}/${COMMUNITY_SESSION}`,
        signal,
        (signal) =>
          this.standalone({ delivery, key, signal, prompt }, true, answered),
      );
    const { agent, team } = delivery;
    await this.follow(delivery.config);
    const entry = this.entry(agent.key, settings);
    if (settings.scope !== "community" && !reserved)
      return standaloneTurn(
        entry.policies,
        signal,
        (signal) => this.standalone({ delivery, key, signal, prompt }, true),
        () => this.notify(),
      );
    if (settings.scope !== "community" || !entry.handle) {
      entry.handle = agent;
      entry.team = team ?? "";
    }
    const gateway =
      delivery.gateway && (await this.routed(entry, delivery.gateway));
    if (gateway) {
      signal.throwIfAborted();
      if (settings.scope === "community")
        return { ok: false, error: COMMUNITY_FORWARDING_UNSUPPORTED };
      const done = this.forward(entry, agent.key, key, gateway, {
        prompt: async () => {
          if (delivery.current?.() === false) return undefined;
          const text = await prompt();
          return text === undefined
            ? undefined
            : { text: standalonePrompt(agent.key, text) };
        },
        title: sessionTitle(entry.name, key),
        signal,
        ...(delivery.synced?.effort ? { kept: delivery.synced.effort } : {}),
      });
      this.notify();
      return done.finally(() => this.notify());
    }
    const done =
      settings.scope === "community"
        ? communityTurn(
            entry.policies,
            signal,
            this.controls,
            `${agent.key}/${COMMUNITY_SESSION}`,
            async (signal) => {
              const text = await prompt();
              if (text === undefined || !delivery.current())
                return { ok: true };
              signal.throwIfAborted();
              entry.handle = agent;
              entry.team = team ?? "";
              entry.contexts.set(COMMUNITY_SESSION, {});
              let stopping: Promise<void> | undefined;
              const stop = () => {
                const process =
                  entry.sessions.serving(COMMUNITY_SESSION)?.process;
                if (!process) return;
                stopping ??= (async () => {
                  let timer: ReturnType<typeof setTimeout> | undefined;
                  try {
                    await Promise.race([
                      entry.sessions
                        .interrupt(COMMUNITY_SESSION)
                        .then(() => entry.sessions.idle(COMMUNITY_SESSION)),
                      new Promise<never>((_, reject) => {
                        timer = setTimeout(
                          () => reject(new Error("Goose did not stop")),
                          15_000,
                        );
                      }),
                    ]);
                  } catch {
                    await process?.kill();
                    await process?.exited;
                  } finally {
                    clearTimeout(timer);
                  }
                })().catch((error) =>
                  console.error("Goose could not stop expired work", error),
                );
              };
              signal.addEventListener("abort", stop, { once: true });
              try {
                const result = await entry.sessions.deliver(
                  COMMUNITY_SESSION,
                  [
                    standalonePrompt(agent.key, text, true),
                    NO_PROJECT.section,
                    ownerInstructions(undefined, true),
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                  0,
                  {
                    signal,
                    delivered: () =>
                      entry.project.resolve(undefined, NO_PROJECT),
                    current: () => !signal.aborted && delivery.current(),
                    ...(delivery.synced?.effort
                      ? { kept: delivery.synced.effort }
                      : {}),
                  },
                );
                if (result.ok && result.answered) answered();
                await entry.sessions.idle(COMMUNITY_SESSION);
                return result;
              } finally {
                signal.removeEventListener("abort", stop);
                await stopping;
              }
            },
            () => this.notify(),
          )
        : entry.sessions.runOnce(
            key,
            async () => {
              const text = await prompt();
              return text === undefined
                ? undefined
                : standalonePrompt(agent.key, text);
            },
            {
              signal,
              title: sessionTitle(entry.name, key),
              current: delivery.current,
              ...(delivery.synced?.effort
                ? { kept: delivery.synced.effort }
                : {}),
            },
          );
    this.notify();
    return done.finally(() => this.notify());
  }

  /** Whether the agent's turns can go through the gateway: on the provider
   * it names, else goose's default, the gateway's. One whose default can't
   * be read runs as it would without the gateway, as does a protected
   * agent: a forwarded turn spawns outside its containment and policy. */
  private async forwards(entry: Entry, agent?: Pick<Agent, "protection">) {
    if (entry.protected || entry.handle?.protection || agent?.protection)
      return false;
    const named = entry.config.provider.trim();
    const provider =
      named || (await this.defaultProvider().catch(() => undefined));
    return provider === GATEWAY_PROVIDER;
  }

  /** The dispatched route a turn runs through, or none: a turn on another
   * provider, or a protected agent's, runs as it would without the
   * gateway, its settings untouched. */
  private async routed(entry: Entry, gateway: Gateway) {
    return (await this.forwards(entry)) ? gateway : undefined;
  }

  /** A conversation's turn through the gateway, holding the conversation:
   * its messages and controls wait for it, and for its process to exit. */
  private forwarded(
    entry: Entry,
    agent: AgentKey,
    key: string,
    gateway: Gateway,
    turn: ForwardTurn,
  ): Promise<Settled> {
    // The delivery's deadline ends only its wait for the conversation, as
    // an ordinary delivery's does; a turn that has it runs on.
    return entry.sessions
      .exclusive(
        key,
        (held) => this.forward(entry, agent, key, gateway, turn, held),
        undefined,
        turn.signal,
      )
      .catch((error: unknown) =>
        message(error) === STOPPED
          ? { ok: true, undelivered: true }
          : message(error) === LATE
            ? { ok: false, error: LATE, undelivered: true }
            : { ok: false, error: message(error) },
      );
  }

  /** Compacts the saved session a forwarded turn left: by its own turn of
   * `/compact` through the gateway, where the agent's turns go through it
   * now, else not at all. */
  private async compact(
    entry: Entry,
    agent: Agent,
    place: SessionPlace,
    held: Exclusive,
    signal: AbortSignal,
  ): Promise<Settled> {
    const route = this.forwarding?.control(agent.key);
    if (route?.kind === "blocked")
      return {
        ok: false,
        // A refused sign-in, or access still being checked, fails as a turn
        // does, not as a fallback.
        error:
          route.reason === "auth" || route.reason === "readiness_pending"
            ? route.message
            : compactRefusal(fallbackNotice(route.reason)),
      };
    if (!route) return { ok: false, error: NOT_COMPACTED };
    const turn = controlTurn(place, config(agent.config).scope);
    const key = this.controlKey(agent, place);
    const result = await this.forward(
      entry,
      agent.key,
      key,
      { route, turn },
      { prompt: async () => ({ text: "/compact" }), signal },
      held,
    );
    // goose ends the turn either way, and says which in its text.
    if (!result.ok || result.text === "Compaction complete") return result;
    return {
      ok: false,
      error: result.text || "goose could not compact the session",
    };
  }

  /** Runs `turn` through the gateway at the route it was dispatched with:
   * in conversation `key` under `held`, resuming its saved session with the
   * binding saved with it, or, without, as a one-off turn with a binding of
   * its own. A turn that can't be forwarded fails visibly before anything
   * spawns; it never runs on goose's own configuration instead, and is
   * never retried. Unlike an ordinary session, which reopens when the
   * agent's instructions, team or memory change, a conversation's forwarded
   * turns keep resuming its saved session, history and all, until New
   * session. Each turn sets its system prompt again, built from the
   * agent's current settings. */
  private forward(
    entry: Entry,
    agent: AgentKey,
    key: string,
    gateway: Gateway,
    turn: ForwardTurn,
    held?: Exclusive,
  ): Promise<Settled> {
    const refused = (error: string) => Promise.resolve({ ok: false, error });
    const { forwarding } = this;
    if (!forwarding) return refused(UNAVAILABLE);
    // Never reached: a protected agent's turns aren't routed here. Its
    // forwarded spawn would run outside its containment and policy.
    if (entry.protected || entry.handle?.protection)
      return refused(FORWARDING_PROTECTED);
    // What is saved, unread, is refused, never taken for none: a value that
    // is no binding reads as malformed.
    const saved = held?.binding;
    let bound: ReturnType<typeof bindSession>;
    try {
      bound = bindSession(
        gateway.route,
        saved === undefined
          ? undefined
          : saved === "malformed" || saved.value == null
            ? MALFORMED
            : saved.value,
        !held ? "standalone" : held.reset ? "reset" : "resume",
      );
    } catch (error) {
      return refused(message(error));
    }
    if (!bound.ok) return refused(bound.message);
    const { binding } = bound;
    const { route } = gateway;
    const { desktop } = this;
    const workspace = () =>
      absolute(desktop.resolveDirectory, entry.config.workspace);
    // The agent owns the turn from here until its process has exited and
    // native has closed its generation: retiring the agent ends it and waits
    // for that. One that could not be confirmed stays, failing every
    // retirement after.
    const owned: Owned = { ended: Promise.resolve() };
    entry.retiring.add(owned);
    // Working until it settles, on the session it resumes or opens. The
    // conversation's next turn may start once this one's process exits,
    // before it settles, so it clears only its own row.
    let row: Readonly<{ sessionId?: string; at: number }> | undefined;
    const running = (sessionId = held?.saved) => {
      row = { ...(sessionId ? { sessionId } : {}), at: Date.now() };
      entry.forwarding.set(key, row);
      this.notify();
    };
    running();
    // What the prompt sent was built to have shown, noted once goose takes
    // it, as an ordinary message is.
    let shown: number | undefined;
    let systemPrompt = "";
    const { activity } = turn;
    const done = forwardedTurn(
      {
        open: (signal) =>
          forwarding.open(
            agent,
            route,
            { binding, context: gateway.turn },
            turn.signal && held
              ? AbortSignal.any([signal, turn.signal])
              : signal,
          ),
        start: async (env, onProcess) =>
          GooseProcess.start(desktop.spawn, {
            cwd: await workspace(),
            env,
            // Its Buzz tools' server counts in the pool sessions share.
            serve: entry.sessions.pooled((handler) => this.serve(handler)),
            onProcess,
            // Acts as the agent, as its ordinary goose does.
            ...(entry.handle && {
              agent: { pubkey: entry.handle.pubkey, relay: entry.handle.relay },
            }),
          }),
        launch: async () => {
          // A conversation given its own folder runs there.
          const launched = await this.launch(
            agent,
            entry,
            held ? key : undefined,
          );
          ({ systemPrompt } = launched);
          return {
            cwd: await absolute(desktop.resolveDirectory, launched.workspace),
            systemPrompt,
          };
        },
        tools: entry.tools,
        choice: () => this.choice(entry),
        conversation: key,
        tags: sessionTags(agent, held ? key : undefined),
        ...(turn.title ? { title: turn.title } : {}),
        ...(held?.saved ? { load: held.saved } : {}),
        prompt: async (fresh) => {
          const prompt = await turn.prompt(fresh);
          shown = prompt?.shown;
          return prompt?.text;
        },
        ...(held ? { keep: (id: string) => held.keep(id, binding) } : {}),
        // Kept as an ordinary new session's is, for the Prompts tab.
        started: (id) => {
          running(id);
          void this.prompts(agent).save(
            id,
            [{ label: "", text: systemPrompt }],
            {
              at: Date.now(),
              title: turn.title ?? "",
              conversation: held ? key : null,
            },
          );
        },
        outlives: (retirement, exited) => {
          // Before the turn ends: by then, one whose process exited is
          // confirmed retired or failed.
          owned.retiring = true;
          void retirement.then(
            () => entry.retiring.delete(owned),
            (error: unknown) => {
              owned.failed = error;
            },
          );
          // The conversation waits only for the process: a generation native
          // didn't close fails this turn and the agent's retirement, but no
          // later turn runs on it.
          held?.outlives(exited);
        },
        signal: AbortSignal.any([
          held?.signal ?? turn.signal ?? entry.lifetime.signal,
          entry.lifetime.signal,
        ]),
        activity: {
          ...activity,
          delivered: () => {
            if (shown !== undefined) held?.shown(shown);
            activity?.delivered?.();
          },
        },
        ...(turn.model ? { model: turn.model } : {}),
        ...(turn.effort ? { effort: turn.effort } : {}),
        ...(turn.kept ? { kept: turn.kept } : {}),
      },
      CHANGED,
    );
    owned.ended = done;
    const cleared = () => {
      if (entry.forwarding.get(key) !== row) return;
      entry.forwarding.delete(key);
      this.notify();
    };
    void done.then(cleared, cleared);
    // Ended with nothing left running: nothing more to wait for.
    void done.then(
      () => {
        if (!owned.retiring) entry.retiring.delete(owned);
      },
      // Unreached: it settles, unless `held.outlives` refused a hold
      // already released, which work it holds cannot see.
      (error: unknown) => {
        owned.failed = error;
      },
    );
    return done;
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
    return unforged(
      [
        text,
        ...notes,
        turnNote(entry.handle, channelId, root, key === COMMUNITY_SESSION),
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  /** Says in the thread that a turn failed, so nobody waits on it. */
  private report(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    error: string,
    topLevel: boolean,
  ) {
    return this.post(
      agent,
      channel,
      event,
      `⚠️ I couldn't finish that: ${this.explain(error.slice(0, 500))}`,
      topLevel,
      [["p", agent.owner]],
    );
  }

  /** Replies as the agent in the event's thread, or at a Solo chat's top
   * level. */
  private post(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    content: string,
    topLevel: boolean,
    tags: string[][] = [],
  ) {
    return agent
      .publish({
        kind: 9,
        content,
        tags: [
          ["h", channel],
          ...(topLevel
            ? []
            : [["e", threadReference(event)?.rootId ?? event.id, "", "reply"]]),
          ...tags,
        ],
      })
      .catch((failure) => console.warn("goose could not post", failure));
  }

  /** Where the event's turn goes, and what its prompt needs. */
  private async turn(
    entry: Entry,
    sessionScope: Scope,
    agent: Pick<Agent, "key" | "pubkey">,
    event: EventData,
    channelId: string,
    topLevel: boolean,
    fresh = false,
    /** Given again after a reload stopped it: it is shown what came after it,
     * its own replies included, as its new session cannot know them. */
    resumed = false,
    solo = topLevel,
    admitted?: string,
    current = () => true,
  ) {
    const snapshot = this.relay(agent.key)?.snapshot();
    const session = snapshot?.status === "ready" ? snapshot.session : undefined;
    const summary =
      session?.channels.list().channels.find((item) => item.id === channelId) ??
      session?.channels.get?.(channelId);
    const dm = summary?.channelType === "dm";
    const thread = threadReference(event);
    const rootId = thread?.rootId ?? event.id;
    // A Solo chat is one conversation, as a DM is.
    const key =
      admitted ??
      scopedSessionKey(
        sessionScope,
        channelId,
        topLevel || dm ? undefined : rootId,
      );

    // The conversation it was admitted to, not the scope as it is now.
    const scope: Scope = scopeOfSession(key, channelId);
    // A resumed turn's session never saw its thread, its own replies included,
    // even when another resumed turn already opened it in a channel session.
    const seen =
      fresh || resumed || key === COMMUNITY_SESSION
        ? 0
        : entry.sessions.seen(key);
    // Read alongside the conversation: only a Solo chat's Canvas is handed over.
    const owner = entry.handle?.owner;
    // Keyed as its session launches: a community session has no folder of
    // its own, whatever folder the chat kept.
    const folder = session ? this.folder(agent.key, key) : undefined;
    const chosen = this.installed(entry, channelId, key);
    const reading = solo
      ? readCanvas(
          session && owner
            ? () =>
                ownerCanvas(
                  session.canvas,
                  owner,
                  channelId,
                  session.channelWrites.startingCanvas(channelId),
                )
            : undefined,
        ).then(
          (read) => read && project(read.text, worksElsewhere(folder, chosen)),
        )
      : Promise.resolve(undefined);
    const threadRead = (thread || (resumed && !dm)) && !topLevel;
    let earlier: readonly EventData[] = [];
    if (session && (thread || dm || topLevel || resumed))
      try {
        const events = await session.read(
          threadRead
            ? [
                { ids: [rootId], "#h": [channelId], limit: 1 },
                { kinds: CHAT, "#h": [channelId], "#e": [rootId], limit: 200 },
              ]
            : [{ kinds: CHAT, "#h": [channelId], limit: CONTEXT_LIMIT + 1 }],
          { signal: AbortSignal.timeout(CONVERSATION_READ_TIMEOUT_MS) },
        );
        earlier = events
          .filter(
            (item) =>
              CHAT.includes(item.kind) &&
              item.tags.some(
                ([key, value]) => key === "h" && value === channelId,
              ) &&
              item.id !== event.id &&
              (resumed || item.created_at <= event.created_at),
          )
          .sort((a, b) => a.created_at - b.created_at);
      } catch (error) {
        console.warn("goose could not read the conversation", error);
      }
    // A session already has its own replies; a new one is shown them too.
    const unseen = earlier.filter(
      (item) =>
        item.created_at > seen && (!seen || item.pubkey !== agent.pubkey),
    );
    const reads = ownerReads(this.relay(agent.key), agent.pubkey);
    const signingAuthority = reads?.workflowAuthority();
    const [names, canvas] = await Promise.all([
      readAuthorNames(
        reads,
        [event, ...unseen.slice(-CONTEXT_LIMIT)],
        signingAuthority,
      ),
      reading,
    ]);
    const loadedProject = canvas;
    const turnProject =
      scope === "community" && admitted && current()
        ? entry.project.preview(channelId, solo ? loadedProject : NO_PROJECT)
        : loadedProject;
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
      ...(thread ? { thread } : {}),
      context: unseen,
      /** created_at of the newest event the turn is shown. A thread read in a
       * channel session stops at the event: the other threads were not read. */
      shown:
        threadRead && key === channelId
          ? event.created_at
          : Math.max(
              event.created_at,
              ...unseen.map((item) => item.created_at),
            ),
      total: earlier.length + 1,
      ...(signingAuthority ? { signingAuthority } : {}),
      names,
      ...(turnProject ? { project: turnProject.section } : {}),
      ...(scope === "community" && turnProject
        ? { acceptProject: () => entry.project.resolve(channelId, turnProject) }
        : {}),
      /** The choices it was built with, to tell when to build it again. */
      choices: JSON.stringify(chosen ?? null),
    };
  }

  /** The section choices a turn's Canvas is read with: those its
   * conversation's session took last, which a turn that starts takes as it
   * is handed over and a steer joins; the current ones before it has any. */
  private installed(entry: Entry, channelId: string, key: string) {
    return entry.located.has(key)
      ? entry.located.get(key)
      : entry.handle?.promptSections?.(channelId);
  }

  private entry(agent: AgentKey, initial: Config): Entry {
    if (this.retirements.has(agent))
      throw new Error("This agent’s previous native sessions have not retired");
    const existing = this.agents.get(agent);
    if (existing) return existing;
    const entry: Entry = {
      project: new ProjectSource(),
      lifetime: new AbortController(),
      config: initial,
      team: "",
      sessions: undefined as unknown as AgentSessions,
      goose: new AgentProcess(
        {
          spawn: (id, options) => this.desktop.spawn(id, options),
          resolveDirectory: (path) => this.desktop.resolveDirectory(path),
        },
        (handler) => this.serve(handler),
        undefined,
        () => entry.handle,
        () => compactAt(entry.config.compactAt),
      ),
      tools: undefined as unknown as ToolServer,
      retiring: new Set(),
      forwarding: new Map(),
      contexts: new Map(),
      folders: new Map(),
      located: new Map(),
      policies: new Map(),
    };
    // Every session of the agent shares them, so they read the settings, the
    // handle and the conversation's place as they are when called.
    const tools: ToolServer = async (conversation, message, workSignal) => {
      const handle = entry.handle;
      // A call in a conversation answers only while its turn runs unstopped.
      // A forwarded turn's session runs in its own goose, outside `sessions`;
      // its work signal alone ends its calls.
      const current =
        conversation &&
        !entry.forwarding.has(conversation) &&
        entry.sessions.current(conversation);
      const signal = AbortSignal.any([
        entry.lifetime.signal,
        workSignal ?? AbortSignal.abort(new Error("The turn has ended")),
      ]);
      const client = () =>
        handle &&
        appClient(handle, {
          signal,
          callSignal: signal,
          ...(current && {
            check: () => {
              if (!current()) throw new Error("The Goose turn has ended");
            },
          }),
          // Its pre-tool check reviews every call, Buzz's extension included.
          nativeToolGate: true,
          // Read from the process hosting the session, which it never starts.
          protectionContext: async () => {
            const serving =
              conversation && entry.sessions.serving(conversation);
            if (!serving)
              throw new Error("The native Goose session is unavailable");
            const { data } = (await serving.process.request(
              "_goose/unstable/session/export",
              { sessionId: serving.sessionId, format: "json" },
              REQUEST_TIMEOUT_MS,
            )) as { data: string };
            return JSON.parse(data);
          },
          relayAuthor: this.relay(agent)?.snapshot().session.relayAuthor,
          signingAuthority: relayKeyOf(
            ownerReads(this.relay(agent), pubkeyOf(agent)),
          ),
          read: (path) => {
            // Relative to where the conversation's session runs. While Buzz
            // reconnects, that is the folder its session started in.
            const cwd =
              (ownerReads(this.relay(agent), pubkeyOf(agent))
                ? this.folder(agent, conversation)
                : conversation && entry.folders.get(conversation)) ||
              entry.config.workspace;
            return handle.protection
              ? readFile(
                  this.desktop.spawn,
                  cwd,
                  path,
                  undefined,
                  handle.protection.processProtection,
                )
              : this.desktop.readFile(path, { cwd });
          },
          memories: (slug) => this.memories(agent, slug),
          remembered: () => this.forget(agent),
        });
      const context = (conversation && entry.contexts.get(conversation)) || {};
      return respond(client, context, message, this.added());
    };
    entry.tools = tools;
    const get = (
      drained?: (process: GooseProcess) => boolean,
    ): Promise<GooseProcess> => {
      const protection = entry.handle?.protection;
      if (!protection) {
        if (entry.protected)
          throw new Error("The protected agent has no live policy binding");
        return entry.goose.get(drained);
      }
      protection.assertAvailable();
      // Another key means a replaced provider, which is already stopping its
      // worker; the replacement starts once every replaced one has exited.
      if (entry.worker && entry.workerKey !== protection.key) {
        entry.stopping = Promise.all([
          entry.stopping,
          entry.worker.shutdown().catch(() => undefined),
        ]).then(() => undefined);
        delete entry.worker;
      }
      entry.workerKey = protection.key;
      entry.worker ??= new AgentProcess(
        this.desktop,
        (handler) => this.serve(handler),
        protection,
        () => entry.handle,
        () => compactAt(entry.config.compactAt),
      );
      const worker = entry.worker;
      const { stopping } = entry;
      // One replaced while this waited is never started: ask for the current.
      return stopping
        ? stopping.then(() =>
            entry.worker === worker ? worker.get(drained) : get(drained),
          )
        : worker.get(drained);
    };
    entry.sessions = new AgentSessions({
      resolveDirectory: (path) => this.desktop.resolveDirectory(path),
      tools,
      process: { get },
      store: localSessions(this.storage, agent),
      started: (session, text, title, conversation) =>
        void this.prompts(agent).save(session, [{ label: "", text }], {
          at: Date.now(),
          title: title ?? "",
          conversation: conversation ?? null,
        }),
      tags: (conversation) => sessionTags(agent, conversation),
      onChange: () => this.notify(),
      // Read as each turn starts, so a change needs no restart.
      choice: () => this.choice(entry),
      // The prompt's other parts, its instructions, team, name, core memory
      // and its conversation's sections, reach a running session in place
      // as its next turn starts. A changed compaction threshold reaches only
      // new sessions, in a goose started with it: open ones keep their
      // history in theirs.
      fingerprint: () =>
        JSON.stringify([
          entry.config.provider.trim() ? 0 : this.defaultsRevision,
          entry.config.workspace,
          entry.config.scope,
          addedKey(this.added()),
        ]),
      launch: (conversation) => this.launch(agent, entry, conversation),
    });
    this.agents.set(agent, entry);
    return entry;
  }

  private choice(entry: Entry) {
    return {
      provider: entry.config.provider.trim(),
      model: entry.config.model.trim(),
      effort: entry.config.effort,
    };
  }
  private async launch(agent: AgentKey, entry: Entry, conversation?: string) {
    const { workspace, instructions, scope } = entry.config;
    const memory = await this.core(agent);
    // A conversation given its own folder starts there, and the folder
    // must still exist; the agent's workspace stays its home.
    const assigned = await this.startFolder(agent, conversation);
    const { resolveDirectory } = this.desktop;
    if (conversation && assigned) entry.folders.set(conversation, assigned);
    const sections = sectionsOf(entry.handle, conversation);
    // What the conversation's session works by once it takes this prompt.
    if (conversation) entry.located.set(conversation, sections);
    const cwd = assigned
      ? await existingFolder(resolveDirectory, assigned)
      : workspace;
    return {
      workspace: cwd,
      systemPrompt: systemPrompt({
        scope,
        cwd,
        ...(assigned ? { workspace: await resolveDirectory(workspace) } : {}),
        repositories: this.repositories(this.relay(agent)?.snapshot().scope),
        ...(entry.name
          ? { agent: { name: entry.name, pubkey: pubkeyOf(agent) } }
          : {}),
        instructions,
        team: entry.team,
        ...(memory === undefined ? {} : { memory }),
        // A conversation's prompt has the sections of the plugin that
        // manages it.
        sections,
        place: placeOf(conversation),
      }),
    };
  }

  /** The agent's memory, or only entry `slug`, as the owner's reads of its
   * community give it: it is encrypted to the owner, so no agent key is
   * needed. */
  private memories(agent: AgentKey, slug?: string) {
    const pubkey = pubkeyOf(agent);
    const reads = ownerReads(this.relay(agent), pubkey);
    if (!reads) return Promise.reject(new Error("Buzz is not connected"));
    return this.memoryReads.read(
      reads,
      pubkey,
      AbortSignal.timeout(READ_TIMEOUT_MS),
      slug,
    );
  }
  private forget(agent: AgentKey) {
    const pubkey = pubkeyOf(agent);
    const reads = ownerReads(this.relay(agent), pubkey);
    if (reads) this.memoryReads.forget(reads.connection, pubkey);
  }
}

type Gateway = Readonly<{ route: EligibleRoute; turn: TurnContext }>;
/** What a forwarded turn runs, past what the gateway and its hold give it. */
type ForwardTurn = Readonly<{
  /** The turn's text, and the created_at of the newest event it shows. */
  prompt(
    fresh: boolean,
  ): Promise<Readonly<{ text: string; shown?: number }> | undefined>;
  title?: string;
  /** The delivery's or control's: it ends the turn's open, and a one-off
   * turn whole. */
  signal?: AbortSignal;
  activity?: ActivityReceipt;
  model?: string;
  effort?: string;
  kept?: string;
}>;

const COMMUNITY_FORWARDING_UNSUPPORTED =
  "Goose cannot use the agent gateway with Community session scope. Choose Thread or Channel scope.";
const NOT_COMPACTED =
  "Couldn't compact: this conversation's session ran through the agent gateway, which this agent's turns don't use now.";
/** goose's error for held work it never ran. */
const STOPPED = "goose was stopped";
/** The most fallback notices an agent keeps, the oldest dropped first. */
const NOTICE_LIMIT = 100;
const LATE = "goose did not start in time";
const NOT_RETIRED =
  "goose didn't stop after a forwarded turn; the agent retires once it has.";
/** A forwarded turn the agent owns, until its retirement is confirmed. */
type Owned = {
  /** Settles once the turn has, retiring as far as it could. */
  ended: Promise<unknown>;
  /** Told its retirement, which it then leaves with. */
  retiring?: boolean;
  failed?: unknown;
};
/** No binding, read as one: `bindSession` refuses it as malformed. */
const MALFORMED = Object.freeze({});

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
