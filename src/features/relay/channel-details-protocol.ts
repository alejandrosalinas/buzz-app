import type { EventTemplate } from "nostr-tools";
import type { RelayEvent } from "./events.ts";
import type { ChannelSummary } from "./contracts.ts";
import {
  exactLifecycleTag,
  lifecycleChannelId,
  lifecycleRecord,
  lifecycleSettings,
} from "./channel-lifecycle-protocol.ts";
import {
  channelIdentity,
  channelLabelTags,
  validChannelLabel,
} from "./channel-labels.ts";

export type ChannelDetailsDraft = Readonly<{
  name: string;
  description: string;
  visibility: "public" | "private";
  /** Admission default only; omission preserves existing relay behavior. */
  joinRole?: "member" | "guest" | undefined;
  /** Absent means ongoing; retain existing custom temporary intervals. */
  ttlSeconds?: number | undefined;
  /** NIP-CL labels. Absent leaves the relay's set unchanged; empty clears it. */
  labels?: readonly string[] | undefined;
}>;
export type ChannelDetails = ChannelDetailsDraft &
  Readonly<{
    channelId: string;
    version: string;
    canEdit: boolean;
  }>;
/** What General access shows and whether it offers changes. */
export type ChannelAccess = Pick<
  ChannelDetails,
  "visibility" | "joinRole" | "labels" | "canEdit"
>;

const editable = (
  type: string | undefined,
  archived: boolean,
  role: string | undefined,
) =>
  !!type &&
  type !== "dm" &&
  !archived &&
  (role === "owner" || role === "admin");

/** Access from the live channel summary, which folds the same signed metadata
 * and roster role. Display only: changes still read fresh details. */
export function summaryAccess(
  channel: ChannelSummary,
): ChannelAccess | undefined {
  if (!channel.visibility) return;
  return {
    visibility: channel.visibility,
    joinRole: channel.joinRole,
    labels: channel.labels,
    canEdit: editable(
      channel.channelType,
      !!channel.archived,
      channel.viewerRole,
    ),
  };
}

/** Missing or contradictory flags are unknown, never implicitly public. */
export function channelVisibility(
  event: RelayEvent,
): "public" | "private" | undefined {
  const flags = event.tags.filter(
    ([key]) => key === "public" || key === "private",
  );
  const flag = flags[0];
  return flags.length === 1 && flag?.length === 1
    ? (flag[0] as "public" | "private")
    : undefined;
}

/** Match buzz-core canonical_channel_name: Rust char::is_whitespace uses
 * Unicode White_Space (unlike JS trim, which omits U+0085 and includes U+FEFF). */
