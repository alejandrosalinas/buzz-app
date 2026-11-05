import { relayDebug } from "./debug";
export function saveData(): boolean {
  try {
    const connection = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    return connection?.saveData === true;
  } catch {
    return false;
  }
}

/** Display URLs covered by a recent prepare intent, for warm/cold attribution.
 * Survives session recreation; entries expire. */
const INTENT_TTL_MS = 5 * 60_000;
const intended = new Map<string, number>();
function markIntended(url: string) {
  intended.set(url, Date.now());
  if (intended.size > 512) {
    const oldest = [...intended.keys()][0];
    if (oldest) intended.delete(oldest);
  }
}
export function wasIntended(url: string): boolean {
  const at = intended.get(url);
  if (at === undefined) return false;
  if (Date.now() - at > INTENT_TTL_MS) {
    intended.delete(url);
    return false;
  }
  return true;
}
/** Opening frames captured by video previews, so a remounted virtualized row
 * reuses its poster instead of seeking and re-encoding. Bounded by encoded
 * size; disposing session media (cache clear, access purge, teardown) forgets
 * them and refuses captures that began before. */
export type OpeningFrame = Readonly<{
  poster: string;
  width: number;
  height: number;
}>;
const OPENING_FRAME_BUDGET = 4 * 1024 * 1024;
const openingFrames = new Map<string, OpeningFrame>();
let openingFrameBytes = 0;
let openingFrameScope = 0;
export function openingFrame(source: string): OpeningFrame | undefined {
  const frame = openingFrames.get(source);
  if (!frame) return undefined;
  // Least recently used is evicted first: a reused frame is never recaptured.
  openingFrames.delete(source);
  openingFrames.set(source, frame);
  return frame;
}
export function openingFrameCapture(): number {
  return openingFrameScope;
}
function forgetOpeningFrame(source: string) {
  const frame = openingFrames.get(source);
  if (!frame) return;
  openingFrames.delete(source);
  openingFrameBytes -= frame.poster.length;
}
export function rememberOpeningFrame(
  source: string,
  frame: OpeningFrame,
  capture: number,
) {
  if (
    capture !== openingFrameScope ||
    frame.poster.length > OPENING_FRAME_BUDGET / 16
  )
    return;
  forgetOpeningFrame(source);
  openingFrames.set(source, frame);
  openingFrameBytes += frame.poster.length;
  for (const oldest of openingFrames.keys()) {
    if (openingFrameBytes <= OPENING_FRAME_BUDGET) break;
    forgetOpeningFrame(oldest);
  }
}

/** Decoded attachment originals detached by virtualized rows, so a remount
 * re-adopts the painted element. A new element would hide until it decodes,
 * and WebKit refetches custom-scheme images for every element. Only the
 * retaining owner (session) can claim one. Bounded by decoded size; disposing
 * session media forgets them and refuses retention that began before. */
const DECODED_IMAGE_BUDGET = 512 * 1024 * 1024;
// 16 MP; a larger original would push out many smaller ones.
const DECODED_IMAGE_LIMIT = 64 * 1024 * 1024;
const decodedImages = new Map<
  string,
  { owner: WeakRef<object>; image: HTMLImageElement; bytes: number }
>();
let decodedImageBytes = 0;
let decodedImageScope = 0;
export function decodedImageCapture(): number {
  return decodedImageScope;
}
export function hasDecodedImage(owner: object, source: string): boolean {
  return decodedImages.get(source)?.owner.deref() === owner;
}
/** Claims the retained element; a concurrent mount of the source gets none. */
export function takeDecodedImage(
  owner: object,
  source: string,
): HTMLImageElement | undefined {
  if (!hasDecodedImage(owner, source)) return undefined;
  return forgetDecodedImage(source);
}
function forgetDecodedImage(source: string) {
  const entry = decodedImages.get(source);
  if (!entry) return undefined;
  decodedImages.delete(source);
  decodedImageBytes -= entry.bytes;
  return entry.image;
}
export function retainDecodedImage(
  owner: object,
  source: string,
  image: HTMLImageElement,
  capture: number,
) {
  const bytes = image.naturalWidth * image.naturalHeight * 4;
  if (capture !== decodedImageScope || !bytes || bytes > DECODED_IMAGE_LIMIT)
    return;
  forgetDecodedImage(source);
  decodedImages.set(source, { owner: new WeakRef(owner), image, bytes });
  decodedImageBytes += bytes;
  for (const oldest of decodedImages.keys()) {
    if (decodedImageBytes <= DECODED_IMAGE_BUDGET) break;
    forgetDecodedImage(oldest);
  }
}

