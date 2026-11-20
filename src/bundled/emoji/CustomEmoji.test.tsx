// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CustomEmoji } from "./CustomEmoji";

const emoji = { shortcode: "party", url: "https://emoji.test/party.png" };
const media = (url: string) => url;
const image = (view: { container: HTMLElement }) => {
  const found = view.container.querySelector("img");
  if (!found) throw new Error("Emoji image missing");
  return found;
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("recovers a transient image failure behind its text without remounting the message", () => {
  vi.useFakeTimers();
  const view = render(<CustomEmoji emoji={emoji} media={media} />);
  fireEvent.error(view.getByRole("img"));
  expect(view.container).toHaveTextContent(":party:");
  act(() => vi.advanceTimersByTime(2_000));
  // The retry loads hidden behind the text and copies nothing itself.
  const retry = image(view);
  expect(retry).toHaveAttribute("src", emoji.url);
  expect(retry).toHaveAttribute("loading", "eager");
  expect(retry).not.toBeVisible();
  expect(retry).not.toHaveAttribute("data-copy-emoji");
  expect(view.container).toHaveTextContent(":party:");
  fireEvent.load(retry);
  expect(view.getByRole("img")).toBe(retry);
  expect(retry).toBeVisible();
  expect(view.container).not.toHaveTextContent(":party:");
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds retries and cancels pending recovery when unmounted", () => {
  vi.useFakeTimers();
  const view = render(<CustomEmoji emoji={emoji} media={media} />);
  for (const delay of [2_000, 10_000, 30_000]) {
    fireEvent.error(image(view));
    act(() => vi.advanceTimersByTime(delay - 1));
    expect(view.container.querySelector("img")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(image(view)).toHaveAttribute("src", emoji.url);
    expect(view.container).toHaveTextContent(":party:");
  }
  fireEvent.error(image(view));
  expect(view.container).toHaveTextContent(":party:");
  expect(vi.getTimerCount()).toBe(0);
  view.unmount();
  const pending = render(<CustomEmoji emoji={emoji} media={media} />);
  fireEvent.error(image(pending));
  pending.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("gives a changed source its own retry budget and never requests denied media", () => {
  vi.useFakeTimers();
  const view = render(<CustomEmoji emoji={emoji} media={media} />);
  fireEvent.error(image(view));
  const next = { ...emoji, url: "https://emoji.test/new.png" };
  view.rerender(<CustomEmoji emoji={next} media={media} />);
  expect(vi.getTimerCount()).toBe(0);
  fireEvent.error(image(view));
  act(() => vi.advanceTimersByTime(2_000));
  expect(image(view)).toHaveAttribute("src", next.url);
  view.rerender(<CustomEmoji emoji={next} media={() => undefined} />);
  expect(view.queryByRole("img")).toBeNull();
  expect(view.container).toHaveTextContent(":party:");
  expect(vi.getTimerCount()).toBe(0);
});

it("paints a remounted emoji in its first frame", () => {
  const remounted = { ...emoji, url: "https://emoji.test/remount.png" };
  const first = render(<CustomEmoji emoji={remounted} media={media} />);
  expect(first.getByRole("img")).toHaveAttribute("loading", "lazy");
  fireEvent.load(first.getByRole("img"));
  first.unmount();
  // WebKit re-requests a lazy custom-scheme image per element and paints a
  // ready async-decoded one as empty for a frame.
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    22,
  );
  const second = render(<CustomEmoji emoji={remounted} media={media} />);
  expect(second.getByRole("img")).toHaveAttribute("loading", "eager");
  expect(second.getByRole("img")).toHaveAttribute("decoding", "sync");
});
