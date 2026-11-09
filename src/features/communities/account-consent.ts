import { coversCommunity } from "../federated-identity/community-hosts";
import type { SessionSnapshot } from "../federated-identity/service";
import type { JoinConsent } from "./FindCommunity";

/**
 * Whether the signed-in Builderlab account already gave the consent a join
 * policy asks for `relay` (a `wss://` or `https://` origin): the community is
 * one its server hosts. Builderlab account setup records a date of birth,
 * which kgoose refuses for anyone under 18, and agrees to the Buzz Terms of
 * Service and Privacy Policy, the documents Builderlab-hosted relays publish
 * as their join policy. Without a signed-in session (an imported key), or for
 * a community no signed-in server hosts, Join Community still asks.
 */
export function accountConsents(
  identity: { snapshot(): SessionSnapshot } | undefined,
  relay: string,
): boolean {
  const session = identity?.snapshot();
  return (
    session?.status === "signed-in" &&
    session.authority !== null &&
    coversCommunity(session.authority.communityHosts, relay)
  );
}

/** What an account's consent attests: an invite claim confirms the person's age with it. */
export const ACCOUNT_CONSENT: JoinConsent = Object.freeze({
  adult: true,
  agreed: true,
});
