import { sourceCompleted, sourceSignature } from "./attention";
// Device-local settings for agents: the attention objects of each agent's
// membership in a community, in the `agent-attention/v1` shape, with its
// timers' run state, and one JSON blob the agent's plugin type owns. Which
// agents exist, their type and name, and their keys live in
// native custody, never here; a record without an identity does nothing. A
// relay-backed store can replace this later without changing the record shape.
import {
  OBJECT_LIMIT,
  timerState,
  validateObject,
  type AttentionObject,
  type AttentionValue,
  type TimerState,
  type TimerWatch,
} from "./attention";
import { AGENT_KEY, type AgentKey } from "./membership";

/** Agent state as every program that runs this machine's agents shares it.
 * Reads are synchronous, from this program's copy. Each write changes the
 * copy at once and returns a promise that settles once the write is saved.
 * It rejects when the write was not saved, and the copy then holds the saved
 * value again. A caller that must know a value is saved awaits the write. */
export type AgentStore = Readonly<{
  keys(): readonly string[];
  get(key: string): string | null;
  /** Reads saved state after this program's pending writes to the key. */
  read(key: string): Promise<string | null>;
  /** Reads saved entries under a prefix without changing this program's copy. */
  scan(prefix: string): Promise<Record<string, string>>;
  /** Saves `value` under `key`; null removes the key. */
  set(key: string, value: string | null): Promise<void>;
  /** Saves `value` only if no program saved a value under `key`. Resolves
   * with the value then kept: `value`, or what another program saved first. */
  add(key: string, value: string): Promise<string>;
}>;

/** `storage` as agent storage. Its writes save as they are made, so each
 * settles at once, or rejects when `storage` refused it. */
export function localStore(
  storage: Storage = globalThis.localStorage,
): AgentStore {
  return Object.freeze({
    keys: () =>
      Array.from({ length: storage.length }, (_, index) =>
        storage.key(index),
      ).filter((key): key is string => key !== null),
    get: (key: string) => storage.getItem(key),
    read: async (key: string) => storage.getItem(key),
    scan: async (prefix: string) =>
      Object.fromEntries(
        Array.from({ length: storage.length }, (_, index) => storage.key(index))
          .filter((key): key is string => Boolean(key?.startsWith(prefix)))
          .flatMap((key) => {
            const value = storage.getItem(key);
            return value === null ? [] : [[key, value]];
          }),
      ),
    set: async (key: string, value: string | null) => {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    },
    add: async (key: string, value: string) => {
      const held = storage.getItem(key);
      if (held !== null) return held;
      storage.setItem(key, value);
      return value;
    },
  });
}

/** An object a reader cannot apply, kept as it was stored so it can be fixed. */
export type SkippedObject = Readonly<{
  slug: string;
  value: unknown;
  modifiedAt: number;
  problem: string;
}>;
/** One event a watch woke its agent for, or one output of a source. */
export type AttentionEntry = Readonly<{
  /** The woken event's id, so it can show as that message. */
  id?: string | undefined;
  at: number;
  text: string;
  author?: string | undefined;
  channel?: string | undefined;
  /** Pubkeys its signed `p` tags name. */
  mentions?: readonly string[] | undefined;
  /** Pubkeys its signed two-field `mention` tags name. */
  mentionReferences?: readonly string[] | undefined;
}>;
export type AttentionHistory = Readonly<{
  lastWokeAt?: number;
  /** What a watch saved before it kept `events`. */
  output?: string;
  events?: readonly AttentionEntry[];
}>;
const pubkeys = (value: unknown) =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (key): key is string =>
              typeof key === "string" && /^[0-9a-f]{64}$/.test(key),
          ),
        ),
      ].slice(0, 100)
    : [];
