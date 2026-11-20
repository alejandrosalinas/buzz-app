// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createMediaPreparation } from "../../../features/relay/media";
import { Avatar } from "./Avatar";
import { retryFailedImages } from "../useReadyImage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("reveals completed cached artwork on mount without waiting for a load event", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    32,
  );
  const view = render(
    <StrictMode>
      <Avatar src="https://example.test/a.png" alt="Agent" fallback="A" />
    </StrictMode>,
  );
  expect(view.container.querySelector("img")).toHaveAttribute(
    "data-loaded",
    "true",
  );
  expect(view.container.querySelector("img")).toHaveAttribute(
    "loading",
    "lazy",
  );
  // Async decoding paints ready artwork as empty for a frame in WebKit.
  expect(view.container.querySelector("img")).toHaveAttribute(
    "decoding",
    "sync",
  );
});

it("lets the browser decide a completed image without a width", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    0,
  );
  // A dimensionless SVG can report no width once complete; it is not broken.
  const svg = render(
    <Avatar
      src="https://example.test/sized-by-css.svg"
      alt="Agent"
      fallback="A"
    />,
  );
  const image = svg.container.querySelector("img");
  if (!image) throw new Error("Expected pending artwork");
  expect(image).not.toHaveAttribute("data-loaded");
  fireEvent.load(image);
  expect(image).toHaveAttribute("data-loaded", "true");
  svg.unmount();

  const broken = render(
    <Avatar src="https://example.test/broken.png" alt="Agent" fallback="A" />,
  );
  const pending = broken.container.querySelector("img");
  if (!pending) throw new Error("Expected pending artwork");
  fireEvent.error(pending);
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByRole("img", { name: "Agent" })).toHaveTextContent("A");
});

it("defers new sources, uses eager loading after success, and shows a failed source's fallback on remount", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const props = {
    src: "https://example.test/warm-remount.png",
    alt: "Agent",
    fallback: "A",
  };
  const first = render(<Avatar {...props} />);
  const image = first.container.querySelector("img");
  if (!image) throw new Error("Expected initial artwork");
  expect(image).toHaveAttribute("loading", "lazy");
  fireEvent.load(image);
  // Artwork that arrives after mount keeps decoding off the main thread.
  expect(image).toHaveAttribute("decoding", "async");
  first.unmount();

  const second = render(<Avatar {...props} />);
  const remount = second.container.querySelector("img");
  if (!remount) throw new Error("Expected remounted artwork");
  expect(remount).toHaveAttribute("loading", "eager");
  // Remembered success is only a scheduling hint: the browser may have evicted
  // the bytes, so actual image readiness still controls visibility.
  expect(remount).not.toHaveAttribute("data-loaded");
  fireEvent.error(remount);
  expect(screen.getByRole("img", { name: "Agent" })).toHaveTextContent("A");
  second.unmount();

  // A remount after failure shows the fallback at once, not a blank circle,
  // while it still requests the source in case it recovered.
  const retry = render(<Avatar {...props} />);
  const retried = retry.container.querySelector("img");
  expect(retried).toHaveAttribute("loading", "lazy");
  expect(screen.getByRole("img", { name: "Agent" })).toHaveTextContent("A");
  if (!retried) throw new Error("Expected retried artwork");
  fireEvent.load(retried);
  expect(retried).toHaveAttribute("data-loaded", "true");
  expect(screen.getByRole("img", { name: "Agent" })).toHaveTextContent("");
});

it("mounts artwork the request warmer loaded eagerly", async () => {
  // WebKit serves a warmed custom-scheme image only to an eager mount; a lazy
  // one refetches it.
  const warmed: { onload: (() => void) | null; src: string }[] = [];
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 32;
      naturalHeight = 32;
      src = "";
      referrerPolicy = "";
      decode = async () => {};
      constructor() {
        warmed.push(this);
      }
    },
  );
  const src = "buzz-media://localhost/warmed-avatar";
  createMediaPreparation().prepare([src]);
  await act(async () => warmed[0]?.onload?.());
  vi.unstubAllGlobals();
  const view = render(<Avatar src={src} alt="Agent" fallback="A" />);
  expect(view.container.querySelector("img")).toHaveAttribute(
    "loading",
    "eager",
  );
});

it("bounds remembered sources and retains recently used artwork", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const src = (index: number) => `https://example.test/bounded-${index}.png`;
  const view = render(<Avatar src={src(0)} alt="Agent" fallback="A" />);
  const mount = (index: number) => {
    view.rerender(<Avatar src={src(index)} alt="Agent" fallback="A" />);
    const image = view.container.querySelector("img");
    if (!image) throw new Error("Expected bounded-cache artwork");
    return image;
  };
  fireEvent.load(mount(0));
  for (let index = 1; index < 1024; index++) fireEvent.load(mount(index));
  // Refresh the oldest entry before adding another distinct source.
  expect(mount(0)).toHaveAttribute("loading", "eager");
  fireEvent.load(mount(0));
  fireEvent.load(mount(1024));
  expect(mount(1)).toHaveAttribute("loading", "lazy");
  expect(mount(0)).toHaveAttribute("loading", "eager");
});

