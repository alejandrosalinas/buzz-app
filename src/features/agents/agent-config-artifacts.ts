// NIP-AP config artifacts (NIP-AR kind 45010) in an agent's or team's config
// channel: identity, validation, the reads that decide state, and one save that
// tells "accepted" apart from "current". The caller supplies a relay-only
// snapshot reader and a narrow artifact writer.
import { PublishRejected } from "../relay/outbox";
import type { RelayWriter } from "../relay/transport";
import type { EventData, ReadFilter, RelayEvent } from "../relay/events";

export const ARTIFACT_KIND = 45010;
export type ArtifactType =
  | "buzz.agent.settings"
  | "buzz.agent.instructions"
  | "buzz.team";
export const ARTIFACT_MAX_CONTENT_BYTES = 131_072;
export const SETTINGS_MAX_CONTENT_BYTES = 65_535;
const MAX_TAGS = 256;
/** The largest complete signed event the relay takes: its default 512 KiB
 * WebSocket frame less the `["EVENT",…]` wrapper. Mirrors
 * `ARTIFACT_MAX_EVENT_BYTES` in `src-tauri/src/relay.rs`. */
export const ARTIFACT_MAX_EVENT_BYTES = 512 * 1024 - 16;

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).length;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** RFC 4122 UUIDv5 of `name` in `namespace`. */
export async function uuidv5(namespace: string, name: string) {
  if (!UUID.test(namespace)) throw new Error("Invalid UUID namespace");
  const ns = Uint8Array.from(
    namespace.replace(/-/g, "").match(/../g) ?? [],
    (h) => parseInt(h, 16),
  );
  const input = new Uint8Array([...ns, ...encoder.encode(name)]);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...hash.slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The artifact's immutable `d`: UUIDv5 of the type in the channel's namespace. */
export const artifactD = (type: ArtifactType, channel: string) =>
  uuidv5(channel, type);

export type Expected = Readonly<{
  channel: string;
  type: ArtifactType;
  d: string;
  /** For `buzz.team`: the selected team's id, from `expectedTeam`. */
  team?: string;
}>;

/** A team config channel's subject label (NIP-AP "Config channels"). */
export async function teamLabel(team: string) {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(team)),
  );
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `team-${hex.slice(0, 59)}`;
}

/** NIP-AP team id grammar: 1–64 scalars, no control or whitespace. */
const teamId = (value: string) =>
  [...value].length >= 1 &&
  [...value].length <= 64 &&
  !/[\p{Cc}\p{White_Space}]/u.test(value);

/** The team id to expect in a channel, once its subject label is proven to be
 * the channel's. Throws for a malformed id or a label from another team. */
export async function expectedTeam(team: string, channelLabel: string) {
  if (!teamId(team) || (await teamLabel(team)) !== channelLabel)
    throw new Error("Team does not belong to this config channel");
  return team;
}

const tag = (event: EventData, name: string) => {
  const found = event.tags.filter((t) => t[0] === name);
  const [only] = found;
  return found.length === 1 && only?.length === 2 ? only[1] : undefined;
};
export const artifactOp = (event: EventData) => tag(event, "op");
export const artifactPrev = (event: EventData) => tag(event, "prev");

/** Why a revision is invalid for its config channel, or undefined when valid
 * (NIP-AP "Config artifacts"). A deletion is valid with empty content. */
