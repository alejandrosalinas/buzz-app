import type { Context } from "@deepseek-ai/cordis";
import {
  createNavigationController,
  NAVIGATION_ABORTED,
  type Navigation,
  type OpenAttempt,
  type OpenResult,
  type NavigationFocus,
} from "./controller";
import { createBrowserHistory } from "./browser-history";
import { createMemoryHistory, type NavigationEntry } from "./history";
import {
  coversWorkspace,
  targetKey,
  withoutJoin,
  type JsonValue,
  type OpenTarget,
} from "./targets";
import type { RelayData, RelaySnapshot } from "../relay/service";

export type PageNavigation = Readonly<{
  entryId: string;
  target: OpenTarget;
  signal: AbortSignal;
  /** Suppress destination autofocus when the opening control retains focus. */
  focus?: NavigationFocus;
  /** Back/Forward returned to this visit. A consumer that kept its state may
   * restore it rather than replay the visit's opening. */
  traversal?: true;
  /** This visit's state under a consumer's key, kept for Back/Forward until
   * the shared store evicts it. */
  position(key: string): JsonValue | undefined;
  /** Usable after this presentation is revoked, so leaving can record it.
   * Every visit and consumer shares one store that keeps the latest 100
   * entries, so use few keys and small values: never drafts, message bodies,
   * credentials or authorization. */
  savePosition(key: string, value: JsonValue): void;
  /** Bind a domain subtree to the exact connection it renders, without another visit. */
  forSession(relay: RelayData, connection: RelaySnapshot): PageNavigation;
  /** Resolve the pending visit's default destination without replacing its caller. */
  resolve(target: OpenTarget): boolean;
  /** While registered, `passes` says whether this visit holds nothing to come
   * back to; then the next page opened from it takes its place in history.
   * Returns the unregister function. */
  passThrough(passes: () => boolean): () => void;
  complete(
    result: Extract<OpenResult, { status: "opened" | "failed" }>,
  ): boolean;
}>;
declare module "@deepseek-ai/cordis" {
  interface Context {
    navigation: Navigation;
  }
}
export function provideNavigation(
  ctx: Context,
  host = typeof window === "undefined" ? undefined : window,
) {
  const controller = createNavigationController(
    host ? createBrowserHistory(host) : createMemoryHistory(),
  );
  ctx.provide("navigation", controller.navigation);
  const positions = new Map<string, JsonValue>();
  ctx.effect(() => () => {
    controller.dispose();
    positions.clear();
  });
  const position = (id: string) => positions.get(id);
  function savePosition(id: string, value: JsonValue) {
    positions.delete(id);
    positions.set(id, value);
    while (positions.size > 100) {
      const first = positions.keys().next().value;
      if (first) positions.delete(first);
    }
  }
  return {
    ...controller,
    position,
    savePosition,
    request(
      attempt: OpenAttempt,
      owner: PresentationOwner,
      retainWhileCovered = false,
    ) {
      let active = attempt;
      let suspended = false;
      let resolution: OpenTarget | undefined;
      let completion:
        | Extract<OpenResult, { status: "opened" | "failed" }>
        | undefined;
      const retainedSignal = retainWhileCovered
        ? new AbortController().signal
        : attempt.signal;
      const visit = (key: string) => JSON.stringify([attempt.entry.id, key]);
      // Another visit covers this view: Settings or a join dialog over a page,
      // a join dialog over Settings. A join presented with its own view, as
      // after reload, covers nothing.
      const covered = (entry: NavigationEntry) =>
        entry.id !== attempt.entry.id &&
        (attempt.entry.target.kind === "settings"
          ? entry.target.join !== undefined
          : coversWorkspace(entry.target));
      const sameVisit = (next: OpenAttempt) =>
        next.entry.id === attempt.entry.id &&
        targetKey(next.entry.target) === targetKey(attempt.entry.target);
      const current = () => {
        const state = controller.navigation.snapshot();
        return (
          !state.ingress && state.attempt === active && !active.signal.aborted
        );
      };
      const presentation = bindPresentation(
        {
          entryId: attempt.entry.id,
          // Presenters see the visit beneath a join dialog, never the dialog.
          target: withoutJoin(attempt.entry.target),
          signal: retainedSignal,
          ...(attempt.traversal && { traversal: attempt.traversal }),
          get focus() {
            return active === attempt
              ? (attempt.focus ?? "content")
              : "preserve";
          },
          position: (key) => position(visit(key)),
          savePosition: (key, value) => savePosition(visit(key), value),
          passThrough: (passes) =>
            controller.passThrough(attempt.entry.id, passes),
          resolve: (target) => {
            if (
              retainWhileCovered &&
              covered(controller.navigation.snapshot().entry)
            ) {
              resolution = target;
              return false;
            }
            return current() && controller.resolve(active, target);
          },
          complete: (result) => {
            const state = controller.navigation.snapshot();
            if (retainWhileCovered && covered(state.entry)) {
              completion = result;
              return false;
            }
            const accepted = current() && controller.complete(active, result);
            if (accepted) completion = result;
            return accepted;
          },
        },
        {
          valid: () => {
            if (!owner.valid()) return false;
            if (current()) return true;
            const state = controller.navigation.snapshot();
            if (retainWhileCovered && !state.ingress && covered(state.entry)) {
              suspended = true;
              return true;
            }
            return (
              retainWhileCovered &&
              suspended &&
              !state.ingress &&
              sameVisit(state.attempt) &&
              !state.attempt.signal.aborted
            );
          },
          subscribe(listener) {
            const stopOwner = owner.subscribe(listener);
            const stopAttempt = controller.navigation.subscribe(listener);
            return () => {
              stopOwner();
              stopAttempt();
            };
          },
        },
      );
      return {
        ...presentation,
        /** Resume only the original visit; retained content cannot acknowledge Settings. */
        resume(next: OpenAttempt) {
          if (
            !retainWhileCovered ||
            !suspended ||
            presentation.request.signal.aborted ||
            !sameVisit(next) ||
            next !== controller.navigation.snapshot().attempt ||
            next.signal.aborted ||
            !owner.valid()
          )
            return false;
          active = next;
          suspended = false;
          if (resolution) controller.resolve(active, resolution);
          else if (completion) controller.complete(active, completion);
          return true;
        },
      };
    },
  };
}

