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

/** Fit painted pixels: emoji font metrics differ between browser engines.
 * `offset` and `x` move the emoji down and right, in image widths. */
export function paintEmojiAvatar(
  canvas: HTMLCanvasElement,
  emoji: string,
  color?: string,
  scale = emojiAvatarScale,
  offset = 0,
  x = 0,
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
    256 + 512 * x - ((left + right + 1) / 2 - 512) * fit,
    256 + 512 * offset - ((top + bottom + 1) / 2 - 512) * fit,
  );
}

/** Persist ordinary square artwork; Avatar owns human/agent clipping. A
 * `transparent` color leaves the background clear. */
export async function emojiAvatar(
  emoji: string,
  color: string,
  scale = emojiAvatarScale,
  offset = 0,
  x = 0,
): Promise<File> {
  if (
    !emoji ||
    emoji.length > 64 ||
    (color !== "transparent" && !/^#[0-9a-f]{6}$/i.test(color))
  )
    throw new Error("Choose an emoji and a background color.");
  const canvas = document.createElement("canvas");
  paintEmojiAvatar(canvas, emoji, color, scale, offset, x);
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

/** Pan and zoom over a square frame. `x` and `y` move the image center, in
 * frame widths; `zoom` 1 covers the frame, as an uncropped avatar does. */
export type AvatarCrop = { zoom: number; x: number; y: number };

export const uncropped: AvatarCrop = { zoom: 1, x: 0, y: 0 };

/** The image's box in frame widths, keeping the frame covered. `aspect` is
 * the image's width over its height. */
export function avatarCropBox(aspect: number, { zoom, x, y }: AvatarCrop) {
  const width = zoom * Math.max(1, aspect);
  const height = zoom * Math.max(1, 1 / aspect);
  const clamp = (value: number, size: number) =>
    Math.min((size - 1) / 2, Math.max((1 - size) / 2, value));
  const crop = { zoom, x: clamp(x, width), y: clamp(y, height) };
  return {
    crop,
    width,
    height,
    left: (1 - width) / 2 + crop.x,
    top: (1 - height) / 2 + crop.y,
  };
}

/** Paint the framed part of an image as square PNG artwork. */
export async function croppedAvatar(
  image: HTMLImageElement,
  crop: AvatarCrop,
): Promise<File> {
  const { width, height, left, top } = avatarCropBox(
    image.naturalWidth / image.naturalHeight,
    crop,
  );
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("Image cropping is unavailable in this browser.");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, left * 512, top * 512, width * 512, height * 512);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error("Could not crop the image.")),
      "image/png",
    ),
  );
  return new File([blob], "avatar.png", { type: "image/png" });
}