export function artifactProblem(event: EventData, expected: Expected) {
  if (event.kind !== ARTIFACT_KIND) return "Not an artifact";
  if (tag(event, "ar") !== "1") return "Unsupported artifact envelope";
  if (tag(event, "d") !== expected.d) return "Artifact identity mismatch";
  if (tag(event, "h") !== expected.channel) return "Artifact home mismatch";
  if (tag(event, "type") !== expected.type) return "Artifact type mismatch";
  if (event.tags.length > MAX_TAGS) return "Too many tags";
  const op = artifactOp(event);
  if (op === "delete")
    return event.content === "" ? undefined : "Malformed deletion";
  if (!["create", "update", "restore", "move"].includes(op ?? ""))
    return "Unknown artifact operation";
  const limit =
    expected.type === "buzz.agent.settings"
      ? SETTINGS_MAX_CONTENT_BYTES
      : ARTIFACT_MAX_CONTENT_BYTES;
  if (bytes(event.content) > limit) return "Artifact content is too large";
  if (event.content.includes("\u0000"))
    return "Artifact content contains U+0000";
  let body: unknown;
  try {
    body = JSON.parse(event.content);
  } catch {
    return "Artifact content is not JSON";
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return "Artifact content is not an object";
  const value = body as Record<string, unknown>;
  if (value.version !== 1) return "Unknown artifact version";
  if (expected.type === "buzz.agent.instructions")
    return typeof value.text !== "string"
      ? "Instructions text missing"
      : value.text.includes("\u0000")
        ? "Instructions contain U+0000"
        : undefined;
  if (expected.type === "buzz.agent.settings")
    return value.settings &&
      typeof value.settings === "object" &&
      !Array.isArray(value.settings)
      ? undefined
      : "Settings missing";
  const title = tag(event, "title");
  if (
    typeof value.name !== "string" ||
    !value.name.trim() ||
    bytes(value.name) > 512 ||
    value.name !== title ||
    typeof value.instructions !== "string"
  )
    return "Malformed team";
  if (value.instructions.includes("\u0000"))
    return "Instructions contain U+0000";
  const team = tag(event, "team");
  if (!team || !teamId(team) || team !== expected.team)
    return "Team does not match this config channel";
  return undefined;
}

/** A returned revision checked against the selected channel, `d` and type
 * before anything installs it: one that fails is the invalid head. Every path
 * that installs a head (sync, save, migration, recovery) goes through this. */
export const checkedHead = (event: RelayEvent, expected: Expected) => {
  const problem = artifactProblem(event, expected);
  return problem
    ? ({ kind: "head", event, problem } as const)
    : ({ kind: "head", event } as const);
};

/** The preset an agent settings snapshot names, such as "recommended". */
function settingsPreset(type: string, content: string) {
  if (type !== "buzz.agent.settings") return undefined;
  try {
    const { preset } = JSON.parse(content) as { preset?: unknown };
    return typeof preset === "string" && preset ? preset : undefined;
  } catch {
    return undefined;
  }
}

/** One revision to sign. `content` is the complete snapshot; `extra` carries
 * preserved client tags (e.g. `team`). Agent settings also get a `preset` tag
 * matching their content, so who is on Automatic can be counted from tags
 * without reading content; a carried one is never kept. */
export function artifactTemplate(
  input: Expected & {
    op: "create" | "update" | "restore";
    title: string;
    content: string;
    prev?: string;
    extra?: readonly (readonly string[])[];
  },
) {
  if ((input.op === "create") !== (input.prev === undefined))
    throw new Error("Only a create has no previous revision");
  const preset = settingsPreset(input.type, input.content);
  return {
    kind: ARTIFACT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: input.content,
    tags: [
      ["ar", "1"],
      ["d", input.d],
      ["h", input.channel],
      ["type", input.type],
      ["title", input.title],
      ["op", input.op],
      ...(input.prev ? [["prev", input.prev]] : []),
      ...(preset ? [["preset", preset]] : []),
      ...(input.extra ?? [])
        .filter(([name]) => name !== "preset")
        .map((t) => [...t]),
    ],
  };
}

/** Bytes of the complete signed event as sent, checked against
 * `ARTIFACT_MAX_EVENT_BYTES` before dispatch. */
export const signedEventBytes = (event: RelayEvent) =>
  bytes(JSON.stringify(event));

/** The relay's answer to one query, and nothing else: signature-verified,
 * access-checked, in the relay's order, with no merged live observations or
 * local outgoing events. Ordinary `session.read` merges both and so cannot
 * stand in for it. */
export type SnapshotRead = (
  filters: readonly ReadFilter[],
  options: { signal?: AbortSignal | undefined },
) => Promise<readonly RelayEvent[]>;

/** The explicit current-heads query. The relay's artifact parser takes only
 * `artifact`, `kinds`, `limit`, `offset` and `#tag` keys, and already reads
 * from the writer pool, so it carries no `consistency`. */
export const currentFilter = (channel: string): ReadFilter => ({
  kinds: [ARTIFACT_KIND],
  "#h": [channel],
  artifact: "current",
  limit: 16,
});

/** Current heads in a channel, by `d`. Omits deletions and redacted heads; a
 * returned head is authoritative even when its history is unreadable. Two
 * heads for one `d`, or a full page, decide nothing: undefined. */
export async function readCurrent(
  read: SnapshotRead,
  channel: string,
  signal?: AbortSignal,
) {
  const filter = currentFilter(channel);
  const events = await read([filter], { signal });
  // A full page may be truncated, and a partial read decides nothing.
  if (events.length >= filter.limit) return undefined;
  const heads = new Map<string, RelayEvent>();
  for (const event of events) {
    const d = tag(event, "d");
    if (!d || heads.has(d)) return undefined;
    heads.set(d, event);
  }
  return heads;
}

/** The head by `d` in `channel`, including a deletion. Empty, or anything but
 * one revision of `d`, decides nothing. The relay leaves system channels out
 * of any read whose `#h` does not name them (NIP-CL), members included. */
export async function readHead(
  read: SnapshotRead,
  channel: string,
  d: string,
  signal?: AbortSignal,
) {
  const events = await read(
    [
      {
        kinds: [ARTIFACT_KIND],
        "#h": [channel],
        "#d": [d],
        limit: 1,
        consistency: "strong",
      },
    ],
    { signal },
  );
  const [event] = events;
  return events.length === 1 && event && tag(event, "d") === d
    ? event
    : undefined;
}

export type Refusal =
  | "conflict"
  | "duplicate"
  | "permission"
  | "archived"
  | "too-large"
  | "invalid"
  | "rate-limited"
  | "unknown";

/** A relay refusal by its machine-readable prefix, never by HTTP status alone. */
export function refusal(message: string): Refusal {
  const prefix = /^([a-z-]+):/.exec(message)?.[1];
  if (
    prefix === "conflict" ||
    prefix === "duplicate" ||
    prefix === "rate-limited"
  )
    return prefix;
  if (/archived/i.test(message)) return "archived";
  if (
    prefix === "restricted" ||
    prefix === "auth-required" ||
    prefix === "blocked"
  )
    return "permission";
  if (prefix === "invalid")
    return /too large|too big|size/i.test(message) ? "too-large" : "invalid";
  return "unknown";
}

export type Delivery =
  | Readonly<{ status: "accepted"; event: RelayEvent }>
  | Readonly<{
      status: "refused";
      event: RelayEvent;
      refusal: Refusal;
      message: string;
    }>
  | Readonly<{ status: "uncertain"; event: RelayEvent; message: string }>;

/** Sends one signed revision. Only an OK or duplicate-OK proves acceptance; a
 * failure without a typed refusal leaves it uncertain, never rejected. An
 * event over the relay's size limit (`maxEventBytes`, from its NIP-11
 * document) is refused before dispatch. */
export async function deliver(
  writer: RelayWriter,
  event: RelayEvent,
  signal: AbortSignal,
  maxEventBytes = ARTIFACT_MAX_EVENT_BYTES,
): Promise<Delivery> {
  if (signedEventBytes(event) > maxEventBytes)
    return {
      status: "refused",
      event,
      refusal: "too-large",
      message: "Artifact event is too large",
    };
  try {
    await writer.publish(event, signal);
    return { status: "accepted", event };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof PublishRejected))
      return { status: "uncertain", event, message };
    const reason = error.reason ?? error.message;
    const kind = refusal(reason);
    if (kind === "duplicate") return { status: "accepted", event };
    if (kind === "unknown")
      return { status: "uncertain", event, message: reason };
    return { status: "refused", event, refusal: kind, message: reason };
  }
}

/** After acceptance, whether the accepted revision is the head. An older
 * accepted replay is superseded and never installed; no readable head leaves
 * the caller with acceptance only. */
export async function settle(
  read: SnapshotRead,
  event: RelayEvent,
  signal?: AbortSignal,
) {
  const head = await readHead(
    read,
    tag(event, "h") ?? "",
    tag(event, "d") ?? "",
    signal,
  );
  if (!head) return { status: "accepted-unavailable" as const };
  return head.id === event.id
    ? { status: "current" as const, head }
    : { status: "superseded" as const, head };
}
