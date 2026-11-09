import type { CustomEmoji } from "../relay/emoji";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emojiPresentation =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\d#*]\uFE0F?\u20E3/u;

function renderedEmoji(value: string, entries: readonly CustomEmoji[]): string {
  if (!value.includes(":")) return value;
  const custom = new Set(entries.map((entry) => entry.shortcode.toLowerCase()));
  return value.replace(
    /:([a-z0-9_-]{1,64}):/gi,
    (literal, shortcode: string) =>
      custom.has(shortcode.toLowerCase()) ? "😀" : literal,
  );
}

export function isUnicodeEmojiOnly(value: string) {
  const content = value.trim();
  if (!content || !emojiPresentation.test(content)) return false;
  for (const { segment } of graphemes.segment(content)) {
    if (/^\s+$/u.test(segment)) continue;
    if (!emojiPresentation.test(segment)) return false;
  }
  return true;
}

export const isEmojiOnly = (
  value: string,
  entries: readonly CustomEmoji[] = [],
) => isUnicodeEmojiOnly(renderedEmoji(value, entries));

export function usesLargeEmojiPresentation(
  value: string,
  entries: readonly CustomEmoji[] = [],
) {
  return isEmojiOnly(value, entries);
}
