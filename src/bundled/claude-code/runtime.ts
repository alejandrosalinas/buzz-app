// Turns Agents deliveries into Claude turns. Each agent of this type has its
// own sessions; a delivery becomes a prompt in the harness format, sent to the
// session for its conversation; a standalone turn, such as a watch's or a
// timer's, runs as a one-off process. The run returns once the turn is handed over,
// so one agent works in several conversations at once. Claude acts in Buzz with
// the in-process Buzz tools, signed by the agent's native-held key; the runtime
// only reports a turn that fails.
import type { Context } from "../../buzz-mcp/client";
import { RESUMED_PROMPT } from "../../buzz-mcp/prompt";
import { type Listing, respond } from "../../buzz-mcp/rpc";
import {
  type AddedTool,
  addedKey,
  sessionHint,
  turnNote,
} from "../../buzz-mcp/session-tools";
import {
  unsupportedSynced,
  unverifiedSynced,
} from "../../features/agents/agent-config";
import { fromOwner, workflowOf } from "../../features/agents/owner-attestation";
import type { AgentReads } from "../../features/agents/reads";
import { localStore, type AgentStore } from "../../features/agents/store";
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
import { appClient, readFile } from "../../buzz-mcp/app-client";
import {
  MemoryReads,
  READ_TIMEOUT_MS,
  recentNotesSection,
} from "../../features/agent-harness/core-memory";
import { readAuthorNames } from "../../features/agent-harness/author-names";
import { readProject } from "../../features/agent-harness/project";
import { SessionControls } from "../../features/agent-harness/session-control";
import type {
  SessionPlace,
  SessionControlAction,
  SessionState,
} from "../../features/agents/service";
import {
  CONTEXT_LIMIT,
  type Scope,
  steerPrompt,
  systemPrompt,
  turnPrompt,
} from "./prompt";
import { AgentSessions, localSessions, Spare } from "./sessions";
import { protectionHistoryEntry } from "./security";
import {
  readSessionTitle,
  readTranscript,
  type Conversation,
} from "./transcript";
import { sessionPrompts } from "../../features/agents/session-prompts";

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
});

/** A saved session, for the owner's transcript list, with the channel's name
 * and kind when this community lists it. */
export type SavedConversation = Conversation &
  Partial<ChannelLabel> & {
    key: string;
    sessionId: string;
    at: number;
  };

const CONVERSATION_READ_TIMEOUT_MS = 4_000;
const CHAT = [9, 40002];

type Entry = {
  protected?: boolean;
  sessions: AgentSessions;
  config: Config;
  /** The team sections of the latest run; a change restarts idle sessions. */
  team: string;
  /** The agent's name, for its prompt; a rename restarts idle sessions. */
  name?: string;
  /** The agent's handle from its latest delivery, for the tools to act with. */
  handle?: AgentHandle;
  /** Where each conversation's tools default to: its latest turn's thread. */
  contexts: Map<string, Context>;
  /** The project folders each Solo chat's latest turn named, for its process. */
  directories: Map<string, readonly string[]>;
  /** Each conversation's latest posting policy: when its turns were handed
   * over, and when all of them settled. */
  policies: Map<
    string,
    {
      topLevel: boolean;
      handed: Promise<unknown>;
      settled: Promise<unknown>;
      cancel(): void;
    }
  >;
};

/** Where an agent's processes run, and with which model and effort. */
const where = ({ workspace, model, effort }: Config) => ({
  cwd: workspace,
  ...(model.trim() ? { model: model.trim() } : {}),
  ...(effort ? { effort } : {}),
});

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

export class ClaudeRuntime {
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
  /** One process started ahead of need, for any agent's next new conversation. */
  private readonly spare = new Spare(
    (id, options) => this.spawn(id, options),
    (_conversation, message) =>
      respond(undefined, {}, message, this.added(), listing(this.added())),
    undefined,
    () => addedKey(this.added()),
  );

  constructor(
    private readonly host: Pick<Host, "spawn">,
    /** What each agent's turns read of its community, while it can be read. */
    private readonly reads: (key: AgentKey) => AgentReads | undefined,
    /** The agent's `core` memory as the host keeps it (`Agents.core`). */
    private readonly core: Agents["core"],
    private readonly storage: AgentStore = localStore(),
    private readonly resolveConfig: (raw: unknown) => Config = config,
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
  ) {}

