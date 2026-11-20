import { npubEncode } from "nostr-tools/nip19";
import {
  parseTeamManifest,
  parseTeamPayload,
  parseTextManifest,
  payloadCoordinate,
  TEAM_PAYLOAD_TAG,
  type TeamPayload,
  TEAM_MANIFEST_TAG,
  type TeamManifest,
} from "./team-payload.ts";

/** Private, community-scoped recipes. Never an OG channel-sections writer. */
export const KIT_TAG = "buzz-channel-kit-v1";
/** Separate discovery prevents older clients from rejecting the whole catalog. */
export const ME_KIT_TAG = "buzz-me-kit-v1";
export const KIT_RECORD_BYTES = 16 * 1024;
/** Canvas content a channel template may carry. */
export const TEMPLATE_CANVAS_BYTES = 24 * 1024;
export { LIVE_CANVAS_BYTES, LIVE_CANVAS_LIMIT } from "./canvas-limits.ts";
export type Lineup = { teamIds: string[]; agents: string[]; canvas: string };
export type Team = {
  type: "team";
  id: string;
  name: string;
  agents: string[];
  portable?: TeamManifest;
};
export type Template = Lineup & {
  type: "template";
  id: string;
  name: string;
  description: string;
};
export type Group = { id: string; name: string; defaultTemplateId: string };
export type Groups = {
  type: "groups";
  id: "me";
  groups: Group[];
  /** Project filing only; the channel's Solo label decides what is Solo. */
  assignments: Record<string, string>;
};
export type KitValue = Team | Template | Groups;
export type PayloadRecord = {
  version: 1;
  community: string;
  deleted: false;
  value: TeamPayload & { type: "team-payload"; id: string };
};
/** A team's shared instructions, kept apart from its v1/v2 team record so
 * older builds that only read team records never see it. */
export const TEAM_TEXT_TAG = "buzz-team-text-v1";
export type TextRecord = {
  version: 1;
  community: string;
  deleted: boolean;
  value: {
    type: "team-text";
    id: string;
    owner: string;
    manifest: TeamManifest | null;
  };
};
export type PrivateRecord = KitRecord | PayloadRecord | TextRecord;
export type KitRecord = {
  version: 1 | 2;
  community: string;
  deleted: boolean;
  value: KitValue;
};
export type KitEntry = {
  record: KitRecord;
  eventId: string;
  createdAt: number;
};
export type AgentChoice = {
  pubkey: string;
  name: string;
  avatar?: string | undefined;
};
export const emptyLineup = (): Lineup => ({
  teamIds: [],
  agents: [],
  canvas: "",
});
const keyPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid channel recipe");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, nonempty = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (nonempty && !value.trim())
  )
    throw new Error("Invalid channel recipe text");
  return value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !idPattern.test(value))
    throw new Error("Invalid channel recipe ID");
  return value;
}
function keys(value: unknown, pattern: RegExp, max: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((v) => typeof v !== "string" || !pattern.test(v)) ||
    new Set(value).size !== value.length
  )
    throw new Error("Invalid channel recipe selection");
  return [...value] as string[];
}
export function parseLineup(raw: unknown): Lineup {
  const v = object(raw);
  const canvas = text(v.canvas, TEMPLATE_CANVAS_BYTES);
  if (new TextEncoder().encode(canvas).length > TEMPLATE_CANVAS_BYTES)
    throw new Error(
      `Canvas is too large (${TEMPLATE_CANVAS_BYTES / 1024} KiB maximum)`,
    );
  return {
    teamIds: keys(v.teamIds, idPattern, 100),
    agents: keys(v.agents, keyPattern, 200),
    canvas,
  };
}
export function kitRecordFits(record: KitRecord) {
  return (
    new TextEncoder().encode(JSON.stringify(record)).length <= KIT_RECORD_BYTES
  );
}
export const soloCapacityMessage =
  "Solo workspace storage is full. Remove a chat from a workspace, then try again.";

export function parseKitRecord(raw: unknown, community: string): KitRecord {
  const r = object(raw),
    v = object(r.value);
  if (
    (r.version !== 1 && r.version !== 2) ||
    r.community !== community ||
    typeof r.deleted !== "boolean"
  )
    throw new Error("Unsupported recipe or wrong community");
  let value: KitValue;
  if (v.type === "team")
    value = {
      type: "team",
      id: id(v.id),
      name: text(v.name, r.version === 2 ? 256 : 120, true),
      agents: keys(v.agents, keyPattern, r.version === 2 ? 32 : 200),
      ...(r.version === 2 ? { portable: parseTeamManifest(v.portable) } : {}),
    };
  else if (v.type === "template")
    value = {
      type: "template",
      id: id(v.id),
      name: text(v.name, 120, true),
      description: text(v.description, 1000),
      ...parseLineup(v),
    };
  else if (v.type === "groups" && v.id === "me") {
    if (!Array.isArray(v.groups) || v.groups.length > 100)
      throw new Error("Too many Solo groups");
    const groups = v.groups.map((raw) => {
      const g = object(raw);
      return {
        id: id(g.id),
        name: text(g.name, 120, true),
        defaultTemplateId:
          g.defaultTemplateId === "" ? "" : id(g.defaultTemplateId),
      };
    });
    if (new Set(groups.map((g) => g.id)).size !== groups.length)
      throw new Error("Duplicate Solo group");
    const assignments = Object.entries(object(v.assignments));
    if (
      assignments.length > 1000 ||
      assignments.some(
        ([channel, group]) =>
          !/^[0-9a-f-]{36}$/.test(channel) ||
          !groups.some((g) => g.id === group),
      )
    )
      throw new Error("Invalid Solo group placement");
    value = {
      type: "groups",
      id: v.id,
      groups,
      // Records from before the Solo label also list `channels`. Dropping
      // it here frees that space on the next write.
      assignments: Object.fromEntries(assignments) as Record<string, string>,
    };
  } else throw new Error("Unsupported channel recipe type");
  if (
    r.version === 2 &&
    (value.type !== "team" || !value.portable || !value.agents.length)
  )
    throw new Error("Unsupported portable recipe");
  if (r.version === 1 && v.portable !== undefined)
    throw new Error("Portable teams require version 2");
  const result: KitRecord = {
    version: r.version,
    community,
    deleted: r.deleted,
    value,
  };
  if (!kitRecordFits(result))
    throw new Error(
      value.type === "groups"
        ? soloCapacityMessage
        : "This saved recipe exceeds 16 KiB; shorten its Canvas or selections",
    );
  return result;
}
export function kitTag(record: KitRecord) {
  if (
    record.value.type === "groups" ||
    (record.value.type === "template" &&
      record.value.id.startsWith("me-section-"))
  )
    return ME_KIT_TAG;
  return record.version === 2 ? TEAM_MANIFEST_TAG : KIT_TAG;
}
export function coordinate(record: KitRecord) {
  return `${kitTag(record)}:${encodeURIComponent(record.community)}:${record.value.type}:${record.value.id}`;
}

