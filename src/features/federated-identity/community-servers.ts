import { communityDestination } from "../communities/destination";
import { communityName } from "../communities/names";
import type { Membership } from "../communities/service";
import { coversCommunity } from "./community-hosts";

/** The joined communities a server's hosts cover, by name, in order. */
export function coveredCommunities(
  hosts: readonly string[],
  memberships: readonly Membership[],
) {
  return memberships
    .filter((membership) =>
      coversCommunity(hosts, communityDestination(membership.id).url),
    )
    .map(communityName);
}

/** A sign-in server as copy names it: its organization, or its host. */
export function serverName(
  authority: Readonly<{ identityOrigin: string; organization: string | null }>,
) {
  return authority.organization ?? new URL(authority.identityOrigin).host;
}
