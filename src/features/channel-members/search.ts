import type { Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { foldProfiles } from "../relay/profiles";
import { searchedProfiles } from "../relay/profile-search";
import { matchPerson } from "../search/person-match";
import { typedPublicKey } from "../../shared/identity/public-key";

export const MEMBER_SEARCH_PAGE_SIZE = 30;

/** One bounded server-ranked page; never substitute a scan of cached profiles. */
export async function searchMembers(
  session: RelaySession,
  query: string,
  page: number,
  signal: AbortSignal,
) {
  const text = query.trim();
  if (!text || text.length > 256 || !Number.isSafeInteger(page) || page < 1)
    throw new Error("Enter a name or public key to search.");
  // An incomplete public key remains an ordinary query while typing.
  const exact = typedPublicKey(text);
  let profiles: Map<string, Profile>;
  let more = false;
  if (exact) {
    const events = await session.read(
      [{ kinds: [0], authors: [exact], limit: MEMBER_SEARCH_PAGE_SIZE }],
      { signal },
    );
    signal.throwIfAborted();
    profiles = foldProfiles(
      events.filter((event) => event.kind === 0 && event.pubkey === exact),
    );
    // A whole key names its owner even without a profile; the relay decides
    // whether they can be added.
    if (!profiles.has(exact))
      profiles.set(exact, { name: exact.slice(0, 10), nameIsFallback: true });
  } else {
    const events = await session.searchProfiles(text, {
      limit: MEMBER_SEARCH_PAGE_SIZE,
      page,
      signal,
    });
    signal.throwIfAborted();
    profiles = searchedProfiles(events, session.profiles.verifiedAuthority?.());
    more = events.length >= MEMBER_SEARCH_PAGE_SIZE;
  }
  // Rank the relay's page by the shared name rule.
  const score = (name: string) => matchPerson(name, text)?.tier ?? 4;
  return {
    people: [...profiles]
      .map(([pubkey, profile]) => ({ pubkey, ...profile }))
      .sort(
        (a, b) =>
          score(a.name) - score(b.name) ||
          a.name.localeCompare(b.name) ||
          a.pubkey.localeCompare(b.pubkey),
      ),
    more,
  };
}
export type MemberSearchResult = Awaited<ReturnType<typeof searchMembers>>;