/** Presentation authority is narrower than the pending visit's lifetime. */
export type PresentationOwner = {
  valid(): boolean;
  subscribe(listener: () => void): () => void;
};
function bindPresentation(
  parent: Omit<PageNavigation, "forSession">,
  owner: PresentationOwner,
) {
  const lifetime = new AbortController();
  const sessions = new WeakMap<
    RelayData,
    WeakMap<RelaySnapshot, PageNavigation>
  >();
  let stop = () => {};
  function dispose() {
    if (lifetime.signal.aborted) return;
    // Commit revocation before invoking abort listeners or other external code.
    lifetime.abort(parent.signal.reason ?? NAVIGATION_ABORTED);
    stop();
    parent.signal.removeEventListener("abort", dispose);
  }
  const valid = () => {
    if (lifetime.signal.aborted) return false;
    if (parent.signal.aborted || !owner.valid()) {
      dispose();
      return false;
    }
    return true;
  };
  const request: PageNavigation = Object.freeze({
    entryId: parent.entryId,
    target: parent.target,
    signal: lifetime.signal,
    ...(parent.traversal && { traversal: parent.traversal }),
    get focus() {
      return parent.focus ?? "content";
    },
    position: parent.position,
    savePosition: parent.savePosition,
    resolve: (target) => valid() && parent.resolve(target),
    complete: (result) => valid() && parent.complete(result),
    passThrough: (passes) => parent.passThrough(passes),
    forSession(relay, connection) {
      let connections = sessions.get(relay);
      if (!connections) {
        connections = new WeakMap();
        sessions.set(relay, connections);
      }
      const existing = connections.get(connection);
      if (existing && !existing.signal.aborted) return existing;
      const bound = bindPresentation(request, {
        valid: () => {
          const current = relay.snapshot();
          return (
            current.session === connection.session &&
            current.generation === connection.generation &&
            current.scope === connection.scope &&
            current.status === connection.status
          );
        },
        subscribe: relay.subscribe,
      });
      connections.set(connection, bound.request);
      return bound.request;
    },
  });
  parent.signal.addEventListener("abort", dispose, { once: true });
  stop = owner.subscribe(() => {
    valid();
  });
  // Registration/session can already be obsolete before React commits the new tree.
  if (!valid()) stop();
  return { request, dispose };
}
