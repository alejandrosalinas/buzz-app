import { LOG_LEVELS, type LogLevel } from "./logging.ts";
import type { RelayMetrics } from "./network-metrics.ts";
import type { NetworkCancellation } from "./network-context.ts";

export type CaptureReset = Readonly<{ enabled: boolean; minutes: number }>;
export const DEFAULT_CAPTURE_RESET: CaptureReset = Object.freeze({
  enabled: false,
  minutes: 15,
});
export function validCaptureReset(reset: CaptureReset) {
  const until = Date.now() + reset.minutes * 60_000;
  return (
    typeof reset.enabled === "boolean" &&
    Number.isSafeInteger(reset.minutes) &&
    reset.minutes > 0 &&
    Number.isSafeInteger(until) &&
    until <= 8.64e15
  );
}
export const captureExpiry = (
  level: LogLevel,
  reset: CaptureReset,
  now = Date.now(),
) =>
  reset.enabled && LOG_LEVELS[level] >= LOG_LEVELS.debug
    ? now + reset.minutes * 60_000
    : undefined;
const HISTORY_LIMIT = 500;
const TRAFFIC_LIMIT = 1500;
export type NetworkSource =
  | "live"
  | "catalog"
  | "solo-preferences"
  | "sidebar-preferences"
  | "visibility";
export type NetworkEvent = Readonly<{
  sequence: number;
  at: number;
  level: Exclude<LogLevel, "silent">;
  event: string;
  relay?: string | undefined;
  connection?: string | undefined;
  reason?: string | undefined;
  ms?: number | undefined;
  status?: number | undefined;
  bytes?: number | undefined;
  count?: number | undefined;
  delayMs?: number | undefined;
  attempt?: number | undefined;
  shown?: boolean | undefined;
  recovering?: boolean | undefined;
  sources?: readonly Readonly<{ name: NetworkSource; status: string }>[];
  detail?: string | undefined;
  operationId?: string | undefined;
  parentId?: string | undefined;
  consumerId?: string | undefined;
  owner?: string | undefined;
  phase?: string | undefined;
  outcome?: string | undefined;
  cancellation?: NetworkCancellation | undefined;
  deadlineMs?: number | undefined;
  dueAt?: number | undefined;
  latenessMs?: number | undefined;
  nativeAt?: number | undefined;
  frameSequence?: number | undefined;
  subscriptionId?: string | undefined;
  error?: NetworkError | undefined;
  metrics?: RelayMetrics | undefined;
}>;
type Input = Omit<NetworkEvent, "sequence" | "at" | "reason" | "error"> & {
  reason?: unknown;
};

export type NetworkError = Readonly<{
  name: string;
  code: string;
  message?: string;
  messageRedacted?: true;
  kind?: string;
  status?: number;
  cause?: NetworkError;
  truncated?: true;
}>;
const safeMessages = new Set([
  "Relay read timed out",
  "Relay read cancelled",
  "Read cancelled",
  "Cancelled",
  "Stale request",
  "Stale live catch-up",
  "Relay is disconnected",
  "Too many pending relay reads",
  "Relay API queue capacity reached",
  "Relay response exceeds the read budget",
  "Relay requests paused",
]);

/** Preserve safe local messages and structured causes, never arbitrary upstream text. */
export function networkError(
  error: unknown,
  seen = new Set<unknown>(),
  depth = 0,
): NetworkError {
  if (depth === 4 || seen.has(error))
    return { name: "Error", code: "cause-truncated", truncated: true };
  seen.add(error);
  const value = error instanceof Error ? error : undefined;
  const message = typeof error === "string" ? error : (value?.message ?? "");
  const reason = networkReason(error);
  const name =
    value &&
    [
      "Error",
      "ReadError",
      "ApiPaused",
      "ApiCapacity",
      "TypeError",
      "AbortError",
      "TimeoutError",
      "SyntaxError",
      "RangeError",
    ].includes(value.name)
      ? value.name
      : "Error";
  const fields = value as
    | (Error & { kind?: unknown; status?: unknown })
    | undefined;
  const kind =
    typeof fields?.kind === "string" &&
    ["cancelled", "denied", "unavailable", "invalid-response"].includes(
      fields.kind,
    )
      ? fields.kind
      : undefined;
  const status =
    typeof fields?.status === "number" &&
    Number.isInteger(fields.status) &&
    fields.status >= 100 &&
    fields.status <= 599
      ? fields.status
      : undefined;
  return {
    name,
    code:
      message === "Relay read timed out" || name === "TimeoutError"
        ? "deadline-exceeded"
        : reason,
    ...(safeMessages.has(message) ||
    (reason !== "unclassified" && reason === message)
      ? { message }
      : { messageRedacted: true as const }),
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
    ...(value?.cause !== undefined
      ? { cause: networkError(value.cause, seen, depth + 1) }
      : {}),
  };
}

