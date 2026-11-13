import type { EventData } from "./events.ts";

export type CustomEmoji = Readonly<{ shortcode: string; url: string }>;
export const EMOJI_SET = "buzz:custom-emoji";
export const EMOJI_SET_KIND = 30030;
export const CUSTOM_REACTION = /^:([a-z0-9_-]{1,64}):$/i;
/** Reaction text stays small, while a valid custom token gets its two delimiters. */
export function validReactionContent(value: string): boolean {
  return [...value].length <= 64 || CUSTOM_REACTION.test(value);
}
/** A `:shortcode:` token, which a reaction slot must never show as text. */
export const isReactionShortcode = (value: string) =>
  CUSTOM_REACTION.test(value);
export function normalizeShortcode(value: string): string | undefined {
  const code = value
    .trim()
    .replace(/^:+|:+$/g, "")
    .toLowerCase();
  return /^[a-z0-9_-]{1,64}$/.test(code) ? code : undefined;
}
/** Desktop's file-first naming: drop the extension and collapse invalid runs to `_`. */
export function suggestShortcode(filename: string): string | undefined {
  return normalizeShortcode(
    filename
      .trim()
      .replace(/^.*[/\\]/, "")
      .replace(/\.[^.]*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[_-]+|[_-]+$/g, ""),
  );
}
/** Broker admission for a member's own set: one coordinate, canonical unique entries. */
export function validEmojiSetTemplate(
  event: unknown,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const e = event as Partial<EventData> | null;
  if (
    e?.kind !== EMOJI_SET_KIND ||
    e.content !== "" ||
    !Number.isSafeInteger(e.created_at) ||
    (e.created_at ?? -1) < 0 ||
    (e.created_at ?? 0) > now + 300 ||
    !Array.isArray(e.tags) ||
    e.tags[0]?.length !== 2 ||
    e.tags[0][0] !== "d" ||
    e.tags[0][1] !== EMOJI_SET
  )
    return false;
  const codes = new Set<string>();
  for (const tag of e.tags.slice(1)) {
    if (!Array.isArray(tag) || tag.length !== 3) return false;
    const [name, code, url] = tag;
    if (
      name !== "emoji" ||
      typeof code !== "string" ||
      normalizeShortcode(code) !== code ||
      codes.has(code) ||
      typeof url !== "string" ||
      !url ||
      url !== url.trim() ||
      url.length > 2048
    )
      return false;
    codes.add(code);
  }
  return true;
}
/** Original URLs belong in events; display URLs are resolved by session.media. */
export function emojiTags(event: {
  readonly tags: readonly (readonly string[])[];
}): readonly CustomEmoji[] {
  const entries = new Map<string, CustomEmoji>();
  for (const [name, value, url] of event.tags) {
    if (name !== "emoji" || !value || !url?.trim()) continue;
    const shortcode = normalizeShortcode(value);
    if (shortcode && !entries.has(shortcode))
      entries.set(shortcode, Object.freeze({ shortcode, url: url.trim() }));
  }
  return Object.freeze([...entries.values()]);
}
/** Share token boundaries with the renderer: never substitute inside HTTP(S) links. */
export const messageParts = (content: string) =>
  content.split(/(https?:\/\/[^\s<>"`]+)/g);
export const linkPart = (part: string) => /^https?:\/\//.test(part);
const shortcodePattern = () => /(?=(:([a-zA-Z0-9_-]{1,64}):))/g;
export function* emojiMatches(
  content: string,
  entries: readonly CustomEmoji[],
) {
  let end = 0;
  for (const match of content.matchAll(shortcodePattern())) {
    if (match.index < end) continue;
    const emoji = entries.find(
      (entry) => entry.shortcode === match[2]?.toLowerCase(),
    );
    if (!emoji) continue;
    end = match.index + (match[1]?.length ?? 0);
    yield { emoji, start: match.index, end };
  }
}
/** The community palette from each member's latest set: the newest entry per
 * shortcode, with the lower URL breaking a tie. */
export function communityEmoji(
  sets: Iterable<{
    readonly tags: readonly (readonly string[])[];
    readonly created_at: number;
  }>,
): CustomEmoji[] {
  const winners = new Map<string, { emoji: CustomEmoji; time: number }>();
  for (const event of sets)
    for (const emoji of emojiTags(event)) {
      const old = winners.get(emoji.shortcode);
      if (
        !old ||
        event.created_at > old.time ||
        (event.created_at === old.time && emoji.url < old.emoji.url)
      )
        winners.set(emoji.shortcode, { emoji, time: event.created_at });
    }
  return [...winners.values()]
    .map(({ emoji }) => emoji)
    .sort((a, b) => a.shortcode.localeCompare(b.shortcode));
}
/** NIP-30 tags for the palette shortcodes `content` uses outside links. */
export function contentEmojiTags(
  content: string,
  entries: readonly CustomEmoji[],
): string[][] {
  const used = new Map<string, string>();
  for (const part of messageParts(content)) {
    if (linkPart(part)) continue;
    for (const { emoji } of emojiMatches(part, entries))
      used.set(emoji.shortcode, emoji.url);
  }
  return [...used].map(([code, url]) => ["emoji", code, url]);
}
export function referencedEmoji(content: string): string[] {
  return [
    ...new Set(
      messageParts(content).flatMap((part) =>
        linkPart(part)
          ? []
          : [...part.matchAll(shortcodePattern())].map((m) =>
              (m[2] ?? "").toLowerCase(),
            ),
      ),
    ),
  ];
}
