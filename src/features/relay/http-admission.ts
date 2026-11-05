import {
  networkContext,
  networkCancellation,
} from "../developer/network-context.ts";
import { networkRecorder } from "../developer/network-diagnostics.ts";
import type { ReadFilter } from "./events.ts";
import { ReadError } from "./errors.ts";

/** Admission owns starts, not retries or delivery semantics. An admitted write is
 * still sent once; a lost response is never permission to repeat it. */
export class ApiPaused extends ReadError {
  constructor(retryAfterMs: number) {
    super(
      "unavailable",
      `Relay requests paused; retry in ${Math.ceil(retryAfterMs / 1000)}s`,
      429,
      retryAfterMs,
    );
    this.name = "ApiPaused";
  }
}
export class ApiNotSent extends Error {}
export class ApiCapacity extends ApiNotSent {
  constructor() {
    super("Relay API queue capacity reached");
    this.name = "ApiCapacity";
  }
}
export type ApiFailure = Readonly<{
  error: string;
  code?: string;
  quota?: "api";
  paused?: true;
  retryAfterMs?: number;
  sent?: false;
  /** A relay-shaped 401/403. An edge or proxy page (for example a VPN still
   * reconnecting) has the same status but is not the relay's answer. */
  denied?: true;
}>;
const MAX_ERROR_BYTES = 4096;
/** Only a correlated relay quota reason becomes a shared API cooldown. Local
 * broker concurrency 429 and arbitrary response text must not impersonate it. */
export function apiFailure(status: number, value: unknown): ApiFailure {
  const body =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const reason = typeof body.error === "string" ? body.error : "";
  if (status === 429 && /^rate-limited: quota exceeded(?:;|$)/.test(reason)) {
    const hint = /^rate-limited: quota exceeded; retry in (\d+)s$/.exec(reason);
    const seconds = hint ? Number(hint[1]) : 60;
    // Unsupported/missing hints fail closed rather than draining the known-busy lane.
    const bounded =
      Number.isSafeInteger(seconds) && seconds <= 86400 ? seconds : 86400;
    return {
      error: `rate-limited: quota exceeded; retry in ${bounded}s`,
      quota: "api",
      retryAfterMs: (bounded + 1) * 1000,
    };
  }
  if (
    status === 429 &&
    body.paused === true &&
    body.sent === false &&
    typeof body.retryAfterMs === "number" &&
    Number.isFinite(body.retryAfterMs) &&
    body.retryAfterMs >= 0 &&
    body.retryAfterMs <= 86401000
  )
    return {
      error: new ApiPaused(body.retryAfterMs).message,
      paused: true,
      sent: false,
      retryAfterMs: body.retryAfterMs,
    };
  // Never forward arbitrary upstream response text into the browser. These local
  // broker messages are useful; all other bodies get a bounded status summary.
  const known = [
    "Query concurrency limit",
    "Live stream capacity reached",
    "Relay unreachable",
  ];
  return {
    error: known.includes(reason) ? reason : `Relay request failed (${status})`,
    ...(body.sent === false ? { sent: false } : {}),
    ...((status === 401 || status === 403) && reason ? { denied: true } : {}),
  };
}
/** Consumes one bounded error body; success payloads remain their owner's concern.
 * `reason` may keep an exact, caller-allowed upstream refusal from that body. */
export async function readApiFailure(
  response: Response,
  reason?: (
    body: unknown,
    status: number,
  ) => string | Pick<ApiFailure, "error" | "code"> | undefined,
): Promise<ApiFailure> {
  if (!response.body) return apiFailure(response.status, undefined);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "",
    bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ERROR_BYTES)
        return apiFailure(response.status, undefined);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return apiFailure(response.status, undefined);
    }
    const failure = apiFailure(response.status, body);
    const allowed = failure.quota ? undefined : reason?.(body, response.status);
    return allowed
      ? {
          ...failure,
          ...(typeof allowed === "string" ? { error: allowed } : allowed),
        }
      : failure;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type Ticket = {
  priority: "foreground" | "background";
  signal?: AbortSignal | undefined;
  start(): void;
  reject(error: Error): void;
  abort(): void;
};
/** One host/principal API lane, bounded like the broker's six-request ceiling.
 * Available capacity dispatches immediately; only server cooldowns pause starts.
 * Cooldowns reject queued work rather than spending a read's 10s deadline. */
