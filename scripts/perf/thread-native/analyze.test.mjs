import { expect, test } from "vitest";
import { frameMetrics, summarize } from "./analyze.mjs";

// [t, scrollTop, scrollHeight, clientHeight] at 60 Hz, scrolling every frame.
const steady = Array.from({ length: 30 }, (_, i) => [
  Math.round(i * 16.67),
  i * 10,
  9000,
  700,
]);
const wheels = [[0, 40]];

test("counts long frames with coarsened 60 Hz timestamps", () => {
  const frames = [...steady, [steady.at(-1)[0] + 100, 290, 9000, 700]];
  frames.push([frames.at(-1)[0] + 50, 300, 9000, 700]);
  expect(frameMetrics({ frames, wheels })).toMatchObject({
    movingFrames: 30,
    gapMaxMs: 100,
    framesOver33: 2,
    droppedFrames: 7,
  });
});

test("keeps a stall during input whose ending frame did not move", () => {
  const frames = [
    [0, 0, 9000, 700],
    [17, 10, 9000, 700],
    [117, 10, 9000, 700],
    [134, 20, 9000, 700],
  ];
  expect(frameMetrics({ frames, wheels })).toMatchObject({
    gapMaxMs: 100,
    framesOver33: 1,
    droppedFrames: 5,
  });
});

test("keeps the interval after the last movement lands", () => {
  const frames = [...steady, [steady.at(-1)[0] + 60, 290, 9000, 700]];
  frames.push([frames.at(-1)[0] + 17, 290, 9000, 700]);
  expect(frameMetrics({ frames, wheels })).toMatchObject({
    gapMaxMs: 60,
    framesOver33: 1,
  });
});

test("ignores time before the first input and after the landing frame", () => {
  const frames = [
    [0, 0, 9000, 700],
    [200, 0, 9000, 700],
    ...steady.map(([t, top]) => [t + 300, top, 9000, 700]),
    [800, 290, 9000, 700],
    [1100, 290, 9000, 700],
    [1600, 290, 9000, 700],
  ];
  expect(frameMetrics({ frames, wheels: [[300, 40]] })).toMatchObject({
    gapMaxMs: 17,
    framesOver33: 0,
    droppedFrames: 0,
  });
});

test("rejects a run without scrolling input", () => {
  expect(() => frameMetrics({ frames: steady, wheels: [] })).toThrow(
    "no scrolling input",
  );
});

test("reports a steady 60 Hz run as meeting the frame target", () => {
  const metrics = frameMetrics({ frames: steady, wheels });
  expect(metrics.framesOver33).toBe(0);
  expect(
    summarize([{ arm: "head", metrics: { ...metrics, blankFrames: 0 } }]),
  ).toContain("(target met)");
});
