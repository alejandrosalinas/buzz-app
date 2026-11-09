import { steerPrompt } from "../../../bundled/claude-code/prompt";
import { unsupportedSynced } from "../../agents/agent-config";
import type { HostMcpServer } from "../../host/service";
import type { AcpProcess } from "./process";
import { codeOf, errorMessage, stepLabel } from "./steps";
import type { ActivityReceipt, Choice, Settled } from "./types";

/** The most of a turn's text kept, to post when it answers nowhere in Buzz. */
const WRITTEN_LIMIT = 20_000;

type Waiter = (settled: Settled) => void;

/** A session's settings, as `session/new` and `session/set_config_option`
 * return them. */
export type ConfigOptions = {
  configOptions?: {
    category?: string | null;
    options?: ConfigValue[];
  }[];
};
/** A select's choice, or a group of them. */
export type ConfigValue = { value?: string; options?: ConfigValue[] };
/** Every choice's value, groups flattened. */
export const valuesOf = (options: readonly ConfigValue[] = []): string[] =>
  options.flatMap((option) =>
    option.options
      ? valuesOf(option.options)
      : typeof option.value === "string"
        ? [option.value]
        : [],
  );

/** One conversation's ACP session. Messages sent while a turn runs are
 * steered into it, when the harness can steer; one that arrives as the turn
 * ends, or asks for another model, runs as the next turn. */
export class AcpSession {
  /** The conversation it serves. */
  conversation: string | undefined;
  /** Takes the first name the harness generates for it; a titled session gets
   * none. */
  named: ((title: string) => void) | undefined;
  /** The harness's id for the running turn, which a steer must name. */
  private runId: string | undefined;
  /** Steers waiting for the running turn's id, which the harness sends just
   * after the turn starts. */
  private runWaiters: ((runId: string | undefined) => void)[] = [];
  /** A `session/prompt` is in flight. */
  private prompting = false;
  private readonly steering = new Set<Waiter>();
  private steered = Promise.resolve();
  /** Turns to run, each with the model and level it was asked for, if any. */
  private readonly queue: {
    text: string;
    model?: string;
    effort?: string;
    kept?: string;
    current?: () => boolean;
    refresh?: ActivityReceipt["refresh"];
    waiter?: Waiter;
    delivered?: () => void;
  }[] = [];
  /** The model the running turn runs on; empty is its provider's default. */
  private model = "";
  /** The thinking level the running turn runs on; empty is the harness's own. */
  private level = "";
  /** The thinking levels the harness last listed for the session's model. */
  private levels: readonly string[] = [];
  /** Messages sent and not yet answered. */
  private pending = 0;
  private waiters: Waiter[] = [];
  /** The waiter that posts the burst's error or text: the latest message
   * acknowledged, else the latest sent. */
  private owner: Waiter | undefined;
  private readonly active = new Map<string, ActivityReceipt>();
  private lastStep = "";
  /** The receipt each queued request displaced in its scope, superseded only
   * once that request is sent, so a request refused before then gives the
   * scope back, Stop included. */
  private readonly displaced = new Map<
    Waiter,
    {
      scope: string;
      prior?: ActivityReceipt | undefined;
      activity: ActivityReceipt;
    }
  >();
  /** The burst's latest error, with the JSON-RPC code of that same error. */
  private lastFailure: { error: string; code?: number } | undefined;
  /** Whether this work answered in Buzz, and what the harness wrote meanwhile: a
   * provider failure comes back as text, and text is never posted. */
  private acted = false;
  private written = "";
  private closed = false;
  /** A final message ended the work: the id of its tool call, whose result
   * cancels the running turn once the harness reports it, then `true` until
   * that turn ends. Meanwhile the turn takes no steers. */
  private ending: string | true | undefined;
  /** The work the owner stopped, while the harness ends it: the messages it
   * had taken, and their activity. What it wrote meanwhile is not posted, and
   * messages sent since wait for a turn of their own. `ended` is set once
   * the cancel ended the turn, not when the turn finished on its own. */
  private stopped:
    | { waiters: Waiter[]; receipts: Set<ActivityReceipt>; ended?: true }
    | undefined;
  private idlers: (() => void)[] = [];
  /** How often its work has been stopped or has ended. */
  private generation = 0;

