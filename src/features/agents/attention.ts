// An agent's attention configuration in the `agent-attention/v1` format: Interests,
// event watches and timers, each one object at a slug. This module is the format
// only (validation and event matching), so the same objects can later move from
// local storage to the relay's encrypted addressable events.
import type { EventData } from "../relay/events";
import { threadReference } from "../relay/thread-reference";
import { channelSourceKind } from "../relay/channel-kinds";
import { reactionTarget } from "../relay/reaction-target";

export const ATTENTION_SCHEMA = "agent-attention/v1";

export type Interest = Readonly<{
  type: "interest";
  /** What the owner sees as the Interest's name. */
  title?: string;
  /** One or two sentences under the title on the owner's card. */
  summary?: string;
  instructions: string;
  paused?: boolean;
}>;
export type ClassifierQuestion = Readonly<{
  question: string;
  true?: string;
  false?: string;
  guidance?: string;
  /** The yes probability at which the answer passes; CLASSIFIER_THRESHOLD
   * when absent. */
  threshold?: number;
}>;
/** Janet's default: a lower threshold passes more events. */
export const CLASSIFIER_THRESHOLD = 0.2;
export type EventWatch = Readonly<{
  type: "event";
  interest_id: string;
  name?: string;
  enabled: boolean;
  since: number;
  channel?: string;
  root?: string;
  channels: "all" | readonly string[];
  kinds: readonly number[];
  /** The event's author must be one of these. Not with `exclude_authors`. */
  authors?: readonly string[];
  /** The event's author must not be one of these. */
  exclude_authors?: readonly string[];
  tags?: Readonly<Record<string, readonly string[]>>;
  /** true: replies only; false: top-level only (NIP-10 `reply` marker). */
  is_reply?: boolean;
  classifier?: Readonly<{
    questions: Readonly<Record<string, ClassifierQuestion>>;
  }>;
}>;
export type TimerWatch = Readonly<{
  type: "timer";
  interest_id: string;
  prompt: string;
  enabled: boolean;
  interval_secs: number;
  armed_at: number;
  max_occurrences: number | null;
  expires_at: number | null;
  channel?: string;
  root?: string;
}>;
/** A plugin-owned deterministic producer. Attention owns its registration and destination. */
export type SourceWatch = Readonly<{
  type: "source";
  interest_id: string;
  enabled: boolean;
  name?: string;
  provider: string;
  config: Readonly<Record<string, unknown>>;
  classifier?: EventWatch["classifier"];
  channel?: string;
  root?: string;
}>;
export type AttentionValue = Interest | EventWatch | TimerWatch | SourceWatch;
export type AttentionObject = Readonly<{
  slug: string;
  value: AttentionValue;
  /** Unix seconds; on the relay this is the event's `created_at`. */
  modifiedAt: number;
}>;

const ID = /^[!-~]{1,64}$/;
const CHANNEL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QUESTION = /^[a-z][a-z0-9_]{0,31}$/;
const PUBKEY = /^[0-9a-f]{64}$/;
const MAX_INT = 2 ** 53 - 1;
const BODY_LIMIT = 65_535;
/** At most this many Interests, and this many watches and timers together. */
export const OBJECT_LIMIT = 100;
const TEXT_LIMIT = 16_384;

export function parseSlug(slug: string) {
  const [, space, id] = /^(interest|watch)\/(.+)$/.exec(slug) ?? [];
  return space && id && ID.test(id)
    ? { space: space as "interest" | "watch", id }
    : undefined;
}
export const interestSlug = (id: string) => `interest/${id}`;
export const watchSlug = (id: string) => `watch/${id}`;

class Invalid extends Error {}
const fail = (message: string): never => {
  throw new Invalid(message);
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function fields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  for (const name of Object.keys(value))
    if (!required.includes(name) && !optional.includes(name))
      fail(`Unknown field: ${name}`);
  for (const name of required)
    if (!(name in value)) fail(`Missing field: ${name}`);
}
const bytes = (value: string) => new TextEncoder().encode(value).length;
const text = (value: unknown, name: string, max = BODY_LIMIT) => {
  if (typeof value !== "string" || value.includes("\0"))
    fail(`${name} must be text`);
  if (bytes(value as string) > max)
    fail(`${name} is longer than ${max.toLocaleString("en-US")} bytes`);
  return value as string;
};
const filled = (value: unknown, name: string, max?: number) =>
  text(value, name, max).trim() ? (value as string) : fail(`${name} is empty`);
function label(value: unknown, name: string, max = 256) {
  const result = text(value, name, max);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the spec excludes them.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(result))
    fail(`${name} must be a single line of text`);
  return result;
}
const integer = (value: unknown, name: string, min = 0, max = MAX_INT) =>
  Number.isSafeInteger(value) &&
  (value as number) >= min &&
  (value as number) <= max
    ? (value as number)
    : fail(`${name} must be a whole number from ${min} to ${max}`);
