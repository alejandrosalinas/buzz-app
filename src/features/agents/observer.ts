import { eventDto, type RelayEvent } from "../relay/events.ts";

export const ACTIVITY_HISTORY_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Host-projected telemetry. Never a signed RelayEvent or a general decrypt API. */
export const OBSERVER_KIND = 24200;
export const OBSERVER_PLAINTEXT_BYTES = 65535;

/** Terminal wire outcomes shared by the live lifecycle and transcript. Missing
 * outcome is the original local-agent completion contract. */
export function terminalOutcome(kind: string, outcome: unknown) {
  if (kind === "turn_error" || kind === "agent_panic") return "error";
  if (kind !== "turn_completed") return undefined;
  switch (outcome) {
    case undefined:
    case "completed":
      return "ended";
    case "failed":
    case "terminated":
      return "error";
    case "cancelled":
      return "stopped";
    default:
      return "unknown";
  }
}
export type ObserverFrame = Readonly<{
  id: string;
  agent: string;
  createdAt: number;
  plaintext: string;
  /** Original owner-encrypted wire envelope; plaintext is never persisted. */
  envelope?: RelayEvent;
}>;
export function observerFrame(value: unknown): ObserverFrame {
  const frame = value as ObserverFrame | null;
  if (
    !frame ||
    typeof frame !== "object" ||
    Array.isArray(frame) ||
    typeof frame.id !== "string" ||
    typeof frame.agent !== "string" ||
    !/^[0-9a-f]{64}$/.test(frame.id) ||
    !/^[0-9a-f]{64}$/.test(frame.agent) ||
    !Number.isSafeInteger(frame.createdAt) ||
    frame.createdAt < 0 ||
    typeof frame.plaintext !== "string" ||
    new TextEncoder().encode(frame.plaintext).length > OBSERVER_PLAINTEXT_BYTES
  )
    throw new Error("Invalid observer frame");
  // Validate JSON here; unknown fields and event kinds remain inert raw evidence.
  JSON.parse(frame.plaintext);
  const envelope =
    frame.envelope === undefined ? undefined : eventDto(frame.envelope);
  if (
    envelope &&
    (envelope.kind !== OBSERVER_KIND ||
      envelope.id !== frame.id ||
      envelope.pubkey !== frame.agent ||
      envelope.created_at !== frame.createdAt)
  )
    throw new Error("Observer envelope mismatch");
  return Object.freeze({
    id: frame.id,
    agent: frame.agent,
    createdAt: frame.createdAt,
    plaintext: frame.plaintext,
    ...(envelope ? { envelope } : {}),
  });
}
export function observerGeneration(value: unknown): number | null {
  if (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  )
    return value;
  throw new Error("Invalid observer generation");
}
