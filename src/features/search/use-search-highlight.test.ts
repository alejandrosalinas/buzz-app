// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useSearchHighlight } from "./use-search-highlight";

const keys = ["a", "b", "c"];

it("starts on a kept row, or on none when the kept row is gone", () => {
  const kept = renderHook(() =>
    useSearchHighlight({
      query: "",
      keys,
      onChoose: vi.fn(),
      highlightEmpty: true,
      initial: "b",
    }),
  );
  expect(kept.result.current.active).toBe("b");
  // A place whose row is out of view picks nothing for Enter to choose.
  const none = renderHook(() =>
    useSearchHighlight({
      query: "",
      keys,
      onChoose: vi.fn(),
      highlightEmpty: true,
      initial: "",
    }),
  );
  expect(none.result.current.active).toBe("");
  const fresh = renderHook(() =>
    useSearchHighlight({
      query: "",
      keys,
      onChoose: vi.fn(),
      highlightEmpty: true,
    }),
  );
  expect(fresh.result.current.active).toBe("a");
});

it("counts a move only for the rows it was made in", () => {
  const { result, rerender } = renderHook(
    ({ within }) =>
      useSearchHighlight({
        query: "deploy",
        keys,
        onChoose: vi.fn(),
        followFirst: true,
        within,
      }),
    { initialProps: { within: "crew" as string | undefined } },
  );
  act(() => result.current.move(true));
  expect(result.current.moved).toBe(true);
  expect(result.current.active).toBe("b");
  // The same text across every conversation: its rows are new, even where a
  // row is the same.
  rerender({ within: undefined });
  expect(result.current.moved).toBe(false);
  expect(result.current.active).toBe("a");
  act(() => result.current.move(true));
  expect(result.current.moved).toBe(true);
});