export const legacyWorkspaceRecipeCoordinate = (community: string) =>
  `${ME_KIT_TAG}:${encodeURIComponent(community)}:groups:me`;
export function resolveLineup(
  lineup: Lineup,
  entries: readonly KitEntry[],
  agents: readonly AgentChoice[],
) {
  const selected = new Set(lineup.agents);
  for (const teamId of lineup.teamIds) {
    const entry = entries.find(
      (e) => e.record.value.type === "team" && e.record.value.id === teamId,
    );
    if (!entry || entry.record.deleted || entry.record.value.type !== "team")
      throw new Error(
        `A selected team is unavailable (${teamId}); remove or replace it`,
      );
    entry.record.value.agents.forEach((key) => {
      selected.add(key);
    });
  }
  if (selected.size > 200)
    throw new Error("Choose at most 200 distinct agents");
  const available = new Map(agents.map((a) => [a.pubkey, a]));
  return [...selected].map((pubkey) => {
    const agent = available.get(pubkey);
    if (!agent)
      throw new Error(
        `Agent ${npubEncode(pubkey)} is unavailable in this community; remove or replace it`,
      );
    return agent;
  });
}

export function parsePayloadRecord(
  raw: unknown,
  community: string,
): PayloadRecord {
  const r = object(raw),
    value = object(r.value);
  if (
    r.version !== 1 ||
    r.community !== community ||
    r.deleted !== false ||
    value.type !== "team-payload"
  )
    throw new Error("Invalid team payload record");
  const payload = parseTeamPayload(value, community);
  if (value.id !== `${payload.revision}-${payload.index}`)
    throw new Error("Invalid team payload ID");
  return {
    version: 1,
    community,
    deleted: false,
    value: { ...payload, type: "team-payload", id: value.id as string },
  };
}
export function parseTextRecord(raw: unknown, community: string): TextRecord {
  const r = object(raw),
    value = object(r.value);
  if (
    Object.keys(r).some(
      (key) => !["version", "community", "deleted", "value"].includes(key),
    ) ||
    Object.keys(value).some(
      (key) => !["type", "id", "owner", "manifest"].includes(key),
    ) ||
    r.version !== 1 ||
    r.community !== community ||
    typeof r.deleted !== "boolean" ||
    value.type !== "team-text" ||
    typeof value.owner !== "string" ||
    !keyPattern.test(value.owner)
  )
    throw new Error("Invalid team instructions record");
  const manifest = r.deleted ? null : parseTextManifest(value.manifest);
  if (r.deleted ? value.manifest !== null : manifest?.owner !== value.owner)
    throw new Error("Invalid team instructions record");
  const result: TextRecord = {
    version: 1,
    community,
    deleted: r.deleted,
    value: {
      type: "team-text",
      id: id(value.id),
      owner: value.owner,
      manifest,
    },
  };
  if (
    new TextEncoder().encode(JSON.stringify(result)).length > KIT_RECORD_BYTES
  )
    throw new Error("Invalid team instructions record");
  return result;
}
export function textCoordinate(
  community: string,
  owner: string,
  teamId: string,
) {
  return `${TEAM_TEXT_TAG}:${encodeURIComponent(community)}:${owner}:${teamId}`;
}
export function parsePrivateRecord(
  raw: unknown,
  community: string,
): PrivateRecord {
  const type = object(object(raw).value).type;
  return type === "team-payload"
    ? parsePayloadRecord(raw, community)
    : type === "team-text"
      ? parseTextRecord(raw, community)
      : parseKitRecord(raw, community);
}
export function privateCoordinate(record: PrivateRecord) {
  return record.value.type === "team-payload"
    ? payloadCoordinate(record.value)
    : record.value.type === "team-text"
      ? textCoordinate(record.community, record.value.owner, record.value.id)
      : coordinate(record as KitRecord);
}
export function privateTag(record: PrivateRecord) {
  return record.value.type === "team-payload"
    ? TEAM_PAYLOAD_TAG
    : record.value.type === "team-text"
      ? TEAM_TEXT_TAG
      : kitTag(record as KitRecord);
}
