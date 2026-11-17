import type { EventTemplate } from "nostr-tools";
import { soloLabels } from "../solo/labels.ts";
import { channelIdentity } from "../relay/channel-labels.ts";
import type { RelayEvent } from "../relay/events.ts";
import {
  channelTypeTag,
  exactLifecycleTag,
  lifecycleChannelId,
  lifecycleRecord,
} from "../relay/channel-lifecycle-protocol.ts";

export const editableMemberRoles = ["admin", "member", "guest"] as const;
export type EditableMemberRole = (typeof editableMemberRoles)[number];
export type MemberRole = EditableMemberRole | "owner" | "bot" | "unknown";
export type MemberChange = Readonly<{
  pubkey: string;
  /** `none` is reserved for system setup; `absent` is an explicit role addition. */
  expectedRole: MemberRole | "none" | "absent";
  /** `owner` transfers ownership: `pubkey` becomes owner and the viewer an admin. */
  role: EditableMemberRole | "owner" | "remove";
}>;
export type MemberAuthority = Readonly<{
  roles: Readonly<Record<string, MemberRole>>;
  canManage: boolean;
  canRemove: boolean;
  canRemoveOwnedAgent: boolean;
  /** A NIP-CL system channel, where administration may also add members. */
  system: boolean;
}>;
const PUBKEY = /^[0-9a-f]{64}$/;

/** Inputs have already passed the session reader's signature verification. */
export function memberAuthority(
  events: readonly RelayEvent[],
  channelId: string,
  viewer: string,
  relayAuthor: string,
): MemberAuthority {
  if (events.some((event) => ![39000, 39001, 39002].includes(event.kind)))
    throw new Error("Unexpected channel membership response");
  const metadata = lifecycleRecord(events, 39000, channelId, relayAuthor);
  const admins = lifecycleRecord(events, 39001, channelId, relayAuthor);
  const roster = lifecycleRecord(events, 39002, channelId, relayAuthor);
  if (!metadata || !admins || !roster)
    throw new Error(
      "Current member roles could not be verified. Refresh members and roles.",
    );
  const type = channelTypeTag(metadata);
  const archived = exactLifecycleTag(metadata, "archived");
  if (
    !["stream", "forum", "dm", "system"].includes(type ?? "") ||
    (archived !== undefined && archived !== "true" && archived !== "false")
  )
    throw new Error("Malformed channel state");
  const roles: Record<string, MemberRole> = {};
  for (const entry of roster.tags.filter(([key]) => key === "p")) {
    const [, key, , role] = entry;
    if (
      !key ||
      !PUBKEY.test(key) ||
      key in roles ||
      entry.length < 2 ||
      entry.length > 4
    )
      throw new Error("Malformed channel membership state");
    roles[key] = ["owner", "admin", "member", "guest", "bot"].includes(
      role ?? "",
    )
      ? (role as MemberRole)
      : "unknown";
  }
  const elevated = new Map<string, string>();
  for (const entry of admins.tags.filter(([key]) => key === "p")) {
    const [, key, role] = entry;
    if (
      entry.length !== 3 ||
      !key ||
      !PUBKEY.test(key) ||
      (role !== "owner" && role !== "admin") ||
      elevated.has(key) ||
      roles[key] !== role
    )
      throw new Error(
        "Member roles are inconsistent. Refresh members and roles.",
      );
    elevated.set(key, role);
  }
  if (
    Object.entries(roles).some(
      ([key, role]) =>
        (role === "owner" || role === "admin") && elevated.get(key) !== role,
    )
  )
    throw new Error(
      "Member roles are inconsistent. Refresh members and roles.",
    );
  const activeChannel = type !== "dm" && archived !== "true";
  // In Solo chats only owners and admins remove people; nobody changes roles.
  const solo = !!soloLabels(channelIdentity(metadata).labels);
  return Object.freeze({
    roles: Object.freeze(roles),
    canManage: activeChannel && !solo && elevated.has(viewer),
    canRemove: activeChannel && elevated.has(viewer),
    canRemoveOwnedAgent:
      activeChannel && !solo && !!roles[viewer] && roles[viewer] !== "unknown",
    system: type === "system",
  });
}

export function canManageMember(
  state: MemberAuthority,
  viewer: string,
  key: string,
) {
  const role = state.roles[key];
  return (
    state.canManage &&
    key !== viewer &&
    !!role &&
    role !== "owner" &&
    role !== "unknown"
  );
}

/** Ownership permits removal only; it never grants role-edit authority. */
export function canRemoveMember(
  state: MemberAuthority,
  viewer: string,
  key: string,
  owner?: string,
) {
  const role = state.roles[key];
  return (
    (state.canRemove || (state.canRemoveOwnedAgent && owner === viewer)) &&
    key !== viewer &&
    !!role &&
    role !== "owner" &&
    role !== "unknown"
  );
}

