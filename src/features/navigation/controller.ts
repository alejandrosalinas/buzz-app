import { parseOpenTarget, targetKey, type OpenTarget } from "./targets";
import type {
  DismissedVisits,
  NavigationEntry,
  NavigationHistory,
} from "./history";

/**
 * Shared abort reason. A reason-less abort() makes Blink mint a DOMException per
 * call, and V8 keeps its unformatted stack alive: that stack holds the start()
 * scope (so the next attempt) and the click dispatch (so the unmounted DOM).
 * One instance captures no per-abort stack, so its .stack points at module
 * evaluation, not the aborting site: do not use it for diagnostics.
 */
export const NAVIGATION_ABORTED = new DOMException(
  "Navigation attempt aborted",
  "AbortError",
);

export type OpenFailure =
  | "invalid-target"
  | "unavailable"
  | "denied"
  | "not-found"
  | "timeout"
  | "host-error";
export type OpenResult = Readonly<
  | { status: "opened" }
  | { status: "cancelled" | "superseded" }
  | {
      status: "failed";
      reason: OpenFailure;
      /** The page shows this failure in place, next to what failed; the host
       * keeps the page on screen instead of replacing it. */
      presented?: true;
      /** Reopen this visit once, while it is still the one shown: called
       * with that reopen, returns its cancel (see reauthorizedOnce). */
      reauthorize?: (reopen: () => void) => () => void;
    }
>;
/** Focus is per opening, never part of a saved address or history entry. */
export type NavigationFocus = "content" | "preserve";
export type NavigationOpenOptions = {
  replace?: boolean;
  /** @deprecated For explicit Close use Navigation.dismiss, which retires visits.
   * Legacy return/replace behavior: this option does not retire restoration visits.
   * Return to the visit behind this one when it matches, otherwise replace it.
   * When the host traverses asynchronously, the return lands after open()
   * resolves, so the resolved result describes the visit being left. */
  dismiss?: boolean;
  focus?: NavigationFocus;
};
export type OpenAttempt = Readonly<{
  id: string;
  entry: NavigationEntry;
  signal: AbortSignal;
  focus?: NavigationFocus;
  /** History traversal returned to a visit it already held; not opened again. */
  traversal?: true;
}>;
export type NavigationSnapshot = Readonly<{
  entry: NavigationEntry;
  attempt: OpenAttempt;
  status: "opening" | OpenResult["status"];
  reason?: OpenFailure;
  /** The failed page presents its own failure in place. */
  presented?: true;
  /** An incoming URL failed before it could create a history destination. */
  ingress?: boolean;
  retryable?: boolean;
  retainedVisits?: readonly string[] | undefined;
  canGoBack: boolean;
  canGoForward: boolean;
}>;
export type Navigation = Readonly<{
  snapshot(): NavigationSnapshot;
  subscribe(listener: () => void): () => void;
  open(
    target: OpenTarget,
    options?: NavigationOpenOptions,
  ): Promise<OpenResult>;
  back(): void;
  forward(): void;
  /** Explicit dismissal retires content visits; passive traversal retains them. */
  dismiss(visits: DismissedVisits, fallback: OpenTarget): void;
  retry(): Promise<OpenResult>;
}>;