  constructor(
    private readonly acp: AcpProcess,
    readonly id: string,
    /** Serves this session's Buzz tools; closed with it. */
    readonly server?: HostMcpServer,
    private readonly choice?: () => Choice,
    /** The provider, model and thinking level it runs on, as chosen here. */
    public chosen: Choice = { provider: "", model: "" },
    /** Instructions that lead its first prompt, for a harness that takes no
     * system prompt. */
    private preamble = "",
  ) {}

  get busy() {
    return this.pending > 0;
  }
  get working() {
    return !this.quiet();
  }
  get open() {
    return !this.closed;
  }
  /** The thinking level it was put on; empty while it runs on the harness's own. */
  get effort() {
    return this.chosen.effort ?? "";
  }
  /** Resolves once nothing runs, waits to run or waits for its answer:
   * unlike `busy`, it waits out the end of the turn after a final `send` too. */
  idle(): Promise<void> {
    if (this.quiet()) return Promise.resolve();
    return new Promise((resolve) => this.idlers.push(resolve));
  }

  /** Sends one user message, whose turn runs on `model` of the provider and
   * thinking level `effort` when given. Resolves when it, and anything sent
   * after it, has been answered, or a final message ended the work. */
  send(
    text: string,
    activity: ActivityReceipt = {},
    model?: string,
    effort?: string,
    /** A synced level the turn must run on, or it fails before its prompt. */
    kept?: string,
  ): Promise<Settled> {
    if (this.closed)
      return Promise.resolve({ ok: false, error: "The session was closed" });
    this.pending++;
    let waiter!: Waiter;
    const settled = new Promise<Settled>((resolve) => {
      waiter = resolve;
      this.waiters.push(resolve);
    });
    // A steer cannot change the model or level, and must not pass a queued
    // turn.
    if (
      this.prompting &&
      !this.stopped &&
      !this.ending &&
      this.acp.hooks.steering &&
      !this.queue.length &&
      (!model || model === this.model) &&
      (!effort || effort === this.level)
    )
      void this.steer(text, activity, waiter, model, effort, kept);
    else {
      this.queue.push({
        text,
        ...(activity.delivered ? { delivered: activity.delivered } : {}),
        ...(activity.current ? { current: activity.current } : {}),
        ...(activity.refresh ? { refresh: activity.refresh } : {}),
        waiter,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(kept ? { kept } : {}),
      });
      this.acknowledge(activity, waiter, true);
      void this.pump();
    }
    return settled;
  }

  /** Whether the work running now, if any, still runs unstopped and
   * unfinished when asked later; work after it is not that work. */
  current(): () => boolean {
    const generation = this.stopped || this.quiet() ? -1 : this.generation;
    return () =>
      this.generation === generation && !this.stopped && !this.quiet();
  }

  /** A final message succeeded: the work counts as done at once, and the
   * turn of tool call `call` ends, unless another message is still waiting
   * for its answer. */
  finished(call?: string) {
    if (this.pending !== 1 || this.queue.length || this.steering.size) return;
    this.settle({ ok: true, answered: true });
    if (this.prompting && call) this.ending = call;
  }

  /** Stops the work: the running turn, as ACP's `session/cancel` does, and
   * the messages waiting for a turn after it, which the harness cannot stop
   * apart. A turn not yet sent is never sent. The work then ends as the
   * harness ends it; a message sent before it has runs as a new turn after. */
  interrupt() {
    if (!this.working || this.closed) return;
    this.generation++;
    this.queue.length = 0;
    this.steered = Promise.resolve();
    this.stopped = {
      waiters: [...this.waiters],
      receipts: new Set(this.active.values()),
    };
    this.acp.notify("session/cancel", { sessionId: this.id });
  }

  /** A Buzz tool that answers, such as `send`, succeeded. */
  answered() {
    this.acted = true;
  }

