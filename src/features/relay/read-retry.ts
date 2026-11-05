import { networkRecorder } from "../developer/network-diagnostics.ts";
import {
  bindNetworkContext,
  networkContext,
  networkSignals,
} from "../developer/network-context.ts";
import { isTransientFailure, readErrorKind, ReadError } from "./errors.ts";
import { RECOVERY_DELAYS_MS } from "./recovery.ts";

const QUIET_MS = 10_000;

/** Transient, but not the owner's own cancellation. */
export function isRetryableRead(error: unknown): boolean {
  if (readErrorKind(error) === "cancelled") return false;
  if (error instanceof Error && error.cause !== undefined)
    return isRetryableRead(error.cause);
  return isTransientFailure(error);
}

/** One initial read and up to three quiet retries under session recovery's
 * first three ceilings (1/2/4 s) with equal jitter, none starting after 10 s.
 * Exhaustion rethrows the last failure. Use one owner per read path; the
 * caller owns its lifetime. */
export async function retryRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  retryable: (error: unknown) => boolean = isRetryableRead,
): Promise<T> {
  const began = performance.now();
  const operationId = networkRecorder.enabled("debug")
    ? `retry:${crypto.randomUUID()}`
    : "";
  const parentId = networkContext(signal)?.operationId;
  const owner = networkContext(signal)?.owner;
  const attemptSignal = networkSignals([signal]);
  bindNetworkContext(attemptSignal, {
    operationId,
    parentId,
    owner,
  });
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      if (networkRecorder.enabled("debug"))
        networkRecorder.record({
          level: "debug",
          event: "read.attempt",
          operationId,
          parentId,
          attempt,
          owner,
        });
      const value = await read(attemptSignal);
      signal.throwIfAborted();
      return value;
    } catch (error) {
      signal.throwIfAborted();
      const ceiling = RECOVERY_DELAYS_MS[attempt] ?? 0;
      const hint = error instanceof ReadError ? (error.retryAfterMs ?? 0) : 0;
      const delay = Math.max(ceiling * (0.5 + Math.random() / 2), hint);
      // A longer admission pause keeps its existing cooldown and action; a
      // read that already waited out its own deadline surfaces it.
      if (
        attempt === 3 ||
        !retryable(error) ||
        hint > ceiling ||
        performance.now() - began + delay > QUIET_MS
      )
        throw error;
      if (networkRecorder.enabled("debug"))
        networkRecorder.record({
          level: "debug",
          event: "read.retry",
          operationId,
          parentId,
          owner,
          attempt: attempt + 1,
          delayMs: delay,
          reason: error,
        });
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, delay);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
}
