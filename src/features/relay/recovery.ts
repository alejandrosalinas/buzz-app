/** One automatic recovery owner for a relay session's background reads.
 *
 * Each source reports whether it currently shows a failure. While any source
 * fails, recovery retries every failed source with a capped exponential delay.
 * It never gives up. A wake, network or success signal retries at once.
 *
 * Sources are background reads only. User actions (sends, moves, deletes) own
 * their own Retry because repeating them silently could repeat a user intent. */
import {
  networkRecorder,
  type NetworkSource,
} from "../developer/network-diagnostics.ts";

export type RecoveryStatus = "failed" | "busy" | "settled";
export type RecoverySource = Readonly<{
  name?: NetworkSource;
  status(): RecoveryStatus;
  subscribe(listener: () => void): () => void;
  retry(): void;
  /** Credentials changed: read again after any read already in flight, even
   * one its status does not show (a ready catalog revalidating). Without it,
   * recovery waits out a `busy` read before retrying. */
  reauthorize?(): void;
}>;
export type RecoverySnapshot = Readonly<{
  /** True while at least one source shows a failure. */
  recovering: boolean;
  /** Backoff index. retryNow restarts it; it does not hide the notice. */
  attempt: number;
  /** True once recovery has lasted RECOVERY_NOTICE_DELAY_MS, until every
   * source settles. Kept apart from `attempt` so a manual or signal retry
   * keeps the notice up. */
  shown: boolean;
  /** Counts credential changes (retryAll). A finite read owned outside
   * recovery retries its failure when this moves; see useReauthorizedRetry. */
  reauthorized: number;
}>;
export type RelayRecovery = Readonly<{
  snapshot(): RecoverySnapshot;
  subscribe(listener: () => void): () => void;
  /** Retry failed sources now and restart the delay sequence. `except` skips
   * a source that already owns its own recovery for the triggering event. */
  retryNow(
    except?: RecoverySource,
    trigger?:
      | "manual"
      | "focus"
      | "online"
      | "wake-gap"
      | "visible"
      | "source-connected",
  ): void;
  /** Credentials changed: retry every source, settled ones included, since a
   * changed credential can clear a refusal recovery deliberately leaves alone.
   * A source busy with a read begun under the old credentials retries again
   * once that read settles, so joining it cannot keep its stale refusal. */
  retryAll(): void;
  dispose(): void;
}>;

/** A background read's state as recovery sees it. Only failures a retry can
 * fix enter recovery; a denial or a deterministic failure stays visible on its
 * own surface (see isTransientFailure). */
export const loadState = (
  state: Readonly<{ status: string; transient?: true | undefined }>,
): RecoveryStatus =>
  state.status === "error"
    ? state.transient
      ? "failed"
      : "settled"
    : state.status === "loading"
      ? "busy"
      : "settled";
/** A refusal that federated sign-in can clear: the relay wanted a token. */
export const isSignInRefusal = (error: unknown) =>
  /Federated sign-in is required|Federated identity is not configured/.test(
    error instanceof Error ? error.message : String(error),
  );
/** Calls `retry` once credentials change after generation `sent` (a request's
 * `reauthorized` when sent); returns its cancel. */
export function reauthorizedOnce(
  recovery: RelayRecovery,
  sent: number,
  retry: () => void,
) {
  const check = () => {
    if (recovery.snapshot().reauthorized <= sent) return;
    stop();
    retry();
  };
  const stop = recovery.subscribe(check);
  check();
  return stop;
}
export const RECOVERY_DELAYS_MS = Object.freeze([
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
]);
/** Recovery shows its notice only once it lasts this long, so a socket blip,
 * a wake from sleep or a failure that the first retries fix stays quiet. Its
 * own timer, not a retry, starts it: a retry that hangs still shows the notice. */
export const RECOVERY_NOTICE_DELAY_MS = 30_000;

