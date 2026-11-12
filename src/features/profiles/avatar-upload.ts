import { prepareAttachment } from "../messages/prepare-attachment";
import { mediaUrl } from "../relay/transport";
import type { UploadProgress } from "../relay/attachments";
import { nativeIdentityEnabled } from "../identity/service";
import { nativeMediaUrl } from "../relay/native";
import { connectCommunityTransport } from "../communities/connection";
import { communityDestination } from "../communities/destination";
import { avatarSource, legacyEmojiPicture } from "../../shared/avatar-source";

/** Shared save policy; display-only inherited artwork may still fail validation. */
export function avatarPictureError(value: string): string | undefined {
  if (
    !value ||
    (value.length <= 2048 && avatarSource(value)?.startsWith("https://"))
  )
    return undefined;
  return "Use an HTTPS image URL without credentials (up to 2,048 characters), or remove the avatar.";
}

/** A personal profile also saves old Buzz's emoji SVG as-is: Buzz mobile still
 * writes and reads it. Agents save HTTPS pictures only. */
export const profilePictureError = (value: string) =>
  legacyEmojiPicture(value.trim()) ? undefined : avatarPictureError(value);

export function avatarPreview(
  value: string,
  community?: string,
  size?: "small",
): string | undefined {
  const source = avatarSource(value);
  if (!source || !community || source.startsWith("data:")) return source;
  return communityMedia(community)(source, size);
}

/** Relay-hosted media of one community through the host's media adapter. */
export function communityMedia(community: string) {
  const { id, url } = communityDestination(community);
  const proxy = nativeIdentityEnabled()
    ? nativeMediaUrl
    : (target: string) =>
        `/api/relay/${encodeURIComponent(id)}/media?url=${encodeURIComponent(target)}`;
  return (source: string, size?: "small") => mediaUrl(source, proxy, url, size);
}

/** Use the existing host upload/preparation contract, never an agent key in React. */
export async function uploadAvatar(
  file: File,
  community: string,
  signal: AbortSignal,
  progress?: UploadProgress,
): Promise<string> {
  if (!/^image\/(png|jpeg|gif|webp|heic|heif)$/.test(file.type))
    throw new Error("Choose a PNG, JPEG, GIF, WebP or HEIC image.");
  if (!file.size || file.size > 50 * 1024 * 1024)
    throw new Error("Choose an image smaller than 50 MiB.");
  const transport = await connectCommunityTransport(
    communityDestination(community).id,
    signal,
  );
  if (!transport.uploadAttachment)
    throw new Error("Image uploads are unavailable on this connection.");
  const prepared = await prepareAttachment(file, signal, true);
  const result = await transport.uploadAttachment(prepared, signal, progress);
  signal.throwIfAborted();
  if (!result.type.startsWith("image/") || !avatarSource(result.url))
    throw new Error("The server did not return an avatar image.");
  return result.url;
}

/** The emoji's longer side as a share of the image: by default the square
 * inscribed in a circular avatar, so clipping never crops it. */
export const emojiAvatarScale = 0.7;

/** Fit painted pixels: emoji font metrics differ between browser engines. */
export function paintEmojiAvatar(
  canvas: HTMLCanvasElement,
  emoji: string,
  color?: string,
  scale = emojiAvatarScale,
  offset = 0,
) {
  canvas.width = canvas.height = 512;
  const context = canvas.getContext("2d");
  const probe = document.createElement("canvas").getContext("2d", {
    willReadFrequently: true,
  });
  if (!context || !probe)
    throw new Error("Emoji images are unavailable in this browser.");
  // Measure the artwork once, then paint it at the font size that fits, so
  // even a zoomed emoji is drawn at full resolution.
  const paint = (
    target: CanvasRenderingContext2D,
    size: number,
    x: number,
    y: number,
  ) => {
    target.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    target.textAlign = "center";
    target.textBaseline = "middle";
    target.fillStyle = "#000000";
    target.fillText(emoji, x, y);
  };
  probe.canvas.width = probe.canvas.height = 1024;
  paint(probe, 516, 512, 512);
  const pixels = probe.getImageData(0, 0, 1024, 1024);
  let left = 1024;
  let right = -1;
  let top = 1024;
  let bottom = -1;
  for (let y = 0; y < 1024; y++) {
    for (let x = 0; x < 1024; x++) {
      // Ignore the nearly transparent fringe/shadow around Apple emoji artwork.
      if ((pixels.data[(y * 1024 + x) * 4 + 3] ?? 0) < 32) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (color) {
    context.fillStyle = color;
    context.fillRect(0, 0, 512, 512);
  }
  if (right < left) return;
  const fit = (512 * scale) / Math.max(right - left + 1, bottom - top + 1);
  paint(
    context,
    516 * fit,
    256 - ((left + right + 1) / 2 - 512) * fit,
    256 + 512 * offset - ((top + bottom + 1) / 2 - 512) * fit,
  );
}

/** Persist ordinary square artwork; Avatar owns human/agent clipping. */
export async function emojiAvatar(
  emoji: string,
  color: string,
  scale = emojiAvatarScale,
  offset = 0,
): Promise<File> {
  if (!emoji || emoji.length > 64 || !/^#[0-9a-f]{6}$/i.test(color))
    throw new Error("Choose an emoji and a background color.");
  const canvas = document.createElement("canvas");
  paintEmojiAvatar(canvas, emoji, color, scale, offset);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value
          ? resolve(value)
          : reject(new Error("Could not prepare the emoji image.")),
      "image/png",
    ),
  );
  return new File([blob], "avatar.png", { type: "image/png" });
}
