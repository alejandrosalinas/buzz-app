import type { FoundCommunity } from "../communities/find-community.ts";
import { coversCommunity } from "../federated-identity/community-hosts";
import {
  signInServers,
  type SessionSnapshot,
} from "../federated-identity/service.ts";

/**
 * Whether a community URL given before setup is covered by this build's
 * Builderlab, its first sign-in server, so first run signs in for it at once
 * rather than asking. Native's compiled server list decides, by the same
 * rules native attaches tokens with; a build with no compiled server has no
 * Builderlab sign-in and treats every community as unhosted.
 */
export async function hostedByThisBuilderlab(
  found: Pick<FoundCommunity, "url">,
  servers: () => Promise<readonly SessionSnapshot[]> = signInServers,
): Promise<boolean> {
  const hosts = await builderlabCommunityHosts(servers);
  return hosts !== undefined && coversCommunity(hosts, found.url);
}

/** The community hosts of this build's Builderlab, its first sign-in server;
 * none when the build has no compiled server or the list can't be read. */
export async function builderlabCommunityHosts(
  servers: () => Promise<readonly SessionSnapshot[]> = signInServers,
): Promise<readonly string[] | undefined> {
  const list = await servers().catch(() => undefined);
  return list?.[0]?.authority?.communityHosts;
}

/**
 * Whether this build signs in at the public Builderlab portal, so a first-run
 * sign-in is an account there. Exact origin: a build that signs in anywhere
 * else (unconfigured, or another deployment's portal) never is. A
 * federated-identity build is only when its identity origin is that portal.
 */
export function atPublicBuilderlab(
  build = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
): boolean {
  try {
    return new URL(build).origin === "https://app.builderlab.xyz";
  } catch {
    return false;
  }
}
