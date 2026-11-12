/** Display-only avatars. No file URLs, arbitrary SVG, executable schemes or
 * credentials; old Buzz's emoji SVG renders only as rebuilt from its parts. */
export function avatarSource(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const source = value.trim();
  if (
    /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/]+=*$/.test(source)
  )
    return source.length <= 512 * 1024 ? source : undefined;
  const legacy = legacyEmojiPicture(source);
  if (legacy) return emojiSvg(legacy.emoji, legacy.color);
  if (source.length > 2048) return undefined;
  try {
    const url = new URL(source);
    if (url.protocol === "https:" && !url.username && !url.password)
      return url.href;
  } catch {
    /* Missing/invalid optional artwork falls back to initials. */
  }
  return undefined;
}

const emojiSvgPrefix = "data:image/svg+xml,";
const emojiSvgHead = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="256" fill="${color}"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">`;
const emojiSvgTail = "</text></svg>";

/** Old Buzz's emoji avatar, still written by Buzz mobile, as its emoji and
 * background. Matches only that exact template, never arbitrary SVG. */
export function legacyEmojiPicture(picture: string) {
  if (!picture.startsWith(emojiSvgPrefix) || picture.length > 16_384) return;
  let svg: string;
  try {
    svg = decodeURIComponent(picture.slice(emojiSvgPrefix.length));
  } catch {
    return;
  }
  const color = /fill="(#[0-9a-fA-F]{6})"/.exec(svg)?.[1];
  if (!color) return;
  const head = emojiSvgHead(color);
  if (!svg.startsWith(head) || !svg.endsWith(emojiSvgTail)) return;
  const text = svg.slice(head.length, -emojiSvgTail.length);
  if (!/^(?:[^<>&]|&amp;|&lt;|&gt;){1,384}$/.test(text)) return;
  // A lone surrogate cannot be encoded again, so it is not this template.
  if (/\p{Cs}/u.test(text)) return;
  const emoji = text
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
  if (emoji.length > 64) return;
  return { emoji, color };
}

/** Re-encode the parsed parts so only the template above ever renders. */
function emojiSvg(emoji: string, color: string) {
  const text = emoji
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `${emojiSvgPrefix}${encodeURIComponent(`${emojiSvgHead(color)}${text}${emojiSvgTail}`)}`;
}

/** Displayable small avatar: inline data as-is, remote art through the
 * session's authenticated media path (never the raw URL). */
export function avatarMedia(
  value: unknown,
  media: ((url: string, size: "small") => string | undefined) | undefined,
) {
  const source = avatarSource(value);
  return source?.startsWith("data:")
    ? source
    : source && media?.(source, "small");
}
