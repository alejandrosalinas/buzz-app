import { afterEach, expect, it, vi } from "vitest";
import { getLogger, logLevel, setLogLevel } from "../developer/logging";
import {
  createMediaPreparation,
  decodedImageCapture,
  hasDecodedImage,
  openingFrame,
  openingFrameCapture,
  rememberOpeningFrame,
  retainDecodedImage,
  saveData,
  takeDecodedImage,
} from "./media";

afterEach(() => {
  vi.unstubAllGlobals();
});

class FakeImage {
  static created: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 100;
  naturalHeight = 100;
  src = "";
  referrerPolicy = "";
  decode = vi.fn(async () => {});
  constructor() {
    FakeImage.created.push(this);
  }
}

function stubImages() {
  FakeImage.created = [];
  vi.stubGlobal("Image", FakeImage);
  return FakeImage.created;
}

const flushDecode = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

it.each([
  [100, true],
  [21000, false],
])("a %ipx-wide original is explicitly decoded: %s", async (width, decoded) => {
  const created = stubImages();
  createMediaPreparation().prepare(["a"]);
  const image = created[0];
  if (!image?.onload) throw new Error("image not requested");
  image.naturalWidth = width;
  image.onload();
  await flushDecode();
  // Oversized originals are not decoded just to prepare an avatar.
  expect(image.decode).toHaveBeenCalledTimes(decoded ? 1 : 0);
});

it("settled avatars are not reloaded until the intent TTL passes", async () => {
  vi.useFakeTimers();
  try {
    const created = stubImages();
    const media = createMediaPreparation();
    media.prepare(["a", "b"]);
    created[0]?.onload?.();
    created[1]?.onerror?.();
    await flushDecode();
    // A loaded avatar and a failed one both settle; repeated intent skips them.
    media.prepare(["a", "b"]);
    media.warm(["a", "b"]);
    expect(created).toHaveLength(2);
    vi.advanceTimersByTime(5 * 60_000);
    media.prepare(["a", "b"]);
    expect(created).toHaveLength(4);
  } finally {
    vi.useRealTimers();
  }
});

it("Save-Data disables warming but nothing else", () => {
  stubImages();
  vi.stubGlobal("navigator", { connection: { saveData: true } });
  expect(saveData()).toBe(true);
  const media = createMediaPreparation();
  media.prepare(["a", "b"]);
  media.warm(["c"]);
  expect(media.stats()).toEqual({
    active: 0,
    queued: 0,
    prefetched: 0,
    decoded: 0,
  });
  expect(FakeImage.created).toHaveLength(0);

  vi.stubGlobal("navigator", { connection: { saveData: false } });
  media.prepare(["a"]);
  expect(FakeImage.created).toHaveLength(1);

  vi.stubGlobal("navigator", {});
  expect(saveData()).toBe(false);
});

it("avatar completion diagnostics never expose signed URL credentials", async () => {
  const created = stubImages();
  const logger = getLogger("relay");
  const reporters = [...logger.options.reporters];
  const previous = logLevel();
  const lines: string[] = [];
  logger.setReporters([{ log: (entry) => lines.push(entry.args.join(" ")) }]);
  const media = createMediaPreparation();
  try {
    setLogLevel("debug");
    media.prepare(["https://media.test/avatar?token=AVATAR_SECRET_306"]);
    created[0]?.onload?.();
    await flushDecode();
    expect(lines.join(" ")).toContain("avatar ok 100x100");
    expect(lines.join(" ")).not.toContain("AVATAR_SECRET_306");
    expect(lines.join(" ")).not.toContain("media.test");
  } finally {
    media.dispose();
    logger.setReporters(reporters);
    setLogLevel(previous);
  }
});

it("bounds opening frames by encoded size and forgets them with session media", () => {
  const frame = (bytes: number) => ({
    poster: `data:image/jpeg;${"x".repeat(bytes)}`,
    width: 640,
    height: 360,
  });
  createMediaPreparation().dispose();
  const capture = openingFrameCapture();
  rememberOpeningFrame("oversized", frame(300 * 1024), capture);
  expect(openingFrame("oversized")).toBeUndefined();
  for (let i = 0; i < 20; i++)
    rememberOpeningFrame(`frame-${i}`, frame(250 * 1024), capture);
  expect(openingFrame("frame-0")).toBeUndefined();
  expect(openingFrame("frame-3")).toBeUndefined();
  expect(openingFrame("frame-4")).toBeDefined();
  expect(openingFrame("frame-19")).toBeDefined();
  expect(openingFrame("frame-4")).toBeDefined();
  rememberOpeningFrame("frame-20", frame(250 * 1024), capture);
  expect(openingFrame("frame-4")).toBeDefined();
  expect(openingFrame("frame-5")).toBeUndefined();

  createMediaPreparation().dispose();
  expect(openingFrame("frame-19")).toBeUndefined();
  rememberOpeningFrame("late", frame(10), capture);
  expect(openingFrame("late")).toBeUndefined();
  rememberOpeningFrame("current", frame(10), openingFrameCapture());
  expect(openingFrame("current")).toBeDefined();
});

it("bounds decoded images by size and owner and forgets them with session media", () => {
  // 64 MiB decoded each, the largest retained; the 512 MiB budget holds eight.
  const image = (side = 4096) =>
    ({ naturalWidth: side, naturalHeight: side }) as HTMLImageElement;
  const owner = {};
  createMediaPreparation().dispose();
  const capture = decodedImageCapture();
  retainDecodedImage(owner, "oversized", image(4097), capture);
  retainDecodedImage(owner, "empty", image(0), capture);
  expect(hasDecodedImage(owner, "oversized")).toBe(false);
  expect(hasDecodedImage(owner, "empty")).toBe(false);
  const images = Array.from({ length: 10 }, () => image());
  for (const [i, item] of images.entries())
    retainDecodedImage(owner, `image-${i}`, item, capture);
  expect(hasDecodedImage(owner, "image-1")).toBe(false);
  expect(hasDecodedImage(owner, "image-2")).toBe(true);
  expect(takeDecodedImage({}, "image-9")).toBeUndefined();
  const claimed = takeDecodedImage(owner, "image-9");
  expect(claimed).toBe(images[9]);
  expect(takeDecodedImage(owner, "image-9")).toBeUndefined();
  // Claiming frees its budget; re-retaining makes the source newest.
  if (claimed) retainDecodedImage(owner, "image-9", claimed, capture);
  retainDecodedImage(owner, "image-10", image(), capture);
  expect(hasDecodedImage(owner, "image-2")).toBe(false);
  expect(hasDecodedImage(owner, "image-3")).toBe(true);
  expect(hasDecodedImage(owner, "image-9")).toBe(true);

  createMediaPreparation().dispose();
  expect(hasDecodedImage(owner, "image-9")).toBe(false);
  retainDecodedImage(owner, "late", image(), capture);
  expect(hasDecodedImage(owner, "late")).toBe(false);
  retainDecodedImage(owner, "current", image(), decodedImageCapture());
  expect(hasDecodedImage(owner, "current")).toBe(true);
});
