// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRecommendedPick } from "./useRecommendedPick";

// Synthetic candidates; real values come only from a packager's build.
const candidates = [
  {
    harness: "goose",
    provider: "provider-b",
    model: "model-b",
    effort: "high",
    label: "Model B",
  },
  { harness: "codex", model: "model-a", effort: "high", label: "Model A" },
];
const harness = (id: string, title: string, ready: () => boolean) => ({
  id,
  title,
  recommends: vi.fn(async () => ready()),
});

beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_RECOMMENDED_AGENT", JSON.stringify(candidates)),
);
afterEach(() => vi.unstubAllEnvs());

it("finds the first ready harness once, with a note for one it skipped", async () => {
  const goose = harness("goose", "Goose", () => false);
  const codex = harness("codex", "Codex", () => true);
  const { result, rerender } = renderHook(() =>
    useRecommendedPick([goose, codex]),
  );
  expect(result.current).toEqual({ status: "checking" });
  await act(async () => {});
  expect(result.current).toEqual({
    status: "found",
    pick: { type: codex, candidate: candidates[1], skipped: [goose] },
    note: "Goose isn’t set up on this computer, so this uses Codex.",
  });
  rerender();
  expect(codex.recommends).toHaveBeenCalledOnce();
});

it("says when nothing recommended is set up here", async () => {
  const goose = harness("goose", "Goose", () => false);
  const { result } = renderHook(() => useRecommendedPick([goose]));
  await act(async () => {});
  expect(result.current).toEqual({ status: "none" });
});

it("asks nothing when off", async () => {
  const goose = harness("goose", "Goose", () => true);
  const { result } = renderHook(() => useRecommendedPick([goose], false));
  await act(async () => {});
  expect(result.current).toEqual({ status: "off" });
  expect(goose.recommends).not.toHaveBeenCalled();
});
