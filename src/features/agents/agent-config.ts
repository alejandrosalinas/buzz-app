// The local synced copy of each agent's and team's config artifacts, one entry
// per `owner:community:channel:type`. It decides each artifact's state from relay
// evidence (NIP-AP "Artifact state"), fences every writer so a late or stale
// result never replaces newer state, and resolves start inputs synchronously
// from storage.
import { PRESET } from "./recommended";
import { verifyEvent } from "nostr-tools";
import type { RelayEvent } from "../relay/events";
import { localStore, type AgentStore } from "./store";
import {
  artifactOp,
  artifactPrev,
  type ArtifactType,
} from "./agent-config-artifacts";

export const CONFIG_STORAGE_KEY = "buzz.agents.config.v1";

export type ArtifactState = "present" | "invalid" | "deleted" | "unavailable";
export type Subject = Readonly<{
  owner: string;
  community: string;
  /** The agent pubkey, or the team id, whose config channel this is. */
  subject: string;
  channel: string;
  type: ArtifactType;
}>;
type Entry = {
  state: ArtifactState;
  head?: RelayEvent;
  problem?: string;
  generation: number;
  sequence: number;
  syncedAt?: number;
};
type Stored = {
  version: 1;
  entries: Record<string, Entry>;
  /** `owner:community:subject:type` once this device has seen any revision. */
  hadVersion: Record<string, true>;
  /** `owner:community:subject:type`: the channel it was last bound in, so a
   * start can find its confirmed copy while no channel is bound. */
  channels: Record<string, string>;
};
/** What a writer saw before its first await. */
export type Captured = Readonly<{ generation: number; sequence: number }>;

/** A strong read's answer for one artifact. `failed` covers partial,
 * inaccessible and errored reads: it changes nothing. */
export type ReadResult =
  | Readonly<{ kind: "head"; event: RelayEvent; problem?: string }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "failed" }>;
/** `reread`: the caller schedules a fresh strong read. */
export type Applied = "applied" | "unchanged" | "reread";

const key = (s: Subject) => `${s.owner}:${s.community}:${s.channel}:${s.type}`;
const hadKey = (s: Subject) =>
  `${s.owner}:${s.community}:${s.subject}:${s.type}`;