  /** Called by the process with each `session/update` for this session. */
  update(update: Record<string, unknown>) {
    const kind = update.sessionUpdate;
    // A cancel before goose has the final message's result would save that
    // call as interrupted. goose reports a batch's results together, once
    // every call in it has one, and keeps them when the turn is cancelled.
    if (
      typeof this.ending === "string" &&
      kind === "tool_call_update" &&
      update.toolCallId === this.ending &&
      (update.status === "completed" || update.status === "failed")
    ) {
      this.ending = true;
      this.acp.notify("session/cancel", { sessionId: this.id });
    }
    if (kind === "agent_message_chunk" && !this.acted) {
      const content = update.content as { text?: unknown } | undefined;
      if (typeof content?.text === "string")
        this.written = (this.written + content.text).slice(0, WRITTEN_LIMIT);
    }
    if (kind === "session_info_update") {
      const title = typeof update.title === "string" ? update.title.trim() : "";
      const named = this.named;
      if (title && named) {
        this.named = undefined;
        named(title);
      }
    }
    // `undefined` from the hook means no run is active: keep it.
    const { steering } = this.acp.hooks;
    const runId = steering ? steering.runId(update) : null;
    if (runId !== null) {
      this.runId = runId;
      if (runId) this.ranAs(runId);
    }
    if (kind === "session_info_update" || runId !== null) return;
    const step = stepLabel(update);
    if (!step) return;
    const label = `${step.tool}\u0000${step.target ?? ""}`;
    if (label === this.lastStep) return;
    this.lastStep = label;
    for (const receipt of this.active.values())
      receipt.step?.(step.tool, step.target);
  }

  /** Ends the session's work with `error`; nothing more is sent to it. */
  fail(error: string) {
    this.closed = true;
    this.queue.length = 0;
    this.settle({ ok: false, error });
  }

  private async steer(
    text: string,
    activity: ActivityReceipt,
    waiter: Waiter,
    model?: string,
    effort?: string,
    kept?: string,
  ) {
    this.steering.add(waiter);
    const prior = this.steered;
    let release!: () => void;
    this.steered = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Work the owner stopped, or that ended meanwhile, takes no more.
    const live = () =>
      this.waiters.includes(waiter) && !this.stopped?.waiters.includes(waiter);
    try {
      await prior;
      if (!live()) return;
      const runId =
        this.runId ??
        (this.prompting
          ? await new Promise<string | undefined>((resolve) =>
              this.runWaiters.push(resolve),
            )
          : undefined);
      if (activity.refresh) text = steerPrompt(await activity.refresh());
      if (!live()) return;
      if (activity.current && !activity.current()) {
        this.discard(waiter);
        return;
      }
      const { steering } = this.acp.hooks;
      if (runId && steering) {
        try {
          await steering.steer(this.acp, this.id, runId, text);
          if (live()) {
            activity.delivered?.();
            this.acknowledge(activity, waiter);
          }
          return;
        } catch {
          // The turn ended, or another took its place: run it as the next.
        }
      }
      if (live()) {
        const next = this.queue.findIndex(
          (turn) =>
            turn.waiter &&
            this.waiters.indexOf(turn.waiter) > this.waiters.indexOf(waiter),
        );
        this.queue.splice(next < 0 ? this.queue.length : next, 0, {
          text,
          ...(activity.delivered ? { delivered: activity.delivered } : {}),
          ...(activity.current ? { current: activity.current } : {}),
          ...(activity.refresh ? { refresh: activity.refresh } : {}),
          waiter,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          // As a turn of its own, it is checked like any other.
          ...(kept ? { kept } : {}),
        });
        this.acknowledge(activity, waiter, true);
      }
    } finally {
      release();
      this.steering.delete(waiter);
      // Runs the next turn, or ends work whose turn ended during the steer.
      void this.pump();
    }
  }

