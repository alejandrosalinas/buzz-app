import type { EmojiMartData } from "@emoji-mart/data";
import type { CustomEmoji } from "../../features/relay/emoji";
import { defaultSkinTone } from "./skin-tone";

export type EmojiMatch = Readonly<{
  id: string;
  shortcode: string;
  name: string;
  text: string;
  url?: string;
}>;
type Standard = EmojiMatch & {
  terms: readonly string[];
  /** Natives by Mart skin index 1–6, for emoji that have tones. */
  skins?: readonly string[];
};
const normalize = (value: string) => value.toLowerCase().replace(/[-_\s]/g, "");
let standard: Promise<readonly Standard[]> | undefined;

type ShortcodeScore = Readonly<{ tier: number; score: number }>;

function subsequenceSpan(query: string, target: string) {
  let first = -1;
  let last = -1;
  let queryIndex = 0;
  for (
    let index = 0;
    index < target.length && queryIndex < query.length;
    index++
  ) {
    if (target[index] !== query[queryIndex]) continue;
    if (first < 0) first = index;
    last = index;
    queryIndex++;
  }
  return queryIndex === query.length ? last - first : undefined;
}

function shortcodeScore(
  query: string,
  shortcode: string,
): ShortcodeScore | undefined {
  const target = normalize(shortcode);
  if (query === target) return { tier: 0, score: 0 };
  if (target.startsWith(query)) return { tier: 1, score: 0 };
  const index = target.indexOf(query);
  if (index >= 0) return { tier: 2, score: index };
  const span = subsequenceSpan(query, target);
  return span === undefined ? undefined : { tier: 3, score: span };
}

/** Separator-insensitive exact, prefix, substring, then subsequence matches. */
export function rankShortcodes<T>(
  query: string,
  items: readonly T[],
  shortcode: (item: T) => string,
) {
  const needle = normalize(query);
  if (!needle) return [];
  return items
    .flatMap((item) => {
      const match = shortcodeScore(needle, shortcode(item));
      return match ? [{ item, ...match }] : [];
    })
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        a.score - b.score ||
        shortcode(a.item).length - shortcode(b.item).length ||
        shortcode(a.item).localeCompare(shortcode(b.item)),
    );
}

/** Data only: never initialize or query Emoji Mart's mutable picker singleton. */
function loadStandard() {
  standard ??= import("@emoji-mart/data")
    .then(({ default: raw }) => {
      // The package declares the shape but omits its JSON default export.
      const data = raw as unknown as EmojiMartData;
      const aliases = new Map<string, string[]>();
      for (const [alias, id] of Object.entries(data.aliases)) {
        const values = aliases.get(id) ?? [];
        values.push(alias);
        aliases.set(id, values);
      }
      return Object.values(data.emojis).flatMap((emoji) => {
        const native = emoji.skins[0]?.native;
        return native
          ? [
              {
                id: `unicode/${emoji.id}`,
                shortcode: emoji.id,
                name: emoji.name,
                text: native,
                ...(emoji.skins.length > 1 && {
                  skins: emoji.skins.map((skin) => skin.native),
                }),
                terms: [
                  emoji.id.toLowerCase(),
                  ...emoji.name.toLowerCase().split(/[-_\s]+/),
                  ...emoji.keywords.map((term) => term.toLowerCase()),
                  ...(aliases.get(emoji.id) ?? []).map((term) =>
                    term.toLowerCase(),
                  ),
                ].filter(Boolean),
              },
            ]
          : [];
      });
    })
    .catch((error: unknown) => {
      standard = undefined; // A failed chunk load remains retryable.
      throw error;
    });
  return standard;
}
function semanticScore(query: string, terms: readonly string[]) {
  let best: number | undefined;
  for (const [index, term] of terms.entries()) {
    if (!term.startsWith(query)) continue;
    const score = index * 2 + (term === query ? 0 : 1);
    best = best === undefined ? score : Math.min(best, score);
  }
  return best;
}

/** Production-style semantic search plus unbounded fuzzy shortcode fallbacks. */
export async function searchEmoji(
  query: string,
  custom: readonly CustomEmoji[],
  limit = Number.POSITIVE_INFINITY,
  tone = defaultSkinTone(),
): Promise<readonly EmojiMatch[]> {
  const native = await loadStandard();
  return rankEmoji(query, native, custom, limit, tone);
}
export function searchCustomEmoji(
  query: string,
  custom: readonly CustomEmoji[],
  limit = Number.POSITIVE_INFINITY,
): readonly EmojiMatch[] {
  return rankEmoji(query, [], custom, limit, 1);
}
/** The one match whose shortcode is the typed name; separator-insensitive ranking
 * ties (`:1:` for `-1`) and community/Unicode namesakes are not exact. */
export function exactEmoji(query: string, matches: readonly EmojiMatch[]) {
  const name = query.toLowerCase();
  const exact = matches.filter((item) => item.shortcode.toLowerCase() === name);
  return exact.length === 1 ? exact[0]?.id : undefined;
}
function rankEmoji(
  query: string,
  native: readonly Standard[],
  custom: readonly CustomEmoji[],
  limit: number,
  tone: number,
): readonly EmojiMatch[] {
  if (!normalize(query)) return [];
  const customCandidates: Standard[] = custom.map(({ shortcode, url }) => ({
    id: `custom/${shortcode}`,
    shortcode,
    name: `:${shortcode}:`,
    text: `:${shortcode}:`,
    url,
    terms: [shortcode],
  }));
  const rank = (items: readonly Standard[]) =>
    rankShortcodes(query, items, (item) => item.shortcode);
  const semantic = native
    .flatMap((item) => {
      const score = semanticScore(query.toLowerCase(), item.terms);
      return score === undefined ? [] : [{ item, score }];
    })
    .sort((a, b) => a.score - b.score || a.item.id.localeCompare(b.item.id))
    .map(({ item }) => item);
  const semanticIds = new Set(semantic.map((item) => item.id));
  const combined = [
    ...semantic,
    ...rank(customCandidates).map(({ item }) => item),
    ...rank(native)
      .map(({ item }) => item)
      .filter((item) => !semanticIds.has(item.id)),
  ];
  const strong = rank(combined)
    .filter(({ tier }) => tier <= 1)
    .map(({ item }) => item);
  const promoted = new Set(strong.map((item) => item.id));
  const ranked = [
    ...strong,
    ...combined.filter((item) => !promoted.has(item.id)),
  ];
  const bounded = Number.isFinite(limit)
    ? ranked.slice(0, Math.max(0, limit))
    : ranked;
  // Insert in the picker's saved default tone, like a picker selection.
  return bounded.map(({ terms: _terms, skins, ...item }) => ({
    ...item,
    text: skins?.[tone - 1] ?? item.text,
  }));
}
