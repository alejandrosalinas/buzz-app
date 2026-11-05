// Turns Agents deliveries into Pi turns. Every Pi agent here runs in the one
// Pi host (pi.ts), each with its own Pi durable storage, where each Buzz
// conversation is one Pi conversation. A delivery becomes a prompt in the
// harness format, submitted to its conversation; one that arrives while Pi
// works steers the run. A watch or timer runs as a standalone turn
// (`runOnce`), in a one-off conversation. Pi acts in Buzz with the in-process
// Buzz tools, signed by the agent's native-held key. The runtime reports a
// turn that fails; what Pi writes without `send` stays in local activity.
import { isFinalMessage } from "../../buzz-mcp/session-tools";
import { appClient, readFile } from "../../buzz-mcp/app-client";
import type { Context } from "../../buzz-mcp/client";
import { content, errorText } from "../../buzz-mcp/rpc";
import {
  type AddedTool,
  callSessionTool,
  sessionHint,
  sessionTools,
  turnNote,
} from "../../buzz-mcp/session-tools";
import {
  wakeAnchor,
  wakeLands,
} from "../../features/agent-harness/plugin-wake";
import { SessionControls } from "../../features/agent-harness/session-control";
import {
  coreMemorySection,
  MemoryReads,
  READ_TIMEOUT_MS,
} from "../../features/agent-harness/core-memory";
import { readAuthorNames } from "../../features/agent-harness/author-names";
import { readProject } from "../../features/agent-harness/project";
import { fromOwner, workflowOf } from "../../features/agents/owner-attestation";
import { type AgentKey, pubkeyOf } from "../../features/agents/membership";
import { sessionPrompts } from "../../features/agents/session-prompts";
import { localStore, type AgentStore } from "../../features/agents/store";
import type { AgentReads } from "../../features/agents/reads";
import type {
  Agent,
  AgentHandle,
  Agents,
  AgentSession,
  Delivery,
  Models,
  SessionControlAction,
  SessionPlace,
  SessionState,
  StandaloneTurn,
  TurnResult,
} from "../../features/agents/service";
import type { Host } from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import type { ChannelLabel } from "../../features/channels/channel-icon";
import { threadReference } from "../../features/relay/thread-reference";
import {
  CONTEXT_LIMIT,
  type Scope,
  steerPrompt,
  systemPrompt,
  turnPrompt,
} from "../claude-code/prompt";
import { effortLabel } from "../claude-code/runtime";
import {
  Pi,
  type PiEvent,
  PiStopped,
  type ToolCall,
  type ToolResult,
} from "./pi";
import { DEFAULT_THINKING, PiSetup, runsAt } from "./setup";
import { readTranscript } from "./transcript";
import { readUsage } from "./usage";