  /** The host's own spawn, not a copy: history read with it is kept for it,
   * and shared with the agents' usage. */
  private get spawn(): Spawn {
    const { spawn } = this.host;
    if (!spawn) throw new Error("Claude agents run only in the desktop app");
    return spawn;
  }

  /** Brings the runtime in line with this type's agents: changed settings
   * restart idle sessions, removed agents stop, and a spare waits while any
   * agent is here. */
  private readonly retirements = new Map<string, Promise<void>>();
  async retire(pubkey: string) {
    let retiring = this.retirements.get(pubkey);
    if (!retiring) {
      retiring = (async () => {
        const entry = this.agents.get(pubkey);
        this.agents.delete(pubkey);
        await entry?.sessions.shutdown();
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
      const next = this.resolveConfig(agent.config);
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
    this.spare.warm(
      ...agents
        .filter((agent) => !agent.protection)
        .map((agent) => where(this.resolveConfig(agent.config))),
    );
    this.notify();
  }

  /** The models the agent's next turn can run on, with their effort levels.
   * Without a pick it uses its own: the configured one, or else the one its
   * sessions report. `default` duplicates a listed model, so it is not offered. */
  async models(agent: AgentKey): Promise<Models> {
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
  sessions(agent: AgentKey) {
    let view = this.views.get(agent);
    if (!view) {
      view = this.agents.get(agent)?.sessions.snapshot() ?? [];
      this.views.set(agent, view);
    }
    return view;
  }
  /** The agent's saved sessions, most recently used first. */
  conversations(agent: AgentKey): SavedConversation[] {
    const reads = this.reads(agent);
    return localSessions(this.storage, agent)
      .list()
      .map(([key, saved]) => {
        const [channelId = key, root] = key.split("/");
        return {
          key,
          agent,
          sessionId: saved.id,
          channelId,
          ...(root ? { root } : {}),
          ...reads?.channelLabel(channelId),
          at: saved.at,
        };
      });
  }
  /** A conversation's transcript, found from the workspace it ran in. */
  transcript(
    conversation: Conversation,
    workspace: string,
    working: boolean,
    signal: AbortSignal,
  ) {
    const prompts = this.prompts(conversation.agent);
    return readTranscript(
      this.spawn,
      workspace,
      conversation,
      working,
      signal,
      (pubkey) => this.reads(conversation.agent)?.name(pubkey),
    ).then(
      (transcript) =>
        transcript && { ...transcript, turns: prompts.shown(transcript.turns) },
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
  ): Promise<SavedConversation | undefined> {
    const transcript = await readTranscript(
      this.spawn,
      workspace,
      { agent, ...place },
      false,
      signal,
    );
    const last = transcript?.turns.at(-1);
    if (!last?.sessionId) return undefined;
    return {
      key: place.root ? `${place.channelId}/${place.root}` : place.channelId,
      agent,
      sessionId: last.sessionId,
      ...place,
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
    return config(agent.config).scope === "channel" || !place.root
      ? place.channelId
      : `${place.channelId}/${place.root}`;
  }
  sessionState(agent: Agent, place: SessionPlace): SessionState {
    const key = this.controlKey(agent, place);
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
  ) {
    const key = this.controlKey(agent, place);
    const control = `${agent.key}/${key}`;
    const entry = this.entry(agent, config(agent.config));
    if (action === "interrupt") {
      this.controls.interrupt(control);
      entry.policies.get(key)?.cancel();
      await entry.sessions.interrupt(key);
      return;
    }
    if (this.sessionState(agent, place) !== "idle")
      throw new Error("Wait for the active turn to finish first.");
    return this.controls.run(control, action, async (signal) => {
      signal.throwIfAborted();
      if (action === "new") await entry.sessions.forget(key);
      else {
        const result = await entry.sessions.compact(key);
        if (!result.ok) throw new Error(result.error);
      }
      signal.throwIfAborted();
    });
  }

  dispose() {
    this.spare.dispose();
    for (const entry of this.agents.values()) entry.sessions.dispose();
    this.agents.clear();
  }

  async run({
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
    superseded,
    interruptible,
    named,
  }: Delivery) {
    const settings = this.resolveConfig(raw);
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
    if (
      trigger.type === "mention" &&
      !(await fromOwner(
        trigger.event,
        agent.owner,
        workflowOf(this.reads(agent.key), agent.pubkey),
      ))
    ) {
      ignored?.();
      return;
    }
    signal.throwIfAborted();
    const entry = this.entry(agent, settings);
    entry.handle = agent;
    entry.team = team ?? "";
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
    const key = await this.key(entry, agent, event, channel, topLevel);
    signal.throwIfAborted();
    const handoff = this.controls.deliver(
      `${agent.key}/${key}`,
      async (deferred) => {
        // Accepted deferred work belongs to the captured agent lifetime, not
        // the short deadline for handing a message to the harness.
        if (this.agents.get(agent.key) !== entry) return;
        if (!deferred) signal.throwIfAborted();
        // `fresh` is for a session that has been shown nothing yet.
        const prompt = async (fresh: boolean) => {
          const turn = await this.turn(
            entry,
            agent,
            event,
            channel,
            key,
            topLevel,
            fresh,
            solo,
          );
          const text = turnPrompt({
            ...turn,
            agent: agent.key,
            channelLevel: topLevel && !solo,
            ...(wake
              ? { wake: { ...wake, text: (await wakeText?.()) ?? wake.text } }
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
        // A turn keeps the posting policy it was admitted with: a request under
        // the other policy waits for the conversation's turns to settle rather
        // than steering into them and changing their tools' context.
        const prior = entry.policies.get(key);
        const same = prior?.topLevel === topLevel;
        const wait = prior && (same ? prior.handed : prior.settled);
        let delivered!: Promise<Settled>;
        let interrupted = false;
        const handed = (async () => {
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
          // Plugins' notes wait until the turn is handed over, so one that
          // fails or is cancelled before then leaves them for the next.
          const noteRoot =
            key === channel
              ? undefined
              : (threadReference(event)?.rootId ?? event.id);
          const notes = agent.notes?.(channel, noteRoot) ?? [];
          const text = this.review(entry, prepared, notes);
          // A conversation's tools default to its thread; a session shared by
          // several threads is told which to reply in instead.
          entry.contexts.set(
            key,
            topLevel
              ? { channel, ...(solo ? { topLevel } : {}) }
              : key === channel
                ? { channel }
                : { channel, root: threadReference(event)?.rootId ?? event.id },
          );
          delivered = entry.sessions.deliver(key, text, event.created_at, {
            current: () => !interrupted && (!current || current()),
            ...(wake
              ? {
                  refresh: async (fresh = false) => {
                    const text = this.review(
                      entry,
                      (await prompt(fresh)).text,
                      notes,
                    );
                    return text;
                  },
                }
              : {}),
            steer: steerPrompt(text),
            fresh: async () =>
              this.review(entry, (await prompt(true)).text, notes),
            ...(contextRoot ? { contextRoot } : {}),
            activityScope: topLevel
              ? channel
              : (threadReference(event)?.rootId ?? event.id),
            ...(step ? { step } : {}),
            ...(acknowledged ? { acknowledged } : {}),
            ...(superseded ? { superseded } : {}),
            pick: {
              ...(model ? { model } : {}),
              ...(effort ? { effort } : {}),
            },
            admit,
          });
          void delivered.then(
            (result) => {
              if (result.undelivered)
                agent.restoreNotes?.(channel, notes, noteRoot);
            },
            () => undefined,
          );
        })();
        const done = handed.then(
          () => delivered,
          (error: unknown): Settled => ({ ok: false, error: String(error) }),
        );
        const policy = {
          topLevel,
          cancel() {
            interrupted = true;
            prior?.cancel();
          },
          handed: handed.catch(() => undefined),
          settled: Promise.all([same ? prior.settled : undefined, done]).then(
            () => undefined,
          ),
        };
        entry.policies.set(key, policy);
        void policy.settled.then(() => {
          if (entry.policies.get(key) === policy) entry.policies.delete(key);
        });
        // Deliveries keep their order: a later one waits on this handover, and
        // one with nothing to wait for is handed over before `run` returns.
        if (!wait) await handed;
        // The turn outlives `run`, which the host is told so it shows it as working.
        workingUntil(done);
        interruptible?.(() => {
          interrupted = true;
          return entry.sessions.interrupt(key);
        });
        this.notify();
        this.watch(done, async (error) => {
          if (error) await this.report(agent, channel, event, error, topLevel);
        });
        if (solo && named)
          void this.offerTitle(done, agent.key, key, settings.workspace, named);
      },
    );
    if (!handoff.deferred) return handoff.done;
    workingUntil(handoff.done);
    void handoff.done
      .catch((error) =>
        this.report(agent, channel, event, String(error), topLevel),
      )
      .catch((error) => console.warn("Claude handover failed", error));
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
      const session = localSessions(this.storage, agent).get(key)?.id;
      if (!session || signal.aborted) return;
      try {
        const title = await readSessionTitle(
          this.spawn,
          workspace,
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

  /** Runs a standalone turn, such as a watch's or a timer's, as a one-off
   * process: a new session that is not saved. */
  async runOnce({
    delivery,
    key,
    signal,
    prompt,
  }: StandaloneTurn): Promise<TurnResult> {
    const { agent, team } = delivery;
    const entry = this.entry(agent, this.resolveConfig(delivery.config));
    entry.handle = agent;
    entry.team = team ?? "";
    const refused = await this.refusal(agent.key, delivery.synced?.effort);
    if (refused) return { ok: false, error: refused };
    const done = entry.sessions.runOnce(key, prompt, signal);
    this.notify();
    return done.finally(() => this.notify());
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
   * end-of-turn note, when there are any. */
  private review(entry: Entry, text: string, notes: readonly string[] = []) {
    return [text, ...notes, turnNote(entry.handle)]
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
  ) {
    return agent
      .publish({
        kind: 9,
        content: `⚠️ I couldn't finish that: ${error.slice(0, 500)}`,
        tags: [
          ["h", channel],
          ...(topLevel
            ? []
            : [["e", threadReference(event)?.rootId ?? event.id, "", "reply"]]),
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
    entry: Entry,
    agent: Pick<Agent, "key">,
    event: EventData,
    channelId: string,
    topLevel: boolean,
  ) {
    const summary = await this.reads(agent.key)?.channel(channelId);
    return topLevel || summary?.dm === true || entry.config.scope === "channel"
      ? channelId
      : `${channelId}/${threadReference(event)?.rootId ?? event.id}`;
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
  ) {
    const reads = this.reads(agent.key);
    const summary = await reads?.channel(channelId);
    const dm = summary?.dm === true;
    const thread = threadReference(event);
    const rootId = thread?.rootId ?? event.id;
    // The conversation it was admitted to, not the scope as it is now.
    const scope: Scope = key === channelId ? "channel" : "thread";
    // Sharing a session does not mean it has seen every thread in the channel.
    const contextRoot =
      scope === "channel" && !dm && !topLevel ? rootId : undefined;
    const seen = fresh ? 0 : entry.sessions.seen(key, contextRoot);
    // Read alongside the conversation: only a Solo chat's Canvas is handed over.
    const canvas = reads?.canvas?.bind(reads);
    const owner = entry.handle?.owner;
    const reading = solo
      ? readProject(
          canvas && owner ? () => canvas(channelId, owner) : undefined,
        )
      : Promise.resolve(undefined);
    let earlier: readonly EventData[] = [];
    // A chat its owner is still creating has nothing earlier to read.
    if (reads && !summary?.starting && (thread || dm || topLevel))
      try {
        const events = await reads.read(
          thread && !topLevel
            ? [
                { ids: [rootId], "#h": [channelId], limit: 1 },
                { kinds: CHAT, "#h": [channelId], "#e": [rootId], limit: 200 },
              ]
            : [{ kinds: CHAT, "#h": [channelId], limit: CONTEXT_LIMIT + 1 }],
          AbortSignal.timeout(CONVERSATION_READ_TIMEOUT_MS),
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
      } catch (error) {
        console.warn("Claude could not read the conversation", error);
      }
    // A session already has its own replies; a new one is shown them too.
    const unseen = earlier.filter(
      (item) =>
        item.created_at > seen && (!seen || item.pubkey !== agent.pubkey),
    );
    const signingAuthority = reads?.workflowAuthority();
    const [names, project] = await Promise.all([
      readAuthorNames(
        reads,
        [event, ...unseen.slice(-CONTEXT_LIMIT)],
        signingAuthority,
      ),
      reading,
    ]);
    // An unread Canvas keeps the folders the chat had, not restarting it.
    if (project?.directories.length)
      entry.directories.set(key, project.directories);
    else if (project) entry.directories.delete(key);
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
      contextRoot,
      total: earlier.length + 1,
      names,
      ...(signingAuthority ? { signingAuthority } : {}),
      ...(project?.section ? { project: project.section } : {}),
    };
  }

  /** Its entry, made with the agent's protection however it is first used,
   * so a protected agent never launches unprotected before `sync`. */
  private entry(
    {
      key: agent,
      protection,
    }: Readonly<{ key: AgentKey; protection?: unknown }>,
    initial: Config,
  ): Entry {
    if (this.retirements.has(agent))
      throw new Error("This agent’s previous native sessions have not retired");
    const existing = this.agents.get(agent);
    if (existing) return existing;
    const entry: Entry = {
      protected: !!protection,
      config: initial,
      team: "",
      sessions: undefined as unknown as AgentSessions,
      contexts: new Map(),
      policies: new Map(),
      directories: new Map(),
    };
    // Each process reads files where it was started, and keeps the tool list
    // it was given, until it is replaced.
    const tools =
      (cwd: string): ToolServer =>
      async (conversation, message, signal) => {
        const handle = entry.handle;
        const client =
          handle &&
          appClient(handle, {
            // Its PreToolUse hook reviews every tool, Buzz's included.
            nativeToolGate: true,
            protectionContext: async () => {
              if (!conversation)
                throw new Error(
                  "The native Claude conversation is unavailable",
                );
              return entry.sessions.protectionContext(conversation);
            },
            relayAuthor: this.reads(agent)?.relayAuthor?.(),
            signingAuthority: this.reads(agent)?.workflowAuthority(),
            read: (path) =>
              readFile(
                this.spawn,
                cwd,
                path,
                undefined,
                handle.protection?.processProtection,
              ),
            memories: (slug) => this.memories(agent, slug),
            remembered: () => this.forget(agent),
            signal,
          });
        const context =
          (conversation && entry.contexts.get(conversation)) || {};
        return respond(
          client,
          context,
          message,
          this.added(),
          listing(this.added()),
        );
      };
    const saved = localSessions(this.storage, agent);
    entry.sessions = new AgentSessions({
      spawn: (id, options) => this.spawn(id, options),
      spare: this.spare,
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
      started: (session, text) =>
        void this.prompts(agent).save(session, [{ label: "", text }]),
      onChange: () => this.notify(),
      fingerprint: (key) =>
        JSON.stringify([
          key ? (entry.directories.get(key) ?? []) : [],
          entry.config.model,
          entry.config.effort,
          entry.config.workspace,
          entry.config.instructions,
          entry.config.scope,
          entry.team,
          entry.name,
          addedKey(this.added()),
        ]),
      launch: async (key) => {
        const { workspace, instructions, scope } = entry.config;
        const gate = entry.handle?.protection;
        if (entry.protected && !gate)
          throw new Error("The protected agent has no live policy binding");
        gate?.assertAvailable();
        // Read once per process: a new note doesn't restart a session, and a
        // slow read starts it without them.
        const [memory, notes] = await Promise.all([
          this.core(agent),
          recentNotesSection((slug) =>
            this.memories(agent, slug, AbortSignal.timeout(NOTES_WAIT_MS)),
          ),
        ]);
        const directories = key ? entry.directories.get(key) : undefined;
        return {
          ...where(entry.config),
          ...(gate
            ? {
                protection: {
                  gate,
                  history: async (path: string, signal: AbortSignal) => {
                    const bytes = await readFile(
                      this.spawn,
                      workspace,
                      path,
                      signal,
                      gate.processProtection,
                    );
                    const lines = new TextDecoder().decode(bytes).split("\n");
                    // Claude appends to its transcript as it goes, so the last
                    // line may still be partial; the next hook reads it whole.
                    const last = lines.pop() ?? "";
                    const rows = lines
                      .filter((line) => line.trim())
                      .map((line) => JSON.parse(line) as unknown);
                    try {
                      if (last.trim()) rows.push(JSON.parse(last));
                    } catch {}
                    return rows.map(protectionHistoryEntry);
                  },
                },
              }
            : {}),
          ...(directories ? { directories } : {}),
          hook: (session, event, input) =>
            this.hook(agent, session, event, input),
          tools: tools(workspace),
          systemPrompt: systemPrompt({
            scope,
            cwd: workspace,
            repositories: this.repositories(this.reads(agent)?.scope),
            ...(entry.name
              ? { agent: { name: entry.name, pubkey: pubkeyOf(agent) } }
              : {}),
            instructions,
            team: entry.team,
            ...(memory === undefined ? {} : { memory }),
            notes,
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
