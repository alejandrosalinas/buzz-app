// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createMediaPreparation } from "../relay/media";
import type { RelaySession } from "../relay/session";
import { AttachmentImage } from "./AttachmentImage";
import { imageDimensions, rememberImageDimensions } from "./image-dimensions";

const source = "https://image.test/one.png";
const dimensions = { width: 1200, height: 100 };
// Only identity is consumed by the geometry cache, not session capabilities.
const session = () => ({}) as RelaySession;

afterEach(() => {
  cleanup();
  // Decoded originals are retained module-wide until session media disposal.
  createMediaPreparation().dispose();
  vi.restoreAllMocks();
});

function mount(
  owner: RelaySession,
  url = source,
  metadata?: typeof dimensions,
  thumbnail?: string,
) {
  return render(
    <AttachmentImage
      session={owner}
      attachment={{
        url,
        kind: "image",
        ...(metadata ? { dimensions: metadata } : {}),
      }}
      source={url}
      thumbnail={thumbnail}
    />,
  );
}

function decode(view: ReturnType<typeof render>) {
  const image = view.container.querySelector("img");
  if (!image) throw new Error("Missing attachment image");
  Object.defineProperties(image, {
    naturalWidth: { value: dimensions.width },
    naturalHeight: { value: dimensions.height },
  });
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const gate = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  Object.defineProperty(image, "decode", { value: vi.fn(() => gate) });
  fireEvent.load(image);
  expect(image.decode).toHaveBeenCalledOnce();
  return {
    release: () => act(async () => resolve()),
    fail: () => act(async () => reject(new Error("decode failed"))),
    // The component awaited the gate first, so its continuation has run but
    // React has not committed the resulting update.
    resolveUncommitted: async () => {
      resolve();
      await gate;
    },
  };
}

it("keeps compact geometry through decoding and unavailable sources", async () => {
  const attachment = { url: source, kind: "image" as const, dimensions };
  const view = render(
    <AttachmentImage attachment={attachment} source={source} compact />,
  );
  const square = { width: "100%", height: "0px", paddingBottom: "100%" };
  expect(view.getByRole("link")).toHaveStyle(square);
  await decode(view).release();
  expect(view.getByRole("link")).toHaveStyle(square);
  view.rerender(
    <AttachmentImage attachment={attachment} source={undefined} compact />,
  );
  expect(view.getByRole("status")).toHaveTextContent("Image unavailable");
  expect(view.getByRole("status")).toHaveStyle(square);
});

for (const metadata of [undefined, { width: 700, height: 900 }]) {
  it(`retains learned geometry across media disposal with ${metadata ? "wrong" : "missing"} metadata, but still decodes pixels`, async () => {
    const owner = session();
    const first = mount(owner, source, metadata);
    const pending = decode(first);
    expect(first.getByRole("link")).not.toHaveAttribute("data-image-ready");
    await pending.release();
    expect(first.getByRole("link")).toHaveStyle({
      width: "360px",
      aspectRatio: "360 / 30",
    });
    first.unmount();
    createMediaPreparation().dispose();
    const next = mount(owner, source, metadata);
    expect(next.getByRole("link")).toHaveStyle({
      width: "360px",
      aspectRatio: "360 / 30",
    });
    expect(next.getByRole("link")).not.toHaveAttribute("data-image-ready");
    expect(next.container.querySelector("img")).toHaveStyle({
      visibility: "hidden",
    });
    const retry = decode(next);
    await retry.fail();
    expect(next.getByRole("link")).toHaveStyle({ aspectRatio: "360 / 30" });
    expect(next.getByRole("link")).not.toHaveAttribute("data-image-ready");
  });
}

it("re-adopts a decoded original across remount without decoding again", async () => {
  const owner = session();
  const first = mount(owner);
  await decode(first).release();
  const original = first.container.querySelector("img");
  first.unmount();
  const next = mount(owner);
  const adopted = next.container.querySelector("img");
  expect(adopted).toBe(original);
  expect(adopted).toHaveStyle({ visibility: "visible" });
  expect(adopted?.decode).toHaveBeenCalledOnce();
  expect(next.getByRole("link")).toHaveAttribute("data-image-ready");
  expect(next.getByRole("link")).toHaveStyle({ aspectRatio: "360 / 30" });
  expect(next.container.querySelector("canvas")).toBeNull();
  // One element has one owner: a concurrent mount loads its own original.
  const concurrent = mount(owner);
  const own = concurrent.container.querySelector("img");
  expect(own).not.toBe(original);
  expect(own).toHaveStyle({ visibility: "hidden" });
  next.unmount();
  concurrent.unmount();
  const other = mount(session());
  expect(other.container.querySelector("img")).not.toBe(original);
  expect(other.container.querySelector("img")).toHaveStyle({
    visibility: "hidden",
  });
});

it("shows a re-adopted original whose row unmounted before ready committed", async () => {
  const owner = session();
  const first = mount(owner);
  await decode(first).resolveUncommitted();
  const original = first.container.querySelector("img");
  expect(original).toHaveStyle({ visibility: "hidden" });
  first.unmount();
  const next = mount(owner);
  expect(next.container.querySelector("img")).toBe(original);
  expect(original).toHaveStyle({ visibility: "visible" });
});