export function canonicalDetailsName(name: string): string {
  return name.replace(/^[#\p{White_Space}]+|\p{White_Space}+$/gu, "");
}

/** Shared field feedback; the command validator remains the write boundary. */
export function detailsDraftErrors(draft: ChannelDetailsDraft) {
  return {
    name:
      !draft ||
      typeof draft.name !== "string" ||
      !draft.name ||
      draft.name !== canonicalDetailsName(draft.name) ||
      [...draft.name].length > 120
        ? "Enter a channel name of 1–120 characters without a leading #."
        : undefined,
    description:
      !draft ||
      typeof draft.description !== "string" ||
      [...draft.description].length > 1000
        ? "Use a description of at most 1,000 characters."
        : draft.description.includes("Buzz Huddle (")
          ? 'Remove "Buzz Huddle (" from the description; that text is used by Buzz for Huddles.'
          : undefined,
    lifetime:
      draft?.ttlSeconds !== undefined &&
      (!Number.isInteger(draft.ttlSeconds) ||
        draft.ttlSeconds <= 0 ||
        draft.ttlSeconds > 2_147_483_647)
        ? "Channel duration could not be verified."
        : undefined,
    visibility:
      !draft ||
      (draft.visibility !== "public" && draft.visibility !== "private")
        ? "Channel visibility could not be verified."
        : undefined,
    labels: labelsError(draft?.labels),
    joinRole:
      draft?.joinRole !== undefined &&
      draft.joinRole !== "member" &&
      draft.joinRole !== "guest"
        ? "New participant role could not be verified."
        : undefined,
  };
}

function labelsError(labels: unknown): string | undefined {
  if (labels === undefined) return undefined;
  if (!Array.isArray(labels)) return "Channel labels could not be verified.";
  try {
    channelLabelTags(labels);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Same label set, ignoring order and duplicates. */
export function sameLabels(a: readonly string[], b: readonly string[]) {
  const left = new Set(a);
  const right = new Set(b);
  return (
    left.size === right.size && [...left].every((label) => right.has(label))
  );
}

export function validateDetailsDraft(draft: ChannelDetailsDraft): void {
  const errors = detailsDraftErrors(draft);
  const error =
    errors.name ??
    errors.description ??
    errors.visibility ??
    errors.lifetime ??
    errors.labels ??
    errors.joinRole;
  if (error) throw new Error(error);
}

export function detailsSettings(
  events: readonly RelayEvent[],
  id: string,
  viewer: string,
  relayAuthor: string,
) {
  const metadata = lifecycleRecord(events, 39000, id, relayAuthor);
  if (!metadata)
    throw new Error("Current channel details could not be verified.");
  // Reuse exact roster/admin validation, not cached roster roles or local key custody.
  const authority = lifecycleSettings(events, id, viewer, relayAuthor);
  const admins = lifecycleRecord(events, 39001, id, relayAuthor);
  const role = admins?.tags.find(
    ([key, value]) => key === "p" && value === viewer,
  )?.[2];
  const visibility = channelVisibility(metadata);
  const joinRole = channelJoinRole(metadata);
  const name = exactLifecycleTag(metadata, "name");
  const description = exactLifecycleTag(metadata, "about") ?? "";
  const ttl = exactLifecycleTag(metadata, "ttl");
  const ttlSeconds = parseDetailsTtl(ttl);
  if (!name || !visibility)
    throw new Error("Current channel details could not be verified.");
  const details: ChannelDetails = Object.freeze({
    channelId: id,
    version: metadata.id,
    name,
    description,
    visibility,
    ...(joinRole ? { joinRole } : {}),
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    labels: channelIdentity(metadata).labels,
    canEdit: editable(
      authority.channelType,
      exactLifecycleTag(metadata, "archived") === "true",
      role,
    ),
  });
  return { details, metadata };
}

export function detailsTemplate(
  id: string,
  draft: ChannelDetailsDraft,
  base: ChannelDetailsDraft,
): EventTemplate {
  validateDetailsDraft(draft);
  return {
    kind: 9002,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [
      ["h", lifecycleChannelId(id)],
      ["name", draft.name],
      ["about", draft.description],
      // Omission preserves current visibility, including in the remaining read/write race.
      ...(draft.visibility !== base.visibility
        ? [["visibility", draft.visibility === "private" ? "private" : "open"]]
        : []),
      // Re-sending an unchanged TTL resets the relay's cleanup deadline.
      ...(draft.ttlSeconds !== base.ttlSeconds
        ? [
            [
              "ttl",
              draft.ttlSeconds === undefined ? "" : String(draft.ttlSeconds),
            ],
          ]
        : []),
      ...(draft.joinRole !== undefined && draft.joinRole !== base.joinRole
        ? [["join_role", draft.joinRole]]
        : []),
      // NIP-CL: `t` tags replace the set; one empty `t` clears it; none keeps it.
      ...(draft.labels !== undefined &&
      !sameLabels(draft.labels, base.labels ?? [])
        ? draft.labels.length
          ? channelLabelTags(draft.labels)
          : [["t", ""]]
        : []),
    ],
  };
}

/** The `t` tags that end a full details command: one `["t", ""]` clears the
 * set, otherwise 1–8 distinct labels. */
function detailsLabels(tags: readonly (readonly string[])[]): string[] {
  const values = tags.map(([, value]) => value ?? "");
  if (values.length === 1 && values[0] === "") return [];
  if (
    values.length > 8 ||
    new Set(values).size !== values.length ||
    !values.every(validChannelLabel)
  )
    throw new Error("Invalid channel details command.");
  return values;
}

/** Display-only TTL for summaries; malformed metadata shows no lifetime instead of failing the list. */
export function channelTtl(event: RelayEvent): number | undefined {
  try {
    return parseDetailsTtl(exactLifecycleTag(event, "ttl"));
  } catch {
    return undefined;
  }
}

/** Legacy absence means Member; malformed explicit defaults fail closed to Guest. */
export function channelJoinRole(event: RelayEvent): "member" | "guest" {
  const tags = event.tags.filter(([key]) => key === "join_role");
  if (tags.length === 0) return "member";
  return tags.length === 1 && tags[0]?.length === 2 && tags[0]?.[1] === "member"
    ? "member"
    : "guest";
}

/** A relay metadata TTL must be an unambiguous positive i32; only absence is ongoing. */
function parseDetailsTtl(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (
    !/^[1-9]\d*$/.test(value) ||
    Number(value) > 2_147_483_647 ||
    String(Number(value)) !== value
  )
    throw new Error("Channel duration could not be verified.");
  return Number(value);
}

/** Separate from lifecycle and outbox admission. Admits only explicit open/private visibility. */
export function validateDetailsTemplate(event: EventTemplate): void {
  if (
    event?.kind !== 9002 ||
    event.content !== "" ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    !Array.isArray(event.tags) ||
    event.tags.length < 3 ||
    !event.tags.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.length === 2 &&
        tag.every((value) => typeof value === "string"),
    ) ||
    !["h", "name", "about"].every(
      (key, index) => event.tags[index]?.[0] === key,
    ) ||
    ![
      [],
      ["visibility"],
      ["ttl"],
      ["visibility", "ttl"],
      ["join_role"],
      ["visibility", "join_role"],
      ["ttl", "join_role"],
      ["visibility", "ttl", "join_role"],
    ].some(
      (keys) =>
        keys.every((key, index) => event.tags[index + 3]?.[0] === key) &&
        event.tags.slice(keys.length + 3).every(([key]) => key === "t"),
    )
  )
    throw new Error("Invalid channel details command.");
  const labels = detailsLabels(event.tags.filter(([key]) => key === "t"));
  const visibility = event.tags.find(([key]) => key === "visibility");
  if (visibility && !["private", "open"].includes(visibility[1] ?? ""))
    throw new Error("Invalid channel details command.");
  const ttl = event.tags.find(([key]) => key === "ttl")?.[1];
  const joinRole = event.tags.find(([key]) => key === "join_role")?.[1];
  if (joinRole !== undefined && joinRole !== "member" && joinRole !== "guest")
    throw new Error("Invalid channel details command.");
  lifecycleChannelId(event.tags[0]?.[1] ?? "");
  validateDetailsDraft({
    name: event.tags[1]?.[1] ?? "",
    description: event.tags[2]?.[1] ?? "",
    visibility: visibility?.[1] === "private" ? "private" : "public",
    ttlSeconds: ttl === "" ? undefined : parseDetailsTtl(ttl),
    ...(joinRole ? { joinRole } : {}),
    ...(event.tags.some(([key]) => key === "t") ? { labels } : {}),
  });
}