/** The latest valid `entries` a watch's history keeps, each clipped. */
export const recentEntries = (entries: readonly unknown[]) =>
  entries
    .flatMap((value): AttentionEntry[] => {
      const entry = value as Partial<AttentionEntry> | null;
      // An event keeps its place even without a body, as a deletion has none.
      return entry &&
        Number.isFinite(entry.at) &&
        typeof entry.text === "string" &&
        (entry.text || typeof entry.id === "string")
        ? [
            {
              at: entry.at as number,
              text: entry.text.slice(0, 2000),
              ...(typeof entry.id === "string" ? { id: entry.id } : {}),
              ...(typeof entry.author === "string"
                ? { author: entry.author }
                : {}),
              ...(typeof entry.channel === "string"
                ? { channel: entry.channel }
                : {}),
              ...(pubkeys(entry.mentions).length
                ? { mentions: pubkeys(entry.mentions) }
                : {}),
              ...(pubkeys(entry.mentionReferences).length
                ? { mentionReferences: pubkeys(entry.mentionReferences) }
                : {}),
            },
          ]
        : [];
    })
    .slice(-10);
export type AgentRecord = Readonly<{
  /** Its membership's key (see `agentKey`): the agent's pubkey in its home
   * community. Saved as `pubkey`, which every record had before agents
   * joined more than one community. */
  pubkey: AgentKey;
  /** Keyed by slug (`interest/<id>` or `watch/<id>`). */
  attention: Readonly<Record<string, AttentionObject>>;
  /** Stored objects that are invalid or over a limit. They do nothing, and stay
   * stored until they are fixed or removed. */
  skipped?: Readonly<Record<string, SkippedObject>>;
  /** Plugin-owned config, shared by all its communities, so only the home
   * record keeps it. The host never reads it. */
  config: unknown;
  /** True when the owner turned attention on. Off, its watches and timers
   * stay stored but wake nothing, and the agent is not offered attention
   * tools. Absent means off, so an agent has no attention until its owner
   * turns it on. */
  attentionEnabled?: boolean;
  /** Run state of its timers, by slug. Not config, so it never leaves the device;
   * kept here so removing a timer or the agent removes its state with it. */
  timers?: Readonly<Record<string, TimerState>>;
  /** Terminal source runs, matched to the exact registration. */
  sourceRuns?: Readonly<Record<string, string>>;
  attentionHistory?: Readonly<Record<string, AttentionHistory>>;
}>;
type Stored = { version: 1; agents: Record<string, AgentRecord> };

/** Where records were kept, all in one value, before each had its own key. */
export const STORAGE_KEY = "buzz.agents.v1";
/** Each agent's record has its own key, so programs that run different
 * agents and share this storage never write over each other's records. */
export const RECORD_PREFIX = "buzz.agent.v1:";
export const recordKey = (key: AgentKey) => `${RECORD_PREFIX}${key}`;
const PUBKEY = /^[0-9a-f]{64}$/;
/** Whether an older reader cannot apply this Interest: it is paused, or has a
 * title or summary its validator rejects. Its watches are saved in an envelope
 * that reader rejects too, so it never runs them without the instructions. */
const sealed = (attention: AgentRecord["attention"], id: string) => {
  const value = attention[`interest/${id}`]?.value;
  return (
    value?.type === "interest" &&
    (value.paused === true ||
      value.title !== undefined ||
      value.summary !== undefined)
  );
};
const group = (value: AttentionValue) =>
  value.type === "interest" ? "Interests" : "watches and timers";

/** Reads every record. An attention object a reader would not apply is skipped
 * and reported, never dropped. */
export function readRecords(storage: AgentStore): Record<string, AgentRecord> {
  const stored: Record<string, AgentRecord> = { ...legacyRecords(storage) };
  for (const key of storage.keys()) {
    if (!key.startsWith(RECORD_PREFIX)) continue;
    const record = parsed(storage.get(key));
    if (record) stored[key.slice(RECORD_PREFIX.length)] = record as AgentRecord;
  }
  const records: Record<string, AgentRecord> = {};
  for (const [key, record] of Object.entries(stored)) {
    const read = readRecord(key, record);
    if (read) records[key] = read;
  }
  return records;
}

function parsed(text: string | null): unknown {
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return undefined;
  }
}

function legacyRecords(storage: AgentStore): Record<string, AgentRecord> {
  const stored = parsed(storage.get(STORAGE_KEY));
  if (
    !stored ||
    typeof stored !== "object" ||
    (stored as Stored).version !== 1 ||
    typeof (stored as Stored).agents !== "object"
  )
    return {};
  return (stored as Stored).agents;
}

