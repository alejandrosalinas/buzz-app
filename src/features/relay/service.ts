import { abortNetwork } from "../developer/network-context";
import type { LocalAgentSource } from "../agents/local-activity";
import { networkRecorder } from "../developer/network-diagnostics";
import { readView } from "../../shared/view-state";
import type { LocalAgents } from "../agents/local";
import type { IdentityNames } from "../identity-names/service";
import type { PresenceActivity } from "../presence/activity";
import type { Context } from "@deepseek-ai/cordis";
import { createRelaySession, type RelaySession } from "./session";
import { createHeadPersistence } from "./persistence";
import {
  relayPartition,
  transportOrigin,
  transportPartition,
} from "./partition";
import { isTransientFailure, ReadError, readErrorKind } from "./errors";
import { RECOVERY_DELAYS_MS } from "./recovery";
import type { ReadTransport } from "./transport";
import { refusalOfError, type CommunityRefusal } from "./http-admission";
/** The snapshot's error for a refusal heard after connecting, for logs and
 * diagnostics; what it offers follows `refusal`, never this text. */
const REFUSAL_ERRORS: Record<CommunityRefusal, string> = {
  "sign-in": "Federated sign-in is required",
  access: "restricted: authorization denied",
};
const WAKE_TICK_MS = 5_000;
const WAKE_GAP_MS = 15_000;

export type RelaySnapshot = Readonly<{
  status: "disconnected" | "connecting" | "ready" | "error";
  generation: number;
  /** The persistence partition, `origin:viewer`. */
  scope?: string;
  /** The community's normalized origin, as `scope` was built from. */
  origin?: string;
  session: RelaySession;
  viewer?: string;
  error?: string;
  /** A usable device snapshot while the real transport is connecting/unavailable. */
  cached?: true;
  /** Only local disk bootstrap is pending; never waits for the network. */
  restoring?: true;
  /** This error is transient: the service reconnects without anyone acting. */
  retrying?: true;
  /** The community refused this account; not a connection problem. */
  denied?: true;
  /** Why, when the relay said: its sign-in ended, or it has no access. */
  refusal?: CommunityRefusal;
}>;
export type RelayData = {
  snapshot(): RelaySnapshot;
  subscribe(listener: () => void): () => void;
  retry(): void;
  disconnect(): void;
  clearCache(): Promise<void>;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    relay: RelayData;
  }
}

/** App-owned session. Plugins receive read models, never a signer or transport.
 * Reconnection replaces the session and invalidates all old async work. */
