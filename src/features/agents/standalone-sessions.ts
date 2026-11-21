// The sessions that each local agent's one-off turns (a watch's or a timer's)
// started, kept so Usage can count them. Such a session's transcript names no
// conversation, so this record is the only sign that it is the agent's. It is
// kept apart from the saved prompts, which drop old sessions to stay small,
// and holds each session for `STANDALONE_DAYS` from its start: longer than
// Usage reads back. Nothing inside that window is dropped, however often the
// agent's turns run. Every one-off turn's session is kept, Usage on or off;
// only while the Usage plugin is on (`usageOn`) does it also keep the key of
// the turn that started it (`timer/ID` or `watch/ID`), so Usage can say which
// routine spent it.
//
// Each day's starts are a value of their own, so a turn rewrites only its
// day's value, and whole days past keeping are removed. Agent storage takes
// 4 MiB a value: about 70,000 starts in one day, far more than one timer's
// 1,440 at its shortest interval. A save past that fails and is logged.
import { validTime } from "../agent-harness/acp/agent-sessions";
import type { AgentKey } from "./membership";
import type { AgentStore } from "./store";
import type { SettingsCards } from "../settings/service";

export const STANDALONE_PREFIX = "buzz.standalone-sessions.v1:";
/** The Usage plugin's settings card, registered only while Usage is on. */
export const USAGE_CARD = "buzz.usage/usage";

/** Whether Usage is on, asked as each one-off turn starts: a runtime keeps
 * the turn's key with its session only then. */
export const usageOn = (cards: Pick<SettingsCards, "has">) => () =>
  cards.has(USAGE_CARD);
/** Usage reads 30 days back, and a turn can answer a day after it started. */
export const STANDALONE_DAYS = 32;
const DAY = 86_400_000;

/** `[id, startedAt]`, then the key of the turn that started it when that
 * was kept. Fields past these are kept as they are, unread. */
type Entry = [string, number, ...unknown[]];
type Stored = { version: 1; sessions: Entry[] };

/** The key of an agent's sessions that started on `day` (days since 1970,
 * UTC), of one agent type. */
const dayKey = (type: string, agent: AgentKey, day: number) =>
  `${STANDALONE_PREFIX}${type}:${agent}:${day}`;

const short = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

/** The stored sessions, entries without a valid id and start dropped. */
function read(text: string | null): Entry[] {
  try {
    const stored = JSON.parse(text ?? "null") as Partial<Stored> | null;
    if (stored?.version === 1 && Array.isArray(stored.sessions))
      return stored.sessions.filter(
        (entry): entry is Entry =>
          Array.isArray(entry) && short(entry[0]) && validTime(entry[1]),
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
    /** The sessions kept, oldest first, with when each started and the key
     * of the turn that started it, when that was kept. A damaged key reads
     * as none, so its session still counts. */
    list: () =>
      kept().map(([id, at, wake]) =>
        short(wake) ? { id, at, wake } : { id, at },
      ),
    /** Records a one-off turn's new session, and the turn's key when given,
     * then removes the days past keeping. A failed save is logged, never
     * thrown, so the agent keeps working. */
    async add(id: string, wake?: string) {
      try {
        // Read, changed and written with no wait between, so adds never
        // drop each other's sessions.
        if (kept().some(([found]) => found === id)) return;
        const at = now();
        const key = dayKey(type, agent, Math.floor(at / DAY));
        const sessions = read(storage.get(key));
        sessions.push(short(wake) ? [id, at, wake] : [id, at]);
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
