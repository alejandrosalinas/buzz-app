import { legacyEmojiPicture } from "../../shared/avatar-source";
import { emojiAvatar } from "../profiles/avatar-upload";

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
