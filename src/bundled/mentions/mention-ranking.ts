import {
  exactName,
  extendsName,
  matchTier,
  nameStarts,
  normalizeName,
  startKey,
} from "../../features/search/person-match";
import { typedPublicKey } from "../../shared/identity/public-key";
import type { mentionCandidates } from "./mention-candidates";
export type MentionChoice = ReturnType<typeof mentionCandidates>[number] & {
  label: string;
  /** The generated key suffix that ends `label` (`Honey · 4prr`), if any. */
  qualifier?: string | undefined;
};
const normalized = normalizeName;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
// `needle` is already normalized, so its code points are the folded query.
const nameMatch = (text: string, needle: string) =>
  needle ? (matchTier(text, [...needle]) ?? Infinity) : 0;
const aliasMatch = (choice: MentionChoice, needle: string) =>
  Math.min(...choice.aliases.map((name) => nameMatch(name, needle)));
/**
 * `mentionMatch` for an already normalized, non-empty needle and the query's
 * `typedPublicKey`.
 */
function labelMatch(
  choice: MentionChoice,
  needle: string,
  key: string | undefined,
) {
  // An exact public key is not a name: it matches only its owner.
  if (key !== undefined) return choice.recipient.pubkey === key ? 0 : Infinity;
  // No known name means the displayed label is only an identity fallback.
  if (!choice.aliases.length) return Infinity;
  // Rank what the user sees before other real names for the same identity.
  const visible = nameMatch(choice.label, needle);
  if (Number.isFinite(visible)) return visible;
  return 4 + aliasMatch(choice, needle);
}
export function mentionMatch(choice: MentionChoice, query: string) {
  const needle = normalized(query);
  return needle ? labelMatch(choice, needle, typedPublicKey(query)) : 0;
}
// One sorted index of name starts per immutable choice list. Choices with a
// name too long to index are always kept for ranking to match directly.
const indexes = new WeakMap<
  readonly MentionChoice[],
  {
    starts: string[];
    owners: number[];
    unindexed: number[];
    /** The last query and its matches: one keystroke asks several times. */
    last?: { needle: string; matches: readonly MentionChoice[] };
  }
>();
/**
 * The choices, in their given order, with a label or alias that the query can
 * match, or, for an exact public key, the choice with that key: a superset of
 * every choice that `rankMentions` or `exactMention` keeps for this query, and
 * every choice with a name that starts with the query, which the Space check
 * for longer names relies on. A binary search of the list's name index finds
 * them, so a keystroke costs O(log n + matches) instead of a scan of every
 * choice.
 */
export function matchingMentions(
  choices: readonly MentionChoice[],
  query: string,
): readonly MentionChoice[] {
  const needle = startKey(normalized(query));
  if (!needle) return choices;
  const key = typedPublicKey(query);
  // The name index holds no keys.
  if (key !== undefined)
    return choices.filter((c) => c.recipient.pubkey === key);
  let index = indexes.get(choices);
  if (!index) {
    const entries: { start: string; owner: number }[] = [];
    const unindexed: number[] = [];
    choices.forEach((choice, owner) => {
      const names = [...new Set([choice.label, ...choice.aliases])].map(
        nameStarts,
      );
      if (names.some((name) => !name.complete)) unindexed.push(owner);
      else
        for (const name of names)
          for (const start of name.starts) entries.push({ start, owner });
    });
    entries.sort((a, b) => compare(a.start, b.start));
    index = {
      starts: entries.map((entry) => entry.start),
      owners: entries.map((entry) => entry.owner),
      unindexed,
    };
    indexes.set(choices, index);
  }
  if (index.last?.needle === needle) return index.last.matches;
  let low = 0;
  let high = index.starts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((index.starts[middle] ?? "") < needle) low = middle + 1;
    else high = middle;
  }
  const found = new Set<number>(index.unindexed);
  for (let i = low; index.starts[i]?.startsWith(needle); i += 1)
    found.add(index.owners[i] ?? 0);
  const matches = [...found]
    .sort((a, b) => a - b)
    .flatMap((owner) => choices[owner] ?? []);
  index.last = { needle, matches };
  return matches;
}
type Ranked = {
  c: MentionChoice;
  tier: readonly number[];
  label: string;
  block: string;
  blockLabel: string;
  recent: number;
  online: number;
};
const byRank = (a: Ranked, b: Ranked) => {
  for (let i = 0; i < a.tier.length; i += 1) {
    const d = (a.tier[i] ?? 0) - (b.tier[i] ?? 0);
    if (d) return d;
  }
  return (
    compare(a.blockLabel, b.blockLabel) ||
    compare(a.block, b.block) ||
    b.recent - a.recent ||
    Number(b.c.managed) - Number(a.c.managed) ||
    a.online - b.online ||
    compare(a.label, b.label) ||
    compare(a.c.recipient.pubkey, b.c.recipient.pubkey)
  );
};
/**
 * The first `limit` of `items` in `order`, as a stable sort would give them.
 * Most items lose to the current last kept item in one comparison, so taking
 * the top 50 of n costs about n comparisons instead of a full n log n sort.
 */