export class AgentConfigStore {
  private stored: Stored;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: AgentStore = localStore()) {
    this.stored = this.load();
  }

  state(subject: Subject): Readonly<Entry> {
    return (
      this.stored.entries[key(subject)] ?? {
        state: "unavailable",
        generation: 0,
        sequence: 0,
      }
    );
  }
  /** Called after any entry changes, live, read or written alike, so starts
   * and running agents re-resolve from the confirmed copy. */
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  hadVersion = (subject: Subject) => !!this.stored.hadVersion[hadKey(subject)];
  /** The channel `subject` (its `channel` ignored) was last bound in. */
  boundChannel = (subject: Subject): string | undefined =>
    this.stored.channels[hadKey(subject)];
  markBound(subject: Subject) {
    if (this.boundChannel(subject) === subject.channel) return;
    this.stored.channels[hadKey(subject)] = subject.channel;
    this.save();
  }

  /** Taken by every writer before its first await. */
  capture(subject: Subject): Captured {
    const { generation, sequence } = this.state(subject);
    return { generation, sequence };
  }

  /** A strong read issued at `captured`. Installed only while nothing changed
   * since; otherwise a differing answer is dropped and a fresh read requested. */
  applyRead(subject: Subject, captured: Captured, result: ReadResult): Applied {
    if (result.kind === "failed") return "unchanged";
    const next = this.fromRead(result);
    const entry = this.state(subject);
    if (
      captured.generation !== entry.generation ||
      captured.sequence !== entry.sequence
    )
      return same(entry, next) ? "unchanged" : "reread";
    if (result.kind === "head") this.markHadVersion(subject);
    this.write(subject, next);
    return "applied";
  }

  /** A live revision from the binding taken at `generation`. It advances only
   * a successor of the head current now; anything else asks for a read rather
   * than deciding by order of arrival. A retired binding changes nothing. */
  applyLive(
    subject: Subject,
    generation: number,
    event: RelayEvent,
    problem?: string,
  ): Applied {
    const entry = this.state(subject);
    if (generation !== entry.generation) return "unchanged";
    if (entry.head?.id === event.id) return "unchanged";
    if (!entry.head || artifactPrev(event) !== entry.head.id) return "reread";
    this.markHadVersion(subject);
    this.write(subject, live(event, problem));
    return problem ? "reread" : "applied";
  }

  /** A live NIP-29 redaction from the binding taken at `generation`.
   * Redacting the head retires it; a retired binding changes nothing. */
  applyRedaction(
    subject: Subject,
    generation: number,
    target: string,
  ): Applied {
    const entry = this.state(subject);
    if (generation !== entry.generation || entry.head?.id !== target)
      return "unchanged";
    this.write(subject, { state: "unavailable" });
    return "reread";
  }

  /** Community switch, channel reselection, archive, sign-out or loss of
   * access: every in-flight writer's capture becomes stale. */
  rebind(subject: Subject) {
    const entry = this.state(subject);
    this.put(subject, {
      state: "unavailable",
      generation: entry.generation + 1,
      sequence: entry.sequence + 1,
    });
  }

  /** Set when a head lookup returned a blocking head before any install
   * (migration `blocked`), so local text stops being a launch source. */
  markHadVersion(subject: Subject) {
    if (this.hadVersion(subject)) return;
    this.stored.hadVersion[hadKey(subject)] = true;
    this.save();
  }

  /** Instructions for a start from the synced copy. Pure over storage. */
  instructions(
    subject: Subject,
  ):
    | Readonly<{ ok: true; text: string }>
    | Readonly<{ ok: false; state: ArtifactState; problem?: string }> {
    const entry = this.state(subject);
    if (entry.state !== "present" || !entry.head)
      return entry.problem
        ? { ok: false, state: entry.state, problem: entry.problem }
        : { ok: false, state: entry.state };
    return {
      ok: true,
      text: (JSON.parse(entry.head.content) as { text: string }).text,
    };
  }

  private fromRead(result: Exclude<ReadResult, { kind: "failed" }>) {
    return result.kind === "empty"
      ? ({ state: "unavailable" } as const)
      : live(result.event, result.problem);
  }
  private write(
    subject: Subject,
    next: Pick<Entry, "state" | "head" | "problem">,
  ) {
    const entry = this.state(subject);
    this.put(subject, {
      ...next,
      generation: entry.generation,
      sequence: entry.sequence + 1,
      syncedAt: Date.now(),
    });
  }
  private put(subject: Subject, entry: Entry) {
    this.stored.entries[key(subject)] = entry;
    this.save();
    for (const listener of [...this.listeners]) listener();
  }
  private save() {
    // Unsaved, the next start reads the last saved copy and syncs again.
    void this.storage
      .set(CONFIG_STORAGE_KEY, JSON.stringify(this.stored))
      .catch((error: unknown) =>
        console.warn("Agent synced settings were not saved", error),
      );
  }
  private load(): Stored {
    const empty: Stored = {
      version: 1,
      entries: {},
      hadVersion: {},
      channels: {},
    };
    let value: unknown;
    try {
      value = JSON.parse(this.storage.get(CONFIG_STORAGE_KEY) ?? "null");
    } catch {
      return empty;
    }
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries))
      return empty;
    const entries: Record<string, Entry> = {};
    for (const [k, entry] of Object.entries(value.entries)) {
      // A malformed entry counts as never synced.
      if (!isEntry(entry)) continue;
      // A stored head is re-verified; one that fails counts as never synced.
      const copy = entry.head && { ...entry.head };
      const head = copy && verifyEvent(copy) ? copy : undefined;
      entries[k] =
        entry.head && !head
          ? {
              state: "unavailable",
              generation: entry.generation + 1,
              sequence: entry.sequence + 1,
            }
          : entry;
    }
    const hadVersion = (value.hadVersion ?? {}) as Stored["hadVersion"];
    const channels = isRecord(value.channels)
      ? (value.channels as Stored["channels"])
      : {};
    return { version: 1, entries, hadVersion, channels };
  }
}