const unique = (values: readonly unknown[]) =>
  new Set(values).size === values.length;

function interestId(value: unknown) {
  return typeof value === "string" && ID.test(value)
    ? value
    : fail("interest_id must be an Interest id");
}

function eventWatch(value: Record<string, unknown>) {
  fields(
    value,
    ["type", "interest_id", "enabled", "since", "channels", "kinds"],
    [
      "name",
      "authors",
      "exclude_authors",
      "tags",
      "is_reply",
      "classifier",
      "channel",
      "root",
    ],
  );
  interestId(value.interest_id);
  if (value.name !== undefined) label(value.name, "name");
  if (typeof value.enabled !== "boolean") fail("enabled must be true or false");
  integer(value.since, "since", 1);
  destination(value);
  const { channels, kinds, tags, classifier } = value;
  if (channels !== "all")
    if (
      !Array.isArray(channels) ||
      !channels.length ||
      channels.length > 100 ||
      !unique(channels) ||
      channels.some(
        (channel) => typeof channel !== "string" || !CHANNEL.test(channel),
      )
    )
      fail('channels must be "all" or a list of channel ids');
  if (
    !Array.isArray(kinds) ||
    kinds.length > 100 ||
    !unique(kinds) ||
    kinds.some(
      (kind) => !Number.isSafeInteger(kind) || kind < 0 || kind > 65_535,
    )
  )
    fail("kinds must be a list of event kinds");
  if (tags !== undefined) {
    const keys = isObject(tags) ? Object.keys(tags).length : 0;
    if (!keys || keys > 16) fail("tags must name 1 to 16 tags");
    let total = 0;
    for (const [key, values] of Object.entries(tags as object)) {
      if (!/^[A-Za-z]$/.test(key) || key === "h")
        fail(`Tag ${key} must be one letter other than h`);
      if (!Array.isArray(values) || !values.length || values.length > 32)
        fail(`Tag ${key} needs 1 to 32 values`);
      for (const item of values as unknown[]) {
        if (!label(item, `Tag ${key}`, 1_024))
          fail(`Tag ${key} values are empty`);
        total += bytes(item as string);
      }
    }
    if (total > TEXT_LIMIT) fail("Tag values are longer than 16,384 bytes");
  }
  for (const name of ["authors", "exclude_authors"] as const) {
    const keys = value[name];
    if (
      keys !== undefined &&
      (!Array.isArray(keys) ||
        !keys.length ||
        keys.length > 100 ||
        !unique(keys) ||
        keys.some((key) => typeof key !== "string" || !PUBKEY.test(key)))
    )
      fail(`${name} must be a list of 1 to 100 hex public keys`);
  }
  if (value.authors !== undefined && value.exclude_authors !== undefined)
    fail("A watch cannot have both authors and exclude_authors");
  if (value.is_reply !== undefined && typeof value.is_reply !== "boolean")
    fail("is_reply must be true or false");
  validateClassifier(classifier);
}

function validateClassifier(classifier: unknown) {
  if (classifier !== undefined) {
    if (!isObject(classifier)) fail("classifier must be an object");
    fields(classifier as Record<string, unknown>, ["questions"]);
    const questions = (classifier as Record<string, unknown>).questions;
    const count = isObject(questions) ? Object.keys(questions).length : 0;
    if (!count || count > 8) fail("classifier needs 1 to 8 questions");
    let total = 0;
    for (const [name, question] of Object.entries(questions as object)) {
      if (!QUESTION.test(name) || name === "true" || name === "false")
        fail(`Invalid question name: ${name}`);
      if (!isObject(question)) fail(`Question ${name} must be an object`);
      const q = question as Record<string, unknown>;
      fields(q, ["question"], ["true", "false", "guidance", "threshold"]);
      for (const [key, max] of [
        ["question", 2_048],
        ["true", 4_096],
        ["false", 4_096],
        ["guidance", 8_192],
      ] as const)
        if (q[key] !== undefined) total += bytes(text(q[key], key, max));
      if (
        q.threshold !== undefined &&
        (typeof q.threshold !== "number" ||
          !(q.threshold > 0 && q.threshold < 1))
      )
        fail("threshold must be between 0 and 1");
    }
    if (total > TEXT_LIMIT) fail("Classifier text is longer than 16,384 bytes");
  }
}

function destination(value: Record<string, unknown>) {
  if (
    value.channel !== undefined &&
    (typeof value.channel !== "string" || !CHANNEL.test(value.channel))
  )
    fail("channel must be a channel id");
  if (value.root !== undefined) {
    if (value.channel === undefined) fail("root requires a channel");
    if (typeof value.root !== "string" || !PUBKEY.test(value.root))
      fail("root must be a 64-hex thread id");
  }
}