/** Preserve fixed public failure classes, never arbitrary exception/relay text. */
export function networkReason(error: unknown): string {
  if (error instanceof TypeError) return "network-unavailable";
  if (error instanceof Error && /^(AbortError|TimeoutError)$/.test(error.name))
    return error.name === "TimeoutError" ? "network-timeout" : "cancelled";
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  const known = [
    "Relay read timed out",
    "Relay read cancelled",
    "Relay is disconnected",
    "Too many pending relay reads",
    "Relay API queue capacity reached",
    "Live connection unavailable",
    "Live connection interrupted",
    "Live authentication timed out",
    "Live connection stopped answering",
    "Live connection closed",
    "Live subscription setup timed out; retry available",
    "Native sockets are busy",
    "Native socket timed out",
    "Native socket upgrade refused",
    "Socket send queue is full",
    "Native socket retired",
    "Native socket canceled",
    "Federated community discovery failed",
    "Federated session changed",
    "Federated community discovery changed",
    "Federated sign-in is required",
    "Federated identity is not configured for this community",
    "Relay request could not be confirmed",
    "Relay response was interrupted",
    "Community discovery failed",
    "network-unavailable",
    "network-timeout",
    "relay-unauthorized",
    "relay-forbidden",
    "relay-unavailable",
    "binding-mismatch",
    "authorization-denied",
    "grant-refused",
    "invalid-proof",
    "invalid-assertion",
    "invalid-response",
    "invalid-expiry",
    "invalid-viewer",
    "adapter-refused",
    "reauthentication-required",
    "response-too-large",
  ];
  if (known.includes(message)) return message;
  if (/^Relay read failed \(\d{3}\)$/.test(message)) return message;
  if (/^Live connection closed \(\d{4}/.test(message)) return "remote-close";
  return (
    /^(invalid|blocked|restricted|auth-required|rate-limited|error|conflict|forbidden):/.exec(
      message,
    )?.[1] ?? "unclassified"
  );
}

/** Two bounded histories keep frame floods from evicting outage explanations.
 * Producers pass allowlisted metadata only; payloads never enter this recorder. */
export function createNetworkRecorder(now = () => Date.now(), active = true) {
  let level: LogLevel = "info";
  let expiresAt: number | undefined;
  let autoReset = DEFAULT_CAPTURE_RESET;
  let sequence = 0;
  let dropped = 0;
  const lifecycle: NetworkEvent[] = [];
  const traffic: NetworkEvent[] = [];
  const listeners = new Set<(event: NetworkEvent) => void>();
  const currentLevel = () => {
    if (expiresAt !== undefined && now() >= expiresAt) {
      level = "info";
      expiresAt = undefined;
    }
    return level;
  };
  return {
    enabled: (minimum: LogLevel) =>
      active && LOG_LEVELS[currentLevel()] >= LOG_LEVELS[minimum],
    collecting: () => active && currentLevel() !== "silent",
    setEnabled(next: boolean) {
      active = next;
    },
    configure(
      next: LogLevel,
      reset = autoReset,
      until = captureExpiry(next, reset, now()),
    ) {
      if (!validCaptureReset(reset))
        throw new Error("Enter a positive whole number of capture minutes");
      level = next;
      autoReset = Object.freeze({ ...reset });
      expiresAt = until;
    },
    subscribe(listener: (event: NetworkEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    record(input: Input) {
      if (
        !active ||
        currentLevel() === "silent" ||
        (input.event !== "metrics.summary" &&
          LOG_LEVELS[currentLevel()] < LOG_LEVELS[input.level])
      )
        return;
      let relay: string | undefined;
      if (input.relay) {
        try {
          relay = new URL(
            input.relay.includes("://")
              ? input.relay
              : `https://${input.relay}`,
          ).host;
        } catch {
          relay = "unknown-relay";
        }
      }
      const { reason, ...metadata } = input;
      const event = Object.freeze({
        ...metadata,
        relay,
        ...(reason === undefined
          ? {}
          : {
              reason: networkReason(reason),
              error:
                LOG_LEVELS[currentLevel()] >= LOG_LEVELS.debug
                  ? networkError(reason)
                  : { name: "Error", code: networkReason(reason) },
            }),
        sequence: ++sequence,
        at: now(),
      });
      const list =
        LOG_LEVELS[input.level] >= LOG_LEVELS.debug ? traffic : lifecycle;
      list.push(event);
      if (list.length > (list === traffic ? TRAFFIC_LIMIT : HISTORY_LIMIT)) {
        list.shift();
        dropped++;
      }
      for (const listener of listeners) listener(event);
    },
    snapshot() {
      return {
        active,
        level: currentLevel(),
        autoReset,
        expiresAt,
        dropped,
        events: [...lifecycle, ...traffic].sort(
          (a, b) => a.sequence - b.sequence,
        ),
      };
    },
    clear(beforeSequence = sequence) {
      for (const list of [lifecycle, traffic])
        for (let i = list.length - 1; i >= 0; i--)
          if ((list[i]?.sequence ?? 0) <= beforeSequence) list.splice(i, 1);
      dropped = 0;
    },
  };
}

// Created before sessions/plugins; plugin activation starts collection.
export const networkRecorder = createNetworkRecorder(() => Date.now(), false);
