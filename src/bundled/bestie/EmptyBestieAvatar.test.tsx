// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EmptyBestieAvatar } from "./EmptyBestieAvatar";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("cycles still artwork only while visible and motion is allowed", () => {
  vi.useFakeTimers();
  const change = new EventTarget();
  let reduced = false;
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return reduced;
    },
    addEventListener: change.addEventListener.bind(change),
    removeEventListener: change.removeEventListener.bind(change),
  }));
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const { container } = render(<EmptyBestieAvatar />);
  const source = () => container.querySelector("img")?.getAttribute("src");
  const first = source();
  expect(first).toBeTruthy();
  expect(container.querySelector("video")).toBeNull();
  act(() => vi.advanceTimersByTime(4_999));
  expect(source()).toBe(first);
  act(() => vi.advanceTimersByTime(1));
  const second = source();
  expect(second).not.toBe(first);

  act(() => {
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(10_000);
  });
  expect(source()).toBe(second);
  act(() => {
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    reduced = true;
    change.dispatchEvent(new Event("change"));
    vi.advanceTimersByTime(10_000);
  });
  expect(source()).toBe(second);
  act(() => {
    reduced = false;
    change.dispatchEvent(new Event("change"));
    vi.advanceTimersByTime(5_000);
  });
  expect(source()).not.toBe(second);
});