function readRecord(
  key: AgentKey,
  record: AgentRecord | undefined,
): AgentRecord | undefined {
  if (!AGENT_KEY.test(key) || record?.pubkey !== key) return undefined;
  const attention: Record<string, AttentionObject> = {};
  const skipped: Record<string, SkippedObject> = {};
  const counts = { Interests: 0, "watches and timers": 0 };
  const entries = Object.entries(record.attention ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [slug, stored] of entries) {
    // Older readers reject this watch extension and retain it for repair. Only
    // unwrap after its parent has been validated (Interests sort before watches).
    let object = stored;
    const value = stored?.value;
    if (
      value &&
      typeof value === "object" &&
      "interest_paused" in value &&
      value.interest_paused &&
      typeof value.interest_paused === "object" &&
      value.type !== "interest" &&
      sealed(attention, value.interest_id)
    ) {
      const { interest_paused, ...watch } = value;
      // Skipped objects survive older rewrites, while their top-level runtime
      // metadata does not. Recover it here, then use the usual validators below.
      const state = interest_paused as {
        timer?: TimerState;
        completed?: true;
        history?: AttentionHistory;
      };
      record = {
        ...record,
        ...(state.timer && {
          timers: { [slug]: state.timer, ...record.timers },
        }),
        ...(state.completed === true &&
          watch.type === "source" && {
            sourceRuns: {
              ...record.sourceRuns,
              [slug]: sourceSignature({
                slug,
                value: watch,
                modifiedAt: stored.modifiedAt,
              }),
            },
          }),
        ...(state.history && {
          attentionHistory: {
            [slug]: state.history,
            ...record.attentionHistory,
          },
        }),
      };
      object = { ...stored, value: watch };
    }
    const modifiedAt = Number.isSafeInteger(object?.modifiedAt)
      ? object.modifiedAt
      : 0;
    let problem =
      object?.slug === slug
        ? validateObject(slug, object.value)
        : "Stored under another slug";
    if (!problem) {
      const kind = group(object.value);
      if (++counts[kind] > OBJECT_LIMIT)
        problem = `Over the limit of ${OBJECT_LIMIT} ${kind}`;
    }
    if (problem)
      skipped[slug] = { slug, value: stored?.value, modifiedAt, problem };
    else attention[slug] = { slug, value: object.value, modifiedAt };
  }
  const timers: Record<string, TimerState> = {};
  for (const [slug, state] of Object.entries(record.timers ?? {}))
    if (
      attention[slug]?.value.type === "timer" &&
      [state?.armedAt, state?.nextDue, state?.used].every(Number.isSafeInteger)
    )
      timers[slug] = state;
  return {
    pubkey: key,
    attention,
    skipped,
    config: record.config,
    ...(record.sourceRuns
      ? {
          sourceRuns: Object.fromEntries(
            Object.entries(record.sourceRuns)
              .filter(
                ([slug, signature]) =>
                  attention[slug]?.value.type === "source" &&
                  typeof signature === "string" &&
                  (sourceCompleted({ [slug]: signature }, attention[slug]) ||
                    sourceCompleted(
                      { [slug]: signature },
                      record.attention[slug],
                    )),
              )
              .map(([slug]) => [
                slug,
                sourceSignature(attention[slug] as AttentionObject),
              ]),
          ),
        }
      : {}),
    ...(record.attentionHistory
      ? {
          attentionHistory: Object.fromEntries(
            Object.entries(record.attentionHistory ?? {}).flatMap(
              ([slug, entry]) =>
                attention[slug] && entry && typeof entry === "object"
                  ? [
                      [
                        slug,
                        {
                          ...(Number.isFinite(entry.lastWokeAt)
                            ? { lastWokeAt: entry.lastWokeAt }
                            : {}),
                          ...(typeof entry.output === "string"
                            ? {
                                output: entry.output
                                  .slice(-16384)
                                  .split("\n")
                                  .slice(-40)
                                  .join("\n"),
                              }
                            : {}),
                          ...(Array.isArray(entry.events)
                            ? { events: recentEntries(entry.events) }
                            : {}),
                        },
                      ],
                    ]
                  : [],
            ),
          ),
        }
      : {}),
    timers,
    ...(record.attentionEnabled === true ? { attentionEnabled: true } : {}),
  };
}

