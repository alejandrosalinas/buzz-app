import { afterEach, expect, it, vi } from "vitest";
import {
  clearReactDevMeasures,
  REACT_DEV_MEASURE_CLEAR_MS,
} from "./react-dev-timing";

afterEach(() => {
  vi.useRealTimers();
});

it("clears measures on each interval until stopped", () => {
  vi.useFakeTimers();
  const perf = { clearMeasures: vi.fn() };
  const stop = clearReactDevMeasures(perf);
  vi.advanceTimersByTime(REACT_DEV_MEASURE_CLEAR_MS - 1);
  expect(perf.clearMeasures).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(perf.clearMeasures).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(REACT_DEV_MEASURE_CLEAR_MS * 2);
  expect(perf.clearMeasures).toHaveBeenCalledTimes(3);
  stop();
  vi.advanceTimersByTime(REACT_DEV_MEASURE_CLEAR_MS * 5);
  expect(perf.clearMeasures).toHaveBeenCalledTimes(3);
});

it("drops measures from a real performance buffer", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  performance.measure("render");
  expect(performance.getEntriesByType("measure")).toHaveLength(1);
  const stop = clearReactDevMeasures();
  vi.advanceTimersByTime(REACT_DEV_MEASURE_CLEAR_MS);
  expect(performance.getEntriesByType("measure")).toHaveLength(0);
  stop();
});

it("does nothing without a User Timing API", () => {
  vi.useFakeTimers();
  const stop = clearReactDevMeasures({} as Pick<Performance, "clearMeasures">);
  expect(vi.getTimerCount()).toBe(0);
  stop();
});