export function createRecovery(
  sources: readonly RecoverySource[],
  timers: Readonly<{
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  }> = {
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
  diagnostics?: Readonly<{ relay: string; connection: string }>,
): RelayRecovery {
  const listeners = new Set<() => void>();
  /** Sources whose pre-reauthorization read is still in flight. */
  const stale = new Set<RecoverySource>();
  let reauthorized = 0;
  const idle = () =>
    Object.freeze({
      recovering: false,
      attempt: 0,
      shown: false,
      reauthorized,
    });
  let snapshot: RecoverySnapshot = idle(),
    attempt = 0,
    shown = false,
    timer: unknown,
    notice: unknown,
    running = false,
    disposed = false;
  let reported = "";
  let operationId: string | undefined;
  const publish = (next: RecoverySnapshot) => {
    if (diagnostics && networkRecorder.collecting()) {
      if (next.recovering && !snapshot.recovering)
        operationId = `recovery:${crypto.randomUUID()}`;
      const sources = sourcesForReport();
      const key = JSON.stringify([next, sources]);
      if (key !== reported) {
        reported = key;
        if (networkRecorder.collecting())
          networkRecorder.record({
            level: "info",
            event: "recovery",
            operationId,
            outcome: next.recovering ? "recovering" : "settled",
            ...diagnostics,
            ...next,
            sources,
          });
      }
    }
    if (
      next.recovering === snapshot.recovering &&
      next.attempt === snapshot.attempt &&
      next.shown === snapshot.shown &&
      next.reauthorized === snapshot.reauthorized
    )
      return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  const sourcesForReport = () =>
    sources.flatMap((source) =>
      source.name ? [{ name: source.name, status: source.status() }] : [],
    );
  const cancel = () => {
    if (timer === undefined) return;
    timers.clearTimeout(timer);
    timer = undefined;
  };
  const cancelNotice = () => {
    if (notice === undefined) return;
    timers.clearTimeout(notice);
    notice = undefined;
  };
  function evaluate() {
    if (disposed || running) return;
    // A source publishes its settled state before it releases the old read,
    // so its retry waits a turn rather than joining the read that is ending.
    for (const source of stale)
      if (source.status() !== "busy") {
        stale.delete(source);
        timers.setTimeout(() => {
          if (!disposed) source.retry();
        }, 0);
      }
    const states = sources.map((source) => source.status());
    if (!states.includes("failed")) {
      cancel();
      // A retry in flight is not proof of recovery: keep the notice and the
      // delay sequence until every source settles.
      if (snapshot.recovering && states.includes("busy")) {
        publish(
          Object.freeze({ recovering: true, attempt, shown, reauthorized }),
        );
        return;
      }
      cancelNotice();
      attempt = 0;
      shown = false;
      publish(idle());
      return;
    }
    publish(Object.freeze({ recovering: true, attempt, shown, reauthorized }));
    if (!shown && notice === undefined)
      notice = timers.setTimeout(() => {
        notice = undefined;
        if (disposed || !snapshot.recovering) return;
        shown = true;
        publish(
          Object.freeze({ recovering: true, attempt, shown, reauthorized }),
        );
      }, RECOVERY_NOTICE_DELAY_MS);
    if (timer !== undefined) return;
    const delay =
      RECOVERY_DELAYS_MS[Math.min(attempt, RECOVERY_DELAYS_MS.length - 1)] ??
      30_000;
    const dueAt = Date.now() + delay;
    const scheduled = performance.now();
    if (diagnostics)
      if (networkRecorder.collecting())
        networkRecorder.record({
          level: "info",
          event: "recovery.retry-scheduled",
          operationId,
          dueAt,
          ...diagnostics,
          attempt,
          delayMs: delay,
        });
    timer = timers.setTimeout(() => {
      timer = undefined;
      if (diagnostics)
        if (networkRecorder.collecting())
          networkRecorder.record({
            level: "info",
            event: "recovery.retry-fired",
            ...diagnostics,
            operationId,
            dueAt,
            delayMs: delay,
            attempt,
            latenessMs: Math.max(0, performance.now() - scheduled - delay),
          });
      attempt++;
      run();
    }, delay);
  }
  function run(except?: RecoverySource) {
    if (disposed) return;
    // Retries can publish synchronously; evaluate once after all of them.
    running = true;
    try {
      for (const source of sources)
        if (source !== except && source.status() === "failed") source.retry();
    } finally {
      running = false;
    }
    evaluate();
  }
  const stops = sources.map((source) => source.subscribe(evaluate));
  evaluate();
  return Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retryNow(
      except?: RecoverySource,
      trigger = except ? "source-connected" : "manual",
    ) {
      if (disposed) return;
      if (diagnostics)
        if (networkRecorder.collecting())
          networkRecorder.record({
            level: "info",
            event: "recovery.retry-now",
            operationId,
            detail: trigger,
            ...diagnostics,
          });
      cancel();
      attempt = 0;
      run(except);
    },
    retryAll() {
      if (disposed) return;
      if (diagnostics)
        if (networkRecorder.collecting())
          networkRecorder.record({
            level: "info",
            event: "recovery.reauthorize",
            operationId,
            detail: "credentials-changed",
            ...diagnostics,
          });
      cancel();
      attempt = 0;
      reauthorized++;
      running = true;
      try {
        for (const source of sources)
          if (source.reauthorize) source.reauthorize();
          else if (source.status() === "busy") stale.add(source);
          else source.retry();
      } finally {
        running = false;
      }
      evaluate();
      publish({ ...snapshot, reauthorized });
    },
    dispose() {
      if (diagnostics)
        if (networkRecorder.collecting())
          networkRecorder.record({
            level: "info",
            event: "recovery",
            operationId,
            outcome: "disposed",
            ...diagnostics,
            recovering: false,
            shown: false,
            sources: [],
          });
      disposed = true;
      cancel();
      cancelNotice();
      stale.clear();
      for (const stop of stops) stop();
      listeners.clear();
    },
  });
}