/** The host alone receives completion/cancellation authority. Plugins get Navigation. */
export function createNavigationController(
  history: NavigationHistory,
  timeoutMs = 15_000,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1)
    throw new Error("Invalid open timeout");
  type Operation = {
    attempt: OpenAttempt;
    controller: AbortController;
    promise: Promise<OpenResult>;
    resolve: (result: OpenResult) => void;
    pending: boolean;
    timer?: ReturnType<typeof setTimeout> | undefined;
    /** Cancels a failed visit's reopen after sign-in. */
    reauthorizing?: () => void;
    /** Timed out on the shown page, which stayed: it may still answer. */
    late?: boolean;
  };
  let disposed = false;
  let active: Operation;
  let snapshot: NavigationSnapshot;
  // The deadline measures a presenter. None may exist yet (the identity and
  // key-setup gate, IdentitySetup, hides the app for minutes), so it runs only
  // while one is attached.
  let presenters = 0;
  // The visit whose page is on screen. A later attempt on it (a retry, a
  // same-target open, a reopen after sign-in) that times out leaves that page
  // up: background work never replaces content already shown.
  let shown: string | undefined;
  let ingressRetry: (() => Promise<OpenResult>) | undefined;
  // Visits whose page currently reports nothing worth returning to.
  const passing = new Map<string, () => boolean>();
  // A page that cannot answer keeps its visit, never the opening.
  const passes = (entryId: string) => {
    try {
      return passing.get(entryId)?.() === true;
    } catch {
      return false;
    }
  };
  const listeners = new Set<() => void>();
  // Commit state and capture each caller's result before invoking external code.
  // Reentrant opens run against committed state and own their own result; deferred
  // abort/notification effects never resume a half-written state transition.
  let depth = 0;
  let draining = false;
  const effects: (() => void)[] = [];
  function transaction<T>(run: () => T): T {
    depth++;
    try {
      return run();
    } finally {
      depth--;
      if (!depth && !draining) {
        draining = true;
        try {
          while (effects.length) effects.shift()?.();
        } finally {
          draining = false;
        }
      }
    }
  }
  const emit = () =>
    effects.push(() => {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          console.error("Navigation observer failed");
        }
      }
    });
  function settle(operation: Operation, result: OpenResult) {
    if (!operation.pending) return;
    operation.pending = false;
    clearTimeout(operation.timer);
    operation.resolve(result);
  }
  function arm(operation: Operation) {
    if (!presenters || !operation.pending || operation.timer) return;
    operation.timer = setTimeout(
      () =>
        transaction(() => {
          finish(
            operation,
            { status: "failed", reason: "timeout" },
            "deadline",
          );
        }),
      timeoutMs,
    );
  }
  /**
   * `source`: "deadline" when this controller's own deadline passed; "answer"
   * when the page or host answered, which a kept attempt may still do late;
   * "host" when the host ends the attempt itself, which keeps no page.
   */
  function finish(
    operation: Operation,
    outcome: OpenResult,
    source: "deadline" | "answer" | "host",
  ) {
    if (
      operation !== active ||
      !(operation.pending || (source === "answer" && operation.late))
    )
      return;
    operation.late = false;
    // A page that stays silent past the deadline keeps showing what it showed.
    // Any failure that is answered, a timeout included, still replaces it with
    // the host's explanation and Retry, as does a rejected incoming link. That
    // covers the host's own report that it was not drawing the kept page.
    const result: OpenResult =
      source === "deadline" &&
      outcome.status === "failed" &&
      !snapshot.ingress &&
      operation.attempt.entry.id === shown
        ? { ...outcome, presented: true }
        : outcome;
    if (result !== outcome) operation.late = true;
    if (result.status === "opened") shown = operation.attempt.entry.id;
    // The host's failure now covers the page.
    else if (result.status === "failed" && !result.presented) shown = undefined;
    // A late answer resolves no caller: settle already ran at the deadline.
    settle(operation, result);
    const { reason: _reason, presented: _presented, ...current } = snapshot;
    snapshot = Object.freeze({
      ...current,
      status: result.status,
      ...(result.status === "failed"
        ? {
            reason: result.reason,
            ...(result.presented ? { presented: true as const } : {}),
          }
        : {}),
    });
    // A failure presented in place keeps its page's authority until the visit
    // is left or replaced, as an opened visit does.
    if (
      result.status !== "opened" &&
      !(result.status === "failed" && result.presented)
    )
      effects.push(() => operation.controller.abort(NAVIGATION_ABORTED));
    const reauthorize = result.status === "failed" && result.reauthorize;
    if (reauthorize)
      effects.push(() => {
        if (active !== operation || disposed) return;
        operation.reauthorizing = reauthorize(() =>
          transaction(() => {
            if (active === operation && !disposed)
              start(operation.attempt.focus);
          }),
        );
      });
    emit();
  }
  function start(
    focus: NavigationFocus = "content",
    traversal = false,
  ): Promise<OpenResult> {
    if (disposed) return Promise.resolve({ status: "cancelled" });
    ingressRetry = undefined;
    const old = active;
    old?.reauthorizing?.();
    if (old) {
      settle(old, { status: "superseded" });
      effects.push(() => old.controller.abort(NAVIGATION_ABORTED));
    }
    const controller = new AbortController();
    const state = history.snapshot();
    if (state.current.id !== shown) shown = undefined;
    const attempt: OpenAttempt = Object.freeze({
      id: crypto.randomUUID(),
      entry: state.current,
      signal: controller.signal,
      focus,
      ...(traversal && { traversal }),
    });
    let resolve: (result: OpenResult) => void = () => {};
    const promise = new Promise<OpenResult>((settle) => {
      resolve = settle;
    });
    const operation: Operation = {
      attempt,
      controller,
      promise,
      resolve,
      pending: true,
    };
    active = operation;
    snapshot = Object.freeze({
      entry: state.current,
      attempt,
      status: "opening",
      retainedVisits: state.retainedVisits,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
    });
    if (state.invalidAddress) {
      finish(operation, { status: "failed", reason: "invalid-target" }, "host");
      return promise;
    }
    arm(operation);
    emit();
    return promise;
  }
  let departureGuard:
    | ((next: OpenTarget, decide: (proceed: boolean) => void) => boolean)
    | undefined;
  let departure: { from: string; to: string; proceed: boolean } | undefined;
  function resumeDeparture(pending: NonNullable<typeof departure>) {
    if (history.returnTo(pending.to)) return;
    const previous = history.snapshot().previous;
    if (previous) {
      pending.to = previous.id;
      if (history.returnTo(previous.id)) return;
    }
    departure = undefined;
  }
  let admittingOpen = false;
  let opening = false;
  let openingDecision: { settle: (result: OpenResult) => void } | undefined;
  let resolving: Operation | undefined;
  // Both host drivers publish pushes synchronously; consume this opening only.
  let openingFocus: NavigationFocus | undefined;
  // A dismissal's traversal may publish after open() returns; it keeps its focus.
  let returningFocus: NavigationFocus | undefined;
  const unsubscribe = history.attach(() => {
    transaction(() => {
      if (resolving && active === resolving) {
        // Domain normalization keeps the caller, visit, signal and original deadline.
        // Rotate the immutable attempt token so an old presentation cannot complete it.
        const state = history.snapshot();
        active.attempt = Object.freeze({
          ...active.attempt,
          entry: state.current,
        });
        snapshot = Object.freeze({
          ...snapshot,
          retainedVisits: state.retainedVisits,
          entry: state.current,
          attempt: active.attempt,
          canGoBack: state.canGoBack,
          canGoForward: state.canGoForward,
        });
        emit();
      } else {
        const state = history.snapshot();
        if (departure?.from === state.current.id) {
          if (departure.proceed) resumeDeparture(departure);
          return;
        }
        const admitted =
          departure?.proceed && departure.to === state.current.id;
        if (admitted) departure = undefined;
        if (
          !admitted &&
          !opening &&
          state.current.id !== active.attempt.entry.id &&
          departureGuard
        ) {
          const pending = {
            from: active.attempt.entry.id,
            to: state.current.id,
            proceed: false,
          };
          departure = pending;
          const blocked = departureGuard(state.current.target, (proceed) => {
            if (departure !== pending) return;
            if (!proceed) {
              departure = undefined;
              return;
            }
            pending.proceed = true;
            if (history.snapshot().current.id === pending.from)
              resumeDeparture(pending);
          });
          if (blocked) {
            history.returnTo(pending.from);
            return;
          }
          departure = undefined;
        }
        if (state.current === active.attempt.entry) {
          snapshot = Object.freeze({
            ...snapshot,
            retainedVisits: state.retainedVisits,
            canGoBack: state.canGoBack,
            canGoForward: state.canGoForward,
          });
          emit();
          return;
        }
        const focus = openingFocus ?? returningFocus;
        openingFocus = returningFocus = undefined;
        // A return lands on a visit history already held. open() publishes
        // while opening, and a driver mints a new visit for an edited address
        // or a dismissal's fallback; none of those returns.
        start(
          focus,
          !opening && !!snapshot.retainedVisits?.includes(state.current.id),
        );
      }
    });
  });
  transaction(start);
  const navigation: Navigation = Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open(input: OpenTarget, options?: NavigationOpenOptions) {
      return transaction(() => {
        if (disposed)
          return Promise.resolve<OpenResult>({ status: "cancelled" });
        let target: OpenTarget;
        try {
          target = parseOpenTarget(input);
        } catch {
          return Promise.resolve<OpenResult>({
            status: "failed",
            reason: "invalid-target",
          });
        }
        if (
          !admittingOpen &&
          departureGuard &&
          targetKey(target) !== targetKey(snapshot.entry.target)
        ) {
          openingDecision?.settle({ status: "superseded" });
          let settle: (result: OpenResult) => void = () => {};
          const result = new Promise<OpenResult>((resolve) => {
            settle = resolve;
          });
          const pending = { settle };
          openingDecision = pending;
          const blocked = departureGuard(target, (proceed) => {
            if (openingDecision !== pending) return;
            openingDecision = undefined;
            if (!proceed) {
              settle({ status: "cancelled" });
              return;
            }
            admittingOpen = true;
            try {
              void navigation.open(target, options).then(settle);
            } finally {
              admittingOpen = false;
            }
          });
          if (blocked) return result;
          openingDecision = undefined;
        }
        try {
          if (
            !history.snapshot().invalidAddress &&
            targetKey(target) === targetKey(history.snapshot().current.target)
          )
            return start(options?.focus);
          opening = true;
          openingFocus = options?.focus;
          returningFocus = undefined;
          // A passing visit leaves as a dismissal does: back to its opener when
          // that is the page opening, else replaced by it. Settings returns to
          // that visit, so it never replaces it. Any forward entries stay.
          const dismiss =
            options?.dismiss ||
            (target.kind !== "settings" &&
              passes(history.snapshot().current.id));
          const previous = history.snapshot().previous;
          if (
            dismiss &&
            previous &&
            targetKey(previous.target) === targetKey(target) &&
            history.returnTo(previous.id)
          ) {
            if (openingFocus) returningFocus = openingFocus;
            return active.promise;
          }
          if (options?.replace || dismiss) history.replace(target);
          else {
            const { current, previous } = history.snapshot();
            if (
              !history.snapshot().invalidAddress &&
              current.target.kind === "conversation" &&
              current.target.panel === "members"
            ) {
              const { panel: _panel, ...channel } = current.target;
              if (previous && targetKey(previous.target) === targetKey(channel))
                history.replace(target);
              else {
                // A cold Members link still needs its channel beneath a handoff.
                resolving = active;
                try {
                  history.resolve(channel);
                } finally {
                  resolving = undefined;
                }
                history.push(target);
              }
            } else history.push(target);
          }
          return active.promise;
        } catch {
          // Drivers commit atomically and notify only their exclusive controller.
          return Promise.resolve<OpenResult>({
            status: "failed",
            reason: "host-error",
          });
        } finally {
          opening = false;
          openingFocus = undefined;
        }
      });
    },
    back() {
      transaction(() => {
        if (!disposed) history.back();
      });
    },
    forward() {
      transaction(() => {
        if (!disposed) history.forward();
      });
    },
    dismiss(visits, fallback) {
      transaction(() => {
        if (!disposed) history.dismiss(visits, fallback);
      });
    },
    retry() {
      if (snapshot.ingress) {
        if (disposed) return Promise.resolve({ status: "cancelled" as const });
        return (
          ingressRetry?.() ??
          Promise.resolve<OpenResult>({
            status: "failed",
            reason: snapshot.reason ?? "invalid-target",
          })
        );
      }
      return transaction(() => start(snapshot.attempt.focus));
    },
  });
  return {
    navigation,
    /** Shell-owned draft guard; native traversal bounces before presentation unmounts. */
    guardDeparture(guard: NonNullable<typeof departureGuard>) {
      departureGuard = guard;
      return () => {
        if (departureGuard === guard) {
          departureGuard = undefined;
          openingDecision?.settle({ status: "cancelled" });
          openingDecision = undefined;
          departure = undefined;
        }
      };
    },
    /**
     * Host-only: a presenter now exists. The pending visit's deadline starts (or
     * restarts) here and stops when the last presenter detaches, so an attempt
     * nobody could present never times out, while one a presenter stalls on does.
     */
    attach() {
      presenters++;
      arm(active);
      let attached = true;
      return () => {
        if (!attached) return;
        attached = false;
        presenters--;
        if (presenters) return;
        clearTimeout(active.timer);
        active.timer = undefined;
      };
    },
    /** Normalize a pending presentation, not a new intent; never reset its deadline. */
    resolve(attempt: OpenAttempt, input: OpenTarget) {
      return transaction(() => {
        if (
          disposed ||
          attempt !== active.attempt ||
          attempt.signal.aborted ||
          // A kept page may still normalize before its late answer.
          (!active.pending && !active.late)
        )
          return false;
        try {
          const target = parseOpenTarget(input);
          if (targetKey(target) === targetKey(snapshot.entry.target))
            return true;
          resolving = active;
          history.resolve(target);
          return true;
        } catch {
          return false;
        } finally {
          resolving = undefined;
        }
      });
    },
    /** Acknowledge only the exact active attempt after actual presentation. */
    complete(
      attempt: OpenAttempt,
      result: Extract<OpenResult, { status: "opened" | "failed" }>,
    ) {
      return transaction(() => {
        if (
          disposed ||
          attempt !== active.attempt ||
          attempt.signal.aborted ||
          (!active.pending && !active.late)
        )
          return false;
        // A kept page may still answer after its deadline, either way.
        finish(active, result, "answer");
        return true;
      });
    },
    /** While registered, the page presenting visit `entryId` reports through
     * `passes` whether it holds anything to come back to. When it holds
     * nothing, the next page opened from it replaces it in history. */
    passThrough(entryId: string, passes: () => boolean) {
      passing.set(entryId, passes);
      return () => {
        if (passing.get(entryId) === passes) passing.delete(entryId);
      };
    },
    /** Host-only traversal to a retained visit; does not retire dismissed content. */
    returnTo(entryId: string) {
      return transaction(() => !disposed && history.returnTo(entryId));
    },
    cancel() {
      transaction(() => {
        ingressRetry = undefined;
        const operation = active;
        finish(operation, { status: "cancelled" }, "host");
        effects.push(() => operation.controller.abort(NAVIGATION_ABORTED));
      });
    },
    /** Keep pre-navigation recovery separate from the previous history visit. */
    fail(reason: OpenFailure, retry?: () => Promise<OpenResult>) {
      transaction(() => {
        if (disposed) return;
        void start();
        ingressRetry = retry;
        snapshot = Object.freeze({
          ...snapshot,
          ingress: true,
          retryable: !!retry,
        });
        finish(active, { status: "failed", reason }, "host");
      });
    },
    dispose() {
      transaction(() => {
        if (disposed) return;
        disposed = true;
        openingDecision?.settle({ status: "cancelled" });
        openingDecision = undefined;
        departure = undefined;
        ingressRetry = undefined;
        active.reauthorizing?.();
        unsubscribe();
        finish(active, { status: "cancelled" }, "host");
        const operation = active;
        effects.push(() => operation.controller.abort(NAVIGATION_ABORTED));
        listeners.clear();
        passing.clear();
        history.dispose();
      });
    },
  };
}
