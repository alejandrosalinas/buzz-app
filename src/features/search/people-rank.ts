import { matchTier, normalizeName } from "./person-match";
import { searchOrder, type SearchUsage } from "./usage";
import { typedPublicKey } from "../../shared/identity/public-key";

export type PersonCandidate = {
  pubkey: string;
  /** The name shown, after namesake qualification. */
  label: string;
  /** The kind-0 handle, shown beside the label, when it differs from it. */
  username?: string | undefined;
  /** A community-verified full name, shown beside the label's detail. */
  fullName?: string | undefined;
  /** A managed agent's own name, matched but not shown, as in mentions. */
  agentName?: string | undefined;
  /** The profile name and handle the directory found this person by, matched
   * but not shown once a verified name replaces them. */
  profileNames?: readonly string[] | undefined;
  agent: boolean;
  /** peopleRelationships rank: lower is closer. */
  relationship: number;
  /** Search usage keys that lift this person: their own and their DM's. */
  usageKeys: readonly string[];
};

export const personKey = (pubkey: string) => `person:${pubkey}`;

/**
 * How well a person matches the typed text, or undefined. The shown label,
 * username and verified full name use the shared name rule (person-match). A
 * hidden agent or profile name ranks after every shown name, as `mentionMatch`
 * ranks hidden aliases.
 */
function personMatch(
  person: PersonCandidate,
  folded: readonly string[] | undefined,
) {
  // Blank suggestions have no exact name; relationship and usage order them.
  if (!folded) return 1;
  const tier = (name: string | undefined) =>
    name === undefined ? undefined : matchTier(name, folded);
  const shown = [
    tier(person.label),
    tier(person.username),
    tier(person.fullName),
  ].filter((value) => value !== undefined);
  if (shown.length) return Math.min(...shown);
  const hidden = [
    tier(person.agentName),
    ...(person.profileNames ?? []).map(tier),
  ].filter((value) => value !== undefined);
  return hidden.length ? 4 + Math.min(...hidden) : undefined;
}

/**
 * Command-K order for people and agents, as New message orders recipients:
 * the shared search order (an exact name, then the earlier choice for this
 * text, then relationship bands lifted by usage). Ties keep the given order,
 * so callers list the directory's rows first, in the order the relay ranked
 * them. `score` is the same order without the band, on the scale channel and
 * page rows use, so a caller can place the whole group among other groups.
 */
export function rankPeople<T extends PersonCandidate>(
  people: readonly T[],
  needle: string,
  usage: SearchUsage,
  picked: string | undefined,
) {
  // A pasted public key names its person exactly, though no name matches it.
  const key = typedPublicKey(needle);
  // Fold the query once, not once per person.
  const folded = needle.trim() ? [...normalizeName(needle)] : undefined;
  return people
    .flatMap((person) => {
      const rank = person.pubkey === key ? 0 : personMatch(person, folded);
      if (rank === undefined) return [];
      const row = {
        key: personKey(person.pubkey),
        rank,
        usageKeys: person.usageKeys,
      };
      return [
        {
          person,
          order: searchOrder(usage, picked, {
            ...row,
            band: person.relationship,
          }),
          score: searchOrder(usage, picked, row),
        },
      ];
    })
    .sort((a, b) => a.order - b.order);
}