function timer(value: Record<string, unknown>) {
  fields(
    value,
    [
      "type",
      "interest_id",
      "prompt",
      "enabled",
      "interval_secs",
      "armed_at",
      "max_occurrences",
      "expires_at",
    ],
    ["channel", "root"],
  );
  destination(value);
  interestId(value.interest_id);
  filled(value.prompt, "prompt", TEXT_LIMIT);
  if (typeof value.enabled !== "boolean") fail("enabled must be true or false");
  integer(value.interval_secs, "interval_secs", 1, 31_536_000);
  integer(value.armed_at, "armed_at");
  if (value.max_occurrences !== null)
    integer(value.max_occurrences, "max_occurrences", 1);
  if (value.expires_at !== null) integer(value.expires_at, "expires_at");
}

/** Checks one object on its own, as a reader does. Returns a message, or nothing. */
export function validateObject(
  slug: string,
  value: unknown,
): string | undefined {
  try {
    const parsed = parseSlug(slug) ?? fail(`Invalid slug: ${slug}`);
    if (!isObject(value)) fail("value must be an object");
    const object = value as Record<string, unknown>;
    if (parsed.space === "interest") {
      if (object.type !== "interest")
        fail('An interest/ value has type "interest"');
      fields(object, ["type", "instructions"], ["title", "summary", "paused"]);
      if (object.paused !== undefined && typeof object.paused !== "boolean")
        fail("paused must be true or false");
      filled(object.instructions, "instructions", TEXT_LIMIT);
      if (object.title !== undefined && !label(object.title, "title").trim())
        fail("title is empty");
      if (object.summary !== undefined) filled(object.summary, "summary", 1024);
    } else if (object.type === "event") eventWatch(object);
    else if (object.type === "timer") timer(object);
    else if (object.type === "source") {
      fields(
        object,
        ["type", "interest_id", "enabled", "provider", "config"],
        ["name", "channel", "root", "classifier"],
      );
      interestId(object.interest_id);
      if (typeof object.enabled !== "boolean")
        fail("enabled must be true or false");
      if (object.name !== undefined) label(object.name, "name");
      if (
        typeof object.provider !== "string" ||
        !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(object.provider)
      )
        fail("provider must be plugin/source");
      if (!isObject(object.config)) fail("config must be an object");
      destination(object);
      validateClassifier(object.classifier);
    } else fail('A watch/ value has type "event", "timer" or "source"');
    const body = JSON.stringify({ schema: ATTENTION_SCHEMA, slug, value });
    if (bytes(body) > BODY_LIMIT)
      fail("The object is larger than 65,535 bytes");
    return undefined;
  } catch (error) {
    if (error instanceof Invalid) return error.message;
    throw error;
  }
}

/** Kinds that are conversation: only these p-tag an agent into a conversation,
 * and only these start a mention run. A reaction to or deletion of the agent's
 * message is addressed (no watch sees it) but is not someone talking to it. */
export const CHAT_KINDS: readonly number[] = [9, 40003, 40007, 46010];

/** Directly addressed events take the runtime's built-in mention path, never a
 * watch: an encrypted DM (kind 4) to the agent, or a chat event that p-tags it.
 * A chat reply that does not mention it, even in its own thread, is not
 * addressed, and neither is a reaction to or deletion of its message: only a
 * watch can wake it for one.
 * Its own events are the caller's to skip. */
export function addressedTo(event: EventData, agent: string) {
  if (event.pubkey === agent) return false;
  if (event.kind === 4 || CHAT_KINDS.includes(event.kind))
    return tagsAgent(event, agent);
  return false;
}
export const tagsAgent = (event: EventData, agent: string) =>
  event.tags.some((tag) => tag[0] === "p" && tag[1] === agent);

/** Steps 1, 2 and 4 of event watch matching. Step 3 (addressed events and the
 * agent's own events) belongs to the caller; classifiers are not run here. */
export function watchMatches(watch: EventWatch, event: EventData): boolean {
  if (!watch.enabled || event.created_at < watch.since) return false;
  // Watches need a channel source whether delivered live or polled. Global
  // events cannot gain one by supplying h tags; multiple homes are ambiguous.
  const homes = event.tags.filter(([name]) => name === "h");
  if (!channelSourceKind(event.kind) || homes.length !== 1 || !homes[0]?.[1])
    return false;
  if (watch.channels !== "all") {
    const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
    if (!channel || !watch.channels.includes(channel)) return false;
  }
  if (watch.kinds.length && !watch.kinds.includes(event.kind)) return false;
  if (watch.authors && !watch.authors.includes(event.pubkey)) return false;
  if (watch.exclude_authors?.includes(event.pubkey)) return false;
  for (const [key, values] of Object.entries(watch.tags ?? {}))
    if (
      event.kind === 7 && key === "e"
        ? !values.includes(reactionTarget(event) ?? "")
        : !event.tags.some(
            (tag) =>
              tag[0] === key && tag[1] !== undefined && values.includes(tag[1]),
          )
    )
      return false;
  // The relay's NIP-10 rule: only a `reply` marker makes a reply.
  return (
    watch.is_reply === undefined || watch.is_reply === !!threadReference(event)
  );
}

