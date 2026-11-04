import { expect, test } from "vitest";
import { scrollCadence } from "./cadence.mjs";

test("clips cadence to the gesture while retaining stalls at an unchanged offset", () => {
  expect(
    scrollCadence({
      frames: [0, 10, 30, 110, 130, 500].map((t) => ({ t, top: 100 })),
      gestureStartMs: 20,
      gestureEndMs: 150,
    }),
  ).toEqual({
    rafMaxGapMs: 80,
    rafP95GapMs: 80,
    rafGapsOver33: 1,
    rafGapsOver50: 1,
  });
});

test("counts a gesture with no callback before it ends as a single gap", () => {
  expect(
    scrollCadence({
      frames: [{ t: 10 }, { t: 1010 }],
      gestureStartMs: 20,
      gestureEndMs: 120,
    }),
  ).toEqual({
    rafMaxGapMs: 100,
    rafP95GapMs: 100,
    rafGapsOver33: 1,
    rafGapsOver50: 1,
  });
});

test("preserves nearest-rank p95 instead of reporting the worst gap", () => {
  expect(
    scrollCadence({
      frames: Array.from({ length: 20 }, (_, i) => ({ t: (i + 1) * 10 })),
      gestureStartMs: 0,
      gestureEndMs: 300,
    }),
  ).toEqual({
    rafMaxGapMs: 100,
    rafP95GapMs: 10,
    rafGapsOver33: 1,
    rafGapsOver50: 1,
  });
});

test("rejects recordings without a completed gesture window", () => {
  expect(() => scrollCadence({ frames: [{ t: 100 }] })).toThrow(
    "Missing or invalid scroll gesture timestamps",
  );
});

test("counts a missed 60 Hz frame separately from a long stall", () => {
  expect(
    scrollCadence({
      frames: [17, 34, 51, 87, 104, 121].map((t) => ({ t })),
      gestureStartMs: 0,
      gestureEndMs: 138,
    }),
  ).toMatchObject({ rafGapsOver33: 1, rafGapsOver50: 0 });
});