it("retains neither undecoded originals nor those decoded before media disposal", async () => {
  const owner = session();
  const pending = mount(owner);
  decode(pending);
  const undecoded = pending.container.querySelector("img");
  pending.unmount();
  const next = mount(owner);
  expect(next.container.querySelector("img")).not.toBe(undecoded);
  await decode(next).release();
  const stale = next.container.querySelector("img");
  createMediaPreparation().dispose();
  next.unmount();
  const later = mount(owner);
  expect(later.container.querySelector("img")).not.toBe(stale);
  expect(later.container.querySelector("img")).toHaveStyle({
    visibility: "hidden",
  });
});

it("isolates geometry by session and exact source; absent sources cannot borrow it", async () => {
  const owner = session();
  const first = mount(owner);
  await decode(first).release();
  first.unmount();
  for (const [nextOwner, url] of [
    [session(), source],
    [owner, `${source}?v=2`],
  ] as const) {
    const next = mount(nextOwner, url);
    expect(next.getByRole("link").style.aspectRatio).toBe("");
    next.unmount();
  }
  const unavailable = render(
    <AttachmentImage
      session={owner}
      attachment={{ url: source, kind: "image" }}
      source={undefined}
      cached
    />,
  );
  expect(unavailable.container.querySelector("span")?.style.aspectRatio).toBe(
    "",
  );
});

it("a retired decode cannot seed geometry for a later mount", async () => {
  const owner = session();
  const first = mount(owner);
  const pending = decode(first);
  first.unmount();
  await pending.release();
  expect(imageDimensions(owner, source)).toBeUndefined();
  const next = mount(owner);
  expect(next.getByRole("link").style.aspectRatio).toBe("");
});

it("bounds retained geometry and refreshes a source on successful decode", () => {
  const owner = session();
  for (let i = 0; i < 512; i++)
    rememberImageDimensions(owner, `${source}/${i}`, dimensions);
  rememberImageDimensions(owner, `${source}/0`, dimensions);
  rememberImageDimensions(owner, `${source}/512`, dimensions);
  expect(imageDimensions(owner, `${source}/0`)).toEqual(dimensions);
  expect(imageDimensions(owner, `${source}/1`)).toBeUndefined();
  expect(imageDimensions(owner, `${source}/512`)).toEqual(dimensions);
});

const relaySource = `https://relay.test/media/${"a".repeat(64)}.png`;
const relayThumbnail = `https://relay.test/media/${"a".repeat(64)}.thumb.jpg`;
const thumbnailOf = (view: ReturnType<typeof render>) =>
  view.container.querySelector<HTMLImageElement>("img[data-thumbnail]");

it("shows the thumbnail once it loads and drops it when the original decodes", async () => {
  const view = mount(session(), relaySource, undefined, relayThumbnail);
  const thumbnail = thumbnailOf(view);
  expect(thumbnail).toHaveAttribute("src", relayThumbnail);
  expect(thumbnail).toHaveAttribute("loading", "lazy");
  expect(thumbnail).toHaveStyle({ visibility: "hidden" });
  fireEvent.load(thumbnail as HTMLImageElement);
  expect(thumbnailOf(view)).toHaveStyle({ visibility: "visible" });
  const original = view.container.querySelector("img");
  expect(original).toHaveAttribute("src", relaySource);
  expect(original).toHaveStyle({ visibility: "hidden" });
  await decode(view).release();
  expect(thumbnailOf(view)).toBeNull();
  expect(original).toHaveStyle({ visibility: "visible" });
});

it("falls back to the blurhash placeholder when the thumbnail fails", () => {
  const view = render(
    <AttachmentImage
      session={session()}
      attachment={{
        url: relaySource,
        kind: "image",
        blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
      }}
      source={relaySource}
      thumbnail={relayThumbnail}
    />,
  );
  expect(view.container.querySelector("canvas")).not.toBeNull();
  fireEvent.error(thumbnailOf(view) as HTMLImageElement);
  expect(thumbnailOf(view)).toHaveStyle({ visibility: "hidden" });
  expect(view.container.querySelector("canvas")).not.toBeNull();
  expect(view.queryByRole("status")).toBeNull();
});

it("requests no thumbnail for third-party images", () => {
  const view = mount(session(), source);
  expect(thumbnailOf(view)).toBeNull();
  expect(view.container.querySelectorAll("img")).toHaveLength(1);
});

it("requests no thumbnail for a re-adopted original", async () => {
  const owner = session();
  const first = mount(owner, relaySource, undefined, relayThumbnail);
  await decode(first).release();
  const original = first.container.querySelector("img");
  first.unmount();
  const next = mount(owner, relaySource, undefined, relayThumbnail);
  expect(next.container.querySelector("img")).toBe(original);
  expect(next.container.querySelectorAll("img")).toHaveLength(1);
  expect(thumbnailOf(next)).toBeNull();
});