/** Runtime schedule state for one timer. Not config: it never leaves the runner. */
export type TimerState = Readonly<{
  armedAt: number;
  nextDue: number;
  used: number;
}>;
/** The saved state while it still describes this schedule. Without one, every
 * occurrence due by `now` counts as used, so a timer never runs more often than
 * it allows (occurrence k is due at armed_at + k × interval_secs). */
export function timerState(
  timer: TimerWatch,
  prior: TimerState | undefined,
  now: number,
): TimerState {
  if (prior && prior.armedAt === timer.armed_at) return prior;
  const used =
    now < timer.armed_at
      ? 0
      : Math.floor((now - timer.armed_at) / timer.interval_secs);
  return {
    armedAt: timer.armed_at,
    nextDue: timer.armed_at + (used + 1) * timer.interval_secs,
    used,
  };
}
export function timerSpent(timer: TimerWatch, state: TimerState, now: number) {
  return (
    (timer.expires_at !== null && now >= timer.expires_at) ||
    (timer.max_occurrences !== null && state.used >= timer.max_occurrences)
  );
}

// Reading the format for people: one line per watch, objects grouped by role.

export type ChannelChoice = Readonly<{ id: string; name: string }>;
export type Watch = EventWatch | TimerWatch | SourceWatch;
export type WatchObject = AttentionObject & { value: Watch };

export const UNITS = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
] as const;
export const plural = (count: number, unit: string) =>
  `${count} ${unit}${count === 1 ? "" : /(ch|s)$/.test(unit) ? "es" : "s"}`;
/** The largest whole unit of `seconds`. */
export function interval(seconds: number) {
  const [unit, size] =
    UNITS.find(([, size]) => seconds % size === 0) ?? UNITS[3];
  return { count: seconds / size, unit, size };
}
export function every(seconds: number) {
  const { count, unit } = interval(seconds);
  return count === 1 ? `Every ${unit}` : `Every ${plural(count, unit)}`;
}
/** `release-triage` reads as "Release triage". */
export const interestTitle = (id: string) => {
  const words = id.replace(/[-_]+/g, " ").trim() || id;
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** One line for a watch, for rows and the peek. */
export function describeWatch(
  watch: Watch,
  channels: readonly ChannelChoice[] = [],
) {
  if (watch.type === "timer") return every(watch.interval_secs);
  if (watch.type === "source") return watch.name || watch.provider;
  if (watch.name) return watch.name;
  const what =
    watch.kinds.length === 1 && watch.kinds[0] === 9
      ? "Messages"
      : watch.kinds.length
        ? `Kind ${watch.kinds.join(", ")} events`
        : "Any event";
  const only =
    watch.channels !== "all" && watch.channels.length === 1
      ? channels.find((item) => item.id === watch.channels[0])
      : undefined;
  const where =
    watch.channels === "all"
      ? "any channel"
      : only
        ? `#${only.name}`
        : plural(watch.channels.length, "channel");
  const filtered =
    watch.authors || watch.exclude_authors || watch.is_reply !== undefined;
  return `${what} in ${where}${filtered ? ", filtered" : ""}`;
}

/** The objects by role, in slug order; `orphans` serve no Interest. */
export function attentionOf(
  attention: Readonly<Record<string, AttentionObject>>,
) {
  const objects = Object.values(attention).sort((a, b) =>
    a.slug.localeCompare(b.slug),
  );
  const interests = objects.filter(
    (object) => object.value.type === "interest",
  );
  const watches = objects.filter(
    (object): object is WatchObject => object.value.type !== "interest",
  );
  const ids = new Set(interests.map((object) => parseSlug(object.slug)?.id));
  return {
    interests,
    watches,
    orphans: watches.filter((object) => !ids.has(object.value.interest_id)),
  };
}

/** Identity of the exact saved registration whose producer finished. */
export const sourceSignature = (object: AttentionObject) =>
  JSON.stringify(object);
export function sourceCompleted(
  runs: Readonly<Record<string, string>> | undefined,
  object: AttentionObject | undefined,
) {
  return (
    object?.value.type === "source" &&
    runs?.[object.slug] === sourceSignature(object)
  );
}

/** Interest pause leaves each watch's own enabled setting intact. */
export function interestPaused(
  attention: Readonly<Record<string, AttentionObject>>,
  id: string,
): boolean {
  const value = attention[`interest/${id}`]?.value;
  return value?.type === "interest" && value.paused === true;
}