export type Config = Readonly<{
  /** A Pi provider; empty uses the one Pi's settings name. */
  provider: string;
  /** One of the provider's models; empty uses the one Pi's settings name. */
  model: string;
  /** A thinking level the model has; empty uses the one Pi's settings name. */
  effort: string;
  instructions: string;
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  /** Whether each thread is its own conversation, or the whole channel is one. */
  scope: Scope;
}>;
export const DEFAULT_CONFIG: Config = Object.freeze({
  provider: "",
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

const CONVERSATION_READ_TIMEOUT_MS = 4_000;
/** How long an adopted run's mention is looked for. */
const READ_MS = 10_000;
const CHAT = [9, 40002];
/** Starts a plugin wake's request, which no relay event's id does, so a run
 * an earlier app left is known as a wake's. */
const WAKE = "plugin/";

/** Where a mention's turn replies: its thread, or the top of a Solo chat. */
type Where = Readonly<{ channel: string; root: string; topLevel: boolean }>;
const replyTags = ({ channel, root, topLevel }: Where) => [
  ["h", channel],
  ...(topLevel ? [] : [["e", root, "", "reply"]]),
];
/** A Buzz thread or channel the agent has a Pi conversation for, with the
 * channel's name and kind once `channelLabel` has added them. */
export type Place = Readonly<
  Partial<ChannelLabel> & {
    key: string;
    conversation: number;
    channelId: string;
    root?: string;
    /** When the newest message it was shown was sent. */
    at: number;
  }
>;
/** How a request settled in Pi: answered, unanswered and why, or not yet,
 * because the agent was closed and its run waits to continue. */
type Waited =
  | { status: "done"; answer: number; text: string }
  | { status: "unanswered"; reason?: string; detail?: string }
  | { status: "closed" };
type Receipt = Pick<Delivery, "step" | "acknowledged" | "superseded"> & {
  /** Its conversation key, which session controls act on. */
  key: string;
  /** Where its activity shows: a thread, or a Solo chat's channel. */
  scope: string;
  /** Where a run's failure for it is reported. */
  where: Where;
  /** A recovered turn holds its posting policy until its run settles. */
  settled?: Promise<void>;
  /** An Attention prompt rebuilt when the host is ready to submit. */
  prompt?: () => Promise<{ text: string; steer: string } | undefined>;
};

type Entry = {
  config: Config;
  /** The team sections of the latest run. */
  team: string;
  name?: string;
  /** The agent's handle from its latest delivery, for the tools to act with. */
  handle?: AgentHandle;
  /** Each conversation's latest posting policy, as in Claude: when its turns
   * were handed over, and when all of them settled. Interrupt cancels the
   * handovers still pending. */
  policies: Map<
    string,
    {
      topLevel: boolean;
      handed: Promise<unknown>;
      settled: Promise<unknown>;
      cancel(): void;
    }
  >;
  /** Mentions handed to Pi and not settled, by request. */
  receipts: Map<string, Receipt>;
  /** Requests waited for here without a receipt: standalone turns handed to
   * Pi and not settled, and plugin wakes a left run continues. */
  standalone: Set<string>;
  /** The request each conversation's activity shows, by its scope. */
  active: Map<number, Map<string, Receipt>>;
  /** The latest taking-on of the runs Pi's storage holds that nothing here
   * waits for; absent until the agent opens here, or after one failed. */
  adopted?: Promise<void>;
  /** A turn stopped waiting for a run still unfinished in Pi's storage, so
   * the next one takes on its left runs again. */
  abandoned?: boolean;
  /** The agent was removed: its turns wait in its storage. */
  closed: boolean;
};

/** A turn Pi took, in which conversation, and the session it starts there
 * when it is that session's first turn. */
type Delivered = {
  submission: number;
  conversation: number;
  session?: number;
};

export class PiRuntime {
  private readonly agents = new Map<AgentKey, Entry>();
  private readonly revisions = new Map<AgentKey, number>();
  private readonly memoryReads = new MemoryReads();
  private readonly controls = new SessionControls(() => this.notify());
  private readonly listeners = new Set<() => void>();
  /** Each agent's working conversations, as last read, for a stable view. */
  private readonly views = new Map<AgentKey, readonly number[]>();
  /** The agents of this type that run here now. */
  private running = new Set<AgentKey>();
  /** Agents with a protection binding, which never use the shared host. */
  private bound = new Set<AgentKey>();
  /** Each agent's conversations as Pi's storage and this app run's
   * deliveries know them, by key; read from storage once, when first asked. */
  private readonly known = new Map<
    AgentKey,
    Map<string, { conversation: number; at: number }>
  >();

  /** The Pi host every agent of this type runs in, started when needed. */
  private readonly pi: Pi;
  readonly setup: PiSetup;

  constructor(
    private readonly host: Pick<Host, "spawn" | "readFile">,
    /** What each agent's turns read of its community, while it can be read. */
    private readonly reads: (key: AgentKey) => AgentReads | undefined,
    /** The agent's `core` memory as the host keeps it (`Agents.core`). */
    private readonly core: Agents["core"],
    /** The tools plugins add to every conversation now. */
    private readonly added: () => readonly AddedTool[] = () => [],
    /** Desktop-local repository instructions; standalone hosts keep their own layout. */
    private readonly repositories: (scope: string | undefined) => string = () =>
      "",
    /** The agent as a run holds it, outside any run (`Agents.handle`). */
    private readonly handle: (key: AgentKey) => AgentHandle | undefined = () =>
      undefined,
    private readonly hook?: (
      agent: string,
      session: string,
      event: string,
      input: unknown,
    ) => Promise<unknown>,
    /** Tells when the owner's connection to the agent's community may have
     * changed, so `reads` may answer with another (`Agents.relay(key)?.subscribe`). */
    private readonly subscribeRelay: (
      key: AgentKey,
      listener: () => void,
    ) => () => void = () => () => {},
    /** Agent storage, where what each session started with is kept. */
    private readonly storage: AgentStore = localStore(),
  ) {
    this.pi = new Pi(
      () => this.spawn,
      {
        tool: (call, signal) => this.tool(call, signal),
        hook: (call) => {
          if (!this.agents.has(call.agent))
            throw new Error("Pi hook agent is no longer active");
          return (
            this.hook?.(
              call.agent,
              String(call.conversation),
              call.event,
              call.input,
            ) ?? Promise.resolve(null)
          );
        },
        event: (event) => this.event(event),
        prompt: ({ agent, request }) =>
          this.agents.get(agent)?.receipts.get(request)?.prompt?.() ??
          Promise.resolve(undefined),
      },
      (pubkey) => {
        const protection = (
          this.agents.get(pubkey)?.handle ?? this.handle(pubkey)
        )?.protection;
        if (!protection && this.bound.has(pubkey))
          throw new Error("The agent isn't connected yet. Try again shortly.");
        return protection;
      },
    );
    this.setup = new PiSetup(this.pi);
  }

  async retire(pubkey: string) {
    const entry = this.agents.get(pubkey);
    if (entry) {
      entry.closed = true;
    }
    this.agents.delete(pubkey);
    await this.pi.retire(pubkey);
  }

  /** Brings the runtime in line with this type's agents. A removed one's
   * storage closes; its unfinished runs continue when it is back. */
  sync(agents: readonly Agent[]) {
    const current = new Set(agents.map((agent) => agent.key));
    // Its storage may be open for a turn or only for listing its sessions.
    for (const agent of new Set([...this.running, ...this.agents.keys()]))
      if (!current.has(agent)) void this.retire(agent).catch(() => undefined);
    this.running = current;
    this.bound = new Set(
      agents.filter((agent) => agent.protection).map((agent) => agent.key),
    );
    for (const agent of agents) {
      const revision = agent.protectionRevision ?? 0;
      const previous = this.revisions.get(agent.key);
      this.revisions.set(agent.key, revision);
      if (previous !== undefined && previous !== revision) {
        void this.retire(agent.key).catch(() => undefined);
        continue;
      }
      const entry = this.agents.get(agent.key);
      if (!entry) continue;
      entry.config = config(agent.config);
      entry.name = agent.name;
    }
  }

  /** The models of the agent's provider, with the thinking levels each has.
   * Without a pick, a turn runs the configured model and level. */
  async models(agent: Agent<Config>): Promise<Models> {
    const { provider, model, effort } = config(agent.config);
    const defaults = await this.setup.defaults();
    const id = provider || defaults.provider;
    if (!id) return { current: "", models: [] };
    const listed = await this.setup.models(id);
    const level = effort || defaults.thinking || DEFAULT_THINKING;
    return {
      current:
        model || (id === defaults.provider ? (defaults.model ?? "") : ""),
      models: listed.map((item) => ({
        id: item.id,
        label: item.label,
        efforts: item.thinking.map((id) => ({ id, label: effortLabel(id) })),
        effort: runsAt(item.thinking, level),
      })),
    };
  }

  /** The agent's Buzz conversations, most recently active first. */
  async places(agent: AgentKey): Promise<Place[]> {
    const { places } = await this.pi.request<{
      places: { key: string; conversation: number; seen: number }[];
    }>("places", { agent });
    if (!this.known.has(agent)) this.known.set(agent, new Map());
    let changed = false;
    for (const { key, conversation, seen } of places)
      changed = this.remember(agent, key, conversation, seen) || changed;
    if (changed) this.notify();
    return places
      .map(({ key, conversation, seen }) => {
        const [channelId = key, root] = key.split("/");
        return {
          key,
          conversation,
          channelId,
          ...(root ? { root } : {}),
          at: seen * 1000,
        };
      })
      .sort((a, b) => b.at - a.at);
  }
  /** The community's current name and kind for a place's channel, if it
   * lists the channel; `subscribeChannels` tells when that may change. Read
   * when shown, not with `places`, so a channel going private shows so at
   * once. */
  channelLabel(agent: AgentKey, channelId: string) {
    return this.reads(agent)?.channelLabel(channelId);
  }
  /** Tells `listener` when `channelLabel` may answer differently: the
   * community's channel list changed, or the connection it is read through
   * did, which brings another list. The listener follows that connection as
   * it comes, goes and is replaced. */
  subscribeChannels(agent: AgentKey, listener: () => void) {
    let reads = this.reads(agent);
    let stop = reads?.subscribeChannels(listener);
    const stopFollowing = this.subscribeRelay(agent, () => {
      const current = this.reads(agent);
      if (current?.connection === reads?.connection) return;
      stop?.();
      reads = current;
      stop = current?.subscribeChannels(listener);
      listener();
    });
    return () => {
      stop?.();
      stopFollowing();
    };
  }
  /** The agent's conversations, most recently active first, with whether
   * each is working while it runs here. The first call reads them from Pi's
   * storage, and tells subscribers when they are in. */
  sessions(agent: AgentKey): AgentSession[] {
    const known = this.known.get(agent);
    // Reading opens its storage, which only an agent running here may hold.
    if (!known && !this.running.has(agent)) return [];
    if (!known) {
      this.known.set(agent, new Map());
      // One that failed is read again when next asked.
      void this.places(agent).catch((error) => {
        if (!this.known.get(agent)?.size) this.known.delete(agent);
        console.warn("Pi could not list an agent's conversations", error);
      });
      return [];
    }
    const entry = this.agents.get(agent);
    return [...known]
      .sort(([, a], [, b]) => b.at - a.at)
      .map(([key, { conversation, at }]) => {
        const [channelId = key, root] = key.split("/");
        return {
          channelId,
          ...(root && { root }),
          at,
          ...(entry && {
            status: entry.active.has(conversation) ? "Working" : "Idle",
          }),
        };
      });
  }
  /** The usage of the agent's Buzz conversations since `since`. */
  async usage(agent: AgentKey, since: number, signal: AbortSignal) {
    // Reading opens its storage, which only an agent running here may hold.
    if (!this.running.has(agent)) return [];
    return readUsage(this.pi, agent, await this.places(agent), since, signal);
  }
  /** The conversations a Buzz request of the agent's is working in. */
  working(agent: AgentKey) {
    let view = this.views.get(agent);
    if (!view) {
      view = [...(this.agents.get(agent)?.active.keys() ?? [])];
      this.views.set(agent, view);
    }
    return view;
  }
  transcript(
    agent: AgentKey,
    place: Place,
    working: boolean,
    signal: AbortSignal,
  ) {
    return readTranscript(this.pi, agent, place, working, signal, (pubkey) =>
      this.reads(agent)?.name(pubkey),
    ).then((transcript) => ({
      ...transcript,
      turns: this.prompts(agent).shown(transcript.turns),
    }));
  }
  /** What each of the agent's sessions started with, by
   * `conversation:session`. */
  private prompts(agent: AgentKey) {
    return sessionPrompts(this.storage, "pi", agent);
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

  /** A conversation is active from a delivery's handover, or a left run's
   * taking-on, until its run settles: Interrupt reaches both. */
  sessionState(agent: Agent, place: SessionPlace): SessionState {
    const key = controlKey(agent, place);
    const control = `${agent.key}/${key}`;
    if (this.controls.compacting(control)) return "compacting";
    const receipts = this.agents.get(agent.key)?.receipts.values() ?? [];
    return this.controls.active(control) ||
      [...receipts].some((receipt) => receipt.key === key)
      ? "active"
      : "idle";
  }
  async session(
    agent: Agent,
    place: SessionPlace,
    action: SessionControlAction,
  ) {
    const key = controlKey(agent, place);
    const control = `${agent.key}/${key}`;
    // Pi continues every run once asked anything: its left runs are taken on
    // first, and reporting their failures needs the agent's handle.
    const act = async (signal?: AbortSignal) => {
      const handle =
        this.agents.get(agent.key)?.handle ?? this.handle(agent.key);
      if (!handle)
        throw new Error("The agent isn't connected yet. Try again shortly.");
      const entry = this.entry(handle, config(agent.config));
      entry.handle ??= handle;
      await this.open(agent.key);
      await this.adopted(entry, agent.key);
      // An Interrupt while this prepared, or a left run just taken on here,
      // stops a Compact or New: both act only on an idle conversation.
      if (signal) {
        signal.throwIfAborted();
        if ([...entry.receipts.values()].some((taken) => taken.key === key))
          throw new Error("Wait for the active turn to finish first.");
      }
      await this.pi.request("session", { agent: agent.key, key, action });
    };
    if (action === "interrupt") {
      this.controls.interrupt(control);
      const entry = this.agents.get(agent.key);
      entry?.policies.get(key)?.cancel();
      return act();
    }
    if (this.sessionState(agent, place) !== "idle")
      throw new Error("Wait for the active turn to finish first.");
    return this.controls.run(control, action, async (signal) => {
      signal.throwIfAborted();
      await act(signal);
    });
  }

  dispose() {
    for (const entry of this.agents.values()) {
      entry.closed = true;
    }
    this.agents.clear();
    void this.pi.dispose();
  }

  async run({
    trigger,
    agent,
    config: raw,
    channelId,
    model,
    effort,
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
  }: Delivery) {
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
    // Only an Attention wake refreshes its Interest's instructions as Pi takes
    // it, and keeps its own destination for a failure recovered after a stop.
    const attention = wake?.type === "attention";
    // Pi runs commands as you; mentions need owner or delegated authority.
    if (
      trigger.type === "mention" &&
      !(await fromOwner(
        trigger.event,
        agent.owner,
        workflowOf(this.reads(agent.key), agent.pubkey),
      ))
    )
      return ignored?.();
    signal.throwIfAborted();
    const entry = this.entry(agent, config(raw));
    entry.handle = agent;
    entry.team = team ?? "";
    const event =
      trigger.type !== "mention" ? wakeAnchor(trigger) : trigger.event;
    const channel = channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1];
    if (!channel) return;
    const solo =
      (await this.reads(agent.key)?.soloChat(agent.owner, channel, signal)) ??
      false;
    const topLevel = solo || wake?.topLevel === true;
    if (wake && !wakeLands(wake, topLevel)) return ignored?.();
    // Frozen with the policy: a scope change while this waits must not move
    // its prompt to another conversation than the one it is delivered to.
    const key = await this.key(entry, agent.key, event, channel, topLevel);
    const root = threadReference(event)?.rootId ?? event.id;
    const where = { channel, root, topLevel };
    // A turn keeps the posting policy it was admitted with: a request under
    // the other policy waits for the conversation's turns to settle rather
    // than steering into them and changing their tools' context.
    const prior = entry.policies.get(key);
    const same = prior?.topLevel === topLevel;
    const wait = prior && (same ? prior.handed : prior.settled);
    const request = wake?.type === "plugin" ? `${WAKE}${wake.id}` : event.id;
    let submitted: Delivered | false | undefined;
    // A delivery during a session action waits for it, past its handover.
    const control = `${agent.key}/${key}`;
    let interrupted = false;
    const handoff = this.controls.deliver(control, async () => {
      await wait;
      if (interrupted || (wake && current && !current())) return;
      this.live(entry, agent.key);
      await this.open(agent.key);
      await this.adopted(entry, agent.key, { current: request });
      await Promise.all(
        [...entry.receipts.values()]
          .filter(
            (receipt) =>
              receipt.key === key && receipt.where.topLevel !== topLevel,
          )
          .map((receipt) => receipt.settled),
      );
      this.live(entry, agent.key);
      if (interrupted || (wake && current && !current())) return;
      const { seen } = await this.pi.request<{ seen: number }>("place", {
        agent: agent.key,
        key,
      });
      const prompt = async () =>
        this.review(
          entry,
          turnPrompt({
            ...(await this.turn(
              agent,
              event,
              channel,
              key,
              topLevel,
              seen,
              solo,
            )),
            agent: agent.key,
            channelLevel: topLevel && !solo,
            ...(wake
              ? { wake: { ...wake, text: (await wakeText?.()) ?? wake.text } }
              : {}),
          }),
        );
      // A conversation's tools default to its thread; a conversation shared
      // by several threads is told which to reply in instead.
      const context: Context = topLevel
        ? { channel, ...(solo ? { topLevel } : {}) }
        : key === channel
          ? { channel }
          : { channel, root };
      // Known before Pi has it, as it can say it joined a run first.
      entry.receipts.set(request, {
        key,
        scope: topLevel ? channel : root,
        where,
        ...(attention
          ? {
              prompt: async () => {
                const text = await prompt();
                return !interrupted && (!current || current())
                  ? { text, steer: steerPrompt(text) }
                  : undefined;
              },
            }
          : {}),
        ...(step ? { step } : {}),
        ...(acknowledged ? { acknowledged } : {}),
        ...(superseded ? { superseded } : {}),
      });
      const picked = await this.turnOf(entry, agent.key, model, effort);
      const text = await prompt();
      this.live(entry, agent.key);
      if (interrupted || (wake && current && !current())) return;
      submitted = await this.deliver(
        entry,
        agent.key,
        {
          agent: agent.key,
          key,
          at: event.created_at,
          context,
          text,
          steer: steerPrompt(text),
          request,
          ...(attention ? { reply: where, refresh: true } : {}),
          ...picked,
        },
        () => !interrupted && (!wake || !current || current()),
      );
      if (!submitted) return;
      if (submitted.session !== undefined)
        void this.prompts(agent.key).save(
          `${submitted.conversation}:${submitted.session}`,
          [
            { label: "instructions", text: picked.instructions },
            { label: "core memory", text: picked.core?.text ?? "" },
          ],
        );
      if (
        this.remember(agent.key, key, submitted.conversation, event.created_at)
      )
        this.notify();
    });
    const handed = handoff.done;
    const settled = handed
      .then(async (): Promise<TurnResult & { stopped?: true }> => {
        // Interrupted before Pi had it, it says nothing.
        if (!submitted) return { ok: true };
        const waited = await this.settle(
          entry,
          agent.key,
          submitted.submission,
          attention ? request : undefined,
        );
        // An answer Pi wrote without `send` stays in local activity.
        if (waited.status === "done") return { ok: true };
        // A turn the owner stopped, or a removed agent's, says nothing more.
        // A run that finished before the stop took effect is done, above.
        if (waited.status === "closed") return { ok: true };
        return waited.reason === "aborted"
          ? { ok: true, stopped: true }
          : { ok: false, error: unanswered(waited) };
      })
      .catch(
        (error: unknown): TurnResult => ({
          ok: false,
          error: errorText(error),
        }),
      )
      .then((result) => {
        this.forget(entry, request);
        // A removed agent's turn continues when it is back.
        return entry.closed ? { ok: true } : result;
      });
    const policy = {
      topLevel,
      cancel: () => {
        interrupted = true;
        prior?.cancel();
      },
      handed: handed.catch(() => undefined),
      settled: Promise.all([same ? prior?.settled : undefined, settled]).then(
        () => undefined,
      ),
    };
    entry.policies.set(key, policy);
    void policy.settled.then(() => {
      if (entry.policies.get(key) === policy) entry.policies.delete(key);
    });
    // Deliveries keep their order: a later one waits on this handover, and
    // one with nothing to wait for is handed over before `run` returns.
    if (!wait && !handoff.deferred) await policy.handed;
    // The turn outlives `run`, which the host is told so it shows it as working.
    workingUntil(settled);
    // Stop on its activity stops the run the request is in.
    interruptible?.(async () => {
      interrupted = true;
      await handed;
      if (!submitted) return;
      await this.pi.request("abort", {
        agent: agent.key,
        conversation: submitted.conversation,
      });
    });
    void settled.then(async (result) => {
      if (!result.ok && !interrupted && !entry.closed)
        await this.report(agent, where, result.error ?? "");
    });
  }

  /** Runs a standalone turn, such as a watch's or a timer's, in a one-off
   * Pi conversation, stopped when `signal` aborts. */
  async runOnce({
    delivery,
    key,
    signal,
    prompt,
  }: StandaloneTurn): Promise<TurnResult> {
    const { agent, team } = delivery;
    const entry = this.entry(agent, config(delivery.config));
    entry.handle = agent;
    entry.team = team ?? "";
    let stop: (() => void) | undefined;
    let request: string | undefined;
    try {
      await this.open(agent.key);
      await this.adopted(entry, agent.key);
      signal.throwIfAborted();
      const text = await prompt();
      if (text === undefined) return { ok: true };
      const turn = await this.turnOf(
        entry,
        agent.key,
        delivery.model,
        delivery.effort,
      );
      signal.throwIfAborted();
      if (delivery.current && !delivery.current()) return { ok: true };
      request = `${key}/${crypto.randomUUID()}`;
      entry.standalone.add(request);
      const { submission, conversation } = await this.pi.request<{
        submission: number;
        conversation: number;
      }>("once", { agent: agent.key, text, request, ...turn });
      // A removed agent's storage is closed, and stays so.
      stop = () => {
        if (!entry.closed)
          void this.pi
            .request("abort", { agent: agent.key, conversation })
            .catch(() => undefined);
      };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      const waited = await this.settle(entry, agent.key, submission);
      return waited.status === "unanswered"
        ? { ok: false, error: unanswered(waited) }
        : { ok: true };
    } catch (error) {
      // Pi may hold its run, which nothing waits for now.
      if (request) entry.abandoned = true;
      return { ok: false, error: errorText(error) };
    } finally {
      if (stop) signal.removeEventListener("abort", stop);
      if (request) entry.standalone.delete(request);
    }
  }

  /** Runs a Buzz tool for Pi, for the conversation that called it. */
  async tool(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const entry = this.agents.get(call.agent);
    const client =
      entry?.handle &&
      appClient(entry.handle, {
        protectionContext: () =>
          this.pi.request("protectionContext", {
            agent: call.agent,
            conversation: call.conversation,
          }),
        relayAuthor: this.reads(call.agent)?.relayAuthor?.(),
        signingAuthority: this.reads(call.agent)?.workflowAuthority(),
        read: (path) =>
          entry.handle?.protection
            ? readFile(
                this.spawn,
                entry.config.workspace,
                path,
                signal,
                entry.handle.protection.processProtection,
              )
            : this.readFile(path, { cwd: entry.config.workspace }),
        memories: (slug) => this.memories(call.agent, slug),
        remembered: () => this.forgetMemory(call.agent),
        ...(signal ? { signal } : {}),
      });
    try {
      const reply = await callSessionTool(
        client,
        call.context,
        call.name,
        call.arguments,
        this.added(),
      );
      return {
        content: content(reply),
        ...(isFinalMessage(call.name, call.arguments) ? { final: true } : {}),
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: errorText(error) }],
        isError: true,
      };
    }
  }

  /** What Pi says of its conversations: a request joining a run takes that
   * conversation's activity from the one before it, and steps go to it. */
  event(event: PiEvent) {
    const entry = this.agents.get(event.agent);
    if (!entry) return;
    let active = entry.active.get(event.conversation);
    if (event.type === "placed") {
      const receipt = entry.receipts.get(event.request);
      if (!receipt) return;
      active ??= new Map();
      entry.active.set(event.conversation, active);
      const before = active.get(receipt.scope);
      if (!before || receipt.step) {
        if (before !== receipt) before?.superseded?.();
        active.set(receipt.scope, receipt);
      }
      receipt.acknowledged?.();
      this.notify();
    } else
      for (const receipt of active?.values() ?? [])
        receipt.step?.(event.tool, event.target);
  }

  /** Notes a conversation's newest message, `seen` in seconds, once the
   * agent's conversations were asked for; a later one already known stays.
   * True when that changed what is known. */
  private remember(
    agent: AgentKey,
    key: string,
    conversation: number,
    seen: number,
  ) {
    const known = this.known.get(agent);
    const before = known?.get(key);
    const at = Math.max(seen * 1000, before?.at ?? 0);
    if (!known || (before?.conversation === conversation && before.at === at))
      return false;
    known.set(key, { conversation, at });
    return true;
  }

  private forget(entry: Entry, request: string) {
    const receipt = entry.receipts.get(request);
    entry.receipts.delete(request);
    for (const [conversation, active] of entry.active)
      for (const [scope, shown] of active)
        if (shown === receipt) {
          active.delete(scope);
          if (!active.size) entry.active.delete(conversation);
        }
    this.notify();
  }

  /** Opens the agent's storage in the host, with its Buzz tools as they are
   * now: those loaded on search are deferred until Pi's tool search loads
   * them, and the hint says what to search for. The host does nothing for one
   * already open with these tools. */
  /** Throws for a removed agent, whose queued mention Pi must not run:
   * Pi's coding tools have no sandbox. Its storage, opened again by the
   * handover, closes. */
  private live(entry: Entry, agent: AgentKey) {
    if (!entry.closed) return;
    if (!this.running.has(agent) && !this.agents.has(agent))
      void this.pi.request("close", { agent }).catch(() => undefined);
    throw new Error("The agent was removed");
  }

  /** Hands a turn to Pi. A host that stops before it answers may have taken
   * the turn already; the next one, asked again, finds it by its request
   * rather than taking it twice. */
  private async deliver(
    entry: Entry,
    agent: AgentKey,
    params: object,
    current: () => boolean,
  ): Promise<Delivered | false | undefined> {
    try {
      return await this.pi.request("deliver", params);
    } catch (error) {
      if (!(error instanceof PiStopped) || entry.closed) throw error;
      try {
        await this.reopen(entry, agent);
        if (!current()) return;
        return await this.pi.request("deliver", params);
      } catch (again) {
        // The stopped host may have taken it, and nothing waits for it now.
        entry.abandoned = true;
        throw again;
      }
    }
  }

  /** Takes on the runs Pi's storage holds that nothing here waits for before
   * anything continues them: once the agent opens here, and `again` once it is
   * opened again, after any taking-on under way. One that fails stops the
   * turn that needed it, and the next turn does it again. */
  private adopted(
    entry: Entry,
    agent: AgentKey,
    { current, again }: { current?: string; again?: boolean } = {},
  ) {
    if (entry.adopted && !again && !entry.abandoned) return entry.adopted;
    entry.abandoned = false;
    const prior = entry.adopted?.catch(() => undefined);
    const adopted = prior
      ? prior.then(() => this.adopt(entry, agent, current))
      : this.adopt(entry, agent, current);
    entry.adopted = adopted;
    adopted.catch(() => {
      if (entry.adopted === adopted) delete entry.adopted;
    });
    return adopted;
  }

  /** Takes on the runs an earlier app, or a host that stopped, left
   * unfinished in Pi's storage, which any delivery continues, in whatever
   * thread: they show as working, and their failures are reported as a
   * delivery's are, but Stop is not restored. Standalone turns' and plugin
   * wakes' runs are ended instead, and rejects when they could not be, as Pi
   * would continue them. `current` is the request being delivered,
   * which its own run waits for. */
  private async adopt(entry: Entry, agent: AgentKey, current?: string) {
    const { submissions: unfinished } = await this.pi.request<{
      submissions: readonly {
        submission: number;
        conversation: number;
        request: string;
        context?: { channel: string; root?: string; topLevel?: boolean };
        reply?: Where;
      }[];
    }>("unfinished", { agent });
    const taken: Receipt[] = [];
    const waits: (() => Promise<void>)[] = [];
    const dropped: { submission: number; conversation: number }[] = [];
    const aborted = new Set<number>();
    // The conversations with a mention's or Attention wake's run to continue.
    const continued = new Set(
      unfinished.flatMap(({ conversation, request, context }) =>
        context && !request.startsWith(WAKE) ? [conversation] : [],
      ),
    );
    for (const {
      submission,
      conversation,
      request,
      context,
      reply,
    } of unfinished) {
      const { handle } = entry;
      if (
        !handle ||
        request === current ||
        entry.receipts.has(request) ||
        entry.standalone.has(request)
      )
        continue;
      // A plugin's wake ends with the app, as in other harnesses, unless its
      // conversation has a continued request, which ending it would end or
      // leave queued untaken. Then it goes on, and nothing is reported for
      // it, as a plugin's wake saves no destination of its own. It is still
      // waited for, as only then does its run's failure end what is queued
      // behind it, which reports it.
      if (request.startsWith(WAKE)) {
        if (!continued.has(conversation)) {
          dropped.push({ submission, conversation });
          aborted.add(conversation);
        } else
          waits.push(async () => {
            entry.standalone.add(request);
            try {
              await this.settle(entry, agent, submission);
            } catch {
              // Given up, as `settle` says: the next turn takes it on again.
            } finally {
              entry.standalone.delete(request);
            }
          });
        continue;
      }
      // A watch's or timer's run ends with the app, as other harnesses' do:
      // continued, it would have no deadline, lane or Stop.
      if (!context) {
        dropped.push({ submission, conversation });
        continue;
      }
      // A conversation several threads share has no root: its failure is
      // reported in the thread of the mention, whose id is the request.
      const root =
        reply?.root ??
        context.root ??
        (context.topLevel ? request : await this.threadOf(agent, request));
      const where = reply ?? {
        channel: context.channel,
        root,
        topLevel: !!context.topLevel,
      };
      const receipt: Receipt = {
        // Only a thread's own conversation has a root.
        key: context.root
          ? `${context.channel}/${context.root}`
          : context.channel,
        scope: where.topLevel ? context.channel : root,
        where,
      };
      // A delivery of the same request takes it over, and says how it ended.
      const ours = () => entry.receipts.get(request) === receipt;
      entry.receipts.set(request, receipt);
      taken.push(receipt);
      const active = entry.active.get(conversation) ?? new Map();
      active.set(receipt.scope, receipt);
      entry.active.set(conversation, active);
      waits.push(() => {
        receipt.settled = this.settle(
          entry,
          agent,
          submission,
          reply ? request : undefined,
        )
          .then(async (waited) => {
            if (!ours()) return;
            // An answer Pi wrote without `send` stays in local activity.
            if (waited.status === "unanswered" && waited.reason !== "aborted")
              await this.report(handle, where, unanswered(waited));
          })
          .catch(async (error: unknown) => {
            if (ours() && !entry.closed)
              await this.report(handle, where, errorText(error));
          })
          .finally(() => {
            if (ours()) this.forget(entry, request);
          });
        return receipt.settled;
      });
    }
    // Only once every run is marked: a wait continues all of them, and one
    // could end while a later run's thread is still looked up.
    // Ending the others continues none; until they are ended, nothing waits.
    if (dropped.length)
      try {
        await this.pi.request("drop", { agent, submissions: dropped });
      } catch (error) {
        for (const [request, receipt] of entry.receipts)
          if (taken.includes(receipt)) this.forget(entry, request);
        throw error;
      }
    // A wake's run is in its thread's conversation, where the next turn would
    // join it while it is only marked, and end untaken with it. Aborting the
    // conversation waits for the run to end. As that continues every left
    // run, it comes once all of them are marked, and their waits start even
    // when an abort fails: how they end meanwhile is still reported.
    try {
      for (const conversation of aborted)
        await this.pi.request("abort", { agent, conversation });
    } finally {
      for (const wait of waits) void wait();
      this.notify();
    }
  }

  /** The thread a mention is in, or opens; itself when it cannot be read. */
  private async threadOf(agent: AgentKey, id: string) {
    try {
      const [event] =
        (await this.reads(agent)?.read(
          [{ ids: [id], limit: 1 }],
          AbortSignal.timeout(READ_MS),
        )) ?? [];
      return (event && threadReference(event)?.rootId) ?? id;
    } catch {
      return id;
    }
  }

  /** Opens the agent again after its host stopped or its storage failed.
   * Pi continues every run once asked anything, so what was left for no one
   * is ended first. */
  private async reopen(entry: Entry, agent: AgentKey) {
    await this.open(agent);
    this.live(entry, agent);
    await this.adopted(entry, agent, { again: true });
  }

  private async open(agent: AgentKey) {
    await this.pi.request("open", {
      agent,
      tools: sessionTools(this.added()),
      hint: sessionHint(this.added()),
    });
  }

  /** How a request settles. A host that stopped, or an agent whose storage
   * failed, is opened again once: its run continues there, from Pi's
   * storage. */
  private async settle(
    entry: Entry,
    agent: AgentKey,
    submission: number,
    request?: string,
  ): Promise<Waited> {
    // Given up, the run is still unfinished, and nothing waits for it now.
    const abandon = (error: unknown) => {
      entry.abandoned = true;
      return error;
    };
    for (let attempt = 0; ; attempt++) {
      let waited: Waited | { status: "reopen" };
      try {
        if (attempt) await this.reopen(entry, agent);
        waited = await this.pi.request("wait", {
          agent: agent,
          submission,
          ...(request ? { request } : {}),
        });
      } catch (error) {
        if (attempt || !(error instanceof PiStopped) || entry.closed)
          throw abandon(error);
        continue;
      }
      if (waited.status !== "reopen") return waited;
      if (attempt || entry.closed)
        throw abandon(new Error("Pi's storage for this agent keeps failing"));
    }
  }

  /** What a turn runs with: the agent's model and thinking level or the
   * owner's pick, its prompt, its `core` memory as read now (none when it
   * could not be read), and its workspace. The memory is apart, as Pi keeps
   * what a conversation was shown of it until a compaction. */
  private async turnOf(
    entry: Entry,
    agent: AgentKey,
    model?: string,
    effort?: string,
  ) {
    const { workspace, instructions, scope } = entry.config;
    const memory = await this.core(agent);
    return {
      provider: entry.config.provider,
      model: entry.config.model,
      thinking: entry.config.effort,
      // Apart, so a request that steers a working run changes only these.
      pick: { model, thinking: effort },
      cwd: workspace,
      instructions: systemPrompt({
        scope,
        cwd: workspace,
        repositories: this.repositories(this.reads(agent)?.scope),
        ...(entry.name
          ? { agent: { name: entry.name, pubkey: pubkeyOf(agent) } }
          : {}),
        instructions,
        team: entry.team,
      }),
      ...(memory === undefined
        ? {}
        : {
            core: {
              text: coreMemorySection(memory),
              placeholder: coreMemorySection(null),
            },
          }),
    };
  }

  /** `text` with the Buzz tools' end-of-turn note, when they have one. */
  private review(entry: Entry, text: string) {
    const note = turnNote(entry.handle);
    return note ? `${text}\n\n${note}` : text;
  }

  /** Says in the thread that a turn failed, so nobody waits on it. Tells the
   * owner even when a sibling asked, as Claude does: tagging the sibling would
   * wake it, and two agents failing alike would wake each other without end. */
  private report(agent: AgentHandle, where: Where, error: string) {
    return agent
      .publish({
        kind: 9,
        content: `⚠️ I couldn't finish that: ${error.slice(0, 500)}`,
        tags: [...replyTags(where), ["p", agent.owner]],
      })
      .catch((failure) =>
        console.warn("Pi could not report a failed turn", failure),
      );
  }

  /** The conversation the event's turn goes to: a Solo chat or DM is one
   * conversation, as is a channel for an agent with channel scope. */
  private async key(
    entry: Entry,
    agent: AgentKey,
    event: EventData,
    channelId: string,
    topLevel: boolean,
  ) {
    const summary = await this.reads(agent)?.channel(channelId);
    return topLevel || summary?.dm === true || entry.config.scope === "channel"
      ? channelId
      : `${channelId}/${threadReference(event)?.rootId ?? event.id}`;
  }

  /** What the event's prompt needs: its channel and thread, and the messages
   * before it that the conversation, shown up to `seen`, has not been shown. */
  private async turn(
    agent: Pick<Agent, "key" | "pubkey">,
    event: EventData,
    channelId: string,
    key: string,
    topLevel: boolean,
    seen: number,
    solo = topLevel,
  ) {
    const reads = this.reads(agent.key);
    const summary = await reads?.channel(channelId);
    const dm = summary?.dm === true;
    const thread = threadReference(event);
    const rootId = thread?.rootId ?? event.id;
    // The conversation it was admitted to, not the scope as it is now.
    const scope: Scope = key === channelId ? "channel" : "thread";
    // Read alongside the conversation: only a Solo chat's Canvas is handed over.
    const canvas = reads?.canvas?.bind(reads);
    const owner = this.agents.get(agent.key)?.handle?.owner;
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
        console.warn("Pi could not read the conversation", error);
      }
    // A conversation already has its own replies; a new one is shown them too.
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
      reading.then((read) => read?.section),
    ]);
    return {
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
      total: earlier.length + 1,
      names,
      ...(signingAuthority ? { signingAuthority } : {}),
      ...(project ? { project } : {}),
    };
  }

  private entry(agent: AgentHandle, initial: Config): Entry {
    const existing = this.agents.get(agent.key);
    if (existing) return existing;
    const entry: Entry = {
      config: initial,
      team: "",
      name: agent.name,
      policies: new Map(),
      receipts: new Map(),
      standalone: new Set(),
      active: new Map(),
      closed: false,
    };
    this.agents.set(agent.key, entry);
    return entry;
  }

  private get spawn() {
    const spawn = this.host.spawn?.bind(this.host);
    if (!spawn) throw new Error("Pi agents run only in the desktop app");
    return spawn;
  }

  private get readFile() {
    const readFile = this.host.readFile?.bind(this.host);
    if (!readFile) throw new Error("Pi agents run only in the desktop app");
    return readFile;
  }

  /** The agent's memory, or only entry `slug`, as its community's reads give
   * it. */
  private memories(agent: AgentKey, slug?: string) {
    const reads = this.reads(agent);
    if (!reads) return Promise.reject(new Error("Buzz is not connected"));
    return this.memoryReads.read(
      reads,
      pubkeyOf(agent),
      AbortSignal.timeout(READ_TIMEOUT_MS),
      slug,
    );
  }
  private forgetMemory(agent: AgentKey) {
    const reads = this.reads(agent);
    if (reads) this.memoryReads.forget(reads.connection, pubkeyOf(agent));
  }
}

/** The conversation key session controls in `place` act on, as `key` makes
 * it: a DM or Solo chat has no root here. */
const controlKey = (agent: Agent, place: SessionPlace) =>
  config(agent.config).scope === "channel" || !place.root
    ? place.channelId
    : `${place.channelId}/${place.root}`;

/** Why Pi left a request unanswered, in words. */
function unanswered({
  reason,
  detail,
}: Extract<Waited, { status: "unanswered" }>) {
  if (detail) return detail;
  if (reason === "no_model") return "Pi has no model for this agent";
  if (reason === "aborted") return "The turn was stopped";
  return `Pi did not answer (${reason ?? "unknown"})`;
}
