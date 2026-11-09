import { emojiAvatar } from "../profiles/avatar-upload";

/** Recognize the old editor's generated artwork, never render arbitrary SVG. */
export function legacyEmojiPicture(picture: string) {
  const prefix = "data:image/svg+xml,";
  if (!picture.startsWith(prefix) || picture.length > 16_384) return;
  let svg: string;
  try {
    svg = decodeURIComponent(picture.slice(prefix.length));
  } catch {
    return;
  }
  const match =
    /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="256" fill="(#[0-9a-fA-F]{6})"\/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">((?:[^<>&]|&amp;|&lt;|&gt;){1,384})<\/text><\/svg>$/.exec(
      svg,
    );
  if (!match?.[1] || !match[2]) return;
  const color = match[1];
  const emoji = match[2]
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
  if (emoji.length > 64) return;
  return { emoji, color };
}

/** Convert before native takes custody; its upload still owns persistence. */
export async function importedEmojiPicture(picture: string | undefined) {
  if (!picture) return;
  const legacy = legacyEmojiPicture(picture);
  if (!legacy) return;
  const file = await emojiAvatar(legacy.emoji, legacy.color);
  let binary = "";
  for (const byte of new Uint8Array(await file.arrayBuffer()))
    binary += String.fromCharCode(byte);
  return { source: picture, png: `data:image/png;base64,${btoa(binary)}` };
}
