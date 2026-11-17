// The sessions that each local agent's one-off turns (a watch's or a timer's)
// started, kept so Usage can count them. Such a session's transcript names no
// conversation, so this record is the only sign that it is the agent's. It is
// kept apart from the saved prompts, which drop old sessions to stay small,
// and holds each session for `STANDALONE_DAYS` from its start: longer than
// Usage reads back. Nothing inside that window is dropped, however often the
// agent's turns run.
//
// Each day's starts are a value of their own, so a turn rewrites only its
// day's value, and whole days past keeping are removed. Agent storage takes
// 4 MiB a value: about 70,000 starts in one day, far more than one timer's
// 1,440 at its shortest interval. A save past that fails and is logged.
import { validTime } from "../agent-harness/acp/agent-sessions";
import type { AgentKey } from "./membership";
import type { AgentStore } from "./store";

export const STANDALONE_PREFIX = "buzz.standalone-sessions.v1:";
/** Usage reads 30 days back, and a turn can answer a day after it started. */
export const STANDALONE_DAYS = 32;
const DAY = 86_400_000;

type Stored = { version: 1; sessions: [string, number][] };

/** The key of an agent's sessions that started on `day` (days since 1970,
 * UTC), of one agent type. */
const dayKey = (type: string, agent: AgentKey, day: number) =>
  `${STANDALONE_PREFIX}${type}:${agent}:${day}`;

/** The stored sessions, damaged entries dropped. */
function read(text: string | null): [string, number][] {
  try {
    const stored = JSON.parse(text ?? "null") as Partial<Stored> | null;
    if (stored?.version === 1 && Array.isArray(stored.sessions))
      return stored.sessions.filter(
        (entry): entry is [string, number] =>
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          entry[0].length > 0 &&
          entry[0].length <= 256 &&
          validTime(entry[1]),
      );
  } catch {}
  return [];
}

/** The sessions one agent's one-off turns started, of one agent type. */
export function standaloneSessions(
  storage: AgentStore,
  type: string,
  agent: AgentKey,
  now: () => number = Date.now,
) {
  const prefix = dayKey(type, agent, 0).slice(0, -1);
  /** The stored days, each with its key. */
  const days = () =>
    storage.keys().flatMap((key) => {
      if (!key.startsWith(prefix)) return [];
      const day = key.slice(prefix.length);
      return /^\d{1,9}$/.test(day) ? [{ key, day: Number(day) }] : [];
    });
  const cutoff = () => now() - STANDALONE_DAYS * DAY;
  const kept = () => {
    const after = cutoff();
    return days()
      .flatMap(({ key, day }) =>
        (day + 1) * DAY <= after ? [] : read(storage.get(key)),
      )
      .filter(([, at]) => at >= after)
      .sort((a, b) => a[1] - b[1]);
  };
  return {
    /** The sessions kept, oldest first, with when each started. */
    list: () => kept().map(([id, at]) => ({ id, at })),
    /** Records a one-off turn's new session, then removes the days past
     * keeping. A failed save is logged, never thrown, so the agent keeps
     * working. */
    async add(id: string) {
      try {
        // Read, changed and written with no wait between, so adds never
        // drop each other's sessions.
        if (kept().some(([found]) => found === id)) return;
        const at = now();
        const key = dayKey(type, agent, Math.floor(at / DAY));
        const sessions = read(storage.get(key));
        sessions.push([id, at]);
        const after = cutoff();
        const past = days().filter(({ day }) => (day + 1) * DAY <= after);
        await storage.set(
          key,
          JSON.stringify({ version: 1, sessions } satisfies Stored),
        );
        for (const { key } of past) await storage.set(key, null);
      } catch (error) {
        console.error("A one-off turn's session was not recorded", error);
      }
    },
  };
}

/** Removes a membership's one-off turn sessions, of every agent type. */
export async function removeStandaloneSessions(
  storage: AgentStore,
  agent: AgentKey,
) {
  for (const key of storage.keys())
    if (
      key.startsWith(STANDALONE_PREFIX) &&
      key.slice(STANDALONE_PREFIX.length).split(":")[1] === agent
    )
      await storage.set(key, null);
}
