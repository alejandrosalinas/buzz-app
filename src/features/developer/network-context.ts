import { networkRecorder } from "./network-diagnostics.ts";
/** Metadata follows owned signals, without changing their reasons or cancellation behavior. */
export type NetworkContext = Readonly<{
  operationId: string;
  parentId?: string | undefined;
  owner?: string | undefined;
}>;
export type NetworkCancellation = Readonly<{
  initiator:
    | "deadline"
    | "superseded"
    | "navigation"
    | "recovery"
    | "session-disposed"
    | "no-consumers"
    | "caller"
    | "completed";
  owner: string;
}>;
const contexts = new WeakMap<AbortSignal, NetworkContext>();
const cancellations = new WeakMap<AbortSignal, NetworkCancellation>();
const parents = new WeakMap<AbortSignal, readonly AbortSignal[]>();

export function bindNetworkContext(
  signal: AbortSignal,
  context: NetworkContext,
) {
  if (networkRecorder.enabled("debug")) contexts.set(signal, context);
}
export function networkContext(
  signal?: AbortSignal,
): NetworkContext | undefined {
  if (!networkRecorder.enabled("debug") || !signal) return;
  return (
    contexts.get(signal) ??
    parents.get(signal)?.map(networkContext).find(Boolean)
  );
}
export function networkCancellation(
  signal?: AbortSignal,
): NetworkCancellation | undefined {
  if (!networkRecorder.enabled("debug") || !signal?.aborted) return;
  return (
    cancellations.get(signal) ??
    parents
      .get(signal)
      ?.filter((parent) => parent.aborted && parent.reason === signal.reason)
      .map(networkCancellation)
      .find(Boolean) ?? {
      initiator:
        signal.reason instanceof Error && signal.reason.name === "TimeoutError"
          ? "deadline"
          : "caller",
      owner: "unattributed",
    }
  );
}
export function markNetworkCancellation(
  signal: AbortSignal,
  cancellation: NetworkCancellation,
) {
  if (networkRecorder.enabled("debug") && !cancellations.has(signal))
    cancellations.set(signal, cancellation);
}
export function abortNetwork(
  controller: AbortController,
  initiator: NetworkCancellation["initiator"],
  owner: string,
) {
  if (!controller.signal.aborted)
    markNetworkCancellation(controller.signal, { initiator, owner });
  controller.abort();
}
export function networkSignals(signals: readonly AbortSignal[]): AbortSignal {
  const combined = AbortSignal.any([...signals]);
  if (networkRecorder.enabled("debug")) parents.set(combined, signals);
  return combined;
}
