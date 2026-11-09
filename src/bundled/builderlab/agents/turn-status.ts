import type { RelayData } from "../../../features/relay/service";
import type { RelaySession } from "../../../features/relay/session";
import type { BuilderlabSession, Credential } from "../session";
import { type AgentClient, isRetryableAgentRead } from "./client";

/** Recover missed terminals, backing off when a task has no saved outcome yet.
 * The client owns HTTP retries; this owner schedules later outcome lookups. */
export function startTurnStatusRecovery({
  relay,
  session,
  client,
}: {
  relay: RelayData;
  session: BuilderlabSession;
  client: AgentClient;
}) {
  let current: RelaySession | undefined;
  let credential: Credential | undefined;
  let stopActivity: (() => void) | undefined;
  let controller: AbortController | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const attempted = new Map<string, { at: number; delay: number }>();

  function cancelRetry() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function attach() {
    const connection = relay.snapshot();
    const signedIn = session.snapshot();
    const next =
      connection.status === "ready" &&
      !connection.cached &&
      signedIn.status === "signed-in" &&
      signedIn.account?.canUseRemoteAgents
        ? connection.session
        : undefined;
    const account = next ? session.credential() : undefined;
    if (next === current && account === credential) return;
    stopActivity?.();
    cancelRetry();
    controller?.abort();
    controller = undefined;
    attempted.clear();
    current = next;
    credential = account;
    if (!next) return;
    const activity = next.agentActivity;
    let running = false;
    async function run() {
      if (disposed || current !== next || credential !== account) return;
      if (activity.snapshot().status !== "listening") {
        cancelRetry();
        controller?.abort();
        controller = undefined;
        attempted.clear();
        return;
      }
      if (running) return;
      cancelRetry();
      controller ??= new AbortController();
      const active = controller;
      running = true;
      try {
        for (;;) {
          active.signal.throwIfAborted();
          const retained = activity.snapshot().turns;
          const keys = new Set(
            retained.map((turn) => `${turn.agent}:${turn.turnId}`),
          );
          for (const key of attempted.keys())
            if (!keys.has(key)) attempted.delete(key);
          const unknown = retained.filter(
            (turn) =>
              turn.state === "unknown" &&
              turn.sessionId &&
              turn.channelId &&
              (attempted.get(`${turn.agent}:${turn.turnId}`)?.at ?? 0) <=
                Date.now(),
          );
          const first = unknown[0];
          if (!first?.sessionId || !first.channelId) break;
          const group = unknown
            .filter(
              (turn) =>
                turn.agent === first.agent &&
                turn.sessionId === first.sessionId &&
                turn.channelId === first.channelId,
            )
            .slice(0, 64);
          for (const turn of group) {
            const key = `${turn.agent}:${turn.turnId}`;
            attempted.set(key, {
              at: Infinity,
              delay: Math.min((attempted.get(key)?.delay ?? 15000) * 2, 300000),
            });
          }
          let outcomes:
            | Awaited<ReturnType<AgentClient["turnStatus"]>>
            | undefined;
          try {
            const listed = await client.list(active.signal);
            if (!listed.some((agent) => agent.pubkey === first.agent)) continue;
            outcomes = await client.turnStatus(
              first.sessionId,
              group.map((turn) => turn.turnId),
              active.signal,
            );
          } catch (error) {
            active.signal.throwIfAborted();
            if (
              error instanceof Error &&
              "status" in error &&
              error.status === 404
            )
              continue;
            console.warn("Builderlab turn status lookup failed", error);
            if (!isRetryableAgentRead(error)) continue;
          }
          active.signal.throwIfAborted();
          for (const turn of group) {
            const outcome = outcomes?.get(turn.turnId);
            if (outcome) activity.reconcile(turn, outcome);
            else {
              const key = `${turn.agent}:${turn.turnId}`;
              const retry = attempted.get(key);
              if (retry)
                attempted.set(key, {
                  ...retry,
                  at: Date.now() + retry.delay * (0.5 + Math.random() / 2),
                });
            }
          }
        }
      } catch (error) {
        if (!active.signal.aborted) {
          console.warn("Builderlab turn status recovery failed", error);
        }
      } finally {
        running = false;
        // A reconnect may have arrived while an aborted request was unwinding.
        if (
          active.signal.aborted &&
          current === next &&
          credential === account &&
          !disposed
        )
          void run();
        else if (!disposed && current === next && credential === account) {
          const at = Math.min(
            ...activity
              .snapshot()
              .turns.filter((turn) => turn.state === "unknown")
              .map(
                (turn) =>
                  attempted.get(`${turn.agent}:${turn.turnId}`)?.at ?? Infinity,
              ),
          );
          if (Number.isFinite(at))
            retryTimer = setTimeout(
              () => {
                retryTimer = undefined;
                void run();
              },
              Math.max(0, at - Date.now()),
            );
        }
      }
    }
    stopActivity = activity.subscribe(() => void run());
    void run();
  }
  const stopRelay = relay.subscribe(attach);
  const stopLogin = session.subscribe(attach);
  attach();
  return () => {
    disposed = true;
    stopRelay();
    stopLogin();
    stopActivity?.();
    cancelRetry();
    controller?.abort();
  };
}