/** Moves records from the old value that held every agent into one key per
 * agent, then removes it. Only that move writes many records at once: after
 * it, each save writes only its own agent's key, so a program that runs
 * other agents from the same storage keeps its changes. */
export async function splitLegacyRecords(
  storage: AgentStore,
  records: Readonly<Record<string, AgentRecord>>,
) {
  if (storage.get(STORAGE_KEY) === null) return;
  try {
    // A key is only added where none is saved: a program that moves late
    // never replaces what another saved since.
    await Promise.all(
      Object.values(records).map((record) =>
        storage.add(recordKey(record.pubkey), recordText(record)),
      ),
    );
    // The shared value goes only once every record is saved: until then it
    // is the only saved copy, and a record of an agent's own wins when both
    // are.
    await storage.set(STORAGE_KEY, null);
  } catch (error) {
    // This must not stop startup: it runs before the app can show an error.
    // The shared value stays, so the records are read from it and the move
    // is tried again at the next start.
    console.error("Agent records were not split", error);
  }
}

/** Removes a membership's record. */
export function removeRecord(storage: AgentStore, key: AgentKey) {
  return storage.set(recordKey(key), null);
}

/** A record as it is saved. */
export function recordText({ skipped, ...record }: AgentRecord) {
  // A sealed Interest's watches are saved in an envelope older readers reject.
  // Their history moves into the envelope rather than being saved twice.
  const enveloped = new Set(
    Object.values(record.attention)
      .filter(
        ({ value }) =>
          value.type !== "interest" &&
          sealed(record.attention, value.interest_id),
      )
      .map(({ slug }) => slug),
  );
  return JSON.stringify({
    ...record,
    ...(record.attentionHistory && {
      attentionHistory: Object.fromEntries(
        Object.entries(record.attentionHistory).filter(
          ([slug]) => !enveloped.has(slug),
        ),
      ),
    }),
    attention: {
      // Skipped objects go back where they were read from, so a later reader
      // that can apply them still finds them, enveloped as their Interest
      // requires: one over a limit here can be within an older reader's.
      ...Object.fromEntries(
        Object.values(skipped ?? {}).map(({ problem: _, ...object }) => [
          object.slug,
          { ...object, value: skippedValue(record.attention, object.value) },
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(record.attention).map(([slug, object]) => {
          const value = object.value;
          if (value.type === "interest") {
            // Active Interests need no extension, so older readers keep their instructions.
            const { paused, ...interest } = value;
            return [slug, paused ? object : { ...object, value: interest }];
          }
          return [
            slug,
            enveloped.has(slug)
              ? {
                  ...object,
                  value: {
                    ...value,
                    interest_paused: {
                      ...(record.timers?.[slug] && {
                        timer: record.timers[slug],
                      }),
                      ...(sourceCompleted(record.sourceRuns, object) && {
                        completed: true,
                      }),
                      ...(record.attentionHistory?.[slug] && {
                        history: record.attentionHistory[slug],
                      }),
                    },
                  },
                }
              : object,
          ];
        }),
      ),
    },
  });
}

/** A skipped watch's value, enveloped while its Interest is sealed and
 * unwrapped once that Interest is readable again. */
function skippedValue(
  attention: AgentRecord["attention"],
  value: unknown,
): unknown {
  if (!value || typeof value !== "object") return value;
  const { interest_paused, ...watch } = value as Record<string, unknown>;
  if (watch.type === "interest" || typeof watch.interest_id !== "string")
    return value;
  const parent = attention[`interest/${watch.interest_id}`]?.value;
  if (parent?.type !== "interest") return value;
  if (sealed(attention, watch.interest_id))
    return { ...watch, interest_paused: interest_paused ?? {} };
  return watch;
}

/** Saves one record, when it changed. */
export async function writeRecord(storage: AgentStore, record: AgentRecord) {
  const text = recordText(record);
  const key = recordKey(record.pubkey);
  if (storage.get(key) !== text) await storage.set(key, text);
}

/** Replaces or deletes (`value: null`) one attention object, after validating it
 * and the count limits. A timer keeps its run state while its `armed_at` is
 * unchanged, as Janet's do: a new interval applies from its next run, and
 * enabling it again runs at most one overdue occurrence. A new `armed_at` (a
 * rearm) sets a new deadline, one interval after it, and keeps the occurrences
 * already used. Only a timer with no saved state counts what was already due.
 * `schedule` overrides that for a timer: `rearm` always sets the new deadline,
 * even at the same `armed_at`, and `restart` also gives it a fresh budget, as
 * the owner's "Run again" does. */
export function setAttention(
  record: AgentRecord,
  slug: string,
  value: AttentionValue | null,
  now = Math.floor(Date.now() / 1000),
  schedule?: "rearm" | "restart",
): AgentRecord {
  const prior = record.attention[slug]?.value;
  const { [slug]: history, ...attentionHistory } =
    record.attentionHistory ?? {};
  if (history !== undefined) record = { ...record, attentionHistory };
  const { [slug]: completed, ...sourceRuns } = record.sourceRuns ?? {};
  if (completed !== undefined) record = { ...record, sourceRuns };
  const { [slug]: _, ...rest } = record.attention;
  const { [slug]: __, ...skipped } = record.skipped ?? {};
  const { [slug]: state, ...timers } = record.timers ?? {};
  if (value === null) return { ...record, attention: rest, skipped, timers };
  const problem = validateObject(slug, value);
  if (problem) throw new Error(problem);
  const kind = group(value);
  if (
    !prior &&
    Object.values(rest).filter((object) => group(object.value) === kind)
      .length >= OBJECT_LIMIT
  )
    throw new Error(`An agent can have at most ${OBJECT_LIMIT} ${kind}`);
  const kept =
    value.type === "timer"
      ? {
          ...timers,
          [slug]:
            state && prior?.type === "timer"
              ? rearmed(value, state, schedule)
              : timerState(value, undefined, now),
        }
      : timers;
  return {
    ...record,
    attention: { ...rest, [slug]: { slug, value, modifiedAt: now } },
    skipped,
    timers: kept,
  };
}

/** What one timer pass saw and decided, by slug: `seen` is the run state it
 * read, absent when the timer had none, and `next` the state it keeps. */
export type TimerProgress = Readonly<
  Record<string, Readonly<{ seen?: TimerState | undefined; next: TimerState }>>
>;

const sameState = (a: TimerState | undefined, b: TimerState | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.armedAt === b.armedAt &&
    a.nextDue === b.nextDue &&
    a.used === b.used);

/** `record` with a timer pass's progress, or undefined when that changes
 * nothing. A timer whose state is still what the pass saw takes the pass's
 * state. One whose state changed since, as a rearm or restart changes it,
 * keeps its new deadline, and the occurrences the pass used are added to it:
 * they ran, so they count. A timer that is gone takes nothing. */
export function withProgress(
  record: AgentRecord,
  progress: TimerProgress,
): AgentRecord | undefined {
  let timers = record.timers ?? {};
  for (const [slug, { seen, next }] of Object.entries(progress)) {
    if (record.attention[slug]?.value.type !== "timer") continue;
    const state = timers[slug];
    const kept =
      !state || sameState(state, seen)
        ? next
        : seen
          ? { ...state, used: state.used + next.used - seen.used }
          : state;
    if (!sameState(kept, state)) timers = { ...timers, [slug]: kept };
  }
  return timers === (record.timers ?? {}) ? undefined : { ...record, timers };
}

/** A group of the owner's agents and the text its members share. Membership
 * lives only here: an agent records nothing about its teams. */
export type Team = Readonly<{
  id: string;
  name: string;
  instructions: string;
  /** Agent pubkeys, in the order shown. */
  members: readonly string[];
  /** A synced team's confirmed head, the base its editor revises. */
  revision?: string;
}>;
export const TEAMS_KEY = "buzz.agents.teams.v1";

/** Reads every team, skipping any that is not one. */
export function readTeams(storage: AgentStore): readonly Team[] {
  let stored: unknown;
  try {
    stored = JSON.parse(storage.get(TEAMS_KEY) ?? "null");
  } catch {
    return [];
  }
  const teams =
    (stored as { version?: unknown; teams?: unknown } | null)?.version === 1
      ? (stored as { teams: unknown }).teams
      : undefined;
  if (!Array.isArray(teams)) return [];
  return teams.flatMap((team: Partial<Team> | null) =>
    typeof team?.id === "string" &&
    typeof team.name === "string" &&
    typeof team.instructions === "string" &&
    Array.isArray(team.members)
      ? [
          {
            id: team.id,
            name: team.name,
            instructions: team.instructions,
            members: team.members.filter((member) => PUBKEY.test(member)),
          },
        ]
      : [],
  );
}

export function writeTeams(storage: AgentStore, teams: readonly Team[]) {
  return storage.set(TEAMS_KEY, JSON.stringify({ version: 1, teams }));
}

/** A hosted agent its provider made whose setup has not finished. Kept so
 * Finish setup continues it instead of the provider making another. */
export type Unfinished = Readonly<{
  pubkey: string;
  /** The agent type's key, `pluginId/typeId`. */
  type: string;
  name: string;
  /** Its `wss://` community. */
  relay: string;
  owner: string;
  /** The HTTPS image URL it was made with, listed once it is set up. */
  picture?: string;
  /** Provider-owned creation settings, retained only until setup succeeds. */
  config?: unknown;
}>;
export const UNFINISHED_KEY = "buzz.agents.unfinished.v1";

/** Reads every unfinished setup, skipping any that is not one. */
export function readUnfinished(storage: AgentStore): readonly Unfinished[] {
  let stored: unknown;
  try {
    stored = JSON.parse(storage.get(UNFINISHED_KEY) ?? "null");
  } catch {
    return [];
  }
  const agents =
    (stored as { version?: unknown } | null)?.version === 1
      ? (stored as { agents: unknown }).agents
      : undefined;
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((agent: Partial<Unfinished> | null) =>
    PUBKEY.test(agent?.pubkey ?? "") &&
    PUBKEY.test(agent?.owner ?? "") &&
    typeof agent?.type === "string" &&
    typeof agent.name === "string" &&
    typeof agent.relay === "string"
      ? [
          {
            pubkey: agent.pubkey as string,
            type: agent.type,
            name: agent.name,
            relay: agent.relay,
            owner: agent.owner as string,
            ...(typeof agent.picture === "string"
              ? { picture: agent.picture }
              : {}),
            ...(agent.config !== undefined ? { config: agent.config } : {}),
          },
        ]
      : [],
  );
}

export function writeUnfinished(
  storage: AgentStore,
  agents: readonly Unfinished[],
) {
  return storage.set(UNFINISHED_KEY, JSON.stringify({ version: 1, agents }));
}

/** `state` for the edited `timer`: unchanged unless it was rearmed. */
function rearmed(
  timer: TimerWatch,
  state: TimerState,
  schedule?: "rearm" | "restart",
): TimerState {
  if (!schedule && state.armedAt === timer.armed_at) return state;
  return {
    armedAt: timer.armed_at,
    nextDue: timer.armed_at + timer.interval_secs,
    used: schedule === "restart" ? 0 : state.used,
  };
}

/** Agent memberships, by key, imported or added to their community where its
 * archive state could not be checked, so their settings keep offering Retry
 * across restarts until a check confirms it. */
export const ARCHIVE_UNCHECKED_KEY = "buzz.agents.archive-unchecked.v1";

export function readArchiveUnchecked(storage: AgentStore): Set<string> {
  let stored: unknown;
  try {
    stored = JSON.parse(storage.get(ARCHIVE_UNCHECKED_KEY) ?? "null");
  } catch {
    return new Set();
  }
  const agents =
    (stored as { version?: unknown } | null)?.version === 1
      ? (stored as { agents: unknown }).agents
      : undefined;
  return new Set(
    Array.isArray(agents)
      ? agents.filter((key): key is string => AGENT_KEY.test(String(key)))
      : [],
  );
}

export function writeArchiveUnchecked(
  storage: AgentStore,
  agents: ReadonlySet<string>,
) {
  return storage.set(
    ARCHIVE_UNCHECKED_KEY,
    JSON.stringify({ version: 1, agents: [...agents] }),
  );
}