/** Avatar request warming, the react-native-web Image model: fetch and
 * decode() into detached images, then retain nothing. The browser's own HTTP
 * and decoded-image caches serve the real <img> mounts. Never warms
 * originals/attachments that this renderer doesn't display. */
export function createMediaPreparation() {
  const pending = new Set<string>();
  let queue: string[] = [];
  let disposed = false;
  const active = new Set<HTMLImageElement>();
  const cancellations = new Map<HTMLImageElement, () => void>();
  const startedAt = new Map<string, number>();
  // Settled loads are not repeated within the intent TTL: every prepare
  // otherwise reloaded and re-decoded the same cached avatars (and 404s).
  const settled = new Map<string, number>();
  const isSettled = (url: string) => {
    const at = settled.get(url);
    return at !== undefined && Date.now() - at < INTENT_TTL_MS;
  };
  let decoded = 0;
  let prefetched = 0;
  function pump() {
    if (disposed || typeof Image === "undefined") return;
    while (active.size < 2 && queue.length) {
      const url = queue.shift();
      if (url === undefined) break;
      const image = new Image();
      active.add(image);
      let finished = false;
      const finish = (outcome: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        image.onload = image.onerror = null;
        active.delete(image);
        cancellations.delete(image);
        pending.delete(url);
        if (outcome !== "timeout" && outcome !== "cancelled") {
          settled.delete(url);
          settled.set(url, Date.now());
          const oldest = settled.size > 4096 && settled.keys().next().value;
          if (oldest) settled.delete(oldest);
        }
        relayDebug(
          "avatar",
          outcome,
          `${Date.now() - (startedAt.get(url) ?? Date.now())}ms`,
        );
        startedAt.delete(url);
        pump();
      };
      const timeout = setTimeout(() => {
        image.src = "";
        finish("timeout");
      }, 10000);
      cancellations.set(image, () => finish("cancelled"));
      image.onerror = () => finish("error");
      image.onload = () => {
        // Do not explicitly decode enormous originals just to prepare an avatar.
        if (image.naturalWidth * image.naturalHeight * 4 > 8 * 1024 * 1024) {
          finish(`too-large ${image.naturalWidth}x${image.naturalHeight}`);
          return;
        }
        void image
          .decode()
          .then(
            () => {
              decoded++;
            },
            () => {},
          )
          .finally(() =>
            finish(`ok ${image.naturalWidth}x${image.naturalHeight}`),
          );
      };
      image.referrerPolicy = "no-referrer";
      startedAt.set(url, Date.now());
      image.src = url;
    }
  }
  return {
    prepare(urls: readonly string[]) {
      if (disposed || saveData() || typeof Image === "undefined") return;
      // New intent replaces queued speculation; active requests remain capped at two.
      for (const url of queue) pending.delete(url);
      queue = [];
      for (const url of [...new Set(urls)].slice(0, 24)) {
        markIntended(url);
        if (pending.has(url) || isSettled(url)) continue;
        pending.add(url);
        queue.push(url);
      }
      pump();
    },
    /** Prefetch-path warming: appends speculation instead of replacing it, so
     * serial background channel reads accumulate avatars across channels. */
    warm(urls: readonly string[]) {
      if (disposed || saveData() || typeof Image === "undefined") return;
      for (const url of [...new Set(urls)]) {
        markIntended(url);
        if (pending.has(url) || isSettled(url) || queue.includes(url)) continue;
        if (queue.length >= 48) break;
        pending.add(url);
        queue.push(url);
        prefetched++;
      }
      pump();
    },
    stats: () => ({
      active: active.size,
      queued: queue.length,
      prefetched,
      decoded,
    }),
    dispose() {
      disposed = true;
      // Frames and decoded images are module-wide, so disposing any session's
      // media (including a handed-off or stale successor) forgets them all.
      // That only costs reuse.
      openingFrames.clear();
      openingFrameBytes = 0;
      openingFrameScope++;
      decodedImages.clear();
      decodedImageBytes = 0;
      decodedImageScope++;
      queue = [];
      for (const image of active) {
        image.src = "";
        cancellations.get(image)?.();
      }
      pending.clear();
    },
  };
}
