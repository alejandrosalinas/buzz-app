import type { Delivery, TurnResult, SessionAction } from "../agents/service";
import { abortable } from "./session-scope";

/** A compact/reset owns its conversation until it ends. Deliveries wait for
 * that boundary; interruption cancels this operation, never a later turn. */
export class SessionControls {
  private readonly changes = new Map<
    string,
    { action: SessionAction; controller: AbortController; done: Promise<void> }
  >();
  private readonly pending = new Map<string, Set<AbortController>>();
  private readonly ordered = new Map<string, Promise<void>>();
  private readonly handoffs = new Map<string, number>();
  constructor(private readonly changed: () => void) {}
  active(key: string) {
    return this.changes.has(key) || this.handoffs.has(key);
  }
  compacting(key: string) {
    return this.changes.get(key)?.action === "compact";
  }
  deliver(
    key: string,
    handoff: (deferred: boolean, signal: AbortSignal) => Promise<void>,
    ordered = false,
  ) {
    const prior = ordered ? this.ordered.get(key) : undefined;
    const deferred = this.changes.has(key) || !!prior;
    const controller = new AbortController();
    const pending = this.pending.get(key) ?? new Set<AbortController>();
    if (ordered) {
      pending.add(controller);
      this.pending.set(key, pending);
    }
    // Reserve admission before waiting, so another action cannot slip between
    // compaction and these messages. Ordinary steering handoffs may overlap.
    this.handoffs.set(key, (this.handoffs.get(key) ?? 0) + 1);
    this.changed();
    const done = (async () => {
      if (prior) await prior.catch(() => undefined);
      while (this.changes.has(key))
        await this.changes.get(key)?.done.catch(() => undefined);
      if (!controller.signal.aborted)
        await handoff(deferred, controller.signal);
    })().finally(() => {
      pending.delete(controller);
      if (!pending.size && this.pending.get(key) === pending)
        this.pending.delete(key);
      const count = (this.handoffs.get(key) ?? 1) - 1;
      if (count) this.handoffs.set(key, count);
      else this.handoffs.delete(key);
      if (this.ordered.get(key) === done) this.ordered.delete(key);
      this.changed();
    });
    if (ordered) this.ordered.set(key, done);
    return {
      deferred,
      done,
      signal: controller.signal,
      cancel: () => controller.abort(new Error("Session work interrupted")),
    };
  }
  /** Authorised community work reserves its position before source preparation. */
  admit(
    key: string,
    delivery: Delivery,
    run: (delivery: Delivery, deferred: boolean) => Promise<void>,
  ) {
    let interrupt: (() => Promise<void>) | undefined;
    let stopped = false;
    let stopping = Promise.resolve();
    const handoff = this.deliver(
      key,
      async (deferred, signal) => {
        try {
          await run(
            {
              ...delivery,
              interruptible: (cancel) => {
                interrupt = cancel;
                if (stopped) {
                  stopping = cancel();
                  void stopping.catch(() => {});
                }
              },
              signal: deferred
                ? signal
                : AbortSignal.any([delivery.signal, signal]),
            },
            deferred,
          );
        } catch (error) {
          if (!signal.aborted) throw error;
        } finally {
          await stopping;
        }
      },
      true,
    );
    delivery.interruptible?.(async () => {
      stopped = true;
      handoff.cancel();
      await interrupt?.();
    });
    delivery.workingUntil(
      handoff.done.then(
        (): TurnResult =>
          handoff.signal.aborted
            ? { ok: false, error: "Session work interrupted" }
            : { ok: true },
        (error: unknown): TurnResult => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
    return handoff.deferred ? Promise.resolve() : handoff.done;
  }
  async wake(
    key: string,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<TurnResult>,
  ): Promise<TurnResult> {
    let result: TurnResult = { ok: false, error: "Session work interrupted" };
    const handoff = this.deliver(
      key,
      async (_deferred, cancel) => {
        result = await run(AbortSignal.any([signal, cancel]));
      },
      true,
    );
    try {
      await abortable(handoff.done, signal);
      return result;
    } catch (error) {
      if (!signal.aborted) throw error;
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  dispose() {
    for (const key of this.pending.keys()) this.interrupt(key, true);
  }
  /** Interrupt the current action, or the work queue when no action owns it.
   * Retirement also cancels queued work, even behind an action. */
  interrupt(key: string, all = false) {
    const change = this.changes.get(key);
    if (all || !change)
      for (const controller of this.pending.get(key) ?? [])
        controller.abort(new Error("Session work interrupted"));
    change?.controller.abort(new Error("Session action interrupted"));
    return !!change;
  }
  run(
    key: string,
    action: SessionAction,
    change: (signal: AbortSignal) => Promise<void>,
  ) {
    if (this.active(key))
      throw new Error("A session action is already running.");
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => change(controller.signal))
      .finally(() => {
        this.changes.delete(key);
        this.changed();
      });
    this.changes.set(key, { action, controller, done });
    this.changed();
    return done;
  }
}
