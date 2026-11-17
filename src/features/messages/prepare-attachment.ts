import { encodeWebp } from "./encode-webp";
import { cleanEncodedJpeg } from "./jpeg-metadata";
import { UploadError } from "../relay/attachments";
import {
  imageType,
  mediaByteLimit,
  UPLOAD_MAX_BYTES,
} from "../relay/attachment-limits";
import {
  cleanWebp,
  cleanGif,
  cleanPng,
  pngChunks,
  pngNeedsPixelTransform,
  snapshotChunk,
  webpChunks,
  webpNeedsPixelTransform,
} from "./image-metadata";

const animatedPng = (chunks: ReturnType<typeof pngChunks>) =>
  chunks.some((c) => c.kind === "acTL");
const animatedWebp = (chunks: ReturnType<typeof webpChunks>) =>
  chunks.some((c) => ["ANIM", "ANMF"].includes(c.kind));

/** Whether painting the image would keep only its first frame. */
export async function animatedImage(file: Blob): Promise<boolean> {
  const type = imageType(new Uint8Array(await file.slice(0, 32).arrayBuffer()));
  if (type === "image/gif") return true;
  if (type !== "image/png" && type !== "image/webp") return false;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return type === "image/png"
    ? animatedPng(pngChunks(bytes))
    : animatedWebp(webpChunks(bytes));
}

/** Prepare pixels before the byte-exact upload contract; the relay still validates. */
export async function prepareAttachment(
  file: File,
  signal: AbortSignal,
  stripSnapshotMetadata = false,
): Promise<File> {
  if (!file.size || file.size > UPLOAD_MAX_BYTES) throw new UploadError("size");
  signal.throwIfAborted();
  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const type = imageType(header);
  if (!type) return file; // Never buffer large video/documents for image detection.
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  let output: Blob | undefined;
  let snapshot: Uint8Array | undefined;
  if (type === "image/gif") output = cleanGif(bytes);
  if (type === "image/png") {
    const chunks = pngChunks(bytes);
    snapshot = stripSnapshotMetadata ? undefined : snapshotChunk(chunks);
    const animated = animatedPng(chunks);
    if (animated || (stripSnapshotMetadata && !pngNeedsPixelTransform(chunks)))
      output = cleanPng(bytes, snapshot, animated);
  }
  if (type === "image/webp") {
    const chunks = webpChunks(bytes);
    const animated = animatedWebp(chunks);
    if (animated || !webpNeedsPixelTransform(chunks))
      output = cleanWebp(bytes, animated);
  }
  if (!output) {
    const image = await createImageBitmap(new Blob([bytes], { type }), {
      imageOrientation: "from-image",
    });
    try {
      signal.throwIfAborted();
      if (
        !image.width ||
        !image.height ||
        image.width * image.height > 25_000_000
      )
        throw new Error("Choose an image with at most 25 million pixels.");
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      try {
        const context = canvas.getContext("2d");
        if (!context)
          throw new Error("Image preparation is unavailable in this browser.");
        context.drawImage(image, 0, 0);
        // Old Buzz writes lossless WebP; WebKit has no canvas WebP encoder.
        const target = type;
        const blob =
          type === "image/webp"
            ? await encodeWebp(
                context.getImageData(0, 0, image.width, image.height),
                signal,
              )
            : await new Promise<Blob>((resolve, reject) =>
                canvas.toBlob(
                  (value) =>
                    value
                      ? resolve(value)
                      : reject(new Error("Image preparation failed.")),
                  target,
                  0.95,
                ),
              );
        signal.throwIfAborted();
        if (blob.type === "image/png")
          output = cleanPng(new Uint8Array(await blob.arrayBuffer()), snapshot);
        else if (blob.type === "image/webp")
          output = cleanWebp(new Uint8Array(await blob.arrayBuffer()), false);
        else if (blob.type === "image/jpeg")
          output = cleanEncodedJpeg(new Uint8Array(await blob.arrayBuffer()));
        else if (blob.type === target) output = blob;
        else throw new Error("This browser cannot prepare this image format.");
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    } finally {
      image.close();
    }
  }
  signal.throwIfAborted();
  if (!output.size || output.size > mediaByteLimit(output.type))
    throw new UploadError("size");
  const name =
    type === "image/webp" && output.type === "image/png"
      ? `${file.name.replace(/\.[^.]+$/, "")}.png`
      : file.name;
  return new File([output], name, {
    type: output.type,
    lastModified: file.lastModified,
  });
}