  /** Ends one request the harness never saw, leaving the rest of the work:
   * unsent, or failed with `error` when it was refused before its prompt.
   * Either way it is undelivered, so what it carried comes back for the next
   * turn. */
  private discard(waiter: Waiter, error?: string) {
    this.withdraw(waiter);
    this.waiters = this.waiters.filter((pending) => pending !== waiter);
    this.pending = this.waiters.length;
    if (this.owner === waiter) this.owner = this.waiters.at(-1);
    for (const [scope, receipt] of this.active)
      if (receipt.current && !receipt.current()) this.active.delete(scope);
    waiter(
      error
        ? { ok: false, error, undelivered: true }
        : { ok: true, undelivered: true },
    );
  }

  private get handingOff() {
    return [...this.steering].some(
      (waiter) =>
        this.waiters.includes(waiter) &&
        !this.stopped?.waiters.includes(waiter),
    );
  }

  private async pump() {
    if (this.prompting || this.handingOff) return;
    this.prompting = true;
    try {
      while (this.queue.length && !this.handingOff && !this.closed) {
        this.ending = undefined;
        // Stopped work has ended, and messages sent since run as new work.
        if (this.stopped) this.endStopped();
        const {
          text,
          model,
          effort,
          kept,
          current,
          refresh,
          waiter,
          delivered,
        } = this.queue.shift() ?? {
          text: "",
        };
        let sent = false;
        try {
          await this.select(model, effort);
          // A harness may ignore a level its model lacks, and keep one across
          // a model switch without its being set again.
          if (kept && !this.levels.includes(kept))
            throw new Error(
              unsupportedSynced(
                "effort",
                kept,
                `${this.acp.hooks.label}'s ${this.model || "default model"}`,
              ),
            );
          const prompt = refresh ? await refresh() : text;
          // The owner stopped it while its provider switch was going.
          if (this.stopped) {
            this.cancelEnded();
            continue;
          }
          // Closed meanwhile: nothing more is sent to it.
          if (this.closed) break;
          if (current && !current()) {
            if (waiter) this.discard(waiter);
            continue;
          }
          delivered?.();
          sent = true;
          if (waiter) this.sent(waiter);
          const lead = this.preamble;
          const { stopReason } = (await this.acp.request("session/prompt", {
            sessionId: this.id,
            prompt: [
              { type: "text", text: lead ? `${lead}\n\n${prompt}` : prompt },
            ],
          })) as { stopReason?: string };
          // A rejected prompt never reached the model: the next one leads.
          this.preamble = "";
          if (stopReason === "cancelled") this.cancelEnded();
          if (stopReason === "refusal")
            this.lastFailure = {
              error: `${this.acp.hooks.label} refused the request`,
            };
        } catch (error) {
          // Refused before the harness saw it: only that request fails.
          if (!sent && waiter) {
            this.discard(waiter, errorMessage(error));
            continue;
          }
          const code = codeOf(error);
          this.lastFailure = {
            error: errorMessage(error),
            ...(code === undefined ? {} : { code }),
          };
        }
      }
    } finally {
      this.prompting = false;
      this.ending = undefined;
      this.runId = undefined;
      this.ranAs(undefined);
    }
    if (!this.steering.size && !this.closed) this.done();
    this.wake();
  }

