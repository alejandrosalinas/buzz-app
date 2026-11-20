// Mention turns that were working when the app closed or reloaded, for a type
// whose turns end with the page (`AgentType.resumes`), kept until the owner
// resumes or forgets them. The event is read again from the relay. Each agent
// membership has its own key, so a program writes only the agents it changed.
import { AGENT_KEY, type AgentKey } from "./membership";
import type { AgentStore } from "./store";

export const INTERRUPTED_PREFIX = "buzz.agents.interrupted.v1:";

/** A channel string, including legacy records, keeps native placement.
 * Pending work can still route; any accepted task has its own saved route. */
type InterruptedEntry =
  | string
  | Readonly<{ channel: string; placement: "pending" }>;
export type InterruptedTurns = Readonly<Record<string, InterruptedEntry>>;
export type Interrupted = Readonly<Record<string, InterruptedTurns>>;

const ID = /^[0-9a-f]{64}$/;

function interruptedEntry(value: unknown): value is InterruptedEntry {
  return (
    typeof value === "string" ||
    (!!value &&
      typeof value === "object" &&
      "channel" in value &&
      typeof value.channel === "string" &&
      "placement" in value &&
      value.placement === "pending")
  );
}

export function interruptedChannels(turns: InterruptedTurns = {}) {
  return Object.fromEntries(
    Object.entries(turns).map(([id, turn]) => [
      id,
      typeof turn === "string" ? turn : turn.channel,
    ]),
  );
}

export function readInterrupted(storage: AgentStore): Interrupted {
  const turns: Record<string, InterruptedTurns> = {};
  for (const key of storage.keys()) {
    if (!key.startsWith(INTERRUPTED_PREFIX)) continue;
    const agent = key.slice(INTERRUPTED_PREFIX.length);
    let stored: unknown;
    try {
      stored = JSON.parse(storage.get(key) ?? "null");
    } catch {
      continue;
    }
    if (!AGENT_KEY.test(agent) || !stored || typeof stored !== "object")
      continue;
    const ids = Object.entries(stored).filter(
      (entry): entry is [string, InterruptedEntry] =>
        ID.test(entry[0]) && interruptedEntry(entry[1]),
    );
    if (ids.length) turns[agent] = Object.fromEntries(ids);
  }
  return turns;
}

/** Saves a membership's turns in its own key. Settles once the write is
 * saved; rejects when storage refuses it. */
export function writeInterrupted(
  storage: AgentStore,
  agent: AgentKey,
  turns: InterruptedTurns,
) {
  return storage.set(
    `${INTERRUPTED_PREFIX}${agent}`,
    Object.keys(turns).length ? JSON.stringify(turns) : null,
  );
}
