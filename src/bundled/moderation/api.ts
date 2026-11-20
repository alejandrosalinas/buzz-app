// Owner/admin requests through the selected community adapter. Roles come from
// the shared roster reader; the relay decides every change.
import { communityRequest } from "../../features/communities/api";
import { communityDestination } from "../../features/communities/destination";
import {
  parsePastedInvite,
  pastedInviteError,
} from "../../features/communities/invite-link";
import type { Member, Role } from "../../features/communities/roster";

export {
  MEMBERSHIP_KIND,
  membersFromSnapshot,
  type Member,
  type Role,
} from "../../features/communities/roster";

export type Invite = {
  invite_id: string;
  code: string;
  url: string;
  expires_at: number;
  max_uses: number | null;
  uses_remaining: number | null;
};
/** A listed invite; the relay never returns its code. */
export type InviteSummary = {
  id: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  max_uses: number | null;
  use_count: number;
  revoked_at: number | null;
  status: "active" | "revoked" | "expired" | "exhausted";
};
export type InvitePage = {
  invites: InviteSummary[];
  next_before: string | null;
};
export type MemberChange =
  | { action: "add" | "role"; pubkey: string; role: "admin" | "member" }
  | { action: "remove"; pubkey: string };

export type Action = "promote" | "demote" | "remove";
/** Actions the relay's permission matrix would allow `actor` to take on `target`. */
export function allowedActions(
  actor: Role | undefined,
  target: Member,
  self: boolean,
): Action[] {
  if (self || target.role === "owner") return [];
  if (actor === "admin") return target.role === "member" ? ["remove"] : [];
  if (actor !== "owner") return [];
  return [target.role === "admin" ? "demote" : "promote", "remove"];
}

export const mintInvite = (
  community: string,
  ttl_secs: number,
  max_uses: number | null,
) => communityRequest<Invite>(community, "invite", { ttl_secs, max_uses });

/** One page of the community's invites, newest first. */
export const listInvites = (community: string, before?: string) =>
  communityRequest<InvitePage>(community, "invites", before ? { before } : {});

export const revokeInvite = (
  community: string,
  target: { id: string } | { code: string },
) =>
  communityRequest<{ id: string; revoked_at: number }>(
    community,
    "invite-revoke",
    target,
  );

/** The code in a pasted link to this community, or why it can't be revoked here. */
export function pastedInviteCode(
  community: string,
  input: string,
): { code: string } | { error: string } {
  const link = parsePastedInvite(input);
  if (!link?.code)
    return { error: pastedInviteError(input.trim(), "Paste an invite link.") };
  if (link.community !== communityDestination(community).url)
    return { error: "This invite link is for a different community." };
  return { code: link.code };
}

export async function changeMember(community: string, change: MemberChange) {
  const receipt = await communityRequest<{
    accepted?: boolean;
    message?: string;
  }>(community, "member", change);
  if (!receipt.accepted)
    throw new Error(receipt.message || "The relay did not accept the change");
}