const STATES: readonly unknown[] = [
  "present",
  "invalid",
  "deleted",
  "unavailable",
];
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
function isEntry(v: unknown): v is Entry {
  return (
    isRecord(v) &&
    STATES.includes(v.state) &&
    isCount(v.generation) &&
    isCount(v.sequence)
  );
}

function live(
  event: RelayEvent,
  problem?: string,
): Pick<Entry, "state" | "head" | "problem"> {
  if (artifactOp(event) === "delete") return { state: "deleted", head: event };
  return problem
    ? { state: "invalid", head: event, problem }
    : { state: "present", head: event };
}
const same = (entry: Entry, next: Pick<Entry, "state" | "head">) =>
  entry.state === next.state && entry.head?.id === next.head?.id;

/** One synced setting: free text or one of a fixed set. */
export type SettingRule = "string" | readonly string[];
export type SettingsSchema = Readonly<Record<string, SettingRule>>;

/** Strictly checks a settings object against a plugin's allowlist: unknown
 * keys, wrong types and out-of-set values are errors, never defaulted. */
export function settingsProblem(schema: SettingsSchema, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Settings are not an object";
  for (const [name, setting] of Object.entries(value)) {
    const rule = Object.hasOwn(schema, name) ? schema[name] : undefined;
    if (!rule) return `Unknown setting "${name}"`;
    if (typeof setting !== "string") return `Setting "${name}" is not text`;
    if (Array.isArray(rule) && !rule.includes(setting))
      return `Setting "${name}" has an unsupported value`;
  }
  return undefined;
}

/** The allowlisted fields of a plugin's config, for publishing. */
export const pickSettings = (schema: SettingsSchema, config: object) =>
  Object.fromEntries(
    Object.keys(schema)
      .filter((name) => name in config)
      .map((name) => [name, (config as Record<string, unknown>)[name]]),
  ) as Record<string, string>;

/** A config with its synced fields taken only from accepted `settings`: a
 * field they leave out gets the plugin's default, never this device's value.
 * Everything outside the schema stays this device's. */
export const withSynced = <C extends object>(
  schema: SettingsSchema,
  defaults: C,
  config: C,
  settings: Readonly<Record<string, string>>,
): C => ({
  ...config,
  ...pickSettings(schema, defaults),
  ...pickSettings(schema, settings),
});

/** A `buzz.agent.settings` body for a plugin: `{version: 1, agentType,
 * settings}`. Another agent type, or a value the plugin can't honour, is
 * invalid for start; one naming no type is the agent's (NIP-AP). */
export function syncedSettings(
  content: string,
  agentType: string,
  schema: SettingsSchema,
):
  | Readonly<{ settings: Record<string, string>; recommended?: true }>
  | Readonly<{ problem: string }> {
  const body = JSON.parse(content) as {
    agentType?: unknown;
    settings?: unknown;
    preset?: unknown;
  };
  if (body.agentType !== undefined && body.agentType !== agentType)
    return { problem: "These settings are for another agent type" };
  const problem = settingsProblem(schema, body.settings);
  return problem
    ? { problem }
    : {
        settings: body.settings as Record<string, string>,
        // Beside `settings`, where versions without it keep and ignore it
        // (NIP-AP "Editing"), so their strict settings check never sees it.
        ...(body.preset === PRESET ? { recommended: true as const } : {}),
      };
}

/** The error a launch shows instead of running a synced setting its runtime
 * doesn't offer on a default (NIP-AP `buzz.agent.settings`). */
export const unsupportedSynced = (name: string, value: string, by: string) =>
  `This agent's synced ${name} "${value}" isn't offered by ${by}. Change it in Settings.`;

/** The error a launch shows when it can't tell whether its runtime offers a
 * synced setting, which it never runs unchecked (NIP-AP). */
export const unverifiedSynced = (name: string, value: string, by: string) =>
  `Couldn't check that ${by} offers this agent's synced ${name} "${value}". Try again, or change it in Settings.`;