it("preserves delayed loading and error fallbacks, resetting when the source changes", () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const view = render(
    <Avatar src="https://example.test/a.png" alt="Agent" fallback="A" />,
  );
  const artwork = () => {
    const image = view.container.querySelector("img");
    if (!image) throw new Error("Expected avatar artwork");
    return image;
  };
  const avatar = screen.getByRole("img", { name: "Agent" });
  expect(avatar).toHaveTextContent("");
  act(() => vi.advanceTimersByTime(149));
  expect(avatar).toHaveTextContent("");
  act(() => vi.advanceTimersByTime(1));
  expect(avatar).toHaveTextContent("A");
  fireEvent.load(artwork());
  expect(artwork()).toHaveAttribute("data-loaded", "true");
  expect(avatar).toHaveTextContent("");

  view.rerender(
    <Avatar src="https://example.test/b.png" alt="Agent" fallback="A" />,
  );
  expect(artwork()).not.toHaveAttribute("data-loaded");
  expect(avatar).toHaveTextContent("");
  fireEvent.error(artwork());
  expect(avatar).toHaveTextContent("A");
  expect(document.querySelector("img")).toBeNull();
  view.rerender(
    <Avatar src="https://example.test/c.png" alt="Agent" fallback="A" />,
  );
  fireEvent.load(artwork());
  expect(artwork()).toHaveAttribute("data-loaded", "true");
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("retries a failed source behind the fallback until it or another mount loads", () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const src = "https://example.test/transient.png";
  const view = render(<Avatar src={src} alt="Preview" fallback="P" />);
  const avatar = screen.getByRole("img", { name: "Preview" });
  const artwork = () => view.container.querySelector("img");

  // Each failure keeps the initial visible; the retry requests the same source.
  for (const delay of [2_000, 10_000, 30_000]) {
    const image = artwork();
    if (!image) throw new Error("Expected avatar artwork");
    fireEvent.error(image);
    expect(artwork()).toBeNull();
    act(() => vi.advanceTimersByTime(delay - 1));
    expect(artwork()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(artwork()).toHaveAttribute("src", src);
    expect(artwork()).not.toHaveAttribute("data-loaded");
    expect(avatar).toHaveTextContent("P");
  }
  const last = artwork();
  if (!last) throw new Error("Expected final retry artwork");
  fireEvent.error(last);
  expect(vi.getTimerCount()).toBe(0);
  expect(avatar).toHaveTextContent("P");

  // Once timed retries are spent, another mount loading the source recovers it.
  const reply = render(<Avatar src={src} alt="Reply" fallback="R" />);
  const loaded = reply.container.querySelector("img");
  if (!loaded) throw new Error("Expected reply artwork");
  fireEvent.load(loaded);
  const recovered = artwork();
  if (!recovered) throw new Error("Expected recovered artwork");
  expect(recovered).toHaveAttribute("src", src);
  fireEvent.load(recovered);
  expect(recovered).toHaveAttribute("data-loaded", "true");
  expect(avatar).toHaveTextContent("");
  reply.unmount();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("requests a failed source again when asked after its timed retries are spent", () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const src = "https://example.test/offline.png";
  const view = render(<Avatar src={src} alt="Offline" fallback="O" />);
  const artwork = () => view.container.querySelector("img");
  for (const delay of [2_000, 10_000, 30_000, 0]) {
    const image = artwork();
    if (!image) throw new Error("Expected avatar artwork");
    fireEvent.error(image);
    act(() => vi.advanceTimersByTime(delay));
  }
  expect(artwork()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  act(() => retryFailedImages());
  const retried = artwork();
  if (!retried) throw new Error("Expected retried artwork");
  expect(retried).toHaveAttribute("src", src);
  fireEvent.load(retried);
  expect(retried).toHaveAttribute("data-loaded", "true");
  view.unmount();
});

it("requests a source once more when it fails after a recovery that found it still loading", () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const src = "https://example.test/pending.png";
  const view = render(<Avatar src={src} alt="Pending" fallback="P" />);
  const artwork = () => view.container.querySelector("img");
  for (const delay of [2_000, 10_000, 30_000]) {
    const image = artwork();
    if (!image) throw new Error("Expected avatar artwork");
    fireEvent.error(image);
    act(() => vi.advanceTimersByTime(delay));
  }
  const pending = artwork();
  if (!pending) throw new Error("Expected the last timed request");
  act(() => retryFailedImages());
  fireEvent.error(pending);
  act(() => vi.advanceTimersByTime(0));
  const recovered = artwork();
  if (!recovered) throw new Error("Expected a request after the recovery");
  fireEvent.load(recovered);
  expect(recovered).toHaveAttribute("data-loaded", "true");
  fireEvent.error(recovered);
  expect(artwork()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  view.unmount();
});