export function createApiAdmission() {
  let pausedUntil = 0,
    active = 0,
    preparing = 0,
    presenceBusy = false,
    presenceNext = 0;
  const queue: Ticket[] = [];
  const pauseError = () =>
    new ApiPaused(Math.max(0, pausedUntil - performance.now()));
  const remove = (ticket: Ticket) => {
    const index = queue.indexOf(ticket);
    if (index >= 0) queue.splice(index, 1);
    ticket.signal?.removeEventListener("abort", ticket.abort);
  };
  function pump() {
    if (!queue.length) return;
    if (performance.now() < pausedUntil) {
      for (const ticket of [...queue]) {
        remove(ticket);
        ticket.reject(pauseError());
      }
      return;
    }
    while (active < 6 && queue.length) {
      const ticket = queue.find((t) => t.priority === "foreground") ?? queue[0];
      if (!ticket) return;
      remove(ticket);
      ticket.start();
    }
  }
  return {
    /** Lossy snapshot lease; never consumes ordinary slots or start credit. */
    tryPresence() {
      if (
        presenceBusy ||
        performance.now() < Math.max(pausedUntil, presenceNext)
      )
        return;
      presenceBusy = true;
      presenceNext = performance.now() + 5000;
      return () => {
        presenceBusy = false;
      };
    },
    presenceIdle: () => !presenceBusy && performance.now() >= presenceNext,
    /** Retain bounded ownership across asynchronous auth and its final dispatch.
     * A cancelled unabortable signer keeps its slot until it settles: repeatedly
     * cancelling must not admit an unbounded number of outstanding sign prompts. */
    async prepare<T>(work: () => Promise<T>): Promise<T> {
      if (performance.now() < pausedUntil) throw pauseError();
      if (preparing >= 128) throw new ApiCapacity();
      preparing++;
      try {
        return await work();
      } finally {
        preparing--;
      }
    },
    idle: () =>
      !active &&
      !preparing &&
      !queue.length &&
      performance.now() >= pausedUntil,
    pause(milliseconds: number) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0)
        throw new Error("Invalid API pause");
      pausedUntil = Math.max(
        pausedUntil,
        performance.now() + Math.min(milliseconds, 86401000),
      );
      pump();
    },
    run<T>(
      work: () => Promise<T>,
      signal?: AbortSignal,
      priority: Ticket["priority"] = "foreground",
    ): Promise<T> {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (performance.now() < pausedUntil) return Promise.reject(pauseError());
      if (queue.length >= 128) return Promise.reject(new ApiCapacity());
      return new Promise((resolve, reject) => {
        const began = performance.now();
        if (networkRecorder.enabled("debug"))
          networkRecorder.record({
            level: "debug",
            event: "admission.queued",
            ...networkContext(signal),
            count: queue.length,
            detail: priority,
          });
        const ticket: Ticket = {
          priority,
          signal,
          start() {
            if (networkRecorder.enabled("debug"))
              networkRecorder.record({
                level: "debug",
                event: "admission.dispatched",
                ...networkContext(signal),
                ms: performance.now() - began,
                count: active,
              });
            active++;
            const finish = () => {
              active--;
              pump();
            };
            try {
              signal?.throwIfAborted();
              Promise.resolve(work()).then(resolve, reject).finally(finish);
            } catch (error) {
              finish();
              reject(error);
            }
          },
          reject,
          abort() {
            if (networkRecorder.enabled("debug"))
              networkRecorder.record({
                level: "debug",
                event: "admission.cancelled",
                ...networkContext(signal),
                cancellation: networkCancellation(signal),
                ms: performance.now() - began,
              });
            remove(ticket);
            reject(
              signal?.reason ?? new DOMException("Cancelled", "AbortError"),
            );
            pump();
          },
        };
        signal?.addEventListener("abort", ticket.abort, { once: true });
        queue.push(ticket);
        pump();
      });
    },
  };
}

/** Wrap the actual fetch boundary in both hosts. No transparent request retry.
 * Normalize bounded error evidence while preserving the original status/headers. */
export async function admittedApiRequest(
  lane: ReturnType<typeof createApiAdmission>,
  request: () => Promise<Response>,
  signal?: AbortSignal,
  priority: Ticket["priority"] = "foreground",
  reason?: (
    body: unknown,
    status: number,
  ) => string | Pick<ApiFailure, "error" | "code"> | undefined,
): Promise<Response> {
  return lane.run(
    async () => {
      const response = await request();
      if (response.ok) return response;
      const failure = await readApiFailure(response, reason);
      if (failure.quota === "api" && failure.retryAfterMs !== undefined)
        lane.pause(failure.retryAfterMs);
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      // A 401/403 page that is not the relay's own answer (an edge proxy
      // while a VPN reconnects) is a gateway failure, not a denial.
      const status =
        (response.status === 401 || response.status === 403) && !failure.denied
          ? 502
          : response.status;
      return Response.json(failure, { status, headers });
    },
    signal,
    priority,
  );
}

/** The optional lane accepts only this bounded presence shape, never a priority hint. */
export function presenceFilter(raw: unknown): raw is ReadFilter[] {
  if (!Array.isArray(raw) || raw.length !== 1) return false;
  const filter = raw[0];
  return (
    !!filter &&
    Object.keys(filter).sort().join(",") === "authors,kinds,limit" &&
    Array.isArray(filter.kinds) &&
    filter.kinds.length === 1 &&
    filter.kinds[0] === 20001 &&
    Array.isArray(filter.authors) &&
    filter.authors.length > 0 &&
    filter.authors.length <= 256 &&
    filter.limit === filter.authors.length &&
    new Set(filter.authors).size === filter.authors.length &&
    filter.authors.every(
      (key: unknown) => typeof key === "string" && /^[0-9a-f]{64}$/.test(key),
    )
  );
}
export async function presenceText(response: Response): Promise<string> {
  if (!response.body) throw new Error("Presence body missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > 1024 * 1024)
        throw new Error("Presence response exceeds capacity");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