export function provideRelay(
  ctx: Context,
  connect?: (signal: AbortSignal) => Promise<ReadTransport>,
  presenceActivity?: PresenceActivity,
  identityNames?: IdentityNames,
  agentChoices?: LocalAgents,
  resume?: { viewer: string; scope: string },
  localAgents?: LocalAgentSource,
  verifyStored?: ReadTransport["verifyStored"],
) {
  let disposed = false;
  let generation = 0;
  let controller: AbortController | undefined;
  let connecting = false;
  let clearing: Promise<void> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let store = createRelaySession(null, { identityNames });
  let snapshot: RelaySnapshot = Object.freeze({
    status: "disconnected",
    generation,
    session: store.session,
  });
  const listeners = new Set<() => void>();
  // A connection that failed for a transient reason (network, timeout) always
  // tries again. Only disconnect() stops trying. A denial or a deterministic
  // failure keeps its error visible and waits for the user.
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnects = 0;
  /** Whether the latest connection failure can clear without anyone acting.
   * Later publishes of the same failure (cache handoff) keep it. */
  let transientFailure = false;
  const publish = ({ retrying: _retrying, ...next }: RelaySnapshot) => {
    if (next.status !== "error") transientFailure = false;
    snapshot = Object.freeze(
      transientFailure && !disposed
        ? { ...next, retrying: true as const }
        : next,
    );
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    if (next.status === "ready" && !next.cached) reconnects = 0;
    else if (next.status === "error" && transientFailure && !disposed)
      reconnectTimer = setTimeout(
        () => service.retry(),
        RECOVERY_DELAYS_MS[
          Math.min(reconnects++, RECOVERY_DELAYS_MS.length - 1)
        ] ?? 30_000,
      );
    for (const listener of listeners) listener();
  };
  const reset = () => {
    generation++;
    connecting = false;
    if (controller) abortNetwork(controller, "superseded", "relay-session");
    clearTimeout(deadline);
    store.dispose();
    store = createRelaySession(null, { identityNames });
  };
  async function restoreLocal(current: number, signal: AbortSignal) {
    if (!resume) return;
    const persistence = createHeadPersistence(resume.viewer, resume.scope);
    let cached: ReturnType<typeof createRelaySession> | undefined;
    let handedOff = false;
    try {
      const saved = (await persistence.readStartup?.())?.discovery;
      if (
        !saved ||
        !/^[0-9a-f]{64}$/.test(saved.relayAuthor) ||
        disposed ||
        current !== generation ||
        signal.aborted
      )
        return;
      cached = createRelaySession(
        {
          viewer: resume.viewer,
          scope: resume.scope,
          relayAuthor: saved.relayAuthor,
          query: () =>
            Promise.reject(
              new ReadError(
                "unavailable",
                "Reconnect to update saved conversations.",
              ),
            ),
          media: () => undefined,
          ...(verifyStored ? { verifyStored } : {}),
        },
        {
          identityNames,
          prepared: true,
          cachedOnly: true,
          persistence,
          initialChannelId: readView<string | undefined>(
            relayPartition(resume.scope, resume.viewer),
            "selected-channel",
            undefined,
          ),
        },
      );
      await cached.restore();
      if (
        disposed ||
        current !== generation ||
        signal.aborted ||
        !cached.session.channels.list().channels.length
      )
        return;
      store.dispose();
      store = cached;
      cached = undefined;
      handedOff = true;
      publish({
        status: connecting ? "connecting" : "error",
        cached: true,
        generation,
        viewer: resume.viewer,
        origin: resume.scope,
        scope: relayPartition(resume.scope, resume.viewer),
        session: store.session,
      });
    } catch {
      // Resume is an optimization; connection can still open an empty/corrupt cache.
    } finally {
      cached?.dispose();
      if (!handedOff) persistence.close();
      if (
        !disposed &&
        current === generation &&
        signal === controller?.signal &&
        snapshot.restoring
      ) {
        const { restoring: _restoring, ...settled } = snapshot;
        publish(settled);
      }
    }
  }
  /** The community refused this account: nothing it showed stays on screen,
   * and only signing in or Try again reconnects. A refusal of the account's
   * access also forgets what this device saved from it; an ended sign-in keeps
   * it for when the person signs in again. */
  async function deny(
    current: number,
    signal: AbortSignal,
    error: string,
    kind?: CommunityRefusal,
    /** The connection it refused, once one was made. */
    refused?: { viewer: string; origin: string },
  ) {
    const live = () =>
      !disposed &&
      !signal.aborted &&
      current === generation &&
      signal === controller?.signal;
    if (kind !== "sign-in") {
      await store.clearCache();
      if (resume) {
        const disk = createHeadPersistence(resume.viewer, resume.scope);
        try {
          await disk.clear();
        } catch {
          /* Storage can be unavailable. */
        } finally {
          disk.close();
        }
      }
    }
    if (!live()) return;
    store.dispose();
    store = createRelaySession(null, { identityNames });
    transientFailure = false;
    publish({
      status: "error",
      generation,
      session: store.session,
      error,
      denied: true,
      ...(kind ? { refusal: kind } : {}),
      // Sign-in recovery looks up this community's own sign-in by origin.
      ...refused,
    });
  }
  const service: RelayData & {
    /** The federated session changed to signed in: retry what it refused. */
    reauthorize(): void;
  } = {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {
      if (disposed || !connect || connecting || clearing) return;
      const retained = snapshot.cached;
      if (!retained) reset();
      connecting = true;
      const current = generation;
      controller = new AbortController();
      const signal = controller.signal;
      if (!retained)
        publish({
          status: "connecting",
          generation,
          session: store.session,
          // Only the first attempt bootstraps from disk behind the launch
          // surface; a retry after a failure keeps the app on screen.
          ...(resume && snapshot.status !== "error"
            ? { restoring: true as const }
            : {}),
        });
      else {
        const { error: _error, ...retainedSnapshot } = snapshot;
        publish({ ...retainedSnapshot, status: "connecting" });
      }
      const restoring = retained
        ? Promise.resolve()
        : restoreLocal(current, signal);
      const timer = setTimeout(() => {
        if (disposed || current !== generation || signal !== controller?.signal)
          return;
        abortNetwork(controller, "deadline", "relay-connect");
        connecting = false;
        transientFailure = true;
        publish({
          ...snapshot,
          status: "error",
          error: "Relay connection timed out. Try again.",
        });
      }, 8_000);
      deadline = timer;
      void Promise.resolve()
        .then(() => connect(signal))
        .then(async (transport) => {
          clearTimeout(timer);
          // A request can be refused while this connection is still being
          // prepared, or at any time after: either way the community is.
          let refused: CommunityRefusal | undefined;
          let ready = false;
          const refuse = (kind: CommunityRefusal) =>
            deny(current, signal, REFUSAL_ERRORS[kind], kind, {
              viewer: transport.viewer,
              origin: transportOrigin(transport),
            });
          const stopRefusals = transport.observeRefusal?.((kind) => {
            if (refused || disposed || current !== generation) return;
            refused = kind;
            if (ready) void refuse(kind);
          });
          if (stopRefusals)
            signal.addEventListener("abort", stopRefusals, { once: true });
          await restoring;
          if (
            disposed ||
            signal.aborted ||
            current !== generation ||
            signal !== controller?.signal
          )
            return;
          const successor = createRelaySession(transport, {
            identityNames,
            agentChoices,
            localAgents,
            ...(presenceActivity ? { presenceActivity } : {}),
            prepared: true,
            // Keep intent preparation, but do not fetch every unopened channel.
            warm: false,
            initialChannelId: readView<string | undefined>(
              transportPartition(transport),
              "selected-channel",
              undefined,
            ),
            persistence: createHeadPersistence(
              transport.viewer,
              transportOrigin(transport),
            ),
          });
          await successor.restore();
          if (
            disposed ||
            signal.aborted ||
            current !== generation ||
            signal !== controller?.signal
          ) {
            successor.dispose();
            return;
          }
          // Materialize retained readers before publishing so React never sees
          // an idle window between two already-hydrated owners.
          for (const id of store.retainedChannels())
            successor.session.channels.ensure(id);
          store.dispose();
          store = successor;
          if (refused) {
            await refuse(refused);
            return;
          }
          publish({
            status: "ready",
            generation,
            viewer: transport.viewer,
            origin: transportOrigin(transport),
            scope: transportPartition(transport),
            session: store.session,
          });
          ready = true;
          store.session.channels.ensureList();
        })
        .catch(async (error) => {
          await restoring;
          if (
            disposed ||
            signal.aborted ||
            current !== generation ||
            signal !== controller?.signal
          )
            return;
          if (readErrorKind(error) === "denied")
            await deny(current, signal, String(error), refusalOfError(error));
          else {
            transientFailure = isTransientFailure(error);
            publish({
              ...snapshot,
              status: "error",
              error: String(error),
            });
          }
        })
        .finally(() => {
          clearTimeout(timer);
          if (current === generation && signal === controller?.signal)
            connecting = false;
        });
    },
    reauthorize() {
      if (disposed) return;
      if (snapshot.status === "error") service.retry();
      else store.session.recovery?.retryAll();
    },
    disconnect() {
      if (disposed) return;
      reset();
      publish({ status: "disconnected", generation, session: store.session });
    },
    clearCache() {
      if (clearing) return clearing;
      if (disposed) return Promise.resolve();
      // Clearing owns a separate fence: an aborted connection's finally cannot
      // release it and let retry restore records still being deleted from disk.
      const current = generation;
      const reconnect = connecting || snapshot.cached;
      const retainedStore = store;
      controller?.abort();
      clearTimeout(deadline);
      connecting = false;
      clearing = Promise.resolve()
        .then(async () => {
          await retainedStore.clearCache();
          if (resume) {
            const disk = createHeadPersistence(resume.viewer, resume.scope);
            try {
              await disk.clear();
            } catch {
              /* Storage can be unavailable. */
            } finally {
              disk.close();
            }
          }
        })
        .finally(() => {
          clearing = undefined;
          if (!disposed && current === generation && reconnect) service.retry();
        });
      return clearing;
    },
  };
  ctx.provide("relay", service);
  ctx.effect(() => {
    // Network, focus and wake are hints that the relay may answer again, and
    // that a socket which still looks open may have died while asleep.
    // Failed background reads retry now; a live socket is asked to answer.
    const hint = (
      network: boolean,
      source: "online" | "focus" | "visible" | "wake",
    ) => {
      networkRecorder.record({
        level: "info",
        event: "signal",
        relay: snapshot.origin,
        detail: source,
      });
      if (snapshot.cached) service.retry();
      else {
        store.session.recovery?.retryNow(
          undefined,
          source === "wake" ? "wake-gap" : source,
        );
        store.session.checkLive(network);
      }
    };
    const resume = () => hint(false, "focus");
    // A socket that answered just before a network change proves nothing after it.
    const network = () => hint(true, "online");
    const visible = () => {
      if (document.visibilityState === "visible") hint(false, "visible");
    };
    // Timers stop while the machine sleeps. A large gap between ticks means
    // it woke up, which a desktop window does not always report as focus.
    let tick = Date.now();
    const wake = setInterval(() => {
      const now = Date.now();
      if (now - tick > WAKE_GAP_MS) hint(false, "wake");
      tick = now;
    }, WAKE_TICK_MS);
    if (typeof window !== "undefined") {
      window.addEventListener("online", network);
      window.addEventListener("focus", resume);
    }
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      clearInterval(wake);
      clearTimeout(reconnectTimer);
      reset();
      listeners.clear();
      if (typeof window !== "undefined") {
        window.removeEventListener("online", network);
        window.removeEventListener("focus", resume);
      }
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", visible);
    };
  });
  service.retry();
  return service;
}