export const transferRefusal =
  "Ownership can only go to a person who has set up a profile.";

/** Only an owner hands over ownership, never to an agent or in a system channel. */
export function canTransferOwnership(
  state: MemberAuthority,
  viewer: string,
  key: string,
  agent: boolean,
) {
  return (
    !agent &&
    !state.system &&
    state.roles[viewer] === "owner" &&
    state.roles[key] !== "bot" &&
    canManageMember(state, viewer, key)
  );
}

export function authorizeMemberChange(
  state: MemberAuthority,
  viewer: string,
  change: MemberChange,
  owner?: string,
  /** Whether `change.pubkey` is an agent; unknown counts as one. */
  agent = true,
) {
  if (change.expectedRole === "none") {
    // This sentinel is reserved for the system-channel setup path.
    if (
      !state.system ||
      !state.canManage ||
      change.pubkey === viewer ||
      change.pubkey in state.roles ||
      !isEditableMemberRole(change.role)
    )
      throw new Error(
        "Membership or permissions changed. Refresh members and roles before trying again.",
      );
    return;
  }
  if (
    !(change.expectedRole === "absent"
      ? isEditableMemberRole(change.role) &&
        state.canManage &&
        PUBKEY.test(change.pubkey) &&
        change.pubkey !== viewer &&
        !(change.pubkey in state.roles)
      : change.role === "remove"
        ? canRemoveMember(state, viewer, change.pubkey, owner)
        : change.role === "owner"
          ? canTransferOwnership(state, viewer, change.pubkey, agent)
          : canManageMember(state, viewer, change.pubkey) &&
            isEditableMemberRole(change.role)) ||
    (change.expectedRole !== "absent" &&
      state.roles[change.pubkey] !== change.expectedRole) ||
    change.expectedRole === change.role
  )
    throw new Error(
      "Membership or permissions changed. Refresh members and roles before trying again.",
    );
}

/**
 * The relay stores an ordinary role as `bot` for a key with a recorded agent
 * owner, even when the request says `member`. Both are the same ordinary
 * permission level, so either one confirms a requested `member`. Other roles
 * must match exactly.
 */
export function memberChangeConfirmed(
  state: MemberAuthority,
  viewer: string,
  change: MemberChange,
) {
  if (change.role === "remove") return !(change.pubkey in state.roles);
  if (change.role === "owner")
    return (
      state.roles[change.pubkey] === "owner" && state.roles[viewer] === "admin"
    );
  const stored = state.roles[change.pubkey];
  return (
    stored === change.role || (change.role === "member" && stored === "bot")
  );
}

export function memberAdministrationTemplate(
  channelId: string,
  viewer: string,
  change: MemberChange,
): EventTemplate {
  const h = ["h", lifecycleChannelId(channelId)];
  return {
    kind: change.role === "remove" ? 9001 : 9000,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    // The relay decides each person in order, so the heir's promotion lets
    // the viewer, possibly the only owner, step down in the same event.
    tags:
      change.role === "owner"
        ? [h, ["p", change.pubkey, "owner"], ["p", viewer, "admin"]]
        : [
            h,
            ["p", change.pubkey],
            ...(change.role === "remove" ? [] : [["role", change.role]]),
          ],
  };
}

/** Purpose-bound broker admission; relay remains the authoritative ACL boundary. */
export function validateMemberAdministrationTemplate(
  event: EventTemplate,
  viewer: string,
) {
  const [h, p, last] = event?.tags ?? [];
  const transfer =
    event?.kind === 9000 &&
    p?.length === 3 &&
    p[2] === "owner" &&
    last?.length === 3 &&
    last[0] === "p" &&
    last[1] === viewer &&
    last[2] === "admin" &&
    PUBKEY.test(viewer);
  if (
    !event ||
    ![9000, 9001].includes(event.kind) ||
    event.content !== "" ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    !Array.isArray(event.tags) ||
    event.tags.length !== (event.kind === 9000 ? 3 : 2) ||
    h?.length !== 2 ||
    h[0] !== "h" ||
    p?.length !== (transfer ? 3 : 2) ||
    p[0] !== "p" ||
    !PUBKEY.test(p[1] ?? "") ||
    p[1] === viewer ||
    (event.kind === 9000 &&
      !transfer &&
      (last?.length !== 2 ||
        last[0] !== "role" ||
        !isEditableMemberRole(last[1])))
  )
    throw new Error("Invalid member administration command");
  lifecycleChannelId(h[1] ?? "");
}

function isEditableMemberRole(role: unknown): role is EditableMemberRole {
  return editableMemberRoles.some((value) => value === role);
}
