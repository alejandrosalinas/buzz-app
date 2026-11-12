import { useEffect, useState } from "react";
import { communityDestination } from "../communities/destination";
import { communityName } from "../communities/names";
import type { Membership } from "../communities/service";
import { coversCommunity } from "./community-hosts";
import type { FederatedIdentity } from "./service";

/** The joined memberships whose access a server's session decides,
 * in order: those its hosts cover that require NIP-FI. Until discovery says a
 * community doesn't, it counts: still being discovered or failed, it may, and
 * a quick switch must not skip the warning. Outside native, discovery
 * rejects, so every covered community counts, as it does without discovery. */
export function useSignInMemberships(
  identity: FederatedIdentity | undefined,
  hosts: readonly string[],
  memberships: readonly Membership[],
) {
  const covered = memberships
    .map((membership) => ({
      membership,
      url: communityDestination(membership.id).url,
    }))
    .filter(({ url }) => coversCommunity(hosts, url));
  // The effect follows the covered relays, not the array built each render.
  const key = covered.map(({ url }) => url).join("\n");
  const [requires, setRequires] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  useEffect(() => {
    if (!identity?.communityRequiresSignIn || !key) return;
    let live = true;
    for (const url of key.split("\n"))
      void identity
        .communityRequiresSignIn(url)
        .catch(() => true)
        .then((value) => {
          if (live)
            setRequires((known) =>
              known.get(url) === value ? known : new Map(known).set(url, value),
            );
        });
    return () => {
      live = false;
    };
  }, [identity, key]);
  return covered
    .filter(({ url }) => requires.get(url) !== false)
    .map(({ membership }) => membership);
}

/** Names for recovery copy; account cards use the same memberships for artwork. */
export function useSignInCommunities(
  identity: FederatedIdentity | undefined,
  hosts: readonly string[],
  memberships: readonly Membership[],
) {
  return useSignInMemberships(identity, hosts, memberships).map(communityName);
}

/** A sign-in server as copy names it: its organization, or its host. */
export function serverName(
  authority: Readonly<{ identityOrigin: string; organization: string | null }>,
) {
  return authority.organization ?? new URL(authority.identityOrigin).host;
}