function first<T>(items: T[], order: (a: T, b: T) => number, limit: number) {
  if (limit >= items.length) return items.sort(order);
  const kept: T[] = [];
  for (const item of items) {
    const last = kept[kept.length - 1];
    if (kept.length === limit && last !== undefined && order(item, last) >= 0)
      continue;
    // After every equal kept item, as a stable sort keeps input order.
    let low = 0;
    let high = kept.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (order(item, kept[middle] as T) < 0) high = middle;
      else low = middle + 1;
    }
    kept.splice(low, 0, item);
    if (kept.length > limit) kept.pop();
  }
  return kept;
}
/**
 * Sorts by per-choice keys, so the order is transitive for any mix of people
 * and agents. Another community's agents follow everyone here. After match quality, your own agents come first. Agents that
 * share a name form one block at its first visible label; recency, managed,
 * and presence order only that block. With `limit` (a whole number, 0 or
 * more), only the first `limit` choices of that order are returned.
 */
export function rankMentions(
  choices: readonly MentionChoice[],
  query: string,
  history?: ReadonlyMap<string, number>,
  presence: (key: string) => string = () => "unknown",
  limit = Infinity,
) {
  const needle = normalized(query);
  const key = typedPublicKey(query);
  const keyed: Ranked[] = [];
  for (const c of choices) {
    const match = needle ? labelMatch(c, needle, key) : 0;
    if (!Number.isFinite(match)) continue;
    const tier = [
      c.member ? 0 : 1,
      c.elsewhere ? 1 : 0,
      match,
      aliasMatch(c, needle),
      c.agent && c.owned ? 0 : 1,
    ];
    keyed.push({
      c,
      tier,
      label: normalized(c.label),
      // People never join a block. On an equal label they sort first.
      block: c.agent
        ? `1${JSON.stringify([tier, normalized(c.recipient.name)])}`
        : `0${c.recipient.pubkey}`,
      blockLabel: "",
      recent: history?.get(c.recipient.pubkey) ?? 0,
      online: { online: 0, away: 1 }[presence(c.recipient.pubkey)] ?? 2,
    });
  }
  const blockLabels = new Map<string, string>();
  for (const k of keyed) {
    const label = blockLabels.get(k.block);
    if (label === undefined || k.label < label)
      blockLabels.set(k.block, k.label);
  }
  for (const k of keyed) k.blockLabel = blockLabels.get(k.block) ?? "";
  return first(keyed, byRank, limit).map((k) => k.c);
}
const choiceNames = (c: MentionChoice) => [...c.aliases, c.label];
/**
 * The known names that continue the query (README section 5), each once,
 * so no exact name can be selected while any exists. A key qualifier or
 * generated `(agent)` suffix only tells namesakes apart, so it never
 * continues the name. Nor does a choice's own longer name when that same
 * choice also has the exact name: one identity is not its own namesake.
 * Choices only arrive, never leave, so once a name continues the query
 * nothing that loads later can lift it: Space is declined, not pending.
 */
export function continuingNames(
  choices: readonly MentionChoice[],
  query: string,
) {
  // No name continues an exact public key.
  if (typedPublicKey(query) !== undefined) return [];
  const needle = normalized(query);
  const names = new Map<string, string>();
  // No name continues an empty query; skip folding every name at a bare `@`.
  if (!needle) return [];
  for (const c of choices) {
    // `Example Agent` never keeps `example` from selecting the agent that is
    // also named `Example`.
    if (choiceNames(c).some((name) => normalized(name) === needle)) continue;
    const label =
      c.qualifier && c.label.endsWith(` · ${c.qualifier}`)
        ? c.label.slice(0, -(c.qualifier.length + 3))
        : c.label;
    // Literal names still block through aliases; generated suffixes do not.
    const longer =
      c.agent && c.aliases.some((name) => `${name.trim()} (agent)` === label)
        ? c.aliases
        : [...c.aliases, label];
    for (const name of longer)
      if (extendsName(name, needle) && !names.has(normalized(name)))
        names.set(normalized(name), name.trim());
  }
  return [...names.values()];
}
export const continuedMention = (
  choices: readonly MentionChoice[],
  query: string,
) => continuingNames(choices, query).length > 0;
/**
 * Space is intent only for one exact key across the full, uncapped choice set.
 * Every choice can continue the name (`continuedMention`); only choices
 * `among` can equal it. An exact public key names only its owner.
 */
export const exactMention = (
  choices: readonly MentionChoice[],
  query: string,
  among: (choice: MentionChoice) => boolean = () => true,
) => {
  const key = typedPublicKey(query);
  if (key !== undefined)
    return choices.find((c) => c.recipient.pubkey === key && among(c))
      ?.recipient.pubkey;
  return continuedMention(choices, query)
    ? undefined
    : exactName(
        choices,
        choiceNames,
        query,
        (c) => c.aliases.length > 0 && among(c),
        () => [],
      )?.recipient.pubkey;
};