  /** Puts the session on the provider, model and thinking level chosen now,
   * or `model` of that provider and level `effort`. A steer joins the running
   * turn, so a change waits for the next. */
  private async select(model?: string, effort?: string) {
    const chosen = this.choice?.();
    if (!chosen) return;
    const want = {
      ...chosen,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
    this.model = want.model;
    this.level = want.effort ?? "";
    await this.acp.hooks.select?.(this.acp, this, want);
  }

  /** Notes the thinking levels in a `session/new` or
   * `session/set_config_option` answer, which list the current model's. */
  offer({ configOptions = [] }: ConfigOptions) {
    const option = configOptions.find(
      (item) => item.category === "thought_level",
    );
    this.levels = valuesOf(option?.options);
  }

  private ranAs(runId: string | undefined) {
    for (const resolve of this.runWaiters.splice(0)) resolve(runId);
  }
  private acknowledge(
    activity: ActivityReceipt,
    waiter: Waiter,
    queued = false,
  ) {
    if (this.waiters.includes(waiter)) this.owner = waiter;
    // Watches and timers have no message activity: they must not hide a mention.
    if (!activity.step) return;
    const scope = activity.activityScope ?? "conversation";
    const prior = this.active.get(scope);
    if (queued) this.displaced.set(waiter, { scope, prior, activity });
    else prior?.superseded?.();
    this.active.set(scope, activity);
    this.lastStep = "";
    activity.acknowledged?.();
  }
  /** A queued request reached the harness: the receipt it displaced is
   * superseded. */
  private sent(waiter: Waiter) {
    this.displaced.get(waiter)?.prior?.superseded?.();
    this.displaced.delete(waiter);
  }
  /** A queued request left before the harness saw it: its scope goes back to
   * the receipt it displaced, unless a later request has the scope now. */
  private withdraw(waiter: Waiter) {
    const entry = this.displaced.get(waiter);
    if (!entry) return;
    this.displaced.delete(waiter);
    for (const later of this.displaced.values())
      if (later.prior === entry.activity) later.prior = entry.prior;
    if (this.active.get(entry.scope) !== entry.activity) return;
    // The next step shows on the receipt given back, even one seen before.
    this.lastStep = "";
    if (entry.prior) this.active.set(entry.scope, entry.prior);
    else this.active.delete(entry.scope);
  }
  private done() {
    // Work that wrote text and never answered in Buzz answered only the
    // harness: a model that forgot `send`, or one that cannot reach its provider.
    const text = this.acted || this.stopped ? "" : this.written.trim();
    const failure = this.lastFailure;
    this.settle({
      ...(failure?.error ? { ok: false, ...failure } : { ok: true }),
      ...(text ? { text } : {}),
      ...(this.acted ? { answered: true } : {}),
      ...(!failure?.error && this.stopped?.ended ? { stopped: true } : {}),
    });
  }
  /** The owner's cancel ended the turn, if it was stopping it. */
  private cancelEnded() {
    if (this.stopped) this.stopped.ended = true;
  }
  /** Settles the work the owner stopped, leaving messages sent since. */
  private endStopped() {
    const stopped = this.stopped;
    if (!stopped) return;
    this.stopped = undefined;
    const failure = this.lastFailure;
    this.lastFailure = undefined;
    this.acted = false;
    this.written = "";
    for (const [scope, receipt] of this.active)
      if (stopped.receipts.has(receipt)) this.active.delete(scope);
    for (const waiter of stopped.waiters) this.displaced.delete(waiter);
    const owner =
      this.owner && stopped.waiters.includes(this.owner)
        ? this.owner
        : stopped.waiters.at(-1);
    if (this.owner === owner) this.owner = undefined;
    this.waiters = this.waiters.filter(
      (waiter) => !stopped.waiters.includes(waiter),
    );
    this.pending = this.waiters.length;
    for (const resolve of stopped.waiters)
      resolve(
        resolve === owner && failure?.error
          ? { ok: false, ...failure }
          : {
              ok: !failure?.error,
              ...(!failure?.error && stopped.ended ? { stopped: true } : {}),
            },
      );
  }
  private settle(settled: Settled) {
    this.pending = 0;
    this.active.clear();
    this.displaced.clear();
    this.lastFailure = undefined;
    this.acted = false;
    this.written = "";
    this.stopped = undefined;
    const owner = this.owner ?? this.waiters.at(-1);
    this.owner = undefined;
    for (const resolve of this.waiters.splice(0))
      resolve(
        resolve === owner
          ? settled
          : { ok: settled.ok, ...(settled.stopped ? { stopped: true } : {}) },
      );
    this.wake();
  }
  private quiet() {
    return (
      this.closed ||
      (!this.prompting &&
        !this.steering.size &&
        !this.pending &&
        !this.queue.length)
    );
  }
  private wake() {
    if (!this.quiet()) return;
    this.generation++;
    for (const resolve of this.idlers.splice(0)) resolve();
  }
}
